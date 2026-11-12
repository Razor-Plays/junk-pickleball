// Run with: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const PB = require('../app/billing.js');
const { migrate, parseGuestLabel } = require('../tools/migrate-legacy.js');

// Small made-up club: two members, three players.
const raw = {
  settings: { default_rate: 140, reclub_fee: 100 },
  players: [
    { name: 'Ann', role: 'member', active: 'TRUE' },
    { name: 'Ben', role: 'member', active: 'TRUE' },
    { name: 'Cat', role: 'player', active: 'TRUE' },
    { name: 'Dan', role: 'player', active: 'TRUE' },
    { name: 'Eve', role: 'player', active: 'FALSE' },
  ],
  sessions: [
    { id: 's1', date: '2026-10-01', reclub_fee: 100 },
    { id: 's2', date: '2026-10-08', reclub_fee: 100 },
    { id: 's3', date: '2026-11-05', reclub_fee: 120 },
  ],
  bookings: [
    { session_id: 's1', member: 'Ann', hours: 1, rate: 140 },
    { session_id: 's1', member: 'Ben', hours: 1, rate: 140 },
    { session_id: 's2', member: 'Ann', hours: 2, rate: 140 },
    { session_id: 's3', member: 'Ben', hours: 2, rate: 160 },
  ],
  attendance: [
    // s1: 4 heads, 280 / 4 = 70
    { session_id: 's1', name: 'Ann', guest: 'FALSE', pays: 'Ann' },
    { session_id: 's1', name: 'Cat', guest: 'FALSE', pays: 'Cat' },
    { session_id: 's1', name: 'Dan', guest: 'FALSE', pays: 'Dan' },
    { session_id: 's1', name: 'Zoe', guest: 'TRUE', pays: 'Cat' },
    // s2: 3 heads, 280 / 3 = 93.33
    { session_id: 's2', name: 'Ben', guest: 'FALSE', pays: 'Ben' },
    { session_id: 's2', name: 'Cat', guest: 'FALSE', pays: 'Cat' },
    { session_id: 's2', name: 'Reclub guest', guest: 'TRUE', pays: 'Reclub' },
    // s3: 4 heads, 320 / 4 = 80, Reclub fee 120 on this session
    { session_id: 's3', name: 'Ann', guest: 'FALSE', pays: 'Ann' },
    { session_id: 's3', name: 'Dan', guest: 'FALSE', pays: 'Dan' },
    { session_id: 's3', name: 'Reclub guest', guest: 'TRUE', pays: 'Reclub' },
    { session_id: 's3', name: 'Reclub guest', guest: 'TRUE', pays: 'Reclub' },
  ],
  memberships: [
    { id: 'm1', member: 'Ann', date: '2026-01-01', amount: 1400, hours: 10, rate: 140 },
    { id: 'm2', member: 'Ben', date: '2026-01-01', amount: 140, hours: 1, rate: 140 },
    { id: 'm3', member: 'Ben', date: '2026-10-15', amount: 1600, hours: 10, rate: 160 },
  ],
  payments: [{ month: '2026-10', person: 'Cat', amount: 233.33, paid_on: '2026-11-01' }],
  kitty: [{ id: 'k1', date: '2026-10-20', description: 'Balls', amount: -50 }],
};
const data = PB.normalize(raw);

test('session cost per player', () => {
  const s = PB.sessionSummary(data, data.sessions[0]);
  assert.equal(s.cost, 280);
  assert.equal(s.heads, 4);
  assert.equal(s.cpp, 70);
  assert.equal(PB.sessionSummary(data, data.sessions[1]).cpp, 93.33);
});

test('players pay for their guests', () => {
  const st = PB.monthStatement(data, '2026-10');
  const cat = st.players.find((p) => p.name === 'Cat');
  assert.equal(cat.total, 233.33); // 70 + guest Zoe 70 + 93.33
  assert.deepEqual([cat.own, cat.games], [163.33, 2]);
  assert.deepEqual(cat.guests, [{ name: 'Zoe', amount: 70, count: 1 }]);
  assert.equal(cat.isGuest, false);
  assert.ok(cat.paid, 'payment row is picked up');
  assert.equal(st.players.find((p) => p.name === 'Dan').total, 70);
});

