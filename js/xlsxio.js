/**
 * Excel in, Excel out.
 *
 * Three jobs, kept separate on purpose:
 *
 *   buildWorkbook()  state  -> .xlsx bytes
 *   readWorkbook()   bytes  -> plain rows, nothing interpreted yet
 *   planImport()     rows   -> a diff you can look at before anything changes
 *
 * The split matters. An import that writes as it parses cannot be reviewed and
 * cannot be aborted halfway without leaving the data in a state that is
 * neither the old one nor the new one. So parsing never touches the store;
 * `planImport` is pure; and `applyPlan` is the only thing that mutates, in one
 * `mutate()` call, which means one undo step reverses the whole import.
 */

import * as S from './store.js';
import {
  SHEETS, WORKBOOKS, sheetsOf, workbookOf, allWorkbooks, inScope,
  VOCAB, vocabList, vocabsUsed, retiredFile,
} from './xlsxschema.js';
import { BUILD } from './version.js';
import { richToText } from './richtext.js';

/* Bumped only when a column layout changes in a way old files cannot satisfy.
   Written into every workbook so a stale template can be recognised.

   2 — the nine workbooks became four. Everything about a person moved into
       01_People.xlsx, the child sheets are joined by Person rather than by a
       copied id, and Leave's `PersonID` column is now `Person`. */
export const SCHEMA_VERSION = 2;

/* The sheet that feeds every drop-down. Written by the exporter, ignored by
   the importer — editing it changes nothing, because the vocabularies live in
   the app. */
export const DATA_SHEET = '_Data';

/* ---------- the library -------------------------------------------------- */

let libPromise = null;

/**
 * Load SheetJS on first use.
 *
 * Vendored at `vendor/xlsx.full.min.js` rather than pulled from a CDN: this
 * runs in a Teams tab on a managed machine, and a blocked third-party request
 * would fail at the exact moment someone is trying to import their roster.
 * ~880 KB, so it is loaded here and not by the app shell.
 */
export function loadLib() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (libPromise) return libPromise;

  libPromise = new Promise((res, rej) => {
    const s = document.createElement('script');
    // Relative to index.html, so it works at a repo sub-path on GitHub Pages.
    s.src = 'vendor/xlsx.full.min.js';
    s.onload = () => (window.XLSX
      ? res(window.XLSX)
      : rej(new Error('The spreadsheet library loaded but did not initialise.')));
    s.onerror = () => {
      libPromise = null;   // let the next attempt retry rather than fail forever
      rej(new Error('Could not load vendor/xlsx.full.min.js. If the app was ' +
                    'just updated, use Settings > About > Check for updates.'));
    };
    document.head.appendChild(s);
  });
  return libPromise;
}

export const libReady = () => !!window.XLSX;

/* ---------- reference resolution ----------------------------------------- */

/*
 * Excel columns hold what a human recognises — a person's name, a project
 * code, a studio name — while the state holds ids. These two tables are the
 * only place that mapping lives.
 */

const REFS = {
  people:    { coll: 'people',    label: r => r.name, keys: r => [r.name, r.email, r.id],
               noun: 'person',   sheet: 'People',    wants: 'a person Name' },
  projects:  { coll: 'projects',  label: r => r.code, keys: r => [r.code, r.name, r.id],
               noun: 'project',  sheet: 'Projects',  wants: 'a project Code' },
  vendors:   { coll: 'vendors',   label: r => r.name, keys: r => [r.name, r.id],
               noun: 'studio',   sheet: 'Vendors',   wants: 'a studio Name' },
  divisions: { coll: 'divisions', label: r => r.id,   keys: r => [r.id, r.name],
               noun: 'division', sheet: 'Divisions', wants: 'a division ID' },
  /* A task's objective. Matched on the title, because that is the only thing
     about an objective a person would type — and titles are long enough to be
     unambiguous in practice. */
  objectives: { coll: 'objectives', label: r => r.title, keys: r => [r.title, r.id],
                noun: 'objective', sheet: 'Objectives', wants: 'an objective Title' },
};

const norm = v => String(v ?? '').trim().toLowerCase();

function refIndex(state, kind) {
  const spec = REFS[kind];
  const map = new Map();
  for (const rec of state[spec.coll] || []) {
    for (const k of spec.keys(rec)) if (k) map.set(norm(k), rec.id);
  }
  return map;
}

/** Every ref index a sheet set might need, built once per import. */
function refIndexes(state) {
  const out = {};
  for (const k of Object.keys(REFS)) out[k] = refIndex(state, k);
  return out;
}

/**
 * id -> the label a human would recognise.
 *
 * A dangling id exports as blank, not as the raw id. Writing `pe_you` into a
 * Lead column looks like data but is not: the record is gone, so re-importing
 * it can only fail. Real case — the seeded divisions kept `lead: 'pe_you'`
 * after the sample roster was cleared, and exporting those ids would have made
 * all five Divisions rows un-importable. Blank is honest, and importing it
 * clears the dead pointer.
 */
function refLabel(state, kind, id) {
  if (!id) return '';
  const spec = REFS[kind];
  const rec = (state[spec.coll] || []).find(r => r.id === id);
  return rec ? String(spec.label(rec) ?? '') : '';
}

/* ---------- cell conversion ---------------------------------------------- */

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Excel hands back dates as Date, as a serial number, or as text. Take all three. */
function toIso(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date && !isNaN(v)) {
    // Built with cellDates, so this is already local midnight. Formatting it
    // by hand avoids toISOString() shifting it a day backwards in UTC+7.
    const p = n => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = String(v).trim();
  if (ISO.test(s)) return s;
  if (/^\d{4}-\d{2}$/.test(s)) return s + '-01';
  // Excel serial: days since 1899-12-30.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    if (!isNaN(d)) {
      const p = n => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
    }
  }
  const d = new Date(s);
  if (!isNaN(d)) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return '';   // unparseable; caller records a warning
}

const TRUEISH  = new Set(['true', 'yes', 'y', '1', 'x', 'signed', 'active']);
const FALSEISH = new Set(['false', 'no', 'n', '0', '', '-']);

/** state value -> cell value */
function toCell(col, rec, state) {
  /* A derived column may read something a plain field name cannot reach — a
     value nested inside another object, say. It is ignored on import either
     way, so there is nothing to write back. */
  if (typeof col.get === 'function') {
    const g = col.get(rec, state);
    return g == null ? '' : g;
  }
  const v = rec[col.f];
  switch (col.t) {
    case 'num':  return (v === '' || v == null || isNaN(v)) ? '' : Number(v);
    case 'bool': return v === true || v === 'true' ? true : v === false || v == null ? false : !!v;
    case 'date': return v ? String(v) : '';
    case 'list': return Array.isArray(v) ? v.join(', ') : String(v ?? '');
    /*
     * A note written with bold and bullets goes into the cell as readable
     * text — nobody wants markup tags in a spreadsheet. The import side then
     * has to be careful not to read that back as a change; see planFlat.
     */
    case 'rich': return richToText(v);
    default:
      if (col.t.startsWith('ref:')) return refLabel(state, col.t.slice(4), v);
      return v == null ? '' : String(v);
  }
}

/**
 * A column's allowed values, whether it lists them or works them out.
 *
 * `enum` was always a fixed array, which was fine while every vocabulary was
 * a constant in the source. The work-breakdown divisions now come from the
 * roster, so the list has to be read at the moment it is needed rather than
 * frozen when the module loaded.
 */
