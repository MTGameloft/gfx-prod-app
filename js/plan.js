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
  holidaySet, leaveDaysMap, leaveType, rateFor, capacityPct,
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
 * @param {Set|null} [o.forProjects]
 *        Narrow the supply to the PEOPLE ON these projects — who, not how
 *        much. Everybody who is on one is counted at their whole working
 *        week; see the note at `memberOf` and at the `onIt` test below.
 *
 *        Without it the supply is the division's whole roster, which is the
 *        right denominator on a portfolio-wide chart: the question there is
 *        "can the 3D team take this", and the team is the team. On one
 *        project's chart the question is "can the people on this project take
 *        it", and weighing a two-person project's scope against all ten 2D
 *        artists makes it look like a fifth of the load it is.
 *
 *        Pass this and leave `useAllocation` off in `loadGrid`. The
 *        allocation floor under demand is a statement about the same
 *        percentages this deliberately no longer reads, and mixing the two
 *        readings in one chart is how the numbers stopped meaning anything.
 */
/**
 * Is this person on one of these projects?
 *
 * Two ways to be, and both count. Allocation is the on-paper answer — you put
 * them on it. Their name on a work-breakdown line is the answer from the work
 * itself, and it has to count too, or naming somebody on a project they were
 * never formally allocated to would book their time against a chart that has
 * no capacity for them, which reads as a division that cannot do its own work.
 */
export function memberOf(person, projectIds, state = S.get()) {
  if ((person.alloc || []).some(a => projectIds.has(a.projectId) && (Number(a.pct) || 0) > 0)) return true;
  for (const e of state.wbEstimates || []) {
    if (!projectIds.has(e.projectId)) continue;
    for (const l of e.lines || []) if ((l.people || []).includes(person.id)) return true;
  }
  return (state.tasks || []).some(t => t.assignee === person.id && projectIds.has(t.project));
}

export function supply(periods, cal, { extraHeads = [], includePeople = null,
                                       forProjects = null } = {}) {
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
  /* Everyone the roster holds who ends up in no division's supply, and why.
     They used to be dropped without a word, which is the worst way to be
     wrong: a team short of the people it thinks it has, reported as a team
     that fits. The views print the count — see `skippedNote()`. */
  const skipped = [];

  for (const p of s.people || []) {
    if (p.active === false) continue;
    if (includePeople && !includePeople.has(p.id)) continue;
    const lane = byDiv.get(p.division);
    if (!lane) {
      skipped.push({ person: p, why: p.division ? 'unknown' : 'none' });
      continue;
    }
    /*
     * `forProjects` says WHO, never HOW MUCH.
     *
     * It decides whether a person is on this project's chart at all — from
     * their allocation, or from their name being on its work — and then they
     * bring their WHOLE working week with them.
     *
     * It used to multiply their capacity by that allocation percentage, and
     * that was wrong in a way that showed: somebody put down as 10% on a
     * project had half a day a week of capacity, so the first real piece of
     * work named on them read as several hundred per cent over. A person on
     * two projects does not own two fifths of a pair of hands on Tuesday;
     * they own one pair of hands, and the allocation is a statement of intent
     * about how they mean to divide it.
     *
     * So the allocation percentage is on-paper intent and drives no capacity
     * arithmetic anywhere. What the work actually consumes is measured from
     * the work — see `realAllocation()`.
     */
    const onIt = !forProjects || memberOf(p, forProjects, s);
    if (!onIt) continue;
    heads.set(p.division, heads.get(p.division) + 1);
    const cap = capacityPct(p) / 100;
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
    heads, skipped,
    /* Whether this supply is the whole roster of a division or a narrowed
       set - the people on a project, or the people on one breakdown. The
       strip says so, because "2p" means a different thing in each case and
       the reader cannot tell them apart from the number alone. */
    perProject: !!(forProjects || includePeople),
    total: periods.map((_, i) => sum(divs, d => byDiv.get(d.id)[i])),
  };
}

/**
 * One line naming the people a supply left out, or '' when it left nobody out.
 *
 * Kept here rather than in a view because all three charts want the same
 * sentence, and because the thing being explained — who is and is not in the
 * denominator — belongs with the function that decided it.
 */
