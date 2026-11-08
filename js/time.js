/* Time helpers. All times are minutes after midnight (5:00 AM = 300). */
(function (root) {
  'use strict';
  const pad = (n) => String(n).padStart(2, '0');

  function parts(m) {
    m = ((Math.round(m) % 1440) + 1440) % 1440;
    const h = Math.floor(m / 60);
    return { h12: h % 12 === 0 ? 12 : h % 12, mm: m % 60, pm: h >= 12 };
  }

  const Time = {
    pad,
    /** 5:00 AM */
    fmt(m) {
      if (m == null) return '';
      const p = parts(m);
      return `${p.h12}:${pad(p.mm)} ${p.pm ? 'PM' : 'AM'}`;
    },
    /** 5a, 5:30a */
    short(m) {
      if (m == null) return '';
      const p = parts(m);
      return `${p.h12}${p.mm ? ':' + pad(p.mm) : ''}${p.pm ? 'p' : 'a'}`;
    },
    /** 9:00–10:00 (no am/pm, like the paper schedules) */
    clock(m) {
      const p = parts(m);
      return `${p.h12}:${pad(p.mm)}`;
    },
    range(a, b) {
      return `${Time.clock(a)}–${Time.clock(b)}`;
    },
    hours(a, b) {
      return Math.round(((b - a) / 60) * 100) / 100;
    },
    /** value for <input type="time"> */
    toInput(m) {
      if (m == null || isNaN(m)) return '';
      return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
    },
    fromInput(v) {
      const r = /^(\d{1,2}):(\d{2})/.exec(v || '');
      return r ? +r[1] * 60 + +r[2] : null;
    },
  };

  root.WS = root.WS || {};
  root.WS.Time = Time;
  if (typeof module !== 'undefined') module.exports = Time;
})(typeof window !== 'undefined' ? window : globalThis);
