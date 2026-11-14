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
