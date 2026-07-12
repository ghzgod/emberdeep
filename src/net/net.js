import { joinRoom, selfId } from 'trystero/nostr';

// Co-op multiplayer over WebRTC, up to 4 players (Obsidian 758).
//
// WHY THIS EXISTS: the old PeerJS transport signalled through the free public
// broker 0.peerjs.com, which is rate-limited and frequently drops the signaling
// socket ("Connection failed (network)") - the recurring "my buddy can't join
// my room" bug. Trystero replaces that single broker with DECENTRALISED
// signaling over public nostr relays (many WSS relays, no account, no key to
// leak), so there is no one broker to be unreachable. The actual media/data
// path is still plain WebRTC.
//
// Trystero is a MESH (every peer connects to every peer), but the game is
// HOST-AUTHORITATIVE (one peer simulates enemies/loot/world; the rest send
// inputs). So we elect a host on top of the mesh:
//   host = the peer with the EARLIEST join time (tiebreak: smaller selfId).
// This is stable (the first person in the room stays host) and self-healing
// (when the host leaves, the next-earliest peer automatically becomes host -
// that IS host migration, for free). Every peer computes the same winner from
// the shared presence table, so they always agree on who the host is.

const MAX_PLAYERS = 4; // host + 3 guests
const ROOM_PREFIX = 'emberdeep-room-';
const APP_ID = 'emberdeep-coop-v1';
// Curated, known-reliable public nostr relays for signaling (Obsidian 758).
// Trystero's built-in defaults include dead/test relays (e.g. testrelay.top),
// so we pin our own well-established set - only signaling handshakes pass
// through them (tiny WS messages), never game traffic, which is direct WebRTC.
const RELAY_URLS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.snort.social',
];
// How long to gather presence from existing peers before settling host/guest.
// The newcomer needs to hear the current host's (earlier) join time so it
// doesn't wrongly claim host; peer discovery over nostr is well under this.
const ELECTION_MS = 2000;

export class Net {
  constructor() {
    this.mode = 'off';         // off | host | guest
    this.room = null;
    this.roomId = null;
    this.handlers = {};
    this.selfId = selfId;
    // presence table: peerId -> { jt (join time ms), id }. Includes self.
    this.presence = new Map();
    this.hostId = null;
    this.conns = new Map();    // host: guestId -> true (mirrors the guest set)
    this.lastRoster = [];      // [all peer ids] incl. self - used by voice + migration
    this.playerCount = 1;
    this._joinTime = 0;
    this._sendMsg = null;
    this._settled = false;
  }

  get active() { return this.mode !== 'off'; }
  get isHost() { return this.mode === 'host'; }
  // Back-compat shim: callers read net.peer?.id (the local peer id). Voice now
  // attaches to net.room, but this keeps net.peer.id working.
  get peer() { return this.mode === 'off' ? null : { id: this.selfId }; }

  on(type, fn) { this.handlers[type] = fn; }
  emitLocal(type, msg, from) { this.handlers[type]?.(msg, from); }

  async start(room) {
    this.roomId = ROOM_PREFIX + room.toLowerCase().replace(/[^a-z0-9]/g, '');
    this._joinTime = Date.now();
    this._settled = false;
    this.presence = new Map([[this.selfId, { jt: this._joinTime, id: this.selfId }]]);

    try {
      this.room = joinRoom({ appId: APP_ID, relayConfig: { urls: RELAY_URLS } }, this.roomId);
    } catch (err) {
      return { mode: 'error', error: 'join-failed' };
    }

    // Two channels: 'msg' carries the game's {t,...} payloads; 'pres' carries
    // presence records for host election. Trystero 0.25 actions expose
    // { send, onMessage } (assign the handler) rather than a [send, get] tuple.
    const msgAction = this.room.makeAction('msg');
    const presAction = this.room.makeAction('pres');
    this._sendMsg = (data, target) => { try { msgAction.send(data, target != null ? { target } : undefined); } catch { /* peer left mid-send */ } };
    this._sendPres = (data, target) => { try { presAction.send(data, target != null ? { target } : undefined); } catch { /* peer left mid-send */ } };

    msgAction.onMessage = (data, ctx) => this._onGameMsg(data, ctx.peerId);
    presAction.onMessage = (data, ctx) => {
      this.presence.set(ctx.peerId, { jt: data.jt, id: ctx.peerId });
      this._reelect();
    };

    // onPeer* are assignable properties in 0.25. net OWNS onPeerJoin/onPeerLeave
    // (presence + migration); voice owns onPeerStream (they share this room).
    this.room.onPeerJoin = (peerId) => {
      // Tell the newcomer our join time so they elect correctly, and note them.
      this._sendPres({ jt: this._joinTime, id: this.selfId }, peerId);
      if (!this.presence.has(peerId)) this.presence.set(peerId, { jt: Infinity, id: peerId });
      this._reelect();
    };
    this.room.onPeerLeave = (peerId) => {
      const wasHost = peerId === this.hostId;
      this.presence.delete(peerId);
      this.conns.delete(peerId);
      this._greeted?.delete?.(peerId);
      this._reelect();
      if (wasHost) {
        // The simulating peer left; the game re-homes the room (onHostLost ->
        // migrate()). Our _reelect has already picked the new host locally.
        this.emitLocal('host_left', {});
      } else if (this.isHost) {
        this.emitLocal('guest_left', { id: peerId });
        this.broadcastRoster();
      }
    };

    // Announce ourselves to everyone already here.
    this._sendPres({ jt: this._joinTime, id: this.selfId });

    // Collect presence, then settle into host or guest.
    await new Promise((r) => setTimeout(r, ELECTION_MS));

    // Enforce the 4-player cap: if we're not among the 4 earliest joiners, bail.
    const ordered = [...this.presence.values()].sort(this._cmp);
    const myRank = ordered.findIndex((p) => p.id === this.selfId);
    if (myRank >= MAX_PLAYERS) {
      try { this.room.leave(); } catch { /* ignore */ }
      this.room = null; this.mode = 'off';
      return { mode: 'error', error: 'room_full' };
    }

    this._settled = true;
    this._reelect(true);
    return { mode: this.mode };
  }

