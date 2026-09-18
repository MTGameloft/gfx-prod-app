/* ============================================================================
   views/gfxwb.js — GFX WB: the work breakdown, and what it costs.

   Four tabs, in the order the work happens:

     Calculator  build a deliverable out of catalogue items and read off the
                 effort, the duration, the cost and whether the team can take it
     Estimates   what has been quoted, and the roll-up across all of it
     Catalogue   the work items and their base eyeball ETAs
     Rates       hourly cost per rung, and the factors the maths uses

   The maths lives in js/wb.js and is pure, so this file only renders it. See
   that file for why effort and duration are two numbers rather than one.
   ========================================================================= */

import * as S from '../store.js';
import {
  h, raw, esc, icon, toast, dialog, formDlg, confirmDlg, menu, acts, bar,
  fmtDate, fmtMoney, fmtMoneyFull, fmtNum, today, addDays, download, toCsv, clamp,
} from '../ui.js';
import { SENIORITY, thisMonth } from '../calc.js';
/* The Schedule panel is the Plan screen's chart and the Plan screen's maths,
   reused rather than reimplemented — two tools that answer "what if two
   people did it" with two different numbers is worse than having one. */
import {
  scopeBars, crewSweep, recommendCrew, workCalendar, periodGrid, supply,
  loadGrid, nextWorkDay,
} from '../plan.js';
import { ganttHTML, capacityStripHTML, wireGantt, geometry, zoomOf } from '../gantt.js';
import { bulkQueueDialog } from '../jiraui.js';
import { openExternal } from '../teams.js';
import {
  wbDivisions, WB_APPROACHES, WB_COMPLEXITY, wbDivision, wbApproach, wbComplexity,
  wbSettings, setWbSetting, hourlyRate, rateLadder, defaultSeniority,
  wbItems, wbItem, itemsByDivision, wbEstimates, wbEstimate, newEstimate, newLine,
  estimate, feasibility, rollUp, saveEstimate, removeEstimate, saveItem, removeItem,
  estimateToTasks, crewOf, logEstimate, unlogEstimate, isLogged, logRollUp,
  wbPresets, wbPreset, savePreset, removePreset, linesToPreset,
} from '../wb.js';

const TABS = [
  { id: 'calc',      label: 'Calculator' },
  { id: 'estimates', label: 'Estimates' },
  { id: 'log',       label: 'Log' },
  { id: 'catalogue', label: 'Catalogue' },
  { id: 'rates',     label: 'Rates' },
];
const tabOf = v => TABS.find(t => t.id === v) ? v : 'calc';

const sym = () => S.get().settings.currencySymbol || '$';
/* An unstaffed division makes duration infinite. Showing that as "Infinity
   days" reads as a bug; a dash with the reason beside it reads as an answer. */
const n1 = x => (Number.isFinite(x)
  ? (Math.round(x * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 })
  : '—');

/*
 * The estimate being edited, held here rather than in the store.
 *
 * An estimate is a working document — you try a crew of two, look at the
 * number, try three — and writing every keystroke into the store would fill
 * the undo ring with noise and dirty the backup. It is saved when you say so.
 */
let draft = null;
let dirty = false;

/* Which rows of the Schedule chart are folded. Per page load, like the Plan's
   — it is a way of looking at the breakdown, not part of the estimate. */
let wbFolded = new Set();

const UI_KEY = 'gfxwb.ui';
const ui = Object.assign({ catDivision: '', estStatus: '', height: 0 },
  JSON.parse(localStorage.getItem(UI_KEY) || '{}'));
const saveUi = () => localStorage.setItem(UI_KEY, JSON.stringify(ui));

const sel = (list, cur, blank) =>
  (blank ? `<option value="">${esc(blank)}</option>` : '') +
  list.map(o => `<option value="${esc(o.v)}"${String(o.v) === String(cur ?? '') ? ' selected' : ''}>${esc(o.t)}</option>`).join('');

/* ---------- tab 1: the calculator --------------------------------------- */

