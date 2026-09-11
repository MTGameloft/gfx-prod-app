/**
 * The header every timeline shares: month, week, date.
 *
 * There were three timelines and three different scales — the Leave grid had
 * a month band over dated day columns, the portfolio gantt had months only,
 * and the dashboard timeline had week and month ticks thinned by measurement.
 * Reading a date off one told you nothing about the others.
 *
 * So the scale is built once, here, and every timeline renders the same three
 * bands from it. Which bands are showing is remembered per timeline in
 * `prefs.timelineBy[key]` — see KEY_DEFAULTS for why that is not one shared
 * setting.
 *
 * Two renderers, because the timelines are laid out differently and pretending
 * otherwise would mean rewriting all three:
 *
 *   headRows()  — <tr> rows of <th colspan>, for a real day-column table
 *   headBands() — proportional flex cells, for the percentage-positioned ones
 *
 * Both take the same scale and the same `show`, so they cannot disagree about
 * where a week starts.
 */

import * as S from './store.js';
import { esc, fmtDate, today, toDate, isoOf, addDays, daysBetween } from './ui.js';

/* ---------- what is showing --------------------------------------------- */

export const SCALE_ROWS = [
  { id: 'month', label: 'Month' },
  { id: 'week',  label: 'Week' },
  { id: 'date',  label: 'Date' },
];

const DEFAULTS = { month: true, week: true, date: true };

/*
 * Where a timeline starts, before anyone has touched its toggle.
 *
 * All three bands are available on all of them. Which start on is a judgement
 * about span, not about the feature:
 *
 *   leave      two or three months, ~24px a day — the date band is the view.
 *   dashboard  six months by default. At a legible day width that is 4300px,
 *              so nine milestones spread out and six of them start off-screen.
 *   portfolio  a fixed twelve months. 8000px, opening scrolled to a fraction
 *              of itself, which reads as broken rather than detailed.
 *
 * So the two long ones start on month and week — the resolution their span
 * actually supports — and the date band is one click away, per timeline, and
 * remembered once chosen.
 */
const KEY_DEFAULTS = {
  portfolio: { month: true, week: true, date: false },
  dashboard: { month: true, week: true, date: false },
};

/* A project's own timeline is keyed `proj:<id>`, so it cannot be listed above.
   It spans months like the dashboard's, so it starts the same way. */
const keyDefault = key =>
  KEY_DEFAULTS[key] || (String(key).startsWith('proj:') ? KEY_DEFAULTS.dashboard : null) || {};

/*
 * Remembered per timeline, not once for the whole app.
 *
 * They cover wildly different spans — the Leave grid is two months, where the
 * date band is the entire point of the view, and the portfolio is a year,
 * where a day is a sliver and the same band is 8000px of scrolling. One shared
 * setting would mean turning dates off for the portfolio also stripped them
 * from Leave. So `prefs.timelineBy[key]` holds each one, and anything not set
 * yet falls back to all three showing.
 */
export function scalePrefs(key = 'default') {
  const by = S.get()?.prefs?.timelineBy;
  const own = by && typeof by === 'object' ? by[key] : null;
  return { ...DEFAULTS, ...keyDefault(key), ...(own && typeof own === 'object' ? own : {}) };
}

/**
 * Turn a band on or off for one timeline.
 *
 * The last one cannot be turned off: a timeline with no scale at all is a row
 * of coloured bars with nothing to read them against, and the way back would
 * not be obvious.
 */
export function setScaleRow(row, on, key = 'default') {
  const next = { ...DEFAULTS, ...keyDefault(key), ...scalePrefs(key), [row]: !!on };
  if (!next.month && !next.week && !next.date) return false;
  S.mutate(s => {
    s.prefs ||= {};
    s.prefs.timelineBy = { ...(s.prefs.timelineBy || {}), [key]: next };
  }, { silent: true, noUndo: true, label: 'timeline scale' });
  return true;
}

/* ---------- the scale ---------------------------------------------------- */

/** ISO-8601 week number. Thursday decides which year a week belongs to. */
export function isoWeek(iso) {
  const d = toDate(iso);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 86400000 + 1) / 7);
}

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const dowOf = iso => toDate(iso).getDay();
export const isWeekendIso = iso => { const n = dowOf(iso); return n === 0 || n === 6; };

/**
 * Every day between two dates, grouped into weeks and months.
 *
 * `span` on a group is a day count, which is what both renderers need: a
 * colspan in the table, and a flex-grow in the band strip. Weeks run
 * Monday–Sunday and the first and last are deliberately short rather than
 * spilling outside the window.
 *
 * Capped at ~2.5 years of days. Beyond that the day array is the expensive
 * part of rendering and nobody is reading individual dates anyway.
 */
export function buildScale(from, to) {
  const days = [];
  const MAX = 920;
  let c = from;
  while (c <= to && days.length < MAX) {
    days.push({ iso: c, dom: c.slice(8), dow: DOW[dowOf(c)], weekend: isWeekendIso(c) });
    c = addDays(c, 1);
  }
  if (!days.length) days.push({ iso: from, dom: from.slice(8), dow: DOW[dowOf(from)], weekend: isWeekendIso(from) });

  const runs = (keyOf, labelOf) => {
    const out = [];
    for (const d of days) {
      const k = keyOf(d.iso);
      const last = out[out.length - 1];
      if (last && last.key === k) { last.span++; last.to = d.iso; }
      else out.push({ key: k, label: labelOf(d.iso), span: 1, from: d.iso, to: d.iso });
    }
    return out;
  };

  return {
    from: days[0].iso,
    to: days[days.length - 1].iso,
    days,
    truncated: c <= to,
    months: runs(iso => iso.slice(0, 7), iso => fmtDate(iso, 'month')),
    weeks: runs(iso => `${toDate(iso).getFullYear()}-${isoWeek(iso)}`, iso => 'W' + isoWeek(iso)),
  };
}

