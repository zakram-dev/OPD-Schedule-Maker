/*
 * Cleans up what the photo reader found, using things the app already knows:
 *  - names this device has scheduled before (fix "Jarnes M" → "James M"),
 *  - shift shapes that make sense (flag 15-hour shifts or 2 AM starts).
 * Nothing leaves the browser; the known-names list lives with the saved days.
 */
(function (root) {
  'use strict';

  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  // Letters the photo reader commonly mixes up, so swapping them is a "cheap" mistake.
  const LOOKALIKE = ['il1j', 'o0dq', 's5', 'b8', 'z2', 'g69', 'ec', 'ao', 'nr', 'uv', 'hb', 'ft', 'yv'];
  const looksAlike = (a, b) => a === b || LOOKALIKE.some((g) => g.includes(a) && g.includes(b));
  // ...and groups of letters that blur into one: "rn" looks like "m", "cl" like "d"
  const MERGES = [
    ['rn', 'm'],
    ['nn', 'm'],
    ['cl', 'd'],
    ['vv', 'w'],
    ['ri', 'n'],
    ['li', 'h'],
    ['ii', 'u'],
  ];

  /** Weighted edit cost between two names: lookalike swaps and merged letters cost less. */
  function nameCost(aIn, bIn) {
    const a = norm(aIn);
    const b = norm(bIn);
    const n = a.length;
    const m = b.length;
    const D = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(Infinity));
    D[0][0] = 0;
    const indel = (s, i) => {
      const ch = s[i];
      if (ch === ' ') return 0.3;
      // a doubled letter dropped or added ("Elis" ↔ "Ellis")
      if ((i > 0 && s[i - 1] === ch) || s[i + 1] === ch) return 0.45;
      return 1;
    };
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= m; j++) {
        const cur = D[i][j];
        if (cur === Infinity) continue;
        if (i < n) D[i + 1][j] = Math.min(D[i + 1][j], cur + indel(a, i));
        if (j < m) D[i][j + 1] = Math.min(D[i][j + 1], cur + indel(b, j));
        if (i < n && j < m) {
          const x = a[i];
          const y = b[j];
          const c = x === y ? 0 : looksAlike(x, y) ? 0.35 : 1;
          D[i + 1][j + 1] = Math.min(D[i + 1][j + 1], cur + c);
        }
        for (const [two, one] of MERGES) {
          if (a.startsWith(two, i) && b.startsWith(one, j)) D[i + 2][j + 1] = Math.min(D[i + 2][j + 1], cur + 0.4);
          if (a.startsWith(one, i) && b.startsWith(two, j)) D[i + 1][j + 2] = Math.min(D[i + 1][j + 2], cur + 0.4);
        }
      }
    return D[n][m];
  }

  /**
   * Best known name for a reading, or null. Conservative on purpose: a new person whose name is
   * close to someone else's ("Ana M" vs "Ava M") must not be renamed.
   */
  function matchName(name, known) {
    const target = norm(name);
    if (!target || !known || !known.length) return null;
    const exact = known.find((k) => norm(k) === target);
    if (exact) return { name: exact, cost: 0 };
    const limit = target.length >= 9 ? 1.25 : target.length >= 6 ? 0.9 : 0.45;
    let best = null;
    let second = Infinity;
    for (const k of known) {
      const c = nameCost(target, k);
      if (!best || c < best.cost) {
        if (best) second = Math.min(second, best.cost);
        best = { name: k, cost: c };
      } else second = Math.min(second, c);
    }
    if (!best || best.cost > limit) return null;
    if (second - best.cost < 0.5) return null; // two known names fit about as well: don't guess
    // the last-name initial must agree (or be a lookalike): "Alice T" is never "Alice R"
    const ini = (s) => (/ ([a-z0-9])$/.exec(norm(s)) || [])[1];
    const i1 = ini(target);
    const i2 = ini(best.name);
    if (i1 && i2 && !looksAlike(i1, i2)) return null;
    return best;
  }

  /**
   * Applies name memory and sanity checks to people found in a photo or scanned PDF.
   * opts: { known: [names], settings, fromPhoto }
   */
  function apply(people, opts) {
    const o = opts || {};
    const s = o.settings || {};
    const deptStart = s.deptStart == null ? 300 : s.deptStart;
    const deptEnd = s.deptEnd == null ? 1320 : s.deptEnd;
    return (people || []).map((p) => {
      const q = Object.assign({}, p);
      const check = new Set(q.check || []);
      if (o.fromPhoto && q.name && o.known && o.known.length) {
        const hit = matchName(q.name, o.known);
        if (hit && hit.name !== q.name) {
          if (norm(hit.name) !== norm(q.name)) {
            q.readAs = q.name;
            check.add('name-fixed');
          }
          q.name = hit.name;
        }
      }
      if (o.fromPhoto) {
        const len = q.end - q.start;
        if (len > 0 && (len < 180 || len > 660)) check.add('odd-length');
        if (q.start < deptStart - 30 || q.end > deptEnd + 30) check.add('odd-time');
      }
      if (check.size) q.check = [...check];
      else delete q.check;
      return q;
    });
  }

  const ReadFix = { nameCost, matchName, apply, norm };
  root.WS = root.WS || {};
  root.WS.ReadFix = ReadFix;
  if (typeof module !== 'undefined') module.exports = ReadFix;
})(typeof window !== 'undefined' ? window : globalThis);
