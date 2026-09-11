/**
 * Jira push — the queue, and the field rules.
 *
 * WHY A QUEUE AND NOT A DIRECT CALL
 *
 * The app cannot reach Jira. Measured, not assumed: an Atlassian Cloud site
 * refuses every cross-origin request to `/rest/api/2` and `/rest/api/3` —
 * plain GET, GET with an Authorization header, and POST all fail on CORS. The
 * one CORS-open Atlassian path is the `api.atlassian.com` gateway, which only
 * accepts OAuth 2.0 (3LO), and 3LO requires a `client_secret` at token
 * exchange. A page served from a public repository cannot hold a secret, so
 * that door is shut too. Putting a Jira API token in `localStorage` would not
 * help either: CORS stops the request long before auth is considered.
 *
 * So this file does everything except the HTTP. It builds a queue you can
 * review, exports it as a file, and reads back what the local helper
 * (`tools/jira-push.ps1`) actually created. The helper holds the credential —
 * the same DPAPI-encrypted token the Art Prod App already uses — and it owns
 * the duplicate-prevention ledger.
 *
 * NOTHING IS EVER SENT AS A SIDE EFFECT. Queueing is local state. Exporting
 * is a download. Only the helper talks to Jira, and only to items you queued.
 */

import * as S from './store.js';

/* ---------- the project's field rules ------------------------------------ */

/*
 * Whose name the ticket is filed under.
 *
 * Deliberately NOT hardcoded. An Atlassian account id is a personal
 * identifier, and this repository is public — so it lives in local settings
 * where the rest of the real data lives, and never in the source.
 *
 * Left blank, Jira files the issue as the owner of the API token the helper
 * uses, which is you. Set it only to file as somebody else.
 */
export const reporterAccountId = () =>
  String(S.get().settings?.jira?.reporterAccountId || '').trim();

/*
 * A project may mark Components and Labels as required on top of Summary, and
 * may require the parent to be an Epic. Those are conventions a team already
 * applies by hand; encoding them means they are not retyped per ticket.
 * Anything the rules cannot decide is asked, never guessed — a wrong ticket in
 * a shared production tracker is worse than one more question.
 */

/*
 * Division -> Jira label. The primary rule.
 *
 * Keyed on the division id, which is what a task actually stores, and the
 * names are there so the intent is readable next to it. This runs for every
 * Jira project, because it describes the work rather than the tracker.
 *
 * It supersedes the summary-text rules for the same thing: a task in the
 * Animation division gets `Anim` from here, so the old summary rule that
 * turned the word "Animation" into `Ani-Env` + `Ani-Prop` has been removed
 * rather than left to fire alongside it and produce three labels.
 */
export const DIVISION_LABELS = {
  '2D':  '2D',        // 2D Art
  '3D':  '3D',        // 3D Art
  ANIM:  'Anim',      // Animation
  UIUX:  'UIUX',      // UI/UX
  VFX:   'VFX',       // VFX
  PROD:  'GFX-Prod',  // GFX Prod — production, not an art discipline
};

/** The label a division implies, or '' where a division has no rule. */
/**
 * The Jira label for a division.
 *
 * The division's own `jiraLabel` wins, because divisions are data — the roster
 * has an `AD` (Art Direction) that this file has never heard of, and hard-coding
 * was the reason it silently produced no label. `DIVISION_LABELS` is now only
 * the default for the five that shipped, applied on migration and used as a
 * fallback for state that predates the field.
 */
export function divisionLabel(divisionId, state = S.get()) {
  const id = String(divisionId || '').trim();
  if (!id) return '';
  const d = (state?.divisions || []).find(x => x.id === id);
  const own = String(d?.jiraLabel ?? '').trim();
  if (own) return own;
  /* An explicitly emptied label means "no label", not "fall back". */
  if (d && d.jiraLabel !== undefined) return '';
  return DIVISION_LABELS[id] || '';
}

