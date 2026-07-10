# Audio Credits

All sounds were sourced from OpenGameArt.org and converted to MP3 for the game.

| Pack | Author | License | Used for |
|---|---|---|---|
| [RPG Sound Pack](https://opengameart.org/content/rpg-sound-pack) | artisticdude | CC0 | Sword swings, imp/golem/boss voices (monster, giant, ogre), skeleton moans (shade), spider bites (beetle), coins, bottle, potion glug, armor/chainmail, interface blips |
| [50 RPG Sound Effects](https://opengameart.org/content/50-rpg-sound-effects) | Kenney (kenney.nl) | CC0 | Footsteps, door open, chest latch/creak, knife-slice hits, arrow thunk, book open/close (UI), cloth hits |
| [Spell Sounds Starter Pack](https://opengameart.org/content/spell-sounds-starter-pack) | p0ss | CC-BY-SA 3.0 | Fireball, explosions, frost nova, blink/teleport, arcane storm zaps, charge/war-cry pulses, whirlwind, magic shield, poison cloud, magic bolts, floor-warp, player death sting, spider death |
| [Battle Sound Effects](https://opengameart.org/content/battle-sound-effects) | artisticdude (via Ogrebane) | CC0 | Bow shots, multishot, dodge roll, rain of arrows swishes |
| [Level Up Sound Effects](https://opengameart.org/content/level-up-sound-effects) | Bart Kelsey (commissioned by Will Corwin for OpenGameArt.org) | CC-BY 3.0 | Level-up fanfare (orchestra) |
| [Dungeon Ambience](https://opengameart.org/content/dungeon-ambience) | yd | CC0 | Generic dungeon music (fallback if an act track fails to load) |
| [Boss Battle Theme](https://opengameart.org/content/boss-battle-theme) | Cleyton Kauffman (soundcloud.com/cleytonkauffman) | CC0 | Generic boss music (fallback if an act-lord track fails to load) |
| [Dungeon Deep](https://opengameart.org/content/dungeon-deep-0) | Eldritch Grim | CC0 | Act I exploration music (The Old Halls), `music_act1.mp3` |
| [Deep Humidity](https://opengameart.org/content/deep-humidity) | TinyWorlds | CC0 | Act II exploration music (The Rotting Depths), `music_act2.mp3` |
| [Ambience of a Fallen Age](https://opengameart.org/content/ambience-of-a-fallen-age) | Umplix | CC0 | "Entering the Volcano" = Act III exploration music (The Ember Vaults), `music_act3.mp3`; "The Abyss" = Act V exploration music (The Abyssal Throne), `music_act5.mp3` |
| [Cursed Light](https://opengameart.org/content/cursed-light) | Cethiel | CC0 | Act IV exploration music (The Sunless Court), `music_act4.mp3` |
| [Boss Fight](https://opengameart.org/content/boss-fight-0) | Lisboa | CC0 | Gravewarden Malruk battle music (Act I lord), `music_boss1.mp3` |
| [Boss Battle #6 Metal](https://opengameart.org/content/boss-battle-6-metal) | nene | CC0 | Broodqueen Sszarra battle music (Act II lord, V1 mix), `music_boss2.mp3` |
| [JRPG Epic Rock Battle Theme #1](https://opengameart.org/content/jrpg-epic-rock-battle-theme-1) | HydroGene | CC0 | Pyrarch Vexmal battle music (Act III lord, loop version), `music_boss3.mp3` |
| [Final Stand](https://opengameart.org/content/final-stand-0) | Centurion_of_war | CC0 | The Obsidian Colossus battle music (Act IV lord, "phase 4.1 final max" mix), `music_boss4.mp3` |
| [Boss Battle Music](https://opengameart.org/content/boss-battle-music) | Juhani Junkala (SubspaceAudio) | CC0 | The Dungeon Lord battle music (Act V, "Epic Boss Battle [Seamlessly Looping]"), `music_boss5.mp3` |
| [Male Grunt/Yelling Sounds](https://opengameart.org/content/male-gruntyelling-sounds) | HaelDB | CC0 | Charge grunt, player hurt/death vocals |
| [Battlecry](https://opengameart.org/content/battlecry) | spookymodem | CC-BY 3.0 | War Cry ("a deep warcry before charging into battle") |

Several ability sounds are layered mixes (ffmpeg) of the above: Whirlwind = triple sword swing + metal ring, Charge = swish + chainmail + grunt, Multishot = triple bow at varied pitch, Rain of Arrows = bow + swish volley, Shield Block = armor + metal ring.

Per-act music tracks were re-encoded with ffmpeg to keep download weight low (mono 64 kbps for exploration beds, stereo 80 kbps for boss loops) and loudness-matched to the original soundtrack (about -20 LUFS exploration, -19 LUFS boss). "Entering the Volcano" and "The Abyss" were shortened to 100-second loops with a crossfaded seam.

# Model Credits

| Pack | Author | License | Used for |
|---|---|---|---|
| [KayKit Character Pack: Adventurers](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0) | Kay Lousberg (kaylousberg.com) | CC0 | Animated hero models: Knight, Mage, Rogue (Ranger) with idle/run/attack/death animations |
| [KayKit Dungeon Remastered](https://github.com/KayKit-Game-Assets/KayKit-Dungeon-Remastered-1.0) | Kay Lousberg (kaylousberg.com) | CC0 | Dungeon floor tiles (intact/rocky/broken), wall segments (intact/cracked/broken), pillar, door archway, mounted torch, rubble/debris piles, iron floor grate (`public/models/dungeon/`); instanced per grid cell with random variant + rotation, tinted per-act. The floor grate (`floor_tile_big_grate.gltf.glb`) doubles as the descend-stairs hatch lid (procedural box lid is the load-failure fallback); the door archway (`wall_doorway.glb`, frame + door leaf) also dresses the Emberville Tavern's real entrance in town, scaled down to human-door height in front of the inn model's own undersized baked door |

Enemy models and textures are procedurally generated in-engine.

# Technology

- [Three.js](https://threejs.org) — rendering
- [TensorFlow.js](https://www.tensorflow.org/js) — in-browser enemy machine learning (movement prediction)
- [PeerJS](https://peerjs.com) — multiplayer networking (WebRTC peer-to-peer co-op via the public PeerJS broker)
- [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) via [kokoro-js](https://www.npmjs.com/package/kokoro-js) (Apache 2.0) — optional neural character voices, in-browser
- [Vite](https://vitejs.dev) — build tooling
