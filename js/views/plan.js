/* ============================================================================
   views/plan.js — the Plan: one Gantt, the team's real capacity under it, and
   scenarios on top.

   THE QUESTION THIS SCREEN ANSWERS

     Three projects are running. Somebody asks for a fourth thing that will
     take a month. Can we? What breaks? And what changes if two people do it
     instead of one?

   Everything on the page is arranged around that sentence, in the order you
   would ask it:

     Gantt        what is already committed, on a calendar
     Capacity     who has room, week by week, under those same bars
     Requests     the new ask, with its crew — a what-if, saved nowhere
     Compare      the same ask at one, two, three people, side by side

   WHY IT REPLACES THE OLD TIMELINE

   There were two pictures of the same calendar: a milestone timeline (dots
   with cards) and a "project spans" strip (bars with no work in them).
   Neither could tell you whether the work fitted, because neither knew what
   the work was. This one is a single picture — spans, milestones as diamonds
   on their own project's row, scopes and tasks as bars underneath — driven by
   one simulation that the capacity strip also reads. Two views of one model
   cannot disagree. Two models always eventually do.

   WHAT IS HELD WHERE

   Scenarios live in this module, not in the store, for the same reason the
   work-breakdown draft does: a what-if is a thing you try, look at and throw
   away, and writing every keystroke into the store would fill the undo ring
   with noise and dirty the backup. Turning one into real plan is an explicit
   act — the Commit button — and only that writes anything.
   ========================================================================= */

import * as S from '../store.js';
import {
  h, raw, esc, icon, toast, dialog, formDlg, confirmDlg, menu, acts,
  fmtDate, fmtMoney, fmtMoneyFull, today, addDays, download, toCsv,
} from '../ui.js';
import { SENIORITY, projectFinance } from '../calc.js';
import {
  wbDivisions, wbSettings, wbEstimates, newEstimate,
  saveEstimate, defaultSeniority, hourlyRate,
} from '../wb.js';
import {
  simulate, newScenario, newRequest, requestCalc, reqCrew, crewSweep,
  recommendCrew, planWindow, coverBars, workDaysBetween,
  nextWorkDay, scopeBars, WINDOWS, GRAINS,
} from '../plan.js';
import {
  ganttHTML, capacityStripHTML, wireGantt, zoomToggle, geometry, zoomOf,
  scrollToToday,
} from '../gantt.js';

