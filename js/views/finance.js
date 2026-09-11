/* ============================================================================
   views/finance.js — budgets, burn, forecast and scenario modelling.

   Three forecasts are offered rather than one, because they answer different
   questions and disagreeing with each other is the point:

     Plan      actuals so far + the rest of the plan   "the plan still holds"
     Run rate  actuals + recent average × months left  "we carry on like this"
     CPI       budget ÷ cost-performance index         "the overrun scales"
   ========================================================================= */

import * as S from '../store.js';
import {
  h, raw, esc, icon, toast, dialog, formDlg, confirmDlg, menu, acts, bar,
  fmtMoney, fmtMoneyFull, fmtPct, fmtNum, fmtMonth, today, download, toCsv,
  lineChart, barChart, donut, sum, groupBy, clamp,
} from '../ui.js';
import {
  projectFinance, CATEGORIES, catOf, monthRange, thisMonth,
  modelledInternal, headcountCost, capacity, rateFor, SENIORITY,
} from '../calc.js';

const UI_KEY = 'gfxprod.ui.finance';
const ui = Object.assign({ project: '', method: 'plan', tab: 'overview', year: new Date().getFullYear() },
                         JSON.parse(localStorage.getItem(UI_KEY) || '{}'));
const saveUi = () => localStorage.setItem(UI_KEY, JSON.stringify(ui));

const sym = () => S.get().settings.currencySymbol || '$';
const yearMonths = y => Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);

/* ---------- overview ----------------------------------------------------- */

