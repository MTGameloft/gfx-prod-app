/* ============================================================================
   bridge.js — talk to the local helper (tools/gfx-bridge.ps1).

   WHY THIS EXISTS
   ---------------
   The built-in folder backup uses the File System Access API, which Chromium
   blocks inside a cross-origin iframe. A Teams tab is exactly that, so inside
   Teams the app cannot reach the disk at all.

   A fetch to 127.0.0.1 has no such restriction: loopback counts as a
   potentially-trustworthy origin, so an HTTPS page may call it without
   tripping mixed-content blocking. So the bridge gets us automatic local
   backup from inside Teams, which is the one place it matters most.

   The bridge requires a token for every write. Without one, any web page you
   visited could POST files onto your disk — so there is no token-free mode.
   ========================================================================= */

import * as S from './store.js';
import { buildPayload, openPayload, peek } from './backupformat.js';

const DEBOUNCE_MS = 25_000;
const MIN_GAP_MS  = 40_000;

export const bridge = {
  status: 'off',        // off | probing | unreachable | unauthorised | idle | saving | error
  lastAt: 0,
  lastError: '',
  folder: '',
  files: [],
};

let timer = null, lastSent = 0, started = false;

const cfg = () => S.get().settings.bridge || {};
const base = () => (cfg().url || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const enabled = () => !!(cfg().enabled && cfg().url && cfg().token);

/* ---------- requests ----------------------------------------------------- */

async function call(path, { method = 'GET', body = null, timeout = 12_000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(base() + path, {
      method,
      headers: {
        // spell out the charset: without it a server may fall back to its
        // system codepage and mangle any non-ASCII name in the payload
        ...(body != null ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
        ...(cfg().token ? { 'X-GFX-Token': cfg().token } : {}),
      },
      body,
      signal: ctl.signal,
      // never send cookies to a local server
      credentials: 'omit',
      mode: 'cors',
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* /file returns raw */ }
    if (!res.ok) {
      const msg = json?.error || `${res.status} ${res.statusText}`;
      const err = new Error(msg); err.status = res.status; throw err;
    }
    return { json, text };
  } finally { clearTimeout(t); }
}

/**
 * Can this page reach a loopback server at all?
 *
 * MEASURED, NOT ASSUMED. An https page may not fetch an http URL — loopback
 * included. Chrome refuses before the request leaves the browser, so the
 * bridge never sees it and the failure looks like "not running". Verified:
 * from http://127.0.0.1:8800 the bridge answers; from
 * https://mtgameloft.github.io the same call dies with ERR_BLOCKED_BY_CLIENT.
 *
 * A Teams tab loads the https origin, so the bridge cannot help there. Saying
 * so up front beats letting someone debug a firewall for an hour.
 */
export const reachable = () => location.protocol !== 'https:';

export const unreachableReason = () =>
  location.protocol === 'https:'
    ? 'This page is served over HTTPS, and browsers refuse to let an HTTPS page ' +
      'call an http:// address — even 127.0.0.1. The bridge only works when the app ' +
      'itself is opened over http, i.e. from serve.ps1 at http://127.0.0.1:8800. ' +
      'In Teams, use "Backup to a folder" in Edge instead.'
    : '';

/** Is the bridge there at all? /ping needs no token. */
export async function probe() {
  if (!cfg().url) { bridge.status = 'off'; emit(); return false; }
  if (!reachable()) {
    bridge.status = 'blocked';
    bridge.lastError = unreachableReason();
    emit();
    return false;
  }
  bridge.status = 'probing'; emit();
  try {
    const { json } = await call('/ping', { timeout: 4000 });
    bridge.folder = json?.folder || '';
    bridge.lastError = '';
    bridge.status = cfg().token ? 'idle' : 'unauthorised';
    emit();
    return true;
  } catch (e) {
    bridge.status = 'unreachable';
    bridge.lastError = e.name === 'AbortError'
      ? 'No answer on that address. Is gfx-bridge.ps1 running?'
      : e.message;
    emit();
    return false;
  }
}

export async function backupNow({ manual = false } = {}) {
  if (!enabled()) return false;
  if (!reachable()) { bridge.status = 'blocked'; bridge.lastError = unreachableReason(); emit(); return false; }
  if (!manual && Date.now() - lastSent < MIN_GAP_MS) return false;

  bridge.status = 'saving'; emit();
  try {
    const payload = await buildPayload();
    const { json } = await call('/backup', { method: 'POST', body: payload, timeout: 20_000 });
    lastSent = Date.now();
    bridge.lastAt = lastSent;
    bridge.lastError = '';
    bridge.status = 'idle';
    S.mutate(s => { (s.settings.bridge ||= {}).lastAt = lastSent; }, { noUndo: true, silent: true });
    emit();
    return json;
  } catch (e) {
    bridge.status = e.status === 401 ? 'unauthorised' : 'error';
    bridge.lastError = e.status === 401 ? 'The bridge rejected the token. Re-copy it from the bridge window.' : e.message;
    emit();
    console.error('[GFX] bridge backup failed', e);
    return false;
  }
}

export async function list() {
  const { json } = await call('/list');
  bridge.files = json?.files || [];
  bridge.folder = json?.folder || bridge.folder;
  emit();
  return bridge.files;
}

export const fetchFile = async name =>
  (await call('/file?name=' + encodeURIComponent(name))).text;

/** Ask the helper to open SharePoint + Explorer, ready for one drag. */
export async function handoff() {
  const { json } = await call('/handoff', { method: 'POST', body: '{}' });
  return json;
}

export { openPayload, peek };

/* ---------- wiring ------------------------------------------------------- */

const listeners = new Set();
export const onBridgeChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach(f => { try { f(bridge); } catch (e) { console.error(e); } });

export function initBridge() {
  if (started) return;
  started = true;

  bridge.lastAt = cfg().lastAt || 0;
  if (!enabled()) { bridge.status = cfg().url ? 'off' : 'off'; emit(); return; }

  probe().then(ok => {
    if (!ok) return;
    // catch up if the last backup was a while ago
    if (Date.now() - bridge.lastAt > 6 * 3600_000) setTimeout(() => backupNow({ manual: true }), 3000);
  });

  S.subscribe(() => {
    if (!enabled()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; backupNow(); }, DEBOUNCE_MS);
  });

  // do not lose a pending backup to a closed tab
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && timer) { clearTimeout(timer); timer = null; backupNow({ manual: true }); }
  });
}

export const bridgeStatusText = () => ({
  off:          'Off',
  blocked:      'Blocked on HTTPS',
  probing:      'Looking for the bridge…',
  unreachable:  'Not running',
  unauthorised: 'Token rejected',
  saving:       'Saving…',
  error:        'Last attempt failed',
  idle:         bridge.lastAt ? 'Saved ' + ago(bridge.lastAt) : 'Connected, nothing sent yet',
}[bridge.status] || '');

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + ' min ago';
  if (s < 172800) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' days ago';
}
