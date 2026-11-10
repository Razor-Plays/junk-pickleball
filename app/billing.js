/*
 * Junk Pickleball — billing logic.
 *
 * Pure functions only (no DOM, no network) so the same file runs in the
 * browser app and in Node tests.
 *
 * Data shape (one array per sheet tab, see apps-script/Code.gs):
 *   players     [{ name, role: 'member'|'player', active, phone, notes }]
 *   sessions    [{ id, date: 'YYYY-MM-DD', reclub_fee, notes }]
 *   bookings    [{ session_id, member, hours, rate }]
 *   attendance  [{ session_id, name, guest, pays }]
 *   memberships [{ id, member, date, amount, hours, rate, notes }]
 *   payments    [{ month: 'YYYY-MM', person, amount, paid_on, note }]
 *   kitty       [{ id, date, description, amount }]
 *   settings    { default_rate, reclub_fee, currency, club_name, pay_to }
 *
 * Money rules (same as the original sheet):
 *   - Session cost = sum of booked hours x the rate stored on each booking.
 *   - Cost per player (CPP) = cost / headcount, rounded to 2 decimals.
 *     Guests count as heads.
 *   - Every attendance row charges CPP to whoever `pays` for it
 *     (the player themselves, the player who brought the guest, or Reclub).
 *   - Members don't pay a bill. Their payback = value of the hours they
 *     booked - everything charged to them (their own CPP and their guests').
 *   - Reclub guests pay the Reclub fee; the difference over CPP goes to
 *     the kitty.
 */
