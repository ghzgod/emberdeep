// Mastery tree: points accrue ~1 per 3 levels plus a +2 bonus every 10th
// level (see Player.masteryEarned). Nine nodes × five ranks = 45 to master —
// reachable only deep into the level cap, never a mid-game formality.
export const SKILLS = [
  { id: 'brutality', name: 'Brutality', icon: '🗡️', branch: 'Offense', per: '+4% damage', max: 5 },
  { id: 'precision', name: 'Precision', icon: '🎯', branch: 'Offense', per: '+2% crit chance', max: 5 },
  { id: 'celerity', name: 'Celerity', icon: '⏱️', branch: 'Offense', per: '-3% ability cooldowns', max: 5 },
  { id: 'vitality', name: 'Vitality', icon: '❤️', branch: 'Defense', per: '+6% max health', max: 5 },
  { id: 'ironhide', name: 'Ironhide', icon: '🛡️', branch: 'Defense', per: '+2% armor', max: 5 },
  { id: 'swiftness', name: 'Swiftness', icon: '👟', branch: 'Defense', per: '+1% move speed', max: 5 },
  { id: 'greed', name: 'Greed', icon: '💰', branch: 'Fortune', per: '+6% gold found', max: 5 },
  { id: 'scholar', name: 'Scholar', icon: '📖', branch: 'Fortune', per: '+6% experience', max: 5 },
  { id: 'alchemy', name: 'Alchemy', icon: '⚗️', branch: 'Fortune', per: '+8% potion healing', max: 5 },
];
