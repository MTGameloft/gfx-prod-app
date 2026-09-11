/* ============================================================================
   store.js — the single source of truth.

   Everything the app knows lives in one plain object. It is persisted to
   localStorage (per browser, per user — nothing leaves the machine unless you
   explicitly connect SharePoint in Settings) and can be exported to a JSON
   file at any time.

   Rules of the house:
     • Never mutate state outside a mutate() call — that is what triggers
       autosave, the undo ring and the re-render.
     • Every list item carries a stable `id`. Order is explicit, never implied
       by array position alone where it matters.
   ========================================================================= */

import { seed } from './seed.js';
import { SENIORITY, normSeniority } from './seniority.js';
import * as lock from './lock.js';

const KEY      = 'gfxprod.state.v1';
const RESCUE   = 'gfxprod.rescue';
const UNDO_MAX = 40;
const SCHEMA   = 1;

let state = null;
const undoRing = [];
const redoRing = [];
const subs = new Set();
let saveTimer = null;
let dirty = false;

/* ---------- ids & clone -------------------------------------------------- */

export const uid = (p = 'x') =>
  p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const clone = o => (typeof structuredClone === 'function'
  ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

/* ---------- load / save -------------------------------------------------- */

/**
 * Fill in keys a newer version added, without ever clobbering existing data.
 *
 * This walks two levels into `prefs` and `settings`, because a top-level-only
 * pass misses the common case: a new sub-key inside an object that already
 * exists (`settings.graph.caps`, say). Arrays are left alone — a user with one
 * division should not silently get five back.
 */
function fillMissing(target, base, depth = 2) {
  for (const k of Object.keys(base)) {
    if (!(k in target)) { target[k] = base[k]; continue; }
    if (depth > 1 &&
        base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) &&
        target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      fillMissing(target[k], base[k], depth - 1);
    }
  }
}

/**
 * Goals used to live inside each person as `p.goals`. They are a top-level
 * collection now, keyed by `personId`, like leave, tasks and one-to-ones —
 * which is what lets one Excel sheet hold every goal on the team and their
 * milestones hang off them as an ordinary child sheet.
 *
 * Additive and idempotent: rows are copied across, the nested array is then
 * removed, and a goal that has already been moved is not moved twice. Runs on
 * load, before anything reads the state.
 */
function liftGoals(s) {
  if (!Array.isArray(s.people)) return;
  s.goals ||= [];
  const seen = new Set(s.goals.map(g => g.id));
  let moved = 0;

  for (const p of s.people) {
    if (!Array.isArray(p.goals) || !p.goals.length) { delete p.goals; continue; }
    for (const g of p.goals) {
      if (g && g.id && !seen.has(g.id)) {
        s.goals.push({ ...g, personId: p.id });
        seen.add(g.id);
        moved++;
      }
    }
    delete p.goals;
  }
  if (moved) console.info(`[GFX] moved ${moved} goal(s) onto the top-level collection`);
}

function migrate(s) {
  if (!s || typeof s !== 'object') return null;
  if (!s.v) s.v = SCHEMA;
  const base = seed();
  for (const k of Object.keys(base)) if (!(k in s)) s[k] = base[k];
  if (s.prefs)    fillMissing(s.prefs, base.prefs, 2);
  if (s.settings) fillMissing(s.settings, base.settings, 3);
  liftGoals(s);
  seedBoardOrder(s);
  seedJiraEvents(s);
  seedDivisionLabels(s);
  seedGfxProdProject(s);
  alignSeniority(s);
  return s;
}

/**
 * Bring the rate card and everyone's rung onto the current ladder.
 *
 * The ladder was renamed months ago — `junior`, `mid`, `senior` became
 * `Junior 1`, `Junior 2`, `Senior`, and `Director` has now become `Vendor` —
 * but nothing ever migrated the DATA. Changing `SENIORITY` only changed what a
 * drop-down offers, so a store written before the rename kept showing the old
 * words in the rate card and on every person, and `rateFor()` could not match
 * them against each other.
 *
 * Runs on EVERY load, not once behind a flag, and is idempotent: the rate card
 * is rebuilt into the canonical order, and a rung already in its current
 * spelling is left alone. That way a workbook or a backup written under an old
 * ladder is corrected the moment it is imported, not only on first upgrade.
 *
 * Money is never invented. A rung's monthly figure is carried across by name,
 * and a genuinely new rung starts at 0 — which reads as "not set yet" on the
 * Rate Card screen rather than as a real rate.
 */
