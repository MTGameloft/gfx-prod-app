/* ============================================================================
   views/people.js — the roster, skills coverage, 1:1s and development goals.

   Everything here is people data. It lives in this browser only. Nothing is
   sent anywhere, and the export is a file you control.
   ========================================================================= */

import * as S from '../store.js';
import {
  h, raw, esc, icon, avatar, toast, dialog, formDlg, confirmDlg, menu, acts, bar,
  fmtDate, fmtMoney, fmtMoneyFull, today, download, toCsv, parseCsv, pickFile,
  sum, groupBy, clamp, initials, hashColor,
} from '../ui.js';
import { personPage, personActions, TABS, logOneToOne } from '../personpage.js';
import { capacity, leaveUsed, leaveDaysInMonth, thisMonth, rateFor, taskStats,
         SENIORITY, CONTRACT } from '../calc.js';
import { divisionLabel } from '../jira.js';

// SENIORITY and CONTRACT now come from calc.js — see the import above.

const MOODS = [
  { id: 'good', label: 'Good', chip: 'ok' },
  { id: 'neutral', label: 'Neutral', chip: '' },
  { id: 'concerned', label: 'Concerned', chip: 'warn' },
  { id: 'flight-risk', label: 'Flight risk', chip: 'risk' },
];

const UI_KEY = 'gfxprod.ui.people';
const ui = Object.assign({ mode: 'roster', division: '', contract: '', q: '' },
                         JSON.parse(localStorage.getItem(UI_KEY) || '{}'));
const saveUi = () => localStorage.setItem(UI_KEY, JSON.stringify(ui));

const roster = () => {
  const q = ui.q.trim().toLowerCase();
  return S.get().people.filter(p =>
    (!ui.division || p.division === ui.division) &&
    (!ui.contract || p.contract === ui.contract) &&
    (!q || `${p.name} ${p.role} ${p.email || ''}`.toLowerCase().includes(q)));
};

const allocTotal = p => sum(p.alloc || [], a => a.pct);

/* ---------- roster ------------------------------------------------------- */

function rosterTable(list) {
  const s = S.get();
  const ym = thisMonth();
  const byDiv = groupBy(list, p => p.division || '—');
  const order = s.divisions.map(d => d.id).filter(d => byDiv[d]).concat(Object.keys(byDiv).filter(k => !s.divisions.some(d => d.id === k)));

  return h`
  <div class="card"><div class="tbl-wrap"><table class="tbl">
    <thead><tr>
      <th>Person</th><th>Role</th><th>Contract</th><th>Allocation</th>
      <th class="num">Leave used</th><th class="num">Away this month</th><th class="num">Cost / mo</th><th></th>
    </tr></thead>
    <tbody>${raw(order.map(dv => {
      const div = S.byId(s.divisions, dv);
      const rows = byDiv[dv];
      return `<tr class="divhead"><td colspan="8" style="background:var(--bg-sunken);font-weight:700;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;padding:5px 12px">
          <span class="pill-div" style="background:${div?.color || 'var(--muted)'}">${esc(dv)}</span>
          <span class="mute" style="margin-left:7px">${esc(div?.name || '')} · ${rows.length} ${rows.length === 1 ? 'person' : 'people'}</span>
        </td></tr>` +
        rows.map(p => {
          const tot = allocTotal(p);
          const used = leaveUsed(p.id);
          const away = leaveDaysInMonth(p.id, ym);
          const cost = p.costMonthly || rateFor(p.seniority);
          return `<tr data-id="${p.id}">
            <td data-act="open" style="cursor:pointer">
              <div class="row" style="gap:8px">
                <span class="avatar sm" style="background:${hashColor(p.name)}">${esc(initials(p.name))}</span>
                <div><div class="strong">${esc(p.name)}${p.isMe ? ' <span class="chip accent">you</span>' : ''}</div>
                     <div class="tiny mute">${esc(p.email || '')}</div></div>
              </div></td>
            <td class="tiny">${esc(p.role)}<div class="mute">${esc(p.seniority)}</div></td>
            <td><span class="chip ${p.contract === 'outsource' ? 'warn' : p.contract === 'contract' ? 'info' : ''}">${esc(p.contract)}</span></td>
            <td style="min-width:170px">
              <div class="row tiny" style="gap:5px;flex-wrap:wrap">${(p.alloc || []).map(a => {
                const pr = S.byId(s.projects, a.projectId);
                return pr ? `<span class="chip" style="background:${pr.color}22;color:${pr.color}">${esc(pr.code)} ${a.pct}%</span>` : '';
              }).join('') || '<span class="mute">unallocated</span>'}</div>
              ${tot !== 100 && (p.alloc || []).length ? `<div class="tiny ${tot > 100 ? 'overdue' : 'mute'}">${tot}% total</div>` : ''}
            </td>
            <td class="num tiny">${used} / ${p.leaveAllowance ?? 15}</td>
            <td class="num tiny ${away > 3 ? 'overdue' : ''}">${away || ''}</td>
            <td class="num tiny">${cost ? fmtMoneyFull(cost, s.settings.currencySymbol) : '—'}</td>
            <td class="act"><button class="btn icon sm subtle" data-act="menu"><svg class="ico"><use href="#i-dots"></use></svg></button></td>
          </tr>`;
        }).join('');
    }).join('') || '<tr><td colspan="8" class="tiny mute" style="padding:24px;text-align:center">Nobody matches those filters.</td></tr>')}</tbody>
  </table></div></div>`;
}

