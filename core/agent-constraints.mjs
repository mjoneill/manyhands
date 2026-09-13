/**
 * #1350 — EVERYTHING THAT GOVERNS AN AGENT, IN ONE PLACE, WITH WHERE IT CAME FROM.
 *
 * Two specimens in 48 hours: a seat failed silently on a mention because its
 * hop cap (8) ran out at 70 s, and nothing on the board said it had one; a
 * seat "went quiet" behind a 60 s inbound debounce that lived in a plugin
 * config no human reads. In both the constraint was real, in effect, and
 * recorded nowhere a person could look. The owner's words: "it's concerning
 * to me that you'd have a debounce control that is not visible."
 *
 * This module answers "what governs THIS agent, now" — a current-state
 * inspector — from the same inputs the runtime resolves against, and it
 * says for every value WHICH LAYER WON. The precedence below is read from
 * the code that applies it, not chosen here:
 *
 *   thinking      agent record  ▸ model spec  ▸ unset           guest-once.mjs (#1196)
 *   maxHops       agent record  ▸ model spec  ▸ code default 4  guest-loop.mjs:503, tool-loop.mjs DEFAULT_MAX_HOPS
 *   wakeOn        agent record  ▸ code default ['mention']      guest-loop.mjs:236
 *   everyMinutes  agent record  ▸ code default 60               guest-loop.mjs:249 (only read when wakeOn has 'schedule')
 *   contextPolicy / residency / state — agent record ▸ code default (agentToWire's `??`)
 *   participationClause  agent record ▸ code default off        #1271, decision cb82348e
 *
 * ⛔ A value set at NO layer is reported as `unset`, never as a default
 * dressed up as a setting; a default the code applies is `code default: N`.
 * (acceptance 3 — the settings page lied about the roster exactly this way, #1336.)
 *
 * ⛔ WHAT THIS CANNOT SEE IS LISTED, NOT OMITTED (acceptance 4). Constraints
 * that live outside the board — the gateway bridge's inbound debounce and
 * suppression rules, the runner's env — are named in `unseen` with the reason.
 * An inspector that drops a layer silently is the defect it was filed to fix.
 *
 * Pure: takes nodes and a ledger slice, returns a wire object. The server
 * route reads the board and hands them in.
 */
import { DEFAULT_MAX_HOPS } from './tool-loop.mjs';

export const CODE_DEFAULTS = Object.freeze({
  wakeOn: ['mention'],
  everyMinutes: 60,
  maxHops: DEFAULT_MAX_HOPS,
  contextPolicy: 'thread',
  residency: 'guest',
  state: 'invited',
  participationClause: false,
});

const has = (v) => v !== undefined && v !== null;
const rec = (value, source, extra = {}) => ({ value, source, ...extra });
const unset = () => rec(null, 'unset');
const fromRecord = (v) => rec(v, 'agent record');
const codeDefault = (v) => rec(v, 'code default');

/** The layers the board cannot read, stated per agent so a reader never mistakes silence for coverage. */
export function unseenLayers(node) {
  const seat = node['scrum:seatKey'];
  return [
    {
      layer: 'plugin config',
      what: 'inbound debounce, reply suppression rules, delivery path',
      why: `if ${seat} is bridged from a gateway runtime, those live in that runtime's plugin config and are not reported to the board (#1347 logs the debounce at lane start; a log line is not a surface)`,
    },
    {
      layer: 'env',
      what: 'SCRUM_GUEST_STATE_FILE, SCRUM_MODEL_LEDGER_FILE, the API key named by apiKeyRef',
      why: 'set in the process that runs the seat (guest-once.mjs); the board cannot read another process\'s environment',
    },
    {
      layer: 'channel delivery',
      what: 'delivery mode (wake rules vs channel-managed Off/Soft/Hard/TokenRing)',
      why: 'not a field yet — #1346 builds it; until then every board-native agent is wake-rule only',
    },
  ];
}

/**
 * @param {object} node          the scrum:Agent node as stored (scrum:* keys)
 * @param {object} [opts]
 * @param {object|null} [opts.model]     the registered scrum:Model node it usesModel, if any
 * @param {object[]} [opts.promptVersions]  scrum:AgentPromptVersion nodes for this agent
 * @param {object[]} [opts.modelCallsToday]  ledger rows for this agent since local midnight (wire shape: {cost, at})
 * @param {object[]} [opts.claims]       cards the seat currently holds ({shortId, title})
 * @param {string}   [opts.since]        ISO start of "today" used for spentToday
 */
