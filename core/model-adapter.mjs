/**
 * core/model-adapter.mjs — #1198 (piece 2 of #1196). THE ONLY PLACE MANYHANDS
 * TALKS TO A MODEL.
 *
 * The board owner ruled on 2026-09-05 (#1196, #1218) that manyhands driving a
 * model directly is the thing to build, and that standing up another agent in a
 * different harness is not: borrowing that harness's gateway would have tested
 * the other harness. This file is that ruling carried out.
 *
 * ── VENDORED, NOT DESIGNED ──────────────────────────────────────────────────
 * The shape is ported, not reinvented, from a 424-line model abstraction in a
 * sibling project on this machine that has been in daily use: the backend dispatch,
 * the runaway budget with its measured constants, the courtesy unload, and the
 * `streamGenerate` indirection that exists so the loop is testable. #1067 §6
 * called it vendorable, not designable, and re-deriving it would have cost the
 * lesson that produced it.
 *
 * ⛔ THE RUNAWAY BUDGET IS NOT `maxTokens`, and the distinction is the whole
 * point. `maxTokens` is sized for the LARGEST LEGITIMATE ANSWER, so a
 * repetition loop stays under it and runs to ~32,000 tokens before anything
 * notices (#58, measured on out-of-distribution input). The budget is sized for
 * THIS PROMPT: 3× the prompt, floor 2000. A runaway is a property of the INPUT
 * and recurs identically on retry, which is why it is a distinct typed error
 * from a malformed answer — one is worth retrying and the other never is.
 *
 * ── SAMPLING BELONGS TO THE ROLE, NOT THE MODEL ─────────────────────────────
 * A judging agent runs at temperature 0 with a pinned seed so a run can be
 * re-run; a challenging agent runs warm. Same model, different knobs. ⭐ `seed`
 * is what makes #1203's decorrelation experiment an experiment rather than an
 * anecdote — without it, "we ran it twice and got different answers" says
 * nothing about the models.
 */

/** Measured in #58, kept verbatim from the vendored source. */
export const RUNAWAY_RATIO = 3.0;
export const RUNAWAY_FLOOR_TOKENS = 2000;
export const DEFAULT_MAX_TOKENS = 32768;
export const DEFAULT_NUM_CTX = 32768;
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/**
 * Largest plausible output for a prompt of this size, in tokens.
 * Ported unchanged — the constants are evidence, not preferences.
 */
export function runawayBudget(promptTokens) {
  return Math.min(
    DEFAULT_MAX_TOKENS,
    Math.max(RUNAWAY_FLOOR_TOKENS, Math.floor(RUNAWAY_RATIO * promptTokens)),
  );
}

/**
 * Rough token count. Deliberately crude and deliberately NOT a tokenizer: the
 * budget is an order-of-magnitude guard against a repetition loop, and a real
 * tokenizer would add a dependency and a per-model branch to a number that
 * only has to be roughly right. Named so nobody mistakes it for precision.
 */
export const approxTokens = (s) => Math.ceil(String(s ?? '').length / 4);

/**
 * Generation aborted for exceeding its plausible-output budget.
 *
 * Distinct from a parse failure ON PURPOSE: the caller needs to tell "the model
 * rambled and we stopped it" apart from "the model answered and the answer was
 * malformed". A runaway is a property of the input and will recur identically
 * on retry; a malformed answer may not.
 */
export class RunawayGenerationError extends Error {
  constructor(produced, budget, promptTokens) {
    super(`runaway generation aborted: produced ${produced} tokens against a budget of ${budget} `
      + `for a ${promptTokens}-token prompt (ratio ${RUNAWAY_RATIO}, floor ${RUNAWAY_FLOOR_TOKENS}). `
      + 'This input is pathological, not merely large.');
    this.name = 'RunawayGenerationError';
    this.code = 'RUNAWAY';
    this.produced = produced; this.budget = budget; this.promptTokens = promptTokens;
  }
}

/**
 * An assertion about the RESPONSE failed — the call succeeded at the transport
 * level and the result is still not usable. Carries which assertion, so the
 * caller is never left inferring it from a message.
 */
export class ModelAssertionError extends Error {
  constructor(assertion, detail, meta = {}) {
    super(`model response failed assertion "${assertion}": ${detail}`);
    this.name = 'ModelAssertionError';
    this.code = 'ASSERTION';
    this.assertion = assertion;
    Object.assign(this, meta);
  }
}

