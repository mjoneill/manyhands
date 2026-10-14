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
import { spawnSync } from 'node:child_process';
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

/**
 * The commit is VERIFIED, not declared (review of the first build): `root` must be a git checkout whose HEAD is
 * the declared sha, with no modified TRACKED file, or the tool cannot attest what it tested and exits 2. Untracked
 * files (the suite's TAP, a receipt, the executor venv) are not part of the commit and do not count. Returns the
 * HEAD's tree hash, which both receipts carry so the pair can compare what was actually tested, not a label.
 */
export function verifyCheckout(root, declared) {
  const sha = requireSha(declared);
  if (!root) throw new CannotCheck('no --root given (the checkout that was tested)');
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new CannotCheck(`${root} is not a git checkout this tool can read (git ${args[0]}: ${(r.stderr || r.error?.message || '').trim()})`);
    return r.stdout;
  };
  const head = git('rev-parse', 'HEAD').trim().toLowerCase();
  if (head !== sha) throw new CannotCheck(`declared sha ${sha} is not the checked-out HEAD ${head} in ${root}`);
  // -z keeps porcelain's leading status columns intact (a trimmed " M path" would lose its first column).
  const dirty = git('status', '--porcelain', '-z', '--untracked-files=no').split('\0').filter(Boolean).map((l) => l.slice(3));
  if (dirty.length) throw new CannotCheck(`tracked files differ from ${sha}, so the tested tree is not that commit: ${dirty.join(', ')}`);
  return { sha, tree: git('rev-parse', 'HEAD^{tree}').trim() };
}