export function skippedNote(sup) {
  const list = sup?.skipped || [];
  if (!list.length) return '';
  const none = list.filter(x => x.why === 'none').length;
  const unknown = list.length - none;
  const bits = [];
  if (none) bits.push(`${none} with no division`);
  if (unknown) bits.push(`${unknown} in a division that no longer exists`);
  return `${list.length} active ${list.length === 1 ? 'person is' : 'people are'} not counted in any `
       + `division's capacity — ${bits.join(', ')}.`;
}

/**
 * REAL allocation: what the work actually named on somebody comes to.
 *
 * `person.alloc` is on-paper intent — you typed 40% and meant it, and it is
 * still worth having, because a plan is partly a statement of what you meant
 * to do. This is the other half: over a window, add up the person-days of
 * every piece of work with this person's name on it, per project, and divide
 * by the working days they actually have in that window.
 *
 * WHY BOTH. They answer different questions and disagreeing is the useful
 * part. On paper 40% on Let's Story, in practice 85% of their month going
 * into it, is precisely the conversation this is for — and neither number on
 * its own can start it.
 *
 * Counts the same two kinds of assignment the capacity lanes do: a name on a
 * work-breakdown line, and a task with an assignee, an estimate and a due
 * date. Work with nobody's name on it is not in here at all, which is the
 * honest answer — unassigned work is not yet anybody's time.
 *
 * @returns {Map<string, {days:number, available:number, pct:number,
 *                        byProject:Array<{project, days, pct}>}>} keyed by person id
 */