/*
 * The Jira projects this app files into — CONFIGURATION, NOT SOURCE.
 *
 * These used to be a hard-coded array of real project keys, epic ids and
 * component names. This repository is public, and a tracker's internal
 * identifiers alongside a client's product name is not something to publish.
 * So they live in state, are added in Settings → Integrations, ride along in
 * backups and in the `JiraProjects` sheet, and never appear here.
 *
 * The shape of one:
 *
 *   { key, name, issueType, component, defaultParent, defaultParentName,
 *     priorities: [], defaultPriority, requiresParent, labelsRequired,
 *     labelRules: [{ test: <RegExp|string>, labels: [] }] }
 *
 * Nothing is invented when the list is empty: the queue refuses politely and
 * points at Settings, which is better than filing into a guessed project.
 */
export const jiraProjects = (state = S.get()) => state.jiraProjects || [];

/** A blank project, so every caller can read `.component` without a guard. */
const NO_PROJECT = {
  key: '', name: '', issueType: 'Task', component: '',
  defaultParent: '', defaultParentName: '',
  priorities: [], defaultPriority: '',
  requiresParent: false, labelsRequired: false, labelRules: [],
};

/**
 * One Jira project by key.
 *
 * Falls back to the FIRST configured project, as before — but to a blank one
 * rather than to a real project when nothing is configured, so an unconfigured app
 * cannot quietly file somewhere real.
 */
export function jiraProject(key, state = S.get()) {
  const all = jiraProjects(state);
  return all.find(p => p.key === key) || all[0] || NO_PROJECT;
}

/** Is there anywhere to file at all? Drives the empty states. */
export const jiraConfigured = (state = S.get()) => jiraProjects(state).length > 0;

/**
 * Which Jira project a task belongs to, from the app project it is filed under.
 *
 * `jiraKey` on the project record is the link. A project with no key, or one
 * naming a Jira project this app does not know the rules for, falls back to
 * the first configured project rather than guessing.
 */
export function jiraKeyFor(task, state = S.get()) {
  if (task?.jira?.project) return task.jira.project;
  const all = jiraProjects(state);
  const proj = (state.projects || []).find(p => p.id === task?.project);
  if (proj?.jiraKey && all.some(p => p.key === proj.jiraKey)) return proj.jiraKey;
  return all[0]?.key || '';
}

/**
 * The epic a task should hang off, before anyone types anything.
 *
 * The project record wins, so an epic can be moved per project — a new
 * milestone epic each version, say — without touching the source. Failing
 * that, the Jira project's own default.
 */
export function defaultEpicFor(task, state = S.get()) {
  const proj = (state.projects || []).find(p => p.id === task?.project);
  const own = String(proj?.jiraEpic || '').trim().toUpperCase();
  if (own) return own;
  return jiraProject(jiraKeyFor(task, state)).defaultParent || '';
}

/** The component the ticket carries. Set by the Jira project, not per task. */
export const componentFor = (task, state = S.get()) =>
  jiraProject(jiraKeyFor(task, state)).component || '';

/**
 * Labels the rules can work out. May legitimately be empty.
 *
 * The division comes first because it is the rule that always applies; the
 * project's summary rules then add anything more specific.
 *
 * @param {string} projectKey
 * @param {string} summary
 * @param {string} [divisionId]  the task's division, e.g. `ANIM`
 */
export function suggestLabels(projectKey, summary, divisionId = '', extra = []) {
  const p = jiraProject(projectKey);
  const out = new Set();
  const dl = divisionLabel(divisionId);
  if (dl) out.add(dl);
  /*
   * Labels the task carries in its own right.
   *
   * A logged GFX scope spans disciplines by nature, so it has no single
   * division and the rule above yields nothing — which made every scope fail
   * a project's "at least one Label" rule. It now records the divisions its breakdown
   * actually covers, and they all come through here.
   */
  for (const l of extra || []) if (l) out.add(String(l));
  /* `test` arrives as a RegExp when it was written in code and as a string
     once the rules came from state — JSON and Excel have no regex literal. So
     both are accepted, and a string that is not a valid pattern is skipped
     rather than throwing in the middle of queueing thirty tasks. */
  for (const r of (p.labelRules || [])) {
    let re = r.test;
    if (!(re instanceof RegExp)) {
      try { re = new RegExp(String(re), 'i'); } catch { continue; }
    }
    if (re.test(summary || '')) (r.labels || []).forEach(l => out.add(l));
  }
  return [...out];
}

