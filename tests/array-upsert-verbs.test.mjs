/**
 * #1137 — acceptanceUpsert / blockersUpsert / checksUpsert.
 *
 * The three card arrays are whole-array REPLACE. #1132 made a replace without
 * ifVersion REFUSE, so a stale write is caught — but the common edit
 * ("discharge one condition", "clear one blocker", "add one check") still had
 * to read the array, mutate one entry locally and send every entry back. The
 * upsert sends ONE entry, matched on its key, and the server composes the
 * array under its write lock: untouched entries are never sent, so they
 * cannot be lost. Third surface of the verb #906 gave descriptions and #1022
 * gave memories. These tests are the card's own acceptance conditions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { patchWithVersion } from './helpers/versioned-patch.mjs';

async function api(baseUrl, method, path, body) {
  const payload = body ? JSON.stringify(body) : undefined;
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(payload ? { body: payload } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, sentBytes: payload ? Buffer.byteLength(payload) : 0 };
}

const SHA = 'a'.repeat(40);
const SHB = 'b'.repeat(40);
const card = (id, shortId, extra = {}) => ({
  id, shortId, title: `card ${shortId}`, description: '', type: 'task', labels: [], assignees: [],
  column: 'backlog', order: shortId, createdAt: '2026-08-01T00:00:00.000Z',
  relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [] },
  ...extra,
});
const board = () => makeBoardFixture({
  cards: [
    card('u-1', 1, { relationships: { relatedTo: [], blockedBy: [2, 3], supersedes: [], derivedFrom: [], supersededBy: [] } }),
    card('u-2', 2), card('u-3', 3),
  ],
  nextShortId: 4,
});

const FIVE = [
  { condition: 'RC1', evidence: [], note: 'one — a long note that must survive byte-for-byte: `code`, "quotes", /regex/' },
  { condition: 'RC2', evidence: [SHA], note: 'two' },
  { condition: 'RC3', evidence: [], note: 'three', blockedBy: [2] },
  { condition: 'RC4', evidence: [], note: 'four' },
  { condition: 'RC5', evidence: [], note: 'five' },
];

test('#1137 acceptanceUpsert on an EXISTING key replaces exactly that entry; the others are byte-identical', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const seed = await patchWithVersion(s.baseUrl, 1, { acceptance: FIVE, by: 'ada' });
    assert.equal(seed.status, 200, JSON.stringify(seed.body));

    const u = await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      acceptanceUpsert: [{ condition: 'RC4', evidence: [SHB], note: 'four — discharged' }], by: 'bex',
    });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal(u.body.ignoredFields, undefined, 'the verb must not be validated-then-discarded');

    const g = await api(s.baseUrl, 'GET', '/api/cards/1');
    const expect = FIVE.map((a) => (a.condition === 'RC4' ? { condition: 'RC4', evidence: [SHB], note: 'four — discharged' } : a));
    assert.deepEqual(g.body.acceptance, expect, 'RC4 replaced in place; RC1/2/3/5 untouched, order kept');
  } finally { await s.stop(); }
});

test('#1137 an upsert on an ABSENT key inserts; no ifVersion is needed — nothing to clobber by construction', async () => {
  const s = await startRestServer({ board: board() });
  try {
    await patchWithVersion(s.baseUrl, 1, { acceptance: FIVE.slice(0, 2), by: 'ada' });
    const u = await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      acceptanceUpsert: [{ condition: 'RC9', evidence: [], note: 'new' }], by: 'bex',
    });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    const g = await api(s.baseUrl, 'GET', '/api/cards/1');
    assert.deepEqual(g.body.acceptance.map((a) => a.condition), ['RC1', 'RC2', 'RC9']);
  } finally { await s.stop(); }
});

test('#1137 ⛔ NEGATIVE CONTROL — two seats upserting DIFFERENT keys concurrently BOTH survive', async () => {
  const s = await startRestServer({ board: board() });
  try {
    await patchWithVersion(s.baseUrl, 1, { acceptance: FIVE, by: 'ada' });
    // Fired with no await between them and no version: neither caller read the
    // other's entry, and neither sent the array. A whole-array write from
    // either would have deleted the other's — that is #466, measured.
    const [a, b] = await Promise.all([
      api(s.baseUrl, 'PATCH', '/api/cards/1', { acceptanceUpsert: [{ condition: 'RC1', evidence: [SHA], note: 'A closed it' }], by: 'ada' }),
      api(s.baseUrl, 'PATCH', '/api/cards/1', { acceptanceUpsert: [{ condition: 'RC5', evidence: [SHB], note: 'B closed it' }], by: 'bex' }),
    ]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const g = await api(s.baseUrl, 'GET', '/api/cards/1');
    const byKey = Object.fromEntries(g.body.acceptance.map((x) => [x.condition, x]));
    assert.deepEqual(byKey.RC1.evidence, [SHA], 'A survived');
    assert.deepEqual(byKey.RC5.evidence, [SHB], 'B survived');
    assert.equal(g.body.acceptance.length, 5, 'and nothing else changed');
  } finally { await s.stop(); }
});

test('#1137 blockersUpsert keys on card | person | anyHuman; checksUpsert keys on claim', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const seed = await patchWithVersion(s.baseUrl, 1, {
      blockers: [
        { card: 2, owner: 'ada', status: 'open', note: 'schema' },
        { card: 3, owner: 'ada', status: 'open' },
        { person: 'grace', status: 'open', note: 'her call' },
        { anyHuman: true, status: 'open', note: 'anyone' },
      ],
      checks: [
        { claim: 'C1', ask: 'ASK { ?x a scrum:Card }', expect: true },
        { claim: 'C2', ask: 'ASK { ?x a scrum:Nope }', expect: false },
      ],
      by: 'ada',
    });
    assert.equal(seed.status, 200, JSON.stringify(seed.body));

    const u = await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      blockersUpsert: [
        { card: 2, owner: 'ada', status: 'cleared', note: 'shipped' },   // replace by card
        { person: 'grace', status: 'cleared' },                          // replace by person (note dropped: whole-entry replace)
        { anyHuman: true, status: 'cleared', note: 'done' },              // replace the any-human entry
      ],
      checksUpsert: [
        { claim: 'C2', ask: 'ASK { ?x a scrum:Card }', expect: true },   // replace by claim
        { claim: 'C3', ask: 'ASK { ?x a scrum:Wake }', expect: true },   // insert
      ],
      by: 'bex',
    });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    const g = await api(s.baseUrl, 'GET', '/api/cards/1');
    assert.deepEqual(g.body.blockers, [
      { card: 2, owner: 'ada', status: 'cleared', note: 'shipped' },
      { card: 3, owner: 'ada', status: 'open' },
      { person: 'grace', status: 'cleared' },
      { anyHuman: true, status: 'cleared', note: 'done' },
    ]);
    assert.deepEqual(g.body.checks.map((c) => [c.claim, c.expect]), [['C1', true], ['C2', true], ['C3', true]]);
  } finally { await s.stop(); }
});

test('#1137 NEGATIVE CONTROL — the request carries only the entry sent', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const big = FIVE.map((a) => ({ ...a, note: a.note + ' ' + 'x'.repeat(800) }));
    const seed = await patchWithVersion(s.baseUrl, 1, { acceptance: big, by: 'ada' });
    assert.equal(seed.status, 200);
    const u = await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      acceptanceUpsert: [{ condition: 'RC3', evidence: [SHA], note: 'closed' }], by: 'bex',
    });
    assert.equal(u.status, 200);
    assert.ok(u.sentBytes < 200, `sent ${u.sentBytes} bytes to touch one of five ~800-byte entries`);
    const g = await api(s.baseUrl, 'GET', '/api/cards/1');
    assert.equal(g.body.acceptance[0].note, big[0].note, 'the untouched 800-byte note is intact');
    assert.deepEqual(g.body.acceptance[2], { condition: 'RC3', evidence: [SHA], note: 'closed' }, 'and the upsert landed');
  } finally { await s.stop(); }
});

test('#1137 a malformed upsert entry is refused with the whole-array validator\'s words and writes NOTHING', async () => {
  const s = await startRestServer({ board: board() });
  try {
    await patchWithVersion(s.baseUrl, 1, { acceptance: FIVE.slice(0, 2), by: 'ada' });

    const badEvidence = await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      acceptanceUpsert: [{ condition: 'RC1', evidence: ['not a sha'] }], by: 'bex',
    });
    assert.equal(badEvidence.status, 400);
    assert.match(badEvidence.body.error, /durable/);

    const badBlocker = await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      blockersUpsert: [{ card: 99, status: 'open' }], by: 'bex',
    });
    assert.equal(badBlocker.status, 400, 'an upsert blocker must still name a card in blockedBy');
    assert.match(badBlocker.body.error, /99/);

    const badCheck = await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      checksUpsert: [{ claim: 'C', ask: 'SELECT * WHERE {}', expect: true }], by: 'bex',
    });
    assert.equal(badCheck.status, 400);
    assert.match(badCheck.body.error, /ASK/);

    const empty = await api(s.baseUrl, 'PATCH', '/api/cards/1', { acceptanceUpsert: [], by: 'bex' });
    assert.equal(empty.status, 400, 'an empty upsert has nothing to upsert');

    const g = await api(s.baseUrl, 'GET', '/api/cards/1');
    assert.deepEqual(g.body.acceptance, FIVE.slice(0, 2), 'nothing was written by any refused request');
    assert.equal(g.body.blockers, undefined);
    assert.equal(g.body.checks, undefined);
  } finally { await s.stop(); }
});

test('#1137 NEGATIVE CONTROL — the whole-array field and its upsert in ONE write → 400', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const both = await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      acceptance: FIVE, acceptanceUpsert: [{ condition: 'RC1' }], ifVersion: 0, by: 'ada',
    });
    assert.equal(both.status, 400, 'replace and upsert in one write are two intentions');
    assert.match(both.body.error, /acceptanceUpsert/);
    const g = await api(s.baseUrl, 'GET', '/api/cards/1');
    assert.equal(g.body.acceptance, undefined, 'nothing written');
  } finally { await s.stop(); }
});

test('#1137 graph projection after an upsert MATCHES a whole-array write of the same final state', async () => {
  const s = await startRestServer({ board: board() });
  try {
    await patchWithVersion(s.baseUrl, 1, { acceptance: FIVE.slice(0, 3), by: 'ada' });
    await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      acceptanceUpsert: [{ condition: 'RC2', evidence: [SHB], note: 'two — closed' }], by: 'bex',
    });
    const Q = (n) => `SELECT ?cond ?ev WHERE {
      ?rc a scrum:ReleaseCondition ; scrum:ofCard ?c ; schema:name ?cond .
      OPTIONAL { ?rc scrum:evidencedBy ?ev }
      ?c schema:identifier "${n}" .
    } ORDER BY ?cond ?ev`;
    const viaUpsert = await api(s.baseUrl, 'POST', '/api/graph', { query: Q(1) });
    assert.equal(viaUpsert.status, 200, JSON.stringify(viaUpsert.body));

    // The same final state written wholesale on a fresh card 2.
    const wholesale = await patchWithVersion(s.baseUrl, 2, {
      acceptance: [FIVE[0], { condition: 'RC2', evidence: [SHB], note: 'two — closed' }, FIVE[2]], by: 'ada',
    });
    assert.equal(wholesale.status, 200, JSON.stringify(wholesale.body));
    const viaWhole = await api(s.baseUrl, 'POST', '/api/graph', { query: Q(2) });
    const rows = (r) => r.body.rows.map((x) => JSON.stringify([x.cond, x.ev ?? null]));
    assert.ok(rows(viaUpsert).length >= 3, `expected rows, got ${JSON.stringify(viaUpsert.body).slice(0, 300)}`);
    assert.deepEqual(rows(viaUpsert), rows(viaWhole), 'same nodes either way');
  } finally { await s.stop(); }
});
