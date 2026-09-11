/**
 * Rich text — the editor, the sanitiser, and the two readers.
 *
 * WHY contenteditable AND execCommand
 *
 * A textarea cannot do bold or bullets, and writing a selection model from
 * scratch is a project of its own. `document.execCommand` is deprecated and
 * still the only thing that gives Word-like editing in a few hundred lines:
 * every browser implements it, nothing replaces it, and the alternative is
 * either a 200 KB dependency or a caret bug hunt with no end. So it is used
 * deliberately, kept to six commands, and everything it produces is passed
 * through the sanitiser below before it is stored.
 *
 * WHY OLD PLAIN TEXT STILL WORKS
 *
 * Every note in the app was plain text before this existed. Rather than
 * migrate the data — which means rewriting records, which means a chance to
 * lose some — `renderRich()` looks at the value: markup is sanitised, and
 * anything else is escaped with its line breaks preserved, exactly as before.
 * Nothing needs converting, and a field that has never been edited reads the
 * same as it always did.
 */

/*
 * Deliberately nothing imported from ui.js. ui.js imports THIS module so that
 * formDlg can build editors, and a cycle between the two is a hazard nobody
 * needs for the sake of one four-line helper.
 */
const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ---------- what is allowed to be stored -------------------------------- */

/*
 * A whitelist, not a blacklist. This is the user's own writing, so the risk is
 * low — but a note can be pasted in from anywhere, backups are shared, and a
 * blacklist is a promise you cannot keep. Anything not named here is unwrapped
 * (its text survives) or dropped.
 */
const ALLOWED = {
  B: [], STRONG: [], I: [], EM: [], U: [], S: [], STRIKE: [],
  UL: [], OL: [], LI: [],
  P: [], BR: [], DIV: [], SPAN: [],
  H3: [], H4: [], BLOCKQUOTE: [], CODE: [], PRE: [],
  A: ['href', 'title'],
};
/** Tags whose content is thrown away entirely, not unwrapped. */
const NUKE = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'FORM', 'INPUT', 'BUTTON', 'SVG']);

const SAFE_HREF = /^(https?:|mailto:|tel:|#|\/)/i;

/**
 * Clean a fragment of HTML down to the whitelist.
 * @param {string} html
 * @returns {string} safe HTML
 */
export function sanitise(html) {
  const doc = new DOMParser().parseFromString(
    '<div id="rt-root">' + String(html ?? '') + '</div>', 'text/html');
  const root = doc.getElementById('rt-root');
  if (!root) return '';

  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) continue;                 // text: always fine
      if (child.nodeType !== 1) { child.remove(); continue; }  // comments etc.

      const tag = child.tagName;
      if (NUKE.has(tag)) { child.remove(); continue; }

      if (!(tag in ALLOWED)) {
        // Keep the words, lose the element.
        while (child.firstChild) node.insertBefore(child.firstChild, child);
        child.remove();
        continue;
      }

      for (const attr of [...child.attributes]) {
        const keep = ALLOWED[tag].includes(attr.name.toLowerCase());
        if (!keep) { child.removeAttribute(attr.name); continue; }
        if (attr.name.toLowerCase() === 'href' && !SAFE_HREF.test(attr.value.trim())) {
          child.removeAttribute('href');
        }
      }
      // A link out of the app should not be able to reach back into it.
      if (tag === 'A' && child.getAttribute('href')) {
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noopener noreferrer');
      }
      walk(child);
    }
  };
  walk(root);
  return root.innerHTML;
}

/** Does this value carry formatting, or is it the plain text it always was? */
const looksLikeHtml = v => /<(b|strong|i|em|u|s|ul|ol|li|br|p|div|span|h3|h4|blockquote|code|pre|a)\b[^>]*>/i.test(String(v ?? ''));

/**
 * A value as safe display HTML.
 *
 * Use this everywhere a note is shown. Plain text keeps its line breaks, so
 * every record written before the editor existed still reads correctly.
 */
export function renderRich(v) {
  const s = String(v ?? '');
  if (!s.trim()) return '';
  return looksLikeHtml(s) ? sanitise(s) : esc(s).replace(/\r?\n/g, '<br>');
}

/**
 * A value as plain text.
 *
 * For CSV, for the Excel sheets, and for search — none of which want markup.
 * Lists come out as "- item" lines so an exported note is still readable.
 */
export function richToText(v) {
  const s = String(v ?? '');
  if (!s.trim()) return '';
  if (!looksLikeHtml(s)) return s;

  const doc = new DOMParser().parseFromString(sanitise(s), 'text/html');
  const lines = [];
  const emit = (node, prefix = '') => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { lines[lines.length - 1] = (lines[lines.length - 1] ?? '') + c.nodeValue; continue; }
      if (c.nodeType !== 1) continue;
      const t = c.tagName;
      if (t === 'BR') { lines.push(''); continue; }
      if (t === 'LI') { lines.push(prefix + '- '); emit(c, prefix + '  '); continue; }
      if (t === 'UL' || t === 'OL') { emit(c, prefix); continue; }
      if (['P', 'DIV', 'H3', 'H4', 'BLOCKQUOTE', 'PRE'].includes(t)) { lines.push(prefix); emit(c, prefix); continue; }
      emit(c, prefix);
    }
  };
  lines.push('');
  emit(doc.body);
  return lines.map(l => l.replace(/\s+$/, '')).filter((l, i, a) => l !== '' || (a[i - 1] ?? '') !== '').join('\n').trim();
}

/** Is there anything in here at all? An empty editor leaves `<br>` behind. */
export const richIsEmpty = v => !richToText(v).trim();

