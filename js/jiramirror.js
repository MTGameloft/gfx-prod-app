/* ============================================================================
   jiramirror.js — the Jira mirror: vocabularies, the Master Filter, and import.

   WHAT THIS IS
   ------------
   `tools/jira-pull.ps1` writes gfx-jira-mirror.json: every issue in scope plus
   the vocabularies needed to render them the way Jira does — statuses,
   priorities, sprints, components, versions, issue types and labels. This
   module is the app's side of that file.

   VOCABULARIES ARE DATA, NOT CODE
   -------------------------------
   No project, status, label or component name is written down in this
   repository — it is public, and a project's shape is its owner's business.
   There is a practical reason too: a sample of one component showed four
   statuses where the workflow actually had eight, and the missing ones were
   the licensing gates a producer most needs to see. Hard-coding what you
   happened to see is how a mirror lies. Every list below is read from the
   pulled file.

   THE MASTER FILTER
   -----------------
   A real project carries far more components than one team works on, and most
   of them — audio, development, game design — have nothing to do with this
   one. An app flooded with them is worse than no app. The filter is a set of
   ticked components and labels, and it is applied in two places:

     - here, on import, so an old mirror file still renders correctly; and
     - in the pull script, via gfx-jira-filter.json, so the fetch itself is
       narrow and a refresh stays fast.

   Both, deliberately. Filtering only at the pull would mean changing a tick
   box did nothing until the next pull; filtering only here would mean pulling
   a thousand issues to throw away nine hundred.

   STATUS IS KEPT TWICE
   --------------------
   `task.jiraStatus` is Jira's own name, and the board lanes are built from it.
   `task.status` stays one of the app's six ids, because the dashboard, the
   timeline and calc.js all count on it. Mapping in one direction only, at
   import, keeps those views working without teaching them about Jira.
   ========================================================================= */

import * as S from './store.js';

/* ---------- shape -------------------------------------------------------- */

export const MIRROR_KIND = 'gfx-jira-mirror';
export const FILTER_FILE = 'gfx-jira-filter.json';

/** The pulled vocabularies, or null when nothing has been imported yet. */
export const mirror = () => S.get().jira?.mirror || null;
export const hasMirror = () => !!mirror();

/**
 * The Master Filter.
 *
 * An empty `components` list means "nothing ticked yet" — on a fresh install
 * that would filter everything away, so the caller treats an empty list as
 * "no component restriction". `labels: []` genuinely means "any label",
 * because labels are a refinement, not the primary axis.
 */
export function filter() {
  const f = S.get().settings?.jiraFilter || {};
  return {
    components: Array.isArray(f.components) ? f.components : [],
    labels:     Array.isArray(f.labels) ? f.labels : [],
    includeDone: !!f.includeDone,
  };
}

export function setFilter(patch) {
  S.mutate(s => {
    s.settings.jiraFilter = { ...filter(), ...patch };
  }, { label: 'Jira filter' });
}

/* ---------- vocabularies ------------------------------------------------- */

const CAT_RANK = { new: 0, indeterminate: 1, done: 2 };

/**
 * Board lanes, in a sane order.
 *
 * Jira returns statuses grouped per issue type, which is workflow order but
 * starts wherever the first issue type happened to start — often on a finished
 * status. Sorting by status category and keeping the original order within
 * each gives the not-started ones, then the in-flight ones, then the finished.
 */
export function statuses() {
  const m = mirror();
  if (!m) return [];
  return m.statuses
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => (CAT_RANK[a.category] ?? 1) - (CAT_RANK[b.category] ?? 1) || a.i - b.i);
}

export const priorities  = () => mirror()?.priorities || [];

/**
 * Priorities worth offering in a drop-down.
 *
 * `/rest/api/3/priority` is a SITE-wide list — 74 entries here — and a picker
 * that long is not a picker. This narrows it to the ones this project's issues
 * actually use, which is a far shorter and more honest list, while always
 * keeping `current` so an unusual value on one issue is never silently lost.
 */
