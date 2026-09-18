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

export const BUILD = '2026-09-18.2';

export const BUILD_NOTES = '"Reload now" now actually reloads. It never did: it cleared the Cache Storage API (which this app does not use) and put a cache-buster on the PAGE url, which re-fetches the document and nothing else — so every module, version.js included, still came back from the browser cache for a full ten minutes. Measured on the live site: 44 of 45 files served from cache after pressing it. The build in memory stayed old, the check kept seeing the new one on the server, and the banner returned a few seconds later, for ever. It now re-fetches every script and stylesheet the page loaded with cache:"reload", which replaces each stale entry, and only then navigates — and when the address has not changed it calls reload() rather than replace(), which on an identical URL does nothing at all. If a reload still fails to move the build, the banner says so and offers Ctrl+Shift+R or reopening the Teams tab instead of the button that just failed, and "Later" now keeps that build quiet for the session instead of reappearing on the next navigation. Previously: a new Plan screen, under Project Management: every project, scope and estimated task on one interactive Gantt, with the team’s real available days drawn week by week underneath it. Drag a bar to move it; drag its right edge to say how long the work may take and the app answers with the crew that would need. Add a request somebody has just asked you for and it lands on the chart in amber — the capacity strip turns red wherever it does not fit, a table names the weeks and how many person-days short they are, and “Crew options” puts the same work at one, two, three and four people side by side so you can see that effort and cost barely move while the date and the strain on the team move a great deal. Nothing a scenario does is saved until you commit it. The portfolio’s two old pictures of the same calendar — the milestone timeline and the project-spans strip — are now that one chart, with milestones as diamonds on their own project’s row, and the work breakdown gained the same chart and the same crew comparison. Separately: the tools scripts no longer carry anybody’s OneDrive URL, Jira project key or disk layout as parameter defaults — those live in tools.config.json outside the repository — and tools\\check-no-personal-data.ps1 scans for them before you publish.';



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
