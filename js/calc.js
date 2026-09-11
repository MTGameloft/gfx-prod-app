/* ============================================================================
   calc.js — all the derived numbers, in one place.

   Views must not do arithmetic on state directly. Everything that could be
   argued about — burn, variance, EAC, available days, utilisation — is
   defined here once, so a number shown on the dashboard is the same number
   shown in Finance.
   ========================================================================= */

import * as S from './store.js';
import { today, monthOf, addMonths, eachDay, dayIdx, sum, groupBy, clamp } from './ui.js';

/* ---------- months ------------------------------------------------------- */

export function monthRange(from, to) {
  const out = []; let m = monthOf(from);
  const end = monthOf(to);
  let guard = 0;
  while (m <= end && guard++ < 120) { out.push(m); m = addMonths(m + '-01', 1); }
  return out;
}
export const thisMonth = () => monthOf(today());

export function fiscalMonths(year = new Date().getFullYear()) {
  const start = S.get().prefs.fiscalStart || 1;
  return Array.from({ length: 12 }, (_, i) => {
    const m = ((start - 1 + i) % 12) + 1;
    const y = year + (start - 1 + i >= 12 ? 1 : 0);
    return `${y}-${String(m).padStart(2, '0')}`;
  });
}

/* ---------- leave -------------------------------------------------------- */

export const LEAVE_TYPES = [
  { id: 'annual',   label: 'Annual leave', cls: 'lv-annual',   counts: true },
  { id: 'sick',     label: 'Sick',         cls: 'lv-sick',     counts: true },
  { id: 'comp',     label: 'Comp / TOIL',  cls: 'lv-comp',     counts: true },
  { id: 'parental', label: 'Parental',     cls: 'lv-parental', counts: true },
  { id: 'unpaid',   label: 'Unpaid',       cls: 'lv-unpaid',   counts: true },
  { id: 'training', label: 'Training',     cls: 'lv-training', counts: false },
  { id: 'wfh',      label: 'Work from home', cls: 'lv-wfh',    counts: false },
];
export const leaveType = id => LEAVE_TYPES.find(t => t.id === id) || LEAVE_TYPES[0];

export const isWorkingDay = (iso, holidaySet) => {
  const wd = S.get().prefs.workingDays || [1, 2, 3, 4, 5];
  return wd.includes(dayIdx(iso)) && !holidaySet.has(iso);
};

export const holidaySet = () => new Set(S.get().holidays.map(h => h.date));

/** Map of ISO date → leave entry, for one person. */
export function leaveDaysMap(personId) {
  const m = new Map();
  for (const l of S.get().leave) {
    if (l.personId !== personId) continue;
    for (const d of eachDay(l.from, l.to || l.from)) m.set(d, l);
  }
  return m;
}

/** Absent working-days for a person inside a month (halves count as 0.5). */
export function leaveDaysInMonth(personId, ym, hol = holidaySet()) {
  const map = leaveDaysMap(personId);
  let n = 0;
  for (const [d, l] of map) {
    if (monthOf(d) !== ym) continue;
    if (!isWorkingDay(d, hol)) continue;
    if (!leaveType(l.type).counts && l.type !== 'training') continue; // WFH is not absence
    n += l.half ? 0.5 : 1;
  }
  return n;
}

export function workingDaysInMonth(ym, hol = holidaySet()) {
  const days = eachDay(ym + '-01', lastOfMonth(ym));
  return days.filter(d => isWorkingDay(d, hol)).length;
}
export function lastOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
}

/** Who is away on a given day, with their entry. */
export function awayOn(iso) {
  return S.get().leave
    .filter(l => l.from <= iso && (l.to || l.from) >= iso)
    .map(l => ({ ...l, person: S.byId(S.get().people, l.personId) }))
    .filter(x => x.person);
}

/** Leave taken so far this year, per person, in days. */
export function leaveUsed(personId, year = new Date().getFullYear()) {
  const hol = holidaySet();
  let n = 0;
  for (const l of S.get().leave) {
    if (l.personId !== personId || l.type !== 'annual') continue;
    for (const d of eachDay(l.from, l.to || l.from)) {
      if (!d.startsWith(String(year))) continue;
      if (isWorkingDay(d, hol)) n += l.half ? 0.5 : 1;
    }
  }
  return n;
}

