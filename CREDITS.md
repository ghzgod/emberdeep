# Audio Credits

All sounds were sourced from OpenGameArt.org and converted to MP3 for the game.

| Pack | Author | License | Used for |
|---|---|---|---|
| [RPG Sound Pack](https://opengameart.org/content/rpg-sound-pack) | artisticdude | CC0 | Sword swings, imp/golem/boss voices (monster, giant, ogre), skeleton moans (shade), spider bites (beetle), coins, bottle, potion glug, armor/chainmail, interface blips |
| [50 RPG Sound Effects](https://opengameart.org/content/50-rpg-sound-effects) | Kenney (kenney.nl) | CC0 | Footsteps, door open, chest latch/creak, knife-slice hits, arrow thunk, book open/close (UI), cloth hits |
| [Spell Sounds Starter Pack](https://opengameart.org/content/spell-sounds-starter-pack) | p0ss | CC-BY-SA 3.0 | Fireball, explosions, frost nova, blink/teleport, arcane storm zaps, charge/war-cry pulses, whirlwind, magic shield, poison cloud, magic bolts, floor-warp, player death sting, spider death |
| [Battle Sound Effects](https://opengameart.org/content/battle-sound-effects) | artisticdude (via Ogrebane) | CC0 | Bow shots, multishot, dodge roll, rain of arrows swishes |
| [Level Up Sound Effects](https://opengameart.org/content/level-up-sound-effects) | Bart Kelsey (commissioned by Will Corwin for OpenGameArt.org) | CC-BY 3.0 | Level-up fanfare (orchestra) |
| [Dungeon Ambience](https://opengameart.org/content/dungeon-ambience) | yd | CC0 | Dungeon exploration music loop |
| [Boss Battle Theme](https://opengameart.org/content/boss-battle-theme) | Cleyton Kauffman (soundcloud.com/cleytonkauffman) | CC0 | Final boss music |
| [Male Grunt/Yelling Sounds](https://opengameart.org/content/male-gruntyelling-sounds) | HaelDB | CC0 | Charge grunt, player hurt/death vocals |
| [Battlecry](https://opengameart.org/content/battlecry) | spookymodem | CC-BY 3.0 | War Cry ("a deep warcry before charging into battle") |

Several ability sounds are layered mixes (ffmpeg) of the above: Whirlwind = triple sword swing + metal ring, Charge = swish + chainmail + grunt, Multishot = triple bow at varied pitch, Rain of Arrows = bow + swish volley, Shield Block = armor + metal ring.

# Model Credits

| Pack | Author | License | Used for |
|---|---|---|---|
| [KayKit Character Pack: Adventurers](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0) | Kay Lousberg (kaylousberg.com) | CC0 | Animated hero models: Knight, Mage, Rogue (Ranger) with idle/run/attack/death animations |

Enemy models, dungeon geometry, and textures are procedurally generated in-engine.

# Technology

- [Three.js](https://threejs.org) — rendering
- [TensorFlow.js](https://www.tensorflow.org/js) — in-browser enemy machine learning (movement prediction)
- [PeerJS](https://peerjs.com) — multiplayer networking (WebRTC peer-to-peer co-op via the public PeerJS broker)
- [Vite](https://vitejs.dev) — build tooling
