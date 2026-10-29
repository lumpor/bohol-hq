'use strict';
// Bohol HQ: read-only status of Horny Mafia and King of Baboy, read from the Google Sheet.
// It never writes anything; the sheet only lets its secret code read.
const VERSION = '1.0.0';
const SYNC_URL = 'https://script.google.com/macros/s/AKfycbxirHkuj8XboiE062f8bNiOBo4W332M0Oje0RjVP6KSqI5r2fcltbeGKYdzxeX91smNbA/exec'; // the same Apps Script web app URL (…/exec) the two apps use

/* ---------- small helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round2 = n => Math.round(n * 100) / 100;
const sum = (arr, f = x => x) => arr.reduce((s, x) => s + f(x), 0);
const peso = n => {
  n = Math.round((n || 0) / 10) * 10; // nearest ₱10
  return (n < 0 ? '−₱' : '₱') + Math.abs(n).toLocaleString('en-PH');
};
const fmtChange = n => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n);

/* ---------- dates (stored as local 'YYYY-MM-DD' strings) ---------- */
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d || 1); };
const today = () => iso(new Date());
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return iso(d); };
const dayOfWeek = s => parseDate(s).getDay();
const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);
const monthOf = s => s.slice(0, 7);
const thisMonth = () => monthOf(today());
const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const fmtMonth = m => parseDate(m + '-01').toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });

/* ---------- Horny Mafia maths (copied from that app) ---------- */
// The copied code reads the global S; it is set to one user's data before each card is drawn.
let S = { borrowers: new Map(), loans: new Map(), payments: new Map(), tenants: new Map(), rent: new Map() };
const TYPE = { term: 'Fixed term', interest: 'Interest only' };
const FREQ = { daily: 'Daily (Mon–Sat)', weekly: 'Weekly' };
const bName = l => S.borrowers.get(l.borrowerId)?.name || '?';
const loansOf = bid => [...S.loans.values()].filter(l => l.borrowerId === bid).sort((a, b) => b.startDate.localeCompare(a.startDate));
const loanPayments = id => [...S.payments.values()].filter(p => p.loanId === id).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);

function nextCollectionDay(start, freq) {
  if (freq === 'weekly') return addDays(start, 7);
  let d = addDays(start, 1);
  if (dayOfWeek(d) === 0) d = addDays(d, 1);
  return d;
}

// Number of collection days from the first collection up to and including `upto`
// (capped at the last repay date for fixed-term loans). Daily loans skip Sundays.
function countDue(l, upto) {
  let end = upto;
  if (l.type === 'term' && l.endDate < end) end = l.endDate;
  if (!l.firstDue || end < l.firstDue) return 0;
  const days = daysBetween(l.firstDue, end) + 1;
  if (l.frequency === 'weekly') return Math.floor((days - 1) / 7) + 1;
  let c = Math.floor(days / 7) * 6;
  const dw = dayOfWeek(l.firstDue);
  for (let i = 0; i < days % 7; i++) if ((dw + i) % 7 !== 0) c++;
  return c;
}

// Date of the n-th collection (1 = first), skipping Sundays for daily loans.
function nthCollectionDay(firstDue, freq, n) {
  if (freq === 'weekly') return addDays(firstDue, 7 * (n - 1));
  let d = firstDue;
  if (dayOfWeek(d) === 0) d = addDays(d, 1);
  for (let i = 1; i < n; i++) { d = addDays(d, 1); if (dayOfWeek(d) === 0) d = addDays(d, 1); }
  return d;
}

// Fixed-term plan from either a last repay date or an amount per payment.
// Payments are whole ₱100s, so a date-based plan rounds the payment up and may finish a bit earlier.
function planTerm({ total, frequency, firstDue, mode, endDate, installment }) {
  if (!(total > 0) || !firstDue) return null;
  let inst = installment;
  if (mode === 'date') {
    if (!endDate || endDate < firstDue) return null;
    const n = countDue({ type: 'term', frequency, firstDue, endDate }, endDate);
    inst = Math.ceil(total / n / 100) * 100;
  }
  if (!(inst > 0)) return null;
  const n = Math.ceil(total / inst);
  return { installment: inst, n, endDate: nthCollectionDay(firstDue, frequency, n), last: total - inst * (n - 1) };
}
// Amount due per collection. For interest-only loans, `l.installment` is the interest on the full
// amount lent; it drops in proportion as the loan is paid back (rounded to ₱100, at least ₱100),
// counting only repayments made before day `d`.
function installment(l, d = '9999-12-31') {
  if (l.type !== 'interest') return l.installment || 0;
  const repaid = sum(loanPayments(l.id).filter(p => !isRegular(p) && p.date < d), p => p.amount);
  const left = l.principal - repaid;
  if (left <= 0) return 0;
  if (!repaid) return l.installment;
  return Math.max(100, Math.round(l.installment * left / l.principal / 100) * 100);
}

