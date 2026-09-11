/**
 * The page for one person: Overview, Goals, 1:1.
 *
 * Lives apart from views/people.js because that file owns the roster, the
 * skills matrix and the capacity view, and none of those have anything to do
 * with a single person's record. The route is still `#/people/<id>`, with the
 * tab as a second parameter — `#/people/<id>/goals` — so the browser's own
 * back button moves between tabs and a tab can be linked to.
 *
 * GOALS ARE A TOP-LEVEL COLLECTION keyed by `personId`, like leave, tasks and
 * one-to-ones. They started nested inside each person, which made them the odd
 * one out and meant a single Excel sheet could not hold the whole team's
 * objectives; `liftGoals()` in store.js moves any that are still nested.
 *
 * Two shapes are readable: the original `{id, text, done, due}` and the current
 * `{title, category, weight, status, due, notes, milestones[]}`. Always read
 * through `goalTitle()` and `goalStatus()` rather than the raw fields, so no
 * record ever has to be rewritten to be understood.
 */

import * as S from './store.js';
import {
  h, raw, esc, icon, toast, dialog, formDlg, confirmDlg, menu, acts, bar,
  fmtDate, fmtMoney, fmtMoneyFull, today, addDays, daysBetween, clamp,
  initials, hashColor, sum,
} from './ui.js';
import { capacity, leaveUsed, thisMonth, rateFor, taskStats, LEAVE_TYPES, MOODS,
         GOAL_CATEGORY, GOAL_STATUS } from './calc.js';
import { renderRich, richIsEmpty } from './richtext.js';

export const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'goals',    label: 'Goals' },
  { id: 'oneone',   label: '1:1' },
];

const moodOf = id => MOODS.find(m => m.id === id) || null;

/* ---------- reading a goal, old shape or new ---------------------------- */

export const goalTitle  = g => g.title || g.text || '(untitled goal)';
export const goalStatus = g => g.status || (g.done ? 'done' : 'open');
const statusOf = g => GOAL_STATUS.find(s => s.id === goalStatus(g)) || GOAL_STATUS[0];
const isOpenGoal = g => !['done', 'dropped'].includes(goalStatus(g));

/** Progress from the milestones, or from the status when there are none. */
function goalProgress(g) {
  const ms = g.milestones || [];
  if (ms.length) return Math.round(ms.filter(m => m.done).length / ms.length * 100);
  return goalStatus(g) === 'done' ? 100 : goalStatus(g) === 'progress' ? 50 : 0;
}

/* Goals are a top-level collection keyed by personId now, not nested inside
   the person — see liftGoals() in store.js. */
const goalsOf = (p, s = S.get()) => (s.goals || []).filter(g => g.personId === p.id);
const categoryOf = g => GOAL_CATEGORY.find(c => c.id === g.category) || null;
const logsOf = (pid, s = S.get()) =>
  s.oneToOnes.filter(o => o.personId === pid).sort((a, b) => b.date.localeCompare(a.date));

/** Every unticked action across every 1:1, newest source first. */
function openActions(pid, s = S.get()) {
  const out = [];
  for (const o of logsOf(pid, s)) {
    (o.actions || []).forEach((a, i) => { if (!a.done) out.push({ ...a, i, logId: o.id, date: o.date }); });
  }
  return out;
}

/* ---------- header ------------------------------------------------------- */

function header(p, tab) {
  const s = S.get();
  const nOpenGoals = goalsOf(p).filter(isOpenGoal).length;
  const nLogs = logsOf(p.id, s).length;
  const count = { goals: nOpenGoals, oneone: nLogs };

  return h`
  <div class="row" style="margin-bottom:12px">
    <button class="btn subtle sm" data-act="back">← Team</button>
    <span class="avatar" style="background:${hashColor(p.name)}">${initials(p.name)}</span>
    <div style="flex:1;min-width:0">
      <h2 style="font-size:19px">${p.name}</h2>
      <div class="tiny mute">${[p.role, S.byId(s.divisions, p.division)?.name || p.division,
                               p.seniority, p.contract].filter(Boolean).join(' · ')}</div>
    </div>
    ${raw(p.email ? `<a class="btn sm subtle" href="mailto:${esc(p.email)}">${icon('link').html}Email</a>` : '')}
    <button class="btn sm subtle" data-act="edit">${icon('edit')}Edit</button>
  </div>

  <div class="seg" style="margin-bottom:14px">
    ${raw(TABS.map(t => `<button data-act="tab" data-v="${t.id}" class="${t.id === tab ? 'on' : ''}">
      ${esc(t.label)}${count[t.id] ? ` <span class="tiny mute">${count[t.id]}</span>` : ''}
    </button>`).join(''))}
  </div>`;
}

