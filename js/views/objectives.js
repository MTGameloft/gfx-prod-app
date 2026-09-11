/* ============================================================================
   views/objectives.js — OKRs: objectives, key results, check-ins.
   ========================================================================= */

import * as S from '../store.js';
import {
  h, raw, esc, icon, toast, dialog, confirmDlg, menu, acts, bar,
  fmtDate, today, quarterOf, groupBy, sum,
} from '../ui.js';
import { krProgress, objProgress } from '../calc.js';

const STATUS = [
  { id: 'on-track',  label: 'On track',  chip: 'ok' },
  { id: 'at-risk',   label: 'At risk',   chip: 'warn' },
  { id: 'off-track', label: 'Off track', chip: 'risk' },
  { id: 'done',      label: 'Achieved',  chip: 'info' },
  { id: 'dropped',   label: 'Dropped',   chip: '' },
];
const statusOf = id => STATUS.find(s => s.id === id) || STATUS[0];

const UI_KEY = 'gfxprod.ui.okr';
const ui = Object.assign({ quarter: '', owner: '', project: '' },
                         JSON.parse(localStorage.getItem(UI_KEY) || '{}'));
const saveUi = () => localStorage.setItem(UI_KEY, JSON.stringify(ui));

const quarters = () => [...new Set(S.get().objectives.map(o => o.quarter).concat(quarterOf(today())))].sort();

/* ---------- cards -------------------------------------------------------- */

function card(o) {
  const s = S.get();
  const pct = objProgress(o);
  const st = statusOf(o.status);
  const proj = S.byId(s.projects, o.project);
  const linked = s.tasks.filter(t => t.objectiveId === o.id);
  const openLinked = linked.filter(t => t.status !== 'done').length;
  const last = (o.updates || []).at(-1);

  return h`
  <section class="card" data-id="${o.id}">
    <header>
      <div style="flex:1;min-width:0">
        <div class="row" style="gap:7px;margin-bottom:2px">
          <span class="chip">${o.quarter}</span>
          ${raw(proj ? `<span class="chip" style="background:${proj.color}22;color:${proj.color}">${esc(proj.code)}</span>` : '')}
          <span class="chip ${st.chip}">${st.label}</span>
        </div>
        <h3 style="font-size:14.5px">${o.title}</h3>
        ${raw(o.why ? `<div class="tiny mute" style="margin-top:3px">${esc(o.why)}</div>` : '')}
      </div>
      <div style="text-align:right;flex:none">
        <div style="font-size:21px;font-weight:650;line-height:1">${pct}%</div>
        <div class="tiny mute">${o.keyResults?.length || 0} KRs</div>
      </div>
      <button class="btn icon sm subtle" data-act="menu"><svg class="ico"><use href="#i-dots"></use></svg></button>
    </header>
    <div class="body">
      ${bar(pct, pct >= 70 ? 'ok' : pct >= 40 ? 'warn' : 'risk')}
      <div style="margin-top:12px;display:flex;flex-direction:column;gap:9px">
        ${raw((o.keyResults || []).map((k, i) => krRow(o, k, i)).join('') ||
              '<div class="tiny mute">No key results yet — a bare objective cannot be measured.</div>')}
      </div>
      <div class="row wrap tiny mute" style="margin-top:12px;gap:12px">
        <span>Owner <b class="dim">${S.personName(o.owner)}</b></span>
        ${raw(linked.length ? `<span>· <b class="dim">${openLinked}</b> of ${linked.length} linked tasks open</span>` : '')}
        ${raw(last ? `<span>· last check-in ${esc(fmtDate(last.date))}</span>` : '<span class="warn">· no check-in yet</span>')}
        <span class="spacer" style="flex:1"></span>
        <button class="btn sm subtle" data-act="checkin">${icon('note')}Check in</button>
        <button class="btn sm subtle" data-act="kr-add">${icon('plus')}Key result</button>
      </div>
      ${raw((o.updates || []).length ? `
        <details style="margin-top:10px">
          <summary class="tiny mute" style="cursor:pointer">${o.updates.length} check-in${o.updates.length > 1 ? 's' : ''}</summary>
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

function krRow(o, k, i) {
  const p = krProgress(k);
  const cls = p >= 100 ? 'ok' : p >= 50 ? '' : p >= 25 ? 'warn' : 'risk';
  return `
  <div class="row" data-kr="${k.id}" style="gap:10px;align-items:center">
    <div style="flex:1;min-width:0">
      <div class="tiny" style="margin-bottom:3px">${esc(k.text)}</div>
      <span class="bar thin"><i class="${cls}" style="width:${p}%"></i></span>
    </div>
    <div class="row" style="flex:none;gap:5px">
      <input type="number" data-input="kr-cur" value="${k.current ?? 0}" step="any"
             style="width:74px;height:26px;text-align:right" title="Current">
      <span class="tiny mute nowrap">/ ${esc(k.target)} ${esc(k.unit || '')}${k.invert ? ' ↓' : ''}</span>
      <button class="btn icon sm subtle" data-act="kr-edit" title="Edit"><svg class="ico"><use href="#i-edit"></use></svg></button>
      <button class="btn icon sm subtle" data-act="kr-del" title="Remove"><svg class="ico"><use href="#i-x"></use></svg></button>
    </div>
    <div style="width:38px;text-align:right;font-weight:650;font-size:12px">${p}%</div>
  </div>`;
}

/* ---------- dialogs ------------------------------------------------------ */

async function editObjective(id) {
  const s = S.get();
  const o = id ? S.byId(s.objectives, id) : null;
  const v = o || { title: '', why: '', quarter: quarterOf(today()), owner: s.people.find(p => p.isMe)?.id || '', project: '', status: 'on-track', keyResults: [], updates: [] };
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
      <label class="fld" style="grid-column:span 4"><span>Owner</span>
        <select id="o_owner">${sel(s.people.map(p => ({ v: p.id, t: p.name })), v.owner, 'Unassigned')}</select></label>
      <label class="fld" style="grid-column:span 4"><span>Status</span>
        <select id="o_status">${sel(STATUS.map(x => ({ v: x.id, t: x.label })), v.status)}</select></label>
      <label class="fld" style="grid-column:span 12"><span>Project</span>
        <select id="o_project">${sel(s.projects.map(p => ({ v: p.id, t: p.name })), v.project, 'Cross-project / team-wide')}</select></label>
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
        close({ title: g('title').trim(), why: g('why'), quarter: g('quarter').trim() || quarterOf(today()),
                owner: g('owner'), status: g('status'), project: g('project') });
      };
    },
  });
  if (!res) return false;
  if (res.__delete) { S.remove('objectives', id); toast('Objective deleted', 'ok'); return true; }
  if (o) S.update('objectives', id, res);
  else S.add('objectives', { ...res, keyResults: [], updates: [] });
  toast('Saved', 'ok');
  return true;
}