function calcTab(ctx) {
  const s = S.get();
  if (!draft) draft = newEstimate();
  const r = estimate(draft);
  const cfg = wbSettings();
  const feas = feasibility(draft, thisMonth());

  const totals = h`
  <div class="grid g4" style="margin-bottom:14px">
    <div class="card stat">
      <div class="k">Effort</div><div class="v">${n1(r.totalHours)}<span style="font-size:14px;font-weight:400">h</span></div>
      <div class="d">${n1(r.effortDays)} person-days · ${r.lines.length} line${r.lines.length === 1 ? '' : 's'}</div></div>
    <div class="card stat">
      <div class="k">Duration</div><div class="v">${n1(r.elapsedDays)}<span style="font-size:14px;font-weight:400"> days</span></div>
      <div class="d ${r.unstaffed.length ? 'down' : ''}">${r.unstaffed.length
        ? `no crew on ${esc(r.unstaffed.map(d => d.id).join(', '))} — it never finishes`
        : `${n1(r.elapsedWeeks)} weeks · ${n1(r.elapsedMonths)} months${draft.parallel === false ? ' · sequential' : ' · in parallel'}`}</div></div>
    <div class="card stat">
      <div class="k">Cost</div><div class="v">${fmtMoney(r.totalCost, sym())}</div>
      <div class="d">${fmtMoneyFull(r.baseCost, sym())} + ${r.upliftPct}% review &amp; contingency</div></div>
    <div class="card stat">
      <div class="k">Lands</div>
      <div class="v" style="font-size:19px">${r.finish ? esc(fmtDate(r.finish, 'long')) : '—'}</div>
      <div class="d">${draft.startDate ? 'from ' + esc(fmtDate(draft.startDate)) + ', working days only' : 'set a start date'}</div></div>
  </div>`;

  const head = h`
  <section class="card" style="margin-bottom:14px">
    <div class="body">
      <div style="display:grid;grid-template-columns:repeat(12,1fr);gap:0 12px">
        <label class="fld" style="grid-column:span 6"><span>Deliverable</span>
          <input data-change="f" data-k="name" value="${esc(draft.name)}" placeholder="e.g. 3D Environment — Exterior"></label>
        <label class="fld" style="grid-column:span 4"><span>Project</span>
          <select data-change="f" data-k="projectId">${raw(sel(s.projects.map(p => ({ v: p.id, t: p.name })), draft.projectId, 'None'))}</select></label>
        <label class="fld" style="grid-column:span 2"><span>Start</span>
          <input type="date" data-change="f" data-k="startDate" value="${esc(draft.startDate || '')}"></label>
      </div>

      <div class="sep" style="margin:6px 0 12px"></div>

      <!-- Each block carries its own caption line, so the controls line up
           along one row whether or not a block has a label above it. The
           checkbox used to sit on its own with nothing above it, which pushed
           it below the boxes it belongs beside. -->
      <div class="wb-rows">
        <div class="wb-rowgrp">
          <div class="wb-cap">Crew — divides duration, never cost · 0 = nobody on it</div>
          <div class="wb-ctl">
            ${raw(wbDivisions().filter(d => d.crew).map(d => `
              <label class="wb-num" title="How many ${esc(d.label)} artists are on this">
                <span class="pill-div" style="background:${esc(divColor(d.id))}">${esc(d.id)}</span>
                <input type="number" min="0" step="1" data-change="crew" data-d="${d.id}"
                       value="${crewOf(draft, d.id)}">
              </label>`).join(''))}
          </div>
        </div>
        <div class="wb-rowgrp">
          <div class="wb-cap">Uplift</div>
          <div class="wb-ctl">
            <label class="wb-num" title="Feedback and revision rounds">
              <span class="tiny">Review</span>
              <input type="number" min="0" step="5" data-change="f" data-k="reviewPct" value="${draft.reviewPct}">
              <span class="tiny mute">%</span></label>
            <label class="wb-num" title="The honest admission that estimates are estimates">
              <span class="tiny">Contingency</span>
              <input type="number" min="0" step="5" data-change="f" data-k="contingencyPct" value="${draft.contingencyPct}">
              <span class="tiny mute">%</span></label>
          </div>
        </div>
        <div class="wb-rowgrp">
          <div class="wb-cap">Scheduling</div>
          <div class="wb-ctl">
            <label class="row tiny" style="gap:7px;cursor:pointer;height:32px;align-items:center">
              <input type="checkbox" data-change="parallel" ${draft.parallel === false ? '' : 'checked'}>
              Divisions work in parallel
            </label>
          </div>
        </div>
      </div>
    </div>
  </section>`;

  const lines = h`
  <section class="card" style="margin-bottom:14px">
    <header><h3>Work breakdown</h3>
      <span class="sub">${r.lines.length} line${r.lines.length === 1 ? '' : 's'} · base × complexity × quantity × approach</span>
      <div class="spacer" style="flex:1"></div>
      <button class="btn sm primary" data-act="add-line">${icon('plus')}Add work item</button>
      <button class="btn sm subtle" data-act="add-preset"${wbPresets().length ? '' : ' disabled title="No presets yet — build a breakdown and use Save as preset"'}>Preset…</button>
      ${raw(r.lines.length ? '<button class="btn sm subtle" data-act="save-preset" title="Keep this breakdown as a reusable preset">Save as preset</button>' : '')}
      ${raw(r.lines.length ? '<button class="btn sm subtle" data-act="clear-lines">Clear</button>' : '')}
      <button class="btn sm subtle" data-act="csv">${icon('down')}CSV</button></header>
    <div class="body flush"><div class="tbl-wrap"><table class="tbl">
      <thead><tr>
        <th style="width:60px">Div</th><th>Work item</th>
        <th style="width:118px">Complexity</th><th style="width:132px">Approach</th>
        <th class="num" style="width:64px">Qty</th><th class="num" style="width:62px">Base h</th>
        <th class="num" style="width:74px">Hours</th><th style="width:120px">Rung</th>
        <th class="num" style="width:92px">Cost</th><th></th>
      </tr></thead>
      <tbody>${raw(r.lines.length ? r.lines.map(l => `<tr data-l="${l.id}">
        <td><span class="pill-div" style="background:${esc(divColor(l.division))}">${esc(l.division)}</span></td>
        <td><b>${esc(l.name)}</b>${l.note ? `<div class="tiny mute">${esc(l.note)}</div>` : ''}</td>
        <td><select data-change="line" data-k="complexity" style="width:100%">${
          sel(WB_COMPLEXITY.map(c => ({ v: c.id, t: `${c.label} ×${c.factor}` })), l.complexity)}</select></td>
        <td><select data-change="line" data-k="approach" style="width:100%"
              title="${esc(l.approachInfo.hint)}">${
          sel(WB_APPROACHES.map(a => ({ v: a.id, t: `${a.label} ×${a.factor}` })), l.approach)}</select></td>
        <td class="num"><input type="number" min="0" step="1" data-change="line" data-k="qty"
              value="${l.qty}" style="width:56px;text-align:right"></td>
        <td class="num tiny mute">${n1(l.baseHours)}</td>
        <td class="num"><b>${n1(l.hours)}</b></td>
        <td><select data-change="line" data-k="seniority" style="width:100%">${
          sel(SENIORITY.map(x => ({ v: x, t: x })), l.seniority || l.seniorityUsed)}</select></td>
        <td class="num">${fmtMoneyFull(l.cost, sym())}</td>
        <td class="act"><button class="btn icon sm subtle" data-act="line-menu"><svg class="ico"><use href="#i-dots"></use></svg></button></td>
      </tr>`).join('') : `<tr><td colspan="10" class="tiny mute" style="padding:26px;text-align:center">
        Nothing yet. <b>Add work item</b> to start, or <b>Preset</b> for a common deliverable.</td></tr>`)}
      </tbody>
      ${raw(r.lines.length ? `<tfoot><tr>
        <td colspan="6" class="tiny mute" style="text-align:right">raw effort</td>
        <td class="num"><b>${n1(r.effortHours)}</b></td><td></td>
        <td class="num"><b>${fmtMoneyFull(r.baseCost, sym())}</b></td><td></td></tr>
        <tr><td colspan="6" class="tiny mute" style="text-align:right">+ ${r.reviewPct}% review + ${r.contPct}% contingency</td>
        <td class="num"><b>${n1(r.totalHours)}</b></td><td></td>
        <td class="num"><b>${fmtMoneyFull(r.totalCost, sym())}</b></td><td></td></tr></tfoot>` : '')}
    </table></div></div>
  </section>`;

  const perDiv = r.byDivision.length ? h`
  <section class="card" style="margin-bottom:14px">
    <header><h3>By division</h3><span class="sub">cost is effort × rung · duration is effort ÷ crew</span></header>
    <div class="body flush"><table class="tbl">
      <thead><tr><th>Division</th><th class="num">Lines</th><th class="num">Effort h</th>
        <th class="num">Crew</th><th class="num">Elapsed days</th><th>Costed at</th><th class="num">Cost</th></tr></thead>
      <tbody>${raw(r.byDivision.map(d => `<tr>
        <td><span class="pill-div" style="background:${esc(divColor(d.division.id))}">${esc(d.division.id)}</span>
          <span class="tiny ${d.division.missing ? '' : 'mute'}" style="margin-left:6px${
            d.division.missing ? ';color:var(--risk)' : ''}"
            ${d.division.missing ? 'title="This division is no longer on the roster. Its hours and cost still count; re-home these lines or add the division back."' : ''}
            >${esc(d.division.label)}</span></td>
        <td class="num tiny">${d.lines}</td>
        <td class="num">${n1(d.hours)}</td>
        <td class="num tiny ${d.unstaffed ? 'overdue' : ''}">${d.division.crew ? d.crew : '—'}</td>
        <td class="num ${d.unstaffed ? 'overdue' : ''}"
            ${d.unstaffed ? 'title="No crew on this division, so this work never finishes. The cost still stands."' : ''}>${n1(d.elapsedDays)}</td>
        <td class="tiny">${esc(d.seniority)} <span class="mute">${fmtMoneyFull(hourlyRate(d.seniority), sym())}/h</span></td>
        <td class="num">${fmtMoneyFull(d.cost, sym())}</td></tr>`).join(''))}</tbody>
    </table></div>
    ${raw(r.byDivision.some(d => d.division.missing) ? `<div class="body" style="padding-top:0">
      <div class="tiny" style="color:var(--risk);line-height:1.7">
        A division in this breakdown is no longer on the roster. Its hours and cost still
        count — they are in the totals — but it has no crew box and no capacity to check
        against, because there is nobody in it. Re-home those lines, or add the division
        back in <b>Settings → Organisation</b>.
      </div></div>` : '')}
  </section>` : '';

  const feasPanel = feas.length ? h`
  <section class="card" style="margin-bottom:14px">
    <header><h3>Can we take it?</h3>
      <span class="sub">this month, after allocation and leave</span>
      <div class="spacer" style="flex:1"></div>
      <button class="btn sm subtle" data-act="go-team">Team →</button></header>
    <div class="body">
      ${raw(feas.map(f => {
        const pct = f.loadPct === Infinity ? 100 : clamp(f.loadPct, 0, 100);
        const tone = f.loadPct > 100 ? 'risk' : f.loadPct > 80 ? 'warn' : 'ok';
        return `<div style="margin-bottom:11px">
          <div class="row tiny" style="margin-bottom:3px">
            <span class="pill-div" style="background:${esc(divColor(f.division.id))}">${esc(f.division.id)}</span>
            <span style="flex:1;margin-left:7px">${esc(f.division.label)}
              <span class="mute">· ${f.people} ${f.people === 1 ? 'person' : 'people'}</span></span>
            <span class="${f.shortfallDays > 0 ? 'overdue' : 'mute'}">
              needs ${n1(f.needDays)} of ${n1(f.availableDays)} available days
              ${f.shortfallDays > 0 ? ` · short ${n1(f.shortfallDays)}` : ''}</span>
          </div>
          ${bar(pct, tone)}
        </div>`;
      }).join(''))}
      <div class="tiny mute" style="margin-top:8px;line-height:1.6">
        A division over 100% cannot absorb this deliverable inside one month at
        the crew you set — add crew, move the start, or cut scope. This uses the
        same available-days figure as the Team and Financials views.
      </div>
    </div>
  </section>` : '';

  return h`
    ${raw(head)}
    ${raw(totals)}
    ${raw(lines)}
    ${raw(schedulePanel(draft, r))}
    ${raw(perDiv)}
    ${raw(feasPanel)}
    <section class="card">
      <div class="body">
        <div class="row wrap" style="gap:10px">
          <label class="fld" style="flex:1;min-width:240px"><span>Notes</span>
            <input data-change="f" data-k="notes" value="${esc(draft.notes || '')}"
                   placeholder="Assumptions, exclusions, what this quote does not cover"></label>
          <div class="spacer" style="flex:1"></div>
          <button class="btn sm subtle" data-act="reset">New estimate</button>
          <button class="btn sm subtle" data-act="to-tasks" title="One task per line, to assign out separately">
            ${icon('board')}Create tasks</button>
          <button class="btn sm subtle" data-act="save">${dirty ? 'Save changes' : 'Save estimate'}</button>
          ${raw(isLogged(draft)
            ? `<span class="chip ok" title="Logged ${esc(fmtDate(new Date(draft.logged.at).toISOString().slice(0, 10), 'long'))}">
                 Logged · ${esc(fmtMoneyFull(draft.logged.cost, sym()))}</span>`
            : `<button class="btn primary sm" data-act="log"
                  title="Sign it off: freeze the cost and put one task on the board">
                 ${icon('check')}Log scope</button>`)}
        </div>
      </div>
    </section>`;
}

/* ---------- the schedule: this breakdown, on a calendar ------------------ */

/*
 * How wide a window the mini Gantt shows, and why it is derived.
 *
 * A fixed window would either clip a three-month scope or shrink a one-week
 * one to a sliver at the far left. So it is the estimate's own span plus a
 * fortnight of air, and the zoom steps down as the span grows.
 */
function draftWindow(bars, start) {
  let from = start, to = start;
  for (const b of bars) { if (b.start < from) from = b.start; if (b.end > to) to = b.end; }
  from = addDays(from, -7);
  to = addDays(to, 14);
  const span = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000));
  const zoom = span <= 70 ? 'day' : span <= 280 ? 'week' : 'month';
  return { from, to, zoom, span };
}

/**
 * Turn the draft into the same shape a planning request has, so the crew
 * comparison here and the one on the Plan screen are literally the same
 * function.
 *
 * Two tools that answer "what if two people did it" with two different
 * numbers is worse than having only one of them.
 */
const draftAsRequest = (draft, r) => ({
  id: 'wb-draft',
  name: draft.name || 'This estimate',
  projectId: draft.projectId || '',
  start: draft.startDate || nextWorkDay(today()),
  deadline: draft.deadline || '',
  parallel: draft.parallel !== false,
  /* byDivision hours are pre-uplift; the request applies the same two
     percentages, so the totals match the cards above to the decimal. */
  reviewPct: r.reviewPct, contingencyPct: r.contPct,
  lines: r.byDivision.filter(d => d.hours > 0)
    .map(d => ({ division: d.division.id, hours: d.hours, seniority: d.seniority })),
  crew: Object.fromEntries(r.byDivision.map(d => [d.division.id, d.crew])),
});

/**
 * The Gantt, and the crew trade-off, inside the work breakdown.
 *
 * This is the half of an estimate a table cannot show: a scope is 400 hours
 * whichever way you read it, but *when it lands* and *what it does to the
 * team while it runs* are the two things the meeting actually argues about.
 * The chart answers the first and the comparison answers the second, from
 * the same numbers as the cards above.
 */
