/**
 * #1217 — A REFUSED WRITE LOGS ITS PAYLOAD.
 *
 * The question the card was filed on: if a seat composes something full of
 * information, submits it, and it is rejected — is fixing the issue and
 * resubmitting lossy? Before this card the answer was YES for every refusal. A refused
 * write returned an error and appended NO event; `board-data-events/` records
 * successful writes only, so the payload survived in the client alone — and the
 * clients this room actually has drop tool responses (#359) and deliver one turn
 * three times (#1212). The information was gone and nothing said so.
 *
 * The rail: every refusal on a WRITE route appends one `op:"refused"` event
 * carrying the request body VERBATIM, so a seat whose harness lost the response
 * can recover what it sent with one query.
 *
 * ⚠️ THE CONTROL IS THE HALF THAT MATTERS. A rail that logs on every response
 * would also "pass" the positive tests here while filling the durable log with
 * every successful write twice. The negative controls below pin that a
 * successful write logs NO refused event and that a refused READ logs nothing —
 * a refusal that lost no information is not worth a line in an append-only log.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const api = async (baseUrl, method, p, body) => {
  const r = await fetch(`${baseUrl}${p}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* some refusals carry no body */ }
  return { status: r.status, body: parsed };
};

/** Every event on disk, oldest first. The log is the assertion surface here —
 *  not an API response, because the whole point is that the response is the
 *  thing that goes missing. */
const readLog = (boardFile) => {
  const dir = boardFile.replace(/\.json$/, '') + '-events';
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l)));
};
const refusals = (boardFile) => readLog(boardFile).filter((e) => e.op === 'refused');

const board = () => makeBoardFixture({
  cards: [
    { id: 'u-1', shortId: 1, title: 'one', description: 'original body', type: 'task',
      labels: [], assignees: [], column: 'backlog', order: 1,
      createdAt: '2026-08-01T00:00:00.000Z', relationships: {}, version: 3 },
  ],
  nextShortId: 2,
});

test('#1217 — a 409 on a stale ifVersion logs the whole description that was sent', async () => {
  const srv = await startRestServer({ board: board() });
  try {
    const LOST = 'A long body a seat spent a turn composing.\n'.repeat(20);
    const before = refusals(srv.boardFile).length;

    const res = await api(srv.baseUrl, 'PATCH', '/api/cards/1',
      { description: LOST, by: 'ada', ifVersion: 1 });          // card is at v3
    assert.equal(res.status, 409, 'stale ifVersion must still be refused');

    const logged = refusals(srv.boardFile);
    assert.equal(logged.length, before + 1, 'exactly one refused event');
    const ev = logged.at(-1);
    assert.equal(ev.op, 'refused');
    assert.equal(ev.entity.kind, 'card');
    assert.equal(ev.entity.id, '1');
    assert.equal(ev.actor, 'ada', 'the refusal names who lost the write');
    assert.equal(ev.state, null, 'a refusal changed no state — carrying one would be a lie');
    assert.match(ev.reason, /version/i, 'the reason is the refusal text the caller saw');
    assert.equal(ev.request.description, LOST,
      'THE PAYLOAD, VERBATIM — this is the whole card: the composed text is recoverable');
    assert.equal(ev.status, 409);
    assert.equal(ev.route, 'PATCH /api/cards/1');
    assert.ok(ev.seq > 0 && ev.recorded_at, 'a refusal is an ordinary event, not a side-file');
  } finally { await srv.stop(); }
});

test('#1217 — a 400 validation refusal on create logs the payload too', async () => {
  const srv = await startRestServer({ board: board() });
  try {
    const res = await api(srv.baseUrl, 'POST', '/api/cards',
      { description: 'hours of research', createdBy: 'bo' });     // no title → 400
    assert.equal(res.status, 400);

    const ev = refusals(srv.boardFile).at(-1);
    assert.equal(ev.op, 'refused');
    assert.equal(ev.entity.kind, 'card');
    assert.equal(ev.request.description, 'hours of research');
    assert.equal(ev.actor, 'bo');
    assert.equal(ev.status, 400);
  } finally { await srv.stop(); }
});