/* ---------- capacity ----------------------------------------------------- */

/**
 * Available person-days per month, optionally filtered to a project or
 * division. Leave and public holidays are already removed.
 */
export function capacity(ym, { projectId = null, division = null, include = null } = {}) {
  const s = S.get(), hol = holidaySet();
  const wd = workingDaysInMonth(ym, hol);
  let gross = 0, net = 0, lost = 0;
  const rows = [];
  for (const p of s.people) {
    if (p.active === false) continue;
    if (division && p.division !== division) continue;
    // `include` lets a view narrow the roster to whatever its own filters
    // selected, so a filter set in one tab means the same thing in all of them
    if (include && !include.has(p.id)) continue;
    const share = projectId
      ? ((p.alloc || []).find(a => a.projectId === projectId)?.pct || 0) / 100
      : 1;
    if (projectId && share === 0) continue;
    const cap = (p.capacity ?? 100) / 100;
    const away = leaveDaysInMonth(p.id, ym, hol);
    const g = wd * cap * share;
    const n = Math.max(0, (wd - away) * cap * share);
    gross += g; net += n; lost += g - n;
    rows.push({ person: p, gross: g, net: n, away: away * share, share });
  }
  return { ym, workingDays: wd, gross, net, lost, rows };
}

/** Estimated demand (in days) landing in a month, from task due dates. */
export function demand(ym, { projectId = null, division = null } = {}) {
  const hpd = S.get().settings.hoursPerDay || 8;
  return sum(S.get().tasks.filter(t =>
    t.status !== 'done' && t.due && monthOf(t.due) === ym &&
    (!projectId || t.project === projectId) &&
    (!division || t.division === division)
  ), t => (t.estimate || 0) / hpd);
}

/* ---------- finance ------------------------------------------------------ */

export const CATEGORIES = [
  { id: 'internal',  label: 'Internal headcount', color: '#4C9AFF' },
  { id: 'outsource', label: 'Outsourcing',        color: '#E8A33D' },
  { id: 'license',   label: 'Licences & tools',   color: '#A055C9' },
  { id: 'hardware',  label: 'Hardware',           color: '#2FB8A8' },
  { id: 'travel',    label: 'Travel & events',    color: '#E2637E' },
  { id: 'other',     label: 'Other / contingency',color: '#8A8886' },
];
export const catOf = id => CATEGORIES.find(c => c.id === id) || CATEGORIES.at(-1);

const mSum = (map, filter = () => true) =>
  sum(Object.entries(map || {}).filter(([m]) => filter(m)), ([, v]) => v);

/**
 * The finance picture for one project (or the whole portfolio when id is null).
 *
 *   plannedToDate  what we said we would have spent by the end of last month
 *   actualToDate   what we actually booked
 *   variance       actual − planned  (positive is overspend)
 *   eac.plan       actuals + the rest of the plan          — "the plan still holds"
 *   eac.runRate    actuals + recent monthly average × months left — "we keep going like this"
 *   eac.cpi        budget ÷ cost-performance index         — "the overrun scales"
 */
