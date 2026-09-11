/* ============================================================================
   views/outsourcing.js — studios and vendors, and the batches they owe you.

   Two things a producer needs from a vendor list, and neither is a contact
   card: what is in flight right now, and whether this studio actually delivers
   on the date it agreed to. Both are computed from the batch records rather
   than from a rating somebody typed in once and never revisited.
   ========================================================================= */

import * as S from '../store.js';
import {
  h, raw, esc, icon, toast, dialog, formDlg, confirmDlg, menu, acts, bar,
  fmtDate, fmtMoney, fmtMoneyFull, fmtPct, relDays, today, download, toCsv,
  sum, groupBy, clamp, initials, hashColor,
} from '../ui.js';
import {
  vendorStats, orphanVendorNames, VENDOR_STATUS, RATE_MODELS, BATCH_STATUS,
  batchStatus, vendorStatus, rateModel,
} from '../calc.js';

const UI_KEY = 'gfxprod.ui.outsourcing';
const ui = Object.assign({ mode: 'studios', status: '', project: '', q: '' },
                         JSON.parse(localStorage.getItem(UI_KEY) || '{}'));
const saveUi = () => localStorage.setItem(UI_KEY, JSON.stringify(ui));

const sym = () => S.get().settings.currencySymbol || '$';
const vendors = () => S.get().vendors || [];
const batches = () => S.get().outsourceBatches || [];

function filteredVendors() {
  const q = ui.q.trim().toLowerCase();
  return vendors().filter(v =>
    (!ui.status || v.status === ui.status) &&
    (!q || `${v.name} ${v.country || ''} ${(v.specialisms || []).join(' ')}`.toLowerCase().includes(q)));
}

