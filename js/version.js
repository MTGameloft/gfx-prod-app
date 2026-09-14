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

export const BUILD = '2026-09-14.2';

export const BUILD_NOTES = 'The Master Filter now lists everything you can choose from, rather than only what you had already chosen. Unticking a component used to remove it from the list it came from, so it vanished with no way to tick it back; the list is now a catalogue that only ever grows. Labels come from a scan of every issue in the project instead of only the ones already imported — 43 rather than 22 here — which is what makes it possible to widen the filter to a label you do not yet have, not only narrow it.';



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
