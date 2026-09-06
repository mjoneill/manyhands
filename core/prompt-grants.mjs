/**
 * #1242 — A PROMPT THAT CANCELS THE GRANTS IT SITS BESIDE.
 *
 * The agent registry holds `toolGrants` and the current prompt on the same
 * record and has no opinion about their conjunction. On 2026-09-06 a seat was
 * granted two read tools at 13:47Z under a prompt whose closing instruction
 * was "say what you would need AND STOP"; the pair stood for thirty-one
 * observed minutes, and at 15:01Z the seat fabricated a lookup it had never
 * made. Two well-formed writes, no third thing checking their product.
 *
 * ⛔ NARROW ON PURPOSE. A fuzzy reading of "does this prompt discourage tools"
 * would nag on every honest prompt and get switched off — the same discipline
 * as #1246. This matches a handful of explicit STOP shapes and nothing else:
 * an instruction to stop before acting, to answer only from what was handed,
 * or to never use tools. A prompt that merely fails to mention tools is not a
 * contradiction; it is a prompt.
 *
 * ⭐ WARN, NEVER REFUSE. A hobbled seat is sometimes the experiment (a
 * graph-only seat was proposed on this very board). The write lands with the
 * contradiction NAMED on the node, so "which seats are told not to use what
 * they hold" is one query rather than reading prompts by eye.
 *
 * Pure: prompt text + grant list in, a finding or null out.
 */

/** The shapes that cancel a grant. Each carries the reason a reader will see. */
export const STOP_SHAPES = Object.freeze([
  { re: /\b(?:and|then)\s+stop\b/i, reason: 'tells the seat to stop instead of acting' },
  { re: /\banswer only from what you (?:are|were) (?:handed|given)\b/i, reason: 'tells the seat to answer only from what it was handed' },
  { re: /\byou know nothing about it beyond what is in this message\b/i, reason: 'tells the seat it knows nothing beyond the message' },
  { re: /\b(?:do not|don't|never)\s+(?:use|call)\b[^.\n]{0,40}?\btools?\b/i, reason: 'tells the seat not to use its tools' },
  { re: /\bwithout\s+(?:using|calling)\b[^.\n]{0,30}?\btools?\b/i, reason: 'tells the seat to work without its tools' },
]);

/**
 * @param {string} promptBody   the CURRENT prompt text
 * @param {string[]} grants     the seat's tool grants
 * @returns {{ phrase: string, reason: string } | null}  null when the pair is coherent
 */
export function promptGrantConflict(promptBody, grants) {
  const g = Array.isArray(grants) ? grants.filter(Boolean) : [];
  if (!g.length) return null;                       // nothing granted, nothing to cancel
  const text = String(promptBody ?? '');
  for (const { re, reason } of STOP_SHAPES) {
    const m = text.match(re);
    if (m) return { phrase: m[0], reason };
  }
  return null;
}

/** One sentence for a write response or a settings row. */
export function promptGrantWarning(conflict, grants) {
  if (!conflict) return null;
  const n = Array.isArray(grants) ? grants.length : 0;
  return `the prompt ${conflict.reason} ("${conflict.phrase}") while ${n} tool grant${n === 1 ? ' is' : 's are'} in force — the grants may be cancelled by the instruction. The write landed; this is a warning, not a refusal (#1242).`;
}
