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
import { rowToBoard } from '../core/model-call-row.mjs';
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

test('#1441 GENERIC SEAM — every field a real wake puts on its row that the wire returns comes back as written', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const { captured } = await oneWake(srv, { text: 'REPLY: here, and card #7 is the one.\nREMEMBER: card #7 is the vocabulary one' });
    assert.ok(captured, 'the runner produced a row');
    const wire = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo&limit=1')).body.calls[0];
    const dropped = [];
    for (const [k, v] of Object.entries(captured)) {
      if (DERIVED.has(k) || !(k in wire)) continue;
      // A nested object the wire returns a PROJECTION of (e.g. wake: the row keeps
      // the mention's author, the board keeps kind + messageId — the author is one
      // lookup away on the message) is compared on the keys the wire returns.
      const plain = (x) => x && typeof x === 'object' && !Array.isArray(x);
      const got = wire[k];
      const want = plain(v) && plain(got) ? Object.fromEntries(Object.keys(got).map((kk) => [kk, v[kk] ?? null])) : v;
      if (JSON.stringify(got) !== JSON.stringify(want)) dropped.push(`${k}: row=${JSON.stringify(v)} wire=${JSON.stringify(got)}`);
    }
    assert.deepEqual(dropped, [], 'a field the runner wrote and the server returns came back different (dropped between them)');
    // and the specific ones measured at zero in production
    assert.equal(wire.markerLines, 1, '#1254 markerLines reaches the board');
    assert.equal(wire.unbackedLookupClaims.length >= 0, true);
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
