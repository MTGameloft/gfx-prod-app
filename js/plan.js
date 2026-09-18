/**
 * plan.js — the planning engine behind the Gantt.
 *
 * The question this exists to answer, in the producer's own words:
 *
 *   "I have three projects running. An extra request comes in that takes
 *    another month. What am I missing for that period — and what does it cost
 *    me in crew and time if I put one person on it instead of two?"
 *
 * Answering that needs three things lined up on the same calendar, which
 * nothing in the app did before:
 *
 *   SUPPLY   how many person-days each division really has, week by week,
 *            after part-time capacity, leave and public holidays.
 *   DEMAND   how many person-days the committed work needs in those same
 *            weeks, spread across the days each piece of work occupies.
 *   COST     what both of those are worth, from the same rate card Finance
 *            uses, so the schedule and the budget cannot disagree.
 *
 * WHAT IS DELIBERATE HERE
 *
 * 1. EFFORT AND DURATION STAY SEPARATE. Inherited from wb.js, and the single
 *    most important rule in the file. Effort (person-hours) is what the work
 *    costs and crew never changes it. Duration (elapsed working days) is when
 *    it lands and crew divides it. A planner that multiplies them together is
 *    a planner that says two people cost twice as much, which is nonsense.
 *
 * 2. DEMAND IS SPREAD OVER WORKING DAYS, NOT CALENDAR DAYS. A scope running
 *    over Tet does not consume effort during Tet. Spreading by calendar day
 *    under-reports the crunch either side of a holiday, which is exactly when
 *    a producer needs the warning.
 *
 * 3. NOTHING IS DOUBLE-COUNTED. A project bar is context — a span you can see
 *    — and contributes no demand of its own. Demand comes from the work
 *    inside it: work-breakdown scopes and estimated tasks. A logged scope has
 *    a task on the board carrying the same hours, so that task is suppressed;
 *    counting both would make every signed-off estimate appear twice.
 *
 * 4. A SCENARIO NEVER TOUCHES THE STORE. It is an overlay computed on the
 *    fly: extra requests, different crew sizes, extra heads, shifted dates.
 *    You can hold three of them at once and compare them, and closing the tab
 *    loses nothing you would have wanted to keep. Committing one is a
 *    separate, explicit act — see `commitRequest()` in views/plan.js.
 *
 * Pure: reads state, returns numbers. No DOM, no mutators.
 */

import * as S from './store.js';
import {
  holidaySet, leaveDaysMap, leaveType, rateFor,
} from './calc.js';
import {
  wbDivisions, wbDivision, wbSettings, wbEstimates, estimate as wbEstimateCalc,
  hourlyRate, defaultSeniority,
} from './wb.js';
import { isoOf, toDate, addDays, today, sum } from './ui.js';
import { isoWeek } from './timescale.js';

/* ========================================================================= */
/* 1. The calendar                                                           */
/* ========================================================================= */

/**
 * A working-day calendar for a window, built once and passed around.
 *
 * Every function below that needs to know "is this a day people work" reads
 * it from here rather than recomputing, because the holiday set and the
 * working-day preference are two lookups that would otherwise happen tens of
 * thousands of times across a year-long grid.
 */
export function workCalendar(from, to) {
  const hol = holidaySet();
  const wdays = S.get().prefs?.workingDays || [1, 2, 3, 4, 5];
  const allowed = new Set(wdays);
  const days = [];
  const index = new Map();          // iso -> position in `days`
  let c = from, guard = 0;
  while (c <= to && guard++ < 2000) {
    const dow = toDate(c).getDay();
    const working = allowed.has(dow) && !hol.has(c);
    index.set(c, days.length);
    days.push({ iso: c, dow, working, holiday: hol.has(c) });
    c = addDays(c, 1);
  }
  return {
    from, to, days, index,
    isWorking: iso => days[index.get(iso)]?.working ?? false,
    /** Working days in [a,b] inclusive, clipped to the window. */
    count(a, b) {
      let n = 0;
      const i0 = Math.max(0, this.index.get(a) ?? 0);
      const i1 = Math.min(days.length - 1, this.index.get(b) ?? days.length - 1);
      for (let i = i0; i <= i1; i++) if (days[i].working) n++;
      return n;
    },
  };
}

/**
 * Walk forward `n` working days from a date. Unbounded by the window, because
 * a bar's end can fall outside the view and still has to be right.
 */
export function addWorkDays(fromIso, n) {
  const hol = holidaySet();
  const allowed = new Set(S.get().prefs?.workingDays || [1, 2, 3, 4, 5]);
  let d = fromIso, left = Math.max(0, Math.ceil(n) - 1), guard = 0;
  // the start day itself counts as the first working day
  while (guard++ < 4000 && (!allowed.has(toDate(d).getDay()) || hol.has(d))) d = addDays(d, 1);
  while (left > 0 && guard++ < 4000) {
    d = addDays(d, 1);
    if (allowed.has(toDate(d).getDay()) && !hol.has(d)) left--;
  }
  return d;
}

/** The next working day on or after `iso`. */
export function nextWorkDay(iso) { return addWorkDays(iso, 1); }

/* ========================================================================= */
/* 2. The period grid                                                        */
/* ========================================================================= */

