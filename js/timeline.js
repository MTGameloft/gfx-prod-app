/* ============================================================================
   timeline.js — the horizontal milestone timeline.

   A port of the Art Prod App's Overview timeline, and it keeps that app's
   hard-won rule: **the layout is measured, never assumed.**

   Cards are a fixed pixel width and are packed into lanes above AND below the
   axis from real geometry after the DOM exists. Row pitch comes from the
   rendered card height, not a constant — a constant of 36 against cards that
   render at 37 made vertically adjacent rows overlap by two pixels. There is
   no hard lane cap either: a dense cluster makes the panel taller, which is
   the truth about it. Silently stacking cards on top of each other would just
   hide work.
   ========================================================================= */

import * as S from './store.js';
import { esc, fmtDate, today, toDate, isoOf, daysBetween, addDays } from './ui.js';
import { buildScale, headBands, scalePrefs, scaleToggle, minScaleWidth } from './timescale.js';

const CARD_W   = 178;   // fixed, so packing can be computed in pixels
const ROW      = 36;    // minimum one card row
const AXIS_PAD = 16;    // axis to the nearest card row
/* The month/week/date strip is now a real element under the track — see
   timescale.js — so the track only reserves a little breathing room rather
   than the height of labels it no longer draws itself. */
const LABELS_H = 6;
const NOW_H    = 21;    // headroom for the TODAY label above the tallest card
const CARD_GAP = 8;
const ALERT_DAYS = 14;

export const RANGES = [['3m', '3 months'], ['6m', '6 months'], ['12m', '1 year']];

/* ---------- dates -------------------------------------------------------- */

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 86400000 + 1) / 7);
}

/** Window: a fortnight of history for context, then N months forward. */
export function bounds(range = '6m') {
  const months = { '3m': 3, '6m': 6, '12m': 12 }[range] || 6;
  const from = addDays(today(), -14);
  const d = toDate(today());
  d.setMonth(d.getMonth() + months);
  return { from, to: isoOf(d) };
}

const pct = (iso, b) => {
  const span = Math.max(1, daysBetween(b.from, b.to));
  return (daysBetween(b.from, iso) / span) * 100;
};

function weekTicks(b) {
  const out = [];
  let c = b.from;
  // walk to the first Monday so gridlines land on week boundaries
  while (toDate(c).getDay() !== 1 && c <= b.to) c = addDays(c, 1);
  let guard = 0;
  while (c <= b.to && guard++ < 120) {
    out.push({ pct: pct(c, b), wk: 'W' + isoWeek(toDate(c)), iso: c });
    c = addDays(c, 7);
  }
  return out;
}

function monthTicks(b) {
  const out = [];
  const d = toDate(b.from);
  d.setDate(1);
  let guard = 0;
  while (guard++ < 40) {
    const iso = isoOf(d);
    if (iso > b.to) break;
    if (iso >= b.from) out.push({ pct: pct(iso, b), label: fmtDate(iso, 'month') });
    d.setMonth(d.getMonth() + 1);
  }
  return out;
}

/* ---------- markup ------------------------------------------------------- */

const statusColour = (m, late) =>
  m.status === 'done' ? 'var(--ok)'
  : late ? 'var(--risk)'
  : m.status === 'at-risk' ? 'var(--warn)'
  : 'var(--info)';

/**
 * @param {Array} items  [{ id, name, date, status, projectId, projectCode, projectName, colour }]
 * @param {Array} pips   [{ date, overdue, title }] — task due dates
 */
