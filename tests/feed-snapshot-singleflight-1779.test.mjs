// #1779 — the feed bootstrap's whole-history snapshot read is SINGLE-FLIGHT and uses the long-budget reader when given.
// 10-26 11:40Z: browser panels walking from `start` after the cutover's new store each ran their own copy of this scan at
// the same time; the copies starved each other past the 10 s bulk budget, none cached, and every retry rescanned
// (135 × ~47 s). With an empty store (no posts), the snapshot query is the only ordered `?c <= B` read, so counting it is
// enough to see the sharing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postFeed } from '../core/post-discovery.mjs';

const isMarker = (q) => q.includes('SELECT ?e ?s ?i WHERE');
const isSnapshot = (q) => /\?c <= \d+/.test(q) && q.includes('ORDER BY ?ps');
function fakeClient({ commit, delayMs = 0, label }) {
  const calls = { snapshot: 0, other: 0 };
  return {
    calls, label,
    async query(q) {
      if (isMarker(q)) return { ok: true, rows: [{ e: { value: '3' }, s: { value: String(commit) }, i: { value: 'inc-1779' } }] };
      if (isSnapshot(q)) { calls.snapshot += 1; await new Promise((r) => setTimeout(r, delayMs)); return { ok: true, rows: [] }; }
      calls.other += 1; return { ok: true, rows: [] };
    },
  };
}

test('#1779 S1 two concurrent bootstraps of one store and baseline share ONE snapshot read', async () => {
  const c = fakeClient({ commit: 9001, delayMs: 50 });
  const [a, b] = await Promise.all([postFeed(c, { after: 'start', limit: 200 }), postFeed(c, { after: 'start', limit: 200 })]);
  assert.equal(c.calls.snapshot, 1, 'the second bootstrap joined the in-flight read instead of scanning again');
  assert.equal(a.phase, 'live'); assert.equal(b.phase, 'live');
  assert.equal(a.nextAfterCommit, b.nextAfterCommit, 'both are handed the same live cursor at the baseline');
});

test('#1779 S2 the snapshot read goes to the long-budget snapshot client when one is given; every other read stays on the page client', async () => {
  const page = fakeClient({ commit: 9002, label: 'page' });
  const snap = fakeClient({ commit: 9002, label: 'snapshot' });
  await postFeed(page, { after: 'start', limit: 200, snapshotClient: snap });
  assert.equal(snap.calls.snapshot, 1, 'the whole-history read used the snapshot client');
  assert.equal(page.calls.snapshot, 0, 'and never the page client');
});

test('#1779 S3 CONTROL: a failed snapshot read is not cached, so the next bootstrap reads again (and still single-flight)', async () => {
  let fail = true; let n = 0;
  const c = {
    async query(q) {
      if (isMarker(q)) return { ok: true, rows: [{ e: { value: '3' }, s: { value: '9003' }, i: { value: 'inc-1779-b' } }] };
      if (isSnapshot(q)) { n += 1; if (fail) return { ok: false, reason: 'timeout' }; return { ok: true, rows: [] }; }
      return { ok: true, rows: [] };
    },
  };
  await assert.rejects(postFeed(c, { after: 'start', limit: 200 }));
  fail = false;
  const r = await postFeed(c, { after: 'start', limit: 200 });
  assert.equal(r.phase, 'live');
  assert.equal(n, 2, 'the failed read was retried, not served from a cache');
});
