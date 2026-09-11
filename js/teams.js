/* ============================================================================
   teams.js — everything that knows we might be inside Microsoft Teams.

   The app must work identically in a plain browser tab, so nothing here is
   allowed to throw when the SDK is missing. `inTeams` stays false and the
   rest of the app carries on.
   ========================================================================= */

export const teams = {
  sdk: null,
  inTeams: false,
  ready: false,
  theme: 'default',       // default | dark | contrast
  context: null,
  user: null,             // { name, upn, id, tenantId } when Teams tells us
};

const themeHandlers = new Set();
export const onThemeChange = fn => { themeHandlers.add(fn); return () => themeHandlers.delete(fn); };
const fireTheme = t => { teams.theme = t; themeHandlers.forEach(f => { try { f(t); } catch (e) { console.error(e); } }); };

/** Resolve once we know whether we are hosted by Teams. Never rejects. */
export async function initTeams() {
  const sdk = window.microsoftTeams;
  if (window.__noTeamsSdk || !sdk?.app) {
    teams.ready = true;
    console.info('[GFX] Teams SDK unavailable — standalone mode.');
    return teams;
  }
  teams.sdk = sdk;
  try {
    // app.initialize() rejects (or hangs) outside a Teams host, hence the race.
    await Promise.race([
      sdk.app.initialize(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500)),
    ]);
    const ctx = await sdk.app.getContext();
    teams.inTeams = true;
    teams.context = ctx;
    teams.user = ctx.user ? {
      name: ctx.user.displayName || '', upn: ctx.user.userPrincipalName || '',
      id: ctx.user.id || '', tenantId: ctx.user.tenant?.id || '',
    } : null;
    fireTheme(normTheme(ctx.app?.theme));
    sdk.app.registerOnThemeChangeHandler(t => fireTheme(normTheme(t)));
    sdk.app.notifySuccess();
    console.info('[GFX] Running inside Teams', ctx.page?.frameContext);
  } catch (e) {
    console.info('[GFX] Not inside Teams —', e.message);
  }
  teams.ready = true;
  return teams;
}

const normTheme = t => (t === 'dark' ? 'dark' : t === 'contrast' ? 'contrast' : 'default');

/** Open a URL the way the host prefers (new tab in Teams, new window elsewhere). */
export function openExternal(url) {
  if (!url) return;
  if (teams.inTeams && teams.sdk?.app?.openLink) teams.sdk.app.openLink(url).catch(() => window.open(url, '_blank', 'noopener'));
  else window.open(url, '_blank', 'noopener');
}

/** Teams-native share-to-chat when available, clipboard fallback otherwise. */
export async function shareLink(url, message = '') {
  try {
    if (teams.inTeams && teams.sdk?.sharing?.shareWebContent) {
      await teams.sdk.sharing.shareWebContent({ content: [{ type: 'URL', url, message, preview: true }] });
      return 'shared';
    }
  } catch { /* fall through */ }
  await navigator.clipboard.writeText(url);
  return 'copied';
}

/**
 * Run an interactive auth popup through the Teams host when we are inside it.
 * Falls back to a plain window.open flow in a browser.
 * @returns {Promise<string>} the value auth-end.html passed to notifySuccess
 */
export function authPopup(url) {
  if (teams.inTeams && teams.sdk?.authentication?.authenticate) {
    return teams.sdk.authentication.authenticate({ url, width: 620, height: 640 });
  }
  return new Promise((resolve, reject) => {
    const w = window.open(url, 'gfxauth', 'width=620,height=640');
    if (!w) return reject(new Error('Popup blocked. Allow popups for this site and try again.'));
    const onMsg = ev => {
      if (ev.origin !== location.origin || !ev.data || ev.data.__gfxauth === undefined) return;
      window.removeEventListener('message', onMsg);
      clearInterval(poll);
      ev.data.ok ? resolve(ev.data.__gfxauth) : reject(new Error(ev.data.__gfxauth || 'Sign-in failed'));
    };
    window.addEventListener('message', onMsg);
    const poll = setInterval(() => {
      if (w.closed) { clearInterval(poll); window.removeEventListener('message', onMsg); reject(new Error('Sign-in window closed.')); }
    }, 600);
  });
}
