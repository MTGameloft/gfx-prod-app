/* ============================================================================
   views/settings.js — profile, appearance, org setup, Microsoft 365, data.
   ========================================================================= */

import * as S from '../store.js';
import {
  h, raw, esc, icon, toast, dialog, formDlg, confirmDlg, acts, avatar,
  fmtDate, today, download, pickFile, initials, hashColor, fmtMoneyFull,
} from '../ui.js';
import { applyPrefs, lockNow } from '../app.js';
import { teams } from '../teams.js';
import * as lock from '../lock.js';
import {
  cloud, cloudStatusText, deviceLabel, backupNow, listBackups,
  fetchBackupText, openPayload, checkRemote,
} from '../cloudbackup.js';
import { graph, initGraph, connect as graphConnect, disconnect as graphDisconnect,
         CAPABILITIES, DEFAULT_CAPS, allScopes } from '../graph.js';
import * as LB from '../localbackup.js';
import * as BR from '../bridge.js';
import { BUILD, BUILD_NOTES, checkForUpdate, hardReload } from '../version.js';
import { saveBackupFile, lastExportAt, exportIsStale } from '../backupformat.js';
import { divisionLabel, jiraProjects } from '../jira.js';

const ACCENTS = ['#6264A7', '#0F6CBD', '#C4314B', '#107C10', '#B146C2', '#C77405', '#0E7A70', '#4F52B2', '#2B2B40'];

/*
 * Settings is six screens, not one.
 *
 * It had grown to eleven cards down two columns — roughly four screens of
 * scrolling in which "how do I change the accent colour" and "where is the
 * rate card" were the same problem. They are grouped by what you came to do,
 * and the tab is the route parameter so a tab is linkable and the back button
 * moves between them.
 */
const TABS = [
  { id: 'you',      label: 'You',           sub: 'how the app addresses you, and how it looks' },
  { id: 'org',      label: 'Organisation',  sub: 'divisions, rates, links and working assumptions' },
  { id: 'connect',  label: 'Integrations',  sub: 'Microsoft 365 and the local bridge' },
  { id: 'backup',   label: 'Backup & data', sub: 'where copies go, and what to do with them' },
  { id: 'security', label: 'Security',      sub: 'password protection for this browser profile' },
  { id: 'about',    label: 'About',         sub: 'build, storage and what changed' },
];
const tabOf = v => (TABS.some(t => t.id === v) ? v : 'you');

/*
 * Where things live on THIS machine.
 *
 * These were three hard-coded `I:\…` literals. A path is a fact about one
 * person's disk, this repository is public, and a second person running the
 * app would have been shown a folder that does not exist. So they are
 * settings, blank by default, and every place that reads one has generic
 * wording for when it is blank.
 */
const paths = () => S.get().settings?.paths || {};
const bridgeCmdPath = () => {
  const dir = String(paths().tools || '').trim();
  return dir ? `"${dir.replace(/[\\/]+$/, '')}\\gfx-bridge.ps1"` : 'tools\\gfx-bridge.ps1';
};

const WIDGETS = [
  { id: 'kpis',       label: 'Headline numbers' },
  { id: 'today',      label: "Today's focus" },
  { id: 'milestones', label: 'Upcoming milestones' },
  { id: 'burn',       label: 'Budget burn' },
  { id: 'leave',      label: 'Who is away' },
  { id: 'okr',        label: 'Objective progress' },
  { id: 'risks',      label: 'Risks & blockers' },
  { id: 'capacity',   label: 'Division capacity' },
];

/* ---------- sections ----------------------------------------------------- */

function profileCard() {
  const p = S.get().profile;
  return h`
  <section class="card">
    <header><h3>Profile</h3><span class="sub">how the app addresses you</span></header>
    <div class="body">
      <div class="row" style="gap:14px;margin-bottom:14px">
        <span class="avatar" style="width:52px;height:52px;font-size:18px;background:${hashColor(p.name || 'GFX')}">${initials(p.name || 'GFX')}</span>
        <div style="flex:1">
          <label class="fld" style="margin-bottom:8px"><span>Name</span>
            <input id="p_name" value="${esc(p.name || '')}"></label>
          <label class="fld" style="margin:0"><span>Title</span>
            <input id="p_title" value="${esc(p.title || '')}" placeholder="Art Producer Lead — GFX"></label>
        </div>
      </div>
      <div class="grid g2">
        <label class="fld"><span>Work email</span><input type="email" id="p_email" value="${esc(p.email || '')}"></label>
        <label class="fld"><span>Time zone</span><input id="p_tz" value="${esc(p.timezone || '')}" placeholder="Asia/Ho_Chi_Minh"></label>
      </div>
      ${raw(teams.inTeams && teams.user ? `<div class="hint">Teams says you are signed in as
        <b>${esc(teams.user.name)}</b> (${esc(teams.user.upn)}).</div>` : '')}
      <button class="btn primary sm" data-act="save-profile" style="margin-top:6px">Save profile</button>
    </div>
  </section>`;
}