export function prioritiesInUse(current = '') {
  const used = new Set(S.get().tasks.map(t => t.jiraPriority).filter(Boolean));
  if (current) used.add(current);
  const known = priorities().filter(p => used.has(p.name));
  // anything in use that the priority list did not describe still belongs here
  for (const name of used) if (!known.some(p => p.name === name)) known.push({ id: name, name });
  return known.length ? known : priorities();
}
export const components  = () => mirror()?.components || [];
export const versions    = () => mirror()?.versions || [];
export const issueTypes  = () => mirror()?.issueTypes || [];
export const labels      = () => mirror()?.labels || [];

/** Sprints, most useful first: active, then future, then closed by recency. */
export function sprints() {
  const list = mirror()?.sprints || [];
  const rank = st => (st === 'active' ? 0 : st === 'future' ? 1 : 2);
  return [...list].sort((a, b) =>
    rank(a.state) - rank(b.state) ||
    String(b.startDate || '').localeCompare(String(a.startDate || '')));
}
export const activeSprints = () => sprints().filter(s => s.state === 'active');

/* ---------- hierarchy ---------------------------------------------------- */

/**
 * Initiative(2) → Epic(1) → Task/Story/Bug/User Story/Request(0) → Sub-task(-1).
 * Parent arrives two ways in this project — the modern `parent` field and the
 * legacy Epic Link — and the pull script has already collapsed both into one.
 */
export const levelOf = t => (typeof t?.hierarchyLevel === 'number' ? t.hierarchyLevel : 0);

export function childrenOf(key, rows) {
  if (!key) return [];
  return rows.filter(t => t.parentKey === key);
}

/** Rows with no parent *inside this set* — so a filtered view still has roots. */
export function roots(rows) {
  const present = new Set(rows.map(t => t.jiraKey).filter(Boolean));
  return rows.filter(t => !t.parentKey || !present.has(t.parentKey));
}

/**
 * Depth-first walk, parents before children, so the list view can indent.
 * Guards against a cycle — Jira will happily let an epic link to itself.
 */
export function tree(rows) {
  const out = [];
  const seen = new Set();
  const walk = (row, depth) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    out.push({ row, depth });
    for (const c of childrenOf(row.jiraKey, rows)) walk(c, depth + 1);
  };
  for (const r of roots(rows)) walk(r, 0);
  // anything left is inside a cycle; show it flat rather than dropping it
  for (const r of rows) if (!seen.has(r.id)) out.push({ row: r, depth: 0 });
  return out;
}

/* ---------- the Master Filter -------------------------------------------- */

/** Does one mirror issue survive the filter? */
export function passes(issue, f = filter()) {
  const comps = issue['Components'] || [];
  if (f.components.length && !comps.some(c => f.components.includes(c))) return false;
  if (f.labels.length) {
    const ls = issue['Labels'] || [];
    if (!ls.some(l => f.labels.includes(l))) return false;
  }
  if (!f.includeDone && issue['Status Category'] === 'done') return false;
  return true;
}

/** The JQL the pull script will run. Shown in Settings so it is never a mystery. */
export function filterJql(project = mirror()?.project?.key || '', f = filter()) {
  // The project key comes from the pulled mirror, never from a literal here:
  // this repository is public and the key names a real internal project.
  const q = project ? [`project = ${project}`] : [];
  if (f.components.length) {
    q.push(`component in (${f.components.map(c => `"${c.replace(/"/g, '\\"')}"`).join(', ')})`);
  }
  if (f.labels.length) {
    q.push(`labels in (${f.labels.map(l => `"${l.replace(/"/g, '\\"')}"`).join(', ')})`);
  }
  if (!f.includeDone) q.push('statusCategory != Done');
  return q.join(' AND ') + ' ORDER BY created ASC';
}

