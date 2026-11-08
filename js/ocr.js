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

  /** Group words that sit on the same row, so "name ... time" columns join into one line. */
  function rowsFromWords(words) {
    const items = words
      .filter((w) => w.text && w.text.trim() && w.confidence > 20 && w.bbox)
      .map((w) => ({ text: w.text.trim(), x: w.bbox.x0, yc: (w.bbox.y0 + w.bbox.y1) / 2, h: w.bbox.y1 - w.bbox.y0 }))
      .sort((a, b) => a.yc - b.yc);
    const rows = [];
    for (const it of items) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(it.yc - row.yc) < Math.max(8, 0.55 * Math.max(it.h, row.h))) {
        row.items.push(it);
        row.yc = (row.yc * (row.items.length - 1) + it.yc) / row.items.length;
        row.h = Math.max(row.h, it.h);
      } else rows.push({ yc: it.yc, h: it.h, items: [it] });
    }
    return rows.map((r) => r.items.sort((a, b) => a.x - b.x).map((i) => i.text).join(' '));
  }

  function collectWords(data) {
    const words = [];
    for (const b of data.blocks || [])
      for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) words.push(w);
    if (!words.length && data.words) words.push(...data.words);
    return words;
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

  const OCR = {
    /** Read a canvas. onProgress(fraction, label). Returns text lines. */
    async recognizeCanvas(canvas, onProgress) {
      listener = (m) => onProgress && onProgress(m.progress || 0, m.status === 'recognizing text' ? 'Reading' : 'Loading photo reader');
      try {
        const worker = await getWorker();
        const { data } = await worker.recognize(clean(canvas), {}, { text: true, blocks: true });
        // Two readings of the same page: Tesseract's own lines, and words re-joined by row
        // (better when names and times sit in far-apart columns). Keep the one that finds more people.
        const textLines = String(data.text || '').split('\n');
        const words = collectWords(data);
        const rowLines = words.length ? rowsFromWords(words) : [];
        const P = root.WS.Parser;
        return rowLines.length && P.parseLines(rowLines).length > P.parseLines(textLines).length ? rowLines : textLines;
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