/** A scale for a percentage-positioned timeline, from its own bounds. */
export const scaleFor = (from, to) => buildScale(from, to);

/* ---------- the toggle -------------------------------------------------- */

/**
 * Three buttons. `data-act="ts-row"` with `data-r`, so a view wires it with
 * one line and every timeline gets the same control in the same place.
 */
export function scaleToggle(key = 'default') {
  const show = scalePrefs(key);
  return `<div class="ts-toggle" title="Which scale bands this timeline shows">
    ${SCALE_ROWS.map(r => `<button data-act="ts-row" data-r="${r.id}" data-tsk="${esc(key)}"
        class="${show[r.id] ? 'on' : ''}" aria-pressed="${!!show[r.id]}">${esc(r.label)}</button>`).join('')}
    </div>`;
}

/**
 * The handler for the toggle. Add it to the view's `acts` map.
 *
 * The key travels on the button rather than being closed over, so one handler
 * serves a view that shows more than one timeline.
 */
export const scaleAct = rerender => (el) => {
  const key = el.dataset.tsk || 'default';
  const row = el.dataset.r;
  if (!setScaleRow(row, !scalePrefs(key)[row], key)) return;
  rerender();
};

/* ---------- renderer 1: a day-column table ------------------------------ */

/**
 * The <tr> rows for a table whose body has one <td> per day.
 *
 * `lead` is the corner cell — the Leave grid's "Person" column — and it spans
 * however many rows are showing, which is why it cannot be written by the
 * caller.
 */
export function headRows(scale, show = scalePrefs(), { lead = '', leadClass = '' } = {}) {
  const rows = SCALE_ROWS.filter(r => show[r.id]);
  const td = today();
  let out = '';

  rows.forEach((r, i) => {
    const corner = i === 0
      ? `<th class="${leadClass}" rowspan="${rows.length}">${lead}</th>`
      : '';

    if (r.id === 'date') {
      out += `<tr>${corner}${scale.days.map(d => {
        const cl = ['d'];
        if (d.weekend) cl.push('we');
        if (d.iso === td) cl.push('today');
        return `<th class="${cl.join(' ')}" title="${esc(fmtDate(d.iso, 'long'))}">${d.dom}<div class="ts-dow">${d.dow}</div></th>`;
      }).join('')}</tr>`;
    } else {
      const band = r.id === 'month' ? scale.months : scale.weeks;
      out += `<tr>${corner}${band.map(g =>
        `<th class="ts-${r.id}" colspan="${g.span}" title="${esc(g.from)} → ${esc(g.to)}">${esc(g.label)}</th>`
      ).join('')}</tr>`;
    }
  });
  return out;
}

/* ---------- renderer 2: proportional bands ------------------------------ */

/**
 * The same three bands as flex cells, for a timeline positioned in percent.
 *
 * Cells grow by their day count, so a 31-day month is wider than a 28-day one
 * and a bar at 40% lines up with the 40% mark of the strip. The date band is
 * only drawn when there is room for it — see `dayWidth()`.
 */
export function headBands(scale, show = scalePrefs(), { width = 0 } = {}) {
  const rows = SCALE_ROWS.filter(r => show[r.id]);
  if (!rows.length) return '';
  const td = today();
  const total = scale.days.length;
  const tight = width > 0 && width / total < 14;   // too narrow for "01 T"

  return `<div class="ts-bands">${rows.map(r => {
    if (r.id === 'date') {
      return `<div class="ts-band ts-band-date">${scale.days.map(d =>
        `<span class="${d.weekend ? 'we' : ''}${d.iso === td ? ' today' : ''}"
               title="${esc(fmtDate(d.iso, 'long'))}">${tight ? '' : d.dom + '<i>' + d.dow + '</i>'}</span>`
      ).join('')}</div>`;
    }
    const band = r.id === 'month' ? scale.months : scale.weeks;
    return `<div class="ts-band ts-band-${r.id}">${band.map(g =>
      `<span style="flex-grow:${g.span}" title="${esc(g.from)} → ${esc(g.to)}">${esc(g.label)}</span>`
    ).join('')}</div>`;
  }).join('')}</div>`;
}

/**
 * How wide the strip has to be for the bands that are on to be readable.
 *
 * With the date band showing, a day needs about 22px or the numbers collide.
 * Returning a minimum rather than squashing is deliberate: the container
 * scrolls, so turning the date band on over a year of gantt gives you a long
 * scrollable strip you can actually read instead of 365 unreadable slivers.
 */
export function minScaleWidth(scale, show = scalePrefs()) {
  if (show.date) return scale.days.length * 22;
  /* 24px fits "W36" at 10px and no more. A year of weeks still overflows a
     normal panel by a little, which is the honest shape of a year at week
     resolution — the container scrolls rather than clipping the labels. */
  if (show.week) return scale.weeks.length * 24;
  return scale.months.length * 56;
}

/** Height of the band strip in pixels, for layouts that must reserve it. */
export function bandsHeight(show = scalePrefs()) {
  const n = SCALE_ROWS.filter(r => show[r.id]).length;
  return n * 15 + (show.date ? 7 : 0) + 4;
}

/* Re-exported so callers do not each import ui.js for the same two helpers. */
export { addDays, isoOf, toDate, daysBetween };
