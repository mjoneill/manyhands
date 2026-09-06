/**
 * #715 — A READER SHARES, A WRITER CLONES, AND THE RESPONSE SAYS WHICH.
 *
 * On a 57 MB board a warm read was a ~250 ms structuredClone allocating ~110 MB
 * per request; overlapping readers turned that into an eighteen-minute
 * event-loop stall. Now a GET route reads one deep-frozen board per file
 * identity, rebuilt once after any write; every other method still gets the
 * mutable clone it needs. The `X-Board-Read` header makes the difference
 * observable, because a working cache and an idle box look identical from
 * outside without it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startRestServer } from './helpers/harness.mjs';

const hdr = (r) => r.headers.get('x-board-read') || '';

test('#715 GET routes share: the first read after boot rebuilds, the next hits; a write invalidates; writers clone', async () => {
  const s = await startRestServer({});
  try {
    const r1 = await fetch(`${s.baseUrl}/api/cards`);
    assert.equal(r1.status, 200);
    assert.match(hdr(r1), /^shared; (rebuilt=\d+ms|hit)/, 'a GET is served from the shared board: ' + hdr(r1));
    const r2 = await fetch(`${s.baseUrl}/api/cards`);
    assert.match(hdr(r2), /^shared; hit; built=20\d\d-/, 'the second GET is a hit and names the build it hit: ' + hdr(r2));
    const r3 = await fetch(`${s.baseUrl}/api/agents`);
    assert.match(hdr(r3), /^shared; hit/, 'a different GET route hits the same build');
    // ⛔ A POST never shares, even one that looks read-only: search with a
    // reader model writes a ledger row inside the request. Measured in the
    // suite when a route flag said otherwise; the method is the whole rule.
    const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    assert.match(src, /shares: method === 'GET', read: null/, 'GET alone decides sharing');
    assert.doesNotMatch(src, /shares: true/, 'no per-route sharing flag exists to drift');

    // A write reads through the CLONE path — it must be allowed to mutate.
    const w = await fetch(`${s.baseUrl}/api/cards`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'after the cache', by: 'sage' }) });
    assert.equal(w.status, 201, await w.text());
    assert.match(hdr(w), /^clone; \d+ms$/, 'a POST reads a clone and says so: ' + hdr(w));

    // The write changed the file identity, so the next GET rebuilds ONCE and sees the new card.
    const r4 = await fetch(`${s.baseUrl}/api/cards`);
    assert.match(hdr(r4), /^shared; rebuilt=\d+ms$/, 'the first GET after a write rebuilds: ' + hdr(r4));
    const cards = await r4.json();
    assert.ok(cards.some((c) => c.title === 'after the cache'), 'the rebuilt shared board carries the write');
    const r5 = await fetch(`${s.baseUrl}/api/cards`);
    assert.match(hdr(r5), /^shared; hit/, 'and the one after that hits again');
  } finally { await s.stop(); }
});

test('#715 the shared board is FROZEN: a GET handler cannot write through it, and a PATCH that writes is unaffected', async () => {
  const s = await startRestServer({});
  try {
    const c = await (await fetch(`${s.baseUrl}/api/cards`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'frozen probe', by: 'sage' }) })).json();
    // Read it twice through GET; the object served is the same frozen build.
    const a = await (await fetch(`${s.baseUrl}/api/cards/${c.shortId}`)).json();
    // A real write must still work — it reads the clone, mutates, saves.
    const p = await fetch(`${s.baseUrl}/api/cards/${c.shortId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'frozen probe, renamed', by: 'sage' }) });
    assert.equal(p.status, 200, await p.text());
    assert.match(hdr(p), /^clone/);
    const b = await (await fetch(`${s.baseUrl}/api/cards/${c.shortId}`)).json();
    assert.equal(a.title, 'frozen probe'); assert.equal(b.title, 'frozen probe, renamed');
    assert.ok(b.version > a.version, 'the write is visible to the next shared read');
    // The read that follows a PATCH rebuilt exactly once; a second read hits.
    const r = await fetch(`${s.baseUrl}/api/cards/${c.shortId}`);
    assert.match(hdr(r), /^shared; hit/);
  } finally { await s.stop(); }
});

test('#715 legacy whole-board routes outside the API table still clone (no request context ⇒ the safe default)', async () => {
  const s = await startRestServer({});
  try {
    const r = await fetch(`${s.baseUrl}/api/load`);
    assert.equal(r.status, 200);
    assert.equal(hdr(r), '', 'no context, no header, no sharing: ' + hdr(r));
  } finally { await s.stop(); }
});
