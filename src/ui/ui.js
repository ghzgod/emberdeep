import { CLASSES } from '../entities/classes.js';
import { RARITIES, statLabel, sellValue, buyPrice } from '../entities/loot.js';
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
    this.wireSettings();
    this.buildClassCards();
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
    $('btn-mp-enter').onclick = async () => {
      const name = $('mp-name').value.trim().slice(0, 14);
      if (name) localStorage.setItem('emberdeep-name-v1', name);
      const room = $('mp-room').value.trim() || 'EMBER';
      $('mp-status').textContent = 'Connecting to room…';
      const result = await this.game.startMultiplayer(room);
      if (result.mode === 'error') {
        $('mp-status').textContent = `Connection failed (${result.error}). Try again.`;
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
    $('btn-new-character').onclick = () => {
      if (!SaveManager.canCreate()) {
        $('saves-list').firstChild?.scrollIntoView();
        alert('Save limit reached (8). Delete a hero first.');
        return;
      }
      this.resetClassSelect();
      this.show('charselect');
    };
    $('btn-charselect-back').onclick = () => { this.renderSaves(); this.show('saves'); };
    $('btn-shop-close').onclick = () => this.game.closeShop();
    $('btn-shop-restock').onclick = () => {
      if (this.game.activeVendor) this.game.restockVendor(this.game.activeVendor);
    };
    $('btn-title-settings').onclick = () => { this.settingsReturnTo = 'title'; this.show('settings'); };
    $('btn-pause-settings').onclick = () => { this.settingsReturnTo = 'pause'; this.show('settings'); };
    $('btn-settings-back').onclick = () => {
      if (this.settingsReturnTo === 'pause') this.show('pause');
      else this.show('title');
    };
    $('btn-resume').onclick = () => this.game.togglePause(false);
    $('btn-pause-quests').onclick = () => { this.game.state = 'quest'; this.openQuestLog(); };
    $('btn-quest-close').onclick = () => { this.game.state = 'playing'; this.hideAll(); };
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
    $('btn-charselect-confirm').onclick = () => {
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
      row.querySelector('.save-del').onclick = (e) => {
        e.stopPropagation();
        if (confirm(`Delete this ${cls ? cls.name : 'hero'} forever?`)) {
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
      .map(([k, v]) => `<span class="qs-item"><b>${k}:</b> ${v}</span>`).join('');
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
    $('shop-title').textContent = vendor.name;
    $('shop-gold').textContent = `Your gold: ${p.gold} 🪙`;
    const fee = this.game.restockFee(vendor);
    $('btn-shop-restock').textContent = `Restock (${fee}g)`;
    $('btn-shop-restock').disabled = p.gold < fee;

    const buyWrap = $('shop-buy-list');
    buyWrap.innerHTML = '';
    for (const entry of vendor.stock) {
      const el = document.createElement('div');
      const afford = p.gold >= entry.price && !entry.sold;
      el.className = `shop-item ${entry.item ? 'r-' + entry.item.rarity : ''} ${afford ? '' : 'disabled'}`;
      el.innerHTML = `
        <span>${entry.icon}</span>
        <span class="shop-item-name">${entry.sold ? '(sold) ' : ''}${entry.label}</span>
        <span class="shop-item-price">${entry.price}g</span>
      `;
      if (afford) {
        el.onclick = () => { this.game.buyFromVendor(vendor, entry); this.renderShop(vendor); };
      }
      buyWrap.appendChild(el);
    }

    const sellWrap = $('shop-sell-list');
    sellWrap.innerHTML = '';
    if (!p.inventory.length) {
      sellWrap.innerHTML = '<div class="shop-empty">Nothing to sell.</div>';
    }
    for (const item of [...p.inventory]) {
      const el = document.createElement('div');
      el.className = `shop-item r-${item.rarity}`;
      el.innerHTML = `
        <span>${item.icon}</span>
        <span class="shop-item-name">${item.name}</span>
        <span class="shop-item-price">+${sellValue(item)}g</span>
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

    // voice chat
    const vSel = $('set-voice');
    const vRow = $('voice-thresh-row');
    const vMeterRow = $('voice-meter-row');
    const vThresh = $('set-voice-thresh');
    const vVal = $('set-voice-thresh-val');
    const syncVoiceRows = () => {
      vRow.classList.toggle('hidden', s.voiceMode !== 'auto');
      vMeterRow.classList.toggle('hidden', s.voiceMode === 'off');
      $('touch-mic').classList.toggle('hidden', s.voiceMode !== 'ptt');
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
      if (s.voiceMode === 'off') voice.disable();
      else if (net.active) {
        const ok = await voice.enable(s.voiceMode, s.voiceThreshold);
        if (!ok) { vSel.value = 'off'; s.voiceMode = 'off'; syncVoiceRows(); alert('Microphone unavailable or permission denied.'); }
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
    // live mic level meter while settings open
    setInterval(async () => {
      if (!this.screens.settings.classList.contains('visible')) return;
      const { voice } = await import('../net/voice.js');
      const meter = $('voice-meter');
      if (voice.active) {
        meter.style.width = `${voice.level}%`;
        meter.classList.toggle('hot', voice.level >= voice.threshold);
      } else {
        meter.style.width = '0%';
      }
    }, 120);
  }

  setMicIndicator(on) {
    $('voice-indicator').classList.toggle('hidden', !on);
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
  buildHotbar(player) {
    const bar = $('hotbar');
    bar.innerHTML = '';
    this.hotbarSlots = [];
    player.classDef.abilities.forEach((ab, i) => {
      const slot = document.createElement('div');
      slot.className = 'hotbar-slot ready';
      slot.innerHTML = `
        <span class="key">${i + 1}</span>
        <span class="ab-icon">${ab.icon}</span>
        <div class="cd-sweep"></div>
        <span class="ab-name">${ab.name}</span>
      `;
      slot.title = `${ab.name} (${ab.cost} ${player.classDef.resource.name}) — ${ab.desc}`;
      bar.appendChild(slot);
      this.hotbarSlots.push(slot);
    });
  }

  flashNoResource(index) {
    const slot = this.hotbarSlots[index];
    if (!slot) return;
    slot.classList.add('no-resource');
    setTimeout(() => slot.classList.remove('no-resource'), 300);
  }

  // ---------- HUD update ----------
  updateHud(player, floor, boss) {
    $('hp-bar').style.width = `${(player.hp / player.maxHp) * 100}%`;
    $('hp-text').textContent = `${Math.ceil(player.hp)} / ${player.maxHp}`;
    $('resource-bar').style.width = `${(player.resource / player.maxResource) * 100}%`;
    $('resource-text').textContent = `${Math.floor(player.resource)} ${player.classDef.resource.name}`;
    const { xpForLevel } = this.game.playerModule;
    const need = xpForLevel(player.level);
    $('xp-bar').style.width = `${(player.xp / need) * 100}%`;
    $('xp-text').textContent = '';
    $('hud-level').textContent = `Lv ${player.level}`;
    $('hud-gold').textContent = `${player.gold} 🪙`;
    $('hud-potions').textContent = `${player.potions} 🧪`;
    // multiplayer: show how many heroes share the room (works in both orientations)
    const playersEl = $('hud-players');
    const count = this.game.roomPlayerCount();
    if (count > 0) {
      playersEl.classList.remove('hidden');
      playersEl.textContent = `${count} 👥`;
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
      const eliteLeft = this.game.enemies.some((e) => !e.dead && e.elite);
      clearEl.textContent = `🔒 ${this.game.floorKills}/${this.game.stairsClearNeed()} culled${eliteLeft ? ' · Elite alive' : ''}`;
      clearEl.className = 'sealed';
    } else {
      clearEl.textContent = '🔓 Stairs open';
      clearEl.className = 'open';
    }
    $('hud-quest').textContent = this.game.currentObjectiveText();

    player.classDef.abilities.forEach((ab, i) => {
      const slot = this.hotbarSlots[i];
      if (!slot) return;
      const cd = player.abilityCds[i];
      const sweep = slot.querySelector('.cd-sweep');
      if (cd > 0) {
        sweep.style.transform = `scaleY(${cd / ab.cd})`;
        slot.classList.remove('ready');
      } else {
        sweep.style.transform = 'scaleY(0)';
        slot.classList.toggle('ready', player.resource >= ab.cost);
      }
    });

    const bossWrap = $('boss-bar-wrap');
    if (boss && !boss.dead) {
      bossWrap.classList.remove('hidden');
      $('boss-name').textContent = boss.name;
      $('boss-bar').style.width = `${(boss.hp / boss.maxHp) * 100}%`;
    } else {
      bossWrap.classList.add('hidden');
    }
  }

  // ---------- toasts/banners ----------
  showLevelUp(level) {
    const toast = $('levelup-toast');
    toast.classList.remove('hidden');
    toast.innerHTML = `LEVEL ${level}!<div class="toast-sub">You feel stronger. Fully restored.</div>`;
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
    for (const slotName of ['weapon', 'armor', 'trinket']) {
      const item = p.equipped[slotName];
      const el = document.createElement('div');
      el.className = `inv-slot equip ${item ? 'rarity-' + item.rarity : ''}`;
      el.innerHTML = `${item ? item.icon : '·'}<span class="slot-label">${slotName}</span>`;
      if (item) {
        el.onmouseenter = (e) => this.showTooltip(item, e);
        el.onmouseleave = () => this.hideTooltip();
        el.onclick = () => { this.game.unequip(slotName); this.renderInventory(); };
      }
      equipWrap.appendChild(el);
    }

    const grid = $('inv-grid');
    grid.innerHTML = '';
    for (let i = 0; i < p.invSize; i++) {
      const item = p.inventory[i];
      const el = document.createElement('div');
      el.className = `inv-slot ${item ? 'rarity-' + item.rarity : ''}`;
      el.textContent = item ? item.icon : '';
      if (item) {
        el.onmouseenter = (e) => this.showTooltip(item, e);
        el.onmouseleave = () => this.hideTooltip();
        el.onclick = () => this.selectItem(item);
        el.oncontextmenu = (e) => {
          e.preventDefault();
          this.game.dropItem(item);
          this.renderInventory();
          this.hideTooltip();
        };
      }
      grid.appendChild(el);
    }
    if (!this.selectedItem || !p.inventory.includes(this.selectedItem)) {
      this.selectedItem = null;
      $('item-actions').classList.add('hidden');
    }
  }

  // Tap/click an item -> action panel (works on mobile where right-click doesn't exist).
  selectItem(item) {
    this.selectedItem = item;
    const panel = $('item-actions');
    panel.classList.remove('hidden');
    const stats = Object.entries(item.stats)
      .map(([k, v]) => `<span class="tt-stat">${statLabel(k, v)}</span>`).join(' · ');
    $('item-actions-info').innerHTML =
      `<h4 class="tt-${item.rarity}" style="display:inline">${item.icon} ${item.name}</h4><br>${stats}`;
    $('btn-item-equip').onclick = () => { this.game.equip(item); this.renderInventory(); };
    const sellBtn = $('btn-item-sell');
    if (this.game.inTown) {
      sellBtn.disabled = false;
      sellBtn.textContent = `Sell +${sellValue(item)}g`;
      sellBtn.onclick = () => { this.game.sellItem(item); this.renderInventory(); };
    } else {
      sellBtn.disabled = true;
      sellBtn.textContent = 'Sell (in town)';
      sellBtn.onclick = null;
    }
    $('btn-item-drop').onclick = () => { this.game.dropItem(item); this.renderInventory(); };
  }

  showTooltip(item, e) {
    const tt = $('item-tooltip');
    tt.classList.remove('hidden');
    const stats = Object.entries(item.stats)
      .map(([k, v]) => `<div class="tt-stat">${statLabel(k, v)}</div>`).join('');
    tt.innerHTML = `
      <h4 class="tt-${item.rarity}">${item.icon} ${item.name}</h4>
      <div style="opacity:0.6;font-size:11px;">${RARITIES[item.rarity].name} ${item.slot}</div>
      ${stats}
      <div style="opacity:0.5;font-size:11px;margin-top:6px;">Click to equip · Right-click to drop</div>
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
