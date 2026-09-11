/* ============================================================================
   views/leave.js — the live leave schedule.

   A wall chart: one row per person, one column per day, colour by leave type.
   Public holidays and weekends are shaded so a "5 day" booking that is really
   3 working days is obvious at a glance.

   Sources, in order of trust:
     1. what you book here by hand
     2. a CSV or pasted block exported from your HR system
     3. Microsoft 365 out-of-office (Settings → Microsoft 365), which shows
        who has an OOF block but cannot tell you what kind of leave it is
   ========================================================================= */

import * as S from '../store.js';
import {
  h, raw, esc, icon, toast, dialog, formDlg, confirmDlg, menu, acts,
  fmtDate, fmtMonth, today, addDays, addMonths, eachDay, isWeekend, dayIdx,
  download, toCsv, parseCsv, pickFile, groupBy, clamp, initials, hashColor,
} from '../ui.js';
import { LEAVE_TYPES, leaveType, holidaySet, isWorkingDay, leaveUsed, monthRange, thisMonth } from '../calc.js';
import { graph, getSchedule } from '../graph.js';
import { buildScale, headRows, scalePrefs, scaleToggle, scaleAct } from '../timescale.js';

const UI_KEY = 'gfxprod.ui.leave';
const ui = Object.assign({ from: '', months: 2, division: '', project: '', groupBy: 'division' },
                         JSON.parse(localStorage.getItem(UI_KEY) || '{}'));
if (!ui.from) ui.from = thisMonth() + '-01';
const saveUi = () => localStorage.setItem(UI_KEY, JSON.stringify(ui));

const lastDay = ym => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };
const windowEnd = () => lastDay(addMonths(ui.from, ui.months - 1));

/* ---------- who is shown ------------------------------------------------- */

function shown() {
  const s = S.get();
  return s.people.filter(p => {
    if (p.active === false) return false;
    if (ui.division && p.division !== ui.division) return false;
    if (ui.project && !(p.alloc || []).some(a => a.projectId === ui.project && a.pct > 0)) return false;
    return true;
  });
}

/* ---------- the grid ----------------------------------------------------- */

function grid() {
  const s = S.get();
  const from = ui.from, to = windowEnd();
  const days = eachDay(from, to);
  const hol = holidaySet();
  const holName = Object.fromEntries(s.holidays.map(x => [x.date, x.name]));
  const td = today();

  const people = shown();
  const groups = ui.groupBy === 'division'
    ? S.get().divisions.map(d => ({ key: d.id, label: `${d.id} — ${d.name}`, color: d.color, rows: people.filter(p => p.division === d.id) })).filter(g => g.rows.length)
    : [{ key: 'all', label: 'Everyone', color: 'var(--muted)', rows: people }];

  const leaveByPerson = groupBy(s.leave, l => l.personId);

  const cellFor = (p, dt) => {
    const entries = (leaveByPerson[p.id] || []).filter(l => l.from <= dt && (l.to || l.from) >= dt);
    const l = entries[0];
    const cls = ['d'];
    if (isWeekend(dt)) cls.push('we');
    if (hol.has(dt)) cls.push('hol');
    if (dt === td) cls.push('today');
    const inner = l ? `<i class="${leaveType(l.type).cls}${l.half ? ' lv-half' : ''}"></i>` : '';
    const tip = l ? `${p.name} — ${leaveType(l.type).label}${l.half ? ' (half day)' : ''}${l.note ? ' · ' + l.note : ''}`
              : hol.has(dt) ? holName[dt] : `${p.name} — ${fmtDate(dt, 'long')}`;
    return `<td class="${cls.join(' ')}" data-p="${p.id}" data-d="${dt}" data-l="${l ? l.id : ''}" title="${esc(tip)}">${inner}</td>`;
  };

  /* The month / week / date bands, from the shared scale — so the columns here
     line up with the same bands on the portfolio and dashboard timelines, and
     one toggle governs all three. */
  const scale = buildScale(from, to);

  return h`
  <div class="card"><div class="cal"><table class="cal-tbl">
    <thead>${raw(headRows(scale, scalePrefs('leave'), { lead: 'Person', leadClass: 'person' }))}</thead>
    <tbody>${raw(groups.map(g => `
      <tr class="divhead"><td class="person" style="background:var(--bg-sunken)">
        <span class="pill-div" style="background:${g.color}">${esc(g.key)}</span>
        <span class="mute" style="margin-left:6px;font-size:10px">${esc(g.label)}</span></td>
        <td colspan="${days.length}" style="background:var(--bg-sunken)"></td></tr>
      ${g.rows.map(p => `<tr>
        <td class="person"><div class="row" style="gap:6px">
          <span class="avatar xs" style="background:${hashColor(p.name)}">${esc(initials(p.name))}</span>
          <span class="trunc" style="flex:1;font-size:11.5px;cursor:pointer" data-act="person" data-id="${p.id}">${esc(p.name)}</span>
          <span class="tiny mute" title="Annual leave used / allowance">${leaveUsed(p.id)}/${p.leaveAllowance ?? 15}</span>
        </div></td>
        ${days.map(dt => cellFor(p, dt)).join('')}
      </tr>`).join('')}`).join('') || `<tr><td class="person">—</td><td colspan="${days.length}" class="tiny mute" style="padding:20px">Nobody matches those filters.</td></tr>`)}
    </tbody>
  </table></div></div>`;
}

