/* ============================================================================
   graph.js — Microsoft Graph: SharePoint, OneDrive, profile, free/busy.

   Optional by design. With no client ID configured the app runs entirely on
   local data and every Graph-backed view says so plainly rather than erroring.

   Auth model: MSAL Browser, cacheLocation 'localStorage'. The interactive
   sign-in happens in a popup served from this same origin (auth-start.html →
   auth-end.html), which is the pattern Teams supports on desktop, web and
   mobile. Because the popup shares our origin it shares the MSAL cache, so
   the main frame can then acquire tokens silently.
   ========================================================================= */

import { teams, authPopup } from './teams.js';

const MSAL_SOURCES = [
  'https://alcdn.msauth.net/browser/2.38.3/js/msal-browser.min.js',
  'https://cdn.jsdelivr.net/npm/@azure/msal-browser@2.38.3/lib/msal-browser.min.js',
];

export const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * Capabilities, smallest first. Asking for everything up front is the quickest
 * way to have a corporate tenant refuse the lot, so each is separately
 * switchable and the default is the minimum that makes the backup work.
 *
 * `ownFiles` (Files.ReadWrite) reaches only the signed-in user's own OneDrive
 * and is the one permission the automatic backup needs. `allFiles` and `sites`
 * are what the Files view needs to browse shared and team content, and are the
 * ones an administrator is most likely to want a conversation about.
 */
export const CAPABILITIES = [
  { id: 'ownFiles', scopes: ['Files.ReadWrite'],        label: 'My OneDrive',
    why: 'Automatic backup. The smallest permission that works — your own files only.' },
  { id: 'allFiles', scopes: ['Files.ReadWrite.All'],    label: 'Files shared with me',
    why: 'Browse and edit documents shared with you in the Files view.' },
  { id: 'sites',    scopes: ['Sites.ReadWrite.All'],    label: 'SharePoint sites',
    why: 'Browse and edit project team sites in the Files view.' },
  { id: 'people',   scopes: ['User.ReadBasic.All'],     label: 'Colleague lookup',
    why: 'Find people by name when adding them to the roster.' },
  { id: 'leave',    scopes: ['Calendars.Read.Shared'],  label: 'Out-of-office',
    why: 'Read OOF blocks from Outlook for the leave schedule.' },
];

export const DEFAULT_CAPS = { ownFiles: true, allFiles: false, sites: false, people: false, leave: false };

export const SCOPE_SETS = { base: ['User.Read'] };

/** The scope list implied by the enabled capabilities. */
export function allScopes(cfg = {}) {
  const caps = cfg.caps || DEFAULT_CAPS;
  const out = [...SCOPE_SETS.base];
  for (const c of CAPABILITIES) if (caps[c.id]) out.push(...c.scopes);
  return [...new Set(out)];
}

export const graph = {
  ready: false,
  connected: false,
  account: null,
  me: null,
  lastError: null,
  config: null,
};

let msal = null;
let loading = null;

/* ---------- bootstrap ---------------------------------------------------- */

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.crossOrigin = 'anonymous';
    s.onload = res; s.onerror = () => rej(new Error('load failed: ' + src));
    document.head.appendChild(s);
  });
}

async function ensureMsalLib() {
  if (window.msal?.PublicClientApplication) return;
  if (!loading) {
    loading = (async () => {
      let last;
      for (const src of MSAL_SOURCES) {
        try { await loadScript(src); if (window.msal) return; } catch (e) { last = e; }
      }
      throw new Error('Could not load the Microsoft sign-in library. ' +
        'Check your network, or that this page is served over HTTPS. (' + (last?.message || '') + ')');
    })();
  }
  return loading;
}

/**
 * Prepare MSAL from the saved settings. Safe to call repeatedly.
 * @param {{clientId:string, tenantId:string}} cfg
 */
export async function initGraph(cfg) {
  graph.config = cfg;
  if (!cfg?.clientId) { graph.ready = false; return graph; }
  await ensureMsalLib();
  if (!msal || msal.__clientId !== cfg.clientId || msal.__tenant !== cfg.tenantId) {
    msal = new window.msal.PublicClientApplication({
      auth: {
        clientId: cfg.clientId,
        authority: `https://login.microsoftonline.com/${cfg.tenantId || 'common'}`,
        redirectUri: new URL('auth-end.html', location.href).href,
        navigateToLoginRequestUrl: false,
      },
      cache: { cacheLocation: 'localStorage', storeAuthStateInCookie: false },
      system: { loggerOptions: { loggerCallback: () => {} } },
    });
    msal.__clientId = cfg.clientId; msal.__tenant = cfg.tenantId;
    await msal.initialize?.();
  }
  graph.ready = true;
  pickAccount();
  return graph;
}