/* ---------- skills matrix ------------------------------------------------ */

function skillsMatrix(list) {
  const skills = [...new Set(list.flatMap(p => Object.keys(p.skills || {})))].sort();
  if (!skills.length) {
    return h`<div class="card"><div class="empty"><h4>No skills recorded yet</h4>
      <div class="tiny">Open a person and add skills with a level from 1 to 5. The matrix then shows where you have only one person who can do something.</div></div></div>`;
  }
  const cover = sk => list.filter(p => (p.skills || {})[sk] >= 3).length;
  const cell = v => {
    if (!v) return '<td class="tc tiny mute">·</td>';
    const c = ['', '#E1DFDD', '#9AD1F5', '#4C9AFF', '#2F7ED8', '#1B4F9E'][v] || 'var(--accent)';
    return `<td class="tc" style="background:${c}22;font-weight:650;font-size:11.5px;color:var(--text)">${v}</td>`;
  };
  return h`
  <div class="banner"><svg class="ico"><use href="#i-info"></use></svg>
    <div><b>Coverage rule of thumb:</b> a skill with fewer than two people at level 3+ is a single point of failure.
    Those columns are flagged below.</div></div>
  <div class="card"><div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Person</th>${raw(skills.map(sk => {
      const c = cover(sk);
      return `<th class="tc" style="writing-mode:vertical-rl;transform:rotate(180deg);height:110px;padding:6px 2px;${c < 2 ? 'color:var(--risk)' : ''}">
        ${esc(sk)}${c < 2 ? ' ⚠' : ''}</th>`;
    }).join(''))}</tr></thead>
    <tbody>${raw(list.map(p => `<tr data-id="${p.id}">
      <td data-act="open" style="cursor:pointer"><div class="row" style="gap:7px">
        <span class="avatar xs" style="background:${hashColor(p.name)}">${esc(initials(p.name))}</span>
        <span>${esc(p.name)}</span><span class="pill-div" style="background:${S.divColor(p.division)}">${esc(p.division)}</span>
      </div></td>
      ${skills.map(sk => cell((p.skills || {})[sk] || 0)).join('')}
    </tr>`).join(''))}
    <tr><td class="tiny mute strong">at level 3+</td>${raw(skills.map(sk => {
      const c = cover(sk);
      return `<td class="tc tiny ${c < 2 ? 'overdue' : 'mute'}"><b>${c}</b></td>`;
    }).join(''))}</tr></tbody>
  </table></div></div>`;
}

/* ---------- capacity ----------------------------------------------------- */

function capacityView(list) {
  const s = S.get();
  const ym = thisMonth();
  const months = [ym, next(ym), next(next(ym))];
  const target = s.settings.utilisationTarget || 85;
  // the toolbar filters apply here too — an unfiltered capacity table under a
  // filtered toolbar is worse than no table, because it looks like an answer
  const include = new Set(list.map(p => p.id));
  const divisions = s.divisions.filter(d => list.some(p => p.division === d.id));

  return h`
  <div class="card"><header><h3>Available capacity</h3>
    <span class="sub">person-days after weekends, public holidays and booked leave</span></header>
    <div class="body flush"><table class="tbl">
      <thead><tr><th>Division</th>${raw(months.map(m => `<th class="num" colspan="2">${esc(mLabel(m))}</th>`).join(''))}</tr>
      <tr><th></th>${raw(months.map(() => '<th class="num tiny">days</th><th class="num tiny">lost</th>').join(''))}</tr></thead>
      <tbody>${raw(divisions.map(d => `<tr>
        <td><span class="pill-div" style="background:${d.color}">${esc(d.id)}</span> <span class="tiny">${esc(d.name)}</span></td>
        ${months.map(m => { const c = capacity(m, { division: d.id, include });
          return `<td class="num">${c.net.toFixed(1)}</td><td class="num tiny ${c.lost > c.gross * 0.15 ? 'overdue' : 'mute'}">${c.lost ? '−' + c.lost.toFixed(1) : ''}</td>`;
        }).join('')}</tr>`).join(''))}
        <tr style="font-weight:650"><td>All divisions</td>
        ${raw(months.map(m => { const c = capacity(m, { include });
          return `<td class="num">${c.net.toFixed(1)}</td><td class="num tiny mute">${c.lost ? '−' + c.lost.toFixed(1) : ''}</td>`;
        }).join(''))}</tr>
      </tbody></table></div>
  </div>

  <div class="card" style="margin-top:14px"><header><h3>Allocation check</h3>
    <span class="sub">target utilisation ${target}% · anyone over 100% is double-booked on paper</span></header>
    <div class="body flush"><table class="tbl">
      <thead><tr><th>Person</th><th>Division</th><th>Allocated</th><th class="num">%</th><th>Flag</th></tr></thead>
      <tbody>${raw(list.filter(p => p.active !== false).map(p => {
        const t = allocTotal(p);
        const flag = t > 100 ? '<span class="chip risk">over-allocated</span>'
                   : t === 0 ? '<span class="chip">unallocated</span>'
                   : t < target ? '<span class="chip warn">under target</span>' : '<span class="chip ok">ok</span>';
        return `<tr data-id="${p.id}"><td data-act="open" style="cursor:pointer">${esc(p.name)}</td>
          <td><span class="pill-div" style="background:${S.divColor(p.division)}">${esc(p.division)}</span></td>
          <td style="min-width:150px">${bar(clamp(t, 0, 100), t > 100 ? 'risk' : t < target ? 'warn' : 'ok').html}</td>
          <td class="num">${t}%</td><td>${flag}</td></tr>`;
      }).join(''))}</tbody></table></div>
  </div>`;
}
const next = ym => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const mLabel = ym => { const [y, m] = ym.split('-'); return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1] + ' ' + y.slice(2); };