const enumOf = col => (typeof col.enum === 'function' ? col.enum() : col.enum);

/**
 * cell value -> state value.
 * @returns {{ok:true,value:*}|{ok:false,why:string}}
 */
function fromCell(col, raw, idx) {
  const blank = raw == null || String(raw).trim() === '';

  switch (col.t) {
    case 'num': {
      if (blank) return { ok: true, value: 0 };
      const n = Number(String(raw).replace(/[\s,]/g, '').replace(/[^\d.eE+-]/g, ''));
      return isNaN(n) ? { ok: false, why: `${col.h}: "${raw}" is not a number` }
                      : { ok: true, value: n };
    }
    case 'bool': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      const s = norm(raw);
      if (TRUEISH.has(s))  return { ok: true, value: true };
      if (FALSEISH.has(s)) return { ok: true, value: false };
      return { ok: false, why: `${col.h}: "${raw}" is not TRUE or FALSE` };
    }
    case 'date': {
      if (blank) return { ok: true, value: '' };
      const iso = toIso(raw);
      return iso ? { ok: true, value: iso }
                 : { ok: false, why: `${col.h}: "${raw}" is not a date I can read` };
    }
    case 'list':
      return { ok: true, value: blank ? []
        : String(raw).split(/[,;]/).map(s => s.trim()).filter(Boolean) };
    default: {
      if (col.t.startsWith('ref:')) {
        const kind = col.t.slice(4);
        if (blank) return { ok: true, value: col.req ? null : '' };
        const id = idx[kind]?.get(norm(raw));
        if (id) return { ok: true, value: id };
        /*
         * A required pointer that does not resolve is fatal — a batch with no
         * studio, or leave with no person, is not a record. An optional one is
         * not: losing the whole row would throw away the division's name and
         * colour because its Lead had left. Clear the pointer, say so, keep
         * the row.
         */
        if (col.req) return { ok: false, why: `${col.h}: no ${REFS[kind].noun} matches "${raw}"` };
        return { ok: true, value: '',
                 warn: `${col.h}: no ${REFS[kind].noun} matches "${raw}" — left empty` };
      }
      const s = blank ? '' : String(raw).trim();
      /*
       * An unexpected status is a note, not a rejection.
       *
       * The app itself accepts any string in these fields, so refusing the row
       * would mean the importer is stricter than the thing it imports into —
       * and the cost of being wrong is a whole row silently dropped. Take the
       * value, flag it, let the reader decide.
       */
      const allowed = enumOf(col);
      if (allowed && s && !allowed.includes(s)) {
        return { ok: true, value: s,
                 warn: `${col.h}: "${s}" is not one of ${allowed.filter(Boolean).join(', ')} — imported as-is` };
      }
      return { ok: true, value: s };
    }
  }
}

/* ---------- writing ------------------------------------------------------ */

/**
 * Months present across a set of budget lines, sorted, so columns line up.
 *
 * With no budget lines at all there are no months either, which would hand you
 * a budget template with nowhere to type a number and no hint of the expected
 * `YYYY-MM` header. So an empty sheet falls back to the current calendar year.
 */
function monthsOf(rows, field) {
  const set = new Set();
  for (const r of rows) for (const m of Object.keys(r[field] || {})) set.add(m);
  if (!set.size) {
    const y = new Date().getFullYear();
    for (let m = 1; m <= 12; m++) set.add(`${y}-${String(m).padStart(2, '0')}`);
  }
  return [...set].sort();
}

const MONTH_H = /^\d{4}-\d{2}$/;

/**
 * Read a month column header back into `YYYY-MM`.
 *
 * We write these as text, but Excel is eager: retype `2026-01` in a cell and it
 * becomes a real date, at which point the header arrives here as a Date or as
 * "Thu Jan 01 2026 ..." and a plain regex misses it. Missing it would silently
 * drop a whole month of budget on import, so all three shapes are accepted.
 *
 * @returns {string} 'YYYY-MM', or '' if this is not a month column
 */