function alignSeniority(s) {
  /* People first: their rungs are what the card has to be able to price. */
  for (const p of s.people || []) {
    if (!p || p.seniority == null) continue;
    const next = normSeniority(p.seniority);
    if (next !== p.seniority) p.seniority = next;
  }

  /* Estimates carry a rung per line and per division, frozen at sign-off.
     A logged snapshot is deliberately NOT touched — it records what was agreed
     — but the live ones are renamed so the picker can show them. */
  for (const e of s.wbEstimates || []) {
    for (const k of Object.keys(e.seniority || {})) {
      const next = normSeniority(e.seniority[k]);
      if (next !== e.seniority[k]) e.seniority[k] = next;
    }
    for (const l of e.lines || []) {
      if (!l?.seniority) continue;
      const next = normSeniority(l.seniority);
      if (next !== l.seniority) l.seniority = next;
    }
  }

  /* The card: one row per rung, in ladder order, keeping what was typed. */
  const old = s.rateCard || [];
  const byName = new Map();
  for (const r of old) {
    const key = normSeniority(r.seniority);
    /* First writer wins, so two legacy rows collapsing onto one rung — `mid`
       and `Junior 2` both mapping to `Junior 2` — keep the earlier figure
       rather than whichever happened to be last in the array. */
    if (key && !byName.has(key)) byName.set(key, r);
  }

  /* A vendor rate is knowable from the roster: what outsourcing partners
     actually cost. Better than 0, and better than a number nobody chose. */
  const vendorCosts = (s.people || [])
    .filter(p => p.active !== false && p.contract === 'outsource' && Number(p.costMonthly) > 0)
    .map(p => Number(p.costMonthly)).sort((a, b) => a - b);
  const vendorGuess = vendorCosts.length ? vendorCosts[Math.floor(vendorCosts.length / 2)] : 0;

  /*
   * A new rung gets a MINTED id, never a positional one.
   *
   * `rc${i + 1}` looked tidy and was wrong: a carried-over row keeps the id it
   * had, so `Lead` arriving with the old `rc4` collided with `Expert` landing
   * in slot 4. Two rows then shared an id, and the Excel round trip caught it
   * as "two rows cannot describe one record" — which is exactly the sort of
   * duplicate that quietly corrupts an import.
   */
  s.rateCard = SENIORITY.map(sen => {
    const hit = byName.get(sen);
    return {
      id: hit?.id || uid('rc'),
      seniority: sen,
      /*
       * A row that EXISTS is respected, including a deliberate 0 — tested on
       * `byName.has`, not on whether the figure is truthy. Written as
       * `Number(hit?.monthly) || vendorGuess` it fell through on zero, so the
       * seed's deliberately blank Vendor rung came back as the roster's
       * retainer and a fresh install showed a rate nobody had entered.
       * The guess is for a rung that is genuinely MISSING.
       */
      monthly: hit ? (Number(hit.monthly) || 0)
                   : (sen === 'Vendor' ? vendorGuess : 0),
    };
  });
}

/**
 * Give the production work its own project.
 *
 * Same reasoning as the division above, and the same trap: putting it in
 * `seed()` reaches a fresh install and nobody else, because `projects` is the
 * user's own data. The sidebar builds one subsection per project, so this is
 * all it takes for GFX Prod to get the full Overview / Tasks / Scopes /
 * Milestones / Risks / Team structure the game projects have.
 *
 * Dates span the current calendar year rather than the seed's hard-coded 2026,
 * because the Overview draws a "% elapsed" bar off them. Budget starts at zero:
 * an invented figure would show up as a forecast overrun on day one.
 */