/* ---------- coverage warnings -------------------------------------------- */

function coverage() {
  const s = S.get();
  const from = today(), to = addDays(today(), 28);
  const hol = holidaySet();
  const alerts = [];

  // 1. a division losing too much of itself. Consecutive working days with the
  //    same people missing collapse into one range — five identical lines for
  //    one week off is noise, and noise is what makes people stop reading.
  for (const d of s.divisions) {
    const team = s.people.filter(p => p.division === d.id && p.active !== false);
    if (team.length < 2) continue;
    let run = null;
    const close = () => {
      if (!run) return;
      const span = run.first === run.last ? fmtDate(run.first, 'long')
                 : `${fmtDate(run.first)}–${fmtDate(run.last, 'long')}`;
      alerts.push({ kind: 'coverage', date: run.first,
        text: `${d.name}: ${run.names.length} of ${team.length} away ${span} — ${run.names.join(', ')}` });
      run = null;
    };
    for (const dt of eachDay(from, to)) {
      if (!isWorkingDay(dt, hol)) continue;
      const away = team.filter(p => s.leave.some(l =>
        l.personId === p.id && l.from <= dt && (l.to || l.from) >= dt && leaveType(l.type).counts));
      const key = away.map(p => p.id).sort().join(',');
      if (away.length / team.length < 0.4) { close(); continue; }
      if (run && run.key === key) run.last = dt;
      else { close(); run = { key, first: dt, last: dt, names: away.map(p => p.name.split(' ')[0]) }; }
    }
    close();
  }

  // 2. leave landing within 3 days of a milestone
  for (const p of s.projects) {
    for (const m of (p.milestones || [])) {
      if (m.status === 'done' || m.date < from || m.date > to) continue;
      const lo = addDays(m.date, -3), hi = addDays(m.date, 3);
      const clash = s.leave.filter(l => l.from <= hi && (l.to || l.from) >= lo)
        .map(l => S.byId(s.people, l.personId)).filter(Boolean)
        .filter(per => (per.alloc || []).some(a => a.projectId === p.id && a.pct > 0));
      if (clash.length) {
        alerts.push({ kind: 'milestone', date: m.date,
          text: `“${m.name}” (${p.code}, ${fmtDate(m.date)}) — ${[...new Set(clash.map(c => c.name))].join(', ')} on leave within 3 days` });
      }
    }
  }

  const collapsed = [];
  const seen = new Set();
  for (const a of alerts.sort((x, y) => x.date.localeCompare(y.date))) {
    if (seen.has(a.text)) continue; seen.add(a.text); collapsed.push(a);
  }
  return collapsed.slice(0, 8);
}

/* ---------- booking ------------------------------------------------------ */

