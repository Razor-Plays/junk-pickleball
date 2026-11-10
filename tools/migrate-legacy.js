#!/usr/bin/env node
/*
 * One-off converter: "Junk Pickleball Attendance 2.0" (wide grid sheet)
 * -> the table layout used by the app (see apps-script/Code.gs).
 *
 * Usage:
 *   node tools/migrate-legacy.js legacy.json > migrated.json
 *
 * legacy.json (exported from the old sheet; not committed because it holds
 * people's data):
 * {
 *   "members": ["Big Kim", "Tommy", "Kevin", "Neil"],      // Court Bookings D:G order
 *   "rate": 140,
 *   "rows": [{ "row": 3, "serial": 45757, "hours": [1,1,0,0] }, ...],
 *   "attendance": { "3": ["Big Kim", "Cake", ...], ... }, // Attendance D:S by sheet row
 *   "comments": [{ "row": 85, "col": "J", "label": "Reclub", "status": "OPEN" }],
 *   "reclubCounts": { "2026-01-14": 3, ... },             // from the Reclub Payments tab
 *   "players": ["Andrew", "Big Kim", ...],                 // Data!B (guest slots are skipped)
 *   "memberships": [{ "member": "Big Kim", "date": "2025-04-10", "amount": 11000, "hours": 79, "rate": 140 }]
 * }
 */
'use strict';

const fs = require('fs');

const COLS = 'DEFGHIJKLMNOPQRS';
const GUEST_SLOT = /^guest\s*\d+$/i;

function serialToISO(serial) {
  const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
  return d.toISOString().slice(0, 10);
}

/** "Foong's friend Jeremy" -> { name: 'Jeremy', pays: 'Foong' } etc. */
function parseGuestLabel(label, knownPlayers) {
  const text = String(label || '').trim();
  if (!text) return null;
  if (/^re\s*cl+u+l?b/i.test(text)) return { name: 'Reclub guest', pays: 'Reclub' };

  // "<Host>'s friend <Name>", "<Host> friend - <Name>", "<Host>'s Friend"
  const m = text.match(/^(.+?)(?:'s|’s)?\s+friend\b\s*[-–:]?\s*(.*)$/i);
  if (m) {
    const host = m[1].trim();
    const name = m[2].trim() || `${host}'s friend`;
    if (knownPlayers.has(host)) return { name, pays: host };
    return { name, pays: name };
  }
  // A plain name: the guest paid for themselves.
  return { name: text, pays: text };
}

function migrate(legacy) {
  const members = legacy.members;
  const rate = legacy.rate;
  const knownPlayers = new Set((legacy.players || []).filter((p) => !GUEST_SLOT.test(p)));
  for (const m of members) knownPlayers.add(m);

  const commentAt = new Map();
  for (const c of legacy.comments || []) {
    if (String(c.status).toUpperCase() === 'RESOLVED') continue;
    commentAt.set(`${c.row}:${c.col}`, c.label);
  }

  const sessions = [];
  const bookings = [];
  const attendance = [];
  const notes = [];
  const usedIds = new Set();

  for (const r of legacy.rows) {
    const date = serialToISO(r.serial);
    const names = (legacy.attendance[String(r.row)] || []).map((n) => String(n).trim());
    const hasHours = r.hours.some((h) => Number(h) > 0);
    if (!hasHours && names.filter(Boolean).length === 0) continue;

    let id = `s${date.replace(/-/g, '')}`;
    let n = 2;
    while (usedIds.has(id)) id = `s${date.replace(/-/g, '')}-${n++}`;
    usedIds.add(id);

    sessions.push({ id, date, reclub_fee: legacy.reclubFee || 100, notes: `imported from sheet row ${r.row}` });

    r.hours.forEach((h, i) => {
      if (Number(h) > 0) bookings.push({ session_id: id, member: members[i], hours: Number(h), rate });
    });

    // First pass: guests labelled by a comment.
    const rows = [];
    names.forEach((name, i) => {
      if (!name) return;
      if (!GUEST_SLOT.test(name)) {
        rows.push({ session_id: id, name, guest: false, pays: name });
        return;
      }
      const label = commentAt.get(`${r.row}:${COLS[i]}`);
      const parsed = parseGuestLabel(label, knownPlayers);
      rows.push(parsed
        ? { session_id: id, name: parsed.name, guest: true, pays: parsed.pays, _slot: name }
        : { session_id: id, name, guest: true, pays: 'Unassigned', _slot: name });
    });

    // Second pass: the Reclub Payments tab says how many Reclub players came.
    // Unlabelled guest slots are filled in order. All guests in a session cost
    // the same, so which slot gets the label doesn't change any money.
    const want = (legacy.reclubCounts || {})[date] || 0;
    let have = rows.filter((x) => x.pays === 'Reclub').length;
    for (const x of rows) {
      if (have >= want) break;
      if (x.guest && x.pays === 'Unassigned') {
        x.name = 'Reclub guest';
        x.pays = 'Reclub';
        have++;
      }
    }
    if (want && have !== want) {
      notes.push(`${date}: Reclub Payments says ${want} Reclub players, attendance has ${have}`);
    }

    for (const x of rows) {
      delete x._slot;
      attendance.push(x);
    }
  }

  // Players tab: everyone who ever played as a regular, plus the members.
  const seen = new Map();
  for (const a of attendance) if (!a.guest) seen.set(a.name, (seen.get(a.name) || 0) + 1);
  for (const p of knownPlayers) if (!seen.has(p)) seen.set(p, 0);
  const players = [...seen.keys()].sort().map((name) => ({
    name,
    role: members.includes(name) ? 'member' : 'player',
    active: true,
    phone: '',
    notes: '',
  }));

  const memberships = (legacy.memberships || []).map((m, i) => ({
    id: `m${i + 1}`,
    member: m.member,
    date: m.date,
    amount: m.amount,
    hours: m.hours,
    rate: m.rate,
    notes: m.notes || 'imported — please confirm',
  }));

  const unassigned = attendance.filter((a) => a.pays === 'Unassigned').length;
  if (unassigned) notes.push(`${unassigned} historical guest slots had no note and are marked "Unassigned"`);

  return { players, sessions, bookings, attendance, memberships, notes };
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node tools/migrate-legacy.js legacy.json');
    process.exit(1);
  }
  const out = migrate(JSON.parse(fs.readFileSync(file, 'utf8')));
  process.stdout.write(JSON.stringify(out, null, 1));
}

module.exports = { migrate, parseGuestLabel, serialToISO };
