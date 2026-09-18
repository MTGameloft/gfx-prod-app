/**
 * gantt.js — the interactive Gantt chart.
 *
 * One renderer, used in three places: the Plan view, the portfolio, and the
 * work-breakdown screen. It replaces two things that were nearly but not
 * quite the same — the milestone timeline and the "project spans" strip —
 * because having both meant the portfolio page showed the same dates twice,
 * differently, and neither of them showed the work.
 *
 * WHAT IT IS MADE OF
 *
 *   A frozen left column of rows (project → scope → division line), and a
 *   scrolling right pane of bars on a day grid. Both panes scroll vertically
 *   as one; only the right pane scrolls horizontally. The header is sticky.
 *
 * DESIGN DECISIONS WORTH THE WORDS
 *
 * 1. PIXELS PER DAY, NOT PERCENT. The old timeline positioned everything in
 *    percent of a container, which meant a bar's width carried no meaning you
 *    could read off — two weeks looked different on a 3-month view and a
 *    1-year one. Here a day is a fixed number of pixels set by the zoom, so
 *    the eye learns the scale and a long bar is genuinely long. It also makes
 *    dragging exact: a drag of 3 × dayPx is a drag of 3 days, with no
 *    round-tripping through a percentage.
 *
 * 2. MILESTONES LIVE ON THEIR PROJECT'S ROW. Diamonds on the project bar,
 *    not in a lane of their own. That is the merge with the old Timeline: a
 *    milestone is a date belonging to a project, and putting it on the
 *    project's row says so, while the old separate panel made you match them
 *    up by eye.
 *
 * 3. DRAG MOVES, THE RIGHT HANDLE RE-CREWS. Dragging a bar sideways moves
 *    when the work happens. Dragging its right edge changes how long it is
 *    allowed to take — and because effort is fixed, that is a statement about
 *    crew, so the app answers with the crew it would need. This is the
 *    interaction the whole feature exists for, and making it the resize
 *    gesture puts it where a producer's hand already is.
 *
 * 4. NOTHING IS WRITTEN UNTIL THE POINTER IS RELEASED. A drag paints a ghost
 *    and reports back once. Committing on every pointermove would fill the
 *    undo ring with forty entries for one gesture, and dirty the backup forty
 *    times — the same lesson as the Availability grid.
 *
 * 5. THE CHART RENDERS FROM A SIMULATION, NOT FROM STATE. The caller hands it
 *    bars that a `plan.js` simulation produced, so what is drawn and what the
 *    capacity strip counts are the same numbers. Two readings of one model
 *    cannot drift apart; two models always do.
 */

import { esc, fmtDate, today, toDate, addDays, fmtMoney, fmtNum } from './ui.js';
import { buildScale, isoWeek } from './timescale.js';
import { workCalendar } from './plan.js';

/* ---------- zoom --------------------------------------------------------- */

/**
 * Three zooms, and the day width each implies.
 *
 * `dayPx` is the single number the whole layout derives from. The names are
 * about what you are reading at that width rather than about the number:
 * at 22px you are reading individual days, at 7px a week is a legible block,
 * at 2.6px you are reading quarters and a day is a hairline.
 */
export const ZOOMS = [
  { id: 'day',   label: 'Days',   dayPx: 22, bands: { month: true, week: true, date: true } },
  { id: 'week',  label: 'Weeks',  dayPx: 7,  bands: { month: true, week: true, date: false } },
  { id: 'month', label: 'Months', dayPx: 2.6, bands: { month: true, week: false, date: false } },
];
export const zoomOf = id => ZOOMS.find(z => z.id === id) || ZOOMS[1];

const LABEL_W = 268;      // the frozen column; wide enough for a scope name
const ROW_H   = 30;
const BAR_H   = 16;

/* ---------- geometry ----------------------------------------------------- */

/**
 * The mapping between dates and pixels, and back.
 *
 * `x(iso)` is the LEFT edge of that day and `xEnd(iso)` its right, so a
 * one-day bar is one day wide rather than zero. Getting this wrong is the
 * classic off-by-one that makes every bar finish the evening before it should.
 */
