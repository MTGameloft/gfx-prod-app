/**
 * The task board and list, as one thing used in two places.
 *
 * `views/tasks.js` renders it across every project; a project's own Tasks tab
 * renders it scoped to that project. They were never going to stay in step as
 * two copies — drag-and-drop, the column filters and the Jira selection are
 * all fiddly enough that a second implementation would drift within a week —
 * so this module owns the behaviour and both callers just pass a scope.
 *
 * Two rules the layout depends on:
 *
 *  - The BOARD is ordered by hand. `task.order` is the only thing that decides
 *    where a card sits, and dropping one writes a new order. Nothing else
 *    sorts it, because a board that re-sorts itself cannot be arranged.
 *  - The LIST's column filters are the list's own. They live under `ui.col`,
 *    are read only by `listRows()`, and the board never looks at them. That is
 *    deliberate: filtering a list to find something must not silently empty
 *    the board you were arranging.
 */

import * as S from './store.js';
import {
  h, raw, esc, icon, toast, dialog, formDlg, confirmDlg, menu, acts, $$,
  fmtDate, relDays, today, download, toCsv, parseCsv, pickFile, groupBy,
} from './ui.js';
import { STATUSES, PRIORITIES, statusOf, prioRank, taskStats } from './calc.js';
import { pushDialog, bulkQueueDialog } from './jiraui.js';
import { IMPORTED_TAG, divisionLabel } from './jira.js';

/* ---------- per-panel state --------------------------------------------- */

const DEFAULTS = () => ({
  mode: 'board',
  q: '', project: '', division: '', assignee: '', priority: '',
  showDone: false,
  /* list only */
  col: { task: '', project: [], division: [], assignee: [], priority: [], status: [], tag: [], overdue: false },
  sort: { by: 'due', dir: 'asc' },
});

const panels = new Map();

function panelState(key) {
  if (panels.has(key)) return panels.get(key);
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key) || '{}'); } catch { /* corrupt: start clean */ }
  const st = { ...DEFAULTS(), ...saved };
  st.col = { ...DEFAULTS().col, ...(saved.col || {}) };
  st.sort = { ...DEFAULTS().sort, ...(saved.sort || {}) };
  // Selection is deliberately not persisted: coming back to a view with
  // eleven tasks still ticked from yesterday is a way to file the wrong thing.
  st.sel = new Set();
  panels.set(key, st);
  return st;
}

const saveState = (key, ui) => {
  const { sel, ...rest } = ui;
  try { localStorage.setItem(key, JSON.stringify(rest)); } catch { /* quota */ }
};

/* ---------- filtering ---------------------------------------------------- */

