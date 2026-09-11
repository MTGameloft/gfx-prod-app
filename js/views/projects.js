/* ============================================================================
   views/projects.js — Project Management: the portfolio, and one project.

   A project's detail is tabbed. Everything that used to be on one long page
   is still here — the same milestones table, the same risk list, the same
   allocation and spend panels, the same editors — but a project is now also
   where its tasks live, and stacking a board under all of that would have
   made both unreachable.

   The Tasks tab renders `taskui.js` scoped to this project, so it is the same
   board, list, column filters, drag-ordering and Jira selection as the global
   Tasks view. Nothing here is per-project code: add a project and it gets all
   of it, because the tab is generated from the project record like everything
   else on this page.
   ========================================================================= */

import * as S from '../store.js';
import {
  h, raw, esc, icon, toast, formDlg, confirmDlg, menu, acts, bar,
  fmtDate, fmtMonth, fmtMoney, fmtMoneyFull, fmtNum, fmtPct, today, daysBetween, sum, groupBy, clamp,
  download, toCsv,
} from '../ui.js';
import { projectHealth, ragColor, capacity, monthRange, thisMonth, projectFinance } from '../calc.js';
import { openExternal } from '../teams.js';
import { taskPanel, editTask } from '../taskui.js';
import { bulkQueueDialog } from '../jiraui.js';
import { divisionLabel } from '../jira.js';
import { scopesFor, loggedEstimates, wbComplexity, wbApproach, wbDivision } from '../wb.js';
import { buildScale, headBands, scalePrefs, scaleToggle, scaleAct, minScaleWidth } from '../timescale.js';
import { milestonePanel, wireMilestones, rangeOf, bounds as tlBounds } from '../timeline.js';

/**
 * Milestones shaped the way the shared timeline wants them.
 *
 * @param {object[]} list  projects to take milestones from
 */
const msItems = list => list.flatMap(p => (p.milestones || [])
  .filter(m => m.date)
  .map(m => ({ id: m.id, name: m.name, date: m.date, status: m.status,
               projectId: p.id, projectCode: p.code, projectName: p.name })));

/** Open task due dates, as pips along the axis. */
const msPips = ids => S.get().tasks
  .filter(t => t.status !== 'done' && t.due && (!ids || ids.has(t.project)))
  .map(t => ({ date: t.due, overdue: t.due < today(), title: t.title }));

/* The tabs a project has. Order is the tab order. */
const TABS = [
  { id: 'overview',   label: 'Overview' },
  { id: 'tasks',      label: 'Tasks' },
  { id: 'scopes',     label: 'Scopes' },
  { id: 'milestones', label: 'Milestones' },
  { id: 'risks',      label: 'Risks' },
  { id: 'team',       label: 'Team' },
];
const tabOf = v => TABS.find(t => t.id === v) ? v : 'overview';

const PHASES = ['Concept', 'Pre-production', 'Vertical Slice', 'Production', 'Alpha', 'Beta', 'Live Ops', 'Maintenance'];
const P_STATUS = ['discovery', 'production', 'live', 'paused', 'archived'];
const MS_STATUS = [
  { id: 'planned', label: 'Planned', chip: '' },
  { id: 'at-risk', label: 'At risk', chip: 'warn' },
  { id: 'done',    label: 'Done',    chip: 'ok' },
  { id: 'missed',  label: 'Missed',  chip: 'risk' },
];

/* ---------- portfolio ---------------------------------------------------- */

/**
 * The one thing Overview adds over the project cards: the totals.
 *
 * Same four-stat shape as the Dashboard, but every number is the sum across
 * projects rather than a single one — this is the "how is the portfolio doing"
 * row, and each tile is a way into the view that can do something about it.
 */
function portfolioKpis(live) {
  const s = S.get();
  const td = today();
  const ids = new Set(live.map(p => p.id));

  const open = s.tasks.filter(t => t.status !== 'done' && ids.has(t.project));
  const overdue = open.filter(t => t.due && t.due < td).length;

  const fin = projectFinance(null);

  const ms = live.flatMap(p => (p.milestones || []).map(m => ({ ...m, p })));
  const msOpen = ms.filter(m => m.status !== 'done');
  const msRisk = msOpen.filter(m => m.status === 'at-risk' || m.status === 'slipped').length;
  const next = msOpen.filter(m => m.date >= td).sort((a, b) => a.date.localeCompare(b.date))[0];

  const risks = live.flatMap(p => (p.risks || []).filter(r => r.status !== 'closed'));
  const bigRisks = risks.filter(r => r.impact === 'high').length;
  const offTrack = live.filter(p => p.health && p.health !== 'green').length;

  return h`<div class="grid g4" style="margin-bottom:14px">
    <div class="card stat" data-act="k-projects" style="cursor:pointer">
      <div class="k">Projects</div><div class="v">${live.length}</div>
      <div class="d ${offTrack ? 'down' : ''}">${offTrack ? `${offTrack} not green` : 'all green'}</div></div>

    <div class="card stat" data-act="k-tasks" style="cursor:pointer">
      <div class="k">Open tasks</div><div class="v">${open.length}</div>
      <div class="d ${overdue ? 'down' : ''}">${overdue} overdue across all projects</div></div>

    <div class="card stat" data-act="k-finance" style="cursor:pointer">
      <div class="k">Forecast vs budget</div>
      <div class="v" style="color:${fin.landing > 0 ? 'var(--risk)' : 'var(--text)'}">${fin.landing > 0 ? '+' : ''}${fmtMoney(fin.landing, symbol())}</div>
      <div class="d">${fmtMoney(fin.forecast, symbol())} landing on ${fmtMoney(fin.budget, symbol())}</div></div>

    <div class="card stat">
      <div class="k">Milestones ahead</div><div class="v">${msOpen.length}</div>
      <div class="d ${msRisk || bigRisks ? 'down' : ''}">${msRisk} at risk${bigRisks ? ` · ${bigRisks} high risk${bigRisks === 1 ? '' : 's'}` : ''}${next ? ` · next ${esc(fmtDate(next.date))}` : ''}</div></div>
  </div>`;
}
/* The other functions each take a local `sym` holding the string. This is the
   getter the KPI row uses, named apart so the two cannot be confused. */
const symbol = () => S.get().settings.currencySymbol || '$';

