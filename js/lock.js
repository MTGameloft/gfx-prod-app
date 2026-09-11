/* ============================================================================
   lock.js — optional password protection, done honestly.

   WHAT THIS IS
   ------------
   Your data is encrypted at rest with a key derived from your password. The
   contents of localStorage become ciphertext: AES-256-GCM, key from
   PBKDF2-HMAC-SHA256 over a random per-install salt. Somebody sitting at your
   unlocked machine, or reading your browser profile in devtools, cannot get
   your roster, costs or budgets out of it without the password.

   WHAT THIS IS NOT
   ----------------
   It is not access control on the URL. This is a static page on a public host;
   anyone can read the code. It does not need to be secret, because the code is
   not what is being protected — the ciphertext is. Nor does it protect you
   from a compromised machine: something logging your keystrokes gets the
   password like anything else would.

   THE PRICE
   ---------
   There is no recovery. No reset link, no back door, no master key — those
   would all defeat the point. Forget the password and the data is gone. The
   app forces a plaintext backup before it will let you switch this on.
   ========================================================================= */

const ITER = 310_000;          // OWASP's floor for PBKDF2-HMAC-SHA256
const ENVELOPE_V = 1;

let key = null;                // the live CryptoKey, memory only, never stored
let salt = null;               // Uint8Array, stored with the envelope

/* ---------- availability ------------------------------------------------- */

/** WebCrypto needs a secure context: https, or localhost/127.0.0.1. */
export const cryptoAvailable = () =>
  !!(globalThis.crypto?.subtle && globalThis.isSecureContext);

export const unavailableReason = () =>
  !globalThis.crypto?.subtle ? 'This browser does not expose the Web Crypto API.'
  : !globalThis.isSecureContext ? 'The page must be served over HTTPS (or from localhost) for encryption to be available.'
  : '';

/* ---------- base64 <-> bytes --------------------------------------------- */

const b64 = buf => {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));

/* ---------- envelope ----------------------------------------------------- */

/** Does this stored blob look like something we encrypted? */
export function isEnvelope(text) {
  if (!text || typeof text !== 'string') return false;
  if (!text.includes('"__enc"')) return false;
  try { const o = JSON.parse(text); return o && o.__enc === 1 && !!o.ct && !!o.salt && !!o.iv; }
  catch { return false; }
}

/* ---------- key derivation ----------------------------------------------- */

async function derive(password, saltBytes, iterations = ITER) {
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']);
}

/* ---------- public API --------------------------------------------------- */

export const hasKey = () => !!key;

/** Forget the in-memory key. The caller should reload the page after this. */
export function clearKey() { key = null; salt = null; }

/**
 * Try to open an envelope with a password.
 * Resolves to the plaintext and keeps the key for subsequent writes.
 * Rejects with a friendly Error if the password is wrong.
 */
export async function unlock(password, envelopeText) {
  if (!cryptoAvailable()) throw new Error(unavailableReason());
  let env;
  try { env = JSON.parse(envelopeText); } catch { throw new Error('The stored data is unreadable.'); }
  const s = unb64(env.salt);
  const k = await derive(password, s, env.iter || ITER);
  let plain;
  try {
    const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, k, unb64(env.ct));
    plain = new TextDecoder().decode(buf);
  } catch {
    // GCM's authentication tag failing is indistinguishable from a wrong
    // password, which is exactly the behaviour we want.
    throw new Error('That password did not work.');
  }
  key = k; salt = s;
  return plain;
}

/** Begin encrypting: derive a fresh key from a new password. */
export async function enable(password) {
  if (!cryptoAvailable()) throw new Error(unavailableReason());
  const s = crypto.getRandomValues(new Uint8Array(16));
  key = await derive(password, s);
  salt = s;
}

/** Stop encrypting. The caller must then write the state back as plaintext. */
export function disable() { clearKey(); }

/** Wrap plaintext in an envelope with the live key. */
export async function seal(plaintext) {
  if (!key) throw new Error('Locked: no key in memory.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return JSON.stringify({
    __enc: 1, v: ENVELOPE_V, iter: ITER,
    salt: b64(salt), iv: b64(iv), ct: b64(ct),
  });
}

/**
 * Decrypt an envelope with a one-off password WITHOUT touching the live key.
 *
 * This is what restoring a cloud backup needs: the file may have been sealed
 * on another machine under a different password, and adopting that key as the
 * live one would silently re-key local storage.
 */