function schedulePanel(draft, r) {
  if (!r.lines.length) return '';
  const start = draft.startDate || nextWorkDay(today());
  const { parent, children } = scopeBars({ ...draft, startDate: start });
  const bars = [parent, ...children];
  const win = draftWindow(bars, start);
  const geo = geometry(win.from, win.to, zoomOf(win.zoom).dayPx);

  /* Capacity under the bars, on the same pixel grid as the Plan screen — so
     a week that is red here is the same week that is red there. */
  const cal = workCalendar(win.from, win.to);
  const periods = periodGrid(win.from, win.to, 'week', cal);
  const sup = supply(periods, cal);
  const load = loadGrid(bars, periods, cal, sup, { useAllocation: false });
  const only = new Set(r.byDivision.map(d => d.division.id));

  const req = draftAsRequest(draft, r);
  const sweep = crewSweep(req, null, { max: 4, from: win.from, to: win.to,
                                       grain: 'week', useAllocation: false });
  const rec = recommendCrew(sweep);
  const current = Math.max(1, Math.round(
    r.byDivision.reduce((n, d) => n + d.crew, 0) / Math.max(1, r.byDivision.length)));

  return h`
  <section class="card gx-card" style="margin-bottom:14px">
    <header><h3>Schedule</h3>
      <span class="sub">${esc(fmtDate(start))} → ${esc(fmtDate(parent.end))} ·
        ${n1(r.elapsedDays)} working days at the crew you set</span>
      <div class="spacer" style="flex:1"></div>
      <span class="gx-key"><i class="k-plan"></i>this breakdown</span>
      <button class="btn sm subtle" data-act="go-plan" title="See it against every other project">
        ${icon('cal')}Open in Plan</button></header>
    ${raw(ganttHTML({
      bars, from: win.from, to: win.to, zoom: win.zoom, sym: sym(), height: ui.height,
      collapsed: wbFolded,
      periods: periods.map(p => p.from),
      footer: capacityStripHTML(load, geo, { onlyDivisions: only, sym: sym() }),
      emptyMsg: 'Set a start date to place this breakdown on a calendar.',
    }))}
    <div class="body">
      <h4 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-mute)">
        What different crew sizes buy you</h4>
      <p class="tiny mute" style="margin-bottom:10px;max-width:72ch;line-height:1.6">
        Effort is ${n1(r.totalHours)} person-hours whoever does it, so <b>cost barely moves</b>.
        What moves is the date and how hard the work leans on the team while it runs.
      </p>
      <div class="tbl-wrap"><table class="tbl compact">
        <thead><tr><th>Crew per division</th><th>Lands</th><th class="num">Elapsed</th>
          <th class="num">Cost</th><th class="num">Peak load</th><th class="num">Short by</th><th></th></tr></thead>
        <tbody>${raw(sweep.map(x => {
          const fits = x.shortfallDays < 0.5;
          return `<tr class="${x.crew === current ? 'on' : ''}">
            <td><b>${x.crew}</b> ${x.crew === 1 ? 'person' : 'people'}${x.crew === current ? ' <span class="chip">as set</span>' : ''}</td>
            <td>${esc(fmtDate(x.finish, 'long'))}</td>
            <td class="num">${n1(x.elapsedDays)}d<div class="tiny mute">${n1(x.elapsedDays / (cfgDaysPerWeek()))}w</div></td>
            <td class="num">${fmtMoneyFull(x.cost, sym())}</td>
            <td class="num ${x.peakPct > 100 ? 'bad' : ''}">${Number.isFinite(x.peakPct)
              ? Math.round(x.peakPct) + '%' : '<span title="A division in this breakdown has nobody in it">no crew</span>'}</td>
            <td class="num ${fits ? '' : 'bad'}">${fits ? '—' : '−' + n1(x.shortfallDays) + 'd'}</td>
            <td class="act">${x.crew === current ? '' :
              `<button class="btn sm subtle" data-act="use-crew" data-n="${x.crew}">Use ${x.crew}</button>`}</td>
          </tr>`;
        }).join(''))}</tbody>
      </table></div>
      ${raw(crewVerdict(rec, current))}
    </div>
  </section>`;
}

const cfgDaysPerWeek = () => Math.max(1, wbSettings().daysPerWeek || 5);

/**
 * The sentence under the crew table.
 *
 * Ordered by what the reader can do about it. An unstaffed division comes
 * first because no crew size fixes it and every row will look broken until
 * it is dealt with — saying "no crew size fits" while the real problem is an
 * empty division sends the reader to change the wrong number.
 */
function crewVerdict(rec, current) {
  const names = rec.unstaffed.map(d => d.label).join(', ');
  if (rec.unstaffed.length) {
    const alt = rec.cleanIgnoringUnstaffed;
    return `<div class="banner risk" style="margin:12px 0 0"><div>
      <b>Nobody is in ${esc(names)}, and this breakdown has work there.</b>
      That is why every row is short, and no crew size changes it: put somebody in
      ${rec.unstaffed.length === 1 ? 'that division' : 'those divisions'}, outsource that part,
      or move the lines somewhere they can be done.
      ${alt ? `Setting the rest aside, a crew of <b>${alt.crew}</b> would cover everything else.` : ''}
    </div></div>`;
  }
  if (rec.clean && rec.clean.crew !== current) {
    return `<div class="banner ok" style="margin:12px 0 0"><div>
      <b>A crew of ${rec.clean.crew} is the smallest that fits.</b>
      It lands ${esc(fmtDate(rec.clean.finish, 'long'))} and no division goes over its
      available days while it runs.</div></div>`;
  }
  if (rec.clean) {
    return `<div class="banner ok" style="margin:12px 0 0"><div>
      <b>The crew you have set is the smallest that fits.</b>
      It lands ${esc(fmtDate(rec.clean.finish, 'long'))} with nobody over their available days.
    </div></div>`;
  }
  return `<div class="banner warn" style="margin:12px 0 0"><div>
    <b>No crew size in this range fits without overloading somebody.</b>
    Even the best of them leaves work uncovered in at least one week — move the start,
    cut the scope, or plan to outsource part of it.</div></div>`;
}

const divColor = id => S.byId(S.get().divisions, id)?.color || 'var(--muted)';

/**
 * The catalogue filter's divisions: the roster's, plus any a catalogue item
 * still names that the roster has dropped.
 *
 * Without the second half, removing a division would leave its work items
 * reachable only by scrolling — filterable by nothing, and easy to believe
 * gone. `itemsByDivision()` groups them for the same reason.
 */
const catDivisionOpts = () => itemsByDivision().map(g => ({
  v: g.division.id,
  t: g.division.missing ? `${g.division.label} (${g.items.length})` : g.division.label,
}));

/* ---------- presets ------------------------------------------------------ */

/*
 * Common deliverables, as a starting breakdown.
 *
 * The reference sheet's own example was a "3D Environment — Exterior", which
 * is the first one here — the same lines it used, so the numbers can be
 * checked against it. These are a head start, not a template: every line is
 * editable and removable once added.
 */
/*
 * Presets now come from state — see `wbPresets` in wb.js and the Catalogue
 * screen, which is where they are added, renamed and removed. They were a
 * const here, which made "we have a new kind of deliverable" a source edit to
 * a published app.
 */

function applyPreset(id) {
  const p = wbPreset(id);
  if (!p) return;
  const items = wbItems();
  const missing = [];
  const lines = [];
  for (const [div, name, qty] of p.lines) {
    const it = items.find(i => i.division === div && i.name === name);
    if (!it) { missing.push(`${div} · ${name}`); continue; }
    lines.push(newLine(it.id, { qty }));
  }
  draft.lines = lines;
  draft.name ||= p.label;
  dirty = true;
  if (missing.length) {
    toast(`${lines.length} lines added. Not in the catalogue: ${missing.slice(0, 3).join(', ')}` +
          (missing.length > 3 ? ` and ${missing.length - 3} more` : ''), 'warn', 8000);
  } else {
    toast(`${lines.length} lines from “${p.label}”`, 'ok');
  }
}

/* ---------- tab 2: estimates -------------------------------------------- */

const EST_STATUS = [
  { id: 'draft',    label: 'Draft',    chip: '' },
  { id: 'quoted',   label: 'Quoted',   chip: 'info' },
  { id: 'approved', label: 'Approved', chip: 'ok' },
  { id: 'done',     label: 'Delivered', chip: 'ok' },
  { id: 'dropped',  label: 'Dropped',  chip: '' },
];
const estStatus = id => EST_STATUS.find(x => x.id === id) || EST_STATUS[0];

