// Inline SVG icon set replacing the old emoji strings, hand-drawn (CC0-clean).
//
// Two families:
//  - COLOR icons: abilities, mastery skills, class marks, shop portraits and
//    the potion flask. Rich flat-tone mini-illustrations (fills + darker
//    outline + a light glint) so they read as polished and colorful like the
//    emoji did, crisp at 24-48px. Every element carries its own fill/stroke,
//    so they render identically anywhere. No gradients, so repeated injection
//    never collides on <defs> ids.
//  - STROKE icons: menu/chrome glyphs (bag, scroll, gear, mic, trash, ...)
//    in the drawer-icon style already used by the touch UI: 24x24 viewBox,
//    stroke currentColor, ~1.75 weight, round caps - they tint with their
//    button's color states for free.
//
// Icons size themselves to 1em (.ui-ic in style.css), so the existing
// font-size rules on .act-icon / .save-icon / .skill-icon drive their size.
// Ability icons are keyed by the ability id from classes.js (its `icon` field
// carries that id), skill icons by the skill id from skills.js.

// ---- shared color-piece helpers (plain strings, composed per icon) ----
const SHIELD_BODY = 'M12 2.9 19.4 5.5v5.2c0 4.6-2.8 7.7-7.4 9.9-4.6-2.2-7.4-5.3-7.4-9.9V5.5L12 2.9Z';

const steelShield =
  `<path fill="#5b7db1" stroke="#283d5e" stroke-width="1.1" stroke-linejoin="round" d="${SHIELD_BODY}"/>` +
  '<path fill="#8fa9cf" stroke="none" d="M12 4.6 17.8 6.7v3.9c0 1.1-.2 2.1-.6 3L12 4.6Z"/>';

const redFlask =
  '<rect x="10" y="2.5" width="4" height="3.6" rx="1" fill="#8a6a3a" stroke="none"/>' +
  '<path fill="#c8342f" stroke="#7a1f1c" stroke-width="1" stroke-linejoin="round" d="M9.2 6.4h5.6v3.1l4.4 7.6c1.3 2.3-.4 5.1-3 5.1H7.8c-2.6 0-4.3-2.8-3-5.1l4.4-7.6V6.4Z"/>' +
  '<path fill="none" stroke="#7a1f1c" stroke-width="1" stroke-linecap="round" d="M8.5 13.8c1.1.6 2.3.9 3.5.9s2.4-.3 3.5-.9"/>' +
  '<ellipse cx="10.1" cy="15.6" rx="1.1" ry="1.7" fill="#ff8f7a" opacity="0.8" stroke="none"/>';

const singleSword =
  '<path fill="#d8dde8" stroke="#5f6b80" stroke-width="0.9" stroke-linejoin="round" d="M19.6 4.4c.2 1.4 0 2.7-.6 3.8l-8 8-2.2-2.2 8-8c1.1-.6 2.4-.8 3.8-.6Z"/>' +
  '<path fill="none" stroke="#e8c05a" stroke-width="1.8" stroke-linecap="round" d="M6.9 12.9l4.2 4.2"/>' +
  '<path fill="none" stroke="#8a5f3a" stroke-width="1.8" stroke-linecap="round" d="M8 16l-2.6 2.6"/>' +
  '<circle cx="4.6" cy="19.4" r="1.2" fill="#e8c05a" stroke="#8a5f14" stroke-width="0.7"/>';

