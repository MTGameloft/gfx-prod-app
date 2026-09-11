/* ============================================================================
   app.js — shell, routing, theming, keyboard, command palette.
   ========================================================================= */

import * as S from './store.js';
import { $, esc, icon, toast, dialog, initials, hashColor } from './ui.js';
import { initTeams, teams, onThemeChange } from './teams.js';
import { initGraph, graph } from './graph.js';
import * as lock from './lock.js';
import { initCloud, onCloudChange } from './cloudbackup.js';
import { initLocal, onLocalChange, reconnect as reconnectFolder } from './localbackup.js';
import { initBridge } from './bridge.js';
import { saveBackupFile, lastExportAt, exportIsStale } from './backupformat.js';
import { checkForUpdate, hardReload } from './version.js';

import dashboard  from './views/dashboard.js';
import tasks      from './views/tasks.js';
import objectives from './views/objectives.js';
import projects   from './views/projects.js';
import people     from './views/people.js';
import leave      from './views/leave.js';
import finance    from './views/finance.js';
import files      from './views/files.js';
import outsourcing from './views/outsourcing.js';
import datax      from './views/datax.js';
import notes      from './views/notes.js';
import settings   from './views/settings.js';
import jiraImports from './views/jiraimports.js';
import gfxwb      from './views/gfxwb.js';

/* ---------- registry ----------------------------------------------------- */

const VIEWS = [dashboard, tasks, objectives, projects, jiraImports, people, leave,
               finance, outsourcing, files, gfxwb, datax, notes, settings];
const byId = id => VIEWS.find(v => v.id === id) || dashboard;

const GROUPS = [
  { id: 'work',     label: 'Work' },
  // The only group whose contents are partly data rather than VIEWS: one entry
  // per project, plus the fixed Overview and Jira Imports — see projectItems().
  { id: 'projects', label: 'Project Management' },
  { id: 'people',   label: 'Team' },
  { id: 'money',    label: 'Financials' },
  { id: 'space',    label: 'Workspace' },
  { id: 'system',   label: '' },    // Settings — no header, never collapsible
];

/* ---------- boot --------------------------------------------------------- */

let current = null;
let cleanup = null;

(async function boot() {
  // The theme has to be guessed before the state exists, or the lock screen
  // flashes white in a dark Teams client.
  document.documentElement.dataset.theme =
    matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default';

  await S.load({ requestPassword: askPassword });
  applyPrefs();

  await initTeams();
  wireTheme();
  adoptTeamsIdentity();

  const cfg = S.get().settings.graph;
  if (cfg.clientId) {
    initGraph(cfg)
      .then(() => { if (cfg.autoConnect) return import('./graph.js').then(m => m.token(m.allScopes(cfg), { interactive: false })); })
      .then(() => { graph.connected && renderNav(); })
      .catch(() => { /* silent: the Files view explains how to connect */ })
      .finally(() => { initCloud(); watchForNewerBackup(); });
  } else {
    initCloud();
  }
  initLocal().then(watchForNewerFolderBackup);
  watchForNewerBuild();
  initBridge();

  renderNav();
  wireChrome();
  wireKeys();
  armAutoLock();

  S.subscribe(() => { renderNav(); refreshBadges(); });

  window.addEventListener('hashchange', route);
  route();

  dismissLockScreen();
  $('#shell').hidden = false;
  const sp = $('#splash');
  if (sp) { sp.classList.add('gone'); setTimeout(() => sp.remove(), 260); }

  if (S.get().meta.seeded && !localStorage.getItem('gfxprod.welcomed')) {
    localStorage.setItem('gfxprod.welcomed', '1');
    setTimeout(welcome, 500);
  }
})();

/* ---------- the lock screen ---------------------------------------------- */

/**
 * Shown before any state exists, so it can use nothing from it. Resolves with
 * whatever the user typed; the store decides whether it worked and calls again
 * if it did not.
 */
