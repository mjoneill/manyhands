/**
 * #1629 slice 1 — the reserve's INPUT CONTRACT measured against the contract that will publish the post. TEST AUTHOR's,
 * written after the code review at 86d77d2 found three defects my earlier rows passed (origin.occurredAt refused,
 * prototype-named attachment keys silently dropped, a malformed identity APPLIED then read back INVALID), and BEFORE the
 * builder's fix. These rows do not restate those three reproductions as examples: they derive the cases from the
 * post.write canonicalization in core/graph-compiler.mjs, so a field the reviewer did not name is held too.
 *
 *   K0  PRECONDITION: the post.write key lists (post, post.origin, post.attachments[k]) are read from the compiler's own source,
 *       and this file's tables cover exactly them — a field added there fails here until it is covered
 *   K1  post.write ACCEPTS => reserve ACCEPTS: a draft carrying any one settled post.write field (each origin key and each
 *       attachment key included), with a value post.write canonicalize accepts, is accepted by the reserve
 *   K2  post.write REFUSES => reserve REFUSES: a lone surrogate in ANY string the reservation carries (identity, every draft
 *       string, every nested origin/attachment string, each mention) and any own key outside the closed attachment or origin
 *       keyset (prototype names constructor / toString / hasOwnProperty / __proto__ included, built as JSON) is refused by the
 *       reserve's own canonicalization. Announcement items the same, against post.create
 *   K3  on a REAL executor: a refused item allocates NOTHING (allocator byte-identical, no reservation) for three refusals
 *       from three different families; and a well-formed non-ASCII identity APPLIES and reads back exactly (control)
 *   K4  on a REAL executor: origin.occurredAt is stored and read back exactly; two drafts differing ONLY in it collide
 *       (intent-collision), and so do one with it and one without
 *
 *   K5  a present attachment object needs EVERY member: a missing or null id / mime / name / size is refused, as post.write
 *       refuses it (the interface owner's ruling on #1629 v60: match post.write, no publisher-side mapping); an omitted or
 *       null attachments ARRAY is still accepted and defaults to empty (control)
 *
 * NOT covered: the outbox/publish path (later slices); REST.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { canonicalize } from '../core/graph-compiler.mjs';
import { postWriteId } from '../core/post-write.mjs';
import { announcePostId } from '../core/announce-outbox.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let M = null, modErr = null;
try { M = await import(pathToFileURL(path.join(ROOT, 'core', 'postseq-reserve.mjs')).href); } catch (e) { modErr = e; }
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 240000 };
const DSID = 'ps1629k';
const BK = 'urn:scrum:bookkeeping:executor';
const P = (x) => `<urn:ex:postseq/${x}>`;
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const int = (n) => `"${n}"^^<${XSD}integer>`;
const ALLOC = `${P('allocator')} a ${P('Allocator')} ; ${P('postSeqEpoch')} "e-1629-contract" ; ${P('nextPostSeq')} ${int(100)} ; ${P('version')} ${int(1)} .`;
const LONE = String.fromCharCode(0xd800);
const AT = '2026-10-18T01:00:00.000Z';

const BASE_DRAFT = () => ({ body: 'contract body', attachedTo: null, mentions: [], attachments: [], conversation: null, onBehalfOf: null });
const ordinary = (author, requestId, draft = {}) => ({ mode: 'ordinary', author, requestId, draft: { ...BASE_DRAFT(), ...draft } });
const announcement = (mutationId, slot, draft = {}) => ({ mode: 'announcement', mutationId, slot, draft: { body: 'announce', author: 'board', originActor: 'ada', occurredAt: AT, mentions: ['ada'], notify: false, ...draft } });
const intention = (reservations) => ({ kind: 'postseq.reserve', opId: M.reserveOpId(reservations), actor: 'urn:ex:seat/ada', reservations });

// the reserve's own verdict on an item, without an executor
const reserveAccepts = (item) => { try { M.canonReservationBatch([item]); return true; } catch { return false; } };
// the publishing contract's verdict: post.write for an ordinary item (the draft's fields plus the values the allocator assigns)
const writeAccepts = (item) => {
  const id = postWriteId(item.author, item.requestId);
  try {
    canonicalize({ kind: 'post.write', opId: `urn:ex:op/post/${id}`, actor: `https://scrumboard.local/person/${item.author}`,
      post: { id, author: item.author, createdAt: AT, postSeq: 1, ...item.draft } });
    return true;
  } catch { return false; }
};
// post.create for an announcement item
const createAccepts = (item) => {
  try {
    canonicalize({ kind: 'post.create', opId: `urn:ex:op/announce/x/0`, actor: 'https://scrumboard.local/person/board',
      post: { id: 'p-1', body: item.draft.body, author: item.draft.author, originActor: item.draft.originActor,
        origin: { mutationId: item.mutationId, slot: item.slot }, occurredAt: item.draft.occurredAt, publicationAt: AT, postSeq: 1, mentions: item.draft.mentions } });
    return true;
  } catch { return false; }
};

// ── K0: the key lists, read from the compiler, not from this file's memory ──
const SRC = fs.readFileSync(path.join(ROOT, 'core', 'graph-compiler.mjs'), 'utf8');
const WRITE_BRANCH = SRC.indexOf("i.kind === 'post.write'");
const branch = WRITE_BRANCH < 0 ? '' : SRC.slice(WRITE_BRANCH, SRC.indexOf('} else if', WRITE_BRANCH + 40));
const keysIn = (what) => { const m = branch.match(new RegExp(`obj\\([^,]+,\\s*\\[([^\\]]*)\\]\\s*,\\s*[\`']${what.replace(/[.[\]$]/g, '\\$&')}`)); return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null; };
const ASSIGNED = ['id', 'author', 'createdAt', 'postSeq'];   // identity or allocator-assigned: not draft fields

// one VALID value per settled post.write draft field, and per nested key
const VALID = {
  body: 'b', attachedTo: 'card-x', mentions: ['ada'], conversation: 'talk-1', onBehalfOf: 'grace', recovered: 'rec-1',
  opId: 'urn:ex:op/post/x', origin: { mutationId: 'm', slot: 's' }, attachments: [{ id: 'att', mime: 'text/plain', name: 'a.txt', size: 3 }],
  originalAuthorToken: 'tok', authorCorrectedAt: AT, authorCorrectedBy: 'grace',
};
const ORIGIN_VALID = { mutationId: 'm', slot: 's', occurredAt: AT };
const ATT_VALID = { id: 'att', mime: 'text/plain', name: 'a.txt', size: 3 };

test('#1629 (K0) PRECONDITION: the post.write key lists are read from the compiler, and this file covers exactly them', () => {
  assert.ok(M, `core/postseq-reserve.mjs did not load (${modErr?.message?.slice(0, 120)})`);
  const post = keysIn('post'), origin = keysIn('post.origin');
  assert.ok(post && post.length > 8, `the post.write key list was found in the compiler source (${JSON.stringify(post)})`);
  assert.ok(origin && origin.length >= 2, `the post.write origin key list was found (${JSON.stringify(origin)})`);
  const att = branch.match(/obj\(a,\s*\[([^\]]*)\]/); const attKeys = att ? [...att[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null;
  assert.ok(attKeys, 'the attachment key list was found');
  assert.deepEqual(post.filter((k) => !ASSIGNED.includes(k)).sort(), Object.keys(VALID).sort(), 'every settled post.write field has a K1 value, and no other');
  assert.deepEqual([...origin].sort(), Object.keys(ORIGIN_VALID).sort(), 'every post.write origin key has a K1 value');
  assert.deepEqual([...attKeys].sort(), Object.keys(ATT_VALID).sort(), 'every post.write attachment key has a K1 value');
});

// ── K1: post.write accepts => reserve accepts ──
const K1 = [
  ...Object.entries(VALID).map(([k, v]) => [`draft.${k}`, { [k]: v }]),
  ...Object.keys(ORIGIN_VALID).filter((k) => !['mutationId', 'slot'].includes(k)).map((k) => [`draft.origin.${k}`, { origin: { ...VALID.origin, [k]: ORIGIN_VALID[k] } }]),
  ['draft.origin with every key', { origin: { ...ORIGIN_VALID } }],
];
for (const [label, patch] of K1) {
  test(`#1629 (K1) post.write accepts ${label}, so the reserve accepts it`, () => {
    const item = ordinary('ada', `k1-${label}`, patch);
    assert.equal(writeAccepts(item), true, `PRECONDITION: post.write canonicalize accepts this draft (${JSON.stringify(patch)})`);
    assert.equal(reserveAccepts(item), true, `the reserve refused a draft post.write would publish (${JSON.stringify(patch)})`);
  });
}

// ── K2: post.write refuses => reserve refuses ──
const K2 = [
  ['identity author', ordinary(LONE, 'k2-a')],
  ['draft.body', ordinary('ada', 'k2-body', { body: `x${LONE}` })],
  ...['attachedTo', 'conversation', 'onBehalfOf', 'recovered', 'opId', 'originalAuthorToken', 'authorCorrectedAt', 'authorCorrectedBy']
    .map((k) => [`draft.${k}`, ordinary('ada', `k2-${k}`, { [k]: `x${LONE}` })]),
  ['draft.mentions[0]', ordinary('ada', 'k2-mention', { mentions: [`x${LONE}`] })],
  ...Object.keys(ORIGIN_VALID).map((k) => [`draft.origin.${k}`, ordinary('ada', `k2-o-${k}`, { origin: { ...ORIGIN_VALID, [k]: `x${LONE}` } })]),
  ...['id', 'mime', 'name'].map((k) => [`draft.attachments[0].${k}`, ordinary('ada', `k2-att-${k}`, { attachments: [{ ...ATT_VALID, [k]: `x${LONE}` }] })]),
  ...['constructor', 'toString', 'hasOwnProperty', '__proto__', 'extra'].map((k) => [`attachment own key ${k}`,
    ordinary('ada', `k2-attkey-${k}`, { attachments: [JSON.parse(`{"id":"att","mime":"text/plain","name":"a.txt","size":3,${JSON.stringify(k)}:"dropped"}`)] })]),
  ...['constructor', '__proto__', 'extra'].map((k) => [`origin own key ${k}`,
    ordinary('ada', `k2-orgkey-${k}`, { origin: JSON.parse(`{"mutationId":"m","slot":"s",${JSON.stringify(k)}:"dropped"}`) })]),
];
for (const [label, item] of K2) {
  test(`#1629 (K2) post.write refuses a malformed ${label}, so the reserve refuses it before anything is sent`, () => {
    assert.equal(writeAccepts(item), false, `PRECONDITION: post.write canonicalize refuses this (${label})`);
    assert.equal(reserveAccepts(item), false, `the reserve accepted what post.write would refuse (${label})`);
  });
}
// requestId is not a post.write field (it only derives the postId), so its contract is the reserve's own READER: a
// requestId the reader would refuse must be refused at the input, or the allocator commits an unreadable reservation
test('#1629 (K2) a malformed identity requestId is refused by the reserve, because its own reader would refuse it', () => {
  assert.equal(reserveAccepts(ordinary('ada', `k2-${LONE}`)), false, 'the reserve accepted a requestId its reader reads as INVALID');
  assert.equal(reserveAccepts(ordinary('ada', 'k2-requestid-ok')), true, 'CONTROL: a well-formed requestId is accepted');
});
const K2A = [
  ...['mutationId', 'slot'].map((k) => [`identity ${k}`, k === 'mutationId' ? announcement(`m${LONE}`, '0') : announcement('m', `${LONE}`)]),
  ...['body', 'author', 'originActor', 'occurredAt'].map((k) => [`draft.${k}`, announcement('m', `k2a-${k}`, { [k]: `x${LONE}` })]),
  ['draft.mentions[0]', announcement('m', 'k2a-mention', { mentions: [`x${LONE}`] })],
];
for (const [label, item] of K2A) {
  test(`#1629 (K2) post.create refuses an announcement with a malformed ${label}, so the reserve refuses it`, () => {
    assert.equal(createAccepts(item), false, `PRECONDITION: post.create canonicalize refuses this (${label})`);
    assert.equal(reserveAccepts(item), false, `the reserve accepted an announcement post.create would refuse (${label})`);
  });
}
// ── K5: every member of a present attachment is required ──
for (const k of Object.keys(ATT_VALID)) {
  for (const [how, att] of [['missing', (() => { const a = { ...ATT_VALID }; delete a[k]; return a; })()], ['null', { ...ATT_VALID, [k]: null }]]) {
    test(`#1629 (K5) an attachment with ${k} ${how} is refused, as post.write refuses it`, () => {
      const item = ordinary('ada', `k5-${k}-${how}`, { attachments: [att] });
      assert.equal(writeAccepts(item), false, `PRECONDITION: post.write canonicalize refuses an attachment with ${k} ${how}`);
      assert.equal(reserveAccepts(item), false, `the reserve accepted an attachment with ${k} ${how}`);
    });
  }
}
test('#1629 (K5 CONTROL) an omitted or null attachments array is accepted and defaults to empty, by both contracts', () => {
  const omitted = ordinary('ada', 'k5-omitted'); delete omitted.draft.attachments;
  const nul = ordinary('ada', 'k5-null', { attachments: null });
  for (const [label, item] of [['omitted', omitted], ['null', nul]]) {
    assert.equal(writeAccepts(item), true, `PRECONDITION: post.write accepts attachments ${label}`);
    assert.equal(reserveAccepts(item), true, `the reserve accepts attachments ${label}`);
    assert.deepEqual(M.canonReservationBatch([item])[0].draft.attachments, [], `attachments ${label} canonicalizes to []`);
  }
});
test('#1629 (K2 CONTROL) a well-formed announcement and a well-formed ordinary item are accepted by both contracts', () => {
  const a = announcement('m', '0'), o = ordinary('ada', 'k2-ok', { origin: { ...VALID.origin }, attachments: [{ ...ATT_VALID }] });   // no occurredAt: that is K1's row, not the control's
  assert.equal(createAccepts(a), true); assert.equal(reserveAccepts(a), true);
  assert.equal(writeAccepts(o), true); assert.equal(reserveAccepts(o), true);
});

// ── K3 / K4: a real executor ──
let seedN = 0;
async function world(body) {
  assert.ok(M, `core/postseq-reserve.mjs did not load (${modErr?.message?.slice(0, 120)})`);
  const store = tmpStore('ps1629k-'); fs.rmSync(store, { recursive: true });
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  try {
    const r = await fetch(`${exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/postseq-contract-${process.pid}-${seedN++}` }, body: `INSERT DATA { GRAPH <${BK}> { ${ALLOC} } }` });
    assert.equal(r.status, 200, `PRECONDITION: the allocator seed was written (${await r.text()})`);
    await body(createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID, label: 'postseq-1629-contract' }));
  } finally { await killExecutor(exec); fs.rmSync(store, { recursive: true, force: true }); }
}
const attempt = async (client, items) => { try { return await client.update(intention(items)); } catch (e) { return { outcome: 'THREW', reason: String(e?.message ?? e) }; } };
const readRes = (client, item) => M.readPostSeqReservation(client, item.mode === 'ordinary' ? postWriteId(item.author, item.requestId) : announcePostId(item.mutationId, item.slot));

test('#1629 (K3) a refused item allocates NOTHING on a real executor, for three refusals from three families', T, async () => {
  await world(async (client) => {
    const a0 = await M.readPostSeqAllocator(client);
    assert.equal(a0.ok, true, `PRECONDITION: the seeded allocator reads (${JSON.stringify(a0)})`);
    const cases = [
      ['malformed identity author', ordinary(LONE, 'k3-identity')],
      ['malformed nested origin.slot', ordinary('ada', 'k3-origin', { origin: { mutationId: 'm', slot: `x${LONE}` } })],
      ['prototype-named attachment key', ordinary('ada', 'k3-att', { attachments: [JSON.parse('{"id":"att","mime":"text/plain","name":"a.txt","size":3,"constructor":"dropped"}')] })],
    ];
    for (const [label, item] of cases) {
      const o = await attempt(client, [item]);
      assert.notEqual(o.outcome, 'APPLIED', `${label}: refused, not applied (${JSON.stringify(o).slice(0, 200)})`);
      assert.deepEqual(await M.readPostSeqAllocator(client), a0, `${label}: the allocator reads exactly as before`);
      if (item.author.isWellFormed()) assert.equal((await readRes(client, item)).reservation ?? null, null, `${label}: no reservation was written`);
    }
  });
});
test('#1629 (K3 CONTROL) a well-formed non-ASCII identity applies and reads back exactly', T, async () => {
  await world(async (client) => {
    const item = ordinary('zoë', 'k3-ok-𝄞-ñ');
    const o = await attempt(client, [item]);
    assert.equal(o.outcome, 'APPLIED', JSON.stringify(o).slice(0, 200));
    const r = await readRes(client, item);
    assert.equal(r.ok, true, JSON.stringify(r)); assert.deepEqual(r.reservation?.identity, { author: 'zoë', requestId: 'k3-ok-𝄞-ñ' });
  });
});
test('#1629 (K4) origin.occurredAt is stored and read back exactly; changing ONLY it, or adding it, is an intent-collision', T, async () => {
  await world(async (client) => {
    const a = ordinary('ada', 'k4', { origin: { mutationId: 'm', slot: 's', occurredAt: AT } });
    const b = ordinary('ada', 'k4', { origin: { mutationId: 'm', slot: 's', occurredAt: '2026-10-18T01:00:01.000Z' } });
    const c = ordinary('ada', 'k4', { origin: { mutationId: 'm', slot: 's' } });
    const first = await attempt(client, [a]);
    assert.equal(first.outcome, 'APPLIED', `a draft whose origin carries occurredAt is reserved (${JSON.stringify(first).slice(0, 200)})`);
    const r = await readRes(client, a);
    assert.deepEqual(r.reservation?.draft?.origin, { mutationId: 'm', slot: 's', occurredAt: AT }, `stored origin kept occurredAt (${JSON.stringify(r.reservation?.draft)})`);
    for (const [label, other] of [['a changed occurredAt', b], ['occurredAt absent', c]]) {
      const o = await attempt(client, [other]);
      assert.equal(o.outcome, 'REJECTED', `${label}: a different intention under the same identity (${JSON.stringify(o).slice(0, 200)})`);
      assert.equal(o.reason, 'intent-collision');
    }
  });
});
