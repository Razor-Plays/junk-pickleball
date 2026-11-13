/**
 * Junk Pickleball — sheet API for the mobile app.
 *
 * Works two ways:
 *   - bound to the app spreadsheet (Extensions > Apps Script), SHEET_ID empty
 *   - as a standalone script, with SHEET_ID set to the spreadsheet's id
 * It never touches the old "Attendance 2.0" sheet.
 *
 * One-time setup:
 *   1. Run `setup` once if the sheet has no tabs or no access code yet.
 *   2. Deploy > New deployment > Web app
 *        Execute as: Me      Who has access: Anyone
 *      Copy the /exec URL into app/config.js (or the app's setup screen).
 *
 * Every data request must include a code from the Settings tab:
 *   access_code  full access, for the people who run the club
 *   member_code  read-only: sessions, who played and bills. No changes, and
 *                no memberships, paybacks, kitty, Reclub fee or phone numbers.
 * The only thing served without it is the attendance-only stats feed, and
 * only while Settings > public_stats is TRUE.
 */

const API_VERSION = 6;

// Leave empty when this script is bound to the spreadsheet.
const SHEET_ID = '';

const MAX_FAILED_ATTEMPTS = 30;   // wrong access codes allowed ...
const FAILURE_WINDOW_SECONDS = 600; // ... within this rolling window

const TABS = {
  Players: ['name', 'role', 'active', 'phone', 'notes'],
  Sessions: ['id', 'date', 'reclub_fee', 'notes', 'updated_at', 'location', 'play_hours'],
  Bookings: ['session_id', 'member', 'hours', 'rate'],
  Attendance: ['session_id', 'name', 'guest', 'pays'],
  Memberships: ['id', 'member', 'date', 'amount', 'hours', 'rate', 'notes', 'kind', 'covers'],
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
  public_stats: 'TRUE',
  locations: 'Metro City Plaza Phase 3 | D-Park, Tsuen Wan | Tin Hau | Wong Chuk Hang',
};

function ss_() {
  return SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

function tz_() {
  return ss_().getSpreadsheetTimeZone();
}

// ---------------------------------------------------------------- setup

function setup() {
  const ss = ss_();
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
  if (!settings.access_code) toAdd.push(['access_code', newAccessCode_()]);
  if (!settings.member_code) toAdd.push(['member_code', newAccessCode_()]);
  if (toAdd.length) appendRows_('Settings', toAdd);

  Logger.log('Setup done. The access code is in the Settings tab (access_code). Change it there any time.');
}

/** 12 characters, no look-alikes (0/O, 1/l/I). Far too many to guess. */
function newAccessCode_() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 12; i++) {
    if (i && i % 4 === 0) out += '-';
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}

// ---------------------------------------------------------------- web entry points

function doGet(e) {
  const view = e && e.parameter && e.parameter.view;
  if (view === 'stats') return json_(publicStats_());
  return json_({ ok: true, app: 'junk-pickleball', version: API_VERSION });
}

/**
 * Attendance only: who played on which date. No money, no phone numbers,
 * no notes, and guests are shown as "Guest 1", "Guest 2"...
 */
function publicStats_() {
  const settings = readSettings_();
  if (String(settings.public_stats || '').toUpperCase() !== 'TRUE') {
    return { ok: false, error: 'Public stats are turned off' };
  }
  const dates = {};
  readTable_('Sessions').forEach(function (s) { dates[s.id] = s.date; });
  // A guest who later became a regular keeps their earlier visits under their name.
  const players = {};
  readTable_('Players').forEach(function (p) { players[nameKey_(p.name)] = p.name; });
  const guestCount = {};
  const rows = [];
  let latest = '';
  readTable_('Attendance').forEach(function (a) {
    const date = dates[a.session_id];
    if (!date) return;
    let name = a.name;
    const nowRegular = a.pays !== 'Reclub' && players[nameKey_(a.name)];
    if (nowRegular) {
      name = nowRegular;
    } else if (isTrue_(a.guest)) {
      guestCount[a.session_id] = (guestCount[a.session_id] || 0) + 1;
      name = 'Guest ' + guestCount[a.session_id];
    }
    if (date > latest) latest = date;
    rows.push({ session_date: date, session_id: a.session_id, player_name: name });
  });
  return { ok: true, club_name: settings.club_name || '', last_session: latest, rows: rows };
}

