/**
 * #1372 — a delivery event can carry a TRACE IDENTITY and a MODEL-CALL EDGE.
 * `traceId` is an opaque literal (≤ 128 chars) on the `scrum:DeliveryEvent`
 * node; `modelCall` names a `scrum:ModelCall` row the board holds and projects
 * as the entity edge `scrum:ofModelCall`, so "which call produced this
 * delivery's outcome" is one hop and "every event of trace T" is one filter.
 * A ref the board does not hold is refused (400) with the record unchanged —
 * never a dangling edge. Both read back on the wire.
 *
 * The runner side: when one digest turn held MORE THAN ONE message and made
 * ONE post, every `published` it writes carries `reason: batch-ambiguous` —
 * one post is not N replies, and the record must not invent that by omission.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { deliveryOutcome } from '../core/guest-loop.mjs';
import { PREDICATE_SOURCE } from '../core/predicate-names.mjs';
import { kindByName } from '../core/kind-registry.mjs';

async function api(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null; try { parsed = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: parsed };
}
const post = (base, author, body) => api(base, 'POST', '/api/conversations', { author, body });
const fresh = () => makeBoardFixture({ cards: [], nextShortId: 1 });
const ev = (base, id, body) => api(base, 'POST', `/api/deliveries/${encodeURIComponent(id)}/events`, { source: 'guest-runner', by: 'gizmo', ...body });

async function offeredAndClaimed(base) {
  const msg = (await post(base, 'ada', 'a post for the room')).body;
  const d = (await api(base, 'POST', '/api/deliveries', { to: 'gizmo', conversation: msg.id, source: 'fanout', by: 'board' })).body;
  const c = await ev(base, d.id, { state: 'claimed' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  return d;
}

test('#1372 traceId and modelCall ride the event and READ BACK; a modelCall the board does not hold is refused with the record unchanged', async () => {
  const srv = await startRestServer({ board: fresh() });
  try {
    const d = await offeredAndClaimed(srv.baseUrl);
    const call = await api(srv.baseUrl, 'POST', '/api/model-calls', { by: 'gizmo', model: 'fake', protocol: 'ollama-native' });
    assert.equal(call.status, 201, JSON.stringify(call.body));

    const bogus = await ev(srv.baseUrl, d.id, { state: 'published', modelCall: 'https://scrumboard.local/model-call/00000000-0000-0000-0000-000000000000' });
    assert.equal(bogus.status, 400, JSON.stringify(bogus.body));
    assert.match(bogus.body.error, /modelCall/);
    const after = (await api(srv.baseUrl, 'GET', `/api/deliveries?to=gizmo`)).body.deliveries[0];
    assert.equal(after.state, 'claimed', 'a refused event appends nothing');
    assert.equal(after.events.length, 2);

    const long = await ev(srv.baseUrl, d.id, { state: 'published', traceId: 'x'.repeat(129) });
    assert.equal(long.status, 400, 'traceId over 128 chars is refused');

    const ok = await ev(srv.baseUrl, d.id, { state: 'published', traceId: 'trace-abc', modelCall: call.body.id });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const last = ok.body.events.at(-1);
    assert.equal(last.state, 'published');
    assert.equal(last.traceId, 'trace-abc');
    assert.equal(last.modelCall, call.body.id);
    // read back, not the 201
    const read = (await api(srv.baseUrl, 'GET', `/api/deliveries?to=gizmo`)).body.deliveries[0];
    assert.equal(read.events.at(-1).traceId, 'trace-abc');
    assert.equal(read.events.at(-1).modelCall, call.body.id);
    // an event without them carries neither key — absence is absence
    assert.equal('traceId' in read.events[0], false);
    assert.equal('modelCall' in read.events[0], false);
  } finally { await srv.stop(); }
});

test('#1372 the GRAPH: scrum:ofModelCall is an entity edge to the ModelCall node; scrum:traceId is a literal on the event', async () => {
  const srv = await startRestServer({ board: fresh() });
  try {
    const d = await offeredAndClaimed(srv.baseUrl);
    const call = (await api(srv.baseUrl, 'POST', '/api/model-calls', { by: 'gizmo', model: 'fake', protocol: 'ollama-native' })).body;
    await ev(srv.baseUrl, d.id, { state: 'published', traceId: 'trace-graph', modelCall: call.id });
    let q;
    for (let i = 0; i < 40; i++) {
      q = await api(srv.baseUrl, 'POST', '/api/graph', { query: `
        SELECT ?e ?state ?trace ?call ?model WHERE {
          ?e a scrum:DeliveryEvent ; scrum:ofDelivery <${d.id}> ; scrum:state ?state ; scrum:traceId ?trace ; scrum:ofModelCall ?call .
          ?call a scrum:ModelCall ; scrum:model ?model .
        }` });
      if (q.status === 200 && q.body.rows.length === 1) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal(q.body.rows.length, 1, `one published event joined to its ModelCall — got ${JSON.stringify(q.body.rows)}`);
    const r = q.body.rows[0];
    assert.equal(String(r.state), 'published');
    assert.equal(String(r.trace), 'trace-graph');
    assert.equal(String(r.call), call.id, 'the edge lands on the ModelCall node itself');
    assert.equal(String(r.model), 'fake', 'and the join to the row proves it is an edge, not a string');
  } finally { await srv.stop(); }
});

test('#1372 the predicate names are declared in code and the kind definition names them', () => {
  // The code-side registries are what the registry-vs-projection check (#875)
  // and the kind divergence check read; the prose registries on prod are
  // written at ship time (kind_register / predicate_register) — not this test's.
  assert.equal(PREDICATE_SOURCE['scrum:traceId'], 'scrum:traceId');
  assert.equal(PREDICATE_SOURCE['scrum:ofModelCall'], 'scrum:ofModelCall');
  const k = kindByName('scrum:DeliveryEvent');
  assert.ok(k, 'scrum:DeliveryEvent is declared');
  assert.match(k.definition, /traceId/);
  assert.match(k.definition, /ofModelCall/);
  assert.match(k.definition, /batch-ambiguous/);
});

// ── the runner's outcome: one post for N messages is batch-ambiguous ──
test('#1372 deliveryOutcome — one digest post over >1 message marks every published batch-ambiguous; one message does not; modelCall rides from the ledger id', () => {
  const posted = { posted: true, ledger: { ledgerId: 'https://scrumboard.local/model-call/abc' } };
  const one = deliveryOutcome(posted, ['d1']);
  assert.deepEqual(one, { state: 'published', modelCall: 'https://scrumboard.local/model-call/abc' });
  const many = deliveryOutcome(posted, ['d1', 'd2']);
  assert.deepEqual(many, { state: 'published', reason: 'batch-ambiguous', modelCall: 'https://scrumboard.local/model-call/abc' });
  const declined = deliveryOutcome({ posted: false, declined: true, ledger: { ledgerId: null } }, ['d1', 'd2']);
  assert.deepEqual(declined, { state: 'declined', reason: 'explicit' }, 'a NO is the seat\'s act, not a batch artefact; no ledger id → no modelCall key');
  const failed = deliveryOutcome({ posted: false, reason: 'model-failed', ledger: { ledgerId: 'https://scrumboard.local/model-call/x' } }, ['d1']);
  assert.deepEqual(failed, { state: 'failed', note: 'model-failed', modelCall: 'https://scrumboard.local/model-call/x' });
  const halted = deliveryOutcome({ posted: false, halted: true, reason: 'budget-breached' }, ['d1']);
  assert.deepEqual(halted, { state: 'failed', note: 'budget-breached' }, 'a halt before the call has no ledger row');
});