/* ---------- Overview ---------------------------------------------------- */

/**
 * One chronological strip of everything that concerns this person.
 *
 * The point of the tab: a 1:1 is a conversation about what happened and what
 * is coming, and that story is currently spread over four collections. Merging
 * them into one list ordered by date is the whole feature.
 */
function personTimeline(p) {
  const s = S.get();
  const td = today();
  const rows = [];

  for (const o of logsOf(p.id, s)) {
    const open = (o.actions || []).filter(a => !a.done).length;
    rows.push({ date: o.date, kind: '1:1', icon: 'note', tone: '',
      text: '1:1 logged' + (moodOf(o.mood) ? ` — ${moodOf(o.mood).label.toLowerCase()}` : ''),
      sub: open ? `${open} action${open === 1 ? '' : 's'} still open` : '' });
  }

  for (const l of s.leave.filter(x => x.personId === p.id)) {
    const t = LEAVE_TYPES.find(x => x.id === l.type);
    const days = Math.max(1, daysBetween(l.from, l.to) + 1);
    rows.push({ date: l.from, kind: 'Time off', icon: 'cal', tone: l.from > td ? 'info' : '',
      text: `${t ? t.label : l.type} — ${days} day${days === 1 ? '' : 's'}`,
      sub: l.from === l.to ? '' : `${fmtDate(l.from)} → ${fmtDate(l.to)}${l.note ? ' · ' + l.note : ''}` });
  }

  for (const g of goalsOf(p)) {
    if (g.due) rows.push({ date: g.due, kind: 'Goal', icon: 'target',
      tone: isOpenGoal(g) && g.due < td ? 'risk' : '',
      text: goalTitle(g), sub: `target · ${statusOf(g).label}` });
    for (const m of g.milestones || []) {
      if (!m.due) continue;
      rows.push({ date: m.due, kind: 'Milestone', icon: 'flag',
        tone: !m.done && m.due < td ? 'risk' : '',
        text: m.text, sub: `${goalTitle(g)}${m.done ? ' · done' : ''}` });
    }
  }

  for (const t of s.tasks.filter(x => x.assignee === p.id && x.status !== 'done' && x.due)) {
    rows.push({ date: t.due, kind: 'Task', icon: 'board', tone: t.due < td ? 'risk' : '',
      text: t.title, sub: S.projectName(t.project) });
  }

  if (!rows.length) {
    return h`<section class="card"><header><h3>Timeline</h3></header>
      <div class="body"><div class="tiny mute">Nothing dated for this person yet — no 1:1s,
        leave, goals or tasks with a date on them.</div></div></section>`;
  }

  // Upcoming first, then the past most-recent-first: the future is the part
  // you can still act on.
  const future = rows.filter(r => r.date >= td).sort((a, b) => a.date.localeCompare(b.date));
  const past   = rows.filter(r => r.date <  td).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);

  const row = r => `<div class="pt-row${r.tone ? ' ' + r.tone : ''}">
    <div class="pt-when tiny">${esc(fmtDate(r.date))}</div>
    <span class="pt-dot"></span>
    <div class="pt-what">
      <div><span class="chip tiny">${esc(r.kind)}</span> ${esc(r.text)}</div>
      ${r.sub ? `<div class="tiny mute">${esc(r.sub)}</div>` : ''}
    </div></div>`;

  return h`
  <section class="card">
    <header><h3>Timeline</h3>
      <span class="sub">${future.length} ahead · last ${past.length}</span></header>
    <div class="body">
      ${raw(future.length ? `<div class="pt-head tiny mute">Coming up</div>` + future.map(row).join('')
                          : '<div class="tiny mute">Nothing scheduled ahead.</div>')}
      ${raw(past.length ? `<div class="pt-head tiny mute" style="margin-top:12px">Already happened</div>`
                          + past.map(row).join('') : '')}
    </div>
  </section>`;
}