function seedGfxProdProject(s) {
  s.meta ||= {};
  if (s.meta.gfxProdProjectSeeded) return;
  s.meta.gfxProdProjectSeeded = true;

  s.projects ||= [];
  if (s.projects.some(p => p.id === 'p_gfxp' || String(p.code).toUpperCase() === 'GFXP')) return;

  const y = new Date().getFullYear();
  /* After the last non-archived game project, before Incubation if it is
     there — the sidebar reads this order until the user drags it. */
  const at = s.projects.findIndex(p => p.id === 'p_inc');
  const rec = {
    id: 'p_gfxp', code: 'GFXP', name: 'GFX Prod', status: 'live', phase: 'Live Ops',
    start: `${y}-01-01`, end: `${y}-12-31`, color: '#6264A7',
    jiraKey: '', jiraEpic: '', budget: 0, currency: 'USD',
    health: 'green', producerLead: (s.people || []).find(p => p.isMe)?.id || '',
    sharepointUrl: '', divisionId: 'PROD',
    description: 'The production work behind the games: feedback rounds, QA passes, documentation, '
      + 'pipeline and cross-team alignment. Costed against the GFX Prod division, filed into Jira '
      + 'with the GFX-Prod label.',
    milestones: [], risks: [],
  };
  if (at >= 0) s.projects.splice(at, 0, rec); else s.projects.push(rec);
}

/**
 * Give every division a Jira label, and make sure GFX Prod is one of them.
 *
 * Divisions are data, so adding `PROD` to the seed did nothing for anyone who
 * already had a roster — their `divisions` came from their own import, and GFX
 * Prod was simply absent from every division drop-down in the app. And the
 * label was read from a hard-coded map, so a division added in the app (`AD`,
 * Art Direction) produced no Jira label at all with no way to give it one.
 *
 * Both are fixed by putting the label on the division record. Runs once per
 * concern, each behind its own flag, so a division deliberately removed or a
 * label deliberately cleared is not silently restored on the next load.
 */
function seedDivisionLabels(s) {
  s.meta ||= {};
  s.divisions ||= [];

  if (!s.meta.prodDivisionSeeded) {
    s.meta.prodDivisionSeeded = true;
    if (!s.divisions.some(d => String(d.id).toUpperCase() === 'PROD')) {
      s.divisions.push({ id: 'PROD', name: 'GFX Prod', color: '#6264A7', lead: '', jiraLabel: 'GFX-Prod' });
    }
  }

  if (!s.meta.divisionLabelsSeeded) {
    s.meta.divisionLabelsSeeded = true;
    /* Kept in step with DIVISION_LABELS in jira.js, duplicated rather than
       imported: store.js is loaded by everything and must not depend on the
       Jira model. Anything not listed starts blank and is set in the app. */
    const defaults = { '2D': '2D', '3D': '3D', ANIM: 'Anim', UIUX: 'UIUX', VFX: 'VFX', PROD: 'GFX-Prod' };
    for (const d of s.divisions) {
      if (d.jiraLabel === undefined) d.jiraLabel = defaults[String(d.id).toUpperCase()] || '';
    }
  }
}

/**
 * Rebuild a Jira history from the stamps that already exist.
 *
 * The event log is new, but tasks have been carrying `queuedAt`, `sentAt` and
 * `filedAt` for a while, and the import log has its own dates. Without this
 * the History tab would open empty for someone who has already filed a dozen
 * issues, which reads as "nothing was ever imported".
 *
 * Only the latest of each stamp survives on a task, so this is a floor rather
 * than a full record — everything from here on is logged as it happens. Run
 * once, guarded by a flag: re-deriving would duplicate every row.
 */