export function monthKey(h) {
  if (h instanceof Date && !isNaN(h)) {
    return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}`;
  }
  const s = String(h ?? '').trim();
  if (MONTH_H.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 7);
  // "Jan 2026", "January 2026", "Thu Jan 01 2026 ..." — anything Date can take,
  // but only when it clearly carries a 4-digit year, so "Notes" cannot match.
  if (/\b(19|20)\d{2}\b/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d)) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  return '';
}

/** Month columns actually present on a parsed sheet: original header -> month. */
function monthCols(rows) {
  const out = [];
  for (const h of Object.keys(rows[0] || {})) {
    const m = monthKey(h);
    if (m) out.push({ h, m });
  }
  return out;
}

function sheetRows(spec, state, scope = null) {
  /* A scoped workbook only carries its own division's rows. */
  const keep = list => (spec.scoped && scope) ? list.filter(r => inScope(scope, r, state, spec)) : list;
  const cols = spec.cols;

  /* child sheet: one row per element of the parent's array/map */
  if (spec.child) {
    const { parent, field, kind, pk } = spec.child;
    const parentSpec = Object.values(SHEETS).find(s => s.coll === parent);
    const plabel = parentSpec?.label || 'name';
    const byCol  = spec.cols[0];
    const out = [];
    for (const p of keep(state[parent] || [])) {
      const holder = p[field];

      /*
       * What identifies the parent on this row.
       *
       * A single key is the parent's own id, or the label it is known by when
       * the column carries a `ref`. A composite key names the parent by the
       * fields a person would recognise — a milestone belongs to Ada's
       * "Ship the shader library", not to `gl_7fa2`.
       */
      const keyCells = {};
      if (pk) {
        for (const k of pk) {
          keyCells[k.h] = k.ref ? refLabel(state, k.ref, p[k.f]) : String(p[k.f] ?? '');
        }
      } else {
        keyCells[byCol.h] = byCol.ref ? refLabel(state, byCol.ref, p.id) : p.id;
      }

      const cellFor = (col, item, k, v) =>
        col.h in keyCells         ? keyCells[col.h]
        : col.t === 'formula'     ? ''
        : col.f === '@parentLabel' ? String(p[plabel] ?? '')
        : col.f === '@key'        ? k
        : col.f === '@val'        ? (isNaN(v) ? v : Number(v))
        : item                    ? toCell(col, item, state)
        : '';

      if (kind === 'map') {
        for (const [k, v] of Object.entries(holder || {})) {
          const row = {};
          for (const col of cols) row[col.h] = cellFor(col, null, k, v);
          out.push(row);
        }
      } else {
        for (const item of holder || []) {
          const row = {};
          for (const col of cols) row[col.h] = cellFor(col, item);
          out.push(row);
        }
      }
    }
    return { rows: out, headers: cols.map(c => c.h) };
  }

  /* flat sheet, optionally with a month matrix on the right */
  const recs = keep(state[spec.coll] || []);
  const months = spec.months ? monthsOf(recs, spec.months) : [];
  const headers = [...cols.map(c => c.h), ...months];
  const rows = recs.map(rec => {
    const row = {};
    for (const col of cols) row[col.h] = col.t === 'formula' ? '' : toCell(col, rec, state);
    if (spec.months) {
      const m = rec[spec.months] || {};
      for (const k of months) row[k] = m[k] == null ? '' : Number(m[k]);
    }
    return row;
  });
  return { rows, headers };
}

/** Rough column widths. Excel measures these in characters, not pixels. */
function widths(headers, rows) {
  return headers.map(h => {
    let w = h.length;
    for (const r of rows) w = Math.max(w, String(r[h] ?? '').length);
    return { wch: Math.min(Math.max(w + 2, 9), 46) };
  });
}

/**
 * A data dictionary for one sheet, generated from the schema.
 *
 * Generated rather than written by hand for the same reason the headers are:
 * a column reference that describes last month's layout is a trap. For `ref:`
 * columns it also lists what is currently valid, so you can see that the
 * Division column wants `2D` and not `2D Art` without guessing.
 */
function columnDoc(name, state) {
  const spec = SHEETS[name];
  if (!spec) return [];
  const rows = [[], [name, spec.note || '']];
  rows.push(['', 'Column', 'Type', 'Required', 'Notes / valid values']);

  for (const col of spec.cols) {
    let type = col.t, notes = '';
    if (col.t === 'id')      { type = 'text';   notes = 'Blank = create a new record. Otherwise the app updates this record. Do not edit or reshuffle.'; }
    else if (col.t === 'parent')  { type = 'text';   notes = 'Which record this row belongs to. Must match a record that already exists.'; }
    else if (col.t === 'derived') { type = 'text';   notes = 'For reading only — the app ignores this column on import.'; }
    else if (col.t === 'formula') { type = 'calculated'; notes = (col.doc ? col.doc + ' ' : '') + 'Excel works this out; the app ignores it on import. Do not type over it.'; }
    else if (col.t === 'date')    { type = 'date';   notes = 'YYYY-MM-DD. A real Excel date works too.'; }
    else if (col.t === 'bool')    { type = 'yes/no'; notes = 'TRUE or FALSE.'; }
    else if (col.t === 'list')    { type = 'list';   notes = 'Several values in one cell, separated by commas.'; }
    else if (col.t === 'num')     { type = 'number'; notes = 'Blank counts as 0.'; }
    else if (col.t.startsWith('ref:')) {
      const kind = col.t.slice(4);
      const spec2 = REFS[kind];
      const opts = (state[spec2.coll] || []).map(r => spec2.label(r)).filter(Boolean);
      type = 'lookup';
      notes = opts.length
        ? `Must be one of: ${opts.slice(0, 30).join(', ')}${opts.length > 30 ? ', …' : ''}`
        : `Must be ${spec2.wants} from the ${spec2.sheet} sheet.`;
    }
    const allowed = enumOf(col);
    if (allowed) notes = `One of: ${allowed.filter(Boolean).join(', ')}` + (allowed.includes('') ? ' (or blank)' : '');
    if (col.dv) {
      const n = vocabList(col.dv, state).length;
      notes = (VOCAB[col.dv]?.strict
        ? `Drop-down (${n} value${n === 1 ? '' : 's'}) from _Data. Excel will not accept anything else.`
        : `Drop-down (${n} value${n === 1 ? '' : 's'}) from _Data, as a suggestion — a new value is allowed.`);
    }
    rows.push(['', col.h, type, col.req ? 'yes' : '', notes]);
  }
  if (spec.months) {
    rows.push(['', 'YYYY-MM …', 'number', '',
      'One column per month, headed like 2026-01. Add or remove months freely. Blank means nothing that month.']);
  }
  return rows;
}

/* ---------- formulas ----------------------------------------------------- */

/** 0-based column index -> A, B, ... AA. */
function colA1(i) {
  let s = '', n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}

/**
 * The kit handed to a column's `fx`.
 *
 * Every range is resolved from the schema, never from a letter typed by hand,
 * and asking for a column that does not exist throws here — at export, with
 * the sheet and column named — rather than producing a workbook full of #REF!
 * that nobody notices until they trust the number.
 *
 * Ranges stop at the last row that holds data instead of running to the bottom
 * of the column, because SUMPRODUCT over a blank row is an error rather than a
 * zero, and `LeaveDays` is a SUMPRODUCT.
 */
function formulaKit(built, self) {
  const sheet = name => {
    const b = built.get(name);
    if (!b) throw new Error(`formula on ${self} refers to sheet "${name}", which is not in this workbook`);
    return b;
  };
  const idx = (name, header) => {
    const b = sheet(name);
    const i = b.headers.indexOf(header);
    if (i < 0) throw new Error(`formula on ${self} refers to ${name}.${header}, which is not a column there`);
    return i;
  };
  /* Never fewer than two, so an empty sheet still yields a valid range. */
  const last = name => Math.max(sheet(name).rows.length + 1, 2);

  return {
    /** A whole column of another sheet, bounded to its rows. */
    at: (name, header) => {
      const L = colA1(idx(name, header));
      return `'${name}'!$${L}$2:$${L}$${last(name)}`;
    },
    /** The absolute column of a header on THIS sheet — append a row number. */
    me: header => `$${colA1(idx(self, header))}`,
    /** Look a value up on another sheet by one of its columns. */
    lookup: (keyCell, name, keyHeader, valHeader) => {
      const ki = idx(name, keyHeader), vi = idx(name, valHeader);
      if (vi <= ki) {
        throw new Error(`formula on ${self}: VLOOKUP cannot read ${name}.${valHeader}, `
                      + `which sits left of ${name}.${keyHeader}`);
      }
      return `IFERROR(VLOOKUP(${keyCell},'${name}'!$${colA1(ki)}$2:$${colA1(vi)}$${last(name)},`
           + `${vi - ki + 1},FALSE),"")`;
    },
  };
}

/**
 * Put the formulas into a finished sheet.
 *
 * Each one is guarded on the row's first real column, so the formulas primed on
 * an empty template show blank rather than a row of zeroes that looks like a
 * record.
 */
function applyFormulas(XLSX, ws, spec, rows, built) {
  const fxCols = spec.cols.filter(c => c.t === 'formula' && typeof c.fx === 'function');
  if (!fxCols.length) return;

  const F = formulaKit(built, spec.name);
  const guard = spec.cols.find(c => c.t !== 'id');
  const gLetter = guard ? `$${colA1(spec.cols.indexOf(guard))}` : null;

  /* One row beyond the data, so a template with nothing in it still shows how
     the column is meant to work and the next row typed inherits it. */
  const lastRow = Math.max(rows.length, 1) + 1;
  for (const col of fxCols) {
    const ci = spec.cols.indexOf(col);
    for (let r = 2; r <= lastRow; r++) {
      const body = col.fx(r, F);
      const f = gLetter ? `IF(${gLetter}${r}="","",${body})` : body;
      ws[colA1(ci) + r] = { t: 's', f };
    }
  }
  /* json_to_sheet sized the range to the data; the primed row can sit past it. */
  const ref = XLSX.utils.decode_range(ws['!ref']);
  if (ref.e.r < lastRow - 1) { ref.e.r = lastRow - 1; ws['!ref'] = XLSX.utils.encode_range(ref); }
}

/* ---------- the _Data sheet and its drop-downs --------------------------- */

/**
 * One column per vocabulary the workbook's sheets actually use.
 *
 * This is what makes a drop-down possible at all: Excel's list validation
 * points at a range, so the values have to be somewhere in the file. Putting
 * them on their own sheet rather than inline keeps them out of the way and
 * lets several columns share one list.
 */
function dataSheet(wbId, state) {
  const names = vocabsUsed(wbId);
  const cols = names.map(n => ({ name: n, values: vocabList(n, state) }));
  const depth = cols.reduce((m, c) => Math.max(m, c.values.length), 0);

  const aoa = [cols.map(c => c.name)];
  for (let r = 0; r < depth; r++) aoa.push(cols.map(c => c.values[r] ?? ''));

  /* header -> where the list lives, for the validation ranges */
  const at = new Map();
  cols.forEach((c, i) => at.set(c.name, { col: colA1(i), n: c.values.length }));
  return { aoa, at, cols };
}

/**
 * The list validations one sheet needs.
 *
 * A vocabulary with nothing in it gets no validation — an empty list would be
 * the range `$A$2:$A$1`, which Excel reads as a broken rule rather than an
 * empty one. That is the normal state of a fresh install, so it has to be the
 * quiet case.
 */
function validationsFor(spec, dataAt) {
  const out = [];
  spec.cols.forEach((col, i) => {
    if (!col.dv) return;
    const where = dataAt.get(col.dv);
    if (!where || !where.n) return;
    const L = colA1(i);
    out.push({
      sqref: `${L}2:${L}${DV_ROWS}`,
      formula1: `'${DATA_SHEET}'!$${where.col}$2:$${where.col}$${where.n + 1}`,
      strict: !!VOCAB[col.dv]?.strict,
      title: col.dv,
    });
  });
  return out;
}

/* How far down a drop-down reaches. Generous, because the whole point is that
   the next row you type already has it. */
const DV_ROWS = 2000;

/*
 * OOXML child order for a worksheet. `dataValidations` sits after
 * conditionalFormatting and before hyperlinks, and Excel silently "repairs" a
 * file that puts it anywhere else — which means dropping the element and, with
 * it, every drop-down. So the insert goes before the first of these that the
 * sheet happens to contain.
 */
const AFTER_DV = ['hyperlinks', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter',
  'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors',
  'smartTags', 'drawing', 'legacyDrawing', 'picture', 'tableParts', 'extLst'];

const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Write the drop-downs in after the fact.
 *
 * SheetJS Community cannot emit data validation — the string does not appear
 * anywhere in the build — so the workbook it produces is unzipped, the sheet
 * XML is edited, and it is zipped again. `XLSX.CFB` is the same ZIP reader and
 * writer SheetJS uses for its own output, so nothing extra is vendored.
 *
 * Which XML file is which sheet is read out of workbook.xml and its rels
 * rather than assumed from the order they were appended. The order does in
 * fact match today, but a wrong guess would put the Person drop-down on the
 * Leave sheet, and that is not a failure anyone would spot by looking.
 */
function injectValidations(XLSX, bytes, plans) {
  if (!plans.length) return bytes;
  const CFB = XLSX.CFB;
  if (!CFB || typeof CFB.read !== 'function') return bytes;   // never seen; not worth failing over

  const dec = new TextDecoder(), enc = new TextEncoder();
  const zip = CFB.read(new Uint8Array(bytes), { type: 'array' });
  const find = suffix => zip.FullPaths.find(p => p.endsWith(suffix));
  const readText = path => dec.decode(new Uint8Array(CFB.find(zip, path).content));

  const wbXml = readText(find('xl/workbook.xml'));
  const relXml = readText(find('xl/_rels/workbook.xml.rels'));

  /* rId -> sheet part, e.g. "worksheets/sheet3.xml" */
  const rels = new Map();
  for (const m of relXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) rels.set(id, target.replace(/^\/?xl\//, ''));
  }
  /* sheet name -> sheet part */
  const parts = new Map();
  for (const m of wbXml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = /name="([^"]*)"/.exec(m[0])?.[1];
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
    if (name && rid && rels.has(rid)) parts.set(unescapeXml(name), rels.get(rid));
  }

  let written = 0;
  for (const plan of plans) {
    const part = parts.get(plan.sheet);
    if (!part) continue;
    const path = find('xl/' + part);
    if (!path) continue;
    const ent = CFB.find(zip, path);
    if (!ent) continue;

    const dvs = plan.dvs.map(d =>
      '<dataValidation type="list" allowBlank="1" showInputMessage="1"'
      + ` showErrorMessage="${d.strict ? 1 : 0}"`
      + (d.strict ? ' errorStyle="stop"'
          + ` errorTitle="${xmlEsc('Not a valid ' + d.title)}"`
          + ` error="${xmlEsc('Pick a value from the list. The list comes from the app — if what you need is missing, add it there first.')}"` : '')
      + ` sqref="${d.sqref}"><formula1>${xmlEsc(d.formula1)}</formula1></dataValidation>`).join('');

    let xml = readText(path);
    const block = `<dataValidations count="${plan.dvs.length}">${dvs}</dataValidations>`;
    let at = -1;
    for (const tag of AFTER_DV) {
      const i = xml.indexOf('<' + tag);
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
    if (at < 0) at = xml.lastIndexOf('</worksheet>');
    if (at < 0) continue;
    xml = xml.slice(0, at) + block + xml.slice(at);

    const buf = enc.encode(xml);
    ent.content = buf; ent.size = buf.length;
    written++;
  }
  if (!written) return bytes;
  return CFB.write(zip, { type: 'array', fileType: 'zip', compression: true });
}

const unescapeXml = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/**
 * Build one workbook.
 * @param {string} wbId  a WORKBOOKS id
 * @returns {Promise<{blob:Blob,file:string,rows:number}>}
 */
export async function buildWorkbook(wbId, state = S.get()) {
  const XLSX = await loadLib();
  const wbDef = workbookOf(wbId, state);
  if (!wbDef) throw new Error(`No such workbook: ${wbId}`);

  const wb = XLSX.utils.book_new();
  let total = 0;

  /*
   * Every sheet's rows first, before a single one is written.
   *
   * The formulas need to know how far each sheet's data reaches — `Weight%` on
   * the People sheet sums a bounded range of the Goals sheet — and that is not
   * knowable while the sheets are still being built one at a time.
   */
  const built = new Map();
  for (const name of wbDef.sheets) {
    const spec = { name, ...SHEETS[name] };
    const { rows, headers } = sheetRows(spec, state, wbDef.scope);
    built.set(name, { spec, rows, headers });
  }

  const data = dataSheet(wbId, state);

  /*
   * The data sheets, in schema order, and that order is the tab order.
   *
   * The first sheet is what Excel opens on, which is why READ ME is now last:
   * it is for the first hour and the roster is for every hour after it.
   */
  const dvPlans = [];
  for (const name of wbDef.sheets) {
    const { spec, rows, headers } = built.get(name);
    const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
    ws['!cols'] = widths(headers, rows);
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ r: 0, c: 0 },
                          { r: Math.max(rows.length, 1), c: headers.length - 1 }) };
    applyFormulas(XLSX, ws, spec, rows, built);
    XLSX.utils.book_append_sheet(wb, ws, name);

    const dvs = validationsFor(spec, data.at);
    if (dvs.length) dvPlans.push({ sheet: name, dvs });
    total += rows.length;
  }

  /* The lists the drop-downs point at. */
  const wsData = XLSX.utils.aoa_to_sheet(data.aoa);
  wsData['!cols'] = data.cols.map(c => ({ wch: Math.min(Math.max(c.name.length + 2, 12), 30) }));
  wsData['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, wsData, DATA_SHEET);

  const readme = [
    ['GFX Prod App — ' + wbDef.title],
    [wbDef.blurb],
    [],
    ['How this works'],
    ['1.', 'Edit the sheets in this file. Keep the header row exactly as it is.'],
    ['2.', 'In the app, open Workspace > Excel Sync and import this file.'],
    ['3.', 'You get a summary of what will change. Nothing is written until you confirm.'],
    [],
    ['The ID column'],
    ['', 'Leave ID blank on a new row and the app creates a new record.'],
    ['', 'Keep an existing ID and the app updates that record, even if you renamed it.'],
    ['', 'Do not reuse or reshuffle IDs.'],
    [],
    ['Deleting'],
    ['', 'Removing a row does NOT delete anything by default. The app reports it and'],
    ['', 'leaves the record alone, because a partial file is far more common than a'],
    ['', 'deliberate deletion. To delete, tick "mirror this file exactly" on import.'],
    [],
    ['The ' + DATA_SHEET + ' sheet'],
    ['', 'Holds the lists behind every drop-down in this file. It is rewritten on'],
    ['', 'every export, so editing it changes nothing — to add a division, a project'],
    ['', 'or a role, add it in the app (or on the sheet that owns it) and export again.'],
    [],
    ['Calculated columns'],
    ['', 'Some columns are Excel formulas — Weight%, OpenActions, Headcount and the'],
    ['', 'Division columns on the child sheets. They fill themselves in and the app'],
    ['', 'ignores them on import. Typing over one only loses the formula.'],
    [],
    ['What the columns mean'],
    ...wbDef.sheets.flatMap(n => columnDoc(n, state)),
    [],
    ['Exported', new Date().toISOString().slice(0, 19).replace('T', ' ')],
    ['App build', BUILD],
    ['Schema', SCHEMA_VERSION],
  ];
  const wsReadme = XLSX.utils.aoa_to_sheet(readme);
  wsReadme['!cols'] = [{ wch: 15 }, { wch: 17 }, { wch: 13 }, { wch: 10 }, { wch: 86 }];
  XLSX.utils.book_append_sheet(wb, wsReadme, 'READ ME');

  /* Open on the first data sheet, not on whatever Excel last remembered. */
  wb.Workbook = { ...(wb.Workbook || {}), Views: [{ activeTab: 0 }] };

  const raw = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const out = injectValidations(XLSX, raw, dvPlans);
  return {
    blob: new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    file: wbDef.file,
    rows: total,
  };
}


/* ---------- reading ------------------------------------------------------ */

/**
 * Parse a workbook into plain rows. Interprets nothing, resolves nothing,
 * touches no state — so a corrupt file fails here, harmlessly.
 */
export async function readWorkbook(buf) {
  const XLSX = await loadLib();
  let wb;
  try {
    wb = XLSX.read(buf, { type: 'array', cellDates: true, cellText: false });
  } catch (e) {
    throw new Error('That file is not a readable .xlsx: ' + e.message);
  }
  const sheets = {};
  for (const name of wb.SheetNames) {
    /* Neither of these is data. `_Data` is the drop-down source, rewritten on
       every export, so reading it back would be reading our own output. */
    if (name === 'READ ME' || name === DATA_SHEET) continue;
    const ws = wb.Sheets[name];
    // defval:'' keeps blank cells as columns instead of dropping the key,
    // which is what lets "cleared this cell" differ from "did not touch it".
    sheets[name] = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true });
  }
  return { sheets, names: Object.keys(sheets) };
}

/**
 * Which workbook does this file look like?
 *
 * Sheet names settle it for the fixed books. They cannot settle it for the
 * division 1:1 files — every one of them has the same two sheets — so the
 * filename is checked first. Getting the division wrong would not corrupt the
 * rows (each carries its own Person) but it would make "missing from the file"
 * and mirror reason about the wrong set of notes.
 */
export function guessWorkbook(names, fileName = '', state = S.get()) {
  const books = allWorkbooks(state);

  const base = String(fileName).replace(/\.xls[xm]$/i, '').replace(/ \(\d+\)$/, '');
  if (base) {
    const byName = books.find(wb => wb.file.replace(/\.xlsx$/i, '').toLowerCase() === base.toLowerCase());
    if (byName) return { wb: byName, matched: byName.sheets.length, by: 'filename' };

    /* A file from before the workbooks were consolidated. Say so, rather than
       letting the sheet-count guess below pick one of the two books its sheets
       are now split across. */
    const old = retiredFile(base);
    if (old) return { retired: old };
  }

  let best = null, bestScore = 0;
  for (const wb of books) {
    const score = wb.sheets.filter(s => names.includes(s)).length;
    if (score > bestScore) { best = wb; bestScore = score; }
  }
  return bestScore ? { wb: best, matched: bestScore, by: 'sheets' } : null;
}

/* ---------- planning ----------------------------------------------------- */

const PREFIX = {
  people: 'pe', projects: 'p', tasks: 't', objectives: 'o', vendors: 'v',
  outsourceBatches: 'ob', budgetLines: 'b', leave: 'l', holidays: 'h',
  goals: 'gl', oneToOnes: 'oo',
  divisions: 'dv', rateCard: 'rc', jiraImports: 'ji',
  wbItems: 'wbi', wbEstimates: 'wbe',
};

/**
 * Is this value effectively empty?
 *
 * The app writes "no manager" as `null` in one place and `''` in another, and a
 * blank Excel cell reads back as `''`. Without this, a straight round-trip
 * reported a change on every such field — 11 phantom "updates" on the Leave
 * sheet alone, all of them `undefined -> ""`. A diff that cries wolf is a diff
 * nobody reads, which defeats the point of showing one.
 */
const blankish = v => v == null || v === '' ||
  // A field the app never set and a field set to false/0 are the same fact.
  // Excel has no way to write "absent": an empty checkbox is FALSE and an empty
  // number cell is 0, so without these two a plain round-trip reports a change
  // on every optional flag and every zero. Note this only makes blank *equal to*
  // false/0 — comparing false against true, or 0 against 5, still differs.
  v === false || v === 0 ||
  (Array.isArray(v) && !v.length) ||
  (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);

/**
 * Structural equality, treating "absent" and "empty" as the same thing.
 *
 * A flat JSON compare is not enough. Excel round-tripping normalises shape as
 * well as values: a key result stored without an `invert` field comes back with
 * `invert: false`, and `{a:1}` vs `{a:1, invert:false}` are different strings
 * but the same data. That produced a "3 rows -> 3 rows" change on every
 * objective — technically a diff, useless to a reader.
 *
 * Numbers are compared numerically so `5` and `"5"` agree, since a cell that
 * has been through Excel may come back as either.
 */
function same(a, b) {
  if (blankish(a) && blankish(b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => same(x, b[i]));
  }
  const oa = a && typeof a === 'object', ob = b && typeof b === 'object';
  if (oa || ob) {
    if (!oa || !ob) return false;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!same(a[k], b[k])) return false;
    return true;
  }
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a), nb = Number(b);
    if (!isNaN(na) && !isNaN(nb)) return na === nb;
  }
  return a === b;
}

/** Find the existing record a row refers to. */
function findExisting(spec, coll, row, resolved) {
  const id = String(row.ID ?? '').trim();
  if (id) {
    const hit = coll.find(r => r.id === id);
    if (hit) return { rec: hit, by: 'ID' };
  }
  for (const key of spec.match || []) {
    if (key === '@composite') {
      const hit = coll.find(r => spec.composite.every(f => norm(r[f]) === norm(resolved[f])));
      if (hit) return { rec: hit, by: spec.composite.join('+') };
      continue;
    }
    const want = norm(resolved[key]);
    if (!want) continue;
    const hit = coll.find(r => norm(r[key]) === want);
    if (hit) return { rec: hit, by: key };
  }
  return { rec: null, by: null };
}

/**
 * Work out exactly what an import would do. Pure: reads state, writes nothing.
 *
 * @param {string} wbId
 * @param {object} sheets     from readWorkbook()
 * @param {object} opt
 * @param {boolean} opt.mirror  also delete records missing from the file
 * @returns plan, safe to render and to hand to applyPlan()
 */
/**
 * Give every row that is about to be created its id, before anything resolves.
 *
 * Manager, Lead, Owner and Assignee are looked up against records that exist.
 * On the first import of a whole roster none of them exist yet, so every
 * manager link came back unresolved and the org chart arrived flat — 28 people
 * and not one reporting line. Cross-sheet references had the same problem:
 * Divisions.Lead names someone the People sheet has not created yet.
 *
 * So ids are minted here, in a pass over every sheet in the workbook, and the
 * lookup index is told about them. By the time a cell is resolved, a reference
 * to a person created two sheets later already points somewhere.
 *
 * @returns {Map<string,string>} "SheetName#rowIndex" -> the id it will get
 */
/*
 * The natural key of a row, resolved the same way both sides resolve it.
 *
 * A goal is identified by its person and its title, and a 1:1 by its person
 * and its date. The person arrives as a name and has to become an id, and the
 * date as anything Excel felt like handing over and has to become an ISO
 * string, or the key built from a child row would not match the key built from
 * its parent row. Returns null when a part is missing, because a partial key
 * matches the wrong thing rather than nothing.
 */
const KEY_SEP = '\u0000';

function keyPart(col, raw, idx) {
  if (!col) return norm(raw);
  const kind = col.ref || (col.t?.startsWith('ref:') ? col.t.slice(4) : null);
  // norm() on the way out too: the record side reads the id straight off the
  // record and normalises it, so the two keys have to agree exactly.
  if (kind) return norm(idx[kind]?.get(norm(raw)) || '');
  if (col.t === 'date' || col.t2 === 'date') return toIso(raw);
  return norm(raw);
}

/** From a spreadsheet row. */
function compositeKey(spec, row, idx) {
  const parts = spec.composite.map(f => {
    const col = spec.cols.find(c => c.f === f);
    return keyPart(col, col ? row[col.h] : '', idx);
  });
  return parts.every(p => p !== '' && p != null) ? parts.join(KEY_SEP) : null;
}

/** From a record already in the store. Must agree with compositeKey(). */
const recordKey = (fields, rec) => fields.map(f => norm(rec[f])).join(KEY_SEP);

function preRegisterNewRows(wbDef, sheets, state, idx) {
  const minted = new Map();          // "Sheet#row" -> id, for rows being created
  const newIds = new Map();          // collection -> Set of ids that will exist

  for (const name of wbDef.sheets) {
    const spec = SHEETS[name];
    if (!spec || spec.child || !spec.coll) continue;
    const rows = sheets[name];
    if (!rows) continue;

    const coll = state[spec.coll] || [];
    const refKind = Object.keys(REFS).find(k => REFS[k].coll === spec.coll);
    const headerOf = f => spec.cols.find(c => c.f === f)?.h;

    rows.forEach((row, i) => {
      const given = String(row.ID ?? '').trim();

      /* Does this row land on a record that is already here? */
      let existingId = (given && coll.some(r => r.id === given)) ? given : null;
      if (!existingId) {
        for (const key of spec.match || []) {
          if (key === '@composite') continue;
          const h = headerOf(key);
          if (!h) continue;
          const want = norm(row[h]);
          if (!want) continue;
          const hit = coll.find(r => norm(r[key]) === want);
          if (hit) { existingId = hit.id; break; }
        }
      }

      const theId = existingId || given || S.uid(PREFIX[spec.coll] || 'x');
      if (!existingId) {
        minted.set(`${name}#${i}`, theId);
        if (!newIds.has(spec.coll)) newIds.set(spec.coll, new Set());
        newIds.get(spec.coll).add(theId);
      }

      /*
       * Register the natural key of anything matched on a composite, so a
       * child sheet can find its parent by the two columns a human typed.
       *
       * Done for updates as well as creates, and that is the interesting case:
       * rewording a goal on the Goals sheet and adding a milestone under the
       * new wording in the same file has to attach to the same goal, not fail
       * with "no goal matches". The composite here is the key as written in
       * the file, which is exactly what the milestone row names.
       */
      if (spec.composite) {
        const ck = compositeKey(spec, row, idx);
        if (ck) {
          const kk = spec.coll + ':keys';
          if (!newIds.has(kk)) newIds.set(kk, new Map());
          newIds.get(kk).set(ck, theId);
        }
      }

      /*
       * Register the names *as written in the file*, for updates as well as
       * creates. An update can rename a record, and other rows refer to the
       * new name, not the old one — importing a roster that replaces someone's
       * initials with their full legal name must still resolve the people who
       * report to them. Existing records are indexed first, so they always win
       * a key they already hold.
       */
      if (refKind) {
        /* `title` is here for objectives, whose natural key is their title.
           This whole pass runs across every sheet before any of them is
           planned, so a Task naming an objective the Objectives sheet is about
           to create still resolves — even though Tasks is the earlier sheet. */
        for (const f of ['name', 'email', 'code', 'title']) {
          const h = headerOf(f);
          const v = h ? row[h] : null;
          if (v && String(v).trim() && !idx[refKind].has(norm(v))) {
            idx[refKind].set(norm(v), theId);
          }
        }
        if (given && !idx[refKind].has(norm(given))) idx[refKind].set(norm(given), theId);
      }
    });
  }
  return { minted, newIds };
}

