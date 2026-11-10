// A small in-memory stand-in for the Google Apps Script services that
// apps-script/Code.gs uses, so the sheet API can be tested with plain Node.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeSheet(name) {
  const sh = { name, rows: [], maxRows: 1000 };
  const ensure = (r) => { while (sh.rows.length < r) sh.rows.push([]); };
  sh.api = {
    getRange(r, c, nr = 1, nc = 1) {
      if (r + nr - 1 > sh.maxRows) throw new Error(`Range out of bounds on ${name}`);
      const range = {
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = sh.rows[r - 1 + i] || [];
            const o = [];
            for (let j = 0; j < nc; j++) o.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]);
            out.push(o);
          }
          return out;
        },
        setValues(v) {
          ensure(r + nr - 1);
          v.forEach((row, i) => row.forEach((x, j) => { sh.rows[r - 1 + i][c - 1 + j] = x; }));
          return range;
        },
        clearContent() {
          for (let i = 0; i < nr; i++) {
            const t = sh.rows[r - 1 + i];
            if (t) for (let j = 0; j < nc; j++) t[c - 1 + j] = '';
          }
          return range;
        },
        setNumberFormat: () => range,
        setFontWeight: () => range,
      };
      return range;
    },
    getLastRow() {
      for (let i = sh.rows.length; i > 0; i--) {
        if ((sh.rows[i - 1] || []).some((x) => x !== '' && x !== undefined)) return i;
      }
      return 0;
    },
    getMaxRows: () => sh.maxRows,
    insertRowsAfter(_, n) { sh.maxRows += n; },
    setFrozenRows() {},
  };
  return sh;
}

function loadGas() {
  const sheets = {};
  const cache = new Map();
  const ss = {
    getSheetByName: (n) => (sheets[n] ? sheets[n].api : null),
    insertSheet: (n) => { sheets[n] = makeSheet(n); return sheets[n].api; },
    getSpreadsheetTimeZone: () => 'Etc/UTC',
  };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss, flush() {} },
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 10), sleep() {} },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, v) }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (s) => ({ content: s, setMimeType() { return this; } }),
    },
    Logger: { log() {} },
  };
  vm.createContext(ctx);
  const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  vm.runInContext(`${code}\n;this.__api = { setup, doPost, doGet, appendObjects_ };`, ctx);

  const api = ctx.__api;
  const settingsRows = () => sheets.Settings.rows;
  return {
    sheets,
    cache,
    setup: api.setup,
    appendObjects: api.appendObjects_,
    accessCode: () => (settingsRows().find((r) => r[0] === 'access_code') || [])[1],
    setSetting(key, value) {
      const row = settingsRows().find((r) => r[0] === key);
      if (row) row[1] = value; else settingsRows().push([key, value]);
    },
    post(body) { return JSON.parse(api.doPost({ postData: { contents: JSON.stringify(body) } }).content); },
    get(params) { return JSON.parse(api.doGet({ parameter: params || {} }).content); },
  };
}

module.exports = { loadGas };
