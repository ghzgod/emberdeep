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

    // add our audio into any calls that were answered before the mic existed
    for (const call of this.calls.values()) {
      try {
        const sender = call.peerConnection?.getSenders?.().find((s) => !s.track || s.track.kind === 'audio');
        if (sender && !sender.track) sender.replaceTrack(this.track);
      } catch { /* renegotiation not critical */ }
    }
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