/* ---------- 1:1s --------------------------------------------------------- */

function oneToOneView(list) {
  const s = S.get();
  const rows = list.filter(p => !p.isMe && p.active !== false).map(p => {
    const list = s.oneToOnes.filter(o => o.personId === p.id).sort((a, b) => b.date.localeCompare(a.date));
    const last = list[0];
    const gap = last ? Math.round((Date.now() - new Date(last.date + 'T00:00:00')) / 86400000) : null;
    return { p, last, gap, n: list.length };
  }).sort((a, b) => (b.gap ?? 9999) - (a.gap ?? 9999));

  const overdue = rows.filter(r => r.gap == null || r.gap > 35).length;

  return h`
  ${raw(overdue ? `<div class="banner warn"><svg class="ico"><use href="#i-warn"></use></svg>
    <div><b>${overdue} ${overdue === 1 ? 'person has' : 'people have'} not had a 1:1 in over five weeks.</b>
    They are at the top of the list.</div></div>` : '')}
  <div class="card"><div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Person</th><th>Last 1:1</th><th>Gap</th><th>Signal</th><th>Last note</th><th></th></tr></thead>
    <tbody>${raw(rows.map(r => {
      const mood = MOODS.find(m => m.id === r.last?.mood);
      return `<tr data-id="${r.p.id}">
        <td data-act="open" style="cursor:pointer"><div class="row" style="gap:7px">
          <span class="avatar sm" style="background:${hashColor(r.p.name)}">${esc(initials(r.p.name))}</span>
          <div><div class="strong">${esc(r.p.name)}</div><div class="tiny mute">${esc(r.p.role)}</div></div></div></td>
        <td class="tiny">${r.last ? esc(fmtDate(r.last.date, 'long')) : '<span class="mute">never</span>'}</td>
        <td class="tiny ${r.gap == null || r.gap > 35 ? 'overdue' : ''}">${r.gap == null ? '—' : r.gap + 'd'}</td>
        <td>${mood ? `<span class="chip ${mood.chip}">${esc(mood.label)}</span>` : ''}</td>
        <td class="tiny trunc" style="max-width:340px">${esc((r.last?.notes || '').slice(0, 140))}</td>
        <td class="act"><button class="btn sm subtle" data-act="log">Log 1:1</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" class="tiny mute" style="padding:24px;text-align:center">Nobody matches those filters.</td></tr>')}</tbody></table></div></div>`;
}

/* ---------- editors ------------------------------------------------------ */

async function editPerson(id) {
  const s = S.get();
  const p = id ? S.byId(s.people, id) : null;
  const res = await formDlg(p ? 'Edit person' : 'Add person', [
    { k: 'name', label: 'Name', value: p?.name || '', required: true, span: 7 },
    { k: 'email', label: 'Email', type: 'email', value: p?.email || '', span: 5 },
    { k: 'role', label: 'Role', value: p?.role || '', span: 7 },
    { k: 'division', label: 'Division', type: 'select', value: p?.division || s.divisions[0]?.id, span: 5,
      opts: s.divisions.map(d => ({ v: d.id, t: `${d.id} — ${d.name}` })) },
    { k: 'seniority', label: 'Seniority', type: 'select', value: p?.seniority || '', span: 4, opts: SENIORITY.map(x => ({ v: x, t: x })) },
    { k: 'contract', label: 'Contract', type: 'select', value: p?.contract || 'staff', span: 4, opts: CONTRACT.map(x => ({ v: x, t: x })) },
    { k: 'capacity', label: 'Capacity %', type: 'number', value: p?.capacity ?? 100, span: 4, min: 0, max: 100,
      hint: 'Part-time or split with another department' },
    { k: 'costMonthly', label: 'Cost / month', type: 'number', value: p?.costMonthly ?? '', span: 4, min: 0,
      hint: 'Blank uses the rate card' },
    { k: 'leaveAllowance', label: 'Annual leave days', type: 'number', value: p?.leaveAllowance ?? 15, span: 4, min: 0 },
    { k: 'startDate', label: 'Start date', type: 'date', value: p?.startDate || '', span: 4 },
    { k: 'notes', label: 'Notes', type: 'textarea', value: p?.notes || '', span: 12, rows: 2 },
    { k: 'active', label: 'Status', type: 'checkbox', value: p ? p.active !== false : true, span: 12, cbLabel: 'Currently on the team' },
  ], { ok: p ? 'Save' : 'Add', wide: true });
  if (!res) return false;
  if (p) S.update('people', id, res);
  else S.add('people', { ...res, alloc: [], skills: {}, goals: [] });
  toast('Saved', 'ok');
  return true;
}