const sym = () => S.get().settings.currencySymbol || '$';
const n1 = x => (Number.isFinite(x) ? (Math.round(x * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—');

/* ---------- view state --------------------------------------------------- */

/*
 * Held in the module, persisted only as far as a page reload.
 *
 * `collapsed` and the filters are UI, not data. `scenarios` is the working
 * set of what-ifs — deliberately volatile, and the empty state says so.
 */
const UI_KEY = 'gfxprod.plan.ui';
const ui = Object.assign({
  range: '6m', zoom: 'week', grain: 'week',
  projects: [],          // [] = all
  divisions: [],         // [] = all
  showTasks: true,
  showCapacity: true,
  /* Chart height in px, 0 = the CSS default. Dragged by the handle under the
     chart; kept here with the other view preferences so it survives a reload
     and every re-render in between. */
  height: 0,
  /*
   * OFF by default, and the reasoning matters.
   *
   * On, the capacity strip reads a fully-allocated roster as 100% busy
   * everywhere and every request becomes impossible — which is *true*, and
   * useless: it turns a planning tool into a machine that says no. Off, the
   * strip compares itemised work against the team, which is the reading you
   * can actually act on: this scope, these weeks, these people.
   *
   * The honest half is the coverage banner. Rather than quietly pick a model,
   * the screen states how much of the team's time the board accounts for and
   * puts the other reading one click away. See `coverageBanner()`.
   */
  useAllocation: false,
  tab: 'gantt',          // gantt | compare
}, JSON.parse(localStorage.getItem(UI_KEY) || '{}'));
/*
 * `tab` is deliberately NOT remembered.
 *
 * Scenarios only live as long as the tab does, so a remembered "compare"
 * reopens on a table with nothing in it but the baseline — the weakest
 * possible first screen, and one you then have to click out of every time.
 * Comparison is a side-trip from the chart; the chart is the view.
 */
ui.tab = 'gantt';
const saveUi = () => {
  try {
    const { tab, ...keep } = ui;
    localStorage.setItem(UI_KEY, JSON.stringify(keep));
  } catch {}
};

let collapsed = new Set();
let scenarios = [];        // the what-ifs, newest last
let activeId = 'baseline';
let lastSim = null;        // so a handler can look up a bar without re-simulating

const activeScenario = () => scenarios.find(s => s.id === activeId) || null;

/* ---------- the simulation ---------------------------------------------- */

function runSim() {
  const base = planWindow(ui.range);
  const scn = activeScenario();
  const projects = ui.projects.length ? new Set(ui.projects) : null;
  const divisions = ui.divisions.length ? new Set(ui.divisions) : null;

  /*
   * A first pass, then widen the window — but ONLY for scenario work.
   *
   * Widening for everything looked right and was wrong: a project running to
   * March 2027 stretched a "3 months" view to eighteen, so the range buttons
   * did nothing and the utilisation figure averaged a crunch away over a year
   * and a half. A project span is happy to be clipped by the window; you can
   * see it continues. A what-if that starts in nine months is invisible, and
   * an invisible what-if is one nobody checks — so that, and only that, moves
   * the frame.
   */
  const probe = simulate(scn, { ...base, grain: ui.grain, projects, divisions, showTasks: ui.showTasks, useAllocation: ui.useAllocation });
  const win = coverBars(base, probe.bars.filter(b => b.scenario));
  /* A little air either side so a bar never starts flush against the frame. */
  const padded = { from: addDays(win.from, -3), to: addDays(win.to, 7) };

  const sim = (padded.from === base.from && padded.to === base.to)
    ? probe
    : simulate(scn, { ...padded, grain: ui.grain, projects, divisions, showTasks: ui.showTasks, useAllocation: ui.useAllocation });
  lastSim = sim;
  return sim;
}

/* ---------- toolbar ------------------------------------------------------ */

function toolbar() {
  const s = S.get();
  const divs = wbDivisions();
  const live = s.projects.filter(p => p.status !== 'archived');

  const chip = (on, act, val, label, tint) =>
    `<button class="gx-chip${on ? ' on' : ''}" data-act="${act}" data-v="${esc(val)}"
       ${tint ? `style="--chip:${esc(tint)}"` : ''}>${esc(label)}</button>`;

  return h`
  <div class="gx-toolbar">
    <div class="gx-tb-row">
      <div class="seg">
        ${raw(WINDOWS.map(([k, l]) => `<button data-act="range" data-v="${k}"
          class="${ui.range === k ? 'on' : ''}" title="${esc(l)}">${k}</button>`).join(''))}
      </div>
      ${raw(zoomToggle(ui.zoom))}
      <div class="seg" title="How wide a capacity column is">
        ${raw(GRAINS.map(g => `<button data-act="grain" data-v="${g.id}"
          class="${ui.grain === g.id ? 'on' : ''}" title="${esc(g.hint)}">${esc(g.label)}</button>`).join(''))}
      </div>
      <div class="spacer" style="flex:1"></div>
      <label class="gx-tog" title="Draw estimated tasks as bars, not only work-breakdown scopes">
        <input type="checkbox" data-change="show-tasks" ${ui.showTasks ? 'checked' : ''}><span>Tasks</span></label>
      <label class="gx-tog" title="Show the capacity strip under the chart">
        <input type="checkbox" data-change="show-cap" ${ui.showCapacity ? 'checked' : ''}><span>Capacity</span></label>
      <label class="gx-tog" title="Count what people are already allocated to, even where no task exists.
Off reads only the work on the board, which flatters a team whose real workload is not all written down.">
        <input type="checkbox" data-change="use-alloc" ${ui.useAllocation ? 'checked' : ''}><span>Allocation</span></label>
      <button class="btn sm subtle" data-act="fold-all" title="Collapse or expand every group">
        ${icon('board')}${collapsed.size ? 'Expand all' : 'Collapse all'}</button>
      <button class="btn sm subtle" data-act="today">${icon('cal')}Today</button>
    </div>

    <div class="gx-tb-row wrap">
      <span class="gx-tb-k">Projects</span>
      ${raw(chip(!ui.projects.length, 'filter-proj', '', 'All'))}
      ${raw(live.map(p => chip(ui.projects.includes(p.id), 'filter-proj', p.id, p.code || p.name, p.color)).join(''))}
      <span class="gx-tb-sep"></span>
      <span class="gx-tb-k">Divisions</span>
      ${raw(chip(!ui.divisions.length, 'filter-div', '', 'All'))}
      ${raw(divs.map(d => chip(ui.divisions.includes(d.id), 'filter-div', d.id, d.id, d.color)).join(''))}
    </div>
  </div>`;
}

/* ---------- the scenario bar -------------------------------------------- */

/**
 * The tab strip of what-ifs, and what the active one changes.
 *
 * Baseline is always first and cannot be edited or deleted — you need
 * somewhere to stand to see what a scenario did.
 */
function scenarioBar(sim) {
  const scn = activeScenario();
  const chips = [`<button class="gx-scn${activeId === 'baseline' ? ' on' : ''}" data-act="scn-pick" data-v="baseline">
      <span class="gx-scn-dot base"></span>As it stands</button>`]
    .concat(scenarios.map(x => {
      const delta = x.id === activeId ? sim : null;
      return `<button class="gx-scn${activeId === x.id ? ' on' : ''}" data-act="scn-pick" data-v="${esc(x.id)}">
        <span class="gx-scn-dot"></span>${esc(x.name)}
        ${delta && delta.summary.shortfallDays > 0.5 ? `<span class="chip risk">−${n1(delta.summary.shortfallDays)}d</span>` : ''}
      </button>`;
    }))
    .join('');

  const detail = scn ? scenarioDetail(scn, sim) : `
    <div class="gx-scn-empty">
      <b>This is the plan as it stands.</b>
      <span>Add a scenario to try an extra request, a different crew, or an extra pair of hands —
      nothing is saved to your data until you commit it.</span>
    </div>`;

  return h`
  <section class="card gx-scn-card">
    <header>
      <h3>Scenarios</h3>
      <span class="sub">what-ifs, held only while this tab is open</span>
      <div class="spacer" style="flex:1"></div>
      ${raw(scenarios.length > 1 ? `<button class="btn sm subtle" data-act="tab" data-v="compare">${icon('chart')}Compare all</button>` : '')}
      <button class="btn primary sm" data-act="scn-new">${icon('plus')}New scenario</button>
    </header>
    <div class="body">
      <div class="gx-scn-tabs">${raw(chips)}</div>
      ${raw(detail)}
    </div>
  </section>`;
}

function scenarioDetail(scn, sim) {
  const s = S.get();
  const reqs = sim.requests || [];

  const reqRows = reqs.map(({ request: r, calc: c }) => {
    const p = S.byId(s.projects, r.projectId);
    const lanes = c.lanes.map(l =>
      `<span class="gx-lane" style="--chip:${esc(l.division.color || 'var(--muted)')}"
         title="${esc(l.division.label)} — ${n1(l.hours)}h at a crew of ${l.crew} = ${l.days} days">
         ${esc(l.division.id)} <b>${l.crew}×</b> <i>${n1(l.days)}d</i></span>`).join('');
    return `<div class="gx-req" data-r="${esc(r.id)}">
      <div class="gx-req-main">
        <div class="row" style="gap:8px;align-items:baseline">
          <b>${esc(r.name)}</b>
          ${p ? `<span class="chip" style="background:${p.color}22;color:${p.color}">${esc(p.code)}</span>` : ''}
          ${c.missesDeadline ? `<span class="chip risk" title="Finishes ${esc(fmtDate(c.finish))}, wanted by ${esc(fmtDate(r.deadline))}">misses deadline by ${n1(Math.abs(c.slackDays))}d</span>`
            : r.deadline ? `<span class="chip ok">${n1(c.slackDays)}d of slack</span>` : ''}
        </div>
        <div class="gx-lanes">${lanes || '<span class="tiny mute">No work on it yet — add some.</span>'}</div>
      </div>
      <div class="gx-req-nums">
        <div><span class="k">Lands</span><b>${c.hours ? esc(fmtDate(c.finish, 'long')) : '—'}</b></div>
        <div><span class="k">Effort</span><b>${n1(c.hours)}h</b><i>${n1(c.effortDays)} person-days</i></div>
        <div><span class="k">Elapsed</span><b>${n1(c.elapsedDays)}d</b><i>${n1(c.elapsedDays / 5)} weeks</i></div>
        <div><span class="k">Cost</span><b>${fmtMoneyFull(c.cost, sym())}</b></div>
      </div>
      <div class="gx-req-acts">
        <button class="btn sm primary" data-act="req-sweep" data-r="${esc(r.id)}" title="One person, two, three — side by side">
          ${icon('chart')}Crew options</button>
        <button class="btn icon sm subtle" data-act="req-menu" data-r="${esc(r.id)}"><svg class="ico"><use href="#i-dots"></use></svg></button>
      </div>
    </div>`;
  }).join('');

  const heads = (scn.extraHeads || []).map(hd =>
    `<span class="gx-head-chip" data-act="head-del" data-v="${esc(hd.id)}" title="Remove">
      +${hd.fte} ${esc(hd.division)} · ${esc(hd.seniority)} from ${esc(fmtDate(hd.from))} ${icon('x')}</span>`).join('');

  const pinch = sim.load.pinchPoints;

  return `
  <div class="gx-scn-body">
    <div class="gx-scn-head">
      <input class="gx-scn-name" data-change="scn-name" value="${esc(scn.name)}" aria-label="Scenario name">
      <div class="spacer" style="flex:1"></div>
      <button class="btn sm" data-act="req-new">${icon('plus')}Add a request</button>
      <button class="btn sm subtle" data-act="head-new">${icon('people')}Add a head</button>
      <button class="btn icon sm subtle" data-act="scn-menu"><svg class="ico"><use href="#i-dots"></use></svg></button>
    </div>

    ${heads ? `<div class="gx-heads">${heads}</div>` : ''}

    ${reqRows || `<div class="gx-scn-empty">
      <b>Nothing in this scenario yet.</b>
      <span>Add the request somebody just asked you for. You will see it land on the Gantt in amber,
      and the capacity strip underneath will turn red wherever it does not fit.</span>
    </div>`}

    <div class="gx-scn-foot">
      <div class="gx-verdict ${pinch.length ? 'bad' : 'good'}">
        ${pinch.length
          ? `<b>${pinch.length} period${pinch.length === 1 ? '' : 's'} do not fit.</b>
             <span>Short ${n1(sim.load.shortfallDays)} person-days in total —
             ${esc(pinch.slice(0, 3).map(x => `${x.period.label} (${x.divisions.map(d => d.division.id).join(', ')})`).join(', '))}${pinch.length > 3 ? '…' : ''}</span>`
          : `<b>Everything fits.</b><span>No division goes over its available days in any period of this window.</span>`}
      </div>
      <div class="gx-verdict-nums">
        <div><span class="k">Added cost</span><b>${fmtMoneyFull(sim.addedCost, sym())}</b>
          <i>${fmtMoney(sim.requestCost, sym())} work${sim.headCost ? ` + ${fmtMoney(sim.headCost, sym())} heads` : ''}</i></div>
        <div><span class="k">Peak load</span><b class="${sim.summary.peakPct > 100 ? 'bad' : ''}">${Number.isFinite(sim.summary.peakPct) ? Math.round(sim.summary.peakPct) + '%' : '∞'}</b>
          <i>busiest division, busiest period</i></div>
      </div>
    </div>
    ${budgetImpact(sim)}
  </div>`;
}

/**
 * What saying yes does to the budget, per project.
 *
 * The schedule question and the money question get asked in the same meeting
 * and are usually answered from two different screens. Since the request
 * already knows which project it is for and what its hours cost at the rate
 * card, the headroom is one subtraction away — and a scenario that fits the
 * team but not the budget is exactly the case a capacity chart on its own
 * would wave through.
 *
 * Only drawn for requests that name a project with a budget: against an
 * unbudgeted project there is no headroom to report, and inventing one would
 * be worse than saying nothing.
 */
function budgetImpact(sim) {
  const byProject = new Map();
  for (const { request: r, calc: c } of sim.requests) {
    if (!r.projectId || !c.cost) continue;
    byProject.set(r.projectId, (byProject.get(r.projectId) || 0) + c.cost);
  }
  if (!byProject.size) return '';

  const rows = [...byProject.entries()].map(([pid, cost]) => {
    const p = S.byId(S.get().projects, pid);
    if (!p || !Number(p.budget)) return '';
    const f = projectFinance(pid);
    const headroom = f.budget - f.forecast;
    const after = headroom - cost;
    return `<div class="gx-budget">
      <span class="chip" style="background:${p.color}22;color:${p.color}">${esc(p.code)}</span>
      <span class="gx-budget-t">Forecast to land ${esc(fmtMoney(f.forecast, sym()))} of ${esc(fmtMoney(f.budget, sym()))} —
        ${headroom >= 0 ? `${esc(fmtMoney(headroom, sym()))} of headroom` : `already ${esc(fmtMoney(-headroom, sym()))} over`}.
        This scenario adds <b>${esc(fmtMoneyFull(cost, sym()))}</b>.</span>
      <b class="${after < 0 ? 'bad' : ''}">${after < 0 ? '−' : '+'}${esc(fmtMoney(Math.abs(after), sym()))}</b>
      <i>${after < 0 ? 'over budget after' : 'still under after'}</i>
    </div>`;
  }).filter(Boolean).join('');

  return rows ? `<div class="gx-budgets">
    <div class="gx-budgets-k">Against the budget</div>${rows}</div>` : '';
}

/* ---------- the pinch-point list ---------------------------------------- */

/**
 * "What am I missing for that particular period", written out.
 *
 * The capacity strip shows it as colour; this says it in days and names the
 * work causing it, which is what you take into the conversation. Only drawn
 * when there is something to say — an empty "no problems" panel is noise.
 */
function pinchPanel(sim) {
  const pp = sim.load.pinchPoints;
  if (!pp.length) return '';
  const hpd = wbSettings().hoursPerDay || 8;

  const rows = pp.slice(0, 12).map(x => {
    const dls = x.divisions.map(d =>
      `<span class="gx-gap" style="--chip:${esc(d.division.color || 'var(--muted)')}">
        ${esc(d.division.id)} <b>−${n1(d.gap)}d</b>
        <i>${Number.isFinite(d.loadPct) ? Math.round(d.loadPct) + '%' : 'no crew'}</i></span>`).join('');
    /* What you could do about it, in the two currencies a producer has. */
    const heads = Math.ceil(x.gap / Math.max(1, x.period.workDays));
    const cost = x.gap * hpd * medianHourly();
    return `<tr>
      <td><b>${esc(x.period.label)}</b><div class="tiny mute">${esc(fmtDate(x.period.from))} → ${esc(fmtDate(x.period.to))}</div></td>
      <td>${dls}</td>
      <td class="num"><b class="bad">−${n1(x.gap)}</b><div class="tiny mute">person-days</div></td>
      <td class="tiny">${heads} extra ${heads === 1 ? 'person' : 'people'} that period,<br>
        or ${fmtMoney(cost, sym())} of outsourcing</td>
    </tr>`;
  }).join('');

  return h`
  <section class="card" style="margin-top:14px">
    <header><h3>Where it does not fit</h3>
      <span class="sub">${pp.length} period${pp.length === 1 ? '' : 's'} · ${n1(sim.load.shortfallDays)} person-days short in total</span>
      <div class="spacer" style="flex:1"></div>
      <button class="btn sm subtle" data-act="csv-pinch">${icon('down')}CSV</button>
    </header>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Period</th><th>Divisions short</th><th class="num">Gap</th><th>What would close it</th></tr></thead>
      <tbody>${raw(rows)}</tbody>
    </table></div>
  </section>`;
}

/** A blended hourly rate for the "what would outsourcing cost" hint. */
function medianHourly() {
  const people = (S.get().people || []).filter(p => p.active !== false && p.seniority);
  if (!people.length) return hourlyRate('Senior');
  const rates = people.map(p => hourlyRate(p.seniority)).sort((a, b) => a - b);
  return rates[Math.floor(rates.length / 2)] || 0;
}

/* ---------- compare ------------------------------------------------------ */

/**
 * Every scenario on one axis.
 *
 * The columns are chosen so the trade is unavoidable: cost barely moves with
 * crew, elapsed time halves, and the shortfall — the thing that actually
 * decides it — doubles. Putting them side by side is the argument.
 */
function compareTab() {
  const base = planWindow(ui.range);
  const projects = ui.projects.length ? new Set(ui.projects) : null;
  const all = [{ id: 'baseline', name: 'As it stands' }, ...scenarios];
  const sims = all.map(x => ({
    scn: x,
    sim: simulate(x.id === 'baseline' ? null : x,
                  { ...base, grain: ui.grain, projects, showTasks: ui.showTasks, useAllocation: ui.useAllocation }),
  }));

  const best = sims.slice(1).filter(x => x.sim.load.shortfallDays < 0.5)
    .sort((a, b) => a.sim.addedCost - b.sim.addedCost)[0];

  return h`
  <section class="card">
    <header><h3>Scenarios side by side</h3>
      <span class="sub">${sims.length} including the baseline · ${esc(ui.range)} window</span>
      <div class="spacer" style="flex:1"></div>
      <button class="btn sm subtle" data-act="tab" data-v="gantt">${icon('board')}Back to the chart</button>
    </header>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr>
        <th>Scenario</th><th class="num">Extra work</th><th class="num">Added cost</th>
        <th class="num">Peak load</th><th class="num">Short by</th><th>Periods that break</th><th></th>
      </tr></thead>
      <tbody>${raw(sims.map(({ scn, sim }) => {
        const fits = sim.load.shortfallDays < 0.5;
        return `<tr class="${scn.id === activeId ? 'on' : ''}">
          <td><b>${esc(scn.name)}</b>${scn.id === 'baseline' ? '<div class="tiny mute">nothing added</div>'
            : `<div class="tiny mute">${(scn.requests || []).length} request${(scn.requests || []).length === 1 ? '' : 's'}${(scn.extraHeads || []).length ? ` · +${(scn.extraHeads || []).length} head` : ''}</div>`}</td>
          <td class="num">${n1(sim.requests.reduce((n, r) => n + r.calc.hours, 0))}h</td>
          <td class="num">${fmtMoneyFull(sim.addedCost, sym())}</td>
          <td class="num ${sim.summary.peakPct > 100 ? 'bad' : ''}">${Number.isFinite(sim.summary.peakPct) ? Math.round(sim.summary.peakPct) + '%' : '∞'}</td>
          <td class="num ${fits ? '' : 'bad'}"><b>${fits ? '—' : '−' + n1(sim.load.shortfallDays) + 'd'}</b></td>
          <td class="tiny">${sim.load.pinchPoints.length
            ? esc(sim.load.pinchPoints.slice(0, 4).map(x => x.period.label).join(', ')) + (sim.load.pinchPoints.length > 4 ? '…' : '')
            : '<span class="chip ok">none</span>'}</td>
          <td class="act">${scn.id === 'baseline' ? '' :
            `<button class="btn sm subtle" data-act="scn-pick" data-v="${esc(scn.id)}">Open</button>`}</td>
        </tr>`;
      }).join(''))}</tbody>
    </table></div>
    ${raw(best ? `<div class="body"><div class="banner ok">
      ${icon('check')}<div><b>${esc(best.scn.name)} is the cheapest option that fits.</b>
      ${fmtMoneyFull(best.sim.addedCost, sym())} added, no division over its available days.</div></div></div>` : '')}
  </section>`;
}

/* ---------- crew sweep dialog ------------------------------------------- */

/**
 * The literal "what if I put two people on it" screen.
 *
 * One row per crew size, with the four numbers that decide it. The
 * recommendation line is the point: it names the smallest crew that both
 * lands in time and does not break anybody, and says plainly when there
 * isn't one.
 */
async function crewSweepDialog(request, ctx) {
  const base = planWindow(ui.range);
  const scn = activeScenario();
  const sweep = crewSweep(request, scn, { max: 5, ...base, grain: ui.grain, useAllocation: ui.useAllocation });
  const rec = recommendCrew(sweep);

  const body = `
    <p class="dim" style="margin-bottom:12px;max-width:66ch">
      The same work — <b>${esc(request.name)}</b>, ${n1(requestCalc(request).hours)} person-hours — at each crew size.
      Effort does not change with crew, so <b>cost barely moves</b>. What moves is when it lands and
      how hard it leans on the team while it runs.
    </p>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Crew</th><th>Lands</th><th class="num">Elapsed</th><th class="num">Cost</th>
        <th class="num">Peak load</th><th class="num">Short by</th><th>Verdict</th></tr></thead>
      <tbody>${sweep.map(r => {
        const fits = r.shortfallDays < 0.5;
        const ok = r.meetsDeadline && fits;
        return `<tr class="${rec.clean && rec.clean.crew === r.crew ? 'on' : ''}">
          <td><b>${r.crew}</b> ${r.crew === 1 ? 'person' : 'people'}<div class="tiny mute">per division</div></td>
          <td>${esc(fmtDate(r.finish, 'long'))}${request.deadline
            ? `<div class="tiny ${r.meetsDeadline ? 'mute' : 'bad'}">${r.meetsDeadline ? 'in time' : 'after the deadline'}</div>` : ''}</td>
          <td class="num">${n1(r.elapsedDays)}d<div class="tiny mute">${n1(r.elapsedDays / 5)}w</div></td>
          <td class="num">${fmtMoneyFull(r.cost, sym())}</td>
          <td class="num ${r.peakPct > 100 ? 'bad' : ''}">${Number.isFinite(r.peakPct)
            ? Math.round(r.peakPct) + '%' : '<span title="A division in this request has nobody in it">no crew</span>'}</td>
          <td class="num ${fits ? '' : 'bad'}">${fits ? '—' : '−' + n1(r.shortfallDays) + 'd'}</td>
          <td class="tiny">${ok ? '<span class="chip ok">works</span>'
            : r.unstaffed.length ? `<span class="chip risk">nobody in ${esc(r.unstaffed.map(d => d.id).join(', '))}</span>`
            : !r.meetsDeadline ? '<span class="chip warn">too slow</span>'
            : `<span class="chip risk">overloads ${esc(r.broken.map(b => b.division.id).join(', '))}</span>`}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
    <div class="banner ${rec.unstaffed.length ? 'risk' : rec.clean ? 'ok' : 'warn'}" style="margin-top:14px">
      <div>${rec.unstaffed.length
        ? `<b>Nobody is in ${esc(rec.unstaffed.map(d => d.label).join(', '))}, and this request has work there.</b>
           No crew size changes that — every row is short for a reason more people on the other
           divisions cannot fix. Staff it, outsource that part, or move those hours.
           ${rec.cleanIgnoringUnstaffed
             ? `Setting it aside, a crew of <b>${rec.cleanIgnoringUnstaffed.crew}</b> covers everything else.` : ''}`
        : rec.clean
        ? `<b>A crew of ${rec.clean.crew} is the smallest that works.</b>
           It lands ${esc(fmtDate(rec.clean.finish, 'long'))}${request.deadline ? ', inside the deadline' : ''},
           and no division goes over its available days.`
        : rec.meetsDeadline
        ? `<b>No crew size fits without overloading somebody.</b>
           A crew of ${rec.meetsDeadline.crew} would hit the date but leaves
           ${n1(rec.meetsDeadline.shortfallDays)} person-days uncovered — that is the gap to close
           with a hire, outsourcing, or moving other work.`
        : `<b>No crew size hits the deadline.</b>
           Even at ${sweep[sweep.length - 1].crew} people it lands ${esc(fmtDate(sweep[sweep.length - 1].finish, 'long'))}.
           The date has to move, or the scope does.`}</div>
    </div>`;

  const pick = await dialog({
    title: `Crew options — ${request.name}`, wide: true, body,
    footer: `<button class="btn" data-no>Close</button>
      ${sweep.map(r => `<button class="btn ${rec.clean && rec.clean.crew === r.crew ? 'primary' : 'subtle'} sm"
         data-pick="${r.crew}">Use ${r.crew}</button>`).join('')}`,
    onMount: ({ root, close }) => {
      root.querySelector('[data-no]').onclick = () => close(undefined);
      root.querySelectorAll('[data-pick]').forEach(b => { b.onclick = () => close(Number(b.dataset.pick)); });
    },
  });

  if (!pick) return false;
  const divs = [...new Set((request.lines || []).map(l => l.division))];
  request.crew = Object.fromEntries(divs.map(d => [d, pick]));
  toast(`Crew set to ${pick} per division`, 'ok');
  return true;
}

/* ---------- request editor ---------------------------------------------- */

/**
 * The five-minute form.
 *
 * Hours per division and a wanted date, because that is what a producer has
 * when somebody walks over. Anything more precise belongs in a
 * work-breakdown estimate, and there is a button to promote it into one.
 */
async function editRequest(existing) {
  const s = S.get();
  const divs = wbDivisions();
  const r = existing ? { ...existing, lines: (existing.lines || []).map(l => ({ ...l })) } : newRequest();

  const laneRow = d => {
    const line = (r.lines || []).find(l => l.division === d.id);
    return `<tr data-d="${esc(d.id)}">
      <td><span class="pill-div" style="background:${esc(d.color || 'var(--muted)')}">${esc(d.id)}</span>
        <span style="margin-left:7px">${esc(d.label)}</span></td>
      <td><input type="number" min="0" step="1" class="rq-h" value="${line ? esc(line.hours) : ''}" placeholder="0" style="width:88px"></td>
      <td><input type="number" min="0" step="1" class="rq-c" value="${esc(reqCrew(r, d.id))}" style="width:66px"></td>
      <td><select class="rq-s">${SENIORITY.map(x =>
        `<option value="${esc(x)}"${(line?.seniority || defaultSeniority(d.id)) === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></td>
      <td class="num tiny mute rq-out">—</td>
    </tr>`;
  };

  const body = `
    <div style="display:grid;grid-template-columns:repeat(12,1fr);gap:0 12px">
      <label class="fld" style="grid-column:span 6"><span>What is being asked for *</span>
        <input id="rq_name" value="${esc(r.name)}" placeholder="e.g. Halloween event art pass"></label>
      <label class="fld" style="grid-column:span 6"><span>Project</span>
        <select id="rq_proj"><option value="">— none —</option>${s.projects.filter(p => p.status !== 'archived')
          .map(p => `<option value="${esc(p.id)}"${p.id === r.projectId ? ' selected' : ''}>${esc(p.code)} · ${esc(p.name)}</option>`).join('')}</select></label>
      <label class="fld" style="grid-column:span 4"><span>Earliest start</span>
        <input type="date" id="rq_start" value="${esc(r.start)}"></label>
      <label class="fld" style="grid-column:span 4"><span>Wanted by</span>
        <input type="date" id="rq_dl" value="${esc(r.deadline)}">
        <span class="hint">Leave blank if there is no date yet</span></label>
      <label class="fld" style="grid-column:span 4"><span>Disciplines run</span>
        <select id="rq_par">
          <option value="1"${r.parallel !== false ? ' selected' : ''}>In parallel — together</option>
          <option value="0"${r.parallel === false ? ' selected' : ''}>Sequentially — a hand-off chain</option>
        </select></label>
    </div>

    <h4 style="margin:14px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-mute)">
      Effort per division</h4>
    <div class="tbl-wrap"><table class="tbl compact">
      <thead><tr><th>Division</th><th>Hours</th><th>Crew</th><th>Costed at</th><th class="num">Elapsed</th></tr></thead>
      <tbody>${divs.map(laneRow).join('')}</tbody>
    </table></div>
    <div class="gx-req-live banner" style="margin-top:12px"><div id="rq_live">—</div></div>`;

  const read = root => {
    const lines = [], crew = {};
    root.querySelectorAll('tbody tr[data-d]').forEach(tr => {
      const d = tr.dataset.d;
      const hours = Number(tr.querySelector('.rq-h').value) || 0;
      crew[d] = Math.max(0, Math.floor(Number(tr.querySelector('.rq-c').value) || 0));
      if (hours > 0) lines.push({ division: d, hours, seniority: tr.querySelector('.rq-s').value });
    });
    return {
      ...r,
      name: root.querySelector('#rq_name').value.trim() || 'Request',
      projectId: root.querySelector('#rq_proj').value,
      start: root.querySelector('#rq_start').value || nextWorkDay(today()),
      deadline: root.querySelector('#rq_dl').value || '',
      parallel: root.querySelector('#rq_par').value === '1',
      lines, crew,
    };
  };

  const out = await dialog({
    title: existing ? 'Edit request' : 'A new request has come in', wide: true, body,
    footer: `<button class="btn" data-no>Cancel</button>
             <button class="btn primary" data-ok>${existing ? 'Save' : 'Add to scenario'}</button>`,
    onMount: ({ root, close }) => {
      const live = root.querySelector('#rq_live');
      const repaint = () => {
        const draft = read(root);
        const c = requestCalc(draft);
        root.querySelectorAll('tbody tr[data-d]').forEach(tr => {
          const lane = c.lanes.find(l => l.division.id === tr.dataset.d);
          tr.querySelector('.rq-out').textContent = lane
            ? `${n1(lane.days)}d${lane.unstaffed ? ' · no crew' : ''}` : '—';
          tr.querySelector('.rq-out').classList.toggle('bad', !!lane?.unstaffed);
        });
        live.innerHTML = c.hours
          ? `<b>${n1(c.hours)} person-hours</b> · ${n1(c.effortDays)} person-days ·
             runs <b>${n1(c.elapsedDays)} working days</b> ·
             lands <b>${esc(fmtDate(c.finish, 'long'))}</b> ·
             <b>${esc(fmtMoneyFull(c.cost, sym()))}</b>
             ${c.missesDeadline ? `<span class="chip risk" style="margin-left:6px">misses the deadline by ${n1(Math.abs(c.slackDays))} days</span>` : ''}
             ${!c.missesDeadline && draft.deadline ? `<span class="chip ok" style="margin-left:6px">${n1(c.slackDays)} days of slack</span>` : ''}`
          : 'Put some hours against a division and the numbers appear here.';
      };
      root.addEventListener('input', repaint);
      root.addEventListener('change', repaint);
      repaint();
      root.querySelector('[data-no]').onclick = () => close(undefined);
      root.querySelector('[data-ok]').onclick = () => {
        const draft = read(root);
        if (!draft.lines.length) { toast('Put hours against at least one division', 'warn'); return; }
        close(draft);
      };
    },
  });
  return out || null;
}

/**
 * Promote a request into a real work-breakdown estimate.
 *
 * The bridge between "somebody asked" and "we have quoted it". One catalogue
 * line per division carrying the agreed hours, so the estimate opens with the
 * right total and can then be broken down properly — rather than making the
 * producer retype what they already told this screen.
 */
function requestToEstimate(r) {
  const c = requestCalc(r);
  const est = newEstimate({
    name: r.name,
    projectId: r.projectId,
    startDate: r.start,
    parallel: r.parallel !== false,
    crew: { ...r.crew },
    /* The uplift is already inside the request's hours, so it must not be
       applied a second time by the estimate. */
    reviewPct: 0, contingencyPct: 0,
    notes: `Promoted from a planning request on ${today()}.`
         + (r.deadline ? ` Wanted by ${r.deadline}.` : '')
         + ` Review and contingency are already inside these hours.`,
    lines: c.lanes.map(l => ({
      id: S.uid('wbl'), itemId: '', division: l.division.id,
      name: `${l.division.label} — agreed scope`,
      baseHours: Math.round(l.hours * 10) / 10,
      complexity: 'normal', approach: 'new', qty: 1,
      seniority: l.seniority, note: 'From a planning request; refine against the catalogue.',
    })),
  });
  saveEstimate(est);
  return est;
}

/* ---------- the view ----------------------------------------------------- */

export default {
  id: 'plan', title: 'Plan', icon: 'cal', group: 'projects', exact: true,
  subtitle: 'Every project on one calendar, against the team you actually have',

  actions: ctx => [
    { label: 'New request', icon: 'plus', primary: true, run: async () => {
      let scn = activeScenario();
      if (!scn) {
        scn = newScenario({ name: 'What if…' });
        scenarios.push(scn); activeId = scn.id;
      }
      const r = await editRequest(null);
      if (!r) return;
      scn.requests.push(r);
      ctx.rerender();
    } },
  ],

  render(host, ctx) {
    const s = S.get();

    if (!s.projects.filter(p => p.status !== 'archived').length) {
      host.innerHTML = h`<div class="card"><div class="empty">
        ${icon('cal')}
        <h4>No live projects yet</h4>
        <div class="tiny" style="max-width:60ch;margin:0 auto">
          The Plan draws every project, its scopes and its estimated tasks on one calendar and
          checks them against the team's real capacity. Add a project first, or import your
          data from the workbooks in your local folder — <b>Workspace → Excel Sync</b>.
        </div>
        <div style="margin-top:12px"><button class="btn primary sm" data-act="go-proj">Open Projects</button></div>
      </div></div>`;
      acts(host, { 'go-proj': () => ctx.go('projects') });
      return;
    }

    if (ui.tab === 'compare') {
      host.innerHTML = h`${raw(toolbar())}${raw(compareTab())}`;
      wireCommon(host, ctx);
      return;
    }

    const sim = runSim();
    const geo = geometry(sim.from, sim.to, zoomOf(ui.zoom).dayPx);
    const periodLines = sim.periods.map(p => p.from);
    const divFilter = ui.divisions.length ? new Set(ui.divisions) : null;

    const footer = ui.showCapacity
      ? capacityStripHTML(sim.load, geo, { onlyDivisions: divFilter, sym: sym() })
      : '';

    host.innerHTML = h`
      ${raw(toolbar())}
      ${raw(headline(sim))}
      ${raw(coverageBanner(sim))}
      <section class="card gx-card">
        <header>
          <h3>${esc(activeId === 'baseline' ? 'The plan' : activeScenario()?.name || 'Scenario')}</h3>
          <span class="sub">${sim.bars.filter(b => b.kind !== 'project').length} pieces of work ·
            ${esc(fmtDate(sim.from))} → ${esc(fmtDate(sim.to))}</span>
          <div class="spacer" style="flex:1"></div>
          <span class="gx-key"><i class="k-plan"></i>committed</span>
          <span class="gx-key"><i class="k-scn"></i>scenario</span>
          <span class="gx-key"><i class="k-late"></i>late / misses</span>
        </header>
        ${raw(ganttHTML({
          bars: sim.bars, from: sim.from, to: sim.to, zoom: ui.zoom,
          collapsed, periods: periodLines, footer, sym: sym(), height: ui.height,
          emptyMsg: 'Nothing scheduled in this window. Log a work-breakdown estimate, '
                  + 'give a task an estimate and a due date, or add a request below.',
        }))}
        <div class="gx-hintbar tiny mute">
          Click a row name to fold it · drag a bar to move it · drag its right edge to change
          how long it may take — the app answers with the crew that would need ·
          click a capacity cell to see what is in it ·
          <b>drag the bar at the very bottom to make the chart taller</b>
        </div>
      </section>

      ${raw(pinchPanel(sim))}
      ${raw(scenarioBar(sim))}`;

    wireCommon(host, ctx);

    const teardown = wireGantt(host, {
      onFold: id => {
        if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
        ctx.rerender();
      },
      onOpen: b => openBar(b, ctx),
      onMilestone: m => ctx.go('projects', m.projectId, 'milestones'),
      onMove: d => moveBar(d, ctx),
      onResize: d => resizeBar(d, ctx),
      onCell: c => cellDetail(c, sim),
      /* Remembered, but NOT re-rendered: the drag has already set the CSS
         variable on the live element, so re-rendering here would rebuild the
         whole chart mid-gesture and throw the scroll position away. */
      onHeight: px => { ui.height = px; saveUi(); },
    });

    scrollToToday(host, { from: sim.from, to: sim.to, zoom: ui.zoom });
    return teardown;
  },
};

/* ---------- headline ----------------------------------------------------- */

function headline(sim) {
  const s = S.get();
  const live = s.projects.filter(p => p.status !== 'archived').length;
  const pieces = sim.bars.filter(b => b.demand && !b.scenario).length;
  const totalSupply = sim.supply.total.reduce((a, b) => a + b, 0);
  const scheduled = sim.load.rows.reduce((a, r) => a + r.totalScheduled, 0);
  const extra = sim.load.rows.reduce((a, r) => a + r.totalExtra, 0);
  const totalDemand = sim.load.totals.reduce((a, t) => a + t.needed, 0);
  const util = totalSupply > 0 ? (totalDemand / totalSupply) * 100 : 0;

  return h`<div class="grid g4" style="margin-bottom:14px">
    <div class="card stat"><div class="k">Live projects</div><div class="v">${live}</div>
      <div class="d">${pieces} scheduled pieces of work</div></div>
    <div class="card stat"><div class="k">Work on the calendar</div>
      <div class="v">${n1(scheduled)}<span style="font-size:14px;font-weight:400">d</span></div>
      <div class="d">${extra > 0.05 ? `+${n1(extra)}d from this scenario` : 'person-days of itemised work'}</div></div>
    <div class="card stat"><div class="k">Team capacity</div>
      <div class="v">${n1(totalSupply)}<span style="font-size:14px;font-weight:400">d</span></div>
      <div class="d">after part-time, leave and holidays</div></div>
    <div class="card stat"><div class="k">Peak load</div>
      <div class="v" style="color:${util > 100 ? 'var(--risk)' : util > 85 ? 'var(--warn)' : 'var(--text)'}">${
        Number.isFinite(sim.summary.peakPct) ? Math.round(sim.summary.peakPct) + '%' : '∞'}</div>
      <div class="d ${sim.load.shortfallDays > 0.5 ? 'down' : ''}">${sim.load.shortfallDays > 0.5
        ? `${n1(sim.load.shortfallDays)} person-days short somewhere`
        : 'nothing over capacity'}</div></div>
  </div>`;
}

/**
 * How much of the team's time the board actually accounts for.
 *
 * The one thing a capacity chart must not do is imply it knows about work it
 * has never been told about. On most teams the majority of what people do is
 * not a task with an estimate and a due date, and a strip reading 8% would
 * then cheerfully say yes to anything.
 *
 * So rather than silently choosing a model, the screen states the gap
 * between what is itemised and what people are allocated to, and puts the
 * strict reading one click away. When the two agree — a team whose work
 * really is all on the board — the banner disappears, because then there is
 * nothing to warn about.
 */
function coverageBanner(sim) {
  const scheduled = sim.load.rows.reduce((a, r) => a + r.totalScheduled, 0);
  const allocated = sim.load.rows.reduce((a, r) => a + r.totalAllocated, 0);
  const supply = sim.supply.total.reduce((a, b) => a + b, 0);
  if (supply <= 0) return '';

  const covered = allocated > 0 ? (scheduled / allocated) * 100 : 100;
  if (ui.useAllocation) {
    return h`<div class="banner warn">${icon('info')}<div>
      <b>Reading capacity from allocation.</b>
      Every division counts as busy to the share of it promised to a project
      (${n1(allocated)} of ${n1(supply)} person-days), whether or not that work is on the
      board. That is the strict reading — a fully allocated team has no room for anything new
      without something else moving.
      <button class="btn sm subtle" data-act="alloc-off" style="margin-left:8px">Read the board instead</button>
    </div></div>`;
  }
  if (covered >= 80 || allocated < 1) return '';

  return h`<div class="banner">${icon('info')}<div>
    <b>The board accounts for ${Math.round(covered)}% of what the team is allocated to.</b>
    ${n1(scheduled)} person-days of itemised work against ${n1(allocated)} allocated —
    so the capacity strip below is measuring against work you have written down, not against
    everything people are actually doing. Add work-breakdown scopes to close the gap, or
    switch to the strict reading.
    <button class="btn sm subtle" data-act="alloc-on" style="margin-left:8px">Count allocation</button>
  </div></div>`;
}

/* ---------- interactions ------------------------------------------------- */

function openBar(b, ctx) {
  if (b.kind === 'project') return ctx.go('projects', b.ref);
  if (b.kind === 'task') return import('./tasks.js').then(m => m.editTask(b.ref).then(r => r && ctx.rerender()));
  if (b.kind === 'scope' || (b.kind === 'division' && b.id.startsWith('scope:'))) {
    return ctx.go('gfxwb', 'estimates');
  }
  if (b.kind === 'request' || b.id.startsWith('request:')) {
    const scn = activeScenario();
    const r = scn?.requests.find(x => x.id === b.ref);
    if (r) editRequest(r).then(next => {
      if (!next) return;
      Object.assign(r, next);
      ctx.rerender();
    });
  }
}

/**
 * A bar was dragged sideways. What that writes depends on what it is, and in
 * every case it is one deliberate change with an undo entry behind it.
 */
function moveBar({ ref, kind, newStart, newEnd }, ctx) {
  /* Dropped on a Saturday means the next Monday. Nudging is the only liberty
     taken with the gesture — the bar otherwise lands where it was put. */
  if (kind === 'scope') {
    const e = wbEstimates().find(x => x.id === ref);
    if (!e) return;
    const next = nextWorkDay(newStart);
    saveEstimate({ ...e, startDate: next });
    toast(`“${e.name || 'Estimate'}” now starts ${fmtDate(next, 'long')}`, 'ok');
  } else if (kind === 'task') {
    const t = S.get().tasks.find(x => x.id === ref);
    if (!t || !t.due) return;
    /* A task's bar ENDS on its due date, so moving the bar moves the due
       date, not a start date it does not have. */
    const next = nextWorkDay(newEnd);
    S.update('tasks', ref, { due: next }, { label: 'move task' });
    toast(`“${t.title}” is now due ${fmtDate(next, 'long')}`, 'ok');
  } else if (kind === 'request') {
    const scn = activeScenario();
    const r = scn?.requests.find(x => x.id === ref);
    if (!r) return;
    r.start = nextWorkDay(newStart);
  }
  ctx.rerender();
}

/**
 * A bar's right edge was dragged. Effort is fixed, so a shorter bar is a
 * statement about crew — and the app answers with the crew it would take
 * rather than silently accepting an impossible date.
 */
async function resizeBar({ ref, kind, newEnd }, ctx) {
  const hpd = wbSettings().hoursPerDay || 8;

  if (kind === 'request') {
    const scn = activeScenario();
    const r = scn?.requests.find(x => x.id === ref);
    if (!r) return;
    const avail = Math.max(1, workDaysBetween(r.start, newEnd) + 1);
    const c = requestCalc(r);
    const need = {};
    for (const l of c.lanes) need[l.division.id] = Math.max(1, Math.ceil(l.hours / hpd / avail));
    const list = c.lanes.map(l => `${l.division.id}: ${need[l.division.id]}`).join(' · ');
    const ok = await confirmDlg(
      `Finishing by ${fmtDate(newEnd, 'long')} means ${avail} working days.\n\n`
      + `For that, each division needs — ${list}\n\n`
      + `Set those crew sizes, and record ${fmtDate(newEnd)} as the deadline?`,
      { title: 'Change how long it may take', ok: 'Set the crew', danger: false });
    if (!ok) { ctx.rerender(); return; }
    r.crew = { ...r.crew, ...need };
    r.deadline = newEnd;
    ctx.rerender();
    return;
  }

  if (kind === 'scope') {
    const e = wbEstimates().find(x => x.id === ref);
    if (!e) { ctx.rerender(); return; }
    const start = e.startDate || today();
    const avail = Math.max(1, workDaysBetween(start, newEnd) + 1);
    const { calc } = scopeBars(e);
    const need = {};
    for (const d of calc.byDivision) {
      if (!d.hours) continue;
      need[d.division.id] = Math.max(1, Math.ceil(d.hours * (1 + calc.upliftPct / 100) / hpd / avail));
    }
    const list = Object.entries(need).map(([k, v]) => `${k}: ${v}`).join(' · ');
    const ok = await confirmDlg(
      `Finishing by ${fmtDate(newEnd, 'long')} means ${avail} working days.\n\n`
      + `For that, each division needs — ${list}\n\n`
      + `Set those crew sizes on “${e.name || 'this estimate'}”?`,
      { title: 'Change how long it may take', ok: 'Set the crew', danger: false });
    if (!ok) { ctx.rerender(); return; }
    saveEstimate({ ...e, crew: { ...(e.crew || {}), ...need } });
    toast('Crew updated', 'ok');
    ctx.rerender();
    return;
  }

  if (kind === 'task') {
    /* A task's bar length is its estimate; changing the length is changing
       the estimate, which is a claim about the work and not one a drag
       should make silently. */
    const t = S.get().tasks.find(x => x.id === ref);
    if (!t) { ctx.rerender(); return; }
    const days = Math.max(1, workDaysBetween(t.due, newEnd) + 1);
    const ok = await confirmDlg(
      `Set the estimate for “${t.title}” to ${n1(days * hpd)} hours (${days} days) and the due date to ${fmtDate(newEnd)}?`,
      { title: 'Re-estimate this task', ok: 'Update', danger: false });
    if (ok) S.update('tasks', ref, { estimate: Math.round(days * hpd), due: newEnd }, { label: 're-estimate task' });
    ctx.rerender();
  }
}

/** What is inside one capacity cell — the click-through from a red week. */
function cellDetail({ divisionId, index }, sim) {
  const row = sim.load.rows.find(r => r.division.id === divisionId);
  if (!row) return;
  const c = row.cells[index];
  const parts = c.contributors.slice().sort((a, b) => b.days - a.days);
  const people = sim.supply.rows.filter(r => r.division === divisionId && r.days[index] > 0)
    .sort((a, b) => b.days[index] - a.days[index]);

  dialog({
    title: `${row.division.label} · ${c.period.label}`,
    wide: true,
    body: `
      <div class="grid g4" style="margin-bottom:14px">
        <div class="card stat"><div class="k">Available</div><div class="v">${n1(c.available)}<span style="font-size:14px;font-weight:400">d</span></div>
          <div class="d">${people.length} ${people.length === 1 ? 'person' : 'people'}, after leave</div></div>
        <div class="card stat"><div class="k">Already committed</div><div class="v">${n1(c.committed)}<span style="font-size:14px;font-weight:400">d</span></div>
          <div class="d">${c.source === 'allocation'
            ? `from allocation — ${n1(c.scheduled)}d of it itemised`
            : `all itemised: ${parts.filter(p => !p.bar.scenario).length} piece${parts.filter(p => !p.bar.scenario).length === 1 ? '' : 's'}`}</div></div>
        <div class="card stat"><div class="k">This scenario adds</div>
          <div class="v">${c.extra > 0.005 ? '+' + n1(c.extra) : '—'}${c.extra > 0.005 ? '<span style="font-size:14px;font-weight:400">d</span>' : ''}</div>
          <div class="d">on top of the committed plan</div></div>
        <div class="card stat"><div class="k">${c.gap > 0 ? 'Short by' : 'Spare'}</div>
          <div class="v" style="color:${c.gap > 0.05 ? 'var(--risk)' : 'var(--ok)'}">${n1(Math.abs(c.gap))}<span style="font-size:14px;font-weight:400">d</span></div>
          <div class="d">${Number.isFinite(c.loadPct) ? Math.round(c.loadPct) + '% loaded' : 'nobody on this division'}</div></div>
      </div>
      ${c.source === 'allocation' ? `<div class="banner" style="margin-bottom:14px"><div>
        <b>This period is set by allocation, not by the board.</b>
        ${n1(c.allocated)} person-days of this division are promised to projects, and only
        ${n1(c.scheduled)} of those are written down as scheduled work. The gap is real work
        nobody has itemised — turn <b>Allocation</b> off in the toolbar to read the board alone.
      </div></div>` : ''}
      <h4 style="margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-mute)">What is drawing on it</h4>
      <div class="tbl-wrap"><table class="tbl compact">
        <thead><tr><th>Work</th><th>Project</th><th class="num">Days this period</th></tr></thead>
        <tbody>${parts.map(p => `<tr>
          <td>${esc(p.bar.label)}${p.bar.scenario ? ' <span class="chip warn">scenario</span>' : ''}</td>
          <td class="tiny mute">${esc(S.projectName(p.bar.projectId) || '—')}</td>
          <td class="num">${n1(p.days)}</td></tr>`).join('')
          || '<tr><td colspan="3" class="tiny mute" style="padding:16px;text-align:center">Nothing scheduled here.</td></tr>'}</tbody>
      </table></div>
      <h4 style="margin:14px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-mute)">Who is available</h4>
      <div class="tbl-wrap"><table class="tbl compact">
        <thead><tr><th>Person</th><th>Rung</th><th class="num">Days</th></tr></thead>
        <tbody>${people.map(p => `<tr>
          <td>${esc(p.person.name)}${p.scenario ? ' <span class="chip warn">scenario hire</span>' : ''}</td>
          <td class="tiny mute">${esc(p.person.seniority || '—')}</td>
          <td class="num">${n1(p.days[index])}</td></tr>`).join('')
          || '<tr><td colspan="3" class="tiny mute" style="padding:16px;text-align:center">Nobody in this division is available.</td></tr>'}</tbody>
      </table></div>`,
    footer: '<button class="btn primary" data-ok>Close</button>',
    onMount: ({ root, close }) => { root.querySelector('[data-ok]').onclick = () => close(); },
  });
}

/* ---------- wiring ------------------------------------------------------- */

function wireCommon(host, ctx) {
  const re = () => ctx.rerender();

  acts(host, {
    range: el => { ui.range = el.dataset.v; saveUi(); re(); },
    grain: el => { ui.grain = el.dataset.v; saveUi(); re(); },
    'gx-zoom': el => { ui.zoom = el.dataset.z; saveUi(); re(); },
    tab: el => { ui.tab = el.dataset.v; saveUi(); re(); },
    today: () => {
      const sim = lastSim;
      if (sim) scrollToToday(host, { from: sim.from, to: sim.to, zoom: ui.zoom });
    },
    'fold-all': () => {
      if (collapsed.size) collapsed = new Set();
      else collapsed = new Set((lastSim?.bars || []).filter(b => b.kind === 'project' || b.kind === 'scope').map(b => b.id));
      re();
    },
    'filter-proj': el => { ui.projects = toggleFilter(ui.projects, el.dataset.v); saveUi(); re(); },
    'filter-div':  el => { ui.divisions = toggleFilter(ui.divisions, el.dataset.v); saveUi(); re(); },

    'scn-new': () => {
      const n = newScenario({ name: `Scenario ${scenarios.length + 1}` });
      scenarios.push(n); activeId = n.id; ui.tab = 'gantt'; saveUi(); re();
    },
    'scn-pick': el => { activeId = el.dataset.v; ui.tab = 'gantt'; saveUi(); re(); },
    'scn-menu': (el, ev) => {
      const scn = activeScenario(); if (!scn) return;
      menu(ev, [
        { label: 'Duplicate', icon: 'plus', run: () => {
          const copy = { ...newScenario(), name: scn.name + ' (copy)',
                         requests: scn.requests.map(r => ({ ...r, id: S.uid('req') })),
                         crew: { ...scn.crew }, shift: { ...scn.shift },
                         extraHeads: scn.extraHeads.map(x => ({ ...x })) };
          scenarios.push(copy); activeId = copy.id; re();
        } },
        { label: 'Commit its requests as estimates…', icon: 'save', run: async () => {
          if (!scn.requests.length) { toast('Nothing to commit', 'warn'); return; }
          const ok = await confirmDlg(
            `Turn ${scn.requests.length} request${scn.requests.length === 1 ? '' : 's'} into saved work-breakdown estimates?\n\n`
            + 'This is the one action on this screen that writes to your data. '
            + 'The estimates appear in GFX WB → Estimates as drafts, and you can undo it with Ctrl+Z.',
            { title: 'Commit this scenario', ok: 'Commit', danger: false });
          if (!ok) return;
          const made = scn.requests.map(requestToEstimate);
          toast(`${made.length} estimate${made.length === 1 ? '' : 's'} saved as drafts`, 'ok');
          re();
        } },
        '-',
        { label: 'Delete scenario', icon: 'trash', danger: true, run: () => {
          scenarios = scenarios.filter(x => x.id !== scn.id);
          activeId = 'baseline'; re();
        } },
      ]);
    },

    'req-new': async () => {
      const scn = activeScenario(); if (!scn) return;
      const r = await editRequest(null);
      if (r) { scn.requests.push(r); re(); }
    },
    'req-sweep': async el => {
      const scn = activeScenario(); if (!scn) return;
      const r = scn.requests.find(x => x.id === el.dataset.r);
      if (r && await crewSweepDialog(r, ctx)) re();
    },
    'req-menu': (el, ev) => {
      const scn = activeScenario(); if (!scn) return;
      const id = el.dataset.r;
      const r = scn.requests.find(x => x.id === id); if (!r) return;
      menu(ev, [
        { label: 'Edit…', icon: 'edit', run: async () => {
          const next = await editRequest(r);
          if (next) { Object.assign(r, next); re(); }
        } },
        { label: 'Crew options…', icon: 'chart', run: async () => { if (await crewSweepDialog(r, ctx)) re(); } },
        { label: 'Save as a work-breakdown estimate', icon: 'save', run: () => {
          const e = requestToEstimate(r);
          toast(`Saved “${e.name}” as a draft estimate`, 'ok');
        } },
        '-',
        { label: 'Remove from scenario', icon: 'trash', danger: true, run: () => {
          scn.requests = scn.requests.filter(x => x.id !== id); re();
        } },
      ]);
    },

    'head-new': async () => {
      const scn = activeScenario(); if (!scn) return;
      const divs = wbDivisions();
      const out = await formDlg('Add a pair of hands', [
        { k: 'division', label: 'Division', type: 'select', span: 6,
          opts: divs.map(d => ({ v: d.id, t: d.label })) },
        { k: 'seniority', label: 'Rung', type: 'select', span: 6, value: 'Senior',
          opts: SENIORITY.map(x => ({ v: x, t: x })) },
        { k: 'fte', label: 'How much of a person', type: 'number', span: 6, value: 1, step: '0.5', min: 0,
          hint: '1 = full time. 0.5 = half a contractor.' },
        { k: 'from', label: 'Starting', type: 'date', span: 6, value: nextWorkDay(today()) },
      ], { ok: 'Add' });
      if (!out) return;
      scn.extraHeads.push({ id: S.uid('hd'), ...out, fte: Number(out.fte) || 1,
                            label: `New ${out.division}` });
      re();
    },
    'head-del': el => {
      const scn = activeScenario(); if (!scn) return;
      scn.extraHeads = scn.extraHeads.filter(x => x.id !== el.dataset.v);
      re();
    },

    'csv-pinch': () => {
      const sim = lastSim; if (!sim) return;
      const rows = sim.load.pinchPoints.flatMap(x => x.divisions.map(d => ({
        Period: x.period.label, From: x.period.from, To: x.period.to,
        Division: d.division.id,
        'Short (person-days)': Math.round(d.gap * 10) / 10,
        'Load %': Number.isFinite(d.loadPct) ? Math.round(d.loadPct) : '',
      })));
      if (!rows.length) { toast('Nothing to export — it all fits', 'ok'); return; }
      download(`gfx-plan-gaps-${today()}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
    },

    /* `acts` also binds [data-change], so these belong in the same map rather
       than in a second listener that would have to be torn down separately. */
    'show-tasks': el => { ui.showTasks = el.checked; saveUi(); re(); },
    'show-cap':   el => { ui.showCapacity = el.checked; saveUi(); re(); },
    'use-alloc':  el => { ui.useAllocation = el.checked; saveUi(); re(); },
    'alloc-on':  () => { ui.useAllocation = true;  saveUi(); re(); },
    'alloc-off': () => { ui.useAllocation = false; saveUi(); re(); },
    'scn-name':   el => { const x = activeScenario(); if (x) x.name = el.value.trim() || 'Scenario'; re(); },
  });
}

const toggleFilter = (list, v) => {
  if (!v) return [];
  return list.includes(v) ? list.filter(x => x !== v) : [...list, v];
};

/* Exported so other views can drop a reader onto the same simulation without
   duplicating the window logic — see views/gfxwb.js and views/projects.js. */
export { runSim as planSimulation, ui as planUi };