test('members are not billed; payback is booked value minus own fees', () => {
  const st = PB.monthStatement(data, '2026-10');
  assert.equal(st.players.some((p) => p.name === 'Ann' || p.name === 'Ben'), false);
  const ann = st.members.find((m) => m.name === 'Ann');
  const ben = st.members.find((m) => m.name === 'Ben');
  assert.equal(ann.payback, 420 - 70);       // booked 1h + 2h, played s1
  assert.equal(ben.payback, PB.round2(140 - 93.33));
});

test('every court dollar is accounted for', () => {
  const st = PB.monthStatement(data, '2026-10');
  const ownFees = st.members.reduce((s, m) => s + m.charges, 0);
  const total = PB.round2(st.totals.players + ownFees + st.reclub.courtShare);
  assert.ok(Math.abs(total - st.totals.courtCost) < 0.05, `${total} vs ${st.totals.courtCost}`);
  assert.equal(st.totals.balanced, true);
});

test('Reclub fee is stored per session and goes to the kitty', () => {
  const nov = PB.monthStatement(data, '2026-11');
  assert.equal(nov.reclub.income, 240);       // 2 x 120
  assert.equal(nov.reclub.profit, 80);        // 240 - 2 x 80
  const k = PB.kitty(data);
  assert.equal(k.reclubProfit, PB.round2((100 - 93.33) + 80));
  assert.equal(k.balance, PB.round2(k.reclubProfit - 50));
});

test('rates stay with the session they were booked on', () => {
  const nov = PB.monthStatement(data, '2026-11');
  assert.equal(nov.totals.courtCost, 320);    // 2h at 160, not today's default 140
});

test('membership balances and next rate use the oldest lot first', () => {
  const bal = PB.membershipBalances(data);
  const ann = bal.find((b) => b.name === 'Ann');
  assert.deepEqual([ann.purchased, ann.used, ann.left], [10, 3, 7]);
  const ben = bal.find((b) => b.name === 'Ben');
  assert.deepEqual([ben.purchased, ben.used, ben.left], [11, 3, 8]);
  assert.equal(PB.nextRate(data, 'Ben'), 160); // first lot (1h) used up
  assert.equal(PB.nextRate(data, 'Ann'), 140);
});

test('warnings for sessions missing players or bookings', () => {
  const d = PB.normalize({ ...raw, sessions: [...raw.sessions, { id: 's4', date: '2026-10-22' }],
    bookings: [...raw.bookings, { session_id: 's4', member: 'Ann', hours: 2, rate: 140 }] });
  const st = PB.monthStatement(d, '2026-10');
  assert.equal(st.warnings.length, 1);
  assert.match(st.warnings[0].text, /no players/);
  assert.equal(st.totals.unallocated, 280);
});

test('messages', () => {
  const st = PB.monthStatement(data, '2026-10');
  const msg = PB.playerMessage(st.players.find((p) => p.name === 'Cat'), '2026-10', data.settings);
  assert.match(msg, /October 2026/);
  assert.match(msg, /guest Zoe \$70\.00/);
  assert.match(msg, /Total: \$233\.33/);
  const mm = PB.memberMessage(st.members.find((m) => m.name === 'Ann'), '2026-10', data.settings);
  assert.match(mm, /Payback to you: \$350\.00/);
});

