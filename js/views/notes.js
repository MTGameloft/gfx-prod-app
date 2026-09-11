/* ============================================================================
   views/notes.js — the scratchpad.

   Notes are created and edited in place, dragged into the order you want, and
   colour-coded. No dialog stands between you and writing something down;
   friction is what stops people keeping notes at all.
   ========================================================================= */

import * as S from '../store.js';
import {
  h, raw, esc, icon, toast, dialog, confirmDlg, menu, acts,
  fmtDate, today, download,
} from '../ui.js';

let q = '';

/** Tints, not fills — they have to stay readable in dark mode and contrast. */
export const NOTE_COLORS = [
  { id: '',        label: 'None',   hex: '' },
  { id: 'yellow',  label: 'Yellow', hex: '#E8A33D' },
  { id: 'blue',    label: 'Blue',   hex: '#4C9AFF' },
  { id: 'green',   label: 'Green',  hex: '#13A10E' },
  { id: 'purple',  label: 'Purple', hex: '#A055C9' },
  { id: 'pink',    label: 'Pink',   hex: '#E2637E' },
  { id: 'teal',    label: 'Teal',   hex: '#2FB8A8' },
  { id: 'red',     label: 'Red',    hex: '#C4314B' },
];
const colorOf = id => NOTE_COLORS.find(c => c.id === (id || '')) || NOTE_COLORS[0];

/* ---------- ordering ----------------------------------------------------- */

/** Notes written before ordering existed have no `order`; fall back to date. */
function ordered(list) {
  return list.slice().sort((a, b) =>
    (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
    (a.order ?? 1e9) - (b.order ?? 1e9) ||
    (b.updated || 0) - (a.updated || 0));
}
const nextOrder = () => {
  const os = S.get().notes.map(n => n.order).filter(x => typeof x === 'number');
  return os.length ? Math.min(...os) - 1 : 0;      // new notes land at the top
};

/** Rewrite every order value to match the on-screen sequence. */
function persistOrder(ids) {
  S.mutate(s => {
    ids.forEach((id, i) => { const n = S.byId(s.notes, id); if (n) n.order = i; });
  }, { label: 'reorder notes' });
}

/* ---------- rendering ---------------------------------------------------- */

function noteCard(n) {
  const c = colorOf(n.color);
  const tint = c.hex
    ? `background:color-mix(in srgb, ${c.hex} 9%, var(--bg-elev));border-left:3px solid ${c.hex}`
    : '';
  return `
  <section class="card note" data-id="${n.id}" draggable="true" style="${tint}">
    <header style="gap:6px">
      <span class="drag-handle" title="Drag to reorder" data-grip>
        <svg class="ico" style="width:14px;height:14px"><use href="#i-dots"></use></svg></span>
      ${n.pinned ? '<svg class="ico" style="width:14px;height:14px;color:var(--accent)"><use href="#i-star"></use></svg>' : ''}
      <div class="note-title" contenteditable="plaintext-only" data-field="title"
           data-ph="Untitled" spellcheck="false">${esc(n.title || '')}</div>
      <button class="btn icon sm subtle" data-act="menu" title="More"><svg class="ico"><use href="#i-dots"></use></svg></button>
    </header>
    <div class="body" style="padding-top:8px">
      <div class="note-body" contenteditable="plaintext-only" data-field="body"
           data-ph="Start typing…">${esc(n.body || '')}</div>
      <div class="row" style="margin-top:10px;gap:5px;align-items:center">
        ${NOTE_COLORS.map(x => `<button class="swatch${(n.color || '') === x.id ? ' on' : ''}"
            data-act="colour" data-c="${x.id}" title="${esc(x.label)}"
            style="${x.hex ? `background:${x.hex}` : ''}"></button>`).join('')}
        <span class="spacer" style="flex:1"></span>
        <span class="tiny mute">${esc(fmtDate(new Date(n.updated || Date.now()).toISOString().slice(0, 10), 'long'))}</span>
      </div>
    </div>
  </section>`;
}

const addTile = () => `
  <button class="card note-add" data-act="new" title="New note (or press N)">
    <svg class="ico" style="width:22px;height:22px"><use href="#i-plus"></use></svg>
    <span>New note</span>
  </button>`;

/* ---------- view --------------------------------------------------------- */

export default {
  id: 'notes', title: 'Notes', icon: 'note', group: 'space',
  subtitle: 'Decisions, agendas and things you will otherwise forget',

  actions: ctx => [
    { label: 'New note', icon: 'plus', primary: true, run: () => createInline(ctx) },
  ],

  render(host, ctx) {
    const term = q.trim().toLowerCase();
    const all = S.get().notes;
    const list = ordered(all.filter(n => !term || (`${n.title} ${n.body}`).toLowerCase().includes(term)));

    host.innerHTML = h`
      <div class="toolbar">
        <div class="search" style="width:280px">${icon('search')}
          <input type="search" id="nq" placeholder="Search notes…" value="${q}"></div>
        <div class="spacer" style="flex:1"></div>
        <span class="tiny mute">${list.length} of ${all.length}</span>
        <button class="btn sm subtle" data-act="export">${icon('down')}Export all</button>
      </div>
      <div class="notes-grid" id="ngrid">
        ${raw(term ? '' : addTile())}
        ${raw(list.map(noteCard).join(''))}
      </div>
      ${raw(!all.length ? `<div class="hint" style="margin-top:12px">
        Click <b>New note</b> to write one straight into the panel. Drag cards to reorder,
        and use the dots under a note to colour it.</div>` : '')}
      ${raw(term && !list.length ? `<div class="card"><div class="empty">
        <svg class="ico"><use href="#i-search"></use></svg>
        <h4>Nothing matched “${esc(term)}”</h4></div></div>` : '')}`;

    const nq = host.querySelector('#nq');
    let t;
    nq.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { q = nq.value; ctx.rerender(); }, 220); });

    acts(host, {
      new: () => createInline(ctx),
      export: () => {
        const md = ordered(S.get().notes).map(n => `# ${n.title || 'Untitled'}\n\n${n.body}\n`).join('\n---\n\n');
        download(`gfx-notes-${today()}.md`, md, 'text/markdown;charset=utf-8');
        toast('Notes exported as Markdown', 'ok');
      },
      colour: el => {
        const id = el.closest('[data-id]').dataset.id;
        const c = el.dataset.c;
        S.mutate(s => { S.byId(s.notes, id).color = c; }, { label: 'note colour' });
        ctx.rerender();
      },
      menu: (el, ev) => {
        const id = el.closest('[data-id]').dataset.id;
        const n = S.byId(S.get().notes, id);
        menu(ev, [
          { label: n.pinned ? 'Unpin' : 'Pin to top', icon: 'star',
            run: () => { S.update('notes', id, { pinned: !n.pinned }); ctx.rerender(); } },
          { label: 'Duplicate', icon: 'file', run: () => {
            S.add('notes', { title: (n.title || 'Untitled') + ' (copy)', body: n.body, color: n.color,
                             pinned: false, order: nextOrder(), updated: Date.now() });
            ctx.rerender();
          } },
          { label: 'Copy to clipboard', icon: 'link', run: () => {
            navigator.clipboard.writeText(`${n.title || ''}\n\n${n.body || ''}`.trim());
            toast('Copied', 'ok');
          } },
          '-',
          { label: 'Delete', icon: 'trash', danger: true, run: async () => {
            if (await confirmDlg(`Delete “${n.title || 'Untitled'}”?`, { ok: 'Delete' })) {
              S.remove('notes', id); ctx.rerender();
            }
          } },
        ]);
      },
    });

    wireInlineEdit(host, ctx);
    wireDnd(host, ctx);

    // press N anywhere on the page to start a note
    const key = e => {
      if (e.key.toLowerCase() !== 'n' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
      e.preventDefault(); createInline(ctx);
    };
    document.addEventListener('keydown', key);

    // focus a freshly created note
    if (pendingFocus) {
      const el = host.querySelector(`[data-id="${pendingFocus}"] [data-field="title"]`);
      pendingFocus = null;
      if (el) { el.focus(); }
    }

    return () => document.removeEventListener('keydown', key);
  },
};

