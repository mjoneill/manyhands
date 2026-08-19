/**
 * #918 — a decision is a CONSTRAINT ON FUTURE WORK, and this room had nowhere
 * to put one.
 *
 * ⛔ Four durable rulings were made on 2026-08-19 alone, and every one of them
 * lived only in a commons post:
 *
 *     membership is ASSERTED, never inferred from a label
 *     isPartOf is read as TRANSITIVE by this board, BY CHOICE
 *     irreversibility is a GATE, not a rank
 *     announcing a restart is NOT a mitigation
 *
 * ⇒ "What has this room decided, and what is still open?" had no answer but a
 * human re-reading scrollback — which is §IV's own thesis (prose stores, graph
 * retrieves) failing on the room's most durable output. Some of that day's ten
 * re-derivations were DECISIONS re-argued from scratch, not cards re-filed.
 *
 * ── WHAT MAKES IT A TYPE AND NOT A CARD ────────────────────────────────────
 *
 *     a card       column · claim · assignee · done
 *     a decision   none of those. Statement · decider · when · what it
 *                  CONSTRAINS · and what would REOPEN it.
 *
 * ⭐ `reopensIf` is the field prose never carries and the reason this is worth
 * building. A ruling is only safe to INHERIT if the next reader can see what
 * evidence would overturn it. Without it a decision is either re-argued from
 * scratch or obeyed superstitiously, and this room has done both.
 *
 * ── THE ACCEPTANCE THAT DECIDES WHETHER THE TYPE EARNED ITS PLACE ──────────
 *
 * From the card, and it is stricter than "can you store one":
 *
 *   "Record two rulings, then answer 'what constrains how membership is
 *    assigned?' in ONE query. If the answer requires knowing which decision to
 *    look for, the type is a filing cabinet and not a retrieval mechanism."
 *
 * ⇒ So `constrains` is a queryable TOPIC, not a sentence. A reader who has
 * never heard of the ruling must be able to find it by naming the thing they
 * are about to do.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPair, mcpSession } from './helpers/harness.mjs';

const post = async (baseUrl, body) => {
  const r = await fetch(`${baseUrl}/api/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

const MEMBERSHIP = {
  statement: 'Membership is ASSERTED by whoever is organising, never inferred from a label.',
  decidedBy: 'ada',
  constrains: ['membership', 'labels'],
  reopensIf: 'someone demonstrates a labelling scheme whose meaning is guaranteed by the system rather than by convention',
};

const TRANSITIVE = {
  statement: 'isPartOf is read as transitive on this board, by choice rather than by definition.',
  decidedBy: 'grace',
  constrains: ['membership', 'traversal'],
  reopensIf: 'any isPartOf edge is asserted between two entities of different rdf:type',
};

test('#918 ⭐ THE ACCEPTANCE: find the ruling by naming the thing you are about to do', async () => {
  // The reader has never heard of these decisions. They are about to assign
  // membership and want to know what constrains that. One query, no prior
  // knowledge of which decision exists.
  const p = await startPair();
  try {
    assert.equal((await post(p.rest.baseUrl, MEMBERSHIP)).status, 201);
    assert.equal((await post(p.rest.baseUrl, TRANSITIVE)).status, 201);

    const session = await mcpSession(p.mcp.mcpUrl);
    const r = await session.callTool('graph_query', {
      by: 'ada',
      query: 'SELECT ?statement ?reopensIf WHERE { ?d a scrum:Decision ; scrum:constrains ?topic ; '
           + 'scrum:statement ?statement ; scrum:reopensIf ?reopensIf . '
           + 'FILTER(CONTAINS(LCASE(?topic), "membership")) }',
    });
    const out = JSON.parse(r.result.content[0].text);
    assert.equal(out.rows.length, 2,
      'both rulings constrain membership and both must be findable by that word alone — '
      + `got ${JSON.stringify(out.rows).slice(0, 200)}`);
    assert.ok(out.rows.every((row) => row.reopensIf),
      'and every one arrives WITH its reopening condition, or the reader inherits a rule they cannot question');
  } finally { await p.stop(); }
});

test('#918 ⛔ a decision with no reopensIf is REFUSED, not stored blank', async () => {
  // Acceptance 3, and the card's reasoning is the point: an optional field on a
  // write path this room uses will be omitted. reopensIf is the whole difference
  // between a decision and an opinion.
  const p = await startPair();
  try {
    const { reopensIf, ...without } = MEMBERSHIP;
    const res = await post(p.rest.baseUrl, without);
    assert.equal(res.status, 400, 'a ruling nobody can overturn is an opinion with a timestamp');
    assert.match(JSON.stringify(res.body), /reopens/i);

    const blank = await post(p.rest.baseUrl, { ...MEMBERSHIP, reopensIf: '   ' });
    assert.equal(blank.status, 400, 'and whitespace is not an answer');
  } finally { await p.stop(); }
});

test('#918 `constrains` must be a non-empty list — a decision constraining nothing is unfindable', async () => {
  // ⚠️ Stored with no topic, a decision is invisible to the only query that
  // matters. That is the filing-cabinet failure the acceptance names, so it is
  // refused at the door rather than discovered later by a reader who finds
  // nothing and concludes nothing constrains them.
  const p = await startPair();
  try {
    assert.equal((await post(p.rest.baseUrl, { ...MEMBERSHIP, constrains: [] })).status, 400);
    assert.equal((await post(p.rest.baseUrl, { ...MEMBERSHIP, constrains: 'membership' })).status, 400,
      'a bare string is refused rather than coerced — one topic and a list of one are different claims');
  } finally { await p.stop(); }
});

test('#918 ROUND-TRIP: every field survives the write path (#823)', async () => {
  // #823 — MCP writes silently discard unknown fields; 29 schemas, zero
  // .strict(). A reopensIf that vanishes in transit produces a decision that
  // LOOKS complete and is unfalsifiable, which is worse than a refused write.
  const p = await startPair();
  try {
    const made = await post(p.rest.baseUrl, MEMBERSHIP);
    assert.equal(made.status, 201);

    const session = await mcpSession(p.mcp.mcpUrl);
    const r = await session.callTool('graph_query', {
      by: 'ada',
      query: `SELECT ?s ?who ?reopens ?when (GROUP_CONCAT(?t;separator="|") AS ?topics) WHERE { `
           + `?d a scrum:Decision ; scrum:statement ?s ; scrum:decidedBy ?who ; `
           + `scrum:reopensIf ?reopens ; scrum:constrains ?t ; schema:dateCreated ?when } `
           + 'GROUP BY ?s ?who ?reopens ?when',
    });
    const row = JSON.parse(r.result.content[0].text).rows[0];
    assert.ok(row, 'the decision must be in the graph, not only in the JSON store');
    assert.equal(row.s, MEMBERSHIP.statement, 'the statement survives verbatim');
    assert.equal(row.who, 'person:ada', 'the decider is an EDGE to a person, not a string');
    assert.equal(row.reopens, MEMBERSHIP.reopensIf, 'reopensIf survives — the field most likely to be dropped');
    assert.deepEqual(row.topics.split('|').sort(), ['labels', 'membership']);
    assert.ok(row.when, 'and when it was decided');
  } finally { await p.stop(); }
});

test('#918 the statement and decider are required', async () => {
  const p = await startPair();
  try {
    const { statement, ...noStatement } = MEMBERSHIP;
    assert.equal((await post(p.rest.baseUrl, noStatement)).status, 400);
    const { decidedBy, ...noDecider } = MEMBERSHIP;
    assert.equal((await post(p.rest.baseUrl, noDecider)).status, 400,
      'a ruling with no decider cannot be weighed by whoever inherits it');
  } finally { await p.stop(); }
});

test('#918 ⭐ WRITABLE BY AN MCP-ONLY SEAT — #904, not repeated', async () => {
  // #651 shipped a node type the seats it was built for could not write to for
  // weeks. This card says explicitly: ships its agent-reachable write path or it
  // is not done.
  const p = await startPair();
  try {
    const session = await mcpSession(p.mcp.mcpUrl);
    const r = await session.callTool('decision_create', TRANSITIVE);
    const text = r.result?.content?.[0]?.text;
    assert.ok(text && !r.result?.isError, `decision_create failed: ${JSON.stringify(r).slice(0, 300)}`);
    const made = JSON.parse(text);
    assert.equal(made.reopensIf, TRANSITIVE.reopensIf,
      'and reopensIf survives the MCP path specifically — zod strips unknown keys silently (#823)');

    const listed = await session.callTool('decision_list', { constrains: 'traversal' });
    const rows = JSON.parse(listed.result.content[0].text);
    assert.equal(rows.length, 1, 'and an MCP seat can find it by topic without knowing it exists');
  } finally { await p.stop(); }
});

test('#918 listing by an unknown topic returns an EMPTY LIST, not an error', async () => {
  // ⚠️ "Nothing constrains this" is a real and common answer — most topics have
  // no ruling. It must not look like a failure, or a reader learns to distrust
  // the empty case and stops asking.
  const p = await startPair();
  try {
    await post(p.rest.baseUrl, MEMBERSHIP);
    const r = await fetch(`${p.rest.baseUrl}/api/decisions?constrains=nothing-has-this-topic`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), []);
  } finally { await p.stop(); }
});
