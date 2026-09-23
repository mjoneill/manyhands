/**
 * #1441 — THE RUNNER'S ROW MUST REACH THE BOARD WHOLE, and a refused memory must
 * reach the seat that wrote it.
 *
 * Measured 2026-09-22 across 1,357 live model-call rows: `markerLines` (#1254,
 * written on EVERY published row), `narrationRetry` (#1246b) and
 * `unbackedLookupClaims` (#1246) were non-empty on ZERO. The server accepts all
 * three; the runner's `rowToBoard` never forwarded them. The tests that covered
 * those fields each carried "the runner's rowToBoard, reduced to the fields this
 * test is about" — a hand copy, which cannot fail for a field the real one drops.
 *
 * And #1240's refusal (`memoryRefused`) lived only in the runner's log: 226
 * refused REMEMBER lines for one resident in two weeks, the seat told of none.
 *
 * So: the REAL rowToBoard (moved to core/), a REAL guestOnce row, a REAL server,
 * and a GENERIC assertion — every field the runner puts on its row that the
 * server's wire also returns must come back as written. The next field someone
 * adds to the row and forgets here fails this file without anyone naming it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestOnce, buildMessages } from '../core/guest-loop.mjs';
import { rowToBoard, refusalsSince } from '../core/model-call-row.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const api = async (baseUrl, method, p, body) => {
  const r = await fetch(`${baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed = null; try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
};

const AGENT = { seatKey: 'gizmo', name: 'Gizmo', systemPrompt: 'answer', residency: 'resident', model: { model: 'm', protocol: 'openai-completions' } };

// Keys the wire derives or renames rather than echoing (postId → producedPost,
// usage → tokensIn/Out, base.at → at): not "forwarded as written" by design.
const DERIVED = new Set(['usage', 'postId', 'ledger', 'recorded', 'ledgerId', 'attempts', 'reason', 'declined', 'modelStopReason']);

async function oneWake(srv, { text, memories = [] }) {
  const mention = (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@gizmo are you there?', author: 'bo' })).body;
  const post = (b) => api(srv.baseUrl, 'POST', '/api/conversations', b).then((r) => r.body);
  let captured = null;
  const ledgerSink = async (row) => { captured = row; return (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body; };
  const callModel = async () => ({ text, toolCalls: [], stopReason: 'stop', usage: { promptTokens: 10, completionTokens: 8 } });
  const r = await guestOnce({ agent: AGENT, wake: mention, callModel, post, ledgerSink,
    memories: async () => memories, writeMemory: async () => ({ id: 'm1' }), ledgerFile: `/tmp/never-used-1441-${process.pid}.jsonl` });
  return { r, captured };
}

// A value at its default ([], {}, null, '') cannot tell "forwarded" from
// "dropped": a dropped field reads back as that same default. (Review of
// 3ecca80: deleting unbackedLookupClaims from rowToBoard left this file green.)
// So every compared field is given a NON-default value here, and the test
// refuses to run vacuously: a compared field left at its default fails with
// its name, which is what makes the NEXT forwarded field land here.
const isDefault = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
const SAMPLE = {
  unbackedLookupClaims: [{ verb: 'read', phrase: 'I have read', index: 0 }],
  narrationRetry: { outcome: 'performed', announced: 'I will search' },
  memoryRefused: [{ line: 'card #7 is the vocabulary one', reason: 'this line claims card #7 and no tool returned that card on this wake.' }],
  markerLines: 2,
  anomalies: ['zero-reasoning-tokens'],
  toolsGranted: ['card_get'],
  toolHops: [{ id: 'c1', name: 'card_get', arguments: { shortId: 7 }, ok: true, rowCount: 1 }],
  modelCalls: 2,
  stoppedBecause: 'answered',
  claims: [{ shortId: 7, ok: true }],
  memoryWritten: ['m1'],
  error: 'sample error text',
  promptVersion: 'pv-1',
  provider: 'http://localhost:9',
  contextHandedTo: ['https://scrumboard.local/conversation/x'],
  // #1428 PRIVACY — `withheldReason` rides the wire as a STABLE TOKEN, so a
  // downward selector can count declines. `withheldText` is NOT in this
  // fixture, NOT on the row, NOT on the wire — the recoverable body lives
  // only in the resident's private file (core/withheld-state.mjs). The
  // seam test asserts the privacy contract on this last test below.
  withheldReason: 'standalone-no-reply',
  // #1428 DIAGNOSTIC ROW — withheldStateOutcome is the STABLE outcome token
  // for the seat's per-seat file operation. Five values: retained, cleared,
  // retain-failed, clear-failed; null on unrelated rows. Public, REST, graph
  // may carry it; NEVER the withheld text or a filesystem path.
  withheldStateOutcome: 'retain-failed',
};
// A wake's received-hand-back count lives INSIDE `memory` (alongside
// refusalsHanded), and the SAME drop-detection rule applies there: the seam
// will only see a drop when the field carries a non-default value.
const MEMORY_SAMPLE = { withheldHanded: 2 };
// Compared fields that are legitimately allowed to stay at their default in
// this fixture, each with the reason. Keep this list short and argued.
const MAY_BE_DEFAULT = {};

test('#1441 GENERIC SEAM — every field a real wake puts on its row that the wire returns comes back as written (non-default values only)', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const { captured } = await oneWake(srv, { text: 'REPLY: here.\nREMEMBER: nothing with a number' });
    assert.ok(captured, 'the runner produced a row');
    const probe = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo&limit=1')).body.calls[0];
    // the REAL row's shape, with every default overlaid by a sample, posted through the REAL builder
    const row = { ...captured };
    // …including the fields the runner puts on the row only when they fire
    // (narrationRetry, memoryRefused are spread in conditionally).
    for (const k of Object.keys(SAMPLE)) if (!(k in row) || isDefault(row[k])) row[k] = SAMPLE[k];
    // #1428 slice 2 — withheldHanded lives INSIDE `memory`, not at the top
    // level. Overlay the same way: a default (null) cannot tell "forwarded"
    // from "dropped", so the test refuses to compare against it.
    row.memory = { ...(row.memory ?? {}) };
    for (const k of Object.keys(MEMORY_SAMPLE)) if (!(k in row.memory) || isDefault(row.memory[k])) row.memory[k] = MEMORY_SAMPLE[k];
    // a later timestamp, so the read-back (newest first) is THIS row and not the probe's
    row.at = new Date(Date.parse(captured.at) + 60_000).toISOString();
    const compared = Object.keys(row).filter((k) => !DERIVED.has(k) && k in probe);
    const vacuous = compared.filter((k) => isDefault(row[k]) && !(k in MAY_BE_DEFAULT));
    assert.deepEqual(vacuous, [], 'these compared fields sit at their default in the fixture, so a drop could not be seen — give each a SAMPLE value');
    const posted = await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT));
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const wire = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo&limit=1')).body.calls[0];
    const plain = (x) => x && typeof x === 'object' && !Array.isArray(x);
    const dropped = [];
    for (const k of compared) {
      const v = row[k]; const got = wire[k];
      // A nested object the wire returns a PROJECTION of (wake: the board keeps
      // kind + messageId; the author is one lookup away on the message) is
      // compared on the keys the wire returns.
      const want = plain(v) && plain(got) ? Object.fromEntries(Object.keys(got).map((kk) => [kk, v[kk] ?? null])) : v;
      if (JSON.stringify(got) !== JSON.stringify(want)) dropped.push(`${k}: row=${JSON.stringify(v)} wire=${JSON.stringify(got)}`);
    }
    // #1428 slice 2 — `memory.withheldHanded` lives INSIDE `memory`, not at
    // the top level. The seam loops over top-level keys; one nested round
    // handles the new hand-back count.
    if (row.memory && plain(wire.memory)) {
      for (const [k, v] of Object.entries(row.memory)) {
        if (!(k in wire.memory)) continue;
        if (isDefault(v) && !(k in MAY_BE_DEFAULT)) { dropped.push(`memory.${k}: defaulted in the fixture, drop would not be visible`); continue; }
        if (JSON.stringify(v) !== JSON.stringify(wire.memory[k])) dropped.push(`memory.${k}: row=${JSON.stringify(v)} wire=${JSON.stringify(wire.memory[k])}`);
      }
    }
    assert.deepEqual(dropped, [], 'a field the runner wrote and the server returns came back different (dropped between them)');
    assert.ok(compared.includes('markerLines') && compared.includes('unbackedLookupClaims') && compared.includes('narrationRetry') && compared.includes('memoryRefused'),
      `the four fields measured at zero in production are among those compared: ${compared.join(', ')}`);
    // #1428 PRIVACY — `withheldReason` is compared at the top level (the
    // STABLE TOKEN ride); `withheldText` is NOT in `compared` because the
    // runner row does not carry it any more — it lives only in the resident's
    // private file. The test asserts the privacy contract on the
    // withheldReason path below.
    assert.ok(compared.includes('withheldReason'),
      `withheldReason is among those compared (stable token that survives the round-trip): ${compared.join(', ')}`);
    assert.ok(!compared.includes('withheldText'),
      `withheldText is NOT among those compared: a future runner that puts the recoverable body back on the row is a privacy regression that fails here. compared: ${compared.join(', ')}`);
    assert.ok(compared.includes('withheldStateOutcome'),
      `withheldStateOutcome is among those compared (stable outcome token): ${compared.join(', ')}`);
  } finally { await srv.stop(); }
});

test('#1441 — a REFUSED REMEMBER line is on the board row, with the line and the reason', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const { captured } = await oneWake(srv, { text: 'REPLY: noted.\nREMEMBER: card #7 is the vocabulary one' });
    assert.equal(captured.memoryRefused?.length, 1, 'the runner refused it (#1240 — #7 was never fetched)');
    const wire = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo&limit=1')).body.calls[0];
    assert.equal(wire.memoryRefused?.length, 1, 'the refusal is on the BOARD row, not only in the runner log');
    assert.match(wire.memoryRefused[0].line, /card #7 is the vocabulary one/);
    assert.match(wire.memoryRefused[0].reason, /#7/);
    // …and PROJECTED: a seat whose only view is the graph can count it.
    const q = await api(srv.baseUrl, 'POST', '/api/graph', { query: 'SELECT ?n WHERE { ?c a scrum:ModelCall ; scrum:memoryRefused ?n . }', by: 'ada' });
    const b = q.body.rows || q.body.bindings || [];
    assert.ok(b.length, `the refusal count must be in the graph: ${JSON.stringify(q.body).slice(0, 300)}`);
    assert.equal(Number(b[0].n?.value ?? b[0].n), 1);
  } finally { await srv.stop(); }
});

test('#1441 — a clean wake carries memoryRefused: [] on the wire (absence reads as zero, not unknown)', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    await oneWake(srv, { text: 'REPLY: nothing to keep.' });
    const wire = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo&limit=1')).body.calls[0];
    assert.deepEqual(wire.memoryRefused, []);
  } finally { await srv.stop(); }
});

test('#1441 HAND-BACK — the next wake is TOLD its last REMEMBER was refused, with the line and why', () => {
  const wake = { id: 'w2', author: 'bo', body: '@gizmo again', createdAt: '2026-09-22T20:00:00Z' };
  const refused = [{ line: 'card #7 is the vocabulary one', reason: 'this line claims card #7 and no tool returned that card on this wake.' }];
  const told = JSON.stringify(buildMessages({ agent: AGENT, wake, refusedMemory: refused }));
  assert.match(told, /REMEMBER was refused/, 'the seat is told');
  assert.match(told, /card #7 is the vocabulary one/, 'which line');
  assert.match(told, /no tool returned that card/, 'and why');
  assert.match(told, /claims card #7/, 'the reason is VERBATIM — it names the unfetched card, so the repair is one fetch (a summarised "refused" would fail here)');
  const quiet = JSON.stringify(buildMessages({ agent: AGENT, wake, refusedMemory: [] }));
  assert.doesNotMatch(quiet, /REMEMBER was refused/, 'no refusal → no block');
});

test('#1441 END TO END — wake 1 is refused on the board; wake 2 reads it back from the board and is told', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    await oneWake(srv, { text: 'REPLY: noted.\nREMEMBER: card #7 is the vocabulary one' });
    const priorRefusals = async (seat) => (await api(srv.baseUrl, 'GET', `/api/model-calls?agent=${seat}&limit=1`)).body.calls[0]?.memoryRefused ?? [];
    let seen = null;
    const mention = (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@gizmo again', author: 'bo' })).body;
    await guestOnce({ agent: AGENT, wake: mention, priorRefusals, memories: async () => [],
      callModel: async (_model, messages) => { seen = JSON.stringify(messages); return { text: 'REPLY: ok', toolCalls: [], stopReason: 'stop', usage: {} }; },
      post: (b) => api(srv.baseUrl, 'POST', '/api/conversations', b).then((r) => r.body),
      ledgerSink: async (row) => (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, AGENT))).body,
      ledgerFile: `/tmp/never-used-1441b-${process.pid}.jsonl` });
    assert.match(seen, /REMEMBER was refused/, 'the second wake was told');
    assert.match(seen, /claims card #7/, 'with the card it names');
    const row = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo&limit=1')).body.calls[0];
    assert.equal(row.memory.refusalsHanded, 1, 'DONE WHEN is observable on the BOARD: the second call\'s row says it was handed one refusal');
  } finally { await srv.stop(); }
});

test('#1441 RANGE — refused, then a quiet wake with no REMEMBER, then a FAILED call: the refusal is still handed on the wake after', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const fromBoard = async () => refusalsSince((await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo&limit=10')).body.calls);
    await oneWake(srv, { text: 'REPLY: noted.\nREMEMBER: card #7 is the vocabulary one' });          // refused
    await oneWake(srv, { text: 'REPLY: nothing to keep.' });                                          // quiet: told, did not re-write
    await api(srv.baseUrl, 'POST', '/api/model-calls', { by: 'gizmo', agent: 'gizmo', model: 'm', cost: 0, ok: false, error: 'fetch failed', at: new Date(Date.now() + 5_000).toISOString() });
    let got = await fromBoard();
    assert.equal(got.length, 1, `still handed after a quiet wake and a failed call: ${JSON.stringify(got)}`);
    assert.match(got[0].reason, /claims card #7/);
    // …and it clears once the seat SUCCEEDS in writing memory
    await oneWake(srv, { text: 'REPLY: fixed.\nREMEMBER: the vocabulary card is the one I was told about' });
    got = await fromBoard();
    assert.deepEqual(got, [], 'a successful memory write is the boundary');
  } finally { await srv.stop(); }
});

test('#1441 RANGE (pure) — ok:false rows are skipped, a writing row bounds the walk and contributes its own refusals, capped at 5', () => {
  const r = (line) => ({ line, reason: `claims card ${line}` });
  const calls = [
    { ok: false, memoryRefused: [r('#x')] },                               // failed: skipped entirely
    { ok: true, memoryRefused: [r('#1')], memoryWritten: [] },
    { ok: true, memoryRefused: [r('#2')], memoryWritten: ['m9'] },         // wrote: boundary, its refusal counts
    { ok: true, memoryRefused: [r('#3')], memoryWritten: [] },             // older than the boundary: not handed
  ];
  assert.deepEqual(refusalsSince(calls).map((m) => m.line), ['#1', '#2']);
  const many = [{ ok: true, memoryRefused: Array.from({ length: 9 }, (_, i) => r(`#${i}`)) }];
  assert.equal(refusalsSince(many).length, 5);
  assert.deepEqual(refusalsSince([{ ok: true, memoryWritten: ['{"error":"boom"}'], memoryRefused: [r('#e')] }, { ok: true, memoryRefused: [r('#f')] }]).map((m) => m.line), ['#e', '#f'],
    'a write that ERRORED is not a successful write — it does not bound the walk');
});