/** The toolbar filters. Shared by both modes — these are the explicit ones. */
function baseRows(ui, scope) {
  const q = ui.q.trim().toLowerCase();
  return S.get().tasks.filter(t => {
    if (scope.projectId && (t.project || '') !== scope.projectId) return false;
    if (!ui.showDone && t.status === 'done' && ui.mode !== 'list') return false;
    if (!scope.projectId && ui.project && (t.project || '') !== ui.project) return false;
    if (ui.division && (t.division || '') !== ui.division) return false;
    if (ui.assignee && (t.assignee || '') !== ui.assignee) return false;
    if (ui.priority && t.priority !== ui.priority) return false;
    if (q && !(`${t.title} ${t.desc || ''} ${(t.tags || []).join(' ')}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

/* What each filterable column is, in one place: how to read it, what the
   options are, and how to sort by it. The header buttons, the popovers and
   the sorters are all generated from this. */
export const COLUMNS = {
  task:     { label: 'Task',     kind: 'text', get: t => t.title },
  project:  { label: 'Project',  kind: 'pick', get: t => t.project || '',
              opts: s => s.projects.map(p => ({ v: p.id, t: p.code || p.name })),
              sortVal: t => S.projectName(t.project) || '' },
  division: { label: 'Division', kind: 'pick', get: t => t.division || '',
              opts: s => s.divisions.map(d => ({ v: d.id, t: d.name })),
              sortVal: t => t.division || '' },
  assignee: { label: 'Assignee', kind: 'pick', get: t => t.assignee || '',
              opts: s => [{ v: '', t: 'Unassigned' }, ...s.people.filter(p => p.active !== false).map(p => ({ v: p.id, t: p.name }))],
              sortVal: t => S.personName(t.assignee) || '' },
  priority: { label: 'Priority', kind: 'pick', get: t => t.priority || 'normal',
              opts: () => PRIORITIES.map(p => ({ v: p.id, t: p.label })),
              sortVal: t => prioRank(t.priority) },
  status:   { label: 'Status',   kind: 'pick', get: t => t.status,
              opts: () => STATUSES.map(x => ({ v: x.id, t: x.label })),
              sortVal: t => STATUSES.findIndex(x => x.id === t.status) },
  due:      { label: 'Due',      kind: 'date', get: t => t.due || '',
              sortVal: t => t.due || '9999-99-99' },
  estimate: { label: 'Est',      kind: 'num',  get: t => t.estimate || 0,
              sortVal: t => Number(t.estimate) || 0 },
  tag:      { label: 'Tags',     kind: 'pick', get: t => (t.tags || []),
              opts: s => [...new Set((s.tasks || []).flatMap(x => x.tags || []))].sort().map(x => ({ v: x, t: x })),
              multi: true, sortVal: t => (t.tags || []).join(' ') },
};

/** Apply the list's own column filters, then its own sort. */
function listRows(ui, scope) {
  const c = ui.col;
  let rows = baseRows(ui, scope).filter(t => {
    if (c.task && !String(t.title).toLowerCase().includes(c.task.toLowerCase())) return false;
    for (const k of ['project', 'division', 'assignee', 'priority', 'status']) {
      if (c[k]?.length && !c[k].includes(COLUMNS[k].get(t))) return false;
    }
    // Tags are a list on the task, so "any of the chosen" is the useful test.
    if (c.tag?.length && !(t.tags || []).some(x => c.tag.includes(x))) return false;
    if (c.overdue && !(t.due && t.due < today() && t.status !== 'done')) return false;
    return true;
  });

  const col = COLUMNS[ui.sort.by] || COLUMNS.due;
  const dir = ui.sort.dir === 'desc' ? -1 : 1;
  const val = col.sortVal || col.get;
  rows.sort((a, b) => {
    const x = val(a), y = val(b);
    const n = typeof x === 'number' && typeof y === 'number'
      ? x - y : String(x).localeCompare(String(y));
    return n * dir || prioRank(a.priority) - prioRank(b.priority);
  });
  return rows;
}

export const anyColFilter = ui =>
  !!(ui.col.task || ui.col.overdue ||
     ['project', 'division', 'assignee', 'priority', 'status', 'tag'].some(k => ui.col[k]?.length));

/* ---------- board ordering ---------------------------------------------- */

const GAP = 1000;
const laneOf = (rows, status) => rows.filter(t => t.status === status)
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.created || 0) - (b.created || 0));

/** The order value that puts a task at the very top of a lane. */
export function topOrder(status, state = S.get()) {
  const first = (state.tasks || []).filter(t => t.status === status)
    .reduce((m, t) => Math.min(m, t.order ?? 0), Infinity);
  return first === Infinity ? GAP : first - GAP;
}

/**
 * Where a card lands, expressed as an order value.
 *
 * Midway between its new neighbours, so one drop rewrites one task and the
 * rest of the lane is untouched. When the two neighbours have collapsed onto
 * the same number — possible after enough drops — the lane is renumbered,
 * which is the only case that writes more than one task.
 */
function orderAt(status, index, movingId) {
  const lane = laneOf(S.get().tasks, status).filter(t => t.id !== movingId);
  const before = lane[index - 1], after = lane[index];
  if (!before && !after) return GAP;
  if (!before) return (after.order ?? GAP) - GAP;
  if (!after)  return (before.order ?? 0) + GAP;
  const gap = (after.order ?? 0) - (before.order ?? 0);
  if (gap > 1) return (before.order ?? 0) + Math.floor(gap / 2);

  S.mutate(s => {
    laneOf(s.tasks, status).forEach((t, i) => { t.order = (i + 1) * GAP; });
  }, { silent: true, label: 'renumber lane' });
  const re = laneOf(S.get().tasks, status).filter(t => t.id !== movingId);
  const b2 = re[index - 1];
  return b2 ? (b2.order ?? 0) + Math.floor(GAP / 2) : GAP / 2;
}

/* ---------- rendering: toolbar ------------------------------------------ */

function toolbar(ui, scope) {
  const s = S.get();
  const opt = (list, sel, blank) =>
    `<option value="">${esc(blank)}</option>` +
    list.map(o => `<option value="${esc(o.v)}"${o.v === sel ? ' selected' : ''}>${esc(o.t)}</option>`).join('');

  return h`
  <div class="toolbar">
    <div class="seg">
      <button data-act="mode" data-v="board" class="${ui.mode === 'board' ? 'on' : ''}">Board</button>
      <button data-act="mode" data-v="list"  class="${ui.mode === 'list'  ? 'on' : ''}">List</button>
    </div>
    <div class="search" style="width:${scope.projectId ? 200 : 230}px">
      ${icon('search')}
      <input type="search" data-tq placeholder="Search tasks…" value="${ui.q}">
    </div>
    ${raw(scope.projectId ? '' : `
      <select data-change="f" data-k="project" style="width:auto">
        ${opt(s.projects.map(p => ({ v: p.id, t: p.name })), ui.project, 'All projects')}
      </select>`)}
    <select data-change="f" data-k="division" style="width:auto">
      ${raw(opt(s.divisions.map(d => ({ v: d.id, t: d.name })), ui.division, 'All divisions'))}
    </select>
    <select data-change="f" data-k="assignee" style="width:auto">
      ${raw(opt(s.people.map(p => ({ v: p.id, t: p.name })), ui.assignee, 'Anyone'))}
    </select>
    <select data-change="f" data-k="priority" style="width:auto">
      ${raw(opt(PRIORITIES.map(p => ({ v: p.id, t: p.label })), ui.priority, 'Any priority'))}
    </select>
    <label class="row tiny" style="gap:6px;cursor:pointer">
      <input type="checkbox" data-change="done" ${ui.showDone ? 'checked' : ''}> Show done
    </label>
    <div class="spacer"></div>
    ${raw(ui.mode === 'list' && anyColFilter(ui)
      ? '<button class="btn sm subtle" data-act="clearcols">Clear column filters</button>' : '')}
    ${raw(anyFilter(ui) ? '<button class="btn sm subtle" data-act="clear">Clear filters</button>' : '')}
    <button class="btn sm subtle" data-act="export" title="Export the filtered list as CSV">${icon('down')}CSV</button>
    <button class="btn sm subtle" data-act="import" title="Import tasks from CSV">${icon('up')}Import</button>
  </div>`;
}
const anyFilter = ui => ui.project || ui.division || ui.assignee || ui.priority || ui.q;

/* ---------- rendering: cards and board ---------------------------------- */

const ini = n => String(n).trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
function avColor(n) {
  let x = 0; for (const c of String(n)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  const hues = [206, 262, 340, 22, 160, 288, 12, 190, 44, 320];
  return `hsl(${hues[x % hues.length]} 52% 46%)`;
}

function taskCard(t, ui) {
  const s = S.get();
  const p = S.byId(s.projects, t.project);
  const d = S.byId(s.divisions, t.division);
  const who = S.byId(s.people, t.assignee);
  const late = t.due && t.due < today() && t.status !== 'done';
  const cl = (t.checklist || []);
  const doneN = cl.filter(x => x.done).length;
  const picked = ui.sel.has(t.id);
  const obj = t.objectiveId ? S.byId(s.objectives, t.objectiveId) : null;

  return h`
  <div class="tcard p-${t.priority || 'normal'}${picked ? ' picked' : ''}" draggable="true" data-id="${t.id}">
    <div class="tc-head">
      <input type="checkbox" class="tc-pick" data-act="pick" ${picked ? 'checked' : ''}
             title="Select for Jira" aria-label="Select task">
      <div class="t" data-act="open">${t.title}</div>
    </div>
    <div class="meta" data-act="open">
      ${raw(p ? `<span class="chip" style="background:${p.color}22;color:${p.color}">${esc(p.code)}</span>` : '')}
      ${raw(d ? `<span class="pill-div" style="background:${d.color}">${esc(d.id)}</span>` : '')}
      ${raw(t.jira?.key ? `<span class="chip tiny ok" title="In Jira">${esc(t.jira.key)}</span>`
            : t.jira?.state === 'queued' ? '<span class="chip tiny warn" title="Queued for Jira">queued</span>' : '')}
      ${raw(obj ? `<span class="chip tiny info" title="${esc(obj.title)}">◎ ${esc(obj.quarter || 'OKR')}</span>` : '')}
      ${raw(t.due ? `<span class="${late ? 'overdue' : ''}">${esc(fmtDate(t.due))}</span>` : '')}
      ${raw(cl.length ? `<span title="Checklist">☑ ${doneN}/${cl.length}</span>` : '')}
      ${raw(t.estimate ? `<span title="Estimate">${t.estimate}h</span>` : '')}
      <span class="spacer"></span>
      ${raw(who ? `<span class="avatar xs" style="background:${avColor(who.name)}" title="${esc(who.name)}">${esc(ini(who.name))}</span>` : '')}
    </div>
  </div>`;
}

function board(rows, ui) {
  const lanes = STATUSES.filter(st => ui.showDone || st.id !== 'done');
  const g = groupBy(rows, t => t.status);
  return h`<div class="board">${raw(lanes.map(st => {
    /* Hand order only. See the note at the top of the file. */
    const items = (g[st.id] || []).slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.created || 0) - (b.created || 0));
    return `<section class="lane" data-lane="${st.id}">
      <header>
        <span class="dot" style="width:8px;height:8px;border-radius:50%;background:${st.color}"></span>
        <b>${esc(st.label)}</b><span class="count">${items.length}</span>
        <span class="spacer" style="flex:1"></span>
        <button class="btn icon sm subtle" data-act="quick" data-s="${st.id}" title="Add at the top">
          <svg class="ico"><use href="#i-plus"></use></svg></button>
      </header>
      <div class="stack">${items.map(t => taskCard(t, ui)).join('')}<div class="drop-end"></div></div>
    </section>`;
  }).join(''))}</div>`;
}

/* ---------- rendering: list -------------------------------------------- */

/** A column header with its filter/sort button. */
function th(key, ui, extra = '') {
  const col = COLUMNS[key];
  const active = key === 'task' ? !!ui.col.task
    : key === 'due' ? !!ui.col.overdue
    : !!(ui.col[key]?.length);
  const sorted = ui.sort.by === key;
  return `<th ${extra}>
    <span class="th-in">
      <span>${esc(col.label)}</span>
      <button class="th-f${active ? ' on' : ''}${sorted ? ' sorted' : ''}" data-act="colf" data-c="${key}"
              title="Filter and sort ${esc(col.label)}">
        ${sorted ? (ui.sort.dir === 'asc' ? '↑' : '↓') : ''}
        <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
             stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>
      </button>
    </span></th>`;
}

function list(rows, ui) {
  if (!rows.length) {
    return h`<div class="card"><div class="empty"><h4>No tasks match</h4>
      <div class="tiny">${anyColFilter(ui) ? 'A column filter is hiding them.' : 'Adjust the filters above.'}</div></div></div>`;
  }
  const s = S.get();
  return h`
  <div class="card"><div class="tbl-wrap"><table class="tbl tbl-tasks">
    <thead><tr>
      <th style="width:26px" class="nofilter">
        <input type="checkbox" data-act="pickall" title="Select all shown"
               ${rows.length && rows.every(t => ui.sel.has(t.id)) ? 'checked' : ''}></th>
      <th style="width:26px" class="nofilter"></th>
      ${raw(th('task', ui))}${raw(th('project', ui))}${raw(th('division', ui))}${raw(th('assignee', ui))}
      ${raw(th('priority', ui))}${raw(th('status', ui))}${raw(th('due', ui))}${raw(th('estimate', ui, 'class="num"'))}
      <th class="nofilter"></th>
    </tr></thead>
    <tbody>${raw(rows.map(t => {
      const p = S.byId(s.projects, t.project);
      const d = S.byId(s.divisions, t.division);
      const late = t.due && t.due < today() && t.status !== 'done';
      const st = statusOf(t.status);
      const obj = t.objectiveId ? S.byId(s.objectives, t.objectiveId) : null;
      return `<tr data-id="${t.id}"${ui.sel.has(t.id) ? ' class="picked"' : ''}>
        <td><input type="checkbox" data-act="pick" ${ui.sel.has(t.id) ? 'checked' : ''} title="Select for Jira"></td>
        <td><input type="checkbox" data-act="toggle" ${t.status === 'done' ? 'checked' : ''} title="Mark done"></td>
        <td data-act="open" style="cursor:pointer">
          <div class="strong">${esc(t.title)}</div>
          <div class="tiny mute">
            ${(t.tags || []).map(x => `<span class="tag-x${String(x).toLowerCase() === IMPORTED_TAG.toLowerCase() ? ' imported' : ''}">#${esc(x)}</span>`).join(' ')}
            ${obj ? `<span class="tag-x obj" title="${esc(obj.title)}">◎ ${esc(obj.title)}</span>` : ''}
          </div>
        </td>
        <td>${p ? `<span class="chip" style="background:${p.color}22;color:${p.color}">${esc(p.code)}</span>` : '<span class="mute">—</span>'}</td>
        <td>${d ? `<span class="pill-div" style="background:${d.color}">${esc(d.id)}</span>` : ''}</td>
        <td class="tiny">${t.assignee ? esc(S.personName(t.assignee)) : '<span class="mute">Unassigned</span>'}</td>
        <td><span class="chip ${t.priority === 'critical' ? 'risk' : t.priority === 'high' ? 'warn' : ''}">${esc(t.priority || 'normal')}</span></td>
        <td><span class="chip" style="background:${st.color}22;color:${st.color}">${esc(st.label)}</span></td>
        <td class="tiny ${late ? 'overdue' : ''}">${t.due ? esc(fmtDate(t.due)) + ' <span class="mute">' + esc(relDays(t.due)) + '</span>' : '<span class="mute">—</span>'}</td>
        <td class="num tiny">${t.estimate || ''}</td>
        <td class="act"><button class="btn icon sm subtle" data-act="row-menu"><svg class="ico"><use href="#i-dots"></use></svg></button></td>
      </tr>`;
    }).join(''))}</tbody>
  </table></div></div>`;
}

/* ---------- the column filter popover ----------------------------------- */

/**
 * One popover per column: sort, then the values present.
 *
 * Only values that actually occur in the unfiltered rows are offered, with a
 * count each — a list of every person in the company when four of them have
 * tasks is a worse control than no control.
 */
function colPopover(key, anchor, ui, scope, rerender) {
  document.querySelector('.colpop')?.remove();
  const col = COLUMNS[key];
  const s = S.get();
  const pool = baseRows(ui, scope);

  const pop = document.createElement('div');
  pop.className = 'colpop';

  const sortBtns = `
    <div class="cp-sort">
      <button data-sort="asc"  class="${ui.sort.by === key && ui.sort.dir === 'asc' ? 'on' : ''}">
        ${col.kind === 'num' || col.kind === 'date' ? 'Oldest / lowest first' : 'A → Z'}</button>
      <button data-sort="desc" class="${ui.sort.by === key && ui.sort.dir === 'desc' ? 'on' : ''}">
        ${col.kind === 'num' || col.kind === 'date' ? 'Newest / highest first' : 'Z → A'}</button>
    </div>`;

  let bodyHtml = '';
  if (col.kind === 'text') {
    bodyHtml = `<label class="fld"><span>Contains</span>
      <input type="search" data-txt value="${esc(ui.col.task || '')}" placeholder="Type to filter…"></label>`;
  } else if (col.kind === 'date') {
    bodyHtml = `<label class="row tiny" style="gap:7px;cursor:pointer;padding:2px 0">
      <input type="checkbox" data-overdue ${ui.col.overdue ? 'checked' : ''}> Overdue only</label>`;
  } else if (col.kind === 'num') {
    bodyHtml = '<div class="tiny mute" style="padding:2px 0">Sort only.</div>';
  } else {
    const counts = new Map();
    for (const t of pool) {
      const v = col.get(t);
      for (const one of (Array.isArray(v) ? v : [v])) counts.set(one, (counts.get(one) || 0) + 1);
    }
    const labels = new Map((col.opts(s) || []).map(o => [o.v, o.t]));
    const present = [...counts.keys()].sort((a, b) =>
      String(labels.get(a) ?? a).localeCompare(String(labels.get(b) ?? b)));
    const chosen = ui.col[key] || [];

    bodyHtml = present.length ? `
      <div class="cp-tools">
        <button data-all>Select all</button><button data-none>Clear</button>
      </div>
      <div class="cp-list">${present.map(v => `
        <label><input type="checkbox" data-v="${esc(v)}" ${chosen.includes(v) ? 'checked' : ''}>
          <span>${esc(labels.get(v) ?? (v === '' ? '(none)' : v))}</span>
          <b>${counts.get(v)}</b></label>`).join('')}</div>`
      : '<div class="tiny mute" style="padding:2px 0">Nothing to filter on.</div>';
  }

  pop.innerHTML = `${sortBtns}<div class="sep"></div>${bodyHtml}`;
  document.body.appendChild(pop);

  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.min(r.bottom + 6, innerHeight - pop.offsetHeight - 10)}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left - 6, innerWidth - pop.offsetWidth - 10))}px`;

  const commit = () => { saveState(scope.key, ui); rerender(); };
  const setPick = list => { ui.col[key] = list; commit(); };

  pop.querySelectorAll('[data-sort]').forEach(b => b.onclick = () => {
    ui.sort = { by: key, dir: b.dataset.sort };
    // Sorting the list means looking at it in order, so switch to it.
    if (ui.mode !== 'list') ui.mode = 'list';
    pop.remove(); commit();
  });
  pop.querySelector('[data-txt]')?.addEventListener('input', e => {
    ui.col.task = e.target.value; saveState(scope.key, ui);
    clearTimeout(pop._d); pop._d = setTimeout(rerender, 250);
  });
  pop.querySelector('[data-overdue]')?.addEventListener('change', e => {
    ui.col.overdue = e.target.checked; commit();
  });
  pop.querySelector('[data-all]')?.addEventListener('click', () =>
    setPick([...pop.querySelectorAll('[data-v]')].map(i => i.dataset.v)));
  pop.querySelector('[data-none]')?.addEventListener('click', () => setPick([]));
  pop.querySelectorAll('[data-v]').forEach(i => i.onchange = () =>
    setPick([...pop.querySelectorAll('[data-v]:checked')].map(x => x.dataset.v)));

  const away = e => {
    if (pop.contains(e.target) || anchor.contains(e.target)) return;
    pop.remove(); document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esckey);
  };
  const esckey = e => { if (e.key === 'Escape') { pop.remove(); document.removeEventListener('mousedown', away); } };
  setTimeout(() => { document.addEventListener('mousedown', away); document.addEventListener('keydown', esckey); }, 0);
}

/* ---------- the selection bar ------------------------------------------- */

function selectionBar(ui) {
  const n = ui.sel.size;
  if (!n) return '';
  const tasks = S.get().tasks.filter(t => ui.sel.has(t.id));
  const done = tasks.filter(t => t.jira?.key).length;
  return h`
  <div class="selbar">
    <b>${n}</b> selected
    ${raw(done ? `<span class="tiny mute">${done} already in Jira</span>` : '')}
    <span class="spacer" style="flex:1"></span>
    <button class="btn sm subtle" data-act="sel-status">Set status…</button>
    <button class="btn sm subtle" data-act="sel-none">Clear</button>
    <button class="btn sm primary" data-act="sel-jira">${icon('link')}Queue ${n} for Jira</button>
  </div>`;
}

/* ---------- the panel --------------------------------------------------- */

/**
 * Render the whole thing into `host`.
 *
 * @param {HTMLElement} host
 * @param {object} ctx      the view context (rerender, params, go)
 * @param {object} opt
 * @param {string} [opt.projectId]  scope to one project; hides the project filter
 * @param {string} [opt.key]        localStorage key, so two panels keep their own view
 * @param {boolean} [opt.stats]     show the summary line (default true)
 */
export function taskPanel(host, ctx, opt = {}) {
  const scope = { projectId: opt.projectId || '', key: opt.key || 'gfxprod.ui.tasks' };
  const ui = panelState(scope.key);
  const rerender = () => taskPanel(host, ctx, opt);

  // A task deleted elsewhere must not stay selected.
  const live = new Set(S.get().tasks.map(t => t.id));
  for (const id of [...ui.sel]) if (!live.has(id)) ui.sel.delete(id);

  const rows = ui.mode === 'list' ? listRows(ui, scope) : baseRows(ui, scope);
  const st = taskStats(t => rows.includes(t));

  host.innerHTML = h`
    ${raw(toolbar(ui, scope))}
    ${raw(opt.stats === false ? '' : `
      <div class="row wrap tiny mute" style="margin:-6px 0 12px">
        <span><b class="dim">${st.open}</b> open</span><span>·</span>
        <span class="${st.overdue ? 'overdue' : ''}"><b>${st.overdue}</b> overdue</span><span>·</span>
        <span><b class="dim">${st.dueSoon}</b> due in 7 days</span><span>·</span>
        <span><b class="dim">${st.blocked}</b> blocked</span><span>·</span>
        <span><b class="dim">${Math.round(st.estimate)}h</b> estimated remaining</span>
      </div>`)}
    <div data-selbar>${raw(selectionBar(ui))}</div>
    <div data-body></div>`;

  const bodyEl = host.querySelector('[data-body]');
  bodyEl.innerHTML = ui.mode === 'board' ? board(rows, ui) : list(rows, ui);

  /*
   * Everything a handler needs, hung off the host.
   *
   * `acts()` is delegated on `host`, and `host` survives a re-render — so
   * binding it per render stacked a second copy of every handler each time,
   * and after a few re-renders one click ran the handler several times over.
   * It is bound once, and reads the current render from here.
   */
  host.__tp = { ui, scope, rows, rerender, ctx };

  const q = host.querySelector('[data-tq]');
  let deb;
  q.addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(() => { ui.q = q.value; saveState(scope.key, ui); rerender(); }, 220);
  });

  if (!host.dataset.tpWired) { wirePanel(host); host.dataset.tpWired = '1'; }
  if (ui.mode === 'board') wireDnd(bodyEl, () => host.__tp.rerender());
}

/**
 * Bind the panel's handlers. Once per host, for the life of the element.
 *
 * Selection is updated in place rather than by re-rendering: it used to
 * re-render, and ticking a second box was then a click on a node that had
 * already been replaced, so the tick registered on nothing.
 */
function wirePanel(host) {
  const tp = () => host.__tp;

  const syncSel = () => {
    const { ui, rows } = tp();
    host.querySelector('[data-selbar]').innerHTML = selectionBar(ui);
    const all = host.querySelector('[data-act="pickall"]');
    if (all) all.checked = rows.length > 0 && rows.every(t => ui.sel.has(t.id));
  };
  const save = () => { const { scope, ui } = tp(); saveState(scope.key, ui); };
  const draw = () => tp().rerender();
  const drawView = () => { const { ctx, rerender } = tp(); (ctx.rerender || rerender)(); };

  acts(host, {
    mode: el => { tp().ui.mode = el.dataset.v; save(); draw(); },
    f: el => { tp().ui[el.dataset.k] = el.value; save(); draw(); },
    done: el => { tp().ui.showDone = el.checked; save(); draw(); },
    clear: () => {
      Object.assign(tp().ui, { project: '', division: '', assignee: '', priority: '', q: '' });
      save(); draw();
    },
    clearcols: () => { tp().ui.col = { ...DEFAULTS().col }; save(); draw(); },
    colf: el => { const { ui, scope, rerender } = tp(); colPopover(el.dataset.c, el, ui, scope, rerender); },
    export: () => exportCsv(tp().rows),
    import: () => importCsv(tp().scope).then(draw),
    quick: el => { const { ui, scope, rerender } = tp(); quickAdd(el.dataset.s, ui, scope, rerender); },
    open: el => editTask(el.closest('[data-id]').dataset.id).then(r => r && drawView()),

    pick: el => {
      const wrap = el.closest('[data-id]');
      const { ui } = tp();
      if (el.checked) ui.sel.add(wrap.dataset.id); else ui.sel.delete(wrap.dataset.id);
      wrap.classList.toggle('picked', el.checked);
      syncSel();
    },
    pickall: el => {
      const { ui, rows } = tp();
      if (el.checked) rows.forEach(t => ui.sel.add(t.id)); else rows.forEach(t => ui.sel.delete(t.id));
      host.querySelectorAll('[data-body] [data-id]').forEach(w =>
        w.classList.toggle('picked', ui.sel.has(w.dataset.id)));
      host.querySelectorAll('[data-body] [data-act="pick"]').forEach(cb => {
        cb.checked = ui.sel.has(cb.closest('[data-id]').dataset.id);
      });
      syncSel();
    },
    'sel-none': () => { tp().ui.sel.clear(); draw(); },
    'sel-jira': async () => {
      const { ui } = tp();
      const ok = await bulkQueueDialog([...ui.sel]);
      if (ok) ui.sel.clear();
      drawView();
    },
    'sel-status': (el, ev) => menu(ev, STATUSES.map(s2 => ({
      label: 'Move to ' + s2.label, icon: 'check',
      run: () => {
        const ids = [...tp().ui.sel];
        S.mutate(state => {
          let o = topOrder(s2.id, state);
          for (const id of ids) {
            const t = state.tasks.find(x => x.id === id);
            if (t) { t.status = s2.id; t.order = o; o -= GAP; }
          }
        }, { label: 'move tasks' });
        toast(`${ids.length} moved to ${s2.label}`, 'ok');
        tp().ui.sel.clear();
        draw();
      },
    }))),

    toggle: el => {
      const id = el.closest('[data-id]').dataset.id;
      const t = S.byId(S.get().tasks, id);
      S.update('tasks', id, { status: t.status === 'done' ? 'doing' : 'done' });
      draw();
    },
    'row-menu': (el, ev) => rowMenu(el.closest('[data-id]').dataset.id, ev, draw),
  });
}

/** Reset a panel's selection — used when a view unmounts. */
export const clearSelection = key => panels.get(key)?.sel.clear();

/* ---------- add, edit, menu -------------------------------------------- */

function quickAdd(status, ui, scope, rerender) {
  formDlg('Quick add', [
    { k: 'title', label: 'Title', required: true, span: 12 },
    { k: 'due', label: 'Due', type: 'date', span: 6 },
    { k: 'estimate', label: 'Estimate (h)', type: 'number', span: 6, min: 0, step: '0.5' },
  ], { ok: 'Add' }).then(v => {
    if (!v) return;
    S.add('tasks', {
      title: v.title, status, priority: 'normal',
      project: scope.projectId || ui.project || '', division: ui.division || '', assignee: ui.assignee || '',
      due: v.due || '', estimate: v.estimate || 0, spent: 0, tags: [], checklist: [], desc: '',
      objectiveId: null, order: topOrder(status),
    });
    toast('Task added', 'ok'); rerender();
  });
}

function rowMenu(id, ev, rerender) {
  const t = S.byId(S.get().tasks, id);
  menu(ev, [
    { label: 'Edit…', icon: 'edit', run: () => editTask(id).then(r => r && rerender()) },
    { label: 'Duplicate', icon: 'file', run: () => {
      const { id: _i, created, jira, ...rest } = t;
      S.add('tasks', { ...rest, title: t.title + ' (copy)', order: topOrder(t.status) });
      rerender();
    } },
    { label: t.jira?.key ? `Open ${t.jira.key}` : 'Push to Jira…', icon: 'link',
      run: () => (t.jira?.url
        ? window.open(t.jira.url, '_blank', 'noopener')
        : pushDialog(id).then(r => r && rerender())) },
    { label: 'Move to top of lane', icon: 'up',
      run: () => { S.update('tasks', id, { order: topOrder(t.status) }); rerender(); } },
    ...STATUSES.filter(s => s.id !== t.status).slice(0, 3).map(s => ({
      label: 'Move to ' + s.label, icon: 'check',
      run: () => { S.update('tasks', id, { status: s.id, order: topOrder(s.id) }); rerender(); },
    })),
    '-',
    { label: 'Delete', icon: 'trash', danger: true, run: async () => {
      if (await confirmDlg(`Delete “${t.title}”?`, { ok: 'Delete' })) { S.remove('tasks', id); rerender(); }
    } },
  ]);
}

/**
 * The task editor.
 *
 * New tasks default to the top of Backlog — that is where an unplanned thing
 * belongs, and having to drag every new card out of the middle of a lane was
 * the reason the board felt unusable.
 */
export async function editTask(id, preset = {}) {
  const s = S.get();
  const t = id ? S.byId(s.tasks, id) : null;
  const v = t || {
    title: '', status: 'backlog', priority: 'normal', project: preset.project || '', division: '',
    assignee: '', due: '', estimate: '', spent: '', desc: '', tags: [], checklist: [],
    objectiveId: null, ...preset,
  };

  const sel = (list, cur, blank) =>
    (blank ? `<option value="">${esc(blank)}</option>` : '') +
    list.map(o => `<option value="${esc(o.v)}"${String(o.v) === String(cur ?? '') ? ' selected' : ''}>${esc(o.t)}</option>`).join('');

  const objs = s.objectives.slice().sort((a, b) =>
    String(b.quarter || '').localeCompare(String(a.quarter || '')) || a.title.localeCompare(b.title));

  const body = `
  <div style="display:grid;grid-template-columns:repeat(12,1fr);gap:0 12px">
    <label class="fld" style="grid-column:span 12"><span>Title *</span>
      <input id="e_title" value="${esc(v.title)}" placeholder="What needs to happen?"></label>

    <label class="fld" style="grid-column:span 6"><span>Project</span>
      <select id="e_project">${sel(s.projects.map(p => ({ v: p.id, t: p.name })), v.project, 'None / cross-project')}</select></label>
    <label class="fld" style="grid-column:span 6"><span>Division</span>
      <select id="e_division">${sel(s.divisions.map(d => ({ v: d.id, t: d.name })), v.division, 'Not division-specific')}</select>
      <span class="hint" id="e_lbl"></span></label>

    <label class="fld" style="grid-column:span 6"><span>Assignee</span>
      <select id="e_assignee">${sel(s.people.filter(p => p.active !== false).map(p => ({ v: p.id, t: `${p.name} · ${p.role}` })), v.assignee, 'Unassigned')}</select></label>
    <label class="fld" style="grid-column:span 3"><span>Status</span>
      <select id="e_status">${sel(STATUSES.map(x => ({ v: x.id, t: x.label })), v.status)}</select></label>
    <label class="fld" style="grid-column:span 3"><span>Priority</span>
      <select id="e_priority">${sel(PRIORITIES.map(x => ({ v: x.id, t: x.label })), v.priority)}</select></label>

    <label class="fld" style="grid-column:span 4"><span>Due</span>
      <input type="date" id="e_due" value="${esc(v.due || '')}"></label>
    <label class="fld" style="grid-column:span 4"><span>Estimate (h)</span>
      <input type="number" id="e_estimate" min="0" step="0.5" value="${v.estimate ?? ''}"></label>
    <label class="fld" style="grid-column:span 4"><span>Spent (h)</span>
      <input type="number" id="e_spent" min="0" step="0.5" value="${v.spent ?? ''}"></label>

    <label class="fld" style="grid-column:span 12"><span>Objective</span>
      <select id="e_obj">${sel(objs.map(o => ({ v: o.id, t: `${o.quarter || '—'} · ${o.title}` })), v.objectiveId, 'Not linked to an objective')}</select>
      <span class="hint">Every objective from the Objectives view. The objective shows its linked tasks and rolls their progress up.</span></label>

    <label class="fld" style="grid-column:span 12"><span>Notes</span>
      <textarea id="e_desc" rows="3" placeholder="Context, links, decisions…">${esc(v.desc || '')}</textarea></label>

    <label class="fld" style="grid-column:span 12"><span>Tags</span>
      <input id="e_tags" value="${esc((v.tags || []).join(', '))}" placeholder="milestone, finance, risk">
      <span class="hint">Comma separated. <code>${IMPORTED_TAG}</code> is added automatically once a task is filed in Jira.</span></label>

    <div class="fld" style="grid-column:span 12">
      <span style="display:block;font-size:11.5px;font-weight:600;color:var(--text-dim);margin-bottom:4px">Checklist</span>
      <div id="e_cl"></div>
      <button type="button" class="btn sm subtle" id="e_cladd" style="margin-top:6px">
        <svg class="ico"><use href="#i-plus"></use></svg>Add step</button>
      <span class="hint">Each step becomes a Jira <b>sub-task</b> of this task's issue when it is filed.
        Steps added later are filed on the next push; the ones already there are not duplicated.</span>
    </div>
  </div>`;

  const res = await dialog({
    title: t ? 'Edit task' : 'New task', wide: true, body,
    footer: `${t ? '<button class="btn danger" data-del>Delete</button>' : ''}<div class="spacer" style="flex:1"></div>
             <button class="btn" data-no>Cancel</button><button class="btn primary" data-ok>${t ? 'Save' : 'Create'}</button>`,
    onMount: ({ root, close }) => {
      /* Show what the division will put on the Jira ticket, at the moment the
         division is chosen — the rule is invisible otherwise, and a label
         nobody can see is a label nobody trusts. */
      const divSel = root.querySelector('#e_division');
      const lbl = root.querySelector('#e_lbl');
      const showLabel = () => {
        const l = divisionLabel(divSel.value);
        lbl.innerHTML = l
          ? `Jira label <code>${esc(l)}</code> is applied automatically.`
          : 'No Jira label is implied by this division.';
      };
      divSel.addEventListener('change', showLabel); showLabel();

      const clWrap = root.querySelector('#e_cl');
      let cl = JSON.parse(JSON.stringify(v.checklist || []));
      const drawCl = () => {
        clWrap.innerHTML = cl.map((c, i) => `
          <div class="row" style="margin-bottom:5px">
            <input type="checkbox" data-ck="${i}" ${c.done ? 'checked' : ''}>
            <input type="text" data-ct="${i}" value="${esc(c.t)}" style="flex:1">
            ${c.jiraKey
              ? `<a class="chip tiny ok" href="${esc(c.jiraUrl || '#')}" target="_blank" rel="noopener"
                    title="Filed as a Jira sub-task">${esc(c.jiraKey)}</a>`
              : c.jiraErr
                ? `<span class="chip tiny risk" title="${esc(c.jiraErr)}">not filed</span>`
                : '<span class="chip tiny" style="opacity:.45" title="Will be filed as a Jira sub-task">sub-task</span>'}
            <button type="button" class="btn icon sm subtle" data-cd="${i}"><svg class="ico"><use href="#i-x"></use></svg></button>
          </div>`).join('') || '<div class="tiny mute">No steps yet.</div>';
      };
      drawCl();
      clWrap.addEventListener('click', e => {
        const d = e.target.closest('[data-cd]'); if (d) { cl.splice(+d.dataset.cd, 1); drawCl(); }
      });
      clWrap.addEventListener('change', e => {
        const k = e.target.closest('[data-ck]'); if (k) cl[+k.dataset.ck].done = k.checked;
      });
      clWrap.addEventListener('input', e => {
        const x = e.target.closest('[data-ct]'); if (x) cl[+x.dataset.ct].t = x.value;
      });
      root.querySelector('#e_cladd').onclick = () => {
        cl.push({ t: '', done: false }); drawCl();
        clWrap.querySelector('[data-ct="' + (cl.length - 1) + '"]')?.focus();
      };

      root.querySelector('[data-no]').onclick = () => close(undefined);
      root.querySelector('[data-del]')?.addEventListener('click', async () => {
        if (await confirmDlg(`Delete “${t.title}”?`, { ok: 'Delete' })) close({ __delete: true });
      });
      root.querySelector('[data-ok]').onclick = () => {
        const g = k => root.querySelector('#e_' + k).value;
        if (!g('title').trim()) { root.querySelector('#e_title').focus(); return toast('A title is required', 'warn'); }
        close({
          title: g('title').trim(), project: g('project'), division: g('division'),
          assignee: g('assignee'), status: g('status'), priority: g('priority'),
          due: g('due'), estimate: g('estimate') === '' ? 0 : +g('estimate'),
          spent: g('spent') === '' ? 0 : +g('spent'), desc: g('desc'),
          objectiveId: g('obj') || null,
          tags: g('tags').split(',').map(x => x.trim()).filter(Boolean),
          checklist: cl.filter(c => c.t.trim()),
        });
      };
    },
  });

  if (!res) return null;
  if (res.__delete) { S.remove('tasks', id); toast('Task deleted', 'ok'); return 'deleted'; }
  if (t) {
    // Moving lane by hand in the editor should still land it somewhere sane.
    const patch = res.status !== t.status ? { ...res, order: topOrder(res.status) } : res;
    S.update('tasks', id, patch);
    toast('Task saved', 'ok');
  } else {
    S.add('tasks', { ...res, order: topOrder(res.status) });
    toast(`Task created at the top of ${statusOf(res.status).label}`, 'ok');
  }
  return 'saved';
}

/* ---------- drag & drop ------------------------------------------------- */

/**
 * Drag to reorder within a lane, and to move between lanes.
 *
 * The insertion point is worked out from the pointer against the midpoint of
 * each card, and shown with a placeholder line, because dropping a card into
 * a twenty-card lane and hoping is not ordering.
 */
function wireDnd(root, rerender) {
  let dragId = null, ph = null;

  const placeholder = () => {
    if (!ph) { ph = document.createElement('div'); ph.className = 'tcard-ph'; }
    return ph;
  };

  root.addEventListener('dragstart', e => {
    const c = e.target.closest('.tcard');
    if (!c) return;
    dragId = c.dataset.id;
    c.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });

  root.addEventListener('dragend', () => {
    root.querySelector('.tcard.dragging')?.classList.remove('dragging');
    ph?.remove();
    $$('.lane', root).forEach(l => l.classList.remove('drop'));
  });

  root.addEventListener('dragover', e => {
    if (!dragId) return;
    const lane = e.target.closest('.lane');
    if (!lane) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    $$('.lane', root).forEach(l => l.classList.toggle('drop', l === lane));

    const stack = lane.querySelector('.stack');
    const cards = [...stack.querySelectorAll('.tcard')].filter(c => c.dataset.id !== dragId);
    const p = placeholder();
    const beforeEl = cards.find(c => {
      const r = c.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    if (beforeEl) stack.insertBefore(p, beforeEl);
    else stack.insertBefore(p, stack.querySelector('.drop-end'));
  });

  root.addEventListener('drop', e => {
    const lane = e.target.closest('.lane');
    if (!lane || !dragId) return;
    e.preventDefault();

    const status = lane.dataset.lane;
    const stack = lane.querySelector('.stack');
    /* Index among the cards that will still be there, which is what
       orderAt() counts. */
    const siblings = [...stack.children].filter(el =>
      (el.classList.contains('tcard') && el.dataset.id !== dragId) || el === ph);
    const index = Math.max(0, siblings.indexOf(ph));

    const id = dragId;
    dragId = null;
    ph?.remove();

    const t = S.byId(S.get().tasks, id);
    if (!t) return rerender();
    const order = orderAt(status, index === -1 ? siblings.length : index, id);
    const moved = t.status !== status;
    S.update('tasks', id, { status, order });
    if (moved) toast(`Moved to ${statusOf(status).label}`, '', 1400);
    rerender();
  });
}

/* ---------- csv --------------------------------------------------------- */

function exportCsv(rows) {
  const out = rows.map(t => ({
    Title: t.title, Project: S.projectName(t.project), Division: t.division || '',
    Assignee: S.personName(t.assignee), Status: t.status, Priority: t.priority,
    Due: t.due || '', Estimate: t.estimate || '', Spent: t.spent || '',
    Objective: t.objectiveId ? (S.byId(S.get().objectives, t.objectiveId)?.title || '') : '',
    JiraKey: t.jira?.key || '', Tags: (t.tags || []).join(' '), Notes: t.desc || '',
  }));
  download(`gfx-tasks-${today()}.csv`, toCsv(out), 'text/csv;charset=utf-8');
  toast(`${out.length} tasks exported`, 'ok');
}

async function importCsv(scope) {
  const f = await pickFile('.csv');
  if (!f) return;
  let rows;
  try { rows = parseCsv(f.text); } catch (e) { return toast('Could not read that CSV: ' + e.message, 'err'); }
  if (!rows.length) return toast('That file had no rows.', 'warn');

  const s = S.get();
  const findProj = v => s.projects.find(p => [p.name, p.code, p.id].some(x => x?.toLowerCase() === String(v).toLowerCase()))?.id || '';
  const findPers = v => s.people.find(p => p.name.toLowerCase() === String(v).toLowerCase())?.id || '';
  const findObj  = v => s.objectives.find(o => o.title.toLowerCase() === String(v).toLowerCase())?.id || null;
  const mapped = rows.map(r => ({
    title: r.Title || r.title || r.Summary || '(untitled)',
    project: findProj(r.Project || r.project) || scope.projectId || '',
    division: (r.Division || r.division || '').toUpperCase() || '',
    assignee: findPers(r.Assignee || r.assignee),
    status: (r.Status || 'backlog').toLowerCase(),
    priority: (r.Priority || 'normal').toLowerCase(),
    due: r.Due || r.due || '',
    estimate: Number(r.Estimate || 0) || 0,
    objectiveId: findObj(r.Objective || r.objective),
    tags: String(r.Tags || '').split(/[ ,]+/).filter(Boolean),
    desc: r.Notes || r.Description || '',
  }));

  const ok = await confirmDlg(`Import ${mapped.length} tasks from ${f.name}? Existing tasks are untouched.`,
                              { title: 'Import tasks', ok: 'Import', danger: false });
  if (!ok) return;
  S.mutate(st => {
    /* Newest at the top of their lane, in file order. */
    const tops = {};
    mapped.forEach(m => {
      tops[m.status] ??= topOrder(m.status, st);
      st.tasks.push({ id: S.uid('tsk'), created: Date.now(), checklist: [], ...m, order: tops[m.status] });
      tops[m.status] -= GAP;
    });
  }, { label: 'import tasks' });
  toast(`${mapped.length} tasks imported`, 'ok');
}
