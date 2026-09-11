/* ============================================================================
   views/dashboard.js — the morning view.

   Widgets are chosen and ordered in Settings → Appearance. The default set is
   built around one question: what would make me change my plan for today?
   ========================================================================= */

import * as S from '../store.js';
import {
  h, raw, esc, icon, avatar, acts, bar,
  fmtDate, fmtMoney, fmtMoneyFull, fmtMonth, relDays, today, addDays,
  lineChart, sum, clamp, initials, hashColor,
} from '../ui.js';
import {
  projectFinance, taskStats, capacity, demand,
  thisMonth, leaveType, awayOn, objProgress, holidaySet,
} from '../calc.js';
import { openExternal } from '../teams.js';
import { timelineHTML, observeTimeline, RANGES, bounds as tlBounds } from '../timeline.js';
import { scaleToggle, scaleAct } from '../timescale.js';

const sym = () => S.get().settings.currencySymbol || '$';

/* ---------- widgets ------------------------------------------------------ */

const W = {};

W.kpis = () => {
  const s = S.get();
  const t = taskStats();
  const f = projectFinance(null);
  const okrs = s.objectives.filter(o => !['done', 'dropped'].includes(o.status));
  const avg = okrs.length ? Math.round(sum(okrs, objProgress) / okrs.length) : 0;
  const away = awayOn(today()).length;
  const heads = s.people.filter(p => p.active !== false && !p.isMe).length;

  return h`<div class="grid g4">
    <div class="card stat" data-act="go" data-v="tasks" style="cursor:pointer">
      <div class="k">Open tasks</div><div class="v">${t.open}</div>
      <div class="d ${t.overdue ? 'down' : ''}">${t.overdue} overdue · ${t.dueSoon} due this week</div></div>
    <div class="card stat" data-act="go" data-v="finance" style="cursor:pointer">
      <div class="k">Forecast vs budget</div>
      <div class="v" style="color:${f.landing > 0 ? 'var(--risk)' : 'var(--text)'}">${f.landing > 0 ? '+' : ''}${fmtMoney(f.landing, sym())}</div>
      <div class="d">${fmtMoney(f.forecast, sym())} landing on ${fmtMoney(f.budget, sym())}</div></div>
    <div class="card stat" data-act="go" data-v="objectives" style="cursor:pointer">
      <div class="k">Objective progress</div><div class="v">${avg}%</div>
      <div class="d">${okrs.length} live · ${okrs.filter(o => o.status !== 'on-track').length} needing attention</div></div>
    <div class="card stat" data-act="go" data-v="leave" style="cursor:pointer">
      <div class="k">Team</div><div class="v">${heads}</div>
      <div class="d ${away ? 'down' : ''}">${away} away today</div></div>
  </div>`;
};

W.today = () => {
  const s = S.get();
  const me = s.people.find(p => p.isMe);
  const td = today();
  const soon = addDays(td, 7);

  const mine = s.tasks.filter(t => t.status !== 'done' && (!me || t.assignee === me.id));
  const overdue = mine.filter(t => t.due && t.due < td);
  const dueNow = mine.filter(t => t.due && t.due >= td && t.due <= soon);
  const blocked = s.tasks.filter(t => t.status === 'blocked');
  const pick = [...overdue, ...dueNow].sort((a, b) => (a.due || '').localeCompare(b.due || '')).slice(0, 7);

  return h`
  <section class="card">
    <header><h3>Your next seven days</h3>
      <span class="sub">${overdue.length} overdue · ${dueNow.length} due</span>
      <div class="spacer" style="flex:1"></div>
      <button class="btn sm subtle" data-act="go" data-v="tasks">All tasks →</button></header>
    <div class="body flush"><table class="tbl"><tbody>
      ${raw(pick.map(t => {
        const late = t.due < td;
        const p = S.byId(s.projects, t.project);
        return `<tr data-t="${t.id}" style="cursor:pointer" data-act="task">
          <td style="width:1%"><span class="chip ${t.priority === 'critical' ? 'risk' : t.priority === 'high' ? 'warn' : ''}">${esc(t.priority)}</span></td>
          <td><b>${esc(t.title)}</b>
            <div class="tiny mute">${p ? esc(p.name) : 'No project'}${t.division ? ' · ' + esc(t.division) : ''}</div></td>
          <td class="tiny nowrap ${late ? 'overdue' : ''}">${esc(fmtDate(t.due))}<div class="mute">${esc(relDays(t.due))}</div></td>
        </tr>`;
      }).join('') || '<tr><td class="tiny mute" style="padding:20px;text-align:center">Nothing due in the next week. Enjoy it.</td></tr>')}
      ${raw(blocked.length ? `<tr><td colspan="3" style="background:color-mix(in srgb, var(--risk) 8%, transparent)">
        <div class="tiny"><b>${blocked.length} task${blocked.length === 1 ? ' is' : 's are'} blocked:</b>
        ${blocked.slice(0, 3).map(b => esc(b.title)).join(' · ')}${blocked.length > 3 ? ' …' : ''}</div></td></tr>` : '')}
    </tbody></table></div>
  </section>`;
};

