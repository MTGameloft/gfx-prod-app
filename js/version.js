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

export const BUILD = '2026-09-11.4';

export const BUILD_NOTES = 'Objectives get a timeline and dates. An objective can carry a start and a due date, a key result can carry its own due date, and an objective now has dated milestones of its own — all three land on one axis above the cards, with today marked and the 3m/6m/12m and month/week/date controls every other timeline has. A click on any mark scrolls to the objective it belongs to. New task on an objective creates one already linked to it, with the project, division and due date carried over. The card itself was rebuilt for reading: the long why is behind a disclosure instead of a wall of muted text, and key results, milestones and linked tasks are three labelled blocks.';

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