async function editAlloc(id) {
  const s = S.get();
  const p = S.byId(s.people, id);
  const res = await dialog({
    title: 'Allocation — ' + p.name,
    body: `<p class="tiny mute">Percentage of this person's time each project is charged for.
           The total drives capacity, cost split and the over-allocation flag.</p>
      <div id="al">${s.projects.filter(x => x.status !== 'archived').map(pr => {
        const cur = (p.alloc || []).find(a => a.projectId === pr.id)?.pct || 0;
        return `<div class="row" style="margin-bottom:9px">
          <span style="width:11px;height:11px;border-radius:3px;background:${pr.color};flex:none"></span>
          <span style="flex:1">${esc(pr.name)}</span>
          <input type="number" data-p="${pr.id}" value="${cur}" min="0" max="100" step="5" style="width:82px;text-align:right">
          <span class="tiny mute">%</span></div>`;
      }).join('')}</div>
      <div class="sep"></div>
      <div class="row tiny"><span style="flex:1">Total</span><b id="altot">—</b></div>`,
    footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-ok>Save</button>`,
    onMount: ({ root, close }) => {
      const recalc = () => {
        const t = [...root.querySelectorAll('[data-p]')].reduce((a, i) => a + (+i.value || 0), 0);
        const el = root.querySelector('#altot');
        el.textContent = t + '%';
        el.style.color = t > 100 ? 'var(--risk)' : t === 100 ? 'var(--ok)' : 'var(--text-dim)';
      };
      root.addEventListener('input', recalc); recalc();
      root.querySelector('[data-no]').onclick = () => close();
      root.querySelector('[data-ok]').onclick = () => close(
        [...root.querySelectorAll('[data-p]')].map(i => ({ projectId: i.dataset.p, pct: +i.value || 0 })).filter(a => a.pct > 0));
    },
  });
  if (!res) return false;
  S.update('people', id, { alloc: res });
  toast('Allocation updated', 'ok');
  return true;
}

async function editSkills(id) {
  const p = S.byId(S.get().people, id);
  const known = [...new Set(S.get().people.flatMap(x => Object.keys(x.skills || {})))].sort();
  const res = await dialog({
    title: 'Skills — ' + p.name,
    body: `<p class="tiny mute">Level 1 = aware, 3 = can deliver unsupervised, 5 = sets the standard and teaches it.</p>
      <div id="sk"></div>
      <div class="row" style="margin-top:10px">
        <input id="sknew" placeholder="Add a skill…" list="sklist" style="flex:1">
        <datalist id="sklist">${known.map(k => `<option value="${esc(k)}">`).join('')}</datalist>
        <button class="btn sm" id="skadd">Add</button></div>`,
    footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-ok>Save</button>`,
    onMount: ({ root, close }) => {
      let sk = { ...(p.skills || {}) };
      const wrap = root.querySelector('#sk');
      const draw = () => {
        wrap.innerHTML = Object.entries(sk).map(([k, v]) => `
          <div class="row" style="margin-bottom:7px" data-sk="${esc(k)}">
            <span class="tiny" style="flex:1">${esc(k)}</span>
            <input type="range" min="0" max="5" step="1" value="${v}" data-lv style="width:130px;flex:none">
            <b class="tiny" style="width:14px;text-align:center">${v}</b>
            <button class="btn icon sm subtle" data-rm><svg class="ico"><use href="#i-x"></use></svg></button>
          </div>`).join('') || '<div class="tiny mute">No skills yet.</div>';
      };
      draw();
      wrap.addEventListener('input', e => {
        const r = e.target.closest('[data-lv]'); if (!r) return;
        const k = r.closest('[data-sk]').dataset.sk;
        sk[k] = +r.value; r.nextElementSibling.textContent = r.value;
      });
      wrap.addEventListener('click', e => {
        const b = e.target.closest('[data-rm]'); if (!b) return;
        delete sk[b.closest('[data-sk]').dataset.sk]; draw();
      });
      const addOne = () => {
        const v = root.querySelector('#sknew').value.trim();
        if (!v) return;
        sk[v] = sk[v] || 3; root.querySelector('#sknew').value = ''; draw();
      };
      root.querySelector('#skadd').onclick = addOne;
      root.querySelector('#sknew').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addOne(); } });
      root.querySelector('[data-no]').onclick = () => close();
      root.querySelector('[data-ok]').onclick = () => close(Object.fromEntries(Object.entries(sk).filter(([, v]) => v > 0)));
    },
  });
  if (!res) return false;
  S.update('people', id, { skills: res });
  return true;
}