/** What gets written to gfx-jira-filter.json for the pull script to read. */
export function filterFile() {
  const f = filter();
  return JSON.stringify({
    kind: 'gfx-jira-filter',
    version: 1,
    savedAt: new Date().toISOString(),
    project: mirror()?.project?.key || '',
    components: f.components,
    labels: f.labels,
    includeDone: f.includeDone,
    jql: filterJql(),
  }, null, 2);
}

/* ---------- import ------------------------------------------------------- */

/**
 * Translate a Jira status into the app's six-id vocabulary.
 *
 * Exported because the board lets you drag a card between Jira's lanes, and
 * the drop has to write BOTH: `jiraStatus` so the card stays where it was
 * dropped, and `status` so the dashboard and timeline still understand it.
 * Writing only the first leaves those views blind; writing only the second
 * makes the card jump back on the next render.
 */
export function statusPatch(jiraStatusName) {
  const st = (mirror()?.statuses || []).find(x => x.name === jiraStatusName);
  const cat = st?.category || 'new';
  return { jiraStatus: jiraStatusName, statusCategory: cat, status: APP_STATUS(jiraStatusName, cat) };
}

const APP_STATUS = (name, cat) => {
  const n = String(name || '').toLowerCase();
  if (n.includes('block')) return 'blocked';
  if (n.includes('review') || n.includes('licensor')) return 'review';
  if (n.includes('backlog')) return 'backlog';
  if (cat === 'done') return 'done';
  if (cat === 'indeterminate') return 'doing';
  return 'todo';
};

/**
 * Jira priority name → the app's four ids.
 *
 * Exported for the same reason as `statusPatch`: the editor offers Jira's list
 * (this project has drifted to nine live values meaning about four things) and
 * something still has to answer "is this urgent" for the dashboard.
 */
export const appPriority = name => APP_PRIORITY(name);

const APP_PRIORITY = name => {
  const n = String(name || '').toLowerCase();
  if (/p1|priority 1|critical|highest|blocker/.test(n)) return 'critical';
  if (/p2|priority 2|major|high/.test(n)) return 'high';
  if (/p4|p5|priority 4|priority 5|low|minor|trivial|nice to have/.test(n)) return 'low';
  return 'normal';
};

const dateOnly = v => (v ? String(v).slice(0, 10) : '');

/**
 * Find or create the person behind a Jira user.
 *
 * Matched on accountId first — a display name can change, and two people can
 * share one. New people are marked `source: 'jira'` so a later roster import
 * can tell them apart from someone you added by hand.
 */
function personFor(user, s) {
  if (!user || !user.accountId) return '';
  let p = s.people.find(x => x.jiraAccountId === user.accountId);
  if (!p) p = s.people.find(x => (x.name || '').toLowerCase() === (user.displayName || '').toLowerCase());
  if (p) {
    if (!p.jiraAccountId) p.jiraAccountId = user.accountId;
    return p.id;
  }
  const id = S.uid('pe');
  s.people.push({
    id, name: user.displayName || '(unknown)', email: user.email || '',
    jiraAccountId: user.accountId, active: user.active !== false,
    division: '', role: '', source: 'jira',
  });
  return id;
}

/** Which sprint is "the" sprint for an issue: the last non-closed one wins. */
function currentSprint(names, all) {
  if (!names || !names.length) return '';
  const byName = new Map(all.map(s => [s.name, s]));
  const open = names.filter(n => byName.get(n) && byName.get(n).state !== 'closed');
  return open.length ? open[open.length - 1] : names[names.length - 1];
}

/**
 * Read a mirror file and replace the task board with it.
 *
 * Replace, not merge: the mirror is a statement about what Jira contains right
 * now, and a merge would silently keep issues that have since left the filter
 * or been deleted. Tasks you created in the app that were never pushed to Jira
 * are kept — they have no Jira key and the mirror says nothing about them.
 */
