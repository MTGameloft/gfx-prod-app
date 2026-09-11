/* ============================================================================
   cloudbackup.js — automatic backup to your own OneDrive.

   THE SHAPE OF IT
   ---------------
   Two kinds of file in one folder:

     gfx-latest.json              overwritten on every change. OneDrive keeps
                                  its own version history, so fine-grained
                                  history comes free without us making a mess.
     gfx-daily-YYYY-MM-DD.json    one per day, first change of that day.
                                  Older ones are pruned to a retention limit.

   WHY IT NEVER RESTORES BY ITSELF
   -------------------------------
   Silent two-way sync is how people lose an afternoon's work: edit on the
   laptop, open the desktop, and the older copy wins. So this writes
   automatically and reads only when you ask. On startup it will *tell* you a
   newer backup exists and offer to pull it — that is a banner, not an action.

   ENCRYPTION
   ----------
   If password protection is on, the payload is sealed with the same key before
   it leaves the machine. It would be incoherent to encrypt local storage and
   then ship the same data to the cloud in the clear. The wrapper stays
   readable so the "newer backup exists" check works without a password.
   ========================================================================= */

import * as S from './store.js';
import * as G from './graph.js';
import { graph } from './graph.js';
import {
  buildPayload, openPayload, peek, deviceLabel, LATEST, DAILY_RE, dailyName,
} from './backupformat.js';

// re-exported so views can import either destination from one place
export { openPayload, deviceLabel };

const DEBOUNCE_MS = 45_000;      // settle time after the last edit
const MIN_GAP_MS  = 60_000;      // never upload more often than this

export const cloud = {
  status: 'off',          // off | idle | saving | error | unconfigured
  lastAt: 0,
  lastError: '',
  remote: null,           // { savedAt, device, encrypted } from gfx-latest.json
  remoteNewer: false,
};

let timer = null;
let lastUpload = 0;
let started = false;

/* ---------- config ------------------------------------------------------- */

const cfg = () => S.get().settings.cloud || {};
const folder = () => (cfg().folder || 'Apps/GFX Prod App').replace(/^\/+|\/+$/g, '');

/* ---------- the write path ---------------------------------------------- */

const ready = () => graph.connected && cfg().enabled && !!S.get().settings.graph.clientId;

export async function backupNow({ manual = false } = {}) {
  if (!ready()) { cloud.status = graph.connected ? 'off' : 'unconfigured'; return false; }
  if (!manual && Date.now() - lastUpload < MIN_GAP_MS) return false;

  cloud.status = 'saving';
  emit();
  try {
    await G.ensureFolderPath(folder());
    const text = await buildPayload();

    await G.uploadTextByPath(`${folder()}/${LATEST}`, text);

    // one dated snapshot per day

    const daily = dailyName();
    const existing = await G.itemByPath(`${folder()}/${daily}`);
    if (!existing) {
      await G.uploadTextByPath(`${folder()}/${daily}`, text);
      await prune();
    }

    lastUpload = Date.now();
    cloud.lastAt = lastUpload;
    cloud.lastError = '';
    cloud.status = 'idle';
    cloud.remoteNewer = false;
    S.mutate(s => { s.settings.cloud.lastAt = lastUpload; }, { noUndo: true, silent: true });
    emit();
    return true;
  } catch (e) {
    cloud.status = 'error';
    cloud.lastError = e.message;
    emit();
    console.error('[GFX] cloud backup failed', e);
    return false;
  }
}

/** Keep the newest N daily files, delete the rest. */
async function prune() {
  const keep = cfg().keep ?? 30;
  if (!keep) return;
  const items = await G.listFolderByPath(folder());
  const dailies = items
    .filter(i => DAILY_RE.test(i.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  for (const old of dailies.slice(keep)) {
    try { await G.deleteFromMyDrive(old.id); } catch { /* not worth failing the backup over */ }
  }
}

/* ---------- the read path ----------------------------------------------- */

export async function listBackups() {
  if (!graph.connected) throw new Error('Microsoft 365 is not connected.');
  const items = await G.listFolderByPath(folder());
  return items
    .filter(i => i.file && /\.json$/i.test(i.name))
    .sort((a, b) => String(b.lastModifiedDateTime).localeCompare(String(a.lastModifiedDateTime)));
}

export const fetchBackupText = item => G.getTextByItem(item);

/**
 * Read only the wrapper of gfx-latest.json, to answer "is there something
 * newer than what I have here?" without decrypting anything.
 */
export async function checkRemote() {
  if (!ready()) return null;
  try {
    const item = await G.itemByPath(`${folder()}/${LATEST}`);
    if (!item) { cloud.remote = null; cloud.remoteNewer = false; return null; }
    const text = await G.getTextByItem(item);
    const wrap = peek(text) || {};
    cloud.remote = {
      savedAt: wrap.savedAt, device: wrap.device, encrypted: !!wrap.encrypted,
      itemId: item.id, name: item.name, size: item.size,
    };
    const localAt = S.get().meta.updated || 0;
    const remoteAt = Date.parse(wrap.savedAt || 0) || 0;
    // 90s of slack so our own upload does not look "newer" than us
    cloud.remoteNewer = remoteAt > localAt + 90_000 && wrap.device !== deviceLabel();
    emit();
    return cloud.remote;
  } catch (e) {
    cloud.lastError = e.message;
    emit();
    return null;
  }
}

/* ---------- wiring ------------------------------------------------------ */

const listeners = new Set();
export const onCloudChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach(f => { try { f(cloud); } catch (e) { console.error(e); } });

/** Call once after Graph has had its chance to connect. */
export function initCloud() {
  if (started) return;
  started = true;

  cloud.lastAt = cfg().lastAt || 0;
  cloud.status = !S.get().settings.graph.clientId ? 'unconfigured'
               : !cfg().enabled ? 'off' : graph.connected ? 'idle' : 'off';

  S.subscribe(() => {
    if (!ready()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; backupNow(); }, DEBOUNCE_MS);
  });

  // a pending backup should not be lost to closing the tab
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && timer) { clearTimeout(timer); timer = null; backupNow({ manual: true }); }
  });

  if (ready()) {
    checkRemote();
    // catch up if the last backup was long ago
    if (Date.now() - cloud.lastAt > 12 * 3600_000) setTimeout(() => backupNow({ manual: true }), 4000);
  }
}

export const cloudStatusText = () => {
  switch (cloud.status) {
    case 'unconfigured': return 'Needs Microsoft 365';
    case 'off':    return 'Off';
    case 'saving': return 'Backing up…';
    case 'error':  return 'Last attempt failed';
    case 'idle':   return cloud.lastAt ? 'Backed up ' + ago(cloud.lastAt) : 'On, nothing sent yet';
    default:       return '';
  }
};

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + ' min ago';
  if (s < 172800) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' days ago';
}
