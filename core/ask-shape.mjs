/**
 * core/ask-shape.mjs — #1251 item 2: POINT THE RECORD AT THE ASK, NOT THE ANSWER.
 *
 * #1246 records, per model call, whether the posted text claimed a lookup the
 * wake never made. #1251's argument is that reading those flags as a property
 * of the SEAT is blame with better tooling — the question worth answering is
 * "WHICH ASKS PRODUCE THIS": repeated requests for the same unreachable thing,
 * escalating rounds on one topic, a wake with no tool that could satisfy it.
 *
 * The specification is the sentence the seat it happened to wrote about
 * itself, which is sharper than anything written about it from outside:
 * "a seat that says 'I cannot reach X' for four rounds, then invents an answer."
 *
 * The card also names the condition that would REFUTE it, which is why this is
 * an instrument rather than a paragraph:
 *
 *     "If the flags cluster on ONE seat regardless of the ask, then it is a
 *      property of that seat's model and this card's premise is wrong."
 *
 * THE PROBLEM THAT SHAPES THIS FILE: measured 2026-09-07, the flag population
 * is EMPTY — 184 model calls, 131 of them with no tool hop, 79 of those
 * posting text, and not one stored flag. A group-by over zero rows returns a
 * clean, confident, meaningless zero, and it is INDISTINGUISHABLE from a
 * detector that is silently broken.
 *
 * So the report carries its own CONTROL. It runs the detector on four fixtures
 * whose answers are known in both directions, and it RECOMPUTES each row's
 * flag from that row's own stored text. A zero is reported as a finding only
 * when the controls pass; otherwise the report says the instrument is what
 * failed. That distinction is the whole point of the file: "nothing was found"
 * and "nothing could be found" are different facts, and a report that cannot
 * tell them apart is worse than no report.
 */

import { unbackedLookupClaims } from './lookup-claim.mjs';

/**
 * Fixtures with known answers, run on every report. Each names what it proves,
 * so a failure says which direction the detector broke in.
 */
export const CONTROL_FIXTURES = [
  {
    name: 'claims a lookup, no hop',
    text: 'I have read the genesis prompt and it says we are here to build.',
    hops: [],
    expect: 1,
    proves: "the detector can fire at all — the founding specimen's own shape",
  },
  {
    name: 'negated',
    text: 'I have not read the genesis prompt.',
    hops: [],
    expect: 0,
    proves: 'an honest denial is not an accusation',
  },
  {
    name: 'backed by a real hop',
    text: 'I have read the genesis prompt.',
    hops: [{ ok: true }],
    expect: 0,
    proves: 'a claim the wake actually backs is not flagged',
  },
  {
    name: 'quoted speech',
    text: 'She said "I have read the genesis prompt".',
    hops: [],
    expect: 0,
    proves: 'speech belonging to someone else is not this seat claiming anything',
  },
];

/**
 * Run the controls. `ok:false` means every count in the report is unreadable —
 * NOT that the counts are zero.
 */
export function runControls(detect = unbackedLookupClaims) {
  const results = CONTROL_FIXTURES.map((f) => {
    let got = null;
    let error = null;
    try {
      got = detect(f.text, f.hops).length;
    } catch (e) {
      error = e.message;
    }
    return { name: f.name, expect: f.expect, got, error, pass: error === null && got === f.expect, proves: f.proves };
  });
  return { ok: results.every((r) => r.pass), results };
}

/** A model call's tool hops, however the row spells "none". */
const hopsOf = (row) => (Array.isArray(row['scrum:toolHops']) ? row['scrum:toolHops'] : []);
const storedFlags = (row) => (Array.isArray(row['scrum:unbackedLookupClaims']) ? row['scrum:unbackedLookupClaims'] : []);

/** The model-call rows of a JSON-LD board document. */
export function modelCallRows(doc) {
  const graph = doc && Array.isArray(doc['@graph']) ? doc['@graph'] : [];
  return graph.filter((n) => n && n['scrum:unbackedLookupClaims'] !== undefined);
}

/**
 * The report. Grouped by (agent, wakeKind) because that is the join #1251
 * needs: the same ask shape reaching different seats is the comparison that
 * decides whether the flags are about the ask or about the seat.
 *
 * `recomputed` re-derives the flag from the row's own stored text. Where it
 * disagrees with `stored`, the RECORD is wrong — a flag computed once and
 * never again is a claim about the past that nothing re-checks.
 */