export function geometry(from, to, dayPx) {
  const span = Math.max(1, dayCount(from, to));
  return {
    from, to, dayPx, span,
    width: span * dayPx,
    x:    iso => dayCount(from, iso) * dayPx,
    xEnd: iso => (dayCount(from, iso) + 1) * dayPx,
    /** Pixel offset back to a date, clamped to the window. */
    iso:  px => addDays(from, Math.max(0, Math.min(span - 1, Math.round(px / dayPx)))),
    /** A pixel delta as a whole number of calendar days. */
    days: px => Math.round(px / dayPx),
  };
}

const dayCount = (a, b) =>
  Math.round((toDate(b) - toDate(a)) / 86400000);

/* ---------- header ------------------------------------------------------- */

/**
 * The scale strip, drawn at pixel widths rather than flex-grow.
 *
 * `headBands()` in timescale.js grows cells proportionally inside a flex row,
 * which is right for a percentage-positioned timeline and wrong here: the
 * bars are placed at absolute pixels, so the header has to be too or a month
 * label drifts off its month by a few pixels at the far end of a year.
 */
function header(geo, bands, cal) {
  const scale = buildScale(geo.from, geo.to);
  const td = today();
  const rows = [];

  if (bands.month) {
    rows.push(`<div class="gx-band gx-band-month">${scale.months.map(g =>
      `<span style="left:${geo.x(g.from)}px;width:${g.span * geo.dayPx}px"
         title="${esc(g.from)} → ${esc(g.to)}">${esc(g.label)}</span>`).join('')}</div>`);
  }
  if (bands.week) {
    rows.push(`<div class="gx-band gx-band-week">${scale.weeks.map(g =>
      `<span style="left:${geo.x(g.from)}px;width:${g.span * geo.dayPx}px"
         title="${esc(g.from)} → ${esc(g.to)}">${g.span * geo.dayPx > 22 ? esc(g.label) : ''}</span>`).join('')}</div>`);
  }
  if (bands.date) {
    rows.push(`<div class="gx-band gx-band-date">${scale.days.map(d =>
      `<span class="${d.weekend ? 'we' : ''}${d.iso === td ? ' today' : ''}"
         style="left:${geo.x(d.iso)}px;width:${geo.dayPx}px"
         title="${esc(fmtDate(d.iso, 'long'))}">${geo.dayPx >= 18 ? d.dom : ''}</span>`).join('')}</div>`);
  }
  return rows.join('');
}

/**
 * Non-working days as a single stack of shaded columns behind everything.
 *
 * Drawn once for the whole chart rather than per row: at day zoom over a year
 * that is the difference between 260 elements and 260 × rows, which is the
 * difference between a chart that scrolls and one that does not.
 */
function backdrop(geo, cal, periodLines) {
  let out = '';
  // runs of consecutive non-working days, so a weekend is one element not two
  let runFrom = null, prev = null;
  for (const d of cal.days) {
    if (!d.working) { if (runFrom === null) runFrom = d.iso; prev = d.iso; }
    else if (runFrom !== null) {
      out += `<span class="gx-off" style="left:${geo.x(runFrom)}px;width:${geo.xEnd(prev) - geo.x(runFrom)}px"></span>`;
      runFrom = null;
    }
  }
  if (runFrom !== null) out += `<span class="gx-off" style="left:${geo.x(runFrom)}px;width:${geo.xEnd(prev) - geo.x(runFrom)}px"></span>`;

  for (const iso of periodLines) out += `<span class="gx-gl" style="left:${geo.x(iso)}px"></span>`;
  return out;
}

/* ---------- rows --------------------------------------------------------- */

const KIND_ICON = {
  project: 'flag', scope: 'sheet', division: 'board',
  task: 'check', request: 'plus', milestone: 'star',
};

/** Indent depth, so a division line sits under its scope under its project. */
const depthOf = (bar, byId) => {
  let n = 0, cur = bar;
  while (cur.parentId && byId.get(cur.parentId) && n < 6) { n++; cur = byId.get(cur.parentId); }
  return n;
};

