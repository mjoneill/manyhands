/**
 * #1931 — A SEARCH FOR A SEAT'S NAME FINDS WHAT THAT SEAT SAID. The commons search (`GET /api/conversations?q=`) matched a post's body or its
 * author KEY (#1010). A seat is shown to people by its roster display NAME, which can share nothing with its key: a seat keyed `lodger` reads
 * "Marmalade" everywhere a person looks. So a person who searched the name they can see found none of that seat's posts unless the body
 * happened to contain it. Found when the owner could not find a seat's song by its name (2026-11-15).
 *
 *   N1  `q` matching a seat's roster display name (case-insensitive, a substring like the body match) returns that seat's posts, including
 *       one whose body never contains the name.
 *   N2  NEGATIVE CONTROL: the name match reaches only the named seat. Another seat's post is returned only if its own body or key matches,
 *       and a name no roster seat holds returns nothing.
 *   N3  The name match is applied before `limit`, like every other `q` match: `limit=1` returns the most recent post by that seat.
 *
 * Must-fail control: N1 and N3 are RED on main 818953a (the `q` filter never consults the roster). N2 passes there too; it is the control
 * that a name match which matched everything would fail.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const ROSTER_FILE = path.join(os.tmpdir(), `name-search-1931-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: {
  ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' },
  lodger: { name: 'Marmalade', glyph: 'm', color: '#c2a057' },
  board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' },
} }));
after(() => { try { fs.unlinkSync(ROSTER_FILE); } catch { /* gone */ } });

const at = (n) => `2026-08-0${n}T00:00:00.000Z`;
const convs = [
  { id: 'm1', body: 'a sea shanty for the crew', author: 'lodger', attachedTo: null, createdAt: at(1), mentions: [] },
  { id: 'a1', body: 'unrelated words', author: 'ada', attachedTo: null, createdAt: at(2), mentions: [] },
  { id: 'a2', body: 'I liked the marmalade one', author: 'ada', attachedTo: null, createdAt: at(3), mentions: [] },
  { id: 'm2', body: 'a second verse', author: 'lodger', attachedTo: null, createdAt: at(4), mentions: [] },
  { id: 'a3', body: 'more unrelated words', author: 'ada', attachedTo: null, createdAt: at(5), mentions: [] },
];
const serve = () => startRestServer({ board: makeBoardFixture({ cards: [], conversations: convs }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
const get = (base, qs) => fetch(`${base}/api/conversations${qs}`).then(async (r) => ({ status: r.status, total: r.headers.get('x-total-count'), body: await r.json() }));
const ids = (r) => r.body.map((c) => c.id).sort();

test('N1 q= matching a seat\'s display name returns that seat\'s posts, even one whose body never says the name', async () => {
  const s = await serve();
  try {
    const r = await get(s.baseUrl, '?q=Marmalade');
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r), ['a2', 'm1', 'm2'], 'both of the seat\'s posts, plus the one post whose BODY says the name');
    assert.ok(!convs.find((c) => c.id === 'm1').body.toLowerCase().includes('marmalade'), 'CONTROL: m1 can only be found through the name');
    assert.deepEqual(ids(await get(s.baseUrl, '?q=marm')), ['a2', 'm1', 'm2'], 'a substring of the name, lower-case, like the body match');
  } finally { await s.stop(); }
});

test('N2 NEGATIVE CONTROL: the name reaches only its own seat, and a name nobody holds finds nothing', async () => {
  const s = await serve();
  try {
    const r = await get(s.baseUrl, '?q=marmalade');
    assert.ok(!ids(r).includes('a1') && !ids(r).includes('a3'), `another seat's posts are not swept in: ${ids(r)}`);
    assert.deepEqual((await get(s.baseUrl, '?q=zzzz-no-such-seat')).body, [], 'no seat, no body: zero, not everything');
    assert.deepEqual(ids(await get(s.baseUrl, '?q=Ada')), ['a1', 'a2', 'a3'], 'the other seat\'s own name finds its own posts and none of the lodger\'s');
  } finally { await s.stop(); }
});

test('N3 the name match is applied before limit: limit=1 is the most recent post BY that seat, and the total counts them all', async () => {
  const s = await serve();
  try {
    const r = await get(s.baseUrl, '?q=marmalade&author=lodger&limit=1');
    assert.deepEqual(r.body.map((c) => c.id), ['m2']);
    assert.equal(r.total, '2', 'X-Total-Count is every match, not the slice');
  } finally { await s.stop(); }
});
