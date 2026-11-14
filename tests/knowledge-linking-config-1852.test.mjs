/**
 * #1852 (supply) — the linker's threshold lives in a TRACKED file, knowledge-linking.json at the repo root (where
 * ceremony-schedule.json lives), so the extractor can link each run it publishes without a launchd change. #1851's rule
 * stands: the threshold is config, never a hidden default. So the loader has NO fallback: a missing key, a missing file or a
 * bad value is a refusal that names what is wrong, and the caller skips linking and says so.
 *
 * INTERFACE PINNED HERE:
 *   validateLinkingConfig(doc) → { ok:true, minScore, perAssertion, k } | { ok:false, error }
 *   readLinkingConfig(file = LINKING_CONFIG_FILE) → the same; an unreadable or non-JSON file is ok:false, never a throw
 *
 *   K1  the shipped file is valid and holds the values the first 62 links were made with: 0.6, 3, 8
 *   K2  every key is required: one missing is refused BY NAME (no default stands in for it)
 *   K3  a value of the wrong type or out of range is refused, naming the key and the value
 *   K4  a key nothing reads is refused by name: a misspelt minscore must not validate and look configured
 *   K5  a missing file, a file that is not JSON, and a JSON value that is not an object are each ok:false with the reason
 *   K6  LINKING_CONFIG_FILE is the tracked file at the repo root
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLinkingConfig, readLinkingConfig, LINKING_CONFIG_FILE } from '../core/knowledge-linking-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOOD = { minScore: 0.6, perAssertion: 3, k: 8 };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klc-1852-'));
process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const fileWith = (text) => { const f = path.join(dir, `c-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(f, text); return f; };

test('K1 the shipped file is valid and holds the values the first links were made with', () => {
  const c = readLinkingConfig();
  assert.deepEqual(c, { ok: true, minScore: 0.6, perAssertion: 3, k: 8 });
});

test('K2 every key is required: one missing is refused by name, and nothing stands in for it', () => {
  for (const key of Object.keys(GOOD)) {
    const { [key]: _gone, ...rest } = GOOD;
    const r = validateLinkingConfig(rest);
    assert.equal(r.ok, false, `${key} missing must refuse`);
    assert.match(r.error, new RegExp(`\\b${key}\\b`), `the refusal names ${key}: ${r.error}`);
    assert.equal(r.minScore, undefined, 'a refusal carries no values a caller could use by mistake');
  }
});

test('K3 a value of the wrong type or out of range is refused, naming the key and the value', () => {
  const bad = [
    [{ ...GOOD, minScore: 1.2 }, /minScore.*1\.2/],
    [{ ...GOOD, minScore: -0.1 }, /minScore.*-0\.1/],
    [{ ...GOOD, minScore: '0.6' }, /minScore.*"0\.6"/],
    [{ ...GOOD, minScore: null }, /minScore.*null/],
    [{ ...GOOD, perAssertion: 0 }, /perAssertion.*0/],
    [{ ...GOOD, perAssertion: 2.5 }, /perAssertion.*2\.5/],
    [{ ...GOOD, k: 2 }, /\bk\b.*2/],          // fewer candidates than links per claim
    [{ ...GOOD, k: 51 }, /\bk\b.*51/],        // the board answers at most 50 and would clamp it without saying
    [{ ...GOOD, k: '8' }, /\bk\b.*"8"/],
  ];
  for (const [doc, re] of bad) {
    const r = validateLinkingConfig(doc);
    assert.equal(r.ok, false, JSON.stringify(doc));
    assert.match(r.error, re, r.error);
  }
  // the edges are allowed: 0 and 1 are scores, and k may equal perAssertion
  assert.equal(validateLinkingConfig({ minScore: 0, perAssertion: 1, k: 1 }).ok, true);
  assert.equal(validateLinkingConfig({ minScore: 1, perAssertion: 50, k: 50 }).ok, true);
});

test('K4 a key nothing reads is refused by name', () => {
  const r = validateLinkingConfig({ ...GOOD, minscore: 0.7, note: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /"minscore"/); assert.match(r.error, /"note"/);
});

test('K5 a missing file, a file that is not JSON, and a non-object are each refused with the reason, never thrown', () => {
  const gone = readLinkingConfig(path.join(dir, 'absent.json'));
  assert.equal(gone.ok, false); assert.match(gone.error, /absent\.json/); assert.match(gone.error, /ENOENT|cannot be read/);
  const junk = readLinkingConfig(fileWith('{ minScore: 0.6 '));
  assert.equal(junk.ok, false); assert.match(junk.error, /not JSON/);
  for (const text of ['[0.6, 3, 8]', '0.6', 'null']) {
    const r = readLinkingConfig(fileWith(text));
    assert.equal(r.ok, false, text); assert.match(r.error, /object/);
  }
  assert.deepEqual(readLinkingConfig(fileWith(JSON.stringify(GOOD))), { ok: true, ...GOOD });
});

test('K6 LINKING_CONFIG_FILE is the tracked file at the repo root', () => {
  assert.equal(LINKING_CONFIG_FILE, path.join(ROOT, 'knowledge-linking.json'));
});