function overviewTab(p, ctx) {
  const s = S.get();
  const ym = thisMonth();
  const mine = capacity(ym, {}).rows.find(r => r.person.id === p.id);
  const used = leaveUsed(p.id);
  const allow = p.leaveAllowance ?? 15;
  const st = taskStats(t => t.assignee === p.id);
  const cost = p.costMonthly || rateFor(p.seniority);
  const sym = s.settings.currencySymbol;
  const tot = sum(p.alloc || [], a => a.pct);
  const actions = openActions(p.id, s);
  const goals = goalsOf(p).filter(isOpenGoal);
  const td = today();
  const soon = s.leave.filter(l => l.personId === p.id && l.to >= td)
    .sort((a, b) => a.from.localeCompare(b.from));

  return h`
  <div class="grid g4" style="margin-bottom:14px">
    <div class="card stat"><div class="k">Allocation</div><div class="v">${tot}%</div>
      <div class="d ${tot > 100 ? 'down' : ''}">${(p.alloc || []).length} project${(p.alloc || []).length === 1 ? '' : 's'}</div></div>
    <div class="card stat"><div class="k">Open tasks</div><div class="v">${st.open}</div>
      <div class="d ${st.overdue ? 'down' : ''}">${st.overdue} overdue</div></div>
    <div class="card stat"><div class="k">Annual leave</div>
      <div class="v">${used}<span style="font-size:14px;font-weight:400"> / ${allow}</span></div>
      <div class="d">${Math.max(0, allow - used)} days remaining</div></div>
    <div class="card stat"><div class="k">Modelled cost</div><div class="v">${fmtMoney(cost, sym)}</div>
      <div class="d">per month, fully loaded</div></div>
  </div>

  <div class="grid" style="grid-template-columns:1fr 1fr;margin-bottom:14px">
    <section class="card">
      <header><h3>Action points</h3>
        <span class="sub">from 1:1s</span>
        <div class="spacer" style="flex:1"></div>
        <button class="btn sm subtle" data-act="go-oneone">Open 1:1s</button></header>
      <div class="body">
        ${raw(actions.length ? actions.map(a => `
          <label class="row pt-act" data-log="${a.logId}" data-i="${a.i}">
            <input type="checkbox" data-act="act-done">
            <span class="tiny" style="flex:1">${esc(a.t)}</span>
            <span class="tiny mute">${esc(fmtDate(a.date))}</span>
          </label>`).join('')
          : '<div class="tiny mute">Nothing outstanding. Actions you agree in a 1:1 show up here until they are ticked.</div>')}
      </div>
    </section>

    <section class="card">
      <header><h3>Goals in flight</h3>
        <div class="spacer" style="flex:1"></div>
        <button class="btn sm subtle" data-act="go-goals">All goals</button></header>
      <div class="body">
        ${raw(goals.length ? goals.slice(0, 4).map(g => {
          const pct = goalProgress(g);
          const late = g.due && g.due < td;
          return `<div style="margin-bottom:11px">
            <div class="row tiny" style="margin-bottom:3px">
              <span style="flex:1"><b>${esc(goalTitle(g))}</b></span>
              <span class="${late ? 'overdue' : 'mute'}">${g.due ? esc(fmtDate(g.due)) : ''}</span>
            </div>
            ${bar(pct, pct >= 70 ? 'ok' : pct >= 30 ? 'warn' : '').html}
            <div class="tiny mute" style="margin-top:2px">${statusOf(g).label} · ${pct}%${
              (g.milestones || []).length ? ` · ${g.milestones.filter(m => m.done).length}/${g.milestones.length} milestones` : ''}</div>
          </div>`;
        }).join('') : '<div class="tiny mute">No goal written down yet.</div>')}
      </div>
    </section>
  </div>

  <div class="grid" style="grid-template-columns:1fr 1fr;margin-bottom:14px">
    <section class="card">
      <header><h3>Project allocation</h3><div class="spacer" style="flex:1"></div>
        <button class="btn sm subtle" data-act="alloc">${icon('edit')}Adjust</button></header>
      <div class="body">
        ${raw((p.alloc || []).length ? (p.alloc || []).map(a => {
          const pr = S.byId(s.projects, a.projectId);
          if (!pr) return '';
          return `<div style="margin-bottom:10px">
            <div class="row tiny" style="margin-bottom:3px"><span style="flex:1"><b>${esc(pr.name)}</b></span><span>${a.pct}%</span></div>
            <span class="bar"><i style="width:${clamp(a.pct, 0, 100)}%;background:${pr.color}"></i></span>
            <div class="tiny mute" style="margin-top:2px">${fmtMoneyFull(cost * a.pct / 100, sym)}/mo charged here</div>
          </div>`;
        }).join('') : '<div class="tiny mute">Not allocated to any project.</div>')}
        ${raw(tot !== 100 && (p.alloc || []).length ? `<div class="tiny ${tot > 100 ? 'overdue' : 'mute'}" style="margin-top:8px">Allocation totals ${tot}%${tot > 100 ? ' — double-booked on paper.' : '.'}</div>` : '')}
      </div>
    </section>

    <section class="card">
      <header><h3>Time off</h3><span class="sub">${used} of ${allow} used</span>
        <div class="spacer" style="flex:1"></div>
        <button class="btn sm subtle" data-act="go-leave">Calendar</button></header>
      <div class="body">
        ${raw(soon.length ? soon.slice(0, 6).map(l => {
          const t = LEAVE_TYPES.find(x => x.id === l.type);
          const days = Math.max(1, daysBetween(l.from, l.to) + 1);
          return `<div class="row tiny" style="margin-bottom:7px">
            <span class="chip tiny">${esc(t ? t.label : l.type)}</span>
            <span style="flex:1">${esc(fmtDate(l.from))}${l.from === l.to ? '' : ' → ' + esc(fmtDate(l.to))}</span>
            <span class="mute">${days}d</span></div>`;
        }).join('') : '<div class="tiny mute">Nothing booked from today onwards.</div>')}
      </div>
    </section>
  </div>

  ${raw(personTimeline(p))}

  <section class="card" style="margin-top:14px">
    <header><h3>Skills</h3><div class="spacer" style="flex:1"></div>
      <button class="btn sm subtle" data-act="skills">${icon('edit')}Edit</button></header>
    <div class="body">
      ${raw(Object.keys(p.skills || {}).length ? `<div class="grid" style="grid-template-columns:1fr 1fr;gap:0 22px">`
        + Object.entries(p.skills).sort((a, b) => b[1] - a[1]).map(([k, v]) => `
          <div class="row" style="margin-bottom:7px">
            <span class="tiny" style="flex:1">${esc(k)}</span>
            <span class="row" style="gap:3px">${[1, 2, 3, 4, 5].map(n =>
              `<span style="width:12px;height:12px;border-radius:3px;background:${n <= v ? 'var(--accent)' : 'var(--bg-sunken)'}"></span>`).join('')}</span>
          </div>`).join('') + '</div>'
        : '<div class="tiny mute">No skills recorded. Adding a handful makes the coverage matrix useful.</div>')}
    </div>
  </section>`;
}