async function bookLeave(preset = {}) {
  const s = S.get();
  const res = await formDlg(preset.id ? 'Edit leave' : 'Book leave', [
    { k: 'personId', label: 'Person', type: 'select', value: preset.personId || '', span: 12, required: true,
      opts: s.people.filter(p => p.active !== false).map(p => ({ v: p.id, t: `${p.name} — ${p.role}` })) },
    { k: 'type', label: 'Type', type: 'select', value: preset.type || 'annual', span: 6,
      opts: LEAVE_TYPES.map(t => ({ v: t.id, t: t.label })) },
    { k: 'half', label: 'Half day', type: 'select', value: preset.half || '', span: 6,
      opts: [{ v: '', t: 'Full day(s)' }, { v: 'am', t: 'Morning only' }, { v: 'pm', t: 'Afternoon only' }] },
    { k: 'from', label: 'From', type: 'date', value: preset.from || today(), span: 6, required: true },
    { k: 'to', label: 'To', type: 'date', value: preset.to || preset.from || today(), span: 6, required: true },
    { k: 'note', label: 'Note', value: preset.note || '', span: 12, hint: 'Optional. Visible to you only.' },
  ], { ok: preset.id ? 'Save' : 'Book' });
  if (!res) return false;
  if (res.to < res.from) { toast('The end date is before the start date.', 'warn'); return false; }

  const hol = holidaySet();
  const wd = eachDay(res.from, res.to).filter(d => isWorkingDay(d, hol)).length;
  if (!wd) {
    const ok = await confirmDlg('That range contains no working days (weekend or public holiday). Book it anyway?',
                                { title: 'Nothing to book?', ok: 'Book anyway', danger: false });
    if (!ok) return false;
  }
  if (preset.id) S.update('leave', preset.id, { ...res, source: 'manual' });
  else S.add('leave', { ...res, source: 'manual' });
  toast(`${wd || 0} working day${wd === 1 ? '' : 's'} booked`, 'ok');
  return true;
}

/* ---------- import / export ---------------------------------------------- */

