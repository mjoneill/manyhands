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
  let modelCalls = 0;
  let text = '';
  let stoppedBecause = 'answered';

  for (;;) {
    const out = await callModel(agent, convo, { ...opts, ...(granted.size ? { tools } : {}) });
    modelCalls += 1;
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

  return { text, hops, modelCalls, stoppedBecause, messages: convo };
}
