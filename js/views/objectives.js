/* ============================================================================
   views/objectives.js — OKRs: objectives, key results, check-ins.
   ========================================================================= */

import * as S from '../store.js';
import {
  h, raw, esc, icon, toast, dialog, confirmDlg, formDlg, menu, acts, bar,
  fmtDate, fmtNum, today, quarterOf, daysBetween, groupBy, sum,
} from '../ui.js';
import { krProgress, objProgress } from '../calc.js';
import { editTask } from '../taskui.js';
import { milestonePanel, wireMilestones } from '../timeline.js';

const STATUS = [
  { id: 'on-track',  label: 'On track',  chip: 'ok' },
  { id: 'at-risk',   label: 'At risk',   chip: 'warn' },
  { id: 'off-track', label: 'Off track', chip: 'risk' },
  { id: 'done',      label: 'Achieved',  chip: 'info' },
  { id: 'dropped',   label: 'Dropped',   chip: '' },
];
const statusOf = id => STATUS.find(s => s.id === id) || STATUS[0];

/* The same four a project milestone uses, so the timeline colours agree. */
const MS_STATUS = [
  { id: 'planned', label: 'Planned', chip: '' },
  { id: 'at-risk', label: 'At risk', chip: 'warn' },
  { id: 'done',    label: 'Done',    chip: 'ok' },
  { id: 'slipped', label: 'Slipped', chip: 'risk' },
];

const UI_KEY = 'gfxprod.ui.okr';
const ui = Object.assign({ quarter: '', owner: '', project: '' },
                         JSON.parse(localStorage.getItem(UI_KEY) || '{}'));
const saveUi = () => localStorage.setItem(UI_KEY, JSON.stringify(ui));

const quarters = () => [...new Set(S.get().objectives.map(o => o.quarter).concat(quarterOf(today())))].sort();

/* ---------- cards -------------------------------------------------------- */

/** Days until a date, or null when there isn't one. */
const daysTo = iso => (iso ? daysBetween(today(), iso) : null);

/** A due date rendered with its urgency, or nothing at all. */
function dueChip(iso, done) {
  if (!iso) return '';
  const n = daysTo(iso);
  const late = !done && n < 0;
  const soon = !done && n >= 0 && n <= 14;
  const cls = done ? 'ok' : late ? 'risk' : soon ? 'warn' : '';
  const word = done ? 'done' : late ? `${-n}d late` : n === 0 ? 'today' : `in ${n}d`;
  return `<span class="chip tiny ${cls}" title="Due ${esc(fmtDate(iso, 'long'))}">${esc(fmtDate(iso))} · ${esc(word)}</span>`;
}

/*
 * One objective.
 *
 * Restructured for reading rather than for fitting everything in. The old card
 * put the whole `why` inline as muted body text — fine for a sentence, a wall
 * for the paragraph a real SMART goal carries — and stacked key results,
 * owner, check-ins and buttons with no hierarchy between them. Now: a header
 * that answers "what, when, how far", `why` behind a disclosure, and the key
 * results, milestones and linked tasks as three labelled blocks.
 */