function seedJiraEvents(s) {
  s.meta ||= {};
  if (s.meta.jiraEventsSeeded) return;
  s.jiraEvents ||= [];

  const add = (t, event, at, extra = {}) => {
    if (!at) return;
    s.jiraEvents.push({
      id: uid('je'), at, taskId: t.id, title: String(t.title || '').slice(0, 160),
      project: t.project || '', jiraProject: t.jira?.project || '',
      event, backfilled: true, ...extra,
    });
  };

  for (const t of s.tasks || []) {
    const j = t.jira;
    if (!j) continue;
    add(t, 'queued', j.queuedAt, { detail: j.project || '' });
    add(t, 'exported', j.sentAt, { batch: j.batch || '' });
    if (j.key) add(t, 'filed', j.filedAt || j.sentAt || j.queuedAt, { key: j.key, url: j.url || '', batch: j.batch || '' });
    else if (j.state === 'failed') add(t, 'failed', j.sentAt || j.queuedAt, { detail: j.err || '' });
  }

  /* Issues whose task has since been deleted still belong in the history. */
  const known = new Set(s.jiraEvents.filter(e => e.event === 'filed').map(e => e.key));
  for (const r of s.jiraImports || []) {
    if (known.has(r.key)) continue;
    s.jiraEvents.push({
      id: uid('je'), at: r.at, taskId: r.taskId || '', title: String(r.title || '').slice(0, 160),
      project: r.projectId || '', jiraProject: r.project || '',
      event: 'filed', key: r.key, url: r.url || '', batch: r.batch || '', backfilled: true,
    });
  }

  s.jiraEvents.sort((a, b) => a.at - b.at);
  s.meta.jiraEventsSeeded = true;
  if (s.jiraEvents.length) console.info(`[GFX] built ${s.jiraEvents.length} Jira history entries from existing records`);
}

/**
 * Give every task a board position.
 *
 * The board used to sort by due date, so nothing needed one. Now the lanes are
 * ordered by hand and `order` is what holds that — which means a task without
 * one would float to an arbitrary place the first time the board is opened.
 *
 * Existing tasks are seeded in the order the old board would have shown them
 * (due date, then priority), so the first render after this upgrade looks
 * exactly like the last render before it. Spaced by 1000 so a drop between two
 * neighbours has room without renumbering the lane.
 */
function seedBoardOrder(s) {
  if (!Array.isArray(s.tasks)) return;
  s.meta ||= {};

  const rank = p => ({ critical: 0, high: 1, normal: 2, low: 3 }[p] ?? 2);
  const lanes = () => {
    const m = new Map();
    for (const t of s.tasks) {
      if (!m.has(t.status)) m.set(t.status, []);
      m.get(t.status).push(t);
    }
    return m;
  };

  /*
   * The one-time pass, guarded by a flag rather than by looking at the values.
   *
   * Every seeded task carried `order: 0`, so "has no order" had to include
   * zero — which then meant a task legitimately dragged to the top of a lane,
   * where zero is a perfectly ordinary value, was renumbered on the next
   * reload. A flag says "this has been done" once and cannot be confused with
   * data.
   */
  if (!s.meta.boardOrdered) {
    for (const list of lanes().values()) {
      list.sort((a, b) =>
        (a.due || '9999').localeCompare(b.due || '9999') || rank(a.priority) - rank(b.priority));
      list.forEach((t, i) => { t.order = (i + 1) * 1000; });
    }
    s.meta.boardOrdered = true;
    return;
  }

  /* Afterwards, only fill in a task that somehow arrived without one — it
     would otherwise sort as if it were at zero, i.e. at the top. */
  for (const [status, list] of lanes()) {
    const gap = list.filter(t => typeof t.order !== 'number');
    if (!gap.length) continue;
    let next = list.reduce((m, t) => Math.max(m, typeof t.order === 'number' ? t.order : 0), 0);
    for (const t of gap) t.order = (next += 1000);
  }
}

const readRaw = () => { try { return localStorage.getItem(KEY); } catch { return null; } };

/** Is the saved data password-protected? Answerable without the password. */
export const isEncrypted = () => lock.isEnvelope(readRaw());
export const isUnlocked  = () => lock.hasKey();

