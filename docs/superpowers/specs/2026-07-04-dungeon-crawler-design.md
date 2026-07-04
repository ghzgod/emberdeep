# Joel's Dungeon — 3D Dungeon Crawler Design Spec

Date: 2026-07-04

## Vision
Third-person overhead 3D dungeon crawler in Three.js (HTML/CSS UI). Pick a class,
descend 10 procedurally generated floors, defeat the final boss. Real-time combat
with cooldown abilities, persistent leveling and loot saved in localStorage.
Full-featured: menus, minimap, inventory, sound, particles.

## Decisions (from brainstorm)
- Camera: third-person overhead follow camera (~55° pitch)
- Combat: real-time hack & slash + 4-ability hotbar per class
- Dungeons: procedurally generated (room-scatter + L-corridors on a tile grid)
- Progression: persistent leveling — XP, levels, gear persist across sessions
- Art: low-poly geometry + textures (canvas-procedural stone/brick/wood/moss)
- Scope: full-featured game from the start
- Classes: chosen on a character-select screen shown at New Game
- Structure: descend 10 floors → final boss → victory
- Audio: real CC0 sound assets downloaded online; many context-appropriate sounds
- Tech: Vite + npm three, vanilla JS ES modules, no framework

## Classes
- Knight — sword melee. Charge, Whirlwind, Shield Block, War Cry. Resource: stamina.
- Mage — staff bolts. Fireball, Frost Nova, Blink, Arcane Storm. Resource: mana.
- Ranger — bow. Multishot, Dodge Roll, Poison Trap, Rain of Arrows. Resource: energy.

Controls: WASD move, mouse aim, LMB basic attack, 1–4 abilities, Tab/I inventory,
Esc pause, M minimap toggle.

## Enemies
Skeleton (melee), Imp (ranged fireballs), Spider (fast swarmer), Golem (slow tank),
per-floor miniboss variants (scaled + named), Floor-10 multi-phase boss.
AI: idle → aggro (proximity/LOS) → chase → attack. Stats scale with depth.
ML: TensorFlow.js movement-prediction model (CPU backend) trains on player
movement and persists across sessions via localStorage — enemies keep learning
between visits.

## World
- Grid ~48×48 tiles/floor; 8–14 rooms, L-corridors, spawn and stairs far apart.
- Merged/instanced meshes for floors/walls; torches (flicker point lights), doors,
  chests, stair mesh. Floor 10 = fixed boss arena layout.
- Fog-of-war canvas minimap revealed by exploration.

## Progression
- XP → levels → stat growth + ability upgrades.
- Loot: gold, potions (health/resource), gear (weapon/armor/trinket) with
  common/rare/epic/legendary rarity (legendary = orange tier); inventory + equip screen.
- Inventory: 12 slots, expandable to 24 via very rare Bag drops (~1.2% enemies,
  8% minibosses, 50% boss, 3% chests; occasionally sold by the alchemist).
  Item action panel: tap item → Equip / Sell (town only) / Drop — mobile-friendly.
- Save slots: up to 8 hero saves; list screen shows class/level/floor/last-played
  with delete + resume. Old single save auto-migrates to a slot.
- Auto-save at floor entrance + on changes. Death: return to town of Embervale,
  keep checkpoint floor, lose 20% carried gold. Victory screen with run stats.

## Town Hub — Embervale
Safe hometown where every session starts; a dungeon portal resumes at the
player's checkpoint floor. Vendors (any inventory item can be sold to any vendor):
- Maribel the Alchemist — potions; occasionally stocks a Traveler's Satchel (bag).
- Torvald the Smith — gear for sale.
- Zoltan the Mysterious — gambling: pay 150g + 30/floor for a Mystery Relic
  (50% common, 30% rare, 15% epic, 5% LEGENDARY uniques such as
  "Doomblade Vharkûl" and "The Emberdeep Heart").

## Multiplayer (Co-op)
- Up to 4 players via PeerJS/WebRTC using the public PeerJS broker.
- Title screen: Single Player and Multiplayer modes. Multiplayer joins a shared
  room name; the first player in becomes host — authoritative for enemies and
  world state — and later players join the host's world.
- Enemy HP/damage scale up with player count.
- Personal loot: each player rolls their own drops; everyone gets full XP.
- Single player is fully isolated from multiplayer code paths.

## Environment & Combat Feel
- Scuff/scorch decals, rubble piles; pit holes (floor 2+) drop the player to the
  next floor with damage in single player (damage only in multiplayer).
- Bricks/debris fly when projectiles hit walls.
- Hit sparks on every hit (status-colored), bigger crit bursts with screen shake,
  projectile impact sparks, red burst when the player is hit.

## Audio (per user goal: many real online sounds, contextually mapped)
CC0 packs (Kenney RPG audio, impact/UI packs; OpenGameArt music). Distinct sounds:
sword swings, bow shots, spell casts per element, per-enemy-type hurt/death,
player hurt/death, footsteps, chest open, coin pickup, potion drink, level-up,
door open, stairs descend, boss roar, UI hover/click, ambient dungeon music loop,
boss music. CREDITS.md records sources/licenses.

## Structure
```
index.html, style.css, package.json (vite, three)
src/main.js
src/core/     — loop, input, states, save, audio engine
src/world/    — textures, dungeon gen, mesh builder
src/entities/ — player, classes, enemies, projectiles, loot
src/combat/   — damage, abilities, status effects
src/ui/       — HUD, menus, character select, minimap, inventory
public/audio/ — downloaded CC0 sounds
```

## Verification
- Vite dev server + headless Playwright: no console errors; screenshots of title,
  character select, gameplay, HUD; simulated input walkthrough; save/continue check.
