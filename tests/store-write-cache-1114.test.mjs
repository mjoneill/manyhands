/**
 * #1114 / #1277 — the writer drops a cache it is holding.
 *
 * `loadDomainShared` caches one parsed domain per file, keyed on the file's
 * identity (ns-mtime + size). `saveDomain` changes that identity, so EVERY
 * WRITE INVALIDATES THE CACHE and the next read pays a full re-read + reparse
 * — measured at 422 ms on the live 55.9 MB board. In a quiet room that cache is
 * nearly free; in a busy one, reads and writes alternate, the hit rate collapses
 * toward zero, and the reparse lands on the same single thread the writes need.
 *
 * The writer already holds the exact document it just wrote. Installing it under
 * the new identity turns the post-write read back into a hit.
 *
 * ⛔ THE HAZARD, and the only reason these tests exist: an installed cache that
 * is not BYTE-FOR-BYTE what a fresh read would produce is a silent corruption
 * with no error anywhere — every reader until the next write sees a document
 * that is not on disk. `JSON.stringify` drops `undefined`-valued keys and
 * rewrites non-finite numbers, so "the object I have" and "the object the file
 * parses to" are NOT the same object in general. These tests assert the
 * equality on shapes chosen to break it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDomain, loadDomain, loadDomainShared, _dropCacheForTest } from '../core/store.mjs';
import { jsonLdToDomain } from '../core/jsonld.mjs';

/** What a cold process reads: the bytes on disk, projected. The ground truth. */
const fromDisk = (p) => jsonLdToDomain(JSON.parse(readFileSync(p, 'utf8')));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'store-cache-1114-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'board-data.json');
}

const baseDomain = () => ({
  cards: [{ id: 'c1', shortId: 1, title: 'a card', column: 'backlog', description: 'hello' }],
  columns: [{ id: 'backlog', name: 'Backlog' }],
  conversations: [],
});

test('#1114 — after a write, the shared read is a HIT, not a reparse', (t) => {
  const p = fixture(t);
  saveDomain(p, baseDomain());
  const first = loadDomainShared(p);
  const second = loadDomainShared(p);
  assert.equal(first.key, second.key);
  assert.equal(first.domain, second.domain, 'a repeat read must be the same object');

  // The write that used to drop it.
  saveDomain(p, { ...baseDomain(), cards: [...baseDomain().cards, { id: 'c2', shortId: 2, title: 'b', column: 'backlog' }] });
  const after = loadDomainShared(p);
  assert.notEqual(after.key, first.key, 'the identity must change — the file changed');
  assert.equal(after.domain.cards.length, 2, 'and the read must see the new card');
});

test('#1114 ⛔ the installed cache must equal what a COLD PROCESS would read', (t) => {
  const p = fixture(t);
  saveDomain(p, baseDomain());
  assert.deepEqual(loadDomainShared(p).domain, fromDisk(p));
  assert.deepEqual(loadDomain(p), fromDisk(p));
});

test('#1114 ⛔ …including the shapes JSON.stringify does not round-trip', (t) => {
  const p = fixture(t);
  // Every one of these is a way for "the object in hand" to differ from "the
  // object the file parses to". If saveDomain installs the in-hand object
  // without accounting for them, one of these assertions fails.
  const nasty = {
    ...baseDomain(),
    cards: [{
      id: 'c1', shortId: 1, title: 'ünïcødé ✦ — em-dash', column: 'backlog',
      description: 'line\nbreak\ttab "quoted" \\ backslash',
      assignee: undefined,                       // ⇐ stringify DROPS this key
      blockers: [],
      acceptance: [null, 'kept'],
      nested: { deep: { deeper: { n: 0, f: 1.5, t: true, z: null, u: undefined } } },
      big: 9007199254740991,
    }],
  };
  saveDomain(p, nasty);
  const disk = fromDisk(p);
  assert.deepEqual(loadDomainShared(p).domain, disk, 'shared read must match the file');
  assert.deepEqual(loadDomain(p), disk, 'cloned read must match the file too');
  // And the specific trap, named so a failure says WHY:
  const c = loadDomainShared(p).domain.cards[0];
  assert.ok(!('assignee' in c) || c.assignee === undefined, 'an undefined-valued key must not survive as a defined one');
});

test('#1114 — two writes in a row: the SECOND is what readers get', (t) => {
  const p = fixture(t);
  saveDomain(p, baseDomain());
  saveDomain(p, { ...baseDomain(), cards: [{ id: 'c1', shortId: 1, title: 'RENAMED', column: 'backlog' }] });
  assert.equal(loadDomainShared(p).domain.cards[0].title, 'RENAMED');
  assert.deepEqual(loadDomainShared(p).domain, fromDisk(p));
});

test('#1114 — a write by ANOTHER writer still invalidates (identity, not trust)', (t) => {
  const p = fixture(t);
  saveDomain(p, baseDomain());
  loadDomainShared(p);                       // establish the cache

  // Something outside this call path rewrites the file — a repair script, a
  // second process, a restored backup. The cache must follow the FILE.
  const other = { ...baseDomain(), cards: [{ id: 'zz', shortId: 99, title: 'foreign', column: 'backlog' }] };
  saveDomain(p, other, { now: new Date(Date.now() + 1000).toISOString() });

  assert.equal(loadDomainShared(p).domain.cards[0].id, 'zz', 'the reader must see the foreign write');
  assert.deepEqual(loadDomainShared(p).domain, fromDisk(p));
});

test('#1114 — the shared domain stays SHARED (no accidental clone-per-read)', (t) => {
  const p = fixture(t);
  saveDomain(p, baseDomain());
  assert.equal(loadDomainShared(p).domain, loadDomainShared(p).domain);
  // …while loadDomain still clones, which is the #715 contract and is what
  // keeps a writer from mutating every later reader's copy.
  assert.notEqual(loadDomain(p), loadDomain(p));
});

test('#1114 ⭐ THE POINT OF THE CARD — the post-write read does not touch the FILE', (t) => {
  const p = fixture(t);
  saveDomain(p, baseDomain());

  // The fix is a pure IO elimination, so the only honest test is one that
  // OBSERVES the IO. Make the file present (so the existsSync path is
  // unchanged) but unreadable: a read that reparses THROWS; a read served from
  // the cache the writer installed succeeds.
  //
  // ⚠️ chmod is ignored for root. If this ever runs as root it would pass for
  // the wrong reason, so it says so rather than pretending.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root — chmod cannot make the file unreadable, so this proves nothing');
    return;
  }
  chmodSync(p, 0o000);
  t.after(() => { try { chmodSync(p, 0o600); } catch { /* already gone */ } });

  const got = loadDomainShared(p);
  assert.equal(got.domain.cards[0].title, 'a card', 'served from the cache the WRITER installed');

  // Control: with the cache dropped, the same read genuinely cannot work —
  // which is what proves the assertion above was not vacuous.
  chmodSync(p, 0o600);
  saveDomain(p, baseDomain(), { now: new Date(Date.now() + 2000).toISOString() });
  chmodSync(p, 0o000);
  _dropCacheForTest(p);
  assert.throws(() => loadDomainShared(p), /EACCES|EPERM/, 'without the installed cache this read MUST fail');
});
