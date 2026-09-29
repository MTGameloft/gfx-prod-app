/* ============================================================================
   version.js — the build marker.

   GitHub Pages serves the app's files with `cache-control: max-age=600`, so a
   tab can be running code up to ten minutes old and an ordinary refresh will
   still hand back the cached copy. Inside Teams there is no address bar and no
   obvious way to tell.

   So the build is stamped here, shown in Settings -> About, and checked
   against the server on demand with a cache-busting fetch. That turns "is my
   Teams app up to date?" from something you have to take on trust into a
   button.

   BUMP THIS whenever you deploy something you need to be able to confirm
   arrived.
   ========================================================================= */

export const BUILD = '2026-09-29.2';

export const BUILD_NOTES = 'Allocation is on paper; capacity is the person. Putting somebody down as 10% on a project used to give them a tenth of a working week of capacity on that project’s chart, so the first real piece of work named on them read as a few hundred per cent over — which is what you saw. That was wrong: a person on two projects does not own two fifths of a pair of hands on Tuesday, they own one pair of hands, and the percentage you typed is a statement of intent about how they mean to divide it. So the allocation percentage now drives no capacity arithmetic anywhere. A person’s lane on the timeline is their own working week — 8 hours a day, five days, less their leave and less part-time — whatever any project says they are. What the allocation still decides is WHO is on a project’s chart, never how much of them: everybody on it is counted at their whole week. And because the number you type is now only intent, the Team page has a second column beside it, REAL ALLOCATION: what the work actually named on somebody comes to this month, per project, as a share of their own working days. On paper 40% on Let’s Story and in practice 85% of their month going into it is exactly the conversation the two columns together are for. It counts both kinds of assignment — a name on a work-breakdown line, and a task assigned to them with an estimate and a due date — and an assigned task now books its person’s time on the timeline too, so a capacity lane shows somebody’s board as well as their estimates. Previously: you can put names on a work item, and the schedule books those people. Every line of a work breakdown has a Who column: click it, tick whoever is on that line, and three things follow. The line gets its own bar on the Schedule under its division, running for as long as those people need — so the chart stops being one block per discipline and becomes the actual pieces of work. The division crew stops being a number you type and becomes the count of the people you named, because once there are names the headcount is a fact rather than a knob. And the capacity strip grows a lane per person underneath their division, which is the point of the whole thing: a division can be sitting at 40% free while the one artist named on two deliverables at once is 30% over, and a per-division row can never show you that. The scheduling rule is one sentence — a person does one thing at a time, so two lines with different people on them run at once and two lines sharing a person queue up. Name nobody and nothing changes: every line falls back to the anonymous crew exactly as before, and the duration comes out at the same hours ÷ crew it always did. People carries through to Excel on WB_Lines as a comma-separated list, and Create tasks now fills in the assignee when a line has exactly one name on it. Previously: the capacity strip now prints what is LEFT, and a project is weighed against its own people. Two changes to the same row of numbers. The cell used to show the load — 20% meant a fifth of the team was busy — which meant subtracting from 100 in your head every time, while the question a chart gets asked is what more it can take. It now reads capacity remaining: 100% is a week nothing is booked into, 0% is exactly full, and a week with more work in it than people goes negative and red. One person on 40h with 40h of scope reads 0%; two people on 80h with the same scope read 50%. And on ONE project’s chart the denominator is now the capacity ALLOCATED to that project rather than the whole division: a project with two and a half of the ten 2D artists was having its scope weighed against all ten, so it looked like a fifth of the load it actually is on the people doing it. The row now says "2.5p" and the tooltip says allocated to this project. The portfolio and the Plan are unchanged there — across every project the right question really is whether the whole team can take it. Separately: the Work column is draggable. Pinning it to one width is what made the three lanes of the chart line up again, and the cost was that a long scope name is clipped; drag the divider beside the names to make it as wide as you like, double-click to put it back, and it is remembered per chart like the height is. Previously: three bugs, and the third one was quietly poisoning every capacity number in the app. ONE: the Gantt was drawing the work weeks into the future. The chart is three separate rows — the month and week bands, the bars, the capacity strip — and each begins with a label cell that has to be exactly the same width, because the dates are drawn at absolute pixels inside the lane beside it. The rows’ label cell was allowed to grow past that width by a row whose meta ("775h · 2× · 49d · $12k") cannot wrap, so the bars and the today line were shifted bodily to the right of the month they belonged to — about 120px, two and a half weeks at the Weeks zoom, and worse the longer a scope name got. The three cells are now pinned to the same width from all three sides. TWO: Create tasks no longer puts the deliverable name in front of every task. Twelve tasks all beginning "LS LATAM Physical Book - 3x Story Creation —" is twelve rows whose difference is off the end of the column; the deliverable is still the project on the task and the first line of its description. THREE: the whole team was at 0% capacity, so there were no available days to divide by. A blank CapacityPct cell imported as the number zero, and an Excel sync with that column empty wrote 0 onto everybody — after which the capacity strip could only ever print ∞ (there is no such thing as over 100% of nothing), no overload could be shown, and the scope calculator had no supply to weigh a scope against. Fixed in three places so it cannot come back: a blank cell now means the standard full week, every reader goes through one function that treats a missing or zero capacity as a whole person, and the rosters already zeroed are put back to 100 once. A person who is not on the team is still said with Active, not with 0%. While in there: anyone the capacity maths cannot place — no division, or a division that no longer exists — is now named under the chart instead of being dropped from the arithmetic in silence. Previously: the work breakdown’s row menu has an Edit option. Complexity, approach, quantity and rung were always editable in the row itself, but the three things that identify a line — its name, its division and its base ETA — were not: a line copies those from the catalogue item when it is added, and a wrong one could only be deleted and re-added. Edit opens all seven in one dialog, with the note. It changes that line only; the catalogue item it came from keeps its own name and hours, which is what Catalogue → Edit is for. Previously: three things you asked for. The work breakdown reorders by dragging a row — the order is not cosmetic, it is the story of how the deliverable gets made, and on a sequential estimate it moves the finish date. The Estimates table has a Crew column, shown per division rather than as one total, because "5" could be five people on 2D or one each across five disciplines and those are completely different schedules; it is in the CSV too. And the chart can now be taller than its contents: dragging the bottom handle used to hit a ceiling at the last row, so on a short plan it could only ever shrink. It now grows into empty ruled rows, which is where you look to see whether there is room. There is also an "Add work" row at the foot of the left-hand column — a task, an estimate or a what-if request, with the project filled in when the chart is showing just one. Previously: the Gantt became resizable: drag the bar along the bottom of the chart to make it taller, double-click it to go back, arrow keys work too, and the height is remembered per chart. It was a fixed 62% of the window, which showed 14 of 27 rows — half the plan behind a scrollbar, inside a panel that is itself inside a scrolling page. Collapsing works now as well. The arrow was 15px in a 30px row, and missing it landed on the row label, which opened the project — so a near-miss did not do nothing, it navigated away. The arrow is 24px and the full height of the row, and clicking a row name folds it instead of opening; the record is still one click away on the bar. Two charts had the fold wired to nothing at all: the portfolio tracked the state and never rendered it, and the work breakdown had no handler. Also fixed: milestone diamonds were painting on top of the capacity strip and the frozen left column, because sticky things were outranked by the rows scrolling beneath them. Previously: "Reload now" actually reloads. It never did: it cleared the Cache Storage API (which this app does not use) and put a cache-buster on the PAGE url, which re-fetches the document and nothing else — so every module, version.js included, still came back from the browser cache for a full ten minutes. Measured on the live site: 44 of 45 files served from cache after pressing it. The build in memory stayed old, the check kept seeing the new one on the server, and the banner returned a few seconds later, for ever. It now re-fetches every script and stylesheet the page loaded with cache:"reload", which replaces each stale entry, and only then navigates — and when the address has not changed it calls reload() rather than replace(), which on an identical URL does nothing at all. If a reload still fails to move the build, the banner says so and offers Ctrl+Shift+R or reopening the Teams tab instead of the button that just failed, and "Later" now keeps that build quiet for the session instead of reappearing on the next navigation. Previously: a new Plan screen, under Project Management: every project, scope and estimated task on one interactive Gantt, with the team’s real available days drawn week by week underneath it. Drag a bar to move it; drag its right edge to say how long the work may take and the app answers with the crew that would need. Add a request somebody has just asked you for and it lands on the chart in amber — the capacity strip turns red wherever it does not fit, a table names the weeks and how many person-days short they are, and “Crew options” puts the same work at one, two, three and four people side by side so you can see that effort and cost barely move while the date and the strain on the team move a great deal. Nothing a scenario does is saved until you commit it. The portfolio’s two old pictures of the same calendar — the milestone timeline and the project-spans strip — are now that one chart, with milestones as diamonds on their own project’s row, and the work breakdown gained the same chart and the same crew comparison. Separately: the tools scripts no longer carry anybody’s OneDrive URL, Jira project key or disk layout as parameter defaults — those live in tools.config.json outside the repository — and tools\\check-no-personal-data.ps1 scans for them before you publish.';