test('legacy guest labels', () => {
  const known = new Set(['Foong', 'Donna']);
  assert.deepEqual(parseGuestLabel("Foong's friend Jeremy", known), { name: 'Jeremy', pays: 'Foong' });
  assert.deepEqual(parseGuestLabel('Donna Friend - Logan', known), { name: 'Logan', pays: 'Donna' });
  assert.deepEqual(parseGuestLabel("Donna's Friend", known), { name: "Donna's friend", pays: 'Donna' });
  assert.deepEqual(parseGuestLabel('Reclub $100', known), { name: 'Reclub guest', pays: 'Reclub' });
  assert.deepEqual(parseGuestLabel('Reclulb', known), { name: 'Reclub guest', pays: 'Reclub' });
  assert.deepEqual(parseGuestLabel('Ange', known), { name: 'Ange', pays: 'Ange' });
});

test('legacy migration fills Reclub counts and keeps labelled guests', () => {
  const out = migrate({
    members: ['Ann', 'Ben'], rate: 140,
    rows: [{ row: 3, serial: 46317, hours: [1, 1] }],          // 2026-10-22
    attendance: { 3: ['Ann', 'Cat', 'Guest 1', 'Guest 2', 'Guest 3'] },
    comments: [{ row: 3, col: 'H', label: "Cat's friend Max", status: 'OPEN' }],
    reclubCounts: { '2026-10-22': 2 },
    players: ['Ann', 'Ben', 'Cat', 'Guest 1'],
  });
  assert.equal(out.sessions[0].date, '2026-10-22');
  assert.deepEqual(out.attendance.map((a) => [a.name, a.pays]),
    [['Ann', 'Ann'], ['Cat', 'Cat'], ['Reclub guest', 'Reclub'], ['Reclub guest', 'Reclub'], ['Max', 'Cat']]);
  assert.deepEqual(out.players.map((p) => p.name), ['Ann', 'Ben', 'Cat']);
});

test('unpaid bills from earlier months, only once payment tracking has started', () => {
  // October has one payment on record (Cat), so October counts as tracked.
  const owing = PB.outstanding(data, '2026-11');
  assert.deepEqual(owing, [{ month: '2026-10', name: 'Dan', amount: 70 }]);
  // Nothing is reported for the month being viewed, or before tracking began.
  assert.deepEqual(PB.outstanding(data, '2026-10'), []);
  assert.deepEqual(PB.outstanding(PB.normalize({ ...raw, payments: [] }), '2026-12'), []);
});

test('returning guests are remembered with who paid for them last', () => {
  const d = PB.normalize({ ...raw, attendance: [...raw.attendance,
    { session_id: 's3', name: 'Zoe', guest: 'TRUE', pays: 'Dan' },
    { session_id: 's3', name: 'Guest 4', guest: 'TRUE', pays: 'Unassigned' },
    { session_id: 's3', name: "Cat's friend", guest: 'TRUE', pays: 'Cat' }] });
  assert.deepEqual(PB.knownGuests(d).map((g) => [g.name, g.pays, g.count]), [['Zoe', 'Dan', 2]]);
});

// A month with every kind of payer: regulars, a hosted guest, a visitor
// paying their own way, a member who brought a guest, and Reclub.
const mixed = PB.normalize({
  settings: { default_rate: 140, reclub_fee: 100 },
  players: raw.players,
  sessions: [{ id: 'x1', date: '2026-12-03', reclub_fee: 100 }, { id: 'x2', date: '2026-12-10', reclub_fee: 100 }],
  bookings: [{ session_id: 'x1', member: 'Ann', hours: 2, rate: 140 }, { session_id: 'x2', member: 'Ben', hours: 2, rate: 140 }],
  attendance: [
    // x1: 7 heads, 40 each
    { session_id: 'x1', name: 'Ann', guest: 'FALSE', pays: 'Ann' },
    { session_id: 'x1', name: 'Cat', guest: 'FALSE', pays: 'Cat' },
    { session_id: 'x1', name: 'Dan', guest: 'FALSE', pays: 'Dan' },
    { session_id: 'x1', name: 'Jeremy', guest: 'TRUE', pays: 'Cat' },
    { session_id: 'x1', name: 'Johann', guest: 'TRUE', pays: 'Johann' },
    { session_id: 'x1', name: 'Milo', guest: 'TRUE', pays: 'Ann' },
    { session_id: 'x1', name: 'Reclub guest', guest: 'TRUE', pays: 'Reclub' },
    // x2: 4 heads, 70 each
    { session_id: 'x2', name: 'Cat', guest: 'FALSE', pays: 'Cat' },
    { session_id: 'x2', name: 'Jeremy', guest: 'TRUE', pays: 'Cat' },
    { session_id: 'x2', name: 'Johann', guest: 'TRUE', pays: 'Johann' },
    { session_id: 'x2', name: 'Ben', guest: 'FALSE', pays: 'Ben' },
  ],
});