/* ---------- Goals ------------------------------------------------------- */

function goalsTab(p) {
  const gs = goalsOf(p);
  const td = today();
  const order = { progress: 0, open: 1, done: 2, dropped: 3 };
  const sorted = gs.slice().sort((a, b) =>
    (order[goalStatus(a)] ?? 9) - (order[goalStatus(b)] ?? 9) ||
    (a.due || '9999').localeCompare(b.due || '9999'));

  if (!gs.length) {
    return h`<section class="card"><div class="empty">
      <svg class="ico"><use href="#i-target"></use></svg>
      <h4>No goals yet</h4>
      <div class="tiny">A goal is something they will be able to do that they cannot do today.
        Give it notes and a few milestones and the 1:1 has an agenda.</div>
      <button class="btn primary sm" data-act="goal-add" style="margin-top:12px">${icon('plus')}Add a goal</button>
    </div></section>`;
  }

  const openN = gs.filter(isOpenGoal).length;
  const doneN = gs.filter(g => goalStatus(g) === 'done').length;
  /* Weights are only meaningful across the goals that still count, so a
     dropped objective does not drag the total below 100. */
  const weight = sum(gs.filter(g => goalStatus(g) !== 'dropped'), g => g.weight || 0);

  /* The empty state has its own Add button, but once there is one goal that
     button disappears with it — leaving no way to add a second. */
  return h`
  <div class="toolbar" style="margin-bottom:12px">
    <span class="tiny mute">${openN} in flight${doneN ? ` · ${doneN} achieved` : ''}${gs.length !== openN + doneN ? ` · ${gs.length - openN - doneN} dropped` : ''}</span>
    ${raw(weight ? `<span class="chip tiny ${weight === 100 ? 'ok' : 'warn'}"
      title="${weight === 100 ? 'Weights add up.' : 'Weights should total 100% across the goals that count.'}"
      >weight ${weight}%</span>` : '')}
    <div class="spacer" style="flex:1"></div>
    <button class="btn sm primary" data-act="goal-add">${icon('plus')}Add a goal</button>
  </div>
  ${raw(sorted.map(g => {
    const s0 = statusOf(g);
    const pct = goalProgress(g);
    const ms = g.milestones || [];
    const late = g.due && g.due < td && isOpenGoal(g);
    return `
    <section class="card goal" data-goal="${g.id}" style="margin-bottom:14px">
      <header>
        <span class="chip ${s0.chip}">${esc(s0.label)}</span>
        <div style="flex:1;min-width:0">
          <h3>${esc(goalTitle(g))}</h3>
          <div class="sub">${[
            categoryOf(g) ? esc(categoryOf(g).label) : '',
            g.weight ? `${g.weight}% weight` : '',
            g.due ? `<span class="${late ? 'overdue' : ''}">target ${esc(fmtDate(g.due, 'long'))}${late ? ' — passed' : ''}</span>` : '',
          ].filter(Boolean).join(' · ')}</div>
        </div>
        <button class="btn icon sm subtle" data-act="goal-menu" title="More">
          <svg class="ico"><use href="#i-dots"></use></svg></button>
      </header>
      <div class="body">
        <div class="row tiny mute" style="margin-bottom:4px">
          <span style="flex:1">Progress</span><span>${pct}%${ms.length ? ` · ${ms.filter(m => m.done).length}/${ms.length}` : ''}</span></div>
        ${bar(pct, pct >= 70 ? 'ok' : pct >= 30 ? 'warn' : '').html}

        ${!richIsEmpty(g.notes) ? `<div class="sep" style="margin:12px 0"></div>
          <div class="rich">${renderRich(g.notes)}</div>` : ''}

        <div class="sep" style="margin:12px 0"></div>
        <div class="row tiny mute" style="margin-bottom:6px">
          <span style="flex:1">Milestones</span>
          <button class="btn sm subtle" data-act="ms-add">${icon('plus').html}Add</button></div>
        ${ms.length ? ms.map((m, i) => `
          <label class="row pt-act" data-ms="${i}">
            <input type="checkbox" data-act="ms-done" ${m.done ? 'checked' : ''}>
            <span class="tiny" style="flex:1;${m.done ? 'text-decoration:line-through;opacity:.6' : ''}">${esc(m.text)}</span>
            ${m.due ? `<span class="tiny ${!m.done && m.due < td ? 'overdue' : 'mute'}">${esc(fmtDate(m.due))}</span>` : ''}
            <button class="btn icon sm subtle" data-act="ms-del"><svg class="ico"><use href="#i-x"></use></svg></button>
          </label>`).join('')
          : '<div class="tiny mute">No milestones. Breaking a goal into two or three makes progress visible.</div>'}
      </div>
    </section>`;
  }).join(''))}`;
}