export function planImport(wbId, sheets, { mirror = false, state = S.get() } = {}) {
  const idx = refIndexes(state);
  const wbDef = workbookOf(wbId, state);
  const { minted, newIds } = preRegisterNewRows(wbDef, sheets, state, idx);
  const plan = {
    wbId, title: wbDef.title, mirror,
    sheets: [], errors: [], skippedSheets: [],
    counts: { create: 0, update: 0, unchanged: 0, remove: 0, error: 0, warn: 0 },
  };

  for (const name of wbDef.sheets) {
    const spec = { name, ...SHEETS[name] };
    const rows = sheets[name];

    /* A sheet that is not in the file is not a request to empty anything. */
    if (!rows) { plan.skippedSheets.push(name); continue; }

    const out = { name, creates: [], updates: [], removes: [], unchanged: 0,
                  errors: [], warnings: [] };

    if (spec.child) planChild(spec, rows, state, idx, out, newIds, wbDef.scope);
    else            planFlat(spec, rows, state, idx, out, mirror, minted, wbDef.scope);

    plan.counts.create    += out.creates.length;
    plan.counts.update    += out.updates.length;
    plan.counts.remove    += out.removes.length;
    plan.counts.unchanged += out.unchanged;
    plan.counts.error     += out.errors.length;
    plan.counts.warn      += (out.warnings || []).length;
    plan.sheets.push(out);
  }
  return plan;
}

