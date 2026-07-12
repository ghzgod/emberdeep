// Voice chat over the SAME Trystero room used for gameplay (Obsidian 758/768).
// Modes: 'off' | 'ptt' (hold V / hold the mic button) | 'auto' (voice-activated
// with an adjustable trigger threshold, set in Settings).
//
// Trystero meshes audio automatically: room.addStream(stream) sends the mic to
// every peer, room.onPeerStream(stream, id) delivers theirs. So the old manual
// PeerJS call-dialing (one MediaConnection per pair) is gone - no more peer.call
// / answer bookkeeping. Muting still works by toggling the track's `enabled`.

import { selfId } from 'trystero/nostr';

const HANGOVER_MS = 450; // keep transmitting briefly after you stop speaking

export class VoiceChat {
  constructor() {
    this.mode = 'off';
    this.threshold = 12;       // 0-100, auto-detect trigger level
    this.stream = null;
    this.track = null;
    this.audioEls = new Map(); // peerId -> <audio>
    this.room = null;          // Trystero room (shared with net)
    this.sentTo = new Set();   // peers our stream has been pushed to
    this.myId = null;
    this.ptt = false;
    this.level = 0;
    this.transmitting = false;
    this._lastLoud = 0;
    this._monitor = null;
    this.onTransmitChange = null; // UI hook
  }

  get active() { return !!this.stream; }

  // Attach to the shared Trystero room. net OWNS onPeerJoin/onPeerLeave (single
  // assignable properties), so voice only takes onPeerStream (to play incoming
  // audio) and relies on the roster-driven syncPeers() below for send/cleanup.
  attachToRoom(room) {
    if (!room) return;
    const changed = this.room !== room;
    this.room = room;
    this.myId = (typeof selfId !== 'undefined' ? selfId : null);
    if (changed) room.onPeerStream = (stream, peerId) => this._playRemote(peerId, stream);
    if (this.stream) this._sendStreamTo();
  }

  // Called by the game on every 'peers' roster update. Push our mic to any
  // newly-seen peer and drop audio elements for peers that have left.
  syncPeers(ids) {
    if (!this.room) return;
    if (this.stream) for (const id of ids) if (id !== this.myId) this._sendStreamTo(id);
    for (const id of [...this.audioEls.keys()]) if (!ids.includes(id)) this._removePeer(id);
  }

  _sendStreamTo(peerId) {
    if (!this.room || !this.stream) return;
    try {
      if (peerId) { if (!this.sentTo.has(peerId)) { this.room.addStream(this.stream, { target: peerId }); this.sentTo.add(peerId); } }
      else { this.room.addStream(this.stream); } // broadcast to all current peers
    } catch { /* addStream can race a leaving peer; ignore */ }
  }

  _playRemote(peerId, remote) {
    let el = this.audioEls.get(peerId);
    if (!el) {
      el = document.createElement('audio');
      el.autoplay = true;
      el.style.display = 'none';
      document.body.appendChild(el);
      this.audioEls.set(peerId, el);
    }
    el.volume = this.outputVolume ?? 0.9;
    el.srcObject = remote;
    el.play().catch(() => {});
  }

  async enable(mode, threshold) {
    this.mode = mode;
    this.threshold = threshold ?? this.threshold;
    if (mode === 'off') { this.disable(); return true; }
    if (this.stream) return true;
    // Two callers can race here (e.g. the meter monitor and the session join
    // both call enable() on the same gesture). Mobile Safari rejects a second
    // concurrent getUserMedia for the mic, which surfaced as a bogus "no
    // microphone" in auto mode. Share one in-flight request so both callers
    // await the same acquisition instead of firing a doomed duplicate.
    if (this._acquiring) return this._acquiring;
    this._acquiring = (async () => {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch (err) {
        console.warn('[voice] microphone unavailable', err);
        this.mode = 'off';
        return false;
      }
      await this._setupMonitor();
      return true;
    })();
    try {
      return await this._acquiring;
    } finally {
      this._acquiring = null;
    }
  }

