import Peer from 'peerjs';

// Co-op multiplayer over WebRTC (PeerJS public broker), up to 4 players.
// The first player to claim the room id becomes HOST and is authoritative for
// enemies, loot and world state. Guests simulate only their own hero and send
// inputs/damage events. Single-player never touches this module.

const MAX_GUESTS = 3; // host + 3 = 4 players
const ROOM_PREFIX = 'emberdeep-room-';

export class Net {
  constructor() {
    this.mode = 'off';        // off | host | guest
    this.peer = null;
    this.conns = new Map();   // host: peerId -> DataConnection
    this.hostConn = null;     // guest: connection to host
    this.handlers = {};
    this.playerCount = 1;
  }

  get active() { return this.mode !== 'off'; }
  get isHost() { return this.mode === 'host'; }

  on(type, fn) { this.handlers[type] = fn; }
  emitLocal(type, msg, from) { this.handlers[type]?.(msg, from); }

  // Try to become host of the room; if the id is taken, join as guest.
  start(room, callbacks) {
    const roomId = ROOM_PREFIX + room.toLowerCase().replace(/[^a-z0-9]/g, '');
    return new Promise((resolve) => {
      const hostPeer = new Peer(roomId);
      let settled = false;

      hostPeer.on('open', () => {
        if (settled) return;
        settled = true;
        this.mode = 'host';
        this.peer = hostPeer;
        hostPeer.on('connection', (conn) => this._acceptGuest(conn));
        resolve({ mode: 'host' });
      });

      hostPeer.on('error', (err) => {
        if (settled) return;
        if (err.type === 'unavailable-id') {
          settled = true;
          hostPeer.destroy();
          this._joinAsGuest(roomId).then(resolve);
        } else {
          settled = true;
          resolve({ mode: 'error', error: err.type });
        }
      });
      // callbacks piped through this.on(...) by the game
      void callbacks;
    });
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
      const peer = new Peer();
      peer.on('open', () => {
        const conn = peer.connect(roomId, { reliable: true });
        conn.on('open', () => {
          this.mode = 'guest';
          this.peer = peer;
          this.hostConn = conn;
          this.playerCount = 2;
          resolve({ mode: 'guest' });
        });
        conn.on('data', (msg) => {
          if (msg.t === 'room_full') {
            this.emitLocal('room_full', msg);
            return;
          }
          this.emitLocal(msg.t, msg, 'host');
        });
        conn.on('close', () => this.emitLocal('host_left', {}));
        conn.on('error', () => this.emitLocal('host_left', {}));
      });
      peer.on('error', (err) => resolve({ mode: 'error', error: err.type }));
    });
  }

  // Everyone learns the full peer-id roster (used for voice-chat mesh calls).
  broadcastRoster() {
    if (this.mode !== 'host') return;
    const ids = [this.peer.id, ...this.conns.keys()];
    this.send({ t: 'peers', ids });
    this.emitLocal('peers', { ids });
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