/* ---------- csv ---------------------------------------------------------- */

function exportCsv() {
  const s = S.get();
  const rows = s.people.map(p => ({
    Name: p.name, Email: p.email || '', Division: p.division, Role: p.role,
    Seniority: p.seniority, Contract: p.contract, CostMonthly: p.costMonthly || '',
    Capacity: p.capacity ?? 100, LeaveAllowance: p.leaveAllowance ?? 15,
    StartDate: p.startDate || '', Active: p.active === false ? 'no' : 'yes',
    Allocation: (p.alloc || []).map(a => `${S.byId(s.projects, a.projectId)?.code || a.projectId}:${a.pct}`).join(' '),
    Skills: Object.entries(p.skills || {}).map(([k, v]) => `${k}:${v}`).join(' '),
    Notes: p.notes || '',
  }));
  download(`gfx-team-${today()}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
  toast(`${rows.length} people exported`, 'ok');
}

/**
 * Import the roster from a CSV file, or from a range pasted straight out of
 * Excel. The paste route is the one that matters: it means the master copy can
 * live in a spreadsheet on SharePoint — filled in by hand, never in the source
 * code and never in the repository — and getting it into the app is a
 * copy-paste rather than a file round-trip.
 */
async function importCsv() {
  const src = await dialog({
    title: 'Import the team',
    wide: true,
    body: `<p class="tiny mute">Two ways in. Paste a range copied straight from Excel — including the
      header row — or choose a CSV file. Columns are matched by header name, so extra columns are
      ignored and the order does not matter.</p>
      <div class="tiny mono" style="background:var(--bg-sunken);padding:8px;border-radius:var(--r-sm);margin:10px 0;overflow-x:auto;white-space:pre">Name\tEmail\tDivision\tRole\tSeniority\tContract\tCostMonthly\tAllocation\tSkills</div>
      <textarea id="pp" rows="10" class="mono" placeholder="Paste from Excel here (Ctrl+V)…"></textarea>
      <div class="row" style="margin-top:10px">
        <button class="btn sm" data-file>${'<svg class="ico"><use href="#i-up"></use></svg>'} Choose a CSV file…</button>
        <span class="tiny mute" id="pfname"></span>
        <span class="spacer" style="flex:1"></span>
        <button class="btn sm subtle" data-tpl>Download a blank template</button>
      </div>
      <div class="banner" style="margin:12px 0 0"><svg class="ico"><use href="#i-info"></use></svg>
        <div>People are matched by <b>name</b>. Matches are updated in place, new names are added,
        and nothing is deleted unless you choose Replace on the next screen.</div></div>`,
    footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-ok>Read it</button>`,
    onMount: ({ root, close }) => {
      root.querySelector('[data-file]').onclick = async () => {
        const f = await pickFile('.csv,.txt,.tsv');
        if (!f) return;
        root.querySelector('#pfname').textContent = f.name;
        root.querySelector('#pp').value = f.text;
      };
      root.querySelector('[data-tpl]').onclick = () => csvTemplate();
      root.querySelector('[data-no]').onclick = () => close(null);
      root.querySelector('[data-ok]').onclick = () => close(root.querySelector('#pp').value);
    },
  });
  if (!src || !src.trim()) return false;

  // Excel puts tabs between cells; parseCsv wants commas. Convert only when the
  // text actually looks tab-separated, so a CSV containing tabs is left alone.
  const looksTabbed = /^[^\n]*\t/.test(src);
  const f = { name: looksTabbed ? 'pasted from Excel' : 'pasted text',
              text: looksTabbed ? src.replace(/\t/g, ',') : src };

  let rows;
  try { rows = parseCsv(f.text); } catch (e) { toast('Could not read that: ' + e.message, 'err'); return false; }
  if (!rows.length) { toast('No rows found. Did the header row come across?', 'warn'); return false; }

  const s = S.get();
  const codeToId = c => s.projects.find(p => [p.code, p.name, p.id].some(x => x?.toLowerCase() === c.toLowerCase()))?.id;
  const mapped = rows.map(r => {
    const alloc = String(r.Allocation || '').split(/\s+/).filter(Boolean).map(bit => {
      const [c, pct] = bit.split(':');
      const id = codeToId(c || '');
      return id ? { projectId: id, pct: +pct || 0 } : null;
    }).filter(Boolean);
    const skills = Object.fromEntries(String(r.Skills || '').split(/\s+/).filter(Boolean)
      .map(bit => { const [k, v] = bit.split(':'); return [k, clamp(+v || 3, 1, 5)]; }));
    return {
      name: (r.Name || r.name || '').trim(),
      email: r.Email || '', division: (r.Division || '').toUpperCase() || s.divisions[0].id,
      role: r.Role || '', seniority: r.Seniority || '',
      contract: (r.Contract || 'staff').toLowerCase(),
      costMonthly: r.CostMonthly ? +r.CostMonthly : undefined,
      capacity: r.Capacity ? +r.Capacity : 100,
      leaveAllowance: r.LeaveAllowance ? +r.LeaveAllowance : 15,
      startDate: r.StartDate || '', active: String(r.Active || 'yes').toLowerCase() !== 'no',
      alloc, skills, goals: [], notes: r.Notes || '',
    };
  }).filter(x => x.name);

  const mode = await dialog({
    title: `Import ${mapped.length} people`,
    body: `<p>From <b>${esc(f.name)}</b>.</p>
      <p class="tiny mute">Matching is by name. “Update” refreshes people you already have and adds the rest.
      “Replace” removes everyone currently in the roster first — allocations, skills and 1:1 notes for
      people not in the file are lost.</p>`,
    footer: `<button class="btn" data-no>Cancel</button>
             <button class="btn danger" data-replace>Replace roster</button>
             <button class="btn primary" data-update>Update &amp; add</button>`,
    onMount: ({ root, close }) => {
      root.querySelector('[data-no]').onclick = () => close();
      root.querySelector('[data-update]').onclick = () => close('update');
      root.querySelector('[data-replace]').onclick = () => close('replace');
    },
  });
  if (!mode) return false;

  S.mutate(st => {
    if (mode === 'replace') {
      const me = st.people.find(p => p.isMe);
      st.people = me ? [me] : [];
    }
    for (const m of mapped) {
      const ex = st.people.find(p => p.name.toLowerCase() === m.name.toLowerCase());
      if (ex) Object.assign(ex, { ...m, id: ex.id, isMe: ex.isMe });
      else st.people.push({ id: S.uid('per'), created: Date.now(), ...m });
    }
  }, { label: 'import people' });
  toast(`${mapped.length} people imported`, 'ok');
  return true;
}

