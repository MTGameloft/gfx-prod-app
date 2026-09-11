/* ============================================================================
   localbackup.js — automatic backup into a folder you choose, with no Azure
   involvement whatsoever.

   THE IDEA
   --------
   Point this at your OneDrive *sync folder* — the one on your disk, e.g.
   `C:\Users\you\OneDrive - Gameloft\Apps\GFX Prod App`. The app writes the
   backup file there; the OneDrive client you already have uploads it and syncs
   it to your other machines. Same result as talking to the Graph API, using
   the client instead, and requiring no app registration and no administrator.

   HOW IT IS ALLOWED TO
   --------------------
   The File System Access API. You choose the folder in the operating system's
   own picker; the browser then hands the page a handle scoped to exactly that
   folder and nothing else. The handle is kept in IndexedDB so it survives a
   reload, but the *permission* usually does not survive a browser restart —
   hence `needsReconnect`, which is one click, not a re-pick.

   WHERE IT DOES NOT WORK
   ----------------------
   Chromium gates this API behind Permissions Policy inside cross-origin
   iframes, and a Teams tab is exactly that. So this is expected to be
   unavailable in the Teams client and available when the same URL is opened
   directly in Edge or Chrome. `capability()` reports which, rather than
   letting it fail mysteriously.
   ========================================================================= */

import * as S from './store.js';
import { buildPayload, openPayload, peek, LATEST, DAILY_RE, dailyName } from './backupformat.js';

const DB = 'gfxprod.fs';
const STORE = 'handles';
const KEY = 'backupDir';
const DEBOUNCE_MS = 20_000;
const MIN_GAP_MS  = 30_000;

export const local = {
  status: 'unsupported',   // unsupported | off | no-folder | needs-reconnect | idle | saving | error
  folderName: '',
  lastAt: 0,
  lastError: '',
  remote: null,            // wrapper of the newest file in the folder
  remoteNewer: false,
};

let dirHandle = null;
let timer = null;
let lastWrite = 0;
let started = false;

/* ---------- capability -------------------------------------------------- */

export function capability() {
  if (!window.isSecureContext)
    return { ok: false, why: 'The page must be served over HTTPS for this to be allowed.' };
  if (typeof window.showDirectoryPicker !== 'function')
    return { ok: false, why: 'This browser does not support choosing a folder. Edge or Chrome do; Firefox and Safari do not.' };
  if (window.top !== window.self)
    return {
      ok: false, inIframe: true,
      why: 'Browsers block folder access inside an embedded tab, which is what a Teams tab is. ' +
           'Open the app directly in Edge to set this up — the backup folder is shared, so doing it ' +
           'there covers the data you enter in Teams only if you also work there. See the note below.',
    };
  return { ok: true, why: '' };
}

/* ---------- handle persistence ------------------------------------------ */

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(key, val) {
  const db = await idb();
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  db.close();
}
async function idbGet(key) {
  const db = await idb();
  const val = await new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const q = tx.objectStore(STORE).get(key);
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
  db.close();
  return val;
}
async function idbDel(key) {
  const db = await idb();
  await new Promise(res => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = res; tx.onerror = res;
  });
  db.close();
}

/* ---------- permission -------------------------------------------------- */

async function permissionState(handle) {
  if (!handle?.queryPermission) return 'granted';
  try { return await handle.queryPermission({ mode: 'readwrite' }); }
  catch { return 'prompt'; }
}

/** Needs a user gesture — wire it to a button, never call it on load. */
export async function reconnect() {
  if (!dirHandle) return false;
  try {
    const p = await dirHandle.requestPermission({ mode: 'readwrite' });
    if (p !== 'granted') { local.status = 'needs-reconnect'; emit(); return false; }
    local.status = 'idle'; local.lastError = ''; emit();
    await checkFolder();
    return true;
  } catch (e) { local.lastError = e.message; emit(); return false; }
}

/* ---------- choosing the folder ----------------------------------------- */

/** Needs a user gesture. Opens the OS folder picker. */
export async function chooseFolder() {
  const cap = capability();
  if (!cap.ok) throw new Error(cap.why);
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'gfxprod-backup' });
  dirHandle = handle;
  await idbPut(KEY, handle);
  local.folderName = handle.name;
  local.status = 'idle';
  local.lastError = '';
  S.mutate(s => { (s.settings.localBackup ||= {}).enabled = true; (s.settings.localBackup).folderName = handle.name; },
           { label: 'backup folder' });
  emit();
  await backupNow({ manual: true });
  return handle.name;
}

export async function forgetFolder() {
  dirHandle = null;
  await idbDel(KEY);
  local.folderName = ''; local.status = 'no-folder'; local.remote = null; local.remoteNewer = false;
  S.mutate(s => { (s.settings.localBackup ||= {}).enabled = false; s.settings.localBackup.folderName = ''; },
           { label: 'backup folder' });
  emit();
}