/**
 * Ask the server what build it is serving, bypassing the HTTP cache.
 * @returns {Promise<{current:string, latest:string, upToDate:boolean}>}
 */
export async function checkForUpdate() {
  const url = new URL('version.js', import.meta.url);
  url.searchParams.set('bust', Date.now().toString(36));
  const res = await fetch(url.href, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not reach the server (${res.status}).`);
  const text = await res.text();
  const m = /BUILD\s*=\s*'([^']+)'/.exec(text);
  if (!m) throw new Error('The server response did not contain a build marker.');
  return { current: BUILD, latest: m[1], upToDate: m[1] === BUILD };
}

/* Set just before a reload, read just after, so the app can tell whether the
   reload it performed actually achieved anything. See `reloadOutcome()`. */
const ATTEMPT_KEY = 'gfxprod.reloadAttempt';

/**
 * Reload past the HTTP cache — properly this time.
 *
 * WHAT WAS WRONG, AND WHY IT LOOPED
 *
 * The previous version cleared the Cache Storage API and then navigated with
 * `?r=<now>` on the PAGE url. Both halves miss:
 *
 *   - This app has no Service Worker, so Cache Storage is empty. The stale
 *     copies live in the ordinary HTTP cache, which `caches.delete()` does
 *     not touch.
 *   - Changing the page's query string makes the browser re-fetch the
 *     DOCUMENT. It does nothing for `js/app.js`, `js/version.js` or any other
 *     module, because their URLs are unchanged and GitHub Pages sends
 *     `max-age=600` on all of them.
 *
 * Measured on the live site: after that reload, 44 of 45 resources came back
 * from the HTTP cache — including version.js. So `BUILD` in memory stayed
 * old, `checkForUpdate()` (which fetches with a bust parameter, a different
 * URL, so a real request) kept seeing the new one, and the banner reappeared
 * seconds later. Every time, for up to ten minutes. "Reload now" genuinely
 * did nothing, which is exactly what it looked like.
 *
 * THE FIX
 *
 * `fetch(url, { cache: 'reload' })` bypasses the cache on the way out AND
 * writes the fresh response into it on the way back. So: re-fetch every
 * same-origin script, stylesheet and the document itself that way, which
 * evicts and replaces each stale entry, and only then navigate. The reload
 * now reads the copies we just refreshed.
 *
 * The URL list comes from `performance.getEntriesByType('resource')` — what
 * the page actually loaded — so it needs no manifest and cannot drift out of
 * step with the imports.
 */
export async function hardReload() {
  const origin = location.origin;
  const urls = new Set();

  // The document itself, without any leftover cache-buster.
  const doc = new URL(location.href);
  doc.searchParams.delete('r');
  doc.hash = '';
  urls.add(doc.href);

  try {
    for (const e of performance.getEntriesByType('resource')) {
      if (!e.name.startsWith(origin)) continue;             // leave the Teams SDK alone
      if (!/\.(js|mjs|css)(\?|$)/.test(e.name)) continue;
      urls.add(e.name.split('?')[0]);
    }
  } catch { /* no Performance API: the document refresh below still helps */ }

  /*
   * Belt and braces. `performance` entries can be evicted from the buffer on
   * a long-lived tab, and a module imported dynamically after the buffer
   * filled would then be missed. version.js is the one file whose staleness
   * causes the loop, so it is added unconditionally.
   */
  urls.add(new URL('version.js', import.meta.url).href.split('?')[0]);

  /*
   * A hung network must not leave the button doing nothing for ever — the
   * complaint this whole change exists to fix. Refresh what we can within
   * eight seconds, then reload regardless: a reload that picks up some of
   * the new files still beats one that never happens.
   */
  const refresh = Promise.all([...urls].map(u =>
    fetch(u, { cache: 'reload', credentials: 'same-origin' }).catch(() => null)));
  await Promise.race([refresh, new Promise(r => setTimeout(r, 8000))]);

  // Cache Storage too, harmlessly, in case a Service Worker is ever added.
  try {
    if (window.caches?.keys) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch { /* not fatal */ }

  try { sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify({ from: BUILD, at: Date.now() })); } catch {}

  /*
   * AND NOW ACTUALLY NAVIGATE — which is harder than it looks.
   *
   * `location.replace(url)` where `url` is identical to the current one,
   * hash included, does NOTHING in Chromium: the hash has not changed, so it
   * is a same-document navigation and the page is never re-fetched. Caught by
   * testing the fix rather than by reading it — the first run worked only
   * because the URL still carried a `?r=` from the previous scheme, so the
   * target genuinely differed. The second run, from a clean URL, silently did
   * not reload at all: the same class of do-nothing failure this whole change
   * exists to remove, reintroduced two lines from the end.
   *
   * So: replace() only when the address really changes (which also strips a
   * leftover `?r=`), and a plain reload() otherwise. Either way the modules
   * now come from the entries refreshed above.
   */
  const target = doc.href + location.hash;
  if (target !== location.href) location.replace(target);
  else location.reload();
}

/**
 * Did the last hard reload work?
 *
 * Returns `null` when no reload was attempted, `'fixed'` when the build
 * changed, and `'failed'` when we reloaded and are still on the same build.
 *
 * This exists because the failure mode being fixed was *silent*: the button
 * appeared to work, nothing changed, and the banner came back looking like a
 * fresh notification rather than the same one. If the reload cannot win, the
 * app should say so and hand over a route that does, not offer the same
 * button again.
 */
export function reloadOutcome() {
  let rec = null;
  try {
    const raw = sessionStorage.getItem(ATTEMPT_KEY);
    if (!raw) return null;
    rec = JSON.parse(raw);
    sessionStorage.removeItem(ATTEMPT_KEY);
  } catch { return null; }
  if (!rec || typeof rec.from !== 'string') return null;
  // Older than a couple of minutes: not this page load's doing.
  if (Date.now() - (rec.at || 0) > 120000) return null;
  return rec.from === BUILD ? 'failed' : 'fixed';
}