export function projectFinance(projectId, { asOf = thisMonth(), method = 'plan' } = {}) {
  const s = S.get();
  const lines = s.budgetLines.filter(b => !projectId || b.projectId === projectId);
  const proj = projectId ? S.byId(s.projects, projectId) : null;

  const months = [...new Set(lines.flatMap(b => [
    ...Object.keys(b.plannedByMonth || {}), ...Object.keys(b.actualByMonth || {}),
  ]))].sort();
  const closed = m => m < asOf;                 // the current month is still open

  const planned = sum(lines, b => mSum(b.plannedByMonth));
  const actual  = sum(lines, b => mSum(b.actualByMonth));
  const plannedToDate = sum(lines, b => mSum(b.plannedByMonth, closed));
  const actualToDate  = sum(lines, b => mSum(b.actualByMonth, closed));
  const budget = projectId ? (proj?.budget ?? planned) : sum(s.projects, p => p.budget || 0);

  const remainingPlan = planned - sum(lines, b => mSum(b.plannedByMonth, closed));
  const closedMonths = months.filter(closed);
  const last3 = closedMonths.slice(-3);
  const runRate = last3.length
    ? sum(last3, m => sum(lines, b => b.actualByMonth?.[m] || 0)) / last3.length : 0;
  const monthsLeft = months.filter(m => !closed(m)).length;

  const cpi = actualToDate > 0 ? plannedToDate / actualToDate : 1;
  const eac = {
    plan:    actualToDate + remainingPlan,
    runRate: actualToDate + runRate * monthsLeft,
    cpi:     cpi > 0 ? budget / cpi : budget,
  };
  const forecast = eac[method] ?? eac.plan;

  const byMonth = months.map(m => ({
    m,
    planned: sum(lines, b => b.plannedByMonth?.[m] || 0),
    actual:  closed(m) ? sum(lines, b => b.actualByMonth?.[m] || 0) : null,
    forecast: closed(m) ? null : sum(lines, b => b.plannedByMonth?.[m] || 0),
  }));
  // cumulative series for the burn chart
  let cp = 0, ca = 0, cf = 0; let seenOpen = false;
  const cumulative = byMonth.map(r => {
    cp += r.planned;
    if (r.actual != null) { ca += r.actual; cf = ca; }
    else { seenOpen = true; cf += (method === 'runRate' ? runRate : r.planned); }
    return { m: r.m, planned: cp, actual: r.actual != null ? ca : null, forecast: seenOpen ? cf : null };
  });

  const byCategory = Object.entries(groupBy(lines, b => b.type)).map(([k, arr]) => ({
    id: k, label: catOf(k).label, color: catOf(k).color,
    planned: sum(arr, b => mSum(b.plannedByMonth)),
    actual:  sum(arr, b => mSum(b.actualByMonth)),
  })).sort((a, b) => b.planned - a.planned);

  return {
    projectId, budget, planned, actual, plannedToDate, actualToDate,
    variance: actualToDate - plannedToDate,
    variancePct: plannedToDate ? ((actualToDate - plannedToDate) / plannedToDate) * 100 : 0,
    burnPct: budget ? (actualToDate / budget) * 100 : 0,
    runRate, monthsLeft, cpi, eac, forecast,
    etc: Math.max(0, forecast - actualToDate),
    landing: forecast - budget,
    landingPct: budget ? ((forecast - budget) / budget) * 100 : 0,
    months, byMonth, cumulative, byCategory, lines,
  };
}

/** Modelled internal cost for a project in a month, from the roster. */
export function headcountCost(projectId, ym) {
  const s = S.get();
  const hol = holidaySet();
  const wd = workingDaysInMonth(ym, hol) || 1;
  return sum(s.people.filter(p => p.active !== false), p => {
    const share = ((p.alloc || []).find(a => a.projectId === projectId)?.pct || 0) / 100;
    if (!share) return 0;
    const rate = p.costMonthly || rateFor(p.seniority);
    const away = leaveDaysInMonth(p.id, ym, hol);
    return rate * share * ((wd - away * 0) / wd); // leave is paid: no cost reduction
  });
}
/**
 * The seniority ladder, in order.
 *
 * Lives here rather than in a view because three places need it — the Team
 * form, the Excel schema and the Finance forecast — and a vocabulary with
 * three copies is a vocabulary with three versions. Values are the labels
 * themselves, so what the app shows, what Excel writes and what is stored are
 * one string with no mapping table to get wrong.
 */
/* The ladder itself lives in `seniority.js`, which imports nothing — `store.js`
   needs it too, and this module already imports `store.js`. Re-exported here so
   the eight modules that read it from `calc.js` are unaffected. */
export { SENIORITY, LEGACY_SENIORITY, normSeniority } from './seniority.js';

export const CONTRACT  = ['staff', 'contract', 'outsource', 'intern'];

/* What kind of objective a goal is. Two kinds, because that is the split that
   matters at review time: what they delivered against what they became. */
export const GOAL_CATEGORY = [
  { id: 'performance', label: 'Performance objective' },
  { id: 'development', label: 'Development objective' },
];
export const GOAL_STATUS = [
  { id: 'open',     label: 'Not started', chip: '' },
  { id: 'progress', label: 'In progress', chip: 'info' },
  { id: 'done',     label: 'Achieved',    chip: 'ok' },
  { id: 'dropped',  label: 'Dropped',     chip: '' },
];

/* How a 1:1 went. Lives here rather than in the person page because the Excel
   schema needs the same list for its drop-down, and a view is the wrong place
   for a vocabulary two readers share. */
