import * as THREE from 'three';
import { CLASSES, buildHeroMesh } from '../entities/classes.js';
import { SKIN_TONES, GENDERS, HAIR_TONES, EYE_COLORS, FACE_SHAPES, HAIR_STYLES, buildAnimatedHero } from '../entities/heroModel.js';
import { SKILLS } from '../entities/skills.js';
import { svgIcon, ICONS, CLASS_ICONS } from './icons.js';
import { RARITIES, statLabel, sellValue, buyPrice } from '../entities/loot.js';
import { makeItemIcon } from '../entities/itemIcon.js';
import { SaveManager } from '../core/save.js';
import { Floaters } from './floaters.js';
import { Minimap } from './minimap.js';
import { audio } from '../core/audio.js';
import { isTouchDevice, isCompactLayout } from '../core/touch.js';

const $ = (id) => document.getElementById(id);

// All HTML/CSS UI: screens, HUD, hotbar, inventory, toasts.
export class UI {
  constructor(game) {
    this.game = game;
    this.floaters = new Floaters(game.camera);
    this.minimap = new Minimap();
    this.screens = {
      loading: $('loading-screen'),
      title: $('title-screen'),
      saves: $('saves-screen'),
      mp: $('mp-screen'),
      charselect: $('charselect-screen'),
      pause: $('pause-screen'),
      quest: $('quest-screen'),
      skills: $('skills-screen'),
      story: $('story-screen'),
      notices: $('notices-screen'),
      chatlog: $('chat-log-screen'),
      settings: $('settings-screen'),
      inventory: $('inventory-screen'),
      shop: $('shop-screen'),
      gameover: $('gameover-screen'),
      victory: $('victory-screen'),
    };
    this.hud = $('hud');
    this.settingsReturnTo = 'title';
    this.hotbarSlots = [];
    this.wireMenus();
    this.wireActionBar();
    this.wireSettings();
    this.wireMinimap();
    this.buildClassCards();
    this.initChat();
    this.addUiSounds();
    this.wireInventoryDragGlobal();
  }

