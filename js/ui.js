/* ============================================================================
   ui.js — the small toolkit every view is built from.

   No inline onclick anywhere in this app. Handlers are attached by delegation
   on data-attributes, which sidesteps the whole class of bugs where an
   apostrophe in a name silently breaks a generated handler.
   ========================================================================= */

import { richEditor, wireRich, readRich } from './richtext.js';

/* ---------- escaping & templating ---------------------------------------- */

export const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** tagged template that escapes interpolations; wrap with raw() to opt out */
export function h(strings, ...vals) {
  return strings.reduce((out, s, i) => {
    if (i === 0) return s;
    const v = vals[i - 1];
    const piece = v && v.__raw ? v.html
      : Array.isArray(v) ? v.map(x => (x && x.__raw ? x.html : esc(x))).join('')
      : esc(v);
    return out + piece + s;
  });
}
/**
 * Mark a string as already-safe HTML.
 *
 * `toString` matters: these objects get interpolated into ordinary template
 * strings as well as into h``, and without it those render as
 * "[object Object]" — visible, but only if you happen to look at that exact
 * button. One method here removes the whole class of bug.
 */
export const raw = html => ({
  __raw: true,
  html: String(html ?? ''),
  toString() { return this.html; },
});

export const icon = (name, cls = 'ico') => raw(`<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`);

/* ---------- DOM ---------------------------------------------------------- */

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** delegated listener: on(root, '[data-act="x"]', 'click', (el, ev) => …) */
export function on(root, sel, type, fn) {
  root.addEventListener(type, ev => {
    const el = ev.target.closest(sel);
    if (el && root.contains(el)) fn(el, ev);
  });
}

/*
 * A tick box must be allowed to tick.
 *
 * `preventDefault()` on a checkbox's click event cancels the state change: the
 * browser puts `checked` back after the handler has run. Every `data-act`
 * checkbox in the app was affected, and it went unnoticed for as long as it
 * did because those handlers all re-rendered — the box was rebuilt from state,
 * so it looked right. The moment one updated in place instead (selecting a
 * task on the board) the tick stopped appearing.
 *
 * So the default is only suppressed where suppressing it is the point: links
 * and buttons that would navigate or submit.
 */
const KEEPS_DEFAULT = el =>
  el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');

/** wire every [data-act] inside root to a map of handlers */
export function acts(root, map) {
  on(root, '[data-act]', 'click', (el, ev) => {
    const fn = map[el.dataset.act];
    if (!fn) return;
    if (!KEEPS_DEFAULT(ev.target)) ev.preventDefault();
    fn(el, ev);
  });
  on(root, '[data-change]', 'change', (el, ev) => {
    const fn = map[el.dataset.change];
    if (fn) fn(el, ev);
  });
  on(root, '[data-input]', 'input', (el, ev) => {
    const fn = map[el.dataset.input];
    if (fn) fn(el, ev);
  });
}

/* ---------- dates -------------------------------------------------------- */

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOW = ['S','M','T','W','T','F','S'];

export const toDate  = iso => (iso ? new Date(iso + (iso.length === 10 ? 'T00:00:00' : '')) : null);
export const isoOf   = dt  => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
export const today   = () => isoOf(new Date());
export const monthOf = iso => (iso || '').slice(0, 7);
export const addDays = (iso, n) => { const d = toDate(iso); d.setDate(d.getDate() + n); return isoOf(d); };
/** Accepts 'YYYY-MM' or 'YYYY-MM-DD', always returns 'YYYY-MM'.
    Both forms are passed in from several call sites; being strict here once
    cost an afternoon of invalid dates propagating silently. */