function appearanceCard() {
  const pr = S.get().prefs;
  return h`
  <section class="card">
    <header><h3>Appearance</h3><span class="sub">yours alone — stored in this browser</span></header>
    <div class="body">
      <label class="fld"><span>Theme</span>
        <div class="seg">
          ${raw([['auto', 'Match Teams'], ['default', 'Light'], ['dark', 'Dark'], ['contrast', 'High contrast']]
            .map(([v, t]) => `<button data-act="theme" data-v="${v}" class="${pr.theme === v ? 'on' : ''}">${t}</button>`).join(''))}
        </div></label>

      <label class="fld"><span>Accent colour</span>
        <div class="row wrap" style="gap:7px">
          ${raw(ACCENTS.map(c => `<button data-act="accent" data-v="${c}" title="${c}"
            style="width:28px;height:28px;border-radius:50%;border:2px solid ${pr.accent.toLowerCase() === c.toLowerCase() ? 'var(--text)' : 'transparent'};background:${c};cursor:pointer"></button>`).join(''))}
          <input type="color" id="accentPick" value="${esc(pr.accent)}" title="Custom colour" style="width:38px">
        </div></label>

      <label class="fld"><span>Density</span>
        <div class="seg">
          ${raw([['compact', 'Compact'], ['normal', 'Normal'], ['roomy', 'Roomy']]
            .map(([v, t]) => `<button data-act="density" data-v="${v}" class="${pr.density === v ? 'on' : ''}">${t}</button>`).join(''))}
        </div></label>

      <!--
        These three used to be saved by the "Save assumptions" button in the
        Organisation column. Once Settings became tabs that button was on
        another screen, so they save on change like everything else here.
      -->
      <div class="grid g2">
        <label class="fld"><span>Open on</span>
          <select id="p_landing" data-change="view-pref">${raw(['dashboard','tasks','objectives','projects','people','leave','finance','files','notes']
            .map(v => `<option value="${v}"${pr.landing === v ? ' selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join(''))}</select></label>
        <label class="fld"><span>Currency</span>
          <div class="row">
            <input id="p_cur" value="${esc(pr.currency)}" data-change="view-pref" style="width:80px" placeholder="USD">
            <input id="p_sym" value="${esc(S.get().settings.currencySymbol)}" data-change="view-pref" style="width:56px" placeholder="$">
          </div></label>
      </div>

      <div class="fld"><span style="display:block;font-size:11.5px;font-weight:600;color:var(--text-dim);margin-bottom:6px">Dashboard widgets</span>
        <div class="row wrap" style="gap:7px">
          ${raw(WIDGETS.map(w => `<button class="chip ${pr.widgets.includes(w.id) ? 'accent' : ''}"
            data-act="widget" data-v="${w.id}" style="cursor:pointer;border:0;height:26px">
            ${pr.widgets.includes(w.id) ? '✓ ' : '+ '}${esc(w.label)}</button>`).join(''))}
        </div>
        <span class="hint">Click to show or hide. Order follows this list.</span></div>

      <div class="fld" style="margin:0"><span style="display:block;font-size:11.5px;font-weight:600;color:var(--text-dim);margin-bottom:6px">Hide sections from the sidebar</span>
        <div class="row wrap" style="gap:7px">
          ${raw(['tasks','objectives','projects','people','leave','finance','outsourcing','files','notes'].map(v => `
            <button class="chip ${(pr.navHidden || []).includes(v) ? '' : 'accent'}" data-act="navtoggle" data-v="${v}"
              style="cursor:pointer;border:0;height:26px">${(pr.navHidden || []).includes(v) ? '+ ' : '✓ '}${v}</button>`).join(''))}
        </div></div>
    </div>
  </section>`;
}

function divisionsCard() {
  const s = S.get();
  return h`
  <section class="card">
    <header><h3>Divisions</h3><span class="sub">the shape of your art department</span>
      <div class="spacer" style="flex:1"></div>
      <button class="btn sm subtle" data-act="div-add">${icon('plus')}Add</button></header>
    <div class="body flush"><table class="tbl">
      <thead><tr><th></th><th>Name</th><th>Jira label</th><th class="num">People</th><th></th></tr></thead>
      <tbody>
      ${raw(s.divisions.map(d => `<tr data-d="${d.id}">
        <td style="width:1%"><span class="pill-div" style="background:${d.color}">${esc(d.id)}</span></td>
        <td>${esc(d.name)}</td>
        <td style="width:130px"><input value="${esc(divisionLabel(d.id, s))}" data-change="div-label"
          placeholder="none" title="Filed on every task in this division" style="font-family:var(--mono,monospace);font-size:12px"></td>
        <td class="num tiny mute">${s.people.filter(p => p.division === d.id && p.active !== false).length}</td>
        <td class="act">
          <input type="color" value="${esc(d.color)}" data-input="div-colour" style="width:34px;height:24px;padding:1px">
          <button class="btn icon sm subtle" data-act="div-del"><svg class="ico"><use href="#i-x"></use></svg></button></td>
      </tr>`).join(''))}
    </tbody></table>
      <div class="tiny mute" style="padding:9px 12px">The Jira label goes on every task this division
      sends to Jira. Blank means it adds none; spaces become hyphens, because Jira rejects a label with a
      space in it. This is the <b>JiraLabel</b> column on the Divisions sheet of <code>01_People.xlsx</code>.</div>
    </div>
  </section>`;
}

function rateCardSection() {
  const s = S.get();
  return h`
  <section class="card">
    <header><h3>Rate card</h3><span class="sub">used when a person has no explicit cost, and by the scenario modeller</span></header>
    <div class="body flush"><table class="tbl">
      <thead><tr><th>Level</th><th class="num">Fully loaded cost / month</th></tr></thead>
      <tbody>${raw(s.rateCard.map(r => `<tr data-r="${r.id}">
        <td>${esc(r.seniority)}</td>
        <td class="num"><input type="number" value="${r.monthly}" data-input="rate" step="100" style="width:120px;text-align:right"></td>
      </tr>`).join(''))}</tbody></table>
      <div class="tiny mute" style="padding:9px 12px">“Fully loaded” means salary plus employer costs, licences and
      desk — whatever your finance team uses when they cost a headcount. Round numbers are fine; the point is
      the shape of a forecast, not payroll accuracy.</div>
    </div>
  </section>`;
}

function linksCard() {
  const s = S.get();
  return h`
  <section class="card">
    <header><h3>Workspace links</h3><span class="sub">shown in Files and on the dashboard</span>
      <div class="spacer" style="flex:1"></div>
      <button class="btn sm subtle" data-act="link-add">${icon('plus')}Add</button></header>
    <div class="body flush"><table class="tbl"><tbody>
      ${raw(s.settings.workspaceLinks.map(l => `<tr data-l="${l.id}">
        <td style="width:34%"><input value="${esc(l.label)}" data-input="link-label" placeholder="Label"></td>
        <td><input value="${esc(l.url)}" data-input="link-url" placeholder="https://…"></td>
        <td class="act"><button class="btn icon sm subtle" data-act="link-del"><svg class="ico"><use href="#i-x"></use></svg></button></td>
      </tr>`).join('') || '<tr><td class="tiny mute" style="padding:14px">No links yet.</td></tr>')}
    </tbody></table></div>
  </section>`;
}

function workCard() {
  const s = S.get();
  return h`
  <section class="card">
    <header><h3>Working assumptions</h3>
      <span class="sub">every capacity, cost and duration figure in the app rests on these</span></header>
    <div class="body grid g3">
      <label class="fld"><span>Hours per working day</span>
        <input type="number" id="w_hpd" value="${s.settings.hoursPerDay}" min="1" max="24" step="0.5"></label>
      <label class="fld"><span>Utilisation target %</span>
        <input type="number" id="w_util" value="${s.settings.utilisationTarget}" min="0" max="100"></label>
      <label class="fld"><span>Fiscal year starts</span>
        <select id="w_fy">${raw(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
          .map((m, i) => `<option value="${i + 1}"${s.prefs.fiscalStart === i + 1 ? ' selected' : ''}>${m}</option>`).join(''))}</select></label>
      <div class="fld" style="grid-column:span 3;margin:0"><span style="display:block;font-size:11.5px;font-weight:600;color:var(--text-dim);margin-bottom:6px">Working days</span>
        <div class="row wrap" style="gap:6px">
          ${raw(['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d, i) => `
            <button class="chip ${(s.prefs.workingDays || []).includes(i) ? 'accent' : ''}" data-act="wd" data-v="${i}"
              style="cursor:pointer;border:0;height:26px">${d}</button>`).join(''))}
        </div></div>
      <button class="btn primary sm" data-act="save-work" style="grid-column:span 3;justify-self:start">Save assumptions</button>
    </div>
  </section>`;
}

/**
 * The Jira projects this app files into.
 *
 * These used to be a hard-coded array in `jira.js` holding real project keys,
 * epic ids and component names. A tracker's internal identifiers next to a
 * client's product name is not something to publish from a public repository,
 * so they are configuration now — and the app is genuinely better for it: a
 * third project no longer needs a code change.
 */
function jiraCard() {
  const list = jiraProjects();
  return h`
  <section class="card">
    <header><h3>Jira projects</h3>
      <span class="sub">where tasks are filed, and the fields each project demands</span>
      <div class="spacer" style="flex:1"></div>
      ${raw(list.length ? `<span class="chip ok">${list.length} configured</span>` : '<span class="chip warn">none yet</span>')}
      <button class="btn sm subtle" data-act="jp-add">${icon('plus')}Add</button></header>
    ${raw(list.length ? `<div class="body flush"><table class="tbl">
      <thead><tr><th>Key</th><th>Name</th><th>Component</th><th>Epic</th><th>Requires</th><th></th></tr></thead>
      <tbody>${list.map(p => `<tr data-jp="${esc(p.key)}">
        <td><code>${esc(p.key)}</code></td>
        <td>${esc(p.name || '')}</td>
        <td class="tiny">${esc(p.component || '—')}</td>
        <td class="tiny">${esc(p.defaultParent || '—')}
          ${p.defaultParentName ? `<div class="mute">${esc(p.defaultParentName)}</div>` : ''}</td>
        <td class="tiny mute">${[p.requiresParent ? 'epic' : '', p.labelsRequired ? 'a label' : '']
          .filter(Boolean).join(' · ') || 'nothing extra'}</td>
        <td class="act">
          <button class="btn sm subtle" data-act="jp-edit">Edit</button>
          <button class="btn icon sm subtle" data-act="jp-del"><svg class="ico"><use href="#i-x"></use></svg></button></td>
      </tr>`).join('')}</tbody></table></div>` : `<div class="body">
      <div class="tiny mute" style="line-height:1.7">
        Nothing is filed until a project is set up here. Add its <b>key</b> (the prefix on
        every issue), the <b>component</b> and <b>epic</b> the team files GFX work under, and
        the <b>priority</b> names that project accepts — Jira rejects a priority it does not
        have. Until then, queueing a task says so rather than guessing a destination.
      </div></div>`)}
    <div class="body" style="padding-top:0">
      <div class="tiny mute">Stored in this browser and in your backups, never in the app's
      source. The reporter account id lives here too — blank files as the owner of the API
      token the helper uses, which is you.</div>
    </div>
  </section>`;
}

/** Folders on this machine. Blank is fine; the screens adapt. */
function foldersCard() {
  const p = paths();
  return h`
  <section class="card">
    <header><h3>Folders on this machine</h3>
      <span class="sub">so the screens can name them — nothing is read from here by the browser</span></header>
    <div class="body">
      <label class="fld"><span>Workbook folder</span>
        <input id="pa_wb" value="${esc(p.workbooks || '')}" data-change="paths" data-k="workbooks"
               placeholder="e.g. D:\\Art Production\\Workbooks"></label>
      <label class="fld"><span>Backup archive folder</span>
        <input id="pa_bk" value="${esc(p.backups || '')}" data-change="paths" data-k="backups"
               placeholder="where the logon sweep files old backups"></label>
      <label class="fld"><span>Tools folder</span>
        <input id="pa_tl" value="${esc(p.tools || '')}" data-change="paths" data-k="tools"
               placeholder="the folder holding gfx-bridge.ps1 and jira-push.ps1"></label>
      <div class="tiny mute" style="line-height:1.7;margin-top:4px">
        A browser cannot read a folder, so these are labels: they make Excel Sync and the
        bridge instructions name the right place instead of a guess. They were hard-coded
        to one machine's <span class="mono">I:</span> drive until now.
      </div>
    </div>
  </section>`;
}

function graphCard() {
  const g = S.get().settings.graph;
  const caps = g.caps || DEFAULT_CAPS;
  const redirect = new URL('auth-end.html', location.href).href;
  return h`
  <section class="card">
    <header><h3>Microsoft 365</h3>
      <span class="sub">optional — powers SharePoint files and out-of-office sync</span>
      <div class="spacer" style="flex:1"></div>
      ${raw(graph.connected
        ? `<span class="chip ok">connected${graph.me ? ' · ' + esc(graph.me.displayName) : ''}</span>`
        : g.clientId ? '<span class="chip warn">configured, signed out</span>' : '<span class="chip">not set up</span>')}
    </header>
    <div class="body">
      <div class="grid g2">
        <label class="fld"><span>Application (client) ID</span>
          <input id="g_client" value="${esc(g.clientId)}" placeholder="00000000-0000-0000-0000-000000000000" class="mono"></label>
        <label class="fld"><span>Directory (tenant) ID</span>
          <input id="g_tenant" value="${esc(g.tenantId || 'common')}" placeholder="common" class="mono"></label>
      </div>
      <label class="fld"><span>Redirect URI to register (copy this exactly)</span>
        <div class="row"><input readonly value="${esc(redirect)}" class="mono" onfocus="this.select()">
          <button class="btn sm" data-act="copy-redirect">Copy</button></div>
        <span class="hint">Register it as a <b>Single-page application</b> platform, not Web.</span></label>
      <div class="fld">
        <span style="display:block;font-size:11.5px;font-weight:600;color:var(--text-dim);margin-bottom:6px">
          What it may do — ask for only what your tenant has consented to</span>
        ${raw(CAPABILITIES.map(c => `
          <label class="row" style="gap:8px;align-items:flex-start;margin-bottom:7px">
            <input type="checkbox" data-change="cap" data-cap="${c.id}" ${caps[c.id] ? 'checked' : ''} style="margin-top:2px">
            <span class="tiny" style="flex:1"><b>${esc(c.label)}</b>
              <span class="mute"> — ${esc(c.why)}</span>
              <span class="mono" style="display:block;font-size:10.5px;opacity:.7">${esc(c.scopes.join(' '))}</span></span>
          </label>`).join(''))}
        <span class="hint">Ticking something the tenant has not consented to makes sign-in fail
        for <i>everything</i>, so start small and add as you go.</span>
      </div>

      <label class="row" style="gap:8px;margin:4px 0 12px">
        <input type="checkbox" id="g_auto" ${g.autoConnect ? 'checked' : ''}>
        <span class="tiny">Sign in silently when the app opens (no popup if your session is still valid)</span></label>
      <div class="row wrap">
        <button class="btn primary sm" data-act="graph-save">Save</button>
        <button class="btn sm" data-act="graph-connect" ${g.clientId ? '' : 'disabled'}>${icon('cloud')}Connect &amp; test</button>
        ${raw(graph.connected ? '<button class="btn sm danger" data-act="graph-out">Sign out</button>' : '')}
      </div>
      <div class="tiny mute" style="margin-top:8px">Will request:
        <span class="mono">${esc(allScopes({ caps }).join(' · '))}</span>
        <button class="btn sm subtle" data-act="copy-scopes" style="margin-left:6px">Copy for IT</button></div>
      ${raw(graph.lastError ? `<div class="banner risk" style="margin-top:12px">
        <svg class="ico"><use href="#i-warn"></use></svg>
        <div><b>Last Graph error</b><div class="tiny mono">${esc(graph.lastError.message)}</div></div></div>` : '')}
      <div class="banner" style="margin-top:12px"><svg class="ico"><use href="#i-info"></use></svg>
        <div>Delegated permissions only: the app can reach exactly the files you can reach, and nothing runs
        when you are not signed in. Most tenants need an administrator to grant consent once for
        <span class="mono">Sites.ReadWrite.All</span> — see <span class="mono">docs/AZURE-AD.md</span>.</div></div>
    </div>
  </section>`;
}

function securityCard() {
  const on = S.isEncrypted();
  const mins = S.get().settings.autoLockMinutes ?? 15;
  const ok = lock.cryptoAvailable();
  return h`
  <section class="card">
    <header>${icon('shield')}<h3>Password protection</h3>
      <div class="spacer" style="flex:1"></div>
      ${raw(on ? '<span class="chip ok">encrypted</span>' : '<span class="chip">off</span>')}
    </header>
    <div class="body">
      ${raw(!ok ? `<div class="banner risk"><svg class="ico"><use href="#i-warn"></use></svg>
        <div><b>Not available here.</b>${esc(lock.unavailableReason())}</div></div>` : '')}

      ${raw(on ? `
        <p class="tiny">Everything is stored encrypted. A password is required each time the app
        opens, and after ${mins ? mins + ' minutes' : 'no amount'} of inactivity.</p>
        <div class="row wrap" style="margin:12px 0">
          <button class="btn sm" data-act="pw-change">Change password</button>
          <button class="btn sm" data-act="pw-lock">${icon('lock')}Lock now</button>
          <div class="spacer" style="flex:1"></div>
          <button class="btn sm danger" data-act="pw-off">Turn protection off</button>
        </div>
        <label class="fld" style="margin:0"><span>Lock automatically after</span>
          <select data-change="autolock" style="max-width:220px">
            ${[0, 5, 15, 30, 60].map(m =>
              `<option value="${m}"${m === mins ? ' selected' : ''}>${m ? m + ' minutes idle' : 'Never'}</option>`).join('')}
          </select></label>
      ` : `
        <p class="tiny">Off. Anyone who can use this browser profile can read your team, costs and
        budgets — including from the developer tools, where storage is plain text.</p>
        <button class="btn primary sm" data-act="pw-on" style="margin-top:10px"${ok ? '' : ' disabled'}>
          ${icon('lock')}Set a password</button>
      `)}

      <div class="sep"></div>
      <details>
        <summary class="tiny mute" style="cursor:pointer">What this does and does not protect</summary>
        <div class="tiny dim" style="line-height:1.65;margin-top:9px">
          <p><b>It does:</b> encrypt your stored data with AES-256-GCM, using a key derived from your
          password by PBKDF2-SHA256 over 310,000 iterations and a random salt. The key is never
          written down anywhere. Someone at your unlocked machine, or reading this browser's storage
          directly, gets ciphertext.</p>
          <p><b>It does not:</b> make the app's address private. This is a static page on a public
          host and anyone can read its code — that is fine, because the code is not the secret. Nor
          does it help if the machine itself is compromised.</p>
          <p><b>There is no recovery.</b> No reset link, no back door. Those would defeat the point.
          Forget the password and the data is gone, which is why the app makes you take a backup
          first.</p>
        </div>
      </details>
    </div>
  </section>`;
}

function bridgeCard() {
  const c = S.get().settings.bridge || {};
  const chip = BR.bridge.status === 'idle' ? 'ok'
             : ['unreachable', 'unauthorised', 'error', 'blocked'].includes(BR.bridge.status) ? 'risk'
             : BR.bridge.status === 'saving' ? 'info' : '';
  const blocked = !BR.reachable();
  return h`
  <section class="card">
    <header>${icon('link')}<h3>Local bridge</h3>
      <span class="sub">only usable when the app is opened over http</span>
      <div class="spacer" style="flex:1"></div>
      <span class="chip ${chip}">${BR.bridgeStatusText()}</span>
    </header>
    <div class="body">
      <p class="tiny">A helper script on this machine that the app posts its backup to, writing it
      straight to disk with no folder picker involved.</p>

      ${raw(blocked ? `<div class="banner risk" style="margin:12px 0">
        <svg class="ico"><use href="#i-warn"></use></svg>
        <div><b>Not usable from this page.</b> ${esc(BR.unreachableReason())}</div></div>` : '')}

      <div class="banner" style="margin:12px 0">
        <svg class="ico"><use href="#i-info"></use></svg>
        <div><b>Start it first.</b> Run this from the app folder, then copy the URL
          and token it prints:
          <div class="mono tiny" style="margin-top:6px;word-break:break-all">powershell -ExecutionPolicy Bypass -File ${raw(esc(bridgeCmdPath()))}</div>
        </div>
      </div>

      <div class="grid g2">
        <label class="fld"><span>Bridge address</span>
          <input id="br_url" value="${esc(c.url || '')}" class="mono" placeholder="http://127.0.0.1:8787"></label>
        <label class="fld"><span>Token</span>
          <input id="br_token" value="${esc(c.token || '')}" class="mono" placeholder="paste from the bridge window"></label>
      </div>
      <label class="row" style="gap:8px;margin:2px 0 12px">
        <input type="checkbox" id="br_on" ${c.enabled ? 'checked' : ''}>
        <span class="tiny"><b>Back up through the bridge automatically</b> — on every change, debounced</span>
      </label>

      <div class="row wrap">
        <button class="btn sm" data-act="br-save">Save</button>
        <button class="btn sm" data-act="br-test">${icon('refresh')}Test connection</button>
        <button class="btn sm" data-act="br-now">${icon('save')}Back up now</button>
        <button class="btn sm" data-act="br-restore">${icon('down')}Restore…</button>
        <div class="spacer" style="flex:1"></div>
        <button class="btn sm primary" data-act="br-handoff" title="Opens SharePoint in Chrome with the newest backup selected in Explorer">
          ${icon('up')}Push to SharePoint</button>
      </div>

      ${raw(BR.bridge.lastError ? `<div class="banner risk" style="margin-top:12px">
        <svg class="ico"><use href="#i-warn"></use></svg>
        <div><b>${esc(BR.bridge.status === 'unauthorised' ? 'Token rejected' : 'Bridge problem')}</b>
        <div class="tiny mono">${esc(BR.bridge.lastError)}</div></div></div>` : '')}

      ${raw(BR.bridge.folder ? `<div class="tiny mute" style="margin-top:10px">Writing to
        <span class="mono">${esc(BR.bridge.folder)}</span></div>` : '')}

      <div class="sep"></div>
      <details>
        <summary class="tiny mute" style="cursor:pointer">Why a token, and what this can and cannot do</summary>
        <div class="tiny dim" style="line-height:1.65;margin-top:9px">
          <p>A local server that writes files is reachable by <i>any</i> page in your browser, so every
          write needs the shared token, the listener binds loopback only, filenames must match
          <span class="mono">gfx-*.json</span>, and they are written only inside the configured folder.
          There is no token-free mode on purpose.</p>
          <p><b>It does not rescue the Teams tab.</b> I had hoped it would. Browsers refuse to let an
          HTTPS page call an <span class="mono">http://</span> address, loopback included — Chrome
          drops it before the request leaves, so the bridge never sees it. A Teams tab loads the
          HTTPS origin, so this only works when you open the app from
          <span class="mono">serve.ps1</span> over http. In Teams, nothing can reach the disk;
          use <b>Backup to a folder</b> in Edge instead.</p>
          <p><b>It cannot upload to SharePoint by itself.</b> Graph needs the app registration IT
          declined, and WebDAV is refused by your tenant. <i>Push to SharePoint</i> therefore opens
          the folder in Chrome with the newest backup selected in Explorer — one drag, about five
          seconds. That last step is a person's, not a script's.</p>
        </div>
      </details>
    </div>
  </section>`;
}

function folderCard() {
  const cap = LB.capability();
  const c = S.get().settings.localBackup || {};
  const chip = LB.local.status === 'idle' ? 'ok'
             : LB.local.status === 'error' || LB.local.status === 'needs-reconnect' ? 'risk'
             : LB.local.status === 'saving' ? 'info' : '';
  return h`
  <section class="card">
    <header>${icon('save')}<h3>Backup to a folder</h3>
      <span class="sub">no Azure, no admin</span>
      <div class="spacer" style="flex:1"></div>
      <span class="chip ${chip}">${LB.localStatusText()}</span>
    </header>
    <div class="body">
      <p class="tiny">Point this at your <b>OneDrive sync folder</b> — the one on your disk, something
      like <span class="mono">C:\\Users\\you\\OneDrive - Gameloft\\Apps\\GFX Prod App</span>. The app
      writes the backup there and the OneDrive client you already have uploads it and syncs it to
      your other machines. Same result as the Graph API, without needing one.</p>

      ${raw(!cap.ok ? `
        <div class="banner ${cap.inIframe ? 'warn' : 'risk'}" style="margin-top:12px">
          <svg class="ico"><use href="#i-warn"></use></svg>
          <div><b>${cap.inIframe ? 'Not available inside the Teams tab.' : 'Not available in this browser.'}</b>
          ${esc(cap.why)}</div>
        </div>
        ${cap.inIframe ? `<div class="banner" style="margin-top:10px">
          <svg class="ico"><use href="#i-info"></use></svg>
          <div><b>What to do instead.</b> Open <span class="mono">${esc(location.origin + location.pathname)}</span>
          in Edge and use it there as your primary window — the folder backup works, and Edge and the
          Teams tab are separate stores anyway, so you would have had to pick one regardless.</div>
        </div>` : ''}
      ` : `
        <div class="row wrap" style="margin:12px 0">
          ${c.folderName
            ? `<span class="chip accent">${esc(c.folderName)}</span>
               <button class="btn sm" data-act="fb-pick">Change folder…</button>
               <button class="btn sm" data-act="fb-now">${'<svg class="ico"><use href="#i-up"></use></svg>'}Save now</button>
               <button class="btn sm" data-act="fb-restore">${'<svg class="ico"><use href="#i-down"></use></svg>'}Restore…</button>
               <div class="spacer" style="flex:1"></div>
               <button class="btn sm danger" data-act="fb-forget">Stop</button>`
            : `<button class="btn primary sm" data-act="fb-pick">${'<svg class="ico"><use href="#i-folder"></use></svg>'}Choose a folder…</button>`}
        </div>
        ${LB.local.status === 'needs-reconnect' ? `
          <div class="banner warn"><svg class="ico"><use href="#i-warn"></use></svg>
            <div><b>Permission to that folder has lapsed.</b> Browsers drop folder access when they
            restart — it is one click to give it back, and you keep the same folder.
            <button class="btn sm" data-act="fb-reconnect" style="margin-top:8px">Reconnect</button></div></div>` : ''}
        <label class="fld" style="max-width:220px"><span>Daily snapshots to keep</span>
          <input type="number" id="fb_keep" value="${c.keep ?? 30}" min="0" max="365"></label>
      `)}

      ${raw(LB.local.lastError && cap.ok ? `<div class="banner risk" style="margin:0 0 12px">
        <svg class="ico"><use href="#i-warn"></use></svg>
        <div><b>Last attempt failed</b><div class="tiny mono">${esc(LB.local.lastError)}</div></div></div>` : '')}

      ${raw(LB.local.remote ? `<div class="tiny mute">Newest in the folder:
        <b class="dim">${esc(String(LB.local.remote.savedAt || '').replace('T', ' ').slice(0, 16))}</b>
        from ${esc(LB.local.remote.device || 'unknown machine')}${LB.local.remote.encrypted ? ' · encrypted' : ''}</div>` : '')}

      <div class="sep"></div>
      <div class="tiny dim" style="line-height:1.6">You choose the folder in the operating system's own
      picker, and the browser hands the page access to that folder and nothing else. Backups use the
      same format as the OneDrive option, so either can restore the other's files — and if password
      protection is on, the payload is encrypted before it is written.</div>
    </div>
  </section>`;
}

function cloudCard() {
  const c = S.get().settings.cloud || {};
  const chip = cloud.status === 'idle'  ? 'ok'
             : cloud.status === 'error' ? 'risk'
             : cloud.status === 'saving' ? 'info' : '';
  return h`
  <section class="card">
    <header>${icon('cloud')}<h3>Automatic backup</h3>
      <div class="spacer" style="flex:1"></div>
      <span class="chip ${chip}">${cloudStatusText()}</span>
    </header>
    <div class="body">
      ${raw(!S.get().settings.graph.clientId ? `
        <div class="banner"><svg class="ico"><use href="#i-info"></use></svg>
          <div>This needs Microsoft 365 connected first — the card below. The backup goes to
          <b>your own OneDrive</b>, using the same sign-in.</div></div>` : '')}

      <p class="tiny">Writes a copy to OneDrive whenever your data changes: <span class="mono">gfx-latest.json</span>
      overwritten each time (OneDrive keeps its own version history), plus one dated snapshot per day.</p>

      <label class="row" style="gap:8px;margin:12px 0">
        <input type="checkbox" id="c_on" ${c.enabled ? 'checked' : ''} ${graph.connected ? '' : 'disabled'}>
        <span class="tiny"><b>Back up automatically</b>${graph.connected ? '' : ' — connect Microsoft 365 to enable'}</span>
      </label>

      <div class="grid g2">
        <label class="fld"><span>OneDrive folder</span>
          <input id="c_folder" value="${esc(c.folder || '')}" class="mono" placeholder="Apps/GFX Prod App">
          <span class="hint">Created if it does not exist.</span></label>
        <label class="fld"><span>Daily snapshots to keep</span>
          <input type="number" id="c_keep" value="${c.keep ?? 30}" min="0" max="365">
          <span class="hint">Older ones are deleted. 0 keeps them all.</span></label>
      </div>
      <label class="fld"><span>This machine is called</span>
        <input id="c_device" value="${esc(c.device || '')}" placeholder="${esc(deviceLabel())}">
        <span class="hint">Stamped on each backup so you can tell which machine wrote it.</span></label>

      <div class="row wrap">
        <button class="btn sm" data-act="cloud-save">Save settings</button>
        <button class="btn sm" data-act="cloud-now" ${graph.connected ? '' : 'disabled'}>${icon('up')}Back up now</button>
        <button class="btn sm" data-act="cloud-restore" ${graph.connected ? '' : 'disabled'}>${icon('down')}Restore from OneDrive…</button>
      </div>

      ${raw(cloud.lastError ? `<div class="banner risk" style="margin:12px 0 0">
        <svg class="ico"><use href="#i-warn"></use></svg>
        <div><b>Last attempt failed</b><div class="tiny mono">${esc(cloud.lastError)}</div></div></div>` : '')}

      ${raw(cloud.remote ? `<div class="sep"></div>
        <div class="tiny mute">Newest in OneDrive: <b class="dim">${esc(cloud.remote.savedAt?.replace('T', ' ').slice(0, 16) || '?')}</b>
        from ${esc(cloud.remote.device || 'unknown machine')}${cloud.remote.encrypted ? ' · encrypted' : ''}</div>` : '')}

      <div class="sep"></div>
      <div class="banner warn" style="margin:0">
        <svg class="ico"><use href="#i-warn"></use></svg>
        <div><b>It backs up, it does not sync.</b> Nothing is ever pulled down without you asking.
        That is deliberate: automatic two-way sync is how an older copy on one machine quietly
        overwrites a newer one on another. When a newer backup exists you get a banner offering it,
        and you decide.</div>
      </div>
    </div>
  </section>`;
}

function dataCard() {
  const s = S.get();
  const size = (() => { try { return new Blob([localStorage.getItem('gfxprod.state.v1') || '']).size; } catch { return 0; } })();
  return h`
  <section class="card">
    <header><h3>Data</h3><span class="sub">everything lives in this browser profile</span></header>
    <div class="body">
      <div class="grid g4" style="margin-bottom:14px">
        <div><div class="tiny mute">Tasks</div><div class="strong">${s.tasks.length}</div></div>
        <div><div class="tiny mute">People</div><div class="strong">${s.people.length}</div></div>
        <div><div class="tiny mute">Leave records</div><div class="strong">${s.leave.length}</div></div>
        <div><div class="tiny mute">Storage used</div><div class="strong">${(size / 1024).toFixed(0)} KB</div></div>
      </div>
      <div class="banner warn"><svg class="ico"><use href="#i-warn"></use></svg>
        <div><b>Browser storage is not a filing system.</b> Clearing site data, switching machine or a
        wiped profile takes all of this with it. Export a backup regularly — that file is the real copy.</div></div>
      <div class="row wrap" style="margin-top:12px">
        <button class="btn primary sm" data-act="export">${icon('down')}Export backup (JSON)</button>
        <button class="btn sm" data-act="import">${icon('up')}Restore from backup</button>
        <button class="btn sm" data-act="merge">Merge a backup in</button>
        <div class="spacer" style="flex:1"></div>
        <button class="btn sm" data-act="reseed">Reload sample data</button>
        <button class="btn sm danger" data-act="wipe">Clear all data</button>
      </div>
      <div class="tiny" style="margin-top:12px;color:${exportIsStale() ? 'var(--warn)' : 'var(--text-mute)'}">
        Last <b>backup file</b> saved:
        <b>${lastExportAt() ? new Date(lastExportAt()).toLocaleString() : 'never'}</b>${exportIsStale() ? ' — overdue' : ''}
        ${raw(lastExportAt() && paths().backups
          ? `<br>Archived to <span class="mono">${esc(paths().backups)}</span> by the logon sweep.`
          : lastExportAt() ? '<br>The logon sweep archives it — set the folder below to see where.' : '')}
      </div>
      <div class="hint" style="margin-top:8px">Browser state last written ${esc(new Date(s.meta.updated || Date.now()).toLocaleString())}
        · schema v${s.v} · ${teams.inTeams ? 'running inside Teams' : 'standalone browser'}
        ${raw(teams.inTeams ? ` · host theme <b>${esc(teams.theme)}</b>` : '')}</div>
    </div>
  </section>`;
}

function aboutCard() {
  return h`
  <section class="card">
    <header><h3>About</h3>
      <div class="spacer" style="flex:1"></div>
      <span class="chip mono" id="buildChip">build ${BUILD}</span></header>
    <div class="body tiny dim" style="line-height:1.7">
      <p><b>GFX Prod App</b> — a personal production console for an art producer running several
      projects and the people on them. No server, no database, no telemetry: a static page plus your
      browser's storage, with an optional signed-in connection to your own Microsoft 365.</p>

      <div class="row wrap" style="margin:12px 0">
        <button class="btn sm" data-act="check-update">${icon('refresh')}Check for updates</button>
        <span class="tiny" id="updateMsg"></span>
      </div>
      <p class="tiny mute" style="margin:0">The app is served with a ten-minute cache, so a tab can
      run code up to ten minutes old — and inside Teams there is no address bar to tell you. This
      button asks the server directly, past the cache.</p>

      <dl class="kv" style="margin-top:12px">
        <dt>Build</dt><dd class="mono">${BUILD}</dd>
        <dt>Changes</dt><dd>${BUILD_NOTES}</dd>
        <dt>Keyboard</dt><dd>Ctrl+K search · Ctrl+B sidebar · Ctrl+Z undo · Ctrl+L lock · Alt+1…9 jump</dd>
        <dt>Host</dt><dd>${teams.inTeams ? 'Microsoft Teams' : 'Browser'} · ${esc(location.host || 'local file')}</dd>
        <dt>Data</dt><dd>localStorage key <span class="mono">gfxprod.state.v1</span></dd>
      </dl>
    </div>
  </section>`;
}

/* ---------- restore from OneDrive --------------------------------------- */

/** Ask for a one-off password to open an encrypted backup. */
/**
 * Add or edit a Jira project.
 *
 * The key is the identity: task records store it, so like a division id it is
 * set once and never edited — changing it here would orphan every task already
 * queued or filed against the old one.
 */
async function editJiraProject(key) {
  const cur = key ? jiraProjects().find(p => p.key === key) : null;
  const res = await formDlg(cur ? `Edit ${cur.key}` : 'Add a Jira project', [
    { k: 'key', label: 'Project key', value: cur?.key || '', required: !cur, span: 4,
      hint: cur ? 'Cannot be changed — tasks refer to it.' : 'The prefix on every issue.' },
    { k: 'name', label: 'Name', value: cur?.name || '', span: 8,
      hint: 'Only for reading. Shown in the project picker.' },
    { k: 'issueType', label: 'Issue type', value: cur?.issueType || 'Task', span: 4,
      hint: 'What a task becomes.' },
    { k: 'component', label: 'Component', value: cur?.component || '', span: 8,
      hint: 'Added to every issue. Blank for none.' },
    { k: 'defaultParent', label: 'Default epic', value: cur?.defaultParent || '', span: 6,
      hint: 'Where GFX work hangs. The helper checks it really is an Epic.' },
    { k: 'defaultParentName', label: 'Epic name', value: cur?.defaultParentName || '', span: 6,
      hint: 'Shown beside the key so it is recognisable.' },
    { k: 'priorities', label: 'Priorities this project accepts', span: 12,
      value: (cur?.priorities || []).join(', '),
      hint: 'Comma separated, in Jira\'s own wording. Jira rejects a priority it does not have.' },
    { k: 'defaultPriority', label: 'Default priority', value: cur?.defaultPriority || '', span: 6,
      hint: 'Must be one of the above.' },
    { k: 'requiresParent', label: 'Parent epic', type: 'checkbox', span: 6,
      cbLabel: 'required by this project', value: !!cur?.requiresParent },
    { k: 'labelsRequired', label: 'Labels', type: 'checkbox', span: 6,
      cbLabel: 'at least one is required', value: !!cur?.labelsRequired },
  ], { ok: cur ? 'Save' : 'Add', wide: true });
  if (!res) return false;

  const priorities = String(res.priorities || '').split(/[,;]/).map(x => x.trim()).filter(Boolean);
  const patch = {
    name: res.name, issueType: String(res.issueType || 'Task').trim() || 'Task',
    component: String(res.component || '').trim(),
    defaultParent: String(res.defaultParent || '').trim().toUpperCase(),
    defaultParentName: String(res.defaultParentName || '').trim(),
    priorities,
    /* A default outside the list would fail validation on every task, so it
       falls back to the first accepted value rather than being taken on faith. */
    defaultPriority: priorities.includes(res.defaultPriority) ? res.defaultPriority : (priorities[0] || ''),
    requiresParent: !!res.requiresParent,
    labelsRequired: !!res.labelsRequired,
  };

  if (cur) {
    S.mutate(s => {
      const p = (s.jiraProjects || []).find(x => x.key === cur.key);
      if (p) Object.assign(p, patch);
    }, { label: 'Jira project' });
    toast(`${cur.key} saved`, 'ok');
    return true;
  }

  const newKey = String(res.key || '').trim().toUpperCase();
  if (!newKey) return toast('A project key is required.', 'err') && false;
  if (jiraProjects().some(p => p.key === newKey)) return toast(`${newKey} is already set up.`, 'err') && false;
  S.mutate(s => { (s.jiraProjects ||= []).push({ key: newKey, labelRules: [], ...patch }); },
           { label: 'add Jira project' });
  toast(`${newKey} added — tasks can now be queued for it`, 'ok', 5000);
  return true;
}

function askBackupPassword(why) {
  return dialog({
    title: 'This backup needs a password',
    body: `<p class="tiny mute">${esc(why)}</p>
      <label class="fld"><span>Password used when it was saved</span>
        <input type="password" id="bp" autocomplete="off"></label>
      <p class="hint">If that machine used a different password from this one, it is that
      machine's password you need.</p>`,
    footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-ok>Open it</button>`,
    onMount: ({ root, close }) => {
      root.querySelector('[data-no]').onclick = () => close(null);
      root.querySelector('[data-ok]').onclick = () => close(root.querySelector('#bp').value);
    },
  });
}

export async function restoreFromCloud(ctx) {
  let items;
  const t = toast('Reading the backup folder…', '', 25000);
  try { items = await listBackups(); }
  catch (e) { t.remove(); return toast('Could not read OneDrive: ' + e.message, 'err', 10000); }
  t.remove();

  if (!items.length)
    return toast('No backups in that OneDrive folder yet. Try "Back up now" first.', 'warn', 7000);

  const chosen = await dialog({
    title: 'Restore from OneDrive',
    wide: true,
    body: `<div class="banner warn"><svg class="ico"><use href="#i-warn"></use></svg>
        <div><b>Restoring replaces everything currently in this browser.</b>
        Export a local backup first if there is any doubt about which copy is newer.</div></div>
      <div class="tbl-wrap" style="max-height:46vh;margin-top:12px">
        <table class="tbl"><thead><tr><th>File</th><th>Saved</th><th class="num">Size</th><th></th></tr></thead>
        <tbody>${items.map((i, n) => `<tr>
          <td class="mono tiny">${esc(i.name)}${i.name === 'gfx-latest.json' ? ' <span class="chip accent">newest</span>' : ''}</td>
          <td class="tiny">${esc(String(i.lastModifiedDateTime || '').replace('T', ' ').slice(0, 16))}</td>
          <td class="num tiny">${esc(fmtBytesLocal(i.size))}</td>
          <td class="act"><button class="btn sm" data-pick="${n}">Restore this</button></td>
        </tr>`).join('')}</tbody></table>
      </div>`,
    footer: `<button class="btn" data-no>Cancel</button>`,
    onMount: ({ root, close }) => {
      root.querySelector('[data-no]').onclick = () => close(null);
      root.addEventListener('click', e => {
        const b = e.target.closest('[data-pick]');
        if (b) close(items[+b.dataset.pick]);
      });
    },
  });
  if (!chosen) return;

  const t2 = toast('Downloading ' + chosen.name + '…', '', 30000);
  let text;
  try { text = await fetchBackupText(chosen); }
  catch (e) { t2.remove(); return toast('Download failed: ' + e.message, 'err', 9000); }
  t2.remove();

  let inner;
  try { inner = await openPayload(text, askBackupPassword); }
  catch (e) { return toast(e.message, 'err', 9000); }
  if (!inner) return;                       // cancelled at the password prompt

  // show what is in it before committing
  let summary = '';
  try {
    const st = (JSON.parse(inner).state) || JSON.parse(inner);
    summary = `${(st.people || []).length} people · ${(st.tasks || []).length} tasks · ` +
              `${(st.projects || []).length} projects · ${(st.leave || []).length} leave records`;
  } catch { return toast('That backup could not be parsed.', 'err', 8000); }

  if (!await confirmDlg(
      `Replace everything in this browser with ${chosen.name}?\n\nIt contains: ${summary}`,
      { title: 'Confirm restore', ok: 'Replace my data' })) return;

  try {
    S.importJson(inner, { merge: false });
    applyPrefs();
    toast('Restored from OneDrive', 'ok', 5000);
    ctx.rerender();
  } catch (e) { toast('Restore failed: ' + e.message, 'err', 9000); }
}

/** Restore a backup the bridge can see on disk. */
export async function restoreFromBridge(ctx) {
  let files;
  try { files = await BR.list(); }
  catch (e) { return toast('Could not list backups: ' + e.message, 'err', 9000); }
  if (!files.length) return toast('No backups in the bridge folder yet. Try "Back up now".', 'warn', 6000);

  const chosen = await dialog({
    title: 'Restore via the bridge',
    wide: true,
    body: `<div class="banner warn"><svg class="ico"><use href="#i-warn"></use></svg>
        <div><b>Restoring replaces everything currently in this browser.</b>
        Check the dates — the newest file is not automatically the one you want.</div></div>
      <div class="tiny mute" style="margin:10px 0 4px">Reading from <span class="mono">${esc(BR.bridge.folder || '')}</span></div>
      <div class="tbl-wrap" style="max-height:44vh">
        <table class="tbl"><thead><tr><th>File</th><th>Modified</th><th class="num">Size</th><th></th></tr></thead>
        <tbody>${files.map((f, n) => `<tr>
          <td class="mono tiny">${esc(f.name)}${f.name === 'gfx-latest.json' ? ' <span class="chip accent">newest</span>' : ''}</td>
          <td class="tiny">${esc(String(f.modified || '').replace('T', ' ').slice(0, 16))}</td>
          <td class="num tiny">${esc(fmtBytesLocal(f.size))}</td>
          <td class="act"><button class="btn sm" data-pick="${n}">Restore this</button></td>
        </tr>`).join('')}</tbody></table></div>`,
    footer: `<button class="btn" data-no>Cancel</button>`,
    onMount: ({ root, close }) => {
      root.querySelector('[data-no]').onclick = () => close(null);
      root.addEventListener('click', e => {
        const b = e.target.closest('[data-pick]');
        if (b) close(files[+b.dataset.pick]);
      });
    },
  });
  if (!chosen) return;

  let text;
  try { text = await BR.fetchFile(chosen.name); }
  catch (e) { return toast('Could not read it: ' + e.message, 'err', 9000); }

  let inner;
  try { inner = await BR.openPayload(text, askBackupPassword); }
  catch (e) { return toast(e.message, 'err', 9000); }
  if (!inner) return;

  let summary = '';
  try {
    const st = (JSON.parse(inner).state) || JSON.parse(inner);
    summary = `${(st.people || []).length} people · ${(st.tasks || []).length} tasks · ` +
              `${(st.projects || []).length} projects · ${(st.leave || []).length} leave records`;
  } catch { return toast('That backup could not be parsed.', 'err', 8000); }

  if (!await confirmDlg(`Replace everything in this browser with ${chosen.name}?\n\nIt contains: ${summary}`,
                        { title: 'Confirm restore', ok: 'Replace my data' })) return;
  try {
    S.importJson(inner, { merge: false });
    applyPrefs();
    toast('Restored', 'ok', 5000);
    ctx.rerender();
  } catch (e) { toast('Restore failed: ' + e.message, 'err', 9000); }
}

/** Same flow as the OneDrive restore, reading from the chosen folder. */
export async function restoreFromFolder(ctx) {
  let items;
  try { items = await LB.listBackups(); }
  catch (e) { return toast(e.message, 'err', 9000); }
  if (!items.length) return toast('No backups in that folder yet. Try "Save now" first.', 'warn', 6000);

  const chosen = await dialog({
    title: 'Restore from folder',
    wide: true,
    body: `<div class="banner warn"><svg class="ico"><use href="#i-warn"></use></svg>
        <div><b>Restoring replaces everything currently in this browser.</b>
        Check the dates below — the newest file is not automatically the one you want.</div></div>
      <div class="tbl-wrap" style="max-height:46vh;margin-top:12px">
        <table class="tbl"><thead><tr><th>File</th><th>Modified</th><th class="num">Size</th><th></th></tr></thead>
        <tbody>${items.map((i, n) => `<tr>
          <td class="mono tiny">${esc(i.name)}${i.name === 'gfx-latest.json' ? ' <span class="chip accent">newest</span>' : ''}</td>
          <td class="tiny">${esc(new Date(i.lastModified).toLocaleString())}</td>
          <td class="num tiny">${esc(fmtBytesLocal(i.size))}</td>
          <td class="act"><button class="btn sm" data-pick="${n}">Restore this</button></td>
        </tr>`).join('')}</tbody></table></div>`,
    footer: `<button class="btn" data-no>Cancel</button>`,
    onMount: ({ root, close }) => {
      root.querySelector('[data-no]').onclick = () => close(null);
      root.addEventListener('click', e => {
        const b = e.target.closest('[data-pick]');
        if (b) close(items[+b.dataset.pick]);
      });
    },
  });
  if (!chosen) return;

  let text;
  try { text = await LB.readBackup(chosen); }
  catch (e) { return toast('Could not read that file: ' + e.message, 'err', 9000); }

  let inner;
  try { inner = await LB.openPayload(text, askBackupPassword); }
  catch (e) { return toast(e.message, 'err', 9000); }
  if (!inner) return;

  let summary = '';
  try {
    const st = (JSON.parse(inner).state) || JSON.parse(inner);
    summary = `${(st.people || []).length} people · ${(st.tasks || []).length} tasks · ` +
              `${(st.projects || []).length} projects · ${(st.leave || []).length} leave records`;
  } catch { return toast('That backup could not be parsed.', 'err', 8000); }

  if (!await confirmDlg(`Replace everything in this browser with ${chosen.name}?\n\nIt contains: ${summary}`,
                        { title: 'Confirm restore', ok: 'Replace my data' })) return;
  try {
    S.importJson(inner, { merge: false });
    applyPrefs();
    toast('Restored from folder', 'ok', 5000);
    ctx.rerender();
  } catch (e) { toast('Restore failed: ' + e.message, 'err', 9000); }
}

const fmtBytesLocal = n =>
  n == null ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

/* ---------- password dialog ---------------------------------------------- */

/**
 * One dialog for set / change. Returns the new password (or {old, pw} when
 * askOld), or undefined if cancelled.
 */
function passwordDialog({ title, intro = '', confirm = false, askOld = false,
                          requireBackup = false, ok = 'Save' }) {
  return dialog({
    title,
    body: `${intro}
      ${askOld ? `<label class="fld"><span>Current password</span>
        <input type="password" id="pw_old" autocomplete="current-password"></label>` : ''}
      <label class="fld" style="margin-bottom:6px"><span>New password</span>
        <input type="password" id="pw_new" autocomplete="new-password"></label>
      <div class="pw-meter" id="pw_meter"><i></i><i></i><i></i><i></i><i></i></div>
      <div class="tiny mute" id="pw_hint" style="min-height:32px;margin:5px 0 12px">
        A passphrase of three or four unrelated words beats a short, clever one.</div>
      ${confirm ? `<label class="fld"><span>Type it again</span>
        <input type="password" id="pw_two" autocomplete="new-password"></label>` : ''}
      <div class="tiny" id="pw_err" style="color:var(--risk);min-height:17px"></div>`,
    footer: `<button class="btn" data-no>Cancel</button>
             <button class="btn primary" data-ok ${requireBackup ? 'disabled' : ''}>${esc(ok)}</button>`,
    onMount: ({ root, close }) => {
      const q = id => root.querySelector('#pw_' + id);
      const okBtn = root.querySelector('[data-ok]');
      let backedUp = !requireBackup;

      root.querySelector('[data-backup]')?.addEventListener('click', () => {
        download(`gfx-prod-app-backup-${today()}.json`, S.exportJson(), 'application/json');
        backedUp = true;
        okBtn.disabled = false;
        toast('Backup downloaded — keep it somewhere you will find it', 'ok', 5000);
      });

      q('new').addEventListener('input', () => {
        const s = lock.strength(q('new').value);
        [...q('meter').children].forEach((el, i) => {
          el.className = i < s.score ? 'on' + s.score : '';
        });
        q('hint').textContent = q('new').value
          ? `${s.label}${s.hint ? ' — ' + s.hint : ''}`
          : 'A passphrase of three or four unrelated words beats a short, clever one.';
      });

      root.querySelector('[data-no]').onclick = () => close(undefined);
      okBtn.onclick = () => {
        const pw = q('new').value;
        const err = m => { q('err').textContent = m; return null; };
        q('err').textContent = '';
        if (!backedUp) return err('Export a backup first — the button above.');
        if (!pw) return err('Enter a password.');
        if (lock.strength(pw).score < 2) return err('Too weak. Twelve characters or more, please.');
        if (confirm && pw !== q('two').value) return err('The two entries do not match.');
        if (askOld && !q('old').value) return err('Enter your current password.');
        close(askOld ? { old: q('old').value, pw } : pw);
      };
    },
  });
}

/* ---------- view --------------------------------------------------------- */

export default {
  id: 'settings', title: 'Settings', icon: 'cog', group: 'system',
  subtitle: 'Profile, appearance, org setup and data',

  actions: () => [],

  render(host, ctx) {
    const tab = tabOf(ctx.params[0]);
    const meta = TABS.find(t => t.id === tab);
    ctx.setCrumb(meta.label);

    const tabsBar = h`<div class="ptabs">${raw(TABS.map(t =>
      `<button class="ptab${t.id === tab ? ' on' : ''}" data-act="tab" data-t="${t.id}"
         title="${esc(t.sub)}">${esc(t.label)}</button>`).join(''))}</div>`;

    /* Two columns where there is enough to balance, one where a single card
       would otherwise sit next to dead space. */
    const two = (left, right) => h`
      <div class="grid" style="grid-template-columns:1fr 1fr;align-items:start;gap:14px">
        <div class="col" style="gap:14px">${raw(left.join(''))}</div>
        <div class="col" style="gap:14px">${raw(right.join(''))}</div>
      </div>`;
    const one = cards => h`<div class="col" style="gap:14px;max-width:820px">${raw(cards.join(''))}</div>`;

    const PANES = {
      you:      () => two([profileCard()], [appearanceCard()]),
      org:      () => two([divisionsCard(), rateCardSection()], [workCard(), linksCard()]),
      connect:  () => two([graphCard(), foldersCard()], [jiraCard(), bridgeCard()]),
      backup:   () => two([folderCard(), dataCard()], [cloudCard()]),
      security: () => one([securityCard()]),
      about:    () => one([aboutCard()]),
    };

    host.innerHTML = tabsBar + `<div class="tiny mute" style="margin:-4px 0 12px">${esc(meta.sub)}</div>`
      + PANES[tab]();

    const setPref = (patch, redraw = true) => {
      S.mutate(s => Object.assign(s.prefs, patch), { noUndo: true, silent: true });
      applyPrefs();
      if (redraw) ctx.rerender();
    };

    acts(host, {
      tab: el => ctx.go('settings', el.dataset.t),

      /* profile */
      'save-profile': () => {
        const g = k => host.querySelector('#p_' + k).value.trim();
        S.mutate(s => Object.assign(s.profile, { name: g('name'), title: g('title'), email: g('email'), timezone: g('tz') }),
                 { label: 'profile' });
        applyPrefs(); toast('Profile saved', 'ok'); ctx.rerender();
      },

      /* appearance */
      theme: el => setPref({ theme: el.dataset.v }),
      accent: el => setPref({ accent: el.dataset.v }),
      density: el => setPref({ density: el.dataset.v }),
      widget: el => {
        const v = el.dataset.v;
        const cur = S.get().prefs.widgets;
        setPref({ widgets: cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v] });
      },
      navtoggle: el => {
        const v = el.dataset.v;
        const cur = S.get().prefs.navHidden || [];
        setPref({ navHidden: cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v] });
      },
      wd: el => {
        const v = +el.dataset.v;
        const cur = S.get().prefs.workingDays || [];
        setPref({ workingDays: cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v].sort() });
      },
      /* Landing page, currency code and symbol — on the You tab, saved as
         they change. They used to ride along with Save assumptions, which now
         lives on a different tab. */
      'view-pref': () => {
        const cur = host.querySelector('#p_cur')?.value.trim() || 'USD';
        const symv = host.querySelector('#p_sym')?.value.trim() || '$';
        const landing = host.querySelector('#p_landing')?.value || 'dashboard';
        S.mutate(s => {
          s.settings.currencySymbol = symv;
          s.prefs.currency = cur; s.prefs.landing = landing;
        }, { label: 'view preferences' });
        applyPrefs(); toast('Saved', 'ok', 2500);
      },

      'save-work': () => {
        const hpd = +host.querySelector('#w_hpd').value || 8;
        const util = +host.querySelector('#w_util').value || 85;
        const fy = +host.querySelector('#w_fy').value || 1;
        S.mutate(s => {
          s.settings.hoursPerDay = hpd; s.settings.utilisationTarget = util;
          s.prefs.fiscalStart = fy;
        }, { label: 'working assumptions' });
        toast('Saved', 'ok'); ctx.rerender();
      },

      /* divisions */
      'div-add': async () => {
        const v = await formDlg('New division', [
          { k: 'id', label: 'Short code', required: true, span: 5, hint: 'e.g. TECH' },
          { k: 'name', label: 'Name', required: true, span: 7 },
          { k: 'color', label: 'Colour', type: 'color', value: '#4C9AFF', span: 5 },
          { k: 'jiraLabel', label: 'Jira label', span: 7, hint: 'Blank adds no label. No spaces.' },
        ]);
        if (!v) return;
        if (S.get().divisions.some(d => d.id.toUpperCase() === v.id.toUpperCase())) return toast('That code is already used', 'warn');
        const jiraLabel = String(v.jiraLabel || '').trim().replace(/\s+/g, '-');
        S.mutate(s => s.divisions.push({ id: v.id.toUpperCase(), name: v.name, color: v.color, jiraLabel }),
                 { label: 'add division' });
        ctx.rerender();
      },
      /* Normalised on the way in: Jira rejects a label with a space, and the
         useful place to learn that is here, not in a push log. */
      'div-label': el => {
        const id = el.closest('[data-d]').dataset.d;
        const v = el.value.trim().replace(/\s+/g, '-');
        el.value = v;
        S.mutate(s => { s.divisions.find(d => d.id === id).jiraLabel = v; }, { label: 'division Jira label' });
        toast(v ? `${id} files as ${v}` : `${id} adds no Jira label`, 'ok', 3500);
      },
      'div-colour': el => {
        const id = el.closest('[data-d]').dataset.d;
        S.mutate(s => { s.divisions.find(d => d.id === id).color = el.value; }, { noUndo: true, silent: true });
      },
      'div-del': async el => {
        const id = el.closest('[data-d]').dataset.d;
        const n = S.get().people.filter(p => p.division === id).length;
        if (!await confirmDlg(n ? `${n} people are in ${id}. Removing the division leaves them without one — carry on?`
                                : `Remove division ${id}?`, { ok: 'Remove' })) return;
        S.mutate(s => { s.divisions = s.divisions.filter(d => d.id !== id); }, { label: 'remove division' });
        ctx.rerender();
      },

      /* --- Jira projects --- */
      'jp-add':  () => editJiraProject(null).then(r => r && ctx.rerender()),
      'jp-edit': el => editJiraProject(el.closest('[data-jp]').dataset.jp).then(r => r && ctx.rerender()),
      'jp-del':  async el => {
        const key = el.closest('[data-jp]').dataset.jp;
        const used = S.get().projects.filter(p => p.jiraKey === key).map(p => p.code);
        if (!await confirmDlg(
          `Remove the Jira project ${key}?` +
          (used.length ? `\n\n${used.join(', ')} ${used.length === 1 ? 'is' : 'are'} filed against it — ` +
            `those projects keep the key, and tasks will not queue until it is set up again.` : '') +
          `\n\nNothing in Jira is touched.`,
          { ok: 'Remove', title: 'Remove Jira project' })) return;
        S.mutate(s => { s.jiraProjects = (s.jiraProjects || []).filter(p => p.key !== key); },
                 { label: 'remove Jira project' });
        ctx.rerender();
      },

      /* --- folders on this machine --- */
      paths: el => {
        const k = el.dataset.k;
        const v = el.value.trim();
        S.mutate(s => { (s.settings.paths ||= {})[k] = v; }, { label: 'folder paths' });
        toast(v ? 'Saved' : 'Cleared', 'ok', 2500);
      },

      /* rate card */
      rate: el => {
        const id = el.closest('[data-r]').dataset.r;
        S.mutate(s => { s.rateCard.find(r => r.id === id).monthly = +el.value || 0; }, { noUndo: true, silent: true });
      },

      /* links */
      'link-add': () => {
        S.mutate(s => s.settings.workspaceLinks.push({ id: S.uid('wl'), label: 'New link', url: '' }), { label: 'add link' });
        ctx.rerender();
      },
      'link-label': el => { const id = el.closest('[data-l]').dataset.l;
        S.mutate(s => { s.settings.workspaceLinks.find(l => l.id === id).label = el.value; }, { noUndo: true, silent: true }); },
      'link-url': el => { const id = el.closest('[data-l]').dataset.l;
        S.mutate(s => { s.settings.workspaceLinks.find(l => l.id === id).url = el.value; }, { noUndo: true, silent: true }); },
      'link-del': el => {
        const id = el.closest('[data-l]').dataset.l;
        S.mutate(s => { s.settings.workspaceLinks = s.settings.workspaceLinks.filter(l => l.id !== id); }, { label: 'remove link' });
        ctx.rerender();
      },

      /* security */
      'pw-on': async () => {
        const pw = await passwordDialog({
          title: 'Set a password',
          intro: `<div class="banner warn"><svg class="ico"><use href="#i-warn"></use></svg>
            <div><b>Read this before you continue.</b>
            There is no way to recover the data if you forget this password — the key is derived
            from it and never stored. Export a backup first; the button below does it for you.</div></div>
            <button type="button" class="btn sm" data-backup style="margin-bottom:14px">
              <svg class="ico"><use href="#i-down"></use></svg>Export a backup now</button>`,
          confirm: true, requireBackup: true, ok: 'Encrypt my data',
        });
        if (!pw) return;
        try {
          await S.enableLock(pw);
          toast('Protection on — your data is now encrypted', 'ok', 5000);
          window.dispatchEvent(new Event('gfx:autolock-changed'));
          ctx.rerender();
        } catch (e) { toast('Could not enable it: ' + e.message, 'err', 9000); }
      },
      'pw-change': async () => {
        const res = await passwordDialog({ title: 'Change password', confirm: true, askOld: true, ok: 'Change it' });
        if (!res) return;
        try {
          await S.changeLock(res.old, res.pw);
          toast('Password changed', 'ok');
          ctx.rerender();
        } catch (e) { toast(e.message, 'err', 8000); }
      },
      'pw-off': async () => {
        if (!await confirmDlg(
          'Turn protection off? Your data goes back to being stored as plain text, readable by ' +
          'anyone who can use this browser profile.',
          { title: 'Turn off protection', ok: 'Turn it off' })) return;
        try { await S.disableLock(); toast('Protection off — data is stored as plain text again', 'warn', 6000); ctx.rerender(); }
        catch (e) { toast(e.message, 'err', 8000); }
      },
      'pw-lock': () => lockNow(),
      autolock: el => {
        S.mutate(s => { s.settings.autoLockMinutes = +el.value; }, { label: 'auto-lock' });
        window.dispatchEvent(new Event('gfx:autolock-changed'));
        ctx.rerender();
      },

      /* about */
      'check-update': async el => {
        const msg = host.querySelector('#updateMsg');
        msg.textContent = 'checking…'; msg.className = 'tiny mute';
        try {
          const r = await checkForUpdate();
          if (r.upToDate) {
            msg.textContent = 'Up to date (' + r.latest + ')';
            msg.className = 'tiny';
            msg.style.color = 'var(--ok)';
          } else {
            msg.innerHTML = '';
            const s1 = document.createElement('span');
            s1.textContent = 'Newer build available: ' + r.latest + ' — you are running ' + r.current + '. ';
            s1.style.color = 'var(--warn)';
            const b = document.createElement('button');
            b.className = 'btn sm primary'; b.textContent = 'Reload now';
            b.onclick = () => hardReload();
            msg.appendChild(s1); msg.appendChild(b);
          }
        } catch (e) {
          msg.textContent = e.message; msg.className = 'tiny'; msg.style.color = 'var(--risk)';
        }
      },

      /* local bridge */
      'br-save': () => {
        const url = host.querySelector('#br_url').value.trim().replace(/\/+$/, '');
        const token = host.querySelector('#br_token').value.trim();
        const on = host.querySelector('#br_on').checked;
        S.mutate(s => Object.assign(s.settings.bridge ||= {}, { url, token, enabled: on }), { label: 'bridge config' });
        toast('Bridge settings saved', 'ok');
        BR.probe().finally(() => ctx.rerender());
      },
      'br-test': async () => {
        const ok = await BR.probe();
        toast(ok ? 'Bridge is running' + (BR.bridge.folder ? ' — writing to ' + BR.bridge.folder : '')
                 : 'Could not reach it: ' + BR.bridge.lastError, ok ? 'ok' : 'err', ok ? 4000 : 9000);
        ctx.rerender();
      },
      'br-now': async () => {
        const t = toast('Sending the backup to the bridge…', '', 20000);
        const r = await BR.backupNow({ manual: true });
        t.remove();
        toast(r ? 'Written: ' + (r.written || []).join(' + ') : 'Failed: ' + BR.bridge.lastError,
              r ? 'ok' : 'err', r ? 4000 : 9000);
        ctx.rerender();
      },
      'br-handoff': async () => {
        try {
          await BR.handoff();
          toast('SharePoint and Explorer opening — drag the selected file in', 'ok', 6000);
        } catch (e) { toast('Could not start the hand-off: ' + e.message, 'err', 9000); }
      },
      'br-restore': () => restoreFromBridge(ctx),

      /* folder backup (File System Access) */
      'fb-pick': async () => {
        try {
          const name = await LB.chooseFolder();
          toast(`Backing up to “${name}”`, 'ok', 5000);
        } catch (e) {
          // an aborted OS picker is a decision, not a failure
          if (e.name !== 'AbortError') toast(e.message, 'err', 9000);
        }
        ctx.rerender();
      },
      'fb-now': async () => {
        const keep = +host.querySelector('#fb_keep')?.value;
        if (!isNaN(keep)) S.mutate(s => { (s.settings.localBackup ||= {}).keep = Math.max(0, keep); }, { noUndo: true, silent: true });
        const t = toast('Writing the backup…', '', 20000);
        const ok = await LB.backupNow({ manual: true });
        t.remove();
        toast(ok ? 'Backup written' : 'Failed: ' + (LB.local.lastError || 'see the card'), ok ? 'ok' : 'err', ok ? 3000 : 9000);
        ctx.rerender();
      },
      'fb-reconnect': async () => {
        const ok = await LB.reconnect();
        toast(ok ? 'Folder reconnected' : 'Permission was not granted', ok ? 'ok' : 'warn');
        ctx.rerender();
      },
      'fb-forget': async () => {
        if (!await confirmDlg('Stop backing up to that folder? The files already written stay where they are.',
                              { title: 'Stop folder backup', ok: 'Stop' })) return;
        await LB.forgetFolder();
        toast('Folder backup stopped', 'ok');
        ctx.rerender();
      },
      'fb-restore': () => restoreFromFolder(ctx),

      /* cloud backup */
      'cloud-save': () => {
        const folder = host.querySelector('#c_folder').value.trim() || 'Apps/GFX Prod App';
        const keep = Math.max(0, +host.querySelector('#c_keep').value || 0);
        const device = host.querySelector('#c_device').value.trim();
        const enabled = host.querySelector('#c_on').checked;
        S.mutate(s => Object.assign(s.settings.cloud, { folder, keep, device, enabled }), { label: 'backup settings' });
        toast(enabled ? 'Automatic backup on' : 'Automatic backup off', 'ok');
        if (enabled) checkRemote().finally(() => ctx.rerender()); else ctx.rerender();
      },
      'cloud-now': async () => {
        const t = toast('Backing up to OneDrive…', '', 40000);
        const ok = await backupNow({ manual: true });
        t.remove();
        toast(ok ? 'Backed up to OneDrive' : 'Backup failed: ' + (cloud.lastError || 'see the card'), ok ? 'ok' : 'err', ok ? 3000 : 10000);
        ctx.rerender();
      },
      'cloud-restore': () => restoreFromCloud(ctx),

      /* graph */
      'copy-redirect': () => { navigator.clipboard.writeText(new URL('auth-end.html', location.href).href); toast('Copied', 'ok'); },
      'copy-scopes': () => {
        const caps = S.get().settings.graph.caps || DEFAULT_CAPS;
        navigator.clipboard.writeText(allScopes({ caps }).join(' '));
        toast('Scope list copied', 'ok');
      },
      cap: el => {
        const id = el.dataset.cap;
        S.mutate(s => { (s.settings.graph.caps ||= { ...DEFAULT_CAPS })[id] = el.checked; },
                 { noUndo: true, silent: true });
        ctx.rerender();
      },
      'graph-save': () => {
        const clientId = host.querySelector('#g_client').value.trim();
        const tenantId = host.querySelector('#g_tenant').value.trim() || 'common';
        const autoConnect = host.querySelector('#g_auto').checked;
        S.mutate(s => Object.assign(s.settings.graph, { clientId, tenantId, autoConnect, enabled: !!clientId }), { label: 'graph config' });
        initGraph({ clientId, tenantId }).then(() => ctx.rerender()).catch(e => toast(e.message, 'err', 8000));
        toast('Microsoft 365 settings saved', 'ok');
      },
      'graph-connect': async () => {
        const cfg = S.get().settings.graph;
        const t = toast('Opening the Microsoft sign-in window…', '', 40000);
        try {
          const me = await graphConnect(cfg);
          t.remove();
          toast(`Connected as ${me.displayName}`, 'ok');
          if (!S.get().profile.email) S.mutate(s => { s.profile.email = me.mail || me.userPrincipalName || ''; }, { noUndo: true, silent: true });
          ctx.rerender();
        } catch (e) { t.remove(); toast('Could not connect: ' + e.message, 'err', 12000); }
      },
      'graph-out': async () => { await graphDisconnect(); toast('Signed out of Microsoft 365', 'ok'); ctx.rerender(); },

      /* data */
      export: () => {
        const name = saveBackupFile();
        toast('Saved ' + name + ' to your Downloads folder', 'ok', 5000);
        ctx.rerender();
      },
      import: async () => {
        const f = await pickFile('.json');
        if (!f) return;
        if (!await confirmDlg(`Replace everything with the contents of ${f.name}? Your current data is overwritten.`,
                              { title: 'Restore backup', ok: 'Replace' })) return;
        try { S.importJson(f.text, { merge: false }); applyPrefs(); toast('Backup restored', 'ok'); ctx.rerender(); }
        catch (e) { toast('That file could not be read: ' + e.message, 'err', 9000); }
      },
      merge: async () => {
        const f = await pickFile('.json');
        if (!f) return;
        try { S.importJson(f.text, { merge: true }); toast('Merged — nothing was overwritten', 'ok'); ctx.rerender(); }
        catch (e) { toast('That file could not be read: ' + e.message, 'err', 9000); }
      },
      reseed: async () => {
        if (!await confirmDlg('Replace everything with the sample dataset again?', { title: 'Reload samples', ok: 'Reload' })) return;
        S.resetToSeed(); applyPrefs(); toast('Sample data reloaded', 'ok'); ctx.rerender();
      },
      wipe: async () => {
        const typed = await dialog({
          title: 'Clear all data',
          body: `<div class="banner risk"><svg class="ico"><use href="#i-warn"></use></svg>
            <div><b>This cannot be undone.</b> Tasks, people, leave, budgets and notes are all removed.
            Export a backup first if there is any doubt.</div></div>
            <label class="fld" style="margin-top:12px"><span>Type <b>DELETE</b> to confirm</span>
              <input id="wipe_c" placeholder="DELETE"></label>`,
          footer: `<button class="btn" data-no>Cancel</button><button class="btn danger" data-ok>Clear everything</button>`,
          onMount: ({ root, close }) => {
            root.querySelector('[data-no]').onclick = () => close();
            root.querySelector('[data-ok]').onclick = () => close(root.querySelector('#wipe_c').value);
          },
        });
        if (typed !== 'DELETE') return typed !== undefined && toast('Not confirmed — nothing was deleted', '', 3000);
        S.wipe(); applyPrefs(); toast('All data cleared', 'ok'); ctx.rerender();
      },
    });

    host.querySelector('#accentPick')?.addEventListener('input', e => setPref({ accent: e.target.value }, false));
    host.querySelector('#accentPick')?.addEventListener('change', () => ctx.rerender());
  },
};