function overview(f) {
  const s = S.get();
  const months = f.months.length ? f.months : yearMonths(ui.year);
  const cum = f.cumulative;
  const overspend = f.landing > 0;

  const kpis = h`
  <div class="grid g4" style="margin-bottom:14px">
    <div class="card stat"><div class="k">Approved budget</div><div class="v">${fmtMoney(f.budget, sym())}</div>
      <div class="d">${ui.project ? S.projectName(ui.project) : s.projects.length + ' projects'}</div></div>
    <div class="card stat"><div class="k">Actual to date</div><div class="v">${fmtMoney(f.actualToDate, sym())}</div>
      <div class="d">${fmtPct(f.burnPct, 1)} of budget · through ${fmtMonth(prevMonth(thisMonth()))}</div></div>
    <div class="card stat"><div class="k">Variance to plan</div>
      <div class="v" style="color:${f.variance > 0 ? 'var(--risk)' : 'var(--ok)'}">${f.variance > 0 ? '+' : ''}${fmtMoney(f.variance, sym())}</div>
      <div class="d ${f.variance > 0 ? 'down' : 'up'}">${fmtPct(Math.abs(f.variancePct), 1)} ${f.variance > 0 ? 'over' : 'under'} plan</div></div>
    <div class="card stat"><div class="k">Forecast landing</div>
      <div class="v" style="color:${overspend ? 'var(--risk)' : 'var(--text)'}">${fmtMoney(f.forecast, sym())}</div>
      <div class="d ${overspend ? 'down' : 'up'}">${overspend ? 'over' : 'under'} by ${fmtMoney(Math.abs(f.landing), sym())} · ${fmtPct(Math.abs(f.landingPct), 1)}</div></div>
  </div>`;

  const burn = h`
  <section class="card">
    <header><h3>Cumulative burn</h3>
      <span class="sub">plan vs actual vs forecast</span>
      <div class="spacer" style="flex:1"></div>
      <div class="seg">
        ${raw([['plan', 'Plan'], ['runRate', 'Run rate'], ['cpi', 'CPI']].map(([v, t]) =>
          `<button data-act="method" data-v="${v}" class="${ui.method === v ? 'on' : ''}" title="${esc(methodHint(v))}">${t}</button>`).join(''))}
      </div>
    </header>
    <div class="body">
      ${raw(lineChart({
        labels: cum.map(c => fmtMonth(c.m)),
        series: [
          { name: 'Plan',     values: cum.map(c => c.planned),  color: 'var(--accent)', area: true },
          { name: 'Actual',   values: cum.map(c => c.actual),   color: 'var(--info)' },
          { name: 'Forecast', values: cum.map(c => c.forecast), color: 'var(--warn)', dash: true },
        ],
        height: 210, sym: sym(),
      }))}
      <div class="legend" style="margin-top:8px">
        <span><i style="background:var(--accent)"></i>Plan</span>
        <span><i style="background:var(--info)"></i>Actual</span>
        <span><i style="background:var(--warn)"></i>Forecast (${esc(methodLabel(ui.method))})</span>
        <span class="spacer" style="flex:1"></span>
        <span class="mute">${esc(methodHint(ui.method))}</span>
      </div>
    </div>
  </section>`;

  const monthly = h`
  <section class="card">
    <header><h3>Monthly spend</h3><span class="sub">planned against booked</span></header>
    <div class="body">
      ${raw(barChart({
        labels: f.byMonth.map(r => fmtMonth(r.m)),
        series: [
          { name: 'Planned', values: f.byMonth.map(r => r.planned), color: 'var(--bg-active)' },
          { name: 'Actual',  values: f.byMonth.map(r => r.actual || 0), color: 'var(--accent)' },
        ],
        height: 190, money: true, sym: sym(),
      }))}
      <div class="legend" style="margin-top:8px">
        <span><i style="background:var(--bg-active)"></i>Planned</span>
        <span><i style="background:var(--accent)"></i>Actual</span>
      </div>
    </div>
  </section>`;

  const cats = h`
  <section class="card">
    <header><h3>Where the money goes</h3></header>
    <div class="body row" style="gap:18px;align-items:flex-start">
      ${raw(donut(f.byCategory.map(c => ({ name: c.label, value: c.planned, color: c.color })),
                  { caption: fmtMoney(f.planned, sym()), sub: 'planned' }))}
      <div style="flex:1">
        ${raw(f.byCategory.map(c => {
          const pct = f.planned ? c.planned / f.planned * 100 : 0;
          const burnt = c.planned ? c.actual / c.planned * 100 : 0;
          return `<div style="margin-bottom:10px">
            <div class="row tiny" style="margin-bottom:3px">
              <i style="width:9px;height:9px;border-radius:2px;background:${c.color};display:inline-block"></i>
              <span style="flex:1">${esc(c.label)}</span>
              <span class="mute">${fmtMoney(c.planned, sym())} · ${fmtPct(pct)}</span>
            </div>
            <span class="bar"><i style="width:${clamp(burnt, 0, 100)}%;background:${c.color}"></i></span>
            <div class="tiny mute" style="margin-top:2px">${fmtMoneyFull(c.actual, sym())} booked · ${fmtPct(burnt)} of its line</div>
          </div>`;
        }).join('') || '<div class="tiny mute">No budget lines yet.</div>')}
      </div>
    </div>
  </section>`;

  const check = headcountCheck();

  return h`${raw(kpis)}
    <div class="grid" style="grid-template-columns:1.25fr 1fr">${raw(burn)}${raw(cats)}</div>
    <div class="grid" style="grid-template-columns:1.25fr 1fr;margin-top:14px">${raw(monthly)}${raw(check)}</div>`;
}

const prevMonth = ym => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 2, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const methodLabel = m => ({ plan: 'plan', runRate: 'run rate', cpi: 'CPI' }[m] || m);
const methodHint = m => ({
  plan: 'Assumes the remaining plan is spent exactly as written.',
  runRate: 'Projects the last three closed months forward.',
  cpi: 'Scales the whole budget by how far off the plan you already are.',
}[m] || '');

/** Does the roster agree with the "internal headcount" budget line? */
function headcountCheck() {
  const s = S.get();
  const months = yearMonths(ui.year);
  const projs = ui.project ? [S.byId(s.projects, ui.project)].filter(Boolean) : s.projects;
  const rows = projs.map(p => {
    const modelled = modelledInternal(p.id, months);
    const booked = sum(s.budgetLines.filter(b => b.projectId === p.id && b.type === 'internal'),
                       b => sum(Object.values(b.plannedByMonth || {})));
    return { p, modelled, booked, delta: modelled - booked };
  });
  return h`
  <section class="card">
    <header><h3>Headcount reality check</h3><span class="sub">roster cost vs the internal budget line</span></header>
    <div class="body flush"><table class="tbl">
      <thead><tr><th>Project</th><th class="num">From roster</th><th class="num">Budgeted</th><th class="num">Gap</th></tr></thead>
      <tbody>${raw(rows.map(r => `<tr>
        <td class="tiny"><b>${esc(r.p.code)}</b> ${esc(r.p.name)}</td>
        <td class="num">${fmtMoney(r.modelled, sym())}</td>
        <td class="num">${fmtMoney(r.booked, sym())}</td>
        <td class="num" style="color:${Math.abs(r.delta) > r.booked * 0.08 ? 'var(--risk)' : 'var(--text-dim)'}">
          ${r.delta > 0 ? '+' : ''}${fmtMoney(r.delta, sym())}</td></tr>`).join(''))}
      </tbody></table>
      <div class="tiny mute" style="padding:9px 12px">Cost from the roster = each person's monthly cost × their
      allocation to that project, summed over ${esc(String(ui.year))}. A gap over 8% usually means an
      allocation is stale or somebody joined or left without the budget being touched.</div>
    </div>
  </section>`;
}

