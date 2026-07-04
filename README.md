# EMBERDEEP

*Descend. Fight. Survive.*

A 3D action dungeon crawler that runs entirely in the browser — Three.js, HTML and CSS. Descend ten procedurally generated floors of torch-lit dungeon, level a persistent hero, and slay the Dungeon Lord.

## Play

```bash
npm install
npm run dev
```

Then open the printed local URL. Works on desktop (WASD + mouse, 1–4 abilities, Q potion, Tab inventory) and mobile (virtual joystick + touch aim, tappable hotbar).

## Features

- **3 classes** — Knight, Mage, Ranger — each with 4 unique abilities, chosen on a character-select screen
- **Procedural dungeons** — rooms, corridors, doors, chests, torches; themes darken as you descend; floor 10 is a boss arena
- **Multi-phase final boss** plus minibosses, 4 enemy archetypes, and endless scaling floors after victory
- **Persistent progression** — XP, levels, rarity-tiered gear, inventory, gold; auto-saved in the browser
- **Enemies that learn** — a TensorFlow.js neural net trains on *your* movement during play; ranged enemies lead their shots and melee enemies cut off your escape
- **60 context-mapped sounds** and two music tracks (all CC0/CC-BY sources — see [CREDITS.md](CREDITS.md))
- **Animated heroes** from the CC0 KayKit Adventurers pack; everything else is generated in-engine

## Build

```bash
npm run build   # static site in dist/, relative paths — host anywhere
```