function askPassword(attempt, lastError) {
  return new Promise(resolve => {
    const splash = $('#splash');
    if (splash) splash.remove();

    let el = $('#lockscreen');
    if (!el) {
      el = document.createElement('div');
      el.id = 'lockscreen';
      el.innerHTML = `
        <form class="lock-card" autocomplete="off">
          <div class="brand-mark" style="width:44px;height:44px;font-size:15px;border-radius:11px;margin:0 auto 14px">GFX</div>
          <h1 style="font-size:17px;text-align:center;margin-bottom:4px">GFX Prod App</h1>
          <p class="tiny mute" style="text-align:center;margin-bottom:18px">This console is password-protected.</p>
          <label class="fld">
            <span>Password</span>
            <input type="password" id="lkpw" autocomplete="current-password" autofocus>
          </label>
          <div id="lkerr" class="tiny" style="color:var(--risk);min-height:17px;margin-bottom:8px"></div>
          <button class="btn primary" type="submit" id="lkgo" style="width:100%">Unlock</button>
          <details style="margin-top:18px">
            <summary class="tiny mute" style="cursor:pointer">Forgotten the password?</summary>
            <p class="tiny mute" style="margin-top:8px;line-height:1.6">
              Then the data cannot be recovered — not by you, not by me, not by anyone.
              The key is derived from the password and is never stored, which is the
              whole reason the protection is worth anything.
              <br><br>
              If you have an exported backup, the only route is to clear this browser's
              stored data and restore from that file.
            </p>
            <button type="button" class="btn danger sm" id="lkwipe" style="width:100%">Erase the stored data and start fresh</button>
          </details>
        </form>`;
      document.body.appendChild(el);
    }

    const pw   = el.querySelector('#lkpw');
    const err  = el.querySelector('#lkerr');
    const go   = el.querySelector('#lkgo');
    const form = el.querySelector('form');

    err.textContent = lastError || '';
    pw.value = '';
    pw.disabled = false; go.disabled = false;
    setTimeout(() => pw.focus(), 30);

    // escalating delay after repeated failures — soft, but it stops a person
    const waitMs = lock.lockedOutFor();
    if (waitMs > 0) {
      pw.disabled = true; go.disabled = true;
      let left = Math.ceil(waitMs / 1000);
      err.textContent = `Too many attempts. Wait ${left}s.`;
      const tick = setInterval(() => {
        left--;
        if (left > 0) { err.textContent = `Too many attempts. Wait ${left}s.`; return; }
        clearInterval(tick);
        err.textContent = ''; pw.disabled = false; go.disabled = false; pw.focus();
      }, 1000);
    }

    el.querySelector('#lkwipe').onclick = async () => {
      if (!confirm('Erase all stored data for GFX Prod App in this browser?\n\n' +
                   'This cannot be undone. Only do this if you have a backup file, ' +
                   'or if you accept losing what is stored.')) return;
      try {
        localStorage.removeItem('gfxprod.state.v1');
        localStorage.removeItem('gfxprod.rescue');
        localStorage.removeItem('gfxprod.lockfail');
      } catch {}
      location.reload();
    };

    const submit = e => {
      e?.preventDefault();
      if (pw.disabled || !pw.value) return;
      go.disabled = true; go.textContent = 'Checking…';
      const value = pw.value;
      // let the button repaint before PBKDF2 blocks for a few hundred ms
      setTimeout(() => {
        form.removeEventListener('submit', submit);
        resolve(value);
      }, 20);
    };
    form.addEventListener('submit', submit);
  });
}

/** Called once the state is open, to take the lock screen away. */
function dismissLockScreen() { $('#lockscreen')?.remove(); }

/* ---------- "a newer backup exists" notice ------------------------------ */

/**
 * Discovery, not action. If another machine has written a newer backup we say
 * so once, prominently, and let the user decide. Pulling it down on our own
 * is exactly the behaviour that loses people an afternoon's work.
 */
function watchForNewerBackup() {
  onCloudChange(c => {
    if (!c.remoteNewer || $('#newerBackup')) return;
    const bar = document.createElement('div');
    bar.id = 'newerBackup';
    bar.className = 'banner warn';
    bar.style.cssText = 'margin:0;border-radius:0;border-left:0;border-right:0;border-top:0';
    bar.innerHTML = `
      <svg class="ico"><use href="#i-cloud"></use></svg>
      <div style="flex:1">
        <b>A newer backup exists in OneDrive.</b>
        Saved ${esc(String(c.remote?.savedAt || '').replace('T', ' ').slice(0, 16))}
        on ${esc(c.remote?.device || 'another machine')}. Nothing has been changed here.
      </div>
      <button class="btn sm" data-review>Review &amp; restore…</button>
      <button class="btn sm subtle" data-dismiss>Not now</button>`;
    $('#main').insertBefore(bar, $('#view'));
    bar.querySelector('[data-dismiss]').onclick = () => bar.remove();
    bar.querySelector('[data-review]').onclick = async () => {
      bar.remove();
      go('settings');
      const m = await import('./views/settings.js');
      m.restoreFromCloud({ rerender: () => route() });
    };
  });
}

