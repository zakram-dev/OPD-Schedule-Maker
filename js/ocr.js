/*
 * Free photo reading with Tesseract.js (runs in the browser, nothing is uploaded
 * to a paid service). The first use downloads the English reading model (~10 MB),
 * after that the browser caches it.
 */
(function (root) {
  'use strict';

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        const heic = /heic|heif/i.test(file.type || '') || /\.(heic|heif)$/i.test(file.name || '');
        reject(
          new Error(
            heic
              ? `${file.name} is an iPhone HEIC photo, which browsers can’t open. Use a screenshot (PNG) or a JPG instead.`
              : `Could not open ${file.name || 'the image'}. Is it a real picture file?`
          )
        );
      };
      img.src = url;
    });
  }

  /** Draw an image onto a canvas at a size the reader likes. */
  async function imageToCanvas(file) {
    const img = await loadImage(file);
    if (!img.naturalWidth || !img.naturalHeight) throw new Error(`${file.name} looks empty.`);
    const scale = Math.min(2.5, Math.max(1, 1600 / img.naturalWidth));
    // keep the canvas under ~40 megapixels so phones don't run out of memory
    const fit = Math.min(1, Math.sqrt(40e6 / (img.naturalWidth * img.naturalHeight * scale * scale)));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale * fit));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale * fit));
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  /** Grayscale, and flip dark-mode screenshots to dark-on-light. */
  function clean(c) {
    const g = c.getContext('2d', { willReadFrequently: true });
    const data = g.getImageData(0, 0, c.width, c.height);
    const px = data.data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) {
      const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      px[i] = px[i + 1] = px[i + 2] = y;
      sum += y;
    }
    if (sum / (px.length / 4) < 110) for (let i = 0; i < px.length; i += 4) px[i] = px[i + 1] = px[i + 2] = 255 - px[i];
    g.putImageData(data, 0, 0);
    return c;
  }

  /** Words with their confidence and position (canvas pixels). */
  function wordItems(data, dx) {
    const out = [];
    const push = (w) => {
      if (!w || !w.bbox || !w.text || !w.text.trim()) return;
      const b = w.bbox;
      out.push({ text: w.text.trim(), conf: w.confidence, x0: b.x0 + (dx || 0), x1: b.x1 + (dx || 0), y0: b.y0, y1: b.y1, yc: (b.y0 + b.y1) / 2, h: b.y1 - b.y0 });
    };
    for (const bl of data.blocks || []) for (const p of bl.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) push(w);
    if (!out.length && data.words) data.words.forEach(push);
    return out;
  }

  /** Tesseract's own lines, as rows of words. */
  function lineRows(data) {
    const rows = [];
    for (const bl of data.blocks || [])
      for (const p of bl.paragraphs || [])
        for (const l of p.lines || []) {
          const items = wordItems({ blocks: [{ paragraphs: [{ lines: [l] }] }] });
          if (items.length) rows.push(makeRow(items));
        }
    return rows;
  }

  /** Words grouped by height on the page, so "name ........ time" columns join into one row. */
  function groupRows(items) {
    const sorted = items.filter((w) => w.conf > 20).sort((a, b) => a.yc - b.yc);
    const groups = [];
    for (const it of sorted) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(it.yc - g.yc) < Math.max(8, 0.55 * Math.max(it.h, g.h))) {
        g.items.push(it);
        g.yc = (g.yc * (g.items.length - 1) + it.yc) / g.items.length;
        g.h = Math.max(g.h, it.h);
      } else groups.push({ yc: it.yc, h: it.h, items: [it] });
    }
    return groups.map((g) => makeRow(g.items));
  }

  const minConf = (items) => (items.length ? Math.min(...items.map((i) => i.conf)) : 100);

  /** A row of words → {text, nameConf, timeConf} for the parser, plus its geometry. */
  function makeRow(items) {
    items = items.slice().sort((a, b) => a.x0 - b.x0);
    const t = items.findIndex((i) => /\d/.test(i.text));
    const nameItems = t < 0 ? items : items.slice(0, t);
    const timeItems = t < 0 ? [] : items.slice(t);
    return {
      items,
      y0: Math.min(...items.map((i) => i.y0)),
      y1: Math.max(...items.map((i) => i.y1)),
      h: Math.max(...items.map((i) => i.h)),
      line: { text: items.map((i) => i.text).join(' '), nameConf: minConf(nameItems), timeConf: minConf(timeItems) },
    };
  }

  /**
   * Second look at the time column: read only that strip, allowing just digits, ":", "AM", "PM"
   * and "-". Fixes O/0, S/5, l/1 and B/8 mix-ups, and finds times the first pass missed.
   */
  async function rereadTimes(canvas, rows) {
    const P = root.WS.Parser;
    const shift = (line) => P.parseLines([line], { halfHours: true })[0];
    const xs = rows
      .filter((r) => shift(r.line))
      .map((r) => (r.items.find((i) => /\d/.test(i.text)) || {}).x0)
      .filter((x) => x != null)
      .sort((a, b) => a - b);
    if (xs.length < 2) return;
    const colX = xs[Math.floor(xs.length / 2)];
    const left = Math.max(0, Math.round(colX - 0.04 * canvas.width));
    const crop = document.createElement('canvas');
    crop.width = canvas.width - left;
    crop.height = canvas.height;
    crop.getContext('2d').drawImage(canvas, left, 0, crop.width, crop.height, 0, 0, crop.width, crop.height);
    const worker = await getTimeWorker();
    const data = (await worker.recognize(crop, {}, { blocks: true })).data;
    const times = wordItems(data, left);
    // each reread word belongs to the one row it sits closest to (never to a sub-line under it)
    const owner = new Map();
    for (const w of times) {
      let best = null;
      let bd = Infinity;
      for (const r of rows) {
        const pad = 0.25 * r.h;
        if (w.yc < r.y0 - pad || w.yc > r.y1 + pad) continue;
        const dist = Math.abs(w.yc - (r.y0 + r.y1) / 2);
        if (dist < bd) {
          bd = dist;
          best = r;
        }
      }
      if (best) owner.set(best, (owner.get(best) || []).concat(w));
    }
    for (const r of rows) {
      const mine = (owner.get(r) || []).sort((a, b) => a.x0 - b.x0);
      if (!mine.length) continue;
      const nameItems = r.items.filter((i) => i.x1 < left + 0.02 * canvas.width && !/\d/.test(i.text));
      const cand = {
        text: nameItems.map((i) => i.text).join(' ') + '   ' + mine.map((i) => i.text).join(' '),
        nameConf: minConf(nameItems),
        timeConf: minConf(mine),
      };
      const a = shift(r.line);
      const b = shift(cand);
      if (!b) continue;
      if (!a) r.line = cand; // the first pass missed this row's times
      else if (a.start !== b.start || a.end !== b.end) {
        if (cand.timeConf > r.line.timeConf) r.line = Object.assign({}, cand, { nameConf: r.line.nameConf, text: r.line.text.slice(0, r.line.text.search(/\d/)) + '   ' + mine.map((i) => i.text).join(' ') });
      } else r.line.timeConf = Math.max(r.line.timeConf, cand.timeConf); // both readings agree
    }
  }

  let listener = null;
  let workerPromise = null;
  function getWorker() {
    if (!root.Tesseract) throw new Error('The photo reader did not load. Check the internet connection and refresh the page.');
    if (!workerPromise) {
      // On the production server the reading engine is bundled (vendor/); otherwise use the CDN defaults.
      const V = root.WS_VENDOR;
      const abs = (p) => new URL(p, root.location.href).href;
      const opts = { logger: (m) => listener && listener(m) };
      if (V) Object.assign(opts, { workerPath: abs(V + 'worker.min.js'), corePath: abs(V + 'tesseract-core'), langPath: abs(V + 'lang') });
      workerPromise = root.Tesseract.createWorker('eng', 1, opts)
        .then(async (w) => {
          await w.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
          return w;
        })
        .catch((e) => {
          workerPromise = null; // let the next try start over
          throw new Error('The photo reader could not start (' + (e && e.message ? e.message : e) + '). Check the internet connection.');
        });
    }
    return workerPromise;
  }

  // A second reader that only knows the characters times use. Kept separate so its limits
  // never affect how names are read.
  let timeWorkerPromise = null;
  function getTimeWorker() {
    if (!timeWorkerPromise) {
      const V = root.WS_VENDOR;
      const abs = (p) => new URL(p, root.location.href).href;
      const opts = { logger: (m) => listener && listener(m) };
      if (V) Object.assign(opts, { workerPath: abs(V + 'worker.min.js'), corePath: abs(V + 'tesseract-core'), langPath: abs(V + 'lang') });
      timeWorkerPromise = root.Tesseract.createWorker('eng', 1, opts)
        .then(async (w) => {
          await w.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1', tessedit_char_whitelist: '0123456789:APMapm.- ' });
          return w;
        })
        .catch((e) => {
          timeWorkerPromise = null;
          throw e;
        });
    }
    return timeWorkerPromise;
  }

  const OCR = {
    /**
     * Read a canvas. onProgress(fraction, label). Returns lines as {text, nameConf, timeConf}
     * (confidence 0–100), which the parser accepts like plain strings.
     */
    async recognizeCanvas(canvas, onProgress) {
      listener = (m) => onProgress && onProgress(m.progress || 0, m.status === 'recognizing text' ? 'Reading' : 'Loading photo reader');
      try {
        const worker = await getWorker();
        const page = clean(canvas);
        const { data } = await worker.recognize(page, {}, { text: true, blocks: true });
        // Two readings of the same page: Tesseract's own lines, and words re-joined by row
        // (better when names and times sit in far-apart columns). Keep the one that finds more people.
        const P = root.WS.Parser;
        const byLine = lineRows(data);
        const byRow = groupRows(wordItems(data));
        const count = (rows) => P.parseLines(rows.map((r) => r.line)).length;
        const rows = byRow.length && count(byRow) > count(byLine) ? byRow : byLine;
        listener = (m) => onProgress && onProgress(m.progress || 0, 'Double-checking times on');
        try {
          await rereadTimes(page, rows);
        } catch (e) {
          console.warn('Time double-check skipped', e);
        }
        return rows.map((r) => r.line);
      } finally {
        listener = null;
      }
    },
    /** Read one picture file. */
    async readImage(file, onProgress) {
      onProgress && onProgress(0, 'Preparing');
      return OCR.recognizeCanvas(await imageToCanvas(file), onProgress);
    },
  };

  root.WS = root.WS || {};
  root.WS.OCR = OCR;
})(typeof window !== 'undefined' ? window : globalThis);