export function timelineHTML(items, { range = '6m', pips = [], scaleKey = 'dashboard',
                                      emptyMsg = 'Nothing in this window.' } = {}) {
  const b = bounds(range);
  const td = today();
  const inWindow = items.filter(m => m.date >= b.from && m.date <= b.to);

  const nowPct = pct(td, b);
  const bandA = Math.max(0, nowPct);
  const bandB = Math.min(100, pct(addDays(td, ALERT_DAYS), b));

  const weeks = weekTicks(b);
  const months = monthTicks(b);

  const grid = weeks.map(w => `<span class="tl-grid" style="left:${w.pct.toFixed(3)}%"></span>`).join('')
    + months.map(m => `<span class="tl-grid month" style="left:${m.pct.toFixed(3)}%"></span>`).join('');

  /*
   * The scale is the shared strip, drawn under the track rather than as ticks
   * inside it. It used to be week and month labels positioned absolutely and
   * thinned by measurement until they stopped touching, which meant this
   * timeline's scale never quite matched the Leave grid's or the portfolio's.
   * With the date band on, the track is given a minimum width and the panel
   * scrolls — the cards are positioned in percent, so they spread with it.
   */
  const show = scalePrefs(scaleKey);
  const scale = buildScale(b.from, b.to);
  const minW = show.date ? minScaleWidth(scale, show) : 0;

  const pipHtml = pips.map(p => {
    const x = pct(p.date, b);
    if (x < 0 || x > 100) return '';
    return `<span class="tl-pip ${p.overdue ? 'over' : ''}" style="left:${x.toFixed(3)}%" title="${esc(p.title)} · ${esc(fmtDate(p.date))}"></span>`;
  }).join('');

  const marks = inWindow.map(m => {
    const late = m.status !== 'done' && m.date < td;
    const col = m.colour || statusColour(m, late);
    const x = pct(m.date, b);
    const wk = 'W' + isoWeek(toDate(m.date));
    const meta = [fmtDate(m.date), wk, m.projectCode].filter(Boolean).join(' · ');
    const state = m.status === 'done' ? 'Done' : late ? 'LATE' : m.status === 'at-risk' ? 'At risk' : 'Planned';
    /* `goId` is whatever the caller wants a click to resolve to when the mark
       is not a project's — an objective, say. `wireMilestones` hands it to an
       `onMark` callback so this module stays ignorant of what it points at. */
    return `<div class="tl-ms" style="left:${x.toFixed(3)}%" data-pct="${x.toFixed(3)}"
              data-ms="${esc(m.id)}" data-project="${esc(m.projectId || '')}"
              data-go="${esc(m.goId || '')}" data-kind="${esc(m.kind || '')}"
              title="${esc(m.name)} — ${esc(fmtDate(m.date, 'long'))} · ${esc(wk)} · ${esc(state)}${m.projectName ? ' · ' + esc(m.projectName) : ''}">
      <span class="tl-stem"></span>
      <span class="tl-dot" style="background:${col}"></span>
      <span class="tl-card" style="border-left-color:${col}">
        <b>${esc(m.name)}</b><span>${esc(meta)}${late ? ' · late' : ''}</span>
      </span>
    </div>`;
  }).join('');

  return `
  <div class="tl">
    ${inWindow.length ? '' : `<div class="tl-empty">${esc(emptyMsg)}</div>`}
    <div class="tl-scroll">
      <div class="tl-inner" style="${minW ? `min-width:${minW}px` : ''}">
        <div class="tl-track" data-tl-track>
          ${grid}
          ${bandB > bandA ? `<span class="tl-band" style="left:${bandA.toFixed(3)}%;width:${(bandB - bandA).toFixed(3)}%" title="Next ${ALERT_DAYS} days"></span>` : ''}
          <span class="tl-axis"></span>
          ${pipHtml}
          ${nowPct >= 0 && nowPct <= 100 ? `<span class="tl-now" style="left:${nowPct.toFixed(3)}%"><b>Today</b></span>` : ''}
          ${marks}
        </div>
        ${headBands(scale, show, { width: minW })}
      </div>
    </div>
    <div class="tl-legend">
      <span><i style="background:var(--info)"></i>Planned</span>
      <span><i style="background:var(--warn)"></i>At risk</span>
      <span><i style="background:var(--risk)"></i>Late</span>
      <span><i style="background:var(--ok)"></i>Done</span>
      ${pips.length ? '<span><i style="background:var(--text-mute)"></i>Task due date</span>' : ''}
      ${show.week ? '<span>W## = ISO week</span>' : ''}
      <span style="margin-left:auto">Click a milestone to open its project</span>
    </div>
  </div>`;
}

/* ---------- the panel, for anywhere that wants this timeline ------------- */

