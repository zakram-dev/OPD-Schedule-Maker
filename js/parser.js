/*
 * Turns lines of text (from the photo reader or pasted) into shifts.
 * Handles "Name 5:00 AM 2:00 PM", "Name 5:00a-2:00p", "Name 5am - 2pm",
 * a name on one line with the time on the next, and "Last, First".
 */
(function (root) {
  'use strict';
  const IGNORE = new Set(
    ('name names associate associates start end hours hrs hr lunch meal break breaks assignment task shift shifts ' +
      'schedule team total time in out am pm to department dept job role pick disp br prep sm exp pr tl draft roster ' +
      'revised complete updated off scheduled').split(' ')
  );
  // A line is a date/heading (not a name) when it looks like "Thu, Nov 6", "Friday November 6th",
  // "11/06", or is just a weekday. Names like "May L", "Declan R", "June K" must still count as names.
  const DATE_NUM = /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+\d{1,2}(st|nd|rd|th)?\b|\b\d{1,2}\/\d{1,2}\b/i;
  const WEEKDAY = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
  const isDateLine = (s) =>
    DATE_NUM.test(s) ||
    (WEEKDAY.test(s) && /[,\d]/.test(s)) ||
    /^\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|yesterday|this week|next week)\s*$/i.test(s);
  // 5:00 AM · 5am · 5:00a · 17:00 · also "530AM" (photo reader dropped the colon)
  const TOKEN = /(\d{1,2})(?::(\d{2})|(\d{2})(?=\s?[ap]))?\s?(a\.?m?\.?|p\.?m?\.?)?(?![a-z0-9])/gi;

  const letters = (s) => (s.match(/[A-Za-zÀ-ɏ]/g) || []).length;

  function fixDigits(s) {
    return s.replace(/[Oo]/g, '0').replace(/[Ss]/g, '5').replace(/[Il|]/g, '1');
  }

  function normalizeLine(s) {
    s = String(s || '')
      .replace(/[—–~]/g, '-')
      .replace(/[|[\]{}_]/g, ' ');
    // common photo-reading slips inside times: 5:0O, S:00, 1l:30
    s = s.replace(/(^|[^A-Za-z0-9])([0-9OoSsIl]{1,2})[:.;,]([0-9OoSsIl]{2})(?![0-9])/g, (m, pre, a, b) =>
      /\d/.test(a + b) ? pre + fixDigits(a) + ':' + fixDigits(b) : m
    );
    return s;
  }

  function findTimes(line) {
    const toks = [];
    TOKEN.lastIndex = 0;
    let m;
    while ((m = TOKEN.exec(line))) {
      const h = +m[1];
      const mins = m[2] != null ? m[2] : m[3];
      const mm = mins != null ? +mins : 0;
      const ap = m[4] ? m[4][0].toLowerCase() : null;
      if (mins == null && !ap) continue; // a bare number (hours column), not a time
      if (h > 23 || mm > 59 || (ap && (h < 1 || h > 12))) continue;
      toks.push({ h, mm, ap, index: m.index, endIndex: m.index + m[0].length });
    }
    return toks;
  }

  const to24 = (h, mm, ap) => (ap === 'a' ? (h % 12) * 60 + mm : ((h % 12) + 12) * 60 + mm);

  function resolveStart(t) {
    if (t.ap) return to24(t.h, t.mm, t.ap);
    if (t.h >= 13 || t.h === 0) return t.h * 60 + t.mm;
    if (t.h === 12) return 720 + t.mm;
    if (t.h >= 5) return t.h * 60 + t.mm; // 5–11 → morning
    return (t.h + 12) * 60 + t.mm; // 1–4 → afternoon
  }
  function resolveEnd(t, start) {
    if (t.ap) return to24(t.h, t.mm, t.ap);
    if (t.h >= 13) return t.h * 60 + t.mm;
    const a = (t.h % 12) * 60 + t.mm;
    if (a > start && a - start <= 14 * 60) return a;
    return a + 720;
  }

  function titleCase(s) {
    return s.replace(/[A-Za-zÀ-ɏ][^\s-]*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  }

  function cleanName(s) {
    let x = String(s || '').replace(/\(?\s*\bTL\b\s*\)?/g, ' ');
    const comma = /^\s*([A-Za-z' -]{2,}),\s*([A-Za-z' .-]{2,})\s*$/.exec(x);
    if (comma) x = comma[2] + ' ' + comma[1];
    x = x.replace(/[^A-Za-zÀ-ɏ' .-]/g, ' ').replace(/\s+/g, ' ').trim();
    // the photo reader sometimes glues a last initial on: "JonC" -> "Jon C", "EliH." -> "Eli H."
    x = x.replace(/\b([A-Z][a-z]{1,})([A-Z]\.?)(?=\s|$)/g, '$1 $2');
    // ...and reads a capital I as a small l: "lan" -> "Ian", "lsabel" -> "Isabel"
    let words = x
      .split(' ')
      .filter((w) => letters(w) > 0)
      .map((w) => (/^l[a-z]{2,}$/.test(w) ? 'I' + w.slice(1) : w));
    words = words.filter((w) => !IGNORE.has(w.toLowerCase().replace(/[^a-z]/g, '')));
    // drop stray single letters the photo reader adds at the edges ("e Alice", "| Alice" read as "I"),
    // but keep a last-name initial: "Alice T", "Alice T."
    while (words.length && letters(words[0]) < 2 && (/^[a-zI]\W*$/.test(words[0]) || !/[A-Z]/.test(words[0]))) words.shift();
    while (words.length > 1 && letters(words[words.length - 1]) < 2 && !/^[A-ZÀ-Þ]\.?$/.test(words[words.length - 1])) words.pop();
    x = words.join(' ').replace(/^[.'-]+|[-']+$/g, '');
    if (x && x === x.toUpperCase()) x = titleCase(x);
    return x;
  }

  function parseLines(lines) {
    const out = [];
    let pending = null;
    for (const raw of lines) {
      const line = normalizeLine(raw);
      if (!line.trim()) continue;
      let toks = findTimes(line);
      const isTL = /\bTL\b|team\s*lead/i.test(line);
      if (toks.length < 2) {
        // bare hours like "Tyriq 1-6"
        const b = /(^|\s)(\d{1,2})\s*(?:-|to)\s*(\d{1,2})(?=\s|$)/i.exec(line);
        if (b && +b[2] <= 23 && +b[3] <= 23) {
          const at = b.index + b[1].length;
          toks = [
            { h: +b[2], mm: 0, ap: null, index: at, endIndex: at },
            { h: +b[3], mm: 0, ap: null, index: at, endIndex: at },
          ];
        }
      }
      if (toks.length < 2) {
        const nm = cleanName(line);
        if (nm && letters(nm) >= 2 && !isDateLine(line)) pending = { name: nm, isTL };
        else if (isDateLine(line)) pending = null;
        continue;
      }
      // the shift is the first two times sitting next to each other ("5:00 AM 2:00 PM",
      // "5a - 2p"); later pairs on the line are usually the lunch column
      let pair = null;
      for (let i = 0; i + 1 < toks.length && !pair; i++) {
        const between = line.slice(toks[i].endIndex, toks[i + 1].index);
        if (/^[\s-]*(to|until|thru)?[\s-]*$/i.test(between)) pair = [toks[i], toks[i + 1]];
      }
      if (!pair) pair = [toks[0], toks[1]];

      let start = resolveStart(pair[0]);
      let end = resolveEnd(pair[1], start);
      if (end <= start && !pair[0].ap && start >= 720) start -= 720;
      // a backwards / overnight shift is kept (shown in red for the lead to fix) rather than silently lost
      if (end - start > 16 * 60) continue;

      let name = cleanName(line.slice(0, pair[0].index));
      let tl = isTL;
      if (letters(name) < 2 && pending) {
        name = pending.name;
        tl = tl || pending.isTL;
      }
      pending = null;
      out.push({ name: letters(name) >= 2 ? name : '', start, end, isTL: tl });
    }
    return out;
  }

  const parseText = (text) => parseLines(String(text || '').split(/\r?\n/));

  root.WS = root.WS || {};
  root.WS.Parser = { parseLines, parseText, cleanName, normalizeLine };
  if (typeof module !== 'undefined') module.exports = root.WS.Parser;
})(typeof window !== 'undefined' ? window : globalThis);