export const GRAINS = [
  { id: 'week',  label: 'Week',  hint: 'One column a week — the resolution a crunch shows up at' },
  { id: 'month', label: 'Month', hint: 'One column a month — the resolution a budget is agreed at' },
];

/**
 * Split a window into periods of the chosen grain.
 *
 * Week is the default and it matters: a fortnight of overload inside a month
 * that balances out shows as green at month grain, and that is precisely the
 * fortnight somebody works the weekend. Month is offered because that is the
 * unit budgets and hiring decisions are made in.
 *
 * Each period carries its own working-day count, so February and a week
 * containing Tet are not silently treated as full.
 */
export function periodGrid(from, to, grain = 'week', cal = workCalendar(from, to)) {
  const out = [];
  const keyOf = grain === 'month'
    ? iso => iso.slice(0, 7)
    : iso => { const d = toDate(iso); return `${d.getFullYear()}-W${String(isoWeek(iso)).padStart(2, '0')}`; };
  const labelOf = grain === 'month'
    ? iso => toDate(iso).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
    : iso => 'W' + isoWeek(iso);

  for (const d of cal.days) {
    const k = keyOf(d.iso);
    const last = out[out.length - 1];
    if (last && last.key === k) { last.to = d.iso; last.days++; if (d.working) last.workDays++; }
    else out.push({ key: k, label: labelOf(d.iso), from: d.iso, to: d.iso,
                    days: 1, workDays: d.working ? 1 : 0, month: d.iso.slice(0, 7) });
  }
  return out;
}

/** period key -> index, for attributing a day to its column in O(1). */
function periodIndexOf(periods, cal) {
  const map = new Map();
  let p = 0;
  for (const d of cal.days) {
    while (p < periods.length - 1 && d.iso > periods[p].to) p++;
    map.set(d.iso, p);
  }
  return map;
}

/* ========================================================================= */
/* 3. Supply — how many person-days we actually have                         */
/* ========================================================================= */

/**
 * Per-division available person-days, one number per period.
 *
 * Built from the roster a day at a time rather than from `capacity(ym)`,
 * because that function answers per month and the whole point here is to see
 * inside a month. It agrees with it: same roster filter, same part-time
 * capacity, same leave, same holiday calendar.
 *
 * ALLOCATION IS NOT APPLIED. A person split 60/40 across two projects is
 * still one pair of hands for their division, and the question "can the 3D
 * team take this" is about hands. Allocation is a separate lens — see
 * `allocatedSupply()` — and conflating the two is how a plan ends up claiming
 * the team is free when every one of them is committed.
 *
 * @param {object} o
 * @param {Array<{division:string, fte:number, from:string, seniority:string}>} [o.extraHeads]
 *        scenario-only additions. `fte` may be fractional — half a contractor
 *        is a real thing to model, and a hire that starts mid-window only
 *        contributes from `from`.
 */
export function supply(periods, cal, { extraHeads = [], includePeople = null } = {}) {
  const s = S.get();
  const pIdx = periodIndexOf(periods, cal);
  const divs = wbDivisions();
  const byDiv = new Map(divs.map(d => [d.id, periods.map(() => 0)]));
  /* The same days again, multiplied by how much of each person is already
     promised to a project. See `loadGrid` for why this is the floor under
     demand rather than a second opinion about it. */
  const allocDiv = new Map(divs.map(d => [d.id, periods.map(() => 0)]));
  const heads = new Map(divs.map(d => [d.id, 0]));
  const rows = [];

  for (const p of s.people || []) {
    if (p.active === false) continue;
    if (includePeople && !includePeople.has(p.id)) continue;
    const lane = byDiv.get(p.division);
    if (!lane) continue;                       // a division that no longer exists
    heads.set(p.division, heads.get(p.division) + 1);
    const cap = (p.capacity ?? 100) / 100;
    const away = leaveDaysMap(p.id);           // iso -> the leave record
    const own = periods.map(() => 0);

    for (const d of cal.days) {
      if (!d.working) continue;
      /* The same test `leaveDaysInMonth` uses, so the two agree: working from
         home is not absence, and a half day is half a day. Reading this map
         as a plain "is there an entry" would delete every WFH day from the
         team's capacity, which would be a large and silent error. */
      const l = away.get(d.iso);
      const off = l && (leaveType(l.type).counts || l.type === 'training')
        ? (l.half ? 0.5 : 1) : 0;
      const avail = 1 - off;
      if (avail <= 0) continue;
      own[pIdx.get(d.iso)] += avail * cap;
    }
    /* Over-allocation is a real and separate problem — the Team view flags
       anyone past 100% — but it must not inflate the division's committed
       days beyond the person who is over-allocated, or one bad record makes
       the whole plan look impossible. Capped at the whole person. */
    const promised = Math.min(1, sum(p.alloc || [], a => (Number(a.pct) || 0) / 100));
    const aLane = allocDiv.get(p.division);
    for (let i = 0; i < periods.length; i++) {
      lane[i] += own[i];
      aLane[i] += own[i] * promised;
    }
    rows.push({ person: p, division: p.division, days: own, total: sum(own),
                allocPct: promised * 100 });
  }

  /* Scenario heads. No leave record, so they are modelled at full working
     days from their start — which is the optimistic case, and the tooltip
     says so rather than the model pretending otherwise. */
  for (const hEntry of extraHeads) {
    const lane = byDiv.get(hEntry.division);
    if (!lane) continue;
    const fte = Number(hEntry.fte) || 0;
    if (!fte) continue;
    const from = hEntry.from || cal.from;
    const own = periods.map(() => 0);
    for (const d of cal.days) {
      if (!d.working || d.iso < from) continue;
      own[pIdx.get(d.iso)] += fte;
    }
    for (let i = 0; i < periods.length; i++) lane[i] += own[i];
    heads.set(hEntry.division, heads.get(hEntry.division) + fte);
    rows.push({ person: { id: hEntry.id || 'new', name: hEntry.label || `New ${hEntry.division}`,
                          seniority: hEntry.seniority, division: hEntry.division, scenario: true },
                division: hEntry.division, days: own, total: sum(own), scenario: true });
  }

  return {
    periods, divisions: divs, rows,
    byDivision: byDiv,
    allocByDivision: allocDiv,
    heads,
    total: periods.map((_, i) => sum(divs, d => byDiv.get(d.id)[i])),
  };
}