function pickAccount() {
  const accts = msal?.getAllAccounts?.() || [];
  const want = (teams.user?.upn || '').toLowerCase();
  graph.account = accts.find(a => a.username?.toLowerCase() === want) || accts[0] || null;
  graph.connected = !!graph.account;
  if (graph.account) msal.setActiveAccount(graph.account);
  return graph.account;
}

/* ---------- tokens ------------------------------------------------------- */

/** Silent first; if that is not possible, run the popup and try again. */
export async function token(scopes, { interactive = true } = {}) {
  if (!graph.ready) throw new Error('Microsoft 365 is not configured. Settings → Microsoft 365.');
  const req = { scopes, account: graph.account || undefined };
  if (graph.account) {
    try { return (await msal.acquireTokenSilent(req)).accessToken; }
    catch (e) { if (!interactive) throw e; }
  }
  if (!interactive) throw new Error('Not signed in.');
  await runPopup(scopes);
  pickAccount();
  if (!graph.account) throw new Error('Sign-in did not complete.');
  return (await msal.acquireTokenSilent({ scopes, account: graph.account })).accessToken;
}

async function runPopup(scopes) {
  const url = new URL('auth-start.html', location.href);
  url.searchParams.set('clientId', graph.config.clientId);
  url.searchParams.set('tenantId', graph.config.tenantId || 'common');
  url.searchParams.set('scopes', scopes.join(' '));
  if (teams.user?.upn) url.searchParams.set('login_hint', teams.user.upn);
  const res = await authPopup(url.href);
  if (res && String(res).startsWith('error:')) throw new Error(String(res).slice(6));
}

/** Full interactive connect used by the Settings button. */
export async function connect(cfg) {
  await initGraph(cfg);
  await token(allScopes(cfg), { interactive: true });
  graph.me = await g('/me?$select=id,displayName,mail,userPrincipalName,jobTitle,officeLocation,preferredLanguage');
  graph.lastError = null;
  return graph.me;
}

export async function disconnect() {
  try { if (graph.account) await msal.logoutPopup({ account: graph.account, postLogoutRedirectUri: location.href }); }
  catch { /* the local cache clear below is what matters */ }
  try { msal?.clearCache?.(); } catch {}
  graph.account = null; graph.connected = false; graph.me = null;
}

/* ---------- request ------------------------------------------------------ */

let currentScopes = null;
const setScopes = s => { currentScopes = s; };
export { setScopes };

/**
 * Call Graph. `path` is relative to /v1.0 or an absolute @odata.nextLink.
 * Returns parsed JSON, or the Response when `raw` is set.
 */
export async function g(path, opt = {}) {
  const scopes = opt.scopes || currentScopes || allScopes(graph.config || {});
  const t = await token(scopes, { interactive: opt.interactive !== false });
  const url = path.startsWith('http') ? path : GRAPH + path;
  const headers = { Authorization: 'Bearer ' + t, ...(opt.headers || {}) };
  let body = opt.body;
  if (body && typeof body === 'object' && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
    headers['Content-Type'] ||= 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(url, { method: opt.method || 'GET', headers, body });

  if (res.status === 429 || res.status === 503) {
    const wait = (+res.headers.get('Retry-After') || 3) * 1000;
    if (!opt.__retried) { await new Promise(r => setTimeout(r, wait)); return g(path, { ...opt, __retried: true }); }
  }
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j.error?.message || ''; } catch { detail = await res.text().catch(() => ''); }
    const err = new Error(`${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}`);
    err.status = res.status; graph.lastError = err;
    throw err;
  }
  if (opt.raw) return res;
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

/** follow @odata.nextLink until `cap` items are collected */
export async function gAll(path, cap = 400, opt = {}) {
  let out = [], next = path;
  while (next && out.length < cap) {
    const page = await g(next, opt);
    out = out.concat(page.value || []);
    next = page['@odata.nextLink'];
  }
  return out;
}

/* ---------- profile ------------------------------------------------------ */

