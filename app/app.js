/* Junk Pickleball manager app. Vanilla JS, no build step. Uses PB from billing.js. */
(function () {
  'use strict';

  const LS = {
    api: 'jpb.apiUrl',
    code: 'jpb.code',
    cache: 'jpb.cache',
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

  function inviteLink() {
    const params = new URLSearchParams();
    params.set('k', state.code);
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

  function render() {
    document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    const view = $('#view');
    if (!state.apiUrl || !state.code) {
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
    const upcoming = sessions.filter((s) => s.date > today).reverse();
    const past = sessions.filter((s) => s.date <= today);
    const shown = state.showAllSessions ? past : past.slice(0, 15);

    const row = (s) => {
      const sum = PB.sessionSummary(d, s, idx);
      const who = sum.bookings.map((b) => `${b.member}${b.hours !== 1 ? ' ×' + b.hours : ''}`).join(', ');
      const sub = sum.heads
        ? `${sum.heads} players · ${money(sum.cpp)} each · ${sum.hours}h`
        : `${sum.hours}h booked${who ? ' (' + who + ')' : ''} · no players yet`;
      return `
        <button class="row" data-action="edit-session" data-id="${esc(s.id)}">
          <div class="grow">
            <div class="title">${esc(PB.dayLabel(s.date, true))}</div>
            <div class="sub">${esc(sub)}</div>
          </div>
          ${sum.heads ? '' : '<span class="pill warn">To fill</span>'}
        </button>`;
    };

    const balances = PB.membershipBalances(d).filter((b) => b.active);
    const low = balances.filter((b) => b.purchased && b.left <= 8);

    let skipped = [];
    try { skipped = JSON.parse(store.get(LS.notRegular) || '[]'); } catch (e) { skipped = []; }
    const suggestions = PB.regularSuggestions(d).filter((g) => !skipped.includes(g.name)).slice(0, 3);
    const suggestionCards = suggestions.length ? `
      <h2>Guests who keep coming</h2>
      <div class="list">${suggestions.map((g) => `
        <div class="row">
          <div class="grow"><div class="title">${esc(g.name)}</div>
            <div class="sub">${g.count} visits${g.pays !== g.name ? ` · with ${esc(g.pays)}` : ''}</div></div>
          <button class="btn secondary compact" data-action="promote-guest" data-name="${esc(g.name)}">Make a regular</button>
          <button class="icon-btn muted" data-action="skip-regular" data-name="${esc(g.name)}" aria-label="Not now" title="Not now">✕</button>
        </div>`).join('')}</div>` : '';

    return `
      ${low.length ? `<div class="warn-box">Membership hours running low: ${low.map((b) => `<b>${esc(b.name)}</b> ${b.left}h`).join(', ')}</div>` : ''}
      ${upcoming.length ? `<h2>Coming up</h2><div class="list">${upcoming.map(row).join('')}</div>` : ''}
      ${suggestionCards}
      <h2>Sessions</h2>
      ${past.length ? `<div class="list">${shown.map(row).join('')}</div>` : '<div class="empty">No sessions yet.</div>'}
      ${past.length > shown.length ? '<button class="btn ghost block" data-action="show-all">Show all sessions</button>' : ''}
      <button class="fab" data-action="new-session">＋ Session</button>`;
  }

  // ------------------------------------------------------------ Session editor

  function openSession(id) {
    const d = state.data;
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
    return { hours, cost, heads, cpp };
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
    const list = active
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .sort((a, b) => (freq.get(b.name) || 0) - (freq.get(a.name) || 0) || a.name.localeCompare(b.name));

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

        <h2>Courts booked</h2>
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
        <div class="chips">
          ${list.map((p) => `<button class="chip${dr.players.includes(p.name) ? ' on' : ''}" data-action="toggle-player" data-name="${esc(p.name)}">${esc(p.name)}${p.role === 'member' ? '<span class="tag">★</span>' : ''}</button>`).join('')}
          ${q && !PB.playerNamed(d, dr.search) ? `<button class="chip" data-action="quick-add-player" data-name="${esc(dr.search.trim())}">＋ Add "${esc(dr.search.trim())}"</button>` : ''}
        </div>

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
          <span class="muted">${sum.hours}h · court ${money(sum.cost)}</span></div>
        <button class="btn" data-action="save-session">Save</button>
      </div></div>`;
    el.hidden = false;
    el.scrollTop = scroll;
    document.body.style.overflow = 'hidden';
  }

  function updateSheetFooter() {
    const sum = draftSummary();
    const s = $('#sheet .summary');
    if (s) s.innerHTML = `<b>${sum.heads} players · ${money(sum.cpp)} each</b><br><span class="muted">${sum.hours}h · court ${money(sum.cost)}</span>`;
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
      session: { id, date: dr.date, reclub_fee: dr.reclub_fee, notes: dr.notes },
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
    const s = d.settings;

    const paidPill = (entry, amount) => {
      const changed = entry.paid && Math.abs(entry.paid.amount - amount) > 0.01;
      return `
      <button class="pill ${entry.paid ? (changed ? 'warn' : 'paid') : ''}" style="border:0;cursor:pointer" data-action="toggle-paid"
        data-person="${esc(entry.name)}" data-amount="${amount}" data-paid="${entry.paid ? 1 : 0}">
        ${entry.paid ? (changed ? `Paid ${money(entry.paid.amount)} · bill changed` : '✓ Paid') : 'Mark paid'}</button>`;
    };

    const owing = PB.outstanding(d, state.month);
    const owingBox = owing.length ? `<div class="warn-box"><b>Still unpaid from earlier months</b><ul>${
      owing.map((o) => `<li>${esc(o.name)} — ${money(o.amount)} (${esc(PB.monthLabel(o.month))})</li>`).join('')}</ul></div>` : '';

    const itemList = (items) => `<details class="items"><summary>${items.length} line${items.length === 1 ? '' : 's'}</summary><ul>${
      items.map((i) => `<li>${esc(PB.dayLabel(i.date))}: ${
        i.kind === 'booking' ? `booked ${i.hours}h (+${money(i.amount)})`
          : i.kind === 'guest' ? `guest ${esc(i.who)} ${money(i.amount)}` : money(i.amount)}</li>`).join('')}</ul></details>`;

    const guestNote = (entry) => entry.guests.map((g) => `${esc(g.name)} ${money(g.amount)}`).join(', ');
    const playerCard = (p) => `
      <div class="card">
        <div class="row" style="padding:0;border:0">
          <div class="grow"><div class="title">${esc(p.name)}${p.isGuest ? ' <span class="pill">guest</span>' : ''}</div>
            <div class="sub">${p.games} game${p.games === 1 ? '' : 's'}${p.guests.length ? ` · incl. ${guestNote(p)}` : ''}</div></div>
          <div class="amount">${money(p.total)}</div>
        </div>
        ${itemList(p.items)}
        <div class="btn-row" style="margin-top:8px">
          ${paidPill(p, p.total)}
          <button class="btn ghost" data-action="send-player" data-person="${esc(p.name)}">Send bill</button>
        </div>
      </div>`;
    const regularCards = st.players.filter((p) => !p.isGuest).map(playerCard).join('');
    const guestCards = st.players.filter((p) => p.isGuest).map(playerCard).join('');

    const memberCards = st.members.map((m) => `
      <div class="card">
        <div class="row" style="padding:0;border:0">
          <div class="grow"><div class="title">${esc(m.name)} <span class="tag muted small">member</span></div>
            <div class="sub">booked ${money(m.credits)} − court fees ${money(m.charges)}${m.guests.length ? ` (incl. ${guestNote(m)})` : ''}</div></div>
          <div class="amount ${m.payback < 0 ? 'neg' : ''}">${m.payback < 0 ? 'owes ' + money(-m.payback) : money(m.payback)}</div>
        </div>
        ${itemList(m.items)}
        <div class="btn-row" style="margin-top:8px">
          ${paidPill(m, m.payback)}
          <button class="btn ghost" data-action="send-member" data-person="${esc(m.name)}">Send payback</button>
        </div>
      </div>`).join('');

    const r = st.reclub;
    const warnings = st.warnings.length
      ? `<div class="warn-box"><b>Check before sending</b><ul>${st.warnings.map((w) => `<li>${esc(w.text)}</li>`).join('')}</ul></div>` : '';

    const paidCount = st.players.filter((p) => p.paid).length;

    return `
      <div class="month-nav">
        <button data-action="month" data-delta="-1" aria-label="Previous month">‹</button>
        <strong>${esc(PB.monthLabel(state.month))}</strong>
        <button data-action="month" data-delta="1" aria-label="Next month">›</button>
      </div>
      ${st.sessions.length ? '' : '<div class="empty">No sessions this month.</div>'}
      ${warnings}
      ${owingBox}
      ${st.sessions.length ? `
      <div class="stats">
        <div class="stat"><div class="label">Collect from players</div><div class="value">${money(st.totals.players)}</div></div>
        <div class="stat"><div class="label">Pay back to members</div><div class="value">${money(st.totals.payback)}</div></div>
        <div class="stat"><div class="label">Court cost (${st.sessions.length} sessions)</div><div class="value">${money(st.totals.courtCost)}</div></div>
        <div class="stat"><div class="label">Players paid</div><div class="value">${paidCount}/${st.players.length}</div></div>
      </div>` : ''}

      ${regularCards ? `<h2>Regulars</h2>${regularCards}` : ''}
      ${guestCards ? `<h2>Guests paying their own way</h2>${guestCards}` : ''}
      ${st.sessions.length ? '<button class="btn secondary block" data-action="send-group">Share summary with the group</button>' : ''}
      ${st.members.length ? `<h2>Members — payback from ${esc(s.pay_to || 'Tommy')}</h2>${memberCards}` : ''}
      ${r ? `<h2>Reclub</h2>
        <div class="card">
          <div class="row" style="padding:0;border:0"><div class="grow">${r.heads} Reclub players × ${money(d.settings.reclub_fee)}</div><div class="amount">${money(r.income)}</div></div>
          <div class="row" style="padding:4px 0 0;border:0"><div class="grow muted">Their share of court cost</div><div class="amount">−${money(r.courtShare)}</div></div>
          <div class="row" style="padding:4px 0 0;border:0"><div class="grow"><b>Into the kitty</b></div><div class="amount">${money(r.profit)}</div></div>
        </div>` : ''}
      ${st.sessions.length ? `<p class="small muted center">Check: ${st.totals.balanced ? '✓ every court dollar is allocated' : '⚠ totals don\'t match court cost'}${Math.abs(st.totals.roundingDiff) >= 0.01 ? ` (rounding ${money(st.totals.roundingDiff)})` : ''}</p>` : ''}`;
  }

  // ------------------------------------------------------------ Club tab

  function renderClub() {
    const d = state.data;
    const balances = PB.membershipBalances(d);
    const kitty = PB.kitty(d);
    const players = [...d.players].sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));

    return `
      <h2>Membership hours</h2>
      <div class="list">
        ${balances.map((b) => {
          const pct = b.purchased ? Math.max(0, Math.min(100, (b.left / b.purchased) * 100)) : 0;
          return `<div class="row"><div class="grow">
              <div class="title">${esc(b.name)}${b.active ? '' : ' <span class="muted small">(inactive)</span>'}</div>
              <div class="sub">${b.used}h used of ${b.purchased}h · rate ${b.currentRate ? money(b.currentRate) : '—'}/h</div>
              <div class="bar ${b.left <= 8 ? 'low' : ''}"><i style="width:${pct}%"></i></div>
            </div><div class="amount ${b.left <= 0 ? 'neg' : ''}">${b.left}h left</div></div>`;
        }).join('') || '<div class="row muted">No memberships yet.</div>'}
      </div>
      <button class="btn ghost" data-action="add-membership">＋ Record a membership purchase</button>

      <h2>Kitty</h2>
      <div class="card">
        <div class="row" style="padding:0;border:0"><div class="grow"><b>Balance</b></div><div class="amount ${kitty.balance < 0 ? 'neg' : ''}">${money(kitty.balance)}</div></div>
        <div class="sub muted small">Reclub profit ${money(kitty.reclubProfit)} · spending ${money(kitty.entriesTotal)}</div>
        ${kitty.entries.length ? `<details class="items"><summary>${kitty.entries.length} entries</summary><ul>${kitty.entries.map((k) =>
          `<li>${esc(k.date)} ${esc(k.description)} ${money(k.amount)} <button class="btn ghost small" data-action="delete-kitty" data-id="${esc(k.id)}">remove</button></li>`).join('')}</ul></details>` : ''}
        <button class="btn ghost" data-action="add-kitty">＋ Add spending (balls etc.)</button>
      </div>

      <h2>Players</h2>
      <div class="list">
        ${players.map((p) => `
          <button class="row" data-action="edit-player" data-name="${esc(p.name)}">
            <div class="grow"><div class="title">${esc(p.name)} ${p.role === 'member' ? '<span class="pill">member</span>' : ''}</div>
              <div class="sub">${p.active ? 'active' : 'inactive'}${p.phone ? ' · ' + esc(p.phone) : ''}</div></div>
          </button>`).join('')}
      </div>
      <button class="btn ghost" data-action="edit-player" data-name="">＋ Add player</button>

      <h2>Settings</h2>
      <div class="card">
        <label class="field"><span>Club name</span><input type="text" id="sClub" value="${esc(d.settings.club_name)}" /></label>
        <label class="field"><span>Default court rate per hour (used when a member has no membership on file)</span><input type="number" inputmode="decimal" id="sRate" value="${esc(d.settings.default_rate)}" /></label>
        <label class="field"><span>Reclub fee per player (new sessions)</span><input type="number" inputmode="decimal" id="sReclub" value="${esc(d.settings.reclub_fee)}" /></label>
        <label class="field"><span>Who collects money</span><input type="text" id="sPayTo" value="${esc(d.settings.pay_to)}" /></label>
        <label class="field"><span>Currency symbol</span><input type="text" id="sCur" value="${esc(d.settings.currency)}" /></label>
        <label class="field"><span>Public stats page (first names and dates played only — no money)</span><select id="sStats">
          <option value="TRUE"${String(d.settings.public_stats).toUpperCase() === 'TRUE' ? ' selected' : ''}>On — anyone with the link can see it</option>
          <option value="FALSE"${String(d.settings.public_stats).toUpperCase() === 'TRUE' ? '' : ' selected'}>Off</option></select></label>
        <button class="btn" data-action="save-settings">Save settings</button>
      </div>
      <h2>Share</h2>
      <div class="card">
        <p class="small muted" style="margin-top:0">The invite link signs another phone in with one tap. It gives full access, so only send it to people who run the club.</p>
        <div class="btn-row">
          <button class="btn secondary" data-action="share-invite">Send invite link</button>
          <a class="btn ghost" href="../" target="_blank" rel="noopener">Open stats page</a>
        </div>
      </div>
      <p class="small muted center">Data from the Google Sheet · loaded ${esc((state.raw && state.raw.loaded_at || '').replace('T', ' ').slice(0, 16))}<br>
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
      case 'show-all': state.showAllSessions = true; render(); break;
      case 'new-session': openSession(null); break;
      case 'edit-session': openSession(t.dataset.id); break;
      case 'close-sheet': closeSheet(); break;
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
        save('setPaid', { month: state.month, person: t.dataset.person, paid, amount: Number(t.dataset.amount), paid_on: todayISO() },
          paid ? `${t.dataset.person} marked paid` : 'Unmarked').then(render);
        break;
      }
      case 'send-player': case 'send-member': {
        const st = PB.monthStatement(d, state.month);
        const p = d.players.find((x) => x.name === t.dataset.person);
        const entry = (a === 'send-player' ? st.players : st.members).find((x) => x.name === t.dataset.person);
        if (!entry) return;
        const text = a === 'send-player' ? PB.playerMessage(entry, state.month, d.settings) : PB.memberMessage(entry, state.month, d.settings);
        sendText(text, p && p.phone);
        break;
      }
      case 'send-group': sendText(PB.groupMessage(PB.monthStatement(d, state.month), d.settings)); break;
      case 'edit-player': editPlayer(t.dataset.name); break;
      case 'add-membership': addMembership(); break;
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
