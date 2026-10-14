/**
 * #1690 — shared pieces of the platform-split landing gate (decision 45a5d8e4).
 *
 * Three scripts use these: check-platform-skips.mjs (the CI leg), run-platform-only.mjs (the Mac leg) and
 * check-gate-pair.mjs (one commit, one manifest). Exit codes are shared too:
 *   0 clean · 1 mismatch (the output NAMES the test, file or sha) · 2 could not check (fails closed).
 *
 * "Could not check" is never "clean": an empty TAP, an empty manifest or an unreadable receipt is the state in
 * which a gate most easily prints its own all-clear.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

export const EXIT = Object.freeze({ CLEAN: 0, MISMATCH: 1, CANNOT_CHECK: 2 });

export class CannotCheck extends Error {}

/** Parse `--flag value` pairs and positionals. A flag given with no value is an error the caller reports as 2. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new CannotCheck(`${a} needs a value`);
      flags[a.slice(2)] = v;
      i += 1;
    } else positional.push(a);
  }
  return { flags, positional };
}

/**
 * The manifest: a non-empty JSON array of { file, name, reason }, each a non-empty string. Returns the entries and
 * the sha256 of the file's BYTES, which is what both legs record so a pair can prove they read the same list.
 */
export function readManifest(file) {
  if (!file) throw new CannotCheck('no --manifest given');
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (e) { throw new CannotCheck(`cannot read manifest ${file}: ${e.code ?? e.message}`); }
  let entries;
  try { entries = JSON.parse(bytes.toString('utf8')); } catch (e) { throw new CannotCheck(`manifest ${file} is not JSON: ${e.message}`); }
  if (!Array.isArray(entries) || entries.length === 0) throw new CannotCheck(`manifest ${file} lists no tests`);
  for (const [i, e] of entries.entries()) {
    for (const k of ['file', 'name', 'reason']) {
      if (typeof e?.[k] !== 'string' || !e[k].trim()) throw new CannotCheck(`manifest ${file} entry ${i} has no ${k}`);
    }
  }
  return { entries, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

/**
 * Test lines from a TAP stream: `ok N - name`, `not ok N - name`, either one optionally carrying a
 * `# SKIP reason` or `# TODO reason` directive. Indented lines (subtests) count too, so a skip cannot hide one
 * level down. TAP escapes `#` in a name as `\#`, so the directive is the first UNESCAPED ` # `, and the name is
 * unescaped before it is compared with the manifest's plain text.
 */
export function parseTap(text) {
  const tests = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(not )?ok \d+ - (.*)$/);
    if (!m) continue;
    const rest = m[2];
    const d = rest.match(/^(.*?)(?<!\\) # (SKIP|TODO)\b ?(.*)$/i);
    const rawName = d ? d[1] : rest;
    tests.push({
      ok: !m[1],
      name: rawName.replace(/\\#/g, '#').replace(/\\\\/g, '\\').trim(),
      directive: d ? d[2].toUpperCase() : null,
      reason: d ? d[3].trim() : '',
    });
  }
  return tests;
}

export const isPlatformSkip = (t) => t.directive === 'SKIP' && /^UNAVAILABLE\b/.test(t.reason);

export function writeReceipt(file, receipt) {
  if (file) fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
}

export function requireSha(sha) {
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) throw new CannotCheck(`--sha must be a full 40-character commit sha, got ${sha ? `"${sha}"` : 'nothing'}`);
  return sha.toLowerCase();
}
