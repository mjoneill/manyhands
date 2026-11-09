/**
 * #1857 — a wiki page save (PATCH /api/nodes/:id) takes `ifVersion`, and a stale one is REFUSED.
 *
 * Before this, the route wrote `card.description = patch.body` wholesale with no precondition, so two tabs (or a seat and
 * a tab) editing the same page meant the later save silently erased the earlier one. #534 closed that door for
 * card_update (decision 3464b457); this is the same compare-and-swap on the wiki's own door, built to the card's groom
 * (#1857, 2026-11-09T06:10Z) steps 1–2:
 *   1. the node GET carries the version (it always did, at `node.board.version`; W1 pins it so the editor can rely on it);
 *   2. the PATCH honours an optional `ifVersion`: a mismatch is a 409 naming the current version, and writes nothing.
 * Step 3 (REQUIRING it on `body`, as #534 did for description) changes the human editing surface and waits for a
 * room decision; W6 pins today's opt-in so that step is a deliberate change, not drift.
 *
 * Read-backs go through the CARD route on purpose (see tests/nodes-ignored-fields.test.mjs readCard): `body` lands in
 * `card.description`, and a read through the node projection would make a mapping bug look like a storage bug.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function newPage(baseUrl, text = 'first text') {
  const r = await fetch(`${baseUrl}/api/cards`, json('POST', { title: 'a wiki page', createdBy: 'ada', description: text }));
  assert.equal(r.status, 201, 'fixture page created');
  return (await r.json()).shortId;
}
const patchNode = async (baseUrl, sid, patch) => {
  const r = await fetch(`${baseUrl}/api/nodes/${sid}`, json('PATCH', patch));
  let body = null; try { body = await r.json(); } catch { /* none */ }
  return { status: r.status, body };
};
const readCard = async (baseUrl, sid) => (await fetch(`${baseUrl}/api/cards/${sid}`)).json();
const nodeVersion = async (baseUrl, sid) => (await (await fetch(`${baseUrl}/api/nodes/${sid}`)).json()).node?.board?.version;

test('W1 the node GET carries the page version at node.board.version, equal to the card version, and it moves on a node save', async () => {
  const s = await startRestServer();
  try {
    const sid = await newPage(s.baseUrl);
    const v0 = await nodeVersion(s.baseUrl, sid);
    assert.ok(Number.isInteger(v0), `the editor needs a token to send: node.board.version = ${v0}`);
    assert.equal(v0, (await readCard(s.baseUrl, sid)).version, 'the same number the card route reports');
    assert.equal((await patchNode(s.baseUrl, sid, { body: 'edited', ifVersion: v0 })).status, 200);
    assert.equal(await nodeVersion(s.baseUrl, sid), v0 + 1, 'a node save moves the version the next editor will read');
  } finally { await s.stop(); }
});

test('W2 two editors read the same version: the first save lands, the second is a 409 naming the current version, and the first body survives', async () => {
  const s = await startRestServer();
  try {
    const sid = await newPage(s.baseUrl, 'v1 server text');
    const read = await nodeVersion(s.baseUrl, sid);   // both tabs open the editor on this version
    const first = await patchNode(s.baseUrl, sid, { body: 'ada saved first', ifVersion: read });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await patchNode(s.baseUrl, sid, { body: 'bo saved from the same read', ifVersion: read });
    assert.equal(second.status, 409, `the stale save is refused: ${JSON.stringify(second.body)}`);
    assert.equal(second.body.currentVersion, read + 1, 'the 409 names the version to re-read');
    assert.match(second.body.error, /moved on|changed/i);
    const after = await readCard(s.baseUrl, sid);
    assert.equal(after.description, 'ada saved first', 'the first save survived');
    assert.equal(after.version, read + 1, 'the refusal did not move the version');
  } finally { await s.stop(); }
});

test('W3 a refused save writes NOTHING: title, parent and attachments in the same stale request do not land either', async () => {
  const s = await startRestServer();
  try {
    const parent = await newPage(s.baseUrl, 'a parent');
    const sid = await newPage(s.baseUrl, 'v1');
    const read = await nodeVersion(s.baseUrl, sid);
    assert.equal((await patchNode(s.baseUrl, sid, { body: 'v2', ifVersion: read })).status, 200);
    const before = await readCard(s.baseUrl, sid);
    const stale = await patchNode(s.baseUrl, sid, { title: 'renamed', body: 'v2-stale', parent: (await readCard(s.baseUrl, parent)).id, ifVersion: read });
    assert.equal(stale.status, 409);
    const after = await readCard(s.baseUrl, sid);
    assert.deepEqual([after.title, after.description, after.parent ?? null, after.updatedAt], [before.title, before.description, before.parent ?? null, before.updatedAt], 'every field as it was');
  } finally { await s.stop(); }
});

test('W4 a malformed ifVersion is a 400 (not a 409 a re-read can never clear), and writes nothing', async () => {
  const s = await startRestServer();
  try {
    const sid = await newPage(s.baseUrl, 'kept');
    for (const bad of ['1', -1, 1.5, null, true]) {
      const r = await patchNode(s.baseUrl, sid, { body: 'should not land', ifVersion: bad });
      assert.equal(r.status, 400, `${JSON.stringify(bad)}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /ifVersion/);
    }
    assert.equal((await readCard(s.baseUrl, sid)).description, 'kept');
  } finally { await s.stop(); }
});

test('W5 ifVersion is CONSUMED, never reported back as an ignored field', async () => {
  const s = await startRestServer();
  try {
    const sid = await newPage(s.baseUrl);
    const r = await patchNode(s.baseUrl, sid, { body: 'x', ifVersion: await nodeVersion(s.baseUrl, sid) });
    assert.equal(r.status, 200);
    assert.ok(!(r.body.ignoredFields || []).includes('ifVersion'), `ignoredFields: ${JSON.stringify(r.body.ignoredFields)}`);
  } finally { await s.stop(); }
});

test('W6 step 3 (owner ruling 2026-11-09 16:31Z, "mandatory"): a body save with NO ifVersion is refused 400 and writes nothing; title, parent and attachments alone need none', async () => {
  const s = await startRestServer();
  try {
    const parent = await newPage(s.baseUrl, 'parent');
    const sid = await newPage(s.baseUrl, 'v1');
    const before = await readCard(s.baseUrl, sid);
    const r = await patchNode(s.baseUrl, sid, { body: 'no precondition', title: 'renamed too' });
    assert.equal(r.status, 400, `a body rewrite without the version read is refused: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /ifVersion/, 'and the refusal names what is missing');
    const after = await readCard(s.baseUrl, sid);
    assert.equal(after.description, before.description, 'nothing written: not the body');
    assert.equal(after.title, before.title, 'and not the title sent alongside it');
    const empty = await patchNode(s.baseUrl, sid, { body: '' });
    assert.equal(empty.status, 400, 'an empty body is a clear and is not exempt');
    // the controls: these do not rewrite the body, so they need no version
    assert.equal((await patchNode(s.baseUrl, sid, { parent: (await readCard(s.baseUrl, parent)).id })).status, 200, 'a drag in the tree is not a body rewrite');
    assert.equal((await patchNode(s.baseUrl, sid, { title: 'just a rename' })).status, 200, 'a rename is not a body rewrite');
    // and with the version it lands, as before
    const v = (await readCard(s.baseUrl, sid)).version ?? 0;
    assert.equal((await patchNode(s.baseUrl, sid, { body: 'with precondition', ifVersion: v })).status, 200);
  } finally { await s.stop(); }
});
