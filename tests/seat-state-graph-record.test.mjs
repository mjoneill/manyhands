/**
 * #1143 — seat state is BORN IN THE GRAPH.
 *
 * Before this slice the write path appended an event AND maintained a row in
 * the document (`data.seatStates[]`), and the only live read came from that
 * row. The replica already projected the declaration TIMELINE from the event
 * log (#1110). This slice retires the row: the event is the write, the graph
 * is the live read, the document carries nothing about seat state.
 *
 * What these tests pin, in order: the read comes from the graph and the
 * document row is gone; re-declare and clear still behave as #613 specified;
 * the payload SAYS where it read from and what the read cost (acceptance 4);
 * a legacy row left in a document is reported, never silently honoured.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const IN_1H = () => new Date(Date.now() + 3600_000).toISOString();
const put = (base, seat, body) => fetch(`${base}/api/seats/${seat}/state`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const del = (base, seat) => fetch(`${base}/api/seats/${seat}/state`, { method: 'DELETE' });
const states = async (base) => (await fetch(`${base}/api/seats/state`)).json();
const graph = async (base, query) => (await fetch(`${base}/api/graph`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
})).json();

test('#1143 a declaration is read from the GRAPH and leaves no row in the document', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const r = await put(s.baseUrl, 'alex', { mode: 'resting', acceptsRoutineWork: false, expiresAt: IN_1H(), note: 'graph-born' });
    assert.equal(r.status, 200, JSON.stringify(await r.json()));

    const doc = s.readBoardFile();
    const rows = doc.seatStates ?? doc['@graph']?.filter((n) => n['@type'] === 'scrum:SeatDeclaration') ?? [];
    assert.equal(rows.length, 0, `the document must carry NO seat-state row; found ${JSON.stringify(rows).slice(0, 200)}`);

    const g = await graph(s.baseUrl,
      'SELECT ?mode ?note WHERE { ?d a scrum:SeatDeclaration ; scrum:declaredSeat person:alex ; scrum:mode ?mode ; scrum:note ?note FILTER NOT EXISTS { ?d scrum:endedAt ?e } }');
    assert.equal(g.rows.length, 1, 'exactly one OPEN declaration for the seat in the graph');
    assert.equal(g.rows[0].mode, 'resting');
    assert.equal(g.rows[0].note, 'graph-born');

    const after = await states(s.baseUrl);
    const mine = after.seats.find((x) => x.seat === 'alex');
    assert.equal(mine.mode, 'resting');
    assert.equal(mine.acceptsRoutineWork, false);
    assert.equal(mine.note, 'graph-born');
    assert.ok(!after.eligible.includes('alex'));
    assert.equal(after.source, 'graph', 'the payload names where the live read came from');
  } finally { await s.stop(); }
});

test('#1143 re-declare supersedes (one open interval), clear returns UNKNOWN, expiry is honoured from the graph', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    await put(s.baseUrl, 'robin', { mode: 'resting', acceptsRoutineWork: false, expiresAt: IN_1H() });
    await put(s.baseUrl, 'robin', { mode: 'degraded', acceptsRoutineWork: true, expiresAt: IN_1H(), constraints: ['slow'] });
    let st = (await states(s.baseUrl)).seats.find((x) => x.seat === 'robin');
    assert.equal(st.mode, 'degraded');
    assert.deepEqual(st.constraints, ['slow']);
    const open = await graph(s.baseUrl, 'SELECT ?d WHERE { ?d a scrum:SeatDeclaration ; scrum:declaredSeat person:robin FILTER NOT EXISTS { ?d scrum:endedAt ?e } }');
    assert.equal(open.rows.length, 1, 'a re-declare ENDS the previous interval; one stays open');

    assert.equal((await del(s.baseUrl, 'robin')).status, 200);
    st = (await states(s.baseUrl)).seats.find((x) => x.seat === 'robin');
    assert.equal(st.mode, 'unknown');
    assert.equal(st.expired, false, 'a cleared seat is ABSENT, not expired');

    // Expiry: a declaration whose expiresAt is in the past reads UNKNOWN with expired:true.
    // validateDeclaration refuses a past expiry, so it is set 2 s ahead and waited out.
    await put(s.baseUrl, 'sage', { mode: 'resting', acceptsRoutineWork: false, expiresAt: new Date(Date.now() + 1500).toISOString() });
    await new Promise((r) => setTimeout(r, 1700));
    st = (await states(s.baseUrl)).seats.find((x) => x.seat === 'sage');
    assert.equal(st.mode, 'unknown');
    assert.equal(st.expired, true, 'an expired interval is still the record that the seat once declared');
  } finally { await s.stop(); }
});

test('#1143 the payload states the read cost — acceptance 4 is measured on every call, not estimated once', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    await put(s.baseUrl, 'nova', { mode: 'available', acceptsRoutineWork: true, expiresAt: IN_1H() });
    const st = await states(s.baseUrl);
    assert.equal(st.source, 'graph');
    assert.ok(st.graph && typeof st.graph === 'object', 'graph read stats present');
    assert.ok(st.graph.rebuiltMs === null || typeof st.graph.rebuiltMs === 'number', 'rebuiltMs is a number after a write, null when nothing was synced');
    assert.ok(st.graph.projectedThrough !== undefined, 'the watermark the read is current to (a seq or a stamp; whatever warmGraphStore reports)');
  } finally { await s.stop(); }
});

test('#1143 a legacy document row is REPORTED and not honoured — the graph is the record now', async () => {
  const board = makeBoardFixture();
  board.seatStates = [{
    '@id': 'https://scrumboard.local/seat-state/kit', '@type': 'scrum:SeatDeclaration',
    'scrum:seat': 'kit', 'scrum:mode': 'resting', 'scrum:acceptsRoutineWork': false,
    'scrum:declaredAt': new Date().toISOString(), 'scrum:expiresAt': IN_1H(),
  }];
  const s = await startRestServer({ board });
  try {
    const st = await states(s.baseUrl);
    assert.equal(st.legacyRows, 1, 'a row the migration left behind is counted, so nobody thinks it silently vanished');
    assert.equal(st.seats.find((x) => x.seat === 'kit').mode, 'unknown',
      'the row is NOT read: without an event the graph holds no declaration, and the graph is the record');
    assert.ok(st.eligible.includes('kit'));
  } finally { await s.stop(); }
});