function portfolioCard(p) {
  const hl = projectHealth(p);
  const f = hl.finance;
  const t = hl.tasks;
  const sym = S.get().settings.currencySymbol;
  const nextMs = (p.milestones || []).filter(m => m.status !== 'done' && m.date >= today()).sort((a, b) => a.date.localeCompare(b.date))[0];
  const elapsed = clamp(daysBetween(p.start, today()) / Math.max(1, daysBetween(p.start, p.end)) * 100, 0, 100);

  return h`
  <section class="card" data-id="${p.id}" style="cursor:pointer" data-act="open">
    <header>
      <span style="width:10px;height:10px;border-radius:3px;background:${p.color};flex:none"></span>
      <div style="flex:1;min-width:0">
        <h3>${p.name}</h3>
        <div class="sub">${p.code} · ${p.phase} · ${p.status}</div>
      </div>
      <span class="chip" style="background:${ragColor(hl.rag)}22;color:${ragColor(hl.rag)}">${hl.rag === 'green' ? 'Healthy' : hl.rag === 'amber' ? 'Watch' : 'Trouble'}</span>
    </header>
    <div class="body">
      <div class="grid g2" style="gap:10px">
        <div>
          <div class="tiny mute">Schedule</div>
          ${bar(elapsed)}
          <div class="tiny mute" style="margin-top:3px">${fmtDate(p.start)} → ${fmtDate(p.end)} · ${Math.round(elapsed)}% elapsed</div>
        </div>
        <div>
          <div class="tiny mute">Budget burn</div>
          ${bar(f.burnPct, f.burnPct > 100 ? 'risk' : f.burnPct > 85 ? 'warn' : 'ok')}
          <div class="tiny mute" style="margin-top:3px">${fmtMoney(f.actualToDate, sym)} of ${fmtMoney(f.budget, sym)} · ${fmtPct(f.burnPct)}</div>
        </div>
      </div>
      <div class="sep" style="margin:12px 0"></div>
      <div class="row wrap tiny" style="gap:14px">
        <span class="mute">Tasks <b class="dim">${t.open}</b> open</span>
        ${raw(t.overdue ? `<span class="overdue">${t.overdue} overdue</span>` : '')}
        ${raw(hl.highRisk ? `<span class="overdue">${hl.highRisk} high risk${hl.highRisk > 1 ? 's' : ''}</span>` : '')}
        <span class="spacer" style="flex:1"></span>
        ${raw(nextMs ? `<span class="mute">Next: <b class="dim">${esc(nextMs.name)}</b> ${esc(fmtDate(nextMs.date))}</span>` : '<span class="mute">No upcoming milestone</span>')}
      </div>
    </div>
  </section>`;
}

/**
 * Task management across the portfolio, one row per project.
 *
 * The portfolio used to say only how much money and how many milestones. This
 * is the other half of running projects: where the work actually is, whether
 * any of it is stuck, and how much is waiting on Jira — with a way straight
 * into each project's own board rather than the global one filtered by hand.
 */
function taskBand(live) {
  const s = S.get();
  const td = today();

  const row = (p) => {
    const mine = s.tasks.filter(t => t.project === p.id);
    const open = mine.filter(t => t.status !== 'done');
    const late = open.filter(t => t.due && t.due < td).length;
    const blocked = open.filter(t => t.status === 'blocked').length;
    const soon = open.filter(t => t.due && t.due >= td && daysBetween(td, t.due) <= 7).length;
    const queued = mine.filter(t => t.jira?.state === 'queued').length;
    const filed = mine.filter(t => t.jira?.key).length;
    const done = mine.length - open.length;
    const pct = mine.length ? Math.round(done / mine.length * 100) : 0;

    return `<tr data-id="${p.id}" data-act="open-tasks" style="cursor:pointer">
      <td><span class="chip" style="background:${p.color}22;color:${p.color}">${esc(p.code)}</span></td>
      <td class="tiny"><b>${esc(p.name)}</b></td>
      <td style="width:150px">
        ${bar(pct, pct >= 80 ? 'ok' : '')}
        <div class="tiny mute" style="margin-top:2px">${done}/${mine.length} done</div></td>
      <td class="num">${open.length}</td>
      <td class="num ${late ? 'overdue' : 'mute'}">${late || '—'}</td>
      <td class="num ${soon ? '' : 'mute'}">${soon || '—'}</td>
      <td class="num ${blocked ? 'overdue' : 'mute'}">${blocked || '—'}</td>
      <td class="num ${queued ? '' : 'mute'}">${queued || '—'}</td>
      <td class="num mute">${filed || '—'}</td>
      <td class="act"><button class="btn sm subtle" data-act="open-tasks">Board →</button></td>
    </tr>`;
  };

  const unassigned = s.tasks.filter(t => !t.project && t.status !== 'done').length;

  return h`
  <section class="card" style="margin-bottom:14px">
    <header><h3>Task management</h3><span class="sub">every project, and where its work stands</span>
      <div class="spacer" style="flex:1"></div>
      ${raw(unassigned ? `<button class="btn sm subtle" data-act="k-tasks">${unassigned} with no project →</button>` : '')}
      <button class="btn sm subtle" data-act="k-tasks">All tasks →</button></header>
    <div class="body flush"><table class="tbl">
      <thead><tr>
        <th style="width:70px">Code</th><th>Project</th><th>Progress</th>
        <th class="num">Open</th><th class="num">Overdue</th><th class="num">Due 7d</th>
        <th class="num">Blocked</th><th class="num">Queued</th><th class="num">In Jira</th><th></th>
      </tr></thead>
      <tbody>${raw(live.map(row).join('') ||
        '<tr><td colspan="10" class="tiny mute" style="padding:16px">No live projects.</td></tr>')}</tbody>
    </table></div>
  </section>`;
}

/** One row per project, milestones as diamonds, across the coming 12 months. */
/**
 * Project spans as bars, milestones as diamonds.
 *
 * The window is whatever the Overview's range buttons say, rather than a
 * hardcoded twelve months — so the range control governs both this and the
 * milestone timeline above it, and the two always show the same stretch of
 * time. Which is the point of having them on one page.
 */
function timeline() {
  const s = S.get();
  const b = tlBounds(rangeOf('portfolio'));
  const first = b.from, last = b.to;
  const months = monthRange(first, last);
  const span = Math.max(1, daysBetween(first, last));
  const pos = iso => clamp(daysBetween(first, iso) / span * 100, 0, 100);

  const rows = s.projects.filter(p => p.status !== 'archived').map(p => {
    const l = Math.max(0, pos(p.start)), r = Math.min(100, pos(p.end));
    const ms = (p.milestones || []).filter(m => m.date >= first && m.date <= last).map(m => `
      <span class="milestone-dot" style="left:${pos(m.date)}%;background:${m.status === 'done' ? 'var(--ok)' : m.status === 'at-risk' ? 'var(--risk)' : 'var(--warn)'}"
            title="${esc(m.name)} — ${esc(fmtDate(m.date, 'long'))}"></span>`).join('');
    return `<div class="gantt-row">
      <div class="lbl trunc" title="${esc(p.name)}"><b>${esc(p.code)}</b> <span class="mute">${esc(p.name)}</span></div>
      <div class="track">
        ${months.map((_, i) => `<span class="gl" style="left:${(i / months.length) * 100}%"></span>`).join('')}
        <div class="gantt-bar" style="left:${l}%;width:${Math.max(2, r - l)}%;background:${p.color}"
             title="${esc(p.phase)}">${esc(p.phase)}</div>
        ${ms}
      </div></div>`;
  }).join('');

  /*
   * The scale is the shared one, so a date here means the same thing as a date
   * on the Leave grid. With the date band on, a year is 365 columns — so the
   * grid is given a minimum width and the panel scrolls, rather than squashing
   * 365 unreadable slivers into the width of the card.
   */
  const scale = buildScale(first, last);
  const show = scalePrefs('portfolio');
  const minW = Math.max(760, 190 + minScaleWidth(scale, show));

  return h`
  <section class="card">
    <header><h3>Project spans</h3><span class="sub">${rangeOf('portfolio')} window · ◆ milestones</span>
      <div class="spacer" style="flex:1"></div>
      ${raw(scaleToggle('portfolio'))}</header>
    <div class="body flush gantt"><div class="gantt-grid" style="min-width:${minW}px">
      <div class="gantt-head">
        <div class="lbl">Project</div>
        <div class="cells">${raw(headBands(scale, show, { width: minW - 190 }))}</div>
      </div>
      <div style="position:relative">
        <div class="gantt-today" style="left:calc(190px + (100% - 190px) * ${pos(today()) / 100})" title="Today"></div>
        ${raw(rows)}
      </div>
    </div></div>
  </section>`;
}
const addM = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const lastDay = ym => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };

/* ---------- detail ------------------------------------------------------- */

/** The bar that is the same on every tab: who this project is, and the tabs. */
function projHeader(p, hl, tab) {
  const s = S.get();
  const open = s.tasks.filter(t => t.project === p.id && t.status !== 'done');
  const counts = {
    tasks: open.length,
    scopes: scopesFor(p.id).length,
    milestones: (p.milestones || []).filter(m => m.status !== 'done').length,
    risks: (p.risks || []).filter(r => r.status !== 'closed').length,
    team: new Set(s.people.filter(x => (x.alloc || []).some(a => a.projectId === p.id)).map(x => x.id)).size,
  };
  const hot = { tasks: open.filter(t => t.due && t.due < today()).length,
                risks: (p.risks || []).filter(r => r.status !== 'closed' && r.impact === 'high').length };

  return h`
  <div class="row" style="margin-bottom:12px">
    <button class="btn subtle sm" data-act="back">← Portfolio</button>
    <span style="width:11px;height:11px;border-radius:3px;background:${p.color}"></span>
    <h2 style="font-size:19px">${p.name}</h2>
    <span class="chip">${p.code}</span>
    <span class="chip" style="background:${ragColor(hl.rag)}22;color:${ragColor(hl.rag)}">health ${hl.score}</span>
    <span class="chip">${p.phase}</span>
    <div class="spacer" style="flex:1"></div>
    ${raw(p.sharepointUrl ? `<button class="btn sm subtle" data-act="sp"><svg class="ico"><use href="#i-cloud"></use></svg>SharePoint</button>` : '')}
    <button class="btn sm subtle" data-act="finance">Finance →</button>
    <button class="btn sm subtle" data-act="edit">${icon('edit')}Edit</button>
  </div>

  <div class="ptabs">${raw(TABS.map(t => {
    const n = counts[t.id];
    return `<button class="ptab${t.id === tab ? ' on' : ''}" data-act="tab" data-t="${t.id}">
      ${esc(t.label)}${n ? `<span class="ptab-n${hot[t.id] ? ' hot' : ''}">${n}</span>` : ''}
    </button>`;
  }).join(''))}</div>`;
}

/* ---------- tabs --------------------------------------------------------- */

/**
 * For a project that IS a division's work — GFX Prod — what that division is
 * doing everywhere else.
 *
 * A task has a project AND a division, and they are different axes. GFX Prod
 * as a project holds the production work that belongs to no single game;
 * GFX Prod as a division is the lane that feedback, QA and documentation sit
 * in on Skylark and Harbour Tales too. Neither owns the other, so this reads
 * across rather than trying to move anything: the tasks stay on the game they
 * belong to and appear here as well.
 *
 * Returns '' for an ordinary project, so the panel costs nothing when the
 * project is not tied to a division.
 */
function tabLinked(p) {
  if (!p.divisionId) return '';
  const s = S.get();
  const d = S.byId(s.divisions, p.divisionId);
  if (!d) return '';
  const sym = s.settings.currencySymbol || '$';

  /* Elsewhere: this division's tasks that live on another project. */
  const away = s.tasks.filter(t => t.division === p.divisionId && t.project && t.project !== p.id);
  const openAway = away.filter(t => t.status !== 'done');
  const byProj = groupBy(openAway, t => t.project);

  /* Ordered: every signed scope's lines in this division, read from the frozen
     snapshot — what was committed, not what it would cost today. */
  let hours = 0, cost = 0, scopeCount = 0;
  for (const e of loggedEstimates(s)) {
    const mine = (e.logged.lines || []).filter(l => l.division === p.divisionId);
    if (!mine.length) continue;
    scopeCount++;
    for (const l of mine) { hours += l.hours || 0; cost += l.cost || 0; }
  }

  const heads = s.people.filter(x => x.active !== false && x.division === p.divisionId).length;
  const label = divisionLabel(p.divisionId, s);

  return h`
  <section class="card" style="margin-bottom:14px">
    <header>
      <span class="pill-div" style="background:${esc(d.color || 'var(--muted)')}">${esc(d.id)}</span>
      <h3>${esc(d.name)} across the portfolio</h3>
      <span class="sub">this project is the ${esc(d.name)} division's own work</span>
      <div class="spacer" style="flex:1"></div>
      <button class="btn sm subtle" data-act="go-team">Team →</button>
    </header>
    <div class="body">
      <div class="row wrap tiny" style="gap:20px;margin-bottom:2px">
        <span><b class="dim" style="font-size:17px">${openAway.length}</b> open task${openAway.length === 1 ? '' : 's'} on other projects</span>
        <span><b class="dim" style="font-size:17px">${fmtNum(Math.round(hours))}</b> hours ordered through GFX WB</span>
        <span><b class="dim" style="font-size:17px">${fmtMoney(cost, sym)}</b> committed across ${scopeCount} scope${scopeCount === 1 ? '' : 's'}</span>
        <span><b class="dim" style="font-size:17px">${heads}</b> ${heads === 1 ? 'person' : 'people'} in the division</span>
      </div>
      <div class="tiny mute" style="margin-top:8px;line-height:1.7">
        A task carries a project <i>and</i> a division, and these are the two different
        questions. Tasks below belong to the game they are filed against — they are shown
        here because they are ${esc(d.name)} work${raw(label
          ? `, and they file into Jira with the <code>${esc(label)}</code> label` : '')}.
      </div>
    </div>
    ${raw(openAway.length ? `<div class="body flush"><table class="tbl">
      <tbody>${Object.keys(byProj).map(pid => {
        const other = S.byId(s.projects, pid);
        const list = byProj[pid].slice().sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
        return list.slice(0, 6).map((t, i) => `<tr data-t="${esc(t.id)}">
          <td style="width:1%">${i === 0 && other
            ? `<span class="chip" style="background:${other.color}22;color:${other.color}">${esc(other.code)}</span>`
            : ''}</td>
          <td><b>${esc(t.title)}</b>
            ${t.due ? `<div class="tiny ${t.due < today() ? 'overdue' : 'mute'}">due ${esc(fmtDate(t.due, 'long'))} · ${esc(rel(t.due))}</div>` : ''}</td>
          <td class="tiny mute nowrap" style="width:110px">${esc(t.assignee ? S.personName(t.assignee) : 'unassigned')}</td>
          <td class="tiny mute nowrap" style="width:70px">${esc(t.status)}</td>
          <td class="act" style="width:1%"><button class="btn sm subtle" data-act="linked-open">Open</button></td>
        </tr>`).join('') + (list.length > 6
          ? `<tr><td></td><td class="tiny mute" colspan="4">+ ${list.length - 6} more on ${esc(other?.code || pid)}</td></tr>`
          : '');
      }).join('')}</tbody></table></div>` : `<div class="body" style="padding-top:0">
      <div class="tiny mute">No ${esc(d.name)} tasks on the other projects right now.</div></div>`)}
  </section>`;
}