(function (root) {
  'use strict';

  const RECLUB = 'Reclub';
  const PB = { RECLUB };

  // ---------- small helpers ----------

  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  PB.round2 = round2;

  const num = (v, fallback = 0) => {
    if (v === null || v === undefined || v === '') return fallback;
    const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : fallback;
  };
  PB.num = num;

  const bool = (v) => v === true || String(v).trim().toLowerCase() === 'true';
  PB.bool = bool;

  const clean = (v) => String(v === null || v === undefined ? '' : v).trim();

  PB.monthOf = (date) => clean(date).slice(0, 7);

  /** Names are compared ignoring case and extra spaces: "neil " is "Neil". */
  PB.nameKey = (name) => clean(name).toLowerCase().replace(/\s+/g, ' ');

  /** The existing player whose name clashes with `name`, if any. */
  PB.playerNamed = (data, name, except = '') => {
    const key = PB.nameKey(name);
    return data.players.find((p) => PB.nameKey(p.name) === key && p.name !== except) || null;
  };

  PB.monthLabel = (month) => {
    const [y, m] = month.split('-').map(Number);
    const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
      'August', 'September', 'October', 'November', 'December'];
    return `${names[m - 1]} ${y}`;
  };

  PB.shiftMonth = (month, delta) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  PB.dayLabel = (date, withYear = false) => {
    const [y, m, d] = date.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getUTCDay()];
    const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
    return `${wd} ${d} ${mo}${withYear ? ' ' + y : ''}`;
  };

  PB.money = (n, currency = '$') => {
    const v = round2(n);
    const sign = v < 0 ? '-' : '';
    return `${sign}${currency}${Math.abs(v).toFixed(2)}`;
  };

  // ---------- normalise raw rows (from the API or a cache) ----------

  PB.normalize = (raw) => {
    const r = raw || {};
    const settings = Object.assign(
      { default_rate: 140, reclub_fee: 100, currency: '$', club_name: 'Junk Pickleball', pay_to: 'Tommy', public_stats: 'TRUE' },
      r.settings || {}
    );
    settings.default_rate = num(settings.default_rate, 140);
    settings.reclub_fee = num(settings.reclub_fee, 100);

    return {
      settings,
      players: (r.players || []).filter((p) => clean(p.name)).map((p) => ({
        name: clean(p.name),
        role: clean(p.role).toLowerCase() === 'member' ? 'member' : 'player',
        active: p.active === undefined || p.active === '' ? true : bool(p.active),
        phone: clean(p.phone),
        notes: clean(p.notes),
      })),
      sessions: (r.sessions || []).filter((s) => clean(s.id) && clean(s.date)).map((s) => ({
        id: clean(s.id),
        date: clean(s.date).slice(0, 10),
        reclub_fee: s.reclub_fee === '' || s.reclub_fee === undefined ? settings.reclub_fee : num(s.reclub_fee),
        notes: clean(s.notes),
        updated_at: clean(s.updated_at),
      })),
      bookings: (r.bookings || []).filter((b) => clean(b.session_id) && clean(b.member) && num(b.hours) > 0)
        .map((b) => ({
          session_id: clean(b.session_id),
          member: clean(b.member),
          hours: num(b.hours),
          rate: num(b.rate, settings.default_rate),
        })),
      attendance: (r.attendance || []).filter((a) => clean(a.session_id) && clean(a.name)).map((a) => ({
        session_id: clean(a.session_id),
        name: clean(a.name),
        guest: bool(a.guest),
        pays: clean(a.pays) || clean(a.name),
      })),
      memberships: (r.memberships || []).filter((m) => clean(m.member)).map((m) => ({
        id: clean(m.id),
        member: clean(m.member),
        date: clean(m.date).slice(0, 10),
        amount: num(m.amount),
        hours: num(m.hours),
        rate: num(m.rate) || (num(m.hours) ? round2(num(m.amount) / num(m.hours)) : settings.default_rate),
        notes: clean(m.notes),
      })),
      payments: (r.payments || []).filter((p) => clean(p.month) && clean(p.person)).map((p) => ({
        month: clean(p.month).slice(0, 7),
        person: clean(p.person),
        amount: num(p.amount),
        paid_on: clean(p.paid_on).slice(0, 10),
        note: clean(p.note),
      })),
      kitty: (r.kitty || []).filter((k) => clean(k.date) || clean(k.description)).map((k) => ({
        id: clean(k.id),
        date: clean(k.date).slice(0, 10),
        description: clean(k.description),
        amount: num(k.amount),
      })),
    };
  };

  // ---------- core calculations ----------

  const groupBy = (rows, key) => {
    const m = new Map();
    for (const r of rows) {
      const k = r[key];
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };

  PB.index = (data) => ({
    bookings: groupBy(data.bookings, 'session_id'),
    attendance: groupBy(data.attendance, 'session_id'),
    players: new Map(data.players.map((p) => [p.name, p])),
  });

  PB.isMember = (data, name) => data.players.some((p) => p.name === name && p.role === 'member');

  /** Everything about one session. */
  PB.sessionSummary = (data, session, idx = PB.index(data)) => {
    const bookings = idx.bookings.get(session.id) || [];
    const attendance = idx.attendance.get(session.id) || [];
    const hours = bookings.reduce((s, b) => s + b.hours, 0);
    const cost = round2(bookings.reduce((s, b) => s + b.hours * b.rate, 0));
    const heads = attendance.length;
    const cpp = heads ? round2(cost / heads) : 0;
    const reclubHeads = attendance.filter((a) => a.pays === RECLUB).length;
    return {
      session, id: session.id, date: session.date,
      bookings, attendance, hours, cost, heads, cpp,
      reclubHeads,
      reclubIncome: round2(reclubHeads * session.reclub_fee),
      reclubProfit: round2(reclubHeads * (session.reclub_fee - cpp)),
    };
  };

  PB.sessionsInMonth = (data, month) =>
    data.sessions.filter((s) => PB.monthOf(s.date) === month)
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  /**
   * The monthly statement: who owes what, member paybacks, Reclub, checks.
   */
  PB.monthStatement = (data, month) => {
    const idx = PB.index(data);
    const sessions = PB.sessionsInMonth(data, month).map((s) => PB.sessionSummary(data, s, idx));
    const memberNames = new Set(data.players.filter((p) => p.role === 'member').map((p) => p.name));
    const playerNames = new Set(data.players.map((p) => p.name));

    const people = new Map(); // payer -> { name, items: [], total }
    const getPerson = (name) => {
      if (!people.has(name)) people.set(name, { name, items: [], charges: 0, credits: 0 });
      return people.get(name);
    };

    const warnings = [];
    let courtCost = 0;
    let allocated = 0;

    for (const s of sessions) {
      courtCost += s.cost;
      if (s.hours > 0 && s.heads === 0) {
        warnings.push({ type: 'no-players', session: s.id,
          text: `${PB.dayLabel(s.date)}: ${s.hours}h booked but no players entered` });
      }
      if (s.heads > 0 && s.hours === 0) {
        warnings.push({ type: 'no-bookings', session: s.id,
          text: `${PB.dayLabel(s.date)}: players entered but no court hours booked` });
      }
      for (const b of s.bookings) {
        const p = getPerson(b.member);
        const value = round2(b.hours * b.rate);
        p.credits = round2(p.credits + value);
        p.items.push({ session: s.id, date: s.date, kind: 'booking', hours: b.hours, rate: b.rate, amount: value });
      }
      for (const a of s.attendance) {
        allocated += s.cpp;
        const payer = a.pays || a.name;
        if (payer === 'Unassigned') {
          warnings.push({ type: 'unassigned', session: s.id,
            text: `${PB.dayLabel(s.date)}: guest "${a.name}" has nobody assigned to pay` });
        }
        const p = getPerson(payer);
        p.charges = round2(p.charges + s.cpp);
        // 'guest' = someone this person brought. A visitor paying their own
        // way is simply playing for themselves.
        const hosted = a.guest && a.name !== payer;
        p.items.push({ session: s.id, date: s.date, kind: hosted ? 'guest' : 'self', who: a.name, amount: s.cpp });
      }
    }

    const paidMap = new Map(data.payments.filter((p) => p.month === month).map((p) => [p.person, p]));

    const players = [];
    const members = [];
    let reclub = null;

    // Split what someone is charged into their own games and each guest's share.
    const split = (items) => {
      let own = 0;
      let games = 0;
      const guests = new Map();
      for (const i of items) {
        if (i.kind === 'self') { own += i.amount; games += 1; }
        if (i.kind !== 'guest') continue;
        const g = guests.get(i.who) || { name: i.who, amount: 0, count: 0 };
        g.amount = round2(g.amount + i.amount);
        g.count += 1;
        guests.set(i.who, g);
      }
      return { own: round2(own), games, guests: [...guests.values()].sort((a, b) => a.name.localeCompare(b.name)) };
    };

    for (const p of people.values()) {
      const paid = paidMap.get(p.name) || null;
      if (p.name === RECLUB) {
        const income = round2(sessions.reduce((s, x) => s + x.reclubIncome, 0));
        reclub = {
          name: RECLUB, heads: p.items.length, courtShare: p.charges, income,
          profit: round2(income - p.charges), items: p.items, paid,
        };
      } else if (memberNames.has(p.name)) {
        members.push({
          name: p.name, credits: p.credits, charges: p.charges,
          payback: round2(p.credits - p.charges), items: p.items, paid, ...split(p.items),
        });
      } else {
        // isGuest: not on the Players list, i.e. a visitor paying their own way.
        players.push({ name: p.name, total: p.charges, items: p.items, paid, ...split(p.items),
          isGuest: !playerNames.has(p.name) });
      }
    }

    players.sort((a, b) => a.name.localeCompare(b.name));
    members.sort((a, b) => a.name.localeCompare(b.name));

    courtCost = round2(courtCost);
    allocated = round2(allocated);
    const totalPlayers = round2(players.reduce((s, p) => s + p.total, 0));
    const totalPayback = round2(members.reduce((s, m) => s + m.payback, 0));
    const unallocated = round2(sessions.filter((s) => s.heads === 0).reduce((s, x) => s + x.cost, 0));
    const roundingDiff = round2(allocated - (courtCost - unallocated));

    return {
      month, sessions, players, members, reclub, warnings,
      totals: {
        courtCost, allocated, unallocated, roundingDiff,
        players: totalPlayers,
        payback: totalPayback,
        reclubIncome: reclub ? reclub.income : 0,
        reclubProfit: reclub ? reclub.profit : 0,
        // Money check: what players + Reclub court share + members' own costs
        // add up to vs. the cost of the courts that had players.
        balanced: Math.abs(roundingDiff) < 0.1,
      },
    };
  };

  /** Hours bought vs used per member, oldest purchase used first. */
  PB.membershipBalances = (data) => {
    const members = data.players.filter((p) => p.role === 'member');
    const names = new Set(members.map((m) => m.name));
    for (const m of data.memberships) names.add(m.member);
    const used = new Map();
    for (const b of data.bookings) used.set(b.member, round2((used.get(b.member) || 0) + b.hours));

    return [...names].sort().map((name) => {
      const lots = data.memberships.filter((m) => m.member === name)
        .sort((a, b) => a.date.localeCompare(b.date));
      const purchased = round2(lots.reduce((s, l) => s + l.hours, 0));
      const u = used.get(name) || 0;
      let remainingUse = u;
      let currentRate = null;
      for (const l of lots) {
        if (remainingUse < l.hours) { currentRate = l.rate; break; }
        remainingUse -= l.hours;
      }
      return {
        name, lots, purchased, used: u, left: round2(purchased - u),
        currentRate, active: members.some((m) => m.name === name && m.active),
      };
    });
  };

  /** Rate to pre-fill for a new booking by this member. */
  PB.nextRate = (data, member) => {
    const bal = PB.membershipBalances(data).find((b) => b.name === member);
    if (bal && bal.currentRate) return bal.currentRate;
    if (bal && bal.lots.length) return bal.lots[bal.lots.length - 1].rate;
    return data.settings.default_rate;
  };

  /** Kitty = Reclub profit from every session + manual entries (e.g. balls bought). */
  PB.kitty = (data) => {
    const idx = PB.index(data);
    let reclubProfit = 0;
    const reclubSessions = [];
    for (const s of data.sessions) {
      const sum = PB.sessionSummary(data, s, idx);
      if (sum.reclubHeads > 0) {
        reclubProfit += sum.reclubProfit;
        reclubSessions.push(sum);
      }
    }
    reclubProfit = round2(reclubProfit);
    const entriesTotal = round2(data.kitty.reduce((s, k) => s + k.amount, 0));
    return {
      reclubProfit, entriesTotal, balance: round2(reclubProfit + entriesTotal),
      reclubSessions: reclubSessions.sort((a, b) => b.date.localeCompare(a.date)),
      entries: [...data.kitty].sort((a, b) => b.date.localeCompare(a.date)),
    };
  };

  /**
   * Unpaid bills from months before `month`. Only months where at least one
   * payment was recorded count, so history from before payment tracking
   * started doesn't show up as a wall of debts.
   */
  PB.outstanding = (data, month) => {
    const tracked = [...new Set(data.payments.map((p) => p.month))].filter((m) => m < month).sort();
    const out = [];
    for (const m of tracked) {
      const st = PB.monthStatement(data, m);
      for (const p of st.players) if (!p.paid && p.total > 0) out.push({ month: m, name: p.name, amount: p.total });
      for (const mem of st.members) if (!mem.paid && mem.payback < 0) out.push({ month: m, name: mem.name, amount: round2(-mem.payback) });
    }
    return out;
  };

  /** Named guests seen before, most recent first, with who paid for them last time. */
  PB.knownGuests = (data) => {
    const dates = new Map(data.sessions.map((s) => [s.id, s.date]));
    const seen = new Map();
    const playerKeys = new Set(data.players.map((p) => PB.nameKey(p.name)));
    for (const a of data.attendance) {
      if (!a.guest || a.pays === RECLUB || a.pays === 'Unassigned') continue;
      if (/^guest\s*\d+$/i.test(a.name) || /friend$/i.test(a.name)) continue;
      if (playerKeys.has(PB.nameKey(a.name))) continue;
      const date = dates.get(a.session_id) || '';
      const cur = seen.get(a.name);
      if (!cur || date >= cur.date) seen.set(a.name, { name: a.name, pays: a.pays, date, count: (cur ? cur.count : 0) + 1 });
      else cur.count += 1;
    }
    return [...seen.values()].sort((a, b) => b.date.localeCompare(a.date));
  };

  /** Guests who have come often enough that they should probably be regulars. */
  PB.regularSuggestions = (data, minVisits = 3) =>
    PB.knownGuests(data).filter((g) => g.count >= minVisits).sort((a, b) => b.count - a.count);

  /** How often each person played since `sinceDate` (for sorting chips). */
  PB.frequency = (data, sinceDate = '') => {
    const dates = new Map(data.sessions.map((s) => [s.id, s.date]));
    const f = new Map();
    for (const a of data.attendance) {
      if (a.guest) continue;
      if ((dates.get(a.session_id) || '') < sinceDate) continue;
      f.set(a.name, (f.get(a.name) || 0) + 1);
    }
    return f;
  };

  PB.newSessionId = (date) =>
    `s${date.replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6)}`;

  // ---------- messages ----------

  const describeItem = (i, cur) => {
    if (i.kind === 'booking') return `${PB.dayLabel(i.date)}: booked ${i.hours}h (+${PB.money(i.amount, cur)})`;
    if (i.kind === 'guest') return `${PB.dayLabel(i.date)}: guest ${i.who} ${PB.money(i.amount, cur)}`;
    return `${PB.dayLabel(i.date)}: ${PB.money(i.amount, cur)}`;
  };

  // "Jeremy: $106.91" lines, so a host knows what to collect from each guest.
  const guestShareLines = (entry, cur) => entry.guests.map((g) =>
    `${g.name}${g.count > 1 ? ` (${g.count} games)` : ''}: ${PB.money(g.amount, cur)}`);

  PB.playerMessage = (entry, month, settings) => {
    const cur = settings.currency || '$';
    const lines = entry.items.map((i) => `• ${describeItem(i, cur)}`);
    const shares = entry.guests.length
      ? [`Your own games: ${PB.money(entry.own, cur)}`, ...guestShareLines(entry, cur)]
      : [];
    return [
      `Hi ${entry.name}! Your ${settings.club_name || 'pickleball'} court fees for ${PB.monthLabel(month)}:`,
      ...lines,
      ...shares,
      `Total: ${PB.money(entry.total, cur)}`,
      'Thanks! 🥒🎾',
    ].join('\n');
  };

  PB.memberMessage = (entry, month, settings) => {
    const cur = settings.currency || '$';
    const own = entry.items.filter((i) => i.kind !== 'booking');
    const lines = [
      `Hi ${entry.name}! Your membership payback for ${PB.monthLabel(month)}:`,
      `Courts booked on your membership: ${PB.money(entry.credits, cur)}`,
      ...entry.items.filter((i) => i.kind === 'booking').map((i) => `• ${describeItem(i, cur)}`),
      `Less your court fees: ${PB.money(entry.charges, cur)}`,
      ...own.map((i) => `• ${describeItem(i, cur)}`),
      ...(entry.guests.length ? guestShareLines(entry, cur).map((l) => `Of which ${l}`) : []),
      entry.payback >= 0
        ? `Payback to you: ${PB.money(entry.payback, cur)}`
        : `You owe: ${PB.money(-entry.payback, cur)}`,
      '🥒🎾',
    ];
    return lines.join('\n');
  };

  PB.sessionMessage = (summary, settings) => {
    const cur = settings.currency || '$';
    const names = summary.attendance.map((a) => a.name).join(', ');
    return `${PB.dayLabel(summary.date)} — ${summary.heads} players (${names}). ` +
      `${summary.hours}h of court, ${PB.money(summary.cpp, cur)} each. ` +
      `It's added to your monthly total! 🥒🎾`;
  };

  /**
   * The monthly summary for the group chat. Everyone is listed with their own
   * fee; guests get their own line (with their host named) so the host knows
   * what to collect. Members are shown too, but their fee comes off their
   * payback. *Stars* make the headings bold in WhatsApp.
   */
  PB.groupMessage = (stmt, settings) => {
    const cur = settings.currency || '$';
    const line = (name, amount, note = '') => `• ${name}: ${PB.money(amount, cur)}${note}`;
    const out = [`*${settings.club_name || 'Pickleball'} — ${PB.monthLabel(stmt.month)} court fees*`];

    const regulars = stmt.players.filter((p) => !p.isGuest && p.own > 0);
    if (regulars.length) out.push('', '*Regulars*', ...regulars.map((p) => line(p.name, p.own)));

    const guests = stmt.players.filter((p) => p.isGuest && p.own > 0).map((p) => ({ name: p.name, amount: p.own, note: '' }));
    for (const host of [...stmt.players, ...stmt.members]) {
      for (const g of host.guests) {
        const note = host.name === 'Unassigned' ? ' (no payer set)' : ` (${host.name}'s guest)`;
        guests.push({ name: g.name, amount: g.amount, note });
      }
    }
    guests.sort((a, b) => a.name.localeCompare(b.name));
    if (guests.length) out.push('', '*Guests*', ...guests.map((g) => line(g.name, g.amount, g.note)));

    const members = stmt.members.filter((m) => m.own > 0);
    if (members.length) out.push('', '*Members* (taken off their payback)', ...members.map((m) => line(m.name, m.own)));

    const hosted = guests.some((g) => g.note);
    out.push('', `Please pay ${settings.pay_to || 'the organiser'}${hosted ? ' — hosts settle up for their guests' : ''}. Thanks! 🥒🎾`);
    return out.join('\n');
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PB;
  else root.PB = PB;
})(typeof window !== 'undefined' ? window : this);