  // Order peers: earliest join time wins; ties broken by smaller id.
  _cmp(a, b) { return a.jt - b.jt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }

  // Recompute who the host is and update our own mode + the host's guest list.
  // `announce` is true only for the initial settle so we don't fire join/host
  // events during the pre-settle gathering window.
  _reelect(announce = false) {
    if (!this.room) return;
    const ordered = [...this.presence.values()].sort(this._cmp);
    const winner = ordered[0];
    const newHostId = winner ? winner.id : this.selfId;
    const becameHost = newHostId === this.selfId && this.mode !== 'host';
    this.hostId = newHostId;
    const newMode = newHostId === this.selfId ? 'host' : 'guest';

    if (this.isHost) {
      // keep the guest set in sync with live peers
      for (const id of this.presence.keys()) if (id !== this.selfId) this.conns.set(id, true);
      for (const id of [...this.conns.keys()]) if (!this.presence.has(id)) this.conns.delete(id);
    }

    const prevMode = this.mode;
    this.mode = newMode;
    this.lastRoster = ordered.map((p) => p.id);
    this.playerCount = this.presence.size;

    if (!this._settled && !announce) return;

    if (becameHost) {
      // Rebuild the guest list and let listeners know (initial host or a
      // migration where we were promoted).
      this.conns = new Map();
      for (const id of this.presence.keys()) if (id !== this.selfId) this.conns.set(id, true);
      if (prevMode === 'guest') this.emitLocal('became_host', {});
      this.broadcastRoster();
    }
  }

  _onGameMsg(data, peerId) {
    if (!data || typeof data.t !== 'string') return;
    if (data.t === 'room_full') { this.emitLocal('room_full', data); return; }
    // A guest only ever receives from the host; the host receives from guests.
    const from = peerId === this.hostId ? 'host' : peerId;
    // Host observes new guests through their first 'hello'.
    if (this.isHost && data.t === 'hello' && !this._greeted?.has?.(peerId)) {
      (this._greeted ||= new Set()).add(peerId);
      this.emitLocal('guest_joined', { id: peerId });
      this.broadcastRoster();
    }
    this.emitLocal(data.t, data, from);
  }

  // Host migration is automatic in the mesh (_reelect on the host leaving picks
  // the next-earliest peer). This just waits for the peer set to settle and
  // reports the resulting role so the game can promote/rejoin. `shouldHost` is
  // the game's own guess; we honour our deterministic election instead.
  async migrate() {
    // give onPeerLeave/_reelect a beat to converge across the surviving mesh
    await new Promise((r) => setTimeout(r, 600));
    this._reelect(true);
    if (this.mode === 'off' || !this.room) return { mode: 'error', error: 'migration-failed' };
    return { mode: this.mode };
  }

  // Everyone learns the full peer-id roster (voice mesh + migration).
  broadcastRoster() {
    if (!this.isHost) return;
    const ids = [...this.presence.keys()];
    this.lastRoster = ids;
    this.send({ t: 'peers', ids });
    this.emitLocal('peers', { ids });
  }

  // host: relay to all guests except one id (chat, so the sender gets no echo)
  sendExcept(msg, exceptId) {
    if (!this.isHost || !this._sendMsg) return;
    const targets = [...this.conns.keys()].filter((id) => id !== exceptId);
    if (targets.length) this._sendMsg(msg, targets);
  }

  // host: to all guests (or one by id); guest: to the host only.
  send(msg, toId = null) {
    if (!this._sendMsg || this.mode === 'off') return;
    if (this.isHost) {
      if (toId) this._sendMsg(msg, toId);
      else if (this.conns.size) this._sendMsg(msg, [...this.conns.keys()]);
    } else if (this.hostId) {
      this._sendMsg(msg, this.hostId);
    }
  }

  stop() {
    try { this.room?.leave(); } catch { /* ignore */ }
    this.room = null;
    this.mode = 'off';
    this.hostId = null;
    this.presence = new Map();
    this.conns.clear();
    this.lastRoster = [];
    this.playerCount = 1;
    this._sendMsg = null;
    this._greeted = null;
    this._settled = false;
  }
}

export const net = new Net();