function tabOverview(p) {
  const s = S.get();
  const hl = projectHealth(p);
  const f = hl.finance;
  const sym = s.settings.currencySymbol;
  const cap = capacity(thisMonth(), { projectId: p.id });
  const elapsed = clamp(daysBetween(p.start, today()) / Math.max(1, daysBetween(p.start, p.end)) * 100, 0, 100);

  const msNext = (p.milestones || []).filter(m => m.status !== 'done')
    .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 4);
  const risks = (p.risks || []).filter(r => r.status !== 'closed')
    .sort((a, b) => sev(b) - sev(a)).slice(0, 3);
  const queued = s.tasks.filter(t => t.project === p.id && t.jira?.state === 'queued').length;
  const filed  = s.tasks.filter(t => t.project === p.id && t.jira?.key).length;

  /* The same timeline as the dashboard and the portfolio, narrowed to this
     project — its own remembered range and scale, because a project you are
     about to ship is a different question from the portfolio. */
  const tl = milestonePanel({
    title: 'Milestones',
    sub: p.code,
    items: msItems([p]),
    pips: msPips(new Set([p.id])),
    key: `proj:${p.id}`,
    emptyMsg: 'No milestones in this window. Widen the range, or add one on the Milestones tab.',
    extra: '<button class="btn sm subtle" data-act="tab" data-t="milestones">Manage →</button>',
  });

  return h`
  ${raw(p.description ? `<p class="dim" style="max-width:70ch;margin-bottom:14px">${esc(p.description)}</p>` : '')}
  ${raw(tabLinked(p))}

  <div class="grid g4" style="margin-bottom:14px">
    <div class="card stat"><div class="k">Budget</div><div class="v">${fmtMoney(f.budget, sym)}</div>
      <div class="d">${fmtMoneyFull(f.actualToDate, sym)} spent to date</div></div>
    <div class="card stat"><div class="k">Forecast landing</div><div class="v">${fmtMoney(f.forecast, sym)}</div>
      <div class="d ${f.landing > 0 ? 'down' : 'up'}">${f.landing > 0 ? 'over' : 'under'} by ${fmtMoney(Math.abs(f.landing), sym)} (${fmtPct(Math.abs(f.landingPct), 1)})</div></div>
    <div class="card stat" data-act="tab" data-t="tasks" style="cursor:pointer">
      <div class="k">Open tasks</div><div class="v">${hl.tasks.open}</div>
      <div class="d ${hl.tasks.overdue ? 'down' : ''}">${hl.tasks.overdue} overdue · ${hl.tasks.blocked} blocked</div></div>
    <div class="card stat" data-act="tab" data-t="team" style="cursor:pointer">
      <div class="k">Team this month</div><div class="v">${cap.net.toFixed(0)}<span style="font-size:14px;font-weight:400"> days</span></div>
      <div class="d">${cap.rows.length} people · ${cap.lost.toFixed(1)} days lost to leave</div></div>
  </div>

  <div class="grid g2" style="margin-bottom:14px">
    <section class="card"><div class="body">
      <div class="tiny mute">Schedule</div>
      ${raw(bar(elapsed))}
      <div class="tiny mute" style="margin-top:3px">${fmtDate(p.start)} → ${fmtDate(p.end)} · ${Math.round(elapsed)}% elapsed</div>
      <div class="sep" style="margin:12px 0"></div>
      <div class="tiny mute">Budget burn</div>
      ${raw(bar(f.burnPct, f.burnPct > 100 ? 'risk' : f.burnPct > 85 ? 'warn' : 'ok'))}
      <div class="tiny mute" style="margin-top:3px">${fmtMoney(f.actualToDate, sym)} of ${fmtMoney(f.budget, sym)} · ${fmtPct(f.burnPct)}</div>
    </div></section>

    <section class="card">
      <header><h3>Jira</h3><span class="sub">for this project</span>
        <div class="spacer" style="flex:1"></div>
        <button class="btn sm subtle" data-act="jira">Queue →</button></header>
      <div class="body">
        <div class="row wrap tiny" style="gap:16px">
          <span><b class="dim" style="font-size:17px">${filed}</b> filed</span>
          <span class="${queued ? 'overdue' : 'mute'}"><b style="font-size:17px">${queued}</b> waiting to be filed</span>
        </div>
        <div class="tiny mute" style="margin-top:8px;line-height:1.6">
          Select tasks on the Tasks tab and queue them in one go. Labels come from
          each task's division, so nothing is retyped.
        </div>
        <div style="margin-top:10px"><button class="btn sm subtle" data-act="imports">Import history →</button></div>
      </div>
    </section>
  </div>

  <div style="margin-bottom:14px">${raw(tl)}</div>

  <div class="grid" style="grid-template-columns:1.35fr 1fr">
    <section class="card">
      <header><h3>Next milestones</h3>
        <div class="spacer" style="flex:1"></div>
        <button class="btn sm subtle" data-act="tab" data-t="milestones">All →</button></header>
      <div class="body flush"><table class="tbl"><tbody>${raw(msNext.length ? msNext.map(m => {
        const st = MS_STATUS.find(x => x.id === m.status) || MS_STATUS[0];
        const late = m.date < today();
        return `<tr>
          <td style="width:1%"><span class="chip ${late ? 'risk' : st.chip}">${late ? 'Late' : esc(st.label)}</span></td>
          <td><b>${esc(m.name)}</b>${m.owner ? `<div class="tiny mute">${esc(S.personName(m.owner))}</div>` : ''}</td>
          <td class="tiny nowrap">${esc(fmtDate(m.date, 'long'))}</td>
          <td class="tiny mute nowrap">${esc(rel(m.date))}</td></tr>`;
      }).join('') : '<tr><td class="tiny mute" style="padding:20px;text-align:center">Nothing scheduled.</td></tr>')}</tbody></table></div>
    </section>

    <section class="card">
      <header><h3>Top risks</h3>
        <div class="spacer" style="flex:1"></div>
        <button class="btn sm subtle" data-act="tab" data-t="risks">All →</button></header>
      <div class="body" style="display:flex;flex-direction:column;gap:10px">
        ${raw(risks.length ? risks.map(r => `
          <div style="border-left:3px solid ${sev(r) >= 4 ? 'var(--risk)' : sev(r) >= 2 ? 'var(--warn)' : 'var(--muted)'};padding-left:10px">
            <div style="font-weight:600;font-size:13px">${esc(r.text)}</div>
            <div class="tiny mute" style="margin-top:2px">${esc(r.impact)} impact · ${esc(r.likelihood)} likelihood</div>
          </div>`).join('') : '<div class="tiny mute">No open risks. That is itself worth a moment\'s thought.</div>')}
      </div>
    </section>
  </div>

  <section class="card" style="margin-top:14px">
    <header><h3>Spend by category</h3>
      <div class="spacer" style="flex:1"></div>
      <button class="btn sm subtle" data-act="finance">Open in Finance →</button></header>
    <div class="body">
      ${raw(f.byCategory.map(c => `
        <div style="margin-bottom:9px">
          <div class="row tiny" style="margin-bottom:3px">
            <span style="flex:1">${esc(c.label)}</span>
            <span class="mute">${fmtMoneyFull(c.actual, sym)} / ${fmtMoneyFull(c.planned, sym)}</span>
          </div>
          <span class="bar"><i style="width:${clamp(c.planned ? c.actual / c.planned * 100 : 0, 0, 100)}%;background:${c.color}"></i></span>
        </div>`).join('') || '<div class="tiny mute">No budget lines for this project yet.</div>')}
    </div>
  </section>`;
}

