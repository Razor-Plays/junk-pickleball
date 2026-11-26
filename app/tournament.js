/*
 * Mini tournaments: the schedule and the standings.
 * Shared by the app and the tests (no DOM, no network).
 *
 * A tournament belongs to one session and is stored as one row in the sheet's
 * Tournaments tab: { id, session_id, name, updated_at, data } where data is
 *   {
 *     format: 'teams' | 'americano',
 *     points_to: 11,              // games are played to this (a guide, not enforced)
 *     courts: 2,
 *     players: ['Jana', ...],
 *     teams: [{ id: 'T1', players: ['Jana', 'Jak'] }],   // 'teams' format only
 *     matches: [{ id, slot, court, stage, a: [names], b: [names], ta, tb, sa, sb }]
 *   }
 *   - slot:  1, 2, 3...  one slot = the games on at the same time ("Round 1")
 *   - court: 'A', 'B', ...
 *   - stage: 'group' | 'final' | 'third'
 *   - ta/tb: team ids ('teams' format); sa/sb: the score, null until played
 *
 * Two formats:
 *   teams     fixed pairs; everyone plays everyone (round robin), then the top
 *             two play a final and the next two play for third.
 *   americano partners rotate every game; each player collects their own points.
 */
(function (root) {
  'use strict';

  const PT = {};
  const COURT_NAMES = 'ABCDEFGH';

  PT.teamName = (players) => players.join(' & ');

  /** Same input, same order: a small seeded shuffle so tests are repeatable. */
  PT.shuffle = (list, seed = Date.now()) => {
    let s = (Number(seed) || 1) % 2147483647;
    if (s <= 0) s += 2147483646;
    const rand = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    const out = [...list];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  /** ['a','b','c','d'] -> [{id:'T1', players:['a','b']}, {id:'T2', players:['c','d']}] */
  PT.pairUp = (players) => {
    const teams = [];
    for (let i = 0; i + 1 < players.length; i += 2) teams.push({ id: `T${teams.length + 1}`, players: [players[i], players[i + 1]] });
    return teams;
  };

  /** Everyone plays everyone once. Returns rounds of [i, j] pairs (indexes into the team list). */
  PT.roundRobin = (n) => {
    const arr = Array.from({ length: n }, (_, i) => i);
    if (n % 2) arr.push(null);   // odd number: one team rests each round
    const size = arr.length;
    const rounds = [];
    for (let r = 0; r < size - 1; r += 1) {
      const round = [];
      for (let i = 0; i < size / 2; i += 1) {
        const x = arr[i], y = arr[size - 1 - i];
        if (x !== null && y !== null) round.push([x, y]);
      }
      rounds.push(round);
      arr.splice(1, 0, arr.pop());   // rotate everyone but the first
    }
    return rounds;
  };

  /**
   * Put games onto courts. Each slot holds up to `courts` games with nobody in
   * two games at once; games are taken in order, pulling a later one forward
   * when it fits. Courts are shared out so no side lives on one court.
   * `games` = [{ sides: [keyA, keyB], ... }] where a key (or array of keys) names who is playing.
   */
  PT.schedule = (games, courts, firstSlot = 1, late = []) => {
    const lateSet = new Set(late);
    const queue = [...games];
    const onCourt = new Map();   // who -> { A: n, B: n }
    const who = (g) => g.sides.flat();
    const out = [];
    let slot = firstSlot;
    while (queue.length) {
      const busy = new Set();
      const now = [];
      for (let i = 0; i < queue.length && now.length < courts; i += 1) {
        if (who(queue[i]).some((p) => busy.has(p))) continue;
        // nobody arriving late plays in the first round, if there's another game to put on
        if (slot === firstSlot && lateSet.size && who(queue[i]).some((p) => lateSet.has(p)) && queue.some((g) => !who(g).some((p) => lateSet.has(p)))) continue;
        who(queue[i]).forEach((p) => busy.add(p));
        now.push(queue.splice(i, 1)[0]);
        i -= 1;
      }
      // try each court order and keep the one that spreads people across courts best
      const orders = now.length === 2 ? [[0, 1], [1, 0]] : [now.map((_, i) => i)];
      const cost = (order) => order.reduce((t, c, i) => t + who(now[i]).reduce((x, p) => x + (((onCourt.get(p) || {})[COURT_NAMES[c]] || 0) + 1) ** 2, 0), 0);
      const best = orders.reduce((a, b) => (cost(b) < cost(a) ? b : a));
      now.forEach((g, i) => {
        const court = COURT_NAMES[best[i]];
        who(g).forEach((p) => { const c = onCourt.get(p) || {}; c[court] = (c[court] || 0) + 1; onCourt.set(p, c); });
        out.push({ ...g, slot, court });
      });
      out.sort((a, b) => a.slot - b.slot || a.court.localeCompare(b.court));
      slot += 1;
    }
    return out;
  };

  const blank = (g, i) => ({
    id: `m${i + 1}`, slot: g.slot, court: g.court, stage: g.stage || 'group',
    a: g.a, b: g.b, ta: g.ta || '', tb: g.tb || '', sa: null, sb: null,
  });

  /**
   * Fixed teams: a round robin on the courts. `times` = how often each pair of
   * teams meets (1 to 3); sides swap on the repeat.
   */
  PT.buildTeams = (teams, courts = 2, times = 1, late = []) => {
    const lateTeams = teams.filter((t) => t.players.some((p) => late.includes(p))).map((t) => t.id);
    const once = PT.roundRobin(teams.length).flat();
    const games = [];
    for (let k = 0; k < Math.max(1, times); k += 1) {
      for (const [x, y] of once) {
        const [i, j] = k % 2 ? [y, x] : [x, y];
        games.push({ sides: [teams[i].id, teams[j].id], a: teams[i].players, b: teams[j].players, ta: teams[i].id, tb: teams[j].id });
      }
    }
    return PT.schedule(games, courts, 1, lateTeams).map(blank);
  };

  /** Minutes to allow for one game, changeover included. Measured: rally scoring to 15 took about 12 minutes a game. */
  PT.minutesPerGame = (pointsTo = 15) => (pointsTo >= 21 ? 16 : pointsTo >= 15 ? 12 : 9);

  /** How many times teams should meet to fill a session without running past about 1h40. */
  PT.teamsDefaultTimes = (nTeams, courts = 2, pointsTo = 15) => {
    let best = 1;
    for (let k = 1; k <= 3; k += 1) {
      const teams = Array.from({ length: nTeams }, (_, i) => ({ id: `T${i + 1}`, players: [`a${i}`, `b${i}`] }));
      if (PT.estimate(PT.buildTeams(teams, courts, k), pointsTo).minutes <= 100) best = k;
    }
    return best;
  };

  /** Round counts where everyone ends up with the same number of games. */
  PT.MAX_ROUNDS = 10;   // a club night: more than this doesn't fit
  PT.americanoRounds = (n, courts = 2) => {
    const playing = Math.min(courts, Math.floor(n / 4)) * 4;
    if (!playing) return [];
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const step = n / gcd(n, playing);            // rounds until everyone has sat out equally
    const out = [];
    if (step === 1) { for (let r = 3; r <= PT.MAX_ROUNDS; r += 1) out.push(r); } else { for (let r = step; r <= PT.MAX_ROUNDS; r += step) out.push(r); }
    return out;
  };
  /** What a number of rounds means: games in total, games per player, and how often each sits out. */
  /**
   * What a number of rounds means: games in total, the fewest and most games
   * anyone plays, and sit-outs. `even` = everyone plays the same number.
   */
  PT.americanoLoad = (n, rounds, courts = 2) => {
    const playing = Math.min(courts, Math.floor(n / 4)) * 4;
    const slots = rounds * playing;
    const min = Math.floor(slots / n), max = Math.ceil(slots / n);
    return { games: slots / 4, each: min, min, max, even: min === max, sits: rounds - max, maxSits: rounds - min };
  };

  /**
   * Every round count from 3 to 12. The even ones (everyone plays the same
   * number of games) come first in the app; the others are shorter or longer
   * nights where some play one game fewer, ranked by points per game.
   */
  PT.americanoAllRounds = (n, courts = 2) => {
    const playing = Math.min(courts, Math.floor(n / 4)) * 4;
    if (!playing) return [];
    const out = [];
    for (let r = 3; r <= PT.MAX_ROUNDS; r += 1) out.push({ rounds: r, ...PT.americanoLoad(n, r, courts) });
    return out;
  };
  PT.americanoDefault = (n, courts = 2) => {
    const options = PT.americanoRounds(n, courts);
    if (!options.length) return 0;
    const ideal = Math.min(courts, Math.floor(n / 4)) * 4 === n ? Math.min(n - 1, 8) : 8;   // n-1 = partner everyone once
    return options.filter((r) => r <= ideal).pop() || options[0];
  };

  /**
   * The rounds to suggest: the even option if it fits a session (about 1h45
   * at the usual minutes a game), otherwise the most rounds that do fit.
   */
  PT.americanoBest = (n, courts = 2, pointsTo = 15, limit = 105) => {
    const even = PT.americanoDefault(n, courts);
    const per = PT.minutesPerGame(pointsTo);
    if (even && even * per <= limit) return even;
    const fits = PT.americanoAllRounds(n, courts).filter((o) => o.rounds * per <= limit);
    return fits.length ? fits[fits.length - 1].rounds : even;
  };

  /**
   * Rotating partners. Each round the players with the fewest games play; they
   * are split into pairs and games so that repeat partners are avoided first,
   * then repeat opponents.
   */
  PT.buildAmericano = (players, rounds, courts = 2, late = [], prior = [], firstSlot = 1) => {
    const n = players.length;
    const isLate = players.map((p) => late.includes(p));
    const playing = Math.min(courts, Math.floor(n / 4)) * 4;
    if (!playing) return [];
    const games = new Array(n).fill(0);
    const partner = Array.from({ length: n }, () => new Array(n).fill(0));
    const opp = Array.from({ length: n }, () => new Array(n).fill(0));
    const onCourt = Array.from({ length: n }, () => ({}));
    const out = [];
    // games already played (e.g. before someone left) count towards partners, opponents and games played
    const ix = new Map(players.map((p, i) => [p, i]));
    for (const m of prior) {
      const [a, b] = m.a.map((p) => ix.get(p)), [c, d] = m.b.map((p) => ix.get(p));
      for (const p of [a, b, c, d]) if (p !== undefined) games[p] += 1;
      if (a !== undefined && b !== undefined) { partner[a][b] += 1; partner[b][a] += 1; }
      if (c !== undefined && d !== undefined) { partner[c][d] += 1; partner[d][c] += 1; }
      for (const [x, y] of [[a, c], [a, d], [b, c], [b, d]]) if (x !== undefined && y !== undefined) { opp[x][y] += 1; opp[y][x] += 1; }
    }

    // every way to split a list of players into games of two pairs
    const splits = (list) => {
      if (!list.length) return [[]];
      const res = [];
      const [p, ...rest] = list;
      for (let i = 0; i < rest.length; i += 1) {            // p's partner
        const q = rest[i];
        const left = rest.filter((_, k) => k !== i);
        const [x, ...others] = left;                         // lowest remaining player anchors the other pair
        for (let j = 0; j < others.length; j += 1) {
          const y = others[j];
          const remaining = others.filter((_, k) => k !== j);
          for (const tail of splits(remaining)) res.push([[[p, q], [x, y]], ...tail]);
        }
      }
      return res;
    };
    const cost = (split) => split.reduce((t, [[a, b], [c, d]]) => t
      + 100 * (partner[a][b] ** 2 + partner[c][d] ** 2 + 2 * (partner[a][b] + partner[c][d]))
      + opp[a][c] ** 2 + opp[a][d] ** 2 + opp[b][c] ** 2 + opp[b][d] ** 2, 0);

    for (let r = 1; r <= rounds; r += 1) {
      // late arrivals sit out round 1 (as far as the numbers allow), then catch up by having played fewest
      const away = (i) => (r === 1 && isLate[i] ? 1 : 0);
      const order = players.map((_, i) => i).sort((x, y) => away(x) - away(y) || games[x] - games[y] || ((x + r * 3) % n) - ((y + r * 3) % n));
      const inPlay = order.slice(0, playing).sort((x, y) => x - y);
      const best = splits(inPlay).reduce((a, b) => (cost(b) < cost(a) ? b : a));
      // courts: spread people across them
      const courtOrders = best.length === 2 ? [[0, 1], [1, 0]] : [best.map((_, i) => i)];
      const courtCost = (o) => o.reduce((t, c, i) => t + best[i].flat().reduce((x, p) => x + ((onCourt[p][COURT_NAMES[c]] || 0) + 1) ** 2, 0), 0);
      const courtsFor = courtOrders.reduce((a, b) => (courtCost(b) < courtCost(a) ? b : a));
      best.forEach(([[a, b], [c, d]], i) => {
        const court = COURT_NAMES[courtsFor[i]];
        for (const p of [a, b, c, d]) { games[p] += 1; onCourt[p][court] = (onCourt[p][court] || 0) + 1; }
        partner[a][b] += 1; partner[b][a] += 1; partner[c][d] += 1; partner[d][c] += 1;
        for (const [x, y] of [[a, c], [a, d], [b, c], [b, d]]) { opp[x][y] += 1; opp[y][x] += 1; }
        out.push({ slot: r + firstSlot - 1, court, a: [players[a], players[b]], b: [players[c], players[d]] });
      });
    }
    return out.sort((x, y) => x.slot - y.slot || x.court.localeCompare(y.court)).map(blank);
  };

  PT.isScored = (m) => Number.isFinite(m.sa) && Number.isFinite(m.sb) && m.sa !== null && m.sb !== null;

  /**
   * The table. Teams: wins, then point difference, then points scored.
   * Americano: each player's own points, then wins, then point difference.
   * Finals don't change the table; they decide the podium (see PT.podium).
   */
  PT.standings = (t) => {
    const rows = new Map();
    const row = (key, name) => {
      if (!rows.has(key)) rows.set(key, { key, name, played: 0, won: 0, lost: 0, pf: 0, pa: 0, diff: 0, avg: 0 });
      return rows.get(key);
    };
    if (t.format === 'teams') for (const team of t.teams || []) row(team.id, PT.teamName(team.players));
    else for (const p of t.players || []) row(p, p);
    for (const m of t.matches || []) {
      if (m.stage !== 'group' || !PT.isScored(m)) continue;
      const sides = t.format === 'teams'
        ? [[row(m.ta, PT.teamName(m.a))], [row(m.tb, PT.teamName(m.b))]]
        : [m.a.map((p) => row(p, p)), m.b.map((p) => row(p, p))];
      sides.forEach((side, i) => side.forEach((x) => {
        const mine = i === 0 ? m.sa : m.sb, theirs = i === 0 ? m.sb : m.sa;
        x.played += 1; x.pf += mine; x.pa += theirs; x.diff = x.pf - x.pa; x.avg = Math.round((x.pf / x.played) * 10) / 10;
        if (mine > theirs) x.won += 1; else x.lost += 1;
      }));
    }
    const list = [...rows.values()];
    if (t.format === 'teams') list.sort((a, b) => b.won - a.won || b.diff - a.diff || b.pf - a.pf || a.name.localeCompare(b.name));
    else if (t.ranking === 'average') {
      // some play one game fewer, so compare points per game (then win rate, then difference per game)
      const per = (x, k) => (x.played ? x[k] / x.played : 0);
      list.sort((a, b) => per(b, 'pf') - per(a, 'pf') || per(b, 'won') - per(a, 'won') || per(b, 'diff') - per(a, 'diff') || a.name.localeCompare(b.name));
    } else list.sort((a, b) => b.pf - a.pf || b.won - a.won || b.diff - a.diff || a.name.localeCompare(b.name));
    return list.map((x, i) => ({ ...x, rank: i + 1 }));
  };

  PT.progress = (t) => {
    const all = t.matches || [];
    const group = all.filter((m) => m.stage === 'group');
    return {
      total: all.length, done: all.filter(PT.isScored).length,
      groupDone: group.length > 0 && group.every(PT.isScored),
      hasFinals: all.some((m) => m.stage !== 'group'),
      finished: all.length > 0 && all.every(PT.isScored),
    };
  };

  /** The games on next: the first slot that still has a game without a score. */
  PT.nextUp = (t) => {
    const open = (t.matches || []).filter((m) => !PT.isScored(m));
    if (!open.length) return null;
    const slot = Math.min(...open.map((m) => m.slot));
    const games = (t.matches || []).filter((m) => m.slot === slot);
    const busy = new Set(games.flatMap((m) => [...m.a, ...m.b]));
    return { slot, games, resting: (t.players || []).filter((p) => !busy.has(p)) };
  };

  /** Teams format, once the round robin is done: 1st v 2nd for the title, 3rd v 4th for third. */
  PT.finals = (t) => {
    if (t.format !== 'teams') return [];
    const p = PT.progress(t);
    if (!p.groupDone || p.hasFinals) return [];
    const table = PT.standings(t);
    const team = (i) => t.teams.find((x) => x.id === table[i].key);
    const slot = Math.max(...t.matches.map((m) => m.slot)) + 1;
    const n = t.matches.length;
    const game = (stage, court, x, y, i) => ({
      id: `m${n + i}`, slot, court, stage, a: team(x).players, b: team(y).players, ta: team(x).id, tb: team(y).id, sa: null, sb: null,
    });
    const out = [game('final', 'A', 0, 1, 1)];
    if (table.length >= 4 && (t.courts || 2) >= 2) out.push(game('third', 'B', 2, 3, 2));
    return out;
  };

  /** Who finished where, once it's decided. Returns [] until then. */
  PT.podium = (t) => {
    const p = PT.progress(t);
    const table = PT.standings(t);
    if (t.format !== 'teams') return p.finished ? table.slice(0, 3).map((x) => x.name) : [];
    const final = (t.matches || []).find((m) => m.stage === 'final');
    if (!final || !PT.isScored(final)) return [];
    const order = (m) => (m.sa > m.sb ? [m.a, m.b] : [m.b, m.a]).map(PT.teamName);
    const third = (t.matches || []).find((m) => m.stage === 'third');
    return [...order(final), ...(third && PT.isScored(third) ? [order(third)[0]] : [])];
  };

  /**
   * Take a player out of a tournament that may already be under way.
   * Games already scored stay as they are, with everyone's points. Games still
   * to play are rebuilt for the players who are left: rotating partners get the
   * same number of rounds re-drawn (and the table switches to points per game);
   * fixed teams lose that player's team from the games still to play.
   */
  PT.removePlayer = (t, name) => {
    const played = (t.matches || []).filter(PT.isScored);
    const open = (t.matches || []).filter((m) => !PT.isScored(m));
    const players = (t.players || []).filter((p) => p !== name);
    const left = [...(t.left || []), { name, after: played.length }];
    const ids = (ms, start) => ms.map((m, i) => ({ ...m, id: `m${start + i + 1}` }));
    if (t.format === 'teams') {
      const team = (t.teams || []).find((x) => x.players.includes(name));
      const keep = open.filter((m) => !team || (m.ta !== team.id && m.tb !== team.id));
      return { ...t, players, left, withdrawn: [...(t.withdrawn || []), ...(team ? [team.id] : [])], matches: [...played, ...keep] };
    }
    const openSlots = [...new Set(open.filter((m) => m.stage === 'group').map((m) => m.slot))];
    const firstSlot = played.length ? Math.max(...played.map((m) => m.slot)) + 1 : 1;
    const rebuilt = openSlots.length ? PT.buildAmericano(players, openSlots.length, t.courts || 2, [], played, firstSlot) : [];
    return { ...t, players, left, ranking: played.length ? 'average' : t.ranking, matches: [...played, ...ids(rebuilt, played.length)] };
  };

  /** Swap one player for another everywhere (a no-show, a late change). */
  PT.replacePlayer = (t, from, to) => {
    const swap = (list) => list.map((p) => (p === from ? to : p));
    return {
      ...t,
      players: swap(t.players || []),
      teams: (t.teams || []).map((team) => ({ ...team, players: swap(team.players) })),
      matches: (t.matches || []).map((m) => ({ ...m, a: swap(m.a), b: swap(m.b) })),
    };
  };

  /** Everything one player (or team, by id) did: each game with partner, opponents, score and points. */
  PT.playerGames = (t, key) => {
    const teams = t.format === 'teams';
    return (t.matches || []).filter((m) => (teams ? m.ta === key || m.tb === key : m.a.includes(key) || m.b.includes(key))).map((m) => {
      const onA = teams ? m.ta === key : m.a.includes(key);
      const mine = onA ? m.a : m.b, theirs = onA ? m.b : m.a;
      const scored = PT.isScored(m);
      const pf = scored ? (onA ? m.sa : m.sb) : null, pa = scored ? (onA ? m.sb : m.sa) : null;
      return { slot: m.slot, stage: m.stage, court: m.court, partner: teams ? null : mine.find((p) => p !== key), mine, theirs, scored, pf, pa, won: scored ? pf > pa : null };
    }).sort((a, b) => a.slot - b.slot);
  };

  /** A rough "how long will this take" for the setup screen. */
  PT.estimate = (matches, pointsTo = 15) => {
    const slots = matches.length ? Math.max(...matches.map((m) => m.slot)) : 0;
    const perGame = PT.minutesPerGame(pointsTo);
    const courts = new Set(matches.map((m) => m.court)).size;   // courts actually in use
    return { games: matches.length, slots, minutes: slots * perGame, perGame, courts };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PT;
  else root.PT = PT;
})(typeof window !== 'undefined' ? window : this);
