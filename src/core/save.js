// localStorage persistence: multiple save slots + settings.
const SLOTS_KEY = 'emberdeep-saves-v2';
const LEGACY_KEY = 'emberdeep-save-v1';
const SETTINGS_KEY = 'emberdeep-settings-v1';
const MAX_SLOTS = 8;

function readSlots() {
  try {
    const raw = localStorage.getItem(SLOTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeSlots(slots) {
  try {
    localStorage.setItem(SLOTS_KEY, JSON.stringify(slots));
  } catch (err) {
    console.warn('Failed to write saves.', err);
  }
}

export const SaveManager = {
  // One-time migration of the old single-save format into slot form.
  migrate() {
    try {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (!legacy) return;
      const data = JSON.parse(legacy);
      const slots = readSlots();
      slots.push({ id: 'slot-' + Date.now().toString(36), updatedAt: Date.now(), data });
      writeSlots(slots);
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      localStorage.removeItem(LEGACY_KEY);
    }
  },

  listSaves() {
    // newest first
    return readSlots().sort((a, b) => b.updatedAt - a.updatedAt);
  },

  hasSave() {
    return readSlots().length > 0;
  },

  newSlotId() {
    return 'slot-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  },

  canCreate() {
    return readSlots().length < MAX_SLOTS;
  },

  loadSlot(id) {
    return readSlots().find((s) => s.id === id)?.data ?? null;
  },

  saveSlot(id, data) {
    const slots = readSlots();
    const existing = slots.find((s) => s.id === id);
    if (existing) {
      existing.data = data;
      existing.updatedAt = Date.now();
    } else {
      slots.push({ id, updatedAt: Date.now(), data });
    }
    writeSlots(slots);
  },

  deleteSlot(id) {
    writeSlots(readSlots().filter((s) => s.id !== id));
  },

  loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },

  saveSettings(settings) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch { /* ignore */ }
  },
};