/* ---------- the month grid ----------------------------------------------- */

function grid(f) {
  const s = S.get();
  const months = yearMonths(ui.year);
  const lines = f.lines.slice().sort((a, b) => (a.projectId + a.type).localeCompare(b.projectId + b.type));
  const cur = thisMonth();

  const row = (b, kind) => {
    const map = kind === 'plan' ? (b.plannedByMonth || {}) : (b.actualByMonth || {});
    const tot = sum(months, m => map[m] || 0);
    return `<tr data-b="${b.id}" data-kind="${kind}" class="${kind === 'actual' ? 'act-row' : ''}">
      <td class="tiny ${kind === 'actual' ? 'mute' : ''}" style="position:sticky;left:0;background:var(--bg-elev);min-width:210px;border-right:1px solid var(--line)">
        ${kind === 'plan' ? `<b>${esc(b.label)}</b>
           <div class="tiny mute">${esc(S.byId(s.projects, b.projectId)?.code || '—')} · ${esc(catOf(b.type).label)}${b.vendor ? ' · ' + esc(b.vendor) : ''}</div>`
         : '<span style="padding-left:12px">actual</span>'}</td>
      ${months.map(m => {
        const v = map[m] || 0;
        const future = m >= cur && kind === 'actual';
        return `<td class="num" style="padding:2px">
          <input type="number" data-m="${m}" value="${v || ''}" step="100"
            class="mono" style="width:76px;height:26px;text-align:right;border-color:transparent;background:${future ? 'var(--bg-sunken)' : 'transparent'};${kind === 'actual' ? 'color:var(--info)' : ''}"
            title="${esc(b.label)} · ${esc(fmtMonth(m))} · ${kind}"></td>`;
      }).join('')}
      <td class="num strong">${fmtMoney(tot, sym())}</td>
      <td class="act">${kind === 'plan' ? `<button class="btn icon sm subtle" data-act="line-menu"><svg class="ico"><use href="#i-dots"></use></svg></button>` : ''}</td>
    </tr>`;
  };

  const totals = kind => months.map(m =>
    sum(lines, b => ((kind === 'plan' ? b.plannedByMonth : b.actualByMonth) || {})[m] || 0));

  return h`
  <div class="banner"><svg class="ico"><use href="#i-info"></use></svg>
    <div>Type straight into the grid — the top row of each pair is the <b>plan</b>, the row under it is the
    <b>actual</b>. Months from ${esc(fmtMonth(cur))} onward are shaded on the actual row because they have not closed yet.</div></div>
  <div class="card"><div class="tbl-wrap" style="max-height:calc(100vh - 300px)"><table class="tbl">
    <thead><tr>
      <th style="position:sticky;left:0;z-index:3;background:var(--bg-elev)">Budget line</th>
      ${raw(months.map(m => `<th class="num" style="min-width:80px">${esc(fmtMonth(m))}</th>`).join(''))}
      <th class="num">Total</th><th></th></tr></thead>
    <tbody>
      ${raw(lines.map(b => row(b, 'plan') + row(b, 'actual')).join('') ||
            `<tr><td colspan="${months.length + 3}" class="tiny mute" style="padding:22px;text-align:center">No budget lines yet — add one to start.</td></tr>`)}
    </tbody>
    <tfoot><tr style="font-weight:700;border-top:2px solid var(--line)">
      <td style="position:sticky;left:0;background:var(--bg-elev)">Planned total</td>
      ${raw(totals('plan').map(v => `<td class="num tiny">${fmtMoney(v, sym())}</td>`).join(''))}
      <td class="num">${fmtMoney(sum(totals('plan')), sym())}</td><td></td></tr>
    <tr style="font-weight:700;color:var(--info)">
      <td style="position:sticky;left:0;background:var(--bg-elev)">Actual total</td>
      ${raw(totals('actual').map(v => `<td class="num tiny">${v ? fmtMoney(v, sym()) : ''}</td>`).join(''))}
      <td class="num">${fmtMoney(sum(totals('actual')), sym())}</td><td></td></tr></tfoot>
  </table></div></div>`;
}