// ---- full-color icons ----
const COLOR = {
  // knight
  charge:
    steelShield +
    '<path fill="#f2c94c" stroke="#8a5f14" stroke-width="0.9" stroke-linejoin="round" d="M7.4 10.7h4.8V8.3l4.9 4-4.9 4v-2.4H7.4v-3.2Z"/>',
  shield_block:
    `<path fill="#35548f" stroke="#1d3059" stroke-width="1.1" stroke-linejoin="round" d="${SHIELD_BODY}"/>` +
    '<path fill="none" stroke="#e8c05a" stroke-width="1.2" d="M12 4.8l5.5 1.9v3.9c0 3.5-2 5.8-5.5 7.6-3.5-1.8-5.5-4.1-5.5-7.6V6.7l5.5-1.9Z"/>' +
    '<path fill="none" stroke="#e6dcc2" stroke-width="1.7" stroke-linecap="round" d="M12 7.4v8M8.5 10.6h7"/>',
  war_cry:
    '<path fill="none" stroke="#b5893a" stroke-width="1.6" stroke-linecap="round" d="M6.2 3.4v17.4"/>' +
    '<circle cx="6.2" cy="3" r="1" fill="#f2c94c" stroke="#8a5f14" stroke-width="0.7"/>' +
    '<path fill="#c0392b" stroke="#7a1f1c" stroke-width="1" stroke-linejoin="round" d="M7.3 4.6h11.5l-3 4 3 4H7.3v-8Z"/>' +
    '<circle cx="11.6" cy="8.6" r="1.5" fill="#f2c94c" stroke="none"/>' +
    '<path fill="none" stroke="#f2c94c" stroke-width="1.4" stroke-linecap="round" d="M18.4 15.6l2.2.9M17.7 18.3l1.7 1.6"/>',
  whirlwind:
    '<path fill="none" stroke="#bfd4f2" stroke-width="1.9" stroke-linecap="round" d="M10.5 11a1.6 1.6 0 0 1 3.2 0 3.1 3.1 0 0 1-6.2 0 4.7 4.7 0 0 1 9.4 0 6.4 6.4 0 0 1-6.4 6.4"/>' +
    '<path fill="none" stroke="#7fa8dd" stroke-width="1.4" stroke-linecap="round" d="M17.6 16.2c.8.8 1.4 1.7 1.9 2.8M5.2 16.8c-.5.9-.8 1.9-1 3"/>' +
    '<circle cx="12.1" cy="11" r="0.9" fill="#eaf2ff" stroke="none"/>',

  // mage
  fireball:
    '<path fill="#ff7a1a" stroke="#7a1f1c" stroke-width="1" stroke-linejoin="round" d="M12 2.8c.8 2.7 2.9 4.2 4.4 6.2 1.3 1.7 2.1 3.4 2.1 5.2A6.6 6.6 0 0 1 12 20.9a6.6 6.6 0 0 1-6.5-6.7c0-2.4 1.2-4.1 2.5-5.6C9.4 7 11.3 5.4 12 2.8Z"/>' +
    '<path fill="#ffc93a" stroke="none" d="M12 8.6c.5 1.7 1.8 2.6 2.7 3.9.7 1 1 2 1 3A3.8 3.8 0 0 1 12 19a3.8 3.8 0 0 1-3.7-3.5c0-1.4.8-2.4 1.7-3.4.9-1 1.7-1.9 2-3.5Z"/>' +
    '<path fill="#fff3b0" stroke="none" d="M12 13.1c.3 1 1.3 1.6 1.3 2.8A1.9 1.9 0 0 1 12 17.6a1.9 1.9 0 0 1-1.3-1.7c0-1.2 1-1.8 1.3-2.8Z"/>',
  frost_nova:
    '<g fill="none" stroke="#9adfff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 3.2v17.6"/><path d="M10.3 4.7 12 3.2l1.7 1.5M10.3 19.3 12 20.8l1.7-1.5"/>' +
    '<path d="M4.4 7.6l15.2 8.8"/><path d="M4.5 9.8l-.1-2.2 2 .5M19.6 14.2l.1 2.2-2-.5"/>' +
    '<path d="M19.6 7.6 4.4 16.4"/><path d="M19.5 9.8l.1-2.2-2 .5M4.5 14.2l-.1 2.2 2-.5"/></g>' +
    '<circle cx="12" cy="12" r="2.1" fill="#eaf7ff" stroke="#7fc4e8" stroke-width="1"/>',
  blink:
    '<path fill="#ffd75e" stroke="#a8741f" stroke-width="1" stroke-linejoin="round" d="M12 3.4l1.9 5.6 5.6 1.9-5.6 1.9-1.9 5.6-1.9-5.6-5.6-1.9 5.6-1.9L12 3.4Z"/>' +
    '<path fill="#fff6d8" stroke="none" d="M12 7.9l.9 2.7 2.7.9-2.7.9-.9 2.7-.9-2.7-2.7-.9 2.7-.9.9-2.7Z"/>' +
    '<g fill="none" stroke="#c09aff" stroke-width="1.6" stroke-linecap="round"><path d="M18.8 15.8v3.6M17 17.6h3.6"/><path d="M5.6 3.6v2.8M4.2 5H7"/></g>',
  arcane_storm:
    '<path fill="#6d5a96" stroke="#3f3260" stroke-width="1.1" stroke-linejoin="round" d="M7 13.6a3.9 3.9 0 0 1-1-7.6 5.2 5.2 0 0 1 10.2-.8 3.5 3.5 0 0 1 1.4 6.8c-.6.2-1.2.3-1.9.3H8.3c-.5 0-.9-.2-1.3-.7Z"/>' +
    '<path fill="#8a76b5" stroke="none" d="M7.4 7.4a4 4 0 0 1 3.6-2.6c1 0 1.9.3 2.6.9-2.3.2-4.4 1-6.2 2.3v-.6Z"/>' +
    '<path fill="#ffd046" stroke="#a8741f" stroke-width="0.9" stroke-linejoin="round" d="M13.6 10.4 9.9 15.6h2.4l-1.5 5 5.3-6.2h-2.6l2-4h-1.9Z"/>',

  // ranger
  multishot:
    '<g fill="none" stroke="#c8a35a" stroke-width="1.6" stroke-linecap="round"><path d="M12 20.5V6.3"/><path d="M12 20.5 6 9.3"/><path d="M12 20.5 18 9.3"/></g>' +
    '<g fill="#d8dde8" stroke="#5f6b80" stroke-width="0.9" stroke-linejoin="round">' +
    '<path d="M12 2.8 10.6 6h2.8L12 2.8Z"/>' +
    '<path d="M5 7.4l2.1 1.4-2.1 1.1-.3-2.5Z"/>' +
    '<path d="M19 7.4l-2.1 1.4 2.1 1.1.3-2.5Z"/></g>' +
    '<g fill="none" stroke="#b34a4a" stroke-width="1.4" stroke-linecap="round"><path d="M12 20.5l-1.6 1.7M12 20.5l1.6 1.7"/></g>',
  dodge_roll:
    '<path fill="none" stroke="#7ce87c" stroke-width="2" stroke-linecap="round" d="M19.2 12a7.2 7.2 0 1 1-2.2-5.2"/>' +
    '<path fill="#7ce87c" stroke="#3f9e5f" stroke-width="0.9" stroke-linejoin="round" d="M16.2 3.3 20.6 6l-4.4 1.9V3.3Z"/>' +
    '<path fill="none" stroke="#bff5bf" stroke-width="1.2" stroke-linecap="round" d="M8.8 15.2a4.4 4.4 0 0 1-.5-4.4"/>',
  poison_trap:
    '<path fill="#e8e6d8" stroke="#5a5a48" stroke-width="1" stroke-linejoin="round" d="M12 3.2a6.6 6.6 0 0 1 6.6 6.6c0 2.3-1.2 4-2.8 5.1v2.4a1.5 1.5 0 0 1-1.5 1.5H9.7a1.5 1.5 0 0 1-1.5-1.5v-2.4c-1.6-1.1-2.8-2.8-2.8-5.1A6.6 6.6 0 0 1 12 3.2Z"/>' +
    '<circle cx="9.4" cy="10.3" r="1.5" fill="#3f9e2f" stroke="none"/><circle cx="14.6" cy="10.3" r="1.5" fill="#3f9e2f" stroke="none"/>' +
    '<path fill="none" stroke="#5a5a48" stroke-width="1.2" stroke-linecap="round" d="M10.7 18.6v-1.4M13.3 18.6v-1.4"/>' +
    '<path fill="none" stroke="#6fcf4f" stroke-width="1.4" stroke-linecap="round" d="M3.4 15c.9-1 .9-2.1 0-3.1M20.6 15c-.9-1-.9-2.1 0-3.1"/>',
  rain_arrows:
    '<path fill="#7b86a8" stroke="#454e6a" stroke-width="1" stroke-linejoin="round" d="M7 12.5h9.6a3.1 3.1 0 0 0 .8-6.1A4.9 4.9 0 0 0 7.9 5.2 3.7 3.7 0 0 0 7 12.5Z"/>' +
    '<path fill="#9aa5c4" stroke="none" d="M8.1 6.6a3.7 3.7 0 0 1 3.3-2c.9 0 1.7.3 2.4.8-2.1.2-4 .9-5.7 2v-.8Z"/>' +
    '<g fill="none" stroke="#c8a35a" stroke-width="1.5" stroke-linecap="round"><path d="M8 14.5v4M12 15.2v4.3M16 14.5v4"/></g>' +
    '<g fill="#d8dde8" stroke="#5f6b80" stroke-width="0.8" stroke-linejoin="round"><path d="M8 21.4l-1.2-2h2.4l-1.2 2Z"/><path d="M12 22l-1.2-2h2.4L12 22Z"/><path d="M16 21.4l-1.2-2h2.4l-1.2 2Z"/></g>',

  // basic attack (touch cluster pivot): crossed steel swords, gold guards
  swords:
    '<path fill="#d8dde8" stroke="#5f6b80" stroke-width="0.9" stroke-linejoin="round" d="M4 3.5c1 0 2 .2 2.8.5l10.8 10.8-2.3 2.3L4.5 6.3C4.2 5.5 4 4.5 4 3.5Z"/>' +
    '<path fill="#c3cbd8" stroke="#5f6b80" stroke-width="0.9" stroke-linejoin="round" d="M20 3.5c0 1-.2 2-.5 2.8L8.7 17.1l-2.3-2.3L17.2 4c.8-.3 1.8-.5 2.8-.5Z"/>' +
    '<g fill="none" stroke="#e8c05a" stroke-width="1.8" stroke-linecap="round"><path d="M15 19.8l4.8-4.8"/><path d="M4.2 15 9 19.8"/></g>' +
    '<circle cx="18.9" cy="18.9" r="1.2" fill="#e8c05a" stroke="#8a5f14" stroke-width="0.7"/>' +
    '<circle cx="5.1" cy="18.9" r="1.2" fill="#e8c05a" stroke="#8a5f14" stroke-width="0.7"/>',

  // ---- class marks (save slots) ----
  shield: steelShield + '<path fill="none" stroke="#e8c05a" stroke-width="1.2" d="M12 4.8l5.5 1.9v3.9c0 3.5-2 5.8-5.5 7.6-3.5-1.8-5.5-4.1-5.5-7.6V6.7l5.5-1.9Z"/>',
  orb:
    '<circle cx="12" cy="10.3" r="6.2" fill="#7b4fc0" stroke="#3f2a66" stroke-width="1"/>' +
    '<circle cx="9.8" cy="8.2" r="1.6" fill="#c9a9f5" stroke="none"/>' +
    '<g fill="none" stroke="#b5893a" stroke-width="1.6" stroke-linecap="round"><path d="M7 18.4h10"/><path d="M8.8 21h6.4"/></g>',
  bow:
    '<path fill="none" stroke="#a8794a" stroke-width="2.4" stroke-linecap="round" d="M5 4.5A16 16 0 0 1 19.5 19"/>' +
    '<path fill="none" stroke="#e6dcc2" stroke-width="1" d="M5 4.5 19.5 19"/>' +
    '<path fill="none" stroke="#e8c05a" stroke-width="1.6" stroke-linecap="round" d="M4 20 18.5 5.5"/>' +
    '<path fill="#d8dde8" stroke="#5f6b80" stroke-width="0.8" stroke-linejoin="round" d="M21 3l-3.9 1.1 2.8 2.8L21 3Z"/>',

  // ---- potion flask (HUD counter, potions vendor, alchemy skill) ----
  flask: redFlask,
  alchemy: redFlask,

  // ---- offhand slot (paper-doll empty state + item cards) — a shield/book
  // hybrid so it reads as "carried in the off hand", covering knight shields
  // as well as mage tomes/ranger quivers that also live in this slot.
  offhand:
    `<path fill="#6b7484" stroke="#3a4150" stroke-width="1.1" stroke-linejoin="round" d="${SHIELD_BODY}"/>` +
    '<path fill="#8f9bb0" stroke="none" d="M12 4.6 17.8 6.7v3.9c0 1.1-.2 2.1-.6 3L12 4.6Z"/>' +
    '<path fill="#c8a35a" stroke="#8a5f14" stroke-width="0.8" stroke-linejoin="round" d="M8.3 10.4h7.4v6.6H8.3z"/>' +
    '<path fill="none" stroke="#5f6b80" stroke-width="0.9" d="M12 10.4v6.6"/>' +
    '<path fill="#e6dcc2" stroke="none" d="M9 11.3h2.5v4.8H9zM12.5 11.3H15v4.8h-2.5z"/>',

  // ---- shop portraits ----
  anvil:
    '<path fill="#6b7484" stroke="#3a4150" stroke-width="1" stroke-linejoin="round" d="M7 4H3a1 1 0 0 0-1 1 4 4 0 0 0 4 4h1V4Z"/>' +
    '<path fill="#8f9bb0" stroke="#3a4150" stroke-width="1" stroke-linejoin="round" d="M7 5a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1 7 7 0 0 1-7 7H8a1 1 0 0 1-1-1V5Z"/>' +
    '<path fill="none" stroke="#c3cbd8" stroke-width="1" stroke-linecap="round" d="M9.5 6h8.5"/>' +
    '<path fill="none" stroke="#3a4150" stroke-width="1.8" d="M9 12v5M15 12v5"/>' +
    '<path fill="#6b7484" stroke="#3a4150" stroke-width="1" stroke-linejoin="round" d="M5 20a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3 1 1 0 0 1-1 1H6a1 1 0 0 1-1-1Z"/>',

  // ---- mastery tree (keyed by skill id) ----
  brutality: singleSword,
  precision:
    '<circle cx="12" cy="12" r="8.2" fill="#e6dcc2" stroke="#8a1e1e" stroke-width="1.2"/>' +
    '<circle cx="12" cy="12" r="5.3" fill="#c0392b" stroke="none"/>' +
    '<circle cx="12" cy="12" r="2.6" fill="#e6dcc2" stroke="none"/>' +
    '<circle cx="12" cy="12" r="1" fill="#8a1e1e" stroke="none"/>',
  celerity:
    '<circle cx="12" cy="12" r="8" fill="#2a2140" stroke="#e8c05a" stroke-width="1.5"/>' +
    '<path fill="none" stroke="#f2d27a" stroke-width="1.7" stroke-linecap="round" d="M12 7v5l3.2 2.1"/>' +
    '<circle cx="12" cy="12" r="0.9" fill="#f2d27a" stroke="none"/>',
  vitality:
    '<path fill="#c0392b" stroke="#7a1f1c" stroke-width="1" stroke-linejoin="round" d="M12 20.3C7.2 16.4 3.8 13 3.8 9.4A4.3 4.3 0 0 1 12 7.1a4.3 4.3 0 0 1 8.2 2.3c0 3.6-3.4 7-8.2 10.9Z"/>' +
    '<path fill="#e87a6a" stroke="none" d="M6.7 7.1c1.1-.6 2.5-.3 3.2.6-.6 1-2 1.4-3.1.9-.3-.6-.3-1.1-.1-1.5Z"/>',
  ironhide: steelShield + '<path fill="none" stroke="#e8c05a" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M8.7 11.4l2.3 2.4 4.3-4.4"/>',
  swiftness:
    '<g fill="none" stroke-linecap="round">' +
    '<path stroke="#9adfff" stroke-width="1.8" d="M3.5 8h9.5a2.4 2.4 0 1 0-2.3-3.1"/>' +
    '<path stroke="#5fb8e8" stroke-width="1.8" d="M3.5 12h13.7a2.7 2.7 0 1 1-2.5 3.5"/>' +
    '<path stroke="#cfeaff" stroke-width="1.8" d="M3.5 16h6"/></g>',
  greed:
    '<circle cx="14.7" cy="14.6" r="5.6" fill="#e0ae35" stroke="#8a5f14" stroke-width="1"/>' +
    '<circle cx="9.3" cy="9.3" r="5.6" fill="#f2c94c" stroke="#8a5f14" stroke-width="1"/>' +
    '<circle cx="9.3" cy="9.3" r="3" fill="none" stroke="#c8912a" stroke-width="1"/>',
  scholar:
    '<path fill="#e6dcc2" stroke="#6a4a2a" stroke-width="1" stroke-linejoin="round" d="M12 6.3C10.4 4.9 8.3 4.2 5.6 4.2c-.8 0-1.5.1-2.1.2v14.1c.6-.1 1.3-.2 2.1-.2 2.7 0 4.8.7 6.4 2.1 1.6-1.4 3.7-2.1 6.4-2.1.8 0 1.5.1 2.1.2V4.4c-.6-.1-1.3-.2-2.1-.2-2.7 0-4.8.7-6.4 2.1Z"/>' +
    '<path fill="none" stroke="#6a4a2a" stroke-width="1" d="M12 6.3v14.2"/>' +
    '<g fill="none" stroke="#a08a5a" stroke-width="0.9" stroke-linecap="round"><path d="M5.8 8.2h3.8M5.8 11h3.8M14.4 8.2h3.8M14.4 11h3.8"/></g>',

  // ---- touch cluster inner-arc utilities (rotate/mic/settings): colorful
  // hand-drawn variants matching the ability-icon art style, replacing the
  // old flat monochrome STROKE glyphs so the utility bubbles read as part of
  // the same family as the ability bubbles around them.
  rotate_left:
    '<path fill="none" stroke="#e8c05a" stroke-width="2.2" stroke-linecap="round" d="M4.5 12a7.5 7.5 0 1 0 2.4-5.4"/>' +
    '<path fill="#e8c05a" stroke="#8a5f14" stroke-width="0.9" stroke-linejoin="round" d="M7.7 3.2 3.2 5.8l4.3 2.2.2-4.8Z"/>' +
    '<path fill="none" stroke="#f7e2a0" stroke-width="1.2" stroke-linecap="round" d="M15.3 15.6a4.6 4.6 0 0 0 .6-4.6"/>',
  rotate_right:
    '<path fill="none" stroke="#e8c05a" stroke-width="2.2" stroke-linecap="round" d="M19.5 12a7.5 7.5 0 1 1-2.4-5.4"/>' +
    '<path fill="#e8c05a" stroke="#8a5f14" stroke-width="0.9" stroke-linejoin="round" d="M16.3 3.2 20.8 5.8l-4.3 2.2-.2-4.8Z"/>' +
    '<path fill="none" stroke="#f7e2a0" stroke-width="1.2" stroke-linecap="round" d="M8.7 15.6a4.6 4.6 0 0 1-.6-4.6"/>',
  mic_color:
    '<rect x="9" y="3" width="6" height="10" rx="3" fill="#c8342f" stroke="#7a1f1c" stroke-width="1"/>' +
    '<ellipse cx="10.6" cy="6.4" rx="1" ry="1.6" fill="#ff8f7a" opacity="0.8"/>' +
    '<path fill="none" stroke="#e8c05a" stroke-width="1.6" stroke-linecap="round" d="M6 11a6 6 0 0 0 12 0"/>' +
    '<path fill="none" stroke="#e6dcc2" stroke-width="1.6" stroke-linecap="round" d="M12 17v3"/>',
  gear_color:
    '<path fill="none" stroke="#c3cbd8" stroke-width="2.4" stroke-linecap="round" d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8M18.4 18.4l-1.8-1.8M7.4 7.4 5.6 5.6"/>' +
    '<circle cx="12" cy="12" r="3.4" fill="#8fa9cf" stroke="#3a4150" stroke-width="1"/>' +
    '<circle cx="12" cy="12" r="1.3" fill="#e8c05a" stroke="#8a5f14" stroke-width="0.6"/>',
  bag_color:
    '<path fill="none" stroke="#8a5f3a" stroke-width="1.8" stroke-linecap="round" d="M9 8V6.5a3 3 0 0 1 6 0V8"/>' +
    '<path fill="#c8a35a" stroke="#7a5514" stroke-width="1" stroke-linejoin="round" d="M5 8h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 8Z"/>' +
    '<path fill="#e6dcc2" stroke="none" d="M5.5 9h4v3.4h-4z"/>' +
    '<path fill="none" stroke="#7a5514" stroke-width="1" d="M3.5 13h17"/>',
};