export const MOODS = [
  { id: 'good',      label: 'Good',      chip: 'ok' },
  { id: 'neutral',   label: 'Neutral',   chip: '' },
  { id: 'concerned', label: 'Concerned', chip: 'warn' },
  { id: 'unhappy',   label: 'Unhappy',   chip: 'risk' },
];

/**
 * Blended monthly cost for a rung.
 *
 * Matched case-insensitively: records predating the ladder rename hold
 * lowercase values like `lead`, and a forecast silently reading 0 for them
 * would be worse than a slightly forgiving lookup.
 */
export const rateFor = seniority => {
  const want = String(seniority || '').trim().toLowerCase();
  if (!want) return 0;
  return S.get().rateCard.find(r => String(r.seniority || '').trim().toLowerCase() === want)?.monthly || 0;
};

/** What the roster implies for a whole year, per project — the sanity check
    against the "internal headcount" budget line somebody typed in by hand. */
export function modelledInternal(projectId, months) {
  return sum(months, m => headcountCost(projectId, m));
}

/* ---------- tasks & objectives ------------------------------------------- */

export const STATUSES = [
  { id: 'backlog', label: 'Backlog',     color: '#8A8886' },
  { id: 'todo',    label: 'To do',       color: '#0F6CBD' },
  { id: 'doing',   label: 'In progress', color: '#6264A7' },
  { id: 'review',  label: 'In review',   color: '#E8A33D' },
  { id: 'blocked', label: 'Blocked',     color: '#C4314B' },
  { id: 'done',    label: 'Done',        color: '#13A10E' },
];
export const PRIORITIES = [
  { id: 'critical', label: 'Critical', rank: 0 },
  { id: 'high',     label: 'High',     rank: 1 },
  { id: 'normal',   label: 'Normal',   rank: 2 },
  { id: 'low',      label: 'Low',      rank: 3 },
];
export const statusOf = id => STATUSES.find(x => x.id === id) || STATUSES[0];
export const prioRank = id => PRIORITIES.find(x => x.id === id)?.rank ?? 2;

export function taskStats(filter = () => true) {
  const t = S.get().tasks.filter(filter);
  const td = today();
  const open = t.filter(x => x.status !== 'done');
  return {
    total: t.length,
    open: open.length,
    done: t.length - open.length,
    overdue: open.filter(x => x.due && x.due < td).length,
    dueSoon: open.filter(x => x.due && x.due >= td && x.due <= addDaysStr(td, 7)).length,
    blocked: open.filter(x => x.status === 'blocked').length,
    donePct: t.length ? ((t.length - open.length) / t.length) * 100 : 0,
    estimate: sum(open, x => x.estimate || 0),
    spent: sum(t, x => x.spent || 0),
  };
}
const addDaysStr = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

export function krProgress(kr) {
  const t = Number(kr.target) || 0, c = Number(kr.current) || 0;
  if (!t) return c ? 100 : 0;
  const p = kr.invert ? (c <= t ? 100 : clamp((t / c) * 100, 0, 100)) : clamp((c / t) * 100, 0, 100);
  return Math.round(p);
}
export const objProgress = o =>
  o.keyResults?.length ? Math.round(sum(o.keyResults, krProgress) / o.keyResults.length) : 0;

/* ---------- outsourcing -------------------------------------------------- */

export const VENDOR_STATUS = [
  { id: 'active', label: 'Active',  chip: 'ok' },
  { id: 'trial',  label: 'On trial', chip: 'warn' },
  { id: 'paused', label: 'Paused',  chip: '' },
  { id: 'former', label: 'Former',  chip: '' },
];
export const RATE_MODELS = [
  { id: 'per-asset', label: 'Per asset' },
  { id: 'retainer',  label: 'Monthly retainer' },
  { id: 'day-rate',  label: 'Day rate' },
  { id: 'fixed-bid', label: 'Fixed bid per batch' },
];
export const BATCH_STATUS = [
  { id: 'briefed',     label: 'Briefed',     chip: '',     open: true },
  { id: 'in-progress', label: 'In progress', chip: 'info', open: true },
  { id: 'in-review',   label: 'In review',   chip: 'warn', open: true },
  { id: 'revisions',   label: 'Revisions',   chip: 'warn', open: true },
  { id: 'accepted',    label: 'Accepted',    chip: 'ok',   open: false },
  { id: 'rejected',    label: 'Rejected',    chip: 'risk', open: false },
  { id: 'cancelled',   label: 'Cancelled',   chip: '',     open: false },
];
export const batchStatus = id => BATCH_STATUS.find(x => x.id === id) || BATCH_STATUS[0];
export const vendorStatus = id => VENDOR_STATUS.find(x => x.id === id) || VENDOR_STATUS[0];
export const rateModel = id => RATE_MODELS.find(x => x.id === id) || RATE_MODELS[0];

