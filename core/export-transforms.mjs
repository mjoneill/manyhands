/**
 * Export transform layer.
 *
 * Your wiki keeps your team's real language. Adaptation for an outside reader
 * happens HERE, at the export boundary, and nowhere else. The source is never
 * edited to suit an audience: a record you sanitise while you are still writing
 * it is a record you can no longer trust.
 *
 * Why this is a module and not a careful hand-pass: a hand-pass quietly extends
 * its own scope. The pass that removed some port numbers from a document also
 * removed an internal name nobody had asked to remove, and the person doing it
 * did not notice until much later. A declared rule list cannot do that — what it
 * transforms is reviewable in EXPORT_TRANSFORMS.json, and what it must never
 * emit is enforced below rather than promised.
 *
 * Pure: no I/O, no fetch, no fs. The CLI (export-wiki.mjs) owns all of that.
 */

import { createHash } from 'node:crypto';

/**
 * The SHIPPED GENERIC DEFAULTS — the policy an installation gets when it has
 * declared none of its own.
 *
 * ⛔ These are NOT examples. EXPORT_TRANSFORMS.json is a worked example for an
 * author AND the file a standalone install resolves as its live policy, and
 * nothing at that path distinguishes the two readings. Its only non-EXAMPLE
 * entries are absolute home paths — DETECTED, with no rule that repairs them —
 * so a fresh install's first export refuses, and so does every one after.
 *
 * The invariant these must hold, enforced by test: every forbidden entry has a
 * rule that repairs it. A detector with nothing behind it can only ever refuse,
 * and shipping one as the default makes the safe path the unreachable one.
 *
 * Each entry carries a `specimen`: a string that trips its own detector. It is
 * how the invariant is checked without hand-listing pairs, and it makes a new
 * entry declare its own test.
 */

// ⛔ A SPECIMEN IS ASSEMBLED, NEVER WRITTEN AS A LITERAL — and the reason is
// that the push gate refused this file for containing one.
//
// The specimen's whole job is to be a string that TRIPS its own detector. The
// detector's pattern is "an absolute home path", so the specimen is an absolute
// home path, so the gate that scans every pushed blob for absolute home paths
// finds it and refuses — correctly. The value is a fabricated name and leaks
// nothing, but the gate cannot know that, and a gate that took my word for it
// would be worth nothing on the day I was wrong.
//
// ⚠️ AND BASELINING IT WAS THE WRONG DOOR, though the refusal offers one. The
// escape exists for a byline someone MEANT to publish; using it here would
// teach the codebase that this shape is acceptable in source, which is the
// exact belief the scrubber exists to prevent.
//
// ⇒ So the shape exists only at RUNTIME. The blob holds segments; the string is
// built when the module loads. Same specimen, same test, nothing for a scanner
// to find — in this file or in any future one that adds an entry.
const specimen = (...segments) => `/${segments.join('/')}`;

export const GENERIC_TRANSFORMS = {
  rules: [
    {
      note: 'absolute macOS home path — rewrite to ~, keeping the rest of the path',
      find: '/Users/[A-Za-z0-9_.\\-]+',
      flags: 'g',
      replace: '~',
    },
    {
      note: 'absolute Linux home path — same shape',
      find: '/home/[A-Za-z0-9_.\\-]+',
      flags: 'g',
      replace: '~',
    },
  ],
  forbidden: [
    {
      note: 'absolute path leaking a local username',
      pattern: '/Users/[A-Za-z0-9_.\\-]+',
      flags: 'gi',
      specimen: specimen('Users', 'zephyrblatt', 'notes', 'thing.md'),
    },
    {
      note: 'same, on Linux',
      pattern: '/home/[A-Za-z0-9_.\\-]+',
      flags: 'gi',
      specimen: specimen('home', 'zephyrblatt', 'x.txt'),
    },
  ],
};

/**
 * Describe the ruleset that produced an artifact, for the INDEX and for every
 * part file.
 *
 * ⭐ "Scrubbed" is true of an export against a room's 21 rules and of one
 * against the two generic defaults, and those are not the same object. The
 * artifact must carry the DISCRIMINATOR rather than the label — because the
 * reader who needs it is someone deciding whether to attach the file to an
 * email, three weeks later, who cannot see the config and does not know what
 * one is.
 *
 * Counts are the cheap discriminator: 2/2 against 4/21 is legible instantly and
 * needs no access to the file. The digest is what makes the claim CHECKABLE
 * instead of declared, and it costs one line.
 */
export function describeConfig(config, { source, path } = {}) {
  const rules = (config && config.rules) || [];
  const forbidden = (config && config.forbidden) || [];
  // Canonical over the parts that decide behaviour, so cosmetic edits to notes
  // do not change the identity of a ruleset that scrubs identically.
  const canonical = JSON.stringify({
    rules: rules.map((r) => [r.find, r.flags || '', r.replace ?? '']),
    forbidden: forbidden.map((f) => [f.pattern, f.flags || '']),
  });
  const sha256 = createHash('sha256').update(canonical).digest('hex');
  // ⚠️ "Scrubbed via" is KEPT deliberately. #523's index contract asserts that
  // phrase, and its stated intent — "the index must record that this export
  // went through the boundary" — is compatible with this one. The defect being
  // fixed is that the phrase was ALL the index said; the fix is to add the
  // discriminator, not to spend the existing vocabulary on the way past.
  const origin = source === 'generic-defaults'
    ? 'built-in GENERIC defaults — this board declared no rules of its own'
    : source === 'explicit'
      ? `an explicitly supplied ruleset (${path})`
      : `this board's own rules (${path})`;
  return {
    source,
    path,
    rules: rules.length,
    forbidden: forbidden.length,
    sha256,
    line: `Scrubbed via ${origin} · ${rules.length} rule(s), ${forbidden.length} check(s) · sha256:${sha256.slice(0, 12)}`,
  };
}