function estimatesTab(ctx) {
  const s = S.get();
  const all = wbEstimates();
  const list = ui.estStatus ? all.filter(e => e.status === ui.estStatus) : all;
  const roll = rollUp(list.filter(e => e.status !== 'dropped'));

  if (!all.length) {
    return h`<div class="card"><div class="empty">
      <h4>No estimates saved yet</h4>
      <div class="tiny" style="max-width:62ch;margin:0 auto">
        Build one on the <b>Calculator</b> tab and save it. Saved estimates roll up
        here into a forecast — hours and cost per division across everything
        quoted, which is the number to take into a planning meeting.
      </div>
      <div style="margin-top:12px"><button class="btn primary sm" data-act="tab" data-t="calc">
        ${icon('plus')}Open the calculator</button></div>
    </div></div>`;
  }

  return h`
  <div class="grid g4" style="margin-bottom:14px">
    <div class="card stat"><div class="k">Estimates</div><div class="v">${all.length}</div>
      <div class="d">${all.filter(e => e.status === 'approved').length} approved · ${all.filter(e => e.status === 'draft').length} draft</div></div>
    <div class="card stat"><div class="k">Effort in scope</div><div class="v">${n1(roll.hours)}<span style="font-size:14px;font-weight:400">h</span></div>
      <div class="d">${n1(roll.hours / (wbSettings().hoursPerDay || 8))} person-days</div></div>
    <div class="card stat"><div class="k">Cost in scope</div><div class="v">${fmtMoney(roll.cost, sym())}</div>
      <div class="d">excluding dropped estimates</div></div>
    <div class="card stat"><div class="k">Biggest division</div>
      <div class="v" style="font-size:19px">${esc(roll.byDivision.slice().sort((a, b) => b.hours - a.hours)[0]?.division.label || '—')}</div>
      <div class="d">${n1(roll.byDivision.slice().sort((a, b) => b.hours - a.hours)[0]?.hours || 0)}h of the total</div></div>
  </div>

  <div class="toolbar">
    <select data-change="estfilter" style="width:auto">
      ${raw(sel(EST_STATUS.map(x => ({ v: x.id, t: x.label })), ui.estStatus, 'Any status'))}
    </select>
    <div class="spacer"></div>
    <button class="btn sm subtle" data-act="csv-estimates">${icon('down')}CSV</button>
    <button class="btn primary sm" data-act="tab" data-t="calc">${icon('plus')}New estimate</button>
  </div>

  <div class="card" style="margin-bottom:14px"><div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Deliverable</th><th>Project</th><th>Approach</th><th class="num">Effort h</th>
      <th class="num">Duration</th><th class="num">Cost</th><th>Status</th><th>Updated</th><th></th></tr></thead>
    <tbody>${raw(list.map(e => {
      const c = estimate(e);
      const p = S.byId(s.projects, e.projectId);
      const st = estStatus(e.status);
      return `<tr data-e="${e.id}">
        <td data-act="open-est" style="cursor:pointer"><b>${esc(e.name || '(unnamed)')}</b>
          <div class="tiny mute">${c.lines.length} line${c.lines.length === 1 ? '' : 's'}
            ${c.byDivision.map(d => esc(d.division.id)).join(' · ')}</div></td>
        <td>${p ? `<span class="chip" style="background:${p.color}22;color:${p.color}">${esc(p.code)}</span>` : '<span class="mute">—</span>'}</td>
        <td class="tiny">${esc(c.approaches.map(a => a.label).join(', ') || '—')}</td>
        <td class="num">${n1(c.totalHours)}</td>
        <td class="num tiny">${n1(c.elapsedDays)}d<div class="mute">${n1(c.elapsedWeeks)}w</div></td>
        <td class="num">${fmtMoneyFull(c.totalCost, sym())}</td>
        <td><span class="chip ${st.chip}">${esc(st.label)}</span></td>
        <td class="tiny mute">${esc(fmtDate(new Date(e.updated || e.created).toISOString().slice(0, 10)))}</td>
        <td class="act"><button class="btn icon sm subtle" data-act="est-menu"><svg class="ico"><use href="#i-dots"></use></svg></button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="9" class="tiny mute" style="padding:20px;text-align:center">Nothing with that status.</td></tr>')}</tbody>
  </table></div></div>

  ${raw(roll.byDivision.length ? `
  <section class="card">
    <header><h3>Forecast by division</h3><span class="sub">across ${roll.rows.length} estimate${roll.rows.length === 1 ? '' : 's'} in scope</span></header>
    <div class="body">
      ${roll.byDivision.slice().sort((a, b) => b.hours - a.hours).map(d => {
        const share = roll.hours ? (d.hours / roll.hours) * 100 : 0;
        return `<div style="margin-bottom:10px">
          <div class="row tiny" style="margin-bottom:3px">
            <span class="pill-div" style="background:${esc(divColor(d.division.id))}">${esc(d.division.id)}</span>
            <span style="flex:1;margin-left:7px">${esc(d.division.label)}</span>
            <span class="mute">${n1(d.hours)}h · ${fmtMoneyFull(d.cost, sym())} · ${Math.round(share)}%</span>
          </div>
          ${bar(share)}
        </div>`;
      }).join('')}
    </div>
  </section>` : '')}`;
}

/* ---------- tab 3: the log ---------------------------------------------- */

/**
 * What has been signed off, and what it committed us to.
 *
 * Every number here comes from the snapshot taken at log time, never from a
 * recomputation — a scope agreed in September has to keep saying what it said
 * if the rate card moves in November.
 */
function logTab(ctx) {
  const s = S.get();
  const roll = logRollUp();

  if (!roll.rows.length) {
    return h`<div class="card"><div class="empty">
      <h4>Nothing has been logged yet</h4>
      <div class="tiny" style="max-width:64ch;margin:0 auto;line-height:1.7">
        Logging an estimate signs it off: the cost and the breakdown are frozen as
        they were on the day, and one task appears on the board with every work
        item as a checklist step — which is also what becomes Jira sub-tasks when
        you queue it. Logged scope shows up on its project's <b>Scopes</b> tab.
      </div>
      <div style="margin-top:12px"><button class="btn primary sm" data-act="tab" data-t="estimates">
        Open the estimates</button></div>
    </div></div>`;
  }

  const nProjects = roll.byProject.filter(p => p.projectId).length;

  return h`
  <div class="grid g4" style="margin-bottom:14px">
    <div class="card stat"><div class="k">Logged scopes</div><div class="v">${roll.rows.length}</div>
      <div class="d">${roll.items} work items in total</div></div>
    <div class="card stat"><div class="k">Committed cost</div><div class="v">${fmtMoney(roll.cost, sym())}</div>
      <div class="d">frozen at the price on the day</div></div>
    <div class="card stat"><div class="k">Committed effort</div><div class="v">${n1(roll.hours)}<span style="font-size:14px;font-weight:400">h</span></div>
      <div class="d">${n1(roll.hours / (wbSettings().hoursPerDay || 8))} person-days</div></div>
    <div class="card stat" data-act="go-portfolio" style="cursor:pointer">
      <div class="k">Across</div><div class="v">${nProjects}<span style="font-size:14px;font-weight:400"> project${nProjects === 1 ? '' : 's'}</span></div>
      <div class="d">open Project Management →</div></div>
  </div>

  <section class="card" style="margin-bottom:14px">
    <header><h3>By project</h3><span class="sub">committed scope, per project</span>
      <div class="spacer" style="flex:1"></div>
      <button class="btn sm subtle" data-act="go-portfolio">Overview →</button></header>
    <div class="body flush"><table class="tbl">
      <thead><tr><th>Project</th><th class="num">Scopes</th><th class="num">Items</th>
        <th class="num">Effort h</th><th class="num">Cost</th><th>Share</th><th></th></tr></thead>
      <tbody>${raw(roll.byProject.map(p => {
        const proj = S.byId(s.projects, p.projectId);
        const share = roll.cost ? (p.cost / roll.cost) * 100 : 0;
        return `<tr${proj ? ` data-p="${proj.id}"` : ''}>
          <td>${proj
            ? `<span class="chip" style="background:${proj.color}22;color:${proj.color}">${esc(proj.code)}</span>
               <span class="tiny" style="margin-left:7px">${esc(proj.name)}</span>`
            : '<span class="mute tiny">No project</span>'}</td>
          <td class="num">${p.count}</td>
          <td class="num tiny">${p.items}</td>
          <td class="num">${n1(p.hours)}</td>
          <td class="num"><b>${fmtMoneyFull(p.cost, sym())}</b></td>
          <td style="width:150px">${bar(share)}<div class="tiny mute" style="margin-top:2px">${Math.round(share)}%</div></td>
          <td class="act">${proj
            ? '<button class="btn sm subtle" data-act="go-scopes">Scopes →</button>'
            : ''}</td></tr>`;
      }).join(''))}</tbody>
    </table></div>
  </section>

  <section class="card">
    <header><h3>The log</h3><span class="sub">newest first · every number frozen at log time</span>
      <div class="spacer" style="flex:1"></div>
      <button class="btn sm subtle" data-act="csv-log">${icon('down')}CSV</button></header>
    <div class="body flush"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Logged</th><th>Scope</th><th>Project</th><th class="num">Items</th>
        <th class="num">Effort h</th><th class="num">Cost</th><th>Task</th><th>Jira</th><th></th></tr></thead>
      <tbody>${raw(roll.rows.map(e => {
        const lg = e.logged;
        const proj = S.byId(s.projects, lg.projectId || e.projectId);
        const task = S.byId(s.tasks, lg.taskId);
        const cl = task?.checklist || [];
        const doneN = cl.filter(x => x.done).length;
        return `<tr data-e="${e.id}">
          <td class="tiny nowrap"><b>${esc(fmtDate(new Date(lg.at).toISOString().slice(0, 10), 'long'))}</b>
            <div class="mute">${esc(new Date(lg.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))}</div></td>
          <td data-act="open-est" style="cursor:pointer"><b>${esc(e.name)}</b>
            <div class="tiny mute">${(lg.lines || []).slice(0, 3).map(l => esc(l.name)).join(' · ')}${(lg.lines || []).length > 3 ? ` +${lg.lines.length - 3}` : ''}</div></td>
          <td>${proj
            ? `<span class="chip" style="background:${proj.color}22;color:${proj.color}" data-act="go-proj" data-p="${proj.id}" style="cursor:pointer">${esc(proj.code)}</span>`
            : '<span class="mute">—</span>'}</td>
          <td class="num tiny">${(lg.lines || []).length}</td>
          <td class="num">${n1(lg.hours)}</td>
          <td class="num"><b>${fmtMoneyFull(lg.cost, sym())}</b></td>
          <td class="tiny">${task
            ? `<span data-act="go-task" style="cursor:pointer;text-decoration:underline">${cl.length ? `${doneN}/${cl.length} steps` : 'open'}</span>`
            : '<span class="mute">task deleted</span>'}</td>
          <td class="tiny">${task?.jira?.key
            ? `<span class="chip tiny ok">${esc(task.jira.key)}</span>`
            : task?.jira?.state === 'queued' ? '<span class="chip tiny warn">queued</span>'
            : '<span class="mute">—</span>'}</td>
          <td class="act"><button class="btn icon sm subtle" data-act="log-menu"><svg class="ico"><use href="#i-dots"></use></svg></button></td>
        </tr>`;
      }).join(''))}</tbody>
    </table></div></div>
  </section>`;
}

function csvLog() {
  const roll = logRollUp();
  if (!roll.rows.length) return toast('Nothing logged yet.', 'warn');
  const rows = [];
  for (const e of roll.rows) {
    for (const l of (e.logged.lines || [])) {
      rows.push({
        LoggedAt: new Date(e.logged.at).toISOString().slice(0, 19).replace('T', ' '),
        Scope: e.name, Project: S.projectName(e.logged.projectId || e.projectId) || '',
        Division: l.division, WorkItem: l.name, Qty: l.qty,
        Complexity: wbComplexity(l.complexity).label, Approach: wbApproach(l.approach).label,
        Hours: Math.round(l.hours * 100) / 100, Seniority: l.seniority,
        HourlyRate: Math.round(l.rate * 100) / 100, Cost: Math.round(l.cost * 100) / 100,
      });
    }
  }
  download(`gfx-wb-log-${today()}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
  toast(`${rows.length} logged items exported`, 'ok');
}

