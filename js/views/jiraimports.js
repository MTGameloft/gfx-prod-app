/* ============================================================================
   views/jiraimports.js — what has been filed into Jira, and when.

   A log, not a workspace. Rows are written once by `applyResult()` when the
   local helper reports an issue created, and are never edited afterwards:
   they record what was actually sent, so retitling or re-scoping the task
   next month does not rewrite August.

   The tasks themselves stay exactly where they were. Being in Jira is not a
   reason to disappear off the board — it is marked with an `Imported` tag and
   nothing else changes.
   ========================================================================= */

import * as S from '../store.js';
import {
  h, raw, esc, icon, toast, acts, confirmDlg, menu,
  fmtDate, fmtNum, daysBetween, today, download, toCsv, groupBy, pickFile,
} from '../ui.js';
import {
  IMPORTED_TAG, jiraEvents, jiraEventKind, JIRA_EVENTS,
  queuedTasks, planFor, subtasksOf, originalEstimateOf, dequeue,
  buildQueue, markSent, applyResult, QUEUE_FILE,
} from '../jira.js';
import { openExternal } from '../teams.js';

const TABS = [
  { id: 'issues',  label: 'Issues' },
  { id: 'history', label: 'History' },
];
const tabOf = v => TABS.find(t => t.id === v) ? v : 'issues';

const UI_KEY = 'gfxprod.ui.jiraimports';
const ui = Object.assign({
  q: '', project: '', division: '', group: 'batch',
  /* History tab: its own filter set, kept separate so switching tabs does not
     silently apply the other tab's filters to a different shape of row. */
  hq: '', hEvent: '', hProject: '', hDivision: '', hFrom: '', hTo: '', hSort: 'new',
}, JSON.parse(localStorage.getItem(UI_KEY) || '{}'));
const saveUi = () => localStorage.setItem(UI_KEY, JSON.stringify(ui));

/** Is anything narrowing the history right now? Drives the Clear button. */
const hFiltered = () =>
  !!(ui.hq || ui.hEvent || ui.hProject || ui.hDivision || ui.hFrom || ui.hTo);

/* A day string, so the from/to inputs compare like-for-like with
   <input type="date"> and no timezone gets dragged into it. */
const dayOf = e => new Date(e.at).toISOString().slice(0, 10);

/* relDays() speaks in due dates — "2d overdue" — which is the wrong tense for
   a log of things that already happened. */
const agoOf = (iso) => {
  const n = daysBetween(iso, today());
  if (n === 0) return 'today';
  if (n === 1) return 'yesterday';
  if (n < 7)  return `${n} days ago`;
  if (n < 60) return `${Math.round(n / 7)} week${Math.round(n / 7) === 1 ? '' : 's'} ago`;
  return `${Math.round(n / 30)} months ago`;
};

/**
 * The history rows, filtered and sorted the way the toolbar says.
 *
 * Shared with the CSV export on purpose: exporting the whole log while the
 * screen showed one division for one week would be a quiet lie.
 */
