/**
 * GFX work breakdown — the catalogue and the maths.
 *
 * The model an Art Producer actually uses to answer "how long, how much, and
 * can we?": a catalogue of work items with a base eyeball ETA, and estimates
 * that multiply those by complexity and quantity, cost them against the rate
 * card, and check the answer against the team you actually have.
 *
 * WHAT THIS FIXES ABOUT THE SPREADSHEET IT REPLACES
 *
 * The reference workbook divided every line's hours by ONE headcount cell —
 * the 2D artist count — whatever division the line belonged to. A 3D line with
 * two 3D artists and one 2D artist was divided by one. So the numbers were
 * wrong wherever crew sizes differed, which is most of the time.
 *
 * It also had one number where there are two, and conflating them is the
 * classic estimating mistake:
 *
 *   EFFORT (person-hours) is what the work costs. Crew size never changes it.
 *   DURATION (elapsed days) is when it lands. Crew size divides it.
 *
 * So `estimate()` returns both. Effort drives cost; duration divides each
 * division's own effort by that division's own crew, and the disciplines run
 * in PARALLEL by default — 2D and 3D working the same fortnight is a fortnight,
 * not a month — with `sequential` for a genuine hand-off chain.
 *
 * Nothing here touches the DOM or the store's mutators; it reads state and
 * returns numbers, so the views can render it and it can be checked directly.
 */

import * as S from './store.js';
import { SENIORITY, rateFor, holidaySet, workingDaysInMonth, capacity, thisMonth } from './calc.js';
import { divisionLabel } from './jira.js';

/* ---------- vocabularies ------------------------------------------------- */

/*
 * The disciplines a work item can belong to — the roster's own divisions.
 *
 * This was a fixed list of six, which meant a division added in the app or in
 * Excel had no lane here: no crew box, no row in the per-division table, no
 * feasibility check, no line in the roll-up. It is now derived from
 * `state.divisions`, so the tool follows the department.
 *
 * Every division on the roster is a division of people, so every one carries a
 * crew and divides duration — including GFX Prod, whose feedback and QA rounds
 * are done by real people whose number changes how long it takes. `crew` stays
 * on the shape because six call sites read it, and `wbCrew: false` on a
 * division record is the escape hatch if a bookkeeping-only division is ever
 * wanted.
 */
export function wbDivisions(state = S.get()) {
  return (state.divisions || [])
    .filter(d => d && d.id)
    .map(d => ({ id: d.id, label: d.name || d.id, color: d.color || '', crew: d.wbCrew !== false }));
}

/**
 * One division by id, or an honest placeholder.
 *
 * This used to return `WB_DIVISIONS[0]` — 2D Art — for anything it did not
 * recognise. That was harmless while the list was fixed and the pickers could
 * not offer anything else. Now that a division can be removed, that fallback
 * would silently re-group and re-cost its catalogue items and draft lines as
 * 2D Art: a confident, wrong number, which is the worst kind. A placeholder
 * that says what happened is worth more than a plausible one, and `missing`
 * lets the views flag it.
 */
export function wbDivision(id, state = S.get()) {
  const hit = wbDivisions(state).find(d => d.id === id);
  if (hit) return hit;
  return {
    id: String(id || ''),
    label: id ? `${id} — removed` : 'No division',
    color: '', crew: true, missing: true,
  };
}

/**
 * The divisions an estimate actually spans: the roster's, in roster order,
 * plus any its own lines name that the roster no longer has.
 *
 * Without the second half an orphaned line's hours counted towards the total
 * and appeared in no row — in the total, nowhere in the table, and left out of
 * the duration. Now it gets a row that says `X — removed`.
 */
function divisionsFor(est, state = S.get()) {
  const all = wbDivisions(state);
  const known = new Set(all.map(d => d.id));
  const orphans = [...new Set((est?.lines || []).map(l => l.division).filter(id => id && !known.has(id)))];
  return [...all, ...orphans.map(id => wbDivision(id, state))];
}

