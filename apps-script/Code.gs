/**
 * Junk Pickleball — sheet API for the mobile app.
 *
 * This script lives inside the NEW app spreadsheet (Extensions > Apps Script).
 * It never touches the old "Attendance 2.0" sheet.
 *
 * One-time setup:
 *   1. Paste this file into the script editor and save.
 *   2. Run `setup` once (approve the permissions prompt). It creates any
 *      missing tabs and puts a random PIN in Settings > app_pin.
 *   3. Deploy > New deployment > Web app
 *        Execute as: Me      Who has access: Anyone
 *      Copy the /exec URL into the app's setup screen.
 *
 * Every request must include the PIN from the Settings tab.
 */

const API_VERSION = 1;

const TABS = {
  Players: ['name', 'role', 'active', 'phone', 'notes'],
  Sessions: ['id', 'date', 'reclub_fee', 'notes', 'updated_at'],
  Bookings: ['session_id', 'member', 'hours', 'rate'],
  Attendance: ['session_id', 'name', 'guest', 'pays'],
  Memberships: ['id', 'member', 'date', 'amount', 'hours', 'rate', 'notes'],
  Payments: ['month', 'person', 'amount', 'paid_on', 'note'],
  Kitty: ['id', 'date', 'description', 'amount'],
  Settings: ['key', 'value'],
};

// Columns kept as plain text so Sheets doesn't turn them into dates/numbers.
const TEXT_COLUMNS = ['id', 'session_id', 'date', 'month', 'paid_on', 'name', 'member', 'person', 'pays', 'phone', 'key', 'value'];

const DEFAULT_SETTINGS = {
  club_name: 'Junk Pickleball',
  default_rate: 140,
  reclub_fee: 100,
  currency: '$',
  pay_to: 'Tommy',
};

// ---------------------------------------------------------------- setup

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(TABS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const headers = TABS[name];
    const current = sh.getRange(1, 1, 1, headers.length).getValues()[0];
    if (current.join('') === '') {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    headers.forEach(function (h, i) {
      if (TEXT_COLUMNS.indexOf(h) >= 0) sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    });
  });

  const settings = readSettings_();
  const toAdd = [];
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    if (!(k in settings)) toAdd.push([k, String(DEFAULT_SETTINGS[k])]);
  });
  if (!settings.app_pin) toAdd.push(['app_pin', String(Math.floor(100000 + Math.random() * 900000))]);
  if (toAdd.length) appendRows_('Settings', toAdd);

  const pin = readSettings_().app_pin;
  Logger.log('Setup done. App PIN is ' + pin + ' (change it in the Settings tab any time).');
}

// ---------------------------------------------------------------- web entry points

function doGet() {
  return json_({ ok: true, app: 'junk-pickleball', version: API_VERSION });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Bad request' });
  }

  const settings = readSettings_();
  if (!settings.app_pin || String(body.pin || '') !== String(settings.app_pin)) {
    Utilities.sleep(800); // slow down guessing
    return json_({ ok: false, error: 'Wrong PIN', code: 'pin' });
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const handler = ACTIONS[body.action];
    if (!handler) return json_({ ok: false, error: 'Unknown action: ' + body.action });
    handler(body.payload || {});
    SpreadsheetApp.flush();
    return json_({ ok: true, data: loadAll_() });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- actions

const ACTIONS = {
  load: function () {},

  /** payload: { session: {id, date, reclub_fee, notes}, bookings: [...], attendance: [...] } */
  saveSession: function (p) {
    const s = p.session || {};
    if (!s.id || !/^\d{4}-\d{2}-\d{2}$/.test(String(s.date || ''))) throw new Error('Session needs an id and a date');
    const id = String(s.id);
    const row = {
      id: id,
      date: String(s.date),
      reclub_fee: s.reclub_fee === undefined || s.reclub_fee === '' ? Number(readSettings_().reclub_fee || 100) : Number(s.reclub_fee),
      notes: s.notes || '',
      updated_at: new Date().toISOString(),
    };
    upsertBy_('Sessions', 'id', id, row);
    replaceChildren_('Bookings', id, (p.bookings || []).filter(function (b) { return Number(b.hours) > 0; })
      .map(function (b) { return { session_id: id, member: b.member, hours: Number(b.hours), rate: Number(b.rate) }; }));
    replaceChildren_('Attendance', id, (p.attendance || []).map(function (a) {
      return { session_id: id, name: a.name, guest: a.guest ? 'TRUE' : 'FALSE', pays: a.pays || a.name };
    }));
  },

  deleteSession: function (p) {
    const id = String(p.id || '');
    if (!id) throw new Error('Missing session id');
    deleteWhere_('Sessions', function (r) { return r.id === id; });
    deleteWhere_('Bookings', function (r) { return r.session_id === id; });
    deleteWhere_('Attendance', function (r) { return r.session_id === id; });
  },

  /** payload: { originalName?, name, role, active, phone, notes } — renames update history too. */
  savePlayer: function (p) {
    const name = String(p.name || '').trim();
    if (!name) throw new Error('Player needs a name');
    const original = String(p.originalName || name).trim();
    if (original !== name) {
      const clash = readTable_('Players').some(function (r) { return r.name === name; });
      if (clash) throw new Error(name + ' already exists');
      renameEverywhere_(original, name);
    }
    upsertBy_('Players', 'name', name, {
      name: name,
      role: p.role === 'member' ? 'member' : 'player',
      active: p.active === false ? 'FALSE' : 'TRUE',
      phone: p.phone || '',
      notes: p.notes || '',
    });
  },

  saveMembership: function (p) {
    if (!p.member || !Number(p.hours)) throw new Error('Membership needs a member and hours');
    const id = p.id || 'm' + Date.now();
    upsertBy_('Memberships', 'id', id, {
      id: id, member: p.member, date: p.date || today_(), amount: Number(p.amount || 0),
      hours: Number(p.hours), rate: Number(p.rate || 0), notes: p.notes || '',
    });
  },

  deleteMembership: function (p) {
    deleteWhere_('Memberships', function (r) { return r.id === String(p.id); });
  },

  /** payload: { month, person, paid: bool, amount, note } */
  setPaid: function (p) {
    const month = String(p.month || ''), person = String(p.person || '');
    if (!/^\d{4}-\d{2}$/.test(month) || !person) throw new Error('Need month and person');
    deleteWhere_('Payments', function (r) { return r.month === month && r.person === person; });
    if (p.paid) {
      appendObjects_('Payments', [{ month: month, person: person, amount: Number(p.amount || 0), paid_on: today_(), note: p.note || '' }]);
    }
  },

  saveKitty: function (p) {
    if (!p.description) throw new Error('Kitty entry needs a description');
    const id = p.id || 'k' + Date.now();
    upsertBy_('Kitty', 'id', id, { id: id, date: p.date || today_(), description: p.description, amount: Number(p.amount || 0) });
  },

  deleteKitty: function (p) {
    deleteWhere_('Kitty', function (r) { return r.id === String(p.id); });
  },

  /** payload: { key: value, ... } — app_pin can't be changed from the app. */
  saveSettings: function (p) {
    Object.keys(p).forEach(function (k) {
      if (k === 'app_pin') return;
      upsertBy_('Settings', 'key', k, { key: k, value: String(p[k]) });
    });
  },
};

// ---------------------------------------------------------------- read

function loadAll_() {
  const settings = readSettings_();
  delete settings.app_pin;
  return {
    version: API_VERSION,
    loaded_at: new Date().toISOString(),
    settings: settings,
    players: readTable_('Players'),
    sessions: readTable_('Sessions'),
    bookings: readTable_('Bookings'),
    attendance: readTable_('Attendance'),
    memberships: readTable_('Memberships'),
    payments: readTable_('Payments'),
    kitty: readTable_('Kitty'),
  };
}

function readSettings_() {
  const out = {};
  readTable_('Settings').forEach(function (r) { if (r.key) out[r.key] = r.value; });
  return out;
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '" — run setup()');
  return sh;
}