W.milestones = () => {
  const s = S.get();
  const td = today();
  const range = s.prefs.tlRange || '6m';

  const items = s.projects
    .filter(p => p.status !== 'archived')
    .flatMap(p => (p.milestones || []).map(m => ({
      id: m.id, name: m.name, date: m.date, status: m.status,
      projectId: p.id, projectCode: p.code, projectName: p.name,
    })))
    .filter(m => m.date);

  // task due dates as small pips along the axis, for context
  const pips = s.tasks
    .filter(t => t.status !== 'done' && t.due)
    .map(t => ({ date: t.due, overdue: t.due < td, title: t.title }));

  const b = tlBounds(range);
  const shown = items.filter(m => m.date >= b.from && m.date <= b.to).length;

  return h`
  <section class="card">
    <header><h3>Milestones ahead</h3>
      <span class="sub">${shown} in view · ◆ on the axis</span>
      <div class="spacer" style="flex:1"></div>
      ${raw(scaleToggle('dashboard'))}
      <div class="seg">
        ${raw(RANGES.map(([k, l]) => `<button data-act="tl-range" data-v="${k}"
          class="${range === k ? 'on' : ''}" title="${esc(l)}">${k}</button>`).join(''))}
      </div>
      <button class="btn sm subtle" data-act="go" data-v="projects">Portfolio →</button></header>
    <div class="body">
      ${raw(timelineHTML(items, { range, pips, emptyMsg: 'No milestones in this window. Widen the range, or add one from Projects.' }))}
    </div>
  </section>`;
};

W.burn = () => {
  const f = projectFinance(null);
  const cum = f.cumulative;
  return h`
  <section class="card">
    <header><h3>Portfolio burn</h3><span class="sub">all projects, cumulative</span>
      <div class="spacer" style="flex:1"></div>
      <button class="btn sm subtle" data-act="go" data-v="finance">Finance →</button></header>
    <div class="body">
      ${raw(cum.length ? lineChart({
        labels: cum.map(c => fmtMonth(c.m)),
        series: [
          { name: 'Plan', values: cum.map(c => c.planned), color: 'var(--accent)', area: true },
          { name: 'Actual', values: cum.map(c => c.actual), color: 'var(--info)' },
          { name: 'Forecast', values: cum.map(c => c.forecast), color: 'var(--warn)', dash: true },
        ], height: 170, sym: sym(),
      }) : '<div class="empty tiny">No budget lines yet.</div>')}
      <div class="row tiny" style="margin-top:8px">
        <span class="mute">Spent <b class="dim">${fmtMoneyFull(f.actualToDate, sym())}</b> of ${fmtMoneyFull(f.budget, sym())}</span>
        <span class="spacer" style="flex:1"></span>
        <span style="color:${f.landing > 0 ? 'var(--risk)' : 'var(--ok)'}">
          forecast ${f.landing > 0 ? 'over' : 'under'} by ${fmtMoney(Math.abs(f.landing), sym())}</span>
      </div>
    </div>
  </section>`;
};

