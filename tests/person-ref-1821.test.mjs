/**
 * #1821 — a person field (decidedBy, owner, author, declaredSeat) that is not a seat key
 * is REFUSED, naming the field, before anything is sent to the executor.
 *
 * Observed 2026-11-07: a prose `decidedBy` became an unescaped IRI inside the person
 * lookup's VALUES clause. The executor answered 400 (a parse error), and the read path
 * relabelled it UNAVAILABLE, so the caller saw 503 "graph executor unavailable" for its
 * own bad input. The replica path, given the same input, percent-encodes it into a
 * person node no seat key matches (four such nodes exist in the live graph).
 *
 * Rows (card #1821, resolved choice):
 *   R1  prose decidedBy  → REJECTED naming decidedBy; zero executor calls
 *   R2  prose owner on memory.create (the sibling path) → REJECTED naming owner; zero calls
 *   R3  prose author on a memory version → REJECTED naming author; zero calls
 *   R4  a valid seat key → proceeds to the executor and APPLIES
 *   R5  a fenced executor → still UNAVAILABLE (a real outage stays a 503)
 *   R7  through REST on a real executor: prose decidedBy and prose owner → HTTP 400
 *       naming the field, nothing written; a seat key → written
 *   R6  the rule itself: seat keys and clean IRIs pass; spaces, parens, colons and a
 *       double prefix do not
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startRestServer, freePort, PROJECT_DIR } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import {
  createLogbornUnit, memoryCreateIntention, decisionCreateIntention, personRefRefusal,
} from '../core/logborn-unit.mjs';

const now = '2026-11-07T00:00:00.000Z';
const PROSE = 'team (seat-a, seat-b, seat-c; seat-d not voted), recorded by seat-a';

/** A fake executor client that records every call, so "nothing was sent" is a count. */
function fakeSlice({ fenced = null } = {}) {
  const calls = [];
  const client = {
    async query(sparql) { calls.push({ op: 'query', sparql }); return { ok: true, rows: [] }; },
    async update(intention) { calls.push({ op: 'update', kind: intention.kind }); return { outcome: 'APPLIED', digest: 'd' }; },
    async reconcile(intention) { calls.push({ op: 'reconcile', kind: intention.kind }); return { outcome: 'ABSENT' }; },
  };
  return { calls, slice: { client, fence: async () => fenced, trialBypass: true } };
}
const unitOf = (slice) => createLogbornUnit({ slice, loadIri: async () => ({}), audit: () => {} });

const decision = (decidedBy) => decisionCreateIntention({
  actor: 'urn:ex:seat/alice',
  entity: { '@id': 'https://scrumboard.local/decision/d1', identifier: 'd1', 'scrum:statement': 's', 'scrum:decidedBy': decidedBy, dateCreated: now },
});
const memory = ({ owner = 'bob', author = 'bob' } = {}) => memoryCreateIntention({
  actor: 'urn:ex:seat/bob',
  identity: { '@id': 'https://scrumboard.local/memory/u1', '@type': 'scrum:Memory', identifier: 'u1', name: 't', 'scrum:owner': owner, 'scrum:currentVersion': 'https://scrumboard.local/memory/u1/v1' },
  versions: [{ '@id': 'https://scrumboard.local/memory/u1/v1', '@type': 'scrum:MemoryVersion', 'scrum:ofMemory': 'https://scrumboard.local/memory/u1', 'scrum:version': 1, 'scrum:body': 'b', author, dateCreated: now }],
});

test('#1821 R1: a prose decidedBy is REJECTED naming decidedBy, and nothing reaches the executor', async () => {
  const { calls, slice } = fakeSlice();
  const r = await unitOf(slice).write(decision(PROSE));
  assert.equal(r.outcome, 'REJECTED', `outcome was ${r.outcome}: ${r.reason}`);
  assert.match(r.reason, /decidedBy/, 'the refusal names the field');
  assert.match(r.reason, /seat key/, 'and says what the field needs');
  assert.deepEqual(calls, [], 'zero executor calls: the refusal comes before the person lookup');
});

test('#1821 R2: a prose owner on memory.create (the sibling path) is REJECTED naming owner, with zero executor calls', async () => {
  const { calls, slice } = fakeSlice();
  const r = await unitOf(slice).write(memory({ owner: 'bob (on behalf of the team)' }));
  assert.equal(r.outcome, 'REJECTED', `outcome was ${r.outcome}: ${r.reason}`);
  assert.match(r.reason, /owner/);
  assert.deepEqual(calls, []);
});

test('#1821 R3: a prose author on a memory version is REJECTED naming author, with zero executor calls', async () => {
  const { calls, slice } = fakeSlice();
  const r = await unitOf(slice).write(memory({ author: 'person:carol' }));
  assert.equal(r.outcome, 'REJECTED', `outcome was ${r.outcome}: ${r.reason}`);
  assert.match(r.reason, /author/);
  assert.deepEqual(calls, []);
});

test('#1821 R4: a valid seat key proceeds to the executor and APPLIES (the control: the guard does not refuse good input)', async () => {
  const { calls, slice } = fakeSlice();
  const r = await unitOf(slice).write(decision('alice'));
  assert.equal(r.outcome, 'APPLIED', `outcome was ${r.outcome}: ${r.reason}`);
  assert.ok(calls.some((c) => c.op === 'query'), 'the person lookup ran');
  assert.ok(calls.some((c) => c.op === 'update' && c.kind === 'decision.create'), 'the update was sent');
});