/**
 * Everything logged against this project through GFX WB.
 *
 * Read entirely from each scope's frozen snapshot, never recomputed — what was
 * ordered in September has to keep reading as it did, whatever the rate card
 * says now. Each scope's task is the thing that goes to Jira, and its
 * checklist is the breakdown, so queueing one scope files one issue with a
 * sub-task per work item.
 */
function tabScopes(p) {
  const s = S.get();
  const scopes = scopesFor(p.id);
  const sym = s.settings.currencySymbol || '$';
  const n1 = x => (Number.isFinite(x) ? Math.round(x * 10) / 10 : 0).toLocaleString();

  if (!scopes.length) {
    return h`<div class="card"><div class="empty">
      <h4>Nothing logged against ${esc(p.code)} yet</h4>
      <div class="tiny" style="max-width:64ch;margin:0 auto;line-height:1.7">
        Build a work breakdown in <b>Workspace → GFX WB</b>, set its project to
        ${esc(p.name)}, and log it. Logged scope appears here with what each work
        item cost and when it was ordered, and can be queued into Jira from this
        tab as one issue with a sub-task per item.
      </div>
      <div style="margin-top:12px"><button class="btn primary sm" data-act="go-wb">
        ${icon('chart')}Open GFX WB</button></div>
    </div></div>`;
  }

  const totalCost = scopes.reduce((n, e) => n + (e.logged.cost || 0), 0);
  const totalHours = scopes.reduce((n, e) => n + (e.logged.hours || 0), 0);
  const totalItems = scopes.reduce((n, e) => n + (e.logged.lines || []).length, 0);
  const tasks = scopes.map(e => S.byId(s.tasks, e.logged.taskId)).filter(Boolean);
  const inJira = tasks.filter(t => t.jira?.key).length;
  const queueable = tasks.filter(t => !t.jira?.key);
  const budget = Number(p.budget) || 0;

  /* Cost per division across every scope — where the money actually goes. */
  const byDiv = new Map();
  for (const e of scopes) {
    for (const l of (e.logged.lines || [])) {
      const cur = byDiv.get(l.division) || { division: l.division, hours: 0, cost: 0, items: 0 };
      cur.hours += l.hours || 0; cur.cost += l.cost || 0; cur.items++;
      byDiv.set(l.division, cur);
    }
  }
  const divRows = [...byDiv.values()].sort((a, b) => b.cost - a.cost);

  return h`
  <div class="grid g4" style="margin-bottom:14px">
    <div class="card stat"><div class="k">Logged scopes</div><div class="v">${scopes.length}</div>
      <div class="d">${totalItems} work items ordered</div></div>
    <div class="card stat"><div class="k">Committed cost</div><div class="v">${fmtMoney(totalCost, sym)}</div>
      <div class="d ${budget && totalCost > budget ? 'down' : ''}">${budget
        ? `${fmtPct(totalCost / budget * 100)} of the ${fmtMoney(budget, sym)} budget`
        : 'no budget set on this project'}</div></div>
    <div class="card stat"><div class="k">Committed effort</div><div class="v">${n1(totalHours)}<span style="font-size:14px;font-weight:400">h</span></div>
      <div class="d">${n1(totalHours / (s.settings.hoursPerDay || 8))} person-days</div></div>
    <div class="card stat"><div class="k">In Jira</div><div class="v">${inJira}<span style="font-size:14px;font-weight:400"> of ${scopes.length}</span></div>
      <div class="d">${queueable.length ? `${queueable.length} not filed yet` : 'all filed'}</div></div>
  </div>

  <div class="toolbar">
    <span class="tiny mute">Every figure frozen at the moment the scope was logged.</span>
    <div class="spacer"></div>
    ${raw(queueable.length ? `<button class="btn sm primary" data-act="scope-jira-all">
      ${icon('link')}Queue ${queueable.length} scope${queueable.length === 1 ? '' : 's'} for Jira</button>` : '')}
    <button class="btn sm subtle" data-act="scope-csv">${icon('down')}CSV</button>
    <button class="btn sm subtle" data-act="go-wb">GFX WB →</button>
  </div>

  ${raw(divRows.length ? `
  <section class="card" style="margin-bottom:14px">
    <header><h3>Ordered by division</h3><span class="sub">across every logged scope</span></header>
    <div class="body">
      ${divRows.map(d => {
        const div = S.byId(s.divisions, d.division);
        const share = totalCost ? (d.cost / totalCost) * 100 : 0;
        return `<div style="margin-bottom:10px">
          <div class="row tiny" style="margin-bottom:3px">
            <span class="pill-div" style="background:${div?.color || 'var(--muted)'}">${esc(d.division)}</span>
            <span style="flex:1;margin-left:7px">${esc(div?.name || wbDivision(d.division).label)}</span>
            <span class="mute">${d.items} items · ${n1(d.hours)}h · ${fmtMoneyFull(d.cost, sym)} · ${Math.round(share)}%</span>
          </div>
          ${bar(share)}
        </div>`;
      }).join('')}
    </div>
  </section>` : '')}

  ${raw(scopes.map(e => {
    const lg = e.logged;
    const task = S.byId(s.tasks, lg.taskId);
    const cl = task?.checklist || [];
    const doneN = cl.filter(x => x.done).length;
    return `<section class="card" style="margin-bottom:12px" data-e="${e.id}">
      <header>
        <h3>${esc(e.name)}</h3>
        <span class="sub">ordered ${esc(fmtDate(new Date(lg.at).toISOString().slice(0, 10), 'long'))}
          · ${(lg.lines || []).length} items · ${n1(lg.hours)}h
          · <b>${esc(fmtMoneyFull(lg.cost, sym))}</b></span>
        <div class="spacer" style="flex:1"></div>
        ${task?.jira?.key
          ? `<span class="chip ok" data-act="scope-open-jira" style="cursor:pointer">${esc(task.jira.key)}</span>`
          : task?.jira?.state === 'queued' ? '<span class="chip warn">queued for Jira</span>'
          : task ? '<button class="btn sm subtle" data-act="scope-jira">' + icon('link') + 'Queue for Jira</button>' : ''}
        ${task ? `<button class="btn sm subtle" data-act="scope-task">${cl.length ? `${doneN}/${cl.length} done` : 'Open task'}</button>` : '<span class="chip risk">task deleted</span>'}
        <button class="btn icon sm subtle" data-act="scope-menu"><svg class="ico"><use href="#i-dots"></use></svg></button>
      </header>
      <div class="body flush"><table class="tbl">
        <thead><tr><th style="width:60px">Div</th><th>Work item</th><th class="num" style="width:60px">Qty</th>
          <th style="width:100px">Complexity</th><th style="width:110px">Approach</th>
          <th class="num" style="width:74px">Hours</th><th style="width:120px">Costed at</th>
          <th class="num" style="width:96px">Cost</th></tr></thead>
        <tbody>${(lg.lines || []).map(l => {
          const div = S.byId(s.divisions, l.division);
          return `<tr>
            <td><span class="pill-div" style="background:${div?.color || 'var(--muted)'}">${esc(l.division)}</span></td>
            <td><b>${esc(l.name)}</b></td>
            <td class="num">${l.qty}</td>
            <td class="tiny mute">${esc(wbComplexity(l.complexity).label)}</td>
            <td class="tiny mute">${esc(wbApproach(l.approach).label)}</td>
            <td class="num">${n1(l.hours)}</td>
            <td class="tiny">${esc(l.seniority)} <span class="mute">${esc(fmtMoneyFull(l.rate, sym))}/h</span></td>
            <td class="num">${esc(fmtMoneyFull(l.cost, sym))}</td></tr>`;
        }).join('')}</tbody>
        <tfoot><tr>
          <td colspan="5" class="tiny mute" style="text-align:right">including ${lg.reviewPct}% review + ${lg.contPct}% contingency</td>
          <td class="num"><b>${n1(lg.hours)}</b></td><td></td>
          <td class="num"><b>${esc(fmtMoneyFull(lg.cost, sym))}</b></td></tr></tfoot>
      </table></div>
    </section>`;
  }).join(''))}`;
}