/* ---------- scenarios ---------------------------------------------------- */

const scen = { heads: 0, seniority: 'Senior', startMonth: '', outsourcePct: 0, contingency: 0, months: 3 };

function scenarios(f) {
  const s = S.get();
  const months = yearMonths(ui.year);
  const cur = thisMonth();
  const remaining = months.filter(m => m >= cur);
  if (!scen.startMonth) scen.startMonth = cur;

  const headCost = rateFor(scen.seniority) * scen.heads *
    Math.max(0, remaining.filter(m => m >= scen.startMonth).length);
  const outsourceBase = sum(s.budgetLines.filter(b => (!ui.project || b.projectId === ui.project) && b.type === 'outsource'),
    b => sum(remaining, m => b.plannedByMonth?.[m] || 0));
  const outsourceDelta = outsourceBase * (scen.outsourcePct / 100);
  const contingencyBase = sum(s.budgetLines.filter(b => (!ui.project || b.projectId === ui.project) && b.type === 'other'),
    b => sum(remaining, m => b.plannedByMonth?.[m] || 0));
  const contingencyRelease = -contingencyBase * (scen.contingency / 100);

  const delta = headCost + outsourceDelta + contingencyRelease;
  const newLanding = f.forecast + delta;
  const vsBudget = newLanding - f.budget;

  return h`
  <div class="grid" style="grid-template-columns:1fr 1.1fr">
    <section class="card">
      <header><h3>What if…</h3><span class="sub">nothing here is saved — it is a sketch</span></header>
      <div class="body">
        <label class="fld"><span>Add headcount</span>
          <div class="row">
            <input type="range" id="sc_heads" min="-4" max="8" step="1" value="${scen.heads}" style="flex:1">
            <b style="width:42px;text-align:right">${scen.heads > 0 ? '+' : ''}${scen.heads}</b>
          </div></label>
        <div class="row" style="gap:10px">
          <label class="fld" style="flex:1"><span>At level</span>
            <select id="sc_sen">${raw(SENIORITY.map(x =>
              `<option value="${x}"${x === scen.seniority ? ' selected' : ''}>${x} · ${fmtMoneyFull(rateFor(x), sym())}/mo</option>`).join(''))}</select></label>
          <label class="fld" style="flex:1"><span>Starting</span>
            <select id="sc_start">${raw(remaining.map(m =>
              `<option value="${m}"${m === scen.startMonth ? ' selected' : ''}>${esc(fmtMonth(m))}</option>`).join(''))}</select></label>
        </div>
        <label class="fld"><span>Change outsourcing spend</span>
          <div class="row">
            <input type="range" id="sc_out" min="-50" max="100" step="5" value="${scen.outsourcePct}" style="flex:1">
            <b style="width:52px;text-align:right">${scen.outsourcePct > 0 ? '+' : ''}${scen.outsourcePct}%</b>
          </div>
          <span class="hint">Applies to ${fmtMoneyFull(outsourceBase, sym())} still planned this year.</span></label>
        <label class="fld"><span>Release contingency</span>
          <div class="row">
            <input type="range" id="sc_cont" min="0" max="100" step="10" value="${scen.contingency}" style="flex:1">
            <b style="width:52px;text-align:right">${scen.contingency}%</b>
          </div>
          <span class="hint">${fmtMoneyFull(contingencyBase, sym())} of contingency remains unspent.</span></label>
      </div>
    </section>

    <section class="card">
      <header><h3>Impact</h3></header>
      <div class="body">
        <table class="tbl">
          <tbody>
            <tr><td>Current forecast (${esc(methodLabel(ui.method))})</td><td class="num strong">${fmtMoneyFull(f.forecast, sym())}</td></tr>
            <tr><td class="tiny">Extra headcount · ${scen.heads} × ${esc(scen.seniority)} from ${esc(fmtMonth(scen.startMonth))}</td>
                <td class="num tiny" style="color:${headCost > 0 ? 'var(--risk)' : headCost < 0 ? 'var(--ok)' : 'inherit'}">${headCost ? (headCost > 0 ? '+' : '') + fmtMoneyFull(headCost, sym()) : '—'}</td></tr>
            <tr><td class="tiny">Outsourcing ${scen.outsourcePct > 0 ? 'increase' : scen.outsourcePct < 0 ? 'cut' : 'unchanged'}</td>
                <td class="num tiny" style="color:${outsourceDelta > 0 ? 'var(--risk)' : outsourceDelta < 0 ? 'var(--ok)' : 'inherit'}">${outsourceDelta ? (outsourceDelta > 0 ? '+' : '') + fmtMoneyFull(outsourceDelta, sym()) : '—'}</td></tr>
            <tr><td class="tiny">Contingency released</td>
                <td class="num tiny" style="color:${contingencyRelease < 0 ? 'var(--ok)' : 'inherit'}">${contingencyRelease ? fmtMoneyFull(contingencyRelease, sym()) : '—'}</td></tr>
            <tr style="border-top:2px solid var(--line)"><td><b>New landing</b></td>
                <td class="num" style="font-size:17px;font-weight:700;color:${vsBudget > 0 ? 'var(--risk)' : 'var(--ok)'}">${fmtMoneyFull(newLanding, sym())}</td></tr>
            <tr><td class="tiny mute">Against a budget of ${fmtMoneyFull(f.budget, sym())}</td>
                <td class="num tiny" style="color:${vsBudget > 0 ? 'var(--risk)' : 'var(--ok)'}">${vsBudget > 0 ? 'over by ' : 'under by '}${fmtMoneyFull(Math.abs(vsBudget), sym())} (${fmtPct(Math.abs(f.budget ? vsBudget / f.budget * 100 : 0), 1)})</td></tr>
          </tbody></table>
        <div class="sep"></div>
        <div class="tiny mute">Headcount uses the rate card in Settings, charged from the month they start
        through December. It does not model recruitment lead time, ramp-up or one-off setup cost — add those
        as a separate budget line when the scenario becomes a proposal.</div>
      </div>
    </section>
  </div>`;
}