/* ---------- 1:1 --------------------------------------------------------- */

function oneOneTab(p) {
  const logs = logsOf(p.id);
  const td = today();
  const open = openActions(p.id).length;

  if (!logs.length) {
    return h`<section class="card"><div class="empty">
      <svg class="ico"><use href="#i-note"></use></svg>
      <h4>No 1:1s logged</h4>
      <div class="tiny">Log what was discussed and what you both agreed to do.
        Open actions carry forward to the Overview tab until they are ticked.</div>
      <button class="btn primary sm" data-act="log" style="margin-top:12px">${icon('plus')}Log a 1:1</button>
    </div></section>`;
  }

  const last = logs[0];
  const gap = daysBetween(last.date, td);

  return h`
  <div class="banner${gap > 42 ? ' warn' : ''}" style="margin-bottom:14px">
    ${icon('info')}
    <div style="flex:1">
      <b>Last 1:1 was ${gap === 0 ? 'today' : gap === 1 ? 'yesterday' : `${gap} days ago`}.</b>
      ${logs.length} logged in total${open ? ` · ${open} action${open === 1 ? '' : 's'} still open` : ''}.
      ${gap > 42 ? ' That is a long gap.' : ''}
    </div>
    <button class="btn sm primary" data-act="log">${icon('plus')}Log a 1:1</button>
  </div>

  ${raw(logs.map(o => {
    const m = moodOf(o.mood);
    const acts0 = o.actions || [];
    return `
    <section class="card" data-log="${o.id}" style="margin-bottom:14px">
      <header>
        <div style="flex:1">
          <h3>${esc(fmtDate(o.date, 'long'))}</h3>
          ${acts0.length ? `<div class="sub">${acts0.filter(a => a.done).length} of ${acts0.length} actions done</div>` : ''}
        </div>
        ${m ? `<span class="chip ${m.chip}">${esc(m.label)}</span>` : ''}
        <button class="btn icon sm subtle" data-act="log-menu" title="More">
          <svg class="ico"><use href="#i-dots"></use></svg></button>
      </header>
      <div class="body">
        ${!richIsEmpty(o.notes) ? `<div class="rich">${renderRich(o.notes)}</div>`
          : '<div class="tiny mute">No notes written.</div>'}
        ${acts0.length ? `<div class="sep" style="margin:12px 0"></div>
          <div class="tiny mute" style="margin-bottom:6px">Agreed actions</div>
          ${acts0.map((a, i) => `
            <label class="row pt-act" data-i="${i}">
              <input type="checkbox" data-act="act-done" ${a.done ? 'checked' : ''}>
              <span class="tiny" style="flex:1;${a.done ? 'text-decoration:line-through;opacity:.6' : ''}">${esc(a.t)}</span>
            </label>`).join('')}` : ''}
      </div>
    </section>`;
  }).join(''))}`;
}

