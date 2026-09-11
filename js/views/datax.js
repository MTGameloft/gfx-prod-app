/* ============================================================================
   views/datax.js — Excel Sync.

   Two directions, one screen:

     Export   the app's data as a real .xlsx you can edit in Excel
     Import   an edited .xlsx back into the app

   Import always shows you a diff first. That is the whole design: the failure
   mode that actually hurts is not a rejected file, it is a file that imports
   "successfully" and quietly replaces work you wanted to keep. So nothing is
   written until you have seen the counts, and deletion never happens unless
   you explicitly ask for it.
   ========================================================================= */

import * as S from '../store.js';
import {
  h, raw, esc, icon, toast, dialog, confirmDlg, acts,
  fmtDate, downloadBlob, pickBinaryFile, fmtNum,
} from '../ui.js';
import { SHEETS, sheetsOf, allWorkbooks, inScope } from '../xlsxschema.js';
import {
  buildWorkbook, readWorkbook, planImport, applyPlan,
  guessWorkbook, rescuePeek, rescueRestore, libReady,
} from '../xlsxio.js';

/*
 * Where the workbooks live on this machine, shown so the screen matches the
 * desk. Set in Settings → Backup & data, NOT hard-coded: a path is a fact
 * about one machine, and this repository is public.
 */
const FOLDER = () => String(S.get().settings?.paths?.workbooks || '').trim();
/** The folder name alone, for prose. Falls back to something generic. */
const FOLDER_NAME = () => {
  const p = FOLDER();
  return p ? (p.split(/[\\/]/).filter(Boolean).pop() || p) : 'your workbook folder';
};

/* ---------- how many rows each workbook currently holds ------------------ */

function rowCount(spec, state, scope) {
  // A scoped workbook counts only its own rows, or every division card would
  // claim the whole team's 1:1s.
  const keep = list => (spec.scoped && scope) ? list.filter(r => inScope(scope, r, state, spec)) : list;
  if (spec.child) {
    const { parent, field } = spec.child;
    return keep(state[parent] || []).reduce((n, p) => {
      const v = p[field];
      return n + (Array.isArray(v) ? v.length : Object.keys(v || {}).length);
    }, 0);
  }
  return keep(state[spec.coll] || []).length;
}

const wbRows = (wb, state) => sheetsOf(wb.id, state).reduce((n, s) => n + rowCount(s, state, wb.scope), 0);

/* ---------- export ------------------------------------------------------- */