function tabMilestones(p) {
  const ms = (p.milestones || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  return h`
  <section class="card">
    <header><h3>Milestones</h3><span class="sub">${ms.length} in total</span>
      <div class="spacer" style="flex:1"></div>
      <button class="btn sm subtle" data-act="ms-add">${icon('plus')}Add</button></header>
    <div class="body flush"><table class="tbl">
      <tbody>${raw(ms.length ? ms.map(m => {
        const st = MS_STATUS.find(x => x.id === m.status) || MS_STATUS[0];
        const late = m.status !== 'done' && m.date < today();
        return `<tr data-ms="${m.id}">
          <td style="width:1%"><span class="chip ${late ? 'risk' : st.chip}">${late ? 'Late' : esc(st.label)}</span></td>
          <td><b>${esc(m.name)}</b>${m.owner ? `<div class="tiny mute">${esc(S.personName(m.owner))}</div>` : ''}</td>
          <td class="tiny nowrap">${esc(fmtDate(m.date, 'long'))}</td>
          <td class="tiny mute nowrap">${esc(rel(m.date))}</td>
          <td class="act"><button class="btn icon sm subtle" data-act="ms-menu"><svg class="ico"><use href="#i-dots"></use></svg></button></td>
        </tr>`;
      }).join('') : '<tr><td class="tiny mute" style="padding:20px;text-align:center">No milestones yet.</td></tr>')}</tbody>
    </table></div>
  </section>`;
}

function tabRisks(p) {
  const risks = (p.risks || []).slice().sort((a, b) => sev(b) - sev(a));
  return h`
  <section class="card">
    <header><h3>Risks</h3><span class="sub">${risks.filter(r => r.status !== 'closed').length} open</span>
      <div class="spacer" style="flex:1"></div>
      <button class="btn sm subtle" data-act="risk-add">${icon('plus')}Add</button></header>
    <div class="body" style="display:flex;flex-direction:column;gap:10px">
      ${raw(risks.length ? risks.map(r => `
        <div data-risk="${r.id}" style="border-left:3px solid ${r.status === 'closed' ? 'var(--line)' : sev(r) >= 4 ? 'var(--risk)' : sev(r) >= 2 ? 'var(--warn)' : 'var(--muted)'};padding-left:10px">
          <div class="row" style="align-items:flex-start">
            <div style="flex:1">
              <div style="font-weight:600;font-size:13px">${esc(r.text)}</div>
              <div class="tiny mute" style="margin-top:2px">${esc(r.impact)} impact · ${esc(r.likelihood)} likelihood · ${esc(r.status)}${r.owner ? ' · ' + esc(S.personName(r.owner)) : ''}</div>
              ${r.mitigation ? `<div class="tiny" style="margin-top:4px">↳ ${esc(r.mitigation)}</div>` : ''}
            </div>
            <button class="btn icon sm subtle" data-act="risk-menu"><svg class="ico"><use href="#i-dots"></use></svg></button>
          </div>
        </div>`).join('') : '<div class="tiny mute">No risks logged. That is itself worth a moment\'s thought.</div>')}
    </div>
  </section>`;
}

function tabTeam(p) {
  const s = S.get();
  const cap = capacity(thisMonth(), { projectId: p.id });
  const divs = groupBy(cap.rows, r => r.person.division);
  return h`
  <section class="card">
    <header><h3>Who is on this project</h3><span class="sub">this month, after leave</span></header>
    <div class="body flush"><table class="tbl">
      <thead><tr><th>Division</th><th>People</th><th class="num">Allocated</th><th class="num">Available days</th></tr></thead>
      <tbody>${raw(Object.entries(divs).map(([d, rows]) => {
        const div = S.byId(s.divisions, d);
        return `<tr>
          <td><span class="pill-div" style="background:${div?.color || 'var(--muted)'}">${esc(d)}</span></td>
          <td class="tiny">${rows.map(r => esc(r.person.name) + ` <span class="mute">${Math.round(r.share * 100)}%</span>`).join(', ')}</td>
          <td class="num">${rows.length}</td>
          <td class="num">${sum(rows, r => r.net).toFixed(1)}</td></tr>`;
      }).join('') || '<tr><td colspan="4" class="tiny mute" style="padding:16px">Nobody is allocated to this project.</td></tr>')}</tbody>
    </table></div>
  </section>`;
}

const sev = r => (r.status === 'closed' ? -1 :
  ({ high: 3, medium: 2, low: 1 }[r.impact] || 1) * ({ high: 1.6, medium: 1, low: .6 }[r.likelihood] || 1));
const rel = iso => { const n = daysBetween(today(), iso); return n === 0 ? 'today' : n < 0 ? `${-n}d ago` : `in ${n}d`; };

/* ---------- editors ------------------------------------------------------ */

async function editProject(id) {
  const s = S.get();
  const p = id ? S.byId(s.projects, id) : null;
  const v = p || { name: '', code: '', phase: 'Production', status: 'production', start: today(),
                   end: '', budget: 0, color: '#4C9AFF', description: '', jiraKey: '', jiraEpic: '', sharepointUrl: '',
                   divisionId: '',
                   producerLead: s.people.find(x => x.isMe)?.id || '', milestones: [], risks: [] };
  const res = await formDlg(p ? 'Edit project' : 'New project', [
    { k: 'name', label: 'Name', value: v.name, required: true, span: 8 },
    { k: 'code', label: 'Short code', value: v.code, span: 4, hint: 'Shown on task cards' },
    { k: 'phase', label: 'Phase', type: 'select', value: v.phase, span: 6, opts: PHASES.map(x => ({ v: x, t: x })) },
    { k: 'status', label: 'Status', type: 'select', value: v.status, span: 6, opts: P_STATUS.map(x => ({ v: x, t: x })) },
    { k: 'start', label: 'Start', type: 'date', value: v.start, span: 4 },
    { k: 'end', label: 'End', type: 'date', value: v.end, span: 4 },
    { k: 'color', label: 'Colour', type: 'color', value: v.color, span: 4 },
    { k: 'budget', label: 'Approved budget', type: 'number', value: v.budget, span: 12, min: 0 },
    { k: 'jiraKey', label: 'Jira project key', value: v.jiraKey, span: 6,
      hint: 'The Jira project key, as set up in Settings → Integrations. It decides the component and epic a task is filed with.' },
    { k: 'jiraEpic', label: 'Jira epic for this project', value: v.jiraEpic || '', span: 6,
      hint: 'Blank uses the Jira project\'s GFX epic. Set it to file this project\'s tasks under a different one.' },
    { k: 'divisionId', label: 'Tied to a division', type: 'select', value: v.divisionId || '', span: 12,
      opts: [{ v: '', t: 'No — this project spans every division' },
             ...s.divisions.map(d => ({ v: d.id, t: `${d.id} — ${d.name}` }))],
      hint: 'For a project that IS a division\'s own work, like GFX Prod. Its Overview then also lists that '
          + 'division\'s tasks sitting on the other projects.' },
    { k: 'sharepointUrl', label: 'SharePoint folder URL', type: 'url', value: v.sharepointUrl, span: 12,
      hint: 'Paste the browser URL of the project art folder. Used by the Files view.' },
    { k: 'description', label: 'Description', type: 'textarea', value: v.description, span: 12, rows: 2 },
  ], { ok: p ? 'Save' : 'Create', wide: true });
  if (!res) return false;
  if (p) S.update('projects', id, res);
  else S.add('projects', { ...v, ...res });
  toast('Project saved', 'ok');
  return true;
}

async function editMilestone(pid, mid) {
  const p = S.byId(S.get().projects, pid);
  const m = mid ? p.milestones.find(x => x.id === mid) : null;
  const res = await formDlg(m ? 'Edit milestone' : 'New milestone', [
    { k: 'name', label: 'Milestone', value: m?.name || '', required: true, span: 12 },
    { k: 'date', label: 'Date', type: 'date', value: m?.date || today(), span: 6, required: true },
    { k: 'status', label: 'Status', type: 'select', value: m?.status || 'planned', span: 6, opts: MS_STATUS.map(x => ({ v: x.id, t: x.label })) },
    { k: 'owner', label: 'Owner', type: 'select', value: m?.owner || '', span: 12,
      opts: [{ v: '', t: 'Unassigned' }, ...S.get().people.map(x => ({ v: x.id, t: x.name }))] },
  ]);
  if (!res) return false;
  S.mutate(s => {
    const pp = S.byId(s.projects, pid);
    if (m) Object.assign(pp.milestones.find(x => x.id === mid), res);
    else (pp.milestones ||= []).push({ id: S.uid('ms'), ...res });
  }, { label: 'milestone' });
  return true;
}

async function editRisk(pid, rid) {
  const p = S.byId(S.get().projects, pid);
  const r = rid ? p.risks.find(x => x.id === rid) : null;
  const res = await formDlg(r ? 'Edit risk' : 'Log a risk', [
    { k: 'text', label: 'Risk', value: r?.text || '', required: true, span: 12, hint: 'What could go wrong, stated plainly.' },
    { k: 'impact', label: 'Impact', type: 'select', value: r?.impact || 'medium', span: 4, opts: ['high', 'medium', 'low'].map(x => ({ v: x, t: x })) },
    { k: 'likelihood', label: 'Likelihood', type: 'select', value: r?.likelihood || 'medium', span: 4, opts: ['high', 'medium', 'low'].map(x => ({ v: x, t: x })) },
    { k: 'status', label: 'Status', type: 'select', value: r?.status || 'open', span: 4, opts: ['open', 'mitigating', 'closed'].map(x => ({ v: x, t: x })) },
    { k: 'mitigation', label: 'Mitigation', type: 'textarea', value: r?.mitigation || '', span: 12, rows: 2 },
    { k: 'owner', label: 'Owner', type: 'select', value: r?.owner || '', span: 12,
      opts: [{ v: '', t: 'Unassigned' }, ...S.get().people.map(x => ({ v: x.id, t: x.name }))] },
  ], { wide: true });
  if (!res) return false;
  S.mutate(s => {
    const pp = S.byId(s.projects, pid);
    if (r) Object.assign(pp.risks.find(x => x.id === rid), res);
    else (pp.risks ||= []).push({ id: S.uid('rk'), ...res });
  }, { label: 'risk' });
  return true;
}

/* ---------- view --------------------------------------------------------- */

export default {
  id: 'projects', title: 'Overview', icon: 'flag', group: 'projects',
  subtitle: 'Every project at a glance — health, schedule, budget and risk',

  actions: ctx => [
    { label: 'New project', icon: 'plus', primary: true, run: () => editProject(null).then(r => r && ctx.rerender()) },
  ],

  render(host, ctx) {
    const s = S.get();
    const pid = ctx.params[0];
    const proj = pid ? S.byId(s.projects, pid) : null;

    if (proj) {
      const tab = tabOf(ctx.params[1]);
      const hl = projectHealth(proj);
      ctx.setTitle(proj.name);
      ctx.setCrumb(proj.code + ' · ' + (TABS.find(t => t.id === tab)?.label || proj.phase));

      host.innerHTML = h`${raw(projHeader(proj, hl, tab))}<div id="ptab-body"></div>`;
      const bodyEl = host.querySelector('#ptab-body');

      if (tab === 'tasks') {
        /* The same panel as the global Tasks view, scoped to this project and
           keyed on its id so each project remembers its own board/list. */
        bodyEl.innerHTML = h`
          <div class="row" style="margin-bottom:10px">
            <div class="tiny mute" style="flex:1">
              Everything filed against <b>${proj.code}</b>. New tasks land at the top of Backlog
              and are already assigned to this project${proj.divisionId
                ? ` and to the <b>${esc(S.byId(S.get().divisions, proj.divisionId)?.name || proj.divisionId)}</b> division`
                : ''}.
              ${raw(proj.divisionId
                ? 'Its work on the <i>other</i> projects is listed on the Overview tab — those tasks stay where they are.'
                : '')}
            </div>
            <button class="btn sm primary" data-act="newtask">${icon('plus')}New task</button>
          </div>
          <div id="ptasks"></div>`;
        taskPanel(bodyEl.querySelector('#ptasks'), ctx, {
          projectId: proj.id,
          key: `gfxprod.ui.tasks.${proj.id}`,
        });
      } else {
        bodyEl.innerHTML = tab === 'milestones' ? tabMilestones(proj)
                         : tab === 'scopes'     ? tabScopes(proj)
                         : tab === 'risks'      ? tabRisks(proj)
                         : tab === 'team'       ? tabTeam(proj)
                         : tabOverview(proj);
      }

      acts(host, {
        back: () => ctx.go('projects'),
        tab: el => ctx.go('projects', proj.id, el.dataset.t),
        edit: () => editProject(proj.id).then(r => r && ctx.rerender()),
        sp: () => openExternal(proj.sharepointUrl),
        finance: () => ctx.go('finance', proj.id),
        jira: () => ctx.go('jira-imports'),
        imports: () => ctx.go('jira-imports'),
        /* A division-tied project pre-fills the division too, so GFX Prod work
           carries its GFX-Prod label without anyone remembering to set it. */
        newtask: () => editTask(null, { project: proj.id, ...(proj.divisionId ? { division: proj.divisionId } : {}) })
          .then(r => r && ctx.rerender()),
        'ms-add': () => editMilestone(proj.id, null).then(r => r && ctx.rerender()),
        'ms-menu': (el, ev) => {
          const mid = el.closest('[data-ms]').dataset.ms;
          menu(ev, [
            { label: 'Edit…', icon: 'edit', run: () => editMilestone(proj.id, mid).then(r => r && ctx.rerender()) },
            { label: 'Mark done', icon: 'check', run: () => { S.mutate(st => { S.byId(st.projects, proj.id).milestones.find(x => x.id === mid).status = 'done'; }); ctx.rerender(); } },
            '-',
            { label: 'Delete', icon: 'trash', danger: true, run: async () => {
              if (!await confirmDlg('Delete this milestone?', { ok: 'Delete' })) return;
              S.mutate(st => { const pp = S.byId(st.projects, proj.id); pp.milestones = pp.milestones.filter(x => x.id !== mid); });
              ctx.rerender();
            } },
          ]);
        },
        'ts-row': scaleAct(() => ctx.rerender()),
        'go-wb': () => ctx.go('gfxwb', 'calc'),

        /* --- the division panel on a division-tied project --- */
        'go-team': () => ctx.go('projects', proj.id, 'team'),
        'linked-open': el => ctx.go('tasks', el.closest('[data-t]').dataset.t),

        /* --- scopes --- */
        'scope-task': el => {
          const e = scopesFor(proj.id).find(x => x.id === el.closest('[data-e]').dataset.e);
          if (e?.logged?.taskId) ctx.go('tasks', e.logged.taskId);
        },
        'scope-jira': el => {
          const e = scopesFor(proj.id).find(x => x.id === el.closest('[data-e]').dataset.e);
          const t = e?.logged?.taskId ? S.byId(S.get().tasks, e.logged.taskId) : null;
          if (!t) return toast('The task for that scope no longer exists.', 'err');
          bulkQueueDialog([t.id]).then(() => ctx.rerender());
        },
        'scope-jira-all': () => {
          const ids = scopesFor(proj.id)
            .map(e => S.byId(S.get().tasks, e.logged.taskId))
            .filter(t => t && !t.jira?.key).map(t => t.id);
          if (!ids.length) return toast('Every scope is already filed.', 'warn');
          bulkQueueDialog(ids).then(() => ctx.rerender());
        },
        'scope-open-jira': el => {
          const e = scopesFor(proj.id).find(x => x.id === el.closest('[data-e]').dataset.e);
          const t = e?.logged?.taskId ? S.byId(S.get().tasks, e.logged.taskId) : null;
          if (t?.jira?.url) openExternal(t.jira.url);
        },
        'scope-menu': (el, ev) => {
          const id = el.closest('[data-e]').dataset.e;
          const e = scopesFor(proj.id).find(x => x.id === id);
          const t = e?.logged?.taskId ? S.byId(S.get().tasks, e.logged.taskId) : null;
          menu(ev, [
            { label: 'Open in GFX WB', icon: 'chart', run: () => ctx.go('gfxwb', 'calc', id) },
            ...(t ? [{ label: 'Open the task', icon: 'board', run: () => ctx.go('tasks', t.id) }] : []),
            { label: 'See the whole log', icon: 'file', run: () => ctx.go('gfxwb', 'log') },
          ]);
        },
        'scope-csv': () => {
          const rows = [];
          for (const e of scopesFor(proj.id)) {
            for (const l of (e.logged.lines || [])) {
              rows.push({
                Project: proj.code, Scope: e.name,
                Ordered: new Date(e.logged.at).toISOString().slice(0, 10),
                Division: l.division, WorkItem: l.name, Qty: l.qty,
                Complexity: wbComplexity(l.complexity).label,
                Approach: wbApproach(l.approach).label,
                Hours: Math.round(l.hours * 100) / 100, Seniority: l.seniority,
                HourlyRate: Math.round(l.rate * 100) / 100,
                Cost: Math.round(l.cost * 100) / 100,
              });
            }
          }
          if (!rows.length) return toast('Nothing logged against this project.', 'warn');
          download(`gfx-scopes-${proj.code}-${today()}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
          toast(`${rows.length} ordered items exported`, 'ok');
        },

        'risk-add': () => editRisk(proj.id, null).then(r => r && ctx.rerender()),
        'risk-menu': (el, ev) => {
          const rid = el.closest('[data-risk]').dataset.risk;
          menu(ev, [
            { label: 'Edit…', icon: 'edit', run: () => editRisk(proj.id, rid).then(r => r && ctx.rerender()) },
            { label: 'Close risk', icon: 'check', run: () => { S.mutate(st => { S.byId(st.projects, proj.id).risks.find(x => x.id === rid).status = 'closed'; }); ctx.rerender(); } },
            '-',
            { label: 'Delete', icon: 'trash', danger: true, run: async () => {
              if (!await confirmDlg('Delete this risk?', { ok: 'Delete' })) return;
              S.mutate(st => { const pp = S.byId(st.projects, proj.id); pp.risks = pp.risks.filter(x => x.id !== rid); });
              ctx.rerender();
            } },
          ]);
        },
      });
      /* The milestone panel is measured after it is in the document, and its
         range buttons and milestone clicks are wired the same way everywhere. */
      return wireMilestones(host, ctx);
    }

    ctx.setTitle();
    ctx.setCrumb('');
    const live = s.projects.filter(p => p.status !== 'archived');
    host.innerHTML = h`
      ${raw(portfolioKpis(live))}
      <div class="grid g3" style="margin-bottom:14px">
        ${raw(live.map(portfolioCard).join(''))}
      </div>
      ${raw(taskBand(live))}
      <div style="margin-bottom:14px">${raw(milestonePanel({
        title: 'Milestones ahead',
        items: msItems(live),
        pips: msPips(new Set(live.map(p => p.id))),
        key: 'portfolio',
        emptyMsg: 'No milestones in this window. Widen the range, or add one on a project.',
        extra: '<button class="btn sm subtle" data-act="k-tasks">All tasks →</button>',
      }))}</div>
      ${raw(timeline())}
      ${raw(s.projects.some(p => p.status === 'archived') ? `
        <details style="margin-top:14px"><summary class="tiny mute" style="cursor:pointer">Archived projects</summary>
          <div class="grid g3" style="margin-top:10px">${s.projects.filter(p => p.status === 'archived').map(portfolioCard).join('')}</div>
        </details>` : '')}`;

    acts(host, {
      open: el => ctx.go('projects', el.closest('[data-id]').dataset.id),
      'open-tasks': el => ctx.go('projects', el.closest('[data-id]').dataset.id, 'tasks'),
      'ts-row': scaleAct(() => ctx.rerender()),
      'k-projects': () => host.querySelector('.grid.g3')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      'k-tasks':   () => ctx.go('tasks'),
      'k-finance': () => ctx.go('finance'),
    });

    return wireMilestones(host, ctx);
  },
};