function labelCell(bar, depth, collapsed, hasKids, sym) {
  const money = bar.cost ? fmtMoney(bar.cost, sym) : '';
  const chev = hasKids
    ? `<button class="gx-chev${collapsed ? '' : ' open'}" data-act="gx-fold" data-b="${esc(bar.id)}"
         title="${collapsed ? 'Expand' : 'Collapse'}" aria-expanded="${!collapsed}">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"
              stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></button>`
    : '<span class="gx-chev-sp"></span>';

  const meta = [];
  if (bar.hours) meta.push(`${fmtNum(bar.hours, 0)}h`);
  if (bar.crew && bar.kind !== 'project') meta.push(`${bar.crew}×`);
  if (bar.workDays) meta.push(`${fmtNum(bar.workDays, 0)}d`);

  return `<div class="gx-lbl gx-k-${esc(bar.kind)}${bar.scenario ? ' scn' : ''}"
            style="padding-left:${8 + depth * 15}px" data-b="${esc(bar.id)}"
            title="${esc(bar.label)}">
    ${chev}
    <span class="gx-dot" style="background:${esc(bar.color)}"></span>
    <span class="gx-name">${esc(bar.code ? bar.code + ' · ' : '')}${esc(bar.label)}</span>
    ${bar.unstaffed ? '<span class="chip risk" style="margin-left:4px">no crew</span>' : ''}
    <span class="gx-meta">${esc(meta.join(' · '))}${money ? ' · ' + esc(money) : ''}</span>
  </div>`;
}

/**
 * One bar. `data-*` carries everything the drag handler needs, so the handler
 * reads the DOM rather than closing over a snapshot that a re-render would
 * make stale.
 */
function barCell(bar, geo, sym) {
  if (!bar.start || !bar.end) {
    return `<div class="gx-track" data-b="${esc(bar.id)}"></div>`;
  }
  const left = geo.x(bar.start);
  const w = Math.max(3, geo.xEnd(bar.end) - left);
  const late = bar.overdue || bar.missesDeadline;
  const cls = ['gx-bar', `gx-b-${bar.kind}`];
  if (bar.scenario) cls.push('scn');
  if (late) cls.push('late');
  if (bar.unstaffed) cls.push('unstaffed');
  if (bar.status === 'done') cls.push('done');

  const tip = [
    bar.label,
    `${fmtDate(bar.start, 'long')} → ${fmtDate(bar.end, 'long')}`,
    bar.workDays ? `${fmtNum(bar.workDays, 0)} working days` : '',
    bar.hours ? `${fmtNum(bar.hours, 1)} person-hours` : '',
    bar.crew ? `crew of ${bar.crew}` : '',
    bar.cost ? fmtMoney(bar.cost, sym) : '',
  ].filter(Boolean).join(' · ');

  /* Only the rows that mean something to move are draggable. A project span
     is a fact about the project, edited on the project; a division line is
     derived from its scope. Offering a handle that silently does nothing is
     worse than offering none. */
  const movable = bar.kind === 'scope' || bar.kind === 'task' || bar.kind === 'request';

  const ms = (bar.milestones || []).map(m => {
    if (m.date < geo.from || m.date > geo.to) return '';
    const col = m.status === 'done' ? 'var(--ok)'
      : (m.status !== 'done' && m.date < today()) ? 'var(--risk)'
      : m.status === 'at-risk' ? 'var(--warn)' : 'var(--info)';
    return `<span class="gx-ms" style="left:${geo.x(m.date) + geo.dayPx / 2}px;background:${col}"
      data-act="gx-ms" data-m="${esc(m.id)}" data-p="${esc(bar.projectId)}"
      title="${esc(m.name)} — ${esc(fmtDate(m.date, 'long'))} · W${isoWeek(m.date)} · ${esc(m.status || 'planned')}"></span>`;
  }).join('');

  const label = w > 58 ? `<span class="gx-bar-t">${esc(bar.label)}</span>` : '';

  return `<div class="gx-track" data-b="${esc(bar.id)}">
    <div class="${cls.join(' ')}" style="left:${left}px;width:${w}px;--bar:${esc(bar.color)}"
         data-act="gx-bar" data-b="${esc(bar.id)}" data-ref="${esc(bar.ref || '')}"
         data-kind="${esc(bar.kind)}" data-start="${esc(bar.start)}" data-end="${esc(bar.end)}"
         data-move="${movable ? 1 : 0}" title="${esc(tip)}">
      ${label}
      ${movable ? '<span class="gx-grip gx-grip-r" data-act="gx-resize" data-b="' + esc(bar.id) + '"></span>' : ''}
    </div>
    ${bar.deadline ? `<span class="gx-deadline" style="left:${geo.x(bar.deadline) + geo.dayPx / 2}px"
        title="Deadline ${esc(fmtDate(bar.deadline, 'long'))}"></span>` : ''}
    ${ms}
  </div>`;
}