/**
 * Notice when this tab is running code older than what the server has.
 *
 * GitHub Pages serves with `max-age=600`, and a Teams tab has no address bar,
 * no visible reload and a cache of its own — so a fix can be deployed, be
 * verifiably live, and still not be what you are looking at. That has now
 * caused two rounds of "the bug is still there" when the bug was already
 * fixed, which is the worst kind of confusion to leave lying around.
 *
 * Settings → About has always had a manual check. This makes the tab say it
 * itself, once, a few seconds after boot so it never competes with startup.
 */
function watchForNewerBuild() {
  setTimeout(async () => {
    let r;
    try { r = await checkForUpdate(); } catch { return; }   // offline: not worth a banner
    if (r.upToDate || $('#newerBuild')) return;

    const bar = document.createElement('div');
    bar.id = 'newerBuild';
    bar.className = 'banner';
    bar.style.cssText = 'margin:0;border-radius:0;border-left:0;border-right:0;border-top:0';
    bar.innerHTML = `
      <svg class="ico"><use href="#i-refresh"></use></svg>
      <div style="flex:1">
        <b>A newer version of this app is available.</b>
        You are on ${esc(r.current)}; the server has ${esc(r.latest)}.
        Your data is untouched either way.
      </div>
      <button class="btn sm primary" data-reload>Reload now</button>
      <button class="btn sm subtle" data-dismiss>Later</button>`;
    $('#main').insertBefore(bar, $('#view'));
    bar.querySelector('[data-dismiss]').onclick = () => bar.remove();
    bar.querySelector('[data-reload]').onclick = () => hardReload();
  }, 4000);
}

/** The folder equivalent, plus the one-click permission re-grant. */
function watchForNewerFolderBackup() {
  onLocalChange(l => {
    if (l.status === 'needs-reconnect' && !$('#folderReconnect')) {
      const bar = document.createElement('div');
      bar.id = 'folderReconnect';
      bar.className = 'banner warn';
      bar.style.cssText = 'margin:0;border-radius:0;border-left:0;border-right:0;border-top:0';
      bar.innerHTML = `
        <svg class="ico"><use href="#i-save"></use></svg>
        <div style="flex:1"><b>Backup folder needs reconnecting.</b>
          Browsers drop folder permission when they restart. One click and it resumes —
          same folder, nothing to re-pick.</div>
        <button class="btn sm" data-rc>Reconnect</button>
        <button class="btn sm subtle" data-dismiss>Not now</button>`;
      $('#main').insertBefore(bar, $('#view'));
      bar.querySelector('[data-dismiss]').onclick = () => bar.remove();
      bar.querySelector('[data-rc]').onclick = async () => {
        const ok = await reconnectFolder();
        if (ok) { bar.remove(); toast('Backup folder reconnected', 'ok'); }
        else toast('Permission was not granted', 'warn');
      };
      return;
    }
    if (!l.remoteNewer || $('#newerFolderBackup')) return;
    const bar = document.createElement('div');
    bar.id = 'newerFolderBackup';
    bar.className = 'banner warn';
    bar.style.cssText = 'margin:0;border-radius:0;border-left:0;border-right:0;border-top:0';
    bar.innerHTML = `
      <svg class="ico"><use href="#i-save"></use></svg>
      <div style="flex:1"><b>A newer backup is in your backup folder.</b>
        Saved ${esc(String(l.remote?.savedAt || '').replace('T', ' ').slice(0, 16))}
        on ${esc(l.remote?.device || 'another machine')}. Nothing has been changed here.</div>
      <button class="btn sm" data-review>Review &amp; restore…</button>
      <button class="btn sm subtle" data-dismiss>Not now</button>`;
    $('#main').insertBefore(bar, $('#view'));
    bar.querySelector('[data-dismiss]').onclick = () => bar.remove();
    bar.querySelector('[data-review]').onclick = async () => {
      bar.remove();
      go('settings');
      const m = await import('./views/settings.js');
      m.restoreFromFolder({ rerender: () => route() });
    };
  });
}

/* ---------- auto-lock ---------------------------------------------------- */

let idleTimer = null;

function armAutoLock() {
  const reset = () => {
    if (idleTimer) clearTimeout(idleTimer);
    const mins = S.get().settings.autoLockMinutes || 0;
    if (!mins || !S.isUnlocked()) return;
    idleTimer = setTimeout(lockNow, mins * 60_000);
  };
  ['mousedown', 'keydown', 'touchstart', 'wheel', 'focus'].forEach(ev =>
    window.addEventListener(ev, reset, { passive: true }));
  window.addEventListener('gfx:autolock-changed', reset);
  reset();
}

