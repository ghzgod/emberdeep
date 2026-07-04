import { CLASSES } from '../entities/classes.js';
import { RARITIES, statLabel } from '../entities/loot.js';
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
      charselect: $('charselect-screen'),
      pause: $('pause-screen'),
      settings: $('settings-screen'),
      inventory: $('inventory-screen'),
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

  showTitle(hasSave) {
    this.show('title');
    this.showHud(false);
    $('btn-continue').classList.toggle('hidden', !hasSave);
  }

  // ---------- menu wiring ----------
  wireMenus() {
    $('btn-new-game').onclick = () => { this.show('charselect'); };
    $('btn-continue').onclick = () => this.game.continueGame();
    $('btn-charselect-back').onclick = () => this.show('title');
    $('btn-title-settings').onclick = () => { this.settingsReturnTo = 'title'; this.show('settings'); };
    $('btn-pause-settings').onclick = () => { this.settingsReturnTo = 'pause'; this.show('settings'); };
    $('btn-settings-back').onclick = () => {
      if (this.settingsReturnTo === 'pause') this.show('pause');
      else this.show('title');
    };
    $('btn-resume').onclick = () => this.game.togglePause(false);
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
        this.game.startNewGame(cls.id);
      };
      card.addEventListener('mouseenter', () => audio.play('ui_hover', { volume: 0.4, throttleMs: 40 }));
      wrap.appendChild(card);
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
    $('hud-floor').textContent = floor >= 10 ? '☠️ Floor 10' : `Floor ${floor}`;

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

  showFloorBanner(floor, themeName) {
    const b = $('floor-banner');
    b.classList.remove('hidden');
    b.innerHTML = `${floor >= 10 ? 'THE FINAL DEPTH' : `FLOOR ${floor}`}<div class="banner-sub">${themeName}</div>`;
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
    for (let i = 0; i < 12; i++) {
      const item = p.inventory[i];
      const el = document.createElement('div');
      el.className = `inv-slot ${item ? 'rarity-' + item.rarity : ''}`;
      el.textContent = item ? item.icon : '';
      if (item) {
        el.onmouseenter = (e) => this.showTooltip(item, e);
        el.onmouseleave = () => this.hideTooltip();
        el.onclick = () => { this.game.equip(item); this.renderInventory(); };
        el.oncontextmenu = (e) => {
          e.preventDefault();
          this.game.dropItem(item);
          this.renderInventory();
          this.hideTooltip();
        };
      }
      grid.appendChild(el);
    }
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