/* ---------- the chart ---------------------------------------------------- */

/**
 * Render a Gantt.
 *
 * @param {object} o
 * @param {Array}  o.bars        from plan.js — already in render order
 * @param {string} o.from,o.to   window
 * @param {string} [o.zoom]      'day' | 'week' | 'month'
 * @param {Set}    [o.collapsed] bar ids whose children are hidden
 * @param {Array}  [o.periods]   period boundaries to draw gridlines at
 * @param {string} [o.footer]    extra markup under the rows, aligned to the
 *                               same pixel grid — the capacity strip uses it
 * @param {number} [o.maxRows]   guard against a pathological render
 */
export function ganttHTML({ bars, from, to, zoom = 'week', collapsed = new Set(),
                            periods = [], footer = '', emptyMsg = 'Nothing scheduled in this window.',
                            sym = '$', maxRows = 400 } = {}) {
  const z = zoomOf(zoom);
  const geo = geometry(from, to, z.dayPx);
  const cal = workCalendar(from, to);

  const byId = new Map(bars.map(b => [b.id, b]));
  const kidsOf = new Map();
  for (const b of bars) {
    if (!b.parentId) continue;
    if (!kidsOf.has(b.parentId)) kidsOf.set(b.parentId, []);
    kidsOf.get(b.parentId).push(b);
  }

  /* A row is hidden when any ancestor is collapsed — not merely its parent,
     or collapsing a project would leave its scopes' division lines floating
     with nothing above them. */
  const hidden = b => {
    let cur = byId.get(b.parentId);
    let n = 0;
    while (cur && n++ < 8) {
      if (collapsed.has(cur.id)) return true;
      cur = byId.get(cur.parentId);
    }
    return false;
  };

  const visible = bars.filter(b => !hidden(b)).slice(0, maxRows);

  if (!bars.length) {
    return `<div class="gx-empty">${esc(emptyMsg)}</div>`;
  }

  const labels = visible.map(b =>
    labelCell(b, depthOf(b, byId), collapsed.has(b.id), (kidsOf.get(b.id) || []).length > 0, sym)).join('');
  const tracks = visible.map(b => barCell(b, geo, sym)).join('');

  const todayX = (today() >= from && today() <= to)
    ? `<div class="gx-today" style="left:${geo.x(today()) + geo.dayPx / 2}px"><b>Today</b></div>` : '';

  return `
  <div class="gx" data-gx style="--gx-label:${LABEL_W}px;--gx-row:${ROW_H}px;--gx-bar:${BAR_H}px">
    <div class="gx-scroll" data-gx-scroll>
      <div class="gx-canvas" style="width:${LABEL_W + geo.width}px">

        <div class="gx-head">
          <div class="gx-head-lbl">Work</div>
          <div class="gx-head-time" style="width:${geo.width}px">${header(geo, z.bands, cal)}</div>
        </div>

        <div class="gx-body">
          <div class="gx-col-lbl">${labels}</div>
          <div class="gx-col-time" style="width:${geo.width}px" data-gx-time data-daypx="${geo.dayPx}"
               data-from="${esc(from)}" data-to="${esc(to)}">
            <div class="gx-backdrop">${backdrop(geo, cal, periods)}</div>
            ${todayX}
            ${tracks}
          </div>
        </div>

        ${footer ? `<div class="gx-foot">${footer}</div>` : ''}
      </div>
    </div>
  </div>`;
}

