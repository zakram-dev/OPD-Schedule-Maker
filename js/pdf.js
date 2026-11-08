/*
 * Reads PDF schedules with the free PDF.js library.
 * - PDFs with real text (exported from an app, Excel, Word) are read directly: fast and exact.
 * - Scanned PDFs (just a picture of paper) are drawn to an image and sent to the photo reader.
 */
(function (root) {
  'use strict';
  const WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const MAX_PAGES = 30;

  /** Join PDF text pieces that sit on the same row, left to right. */
  function linesFromText(items) {
    const its = items
      .filter((i) => i && typeof i.str === 'string' && i.str.trim() && i.transform)
      .map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0, h: Math.abs(i.transform[3]) || i.height || 10 }))
      .sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    for (const it of its) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(row.y - it.y) < Math.max(2, 0.5 * Math.max(row.h, it.h))) {
        row.items.push(it);
        row.h = Math.max(row.h, it.h);
      } else rows.push({ y: it.y, h: it.h, items: [it] });
    }
    return rows.map((r) => {
      const parts = r.items.sort((a, b) => a.x - b.x);
      let out = '';
      let prevEnd = null;
      for (const p of parts) {
        const gap = prevEnd == null ? 0 : p.x - prevEnd;
        out += (prevEnd != null && gap > 0.15 * p.h ? '   ' : '') + p.s;
        prevEnd = p.x + p.w;
      }
      return out;
    });
  }

  const Pdf = {
    isPdf(file) {
      return /\.pdf$/i.test(file.name || '') || file.type === 'application/pdf';
    },
    /** onProgress(fraction 0..1, label). Returns text lines from every page. */
    async readFile(file, onProgress) {
      const lib = root.pdfjsLib;
      if (!lib) throw new Error('The PDF reader did not load. Check the internet connection and refresh the page.');
      lib.GlobalWorkerOptions.workerSrc = root.WS_VENDOR ? new URL(root.WS_VENDOR + 'pdf.worker.min.js', root.location.href).href : WORKER;
      let pdf;
      try {
        pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      } catch (e) {
        if (e && e.name === 'PasswordException') throw new Error(`${file.name} is password-protected. Remove the password and try again.`);
        throw new Error(`${file.name} isn’t a readable PDF (it may be damaged).`);
      }
      const pages = Math.min(pdf.numPages, MAX_PAGES);
      const lines = [];
      for (let p = 1; p <= pages; p++) {
        onProgress && onProgress((p - 1) / pages, 'Reading PDF page ' + p + ' of');
        const page = await pdf.getPage(p);
        const text = linesFromText((await page.getTextContent()).items);
        if (text.join('').replace(/[^A-Za-z]/g, '').length >= 15) {
          lines.push(...text);
          continue;
        }
        // no real text on this page: it's a scan, so read it like a photo
        const base = page.getViewport({ scale: 1 });
        const scale = Math.max(1, Math.min(3, 1800 / base.width));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const g = canvas.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: g, viewport }).promise;
        const read = await root.WS.OCR.recognizeCanvas(canvas, (f) => onProgress && onProgress((p - 1 + f) / pages, 'Reading scanned page ' + p + ' of'));
        lines.push(...read);
      }
      return lines;
    },
    _linesFromText: linesFromText,
  };

  root.WS = root.WS || {};
  root.WS.Pdf = Pdf;
})(typeof window !== 'undefined' ? window : globalThis);