/**
 * Reloading is the honest way to lock: it guarantees no decrypted state is
 * left anywhere in memory or in the DOM.
 */
export async function lockNow() {
  if (!S.isUnlocked()) return;
  await S.lockNow();
  location.reload();
}

/* ---------- preferences -> CSS ------------------------------------------- */

export function applyPrefs() {
  const p = S.get().prefs;
  const root = document.documentElement;
  root.dataset.density = p.density || 'normal';
  root.style.setProperty('--accent', p.accent);
  root.style.setProperty('--accent-hover', shade(p.accent, -12));
  root.style.setProperty('--accent-fg', contrastOn(p.accent));
  applyTheme();
  $('#rail')?.classList.toggle('mini', !!p.railMini);
  const prof = S.get().profile;
  if ($('#brandMark')) $('#brandMark').textContent = 'GFX';
  if ($('#whoName')) {
    $('#whoName').textContent = prof.name || 'Set your name';
    $('#whoRole').textContent = prof.title || '—';
    const av = $('#whoAv');
    av.textContent = initials(prof.name || 'GFX');
    av.style.background = hashColor(prof.name || 'GFX');
  }
}

function applyTheme() {
  const want = S.get().prefs.theme;
  let t = want;
  if (want === 'auto') {
    t = teams.inTeams ? teams.theme
      : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default');
  }
  document.documentElement.dataset.theme = t;
}