/**
 * Read the saved state, decrypting first if a password is set.
 *
 * @param {object}  opt
 * @param {(attempt:number, lastError:string)=>Promise<string>} opt.requestPassword
 *        Called repeatedly until it returns a password that works. Whoever
 *        owns the UI owns this; the store only knows how to try it.
 */
export async function load({ requestPassword } = {}) {
  let raw = readRaw();

  if (lock.isEnvelope(raw)) {
    if (!requestPassword) throw new Error('This data is password-protected.');
    for (let attempt = 1; ; attempt++) {
      const pw = await requestPassword(attempt, attempt === 1 ? '' : 'That password did not work.');
      try {
        raw = await lock.unlock(pw, readRaw());
        lock.clearFailures();
        break;
      } catch (e) {
        lock.recordFailure();
        // requestPassword is expected to surface the error and ask again;
        // looping here keeps the retry logic in one place.
        if (attempt > 500) throw e;
      }
    }
  }

  if (raw) {
    try {
      state = migrate(JSON.parse(raw));
    } catch (e) {
      console.error('State unreadable, falling back to rescue copy', e);
      try {
        let r = localStorage.getItem(RESCUE);
        if (lock.isEnvelope(r)) r = null;   // the rescue copy needs the same key; skip it here
        state = migrate(JSON.parse(r));
      } catch { state = null; }
    }
  }
  if (!state) {
    state = seed();
    state.meta.seeded = true;
    // Persist immediately. Without this the sample set is regenerated on every
    // load until the first edit, so nothing the user does before that survives.
    await writeNow();
  }
  return state;
}

async function writeNow() {
  try {
    state.meta.updated = Date.now();
    const json = JSON.stringify(state);
    const blob = lock.hasKey() ? await lock.seal(json) : json;
    localStorage.setItem(KEY, blob);
    // A second copy under a different key: if a write is ever interrupted or a
    // future migration corrupts the primary, this is the parachute. It carries
    // the same encryption, so it never leaks what the primary protects.
    localStorage.setItem(RESCUE, blob);
    dirty = false;
  } catch (e) {
    console.error('Save failed', e);
    window.dispatchEvent(new CustomEvent('gfx:savefail', { detail: e }));
  }
}

export function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  return dirty ? writeNow() : Promise.resolve();
}

function scheduleSave() {
  dirty = true;
  // Kept short deliberately. Encryption is async, and `beforeunload` cannot
  // await it, so the shorter this is the smaller the window in which a change
  // could be lost to a hard close. See also the pagehide handler below.
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, lock.hasKey() ? 250 : 400);
}

window.addEventListener('beforeunload', flush);
window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

/* ---------- turning protection on and off -------------------------------- */

/** Encrypt everything from now on, and rewrite what is already stored. */
export async function enableLock(password) {
  await lock.enable(password);
  await writeNow();
  lock.clearFailures();
}

/** Go back to plaintext storage. */
export async function disableLock() {
  lock.disable();
  await writeNow();
}

/** Verify the old password, then re-key. */
export async function changeLock(oldPassword, newPassword) {
  const raw = readRaw();
  if (lock.isEnvelope(raw) && !await lock.verify(oldPassword, raw))
    throw new Error('The current password is not right.');
  await lock.enable(newPassword);
  await writeNow();
}

/** Drop the key from memory. The caller should reload immediately after. */
export async function lockNow() {
  await flush();
  lock.clearKey();
}

/* ---------- read / write ------------------------------------------------- */

export const get = () => state;

/**
 * The only supported way to change anything.
 * @param {(s:object)=>void} fn      mutator, receives live state
 * @param {object}  opt
 * @param {string}  opt.label        shown in the undo toast
 * @param {boolean} opt.silent       skip re-render
 * @param {boolean} opt.noUndo       skip the undo snapshot (use for bulk imports)
 */
export function mutate(fn, opt = {}) {
  if (!opt.noUndo) {
    undoRing.push(JSON.stringify(state));
    if (undoRing.length > UNDO_MAX) undoRing.shift();
    redoRing.length = 0;
  }
  fn(state);
  scheduleSave();
  if (!opt.silent) emit(opt.label || '');
  return state;
}

