'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const PT = require('../app/tournament.js');

const names = (n) => Array.from({ length: n }, (_, i) => `P${i + 1}`);
const noClash = (matches) => {
  const bySlot = new Map();
  for (const m of matches) {
    const seen = bySlot.get(m.slot) || new Set();
    for (const p of [...m.a, ...m.b]) { assert.equal(seen.has(p), false, `${p} is in two games in round ${m.slot}`); seen.add(p); }
    bySlot.set(m.slot, seen);
  }
  // one game per court per round
  const keys = matches.map((m) => `${m.slot}${m.court}`);
  assert.equal(new Set(keys).size, keys.length);
};

test('fixed teams: everyone plays everyone once, two courts, nobody in two games at once', () => {
  for (const [n, games, slots] of [[4, 6, 3], [5, 10, 5], [6, 15, 8]]) {
    const teams = PT.pairUp(names(n * 2));
    const m = PT.buildTeams(teams, 2);
    assert.deepEqual([m.length, Math.max(...m.map((x) => x.slot))], [games, slots], `${n} teams`);
    noClash(m);
    const pairs = m.map((x) => [x.ta, x.tb].sort().join('v'));
    assert.equal(new Set(pairs).size, games);
    // courts are shared: no team is on one court for every game
    for (const t of teams) {
      const mine = m.filter((x) => x.ta === t.id || x.tb === t.id);
      assert.equal(mine.length, n - 1);
      // (with 4 teams one team can't avoid three games on the same court)
      if (n > 4) assert.ok(mine.some((x) => x.court === 'A') && mine.some((x) => x.court === 'B'), `${t.id} uses both courts`);
    }
  }
});

test('rotating partners: equal games, no repeat partners, sit-outs shared', () => {
  for (const n of [8, 10, 12]) {
    const players = names(n);
    const rounds = PT.americanoDefault(n, 2);
    const m = PT.buildAmericano(players, rounds, 2);
    noClash(m);
    assert.equal(m.length, rounds * 2);
    const games = new Map(), partners = new Map();
    for (const x of m) {
      for (const p of [...x.a, ...x.b]) games.set(p, (games.get(p) || 0) + 1);
      for (const side of [x.a, x.b]) { const k = [...side].sort().join('+'); partners.set(k, (partners.get(k) || 0) + 1); }
    }
    assert.equal(new Set(players.map((p) => games.get(p))).size, 1, `${n} players all play the same number of games`);
    assert.equal(Math.max(...partners.values()), 1, `${n} players: nobody partners the same person twice`);
  }
  assert.equal(PT.americanoDefault(8), 7);       // partner everyone once
  assert.deepEqual(PT.americanoRounds(10), [5, 10]);
  assert.deepEqual(PT.buildAmericano(names(3), 3), []);
});

test('standings, finals and podium for fixed teams', () => {
  const teams = PT.pairUp(['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2']);
  let t = { format: 'teams', courts: 2, points_to: 11, players: teams.flatMap((x) => x.players), teams, matches: PT.buildTeams(teams, 2) };
  assert.equal(PT.nextUp(t).slot, 1);
  assert.deepEqual(PT.finals(t), []);                                   // not until the round robin is done
  // T1 beats everyone, T2 beats T3 and T4, T3 beats T4
  const rank = { T1: 4, T2: 3, T3: 2, T4: 1 };
  t.matches = t.matches.map((m) => (rank[m.ta] > rank[m.tb] ? { ...m, sa: 11, sb: 5 } : { ...m, sa: 7, sb: 11 }));
  const table = PT.standings(t);
  assert.deepEqual(table.map((x) => [x.name, x.won, x.lost]), [['A1 & A2', 3, 0], ['B1 & B2', 2, 1], ['C1 & C2', 1, 2], ['D1 & D2', 0, 3]]);
  assert.equal(PT.progress(t).groupDone, true);
  assert.deepEqual(PT.podium(t), []);
  const finals = PT.finals(t);
  assert.deepEqual(finals.map((m) => [m.stage, m.court, m.ta, m.tb, m.slot]), [['final', 'A', 'T1', 'T2', 4], ['third', 'B', 'T3', 'T4', 4]]);
  t.matches = [...t.matches, ...finals];
  assert.deepEqual(PT.finals(t), []);                                   // only once
  t.matches = t.matches.map((m) => (m.stage === 'final' ? { ...m, sa: 9, sb: 11 } : m.stage === 'third' ? { ...m, sa: 11, sb: 3 } : m));
  assert.deepEqual(PT.podium(t), ['B1 & B2', 'A1 & A2', 'C1 & C2']);   // the final decides it, not the table
  assert.equal(PT.standings(t)[0].name, 'A1 & A2');                    // finals don't change the table
  assert.equal(PT.nextUp(t), null);
});

test('standings for rotating partners count each player\'s own points', () => {
  const players = names(4);
  const t = { format: 'americano', courts: 1, players, matches: PT.buildAmericano(players, 3, 1) };
  assert.equal(t.matches.length, 3);
  t.matches[0] = { ...t.matches[0], sa: 11, sb: 4 };
  const table = PT.standings(t);
  const winners = t.matches[0].a;
  assert.deepEqual(table.slice(0, 2).map((x) => x.name).sort(), [...winners].sort());
  assert.deepEqual([table[0].pf, table[0].won, table[3].pf], [11, 1, 4]);
  assert.deepEqual(PT.podium(t), []);
});