W.leave = () => {
  const s = S.get();
  const td = today();
  const horizon = addDays(td, 14);
  const hol = holidaySet();
  const upcoming = s.leave.filter(l => (l.to || l.from) >= td && l.from <= horizon)
    .sort((a, b) => a.from.localeCompare(b.from));
  const nowAway = upcoming.filter(l => l.from <= td);
  const holsSoon = s.holidays.filter(x => x.date >= td && x.date <= horizon);

  return h`
  <section class="card">
    <header><h3>Away in the next two weeks</h3>
      <span class="sub">${nowAway.length} out today</span>
      <div class="spacer" style="flex:1"></div>
      <button class="btn sm subtle" data-act="go" data-v="leave">Schedule →</button></header>
    <div class="body">
      ${raw(holsSoon.length ? `<div class="banner" style="padding:8px 11px;margin-bottom:10px">
        <svg class="ico"><use href="#i-cal"></use></svg>
        <div class="tiny">Public holiday: ${holsSoon.map(x => `<b>${esc(x.name)}</b> ${esc(fmtDate(x.date))}`).join(' · ')}</div></div>` : '')}
      ${raw(upcoming.length ? upcoming.slice(0, 9).map(l => {
        const p = S.byId(s.people, l.personId);
        if (!p) return '';
        const t = leaveType(l.type);
        const out = l.from <= td;
        return `<div class="row" style="margin-bottom:8px">
          <span class="avatar sm" style="background:${hashColor(p.name)}">${esc(initials(p.name))}</span>
          <div style="flex:1;min-width:0">
            <div class="tiny"><b>${esc(p.name)}</b> ${out ? '<span class="chip risk" style="height:17px">out now</span>' : ''}</div>
            <div class="tiny mute">${esc(t.label)} · ${esc(fmtDate(l.from))}${l.to && l.to !== l.from ? ' → ' + esc(fmtDate(l.to)) : ''}</div>
          </div>
          <span class="pill-div" style="background:${S.divColor(p.division)}">${esc(p.division)}</span>
        </div>`;
      }).join('') : '<div class="tiny mute">Nobody is booked off in the next fortnight.</div>')}
    </div>
  </section>`;
};

W.okr = () => {
  const s = S.get();
  const live = s.objectives.filter(o => !['done', 'dropped'].includes(o.status))
    .sort((a, b) => objProgress(a) - objProgress(b));
  return h`
  <section class="card">
    <header><h3>Objectives</h3>
      <div class="spacer" style="flex:1"></div>
      <button class="btn sm subtle" data-act="go" data-v="objectives">All →</button></header>
    <div class="body">
      ${raw(live.slice(0, 6).map(o => {
        const p = objProgress(o);
        const st = o.status === 'at-risk' ? 'warn' : o.status === 'off-track' ? 'risk' : 'ok';
        return `<div style="margin-bottom:11px;cursor:pointer" data-act="okr" data-o="${o.id}">
          <div class="row tiny" style="margin-bottom:3px">
            <span class="trunc" style="flex:1">${esc(o.title)}</span>
            <span class="chip">${esc(o.quarter)}</span>
            <b style="width:34px;text-align:right">${p}%</b>
          </div>
          <span class="bar"><i class="${st}" style="width:${p}%"></i></span>
        </div>`;
      }).join('') || '<div class="tiny mute">No live objectives.</div>')}
    </div>
  </section>`;
};

W.risks = () => {
  const s = S.get();
  const risks = s.projects.flatMap(p => (p.risks || []).filter(r => r.status !== 'closed').map(r => ({ ...r, p })));
  const score = r => ({ high: 3, medium: 2, low: 1 }[r.impact] || 1) * ({ high: 1.6, medium: 1, low: .6 }[r.likelihood] || 1);
  risks.sort((a, b) => score(b) - score(a));
  const blocked = s.tasks.filter(t => t.status === 'blocked');

  return h`
  <section class="card">
    <header><h3>Risks &amp; blockers</h3>
      <span class="sub">${risks.length} open risk${risks.length === 1 ? '' : 's'} · ${blocked.length} blocked</span></header>
    <div class="body">
      ${raw(risks.slice(0, 5).map(r => `
        <div style="border-left:3px solid ${score(r) >= 4 ? 'var(--risk)' : score(r) >= 2 ? 'var(--warn)' : 'var(--muted)'};padding-left:9px;margin-bottom:10px;cursor:pointer"
             data-act="proj" data-p="${r.p.id}">
          <div class="tiny"><b>${esc(r.text)}</b></div>
          <div class="tiny mute">${esc(r.p.code)} · ${esc(r.impact)} impact / ${esc(r.likelihood)} likelihood${r.owner ? ' · ' + esc(S.personName(r.owner)) : ''}</div>
        </div>`).join('') || '<div class="tiny mute">No open risks logged.</div>')}
      ${raw(blocked.length ? `<div class="sep"></div>${blocked.slice(0, 4).map(b => `
        <div class="row tiny" style="margin-bottom:5px" data-act="task" data-t="${b.id}">
          <svg class="ico" style="width:14px;height:14px;color:var(--risk)"><use href="#i-warn"></use></svg>
          <span class="trunc" style="flex:1;cursor:pointer">${esc(b.title)}</span>
          <span class="mute">${esc(S.personName(b.assignee))}</span></div>`).join('')}` : '')}
    </div>
  </section>`;
};