/* ---------- editors ------------------------------------------------------ */

async function editLine(id) {
  const s = S.get();
  const b = id ? S.byId(s.budgetLines, id) : null;
  const months = yearMonths(ui.year);
  const res = await dialog({
    title: b ? 'Edit budget line' : 'New budget line',
    wide: true,
    body: `<div style="display:grid;grid-template-columns:repeat(12,1fr);gap:0 12px">
      <label class="fld" style="grid-column:span 7"><span>Label *</span>
        <input id="b_label" value="${esc(b?.label || '')}" placeholder="Outsourcing — props batch 3"></label>
      <label class="fld" style="grid-column:span 5"><span>Vendor / supplier</span>
        <input id="b_vendor" value="${esc(b?.vendor || '')}"></label>
      <label class="fld" style="grid-column:span 6"><span>Project</span>
        <select id="b_project">${s.projects.map(p => `<option value="${p.id}"${p.id === (b?.projectId || ui.project) ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label class="fld" style="grid-column:span 6"><span>Category</span>
        <select id="b_type">${CATEGORIES.map(c => `<option value="${c.id}"${c.id === b?.type ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
    </div>
    <div class="sep"></div>
    <div class="row" style="align-items:flex-end;gap:10px">
      <label class="fld" style="flex:1;margin:0"><span>Spread a total across months</span>
        <input type="number" id="b_total" placeholder="e.g. 120000" step="1000"></label>
      <label class="fld" style="width:110px;margin:0"><span>From</span>
        <select id="b_from">${months.map(m => `<option value="${m}">${esc(fmtMonth(m))}</option>`).join('')}</select></label>
      <label class="fld" style="width:110px;margin:0"><span>To</span>
        <select id="b_to">${months.map((m, i) => `<option value="${m}"${i === 11 ? ' selected' : ''}>${esc(fmtMonth(m))}</option>`).join('')}</select></label>
      <label class="fld" style="width:120px;margin:0"><span>Shape</span>
        <select id="b_shape"><option value="flat">Even</option><option value="ramp">Ramp up</option>
          <option value="front">Front-loaded</option><option value="peak">Peak in middle</option></select></label>
      <button class="btn" id="b_apply">Apply</button>
    </div>
    <div class="hint">Applying overwrites the monthly plan below. You can then adjust individual months in the grid.</div>`,
    footer: `${b ? '<button class="btn danger" data-del>Delete</button>' : ''}<div style="flex:1"></div>
             <button class="btn" data-no>Cancel</button><button class="btn primary" data-ok>${b ? 'Save' : 'Create'}</button>`,
    onMount: ({ root, close }) => {
      let plan = { ...(b?.plannedByMonth || {}) };
      root.querySelector('#b_apply').onclick = () => {
        const total = +root.querySelector('#b_total').value || 0;
        const from = root.querySelector('#b_from').value, to = root.querySelector('#b_to').value;
        const shape = root.querySelector('#b_shape').value;
        if (!total) return toast('Enter a total to spread', 'warn');
        if (to < from) return toast('The end month is before the start month', 'warn');
        plan = spread(total, from, to, shape, months);
        toast(`Spread ${fmtMoneyFull(total, sym())} across ${Object.keys(plan).length} months`, 'ok', 2000);
      };
      root.querySelector('[data-no]').onclick = () => close();
      root.querySelector('[data-del]')?.addEventListener('click', async () => {
        if (await confirmDlg(`Delete “${b.label}” and its monthly figures?`, { ok: 'Delete' })) close({ __delete: true });
      });
      root.querySelector('[data-ok]').onclick = () => {
        const g = k => root.querySelector('#b_' + k).value;
        if (!g('label').trim()) return toast('The line needs a label', 'warn');
        close({ label: g('label').trim(), vendor: g('vendor'), projectId: g('project'), type: g('type'), plannedByMonth: plan });
      };
    },
  });
  if (!res) return false;
  if (res.__delete) { S.remove('budgetLines', id); toast('Budget line deleted', 'ok'); return true; }
  if (b) S.update('budgetLines', id, res);
  else S.add('budgetLines', { ...res, currency: S.get().prefs.currency, actualByMonth: {} });
  toast('Budget line saved', 'ok');
  return true;
}

function spread(total, from, to, shape, months) {
  const a = months.indexOf(from), z = months.indexOf(to);
  const n = z - a + 1, out = {};
  if (n <= 0) return out;
  const w = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? .5 : i / (n - 1);
    w.push(shape === 'ramp' ? .4 + 1.2 * t : shape === 'front' ? 1.6 - 1.2 * t
         : shape === 'peak' ? .5 + 1.6 * Math.sin(Math.PI * t) : 1);
  }
  const tot = w.reduce((x, y) => x + y, 0);
  for (let i = 0; i < n; i++) out[months[a + i]] = Math.round(total * w[i] / tot);
  return out;
}

function exportCsv(f) {
  const months = yearMonths(ui.year);
  const rows = [];
  for (const b of f.lines) {
    const base = { Project: S.byId(S.get().projects, b.projectId)?.code || '', Category: catOf(b.type).label, Line: b.label, Vendor: b.vendor || '' };
    rows.push({ ...base, Kind: 'Plan',   ...Object.fromEntries(months.map(m => [fmtMonth(m), b.plannedByMonth?.[m] || 0])) });
    rows.push({ ...base, Kind: 'Actual', ...Object.fromEntries(months.map(m => [fmtMonth(m), b.actualByMonth?.[m] || 0])) });
  }
  download(`gfx-budget-${ui.year}-${today()}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
  toast('Budget exported', 'ok');
}

/* ---------- view --------------------------------------------------------- */

export default {
  id: 'finance', title: 'Overview', icon: 'cash', group: 'money',
  subtitle: 'Budget, burn, forecast and headcount cost',

  actions: ctx => [
    { label: 'New budget line', icon: 'plus', primary: true, run: () => editLine(null).then(r => r && ctx.rerender()) },
  ],

  render(host, ctx) {
    const s = S.get();
    if (ctx.params[0] && S.byId(s.projects, ctx.params[0])) { ui.project = ctx.params[0]; saveUi(); history.replaceState(null, '', '#/finance'); }
    const f = projectFinance(ui.project || null, { method: ui.method });
    ctx.setCrumb(ui.project ? S.projectName(ui.project) : 'All projects');

    const tabs = [['overview', 'Overview'], ['grid', 'Budget grid'], ['scenario', 'Scenarios']];

    host.innerHTML = h`
      <div class="toolbar">
        <div class="seg">${raw(tabs.map(([v, t]) => `<button data-act="tab" data-v="${v}" class="${ui.tab === v ? 'on' : ''}">${t}</button>`).join(''))}</div>
        <select data-change="proj" style="width:auto">
          <option value="">All projects</option>
          ${raw(s.projects.map(p => `<option value="${esc(p.id)}"${p.id === ui.project ? ' selected' : ''}>${esc(p.name)}</option>`).join(''))}
        </select>
        <select data-change="year" style="width:auto">
          ${raw([ui.year - 1, ui.year, ui.year + 1].map(y => `<option value="${y}"${y === ui.year ? ' selected' : ''}>FY ${y}</option>`).join(''))}
        </select>
        <div class="spacer" style="flex:1"></div>
        <span class="tiny mute">${f.lines.length} budget line${f.lines.length === 1 ? '' : 's'} · ${esc(sym())}${esc(S.get().prefs.currency)}</span>
        <button class="btn sm subtle" data-act="export">${icon('down')}CSV</button>
      </div>
      <div id="fbody"></div>`;

    const body = host.querySelector('#fbody');
    body.innerHTML = ui.tab === 'grid' ? grid(f) : ui.tab === 'scenario' ? scenarios(f) : overview(f);

    acts(host, {
      tab: el => { ui.tab = el.dataset.v; saveUi(); ctx.rerender(); },
      method: el => { ui.method = el.dataset.v; saveUi(); ctx.rerender(); },
      proj: el => { ui.project = el.value; saveUi(); ctx.rerender(); },
      year: el => { ui.year = +el.value; saveUi(); ctx.rerender(); },
      export: () => exportCsv(f),
      'line-menu': (el, ev) => {
        const id = el.closest('[data-b]').dataset.b;
        menu(ev, [
          { label: 'Edit line…', icon: 'edit', run: () => editLine(id).then(r => r && ctx.rerender()) },
          { label: 'Copy plan to actual (through last month)', icon: 'file', run: () => {
            const cur = thisMonth();
            S.mutate(st => {
              const b = S.byId(st.budgetLines, id);
              b.actualByMonth ||= {};
              for (const [m, v] of Object.entries(b.plannedByMonth || {})) if (m < cur) b.actualByMonth[m] = v;
            }, { label: 'copy plan to actual' });
            toast('Actuals filled from plan', 'ok'); ctx.rerender();
          } },
          '-',
          { label: 'Delete', icon: 'trash', danger: true, run: async () => {
            const b = S.byId(S.get().budgetLines, id);
            if (!await confirmDlg(`Delete “${b.label}”?`, { ok: 'Delete' })) return;
            S.remove('budgetLines', id); ctx.rerender();
          } },
        ]);
      },
    });

    /* grid cell editing — debounced, no full re-render on every keystroke */
    if (ui.tab === 'grid') {
      let t;
      body.addEventListener('input', e => {
        const inp = e.target.closest('input[data-m]'); if (!inp) return;
        const tr = inp.closest('[data-b]');
        const id = tr.dataset.b, kind = tr.dataset.kind, m = inp.dataset.m;
        const v = inp.value === '' ? 0 : +inp.value;
        S.mutate(st => {
          const b = S.byId(st.budgetLines, id);
          const map = kind === 'plan' ? (b.plannedByMonth ||= {}) : (b.actualByMonth ||= {});
          if (v) map[m] = v; else delete map[m];
        }, { silent: true, noUndo: true, label: 'budget cell' });
        clearTimeout(t); t = setTimeout(() => ctx.rerender(), 1200);
      });
    }

    /* scenario sliders */
    if (ui.tab === 'scenario') {
      const bind = (id, key, num = true) => {
        const el = body.querySelector('#' + id); if (!el) return;
        el.addEventListener('input', () => { scen[key] = num ? +el.value : el.value; ctx.rerender(); });
        el.addEventListener('change', () => { scen[key] = num ? +el.value : el.value; ctx.rerender(); });
      };
      bind('sc_heads', 'heads'); bind('sc_out', 'outsourcePct'); bind('sc_cont', 'contingency');
      bind('sc_sen', 'seniority', false); bind('sc_start', 'startMonth', false);
    }
  },
};