/**
 * The same roster seen through allocation: how much of each division is
 * nominally promised to each project.
 *
 * Used for the "committed vs available" read on the capacity strip. A team at
 * 100% allocation with no scheduled work is not free — it means somebody has
 * promised those hands elsewhere and has not written down what to.
 */
export function allocatedSupply() {
  const out = new Map();
  for (const p of S.get().people || []) {
    if (p.active === false) continue;
    for (const a of p.alloc || []) {
      const k = `${p.division}|${a.projectId}`;
      out.set(k, (out.get(k) || 0) + (Number(a.pct) || 0) / 100);
    }
  }
  return out;
}

/* ========================================================================= */
/* 4. Demand — the work, as bars on a calendar                               */
/* ========================================================================= */

/**
 * The shape every row on the Gantt reduces to.
 *
 * @typedef {object} Bar
 * @property {string} id            stable, so a scenario can address one
 * @property {'project'|'scope'|'division'|'task'|'request'|'milestone'} kind
 * @property {string} label
 * @property {string} parentId      '' for a top-level row
 * @property {string} projectId
 * @property {string} divisionId    '' where the bar spans several
 * @property {string} start         ISO, first working day
 * @property {string} end           ISO, last working day
 * @property {number} hours         person-hours of effort, 0 for context rows
 * @property {number} crew          people working it in parallel
 * @property {number} cost
 * @property {boolean} demand       does it consume capacity (context rows: no)
 * @property {string} color
 * @property {string} ref           the underlying record's id
 */

const HPD = () => Math.max(1, wbSettings().hoursPerDay);

/**
 * Turn one work-breakdown estimate into a parent bar and one child per
 * division, honouring the estimate's own parallel / sequential choice.
 *
 * This is where the Gantt gets its real content. A WB estimate already knows
 * hours per division, crew per division and whether the disciplines run
 * together — which is a schedule in everything but presentation.
 *
 * `crewOverride` is the scenario hook: `{2D: 2, 3D: 1}` re-crews the estimate
 * without touching it, which is the whole "what if I put two people on it"
 * question in one argument.
 */
export function scopeBars(est, { crewOverride = null, startOverride = null,
                                 idPrefix = '', state = S.get() } = {}) {
  const calc = wbEstimateCalc(est, state);
  const hpd = calc.hpd || HPD();
  const start = startOverride || est.startDate || today();
  const proj = S.byId(state.projects, est.projectId);
  const pid = `${idPrefix}scope:${est.id}`;

  const kids = [];
  let cursor = start;
  let latest = start;

  /* Longest-first when sequential, so the chain reads the way the work is
     usually ordered and a one-hour line does not sit in front of a fortnight
     of modelling. Parallel keeps roster order, which groups the disciplines
     the way the team is organised. */
  const lanes = est.parallel === false
    ? calc.byDivision.slice().sort((a, b) => b.hours - a.hours)
    : calc.byDivision;

  for (const d of lanes) {
    if (!d.hours) continue;
    const crew = crewOverride && crewOverride[d.division.id] != null
      ? Math.max(0, Math.floor(Number(crewOverride[d.division.id]) || 0))
      : d.crew;
    /* Nobody on it never finishes. A bar of infinite length cannot be drawn,
       so it is flagged and given a nominal single-person length — the row
       says "unstaffed" in red rather than silently showing a plausible bar. */
    const unstaffed = crew === 0;
    const effective = unstaffed ? 1 : crew;
    const days = Math.max(1, Math.ceil(d.hours / hpd / effective));
    const from = est.parallel === false ? cursor : start;
    const to = addWorkDays(from, days);
    if (est.parallel === false) cursor = addWorkDays(to, 2);   // next starts the following day
    if (to > latest) latest = to;

    kids.push({
      id: `${pid}:${d.division.id}`, kind: 'division', parentId: pid,
      label: d.division.label, projectId: est.projectId, divisionId: d.division.id,
      start: from, end: to, workDays: days,
      hours: d.hours, crew, unstaffed,
      cost: d.cost, demand: true,
      color: d.division.color || 'var(--muted)',
      ref: est.id, sub: `${d.lines} line${d.lines === 1 ? '' : 's'}`,
    });
  }

  const parent = {
    id: pid, kind: 'scope', parentId: '', label: est.name || '(unnamed estimate)',
    projectId: est.projectId, divisionId: '',
    start, end: latest, workDays: Math.max(1, Math.ceil(calc.elapsedDays || 1)),
    hours: calc.totalHours, crew: calc.crewTotal, cost: calc.totalCost,
    demand: false,                      // its children carry the demand
    color: proj?.color || 'var(--accent)',
    ref: est.id, status: est.status,
    logged: !!est.logged,
    sub: `${calc.lines.length} line${calc.lines.length === 1 ? '' : 's'}`,
    /* Review and contingency are inside totalHours but outside the per-division
       lane hours, so the gap is stated rather than silently lost. */
    upliftPct: calc.upliftPct,
  };

  return { parent, children: kids, calc };
}

