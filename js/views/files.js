/* ============================================================================
   views/files.js — SharePoint and OneDrive: browse, preview, edit in place.

   What "direct file change" means here, honestly:

     • text-shaped files (.md .txt .csv .json .xml .html …) are fetched,
       edited in the app and written straight back with a PUT — SharePoint
       keeps a new version, so the old one is recoverable.
     • Office files open in an embedded Office-for-the-web *editing* surface,
       which is the real editor, saving to the real file.
     • images and PDFs preview only.

   Nothing here works without a Microsoft Entra (Azure AD) app registration —
   see Settings → Microsoft 365, and docs/AZURE-AD.md in the repository.
   ========================================================================= */

import * as S from '../store.js';
import {
  h, raw, esc, icon, toast, dialog, formDlg, confirmDlg, menu, acts, $, $$,
  fmtDate, today, download, pickFile, clamp,
} from '../ui.js';
import * as G from '../graph.js';
import { graph } from '../graph.js';
import { openExternal, shareLink } from '../teams.js';

/* module-level browsing state, so switching views and coming back keeps place */
const nav = {
  source: null,            // {kind:'onedrive'|'site', id, name, driveId}
  driveId: null,
  itemId: 'root',
  crumbs: [],              // [{id, name}]
  items: [],
  selected: null,
  editing: null,           // {itemId, name, text, original, mime}
  loading: false,
  error: null,
  search: '',
};

let hostEl = null, ctxRef = null;

/* ---------- shell states ------------------------------------------------- */

function notConfigured() {
  const links = S.get().settings.workspaceLinks.filter(l => l.url);
  return h`
  <div class="grid" style="grid-template-columns:1.3fr 1fr">
    <section class="card">
      <header><h3>Connect SharePoint</h3></header>
      <div class="body">
        <p>This view reads and writes your real SharePoint and OneDrive files through Microsoft Graph.
        To let it do that, your tenant needs an <b>app registration</b> — a one-off, five-minute job in the
        Azure portal, or a ticket to whoever runs Microsoft 365 at your studio.</p>
        <ol style="padding-left:20px;line-height:1.8">
          <li>Open <b>portal.azure.com</b> → Microsoft Entra ID → <b>App registrations</b> → New registration.</li>
          <li>Name it <span class="mono">GFX Prod App</span>, accounts in <b>this organisational directory only</b>.</li>
          <li>Redirect URI: <b>Single-page application (SPA)</b> →
            <span class="mono">${esc(new URL('auth-end.html', location.href).href)}</span></li>
          <li>API permissions → Microsoft Graph → <b>Delegated</b> →
            <span class="mono">User.Read</span>, <span class="mono">Files.ReadWrite.All</span>,
            <span class="mono">Sites.ReadWrite.All</span>. Grant admin consent.</li>
          <li>Copy the <b>Application (client) ID</b> and the <b>Directory (tenant) ID</b> into
            Settings → Microsoft 365.</li>
        </ol>
        <p class="tiny mute">The app only ever asks for <i>delegated</i> permission — it can see exactly what
        you can see when you sign in, and nothing more. There is no background service and no stored password.</p>
        <button class="btn primary" data-act="settings">${icon('cog')}Open Microsoft 365 settings</button>
      </div>
    </section>
    <section class="card">
      <header><h3>Quick links</h3><span class="sub">works without any of the above</span></header>
      <div class="body">
        <p class="tiny mute">Until Graph is wired up, keep your SharePoint folders one click away.
        Add them in Settings → Workspace links, or put a SharePoint URL on each project.</p>
        ${raw(links.map(l => `<div class="fitem" data-act="link" data-u="${esc(l.url)}">
            <svg class="ico"><use href="#i-link"></use></svg>
            <span class="nm">${esc(l.label)}</span><span class="sz">open →</span></div>`).join('')
          || '<div class="tiny mute">No links saved yet.</div>')}
        ${raw(S.get().projects.filter(p => p.sharepointUrl).map(p => `
          <div class="fitem" data-act="link" data-u="${esc(p.sharepointUrl)}">
            <svg class="ico"><use href="#i-folder"></use></svg>
            <span class="nm">${esc(p.name)}</span><span class="sz">SharePoint →</span></div>`).join(''))}
      </div>
    </section>
  </div>`;
}