export const addMonths = (ym, n) => {
  const [y, m] = String(ym).slice(0, 7).split('-').map(Number);
  const d = new Date(y, (m - 1) + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
export const dayIdx  = iso => toDate(iso).getDay();
export const isWeekend = iso => [0, 6].includes(dayIdx(iso));

export function daysBetween(a, b) {
  if (!a || !b) return 0;
  return Math.round((toDate(b) - toDate(a)) / 86400000);
}
export function eachDay(from, to) {
  const out = []; let c = from;
  let guard = 0;
  while (c <= to && guard++ < 2000) { out.push(c); c = addDays(c, 1); }
  return out;
}
export function fmtDate(iso, style = 'short') {
  if (!iso) return '—';
  const d = toDate(iso);
  if (isNaN(d)) return '—';
  if (style === 'long')  return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`;
  if (style === 'month') return `${MON[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
  if (style === 'dow')   return `${DOW[d.getDay()]}`;
  return `${d.getDate()} ${MON[d.getMonth()]}`;
}
export function fmtMonth(ym) {
  const [y, m] = ym.split('-');
  return `${MON[+m - 1]} ${String(y).slice(2)}`;
}
export function relDays(iso) {
  if (!iso) return '';
  const n = daysBetween(today(), iso);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n < 0 ? `${-n}d overdue` : `in ${n}d`;
}
export function quarterOf(iso) {
  const d = toDate(iso || today());
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
}

/** working days between two ISO dates, honouring weekends + holiday list */
export function workingDays(from, to, holidays = [], workDays = [1, 2, 3, 4, 5]) {
  const hol = new Set(holidays.map(x => x.date || x));
  return eachDay(from, to).filter(dt => workDays.includes(dayIdx(dt)) && !hol.has(dt)).length;
}

/* ---------- numbers ------------------------------------------------------ */

export function fmtMoney(n, sym = '$', dp = 0) {
  if (n == null || isNaN(n)) return '—';
  const neg = n < 0; const a = Math.abs(n);
  const s = a >= 1_000_000 ? (a / 1_000_000).toFixed(a >= 10_000_000 ? 1 : 2) + 'M'
          : a >= 10_000    ? Math.round(a / 1000) + 'k'
          : a.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return (neg ? '−' : '') + sym + s;
}
export const fmtMoneyFull = (n, sym = '$') =>
  (n < 0 ? '−' : '') + sym + Math.abs(Math.round(n || 0)).toLocaleString();
export const fmtNum = (n, dp = 0) => (n == null || isNaN(n) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: dp }));
export const fmtPct = (n, dp = 0) => (n == null || isNaN(n) ? '—' : `${Number(n).toFixed(dp)}%`);
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const sum = (arr, f = x => x) => (arr || []).reduce((a, b) => a + (Number(f(b)) || 0), 0);
export const groupBy = (arr, f) => (arr || []).reduce((m, x) => { const k = f(x); (m[k] ||= []).push(x); return m; }, {});
export const initials = name => String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

/** deterministic pleasant colour from a string — used for avatars */
export function hashColor(str) {
  let x = 0; for (const c of String(str)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  const hues = [206, 262, 340, 22, 160, 288, 12, 190, 44, 320];
  return `hsl(${hues[x % hues.length]} 52% 46%)`;
}

/* ---------- toasts ------------------------------------------------------- */

export function toast(msg, kind = '', ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = h`${icon(kind === 'err' ? 'warn' : kind === 'ok' ? 'check' : 'info')}<span>${msg}</span>`;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(14px)'; setTimeout(() => el.remove(), 200); }, ms);
  return el;
}

/* ---------- dialogs ------------------------------------------------------ */

let openDlg = null;

/**
 * dialog({title, body, footer, wide, onMount}) → Promise<any>
 * Resolve by calling close(value) — available on the returned handle and
 * passed to onMount.
 */
export function dialog({ title, body = '', footer = null, wide = false, onMount, dismissable = true }) {
  return new Promise(resolve => {
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML = `
      <div class="dlg ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        <header>
          <h3></h3>
          <button class="btn icon subtle" data-x title="Close"><svg class="ico"><use href="#i-x"></use></svg></button>
        </header>
        <div class="body"></div>
        ${footer === null ? '' : '<footer></footer>'}
      </div>`;
    scrim.querySelector('h3').textContent = title || '';
    const bodyEl = scrim.querySelector('.body');
    if (body instanceof Node) bodyEl.appendChild(body); else bodyEl.innerHTML = body;
    if (footer !== null) scrim.querySelector('footer').innerHTML = footer;

    const close = v => {
      if (!scrim.isConnected) return;
      scrim.remove(); openDlg = null;
      document.removeEventListener('keydown', key);
      resolve(v);
    };
    const key = e => {
      if (e.key === 'Escape' && dismissable) { e.stopPropagation(); close(undefined); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) scrim.querySelector('[data-ok]')?.click();
    };
    scrim.querySelector('[data-x]').onclick = () => close(undefined);
    if (dismissable) scrim.addEventListener('mousedown', e => { if (e.target === scrim) close(undefined); });
    document.addEventListener('keydown', key);

    document.body.appendChild(scrim);
    openDlg = { close };
    // focus the first sensible control
    const first = scrim.querySelector('input:not([type=hidden]), textarea, select, [data-ok]');
    setTimeout(() => first?.focus(), 30);
    onMount?.({ root: scrim.querySelector('.dlg'), body: bodyEl, close });
  });
}
export const closeDialog = v => openDlg?.close(v);

export function confirmDlg(msg, { title = 'Are you sure?', ok = 'Confirm', danger = true } = {}) {
  return dialog({
    title, body: `<p>${esc(msg)}</p>`,
    footer: `<button class="btn" data-no>Cancel</button>
             <button class="btn ${danger ? 'danger' : 'primary'}" data-ok data-yes>${esc(ok)}</button>`,
    onMount: ({ root, close }) => {
      root.querySelector('[data-no]').onclick = () => close(false);
      root.querySelector('[data-yes]').onclick = () => close(true);
    },
  }).then(v => v === true);
}

/** a form dialog. fields: [{k, label, type, opts, value, hint, required, span}] */
export function formDlg(title, fields, { ok = 'Save', wide = false, extra = '' } = {}) {
  const inputs = fields.map(f => {
    const id = 'f_' + f.k;
    let ctl;
    if (f.type === 'select') {
      ctl = `<select id="${id}">${(f.opts || []).map(o =>
        `<option value="${esc(o.v)}"${String(o.v) === String(f.value ?? '') ? ' selected' : ''}>${esc(o.t)}</option>`).join('')}</select>`;
    } else if (f.type === 'textarea' || f.type === 'rich') {
      /*
       * Every multi-line field is a rich editor now. `textarea` is kept as a
       * synonym rather than chased through a dozen call sites, so anything
       * that asked for one gets bold, bullets and Tab-to-indent for free —
       * which is what "everywhere I can write" has to mean to be true.
       */
      ctl = richEditor({ value: f.value ?? '', name: f.k, rows: f.rows || 4, placeholder: f.ph || '' });
    } else if (f.type === 'checkbox') {
      ctl = `<label class="row" style="gap:7px;font-weight:400"><input type="checkbox" id="${id}"${f.value ? ' checked' : ''}><span>${esc(f.cbLabel || '')}</span></label>`;
    } else {
      ctl = `<input type="${f.type || 'text'}" id="${id}" value="${esc(f.value ?? '')}" placeholder="${esc(f.ph || '')}"${f.step ? ` step="${f.step}"` : ''}${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''}>`;
    }
    return `<label class="fld" style="grid-column:span ${f.span || 12}">
              <span>${esc(f.label)}${f.required ? ' *' : ''}</span>${ctl}
              ${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}
            </label>`;
  }).join('');

  return dialog({
    title, wide,
    body: `<div style="display:grid;grid-template-columns:repeat(12,1fr);gap:0 12px">${inputs}</div>${extra}`,
    footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-ok>${esc(ok)}</button>`,
    onMount: ({ root, close }) => {
      wireRich(root);
      root.querySelector('[data-no]').onclick = () => close(undefined);
      root.querySelector('[data-ok]').onclick = () => {
        const out = {};
        for (const f of fields) {
          const rich = f.type === 'textarea' || f.type === 'rich';
          const el = rich ? root.querySelector(`.rt[data-rt-name="${f.k}"] .rt-body`)
                          : root.querySelector('#f_' + f.k);
          let v = rich ? readRich(root, f.k) : (f.type === 'checkbox' ? el.checked : el.value);
          if (f.type === 'number') v = v === '' ? null : Number(v);
          if (f.required && (v === '' || v == null)) { el.focus(); toast(`${f.label} is required`, 'warn'); return; }
          out[f.k] = v;
        }
        close(out);
      };
    },
  });
}

/* ---------- context menu ------------------------------------------------- */

export function menu(anchorEv, items) {
  document.querySelector('.menu')?.remove();
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = items.map(it => it === '-' ? '<hr>' :
    `<button data-i="${items.indexOf(it)}" class="${it.danger ? 'danger' : ''}">
       ${it.icon ? `<svg class="ico" style="width:15px;height:15px"><use href="#i-${it.icon}"></use></svg>` : '<span style="width:15px"></span>'}
       <span>${esc(it.label)}</span></button>`).join('');
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  const x = Math.min(anchorEv.clientX, innerWidth - r.width - 8);
  const y = Math.min(anchorEv.clientY, innerHeight - r.height - 8);
  m.style.left = x + 'px'; m.style.top = y + 'px';
  m.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    m.remove(); items[+b.dataset.i]?.run?.();
  });
  const away = e => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', away); } };
  setTimeout(() => document.addEventListener('mousedown', away), 0);
}

/* ---------- files -------------------------------------------------------- */

export function download(name, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/**
 * Save bytes, not text. `download()` stringifies whatever it is given, which
 * would turn a workbook into the literal text "[object ArrayBuffer]".
 */
export function downloadBlob(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/**
 * Pick a file and read it as bytes. Separate from `pickFile` because
 * `readAsText` on a .xlsx (which is a ZIP) mangles it beyond recovery.
 */
export function pickBinaryFile(accept = '.xlsx') {
  return new Promise(res => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = accept;
    i.onchange = async () => {
      const f = i.files[0]; if (!f) return res(null);
      try {
        res({ name: f.name, size: f.size, buf: await f.arrayBuffer(),
              file: f, lastModified: f.lastModified });
      } catch (e) { res({ name: f.name, error: e.message }); }
    };
    i.click();
  });
}

export function pickFile(accept = '.json,.csv,.txt,.md') {
  return new Promise(res => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = accept;
    i.onchange = () => {
      const f = i.files[0]; if (!f) return res(null);
      const r = new FileReader();
      r.onload = () => res({ name: f.name, text: r.result, size: f.size, file: f });
      r.readAsText(f);
    };
    i.click();
  });
}

/* ---------- CSV ---------------------------------------------------------- */

export function toCsv(rows, headers) {
  const cols = headers || Object.keys(rows[0] || {});
  const q = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(','), ...rows.map(r => cols.map(c => q(r[c])).join(','))].join('\r\n');
}

export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const head = rows.shift().map(x => x.trim());
  return rows.filter(r => r.some(x => x.trim() !== ''))
             .map(r => Object.fromEntries(head.map((k, i) => [k, (r[i] ?? '').trim()])));
}

/* ---------- charts (hand-rolled SVG, no library) ------------------------- */

const SVG_W = 640;

/** grouped/stacked column chart */
export function barChart({ labels, series, height = 180, money = false, sym = '$', stacked = false }) {
  const pad = { l: 46, r: 8, t: 10, b: 22 };
  const w = SVG_W, h = height;
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const totals = labels.map((_, i) => stacked ? sum(series, s => s.values[i] || 0) : Math.max(...series.map(s => s.values[i] || 0)));
  const max = Math.max(1, ...totals) * 1.12;
  const y = v => pad.t + ih - (v / max) * ih;
  const bw = iw / labels.length;
  const inner = bw * 0.62;
  const fmt = v => money ? fmtMoney(v, sym) : fmtNum(v);

  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = max * i / 4;
    g += `<line class="gridline" x1="${pad.l}" x2="${w - pad.r}" y1="${y(v)}" y2="${y(v)}"/>
          <text x="${pad.l - 6}" y="${y(v) + 3.5}" text-anchor="end">${fmt(v)}</text>`;
  }
  let bars = '';
  labels.forEach((lb, i) => {
    const x0 = pad.l + i * bw + (bw - inner) / 2;
    if (stacked) {
      let acc = 0;
      series.forEach(s => {
        const v = s.values[i] || 0; if (!v) return;
        const yy = y(acc + v), hh = y(acc) - y(acc + v);
        bars += `<rect x="${x0}" y="${yy}" width="${inner}" height="${Math.max(0, hh)}" fill="${s.color}" rx="1.5"><title>${esc(s.name)} · ${esc(lb)}: ${fmt(v)}</title></rect>`;
        acc += v;
      });
    } else {
      const sw = inner / series.length;
      series.forEach((s, j) => {
        const v = s.values[i] || 0;
        bars += `<rect x="${x0 + j * sw}" y="${y(v)}" width="${Math.max(1, sw - 1.5)}" height="${Math.max(0, pad.t + ih - y(v))}" fill="${s.color}" rx="1.5"><title>${esc(s.name)} · ${esc(lb)}: ${fmt(v)}</title></rect>`;
      });
    }
    bars += `<text x="${pad.l + i * bw + bw / 2}" y="${h - 6}" text-anchor="middle">${esc(lb)}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="height:${h}px">
            ${g}<line class="axis" x1="${pad.l}" x2="${w - pad.r}" y1="${pad.t + ih}" y2="${pad.t + ih}"/>${bars}</svg>`;
}

/** multi-series line chart with optional filled area on the first series */
export function lineChart({ labels, series, height = 190, money = true, sym = '$' }) {
  const pad = { l: 50, r: 10, t: 10, b: 22 };
  const w = SVG_W, h = height;
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const all = series.flatMap(s => s.values.filter(v => v != null));
  const max = Math.max(1, ...all) * 1.12;
  const x = i => pad.l + (labels.length === 1 ? iw / 2 : (i / (labels.length - 1)) * iw);
  const y = v => pad.t + ih - (v / max) * ih;
  const fmt = v => money ? fmtMoney(v, sym) : fmtNum(v);

  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = max * i / 4;
    g += `<line class="gridline" x1="${pad.l}" x2="${w - pad.r}" y1="${y(v)}" y2="${y(v)}"/>
          <text x="${pad.l - 6}" y="${y(v) + 3.5}" text-anchor="end">${fmt(v)}</text>`;
  }
  let paths = '';
  series.forEach(s => {
    const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)])).filter(Boolean);
    if (!pts.length) return;
    const dline = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    if (s.area) {
      paths += `<path d="${dline} L ${pts.at(-1)[0].toFixed(1)} ${(pad.t + ih)} L ${pts[0][0].toFixed(1)} ${(pad.t + ih)} Z" fill="${s.color}" opacity=".13"/>`;
    }
    paths += `<path d="${dline}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ' stroke-dasharray="4 3"' : ''}/>`;
    paths += s.values.map((v, i) => v == null ? '' :
      `<circle cx="${x(i)}" cy="${y(v)}" r="2.6" fill="${s.color}"><title>${esc(s.name)} · ${esc(labels[i])}: ${fmt(v)}</title></circle>`).join('');
  });
  const xl = labels.map((lb, i) => (labels.length > 14 && i % 2) ? '' :
    `<text x="${x(i)}" y="${h - 6}" text-anchor="middle">${esc(lb)}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="height:${h}px">
            ${g}<line class="axis" x1="${pad.l}" x2="${w - pad.r}" y1="${pad.t + ih}" y2="${pad.t + ih}"/>${paths}${xl}</svg>`;
}

/** donut with a centre caption */
export function donut(segments, { size = 132, caption = '', sub = '' } = {}) {
  const total = sum(segments, s => s.value) || 1;
  const r = size / 2 - 11, c = 2 * Math.PI * r, cx = size / 2;
  let off = 0;
  const rings = segments.filter(s => s.value > 0).map(s => {
    const len = (s.value / total) * c;
    const el = `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${s.color}" stroke-width="15"
                 stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"
                 transform="rotate(-90 ${cx} ${cx})"><title>${esc(s.name)}: ${fmtNum(s.value)}</title></circle>`;
    off += len; return el;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${size} ${size}" style="width:${size}px;height:${size}px;flex:none">
    <circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="var(--bg-sunken)" stroke-width="15"/>
    ${rings}
    <text x="${cx}" y="${cx - 1}" text-anchor="middle" style="font-size:17px;font-weight:650" fill="var(--text)">${esc(caption)}</text>
    <text x="${cx}" y="${cx + 14}" text-anchor="middle" style="font-size:9.5px">${esc(sub)}</text></svg>`;
}

export function sparkline(values, { w = 100, h = 26, color = 'var(--accent)' } = {}) {
  if (!values.length) return '';
  const max = Math.max(...values, 1), min = Math.min(...values, 0);
  const rng = max - min || 1;
  const pts = values.map((v, i) => [i / (values.length - 1) * w, h - ((v - min) / rng) * (h - 3) - 1.5]);
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" style="width:${w}px;height:${h}px">
    <path d="${pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ')}"
      fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}

/* ---------- small render helpers ----------------------------------------- */

export const avatar = (name, cls = '') =>
  raw(`<span class="avatar ${cls}" style="background:${hashColor(name)}" title="${esc(name)}">${esc(initials(name))}</span>`);

export const bar = (pct, cls = '') =>
  raw(`<span class="bar"><i class="${cls}" style="width:${clamp(pct, 0, 100).toFixed(1)}%"></i></span>`);

export const emptyState = (title, sub, act = '') => h`
  <div class="empty">
    ${icon('note')}
    <h4>${title}</h4>
    <div class="tiny">${sub}</div>
    ${raw(act)}
  </div>`;
