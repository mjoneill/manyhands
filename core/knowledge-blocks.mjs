/**
 * #1894 — the two pure rules about a source's kept text, in a module that imports NOTHING.
 *
 * The board server reads a source's page numbers for the reading page (core/knowledge-reading.mjs). These rules lived beside
 * the extractor, whose module imports the LangGraph packages, so importing them from there put an npm dependency in
 * server.js's static import graph and broke "no install step" (#868). They are stated ONCE, here; the extractor's modules
 * re-export them, so every earlier import still resolves to this one implementation.
 */

/** Blocks are LINES: block index = line index, so a passage IRI is stable for a given byte content. */
export function blocksOf(text) { return String(text).split(/\r?\n/); }

/** The 1-based page a block (a line) of converted text sits on: one more than the form feeds before its text. */
export function pageOfBlock(blocks, i) {
  let ff = 0;
  for (let k = 0; k <= i && k < blocks.length; k += 1) {
    const b = blocks[k];
    // a form feed inside block i that comes AFTER some of its text would put that text on the earlier page; pdftotext
    // writes the form feed at the start of the next page's first line, so counting every one up to and including block i is right
    for (const ch of b) if (ch === '\f') ff += 1;
  }
  return ff + 1;
}

/**
 * #1961 — a Word file's kept text marks each heading as a line of "#" × its level, a space, then the heading's words (body lines
 * that would look like one are escaped with a backslash). These two rules turn that text into an address a reader can find in
 * the document, so the address, like a PDF's page, is derived from the kept text alone.
 */
const HEADING = /^(#{1,9}) (.*)$/;

/**
 * The section a block (a line) sits in: the heading path above it, and which paragraph of that heading it is (1-based, counting
 * only non-blank body lines). A block that IS a heading has para null. Null when no heading line comes at or before the block.
 */
export function sectionOfBlock(blocks, i) {
  if (!Number.isInteger(i) || i < 0 || i >= blocks.length) return null;
  let stack = []; let para = 0; let seen = false;
  for (let k = 0; k <= i; k += 1) {
    const m = HEADING.exec(blocks[k]);
    if (m) {
      const level = m[1].length;
      stack = [...stack.filter((h) => h.level < level), { level, text: m[2].trim() }];
      para = 0; seen = true;
      if (k === i) return { path: stack.map((h) => h.text), para: null };
    } else if (String(blocks[k]).trim()) para += 1;
  }
  return seen ? { path: stack.map((h) => h.text), para } : null;
}

/** "Evaluation › Method ¶2": the heading path, then the paragraph. Null for no section. */
export function addressOf(section) {
  if (!section) return null;
  const where = section.path.join(' › ');
  return section.para == null ? where : (where ? `${where} ¶${section.para}` : `¶${section.para}`);
}