function card(o) {
  const s = S.get();
  const pct = objProgress(o);
  const st = statusOf(o.status);
  const proj = S.byId(s.projects, o.project);
  const div = o.division ? S.byId(s.divisions, o.division) : null;
  const linked = s.tasks.filter(t => t.objectiveId === o.id);
  const openLinked = linked.filter(t => t.status !== 'done');
  const last = (o.updates || []).at(-1);
  const krs = o.keyResults || [];
  const mss = (o.milestones || []).slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const doneKr = krs.filter(k => krProgress(k) >= 100).length;

  return h`
  <section class="card okr" data-id="${o.id}">
    <header style="align-items:flex-start">
      <div style="flex:1;min-width:0">
        <div class="row wrap" style="gap:6px;margin-bottom:4px">
          <span class="chip tiny ${st.chip}">${st.label}</span>
          <span class="chip tiny">${o.quarter || 'no quarter'}</span>
          ${raw(proj ? `<span class="chip tiny" style="background:${proj.color}22;color:${proj.color}">${esc(proj.code)}</span>` : '')}
          ${raw(div ? `<span class="pill-div" style="background:${esc(div.color)}">${esc(div.id)}</span>` : '')}
          ${raw(dueChip(o.due, o.status === 'done'))}
        </div>
        <h3 style="font-size:15px;line-height:1.35">${o.title}</h3>
        <div class="tiny mute" style="margin-top:4px">
          ${S.personName(o.owner) || 'Unassigned'}
          ${raw(o.start || o.due ? ` · ${esc(o.start ? fmtDate(o.start) : '—')} → ${esc(o.due ? fmtDate(o.due) : '—')}` : '')}
          ${raw(last
            ? ` · checked in ${esc(fmtDate(last.date))}`
            : ' · <span class="overdue">never checked in</span>')}
        </div>
      </div>
      <div style="text-align:right;flex:none;min-width:64px">
        <div class="okr-pct" style="font-size:23px;font-weight:650;line-height:1">${pct}<span style="font-size:13px">%</span></div>
        <div class="tiny mute">${doneKr}/${krs.length} KR${krs.length === 1 ? '' : 's'}</div>
      </div>
      <button class="btn icon sm subtle" data-act="menu"><svg class="ico"><use href="#i-dots"></use></svg></button>
    </header>

    <div class="body">
      <!-- wrapped so the in-place progress update has a stable hook: bar()
           returns the span itself, and the card has other bars inside it -->
      <span class="okr-prog">${bar(pct, pct >= 70 ? 'ok' : pct >= 40 ? 'warn' : 'risk')}</span>

      ${raw(o.why ? `<details class="okr-why" style="margin-top:10px">
        <summary class="tiny mute" style="cursor:pointer">Why it matters</summary>
        <div class="tiny" style="margin-top:6px;line-height:1.7;white-space:pre-wrap">${esc(o.why)}</div>
      </details>` : '')}

      <div class="okr-sec">
        <div class="okr-sec-h">
          <span>Key results</span>
          <button class="btn sm subtle" data-act="kr-add">${icon('plus')}Add</button>
        </div>
        ${raw(krs.length
          ? `<div class="okr-krs">${krs.map(k => krRow(o, k)).join('')}</div>`
          : '<div class="tiny mute">None yet — a bare objective cannot be measured.</div>')}
      </div>

      <div class="okr-sec">
        <div class="okr-sec-h">
          <span>Milestones</span>
          <button class="btn sm subtle" data-act="ms-add">${icon('plus')}Add</button>
        </div>
        ${raw(mss.length ? `<div class="okr-krs">${mss.map(m => {
          const mst = MS_STATUS.find(x => x.id === m.status) || MS_STATUS[0];
          const late = m.status !== 'done' && m.date && m.date < today();
          return `<div class="row okr-ms" data-ms="${esc(m.id)}" style="gap:8px;align-items:center">
            <span class="chip tiny ${late ? 'risk' : mst.chip}">${late ? 'Late' : esc(mst.label)}</span>
            <span class="tiny" style="flex:1;min-width:0">${esc(m.name)}</span>
            <span class="tiny mute nowrap">${m.start ? esc(fmtDate(m.start)) + ' → ' : ''}${esc(fmtDate(m.date, 'long'))}</span>
            <button class="btn icon sm subtle" data-act="ms-edit" title="Edit"><svg class="ico"><use href="#i-edit"></use></svg></button>
            <button class="btn icon sm subtle" data-act="ms-del" title="Remove"><svg class="ico"><use href="#i-x"></use></svg></button>
          </div>`;
        }).join('')}</div>` : '<div class="tiny mute">No dated checkpoints. Add one and it appears on the timeline above.</div>')}
      </div>

      <div class="okr-sec">
        <div class="okr-sec-h">
          <span>Tasks</span>
          <button class="btn sm subtle" data-act="task-add">${icon('plus')}New task</button>
        </div>
        ${raw(linked.length ? `
          <div class="tiny mute" style="margin-bottom:6px">${openLinked.length} of ${linked.length} open</div>
          <div class="okr-krs">${linked.slice()
            .sort((a, b) => (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0)
                          || (a.due || '9999').localeCompare(b.due || '9999'))
            .slice(0, 6).map(t => `
            <div class="row okr-task" data-t="${esc(t.id)}" style="gap:8px;align-items:center">
              <span class="chip tiny ${t.status === 'done' ? 'ok' : ''}">${esc(t.status)}</span>
              <span class="tiny" style="flex:1;min-width:0${t.status === 'done' ? ';text-decoration:line-through;opacity:.65' : ''}">${esc(t.title)}</span>
              ${t.due ? `<span class="tiny ${t.status !== 'done' && t.due < today() ? 'overdue' : 'mute'} nowrap">${esc(fmtDate(t.due))}</span>` : ''}
              <button class="btn sm subtle" data-act="task-open">Open</button>
            </div>`).join('')}</div>
          ${linked.length > 6 ? `<div class="tiny mute" style="margin-top:6px">+ ${linked.length - 6} more · <button class="btn sm subtle" data-act="task-all">See all in Tasks</button></div>` : ''}
        ` : '<div class="tiny mute">Nothing linked yet. A new task here is assigned to this objective automatically.</div>')}
      </div>

      <div class="row wrap" style="margin-top:12px;gap:8px">
        <button class="btn sm subtle" data-act="checkin">${icon('note')}Check in</button>
        <button class="btn sm subtle" data-act="edit">${icon('edit')}Edit</button>
        <div class="spacer" style="flex:1"></div>
        ${raw((o.updates || []).length ? `<span class="tiny mute">${o.updates.length} check-in${o.updates.length > 1 ? 's' : ''}</span>` : '')}
      </div>

      ${raw((o.updates || []).length ? `
        <details style="margin-top:8px">
          <summary class="tiny mute" style="cursor:pointer">Check-in history</summary>
          <div style="margin-top:8px;display:flex;flex-direction:column;gap:7px">
            ${o.updates.slice().reverse().map(u => `
              <div style="border-left:2px solid var(--line);padding-left:9px">
                <div class="tiny mute">${esc(fmtDate(u.date, 'long'))} · ${esc(S.personName(u.by))}</div>
                <div class="tiny">${esc(u.text)}</div>
              </div>`).join('')}
          </div>
        </details>` : '')}
    </div>
  </section>`;
}