function wireTheme() {
  onThemeChange(() => { if (S.get().prefs.theme === 'auto') applyTheme(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (S.get().prefs.theme === 'auto' && !teams.inTeams) applyTheme();
  });
}

function shade(hex, pct) {
  const n = parseInt(hex.replace('#', ''), 16);
  const f = c => Math.max(0, Math.min(255, Math.round(c * (1 + pct / 100))));
  return '#' + [f(n >> 16 & 255), f(n >> 8 & 255), f(n & 255)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function contrastOn(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const L = (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255;
  return L > 0.62 ? '#1b1b1b' : '#ffffff';
}

/** If Teams knows who we are and the profile is still the template, adopt it. */
function adoptTeamsIdentity() {
  if (!teams.user?.name) return;
  const p = S.get().profile;
  if (p.name && p.name !== 'Art Producer Lead') return;
  S.mutate(s => {
    s.profile.name = teams.user.name;
    s.profile.email = teams.user.upn || '';
  }, { noUndo: true, silent: true });
  const me = S.get().people.find(x => x.isMe);
  if (me) S.mutate(s => { s.people.find(x => x.isMe).name = teams.user.name; }, { noUndo: true, silent: true });
  applyPrefs();
}

/* ---------- navigation --------------------------------------------------- */

function renderNav() {
  const nav = $('#nav');
  if (!nav) return;
  const hidden = new Set(S.get().prefs.navHidden || []);
  // In the mini rail the group headers are hidden, so honouring `collapsed`
  // there would leave a section with no way to reach it. Icons only, all shown.
  const collapsed = S.get().prefs.railMini ? {} : (S.get().prefs.navCollapsed || {});
  const counts = badgeCounts();
  // The full route path, so an entry for one project can tell itself apart
  // from the group's Overview. `current` is only the view id.
  const activeKey = (location.hash || '#/dashboard').replace(/^#\//, '') || 'dashboard';
  let html = '';

  for (const gp of GROUPS) {
    const items = (gp.id === 'projects' ? projectItems() : VIEWS.filter(v => v.group === gp.id))
      .filter(v => !hidden.has(v.id));
    if (!items.length) continue;

    // Settings has no header, so it can never be collapsed away — losing the
    // way back into Settings would be a trap.
    if (!gp.label) {
      html += '<div style="height:10px"></div>';
      html += `<div class="nav-items" data-items-group="${gp.id}">`
            + orderedItems(items).map(v => navItem(v, counts, activeKey)).join('')
            + '</div>';
      continue;
    }

    const isShut = !!collapsed[gp.id];
    const holdsActive = items.some(v => isActive(v, activeKey));
    // sum of any hot badges inside, so a shut group still tells you something
    const hot = items.reduce((n, v) => n + (counts[v.id]?.hot ? counts[v.id].n : 0), 0);

    html += `<button class="nav-group${isShut ? ' shut' : ''}${holdsActive ? ' active-group' : ''}"
                data-group="${gp.id}" aria-expanded="${!isShut}"
                title="${isShut ? 'Show' : 'Hide'} ${esc(gp.label)}">
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      <span>${esc(gp.label)}</span>
      ${isShut && hot ? `<span class="nav-badge hot">${hot}</span>` : ''}
    </button>`;

    if (!isShut) {
      html += `<div class="nav-items" data-items-group="${gp.id}">`
            + orderedItems(items).map(v => navItem(v, counts, activeKey)).join('')
            + '</div>';
    }
  }
  nav.innerHTML = html;

  // Listeners live on #nav, which survives innerHTML, so wire them once.
  if (!nav.dataset.dnd) { wireNavDnd(nav); nav.dataset.dnd = '1'; }
}

/**
 * Which sidebar entry is the current one.
 *
 * A view id claims its own sub-paths, so `#/tasks/<id>` keeps Tasks lit while
 * a task is open. Entries marked `exact` do not, because the Projects group
 * puts Overview beside one entry per project: without this, opening a project
 * would light up both its own row and Overview.
 */
function isActive(v, key) {
  if (v.exact) return key === v.id;
  return key === v.id || key.startsWith(v.id + '/');
}

function navItem(v, counts, key) {
  const n = counts[v.id];
  // A project's own colour, so the mini rail is still readable when every
  // entry in the group shares one icon.
  const tint = v.tint ? ` style="color:${esc(v.tint)}"` : '';
  return `<div class="nav-item${isActive(v, key) ? ' on' : ''}" data-go="${v.id}"
               draggable="true" title="${esc(v.hint || v.title)}">
    <svg class="ico"${tint}><use href="#i-${v.icon}"></use></svg>
    <span class="nav-label">${esc(v.title)}</span>
    ${n ? `<span class="nav-badge${n.hot ? ' hot' : ''}">${n.n}</span>` : ''}
  </div>`;
}

/**
 * Project Management: Overview, one entry per live project, then Jira Imports.
 *
 * The project entries are not views. `views/projects.js` already renders a
 * single project when it is given one as a route parameter, so each entry is
 * simply a link to `#/projects/<id>` — no new view, no duplicated detail
 * rendering, and a project added anywhere gets its own entry, its tabs and its
 * own task board with no code to write. Archived projects are left out; they
 * are still reachable from Overview.
 */
function projectItems() {
  const overview = VIEWS.find(v => v.id === 'projects');
  const out = overview
    ? [{ id: 'projects', title: 'Overview', icon: overview.icon, exact: true,
         hint: 'Every project at a glance' }]
    : [];

  for (const p of S.get().projects || []) {
    if (p.status === 'archived') continue;
    out.push({
      id: `projects/${p.id}`,
      title: p.code || p.name,
      hint: p.name + (p.phase ? ` · ${p.phase}` : ''),
      icon: 'flag',
      tint: p.color || '',
    });
  }

  const imports = VIEWS.find(v => v.id === 'jira-imports');
  if (imports) {
    out.push({ id: imports.id, title: imports.title, icon: imports.icon, exact: true,
               hint: 'Every task filed into Jira, and which run filed it' });
  }
  return out;
}

/* ---------- sidebar reordering ------------------------------------------- */

/**
 * Put a group's items in the order the user dragged them into.
 *
 * `prefs.navOrder` is one flat list of view ids across the whole sidebar.
 * Anything not in it keeps its natural position at the end, so adding a new
 * view later does not need a migration and does not vanish.
 */
function orderedItems(items) {
  const order = S.get().prefs.navOrder || [];
  const rank = id => { const i = order.indexOf(id); return i === -1 ? Infinity : i; };
  return items.slice().sort((a, b) => rank(a.id) - rank(b.id));
}

/**
 * Drag to reorder, scoped to one group.
 *
 * Groups are the organising idea of this sidebar — Work, Team, Financials —
 * so letting Leave land under Financials would only ever be a mistake. The
 * drop target is the item's own `.nav-items` container, and a drag that
 * wanders outside it simply does nothing.
 */
let navDragEnded = 0;

function wireNavDnd(nav) {
  let dragEl = null, homeBox = null;

  nav.addEventListener('dragstart', e => {
    const item = e.target.closest('.nav-item');
    if (!item) return;
    dragEl = item;
    homeBox = item.closest('.nav-items');
    item.classList.add('nav-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.dataset.go);
  });

  nav.addEventListener('dragover', e => {
    if (!dragEl) return;
    const over = e.target.closest('.nav-item');
    // Only within the group it started in.
    if (!over || over === dragEl || over.closest('.nav-items') !== homeBox) return;
    e.preventDefault();
    const r = over.getBoundingClientRect();
    const below = (e.clientY - r.top) > r.height / 2;
    homeBox.insertBefore(dragEl, below ? over.nextSibling : over);
  });

  nav.addEventListener('drop', e => { if (dragEl) e.preventDefault(); });

  nav.addEventListener('dragend', () => {
    dragEl?.classList.remove('nav-dragging');
    dragEl = null; homeBox = null;
    // A drag often ends with a click event on the item; swallow it so
    // reordering does not also navigate away from where you are.
    navDragEnded = Date.now();

    // Commit the whole sidebar, reading the DOM rather than tracking indices.
    const ids = [...nav.querySelectorAll('.nav-item')].map(el => el.dataset.go);
    S.mutate(s => {
      const rest = (s.prefs.navOrder || []).filter(id => !ids.includes(id));
      s.prefs.navOrder = [...ids, ...rest];
    }, { noUndo: true, silent: true });
  });
}

function badgeCounts() {
  const s = S.get();
  const t = new Date().toISOString().slice(0, 10);
  const open = s.tasks.filter(x => x.status !== 'done');
  const overdue = open.filter(x => x.due && x.due < t).length;
  const atRisk = s.objectives.filter(o => o.status === 'at-risk' || o.status === 'off-track').length;
  const out = {
    tasks: open.length ? { n: overdue || open.length, hot: overdue > 0 } : null,
    objectives: atRisk ? { n: atRisk, hot: true } : null,
  };

  /* One badge per project entry in the sidebar: overdue first, because that is
     the number worth interrupting for, and otherwise nothing at all — a count
     of open tasks next to every project is just noise. */
  for (const p of s.projects || []) {
    const late = open.filter(x => x.project === p.id && x.due && x.due < t).length;
    if (late) out[`projects/${p.id}`] = { n: late, hot: true };
  }

  /* Tasks queued for Jira but not yet filed. Worth a badge because the queue
     is a thing you have to come back to — nothing sends it for you. */
  const queued = (s.tasks || []).filter(x => x.jira?.state === 'queued').length;
  if (queued) out['jira-imports'] = { n: queued, hot: false };
  return out;
}
const refreshBadges = () => refreshBackupBtn();

/** Tooltip and a nag dot on the header's Save-backup button. */
function refreshBackupBtn() {
  const b = $('#backupBtn');
  if (!b) return;
  const last = lastExportAt();
  const stale = exportIsStale();
  b.classList.toggle('nag', stale);
  b.title = last
    ? `Save backup — last saved ${new Date(last).toLocaleString()}${stale ? ' (overdue)' : ''}`
    : 'Save backup — never saved yet';
}

/* ---------- routing ------------------------------------------------------ */

function route() {
  const [, id, ...rest] = (location.hash || '#/dashboard').split('/');
  const view = byId(id || S.get().prefs.landing);
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  current = view.id;

  $('#pageTitle').textContent = view.title;
  $('#pageCrumb').textContent = view.subtitle || '';
  document.title = `${view.title} · GFX Prod App`;

  const host = $('#view');
  host.innerHTML = '<div class="view-pad"></div>';
  const pad = host.firstElementChild;

  const ctx = {
    params: rest,
    go,
    setCrumb: t => { $('#pageCrumb').textContent = t || ''; },
    /*
     * For a view that renders more than one thing. Projects shows the
     * portfolio at `#/projects` and a single project at `#/projects/<id>`;
     * without this the header would read "Overview" while you are looking at
     * Skylark. Passing nothing puts the view's own title back.
     */
    setTitle: t => {
      const name = t || view.title;
      $('#pageTitle').textContent = name;
      document.title = `${name} · GFX Prod App`;
    },
    rerender: () => route(),
  };

  // top-right per-view actions
  const ta = $('#topActions');
  ta.innerHTML = '';
  const acts = view.actions?.(ctx) || [];
  acts.forEach((a, i) => {
    const b = document.createElement('button');
    b.className = 'btn ' + (a.primary ? 'primary' : 'subtle') + (a.iconOnly ? ' icon' : '');
    b.innerHTML = (a.icon ? `<svg class="ico"><use href="#i-${a.icon}"></use></svg>` : '') +
                  (a.iconOnly ? '' : `<span>${esc(a.label)}</span>`);
    b.title = a.label;
    b.onclick = () => a.run(ctx);
    ta.appendChild(b);
  });

  try {
    cleanup = view.render(pad, ctx) || null;
  } catch (e) {
    console.error(e);
    pad.innerHTML = `<div class="banner risk"><svg class="ico"><use href="#i-warn"></use></svg>
      <div><b>That view failed to render.</b><span class="mono tiny">${esc(e.message)}</span></div></div>`;
  }
  renderNav();
  refreshBackupBtn();
  host.scrollTop = 0;
}

export function go(id, ...rest) {
  location.hash = '#/' + [id, ...rest].join('/');
  if ((location.hash.slice(2).split('/')[0] || 'dashboard') === current) route();
}
window.gfxGo = go;

/* ---------- chrome ------------------------------------------------------- */

function wireChrome() {
  $('#nav').addEventListener('click', e => {
    /*
     * Match the header BUTTON, not merely anything carrying `data-group`.
     * The items of a group now sit in their own wrapper, and when that wrapper
     * also answered to `[data-group]` every click on a nav item resolved to
     * its group header instead: the section collapsed and nothing navigated.
     */
    const grp = e.target.closest('button.nav-group');
    if (grp) {
      const id = grp.dataset.group;
      S.mutate(s => {
        const c = (s.prefs.navCollapsed ||= {});
        c[id] = !c[id];
      }, { noUndo: true, silent: true });
      renderNav();
      return;
    }
    // A finished drag fires a click on the item it landed on. Reordering the
    // sidebar should not also navigate you somewhere else.
    if (Date.now() - navDragEnded < 250) return;
    const it = e.target.closest('[data-go]');
    if (it) go(it.dataset.go);
  });
  $('#railToggle').onclick = () => {
    if (innerWidth <= 640) { $('#rail').classList.toggle('open'); return; }
    S.mutate(s => { s.prefs.railMini = !s.prefs.railMini; }, { noUndo: true, silent: true });
    applyPrefs();
  };
  $('#whoBtn').onclick = () => go('settings');
  $('#cmdBtn').onclick = palette;
  $('#themeBtn').onclick = () => {
    const order = ['auto', 'default', 'dark', 'contrast'];
    const cur = S.get().prefs.theme;
    const next = order[(order.indexOf(cur) + 1) % order.length];
    S.mutate(s => { s.prefs.theme = next; }, { noUndo: true, silent: true });
    applyPrefs();
    toast(`Theme: ${next === 'default' ? 'light' : next}`, '', 1400);
  };
  window.addEventListener('gfx:savefail', () =>
    toast('Could not save — browser storage may be full or blocked.', 'err', 8000));

  // Save backup, one click from anywhere. In a Teams tab this is the ONLY way
  // to get data onto disk, so it does not belong buried in Settings.
  const bk = document.createElement('button');
  bk.className = 'btn icon subtle';
  bk.id = 'backupBtn';
  bk.innerHTML = '<svg class="ico"><use href="#i-save"></use></svg>';
  bk.onclick = () => {
    const name = saveBackupFile();
    toast(`Saved ${name} to your Downloads folder`, 'ok', 5000);
    refreshBackupBtn();
  };
  $('#themeBtn').before(bk);
  refreshBackupBtn();

  // A lock button only makes sense when there is something to lock.
  if (S.isUnlocked()) {
    const b = document.createElement('button');
    b.className = 'btn icon subtle';
    b.id = 'lockBtn';
    b.title = 'Lock the app (Ctrl+L)';
    b.innerHTML = '<svg class="ico"><use href="#i-lock"></use></svg>';
    b.onclick = lockNow;
    $('#themeBtn').after(b);
  }
}

function wireKeys() {
  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); palette(); return; }
    if (mod && e.key.toLowerCase() === 'b' && !typing) { e.preventDefault(); $('#railToggle').click(); return; }
    if (mod && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      if (e.shiftKey ? S.redo() : S.undo()) { toast(e.shiftKey ? 'Redone' : 'Undone', '', 1200); route(); }
      return;
    }
    if (mod && e.key.toLowerCase() === 's' && !typing) { e.preventDefault(); S.flush(); toast('Saved', 'ok', 1200); return; }
    if (mod && e.key.toLowerCase() === 'l' && !typing && S.isUnlocked()) { e.preventDefault(); lockNow(); return; }
    if (!typing && !mod && e.altKey && /^[1-9]$/.test(e.key)) {
      const list = VIEWS.filter(v => !(S.get().prefs.navHidden || []).includes(v.id));
      const v = list[+e.key - 1];
      if (v) { e.preventDefault(); go(v.id); }
    }
  });
}

/* ---------- command palette --------------------------------------------- */

function palette() {
  const s = S.get();
  const items = [
    ...VIEWS.map(v => ({ g: 'Go to', t: v.title, sub: v.subtitle || '', run: () => go(v.id), icon: v.icon })),
    ...s.tasks.filter(t => t.status !== 'done').map(t => ({ g: 'Task', t: t.title, sub: S.projectName(t.project), run: () => go('tasks', t.id), icon: 'check' })),
    ...s.projects.map(p => ({ g: 'Project', t: p.name, sub: p.phase, run: () => go('projects', p.id), icon: 'flag' })),
    ...s.people.map(p => ({ g: 'Person', t: p.name, sub: p.role, run: () => go('people', p.id), icon: 'people' })),
    ...s.objectives.map(o => ({ g: 'Objective', t: o.title, sub: o.quarter, run: () => go('objectives', o.id), icon: 'target' })),
    { g: 'Action', t: 'New task', sub: '', run: () => go('tasks', 'new'), icon: 'plus' },
    { g: 'Action', t: 'Export a backup (JSON)', sub: '', run: () => go('settings'), icon: 'down' },
  ];

  dialog({
    title: 'Quick search',
    body: `<div class="search" style="margin-bottom:10px">
             <svg class="ico"><use href="#i-search"></use></svg>
             <input id="pq" type="search" placeholder="Search tasks, people, projects, objectives…" autocomplete="off">
           </div>
           <div id="pres" style="max-height:52vh;overflow:auto"></div>
           <div class="hint">↑↓ to move · Enter to open · Esc to close</div>`,
    footer: null,
    onMount: ({ root, close }) => {
      const q = root.querySelector('#pq'), res = root.querySelector('#pres');
      let sel = 0, shown = [];
      const draw = () => {
        const term = q.value.trim().toLowerCase();
        shown = (term ? items.filter(i => (i.t + ' ' + i.sub + ' ' + i.g).toLowerCase().includes(term)) : items.slice(0, 12)).slice(0, 40);
        sel = Math.min(sel, Math.max(0, shown.length - 1));
        res.innerHTML = shown.length ? shown.map((i, n) => `
          <div class="fitem${n === sel ? ' on' : ''}" data-n="${n}">
            <svg class="ico"><use href="#i-${i.icon}"></use></svg>
            <span class="nm">${esc(i.t)}</span>
            <span class="sz">${esc(i.sub || i.g)}</span>
          </div>`).join('') : '<div class="empty tiny">Nothing matched.</div>';
      };
      draw();
      q.addEventListener('input', () => { sel = 0; draw(); });
      q.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, shown.length - 1); draw(); e.preventDefault(); }
        if (e.key === 'ArrowUp')   { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
        if (e.key === 'Enter' && shown[sel]) { const r = shown[sel].run; close(); r(); }
      });
      res.addEventListener('click', e => {
        const it = e.target.closest('[data-n]'); if (!it) return;
        const r = shown[+it.dataset.n].run; close(); r();
      });
    },
  });
}

/* ---------- first run ---------------------------------------------------- */

function welcome() {
  dialog({
    title: 'Welcome to GFX Prod App',
    body: `
      <p>This is your console, loaded with a <b>sample dataset</b> so nothing looks empty
      while you find your way around. Three things worth knowing:</p>
      <ol style="padding-left:20px;line-height:1.7">
        <li><b>Everything is local.</b> Your data lives in this browser profile only. Nothing is
            uploaded anywhere unless you connect Microsoft 365 yourself in Settings.</li>
        <li><b>The people are invented.</b> Replace them in <b>Team → Import</b>, or clear the
            samples in <b>Settings → Data</b>.</li>
        <li><b>Back up regularly.</b> Settings → Data → <i>Export backup</i>. Browser storage is
            not a filing system — treat the export as the real copy.</li>
      </ol>
      <p class="hint">Press <b>Ctrl + K</b> at any time to jump anywhere.</p>`,
    footer: `<button class="btn" data-tour>Set up my profile</button>
             <button class="btn primary" data-ok>Start exploring</button>`,
    onMount: ({ root, close }) => {
      root.querySelector('[data-ok]').onclick = () => close();
      root.querySelector('[data-tour]').onclick = () => { close(); go('settings'); };
    },
  });
}
