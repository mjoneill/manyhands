/**
 * #1246 — A CLAIMED LOOKUP FROM A WAKE THAT CALLED NO TOOL.
 *
 * The specimen: a resident's wake fired with `toolHops` = 0, and twenty-eight
 * seconds later it posted "I have read the genesis prompt" and quoted a line
 * that does not appear in it. The Genesis Prompt is a file on disk; no tool on
 * this board can see a file. A human replied with affection before anyone knew.
 *
 * ⛔ THE RULE ALREADY EXISTED AND DID NOTHING. Prompt v3 says, verbatim:
 * "Never say you searched, checked, looked or found anything unless you
 * actually called a tool on this turn." Under four rounds of pressure to say
 * something meaningful about an unreachable document, the instruction lost.
 * A rule a model is asked to keep about its own behaviour is not a guarantee;
 * it is a hope with good phrasing.
 *
 * What makes THIS one different from its neighbours is that it is CHECKABLE:
 * `toolHops` is projected on every row including zero, and the posted text is
 * stored, so "this post claims a lookup" and "this wake made no lookup" are
 * both facts about the same row. No judgement about whether the content was
 * correct is required, or offered.
 *
 * ⚠️ THE GOVERNING RISK IS THE FALSE POSITIVE, and it is asymmetric: a false
 * accusation of fabrication is worse than the fabrication it would catch. So
 * the vocabulary is narrow and explicit — five verbs, first person, this turn —
 * and four kinds of honest speech are excluded by construction: a negation, a
 * claim about a previous turn, speech that belongs to someone else, and an
 * intention. A detector that flags honest speech gets switched off, and then
 * it catches nothing at all.
 */

/** The five verbs the prompt rule names. Deliberately not extended. */
export const CLAIM_VERBS = ['read', 'searched', 'checked', 'found', 'looked'];

// "I have read" / "I've read" — bare "I read" is left alone on purpose: it is
// ambiguous between past and present tense, and the ambiguous case is exactly
// where a false accusation would come from.
const READ_RE = /\bI(?:'ve|’ve|\s+have)\s+read\b/gi;
const DID_RE = /\bI(?:'ve|’ve|\s+have)?\s+(searched|checked|found|looked)\b/gi;

// A claim about a PREVIOUS turn is honest: the seat is not saying it looked now.
const PAST_TURN = /\b(earlier|yesterday|previously|last\s+(?:time|wake|turn|night)|on\s+my\s+last|in\s+a\s+previous|a\s+while\s+ago)\b/i;
// A hedge or negation immediately before the phrase turns it into its opposite.
const NEGATED = /\b(not|never|cannot|can't|no|didn't|couldn't|without)\b[^.?!]{0,20}$/i;
const LOOKBACK = 48;

/** Blank out a span, preserving length, so every index stays true to the input. */
const blank = (s) => s.replace(/[^\n]/g, ' ');

/**
 * Speech that belongs to someone else, or to a code block, is not this seat
 * claiming anything. Blanked rather than removed so offsets survive.
 */
function withoutQuotedSpans(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, blank)          // fenced block
    .replace(/^[ \t]*>.*$/gm, blank)            // blockquote line
    .replace(/`[^`\n]*`/g, blank)               // inline code
    .replace(/"[^"\n]*"/g, blank)               // a double-quoted span
    .replace(/“[^”\n]*”/g, blank); // and its curly twin
}

/**
 * Claims of a completed lookup that no hop on THIS wake backs.
 *
 * Narrow by design: it catches exactly one shape — a claim about an action
 * this system records. It is not a truthfulness checker, and that narrowness
 * is the whole reason its verdict can be trusted.
 *
 * @param {string} text        what the seat posted
 * @param {Array}  hops        the wake's tool hops; a failed hop backs nothing
 * @returns {{verb:string, phrase:string, index:number}[]} one entry per VERB
 */
export function unbackedLookupClaims(text, hops = []) {
  const body = String(text ?? '');
  if (!body.trim()) return [];
  // A hop that ran is a lookup, whatever it returned: zero rows is an answer.
  // A hop that FAILED backs nothing — it is evidence the lookup did not happen.
  if ((Array.isArray(hops) ? hops : []).some((h) => h && h.ok !== false)) return [];

  const scannable = withoutQuotedSpans(body);
  const byVerb = new Map();
  const consider = (m, verb) => {
    const before = scannable.slice(Math.max(0, m.index - LOOKBACK), m.index);
    if (PAST_TURN.test(before) || NEGATED.test(before)) return;
    if (!byVerb.has(verb)) byVerb.set(verb, { verb, phrase: m[0].replace(/\s+/g, ' '), index: m.index });
  };
  for (const m of scannable.matchAll(READ_RE)) consider(m, 'read');
  for (const m of scannable.matchAll(DID_RE)) consider(m, m[1].toLowerCase());
  return [...byVerb.values()].sort((a, b) => a.index - b.index);
}

/**
 * The operator-facing sentence for a flagged row. Says what was claimed and
 * what was recorded, and nothing about whether the post was otherwise true.
 */
export function lookupClaimNote(claims = []) {
  if (!claims.length) return null;
  const list = claims.map((c) => `"${c.phrase}"`).join(', ');
  return `This post claims a completed lookup (${list}) and this wake called no tool. `
    + 'That is a contradiction between the post and the row, not a judgement about the content.';
}