/**
 * Everything this project needs before an issue can be created.
 * @returns {string[]} human-readable gaps; empty means ready to send
 */
export function validate(item) {
  const p = jiraProject(item.project);
  /* Nothing configured is one problem, not five. Listing "Summary" and a
     priority "one of " underneath it would bury the only thing to fix. */
  if (!p.key) return ['a Jira project — add one in Settings → Integrations'];

  const miss = [];
  if (!String(item.summary || '').trim())     miss.push('Summary');
  if (!String(item.description || '').trim()) miss.push('Description');
  if (p.labelsRequired && !(item.labels || []).length) miss.push('at least one Label');
  if (p.requiresParent && !String(item.parent || '').trim()) miss.push('a Parent epic');
  if ((p.priorities || []).length && !p.priorities.includes(item.priority)) {
    miss.push(`Priority (one of ${p.priorities.join(', ')})`);
  }
  return miss;
}

/* ---------- the event log ------------------------------------------------ */

/*
 * Every step a task takes towards Jira, with a timestamp.
 *
 * The task itself only carries the LATEST of each stamp — `queuedAt`,
 * `sentAt`, `filedAt` — so a task queued, dropped and queued again keeps no
 * record of the first attempt, and "when was this imported" had no answer
 * beyond the most recent one. This is append-only and keeps its own copy of
 * the title, so the history survives the task being renamed or deleted.
 */
/*
 * Queueing and un-queueing are no longer recorded.
 *
 * They are working state, not history — a queue you assemble and reshuffle
 * before sending says nothing later, and it buried the three steps that do:
 * what went over, what Jira made of it, and what it rejected.
 */
export const JIRA_EVENTS = {
  exported: { label: 'Imported', chip: 'info', verb: 'handed to the helper' },
  filed:    { label: 'Filed',    chip: 'ok',   verb: 'created in Jira' },
  failed:   { label: 'Failed',   chip: 'risk', verb: 'rejected by Jira' },
};
export const jiraEventKind = id => JIRA_EVENTS[id] || { label: id, chip: '', verb: id };

/* Enough to be a history, small enough never to bloat a backup. */
const EVENT_CAP = 4000;

/**
 * Record one event. Called from inside an existing `mutate`, so it takes the
 * draft state rather than opening a second transaction — a bulk queue of
 * thirty tasks is one undo step, and thirty nested mutations would not be.
 */
export function pushJiraEvent(s, task, event, extra = {}) {
  if (!JIRA_EVENTS[event]) return;      // not a step worth keeping
  s.jiraEvents ||= [];
  s.jiraEvents.push({
    id: S.uid('je'),
    at: Date.now(),
    taskId: task?.id || '',
    title: String(task?.title || '').slice(0, 160),
    project: task?.project || '',
    /* The division travels with the event so the history can be filtered by it
       even after the task has moved division or been deleted. */
    division: task?.division || '',
    jiraProject: task?.jira?.project || '',
    event,
    ...extra,
  });
  if (s.jiraEvents.length > EVENT_CAP) s.jiraEvents = s.jiraEvents.slice(-EVENT_CAP);
}

/** The history, newest first. Steps no longer kept are filtered out. */
export const jiraEvents = (state = S.get()) =>
  (state.jiraEvents || []).filter(e => JIRA_EVENTS[e.event]).sort((a, b) => b.at - a.at);

/* ---------- the queue ---------------------------------------------------- */

/*
 * The queue is per task, stored on the task itself, so it survives a reload,
 * rides along in every backup, and cannot get out of step with the task it
 * describes. `state` is the whole lifecycle:
 *
 *   (none)   never queued
 *   queued   waiting to be exported and filed
 *   sent     exported; the helper has been given it
 *   filed    the helper created it; `key` and `url` are set
 *   failed   the helper reported a reason in `err`
 */
export const queueOf = (task) => task.jira || null;

export const isFiled  = t => !!(t.jira && t.jira.key);
export const isQueued = t => !!(t.jira && t.jira.state === 'queued');

