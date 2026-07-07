import Peer from 'peerjs';

// Co-op multiplayer over WebRTC (PeerJS public broker), up to 4 players.
// The first player to claim the room id becomes HOST and is authoritative for
// enemies, loot and world state. Guests simulate only their own hero and send
// inputs/damage events. Single-player never touches this module.

const MAX_GUESTS = 3; // host + 3 = 4 players
const ROOM_PREFIX = 'emberdeep-room-';

// How long we wait for any single handshake stage before giving up. Without
// this a failed join (dead room id, ICE that never connects on a phone's
// carrier-grade NAT) leaves the player stuck on "Connecting to room" forever.
const HANDSHAKE_TIMEOUT_MS = 15000;

// Explicit ICE servers. PeerJS only ships one STUN server by default, which is
// not enough for mobile networks behind symmetric NAT. Several public STUN
// servers plus a public TURN relay give the offer/answer a real chance to
// complete instead of silently stalling with no error and no timeout.
const PEER_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
};

export class Net {
  constructor() {
    this.mode = 'off';        // off | host | guest
    this.peer = null;
    this.conns = new Map();   // host: peerId -> DataConnection
    this.hostConn = null;     // guest: connection to host
    this.handlers = {};
    this.playerCount = 1;
    this.roomId = null;
    this.lastRoster = [];     // full peer-id roster, used for host migration
  }

  get active() { return this.mode !== 'off'; }
  get isHost() { return this.mode === 'host'; }

  on(type, fn) { this.handlers[type] = fn; }
  emitLocal(type, msg, from) { this.handlers[type]?.(msg, from); }

  // Try to become host of the room; if the id is taken, join as guest.
  start(room) {
    this.roomId = ROOM_PREFIX + room.toLowerCase().replace(/[^a-z0-9]/g, '');
    return this._claimOrJoin();
  }