function krRow(o, k) {
  const p = krProgress(k);
  const cls = p >= 100 ? 'ok' : p >= 50 ? '' : p >= 25 ? 'warn' : 'risk';
  return `
  <div class="okr-kr" data-kr="${k.id}">
    <div style="min-width:0">
      <div class="tiny" style="margin-bottom:4px;line-height:1.45">${esc(k.text)}
        ${k.start && k.due ? `<span class="tiny mute nowrap">${esc(fmtDate(k.start))} →</span>` : ''}
        ${k.due ? dueChip(k.due, p >= 100) : ''}</div>
      <span class="bar thin"><i class="${cls}" style="width:${p}%"></i></span>
    </div>
    <div class="row" style="flex:none;gap:5px;align-items:center">
      <input type="number" data-input="kr-cur" value="${k.current ?? 0}" step="any"
             style="width:70px;height:26px;text-align:right" title="Current value">
      <span class="tiny mute nowrap">/ ${esc(k.target)} ${esc(k.unit || '')}${k.invert ? ' ↓' : ''}</span>
      <span class="okr-kr-pct">${p}%</span>
      <button class="btn icon sm subtle" data-act="kr-edit" title="Edit"><svg class="ico"><use href="#i-edit"></use></svg></button>
      <button class="btn icon sm subtle" data-act="kr-del" title="Remove"><svg class="ico"><use href="#i-x"></use></svg></button>
    </div>
  </div>`;
}

/* ---------- dialogs ------------------------------------------------------ */