export function askShapeReport(doc, { detect = unbackedLookupClaims } = {}) {
  const controls = runControls(detect);
  const rows = modelCallRows(doc);
  const groups = new Map();
  const disagreements = [];
  const flagged = [];

  for (const row of rows) {
    const agent = row['scrum:agent'] || '(unattributed)';
    const wakeKind = row['scrum:wakeKind'] || '(none)';
    // JSON rather than a delimiter: an agent or wakeKind containing the
    // separator would otherwise merge two groups into one silently.
    const key = JSON.stringify([agent, wakeKind]);
    const g = groups.get(key)
      || { agent, wakeKind, calls: 0, noTool: 0, posted: 0, noToolPosted: 0, stored: 0, recomputed: 0 };
    g.calls++;

    const hops = hopsOf(row);
    const text = typeof row['scrum:postedText'] === 'string' ? row['scrum:postedText'] : '';
    const hasText = text.trim().length > 0;
    if (!hops.length) g.noTool++;
    if (hasText) g.posted++;
    if (!hops.length && hasText) g.noToolPosted++;

    const stored = storedFlags(row);
    if (stored.length) {
      g.stored++;
      flagged.push({
        agent,
        wakeKind,
        at: row['scrum:calledAt'] || null,
        verbs: stored.map((s) => s && s.verb).filter(Boolean),
      });
    }

    // Computed even when the controls fail, so a disagreement stays visible.
    let again = [];
    try {
      again = hasText ? detect(text, hops) : [];
    } catch {
      again = [];
    }
    if (again.length) g.recomputed++;
    if (Boolean(again.length) !== Boolean(stored.length)) {
      disagreements.push({ agent, at: row['scrum:calledAt'] || null, stored: stored.length, recomputed: again.length });
    }
    groups.set(key, g);
  }

  const totals = [...groups.values()].reduce((a, g) => ({
    calls: a.calls + g.calls,
    noTool: a.noTool + g.noTool,
    posted: a.posted + g.posted,
    noToolPosted: a.noToolPosted + g.noToolPosted,
    stored: a.stored + g.stored,
    recomputed: a.recomputed + g.recomputed,
  }), { calls: 0, noTool: 0, posted: 0, noToolPosted: 0, stored: 0, recomputed: 0 });

  return {
    controls,
    groups: [...groups.values()].sort((a, b) => b.calls - a.calls),
    totals,
    flagged,
    disagreements,
    verdict: verdictOf(controls, totals, groups),
  };
}

/**
 * THE LINE THIS FILE EXISTS FOR. A zero is three different facts and the
 * report must never collapse them:
 *
 *   controls failed        the INSTRUMENT is broken — the counts say nothing
 *   controls pass, n=0     genuinely no flags in this population
 *   flags exist            then, and only then, is clustering a question
 */
function verdictOf(controls, totals, groups) {
  if (!controls.ok) {
    return {
      code: 'INSTRUMENT_FAILED',
      says: 'The controls did not pass. Every count in this report is unreadable — this is NOT a finding of zero.',
    };
  }
  if (totals.stored === 0 && totals.recomputed === 0) {
    return {
      code: 'NO_FLAGS',
      says: `The detector is working (${controls.results.length}/${controls.results.length} controls) and found nothing `
        + `across ${totals.calls} model calls, ${totals.noToolPosted} of which posted text with no tool hop. `
        + "#1251's clustering question CANNOT be answered: there is no population to group. "
        + 'Item 1 was built on a principle, not on a rate, and the card should say so.',
    };
  }
  const seats = new Set([...groups.values()].filter((g) => g.stored || g.recomputed).map((g) => g.agent));
  if (seats.size === 1) {
    return {
      code: 'SINGLE_SEAT',
      says: `Every flag is on ONE seat (${[...seats][0]}). #1251 names this as its own refutation condition: `
        + 'if flags cluster on one seat regardless of the ask, the premise that the pressure is ours is wrong. '
        + 'Check whether that seat also sees a different distribution of asks before concluding either way.',
    };
  }
  return {
    code: 'MULTI_SEAT',
    says: `Flags span ${seats.size} seats. Compare the same wakeKind across seats: that column is the ask-vs-seat discriminator.`,
  };
}