function notConnected() {
  return h`
  <div class="card" style="max-width:620px;margin:40px auto">
    <div class="body" style="text-align:center;padding:34px">
      ${icon('cloud', 'ico')}
      <h3 style="margin:10px 0 6px">Sign in to Microsoft 365</h3>
      <p class="tiny mute" style="max-width:44ch;margin:0 auto 16px">
        A popup will ask for your work account. The app then sees the same SharePoint and OneDrive
        files you can see in the browser — nothing more, nothing less.</p>
      <button class="btn primary" data-act="connect">${icon('cloud')}Connect</button>
      <div class="hint" style="margin-top:12px">Signed-out state · client ID ends
        <span class="mono">…${esc(String(S.get().settings.graph.clientId).slice(-6))}</span></div>
    </div>
  </div>`;
}

/* ---------- browser ------------------------------------------------------ */

function sourcePane(sources) {
  const s = S.get();
  return h`
  <section class="card pane">
    <header><h3>Places</h3>
      <div class="spacer" style="flex:1"></div>
      <button class="btn icon sm subtle" data-act="reload" title="Refresh"><svg class="ico"><use href="#i-refresh"></use></svg></button>
    </header>
    <div class="body" style="padding:8px">
      <div class="nav-group" style="padding:6px 8px 3px">Microsoft 365</div>
      ${raw(sources.map(src => `
        <div class="fitem${nav.source?.key === src.key ? ' on' : ''}" data-act="source" data-k="${esc(src.key)}">
          <svg class="ico"><use href="#i-${src.icon}"></use></svg>
          <span class="nm">${esc(src.name)}</span>
        </div>`).join('') || '<div class="tiny mute" style="padding:8px">Nothing found. Use “Add a site” below.</div>')}
      <div class="row" style="margin-top:8px;padding:0 4px">
        <button class="btn sm subtle" data-act="addsite" style="flex:1">${icon('plus')}Add a site by URL</button>
      </div>

      ${raw(s.files.pinned?.length ? `
        <div class="nav-group" style="padding:14px 8px 3px">Pinned</div>
        ${s.files.pinned.map(p => `<div class="fitem" data-act="pinned" data-d="${esc(p.driveId)}" data-i="${esc(p.itemId)}">
            <svg class="ico"><use href="#i-star"></use></svg>
            <span class="nm">${esc(p.name)}</span>
            <button class="btn icon sm subtle" data-act="unpin" data-i="${esc(p.itemId)}"><svg class="ico"><use href="#i-x"></use></svg></button>
          </div>`).join('')}` : '')}

      <div class="nav-group" style="padding:14px 8px 3px">Links</div>
      ${raw(s.settings.workspaceLinks.filter(l => l.url).map(l => `
        <div class="fitem" data-act="link" data-u="${esc(l.url)}">
          <svg class="ico"><use href="#i-link"></use></svg><span class="nm">${esc(l.label)}</span></div>`).join('')
        || '<div class="tiny mute" style="padding:4px 8px">None saved.</div>')}
    </div>
  </section>`;
}

function listPane() {
  const items = nav.items;
  const folders = items.filter(i => i.folder);
  const files = items.filter(i => !i.folder);
  return h`
  <section class="card pane" style="display:flex;flex-direction:column">
    <header style="flex-wrap:wrap;gap:6px">
      <div class="crumbs" style="flex:1;min-width:0">
        ${raw(nav.crumbs.map((c, i) =>
          `<a data-act="crumb" data-i="${i}">${esc(c.name)}</a>${i < nav.crumbs.length - 1 ? '<span>›</span>' : ''}`).join('')
          || '<span class="mute">Pick a place on the left</span>')}
      </div>
      <div class="search" style="width:180px">${icon('search')}
        <input type="search" id="fq" placeholder="Search this drive" value="${nav.search}"></div>
      <button class="btn sm subtle" data-act="newfolder" title="New folder">${icon('plus')}Folder</button>
      <button class="btn sm subtle" data-act="upload" title="Upload a file">${icon('up')}Upload</button>
    </header>
    <div class="body flush" style="flex:1;overflow:auto;padding:6px">
      ${raw(nav.loading ? '<div class="empty"><div class="spin" style="margin:0 auto 10px"></div><div class="tiny">Loading…</div></div>'
        : nav.error ? `<div class="banner risk" style="margin:8px"><svg class="ico"><use href="#i-warn"></use></svg>
            <div><b>Graph said no.</b><div class="tiny mono">${esc(nav.error)}</div></div></div>`
        : !items.length ? '<div class="empty tiny">This folder is empty.</div>'
        : [...folders, ...files].map(row).join(''))}
    </div>
  </section>`;
}