/* ---------- the capacity strip, on the same pixel grid ------------------- */

/**
 * One row per division, one cell per period, coloured by load.
 *
 * Rendered as the Gantt's footer rather than as a separate panel underneath,
 * because the whole value is reading a red week against the bars that caused
 * it. A separate panel with its own scroll would put them a scroll apart, and
 * two scrollbars that have to be kept in sync by hand is the state this was
 * built to get out of.
 *
 * COLOUR. Five steps, and the top one is reserved for genuinely over 100%.
 * Spreading the scale evenly made 95% and 105% nearly the same shade, which
 * hides the only boundary that matters. Everything under 100 shares the lower
 * four.
 */
export function capacityStripHTML(load, geo, { onlyDivisions = null, sym = '$' } = {}) {
  const rows = load.rows.filter(r => !onlyDivisions || onlyDivisions.has(r.division.id));
  if (!rows.length) return '';

  const cell = (c, div, i) => {
    const pct = c.loadPct;
    const step = !Number.isFinite(pct) ? (c.needed > 0 ? 5 : 0)
      : pct > 100 ? 5 : pct > 85 ? 4 : pct > 60 ? 3 : pct > 25 ? 2 : pct > 0 ? 1 : 0;
    const left = geo.x(c.period.from);
    const w = Math.max(2, geo.xEnd(c.period.to) - left);
    const txt = w > 30
      ? (Number.isFinite(pct) ? Math.round(pct) + '%' : '∞')
      : '';
    /* The tooltip says WHERE the number came from, not just what it is. A
       cell at 120% because five people are allocated elsewhere is a different
       conversation from one at 120% because of a scope you can move, and a
       bare percentage cannot tell you which you are looking at. */
    const src = c.source === 'allocation'
      ? `committed ${fmtNum(c.committed, 1)}d — from allocation (${fmtNum(c.scheduled, 1)}d of it itemised)`
      : `committed ${fmtNum(c.committed, 1)}d — all itemised work`;
    const tip = `${div.label} · ${c.period.label} (${fmtDate(c.period.from)} → ${fmtDate(c.period.to)})\n`
      + `${fmtNum(c.needed, 1)} person-days needed of ${fmtNum(c.available, 1)} available\n`
      + src
      + (c.extra > 0.05 ? `\n+ ${fmtNum(c.extra, 1)}d from this scenario` : '')
      + (c.gap > 0.05 ? `\nSHORT ${fmtNum(c.gap, 1)} days` : c.gap < -0.05 ? `\n${fmtNum(-c.gap, 1)} days spare` : '')
      + (c.contributors.length ? `\n${c.contributors.length} piece(s) of work — click for the breakdown` : '\nClick for the breakdown');
    return `<span class="gx-cap s${step}${c.over ? ' over' : ''}" style="left:${left}px;width:${w - 1}px"
       data-act="gx-cell" data-d="${esc(div.id)}" data-i="${i}" title="${esc(tip)}">${txt}</span>`;
  };

  return `<div class="gx-cap-strip">
    ${rows.map(r => `
      <div class="gx-cap-row">
        <div class="gx-cap-lbl" title="${esc(r.division.label)} — ${r.heads} ${r.heads === 1 ? 'person' : 'people'}">
          <span class="gx-dot" style="background:${esc(r.division.color || 'var(--muted)')}"></span>
          <span class="gx-name">${esc(r.division.id)}</span>
          <span class="gx-meta">${r.heads}p${r.shortfallDays > 0.5 ? ` · <b class="bad">−${fmtNum(r.shortfallDays, 0)}d</b>` : ''}</span>
        </div>
        <div class="gx-cap-track">${r.cells.map((c, i) => cell(c, r.division, i)).join('')}</div>
      </div>`).join('')}
  </div>`;
}

