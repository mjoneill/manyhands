/**
 * #1852 (supply) — the linker's settings, read from a TRACKED file: knowledge-linking.json at the repo root, beside
 * ceremony-schedule.json. Until now the linker ran only by hand, because its threshold was a command-line flag and giving it
 * to the extractor meant a launchd change. A tracked file travels with a deploy and is reviewed like code.
 *
 *   minScore      a search hit below this cosine is not proposed. The first 62 links were made at 0.6 (lowest stored: 0.601).
 *   perAssertion  at most this many links per claim, highest score first.
 *   k             how many hits the board's search is asked for per claim.
 *
 * #1851's rule stands: the threshold is config, never a hidden default. So NOTHING here has a fallback. A missing file, a
 * missing key, an unknown key or a bad value is a refusal that names what is wrong; the extractor then skips linking and its
 * finish post says links were not made and why. A run linked at a number nobody chose would look exactly like a real one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LINKING_CONFIG_FILE = fileURLToPath(new URL('../knowledge-linking.json', import.meta.url));

// The board's search answers at most 50 hits and clamps a larger k without saying so; a k above it would not be the k that ran.
const K_MAX = 50;
const show = (v) => (v === undefined ? 'nothing' : JSON.stringify(v));
const RULES = {
  minScore: (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? null : `minScore must be a number from 0 to 1, got ${show(v)}`),
  perAssertion: (v) => (Number.isInteger(v) && v >= 1 ? null : `perAssertion must be an integer of 1 or more, got ${show(v)}`),
  k: (v, doc) => {
    if (!Number.isInteger(v) || v < 1 || v > K_MAX) return `k must be an integer from 1 to ${K_MAX}, got ${show(v)}`;
    return Number.isInteger(doc.perAssertion) && v < doc.perAssertion ? `k must be at least perAssertion (${doc.perAssertion}), got ${show(v)}` : null;
  },
};

/** Validate a parsed config. Fails closed: one problem refuses the whole file, and a refusal carries no values. */
export function validateLinkingConfig(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: 'the linking config must be a JSON object with minScore, perAssertion and k' };
  const problems = [];
  for (const [key, rule] of Object.entries(RULES)) {
    if (!(key in doc)) { problems.push(`${key} is missing (it has no default)`); continue; }
    const p = rule(doc[key], doc);
    if (p) problems.push(p);
  }
  // A key nothing reads is refused, not carried: a misspelt minscore would validate, never apply, and look configured.
  const unknown = Object.keys(doc).filter((k) => !(k in RULES));
  if (unknown.length) problems.push(`unknown key${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => JSON.stringify(k)).join(', ')} (known: ${Object.keys(RULES).join(', ')})`);
  if (problems.length) return { ok: false, error: problems.join('; ') };
  return { ok: true, minScore: doc.minScore, perAssertion: doc.perAssertion, k: doc.k };
}

/** Read and validate the config file. Never throws: an unreadable or non-JSON file is a refusal naming the file. */
export function readLinkingConfig(file = LINKING_CONFIG_FILE) {
  const name = path.basename(file);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, error: `${name} cannot be read (${e.code || e.message})` }; }
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { return { ok: false, error: `${name} is not JSON (${e.message})` }; }
  const v = validateLinkingConfig(doc);
  return v.ok ? v : { ok: false, error: `${name}: ${v.error}` };
}