/**
 * The checklist steps that should become sub-tasks, with their positions.
 *
 * Steps already filed keep their key and are sent anyway with `key` set, so
 * the helper can skip them by name rather than by guessing — re-queueing a
 * task whose checklist has grown files only the new steps.
 */
/**
 * The task's estimate as Jira's Original Estimate, e.g. `8h`.
 *
 * Blank when there is no estimate — sending `0h` would assert that the work
 * takes no time, which is a different claim from not having estimated it.
 */
export function originalEstimateOf(task) {
  const n = Number(task?.estimate);
  if (!Number.isFinite(n) || n <= 0) return '';
  const rounded = Math.round(n * 100) / 100;
  return `${rounded}h`;
}

export function subtasksOf(task) {
  return (task.checklist || [])
    .map((c, index) => ({ index, summary: String(c.t || '').trim(), done: !!c.done, key: c.jiraKey || '' }))
    .filter(c => c.summary);
}

/* The tag put on a task once its Jira issue exists. A tag rather than a hidden
   flag so it shows on the card, filters in the list, and rides along in the
   Excel round-trip like any other tag. */
export const IMPORTED_TAG = 'Imported';
export const isImported = t =>
  (t.tags || []).some(x => String(x).toLowerCase() === IMPORTED_TAG.toLowerCase());

export function queuedTasks(state = S.get()) {
  return (state.tasks || []).filter(isQueued);
}

/** Put a task in the queue, or update what it will be filed as. */
export function enqueue(taskId, fields) {
  S.mutate(s => {
    const t = (s.tasks || []).find(x => x.id === taskId);
    if (!t) return;
    t.jira = {
      ...(t.jira || {}),
      state: 'queued',
      project: fields.project,
      summary: fields.summary,
      description: fields.description,
      labels: fields.labels || [],
      priority: fields.priority,
      parent: fields.parent || '',
      assignee: fields.assignee || '',
      err: '',
      queuedAt: Date.now(),
    };
  }, { label: 'queue for Jira' });
}

export function dequeue(taskId) {
  S.mutate(s => {
    const t = (s.tasks || []).find(x => x.id === taskId);
    if (t?.jira) { t.jira.state = ''; t.jira.err = ''; }
  }, { label: 'remove from Jira queue' });
}

/* ---------- queueing a selection ---------------------------------------- */

/**
 * What one task would be filed as, with every rule applied.
 *
 * Pure — it reads state and returns a plan. Selecting thirty tasks and being
 * told afterwards that eleven were rejected is no use, so this is what the
 * bulk dialog shows *before* anything is queued.
 *
 * @param {object} task
 * @param {object} opt
 * @param {string} [opt.parent]        parent epic to apply where the task has none
 * @param {string} [opt.priority]      priority to apply instead of the project default
 * @param {boolean} [opt.titleAsDesc]  use the title where the task has no notes
 * @param {object}  [opt.state]
 */
export function planFor(task, opt = {}) {
  const state = opt.state || S.get();
  const key = jiraKeyFor(task, state);
  const p = jiraProject(key);

  const summary = String(task.jira?.summary || task.title || '').trim();
  let description = String(task.jira?.description || task.desc || '').trim();
  if (!description && opt.titleAsDesc) description = summary;

  const fields = {
    project: key,
    summary,
    description,
    /* Existing labels win only if somebody edited them by hand for this task;
       otherwise the rules decide, so changing a task's division changes its
       label without anyone having to remember to. */
    labels: task.jira?.labelsEdited && task.jira?.labels?.length
      ? task.jira.labels
      : suggestLabels(key, summary, task.division, task.jiraLabels),
    priority: opt.priority && p.priorities.includes(opt.priority)
      ? opt.priority
      : (task.jira?.priority && p.priorities.includes(task.jira.priority)
          ? task.jira.priority : p.defaultPriority),
    /* What the task itself says, then what was typed for this batch, then the
       project's epic, then the Jira project's. A default nobody typed is still
       a default: the point of items 2 and 3 is that GFX work lands under the
       right epic without anyone remembering the key. */
    parent: String(task.jira?.parent || opt.parent || defaultEpicFor(task, state) || '')
      .trim().toUpperCase(),
    assignee: '',
  };

  /* The component is reported but deliberately NOT stored on the task:
     `buildQueue()` derives it from the Jira project at export time, and two
     copies of the same fact drift. */
  return { taskId: task.id, title: task.title, fields, component: p.component || '',
           gaps: validate(fields), jiraKey: p.key };
}

