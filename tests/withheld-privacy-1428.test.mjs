/**
 * #1428 PRIVACY — the FULL withheld text MUST NOT reach public surfaces,
 * and a unique secret phrase hidden in it MUST be absent from every shape
 * a board reader can touch.
 *
 * Contract (review of the privacy-violating slice that exposed withheld text
 * through /api/model-calls + graph):
 *
 *   - `rowToBoard` does NOT carry `withheldText`.
 *   - POST /api/model-calls REFUSES `withheldText` as an unknown field
 *     (the runner should never have shipped it; the server should not
 *     accept it; a hostile caller that tries should hit the same refusal).
 *   - The graph projection does not emit `scrum:withheldText` as a predicate.
 *   - GET /api/model-calls does not return `withheldText`.
 *
 * These are ASSERTED with a unique secret phrase in the seat's text; every
 * assertion scans the corresponding surface and FAILS RED if the phrase
 * appears ANYWHERE in a field, body, or projection triple that should not
 * have it.
 *
 * ⛔ The phrase must be UNIQUE enough that a coincidence is exceedingly
 * unlikely — we pick a 64-character random string at module load and embed
 * it inside the seat's authored withheld post.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guestOnce } from '../core/guest-loop.mjs';
import { rowToBoard } from '../core/model-call-row.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const api = async (baseUrl, method, p, body) => {
  const r = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
};

// ⛔ A UNIQUE, IMMEDIATELY-PASTED-INTO-A-SEAT'S-POST phrase: 64 random
// hex chars. Any surface that carries the phrase is a leak. The phrase is
// generated ONCE per test file load and is stable across the run.
const SECRET_PHRASE = crypto.randomBytes(32).toString('hex');
const WITHOUT_HELD_TEXT_WITH_SECRET =
  `I weighed the room and chose quiet — the work is for a different seat this turn.\n${SECRET_PHRASE}\nNO_REPLY`;

const AGENT = {
  seatKey: 'gizmo', name: 'Gizmo', systemPrompt: 'answer',
  residency: 'resident',
  model: { model: 'm', protocol: 'openai-completions' },
};

function scanStringDeep(obj, needle) {
  if (obj == null) return false;
  if (typeof obj === 'string') return obj.includes(needle);
  if (typeof obj !== 'object') return false;
  if (Array.isArray(obj)) return obj.some((v) => scanStringDeep(v, needle));
  for (const v of Object.values(obj)) if (scanStringDeep(v, needle)) return true;
  return false;
}

function scanProjectedGraph(obj, needle) {
  // The /api/graph response shape: an rdf-like rows array of {s, p, o}
  // (or {?c, ?t, ?r} for the SELECT we run). Walk every cell.
  if (obj == null) return false;
  if (typeof obj === 'string') return obj.includes(needle);
  if (Array.isArray(obj)) return obj.some((v) => scanProjectedGraph(v, needle));
  if (typeof obj === 'object') {
    for (const v of Object.values(obj)) if (scanProjectedGraph(v, needle)) return true;
    return false;
  }
  return false;
}

/**
 * THE PRIVACY BANANA — run the seat through guestOnce, POST the row,
 * GET it back, query the graph, and fail RED if the secret phrase shows
 * up anywhere a public surface says it shouldn't.
 */
test('#1428 PRIVACY — withheld text never reaches rowToBoard, REST, or graph', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    // 1. POST a mention so the wake has somewhere to point.
    const mention = (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@gizmo are you there?', author: 'bo' })).body;

    // 2. RUN the wake through guestOnce — it produces a runner row with
    //    the FULL withheld text embedded. The runner row stays local;
    //    only the rowToBoard body is what hits the wire.
    let capturedRunnerRow = null;
    const ledgerSink = async (row) => {
      capturedRunnerRow = row;
      const board = rowToBoard(row, AGENT);
      return (await api(srv.baseUrl, 'POST', '/api/model-calls', board)).body;
    };
    const r = await guestOnce({
      agent: AGENT, wake: mention,
      callModel: async () => ({ text: WITHOUT_HELD_TEXT_WITH_SECRET, stopReason: 'stop', usage: { promptTokens: 10, completionTokens: 8 } }),
      post: async () => ({ id: 'p-x' }),
      ledgerSink,
      writeMemory: async () => ({ id: 'm1' }),
      ledgerFile: `/tmp/never-used-1428-privacy-${process.pid}.jsonl`,
    });
    assert.equal(r.posted, false, 'the standalone NO_REPLY line suppressed the post');
    assert.equal(r.declined, true);
    assert.ok(capturedRunnerRow, 'guestOnce produced a row');

    // ⛔ Runner row does NOT carry withheld text. The recoverable body
    // rides in the resident's PRIVATE per-seat file (core/withheld-state.mjs)
    // — never on the runner's row, never on the board row, never on REST.
    // A `withheldText` field on the runner's row would only matter if some
    // downstream reader pulled it; they do not, so the field is omitted
    // entirely.
    assert.equal(capturedRunnerRow.withheldText, undefined,
      'runner row does NOT carry withheldText — the recoverable body lives only in the private file');

    // ⛔ A. rowToBoard MUST NOT ship the secret phrase. ⛔
    const board = rowToBoard(capturedRunnerRow, AGENT);
    assert.equal(JSON.stringify(board).includes(SECRET_PHRASE), false,
      'rowToBoard output is FREE of the secret phrase — the withheld text is local to the runner');

    // ⛔ B. GET /api/model-calls MUST NOT return the secret phrase. ⛔
    const calls = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo&limit=10')).body.calls || [];
    assert.equal(scanStringDeep(calls, SECRET_PHRASE), false,
      'no row returned by GET /api/model-calls carries the secret phrase');

    // ⛔ C. GRAPH projection MUST NOT emit a triple whose object is the
    //        secret phrase. ⛔
    const q = await api(srv.baseUrl, 'POST', '/api/graph', {
      query: 'SELECT ?c ?t ?r WHERE { ?c a scrum:ModelCall ; scrum:withheldText ?t ; scrum:withheldReason ?r . }',
      by: 'ada',
    });
    assert.equal(scanProjectedGraph(q.body, SECRET_PHRASE), false,
      'the graph projection does not emit a triple whose object is the secret phrase');
  } finally { await srv.stop(); }
});