/* ---------- inline create & edit ---------------------------------------- */

let pendingFocus = null;

function createInline(ctx) {
  if (q) { q = ''; }                       // a filter would hide the new note
  const rec = S.add('notes', {
    title: '', body: '', color: '', pinned: false,
    order: nextOrder(), updated: Date.now(),
  });
  pendingFocus = rec.id;
  ctx.rerender();
}

/**
 * contenteditable saves on blur, and on a debounce while typing so a crash or
 * a closed tab cannot cost more than a second of writing.
 */
function wireInlineEdit(host, ctx) {
  let timer = null, dirty = new Map();

  const flush = () => {
    if (!dirty.size) return;
    const snapshot = new Map(dirty);
    dirty.clear();
    S.mutate(s => {
      for (const [id, fields] of snapshot) {
        const n = S.byId(s.notes, id);
        if (n) Object.assign(n, fields, { updated: Date.now() });
      }
    }, { label: 'edit note', noUndo: true });
  };

  host.addEventListener('input', e => {
    const el = e.target.closest('[data-field]');
    if (!el) return;
    const id = el.closest('[data-id]').dataset.id;
    const patch = dirty.get(id) || {};
    patch[el.dataset.field] = el.innerText.replace(/ /g, ' ');
    dirty.set(id, patch);
    clearTimeout(timer);
    timer = setTimeout(flush, 900);
  });

  host.addEventListener('focusout', e => {
    if (!e.target.closest('[data-field]')) return;
    clearTimeout(timer);
    flush();
  });

  // Escape gives up focus; Ctrl+Enter jumps from title to body
  host.addEventListener('keydown', e => {
    const el = e.target.closest('[data-field]');
    if (!el) return;
    if (e.key === 'Escape') { el.blur(); }
    if (e.key === 'Enter' && el.dataset.field === 'title') {
      e.preventDefault();
      el.closest('[data-id]').querySelector('[data-field="body"]')?.focus();
    }
  });

  window.addEventListener('beforeunload', flush);
}

/* ---------- drag to reorder ---------------------------------------------- */

function wireDnd(host, ctx) {
  const grid = host.querySelector('#ngrid');
  if (!grid) return;
  let dragEl = null;

  grid.addEventListener('dragstart', e => {
    const card = e.target.closest('.note');
    if (!card) return;
    dragEl = card;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.id);
  });

  grid.addEventListener('dragend', () => {
    dragEl?.classList.remove('dragging');
    dragEl = null;
    // commit whatever order the DOM ended up in
    persistOrder([...grid.querySelectorAll('.note')].map(el => el.dataset.id));
  });

  grid.addEventListener('dragover', e => {
    if (!dragEl) return;
    e.preventDefault();
    const over = e.target.closest('.note');
    if (!over || over === dragEl) return;
    const r = over.getBoundingClientRect();
    // insert before or after depending on which half the cursor is over,
    // measured rather than assumed so a wide card behaves the same as a tall one
    const after = (e.clientX - r.left) > r.width / 2;
    grid.insertBefore(dragEl, after ? over.nextSibling : over);
  });

  grid.addEventListener('drop', e => e.preventDefault());
}
