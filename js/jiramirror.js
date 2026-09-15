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

/**
 * Change the filter — and first, remember everything currently on offer.
 *
 * A tick list whose only source is the ticked set eats its own entries: untick
 * a component and it vanishes, with no way to tick it back. So the full list
 * as it stands is folded into the catalogue BEFORE the change is applied. The
 * catalogue only ever grows, which is what makes unticking safe without
 * hard-coding any name as a fallback.
 */
export function setFilter(patch) {
  const comps = allComponents();
  const labs = allLabels();
  S.mutate(s => {
    s.jira = s.jira || {};
    s.jira.catalogue = { components: comps, labels: labs };
    s.settings.jiraFilter = { ...filter(), ...patch };
  }, { label: 'Jira filter' });
}

/** Everything ever offered, from any pull. Grows, never shrinks. */
export const catalogue = () => {
  const c = S.get().jira?.catalogue || {};
  return {
    components: Array.isArray(c.components) ? c.components : [],
    labels: Array.isArray(c.labels) ? c.labels : [],
  };
};

const union = (...lists) => [...new Set(lists.flat().filter(Boolean))];

/**
 * Every component the tick list should show: what the project has, what the
 * catalogue remembers, and whatever is ticked right now — so a filter naming
 * something the current pull did not return still shows that thing.
 */
export const allComponents = () =>
  union(catalogue().components, components().map(c => c.name), filter().components).sort();

/**
 * Every label, same rule.
 *
 * `mirror().catalogue.labels` is the project-wide set the pull collects
 * separately; `mirror().labels` is only what the filtered issues happened to
 * carry. Showing the latter alone would mean you could never widen the filter
 * to a label that is currently filtered out — the list would only ever offer
 * what you already have.
 */
export const allLabels = () =>
  union(catalogue().labels, mirror()?.catalogue?.labels || [], labels(), filter().labels).sort();

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
      catalogue: m.catalogue || null,
      fields: m.fields || {}, counts: { pulled: (m.issues || []).length, kept: kept.length },
    };

    /* Fold this pull into the standing catalogue rather than replacing it: a
       narrow pull must not shrink the list of things you are allowed to widen
       the filter back to. */
    const prev = s.jira.catalogue || {};
    s.jira.catalogue = {
      components: [...new Set([...(prev.components || []),
                               ...(m.components || []).map(c => c.name)])].filter(Boolean).sort(),
      labels: [...new Set([...(prev.labels || []),
                           ...(m.catalogue?.labels || []), ...(m.labels || [])])].filter(Boolean).sort(),
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

/* ---------- getting the file in, with as few clicks as possible ----------
 *
 * Three routes, best first. Which ones exist depends on where the app is
 * running, so `intake()` MEASURES rather than assuming.
 *
 *   1. A remembered folder (File System Access API). Pick it once, then every
 *      later refresh is a single click with no dialog — and the app can check
 *      on open whether the file is newer. Chromium blocks this API inside a
 *      cross-origin iframe, which is exactly what a Teams tab is, so this
 *      route exists in Edge and not in Teams.
 *   2. Drag the file onto the card. Works everywhere, iframes included.
 *   3. The file picker. Always available; the floor, not the goal.
 *
 * There is no fourth route. A page cannot read a path it was simply told
 * about: every one of these needs the person to have pointed at the file at
 * least once. That is the browser's rule about disk access, not a gap here.
 */

const FS_DB = 'gfxprod.fs';
const FS_STORE = 'handles';
const FS_KEY = 'jiraMirrorDir';
export const MIRROR_FILE = 'gfx-jira-mirror.json';

let dirHandle = null;

function fsdb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(FS_DB, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(FS_STORE)) r.result.createObjectStore(FS_STORE);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function fsPut(k, v) {
  const db = await fsdb();
  await new Promise((res, rej) => {
    const tx = db.transaction(FS_STORE, 'readwrite');
    tx.objectStore(FS_STORE).put(v, k);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  db.close();
}
async function fsGet(k) {
  const db = await fsdb();
  const v = await new Promise((res, rej) => {
    const tx = db.transaction(FS_STORE, 'readonly');
    const q = tx.objectStore(FS_STORE).get(k);
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
  db.close();
  return v;
}

/** What this environment actually allows. Measured, not guessed. */
export function intake() {
  const picker = typeof window.showDirectoryPicker === 'function';
  const framed = window.top !== window.self;
  return {
    canBindFolder: picker && !framed && window.isSecureContext,
    framed,
    why: !picker
      ? 'This browser cannot remember a folder. Edge and Chrome can; Firefox and Safari cannot.'
      : framed
        ? 'Browsers block folder access inside an embedded tab, and a Teams tab is one. '
          + 'Drag the file onto this card instead, or open the app in Edge to link the folder once.'
        : '',
  };
}

/** Restore a previously linked folder. Safe to call on load — no prompt. */
export async function restoreFolder() {
  if (!intake().canBindFolder) return null;
  try {
    const h = await fsGet(FS_KEY);
    if (!h) return null;
    dirHandle = h;
    return h.name || '';
  } catch { return null; }
}

export const boundFolder = () => dirHandle?.name || '';

/** Needs a real click — the picker throws without a user gesture. */
export async function bindFolder() {
  const cap = intake();
  if (!cap.canBindFolder) throw new Error(cap.why);
  const h = await window.showDirectoryPicker({ id: 'gfx-jira-mirror', mode: 'read' });
  dirHandle = h;
  await fsPut(FS_KEY, h);
  return h.name || '';
}

export async function unbindFolder() {
  dirHandle = null;
  try { const db = await fsdb(); db.transaction(FS_STORE, 'readwrite').objectStore(FS_STORE).delete(FS_KEY); db.close(); } catch { /* nothing to remove */ }
}

async function ensurePermission() {
  if (!dirHandle?.queryPermission) return true;
  if (await dirHandle.queryPermission({ mode: 'read' }) === 'granted') return true;
  // Permission usually lapses when the browser restarts. One click, not a re-pick.
  return await dirHandle.requestPermission({ mode: 'read' }) === 'granted';
}

/**
 * Read the mirror straight out of the linked folder.
 * @returns {Promise<{text:string, modified:number}|null>} null when no folder
 *          is linked or permission was refused.
 */
export async function readFromFolder() {
  if (!dirHandle) return null;
  if (!await ensurePermission()) return null;
  const fh = await dirHandle.getFileHandle(MIRROR_FILE);
  const f = await fh.getFile();
  return { text: await f.text(), modified: f.lastModified };
}

/**
 * One call for "refresh", whatever route is available.
 * Returns the import result, or null when there was nothing to read.
 */
export async function refreshFromFolder() {
  const got = await readFromFolder();
  if (!got) return null;
  const r = importMirror(got.text);
  S.mutate(s => { (s.jira ||= {}).lastFileAt = got.modified; }, { noUndo: true, silent: true });
  return r;
}

/** Is the file on disk newer than the last one imported? */
export async function folderHasNewer() {
  if (!dirHandle) return false;
  try {
    if (!await ensurePermission()) return false;
    const f = await (await dirHandle.getFileHandle(MIRROR_FILE)).getFile();
    return f.lastModified > (S.get().jira?.lastFileAt || 0);
  } catch { return false; }
}

/** Wipe every task. Used by Settings → "Delete all tasks". */
export function clearTasks() {
  const n = S.get().tasks.length;
  S.mutate(s => { s.tasks = []; }, { label: 'delete all tasks' });
  return n;
}
