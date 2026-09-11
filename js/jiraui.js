/**
 * Jira push — the dialogs.
 *
 * Kept apart from views/tasks.js because this is a self-contained flow with
 * its own rules, and apart from js/jira.js because that file is the model and
 * must stay testable without a DOM.
 *
 * The one design rule: a task is never queued with a field this project would
 * reject. Validation happens here, in front of the person who can fix it,
 * rather than three steps later in a PowerShell log.
 */

import * as S from './store.js';
import { esc, toast, dialog, formDlg, confirmDlg } from './ui.js';
import {
  jiraProjects, jiraProject, jiraConfigured, suggestLabels, validate, enqueue, isFiled,
  reporterAccountId, planFor, enqueueMany, divisionLabel,
  defaultEpicFor, jiraKeyFor, subtasksOf,
} from './jira.js';

/* ---------- push one task ------------------------------------------------ */

/**
 * Collect what this project requires, then queue it.
 *
 * Defaults are the team's conventions, not guesses: the project comes from the
 * task's own project where that maps to a Jira key, labels are derived from
 * the summary by the documented rules, and priority starts at the project's
 * default. Everything is editable before it is queued.
 */
/* Nothing to file into. Said once, here and in the bulk dialog, rather than
   letting a blank project produce a form with an empty project drop-down and
   a priority list of nothing. */
const NEEDS_SETUP = 'No Jira project is set up yet. Add one in Settings → Integrations '
  + '— its key, component, epic and priorities — and this will fill itself in.';

export async function pushDialog(taskId) {
  const t = S.byId(S.get().tasks, taskId);
  if (!t) return false;
  if (!jiraConfigured()) { toast(NEEDS_SETUP, 'warn', 9000); return false; }

  if (isFiled(t)) {
    const again = await confirmDlg(
      `This task is already ${t.jira.key} in Jira. Queueing it again will not create a ` +
      `second issue — the local helper keeps a ledger and will skip it. Queue it anyway?`,
      { title: 'Already in Jira', ok: 'Queue anyway', danger: false });
    if (!again) return false;
  }

  const picked = jiraProject(jiraKeyFor(t));
  const subs = subtasksOf(t);
  const summary0 = t.jira?.summary || t.title || '';
  const labels0 = (t.jira?.labels?.length ? t.jira.labels : suggestLabels(picked.key, summary0, t.division));
  const parent0 = t.jira?.parent || defaultEpicFor(t) || '';

  const res = await formDlg(`Push "${t.title}" to Jira`, [
    { k: 'project', label: 'Jira project', type: 'select', span: 6, value: picked.key,
      opts: jiraProjects().map(p => ({ v: p.key, t: `${p.key} — ${p.name}` })) },
    { k: 'priority', label: 'Priority', type: 'select', span: 6,
      value: t.jira?.priority || picked.defaultPriority,
      opts: picked.priorities.map(x => ({ v: x, t: x })) },
    { k: 'summary', label: 'Summary', span: 12, required: true, value: summary0,
      hint: 'This becomes the Jira issue title, and the label rules read it.' },
    { k: 'description', label: 'Description', type: 'textarea', rows: 4, span: 12,
      value: t.jira?.description || t.desc || '',
      hint: 'Required by this project. Blank lines become separate paragraphs.' },
    { k: 'labels', label: 'Labels', span: 6, value: labels0.join(', '),
      hint: 'Comma separated. Required — Jira rejects an issue with none.' },
    { k: 'parent', label: 'Parent epic', span: 6, value: parent0,
      hint: picked.defaultParent
        ? `Filled in from ${esc(picked.key)}'s GFX epic. Must be an Epic; the helper verifies it before filing.`
        : 'The epic key. Must be an Epic; the helper verifies it before filing.' },
  ], { ok: 'Add to queue', wide: true,
       extra: `<div class="banner" style="margin:0 0 12px">
         <svg class="ico"><use href="#i-info"></use></svg>
         <div><b>Set automatically.</b>
           Issue type <code>Task</code> ·
           Component <code>${esc(picked.component || 'none for this project')}</code> ·
           Epic <code>${parent0 ? esc(parent0) : 'none'}</code>${picked.defaultParentName && parent0 === picked.defaultParent ? ` <span class="tiny mute">(${esc(picked.defaultParentName)})</span>` : ''} ·
           Reporter <code>${reporterAccountId() ? esc(reporterAccountId()) : 'you (the API token owner)'}</code> · Assignee left unassigned.
           ${subs.length ? `<div class="tiny" style="margin-top:4px">
             The <b>${subs.length} checklist step${subs.length === 1 ? '' : 's'}</b> on this task
             ${subs.length === 1 ? 'becomes a' : 'become'} Jira sub-task${subs.length === 1 ? '' : 's'} of the new issue,
             inheriting its component and labels.</div>` : ''}
           <div class="tiny mute" style="margin-top:4px">
             Nothing is sent from here. This adds the task to a queue you export,
             and the local helper does the filing.
           </div></div></div>` });

  if (!res) return false;

  const chosen = jiraProject(res.project);
  const fields = {
    project: res.project,
    summary: String(res.summary || '').trim(),
    description: String(res.description || '').trim(),
    labels: String(res.labels || '').split(/[,;]/).map(s => s.trim()).filter(Boolean),
    priority: res.priority,
    parent: String(res.parent || '').trim().toUpperCase(),
  };

  const gaps = validate(fields);
  if (gaps.length) {
    toast(`${chosen.key} needs ${gaps.join(', ')}. Nothing was queued.`, 'err', 8000);
    return false;
  }

  enqueue(taskId, fields);
  toast(`Queued for ${chosen.key}. It is waiting in Jira Imports — click Import to Jira there.`, 'ok', 6000);
  return true;
}