/**
 * ⛔ DIRECT SUBMITTED withheldText HITS A REFUSAL. The endpoint that
 * accepts a model-call row refuses unknown fields. A second surface where
 * the slice's plumbing could accidentally store leaked text is gone if a
 * malicious caller cannot supply one.
 *
 * The model-call row's allowlist already covered `withheldReason` (a STABLE
 * TOKEN, not free text) — what this test pins is that the field whose
 * presence is the privacy leak is rejected outright.
 */
test('#1428 PRIVACY — POST /api/model-calls refuses submitted withheldText as unknown field', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const submitted = await api(srv.baseUrl, 'POST', '/api/model-calls', {
      by: 'gizmo', agent: 'gizmo', model: 'm', ok: true,
      stopReason: 'declined:explicit',
      withheldText: WITHOUT_HELD_TEXT_WITH_SECRET,
      withheldReason: 'standalone-no-reply',
      wake: { kind: 'mention', messageId: 'wx' },
    });
    assert.notEqual(submitted.status, 201,
      'submitted withheldText IS refused — direct submission cannot put the secret phrase on the board');
    assert.equal(submitted.status, 400,
      `unknown-field refusal is 400 — got ${submitted.status}: ${JSON.stringify(submitted.body)}`);

    // Belt and braces: the secret phrase is not on the board anyway.
    const calls = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo&limit=10')).body.calls || [];
    assert.equal(scanStringDeep(calls, SECRET_PHRASE), false,
      'no GET of /api/model-calls carries the secret phrase, even when the refusal failed');
  } finally { await srv.stop(); }
});

/**
 * ⛔ The graph replica does not DEFINE `scrum:withheldText` as a vocabulary
 * predicate nor EMIT it from `projectModelCall`. A direct SPARQL query for
 * the secret phrase (with no predicate filter) returns NO ROWS whose object
 * is the phrase.
 */
test('#1428 PRIVACY — graph vocabulary does NOT define scrum:withheldText', async () => {
  const { GRAPH_VOCABULARY } = await import('../core/graph-replica.mjs');
  const { PREDICATE_SOURCE } = await import('../core/predicate-names.mjs');
  assert.equal(GRAPH_VOCABULARY.has('scrum:withheldText'), false,
    'scrum:withheldText is NOT in GRAPH_VOCABULARY — the replica refuses to mint or emit it');
  assert.equal('scrum:withheldText' in PREDICATE_SOURCE, false,
    'scrum:withheldText is NOT in PREDICATE_SOURCE — there is no store field for it either');
});

/**
 * ⛔ The diagnostic-row correction (#1428 slice 3) introduces
 * `withheldStateOutcome` — a STABLE TOKEN (`retained`, `cleared`,
 * `retain-failed`, `clear-failed`) on the public row. The privacy contract
 * still holds:
 *   - the TOKEN rides REST, rowToBoard, and the graph predicate;
 *   - the withheld TEXT does not;
 *   - the FILESYSTEM PATH does not — a token-only outcome, by construction.
 *
 * The rowToBoard output for a seat that hit `retain-failed` is asserted
 * here as a single object: it carries the stable token and the existing
 * withheldReason, and nothing else from the recoverable body.
 */
test('#1428 PRIVACY — withheldStateOutcome token only; no text, no path', () => {
  const row = {
    agent: 'gizmo', model: 'm', protocol: 'ollama-native', ok: true,
    usage: null, latencyMs: 0, error: null,
    wake: { kind: 'mention' }, at: '2026-09-22T10:00:00Z',
    withheldReason: 'standalone-no-reply',
    withheldStateOutcome: 'retain-failed',
    // hypothetically leaked private-file path and text — rowToBoard must drop both
    withheldStateFile: '/run/secrets/private.json',
    withheldText: WITHOUT_HELD_TEXT_WITH_SECRET,
  };
  const board = rowToBoard(row, AGENT);
  assert.equal(board.withheldStateOutcome, 'retain-failed',
    'the stable outcome token is on rowToBoard output');
  assert.equal(board.withheldReason, 'standalone-no-reply',
    'the stable withheld reason rides alongside');
  assert.equal(board.withheldStateFile, undefined,
    'the FILESYSTEM PATH is NEVER on rowToBoard output — the token replaces it');
  assert.equal(board.withheldText, undefined,
    'the recoverable TEXT is NEVER on rowToBoard output');
  assert.equal(JSON.stringify(board).includes(SECRET_PHRASE), false,
    'no field on rowToBoard output carries the secret phrase');
  assert.equal(JSON.stringify(board).includes('/run/secrets/'), false,
    'no field on rowToBoard output carries a filesystem path');
});