/**
 * A task with an estimate and a due date, as a bar.
 *
 * Placed by working back from the due date, because a due date is a promise
 * and a start date on a task rarely is. A task with no estimate has no
 * duration to draw and no demand to count, so it becomes a pip on the
 * project row instead — see `milestoneMarks()`.
 */
export function taskBar(t, state = S.get()) {
  const hpd = HPD();
  const hours = Number(t.estimate) || 0;
  if (!hours || !t.due) return null;
  const days = Math.max(1, Math.ceil(hours / hpd));
  /* One person unless somebody is named, which is the honest default: an
     unassigned task is one person's work until it is given to a pair. */
  const end = t.due;
  const start = backWorkDays(end, days);
  const div = wbDivision(t.division, state);
  const p = S.byId(state.projects, t.project);
  const sen = state.people.find(x => x.id === t.assignee)?.seniority || defaultSeniority(t.division);
  return {
    id: `task:${t.id}`, kind: 'task', parentId: p ? `project:${p.id}` : '',
    label: t.title, projectId: t.project || '', divisionId: t.division || '',
    start, end, workDays: days, hours, crew: 1,
    cost: hours * hourlyRate(sen),
    demand: t.status !== 'done',
    color: div.color || 'var(--muted)',
    ref: t.id, status: t.status,
    overdue: t.status !== 'done' && t.due < today(),
    sub: t.assignee ? S.personName(t.assignee) : 'Unassigned',
  };
}

/** Walk backwards `n` working days — the mirror of addWorkDays. */
export function backWorkDays(fromIso, n) {
  const hol = holidaySet();
  const allowed = new Set(S.get().prefs?.workingDays || [1, 2, 3, 4, 5]);
  let d = fromIso, left = Math.max(0, Math.ceil(n) - 1), guard = 0;
  while (guard++ < 4000 && (!allowed.has(toDate(d).getDay()) || hol.has(d))) d = addDays(d, -1);
  while (left > 0 && guard++ < 4000) {
    d = addDays(d, -1);
    if (allowed.has(toDate(d).getDay()) && !hol.has(d)) left--;
  }
  return d;
}

/**
 * Everything on the board, as a flat list of bars in render order.
 *
 * Grouped by project, because that is how a portfolio is read. Within a
 * project: its scopes (each with its division children), then its estimated
 * tasks, then anything the scenario has added.
 *
 * @param {object} o
 * @param {Set<string>|null} o.projects   which projects to include
 * @param {Set<string>|null} o.divisions  narrow to these divisions
 * @param {boolean} o.showTasks
 * @param {object|null} o.scenario
 */
export function buildBars({ projects = null, divisions = null, showTasks = true,
                            includeDone = false, scenario = null, state = S.get() } = {}) {
  const bars = [];
  const ests = wbEstimates(state).filter(e => e.status !== 'dropped');
  const wanted = p => !projects || projects.has(p);

  /* Tasks created BY a logged scope carry that scope's hours. The scope bar
     already counts them, so counting the task too would double every signed
     estimate. One id set, computed once. */
  const scopeTasks = new Set(ests.filter(e => e.logged?.taskId).map(e => e.logged.taskId));

  const projectsList = (state.projects || [])
    .filter(p => p.status !== 'archived' && wanted(p.id));

  const ungrouped = { id: '', code: '—', name: 'No project', color: 'var(--muted)',
                      start: '', end: '', milestones: [] };
  const groups = [...projectsList];
  if (!projects || projects.has('')) {
    const orphan = ests.some(e => !e.projectId) ||
                   (state.tasks || []).some(t => !t.project && t.estimate && t.due);
    if (orphan) groups.push(ungrouped);
  }

  for (const p of groups) {
    const row = {
      id: `project:${p.id}`, kind: 'project', parentId: '', label: p.name,
      code: p.code, projectId: p.id, divisionId: '',
      start: p.start || '', end: p.end || '',
      hours: 0, crew: 0, cost: Number(p.budget) || 0, demand: false,
      color: p.color || 'var(--accent)', ref: p.id,
      phase: p.phase || '', status: p.status || '',
      milestones: (p.milestones || []).filter(m => m.date),
    };
    bars.push(row);

    for (const e of ests) {
      if ((e.projectId || '') !== p.id) continue;
      const ov = scenario?.crew?.[e.id] || null;
      const shift = scenario?.shift?.[e.id];
      const st = shift ? addWorkDays(e.startDate || today(), shift + 1) : null;
      const { parent, children } = scopeBars(e, { crewOverride: ov, startOverride: st, state });
      parent.parentId = row.id;
      children.forEach(c => { c.projectId = p.id; });
      if (!divisions || children.some(c => divisions.has(c.divisionId))) {
        bars.push(parent, ...children.filter(c => !divisions || divisions.has(c.divisionId)));
      }
    }

    if (showTasks) {
      for (const t of state.tasks || []) {
        if ((t.project || '') !== p.id) continue;
        if (scopeTasks.has(t.id)) continue;
        if (!includeDone && t.status === 'done') continue;
        if (divisions && !divisions.has(t.division)) continue;
        const b = taskBar(t, state);
        if (b) { b.parentId = row.id; bars.push(b); }
      }
    }
  }

  /* Scenario requests last, so a what-if always reads as an addition on top
     of the real plan rather than as part of it. */
  for (const r of scenario?.requests || []) {
    if (projects && r.projectId && !projects.has(r.projectId)) continue;
    const { parent, children } = requestBars(r, state);
    bars.push(parent, ...children.filter(c => !divisions || divisions.has(c.divisionId)));
  }

  return bars;
}

