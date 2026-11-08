/* Reads Excel / CSV files (free SheetJS library) into text lines for the parser. */
(function (root) {
  'use strict';

  function cellText(v) {
    if (typeof v === 'number') {
      // Excel stores times as a fraction of a day (0.25 = 6:00 AM); date+time cells are big numbers
      if ((v > 0 && v < 1) || (v > 20000 && !Number.isInteger(v))) {
        const frac = v - Math.floor(v);
        return root.WS.Time.fmt(Math.round(frac * 1440));
      }
      return String(v);
    }
    return String(v == null ? '' : v).trim();
  }

  const Sheet = {
    isSheet(file) {
      return /\.(xlsx|xlsm|xls|csv|ods)$/i.test(file.name || '') || /spreadsheet|excel|csv/i.test(file.type || '');
    },
    async readFile(file) {
      if (!root.XLSX) throw new Error('The Excel reader did not load. Check the internet connection and refresh.');
      const wb = root.XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const lines = [];
      for (const name of wb.SheetNames) {
        const rows = root.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
        for (const row of rows) lines.push(row.map(cellText).join('   '));
      }
      return lines;
    },
  };

  root.WS = root.WS || {};
  root.WS.Sheet = Sheet;
})(typeof window !== 'undefined' ? window : globalThis);
