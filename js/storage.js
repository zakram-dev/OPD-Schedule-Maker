/* Saves everything in this browser (localStorage). Backup/restore via JSON file. */
(function (root) {
  'use strict';
  const KEY = 'opd-schedule-maker:v1';

  function blank() {
    return { version: 1, settings: null, roster: {}, days: {} };
  }

  const Store = {
    load() {
      try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return blank();
        const d = JSON.parse(raw);
        return Object.assign(blank(), d);
      } catch (e) {
        console.warn('Could not read saved data', e);
        return blank();
      }
    },
    save(db) {
      try {
        // don't keep empty days around
        for (const [k, d] of Object.entries(db.days)) if (!d || (!d.employees?.length && !d.rows?.length)) delete db.days[k];
        localStorage.setItem(KEY, JSON.stringify(db));
        return true;
      } catch (e) {
        console.warn('Could not save', e);
        return false;
      }
    },
    exportJSON(db) {
      return JSON.stringify(db, null, 2);
    },
    importJSON(text) {
      const d = JSON.parse(text);
      if (!d || typeof d !== 'object' || !d.days) throw new Error('This file is not a schedule backup.');
      return Object.assign(blank(), d);
    },
    clear() {
      try {
        localStorage.removeItem(KEY);
      } catch (e) {
        /* ignore */
      }
    },
  };

  root.WS = root.WS || {};
  root.WS.Store = Store;
})(typeof window !== 'undefined' ? window : globalThis);