async function exportOne(wbId, btn) {
  const label = btn?.textContent;
  try {
    if (btn) { btn.disabled = true; btn.textContent = libReady() ? 'Building…' : 'Loading…'; }
    const { blob, file, rows } = await buildWorkbook(wbId);
    downloadBlob(file, blob);
    toast(`${file} — ${fmtNum(rows)} rows. It lands in Downloads; the watcher ` +
          `moves it into ${FOLDER_NAME()} within about 15 seconds.`, 'ok', 6500);
  } catch (e) {
    toast(e.message, 'err', 7000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

async function exportAll(btn) {
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Building…'; }
  let ok = 0;
  for (const wb of allWorkbooks(S.get())) {
    try {
      const { blob, file } = await buildWorkbook(wb.id);
      downloadBlob(file, blob);
      ok++;
      // Browsers rate-limit a burst of downloads; a beat apart, all five land.
      await new Promise(r => setTimeout(r, 400));
    } catch (e) { toast(`${wb.file}: ${e.message}`, 'err', 6000); }
  }
  if (btn) { btn.disabled = false; btn.textContent = label; }
  if (ok) toast(`${ok} workbook${ok === 1 ? '' : 's'} downloaded.`, 'ok', 5000);
}

/* ---------- import ------------------------------------------------------- */

async function importOne(wbId, ctx) {
  const picked = await pickBinaryFile('.xlsx,.xlsm');
  if (!picked) return;
  if (picked.error) return toast('Could not read that file: ' + picked.error, 'err');

  let parsed;
  try {
    parsed = await readWorkbook(picked.buf);
  } catch (e) { return toast(e.message, 'err', 7000); }

  /* Which workbook is this really? Picking the wrong button is easy, and
     importing a roster as a budget would be a mess to unpick. */
  const guess = guessWorkbook(parsed.names, picked.name);

  /* A file from before the nine workbooks became four. Its sheets are now
     split across two books, so importing it would quietly apply half of it. */
  if (guess && guess.retired) {
    return toast(`"${picked.name}" is from an older version of the app. ` +
                 guess.retired.why + ' Export the new file and edit that.', 'err', 10000);
  }

  let useId = wbId;
  if (guess && guess.wb.id !== wbId) {
    const go = await confirmDlg(
      `This file's sheets look like "${guess.wb.title}" (${guess.wb.file}), not ` +
      `"${(allWorkbooks(S.get()).find(w => w.id === wbId) || {}).title}". Import it as ` +
      `"${guess.wb.title}" instead?`,
      { title: 'That looks like a different file', ok: 'Yes, use ' + guess.wb.title, danger: false });
    if (go) useId = guess.wb.id;
  }
  if (!guess) {
    return toast('None of the sheets in that file match a known layout. Export a ' +
                 'template first and edit that.', 'err', 8000);
  }

  await reviewAndApply(useId, parsed, picked, ctx);
}

/* ---------- the diff dialog --------------------------------------------- */

function chg(c) {
  const f = v => v === '' || v == null ? '—'
    : Array.isArray(v) ? (v.length ? v.join(', ') : '—')
    : typeof v === 'object' ? JSON.stringify(v)
    : String(v);
  const from = f(c.from), to = f(c.to);
  const cut = s => (s.length > 44 ? s.slice(0, 42) + '…' : s);
  return `<code class="dx-was">${esc(cut(from))}</code> <span class="dx-arrow">&rarr;</span> <code class="dx-now">${esc(cut(to))}</code>`;
}

function planHTML(plan) {
  const c = plan.counts;
  const pill = (n, label, cls) => n
    ? `<span class="chip tiny ${cls}">${fmtNum(n)} ${label}</span>` : '';

  /* Unexpected-but-accepted values. Worth seeing, never worth blocking on. */
  const warnBlock = s => (s.warnings || []).length ? `<div class="banner warn" style="margin:6px 8px">
      <svg class="ico"><use href="#i-info"></use></svg>
      <div><b>${s.warnings.length} value${s.warnings.length === 1 ? '' : 's'} outside the usual list.</b>
        Imported exactly as written.
        <ul class="dx-err">${s.warnings.slice(0, 8).map(w =>
          `<li>Row ${w.row}: ${esc(w.why)}</li>`).join('')}</ul>
        ${s.warnings.length > 8 ? `<div class="tiny">…and ${s.warnings.length - 8} more</div>` : ''}
      </div></div>` : '';

  const sheetBlocks = plan.sheets.map(s => {
    const touched = s.creates.length + s.updates.length + s.removes.length;
    if (!touched && !s.errors.length && !(s.warnings || []).length) {
      return `<div class="dx-sheet quiet"><b>${esc(s.name)}</b>
        <span class="tiny mute">${s.unchanged ? fmtNum(s.unchanged) + ' rows, all identical' : 'nothing to do'}</span></div>`;
    }
    const rows = [];
    for (const u of s.updates.slice(0, 40)) {
      rows.push(`<tr><td class="dx-k">change</td><td><b>${esc(u.label)}</b>
        <span class="tiny mute">row ${u.row || '—'}${u.matchedBy ? ', matched on ' + esc(u.matchedBy) : ''}</span></td>
        <td>${u.changes.map(x => `<div class="dx-c"><span class="dx-f">${esc(x.f)}</span> ${chg(x)}</div>`).join('')}</td></tr>`);
    }
    for (const cr of s.creates.slice(0, 40)) {
      rows.push(`<tr><td class="dx-k add">add</td><td><b>${esc(cr.label)}</b>
        <span class="tiny mute">row ${cr.row}</span></td><td class="tiny mute">new record</td></tr>`);
    }
    for (const rm of s.removes.slice(0, 40)) {
      rows.push(`<tr><td class="dx-k del">delete</td><td><b>${esc(rm.label)}</b></td>
        <td class="tiny mute">not present in the file</td></tr>`);
    }
    const over = touched - Math.min(touched, 120);
    return `<div class="dx-sheet">
      <div class="dx-sheet-h"><b>${esc(s.name)}</b>
        ${pill(s.creates.length, 'add', 'ok')}
        ${pill(s.updates.length, 'change', 'info')}
        ${pill(s.removes.length, 'delete', 'risk')}
        ${s.unchanged ? `<span class="tiny mute">${fmtNum(s.unchanged)} identical</span>` : ''}
      </div>
      <table class="dx-table">${rows.join('')}</table>
      ${over > 0 ? `<div class="tiny mute" style="padding:4px 8px">…and ${fmtNum(over)} more</div>` : ''}
      ${warnBlock(s)}
      ${s.errors.length ? `<div class="banner risk" style="margin:6px 8px">
        <svg class="ico"><use href="#i-warn"></use></svg>
        <div>
          <b>${s.errors.length} row${s.errors.length === 1 ? '' : 's'} skipped.</b>
          <ul class="dx-err">${s.errors.slice(0, 12).map(e =>
            `<li>Row ${e.row}: ${esc(e.why.join('; '))}</li>`).join('')}</ul>
          ${s.errors.length > 12 ? `<div class="tiny">…and ${s.errors.length - 12} more</div>` : ''}
        </div>
      </div>` : ''}
    </div>`;
  }).join('');

  const missing = plan.sheets.flatMap(s => (s.missing || []).map(m => ({ sheet: s.name, ...m })));

  return `
    <div class="dx-sum">
      ${pill(c.create, 'to add', 'ok')}
      ${pill(c.update, 'to change', 'info')}
      ${pill(c.remove, 'to delete', 'risk')}
      ${pill(c.unchanged, 'unchanged', '')}
      ${pill(c.error, 'row error' + (c.error === 1 ? '' : 's'), 'risk')}
      ${pill(c.warn, 'to check', 'warn')}
      ${!c.create && !c.update && !c.remove
        ? '<span class="tiny mute">Nothing in this file differs from what the app already has.</span>' : ''}
    </div>

    ${plan.skippedSheets.length ? `<div class="hint">
      Not in this file, so left completely alone:
      <b>${plan.skippedSheets.map(esc).join(', ')}</b>.</div>` : ''}

    ${sheetBlocks}

    ${missing.length ? `<div class="dx-sheet">
      <div class="dx-sheet-h"><b>In the app but not in the file</b>
        <span class="chip tiny">${fmtNum(missing.length)}</span></div>
      <div class="tiny mute" style="padding:2px 8px 8px">
        Kept as they are. A file missing rows is usually a partial export, not a
        request to delete. Tick the box below if you really do want the app to
        match this file exactly.</div>
      <div class="dx-chips">${missing.slice(0, 60).map(m =>
        `<span class="chip tiny">${esc(m.label)}<span class="mute"> · ${esc(m.sheet)}</span></span>`).join('')}
        ${missing.length > 60 ? `<span class="tiny mute">…and ${missing.length - 60} more</span>` : ''}</div>
    </div>` : ''}`;
}

async function reviewAndApply(wbId, parsed, picked, ctx) {
  let mirror = false;
  const build = () => planImport(wbId, parsed.sheets, { mirror });
  let plan = build();

  const wb = allWorkbooks(S.get()).find(w => w.id === wbId);

  const res = await dialog({
    title: `Import ${wb.title}`,
    wide: true,
    body: `
      <div class="dx-file">
        ${icon('sheet')}
        <div><b>${esc(picked.name)}</b>
          <div class="tiny mute">${fmtNum(Math.round(picked.size / 1024))} KB ·
            ${parsed.names.length} sheet${parsed.names.length === 1 ? '' : 's'} ·
            last saved ${picked.lastModified ? fmtDate(new Date(picked.lastModified).toISOString().slice(0, 10), 'long') : 'unknown'}</div>
        </div>
      </div>
      <div id="dxbody">${planHTML(plan)}</div>
      <label class="dx-mirror">
        <input type="checkbox" id="dxmirror">
        <span><b>Mirror this file exactly</b>
          <span class="tiny mute">Also delete records that are missing from the file.
          Off by default, and it only affects the sheets this file actually contains.</span></span>
      </label>`,
    footer: `<button class="btn" data-no>Cancel</button>
             <button class="btn primary" data-ok data-yes>Apply</button>`,
    onMount: ({ root, close }) => {
      const body = root.querySelector('#dxbody');
      const applyBtn = root.querySelector('[data-yes]');
      const sync = () => {
        applyBtn.disabled = !(plan.counts.create + plan.counts.update + plan.counts.remove);
        applyBtn.textContent = plan.counts.remove
          ? `Apply, including ${plan.counts.remove} deletion${plan.counts.remove === 1 ? '' : 's'}`
          : 'Apply';
        applyBtn.classList.toggle('danger', !!plan.counts.remove);
        applyBtn.classList.toggle('primary', !plan.counts.remove);
      };
      root.querySelector('#dxmirror').onchange = e => {
        mirror = e.target.checked;
        plan = build();
        body.innerHTML = planHTML(plan);
        sync();
      };
      root.querySelector('[data-no]').onclick = () => close(false);
      applyBtn.onclick = () => close(true);
      sync();
    },
  });

  if (res !== true) return;

  if (plan.counts.remove) {
    const sure = await confirmDlg(
      `${plan.counts.remove} record${plan.counts.remove === 1 ? '' : 's'} will be deleted ` +
      `because they are not in this file. A copy of the current data is saved first, ` +
      `and Ctrl+Z undoes the whole import.`,
      { title: 'Delete missing records?', ok: 'Delete them' });
    if (!sure) return;
  }

  const done = applyPlan(plan);
  toast(`Imported: ${done.created} added, ${done.updated} changed` +
        (done.removed ? `, ${done.removed} deleted` : '') + '. Ctrl+Z undoes it.', 'ok', 7000);
  ctx.rerender();
}

/* ---------- view --------------------------------------------------------- */

export default {
  id: 'datax', title: 'Excel Sync', icon: 'sheet', group: 'space',
  subtitle: 'Move data between the app and your Excel files, in both directions',

  /* `run` is called with the view ctx, not the click event, so there is no
     button element to disable here — exportAll copes with being handed none. */
  actions: () => [
    { label: 'Export all', icon: 'down', primary: true, run: () => exportAll(null) },
  ],

  render(host, ctx) {
    const st = S.get();
    const last = st.settings?.excel?.lastImport;
    const rescue = rescuePeek();

    host.innerHTML = h`
      <div class="banner">
        ${icon('info')}
        <div>
          <b>How this works.</b> Export a workbook, edit it in Excel, then import it
          back. Import shows you exactly what will change before anything is written,
          and it never deletes a record unless you ask it to.
          <div class="tiny mute" style="margin-top:6px">
            The app cannot watch a folder and pick up a replaced file on its own — a
            Teams tab has no access to your disk. Importing is one click, but it is a
            click you have to make.
          </div>
        </div>
      </div>

      <div class="dx-folder">
        ${icon('folder')}
        <div><div class="tiny mute">Exports land in Downloads, then a watcher moves them
          ${FOLDER() ? 'here' : 'into your workbook folder'}
          — the copy they replace is kept in <code>_Previous\\</code></div>
          ${raw(FOLDER()
            ? `<code>${esc(FOLDER())}</code>`
            : `<span class="tiny mute">Set the folder in <b>Settings → Backup &amp; data</b> and it will
               be shown here.</span>`)}</div>
      </div>

      <div class="dx-grid">
        ${raw(allWorkbooks(st).map(wb => {
          const rows = wbRows(wb, st);
          return `<div class="card dx-card">
            <div class="dx-card-h">
              <div>
                <h4>${esc(wb.title)}</h4>
                <code class="tiny">${esc(wb.file)}</code>
              </div>
              <span class="chip tiny ${rows ? '' : 'warn'}">${rows ? fmtNum(rows) + ' rows' : 'empty'}</span>
            </div>
            <p class="tiny mute">${esc(wb.blurb)}</p>
            <div class="dx-chips">
              ${wb.sheets.map(s => `<span class="chip tiny" title="${esc(SHEETS[s]?.note || '')}">${esc(s)}</span>`).join('')}
            </div>
            <div class="dx-actions">
              <button class="btn sm" data-act="export" data-wb="${wb.id}">
                <svg class="ico"><use href="#i-down"></use></svg>Export</button>
              <button class="btn sm subtle" data-act="import" data-wb="${wb.id}">
                <svg class="ico"><use href="#i-up"></use></svg>Import</button>
            </div>
          </div>`;
        }).join(''))}
      </div>

      ${raw(last ? `<div class="card">
        <h4>Last import</h4>
        <p class="tiny mute">${fmtDate(new Date(last.at).toISOString().slice(0, 10), 'long')} —
          ${fmtNum(last.created)} added, ${fmtNum(last.updated)} changed${last.removed ? `, ${fmtNum(last.removed)} deleted` : ''}
          (${esc(allWorkbooks(st).find(w => w.id === last.wbId)?.title || last.wbId)}).</p>
        ${rescue ? `<button class="btn sm subtle" data-act="rescue">
          <svg class="ico"><use href="#i-undo"></use></svg>Restore the data from just before it</button>` : ''}
      </div>` : '')}

      <div class="card">
        <h4>The rules, in one place</h4>
        <ul class="dx-rules tiny">
          <li><b>ID column.</b> Blank means a new record. Filled means update that
              record — so you can rename someone in Excel and it stays the same person.</li>
          <li><b>Names, not ids.</b> Manager, Assignee, Owner and Lead are person
              <i>names</i>; ProjectCode is a project <i>code</i>; Vendor is a studio
              <i>name</i>. Anything that does not match is reported and that row is skipped.</li>
          <li><b>Missing sheets are ignored.</b> Delete a sheet from the file and the
              app leaves that data alone. Sheets are independent.</li>
          <li><b>Missing rows are kept.</b> Deletion only happens with
              “mirror this file exactly” ticked.</li>
          <li><b>Untouched fields stay untouched.</b> A sheet can only write the
              columns it has, which is why allocations live on their own sheet —
              importing People cannot disturb anyone's project split.</li>
          <li><b>One undo.</b> A whole import is a single step; Ctrl+Z reverses it,
              and a full copy is saved to this browser beforehand.</li>
        </ul>
      </div>`;

    acts(host, {
      export: (el) => exportOne(el.dataset.wb, el),
      import: (el) => importOne(el.dataset.wb, ctx),
      rescue: async () => {
        if (!await confirmDlg(
          'This replaces everything in the app with the copy saved just before the ' +
          'last import. Anything you changed since then is lost.',
          { title: 'Restore pre-import data?', ok: 'Restore' })) return;
        try { rescueRestore(); toast('Restored.', 'ok'); ctx.rerender(); }
        catch (e) { toast(e.message, 'err'); }
      },
    });
  },
};