/**
 * The provider refused, and the refusal is FINAL — retrying cannot help.
 *
 * ⛔ `body` is always carried. #838/#840: a dead provider returned 410 Gone
 * thirteen times with a dated plain-English end-of-life notice in the body, and
 * the retry logic consumed it as if it were 429 Busy. Nobody read the body for
 * weeks because nothing kept it. A status code without its body is a refusal
 * with its explanation thrown away.
 */
/**
 * ⚠️ THE PROVIDER'S OWN WORDS BELONG IN THE MESSAGE. Carried on `.body` alone
 * they are invisible: what gets read is what gets printed, and a reader shown
 * "refused (400): client error 400" learns nothing and goes looking in the
 * wrong place. Found live when a tools-bearing request met a model with no
 * tools capability — the 400's body said precisely that and the message did
 * not. Fixed here rather than per protocol so every one of them gains it.
 */
function refusalDetail(body) {
  const raw = typeof body === 'string' ? body : (body == null ? '' : JSON.stringify(body));
  const text = raw.trim();
  if (!text) return '';
  // Prefer the provider's own message field when there is one; the rest of a
  // JSON envelope is noise in an error line.
  let said = text;
  try {
    const o = JSON.parse(text);
    said = o?.error?.message ?? o?.error ?? o?.message ?? o?.detail ?? o?.title ?? text;
    if (typeof said !== 'string') said = JSON.stringify(said);
  } catch { /* not JSON: the text IS the message */ }
  said = String(said).replace(/\s+/g, ' ').trim();
  return said ? ` — provider said: ${said.slice(0, 300)}${said.length > 300 ? '…' : ''}` : '';
}

export class ModelRefusedError extends Error {
  constructor(status, reason, body, meta = {}) {
    super(`model provider refused (${status}): ${reason}${refusalDetail(body)}`);
    this.name = 'ModelRefusedError';
    this.code = 'REFUSED';
    this.status = status; this.reason = reason; this.body = body;
    Object.assign(this, meta);
  }
}

/**
 * What to do about a status, as data rather than as a chain of ifs — so the
 * policy can be read, tested and cited without executing it (#838/#840).
 *
 *   retry   — transient; back off and try again
 *   retire  — the MODEL is gone. Mark it retired in the registry and refuse;
 *             retrying a 410 forever is what #838 actually did.
 *   refuse  — final, and the message must name WHICH failure it was
 */
export function classifyStatus(status) {
  if (status === 429) {
    return { action: 'retry', reason: 'rate limited' };
  }
  if (status >= 500 && status <= 599) {
    return { action: 'retry', reason: `provider error ${status}` };
  }
  if (status === 410) {
    return {
      action: 'retire', reason: 'the model is GONE (410). Retiring it in the registry rather than '
        + 'retrying: a 410 body is an end-of-life notice, and this exact case was consumed as a '
        + 'busy signal thirteen times (#838)',
    };
  }
  if (status === 404) {
    return {
      action: 'refuse', reason: 'not found — say WHICH: an unknown model name, or a wrong base '
        + 'URL/path. Both return 404 and they need different fixes',
    };
  }
  if (status === 401 || status === 403) {
    return { action: 'refuse', reason: 'not authorised — name the key REFERENCE that was used, never the key' };
  }
  if (status >= 400) return { action: 'refuse', reason: `client error ${status}` };
  return { action: 'ok', reason: '' };
}

/** Sampling knobs, per call. Absent keys are left to the provider's default. */
const SAMPLING = ['temperature', 'topP', 'topK', 'repetitionPenalty', 'seed', 'stop', 'maxTokens', 'keepAlive'];

/** Ollama's option names differ from ours; map explicitly rather than guess. */
const OLLAMA_OPTION = {
  temperature: 'temperature', topP: 'top_p', topK: 'top_k',
  repetitionPenalty: 'repeat_penalty', seed: 'seed', stop: 'stop', maxTokens: 'num_predict',
};

function samplingOf(opts = {}) {
  const out = {};
  for (const k of SAMPLING) if (opts[k] !== undefined && opts[k] !== null) out[k] = opts[k];
  return out;
}

