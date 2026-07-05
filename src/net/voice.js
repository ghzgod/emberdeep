// Voice chat over the same PeerJS connections used for gameplay.
// Modes: 'off' | 'ptt' (hold V / hold the mic button) | 'auto' (voice-activated
// with an adjustable trigger threshold, set in Settings).

const HANGOVER_MS = 450; // keep transmitting briefly after you stop speaking

export class VoiceChat {
  constructor() {
    this.mode = 'off';
    this.threshold = 12;       // 0-100, auto-detect trigger level
    this.stream = null;
    this.track = null;
    this.calls = new Map();    // peerId -> MediaConnection
    this.audioEls = new Map(); // peerId -> <audio>
    this.peer = null;
    this.myId = null;
    this.ptt = false;
    this.level = 0;
    this.transmitting = false;
    this._lastLoud = 0;
    this._monitor = null;
    this.onTransmitChange = null; // UI hook
  }

  get active() { return !!this.stream; }

  attachToPeer(peer) {
    this.peer = peer;
    this.myId = peer.id;
    peer.on('call', (call) => {
      call.answer(this.stream || undefined);
      this._wireCall(call);
    });
  }

  async enable(mode, threshold) {
    this.mode = mode;
    this.threshold = threshold ?? this.threshold;
    if (mode === 'off') { this.disable(); return true; }
    if (this.stream) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      console.warn('[voice] microphone unavailable', err);
      this.mode = 'off';
      return false;
    }
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

    // add our audio into any calls that were answered before the mic existed
    for (const call of this.calls.values()) {
      try {
        const sender = call.peerConnection?.getSenders?.().find((s) => !s.track || s.track.kind === 'audio');
        if (sender && !sender.track) sender.replaceTrack(this.track);
      } catch { /* renegotiation not critical */ }
    }
    return true;
  }

  // Settings "mic test": keep the mic un-muted so the level meter reads input
  // without transmitting to anyone.
  setMonitor(on) { this.monitor = on; }

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

  // Ensure exactly one call per peer pair: the lexicographically smaller id dials.
  syncPeers(ids) {
    if (!this.peer || this.mode === 'off') return;
    for (const id of ids) {
      if (id === this.myId || this.calls.has(id)) continue;
      if (this.myId < id && this.stream) {
        const call = this.peer.call(id, this.stream);
        this._wireCall(call);
      }
    }
    // drop calls to peers that left
    for (const [id, call] of this.calls) {
      if (!ids.includes(id)) {
        try { call.close(); } catch {}
        this._removePeer(id);
      }
    }
  }

  setOutputVolume(v) {
    this.outputVolume = v;
    for (const el of this.audioEls.values()) el.volume = v;
  }

  _wireCall(call) {
    this.calls.set(call.peer, call);
    call.on('stream', (remote) => {
      let el = this.audioEls.get(call.peer);
      if (!el) {
        el = document.createElement('audio');
        el.autoplay = true;
        el.style.display = 'none';
        document.body.appendChild(el);
        this.audioEls.set(call.peer, el);
      }
      el.volume = this.outputVolume ?? 0.9;
      el.srcObject = remote;
      el.play().catch(() => {});
    });
    call.on('close', () => this._removePeer(call.peer));
    call.on('error', () => this._removePeer(call.peer));
  }

  _removePeer(id) {
    this.calls.delete(id);
    const el = this.audioEls.get(id);
    if (el) { el.remove(); this.audioEls.delete(id); }
  }

  disable() {
    clearInterval(this._monitor);
    this._monitor = null;
    for (const call of this.calls.values()) { try { call.close(); } catch {} }
    for (const el of this.audioEls.values()) el.remove();
    this.calls.clear();
    this.audioEls.clear();
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