export const getMe = () => g('/me?$select=id,displayName,mail,userPrincipalName,jobTitle,officeLocation');

export async function getPhotoUrl(userId = 'me') {
  try {
    const res = await g(`/${userId === 'me' ? 'me' : 'users/' + userId}/photo/$value`, { raw: true });
    return URL.createObjectURL(await res.blob());
  } catch { return null; }
}

export const searchPeople = q =>
  gAll(`/users?$search="displayName:${encodeURIComponent(q)}"&$select=id,displayName,mail,jobTitle,department&$top=25`,
       25, { headers: { ConsistencyLevel: 'eventual' } });

/* ---------- SharePoint & OneDrive ---------------------------------------- */

export const myDrive       = () => g('/me/drive?$select=id,name,driveType,webUrl,quota');
export const followedSites = () => gAll('/me/followedSites?$select=id,name,displayName,webUrl', 60);
export const searchSites   = q  => gAll(`/sites?search=${encodeURIComponent(q || '*')}&$select=id,name,displayName,webUrl`, 60);
export const siteDrives    = id => gAll(`/sites/${id}/drives?$select=id,name,webUrl,driveType`, 40);

/** Turn a pasted SharePoint URL into a site id Graph will accept. */
export async function siteFromUrl(url) {
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  const i = parts.findIndex(p => p === 'sites' || p === 'teams');
  const rel = i >= 0 ? `/${parts[i]}/${parts[i + 1]}` : '';
  return g(`/sites/${u.hostname}:${rel}?$select=id,name,displayName,webUrl`);
}

const SEL = '$select=id,name,size,folder,file,webUrl,lastModifiedDateTime,lastModifiedBy,createdDateTime,parentReference,@microsoft.graph.downloadUrl';

export const listChildren = (driveId, itemId = 'root') =>
  gAll(`/drives/${driveId}/items/${itemId}/children?${SEL}&$top=200&$orderby=folder desc,name`, 400);

export const getItem = (driveId, itemId) => g(`/drives/${driveId}/items/${itemId}?${SEL}`);

export const searchDrive = (driveId, q) =>
  gAll(`/drives/${driveId}/root/search(q='${encodeURIComponent(q)}')?${SEL}&$top=60`, 120);

export async function getText(driveId, itemId) {
  const res = await g(`/drives/${driveId}/items/${itemId}/content`, { raw: true });
  return res.text();
}
export async function getBlobUrl(driveId, itemId) {
  const res = await g(`/drives/${driveId}/items/${itemId}/content`, { raw: true });
  return URL.createObjectURL(await res.blob());
}

/** Direct write-back. This overwrites the file and creates a new version in SharePoint. */
export const putText = (driveId, itemId, text, mime = 'text/plain') =>
  g(`/drives/${driveId}/items/${itemId}/content`, {
    method: 'PUT', body: new Blob([text], { type: mime }), headers: { 'Content-Type': mime },
  });

export const uploadToFolder = (driveId, parentId, name, blobOrText, mime = 'application/octet-stream') =>
  g(`/drives/${driveId}/items/${parentId}:/${encodeURIComponent(name)}:/content`, {
    method: 'PUT',
    body: blobOrText instanceof Blob ? blobOrText : new Blob([blobOrText], { type: mime }),
    headers: { 'Content-Type': mime },
  });