/**
 * A vendor's record, measured rather than remembered.
 *
 * `budgetSpend` comes from the outsourcing budget lines whose `vendor` string
 * matches this vendor's name — the two were separate fields before vendors
 * existed, so the match is by name and a mismatch is surfaced rather than
 * silently ignored (see `orphanVendorNames`).
 */
export function vendorStats(vendorId) {
  const s = S.get();
  const v = S.byId(s.vendors, vendorId);
  const batches = (s.outsourceBatches || []).filter(b => b.vendorId === vendorId);
  const closed = batches.filter(b => b.deliveredOn && b.dueOn);
  const onTimeN = closed.filter(b => b.deliveredOn <= b.dueOn).length;
  const open = batches.filter(b => batchStatus(b.status).open);
  const accepted = batches.filter(b => b.status === 'accepted');

  const budgetSpend = sum(
    s.budgetLines.filter(b => b.type === 'outsource' &&
      (b.vendor || '').trim().toLowerCase() === (v?.name || '').trim().toLowerCase()),
    b => sum(Object.values(b.actualByMonth || {})));

  const budgetPlanned = sum(
    s.budgetLines.filter(b => b.type === 'outsource' &&
      (b.vendor || '').trim().toLowerCase() === (v?.name || '').trim().toLowerCase()),
    b => sum(Object.values(b.plannedByMonth || {})));

  return {
    vendor: v, batches, open, accepted,
    committed: sum(batches, b => b.agreedCost || 0),
    committedOpen: sum(open, b => b.agreedCost || 0),
    budgetSpend, budgetPlanned,
    onTimePct: closed.length ? (onTimeN / closed.length) * 100 : null,
    closedCount: closed.length,
    avgRevisions: batches.length ? sum(batches, b => b.revisions || 0) / batches.length : 0,
    overdue: open.filter(b => b.dueOn && b.dueOn < today() && !b.deliveredOn),
    score: v ? Math.round((((v.quality || 0) + (v.onTime || 0) + (v.comms || 0)) / 15) * 100) : 0,
  };
}

/** Budget lines tagged as outsourcing whose vendor name matches no record. */
export function orphanVendorNames() {
  const s = S.get();
  const known = new Set((s.vendors || []).map(v => (v.name || '').trim().toLowerCase()));
  const seen = new Map();
  for (const b of s.budgetLines) {
    if (b.type !== 'outsource') continue;
    const name = (b.vendor || '').trim();
    if (!name || known.has(name.toLowerCase())) continue;
    seen.set(name, (seen.get(name) || 0) + sum(Object.values(b.plannedByMonth || {})));
  }
  return [...seen].map(([name, planned]) => ({ name, planned }));
}

/* ---------- risk & health ------------------------------------------------ */

export function projectHealth(p) {
  const f = projectFinance(p.id);
  const t = taskStats(x => x.project === p.id);
  const openRisks = (p.risks || []).filter(r => r.status !== 'closed');
  const highRisk = openRisks.filter(r => r.impact === 'high' && r.likelihood !== 'low').length;
  const overdueMs = (p.milestones || []).filter(m => m.status !== 'done' && m.date < today()).length;

  let score = 100;
  score -= Math.min(30, t.overdue * 4);
  score -= Math.min(20, highRisk * 10);
  score -= Math.min(25, overdueMs * 12);
  if (f.landingPct > 5) score -= Math.min(25, f.landingPct);
  const rag = score >= 78 ? 'green' : score >= 55 ? 'amber' : 'red';
  return { score: Math.max(0, Math.round(score)), rag, overdueTasks: t.overdue, highRisk, overdueMs, finance: f, tasks: t };
}

export const ragColor = r => (r === 'green' ? 'var(--ok)' : r === 'amber' ? 'var(--warn)' : 'var(--risk)');