async function editObjective(id) {
  const s = S.get();
  const o = id ? S.byId(s.objectives, id) : null;
  const v = o || { title: '', why: '', quarter: quarterOf(today()), start: '', due: '',
                   owner: s.people.find(p => p.isMe)?.id || '', project: '', division: '',
                   status: 'on-track', keyResults: [], milestones: [], updates: [] };
  const sel = (list, cur, blank) => (blank ? `<option value="">${esc(blank)}</option>` : '') +
    list.map(x => `<option value="${esc(x.v)}"${String(x.v) === String(cur ?? '') ? ' selected' : ''}>${esc(x.t)}</option>`).join('');

  const res = await dialog({
    title: o ? 'Edit objective' : 'New objective', wide: true,
    body: `<div style="display:grid;grid-template-columns:repeat(12,1fr);gap:0 12px">
      <label class="fld" style="grid-column:span 12"><span>Objective *</span>
        <input id="o_title" value="${esc(v.title)}" placeholder="A qualitative outcome, not a task"></label>
      <label class="fld" style="grid-column:span 12"><span>Why it matters</span>
        <textarea id="o_why" rows="2" placeholder="What breaks if this does not happen?">${esc(v.why || '')}</textarea></label>
      <label class="fld" style="grid-column:span 4"><span>Quarter</span>
        <input id="o_quarter" value="${esc(v.quarter)}" placeholder="2026-Q4"></label>
      <label class="fld" style="grid-column:span 4"><span>Starts</span>
        <input type="date" id="o_start" value="${esc(v.start || '')}"></label>
      <label class="fld" style="grid-column:span 4"><span>Due</span>
        <input type="date" id="o_due" value="${esc(v.due || '')}">
        <span class="hint tiny">Drawn on the timeline. The quarter is the bucket; this is the date.</span></label>
      <label class="fld" style="grid-column:span 6"><span>Owner</span>
        <select id="o_owner">${sel(s.people.map(p => ({ v: p.id, t: p.name })), v.owner, 'Unassigned')}</select></label>
      <label class="fld" style="grid-column:span 6"><span>Status</span>
        <select id="o_status">${sel(STATUS.map(x => ({ v: x.id, t: x.label })), v.status)}</select></label>
      <label class="fld" style="grid-column:span 6"><span>Project</span>
        <select id="o_project">${sel(s.projects.map(p => ({ v: p.id, t: p.name })), v.project, 'Cross-project / team-wide')}</select></label>
      <label class="fld" style="grid-column:span 6"><span>Division</span>
        <select id="o_division">${sel(s.divisions.map(d => ({ v: d.id, t: `${d.id} — ${d.name}` })), v.division, 'Not division-specific')}</select></label>
    </div>`,
    footer: `${o ? '<button class="btn danger" data-del>Delete</button>' : ''}<div style="flex:1"></div>
             <button class="btn" data-no>Cancel</button><button class="btn primary" data-ok>${o ? 'Save' : 'Create'}</button>`,
    onMount: ({ root, close }) => {
      root.querySelector('[data-no]').onclick = () => close();
      root.querySelector('[data-del]')?.addEventListener('click', async () => {
        if (await confirmDlg(`Delete “${o.title}” and its key results?`, { ok: 'Delete' })) close({ __delete: true });
      });
      root.querySelector('[data-ok]').onclick = () => {
        const g = k => root.querySelector('#o_' + k).value;
        if (!g('title').trim()) return toast('An objective needs a title', 'warn');
        if (g('start') && g('due') && g('due') < g('start')) {
          return toast('The due date is before the start date.', 'warn');
        }
        close({ title: g('title').trim(), why: g('why'), quarter: g('quarter').trim() || quarterOf(today()),
                start: g('start'), due: g('due'),
                owner: g('owner'), status: g('status'), project: g('project'), division: g('division') });
      };
    },
  });
  if (!res) return false;
  if (res.__delete) { S.remove('objectives', id); toast('Objective deleted', 'ok'); return true; }
  if (o) S.update('objectives', id, res);
  else S.add('objectives', { ...res, keyResults: [], milestones: [], updates: [] });
  toast('Saved', 'ok');
  return true;
}