/* ---------- tab 4: catalogue -------------------------------------------- */

/**
 * Presets, on the same screen as the items they are made of.
 *
 * A preset names a common deliverable and the lines it usually takes. Each row
 * says how many lines it carries and flags any that no longer match a
 * catalogue item — a renamed item silently drops out of a preset otherwise,
 * and you find out when an estimate comes in light.
 */
function presetsCard() {
  const ps = wbPresets();
  /* A map of division → names, not one Set keyed on a joined string. Any
     separator can appear in a work item name, and the obvious "impossible"
     one — a NUL — is worse than useless: it makes the source file itself
     binary to grep, diff and every other text tool. */
  const byDiv = new Map();
  for (const i of wbItems()) {
    if (!byDiv.has(i.division)) byDiv.set(i.division, new Set());
    byDiv.get(i.division).add(i.name);
  }
  const missingIn = p => (p.lines || []).filter(([d, n]) => !byDiv.get(d)?.has(n)).length;

  return `
  <section class="card" style="margin-bottom:12px">
    <header>${icon('file')}<h3 style="margin-left:8px">Presets</h3>
      <span class="sub">a common deliverable as a starting breakdown</span>
      <div class="spacer" style="flex:1"></div>
      <span class="chip tiny">${ps.length}</span>
    </header>
    <div class="body">
      <p class="tiny mute" style="margin:0 0 10px">Applying one replaces the lines in the
        calculator. To make a new one, build the breakdown on the Calculator tab and press
        <b>Save as preset</b> — quicker and more accurate than describing it in a form.</p>
      ${ps.length ? `<table class="tbl"><thead><tr>
          <th>Preset</th><th class="num" style="width:80px">Lines</th>
          <th style="width:160px"></th><th style="width:40px"></th></tr></thead>
        <tbody>${ps.map(p => {
          const miss = missingIn(p);
          return `<tr data-p="${esc(p.id)}">
            <td><b>${esc(p.label)}</b>${miss
              ? `<div class="tiny" style="color:var(--warn,#C77405)">${miss === 1
                  ? '1 line no longer matches a catalogue item'
                  : `${miss} lines no longer match a catalogue item`}</div>`
              : ''}</td>
            <td class="num tiny">${(p.lines || []).length}</td>
            <td><button class="btn sm subtle" data-act="preset-rename">Rename</button></td>
            <td class="act"><button class="btn icon sm subtle" data-act="preset-del" title="Delete preset">
              <svg class="ico"><use href="#i-trash"></use></svg></button></td>
          </tr>`;
        }).join('')}</tbody></table>`
        : '<p class="tiny mute">None yet.</p>'}
    </div>
  </section>`;
}