/**
 * How much of an item is really new work.
 *
 * The reference had this as a lookup whose table had been deleted, leaving
 * `#REF!` in the totals — which is exactly the kind of silent breakage a
 * spreadsheet hides. Here the factors are data, editable in the Rates tab.
 */
export const WB_APPROACHES = [
  { id: 'new',       label: 'New',            factor: 1,    hint: 'Built from nothing.' },
  { id: 'variation', label: 'Variation',      factor: 0.6,  hint: 'A new take on something that exists.' },
  { id: 'reskin',    label: 'Reskin',         factor: 0.35, hint: 'Same asset, new dressing.' },
  { id: 'reuse',     label: 'Reuse + fix',    factor: 0.2,  hint: 'Existing asset, touched up.' },
  { id: 'polish',    label: 'Polish pass',    factor: 0.3,  hint: 'Raising quality on finished work.' },
  { id: 'port',      label: 'Port / rebuild', factor: 0.5,  hint: 'Same design, new pipeline.' },
];
export const wbApproach = id => WB_APPROACHES.find(a => a.id === id) || WB_APPROACHES[0];

/**
 * Complexity, as named rungs rather than a free number.
 *
 * A free "complexity factor" column is where estimates go to die: everyone
 * types 1 and the number stops meaning anything. Named rungs force a
 * judgement, and the multiplier is visible next to it.
 */
export const WB_COMPLEXITY = [
  { id: 'trivial', label: 'Trivial',  factor: 0.5 },
  { id: 'simple',  label: 'Simple',   factor: 0.75 },
  { id: 'normal',  label: 'Normal',   factor: 1 },
  { id: 'complex', label: 'Complex',  factor: 1.5 },
  { id: 'hero',    label: 'Hero',     factor: 2.5 },
];
export const wbComplexity = id => WB_COMPLEXITY.find(c => c.id === id) || WB_COMPLEXITY[2];

/* ---------- settings ----------------------------------------------------- */

const WB_DEFAULTS = {
  hoursPerDay: 8,
  daysPerWeek: 5,
  workDaysPerMonth: 21,   // what a monthly salary buys, after weekends
  contingencyPct: 15,     // the honest admission that estimates are estimates
  reviewPct: 10,          // feedback and revision rounds, on top of the work
  parallel: true,
};

export function wbSettings() {
  const s = S.get();
  const own = s?.settings?.wb;
  const out = { ...WB_DEFAULTS, ...(own && typeof own === 'object' ? own : {}) };
  // The app already has an hours-per-day; do not keep a second answer.
  out.hoursPerDay = s?.settings?.hoursPerDay || out.hoursPerDay;
  return out;
}

export function setWbSetting(patch) {
  S.mutate(s => {
    s.settings ||= {};
    s.settings.wb = { ...(s.settings.wb || {}), ...patch };
  }, { silent: true, noUndo: true, label: 'work breakdown settings' });
}

/* ---------- rates -------------------------------------------------------- */

/**
 * Hourly cost of a rung, derived rather than typed.
 *
 * The rate card holds a monthly cost, which is the number finance agrees;
 * an hourly rate typed beside it would be a second version of the same fact.
 * So it is monthly ÷ (working days a month × hours a day).
 */
export function hourlyRate(seniority, cfg = wbSettings()) {
  const monthly = rateFor(seniority);
  const hours = Math.max(1, cfg.workDaysPerMonth * cfg.hoursPerDay);
  return monthly / hours;
}

/** Every rung with its monthly and hourly cost, for the Rates tab. */
export function rateLadder(cfg = wbSettings()) {
  return SENIORITY.map(sen => ({
    seniority: sen,
    monthly: rateFor(sen),
    hourly: hourlyRate(sen, cfg),
    daily: hourlyRate(sen, cfg) * cfg.hoursPerDay,
  }));
}

/**
 * The rung to cost a division's work at when the estimate does not say.
 *
 * Taken from who is actually in that division — the median rung of the people
 * on the roster — because a blended rate invented in a settings screen drifts
 * from the team the moment somebody joins or is promoted.
 */