function planFlat(spec, rows, state, idx, out, mirror, minted = new Map(), scope = null) {
  /*
   * Matching looks at the WHOLE collection; only "missing" and mirror are
   * scoped. A 1:1 whose author has since changed division still has to be
   * findable by its id, or importing that division's file would create a
   * duplicate instead of updating the note. But it must not be reported as
   * missing from a file that was never meant to contain it, and mirror must
   * never delete it.
   */
  const coll = state[spec.coll] || [];
  const inThisFile = (spec.scoped && scope)
    ? coll.filter(r => inScope(scope, r, state, spec))
    : coll;
  const months = spec.months ? monthCols(rows) : [];
  // Fields the app stores as formatted text and the sheet carries as plain.
  const richFields = new Set(spec.cols.filter(c => c.t === 'rich').map(c => c.f));
  const seen = new Set();
  const claimedBy = new Map();   // record id -> the row that claimed it

  rows.forEach((row, i) => {
    const rowNo = i + 2;                        // +1 header, +1 to 1-base
    const resolved = {};
    const errs = [];

    for (const col of spec.cols) {
      if (col.t === 'derived' || col.t === 'formula') continue;
      if (col.t === 'id') { resolved.id = String(row[col.h] ?? '').trim(); continue; }
      /*
       * A column the FILE does not have is not an instruction to clear it.
       *
       * `readWorkbook` reads with `defval:''`, so a cell someone emptied
       * arrives as `''` — present and blank, a real edit — while a column the
       * sheet never had arrives as `undefined`. That is exactly what last
       * month's export looks like after the schema gains a column: importing
       * it wiped the new field on every row, silently. Measured on the
       * Divisions sheet the day `JiraLabel` was added: a workbook exported an
       * hour earlier planned "jiraLabel: GFX-Prod -> ''" for all seven rows.
       *
       * A REQUIRED column that is missing is a broken file, not an old one,
       * and still errors below.
       */
      if (!(col.h in row) && !col.req) continue;
      const r = fromCell(col, row[col.h], idx);
      if (!r.ok) { errs.push(r.why); continue; }
      if (r.warn) out.warnings.push({ row: rowNo, why: r.warn });
      if (col.req && (r.value === '' || r.value == null)) {
        errs.push(`${col.h} is required`); continue;
      }
      resolved[col.f] = r.value;
    }

    /* A row that is blank all the way across is just spreadsheet padding. */
    const anyValue = spec.cols.some(c => c.t !== 'id' && c.t !== 'derived' && c.t !== 'formula' &&
                                    String(row[c.h] ?? '').trim() !== '');
    if (!anyValue) return;

    if (errs.length) { out.errors.push({ row: rowNo, why: errs }); return; }

    if (months.length) {
      const m = {};
      for (const { h, m: month } of months) {
        const v = row[h];
        if (v === '' || v == null) continue;
        const n = Number(String(v).replace(/[\s,]/g, ''));
        if (isNaN(n)) { out.errors.push({ row: rowNo, why: [`${h}: "${v}" is not a number`] }); return; }
        m[month] = n;
      }
      resolved[spec.months] = m;
    }

    const { rec, by } = findExisting(spec, coll, row, resolved);

    /*
     * One record, one row.
     *
     * A row can find a record by ID or by a natural key, and those two routes
     * can land on the same record from different rows — rename a rate-card
     * rung to "Lead" while another row already owns that record by id, and
     * both rows target it. Applied in order, the second silently overwrites
     * the first and a whole rung disappears with nothing reported. Refuse
     * instead, naming the other row so it can be fixed.
     */
    if (rec && seen.has(rec.id)) {
      out.errors.push({ row: rowNo, why: [
        `also matches the record already claimed by row ${claimedBy.get(rec.id)} ` +
        `("${rec[spec.label] || rec.id}") — two rows cannot describe one record`] });
      return;
    }

    if (!rec) {
      // The id was decided in the pre-pass, and other rows may already point
      // at it, so it must be the one that actually gets written.
      const pre = minted.get(`${spec.name}#${i}`);
      if (pre) resolved.id = pre;
      out.creates.push({ row: rowNo, label: resolved[spec.label] || '(unnamed)', data: resolved, coll: spec.coll });
      return;
    }
    seen.add(rec.id);
    claimedBy.set(rec.id, rowNo);

    const changes = [];
    for (const [f, v] of Object.entries(resolved)) {
      if (f === 'id') continue;
      /*
       * A rich field goes out as plain text and comes back as plain text, so a
       * byte comparison would report a change on every single round trip and
       * quietly flatten the formatting. Compare what the cell says against the
       * stored value's *text*: equal means the cell was not edited, so leave
       * the formatted original alone. Different means it was, and the plain
       * text the user typed wins.
       */
      if (richFields.has(f) && richToText(rec[f]) === richToText(v)) continue;
      if (!same(rec[f], v)) changes.push({ f, from: rec[f], to: v });
    }
    if (!changes.length) { out.unchanged++; return; }
    out.updates.push({ row: rowNo, id: rec.id, matchedBy: by,
                       label: rec[spec.label] || rec.id, changes, coll: spec.coll });
  });

  if (mirror) {
    for (const rec of inThisFile) {
      if (seen.has(rec.id)) continue;
      out.removes.push({ id: rec.id, label: rec[spec.label] || rec.id, coll: spec.coll });
    }
  } else {
    /* Reported, not acted on. */
    out.missing = inThisFile.filter(r => !seen.has(r.id))
                            .map(r => ({ id: r.id, label: r[spec.label] || r.id }));
  }
}

