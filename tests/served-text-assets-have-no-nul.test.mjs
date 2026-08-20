/**
 * #485 — no served text asset may contain a NUL byte.
 *
 * ⛔ THE INSTANCE, 2026-08-20. A group-key sentinel in `commons.html` intended
 * as `' legacy'` (leading space) was written with `0x00`, four times. The
 * comparisons stayed self-consistent, so grouping worked, the DOM was correct
 * and NINETEEN TESTS PASSED — twice. `file commons.html` reported `data` rather
 * than `HTML document text`, and grep began treating the source as binary and
 * silently returning nothing.
 *
 * ⭐⭐⭐ It was caught by a `grep` run for an unrelated reason, whose empty
 * output I could not explain. Nothing in the suite could ever have failed on
 * it: a private sentinel's byte value is not observable behaviour — its only
 * contract is equality with itself, so ANY internal token I mistype stays
 * self-consistent by construction.
 *
 * ⇒ THIS TEST EXISTS BECAUSE THE MANUAL SWEEP PROVED THE TREE CLEAN AND
 * PREVENTS NOTHING. (@minimo's durability requirement, and she is right: "a
 * manual population grep does not prevent recurrence.")
 *
 * ⚠️ Deliberately a BYTE check, not an encoding check. The file was valid
 * UTF-8 the whole time — a NUL is a legal code point. What makes it a defect is
 * that it is a control byte in a document served as text, which breaks tooling
 * (grep, diff, editors, and anything that sniffs text-vs-binary) without
 * breaking rendering. An encoding assertion would have passed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Extensions whose bytes are served or read AS TEXT. A NUL in any of these is
// a defect regardless of whether the thing still renders.
const TEXT_EXT = new Set(['.html', '.css', '.mjs', '.js', '.json', '.md', '.sh', '.txt', '.svg']);
const SKIP_DIR = new Set(['node_modules', '.git', 'coverage', 'dist', '.cache']);

function textFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.githooks') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue;
      textFiles(full, out);
    } else if (TEXT_EXT.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/** The detector, isolated so the control below can exercise the same code. */
const nulCount = (file) => {
  const buf = fs.readFileSync(file);
  let n = 0;
  for (const b of buf) if (b === 0) n += 1;
  return n;
};

/**
 * ⭐ THE CONTROL, and it runs FIRST. A sweep that cannot detect the thing it
 * sweeps for reports a clean tree forever — which is exactly the failure mode
 * of the defect it is guarding (green because nothing could have gone red).
 */
test('#485 the NUL detector actually detects — control, must find a planted byte', () => {
  const planted = path.join(os.tmpdir(), `nul-control-${process.pid}.html`);
  try {
    fs.writeFileSync(planted, Buffer.from("<p>const k = '\0legacy';</p>\n", 'binary'));
    assert.equal(nulCount(planted), 1,
      'the detector missed a planted NUL — every "clean" result below is now meaningless');
  } finally {
    fs.rmSync(planted, { force: true });
  }
});

test('#485 commons.html — the file the defect actually landed in', () => {
  const f = path.join(REPO, 'commons.html');
  assert.equal(nulCount(f), 0,
    'commons.html contains a NUL byte: the page will still render and every DOM assertion will still pass, '
    + 'but `file` reports it as data and grep treats it as binary. Look for an invisible character used as a sentinel.');
});