export function importMirror(text, { keepLocal = true } = {}) {
  let m;
  try { m = JSON.parse(text); }
  catch { throw new Error('That file is not readable JSON.'); }
  if (m.kind !== MIRROR_KIND) {
    throw new Error('That is not a Jira mirror file. Run tools\\jira-pull.ps1 to produce one.');
  }

  const f = filter();
  const kept = (m.issues || []).filter(i => passes(i, f));
  const all = m.sprints || [];

  let created = 0;
  S.mutate(s => {
    s.jira = s.jira || {};
    s.jira.mirror = {
      pulledAt: m.pulledAt, site: m.site, jql: m.jql,
      project: m.project, components: m.components || [], versions: m.versions || [],
      issueTypes: m.issueTypes || [], statuses: m.statuses || [],
      priorities: m.priorities || [], sprints: all, labels: m.labels || [],
      fields: m.fields || {}, counts: { pulled: (m.issues || []).length, kept: kept.length },
    };

    const local = keepLocal ? s.tasks.filter(t => !t.jiraKey && t.source !== 'jira') : [];

    const rows = kept.map((i, n) => {
      const sprint = currentSprint(i['Sprint'], all);
      return {
        id: 'jira_' + i['Key'],
        jiraKey: i['Key'],
        source: 'jira',

        /* Jira's own names are what the UI shows; these are the storage keys
           the rest of the app already reads. */
        title: i['Summary'] || '',
        desc: i['Description'] || '',

        issueType: i['Issue Type'] || '',
        hierarchyLevel: typeof i['Hierarchy Level'] === 'number' ? i['Hierarchy Level'] : 0,
        parentKey: i['Parent'] || '',

        jiraStatus: i['Status'] || '',
        statusCategory: i['Status Category'] || 'new',
        status: APP_STATUS(i['Status'], i['Status Category']),

        jiraPriority: i['Priority'] || '',
        priority: APP_PRIORITY(i['Priority']),

        assignee: personFor(i['Assignee'], s),
        assigneeName: i['Assignee']?.displayName || '',
        reporterName: i['Reporter']?.displayName || '',

        labels: i['Labels'] || [],
        components: i['Components'] || [],
        tags: [...(i['Labels'] || []), ...(i['Components'] || [])],

        sprint: typeof sprint === 'object' ? sprint.name : sprint,
        sprints: i['Sprint'] || [],
        fixVersions: i['Fix versions'] || [],

        /* Jira reports time in seconds; the pull already converted to hours.
           The app's own estimate field is in days. */
        originalEstimate: i['Original estimate'] ?? null,
        remainingEstimate: i['Remaining Estimate'] ?? null,
        timeSpent: i['Time Spent'] ?? null,
        storyPoints: i['Story Points'] ?? i['Story point estimate'] ?? null,
        estimate: i['Original estimate'] ? +(i['Original estimate'] / 8).toFixed(2) : 0,
        spent: i['Time Spent'] ? +(i['Time Spent'] / 8).toFixed(2) : 0,

        start: dateOnly(i['Start date']),
        due: dateOnly(i['Due date']),
        end: dateOnly(i['End date']),

        tshirt: i['T-Shirt Size'] || '',
        percentDone: i['Percent Done'] || '',
        flagged: !!i['Flagged'],
        resolution: i['Resolution'] || '',
        links: i['Linked Issues'] || [],
        attachments: i['Attachment'] || 0,
        url: i['Url'] || '',

        created: Date.parse(i['Created']) || Date.now(),
        updated: Date.parse(i['Updated']) || Date.now(),
        order: n,
        division: '',
        objectiveId: '',
        checklist: [],
      };
    });

    created = rows.length;
    s.tasks = [...rows, ...local];
  }, { label: 'Jira mirror', noUndo: true });

  return {
    pulled: (m.issues || []).length,
    kept: created,
    skipped: (m.issues || []).length - created,
    sprints: all.length,
    statuses: (m.statuses || []).length,
    pulledAt: m.pulledAt,
  };
}

/** Wipe every task. Used by Settings → "Delete all tasks". */
export function clearTasks() {
  const n = S.get().tasks.length;
  S.mutate(s => { s.tasks = []; }, { label: 'delete all tasks' });
  return n;
}