W.capacity = () => {
  const s = S.get();
  const ym = thisMonth();
  const rows = s.divisions.map(d => {
    const c = capacity(ym, { division: d.id });
    const dm = demand(ym, { division: d.id });
    return { d, c, dm, load: c.net ? (dm / c.net) * 100 : 0 };
  }).filter(r => r.c.rows.length);

  return h`
  <section class="card">
    <header><h3>Division load — ${fmtMonth(ym)}</h3>
      <span class="sub">estimated work due against days actually available</span>
      <div class="spacer" style="flex:1"></div>
      <button class="btn sm subtle" data-act="go" data-v="people">Team →</button></header>
    <div class="body">
      ${raw(rows.map(r => `
        <div style="margin-bottom:11px">
          <div class="row tiny" style="margin-bottom:3px">
            <span class="pill-div" style="background:${r.d.color}">${esc(r.d.id)}</span>
            <span style="flex:1">${esc(r.d.name)}</span>
            <span class="mute">${r.dm.toFixed(1)} / ${r.c.net.toFixed(1)} days</span>
            <b style="width:44px;text-align:right;color:${r.load > 100 ? 'var(--risk)' : r.load > 85 ? 'var(--warn)' : 'var(--text)'}">${Math.round(r.load)}%</b>
          </div>
          <span class="bar"><i class="${r.load > 100 ? 'risk' : r.load > 85 ? 'warn' : 'ok'}" style="width:${clamp(r.load, 0, 100)}%"></i></span>
          ${r.c.lost > 0.5 ? `<div class="tiny mute" style="margin-top:2px">${r.c.lost.toFixed(1)} days lost to leave this month</div>` : ''}
        </div>`).join('') || '<div class="tiny mute">No divisions with people in them yet.</div>')}
      <div class="hint">Load is task estimates due this month divided by days available after leave and
      holidays. Anything over 100% will slip unless something is cut or moved.
      ${raw(estimateCoverage(ym))}</div>
    </div>
  </section>`;
};

/**
 * A load figure is only as good as the estimates behind it. If most open work
 * carries no estimate or no due date, say so rather than letting a reassuring
 * "9%" stand unchallenged.
 */
function estimateCoverage(ym) {
  const open = S.get().tasks.filter(t => t.status !== 'done');
  const counted = open.filter(t => t.due && t.due.slice(0, 7) === ym && t.estimate > 0).length;
  const undated = open.filter(t => !t.due).length;
  const unestimated = open.filter(t => t.due && t.due.slice(0, 7) === ym && !t.estimate).length;
  if (!open.length) return '';
  const noDivision = open.filter(t => t.due && t.due.slice(0, 7) === ym && t.estimate > 0 && !t.division).length;
  const notes = [];
  notes.push(`Counting ${counted} task${counted === 1 ? '' : 's'} landing this month.`);
  if (noDivision) notes.push(`${noDivision} of those ${noDivision === 1 ? 'is' : 'are'} not assigned to a division, so ${noDivision === 1 ? 'it appears' : 'they appear'} in no row above.`);
  if (unestimated) notes.push(`${unestimated} more ${unestimated === 1 ? 'is' : 'are'} due this month with no estimate.`);
  if (undated) notes.push(`${undated} open task${undated === 1 ? ' has' : 's have'} no due date and so count nowhere.`);
  return `<br><span style="opacity:.85">${esc(notes.join(' '))}</span>`;
}

