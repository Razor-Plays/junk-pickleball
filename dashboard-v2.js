(() => {
  const SHEET_ID = '1pe2SvzjhPTlWaRfMWkuXmErbjPWHGIEraELYhZxgAHA';
  const BUILD_TAG = '2026-11-12.2';
  // The manager app's sheet API also serves an attendance-only feed (no money).
  const API_URL = (window.JPB_CONFIG && window.JPB_CONFIG.apiUrl) || '';
  const CSV_URL = (sheetName) => `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  const SNAPSHOT_ATTENDANCE_URL = './data/attendance_export_snapshot.csv';
  const SNAPSHOT_META_URL = './data/source_meta_snapshot.csv';

  const GUEST_REGEX = /^guest\s+\d+$/i;
  const PLACEHOLDER_NAMES = new Set(['', '-', 'na', 'n/a', 'null', 'none', 'unknown', 'tbd']);

  const state = {
    rawRows: [],
    sessions: [],
    players: [],
    syncLabel: '—',
    dataSource: 'loading',
    highlightFallback: null,
    charts: {},
  };

  const $ = (s) => document.querySelector(s);

  function showLoading(show) {
    $('#loadingState').classList.toggle('show', show);
  }

  function showError(message = '') {
    const el = $('#errorState');
    el.textContent = message;
    el.classList.toggle('show', Boolean(message));
  }

  function setDataSourceStatus(mode, detail = '') {
    state.dataSource = mode;
    const el = $('#dataSourceStatus');
    el.classList.remove('live', 'snapshot', 'error');
    if (mode === 'loading') {
      el.textContent = 'Loading…';
      return;
    }
    if (mode === 'live') {
      el.classList.add('live');
      el.textContent = 'Live from the club sheet · updates as soon as players are entered';
      return;
    }
    if (mode === 'snapshot') {
      el.classList.add('snapshot');
      el.textContent = detail ? `Showing a saved copy, not live (${detail})` : 'Showing a saved copy, not live';
      return;
    }
    el.classList.add('error');
    el.textContent = 'Data source: Error loading data';
  }

  function parseCsv(url) {
    return new Promise((resolve, reject) => {
      Papa.parse(url, {
        download: true,
        header: true,
        skipEmptyLines: true,
        complete: (result) => {
          if (result.errors?.length) {
            reject(new Error(result.errors[0].message || 'CSV parse error'));
            return;
          }
          resolve(result.data || []);
        },
        error: (err) => reject(err),
      });
    });
  }

  function pickColumn(row, candidates) {
    const entries = Object.entries(row);
    for (const c of candidates) {
      const found = entries.find(([k]) => k.trim().toLowerCase() === c);
      if (found) return found[1];
    }
    return '';
  }

  function cleanPlayerName(value) {
    const n = String(value || '').trim();
    if (PLACEHOLDER_NAMES.has(n.toLowerCase())) return '';
    if (GUEST_REGEX.test(n)) return '';
    return n;
  }

  function toIsoDate(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  }

  function formatDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
  }

  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const daysBetween = (a, b) => Math.max(0, Math.round((new Date(a) - new Date(b)) / 86400000));

  function formatNames(names) {
    if (!names.length) return '—';
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} & ${names[1]}`;
    return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
  }

  function topBy(players, getValue, { minValue = -Infinity, maxLeaders = 2 } = {}) {
    if (!players.length) return { leaders: [], value: null };
    const ranked = [...players].sort((a, b) => getValue(b) - getValue(a));
    const best = getValue(ranked[0]);
    if (best == null || best < minValue) return { leaders: [], value: null };
    const leaders = ranked.filter((p) => getValue(p) === best).slice(0, maxLeaders);
    return { leaders, value: best };
  }

  const BAR_COLOR = '#0E8AA6';

  function destroyCharts() {
    Object.values(state.charts).forEach((ch) => ch?.destroy());
    state.charts = {};
  }

  function inferRows(attendanceRows) {
    const normalized = [];

    for (const row of attendanceRows) {
      const sessionDateRaw = pickColumn(row, [
        'session_date',
        'date',
        'attendance_date',
        'session day',
      ]);
      const playerRaw = pickColumn(row, [
        'player_name',
        'player',
        'name',
        'participant_name',
        'participant',
      ]);
      const sessionIdRaw = pickColumn(row, ['session_id', 'session_key', 'session']);

      const sessionDate = toIsoDate(sessionDateRaw);
      const playerName = cleanPlayerName(playerRaw);
      if (!sessionDate || !playerName) continue;

      normalized.push({
        sessionDate,
        sessionId: String(sessionIdRaw || '').trim(),
        playerName,
      });
    }

    return normalized;
  }

  function buildSessions(rows, fromDate, toDate) {
    const map = new Map();

    for (const r of rows) {
      if (fromDate && r.sessionDate < fromDate) continue;
      if (toDate && r.sessionDate > toDate) continue;

      const key = r.sessionId ? `${r.sessionDate}__${r.sessionId}` : r.sessionDate;
      if (!map.has(key)) {
        map.set(key, {
          key,
          date: r.sessionDate,
          players: new Set(),
        });
      }
      map.get(key).players.add(r.playerName);
    }

    return [...map.values()]
      .map((s) => ({ ...s, players: [...s.players].sort((a, b) => a.localeCompare(b)) }))
      .sort((a, b) => (a.date === b.date ? a.key.localeCompare(b.key) : a.date.localeCompare(b.date)));
  }

  function buildPlayerStats(sessions) {
    const totalSessions = sessions.length;
    const playerIndices = new Map();

    sessions.forEach((session, idx) => {
      for (const p of session.players) {
        if (!playerIndices.has(p)) playerIndices.set(p, []);
        playerIndices.get(p).push(idx);
      }
    });

    const players = [];

    for (const [name, indices] of playerIndices.entries()) {
      const attendedSet = new Set(indices);
      const firstIdx = indices[0];
      const lastIdx = indices[indices.length - 1];

      const eligibleSessions = Math.max(1, totalSessions - firstIdx);
      const totalAttended = indices.length;
      const attendanceRate = totalAttended / eligibleSessions;

      let longestStreak = 0;
      let run = 0;
      for (let i = firstIdx; i < totalSessions; i += 1) {
        if (attendedSet.has(i)) {
          run += 1;
          if (run > longestStreak) longestStreak = run;
        } else {
          run = 0;
        }
      }

      let currentStreak = 0;
      for (let i = totalSessions - 1; i >= 0; i -= 1) {
        if (attendedSet.has(i)) currentStreak += 1;
        else break;
      }

      const start = Math.max(0, totalSessions - 10);
      let last10 = 0;
      for (let i = start; i < totalSessions; i += 1) {
        if (attendedSet.has(i)) last10 += 1;
      }

      const prevStart = Math.max(0, totalSessions - 20);
      const prevEnd = Math.max(0, totalSessions - 10);
      let prev10 = 0;
      for (let i = prevStart; i < prevEnd; i += 1) {
        if (attendedSet.has(i)) prev10 += 1;
      }

      players.push({
        playerName: name,
        totalAttended,
        firstAttendanceDate: sessions[firstIdx]?.date || '',
        lastAttendanceDate: sessions[lastIdx]?.date || '',
        attendanceRate,
        currentStreak,
        longestStreak,
        last10,
        prev10,
        improveDelta: last10 - prev10,
      });
    }

    players.sort((a, b) => b.totalAttended - a.totalAttended || a.playerName.localeCompare(b.playerName));
    return players;
  }

  function readLastSyncLabel(metaRows) {
    if (!metaRows?.length) return '—';

    const candidates = ['last_sync_date', 'last_sync', 'sync_date', 'updated_at', 'timestamp'];

    for (const row of metaRows) {
      for (const [k, v] of Object.entries(row)) {
        const key = k.trim().toLowerCase();
        if (candidates.includes(key) && String(v || '').trim()) {
          const parsed = toIsoDate(v);
          return parsed ? formatDate(parsed) : String(v);
        }
      }

      const keyField = pickColumn(row, ['key', 'name', 'metric']);
      const valueField = pickColumn(row, ['value', 'metric_value']);
      if (String(keyField).trim().toLowerCase().includes('sync') && String(valueField).trim()) {
        const parsed = toIsoDate(valueField);
        return parsed ? formatDate(parsed) : String(valueField);
      }
    }

    return '—';
  }

  function renderKpis(sessions, players, syncLabel) {
    $('#kpiSessions').textContent = String(sessions.length);
    $('#kpiPlayers').textContent = String(players.length);
    const avg = sessions.length ? (players.reduce((acc, p) => acc + p.totalAttended, 0) / sessions.length) : 0;
    $('#kpiAvg').textContent = avg.toFixed(1);
    $('#kpiSync').textContent = syncLabel || '—';
  }

  const NEWCOMER_DAYS = 90;

  // First game ever for each player, from every row we have (ignores the date filter).
  function firstEverDates() {
    const first = new Map();
    for (const r of state.rawRows) {
      const cur = first.get(r.playerName);
      if (!cur || r.sessionDate < cur) first.set(r.playerName, r.sessionDate);
    }
    return first;
  }

  // Players whose first game ever was in the 90 days before the latest session shown.
  function newcomers(players, sessions) {
    const latest = sessions[sessions.length - 1]?.date;
    if (!latest) return [];
    const first = firstEverDates();
    return players
      .map((p) => ({ ...p, firstEver: first.get(p.playerName) || p.firstAttendanceDate }))
      .filter((p) => p.firstEver && daysBetween(latest, p.firstEver) <= NEWCOMER_DAYS);
  }

  // Someone who played in the last 3 sessions after missing at least 6 in a row.
  function bestReturn(players, sessions) {
    let best = null;
    for (const p of players) {
      const idx = [];
      sessions.forEach((s, i) => { if (s.players?.includes(p.playerName)) idx.push(i); });
      if (idx.length < 2) continue;
      const last = idx[idx.length - 1];
      if (last < sessions.length - 3) continue;
      // walk back over the current run to find the gap before it
      let k = idx.length - 1;
      while (k > 0 && idx[k] - idx[k - 1] === 1) k -= 1;
      if (k === 0) continue;
      const gap = idx[k] - idx[k - 1] - 1;
      if (gap >= 6 && (!best || gap > best.gap)) best = { player: p, gap, since: sessions[idx[k - 1]].date };
    }
    return best;
  }

  function renderHighlights(players, sessions) {
    const el = $('#highlightsGrid');
    const recentWindow = Math.min(10, sessions.length);
    const latestIndex = sessions.length - 1;
    const latestDate = sessions[latestIndex]?.date;

    const streak = topBy(players, (p) => p.currentStreak, { minValue: 1 });
    const recent = topBy(players, (p) => p.last10, { minValue: 1 });
    const bestNewMember = topBy(newcomers(players, sessions), (p) => p.totalAttended, { minValue: 1 });
    const returned = bestReturn(players, sessions);
    // needs 20 sessions in view, or "the 10 before" isn't a fair comparison
    const rising = topBy(sessions.length >= 20 ? players.filter((p) => p.improveDelta > 0) : [], (p) => p.improveDelta, { minValue: 2 });

    // Assumption: comeback watch = meaningful prior contributor (8+ sessions) absent for last 6 sessions.
    const comebackPool = players
      .map((p) => ({
        ...p,
        lastSeenIdx: sessions.findIndex((s) => s.date === p.lastAttendanceDate),
      }))
      .filter((p) => p.totalAttended >= 8 && p.lastSeenIdx >= 0 && (latestIndex - p.lastSeenIdx) >= 6)
      .sort((a, b) => b.totalAttended - a.totalAttended || b.longestStreak - a.longestStreak);
    const comeback = comebackPool[0];

    const fallback = state.highlightFallback || {};

    const hot = streak.leaders.length
      ? { main: `${formatNames(streak.leaders.map((p) => p.playerName))} — ${streak.value} straight`, sub: 'Carrying the best active run right now.' }
      : (fallback.hot || { main: 'No current candidate', sub: 'Waiting on more sessions in this range.' });
    const active = recent.leaders.length
      ? { main: `${formatNames(recent.leaders.map((p) => p.playerName))} — ${recent.value}/${recentWindow || 10}`, sub: 'Setting the pace in recent sessions.' }
      : (fallback.active || { main: 'No current candidate', sub: 'Try widening the date filter.' });
    // Third card: a real newcomer if there is one; otherwise the best return, otherwise who is on the rise.
    const thirdCard = (() => {
      if (bestNewMember.leaders.length) {
        const p = bestNewMember.leaders[0];
        return { title: '🌱 Newest Face', main: `${formatNames(bestNewMember.leaders.map((x) => x.playerName))} — ${bestNewMember.value} session${bestNewMember.value === 1 ? '' : 's'} so far`, sub: `First session ${formatDate(p.firstEver)}. Welcome to the group.` };
      }
      if (returned) {
        return { title: '🙌 Welcome Back', main: `${returned.player.playerName} — back after ${returned.gap} sessions away`, sub: `Last played ${formatDate(returned.since)} before returning.` };
      }
      if (rising.leaders.length) {
        return { title: '📈 On the Rise', main: `${formatNames(rising.leaders.map((p) => p.playerName))} — +${rising.value} sessions`, sub: 'Last 10 sessions compared with the 10 before.' };
      }
      return { title: '🌱 Newest Face', main: 'Nobody new lately', sub: `No first-timers in the last ${NEWCOMER_DAYS} days. Bring a friend!` };
    })();
    const comebackCard = (() => {
      if (comeback) {
        const missingWeeks = latestDate ? Math.max(1, Math.round(daysBetween(latestDate, comeback.lastAttendanceDate) / 7)) : 0;
        return {
          main: `${comeback.playerName} — Missing for ${missingWeeks} week${missingWeeks === 1 ? '' : 's'}`,
          sub: `Last seen ${formatDate(comeback.lastAttendanceDate)}. Ready for a return.`,
        };
      }
      return fallback.comeback || { main: 'No current candidate', sub: 'Waiting for a clear comeback storyline.' };
    })();

    const cards = [
      { title: '🔥 Hot Streak', ...hot },
      { title: '🎯 Most Active (Last 10)', ...active },
      thirdCard,
      { title: '👀 Comeback Watch', ...comebackCard },
    ];

    el.innerHTML = cards.map((c) => `
      <article class="story-card">
        <div class="story-title">${c.title}</div>
        <div class="story-main">${c.main}</div>
        <div class="story-sub">${c.sub}</div>
      </article>
    `).join('');
  }

  function computeHighlightFallback() {
    if (!state.rawRows.length) {
      state.highlightFallback = null;
      return;
    }
    const allSessions = buildSessions(state.rawRows, '', '');
    const maxDate = allSessions[allSessions.length - 1]?.date;
    if (!maxDate) return;
    const from = new Date(new Date(maxDate).getTime() - (30 * 86400000)).toISOString().slice(0, 10);
    const baselineSessions = buildSessions(state.rawRows, from, maxDate);
    const baselinePlayers = buildPlayerStats(baselineSessions);
    if (!baselineSessions.length || !baselinePlayers.length) return;

    const recentWindow = Math.min(10, baselineSessions.length);
    const latestIndex = baselineSessions.length - 1;
    const latestDate = baselineSessions[latestIndex]?.date;
    const streak = topBy(baselinePlayers, (p) => p.currentStreak, { minValue: 1 });
    const recent = topBy(baselinePlayers, (p) => p.last10, { minValue: 1 });
    const comebackPool = baselinePlayers
      .map((p) => ({ ...p, lastSeenIdx: baselineSessions.findIndex((s) => s.date === p.lastAttendanceDate) }))
      .filter((p) => p.totalAttended >= 8 && p.lastSeenIdx >= 0 && (latestIndex - p.lastSeenIdx) >= 6)
      .sort((a, b) => b.totalAttended - a.totalAttended || b.longestStreak - a.longestStreak);
    const comeback = comebackPool[0];
    const missingWeeks = comeback && latestDate ? Math.max(1, Math.round(daysBetween(latestDate, comeback.lastAttendanceDate) / 7)) : 0;

    state.highlightFallback = {
      hot: streak.leaders.length ? {
        main: `${formatNames(streak.leaders.map((p) => p.playerName))} — ${streak.value} straight`,
        sub: 'Carrying the best active run right now.',
      } : null,
      active: recent.leaders.length ? {
        main: `${formatNames(recent.leaders.map((p) => p.playerName))} — ${recent.value}/${recentWindow || 10}`,
        sub: 'Setting the pace in recent sessions.',
      } : null,
      comeback: comeback ? {
        main: `${comeback.playerName} — Missing for ${missingWeeks} week${missingWeeks === 1 ? '' : 's'}`,
        sub: `Last seen ${formatDate(comeback.lastAttendanceDate)}. Ready for a return.`,
      } : null,
    };
  }

  function renderAwards(players, sessions) {
    const el = $('#awardsGrid');
    const hasHistory20 = sessions.length >= 20;
    const mostRegular = topBy(players, (p) => p.totalAttended, { minValue: 1 });
    const improvedPool = hasHistory20 ? players.filter((p) => p.improveDelta > 0) : [];
    const mostImproved = topBy(improvedPool, (p) => p.improveDelta, { minValue: 1 });
    const mostConsistent = topBy(players.filter((p) => p.totalAttended >= 8), (p) => Number((p.attendanceRate * 100).toFixed(1)), { minValue: 1 });
    const bestNewMemberAward = topBy(newcomers(players, sessions), (p) => p.totalAttended, { minValue: 1 });

    // Assumption: Fast Starter = best attendance in first 5 sessions after joining, later joiners only.
    const fastStarterPool = players.map((p) => {
      const firstIdx = sessions.findIndex((s) => s.date === p.firstAttendanceDate);
      const windowStart = Math.max(0, firstIdx);
      const windowEnd = Math.min(sessions.length, windowStart + 5);
      const eligible = Math.max(1, windowEnd - windowStart);
      let attended = 0;
      for (let i = windowStart; i < windowEnd; i += 1) {
        if (sessions[i]?.players?.includes(p.playerName)) attended += 1;
      }
      return { ...p, firstIdx, fastStarterScore: attended / eligible, fastStarterCount: attended };
    }).filter((p) => p.fastStarterCount >= 3 && p.firstIdx >= Math.max(8, sessions.length - 24));
    const fastStarter = topBy(fastStarterPool, (p) => p.fastStarterScore, { minValue: 0.2 });

    const maxTotal = Math.max(1, ...players.map((p) => p.totalAttended));
    const mostRegularName = mostRegular.leaders[0]?.playerName;
    // Assumption: Quiet Contributor favors balanced strength (rate + volume + recent form) while avoiding headline winners if possible.
    const quietPool = players
      .filter((p) => p.totalAttended >= 10 && p.attendanceRate >= 0.45 && p.last10 >= 3)
      .map((p) => ({
        ...p,
        quietScore: 0.45 * p.attendanceRate + 0.35 * (p.totalAttended / maxTotal) + 0.2 * (p.last10 / 10),
      }))
      .sort((a, b) => b.quietScore - a.quietScore);
    const quietWinner = quietPool.find((p) => ![mostRegularName].includes(p.playerName)) || quietPool[0];

    const awards = [
      {
        name: 'Most Regular Player',
        winner: formatNames(mostRegular.leaders.map((p) => p.playerName)),
        stat: `${mostRegular.value || 0} sessions`,
        note: 'Still setting the pace.',
      },
      {
        name: 'Most Improved',
        winner: formatNames(mostImproved.leaders.map((p) => p.playerName)),
        stat: `${mostImproved.value ? `+${mostImproved.value}` : '+0'} vs previous 10`,
        note: 'Best jump from previous 10 to last 10.',
      },
      {
        name: 'Fast Starter',
        winner: formatNames(fastStarter.leaders.map((p) => p.playerName)),
        stat: fastStarter.leaders.length ? `${pct(fastStarter.value)} in first 5` : '—',
        note: 'Best first five sessions after joining.',
      },
      {
        name: 'Best New Member',
        winner: formatNames(bestNewMemberAward.leaders.map((p) => p.playerName)),
        stat: bestNewMemberAward.leaders.length ? `${bestNewMemberAward.value} sessions since joining` : '—',
        note: `Most games among players who joined in the last ${NEWCOMER_DAYS} days.`,
      },
      {
        name: 'Quiet Contributor',
        winner: quietWinner?.playerName || '—',
        stat: quietWinner ? `${pct(quietWinner.attendanceRate)} rate • ${quietWinner.last10}/10 recent` : '—',
        note: 'Consistent impact without the spotlight.',
      },
      {
        name: 'Most Consistent Presence',
        winner: formatNames(mostConsistent.leaders.map((p) => p.playerName)),
        stat: `${mostConsistent.value ? mostConsistent.value.toFixed(1) : '0.0'}% rate`,
        note: 'Best attendance rate among regulars.',
      },
    ];

    // An award nobody qualifies for is left out, not shown as a blank card.
    el.innerHTML = awards.filter((a) => a.winner && a.winner !== '—').map((a) => `
      <article class="award-card">
        <div class="award-name">${a.name}</div>
        <div class="award-winner">${a.winner}</div>
        <div class="award-stat">${a.stat}</div>
        <div class="award-note">${a.note}</div>
      </article>
    `).join('');
  }

  function renderAllTimeGreats(players) {
    const el = $('#allTimeGrid');
    const streakLegend = topBy(players, (p) => p.longestStreak, { minValue: 1 });
    const grinder = topBy(players, (p) => p.totalAttended, { minValue: 1 });
    const core5 = [...players].sort((a, b) => b.totalAttended - a.totalAttended).slice(0, 5);

    el.innerHTML = `
      <article class="legacy-card iron">
        <div class="legacy-label">🔥 The Iron Paddle</div>
        <div class="legacy-name">${formatNames(streakLegend.leaders.map((p) => p.playerName))}</div>
        <div class="legacy-stat">${streakLegend.value || 0} straight</div>
        <div class="legacy-sub">Longest run in group history.</div>
      </article>
      <article class="legacy-card grinder">
        <div class="legacy-label">💪 The Grinder</div>
        <div class="legacy-name">${formatNames(grinder.leaders.map((p) => p.playerName))}</div>
        <div class="legacy-stat">${grinder.value || 0} sessions</div>
        <div class="legacy-sub">Always in the mix.</div>
      </article>
      <article class="core-card">
        <div class="legacy-label">🏅 Active Core 5</div>
        <div class="legacy-name">The backbone of the group</div>
        <ol class="core-list">
          ${core5.map((p, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '•';
      return `<li><span>${medal} ${p.playerName}</span><strong>${p.totalAttended}</strong></li>`;
    }).join('')}
        </ol>
      </article>
    `;
  }

  function renderCharts(players, sessions) {
    destroyCharts();

    // One series per chart, so every bar wears the same club blue (checked for
    // contrast on the white card); axes and grid stay quiet.
    Chart.defaults.color = '#5A6E80';
    Chart.defaults.borderColor = '#EBDFC9';
    Chart.defaults.plugins.legend.display = false;
    Chart.defaults.scales.category.ticks.autoSkip = false;   // name every bar, even on a phone
    Chart.defaults.font.size = 11;
    Chart.defaults.datasets.bar.borderWidth = 0;
    Chart.defaults.datasets.bar.borderRadius = 4;
    Chart.defaults.datasets.bar.maxBarThickness = 24;

    const leaders = [...players].sort((a, b) => b.totalAttended - a.totalAttended).slice(0, 12);
    const fairness = [...players]
      .filter((p) => p.totalAttended >= 5)
      .sort((a, b) => b.attendanceRate - a.attendanceRate)
      .slice(0, 12);
    const form = [...players].sort((a, b) => b.last10 - a.last10 || b.totalAttended - a.totalAttended).slice(0, 12);
    const dowCounts = new Map([['Mon', 0], ['Tue', 0], ['Wed', 0], ['Thu', 0], ['Fri', 0], ['Sat', 0], ['Sun', 0]]);
    sessions.forEach((s) => {
      const key = new Date(s.date).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
      dowCounts.set(key, (dowCounts.get(key) || 0) + 1);
    });

    const leadersCtx = document.getElementById('leadersChart').getContext('2d');
    const rateCtx = document.getElementById('rateChart').getContext('2d');
    const formCtx = document.getElementById('formChart').getContext('2d');
    const dowCtx = document.getElementById('dowChart').getContext('2d');

    state.charts.leaders = new Chart(leadersCtx, {
      type: 'bar',
      data: {
        labels: leaders.map((x) => x.playerName),
        datasets: [{
          label: 'Sessions Attended',
          data: leaders.map((x) => x.totalAttended),
          backgroundColor: BAR_COLOR,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        scales: { x: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });

    state.charts.rate = new Chart(rateCtx, {
      type: 'bar',
      data: {
        labels: fairness.map((x) => x.playerName),
        datasets: [{
          label: 'Attendance Rate %',
          data: fairness.map((x) => +(x.attendanceRate * 100).toFixed(1)),
          backgroundColor: BAR_COLOR,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        scales: { x: { beginAtZero: true, max: 100 } },
      },
    });

    state.charts.form = new Chart(formCtx, {
      type: 'bar',
      data: {
        labels: form.map((x) => x.playerName),
        datasets: [{
          label: 'Last 10 Sessions',
          data: form.map((x) => x.last10),
          backgroundColor: BAR_COLOR,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { x: { beginAtZero: true, max: 10, ticks: { precision: 0 } } },
      },
    });

    state.charts.dow = new Chart(dowCtx, {
      type: 'bar',
      data: {
        labels: [...dowCounts.keys()],
        datasets: [{ label: 'Sessions', data: [...dowCounts.values()], backgroundColor: BAR_COLOR }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { grid: { display: false } } },
      },
    });
  }

  function renderTable(players) {
    const body = $('#playerTableBody');
    body.innerHTML = '';

    for (const p of players) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${p.playerName}</td>
        <td>${p.totalAttended}</td>
        <td>${(p.attendanceRate * 100).toFixed(1)}%</td>
        <td>${formatDate(p.lastAttendanceDate)}</td>
        <td>${p.currentStreak}</td>
        <td>${p.longestStreak}</td>
      `;
      body.appendChild(tr);
    }
  }

  async function loadApiData() {
    const res = await fetch(`${API_URL}?view=stats&t=${Date.now()}`, { redirect: 'follow', cache: 'no-store' });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'stats feed unavailable');
    // A session shows up as soon as its players are entered in the app, even the same evening.
    const rows = json.rows || [];
    const last = json.last_session || '';
    return {
      attendanceRows: rows,
      metaRows: last ? [{ last_sync_date: last }] : [],
      sourceMode: 'live',
    };
  }

  async function loadSnapshotData(reason) {
    const [attendanceRows, metaRows] = await Promise.all([
      parseCsv(SNAPSHOT_ATTENDANCE_URL),
      parseCsv(SNAPSHOT_META_URL).catch(() => []),
    ]);
    return { attendanceRows, metaRows, sourceMode: 'snapshot', sourceDetail: reason };
  }

  async function loadSheetsData() {
    if (API_URL) {
      try {
        return await loadApiData();
      } catch (apiErr) {
        return loadSnapshotData(apiErr?.message ? `live failed: ${apiErr.message}` : 'live fetch failed');
      }
    }
    try {
      const [attendanceRows, metaRows] = await Promise.all([
        parseCsv(CSV_URL('attendance_export')),
        parseCsv(CSV_URL('source_meta')).catch(() => []),
      ]);
      return { attendanceRows, metaRows, sourceMode: 'live' };
    } catch (liveErr) {
      const [attendanceRows, metaRows] = await Promise.all([
        parseCsv(SNAPSHOT_ATTENDANCE_URL),
        parseCsv(SNAPSHOT_META_URL).catch(() => []),
      ]);
      return {
        attendanceRows,
        metaRows,
        sourceMode: 'snapshot',
        sourceDetail: liveErr?.message ? `live failed: ${liveErr.message}` : 'live fetch failed',
      };
    }
  }

  function getDateFilters() {
    const from = $('#fromDate').value || '';
    const to = $('#toDate').value || '';
    return { from, to };
  }

  function applyAndRender() {
    const { from, to } = getDateFilters();
    state.sessions = buildSessions(state.rawRows, from, to);
    state.players = buildPlayerStats(state.sessions);

    renderKpis(state.sessions, state.players, state.syncLabel);
    renderHighlights(state.players, state.sessions);
    renderAwards(state.players, state.sessions);
    renderAllTimeGreats(state.players);
    renderCharts(state.players, state.sessions);
    renderTable(state.players);
  }

  async function refresh() {
    showError('');
    showLoading(true);
    setDataSourceStatus('loading');

    try {
      const { attendanceRows, metaRows, sourceMode, sourceDetail } = await loadSheetsData();
      state.rawRows = inferRows(attendanceRows);
      state.syncLabel = readLastSyncLabel(metaRows);
      computeHighlightFallback();
      setDataSourceStatus(sourceMode, sourceDetail);

      if (!state.rawRows.length) {
        throw new Error('No usable rows found in attendance_export. Verify public sheet + expected columns (session_date/player_name).');
      }

      const dates = [...new Set(state.rawRows.map((r) => r.sessionDate))].sort((a, b) => a.localeCompare(b));
      if (dates.length) {
        if (!$('#fromDate').value) $('#fromDate').value = dates[0];
        if (!$('#toDate').value) $('#toDate').value = dates[dates.length - 1];
      }

      applyAndRender();
    } catch (err) {
      showError(`Unable to load dashboard data: ${err.message || err}`);
      setDataSourceStatus('error');
      destroyCharts();
      $('#playerTableBody').innerHTML = '';
      $('#highlightsGrid').innerHTML = '';
      $('#awardsGrid').innerHTML = '';
      $('#allTimeGrid').innerHTML = '';
      ['#kpiSessions', '#kpiPlayers', '#kpiAvg'].forEach((sel) => { $(sel).textContent = '—'; });
      $('#kpiSync').textContent = state.syncLabel || '—';
    } finally {
      showLoading(false);
    }
  }

  function boot() {
    $('#buildTag').textContent = `Build: ${BUILD_TAG}`;
    $('#refreshBtn').addEventListener('click', refresh);
    $('#fromDate').addEventListener('change', applyAndRender);
    $('#toDate').addEventListener('change', applyAndRender);
    refresh();
  }

  boot();
})();