/* ---------- writing ----------------------------------------------------- */

const cfg = () => S.get().settings.localBackup || {};
const ready = () => !!dirHandle && cfg().enabled && local.status !== 'needs-reconnect';

async function writeFile(name, text) {
  const fh = await dirHandle.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

export async function backupNow({ manual = false } = {}) {
  if (!dirHandle || !cfg().enabled) return false;
  if (!manual && Date.now() - lastWrite < MIN_GAP_MS) return false;

  if (await permissionState(dirHandle) !== 'granted') {
    local.status = 'needs-reconnect'; emit(); return false;
  }

  local.status = 'saving'; emit();
  try {
    const text = await buildPayload();
    await writeFile(LATEST, text);

    // one dated snapshot per day
    const daily = dailyName();
    let exists = true;
    try { await dirHandle.getFileHandle(daily); } catch { exists = false; }
    if (!exists) { await writeFile(daily, text); await prune(); }

    lastWrite = Date.now();
    local.lastAt = lastWrite;
    local.lastError = '';
    local.status = 'idle';
    local.remoteNewer = false;
    S.mutate(s => { (s.settings.localBackup ||= {}).lastAt = lastWrite; }, { noUndo: true, silent: true });
    emit();
    return true;
  } catch (e) {
    local.status = 'error'; local.lastError = e.message; emit();
    console.error('[GFX] folder backup failed', e);
    return false;
  }
}

async function prune() {
  const keep = cfg().keep ?? 30;
  if (!keep) return;
  const names = [];
  for await (const [name, h] of dirHandle.entries()) if (h.kind === 'file' && DAILY_RE.test(name)) names.push(name);
  names.sort().reverse();
  for (const old of names.slice(keep)) {
    try { await dirHandle.removeEntry(old); } catch { /* not worth failing a backup over */ }
  }
}

/* ---------- reading ----------------------------------------------------- */

export async function listBackups() {
  if (!dirHandle) throw new Error('No backup folder chosen.');
  if (await permissionState(dirHandle) !== 'granted') throw new Error('Permission to that folder has lapsed — reconnect it first.');
  const out = [];
  for await (const [name, h] of dirHandle.entries()) {
    if (h.kind !== 'file' || !/\.json$/i.test(name)) continue;
    const f = await h.getFile();
    out.push({ name, size: f.size, lastModified: f.lastModified, handle: h });
  }
  return out.sort((a, b) => b.lastModified - a.lastModified);
}

export const readBackup = item => item.handle.getFile().then(f => f.text());
export { openPayload };

/** Is the newest file in the folder newer than what this browser holds? */
export async function checkFolder() {
  if (!ready()) return null;
  try {
    let fh;
    try { fh = await dirHandle.getFileHandle(LATEST); } catch { local.remote = null; local.remoteNewer = false; return null; }
    const text = await (await fh.getFile()).text();
    const w = peek(text);
    if (!w) return null;
    local.remote = w;
    const localAt = S.get().meta.updated || 0;
    const remoteAt = Date.parse(w.savedAt || 0) || 0;
    const { deviceLabel } = await import('./backupformat.js');
    local.remoteNewer = remoteAt > localAt + 90_000 && w.device !== deviceLabel();
    emit();
    return w;
  } catch (e) { local.lastError = e.message; emit(); return null; }
}

/* ---------- wiring ------------------------------------------------------ */

const listeners = new Set();
export const onLocalChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach(f => { try { f(local); } catch (e) { console.error(e); } });

export async function initLocal() {
  if (started) return;
  started = true;

  const cap = capability();
  if (!cap.ok) { local.status = 'unsupported'; local.lastError = cap.why; emit(); return; }

  local.lastAt = cfg().lastAt || 0;
  try { dirHandle = await idbGet(KEY); } catch { dirHandle = null; }

  if (!dirHandle) { local.status = 'no-folder'; emit(); return; }
  local.folderName = dirHandle.name;

  const p = await permissionState(dirHandle);
  local.status = !cfg().enabled ? 'off' : p === 'granted' ? 'idle' : 'needs-reconnect';
  emit();

  S.subscribe(() => {
    if (!ready()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; backupNow(); }, DEBOUNCE_MS);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && timer) { clearTimeout(timer); timer = null; backupNow({ manual: true }); }
  });

  if (local.status === 'idle') checkFolder();
}

export const localStatusText = () => ({
  unsupported:       'Not available in this window',
  off:               'Off',
  'no-folder':       'No folder chosen',
  'needs-reconnect': 'Reconnect the folder',
  saving:            'Saving…',
  error:             'Last attempt failed',
  idle:              local.lastAt ? 'Saved ' + ago(local.lastAt) : 'On, nothing written yet',
}[local.status] || '');

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + ' min ago';
  if (s < 172800) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' days ago';
}
