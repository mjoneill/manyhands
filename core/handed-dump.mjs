/**
 * #1558/#1567 PC5 — capture EXACTLY what a wake hands the model, at every
 * dispatch: the first call, every tool hop, every continuation and retry
 * (a reviewer 03:07Z: the loop can append context after buildMessages, so the
 * initial messages alone are not the evidence).
 *
 * Harness-only. OFF unless SCRUM_HANDED_DUMP names a file. One JSON line per
 * dispatch, written BEFORE the call goes out, so a call that hangs or fails is
 * still on record. Credentials never reach the file: the adapter adds the API
 * key after this wrapper, and option keys that look like secrets are dropped
 * here as well, with their NAMES recorded so the omission is visible.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const SECRETISH = /key|token|secret|authori[sz]ation|password|cookie/i;

function scrub(obj) {
  const kept = {};
  const dropped = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (SECRETISH.test(k)) dropped.push(k);
    else kept[k] = v;
  }
  return { kept, dropped };
}

/** Position of this dispatch: how many tool results the model has already been handed. */
export function dispatchPosition(messages = []) {
  const toolResults = messages.filter((m) => m && m.role === 'tool').length;
  return toolResults === 0 ? 'initial' : `after-tool-result-${toolResults}`;
}

export function makeHandedCapture({ file, now = () => new Date().toISOString(), wakeId = null }) {
  let seq = 0;
  return function wrap(callModel) {
    return async function capturedCallModel(agent, messages, opts = {}) {
      const { kept: options, dropped } = scrub(opts);
      const { tools = null, ...rest } = options;
      const handed = { messages, tools };
      const body = JSON.stringify(handed);
      const row = {
        seq: ++seq,
        wakeId,
        at: now(),
        position: dispatchPosition(messages),
        model: { id: agent?.id ?? null, model: agent?.model ?? null, provider: agent?.provider ?? null },
        options: rest,
        droppedOptionKeys: dropped,
        sha256: createHash('sha256').update(body).digest('hex'),
        handed,
      };
      fs.appendFileSync(file, JSON.stringify(row) + '\n');
      return callModel(agent, messages, opts);
    };
  };
}