export async function openWith(password, envelopeText) {
  if (!cryptoAvailable()) throw new Error(unavailableReason());
  let env;
  try { env = JSON.parse(envelopeText); } catch { throw new Error('That backup is not readable.'); }
  const k = await derive(password, unb64(env.salt), env.iter || ITER);
  try {
    const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, k, unb64(env.ct));
    return new TextDecoder().decode(buf);
  } catch {
    throw new Error('That password does not open this backup.');
  }
}

/**
 * Verify a password against the current envelope without changing the live
 * key — used by "change password" so a typo cannot lock you out.
 */
export async function verify(password, envelopeText) {
  try { const env = JSON.parse(envelopeText);
        const k = await derive(password, unb64(env.salt), env.iter || ITER);
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, k, unb64(env.ct));
        return true; }
  catch { return false; }
}

/* ---------- password quality -------------------------------------------- */

/**
 * A deliberately blunt strength check. Length is what matters against an
 * offline attack on a PBKDF2 hash; character classes are a distant second.
 */
/**
 * Guessable words taken from this install's own content.
 *
 * Read straight out of `localStorage` rather than through `store.js`: this
 * module is imported BY the store to unseal it, so importing it back would be
 * a cycle. A locked store is ciphertext and yields nothing here, which is
 * fine — the generic list still applies.
 */
function extraWeakWords() {
  const raw = localStorage.getItem('gfxprod.state.v1');
  if (!raw || !raw.startsWith('{')) return [];
  const s = JSON.parse(raw);
  const out = new Set();
  for (const p of s.projects || []) {
    for (const v of [p.name, p.code]) {
      const t = String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (t) out.add(t);
    }
  }
  const org = String(s.profile?.org || s.settings?.org || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (org) out.add(org);
  return [...out];
}

export function strength(pw) {
  const s = String(pw || '');
  if (!s) return { score: 0, label: '', hint: '' };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(s)).length;
  /*
   * The words an attacker guesses first: the universal ones, plus whatever is
   * written all over THIS install — the employer, the project names and codes.
   *
   * Those used to be hard-coded, which both published who the app was built
   * for and only ever protected that one team. Reading them from state is
   * stronger as well as quieter: someone whose project is called Skylark is
   * now stopped from using "skylark" as their password.
   */
  const weak = ['password', '123456', '12345678', 'qwerty', 'letmein', 'admin', 'welcome', 'gfx', 'artprod'];
  try {
    const st = extraWeakWords();
    for (const w of st) if (w.length >= 3) weak.push(w);
  } catch { /* no state yet is not a reason to refuse a password */ }

  const lower = s.toLowerCase();
  if (weak.some(w => lower.includes(w)))
    return { score: 1, label: 'Too guessable', hint: 'It contains a word an attacker would try first.' };
  if (s.length < 8)  return { score: 1, label: 'Too short', hint: 'Twelve characters or more, please.' };
  if (s.length < 12) return { score: 2, label: 'Weak', hint: 'Length beats cleverness. Aim for twelve or more.' };
  if (s.length < 16 && classes < 3)
    return { score: 3, label: 'Fair', hint: 'Longer, or mix in another kind of character.' };
  if (s.length >= 20) return { score: 5, label: 'Strong', hint: 'Good. A passphrase of a few words is ideal.' };
  return { score: 4, label: 'Good', hint: '' };
}

/* ---------- brute-force friction ---------------------------------------- */

const FAIL_KEY = 'gfxprod.lockfail';

export function failureState() {
  try {
    const o = JSON.parse(localStorage.getItem(FAIL_KEY) || '{}');
    return { count: o.count || 0, until: o.until || 0 };
  } catch { return { count: 0, until: 0 }; }
}

/** Escalating delay. Client-side and therefore soft, but it stops a human. */
export function recordFailure() {
  const { count } = failureState();
  const n = count + 1;
  const waitMs = n < 3 ? 0 : Math.min(60_000, 2 ** (n - 3) * 2000);
  try { localStorage.setItem(FAIL_KEY, JSON.stringify({ count: n, until: Date.now() + waitMs })); } catch {}
  return { count: n, waitMs };
}

export function clearFailures() { try { localStorage.removeItem(FAIL_KEY); } catch {} }

export const lockedOutFor = () => Math.max(0, failureState().until - Date.now());
