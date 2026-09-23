/**
 * #1196 slice A2 — THE CALL / EXECUTE / CALL LOOP.
 *
 * A colleague on this board could talk and could not look. The adapter now
 * carries tools and reads calls back; this closes the circuit, so a request to
 * read a card is answered with a card.
 *
 * ⛔ WHAT THIS IS NOT FOR. It does not make answers correct, and nothing here
 * should be read as expecting that. A small model handed the right rows still
 * narrated over them on a frozen set: 4 verdict matches of 14, and 0 of 3
 * abstentions on cases with no answer. Three prompt revisions in one night
 * moved the failure's SHAPE three times and removed it zero times.
 *
 * ⭐ WHAT IT IS FOR. Every hop is recorded — the tool, its arguments, whether it
 * ran, and HOW MANY ROWS came back — and that record travels with the answer.
 * Before this, a claim had no referent and could not be checked by anyone. Now
 * a reader downstream can ask the only question that has ever separated a
 * grounded answer from a fluent one: did those rows come back, and do they say
 * that. Zero rows and a confident answer is the exact pair we could not see.
 *
 * Pure by construction: the model and the tools both arrive as functions, so
 * the whole contract is testable without a GPU or a board.
 */

/** The default ceiling. Small models ask for the same thing repeatedly. */
export const DEFAULT_MAX_HOPS = 4;

const nameOf = (t) => t?.function?.name ?? t?.name ?? null;

/** Count what a tool returned, for whichever shape it returned it in. */
function rowsIn(result) {
  if (result == null) return 0;
  if (Array.isArray(result)) return result.length;
  for (const k of ['rows', 'results', 'cards', 'items', 'bindings']) {
    if (Array.isArray(result[k])) return result[k].length;
  }
  return 1;
}

/**
 * Run one wake to completion.
 *
 * @param {object}   agent      passed through to callModel unchanged
 * @param {Array}    messages   the opening turn
 * @param {Array}    tools      the GRANT: what this colleague may reach. Empty
 *                              means no tools are offered at all — not an empty
 *                              list offered, which is a different claim.
 * @param {Function} execute    async (name, args) => result; only ever called
 *                              with a granted name and parsed arguments
 * @param {Function} callModel  async (agent, messages, opts) => {text, toolCalls}
 * @param {number}   maxHops    ceiling on tool rounds
 * @returns {{text, hops, modelCalls, stoppedBecause, messages}}
 */
