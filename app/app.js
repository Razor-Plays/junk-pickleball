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

  async function api(action, payload = {}) {
    if (!state.apiUrl) throw new Error('No API URL set');
    state.busy = true;
    $('[data-action="refresh"]').classList.add('spin');
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
      state.busy = false;
      $('[data-action="refresh"]').classList.remove('spin');
    }
  }

  function setData(raw) {
    state.raw = raw;
    state.data = PB.normalize(raw);
    store.set(LS.cache, JSON.stringify(raw));
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
      const who = sum.bookings.map((b) => `${b.member}${b.hours !== 1 ? ' ×' + b.hours : ''}`).join(', ');
      const sub = sum.heads
        ? `${sum.heads} players · ${money(sum.cpp)} each · ${PB.courtLabel(sum)}`
        : `${PB.courtLabel(sum)}${who ? ' · ' + who : ''}`;
      const label = PB.dayLabel(s.date, true);
      return `
        <button class="session" data-action="edit-session" data-id="${esc(s.id)}">
          <div class="date-block"><span>${esc(label.slice(0, 3).toUpperCase())}</span><b>${Number(s.date.slice(8, 10))}</b><span>${MONTHS[Number(s.date.slice(5, 7)) - 1]}</span></div>
          <div class="grow">
            <div class="title">${esc(label)}</div>
            <div class="sub">${esc(sub)}</div>
            ${s.location ? `<div class="sub place">${ICON.pin}${esc(s.location)}</div>` : ''}
          </div>
          ${sum.heads ? '' : `<span class="pill todo">${d.role === 'member' ? 'Booked' : 'To fill ›'}</span>`}
        </button>`;
    };

    const ro = d.role === 'member';
    const balances = PB.membershipBalances(d).filter((b) => b.active);
    const low = ro ? [] : balances.filter((b) => b.purchased && b.left <= 8);

    let skipped = [];
    try { skipped = JSON.parse(store.get(LS.notRegular) || '[]'); } catch (e) { skipped = []; }
    const suggestions = ro ? [] : PB.regularSuggestions(d).filter((g) => !skipped.includes(g.name)).slice(0, 3);
    const suggestionCards = suggestions.length ? `
      <h2>Guests who keep coming</h2>
      <div class="list">${suggestions.map((g, i) => `
        <div class="row">
          <span class="avatar${i % 2 ? ' alt' : ''}" aria-hidden="true">${esc(g.name.slice(0, 1).toUpperCase())}</span>
          <div class="grow"><div class="title">${esc(g.name)}</div>
            <div class="sub">${g.count} visits${g.pays !== g.name ? ` · with ${esc(g.pays)}` : ''}</div></div>
          <button class="btn secondary compact" data-action="promote-guest" data-name="${esc(g.name)}">Make a regular</button>
          <button class="icon-btn muted" data-action="skip-regular" data-name="${esc(g.name)}" aria-label="Not now" title="Not now">✕</button>
        </div>`).join('')}</div>` : '';

    return `
      ${low.length ? `<button class="alert" data-tab="club">${ICON.bell}<span class="grow">Hours running low: ${low.map((b) => `<b>${esc(b.name)} ${b.left}h</b>`).join(', ')}</span>${ICON.chevron}</button>` : ''}
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
        <button class="btn ghost" data-action="${back ? 'sheet-back' : 'close-sheet'}">${back ? '‹ Back' : 'Close'}</button>
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
        location: s.location || '', play_hours: s.play_hours || 2,
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
        play_hours: 2,
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

    el.innerHTML = `
      <div class="sheet-head">
        <button class="btn ghost" data-action="close-sheet">Cancel</button>
        <h3>${dr.isNew ? 'New session' : 'Edit session'}</h3>
        ${dr.isNew ? '' : '<button class="btn danger" data-action="delete-session">Delete</button>'}
      </div>
      <div class="sheet-body">
        <label class="field"><span>Date</span>
          <input type="date" id="dDate" value="${esc(dr.date)}" />
        </label>
        <label class="field"><span>Where</span>
          <select id="dLocation">
            ${[...new Set([...PB.locations(d), dr.location].filter(Boolean))].map((l) => `<option${l === dr.location ? ' selected' : ''}>${esc(l)}</option>`).join('')}
            <option value=""${dr.location ? '' : ' selected'}>Not set</option>
          </select>
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
        </div>

        <h2>Who played <span class="pill">${dr.players.length}</span></h2>
        <input type="search" id="dSearch" placeholder="Search players" value="${esc(dr.search)}" style="margin-bottom:10px" />
        ${grouped ? `
        <div class="chip-label">Usual crowd — most active first</div>
        <div class="chips">${usual.map(chip).join('')}</div>
        <div class="chip-label">Everyone else — A to Z</div>
        <div class="chips">${others.map(chip).join('')}</div>` : `
        <div class="chips">${list.map(chip).join('')}${addChip}</div>`}

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
        </div>

        <label class="field" style="margin-top:16px"><span>Notes (optional)</span>
          <input type="text" id="dNotes" value="${esc(dr.notes)}" />
        </label>
        ${dr.isNew ? '' : `<button class="btn ghost" data-action="share-session">Share session message</button>`}
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
      session: { id, date: dr.date, reclub_fee: dr.reclub_fee, notes: dr.notes, location: dr.location, play_hours: Number(dr.play_hours) || 2 },
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
          <div class="small muted" style="margin-top:4px">Court fees are worked out and sent at the end of ${esc(monthWord)}.</div>
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
        <a class="brag-card" href="../" target="_blank" rel="noopener" aria-label="Open the club stats page">
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
    const low = balances.filter((b) => b.purchased && b.left <= 8);
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

    const membership = section('club-hours', 'Membership Balance',
      low.length ? `<span class="low-note">Low: ${low.map((b) => `${esc(b.name)} ${b.left}h`).join(', ')}</span>` : `${balances.length} members`, `
        <div class="list">
          ${balances.map((b) => {
            const pct = b.purchased ? Math.max(0, Math.min(100, (b.left / b.purchased) * 100)) : 0;
            const isLow = b.purchased && b.left <= 8;
            return `<div class="row"><div class="grow">
                <div class="title">${esc(b.name)}${b.active ? '' : ' <span class="muted small">(inactive)</span>'}</div>
                <div class="sub">used ${b.used}h of ${b.purchased}h · ${b.currentRate ? money(b.currentRate) : '—'}/h</div>
                <div class="bar ${isLow ? 'low' : ''}"><i style="width:${pct}%"></i></div>
              </div><div class="hours-left${isLow ? ' low' : ''}${b.left <= 0 ? ' out' : ''}"><b>${b.left}h</b><span>left</span></div></div>`;
          }).join('') || '<div class="row muted">No memberships yet.</div>'}
        </div>
        <button class="btn ghost" data-action="add-membership">＋ Record a membership purchase</button>`, true);

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
      ${membership}
      ${kittyBox}
      ${playersBox}
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

  function closeSheet() {
    state.draft = null;
    const el = $('#sheet');
    el.hidden = true;
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
      <div class="sheet-head"><button class="btn ghost" data-action="close-sheet">Close</button><h3>${esc(name)}</h3>
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

  function addMembership() {
    const members = state.data.players.filter((p) => p.role === 'member').map((p) => p.name);
    openForm('Membership purchase', `
      <label class="field"><span>Member</span><select name="member">${members.map((m) => `<option>${esc(m)}</option>`).join('')}</select></label>
      <label class="field"><span>Date bought</span><input type="date" name="date" value="${todayISO()}" /></label>
      <label class="field"><span>Amount paid</span><input type="number" inputmode="decimal" name="amount" required /></label>
      <label class="field"><span>Bookable hours</span><input type="number" inputmode="decimal" name="hours" required /></label>
      <label class="field"><span>Court rate per hour charged to the group</span><input type="number" inputmode="decimal" step="0.01" name="rate" placeholder="e.g. 140" required /></label>
      <label class="field"><span>Notes</span><input type="text" name="notes" /></label>
      <p class="small muted">New bookings use the oldest membership that still has hours, so old rates stay on old sessions.</p>`,
    (fd) => save('saveMembership', fd, 'Membership saved'));
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
    const a = t.dataset.action;
    const dr = state.draft;
    const d = state.data;

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
        save('setPaid', { month: t.dataset.month || state.month, person: t.dataset.person, paid, amount: Number(t.dataset.amount), paid_on: todayISO() },
          paid ? `${t.dataset.person} marked paid` : 'Unmarked').then(render);
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
      case 'add-membership': addMembership(); break;
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

  // Remember which glance tables are folded away (the toggle event doesn't bubble).
  document.addEventListener('toggle', (ev) => {
    const key = ev.target && ev.target.dataset ? ev.target.dataset.glance : '';
    if (key) store.set(`jpb.open.${key}`, ev.target.open ? '1' : '0');
  }, true);

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
})();