/* ---------- push a selection -------------------------------------------- */

/**
 * Queue many tasks at once.
 *
 * The whole point is to see what will happen before it does. Every selected
 * task is planned first — project, labels from its division, priority, parent
 * — and the dialog shows the ones that are ready and the ones that are short
 * of something, with the reason. Only the ready ones are queued, and the rest
 * stay selected so they can be fixed.
 *
 * Two fields fill the usual gaps in one go rather than per task: a parent epic
 * (some projects require one, and it is normally the same epic for a batch) and a
 * priority. Both apply only where the task does not already say.
 *
 * Redrawing is the caller's job, not this dialog's. It used to re-render
 * itself on the way out, which happened before the caller could drop the
 * selection — so the "4 selected" bar survived a queue that had emptied it.
 *
 * @param {string[]} taskIds
 * @returns {Promise<boolean>} true if anything was queued
 */
export async function bulkQueueDialog(taskIds) {
  const s = S.get();
  const tasks = taskIds.map(id => S.byId(s.tasks, id)).filter(Boolean);
  if (!tasks.length) { toast('Nothing selected.', 'warn'); return false; }
  if (!jiraConfigured(s)) { toast(NEEDS_SETUP, 'warn', 9000); return false; }

  const already = tasks.filter(isFiled);
  const keys = [...new Set(tasks.map(t => jiraKeyFor(t)))];
  const needParent = keys.some(k => jiraProject(k).requiresParent);
  const prios = jiraProject(keys[0]).priorities;

  /*
   * Leave the batch parent blank when the selection spans Jira projects.
   *
   * Each task already resolves its own epic, and typing one key here would
   * override every one of them — filing one game's task under another game's
   * epic. Blank means "let each task use its own", which is the right default
   * and the reason the field's placeholder says so.
   */
  const epics = [...new Set(tasks.map(t => defaultEpicFor(t)).filter(Boolean))];
  const parentPrefill = epics.length === 1 ? epics[0] : '';

  /* What the division rule will do, summarised — this is the rule doing the
     work, so it is worth showing rather than leaving to be discovered. */
  const divCount = new Map();
  for (const t of tasks) {
    const l = divisionLabel(t.division) || '(no division)';
    divCount.set(l, (divCount.get(l) || 0) + 1);
  }

  /* The checklist count rides along on the plan so the preview can show what
     the batch will actually create — a selection of eight tasks can easily be
     thirty issues once their checklists are counted. */
  const preview = (parent, priority, titleAsDesc) =>
    tasks.map(t => ({ ...planFor(t, { parent, priority, titleAsDesc }), subs: subtasksOf(t).length }));
  const subTotal = tasks.reduce((n, t) => n + subtasksOf(t).length, 0);

  const render = (plans) => {
    const ready = plans.filter(p => !p.gaps.length);
    const short = plans.filter(p => p.gaps.length);
    return `
      <div class="dx-sum">
        <span class="chip tiny ${ready.length ? 'ok' : ''}">${ready.length} ready</span>
        ${short.length ? `<span class="chip tiny warn">${short.length} missing something</span>` : ''}
        ${already.length ? `<span class="tiny mute">${already.length} already in Jira — the helper's ledger will skip those</span>` : ''}
      </div>
      <table class="dx-table" style="border:1px solid var(--line);border-radius:var(--r);margin-top:8px">
        ${plans.map(p => `<tr>
          <td style="width:74px">${p.gaps.length
            ? '<span class="chip tiny warn">short</span>' : '<span class="chip tiny ok">ready</span>'}</td>
          <td><b>${esc(p.title)}</b>
            <div class="tiny mute">${esc(p.fields.project)}
              ${p.component ? ' · ' + esc(p.component) : ''}
              ${p.fields.labels.length ? ' · ' + esc(p.fields.labels.join(', ')) : ' · no labels'}
              ${p.fields.parent ? ' · ' + esc(p.fields.parent) : ' · no epic'}
              · ${esc(p.fields.priority)}
              ${p.subs ? ` · <b>+${p.subs} sub-task${p.subs === 1 ? '' : 's'}</b>` : ''}</div>
            ${p.gaps.length ? `<div class="tiny" style="color:var(--risk)">needs ${esc(p.gaps.join(', '))}</div>` : ''}
          </td></tr>`).join('')}
      </table>`;
  };

  const fields = `
    <div style="display:grid;grid-template-columns:repeat(12,1fr);gap:0 12px">
      <label class="fld" style="grid-column:span 6"><span>Parent epic</span>
        <input id="bq_parent" value="${esc(parentPrefill)}"
               placeholder="${epics.length > 1 ? 'each task uses its own project epic' : 'the epic key'}">
        <span class="hint">${epics.length > 1
          ? `The selection spans ${esc(epics.join(' and '))} — leave blank and each task keeps its own.`
          : parentPrefill ? 'Filled in from the project\'s GFX epic. Overrides every task in this batch.'
          : 'Applied to every task that has none.'}${needParent
          ? ` Required by ${esc(keys.filter(k => jiraProject(k).requiresParent).join(', '))}.` : ''}</span></label>
      <label class="fld" style="grid-column:span 6"><span>Priority</span>
        <select id="bq_prio">${prios.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}</select>
        <span class="hint">Applied where the task has no Jira priority yet.</span></label>
      <label class="row tiny" style="grid-column:span 12;gap:7px;cursor:pointer;margin:2px 0 10px">
        <input type="checkbox" id="bq_desc" checked>
        Use the task title as the description where a task has no notes
      </label>
    </div>`;

  let queued = false;

  await dialog({
    title: `Queue ${tasks.length} task${tasks.length === 1 ? '' : 's'} for Jira`,
    wide: true,
    body: `
      <div class="banner">
        <svg class="ico"><use href="#i-info"></use></svg>
        <div><b>Component, epic and labels are set for you.</b>
          Component <code>${esc([...new Set(keys.map(k => jiraProject(k).component || 'none'))].join(', '))}</code>
          · Epic <code>${esc(epics.join(', ') || 'none')}</code>
          · Labels from the division ${[...divCount].map(([l, n]) => `<code>${esc(l)}</code>&nbsp;×${n}`).join(' · ')}
          ${subTotal ? `<div class="tiny" style="margin-top:4px">Checklists add
            <b>${subTotal} sub-task${subTotal === 1 ? '' : 's'}</b> under these
            ${tasks.length} issue${tasks.length === 1 ? '' : 's'}.</div>` : ''}
          <div class="tiny mute" style="margin-top:4px">
            Nothing is sent from here. This queues the tasks; you then export the
            queue and the local helper files them.
          </div></div>
      </div>
      ${fields}
      <div id="bq_prev">${render(preview('', prios[0], true))}</div>`,
    footer: `<button class="btn" data-no>Cancel</button>
             <div class="spacer" style="flex:1"></div>
             <button class="btn primary" data-ok>Queue the ready ones</button>`,
    onMount: ({ root, close }) => {
      const read = () => ({
        parent: (root.querySelector('#bq_parent').value || '').trim().toUpperCase(),
        priority: root.querySelector('#bq_prio').value,
        titleAsDesc: root.querySelector('#bq_desc').checked,
      });
      const refresh = () => {
        const o = read();
        root.querySelector('#bq_prev').innerHTML =
          render(preview(o.parent, o.priority, o.titleAsDesc));
      };
      root.querySelector('#bq_parent').addEventListener('input', refresh);
      root.querySelector('#bq_prio').addEventListener('change', refresh);
      root.querySelector('#bq_desc').addEventListener('change', refresh);

      root.querySelector('[data-no]').onclick = () => close();
      root.querySelector('[data-ok]').onclick = () => {
        const o = read();
        const { queued: q, skipped } = enqueueMany(taskIds, o);
        if (!q.length) {
          toast(`Nothing could be queued — ${skipped[0]?.gaps.join(', ') || 'fields are missing'}.`, 'err', 8000);
          return;
        }
        queued = true;
        toast(`${q.length} queued${skipped.length ? `, ${skipped.length} skipped` : ''}. ` +
              `They are waiting in Jira Imports — click Import to Jira there.`, 'ok', 6000);
        close(true);
      };
    },
  });

  return queued;
}