function row(i) {
  const kind = i.folder ? 'folder' : G.fileKind(i.name);
  const ic = i.folder ? 'folder' : kind === 'image' ? 'eye' : kind === 'text' ? 'note' : 'file';
  return `<div class="fitem${nav.selected?.id === i.id ? ' on' : ''}" data-act="item" data-i="${esc(i.id)}" data-folder="${i.folder ? 1 : 0}">
    <svg class="ico"><use href="#i-${ic}"></use></svg>
    <span class="nm">${esc(i.name)}</span>
    <span class="sz">${i.folder ? (i.folder.childCount ?? '') + ' items' : G.fmtBytes(i.size)}</span>
    <button class="btn icon sm subtle" data-act="item-menu" data-i="${esc(i.id)}"><svg class="ico"><use href="#i-dots"></use></svg></button>
  </div>`;
}

function detailPane() {
  const i = nav.selected;
  if (!i) return h`
    <section class="card pane"><div class="empty">
      ${icon('file')}<h4>Nothing selected</h4>
      <div class="tiny">Pick a file to preview it. Text files can be edited here and saved straight back to SharePoint.</div>
    </div></section>`;

  const kind = G.fileKind(i.name);
  const ed = nav.editing;
  const dirty = ed && ed.text !== ed.original;

  return h`
  <section class="card pane" style="display:flex;flex-direction:column">
    <header style="flex-wrap:wrap;gap:6px">
      <div style="flex:1;min-width:0">
        <h3 class="trunc">${i.name}</h3>
        <div class="sub">${G.fmtBytes(i.size)} · modified ${fmtDate(String(i.lastModifiedDateTime || '').slice(0, 10), 'long')}
          ${raw(i.lastModifiedBy?.user?.displayName ? ' by ' + esc(i.lastModifiedBy.user.displayName) : '')}</div>
      </div>
      ${raw(dirty ? '<span class="chip warn"><span class="dirty-dot"></span>unsaved</span>' : '')}
      ${raw(ed ? `<button class="btn primary sm" data-act="save"${dirty ? '' : ' disabled'}>${'<svg class="ico"><use href="#i-save"></use></svg>'}Save to SharePoint</button>` : '')}
      <button class="btn icon sm subtle" data-act="file-menu"><svg class="ico"><use href="#i-dots"></use></svg></button>
    </header>
    <div class="body" id="pv" style="flex:1;overflow:auto">
      ${raw(kind === 'text'
        ? (ed ? `<textarea class="editor" id="edit" spellcheck="false">${esc(ed.text)}</textarea>
                 <div class="hint">Saving writes a new version of the file in SharePoint. The previous version stays in the file's version history.</div>`
              : '<div class="empty"><div class="spin" style="margin:0 auto 10px"></div><div class="tiny">Loading the file…</div></div>')
        : '<div class="empty"><div class="spin" style="margin:0 auto 10px"></div><div class="tiny">Building a preview…</div></div>')}
    </div>
  </section>`;
}

/* ---------- data --------------------------------------------------------- */

async function loadSources() {
  const out = [];
  try {
    const d = await G.myDrive();
    out.push({ key: 'od', kind: 'onedrive', name: 'My files (OneDrive)', icon: 'cloud', driveId: d.id });
  } catch { /* no OneDrive licence, or scope refused */ }

  let sites = [];
  try { sites = await G.followedSites(); } catch { }
  if (!sites.length) { try { sites = (await G.searchSites('*')).slice(0, 20); } catch { } }
  for (const st of sites) {
    out.push({ key: 'site:' + st.id, kind: 'site', name: st.displayName || st.name, icon: 'folder', siteId: st.id, webUrl: st.webUrl });
  }
  for (const extra of (S.get().files.sites || [])) {
    if (!out.some(o => o.key === 'site:' + extra.id)) {
      out.push({ key: 'site:' + extra.id, kind: 'site', name: extra.name, icon: 'folder', siteId: extra.id, webUrl: extra.webUrl });
    }
  }
  return out;
}

async function openSource(src) {
  nav.source = src; nav.selected = null; nav.editing = null; nav.error = null; nav.search = '';
  if (src.kind === 'onedrive') {
    nav.driveId = src.driveId;
    nav.crumbs = [{ id: 'root', name: src.name }];
  } else {
    const drives = await G.siteDrives(src.siteId);
    const doc = drives.find(d => d.name === 'Documents') || drives[0];
    if (!doc) throw new Error('That site has no document library you can reach.');
    nav.driveId = doc.id;
    nav.crumbs = [{ id: 'root', name: `${src.name} · ${doc.name}` }];
  }
  nav.itemId = 'root';
  await loadFolder('root');
}

async function loadFolder(itemId) {
  nav.loading = true; nav.error = null; render();
  try {
    nav.items = await G.listChildren(nav.driveId, itemId);
    nav.itemId = itemId;
  } catch (e) {
    nav.items = []; nav.error = e.message;
  }
  nav.loading = false; render();
}

async function selectItem(id) {
  const item = nav.items.find(x => x.id === id);
  if (!item) return;
  if (item.folder) {
    nav.crumbs.push({ id: item.id, name: item.name });
    nav.selected = null; nav.editing = null;
    return loadFolder(item.id);
  }
  nav.selected = item; nav.editing = null;
  render();
  await showPreview(item);
}

async function showPreview(item) {
  const kind = G.fileKind(item.name);
  const pv = hostEl.querySelector('#pv');
  if (!pv) return;

  try {
    if (kind === 'text') {
      const text = await G.getText(nav.driveId, item.id);
      nav.editing = { itemId: item.id, name: item.name, text, original: text, mime: G.mimeFor(item.name) };
      render();
      const ta = hostEl.querySelector('#edit');
      if (ta) {
        ta.addEventListener('input', () => {
          nav.editing.text = ta.value;
          const btn = hostEl.querySelector('[data-act="save"]');
          const changed = nav.editing.text !== nav.editing.original;
          if (btn) btn.disabled = !changed;
          const chip = hostEl.querySelector('.chip.warn');
          if (changed && !chip) render();     // show the "unsaved" chip once
        });
        ta.addEventListener('keydown', e => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveText(); }
        });
      }
      return;
    }

    if (kind === 'image') {
      const url = await G.getBlobUrl(nav.driveId, item.id);
      pv.innerHTML = `<div style="text-align:center"><img src="${url}" alt="${esc(item.name)}"
        style="max-width:100%;max-height:70vh;border-radius:var(--r);box-shadow:var(--shadow-1)"></div>`;
      return;
    }

    // Office / PDF / everything else: ask Graph for an embeddable viewer
    const canEdit = G.OFFICE.test(item.name);
    const link = await G.previewLink(nav.driveId, item.id, { allowEdit: canEdit });
    const url = link.getUrl || link.postUrl;
    if (!url) throw new Error('Graph returned no preview URL for this file type.');
    pv.innerHTML = `
      ${canEdit ? `<div class="banner" style="margin-bottom:10px"><svg class="ico"><use href="#i-info"></use></svg>
        <div>This is the real Office editor. Changes you make save to the file in SharePoint, same as opening it from the site.</div></div>` : ''}
      <iframe class="preview-frame" src="${esc(url)}" allowfullscreen
              style="height:${canEdit ? '72vh' : '64vh'}"></iframe>`;
  } catch (e) {
    pv.innerHTML = `<div class="banner risk"><svg class="ico"><use href="#i-warn"></use></svg>
      <div><b>Could not preview that file.</b><div class="tiny mono">${esc(e.message)}</div>
      <button class="btn sm" data-act="openweb" style="margin-top:8px">Open it in SharePoint instead</button></div></div>`;
  }
}

async function saveText() {
  const ed = nav.editing;
  if (!ed || ed.text === ed.original) return;
  const t = toast('Saving to SharePoint…', '', 20000);
  try {
    await G.putText(nav.driveId, ed.itemId, ed.text, ed.mime);
    ed.original = ed.text;
    t.remove(); toast(`${ed.name} saved`, 'ok');
    // refresh the row so size/modified are current
    try { const fresh = await G.getItem(nav.driveId, ed.itemId);
          nav.items = nav.items.map(x => x.id === fresh.id ? fresh : x);
          nav.selected = fresh; } catch {}
    render();
  } catch (e) {
    t.remove();
    toast('Save failed: ' + e.message, 'err', 9000);
  }
}

/* ---------- actions ------------------------------------------------------ */

async function newFolder() {
  const v = await formDlg('New folder', [{ k: 'name', label: 'Folder name', required: true, span: 12 }]);
  if (!v) return;
  try { await G.createFolder(nav.driveId, nav.itemId, v.name); toast('Folder created', 'ok'); loadFolder(nav.itemId); }
  catch (e) { toast('Could not create it: ' + e.message, 'err', 8000); }
}

async function uploadFile() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    if (f.size > 4 * 1024 * 1024) return toast('Files over 4 MB need a chunked upload, which this build does not do yet. Use the SharePoint web page for large files.', 'warn', 9000);
    const t = toast(`Uploading ${f.name}…`, '', 30000);
    try { await G.uploadToFolder(nav.driveId, nav.itemId, f.name, f, f.type || 'application/octet-stream');
          t.remove(); toast('Uploaded', 'ok'); loadFolder(nav.itemId); }
    catch (e) { t.remove(); toast('Upload failed: ' + e.message, 'err', 9000); }
  };
  inp.click();
}

async function addSite() {
  const v = await formDlg('Add a SharePoint site', [
    { k: 'url', label: 'Site or folder URL', type: 'url', required: true, span: 12,
      hint: 'Paste the address from your browser, e.g. https://contoso.sharepoint.com/sites/ArtTeam' },
  ]);
  if (!v) return;
  try {
    const site = await G.siteFromUrl(v.url);
    S.mutate(s => { (s.files.sites ||= []).push({ id: site.id, name: site.displayName || site.name, webUrl: site.webUrl }); },
             { label: 'add site' });
    toast(`Added ${site.displayName || site.name}`, 'ok');
    boot();
  } catch (e) { toast('Could not resolve that URL: ' + e.message, 'err', 9000); }
}

function itemMenu(id, ev) {
  const i = nav.items.find(x => x.id === id) || nav.selected;
  if (!i) return;
  const pinned = (S.get().files.pinned || []).some(p => p.itemId === i.id);
  menu(ev, [
    { label: i.folder ? 'Open' : 'Preview', icon: 'eye', run: () => selectItem(i.id) },
    { label: 'Open in SharePoint', icon: 'link', run: () => openExternal(i.webUrl) },
    ...(i['@microsoft.graph.downloadUrl'] ? [{ label: 'Download', icon: 'down', run: () => openExternal(i['@microsoft.graph.downloadUrl']) }] : []),
    { label: 'Copy link', icon: 'link', run: async () => { const r = await shareLink(i.webUrl); toast(r === 'shared' ? 'Shared' : 'Link copied', 'ok'); } },
    '-',
    { label: pinned ? 'Unpin' : 'Pin to Places', icon: 'star', run: () => {
      S.mutate(s => {
        s.files.pinned ||= [];
        s.files.pinned = pinned ? s.files.pinned.filter(p => p.itemId !== i.id)
          : [...s.files.pinned, { itemId: i.id, driveId: nav.driveId, name: i.name }];
      }, { label: 'pin' });
      render();
    } },
    { label: 'Rename…', icon: 'edit', run: async () => {
      const v = await formDlg('Rename', [{ k: 'name', label: 'New name', value: i.name, required: true, span: 12 }]);
      if (!v) return;
      try { await G.renameItem(nav.driveId, i.id, v.name); toast('Renamed', 'ok'); loadFolder(nav.itemId); }
      catch (e) { toast('Rename failed: ' + e.message, 'err', 8000); }
    } },
    { label: 'Version history…', icon: 'clock', run: () => showVersions(i) },
    '-',
    { label: 'Delete', icon: 'trash', danger: true, run: async () => {
      if (!await confirmDlg(`Move “${i.name}” to the SharePoint recycle bin? It can be restored from there for 93 days.`,
                            { title: 'Delete file', ok: 'Move to recycle bin' })) return;
      try { await G.deleteItem(nav.driveId, i.id); toast('Moved to the recycle bin', 'ok');
            nav.selected = null; nav.editing = null; loadFolder(nav.itemId); }
      catch (e) { toast('Delete failed: ' + e.message, 'err', 8000); }
    } },
  ]);
}

async function showVersions(i) {
  let list = [];
  try { list = await G.versions(nav.driveId, i.id); }
  catch (e) { return toast('Could not read version history: ' + e.message, 'err', 8000); }
  dialog({
    title: 'Versions — ' + i.name,
    body: list.length ? `<table class="tbl"><thead><tr><th>Version</th><th>Modified</th><th>By</th><th class="num">Size</th></tr></thead>
      <tbody>${list.map(v => `<tr><td class="mono tiny">${esc(v.id)}</td>
        <td class="tiny">${esc(String(v.lastModifiedDateTime || '').slice(0, 16).replace('T', ' '))}</td>
        <td class="tiny">${esc(v.lastModifiedBy?.user?.displayName || '')}</td>
        <td class="num tiny">${G.fmtBytes(v.size)}</td></tr>`).join('')}</tbody></table>
      <p class="hint">Restoring a version is done from SharePoint itself — this is a read-only view.</p>`
      : '<p class="tiny mute">No version history returned for this file.</p>',
    footer: `<button class="btn" data-x2>Close</button>`,
    onMount: ({ root, close }) => { root.querySelector('[data-x2]').onclick = () => close(); },
  });
}

/* ---------- render ------------------------------------------------------- */

let sourcesCache = null;

function render() {
  if (!hostEl) return;
  const cfg = S.get().settings.graph;

  if (!cfg.clientId) { hostEl.innerHTML = notConfigured(); wire(); return; }
  if (!graph.connected) { hostEl.innerHTML = notConnected(); wire(); return; }

  hostEl.innerHTML = h`<div class="fx" style="grid-template-columns:270px 340px 1fr">
    ${raw(sourcePane(sourcesCache || []))}
    ${raw(listPane())}
    ${raw(detailPane())}
  </div>`;
  wire();
}

function wire() {
  acts(hostEl, {
    settings: () => ctxRef.go('settings'),
    link: el => openExternal(el.dataset.u),
    connect: async () => {
      const t = toast('Opening the Microsoft sign-in window…', '', 30000);
      try { await G.connect(S.get().settings.graph); t.remove(); toast('Connected', 'ok'); boot(); }
      catch (e) { t.remove(); toast('Sign-in failed: ' + e.message, 'err', 10000); }
    },
    reload: () => { sourcesCache = null; boot(); },
    source: el => {
      const src = (sourcesCache || []).find(s => s.key === el.dataset.k);
      if (src) openSource(src).catch(e => { nav.error = e.message; render(); });
    },
    addsite: addSite,
    pinned: async el => {
      nav.driveId = el.dataset.d;
      try { const it = await G.getItem(nav.driveId, el.dataset.i);
            nav.items = [it]; nav.crumbs = [{ id: 'root', name: 'Pinned' }];
            await selectItem(it.id); }
      catch (e) { toast('Could not open that pin: ' + e.message, 'err', 8000); }
    },
    unpin: el => {
      S.mutate(s => { s.files.pinned = (s.files.pinned || []).filter(p => p.itemId !== el.dataset.i); }, { label: 'unpin' });
      render();
    },
    crumb: el => {
      const i = +el.dataset.i;
      nav.crumbs = nav.crumbs.slice(0, i + 1);
      nav.selected = null; nav.editing = null;
      loadFolder(nav.crumbs[i].id);
    },
    item: el => selectItem(el.dataset.i),
    'item-menu': (el, ev) => itemMenu(el.dataset.i, ev),
    'file-menu': (el, ev) => itemMenu(nav.selected?.id, ev),
    newfolder: newFolder,
    upload: uploadFile,
    save: saveText,
    openweb: () => openExternal(nav.selected?.webUrl),
  });

  const q = hostEl.querySelector('#fq');
  if (q) {
    let t;
    q.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        nav.search = q.value.trim();
        if (!nav.search) return loadFolder(nav.itemId);
        nav.loading = true; render();
        try { nav.items = await G.searchDrive(nav.driveId, nav.search); nav.error = null; }
        catch (e) { nav.items = []; nav.error = e.message; }
        nav.loading = false; render();
        hostEl.querySelector('#fq')?.focus();
      }, 400);
    });
  }
}

async function boot() {
  const cfg = S.get().settings.graph;
  if (!cfg.clientId) return render();
  try {
    await G.initGraph(cfg);
    if (!graph.connected) { await G.token(G.allScopes(cfg), { interactive: false }).catch(() => {}); }
  } catch { }
  if (!graph.connected) return render();
  render();
  try {
    sourcesCache = await loadSources();
    render();
    if (!nav.source && sourcesCache.length) await openSource(sourcesCache[0]);
  } catch (e) {
    nav.error = e.message; render();
  }
}

/* ---------- view --------------------------------------------------------- */

export default {
  id: 'files', title: 'Files', icon: 'folder', group: 'space',
  subtitle: 'SharePoint & OneDrive — browse, preview, edit',

  actions: () => [],

  render(host, ctx) {
    hostEl = host; ctxRef = ctx;
    render();
    boot();
    return () => { hostEl = null; };
  },
};