/* ========================================================================= */
/* 5. Requests — the thing that has not been agreed yet                      */
/* ========================================================================= */

/**
 * A request is an extra ask that has not been accepted.
 *
 * Deliberately lighter than a work-breakdown estimate: hours per division, a
 * wanted start, optionally a deadline, and a crew per division. That is the
 * information a producer has in the five minutes after somebody walks over
 * and asks for a seasonal event, and demanding a full breakdown before the
 * app will tell you whether it fits is exactly the friction that makes people
 * answer from their gut instead.
 *
 * A request can be promoted into a real estimate later — see
 * `requestToEstimate()`.
 */
export function newRequest(patch = {}) {
  return {
    id: S.uid('req'),
    name: 'New request',
    projectId: '',
    start: nextWorkDay(today()),
    deadline: '',
    parallel: true,
    lines: [],                 // [{ division, hours, seniority }]
    crew: {},                  // division -> people
    contingencyPct: wbSettings().contingencyPct,
    reviewPct: wbSettings().reviewPct,
    ...patch,
  };
}

/** The uplift a request carries, as a multiplier. */
const upliftOf = r => 1 + (Math.max(0, Number(r.reviewPct) || 0) +
                           Math.max(0, Number(r.contingencyPct) || 0)) / 100;

/** Crew for one division of a request. Absent means one; zero means zero. */
export function reqCrew(r, divId) {
  const raw = r?.crew?.[divId];
  if (raw === undefined || raw === null || raw === '') return 1;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/** Cost and duration of a request, the same maths as an estimate. */
export function requestCalc(r, state = S.get()) {
  const hpd = HPD();
  const up = upliftOf(r);
  const lanes = (r.lines || []).filter(l => Number(l.hours) > 0).map(l => {
    const div = wbDivision(l.division, state);
    const sen = l.seniority || defaultSeniority(l.division);
    const hours = (Number(l.hours) || 0) * up;
    const crew = reqCrew(r, l.division);
    return {
      division: div, hours, crew,
      unstaffed: crew === 0,
      days: Math.max(1, Math.ceil(hours / hpd / Math.max(1, crew))),
      seniority: sen,
      rate: hourlyRate(sen),
      cost: hours * hourlyRate(sen),
    };
  });
  const elapsed = r.parallel === false
    ? sum(lanes, l => l.days)
    : lanes.reduce((n, l) => Math.max(n, l.days), 0);
  const hours = sum(lanes, l => l.hours);
  const cost = sum(lanes, l => l.cost);
  const start = r.start || nextWorkDay(today());
  const finish = elapsed ? addWorkDays(start, elapsed) : start;
  return {
    lanes, hours, cost, elapsedDays: elapsed, start, finish,
    effortDays: hours / hpd,
    crewTotal: sum(lanes, l => l.crew),
    /* A deadline that the duration cannot reach is the single most useful
       thing this screen can tell you, so it is computed, not left to the eye. */
    missesDeadline: !!(r.deadline && finish > r.deadline),
    slackDays: r.deadline ? workDaysBetween(finish, r.deadline) : null,
    /* What crew each lane would need to hit the deadline, if there is one. */
    crewForDeadline: r.deadline ? lanes.map(l => {
      const avail = Math.max(1, workDaysBetween(start, r.deadline));
      return { division: l.division, need: Math.ceil(l.hours / hpd / avail) };
    }) : [],
  };
}

/** Signed working-day distance: positive when `b` is after `a`. */
export function workDaysBetween(a, b) {
  if (!a || !b) return 0;
  const sign = b < a ? -1 : 1;
  const [lo, hi] = sign > 0 ? [a, b] : [b, a];
  const cal = workCalendar(lo, hi);
  return sign * cal.count(lo, hi);
}

export function requestBars(r, state = S.get()) {
  const c = requestCalc(r, state);
  const pid = `request:${r.id}`;
  let cursor = c.start, latest = c.start;
  const children = c.lanes.map(l => {
    const from = r.parallel === false ? cursor : c.start;
    const to = addWorkDays(from, l.days);
    if (r.parallel === false) cursor = addWorkDays(to, 2);
    if (to > latest) latest = to;
    return {
      id: `${pid}:${l.division.id}`, kind: 'division', parentId: pid,
      label: l.division.label, projectId: r.projectId || '', divisionId: l.division.id,
      start: from, end: to, workDays: l.days,
      hours: l.hours, crew: l.crew, unstaffed: l.unstaffed, cost: l.cost,
      demand: true, scenario: true,
      color: l.division.color || 'var(--muted)', ref: r.id,
    };
  });
  return {
    parent: {
      id: pid, kind: 'request', parentId: '', label: r.name || 'Request',
      projectId: r.projectId || '', divisionId: '',
      start: c.start, end: latest, workDays: c.elapsedDays,
      hours: c.hours, crew: c.crewTotal, cost: c.cost,
      demand: false, scenario: true,
      color: 'var(--warn)', ref: r.id,
      deadline: r.deadline || '', missesDeadline: c.missesDeadline,
      sub: `${c.lanes.length} division${c.lanes.length === 1 ? '' : 's'}`,
    },
    children, calc: c,
  };
}

/* ========================================================================= */
/* 6. Load — supply against demand, period by period                         */
/* ========================================================================= */

/**
 * Spread a bar's effort across the working days it occupies, and total it
 * into the periods it touches.
 *
 * Even spreading is a modelling choice and worth naming: real work ramps and
 * tails. But a producer cannot tell you the shape, and a made-up S-curve
 * would move the overload warning to a week nobody chose. Flat is the
 * defensible default, and the clipping to the visible window is what keeps a
 * bar that starts before the view from dumping its whole effort into week one.
 */
function spreadBar(bar, periods, cal, pIdx, out) {
  const hpd = HPD();
  const days = [];
  let c = bar.start, guard = 0;
  while (c <= bar.end && guard++ < 2000) {
    if (cal.index.has(c) && cal.isWorking(c)) days.push(c);
    c = addDays(c, 1);
  }
  /* The bar's total working length, including any part outside the window —
     the per-day rate must not change because you scrolled. */
  const fullLength = Math.max(1, bar.workDays || workDaysBetween(bar.start, bar.end) + 1);
  const perDay = (bar.hours / hpd) / fullLength;
  for (const iso of days) out[pIdx.get(iso)] += perDay;
}

/**
 * The whole picture: per division, per period — available, needed, gap.
 *
 * `loadPct` is demand ÷ supply. Above 100 is an overload, and the number of
 * person-days short is what you would put in a hiring or outsourcing request,
 * so it is returned as days rather than only as a percentage.
 */
export function loadGrid(bars, periods, cal, sup, { useAllocation = true } = {}) {
  const pIdx = periodIndexOf(periods, cal);
  const divs = sup.divisions;
  /* Two lanes, and keeping them apart is what makes the model behave: the
     committed plan is reconciled against allocation, a scenario's work is
     added on top of whatever that comes to. See the note on `rows` below. */
  const demandBy = new Map(divs.map(d => [d.id, periods.map(() => 0)]));
  const scnBy    = new Map(divs.map(d => [d.id, periods.map(() => 0)]));
  const contributors = new Map();          // `${div}|${period}` -> Bar[]

  for (const b of bars) {
    if (!b.demand || !b.hours || !b.divisionId) continue;
    const lane = (b.scenario ? scnBy : demandBy).get(b.divisionId);
    if (!lane) continue;
    const before = lane.slice();
    spreadBar(b, periods, cal, pIdx, lane);
    for (let i = 0; i < periods.length; i++) {
      if (lane[i] - before[i] > 0.001) {
        const k = `${b.divisionId}|${i}`;
        if (!contributors.has(k)) contributors.set(k, []);
        contributors.get(k).push({ bar: b, days: lane[i] - before[i] });
      }
    }
  }

  /*
   * ALLOCATION IS THE FLOOR UNDER DEMAND, AND THIS IS THE IMPORTANT BIT.
   *
   * Scheduled bars only cover work somebody has written down. On a real team
   * most of what people do is never a task with an estimate and a due date,
   * so counting only bars reports a fully committed 2D team as 20% busy and
   * cheerfully says yes to everything. That is not a conservative model; it
   * is a wrong one, and it is wrong in the direction that gets people
   * overworked.
   *
   * So the COMMITTED plan is `max(allocated, scheduled)`, not their sum. MAX,
   * because those are two readings of the same work at different
   * resolutions: allocation says "these people are spoken for", bars say
   * "here is the part we itemised". Adding them would double-count every
   * estimate that was properly broken down — which would punish exactly the
   * discipline the app is trying to encourage.
   *
   * SCENARIO WORK IS THEN ADDED ON TOP, and that part is a sum. A new ask is
   * genuinely extra: nobody's allocation already covers a thing nobody has
   * agreed to. Folding it into the same max() would hide a request entirely
   * behind a fully-allocated team — the request would look free, which is
   * the exact opposite of what this screen is for.
   *
   * Every number is kept on the cell, so the tooltip can say which one is
   * binding, and the toggle can turn the floor off for a team whose work
   * genuinely is all on the board.
   */
  const rows = divs.map(d => {
    const avail = sup.byDivision.get(d.id) || periods.map(() => 0);
    const alloc = sup.allocByDivision?.get(d.id) || periods.map(() => 0);
    const sched = demandBy.get(d.id) || periods.map(() => 0);
    const extra = scnBy.get(d.id) || periods.map(() => 0);
    const cells = periods.map((p, i) => {
      const a = avail[i];
      const committed = Math.max(useAllocation ? alloc[i] : 0, sched[i]);
      const n = committed + extra[i];
      return {
        period: p, available: a, needed: n,
        scheduled: sched[i], allocated: alloc[i], extra: extra[i], committed,
        /* Which reading is setting the committed part, so the tooltip can say
           so rather than leaving the producer to wonder where it came from. */
        source: useAllocation && alloc[i] > sched[i] ? 'allocation' : 'scheduled',
        gap: n - a,
        loadPct: a > 0 ? (n / a) * 100 : (n > 0 ? Infinity : 0),
        over: n - a > 0.05,
        contributors: contributors.get(`${d.id}|${i}`) || [],
      };
    });
    return {
      division: d, cells,
      heads: sup.heads.get(d.id) || 0,
      totalAvailable: sum(avail),
      totalNeeded: sum(cells, c => c.needed),
      totalScheduled: sum(sched),
      totalAllocated: sum(alloc),
      totalExtra: sum(extra),
      shortfallDays: sum(cells, c => Math.max(0, c.gap)),
      idleDays: sum(cells, c => Math.max(0, -c.gap)),
      /* Infinity is kept rather than flattened to a big number. A division
         with work and nobody in it is not "999% loaded" — it is unstaffed,
         which no amount of crew on the OTHER divisions fixes, and a
         plausible-looking percentage would send the reader looking for the
         wrong remedy. The views print "no crew". */
      peakPct: cells.reduce((m, c) => (c.loadPct > m ? c.loadPct : m), 0),
      unstaffed: (sup.heads.get(d.id) || 0) === 0 && sum(cells, c => c.needed) > 0.05,
    };
  });

  const totals = periods.map((p, i) => {
    const a = sum(rows, r => r.cells[i].available);
    const n = sum(rows, r => r.cells[i].needed);
    return { period: p, available: a, needed: n, gap: n - a,
             loadPct: a > 0 ? (n / a) * 100 : (n > 0 ? Infinity : 0) };
  });

  return {
    periods, rows, totals,
    shortfallDays: sum(rows, r => r.shortfallDays),
    /* The periods where at least one division cannot cover its work. This is
       the answer to "what am I missing for that particular period", and it is
       a list of concrete weeks with a number of days against each. */
    pinchPoints: periods.map((p, i) => ({
      period: p,
      divisions: rows.filter(r => r.cells[i].over)
        .map(r => ({ division: r.division, gap: r.cells[i].gap, loadPct: r.cells[i].loadPct })),
    })).filter(x => x.divisions.length)
      .map(x => ({ ...x, gap: sum(x.divisions, d => d.gap) })),
  };
}

/* ========================================================================= */
/* 7. Scenarios                                                              */
/* ========================================================================= */

/**
 * A scenario is an overlay, never a saved plan.
 *
 * `baseline` is the empty one: the plan as it stands. Everything else is a
 * copy of it plus requests, crew changes, extra heads and shifted dates, and
 * comparing two of them is the point of the feature.
 */
export function newScenario(patch = {}) {
  return {
    id: S.uid('scn'),
    name: 'Scenario',
    requests: [],
    crew: {},          // estimateId -> { divisionId: crew }
    shift: {},         // estimateId -> working days to push
    extraHeads: [],    // { id, division, seniority, fte, from, label }
    ...patch,
  };
}

export const BASELINE = { id: 'baseline', name: 'As it stands', requests: [],
                          crew: {}, shift: {}, extraHeads: [] };

/**
 * Run one scenario over a window and return everything a view needs.
 *
 * Deliberately returns the bars as well as the numbers: the Gantt and the
 * capacity strip must be two readings of ONE simulation, or they will
 * eventually disagree and the disagreement will be believed.
 */
export function simulate(scenario, { from, to, grain = 'week', projects = null,
                                     divisions = null, showTasks = true,
                                     useAllocation = true,
                                     state = S.get() } = {}) {
  const cal = workCalendar(from, to);
  const periods = periodGrid(from, to, grain, cal);
  const sup = supply(periods, cal, { extraHeads: scenario?.extraHeads || [] });
  const bars = buildBars({ projects, divisions, showTasks, scenario, state });
  const load = loadGrid(bars, periods, cal, sup, { useAllocation });

  /* What the scenario adds, priced. Extra heads are a monthly salary for the
     months they are present; requests are their own effort at the rate card.
     Both are the marginal number — what saying yes costs — which is what gets
     asked for in the meeting. */
  const reqCost = sum(scenario?.requests || [], r => requestCalc(r, state).cost);
  const headCost = sum(scenario?.extraHeads || [], hd => {
    const months = monthsBetween(hd.from || from, to);
    return (Number(hd.fte) || 0) * rateFor(hd.seniority) * months;
  });

  const reqs = (scenario?.requests || []).map(r => ({ request: r, calc: requestCalc(r, state) }));

  return {
    scenario: scenario || BASELINE,
    from, to, grain, cal, periods, supply: sup, bars, load,
    requests: reqs,
    addedCost: reqCost + headCost,
    requestCost: reqCost,
    headCost,
    /* The headline three numbers a comparison needs. */
    summary: {
      finish: reqs.reduce((d, r) => (r.calc.finish > d ? r.calc.finish : d), ''),
      shortfallDays: load.shortfallDays,
      pinchPeriods: load.pinchPoints.length,
      peakPct: load.rows.reduce((m, r) => Math.max(m, r.peakPct), 0),
      cost: reqCost + headCost,
      missedDeadlines: reqs.filter(r => r.calc.missesDeadline).length,
    },
  };
}

const monthsBetween = (a, b) => {
  if (!a || !b) return 0;
  const [y1, m1] = a.slice(0, 7).split('-').map(Number);
  const [y2, m2] = b.slice(0, 7).split('-').map(Number);
  return Math.max(0, (y2 - y1) * 12 + (m2 - m1) + 1);
};

/**
 * The crew sweep: the same request at one person, two, three… on one axis.
 *
 * This is the literal question the feature was asked for. For each crew size
 * it reports when the work lands, whether that clears the deadline, what it
 * costs (which barely moves — effort is effort) and, crucially, how much it
 * overloads the division (which moves a great deal).
 *
 * The lesson it teaches by showing it: doubling the crew halves the elapsed
 * time and doubles the weekly draw on the team. Whether that is affordable is
 * a capacity question, not a cost question, and the table puts both side by
 * side so the trade is visible instead of argued.
 */
export function crewSweep(request, base, { max = 4, from, to, grain = 'week',
                                           useAllocation = true, state = S.get() } = {}) {
  const divs = [...new Set((request.lines || [])
    .filter(l => Number(l.hours) > 0).map(l => l.division))];
  const out = [];
  for (let n = 1; n <= max; n++) {
    const r = { ...request, crew: Object.fromEntries(divs.map(d => [d, n])) };
    const scn = { ...(base || BASELINE),
                  requests: [...(base?.requests || []).filter(x => x.id !== request.id), r] };
    const sim = simulate(scn, { from, to, grain, useAllocation, state });
    const calc = requestCalc(r, state);
    out.push({
      crew: n, calc,
      finish: calc.finish,
      elapsedDays: calc.elapsedDays,
      cost: calc.cost,
      meetsDeadline: !request.deadline || !calc.missesDeadline,
      shortfallDays: sim.load.shortfallDays,
      pinchPeriods: sim.load.pinchPoints.length,
      peakPct: sim.load.rows.reduce((m, x) => Math.max(m, x.peakPct), 0),
      /* Which divisions this crew size breaks, so the row is actionable
         rather than just red. */
      broken: sim.load.rows.filter(x => x.shortfallDays > 0.5)
        .map(x => ({ division: x.division, days: x.shortfallDays, unstaffed: x.unstaffed })),
      /* Separated out because it is a different problem with a different
         answer. Work in a division with nobody in it cannot be fixed by
         putting more people on the other divisions, so a recommendation that
         says "try a bigger crew" would be advice that cannot work. */
      unstaffed: sim.load.rows.filter(x => x.unstaffed).map(x => x.division),
    });
  }
  return out;
}

/**
 * The smallest crew that clears the deadline without overloading anyone, and
 * the smallest that clears it at all. Either can be absent, and saying so is
 * more use than returning the nearest miss.
 */
export function recommendCrew(sweep) {
  const clean = sweep.find(r => r.meetsDeadline && r.shortfallDays < 0.5);
  const anyDeadline = sweep.find(r => r.meetsDeadline);
  /*
   * Unstaffed divisions are reported separately because they make every row
   * fail for a reason crew size cannot touch. Without this the advice reads
   * "no crew size fits" when the truth is "there is nobody in VFX".
   */
  const unstaffed = sweep[0]?.unstaffed || [];
  /* Would a bigger crew be enough if those divisions were staffed? Answered
     by ignoring their shortfall, so the recommendation stays useful. */
  const cleanIgnoringUnstaffed = unstaffed.length
    ? sweep.find(r => r.meetsDeadline &&
        r.broken.filter(b => !b.unstaffed).reduce((n, b) => n + b.days, 0) < 0.5)
    : null;
  return {
    clean: clean || null,
    meetsDeadline: anyDeadline || null,
    unstaffed,
    cleanIgnoringUnstaffed: cleanIgnoringUnstaffed || null,
  };
}

/* ========================================================================= */
/* 8. Window helpers                                                         */
/* ========================================================================= */

export const WINDOWS = [
  ['3m', '3 months'], ['6m', '6 months'], ['12m', '1 year'],
];

/** The default planning window: a fortnight behind for context, N months on. */
export function planWindow(range = '6m', anchor = today()) {
  const months = { '3m': 3, '6m': 6, '12m': 12 }[range] || 6;
  const from = addDays(anchor, -14);
  const d = toDate(anchor);
  d.setMonth(d.getMonth() + months);
  return { from, to: isoOf(d) };
}

/**
 * Widen a window so nothing planned falls outside it.
 *
 * A scenario whose request starts in eight months would otherwise be invisible
 * on a six-month view, and an invisible what-if is a what-if nobody checks.
 */
export function coverBars(win, bars) {
  let { from, to } = win;
  for (const b of bars) {
    if (b.start && b.start < from) from = b.start;
    if (b.end && b.end > to) to = b.end;
  }
  return { from, to };
}
