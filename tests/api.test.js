'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./fake-gas.js');
const PB = require('../app/billing.js');

function fresh() {
  const gas = loadGas();
  gas.setup();
  const code = gas.accessCode();
  const call = (action, payload) => gas.post({ code, action, payload });
  return { gas, code, call };
}

const session = (extra = {}) => ({
  session: { id: 's1', date: '2026-11-12', reclub_fee: 100, notes: '' },
  bookings: [{ member: 'Ann', hours: 2, rate: 140 }, { member: 'Ben', hours: 0, rate: 140 }],
  attendance: [
    { name: 'Ann', guest: false, pays: 'Ann' },
    { name: 'Cat', guest: false, pays: 'Cat' },
    { name: 'Max', guest: true, pays: 'Cat' },
    { name: 'Reclub guest', guest: true, pays: 'Reclub' },
  ],
  ...extra,
});

test('setup creates tabs, defaults and a strong access code', () => {
  const { gas, code } = fresh();
  assert.deepEqual(Object.keys(gas.sheets).sort(),
    ['Attendance', 'Bookings', 'Kitty', 'Memberships', 'Payments', 'Players', 'Sessions', 'Settings']);
  assert.match(code, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  gas.setup(); // running it again changes nothing
  assert.equal(gas.accessCode(), code);
});

test('requests without the right access code are refused and never see data', () => {
  const { gas } = fresh();
  const res = gas.post({ code: 'nope', action: 'load' });
  assert.deepEqual([res.ok, res.code, res.data], [false, 'auth', undefined]);
  assert.equal(gas.post({ action: 'load' }).ok, false);
});

test('repeated wrong codes lock the API, even for the right code, until the window passes', () => {
  const { gas, call } = fresh();
  for (let i = 0; i < 30; i++) gas.post({ code: `guess${i}`, action: 'load' });
  assert.equal(call('load').code, 'locked');
  gas.cache.clear(); // the 10 minute window expiring
  assert.equal(call('load').ok, true);
});

test('the access code is never sent to the app and cannot be changed through it', () => {
  const { gas, code, call } = fresh();
  const res = call('saveSettings', { access_code: 'hacked', club_name: 'New Name' });
  assert.equal(res.data.settings.access_code, undefined);
  assert.equal(res.data.settings.club_name, 'New Name');
  assert.equal(gas.accessCode(), code);
});

test('saving a session round-trips and bills correctly', () => {
  const { call } = fresh();
  call('savePlayer', { name: 'Ann', role: 'member', active: true });
  call('savePlayer', { name: 'Cat', role: 'player', active: true });
  const res = call('saveSession', session());
  assert.equal(res.ok, true);
  assert.equal(res.data.bookings.length, 1, 'zero-hour bookings are dropped');
  const st = PB.monthStatement(PB.normalize(res.data), '2026-11');
  assert.equal(st.sessions[0].cpp, 70);                               // 280 / 4
  assert.equal(st.players.find((p) => p.name === 'Cat').total, 140);   // Cat + guest Max
  assert.equal(st.members.find((m) => m.name === 'Ann').payback, 210); // 280 - 70
  assert.equal(st.reclub.profit, 30);
});

test('saving the same new session twice does not create a copy', () => {
  const { call } = fresh();
  call('saveSession', session());
  const res = call('saveSession', session());
  assert.equal(res.data.sessions.length, 1);
  assert.equal(res.data.attendance.length, 4);
});

test('an edit based on a stale copy is refused instead of overwriting', () => {
  const { call } = fresh();
  const first = call('saveSession', session());
  const stamp = first.data.sessions[0].updated_at;
  const stale = call('saveSession', session({ base_updated_at: 'something-older' }));
  assert.equal(stale.ok, false);
  assert.match(stale.error, /Someone else/);
  assert.equal(call('saveSession', session({ base_updated_at: stamp })).ok, true);
});

test('deleting a session removes its bookings and attendance', () => {
  const { call } = fresh();
  call('saveSession', session());
  const res = call('deleteSession', { id: 's1' });
  assert.deepEqual([res.data.sessions.length, res.data.bookings.length, res.data.attendance.length], [0, 0, 0]);
});

test('renaming a player updates history, and name clashes are refused', () => {
  const { call } = fresh();
  call('savePlayer', { name: 'Cat', role: 'player', active: true });
  call('savePlayer', { name: 'Ann', role: 'member', active: true });
  call('saveSession', session());
  const res = call('savePlayer', { originalName: 'Cat', name: 'Catherine', role: 'player', active: true });
  assert.deepEqual(res.data.attendance.filter((a) => a.pays === 'Catherine').map((a) => a.name), ['Catherine', 'Max']);
  assert.equal(res.data.players.some((p) => p.name === 'Cat'), false);
  assert.equal(call('savePlayer', { originalName: 'Catherine', name: 'Ann', role: 'player' }).ok, false);
});

test('mark paid / unpaid', () => {
  const { call } = fresh();
  let res = call('setPaid', { month: '2026-11', person: 'Cat', paid: true, amount: 140, paid_on: '2026-12-01' });
  assert.deepEqual(res.data.payments.map((p) => [p.person, p.amount, p.paid_on]), [['Cat', 140, '2026-12-01']]);
  res = call('setPaid', { month: '2026-11', person: 'Cat', paid: false });
  assert.equal(res.data.payments.length, 0);
});

test('public stats feed shows attendance only, hides guest names, and can be switched off', () => {
  const { gas, call } = fresh();
  call('savePlayer', { name: 'Cat', role: 'player', active: true, phone: '+852 9000 0000' });
  call('saveSession', session());
  const stats = gas.get({ view: 'stats' });
  assert.equal(stats.ok, true);
  assert.equal(stats.last_session, '2026-11-12');
  assert.deepEqual(stats.rows.map((r) => r.player_name), ['Ann', 'Cat', 'Guest 1', 'Guest 2']);
  assert.deepEqual(Object.keys(stats.rows[0]).sort(), ['player_name', 'session_date', 'session_id']);
  const text = JSON.stringify(stats);
  for (const secret of ['Max', '9000', '140', gas.accessCode()]) assert.equal(text.includes(secret), false, secret);

  call('saveSettings', { public_stats: 'FALSE' });
  assert.deepEqual(gas.get({ view: 'stats' }), { ok: false, error: 'Public stats are turned off' });
  assert.equal(gas.get().ok, true); // plain health check still answers, with no data
});