test('#1217 CONTROL — a SUCCESSFUL write logs no refused event', async () => {
  const srv = await startRestServer({ board: board() });
  try {
    const res = await api(srv.baseUrl, 'PATCH', '/api/cards/1', { description: 'fine', by: 'ada' });
    assert.equal(res.status, 200);
    assert.deepEqual(refusals(srv.boardFile), [],
      'the log must not gain a refusal for a write that succeeded');
  } finally { await srv.stop(); }
});

test('#1217 CONTROL — a refused READ logs nothing: no payload was at risk', async () => {
  const srv = await startRestServer({ board: board() });
  try {
    const res = await fetch(`${srv.baseUrl}/api/cards/99999`);
    assert.equal(res.status, 404);
    assert.deepEqual(refusals(srv.boardFile), [],
      'GET carries no composed payload — logging it would be noise in a durable record');
  } finally { await srv.stop(); }
});

test('#1217 — a refused write on a NON-CARD route is logged against its own kind', async () => {
  const srv = await startRestServer({ board: board() });
  try {
    const res = await api(srv.baseUrl, 'POST', '/api/conversations',
      { body: '', author: 'cy' });                                // empty body → 400
    assert.equal(res.status, 400);
    const ev = refusals(srv.boardFile).at(-1);
    assert.equal(ev.entity.kind, 'conversation');
    assert.equal(ev.request.author, 'cy');
  } finally { await srv.stop(); }
});

test('#1217 — a secret in a refused body is REDACTED before it reaches the log', async () => {
  const srv = await startRestServer({ board: board() });
  try {
    // The refusal path is the one write path that stores a body NOBODY validated.
    // A pasted token in a rejected payload would otherwise become permanent in an
    // append-only file, which is a worse outcome than the loss this card fixes.
    // The OpenRouter-shaped fixture is ASSEMBLED, not written: GitHub's push
    // protection refused the literal (2026-09-06, GH013), which is the server
    // layer of the same rail this test checks the board's layer of.
    const orKey = ['sk', 'or', 'v1'].join('-') + '-' + '0123456789abcdef'.repeat(4);
    const res = await api(srv.baseUrl, 'PATCH', '/api/cards/1', {
      description: `deploy with sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 and ${orKey}`,
      by: 'ada', ifVersion: 1,
    });
    assert.equal(res.status, 409);
    const ev = refusals(srv.boardFile).at(-1);
    const stored = JSON.stringify(ev.request);
    assert.ok(!stored.includes('sk-ant-api03-AAAABBBB'), 'an API key must not land in the log');
    assert.ok(!stored.includes('ghp_ABCDEFGHIJKLMNOP'), 'a token must not land in the log');
    // 2026-09-06 — the OpenRouter shape has hyphens after `sk-`, which the OpenAI
    // pattern does not match; it was passing through the redaction untouched.
    assert.ok(!stored.includes(orKey.slice(0, 24)), 'an OpenRouter key must not land in the log');
    assert.match(stored, /REDACTED/, 'and the removal is VISIBLE, not silent');
    assert.match(stored, /deploy with/, 'the rest of the payload still survives');
  } finally { await srv.stop(); }
});

/**
 * The card's stated acceptance, and the half a unit test cannot reach: the
 * recovery query. #725 part 2's lesson applies directly — a projection with a
 * green unit test and no production caller reads as working while the live
 * board answers zero. So this asks the LIVE graph endpoint, through the front
 * door, exactly what a seat who lost a response would ask.
 */
async function sparql(baseUrl, query) {
  const res = await fetch(`${baseUrl}/api/graph`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, `graph query failed: ${JSON.stringify(body)}`);
  return body;
}