/**
 * The range each timeline is looking at, remembered separately.
 *
 * The dashboard, the portfolio and each individual project are looking at
 * different questions — a year for the portfolio, a quarter for the project
 * you are about to ship — so one shared range would fight itself. The
 * dashboard's original `prefs.tlRange` is the fallback, so its setting
 * survives this change.
 */
export function rangeOf(key = 'dashboard') {
  const by = S.get()?.prefs?.tlRangeBy;
  const own = by && typeof by === 'object' ? by[key] : null;
  const r = own || S.get()?.prefs?.tlRange || '6m';
  return RANGES.some(([k]) => k === r) ? r : '6m';
}

export function setRange(key, value) {
  S.mutate(s => {
    s.prefs ||= {};
    s.prefs.tlRangeBy = { ...(s.prefs.tlRangeBy || {}), [key]: value };
  }, { silent: true, noUndo: true, label: 'timeline range' });
}

/**
 * A whole card: header with the scale toggle and the range buttons, and the
 * timeline itself.
 *
 * Exists so the portfolio and each project get the dashboard's timeline
 * rather than a lookalike — same today marker, same ranges, same scale bands,
 * same measured card packing. One implementation, three callers.
 *
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.sub]        overridden with the in-view count
 * @param {Array}  o.items        milestones, as timelineHTML expects
 * @param {Array}  [o.pips]       task due dates
 * @param {string} o.key          identity for the remembered range and scale
 * @param {string} [o.emptyMsg]
 * @param {string} [o.extra]      extra header buttons, e.g. a link out
 */
export function milestonePanel(o) {
  const key = o.key || 'dashboard';
  const range = rangeOf(key);
  const b = bounds(range);
  const shown = (o.items || []).filter(m => m.date >= b.from && m.date <= b.to).length;

  return `
  <section class="card">
    <header><h3>${esc(o.title)}</h3>
      <span class="sub">${shown} in view${o.sub ? ' · ' + esc(o.sub) : ''} · ◆ on the axis</span>
      <div class="spacer" style="flex:1"></div>
      ${scaleToggle(key)}
      <div class="seg">
        ${RANGES.map(([k, l]) => `<button data-act="tl-range" data-v="${k}" data-rk="${esc(key)}"
          class="${range === k ? 'on' : ''}" title="${esc(l)}">${k}</button>`).join('')}
      </div>
      ${o.extra || ''}</header>
    <div class="body">
      ${timelineHTML(o.items || [], { range, pips: o.pips || [], scaleKey: key,
                                      emptyMsg: o.emptyMsg || 'Nothing in this window.' })}
    </div>
  </section>`;
}

/**
 * Wire one or more panels in a host: the range buttons, the milestone click,
 * and the measured layout. Returns the teardown for the view's cleanup.
 */
export function wireMilestones(host, ctx, { onMark = null } = {}) {
  host.addEventListener('click', e => {
    const rb = e.target.closest('[data-act="tl-range"]');
    if (rb) {
      e.preventDefault();
      setRange(rb.dataset.rk || 'dashboard', rb.dataset.v);
      ctx.rerender();
      return;
    }
    const ms = e.target.closest('.tl-ms');
    if (!ms) return;
    /* A caller with its own notion of what a mark points at gets first refusal;
       everything else keeps the original behaviour of opening the project. */
    if (onMark && ms.dataset.go) {
      onMark(ms.dataset.go, ms.dataset.ms, ms.dataset.kind);
      return;
    }
    if (ms.dataset.project) ctx.go('projects', ms.dataset.project);
  });
  return observeTimeline(host);
}

/* ---------- layout ------------------------------------------------------- */

/**
 * Measure and place. Must run after the markup is in the document, and again
 * whenever the width changes.
 */