function csvTemplate() {
  const s = S.get();
  const sample = [{
    Name: 'Jane Doe', Email: 'jane.doe@example.com', Division: s.divisions[0]?.id || '2D',
    /* `CostMonthly: 0` and a real rung. The example used to carry 3000 and a
       `mid` that is not on the ladder any more — a cost figure has no business
       in a downloadable template shipped from a public repository, and an
       invalid rung in the one row people copy is a bug factory. */
    Role: '2D Artist', Seniority: SENIORITY[0], Contract: 'staff', CostMonthly: 0,
    Capacity: 100, LeaveAllowance: 15, StartDate: '2025-04-01', Active: 'yes',
    Allocation: `${s.projects[0]?.code || 'SKY'}:60 ${s.projects[1]?.code || 'HBR'}:40`,
    Skills: 'Painting:4 Props:3', Notes: '',
  }];
  download('gfx-team-template.csv', toCsv(sample), 'text/csv;charset=utf-8');
  toast('Template downloaded — fill it in and import it back', 'ok');
}

/* ---------- view --------------------------------------------------------- */

/* ---------- divisions ---------------------------------------------------- */

/**
 * Add, rename and retire divisions.
 *
 * There was no way to do this in the app at all — the only route was the
 * Divisions sheet of `01_People.xlsx`, which is a strange place to have to go
 * to add a team. The ID is the part that matters and the part you cannot
 * safely change: people, tasks, batches, work-breakdown items and the Jira
 * label rule all refer to a division by it.
 */
