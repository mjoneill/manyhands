/**
 * #1207 (slice 2 of #1205) — THE RESEARCH WRITE VERBS.
 *
 * A card PATCH cannot say "this run generated that file". These can. #1206
 * registered the words; this is the write path that uses them, and these tests
 * drive it THROUGH THE FRONT DOOR — a running server, the real routes, the real
 * document round trip — because the two defects #1214 shipped both lived on a
 * boundary its tests stopped short of.
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
    { id: 'u-1', shortId: 1, title: 'a derived card', description: '', type: 'task',
      labels: [], assignees: [], column: 'backlog', order: 1,
      createdAt: '2026-08-01T00:00:00.000Z', relationships: {} },
  ],
  nextShortId: 2,
});

const PROC = { name: 'research a YouTube video', by: 'ada',
  body: 'Fetch the transcript. Read the primary sources. Record what you could not verify.' };

async function withServer(t) {
  const s = await startRestServer({ board: board() });
  t.after(() => s.stop());
  return s;
}

test('#1207 a procedure is created with its first version, identity separate from text', async (t) => {
  const s = await withServer(t);
  const c = await api(s.baseUrl, 'POST', '/api/procedures', PROC);
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.body.name, PROC.name);
  assert.ok(c.body.version?.id, 'a procedure is born with version 1');
  assert.equal(c.body.version.body, PROC.body);
  assert.equal(c.body.version.ofProcedure, c.body.id, 'the version points at its identity');

  const list = await api(s.baseUrl, 'GET', '/api/procedures');
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].versions.length, 1);
});

test('#1207 a revision adds a VERSION and leaves the identity untouched', async (t) => {
  const s = await withServer(t);
  const c = await api(s.baseUrl, 'POST', '/api/procedures', PROC);
  const v2 = await api(s.baseUrl, 'POST', '/api/procedure-versions', {
    procedure: c.body.id, by: 'bo', body: 'Revised: archive the raw file BEFORE reading it.',
  });
  assert.equal(v2.status, 201, JSON.stringify(v2.body));
  assert.notEqual(v2.body.id, c.body.version.id, 'a revision is a new entity, not an overwrite');
  assert.equal(v2.body.ofProcedure, c.body.id);

  const list = await api(s.baseUrl, 'GET', '/api/procedures');
  assert.equal(list.body.length, 1, 'still ONE procedure');
  assert.equal(list.body[0].versions.length, 2, 'with two versions beside it');
  // ⭐ The whole point of the split: v1's text is unchanged, so a run that
  // named v1 still resolves to what was actually followed.
  const v1 = list.body[0].versions.find((v) => v.id === c.body.version.id);
  assert.equal(v1.body, PROC.body, 'improving the method must not rewrite history');
});

test('#1207 a procedure with no body is refused, and says why a name is not enough', async (t) => {
  const s = await withServer(t);
  const r = await api(s.baseUrl, 'POST', '/api/procedures', { name: 'x', by: 'ada' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /without recording which one/);
});

test('#1207 ⭐ the ACTOR is not the PARTICIPANTS, and the verb does not merge them', async (t) => {
  const s = await withServer(t);
  const c = await api(s.baseUrl, 'POST', '/api/procedures', PROC);
  const run = await api(s.baseUrl, 'POST', '/api/runs', {
    op: 'research', by: 'ada', participants: ['bo', 'cy'],
    performedUsing: c.body.version.id,
    used: ['https://www.youtube.com/watch?v=EXAMPLE'],
  });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  // One initiating writer; three seats in the room. Both facts survive.
  assert.deepEqual(run.body.participants.sort(), ['ada', 'bo', 'cy']);
  assert.equal(run.body.performedUsing, c.body.version.id);
  assert.deepEqual(run.body.used, ['https://www.youtube.com/watch?v=EXAMPLE'],
    'a source OUTSIDE this board is kept as a literal, not refused — refusing it would push '
    + 'provenance back into prose');

  const noBy = await api(s.baseUrl, 'POST', '/api/runs', { op: 'research', participants: ['bo'] });
  assert.equal(noBy.status, 400);
  assert.match(noBy.body.error, /who was in the room/,
    'the refusal must say why the two are different, or the next caller passes the list');
});

test('#1207 a run naming an unknown procedure version is refused, naming the fix', async (t) => {
  const s = await withServer(t);
  const r = await api(s.baseUrl, 'POST', '/api/runs', {
    op: 'research', by: 'ada', performedUsing: 'https://scrumboard.local/procedure-version/nope',
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unattributable method/);
});

test('#1207 ⛔ a run op that collides with an EVENT op is refused at the door', async (t) => {
  const s = await withServer(t);
  // If a run could carry "create", every one of the board's ~21,000 write
  // activities would answer a run query. #1206's negative control asserts that
  // cannot happen; this is the door it cannot come through.
  for (const op of [...EVENT_OPS]) {
    const r = await api(s.baseUrl, 'POST', '/api/runs', { op, by: 'ada' });
    assert.equal(r.status, 400, `op "${op}" must be refused`);
    assert.match(r.body.error, /reserved/);
  }
});

test('#1207 an artifact is a pointer and a hash, and the run points at it', async (t) => {
  const s = await withServer(t);
  const run = await api(s.baseUrl, 'POST', '/api/runs', { op: 'research', by: 'ada' });
  const a1 = await api(s.baseUrl, 'POST', '/api/artifacts', {
    run: run.body.id, by: 'ada',
    contentUrl: 'file:///research/2026-09-05-transcript.md',
    encodingFormat: 'text/markdown', contentHash: `sha256:${'a'.repeat(64)}`,
  });
  assert.equal(a1.status, 201, JSON.stringify(a1.body));
  const a2 = await api(s.baseUrl, 'POST', '/api/artifacts', {
    run: run.body.id, by: 'ada', contentUrl: 'file:///research/2026-09-05-notes.md',
  });
  assert.equal(a2.status, 201);

  const runs = await api(s.baseUrl, 'GET', '/api/runs?op=research');
  assert.equal(runs.body.length, 1);
  assert.equal(runs.body[0].generated.length, 2, 'both artifacts hang off the run');
});

test('#1207 ⛔ a PAYLOAD is refused — board state is snapshotted on every write', async (t) => {
  const s = await withServer(t);
  const run = await api(s.baseUrl, 'POST', '/api/runs', { op: 'research', by: 'ada' });
  const r = await api(s.baseUrl, 'POST', '/api/artifacts', {
    run: run.body.id, by: 'ada', contentUrl: 'file:///research/big.md',
    body: 'x'.repeat(5 * 1024),   // 5 KB, over the 4 KB limit
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /5120 bytes/, 'the refusal names the actual size');
  assert.match(r.body.error, /again on every write that follows/,
    'and the REASON, or the next caller just splits the file in two');
});

test('#1207 run_generated attaches a card, and refuses a node this board does not hold', async (t) => {
  const s = await withServer(t);
  const run = await api(s.baseUrl, 'POST', '/api/runs', { op: 'research', by: 'ada' });

  const ok = await api(s.baseUrl, 'POST', '/api/runs/generated', {
    run: run.body.id, by: 'ada', nodes: [1],
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.generated.length, 1, 'the card is now something this run produced');

  const bad = await api(s.baseUrl, 'POST', '/api/runs/generated', {
    run: run.body.id, by: 'ada', nodes: [9999],
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /must exist here/,
    'a run may USE an outside source, but a claim that it GENERATED something absent is a claim '
    + 'this board can disprove');
});

test('#1207 the whole chain is QUERYABLE from the graph, not just readable over REST', async (t) => {
  const s = await withServer(t);
  const c = await api(s.baseUrl, 'POST', '/api/procedures', PROC);
  const run = await api(s.baseUrl, 'POST', '/api/runs', {
    op: 'research', by: 'ada', performedUsing: c.body.version.id,
  });
  await api(s.baseUrl, 'POST', '/api/artifacts', {
    run: run.body.id, by: 'ada', contentUrl: 'file:///research/t.md',
    contentHash: `sha256:${'b'.repeat(64)}`,
  });

  // ⭐ THE TEST #1214 DID NOT HAVE. Straight through the live graph endpoint:
  // if a collection is missing from the document builder, this returns zero
  // while REST happily answers — which is exactly what shipped an hour ago.
  const q = async (query) => {
    const r = await fetch(`${s.baseUrl}/api/graph`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    return (await r.json()).rows ?? [];
  };

  const runs = await q('SELECT ?r WHERE { ?r a prov:Activity ; scrum:op "research" }');
  assert.equal(runs.length, 1, 'the run must be IN the graph');

  const chain = await q(`SELECT ?body ?url WHERE {
    ?r a prov:Activity ; scrum:op "research" ; scrum:performedUsing ?v ; prov:generated ?a .
    ?v scrum:body ?body . ?a schema:contentUrl ?url }`);
  assert.equal(chain.length, 1, 'run → version → text and run → artifact → url, in one hop each');
  assert.match(chain[0].body, /Fetch the transcript/);
  assert.match(chain[0].url, /^file:\/\/\/research\//);
});