export function layoutTimeline(root) {
  const track = root?.querySelector('[data-tl-track]');
  if (!track) return;
  const W = track.clientWidth;

  // Degenerate width (collapsed panel, hidden tab): leave a sane height and
  // skip packing rather than divide by zero.
  if (W < 120) {
    track.style.height = (NOW_H + ROW + AXIS_PAD * 2 + LABELS_H) + 'px';
    track.style.setProperty('--axis-y', (NOW_H + ROW + AXIS_PAD) + 'px');
    track.style.setProperty('--labels-h', LABELS_H + 'px');
    return;
  }

  const items = [...track.querySelectorAll('.tl-ms')]
    .map(el => ({ el, pct: parseFloat(el.dataset.pct) || 0 }))
    .sort((a, b) => a.pct - b.pct);

  // Fix the width first, then measure a real card.
  items.forEach(it => { it.el.querySelector('.tl-card').style.width = CARD_W + 'px'; });
  const sample = items.length ? items[0].el.querySelector('.tl-card') : null;
  const cardH = sample ? Math.ceil(sample.getBoundingClientRect().height) : 34;
  const PITCH = Math.max(ROW, cardH + 6);

  const used = {};                 // "side|lane" -> [[x1,x2], …]
  let maxUp = -1, maxDown = -1;

  for (const it of items) {
    it.cx = (it.pct / 100) * W;
    it.x = Math.max(0, Math.min(W - CARD_W, it.cx - CARD_W / 2));
    const free = (side, lane) => {
      const arr = used[side + '|' + lane] || [];
      return arr.every(([a, z]) => it.x + CARD_W + CARD_GAP <= a || it.x >= z + CARD_GAP);
    };
    // A fresh lane is always free, so a card can never be forced to overlap.
    let placed = false;
    for (let lane = 0; !placed; lane++) {
      for (const side of ['up', 'down']) {
        if (free(side, lane)) {
          (used[side + '|' + lane] = used[side + '|' + lane] || []).push([it.x, it.x + CARD_W]);
          it.side = side; it.lane = lane; placed = true;
          break;
        }
      }
      if (lane > 200) break;        // pathological data guard, not a layout cap
    }
    if (!placed) { it.side = 'up'; it.lane = 0; }
    if (it.side === 'up') maxUp = Math.max(maxUp, it.lane);
    else maxDown = Math.max(maxDown, it.lane);
  }

  const upRows = maxUp + 1;
  const downRows = maxDown + 1;
  const axisY = NOW_H + (upRows ? upRows * PITCH : PITCH) + AXIS_PAD;
  const height = axisY + AXIS_PAD + downRows * PITCH + LABELS_H;

  track.style.height = height + 'px';
  track.style.setProperty('--axis-y', axisY + 'px');
  track.style.setProperty('--labels-h', LABELS_H + 'px');

  for (const it of items) {
    const card = it.el.querySelector('.tl-card');
    const stem = it.el.querySelector('.tl-stem');
    const dot = it.el.querySelector('.tl-dot');
    dot.style.top = (axisY - 5.5) + 'px';
    const top = it.side === 'up'
      ? axisY - AXIS_PAD - (it.lane + 1) * PITCH
      : axisY + AXIS_PAD + it.lane * PITCH;
    card.style.top = top + 'px';
    card.style.left = Math.round(it.x - it.cx) + 'px';
    card.style.width = CARD_W + 'px';
    if (it.side === 'up') {
      const bottom = top + cardH;
      stem.style.top = bottom + 'px';
      stem.style.height = Math.max(0, axisY - bottom) + 'px';
    } else {
      stem.style.top = axisY + 'px';
      stem.style.height = Math.max(0, top - axisY) + 'px';
    }
  }

}

/**
 * Keep it correct when the panel or window changes size. Returns a teardown
 * function for the view's cleanup.
 */
export function observeTimeline(root) {
  let t = null;
  const relayout = () => { clearTimeout(t); t = setTimeout(() => layoutTimeline(root), 90); };
  layoutTimeline(root);
  // a second pass after fonts settle, or the first measurement is a pixel out
  setTimeout(() => layoutTimeline(root), 120);
  window.addEventListener('resize', relayout);
  let ro = null;
  const track = root?.querySelector('[data-tl-track]');
  if (track && 'ResizeObserver' in window) {
    ro = new ResizeObserver(relayout);
    ro.observe(track.parentElement || track);
  }
  return () => { clearTimeout(t); window.removeEventListener('resize', relayout); ro?.disconnect(); };
}