test('a visitor paying their own way is a guest, not someone with a guest', () => {
  const st = PB.monthStatement(mixed, '2026-12');
  const johann = st.players.find((p) => p.name === 'Johann');
  assert.deepEqual([johann.isGuest, johann.own, johann.games, johann.guests.length], [true, 110, 2, 0]);
  const cat = st.players.find((p) => p.name === 'Cat');
  assert.deepEqual([cat.isGuest, cat.own, cat.total], [false, 110, 220]);
  assert.deepEqual(cat.guests, [{ name: 'Jeremy', amount: 110, count: 2 }]);
});

test('group message: everyone on their own line, guests with their host, members shown separately', () => {
  const msg = PB.groupMessage(PB.monthStatement(mixed, '2026-12'), mixed.settings);
  assert.equal(msg, [
    '*Junk Pickleball — December 2026 court fees*',
    '',
    '*Regulars*',
    '• Cat: $110.00',
    '• Dan: $40.00',
    '',
    '*Guests*',
    "• Jeremy: $110.00 (Cat's guest)",
    '• Johann: $110.00',
    "• Milo: $40.00 (Ann's guest)",
    '',
    '*Members* (taken off their payback)',
    '• Ann: $40.00',
    '• Ben: $70.00',
    '',
    'Please pay Tommy — hosts settle up for their guests. Thanks! 🥒🎾',
  ].join('\n'));
  // every court dollar that isn't Reclub's appears exactly once
  const listed = [...msg.matchAll(/\$([\d.]+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  const st = PB.monthStatement(mixed, '2026-12');
  assert.equal(PB.round2(listed), PB.round2(st.totals.allocated - st.reclub.courtShare));
});

test("a host's bill says what each guest's share is", () => {
  const st = PB.monthStatement(mixed, '2026-12');
  const msg = PB.playerMessage(st.players.find((p) => p.name === 'Cat'), '2026-12', mixed.settings);
  assert.match(msg, /Your own sessions: \$110\.00\nJeremy \(2 sessions\): \$110\.00\nTotal: \$220\.00/);
  const own = PB.playerMessage(st.players.find((p) => p.name === 'Dan'), '2026-12', mixed.settings);
  assert.equal(/Your own sessions/.test(own), false);
  assert.match(PB.memberMessage(st.members.find((m) => m.name === 'Ann'), '2026-12', mixed.settings), /Of which Milo: \$40\.00/);
});

test('regular suggestions: named guests after their third visit, until they are made a player', () => {
  const visits = (name, pays, ids) => ids.map((id) => ({ session_id: id, name, guest: 'TRUE', pays }));
  const d = (players) => PB.normalize({ ...raw, players, attendance: [...raw.attendance,
    ...visits('Clyde', 'Clyde', ['s1', 's2', 's3']), ...visits('Kay', 'Kay', ['s1', 's2']),
    ...visits('Reclub guest', 'Reclub', ['s1', 's2', 's3'])] });
  assert.deepEqual(PB.regularSuggestions(d(raw.players)).map((g) => [g.name, g.count]), [['Clyde', 3]]);
  const promoted = d([...raw.players, { name: 'Clyde', role: 'player', active: 'TRUE' }]);
  assert.deepEqual(PB.regularSuggestions(promoted), []);
  // ... and their earlier visits now sit with the regulars
  const clyde = PB.monthStatement(promoted, '2026-10').players.find((p) => p.name === 'Clyde');
  assert.deepEqual([clyde.isGuest, clyde.games], [false, 2]);
});

test('names clash ignoring case and spacing', () => {
  assert.equal(PB.playerNamed(data, ' ann ').name, 'Ann');
  assert.equal(PB.playerNamed(data, 'Ann G'), null);
  assert.equal(PB.playerNamed(data, 'ANN', 'Ann'), null); // renaming yourself is fine
});

test('court wording: booked hours read as courts x session length', () => {
  const label = (hours, play_hours) => PB.courtLabel({ hours, session: { play_hours } });
  assert.equal(label(4, 0), '2 courts × 2h');      // length not recorded: sessions run 2 hours
  assert.equal(label(2, 0), '1 court × 2h');
  assert.equal(label(4, 1), '4 courts × 1h');
  assert.equal(label(3, 1.5), '2 courts × 1.5h');
  assert.equal(label(1, 0), '1 court-hour');       // doesn't divide into whole courts
  assert.equal(label(0, 2), 'no courts booked');
});

test('player history: months, totals and who paid', () => {
  const h = PB.playerHistory(mixed, 'Cat');
  assert.deepEqual([h.games, h.first, h.last, h.fees, h.perGame], [2, '2026-12-03', '2026-12-10', 220, 110]);
  assert.deepEqual(h.months.map((m) => [m.month, m.games, m.fees, m.items.length]), [['2026-12', 2, 220, 4]]);
  assert.deepEqual(h.months[0].items.map((i) => [i.kind, i.who]), [['self', ''], ['guest', 'Jeremy'], ['self', ''], ['guest', 'Jeremy']]);
  assert.deepEqual(h.years.map((y) => [y.year, y.games, y.fees]), [['2026', 2, 220]]);
  assert.equal(h.totalSessions, 2);
  // a hosted guest played but owes nothing themselves
  const j = PB.playerHistory(mixed, 'Jeremy');
  assert.deepEqual([j.games, j.fees, j.isGuest, j.months[0].items[0].kind, j.months[0].items[0].paidBy], [2, 0, true, 'hosted', 'Cat']);
  // paid months are flagged; someone who never played has an empty history
  assert.ok(PB.playerHistory(data, 'Cat').months.find((m) => m.month === '2026-10').paid);
  assert.deepEqual(PB.playerHistory(data, 'Eve').months, []);
});

test('locations come from settings, in order', () => {
  assert.deepEqual(PB.locations(PB.normalize({ settings: { locations: ' A | B |  | C ' } })), ['A', 'B', 'C']);
  assert.equal(PB.locations(PB.normalize({}))[0], 'Metro City Plaza Phase 3');
});

test('unpaid months: every month after tracking starts counts, even one with no payments yet', () => {
  // payments recorded for October only; November and December have none yet
  const d = PB.normalize({ ...raw,
    sessions: [...raw.sessions, { id: 'd1', date: '2026-12-02', reclub_fee: 100 }],
    bookings: [...raw.bookings, { session_id: 'd1', member: 'Ann', hours: 1, rate: 140 }],
    attendance: [...raw.attendance, { session_id: 'd1', name: 'Dan', guest: 'FALSE', pays: 'Dan' }] });
  const owing = PB.outstanding(d, '2027-01').map((o) => `${o.month} ${o.name}`);
  // November has no payment rows at all but still counts; Ann is a member who played without booking, so she owes
  assert.deepEqual(owing, ['2026-10 Dan', '2026-11 Dan', '2026-11 Ann', '2026-12 Dan']);
});

test("a member's page lists their bookings without counting them as fees", () => {
  const h = PB.playerHistory(mixed, 'Ann');
  const dec = h.months[0];
  assert.deepEqual(dec.items.map((i) => [i.kind, i.amount]), [['booking', 280], ['self', 40], ['guest', 40]]);
  assert.deepEqual([dec.games, dec.fees, h.games, h.fees], [1, 80, 1, 80]);
});