function filteredBatches() {
  const q = ui.q.trim().toLowerCase();
  return batches().filter(b => {
    if (ui.project && b.projectId !== ui.project) return false;
    if (q) {
      const vn = S.byId(vendors(), b.vendorId)?.name || '';
      if (!`${b.title} ${vn} ${b.poNumber || ''}`.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

/* ---------- studios ------------------------------------------------------ */

function ratingDots(n, max = 5) {
  return Array.from({ length: max }, (_, i) =>
    `<span style="width:9px;height:9px;border-radius:50%;display:inline-block;background:${
      i < n ? 'var(--accent)' : 'var(--bg-sunken)'}"></span>`).join('');
}

function vendorCard(v) {
  const st = vendorStats(v.id);
  const s = S.get();
  const late = st.overdue.length;
  const vs = vendorStatus(v.status);
  return h`
  <section class="card" data-id="${v.id}">
    <header>
      <span class="avatar sm" style="background:${hashColor(v.name)}">${initials(v.name)}</span>
      <div style="flex:1;min-width:0">
        <h3 class="trunc">${v.name}</h3>
        <div class="sub">${v.country || '—'} · ${rateModel(v.rateModel).label}${v.rateValue ? ' · ' + fmtMoneyFull(v.rateValue, sym()) : ''}</div>
      </div>
      <span class="chip ${vs.chip}">${vs.label}</span>
      <button class="btn icon sm subtle" data-act="v-menu"><svg class="ico"><use href="#i-dots"></use></svg></button>
    </header>
    <div class="body">
      <div class="row wrap" style="gap:5px;margin-bottom:10px">
        ${raw((v.specialisms || []).map(d => {
          const dv = S.byId(s.divisions, d);
          return `<span class="pill-div" style="background:${dv?.color || 'var(--muted)'}">${esc(d)}</span>`;
        }).join('') || '<span class="tiny mute">no specialisms recorded</span>')}
        <span class="spacer" style="flex:1"></span>
        ${raw(!v.msaSigned ? '<span class="chip warn" title="Master service agreement not signed">no MSA</span>' : '')}
        ${raw(!v.ndaSigned ? '<span class="chip risk" title="NDA not signed">no NDA</span>' : '')}
      </div>

      <div class="grid g2" style="gap:10px">
        <div>
          <div class="tiny mute">Delivers on time</div>
          <div class="row" style="gap:7px">
            ${raw(st.onTimePct == null
              ? '<span class="tiny mute">no closed batches yet</span>'
              : `${bar(st.onTimePct, st.onTimePct >= 80 ? 'ok' : st.onTimePct >= 50 ? 'warn' : 'risk').html}
                 <b class="tiny" style="width:38px;text-align:right">${fmtPct(st.onTimePct)}</b>`)}
          </div>
          <div class="tiny mute" style="margin-top:3px">${st.closedCount} delivered · ${st.avgRevisions.toFixed(1)} revisions avg</div>
        </div>
        <div>
          <div class="tiny mute">Committed</div>
          <div class="strong">${fmtMoney(st.committed, sym())}</div>
          <div class="tiny mute">${fmtMoneyFull(st.committedOpen, sym())} still open</div>
        </div>
      </div>

      <div class="sep" style="margin:12px 0"></div>
      <div class="row wrap tiny" style="gap:12px">
        <span class="mute">Quality ${raw(ratingDots(v.quality))}</span>
        <span class="mute">On time ${raw(ratingDots(v.onTime))}</span>
        <span class="mute">Comms ${raw(ratingDots(v.comms))}</span>
      </div>
      <div class="row wrap tiny" style="gap:12px;margin-top:9px">
        <span class="mute"><b class="dim">${st.open.length}</b> batch${st.open.length === 1 ? '' : 'es'} in flight</span>
        ${raw(late ? `<span class="overdue"><b>${late}</b> overdue</span>` : '')}
        <span class="spacer" style="flex:1"></span>
        <button class="btn sm subtle" data-act="open">Open →</button>
      </div>
    </div>
  </section>`;
}

/* ---------- batches ----------------------------------------------------- */

function batchTable(list) {
  const s = S.get();
  const rows = list.slice().sort((a, b) => {
    const ao = batchStatus(a.status).open, bo = batchStatus(b.status).open;
    if (ao !== bo) return ao ? -1 : 1;                  // open work first
    return (a.dueOn || '9999').localeCompare(b.dueOn || '9999');
  });
  if (!rows.length) {
    return h`<div class="card"><div class="empty">
      ${icon('cash')}<h4>No batches</h4>
      <div class="tiny">A batch is one thing you have asked a studio to deliver, with a date and a price.</div>
    </div></div>`;
  }
  return h`
  <div class="card"><div class="tbl-wrap"><table class="tbl">
    <thead><tr>
      <th>Batch</th><th>Studio</th><th>Project</th><th>Qty</th>
      <th class="num">Agreed</th><th>PO</th><th>Due</th><th>Delivered</th><th>Status</th><th></th>
    </tr></thead>
    <tbody>${raw(rows.map(b => {
      const v = S.byId(vendors(), b.vendorId);
      const p = S.byId(s.projects, b.projectId);
      const bs = batchStatus(b.status);
      const overdue = bs.open && b.dueOn && b.dueOn < today() && !b.deliveredOn;
      const lateBy = b.deliveredOn && b.dueOn && b.deliveredOn > b.dueOn;
      const dv = S.byId(s.divisions, b.division);
      return `<tr data-b="${b.id}">
        <td data-act="b-edit" style="cursor:pointer">
          <div class="strong">${esc(b.title)}</div>
          <div class="tiny mute">${dv ? `<span class="pill-div" style="background:${dv.color}">${esc(dv.id)}</span> ` : ''}${b.revisions ? b.revisions + ' revision' + (b.revisions === 1 ? '' : 's') : ''}</div>
        </td>
        <td class="tiny">${v ? esc(v.name) : '<span class="mute">—</span>'}</td>
        <td>${p ? `<span class="chip" style="background:${p.color}22;color:${p.color}">${esc(p.code)}</span>` : '<span class="mute">—</span>'}</td>
        <td class="tiny nowrap">${b.qty || ''} ${esc(b.unit || '')}</td>
        <td class="num">${fmtMoney(b.agreedCost, sym())}</td>
        <td class="tiny mono">${b.poNumber ? esc(b.poNumber) : '<span class="chip warn">none</span>'}</td>
        <td class="tiny nowrap ${overdue ? 'overdue' : ''}">${b.dueOn ? esc(fmtDate(b.dueOn)) : '—'}
          ${bs.open && b.dueOn ? `<div class="mute">${esc(relDays(b.dueOn))}</div>` : ''}</td>
        <td class="tiny nowrap ${lateBy ? 'overdue' : ''}">${b.deliveredOn ? esc(fmtDate(b.deliveredOn)) + (lateBy ? ' late' : '') : '<span class="mute">—</span>'}</td>
        <td><span class="chip ${overdue ? 'risk' : bs.chip}">${overdue ? 'Overdue' : esc(bs.label)}</span></td>
        <td class="act"><button class="btn icon sm subtle" data-act="b-menu"><svg class="ico"><use href="#i-dots"></use></svg></button></td>
      </tr>`;
    }).join(''))}</tbody>
  </table></div></div>`;
}

/* ---------- vendor detail ----------------------------------------------- */

function vendorDetail(v, ctx) {
  const s = S.get();
  const st = vendorStats(v.id);
  const vs = vendorStatus(v.status);

  return h`
  <div class="row" style="margin-bottom:14px">
    <button class="btn subtle sm" data-act="back">← Outsourcing</button>
    <span class="avatar" style="background:${hashColor(v.name)}">${initials(v.name)}</span>
    <div style="flex:1">
      <h2 style="font-size:19px">${v.name}</h2>
      <div class="tiny mute">${v.country || '—'} · ${rateModel(v.rateModel).label}${v.rateValue ? ' · ' + fmtMoneyFull(v.rateValue, sym()) : ''}
        ${v.contactEmail ? ' · ' + v.contactEmail : ''}</div>
    </div>
    <span class="chip ${vs.chip}">${vs.label}</span>
    <button class="btn sm subtle" data-act="b-add">${icon('plus')}New batch</button>
    <button class="btn sm subtle" data-act="v-edit">${icon('edit')}Edit</button>
  </div>

  <div class="grid g4" style="margin-bottom:14px">
    <div class="card stat"><div class="k">On-time delivery</div>
      <div class="v">${st.onTimePct == null ? '—' : fmtPct(st.onTimePct)}</div>
      <div class="d">${st.closedCount} batch${st.closedCount === 1 ? '' : 'es'} delivered</div></div>
    <div class="card stat"><div class="k">Committed</div><div class="v">${fmtMoney(st.committed, sym())}</div>
      <div class="d">${fmtMoneyFull(st.committedOpen, sym())} still open</div></div>
    <div class="card stat"><div class="k">Booked in budget</div><div class="v">${fmtMoney(st.budgetSpend, sym())}</div>
      <div class="d">of ${fmtMoney(st.budgetPlanned, sym())} planned</div></div>
    <div class="card stat"><div class="k">Revisions per batch</div><div class="v">${st.avgRevisions.toFixed(1)}</div>
      <div class="d ${st.overdue.length ? 'down' : ''}">${st.overdue.length} overdue now</div></div>
  </div>

  ${raw(st.overdue.length ? `<div class="banner risk">
    <svg class="ico"><use href="#i-warn"></use></svg>
    <div><b>${st.overdue.length} batch${st.overdue.length === 1 ? ' is' : 'es are'} past the agreed date.</b>
    ${st.overdue.map(b => esc(b.title) + ' (due ' + esc(fmtDate(b.dueOn)) + ')').join(' · ')}</div></div>` : '')}

  ${raw(!v.msaSigned || !v.ndaSigned ? `<div class="banner warn">
    <svg class="ico"><use href="#i-warn"></use></svg>
    <div><b>Paperwork outstanding.</b>
    ${!v.ndaSigned ? 'No NDA on file. ' : ''}${!v.msaSigned ? 'No master service agreement. ' : ''}
    Worth settling before the next batch, not after.</div></div>` : '')}

  <div class="grid" style="grid-template-columns:1fr 340px">
    <div>${raw(batchTable(st.batches))}</div>
    <div class="col" style="gap:14px">
      <section class="card">
        <header><h3>Scorecard</h3><span class="sub">your judgement, not computed</span></header>
        <div class="body">
          ${raw([['quality', 'Quality'], ['onTime', 'Hits dates'], ['comms', 'Communication']].map(([k, label]) => `
            <div class="row" style="margin-bottom:9px" data-rate="${k}">
              <span class="tiny" style="flex:1">${label}</span>
              <input type="range" min="0" max="5" step="1" value="${v[k] || 0}" data-input="rate"
                     style="width:120px;flex:none">
              <b class="tiny" style="width:14px;text-align:center">${v[k] || 0}</b>
            </div>`).join(''))}
          <div class="sep"></div>
          <div class="tiny mute">On-time delivery above is measured from the batch dates.
          This slider is what you think, and the two disagreeing is worth noticing.</div>
        </div>
      </section>
      <section class="card">
        <header><h3>Contact &amp; notes</h3></header>
        <div class="body">
          <dl class="kv">
            <dt>Contact</dt><dd>${v.contactName || '—'}</dd>
            <dt>Email</dt><dd>${v.contactEmail || '—'}</dd>
            <dt>NDA</dt><dd>${v.ndaSigned ? 'signed' : 'not signed'}</dd>
            <dt>MSA</dt><dd>${v.msaSigned ? 'signed' : 'not signed'}</dd>
          </dl>
          ${raw(v.notes ? `<div class="sep"></div><div class="tiny" style="white-space:pre-wrap">${esc(v.notes)}</div>` : '')}
        </div>
      </section>
    </div>
  </div>`;
}

/* ---------- editors ----------------------------------------------------- */

async function editVendor(id) {
  const s = S.get();
  const v = id ? S.byId(s.vendors, id) : null;
  const res = await formDlg(v ? 'Edit studio' : 'Add studio', [
    { k: 'name', label: 'Studio / vendor name', value: v?.name || '', required: true, span: 7,
      hint: 'Match the vendor name on your outsourcing budget lines so spend links up' },
    { k: 'country', label: 'Country', value: v?.country || '', span: 5 },
    { k: 'status', label: 'Status', type: 'select', value: v?.status || 'trial', span: 4,
      opts: VENDOR_STATUS.map(x => ({ v: x.id, t: x.label })) },
    { k: 'rateModel', label: 'Rate model', type: 'select', value: v?.rateModel || 'per-asset', span: 4,
      opts: RATE_MODELS.map(x => ({ v: x.id, t: x.label })) },
    { k: 'rateValue', label: 'Rate', type: 'number', value: v?.rateValue ?? '', span: 4, min: 0,
      hint: 'Per asset, per day, or per month' },
    { k: 'contactName', label: 'Contact', value: v?.contactName || '', span: 6 },
    { k: 'contactEmail', label: 'Email', type: 'email', value: v?.contactEmail || '', span: 6 },
    { k: 'specialisms', label: 'Specialisms', value: (v?.specialisms || []).join(', '), span: 12,
      hint: 'Division codes, comma separated — e.g. 2D, 3D, ANIM' },
    { k: 'ndaSigned', label: 'NDA', type: 'checkbox', value: v ? !!v.ndaSigned : false, span: 6, cbLabel: 'NDA signed' },
    { k: 'msaSigned', label: 'MSA', type: 'checkbox', value: v ? !!v.msaSigned : false, span: 6, cbLabel: 'Master service agreement signed' },
    { k: 'notes', label: 'Notes', type: 'textarea', value: v?.notes || '', span: 12, rows: 3,
      hint: 'What you would tell the next producer who briefs them' },
  ], { ok: v ? 'Save' : 'Add', wide: true });
  if (!res) return false;

  const patch = {
    ...res,
    specialisms: String(res.specialisms || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean),
    rateValue: res.rateValue === null ? 0 : res.rateValue,
  };
  if (v) S.update('vendors', id, patch);
  else S.add('vendors', { ...patch, quality: 3, onTime: 3, comms: 3, currency: S.get().prefs.currency });
  toast('Studio saved', 'ok');
  return true;
}

async function editBatch(id, presetVendor) {
  const s = S.get();
  const b = id ? S.byId(s.outsourceBatches, id) : null;
  if (!vendors().length) { toast('Add a studio first — a batch belongs to one.', 'warn', 5000); return false; }

  const res = await formDlg(b ? 'Edit batch' : 'New batch', [
    { k: 'title', label: 'What are they delivering?', value: b?.title || '', required: true, span: 12,
      hint: 'One line, specific — "Autumn Drop props, batch 12", not "props"' },
    { k: 'vendorId', label: 'Studio', type: 'select', value: b?.vendorId || presetVendor || '', span: 6, required: true,
      opts: vendors().map(v => ({ v: v.id, t: v.name })) },
    { k: 'projectId', label: 'Project', type: 'select', value: b?.projectId || '', span: 6,
      opts: [{ v: '', t: 'None' }, ...s.projects.map(p => ({ v: p.id, t: p.name }))] },
    { k: 'division', label: 'Division', type: 'select', value: b?.division || '', span: 4,
      opts: [{ v: '', t: 'Not division-specific' }, ...s.divisions.map(d => ({ v: d.id, t: d.name }))] },
    { k: 'qty', label: 'Quantity', type: 'number', value: b?.qty ?? '', span: 4, min: 0 },
    { k: 'unit', label: 'Unit', value: b?.unit || '', span: 4, hint: 'props, icons, scenes, days' },
    { k: 'agreedCost', label: 'Agreed cost', type: 'number', value: b?.agreedCost ?? '', span: 6, min: 0 },
    { k: 'poNumber', label: 'PO number', value: b?.poNumber || '', span: 6,
      hint: 'Leave blank and it is flagged — work without a PO is a conversation with finance later' },
    { k: 'briefedOn', label: 'Briefed', type: 'date', value: b?.briefedOn || today(), span: 4 },
    { k: 'dueOn', label: 'Due', type: 'date', value: b?.dueOn || '', span: 4 },
    { k: 'deliveredOn', label: 'Delivered', type: 'date', value: b?.deliveredOn || '', span: 4,
      hint: 'Fill this in and the on-time figure updates itself' },
    { k: 'status', label: 'Status', type: 'select', value: b?.status || 'briefed', span: 6,
      opts: BATCH_STATUS.map(x => ({ v: x.id, t: x.label })) },
    { k: 'revisions', label: 'Revision rounds', type: 'number', value: b?.revisions ?? 0, span: 6, min: 0 },
    { k: 'notes', label: 'Notes', type: 'textarea', value: b?.notes || '', span: 12, rows: 2 },
  ], { ok: b ? 'Save' : 'Create', wide: true });
  if (!res) return false;

  if (res.dueOn && res.briefedOn && res.dueOn < res.briefedOn) {
    toast('The due date is before the brief date.', 'warn', 5000);
    return false;
  }
  if (b) S.update('outsourceBatches', id, res);
  else S.add('outsourceBatches', { ...res, acceptedOn: '' });
  toast('Batch saved', 'ok');
  return true;
}

function exportCsv() {
  const s = S.get();
  const rows = batches().map(b => ({
    Batch: b.title,
    Studio: S.byId(vendors(), b.vendorId)?.name || '',
    Project: S.byId(s.projects, b.projectId)?.code || '',
    Division: b.division || '',
    Qty: b.qty || '', Unit: b.unit || '',
    AgreedCost: b.agreedCost || '', PO: b.poNumber || '',
    Briefed: b.briefedOn || '', Due: b.dueOn || '', Delivered: b.deliveredOn || '',
    Status: b.status, Revisions: b.revisions || 0, Notes: b.notes || '',
  }));
  download(`gfx-outsourcing-${today()}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
  toast(`${rows.length} batches exported`, 'ok');
}

/* ---------- view -------------------------------------------------------- */

export default {
  id: 'outsourcing', title: 'Outsourcing', icon: 'handshake', group: 'money',
  subtitle: 'Studios, vendors and the batches they owe you',

  actions: ctx => [
    { label: 'New batch', icon: 'plus', primary: true, run: () => editBatch(null).then(r => r && ctx.rerender()) },
    { label: 'Add studio', icon: 'people', run: () => editVendor(null).then(r => r && ctx.rerender()) },
  ],

  render(host, ctx) {
    const s = S.get();
    const vid = ctx.params[0];
    const v = vid ? S.byId(s.vendors, vid) : null;

    if (v) {
      ctx.setCrumb(v.name);
      host.innerHTML = vendorDetail(v, ctx);
      wireDetail(host, ctx, v);
      return;
    }
    ctx.setCrumb('');

    const all = batches();
    const openB = all.filter(b => batchStatus(b.status).open);
    const overdue = openB.filter(b => b.dueOn && b.dueOn < today() && !b.deliveredOn);
    const noPo = openB.filter(b => !b.poNumber);
    const committedOpen = sum(openB, b => b.agreedCost || 0);
    const orphans = orphanVendorNames();

    const modes = [['studios', 'Studios'], ['batches', 'Batches']];

    host.innerHTML = h`
      <div class="grid g4" style="margin-bottom:14px">
        <div class="card stat"><div class="k">Active studios</div>
          <div class="v">${vendors().filter(x => x.status === 'active').length}</div>
          <div class="d">${vendors().filter(x => x.status === 'trial').length} on trial · ${vendors().length} total</div></div>
        <div class="card stat"><div class="k">Batches in flight</div><div class="v">${openB.length}</div>
          <div class="d ${overdue.length ? 'down' : ''}">${overdue.length} overdue</div></div>
        <div class="card stat"><div class="k">Committed, open</div><div class="v">${fmtMoney(committedOpen, sym())}</div>
          <div class="d">across ${new Set(openB.map(b => b.vendorId)).size} studio(s)</div></div>
        <div class="card stat"><div class="k">Missing a PO</div><div class="v">${noPo.length}</div>
          <div class="d ${noPo.length ? 'down' : ''}">${noPo.length ? 'raise these before work starts' : 'all covered'}</div></div>
      </div>

      ${raw(overdue.length ? `<div class="banner risk">
        <svg class="ico"><use href="#i-warn"></use></svg>
        <div><b>${overdue.length} batch${overdue.length === 1 ? '' : 'es'} past the agreed date.</b>
        ${overdue.slice(0, 4).map(b => esc(b.title) + ' — ' + esc(S.byId(vendors(), b.vendorId)?.name || '?') +
          ', due ' + esc(fmtDate(b.dueOn))).join(' · ')}</div></div>` : '')}

      ${raw(noPo.length ? `<div class="banner warn">
        <svg class="ico"><use href="#i-warn"></use></svg>
        <div><b>${noPo.length} open batch${noPo.length === 1 ? '' : 'es'} with no PO number.</b>
        ${noPo.slice(0, 3).map(b => esc(b.title)).join(' · ')} — work delivered against no PO becomes your problem at invoice time.</div></div>` : '')}

      ${raw(orphans.length ? `<div class="banner">
        <svg class="ico"><use href="#i-info"></use></svg>
        <div><b>${orphans.length} outsourcing budget line${orphans.length === 1 ? '' : 's'} name a studio with no record here:</b>
        ${orphans.map(o => esc(o.name) + ' (' + fmtMoney(o.planned, sym()) + ' planned)').join(' · ')}.
        Add them and their spend links up automatically.</div></div>` : '')}

      <div class="toolbar">
        <div class="seg">${raw(modes.map(([k, t]) => `<button data-act="mode" data-v="${k}" class="${ui.mode === k ? 'on' : ''}">${t}</button>`).join(''))}</div>
        <div class="search" style="width:220px">${icon('search')}
          <input type="search" id="oq" placeholder="Search studios or batches…" value="${ui.q}"></div>
        ${raw(ui.mode === 'studios' ? `
          <select data-change="f" data-k="status" style="width:auto">
            <option value="">Any status</option>
            ${VENDOR_STATUS.map(x => `<option value="${x.id}"${x.id === ui.status ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}
          </select>` : `
          <select data-change="f" data-k="project" style="width:auto">
            <option value="">All projects</option>
            ${s.projects.map(p => `<option value="${esc(p.id)}"${p.id === ui.project ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>`)}
        <div class="spacer" style="flex:1"></div>
        <button class="btn sm subtle" data-act="export">${icon('down')}CSV</button>
      </div>

      <div id="obody"></div>`;

    const body = host.querySelector('#obody');
    if (ui.mode === 'batches') {
      body.innerHTML = batchTable(filteredBatches());
    } else {
      const list = filteredVendors();
      body.innerHTML = list.length
        ? h`<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(380px,1fr))">${raw(list.map(vendorCard).join(''))}</div>`
        : h`<div class="card"><div class="empty">
            ${icon('handshake')}<h4>${ui.q || ui.status ? 'No studios match' : 'No studios yet'}</h4>
            <div class="tiny">${ui.q || ui.status ? 'Clear the filters above.' : 'Add the studios you outsource to, then log a batch against one.'}</div>
          </div></div>`;
    }

    const oq = host.querySelector('#oq');
    let t;
    oq.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { ui.q = oq.value; saveUi(); ctx.rerender(); }, 220); });

    acts(host, {
      mode: el => { ui.mode = el.dataset.v; saveUi(); ctx.rerender(); },
      f: el => { ui[el.dataset.k] = el.value; saveUi(); ctx.rerender(); },
      export: exportCsv,
      open: el => ctx.go('outsourcing', el.closest('[data-id]').dataset.id),
      'v-menu': (el, ev) => vendorMenu(el.closest('[data-id]').dataset.id, ev, ctx),
      'b-edit': el => editBatch(el.closest('[data-b]').dataset.b).then(r => r && ctx.rerender()),
      'b-menu': (el, ev) => batchMenu(el.closest('[data-b]').dataset.b, ev, ctx),
    });
  },
};

function wireDetail(host, ctx, v) {
  acts(host, {
    back: () => ctx.go('outsourcing'),
    'v-edit': () => editVendor(v.id).then(r => r && ctx.rerender()),
    'b-add': () => editBatch(null, v.id).then(r => r && ctx.rerender()),
    'b-edit': el => editBatch(el.closest('[data-b]').dataset.b).then(r => r && ctx.rerender()),
    'b-menu': (el, ev) => batchMenu(el.closest('[data-b]').dataset.b, ev, ctx),
    rate: el => {
      const key = el.closest('[data-rate]').dataset.rate;
      S.mutate(s => { S.byId(s.vendors, v.id)[key] = +el.value || 0; }, { label: 'vendor rating', silent: true });
      el.nextElementSibling.textContent = el.value;
    },
  });
}

function vendorMenu(id, ev, ctx) {
  const v = S.byId(S.get().vendors, id);
  menu(ev, [
    { label: 'Open', icon: 'eye', run: () => ctx.go('outsourcing', id) },
    { label: 'Edit…', icon: 'edit', run: () => editVendor(id).then(r => r && ctx.rerender()) },
    { label: 'New batch…', icon: 'plus', run: () => editBatch(null, id).then(r => r && ctx.rerender()) },
    '-',
    ...VENDOR_STATUS.filter(x => x.id !== v.status).map(x => ({
      label: 'Mark ' + x.label.toLowerCase(), icon: 'check',
      run: () => { S.update('vendors', id, { status: x.id }); ctx.rerender(); },
    })),
    '-',
    { label: 'Delete', icon: 'trash', danger: true, run: async () => {
      const n = (S.get().outsourceBatches || []).filter(b => b.vendorId === id).length;
      if (!await confirmDlg(
        n ? `Delete ${v.name}? Its ${n} batch record${n === 1 ? '' : 's'} go too.`
          : `Delete ${v.name}?`, { ok: 'Delete' })) return;
      S.mutate(s => {
        s.vendors = s.vendors.filter(x => x.id !== id);
        s.outsourceBatches = (s.outsourceBatches || []).filter(b => b.vendorId !== id);
      }, { label: 'delete vendor' });
      ctx.go('outsourcing');
    } },
  ]);
}

function batchMenu(id, ev, ctx) {
  const b = S.byId(S.get().outsourceBatches, id);
  menu(ev, [
    { label: 'Edit…', icon: 'edit', run: () => editBatch(id).then(r => r && ctx.rerender()) },
    ...(b.deliveredOn ? [] : [{ label: 'Mark delivered today', icon: 'check', run: () => {
      S.update('outsourceBatches', id, { deliveredOn: today(), status: 'in-review' });
      toast('Marked delivered — on-time figures updated', 'ok'); ctx.rerender();
    } }]),
    ...(b.status === 'accepted' ? [] : [{ label: 'Accept', icon: 'check', run: () => {
      S.update('outsourceBatches', id, { status: 'accepted', acceptedOn: today(), deliveredOn: b.deliveredOn || today() });
      ctx.rerender();
    } }]),
    { label: 'Add a revision round', icon: 'refresh', run: () => {
      S.update('outsourceBatches', id, { revisions: (b.revisions || 0) + 1, status: 'revisions' });
      ctx.rerender();
    } },
    '-',
    { label: 'Delete', icon: 'trash', danger: true, run: async () => {
      if (!await confirmDlg(`Delete “${b.title}”?`, { ok: 'Delete' })) return;
      S.remove('outsourceBatches', id); ctx.rerender();
    } },
  ]);
}