/* ---------- layout ------------------------------------------------------- */

// the timeline needs the full width to be readable — it gets its own row
const FULL = new Set(['kpis', 'milestones']);
const WIDE = new Set(['today', 'burn', 'capacity']);

/* ---------- view --------------------------------------------------------- */

export default {
  id: 'dashboard', title: 'Dashboard', icon: 'home', group: 'work',
  subtitle: '',

  actions: ctx => [
    { label: 'New task', icon: 'plus', primary: true, run: async () => {
      const m = await import('./tasks.js');
      m.editTask(null).then(r => r && ctx.rerender());
    } },
  ],

  render(host, ctx) {
    const s = S.get();
    const hour = new Date().getHours();
    const greet = hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    // don't greet the placeholder name by its first word ("Good morning, Art.")
    const rawName = s.profile.name === 'Art Producer Lead' ? '' : (s.profile.name || '');
    const firstName = rawName.split(' ')[0];
    const chosen = (s.prefs.widgets || []).filter(w => W[w]);

    const links = s.settings.workspaceLinks.filter(l => l.url);

    host.innerHTML = h`
      <div class="row wrap" style="margin-bottom:16px;align-items:flex-end">
        <div style="flex:1">
          <h2 style="font-size:21px;letter-spacing:-.3px">${greet}${firstName ? ', ' + firstName : ''}.</h2>
          <div class="tiny mute">${fmtDate(today(), 'long')} · ${s.projects.filter(p => p.status !== 'archived').length} live projects ·
            ${s.people.filter(p => p.active !== false && !p.isMe).length} people across ${s.divisions.length} divisions</div>
        </div>
        ${raw(links.length ? `<div class="row wrap" style="gap:6px">
          ${links.slice(0, 4).map(l => `<button class="btn sm subtle" data-act="link" data-u="${esc(l.url)}">
            <svg class="ico"><use href="#i-link"></use></svg>${esc(l.label)}</button>`).join('')}</div>` : '')}
      </div>

      ${raw(chosen.length ? layout(chosen) : `
        <div class="card"><div class="empty">
          <svg class="ico"><use href="#i-home"></use></svg>
          <h4>Every widget is switched off</h4>
          <div class="tiny">Turn some back on in Settings → Appearance → Dashboard widgets.</div>
        </div></div>`)}`;

    acts(host, {
      go: el => ctx.go(el.dataset.v),
      link: el => openExternal(el.dataset.u),
      'tl-range': el => {
        S.mutate(s => { s.prefs.tlRange = el.dataset.v; }, { noUndo: true, silent: true });
        ctx.rerender();
      },
      'ts-row': scaleAct(() => ctx.rerender()),
      task: async el => {
        const m = await import('./tasks.js');
        m.editTask(el.dataset.t || el.closest('[data-t]').dataset.t).then(r => r && ctx.rerender());
      },
      proj: el => ctx.go('projects', el.dataset.p || el.closest('[data-p]').dataset.p),
      okr: el => ctx.go('objectives', el.dataset.o),
    });

    // clicking a milestone opens its project
    host.addEventListener('click', e => {
      const ms = e.target.closest('.tl-ms');
      if (ms?.dataset.project) ctx.go('projects', ms.dataset.project);
    });

    // The timeline must be measured after it is in the document, and again
    // whenever its container changes width.
    return observeTimeline(host);
  },
};

function layout(chosen) {
  let out = '';
  let bucket = [];
  const flushBucket = () => {
    if (!bucket.length) return;
    out += `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr));margin-bottom:14px">${bucket.join('')}</div>`;
    bucket = [];
  };
  for (const id of chosen) {
    const html = W[id]();
    if (FULL.has(id)) { flushBucket(); out += `<div style="margin-bottom:14px">${html}</div>`; }
    else if (WIDE.has(id)) { bucket.push(`<div style="grid-column:span 1;min-width:0">${html}</div>`); }
    else bucket.push(`<div style="min-width:0">${html}</div>`);
    if (bucket.length === 2) flushBucket();
  }
  flushBucket();
  return out;
}