/**
 * Queue several tasks at once. Only the ones with no gaps are queued.
 *
 * One `mutate()` for the whole selection, so a bulk queue is a single undo
 * step rather than thirty.
 *
 * @returns {{queued:object[], skipped:object[]}}
 */
export function enqueueMany(taskIds, opt = {}) {
  const state = opt.state || S.get();
  const plans = taskIds
    .map(id => (state.tasks || []).find(t => t.id === id))
    .filter(Boolean)
    .map(t => planFor(t, { ...opt, state }));

  const queued = plans.filter(p => !p.gaps.length);
  const skipped = plans.filter(p => p.gaps.length);

  if (queued.length) {
    S.mutate(s => {
      for (const plan of queued) {
        const t = (s.tasks || []).find(x => x.id === plan.taskId);
        if (!t) continue;
        t.jira = {
          ...(t.jira || {}), ...plan.fields,
          state: 'queued', err: '', queuedAt: Date.now(),
        };
      }
    }, { label: `queue ${queued.length} task${queued.length === 1 ? '' : 's'} for Jira` });
  }
  return { queued, skipped };
}

/* ---------- the file the helper reads ------------------------------------ */

export const QUEUE_FILE  = 'gfx-jira-queue.json';
export const RESULT_FILE = 'gfx-jira-result.json';

/**
 * Build the queue file.
 *
 * `taskId` travels with each item and comes back on the result, which is what
 * lets the helper's ledger key on it and refuse to file the same task twice
 * however many times this file is exported.
 */
export function buildQueue(state = S.get()) {
  const items = queuedTasks(state).map(t => ({
    taskId: t.id,
    project: t.jira.project,
    issueType: jiraProject(t.jira.project).issueType,
    summary: t.jira.summary,
    description: t.jira.description,
    labels: t.jira.labels || [],
    priority: t.jira.priority,
    parent: t.jira.parent || '',
    assignee: t.jira.assignee || '',
    component: jiraProject(t.jira.project).component || '',
    reporter: reporterAccountId(),
    /*
     * The task's estimate becomes Jira's Original Estimate.
     *
     * Sent as a string with the unit, because that is what Jira's time-tracking
     * field parses — a bare number is read as SECONDS, which would turn an
     * 8-hour task into eight seconds. Fractions are fine: `1.5h`.
     */
    originalEstimate: originalEstimateOf(t),
    /*
     * The checklist becomes Jira sub-tasks of the issue this row creates.
     *
     * It was not sent at all before, so a task with six checklist steps
     * arrived in Jira as a bare Task and the breakdown stayed behind in this
     * app. `index` travels so the helper's answer can be written back onto
     * the right step — the text alone is not a key, since two steps can read
     * the same and either can be renamed afterwards.
     */
    subtasks: subtasksOf(t),
  }));
  return {
    app: 'GFX Prod App',
    kind: 'jira-queue',
    version: 1,
    exported: new Date().toISOString(),
    // Reused if the same export is filed twice, so a retry replays rather
    // than creates. Mirrors the per-batch half of the Art Prod App's ledger.
    batchId: 'gfx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    items,
  };
}

/** Mark what we just handed over, so the UI stops offering to send it again. */
export function markSent(batchId, state = S.get()) {
  const ids = queuedTasks(state).map(t => t.id);
  S.mutate(s => {
    for (const t of s.tasks || []) {
      if (!ids.includes(t.id)) continue;
      t.jira.state = 'sent';
      t.jira.batch = batchId;
      t.jira.sentAt = Date.now();
      pushJiraEvent(s, t, 'exported', { batch: batchId, subtasks: subtasksOf(t).length });
    }
  }, { label: 'export Jira queue' });
  return ids.length;
}

/**
 * Read back what the helper created.
 * @returns {{filed:number, failed:number, unknown:string[], details:object[]}}
 */