/* ---------- dialogs ----------------------------------------------------- */

async function editGoal(personId, goalId) {
  const g = goalId ? S.byId(S.get().goals, goalId) : null;

  const res = await formDlg(g ? 'Edit goal' : 'New goal', [
    { k: 'title', label: 'Goal', span: 12, required: true, value: g ? goalTitle(g) : '',
      hint: 'For a development objective: something they will be able to do that they cannot do today.' },
    { k: 'category', label: 'Category', type: 'select', span: 6, value: g?.category || 'performance',
      opts: GOAL_CATEGORY.map(c => ({ v: c.id, t: c.label })) },
    { k: 'weight', label: 'Weight %', type: 'number', span: 6, value: g?.weight ?? '', min: 0, max: 100,
      hint: 'How much of the review this goal carries. The tab totals it and flags anything but 100%.' },
    { k: 'status', label: 'Status', type: 'select', span: 6, value: g ? goalStatus(g) : 'open',
      opts: GOAL_STATUS.map(s => ({ v: s.id, t: s.label })) },
    { k: 'due', label: 'Target date', type: 'date', span: 6, value: g?.due || '' },
    { k: 'notes', label: 'Notes', type: 'rich', rows: 6, span: 12, value: g?.notes || '',
      hint: 'Ctrl+B for bold, Tab for a bullet. Whatever context makes this goal make sense later.' },
  ], { ok: g ? 'Save' : 'Add goal', wide: true });
  if (!res) return false;

  const fields = { title: res.title, category: res.category,
                   weight: res.weight == null ? 0 : res.weight,
                   status: res.status, due: res.due, notes: res.notes, updated: Date.now() };

  S.mutate(st => {
    st.goals ||= [];
    if (g) {
      const t = S.byId(st.goals, goalId);
      Object.assign(t, fields);
      delete t.text; delete t.done;      // retire the old shape once it is edited
    } else {
      st.goals.push({ id: S.uid('gl'), personId, ...fields, milestones: [], created: Date.now() });
    }
  }, { label: g ? 'edit goal' : 'add goal' });
  return true;
}

