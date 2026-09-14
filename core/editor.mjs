/**
 * core/editor.mjs — #1367: one editor everywhere a description or comment is
 * written.
 *
 * "There were conversations about how painful it is to edit a card
 * description, even on first add." (the owner, on #1367, 2026-09-13). What existed was
 * four textareas, each styled and wired on its own: the create form, the
 * column edit form, the wiki body, the commons composers. None previewed, none
 * grew, and the create form's box stopped at 120px — the "wall" #40 felt in May
 * was a box that stopped growing, not a byte limit (there is no maxlength on a
 * description and the server takes 10 MB bodies).
 *
 * This wraps an EXISTING textarea in place rather than replacing it, so every
 * selector and handler a surface already has (#card-desc, .edit-desc,
 * #convs-body, the paste-to-attach listener, the #1255 draft watch) keeps
 * working untouched. It is an enhancement, not a dependency: a page that never
 * mounts it still has its textarea.
 *
 *   mountEditor(textarea, { render, resolveTitle, onSubmit, maxHeight })
 *     render        (text) => html — the SURFACE'S OWN renderer. The board
 *                   shows a description as escaped text + #NNN links; the
 *                   commons shows chat markdown. A preview through any other
 *                   renderer is a lie about what save will show, so the
 *                   component takes one rather than owning one. Omit it and
 *                   there is no preview control.
 *     resolveTitle  (shortId) => string | undefined — puts the card's title on
 *                   a #NNN's hover in the preview when the surface can look it
 *                   up; nothing when it cannot.
 *     onSubmit      () => void — Cmd/Ctrl+Enter. Plain Enter stays a newline.
 *     maxHeight     px — grows to fit up to here, then scrolls (default 480).
 *
 * Returns a handle: { root, textarea, previewing, showPreview(bool), refresh(),
 * destroy() }. Mounting twice on one textarea returns the same handle.
 *
 * No node imports — runs in the browser (isomorphic core, ADR-002).
 */

const HANDLES = new WeakMap();

export function mountEditor(textarea, {
  doc = textarea?.ownerDocument,
  render = null,
  resolveTitle = null,
  onSubmit = null,
  maxHeight = 480,
} = {}) {
  if (!textarea || textarea.tagName !== 'TEXTAREA') throw new Error('mountEditor: a <textarea> is required');
  if (HANDLES.has(textarea)) return HANDLES.get(textarea);

  const root = doc.createElement('div');
  root.className = 'mh-editor';
  const bar = doc.createElement('div');
  bar.className = 'mh-editor-bar';

  let preview = null;
  let writeBtn = null;
  let previewBtn = null;
  if (typeof render === 'function') {
    writeBtn = mkBtn(doc, 'Write', 'data-editor-write');
    previewBtn = mkBtn(doc, 'Preview', 'data-editor-preview');
    writeBtn.setAttribute('aria-pressed', 'true');
    previewBtn.setAttribute('aria-pressed', 'false');
    bar.append(writeBtn, previewBtn);
    preview = doc.createElement('div');
    preview.className = 'mh-editor-preview prose';
    preview.hidden = true;
  }
  const hint = doc.createElement('span');
  hint.className = 'mh-editor-hint';
  hint.textContent = onSubmit ? '⌘/Ctrl+Enter to submit' : '';
  bar.append(hint);

  // Wrap in place: the textarea keeps its parent, its id, its listeners.
  const parent = textarea.parentNode;
  parent.insertBefore(root, textarea);
  root.append(bar, textarea);
  if (preview) root.append(preview);

  // Growth. The surface's own stylesheet may cap the box (index.html caps
  // .form-textarea at 120px); the inline max-height wins so the ceiling here
  // is the one that applies.
  textarea.style.maxHeight = `${maxHeight}px`;
  textarea.style.resize = 'vertical';
  const grow = () => {
    textarea.style.height = 'auto';
    const h = textarea.scrollHeight;
    // Not laid out (display:none ancestor, a closed <details>): scrollHeight
    // reads 0 and a 0px box would be the result. Leave the stylesheet's
    // height in place; focus re-measures once it is visible.
    if (h === 0) { textarea.style.height = ''; textarea.style.overflowY = ''; return; }
    if (h > maxHeight) {
      textarea.style.height = `${maxHeight}px`;
      textarea.style.overflowY = 'auto';
    } else {
      textarea.style.height = `${h}px`;
      textarea.style.overflowY = 'hidden';
    }
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && typeof onSubmit === 'function') {
      e.preventDefault();
      onSubmit();
    }
  };

  let previewing = false;
  const refresh = () => {
    if (!preview || !previewing) return;
    preview.innerHTML = render(textarea.value);
    if (typeof resolveTitle === 'function') {
      for (const a of preview.querySelectorAll('a[data-shortid]')) {
        const t = resolveTitle(Number(a.dataset.shortid));
        if (t) a.title = t; // property assignment — a title is text, never markup
      }
    }
  };
  const showPreview = (on) => {
    if (!preview) return;
    previewing = !!on;
    textarea.hidden = previewing;
    preview.hidden = !previewing;
    writeBtn.setAttribute('aria-pressed', String(!previewing));
    previewBtn.setAttribute('aria-pressed', String(previewing));
    root.classList.toggle('previewing', previewing);
    if (previewing) refresh();
    else { textarea.focus?.(); grow(); }
  };

  textarea.addEventListener('input', grow);
  textarea.addEventListener('focus', grow);
  textarea.addEventListener('keydown', onKey);
  if (writeBtn) writeBtn.addEventListener('click', () => showPreview(false));
  if (previewBtn) previewBtn.addEventListener('click', () => showPreview(true));
  grow();

  const handle = {
    root,
    textarea,
    get previewing() { return previewing; },
    showPreview,
    refresh,
    grow,
    destroy() {
      textarea.removeEventListener('input', grow);
      textarea.removeEventListener('focus', grow);
      textarea.removeEventListener('keydown', onKey);
      textarea.hidden = false;
      root.parentNode?.insertBefore(textarea, root);
      root.remove();
      HANDLES.delete(textarea);
    },
  };
  HANDLES.set(textarea, handle);
  return handle;
}

function mkBtn(doc, label, attr) {
  const b = doc.createElement('button');
  b.type = 'button'; // never a form submit
  b.className = 'mh-editor-tab';
  b.textContent = label;
  b.setAttribute(attr, '');
  return b;
}
