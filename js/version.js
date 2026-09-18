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

export const BUILD = '2026-09-18.1';

export const BUILD_NOTES = 'A new Plan screen, under Project Management: every project, scope and estimated task on one interactive Gantt, with the team’s real available days drawn week by week underneath it. Drag a bar to move it; drag its right edge to say how long the work may take and the app answers with the crew that would need. Add a request somebody has just asked you for and it lands on the chart in amber — the capacity strip turns red wherever it does not fit, a table names the weeks and how many person-days short they are, and “Crew options” puts the same work at one, two, three and four people side by side so you can see that effort and cost barely move while the date and the strain on the team move a great deal. Nothing a scenario does is saved until you commit it. The portfolio’s two old pictures of the same calendar — the milestone timeline and the project-spans strip — are now that one chart, with milestones as diamonds on their own project’s row, and the work breakdown gained the same chart and the same crew comparison. Separately: the tools scripts no longer carry anybody’s OneDrive URL, Jira project key or disk layout as parameter defaults — those live in tools.config.json outside the repository — and tools\\check-no-personal-data.ps1 scans for them before you publish.';



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

/**
 * Reload past the HTTP cache. `location.reload(true)` has been a no-op for
 * years, so clear the Cache Storage API entries this origin may hold and then
 * navigate with a cache-busting query — which is what actually works.
 */
export async function hardReload() {
  try {
    if (window.caches?.keys) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch { /* not fatal — the query string below still forces a fetch */ }
  const u = new URL(location.href);
  u.searchParams.set('r', Date.now().toString(36));
  location.replace(u.href);
}