/* ---------- the editor -------------------------------------------------- */

let seq = 0;

/**
 * Markup for one editor. Call `wireRich()` on a container afterwards.
 *
 * @param {object} o
 * @param {string} o.value     current value (HTML or plain text)
 * @param {string} o.name      read back with `readRich(root, name)`
 * @param {number} o.rows      visible height in rows
 * @param {string} o.placeholder
 */
export function richEditor({ value = '', name = 'rt' + (++seq), rows = 4, placeholder = '' } = {}) {
  const btn = (cmd, label, title, key) =>
    `<button type="button" class="rt-b" data-rt-cmd="${cmd}" title="${esc(title)} (${esc(key)})"
             tabindex="-1">${label}</button>`;
  return `<div class="rt" data-rt-name="${esc(name)}">
    <div class="rt-bar">
      ${btn('bold', '<b>B</b>', 'Bold', 'Ctrl+B')}
      ${btn('italic', '<i>I</i>', 'Italic', 'Ctrl+I')}
      ${btn('underline', '<u>U</u>', 'Underline', 'Ctrl+U')}
      <span class="rt-sep"></span>
      ${btn('insertUnorderedList', '&bull;&nbsp;&#8212;', 'Bullet list', 'Tab')}
      ${btn('insertOrderedList', '1.&nbsp;&#8212;', 'Numbered list', 'Ctrl+Shift+7')}
      <span class="rt-sep"></span>
      ${btn('outdent', '&#8676;', 'Outdent', 'Shift+Tab')}
      ${btn('indent', '&#8677;', 'Indent', 'Tab')}
      <span class="rt-sep"></span>
      ${btn('removeFormat', '&#10005;', 'Clear formatting', 'Ctrl+\\')}
    </div>
    <div class="rt-body" contenteditable="true" role="textbox" aria-multiline="true"
         data-ph="${esc(placeholder)}" style="min-height:${Math.max(2, rows) * 1.55}em"
      >${renderRich(value)}</div>
  </div>`;
}

/** The current value of one editor inside `root`, sanitised and ready to store. */
export function readRich(root, name) {
  const el = root.querySelector(`.rt[data-rt-name="${name}"] .rt-body`);
  if (!el) return '';
  const html = sanitise(el.innerHTML);
  // A contenteditable that has been typed in and cleared keeps a stray <br>.
  return richIsEmpty(html) ? '' : html;
}

/**
 * Make every editor inside `root` behave like a document.
 *
 * @param {Element} root
 * @param {(name:string, html:string)=>void} [onChange] called on input, debounced
 */
export function wireRich(root, onChange) {
  for (const rt of root.querySelectorAll('.rt')) {
    if (rt.dataset.rtWired) continue;
    rt.dataset.rtWired = '1';
    const body = rt.querySelector('.rt-body');
    const name = rt.dataset.rtName;

    /** What this editor currently holds, cleaned and ready to store. */
    const value = () => {
      const html = sanitise(body.innerHTML);
      return richIsEmpty(html) ? '' : html;
    };

    /** Is the caret inside a list item? Decides what Tab means. */
    const inList = () => {
      const sel = document.getSelection();
      let n = sel && sel.anchorNode;
      while (n && n !== body) { if (n.nodeName === 'LI') return true; n = n.parentNode; }
      return false;
    };

    let deb;
    const sync = () => {
      if (!onChange) return;
      clearTimeout(deb);
      deb = setTimeout(() => onChange(name, value()), 400);
    };

    const exec = (cmd) => {
      body.focus();
      try { document.execCommand(cmd, false, null); } catch { /* nothing to do */ }
      sync();
    };

    rt.querySelectorAll('[data-rt-cmd]').forEach(b => {
      // mousedown, not click: click runs after the editor has lost its
      // selection, and execCommand with no selection does nothing.
      b.addEventListener('mousedown', e => { e.preventDefault(); exec(b.dataset.rtCmd); });
    });

    body.addEventListener('keydown', e => {
      const ctrl = e.ctrlKey || e.metaKey;

      if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) { exec('outdent'); return; }
        /*
         * Tab is the "make this a bullet" key, which is what a Word user
         * reaches for. Inside a list it nests one level; outside, it starts
         * the list. Either way it must never move focus to the next control.
         */
        if (inList()) exec('indent'); else exec('insertUnorderedList');
        return;
      }

      if (!ctrl) return;
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); exec('bold'); }
      else if (k === 'i') { e.preventDefault(); exec('italic'); }
      else if (k === 'u') { e.preventDefault(); exec('underline'); }
      else if (k === '\\') { e.preventDefault(); exec('removeFormat'); }
      // Word's own list shortcuts, so muscle memory works.
      else if (e.shiftKey && (k === 'l' || k === '8')) { e.preventDefault(); exec('insertUnorderedList'); }
      else if (e.shiftKey && k === '7') { e.preventDefault(); exec('insertOrderedList'); }
    });

    // Paste as our own subset. Word and Confluence paste a mountain of markup.
    body.addEventListener('paste', e => {
      const dt = e.clipboardData;
      if (!dt) return;
      e.preventDefault();
      const html = dt.getData('text/html');
      const text = dt.getData('text/plain');
      const clean = html ? sanitise(html) : esc(text).replace(/\r?\n/g, '<br>');
      try { document.execCommand('insertHTML', false, clean); } catch { body.textContent += text; }
      sync();
    });

    body.addEventListener('input', sync);
    body.addEventListener('blur', () => { clearTimeout(deb); if (onChange) onChange(name, value()); });
  }
}
