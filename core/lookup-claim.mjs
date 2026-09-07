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

/**
 * #1246 sibling — THE FUTURE TENSE, which is the shape that actually dominates.
 *
 * `unbackedLookupClaims` catches "I have read". This catches "I will search",
 * from a wake that then ends. ⛔ In a one-shot wake there IS no next turn, so
 * an announced lookup is not an intention a seat can keep — it is a promise
 * the architecture makes impossible, delivered in the register of cooperation.
 * The asker waits for a follow-up that cannot come. That is worse than a
 * refusal, which at least ends the exchange honestly.
 *
 * ⚠️ Narrow in the same way and for the same reason: only LOOKUP verbs, only
 * first person, and never inside quoted or fenced text. "I will remember that"
 * and "I will not guess" are ordinary speech and must pass untouched.
 *
 * @returns {{phrase:string}|null}
 */
const LOOKUP_VERB = '(?:search|look|check|read|find)';
const ANNOUNCE = [
  new RegExp(String.raw`\bI(?:'ll|\u2019ll|\s+will)\s+(?:go\s+and\s+|now\s+)?` + LOOKUP_VERB + String.raw`\b`, 'i'),
  new RegExp(String.raw`\bI(?:'m|\u2019m|\s+am)\s+going\s+to\s+` + LOOKUP_VERB + String.raw`\b`, 'i'),
  new RegExp(String.raw`\bLet\s+me\s+` + LOOKUP_VERB + String.raw`\b`, 'i'),
  new RegExp(String.raw`\bI(?:'m|\u2019m|\s+am)\s+(?:now\s+)?(?:searching|looking|checking|reading)\b`, 'i'),
];

export function announcedLookup(text) {
  const body = String(text ?? '');
  if (!body.trim()) return null;
  const scannable = withoutQuotedSpans(body);
  for (const re of ANNOUNCE) {
    const m = scannable.match(re);
    if (m) return { phrase: m[0].replace(/\s+/g, ' ') };
  }
  return null;
}

/**
 * The one thing the loop says back. Not a scolding and not a re-statement of
 * the rule that already failed — a MOVE, with both roads named: do it now, or
 * decline in a way that ends the exchange. #1251: a usable exit has to be
 * something the seat can DO, not another sentence telling it that it may.
 */
export function performOrDeclineNudge(phrase) {
  return `You said: "${phrase}" — but this turn is ending and there is no later turn in which to do it. `
    + 'You have the tools right now. Either CALL one on this turn and answer from what comes back, '
    + 'or say plainly that you cannot answer and why — beginning, as always, with `REPLY:`, or the person waiting will get silence instead of your reason (#1254). Both are fine. '
    + 'Announcing a lookup you do not make is the one thing that is not, '
    + 'because the person is left waiting for a reply that will never come.';
}
