// localStorage persistence for character + settings.
const SAVE_KEY = 'emberdeep-save-v1';
const SETTINGS_KEY = 'emberdeep-settings-v1';

export const SaveManager = {
  hasSave() {
    return localStorage.getItem(SAVE_KEY) !== null;
  },

  load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.warn('Corrupt save, discarding.', err);
      return null;
    }
  },

  save(data) {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch (err) {
      console.warn('Failed to save.', err);
    }
  },

  clear() {
    localStorage.removeItem(SAVE_KEY);
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