  // Minimap: barely-visible by default so it doesn't clutter the view, tap to
  // expand into a big readable view of everything discovered on the floor so
  // far, tap again to shrink. Idle-fades back to the transparent resting
  // state a few seconds after the player stops interacting with it.
  wireMinimap() {
    const canvas = $('minimap');
    if (!canvas) return;
    const NORMAL_RES = 180, EXPANDED_RES = 480;
    let idleTimer = null;
    const settle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => canvas.classList.remove('mm-active'), 2500);
    };
    const wake = () => { canvas.classList.add('mm-active'); settle(); };
    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const expanding = !canvas.classList.contains('expanded');
      canvas.classList.toggle('expanded', expanding);
      // bump the drawing resolution up while expanded so the enlarged view
      // stays crisp instead of just stretching the small bitmap.
      const res = expanding ? EXPANDED_RES : NORMAL_RES;
      if (canvas.width !== res) { canvas.width = res; canvas.height = res; }
      wake();
    });
    // any pointer activity elsewhere on the map keeps it awake while open;
    // once collapsed it just relies on the tap handler above.
    canvas.addEventListener('pointermove', wake);
    wake();
  }

  // ---------- screens ----------
  show(name) {
    for (const [k, el] of Object.entries(this.screens)) {
      el.classList.toggle('visible', k === name);
    }
    // The character-creation 3D preview only lives while its screen is up:
    // spun up on entry, renderer/scene torn down the moment any other screen
    // (or none) takes over, so no hidden WebGL context keeps burning frames.
    if (name === 'charselect') this.startCharPreview();
    else if (this._csPrev) this.stopCharPreview();
    // Ember particles only run behind the title screen itself -- never while
    // the game plays or any other menu is up, so they can't burn frames once
    // gameplay starts.
    if (name === 'title') this.startTitleEmbers();
    else this.stopTitleEmbers();
    // Any real overlay (pause/inventory/gameover/etc) immediately cuts the
    // low-health warning (glow + heartbeat) -- updateHud only runs during
    // 'playing' so it can't retire this on its own once the frame stops
    // ticking. Returning to gameplay (show('__none__')) needs no action here:
    // updateHud re-evaluates and reinstates it the very next frame if HP is
    // still low.
    if (name !== '__none__') this.setLowHealthFx(false);
  }
  hideAll() { this.show('__none__'); }
  showHud(visible) { this.hud.classList.toggle('hidden', !visible); }

  setLoadingProgress(frac, text) {
    $('loading-bar').style.width = `${Math.round(frac * 100)}%`;
    if (text) $('loading-text').textContent = text;
  }

  // Show the loading screen over the game (act travel / floor load). Reuses the
  // boot loading-screen element + bar, so progress here shares the same styling.
  showLoading(frac = 0, text = 'Loading…') {
    this.setLoadingProgress(frac, text);
    this.screens.loading.classList.add('visible');
  }
  hideLoading() {
    this.screens.loading.classList.remove('visible');
  }

  showTitle() {
    this.show('title');
    this.showHud(false);
  }

  // ---------- Title-screen embers ----------
  // Drifting ember particles rising behind EMBERDEEP: plain canvas 2D, a
  // capped particle count, and it skips starting entirely under
  // prefers-reduced-motion rather than offer a half-motion fallback nobody
  // asked for. show() starts/stops this so it only ever runs while the title
  // screen itself is on top -- it's torn down before gameplay or any other
  // menu can render a frame under it.
  startTitleEmbers() {
    if (this._emberRaf) return;
    const canvas = $('title-embers');
    if (!canvas) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = canvas.getContext('2d');
    const resize = () => {
      canvas.width = Math.max(1, canvas.clientWidth) * (window.devicePixelRatio || 1);
      canvas.height = Math.max(1, canvas.clientHeight) * (window.devicePixelRatio || 1);
    };
    resize();
    this._emberResize = resize;
    window.addEventListener('resize', resize);
    const COUNT = 30;
    const parts = Array.from({ length: COUNT }, () => this._spawnEmber(canvas, true));
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of parts) {
        p.y -= p.speed * dt * canvas.height;
        p.t += dt * p.wobbleSpeed;
        p.x += Math.sin(p.t) * p.wobble * dt * canvas.width;
        p.life -= dt;
        if (p.life <= 0 || p.y < -p.size * 2) Object.assign(p, this._spawnEmber(canvas, false));
        const fade = Math.max(0, Math.min(1, p.life / p.maxLife));
        ctx.globalAlpha = fade * p.opacity;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
        g.addColorStop(0, 'rgba(255, 205, 120, 1)');
        g.addColorStop(0.5, 'rgba(232, 140, 60, 0.7)');
        g.addColorStop(1, 'rgba(180, 60, 20, 0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      this._emberRaf = requestAnimationFrame(tick);
    };
    this._emberRaf = requestAnimationFrame(tick);
  }

  // A single ember: rises from near the bottom, drifting sideways with a
  // gentle sine wobble, fading in/out over its lifetime. randomY seeds the
  // initial batch at random heights so the screen isn't empty on launch;
  // respawns always start low so they read as continuously rising.
  _spawnEmber(canvas, randomY) {
    const w = canvas.width, h = canvas.height;
    const maxLife = 3.5 + Math.random() * 3.5;
    return {
      x: Math.random() * w,
      y: randomY ? Math.random() * h : h + Math.random() * 30,
      size: (1.1 + Math.random() * 2.1) * (window.devicePixelRatio || 1),
      speed: 0.045 + Math.random() * 0.06,
      wobble: 0.25 + Math.random() * 0.35,
      wobbleSpeed: 0.4 + Math.random() * 1.0,
      t: Math.random() * 10,
      opacity: 0.35 + Math.random() * 0.45,
      life: maxLife, maxLife,
    };
  }

  stopTitleEmbers() {
    if (this._emberRaf) { cancelAnimationFrame(this._emberRaf); this._emberRaf = null; }
    if (this._emberResize) { window.removeEventListener('resize', this._emberResize); this._emberResize = null; }
  }

  // Themed replacement for native alert()/confirm(): resolves true on
  // OK/confirm, false on cancel, outside-click, or Esc. Pass notice: true for
  // a single-button acknowledgement (no cancel button). danger: true reuses
  // the destroy-modal's red styling on the card and confirm button.
  // dontShow: true adds a "Do not show again" checkbox to the modal. When
  // present, the promise resolves to an object { confirmed, dontShow } instead
  // of a bare boolean, so the caller can persist the preference.
  confirmModal({ title = '', message = '', confirmText = 'OK', cancelText = 'Cancel', danger = false, notice = false, dontShow = false, password = false } = {}) {
    return new Promise((resolve) => {
      const modal = $('confirm-modal'), card = $('confirm-card');
      const okBtn = $('btn-confirm-ok'), cancelBtn = $('btn-confirm-cancel');
      const dontRow = $('confirm-dontshow-row'), dontBox = $('confirm-dontshow');
      const pwRow = $('confirm-password-row'), pwInput = $('confirm-password');
      if (pwRow) pwRow.classList.toggle('hidden', !password);
      if (pwInput) pwInput.value = '';
      $('confirm-title').textContent = title;
      $('confirm-message').textContent = message;
      card.classList.toggle('danger', !!danger);
      okBtn.textContent = confirmText;
      okBtn.classList.toggle('danger', !!danger);
      cancelBtn.classList.toggle('hidden', !!notice);
      cancelBtn.textContent = cancelText;
      if (dontRow) dontRow.classList.toggle('hidden', !dontShow);
      if (dontBox) dontBox.checked = false;
      modal.classList.remove('hidden');
      audio.play('ui_open');
      const cleanup = (confirmed) => {
        modal.classList.add('hidden');
        if (dontRow) dontRow.classList.add('hidden');
        okBtn.onclick = null; cancelBtn.onclick = null;
        modal.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey);
        if (pwRow) pwRow.classList.add('hidden');
        resolve(dontShow ? { confirmed, dontShow: !!(dontBox && dontBox.checked) }
          : password ? { confirmed, password: pwInput ? pwInput.value : '' }
            : confirmed);
      };
      const onBackdrop = (e) => { if (e.target === modal) cleanup(false); };
      const onKey = (e) => { if (e.key === 'Escape') cleanup(false); };
      okBtn.onclick = () => cleanup(true);
      cancelBtn.onclick = () => cleanup(false);
      modal.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey);
    });
  }

  // Shared explainer for the battery-saver tradeoff, used both for the
  // one-time first-launch prompt (game.js boot()) and the "Full AI & Natural
  // Voices" toggle in Settings. A plain Confirm/Cancel modal explains what
  // will happen; Confirm applies the requested state, Cancel reverts to
  // whatever was active before.
  //
  // turningOn: true means the player wants full AI ON (battery saver OFF);
  // false means they want to go back to battery saver ON.
  //
  // Turning battery saver OFF requires the neural (Kokoro) voices. If they
  // were never downloaded/cached, this drives the download itself, right
  // here in the modal, with a progress bar; a cache hit (already downloaded)
  // applies instantly with no download step. Cancelling mid-download reverts
  // to battery saver ON, since the voices non-battery-saver mode needs never
  // finished loading.
  //
  // toggleEl, if given, is the checkbox that triggered this (Settings' live
  // toggle) so it can be flipped back to reflect a cancelled/reverted choice.
  // skipExplainer: the Settings toggles show their own one-time explainer in
  // onAiVoiceToggle, so they skip this method's built-in Confirm/Cancel prompt.
  // The boot first-launch prompt still uses the built-in explainer.
  async promptBatterySaverChoice(turningOn = true, toggleEl = null, skipExplainer = false) {
    const s = this.game.settings;
    const wasOn = s.batterySaver !== true; // full-AI state before this prompt
    const afterState = () => {
      this._syncAiVoiceToggles?.();
      if (this.screens.settings.classList.contains('visible')) this.reflectNeuralStatus();
    };
    if (!skipExplainer) {
      const confirmed = await this.confirmModal({
        title: 'Full AI & Natural Voices',
        message: turningOn
          ? 'Turning this ON enables smarter bosses that learn over time and natural neural voices. Uses more battery and memory, and may download voices once.'
          : 'Turning this OFF switches to basic built-in voices with no learning AI, to save battery and memory.',
        confirmText: 'Confirm', cancelText: 'Cancel',
      });
      if (!confirmed) {
        // Cancelled: revert to whatever was active before, no change applied.
        if (toggleEl) toggleEl.checked = wasOn;
        afterState();
        return;
      }
    }

    if (!turningOn) {
      // Turning full AI OFF: nothing to download, just persist.
      s.batterySaver = true;
      this.game.saveSettings();
      const { roaster } = await import('../ai/roaster.js');
      roaster.batterySaver = true;
      afterState();
      return;
    }

    // Turning full AI ON. Warn first on a device that would OOM on the heavy
    // download, same safeguard the "Retry neural voices" button uses.
    const { neuralVoice } = await import('../ai/neuralVoice.js');
    if (neuralVoice.memoryConstrained && neuralVoice.status !== 'ready') {
      const ok = await this.confirmModal({
        title: 'Download neural voices?',
        message: 'Neural voices are a large download (about 90 MB) and can crash the browser on phones and low-memory devices. Try anyway?',
        confirmText: 'Download', cancelText: 'Keep standard', danger: true,
      });
      if (!ok) { if (toggleEl) toggleEl.checked = wasOn; afterState(); return; } // stays as it was
      neuralVoice._optIn = true;
    }

    // Already cached/ready: apply instantly, no download UI.
    if (neuralVoice.ready) {
      s.batterySaver = false;
      this.game.saveSettings();
      const { roaster } = await import('../ai/roaster.js');
      roaster.batterySaver = false;
      afterState();
      return;
    }

    const finished = await this.runNeuralVoiceDownload();
    s.batterySaver = !finished; // completed -> OFF (full AI); cancelled/failed -> stays ON
    this.game.saveSettings();
    const { roaster } = await import('../ai/roaster.js');
    roaster.batterySaver = s.batterySaver;
    if (toggleEl) toggleEl.checked = !s.batterySaver;
    afterState();
  }

  // Drives the confirm modal into a non-dismissible download-progress state
  // (Cancel only, no OK, no backdrop/Esc close) while neuralVoice.load()
  // fetches the Kokoro model. Resolves true once loading completes
  // successfully, false if the player cancels or the load fails.
  async runNeuralVoiceDownload() {
    const { neuralVoice } = await import('../ai/neuralVoice.js');
    return new Promise((resolve) => {
      const modal = $('confirm-modal'), card = $('confirm-card');
      const okBtn = $('btn-confirm-ok'), cancelBtn = $('btn-confirm-cancel');
      const progRow = $('confirm-progress-row'), progBar = $('confirm-progress-bar'), progText = $('confirm-progress-text');
      $('confirm-title').textContent = 'Downloading neural voices…';
      $('confirm-message').textContent = 'This is a one-time ~90 MB download, cached afterwards. Cancelling keeps Battery Saver on.';
      card.classList.remove('danger');
      progRow.classList.remove('hidden');
      progBar.style.width = '0%';
      progText.textContent = 'Starting…';
      okBtn.classList.add('hidden');
      cancelBtn.classList.remove('hidden');
      cancelBtn.textContent = 'Cancel';
      modal.classList.remove('hidden');
      audio.play('ui_open');

      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        neuralVoice.onStatus = null;
        modal.classList.add('hidden');
        okBtn.classList.remove('hidden');
        cancelBtn.onclick = null;
        progRow.classList.add('hidden');
        resolve(ok);
      };
      // No true abort API on neuralVoice (from_pretrained has no cancel hook):
      // Cancel just stops listening/blocking here and reports "not finished".
      // The background fetch may still complete to status 'ready' later, but
      // roaster gates on settings.batterySaver (the caller reverts it to true
      // on a false resolve), so a late completion is never actually used.
      cancelBtn.onclick = () => finish(false);

      neuralVoice.onStatus = (status, progress) => {
        if (settled) return;
        if (status === 'loading') {
          const pct = Math.round((progress || 0) * 100);
          progBar.style.width = `${pct}%`;
          progText.textContent = pct > 0 ? `Downloading… ${pct}%` : 'Starting…';
        } else if (status === 'ready') {
          progBar.style.width = '100%';
          progText.textContent = 'Ready';
          finish(true);
        } else if (status === 'error') {
          finish(false);
        }
      };
      neuralVoice.retry(true).then((ok) => { if (!settled) finish(!!ok); });
    });
  }

  // Handles either of the two Settings toggles ("In-Game AI" /
  // "In-Game Natural Voices"). On the FIRST change of a given toggle, shows a
  // one-time explainer modal describing what it does and its battery impact,
  // with a "Do not show again" checkbox persisted to localStorage. Once
  // dismissed with that checked, further toggling is silent. Both toggles map
  // to the same underlying full-AI state, so we keep them in sync afterwards.
  async onAiVoiceToggle(which, turningOn, sync) {
    const key = which === 'ai' ? 'emberdeep-ai-modal-hide-v1' : 'emberdeep-voice-modal-hide-v1';
    const seen = localStorage.getItem(key) === '1';
    if (!seen) {
      const msg = which === 'ai'
        ? 'In-Game AI powers smarter bosses that learn and adapt over time. It runs machine learning in your browser, which uses more battery and memory. Turn it off to save power.'
        : 'In-Game Natural Voices give characters lifelike neural speech instead of your browser\'s basic built-in voices. The voice model is a one-time large download and uses more battery and memory.';
      const res = await this.confirmModal({
        title: which === 'ai' ? 'In-Game AI' : 'In-Game Natural Voices',
        message: msg,
        confirmText: 'Got it', cancelText: 'Cancel', dontShow: true,
      });
      if (!res.confirmed) { sync(); return; } // cancelled: revert both toggles
      if (res.dontShow) localStorage.setItem(key, '1');
    }
    // Apply the requested state through the shared battery-saver path (handles
    // the neural-voice download when turning natural voices on).
    await this.promptBatterySaverChoice(turningOn, null, true);
    sync();
  }

  // ---------- menu wiring ----------
  wireMenus() {
    $('btn-single').onclick = () => {
      this.game.setMultiplayer(false);
      this.renderSaves();
      this.show('saves');
    };
    $('btn-multi').onclick = () => {
      $('mp-status').textContent = '';
      $('mp-name').value = localStorage.getItem('emberdeep-name-v1') || '';
      this.show('mp');
    };
    // persist the name as it's typed, not only on Enter — survives any reload
    $('mp-name').addEventListener('input', () => {
      const v = $('mp-name').value.trim().slice(0, 14);
      if (v) localStorage.setItem('emberdeep-name-v1', v);
    });
    $('btn-mp-enter').onclick = async () => {
      const name = $('mp-name').value.trim().slice(0, 14);
      if (name) localStorage.setItem('emberdeep-name-v1', name);
      const room = $('mp-room').value.trim() || 'EMBER';
      $('mp-status').textContent = 'Connecting to room…';
      const result = await this.game.startMultiplayer(room);
      if (result.mode === 'error') {
        $('mp-status').textContent = result.error === 'timeout'
          ? 'Could not reach the room (timed out). Check your connection and try again.'
          : `Connection failed (${result.error}). Try again.`;
      } else if (result.mode === 'full') {
        $('mp-status').textContent = 'That room already has 4 heroes.';
      } else {
        $('mp-status').textContent = '';
        this.renderSaves(result.mode === 'host' ? 'You are the HOST of this room.' : 'Joined! You will enter the host’s world.');
        this.show('saves');
      }
    };
    $('btn-mp-back').onclick = () => this.show('title');
    $('btn-saves-back').onclick = () => { this.game.leaveMultiplayerLobby(); this.show('title'); };
    $('btn-new-character').onclick = async () => {
      if (!SaveManager.canCreate()) {
        $('saves-list').firstChild?.scrollIntoView();
        await this.confirmModal({ title: 'Roster full', message: 'Save limit reached (8). Delete a hero first.', notice: true });
        return;
      }
      this.resetClassSelect();
      this.show('charselect');
    };
    $('btn-charselect-back').onclick = () => { this.renderSaves(); this.show('saves'); };
    $('btn-shop-close').onclick = () => this.game.closeShop();
    $('btn-relic-take').onclick = () => { $('relic-reveal').classList.add('hidden'); this.renderShop?.(this.game.activeVendor); };
    $('btn-buy-confirm').onclick = () => this.confirmBuy();
    $('btn-buy-cancel').onclick = () => { $('buy-confirm').classList.add('hidden'); this._pendingBuy = null; };
    $('btn-destroy-confirm').onclick = () => {
      // destroy whatever confirmDestroy staged: bulk marks or a single item
      const doomed = this._destroyPending || [...(this.destroySel || [])];
      this.game.destroyItems(doomed);
      for (const it of doomed) this.destroySel?.delete(it);
      this._destroyPending = null;
      $('destroy-modal').classList.add('hidden');
      this.renderInventory();
    };
    $('btn-destroy-cancel').onclick = () => $('destroy-modal').classList.add('hidden');
    // Click anywhere on a modal's dimmed backdrop (but not its card) to dismiss it.
    $('relic-reveal').addEventListener('click', (e) => { if (e.target.id === 'relic-reveal') $('btn-relic-take').click(); });
    $('buy-confirm').addEventListener('click', (e) => { if (e.target.id === 'buy-confirm') $('btn-buy-cancel').click(); });
    $('destroy-modal').addEventListener('click', (e) => { if (e.target.id === 'destroy-modal') $('destroy-modal').classList.add('hidden'); });
    $('btn-act-cancel').onclick = () => $('act-select').classList.add('hidden');
    $('act-select').addEventListener('click', (e) => { if (e.target.id === 'act-select') $('act-select').classList.add('hidden'); });
    $('btn-flirt-leave').onclick = () => this.closeFlirt();
    $('flirt-dialog').addEventListener('click', (e) => { if (e.target.id === 'flirt-dialog') this.closeFlirt(); });
    $('btn-inspect-close').onclick = () => $('inspect-panel').classList.add('hidden');
    $('inspect-panel').addEventListener('click', (e) => { if (e.target.id === 'inspect-panel') $('inspect-panel').classList.add('hidden'); });
    $('item-actions').addEventListener('click', (e) => { if (e.target.id === 'item-actions') this.closeItemActions(); });
    $('btn-item-close').onclick = () => this.closeItemActions();
    $('btn-shop-restock').onclick = () => {
      if (this.game.activeVendor) this.game.restockVendor(this.game.activeVendor);
    };
    $('btn-title-settings').onclick = () => { this.settingsReturnTo = 'title'; this.show('settings'); this.armMicMonitor(); };
    $('btn-pause-settings').onclick = () => { this.settingsReturnTo = 'pause'; this.show('settings'); this.armMicMonitor(); };
    $('btn-settings-back').onclick = () => {
      this.disarmMicMonitor();
      if (this.settingsReturnTo === 'pause') this.show('pause');
      else this.show('title');
    };
    $('btn-resume').onclick = () => this.game.togglePause(false);
    $('btn-pause-quests').onclick = () => { this.game.state = 'quest'; this.openQuestLog(); };
    $('btn-quest-close').onclick = () => { this.game.state = 'playing'; this.hideAll(); };
    $('btn-pause-skills').onclick = () => { this.game.state = 'skills'; this.openSkills(); };
    $('btn-skills-close').onclick = () => { this.game.state = 'playing'; this.hideAll(); };
    $('btn-story-continue').onclick = () => { this.game.state = 'playing'; this.hideAll(); };
    $('btn-notices-close').onclick = () => { this.game.state = 'playing'; this.hideAll(); };
    $('btn-quit-title').onclick = () => this.game.quitToTitle();
    $('btn-respawn').onclick = () => this.game.respawn();
    $('btn-gameover-title').onclick = () => this.game.quitToTitle();
    $('btn-victory-continue').onclick = () => this.game.continueAfterVictory();
    $('btn-victory-title').onclick = () => this.game.quitToTitle();
  }

  addUiSounds() {
    document.querySelectorAll('button, .class-card').forEach((el) => {
      el.addEventListener('mouseenter', () => audio.play('ui_hover', { volume: 0.4, throttleMs: 40 }));
      el.addEventListener('click', () => audio.play('ui_click', { volume: 0.7 }));
    });
  }

  buildClassCards() {
    const wrap = $('class-cards');
    wrap.innerHTML = '';
    this.selectedClass = null;
    this.classCards = new Map();
    for (const cls of Object.values(CLASSES)) {
      const card = document.createElement('div');
      card.className = 'class-card';
      card.style.setProperty('--card-color', cls.uiColor);
      card.style.setProperty('--card-glow', cls.uiColor + '55');
      card.innerHTML = `
        <h3>${cls.name}</h3>
        <div class="class-role">${cls.role}</div>
        <div class="class-desc">${cls.desc}</div>
        <ul>${cls.abilities.map((a) => `<li><b>${svgIcon(a.icon)} ${a.name}</b> — ${a.desc}</li>`).join('')}</ul>
      `;
      card.onclick = () => {
        audio.play('ui_click', { volume: 0.7 });
        this.selectClass(cls);
      };
      card.addEventListener('mouseenter', () => audio.play('ui_hover', { volume: 0.4, throttleMs: 40 }));
      wrap.appendChild(card);
      this.classCards.set(cls.id, card);
    }
    // char-select name field: prefill from any saved/entered name, persist as typed
    const csName = $('cs-name');
    if (csName) {
      csName.value = localStorage.getItem('emberdeep-name-v1') || '';
      csName.addEventListener('input', () => {
        csName.classList.remove('input-error');
        const v = csName.value.trim().slice(0, 14);
        if (v) localStorage.setItem('emberdeep-name-v1', v);
        // the name seeds the hero's outfit cosmetics - refresh the preview
        // (debounced so mid-word typing doesn't rebuild every keystroke)
        clearTimeout(this._csNameT);
        this._csNameT = setTimeout(() => this.refreshCharPreview(), 350);
      });
    }
    this.buildAppearancePickers();
    $('btn-charselect-confirm').onclick = () => {
      // a name is REQUIRED before starting
      const name = (csName?.value || '').trim().slice(0, 14);
      if (!name) { csName?.classList.add('input-error'); csName?.focus(); return; }
      localStorage.setItem('emberdeep-name-v1', name);
      if (this.selectedClass) this.game.startNewGame(this.selectedClass);
    };
  }

  // Gender + skin-tone pickers for character creation. Each choice is persisted
  // to localStorage the instant it is clicked, and the Player constructor reads
  // those same keys when startNewGame builds the hero, so what you pick is what
  // spawns (and what gets written into the save via player.toSave).
  buildAppearancePickers() {
    const genderWrap = $('cs-gender');
    if (genderWrap) {
      const cur = localStorage.getItem('emberdeep-gender-v1') === 'female' ? 'female' : 'male';
      if (!localStorage.getItem('emberdeep-gender-v1')) localStorage.setItem('emberdeep-gender-v1', cur);
      genderWrap.innerHTML = '';
      for (const g of GENDERS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cs-gender-btn' + (g.id === cur ? ' selected' : '');
        btn.textContent = g.label;
        btn.onclick = () => {
          localStorage.setItem('emberdeep-gender-v1', g.id);
          audio.play('ui_click', { volume: 0.6 });
          genderWrap.querySelectorAll('.cs-gender-btn').forEach((b) => b.classList.remove('selected'));
          btn.classList.add('selected');
          this.refreshCharPreview();
        };
        genderWrap.appendChild(btn);
      }
    }
    const skinWrap = $('cs-skin');
    if (skinWrap) {
      const cur = SKIN_TONES.some((t) => t.id === localStorage.getItem('emberdeep-skin-v1'))
        ? localStorage.getItem('emberdeep-skin-v1') : 'light';
      if (!localStorage.getItem('emberdeep-skin-v1')) localStorage.setItem('emberdeep-skin-v1', cur);
      skinWrap.innerHTML = '';
      for (const t of SKIN_TONES) {
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'cs-skin-sw' + (t.id === cur ? ' selected' : '');
        sw.title = t.label;
        sw.setAttribute('aria-label', t.label);
        sw.style.background = '#' + t.hex.toString(16).padStart(6, '0');
        sw.onclick = () => {
          localStorage.setItem('emberdeep-skin-v1', t.id);
          audio.play('ui_click', { volume: 0.6 });
          skinWrap.querySelectorAll('.cs-skin-sw').forEach((b) => b.classList.remove('selected'));
          sw.classList.add('selected');
          this.refreshCharPreview();
        };
        skinWrap.appendChild(sw);
      }
    }
    const hairWrap = $('cs-hair');
    if (hairWrap) {
      // null = keep the rig's own baked hair (no swatch selected yet).
      const stored = localStorage.getItem('emberdeep-hair-v1');
      const cur = HAIR_TONES.some((t) => t.id === stored) ? stored : null;
      hairWrap.innerHTML = '';
      for (const t of HAIR_TONES) {
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'cs-hair-sw' + (t.id === cur ? ' selected' : '');
        sw.title = t.label;
        sw.setAttribute('aria-label', t.label);
        sw.style.background = '#' + t.hex.toString(16).padStart(6, '0');
        sw.onclick = () => {
          localStorage.setItem('emberdeep-hair-v1', t.id);
          audio.play('ui_click', { volume: 0.6 });
          hairWrap.querySelectorAll('.cs-hair-sw').forEach((b) => b.classList.remove('selected'));
          sw.classList.add('selected');
          this.refreshCharPreview();
        };
        hairWrap.appendChild(sw);
      }
    }
    // Eyes picker removed (TODO 698) - cs-eyes markup is gone; eyeColor
    // persists in saves but has no visual until a texture-level recolor.
    const faceWrap = $('cs-face');
    if (faceWrap) {
      const cur = FACE_SHAPES.some((t) => t.id === localStorage.getItem('emberdeep-face-v1'))
        ? localStorage.getItem('emberdeep-face-v1') : 'standard';
      if (!localStorage.getItem('emberdeep-face-v1')) localStorage.setItem('emberdeep-face-v1', cur);
      faceWrap.innerHTML = '';
      for (const t of FACE_SHAPES) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cs-face-btn' + (t.id === cur ? ' selected' : '');
        btn.textContent = t.label;
        btn.onclick = () => {
          localStorage.setItem('emberdeep-face-v1', t.id);
          audio.play('ui_click', { volume: 0.6 });
          faceWrap.querySelectorAll('.cs-face-btn').forEach((b) => b.classList.remove('selected'));
          btn.classList.add('selected');
          this.refreshCharPreview();
        };
        faceWrap.appendChild(btn);
      }
    }
    const hairStyleWrap = $('cs-hairstyle');
    if (hairStyleWrap) {
      const cur = HAIR_STYLES.some((t) => t.id === localStorage.getItem('emberdeep-hairstyle-v1'))
        ? localStorage.getItem('emberdeep-hairstyle-v1') : 'short';
      if (!localStorage.getItem('emberdeep-hairstyle-v1')) localStorage.setItem('emberdeep-hairstyle-v1', cur);
      hairStyleWrap.innerHTML = '';
      for (const t of HAIR_STYLES) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cs-hairstyle-btn' + (t.id === cur ? ' selected' : '');
        btn.textContent = t.label;
        btn.onclick = () => {
          localStorage.setItem('emberdeep-hairstyle-v1', t.id);
          audio.play('ui_click', { volume: 0.6 });
          hairStyleWrap.querySelectorAll('.cs-hairstyle-btn').forEach((b) => b.classList.remove('selected'));
          btn.classList.add('selected');
          this.refreshCharPreview();
        };
        hairStyleWrap.appendChild(btn);
      }
    }
  }

  // Tap/click selects and shows details; the confirm button starts the game.
  selectClass(cls) {
    this.selectedClass = cls.id;
    for (const [id, card] of this.classCards) {
      card.classList.toggle('selected', id === cls.id);
    }
    const detail = $('class-detail');
    detail.classList.remove('hidden');
    detail.style.setProperty('--card-color', cls.uiColor);
    detail.innerHTML = `
      <div class="class-desc">${cls.desc}</div>
      <ul>${cls.abilities.map((a) => `<li><b>${svgIcon(a.icon)} ${a.name}</b> — ${a.desc}</li>`).join('')}</ul>
    `;
    const btn = $('btn-charselect-confirm');
    btn.disabled = false;
    btn.textContent = `Begin as ${cls.name}`;
    this.refreshCharPreview();
  }

  resetClassSelect() {
    this.selectedClass = null;
    for (const card of this.classCards.values()) card.classList.remove('selected');
    $('class-detail').classList.add('hidden');
    const btn = $('btn-charselect-confirm');
    btn.disabled = true;
    btn.textContent = 'Choose a hero';
    this.refreshCharPreview();
  }

  // ---------- character-creation live 3D preview ----------
  // A small dedicated WebGL canvas on the charselect screen showing the
  // currently-selected class hero with the chosen gender + skin tone, slowly
  // rotating on a turntable with the idle animation playing. Rebuilt live on
  // every class/gender/skin/name change; fully disposed on leaving the screen.
  startCharPreview() {
    if (this._csPrev) { this.refreshCharPreview(); return; }
    const canvas = $('cs-preview-canvas');
    if (!canvas) return;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch { return; } // no WebGL for the preview: the screen still works without it
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const w = canvas.clientWidth || 190, h = canvas.clientHeight || 210;
    renderer.setSize(w, h, false);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, w / h, 0.1, 30);
    // 2.9 (was 3.4): the 712 redesign made this pane the large left column
    // and the old distance left the hero floating small inside it
    camera.position.set(0, 1.3, 2.9);
    camera.lookAt(0, 0.9, 0);
    // warm key + cool violet rim on a soft hemisphere, matching the game's
    // torchlit gold-on-dark-purple mood
    scene.add(new THREE.HemisphereLight(0xcdc4ea, 0x2a2033, 1.15));
    const key = new THREE.DirectionalLight(0xffe2b0, 1.7);
    key.position.set(2.2, 3.5, 2.6);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x8a6cff, 0.8);
    rim.position.set(-2.5, 2, -2);
    scene.add(rim);
    const turntable = new THREE.Group();
    scene.add(turntable);
    const P = this._csPrev = {
      renderer, scene, camera, turntable, canvas,
      lastT: performance.now(), hero: null, raf: 0, w, h,
    };
    this.refreshCharPreview();
    const loop = () => {
      if (this._csPrev !== P) return;
      P.raf = requestAnimationFrame(loop);
      // track CSS size changes (orientation flip, media-query resize)
      const cw = P.canvas.clientWidth, ch = P.canvas.clientHeight;
      if (cw && ch && (cw !== P.w || ch !== P.h)) {
        P.w = cw; P.h = ch;
        P.renderer.setSize(cw, ch, false);
        P.camera.aspect = cw / ch;
        P.camera.updateProjectionMatrix();
      }
      const now = performance.now();
      const dt = Math.min(0.05, (now - P.lastT) / 1000);
      P.lastT = now;
      P.turntable.rotation.y += dt * 0.7;
      if (P.hero) {
        if (P.hero.anim) P.hero.anim.setLocomotion(0, dt, false);
        if (P.hero.anim) P.hero.anim.mixer.update(dt);
        if (P.hero.gait) P.hero.gait(dt, 0, false);
        // female head shrink: after the mixer, because the idle keys scale
        if (P.hero.headBone) P.hero.headBone.scale.setScalar(P.hero.headScale);
      }
      P.renderer.render(P.scene, P.camera);
    };
    loop();
  }

  // Tear down just the hero (per-preview cloned materials and the tinted skin
  // CanvasTexture). Geometry is SHARED with the preloaded game models
  // (skeletonClone reuses it), so it is never disposed here.
  _disposePreviewHero() {
    const P = this._csPrev;
    if (!P || !P.hero) return;
    P.turntable.remove(P.hero.mesh);
    P.hero.mesh.traverse((o) => {
      if (o.isMesh && o.material) {
        if (o.material.map && o.material.map.isCanvasTexture) o.material.map.dispose();
        o.material.dispose();
      }
    });
    P.hero = null;
  }

  refreshCharPreview() {
    const P = this._csPrev;
    if (!P) return;
    this._disposePreviewHero();
    const clsId = this.selectedClass || 'knight';
    const name = ($('cs-name')?.value || '').trim() || 'Hero';
    const gender = localStorage.getItem('emberdeep-gender-v1') === 'female' ? 'female' : 'male';
    const skinTone = localStorage.getItem('emberdeep-skin-v1') || 'light';
    const storedHair = localStorage.getItem('emberdeep-hair-v1');
    const hairColor = HAIR_TONES.some((t) => t.id === storedHair) ? storedHair : null;
    const storedEyes = localStorage.getItem('emberdeep-eyes-v1');
    const eyeColor = EYE_COLORS.some((t) => t.id === storedEyes) ? storedEyes : 'brown';
    const storedFace = localStorage.getItem('emberdeep-face-v1');
    const faceShape = FACE_SHAPES.some((t) => t.id === storedFace) ? storedFace : 'standard';
    const storedHairStyle = localStorage.getItem('emberdeep-hairstyle-v1');
    const hairStyle = HAIR_STYLES.some((t) => t.id === storedHairStyle) ? storedHairStyle : 'short';
    // Same builder + same creation options the real Player uses, so what spins
    // here is exactly what spawns. Primitive fallback only if the GLB failed.
    const anim = buildAnimatedHero(clsId, name, { gender, skinTone, hairColor, eyeColor, faceShape, hairStyle });
    let mesh, gait = null;
    if (anim) {
      mesh = anim.mesh;
    } else {
      mesh = buildHeroMesh(CLASSES[clsId], name);
      gait = mesh.userData.updateGait;
    }
    // PREVIEW-ONLY gender amplification: the in-game female silhouette hint
    // (x0.94 / y1.03 in buildAnimatedHero) is deliberately subtle and reads
    // as near-identical on this small turntable, so the preview pushes it
    // further - noticeably slimmer + taller build and a smaller head - so
    // male vs female are visibly different the moment the picker flips. The
    // head shrink must be re-applied AFTER every mixer.update in the render
    // loop because the idle animation keys bone scale and resets it each
    // frame. The spawned in-game hero keeps the subtle proportions untouched.
    let headBone = null;
    if (gender === 'female') {
      mesh.scale.x *= 0.85;
      mesh.scale.z *= 0.85;
      mesh.scale.y *= 1.06;
      mesh.traverse((o) => { if (!headBone && o.isBone && /^head$/i.test(o.name)) headBone = o; });
    }
    P.turntable.add(mesh);
    P.hero = { mesh, anim, gait, headBone, headScale: 0.86 };
  }

  stopCharPreview() {
    const P = this._csPrev;
    if (!P) return;
    cancelAnimationFrame(P.raf);
    this._disposePreviewHero();
    P.renderer.dispose();
    P.renderer.forceContextLoss?.();
    this._csPrev = null;
  }

  // ---------- save slots ----------
  renderSaves(statusMsg = '') {
    const wrap = $('saves-list');
    wrap.innerHTML = '';
    if (statusMsg) {
      const s = document.createElement('div');
      s.className = 'saves-empty';
      s.textContent = statusMsg;
      wrap.appendChild(s);
    }
    const saves = SaveManager.listSaves();
    if (!saves.length) {
      const e = document.createElement('div');
      e.className = 'saves-empty';
      e.textContent = 'No heroes yet — forge one below.';
      wrap.appendChild(e);
      return;
    }
    // One-click resume of the most-recently-played hero: the game you just
    // refreshed out of. Both Single Player and Multiplayer land on this screen,
    // so this covers "pick a mode, then Resume" for either. continueGame drops
    // you back onto the exact dungeon floor when you were mid-run.
    const recent = saves[0];
    const rp = recent.data.player;
    const rcls = CLASSES[rp.classId];
    const where = recent.data.inDungeon ? `Floor ${recent.data.floor || 1}` : 'Embervale';
    const resumeBtn = document.createElement('button');
    resumeBtn.className = 'menu-btn resume-btn';
    resumeBtn.innerHTML = `<span class="resume-play">&#9654;</span> Resume: ${rcls ? rcls.name : rp.classId} Lv ${rp.level} <span class="resume-where">${where}</span>`;
    resumeBtn.onclick = () => { audio.play('ui_click', { volume: 0.7 }); this.game.continueGame(recent.id); };
    wrap.appendChild(resumeBtn);
    for (const slot of saves) {
      const p = slot.data.player;
      const row = document.createElement('div');
      row.className = 'save-row';
      const ago = timeAgo(slot.updatedAt);
      const cls = CLASSES[p.classId];
      row.innerHTML = `
        <span class="save-icon">${svgIcon(CLASS_ICONS[p.classId] || 'swords')}</span>
        <span class="save-main">
          <div class="save-name">${cls ? cls.name : p.classId} — Level ${p.level}</div>
          <div class="save-sub">Floor ${slot.data.floor || 1} · ${p.gold}g · ${ago}</div>
        </span>
        <button class="save-del" title="Delete hero">✕</button>
      `;
      row.querySelector('.save-del').onclick = async (e) => {
        e.stopPropagation();
        const ok = await this.confirmModal({
          title: 'Delete hero',
          message: `Delete this ${cls ? cls.name : 'hero'} forever?`,
          confirmText: 'Delete', danger: true,
        });
        if (ok) {
          SaveManager.deleteSlot(slot.id);
          this.renderSaves();
        }
      };
      row.onclick = () => {
        audio.play('ui_click', { volume: 0.7 });
        this.game.continueGame(slot.id);
      };
      wrap.appendChild(row);
    }
  }

  // ---------- notice board ----------
  // Camera-zoomed-onto-the-board view (Obsidian 727): one wooden plank panel
  // with all three notices pinned side by side, every one fully readable at
  // once - no preview/expand round-trip. A parchment rustle plays on open
  // instead of the generic UI-open blip.
  openNotices(notices) {
    this._notices = notices;
    this.renderNotices();
    this.show('notices');
    audio.play('parchment_rustle');
  }

  renderNotices() {
    const list = $('notices-list');
    list.innerHTML = '';
    list.classList.add('notice-board-wood');
    for (const nt of this._notices || []) {
      const paper = document.createElement('div');
      paper.className = 'notice-paper';
      paper.innerHTML = `<h4>${svgIcon(nt.icon || 'scroll')} ${nt.title}</h4><p>${nt.text}</p>`;
      list.appendChild(paper);
    }
  }

  // ---------- story cards ----------
  showStory(story) {
    $('story-title').textContent = story.title;
    $('story-text').textContent = story.text;
    this.show('story');
    audio.play('ui_open');
  }

  // ---------- mastery tree ----------
  openSkills() {
    const p = this.game.player;
    const pts = p.skillPoints();
    $('skills-points').innerHTML = pts > 0
      ? `<b>${pts}</b> point${pts === 1 ? '' : 's'} to spend — one earned per level`
      : 'No points to spend — level up to earn more';
    const grid = $('skills-grid');
    grid.innerHTML = '';
    let branch = '', groupEl = null;
    for (const sk of SKILLS) {
      if (sk.branch !== branch) {
        // Each branch is its own column-block so the tree lays out as several
        // side-by-side columns instead of one tall scrolling list.
        branch = sk.branch;
        groupEl = document.createElement('div');
        groupEl.className = 'skill-group';
        const h = document.createElement('div');
        h.className = 'skills-branch';
        h.textContent = branch;
        groupEl.appendChild(h);
        grid.appendChild(groupEl);
      }
      const rank = p.skillRank(sk.id);
      const row = document.createElement('div');
      row.className = `skill-row ${rank >= sk.max ? 'maxed' : ''}`;
      row.innerHTML = `
        <span class="skill-icon">${svgIcon(sk.id) || sk.icon}</span>
        <span class="skill-main">
          <div class="skill-name">${sk.name} <span class="skill-rank">${rank}/${sk.max}</span></div>
          <div class="skill-desc">${sk.per} per rank</div>
        </span>
        <button class="skill-buy menu-btn small" ${pts <= 0 || rank >= sk.max ? 'disabled' : ''}>+</button>
      `;
      row.querySelector('.skill-buy').onclick = () => this.game.buySkill(sk.id);
      groupEl.appendChild(row);
    }
    this.show('skills');
  }

  // ---------- quest log ----------
  // Flat-stroke state marks (currentColor, tinted per row-state in CSS):
  // check = completed, reticle = the hunt in progress, padlock = not yet open.
  static QUEST_MARKS = {
    done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12.5l5 5L19.5 7"/></svg>',
    active: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.6"/><path d="M12 1.8v3M12 19.2v3M1.8 12h3M19.2 12h3"/></svg>',
    locked: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    abyss: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 5.5l6 6 6-6M6 13l6 6 6-6"/></svg>',
  };

  openQuestLog() {
    const qs = this.game.questState();
    const list = $('quest-list');
    list.innerHTML = '';
    const M = UI.QUEST_MARKS;
    for (const a of qs.acts) {
      const state = a.cleared ? 'done' : a.current ? 'active' : 'locked';
      const row = document.createElement('div');
      row.className = `quest-row ${state}`;
      const pct = Math.round((a.progress / a.total) * 100);
      // Cleared: a satisfying checked state (gold check, "Complete", reward
      // marked claimed). Active: objective + a floor-progress bar with n/m.
      // Locked: objective + the reward it will pay, dimmed.
      const progressRow = a.cleared ? '' : `
          <div class="quest-progress">
            <span class="qp-track"><span class="qp-fill" style="width:${pct}%"></span></span>
            <span class="qp-num">${a.progress}/${a.total}</span>
          </div>`;
      row.innerHTML = `
        <span class="quest-mark">${M[state]}</span>
        <span class="quest-main">
          <div class="quest-title">${a.title}</div>
          <div class="quest-obj">${a.cleared ? 'Complete' : a.objective}</div>${progressRow}
          <div class="quest-reward">${a.cleared ? 'Claimed' : 'Reward'}: ${a.reward}</div>
        </span>`;
      list.appendChild(row);
    }
    if (qs.done) {
      const row = document.createElement('div');
      row.className = 'quest-row active';
      row.innerHTML = `<span class="quest-mark">${M.abyss}</span><span class="quest-main"><div class="quest-title">The Endless Abyss</div><div class="quest-obj">Descend as far as you dare.</div></span>`;
      list.appendChild(row);
    }
    $('quest-stats').innerHTML = Object.entries(qs.stats)
      .map(([k, v]) => `<div class="qs-row"><span>${k}</span><b>${v}</b></div>`).join('');
    this.show('quest');
    audio.play('ui_open');
  }

  // ---------- vendor shop ----------
  openShop(vendor) {
    this.renderShop(vendor);
    this.show('shop');
    audio.play('ui_open');
    this._startShopTick();
  }

  // Live ticker for the shop screen (nothing in the normal HUD update loop
  // runs while state === 'shop' - the world freezes - so Zoltan's "fate
  // rests" countdown needs its own small interval). Self-clears the moment
  // the shop screen is no longer visible, so closeShop() (in game.js, off
  // limits here) needs no matching teardown call.
  _startShopTick() {
    clearInterval(this._shopTickId);
    this._shopTickId = setInterval(() => {
      if (!this.screens.shop.classList.contains('visible')) { clearInterval(this._shopTickId); this._shopTickId = null; return; }
      const pend = this._pendingBuy;
      if (pend && pend.entry.kind === 'gamble' && !$('buy-confirm').classList.contains('hidden')) {
        this.refreshGambleCountdown();
      }
    }, 500);
  }

  // M:SS, used for Zoltan's rolling-window cooldown (can run past a minute).
  formatMMSS(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // Refreshes just the confirm button's label/disabled state against the
  // live gamble cooldown, without re-running the whole showBuyConfirm build
  // (which would also re-flash the rarity glow etc every tick).
  refreshGambleCountdown() {
    const buyBtn = $('btn-buy-confirm');
    const left = Math.ceil((this.game.gambleReadyAt() - performance.now()) / 1000);
    if (left > 0) {
      buyBtn.disabled = true;
      buyBtn.textContent = `Fate rests (${this.formatMMSS(left)})`;
      return;
    }
    const p = this.game.player;
    const entry = this._pendingBuy.entry;
    const broke = p.gold < entry.price;
    buyBtn.disabled = broke;
    buyBtn.textContent = broke ? 'Not enough gold' : 'Buy';
  }

  // Real item glyph for a shop entry (Obsidian 777): gear uses the same
  // canvas item-icon the inventory renders; consumables use a themed SVG
  // glyph (flask/bag/orb) instead of a raw emoji (the "first-aid helmet" and
  // friends were unicode emojis rendered by the system font).
  shopIconHtml(entry) {
    if (entry.item) return `<img class="shop-item-pic" src="${makeItemIcon(entry.item)}" alt="">`;
    const glyph = entry.kind === 'bag' ? 'bag' : entry.kind === 'gamble' ? 'orb' : 'flask';
    return svgIcon(glyph);
  }

  renderShop(vendor) {
    const p = this.game.player;
    const FLAVOR = {
      potions: { portrait: 'flask', tag: 'Remedies & tonics — brewed this morning' },
      gear: { portrait: 'anvil', tag: 'Honest steel, honestly priced' },
      mystery: { portrait: 'orb', tag: 'Fate, bottled. No refunds.' },
    };
    const fl = FLAVOR[vendor.type] || FLAVOR.gear;
    $('shop-portrait').innerHTML = svgIcon(fl.portrait);
    $('shop-title').textContent = vendor.name;
    $('shop-tagline').textContent = fl.tag;
    $('shop-gold').innerHTML = `<span class="coin-stack"><span class="coin"></span><span class="coin c2"></span></span> <b>${p.gold}</b>`;
    const fee = this.game.restockFee(vendor);
    $('btn-shop-restock').textContent = `↻ Restock wares — ${fee}g`;
    $('btn-shop-restock').disabled = p.gold < fee;

    const subFor = (entry) => {
      if (entry.kind === 'potion') return 'Restores 45% health';
      if (entry.kind === 'elixir') return entry.elixir?.label || 'Temporary boon';
      if (entry.kind === 'bag') return '+3 inventory slots, forever';
      if (entry.kind === 'gamble') return 'Common… or legendary. Fate decides.';
      if (entry.item) return `${RARITIES[entry.item.rarity].name} ${entry.item.slot}`;
      return '';
    };
    const stockOf = (entry) => (entry.qty != null ? entry.qty : (entry.sold ? 0 : 1));

    const buyWrap = $('shop-buy-list');
    buyWrap.innerHTML = '';
    for (const entry of vendor.stock) {
      const el = document.createElement('div');
      const left = stockOf(entry);
      const soldOut = left <= 0;
      const afford = p.gold >= entry.price && !soldOut;
      el.className = `shop-item ${entry.item ? 'r-' + entry.item.rarity : ''} ${soldOut ? 'sold' : afford ? '' : 'disabled'}`;
      // show the remaining stock for stackable wares so it reads as one slot
      const qtyTag = (entry.qty != null && !soldOut) ? ` · ×${left}` : '';
      el.innerHTML = `
        <span class="shop-item-icon">${this.shopIconHtml(entry)}</span>
        <span class="shop-item-name">${entry.label}<small>${soldOut ? 'Sold out' : subFor(entry) + qtyTag}</small></span>
        <span class="shop-item-price">${entry.price}g</span>
      `;
      // click opens a detail + Buy confirm rather than purchasing instantly
      if (!soldOut) {
        el.onclick = () => this.showBuyConfirm(vendor, entry);
      }
      buyWrap.appendChild(el);
    }

    const sellWrap = $('shop-sell-list');
    sellWrap.innerHTML = '';
    if (!p.inventory.length) {
      sellWrap.innerHTML = '<div class="shop-empty">Your pack is empty —<br>the dungeon provides.</div>';
    }
    for (const item of [...p.inventory]) {
      const el = document.createElement('div');
      el.className = `shop-item r-${item.rarity}`;
      // real item glyph, not the raw emoji field (777)
      const ico = item.slot ? `<img class="shop-item-pic" src="${makeItemIcon(item)}" alt="">` : svgIcon('flask');
      el.innerHTML = `
        <span class="shop-item-icon">${ico}</span>
        <span class="shop-item-name">${item.name}<small>${RARITIES[item.rarity].name} ${item.slot}</small></span>
        <span class="shop-item-price sell">+${sellValue(item)}g</span>
      `;
      el.onclick = () => { this.game.sellItem(item); this.renderShop(vendor); };
      sellWrap.appendChild(el);
    }
  }

  // Builds a themed, in-panel custom dropdown over a native <select id=id>
  // (wrapped in .cselect in the HTML). The native select stays in the DOM,
  // visually hidden, so every existing s.value read and el.onchange handler
  // keeps working unchanged. Picking a custom option sets select.value and
  // dispatches a real 'change' event. Fixes native <select> popups rendering
  // off-screen on tablet/mobile inside the transformed settings panel, since
  // the replacement list is just themed DOM positioned within the page flow.
  // Returns a sync() function callers can invoke after setting select.value
  // programmatically (e.g. a fallback reset) to refresh the custom label.
  enhanceSelect(id) {
    const select = $(id);
    const wrap = select.closest('.cselect');
    const trigger = wrap.querySelector('.cselect-trigger');
    const label = wrap.querySelector('.cselect-label');
    const list = wrap.querySelector('.cselect-list');
    const options = Array.from(select.options);

    const render = () => {
      list.innerHTML = '';
      options.forEach((opt) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cselect-option' + (opt.value === select.value ? ' active' : '');
        btn.textContent = opt.textContent;
        btn.onclick = () => {
          select.value = opt.value;
          select.dispatchEvent(new Event('change'));
          sync();
          close();
        };
        list.appendChild(btn);
      });
    };
    const sync = () => {
      const sel = options.find((o) => o.value === select.value);
      label.textContent = sel ? sel.textContent : '';
      render();
    };
    const open = () => {
      document.querySelectorAll('.cselect.open').forEach((el) => { if (el !== wrap) el.classList.remove('open'); });
      wrap.classList.add('open');
      list.classList.remove('hidden');
    };
    const close = () => { wrap.classList.remove('open'); list.classList.add('hidden'); };
    trigger.onclick = () => (wrap.classList.contains('open') ? close() : open());
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    sync();
    return sync;
  }

  // ---------- settings ----------
  wireSettings() {
    const s = this.game.settings;
    // Every volume row's % label doubles as a mute toggle: click/tap it to
    // snap the slider to 0, remembering the prior value; click again to
    // restore it. apply() is whatever the slider's own oninput does, so the
    // label click goes through the exact same volume-apply path.
    const wireMuteLabel = (el, labelEl, key, apply) => {
      labelEl.classList.add('vol-mute-label');
      labelEl.tabIndex = 0;
      labelEl.setAttribute('role', 'button');
      labelEl.title = 'Click to mute / unmute';
      let prevPct = el.value;
      labelEl.addEventListener('click', () => {
        if (+el.value > 0) {
          prevPct = el.value;
          el.value = 0;
        } else {
          el.value = prevPct > 0 ? prevPct : 100;
        }
        s[key] = el.value / 100;
        labelEl.textContent = `${el.value}%`;
        apply();
        this.game.saveSettings();
      });
      labelEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); labelEl.click(); }
      });
    };
    const bind = (id, valId, key, channel) => {
      const el = $(id);
      el.value = Math.round(s[key] * 100);
      $(valId).textContent = `${el.value}%`;
      el.oninput = () => {
        s[key] = el.value / 100;
        $(valId).textContent = `${el.value}%`;
        audio.setVolume(channel, s[key]);
        this.game.saveSettings();
      };
      wireMuteLabel(el, $(valId), key, () => audio.setVolume(channel, s[key]));
    };
    bind('set-master', 'set-master-val', 'masterVolume', 'master');
    bind('set-music', 'set-music-val', 'musicVolume', 'music');
    bind('set-sfx', 'set-sfx-val', 'sfxVolume', 'sfx');

    // voice chat + character speech channels
    const bindPlain = (id, valId, key) => {
      const el = $(id);
      el.value = Math.round(s[key] * 100);
      $(valId).textContent = `${el.value}%`;
      el.oninput = () => {
        s[key] = el.value / 100;
        $(valId).textContent = `${el.value}%`;
        this.game.applyAudioSettings();
        this.game.saveSettings();
      };
      wireMuteLabel(el, $(valId), key, () => this.game.applyAudioSettings());
    };
    bindPlain('set-vchat', 'set-vchat-val', 'voiceChatVolume');
    bindPlain('set-speech', 'set-speech-val', 'speechVolume');

    // key bindings (desktop): click a row, then press a key to rebind
    this.renderKeybinds();

    // Auto-balance: dialogue-first mixing — speech at reference, voice chat
    // equal (0 dB), SFX −6 dB, music pulled well down so it never buries
    // dialogue (~0.15), master at 85%.
    $('btn-auto-level').onclick = () => {
      const db = (d) => Math.pow(10, d / 20);
      s.speechVolume = 1.0;
      s.voiceChatVolume = 1.0;
      s.sfxVolume = +(db(-6)).toFixed(2);    // ≈ 0.50
      s.musicVolume = 0.15;                  // background bed, well under speech/SFX
      s.masterVolume = 0.85;
      this.game.applyAudioSettings();
      this.game.saveSettings();
      this.syncSettingsInputs();
      $('set-vchat').value = 100; $('set-vchat-val').textContent = '100%';
      $('set-speech').value = 100; $('set-speech-val').textContent = '100%';
      audio.play('ui_click');
    };

    const q = $('set-quality');
    q.value = s.quality;
    q.onchange = () => { s.quality = q.value; this.game.applyQuality(); this.game.saveSettings(); };
    this._syncQualitySelect = this.enhanceSelect('set-quality');

    const shake = $('set-shake');
    shake.checked = s.screenShake;
    shake.onchange = () => { s.screenShake = shake.checked; this.game.saveSettings(); };

    // Desktop click-to-attack (Obsidian 769): on by default; disable here.
    const mouseAtk = $('set-mouse-attack');
    if (mouseAtk) {
      mouseAtk.checked = s.mouseAttack !== false;
      mouseAtk.onchange = () => { s.mouseAttack = mouseAtk.checked; this.game.saveSettings(); };
    }

    // "In-Game AI" and "In-Game Natural Voices" are two independent-looking
    // toggles that both drive the same underlying full-AI state (NOT battery
    // saver). Checked = the heavy features are on. Each toggle, the FIRST time
    // it is changed, shows a one-time explainer modal (with a "Do not show
    // again" persisted in localStorage); after that it toggles silently.
    const aiToggle = $('set-ingame-ai');
    const voiceToggle = $('set-natural-voice');
    const syncAiVoiceToggles = () => {
      const on = s.batterySaver !== true;
      aiToggle.checked = on;
      voiceToggle.checked = on;
    };
    syncAiVoiceToggles();
    aiToggle.onchange = () => this.onAiVoiceToggle('ai', aiToggle.checked, syncAiVoiceToggles);
    voiceToggle.onchange = () => this.onAiVoiceToggle('voice', voiceToggle.checked, syncAiVoiceToggles);
    this._syncAiVoiceToggles = syncAiVoiceToggles;

    const taunts = $('set-taunts');
    taunts.checked = s.taunts !== false;
    taunts.onchange = async () => {
      s.taunts = taunts.checked;
      this.game.saveSettings();
      const { roaster } = await import('../ai/roaster.js');
      roaster.enabled = s.taunts;
      if (!s.taunts && 'speechSynthesis' in window) speechSynthesis.cancel();
    };

    // 18+ mature-content gate (Obsidian 793/783): enabling it requires an age
    // agreement; it unlocks the explicit/vulgar dialogue banks (rude patrons,
    // Rosalind's NSFW lines). Off + un-agreed by default.
    const adult18 = $('set-adult18');
    adult18.checked = !!s.adult18;
    adult18.onchange = async () => {
      if (adult18.checked) {
        const res = await this.confirmModal({
          title: '18+ Mature Content',
          message: 'This unlocks explicit sexual and crude/vulgar language from tavern NPCs. By enabling it you confirm you are 18 years of age or older, and you must enter the access password.',
          confirmText: 'Unlock',
          cancelText: 'Cancel',
          password: true,
        });
        if (!res || !res.confirmed || res.password !== '3mb3rvi113m0d3') {
          adult18.checked = false;
          if (res && res.confirmed && res.password !== '3mb3rvi113m0d3') {
            this.confirmModal({ title: 'Incorrect password', message: '18+ mode was not enabled.', notice: true, confirmText: 'OK' });
          }
          return;
        }
      }
      s.adult18 = adult18.checked;
      this.game.saveSettings();
    };

    // neural character voices (Kokoro) — the only voice engine; no user toggle.
    $('btn-voice-retry').onclick = async () => {
      const { neuralVoice } = await import('../ai/neuralVoice.js');
      // On phones the model is skipped by default because instantiating it
      // OOM-crashes mobile Safari. Only try if the player explicitly opts in
      // after a clear warning; otherwise re-run the normal retry.
      if (neuralVoice.memoryConstrained) {
        const ok = await this.confirmModal({
          title: 'Download neural voices?',
          message: 'Neural voices are a large download (about 90 MB) and can crash the browser on phones and low-memory devices. Standard voices are used otherwise. Try anyway?',
          confirmText: 'Download', cancelText: 'Keep standard', danger: true,
        });
        if (!ok) return;
        neuralVoice.retry(true);
      } else {
        neuralVoice.retry();
      }
      this.startNeuralVoices();
    };
    // reflect current load state (downloading / ready / failed) whenever settings open
    this.reflectNeuralStatus();

    // voice chat
    const vSel = $('set-voice');
    const vRow = $('voice-thresh-row');
    const vThresh = $('set-voice-thresh');
    const vVal = $('set-voice-thresh-val');
    const syncVoiceRows = () => {
      const mode = s.voiceMode;
      // The trigger slider doubles as the live mic meter (fill inside the
      // slider track, knob = cutoff) - voice-activated only.
      vRow.classList.toggle('hidden', mode !== 'auto');
      // Push-to-talk has no trigger knob, but still shows a plain live meter so
      // the player can confirm the mic is picking them up.
      $('ptt-meter-row').classList.toggle('hidden', mode !== 'ptt');
      $('ptt-meter-hint').classList.toggle('hidden', mode !== 'ptt');
      // The hear-yourself mic test is useful in any mic mode (PTT or auto).
      $('mic-test-row').classList.toggle('hidden', mode === 'off');
      $('touch-mic').classList.toggle('hidden', mode !== 'ptt');
      this.setMicAvailable(mode === 'ptt');
    };
    vSel.value = s.voiceMode;
    vThresh.value = s.voiceThreshold;
    vVal.textContent = s.voiceThreshold;
    syncVoiceRows();
    const syncVSel = this.enhanceSelect('set-voice');
    vSel.onchange = async () => {
      s.voiceMode = vSel.value;
      this.game.saveSettings();
      syncVoiceRows();
      const { voice } = await import('../net/voice.js');
      const { net } = await import('../net/net.js');
      if (s.voiceMode === 'off') {
        voice.disable();
      } else {
        // Acquire the mic on this user gesture (mobile requires a gesture) and
        // report failure only when it genuinely can't be opened. Both auto and
        // ptt probe the same way now; the shared in-flight guard in enable()
        // stops the meter monitor and the session join racing each other.
        const ok = await this.armMicMonitor();
        if (!ok) {
          voice.disable();
          vSel.value = 'off'; s.voiceMode = 'off'; this.game.saveSettings(); syncVoiceRows(); syncVSel();
          await this.confirmModal({ title: 'No microphone', message: 'Microphone unavailable or permission denied.', notice: true });
        }
      }
      if (net.active && net.isHost) net.broadcastRoster();
    };
    vThresh.oninput = async () => {
      s.voiceThreshold = +vThresh.value;
      vVal.textContent = vThresh.value;
      this.game.saveSettings();
      const { voice } = await import('../net/voice.js');
      voice.threshold = s.voiceThreshold;
    };
    // Mic test: record 3s and play it back so the user can confirm their mic works.
    const micTestBtn = $('btn-mic-test');
    if (micTestBtn) micTestBtn.onclick = async () => {
      if (micTestBtn.disabled) return;
      micTestBtn.disabled = true;
      const { voice } = await import('../net/voice.js');
      try {
        await voice.testMic((stage) => {
          micTestBtn.textContent = stage === 'record' ? '● Recording… (speak)' : stage === 'play' ? '▶ Playing back…' : 'Test mic (hear yourself)';
        });
      } catch {
        await this.confirmModal({ title: 'No microphone', message: 'Microphone unavailable or permission denied.', notice: true });
        micTestBtn.textContent = 'Test mic (hear yourself)';
      }
      micTestBtn.disabled = false;
    };
    // Live mic level while settings are open, drawn INSIDE the trigger slider:
    // the fill is your voice, the knob is the cutoff it must cross.
    setInterval(async () => {
      if (!this.screens.settings.classList.contains('visible')) return;
      const { voice } = await import('../net/voice.js');
      const fill = $('voice-level-fill');
      const pttFill = $('ptt-level-fill');
      if (!fill && !pttFill) return;
      if (voice.active) {
        // map the level onto the slider's own min..max scale so the fill lines
        // up with where the knob sits for the same value (auto trigger slider)
        const min = +vThresh.min, max = +vThresh.max;
        const frac = Math.max(0, Math.min(1, (voice.level - min) / (max - min)));
        if (fill) {
          fill.style.width = `${frac * 100}%`;
          fill.classList.toggle('hot', voice.level >= voice.threshold);
        }
        // PTT meter is a plain 0..100 level bar (no cutoff knob to line up to)
        if (pttFill) pttFill.style.width = `${Math.max(0, Math.min(100, voice.level))}%`;
      } else {
        if (fill) fill.style.width = '0%';
        if (pttFill) pttFill.style.width = '0%';
      }
    }, 120);
  }

  // While settings are open, run the mic so the trigger meter is live even
  // outside a multiplayer session; release it again on close if not in a room.
  async armMicMonitor() {
    const s = this.game.settings;
    if (s.voiceMode === 'off') return false;
    const { voice } = await import('../net/voice.js');
    const ok = await voice.enable(s.voiceMode, s.voiceThreshold);
    voice.setMonitor(true); // keep mic live for the meter while settings open
    return ok;
  }

  async disarmMicMonitor() {
    const { voice } = await import('../net/voice.js');
    const { net } = await import('../net/net.js');
    voice.setMonitor(false);
    if (!net.active) voice.disable();
  }

  setMicIndicator(on) {
    $('voice-indicator').classList.toggle('hidden', !on);
    $('touch-mic')?.classList.toggle('live', on);
  }

  // ---------- key bindings ----------
  keyLabel(code) {
    if (!code) return '—';
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code === 'Space') return 'Space';
    return code;
  }

  renderKeybinds() {
    const wrap = $('keybinds');
    if (!wrap) return;
    const binds = this.game.settings.keybinds;
    const labels = { interact: 'Interact', potion: 'Drink Potion', talk: 'Push-to-Talk', inventory: 'Inventory', quests: 'Quest Log', mastery: 'Mastery' };
    wrap.innerHTML = '';
    for (const [action, label] of Object.entries(labels)) {
      const row = document.createElement('div');
      row.className = 'keybind-row';
      row.innerHTML = `<span>${label}</span><button class="keybind-btn">${this.keyLabel(binds[action])}</button>`;
      const btn = row.querySelector('.keybind-btn');
      btn.onclick = () => {
        btn.textContent = 'Press a key…';
        btn.classList.add('listening');
        const onKey = (e) => {
          e.preventDefault(); e.stopPropagation();
          window.removeEventListener('keydown', onKey, true);
          if (e.code !== 'Escape') { binds[action] = e.code; this.game.saveSettings(); }
          btn.classList.remove('listening');
          this.renderKeybinds();
        };
        window.addEventListener('keydown', onKey, true);
      };
      wrap.appendChild(row);
    }
  }

  // ---------- multiplayer text chat ----------
  initChat() {
    this.chatLog = [];
    this._chatIdleT = null;
    const input = $('chat-input');
    // Click anywhere on the chat frame to open the input row below it (WoW-style).
    // No 💬 button — the scrollback frame itself is the affordance.
    $('chat').addEventListener('click', (e) => {
      if (e.target.closest('#chat-input-row')) return; // don't reopen while typing
      this.openChatInput();
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        // send but KEEP the box open + focused so you can fire off several
        // messages without re-clicking. Escape (or clicking away) closes it.
        this.sendChat(input.value); input.value=''; this._wakeChat(); input.focus();
      } else if (e.key === 'Escape') {
        input.value=''; $('chat-input-row').classList.add('hidden'); input.blur();
      }
    });
    input.addEventListener('focus', () => this._wakeChat());
    // click/tap away from the box → collapse the input row back down
    input.addEventListener('blur', () => { $('chat-input-row').classList.add('hidden'); });
  }

  showChatBar(visible) {
    $('chat').classList.toggle('hidden', !visible);
    if (visible) this._wakeChat();
  }

  // keep the chat frame at full opacity briefly, then let it dim (but stay visible)
  _wakeChat() {
    const c = $('chat');
    c.classList.remove('idle');
    clearTimeout(this._chatIdleT);
    this._chatIdleT = setTimeout(() => c.classList.add('idle'), 9000);
  }

  openChatInput() {
    if ($('chat').classList.contains('hidden')) return;
    $('chat-input-row').classList.remove('hidden');
    this._wakeChat();
    setTimeout(() => $('chat-input').focus(), 20);
  }

  sendChat(text) {
    text = (text || '').trim().slice(0, 140);
    if (!text) return;
    this.game.broadcastChat(text);
  }

  addChatMessage(name, text, ts, mine) {
    const stamp = ts || Date.now();
    this.chatLog.push({ name, text, ts: stamp, mine });
    if (this.chatLog.length > 200) this.chatLog.shift();
    // persistent scrollback: timestamp + colored name, auto-scroll to newest
    const list = $('chat-recent');
    const d = new Date(stamp);
    const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
    const el = document.createElement('div');
    el.className = 'chat-msg' + (mine ? ' mine' : '');
    el.innerHTML = `<span class="ts">${hh}:${mm}</span><b>${this.esc(name)}</b>${this.esc(text)}`;
    list.appendChild(el);
    while (list.children.length > 60) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
    this._wakeChat();
  }

  renderChatLog() {
    const list = $('chat-log-list');
    list.innerHTML = this.chatLog.map((m) => {
      const d = new Date(m.ts);
      const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
      return `<div class="chat-log-msg"><span class="ts">${hh}:${mm}</span><b>${this.esc(m.name)}</b>${this.esc(m.text)}</div>`;
    }).join('');
    list.scrollTop = list.scrollHeight;
  }

  esc(s) { return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

  // Themed subtitle bar for character speech (vendors, NPCs, enemies). The
  // caption holds on screen until speech is done, then fades out slowly (via a
  // CSS opacity/visibility transition, never an abrupt display:none snap).
  //
  // holdUntilDismissed: when true the auto-hide timer is skipped and the
  // caption stays until dismissSubtitle() is called by whoever knows when the
  // real speech ended (e.g. a neuralVoice src.onended / speechSynthesis onend).
  // Otherwise durationMs is a best-effort fallback estimate.
  showSubtitle(speaker, text, durationMs = 4200, holdUntilDismissed = false) {
    const el = $('subtitle');
    $('subtitle-speaker').textContent = speaker;
    $('subtitle-text').textContent = text;
    el.classList.remove('hidden', 'fading');
    // the interact prompt sits in the same spot — hide it so they don't overlap
    $('interact-prompt').classList.add('hidden');
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    clearTimeout(this._subT);
    clearTimeout(this._subFadeT);
    if (!holdUntilDismissed) this._subT = setTimeout(() => this.dismissSubtitle(), durationMs);
  }

  // Fade the caption out (slow opacity/visibility transition), then park it
  // fully hidden once the transition has run. Safe to call more than once.
  dismissSubtitle() {
    const el = $('subtitle');
    if (el.classList.contains('hidden')) return;
    clearTimeout(this._subT);
    el.classList.add('fading'); // CSS drives opacity/visibility to 0 over 0.6s
    clearTimeout(this._subFadeT);
    this._subFadeT = setTimeout(() => { el.classList.add('hidden'); el.classList.remove('fading'); }, 650);
  }

  // Kick off (or re-show) the neural voice download with live progress + retry.
  async startNeuralVoices() {
    const vStatus = $('voice-engine-status');
    const bar = $('voice-engine-bar'), fill = $('voice-engine-fill');
    const retry = $('btn-voice-retry');
    vStatus.classList.remove('hidden');
    retry.classList.add('hidden');
    const { neuralVoice } = await import('../ai/neuralVoice.js');
    neuralVoice.onStatus = (st, prog, err) => {
      if (st === 'loading') {
        vStatus.textContent = prog > 0
          ? `Downloading voice model… ${Math.round(prog * 100)}%`
          : 'Preparing neural voices…';
        bar.classList.remove('hidden');
        fill.style.width = `${Math.round(prog * 100)}%`;
        retry.classList.add('hidden');
      } else if (st === 'ready') {
        // No "ready ✓" box - success needs no footnote; just clear the progress.
        vStatus.classList.add('hidden');
        fill.style.width = '100%';
        setTimeout(() => bar.classList.add('hidden'), 1200);
        retry.classList.add('hidden');
      } else if (st === 'error') {
        vStatus.textContent = neuralVoice.skipped
          ? 'Neural voices are off on this device (large download can crash mobile browsers). Using standard voices.'
          : `Couldn't load neural voices (${err || 'unknown'}). Using standard voices for now.`;
        bar.classList.add('hidden');
        retry.textContent = neuralVoice.memoryConstrained ? 'Enable neural voices' : 'Retry';
        retry.classList.remove('hidden');
      }
    };
    neuralVoice.load();
  }

  reflectNeuralStatus() {
    // Battery saver bypasses the neural engine entirely: hide the load state
    // and the "retry neural voices" button rather than nagging with a hint;
    // the toggles above already say what mode you are in.
    if (this.game.settings.batterySaver === true) {
      $('voice-engine-status').classList.add('hidden');
      $('voice-engine-bar').classList.add('hidden');
      $('btn-voice-retry').classList.add('hidden');
      return;
    }
    import('../ai/neuralVoice.js').then(({ neuralVoice }) => {
      if (neuralVoice.status === 'ready') {
        // Ready needs no status box - keep the settings panel uncluttered.
        $('voice-engine-status').classList.add('hidden');
      } else if (neuralVoice.status === 'loading') {
        this.startNeuralVoices();
      } else if (neuralVoice.status === 'error') {
        this.startNeuralVoices();
      }
    });
  }

  setMicAvailable(on) {
    // With the mic bubble hidden (single player / mic off), the utility arc
    // would show a hole at its slot - body.mic-hidden re-spaces the remaining
    // bubbles over the gap (style.css).
    document.body.classList.toggle('mic-hidden', !on);
  }

  showInteract(candidate) {
    const el = $('interact-prompt');
    if (!candidate) { el.classList.add('hidden'); return; }
    // while an NPC line (subtitle) is up, don't stack the prompt behind it
    if (!$('subtitle').classList.contains('hidden')) { el.classList.add('hidden'); return; }
    // Show a device-appropriate action hint: the F key on desktop, "Tap" on
    // touch devices (the whole pill is tappable there).
    const hint = isTouchDevice() ? 'Tap' : 'F';
    el.innerHTML = `${candidate.icon} ${candidate.label} <span class="key-chip">${hint}</span>`;
    el.classList.remove('hidden');
  }

  wireActionBar() {
    const g = this.game;
    // Desktop shares the touch utility bubbles (#touch-inv/mic/pause + potion)
    // - the old flat-stroke #action-bar row is gone. Only the generic pieces
    // remain here.
    $('interact-prompt').onclick = () => g.doInteract();
    // universal corner ✕ on every panel overlay (works without a keyboard)
    document.querySelectorAll('.overlay-close').forEach((btn) => {
      btn.onclick = () => { g.state = 'playing'; this.hideAll(); };
    });
  }

  syncSettingsInputs() {
    const s = this.game.settings;
    $('set-master').value = Math.round(s.masterVolume * 100);
    $('set-master-val').textContent = `${Math.round(s.masterVolume * 100)}%`;
    $('set-music').value = Math.round(s.musicVolume * 100);
    $('set-music-val').textContent = `${Math.round(s.musicVolume * 100)}%`;
    $('set-sfx').value = Math.round(s.sfxVolume * 100);
    $('set-sfx-val').textContent = `${Math.round(s.sfxVolume * 100)}%`;
    $('set-quality').value = s.quality;
    this._syncQualitySelect?.();
    $('set-shake').checked = s.screenShake;
    this._syncAiVoiceToggles?.();
  }

  // ---------- hotbar ----------
  // Slots render through player.abilityOrder (slot -> ability index) so a
  // re-slotted ability shows its own icon/cooldown in its new spot.
  buildHotbar(player) {
    const bar = $('hotbar');
    bar.innerHTML = '';
    this.hotbarSlots = [];
    this.cluster = null;
    this.vitals = null;
    this.potionBtn = null;
    const order = player.abilityOrder || [0, 1, 2, 3];
    // Every layout renders the SAME Wild Rift-style corner cluster: one big
    // BASIC-ATTACK button at the bottom-right thumb pivot, the four ability
    // buttons fanned in an arc up-and-to-the-left of it, the vitals arcs
    // hugging its outside (_buildTouchVitals), and the potion bubble tucked
    // into the arc. body.touch-mode is still set from the same
    // isCompactLayout() check (core/touch.js) so touch-only bits elsewhere
    // (joystick, gesture tutorial) keep working, but it no longer chooses
    // between a row and a cluster - the cluster is unconditional.
    document.body.classList.toggle('touch-mode', isCompactLayout());
    this.buildActionCluster(player, order);
  }

  // Build one circular action button (a div with a gold cooldown ring drawn by
  // an SVG stroke, an icon, and a hidden cooldown-seconds number). Shared by the
  // basic-attack button (slot -1) and the four ability buttons (slot 0-3).
  _makeActionButton(slot, label, icon, cls) {
    // ring circumference for r=45 in the 100x100 viewBox (2*PI*45 ≈ 282.74)
    const C = 282.74;
    const btn = document.createElement('div');
    btn.className = `act-btn ${cls} ready`;
    btn.innerHTML = `
      <svg class="act-ring" viewBox="0 0 100 100" aria-hidden="true">
        <circle class="act-ring-bg" cx="50" cy="50" r="45"></circle>
        <circle class="act-ring-fg" cx="50" cy="50" r="45"
          stroke-dasharray="${C}" stroke-dashoffset="0"></circle>
      </svg>
      <span class="act-icon">${icon}</span>
      <span class="act-cd"></span>
      ${label ? `<span class="act-key">${label}</span>` : ''}
    `;
    return {
      slot, el: btn,
      ring: btn.querySelector('.act-ring-fg'),
      iconEl: btn.querySelector('.act-icon'),
      cdEl: btn.querySelector('.act-cd'),
      C,
    };
  }

  // Wild Rift-style cluster of CIRCULAR buttons in the bottom-right corner,
  // shared by every layout (touch and desktop alike): one large BASIC-ATTACK
  // button at the pivot, and the four ability buttons fanned in an arc
  // up-and-left of it (their screen positions come from CSS). Each button
  // supports TAP/click (auto-aim nearest) and HOLD+SWIPE/drag (directional
  // cast); see wireActionButton - it handles mouse and touch identically.
  buildActionCluster(player, order) {
    const bar = $('hotbar');
    this.cluster = [];
    // vitals arcs first so the buttons paint above them
    this._buildTouchVitals(bar);
    // big basic-attack at the corner pivot (slot -1); crossed-swords glyph.
    // The title only matters on desktop (mouse hover); touch never shows it.
    const basic = this._makeActionButton(-1, '', svgIcon('swords'), 'act-basic');
    basic.el.title = 'Basic Attack';
    bar.appendChild(basic.el);
    this.wireActionButton(basic, player);
    this.cluster.push(basic);
    // four abilities fanned in the arc, slot 0..3 - numbered gold chips double
    // as both the touch label and the desktop keybind hint (Digit1-4, see
    // game.js), and the tooltip carries the full name/cost/desc for mouse hover.
    order.forEach((abIndex, i) => {
      const ab = player.classDef.abilities[abIndex];
      const b = this._makeActionButton(i, i + 1, svgIcon(ab.icon), `act-ability act-slot-${i}`);
      b.iconKey = ab.icon;
      b.el.title = `${ab.name} (${ab.cost} ${player.classDef.resource.name}): ${ab.desc} [${i + 1}]`;
      bar.appendChild(b.el);
      this.wireActionButton(b, player);
      this.cluster.push(b);
    });
    // potion: one more bubble in the arc, right next to the last ability
    this._buildPotionBubble(bar);
  }

  // Health / resource / XP as curved arc bars hugging the OUTSIDE of the
  // action cluster (both touch and desktop layouts now - the desktop
  // top-left bars retire in favor of these, see body.touch-mode removal on
  // #hud-topleft .bar-wrap in style.css). One SVG in a fixed 210x210
  // viewBox, CSS-scaled to the #hotbar box in both
  // orientations, centered on the basic-attack pivot. Living inside #hotbar
  // means every rule that fades or hides the cluster covers the vitals too.
  // updateActionCluster drives the dash offsets each frame.
  _buildTouchVitals(bar) {
    const NS = 'http://www.w3.org/2000/svg';
    const CX = 156, CY = 156; // the basic-attack button's pivot in the 210 box
    const pt = (r, deg) => {
      const a = (deg * Math.PI) / 180;
      return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
    };
    // sweep: from straight-up (right at slot 0's chip, closing the old dead
    // gap between the arc's tip and the first ability button) counterclockwise
    // down past slot 3 (further than before, so the lower-left tail reaches
    // further down the screen too) - see TODO 691.
    // TODO 700: bands run ALONGSIDE the ability arc, fully OUTSIDE it - from
    // the top-right edge of slot 0 (-90deg button center + ~12deg half-width)
    // to the bottom edge of slot 3 (-190deg - ~8deg). Radii below keep every
    // band's inner edge clear of the buttons' outer extent (~150px: 115.6
    // center radius + 29 button + ring + number chip) with a real gap - the
    // failed first pass tucked the bands UNDER buttons 2 and 4.
    const A0 = -78, A1 = -198;
    const arcPath = (r) => {
      const [x0, y0] = pt(r, A0), [x1, y1] = pt(r, A1);
      return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 0 0 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
    };
    const svg = document.createElementNS(NS, 'svg');
    svg.id = 'touch-vitals';
    svg.setAttribute('viewBox', '0 0 210 210');
    svg.setAttribute('aria-hidden', 'true');
    const mk = (cls, d, w) => {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('class', cls);
      p.setAttribute('d', d);
      p.setAttribute('stroke-width', w);
      svg.appendChild(p);
      return p;
    };
    const build = (cls, r, w) => {
      const d = arcPath(r);
      mk('tv-track', d, w + 2);
      return mk(cls, d, w);
    };
    const xp = build('tv-xp', 155, 2.5);     // thin gold XP arc, innermost (inner edge 153.75 > button extent 150)
    const res = build('tv-res', 161, 5);     // deep blue-purple resource
    const hp = build('tv-hp', 169, 8);       // blood-red health, outermost
    // Current/max readouts CURVE ALONG their own bands via textPath: the
    // health numbers ride the health arc, the resource numbers ride the
    // resource arc. Each invisible text arc runs the reverse direction
    // (A1 -> A0, sweep 1 = clockwise across the top-left) so the glyphs sit
    // upright instead of upside down, centered mid-arc via startOffset 50%.
    // Baseline radii sit a touch inside each band so the small glyphs fill
    // the band instead of spilling onto the ability circles inside it.
    const defs = document.createElementNS(NS, 'defs');
    svg.appendChild(defs);
    const textArc = (id, r) => {
      const [x0, y0] = pt(r, A1), [x1, y1] = pt(r, A0);
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('id', id);
      p.setAttribute('d', `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`);
      p.setAttribute('fill', 'none');
      defs.appendChild(p);
    };
    textArc('tv-txt-hp-arc', 167);
    textArc('tv-txt-res-arc', 156.5);
    const mkArcText = (cls, id) => {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('class', cls);
      t.setAttribute('text-anchor', 'middle');
      const tp = document.createElementNS(NS, 'textPath');
      tp.setAttribute('href', `#${id}`);
      tp.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', `#${id}`); // older Safari
      // 76%: sits the numbers along the arc's lower-left TAIL, past the last
      // ability bubble - at 50% (mid-arc) they crossed the upper bubbles' rings.
      tp.setAttribute('startOffset', '76%');
      t.appendChild(tp);
      svg.appendChild(t);
      return tp;
    };
    const text = mkArcText('tv-hp-text', 'tv-txt-hp-arc');
    const resText = mkArcText('tv-res-text', 'tv-txt-res-arc');
    bar.appendChild(svg);
    this.vitals = {
      hp, res, xp, text, resText,
      hpLen: hp.getTotalLength(), resLen: res.getTotalLength(), xpLen: xp.getTotalLength(),
    };
    for (const [p, l] of [[hp, this.vitals.hpLen], [res, this.vitals.resLen], [xp, this.vitals.xpLen]]) {
      p.setAttribute('stroke-dasharray', l.toFixed(1));
      p.setAttribute('stroke-dashoffset', '0');
    }
  }

  // The potion bubble: same circular style as the ability buttons (gold ring,
  // red flask icon, potions-remaining badge). Tap drinks; updateHud grays it
  // out (.disabled) when the pack is empty or health is already full.
  _buildPotionBubble(bar) {
    const C = 282.74;
    const btn = document.createElement('div');
    btn.className = 'act-btn act-potion ready';
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', 'Drink potion');
    // Desktop has a keyboard, so the potion gets the same top-right hotkey
    // chip as the four ability bubbles (uses the live keybind, not a
    // hardcoded "R"). The touch cluster has no keyboard, so it's skipped
    // there - buildHotbar/buildActionCluster set body.touch-mode before this
    // runs, so that class is the reliable "are we on the desktop row" check.
    const keyChip = document.body.classList.contains('touch-mode')
      ? '' : `<span class="act-key">${this.keyLabel(this.game.settings.keybinds.potion)}</span>`;
    btn.innerHTML = `
      <svg class="act-ring" viewBox="0 0 100 100" aria-hidden="true">
        <circle class="act-ring-bg" cx="50" cy="50" r="45"></circle>
        <circle class="act-ring-fg" cx="50" cy="50" r="45"
          stroke-dasharray="${C}" stroke-dashoffset="0"></circle>
      </svg>
      <svg class="potion-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="10" y="2" width="4" height="4" rx="1" fill="#8a6a3a"/>
        <path d="M9 6h6v3.2l3.6 7.4c1.1 2.3-.5 5-3 5H8.4c-2.5 0-4.1-2.7-3-5L9 9.2V6z" fill="#c8342f" stroke="#7a1f1c" stroke-width="1"/>
        <path d="M8.6 13.5c1 .6 2.2.9 3.4.9s2.4-.3 3.4-.9" stroke="#7a1f1c" stroke-width="1" fill="none" stroke-linecap="round"/>
        <ellipse cx="10.3" cy="14.3" rx="1.1" ry="1.7" fill="#ff8f7a" opacity="0.75"/>
      </svg>
      <span class="act-count"></span>
      ${keyChip}
    `;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      this.game.touch?.wake?.();
      if (this.game.state !== 'playing') return;
      if (btn.classList.contains('disabled')) return;
      this.game.player?.drinkPotion(this.game);
    });
    bar.appendChild(btn);
    this.potionBtn = { el: btn, countEl: btn.querySelector('.act-count') };
  }

  // Per-button gesture handling shared by every cluster button (and it works
  // for mouse too, so desktop gets the same tap/click + drag-to-aim). A quick
  // press-release with little movement is a TAP (auto-aim nearest enemy); a
  // press then drag past SWIPE_PX is a SWIPE (cast in the drag direction, with
  // a live ground aim arrow). Both route through game.clusterTap / clusterSwipe,
  // which feed the existing tryAbility / tryBasicAttack path.
  wireActionButton(b, player) {
    const SWIPE_PX = 18; // > this = aim/swipe mode; <= this = tap
    b.el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (this.game.state !== 'playing') return;
      b.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, swiping: false };
      b.el.setPointerCapture?.(e.pointerId);
      this.game.touch?.wake?.();
    });
    b.el.addEventListener('pointermove', (e) => {
      const d = b.drag;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
      if (!d.swiping && Math.hypot(dx, dy) > SWIPE_PX) d.swiping = true;
      if (d.swiping) {
        const dir = this.game.dragToWorldDir(dx, dy);
        this.game.setAimIndicator(dir);
        b.el.classList.add('aiming');
      }
    });
    const finish = (e) => {
      const d = b.drag;
      if (!d || d.id !== e.pointerId) return;
      b.drag = null;
      b.el.classList.remove('aiming');
      this.game.setAimIndicator(null);
      this.game.touch?._advanceTut?.('ability');
      if (this.game.state !== 'playing') return;
      const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
      if (d.swiping) {
        const dir = this.game.dragToWorldDir(dx, dy);
        if (dir) this.game.clusterSwipe(b.slot, dir.x, dir.z);
        else this.game.clusterTap(b.slot); // drag collapsed back onto the button
      } else {
        this.game.clusterTap(b.slot);
      }
    };
    b.el.addEventListener('pointerup', finish);
    b.el.addEventListener('pointercancel', (e) => {
      if (b.drag?.id === e.pointerId) { b.drag = null; b.el.classList.remove('aiming'); this.game.setAimIndicator(null); }
    });
  }

  updateActionCluster(player) {
    // vitals arcs hugging the cluster: the visible dash shrinks from the far
    // end as the value drains (offset = length * missing fraction)
    if (this.vitals) {
      const v = this.vitals;
      const set = (p, len, frac) => {
        const f = Math.max(0, Math.min(1, frac));
        p.style.strokeDashoffset = (len * (1 - f)).toFixed(1);
      };
      set(v.hp, v.hpLen, player.hp / player.maxHp);
      set(v.res, v.resLen, player.resource / player.maxResource);
      const { xpForLevel } = this.game.playerModule;
      set(v.xp, v.xpLen, player.xp / xpForLevel(player.level));
      const txt = `${Math.max(0, Math.ceil(player.hp))}/${Math.round(player.maxHp)}`;
      if (v.text.textContent !== txt) v.text.textContent = txt;
      const rtxt = `${Math.max(0, Math.floor(player.resource))}/${Math.round(player.maxResource)}`;
      if (v.resText.textContent !== rtxt) v.resText.textContent = rtxt;
    }
    const order = player.abilityOrder || [0, 1, 2, 3];
    for (const b of this.cluster) {
      if (b.slot < 0) {
        // basic attack: cooldown is player.attackCd (max = basic.cooldown),
        // and it can be starved of resource just like abilities.
        const basic = player.classDef.basic;
        const cd = player.attackCd;
        const max = basic.cooldown || 0.45;
        const onCd = cd > 0.02;
        const frac = onCd ? Math.max(0, Math.min(1, cd / max)) : 0;
        b.ring.style.strokeDashoffset = (b.C * frac).toFixed(1);
        const canAfford = player.resource >= (basic.basicCost || 0);
        b.el.classList.toggle('cooling', onCd);
        b.el.classList.toggle('ready', !onCd && canAfford);
        b.el.classList.toggle('no-resource', !onCd && !canAfford);
        b.cdEl.textContent = onCd && cd >= 0.1 ? Math.ceil(cd).toString() : '';
        continue;
      }
      const abIndex = order[b.slot];
      const ab = player.classDef.abilities[abIndex];
      if (!ab) continue;
      const cd = player.abilityCds[abIndex];
      const max = player.abilityCdMax?.[abIndex] || ab.cd;
      const onCd = cd > 0;
      // gold ring depletes as the cooldown recovers: full ring = ready,
      // stroke-dashoffset grows with the remaining fraction.
      const frac = onCd ? Math.max(0, Math.min(1, cd / max)) : 0;
      b.ring.style.strokeDashoffset = (b.C * frac).toFixed(1);
      const cost = Math.round(ab.cost * (player.maxResource / player.classDef.resource.max));
      const canAfford = player.resource >= cost;
      b.el.classList.toggle('cooling', onCd);
      b.el.classList.toggle('ready', !onCd && canAfford);
      b.el.classList.toggle('no-resource', !onCd && !canAfford);
      b.cdEl.textContent = onCd ? Math.ceil(cd).toString() : '';
      if (b.iconKey !== ab.icon) { b.iconKey = ab.icon; b.iconEl.innerHTML = svgIcon(ab.icon); }
    }
  }

  flashNoResource(slot) {
    // both layouts store buttons with their slot number (the touch cluster
    // also carries the basic attack at slot -1), so look the slot up directly
    const el = this.cluster?.find((b) => b.slot === slot)?.el;
    if (!el) return;
    el.classList.add('no-resource');
    setTimeout(() => el.classList.remove('no-resource'), 300);
  }

  // Low-health warning: pulsing red-gold glow on the potion bubble + health
  // bar/arc, plus a soft looping heartbeat, while HP stays under ~30%. A
  // small hysteresis gap (enter under 30%, only clear above 35%) keeps it
  // from flickering when HP hovers right at the line. Idempotent -- only
  // touches the DOM/audio when the on/off state actually changes.
  setLowHealthFx(active) {
    if (this._lowHealthOn === active) return;
    this._lowHealthOn = active;
    document.body.classList.toggle('low-hp', active);
    if (active) audio.startHeartbeat();
    else audio.stopHeartbeat();
  }

  // ---------- HUD update ----------
  updateHud(player, floor, boss) {
    // Low-health warning threshold check (see setLowHealthFx above). Dead
    // players never get the warning, whatever the last HP reading was.
    const hpFrac = player.maxHp > 0 ? player.hp / player.maxHp : 0;
    const wasLow = !!this._lowHealthOn;
    const lowHp = !player.dead && (wasLow ? hpFrac < 0.35 : hpFrac < 0.3);
    this.setLowHealthFx(lowHp);

    // Bars carry their NAME, not numbers - the fill level tells the story.
    $('hp-bar').style.width = `${(player.hp / player.maxHp) * 100}%`;
    $('hp-text').textContent = 'Health';
    $('resource-bar').style.width = `${(player.resource / player.maxResource) * 100}%`;
    $('resource-text').textContent = player.classDef.resource.name;
    const { xpForLevel } = this.game.playerModule;
    const need = xpForLevel(player.level);
    $('xp-bar').style.width = `${(player.xp / need) * 100}%`;
    $('xp-text').textContent = 'XP';
    const pts = player.skillPoints();
    $('hud-level').textContent = pts > 0 ? `Lv ${player.level} ✦${pts}` : `Lv ${player.level}`;
    $('hud-gold').innerHTML = `${player.gold} <span class="coin-stack"><span class="coin"></span><span class="coin c2"></span></span>`;
    const potHud = `${player.potions} ${svgIcon('flask')}`;
    if (this._hudPotionsHtml !== potHud) { this._hudPotionsHtml = potHud; $('hud-potions').innerHTML = potHud; }
    // potion buttons stay visible always; grayed out (and inert) when there's
    // no potion to drink or drinking one would do nothing, so the slot never
    // vanishes -- the player always knows where it is, just not usable yet.
    const canDrink = player.hp < player.maxHp - 1 && player.potions > 0;
    if (this.potionBtn) {
      this.potionBtn.el.classList.toggle('disabled', !canDrink);
      const pc = String(player.potions);
      if (this.potionBtn.countEl.textContent !== pc) this.potionBtn.countEl.textContent = pc;
    }
    // multiplayer: show how many heroes share the room (works in both orientations)
    const playersEl = $('hud-players');
    const count = this.game.roomPlayerCount();
    if (count > 0) {
      playersEl.classList.remove('hidden');
      const room = this.game.roomName();
      playersEl.textContent = room ? `${room} · ${count}` : `Online (${count})`;
      playersEl.title = room ? `Room ${room} — ${count} heroes` : `${count} heroes in this room`;
    } else {
      playersEl.classList.add('hidden');
    }
    // floorLabelText() returns a single string that's sometimes "<emoji> Title"
    // (town/tavern/depths) and sometimes just "Title" (in-Act dungeon floors).
    // Split the leading glyph into its own element so CSS can vertically
    // center it against the title text as one tidy row (TODO 697) instead of
    // relying on inline emoji baseline alignment inside the text node.
    const floorText = this.game.floorLabelText();
    const floorM = floorText.match(/^(\S+)\s+(.*)$/);
    const floorIconEl = $('hud-floor-icon');
    if (floorM && !/[A-Za-z0-9]/.test(floorM[1])) {
      floorIconEl.textContent = floorM[1];
      floorIconEl.classList.remove('hidden');
      $('hud-floor').textContent = floorM[2];
    } else {
      floorIconEl.classList.add('hidden');
      $('hud-floor').textContent = floorText;
    }

    // stairs seal progress
    const clearEl = $('hud-clear');
    if (this.game.inTown || !this.game.dungeon?.stairs) {
      clearEl.textContent = '';
    } else if (this.game.stairsLocked()) {
      // Show how many are LEFT to clear before the stairs down open, so the
      // objective reads as a countdown to the next floor rather than a tally.
      const left = Math.max(0, this.game.stairsClearNeed() - this.game.floorKills);
      const eliteLeft = this.game.enemies.some((e) => !e.dead && e.elite);
      const parts = [];
      if (left > 0) parts.push(`${left} to slay`);
      if (eliteLeft) parts.push('elite alive');
      clearEl.innerHTML = `${svgIcon('lock')} ${parts.length ? `${parts.join(' · ')} to open the stairs` : 'clear the floor'}`;
      clearEl.className = 'sealed';
    } else {
      clearEl.innerHTML = `${svgIcon('unlock')} Stairs open, descend when ready`;
      clearEl.className = 'open';
    }
    $('hud-quest').textContent = this.game.currentObjectiveText();
    // Touch ability wheel is a dungeon tool: fade it in town (no combat there)
    // and while an interact/descend prompt is up so it never sits under it.
    document.body.classList.toggle('in-town', !!this.game.inTown);
    document.body.classList.toggle('show-interact', !$('interact-prompt').classList.contains('hidden'));

    // anti-cheat lockout countdown banner
    const cl = $('cheat-lock');
    const lockLeft = (this.game.cheatLockUntil || 0) - performance.now();
    if (lockLeft > 0) {
      const s = Math.ceil(lockLeft / 1000);
      cl.classList.remove('hidden');
      cl.innerHTML = `${svgIcon('ban')} CHEATING DETECTED<div class="cl-sub">Frozen — ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}</div>`;
    } else if (!cl.classList.contains('hidden')) {
      cl.classList.add('hidden');
    }

    // Both layouts (touch corner cluster AND the desktop bottom-center row)
    // are built from the same circular buttons and stored in this.cluster, so
    // one updater drives cooldown rings, seconds and resource gating for both.
    if (this.cluster) this.updateActionCluster(player);

    const bossWrap = $('boss-bar-wrap');
    if (boss && !boss.dead) {
      $('boss-name').textContent = boss.name;
      $('boss-bar').style.width = `${(boss.hp / boss.maxHp) * 100}%`;
      // World-anchor the bar just above the boss's head instead of pinning it to
      // the top of the screen: project the top of the boss (ground pos.y + a
      // head-height offset scaled by its footprint) to screen every frame and
      // follow it. Reuses the floaters world->screen projection so it stays in
      // sync with the combat text. Clamp to the viewport edges and hide it when
      // the boss goes behind the camera or off-screen.
      const headY = (boss.pos.y || 0) + 3.6 + (boss.radius || 1) * 1.6;
      const s = this.floaters.worldToScreen(boss.pos.x, headY, boss.pos.z);
      if (!s.onScreen) {
        bossWrap.classList.add('hidden');
      } else {
        bossWrap.classList.remove('hidden');
        const w = bossWrap.offsetWidth || 320;
        const h = bossWrap.offsetHeight || 40;
        const half = w / 2;
        const pad = 8;
        // clamp horizontal centre so the width-constrained bar never runs off
        // either edge; clamp vertical so it never rides above the top HUD.
        const cx = Math.max(half + pad, Math.min(window.innerWidth - half - pad, s.x));
        const cy = Math.max(pad + h, Math.min(window.innerHeight - pad, s.y));
        bossWrap.style.left = `${cx}px`;
        bossWrap.style.top = `${cy}px`;
      }
    } else {
      bossWrap.classList.add('hidden');
    }
  }

  // Clicking a shop ware opens this detail + Buy confirm (no instant purchase).
  showBuyConfirm(vendor, entry) {
    const p = this.game.player;
    this._pendingBuy = { vendor, entry };
    const item = entry.item;
    const rarity = item ? item.rarity : (entry.kind === 'elixir' ? entry.elixir.rarity : 'common');
    const R = RARITIES[rarity] || RARITIES.common;
    $('buy-icon').innerHTML = this.shopIconHtml(entry); // real glyph, not an emoji (777)
    const name = $('buy-name'); name.textContent = entry.label; name.className = `tt-${rarity}`;
    $('buy-rarity').textContent = item ? `${R.name} ${item.slot}` : (entry.kind === 'elixir' ? `${R.name} elixir` : '');
    let detail = '';
    if (item) detail = Object.entries(item.stats || {}).map(([k, v]) => `<span class="tt-stat">${statLabel(k, v)}</span>`).join(' · ');
    else if (entry.kind === 'elixir') detail = `<span class="tt-stat">${entry.elixir.label}</span>`;
    else if (entry.kind === 'potion') detail = 'Restores 45% health';
    else if (entry.kind === 'bag') detail = '+3 inventory slots, forever';
    else if (entry.kind === 'gamble') detail = 'Common… or Epic. Fate decides.';
    $('buy-stats').innerHTML = detail;
    // for gear, show how it compares to what's worn
    $('buy-compare').innerHTML = item ? (this.affinityNote(item) + this.compareNote(item)) : '';
    $('buy-price').innerHTML = `<span class="coin-stack"><span class="coin"></span><span class="coin c2"></span></span> ${entry.price}g`;
    $('buy-card').style.setProperty('--relic-glow', `#${R.color.toString(16).padStart(6, '0')}`);
    const buyBtn = $('btn-buy-confirm');
    const broke = p.gold < entry.price;
    buyBtn.disabled = broke;
    buyBtn.textContent = broke ? 'Not enough gold' : 'Buy';
    // mystery relics rest between draws (6s spam guard) AND cap at 3 buys
    // per rolling 10 minutes — tell the player how long either way
    if (entry.kind === 'gamble') {
      const left = Math.ceil((this.game.gambleReadyAt() - performance.now()) / 1000);
      if (left > 0) { buyBtn.disabled = true; buyBtn.textContent = `Fate rests (${this.formatMMSS(left)})`; }
    }
    $('buy-confirm').classList.remove('hidden');
  }

  confirmBuy() {
    const pend = this._pendingBuy;
    $('buy-confirm').classList.add('hidden');
    if (!pend) return;
    this.game.buyFromVendor(pend.vendor, pend.entry);
    this.renderShop(pend.vendor);
    this._pendingBuy = null;
  }

  // Diablo-style inspect: another co-op hero's class, level and equipped gear.
  showInspect(rp) {
    $('inspect-name').textContent = rp.name || 'Hero';
    $('inspect-sub').textContent = `${this.className(rp.cls)} · Level ${rp.level || 1}`;
    const wrap = $('inspect-slots');
    wrap.innerHTML = '';
    const eq = rp.loadout || {};
    let any = false;
    for (const slot of ['weapon', 'helmet', 'chest', 'legs', 'hands', 'trinket', 'offhand']) {
      const it = eq[slot];
      const el = document.createElement('div');
      el.className = `inspect-slot ${it ? 'rarity-' + it.rarity : 'empty'}`;
      if (it) {
        any = true;
        const stats = Object.entries(it.stats || {}).map(([k, v]) => statLabel(k, v)).join(' · ');
        el.innerHTML = `<span class="is-icon">${it.icon}</span><div class="is-txt"><span class="tt-${it.rarity}">${it.name}</span><small>${stats || slot}</small></div>`;
      } else {
        el.innerHTML = `<span class="is-icon">·</span><div class="is-txt"><small class="is-empty">${slot} — empty</small></div>`;
      }
      wrap.appendChild(el);
    }
    if (!any) wrap.insertAdjacentHTML('afterbegin', '<div class="is-empty" style="text-align:center;margin-bottom:6px">No gear info yet</div>');
    $('inspect-panel').classList.remove('hidden');
  }

  // Pick which cleared act to travel into (opened from the town dungeon portal).
  showActSelect() {
    const g = this.game;
    const maxAct = Math.min(5, g.actsCleared + 1);
    const cur = g.currentAct();
    const names = ['', 'The Old Halls', 'The Rotting Depths', 'The Ember Vaults', 'The Sunless Court', 'The Abyssal Throne'];
    const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
    const list = $('act-list');
    list.innerHTML = '';
    for (let a = 1; a <= maxAct; a++) {
      const btn = document.createElement('button');
      btn.className = 'menu-btn';
      const isCur = a === cur;
      btn.innerHTML = `Act ${ROMAN[a]} — ${names[a]}<small>${isCur ? `resume · floor ${Math.min(g.floor, 50)}` : 'revisit from the start'}</small>`;
      btn.onclick = () => { $('act-select').classList.add('hidden'); g.travelToAct(a); };
      list.appendChild(btn);
    }
    $('act-select').classList.remove('hidden');
  }

  // Rosalind's branching flirt dialogue (Obsidian 783): her current line up
  // top with a mood read, four range-spanning replies below. Each reply calls
  // game.flirtSelect, which shifts her affinity and hands back her reaction +
  // the next four choices (empty when she's given up on a cold player).
  openFlirtDialog(pm, line, choices) {
    this._flirtPm = pm;
    $('flirt-name').textContent = pm.name || 'Rosalind';
    $('flirt-line').textContent = line;
    this._flirtMood(pm.affinity || 0);
    this._renderFlirtChoices(choices);
    $('btn-flirt-leave').textContent = 'Leave';
    $('flirt-dialog').classList.remove('hidden');
  }
  _renderFlirtChoices(choices) {
    const list = $('flirt-choices');
    list.innerHTML = '';
    for (const c of choices) {
      const btn = document.createElement('button');
      btn.className = `menu-btn flirt-choice flirt-tier${c.tier}`;
      btn.textContent = c.label;
      btn.onclick = () => {
        // Instant canned line; the LLM (801) may replace it a moment later via
        // updateFlirtLine() while the dialog stays open.
        const res = this.game.flirtSelect(this._flirtPm, c.tier);
        $('flirt-line').textContent = res.line;
        this._flirtMood(res.affinity);
        this._renderFlirtChoices(res.choices);
        if (res.disliked || !res.choices.length) $('btn-flirt-leave').textContent = 'Leave her be';
      };
      list.appendChild(btn);
    }
  }
  // The LLM enhancement (801) landed while the dialog is still open - swap the
  // canned line for the fresher one.
  updateFlirtLine(text) {
    if (this.game.state === 'flirt' && this._flirtPm) $('flirt-line').textContent = text;
  }
  _flirtMood(aff) {
    const el = $('flirt-mood');
    if (aff <= -3) { el.textContent = '✗ lost interest'; el.style.color = '#8a8a94'; }
    else if (aff >= 4) { el.textContent = '♥♥♥ smitten'; el.style.color = '#ff6ea6'; }
    else if (aff >= 2) { el.textContent = '♥♥ warming'; el.style.color = '#ff9ac0'; }
    else if (aff >= 1) { el.textContent = '♥'; el.style.color = '#ffb0cf'; }
    else { el.textContent = ''; el.style.color = ''; }
  }
  closeFlirt() {
    $('flirt-dialog').classList.add('hidden');
    this._flirtPm = null;
    if (this.game.state === 'flirt') this.game.state = 'playing';
  }

  // Zoltan's mystery relic: reveal what fate handed over, click to keep.
  showRelicReveal(item) {
    const R = RARITIES[item.rarity];
    $('relic-icon').textContent = item.icon;
    const name = $('relic-name');
    name.textContent = item.name;
    name.className = `tt-${item.rarity}`;
    $('relic-rarity').textContent = `${R.name}${item.consumable ? ' elixir' : ' ' + item.slot}`;
    $('relic-stats').innerHTML = item.consumable
      ? `<span class="tt-stat">${item.effectLabel || ''}</span>`
      : Object.entries(item.stats || {}).map(([k, v]) => `<span class="tt-stat">${statLabel(k, v)}</span>`).join(' · ');
    $('relic-card').style.setProperty('--relic-glow', `#${R.color.toString(16).padStart(6, '0')}`);
    $('relic-reveal').classList.remove('hidden');
  }

  // ---------- toasts/banners ----------
  showLevelUp(level) {
    const toast = $('levelup-toast');
    toast.classList.remove('hidden');
    // Device-appropriate hint for where the mastery point is spent: the K key on
    // desktop, the Mastery button on touch.
    const masteryHint = isTouchDevice() ? 'open Mastery' : '(K)';
    toast.innerHTML = `LEVEL ${level}!<div class="toast-sub">+1 mastery point ${masteryHint} · fully restored</div>`;
    toast.style.animation = 'none';
    void toast.offsetWidth; // restart animation
    toast.style.animation = '';
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => toast.classList.add('hidden'), 2300);
  }

  // Small "QUEST COMPLETE" toast with the actual reward line, popped when an
  // act boss falls (game.js delays it until the ACT CLEARED banner has faded).
  // Same restart-the-CSS-animation trick as the level-up toast above.
  showQuestComplete(title, reward) {
    const toast = $('quest-toast');
    if (!toast) return;
    toast.classList.remove('hidden');
    toast.innerHTML = `<span class="qt-head"><span class="qt-check">${UI.QUEST_MARKS.done}</span>QUEST COMPLETE</span>
      <div class="toast-sub">${title}</div>
      <div class="qt-reward">${reward}</div>`;
    toast.style.animation = 'none';
    void toast.offsetWidth;
    toast.style.animation = '';
    clearTimeout(this._questToastT);
    this._questToastT = setTimeout(() => toast.classList.add('hidden'), 4200);
    audio.play('level_up', { volume: 0.5, rate: 1.15 });
  }

  showFloorBanner(title, themeName, raw = false) {
    const b = $('floor-banner');
    b.classList.remove('hidden');
    const text = raw ? title : (title === 0 ? 'EMBERVALE' : `FLOOR ${title}`);
    b.innerHTML = `${text}<div class="banner-sub">${themeName}</div>`;
    b.style.animation = 'none';
    void b.offsetWidth;
    b.style.animation = '';
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => b.classList.add('hidden'), 2700);
  }

  showGameOver(floor) {
    $('gameover-text').textContent =
      `The dungeon claims another hero on floor ${floor}. Your strength endures — rise and try again.`;
    this.show('gameover');
  }

  showVictory(stats) {
    $('victory-stats').innerHTML = `
      Hero: <b>${stats.className}</b> — Level <b>${stats.level}</b><br>
      Monsters slain: <b>${stats.kills}</b> · Gold amassed: <b>${stats.gold}</b><br>
      Deaths along the way: <b>${stats.deaths}</b><br><br>
      The depths grow quiet… for now.
    `;
    this.show('victory');
  }

  // ---------- inventory ----------
  openInventory() {
    this.renderInventory();
    this.show('inventory');
    this.startInvPreview();
    audio.play('ui_open');
  }
  closeInventory() {
    // the item stats/actions card floats on top of the inventory but isn't
    // one of the this.screens panels hideAll() cycles through - close it
    // explicitly so it never gets orphaned open behind a closed inventory.
    this.closeItemActions();
    this.hideAll();
    this.stopInvPreview();
    audio.play('ui_close');
  }

  // ---------- inventory paper-doll live 3D preview ----------
  // Same pattern as startCharPreview (own tiny renderer, idle animation,
  // fully disposed on close) but shows the ACTUAL playing hero: real class,
  // gender, skin tone, name AND worn gear - the same updateHeroGear pass the
  // in-game hero gets (helmet, rarity tints, weapon dressing), re-applied in
  // the render loop so equipping from the bag updates the doll instantly
  // (updateHeroGear no-ops on an unchanged gear signature, so this is cheap).
  startInvPreview() {
    const canvas = $('inv-preview-canvas');
    if (!canvas) return;
    // ROOT CAUSE of the intermittent blank preview (TODO 686): stopInvPreview
    // used to call renderer.dispose() + renderer.forceContextLoss() on THIS
    // SAME, REUSED canvas element every time the inventory closed. Once a
    // canvas's WebGL context is explicitly lost via forceContextLoss(), the
    // browser will never grant that canvas a new context again - the first
    // open of a session works (virgin context), but the very next
    // getContext() call on the SECOND open returns null/a dead context
    // forever after, so every reopen from then on renders nothing. This
    // reproduced 100% of the time from the 2nd open onward (verified via
    // Playwright: startInvPreview() ran to completion with no thrown error,
    // yet this._invPrev stayed unset because the renderer's context was
    // already permanently dead). Fix: create the renderer ONCE and cache it
    // on the ui instance for the life of the page; every open/close cycle
    // reuses that same live context instead of killing and recreating it.
    let renderer = this._invPrevRenderer;
    if (!renderer || renderer.getContext()?.isContextLost?.()) {
      try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); }
      catch { return; } // no WebGL: the panel still works without the preview
      this._invPrevRenderer = renderer;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const w = canvas.clientWidth || 190, h = canvas.clientHeight || 260;
    renderer.setSize(w, h, false);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, w / h, 0.1, 30);
    camera.position.set(0, 1.35, 3.4);
    camera.lookAt(0, 0.85, 0);
    scene.add(new THREE.HemisphereLight(0xcdc4ea, 0x2a2033, 1.15));
    const key = new THREE.DirectionalLight(0xffe2b0, 1.7);
    key.position.set(2.2, 3.5, 2.6);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x8a6cff, 0.8);
    rim.position.set(-2.5, 2, -2);
    scene.add(rim);
    const turntable = new THREE.Group();
    scene.add(turntable);

    const p = this.game.player;
    const anim = buildAnimatedHero(p.classId, this.game.playerName(), { gender: p.gender, skinTone: p.skinTone, hairColor: p.hairColor, eyeColor: p.eyeColor, faceShape: p.faceShape, hairStyle: p.hairStyle });
    let mesh, gait = null;
    if (anim) mesh = anim.mesh;
    else { mesh = buildHeroMesh(CLASSES[p.classId], this.game.playerName()); gait = mesh.userData.updateGait; }
    turntable.add(mesh);
    if (anim) this.game.updateHeroGear(mesh, p.equipped, p.classId);

    const P = this._invPrev = {
      renderer, scene, camera, turntable, canvas, mesh, anim, gait,
      lastT: performance.now(), raf: 0, w, h,
    };
    const loop = () => {
      if (this._invPrev !== P) return;
      P.raf = requestAnimationFrame(loop);
      // A throw anywhere below (bad gear signature, mixer on a disposed
      // bone, etc.) used to fall out of this function and silently end the
      // RAF chain forever - the canvas just stayed blank with no visible
      // error. Now the loop survives: skip this one frame, log once (not
      // per-frame, to avoid console spam), keep ticking next frame.
      try {
        const now = performance.now();
        const dt = Math.min(0.05, (now - P.lastT) / 1000);
        P.lastT = now;
        // Paused (but still ticking the clock above) while the item-actions
        // card is open: it's a full-screen overlay that fully hides the doll,
        // so rendering behind it would be wasted GPU work every frame.
        if (!$('item-actions')?.classList.contains('hidden')) return;
        const cw = P.canvas.clientWidth, ch = P.canvas.clientHeight;
        if (cw && ch && (cw !== P.w || ch !== P.h)) {
          P.w = cw; P.h = ch;
          P.renderer.setSize(cw, ch, false);
          P.camera.aspect = cw / ch;
          P.camera.updateProjectionMatrix();
        }
        P.turntable.rotation.y += dt * 0.7;
        if (P.anim) this.game.updateHeroGear(P.mesh, this.game.player.equipped, this.game.player.classId);
        if (P.anim) { P.anim.setLocomotion(0, dt, false); P.anim.mixer.update(dt); }
        if (P.gait) P.gait(dt, 0, false);
        P.renderer.render(P.scene, P.camera);
      } catch (err) {
        if (!P.loggedError) { P.loggedError = true; console.warn('[invPreview] frame error (recovering):', err); }
      }
    };
    loop();
  }

  stopInvPreview() {
    const P = this._invPrev;
    if (!P) return;
    cancelAnimationFrame(P.raf);
    P.turntable.remove(P.mesh);
    P.mesh.traverse((o) => {
      if (o.isMesh && o.material) {
        // split weapons carry an ARRAY of materials (grip/blade groups from
        // splitWeaponMesh) - dispose each; a bare .dispose() on the array
        // itself throws and leaked every preview teardown.
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m.map && m.map.isCanvasTexture) m.map.dispose();
          m.dispose();
        }
      }
    });
    // NOTE: deliberately does NOT call renderer.dispose()/forceContextLoss()
    // here (see the long comment in startInvPreview) - the renderer and its
    // WebGL context are cached on this.game.ui and reused for every future
    // open of this panel. Only the scene-owned mesh/material/texture
    // resources built by THIS open are freed above.
    this._invPrev = null;
  }

  // ---------- inventory drag-and-drop ----------
  // One pointer-based drag session, bound ONCE on window (elements themselves
  // are torn down and rebuilt every renderInventory() call, so per-element
  // listeners can't own the move/up lifecycle). Mirrors wireActionButton's
  // tap-vs-drag split: a quick press-release is a click (stats card / equip-
  // best / multi-select toggle, all unchanged); a press that moves past
  // DRAG_PX becomes a real drag, tracked via this._invDrag and resolved by
  // whatever is under the pointer at release (document.elementFromPoint).
  // Two directions only, matching what the data model actually supports:
  // bag item -> matching equip slot (equip(), which already swaps the worn
  // item back into the pack), or equipped item -> anywhere in the bag grid
  // (unequip()). Bag-to-bag reordering isn't a thing the inventory array
  // exposes, so it's not offered as a drop target.
  wireInventoryDragGlobal() {
    const DRAG_PX = 18; // matches the action-cluster tap-vs-swipe threshold
    const clearHighlights = () => {
      document.querySelectorAll('#equip-slots .inv-slot, #inv-grid .inv-slot')
        .forEach((s) => s.classList.remove('drop-target', 'drop-invalid'));
    };
    const targetAt = (x, y) => document.elementFromPoint(x, y)?.closest('.inv-slot') || null;
    window.addEventListener('pointermove', (e) => {
      const d = this._invDrag;
      if (!d || d.pointerId !== e.pointerId) return;
      if (!d.dragging) {
        const moved = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
        if (moved <= DRAG_PX) return;
        d.dragging = true;
        clearTimeout(d.longPressTimer);
        d.el.classList.add('dragging');
        this.hideTooltip();
      }
      clearHighlights();
      const target = targetAt(e.clientX, e.clientY);
      if (!target || target === d.el) return;
      target.classList.add(this._invDropValid(d, target) ? 'drop-target' : 'drop-invalid');
    });
    const finish = (e) => {
      const d = this._invDrag;
      if (!d || d.pointerId !== e.pointerId) return;
      clearTimeout(d.longPressTimer);
      this._invDrag = null;
      d.el.classList.remove('dragging');
      clearHighlights();
      if (d.dragging) {
        // A real drag happened, so the trailing click (if any) is not a tap.
        // The browser only fires that click when down/up land on the SAME
        // element (dropped back where it started) - if the drop landed
        // elsewhere, no click ever comes to consume this flag, so clear it
        // on the next tick rather than leaving it armed to silently eat the
        // player's next unrelated tap.
        this._suppressClick = true;
        setTimeout(() => { this._suppressClick = false; }, 0);
        const target = targetAt(e.clientX, e.clientY);
        if (target && target !== d.el && this._invDropValid(d, target)) this._invDropExecute(d);
        this.renderInventory();
      }
    };
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }

  // Valid drop targets: bag item -> the ONE equip slot matching its gear
  // slot AND respecting class-lock; equipped item -> any bag grid cell, as
  // long as the bag has room (unequip() itself refuses when full).
  _invDropValid(d, target) {
    const p = this.game.player;
    if (d.origin === 'bag') {
      if (!target.classList.contains('equip')) return false;
      if (target.dataset.slot !== d.item.slot) return false;
      if (d.item.forClass && d.item.forClass !== p.classId) return false;
      return true;
    }
    // origin === 'equip': drop anywhere in the bag grid (not another equip slot)
    if (target.classList.contains('equip')) return false;
    if (target.closest('#inv-grid') == null) return false;
    return p.inventory.length < p.invSize;
  }

  _invDropExecute(d) {
    if (d.origin === 'bag') this.game.equip(d.item);
    else this.game.unequip(d.fromSlot);
  }

  renderInventory() {
    const p = this.game.player;
    const equipWrap = $('equip-slots');
    equipWrap.innerHTML = '';
    for (const slotName of ['weapon', 'helmet', 'chest', 'legs', 'hands', 'trinket', 'offhand']) {
      const item = p.equipped[slotName];
      const el = document.createElement('div');
      const offClass = item && item.affinity && item.affinity !== p.classId;
      el.className = `inv-slot equip ${item ? 'rarity-' + item.rarity : ''} ${offClass ? 'off-class' : ''}`;
      el.dataset.slot = slotName;
      const eqIcon = item ? (item.slot ? `<img class="inv-item-icon" src="${makeItemIcon(item)}" alt="">` : item.icon) : '·';
      el.innerHTML = `${eqIcon}<span class="slot-label">${slotName}</span>`;
      if (item) {
        el.onmouseenter = (e) => this.showTooltip(item, e, true);
        el.onmouseleave = () => this.hideTooltip();
        // stats panel first; unequipping is a button on that panel
        el.onclick = () => {
          if (this._suppressClick) { this._suppressClick = false; return; }
          this.selectItem(item, slotName);
        };
        // drag an equipped item back out to the bag to unequip it
        el.onpointerdown = (e) => {
          this._invDrag = { origin: 'equip', item, fromSlot: slotName, el, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, dragging: false };
        };
      } else {
        // One-tap fill: click an empty slot to equip the best-scoring eligible
        // item from the pack for that slot (respecting class-lock rules).
        const best = this.bestBagItemForSlot(slotName);
        if (best) {
          el.classList.add('fillable');
          el.title = `Equip best: ${best.name}`;
          el.onclick = () => {
            if (this._suppressClick) { this._suppressClick = false; return; }
            this.game.equip(best); this.renderInventory();
          };
        }
      }
      equipWrap.appendChild(el);
    }

    this.renderInvStats(p);

    this.destroySel ||= new Set();
    // drop any queued-for-destruction items that left the pack
    for (const it of [...this.destroySel]) if (!p.inventory.includes(it)) this.destroySel.delete(it);

    const grid = $('inv-grid');
    grid.innerHTML = '';
    for (let i = 0; i < p.invSize; i++) {
      const item = p.inventory[i];
      const el = document.createElement('div');
      const marked = item && this.destroySel.has(item);
      el.className = `inv-slot ${item ? 'rarity-' + item.rarity : ''} ${marked ? 'marked' : ''}`;
      // gear gets its unique procedural picture; consumables keep their glyph
      if (item && item.slot) el.innerHTML = `<img class="inv-item-icon" src="${makeItemIcon(item)}" alt="">`;
      else el.textContent = item ? item.icon : '';
      if (item) {
        // Once multi-select is active (any item marked), the grid is a picker:
        // no stats card, no hover tooltip - every tap just toggles a mark, so
        // the stats popup never covers the items being multi-selected.
        el.onmouseenter = (e) => { if (this.destroySel.size === 0) this.showTooltip(item, e); };
        el.onmouseleave = () => this.hideTooltip();
        const toggleMark = () => {
          this.destroySel.has(item) ? this.destroySel.delete(item) : this.destroySel.add(item);
          this.hideTooltip();
          // entering multi-select tears down the stats card so it can't cover
          // the grid while items are being picked
          if (this.destroySel.size > 0) this.closeItemActions();
          this.renderInventory();
        };
        // ctrl/cmd/shift-click marks for bulk destruction; plain click = stats,
        // unless multi-select is already active, in which case a plain tap marks.
        el.onclick = (e) => {
          if (this._suppressClick) { this._suppressClick = false; return; }
          if (e.ctrlKey || e.metaKey || e.shiftKey || this.destroySel.size > 0) toggleMark();
          else this.selectItem(item);
        };
        // touch: press-and-hold (with no real drag) enters multi-select, same
        // as before. Any pointer type also starts tracking a potential drag
        // to an equip slot - if it crosses the drag threshold first, the
        // window-level handler in wireInventoryDragGlobal cancels this timer
        // and takes over, so a real drag never also triggers multi-select.
        // Suppressed entirely once multi-select is already active, so the
        // existing tap-to-mark picker flow is untouched.
        el.onpointerdown = (e) => {
          if (this.destroySel.size > 0) return;
          this._invDrag = { origin: 'bag', item, el, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, dragging: false };
          if (e.pointerType === 'touch') {
            this._invDrag.longPressTimer = setTimeout(() => {
              if (this._invDrag && this._invDrag.pointerId === e.pointerId && !this._invDrag.dragging) {
                this._invDrag = null;
                this._suppressClick = true;
                this.hideTooltip();
                toggleMark();
              }
            }, 450);
          }
        };
        el.oncontextmenu = (e) => { e.preventDefault(); this.game.dropItem(item); this.renderInventory(); this.hideTooltip(); };
      }
      grid.appendChild(el);
    }
    const stillHeld = this.selectedItem &&
      (p.inventory.includes(this.selectedItem) || Object.values(p.equipped).includes(this.selectedItem));
    if (!stillHeld) {
      this.selectedItem = null;
      $('item-actions').classList.add('hidden');
    }

    // the inventory action buttons sit in a single horizontal row
    let row = $('inv-btn-row');
    if (!row) {
      row = document.createElement('div');
      row.id = 'inv-btn-row';
      row.style.cssText = 'display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:8px;';
      grid.parentElement.appendChild(row);
    }

    // quick "drop all commons" button — created once, shown only when commons exist
    let dc = $('drop-commons-btn');
    if (!dc) {
      dc = document.createElement('button');
      dc.id = 'drop-commons-btn';
      dc.className = 'menu-btn small';
      row.appendChild(dc);
      dc.onclick = () => { this.game.dropAllCommons(); this.renderInventory(); };
    }
    const commons = p.inventory.filter((it) => it.rarity === 'common').length;
    dc.textContent = `Drop all commons (${commons})`;
    dc.style.display = commons ? '' : 'none';

    // Bulk destruction: no standing toggle button. Marking 2+ items
    // (ctrl-click / press-and-hold) reveals the destroy button; single-item
    // destruction lives on the item's stats panel instead.
    $('destroy-toggle-btn')?.remove(); // retired control from the old flow
    let db = $('destroy-confirm-btn');
    if (!db) {
      db = document.createElement('button');
      db.id = 'destroy-confirm-btn'; db.className = 'menu-btn small danger';
      row.appendChild(db);
      db.onclick = () => this.confirmDestroy([...this.destroySel]);
    }
    db.innerHTML = `${svgIcon('trash')} Destroy ${this.destroySel.size} items`;
    db.style.display = this.destroySel.size >= 2 ? '' : 'none';
  }

  // Two-column totals under the doll: Offense (damage/crit/speed/ultimate
  // cooldown) and Defense (health/armor/regen/level). Pulls from the same
  // derived stats recompute() already produces, so it always matches what
  // combat actually uses - no separate calculation to drift out of sync.
  renderInvStats(p) {
    const wrap = $('inv-stats');
    if (!wrap) return;
    const row = (label, val) => `<div class="stat-row"><span>${label}</span><span>${val}</span></div>`;
    wrap.innerHTML = `
      <div class="inv-stats-col">
        <h4>Offense</h4>
        ${row('Damage', Math.round(p.baseDamage))}
        ${row('Crit chance', Math.round(p.crit * 100) + '%')}
        ${row('Move speed', Math.round(p.speed))}
        ${row('Ultimate CDR', Math.round((p.ult4Cdr || 0) * 100) + '%')}
      </div>
      <div class="inv-stats-col">
        <h4>Defense</h4>
        ${row('Max health', p.maxHp)}
        ${row('Armor', Math.round(p.armor * 100) + '%')}
        ${row('Resource regen', p.resourceRegen.toFixed(1))}
        ${row('Level', p.level)}
      </div>`;
  }

  // List the doomed items and ask before wiping them for good. Anything
  // valuable gets called out loudly above the message so a misclick can't
  // silently vaporize an Epic.
  confirmDestroy(items) {
    if (!items?.length) return;
    this._destroyPending = items;
    const high = items.filter((it) => ['rare', 'epic', 'legendary'].includes(it.rarity) || (it.value || 0) >= 200);
    const warn = $('destroy-warning');
    if (high.length) {
      warn.innerHTML = `<div class="destroy-warn-head">⚠ You are about to destroy high-value gear:</div>` +
        high.map((it) => {
          const stats = Object.entries(it.stats || {}).map(([k, v]) => statLabel(k, v)).join(' · ');
          return `<div class="tt-stat tt-${it.rarity}">${it.icon} <b>${it.name}</b> · ${RARITIES[it.rarity].name}${stats ? ' · ' + stats : ''} · ${it.value || 0}g</div>`;
        }).join('');
      warn.classList.remove('hidden');
    } else {
      warn.classList.add('hidden');
    }
    $('destroy-count').textContent = `Permanently destroy ${items.length} item${items.length > 1 ? 's' : ''}? This cannot be undone.`;
    $('destroy-list').innerHTML = items.map((it) => `<div class="tt-stat tt-${it.rarity}">${it.icon} ${it.name}</div>`).join('');
    $('destroy-modal').classList.remove('hidden');
  }

  className(id) { return ({ knight: 'Knight', mage: 'Mage', ranger: 'Ranger' })[id] || id; }

  // A one-line note about class-lock (weapons) or affinity (shared gear).
  affinityNote(item) {
    const cls = this.game.player.classId;
    if (item.forClass) {
      const ok = item.forClass === cls;
      return `<div style="font-size:11px;margin-top:2px;color:${ok ? '#7ce87c' : '#e86a6a'}">${ok ? '★ Your class' : svgIcon('ban') + ' ' + this.className(item.forClass) + ' only'}</div>`;
    }
    if (item.affinity) {
      const ok = item.affinity === cls;
      return `<div style="font-size:11px;margin-top:2px;color:${ok ? '#7ce87c' : '#e8a85a'}">${ok ? '★ Attuned to your class' : '½ stats · attuned to ' + this.className(item.affinity)}</div>`;
    }
    return '';
  }

  statName(k) {
    return ({
      damagePct: 'damage', maxHp: 'max HP', armor: 'armor', crit: 'crit', speed: 'move speed', regen: 'regen', cdr4: 'ult cooldown',
      blockChance: 'block chance', thorns: 'thorns', procRegen: 'bonus regen', goldFind: 'gold find', killHeal: 'kill heal',
    })[k] || k;
  }

  // Split a stat into a bold value and a readable name, for the two-column
  // stat list in the item panel (value on the left, label on the right).
  statParts(k, v) {
    const pct = k === 'damagePct' || k === 'armor' || k === 'crit' || k === 'speed' || k === 'cdr4' || k === 'blockChance' || k === 'goldFind' || k === 'killHeal';
    const name = ({
      damagePct: 'Damage', maxHp: 'Max Health', armor: 'Armor', crit: 'Crit Chance', speed: 'Move Speed', regen: 'Resource Regen', cdr4: 'Ult Cooldown',
      blockChance: 'Block Chance', thorns: 'Thorns (reflect)', procRegen: 'Bonus Regen', goldFind: 'Gold Find', killHeal: 'Heal on Kill',
    })[k] || k;
    const sign = k === 'cdr4' ? '-' : '+';
    return { val: `${sign}${v}${pct ? '%' : ''}`, name };
  }

  // Best pack item to drop into an empty equip slot, or null if none fit.
  // Only gear for that slot the hero may actually wear (class-lock respected);
  // scored by the same affinity-adjusted stat weights compareNote uses, with
  // item level then rarity as tie-breakers.
  bestBagItemForSlot(slotName) {
    const p = this.game.player;
    const W = {
      maxHp: 0.15, armor: 1, crit: 1.5, speed: 1, regen: 0.8, damagePct: 1.2, cdr4: 1,
      blockChance: 1.3, thorns: 0.9, procRegen: 0.8, goldFind: 0.7, killHeal: 1.1,
    };
    const RANK = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };
    const score = (it) => {
      const scale = (it.affinity && it.affinity !== p.classId) ? 0.5 : 1;
      let total = 0;
      for (const [k, v] of Object.entries(it.stats || {})) total += (v * scale) * (W[k] || 1);
      return total;
    };
    let best = null, bestScore = -Infinity;
    for (const it of p.inventory) {
      if (it.consumable || it.slot !== slotName) continue;
      if (it.forClass && it.forClass !== p.classId) continue; // can't wield
      const s = score(it);
      const better = s > bestScore
        || (s === bestScore && best && (
          (it.ilvl ?? 0) > (best.ilvl ?? 0)
          || ((it.ilvl ?? 0) === (best.ilvl ?? 0) && (RANK[it.rarity] ?? 0) > (RANK[best.rarity] ?? 0))
        ));
      if (better) { best = it; bestScore = s; }
    }
    return best;
  }

  // Compare a gear item against what's equipped in its slot: per-stat deltas
  // (green gain / red loss, accounting for class affinity) + an overall verdict.
  compareNote(item) {
    if (!item || item.consumable || !item.slot) return '';
    const p = this.game.player;
    const equipped = p.equipped[item.slot];
    if (!equipped) return `<div style="font-size:11px;margin-top:5px;color:#7ce87c">▲ ${item.slot} slot empty: straight upgrade</div>`;
    if (equipped === item) return '';
    const eff = (it) => {
      const scale = (it.affinity && it.affinity !== p.classId) ? 0.5 : 1;
      const m = {}; for (const [k, v] of Object.entries(it.stats || {})) m[k] = v * scale; return m;
    };
    const a = eff(item), b = eff(equipped);
    const W = {
      maxHp: 0.15, armor: 1, crit: 1.5, speed: 1, regen: 0.8, damagePct: 1.2, cdr4: 1,
      blockChance: 1.3, thorns: 0.9, procRegen: 0.8, goldFind: 0.7, killHeal: 1.1,
    };
    let total = 0; const rows = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = Math.round((a[k] || 0) - (b[k] || 0));
      if (!d) continue;
      total += d * (W[k] || 1);
      const color = d > 0 ? '#7ce87c' : '#e86a6a';
      rows.push(`<div class="tt-stat" style="color:${color}">${d > 0 ? '+' : ''}${d} ${this.statName(k)}</div>`);
    }
    const verdict = total > 0.5 ? '<span style="color:#7ce87c">▲ Upgrade</span>'
      : total < -0.5 ? '<span style="color:#e86a6a">▼ Downgrade</span>'
      : '<span style="opacity:0.6">≈ Sidegrade</span>';
    return `<div style="border-top:1px solid rgba(255,255,255,0.12);margin-top:6px;padding-top:4px;">
      <div style="font-size:11px;opacity:0.7;margin-bottom:2px;">vs equipped ${equipped.icon}: ${verdict}</div>${rows.join('')}</div>`;
  }

  // Tap/click an item -> action panel (works on mobile where right-click doesn't exist).
  // Show an item's stats in the detail panel. Equipping/unequipping happens
  // via the button at the bottom, never directly from the grid click.
  selectItem(item, equippedSlot = null) {
    this.selectedItem = item;
    const panel = $('item-actions');
    panel.classList.remove('hidden');
    // comparing an equipped item against itself is noise; only compare pack items
    const compare = equippedSlot ? '' : this.compareNote(item);
    const rarityName = RARITIES[item.rarity]?.name || item.rarity;
    if (item.consumable) {
      // consumables keep their glyph, shown large, with the effect spelled out
      $('item-actions-info').innerHTML = `
        <div class="item-panel">
          <div class="item-hero">
            <div class="item-pic emoji rarity-${item.rarity}">${item.icon}</div>
            <div class="item-head">
              <div class="item-name tt-${item.rarity}">${item.name}</div>
              <div class="item-meta">${rarityName} elixir</div>
            </div>
          </div>
          <div class="item-stats"><div class="stat-row"><span class="stat-name">${item.effectLabel || 'Temporary boon'}</span></div></div>
        </div>`;
    } else {
      const ilvl = item.ilvl ?? Math.max(1, Math.round((item.value || 20) / 8));
      const rows = Object.entries(item.stats).map(([k, v]) => {
        const s = this.statParts(k, v);
        return `<div class="stat-row"><span class="stat-val">${s.val}</span><span class="stat-name">${s.name}</span></div>`;
      }).join('');
      $('item-actions-info').innerHTML = `
        <div class="item-panel">
          <div class="item-hero">
            <img class="item-pic rarity-${item.rarity}" src="${makeItemIcon(item, 96)}" alt="">
            <div class="item-head">
              <div class="item-name tt-${item.rarity}">${item.name}</div>
              <div class="item-meta">${rarityName} ${item.slot} &middot; <span class="item-ilvl">iLvl ${ilvl}</span></div>
            </div>
          </div>
          <div class="item-stats">${rows}</div>
          ${this.affinityNote(item)}${compare}
        </div>`;
    }
    const equipBtn = $('btn-item-equip');
    equipBtn.textContent = item.consumable ? 'Drink' : equippedSlot ? 'Unequip' : 'Equip';
    equipBtn.onclick = equippedSlot
      ? () => { this.game.unequip(equippedSlot); this.closeItemActions(); this.renderInventory(); }
      : () => { this.game.equip(item); this.closeItemActions(); this.renderInventory(); };
    // Selling is done only at an NPC vendor's menu, never from the inventory.
    const sellBtn = $('btn-item-sell');
    if (sellBtn) sellBtn.style.display = 'none';
    const dropBtn = $('btn-item-drop');
    dropBtn.style.display = equippedSlot ? 'none' : '';
    dropBtn.onclick = () => { this.game.dropItem(item); this.closeItemActions(); this.renderInventory(); };
    // destroying goes through the same confirmation modal as bulk destruction
    const destroyBtn = $('btn-item-destroy');
    destroyBtn.style.display = equippedSlot ? 'none' : '';
    destroyBtn.onclick = () => { this.closeItemActions(); this.confirmDestroy([item]); };
  }

  closeItemActions() {
    this.selectedItem = null;
    $('item-actions').classList.add('hidden');
  }

  showTooltip(item, e, equipped = false) {
    const tt = $('item-tooltip');
    tt.classList.remove('hidden');
    const stats = item.consumable
      ? `<div class="tt-stat">${item.effectLabel || 'Temporary boon'}</div>`
      : Object.entries(item.stats).map(([k, v]) => `<div class="tt-stat">${statLabel(k, v)}</div>`).join('');
    const hint = equipped ? 'Click for details' : 'Click for details · Right-click to drop';
    tt.innerHTML = `
      <h4 class="tt-${item.rarity}">${item.icon} ${item.name}</h4>
      <div style="opacity:0.6;font-size:11px;">${RARITIES[item.rarity].name} ${item.consumable ? 'elixir' : item.slot}</div>
      ${stats}
      ${this.affinityNote(item)}
      ${equipped ? '' : this.compareNote(item)}
      <div style="opacity:0.5;font-size:11px;margin-top:6px;">${hint}</div>
    `;
    tt.style.left = `${Math.min(e.clientX + 16, window.innerWidth - 260)}px`;
    tt.style.top = `${Math.min(e.clientY + 8, window.innerHeight - 180)}px`;
  }
  hideTooltip() { $('item-tooltip').classList.add('hidden'); }
}

function timeAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