  async _setupMonitor() {
    this.track = this.stream.getAudioTracks()[0];
    this.track.enabled = false;

    // level meter for auto-detection. A fresh AudioContext starts suspended
    // (autoplay policy) and would feed the analyser silence, so resume it —
    // enable() is always triggered by a user gesture (settings toggle).
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this._ctx = new Ctx();
    try { await this._ctx.resume(); } catch { /* resumes on next gesture */ }
    const src = this._ctx.createMediaStreamSource(this.stream);
    this._analyser = this._ctx.createAnalyser();
    this._analyser.fftSize = 512;
    src.connect(this._analyser);
    this._buf = new Uint8Array(this._analyser.fftSize);
    this._monitor = setInterval(() => this._tick(), 60);

    // the mic now exists - push it into the shared Trystero room so every peer
    // (current and future) receives it.
    if (this.room) this._sendStreamTo();
  }

  // Settings "mic test": keep the mic un-muted so the level meter reads input
  // without transmitting to anyone.
  setMonitor(on) { this.monitor = on; }

  // Record ~3s from the mic and play it straight back, so the user can confirm
  // their microphone actually works. Never transmitted. onState(stage) reports
  // 'record' -> 'play' -> 'done' (or throws if the mic is unavailable).
  async testMic(onState) {
    const owned = !this.stream;
    const stream = this.stream || await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const wasEnabled = this.track ? this.track.enabled : null;
    if (this.track) this.track.enabled = true; // make sure input is captured
    const rec = new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    onState?.('record');
    return new Promise((resolve, reject) => {
      rec.onstop = () => {
        if (this.track) this.track.enabled = wasEnabled ?? false;
        if (owned) stream.getTracks().forEach((t) => t.stop()); // release a borrowed mic
        if (!chunks.length) { onState?.('done'); return resolve('empty'); }
        const url = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
        const a = new Audio(url);
        onState?.('play');
        a.onended = () => { URL.revokeObjectURL(url); onState?.('done'); resolve('done'); };
        a.onerror = () => { URL.revokeObjectURL(url); onState?.('done'); resolve('playfail'); };
        a.play().catch(() => { onState?.('done'); resolve('playfail'); });
      };
      rec.onerror = (e) => reject(e.error || new Error('record failed'));
      rec.start();
      setTimeout(() => { try { rec.stop(); } catch {} }, 3000);
    });
  }

  _tick() {
    if (!this._analyser) return;

    let want = false;
    if (this.mode === 'ptt') {
      want = this.ptt;
    } else if (this.mode === 'auto') {
      // level was computed last tick; decide before we (maybe) mute below
      const now = performance.now();
      if (this.level >= this.threshold) this._lastLoud = now;
      want = now - this._lastLoud < HANGOVER_MS;
    }
    // keep the track live if transmitting OR just monitoring for the meter,
    // so the analyser always sees real input when settings are open
    if (this.track) this.track.enabled = want || !!this.monitor;

    this._analyser.getByteTimeDomainData(this._buf);
    let sum = 0;
    for (let i = 0; i < this._buf.length; i++) {
      const v = (this._buf[i] - 128) / 128;
      sum += v * v;
    }
    this.level = Math.min(100, Math.round(Math.sqrt(sum / this._buf.length) * 320));

    if (want !== this.transmitting) {
      this.transmitting = want;
      this.onTransmitChange?.(want);
    }
  }

  setOutputVolume(v) {
    this.outputVolume = v;
    for (const el of this.audioEls.values()) el.volume = v;
  }

  _removePeer(id) {
    this.sentTo.delete(id);
    const el = this.audioEls.get(id);
    if (el) { el.remove(); this.audioEls.delete(id); }
  }

  disable() {
    clearInterval(this._monitor);
    this._monitor = null;
    if (this.room && this.stream) { try { this.room.removeStream(this.stream); } catch { /* ignore */ } }
    for (const el of this.audioEls.values()) el.remove();
    this.audioEls.clear();
    this.sentTo.clear();
    if (this.track) this.track.stop();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    try { this._ctx?.close(); } catch {}
    this.stream = null;
    this.track = null;
    this.transmitting = false;
    this.onTransmitChange?.(false);
  }
}

export const voice = new VoiceChat();
