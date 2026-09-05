/**
 * #1208 (slice 3 of #1205) — THE THIN SLICE, from a STRANGER'S position.
 *
 * The acceptance is not "the data is there". It is that someone who has never
 * seen this board can ask what has been researched WITHOUT being handed a card
 * number or a filename — the two things a newcomer cannot possibly have.
 *
 * So these drive the three README queries through the live graph endpoint, and
 * the control that matters: the research query must not be able to return the
 * board's own write activity. On prod that is 21,534 activities of which one is
 * a run, and if the separation were leaky the query would answer with a large,
 * confident, wrong number rather than an obviously wrong one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { EVENT_OPS } from '../core/event-log.mjs';

const api = async (baseUrl, method, path, body) => {
  const r = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
};

const board = () => makeBoardFixture({
  cards: [
    { id: 'u-1', shortId: 1, title: 'a card the research produced', description: '', type: 'task',
      labels: [], assignees: [], column: 'backlog', order: 1,
      createdAt: '2026-08-01T00:00:00.000Z', relationships: {} },
  ],
  nextShortId: 2,
});

/** The whole chain, exactly as a seat would record it. */
async function seedRun(s) {
  const proc = await api(s.baseUrl, 'POST', '/api/procedures', {
    name: 'research a YouTube video', by: 'ada',
    body: 'Archive the raw bytes before reading them. Verify every claim against a primary source.',
  });
  const run = await api(s.baseUrl, 'POST', '/api/runs', {
    op: 'research', by: 'ada', participants: ['bo'],
    performedUsing: proc.body.version.id,
    used: ['https://www.youtube.com/watch?v=EXAMPLE'],
  });
  await api(s.baseUrl, 'POST', '/api/artifacts', {
    run: run.body.id, by: 'ada',
    contentUrl: 'file:///research/2026-09-05-example-transcript.md',
    encodingFormat: 'text/markdown', contentHash: `sha256:${'c'.repeat(64)}`,
  });
  await api(s.baseUrl, 'POST', '/api/runs/generated', { run: run.body.id, by: 'ada', nodes: [1] });
  return { proc, run };
}

const q = async (s, query) => {
  const r = await fetch(`${s.baseUrl}/api/graph`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return r.json();
};

test('#1208 board_status answers "how much research" with NO card number and NO filename', async (t) => {
  const s = await startRestServer({ board: board() });
  t.after(() => s.stop());

  const before = await api(s.baseUrl, 'GET', '/api/board/status');
  assert.equal(before.body.researchRuns, 0,
    'a board with no research says zero — and says it, rather than omitting the field, so a '
    + 'stranger can tell "none yet" from "this board does not track that"');

  await seedRun(s);
  const after = await api(s.baseUrl, 'GET', '/api/board/status');
  assert.equal(after.body.researchRuns, 1);
});

test('#1208 query 1 — what research happened, and when', async (t) => {
  const s = await startRestServer({ board: board() });
  t.after(() => s.stop());
  await seedRun(s);

  const res = await q(s, 'SELECT ?r ?t WHERE { ?r a prov:Activity ; scrum:op "research" ; prov:startedAtTime ?t }');
  assert.equal(res.truncated, false, 'the README prints this verbatim — it must not be a truncated answer');
  assert.equal(res.rows.length, 1);
  assert.match(res.rows[0].t, /^\d{4}-\d{2}-\d{2}T/, 'with a real timestamp, not a placeholder');
});

test('#1208 query 2 — what files, and are they still those files', async (t) => {
  const s = await startRestServer({ board: board() });
  t.after(() => s.stop());
  await seedRun(s);

  const res = await q(s, `SELECT ?u ?h WHERE {
    ?r a prov:Activity ; scrum:op "research" ; prov:generated ?a .
    ?a schema:contentUrl ?u ; scrum:contentHash ?h }`);
  assert.equal(res.truncated, false);
  assert.equal(res.rows.length, 1);
  assert.match(res.rows[0].u, /^file:\/\/\/research\//);
  assert.match(res.rows[0].h, /^sha256:[0-9a-f]{64}$/,
    'pointer AND hash — a URL alone is a promise nobody can check');
});

test('#1208 query 3 — what did the research CHANGE', async (t) => {
  const s = await startRestServer({ board: board() });
  t.after(() => s.stop());
  await seedRun(s);

  const res = await q(s, `SELECT ?id ?title WHERE {
    ?r a prov:Activity ; scrum:op "research" ; prov:generated ?c .
    ?c a scrum:Card ; schema:identifier ?id ; schema:name ?title }`);
  assert.equal(res.truncated, false);
  assert.equal(res.rows.length, 1, 'the card the run produced, found from the run');
  assert.equal(String(res.rows[0].id), '1');
  // ⭐ This is the query worth stealing: a summary nobody acted on is a summary
  // nobody needed, and this is how you find out which kind you wrote.
  assert.match(res.rows[0].title, /produced/);
});

test('#1208 ⭐ THE CONTROL — the research query cannot return the board\'s own writes', async (t) => {
  const s = await startRestServer({ board: board() });
  t.after(() => s.stop());
  await seedRun(s);

  // Every seeding call above already wrote events, so the board has real write
  // activity beside the run — this control runs against a populated log rather
  // than an empty one, which is the only version of it that means anything.
  const all = await q(s, 'SELECT (COUNT(DISTINCT ?a) AS ?n) WHERE { ?a a prov:Activity }');
  const total = Number(all.rows[0].n);
  assert.ok(total > 1, `the board must hold write activity beside the run (got ${total}) — a control `
    + 'run against a population of one proves nothing');

  const research = await q(s, 'SELECT (COUNT(DISTINCT ?a) AS ?n) WHERE { ?a a prov:Activity ; scrum:op "research" }');
  assert.equal(Number(research.rows[0].n), 1, 'exactly the run, out of every activity on the board');

  // And structurally, not just observed once: a run cannot take an event op.
  for (const op of EVENT_OPS) {
    const r = await api(s.baseUrl, 'POST', '/api/runs', { op, by: 'ada' });
    assert.equal(r.status, 400, `a run carrying the event op "${op}" must be refused at the door`);
  }
});

test('#1208 the run names the VERSION it followed, so the method is data too', async (t) => {
  const s = await startRestServer({ board: board() });
  t.after(() => s.stop());
  const { proc } = await seedRun(s);

  // Improve the method AFTER the run.
  await api(s.baseUrl, 'POST', '/api/procedure-versions', {
    procedure: proc.body.id, by: 'bo', body: 'Revised: ask what caption tracks EXIST before asking for content.',
  });

  const res = await q(s, `SELECT ?body WHERE {
    ?r a prov:Activity ; scrum:op "research" ; scrum:performedUsing ?v . ?v scrum:body ?body }`);
  assert.equal(res.rows.length, 1);
  assert.match(res.rows[0].body, /Archive the raw bytes/,
    'the run must still resolve to what it ACTUALLY followed — if improving a method rewrote '
    + 'history, the record would say every past run used today\'s best practice');
  assert.doesNotMatch(res.rows[0].body, /Revised/);
});