async function editMilestone(goalId, index) {
  const g = S.byId(S.get().goals, goalId);
  if (!g) return false;
  const m = index == null ? null : (g.milestones || [])[index];

  const res = await formDlg(m ? 'Edit milestone' : 'Add milestone', [
    { k: 'text', label: 'Milestone', span: 12, required: true, value: m?.text || '' },
    { k: 'due', label: 'Due', type: 'date', span: 6, value: m?.due || '' },
  ], { ok: m ? 'Save' : 'Add' });
  if (!res) return false;

  S.mutate(st => {
    const gg = S.byId(st.goals, goalId);
    const list = (gg.milestones ||= []);
    if (m) Object.assign(list[index], { text: res.text, due: res.due });
    else list.push({ id: S.uid('gm'), text: res.text, due: res.due, done: false });
    gg.updated = Date.now();
  }, { label: 'goal milestone' });
  return true;
}

export async function logOneToOne(personId, logId) {
  const o = logId ? S.byId(S.get().oneToOnes, logId) : null;

  const res = await formDlg(o ? 'Edit 1:1' : 'Log a 1:1', [
    { k: 'date', label: 'Date', type: 'date', span: 6, value: o?.date || today(), required: true },
    { k: 'mood', label: 'How are they?', type: 'select', span: 6, value: o?.mood || 'neutral',
      opts: MOODS.map(m => ({ v: m.id, t: m.label })) },
    { k: 'notes', label: 'Notes', type: 'rich', rows: 8, span: 12, value: o?.notes || '',
      hint: 'Ctrl+B for bold, Tab for a bullet. What was discussed, what they raised, what you noticed.' },
    { k: 'actions', label: 'Agreed actions', type: 'textarea', rows: 3, span: 12,
      value: (o?.actions || []).map(a => a.t).join('\n'),
      hint: 'One per line. Each becomes a tick box that carries forward until it is done.' },
  ], { ok: o ? 'Save' : 'Log it', wide: true });
  if (!res) return false;

  /* The actions field is a list, not prose — take its text and split it. Using
     the rich editor here would fight the one-per-line contract. */
  const { richToText } = await import('./richtext.js');
  const lines = richToText(res.actions).split('\n').map(x => x.replace(/^[-*•\s]+/, '').trim()).filter(Boolean);

  S.mutate(st => {
    if (o) {
      const t = S.byId(st.oneToOnes, logId);
      const wasDone = new Map((t.actions || []).map(a => [a.t, a.done]));
      Object.assign(t, { date: res.date, mood: res.mood, notes: res.notes,
        // Keep a tick that has already been made, matched on the text.
        actions: lines.map(x => ({ t: x, done: !!wasDone.get(x) })) });
    } else {
      st.oneToOnes.push({ id: S.uid('oo'), personId, date: res.date, mood: res.mood,
        notes: res.notes, actions: lines.map(x => ({ t: x, done: false })) });
    }
  }, { label: o ? 'edit 1:1' : 'log 1:1' });
  return true;
}