export function undo() {
  if (!undoRing.length) return false;
  redoRing.push(JSON.stringify(state));
  state = JSON.parse(undoRing.pop());
  scheduleSave(); emit('undo');
  return true;
}
export function redo() {
  if (!redoRing.length) return false;
  undoRing.push(JSON.stringify(state));
  state = JSON.parse(redoRing.pop());
  scheduleSave(); emit('redo');
  return true;
}
export const canUndo = () => undoRing.length > 0;

/* ---------- subscriptions ------------------------------------------------ */

export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
function emit(label) { for (const f of subs) { try { f(state, label); } catch (e) { console.error(e); } } }
export const notify = emit;

/* ---------- collection helpers ------------------------------------------- */

export const byId = (list, id) => (list || []).find(x => x.id === id) || null;

export function add(listName, item, opt = {}) {
  const rec = { id: uid(listName.slice(0, 3)), created: Date.now(), ...item };
  mutate(s => { (s[listName] ||= []).push(rec); }, { label: 'add ' + listName, ...opt });
  return rec;
}
export function update(listName, id, patch, opt = {}) {
  mutate(s => {
    const r = byId(s[listName], id);
    if (r) Object.assign(r, patch, { updated: Date.now() });
  }, { label: 'edit ' + listName, ...opt });
}
export function remove(listName, id, opt = {}) {
  mutate(s => { s[listName] = (s[listName] || []).filter(x => x.id !== id); },
         { label: 'delete ' + listName, ...opt });
}

/* ---------- export / import ---------------------------------------------- */

export function exportJson() {
  flush();
  return JSON.stringify({ app: 'GFX Prod App', schema: SCHEMA, exported: new Date().toISOString(), state }, null, 2);
}

export function importJson(text, { merge = false } = {}) {
  const parsed = JSON.parse(text);
  const incoming = parsed.state || parsed;
  if (!incoming || typeof incoming !== 'object') throw new Error('Not a GFX Prod App backup.');
  mutate(s => {
    if (!merge) { Object.keys(s).forEach(k => delete s[k]); Object.assign(s, migrate(incoming)); return; }
    // Merge: add rows whose id is not already present, leave everything else alone.
    for (const list of ['projects', 'people', 'tasks', 'objectives', 'budgetLines', 'leave', 'holidays', 'notes']) {
      if (!Array.isArray(incoming[list])) continue;
      const have = new Set((s[list] || []).map(x => x.id));
      s[list] = (s[list] || []).concat(incoming[list].filter(x => !have.has(x.id)));
    }
  }, { label: 'import' });
  return true;
}

export function resetToSeed() {
  mutate(s => { Object.keys(s).forEach(k => delete s[k]); Object.assign(s, seed()); }, { label: 'reset' });
}

export function wipe() {
  mutate(s => {
    Object.keys(s).forEach(k => delete s[k]);
    const base = seed();
    Object.assign(s, base);
    // keep the shape, drop the sample content
    base.projects.length = 0;
    s.projects = []; s.people = []; s.tasks = []; s.objectives = [];
    s.budgetLines = []; s.leave = []; s.notes = []; s.oneToOnes = [];
    s.meta.seeded = false;
  }, { label: 'clear all data' });
}

/* ---------- derived ------------------------------------------------------ */

export const activeProjects = () => get().projects.filter(p => p.status !== 'archived');
export const activePeople   = () => get().people.filter(p => p.active !== false);

export function projectName(id) {
  const p = byId(get().projects, id);
  return p ? p.name : (id ? '—' : 'Unassigned');
}
export function personName(id) {
  const p = byId(get().people, id);
  return p ? p.name : (id ? '—' : 'Unassigned');
}
export function divisionOf(name) {
  return get().divisions.find(d => d.id === name || d.name === name) || null;
}
export function divColor(id) {
  const d = divisionOf(id);
  return d ? d.color : 'var(--muted)';
}