// Total that should have been paid by the end of day `upto`.
function expectedBy(l, upto) {
  if (l.type === 'term') return upto >= l.endDate ? l.total : Math.min(l.installment * countDue(l, upto), l.total);
  let total = 0;
  for (let d = l.firstDue; d <= upto; d = addDays(d, l.frequency === 'weekly' ? 7 : 1)) {
    if (l.frequency === 'weekly' || dayOfWeek(d) !== 0) total += installment(l, d);
  }
  return total;
}

const isRegular = p => p.kind !== 'principal';
function interestOf(p, l) {
  if (!l || !isRegular(p)) return 0;
  if (l.type === 'term') return l.total > 0 ? p.amount * (l.total - l.principal) / l.total : 0;
  return p.amount;
}

function loanStats(l) {
  const pays = loanPayments(l.id);
  const inst = installment(l);
  const paidRegular = round2(sum(pays.filter(isRegular), p => p.amount));
  const paidPrincipal = round2(sum(pays.filter(p => !isRegular(p)), p => p.amount));
  const behind = l.closed ? 0 : Math.max(0, round2(expectedBy(l, addDays(today(), -1)) - paidRegular));
  const remaining = l.type === 'term'
    ? Math.max(0, round2(l.total - paidRegular))
    : Math.max(0, round2(l.principal - paidPrincipal));
  return {
    pays, inst, paidRegular, paidPrincipal, behind, remaining,
    missed: inst > 0 ? Math.ceil(behind / inst - 0.001) : 0,
    lastPayment: pays.length ? pays[pays.length - 1].date : null,
    interestEarned: round2(sum(pays, p => interestOf(p, l))),
    // principal still out on the street
    principalOut: l.type === 'term' ? (l.total > 0 ? remaining * l.principal / l.total : 0) : remaining,
  };
}
const rentId = (tid, m) => `${tid}|${m}`;
const tenantInMonth = (t, m) => monthOf(t.startDate) <= m && (!t.endDate || m <= monthOf(t.endDate));