async function manageDivisions(ctx) {
  const render = () => {
    const s = S.get();
    return `
      <div class="banner">
        <svg class="ico"><use href="#i-info"></use></svg>
        <div><b>The ID is the identity.</b> People, tasks, outsourcing batches and the
          work-breakdown catalogue all refer to a division by it — so it is set once and
          never edited. Keep it short: <code>2D</code>, <code>ANIM</code>, <code>PROD</code>.
          <div class="tiny mute" style="margin-top:4px">
            The Jira label is the one every task in the division is filed with. Leave it
            blank for a division that should add none. This is also the
            <b>JiraLabel</b> column on the Divisions sheet of <code>01_People.xlsx</code>.
          </div></div>
      </div>
      <table class="dx-table" style="border:1px solid var(--line);border-radius:var(--r)">
        ${s.divisions.map(d => {
          const heads = s.people.filter(p => p.active !== false && p.division === d.id).length;
          const tasks = s.tasks.filter(t => t.division === d.id).length;
          const label = divisionLabel(d.id);
          return `<tr data-d="${esc(d.id)}">
            <td style="width:66px"><span class="pill-div" style="background:${esc(d.color || 'var(--muted)')}">${esc(d.id)}</span></td>
            <td><b>${esc(d.name || d.id)}</b>
              <div class="tiny mute">${heads} ${heads === 1 ? 'person' : 'people'} · ${tasks} task${tasks === 1 ? '' : 's'}
                ${d.lead ? ' · lead ' + esc(S.personName(d.lead)) : ''}</div></td>
            <td style="width:110px" class="tiny">${label
              ? `Jira <code>${esc(label)}</code>`
              : '<span class="mute">no Jira label</span>'}</td>
            <td style="width:150px;text-align:right">
              <button class="btn sm subtle" data-edit="${esc(d.id)}">Edit</button>
              <button class="btn sm subtle" data-del="${esc(d.id)}">Remove</button>
            </td></tr>`;
        }).join('')}
      </table>`;
  };

  await dialog({
    title: 'Divisions', wide: true, body: render(),
    footer: `<button class="btn" data-x2>Close</button>
             <div class="spacer" style="flex:1"></div>
             <button class="btn primary" data-add>${'<svg class="ico"><use href="#i-plus"></use></svg>'}Add a division</button>`,
    onMount: ({ root, body, close }) => {
      const refresh = () => { body.innerHTML = render(); wire(); ctx.rerender(); };

      const edit = async (id) => {
        const d = id ? S.byId(S.get().divisions, id) : null;
        const res = await formDlg(d ? `Edit ${d.id}` : 'New division', [
          { k: 'id', label: 'ID', value: d?.id || '', required: !d, span: 4,
            hint: d ? 'Cannot be changed — everything refers to it.' : 'Short and stable, e.g. PROD.' },
          { k: 'name', label: 'Name', value: d?.name || '', required: true, span: 8 },
          { k: 'color', label: 'Colour', type: 'color', value: d?.color || '#6264A7', span: 4 },
          { k: 'jiraLabel', label: 'Jira label', value: d ? divisionLabel(d.id) : '', span: 8,
            hint: 'Filed on every task in this division. No spaces; blank means no label.' },
          { k: 'lead', label: 'Lead', type: 'select', value: d?.lead || '', span: 12,
            opts: [{ v: '', t: 'Unassigned' },
                   ...S.get().people.filter(p => p.active !== false).map(p => ({ v: p.id, t: p.name }))] },
        ], { ok: d ? 'Save' : 'Add', wide: true });
        if (!res) return;

        /* Jira rejects a label containing whitespace, so it is normalised here
           rather than at push time — a rejection three steps later, from a
           PowerShell log, is not a useful place to learn about a typed space. */
        const label = String(res.jiraLabel || '').trim().replace(/\s+/g, '-');

        if (d) {
          /* The ID field is shown for context but never applied: changing it
             would orphan every person and task pointing at the old one. */
          S.update('divisions', d.id, { name: res.name, color: res.color, lead: res.lead, jiraLabel: label });
          toast(label ? `Saved · Jira label ${label}` : 'Saved · this division adds no Jira label', 'ok', 5000);
        } else {
          const newId = String(res.id || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
          if (!newId) return toast('That ID has no usable characters.', 'err');
          if (S.get().divisions.some(x => String(x.id).toUpperCase() === newId)) {
            return toast(`A division with the ID ${newId} already exists.`, 'err');
          }
          S.mutate(st => {
            st.divisions.push({ id: newId, name: res.name, color: res.color, lead: res.lead, jiraLabel: label });
          }, { label: 'add division' });
          toast(label ? `${newId} added · Jira label ${label}` : `${newId} added · it has no Jira label`, 'ok', 6000);
        }
        refresh();
      };

      const wire = () => {
        body.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => edit(b.dataset.edit));
        body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
          const id = b.dataset.del;
          const s = S.get();
          const heads = s.people.filter(p => p.division === id).length;
          const tasks = s.tasks.filter(t => t.division === id).length;
          const items = (s.wbItems || []).filter(i => i.division === id).length;
          if (heads || tasks || items) {
            return toast(
              `${id} is still in use — ${heads} person/people, ${tasks} task(s), ${items} catalogue item(s). ` +
              `Move them first; removing it would leave them pointing at nothing.`, 'err', 9000);
          }
          if (!await confirmDlg(`Remove the division ${id}? Nothing refers to it.`, { ok: 'Remove' })) return;
          S.mutate(st => { st.divisions = st.divisions.filter(x => x.id !== id); }, { label: 'remove division' });
          refresh();
        });
      };
      wire();

      root.querySelector('[data-x2]').onclick = () => close();
      root.querySelector('[data-add]').onclick = () => edit(null);
    },
  });
}