  _claimOrJoin() {
    return new Promise((resolve) => {
      const hostPeer = new Peer(this.roomId, { config: PEER_CONFIG });
      let settled = false;

      // If the broker never answers (offline, blocked, or the socket stalls),
      // neither 'open' nor 'error' may ever fire. Fail fast instead of hanging.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { hostPeer.destroy(); } catch {}
        resolve({ mode: 'error', error: 'timeout' });
      }, HANDSHAKE_TIMEOUT_MS);

      hostPeer.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.mode = 'host';
        this.peer = hostPeer;
        hostPeer.on('connection', (conn) => this._acceptGuest(conn));
        resolve({ mode: 'host' });
      });

      hostPeer.on('error', (err) => {
        if (settled) return;
        if (err.type === 'unavailable-id') {
          settled = true;
          clearTimeout(timer);
          hostPeer.destroy();
          this._joinAsGuest(this.roomId).then(resolve);
        } else {
          settled = true;
          clearTimeout(timer);
          resolve({ mode: 'error', error: err.type });
        }
      });
    });
  }

  // Host migration: when the simulating peer leaves, the surviving peer with
  // the lowest id takes over the room id; everyone else reconnects. From the
  // players' point of view the room simply stays alive.
  async migrate(shouldHost) {
    const oldPeer = this.peer;
    this.mode = 'off';
    this.conns.clear();
    this.hostConn = null;
    if (shouldHost) {
      try { oldPeer?.destroy(); } catch {}
      for (let attempt = 0; attempt < 8; attempt++) {
        await new Promise((r) => setTimeout(r, attempt === 0 ? 800 : 1600));
        const res = await this._claimOrJoin();
        if (res.mode !== 'error') return res;
      }
      return { mode: 'error', error: 'migration-failed' };
    }
    // rejoining guests keep their peer; retry until the new host is up
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise((r) => setTimeout(r, 2000 + attempt * 500));
      const res = await new Promise((resolve) => {
        const conn = this.peer.connect(this.roomId, { reliable: true });
        const to = setTimeout(() => { try { conn.close(); } catch {} resolve(null); }, 4000);
        conn.on('open', () => {
          clearTimeout(to);
          this.mode = 'guest';
          this.hostConn = conn;
          this.playerCount = 2;
          conn.on('data', (msg) => this.emitLocal(msg.t, msg, 'host'));
          conn.on('close', () => this.emitLocal('host_left', {}));
          conn.on('error', () => this.emitLocal('host_left', {}));
          resolve({ mode: 'guest' });
        });
        conn.on('error', () => { clearTimeout(to); resolve(null); });
      });
      if (res) return res;
    }
    return { mode: 'error', error: 'migration-failed' };
  }

  _acceptGuest(conn) {
    if (this.conns.size >= MAX_GUESTS) {
      conn.on('open', () => {
        conn.send({ t: 'room_full' });
        setTimeout(() => conn.close(), 300);
      });
      return;
    }
    conn.on('open', () => {
      this.conns.set(conn.peer, conn);
      this.playerCount = 1 + this.conns.size;
      this.emitLocal('guest_joined', { id: conn.peer });
      this.broadcastRoster();
    });
    conn.on('data', (msg) => this.emitLocal(msg.t, msg, conn.peer));
    const drop = () => {
      if (this.conns.delete(conn.peer)) {
        this.playerCount = 1 + this.conns.size;
        this.emitLocal('guest_left', { id: conn.peer });
        this.broadcastRoster();
      }
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  _joinAsGuest(roomId) {
    return new Promise((resolve) => {
      const peer = new Peer(undefined, { config: PEER_CONFIG });
      let settled = false;

      // The join can stall silently at two points: waiting for our own peer to
      // open against the broker, and waiting for the data channel to the host
      // to open. PeerJS often emits no 'error' when the host id is unreachable
      // or ICE never connects, so without this timeout the guest is stuck on
      // "Connecting to room" forever. This is the reported bug.
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (result.mode !== 'guest') { try { peer.destroy(); } catch {} }
        resolve(result);
      };
      const timer = setTimeout(() => finish({ mode: 'error', error: 'timeout' }), HANDSHAKE_TIMEOUT_MS);

      peer.on('open', () => {
        const conn = peer.connect(roomId, { reliable: true });
        conn.on('open', () => {
          this.mode = 'guest';
          this.peer = peer;
          this.hostConn = conn;
          this.playerCount = 2;
          finish({ mode: 'guest' });
        });
        conn.on('data', (msg) => {
          if (msg.t === 'room_full') {
            this.emitLocal('room_full', msg);
            return;
          }
          this.emitLocal(msg.t, msg, 'host');
        });
        conn.on('close', () => this.emitLocal('host_left', {}));
        conn.on('error', () => {
          // Before the channel opens this means the join failed; after it opens
          // it means we lost the host. 'settled' tells the two cases apart.
          if (settled) this.emitLocal('host_left', {});
          else finish({ mode: 'error', error: 'connect-failed' });
        });
      });
      peer.on('error', (err) => finish({ mode: 'error', error: err.type }));
    });
  }

  // Everyone learns the full peer-id roster (used for voice-chat mesh calls).
  broadcastRoster() {
    if (this.mode !== 'host') return;
    const ids = [this.peer.id, ...this.conns.keys()];
    this.lastRoster = ids;
    this.send({ t: 'peers', ids });
    this.emitLocal('peers', { ids });
  }

  // host: relay to all guests except one id (used for chat, so the sender
  // doesn't receive an echo of their own message)
  sendExcept(msg, exceptId) {
    if (this.mode !== 'host') return;
    for (const [id, c] of this.conns) if (id !== exceptId) c.send(msg);
  }

  // host: send to all guests (or one guest by id); guest: send to host
  send(msg, toId = null) {
    if (this.mode === 'host') {
      if (toId) this.conns.get(toId)?.send(msg);
      else for (const c of this.conns.values()) c.send(msg);
    } else if (this.mode === 'guest' && this.hostConn?.open) {
      this.hostConn.send(msg);
    }
  }

  stop() {
    try { this.peer?.destroy(); } catch {}
    this.peer = null;
    this.conns.clear();
    this.hostConn = null;
    this.mode = 'off';
    this.playerCount = 1;
  }
}

export const net = new Net();