function exportCsv() {
  const s = S.get();
  const rows = s.leave.slice().sort((a, b) => a.from.localeCompare(b.from)).map(l => ({
    Person: S.personName(l.personId), Type: l.type, From: l.from, To: l.to || l.from,
    Half: l.half || '', Note: l.note || '', Source: l.source || 'manual',
  }));
  download(`gfx-leave-${today()}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
  toast(`${rows.length} leave records exported`, 'ok');
}

function exportIcs() {
  const s = S.get();
  const pad = x => String(x).padStart(2, '0');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GFX Prod App//Leave//EN', 'CALSCALE:GREGORIAN'];
  for (const l of s.leave) {
    const end = addDays(l.to || l.from, 1); // DTEND is exclusive for all-day events
    lines.push('BEGIN:VEVENT',
      `UID:${l.id}@gfxprodapp`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${l.from.replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${end.replace(/-/g, '')}`,
      `SUMMARY:${S.personName(l.personId)} — ${leaveType(l.type).label}${l.half ? ' (half day)' : ''}`,
      `DESCRIPTION:${(l.note || '').replace(/[\r\n]+/g, ' ')}`,
      'TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  download(`gfx-leave-${today()}.ics`, lines.join('\r\n'), 'text/calendar;charset=utf-8');
  toast('Calendar file exported — import it into Outlook', 'ok');
}

async function importLeave() {
  const res = await dialog({
    title: 'Import leave',
    wide: true,
    body: `<p class="tiny mute">Two ways in. Either upload a CSV with the columns
      <span class="mono">Person, Type, From, To</span> (Half and Note optional), or paste rows below —
      tab or comma separated, one booking per line.</p>
      <textarea id="lp" rows="9" class="mono" placeholder="Ana Ruiz	annual	2026-09-14	2026-09-18
Chen Wei	sick	2026-09-22	2026-09-22"></textarea>
      <div class="row" style="margin-top:10px">
        <button class="btn sm" data-file>${'<svg class="ico"><use href="#i-up"></use></svg>'} Choose a CSV file…</button>
        <span class="tiny mute" id="lfname"></span>
      </div>
      <div class="banner warn" style="margin:12px 0 0"><svg class="ico"><use href="#i-warn"></use></svg>
        <div>People are matched by name, ignoring accents and word order. Anything that does not match
        is listed back to you rather than silently dropped.</div></div>`,
    footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-ok>Import</button>`,
    onMount: ({ root, close }) => {
      root.querySelector('[data-file]').onclick = async () => {
        const f = await pickFile('.csv,.txt');
        if (!f) return;
        root.querySelector('#lfname').textContent = f.name;
        root.querySelector('#lp').value = f.text;
      };
      root.querySelector('[data-no]').onclick = () => close();
      root.querySelector('[data-ok]').onclick = () => close(root.querySelector('#lp').value);
    },
  });
  if (!res || !res.trim()) return false;

  // CSV with a header row, or bare tab/comma rows
  let rows;
  if (/^\s*person\s*[,;\t]/i.test(res)) rows = parseCsv(res.replace(/\t/g, ','));
  else rows = res.trim().split(/\r?\n/).map(line => {
    const c = line.split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(x => x.trim().replace(/^"|"$/g, ''));
    return { Person: c[0], Type: c[1], From: c[2], To: c[3], Half: c[4], Note: c[5] };
  });

  const norm = str => String(str || '').normalize('NFD').split('').filter(c => { const n = c.charCodeAt(0); return n < 0x300 || n > 0x36f; }).join('')
    .toLowerCase().split(/\s+/).filter(x => x && !/^\d+$/.test(x)).sort().join(' ');
  const people = S.get().people.map(p => ({ p, key: norm(p.name) }));
  const findPerson = n => people.find(x => x.key === norm(n))?.p
    || people.find(x => x.key.includes(norm(n)) || norm(n).includes(x.key))?.p || null;

  const good = [], bad = [];
  for (const r of rows) {
    const p = findPerson(r.Person);
    const from = fixDate(r.From), to = fixDate(r.To || r.From);
    if (!p || !from) { bad.push(r.Person + ' ' + (r.From || '')); continue; }
    const type = LEAVE_TYPES.find(t => t.id === String(r.Type || '').toLowerCase())?.id || 'annual';
    good.push({ personId: p.id, type, from, to: to || from, half: (r.Half || '').toLowerCase(), note: r.Note || '', source: 'import' });
  }
  if (!good.length) { toast('Nothing could be matched. Check the name spellings and date format.', 'err', 6000); return false; }

  const ok = await confirmDlg(
    `${good.length} booking${good.length === 1 ? '' : 's'} ready.` +
    (bad.length ? ` ${bad.length} row${bad.length === 1 ? '' : 's'} could not be matched: ${bad.slice(0, 6).join('; ')}${bad.length > 6 ? '…' : ''}` : ''),
    { title: 'Import leave', ok: 'Import ' + good.length, danger: false });
  if (!ok) return false;

  S.mutate(st => {
    for (const g of good) {
      const dup = st.leave.some(l => l.personId === g.personId && l.from === g.from && l.to === g.to);
      if (!dup) st.leave.push({ id: S.uid('lv'), created: Date.now(), ...g });
    }
  }, { label: 'import leave' });
  toast(`${good.length} bookings imported`, 'ok');
  return true;
}

/** Accept 2026-09-14, 14/09/2026 and 14-Sep-2026. */
function fixDate(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  m = /^(\d{1,2})[ -]([A-Za-z]{3,})[ -](\d{4})$/.exec(s);
  if (m) {
    const i = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[2].slice(0, 3).toLowerCase());
    if (i >= 0) return `${m[3]}-${String(i + 1).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  const d = new Date(s);
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

/* ---------- Microsoft 365 out-of-office ---------------------------------- */

async function syncGraph(ctx) {
  if (!graph.ready) { toast('Connect Microsoft 365 first — Settings → Microsoft 365.', 'warn', 5000); return; }
  const people = S.get().people.filter(p => p.email && p.active !== false);
  if (!people.length) { toast('Nobody in the roster has an email address.', 'warn'); return; }

  const t = toast('Reading out-of-office from Microsoft 365…', '', 30000);
  try {
    const from = ui.from, to = windowEnd();
    const res = await getSchedule(people.map(p => p.email), from, to, S.get().profile.timezone || 'UTC');
    const found = [];
    for (const sched of res) {
      const person = people.find(p => p.email.toLowerCase() === String(sched.scheduleId).toLowerCase());
      if (!person) continue;
      for (const item of sched.scheduleItems || []) {
        if (String(item.status).toLowerCase() !== 'oof') continue;
        found.push({
          personId: person.id, type: 'annual', source: 'graph',
          from: String(item.start.dateTime).slice(0, 10),
          to: String(item.end.dateTime).slice(0, 10),
          note: 'Out of office (from Microsoft 365) — confirm the leave type',
        });
      }
    }
    t.remove();
    if (!found.length) return toast('No out-of-office blocks found in that window.', '', 4000);

    // merge adjacent/overlapping blocks per person
    const merged = [];
    for (const g of Object.values(groupBy(found, f => f.personId))) {
      g.sort((a, b) => a.from.localeCompare(b.from));
      let cur = null;
      for (const f of g) {
        if (cur && f.from <= addDays(cur.to, 1)) cur.to = f.to > cur.to ? f.to : cur.to;
        else { cur = { ...f }; merged.push(cur); }
      }
    }

    const ok = await confirmDlg(
      `${merged.length} out-of-office block${merged.length === 1 ? '' : 's'} found. They will be added as annual leave ` +
      `marked "from Microsoft 365" — Outlook does not say what type of leave it is, so check them.`,
      { title: 'Import out-of-office', ok: 'Add ' + merged.length, danger: false });
    if (!ok) return;

    S.mutate(st => {
      st.leave = st.leave.filter(l => l.source !== 'graph');   // replace the previous pull
      merged.forEach(m => st.leave.push({ id: S.uid('lv'), created: Date.now(), ...m }));
    }, { label: 'sync leave' });
    toast(`${merged.length} blocks imported`, 'ok');
    ctx.rerender();
  } catch (e) {
    t.remove();
    toast('Microsoft 365 refused that request: ' + e.message, 'err', 9000);
  }
}

/* ---------- holidays ----------------------------------------------------- */

async function manageHolidays(ctx) {
  const res = await dialog({
    title: 'Public holidays',
    wide: true,
    body: `<p class="tiny mute">These shade the calendar and are removed from every working-day and
      capacity calculation. The list shipped with the app is a <b>template</b> — check it against your
      official HR calendar before you plan a milestone around it.</p>
      <div id="hl" style="max-height:46vh;overflow:auto"></div>
      <div class="row" style="margin-top:10px">
        <input type="date" id="hd" style="width:150px">
        <input id="hn" placeholder="Holiday name" style="flex:1">
        <button class="btn sm" id="ha">Add</button></div>`,
    footer: `<button class="btn" data-no>Close</button>`,
    onMount: ({ root, close }) => {
      const wrap = root.querySelector('#hl');
      const draw = () => {
        const list = S.get().holidays.slice().sort((a, b) => a.date.localeCompare(b.date));
        wrap.innerHTML = `<table class="tbl"><tbody>${list.map(x => `
          <tr data-h="${x.id}"><td class="tiny nowrap">${esc(fmtDate(x.date, 'long'))}</td>
            <td class="tiny">${esc(x.name)}</td>
            <td class="tiny mute">${esc(x.region || '')}</td>
            <td class="act"><button class="btn icon sm subtle" data-hd><svg class="ico"><use href="#i-x"></use></svg></button></td>
          </tr>`).join('')}</tbody></table>`;
      };
      draw();
      wrap.addEventListener('click', e => {
        const b = e.target.closest('[data-hd]'); if (!b) return;
        S.remove('holidays', b.closest('[data-h]').dataset.h); draw();
      });
      root.querySelector('#ha').onclick = () => {
        const d = root.querySelector('#hd').value, n = root.querySelector('#hn').value.trim();
        if (!d || !n) return toast('Both a date and a name, please', 'warn');
        S.add('holidays', { date: d, name: n, region: S.get().settings.holidayRegion || 'VN' });
        root.querySelector('#hn').value = ''; draw();
      };
      root.querySelector('[data-no]').onclick = () => close();
    },
  });
  ctx.rerender();
  return res;
}

/* ---------- view --------------------------------------------------------- */

export default {
  id: 'leave', title: 'Leave', icon: 'cal', group: 'people',
  subtitle: 'Who is away, when, and what it collides with',

  actions: ctx => [
    { label: 'Book leave', icon: 'plus', primary: true, run: () => bookLeave().then(r => r && ctx.rerender()) },
  ],

  render(host, ctx) {
    const s = S.get();
    const alerts = coverage();
    const from = ui.from, to = windowEnd();
    const upcoming = s.leave.filter(l => (l.to || l.from) >= today())
      .sort((a, b) => a.from.localeCompare(b.from)).slice(0, 10);
    const awayToday = s.leave.filter(l => l.from <= today() && (l.to || l.from) >= today());

    host.innerHTML = h`
      <div class="toolbar">
        <button class="btn icon sm subtle" data-act="prev" title="Earlier">←</button>
        <b style="min-width:150px;text-align:center">${fmtMonth(ui.from)} — ${fmtMonth(to.slice(0, 7))}</b>
        <button class="btn icon sm subtle" data-act="next" title="Later">→</button>
        <button class="btn sm subtle" data-act="today">Today</button>
        <div class="seg">
          ${raw([1, 2, 3].map(n => `<button data-act="span" data-v="${n}" class="${ui.months === n ? 'on' : ''}">${n}m</button>`).join(''))}
        </div>
        <select data-change="f" data-k="division" style="width:auto">
          <option value="">All divisions</option>
          ${raw(s.divisions.map(d => `<option value="${esc(d.id)}"${d.id === ui.division ? ' selected' : ''}>${esc(d.name)}</option>`).join(''))}
        </select>
        <select data-change="f" data-k="project" style="width:auto">
          <option value="">Any project</option>
          ${raw(s.projects.map(p => `<option value="${esc(p.id)}"${p.id === ui.project ? ' selected' : ''}>${esc(p.name)}</option>`).join(''))}
        </select>
        ${raw(scaleToggle('leave'))}
        <div class="spacer" style="flex:1"></div>
        <button class="btn sm subtle" data-act="hol">${icon('cal')}Holidays</button>
        <button class="btn sm subtle" data-act="sync" title="Read out-of-office from Microsoft 365">${icon('cloud')}Sync OOF</button>
        <button class="btn sm subtle" data-act="import">${icon('up')}Import</button>
        <button class="btn sm subtle" data-act="menu-x">${icon('down')}Export</button>
      </div>

      <div class="row wrap" style="gap:14px;margin:-4px 0 12px">
        <div class="legend">
          ${raw(LEAVE_TYPES.map(t => `<span><i class="${t.cls}"></i>${esc(t.label)}</span>`).join(''))}
          <span><i style="background:color-mix(in srgb, var(--info) 30%, transparent)"></i>Public holiday</span>
        </div>
        <div class="spacer" style="flex:1"></div>
        <span class="tiny mute">${awayToday.length} away today · ${shown().length} people shown</span>
      </div>

      ${raw(alerts.length ? `
        <div class="banner warn" style="align-items:flex-start">
          <svg class="ico"><use href="#i-warn"></use></svg>
          <div style="flex:1"><b>${alerts.length} coverage flag${alerts.length === 1 ? '' : 's'} in the next four weeks</b>
            <ul style="margin:5px 0 0;padding-left:18px">
              ${alerts.map(a => `<li class="tiny">${esc(a.text)}</li>`).join('')}
            </ul></div>
        </div>` : '')}

      ${raw(grid())}

      <div class="grid g2" style="margin-top:14px">
        <section class="card">
          <header><h3>Next bookings</h3></header>
          <div class="body flush"><table class="tbl"><tbody>
            ${raw(upcoming.map(l => {
              const t = leaveType(l.type);
              return `<tr data-l="${l.id}">
                <td class="tiny">${esc(S.personName(l.personId))}</td>
                <td><span class="chip"><i style="width:8px;height:8px;border-radius:2px;display:inline-block" class="${t.cls}"></i>${esc(t.label)}</span></td>
                <td class="tiny nowrap">${esc(fmtDate(l.from))}${(l.to && l.to !== l.from) ? ' → ' + esc(fmtDate(l.to)) : ''}${l.half ? ' ½' : ''}</td>
                <td class="tiny mute trunc" style="max-width:150px">${esc(l.note || '')}</td>
                <td class="act"><button class="btn icon sm subtle" data-act="lv-menu"><svg class="ico"><use href="#i-dots"></use></svg></button></td>
              </tr>`;
            }).join('') || '<tr><td class="tiny mute" style="padding:16px">Nothing booked ahead.</td></tr>')}
          </tbody></table></div>
        </section>

        <section class="card">
          <header><h3>Annual leave balances</h3><span class="sub">${new Date().getFullYear()}</span></header>
          <div class="body flush"><table class="tbl">
            <thead><tr><th>Person</th><th class="num">Used</th><th class="num">Left</th><th>Burn-down</th></tr></thead>
            <tbody>${raw(shown().map(p => {
              const used = leaveUsed(p.id), all = p.leaveAllowance ?? 15;
              const pct = all ? clamp(used / all * 100, 0, 100) : 0;
              const monthsGone = new Date().getMonth() + 1;
              const expected = all * monthsGone / 12;
              const flag = used > expected * 1.35 ? 'risk' : used < expected * 0.5 ? 'warn' : 'ok';
              return `<tr><td class="tiny">${esc(p.name)}</td>
                <td class="num tiny">${used}</td><td class="num tiny">${Math.max(0, all - used)}</td>
                <td style="min-width:120px"><span class="bar"><i class="${flag}" style="width:${pct}%"></i></span></td></tr>`;
            }).join(''))}</tbody></table>
            <div class="tiny mute" style="padding:9px 12px">Amber means barely any leave taken this far into the year —
            unused leave is a Q4 capacity problem waiting to happen.</div>
          </div>
        </section>
      </div>`;

    acts(host, {
      prev: () => { ui.from = addMonths(ui.from, -1) + '-01'; saveUi(); ctx.rerender(); },
      next: () => { ui.from = addMonths(ui.from, 1) + '-01'; saveUi(); ctx.rerender(); },
      today: () => { ui.from = thisMonth() + '-01'; saveUi(); ctx.rerender(); },
      span: el => { ui.months = +el.dataset.v; saveUi(); ctx.rerender(); },
      f: el => { ui[el.dataset.k] = el.value; saveUi(); ctx.rerender(); },
      'ts-row': scaleAct(() => ctx.rerender()),
      hol: () => manageHolidays(ctx),
      sync: () => syncGraph(ctx),
      import: () => importLeave().then(r => r && ctx.rerender()),
      'menu-x': (el, ev) => menu(ev, [
        { label: 'Export CSV', icon: 'down', run: exportCsv },
        { label: 'Export calendar (.ics)', icon: 'cal', run: exportIcs },
      ]),
      person: el => ctx.go('people', el.dataset.id),
      'lv-menu': (el, ev) => {
        const id = el.closest('[data-l]').dataset.l;
        const l = S.byId(S.get().leave, id);
        menu(ev, [
          { label: 'Edit…', icon: 'edit', run: () => bookLeave({ ...l }).then(r => r && ctx.rerender()) },
          { label: 'Delete', icon: 'trash', danger: true, run: () => { S.remove('leave', id); ctx.rerender(); } },
        ]);
      },
    });

    // clicking a day cell books or clears
    host.querySelector('.cal-tbl')?.addEventListener('click', async e => {
      const td = e.target.closest('td.d'); if (!td) return;
      const { p: personId, d: date, l: lid } = td.dataset;
      if (lid) {
        const l = S.byId(S.get().leave, lid);
        menu(e, [
          { label: `${leaveType(l.type).label}: ${fmtDate(l.from)} → ${fmtDate(l.to || l.from)}`, run: () => {} },
          '-',
          { label: 'Edit…', icon: 'edit', run: () => bookLeave({ ...l }).then(r => r && ctx.rerender()) },
          { label: 'Delete this booking', icon: 'trash', danger: true, run: () => { S.remove('leave', lid); ctx.rerender(); } },
        ]);
      } else {
        if (await bookLeave({ personId, from: date, to: date })) ctx.rerender();
      }
    });
  },
};