function readTable_(name) {
  const sh = sheet_(name);
  const headers = TABS[name];
  const last = sh.getLastRow();
  if (last < 2) return [];
  const tz = Session.getScriptTimeZone();
  const values = sh.getRange(2, 1, last - 1, headers.length).getValues();
  return values
    .filter(function (row) { return row.join('') !== ''; })
    .map(function (row) {
      const o = {};
      headers.forEach(function (h, i) {
        let v = row[i];
        if (v instanceof Date) v = Utilities.formatDate(v, tz, h === 'month' ? 'yyyy-MM' : 'yyyy-MM-dd');
        if (typeof v === 'string') v = v.trim();
        o[h] = v;
      });
      return o;
    });
}

// ---------------------------------------------------------------- write helpers

function toRow_(name, obj) {
  return TABS[name].map(function (h) { return obj[h] === undefined || obj[h] === null ? '' : obj[h]; });
}

function writeTable_(name, rows) {
  const sh = sheet_(name);
  const width = TABS[name].length;
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, width).clearContent();
  if (!rows.length) return;
  const need = rows.length + 1;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  formatTextColumns_(sh, name, 2, rows.length);
  sh.getRange(2, 1, rows.length, width).setValues(rows.map(function (r) { return toRow_(name, r); }));
}

function appendObjects_(name, objs) {
  appendRows_(name, objs.map(function (o) { return toRow_(name, o); }));
}

function appendRows_(name, rows) {
  if (!rows.length) return;
  const sh = sheet_(name);
  const start = Math.max(sh.getLastRow(), 1) + 1;
  const need = start + rows.length - 1;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  formatTextColumns_(sh, name, start, rows.length);
  sh.getRange(start, 1, rows.length, TABS[name].length).setValues(rows);
}

function formatTextColumns_(sh, name, startRow, count) {
  TABS[name].forEach(function (h, i) {
    if (TEXT_COLUMNS.indexOf(h) >= 0) sh.getRange(startRow, i + 1, count, 1).setNumberFormat('@');
  });
}

function upsertBy_(name, key, value, obj) {
  const rows = readTable_(name);
  let found = false;
  const next = rows.map(function (r) {
    if (String(r[key]) === String(value)) { found = true; return obj; }
    return r;
  });
  if (found) writeTable_(name, next);
  else appendObjects_(name, [obj]);
}

function deleteWhere_(name, predicate) {
  const rows = readTable_(name);
  const keep = rows.filter(function (r) { return !predicate(r); });
  if (keep.length !== rows.length) writeTable_(name, keep);
}

function replaceChildren_(name, sessionId, children) {
  const keep = readTable_(name).filter(function (r) { return r.session_id !== sessionId; });
  writeTable_(name, keep.concat(children));
}

function renameEverywhere_(from, to) {
  [['Bookings', ['member']], ['Attendance', ['name', 'pays']], ['Memberships', ['member']],
   ['Payments', ['person']], ['Players', ['name']]].forEach(function (pair) {
    const rows = readTable_(pair[0]);
    let changed = false;
    rows.forEach(function (r) {
      pair[1].forEach(function (col) { if (r[col] === from) { r[col] = to; changed = true; } });
    });
    if (changed) writeTable_(pair[0], rows);
  });
}

function today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