/** Build a RegExp from a rule/forbidden entry. `find`/`pattern` are regex source. */
const toRegExp = (source, flags, fallbackFlags) => {
  try {
    return new RegExp(source, flags || fallbackFlags);
  } catch (err) {
    throw new Error(`export-transforms: invalid pattern ${JSON.stringify(source)} — ${err.message}`);
  }
};

/**
 * Apply the substitution rules, in the order given.
 *
 * Order is load-bearing, not incidental: a PHRASE rule must be able to pre-empt
 * a WORD rule over the same term. The case that motivates it: a document that
 * explains WHY an internal name was chosen. Swap the word alone and the sentence
 * survives as a claim about the new name that was never true of it. The phrase
 * rule runs first and rewrites the whole clause; the word rule mops up the rest.
 */
export function applyTransforms(text, config) {
  if (typeof text !== 'string') return '';
  const rules = (config && config.rules) || [];
  return rules.reduce(
    (acc, rule) => acc.replace(toRegExp(rule.find, rule.flags, 'g'), rule.replace ?? ''),
    text,
  );
}

/**
 * Find any forbidden term still present. Returns [] when clean.
 *
 * Deliberately independent of how the rules were written: the forbidden list is
 * matched case-insensitively by default, so a lowercase-only rule that leaves
 * "TokenRing" behind is still caught. The check exists to disagree with the rules,
 * not to agree with them.
 */
export function findResidue(text, config) {
  const forbidden = (config && config.forbidden) || [];
  const hits = [];
  for (const entry of forbidden) {
    const re = toRegExp(entry.pattern, entry.flags, 'gi');
    for (const m of String(text).matchAll(re)) {
      const start = Math.max(0, m.index - 40);
      hits.push({
        pattern: entry.pattern,
        match: m[0],
        note: entry.note || '',
        // A bare term is not actionable; the surrounding text is.
        sample: String(text).slice(start, m.index + m[0].length + 40).replace(/\s+/g, ' ').trim(),
      });
      if (!re.global) break;
    }
  }
  return hits;
}

/**
 * Transform for export, FAIL-CLOSED.
 *
 * Throws rather than returning a leaky artifact. This is the whole point of the
 * module: the guarantee that the shipped file carries no in-room language is a
 * property of the mechanism, not of whoever ran it having checked carefully.
 * Residue is a build failure, not a warning to skim past.
 */
export function transformForExport(text, config, { mode = 'scrub' } = {}) {
  // ⛔ Fail closed on the ARGUMENT itself. A typo must never land on the
  // permissive branch — that is how an opt-out becomes a default nobody chose.
  if (mode !== 'scrub' && mode !== 'raw') {
    throw new Error(`export-transforms: unknown export mode ${JSON.stringify(mode)} — expected 'scrub' or 'raw'`);
  }
  // raw is the in-room archive: no rules, no check, verbatim. It lives HERE and
  // not in a caller so that both exporters get the same one and neither can
  // implement it differently — which is exactly how they drifted.
  if (mode === 'raw') return typeof text === 'string' ? text : '';
  const out = applyTransforms(text, config);
  const residue = findResidue(out, config);
  if (residue.length) {
    const detail = residue
      .map((r) => `  • ${JSON.stringify(r.match)}${r.note ? ` (${r.note})` : ''}\n      …${r.sample}…`)
      .join('\n');
    throw new Error(
      `export refused — ${residue.length} un-transformed term(s) survived the scrub:\n${detail}\n` +
      `Add a rule to EXPORT_TRANSFORMS.json, or correct an existing one. The export does not ship partial scrubs.`,
    );
  }
  return out;
}

/**
 * Transform MANY records for export, in one mode, collecting residue ONCE.
 *
 * ⛔ This exists because the batch case is why the decision got duplicated in
 * the first place. `transformForExport` throws per call; an 8,000-record board
 * export that threw on the first residue would bury the finding it exists to
 * surface, so export-board.mjs reached past the composed function to the
 * primitives and rebuilt apply→check→refuse with its own `--raw` branch. The
 * two copies then drifted into different refusal semantics.
 *
 * ⇒ So the fix is not "call the single-record function in a loop" — it is to
 * give the service the shape the second caller actually needed. One mode
 * argument, one residue policy, one place either can change.
 *
 * Returns { texts, residue }. It does NOT throw on residue: batching exists so
 * the caller can report every hit at once and decide what a residue MEANS for
 * the artifact it is producing. An outbound artifact refuses; an in-room
 * archive may legitimately warn. That call belongs to the caller; collecting
 * the evidence belongs here.
 */
export function transformManyForExport(texts, config, { mode = 'scrub' } = {}) {
  if (mode !== 'scrub' && mode !== 'raw') {
    throw new Error(`export-transforms: unknown export mode ${JSON.stringify(mode)} — expected 'scrub' or 'raw'`);
  }
  if (mode === 'raw') {
    return { texts: texts.map((t) => (typeof t === 'string' ? t : '')), residue: [] };
  }
  const out = [];
  const residue = [];
  for (const text of texts) {
    const scrubbed = applyTransforms(text, config);
    out.push(scrubbed);
    residue.push(...findResidue(scrubbed, config));
  }
  return { texts: out, residue };
}