export function defaultSeniority(divisionId) {
  const people = (S.get().people || []).filter(p =>
    p.active !== false && p.division === divisionId && p.seniority);
  if (!people.length) return 'Senior';
  const rungs = people
    .map(p => SENIORITY.findIndex(x => x.toLowerCase() === String(p.seniority).toLowerCase()))
    .filter(i => i >= 0).sort((a, b) => a - b);
  if (!rungs.length) return 'Senior';
  return SENIORITY[rungs[Math.floor(rungs.length / 2)]];
}

/* ---------- the catalogue ------------------------------------------------ */

export const wbItems = (state = S.get()) => state.wbItems || [];
export const wbItem = (id, state = S.get()) => wbItems(state).find(i => i.id === id) || null;

/** Catalogue grouped by division, in roster order, for the pickers. */
export function itemsByDivision(state = S.get()) {
  /* Items whose division has been removed are grouped too rather than hidden:
     a catalogue entry that has quietly stopped being offered is worse than one
     that shows up asking to be re-homed. */
  const known = new Set(wbDivisions(state).map(d => d.id));
  const orphans = [...new Set(wbItems(state).map(i => i.division).filter(id => id && !known.has(id)))];
  return [...wbDivisions(state), ...orphans.map(id => wbDivision(id, state))].map(d => ({
    division: d,
    items: wbItems(state).filter(i => i.division === d.id && i.active !== false),
  })).filter(g => g.items.length);
}

/* ---------- estimating --------------------------------------------------- */

export const wbEstimates = (state = S.get()) => state.wbEstimates || [];
export const wbEstimate = (id, state = S.get()) => wbEstimates(state).find(e => e.id === id) || null;

/** A fresh estimate, with sane defaults rather than blanks. */
export function newEstimate(patch = {}) {
  const cfg = wbSettings();
  return {
    id: S.uid('wbe'),
    name: '',
    projectId: '',
    approach: 'new',
    status: 'draft',                 // draft | quoted | approved | done
    crew: Object.fromEntries(wbDivisions().filter(d => d.crew).map(d => [d.id, 1])),
    seniority: {},                   // division -> rung; blank = defaultSeniority()
    contingencyPct: cfg.contingencyPct,
    reviewPct: cfg.reviewPct,
    parallel: cfg.parallel,
    startDate: '',
    lines: [],
    notes: '',
    created: Date.now(),
    updated: Date.now(),
    ...patch,
  };
}

/**
 * The crew size for one division on an estimate.
 *
 * Zero is a real answer — "nobody is on this" — so it cannot be clamped away.
 * But a key that is simply absent is not zero: an estimate saved before UI/UX
 * was in the list has no `UIUX` key, and reading that as an unstaffed division
 * would turn its duration into infinity. Absent means one; zero means zero.
 */