export async function runToolLoop({ agent, messages, tools = [], execute, callModel, maxHops = DEFAULT_MAX_HOPS, opts = {} }) {
  const granted = new Set((tools || []).map(nameOf).filter(Boolean));
  const convo = [...messages];
  const hops = [];
  // #1294 — USAGE IS SUMMED ACROSS HOPS, and the sum is the point.
  //
  // This loop returned {text, hops, modelCalls, stoppedBecause, messages} and
  // dropped every call's usage. The guest loop records `usage: result.usage`
  // from this return, so its ledger rows carried no tokens, cost priced to 0,
  // and `spent >= budget` could never be true — 145 rows for one seat while
  // OpenRouter billed $2.05 over the same window.
  //
  // ⭐ It also explains the asymmetry that made it findable: the search reader
  // calls callModel DIRECTLY and its rows carry tokens correctly. One adapter,
  // two callers, opposite outcomes.
  //
  // ⚠️ SUMMED, not last-wins: one wake is N model calls (~3 per wake measured,
  // against maxHops 8), so reporting only the final hop would under-bill by
  // roughly the factor that makes this expensive — and would look correct in
  // any single-hop test.
  //
  // ⛔ NULL WHEN NOTHING REPORTED, never {promptTokens: 0}: a zero here would
  // price the wake as free and be indistinguishable from a genuinely free
  // call, which is the defect one layer up. An unmeasured zero is not a value.
  //
  // ⛔ #1296 — AND THE ABSENCE IS PER-CATEGORY, not per-call. The first version
  // of this seeded all four categories at 0 behind a single `sawUsage` flag, so
  // a provider that reported prompt and completion and said NOTHING about
  // reasoning or caching produced `reasoningTokens: 0` — a confident claim that
  // the model did not think, and a perfect cache miss, neither of which anyone
  // measured. That is the same unmeasured zero this comment warns about, one
  // level down, and it was found by an assertion rather than by re-reading.
  const usage = {};
  const anomalies = new Set();   // #1352
  const seen = new Set();
  const addUsage = (u) => {
    if (!u || typeof u !== 'object') return;
    for (const k of ['promptTokens', 'completionTokens', 'reasoningTokens', 'cachedPromptTokens']) {
      // ⛔ `Number(null)` is 0 and `Number.isFinite(0)` is true, so a numeric
      // guard alone reads an EXPLICIT null as a measured zero. Every adapter
      // reports an uncounted category as null, which is precisely the case
      // this must not convert into a value.
      const raw = u[k];
      if (raw == null || raw === '') continue;
      const v = Number(raw);
      if (Number.isFinite(v)) { usage[k] = (usage[k] ?? 0) + v; seen.add(k); }
    }
  };
  let modelCalls = 0;
  let text = '';
  let stoppedBecause = 'answered';

  for (;;) {
    let out;
    try { out = await callModel(agent, convo, { ...opts, ...(granted.size ? { tools } : {}) }); }
    catch (e) {
      // #1435 — A FAILED HOP DOES NOT ERASE THE HOPS BEFORE IT. The error
      // leaves this loop with the wake's usage SUMMED (earlier hops + the
      // failed one, when the adapter attached it) and the hops it made, so the
      // failure row can say what the wake spent and fetched before it died.
      if (e && typeof e === 'object') {
        addUsage(e.usage);
        e.usage = seen.size ? { ...usage } : (e.usage ?? null);
        e.hops = hops; e.modelCalls = modelCalls + 1;
      }
      throw e;
    }
    modelCalls += 1;
    addUsage(out.usage);   // #1294 — every hop is billed, including the last
    for (const a of out.anomalies ?? []) anomalies.add(a);   // #1352 — an anomaly on any hop is on the wake
    text = out.text ?? '';
    const calls = Array.isArray(out.toolCalls) ? out.toolCalls : [];
    if (!calls.length) { stoppedBecause = 'answered'; break; }

    // The ceiling is counted in HOPS, not in calls, and when it bites the
    // reason is named. A truncated exploration reported as a finished one is
    // the same defect this whole card exists to remove, one layer up.
    if (hops.length >= maxHops) { stoppedBecause = 'max-hops'; break; }

    // The assistant's tool-calling turn stays in the transcript; a model that
    // cannot see it asked for asks again.
    convo.push({ role: 'assistant', content: out.text ?? '', tool_calls: calls });

    for (const call of calls) {
      if (hops.length >= maxHops) { stoppedBecause = 'max-hops'; break; }
      const hop = { id: call.id ?? null, name: call.name ?? null, arguments: call.arguments ?? null, ok: false, rowCount: 0 };
      let content;

      if (call.argumentsError || call.arguments == null) {
        // ⛔ Never call a tool with arguments we could not read. Guessing here
        // is how a colleague deletes the wrong thing.
        hop.error = call.argumentsError || 'arguments could not be read as JSON';
        content = `refused: ${hop.error}`;
      } else if (!granted.has(call.name)) {
        // Named, always. A silent refusal is indistinguishable from a tool that
        // ran and found nothing, and the model cannot correct what it cannot see.
        hop.error = `tool ${JSON.stringify(call.name)} is not granted to this seat; granted: ${[...granted].join(', ') || '(none)'}`;
        content = `refused: ${hop.error}`;
      } else if (typeof execute !== 'function') {
        hop.error = 'no tool executor is wired on this loop';
        content = `refused: ${hop.error}`;
      } else {
        try {
          const result = await execute(call.name, call.arguments);
          hop.ok = true;
          hop.rowCount = rowsIn(result);
          content = typeof result === 'string' ? result : JSON.stringify(result);
        } catch (e) {
          // A failing tool is a fact the colleague should be told, not a crash
          // that loses the whole wake.
          hop.error = String(e?.message ?? e);
          content = `error: ${hop.error}`;
        }
      }

      hops.push(hop);
      convo.push({ role: 'tool', name: call.name ?? 'unknown', tool_call_id: call.id ?? null, content });
    }
    if (stoppedBecause === 'max-hops') break;
  }

  // #1444 — THE CEILING EARNS ONE CLOSING CALL. Breaking out at max-hops left
  // the wake holding the last tool-calling turn's text, which is almost always
  // empty (that turn asked for a tool instead of answering): 88 of 1,116
  // resident wakes (7.9%) posted NOTHING after 4–7 paid calls. So when the
  // ceiling bites with nothing said, the seat gets one call WITHOUT tools, the
  // transcript so far, and one line saying why. It is not a hop and runs no
  // tool; it is counted and billed like any call.
  let finalTurn = null;
  if (stoppedBecause === 'max-hops' && !String(text ?? '').trim()) {
    // A provider rejects a transcript whose tool_calls lack results, and a
    // ceiling hit mid-turn leaves the unrun calls unanswered — say so.
    const answered = new Set(convo.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
    for (const m of convo) {
      if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
      for (const c of m.tool_calls) {
        if (c?.id == null || answered.has(c.id)) continue;
        convo.push({ role: 'tool', name: c.name ?? 'unknown', tool_call_id: c.id, content: 'skipped: the lookup ceiling was reached before this ran' });
        answered.add(c.id);
      }
    }
    convo.push({ role: 'user', content: 'You have used your lookups for this wake — the ceiling is reached, and no more tools will run. '
      + 'Answer now from what you found, and say plainly what you could not check. If nothing here calls for you, reply NO_REPLY.' });
    let fin;
    try { fin = await callModel(agent, convo, { ...opts }); }   // ⛔ no `tools`: nothing more can be looked up
    catch (e) {
      // #1435 — the closing call's failure carries the wake's usage and hops, like any hop's.
      if (e && typeof e === 'object') {
        addUsage(e.usage);
        e.usage = seen.size ? { ...usage } : (e.usage ?? null);
        e.hops = hops; e.modelCalls = modelCalls + 1;
      }
      throw e;
    }
    modelCalls += 1;
    addUsage(fin.usage);
    for (const a of fin.anomalies ?? []) anomalies.add(a);
    text = fin.text ?? '';
    // Only "did it say anything". Whether what it said is a DECLINE is the
    // publish gate's call (#1428's textHasStandaloneSentinel, in guest-loop),
    // so the telemetry can never disagree with what the room actually saw.
    finalTurn = String(text).trim() ? 'answered' : 'empty';
  }

  return { text, hops, modelCalls, stoppedBecause, ...(finalTurn ? { finalTurn } : {}), messages: convo, usage: seen.size ? usage : null, anomalies: [...anomalies] };
}