const historyRows = () => {
  const q = ui.hq.trim().toLowerCase();
  const asc = ui.hSort === 'old';
  return jiraEvents().filter(e => {
    if (ui.hEvent && e.event !== ui.hEvent) return false;
    if (ui.hProject && (e.project || '') !== ui.hProject) return false;
    if (ui.hDivision && (e.division || '') !== ui.hDivision) return false;
    if (ui.hFrom && dayOf(e) < ui.hFrom) return false;
    if (ui.hTo && dayOf(e) > ui.hTo) return false;
    if (q && !`${e.title} ${e.key || ''} ${e.jiraProject || ''} ${e.detail || ''}`
      .toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => asc ? a.at - b.at : b.at - a.at);
};

const rowsOf = () => {
  const q = ui.q.trim().toLowerCase();
  return (S.get().jiraImports || []).filter(r => {
    if (ui.project && (r.project || '') !== ui.project) return false;
    if (ui.division && (r.division || '') !== ui.division) return false;
    if (q && !`${r.key} ${r.title} ${(r.labels || []).join(' ')} ${r.parent || ''}`.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => (b.at || 0) - (a.at || 0));
};

/* ---------- what is waiting to go ---------------------------------------- */

/**
 * The queue, shown here rather than in a dialog.
 *
 * It used to live behind a "Jira queue" button, which meant the one screen
 * called Jira Imports could say "nothing has been filed yet" while three tasks
 * sat queued two clicks away. The thing you are about to send belongs on the
 * page about sending things.
 */
function queuePanel() {
  const s = S.get();
  const queued = queuedTasks(s);
  const sent = (s.tasks || []).filter(t => t.jira?.state === 'sent');
  const failed = (s.tasks || []).filter(t => t.jira?.state === 'failed');

  /* Sent tasks are deliberately not listed. Importing empties this panel —
     the record of what went over lives on History, and a queue that still
     shows what you just sent reads as if the click did nothing. They are
     counted, because Import results needs to be run for them. */
  if (!queued.length && !failed.length) {
    return h`<div class="card"><div class="empty">
      <h4>${sent.length ? 'Nothing left to send' : 'Nothing queued'}</h4>
      <div class="tiny" style="max-width:62ch;margin:0 auto;line-height:1.7">
        ${sent.length ? raw(`<b>${sent.length} task${sent.length === 1 ? ' is' : 's are'} with the helper.</b>
          Once it has filed them, click <b>Import results</b> to bring the issue keys back.
          What went over is on the <b>History</b> tab.<br>`) : ''}
        Select tasks on the board or in the list and choose <b>Queue for Jira</b>.
        They appear here with what they will be filed as, and <b>Import to Jira</b>
        hands them over.
      </div>
      <div style="margin-top:12px"><button class="btn primary sm" data-act="go-tasks">
        ${icon('board')}Open the board</button>
        ${raw(sent.length ? '<button class="btn sm subtle" data-act="go-history">History →</button>' : '')}
      </div>
    </div></div>`;
  }

  const row = (t, kind) => {
    const p = planFor(t);
    const d = S.byId(s.divisions, t.division);
    const proj = S.byId(s.projects, t.project);
    const subs = subtasksOf(t).length;
    const est = originalEstimateOf(t);
    return `<tr data-id="${t.id}">
      <td style="width:86px">${kind === 'queued' ? '<span class="chip warn">Queued</span>'
        : '<span class="chip risk">Failed</span>'}</td>
      <td><b>${esc(p.fields.summary || t.title)}</b>
        <div class="tiny mute">${esc(p.jiraKey)}
          ${p.component ? ' · ' + esc(p.component) : ''}
          ${p.fields.labels.length ? ' · ' + esc(p.fields.labels.join(', ')) : ' · no labels'}
          ${p.fields.parent ? ' · ' + esc(p.fields.parent) : ''}
          · ${esc(p.fields.priority)}
          ${est ? ' · est ' + esc(est) : ''}
          ${subs ? ` · +${subs} sub-task${subs === 1 ? '' : 's'}` : ''}</div>
        ${t.jira?.err ? `<div class="tiny" style="color:var(--risk)">${esc(t.jira.err)}</div>` : ''}
        ${p.gaps.length ? `<div class="tiny" style="color:var(--risk)">needs ${esc(p.gaps.join(', '))}</div>` : ''}</td>
      <td style="width:72px">${proj
        ? `<span class="chip" style="background:${proj.color}22;color:${proj.color}">${esc(proj.code)}</span>`
        : '<span class="mute tiny">—</span>'}</td>
      <td style="width:56px">${d ? `<span class="pill-div" style="background:${d.color}">${esc(d.id)}</span>` : ''}</td>
      <td class="act" style="width:1%">
        <button class="btn sm subtle" data-act="q-open">Open</button>
        <button class="btn sm subtle" data-act="q-drop">Remove</button>
      </td></tr>`;
  };

  const ready = queued.filter(t => !planFor(t).gaps.length).length;
  const short = queued.length - ready;

  return h`
  <section class="card">
    <header><h3>Waiting to go to Jira</h3>
      <span class="sub">${queued.length} queued${short ? ` · ${short} missing a field` : ''}${
        failed.length ? ` · ${failed.length} rejected last time` : ''}${
        sent.length ? ` · ${sent.length} with the helper` : ''}</span>
      <div class="spacer" style="flex:1"></div>
      ${raw(queued.length ? '<button class="btn sm subtle" data-act="q-clear">Clear the queue</button>' : '')}
      ${raw(ready ? `<button class="btn sm primary" data-act="do-import">${icon('link')}Import ${ready} to Jira</button>` : '')}
    </header>
    <div class="body flush"><table class="tbl"><tbody>
      ${raw(queued.map(t => row(t, 'queued')).join(''))}
      ${raw(failed.map(t => row(t, 'failed')).join(''))}
    </tbody></table></div>
    ${raw(sent.length ? `<div class="body" style="padding-top:0">
      <div class="tiny mute" style="line-height:1.7">
        ${sent.length} task${sent.length === 1 ? ' is' : 's are'} already with the helper and no
        longer listed here — see the <b>History</b> tab. When it has filed them, use
        <b>Import results</b> to bring the issue keys back; that is what tags the tasks.
      </div></div>` : '')}
  </section>`;
}

/**
 * Hand the queue over: build the file, download it, mark the tasks sent.
 *
 * Exactly what "Export queue" did in the dialog that used to own this. The
 * view then empties itself, because the tasks are no longer queued — which is
 * the whole point of the queue living on the page.
 */
async function importToJira(ctx) {
  const queued = queuedTasks();
  if (!queued.length) {
    toast('Nothing is queued. Select tasks on the board and choose Queue for Jira.', 'warn', 6000);
    return;
  }
  const plans = queued.map(t => ({ t, p: planFor(t) }));
  const short = plans.filter(x => x.p.gaps.length);
  if (short.length === plans.length) {
    toast(`Nothing can be sent — ${short[0].p.gaps.join(', ')} missing. Open the task to fix it.`, 'err', 8000);
    return;
  }

  const subs = queued.reduce((n, t) => n + subtasksOf(t).length, 0);
  const ok = await confirmDlg(
    `Hand ${plans.length - short.length} task${plans.length - short.length === 1 ? '' : 's'}`
    + `${subs ? ` and ${subs} sub-task${subs === 1 ? '' : 's'}` : ''} to the local helper?`
    + (short.length ? `\n\n${short.length} will be left in the queue — they are missing a required field.` : '')
    + `\n\nThe queue downloads to your Downloads folder. The helper files it — within about 15 `
    + `seconds if auto-push is on, otherwise run tools\\jira-push.ps1. Then use Import results.`,
    { title: 'Import to Jira', ok: 'Hand it over', danger: false });
  if (!ok) return;

  const q = buildQueue();
  if (!q.items.length) return toast('Nothing is queued.', 'warn');
  download(QUEUE_FILE, JSON.stringify(q, null, 2), 'application/json');
  const n = markSent(q.batchId);
  toast(`${n} task${n === 1 ? '' : 's'} handed over. When the helper has filed them, use Import results.`,
        'ok', 9000);
  ctx.rerender();
}

/** Read back what the helper created. */
async function importResults(ctx) {
  const f = await pickFile('.json');
  if (!f) return;
  try {
    const r = applyResult(f.text);
    const bits = [];
    if (r.filed) bits.push(`${r.filed} filed`);
    if (r.subtasks) bits.push(`${r.subtasks} sub-task${r.subtasks === 1 ? '' : 's'}`);
    if (r.subtaskFails) bits.push(`${r.subtaskFails} sub-task${r.subtaskFails === 1 ? '' : 's'} failed`);
    if (r.failed) bits.push(`${r.failed} failed`);
    if (r.unknown.length) bits.push(`${r.unknown.length} not from this app`);
    toast(bits.length ? bits.join(', ') : 'Nothing in that file matched a task.',
          r.failed ? 'warn' : 'ok', 8000);
    ctx.rerender();
  } catch (e) { toast(e.message, 'err', 8000); }
}

/* ---------- pieces ------------------------------------------------------- */

function kpis(rows) {
  const all = S.get().jiraImports || [];
  const batches = new Set(all.map(r => r.batch).filter(Boolean)).size;
  const last = all.reduce((m, r) => Math.max(m, r.at || 0), 0);
  const queued = (S.get().tasks || []).filter(t => t.jira?.state === 'queued').length;
  const tagged = (S.get().tasks || []).filter(t =>
    (t.tags || []).some(x => String(x).toLowerCase() === IMPORTED_TAG.toLowerCase())).length;

  return h`<div class="grid g4" style="margin-bottom:14px">
    <div class="card stat"><div class="k">Issues filed</div><div class="v">${fmtNum(all.length)}</div>
      <div class="d">${rows.length === all.length ? 'all time' : `${fmtNum(rows.length)} shown`}</div></div>
    <div class="card stat"><div class="k">Import runs</div><div class="v">${fmtNum(batches)}</div>
      <div class="d">${last ? 'last ' + esc(fmtDate(new Date(last).toISOString().slice(0, 10), 'long')) : 'never'}</div></div>
    <div class="card stat"><div class="k">Tagged in the app</div><div class="v">${fmtNum(tagged)}</div>
      <div class="d">tasks carrying <code>${esc(IMPORTED_TAG)}</code></div></div>
    <div class="card stat">
      <div class="k">Waiting to be filed</div><div class="v">${fmtNum(queued)}</div>
      <div class="d ${queued ? 'down' : ''}">${queued ? 'in the queue below' : 'nothing queued'}</div></div>
  </div>`;
}

function toolbar() {
  const s = S.get();
  const all = s.jiraImports || [];
  const opt = (list, sel, blank) =>
    `<option value="">${esc(blank)}</option>` +
    list.map(o => `<option value="${esc(o.v)}"${o.v === sel ? ' selected' : ''}>${esc(o.t)}</option>`).join('');
  const projects = [...new Set(all.map(r => r.project).filter(Boolean))].sort();
  const divisions = [...new Set(all.map(r => r.division).filter(Boolean))].sort();

  return h`
  <div class="toolbar">
    <div class="search" style="width:250px">
      ${icon('search')}
      <input type="search" id="jq" placeholder="Search issue key, title, label…" value="${ui.q}">
    </div>
    <select data-change="f" data-k="project" style="width:auto">
      ${raw(opt(projects.map(p => ({ v: p, t: p })), ui.project, 'All Jira projects'))}
    </select>
    <select data-change="f" data-k="division" style="width:auto">
      ${raw(opt(divisions.map(d => ({ v: d, t: S.byId(s.divisions, d)?.name || d })), ui.division, 'All divisions'))}
    </select>
    <div class="seg">
      <button data-act="group" data-v="batch" class="${ui.group === 'batch' ? 'on' : ''}">By run</button>
      <button data-act="group" data-v="flat"  class="${ui.group === 'flat'  ? 'on' : ''}">Flat</button>
    </div>
    <div class="spacer"></div>
    <button class="btn sm subtle" data-act="csv" title="Export this history as CSV">${icon('down')}CSV</button>
  </div>`;
}

function table(rows) {
  const s = S.get();
  const line = r => {
    const d = S.byId(s.divisions, r.division);
    const p = S.byId(s.projects, r.projectId);
    const live = S.byId(s.tasks, r.taskId);
    return `<tr data-ji="${r.id}">
      <td class="nowrap">${r.url
        ? `<a href="${esc(r.url)}" data-act="open-issue" data-u="${esc(r.url)}" class="chip ok">${esc(r.key)}</a>`
        : `<span class="chip ok">${esc(r.key)}</span>`}</td>
      <td>
        <div class="strong">${esc(r.title)}</div>
        <div class="tiny mute">
          ${(r.labels || []).map(l => `<span class="tag-x">${esc(l)}</span>`).join(' ')}
          ${r.parent ? `<span class="tag-x">parent ${esc(r.parent)}</span>` : ''}
          ${r.skipped ? '<span class="tag-x">already existed</span>' : ''}
        </div>
      </td>
      <td>${p ? `<span class="chip" style="background:${p.color}22;color:${p.color}">${esc(p.code)}</span>` : '<span class="mute">—</span>'}</td>
      <td>${d ? `<span class="pill-div" style="background:${d.color}">${esc(d.id)}</span>` : ''}</td>
      <td class="tiny">${esc(r.project || '')}</td>
      <td class="tiny">${esc(r.priority || '')}</td>
      <td class="tiny nowrap">${esc(fmtDate(new Date(r.at).toISOString().slice(0, 10), 'long'))}</td>
      <td class="tiny">${live ? '<span class="mute">in the board</span>' : '<span class="mute">task deleted</span>'}</td>
      <td class="act"><button class="btn icon sm subtle" data-act="row-menu"><svg class="ico"><use href="#i-dots"></use></svg></button></td>
    </tr>`;
  };

  const head = `<thead><tr>
      <th style="width:96px">Issue</th><th>Summary</th><th>Project</th><th>Div</th>
      <th>Jira project</th><th>Priority</th><th>Filed</th><th>Task</th><th></th>
    </tr></thead>`;

  if (ui.group === 'flat') {
    return h`<div class="card"><div class="tbl-wrap"><table class="tbl">
      ${raw(head)}<tbody>${raw(rows.map(line).join(''))}</tbody></table></div></div>`;
  }

  /* Grouped by the export that created them, newest run first — which is how
     you actually look this up: "what went over on Tuesday". */
  const g = groupBy(rows, r => r.batch || 'unbatched');
  const order = Object.keys(g).sort((a, b) =>
    Math.max(...g[b].map(r => r.at || 0)) - Math.max(...g[a].map(r => r.at || 0)));

  return h`${raw(order.map(b => {
    const list = g[b];
    const at = Math.max(...list.map(r => r.at || 0));
    return `<section class="card" style="margin-bottom:12px">
      <header>
        <h3>${list.length} issue${list.length === 1 ? '' : 's'}</h3>
        <span class="sub">${esc(fmtDate(new Date(at).toISOString().slice(0, 10), 'long'))}
          · run <code>${esc(b === 'unbatched' ? 'not recorded' : b)}</code></span>
      </header>
      <div class="body flush"><table class="tbl">${head}<tbody>${list.map(line).join('')}</tbody></table></div>
    </section>`;
  }).join(''))}`;
}

/* ---------- the history tab --------------------------------------------- */

/**
 * When each task moved, in order.
 *
 * The Issues tab answers "what is in Jira". This answers "what happened, and
 * when" — including the attempts that failed and the queues that were emptied
 * without being sent, neither of which leaves a trace on the Issues tab.
 */
function historyTab() {
  const s = S.get();
  const all = jiraEvents();
  const rows = historyRows();

  if (!all.length) {
    return h`<div class="card"><div class="empty">
      <h4>No import history yet</h4>
      <div class="tiny" style="max-width:60ch;margin:0 auto;line-height:1.7">
        Every task handed to the helper is recorded here with a timestamp, along with
        what Jira did with it. Queue something from the board and click
        <b>Import to Jira</b> and it appears.
      </div></div></div>`;
  }

  const count = ev => all.filter(e => e.event === ev).length;
  const lastFiled = all.find(e => e.event === 'filed');
  const backfilled = all.filter(e => e.backfilled).length;

  /* Options come from the events themselves, not from the full project and
     division lists: a filter that can only ever return nothing is noise. */
  const projOpts = [...new Set(all.map(e => e.project).filter(Boolean))]
    .map(id => ({ v: id, t: S.byId(s.projects, id)?.name || id }))
    .sort((a, b) => a.t.localeCompare(b.t));
  const divOpts = [...new Set(all.map(e => e.division).filter(Boolean))]
    .map(id => ({ v: id, t: S.byId(s.divisions, id)?.name || id }))
    .sort((a, b) => a.t.localeCompare(b.t));
  const opts = (list, sel) => list.map(o =>
    `<option value="${esc(o.v)}"${o.v === sel ? ' selected' : ''}>${esc(o.t)}</option>`).join('');

  /* Grouped by calendar day, because "when did that go over" is a day-shaped
     question and a flat list of 200 timestamps is not browsable. Sort runs the
     days and the rows inside them together, so oldest-first means exactly
     that all the way down. */
  const asc = ui.hSort === 'old';
  const byDay = groupBy(rows, dayOf);
  const days = Object.keys(byDay).sort((a, b) => asc ? a.localeCompare(b) : b.localeCompare(a));

  return h`
  <div class="grid g4" style="margin-bottom:14px">
    <div class="card stat"><div class="k">Events</div><div class="v">${fmtNum(all.length)}</div>
      <div class="d">${rows.length === all.length ? 'all shown' : `${fmtNum(rows.length)} shown`}</div></div>
    <div class="card stat"><div class="k">Filed</div><div class="v">${fmtNum(count('filed'))}</div>
      <div class="d">${count('failed') ? `${count('failed')} rejected` : 'none rejected'}</div></div>
    <div class="card stat"><div class="k">Imported</div><div class="v">${fmtNum(count('exported'))}</div>
      <div class="d">handed to the helper</div></div>
    <div class="card stat"><div class="k">Last filed</div>
      <div class="v" style="font-size:17px">${lastFiled
        ? esc(fmtDate(new Date(lastFiled.at).toISOString().slice(0, 10), 'long')) : '—'}</div>
      <div class="d">${lastFiled ? esc(lastFiled.key || '') : 'nothing filed yet'}</div></div>
  </div>

  <div class="toolbar">
    <div class="search" style="width:220px">
      ${icon('search')}
      <input type="search" id="hq" placeholder="Search task, issue key…" value="${ui.hq}">
    </div>
    <select data-change="hf" data-k="hProject" style="width:auto" title="Project">
      <option value="">All projects</option>
      ${raw(opts(projOpts, ui.hProject))}
    </select>
    <select data-change="hf" data-k="hDivision" style="width:auto" title="Division">
      <option value="">All divisions</option>
      ${raw(opts(divOpts, ui.hDivision))}
    </select>
    <select data-change="hf" data-k="hEvent" style="width:auto" title="Step">
      <option value="">Every step</option>
      ${raw(Object.entries(JIRA_EVENTS).map(([id, k]) =>
        `<option value="${esc(id)}"${id === ui.hEvent ? ' selected' : ''}>${esc(k.label)} (${count(id)})</option>`).join(''))}
    </select>
    <label class="tiny mute" style="display:flex;align-items:center;gap:5px">From
      <input type="date" data-change="hf" data-k="hFrom" value="${ui.hFrom}" style="width:auto"></label>
    <label class="tiny mute" style="display:flex;align-items:center;gap:5px">to
      <input type="date" data-change="hf" data-k="hTo" value="${ui.hTo}" style="width:auto"></label>
    <div class="seg" title="Sort by date">
      <button data-act="hsort" data-v="new" class="${asc ? '' : 'on'}">Newest</button>
      <button data-act="hsort" data-v="old" class="${asc ? 'on' : ''}">Oldest</button>
    </div>
    <div class="spacer"></div>
    ${raw(hFiltered() ? '<button class="btn sm subtle" data-act="hclear">Clear filters</button>' : '')}
    <button class="btn sm subtle" data-act="csv-history" title="Export what is shown as CSV">${icon('down')}CSV</button>
  </div>

  ${raw(backfilled ? `<div class="banner" style="margin-bottom:12px">
    <svg class="ico"><use href="#i-info"></use></svg>
    <div>${backfilled} of these were rebuilt from the timestamps already on your tasks
      when this history was added.
      <div class="tiny mute" style="margin-top:4px">A task only keeps the latest of each
        stamp, so those entries are a floor rather than a full record — a task imported twice
        before today shows one import. Everything from now on is logged as it happens.</div>
    </div></div>` : '')}

  ${raw(days.length ? days.map(day => {
    const evs = byDay[day];
    return `<section class="card" style="margin-bottom:10px">
      <header><h3>${esc(fmtDate(day, 'long'))}</h3>
        <span class="sub">${evs.length} event${evs.length === 1 ? '' : 's'}
          · ${esc(agoOf(day))}</span></header>
      <div class="body flush"><table class="tbl">
        <tbody>${evs.map(e => {
          const k = jiraEventKind(e.event);
          const proj = S.byId(s.projects, e.project);
          const div = e.division ? S.byId(s.divisions, e.division) : null;
          const live = e.taskId ? S.byId(s.tasks, e.taskId) : null;
          return `<tr data-je="${e.id}"${e.taskId ? ` data-t="${e.taskId}"` : ''}>
            <td class="tiny nowrap" style="width:64px">${esc(new Date(e.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))}</td>
            <td style="width:92px"><span class="chip ${k.chip}">${esc(k.label)}</span></td>
            <td><b>${esc(e.title || '(untitled)')}</b>
              <div class="tiny mute">${esc(k.verb)}${e.jiraProject ? ' · ' + esc(e.jiraProject) : ''}${
                e.subtasks ? ` · ${e.subtasks} sub-task${e.subtasks === 1 ? '' : 's'}` : ''}${
                e.batch ? ` · run ${esc(String(e.batch).slice(0, 16))}` : ''}${
                e.skipped ? ' · already existed' : ''}</div>
              ${e.detail && e.event === 'failed' ? `<div class="tiny" style="color:var(--risk)">${esc(e.detail)}</div>` : ''}</td>
            <td style="width:80px">${proj
              ? `<span class="chip" style="background:${proj.color}22;color:${proj.color}">${esc(proj.code)}</span>`
              : '<span class="mute tiny">—</span>'}</td>
            <td style="width:56px">${div
              ? `<span class="pill-div" style="background:${div.color}" title="${esc(div.name)}">${esc(div.id)}</span>`
              : ''}</td>
            <td class="tiny nowrap" style="width:120px">${e.key
              ? (e.url
                  ? `<span class="chip ok" data-act="open-issue" data-u="${esc(e.url)}" style="cursor:pointer">${esc(e.key)}</span>`
                  : `<span class="chip ok">${esc(e.key)}</span>`)
              : ''}</td>
            <td class="act" style="width:1%">${live
              ? '<button class="btn sm subtle" data-act="open-task">Task →</button>'
              : '<span class="tiny mute">deleted</span>'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
    </section>`;
  }).join('') : `<div class="card"><div class="empty"><h4>Nothing matches</h4>
      <div class="tiny">${fmtNum(all.length)} event${all.length === 1 ? '' : 's'} are recorded —
        widen the dates or clear the filters.</div>
      <div style="margin-top:12px"><button class="btn sm" data-act="hclear">Clear filters</button></div>
      </div></div>`)}`;
}

function csvHistory() {
  const s = S.get();
  const rows = historyRows().map(e => ({
    At: new Date(e.at).toISOString().slice(0, 19).replace('T', ' '),
    Step: jiraEventKind(e.event).label,
    Task: e.title,
    Project: S.byId(s.projects, e.project)?.code || '',
    Division: e.division || '',
    JiraProject: e.jiraProject || '',
    IssueKey: e.key || '',
    Subtasks: e.subtasks || '',
    Run: e.batch || '',
    Detail: e.detail || '',
    Rebuilt: e.backfilled ? 'yes' : '',
  }));
  if (!rows.length) return toast(hFiltered() ? 'Nothing matches those filters.' : 'No history yet.', 'warn');
  download(`gfx-jira-history-${today()}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
  toast(`${rows.length} event${rows.length === 1 ? '' : 's'} exported${hFiltered() ? ' (filtered)' : ''}`, 'ok');
}

/* ---------- csv ---------------------------------------------------------- */

function exportCsv(rows) {
  const s = S.get();
  download(`gfx-jira-imports-${today()}.csv`, toCsv(rows.map(r => ({
    IssueKey: r.key,
    Summary: r.title,
    JiraProject: r.project || '',
    Project: S.byId(s.projects, r.projectId)?.code || '',
    Division: r.division || '',
    Labels: (r.labels || []).join(' '),
    Parent: r.parent || '',
    Priority: r.priority || '',
    FiledAt: new Date(r.at).toISOString().slice(0, 19).replace('T', ' '),
    Run: r.batch || '',
    AlreadyExisted: r.skipped ? 'yes' : '',
    Url: r.url || '',
  }))), 'text/csv;charset=utf-8');
  toast(`${rows.length} rows exported`, 'ok');
}

/* ---------- view --------------------------------------------------------- */

export default {
  id: 'jira-imports', title: 'Jira Imports', icon: 'link', group: 'projects', exact: true,
  subtitle: 'Every task filed into Jira, and which run filed it',

  /*
   * Two buttons, because the round trip has two halves and the app cannot do
   * either of them silently: it hands the queue over as a download, and reads
   * back what the helper made of it.
   */
  actions: ctx => {
    const n = queuedTasks().length;
    return [
      { label: n ? `Import to Jira (${n})` : 'Import to Jira', icon: 'link', primary: true,
        run: () => importToJira(ctx) },
      { label: 'Import results', icon: 'up', run: () => importResults(ctx) },
    ];
  },

  render(host, ctx) {
    const tab = tabOf(ctx.params[0]);
    ctx.setCrumb(TABS.find(t => t.id === tab)?.label || '');

    const rows = rowsOf();
    const all = S.get().jiraImports || [];

    const tabsBar = h`<div class="ptabs">${raw(TABS.map(t => {
      const n = t.id === 'issues' ? all.length : jiraEvents().length;
      return `<button class="ptab${t.id === tab ? ' on' : ''}" data-act="tab" data-t="${t.id}">
        ${esc(t.label)}${n ? `<span class="ptab-n">${n}</span>` : ''}</button>`;
    }).join(''))}</div>`;

    if (tab === 'history') {
      host.innerHTML = tabsBar + historyTab();
      const hq = host.querySelector('#hq');
      if (hq) {
        let deb;
        hq.addEventListener('input', () => {
          clearTimeout(deb);
          deb = setTimeout(() => { ui.hq = hq.value; saveUi(); ctx.rerender(); }, 220);
        });
      }
      acts(host, {
        tab: el => ctx.go('jira-imports', el.dataset.t),
        hf: el => { ui[el.dataset.k] = el.value; saveUi(); ctx.rerender(); },
        hsort: el => { ui.hSort = el.dataset.v; saveUi(); ctx.rerender(); },
        hclear: () => {
          Object.assign(ui, { hq: '', hEvent: '', hProject: '', hDivision: '', hFrom: '', hTo: '' });
          saveUi(); ctx.rerender();
        },
        'csv-history': csvHistory,
        'open-issue': el => openExternal(el.dataset.u),
        'open-task': el => ctx.go('tasks', el.closest('[data-t]').dataset.t),
      });
      return;
    }

    /*
     * The queue comes first: it is the thing you are about to do. What is
     * already in Jira sits underneath, and the full record is on History.
     */
    host.innerHTML = tabsBar + h`
      ${raw(kpis(rows))}
      <div style="margin-bottom:14px">${raw(queuePanel())}</div>
      ${raw(all.length ? toolbar() : '')}
      ${raw(all.length === 0 ? ''
        : rows.length ? table(rows) : `
        <div class="card"><div class="empty"><h4>No rows match</h4>
          <div class="tiny">Clear the search or the filters above.</div></div></div>`)}

      ${raw(all.length ? `
        <div class="hint" style="margin-top:12px">
          This also exports to the <b>JiraImports</b> sheet of
          <code>04_Tasks_Objectives.xlsx</code> — Workspace → Excel Sync → Export.
        </div>` : '')}`;

    const q = host.querySelector('#jq');
    if (q) {
      let deb;
      q.addEventListener('input', () => {
        clearTimeout(deb);
        deb = setTimeout(() => { ui.q = q.value; saveUi(); ctx.rerender(); }, 220);
      });
    }

    acts(host, {
      tab: el => ctx.go('jira-imports', el.dataset.t),
      f: el => { ui[el.dataset.k] = el.value; saveUi(); ctx.rerender(); },
      group: el => { ui.group = el.dataset.v; saveUi(); ctx.rerender(); },
      csv: () => exportCsv(rows),
      'open-issue': el => openExternal(el.dataset.u),

      /* --- the queue --- */
      'go-tasks': () => ctx.go('tasks'),
      'go-history': () => ctx.go('jira-imports', 'history'),
      'do-import': () => importToJira(ctx),
      'q-open': el => ctx.go('tasks', el.closest('[data-id]').dataset.id),
      'q-drop': el => { dequeue(el.closest('[data-id]').dataset.id); ctx.rerender(); },
      'q-clear': async () => {
        const ids = queuedTasks().map(t => t.id);
        if (!ids.length) return;
        if (!await confirmDlg(
          `Take all ${ids.length} task${ids.length === 1 ? '' : 's'} out of the queue? ` +
          `Nothing is sent to Jira either way, and you can queue them again.`,
          { ok: 'Clear', title: 'Clear the queue' })) return;
        ids.forEach(dequeue);
        ctx.rerender();
      },
      'row-menu': (el, ev) => {
        const r = (S.get().jiraImports || []).find(x => x.id === el.closest('[data-ji]').dataset.ji);
        if (!r) return;
        const live = S.byId(S.get().tasks, r.taskId);
        menu(ev, [
          ...(r.url ? [{ label: `Open ${r.key} in Jira`, icon: 'link', run: () => openExternal(r.url) }] : []),
          ...(live ? [{ label: 'Open the task', icon: 'board', run: () => ctx.go('tasks', r.taskId) }] : []),
          { label: 'Copy issue key', icon: 'file',
            run: () => navigator.clipboard?.writeText(r.key).then(() => toast(`${r.key} copied`, 'ok')) },
          '-',
          { label: 'Remove this row', icon: 'trash', danger: true, run: async () => {
            if (!await confirmDlg(
              `Remove ${r.key} from the history? The Jira issue is not touched — this only ` +
              `forgets that it was filed from here.`, { ok: 'Remove', title: 'Remove history row' })) return;
            S.mutate(st => { st.jiraImports = (st.jiraImports || []).filter(x => x.id !== r.id); },
                     { label: 'remove import row' });
            ctx.rerender();
          } },
        ]);
      },
    });
  },
};
