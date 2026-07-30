/**
 * #558 — read a server.js and answer, mechanically, which board writes are
 * serialized through `withWriteLock`.
 *
 * Shared by the structural test (which asserts coverage) and the probe (which
 * reports which KIND of tree it was pointed at), so there is one implementation
 * of "is this write site locked" and the two cannot disagree.
 *
 * ── WHY THE PROBE NEEDS THIS AT ALL ─────────────────────────────────────────
 * Because `.` is not an identifier. Both @indigo's comment and my test header
 * documented `interleave-probe.mjs . 60 --inject-yield` as the run that loses
 * every round — TRUE on a pre-fix checkout, FALSE the moment the file is
 * cherry-picked onto the branch that adds the lock, because `.` then resolves
 * to a tree where the injected yield lands INSIDE the critical section.
 *
 * Nobody edited the instruction. Its truth value flipped by being moved, and it
 * failed in the worst direction: a confident `⚪ no loss` that reads as
 * reassurance. Caught by @indigo running her own documented command.
 *
 * ⇒ So the instrument stops trusting the operator's belief about the path and
 *   reports the property it can determine for itself.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Blank out comments and string bodies, preserving every offset and newline.
 *
 * Found the hard way: matching against raw source counted an explanatory
 * COMMENT naming a function as a call to it, so a check failed on the tree with
 * the better comment and passed on the tree without one. A source matcher that
 * cannot tell code from prose grades documentation as behaviour.
 *
 * Strings are blanked too because server.js contains `http://127.0.0.1`, and a
 * `//` inside a string would otherwise swallow the rest of the line as a
 * comment. Length is preserved so offsets and line numbers stay meaningful.
 */
export function codeOnly(src) {
  const out = src.split('');
  const blank = (i) => { if (out[i] !== '\n') out[i] = ' '; };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') blank(i++);
    } else if (c === '/' && d === '*') {
      blank(i++); blank(i++);
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) blank(i++);
      blank(i++); blank(i++);
    } else if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++; // keep the opening quote so the token still parses as a string
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') blank(i++);
        if (i < src.length) blank(i++);
      }
      i++;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** Byte ranges of every `withWriteLock(...)` callback body, by brace matching. */
export function lockedRanges(src) {
  const ranges = [];
  const re = /withWriteLock\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 0;
    let started = false;
    for (let i = m.index; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') {
        depth--;
        if (started && depth === 0) { ranges.push([m.index, i]); break; }
      }
    }
  }
  return ranges;
}

/** The nearest preceding `function name(` — whose body a given offset sits in. */
export function enclosingFunction(src, offset) {
  const head = src.slice(0, offset);
  const matches = [...head.matchAll(/function\s+([A-Za-z0-9_$]+)\s*\(/g)];
  return matches.length ? matches[matches.length - 1][1] : '(top level)';
}

/** Every `writeBoard(...)` CALL site (never the declaration), with its context. */
export function writeBoardSites(src) {
  const ranges = lockedRanges(src);
  const sites = [];
  const re = /writeBoard\(/g;
  let m;
  while ((m = re.exec(src))) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const line = src.slice(lineStart, src.indexOf('\n', m.index));
    if (/^\s*function\s+writeBoard/.test(line)) continue;
    sites.push({
      offset: m.index,
      line: src.slice(0, m.index).split('\n').length,
      fn: enclosingFunction(src, m.index),
      locked: ranges.some(([a, b]) => m.index > a && m.index < b),
    });
  }
  return sites;
}

/**
 * Which kind of checkout is this — pre-fix or fixed?
 *
 * Decided by the property that matters to the probe rather than by branch name,
 * path, or the operator's expectation: does `handleSave`'s board write run
 * inside a `withWriteLock` callback?
 *
 * @returns {{locked: boolean|null, line: number|null, reason: string}}
 */
export function describeTarget(serverDir) {
  const file = path.join(serverDir, 'server.js');
  if (!fs.existsSync(file)) {
    return { locked: null, line: null, reason: `no server.js in ${serverDir}` };
  }
  const src = codeOnly(fs.readFileSync(file, 'utf8'));
  const site = writeBoardSites(src).find((s) => s.fn === 'handleSave');

  // Fail loud rather than guessing. A silent `locked: false` here would put the
  // probe right back to asserting something it did not check.
  if (!site) {
    return {
      locked: null,
      line: null,
      reason: 'could not find handleSave\'s writeBoard() call — this build may not be the one these modes describe',
    };
  }
  return {
    locked: site.locked,
    line: site.line,
    reason: site.locked
      ? `handleSave's writeBoard() at server.js:${site.line} runs INSIDE withWriteLock — this checkout HAS the #558 fix`
      : `handleSave's writeBoard() at server.js:${site.line} runs OUTSIDE withWriteLock — this checkout is PRE-FIX`,
  };
}