// ---- flat-stroke chrome icons (inherit currentColor) ----
const STROKE = {
  bag: '<path d="M9 8V6.5a3 3 0 0 1 6 0V8"/><path d="M5 8h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 8Z"/><path d="M3.5 13h17"/>',
  scroll: '<path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/><path d="M11.5 8h4M11.5 12h4"/>',
  star: '<path d="M12 3.6l2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.2 6.9 19l1.1-5.6L3.8 9.5l5.7-.7L12 3.6Z"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3"/>',
  mic: '<rect x="9" y="3" width="6" height="10" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><path d="M12 17v3"/>',
  menu: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
  close: '<path d="M5.5 5.5l13 13M18.5 5.5l-13 13"/>',
  trash: '<path d="M4.5 6.5h15"/><path d="M8.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 15.5 5v1.5"/><path d="M6.5 6.5 7.3 19a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12.5"/><path d="M10 10.5v6M14 10.5v6"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.7-1.6"/>',
  ban: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
  spiral: '<path d="M10.5 11a1.6 1.6 0 0 1 3.2 0 3.1 3.1 0 0 1-6.2 0 4.7 4.7 0 0 1 9.4 0 6.4 6.4 0 0 1-6.4 6.4"/>',
};

// Class -> save-slot mark
export const CLASS_ICONS = { knight: 'shield', mage: 'orb', ranger: 'bow' };

export function svgIcon(name, cls = '') {
  const classAttr = `class="ui-ic${cls ? ' ' + cls : ''}"`;
  if (COLOR[name]) {
    return `<svg ${classAttr} viewBox="0 0 24 24" fill="none" aria-hidden="true">${COLOR[name]}</svg>`;
  }
  const body = STROKE[name];
  if (!body) return '';
  return `<svg ${classAttr} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export const ICONS = { ...STROKE, ...COLOR };
