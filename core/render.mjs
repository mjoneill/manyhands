/**
 * core/render.mjs — pure, browser-safe markdown→HTML for the wiki.
 *
 * Escape-FIRST (XSS-safe by construction): everything user-supplied is HTML-
 * escaped before any markup is added, so nothing can become live HTML. Then a
 * minimal, safe markdown subset — headings, unordered lists, bold/italic,
 * [[wikilinks]] — assembled LINE BY LINE so single newlines and list items
 * render correctly (real notes rarely use blank-line-separated paragraphs; #247
 * fixed a heading-block that swallowed every following line). No node imports →
 * runs in the browser too (isomorphic core, ADR-002).
 */

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Inline marks on already-escaped text: bold first, then italic.
function inline(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
}

// #248 — turn a flat [{depth, html}] sequence (depth 0-based, only ever +1 per
// step, clamped at collection) into nested <ul> markup, with each child list
// living inside its parent <li>.
function buildNestedList(items) {
  let out = '';
  let depth = -1;
  for (const it of items) {
    if (it.depth > depth) {
      while (depth < it.depth) { out += '<ul>'; depth++; }
      out += `<li>${it.html}`;
    } else if (it.depth === depth) {
      out += `</li><li>${it.html}`;
    } else {
      while (depth > it.depth) { out += '</li></ul>'; depth--; }
      out += `</li><li>${it.html}`;
    }
  }
  while (depth >= 0) { out += '</li></ul>'; depth--; }
  return out;
}

// #303-1 — chat-minimal markdown for the commons. Same escape-FIRST guarantee
// as renderMarkdown (XSS-safe by construction), but a deliberately smaller
// subset so posts stay *chat*, not documents: bold, italic, unordered lists,
// and #NNN card links. NO headings — a line like "# thing" renders as literal
// text (and `#123` becomes a card link), which also gently discourages the
// wall-of-headers habit. Consecutive text lines join with <br> (no <p>/<h*>
// blocks) to keep the compact chat feel.
// #303-1 — a #NNN card ref. Runs on ALREADY-ESCAPED text, so the lookbehind
// must also exclude `&` and `;` — otherwise it would match the `#39` inside the
// escaped apostrophe `&#39;` and corrupt the entity (turning "it's" into
// "Alex&<link>#39</link>;s"). `\w` keeps "word#3" from matching, as before.
const CHAT_CARD_REF_RE = /(?<![\w&;])#(\d+)/g;

// Inline marks on already-escaped text: bold, italic, THEN #NNN links. Order
// matters — the <a> insertion runs last so its attributes aren't re-processed.
function inlineChat(s) {
  return inline(s).replace(
    CHAT_CARD_REF_RE,
    (_, n) => `<a class="cardref" data-shortid="${n}" href="index.html?card=${n}">#${n}</a>`,
  );
}

export function renderChatMarkdown(text) {
  if (typeof text !== 'string') return '';
  const s = escapeHtml(text); // escape FIRST — nothing user-supplied becomes live HTML
  const out = [];
  let buf = [];
  let list = [];
  const flushBuf = () => { if (buf.length) { out.push(buf.join('<br>')); buf = []; } };
  const flushList = () => { if (list.length) { out.push(buildNestedList(list)); list = []; } };

  for (const line of s.split('\n')) {
    const bullet = line.match(/^([ \t]*)[-*]\s+(.*)$/);
    if (bullet) {
      flushBuf();
      const raw = Math.floor(bullet[1].replace(/\t/g, '  ').length / 2);
      const depth = list.length ? Math.min(raw, list[list.length - 1].depth + 1) : 0;
      list.push({ depth, html: inlineChat(bullet[2]) });
    } else {
      flushList();
      buf.push(inlineChat(line));
    }
  }
  flushBuf();
  flushList();
  return out.join('');
}

export function renderMarkdown(text) {
  if (typeof text !== 'string') return '';

  // 1. Escape everything first — nothing user-supplied can become live HTML.
  let s = escapeHtml(text);

  // 2. [[wikilinks]] → safe anchors. The target is already escaped, so the
  //    data-target attribute can't break out; brackets/pipe survive escaping.
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
    const t = target.trim();
    const label = (alias != null ? alias : target).trim();
    return `<a class="wikilink" data-target="${t}">${label}</a>`;
  });

  // 3. Assemble block structure line by line: headings stand alone; `-`/`*`
  //    lines group into a <ul>; blank lines break paragraphs; consecutive text
  //    lines join with <br> so single newlines are preserved (not enjambed).
  const out = [];
  let para = [];
  let list = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list.length) { out.push(buildNestedList(list)); list = []; } };

  for (const line of s.split('\n')) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^([ \t]*)[-*]\s+(.*)$/);
    if (heading) {
      flushPara(); flushList();
      const lvl = heading[1].length;
      out.push(`<h${lvl}>${inline(heading[2])}</h${lvl}>`);
    } else if (bullet) {
      flushPara();
      // depth from leading indent (tab = one level); only ever one deeper than
      // the previous item, so a stray over-indent can't produce invalid nesting.
      const raw = Math.floor(bullet[1].replace(/\t/g, '  ').length / 2);
      const depth = list.length ? Math.min(raw, list[list.length - 1].depth + 1) : 0;
      list.push({ depth, html: inline(bullet[2]) });
    } else if (line.trim() === '') {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(inline(line));
    }
  }
  flushPara(); flushList();

  return out.join('\n');
}