test('#485 no served text asset anywhere in the tree contains a NUL byte', () => {
  const files = textFiles(REPO);

  // Vacuity guard: a walker that finds nothing passes trivially. This is the
  // shrunk-denominator failure — an instrument that narrows its own input and
  // then reports on what is left.
  assert.ok(files.length > 100,
    `the walker found only ${files.length} text files — it is not covering the tree, so a clean result means nothing`);
  assert.ok(files.some((f) => f.endsWith('index.html')), 'walker missed index.html');
  assert.ok(files.some((f) => f.endsWith('server.js')), 'walker missed server.js');

  const offenders = files
    .map((f) => ({ f: path.relative(REPO, f), n: nulCount(f) }))
    .filter((r) => r.n > 0);

  // ⭐ ZERO EXEMPTIONS, and it did not start that way.
  //
  // This sweep first found `core/export-html.mjs` carrying four literal NULs —
  // deliberate, as a placeholder for code spans during markdown conversion, on
  // the sound reasoning that NUL cannot occur in the input. I recorded it as an
  // expected value rather than an ignore-rule.
  //
  // ⛔ The Value Steward refused that: "do not allowlist literal NUL bytes. If
  // runtime logic needs a NUL delimiter, encode it TEXTUALLY as '\0' or '\x00';
  // repository source must remain text." She is right, and the fix is free —
  // the escape sequence produces the identical byte at runtime while leaving
  // the source greppable, diffable and readable. 19 export tests unchanged.
  //
  // ⇒ So the exemption is gone rather than documented. A guard with no
  // exceptions is the only kind whose empty result needs no footnote.
  const KNOWN = [];

  assert.deepEqual(offenders, KNOWN,
    `NUL bytes in served text assets (${files.length} scanned).\n`
    + `A NUL renders fine and passes every DOM assertion, while making the file read as binary to grep, diff and \`file\`.\n`
    + `found:\n${offenders.map((o) => `  ${o.f}: ${o.n}`).join('\n') || '  (none)'}\n`
    + `expected:\n${KNOWN.map((o) => `  ${o.f}: ${o.n}`).join('\n')}`);
});

/**
 * ⛔⛔⛔ AND THE REASON THIS FILE EXISTS AT ALL, rather than a shell one-liner.
 *
 * After fixing the NUL in commons.html I swept the tree with
 * `grep -rlP "\x00" --include=...` and reported ZERO others. A second seat then
 * re-ran an independently-written sweep — `find -print0 | xargs -0 grep -lP` —
 * across 284 files and independently confirmed zero. Two seats, two commands,
 * agreement.
 *
 * ⇒ BOTH WERE FALSE NEGATIVES. `core/export-html.mjs` had four NULs the whole
 * time, and the test above found them on its first run.
 *
 * ⚠️ THE MECHANISM, measured rather than guessed — and my first explanation was
 * wrong. I assumed the pattern could not carry a NUL because it is a
 * NUL-terminated C string. It is simpler and worse than that:
 *
 *   grep -lP  "\x00" <file-with-nul>   ⇒ NO MATCH, exit 1
 *   grep -alP "\x00" <file-with-nul>   ⇒ MATCHES
 *
 * ⇒ grep classifies a file containing NUL as BINARY, and without `-a` it omits
 * binary files from `-l` output. So a search FOR the byte that makes a file
 * binary skips precisely the files that contain it.
 *
 * ⭐⭐⭐ THE INSTRUMENT IS SELF-DEFEATING ON EXACTLY ITS OWN SUBJECT, and it
 * fails by reporting a clean result rather than by refusing.
 *
 * ⇒ AND THE LESSON ABOVE THE TOOL: AGREEMENT BETWEEN SEATS IS NOT
 * TRIANGULATION WHEN BOTH REACH FOR THE SAME INSTRUMENT. Two seats, two
 * independently written commands, one shared blind spot — and the consensus
 * read as verification.
 *
 * This test asserts the property in the language the bytes live in, and pins
 * the blind spot so a future grep that closes it makes this fail loudly.
 */
// ⚠️ NO TEST ASSERTS grep's BEHAVIOUR HERE, and the reason is the third finding.
//
// I wrote one, and it failed — because `sh -c "grep -P …"` on this machine
// resolves to BSD grep, which has NO `-P` AT ALL (exit 2, empty stdout), while
// the interactive shell picks up a GNU grep earlier in PATH that does. So the
// same command means two different things on one machine depending on who runs
// it, and an empty result can mean "no matches", "binary suppressed", or
// "unsupported flag" — three states the caller cannot distinguish.
//
// ⇒ That is one more reason not to verify a byte-level property with a shell
// sweep, and a bad thing to encode as an assertion about someone else's tool.
// The property this suite owns is asserted above, in the language the bytes
// live in.