export default {
  id: 'people', title: 'Team', icon: 'people', group: 'people',
  subtitle: 'Roster, capacity, skills coverage and 1:1s',

  actions: ctx => [
    { label: 'Add person', icon: 'plus', primary: true, run: () => editPerson(null).then(r => r && ctx.rerender()) },
    { label: 'Divisions', icon: 'people', run: () => manageDivisions(ctx) },
  ],

  render(host, ctx) {
    const s = S.get();
    const pid = ctx.params[0];
    const person = pid ? S.byId(s.people, pid) : null;

    if (person) {
      /* The person page is three tabs, and the tab is the second route
         parameter — so the browser's back button moves between them and a tab
         can be linked to. Its markup and handlers live in js/personpage.js;
         this file owns the roster, not one person's record. */
      const tab = TABS.some(t => t.id === ctx.params[1]) ? ctx.params[1] : 'overview';
      ctx.setTitle(person.name);
      ctx.setCrumb([person.role, TABS.find(t => t.id === tab).label].filter(Boolean).join(' · '));

      host.innerHTML = personPage(person, ctx, tab);
      acts(host, personActions(person, ctx, tab, {
        back: () => ctx.go('people'),
        edit: () => editPerson(person.id).then(r => r && ctx.rerender()),
        alloc: () => editAlloc(person.id).then(r => r && ctx.rerender()),
        skills: () => editSkills(person.id).then(r => r && ctx.rerender()),
      }));
      return;
    }
    ctx.setTitle();

    ctx.setCrumb('');
    const list = roster();
    const modes = [['roster', 'Roster'], ['skills', 'Skills matrix'], ['capacity', 'Capacity'], ['1to1', '1:1 tracker']];

    host.innerHTML = h`
      <div class="banner"><svg class="ico"><use href="#i-info"></use></svg>
        <div><b>People data stays in this browser.</b> It is never uploaded and never leaves this device
        unless you export it yourself. The sample roster is fictional — replace it with a CSV import.</div></div>

      <div class="toolbar">
        <div class="seg">${raw(modes.map(([v, t]) => `<button data-act="mode" data-v="${v}" class="${ui.mode === v ? 'on' : ''}">${t}</button>`).join(''))}</div>
        <div class="search" style="width:210px">${icon('search')}<input type="search" id="pq" placeholder="Search people…" value="${ui.q}"></div>
        <select data-change="f" data-k="division" style="width:auto">
          <option value="">All divisions</option>
          ${raw(s.divisions.map(d => `<option value="${esc(d.id)}"${d.id === ui.division ? ' selected' : ''}>${esc(d.name)}</option>`).join(''))}
        </select>
        <select data-change="f" data-k="contract" style="width:auto">
          <option value="">All contracts</option>
          ${raw(CONTRACT.map(c => `<option value="${c}"${c === ui.contract ? ' selected' : ''}>${c}</option>`).join(''))}
        </select>
        <div class="spacer" style="flex:1"></div>
        <span class="tiny mute">${list.length} of ${s.people.length}</span>
        <button class="btn sm subtle" data-act="template" title="Download a blank CSV to fill in">Template</button>
        <button class="btn sm subtle" data-act="import">${icon('up')}Import</button>
        <button class="btn sm subtle" data-act="export">${icon('down')}Export</button>
      </div>

      <div id="pbody"></div>`;

    const body = host.querySelector('#pbody');
    body.innerHTML = ui.mode === 'skills' ? skillsMatrix(list)
                   : ui.mode === 'capacity' ? capacityView(list)
                   : ui.mode === '1to1' ? oneToOneView(list)
                   : rosterTable(list);

    const q = host.querySelector('#pq');
    let deb;
    q.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => { ui.q = q.value; saveUi(); ctx.rerender(); }, 220); });

    acts(host, {
      mode: el => { ui.mode = el.dataset.v; saveUi(); ctx.rerender(); },
      f: el => { ui[el.dataset.k] = el.value; saveUi(); ctx.rerender(); },
      open: el => ctx.go('people', el.closest('[data-id]').dataset.id),
      log: el => logOneToOne(el.closest('[data-id]').dataset.id).then(r => r && ctx.rerender()),
      export: exportCsv,
      import: () => importCsv().then(r => r && ctx.rerender()),
      template: csvTemplate,
      menu: (el, ev) => {
        const id = el.closest('[data-id]').dataset.id;
        const p = S.byId(S.get().people, id);
        menu(ev, [
          { label: 'Open profile', icon: 'eye', run: () => ctx.go('people', id) },
          { label: 'Edit…', icon: 'edit', run: () => editPerson(id).then(r => r && ctx.rerender()) },
          { label: 'Allocation…', icon: 'chart', run: () => editAlloc(id).then(r => r && ctx.rerender()) },
          { label: 'Skills…', icon: 'star', run: () => editSkills(id).then(r => r && ctx.rerender()) },
          { label: 'Log a 1:1…', icon: 'note', run: () => logOneToOne(id).then(r => r && ctx.rerender()) },
          '-',
          { label: p.active === false ? 'Mark active' : 'Mark as left', icon: 'x',
            run: () => { S.update('people', id, { active: p.active === false }); ctx.rerender(); } },
          { label: 'Delete', icon: 'trash', danger: true, run: async () => {
            if (!await confirmDlg(`Remove ${p.name} from the roster? Their 1:1 notes go too.`, { ok: 'Delete' })) return;
            S.mutate(st => {
              st.people = st.people.filter(x => x.id !== id);
              st.oneToOnes = st.oneToOnes.filter(x => x.personId !== id);
              st.leave = st.leave.filter(x => x.personId !== id);
              st.tasks.forEach(t => { if (t.assignee === id) t.assignee = ''; });
            }, { label: 'delete person' });
            ctx.rerender();
          } },
        ]);
      },
    });
  },
};