/* ---------- interaction -------------------------------------------------- */

/**
 * Wire a rendered chart.
 *
 * @param {HTMLElement} host   the element the chart was rendered into
 * @param {object} handlers
 * @param {(id:string)=>void} handlers.onFold
 * @param {(bar:{id,ref,kind})=>void} handlers.onOpen
 * @param {(m:{msId,projectId})=>void} handlers.onMilestone
 * @param {(o:{id,ref,kind,days})=>void} handlers.onMove    dropped, N days
 * @param {(o:{id,ref,kind,days,newEnd})=>void} handlers.onResize
 * @param {(o:{divisionId,index})=>void} handlers.onCell
 * @returns {() => void} teardown
 */
export function wireGantt(host, handlers = {}) {
  const gx = host.querySelector('[data-gx]');
  if (!gx) return () => {};

  /* Declared before the click handler that reads it: a click fires at the end
     of a drag, and the flag is how the two are told apart. */
  let drag = null, dragged = false;

  const click = e => {
    const fold = e.target.closest('[data-act="gx-fold"]');
    if (fold) { e.stopPropagation(); handlers.onFold?.(fold.dataset.b); return; }

    const ms = e.target.closest('[data-act="gx-ms"]');
    if (ms) { e.stopPropagation(); handlers.onMilestone?.({ msId: ms.dataset.m, projectId: ms.dataset.p }); return; }

    const cell = e.target.closest('[data-act="gx-cell"]');
    if (cell) { handlers.onCell?.({ divisionId: cell.dataset.d, index: Number(cell.dataset.i) }); return; }

    if (dragged) return;                       // a drag ends in a click; ignore it
    const bar = e.target.closest('[data-act="gx-bar"]');
    if (bar) { handlers.onOpen?.({ id: bar.dataset.b, ref: bar.dataset.ref, kind: bar.dataset.kind }); return; }

    const lbl = e.target.closest('.gx-lbl');
    if (lbl) {
      const b = gx.querySelector(`[data-act="gx-bar"][data-b="${CSS.escape(lbl.dataset.b)}"]`);
      if (b) handlers.onOpen?.({ id: b.dataset.b, ref: b.dataset.ref, kind: b.dataset.kind });
    }
  };
  gx.addEventListener('click', click);

  /* ---- drag to move, drag the right grip to re-crew --------------------- */

  const down = e => {
    if (e.button !== 0) return;
    const grip = e.target.closest('[data-act="gx-resize"]');
    const bar = e.target.closest('[data-act="gx-bar"]');
    if (!bar || bar.dataset.move !== '1') return;
    const time = gx.querySelector('[data-gx-time]');
    if (!time) return;

    e.preventDefault();
    dragged = false;
    drag = {
      el: bar, mode: grip ? 'resize' : 'move',
      x0: e.clientX,
      left0: parseFloat(bar.style.left) || 0,
      w0: parseFloat(bar.style.width) || 0,
      dayPx: Number(time.dataset.daypx) || 7,
      from: time.dataset.from,
      start: bar.dataset.start, end: bar.dataset.end,
    };
    bar.classList.add('dragging');
    gx.classList.add('gx-dragging');
    showHint(gx, drag, 0);
  };

  const move = e => {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    const days = Math.round(dx / drag.dayPx);
    if (Math.abs(dx) > 3) dragged = true;
    if (drag.mode === 'move') {
      drag.el.style.left = (drag.left0 + days * drag.dayPx) + 'px';
    } else {
      /* A bar may not be dragged shorter than one day. Allowing zero would
         produce a divide-by-zero crew and an "Infinity people" answer. */
      drag.el.style.width = Math.max(drag.dayPx, drag.w0 + days * drag.dayPx) + 'px';
    }
    drag.days = days;
    showHint(gx, drag, days);
  };

  const up = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.el.classList.remove('dragging');
    gx.classList.remove('gx-dragging');
    hideHint(gx);
    const days = d.days || 0;
    if (!days) { d.el.style.left = d.left0 + 'px'; d.el.style.width = d.w0 + 'px'; return; }

    /*
     * DIRECT MANIPULATION: the bar lands on the date it was dropped on.
     *
     * The first version reported a delta in calendar days and let the handler
     * walk that many WORKING days forward, which meant the read-out said
     * "16 Sep" and the task came back dated the 18th. Dragging is pointing at
     * a date; anything other than landing on it is the tool arguing with the
     * gesture. So the payload carries the dates, and the handler's only
     * liberty is to nudge a weekend landing onto the next working day.
     */
    const payload = {
      id: d.el.dataset.b, ref: d.el.dataset.ref, kind: d.el.dataset.kind, days,
      newStart: addDays(d.start, days),
      newEnd: addDays(d.end, days),
    };
    if (d.mode === 'move') handlers.onMove?.(payload);
    else {
      const newLen = Math.max(1, Math.round((d.w0 + days * d.dayPx) / d.dayPx));
      handlers.onResize?.({ id: payload.id, ref: payload.ref, kind: payload.kind, days,
                            calendarDays: newLen,
                            newEnd: addDays(d.start, newLen - 1) });
    }
    /* Whatever happens next is the caller's re-render. Nothing is written
       here, so a handler that declines leaves the chart exactly as it was
       after the next paint. */
    setTimeout(() => { dragged = false; }, 0);
  };

  gx.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);

  return () => {
    gx.removeEventListener('click', click);
    gx.removeEventListener('pointerdown', down);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };
}