/**
 * ⚠️ INDIRECTION ON PURPOSE, ported from the vendored source's `_stream_generate`
 * comment: "so the loop is testable". Every network call goes through here, so a
 * test drives all three protocols against a stub without a live model, a mock
 * library, or a running GPU. Replaceable per call via `opts.transport`.
 */
export async function defaultTransport(request) {
  const res = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: request.signal,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep the raw body */ }
  return { status: res.status, body: json, rawBody: text };
}

/** ─── protocol adapters ────────────────────────────────────────────────────
 * Each one only knows how to SHAPE a request and READ a response. None of them
 * decides retries, assertions or budgets — one policy, applied once, below.
 */
/**
 * #1196 slice A — TOOL CALLS, normalised across protocols.
 *
 * The wire shapes disagree: Ollama hands back `arguments` as an object, the
 * OpenAI shape as a JSON STRING. A caller that has to know which one it is
 * talking to in order to read a tool call has no tool channel, it has two.
 *
 * ⛔ Unparseable arguments are REPORTED, never dropped. A tool call quietly
 * discarded reads downstream as a call the model never made, which is the one
 * failure that cannot be noticed from the outside.
 */
function readToolCalls(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((c, i) => {
    const fn = c?.function ?? c ?? {};
    const a = fn.arguments;
    let args = null; let argumentsError = null;
    if (a === undefined || a === null) args = {};
    else if (typeof a === 'object') args = a;
    else {
      try { args = JSON.parse(a); }
      catch (e) { args = null; argumentsError = `arguments are not valid JSON: ${e.message}`; }
    }
    return {
      id: c?.id ?? `call_${i}`,
      name: fn.name ?? null,
      arguments: args,
      ...(argumentsError ? { argumentsError } : {}),
    };
  });
}

const PROTOCOLS = {
  /** Ollama's native /api/chat. */
  'ollama-native': {
    request(model, messages, s, grants = {}) {
      const options = { num_ctx: DEFAULT_NUM_CTX };
      for (const [ours, theirs] of Object.entries(OLLAMA_OPTION)) {
        if (s[ours] !== undefined) options[theirs] = s[ours];
      }
      const body = { model, messages, stream: false, options };
      // A grant is data on the agent. NO KEY when nothing is granted: an empty
      // array is a different claim from "this colleague has no tools", and some
      // servers act on the difference.
      if (Array.isArray(grants.tools) && grants.tools.length) body.tools = grants.tools;
      // The GPU on this box is shared with another local process (#1067 §4), so
      // how long a model stays resident is a NEIGHBOURLY choice, not a tuning one.
      if (s.keepAlive !== undefined) body.keep_alive = s.keepAlive;
      return { path: '/api/chat', body };
    },
    read(body) {
      // ⚠️ `message.thinking` IS A SEPARATE FIELD, and missing it cost the first
      // live call this adapter ever made. qwen3.5-fast spent all 300 permitted
      // tokens reasoning and returned `content: ""` with `done_reason: "length"`
      // — a thinking model can burn its ENTIRE budget before writing one
      // character of answer. Reading only `content` reports that as "the model
      // returned nothing", which is true and useless: the model returned 300
      // tokens, none of them for us.
      const msg = body?.message ?? {};
      const thinking = msg.thinking ?? '';
      return {
        text: msg.content ?? '',
        thinking,
        toolCalls: readToolCalls(msg.tool_calls),
        // Ollama says done_reason: "stop" | "length" | "load" …
        stopReason: body?.done_reason ?? (body?.done ? 'stop' : null),
        usage: {
          promptTokens: body?.prompt_eval_count ?? null,
          completionTokens: body?.eval_count ?? null,
          // Ollama does not itemise reasoning tokens, so this is APPROXIMATE and
          // named as such at its only use. It is enough to answer the question
          // the registry's `thinking: true` actually asks: did it reason at all.
          reasoningTokens: thinking ? approxTokens(thinking) : (thinking === '' && 'thinking' in msg ? 0 : null),
        },
      };
    },
  },

  /** The OpenAI chat-completions shape — OpenRouter and most hosted providers. */
  'openai-completions': {
    request(model, messages, s, grants = {}) {
      const body = { model, messages, stream: false };
      if (Array.isArray(grants.tools) && grants.tools.length) body.tools = grants.tools;
      if (s.temperature !== undefined) body.temperature = s.temperature;
      if (s.topP !== undefined) body.top_p = s.topP;
      if (s.maxTokens !== undefined) body.max_tokens = s.maxTokens;
      if (s.stop !== undefined) body.stop = s.stop;
      if (s.seed !== undefined) body.seed = s.seed;
      return { path: '/chat/completions', body };
    },
    read(body) {
      const choice = body?.choices?.[0];
      return {
        text: choice?.message?.content ?? '',
        toolCalls: readToolCalls(choice?.message?.tool_calls),
        // finish_reason: "stop" | "length" | "content_filter" | "tool_calls"
        stopReason: choice?.finish_reason ?? null,
        usage: {
          promptTokens: body?.usage?.prompt_tokens ?? null,
          completionTokens: body?.usage?.completion_tokens ?? null,
          reasoningTokens: body?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
        },
      };
    },
  },

  /**
   * MLX, through a local server speaking the same generate shape the vendored
   * Python used. Kept as its own protocol rather than aliased to the OpenAI one
   * because the runtime distinction (lm vs vlm) is real and will matter.
   */
  mlx: {
    request(model, messages, s) {
      const body = { model, messages, max_tokens: s.maxTokens ?? DEFAULT_MAX_TOKENS };
      if (s.temperature !== undefined) body.temperature = s.temperature;
      if (s.topP !== undefined) body.top_p = s.topP;
      if (s.seed !== undefined) body.seed = s.seed;
      if (s.stop !== undefined) body.stop = s.stop;
      return { path: '/v1/generate', body };
    },
    read(body) {
      return {
        text: body?.text ?? body?.choices?.[0]?.text ?? '',
        stopReason: body?.stop_reason ?? body?.finish_reason ?? null,
        usage: {
          promptTokens: body?.usage?.prompt_tokens ?? null,
          completionTokens: body?.usage?.completion_tokens ?? null,
        },
      };
    },
  },
};

