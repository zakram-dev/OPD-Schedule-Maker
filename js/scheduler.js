/*
 * OPD scheduling engine.
 *
 *  1. Single-person jobs (Backroom, Prep, SM/EXP) get a chain of people that covers
 *     their hours, each person doing the job for their whole shift.
 *  2. Everyone else is split into Pickers / Dispensers so the dispenser share matches
 *     the target for each time of day.
 *  3. Lunches are placed by the lunch rules and staggered so not too many people from
 *     the same job are out at once.
 *  4. A picker or dispenser is picked to cover each Backroom / Prep / SM lunch.
 *
 * Rotation: past saved days are passed in as `history`; people who did a job recently
 * are less likely to get the same job again.
 */
(function (root) {
  'use strict';
  const TICK = 15; // minutes; internal resolution for counting people

  const ROLES = {
    PICK: { label: 'Pick', long: 'Picker' },
    DISP: { label: 'Disp', long: 'Dispenser' },
    BR: { label: 'BR', long: 'Backroom' },
    PREP: { label: 'Prep', long: 'Prep' },
    SM: { label: 'SM', long: 'SM / EXP' },
    TL: { label: 'TL', long: 'Team Lead' },
  };
  const POOL = ['PICK', 'DISP'];
  const SINGLE = ['BR', 'PREP', 'SM'];
  const isSingle = (r) => SINGLE.includes(r);
  // one-person jobs whose lunch needs a picker/dispenser to cover (SM / EXP doesn't)
  const COVERED = ['BR', 'PREP'];
  const needsCover = (r) => COVERED.includes(r);
  const isPool = (r) => POOL.includes(r);

  function defaultSettings() {
    return {
      deptStart: 300, // 5:00 AM
      deptEnd: 1320, // 10:00 PM
      lunch: {
        noneUnder: 6, // shifts shorter than this many hours: no lunch
        shortUpTo: 6, // shifts up to this many hours: short lunch
        shortLen: 30,
        longLen: 60, // everything longer
        earliestAfter: 180, // lunch can start 3h after shift start at the earliest
        latestAfter: 360, // ...and must start within 6h of shift start
        endBuffer: 60, // lunch must end at least 1h before the shift ends
        step: 30, // lunches start on :00 / :30
      },
      singleRoles: [
        { key: 'BR', enabled: true, count: 1, from: 300, to: 1320 },
        { key: 'PREP', enabled: true, count: 1, from: 360, to: 1320 },
        { key: 'SM', enabled: true, count: 1, from: 300, to: 1200 },
      ],
      // Share of pickers+dispensers on the clock who should be dispensers, by time of day.
      // Taken from the sample schedules: almost all picking at open, ~50/50 at night.
      dispTargets: [
        { from: 300, pct: 5 },
        { from: 390, pct: 35 },
        { from: 660, pct: 40 },
        { from: 960, pct: 50 },
      ],
      minPick: 1,
      minDisp: 1,
      dispFrom: 420, // dispensing (customer pickup) hours, used for the minimum
      dispTo: 1320,
      rotationDays: 7,
      rotation: 2, // 0 off, 1 low, 2 normal, 3 strong
      floorSheet: true, // show the Floor sheet print button
      dispOpen: 360, // floor sheet: dispensing starts at 6:00 AM (5-6 AM dispensers pick first)
    };
  }

  /** A number from settings, or the default when it's missing / not a number; clamped to a sane range. */
  function num(v, def, min, max, integer) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return def;
    let n = +v;
    if (!Number.isFinite(n)) return def;
    if (integer) n = Math.round(n);
    return Math.min(max, Math.max(min, n));
  }

  /** Fill in defaults and repair anything broken, so bad settings can never crash a schedule. */
  function mergeSettings(s) {
    const d = defaultSettings();
    if (!s || typeof s !== 'object') return d;
    const out = { ...d };
    out.deptStart = num(s.deptStart, d.deptStart, 0, 1425);
    out.deptEnd = num(s.deptEnd, d.deptEnd, 15, 1440);
    if (out.deptEnd - out.deptStart < 60) {
      out.deptStart = d.deptStart;
      out.deptEnd = d.deptEnd;
    }
    const sl = s.lunch && typeof s.lunch === 'object' ? s.lunch : {};
    out.lunch = {
      noneUnder: num(sl.noneUnder, d.lunch.noneUnder, 0, 24),
      shortUpTo: num(sl.shortUpTo, d.lunch.shortUpTo, 0, 24),
      shortLen: num(sl.shortLen, d.lunch.shortLen, 0, 120),
      longLen: num(sl.longLen, d.lunch.longLen, 0, 120),
      earliestAfter: num(sl.earliestAfter, d.lunch.earliestAfter, 30, 720), // never right at clock-in
      latestAfter: num(sl.latestAfter, d.lunch.latestAfter, 0, 1440),
      endBuffer: num(sl.endBuffer, d.lunch.endBuffer, 15, 720), // never right before clock-out
      step: [15, 30, 60].includes(+sl.step) ? +sl.step : d.lunch.step,
    };
    const mineRoles = Array.isArray(s.singleRoles) ? s.singleRoles.filter((x) => x && typeof x === 'object') : [];
    out.singleRoles = d.singleRoles.map((def) => {
      const mine = mineRoles.find((x) => x.key === def.key) || {};
      let from = num(mine.from, def.from, 0, 1440);
      let to = num(mine.to, def.to, 0, 1440);
      if (to <= from) {
        from = def.from;
        to = def.to;
      }
      return { key: def.key, enabled: mine.enabled === undefined ? def.enabled : !!mine.enabled, count: num(mine.count, def.count, 1, 5, true), from, to };
    });
    const targets = (Array.isArray(s.dispTargets) ? s.dispTargets : [])
      .filter((x) => x && x.from !== null && x.from !== undefined && x.from !== '' && Number.isFinite(+x.from))
      .map((x) => ({ from: num(x.from, 0, 0, 1440), pct: num(x.pct, 0, 0, 100) }));
    out.dispTargets = (targets.length ? targets : d.dispTargets).sort((a, b) => a.from - b.from);
    out.minPick = num(s.minPick, d.minPick, 0, 10, true);
    out.minDisp = num(s.minDisp, d.minDisp, 0, 10, true);
    out.dispFrom = num(s.dispFrom, d.dispFrom, 0, 1440);
    out.dispTo = num(s.dispTo, d.dispTo, 0, 1440);
    if (out.dispTo <= out.dispFrom) {
      out.dispFrom = d.dispFrom;
      out.dispTo = d.dispTo;
    }
    out.rotationDays = num(s.rotationDays, d.rotationDays, 1, 28, true);
    out.rotation = num(s.rotation, d.rotation, 0, 3, true);
    out.floorSheet = s.floorSheet === undefined ? d.floorSheet : !!s.floorSheet;
    out.dispOpen = num(s.dispOpen, d.dispOpen, 0, 1380);
    return out;
  }

  const ceilTo = (x, step) => Math.ceil(x / step) * step;
  const floorTo = (x, step) => Math.floor(x / step) * step;
  const works = (r, t) => r.start <= t && t < r.end;
  const onLunch = (r, t) => r.lunch != null && r.lunchLen > 0 && r.lunch <= t && t < r.lunch + r.lunchLen;

  function lunchLength(start, end, sIn) {
    const L = mergeSettings(sIn).lunch;
    const h = (end - start) / 60;
    if (h < L.noneUnder) return 0;
    if (h <= L.shortUpTo) return L.shortLen;
    return L.longLen;
  }

  /** Lunch start times allowed by the rules. */
  function lunchOptions(start, end, len, sIn) {
    if (!len) return [];
    const L = mergeSettings(sIn).lunch;
    const first = ceilTo(start + L.earliestAfter, L.step);
    const last = floorTo(Math.min(start + L.latestAfter, end - L.endBuffer - len), L.step);
    const out = [];
    for (let t = first; t <= last; t += L.step) out.push(t);
    if (!out.length) {
      const mid = floorTo(start + (end - start - len) / 2, L.step);
      if (mid > start && mid + len < end) out.push(mid);
    }
    return out;
  }

  function lunchProblem(r, sIn) {
    if (!r.lunchLen || r.lunch == null) return null;
    const s = mergeSettings(sIn);
    if (r.lunch < r.start || r.lunch + r.lunchLen > r.end) return 'outside the shift';
    if (r.lunch < r.start + s.lunch.earliestAfter) return `less than ${s.lunch.earliestAfter / 60}h into the shift`;
    if (r.lunch > r.start + s.lunch.latestAfter) return `more than ${s.lunch.latestAfter / 60}h into the shift`;
    return null;
  }

  function rng(seed) {
    let a = seed >>> 0 || 1;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rand) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  const nameKey = (n) => String(n == null ? '' : n).toLowerCase().replace(/[^a-z0-9]/g, '');

  // ---- rotation history -------------------------------------------------------------
  function buildHistory(history, date, days) {
    const map = new Map();
    if (!history || typeof history !== 'object' || !date) return map;
    const d0 = Date.parse(date + 'T00:00:00Z');
    if (!Number.isFinite(d0)) return map;
    for (const [d, day] of Object.entries(history)) {
      const ago = Math.round((d0 - Date.parse(d + 'T00:00:00Z')) / 86400000);
      if (!(ago >= 1 && ago <= days)) continue;
      if (!day || !Array.isArray(day.rows)) continue;
      for (const r of day.rows) {
        if (!r || typeof r.name !== 'string' || typeof r.role !== 'string' || !ROLES[r.role] || r.role === 'TL') continue;
        const k = nameKey(r.name);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push({ ago, role: r.role });
      }
    }
    return map;
  }
  function rotPenalty(hist, name, role, days) {
    const list = hist.get(nameKey(name));
    if (!list) return 0;
    let p = 0;
    for (const h of list) {
      const w = 1 - (h.ago - 1) / days; // yesterday = 1, a week ago ≈ 0.14
      if (h.role === role) p += w;
      else if (isSingle(h.role) && isSingle(role)) p += 0.4 * w;
    }
    return p;
  }

  // ---- main ---------------------------------------------------------------------------
  /**
   * employees: [{id, name, start, end, isTL, role?, lockRole?, lunch?, lunchLen?, lockLunch?, coverBy?, coverLock?}]
   * opts: {seed, date, history}
   * Returns schedule rows.
   */
  function generate(employees, sIn, opts) {
    opts = opts || {};
    const s = mergeSettings(sIn);
    const rand = rng(opts.seed || 1);
    const hist = buildHistory(opts.history, opts.date, s.rotationDays);
    const rotW = [0, 0.5, 1, 2][s.rotation] != null ? [0, 0.5, 1, 2][s.rotation] : 1;
    const T0 = s.deptStart;
    const NT = Math.max(0, Math.round((s.deptEnd - s.deptStart) / TICK));
    const tt = (i) => T0 + i * TICK;
    const inDisp = (t) => t >= s.dispFrom && t < s.dispTo;

    const rows = employees.map((e) => {
      const lockRole = !e.isTL && !!e.lockRole && !!e.role;
      const lockLunch = !e.isTL && !!e.lockLunch;
      return {
        id: e.id,
        name: e.name,
        start: e.start,
        end: e.end,
        isTL: !!e.isTL,
        role: e.isTL ? 'TL' : lockRole ? e.role : null,
        lockRole,
        lunch: lockLunch ? (e.lunch == null ? null : e.lunch) : null,
        lunchLen: lockLunch && e.lunchLen != null ? e.lunchLen : lunchLength(e.start, e.end, s),
        lockLunch,
        coverBy: e.coverLock ? e.coverBy || null : null,
        coverLock: !!e.coverLock,
      };
    });
    const workers = rows.filter((r) => !r.isTL);

    // 1. single-person jobs ------------------------------------------------------------
    const reqPool = (t) => s.minPick + (inDisp(t) ? s.minDisp : 0);
    for (const sr of s.singleRoles.filter((x) => x.enabled)) {
      const need = Math.max(1, sr.count | 0 || 1);
      for (let lane = 1; lane <= need; lane++) planChain(sr, lane);
    }

    /*
     * Pick who does a one-person job so its hours are covered, weighing every possible
     * hand-off chain at once (shortest-path over the day):
     *   - an uncovered 15 minutes costs 2
     *   - each person used costs 1, plus 1 per hour they double up with the previous person
     *   - taking someone who leaves the floor below the minimum costs 25 per hour (so we'd
     *     rather leave a gap than leave nobody picking/dispensing)
     *   - rotation adds a small, capped cost, so it changes *who* but never costs coverage
     */
    function planChain(sr, lane) {
      const from = Math.max(sr.from, T0);
      const to = Math.min(sr.to, s.deptEnd);
      if (to <= from) return;
      const N = Math.ceil((to - from) / TICK);
      const at = (k) => from + k * TICK;
      const covered = (k) => rows.filter((r) => r.role === sr.key && works(r, at(k))).length >= lane;
      const avail = new Array(NT).fill(0);
      for (const r of workers) if (!r.role) for (let i = 0; i < NT; i++) if (works(r, tt(i))) avail[i]++;
      const cands = workers
        .filter((c) => !c.role && c.end > from && c.start < to)
        .map((c) => {
          let short = 0;
          for (let i = 0; i < NT; i++) if (works(c, tt(i)) && avail[i] - 1 < reqPool(tt(i))) short += TICK / 60;
          const rot = rotW * 0.5 * Math.min(3, rotPenalty(hist, c.name, sr.key, s.rotationDays));
          return { c, short, rot, jitter: rand() * 0.02 };
        });
      const cost = new Array(N + 1).fill(Infinity);
      const prev = new Array(N + 1).fill(null);
      cost[0] = 0;
      for (let k = 0; k < N; k++) {
        if (cost[k] === Infinity) continue;
        const step = covered(k) ? 0 : 2; // already covered by someone, or a gap
        if (cost[k] + step < cost[k + 1]) {
          cost[k + 1] = cost[k] + step;
          prev[k + 1] = { k, who: null };
        }
        if (covered(k)) continue;
        const t = at(k);
        for (const x of cands) {
          if (!works(x.c, t)) continue;
          const k2 = Math.min(N, Math.ceil((Math.min(x.c.end, to) - from) / TICK));
          if (k2 <= k) continue;
          const overlapH = Math.max(0, t - Math.max(x.c.start, from)) / 60;
          const c2 = cost[k] + 1 + overlapH + 25 * x.short + x.rot + x.jitter;
          if (c2 < cost[k2]) {
            cost[k2] = c2;
            prev[k2] = { k, who: x.c };
          }
        }
      }
      for (let k = N; k > 0 && prev[k]; k = prev[k].k) if (prev[k].who) prev[k].who.role = sr.key;
    }

    // 2. pickers vs dispensers ------------------------------------------------------------
    const pool = workers.filter((r) => !r.role || isPool(r.role));
    const free = pool.filter((r) => !r.role);
    free.forEach((r) => (r.role = 'PICK'));
    const pctAt = (t) => {
      let p = 0;
      for (const d of s.dispTargets) if (t >= d.from) p = d.pct;
      return p / 100;
    };
    const poolTicks = pool.map((r) => {
      const a = [];
      for (let i = 0; i < NT; i++) if (works(r, tt(i))) a.push(i);
      return a;
    });
    function poolCost() {
      const n = new Array(NT).fill(0);
      const d = new Array(NT).fill(0);
      pool.forEach((r, k) => {
        for (const i of poolTicks[k]) {
          n[i]++;
          if (r.role === 'DISP') d[i]++;
        }
      });
      let c = 0;
      for (let i = 0; i < NT; i++) {
        if (!n[i]) continue;
        const t = tt(i);
        const dev = d[i] - pctAt(t) * n[i];
        c += dev * dev;
        if (inDisp(t) && n[i] >= s.minPick + s.minDisp && d[i] < s.minDisp) c += 40 * (s.minDisp - d[i]) ** 2;
        if (n[i] - d[i] < s.minPick) c += 40 * (s.minPick - (n[i] - d[i])) ** 2;
      }
      for (const r of free) c += rotW * 8 * rotPenalty(hist, r.name, r.role, s.rotationDays);
      return c;
    }
    const flip = (r) => (r.role = r.role === 'PICK' ? 'DISP' : 'PICK');
    let cur = poolCost();
    for (let pass = 0; pass < 40; pass++) {
      let improved = false;
      const order = shuffle(free.slice(), rand);
      for (const r of order) {
        flip(r);
        const c = poolCost();
        if (c < cur - 1e-9) {
          cur = c;
          improved = true;
        } else flip(r);
      }
      for (const a of order)
        for (const b of order) {
          if (a.role !== 'PICK' || b.role !== 'DISP') continue;
          a.role = 'DISP';
          b.role = 'PICK';
          const c = poolCost();
          if (c < cur - 1e-9) {
            cur = c;
            improved = true;
          } else {
            a.role = 'PICK';
            b.role = 'DISP';
          }
        }
      if (!improved) break;
    }

    // 3. lunches --------------------------------------------------------------------------
    const group = (r) => (isSingle(r.role) ? 'SINGLE' : r.role);
    const groups = ['PICK', 'DISP', 'SINGLE'];
    const working = {};
    const out = {};
    groups.forEach((g) => {
      working[g] = new Array(NT).fill(0);
      out[g] = new Array(NT).fill(0);
    });
    const outTotal = new Array(NT).fill(0);
    for (const r of workers) for (let i = 0; i < NT; i++) if (works(r, tt(i))) working[group(r)][i]++;

    const applyLunch = (r, sign) => {
      if (r.lunch == null || !r.lunchLen) return;
      for (let x = r.lunch; x < r.lunch + r.lunchLen; x += TICK) {
        const i = (x - T0) / TICK;
        if (i < 0 || i >= NT) continue;
        out[group(r)][i] += sign;
        outTotal[i] += sign;
      }
    };
    function placeCost(r, L) {
      const g = group(r);
      let c = 0;
      for (let x = L; x < L + r.lunchLen; x += TICK) {
        const i = (x - T0) / TICK;
        if (i < 0 || i >= NT) continue;
        c += outTotal[i] + 4 * out[g][i];
        if (isPool(g)) {
          const onFloor = working[g][i] - out[g][i] - 1;
          const min = g === 'PICK' ? s.minPick : inDisp(x) ? s.minDisp : 0;
          if (onFloor < min) c += 60;
          c += (8 * (out[g][i] + 1)) / Math.max(1, working[g][i]);
        } else if (needsCover(r.role)) {
          // someone from the floor has to cover: prefer times with more people around
          const floor = working.PICK[i] + working.DISP[i] - out.PICK[i] - out.DISP[i];
          if (floor < 2) c += 30;
        }
      }
      const ideal = r.start + (r.end - r.start - r.lunchLen) / 2;
      c += (0.6 * Math.abs(L - ideal)) / 30;
      return c + rand() * 0.01;
    }

    workers.filter((r) => r.lockLunch).forEach((r) => applyLunch(r, +1));
    const needLunch = workers.filter((r) => !r.lockLunch && r.lunchLen > 0);
    const options = new Map(needLunch.map((r) => [r.id, lunchOptions(r.start, r.end, r.lunchLen, s)]));
    needLunch.sort((a, b) => options.get(a.id).length - options.get(b.id).length || a.start - b.start);
    const bestSpot = (r) => {
      let best = null;
      let bc = Infinity;
      for (const L of options.get(r.id)) {
        const c = placeCost(r, L);
        if (c < bc) {
          bc = c;
          best = L;
        }
      }
      return best;
    };
    for (const r of needLunch) {
      r.lunch = bestSpot(r);
      applyLunch(r, +1);
    }
    for (let pass = 0; pass < 5; pass++) {
      for (const r of shuffle(needLunch.slice(), rand)) {
        applyLunch(r, -1);
        r.lunch = bestSpot(r);
        applyLunch(r, +1);
      }
    }

    // 4. lunch covers ---------------------------------------------------------------------
    assignCovers(rows, s);
    return sortRows(rows);
  }

  const ROLE_ORDER = { TL: 0, SM: 1, BR: 2, PREP: 3, PICK: 4, DISP: 5 };
  function sortRows(rows) {
    return rows.sort((a, b) => a.start - b.start || a.end - b.end || a.name.localeCompare(b.name));
  }

  /** Pick a picker/dispenser to cover each Backroom / Prep lunch. Keeps locked covers. */
  function assignCovers(rows, sIn) {
    const s = mergeSettings(sIn);
    const pool = rows.filter((r) => isPool(r.role));
    const busy = new Map();
    const addBusy = (id, a, b) => {
      if (!busy.has(id)) busy.set(id, []);
      busy.get(id).push([a, b]);
    };
    const singles = rows.filter((r) => needsCover(r.role)).sort((a, b) => (a.lunch || 0) - (b.lunch || 0));
    const byId = new Map(rows.map((r) => [r.id, r]));
    // a hand-picked cover only stays if it still makes sense
    const validCover = (r, c) =>
      c && isPool(c.role) && c.start <= r.lunch && c.end >= r.lunch + r.lunchLen && !(c.lunch != null && c.lunchLen && c.lunch < r.lunch + r.lunchLen && c.lunch + c.lunchLen > r.lunch);
    for (const r of singles) {
      if (r.lunch == null || !r.lunchLen) {
        r.coverBy = null;
        r.coverLock = false;
        continue;
      }
      if (r.coverLock && r.coverBy) {
        const c = byId.get(r.coverBy);
        const clash = (busy.get(r.coverBy) || []).some(([x, y]) => x < r.lunch + r.lunchLen && y > r.lunch);
        if (validCover(r, c) && !clash) addBusy(r.coverBy, r.lunch, r.lunch + r.lunchLen);
        else r.coverLock = false;
      }
    }
    for (const r of rows) if (!needsCover(r.role)) {
      r.coverBy = null;
      r.coverLock = false;
    }
    for (const r of singles) {
      if (r.lunch == null || !r.lunchLen || (r.coverLock && r.coverBy)) continue;
      r.coverLock = false;
      const a = r.lunch;
      const b = r.lunch + r.lunchLen;
      let best = null;
      let bs = -Infinity;
      for (const c of pool) {
        if (c.start > a || c.end < b) continue;
        if (c.lunch != null && c.lunch < b && c.lunch + c.lunchLen > a) continue;
        const mine = busy.get(c.id) || [];
        if (mine.some(([x, y]) => x < b && y > a)) continue;
        let minFloor = Infinity;
        for (let t = a; t < b; t += TICK) {
          const n = pool.filter((p) => p.role === c.role && works(p, t) && !onLunch(p, t)).length;
          minFloor = Math.min(minFloor, n);
        }
        const min = c.role === 'PICK' ? s.minPick : s.minDisp;
        const score = minFloor - min - 3 * mine.length + (c.role === 'PICK' ? 0.5 : 0);
        if (score > bs || (score === bs && best && c.name < best.name)) {
          bs = score;
          best = c;
        }
      }
      r.coverBy = best ? best.id : null;
      if (best) addBusy(best.id, a, b);
    }
    return rows;
  }

  /** Coverage counts and problems for a finished (or edited) schedule. */
  function analyze(rows, sIn) {
    const s = mergeSettings(sIn);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const singles = s.singleRoles.filter((x) => x.enabled);
    const covering = (c, t) => rows.some((r) => r.coverBy === c.id && needsCover(r.role) && onLunch(r, t));

    const ticks = [];
    for (let t = s.deptStart; t < s.deptEnd; t += TICK) {
      const k = { t, PICK: 0, DISP: 0, lunch: 0, staff: 0, single: {}, need: {} };
      for (const r of rows) {
        if (!works(r, t)) continue;
        if (!r.isTL) k.staff++;
        if (onLunch(r, t)) {
          k.lunch++;
          continue;
        }
        if (isPool(r.role) && !covering(r, t)) k[r.role]++;
      }
      for (const sr of singles) {
        const active = t >= sr.from && t < sr.to;
        k.need[sr.key] = active ? Math.max(1, sr.count | 0 || 1) : 0;
        let n = 0;
        for (const r of rows) {
          if (r.role !== sr.key || !works(r, t)) continue;
          if (!onLunch(r, t)) n++;
          else if (!needsCover(r.role)) n++; // e.g. SM / EXP: their lunch is an accepted gap
          else if (r.coverBy && byId.has(r.coverBy) && works(byId.get(r.coverBy), t) && !onLunch(byId.get(r.coverBy), t)) n++;
        }
        k.single[sr.key] = n;
      }
      ticks.push(k);
    }

    // 30-minute slots for display: worst case inside the slot
    const slots = [];
    for (let i = 0; i < ticks.length; i += 2) {
      const grp = ticks.slice(i, i + 2);
      const sl = {
        t: grp[0].t,
        PICK: Math.min(...grp.map((g) => g.PICK)),
        DISP: Math.min(...grp.map((g) => g.DISP)),
        lunch: Math.max(...grp.map((g) => g.lunch)),
        staff: Math.max(...grp.map((g) => g.staff)),
        single: {},
        need: {},
      };
      for (const sr of singles) {
        sl.single[sr.key] = Math.min(...grp.map((g) => g.single[sr.key]));
        sl.need[sr.key] = Math.max(...grp.map((g) => g.need[sr.key]));
      }
      slots.push(sl);
    }

    const warnings = [];
    const ranges = (pred) => {
      const out = [];
      let open = null;
      for (const k of ticks) {
        if (pred(k)) {
          if (!open) open = { from: k.t, to: k.t + TICK };
          else open.to = k.t + TICK;
        } else if (open) {
          out.push(open);
          open = null;
        }
      }
      if (open) out.push(open);
      return out;
    };
    const hasStaff = rows.some((r) => !r.isTL && r.end > r.start);
    if (hasStaff)
      for (const g of ranges((k) => k.staff === 0))
        warnings.push({ kind: 'empty', from: g.from, to: g.to, text: 'Nobody is on the schedule' });
    for (const sr of singles) {
      for (const g of ranges((k) => k.staff > 0 && k.single[sr.key] < k.need[sr.key]))
        warnings.push({ kind: 'cover', role: sr.key, from: g.from, to: g.to, text: `No ${ROLES[sr.key].long} on duty` });
    }
    for (const g of ranges((k) => k.staff > 0 && k.t >= s.dispFrom && k.t < s.dispTo && k.DISP < s.minDisp))
      warnings.push({ kind: 'floor', role: 'DISP', from: g.from, to: g.to, text: `Fewer than ${s.minDisp} dispenser(s) on the floor` });
    for (const g of ranges((k) => k.staff > 0 && k.PICK < s.minPick))
      warnings.push({ kind: 'floor', role: 'PICK', from: g.from, to: g.to, text: `Fewer than ${s.minPick} picker(s) on the floor` });

    for (const r of rows) {
      if (r.isTL) continue;
      const expected = lunchLength(r.start, r.end, s);
      if (expected && r.lunch == null) warnings.push({ kind: 'lunch', id: r.id, text: `${r.name} (${Time.hours(r.start, r.end)}h) has no lunch` });
      const p = lunchProblem(r, s);
      if (p) warnings.push({ kind: 'lunch', id: r.id, text: `${r.name}'s lunch is ${p}` });
      if (needsCover(r.role) && r.lunch != null && r.lunchLen) {
        const c = byId.get(r.coverBy);
        if (!c) warnings.push({ kind: 'lunch', id: r.id, text: `Nobody is covering ${r.name}'s ${ROLES[r.role].long} lunch` });
        else if (c.start > r.lunch || c.end < r.lunch + r.lunchLen)
          warnings.push({ kind: 'lunch', id: r.id, text: `${c.name} isn't on the clock for all of ${r.name}'s lunch` });
        else if (c.lunch != null && c.lunch < r.lunch + r.lunchLen && c.lunch + c.lunchLen > r.lunch)
          warnings.push({ kind: 'lunch', id: r.id, text: `${c.name} is covering ${r.name} during their own lunch` });
      }
    }

    const counts = {};
    for (const r of rows) counts[r.role] = (counts[r.role] || 0) + 1;
    return { ticks, slots, warnings, counts };
  }

  // Time is needed for warning text; fall back to a tiny formatter when loaded alone.
  const Time =
    (root.WS && root.WS.Time) ||
    (typeof require !== 'undefined' ? require('./time.js') : { hours: (a, b) => (b - a) / 60 });

  const api = {
    TICK,
    ROLES,
    SINGLE,
    POOL,
    isSingle,
    needsCover,
    COVERED,
    isPool,
    defaultSettings,
    mergeSettings,
    lunchLength,
    lunchOptions,
    lunchProblem,
    generate,
    assignCovers,
    analyze,
    nameKey,
    sortRows,
    ROLE_ORDER,
  };
  root.WS = root.WS || {};
  root.WS.Sched = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