export function agentConstraints(node, { model = null, promptVersions = [], modelCallsToday = [], claims = [], since = null } = {}) {
  const spec = node['scrum:modelSpec'] ?? null;
  const seat = node['scrum:seatKey'];

  // thinking — agent record beats model spec; unset sends no flag (#1196).
  const thinking = has(node['scrum:thinking']) ? fromRecord(node['scrum:thinking'])
    : has(spec?.thinking) ? rec(spec.thinking, 'model spec')
    : unset();

  // maxHops — agent record beats model spec beats the loop's default.
  const maxHops = has(node['scrum:maxHops']) ? fromRecord(node['scrum:maxHops'])
    : has(spec?.maxHops) ? rec(spec.maxHops, 'model spec')
    : codeDefault(CODE_DEFAULTS.maxHops);

  const wakeOnRaw = node['scrum:wakeOn'];
  const wakeOn = Array.isArray(wakeOnRaw) && wakeOnRaw.length ? fromRecord(wakeOnRaw) : codeDefault(CODE_DEFAULTS.wakeOn);
  const everyMinutes = has(node['scrum:everyMinutes']) ? fromRecord(node['scrum:everyMinutes'])
    : wakeOn.value.includes('schedule') ? codeDefault(CODE_DEFAULTS.everyMinutes)
    : unset();

  const current = promptVersions.find((v) => v['@id'] === node['scrum:currentPrompt']) || null;
  // Money, summed in binary: 0.1 + 0.25 leaves 0.15000000000000002 as the remainder. Rounded to
  // a micro-dollar, which is finer than any ledger row (#1294 measures to 9 places, priced to 6).
  const usd = (n) => Math.round(n * 1e6) / 1e6;
  const spent = usd(modelCallsToday.reduce((n, c) => n + (Number(c.cost) || 0), 0));
  const budget = has(node['scrum:budgetPerDay']) ? fromRecord(node['scrum:budgetPerDay']) : unset();

  return {
    seat,
    name: node.name ?? seat,
    constraints: {
      model: spec?.model != null ? rec(spec.model, model ? 'model spec' : 'agent record', { modelKey: spec.modelKey ?? model?.['scrum:modelKey'] ?? null }) : unset(),
      provider: model?.['scrum:provider'] != null ? rec(model['scrum:provider'], 'model spec') : spec?.baseUrl ? rec(spec.baseUrl, 'agent record') : unset(),
      protocol: spec?.protocol != null ? rec(spec.protocol, model ? 'model spec' : 'agent record') : unset(),
      thinking,
      maxHops,
      budgetPerDay: budget,
      spentToday: rec(spent, 'ledger', { since, calls: modelCallsToday.length, remaining: budget.value == null ? null : usd(Math.max(0, budget.value - spent)) }),
      promptVersion: current ? rec(current['scrum:version'], 'agent record', { id: current['@id'] }) : unset(),
      participationClause: has(node['scrum:participationClause']) ? fromRecord(node['scrum:participationClause']) : codeDefault(CODE_DEFAULTS.participationClause),
      wakeOn,
      everyMinutes,
      deliveryMode: unset(),   // #1346 — not a field yet; listed in `unseen`
      toolGrants: Array.isArray(node['scrum:toolGrant']) ? fromRecord(node['scrum:toolGrant']) : codeDefault([]),
      contextPolicy: has(node['scrum:contextPolicy']) ? fromRecord(node['scrum:contextPolicy']) : codeDefault(CODE_DEFAULTS.contextPolicy),
      residency: has(node['scrum:residency']) ? fromRecord(node['scrum:residency']) : codeDefault(CODE_DEFAULTS.residency),
      state: has(node['scrum:state']) ? fromRecord(node['scrum:state']) : codeDefault(CODE_DEFAULTS.state),
      holds: rec(claims.map((c) => ({ card: c.shortId, title: c.title })), 'board'),
      promptGrantConflict: node['scrum:promptGrantConflict'] ? rec({ phrase: node['scrum:promptGrantConflict'], reason: node['scrum:promptGrantConflictReason'] ?? null }, 'agent record') : unset(),
    },
    unseen: unseenLayers(node),
    layers: ['agent record', 'model spec', 'ledger', 'board', 'code default', 'unset'],
  };
}