async function editKr(objId, krId) {
  const o = S.byId(S.get().objectives, objId);
  const k = krId ? o.keyResults.find(x => x.id === krId) : null;
  const v = k || { text: '', target: 1, current: 0, unit: '', due: '', invert: false };
  const res = await dialog({
    title: k ? 'Edit key result' : 'New key result',
    body: `<div style="display:grid;grid-template-columns:repeat(12,1fr);gap:0 12px">
      <label class="fld" style="grid-column:span 12"><span>Key result *</span>
        <input id="k_text" value="${esc(v.text)}" placeholder="Something with a number attached"></label>
      <label class="fld" style="grid-column:span 4"><span>Target</span>
        <input type="number" id="k_target" step="any" value="${v.target}"></label>
      <label class="fld" style="grid-column:span 4"><span>Current</span>
        <input type="number" id="k_current" step="any" value="${v.current}"></label>
      <label class="fld" style="grid-column:span 4"><span>Unit</span>
        <input id="k_unit" value="${esc(v.unit || '')}" placeholder="%, bugs, done"></label>
      <label class="fld" style="grid-column:span 3"><span>Starts</span>
        <input type="date" id="k_start" value="${esc(v.start || '')}"></label>
      <label class="fld" style="grid-column:span 3"><span>Due</span>
        <input type="date" id="k_due" value="${esc(v.due || '')}">
        <span class="hint tiny">Both optional. With a start, the timeline draws a span.</span></label>
      <label class="fld" style="grid-column:span 6"><span>Direction</span>
        <label class="row" style="gap:7px;height:32px"><input type="checkbox" id="k_invert" ${v.invert ? 'checked' : ''}>
          <span class="tiny">Lower is better (bug count, variance %)</span></label></label>
    </div>`,
    footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-ok>Save</button>`,
    onMount: ({ root, close }) => {
      root.querySelector('[data-no]').onclick = () => close();
      root.querySelector('[data-ok]').onclick = () => {
        const g = k2 => root.querySelector('#k_' + k2);
        if (!g('text').value.trim()) return toast('Give the key result a name', 'warn');
        if (g('start').value && g('due').value && g('due').value < g('start').value) {
          return toast('That key result is due before it starts.', 'warn');
        }
        close({ text: g('text').value.trim(), target: +g('target').value || 0,
                current: +g('current').value || 0, unit: g('unit').value.trim(),
                start: g('start').value, due: g('due').value, invert: g('invert').checked });
      };
    },
  });
  if (!res) return false;
  S.mutate(s => {
    const ob = S.byId(s.objectives, objId);
    if (k) Object.assign(ob.keyResults.find(x => x.id === krId), res);
    else (ob.keyResults ||= []).push({ id: S.uid('kr'), ...res });
  }, { label: 'key result' });
  return true;
}

/**
 * A dated checkpoint under an objective.
 *
 * Deliberately the same record shape as a project milestone — `{id, name,
 * date, status, owner}` — so `msItems()` can hand both to the shared timeline
 * with no translation and no second code path to keep in step.
 */
async function editObjMilestone(objId, msId) {
  const o = S.byId(S.get().objectives, objId);
  if (!o) return false;
  const m = msId ? (o.milestones || []).find(x => x.id === msId) : null;
  const res = await formDlg(m ? 'Edit milestone' : `New milestone — ${o.title}`, [
    { k: 'name', label: 'Milestone', value: m?.name || '', required: true, span: 12,
      hint: 'A checkpoint with a date, not a task.' },
    { k: 'start', label: 'Starts', type: 'date', value: m?.start || '', span: 6,
      hint: 'Optional. With one, the timeline draws the stretch instead of a point.' },
    { k: 'date', label: 'Date', type: 'date', value: m?.date || o.due || today(), span: 6, required: true },
    { k: 'status', label: 'Status', type: 'select', value: m?.status || 'planned', span: 6,
      opts: MS_STATUS.map(x => ({ v: x.id, t: x.label })) },
    { k: 'owner', label: 'Owner', type: 'select', value: m?.owner || o.owner || '', span: 12,
      opts: [{ v: '', t: 'Unassigned' }, ...S.get().people.map(p => ({ v: p.id, t: p.name }))] },
  ], { ok: m ? 'Save' : 'Add', wide: true });
  if (!res) return false;
  if (res.start && res.date && res.date < res.start) {
    toast('That milestone ends before it starts.', 'warn');
    return false;
  }

  S.mutate(s => {
    const ob = S.byId(s.objectives, objId);
    ob.milestones ||= [];
    if (m) Object.assign(ob.milestones.find(x => x.id === msId), res);
    else ob.milestones.push({ id: S.uid('oms'), ...res });
  }, { label: 'objective milestone' });
  toast(m ? 'Milestone saved' : 'Milestone added — it is on the timeline', 'ok', 4000);
  return true;
}

async function checkin(objId) {
  const o = S.byId(S.get().objectives, objId);
  const res = await dialog({
    title: 'Check in — ' + o.title,
    body: `<label class="fld"><span>Status</span>
             <select id="c_status">${STATUS.map(x => `<option value="${x.id}"${x.id === o.status ? ' selected' : ''}>${x.label}</option>`).join('')}</select></label>
           <label class="fld"><span>What changed since the last check-in?</span>
             <textarea id="c_text" rows="4" placeholder="Progress, blockers, what you are doing about it"></textarea></label>`,
    footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-ok>Post check-in</button>`,
    onMount: ({ root, close }) => {
      root.querySelector('[data-no]').onclick = () => close();
      root.querySelector('[data-ok]').onclick = () => close({
        status: root.querySelector('#c_status').value,
        text: root.querySelector('#c_text').value.trim(),
      });
    },
  });
  if (!res) return false;
  S.mutate(s => {
    const ob = S.byId(s.objectives, objId);
    ob.status = res.status;
    if (res.text) (ob.updates ||= []).push({ date: today(), text: res.text, by: s.people.find(p => p.isMe)?.id || null });
  }, { label: 'check-in' });
  toast('Check-in posted', 'ok');
  return true;
}

