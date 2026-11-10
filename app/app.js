/* Junk Pickleball manager app. Vanilla JS, no build step. Uses PB from billing.js. */
(function () {
  'use strict';

  const LS = {
    api: 'jpb.apiUrl',
    pin: 'jpb.pin',
    cache: 'jpb.cache',
    tab: 'jpb.tab',
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  const state = {
    apiUrl: (window.JPB_CONFIG && window.JPB_CONFIG.apiUrl) || store.get(LS.api) || '',
    pin: store.get(LS.pin) || '',
    raw: null,
    data: null,
    tab: store.get(LS.tab) || 'sessions',
    month: null,
    busy: false,
    draft: null,      // session being edited
    showAllSessions: false,
  };

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
        body: JSON.stringify({ pin: state.pin, action, payload }),
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
    if (e.code === 'pin') {
      store.del(LS.pin);
      state.pin = '';
      toast('Wrong PIN', true);
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
    if (!state.apiUrl || !state.pin) {
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
        <p class="small muted">One-time setup on this device. Ask Neil for the PIN.</p>
        ${window.JPB_CONFIG && window.JPB_CONFIG.apiUrl ? '' : `
        <label class="field"><span>Sheet API URL (ends in /exec)</span>
          <input type="text" id="setupUrl" value="${esc(state.apiUrl)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off" />
        </label>`}
        <label class="field"><span>PIN</span>
          <input type="tel" id="setupPin" inputmode="numeric" autocomplete="off" />
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

    return `
      ${low.length ? `<div class="warn-box">Membership hours running low: ${low.map((b) => `<b>${esc(b.name)}</b> ${b.left}h`).join(', ')}</div>` : ''}
      ${upcoming.length ? `<h2>Coming up</h2><div class="list">${upcoming.map(row).join('')}</div>` : ''}
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
      draft = {
        id, isNew: false, date: s.date, notes: s.notes, reclub_fee: s.reclub_fee,
        bookings,
        players: att.filter((a) => !a.guest).map((a) => a.name),
        guests: att.filter((a) => a.guest).map((a) => ({ name: a.name, pays: a.pays })),
        search: '',
      };
      // keep members who booked but are now inactive visible
      for (const m of Object.keys(bookings)) if (!members.includes(m)) members.push(m);
    } else {
      const date = todayISO();
      draft = {
        id: null, isNew: true, date, notes: '', reclub_fee: d.settings.reclub_fee,
        bookings: {}, players: [], guests: [], search: '',
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
          ${q && !list.some((p) => p.name.toLowerCase() === q) ? `<button class="chip" data-action="quick-add-player" data-name="${esc(dr.search.trim())}">＋ Add "${esc(dr.search.trim())}"</button>` : ''}
        </div>

        <h2>Guests <span class="pill">${dr.guests.length}</span></h2>
        ${dr.guests.map((g, i) => `
          <div class="guest-row">
            <input type="text" placeholder="Guest name" data-guest-name="${i}" value="${esc(g.name)}" />
            <select data-guest-pays="${i}">${payOptions(g.pays === g.name && g.name ? '__self' : g.pays)}</select>
            <button data-action="remove-guest" data-index="${i}" aria-label="Remove guest">✕</button>
          </div>`).join('')}
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dr.date)) return toast('Pick a date', true);
    for (const g of dr.guests) {
      if (!g.name.trim()) return toast('Every guest needs a name', true);
      if (!g.pays) return toast(`Who pays for ${g.name}?`, true);
    }
    const hours = Object.values(dr.bookings).reduce((s, b) => s + (Number(b.hours) || 0), 0);
    const heads = dr.players.length + dr.guests.length;
    if (!hours && !heads) return toast('Add court hours or players first', true);

    const dupe = d.sessions.find((s) => s.date === dr.date && s.id !== dr.id);
    if (dupe && dr.isNew && !window.confirm(`There's already a session on ${PB.dayLabel(dr.date)}. Save a second one?`)) return;

    const id = dr.id || PB.newSessionId(dr.date);
    const payload = {
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

    const paidPill = (entry, amount) => `
      <button class="pill ${entry.paid ? 'paid' : ''}" style="border:0;cursor:pointer" data-action="toggle-paid"
        data-person="${esc(entry.name)}" data-amount="${amount}" data-paid="${entry.paid ? 1 : 0}">
        ${entry.paid ? '✓ Paid' : 'Mark paid'}</button>`;

    const itemList = (items) => `<details class="items"><summary>${items.length} line${items.length === 1 ? '' : 's'}</summary><ul>${
      items.map((i) => `<li>${esc(PB.dayLabel(i.date))}: ${
        i.kind === 'booking' ? `booked ${i.hours}h (+${money(i.amount)})`
          : i.kind === 'guest' ? `guest ${esc(i.who)} ${money(i.amount)}` : money(i.amount)}</li>`).join('')}</ul></details>`;

    const playerCards = st.players.map((p) => `
      <div class="card">
        <div class="row" style="padding:0;border:0">
          <div class="grow"><div class="title">${esc(p.name)}</div>
            <div class="sub">${p.items.length} session${p.items.length === 1 ? '' : 's'}${p.guestCount ? ` · incl. ${p.guestCount} guest${p.guestCount > 1 ? 's' : ''}` : ''}</div></div>
          <div class="amount">${money(p.total)}</div>
        </div>
        ${itemList(p.items)}
        <div class="btn-row" style="margin-top:8px">
          ${paidPill(p, p.total)}
          <button class="btn ghost" data-action="send-player" data-person="${esc(p.name)}">Send bill</button>
        </div>
      </div>`).join('');

    const memberCards = st.members.map((m) => `
      <div class="card">
        <div class="row" style="padding:0;border:0">
          <div class="grow"><div class="title">${esc(m.name)} <span class="tag muted small">member</span></div>
            <div class="sub">booked ${money(m.credits)} − own fees ${money(m.charges)}</div></div>
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
      ${st.sessions.length ? `
      <div class="stats">
        <div class="stat"><div class="label">Collect from players</div><div class="value">${money(st.totals.players)}</div></div>
        <div class="stat"><div class="label">Pay back to members</div><div class="value">${money(st.totals.payback)}</div></div>
        <div class="stat"><div class="label">Court cost (${st.sessions.length} sessions)</div><div class="value">${money(st.totals.courtCost)}</div></div>
        <div class="stat"><div class="label">Players paid</div><div class="value">${paidCount}/${st.players.length}</div></div>
      </div>` : ''}

      ${st.players.length ? `<h2>Players</h2>${playerCards}
        <button class="btn secondary block" data-action="send-group">Share summary with the group</button>` : ''}
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
        <button class="btn" data-action="save-settings">Save settings</button>
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
    (fd) => save('savePlayer', {
      originalName: name || fd.name, name: fd.name.trim(), role: fd.role,
      active: fd.active === 'true', phone: fd.phone, notes: fd.notes,
    }, 'Player saved'));
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
        const pin = $('#setupPin').value.trim();
        if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) return toast('That URL should end in /exec', true);
        if (!pin) return toast('Enter the PIN', true);
        state.apiUrl = url; state.pin = pin;
        try {
          await api('load');
          store.set(LS.api, url); store.set(LS.pin, pin);
          toast('Connected');
          render();
        } catch (e) { state.pin = ''; handleError(e); }
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
      case 'quick-add-player': {
        const name = t.dataset.name;
        if (await save('savePlayer', { name, role: 'player', active: true }, `${name} added`)) {
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
        save('setPaid', { month: state.month, person: t.dataset.person, paid, amount: Number(t.dataset.amount) },
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
      case 'add-kitty': addKitty(); break;
      case 'delete-kitty':
        if (window.confirm('Remove this kitty entry?')) save('deleteKitty', { id: t.dataset.id }, 'Removed').then(render);
        break;
      case 'save-settings':
        save('saveSettings', {
          club_name: $('#sClub').value.trim(), default_rate: $('#sRate').value, reclub_fee: $('#sReclub').value,
          pay_to: $('#sPayTo').value.trim(), currency: $('#sCur').value.trim() || '$',
        }, 'Settings saved').then(render);
        break;
      case 'sign-out':
        if (window.confirm('Forget the PIN on this device?')) {
          store.del(LS.pin); store.del(LS.cache); state.pin = ''; state.data = null; render();
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
  render();
  if (state.apiUrl && state.pin) refresh(true);
})();