export const PROTOCOL_NAMES = Object.freeze(Object.keys(PROTOCOLS));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Call a model. The ONE call shape.
 *
 * @param {object} agent   {model, protocol, baseUrl, apiKeyRef, thinking, sampling}
 *                         — an entry from the model registry (#1197). `apiKeyRef`
 *                         is a REFERENCE; the key itself is resolved at call
 *                         time and never stored, logged or returned.
 * @param {Array}  messages [{role, content}]
 * @param {object} opts    per-call sampling + {transport, retries, apiKey, now}
 * @returns {Promise<{text, stopReason, usage, raw, attempts}>}
 */
/**
 * #1197 — THE PROBE: does this model id answer, and with which status CLASS?
 * Sends a one-token request through the same protocol shaping as a real call
 * and returns the class without asserting on the body — a probe MEASURES; it
 * does not decide. The body's head travels back because the gateway that
 * discarded 410 bodies is how "retired" got read as "busy" thirteen times
 * (#838). Semantics verified on #840: 401 = exists, auth is the gate · 410 =
 * retired, body carries the EOL date · plain-text 404 = no such id ·
 * problem+json 404 = entitlement. Run a deliberately fake id in the SAME
 * probe run as a control, or a 404 cannot be read.
 */
export async function probeModel(agent, opts = {}) {
  const protocol = PROTOCOLS[agent?.protocol];
  if (!protocol) return { status: null, klass: 'unknown-protocol', reason: `unknown protocol ${JSON.stringify(agent?.protocol)}`, bodyHead: null };
  const transport = opts.transport || defaultTransport;
  const { path, body } = protocol.request(agent.model, [{ role: 'user', content: 'ping' }], { maxTokens: 1 });
  const headers = { 'Content-Type': 'application/json' };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const base = String(agent.baseUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
  const started = Date.now();
  let res;
  try { res = await transport({ url: base + path, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) }); }
  catch (e) { return { status: null, klass: 'unreachable', reason: e?.message ?? String(e), bodyHead: null, latencyMs: Date.now() - started }; }
  const k = classifyStatus(res.status);
  const bodyHead = (res.rawBody ?? '').slice(0, 400);
  const contentType = /problem\+json/i.test(bodyHead) || (res.body && typeof res.body === 'object' && ('title' in res.body || 'detail' in res.body)) ? 'problem+json' : (res.body && typeof res.body === 'object' ? 'json' : 'text');
  let klass = k.action === 'ok' ? 'answers' : k.reason;
  if (res.status === 401 || res.status === 403) klass = 'exists-auth-gated';
  else if (res.status === 410) klass = 'retired';
  else if (res.status === 404) klass = contentType === 'problem+json' ? 'entitlement' : 'no-such-id';
  // First live hosted reading, 2026-09-06 (#1203 via #1197): OpenRouter answers a
  // fake id with 400 `{"error":{"message":"<id> is not a valid model ID"}}`, not a
  // 404. A 400 whose body SAYS the model does not exist is no-such-id; a 400 that
  // says anything else stays a client error, because a malformed request must not
  // read as a missing model.
  else if (res.status === 400 && /not a valid model|model not found|no such model|does not exist|unknown model/i.test(bodyHead)) klass = 'no-such-id';
  return { status: res.status, klass, reason: k.reason, contentType, bodyHead, latencyMs: Date.now() - started };
}

export async function callModel(agent, messages, opts = {}) {
  const protocol = PROTOCOLS[agent?.protocol];
  if (!protocol) {
    throw new ModelAssertionError('protocol', `unknown protocol ${JSON.stringify(agent?.protocol)} — `
      + `known: ${PROTOCOL_NAMES.join(', ')}`);
  }
  if (!Array.isArray(messages) || !messages.length) {
    throw new ModelAssertionError('messages', 'at least one message is required');
  }

  // Role sampling first, per-call on top: the ROLE owns the defaults and the
  // call may override one knob without restating the rest.
  const sampling = { ...samplingOf(agent.sampling || {}), ...samplingOf(opts) };
  const transport = opts.transport || defaultTransport;
  const maxRetries = opts.retries ?? 3;

  const promptTokens = approxTokens(messages.map((m) => m.content).join('\n'));
  const budget = runawayBudget(promptTokens);

  // #1196 — TOOL GRANTS are deliberately NOT part of `sampling`. Sampling is a
  // whitelist of generation knobs, and a capability that rode through it could be
  // widened by an agent's own sampling block. What a colleague may reach is a
  // grant, decided where agents are defined, and it travels on its own channel.
  const grants = { tools: opts.tools ?? agent.tools ?? null };
  const { path, body } = protocol.request(agent.model, messages, sampling, grants);
  const headers = { 'Content-Type': 'application/json' };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  const base = String(agent.baseUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
  const request = { url: base + path, headers, body };

  let attempt = 0; let lastRetryable = null;
  for (;;) {
    attempt += 1;
    const res = await transport(request);
    const klass = classifyStatus(res.status);

    if (klass.action === 'retry') {
      // ⛔ The body travels with every 4xx/5xx, retried or not. See ModelRefusedError.
      lastRetryable = new ModelRefusedError(res.status, klass.reason, res.rawBody, { attempts: attempt });
      if (attempt > maxRetries) throw lastRetryable;
      await sleep(opts.backoffMs ?? Math.min(8000, 250 * 2 ** (attempt - 1)));
      continue;
    }
    if (klass.action === 'retire') {
      throw new ModelRefusedError(res.status, klass.reason, res.rawBody, { retire: agent.model, attempts: attempt });
    }
    if (klass.action === 'refuse') {
      throw new ModelRefusedError(res.status, klass.reason, res.rawBody, {
        attempts: attempt,
        // The REFERENCE, never the key. A log line is a place a secret goes to live forever.
        apiKeyRef: agent.apiKeyRef ?? null,
      });
    }

    const out = protocol.read(res.body);
    // #1196 — every protocol answers the same question the same way. A caller
    // that must branch on `undefined` to ask "did it call a tool" will forget to,
    // and a forgotten branch here loses the call silently.
    if (!Array.isArray(out.toolCalls)) out.toolCalls = [];

    // ── ASSERTIONS, in the order that makes the failure most informative ──

    // 1. A `length` stop is a CONFIGURATION failure, not a model verdict
    //    (#1067 §5, reproduced by two seats). Returning the truncated text as
    //    if it were an answer is how a cut-off sentence becomes a finding.
    // #1196 — a TOOL CALL is a complete turn, not a cut-off one. Before the tool
    // channel existed, every non-stop finish meant a spent budget, so this guard
    // correctly rejected them all. `tool_calls` with calls in hand is the model
    // doing exactly what it was granted; treating it as a failed generation is
    // how a working channel would look broken on its first live call.
    const calledTools = out.toolCalls.length > 0;
    if (out.stopReason && out.stopReason !== 'stop' && !(out.stopReason === 'tool_calls' && calledTools)) {
      // ⚠️ TWO DIFFERENT FAILURES WEAR THIS ONE NAME, and they need opposite
      // fixes. Found on this adapter's first live call: a thinking model spent
      // its whole budget reasoning and returned `content: ""` — raising the
      // budget is right. A model cut off mid-sentence with text in hand is the
      // other one. Reporting both as "truncated" sends the reader to the wrong
      // fix half the time, so the error says WHICH.
      const producedNothing = !String(out.text).trim();
      const reasoned = !!String(out.thinking ?? '').trim();
      const detail = producedNothing && reasoned
        ? `expected "stop", got ${JSON.stringify(out.stopReason)}, and the model produced NO ANSWER `
          + 'AT ALL — the entire budget went into reasoning before it began replying. Raise the token '
          + 'budget or turn thinking off for this role; the answer is not truncated, it never started.'
        : producedNothing
          ? `expected "stop", got ${JSON.stringify(out.stopReason)}, and the response carries no text. `
            + 'The budget was spent before any answer was written.'
          : `expected "stop", got ${JSON.stringify(out.stopReason)}. A non-stop finish is a `
            + 'configuration failure — the answer is truncated, not complete.';
      throw new ModelAssertionError('stopReason', detail, {
        stopReason: out.stopReason, usage: out.usage, attempts: attempt,
        producedNothing, reasoned,
        // A truncated answer is EVIDENCE, not garbage: carry an excerpt so the
        // caller can see where it stopped without re-running a 46-second call.
        excerpt: String(out.text).slice(0, 200) || null,
      });
    }

    // 2. The runaway guard, applied to what actually came back. The budget is
    //    sized to THIS prompt, which is why it catches a repetition loop that
    //    maxTokens sails past.
    const produced = out.usage.completionTokens ?? approxTokens(out.text);
    if (produced > budget) {
      throw new RunawayGenerationError(produced, budget, promptTokens);
    }

    // 3. A thinking model must have actually been given room to think, or the
    //    registry's `thinking: true` is a claim nothing checks.
    if (agent.thinking && out.usage.reasoningTokens === 0) {
      throw new ModelAssertionError('thinking',
        'the registry says this model reasons, and the response reports zero reasoning tokens — '
        + 'the budget was not honoured, so this answer is not the one that was asked for',
        { usage: out.usage, attempts: attempt });
    }

    // 4. Empty text is a failure with a name, not an empty string handed on.
    //    ⛔ An empty result and a failed call must never look identical.
    //    #1196 — EXCEPT when the turn is a tool call. A colleague that answers
    //    "let me look that up" in prose AND calls the tool has said nothing
    //    useful twice; silence plus a call is the correct shape, and rejecting
    //    it would make the well-behaved case the failing one.
    if (!String(out.text).trim() && !calledTools) {
      throw new ModelAssertionError('nonEmpty',
        'the provider returned success and no text. An empty answer and a failed call are '
        + 'different facts and the caller must be able to tell them apart.',
        { usage: out.usage, attempts: attempt });
    }

    return { ...out, raw: res.body, attempts: attempt };
  }
}

/**
 * Ask Ollama to drop a model from VRAM. The GPU on this machine is shared with
 * another local process (#1067 §4), so this is a courtesy to a NEIGHBOUR, not
 * an optimisation — and it is best-effort by design: failing to unload must
 * never fail the work that just succeeded.
 */
export async function courtesyUnload(agent, opts = {}) {
  if (agent?.protocol !== 'ollama-native') return { unloaded: false, reason: 'not an Ollama model' };
  const transport = opts.transport || defaultTransport;
  try {
    const base = String(agent.baseUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
    const res = await transport({
      url: `${base}/api/generate`,
      headers: { 'Content-Type': 'application/json' },
      body: { model: agent.model, prompt: '', keep_alive: 0 },
    });
    return { unloaded: res.status >= 200 && res.status < 300, status: res.status };
  } catch (e) {
    return { unloaded: false, reason: e.message };
  }
}