/* ---------- the page ---------------------------------------------------- */

export function personPage(p, ctx, tab) {
  const body = tab === 'goals' ? goalsTab(p) : tab === 'oneone' ? oneOneTab(p) : overviewTab(p, ctx);
  // h`` returns a string, not a raw() object — there is no .html on either of these.
  return header(p, tab) + body;
}

/** Everything clickable on the page. Returned so views/people.js stays thin. */
export function personActions(p, ctx, tab, extra = {}) {
  const goTab = t => ctx.go('people', p.id, t);

  return {
    ...extra,
    tab: el => goTab(el.dataset.v),
    'go-goals': () => goTab('goals'),
    'go-oneone': () => goTab('oneone'),
    'go-leave': () => ctx.go('leave'),

    /* --- goals --- */
    'goal-add': () => editGoal(p.id, null).then(r => r && ctx.rerender()),
    'goal-menu': (el, ev) => {
      const gid = el.closest('[data-goal]').dataset.goal;
      const g = S.byId(S.get().goals, gid);
      menu(ev, [
        { label: 'Edit…', icon: 'edit', run: () => editGoal(p.id, gid).then(r => r && ctx.rerender()) },
        { label: 'Add milestone', icon: 'plus', run: () => editMilestone(gid, null).then(r => r && ctx.rerender()) },
        '-',
        ...GOAL_STATUS.filter(s => s.id !== goalStatus(g)).map(s => ({
          label: 'Mark ' + s.label.toLowerCase(), icon: 'check',
          run: () => { S.mutate(st => { const t = S.byId(st.goals, gid);
                         t.status = s.id; delete t.done; t.updated = Date.now(); }, { label: 'goal status' });
                       ctx.rerender(); },
        })),
        '-',
        { label: 'Delete goal', icon: 'trash', danger: true, run: async () => {
          if (!await confirmDlg(`Delete “${goalTitle(g)}”? Its notes and milestones go with it.`, { ok: 'Delete' })) return;
          S.remove('goals', gid);
          ctx.rerender();
        } },
      ]);
    },
    'ms-add': el => editMilestone(el.closest('[data-goal]').dataset.goal, null).then(r => r && ctx.rerender()),
    'ms-done': el => {
      const gid = el.closest('[data-goal]').dataset.goal;
      const i = Number(el.closest('[data-ms]').dataset.ms);
      S.mutate(st => { const g = S.byId(st.goals, gid);
                       g.milestones[i].done = el.checked; g.updated = Date.now(); }, { label: 'milestone' });
      ctx.rerender();
    },
    'ms-del': async el => {
      const gid = el.closest('[data-goal]').dataset.goal;
      const i = Number(el.closest('[data-ms]').dataset.ms);
      if (!await confirmDlg('Delete this milestone?', { ok: 'Delete' })) return;
      S.mutate(st => { const g = S.byId(st.goals, gid);
                       g.milestones.splice(i, 1); g.updated = Date.now(); }, { label: 'delete milestone' });
      ctx.rerender();
    },

    /* --- 1:1 --- */
    log: () => logOneToOne(p.id).then(r => r && ctx.rerender()),
    'log-menu': (el, ev) => {
      const id = el.closest('[data-log]').dataset.log;
      menu(ev, [
        { label: 'Edit…', icon: 'edit', run: () => logOneToOne(p.id, id).then(r => r && ctx.rerender()) },
        '-',
        { label: 'Delete', icon: 'trash', danger: true, run: async () => {
          if (!await confirmDlg('Delete this 1:1 note?', { ok: 'Delete' })) return;
          S.remove('oneToOnes', id); ctx.rerender();
        } },
      ]);
    },
    'act-done': el => {
      const id = el.closest('[data-log]').dataset.log;
      const i = Number(el.closest('[data-i]').dataset.i);
      S.mutate(st => { const o = S.byId(st.oneToOnes, id); o.actions[i].done = el.checked; }, { label: 'action' });
      ctx.rerender();
    },
  };
}
