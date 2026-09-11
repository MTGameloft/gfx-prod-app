/* ============================================================================
   backupformat.js — the one definition of what a backup file looks like.

   Shared by both destinations (OneDrive via Graph, and a local folder via the
   File System Access API) so a backup written by one can always be restored
   by the other.

   The wrapper is deliberately plaintext even when the payload is encrypted:
   that is what lets "a newer backup exists on another machine" work without
   asking for a password first.

     {
       "__gfxbackup": 1,
       "savedAt":  "2026-09-07T12:00:00.000Z",
       "device":   "Windows · Teams",
       "encrypted": true,
       "payload":  "<the exportJson string, or an encryption envelope>"
     }
   ========================================================================= */

import * as S from './store.js';
import * as lock from './lock.js';
import { teams } from './teams.js';
import { download, today } from './ui.js';

/** A human label so you can tell which machine wrote a given backup. */
export function deviceLabel() {
  const set = S.get().settings.cloud?.device;
  if (set) return set;
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'macOS'
           : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : 'Unknown OS';
  // The Teams SDK script loads whether or not Teams is hosting us, so ask the
  // resolved context rather than the global.
  return `${os} · ${teams.inTeams ? 'Teams' : 'Browser'}`;
}

export async function buildPayload() {
  const inner = S.exportJson();                 // plaintext, pretty-printed
  const encrypted = S.isUnlocked();
  return JSON.stringify({
    __gfxbackup: 1,
    savedAt: new Date().toISOString(),
    device: deviceLabel(),
    encrypted,
    app: 'GFX Prod App',
    payload: encrypted ? await lock.seal(inner) : inner,
  });
}

/**
 * Turn a backup file's text back into the exportJson string.
 * `askPassword(why)` is called only when the file actually needs one, and must
 * resolve to a password or null to cancel.
 */
export async function openPayload(text, askPassword) {
  let wrap;
  try { wrap = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }

  // a plain export saved straight from Settings → Data
  if (!wrap.__gfxbackup) {
    if (lock.isEnvelope(text)) {
      const pw = await askPassword('This backup is encrypted.');
      if (!pw) return null;
      return lock.openWith(pw, text);
    }
    return text;
  }

  if (!wrap.encrypted) return wrap.payload;
  const pw = await askPassword(`Encrypted on ${wrap.device || 'another machine'}.`);
  if (!pw) return null;
  return lock.openWith(pw, wrap.payload);
}

/** Read just the wrapper — no password needed, no payload touched. */
export function peek(text) {
  try {
    const w = JSON.parse(text);
    if (!w.__gfxbackup) return null;
    return { savedAt: w.savedAt, device: w.device, encrypted: !!w.encrypted };
  } catch { return null; }
}

/* ---------- the download route ------------------------------------------- */

/**
 * Save a backup as a file download.
 *
 * This is the one route out of a Teams tab. Both filesystem routes are shut
 * there — the File System Access API is blocked in a cross-origin iframe, and
 * an HTTPS page cannot call a loopback server — but a download is driven by a
 * click rather than an API, so it is allowed.
 *
 * The filename is what tools/sweep-backups.ps1 looks for, so do not change
 * the prefix without changing the sweeper's -Pattern to match.
 */
export function saveBackupFile() {
  const name = `gfx-prod-app-backup-${today()}.json`;
  download(name, S.exportJson(), 'application/json');
  // NOT silent: subscribers are what refresh the header's overdue indicator.
  // With silent:true the dot stayed on after a successful save, which is the
  // one place a stale indicator actually misleads you.
  S.mutate(s => { s.settings.lastExportAt = Date.now(); }, { noUndo: true });
  return name;
}

export const lastExportAt = () => S.get().settings.lastExportAt || 0;

/** Older than a day and a half, with data worth losing. */
export function exportIsStale() {
  const s = S.get();
  const hasContent = s.tasks.length || s.people.length > 1 || s.notes.length;
  if (!hasContent) return false;
  const last = lastExportAt();
  return !last || (Date.now() - last) > 36 * 3600_000;
}

export const DAILY_RE = /^gfx-daily-(\d{4}-\d{2}-\d{2})\.json$/;
export const LATEST = 'gfx-latest.json';
export const dailyName = (d = new Date()) => `gfx-daily-${d.toISOString().slice(0, 10)}.json`;