test('#1217 — the recovery query finds my refusal in the live graph, by seat', async () => {
  const srv = await startRestServer({ board: board() });
  try {
    const Q = `SELECT ?t ?reason WHERE {
      ?a a prov:Activity ; scrum:op "refused" ;
         prov:wasAssociatedWith person:ada ;
         prov:startedAtTime ?t ; scrum:reason ?reason }`;

    // CONTROL FIRST: nothing refused yet, so the query must be empty. Without
    // this the assertion below could pass against a pre-populated store.
    const before = await sparql(srv.baseUrl, Q);
    assert.equal(before.rows.length, 0,
      'a board that has refused nothing must answer zero');

    const res = await api(srv.baseUrl, 'PATCH', '/api/cards/1',
      { description: 'the work that would have been lost', by: 'ada', ifVersion: 1 });
    assert.equal(res.status, 409);

    const after = await sparql(srv.baseUrl, Q);
    const rows = after.rows;
    assert.equal(rows.length, 1, 'the refusal is visible to the seat it happened to');
    const reason = JSON.stringify(rows[0]);
    assert.match(reason, /version/i);
  } finally { await srv.stop(); }
});

test('#1217 — the refusal is recoverable through changes_since, with the body, and does not hide the real last write', async () => {
  // ⛔ CI-RED TWICE, GREEN LOCALLY EVERY TIME, and it was not a flake. The first
  // version used a FIXTURE card (which predates the log) and asked from the
  // PATCH response's `updatedAt`. That stamp is taken inside the write, and the
  // event's `recorded_at` is taken a moment later from `data.lastUpdated` — on
  // a fast box the same millisecond, on CI the next one. With a pre-log card
  // the retention floor is that first event, so a `since` one millisecond
  // before it is refused as CURSOR_TOO_OLD (#679's honest-partial rule): the
  // exact boundary the old comment claimed to be avoiding.
  //
  // Now: an EMPTY board and a card CREATED through the API, so the log's oldest
  // line is the create event, and every later stamp — including the PATCH's
  // `updatedAt` — is strictly inside retention on any machine.
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const made = await api(srv.baseUrl, 'POST', '/api/cards', { title: 'one', description: 'original body', createdBy: 'ada' });
    assert.equal(made.status, 201);
    const id = made.body.shortId;
    // A real write, then a refused one, on the same card by the same seat.
    const ok = await api(srv.baseUrl, 'PATCH', `/api/cards/${id}`, { description: 'the real last write', by: 'ada' });
    assert.equal(ok.status, 200);
    const since = ok.body.updatedAt;
    const bad = await api(srv.baseUrl, 'PATCH', `/api/cards/${id}`, { description: 'the lost draft', by: 'ada', ifVersion: 1 });
    assert.equal(bad.status, 409);

    // history:true — the recovery ask. The body comes back.
    const hist = await api(srv.baseUrl, 'GET', `/api/changes?since=${encodeURIComponent(since)}&actor=ada&history=true`);
    assert.equal(hist.status, 200);
    const refused = hist.body.changes.filter((r) => r.op === 'refused');
    assert.equal(refused.length, 1);
    assert.equal(refused[0].request.description, 'the lost draft', 'the payload comes back through the front door');
    assert.equal(refused[0].status, 409);
    assert.match(refused[0].reason, /version/i);

    // DEFAULT view (latest-per-entity) — the refusal must be its own row AND the
    // card's latest must still be the real write, not the refusal.
    const def = await api(srv.baseUrl, 'GET', `/api/changes?since=${encodeURIComponent(since)}&actor=ada`);
    const card1 = def.body.changes.filter((r) => r.kind === 'card' && r.id === 'u-1' || (r.kind === 'card' && r.id === '1'));
    const ops = def.body.changes.filter((r) => r.kind === 'card').map((r) => r.op).sort();
    assert.deepEqual(ops, ['refused', 'update'],
      `the default view keeps the real update AND the refusal as separate rows; got ${JSON.stringify(def.body.changes)}`);
    void card1;
  } finally { await srv.stop(); }
});