/* ---------- state ---------- */
// The secret code and the last data are kept in this browser only, so the app opens offline.
const ls = {
  get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const UI = { period: thisMonth(), loading: false, error: null, installEvt: null };
let key = ls.get('hqKey') || '';
let cache = ls.get('hqCache'); // { at, users: [{ app, name, data }] }

async function refresh() {
  if (!key || UI.loading) return;
  UI.loading = true; UI.error = null; render();
  try {
    const r = await fetch(SYNC_URL, { method: 'POST', body: JSON.stringify({ action: 'pullAll', key }) });
    const j = await r.json();
    if (!j.ok) {
      if (j.error === 'wrong secret code') { key = ''; ls.set('hqKey', ''); throw new Error('Wrong code. Try again.'); }
      throw new Error(j.error || 'Could not read the sheet');
    }
    cache = { at: new Date().toISOString(), users: j.users };
    ls.set('hqCache', cache);
  } catch (err) {
    UI.error = navigator.onLine ? err.message : 'No internet right now';
  } finally {
    UI.loading = false;
    render();
  }
}

/* ---------- cards ---------- */
const inPeriod = d => UI.period === 'all' || monthOf(d) === UI.period;
const fact = (label, value, cls = '') => `<div><small>${label}</small><b class="${cls}">${value}</b></div>`;
const fmtDay = s => parseDate(s).toLocaleDateString('en-PH', { weekday: 'short', day: 'numeric', month: 'short' });

// Transactions as rows { date, order, what, detail, amount (+ in, − out) }, newest first.
function txLog(rows, title = 'Transactions') {
  if (!rows.length) return '';
  rows.sort((a, b) => b.date.localeCompare(a.date) || (b.order || 0) - (a.order || 0));
  let html = '', day = null;
  for (const r of rows) {
    if (r.date !== day) {
      if (day) html += '</div>';
      day = r.date;
      html += `<div class="day">${fmtDay(r.date)}</div><div class="list">`;
    }
    html += `<div class="item"><div class="item-main"><b>${r.what}</b>${r.detail ? `<small>${r.detail}</small>` : ''}</div>
      ${r.amount ? `<span class="amt ${r.amount > 0 ? 'ok' : ''}">${r.amount > 0 ? '+' : '−'}${peso(Math.abs(r.amount))}</span>` : ''}</div>`;
  }
  return `<details><summary>${title} (${rows.length})</summary>${html}</div></details>`;
}

function hmCard(u) {
  const toMap = list => new Map((list || []).map(o => [o.id, o]));
  S = { borrowers: toMap(u.data.borrowers), loans: toMap(u.data.loans), payments: toMap(u.data.payments), tenants: toMap(u.data.tenants), rent: toMap(u.data.rent) };
  const pays = [...S.payments.values()].filter(p => inPeriod(p.date));
  const interest = sum(pays, p => interestOf(p, S.loans.get(p.loanId)));
  const lent = [...S.loans.values()].filter(l => inPeriod(l.startDate));
  const active = [...S.loans.values()].filter(l => !l.closed).map(l => ({ l, st: loanStats(l) }));
  const behind = active.filter(x => x.st.behind > 0).sort((a, b) => b.st.behind - a.st.behind);
  const rm = UI.period === 'all' ? thisMonth() : UI.period;
  const tenants = [...S.tenants.values()].filter(t => tenantInMonth(t, rm));
  const paid = tenants.filter(t => S.rent.has(rentId(t.id, rm)));
  const unpaid = tenants.filter(t => !S.rent.has(rentId(t.id, rm)));
  const rentPaid = sum(paid, t => S.rent.get(rentId(t.id, rm)).amount);
  const rentDue = sum(tenants, t => S.rent.get(rentId(t.id, rm))?.amount ?? t.rent);
  return `<div class="card">
    <div class="who"><b>${esc(u.name)}</b><span class="badge">Horny Mafia</span></div>
    <div class="facts">
      ${fact('Lent', `${peso(sum(lent, l => l.principal))} <small>(${lent.length})</small>`)}
      ${fact('Collected', peso(sum(pays, p => p.amount)))}
      ${fact('Interest earned', peso(interest), 'ok')}
      ${fact('Active loans', active.length)}
      ${fact('Lent out now', peso(sum(active, x => x.st.principalOut)))}
      ${fact('Still to collect', peso(sum(active, x => x.st.remaining)))}
      ${fact('Behind now', peso(sum(behind, x => x.st.behind)), behind.length ? 'bad' : 'ok')}
      ${fact(`Rent ${fmtMonth(rm).split(' ')[0]}`, `${peso(rentPaid)} <small>of ${peso(rentDue)}</small>`, unpaid.length ? '' : 'ok')}
    </div>
    ${behind.length ? `<details><summary>Behind on payments (${behind.length})</summary><div class="list">
      ${behind.map(x => `<div class="item"><div class="item-main"><b>${esc(bName(x.l))}</b>
        <small>${x.st.missed} missed · last paid ${x.st.lastPayment || 'never'}</small></div><span class="amt bad">${peso(x.st.behind)}</span></div>`).join('')}</div></details>` : ''}
    ${unpaid.length ? `<details><summary>Rent not paid (${unpaid.length})</summary><div class="list">
      ${unpaid.map(t => `<div class="item"><div class="item-main"><b>${esc(t.name)}</b><small>pay day ${t.payDay}</small></div><span class="amt">${peso(t.rent)}</span></div>`).join('')}</div></details>` : ''}
    ${active.length ? `<details open><summary>Current loans (${active.length})</summary><div class="list">
      ${active.sort((a, b) => bName(a.l).localeCompare(bName(b.l))).map(({ l, st }) => `<div class="item"><div class="item-main"><b>${esc(bName(l))}</b>
        <small>${peso(l.principal)} lent ${fmtDay(l.startDate)} · ${TYPE[l.type]}, ${peso(st.inst)} ${l.frequency === 'weekly' ? 'a week' : 'a day'}</small>
        <small>${l.type === 'term' ? `${peso(st.paidRegular)} of ${peso(l.total)} paid · ends ${fmtDay(l.endDate)}` : `${peso(st.interestEarned)} interest paid so far`}</small>
        ${st.behind > 0 ? `<small class="bad">Behind ${peso(st.behind)} (${st.missed} missed)</small>` : ''}</div>
        <span class="amt">${peso(st.remaining)}<br><small class="muted">${l.type === 'term' ? 'to pay' : 'owed'}</small></span></div>`).join('')}</div></details>` : ''}
    ${txLog([
      ...[...S.loans.values()].filter(l => inPeriod(l.startDate)).map(l => ({ date: l.startDate, order: l.createdAt, what: esc(bName(l)),
        amount: -l.principal, detail: `New loan · ${TYPE[l.type]}${l.type === 'term' ? `, pays back ${peso(l.total)}` : ''}` })),
      // part of an interest-only loan paid back
      ...[...S.payments.values()].filter(p => p.kind === 'principal' && inPeriod(p.date)).map(p => {
        const l = S.loans.get(p.loanId);
        return { date: p.date, order: p.createdAt, what: esc(l ? bName(l) : '?'), amount: p.amount, detail: 'Paid back part of the loan' };
      }),
      ...[...S.loans.values()].filter(l => l.closed && l.closedOn && inPeriod(l.closedOn)).map(l => ({ date: l.closedOn, order: 1e15, what: esc(bName(l)),
        detail: l.autoClosed ? `Loan of ${peso(l.principal)} fully paid back` : `Loan of ${peso(l.principal)} closed` })),
      ...[...S.tenants.values()].filter(t => inPeriod(t.startDate)).map(t => ({ date: t.startDate, order: 0, what: esc(t.name),
        detail: `New boarder · ${peso(t.rent)} a month` })),
      ...[...S.tenants.values()].filter(t => t.endDate && inPeriod(t.endDate)).map(t => ({ date: t.endDate, order: 0, what: esc(t.name),
        detail: t.endDate > today() ? 'Moves out' : 'Moved out' })),
    ], 'Loans and boarders')}
  </div>`;
}

const SIZES = { gamay: 'Gamay', tunga: 'Tunga-tunga', dako: 'Dako' };
function baboyCard(u) {
  const all = u.data.entries || [];
  const list = all.filter(e => inPeriod(e.date));
  const by = (kind, f) => sum(list.filter(e => e.kind === kind), f);
  const sold = by('sell', e => e.total), bought = by('buy', e => e.total);
  const feed = by('feed', e => e.total), gas = by('gas', e => e.total), other = by('other', e => e.total);
  const spent = bought + feed + gas + other;
  const nSold = by('sell', e => e.count), nBought = by('buy', e => e.count);
  const startCount = (u.data.settings || []).find(x => x.id === 'startCount')?.value || 0;
  const now = startCount + sum(all, e => (e.kind === 'buy' ? e.count : e.kind === 'sell' ? -e.count : 0));
  const sizes = kind => Object.entries(SIZES).map(([k, label]) => [label, sum(list.filter(e => e.kind === kind && e.size === k), e => e.count)])
    .filter(([, n]) => n).map(([label, n]) => `${n} ${label}`).join(', ');
  const others = list.filter(e => e.kind === 'other');
  return `<div class="card">
    <div class="who"><b>${esc(u.name)}</b><span class="badge baboy">King of Baboy</span></div>
    <div class="facts">
      ${fact('Sold', `${peso(sold)} <small>(${nSold})</small>`)}
      ${fact('Spent', peso(spent))}
      ${fact('Profit', peso(sold - spent), sold - spent < 0 ? 'bad' : 'ok')}
      ${fact('Baboy change', `${fmtChange(nBought - nSold)} <small>(${nBought} in, ${nSold} out)</small>`)}
      ${fact('Baboy now', now)}
      ${fact('Feed', `${peso(feed)} <small>(${round2(by('feed', e => e.kilos))} kg)</small>`)}
    </div>
    <details><summary>Spending and sizes</summary><div class="card inner"><div class="facts">
      ${fact('Baboy bought', peso(bought))}
      ${fact('Gasolina', peso(gas))}
      ${fact('Other', peso(other))}
      ${fact('Sold sizes', sizes('sell') || '—')}
      ${fact('Bought sizes', sizes('buy') || '—')}
    </div>
    ${others.length ? `<p><small>Other: ${others.map(e => `${esc(e.what)} ${peso(e.total)}`).join(', ')}</small></p>` : ''}</div></details>
    ${txLog(list.map(e => ({
      date: e.date, order: e.createdAt, amount: e.kind === 'sell' ? e.total : -e.total,
      what: { buy: 'Bought baboy', sell: 'Sold baboy', feed: 'Bought feed', gas: 'Gasolina', other: esc(e.what) }[e.kind],
      detail: [e.count ? `${e.count} ${SIZES[e.size] || ''}` : '', e.kind === 'feed' ? `${e.kilos} kg` : '', esc(e.notes || '')].filter(Boolean).join(' · '),
    })))}
  </div>`;
}

/* ---------- page ---------- */
function render() {
  const view = $('#view');
  if (!key) {
    view.innerHTML = `<form class="card" data-form="connect"><b>Connect to the sheet</b>
      <p><small>Enter the Bohol HQ code. You only do this once.</small></p>
      <label class="field"><input name="code" type="password" autocomplete="current-password" autocapitalize="none" placeholder="Code" required></label>
      <button class="btn block" type="submit" ${UI.loading ? 'disabled' : ''}>${UI.loading ? 'Connecting…' : 'Connect'}</button>
      ${UI.error ? `<p class="bad"><small>${esc(UI.error)}</small></p>` : ''}</form>`;
    return;
  }
  const users = cache?.users || [];
  const p = UI.period;
  const updated = cache ? new Date(cache.at).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : 'never';
  const section = (app, title, card) => {
    const us = users.filter(u => u.app === app);
    return us.length ? `<h2>${title}</h2>${us.map(card).join('')}` : '';
  };
  view.innerHTML = `
    <div class="datenav">
      <button class="btn ghost" data-act="prev" ${p === 'all' ? 'disabled' : ''} aria-label="Previous month">‹</button>
      <div class="period">${p === 'all' ? 'All time' : fmtMonth(p)}</div>
      <button class="btn ghost" data-act="next" ${p === 'all' || p >= thisMonth() ? 'disabled' : ''} aria-label="Next month">›</button>
    </div>
    <div class="btns" style="margin-top:0">
      <button class="btn ${p === 'all' ? '' : 'ghost'}" data-act="toggleAll">${p === 'all' ? 'Show this month' : 'Show all time'}</button>
      <button class="btn ghost" data-act="refresh" ${UI.loading ? 'disabled' : ''}>${UI.loading ? 'Loading…' : 'Refresh'}</button>
    </div>
    <p class="muted" style="margin:0 4px 8px"><small>Updated ${updated}${UI.error ? ` · <span class="bad">${esc(UI.error)}</span>` : ''}</small></p>
    ${section('horny-mafia', 'Horny Mafia', hmCard)}
    ${section('king-of-baboy', 'King of Baboy', baboyCard)}
    ${users.length ? '' : `<div class="card"><small>${UI.loading ? 'Loading…' : 'No data yet.'}</small></div>`}`;
}

const ACT = {
  prev: () => { UI.period = addMonths(UI.period, -1); render(); },
  next: () => { UI.period = addMonths(UI.period, 1); render(); },
  toggleAll: () => { UI.period = UI.period === 'all' ? thisMonth() : 'all'; render(); },
  refresh: () => refresh(),
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (el && ACT[el.dataset.act]) { e.preventDefault(); ACT[el.dataset.act](); }
});

document.addEventListener('submit', e => {
  if (e.target.dataset.form !== 'connect') return;
  e.preventDefault();
  key = new FormData(e.target).get('code').trim();
  ls.set('hqKey', key);
  refresh();
});

// A setup link (…/#setup/<secret code>) stores the read-only code in this browser.
function handleSetupLink() {
  const m = location.hash.match(/^#setup\/(.+)$/);
  if (!m) return;
  key = decodeURIComponent(m[1]);
  ls.set('hqKey', key);
  history.replaceState(null, '', location.pathname);
}
window.addEventListener('hashchange', () => { handleSetupLink(); refresh(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('online', () => refresh());

handleSetupLink();
render();
refresh();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