export function realAllocation({ from, to, state = S.get() } = {}) {
  const cal = workCalendar(from, to);
  const periods = periodGrid(from, to, 'month', cal);
  const pIdx = periodIndexOf(periods, cal);
  const sup = supply(periods, cal);
  const bars = buildBars({ showTasks: true, state });

  const out = new Map();
  const bucket = id => {
    if (!out.has(id)) out.set(id, { days: 0, byProject: new Map() });
    return out.get(id);
  };

  for (const b of bars) {
    if (!b.demand || !b.hours || !(b.people || []).length) continue;
    const share = b.hours / b.people.length;
    for (const id of b.people) {
      /* Spread across the window the same way the capacity strip does, so a
         bar that only half overlaps the window contributes half. */
      const lane = periods.map(() => 0);
      spreadBar(b, periods, cal, pIdx, lane, share);
      const days = sum(lane);
      if (days <= 0.0001) continue;
      const rec = bucket(id);
      rec.days += days;
      const k = b.projectId || '';
      rec.byProject.set(k, (rec.byProject.get(k) || 0) + days);
    }
  }

  /*
   * Hours already LOGGED against their tasks, beside the hours scheduled.
   *
   * `task.spent` is a single running total typed on the task — the app has no
   * dated time log — so this cannot be cut to the window and is deliberately
   * not mixed into the percentage, which is about a month. It is reported as
   * what it is: the total recorded so far against work assigned to them, and
   * the tooltip says so rather than implying a precision that is not there.
   *
   * Done tasks count. Time spent is spent, and leaving them out would make
   * the number fall as work finished, which is the opposite of a total.
   */
  for (const t of state.tasks || []) {
    const h = Number(t.spent) || 0;
    if (!h || !t.assignee) continue;
    const rec = bucket(t.assignee);
    rec.spent = (rec.spent || 0) + h;
    if (!rec.spentByProject) rec.spentByProject = new Map();
    const k = t.project || '';
    rec.spentByProject.set(k, (rec.spentByProject.get(k) || 0) + h);
  }

  const avail = new Map((sup.rows || []).map(r => [r.person.id, r.total]));
  const res = new Map();
  for (const [id, rec] of out) {
    const a = avail.get(id) || 0;
    res.set(id, {
      days: rec.days,
      available: a,
      spentHours: rec.spent || 0,
      spentByProject: [...(rec.spentByProject || new Map()).entries()]
        .map(([pid, hours]) => ({ project: S.byId(state.projects, pid) || null, hours }))
        .sort((x, y) => y.hours - x.hours),
      /* No percentage at all when there are no working days to divide by —
         somebody entirely on leave for the window is not "infinitely
         allocated", there is simply nothing to take a share of. */
      pct: a > 0 ? (rec.days / a) * 100 : null,
      byProject: [...rec.byProject.entries()]
        .map(([pid, days]) => ({
          project: S.byId(state.projects, pid) || null,
          days, pct: a > 0 ? (days / a) * 100 : null,
        }))
        .sort((x, y) => y.days - x.days),
    });
  }
  return res;
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

  /*
   * Offsets from `lineSchedule()` are fractional working days from the start
   * of the estimate; these turn them into dates.
   *
   * `i0`/`i1` are the first and last whole working day a span touches, and
   * the bar's `workDays` is taken from THOSE rather than from `ceil(len)`.
   * They differ whenever a span straddles a day boundary — half a day that
   * starts at lunchtime touches two — and `spreadBar()` in the load model
   * divides a bar's hours by `workDays` and then adds that to every day the
   * bar covers. A `workDays` smaller than the days covered would post the
   * work more than once against the same week.
   */
  const i0 = off => Math.floor(off);
  const i1 = off => Math.floor(Math.max(0, off - 1e-9));
  const dayAt = i => addWorkDays(start, i + 1);   // addWorkDays(s, 1) is s itself

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

    /*
     * A CREW SWEEP IGNORES THE SCHEDULE, and has to.
     *
     * `crewOverride` is the "what if three people did it" comparison, which
     * asks a question about an anonymous headcount — there is no answer to
     * "what if three people did it" that also honours which two people you
     * named. So an override falls back to the flat hours ÷ crew length and
     * never splits into lines.
     */
    const swept = crewOverride && crewOverride[d.division.id] != null;
    const mine = swept ? [] : calc.lines.filter(l => l.division === d.division.id && l.slot);
    /* One row per line once somebody is named in this division, one row for
       the division while nobody is. Splitting an unassigned lane would add a
       row per line to every chart in the app and say nothing new — every
       line would sit on the same anonymous crew. */
    const split = !swept && d.people.length > 0 && mine.length > 0;

    let laneFrom, laneTo, laneDays;
    if (swept) {
      laneDays = Math.max(1, Math.ceil(d.hours / hpd / effective));
      laneFrom = est.parallel === false ? cursor : start;
      laneTo = addWorkDays(laneFrom, laneDays);
      if (est.parallel === false) cursor = addWorkDays(laneTo, 2);
    } else {
      const blk = calc.sched.byDivision.get(d.division.id) || { from: 0, to: d.elapsedDays };
      const a = i0(blk.from), b = Math.max(i0(blk.from), i1(blk.to));
      laneFrom = dayAt(a);
      laneTo = dayAt(b);
      laneDays = b - a + 1;
    }
    if (laneTo > latest) latest = laneTo;

    kids.push({
      id: `${pid}:${d.division.id}`, kind: 'division', parentId: pid,
      label: d.division.label, projectId: est.projectId, divisionId: d.division.id,
      start: laneFrom, end: laneTo, workDays: laneDays,
      hours: d.hours, crew, unstaffed,
      cost: d.cost,
      /* The demand moves down to the lines when they are drawn, or the same
         hours would be counted twice against the same week. */
      demand: !split,
      people: split ? [] : d.people,
      color: d.division.color || 'var(--muted)',
      ref: est.id, sub: `${d.lines} line${d.lines === 1 ? '' : 's'}`,
    });

    if (!split) continue;

    for (const l of mine) {
      const s = l.slot;
      const a = i0(s.from), b = Math.max(i0(s.from), i1(s.to));
      kids.push({
        id: `${pid}:${d.division.id}:${l.id}`, kind: 'wbline',
        parentId: `${pid}:${d.division.id}`,
        label: l.name + (l.qty > 1 ? ` ×${l.qty}` : ''),
        projectId: est.projectId, divisionId: d.division.id,
        start: dayAt(a), end: dayAt(b), workDays: b - a + 1,
        hours: l.hours, crew: s.crew, unstaffed: s.unstaffed,
        pinned: s.pinned,
        cost: l.cost, demand: true,
        /* The whole point: this line's hours land on THESE people's weeks. */
        people: s.people,
        peopleNames: s.people.map(id => S.byId(state.people, id)?.name || '?'),
        color: d.division.color || 'var(--muted)',
        ref: est.id, refLine: l.id,
      });
    }
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
    /* An assigned task books that person's time exactly as a named breakdown
       line does. It is the same statement — this work is theirs — and leaving
       it out would mean a person's capacity lane showed their estimates and
       not their board. */
    people: t.assignee ? [t.assignee] : [],
    peopleNames: t.assignee ? [S.personName(t.assignee)] : [],
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
function spreadBar(bar, periods, cal, pIdx, out, hours = bar.hours, crew = 1) {
  const hpd = HPD();
  /*
   * A DAY OF SOMEBODY'S WORK IS A WHOLE DAY OF THEIRS.
   *
   * This used to divide the effort by the number of days the bar covers, and
   * that quietly understated every piece of work whose length did not land on
   * a whole day. 57 hours is 7.125 days, which draws as an 8-day bar, and
   * 7.125 ÷ 8 posted 0.89 of a day against each of them — so one artist
   * working solidly through a week came out at 89% of it and the strip said
   * 11% still free. There was no free 11%: there was a bar rounded up to the
   * next whole day and its effort smeared back across the rounding.
   *
   * So the rate is now the crew — a whole person-day per person per day —
   * until the effort runs out, and the last day takes whatever remains. The
   * total is identical; where it lands is not, and the last day is the only
   * one that is ever part-full.
   *
   * Indexed off the bar's own start rather than off the window, so a bar that
   * begins before the view still puts the right days in the visible part
   * instead of restarting its ramp at the left edge.
   */
  const per = Math.max(1, crew);
  const effortDays = hours / hpd;
  let c = bar.start, guard = 0;
  while (c <= bar.end && guard++ < 2000) {
    if (cal.index.has(c) && cal.isWorking(c)) {
      const k = workDaysBetween(bar.start, c) - 1;          // 0-based, inclusive count
      const take = Math.min(per, effortDays - k * per);
      if (take > 0) out[pIdx.get(c)] += take;
    }
    c = addDays(c, 1);
  }
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
  /* Named work, posted a second time against the individuals rather than
     against the discipline. The same hours, split evenly between the people
     on the bar — the division total is unchanged, this is the same total seen at
     a finer grain. */
  const personNeed = new Map();            // personId -> days[]
  const personBars = new Map();            // personId -> Bar[]

  for (const b of bars) {
    if (!b.demand || !b.hours || !b.divisionId) continue;
    const lane = (b.scenario ? scnBy : demandBy).get(b.divisionId);
    if (!lane) continue;
    const before = lane.slice();
    /* The bar's own crew is its daily rate: two people on it spend two
       person-days a day. Falls back to one, which is what an unstaffed or
       unnamed bar has always been worth. */
    const crew = Math.max(1, (b.people || []).length || b.crew || 1);
    spreadBar(b, periods, cal, pIdx, lane, b.hours, crew);
    for (let i = 0; i < periods.length; i++) {
      if (lane[i] - before[i] > 0.001) {
        const k = `${b.divisionId}|${i}`;
        if (!contributors.has(k)) contributors.set(k, []);
        contributors.get(k).push({ bar: b, days: lane[i] - before[i] });
      }
    }

    const who = b.people || [];
    if (!who.length) continue;
    for (const id of who) {
      if (!personNeed.has(id)) { personNeed.set(id, periods.map(() => 0)); personBars.set(id, []); }
      /* One person's share, at one person-day a day — which is the whole
         point of a personal lane. Their share of the effort over the same
         span comes to exactly the bar's own length, so somebody working
         solidly through a week reads as a full week. */
      spreadBar(b, periods, cal, pIdx, personNeed.get(id), b.hours / who.length, 1);
      personBars.get(id).push(b);
    }
  }

  /*
   * One row per person who has named work in this window.
   *
   * Only those people: a lane per member of the roster would bury the four
   * that matter under thirty that say 100% all the way across, and the reason
   * to look at an individual at all is that somebody put their name on
   * something. Their supply is their own days out of `supply()` — already
   * after leave, part-time capacity and, on a project chart, their allocation
   * to that project — so the person lane and the division lane above it are
   * the same arithmetic at two grains.
   */
  const personSupply = new Map((sup.rows || []).map(r => [r.person.id, r]));
  const roster = S.get().people || [];
  const personRows = [...personNeed.entries()].map(([id, need]) => {
    const src = personSupply.get(id);
    const avail = src?.days || periods.map(() => 0);
    /* Their own division when the supply has never heard of them, or the row
       would belong to no division and be filtered out of the strip entirely.
       That is precisely the person who needs showing: named on the work, and
       not in the capacity this chart is counting. */
    const onRoster = roster.find(p => p.id === id);
    return {
      person: src?.person || onRoster || { id, name: id },
      division: src?.division || onRoster?.division || '',
      cells: periods.map((p, i) => {
        const a = avail[i], n = need[i];
        return {
          period: p, available: a, needed: n, gap: n - a,
          loadPct: a > 0 ? (n / a) * 100 : (n > 0 ? Infinity : 0),
          freePct: a > 0 ? ((a - n) / a) * 100 : null,
          over: n - a > 0.05,
          contributors: (personBars.get(id) || []).map(bar => ({ bar, days: 0 })),
        };
      }),
      /* Not on the roster any more, or not allocated to this project — the
         work is named on somebody this chart has no capacity for, which is
         worth saying rather than drawing as a full bar. */
      noSupply: !src,
      totalNeeded: sum(need),
      shortfallDays: sum(periods.map((_, i) => Math.max(0, need[i] - avail[i]))),
    };
  }).sort((a, b) => b.totalNeeded - a.totalNeeded);

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
        /*
         * The same cell read the other way up: how much of the capacity is
         * STILL FREE. `100 - loadPct`, and negative when the work is more
         * than the people.
         *
         * Both are kept because they are for different readers. Every
         * threshold in this file and every colour on the strip is expressed
         * against load — over 100 is an overload, and inverting the model
         * would mean rewriting all of that and getting one of the
         * comparisons backwards. What a producer wants to READ off a chart
         * is the other one: not "this week is at 80%" but "this week has 20%
         * left", because the question being asked of the chart is what more
         * it can take. So the model stays in load and the strip prints free.
         *
         * `null` where there is no capacity at all: 0% free and "there is
         * nobody here" are not the same answer, and printing 0 for both
         * hides the one that needs acting on.
         */
        freePct: a > 0 ? ((a - n) / a) * 100 : null,
        over: n - a > 0.05,
        contributors: contributors.get(`${d.id}|${i}`) || [],
      };
    });
    return {
      division: d, cells,
      heads: sup.heads.get(d.id) || 0,
      perProject: !!sup.perProject,
      /* The named individuals inside this discipline, so the strip can open
         one row into the people it is made of. */
      people: personRows.filter(r => r.division === d.id),
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
    /* Every named person with work in this window, division or not — the
       views that want a flat list (an orphan whose division has gone) read
       this rather than digging through the rows. */
    personRows,
    shortfallDays: sum(rows, r => r.shortfallDays),
    /* The periods where at least one division cannot cover its work. This is
       the answer to "what am I missing for that particular period", and it is
       a list of concrete weeks with a number of days against each. */
    pinchPoints: periods.map((p, i) => ({
      period: p,
      divisions: rows.filter(r => r.cells[i].over)
        .map(r => ({ division: r.division, gap: r.cells[i].gap,
                     loadPct: r.cells[i].loadPct, freePct: r.cells[i].freePct })),
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
                                     useAllocation = true, scopeSupply = false,
                                     state = S.get() } = {}) {
  const cal = workCalendar(from, to);
  const periods = periodGrid(from, to, grain, cal);
  /* `scopeSupply` weighs the work against the capacity ALLOCATED to the
     projects on screen rather than against the whole division — the right
     denominator when the chart is one project's, and the wrong one when it is
     the portfolio's. Off by default so the Plan keeps answering "can the team
     take this". See `supply()` for why it must not be combined with
     `useAllocation`. */
  const sup = supply(periods, cal, {
    extraHeads: scenario?.extraHeads || [],
    forProjects: scopeSupply && projects?.size ? projects : null,
  });
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