function planChild(spec, rows, state, idx, out, newIds = new Map(), scope = null) {
  const { parent, field, kind, pk } = spec.child;
  const byCol = spec.cols[0];
  const parents = state[parent] || [];
  const groups = new Map();
  const errs = [];

  /*
   * Parents created earlier in this same import count as parents.
   *
   * Migrating a roster puts 28 new people on the People sheet and their
   * project splits on Allocations. Looking only at `state` meant every one of
   * those 30 allocation rows failed with "no match for EMP-001" — the person
   * it named was three sheets away, about to be created. `applyPlan` writes
   * sheets in workbook order, so the parent exists by the time the child is
   * written; the planner just has to know it is coming.
   */
  const pending = newIds.get(parent) || new Set();
  const pendingKeys = newIds.get(parent + ':keys') || new Map();
  /* The sheet the parent lives on, by name, so an error can point at it. */
  const parentSheet = Object.keys(SHEETS).find(k => SHEETS[k].coll === parent) || parent;
  const labelOf = new Map();

  /*
   * Which record does this row hang off?
   *
   * Two shapes. A single key is the parent's id, or the label it is known by
   * when the column carries a `ref` — a project Code, a person Name.
   *
   * A composite key names the parent the way a person would: Ada plus the
   * wording of the goal. That replaced a `GoalID` column the sheet expected
   * you to copy across from the Goals sheet, which meant a goal added in Excel
   * could not have a milestone until it had been imported and exported again.
   * The lookup goes to the store first and then to the keys registered for
   * rows this same import is about to create or rename, so a goal and its
   * milestones can arrive together in one file.
   */
  function resolveParent(row) {
    if (!pk) {
      const key = String(row[byCol.h] ?? '').trim();
      if (!key) return { skip: true };
      const pid = byCol.ref ? idx[byCol.ref]?.get(norm(key)) : key;
      const found = parents.find(x => x.id === pid);
      if (found) return { p: found };
      if (pid && pending.has(pid)) {
        const lc = spec.cols.find(c => c.f === '@parentLabel');
        const name = (lc && row[lc.h]) || key;
        labelOf.set(pid, name);
        return { p: { id: pid, name, [field]: kind === 'map' ? {} : [] } };
      }
      return { why: `${byCol.h}: no match for "${key}"` };
    }

    /* composite */
    const parts = [];
    for (const k of pk) {
      const raw = row[k.h];
      if (raw == null || String(raw).trim() === '') {
        return { why: `${k.h} is needed to say which row this belongs to` };
      }
      const part = keyPart(k, raw, idx);
      if (!part) {
        return { why: k.ref
          ? `${k.h}: no ${REFS[k.ref].noun} matches "${raw}"`
          : `${k.h}: "${raw}" is not a value I can read` };
      }
      parts.push(part);
    }
    const ck = parts.join(KEY_SEP);
    const fields = pk.map(k => k.f);

    const found = parents.find(x => recordKey(fields, x) === ck);
    if (found) return { p: found };

    const pid = pendingKeys.get(ck);
    if (pid) {
      const known = parents.find(x => x.id === pid);
      if (known) return { p: known };
      const name = pk.map(k => String(row[k.h])).join(' — ');
      labelOf.set(pid, name);
      return { p: { id: pid, name, [field]: kind === 'map' ? {} : [] } };
    }
    return { why: `no row on the ${parentSheet} sheet matches `
      + pk.map(k => `${k.h} "${String(row[k.h]).trim()}"`).join(' + ') };
  }

  rows.forEach((row, i) => {
    const rowNo = i + 2;
    const r0 = resolveParent(row);
    if (r0.skip) return;
    if (r0.why) { errs.push({ row: rowNo, why: [r0.why] }); return; }
    const p = r0.p;

    if (kind === 'map') {
      /* Named in the schema rather than taken by position — dropping the
         redundant PersonID column shifted these two along by one, and a
         positional read would silently have started storing the level as the
         skill name. */
      const k = String(row[spec.child.k] ?? '').trim();
      if (!k) return;
      const v = Number(row[spec.child.v]);
      if (!groups.has(p.id)) groups.set(p.id, {});
      groups.get(p.id)[k] = isNaN(v) ? row[spec.child.v] : v;
      return;
    }

    const item = {};
    let bad = null;
    for (const col of spec.cols) {
      /* The parent-key columns say which record this belongs to; they are not
         fields of it. There can be more than one of them. */
      if (col.t === 'parent') continue;
      if (col.t === 'derived' || col.t === 'formula' || col.f === '@parentLabel') continue;
      /* As in planFlat: an absent column is an older file, not a clearance. */
      if (!(col.h in row) && !col.req) continue;
      const r = fromCell(col, row[col.h], idx);
      if (!r.ok) { bad = r.why; break; }
      if (r.warn) out.warnings.push({ row: rowNo, why: r.warn });
      if (col.req && (r.value === '' || r.value == null)) { bad = `${col.h} is required`; break; }
      item[col.f] = r.value;
    }
    if (bad) { errs.push({ row: rowNo, why: [bad] }); return; }
    if (!groups.has(p.id)) groups.set(p.id, []);
    groups.get(p.id).push(item);
  });

  out.errors.push(...errs);

  for (const [pid, next] of groups) {
    const p = parents.find(x => x.id === pid);
    // A parent still to be created has nothing before, so everything is new.
    const before = p ? p[field] : (kind === 'map' ? {} : []);
    if (same(before, next)) { out.unchanged++; continue; }
    const n = Array.isArray(next) ? next.length : Object.keys(next).length;
    const was = Array.isArray(before) ? before.length : Object.keys(before || {}).length;
    out.updates.push({
      id: pid, coll: parent, label: p ? (p.name || p.code || pid) : (labelOf.get(pid) || pid), child: field,
      matchedBy: pk ? pk.map(k => k.h).join(' + ') : byCol.h,
      changes: [{ f: field, from: `${was} row${was === 1 ? '' : 's'}`, to: `${n} row${n === 1 ? '' : 's'}` }],
      data: next,
    });
  }
  /* Parents with no rows in the sheet keep what they have — and in a scoped
     workbook, a parent from another division was never a candidate. */
  const mine = (spec.scoped && scope)
    ? parents.filter(p => inScope(scope, p, state, spec))
    : parents;
  out.missing = mine.filter(p => !groups.has(p.id) &&
                  (Array.isArray(p[field]) ? p[field].length : Object.keys(p[field] || {}).length))
                .map(p => ({ id: p.id, label: p.name || p.code || p.id }));
}

