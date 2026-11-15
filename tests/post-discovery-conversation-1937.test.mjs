// #1937 — the commit-ordered feed carries a post's TALK tag. The node reader already read `rs:conversation` (and the
// `conversation` filter matched on it), but the row shape dropped it, so a feed consumer could not tell a talk post from a
// room post. A fake executor client answers the three reads the feed makes (marker, op batch, node fields), so each row
// below is exercised on both the LIVE path and the BOOTSTRAP path, without a store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postFeed, formatLive, scopeOf } from '../core/post-discovery.mjs';

const XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA = 'https://schema.org/';
const RS = 'https://scrumboard.local/ns#';
const ENTITY = 'https://scrumboard.local/entity/';
const PERSON = 'https://scrumboard.local/person/';
const TALK = 'https://scrumboard.local/talk/';
const REDACTED = `${RS}RedactedPost`;
const EPOCH = '7';

const lit = (value, datatype) => ({ value, ...(datatype ? { datatype } : {}) });
const iri = (id) => `${ENTITY}${id}`;

/** A post as triples on its node. `talk` tags it into a 1:1 talk; `redacted` makes it a tombstone that still holds them. */
function node(id, { postSeq, talk = null, redacted = false }) {
  const t = [
    [RDF_TYPE, redacted ? REDACTED : `${SCHEMA}Comment`],
    [`${SCHEMA}text`, `secret body of ${id}`],
    [`${SCHEMA}author`, `${PERSON}ada`],
    [`${SCHEMA}dateCreated`, '2026-11-15T00:00:00.000Z'],
    [`${RS}postSeq`, String(postSeq), XSD_INT],
  ];
  if (talk) t.push([`${RS}conversation`, `${TALK}${talk}`]);
  return t.map(([k, v, dt]) => ({ p: lit(iri(id)), k: lit(k), v: lit(v, dt) }));
}

/** A fake executor: `posts` = [{id, postSeq, commit, talk?, redacted?}], all committed (APPLIED) at their `commit`. */
function fakeClient(posts, { head, inc }) {
  const byIri = new Map(posts.map((p) => [iri(p.id), node(p.id, p)]));
  return {
    async query(q) {
      if (q.includes('SELECT ?e ?s ?i WHERE')) return { ok: true, rows: [{ e: lit(EPOCH), s: lit(String(head)), i: lit(inc) }] };
      if (q.includes('VALUES ?p {')) {
        const wanted = [...q.matchAll(/<([^>]+)>/g)].map((m) => m[1]).filter((x) => byIri.has(x));
        return { ok: true, rows: wanted.flatMap((x) => byIri.get(x)) };
      }
      if (q.includes('SELECT ?op ?c ?p ?ps ?q ?qs')) {
        const gt = /\?c > (\d+)/.exec(q), le = /\?c <= (\d+)/.exec(q);
        const rows = posts
          .filter((p) => (gt ? p.commit > Number(gt[1]) : true) && (le ? p.commit <= Number(le[1]) : true))
          .sort((a, b) => (q.includes('ORDER BY ?ps') ? a.postSeq - b.postSeq : a.commit - b.commit))
          .map((p) => ({ op: lit(`urn:ex:op/post/${p.id}`), c: lit(String(p.commit)), p: lit(iri(p.id)), ps: lit(String(p.postSeq), XSD_INT) }));
        return { ok: true, rows };
      }
      throw new Error(`unexpected query: ${q.slice(0, 80)}`);
    },
  };
}

const POSTS = [
  { id: 'room-1', postSeq: 1, commit: 11 },
  { id: 'talk-1', postSeq: 2, commit: 12, talk: 'tk-abc' },
  { id: 'talk-gone', postSeq: 3, commit: 13, talk: 'tk-abc', redacted: true },
];
// every call gets its own incarnation, so the bootstrap snapshot cache never carries a list from one test to the next
let n = 0;
const nextInc = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

async function both(filters = {}) {
  const live = fakeClient(POSTS, { head: 20, inc: nextInc() });
  const liveInc = (await live.query('SELECT ?e ?s ?i WHERE')).rows[0].i.value;
  const fromLive = await postFeed(live, { after: formatLive(liveInc, EPOCH, 10, scopeOf(filters)), limit: 50, filters });
  const boot = fakeClient(POSTS, { head: 20, inc: nextInc() });
  const fromBoot = await postFeed(boot, { after: 'start', limit: 50, filters });
  return { live: fromLive.conversations, boot: fromBoot.conversations };
}
const byId = (rows, id) => rows.find((r) => r.id === id);

test('#1937 C1 a TALK post read through the feed carries `conversation`: the talk id, with the talk prefix stripped', async () => {
  const { live, boot } = await both();
  for (const [path, rows] of [['live', live], ['bootstrap', boot]]) {
    const row = byId(rows, 'talk-1');
    assert.ok(row, `${path}: the talk post is delivered`);
    assert.equal(row.conversation, 'tk-abc', `${path}: the row names its talk`);
  }
});

test('#1937 C2 a ROOM post has NO `conversation` key (absent, never null or "")', async () => {
  const { live, boot } = await both();
  for (const [path, rows] of [['live', live], ['bootstrap', boot]]) {
    const row = byId(rows, 'room-1');
    assert.ok(row, `${path}: the room post is delivered`);
    assert.equal(Object.hasOwn(row, 'conversation'), false, `${path}: a room post carries no conversation key`);
  }
});

test('#1937 C3 a REDACTED talk post stays content-free: exactly its slot, no conversation and nothing it said', async () => {
  const { live, boot } = await both();
  for (const [path, rows] of [['live', live], ['bootstrap', boot]]) {
    const row = byId(rows, 'talk-gone');
    assert.ok(row, `${path}: the redacted slot is delivered`);
    assert.deepEqual(Object.keys(row).sort(), ['body', 'commitSeq', 'id', 'postSeq', 'redacted'], `${path}: the redacted shape gains no field`);
    assert.equal(row.body, null); assert.equal(row.redacted, true);
  }
});

test('#1937 C4 CONTROL: the `conversation` filter still selects the talk post (and its redacted slot) and drops the room post', async () => {
  const { live, boot } = await both({ conversation: 'tk-abc' });
  for (const [path, rows] of [['live', live], ['bootstrap', boot]]) {
    assert.deepEqual(rows.map((r) => r.id), ['talk-1', 'talk-gone'], `${path}: filter unchanged`);
  }
});