/**
 * The floating read-out during a drag.
 *
 * A drag with no feedback is a guess. This says what the gesture means in
 * words — "+4 days · starts Mon 12 Oct" or "14 days · needs a crew of 3" —
 * which is what turns dragging a bar into a decision rather than a fidget.
 */
function showHint(gx, d, days) {
  let el = gx.querySelector('.gx-hint');
  if (!el) {
    el = document.createElement('div');
    el.className = 'gx-hint';
    gx.appendChild(el);
  }
  if (d.mode === 'move') {
    /* Both ends, because which one matters depends on what the bar is: a
       scope is placed by its start, a task by the due date its bar ends on.
       Showing one of them would be right half the time. */
    const start = addDays(d.start, days);
    const end = addDays(d.end, days);
    el.textContent = `${days > 0 ? '+' : ''}${days}d · ${fmtDate(start)} → ${fmtDate(end, 'long')}`;
  } else {
    const len = Math.max(1, Math.round((d.w0 + days * d.dayPx) / d.dayPx));
    const end = addDays(d.start, len - 1);
    el.textContent = `${len} day${len === 1 ? '' : 's'} · ends ${fmtDate(end, 'long')}`;
  }
  const r = d.el.getBoundingClientRect();
  const g = gx.getBoundingClientRect();
  el.style.left = Math.max(4, r.left - g.left + r.width / 2) + 'px';
  el.style.top = (r.top - g.top - 26) + 'px';
}
const hideHint = gx => gx.querySelector('.gx-hint')?.remove();

/**
 * Scroll the chart so today is a third of the way in.
 *
 * Opening a year-long plan scrolled to January when it is September reads as
 * broken. A third rather than centred because the past is context and the
 * future is the job.
 */
export function scrollToToday(host, { from, to, zoom = 'week', anchor = today() } = {}) {
  const sc = host.querySelector('[data-gx-scroll]');
  if (!sc) return;
  const geo = geometry(from, to, zoomOf(zoom).dayPx);
  const want = geo.x(anchor < from ? from : anchor > to ? to : anchor);
  sc.scrollLeft = Math.max(0, want - (sc.clientWidth - LABEL_W) / 3);
}

/** The zoom control, matching the scale toggle's look. */
export function zoomToggle(current) {
  return `<div class="ts-toggle" title="Zoom">
    ${ZOOMS.map(z => `<button data-act="gx-zoom" data-z="${z.id}"
      class="${current === z.id ? 'on' : ''}" aria-pressed="${current === z.id}">${esc(z.label)}</button>`).join('')}
  </div>`;
}

export { LABEL_W, ROW_H };