test('#1821 R5: a fenced executor is still UNAVAILABLE, even for prose input (an outage is not a bad request)', async () => {
  const { calls, slice } = fakeSlice({ fenced: 'executor fenced for a restore' });
  const r = await unitOf(slice).write(decision('alice'));
  assert.equal(r.outcome, 'UNAVAILABLE');
  assert.deepEqual(calls, []);
});

test('#1821 R6: the rule — seat keys and clean IRIs pass; prose, colons and a double prefix do not', () => {
  for (const ok of ['alice', 'bob', 'carol', 'seat-a', 'not-a-seat-probe', 'a-b_c-1', 'https://scrumboard.local/person/alice']) {
    assert.equal(personRefRefusal('decidedBy', ok), null, `${ok} should pass`);
  }
  for (const bad of [PROSE, 'carol (thread 2026-01-02T03:04:05Z: "quoted words")', 'person:carol', '2026-01-02T03:04:05Z', 'Alice', 'a.b', '', ' alice', 'alice ', 'https://scrumboard.local/person/a b', 'https://scrumboard.local/person/']) {
    const why = personRefRefusal('decidedBy', bad);
    assert.ok(why && /decidedBy/.test(why), `${JSON.stringify(bad)} should be refused naming the field; got ${why}`);
  }
});

// ── R7: the real route, the real executor ─────────────────────────────────────
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const TOK = mintToken();
let SRV, DIR;
before(async () => {
  if (SKIP) return;
  const d = DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pr1821-'));
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const tokens = path.join(d, 'seat-tokens.json');
  fs.writeFileSync(tokens, JSON.stringify({ seats: { bob: { credentials: [{ tokenHash: hashToken(TOK), scope: 'act', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } }));
  const store = path.join(d, 'store');
  const dsid = 'pr1821';
  const init = spawnSync(PY, ['-c', `import pyoxigraph as px\ns = px.Store(${JSON.stringify(store)})\ns.update('INSERT DATA { GRAPH <urn:scrum:bookkeeping:executor> { <urn:ex:dataset> <urn:ex:datasetId> "${dsid}" ; <urn:ex:epoch> 1 ; <urn:ex:commitSeq> 0 } }')\ns.flush()`]);
  assert.equal(init.status, 0, String(init.stderr));
  SRV = await startRestServer({ env: {
    SCRUM_GRAPH_EXECUTOR_URL: `http://127.0.0.1:${await freePort()}`, SCRUM_GRAPH_DATASET_ID: dsid,
    SCRUM_TRIAL_EXECUTOR_STORE: store, GRAPH_EXECUTOR_PYTHON: PY, SCRUM_SEAT_TOKENS: tokens, SCRUM_GRAPH_UNIT_LOGBORN: '1',
  } });
  for (let i = 0; i < 200; i++) {
    const c = await (await fetch(`${SRV.baseUrl}/api/trial/counters`)).json().catch(() => ({}));
    if (c.executor) break;
    await new Promise((r) => setTimeout(r, 50));
  }
});
after(async () => { await SRV?.stop(); if (DIR) fs.rmSync(DIR, { recursive: true, force: true }); });   // #1672: this file's own temp, and only that
const call = async (method, p, body) => {
  const r = await fetch(`${SRV.baseUrl}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOK}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const listOf = (b, k) => (Array.isArray(b) ? b : b?.[k] ?? []);

test('#1821 R7: through REST on a real executor — prose decidedBy and prose owner are HTTP 400 naming the field and write nothing; a seat key is written', { skip: SKIP }, async () => {
  const d = await call('POST', '/api/decisions', { statement: 'r7-prose', decidedBy: PROSE, constrains: ['t1821'], reopensIf: 'a test reopens it' });
  assert.equal(d.status, 400, `status ${d.status}: ${JSON.stringify(d.body)}`);
  assert.equal(d.body?.code, 'GRAPH_WRITE_REJECTED', JSON.stringify(d.body));
  assert.match(d.body?.error ?? '', /decidedBy must be a seat key/);
  const m = await call('POST', '/api/memories', { owner: 'bob (for the team)', title: 'r7-prose', body: 'b' });
  assert.equal(m.status, 400, `status ${m.status}: ${JSON.stringify(m.body)}`);
  assert.match(m.body?.error ?? '', /owner must be a seat key/);
  const ok = await call('POST', '/api/decisions', { statement: 'r7-key', decidedBy: 'bob', constrains: ['t1821'], reopensIf: 'a test reopens it' });
  assert.ok(ok.status >= 200 && ok.status < 300, `status ${ok.status}: ${JSON.stringify(ok.body)}`);
  const decisions = listOf((await call('GET', '/api/decisions')).body, 'decisions').map((x) => x['scrum:statement'] ?? x.statement);
  assert.ok(decisions.includes('r7-key'), 'the seat-key decision was written');
  assert.ok(!decisions.includes('r7-prose'), 'the refused decision was not');
  const memories = listOf((await call('GET', '/api/memories')).body, 'memories').map((x) => x.title);
  assert.ok(!memories.includes('r7-prose'), 'the refused memory was not written');
});