// Unique even for two saves in the same millisecond.
function newId_(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function nameKey_(v) {
  return String(v === null || v === undefined ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
}

function isTrue_(v) {
  return v === true || String(v).toUpperCase() === 'TRUE';
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Bad request' });
  }

  const cache = CacheService.getScriptCache();
  const failures = Number(cache.get('failed_attempts') || 0);
  if (failures >= MAX_FAILED_ATTEMPTS) {
    return json_({ ok: false, error: 'Too many wrong access codes. Try again in 10 minutes.', code: 'locked' });
  }
  const codes = readSettings_();
  const given = String(body.code || '').trim();
  const adminCode = String(codes.access_code || '').trim();
  const memberCode = String(codes.member_code || '').trim();
  const role = given && given === adminCode ? 'admin' : (given && memberCode && given === memberCode ? 'member' : '');
  if (!role) {
    cache.put('failed_attempts', String(failures + 1), FAILURE_WINDOW_SECONDS);
    Utilities.sleep(800); // slow down guessing
    return json_({ ok: false, error: 'Wrong access code', code: 'auth' });
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const handler = ACTIONS[body.action];
    if (!handler) return json_({ ok: false, error: 'Unknown action: ' + body.action });
    if (role === 'member') {
      // Members can look, nothing else. This is the real lock; the app hiding buttons is only tidiness.
      if (body.action !== 'load') return json_({ ok: false, error: 'This code is read-only.', code: 'readonly' });
      return json_({ ok: true, data: memberView_(loadAll_()) });
    }
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

  /** payload: { session: {id, date, reclub_fee, notes}, bookings: [...], attendance: [...], base_updated_at? } */
  saveSession: function (p) {
    const s = p.session || {};
    if (!s.id || !/^\d{4}-\d{2}-\d{2}$/.test(String(s.date || ''))) throw new Error('Session needs an id and a date');
    const id = String(s.id);
    const existing = readTable_('Sessions').filter(function (r) { return r.id === id; })[0];
    if (existing && p.base_updated_at !== undefined && String(existing.updated_at || '') !== String(p.base_updated_at || '')) {
      throw new Error('Someone else just changed this session. Refresh and try again.');
    }
    const row = {
      id: id,
      date: String(s.date),
      reclub_fee: s.reclub_fee === undefined || s.reclub_fee === '' ? Number(readSettings_().reclub_fee || 100) : Number(s.reclub_fee),
      notes: s.notes || '',
      updated_at: new Date().toISOString(),
      location: String(s.location || '').trim(),
      play_hours: Number(s.play_hours) > 0 ? Number(s.play_hours) : '',
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

  /**
   * payload: { originalName?, name, role, active, phone, notes, isNew? }
   * Renames update history too (this is also how a guest becomes a regular).
   * Names must be unique ignoring case and spacing, because bills are kept by name.
   */
  savePlayer: function (p) {
    const name = String(p.name || '').trim();
    if (!name) throw new Error('Player needs a name');
    const original = String(p.originalName || name).trim();
    const taken = readTable_('Players').filter(function (r) { return nameKey_(r.name) === nameKey_(name); });
    const clash = taken.some(function (r) { return r.name !== original; }) || (p.isNew && taken.length > 0);
    if (clash) throw new Error('There is already a player called ' + taken[0].name + '. Add a last initial to tell them apart.');
    if (original !== name) renameEverywhere_(original, name);
    upsertBy_('Players', 'name', name, {
      name: name,
      role: p.role === 'member' ? 'member' : 'player',
      active: p.active === false ? 'FALSE' : 'TRUE',
      phone: p.phone || '',
      notes: p.notes || '',
    });
  },

  /** payload: { member, date, amount, rate, hours?, notes?, kind: 'purchase' | 'balance', covers? } */
  saveMembership: function (p) {
    const kind = p.kind === 'balance' ? 'balance' : 'purchase';
    if (!p.member) throw new Error('Choose a member');
    if (kind === 'purchase' && !(Number(p.amount) > 0)) throw new Error('Enter the amount bought');
    if (kind === 'balance' && (p.amount === '' || p.amount === undefined || isNaN(Number(p.amount)))) throw new Error('Enter the balance');
    const id = p.id || newId_('m');
    const rate = Number(p.rate || 0);
    upsertBy_('Memberships', 'id', id, {
      id: id, member: p.member, date: p.date || today_(), amount: Number(p.amount),
      hours: kind === 'balance' ? 0 : Number(p.hours || (rate ? Number(p.amount) / rate : 0)),
      rate: rate, notes: p.notes || (kind === 'balance' ? 'Court balance check' : ''), kind: kind,
      covers: kind === 'balance' ? String(p.covers || '') : '',
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
      const paidOn = /^\d{4}-\d{2}-\d{2}$/.test(String(p.paid_on || '')) ? String(p.paid_on) : today_();
      appendObjects_('Payments', [{ month: month, person: person, amount: Number(p.amount || 0), paid_on: paidOn, note: p.note || '' }]);
    }
  },

  saveKitty: function (p) {
    if (!p.description) throw new Error('Kitty entry needs a description');
    const id = p.id || newId_('k');
    upsertBy_('Kitty', 'id', id, { id: id, date: p.date || today_(), description: p.description, amount: Number(p.amount || 0) });
  },

  deleteKitty: function (p) {
    deleteWhere_('Kitty', function (r) { return r.id === String(p.id); });
  },

  /** payload: { key: value, ... } — the access code can't be changed from the app. */
  saveSettings: function (p) {
    Object.keys(p).forEach(function (k) {
      if (k === 'access_code' || k === 'member_code') return;
      upsertBy_('Settings', 'key', k, { key: k, value: String(p[k]) });
    });
  },
};

// ---------------------------------------------------------------- read

function loadAll_() {
  const settings = readSettings_();
  delete settings.access_code;   // member_code stays: admins need it to share the member link
  return {
    version: API_VERSION,
    role: 'admin',
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

/**
 * What a member's phone is sent. Anything they shouldn't know is left out
 * here, on the server, so it can't be dug out of the app:
 *   - who booked which court (that, with the fees, is the payback), so
 *     bookings are merged into one "Courts" line per session
 *   - memberships (hours left), kitty, Reclub fee, settings other than names
 *   - phone numbers and notes, and payments made to members (paybacks)
 */
function memberView_(data) {
  const isMember = {};
  data.players.forEach(function (p) { if (p.role === 'member') isMember[p.name] = true; });
  const courts = {};
  data.bookings.forEach(function (b) {
    const c = courts[b.session_id] || (courts[b.session_id] = { hours: 0, cost: 0 });
    c.hours += Number(b.hours) || 0;
    c.cost += (Number(b.hours) || 0) * (Number(b.rate) || 0);
  });
  return {
    version: data.version,
    role: 'member',
    loaded_at: data.loaded_at,
    settings: { club_name: data.settings.club_name, currency: data.settings.currency, pay_to: data.settings.pay_to },
    players: data.players.map(function (p) { return { name: p.name, role: p.role, active: p.active }; }),
    sessions: data.sessions.map(function (s) { return { id: s.id, date: s.date, location: s.location, play_hours: s.play_hours }; }),
    bookings: Object.keys(courts).map(function (id) {
      const c = courts[id];
      return { session_id: id, member: 'Courts', hours: c.hours, rate: c.hours ? c.cost / c.hours : 0 };
    }),
    attendance: data.attendance,
    memberships: [],
    // Players' payments in full. For members only "settled": no payback amount or date.
    payments: data.payments.map(function (p) {
      return isMember[p.person]
        ? { month: p.month, person: p.person, amount: '', paid_on: '' }
        : { month: p.month, person: p.person, amount: p.amount, paid_on: p.paid_on };
    }),
    kitty: [],
  };
}

function readSettings_() {
  const out = {};
  readTable_('Settings').forEach(function (r) { if (r.key) out[r.key] = r.value; });
  return out;
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '" — run setup()');
  // A tab made before a column was added gets the new columns and headings on first use.
  const headers = TABS[name];
  if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
  const top = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  if (top[0] !== '' && top[headers.length - 1] === '') sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  return sh;
}

function readTable_(name) {
  const sh = sheet_(name);
  const headers = TABS[name];
  const last = sh.getLastRow();
  if (last < 2) return [];
  const tz = tz_();
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
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