export function applyResult(text) {
  let doc;
  try { doc = JSON.parse(text); }
  catch (e) { throw new Error('That is not a readable result file: ' + e.message); }
  if (doc.kind !== 'jira-result' || !Array.isArray(doc.items)) {
    throw new Error('That file is not a Jira result from the local helper.');
  }

  const out = { filed: 0, failed: 0, unknown: [], details: [], subtasks: 0, subtaskFails: 0 };
  S.mutate(s => {
    s.jiraImports ||= [];
    const already = new Set(s.jiraImports.map(x => x.key));

    for (const r of doc.items) {
      const t = (s.tasks || []).find(x => x.id === r.taskId);
      if (!t) { out.unknown.push(r.taskId); continue; }
      t.jira = { ...(t.jira || {}) };
      if (r.ok && r.key) {
        t.jira.state = 'filed';
        t.jira.key = r.key;
        t.jira.url = r.url || '';
        t.jira.err = '';
        t.jira.filedAt = r.at || Date.now();
        t.jiraKey = r.key;               // the column the Excel sheet exports

        /*
         * Mark the task, and log the issue.
         *
         * The tag is what makes "already in Jira" visible on the board and
         * filterable in the list, without hiding the task — an imported task
         * is still live work. The history row is a snapshot: it keeps what
         * was actually sent, so retitling the task later does not rewrite it.
         */
        t.tags = Array.isArray(t.tags) ? t.tags : [];
        if (!t.tags.some(x => String(x).toLowerCase() === IMPORTED_TAG.toLowerCase())) {
          t.tags.push(IMPORTED_TAG);
        }

        /*
         * Sub-task keys land back on the checklist steps that produced them.
         *
         * Matched on the index the queue sent, not on the text: two steps can
         * read the same, and either can be renamed while the helper is
         * running. A step the helper could not file keeps no key, so the next
         * queue tries it again.
         */
        if (Array.isArray(r.subtasks) && Array.isArray(t.checklist)) {
          for (const sub of r.subtasks) {
            const step = t.checklist[sub.index];
            if (!step) continue;
            if (sub.ok && sub.key) { step.jiraKey = sub.key; step.jiraUrl = sub.url || ''; }
            else if (sub.error) { step.jiraErr = sub.error; }
          }
          out.subtasks = (out.subtasks || 0) + r.subtasks.filter(x => x.ok && x.key).length;
          out.subtaskFails = (out.subtaskFails || 0) + r.subtasks.filter(x => !x.ok).length;
        }
        if (!already.has(r.key)) {
          already.add(r.key);
          s.jiraImports.push({
            id: S.uid('ji'),
            taskId: t.id,
            key: r.key,
            url: r.url || '',
            title: t.jira.summary || t.title || '',
            project: t.jira.project || '',
            labels: (t.jira.labels || []).slice(),
            parent: t.jira.parent || '',
            priority: t.jira.priority || '',
            division: t.division || '',
            projectId: t.project || '',
            batch: doc.batchId || t.jira.batch || '',
            at: r.at || Date.now(),
            /* The date as well as the timestamp: the timestamp is what sorts,
               and the date is what a spreadsheet cell can hold. */
            date: new Date(r.at || Date.now()).toISOString().slice(0, 10),
            skipped: !!r.skipped,
          });
        }
        pushJiraEvent(s, t, 'filed', {
          key: r.key, url: r.url || '', batch: doc.batchId || t.jira.batch || '',
          subtasks: Array.isArray(r.subtasks) ? r.subtasks.filter(x => x.ok && x.key).length : 0,
          skipped: !!r.skipped,
        });
        out.filed++;
        out.details.push({ title: t.title, key: r.key, ok: true, skipped: !!r.skipped });
      } else {
        t.jira.state = 'failed';
        t.jira.err = r.error || 'unknown error';
        pushJiraEvent(s, t, 'failed', { detail: t.jira.err, batch: doc.batchId || '' });
        out.failed++;
        out.details.push({ title: t.title, ok: false, error: t.jira.err });
      }
    }
    s.settings ||= {};
    s.settings.jira ||= {};
    s.settings.jira.lastResult = { at: Date.now(), filed: out.filed, failed: out.failed };
  }, { label: 'apply Jira results' });

  return out;
}