export const createFolder = (driveId, parentId, name) =>
  g(`/drives/${driveId}/items/${parentId}/children`, {
    method: 'POST', body: { name, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' },
  });

export const renameItem = (driveId, itemId, name) =>
  g(`/drives/${driveId}/items/${itemId}`, { method: 'PATCH', body: { name } });

/** Goes to the SharePoint recycle bin, not a hard delete. */
export const deleteItem = (driveId, itemId) =>
  g(`/drives/${driveId}/items/${itemId}`, { method: 'DELETE' });

/** Embeddable preview. allowEdit gives an Office-for-the-web editing surface. */
export const previewLink = (driveId, itemId, { allowEdit = false, page } = {}) =>
  g(`/drives/${driveId}/items/${itemId}/preview`, {
    method: 'POST', body: { allowEdit, ...(page ? { page: String(page) } : {}) },
  });

export const versions = (driveId, itemId) =>
  gAll(`/drives/${driveId}/items/${itemId}/versions?$top=20`, 20);

export const recentFiles = () => gAll(`/me/drive/recent?$top=40`, 40);

/* ---------- path-addressed helpers (used by cloud backup) ---------------- */

const encPath = p => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');

/** Fetch an item by its path under the signed-in user's OneDrive root. */
export async function itemByPath(path) {
  try { return await g(`/me/drive/root:/${encPath(path)}?${SEL}`); }
  catch (e) { if (e.status === 404) return null; throw e; }
}

/**
 * Create every missing folder along a path and return the leaf.
 * A simple upload to a path does not create intermediate folders, so this
 * walks them explicitly rather than relying on behaviour that varies.
 */
export async function ensureFolderPath(path) {
  const parts = path.split('/').filter(Boolean);
  let parentId = 'root', sofar = '';
  for (const part of parts) {
    sofar += (sofar ? '/' : '') + part;
    let item = await itemByPath(sofar);
    if (!item) item = await createFolderInMyDrive(parentId, part).catch(async e => {
      // a racing tab may have created it a moment ago
      const again = await itemByPath(sofar);
      if (again) return again;
      throw e;
    });
    if (!item.folder) throw new Error(`"${sofar}" exists but is a file, not a folder.`);
    parentId = item.id;
  }
  return parentId;
}

/** createFolder for the user's own drive takes 'me' as the drive id. */
export const createFolderInMyDrive = (parentId, name) =>
  g(`/me/drive/items/${parentId}/children`, {
    method: 'POST', body: { name, folder: {}, '@microsoft.graph.conflictBehavior': 'replace' },
  });

/** Write (or overwrite) a text file at a path under OneDrive root. */
export const uploadTextByPath = (path, text, mime = 'application/json') =>
  g(`/me/drive/root:/${encPath(path)}:/content`, {
    method: 'PUT', body: new Blob([text], { type: mime }), headers: { 'Content-Type': mime },
  });

export const listFolderByPath = async path => {
  try { return await gAll(`/me/drive/root:/${encPath(path)}:/children?${SEL}&$top=200`, 400); }
  catch (e) { if (e.status === 404) return []; throw e; }
};

export async function getTextByItem(item) {
  const res = await g(`/me/drive/items/${item.id}/content`, { raw: true });
  return res.text();
}

export const deleteFromMyDrive = itemId => g(`/me/drive/items/${itemId}`, { method: 'DELETE' });

/* ---------- calendar / out-of-office ------------------------------------- */

/**
 * Free/busy for a list of mailboxes. `oof` slots are what we treat as leave.
 * Requires Calendars.Read.Shared — in most tenants that is admin-consented.
 */
export async function getSchedule(emails, startISO, endISO, tz = 'UTC') {
  if (!emails.length) return [];
  const out = [];
  for (let i = 0; i < emails.length; i += 20) {
    const chunk = emails.slice(i, i + 20);
    const r = await g('/me/calendar/getSchedule', {
      method: 'POST',
      scopes: [...SCOPE_SETS.base, 'Calendars.Read.Shared'],
      body: {
        schedules: chunk,
        startTime: { dateTime: startISO + 'T00:00:00', timeZone: tz },
        endTime:   { dateTime: endISO   + 'T23:59:00', timeZone: tz },
        availabilityViewInterval: 60,
      },
    });
    out.push(...(r.value || []));
  }
  return out;
}

/* ---------- helpers ------------------------------------------------------ */

export const TEXTUAL = /\.(txt|md|markdown|csv|tsv|json|xml|yml|yaml|log|ini|cfg|html|htm|css|js|ts|py|ps1|bat|sh|sql|srt)$/i;
export const OFFICE  = /\.(docx?|xlsx?|pptx?|vsdx?|one)$/i;
export const IMAGE   = /\.(png|jpe?g|gif|webp|bmp|svg|tga)$/i;
export const PDF     = /\.pdf$/i;

export function fileKind(name = '') {
  if (TEXTUAL.test(name)) return 'text';
  if (OFFICE.test(name))  return 'office';
  if (IMAGE.test(name))   return 'image';
  if (PDF.test(name))     return 'pdf';
  return 'other';
}
export const mimeFor = name =>
  /\.md$/i.test(name)   ? 'text/markdown' :
  /\.csv$/i.test(name)  ? 'text/csv' :
  /\.json$/i.test(name) ? 'application/json' :
  /\.html?$/i.test(name)? 'text/html' : 'text/plain';

export function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
