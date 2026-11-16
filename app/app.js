/* Junk Pickleball manager app. Vanilla JS, no build step. Uses PB from billing.js. */
(function () {
  'use strict';

  const LS = {
    api: 'jpb.apiUrl',
    code: 'jpb.code',
    cache: 'jpb.cache',
    theme: 'jpb.theme',
    notRegular: 'jpb.notRegular',
    tab: 'jpb.tab',
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  const state = {
    apiUrl: (window.JPB_CONFIG && window.JPB_CONFIG.apiUrl) || store.get(LS.api) || '',
    code: store.get(LS.code) || '',
    raw: null,
    data: null,
    tab: store.get(LS.tab) || 'sessions',
    month: null,
    busy: false,
    draft: null,      // session being edited
    showAllSessions: false,
  };

  const API_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;
  const configuredUrl = (window.JPB_CONFIG && window.JPB_CONFIG.apiUrl) || '';

  (function readInviteLink() {
    if (!location.hash || location.hash.length < 3) return;
    const params = new URLSearchParams(location.hash.slice(1));
    const k = (params.get('k') || '').trim();
    const u = (params.get('u') || '').trim();
    if (k) {
      // Only kept once it has worked, so a stale link can't sign a phone out.
      state.invite = { prevCode: state.code, prevUrl: state.apiUrl };
      if (!configuredUrl && API_URL_RE.test(u)) state.apiUrl = u;
      state.code = k;
    }
    // Take the code out of the address bar so it isn't left in history or screenshots.
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  })();

  function inviteLink(code = state.code) {
    const params = new URLSearchParams();
    params.set('k', code);
    if (!configuredUrl) params.set('u', state.apiUrl);
    return `${location.origin}${location.pathname}#${params.toString()}`;
  }

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const money = (n) => PB.money(n, state.data ? state.data.settings.currency : '$');
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // ------------------------------------------------------------ icons

  const ICON = {
    moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
    sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/></svg>',
    bell: '<svg class="bell" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0" fill="none"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.5-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.5 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.2"/></svg>',
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 3 10 14"/><path d="M21 3l-6.5 18-4-7.5L3 9.5z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M4 12h16"/></svg>',
  };

  // ------------------------------------------------------------ day / night

  function applyTheme(theme) {
    const dark = theme === 'dark';
    if (dark) document.documentElement.dataset.theme = 'dark';
    else delete document.documentElement.dataset.theme;
    const scheme = document.querySelector('meta[name="color-scheme"]');
    if (scheme) scheme.content = dark ? 'dark' : 'light';
    const bar = document.querySelector('meta[name="theme-color"]');
    if (bar) bar.content = dark ? '#06243B' : '#092D4A';
    const btn = document.querySelector('[data-action="toggle-theme"]');
    if (btn) {
      btn.innerHTML = dark ? ICON.sun : ICON.moon;
      btn.setAttribute('aria-label', dark ? 'Switch to day mode' : 'Switch to night mode');
      btn.title = btn.getAttribute('aria-label');
    }
  }
  applyTheme(store.get(LS.theme));

  // ------------------------------------------------------------ toast

  let toastTimer;
  function toast(msg, isError = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (isError ? ' error' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 5000 : 2200);
  }

  // ------------------------------------------------------------ API

  // A full-screen "working on it" card for anything that changes the sheet.
  // Saves go through Google and take several seconds, so make that visible
  // (and block extra taps while it happens).
  const BUSY_TEXT = {
    saveSession: 'Saving session…', deleteSession: 'Deleting session…', setPaid: 'Updating…',
    savePlayer: 'Saving player…', saveMembership: 'Saving…', deleteMembership: 'Removing…',
    saveKitty: 'Saving…', deleteKitty: 'Removing…', saveSettings: 'Saving settings…',
  };
  let busyTimer = null;
  function showBusy(text) {
    clearTimeout(busyTimer);
    const el = $('#busy');
    $('#busyText').textContent = text;
    $('#busySub').textContent = '';
    el.hidden = false;
    // reassure on a slow connection
    busyTimer = setTimeout(() => { $('#busySub').textContent = 'Still going… Google can take a few seconds.'; }, 6000);
  }
  function hideBusy() {
    clearTimeout(busyTimer);
    $('#busy').hidden = true;
  }

  // quiet: save in the background (no saving screen), e.g. ticking someone paid.
  async function api(action, payload = {}, { quiet = false } = {}) {
    if (!state.apiUrl) throw new Error('No API URL set');
    if (!quiet) state.busy = true;
    state.inFlight = (state.inFlight || 0) + 1;
    $('[data-action="refresh"]').classList.add('spin');
    if (action !== 'load' && !quiet) showBusy(BUSY_TEXT[action] || 'Saving…');
    try {
      // text/plain keeps this a "simple" request (no CORS preflight) for Apps Script.
      const res = await fetch(state.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ code: state.code, action, payload }),
        redirect: 'follow',
      });
      const json = await res.json();
      if (!json.ok) {
        const err = new Error(json.error || 'Request failed');
        err.code = json.code;
        throw err;
      }
      setData(json.data);
      return json.data;
    } finally {
      if (!quiet) { state.busy = false; hideBusy(); }
      state.inFlight -= 1;
      if (!state.inFlight) $('[data-action="refresh"]').classList.remove('spin');
    }
  }

  // Paid ticks still on their way to the sheet. They're shown straight away and
  // laid over any data that comes back until the sheet has them.
  state.pendingPaid = [];
  function applyPaid(raw, p) {
    const payments = (raw.payments || []).filter((x) => !(String(x.month).slice(0, 7) === p.month && x.person === p.person));
    if (p.paid) payments.push({ month: p.month, person: p.person, amount: p.amount, paid_on: p.paid_on, note: '' });
    return { ...raw, payments };
  }

  function setData(raw) {
    state.serverRaw = raw;   // what the sheet last said
    store.set(LS.cache, JSON.stringify(raw));
    for (const p of state.pendingPaid) raw = applyPaid(raw, p);
    state.raw = raw;
    state.data = PB.normalize(raw);
    state.tournaments = parseTournaments(raw);
    $('#clubName').textContent = state.data.settings.club_name || 'Junk Pickleball';
  }

  async function refresh(quiet = false) {
    try {
      await api('load');
      if (!quiet) toast('Up to date');
      render();
    } catch (e) {
      handleError(e);
    }
  }

  function handleError(e) {
    if (e.code === 'auth') {
      store.del(LS.code);
      state.code = '';
      toast('Wrong access code', true);
      render();
      return;
    }
    toast(e.message || String(e), true);
  }

  async function save(action, payload, okMsg) {
    try {
      await api(action, payload);
      if (okMsg) toast(okMsg);
      return true;
    } catch (e) {
      handleError(e);
      return false;
    }
  }

  // ------------------------------------------------------------ sharing

  function sendText(text, phone) {
    const digits = String(phone || '').replace(/[^\d]/g, '');
    if (digits) {
      window.open(`https://wa.me/${digits}?text=${encodeURIComponent(text)}`, '_blank');
      return;
    }
    if (navigator.share) {
      navigator.share({ text }).catch(() => {});
      return;
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch (e) {
      window.prompt('Copy this:', text);
    }
  }

  // ------------------------------------------------------------ render root

  // The big logo shows on the home (Sessions) screen only. While any of it is
  // still on screen the top bar is see-through; after that the bar turns solid.
  function syncHero() {
    const shown = document.body.classList.contains('show-hero');
    const over = shown && $('#hero').getBoundingClientRect().bottom > $('#topbar').offsetHeight + 6;
    document.body.classList.toggle('over-hero', over);
  }
  window.addEventListener('scroll', syncHero, { passive: true });
  window.addEventListener('resize', syncHero);

  function render() {
    document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    const view = $('#view');
    const signedIn = state.apiUrl && state.code;
    document.body.classList.toggle('show-hero', !signedIn || state.tab === 'sessions');
    syncHero();
    if (!signedIn) {
      $('#tabbar').hidden = true;
      view.innerHTML = renderSetup();
      return;
    }
    $('#tabbar').hidden = false;
    if (!state.data) {
      view.innerHTML = '<div class="empty">Loading…</div>';
      return;
    }
    if (state.tab === 'bills') view.innerHTML = renderBills();
    else if (state.tab === 'club') view.innerHTML = renderClub();
    else view.innerHTML = renderSessions();
  }

  function renderSetup() {
    return `
      <div class="setup card">
        <h2>Connect to the sheet</h2>
        <p class="small muted">One-time setup on this device. Ask whoever runs the club for the invite link or the access code.</p>
        ${window.JPB_CONFIG && window.JPB_CONFIG.apiUrl ? '' : `
        <label class="field"><span>Sheet API URL (ends in /exec)</span>
          <input type="text" id="setupUrl" value="${esc(state.apiUrl)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off" />
        </label>`}
        <label class="field"><span>Access code</span>
          <input type="text" id="setupCode" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off" />
        </label>
        <button class="btn block" data-action="connect">Connect</button>
      </div>`;
  }

  // ------------------------------------------------------------ Sessions tab

  function renderSessions() {
    const d = state.data;
    const idx = PB.index(d);
    const sessions = [...d.sessions].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    const today = todayISO();
    // Today's session stays under "Coming up" until the day is over (phone's own date).
    const upcoming = sessions.filter((s) => s.date >= today).reverse();
    const past = sessions.filter((s) => s.date < today);
    const shown = state.showAllSessions ? past : past.slice(0, 15);

    const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const row = (s) => {
      const sum = PB.sessionSummary(d, s, idx);
      // A booking still to come: managers get a small Poll button in the card instead of "To fill".
      const poll = d.role !== 'member' && s.date > today && !sum.heads;
      const who = sum.bookings.map((b) => `${b.member}${b.hours !== 1 ? ' ×' + b.hours : ''}`).join(', ');
      const sub = sum.heads
        ? `${sum.heads} players · ${money(sum.cpp)} each · ${PB.courtLabel(sum)}`
        : `${PB.courtLabel(sum)}${who ? ' · ' + who : ''}`;
      const label = PB.dayLabel(s.date, true);
      return `
        <div class="session-wrap">
        <button class="session${poll ? ' has-poll' : ''}" data-action="edit-session" data-id="${esc(s.id)}">
          <div class="date-block"><span>${esc(label.slice(0, 3).toUpperCase())}</span><b>${Number(s.date.slice(8, 10))}</b><span>${MONTHS[Number(s.date.slice(5, 7)) - 1]}</span></div>
          <div class="grow">
            <div class="title">${esc(label)}</div>
            <div class="sub">${esc(sub)}</div>
            ${s.location ? `<div class="sub place">${ICON.pin}${esc(s.location)}</div>` : ''}
          </div>
          ${sum.heads || poll ? '' : `<span class="pill todo">${d.role === 'member' ? 'Booked' : 'To fill ›'}</span>`}
        </button>
        ${poll ? `<button class="poll-chip" data-action="copy-poll" data-id="${esc(s.id)}" aria-label="Copy the WhatsApp poll question for ${esc(label)}" title="Copy the WhatsApp poll question">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h10M5 12h14M5 18h7"/></svg>Poll</button>` : ''}
        </div>`;
    };

    const ro = d.role === 'member';
    const balances = PB.membershipBalances(d).filter((b) => b.active);
    const low = ro ? [] : balances.filter((b) => b.hasCredit && b.hoursLeft <= 8);

    let skipped = [];
    try { skipped = JSON.parse(store.get(LS.notRegular) || '[]'); } catch (e) { skipped = []; }
    const suggestions = ro ? [] : PB.regularSuggestions(d).filter((g) => !skipped.includes(g.name)).slice(0, 3);
    // Folded unless it was opened last time (remembered per phone).
    const suggestionsOpen = store.get('jpb.open.regulars') === '1';
    const suggestionCards = suggestions.length ? `
      <details class="glance suggest-fold" data-glance="regulars" ${suggestionsOpen ? 'open' : ''}>
        <summary><span class="chev" aria-hidden="true"></span><span class="grow">Promote to Regular <span class="count">· ${suggestions.length}</span></span></summary>
      <div class="list">${suggestions.map((g, i) => `
        <div class="row">
          <span class="avatar${i % 2 ? ' alt' : ''}" aria-hidden="true">${esc(g.name.slice(0, 1).toUpperCase())}</span>
          <div class="grow"><div class="title">${esc(g.name)}</div>
            <div class="sub">${g.count} visits${g.pays !== g.name ? ` · with ${esc(g.pays)}` : ''}</div></div>
          <button class="btn secondary compact" data-action="promote-guest" data-name="${esc(g.name)}" aria-label="Promote ${esc(g.name)} to a regular">Promote</button>
          <button class="icon-btn muted" data-action="skip-regular" data-name="${esc(g.name)}" aria-label="Not now" title="Not now">✕</button>
        </div>`).join('')}</div>
      </details>` : '';

    return `
      ${low.length ? `<button class="alert" data-tab="club">${ICON.bell}<span class="grow">Credit running low: ${low.map((b) => `<b>${esc(b.name)} ≈${b.hoursLeft}h</b>`).join(', ')}</span>${ICON.chevron}</button>` : ''}
      ${tournamentCard()}
      ${upcoming.length ? `<h2>Coming up</h2><div class="sessions">${upcoming.map(row).join('')}</div>` : ''}
      ${suggestionCards}
      <h2>Past sessions</h2>
      ${past.length ? `<div class="sessions">${shown.map(row).join('')}</div>` : '<div class="empty">No sessions played yet.</div>'}
      ${past.length > shown.length ? '<button class="btn ghost block" data-action="show-all">Show all past sessions</button>' : ''}
      ${ro ? '' : `<button class="fab" data-action="new-session">${ICON.plus}Session</button>`}`;
  }

  // ------------------------------------------------------------ Session editor

  // Read-only look at one session, for the member view.
  // One session in full: where, courts, cost, who played and what each paid.
  // `back` reopens the page you came from (e.g. a player's page).
  function viewSession(id, back = null) {
    const d = state.data;
    const s = d.sessions.find((x) => x.id === id);
    if (!s) return;
    const admin = d.role !== 'member';
    const sum = PB.sessionSummary(d, s);
    const players = sum.attendance.filter((a) => !a.guest);
    const guests = sum.attendance.filter((a) => a.guest);
    state.sheetBack = back;
    const booked = admin ? sum.bookings.filter((b) => b.member !== PB.COURTS) : [];
    const el = $('#sheet');
    el.innerHTML = `
      <div class="sheet-head">
        <button class="btn ghost" data-action="${back ? 'sheet-back' : 'close-sheet'}">‹ Back</button>
        <h3>${esc(PB.dayLabel(s.date, true))}</h3>
        ${admin ? `<button class="btn ghost" data-action="edit-session" data-id="${esc(s.id)}">Edit</button>` : ''}
      </div>
      <div class="sheet-body">
        ${s.location ? `<p class="place big">${ICON.pin}${esc(s.location)}</p>` : ''}
        <div class="stats">
          <div class="stat"><div class="label">Courts</div><div class="value">${esc(PB.courtLabel(sum))}</div></div>
          <div class="stat"><div class="label">Court cost</div><div class="value">${money(sum.cost)}</div></div>
          <div class="stat"><div class="label">Players</div><div class="value">${sum.heads || '—'}</div></div>
          <div class="stat"><div class="label">Each</div><div class="value">${sum.heads ? money(sum.cpp) : '—'}</div></div>
        </div>
        ${sum.heads ? `<p class="small muted center" style="margin:-2px 0 4px">${money(sum.cost)} court cost ÷ ${sum.heads} player${sum.heads === 1 ? '' : 's'} = ${money(sum.cpp)} each</p>` : ''}
        ${booked.length ? `<h2>Courts booked on</h2>
        <div class="list">${booked.map((b) => `<div class="row"><div class="grow"><div class="title">${esc(b.member)}'s membership</div>
          <div class="sub">${b.hours} court-hour${b.hours === 1 ? '' : 's'} × ${money(b.rate)}</div></div><span class="amount">${money(b.hours * b.rate)}</span></div>`).join('')}</div>` : ''}
        ${sum.heads ? `<h2>Who played <span class="pill">${players.length}</span></h2>
        <div class="chips">${players.map((a) => `<button class="chip on" data-action="open-player" data-name="${esc(a.name)}">${esc(a.name)}</button>`).join('')}</div>` : '<div class="empty">Booked — players not entered yet.</div>'}
        ${guests.length ? `<h2>Guests <span class="pill">${guests.length}</span></h2>
        <div class="list">${guests.map((g) => `<div class="row"><div class="grow"><div class="title">${esc(g.name)}</div></div>
          <span class="muted small">${g.pays === 'Reclub' ? 'Reclub' : g.pays === g.name ? 'pays own way' : `with ${esc(g.pays)}`}</span></div>`).join('')}</div>` : ''}
      </div>`;
    el.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function openSession(id) {
    const d = state.data;
    if (d.role === 'member') { if (id) viewSession(id); return; }
    const members = d.players.filter((p) => p.role === 'member' && p.active).map((p) => p.name);
    let draft;
    if (id) {
      const s = d.sessions.find((x) => x.id === id);
      if (!s) return;
      const bookings = {};
      for (const b of d.bookings.filter((x) => x.session_id === id)) bookings[b.member] = { hours: b.hours, rate: b.rate };
      const att = d.attendance.filter((a) => a.session_id === id);
      const isGuestRow = (a) => a.guest && !(a.pays === a.name && PB.playerNamed(d, a.name));
      draft = {
        id, isNew: false, date: s.date, notes: s.notes, reclub_fee: s.reclub_fee,
        location: s.location || '', play_hours: s.play_hours || 2, start_hour: s.start_hour || 20,
        baseUpdatedAt: s.updated_at || '',
        bookings,
        // A past guest who has since become a regular (and paid their own way)
        // is shown as the player they now are.
        players: att.filter((a) => !isGuestRow(a)).map((a) => a.name),
        guests: att.filter(isGuestRow).map((a) => ({ name: a.name, pays: a.pays })),
        keptGuests: new Set(att.filter(isGuestRow).map((a) => PB.nameKey(a.name))),
        search: '',
      };
      // keep members who booked but are now inactive visible
      for (const m of Object.keys(bookings)) if (!members.includes(m)) members.push(m);
    } else {
      const date = todayISO();
      draft = {
        // The id is fixed now, so tapping Save twice (or retrying after a
        // dropped connection) updates the same session instead of adding a copy.
        id: PB.newSessionId(date), isNew: true, date, notes: '', reclub_fee: d.settings.reclub_fee,
        // start from where we played last time; otherwise the first place on the list
        location: ([...d.sessions].sort((a, b) => b.date.localeCompare(a.date)).find((x) => x.location) || {}).location || PB.locations(d)[0] || '',
        play_hours: 2, start_hour: 20,
        bookings: {}, players: [], guests: [], keptGuests: new Set(), search: '',
      };
    }
    for (const m of members) {
      if (!draft.bookings[m]) draft.bookings[m] = { hours: 0, rate: PB.nextRate(d, m) };
    }
    draft.members = members;
    state.draft = draft;
    renderSheet();
  }

  function draftSummary() {
    const dr = state.draft;
    const hours = Object.values(dr.bookings).reduce((s, b) => s + (Number(b.hours) || 0), 0);
    const cost = PB.round2(Object.values(dr.bookings).reduce((s, b) => s + (Number(b.hours) || 0) * (Number(b.rate) || 0), 0));
    const heads = dr.players.length + dr.guests.length;
    const cpp = heads ? PB.round2(cost / heads) : 0;
    const label = PB.courtLabel({ hours, session: { play_hours: Number(dr.play_hours) || 2 } });
    return { hours, cost, heads, cpp, label };
  }

  function renderSheet() {
    const el = $('#sheet');
    const dr = state.draft;
    if (!dr) { el.hidden = true; el.innerHTML = ''; document.body.style.overflow = ''; return; }
    const d = state.data;

    const since = PB.shiftMonth(dr.date.slice(0, 7), -4) + '-01';
    const freq = PB.frequency(d, since);
    const active = d.players.filter((p) => p.active || dr.players.includes(p.name));
    const q = dr.search.trim().toLowerCase();
    const byActivity = (a, b) => (freq.get(b.name) || 0) - (freq.get(a.name) || 0) || a.name.localeCompare(b.name);
    const list = active.filter((p) => !q || p.name.toLowerCase().includes(q)).sort(byActivity);
    // Searching also finds inactive players; tapping one brings them back and adds them.
    const resting = q ? d.players.filter((p) => !p.active && !dr.players.includes(p.name) && p.name.toLowerCase().includes(q)).sort((x, y) => x.name.localeCompare(y.name)) : [];
    const restChip = (p) => `<button class="chip resting" data-action="reactivate-player" data-name="${esc(p.name)}">${esc(p.name)} <span class="tag">inactive · tap to add</span></button>`;
    // "Usual crowd" = played at least 3 times in the last 4 months.
    const usual = list.filter((p) => (freq.get(p.name) || 0) >= 3);
    const others = list.filter((p) => (freq.get(p.name) || 0) < 3).sort((a, b) => a.name.localeCompare(b.name));
    const chip = (p) => `<button class="chip${dr.players.includes(p.name) ? ' on' : ''}" data-action="toggle-player" data-name="${esc(p.name)}">${esc(p.name)}${p.role === 'member' ? '<span class="tag">★</span>' : ''}</button>`;
    const addChip = q && !PB.playerNamed(d, dr.search) ? `<button class="chip" data-action="quick-add-player" data-name="${esc(dr.search.trim())}">＋ Add "${esc(dr.search.trim())}"</button>` : '';
    const grouped = !q && usual.length >= 4 && others.length > 0;

    const payOptions = (current) => {
      const names = [...dr.players].sort();
      const opts = ['<option value="">Who pays?</option>']
        .concat(names.map((n) => `<option value="${esc(n)}"${current === n ? ' selected' : ''}>${esc(n)}</option>`))
        .concat([`<option value="Reclub"${current === 'Reclub' ? ' selected' : ''}>Reclub</option>`,
          `<option value="__self"${current === '__self' ? ' selected' : ''}>Themselves</option>`]);
      // keep unusual saved values (e.g. imported "Unassigned" or a guest paying for themselves)
      if (current && current !== '__self' && !names.includes(current) && current !== 'Reclub') {
        opts.push(`<option value="${esc(current)}" selected>${esc(current)}</option>`);
      }
      return opts.join('');
    };

    const sum = draftSummary();
    const scroll = el.scrollTop;

    // The WhatsApp poll question, from what's in the editor right now.
    const pollNow = () => {
      const s = { id: dr.id, date: dr.date, location: dr.location, play_hours: Number(dr.play_hours) || 2, start_hour: Number(dr.start_hour) || 20 };
      const bookings = Object.entries(dr.bookings).filter(([, b]) => b.hours > 0).map(([member, b]) => ({ session_id: dr.id, member, hours: b.hours, rate: b.rate }));
      return PB.pollText({ ...d, sessions: [s], bookings, attendance: [] }, s);
    };
    state.pollNow = pollNow;
    // Before the day, the booking is what changes; from the day itself, it's who came.
    // Uses the saved date, so the layout doesn't jump around while the date is being edited.
    const savedDate = ((d.sessions.find((x) => x.id === dr.id)) || {}).date || '';
    const gameDay = !dr.isNew && savedDate && savedDate <= todayISO();
    const bookingBlock = `
        <label class="field"><span>Date</span>
          <input type="date" id="dDate" value="${esc(dr.date)}" />
        </label>
        <label class="field"><span>Where</span>
          <select id="dLocation">
            ${[...new Set([...PB.locations(d), dr.location].filter(Boolean))].map((l) => `<option${l === dr.location ? ' selected' : ''}>${esc(l)}</option>`).join('')}
            <option value=""${dr.location ? '' : ' selected'}>Not set</option>
          </select>
        </label>
        <label class="field"><span>Starts</span>
          <select id="dStart">${[17, 17.5, 18, 18.5, 19, 19.5, 20, 20.5, 21].map((h) => `<option value="${h}"${Number(dr.start_hour) === h ? ' selected' : ''}>${esc(PB.timeRange(h, 0).split('-')[1])}</option>`).join('')}</select>
        </label>
        <label class="field"><span>How long we play</span>
          <select id="dLength">${[1, 1.5, 2, 2.5, 3].map((h) => `<option value="${h}"${Number(dr.play_hours) === h ? ' selected' : ''}>${h} hour${h === 1 ? '' : 's'}</option>`).join('')}</select>
        </label>

        <h2>Courts booked</h2>
        <p class="small muted" style="margin:-4px 2px 8px">Hours taken from each membership. Two courts for 2 hours is 4 hours in total.</p>
        <div class="list">
          ${dr.members.map((m) => {
            const b = dr.bookings[m];
            return `
            <div class="row">
              <div class="grow"><div class="title">${esc(m)}</div>
                <div class="sub">rate <input class="rate-input" type="number" inputmode="decimal" step="0.01" data-rate="${esc(m)}" value="${esc(b.rate)}" /> /h</div>
              </div>
              <div class="stepper">
                <button data-action="hours" data-member="${esc(m)}" data-delta="-1" aria-label="Less">−</button>
                <span class="val">${b.hours}</span>
                <button data-action="hours" data-member="${esc(m)}" data-delta="1" aria-label="More">＋</button>
              </div>
            </div>`;
          }).join('') || '<div class="row muted">No members set up — add them in Club.</div>'}
        </div>`;
    const whoBlock = `
        <h2>Who played <span class="pill">${dr.players.length}</span></h2>
        <input type="search" id="dSearch" placeholder="Search players" value="${esc(dr.search)}" style="margin-bottom:10px" />
        ${grouped ? `
        <div class="chip-label">Usual crowd — most active first</div>
        <div class="chips">${usual.map(chip).join('')}</div>
        <div class="chip-label">Everyone else — A to Z</div>
        <div class="chips">${others.map(chip).join('')}</div>` : `
        <div class="chips">${list.map(chip).join('')}${resting.map(restChip).join('')}${addChip}</div>`}

        <h2>Guests <span class="pill">${dr.guests.length}</span></h2>
        ${dr.guests.map((g, i) => `
          <div class="guest-row">
            <input type="text" placeholder="Guest name" list="knownGuests" autocomplete="off" data-guest-name="${i}" value="${esc(g.name)}" />
            <select data-guest-pays="${i}">${payOptions(g.pays === g.name && g.name ? '__self' : g.pays)}</select>
            <button data-action="remove-guest" data-index="${i}" aria-label="Remove guest">✕</button>
          </div>`).join('')}
        <datalist id="knownGuests">${PB.knownGuests(d).map((g) => `<option value="${esc(g.name)}">${g.pays === g.name ? 'pays own way' : 'with ' + esc(g.pays)}</option>`).join('')}</datalist>
        <div class="btn-row">
          <button class="btn secondary" data-action="add-guest">＋ Guest</button>
          <button class="btn secondary" data-action="add-reclub">＋ Reclub player</button>
        </div>`;

    el.innerHTML = `
      <div class="sheet-head">
        <button class="btn ghost" data-action="close-sheet">Cancel</button>
        <h3>${dr.isNew ? 'New session' : 'Edit session'}</h3>
        ${dr.isNew ? '' : '<button class="btn danger" data-action="delete-session">Delete</button>'}
      </div>
      <div class="sheet-body">
        ${!gameDay && dr.date >= todayISO() ? `
        <div class="poll-card">
          <div class="grow"><div class="small muted">WhatsApp poll question</div><div class="poll-text">${esc(pollNow())}</div></div>
          <button class="btn secondary compact" data-action="copy-poll">Copy</button>
        </div>` : ''}
        ${gameDay ? `${whoBlock}
        <details class="glance booking-fold" data-fold="booking" ${dr.bookingOpen ? 'open' : ''}>
          <summary><span class="chev" aria-hidden="true"></span><span class="grow">Booking
            <span class="count">· ${esc(PB.dayLabel(dr.date).slice(4))}${dr.location ? ` · ${esc(dr.location)}` : ''} · ${esc(sum.label)}</span></span>
            <span class="small muted">${dr.bookingOpen ? '' : 'Edit'}</span></summary>
          <div class="fold-body">${bookingBlock}</div>
        </details>` : `${bookingBlock}${whoBlock}`}

        <label class="field" style="margin-top:16px"><span>Notes (optional)</span>
          <input type="text" id="dNotes" value="${esc(dr.notes)}" />
        </label>
        ${dr.isNew ? '' : `<button class="btn ghost" data-action="share-session">Share session message</button>`}
        ${dr.isNew || dr.date > todayISO() ? '' : ((state.tournaments || []).some((x) => x.session_id === dr.id)
    ? `<button class="btn secondary block" data-action="session-tournament" style="margin-top:8px">🏆 Open this session's Junk Cup</button>`
    : `<button class="btn secondary block" data-action="session-tournament" style="margin-top:8px">🏆 Start a Junk Cup with these players</button>`)}
      </div>
      <div class="sheet-foot"><div class="inner">
        <div class="summary"><b>${sum.heads} players · ${money(sum.cpp)} each</b><br>
          <span class="muted">${sum.label} · ${money(sum.cost)}</span></div>
        <button class="btn" data-action="save-session">Save</button>
      </div></div>`;
    el.hidden = false;
    el.scrollTop = scroll;
    document.body.style.overflow = 'hidden';
  }

  function updateSheetFooter() {
    const sum = draftSummary();
    const s = $('#sheet .summary');
    if (s) s.innerHTML = `<b>${sum.heads} players · ${money(sum.cpp)} each</b><br><span class="muted">${sum.label} · ${money(sum.cost)}</span>`;
  }

  async function saveDraft() {
    const dr = state.draft;
    const d = state.data;
    if (state.busy) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dr.date)) return toast('Pick a date', true);
    const guestKeys = new Set();
    for (const g of dr.guests) {
      if (!g.name.trim()) return toast('Every guest needs a name', true);
      if (!g.pays) return toast(`Who pays for ${g.name}?`, true);
      if (g.pays === 'Reclub') continue;
      // Bills are kept by name, so a guest can't share one with a player or another guest.
      const key = PB.nameKey(g.name);
      const clash = dr.keptGuests.has(key) ? null : PB.playerNamed(d, g.name);
      if (clash) return toast(`${clash.name} is already a player. Tick them above, or add an initial for the guest (e.g. "${clash.name} G").`, true);
      if (guestKeys.has(key)) return toast(`Two guests called ${g.name.trim()}. Add an initial to tell them apart.`, true);
      guestKeys.add(key);
    }
    const hours = Object.values(dr.bookings).reduce((s, b) => s + (Number(b.hours) || 0), 0);
    const heads = dr.players.length + dr.guests.length;
    if (!hours && !heads) return toast('Add court hours or players first', true);

    const dupe = d.sessions.find((s) => s.date === dr.date && s.id !== dr.id);
    if (dupe && dr.isNew && !window.confirm(`There's already a session on ${PB.dayLabel(dr.date)}. Save a second one?`)) return;

    const id = dr.id;
    const payload = {
      ...(dr.isNew ? {} : { base_updated_at: dr.baseUpdatedAt }),
      session: { id, date: dr.date, reclub_fee: dr.reclub_fee, notes: dr.notes, location: dr.location, play_hours: Number(dr.play_hours) || 2, start_hour: Number(dr.start_hour) || 20 },
      bookings: Object.entries(dr.bookings)
        .filter(([, b]) => Number(b.hours) > 0)
        .map(([member, b]) => ({ member, hours: Number(b.hours), rate: Number(b.rate) })),
      attendance: dr.players.map((name) => ({ name, guest: false, pays: name }))
        .concat(dr.guests.map((g) => ({
          name: g.pays === 'Reclub' && !g.name.trim() ? 'Reclub guest' : g.name.trim(),
          guest: true,
          pays: g.pays === '__self' ? g.name.trim() : g.pays,
        }))),
    };
    const ok = await save('saveSession', payload, 'Session saved');
    if (ok) {
      state.draft = null;
      renderSheet();
      render();
    }
  }

  // ------------------------------------------------------------ Bills tab

  function renderBills() {
    const d = state.data;
    if (!state.month) {
      const months = d.sessions.map((s) => s.date.slice(0, 7)).sort();
      const current = todayISO().slice(0, 7);
      state.month = months.includes(current) ? current : (months[months.length - 1] || current);
    }
    const st = PB.monthStatement(d, state.month);
    // Members of the group get a read-only view: no buttons that change or send anything,
    // and (enforced by the sheet script, not just here) no paybacks or kitty.
    const ro = d.role === 'member';
    const [monthWord, year] = PB.monthLabel(state.month).split(' ');

    // ---- header: where the month stands
    const paidPlayers = st.players.filter((p) => p.paid);
    const collected = PB.round2(paidPlayers.reduce((sum, p) => sum + p.total, 0));
    const pct = st.totals.players ? Math.min(100, Math.round((collected / st.totals.players) * 100)) : 0;
    // People, not visits: everyone who played this month, with guests counted separately.
    const regularsThisMonth = new Set();
    let guestVisits = 0;
    for (const x of st.sessions) for (const a of x.attendance) { if (a.guest) guestVisits += 1; else regularsThisMonth.add(a.name); }
    // Fees are invoiced once the month is over, so the current month isn't due yet.
    const inProgress = state.month >= todayISO().slice(0, 7);
    const header = `
      <div class="tab-head">
        <div class="tab-title">Monthly Tab</div>
        <div class="month-nav">
          <button data-action="month" data-delta="-1" aria-label="Previous month">‹</button>
          <div class="month-name"><strong>${esc(monthWord)}</strong><span>${esc(year)}</span></div>
          <button data-action="month" data-delta="1" aria-label="Next month">›</button>
        </div>
        ${st.sessions.length ? `
        <div class="tab-sub">${st.sessions.length} session${st.sessions.length === 1 ? '' : 's'} · ${regularsThisMonth.size} player${regularsThisMonth.size === 1 ? '' : 's'}${guestVisits ? ` + ${guestVisits} guest visit${guestVisits === 1 ? '' : 's'}` : ''} · ${money(st.totals.courtCost)} court cost</div>
        ${inProgress && st.players.length ? `
        <div class="collect pending">
          <div class="collect-line"><span><b>Month in progress</b></span><span class="muted">${money(st.totals.players)} so far</span></div>
          <div class="small muted" style="margin-top:4px">Final court fees are sent at the end of ${esc(monthWord)}.</div>
        </div>` : ''}
        ${!inProgress && st.players.length ? `
        <div class="collect">
          <div class="collect-line"><span>${ro ? `${paidPlayers.length} of ${st.players.length} paid` : `<b>${money(collected)}</b> of ${money(st.totals.players)} collected`}</span>
            <span class="muted">${ro ? '' : `${paidPlayers.length}/${st.players.length} paid`}</span></div>
          <div class="bar"><i style="width:${ro ? (st.players.length ? Math.round((paidPlayers.length / st.players.length) * 100) : 0) : pct}%"></i></div>
        </div>` : ''}` : '<div class="tab-sub">No sessions this month.</div>'}
      </div>`;

    // ---- one row per person: name (opens their page), amount, and for admins the paid tick and a send button
    const tick = (entry, amount) => {
      if (ro) return entry.paid ? '<span class="tick-badge on" title="Paid">✓</span>' : '<span class="tick-badge" aria-hidden="true"></span>';
      const changed = entry.paid && Math.abs(entry.paid.amount - amount) > 0.01;
      const label = entry.paid ? (changed ? `Paid ${money(entry.paid.amount)}, but the bill has changed. Tap to unmark.` : 'Paid. Tap to unmark.') : 'Tap to mark paid';
      return `<button class="tick-badge${entry.paid ? (changed ? ' changed' : ' on') : ''}" data-action="toggle-paid" data-person="${esc(entry.name)}"
        data-amount="${amount}" data-paid="${entry.paid ? 1 : 0}" aria-label="${esc(entry.name)}: ${label}" title="${label}">${entry.paid ? (changed ? '!' : '✓') : ''}</button>`;
    };
    const send = (entry, kind) => (ro ? '' : `<button class="row-icon" data-action="${kind}" data-person="${esc(entry.name)}" aria-label="Send ${esc(entry.name)} their ${kind === 'send-member' ? 'payback' : 'bill'}" title="Send on WhatsApp">${ICON.send}</button>`);
    const row = (entry, note, amount, amountText, kind, neg = false) => `
      <div class="tab-row">
        <button class="tab-name" data-action="open-player" data-name="${esc(entry.name)}">
          <span class="name">${esc(entry.name)}</span>${note ? `<span class="note">${note}</span>` : ''}
        </button>
        <span class="amount ${neg ? 'neg' : ''}">${amountText}</span>
        ${kind ? send(entry, kind) : ''}
        ${tick(entry, amount)}
      </div>`;

    const isOpen = (key) => store.get(`jpb.open.${key}`) !== '0';
    const regulars = st.players.filter((p) => !p.isGuest);
    const visitors = st.players.filter((p) => p.isGuest);
    const playerRow = (p) => row(p,
      p.guests.length ? `incl. ${p.guests.map((g) => esc(g.name)).join(', ')}` : '', p.total, money(p.total), 'send-player');
    const playersTable = st.players.length ? `
      <details class="glance" data-glance="players" ${isOpen('players') ? 'open' : ''}>
        <summary><span class="chev" aria-hidden="true"></span><span class="grow">Players <span class="count">· ${inProgress ? 'so far' : `${paidPlayers.length}/${st.players.length} paid`}</span></span>
          <span class="amount">${money(st.totals.players)}</span></summary>
        ${regulars.map(playerRow).join('')}
        ${visitors.length ? `<div class="tab-group">Guests paying their own way</div>${visitors.map(playerRow).join('')}` : ''}
        <div class="glance-row total"><span class="name">${ro ? 'Players\' court fees' : inProgress ? 'Running total' : 'Total to collect'}</span><span class="amount">${money(st.totals.players)}</span></div>
      </details>` : '';

    const memberFees = PB.round2(st.members.reduce((sum, m) => sum + m.charges, 0));
    const shownMembers = ro ? st.members.filter((m) => m.charges > 0) : st.members;
    const membersTable = shownMembers.length ? `
      <details class="glance" data-glance="members" ${isOpen('members') ? 'open' : ''}>
        <summary><span class="chev" aria-hidden="true"></span><span class="grow">Members <span class="count">· ${ro ? 'court fees' : `payback from ${esc(d.settings.pay_to || 'Tommy')}`}</span></span>
          <span class="amount">${money(ro ? memberFees : st.totals.payback)}</span></summary>
        ${shownMembers.map((m) => (ro
          ? row(m, m.guests.length ? `incl. ${m.guests.map((g) => esc(g.name)).join(', ')}` : '', m.charges, money(m.charges), '')
          : row(m, `booked ${money(m.credits)} − fees ${money(m.charges)}`, m.payback,
            m.payback < 0 ? `owes ${money(-m.payback)}` : money(m.payback), 'send-member', m.payback < 0))).join('')}
        <div class="glance-row total"><span class="name">${ro ? 'Members\' court fees' : 'Total payback'}</span><span class="amount">${money(ro ? memberFees : st.totals.payback)}</span></div>
      </details>` : '';

    // ---- things to sort out before sending (admins)
    const warnings = st.warnings.length && !ro
      ? `<div class="warn-box"><b>Check before sending</b><ul>${st.warnings.map((w) => `<li>${esc(w.text)}</li>`).join('')}</ul></div>` : '';
    const owing = ro ? [] : PB.outstanding(d, state.month);
    const owingBox = owing.length ? `<div class="warn-box"><b>Still unpaid from earlier months</b><ul>${
      owing.map((o) => `<li>${esc(o.name)} — ${money(o.amount)} (${esc(PB.monthLabel(o.month))})</li>`).join('')}</ul></div>` : '';

    // ---- small print at the bottom
    const r = st.reclub;
    const footer = st.sessions.length ? `
      <div class="card tab-foot">
        ${r ? (ro
          ? `<div class="foot-line"><span>${r.heads} Reclub player${r.heads === 1 ? '' : 's'}</span><span class="amount">${money(r.courtShare)}</span></div>`
          : `<div class="foot-line"><span>Reclub: ${r.heads} player${r.heads === 1 ? '' : 's'} × ${money(d.settings.reclub_fee)}</span><span class="amount">${money(r.income)}</span></div>
             <div class="foot-line muted"><span>Their share of court cost</span><span class="amount">−${money(r.courtShare)}</span></div>
             <div class="foot-line"><b>Into the kitty</b><span class="amount">${money(r.profit)}</span></div>`) : ''}
        ${ro ? '' : `<div class="foot-check">${st.totals.balanced ? '✓ Every court dollar is accounted for' : '⚠ Totals don\'t match the court cost'}${Math.abs(st.totals.roundingDiff) >= 0.01 ? ` (rounding ${money(st.totals.roundingDiff)})` : ''}</div>`}
      </div>` : '';

    return `
      ${header}
      ${warnings}
      ${owingBox}
      ${playersTable}
      ${membersTable}
      ${st.sessions.length && !ro ? `<button class="btn secondary block" data-action="send-group">${inProgress ? 'Share the running total with the group' : 'Share summary with the group'}</button>` : ''}
      ${!ro && st.players.length ? '<p class="small muted center" style="margin:8px 0 0">Tap a name for their sessions and history. Tap the circle when they\'ve paid.</p>' : ''}
      ${footer}`;
  }

  // ------------------------------------------------------------ Club tab

  // A clear call to action for the stats page, with a live teaser so it's obviously stats.
  function bragCard(d) {
    const played = [...d.sessions].filter((x) => x.date < todayISO()).sort((x, y) => x.date.localeCompare(y.date));
    const ids = new Set(played.map((x) => x.id));
    const lastTen = new Set(played.filter((x) => d.attendance.some((a) => a.session_id === x.id)).slice(-10).map((x) => x.id));
    const all = new Map(); const recent = new Map();
    for (const a of d.attendance) {
      if (a.guest || !ids.has(a.session_id)) continue;
      all.set(a.name, (all.get(a.name) || 0) + 1);
      if (lastTen.has(a.session_id)) recent.set(a.name, (recent.get(a.name) || 0) + 1);
    }
    const top = (m) => [...m.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
    const most = top(all); const hot = top(recent);
    return `
        <a class="brag-card" href="../" data-action="open-stats" aria-label="Open the club stats page">
          <div class="brag-top">
            <span class="brag-trophy" aria-hidden="true">🏆</span>
            <span class="grow">
              <span class="brag-eyebrow">Club stats</span>
              <span class="brag-title">Bragging Rights</span>
              <span class="brag-sub">Leaderboard, streaks &amp; awards</span>
            </span>
          </div>
          <div class="brag-teasers">
            ${hot ? `<span>🔥 On fire: <b>${esc(hot[0])}</b> · ${hot[1]} of the last ${lastTen.size}</span>` : ''}
            ${most ? `<span>🏅 Most sessions ever: <b>${esc(most[0])}</b> · ${most[1]}</span>` : ''}
          </div>
          <span class="brag-button">View club stats ${ICON.chevron}</span>
        </a>`;
  }

  // Banner at the top of the Club tab, for everyone.
  function clubHead(d) {
    const people = d.players.filter((p) => p.active).length;
    const played = d.sessions.filter((s) => s.date < todayISO()).length;
    return `
      <div class="tab-head club-head">
        <div class="club-title"><span aria-hidden="true">🏓</span> The Clubhouse</div>
        <p class="club-intro">Your home for all things Junk Pickleball. Find your name to explore your playing history, attendance and monthly fees.</p>
        <div class="club-chips"><span>${people} players</span><span>${played} sessions played</span></div>
      </div>`;
  }

  function renderClub() {
    const d = state.data;
    if (d.role === 'member') {
      const names = [...d.players].filter((p) => p.active).sort((a, b) => a.name.localeCompare(b.name));
      return `
        ${clubHead(d)}
        ${bragCard(d)}
        <h2>Players <span class="pill">${names.length}</span></h2>
        <div class="list">${names.map((p) => `<button class="row" data-action="open-player" data-name="${esc(p.name)}"><div class="grow"><div class="title">${esc(p.name)} ${p.role === 'member' ? '<span class="pill">member</span>' : ''}</div></div>${ICON.chevron}</button>`).join('')}</div>
        <p class="small muted center">Loaded ${esc((state.raw && state.raw.loaded_at || '').replace('T', ' ').slice(0, 16))}<br>
          <button class="btn ghost small" data-action="sign-out">Sign out on this device</button></p>`;
    }
    const balances = PB.membershipBalances(d);
    const kitty = PB.kitty(d);
    const active = d.players.filter((p) => p.active).sort((a, b) => a.name.localeCompare(b.name));
    const inactive = d.players.filter((p) => !p.active).sort((a, b) => a.name.localeCompare(b.name));
    const low = balances.filter((b) => b.hasCredit && b.hoursLeft <= 8);
    const loaded = esc((state.raw && state.raw.loaded_at || '').replace('T', ' ').slice(0, 16));

    // A foldable section; each phone remembers which ones are open.
    const section = (key, title, summary, body, openByDefault) => {
      const saved = store.get(`jpb.open.${key}`);
      const open = saved === null ? openByDefault : saved !== '0';
      return `
      <details class="club-section" data-glance="${key}" ${open ? 'open' : ''}>
        <summary><span class="chev" aria-hidden="true"></span><span class="grow"><span class="club-section-title">${title}</span>
          ${summary ? `<span class="club-section-sum">${summary}</span>` : ''}</span></summary>
        <div class="club-section-body">${body}</div>
      </details>`;
    };

    const playerRow = (p) => `
      <button class="row${p.active ? '' : ' faded'}" data-action="open-player" data-name="${esc(p.name)}" data-search="${esc(p.name.toLowerCase())}">
        <div class="grow"><div class="title">${esc(p.name)} ${p.role === 'member' ? '<span class="pill">member</span>' : ''}</div>
          ${p.phone || !p.active ? `<div class="sub">${p.active ? '' : 'inactive'}${p.phone ? `${p.active ? '' : ' · '}${esc(p.phone)}` : ''}</div>` : ''}</div>
        ${ICON.chevron}
      </button>`;

    const shortDate = (iso) => PB.dayLabel(iso).slice(4);
    const creditHistory = (b) => {
      const lines = b.lots.map((l) => l.kind === 'balance'
        ? `<li><b>${esc(shortDate(l.date))} ${l.date.slice(0, 4)}</b> · BayPickle said ${money(l.amount)} left${b.check && b.check.id === l.id && b.adjustment ? ` <span class="muted">(${b.adjustment > 0 ? '+' : ''}${money(b.adjustment)} vs our records)</span>` : ''}</li>`
        : `<li>${esc(shortDate(l.date))} ${l.date.slice(0, 4)} · bought ${money(l.amount)} at ${money(l.rate)}/h${l.notes ? ` <span class="muted">· ${esc(l.notes)}</span>` : ''}</li>`);
      return `<details class="items"><summary>Credit history</summary><ul>${lines.join('')}</ul>
        <div class="btn-row"><button class="btn ghost compact" data-action="add-membership" data-member="${esc(b.name)}">＋ Top-up</button>
        <button class="btn ghost compact" data-action="add-court-balance" data-member="${esc(b.name)}">✓ Court balance</button></div></details>`;
    };
    const membership = section('club-hours', 'Membership Balance',
      low.length ? `<span class="low-note">Low: ${low.map((b) => `${esc(b.name)} ≈${b.hoursLeft}h`).join(', ')}</span>` : `${balances.length} members`, `
        <div class="list">
          ${balances.map((b) => {
            const isLow = b.hasCredit && b.hoursLeft <= 8;
            const notes = [
              b.pool ? `${Math.round(b.share * 100)}% left of ${money(b.pool)} since ${esc(shortDate(b.poolFrom))} ${b.poolFrom.slice(0, 4)}` : '',
              b.check ? `BayPickle balance ${esc(shortDate(b.check.date))}` : 'no BayPickle balance yet',
              b.check && b.usedSinceCheck ? `${money(b.usedSinceCheck)} booked since` : '',
              b.aheadValue ? `incl. ${money(b.aheadValue)} booked ahead` : '',
            ].filter(Boolean).join(' · ');
            return `<div class="row credit-row"><div class="grow">
                <div class="title">${esc(b.name)}${b.active ? '' : ' <span class="muted small">(inactive)</span>'}</div>
                <div class="sub">≈ ${b.hoursLeft}h at ${money(b.rate)}/h</div>
                <div class="bar ${isLow ? 'low' : ''}"><i style="width:${Math.round(b.share * 100)}%"></i></div>
                <div class="sub small">${notes}</div>
                ${creditHistory(b)}
              </div><div class="hours-left credit${isLow ? ' low' : ''}${b.balance <= 0 ? ' out' : ''}"><b>${money(b.balance)}</b><span>left</span></div></div>`;
          }).join('') || '<div class="row muted">No memberships yet.</div>'}
        </div>
        <div class="btn-row">
          <button class="btn ghost" data-action="add-membership">＋ Record a top-up</button>
          <button class="btn ghost" data-action="add-court-balance">✓ Enter court balance</button>
        </div>`, true);

    const kittyBox = section('club-kitty', 'Kitty Balance', `<b class="${kitty.balance < 0 ? 'neg' : ''}">${money(kitty.balance)}</b>`, `
        <div class="card">
          <div class="foot-line"><span>Reclub profit, all time</span><span class="amount">${money(kitty.reclubProfit)}</span></div>
          <div class="foot-line"><span>Spending</span><span class="amount">${money(kitty.entriesTotal)}</span></div>
          <div class="foot-line kitty-total"><b>Balance</b><span class="amount ${kitty.balance < 0 ? 'neg' : ''}">${money(kitty.balance)}</span></div>
          ${kitty.entries.length ? `<details class="items"><summary>${kitty.entries.length} spending entr${kitty.entries.length === 1 ? 'y' : 'ies'}</summary><ul>${kitty.entries.map((k) =>
            `<li>${esc(k.date)} ${esc(k.description)} ${money(k.amount)} <button class="btn ghost small" data-action="delete-kitty" data-id="${esc(k.id)}">remove</button></li>`).join('')}</ul></details>` : ''}
          <button class="btn ghost" data-action="add-kitty">＋ Add spending (balls etc.)</button>
        </div>`, true);

    const playersBox = section('club-players', 'Players', `${active.length} active${inactive.length ? ` · ${inactive.length} inactive` : ''}`, `
        <input type="search" id="pSearch" placeholder="Find a player" autocomplete="off" style="margin-bottom:8px" />
        <div class="list" id="playerList">
          ${active.map(playerRow).join('')}
          ${inactive.length ? `<div class="tab-group">Inactive</div>${inactive.map(playerRow).join('')}` : ''}
        </div>
        <button class="btn ghost" data-action="edit-player" data-name="">＋ Add player</button>`, false);

    const tours = [...(state.tournaments || [])].sort((a, b) => tournamentDate(b).localeCompare(tournamentDate(a)));
    const tournamentBox = section('club-tournaments', '<img class="jc-title" src="junk-cup.webp" alt="Junk Cup" width="1200" height="363" />', tours.length ? `${tours.length} tournament${tours.length === 1 ? '' : 's'}` : 'tournaments', `
        ${tours.length ? `<div class="list">${tours.map((t) => {
    const pr = PT.progress(t); const pod = PT.podium(t);
    return `<button class="row" data-action="open-tournament" data-id="${esc(t.id)}"><div class="grow"><div class="title">${esc(t.name)}</div>
            <div class="sub">${esc(PB.dayLabel(tournamentDate(t) || todayISO(), true))} · ${tFormatName(t)} · ${pod.length ? `won by ${esc(pod[0])}` : `${pr.done}/${pr.total} games`}</div></div>${ICON.chevron}</button>`;
  }).join('')}</div>` : '<p class="small muted" style="margin:0 2px 10px">Turn a session into a Junk Cup: fixed teams of two, or a new partner every game.</p>'}
        <button class="btn secondary block" data-action="new-tournament" style="margin-top:10px">＋ New tournament</button>`, false);

    const shareBox = section('club-share', 'Share &amp; Access', 'invite links', `
        <div class="card">
          <p class="small" style="margin-top:0">A link signs a phone in with one tap.</p>
          <div class="share-line"><div><b>Admin link</b><div class="small muted">Full access. Only for the people who run the club.</div></div>
            <button class="btn secondary compact" data-action="share-invite">Send</button></div>
          ${d.settings.member_code ? `<div class="share-line"><div><b>Member link</b><div class="small muted">Look only: sessions, who played and court fees. No paybacks, hours or kitty.</div></div>
            <button class="btn secondary compact" data-action="share-member-invite">Send</button></div>` : ''}
          <p class="small muted" style="margin-bottom:0">The codes live in the sheet's <b>Settings</b> tab (<i>access_code</i> and <i>member_code</i>). Change one there to cut off old links, then send a new one.</p>
        </div>`, false);

    const settingsBox = section('club-settings', 'Settings', 'club details and pricing', `
        <div class="card">
          <div class="settings-group">Club</div>
          <label class="field"><span>Club name</span><input type="text" id="sClub" value="${esc(d.settings.club_name)}" /></label>
          <label class="field"><span>Who collects money</span><input type="text" id="sPayTo" value="${esc(d.settings.pay_to)}" /></label>
          <label class="field"><span>Currency symbol</span><input type="text" id="sCur" value="${esc(d.settings.currency)}" /></label>
          <label class="field"><span>Places we play (one per line, most used first)</span>
            <textarea id="sPlaces" rows="4">${esc(PB.locations(d).join('\n'))}</textarea></label>
          <label class="field"><span>Public stats page (first names and dates played only — no money)</span><select id="sStats">
            <option value="TRUE"${String(d.settings.public_stats).toUpperCase() === 'TRUE' ? ' selected' : ''}>On — anyone with the link can see it</option>
            <option value="FALSE"${String(d.settings.public_stats).toUpperCase() === 'TRUE' ? '' : ' selected'}>Off</option></select></label>
          <div class="settings-group">Pricing</div>
          <label class="field"><span>Default court rate per hour (used when a member has no membership on file)</span><input type="number" inputmode="decimal" id="sRate" value="${esc(d.settings.default_rate)}" /></label>
          <label class="field"><span>Reclub fee per player (new sessions)</span><input type="number" inputmode="decimal" id="sReclub" value="${esc(d.settings.reclub_fee)}" /></label>
          <button class="btn block" data-action="save-settings">Save settings</button>
        </div>`, false);

    return `
      ${clubHead(d)}
      ${bragCard(d)}
      ${playersBox}
      ${tournamentBox}
      ${membership}
      ${kittyBox}
      ${shareBox}
      ${settingsBox}
      <p class="small muted center">Data from the Google Sheet · loaded ${loaded}<br>
        <button class="btn ghost small" data-action="sign-out">Sign out on this device</button></p>`;
  }

  function openForm(title, fieldsHtml, onSubmit, extraButtons = '') {
    const el = $('#sheet');
    el.innerHTML = `
      <div class="sheet-head"><button class="btn ghost" data-action="close-sheet">Cancel</button><h3>${esc(title)}</h3>${extraButtons}</div>
      <div class="sheet-body"><form id="form">${fieldsHtml}<button class="btn block" type="submit">Save</button></form></div>`;
    el.hidden = false;
    document.body.style.overflow = 'hidden';
    $('#form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = Object.fromEntries(new FormData(ev.target).entries());
      const ok = await onSubmit(fd);
      if (ok) closeSheet();
    });
  }

  // The club stats page, shown inside the app. It's the same page as the public
  // link, loaded into a frame, so there's only ever one version of it.
  function openStats() {
    const el = $('#sheet');
    el.classList.add('stats-sheet');
    el.innerHTML = `
      <div class="sheet-head">
        <button class="btn ghost" data-action="close-sheet">‹ Back</button>
        <h3>Club stats</h3>
      </div>
      <div class="stats-wait" aria-hidden="true"><img class="busy-ball" src="ball.svg" alt="" width="64" height="64" /><span class="busy-shadow"></span></div>
      <iframe class="stats-frame" src="../" title="Club stats"></iframe>`;
    const frame = el.querySelector('.stats-frame');
    frame.addEventListener('load', () => { frame.classList.add('ready'); const w = el.querySelector('.stats-wait'); if (w) w.remove(); });
    el.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  // ------------------------------------------------------------ mini tournaments
  // Schedules and standings come from tournament.js (PT). Managers set one up
  // and enter scores; everyone can watch the games and the table.

  state.pendingScores = [];   // scores shown at once while they save in the background
  function parseTournaments(raw) {
    const list = ((raw && raw.tournaments) || []).map((r) => {
      let data = {};
      try { data = JSON.parse(r.data || '{}'); } catch (e) { data = {}; }
      return { players: [], teams: [], matches: [], ...data, id: String(r.id), session_id: String(r.session_id || ''), name: r.name || 'Junk Cup', updated_at: r.updated_at || '' };
    });
    for (const p of state.pendingScores) {
      const t = list.find((x) => x.id === p.id);
      const m = t && t.matches.find((x) => x.id === p.match_id);
      if (m) { m.sa = p.sa; m.sb = p.sb; }
    }
    return list;
  }
  const tournamentDate = (t) => ((state.data.sessions.find((s) => s.id === t.session_id) || {}).date) || '';
  const tFormatName = (t) => (t.format === 'americano' ? 'Rotating partners' : 'Fixed teams');
  // The tournament's name as a wordmark: last word in orange, like the club logo.
  const tWord = (name) => {
    const words = String(name).trim().split(/\s+/);
    const last = words.pop();
    return `${words.length ? `${esc(words.join(' '))} ` : ''}<em>${esc(last)}</em>`;
  };
  const tSide = (names) => names.map(esc).join(' <span class="amp">&amp;</span> ');

  /** Sessions tab: the tournament that's on now or coming up (or just finished). */
  function tournamentCard() {
    const today = todayISO();
    const weekAgo = PB.shiftDays ? PB.shiftDays(today, -7) : new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const list = (state.tournaments || []).map((t) => ({ t, date: tournamentDate(t) })).filter((x) => x.date >= weekAgo);
    if (!list.length) return '';
    const ahead = list.filter((x) => x.date >= today).sort((a, b) => a.date.localeCompare(b.date));
    const pick = ahead[0] || list.sort((a, b) => b.date.localeCompare(a.date))[0];
    const p = PT.progress(pick.t);
    const podium = PT.podium(pick.t);
    const line = podium.length ? `Winner: ${podium[0]}` : p.done ? `${p.done} of ${p.total} games played` : `${p.total} games · ${tFormatName(pick.t).toLowerCase()}`;
    const live = pick.date === today && p.done > 0 && !podium.length;
    const when = pick.date === today ? 'Today' : PB.dayLabel(pick.date);
    const custom = pick.t.name.trim().toLowerCase() !== 'junk cup';   // the logo already says Junk Cup
    return `
      <button class="t-card" data-action="open-tournament" data-id="${esc(pick.t.id)}">
        <img class="t-card-logo" src="junk-cup.webp" alt="Junk Cup" width="1200" height="363" />
        <span class="grow">
          <span class="t-card-eyebrow">${esc(when)}${live ? ' <span class="t-live">Live</span>' : ''}</span>
          ${custom ? `<span class="t-card-name">${esc(pick.t.name)}</span>` : ''}
          <span class="t-card-sub">${esc(line)}</span></span>
        ${ICON.chevron}
      </button>`;
  }

  // ---- the tournament itself: next up, table, every game
  function tTop(t) {
    const p = PT.progress(t);
    const podium = PT.podium(t);
    const next = PT.nextUp(t);
    const table = PT.standings(t);
    const teams = t.format === 'teams';
    const date = tournamentDate(t);
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    return `
      <div class="t-hero">
        <img class="t-hero-logo" src="junk-cup.webp" alt="Junk Cup" width="1200" height="363" />
        ${t.name.trim().toLowerCase() !== 'junk cup' ? `<div class="t-word">${tWord(t.name)}</div>` : ''}
        <div class="t-hero-chips">${date ? `<span>${esc(PB.dayLabel(date))}</span>` : ''}<span>${tFormatName(t)}</span><span>to ${esc(t.points_to || 11)}</span></div>
      </div>
      <div class="t-progress"><div class="bar"><i style="width:${pct}%"></i></div><span class="t-meta">${p.done} of ${p.total} games played</span></div>
      ${podium.length ? `
        <div class="t-podium">
          <div class="t-podium-label">${teams ? 'Champions' : 'Champion'}</div>
          <div class="t-podium-name">🏆 ${esc(podium[0])}</div>
          ${podium[1] ? `<div class="t-podium-rest"><span>🥈 ${esc(podium[1])}</span>${podium[2] ? `<span>🥉 ${esc(podium[2])}</span>` : ''}</div>` : ''}
        </div>` : ''}
      ${next ? `
        <div class="t-next"><div class="t-next-label">Next up · ${next.games[0].stage === 'group' ? `Round ${next.slot}` : 'Finals'}</div>
          ${next.games.map((m) => `<div class="t-next-game"><span class="t-court c-${esc(m.court)}">${esc(m.court)}</span><span class="grow">${tSide(m.a)} <span class="vs">v</span> ${tSide(m.b)}</span></div>`).join('')}
          ${next.resting.length ? `<div class="t-rest">Sitting out: ${next.resting.map(esc).join(', ')}</div>` : ''}</div>` : ''}
      <h2>Standings</h2>
      <div class="card t-table-card"><table class="t-table">
        <thead><tr><th></th><th>${teams ? 'Team' : 'Player'}</th>${teams ? '<th>W</th><th>L</th><th>+/−</th>' : '<th>Pts</th><th>W</th><th>+/−</th>'}</tr></thead>
        <tbody>${table.map((x) => `<tr${x.rank === 1 && x.played ? ' class="lead"' : ''}><td class="rk">${x.played && x.rank <= 3 ? `<span class="t-medal m${x.rank}">${x.rank}</span>` : x.rank}</td><td class="nm">${esc(x.name)}</td>${teams
    ? `<td><b>${x.won}</b></td><td>${x.lost}</td><td>${x.diff > 0 ? '+' : ''}${x.diff}</td>`
    : `<td><b>${x.pf}</b></td><td>${x.won}</td><td>${x.diff > 0 ? '+' : ''}${x.diff}</td>`}</tr>`).join('')}</tbody>
      </table></div>
      <p class="small muted" style="margin:6px 2px 0">${teams ? 'Ranked by wins, then point difference.' : 'Ranked by your own points, then wins.'}</p>`;
  }

  function tActions(t) {
    if (state.data.role === 'member') return '';
    return `
      ${PT.finals(t).length ? '<button class="btn block" data-action="t-finals">Round robin done: create the final</button>' : ''}
      <div class="btn-row" style="margin-top:14px">
        <button class="btn ghost" data-action="t-replace">Replace a player</button>
        <button class="btn ghost danger-text" data-action="t-delete">Delete tournament</button>
      </div>`;
  }

  function renderTournament(partial = false) {
    const el = $('#sheet');
    const t = (state.tournaments || []).find((x) => x.id === state.tview);
    if (!t) { state.tview = null; closeSheet(); return; }
    const admin = state.data.role !== 'member';
    if (partial && $('#tTop')) {
      // typing a score: refresh the table around the inputs, leave the inputs alone
      $('#tTop').innerHTML = tTop(t);
      $('#tActions').innerHTML = tActions(t);
      for (const m of t.matches) {
        const row = el.querySelector(`.t-match[data-mid="${m.id}"]`);
        if (row) { row.classList.toggle('a-won', PT.isScored(m) && m.sa > m.sb); row.classList.toggle('b-won', PT.isScored(m) && m.sb > m.sa); }
      }
      return;
    }
    const scroll = el.scrollTop;
    const slots = [...new Set(t.matches.map((m) => m.slot))].sort((a, b) => a - b);
    const stageName = { final: 'Final', third: '3rd place' };
    const score = (m, side) => (admin
      ? `<input class="t-score" type="number" inputmode="numeric" min="0" max="99" data-mid="${esc(m.id)}" data-side="${side}" value="${m[side === 'a' ? 'sa' : 'sb'] ?? ''}" aria-label="Score for ${esc(m[side].join(' and '))}" />`
      : `<span class="t-res">${m[side === 'a' ? 'sa' : 'sb'] ?? '–'}</span>`);
    el.innerHTML = `
      <div class="sheet-head"><button class="btn ghost" data-action="close-sheet">‹ Back</button><h3>Tournament</h3></div>
      <div class="sheet-body t-view">
        <div id="tTop">${tTop(t)}</div>
        <h2>Games</h2>
        ${slots.map((slot) => {
    const games = t.matches.filter((m) => m.slot === slot);
    const finals = games[0].stage !== 'group';
    return `
          <div class="t-round"><div class="t-round-label">${finals ? 'Finals' : `Round ${slot}`}</div>
            ${games.map((m) => `
            <div class="t-match${PT.isScored(m) && m.sa > m.sb ? ' a-won' : ''}${PT.isScored(m) && m.sb > m.sa ? ' b-won' : ''}" data-mid="${esc(m.id)}">
              <span class="t-court c-${esc(m.court)}">${esc(m.court)}</span>
              <div class="t-sides">
                ${stageName[m.stage] ? `<div class="t-stage">${stageName[m.stage]}</div>` : ''}
                <div class="t-line a"><span class="grow">${tSide(m.a)}</span>${score(m, 'a')}</div>
                <div class="t-line b"><span class="grow">${tSide(m.b)}</span>${score(m, 'b')}</div>
              </div>
            </div>`).join('')}
          </div>`;
  }).join('')}
        ${admin ? '<p class="small muted center" style="margin-top:10px">Type both scores for a game; it saves by itself.</p>' : ''}
        <div id="tActions">${tActions(t)}</div>
      </div>`;
    el.hidden = false;
    el.scrollTop = scroll;
    document.body.style.overflow = 'hidden';
  }

  function openTournament(id) {
    state.draft = null; state.tdraft = null;
    state.tview = id;
    $('#sheet').classList.remove('stats-sheet');
    renderTournament();
    $('#sheet').scrollTop = 0;
  }

  // A score: shown straight away, saved in the background, one after another.
  function commitScore(id, matchId, sa, sb) {
    const p = { id, match_id: matchId, sa, sb };
    state.pendingScores.push(p);
    setData(state.serverRaw);
    renderTournament(true);
    state.scoreQueue = (state.scoreQueue || Promise.resolve()).then(async () => {
      try {
        await api('setMatchScore', p, { quiet: true });
      } catch (e) {
        tournamentError(e, `Couldn't save that score. Check it and try again.`);
      } finally {
        state.pendingScores = state.pendingScores.filter((x) => x !== p);
        setData(state.serverRaw);
        if (state.tview) renderTournament(document.activeElement && document.activeElement.classList.contains('t-score'));
      }
    });
  }
  function tournamentError(e, fallback) {
    if (/Unknown action/i.test(e.message || '')) toast('The sheet script needs updating before tournaments work (Apps Script → Deploy → New version).', true);
    else if (e.code === 'auth') handleError(e);
    else toast(e.message || fallback, true);
  }
  document.addEventListener('change', (ev) => {
    const input = ev.target;
    if (!input.classList || !input.classList.contains('t-score') || !state.tview) return;
    const t = state.tournaments.find((x) => x.id === state.tview);
    const m = t && t.matches.find((x) => x.id === input.dataset.mid);
    if (!m) return;
    const row = input.closest('.t-match');
    const [a, b] = ['a', 'b'].map((s) => row.querySelector(`.t-score[data-side="${s}"]`).value.trim());
    if (a === '' && b === '') { if (PT.isScored(m)) commitScore(t.id, m.id, null, null); return; }
    if (a === '' || b === '') return;   // wait for the other score
    const sa = Number(a), sb = Number(b);
    if (!Number.isInteger(sa) || !Number.isInteger(sb) || sa < 0 || sb < 0) { toast('Scores are whole numbers', true); return; }
    if (sa === sb) { toast('A game needs a winner: the scores can\'t be equal', true); return; }
    if (m.sa === sa && m.sb === sb) return;
    commitScore(t.id, m.id, sa, sb);
  });
  // While a tournament is on screen, keep it live for people watching.
  setInterval(async () => {
    if (!state.tview || $('#sheet').hidden || document.visibilityState !== 'visible') return;
    if (state.busy || state.inFlight || state.pendingScores.length) return;
    const typing = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('t-score');
    try { await api('load'); } catch (e) { return; }
    if (state.tview && !$('#sheet').hidden) renderTournament(!!typing);
  }, 20000);

  // ---- setting one up (managers)
  function newTournament(sessionId = '') {
    const d = state.data;
    const today = todayISO();
    const sorted = [...d.sessions].sort((a, b) => a.date.localeCompare(b.date));
    // the session asked for; otherwise today's, or the next one coming up
    const s = d.sessions.find((x) => x.id === sessionId) || sorted.find((x) => x.date >= today) || sorted[sorted.length - 1];
    if (!s) { toast('Add a session first', true); return; }
    state.draft = null; state.tview = null;
    state.tdraft = { id: `t${Date.now().toString(36)}`, session_id: s.id, name: 'Junk Cup', format: 'teams', points_to: 11, courts: 0, players: [], rounds: 0, pick: null };
    tAdoptSession();
    $('#sheet').classList.remove('stats-sheet');
    renderTournamentSetup();
    $('#sheet').scrollTop = 0;
  }
  // Courts from the session's booking, and its players if attendance is already in.
  function tAdoptSession(force = false) {
    const d = state.data, dr = state.tdraft;
    const s = d.sessions.find((x) => x.id === dr.session_id);
    const sum = PB.sessionSummary(d, s);
    const courts = sum.hours / (s.play_hours || 2);
    dr.courts = Number.isInteger(courts) && courts >= 1 && courts <= 3 ? courts : 2;
    // The session's attendance is the roster. Reclub guests aren't named, so they're added by hand.
    const rows = d.attendance.filter((a) => a.session_id === s.id);
    const there = [...new Set(rows.filter((a) => a.pays !== PB.RECLUB).map((a) => a.name))];
    dr.reclub = rows.length - rows.filter((a) => a.pays !== PB.RECLUB).length;
    dr.fromAttendance = there.length;
    if (there.length && (force || !dr.players.length)) dr.players = there;
  }
  function tDraftBuild(dr) {
    const n = dr.players.length;
    if (dr.format === 'teams') {
      if (n < 6) return { error: 'Pick at least 6 players (3 teams).' };
      if (n % 2) return { error: 'Teams need an even number: add or remove one player.' };
      const teams = PT.pairUp(dr.players);
      // how often teams meet: chosen by the manager, otherwise whatever fills the session best
      const times = dr.times || PT.teamsDefaultTimes(teams.length, dr.courts, dr.points_to);
      return { teams, times, matches: PT.buildTeams(teams, dr.courts, times) };
    }
    if (n < 4) return { error: 'Pick at least 4 players.' };
    const options = PT.americanoRounds(n, dr.courts);
    if (!options.includes(dr.rounds)) dr.rounds = PT.americanoDefault(n, dr.courts);
    return { teams: [], matches: PT.buildAmericano(dr.players, dr.rounds, dr.courts), options };
  }
  function renderTournamentSetup() {
    const el = $('#sheet');
    const d = state.data, dr = state.tdraft;
    if (!dr) return;
    const scroll = el.scrollTop;
    const today = todayISO();
    const sessions = [...d.sessions].sort((a, b) => b.date.localeCompare(a.date)).filter((s, i) => s.date >= today || i < 8 || s.id === dr.session_id).slice(0, 12);
    const freq = PB.frequency(d, PB.shiftMonth(today.slice(0, 7), -4) + '-01');
    const known = d.players.filter((p) => p.active).sort((a, b) => (freq.get(b.name) || 0) - (freq.get(a.name) || 0) || a.name.localeCompare(b.name)).map((p) => p.name);
    const names = [...known, ...dr.players.filter((p) => !known.includes(p))];
    const built = tDraftBuild(dr);
    const est = built.matches ? PT.estimate(built.matches, dr.points_to) : null;
    const seg = (action, value, label, on) => `<button type="button" class="seg-btn${on ? ' on' : ''}" data-action="${action}" data-v="${value}">${label}</button>`;
    el.innerHTML = `
      <div class="sheet-head"><button class="btn ghost" data-action="close-sheet">Cancel</button><h3>New tournament</h3></div>
      <div class="sheet-body t-setup">
        <div class="t-hero small"><img class="t-hero-logo" src="junk-cup.webp" alt="Junk Cup" width="1200" height="363" /></div>
        <label class="field"><span>Session</span>
          <select id="tSession">${sessions.map((s) => `<option value="${esc(s.id)}"${s.id === dr.session_id ? ' selected' : ''}>${esc(PB.dayLabel(s.date, true))}${s.location ? ` · ${esc(s.location)}` : ''}</option>`).join('')}</select></label>
        <div class="t-roster-note">${dr.fromAttendance
    ? `<span class="grow">👥 <b>${dr.fromAttendance} players</b> taken from this session's attendance${dr.reclub ? `. ${dr.reclub} Reclub guest${dr.reclub === 1 ? ' isn\'t' : 's aren\'t'} named: add them below if they're playing.` : '.'}</span>
             <button class="btn ghost compact" data-action="t-use-attendance" title="Reset the players to the session's attendance">↻ Reset</button>`
    : '<span class="grow">No attendance entered for this session yet. Tick who\'s there in the session first, or pick the players below.</span>'}</div>
        <label class="field"><span>Name</span><input type="text" id="tName" value="${esc(dr.name)}" /></label>

        <h2>Format</h2>
        <div class="seg">${seg('t-format', 'teams', 'Fixed teams', dr.format === 'teams')}${seg('t-format', 'americano', 'Rotating partners', dr.format === 'americano')}</div>
        <p class="small muted" style="margin:6px 2px 0">${dr.format === 'teams'
    ? 'Teams of two. Every team plays every other team, then the top two play a final.'
    : 'Americano: a new partner every game. Each player collects their own points; most points wins.'}</p>

        <div class="t-opts">
          <div><div class="chip-label">Games to</div><div class="seg small">${[11, 15, 21].map((v) => seg('t-points', v, v, dr.points_to === v)).join('')}</div></div>
          <div><div class="chip-label">Courts</div><div class="seg small">${[1, 2, 3].map((v) => seg('t-courts', v, v, dr.courts === v)).join('')}</div></div>
        </div>

        <h2>Players <span class="pill">${dr.players.length}</span></h2>
        <div class="chips">${names.map((n) => `<button class="chip${dr.players.includes(n) ? ' on' : ''}" data-action="t-toggle" data-name="${esc(n)}">${esc(n)}</button>`).join('')}</div>
        <div class="guest-row" style="margin-top:10px">
          <input type="text" id="tGuest" placeholder="Someone else (a guest)" autocomplete="off" />
          <button class="btn secondary compact" data-action="t-add-guest">Add</button>
        </div>

        ${built.error ? `<div class="warn-box" style="margin-top:14px">${esc(built.error)}</div>` : ''}
        ${!built.error && dr.format === 'teams' ? `
        <h2>Teams <span class="pill">${built.teams.length}</span></h2>
        <p class="small muted" style="margin:-4px 2px 8px">Tap two players to swap them.</p>
        <div class="t-teams">${built.teams.map((team, i) => `
          <div class="t-team"><span class="t-team-no">${i + 1}</span>${team.players.map((p) => `<button class="chip${dr.pick === p ? ' picked' : ''}" data-action="t-pick" data-name="${esc(p)}">${esc(p)}</button>`).join('')}</div>`).join('')}</div>
        <button class="btn secondary block" data-action="t-shuffle" style="margin-top:10px">🔀 Shuffle teams</button>
        <div class="chip-label" style="margin-top:14px">Each team plays every other team</div>
        <div class="seg">${[[1, 'Once'], [2, 'Twice'], [3, '3 times']].map(([v, label]) => seg('t-times', v, label, built.times === v)).join('')}</div>
        <p class="small muted" style="margin:6px 2px 0">${built.teams.length} teams: ${(built.teams.length - 1) * built.times} games each${built.teams.length % 2 ? ', and one team rests each round' : ''}.</p>` : ''}
        ${!built.error && dr.format === 'americano' ? `
        <label class="field" style="margin-top:14px"><span>Rounds</span>
          <select id="tRounds">${built.options.map((r) => { const g = PT.americanoLoad(dr.players.length, r, dr.courts); return `<option value="${r}"${r === dr.rounds ? ' selected' : ''}>${r} rounds · ${g.games} games · ${g.each} each${g.sits ? `, sit out ${g.sits}` : ''}</option>`; }).join('')}</select></label>
        <p class="small muted" style="margin:-4px 2px 0">Each round is one game per court. Only round counts where everyone plays the same number of games are offered.</p>` : ''}

        ${est ? `<div class="t-est"><b>${est.games} games</b> in ${est.slots} round${est.slots === 1 ? '' : 's'} on ${est.courts} court${est.courts === 1 ? '' : 's'}
          <span class="muted">· about ${est.minutes >= 60 ? `${Math.floor(est.minutes / 60)}h${est.minutes % 60 ? ` ${est.minutes % 60}m` : ''}` : `${est.minutes}m`}${dr.format === 'teams' ? `, plus ${est.perGame}m for the final` : ''}</span>
          <div class="small muted" style="margin-top:2px">Allowing ${est.perGame} minutes a game, changeover included.</div></div>` : ''}
      </div>
      <div class="sheet-foot"><div class="inner">
        <div class="summary">${built.error ? '<span class="muted">Not ready yet</span>' : `<b>${dr.players.length} players</b><br><span class="muted">${dr.format === 'teams' ? `${built.teams.length} teams · ${built.matches.length} games` : `${dr.rounds} rounds`} · to ${dr.points_to}</span>`}</div>
        <button class="btn" data-action="t-create"${built.error ? ' disabled' : ''}>Create</button>
      </div></div>`;
    el.hidden = false;
    el.scrollTop = scroll;
    document.body.style.overflow = 'hidden';
  }
  ['input', 'change'].forEach((type) => document.addEventListener(type, (ev) => {
    const dr = state.tdraft;
    if (!dr) return;
    if (ev.target.id === 'tName') dr.name = ev.target.value;
    if (type !== 'change') return;
    if (ev.target.id === 'tSession') { dr.session_id = ev.target.value; dr.players = []; tAdoptSession(true); renderTournamentSetup(); }
    if (ev.target.id === 'tRounds') { dr.rounds = Number(ev.target.value); renderTournamentSetup(); }
  }));

  /** Tournament buttons. Returns true when the action was one of ours. */
  async function tournamentAction(a, t) {
    const dr = state.tdraft;
    switch (a) {
      case 'open-tournament': openTournament(t.dataset.id); return true;
      case 'new-tournament': newTournament(); return true;
      case 'session-tournament': {
        // From the session editor: save who's ticked first, so the roster is what's on screen.
        const sid = state.draft && state.draft.id;
        if (!sid) return true;
        await saveDraft();
        if (state.draft) return true;   // the save was refused; its message is already showing
        const existing = (state.tournaments || []).find((x) => x.session_id === sid);
        if (existing) openTournament(existing.id); else newTournament(sid);
        return true;
      }
      case 't-use-attendance': tAdoptSession(true); dr.pick = null; renderTournamentSetup(); return true;
      case 't-format': dr.format = t.dataset.v; dr.pick = null; renderTournamentSetup(); return true;
      case 't-points': dr.points_to = Number(t.dataset.v); renderTournamentSetup(); return true;
      case 't-times': dr.times = Number(t.dataset.v); renderTournamentSetup(); return true;
      case 't-courts': dr.courts = Number(t.dataset.v); renderTournamentSetup(); return true;
      case 't-toggle': {
        const n = t.dataset.name;
        dr.players = dr.players.includes(n) ? dr.players.filter((x) => x !== n) : dr.players.concat(n);
        dr.pick = null; dr.times = 0;   // a different number of teams: pick the best fit again
        renderTournamentSetup(); return true;
      }
      case 't-add-guest': {
        const n = $('#tGuest').value.trim();
        if (!n) return true;
        const same = [...state.data.players.map((p) => p.name), ...dr.players].find((x) => x.toLowerCase() === n.toLowerCase());
        if (same) { if (!dr.players.includes(same)) dr.players.push(same); } else dr.players.push(n);
        dr.times = 0;
        renderTournamentSetup(); return true;
      }
      case 't-shuffle': dr.players = PT.shuffle(dr.players); dr.pick = null; renderTournamentSetup(); return true;
      case 't-pick': {
        const n = t.dataset.name;
        if (!dr.pick) dr.pick = n;
        else if (dr.pick === n) dr.pick = null;
        else {
          const i = dr.players.indexOf(dr.pick), j = dr.players.indexOf(n);
          [dr.players[i], dr.players[j]] = [dr.players[j], dr.players[i]];
          dr.pick = null;
        }
        renderTournamentSetup(); return true;
      }
      case 't-create': {
        const built = tDraftBuild(dr);
        if (built.error) return true;
        const data = { format: dr.format, points_to: dr.points_to, courts: dr.courts, players: dr.players, teams: built.teams, matches: built.matches, ...(built.times ? { times: built.times } : {}) };
        try {
          await api('saveTournament', { id: dr.id, session_id: dr.session_id, name: dr.name.trim() || 'Junk Cup', data });
          toast('Tournament created');
          openTournament(dr.id);
        } catch (e) { tournamentError(e, 'Couldn\'t create the tournament.'); }
        return true;
      }
      case 't-finals': case 't-delete': case 't-replace': {
        const cur = state.tournaments.find((x) => x.id === state.tview);
        if (!cur) return true;
        const put = async (next, okMsg) => {
          const { id, session_id, name, updated_at, ...data } = next;   // eslint-disable-line no-unused-vars
          try { await api('saveTournament', { id, session_id, name, data }); toast(okMsg); renderTournament(); } catch (e) { tournamentError(e, 'Couldn\'t save that.'); }
        };
        if (a === 't-finals') {
          const finals = PT.finals(cur);
          if (finals.length) await put({ ...cur, matches: [...cur.matches, ...finals] }, 'Final created');
        } else if (a === 't-delete') {
          if (!window.confirm(`Delete "${cur.name}" and all its scores?`)) return true;
          try { await api('deleteTournament', { id: cur.id }); toast('Tournament deleted'); state.tview = null; closeSheet(); } catch (e) { tournamentError(e, 'Couldn\'t delete it.'); }
        } else {
          const from = window.prompt(`Who is being replaced?\n\n${cur.players.join(', ')}`);
          if (!from) return true;
          const out = cur.players.find((p) => p.toLowerCase() === from.trim().toLowerCase());
          if (!out) { toast(`${from.trim()} isn't in this tournament`, true); return true; }
          const to = (window.prompt(`Who is taking ${out}'s place?`) || '').trim();
          if (!to) return true;
          if (cur.players.some((p) => p.toLowerCase() === to.toLowerCase())) { toast(`${to} is already playing`, true); return true; }
          await put(PT.replacePlayer(cur, out, to), `${to} is in for ${out}`);
        }
        return true;
      }
      default: return false;
    }
  }

  function closeSheet() {
    state.draft = null;
    state.tdraft = null; state.tview = null;
    const el = $('#sheet');
    el.hidden = true;
    el.classList.remove('stats-sheet');
    el.innerHTML = '';
    document.body.style.overflow = '';
    render();
  }

  // One person's page: headline numbers, sessions per month, and every month's bill.
  function openPlayer(name) {
    const d = state.data;
    const h = PB.playerHistory(d, name);
    const admin = d.role !== 'member';
    const el = $('#sheet');
    if (!h.months.length) {
      if (admin && h.player) { editPlayer(name); return; }
      toast(`${name} hasn't played yet`);
      return;
    }
    const monthName = (m) => PB.monthLabel(m).split(' ')[0];
    // last 12 months, oldest first, including the quiet ones
    const end = h.months[0].month;
    const span = Array.from({ length: 12 }, (_, i) => PB.shiftMonth(end, i - 11));
    const byMonth = new Map(h.months.map((m) => [m.month, m]));
    const peak = Math.max(1, ...span.map((m) => (byMonth.get(m) || { games: 0 }).games));
    const share = h.totalSessions ? Math.round((h.games / h.totalSessions) * 100) : 0;
    const facts = [
      h.totalSessions ? `Played ${h.games} of the ${h.totalSessions} sessions since joining (${share}%)` : '',
      h.favouriteDay ? `Usually a ${({ Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' })[h.favouriteDay]} player` : '',
      h.busiestMonth && h.busiestMonth.games > 1 ? `Busiest month: ${PB.monthLabel(h.busiestMonth.month)} (${h.busiestMonth.games} sessions)` : '',
      h.favouritePlace ? `Most often at ${esc(h.favouritePlace)}` : '',
    ].filter(Boolean);
    const line = (i) => `<button class="glance-row" data-action="view-session" data-id="${esc(i.session)}" data-from="${esc(name)}"><span class="name">${esc(PB.dayLabel(i.date))}<span class="note">${
      i.kind === 'booking' ? `booked ${i.hours} court-hour${i.hours === 1 ? '' : 's'}` : i.kind === 'guest' ? `guest ${esc(i.who)}` : i.kind === 'hosted' ? `paid by ${esc(i.paidBy)}` : ''}${i.location ? `${i.kind === 'self' ? '' : ' · '}${esc(i.location)}` : ''}</span></span>
      <span class="amount${i.kind === 'hosted' || i.kind === 'booking' ? ' muted' : ''}">${i.kind === 'booking' ? '+' : ''}${money(i.amount)}</span><span class="row-chev" aria-hidden="true">${ICON.chevron}</span></button>`;
    el.innerHTML = `
      <div class="sheet-head"><button class="btn ghost" data-action="close-sheet">‹ Back</button><h3>${esc(name)}</h3>
        ${admin && h.player ? `<button class="btn ghost" data-action="edit-player" data-name="${esc(name)}">Edit</button>` : ''}</div>
      <div class="sheet-body">
        <div class="profile-head">
          <span class="avatar big${h.isMember ? '' : ' alt'}" aria-hidden="true">${esc(name.slice(0, 1).toUpperCase())}</span>
          <div class="grow">
            <div class="profile-name">${esc(name)}</div>
            <div class="profile-sub">${h.isMember ? 'Member' : h.isGuest ? 'Guest' : 'Regular'}${h.first ? ` · since ${esc(PB.monthLabel(h.first.slice(0, 7)).replace(/^(\w{3})\w*/, '$1'))}` : ''}${h.player && !h.player.active ? ' · inactive' : ''}</div>
          </div>
        </div>
        <div class="stats">
          <div class="stat"><div class="label">Sessions played</div><div class="value">${h.games}</div></div>
          <div class="stat"><div class="label">First session</div><div class="value">${h.first ? esc(PB.dayLabel(h.first, true).slice(4)) : '—'}</div></div>
          <div class="stat"><div class="label">Court fees, all time</div><div class="value">${money(h.fees)}</div></div>
          <div class="stat"><div class="label">Average per session</div><div class="value">${h.games ? money(h.perGame) : '—'}</div></div>
        </div>
        ${facts.length ? `<div class="card facts">${facts.map((f) => `<div>${f}</div>`).join('')}</div>` : ''}

        <h2>Sessions per month</h2>
        <div class="card">
          <div class="spark" role="img" aria-label="Sessions played in each of the last 12 months">
            ${span.map((m) => { const g = (byMonth.get(m) || { games: 0 }).games; return `<div class="col" title="${esc(PB.monthLabel(m))}: ${g} session${g === 1 ? '' : 's'}"><span class="n">${g || ''}</span><i style="height:${Math.round((g / peak) * 100)}%"></i><span class="m">${esc(monthName(m).slice(0, 1))}</span></div>`; }).join('')}
          </div>
          <div class="small muted center">${esc(PB.monthLabel(span[0]))} to ${esc(PB.monthLabel(end))}</div>
        </div>

        ${h.years.map((y) => `
          <h2>${y.year} <span class="pill">${y.games} session${y.games === 1 ? '' : 's'} · ${money(y.fees)}</span></h2>
          ${y.months.map((m) => `
            <details class="glance">
              <summary><span class="chev" aria-hidden="true"></span><span class="grow">${esc(monthName(m.month))} <span class="count">· ${m.games} session${m.games === 1 ? '' : 's'}</span></span>
                ${m.paid ? '<span class="tick small">✓ paid</span>' : ''}<span class="amount">${money(m.fees)}</span></summary>
              ${m.items.map(line).join('')}
              ${admin ? `<div class="glance-row" style="cursor:default"><button class="btn ghost compact" data-action="${h.isMember ? 'send-member' : 'send-player'}" data-person="${esc(name)}" data-month="${m.month}">${ICON.send} Send ${esc(monthName(m.month))} ${h.isMember ? 'payback' : 'bill'}</button></div>` : ''}
            </details>`).join('')}`).join('')}
        ${h.isMember ? '<p class="small muted center">Court fees for a member come off their booking, so there is nothing to pay.</p>' : ''}
      </div>`;
    el.hidden = false;
    el.scrollTop = 0;
    document.body.style.overflow = 'hidden';
  }

  function editPlayer(name) {
    const p = state.data.players.find((x) => x.name === name) || { name: '', role: 'player', active: true, phone: '', notes: '' };
    openForm(name ? `Edit ${name}` : 'Add player', `
      <label class="field"><span>Name</span><input type="text" name="name" value="${esc(p.name)}" required /></label>
      <label class="field"><span>Type</span><select name="role">
        <option value="player"${p.role === 'player' ? ' selected' : ''}>Player</option>
        <option value="member"${p.role === 'member' ? ' selected' : ''}>Member (books courts, gets payback)</option></select></label>
      <label class="field"><span>Status</span><select name="active">
        <option value="true"${p.active ? ' selected' : ''}>Active</option>
        <option value="false"${!p.active ? ' selected' : ''}>Inactive (hidden from the player list)</option></select></label>
      <label class="field"><span>WhatsApp number with country code (optional — lets "Send" open their chat)</span>
        <input type="tel" name="phone" value="${esc(p.phone)}" placeholder="+852 9123 4567" /></label>
      <label class="field"><span>Notes</span><input type="text" name="notes" value="${esc(p.notes)}" /></label>
      ${name ? '<p class="small muted">Renaming updates every past session too.</p>' : ''}`,
    (fd) => {
      const newName = fd.name.trim();
      const clash = PB.playerNamed(state.data, newName, name);
      if (clash) { toast(nameTakenMessage(clash.name, newName), true); return false; }
      return save('savePlayer', {
        originalName: name || newName, name: newName, role: fd.role, isNew: !name,
        active: fd.active === 'true', phone: fd.phone, notes: fd.notes,
      }, 'Player saved');
    });
  }

  const nameTakenMessage = (existing) =>
    `There's already a ${existing}. Add a last initial so bills don't get mixed up, e.g. "${existing} G".`;

  // A guest who keeps coming becomes a regular. Their past visits follow them
  // (renamed too, if the name is changed here).
  function promoteGuest(guestName) {
    const g = PB.knownGuests(state.data).find((x) => x.name === guestName);
    if (!g) return;
    openForm(`Make ${guestName} a regular`, `
      <label class="field"><span>Name (change it if another player has the same one)</span>
        <input type="text" name="name" value="${esc(guestName)}" required /></label>
      <label class="field"><span>WhatsApp number with country code (optional)</span>
        <input type="tel" name="phone" placeholder="+852 9123 4567" /></label>
      <p class="small muted">Past months stay as they were billed. From now on ${esc(guestName)} is ticked like any other player and gets their own bill${g.pays !== g.name ? ` — not ${esc(g.pays)}'s` : ''}.</p>`,
    (fd) => {
      const newName = fd.name.trim();
      const clash = PB.playerNamed(state.data, newName);
      if (clash) { toast(nameTakenMessage(clash.name, newName), true); return false; }
      return save('savePlayer', { originalName: guestName, name: newName, role: 'player', active: true, phone: fd.phone, isNew: true },
        `${newName} is now a regular`);
    });
  }

  function addMembership(member = '') {
    const d = state.data;
    const members = d.players.filter((p) => p.role === 'member').map((p) => p.name);
    openForm('Record a top-up', `
      <label class="field"><span>Member</span><select name="member">${members.map((m) => `<option${m === member ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select></label>
      <label class="field"><span>Date</span><input type="date" name="date" value="${todayISO()}" /></label>
      <label class="field"><span>Credit added (${esc(d.settings.currency)})</span><input type="number" inputmode="decimal" name="amount" required /></label>
      <label class="field"><span>Court rate per hour charged to the group</span><input type="number" inputmode="decimal" step="0.01" name="rate" value="${esc(d.settings.default_rate)}" required /></label>
      <label class="field"><span>Notes</span><input type="text" name="notes" placeholder="e.g. new price from January" /></label>
      <p class="small muted">New sessions booked on this membership use this rate. Past sessions keep the rate they were booked at.</p>`,
    (fd) => {
      const amount = Number(fd.amount); const rate = Number(fd.rate);
      if (!(amount > 0) || !(rate > 0)) { toast('Enter the amount and the rate', true); return false; }
      return save('saveMembership', { ...fd, amount, rate, hours: PB.round2(amount / rate), kind: 'purchase' }, 'Top-up saved');
    });
  }

  // What the court says is left. Becomes the new starting point for that member's credit.
  function addCourtBalance(member = '') {
    const d = state.data;
    const members = d.players.filter((p) => p.role === 'member').map((p) => p.name);
    const y = new Date(); y.setDate(y.getDate() - 1);
    const yesterday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
    openForm('Enter court balance', `
      <label class="field"><span>Member</span><select name="member">${members.map((m) => `<option${m === member ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select></label>
      <label class="field"><span>Balance the court gave (${esc(d.settings.currency)})</span><input type="number" inputmode="decimal" step="0.01" name="amount" required /></label>
      <label class="field"><span>Balance as of (the last session it includes)</span><input type="date" name="date" value="${yesterday}" /></label>
      <p class="small muted">The court takes credit off as soon as a court is booked (and gives it back if released), so its figure already includes bookings for later sessions. From this date the app counts down from the court's figure; past sessions and paybacks don't change.</p>`,
    (fd) => {
      const amount = Number(fd.amount);
      if (!(amount >= 0) || fd.amount === '') { toast('Enter the balance', true); return false; }
      const covers = PB.formatCovers(PB.bookedAfter(d, fd.member, fd.date));
      return save('saveMembership', { member: fd.member, date: fd.date, amount, hours: 0, rate: Number(d.settings.default_rate) || 0,
        kind: 'balance', covers, notes: `Court balance check: ${money(amount)} as of ${fd.date}${covers ? ` | covers: ${covers}` : ''}` }, 'Court balance saved');
    });
  }

  function addKitty() {
    openForm('Kitty spending', `
      <label class="field"><span>Date</span><input type="date" name="date" value="${todayISO()}" /></label>
      <label class="field"><span>What for</span><input type="text" name="description" placeholder="Balls" required /></label>
      <label class="field"><span>Amount spent</span><input type="number" inputmode="decimal" name="amount" required /></label>`,
    (fd) => save('saveKitty', { ...fd, amount: -Math.abs(Number(fd.amount)) }, 'Saved'));
  }

  // ------------------------------------------------------------ events

  document.addEventListener('click', async (ev) => {
    const tabBtn = ev.target.closest('[data-tab]');
    if (tabBtn) {
      state.tab = tabBtn.dataset.tab;
      store.set(LS.tab, state.tab);
      render();
      window.scrollTo(0, 0);
      return;
    }
    const t = ev.target.closest('[data-action]');
    if (!t) return;
    if (t.tagName === 'A') ev.preventDefault();   // links with an action stay in the app
    const a = t.dataset.action;
    const dr = state.draft;
    const d = state.data;
    if (await tournamentAction(a, t)) return;

    switch (a) {
      case 'connect': {
        const url = ($('#setupUrl') && $('#setupUrl').value.trim()) || state.apiUrl;
        const code = $('#setupCode').value.trim();
        if (!API_URL_RE.test(url)) return toast('That URL should start with script.google.com and end in /exec', true);
        if (!code) return toast('Enter the access code', true);
        state.apiUrl = url; state.code = code;
        try {
          await api('load');
          store.set(LS.api, url); store.set(LS.code, code);
          toast('Connected');
          render();
        } catch (e) { state.code = ''; handleError(e); }
        break;
      }
      case 'refresh': if (!state.busy) refresh(); break;
      case 'toggle-theme': {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        store.set(LS.theme, next);
        applyTheme(next);
        break;
      }
      case 'show-all': state.showAllSessions = true; render(); break;
      case 'new-session': openSession(null); break;
      case 'edit-session': openSession(t.dataset.id); break;
      case 'close-sheet': state.sheetBack = null; closeSheet(); break;
      case 'open-stats': openStats(); break;
      case 'copy-poll': {
        // From the list: the saved session. In the editor: what's on screen now.
        const s = t.dataset.id ? d.sessions.find((x) => x.id === t.dataset.id) : null;
        const text = s ? PB.pollText(d, s) : (state.pollNow ? state.pollNow() : '');
        if (!text) return;
        try { await navigator.clipboard.writeText(text); toast('Poll question copied. Paste it into a new WhatsApp poll.'); } catch (e) { window.prompt('Copy this:', text); }
        break;
      }
      case 'sheet-back': { const fn = state.sheetBack; state.sheetBack = null; if (fn) fn(); else closeSheet(); break; }
      case 'view-session': {
        const from = t.dataset.from;
        viewSession(t.dataset.id, from ? () => openPlayer(from) : null);
        break;
      }
      case 'hours': {
        const b = dr.bookings[t.dataset.member];
        b.hours = Math.max(0, (Number(b.hours) || 0) + Number(t.dataset.delta));
        renderSheet();
        break;
      }
      case 'toggle-player': {
        const n = t.dataset.name;
        dr.players = dr.players.includes(n) ? dr.players.filter((x) => x !== n) : dr.players.concat(n);
        if (dr.guests.length) { renderSheet(); break; } // refresh "who pays" lists
        t.classList.toggle('on');
        const pill = t.closest('.sheet-body').querySelectorAll('h2 .pill')[0];
        if (pill) pill.textContent = dr.players.length;
        updateSheetFooter();
        break;
      }
      case 'promote-guest': promoteGuest(t.dataset.name); break;
      case 'skip-regular': {
        let skipped = [];
        try { skipped = JSON.parse(store.get(LS.notRegular) || '[]'); } catch (e) { skipped = []; }
        store.set(LS.notRegular, JSON.stringify(skipped.concat(t.dataset.name)));
        render();
        break;
      }
      case 'quick-add-player': {
        const name = t.dataset.name;
        if (await save('savePlayer', { name, role: 'player', active: true, isNew: true }, `${name} added`)) {
          dr.players.push(name); dr.search = ''; renderSheet();
        }
        break;
      }
      case 'reactivate-player': {
        const pl = d.players.find((x) => x.name === t.dataset.name);
        if (!pl) return;
        if (await save('savePlayer', { originalName: pl.name, name: pl.name, role: pl.role, active: true, phone: pl.phone, notes: pl.notes }, `${pl.name} is active again`)) {
          dr.players.push(pl.name); dr.search = ''; renderSheet();
        }
        break;
      }
      case 'add-guest': dr.guests.push({ name: '', pays: '' }); renderSheet(); break;
      case 'add-reclub': dr.guests.push({ name: 'Reclub guest', pays: 'Reclub' }); renderSheet(); break;
      case 'remove-guest': dr.guests.splice(Number(t.dataset.index), 1); renderSheet(); break;
      case 'save-session': saveDraft(); break;
      case 'delete-session': {
        if (!window.confirm('Delete this session? This removes its bookings and attendance.')) return;
        if (await save('deleteSession', { id: dr.id }, 'Session deleted')) closeSheet();
        break;
      }
      case 'share-session': {
        const s = d.sessions.find((x) => x.id === dr.id);
        if (s) sendText(PB.sessionMessage(PB.sessionSummary(d, s), d.settings));
        break;
      }
      case 'month': state.month = PB.shiftMonth(state.month, Number(t.dataset.delta)); render(); break;
      case 'toggle-paid': {
        const paid = t.dataset.paid !== '1';
        // Tick at once and save in the background, one after another, so several can be ticked quickly.
        const p = { month: t.dataset.month || state.month, person: t.dataset.person, paid, amount: Number(t.dataset.amount), paid_on: todayISO() };
        state.pendingPaid.push(p);
        setData(state.serverRaw);
        render();
        state.paidQueue = (state.paidQueue || Promise.resolve()).then(async () => {
          try {
            await api('setPaid', p, { quiet: true });
          } catch (e) {
            handleError(e);
            toast(`Couldn't save ${p.person}. Check and try again.`, true);
          } finally {
            state.pendingPaid = state.pendingPaid.filter((x) => x !== p);
            setData(state.serverRaw);   // a failed tick drops back to what the sheet has
            render();
          }
        });
        break;
      }
      case 'send-player': case 'send-member': {
        const month = t.dataset.month || state.month;
        const st = PB.monthStatement(d, month);
        const p = d.players.find((x) => x.name === t.dataset.person);
        const entry = (a === 'send-player' ? st.players : st.members).find((x) => x.name === t.dataset.person);
        if (!entry) return;
        const text = a === 'send-player' ? PB.playerMessage(entry, month, d.settings) : PB.memberMessage(entry, month, d.settings);
        sendText(text, p && p.phone);
        break;
      }
      case 'send-group': sendText(PB.groupMessage(PB.monthStatement(d, state.month), d.settings)); break;
      case 'edit-player': editPlayer(t.dataset.name); break;
      case 'open-player': openPlayer(t.dataset.name); break;
      case 'add-membership': addMembership(t.dataset.member || ''); break;
      case 'add-court-balance': addCourtBalance(t.dataset.member || ''); break;
      case 'share-member-invite': {
        const link = inviteLink(String(state.data.settings.member_code));
        const text = `${state.data.settings.club_name || 'Junk Pickleball'} — tap to see sessions and bills: ${link}`;
        if (navigator.share) navigator.share({ text }).catch(() => {});
        else copyText(link);
        break;
      }
      case 'share-invite': {
        const link = inviteLink();
        if (navigator.share) navigator.share({ text: `Junk Pickleball manager app — tap to sign in: ${link}` }).catch(() => {});
        else copyText(link);
        break;
      }
      case 'add-kitty': addKitty(); break;
      case 'delete-kitty':
        if (window.confirm('Remove this kitty entry?')) save('deleteKitty', { id: t.dataset.id }, 'Removed').then(render);
        break;
      case 'save-settings':
        save('saveSettings', {
          club_name: $('#sClub').value.trim(), default_rate: $('#sRate').value, reclub_fee: $('#sReclub').value,
          pay_to: $('#sPayTo').value.trim(), currency: $('#sCur').value.trim() || '$',
          public_stats: $('#sStats').value,
          locations: $('#sPlaces').value.split('\n').map((x) => x.trim()).filter(Boolean).join(' | '),
        }, 'Settings saved').then(render);
        break;
      case 'sign-out':
        if (window.confirm('Forget the access code on this device?')) {
          store.del(LS.code); store.del(LS.cache); state.code = ''; state.data = null; render();
        }
        break;
      default: break;
    }
  });

  // The phone's back button (Android) steps back out of a session, player page,
  // stats or form instead of leaving the app. Each open sheet adds one history
  // step; closing it with the on-screen button takes that step back off.
  state.skipPop = false;
  new MutationObserver(() => {
    const open = !$('#sheet').hidden;
    const marked = !!(history.state && history.state.jpbSheet);
    if (open && !marked) history.pushState({ jpbSheet: 1 }, '');
    else if (!open && marked) { state.skipPop = true; history.back(); }
  }).observe($('#sheet'), { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('popstate', () => {
    if (state.skipPop) {
      state.skipPop = false;
      // one screen closed and another opened straight after: keep a step for the new one
      if (!$('#sheet').hidden && !(history.state && history.state.jpbSheet)) history.pushState({ jpbSheet: 1 }, '');
      return;
    }
    if ($('#sheet').hidden) return;
    const fn = state.sheetBack;
    state.sheetBack = null;
    if (fn) {
      fn();   // e.g. from a session back to the player page it was opened from
      if (!$('#sheet').hidden) history.pushState({ jpbSheet: 1 }, '');
    } else {
      closeSheet();
    }
  });

  // Remember which glance tables are folded away (the toggle event doesn't bubble).
  document.addEventListener('toggle', (ev) => {
    const key = ev.target && ev.target.dataset ? ev.target.dataset.glance : '';
    if (key) store.set(`jpb.open.${key}`, ev.target.open ? '1' : '0');
    // the session editor's folded booking: remember it while the editor re-draws
    if (ev.target && ev.target.dataset && ev.target.dataset.fold === 'booking' && state.draft) {
      state.draft.bookingOpen = ev.target.open;
      const hint = ev.target.querySelector('summary .small'); if (hint) hint.textContent = ev.target.open ? '' : 'Edit';
    }
  }, true);

  // Session editor: keep the poll preview in step with the date, time, place and length.
  ['input', 'change'].forEach((type) => document.addEventListener(type, (ev) => {
    if (!['dDate', 'dStart', 'dLength', 'dLocation'].includes(ev.target.id)) return;
    setTimeout(() => { const el = $('#sheet .poll-text'); if (el && state.pollNow) el.textContent = state.pollNow(); }, 0);
  }));

  // Club tab: filter the player list as you type (no re-render, so the keyboard stays up).
  document.addEventListener('input', (ev) => {
    if (ev.target.id !== 'pSearch') return;
    const q = ev.target.value.trim().toLowerCase();
    document.querySelectorAll('#playerList [data-search]').forEach((r) => { r.hidden = !!q && !r.dataset.search.includes(q); });
  });

  document.addEventListener('input', (ev) => {
    const dr = state.draft;
    if (!dr) return;
    const el = ev.target;
    if (el.id === 'dSearch') {
      dr.search = el.value;
      const pos = el.selectionStart;
      renderSheet();
      const s = $('#dSearch'); s.focus(); s.setSelectionRange(pos, pos);
    } else if (el.id === 'dNotes') {
      dr.notes = el.value;
    } else if (el.dataset.rate !== undefined) {
      dr.bookings[el.dataset.rate].rate = el.value;
      updateSheetFooter();
    } else if (el.dataset.guestName !== undefined) {
      const g = dr.guests[Number(el.dataset.guestName)];
      const wasSelf = g.pays && g.pays === g.name;
      g.name = el.value;
      if (wasSelf) g.pays = el.value;
    }
  });

  document.addEventListener('change', (ev) => {
    const dr = state.draft;
    if (!dr) return;
    const el = ev.target;
    if (el.id === 'dDate') {
      dr.date = el.value;
    } else if (el.id === 'dLocation') {
      dr.location = el.value;
    } else if (el.id === 'dStart') {
      dr.start_hour = Number(el.value);
    } else if (el.id === 'dLength') {
      dr.play_hours = Number(el.value);
      updateSheetFooter();
    } else if (el.dataset.guestName !== undefined) {
      // A returning guest: fill in who paid for them last time.
      const g = dr.guests[Number(el.dataset.guestName)];
      const known = PB.knownGuests(state.data).find((k) => k.name.toLowerCase() === g.name.trim().toLowerCase());
      if (known && (!g.pays || g.pays === '__self')) {
        g.name = known.name;
        if (known.pays === known.name) g.pays = known.name;
        else if (dr.players.includes(known.pays)) g.pays = known.pays;
        renderSheet();
      }
    } else if (el.dataset.guestPays !== undefined) {
      const g = dr.guests[Number(el.dataset.guestPays)];
      g.pays = el.value === '__self' ? (g.name || '__self') : el.value;
      if (el.value === '__self' && !g.name) g.pays = '__self';
    }
  });

  // ------------------------------------------------------------ start

  const cached = store.get(LS.cache);
  if (cached) {
    try { setData(JSON.parse(cached)); } catch (e) { store.del(LS.cache); }
  }
  async function start() {
    render();
    if (!state.apiUrl || !state.code) return;
    const invite = state.invite;
    state.invite = null;
    if (!invite) { refresh(true); return; }
    try {
      await api('load');
      store.set(LS.code, state.code);
      if (!configuredUrl) store.set(LS.api, state.apiUrl);
      toast('Signed in');
      render();
    } catch (e) {
      if (e.code === 'auth' && invite.prevCode) {
        state.code = invite.prevCode;
        state.apiUrl = invite.prevUrl;
        toast('That invite link is out of date', true);
        refresh(true);
      } else {
        handleError(e);
      }
    }
  }
  start();

  // Coming back to the app (unlocking the phone, switching back from WhatsApp)
  // fetches the latest from the sheet, so nobody looks at old data. Skipped
  // while something is open or saving, and at most once every 30 seconds.
  let lastAuto = Date.now();
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (!state.apiUrl || !state.code || !state.data) return;
    if (state.busy || state.inFlight || state.pendingPaid.length || !$('#sheet').hidden) return;
    if (Date.now() - lastAuto < 30000) return;
    lastAuto = Date.now();
    try {
      await api('load');
      if ($('#sheet').hidden) render();
    } catch (e) {
      if (e.code === 'auth') handleError(e);   // a bad connection stays quiet; the old data is still shown
    }
  });
})();