/* ---------- view --------------------------------------------------------- */

export default {
  id: 'objectives', title: 'Objectives', icon: 'target', group: 'work',
  subtitle: 'Quarterly OKRs and where they actually stand',

  actions: ctx => [
    { label: 'New objective', icon: 'plus', primary: true, run: () => editObjective(null).then(r => r && ctx.rerender()) },
  ],

  render(host, ctx) {
    const s = S.get();
    let list = s.objectives.slice();
    if (ui.quarter) list = list.filter(o => o.quarter === ui.quarter);
    if (ui.owner)   list = list.filter(o => o.owner === ui.owner);
    if (ui.project) list = list.filter(o => (o.project || '') === ui.project);

    const byQ = groupBy(list, o => o.quarter);
    const qs = Object.keys(byQ).sort().reverse();

    const overall = list.length ? Math.round(sum(list, objProgress) / list.length) : 0;
    const atRisk = list.filter(o => o.status === 'at-risk' || o.status === 'off-track').length;
    const stale = list.filter(o => {
      const last = (o.updates || []).at(-1);
      return !last || (Date.now() - new Date(last.date).getTime()) > 21 * 86400000;
    }).length;

    /*
     * Everything dated, on one axis.
     *
     * Three kinds of thing share it, because "when is this objective actually
     * landing" is one question and splitting it across three panels would not
     * answer it: the objective's own due date, its milestones, and any key
     * result carrying a date. `goId` is the objective, so a click on any of
     * them scrolls to the card it belongs to.
     */
    const tlItems = list.flatMap(o => {
      const out = [];
      const st = o.status === 'done' ? 'done' : o.status === 'at-risk' || o.status === 'off-track' ? 'at-risk' : 'planned';
      /* `from` is what turns a point into a span. Only the three things that
         can carry a start supply it; the rest stay points. */
      if (o.due) {
        out.push({ id: `od_${o.id}`, name: o.title, date: o.due, from: o.start || '', status: st,
                   goId: o.id, kind: 'objective', projectCode: o.quarter || '' });
      }
      for (const m of (o.milestones || [])) {
        if (!m.date) continue;
        out.push({ id: m.id, name: m.name, date: m.date, from: m.start || '', status: m.status || 'planned',
                   goId: o.id, kind: 'milestone', projectCode: o.title.slice(0, 22) });
      }
      for (const k of (o.keyResults || [])) {
        if (!k.due) continue;
        out.push({ id: k.id, name: k.text.length > 52 ? k.text.slice(0, 52) + '…' : k.text,
                   date: k.due, from: k.start || '', status: krProgress(k) >= 100 ? 'done' : st,
                   goId: o.id, kind: 'kr', projectCode: 'KR' });
      }
      return out;
    });

    /* Due dates of the tasks linked to these objectives, as pips — the small
       marks under the axis that show where the work actually sits. */
    const objIds = new Set(list.map(o => o.id));
    const tlPips = s.tasks
      .filter(t => t.objectiveId && objIds.has(t.objectiveId) && t.status !== 'done' && t.due)
      .map(t => ({ date: t.due, overdue: t.due < today(), title: t.title }));

    const dated = list.filter(o => o.due).length;

    host.innerHTML = h`
      <div class="grid g4" style="margin-bottom:14px">
        <div class="card stat"><div class="k">Objectives</div><div class="v">${list.length}</div>
          <div class="d">${dated} with a due date</div></div>
        <div class="card stat"><div class="k">Average progress</div><div class="v">${overall}%</div>
          <div class="d">${fmtNum(sum(list, o => (o.keyResults || []).length))} key results</div></div>
        <div class="card stat"><div class="k">At risk</div><div class="v">${atRisk}</div>
          <div class="d ${atRisk ? 'down' : ''}">${atRisk ? 'at risk or off track' : 'none flagged'}</div></div>
        <div class="card stat"><div class="k">Awaiting check-in</div><div class="v">${stale}</div>
          <div class="d ${stale ? 'down' : ''}">${stale ? 'quiet for three weeks' : 'all current'}</div></div>
      </div>

      ${raw(tlItems.length ? milestonePanel({
        title: 'Objective timeline',
        sub: `${tlItems.length} dated item${tlItems.length === 1 ? '' : 's'}`,
        items: tlItems,
        pips: tlPips,
        key: 'okr',
        clickHint: 'Click anything on the axis to jump to its objective',
        emptyMsg: 'Nothing dated in this window. Widen the range, or put a due date on an objective.',
      }) : `<div class="card" style="margin-bottom:14px"><div class="body">
        <div class="tiny mute" style="line-height:1.7">
          <b>Nothing is dated yet, so there is no timeline to draw.</b>
          Give an objective a <b>Due</b> date, or add a <b>milestone</b> or a dated
          <b>key result</b>, and they all appear here on one axis with today marked.
        </div></div></div>`)}

      <div class="toolbar">
        <select data-change="f" data-k="quarter" style="width:auto">
          <option value="">All quarters</option>
          ${raw(quarters().map(q => `<option value="${esc(q)}"${q === ui.quarter ? ' selected' : ''}>${esc(q)}</option>`).join(''))}
        </select>
        <select data-change="f" data-k="owner" style="width:auto">
          <option value="">Any owner</option>
          ${raw(s.people.map(p => `<option value="${esc(p.id)}"${p.id === ui.owner ? ' selected' : ''}>${esc(p.name)}</option>`).join(''))}
        </select>
        <select data-change="f" data-k="project" style="width:auto">
          <option value="">All projects</option>
          ${raw(s.projects.map(p => `<option value="${esc(p.id)}"${p.id === ui.project ? ' selected' : ''}>${esc(p.name)}</option>`).join(''))}
        </select>
        <div class="spacer" style="flex:1"></div>
        <span class="tiny mute">Average progress <b class="dim">${overall}%</b></span>
      </div>

      ${raw(atRisk || stale ? `
        <div class="banner ${atRisk ? 'warn' : ''}">
          <svg class="ico"><use href="#i-warn"></use></svg>
          <div>${atRisk ? `<b>${atRisk} objective${atRisk > 1 ? 's are' : ' is'} at risk or off track.</b>` : ''}
          ${stale ? `${stale} ${stale > 1 ? 'have' : 'has'} not been checked in on for three weeks — an OKR nobody updates is a wish.` : ''}</div>
        </div>` : '')}

      ${raw(qs.length ? qs.map(q => `
        <div class="okr-qhead">
          <h3>${esc(q || 'No quarter')}</h3>
          <span class="tiny mute">${byQ[q].length} objective${byQ[q].length > 1 ? 's' : ''}
            · ${Math.round(sum(byQ[q], objProgress) / byQ[q].length)}% average</span>
        </div>
        <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(480px,1fr));align-items:start">
          ${byQ[q].map(card).join('')}
        </div>`).join('') : `
        <div class="card"><div class="empty">
          <svg class="ico"><use href="#i-target"></use></svg>
          <h4>No objectives yet</h4>
          <div class="tiny">Three or four per quarter is plenty. Anything more and none of them are objectives.</div>
        </div></div>`)}`;

    const objOf = el => el.closest('[data-id]').dataset.id;

    acts(host, {
      f: el => { ui[el.dataset.k] = el.value; saveUi(); ctx.rerender(); },
      edit: el => editObjective(objOf(el)).then(r => r && ctx.rerender()),

      /* --- milestones --- */
      'ms-add':  el => editObjMilestone(objOf(el), null).then(r => r && ctx.rerender()),
      'ms-edit': el => editObjMilestone(objOf(el), el.closest('[data-ms]').dataset.ms).then(r => r && ctx.rerender()),
      'ms-del':  async el => {
        const oid = objOf(el), mid = el.closest('[data-ms]').dataset.ms;
        if (!await confirmDlg('Remove this milestone?', { ok: 'Remove' })) return;
        S.mutate(s => {
          const o = S.byId(s.objectives, oid);
          o.milestones = (o.milestones || []).filter(m => m.id !== mid);
        }, { label: 'remove objective milestone' });
        ctx.rerender();
      },

      /* --- tasks --- */
      'task-add': el => {
        const o = S.byId(S.get().objectives, objOf(el));
        /* Pre-filled with the objective, and with its project and division
           where it has them, so a task created here is already attributed. */
        editTask(null, {
          objectiveId: o.id,
          ...(o.project ? { project: o.project } : {}),
          ...(o.division ? { division: o.division } : {}),
          ...(o.due ? { due: o.due } : {}),
        }).then(r => r && ctx.rerender());
      },
      'task-open': el => ctx.go('tasks', el.closest('[data-t]').dataset.t),
      'task-all':  () => ctx.go('tasks'),

      menu: (el, ev) => {
        const id = objOf(el);
        menu(ev, [
          { label: 'Edit objective…', icon: 'edit', run: () => editObjective(id).then(r => r && ctx.rerender()) },
          { label: 'Add key result…', icon: 'plus', run: () => editKr(id, null).then(r => r && ctx.rerender()) },
          { label: 'Add milestone…', icon: 'flag', run: () => editObjMilestone(id, null).then(r => r && ctx.rerender()) },
          { label: 'New task for this…', icon: 'board', run: () => {
            const o = S.byId(S.get().objectives, id);
            editTask(null, { objectiveId: id, ...(o.project ? { project: o.project } : {}) })
              .then(r => r && ctx.rerender());
          } },
          { label: 'Check in…', icon: 'note', run: () => checkin(id).then(r => r && ctx.rerender()) },
          '-',
          { label: 'Delete', icon: 'trash', danger: true, run: async () => {
            const o = S.byId(S.get().objectives, id);
            if (await confirmDlg(`Delete “${o.title}”?`, { ok: 'Delete' })) { S.remove('objectives', id); ctx.rerender(); }
          } },
        ]);
      },
      checkin: el => checkin(el.closest('[data-id]').dataset.id).then(r => r && ctx.rerender()),
      'kr-add': el => editKr(el.closest('[data-id]').dataset.id, null).then(r => r && ctx.rerender()),
      'kr-edit': el => editKr(el.closest('[data-id]').dataset.id, el.closest('[data-kr]').dataset.kr).then(r => r && ctx.rerender()),
      'kr-del': async el => {
        const oid = el.closest('[data-id]').dataset.id, kid = el.closest('[data-kr]').dataset.kr;
        if (!await confirmDlg('Remove this key result?', { ok: 'Remove' })) return;
        S.mutate(s => { const o = S.byId(s.objectives, oid); o.keyResults = o.keyResults.filter(k => k.id !== kid); }, { label: 'remove KR' });
        ctx.rerender();
      },
      'kr-cur': el => {
        const oid = el.closest('[data-id]').dataset.id, kid = el.closest('[data-kr]').dataset.kr;
        S.mutate(s => { const k = S.byId(s.objectives, oid).keyResults.find(x => x.id === kid); k.current = +el.value || 0; },
                 { label: 'KR progress', silent: true });
        /*
         * Update this row in place rather than re-rendering.
         *
         * A full rerender would rebuild the timeline and steal focus from the
         * number you are typing in. The selectors are deliberately class-based
         * (`.okr-kr-pct`, `.okr-prog`) — the previous version walked the DOM by
         * position (`row.lastElementChild`, `header div[style*=…]`) and broke
         * the moment the card's markup changed, which it just did.
         */
        const row = el.closest('[data-kr]');
        const k = S.byId(S.get().objectives, oid).keyResults.find(x => x.id === kid);
        const p = krProgress(k);
        row.querySelector('.bar i').style.width = p + '%';
        const pctEl = row.querySelector('.okr-kr-pct');
        if (pctEl) pctEl.textContent = p + '%';

        const cardEl = el.closest('[data-id]');
        const op = objProgress(S.byId(S.get().objectives, oid));
        const head = cardEl.querySelector('.okr-pct');
        if (head) head.innerHTML = `${op}<span style="font-size:13px">%</span>`;
        const obar = cardEl.querySelector('.okr-prog i');
        if (obar) obar.style.width = op + '%';
      },
    });

    /* The timeline's own range buttons and scale toggle, plus a click on any
       mark scrolling to the objective it belongs to. */
    const teardown = wireMilestones(host, ctx, {
      onMark: (objId) => {
        const el = host.querySelector(`[data-id="${objId}"]`);
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          el.classList.add('okr-flash');
          setTimeout(() => el.classList.remove('okr-flash'), 1200);
        }
      },
    });

    const [p0] = ctx.params;
    if (p0 && S.byId(S.get().objectives, p0)) {
      history.replaceState(null, '', '#/objectives');
      host.querySelector(`[data-id="${p0}"]`)?.scrollIntoView({ block: 'center' });
    }
    return teardown;
  },
};