/* ---------- applying ----------------------------------------------------- */

const RESCUE_KEY = 'gfxprod.preimport';

/**
 * Write the plan. One `mutate()`, so one Ctrl+Z undoes the entire import.
 *
 * A full copy of the previous state goes to localStorage first. The undo ring
 * is in memory and dies with the tab; an import is exactly the operation you
 * discover was wrong tomorrow.
 */
export function applyPlan(plan) {
  try { localStorage.setItem(RESCUE_KEY, JSON.stringify({
    at: Date.now(), from: plan.title, json: S.exportJson(),
  })); } catch { /* quota: proceed, the undo ring still covers this session */ }

  const applied = { created: 0, updated: 0, removed: 0 };

  S.mutate(s => {
    for (const sheet of plan.sheets) {
      for (const u of sheet.updates) {
        const rec = (s[u.coll] || []).find(r => r.id === u.id);
        if (!rec) continue;
        if (u.child) rec[u.child] = u.data;
        else for (const ch of u.changes) rec[ch.f] = ch.to;
        applied.updated++;
      }
      for (const cr of sheet.creates) {
        const list = (s[cr.coll] ||= []);
        const rec = { ...cr.data };
        if (!rec.id) rec.id = S.uid(PREFIX[cr.coll] || 'x');
        list.push(rec);
        applied.created++;
      }
      for (const rm of sheet.removes) {
        s[rm.coll] = (s[rm.coll] || []).filter(r => r.id !== rm.id);
        applied.removed++;
      }
    }
    s.meta ||= {}; s.meta.updated = Date.now();
    s.settings ||= {};
    s.settings.excel ||= {};
    s.settings.excel.lastImport = { at: Date.now(), wbId: plan.wbId, ...applied };
  }, { label: 'Excel import' });

  return applied;
}

/** The state as it was immediately before the last import, if still held. */
export function rescuePeek() {
  try {
    const r = JSON.parse(localStorage.getItem(RESCUE_KEY) || 'null');
    return r && r.json ? { at: r.at, from: r.from, bytes: r.json.length } : null;
  } catch { return null; }
}

export function rescueRestore() {
  const r = JSON.parse(localStorage.getItem(RESCUE_KEY) || 'null');
  if (!r?.json) throw new Error('There is no pre-import copy saved.');
  S.importJson(r.json);
  return true;
}
