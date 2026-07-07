import { CLASSES } from '../entities/classes.js';
import { SKILLS } from '../entities/skills.js';
import { RARITIES, statLabel, sellValue, buyPrice } from '../entities/loot.js';
import { makeItemIcon } from '../entities/itemIcon.js';
import { SaveManager } from '../core/save.js';
import { Floaters } from './floaters.js';
import { Minimap } from './minimap.js';
import { audio } from '../core/audio.js';

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
    this.buildClassCards();
    this.initChat();
    this.addUiSounds();
  }

  // ---------- screens ----------
  show(name) {
    for (const [k, el] of Object.entries(this.screens)) {
      el.classList.toggle('visible', k === name);
    }
  }
  hideAll() { this.show('__none__'); }
  showHud(visible) { this.hud.classList.toggle('hidden', !visible); }

  setLoadingProgress(frac, text) {
    $('loading-bar').style.width = `${Math.round(frac * 100)}%`;
    if (text) $('loading-text').textContent = text;
  }

  showTitle() {
    this.show('title');
    this.showHud(false);
  }

  // Themed replacement for native alert()/confirm(): resolves true on
  // OK/confirm, false on cancel, outside-click, or Esc. Pass notice: true for
  // a single-button acknowledgement (no cancel button). danger: true reuses
  // the destroy-modal's red styling on the card and confirm button.
  confirmModal({ title = '', message = '', confirmText = 'OK', cancelText = 'Cancel', danger = false, notice = false } = {}) {
    return new Promise((resolve) => {
      const modal = $('confirm-modal'), card = $('confirm-card');
      const okBtn = $('btn-confirm-ok'), cancelBtn = $('btn-confirm-cancel');
      $('confirm-title').textContent = title;
      $('confirm-message').textContent = message;
      card.classList.toggle('danger', !!danger);
      okBtn.textContent = confirmText;
      okBtn.classList.toggle('danger', !!danger);
      cancelBtn.classList.toggle('hidden', !!notice);
      cancelBtn.textContent = cancelText;
      modal.classList.remove('hidden');
      audio.play('ui_open');
      const cleanup = (result) => {
        modal.classList.add('hidden');
        okBtn.onclick = null; cancelBtn.onclick = null;
        modal.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey);
        resolve(result);
      };
      const onBackdrop = (e) => { if (e.target === modal) cleanup(false); };
      const onKey = (e) => { if (e.key === 'Escape') cleanup(false); };
      okBtn.onclick = () => cleanup(true);
      cancelBtn.onclick = () => cleanup(false);
      modal.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey);
    });
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
    $('btn-inspect-close').onclick = () => $('inspect-panel').classList.add('hidden');
    $('inspect-panel').addEventListener('click', (e) => { if (e.target.id === 'inspect-panel') $('inspect-panel').classList.add('hidden'); });
    $('item-actions').addEventListener('click', (e) => { if (e.target.id === 'item-actions') this.closeItemActions(); });
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
        <ul>${cls.abilities.map((a) => `<li><b>${a.icon} ${a.name}</b> — ${a.desc}</li>`).join('')}</ul>
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
      });
    }
    $('btn-charselect-confirm').onclick = () => {
      // a name is REQUIRED before starting
      const name = (csName?.value || '').trim().slice(0, 14);
      if (!name) { csName?.classList.add('input-error'); csName?.focus(); return; }
      localStorage.setItem('emberdeep-name-v1', name);
      if (this.selectedClass) this.game.startNewGame(this.selectedClass);
    };
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
      <ul>${cls.abilities.map((a) => `<li><b>${a.icon} ${a.name}</b> — ${a.desc}</li>`).join('')}</ul>
    `;
    const btn = $('btn-charselect-confirm');
    btn.disabled = false;
    btn.textContent = `Begin as ${cls.name}`;
  }

  resetClassSelect() {
    this.selectedClass = null;
    for (const card of this.classCards.values()) card.classList.remove('selected');
    $('class-detail').classList.add('hidden');
    const btn = $('btn-charselect-confirm');
    btn.disabled = true;
    btn.textContent = 'Choose a hero';
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
    const icons = { knight: '🛡️', mage: '🔮', ranger: '🏹' };
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
        <span class="save-icon">${icons[p.classId] || '⚔️'}</span>
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
  openNotices(notices) {
    const list = $('notices-list');
    list.innerHTML = '';
    for (const nt of notices) {
      const paper = document.createElement('div');
      paper.className = 'notice-paper';
      paper.innerHTML = `<h4>${nt.title}</h4><p>${nt.text}</p>`;
      list.appendChild(paper);
    }
    this.show('notices');
    audio.play('ui_open');
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
    let branch = '';
    for (const sk of SKILLS) {
      if (sk.branch !== branch) {
        branch = sk.branch;
        const h = document.createElement('div');
        h.className = 'skills-branch';
        h.textContent = branch;
        grid.appendChild(h);
      }
      const rank = p.skillRank(sk.id);
      const row = document.createElement('div');
      row.className = `skill-row ${rank >= sk.max ? 'maxed' : ''}`;
      row.innerHTML = `
        <span class="skill-icon">${sk.icon}</span>
        <span class="skill-main">
          <div class="skill-name">${sk.name} <span class="skill-rank">${rank}/${sk.max}</span></div>
          <div class="skill-desc">${sk.per} per rank</div>
        </span>
        <button class="skill-buy menu-btn small" ${pts <= 0 || rank >= sk.max ? 'disabled' : ''}>+</button>
      `;
      row.querySelector('.skill-buy').onclick = () => this.game.buySkill(sk.id);
      grid.appendChild(row);
    }
    this.show('skills');
  }

  // ---------- quest log ----------
  openQuestLog() {
    const qs = this.game.questState();
    const list = $('quest-list');
    list.innerHTML = '';
    for (const a of qs.acts) {
      const row = document.createElement('div');
      row.className = `quest-row ${a.cleared ? 'done' : a.current ? 'active' : 'locked'}`;
      const mark = a.cleared ? '✅' : a.current ? '⚔️' : '🔒';
      row.innerHTML = `
        <span class="quest-mark">${mark}</span>
        <span class="quest-main">
          <div class="quest-title">${a.title}</div>
          <div class="quest-obj">${a.objective}${a.cleared ? ' — done' : a.current ? ' — in progress' : ''}</div>
        </span>`;
      list.appendChild(row);
    }
    if (qs.done) {
      const row = document.createElement('div');
      row.className = 'quest-row done';
      row.innerHTML = '<span class="quest-mark">🌀</span><span class="quest-main"><div class="quest-title">The Endless Abyss</div><div class="quest-obj">Descend as far as you dare.</div></span>';
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
  }

  renderShop(vendor) {
    const p = this.game.player;
    const FLAVOR = {
      potions: { portrait: '⚗️', tag: 'Remedies & tonics — brewed this morning' },
      gear: { portrait: '⚒️', tag: 'Honest steel, honestly priced' },
      mystery: { portrait: '🔮', tag: 'Fate, bottled. No refunds.' },
    };
    const fl = FLAVOR[vendor.type] || FLAVOR.gear;
    $('shop-portrait').textContent = fl.portrait;
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
        <span class="shop-item-icon">${entry.icon}</span>
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
      el.innerHTML = `
        <span class="shop-item-icon">${item.icon}</span>
        <span class="shop-item-name">${item.name}<small>${RARITIES[item.rarity].name} ${item.slot}</small></span>
        <span class="shop-item-price sell">+${sellValue(item)}g</span>
      `;
      el.onclick = () => { this.game.sellItem(item); this.renderShop(vendor); };
      sellWrap.appendChild(el);
    }
  }

  // ---------- settings ----------
  wireSettings() {
    const s = this.game.settings;
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
    };
    bindPlain('set-vchat', 'set-vchat-val', 'voiceChatVolume');
    bindPlain('set-speech', 'set-speech-val', 'speechVolume');

    // key bindings (desktop): click a row, then press a key to rebind
    this.renderKeybinds();

    // Auto-balance: dialogue-first mixing — speech at reference, voice chat
    // equal (0 dB), SFX −6 dB, music −12 dB, master at 85%.
    $('btn-auto-level').onclick = () => {
      const db = (d) => Math.pow(10, d / 20);
      s.speechVolume = 1.0;
      s.voiceChatVolume = 1.0;
      s.sfxVolume = +(db(-6)).toFixed(2);    // ≈ 0.50
      s.musicVolume = +(db(-12)).toFixed(2); // ≈ 0.25
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

    const shake = $('set-shake');
    shake.checked = s.screenShake;
    shake.onchange = () => { s.screenShake = shake.checked; this.game.saveSettings(); };

    const taunts = $('set-taunts');
    taunts.checked = s.taunts !== false;
    taunts.onchange = async () => {
      s.taunts = taunts.checked;
      this.game.saveSettings();
      const { roaster } = await import('../ai/roaster.js');
      roaster.enabled = s.taunts;
      if (!s.taunts && 'speechSynthesis' in window) speechSynthesis.cancel();
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
      $('voice-meter-hint').classList.toggle('hidden', mode !== 'auto');
      // The hear-yourself mic test is useful in any mic mode (PTT or auto).
      $('mic-test-row').classList.toggle('hidden', mode === 'off');
      $('touch-mic').classList.toggle('hidden', mode !== 'ptt');
      this.setMicAvailable(mode === 'ptt');
    };
    vSel.value = s.voiceMode;
    vThresh.value = s.voiceThreshold;
    vVal.textContent = s.voiceThreshold;
    syncVoiceRows();
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
          vSel.value = 'off'; s.voiceMode = 'off'; this.game.saveSettings(); syncVoiceRows();
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
          micTestBtn.textContent = stage === 'record' ? '● Recording… (speak)' : stage === 'play' ? '▶ Playing back…' : '🎤 Test mic';
        });
      } catch {
        await this.confirmModal({ title: 'No microphone', message: 'Microphone unavailable or permission denied.', notice: true });
        micTestBtn.textContent = '🎤 Test mic';
      }
      micTestBtn.disabled = false;
    };
    // Live mic level while settings are open, drawn INSIDE the trigger slider:
    // the fill is your voice, the knob is the cutoff it must cross.
    setInterval(async () => {
      if (!this.screens.settings.classList.contains('visible')) return;
      const { voice } = await import('../net/voice.js');
      const fill = $('voice-level-fill');
      if (!fill) return;
      if (voice.active) {
        // map the level onto the slider's own min..max scale so the fill lines
        // up with where the knob sits for the same value
        const min = +vThresh.min, max = +vThresh.max;
        const frac = Math.max(0, Math.min(1, (voice.level - min) / (max - min)));
        fill.style.width = `${frac * 100}%`;
        fill.classList.toggle('hot', voice.level >= voice.threshold);
      } else {
        fill.style.width = '0%';
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
    $('ab-mic').classList.toggle('live', on);
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

  // Themed subtitle bar for character speech (vendors, NPCs, enemies).
  showSubtitle(speaker, text, durationMs = 4200) {
    const el = $('subtitle');
    $('subtitle-speaker').textContent = speaker;
    $('subtitle-text').textContent = text;
    el.classList.remove('hidden');
    // the interact prompt sits in the same spot — hide it so they don't overlap
    $('interact-prompt').classList.add('hidden');
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    clearTimeout(this._subT);
    this._subT = setTimeout(() => el.classList.add('hidden'), durationMs);
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
        vStatus.textContent = 'Neural voices ready ✓';
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
    import('../ai/neuralVoice.js').then(({ neuralVoice }) => {
      if (neuralVoice.status === 'ready') {
        $('voice-engine-status').classList.remove('hidden');
        $('voice-engine-status').textContent = 'Neural voices ready ✓';
      } else if (neuralVoice.status === 'loading') {
        this.startNeuralVoices();
      } else if (neuralVoice.status === 'error') {
        this.startNeuralVoices();
      }
    });
  }

  setMicAvailable(on) {
    $('ab-mic').classList.toggle('hidden', !on);
  }

  showInteract(candidate) {
    const el = $('interact-prompt');
    if (!candidate) { el.classList.add('hidden'); return; }
    // while an NPC line (subtitle) is up, don't stack the prompt behind it
    if (!$('subtitle').classList.contains('hidden')) { el.classList.add('hidden'); return; }
    // key chip is hidden by CSS on coarse-pointer devices — tap the pill there
    el.innerHTML = `${candidate.icon} ${candidate.label} <span class="key-chip">F</span>`;
    el.classList.remove('hidden');
  }

  wireActionBar() {
    const g = this.game;
    $('interact-prompt').onclick = () => g.doInteract();
    // universal corner ✕ on every panel overlay (works without a keyboard)
    document.querySelectorAll('.overlay-close').forEach((btn) => {
      btn.onclick = () => { g.state = 'playing'; this.hideAll(); };
    });
    // collapse/expand the icon row; the ☰ toggle keeps its fixed anchor
    const bar = $('action-bar');
    if (window.innerWidth < 1100) bar.classList.add('collapsed');
    const syncToggle = () => {
      $('ab-toggle').textContent = bar.classList.contains('collapsed') ? '☰' : '✕';
    };
    syncToggle();
    $('ab-toggle').onclick = () => { bar.classList.toggle('collapsed'); syncToggle(); };
    $('ab-inv').onclick = () => g.toggleInventory();
    $('ab-quests').onclick = () => { if (g.state === 'playing') g.toggleQuestLog(); };
    $('ab-skills').onclick = () => { if (g.state === 'playing') g.toggleSkills(); };
    $('ab-potion').onclick = () => { if (g.state === 'playing') g.player?.drinkPotion(g); };
    $('ab-pause').onclick = () => g.togglePause(true);
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
    $('set-shake').checked = s.screenShake;
  }

  // ---------- hotbar ----------
  // Slots render through player.abilityOrder (slot -> ability index) so a
  // re-slotted ability shows its own icon/name/cooldown in its new spot.
  buildHotbar(player) {
    const bar = $('hotbar');
    bar.innerHTML = '';
    this.hotbarSlots = [];
    this.radial = null;
    const order = player.abilityOrder || [0, 1, 2, 3];
    // On touch devices the abilities render as a quarter-pie radial wheel in the
    // bottom-right corner (built + updated separately); desktop keeps the row.
    if (matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window) {
      this.buildRadialHotbar(player, order);
      return;
    }
    order.forEach((abIndex, i) => {
      const ab = player.classDef.abilities[abIndex];
      const slot = document.createElement('div');
      slot.className = 'hotbar-slot ready';
      slot.innerHTML = `
        <span class="key">${i + 1}</span>
        <span class="ab-icon">${ab.icon}</span>
        <div class="cd-sweep"></div>
        <span class="ab-name">${ab.name}</span>
      `;
      slot.title = `${ab.name} (${ab.cost} ${player.classDef.resource.name}): ${ab.desc}`;
      bar.appendChild(slot);
      this.hotbarSlots.push(slot);
    });
    this.wireHotbarInput(player);
  }

  // SVG annular-sector path (a pie slice with a hole at the pivot), pivot fixed
  // at the bottom-right corner (100,100) of a 0..100 viewBox.
  _wedgePath(a1, a2, r0, r1) {
    const pt = (a, r) => [
      (100 + r * Math.cos((a * Math.PI) / 180)).toFixed(2),
      (100 + r * Math.sin((a * Math.PI) / 180)).toFixed(2),
    ];
    const [x1, y1] = pt(a1, r1), [x2, y2] = pt(a2, r1), [x3, y3] = pt(a2, r0), [x4, y4] = pt(a1, r0);
    return `M${x1} ${y1} A${r1} ${r1} 0 0 1 ${x2} ${y2} L${x3} ${y3} A${r0} ${r0} 0 0 0 ${x4} ${y4} Z`;
  }

  // Touch abilities: a quarter-pie wheel of four wedges (pineapple slices) in
  // the bottom-right corner, sweeping from the bottom edge (slot 1) up to the
  // right edge (slot 4) around the thumb pivot. Each wedge is a tap target that
  // casts its ability; cooldown drains a dark overlay across the slice.
  buildRadialHotbar(player, order) {
    const bar = $('hotbar');
    const NS = 'http://www.w3.org/2000/svg';
    const R0 = 36, R = 98, GAP = 3;
    const pt = (a, r) => [
      (100 + r * Math.cos((a * Math.PI) / 180)).toFixed(2),
      (100 + r * Math.sin((a * Math.PI) / 180)).toFixed(2),
    ];
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('class', 'ability-wheel');
    this.radial = [];
    order.forEach((abIndex, i) => {
      const ab = player.classDef.abilities[abIndex];
      const base = 180 + i * 22.5;
      const a1 = base + GAP / 2, a2 = base + 22.5 - GAP / 2, mid = (a1 + a2) / 2;
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'wheel-slot ready');
      const wedge = document.createElementNS(NS, 'path');
      wedge.setAttribute('d', this._wedgePath(a1, a2, R0, R));
      wedge.setAttribute('class', 'wheel-wedge');
      const cd = document.createElementNS(NS, 'path');
      cd.setAttribute('class', 'wheel-cd');
      cd.setAttribute('d', '');
      const [ix, iy] = pt(mid, (R0 + R) / 2 + 3);
      const icon = document.createElementNS(NS, 'text');
      icon.setAttribute('x', ix); icon.setAttribute('y', iy);
      icon.setAttribute('class', 'wheel-icon');
      icon.setAttribute('text-anchor', 'middle');
      icon.setAttribute('dominant-baseline', 'central');
      icon.textContent = ab.icon;
      const [nx, ny] = pt(mid, R0 + 8);
      const num = document.createElementNS(NS, 'text');
      num.setAttribute('x', nx); num.setAttribute('y', ny);
      num.setAttribute('class', 'wheel-num');
      num.setAttribute('text-anchor', 'middle');
      num.setAttribute('dominant-baseline', 'central');
      num.textContent = i + 1;
      g.append(wedge, cd, icon, num);
      svg.appendChild(g);
      const fire = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (this.game.state === 'playing') this.game.player?.tryAbility(i, this.game);
      };
      g.addEventListener('pointerup', fire);
      this.radial.push({ i, g, wedge, cd, icon, a1, a2 });
    });
    bar.appendChild(svg);
  }

  updateRadialHotbar(player) {
    const order = player.abilityOrder || [0, 1, 2, 3];
    this.radial.forEach((s, i) => {
      const abIndex = order[i];
      const ab = player.classDef.abilities[abIndex];
      if (!ab) return;
      const cd = player.abilityCds[abIndex];
      const max = player.abilityCdMax?.[abIndex] || ab.cd;
      const onCd = cd > 0;
      const frac = onCd ? Math.max(0, Math.min(1, cd / max)) : 0;
      // dark overlay drains from the leading edge as the cooldown recovers
      s.cd.setAttribute('d', frac > 0 ? this._wedgePath(s.a1, s.a1 + (s.a2 - s.a1) * frac, 36, 98) : '');
      const canAfford = player.resource >= ab.cost;
      s.g.classList.toggle('cooling', onCd);
      s.g.classList.toggle('ready', !onCd && canAfford);
      s.g.classList.toggle('no-resource', !onCd && !canAfford);
      if (s.icon.textContent !== ab.icon) s.icon.textContent = ab.icon;
    });
  }

  // One pointer-based interaction path covers both mouse and touch: a quick
  // tap/click casts, a small mouse drag (or a touch long-press then drag)
  // picks a slot up and dropping it on another swaps the two. This avoids a
  // finger's natural jitter being mistaken for a drag on touch.
  wireHotbarInput(player) {
    const LONG_PRESS_MS = 450, DRAG_PX = 6;
    const clearHighlights = () => this.hotbarSlots.forEach((s) => s.classList.remove('drop-target'));
    const slotAt = (x, y) => {
      const el = document.elementFromPoint(x, y)?.closest('.hotbar-slot');
      return el ? this.hotbarSlots.indexOf(el) : -1;
    };
    this.hotbarSlots.forEach((slot, i) => {
      slot.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const isTouch = e.pointerType !== 'mouse';
        const drag = { fromSlot: i, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, dragging: false, isTouch };
        this._hotbarDrag = drag;
        if (isTouch) {
          drag.longPressTimer = setTimeout(() => {
            if (this._hotbarDrag === drag) { drag.dragging = true; slot.classList.add('dragging'); }
          }, LONG_PRESS_MS);
        }
      });
      slot.addEventListener('pointermove', (e) => {
        const drag = this._hotbarDrag;
        if (!drag || drag.pointerId !== e.pointerId) return;
        if (!drag.isTouch && !drag.dragging) {
          const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
          if (moved > DRAG_PX) { drag.dragging = true; slot.classList.add('dragging'); }
        }
        if (drag.dragging) {
          clearHighlights();
          const overIdx = slotAt(e.clientX, e.clientY);
          if (overIdx !== -1 && overIdx !== drag.fromSlot) this.hotbarSlots[overIdx].classList.add('drop-target');
        }
      });
      const finish = (e) => {
        const drag = this._hotbarDrag;
        if (!drag || drag.pointerId !== e.pointerId) return;
        clearTimeout(drag.longPressTimer);
        slot.classList.remove('dragging');
        clearHighlights();
        this._hotbarDrag = null;
        if (drag.dragging) {
          const toSlot = slotAt(e.clientX, e.clientY);
          if (toSlot !== -1 && toSlot !== drag.fromSlot) {
            this.game.player?.swapAbilitySlots(drag.fromSlot, toSlot);
            this.buildHotbar(this.game.player);
            this.game.requestSave();
          }
        } else if (this.game.state === 'playing') {
          this.game.player?.tryAbility(drag.fromSlot, this.game);
        }
      };
      slot.addEventListener('pointerup', finish);
      slot.addEventListener('pointercancel', () => {
        const drag = this._hotbarDrag;
        if (drag) clearTimeout(drag.longPressTimer);
        this._hotbarDrag = null;
        slot.classList.remove('dragging');
        clearHighlights();
      });
    });
  }

  flashNoResource(slot) {
    const el = this.radial ? this.radial[slot]?.g : this.hotbarSlots[slot];
    if (!el) return;
    el.classList.add('no-resource');
    setTimeout(() => el.classList.remove('no-resource'), 300);
  }

  // ---------- HUD update ----------
  updateHud(player, floor, boss) {
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
    $('hud-potions').textContent = `${player.potions} 🧪`;
    // potion buttons only matter when you're actually hurt
    const needPotion = player.hp < player.maxHp - 1 && player.potions > 0;
    $('touch-potion')?.classList.toggle('hidden', !needPotion);
    $('ab-potion')?.classList.toggle('hidden', !needPotion);
    // multiplayer: show how many heroes share the room (works in both orientations)
    const playersEl = $('hud-players');
    const count = this.game.roomPlayerCount();
    if (count > 0) {
      playersEl.classList.remove('hidden');
      playersEl.textContent = `Online (${count})`;
      playersEl.title = `${count} heroes in this room`;
    } else {
      playersEl.classList.add('hidden');
    }
    $('hud-floor').textContent = this.game.floorLabelText();

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
      clearEl.textContent = parts.length ? `🔒 ${parts.join(' · ')} to open the stairs` : '🔒 clear the floor';
      clearEl.className = 'sealed';
    } else {
      clearEl.textContent = '🔓 Stairs open, descend when ready';
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
      cl.innerHTML = `⛔ CHEATING DETECTED<div class="cl-sub">Frozen — ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}</div>`;
    } else if (!cl.classList.contains('hidden')) {
      cl.classList.add('hidden');
    }

    if (this.radial) { this.updateRadialHotbar(player); }
    else {
    const abilityOrder = player.abilityOrder || [0, 1, 2, 3];
    abilityOrder.forEach((abIndex, i) => {
      const ab = player.classDef.abilities[abIndex];
      const slot = this.hotbarSlots[i];
      if (!ab || !slot) return;
      const cd = player.abilityCds[abIndex];
      const max = player.abilityCdMax?.[abIndex] || ab.cd;
      const sweep = slot.querySelector('.cd-sweep');
      const onCd = cd > 0;
      // radial clock wheel: dark wedge = remaining cooldown, driven by the
      // ACTUAL cooldown duration so it empties exactly when the ability is usable
      const frac = onCd ? Math.max(0, Math.min(1, cd / max)) : 0;
      sweep.style.setProperty('--cd-ang', `${frac * 360}deg`);
      const canAfford = player.resource >= ab.cost;
      slot.classList.toggle('cooling', onCd);
      slot.classList.toggle('ready', !onCd && canAfford);
      // off cooldown but not enough resource → stays visibly gated, so a
      // full-colour button is never secretly uncastable
      slot.classList.toggle('no-resource', !onCd && !canAfford);
    });
    }

    const bossWrap = $('boss-bar-wrap');
    if (boss && !boss.dead) {
      bossWrap.classList.remove('hidden');
      $('boss-name').textContent = boss.name;
      $('boss-bar').style.width = `${(boss.hp / boss.maxHp) * 100}%`;
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
    $('buy-icon').textContent = entry.icon;
    const name = $('buy-name'); name.textContent = entry.label; name.className = `tt-${rarity}`;
    $('buy-rarity').textContent = item ? `${R.name} ${item.slot}` : (entry.kind === 'elixir' ? `${R.name} elixir` : '');
    let detail = '';
    if (item) detail = Object.entries(item.stats || {}).map(([k, v]) => `<span class="tt-stat">${statLabel(k, v)}</span>`).join(' · ');
    else if (entry.kind === 'elixir') detail = `<span class="tt-stat">${entry.elixir.label}</span>`;
    else if (entry.kind === 'potion') detail = 'Restores 45% health';
    else if (entry.kind === 'bag') detail = '+3 inventory slots, forever';
    else if (entry.kind === 'gamble') detail = 'Common… or Super Rare. Fate decides.';
    $('buy-stats').innerHTML = detail;
    // for gear, show how it compares to what's worn
    $('buy-compare').innerHTML = item ? (this.affinityNote(item) + this.compareNote(item)) : '';
    $('buy-price').innerHTML = `<span class="coin-stack"><span class="coin"></span><span class="coin c2"></span></span> ${entry.price}g`;
    $('buy-card').style.setProperty('--relic-glow', `#${R.color.toString(16).padStart(6, '0')}`);
    const buyBtn = $('btn-buy-confirm');
    const broke = p.gold < entry.price;
    buyBtn.disabled = broke;
    buyBtn.textContent = broke ? 'Not enough gold' : 'Buy';
    // mystery relics rest between draws — tell the player how long
    if (entry.kind === 'gamble') {
      const left = Math.ceil(((this.game._gambleReadyAt || 0) - performance.now()) / 1000);
      if (left > 0) { buyBtn.disabled = true; buyBtn.textContent = `Fate rests (${left}s)`; }
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
    for (const slot of ['weapon', 'helmet', 'chest', 'legs', 'hands', 'trinket']) {
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
    toast.innerHTML = `LEVEL ${level}!<div class="toast-sub">+1 mastery point (K) · fully restored</div>`;
    toast.style.animation = 'none';
    void toast.offsetWidth; // restart animation
    toast.style.animation = '';
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => toast.classList.add('hidden'), 2300);
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
    audio.play('ui_open');
  }
  closeInventory() {
    this.hideAll();
    audio.play('ui_close');
  }

  renderInventory() {
    const p = this.game.player;
    const equipWrap = $('equip-slots');
    equipWrap.innerHTML = '';
    for (const slotName of ['weapon', 'helmet', 'chest', 'legs', 'hands', 'trinket']) {
      const item = p.equipped[slotName];
      const el = document.createElement('div');
      const offClass = item && item.affinity && item.affinity !== p.classId;
      el.className = `inv-slot equip ${item ? 'rarity-' + item.rarity : ''} ${offClass ? 'off-class' : ''}`;
      const eqIcon = item ? (item.slot ? `<img class="inv-item-icon" src="${makeItemIcon(item)}" alt="">` : item.icon) : '·';
      el.innerHTML = `${eqIcon}<span class="slot-label">${slotName}</span>`;
      if (item) {
        el.onmouseenter = (e) => this.showTooltip(item, e, true);
        el.onmouseleave = () => this.hideTooltip();
        // stats panel first; unequipping is a button on that panel
        el.onclick = () => this.selectItem(item, slotName);
      }
      equipWrap.appendChild(el);
    }

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
        el.onmouseenter = (e) => this.showTooltip(item, e);
        el.onmouseleave = () => this.hideTooltip();
        const toggleMark = () => {
          this.destroySel.has(item) ? this.destroySel.delete(item) : this.destroySel.add(item);
          this.renderInventory();
        };
        // ctrl/cmd/shift-click marks for bulk destruction; plain click = stats
        el.onclick = (e) => {
          if (this._suppressClick) { this._suppressClick = false; return; }
          if (e.ctrlKey || e.metaKey || e.shiftKey) toggleMark();
          else this.selectItem(item);
        };
        // touch: press-and-hold marks the item instead
        el.onpointerdown = (e) => {
          if (e.pointerType !== 'touch') return;
          this._holdT = setTimeout(() => { this._suppressClick = true; toggleMark(); }, 450);
        };
        el.onpointerup = el.onpointerleave = () => clearTimeout(this._holdT);
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
    db.textContent = `🗑 Destroy ${this.destroySel.size} items`;
    db.style.display = this.destroySel.size >= 2 ? '' : 'none';
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
      return `<div style="font-size:11px;margin-top:2px;color:${ok ? '#7ce87c' : '#e86a6a'}">${ok ? '★ Your class' : '⛔ ' + this.className(item.forClass) + ' only'}</div>`;
    }
    if (item.affinity) {
      const ok = item.affinity === cls;
      return `<div style="font-size:11px;margin-top:2px;color:${ok ? '#7ce87c' : '#e8a85a'}">${ok ? '★ Attuned to your class' : '½ stats · attuned to ' + this.className(item.affinity)}</div>`;
    }
    return '';
  }

  statName(k) {
    return ({ damagePct: 'damage', maxHp: 'max HP', armor: 'armor', crit: 'crit', speed: 'move speed', regen: 'regen', cdr4: 'ult cooldown' })[k] || k;
  }

  // Split a stat into a bold value and a readable name, for the two-column
  // stat list in the item panel (value on the left, label on the right).
  statParts(k, v) {
    const pct = k === 'damagePct' || k === 'armor' || k === 'crit' || k === 'speed' || k === 'cdr4';
    const name = ({ damagePct: 'Damage', maxHp: 'Max Health', armor: 'Armor', crit: 'Crit Chance', speed: 'Move Speed', regen: 'Resource Regen', cdr4: 'Ult Cooldown' })[k] || k;
    const sign = k === 'cdr4' ? '-' : '+';
    return { val: `${sign}${v}${pct ? '%' : ''}`, name };
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
    const W = { maxHp: 0.15, armor: 1, crit: 1.5, speed: 1, regen: 0.8, damagePct: 1.2, cdr4: 1 };
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