export function crewOf(est, divisionId) {
  const raw = est?.crew?.[divisionId];
  if (raw === undefined || raw === null || raw === '') return 1;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/**
 * A line, resolved against the catalogue at the moment it is added.
 *
 * Approach and seniority are stored ON the line rather than inherited from the
 * estimate. A deliverable is rarely all-new or all-reuse — the concept is new
 * and the props are reskins — and a single approach for the whole thing made
 * that unsayable. Seniority is written out for the same reason: a blank that
 * silently meant "the division's rung" showed up in the picker as
 * `Senior (division)`, which reads as a rung called Senior (division).
 */
export function newLine(itemId, patch = {}) {
  const it = wbItem(itemId);
  /* Blank rather than '2D' when the catalogue item has gone: the same silent
     fallback as the old wbDivision(), and the same reason not to have it. */
  const division = it?.division || '';
  return {
    id: S.uid('wbl'),
    itemId,
    division,
    name: it?.name || '',
    baseHours: Number(it?.hours) || 0,
    complexity: 'normal',
    approach: 'new',
    qty: 1,
    seniority: defaultSeniority(division),
    note: '',
    ...patch,
  };
}

/**
 * Work out an estimate. Pure.
 *
 * Returns the two numbers that matter and never mixes them:
 *
 *   effortHours   person-hours. What it costs. Crew size is irrelevant.
 *   elapsedDays   working days from start to finish, after crew and after the
 *                 parallel/sequential choice.
 *
 * Order of the multipliers, which is worth stating because it is easy to argue
 * about: base × complexity × quantity gives the raw work; the approach factor
 * scales the whole deliverable (a reskin is cheaper across the board); review
 * and contingency are then added to that, not to each other's result, so the
 * two percentages stay independent and legible.
 */
export function estimate(est, state = S.get()) {
  const cfg = wbSettings();
  const hpd = Math.max(1, cfg.hoursPerDay);

  const lines = (est.lines || []).map(l => {
    const cx = wbComplexity(l.complexity).factor;
    /* Per line, falling back to the estimate's old single value so estimates
       saved before the approach moved onto the line still read correctly. */
    const appr = wbApproach(l.approach || est.approach || 'new');
    const qty = Number(l.qty) || 0;
    const raw = (Number(l.baseHours) || 0) * cx * qty;
    const hours = raw * appr.factor;
    const sen = l.seniority || est.seniority?.[l.division] || defaultSeniority(l.division);
    const rate = hourlyRate(sen, cfg);
    return { ...l, approach: appr.id, approachInfo: appr, cxFactor: cx, rawHours: raw,
             hours, seniorityUsed: sen, rate, cost: hours * rate };
  });

  /* Per division, because that is the unit of both crew and rate. */
  const byDivision = divisionsFor(est, state).map(d => {
    const mine = lines.filter(l => l.division === d.id);
    const hours = mine.reduce((n, l) => n + l.hours, 0);
    const cost = mine.reduce((n, l) => n + l.cost, 0);
    const crew = d.crew ? crewOf(est, d.id) : 1;
    return {
      division: d, lines: mine.length, hours, cost, crew,
      days: hours / hpd,                    // effort in days, crew-independent
      /* Work with nobody on it never finishes, and saying so is more use than
         quietly pretending one person is doing it. Cost is unaffected: the
         effort is still the effort, which is why it is a separate number. */
      elapsedDays: crew > 0 ? hours / hpd / crew : (hours > 0 ? Infinity : 0),
      unstaffed: d.crew && crew === 0 && hours > 0,
      seniority: est.seniority?.[d.id] || defaultSeniority(d.id),
    };
  }).filter(d => d.lines);

  const effortHours = lines.reduce((n, l) => n + l.hours, 0);
  const baseCost = lines.reduce((n, l) => n + l.cost, 0);

  const reviewPct = Math.max(0, Number(est.reviewPct) || 0);
  const contPct = Math.max(0, Number(est.contingencyPct) || 0);
  const upliftPct = reviewPct + contPct;
  const totalHours = effortHours * (1 + upliftPct / 100);
  const totalCost = baseCost * (1 + upliftPct / 100);

  /* Parallel: the longest discipline sets the date. Sequential: they add up. */
  const elapsedBase = est.parallel === false
    ? byDivision.reduce((n, d) => n + d.elapsedDays, 0)
    : byDivision.reduce((n, d) => Math.max(n, d.elapsedDays), 0);
  const elapsedDays = elapsedBase * (1 + upliftPct / 100);

  const unstaffed = byDivision.filter(d => d.unstaffed).map(d => d.division);

  /* Which approaches are in play, most-used first — the estimate no longer has
     one, so this is what a summary column can show. */
  const approaches = [...new Set(lines.map(l => l.approach))]
    .map(id => ({ ...wbApproach(id), lines: lines.filter(l => l.approach === id).length }))
    .sort((a, b) => b.lines - a.lines);

  return {
    lines, byDivision, unstaffed, approaches,
    effortHours, baseCost,
    reviewPct, contPct, upliftPct,
    totalHours, totalCost,
    effortDays: totalHours / hpd,
    elapsedDays,
    elapsedWeeks: elapsedDays / Math.max(1, cfg.daysPerWeek),
    elapsedMonths: elapsedDays / Math.max(1, cfg.workDaysPerMonth),
    /* No finish date when the duration is not a number — walking the calendar
       towards infinity would return a date, and a made-up date is worse than
       none. */
    finish: est.startDate && Number.isFinite(elapsedDays)
      ? addWorkingDays(est.startDate, Math.ceil(elapsedDays)) : '',
    crewTotal: byDivision.reduce((n, d) => n + (d.division.crew ? d.crew : 0), 0),
    hpd,
  };
}

/**
 * A working-day walk, skipping weekends and the holiday calendar.
 *
 * Calendar arithmetic would put a four-week estimate a week early, which is
 * the sort of error that gets promised to a publisher.
 */
export function addWorkingDays(fromIso, days) {
  const hol = holidaySet();
  const wd = S.get().prefs?.workingDays || [1, 2, 3, 4, 5];
  const d = new Date(fromIso + 'T00:00:00');
  let left = Math.max(0, days);
  const iso = x => x.toISOString().slice(0, 10);
  let guard = 0;
  while (left > 0 && guard++ < 4000) {
    d.setDate(d.getDate() + 1);
    if (wd.includes(d.getDay()) && !hol.has(iso(d))) left--;
  }
  return iso(d);
}

/* ---------- can we actually do it? -------------------------------------- */

/**
 * The estimate against the team you have, this month.
 *
 * The question an estimate on its own cannot answer. Available days come from
 * the same `capacity()` the rest of the app uses — after allocation, after
 * leave — so this agrees with the Team and Finance views instead of being a
 * second opinion.
 */
export function feasibility(est, ym = thisMonth(), state = S.get()) {
  const r = estimate(est, state);
  const hpd = r.hpd;
  return r.byDivision.filter(d => d.division.crew).map(d => {
    const cap = capacity(ym, { division: d.division.id });
    const availableDays = cap.net;
    const needDays = d.hours * (1 + r.upliftPct / 100) / hpd;
    return {
      division: d.division,
      needDays, availableDays,
      people: cap.rows.length,
      loadPct: availableDays > 0 ? (needDays / availableDays) * 100 : (needDays > 0 ? Infinity : 0),
      shortfallDays: Math.max(0, needDays - availableDays),
    };
  });
}

/** Totals across several estimates — the forecast roll-up. */
export function rollUp(list, state = S.get()) {
  const rows = list.map(e => ({ est: e, calc: estimate(e, state) }));
  return {
    rows,
    hours: rows.reduce((n, r) => n + r.calc.totalHours, 0),
    cost: rows.reduce((n, r) => n + r.calc.totalCost, 0),
    /* Every division the estimates between them touch — the roster's, plus any
       a line still names that the roster has dropped, so a removed division's
       hours are visible in the roll-up rather than missing from it. */
    byDivision: (() => {
      const all = wbDivisions(state);
      const known = new Set(all.map(d => d.id));
      const orphans = [...new Set(rows.flatMap(r => r.calc.byDivision.map(x => x.division.id))
        .filter(id => id && !known.has(id)))];
      return [...all, ...orphans.map(id => wbDivision(id, state))].map(d => ({
        division: d,
        hours: rows.reduce((n, r) =>
          n + (r.calc.byDivision.find(x => x.division.id === d.id)?.hours || 0), 0),
        cost: rows.reduce((n, r) =>
          n + (r.calc.byDivision.find(x => x.division.id === d.id)?.cost || 0), 0),
      })).filter(d => d.hours > 0);
    })(),
  };
}

/* ---------- persistence -------------------------------------------------- */

export function saveEstimate(est) {
  S.mutate(s => {
    s.wbEstimates ||= [];
    const i = s.wbEstimates.findIndex(e => e.id === est.id);
    const next = { ...est, updated: Date.now() };
    if (i >= 0) s.wbEstimates[i] = next; else s.wbEstimates.push(next);
  }, { label: 'save estimate' });
}

export function removeEstimate(id) {
  S.mutate(s => { s.wbEstimates = (s.wbEstimates || []).filter(e => e.id !== id); },
           { label: 'delete estimate' });
}

export function saveItem(item) {
  S.mutate(s => {
    s.wbItems ||= [];
    const i = s.wbItems.findIndex(x => x.id === item.id);
    if (i >= 0) s.wbItems[i] = { ...s.wbItems[i], ...item };
    else s.wbItems.push({ id: S.uid('wbi'), active: true, ...item });
  }, { label: 'save work item' });
}

export function removeItem(id) {
  S.mutate(s => { s.wbItems = (s.wbItems || []).filter(x => x.id !== id); },
           { label: 'delete work item' });
}

/* ---------- logging an estimate ----------------------------------------- */

export const isLogged = e => !!(e && e.logged && e.logged.at);
export const loggedEstimates = (state = S.get()) =>
  wbEstimates(state).filter(isLogged).sort((a, b) => b.logged.at - a.logged.at);

/** Logged scope for one project, newest first. */
export const scopesFor = (projectId, state = S.get()) =>
  loggedEstimates(state).filter(e => (e.logged.projectId || e.projectId) === projectId);

/**
 * Sign an estimate off: freeze what it said, and put it on the board.
 *
 * Two things happen, and both matter.
 *
 * The numbers are SNAPSHOT. A logged estimate is a commitment made on a date,
 * and it has to keep saying what it said — if the rate card changes in
 * November, what was signed in September must not quietly change with it. So
 * cost, hours and every line are copied into `logged`, and the Log and Scopes
 * views read the snapshot, never a recomputation.
 *
 * And ONE task is created, not one per line, with the lines as its checklist.
 * That is deliberate: the scope is one thing you agreed to deliver, and the
 * checklist is how it breaks down — which is also exactly what becomes Jira
 * sub-tasks of one issue when the task is queued.
 *
 * @returns {{ok:boolean, taskId?:string, error?:string}}
 */
export function logEstimate(estId, { status = 'backlog' } = {}) {
  const est = wbEstimate(estId);
  if (!est) return { ok: false, error: 'That estimate no longer exists.' };
  if (isLogged(est)) return { ok: false, error: 'That estimate is already logged.' };
  if (!String(est.name || '').trim()) return { ok: false, error: 'Name the estimate before logging it.' };

  const r = estimate(est);
  if (!r.lines.length) return { ok: false, error: 'There is nothing in the breakdown to log.' };

  const taskId = S.uid('tsk');
  const at = Date.now();
  const hpd = r.hpd;

  S.mutate(s => {
    const order = (s.tasks || []).filter(t => t.status === status)
      .reduce((m, t) => Math.min(m, t.order ?? 0), 1000) - 1000;

    /*
     * A scope spans disciplines, so `division` is set to whichever carries the
     * most hours — that is what colours the card and what the board filters on
     * — while `jiraLabels` records every discipline in the breakdown. Without
     * the second one a scope reached Jira with no label at all and a project
     * refused it, since the label rule reads a single division.
     */
    const dom = r.byDivision.filter(d => d.division.crew)
      .sort((a, b) => b.hours - a.hours)[0]?.division.id || '';
    const labels = [...new Set(r.byDivision
      .map(d => divisionLabel(d.division.id)).filter(Boolean))];

    s.tasks.push({
      id: taskId, created: at,
      title: est.name,
      project: est.projectId || '',
      division: dom,
      jiraLabels: labels,
      assignee: '', status, priority: 'normal', due: '',
      estimate: Math.round(r.totalHours * 10) / 10, spent: 0,
      tags: ['WB', 'Scope'], objectiveId: null, order,
      /* The breakdown, one step per line. These become Jira sub-tasks of this
         task's issue when it is queued, so the shape survives the trip. */
      checklist: r.lines.map(l => ({
        t: `${l.division} · ${l.name}${l.qty > 1 ? ` ×${l.qty}` : ''}`
         + ` — ${Math.round(l.hours * 10) / 10}h`,
        done: false,
      })),
      desc: `Logged GFX work breakdown, ${new Date(at).toISOString().slice(0, 10)}.\n`
          + `${r.lines.length} items · ${Math.round(r.totalHours * 10) / 10}h `
          + `(${Math.round(r.totalHours / hpd * 10) / 10} person-days) · `
          + `${r.reviewPct}% review + ${r.contPct}% contingency included.`,
    });

    const e = (s.wbEstimates || []).find(x => x.id === estId);
    if (e) {
      e.status = 'approved';
      e.logged = {
        at,
        taskId,
        projectId: est.projectId || '',
        hours: r.totalHours,
        effortDays: r.totalHours / hpd,
        cost: r.totalCost,
        baseCost: r.baseCost,
        reviewPct: r.reviewPct,
        contPct: r.contPct,
        elapsedDays: Number.isFinite(r.elapsedDays) ? r.elapsedDays : null,
        currency: s.settings?.currencySymbol || '$',
        /* The lines as they were, so the Scopes view can show what was ordered
           even if the catalogue is edited afterwards. */
        lines: r.lines.map(l => ({
          division: l.division, name: l.name, qty: l.qty,
          complexity: l.complexity, approach: l.approach,
          baseHours: l.baseHours, hours: l.hours,
          seniority: l.seniorityUsed, rate: l.rate, cost: l.cost,
        })),
      };
      e.updated = at;
    }
  }, { label: 'log estimate' });

  return { ok: true, taskId };
}

/** Undo a log. The task is left alone — it may already have work against it. */
export function unlogEstimate(estId) {
  S.mutate(s => {
    const e = (s.wbEstimates || []).find(x => x.id === estId);
    if (e) { delete e.logged; e.status = 'quoted'; e.updated = Date.now(); }
  }, { label: 'unlog estimate' });
}

/** What has been logged, totalled per project. */
export function logRollUp(state = S.get()) {
  const rows = loggedEstimates(state);
  const byProject = new Map();
  for (const e of rows) {
    const pid = e.logged.projectId || e.projectId || '';
    const cur = byProject.get(pid) || { projectId: pid, count: 0, cost: 0, hours: 0, items: 0 };
    cur.count++; cur.cost += e.logged.cost || 0; cur.hours += e.logged.hours || 0;
    cur.items += (e.logged.lines || []).length;
    byProject.set(pid, cur);
  }
  return {
    rows,
    cost: rows.reduce((n, e) => n + (e.logged.cost || 0), 0),
    hours: rows.reduce((n, e) => n + (e.logged.hours || 0), 0),
    items: rows.reduce((n, e) => n + (e.logged.lines || []).length, 0),
    byProject: [...byProject.values()].sort((a, b) => b.cost - a.cost),
  };
}

/**
 * Turn an estimate into real tasks on the board.
 *
 * One task per line, in the line's division, with the computed hours as the
 * estimate — which is the point of doing the breakdown in the first place, and
 * the step that was pure retyping before. Their checklists stay empty; the
 * lines are already the breakdown.
 *
 * This is the alternative to `logEstimate()`: many small tasks to assign out,
 * rather than one signed scope with a checklist.
 */
export function estimateToTasks(est, { status = 'backlog', projectId = '' } = {}) {
  const r = estimate(est);
  const made = [];
  S.mutate(s => {
    let order = (s.tasks || []).filter(t => t.status === status)
      .reduce((m, t) => Math.min(m, t.order ?? 0), 1000) - 1000;
    for (const l of r.lines) {
      if (!l.hours) continue;
      const id = S.uid('tsk');
      s.tasks.push({
        id, created: Date.now(),
        title: `${est.name || 'Estimate'} — ${l.name}${l.qty > 1 ? ` ×${l.qty}` : ''}`,
        project: projectId || est.projectId || '',
        /* PROD is a real division now, so it keeps it like any other. */
        division: l.division,
        assignee: '', status, priority: 'normal', due: '',
        estimate: Math.round(l.hours * 10) / 10, spent: 0,
        tags: ['WB'], checklist: [], objectiveId: null, order,
        desc: `From work-breakdown estimate “${est.name || 'untitled'}”.\n`
            + `${l.name} · ${wbComplexity(l.complexity).label} · ×${l.qty} · `
            + `${wbApproach(l.approach).label} · ${l.seniorityUsed}`,
      });
      made.push(id);
      order -= 1000;
    }
  }, { label: 'create tasks from estimate' });
  return made;
}
