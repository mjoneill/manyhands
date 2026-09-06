/**
 * #1242 — a prompt that contradicts its grants is NAMED at the write, stored on
 * the node, and queryable. Fixtures are the three prompt versions the specimen
 * seat actually ran on 2026-09-06, quoted from the card, plus a second seat's
 * v1: the check must fire on exactly the pair that preceded the fabrication.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptGrantConflict, promptGrantWarning } from '../core/prompt-grants.mjs';
import { startRestServer } from './helpers/harness.mjs';

const V1 = 'You know nothing about it beyond what is in this message. Answer only from what you are handed. If you cannot do what is asked from what you were given, say exactly what you would need AND STOP; do not guess.';
const V2 = 'If you cannot answer from what you were handed, say in one sentence what you would need, AND STOP.';
const V3 = 'THE BOARD IS YOURS TO READ. You have tools for it and you never need permission to use them. When a question depends on what is written on this board, CALL THE TOOL FIRST. If the question needs something the board cannot give you, say that in one sentence.';
const OTHER_V1 = 'You can look things up before you answer. Use board_search when someone asks what the board says about a topic. Never say you searched, checked or found anything unless you actually called a tool on this turn. If you cannot answer and have no tool that would help, say so.';
const READS = ['card_get', 'board_search'];

test('#1242 the pure check fires on the specimen pair and on nothing coherent', () => {
  // The pair that preceded the fabrication: v2 + two read grants.
  const c = promptGrantConflict(V2, READS);
  assert.ok(c, 'v2 with grants is a contradiction');
  assert.match(c.phrase, /AND STOP/);
  // v1 is the same shape with more words.
  assert.ok(promptGrantConflict(V1, READS), 'v1 with grants is a contradiction');
  // ⛔ THE NEGATIVES ARE THE TEST. A check that fires on every prompt is a check nobody keeps on.
  assert.equal(promptGrantConflict(V3, READS), null, 'v3 invites tool use: no conflict');
  assert.equal(promptGrantConflict(OTHER_V1, READS), null, 'a prompt that mentions tools without forbidding them: no conflict');
  assert.equal(promptGrantConflict(V2, []), null, 'a stop-prompt on a seat with NO grants cancels nothing');
  assert.equal(promptGrantConflict('Do not use tools you were not granted.', READS)?.reason, 'tells the seat not to use its tools');
  assert.equal(promptGrantConflict('Stop signs are red.', READS), null, '"stop" alone is a word, not an instruction');
  const w = promptGrantWarning(c, READS);
  assert.match(w, /2 tool grants are in force/); assert.match(w, /warning, not a refusal/);
});

test('#1242 at the WRITE: create, PATCH grants, and a new prompt version each re-check; the node carries the finding; the write is never refused', async () => {
  const s = await startRestServer({});
  const call = async (method, p, body) => { const r = await fetch(`${s.baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, out: await r.json() }; };
  try {
    // 1. Create with a stop-prompt AND grants → 201 (landed), warning named, node flagged.
    let r = await call('POST', '/api/agents', { seatKey: 'probe', name: 'Probe', prompt: V2, by: 'sage', model: { model: 'gemma3:12b', protocol: 'ollama-native' }, toolGrants: READS });
    assert.equal(r.status, 201, JSON.stringify(r.out));
    assert.ok(r.out.conflict, 'the wire names the conflict');
    assert.match(r.out.conflict.phrase, /AND STOP/);
    assert.match(r.out.warning, /#1242/);

    // 2. Queryable: the seat is findable by the flag alone.
    const q = await call('POST', '/api/graph', { by: 'sage', query: 'PREFIX scrum: <https://scrumboard.local/ns#> SELECT ?seat ?phrase WHERE { ?a a scrum:Agent ; scrum:seatKey ?seat ; scrum:promptGrantConflict ?phrase }' });
    assert.equal(q.status, 200, JSON.stringify(q.out));
    assert.deepEqual(q.out.rows.map((x) => x.seat), ['probe'], 'one contradictory seat: ' + JSON.stringify(q.out.rows));

    // 3. A new prompt version that invites tool use clears it.
    r = await call('POST', '/api/agents/probe/prompt', { body: V3, by: 'sage' });
    assert.equal(r.status, 201); assert.equal(r.out.conflict, null, 'v3 clears the conflict'); assert.equal(r.out.warning, undefined);

    // 4. Grants change re-checks against the CURRENT prompt — still v3, still clean.
    r = await call('PATCH', '/api/agents/probe', { by: 'sage', toolGrants: [...READS, 'graph_query'] });
    assert.equal(r.status, 200); assert.equal(r.out.conflict, null);

    // 5. Back to the stop-prompt: flagged again, still 201 — a hobbled seat may be deliberate.
    r = await call('POST', '/api/agents/probe/prompt', { body: V1, by: 'sage' });
    assert.equal(r.status, 201); assert.ok(r.out.conflict); assert.equal(r.out.conflict.since, r.out.prompt.at, 'dated to the write that made it');

    // 6. Dropping every grant clears it: nothing to cancel.
    r = await call('PATCH', '/api/agents/probe', { by: 'sage', toolGrants: [] });
    assert.equal(r.status, 200); assert.equal(r.out.conflict, null);
    const q2 = await call('POST', '/api/graph', { by: 'sage', query: 'PREFIX scrum: <https://scrumboard.local/ns#> SELECT ?seat WHERE { ?a a scrum:Agent ; scrum:seatKey ?seat ; scrum:promptGrantConflict ?p }' });
    assert.deepEqual(q2.out.rows, [], 'cleared in the graph too');

    // The list route shows the same field, so a page can render it without a second call.
    const list = await (await fetch(`${s.baseUrl}/api/agents`)).json();
    assert.equal(list.find((a) => a.seatKey === 'probe').conflict, null);
  } finally { await s.stop(); }
});
