/**
 * #1350 — what governs THIS agent, now, with the layer each value came from.
 *
 * Acceptance 1 is the discriminating test: one value set at TWO layers, and
 * the surface must show the winner AND name the layer. `thinking` is the
 * cleanest case in the real data model (a registered model carries it, an
 * agent record can override it), so the pair below is the same seat with and
 * without the override — opposite answers from one call.
 *
 * Acceptance 3 is the negative control: a value set nowhere reads `unset`,
 * and a default the code applies reads `code default`, never blank and never
 * dressed as a setting.
 *
 * Acceptance 4: the layers the board cannot see are LISTED, with why.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentConstraints, CODE_DEFAULTS } from '../core/agent-constraints.mjs';
import { DEFAULT_MAX_HOPS } from '../core/tool-loop.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const MODEL_NODE = { '@id': 'https://scrumboard.local/model/m1', '@type': 'scrum:Model', 'scrum:modelKey': 'm1', 'scrum:model': 'gemma4:26b', 'scrum:provider': 'ollama', 'scrum:protocol': 'ollama-native', 'scrum:thinking': true };
const SPEC_FROM_MODEL = { model: 'gemma4:26b', protocol: 'ollama-native', modelKey: 'm1', thinking: true };
const base = (over = {}) => ({
  '@id': 'https://scrumboard.local/agent/gizmo', '@type': 'scrum:Agent', 'scrum:seatKey': 'gizmo', name: 'Gizmo',
  'scrum:modelSpec': SPEC_FROM_MODEL, 'scrum:usesModel': MODEL_NODE['@id'], 'scrum:currentPrompt': 'https://scrumboard.local/agent-prompt/gizmo/v2',
  ...over,
});
const VERSIONS = [
  { '@id': 'https://scrumboard.local/agent-prompt/gizmo/v1', 'scrum:version': 1 },
  { '@id': 'https://scrumboard.local/agent-prompt/gizmo/v2', 'scrum:version': 2 },
];

test('#1350 ACCEPTANCE 1 — one value at two layers: the agent record wins over the model spec and the layer is NAMED; drop the override and the model spec wins, named', () => {
  const overridden = agentConstraints(base({ 'scrum:thinking': false }), { model: MODEL_NODE, promptVersions: VERSIONS });
  assert.deepEqual(overridden.constraints.thinking, { value: false, source: 'agent record' });
  const inherited = agentConstraints(base(), { model: MODEL_NODE, promptVersions: VERSIONS });
  assert.deepEqual(inherited.constraints.thinking, { value: true, source: 'model spec' });
});

test('#1350 ACCEPTANCE 2 — the hop-cap specimen is answerable from the surface: a record with maxHops 8 says 8 / agent record; a record without says the loop default / code default', () => {
  const capped = agentConstraints(base({ 'scrum:maxHops': 8 }));
  assert.deepEqual(capped.constraints.maxHops, { value: 8, source: 'agent record' });
  const uncapped = agentConstraints(base());
  assert.deepEqual(uncapped.constraints.maxHops, { value: DEFAULT_MAX_HOPS, source: 'code default' });
  assert.equal(CODE_DEFAULTS.maxHops, DEFAULT_MAX_HOPS, 'the inspector must quote the SAME constant the loop enforces');
});

test('#1350 ACCEPTANCE 3 NEGATIVE CONTROL — set nowhere reads `unset`; a code-applied default reads `code default`, never blank', () => {
  const bare = agentConstraints({ '@id': 'https://scrumboard.local/agent/blank', 'scrum:seatKey': 'blank' });
  const c = bare.constraints;
  assert.deepEqual(c.model, { value: null, source: 'unset' });
  assert.deepEqual(c.thinking, { value: null, source: 'unset' });
  assert.deepEqual(c.budgetPerDay, { value: null, source: 'unset' });
  assert.deepEqual(c.promptVersion, { value: null, source: 'unset' });
  assert.deepEqual(c.everyMinutes, { value: null, source: 'unset' }, 'everyMinutes is not even read unless wakeOn has schedule');
  assert.deepEqual(c.wakeOn, { value: ['mention'], source: 'code default' });
  assert.deepEqual(c.participationClause, { value: false, source: 'code default' });
  assert.deepEqual(c.residency, { value: 'guest', source: 'code default' });
  for (const [k, v] of Object.entries(c)) assert.ok(typeof v.source === 'string' && v.source.length, `${k} has no source`);
});

test('#1350 everyMinutes becomes a live code default the moment schedule is in wakeOn — the value the loop would actually use', () => {
  const scheduled = agentConstraints(base({ 'scrum:wakeOn': ['mention', 'schedule'] }));
  assert.deepEqual(scheduled.constraints.wakeOn, { value: ['mention', 'schedule'], source: 'agent record' });
  assert.deepEqual(scheduled.constraints.everyMinutes, { value: 60, source: 'code default' });
});

test('#1350 spent today comes from the ledger and is stated against the budget; holds come from the board', () => {
  const r = agentConstraints(base({ 'scrum:budgetPerDay': 0.5 }), {
    modelCallsToday: [{ cost: 0.1 }, { cost: 0.25 }, { cost: 'not a number' }],
    claims: [{ shortId: 42, title: 'A card' }],
    since: '2026-09-13T00:00:00.000Z',
  });
  assert.deepEqual(r.constraints.spentToday, { value: 0.35, source: 'ledger', since: '2026-09-13T00:00:00.000Z', calls: 3, remaining: 0.15 });
  assert.deepEqual(r.constraints.holds, { value: [{ card: 42, title: 'A card' }], source: 'board' });
});

test('#1350 ACCEPTANCE 4 — the layers the board cannot read are LISTED with a reason; delivery mode LEFT the list when #1346 made it a field', () => {
  const r = agentConstraints(base());
  const layers = r.unseen.map((u) => u.layer);
  // #1346 slice 1 — 'channel delivery' was here until the field existed. An
  // inspector must not declare blind a thing it can read, so the list shrank.
  assert.deepEqual(layers, ['plugin config', 'env']);
  for (const u of r.unseen) assert.ok(u.what && u.why, `${u.layer} must say what and why`);
  assert.match(r.unseen[0].what, /debounce/);
  assert.deepEqual(r.constraints.deliveryMode, { value: 'wake', source: 'code default' },
    'absent on the record ⇒ the code default, NAMED as such — never unset, never blank');
});

test('#1350 wire — GET /api/agents/:seat/constraints serves the inspector; an unknown seat is a 404 that still names the blind spot', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const api = async (method, p, body) => {
      const r = await fetch(`${srv.baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    const created = await api('POST', '/api/agents', { seatKey: 'gizmo', name: 'Gizmo', prompt: 'Answer only from what you are handed.', model: { model: 'gemma4:26b', protocol: 'ollama-native', baseUrl: 'http://localhost:11434' }, toolGrants: ['conversation_post'], budgetPerDay: 0.5, residency: 'guest', maxHops: 8, by: 'ada' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const r = await api('GET', '/api/agents/gizmo/constraints');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.seat, 'gizmo');
    assert.deepEqual(r.body.constraints.maxHops, { value: 8, source: 'agent record' });
    assert.deepEqual(r.body.constraints.budgetPerDay, { value: 0.5, source: 'agent record' });
    assert.equal(r.body.constraints.spentToday.source, 'ledger');
    assert.deepEqual(r.body.constraints.promptVersion.value, 1);
    assert.ok(Array.isArray(r.body.unseen) && r.body.unseen.length >= 2);   // #1346 took 'channel delivery' off the list

    const missing = await api('GET', '/api/agents/nobody/constraints');
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /no agent record/);
    assert.ok(Array.isArray(missing.body.unseen) && missing.body.unseen.length, 'a seat with no record still gets told which layers might govern it');
  } finally { await srv.stop(); }
});