function catalogueTab() {
  const groups = itemsByDivision().filter(g => !ui.catDivision || g.division.id === ui.catDivision);
  const cfg = wbSettings();
  const all = wbItems();

  return h`
  <div class="banner">
    <svg class="ico"><use href="#i-info"></use></svg>
    <div><b>The base eyeball ETA per work item.</b> One artist, normal complexity,
      one of the thing. Everything else in the calculator is a multiplier on these,
      so this is the one place a number is worth arguing about.
      <div class="tiny mute" style="margin-top:4px">
        ${all.length} items · a day is ${cfg.hoursPerDay}h, so a base of ${cfg.hoursPerDay} reads as one day.
      </div></div>
  </div>

  <div class="toolbar">
    <select data-change="catfilter" style="width:auto">
      ${raw(sel(catDivisionOpts(), ui.catDivision, 'All divisions'))}
    </select>
    <div class="spacer"></div>
    <button class="btn sm subtle" data-act="csv-catalogue">${icon('down')}CSV</button>
    <button class="btn primary sm" data-act="item-add">${icon('plus')}Add work item</button>
  </div>

  ${raw(presetsCard())}

  ${raw(groups.map(g => `
    <section class="card" style="margin-bottom:12px">
      <header>
        <span class="pill-div" style="background:${esc(divColor(g.division.id))}">${esc(g.division.id)}</span>
        <h3 style="margin-left:8px">${esc(g.division.label)}</h3>
        <span class="sub">${g.items.length} items · ${n1(g.items.reduce((n, i) => n + (+i.hours || 0), 0))}h if you did every one once</span>
        <div class="spacer" style="flex:1"></div>
        ${g.division.crew ? '' : '<span class="chip tiny">no crew — never divides duration</span>'}
      </header>
      <div class="body flush"><table class="tbl">
        <thead><tr><th>Work item</th><th class="num" style="width:90px">Base h</th>
          <th class="num" style="width:90px">Base days</th><th style="width:130px">At ${esc(defaultSeniority(g.division.id))}</th><th></th></tr></thead>
        <tbody>${g.items.map(i => `<tr data-i="${i.id}">
          <td><b>${esc(i.name)}</b>${i.notes ? `<div class="tiny mute">${esc(i.notes)}</div>` : ''}</td>
          <td class="num">${n1(i.hours)}</td>
          <td class="num tiny mute">${n1((+i.hours || 0) / cfg.hoursPerDay)}</td>
          <td class="tiny mute">${fmtMoneyFull((+i.hours || 0) * hourlyRate(defaultSeniority(g.division.id)), sym())}</td>
          <td class="act"><button class="btn icon sm subtle" data-act="item-menu"><svg class="ico"><use href="#i-dots"></use></svg></button></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </section>`).join('') || '<div class="card"><div class="empty tiny">No items for that division yet.</div></div>')}`;
}

/* ---------- tab 4: rates ------------------------------------------------- */

function ratesTab() {
  const cfg = wbSettings();
  const ladder = rateLadder(cfg);

  return h`
  <div class="grid g2" style="margin-bottom:14px">
    <section class="card">
      <header><h3>Hourly cost per rung</h3><span class="sub">derived, not typed</span>
        <div class="spacer" style="flex:1"></div>
        <button class="btn sm subtle" data-act="go-rates">Rate card →</button></header>
      <div class="body flush"><table class="tbl">
        <thead><tr><th>Seniority</th><th class="num">Monthly</th><th class="num">Daily</th><th class="num">Hourly</th><th class="num">People</th></tr></thead>
        <tbody>${raw(ladder.map(l => {
          const n = S.get().people.filter(p => p.active !== false &&
            String(p.seniority || '').toLowerCase() === l.seniority.toLowerCase()).length;
          return `<tr>
            <td><b>${esc(l.seniority)}</b></td>
            <td class="num">${fmtMoneyFull(l.monthly, sym())}</td>
            <td class="num">${fmtMoneyFull(l.daily, sym())}</td>
            <td class="num"><b>${fmtMoneyFull(l.hourly, sym())}</b></td>
            <td class="num tiny ${n ? '' : 'mute'}">${n || '—'}</td></tr>`;
        }).join(''))}</tbody>
      </table></div>
      <div class="body" style="padding-top:0">
        <div class="tiny mute" style="line-height:1.6">
          Monthly comes from the rate card in Financials. Hourly is
          monthly ÷ (${cfg.workDaysPerMonth} working days × ${cfg.hoursPerDay}h), so there is one
          version of the number and changing the rate card changes every estimate.
        </div>
      </div>
    </section>

    <section class="card">
      <header><h3>The maths</h3><span class="sub">what the calculator assumes</span></header>
      <div class="body">
        <div style="display:grid;grid-template-columns:repeat(12,1fr);gap:0 12px">
          <label class="fld" style="grid-column:span 6"><span>Working days a month</span>
            <input type="number" min="1" max="31" step="1" data-change="cfg" data-k="workDaysPerMonth" value="${cfg.workDaysPerMonth}">
            <span class="hint">What a monthly salary buys. Drives the hourly rate.</span></label>
          <label class="fld" style="grid-column:span 6"><span>Days a week</span>
            <input type="number" min="1" max="7" step="1" data-change="cfg" data-k="daysPerWeek" value="${cfg.daysPerWeek}">
            <span class="hint">Only converts duration into weeks.</span></label>
          <label class="fld" style="grid-column:span 6"><span>Default review %</span>
            <input type="number" min="0" step="5" data-change="cfg" data-k="reviewPct" value="${cfg.reviewPct}"></label>
          <label class="fld" style="grid-column:span 6"><span>Default contingency %</span>
            <input type="number" min="0" step="5" data-change="cfg" data-k="contingencyPct" value="${cfg.contingencyPct}"></label>
        </div>
        <div class="sep" style="margin:4px 0 12px"></div>
        <div class="tiny mute" style="margin-bottom:6px"><b>Hours a day</b> is ${cfg.hoursPerDay}, set in Settings so the
          whole app agrees on what a day is.</div>

        <div class="tiny mute" style="margin-bottom:4px;font-weight:600">Complexity</div>
        <div class="row wrap tiny" style="gap:8px;margin-bottom:10px">
          ${raw(WB_COMPLEXITY.map(c => `<span class="chip">${esc(c.label)} ×${c.factor}</span>`).join(''))}
        </div>
        <div class="tiny mute" style="margin-bottom:4px;font-weight:600">Production approach</div>
        <div class="row wrap tiny" style="gap:8px">
          ${raw(WB_APPROACHES.map(a => `<span class="chip" title="${esc(a.hint)}">${esc(a.label)} ×${a.factor}</span>`).join(''))}
        </div>
      </div>
    </section>
  </div>

  <section class="card">
    <header><h3>Effort is not duration</h3></header>
    <div class="body">
      <div class="tiny" style="max-width:88ch;line-height:1.75">
        <b>Effort</b> is person-hours. It is what the work costs, and crew size never
        changes it — two artists on a 40-hour job is still 40 hours of salary.<br>
        <b>Duration</b> is elapsed working days. Crew size divides it, and each
        division divides by <i>its own</i> crew.<br><br>
        With <b>parallel</b> on, the longest division sets the date: 2D and 3D working
        the same fortnight is a fortnight. Turn it off for a genuine hand-off chain —
        concept must finish before modelling starts — and the divisions add up
        instead.<br><br>
        <span class="mute">The spreadsheet this replaces divided every line by a single
        headcount cell whatever division the line was in, so any estimate with
        uneven crews came out wrong. That is the bug this separation removes.</span>
      </div>
    </div>
  </section>`;
}

/* ---------- dialogs ------------------------------------------------------ */

async function addLineDialog() {
  const groups = itemsByDivision();
  const divs = wbDivisions();
  if (!groups.length && !divs.length) {
    toast('No divisions are set up yet.', 'warn'); return false;
  }

  const res = await dialog({
    title: 'Add work items', wide: true,
    body: `
      <div class="banner"><svg class="ico"><use href="#i-info"></use></svg>
        <div>Tick everything this deliverable needs. Quantity and complexity are
          set per line afterwards.</div></div>

      <!--
        A one-off line, without a trip to the Catalogue screen.

        A line already carries its own name, division and base hours - they are
        copied from the catalogue item when the line is made, and the estimate
        reads the line, not the catalogue. So a custom item needs no catalogue
        entry at all, and the catalogue does not fill up with one-offs. Tick
        the box when it IS worth keeping.
      -->
      <details class="wb-custom" style="margin:10px 0 4px;border:1px solid var(--line,#e3e3e8);border-radius:8px;padding:8px 10px">
        <summary style="cursor:pointer;font-size:12px;font-weight:600">Add a custom work item</summary>
        <div style="display:grid;grid-template-columns:repeat(12,1fr);gap:8px 10px;margin-top:10px">
          <label class="fld" style="grid-column:span 3;margin:0"><span>Division</span>
            <select id="cu_div">${divs.map(d => `<option value="${esc(d.id)}">${esc(d.label)}</option>`).join('')}</select></label>
          <label class="fld" style="grid-column:span 5;margin:0"><span>Work item</span>
            <input id="cu_name" placeholder="e.g. Licensor revision pass"></label>
          <label class="fld" style="grid-column:span 2;margin:0"><span>Base ETA (h)</span>
            <input id="cu_hours" type="number" min="0" step="0.25" value="1"></label>
          <label class="fld" style="grid-column:span 2;margin:0"><span>Quantity</span>
            <input id="cu_qty" type="number" min="1" step="1" value="1"></label>
          <label class="tiny" style="grid-column:span 8;display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" id="cu_save">
            <span>Also add it to the catalogue, so it is on this list next time</span></label>
          <div style="grid-column:span 4;text-align:right">
            <button type="button" class="btn sm primary" id="cu_add">Add this item</button></div>
          <div class="tiny mute" style="grid-column:span 12" id="cu_msg">
            Base ETA is one artist, normal complexity, one of the thing — the same
            basis as every catalogue item.</div>
          <div style="grid-column:span 12" id="cu_added"></div>
        </div>
      </details>
      <div class="wb-pick">${groups.map(g => `
        <div class="wb-pick-g">
          <div class="wb-pick-h">
            <span class="pill-div" style="background:${esc(divColor(g.division.id))}">${esc(g.division.id)}</span>
            <b>${esc(g.division.label)}</b>
            <span class="spacer" style="flex:1"></span>
            <button type="button" class="btn sm subtle" data-all="${g.division.id}">All</button>
          </div>
          ${g.items.map(i => `<label class="wb-pick-i" data-div="${g.division.id}">
            <input type="checkbox" data-item="${i.id}">
            <span style="flex:1">${esc(i.name)}</span>
            <b class="tiny mute">${n1(i.hours)}h</b></label>`).join('')}
        </div>`).join('')}</div>`,
    footer: `<span class="tiny mute" data-count>Nothing selected</span>
             <div class="spacer" style="flex:1"></div>
             <button class="btn" data-no>Cancel</button>
             <button class="btn primary" data-ok>Add selected</button>`,
    onMount: ({ root, close }) => {
      /*
       * "Add this item" ADDS THE ITEM.
       *
       * It used to stage one and commit on "Add selected", which meant the
       * button cleared the form and did nothing you could see — and a ticked
       * "add to the catalogue" produced no catalogue entry until the dialog
       * was closed the one right way. A button named "Add this item" that
       * only sometimes adds the item is worse than no button.
       *
       * So it commits on the spot: the line goes into the breakdown and the
       * catalogue entry is written now. Because that cannot then be undone by
       * Cancel, Cancel becomes "Close" the moment anything has been committed
       * — rather than offering an undo it will not honour.
       */
      const added = [];
      const count = () => {
        const n = root.querySelectorAll('[data-item]:checked').length;
        root.querySelector('[data-count]').textContent =
          n ? `${n} item${n === 1 ? '' : 's'} ticked` : (added.length ? '' : 'Nothing selected');
        if (added.length) {
          root.querySelector('[data-count]').textContent =
            `${added.length} custom item${added.length === 1 ? '' : 's'} added`
            + (n ? `, ${n} ticked` : '');
        }
      };

      const paintAdded = () => {
        root.querySelector('#cu_added').innerHTML = added.length
          ? `<div class="tiny" style="margin-top:6px">Added to this breakdown: ${added.map(a =>
              `<span class="chip tiny ok">${esc(a.name)} · ${n1(a.baseHours)}h${a.qty > 1 ? ` ×${a.qty}` : ''}${a.save ? ' · in catalogue' : ''}</span>`
            ).join(' ')}</div>`
          : '';
      };

      root.querySelector('#cu_add').onclick = () => {
        const nameEl = root.querySelector('#cu_name');
        const name = nameEl.value.trim();
        const hours = Number(root.querySelector('#cu_hours').value);
        const qty = Math.max(1, Math.round(Number(root.querySelector('#cu_qty').value) || 1));
        const division = root.querySelector('#cu_div').value;
        const save = root.querySelector('#cu_save').checked;
        const msg = root.querySelector('#cu_msg');
        if (!name) { nameEl.focus(); msg.textContent = 'Give it a name first.'; return; }
        if (!Number.isFinite(hours) || hours < 0) {
          root.querySelector('#cu_hours').focus(); msg.textContent = 'Base ETA must be a number.'; return;
        }

        draft.lines.push(newLine('', {
          division, name, baseHours: hours, qty, seniority: defaultSeniority(division),
        }));
        if (save) saveItem({ division, name, hours, active: true });
        dirty = true;
        added.push({ division, name, baseHours: hours, qty, save });

        msg.textContent = save
          ? 'Added to the breakdown, and saved to the catalogue.'
          : 'Added to the breakdown. Tick the box to keep it in the catalogue too.';
        nameEl.value = '';
        root.querySelector('#cu_hours').value = '1';
        root.querySelector('#cu_qty').value = '1';
        root.querySelector('#cu_save').checked = false;
        nameEl.focus();
        paintAdded();
        count();

        // Cancel no longer undoes anything, so stop calling it Cancel.
        const no = root.querySelector('[data-no]');
        if (no) no.textContent = 'Close';
      };
      root.addEventListener('change', count);
      root.querySelectorAll('[data-all]').forEach(b => b.onclick = () => {
        const div = b.dataset.all;
        const boxes = [...root.querySelectorAll(`.wb-pick-i[data-div="${div}"] [data-item]`)];
        const on = !boxes.every(x => x.checked);
        boxes.forEach(x => { x.checked = on; });
        count();
      });
      root.querySelector('[data-no]').onclick = () => close({ ids: [], added: added.length });
      root.querySelector('[data-ok]').onclick = () => close({
        ids: [...root.querySelectorAll('[data-item]:checked')].map(x => x.dataset.item),
        added: added.length,
      });
    },
  });

  if (!res) return false;
  const { ids = [], added = 0 } = res;

  /* Custom items are already in `draft.lines` — they were committed as they
     were added. Only the ticked catalogue items are left to do. */
  for (const id of ids) draft.lines.push(newLine(id));
  if (ids.length) dirty = true;

  const n = ids.length + added;
  if (!n) return false;
  toast(`${n} line${n === 1 ? '' : 's'} added`, 'ok');
  return true;
}

async function editItemDialog(id) {
  const it = id ? wbItem(id) : null;
  const res = await formDlg(it ? 'Edit work item' : 'New work item', [
    { k: 'name', label: 'Work item', value: it?.name || '', required: true, span: 12,
      hint: 'What one of these is. Keep it the unit you estimate in.' },
    /* The filtered division if one is chosen, else the first on the roster —
       not a hard-coded '2D', which a department without one would not have. */
    { k: 'division', label: 'Division', type: 'select', span: 6,
      value: it?.division || ui.catDivision || wbDivisions()[0]?.id || '',
      opts: wbDivisions().map(d => ({ v: d.id, t: d.label })) },
    { k: 'hours', label: 'Base ETA (hours)', type: 'number', value: it?.hours ?? 1, span: 6, min: 0, step: '0.25',
      hint: 'One artist, normal complexity, one of the thing.' },
    { k: 'notes', label: 'Notes', value: it?.notes || '', span: 12,
      hint: 'What is in and out of scope for this item.' },
  ], { ok: it ? 'Save' : 'Add', wide: true });
  if (!res) return false;
  saveItem({ ...(it || {}), ...res, hours: Number(res.hours) || 0 });
  toast('Work item saved', 'ok');
  return true;
}

/* ---------- logging ------------------------------------------------------ */

/**
 * Sign off the estimate on screen.
 *
 * It has to be saved first — a log is a reference to a stored estimate, and
 * logging an unsaved draft would leave the frozen snapshot pointing at
 * nothing. So it saves, then asks, then logs.
 */
async function doLog(est, ctx, redraw) {
  if (!est) return;
  const r = estimate(est);
  if (!r.lines.length) return toast('There is nothing in the breakdown to log.', 'warn');

  if (!String(est.name || '').trim()) {
    const res = await formDlg('Name this scope before logging it', [
      { k: 'name', label: 'Deliverable', value: '', required: true, span: 12,
        hint: 'What is being committed to. This becomes the task title.' },
    ], { ok: 'Continue' });
    if (!res) return;
    est.name = res.name;
  }

  const proj = S.byId(S.get().projects, est.projectId);
  const ok = await confirmDlg(
    `Log “${est.name}” at ${fmtMoneyFull(r.totalCost, sym())} for ${n1(r.totalHours)}h`
    + `${proj ? ` against ${proj.name}` : ' with no project'}?`
    + `\n\nThe cost and all ${r.lines.length} lines are frozen as they are now, and one task `
    + `appears at the top of Backlog with every line as a checklist step.`
    + (proj ? '' : '\n\nWithout a project it will not appear on any Scopes tab.'),
    { title: 'Log this scope', ok: 'Log it', danger: false });
  if (!ok) return;

  saveEstimate(est);
  const res = logEstimate(est.id);
  if (!res.ok) return toast(res.error, 'err', 7000);

  dirty = false;
  draft = JSON.parse(JSON.stringify(wbEstimate(est.id)));
  toast(`“${est.name}” logged · task created with ${r.lines.length} checklist steps`, 'ok', 6000);
  ctx.go('gfxwb', 'log');
}

/* ---------- csv ---------------------------------------------------------- */

function csvLines() {
  const r = estimate(draft);
  if (!r.lines.length) return toast('Nothing to export.', 'warn');
  download(`gfx-wb-${(draft.name || 'estimate').replace(/[^A-Za-z0-9_-]+/g, '-')}-${today()}.csv`,
    toCsv(r.lines.map(l => ({
      Deliverable: draft.name, Division: l.division, WorkItem: l.name,
      Complexity: wbComplexity(l.complexity).label, ComplexityFactor: l.cxFactor,
      Qty: l.qty, BaseHours: l.baseHours,
      Approach: l.approachInfo.label, ApproachFactor: l.approachInfo.factor,
      Hours: Math.round(l.hours * 100) / 100, Seniority: l.seniorityUsed,
      HourlyRate: Math.round(l.rate * 100) / 100, Cost: Math.round(l.cost * 100) / 100,
    }))), 'text/csv;charset=utf-8');
  toast(`${r.lines.length} lines exported`, 'ok');
}

function csvEstimates() {
  const list = wbEstimates();
  if (!list.length) return toast('Nothing to export.', 'warn');
  download(`gfx-wb-estimates-${today()}.csv`, toCsv(list.map(e => {
    const c = estimate(e);
    return {
      Deliverable: e.name, Project: S.projectName(e.projectId) || '',
      Approach: c.approaches.map(a => a.label).join(' + '), Status: e.status, Lines: c.lines.length,
      EffortHours: Math.round(c.totalHours * 10) / 10,
      ElapsedDays: Math.round(c.elapsedDays * 10) / 10,
      Cost: Math.round(c.totalCost), Review: c.reviewPct, Contingency: c.contPct,
      Start: e.startDate || '', Lands: c.finish || '', Notes: e.notes || '',
    };
  })), 'text/csv;charset=utf-8');
  toast(`${list.length} estimates exported`, 'ok');
}

function csvCatalogue() {
  const cfg = wbSettings();
  download(`gfx-wb-catalogue-${today()}.csv`, toCsv(wbItems().map(i => ({
    Division: i.division, DivisionName: wbDivision(i.division).label, WorkItem: i.name,
    BaseHours: i.hours, BaseDays: Math.round((+i.hours || 0) / cfg.hoursPerDay * 1000) / 1000,
    Notes: i.notes || '',
  }))), 'text/csv;charset=utf-8');
  toast(`${wbItems().length} items exported`, 'ok');
}

/* ---------- view --------------------------------------------------------- */

export default {
  id: 'gfxwb', title: 'GFX WB', icon: 'chart', group: 'space',
  subtitle: 'Work breakdown, estimates and what they cost',

  actions: ctx => {
    const tab = tabOf(ctx.params[0]);
    if (tab === 'catalogue') {
      return [{ label: 'Add work item', icon: 'plus', primary: true,
                run: () => editItemDialog(null).then(r => r && ctx.rerender()) }];
    }
    return [{ label: 'New estimate', icon: 'plus', primary: true, run: () => {
      draft = newEstimate(); dirty = false; ctx.go('gfxwb', 'calc');
    } }];
  },

  render(host, ctx) {
    const tab = tabOf(ctx.params[0]);
    const estId = ctx.params[1];

    /* Deep link into a saved estimate: #/gfxwb/calc/<id> */
    if (tab === 'calc' && estId && (!draft || draft.id !== estId)) {
      const found = wbEstimate(estId);
      if (found) { draft = JSON.parse(JSON.stringify(found)); dirty = false; }
    }

    ctx.setCrumb(TABS.find(t => t.id === tab)?.label || '');

    host.innerHTML = h`
      <div class="ptabs">${raw(TABS.map(t => {
        const n = t.id === 'estimates' ? wbEstimates().length
                : t.id === 'log'       ? wbEstimates().filter(isLogged).length
                : t.id === 'catalogue' ? wbItems().length
                : t.id === 'calc' ? (draft?.lines?.length || 0) : 0;
        return `<button class="ptab${t.id === tab ? ' on' : ''}" data-act="tab" data-t="${t.id}">
          ${esc(t.label)}${n ? `<span class="ptab-n">${n}</span>` : ''}
        </button>`;
      }).join(''))}</div>
      <div id="wb-body"></div>`;

    const body = host.querySelector('#wb-body');
    body.innerHTML = tab === 'estimates' ? estimatesTab(ctx)
                   : tab === 'log'       ? logTab(ctx)
                   : tab === 'catalogue' ? catalogueTab()
                   : tab === 'rates'     ? ratesTab()
                   : calcTab(ctx);

    const redraw = () => ctx.rerender();

    acts(host, {
      tab: el => ctx.go('gfxwb', el.dataset.t),

      /* --- calculator --- */
      f: el => {
        const k = el.dataset.k;
        draft[k] = el.type === 'number' ? Number(el.value) || 0 : el.value;
        dirty = true; redraw();
      },
      crew: el => {
        /* Zero is allowed and means nobody is on it. Blank falls back to one
           rather than silently unstaffing a division. */
        const v = el.value === '' ? 1 : Math.max(0, Math.floor(Number(el.value) || 0));
        draft.crew = { ...(draft.crew || {}), [el.dataset.d]: v };
        dirty = true; redraw();
      },
      parallel: el => { draft.parallel = el.checked; dirty = true; redraw(); },
      /* One click from the crew comparison to actually setting that crew.
         The table is only worth the space if the answer it gives is one
         button away from being taken. */
      'use-crew': el => {
        const n = Math.max(0, Number(el.dataset.n) || 1);
        const next = { ...(draft.crew || {}) };
        for (const d of estimate(draft).byDivision) {
          if (d.division.crew && d.hours > 0) next[d.division.id] = n;
        }
        draft.crew = next; dirty = true;
        toast(`Crew set to ${n} on every division in this breakdown`, 'ok');
        redraw();
      },
      'go-plan': () => ctx.go('plan'),
      line: el => {
        const id = el.closest('[data-l]').dataset.l;
        const l = draft.lines.find(x => x.id === id);
        if (!l) return;
        const k = el.dataset.k;
        l[k] = k === 'qty' ? Math.max(0, Number(el.value) || 0) : el.value;
        dirty = true; redraw();
      },
      'line-menu': (el, ev) => {
        const id = el.closest('[data-l]').dataset.l;
        const l = draft.lines.find(x => x.id === id);
        menu(ev, [
          { label: 'Duplicate', icon: 'file', run: () => {
            draft.lines.splice(draft.lines.indexOf(l) + 1, 0, { ...l, id: S.uid('wbl') });
            dirty = true; redraw();
          } },
          { label: 'Add a note…', icon: 'edit', run: async () => {
            const res = await formDlg('Line note', [
              { k: 'note', label: 'Note', value: l.note || '', span: 12,
                hint: 'Why this line is here, or what it assumes.' }]);
            if (res) { l.note = res.note; dirty = true; redraw(); }
          } },
          '-',
          { label: 'Remove', icon: 'trash', danger: true, run: () => {
            draft.lines = draft.lines.filter(x => x.id !== id); dirty = true; redraw();
          } },
        ]);
      },
      'add-line': () => addLineDialog().then(r => r && redraw()),
      /* Save what is on screen as a new preset. The quickest way to get one
         that matches your pipeline is to build it once and keep it, rather
         than to describe it in a form. */
      'save-preset': async () => {
        if (!draft.lines.length) return toast('Add some lines first.', 'warn');
        const res = await formDlg('Save as preset', [
          { k: 'label', label: 'Preset name', value: draft.name || '', required: true, span: 12,
            hint: 'What kind of deliverable this breakdown is for.' },
        ], { ok: 'Save preset' });
        if (!res) return;
        savePreset({ label: res.label.trim(), lines: linesToPreset(draft.lines) });
        toast(`Preset “${res.label.trim()}” saved — ${draft.lines.length} lines`, 'ok', 6000);
        redraw();
      },
      'add-preset': (el, ev) => menu(ev, wbPresets().map(p => ({
        label: p.label, icon: 'file',
        run: async () => {
          if (draft.lines.length && !await confirmDlg(
            `Replace the ${draft.lines.length} line${draft.lines.length === 1 ? '' : 's'} already here with “${p.label}”?`,
            { ok: 'Replace', title: 'Apply preset' })) return;
          applyPreset(p.id); redraw();
        },
      }))),
      'clear-lines': async () => {
        if (!await confirmDlg('Remove every line from this estimate?', { ok: 'Clear' })) return;
        draft.lines = []; dirty = true; redraw();
      },
      csv: csvLines,
      reset: async () => {
        if (dirty && !await confirmDlg('Start a new estimate and discard the unsaved changes?',
                                        { ok: 'Discard', title: 'Unsaved changes' })) return;
        draft = newEstimate(); dirty = false;
        history.replaceState(null, '', '#/gfxwb/calc');
        redraw();
      },
      save: async () => {
        if (!String(draft.name || '').trim()) {
          const res = await formDlg('Name this estimate', [
            { k: 'name', label: 'Deliverable', value: '', required: true, span: 12,
              hint: 'What is being estimated. This is how it appears in the list.' },
            { k: 'status', label: 'Status', type: 'select', value: draft.status, span: 12,
              opts: EST_STATUS.map(x => ({ v: x.id, t: x.label })) },
          ], { ok: 'Save' });
          if (!res) return;
          draft.name = res.name; draft.status = res.status;
        }
        saveEstimate(draft);
        dirty = false;
        toast(`“${draft.name}” saved`, 'ok');
        redraw();
      },
      'to-tasks': async () => {
        const r = estimate(draft);
        if (!r.lines.length) return toast('Nothing to turn into tasks.', 'warn');
        const ok = await confirmDlg(
          `Create ${r.lines.length} task${r.lines.length === 1 ? '' : 's'} at the top of Backlog, ` +
          `one per line, with the calculated hours as the estimate?`,
          { title: 'Create tasks', ok: 'Create', danger: false });
        if (!ok) return;
        const made = estimateToTasks(draft, { projectId: draft.projectId });
        toast(`${made.length} task${made.length === 1 ? '' : 's'} created`, 'ok', 5000);
      },
      'go-team': () => ctx.go('people'),
      'go-rates': () => ctx.go('finance'),
      'go-portfolio': () => ctx.go('projects'),

      /* --- logging --- */
      log: () => doLog(draft, ctx, redraw),

      /* --- the log --- */
      'go-proj': el => ctx.go('projects', el.dataset.p),
      'go-scopes': el => ctx.go('projects', el.closest('[data-p]').dataset.p, 'scopes'),
      'go-task': el => {
        const e = wbEstimate(el.closest('[data-e]').dataset.e);
        if (e?.logged?.taskId) ctx.go('tasks', e.logged.taskId);
      },
      'csv-log': csvLog,
      'log-menu': (el, ev) => {
        const id = el.closest('[data-e]').dataset.e;
        const e = wbEstimate(id);
        const task = e?.logged?.taskId ? S.byId(S.get().tasks, e.logged.taskId) : null;
        const proj = S.byId(S.get().projects, e?.logged?.projectId || e?.projectId);
        menu(ev, [
          ...(task ? [{ label: 'Open the task', icon: 'board', run: () => ctx.go('tasks', task.id) }] : []),
          ...(task && !task.jira?.key ? [{ label: 'Queue for Jira…', icon: 'link',
            run: () => bulkQueueDialog([task.id]).then(() => redraw()) }] : []),
          ...(task?.jira?.url ? [{ label: `Open ${task.jira.key}`, icon: 'link',
            run: () => openExternal(task.jira.url) }] : []),
          ...(proj ? [{ label: `Scopes for ${proj.code}`, icon: 'flag',
            run: () => ctx.go('projects', proj.id, 'scopes') }] : []),
          { label: 'Open in the calculator', icon: 'edit', run: () => ctx.go('gfxwb', 'calc', id) },
          '-',
          { label: 'Unlog', icon: 'undo', danger: true, run: async () => {
            if (!await confirmDlg(
              `Unlog “${e.name}”? The frozen numbers are discarded and it goes back to Quoted. ` +
              `The task it created stays on the board — it may already have work against it.`,
              { ok: 'Unlog', title: 'Unlog scope' })) return;
            unlogEstimate(id);
            toast('Unlogged', 'ok');
            redraw();
          } },
        ]);
      },

      /* --- estimates --- */
      estfilter: el => { ui.estStatus = el.value; saveUi(); redraw(); },
      'open-est': el => {
        const id = el.closest('[data-e]').dataset.e;
        ctx.go('gfxwb', 'calc', id);
      },
      'est-menu': (el, ev) => {
        const id = el.closest('[data-e]').dataset.e;
        const e = wbEstimate(id);
        menu(ev, [
          { label: 'Open in the calculator', icon: 'edit', run: () => ctx.go('gfxwb', 'calc', id) },
          { label: 'Duplicate', icon: 'file', run: () => {
            saveEstimate({ ...JSON.parse(JSON.stringify(e)), id: S.uid('wbe'),
                           name: e.name + ' (copy)', status: 'draft', created: Date.now() });
            redraw();
          } },
          '-',
          ...EST_STATUS.filter(x => x.id !== e.status).map(x => ({
            label: 'Mark ' + x.label.toLowerCase(), icon: 'check',
            run: () => { saveEstimate({ ...e, status: x.id }); redraw(); },
          })),
          '-',
          { label: 'Delete', icon: 'trash', danger: true, run: async () => {
            if (!await confirmDlg(`Delete the estimate “${e.name || '(unnamed)'}”?`, { ok: 'Delete' })) return;
            removeEstimate(id);
            if (draft?.id === id) { draft = newEstimate(); dirty = false; }
            redraw();
          } },
        ]);
      },
      'csv-estimates': csvEstimates,

      /* --- catalogue --- */
      catfilter: el => { ui.catDivision = el.value; saveUi(); redraw(); },
      'item-add': () => editItemDialog(null).then(r => r && redraw()),

      'preset-rename': async el => {
        const id = el.closest('[data-p]').dataset.p;
        const p = wbPreset(id);
        if (!p) return;
        const res = await formDlg('Rename preset', [
          { k: 'label', label: 'Preset name', value: p.label, required: true, span: 12 },
        ], { ok: 'Save' });
        if (!res) return;
        savePreset({ id, label: res.label.trim() });
        toast('Preset renamed', 'ok'); redraw();
      },
      'preset-del': async el => {
        const id = el.closest('[data-p]').dataset.p;
        const p = wbPreset(id);
        if (!p) return;
        if (!await confirmDlg(`Delete the preset “${p.label}”? Estimates already built from it are untouched.`,
                              { ok: 'Delete', danger: true, title: 'Delete preset' })) return;
        removePreset(id);
        toast('Preset deleted', 'ok'); redraw();
      },
      'item-menu': (el, ev) => {
        const id = el.closest('[data-i]').dataset.i;
        const it = wbItem(id);
        menu(ev, [
          { label: 'Edit…', icon: 'edit', run: () => editItemDialog(id).then(r => r && redraw()) },
          { label: 'Add to the current estimate', icon: 'plus', run: () => {
            if (!draft) draft = newEstimate();
            draft.lines.push(newLine(id)); dirty = true;
            toast(`“${it.name}” added to the estimate`, 'ok');
            redraw();
          } },
          '-',
          { label: 'Delete', icon: 'trash', danger: true, run: async () => {
            if (!await confirmDlg(
              `Delete “${it.name}” from the catalogue? Estimates already using it keep ` +
              `their own copy of the hours, so saved numbers do not change.`,
              { ok: 'Delete' })) return;
            removeItem(id); redraw();
          } },
        ]);
      },
      'csv-catalogue': csvCatalogue,

      /* --- rates --- */
      cfg: el => { setWbSetting({ [el.dataset.k]: Number(el.value) || 0 }); redraw(); },
    });

    /*
     * The Schedule panel's chart. Wired read-only on purpose: the bars are
     * a picture of a draft that is not saved yet, so dragging one would have
     * nothing to write to. Its crew comparison is the editable part, and it
     * edits the crew boxes above rather than the chart.
     */
    return wireGantt(host, {
      /* Folding was not wired here at all, so the arrow and the row were dead
         controls — worse than not offering them. */
      onFold: id => {
        if (wbFolded.has(id)) wbFolded.delete(id); else wbFolded.add(id);
        redraw();
      },
      onCell: () => toast('Open the Plan to see this week against every other project', '', 4000),
      /* Same drag handle as the other two charts, remembered with this
         screen's other view preferences. */
      onHeight: px => { ui.height = px; saveUi(); },
    });
  },
};
