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
export function transformForExport(text, config) {
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