async function editKr(objId, krId) {
  const o = S.byId(S.get().objectives, objId);
  const k = krId ? o.keyResults.find(x => x.id === krId) : null;
  const v = k || { text: '', target: 1, current: 0, unit: '', invert: false };
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
      <label class="fld" style="grid-column:span 12">
        <label class="row" style="gap:7px"><input type="checkbox" id="k_invert" ${v.invert ? 'checked' : ''}>
          <span class="tiny">Lower is better (e.g. bug count, variance %)</span></label></label>
    </div>`,
    footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-ok>Save</button>`,
    onMount: ({ root, close }) => {
      root.querySelector('[data-no]').onclick = () => close();
      root.querySelector('[data-ok]').onclick = () => {
        const g = k2 => root.querySelector('#k_' + k2);
        if (!g('text').value.trim()) return toast('Give the key result a name', 'warn');
        close({ text: g('text').value.trim(), target: +g('target').value || 0,
                current: +g('current').value || 0, unit: g('unit').value.trim(), invert: g('invert').checked });
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

    host.innerHTML = h`
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
        <div class="nav-group" style="padding:16px 2px 8px">${esc(q)} · ${byQ[q].length} objective${byQ[q].length > 1 ? 's' : ''}</div>
        <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(430px,1fr))">
          ${byQ[q].map(card).join('')}
        </div>`).join('') : `
        <div class="card"><div class="empty">
          <svg class="ico"><use href="#i-target"></use></svg>
          <h4>No objectives yet</h4>
          <div class="tiny">Three or four per quarter is plenty. Anything more and none of them are objectives.</div>
        </div></div>`)}`;

    acts(host, {
      f: el => { ui[el.dataset.k] = el.value; saveUi(); ctx.rerender(); },
      menu: (el, ev) => {
        const id = el.closest('[data-id]').dataset.id;
        menu(ev, [
          { label: 'Edit objective…', icon: 'edit', run: () => editObjective(id).then(r => r && ctx.rerender()) },
          { label: 'Add key result…', icon: 'plus', run: () => editKr(id, null).then(r => r && ctx.rerender()) },
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
        // live-update just this row rather than re-rendering the whole page
        const row = el.closest('[data-kr]');
        const k = S.byId(S.get().objectives, oid).keyResults.find(x => x.id === kid);
        const p = krProgress(k);
        row.querySelector('.bar i').style.width = p + '%';
        row.lastElementChild.textContent = p + '%';
        const cardEl = el.closest('[data-id]');
        const op = objProgress(S.byId(S.get().objectives, oid));
        cardEl.querySelector('header div[style*="text-align:right"] div').textContent = op + '%';
        cardEl.querySelector('.body > .bar i').style.width = op + '%';
      },
    });

    const [p0] = ctx.params;
    if (p0 && S.byId(S.get().objectives, p0)) {
      history.replaceState(null, '', '#/objectives');
      host.querySelector(`[data-id="${p0}"]`)?.scrollIntoView({ block: 'center' });
    }
  },
};
