# EMBERDEEP

*Descend. Fight. Survive.*

A 3D action dungeon crawler that runs entirely in the browser — Three.js, HTML and CSS. Descend ten procedurally generated floors of torch-lit dungeon, level a persistent hero, and slay the Dungeon Lord — alone or in up to 4-player online co-op.

## Play

```bash
npm install
npm run dev
```

Then open the printed local URL. Works on desktop (WASD + mouse, 1–4 abilities, R potion, Q/E rotate, Tab inventory) and mobile (virtual joystick + touch aim, tappable hotbar).

From the title screen pick **Single Player** or **Multiplayer** (enter a shared room name — the first player in becomes host and friends join their world), then choose one of up to 8 hero save slots. Every session starts in the town of Embervale: browse the vendors (tap an inventory item for Equip / Sell / Drop), then step through the dungeon portal to resume at your checkpoint floor.

## Features

- **3 classes** — Knight, Mage, Ranger — each with 4 unique abilities, chosen on a character-select screen
- **Multiplayer co-op** — up to 4 players via PeerJS/WebRTC (public PeerJS broker): the host is authoritative for enemies and the world, enemy HP/damage scale with player count, loot drops are personal (everyone rolls their own, everyone gets full XP), and single player stays fully isolated
- **Hometown hub — Embervale** — a safe town where every session starts: Maribel the Alchemist (potions, occasionally a Traveler's Satchel), Torvald the Smith (gear), and Zoltan the Mysterious (gamble 150g + 30/floor on a Mystery Relic — 50% common, 30% rare, 15% epic, 5% LEGENDARY uniques like "Doomblade Vharkûl" and "The Emberdeep Heart"); sell anything to any vendor; dying returns you to town (checkpoint kept, 20% gold lost)
- **8 hero save slots** — a slot list with class/level/floor/last-played, delete and resume; the old single save auto-migrates
- **Procedural dungeons** — rooms, corridors, doors, chests, torches; themes darken as you descend; floor 10 is a boss arena
- **Living environments** — scuff/scorch decals, rubble piles, flying bricks and debris when projectiles hit walls, and pit holes (floor 2+) that drop you to the next floor with damage in single player (damage only in multiplayer)
- **Multi-phase final boss** plus minibosses, 4 enemy archetypes, and endless scaling floors after victory
- **Punchy combat feedback** — status-colored hit sparks on every hit, bigger crit bursts with screen shake, projectile impact sparks, and a red burst when you take damage
- **Persistent progression** — XP, levels, rarity-tiered gear (common → rare → epic → legendary), inventory, gold; auto-saved in the browser
- **Expandable inventory** — 12 slots growable to 24 via very rare Bag drops (~1.2% enemies, 8% minibosses, 50% boss, 3% chests, sometimes sold by the alchemist); a tap-to-act item panel (Equip / Sell in town / Drop) keeps item management mobile-friendly
- **Enemies that learn** — a TensorFlow.js neural net trains on *your* movement during play (CPU backend) and now persists across sessions via localStorage, so enemies keep learning between visits; ranged enemies lead their shots and melee enemies cut off your escape
- **60 context-mapped sounds** and two music tracks (all CC0/CC-BY sources — see [CREDITS.md](CREDITS.md))
- **Animated heroes** from the CC0 KayKit Adventurers pack; everything else is generated in-engine

## Technology

[Three.js](https://threejs.org) rendering, [TensorFlow.js](https://www.tensorflow.org/js) enemy learning, [PeerJS](https://peerjs.com) multiplayer networking (WebRTC), and [Vite](https://vitejs.dev) build tooling.

## Build

```bash
npm run build   # static site in dist/, relative paths — host anywhere
```