test('replacing a player keeps the schedule', () => {
  const teams = PT.pairUp(names(8));
  const t = { format: 'teams', players: names(8), teams, matches: PT.buildTeams(teams, 2) };
  const r = PT.replacePlayer(t, 'P3', 'Sub');
  assert.equal(JSON.stringify(r).includes('"P3"'), false);
  assert.equal(r.teams[1].players[0], 'Sub');
  assert.equal(r.matches.length, t.matches.length);
});

test('fixed teams can meet more than once, and the default fills a session', () => {
  const teams = PT.pairUp(names(6));                      // 3 teams
  const twice = PT.buildTeams(teams, 2, 2);
  assert.equal(twice.length, 6);
  noClash(twice);
  const meets = new Map();
  for (const m of twice) { const k = [m.ta, m.tb].sort().join('v'); meets.set(k, (meets.get(k) || 0) + 1); }
  assert.deepEqual([...meets.values()], [2, 2, 2]);
  // 15 minutes a game to 11: 3 or 4 teams play twice, 5 or 6 teams once
  assert.deepEqual([3, 4, 5, 6].map((n) => PT.teamsDefaultTimes(n, 2, 11)), [2, 2, 1, 1]);
  assert.deepEqual(PT.estimate(twice, 11), { games: 6, slots: 6, minutes: 90, perGame: 15, courts: 1 });
});

test('rotating partners: shorter or longer nights, ranked by points per game', () => {
  // 9 players, 2 courts: only 9 rounds is even; 7 rounds means some play 6, some 7
  assert.deepEqual(PT.americanoRounds(9), [9]);
  const all = PT.americanoAllRounds(9);
  assert.deepEqual(all.filter((o) => o.even).map((o) => o.rounds), [9]);
  const seven = all.find((o) => o.rounds === 7);
  assert.deepEqual([seven.games, seven.min, seven.max, seven.even], [14, 6, 7, false]);
  const players = names(9);
  const m = PT.buildAmericano(players, 7, 2);
  noClash(m);
  const games = new Map();
  for (const x of m) for (const p of [...x.a, ...x.b]) games.set(p, (games.get(p) || 0) + 1);
  assert.deepEqual([...new Set(players.map((p) => games.get(p)))].sort(), [6, 7]);
  // by total points a 7-game player would win; by points per game the 6-game player does
  const t = { format: 'americano', ranking: 'average', players: ['A', 'B', 'C', 'D', 'E'], matches: [
    { id: 'm1', slot: 1, court: 'A', stage: 'group', a: ['A', 'B'], b: ['C', 'D'], sa: 11, sb: 9 },
    { id: 'm2', slot: 2, court: 'A', stage: 'group', a: ['A', 'C'], b: ['B', 'E'], sa: 11, sb: 9 },
    { id: 'm3', slot: 3, court: 'A', stage: 'group', a: ['A', 'D'], b: ['C', 'E'], sa: 6, sb: 11 },
    { id: 'm4', slot: 4, court: 'A', stage: 'group', a: ['B', 'D'], b: ['E', 'C'], sa: 2, sb: 11 },
  ] };
  // A: 28 pts in 3 games (9.3); E: 31 pts in 3 (10.3); C: 9+11+11+11=42 in 4 (10.5)
  const table = PT.standings(t);
  assert.deepEqual(table.slice(0, 3).map((x) => [x.name, x.avg]), [['C', 10.5], ['E', 10.3], ['A', 9.3]]);
  assert.equal(PT.standings({ ...t, ranking: undefined })[0].name, 'C');   // C also leads on total points here
  assert.equal(PT.standings({ ...t, ranking: undefined })[1].name, 'E');
});

test('suggested rounds fit a session', () => {
  assert.equal(PT.americanoBest(8), 7);     // even, 1h45
  assert.equal(PT.americanoBest(9), 7);     // even would be 9 rounds (2h15), so 7
  assert.equal(PT.americanoBest(10), 5);    // even and fits
  assert.equal(PT.americanoBest(9, 2, 15), 5);
});

test('late arrivals sit out round 1 and still play their share', () => {
  const players = names(10);
  const m = PT.buildAmericano(players, 5, 2, ['P10']);
  noClash(m);
  const round1 = new Set(m.filter((x) => x.slot === 1).flatMap((x) => [...x.a, ...x.b]));
  assert.equal(round1.has('P10'), false);
  const games = new Map();
  for (const x of m) for (const p of [...x.a, ...x.b]) games.set(p, (games.get(p) || 0) + 1);
  assert.deepEqual([...new Set(players.map((p) => games.get(p)))], [4]);   // still 4 each
  // two late with 10 players: both sit round 1
  const two = PT.buildAmericano(players, 5, 2, ['P1', 'P2']);
  const r1 = new Set(two.filter((x) => x.slot === 1).flatMap((x) => [...x.a, ...x.b]));
  assert.deepEqual([r1.has('P1'), r1.has('P2')], [false, false]);
  // fixed teams: a late player's team doesn't play in round 1
  const teams = PT.pairUp(names(8));
  const t = PT.buildTeams(teams, 2, 1, ['P1']);
  noClash(t);
  assert.equal(t.filter((x) => x.slot === 1).some((x) => x.ta === 'T1' || x.tb === 'T1'), false);
  assert.equal(t.length, 6);
});
