/**
 * #1689 — AMBIENT RECALL, the pure half and the in-process engine: a room post that touches a topic the room has READ
 * carries a pointer to that reading, with the sentence that matched; otherwise it stays silent. No graph, no model here:
 * the claims are rows handed in, the embedder is a function, and the files live in a temp folder.
 *
 *   C1  the tracked config loads; every key is required, an unknown key is refused by name, ranges are checked, no fallback
 *   C2  the repo's own knowledge-recall.json is valid and holds the measured numbers
 *   Q1  a claim's text is its gist, or its verbatim quote when it has no gist; a run id is emitted only in its exact shape
 *   B1  the bar: a text above minScore surfaces the claim, one below does not (vectors under the test's control)
 *   B2  one item per source (its best claim), sorted by score, at most k
 *   B3  a source whose own url is in the text is left out
 *   B4  a long quote is cut with quoteTruncated
 *   E1  the engine embeds what is new, in batches no larger than maxEmbed, and says partial until every claim is embedded
 *   E2  the index persists: a new engine over the same file embeds nothing again; a different model re-embeds everything
 *   E3  the embedder down, or slower than the deadline: available:false with the reason, never an empty answer
 *   E4  recall off (config invalid, unit off, no embedder): available:false and off:true, and nothing is embedded
 *   E5  no claims at all: an answer (the search ran over nothing), and the embedder is not asked
 *   S1  the quiet rule: a source attached at post N is not attached at N+1…N+quietPosts, and is again at N+quietPosts+1
 *   S2  the work queue is written atomically, capped by sequence, reads back the same, and an unreadable one is never overwritten
 *   S3  the offer cache: loaded from its file, or rebuilt ONCE from the graph when the file is missing; reads add nothing
 *   H1  the hook never makes its caller wait, and decides each post once, which a re-read gives back unchanged
 *   H2  unavailable → retried on a later post's success (oldest first, at most 2 per trigger), each at most 3 tries in all
 *   H3  a retry applies the quiet rule as of the retried post's own sequence, and never rewrites another post's offers
 *   H4  computed-but-nothing is stored (never recomputed) and is not shown to readers
 *   H5  an offer exists only once its write is APPLIED: a failed write leaves the post unavailable and it is retried; a write
 *       that landed although reported failed is taken back (the writer reads it), exactly once
 *   K1  the queue's counts: unavailable, pending retries, gave up, and `since`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  validateRecallConfig, readRecallConfig, RECALL_CONFIG_FILE, claimsOfRows, claimText, recallItems, publicItem,
  createRecallEngine, createRecallQueue, createOfferProjection, createRecallHook, applyQuiet,
} from '../core/knowledge-recall.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'recall1689-'));
const uuid = () => crypto.randomUUID();
const GOOD = { minScore: 0.62, maxItems: 2, quietPosts: 20, minChars: 80, deadlineMs: 5000 };

test('C1 the config: every key required, unknown keys refused by name, ranges checked, no fallback', () => {
  assert.deepEqual(validateRecallConfig(GOOD), { ok: true, ...GOOD });
  for (const k of Object.keys(GOOD)) {
    const { [k]: _, ...rest } = GOOD;
    const v = validateRecallConfig(rest);
    assert.equal(v.ok, false); assert.match(v.error, new RegExp(`${k} is missing`));
  }
  const unk = validateRecallConfig({ ...GOOD, minscore: 0.5 });
  assert.equal(unk.ok, false); assert.match(unk.error, /unknown key "minscore"/);
  for (const [k, bad] of [['minScore', 1.5], ['minScore', '0.6'], ['maxItems', 0], ['maxItems', 6], ['maxItems', 1.5], ['quietPosts', -1], ['minChars', 0], ['deadlineMs', 0], ['deadlineMs', 120001]]) {
    const v = validateRecallConfig({ ...GOOD, [k]: bad });
    assert.equal(v.ok, false, `${k}=${JSON.stringify(bad)} is refused`); assert.match(v.error, new RegExp(k));
  }
  assert.equal(validateRecallConfig(null).ok, false);
  assert.equal(validateRecallConfig([]).ok, false);
  const d = tmp();
  try {
    assert.match(readRecallConfig(path.join(d, 'absent.json')).error, /cannot be read/);
    fs.writeFileSync(path.join(d, 'bad.json'), '{ not json');
    assert.match(readRecallConfig(path.join(d, 'bad.json')).error, /is not JSON/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('C2 the repo\'s own knowledge-recall.json is valid and holds the measured numbers', () => {
  assert.equal(path.basename(RECALL_CONFIG_FILE), 'knowledge-recall.json');
  assert.deepEqual(readRecallConfig(), { ok: true, ...GOOD });
});

// ── rows as the executor returns them for the claims query ────────────────────────────────────────────────────────────
const lit = (v) => (v == null ? undefined : { type: 'literal', value: String(v) });
const iri = (v) => ({ type: 'uri', value: v });
function claimRow({ a = `https://scrumboard.local/assertion/${uuid()}`, gist = 'g', quote = 'q', run = `run-${uuid()}`, src = 'https://scrumboard.local/source/s1', name = 'A source', url = 'https://example.com/a', at = new Date().toISOString() } = {}) {
  const row = { a: iri(a), r: iri(`https://scrumboard.local/activity/${run}`), src: iri(src) };
  for (const [k, v] of Object.entries({ gist, span: quote, name, url, at })) if (v != null) row[k] = lit(v);
  return row;
}

test('Q1 a claim\'s text is its gist, else its quote; a run id is emitted only in its exact shape; claims dedupe by IRI', () => {
  const a = 'https://scrumboard.local/assertion/x1';
  const cs = claimsOfRows([claimRow({ a, gist: 'The gist.' }), claimRow({ a, gist: 'The gist.' }), claimRow({ gist: null, quote: 'Only a quote.' }), claimRow({ gist: '  ', quote: '' }), claimRow({ run: 'run-NOT-A-UUID' })]);
  assert.equal(cs.length, 3, 'one per claim IRI; a claim with no text at all is not a claim recall can match');
  assert.equal(claimText(cs[0]), 'The gist.');
  assert.equal(claimText(cs[1]), 'Only a quote.');
  assert.equal(cs[2].runId, null, 'a run IRI whose last segment is not run-<uuid> is never emitted');
  assert.match(cs[0].runId, /^run-[0-9a-f-]{36}$/);
});

// ── vectors under the test's control ──────────────────────────────────────────────────────────────────────────────────
const AX = ['kiwi', 'melon', 'plum', 'fig', 'pear'];
const vec = (t) => { const s = String(t).toLowerCase(); const v = AX.map((w) => (s.match(new RegExp(`\\b${w}\\b`, 'g')) || []).length); return v.some(Boolean) ? [...v, 0] : [0, 0, 0, 0, 0, 1]; };
const rowsFor = (claims) => new Map(claims.map((c) => { const v = Float32Array.from(vec(claimText(c))); return [c.iri, { hash: 'h', vec: v, norm: Math.hypot(...v) }]; }));

test('B1 the bar: above minScore surfaces, below does not', () => {
  const claims = claimsOfRows([claimRow({ gist: 'kiwi' })]);
  const rows = rowsFor(claims);
  const above = recallItems({ queryVec: vec('kiwi kiwi melon melon'), claims, rows, minScore: 0.62, k: 2, text: '' });   // 0.707
  const below = recallItems({ queryVec: vec('kiwi melon melon'), claims, rows, minScore: 0.62, k: 2, text: '' });         // 0.447
  assert.equal(above.length, 1); assert.equal(above[0].score, 0.707);
  assert.deepEqual(below, []);
});

test('B2 one item per source, its best claim; sorted; at most k; B3 own url excluded; B4 long quote cut', () => {
  const long = 'x'.repeat(400);
  const claims = claimsOfRows([
    claimRow({ gist: 'kiwi melon', src: 'S1', url: 'https://example.com/one', name: 'One' }),
    claimRow({ gist: 'kiwi', src: 'S1', url: 'https://example.com/one', name: 'One', quote: long }),
    claimRow({ gist: 'kiwi plum', src: 'S2', url: 'https://example.com/two', name: 'Two' }),
    claimRow({ gist: 'kiwi fig fig', src: 'S3', url: 'https://example.com/three', name: 'Three' }),
  ]);
  const rows = rowsFor(claims);
  const got = recallItems({ queryVec: vec('kiwi'), claims, rows, minScore: 0.5, k: 5, text: '' });
  assert.deepEqual(got.map((i) => i.source.title), ['One', 'Two'], 'S1 once (its exact claim, 1.0), then S2 (0.707); S3 at 0.447 is under the bar');
  assert.equal(got[0].why.gist, 'kiwi');
  assert.equal(got[0].why.quoteTruncated, true); assert.ok(got[0].why.quote.length <= 301);
  assert.equal('quoteTruncated' in got[1].why, false);
  assert.equal(recallItems({ queryVec: vec('kiwi'), claims, rows, minScore: 0.5, k: 1, text: '' }).length, 1, 'k caps it');
  const own = recallItems({ queryVec: vec('kiwi'), claims, rows, minScore: 0.5, k: 5, text: 'read this https://example.com/one please' });
  assert.deepEqual(own.map((i) => i.source.title), ['Two'], 'a post that links the document needs no pointer to it');
  const item = publicItem(got[0]);
  assert.deepEqual(Object.keys(item).sort(), ['readAt', 'readingPage', 'score', 'source', 'why']);
  assert.match(item.readingPage, /^\/reading\.html\?run=run-[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(item.why).sort(), ['claim', 'gist', 'quote', 'quoteTruncated']);
});

// ── the engine, over a fake embedder ──────────────────────────────────────────────────────────────────────────────────
function fakeEmbed({ delayMs = 0 } = {}) {
  const calls = [];
  const f = async (texts, opts = {}) => {
    calls.push(texts.length);
    if (f.down) throw new Error('embedder answered 500');
    if (f.delayMs || delayMs) await new Promise((r) => { const t = setTimeout(r, f.delayMs || delayMs); t.unref?.(); });
    return texts.map(vec);
  };
  f.calls = calls; f.down = false; f.delayMs = 0;
  return f;
}
function engineOver(dir, claims, { embed = fakeEmbed(), maxEmbed = 2, model = 'fake', config = GOOD, off = null } = {}) {
  const e = createRecallEngine({
    readConfig: () => (config.ok === false ? config : { ok: true, ...config }), offReason: () => off,
    queryClaims: async () => claims, embed, model, indexFile: path.join(dir, 'recall-index.jsonl'), maxEmbed, maxEmbedChars: 60000,
  });
  return { e, embed };
}

test('E1 embeds new claims in batches of maxEmbed and says partial until all are embedded', async () => {
  const d = tmp();
  try {
    const rows = ['kiwi', 'melon', 'plum', 'fig', 'pear'].map((g, i) => claimRow({ gist: g, src: `S${i}`, name: `N${i}` }));
    const { e, embed } = engineOver(d, rows);
    const text = 'kiwi '.repeat(20);
    let r = await e.recall(text);
    assert.equal(r.available, true);
    assert.deepEqual(r.searched, { claims: 5, embedded: 2, sources: 5 });
    assert.equal(r.partial, true);
    r = await e.recall(text); assert.deepEqual(r.searched, { claims: 5, embedded: 4, sources: 5 });
    r = await e.recall(text); assert.deepEqual(r.searched, { claims: 5, embedded: 5, sources: 5 }); assert.equal(r.partial, false);
    assert.equal(r.items[0].source.title, 'N0'); assert.equal(r.items[0].score, 1);
    assert.ok(embed.calls.every((n) => n <= 2), `no batch larger than maxEmbed: ${embed.calls}`);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('E2 the index persists across engines; a different model re-embeds everything', async () => {
  const d = tmp();
  try {
    const rows = ['kiwi', 'melon'].map((g, i) => claimRow({ gist: g, src: `S${i}` }));
    const one = engineOver(d, rows);
    await one.e.recall('kiwi kiwi kiwi');
    const two = engineOver(d, rows);
    const r = await two.e.recall('kiwi kiwi kiwi');
    assert.deepEqual(r.searched, { claims: 2, embedded: 2, sources: 2 });
    assert.deepEqual(two.embed.calls, [1], 'only the query was embedded: the claims were read back from the file');
    const three = engineOver(d, rows, { model: 'another' });
    const r3 = await three.e.recall('kiwi kiwi kiwi');
    assert.equal(r3.searched.embedded, 2);
    assert.deepEqual(three.embed.calls, [1, 2], 'a model change re-embeds the claims');
    assert.match(fs.readFileSync(path.join(d, 'recall-index.jsonl'), 'utf8').split('\n')[0], /"model":"another"/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('E3 embedder down or slower than the deadline: available:false with the reason', async () => {
  const d = tmp();
  try {
    const rows = [claimRow({ gist: 'kiwi' })];
    const down = fakeEmbed(); down.down = true;
    const r = await engineOver(d, rows, { embed: down }).e.recall('kiwi');
    assert.deepEqual({ available: r.available, items: r.items }, { available: false, items: [] }); assert.match(r.reason, /embedder/);
    const slow = fakeEmbed({ delayMs: 400 });
    const t0 = Date.now();
    const s = await engineOver(d, rows, { embed: slow, config: { ...GOOD, deadlineMs: 100 } }).e.recall('kiwi');
    assert.ok(Date.now() - t0 < 350, 'answered at the deadline, not when the embedder finished');
    assert.equal(s.available, false); assert.match(s.reason, /within 100 ms/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('E4 recall off: config invalid, unit off, no embedder: available:false, off:true, nothing embedded', async () => {
  const d = tmp();
  try {
    const bad = engineOver(d, [claimRow()], { config: { ok: false, error: 'knowledge-recall.json: minScore is missing (it has no default)' } });
    const r = await bad.e.recall('kiwi');
    assert.equal(r.available, false); assert.equal(r.off, true); assert.match(r.reason, /minScore is missing/);
    const off = engineOver(d, [claimRow()], { off: 'the log-born unit is off' });
    const r2 = await off.e.recall('kiwi');
    assert.equal(r2.available, false); assert.equal(r2.off, true); assert.match(r2.reason, /log-born/);
    assert.deepEqual([...bad.embed.calls, ...off.embed.calls], []);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('E5 no claims: an answer with nothing, and the embedder is not asked', async () => {
  const d = tmp();
  try {
    const { e, embed } = engineOver(d, []);
    const r = await e.recall('kiwi');
    assert.equal(r.available, true); assert.deepEqual(r.items, []); assert.deepEqual(r.searched, { claims: 0, embedded: 0, sources: 0 }); assert.equal(r.partial, false);
    assert.deepEqual(embed.calls, []);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── the state and the quiet rule ──────────────────────────────────────────────────────────────────────────────────────
const it = (src, score = 0.7) => ({ source: { title: src, url: null }, readingPage: null, readAt: null, why: { gist: src, quote: src, claim: `c-${src}` }, score, sourceIri: src, runId: null });

test('S1 the quiet rule by post sequence', () => {
  const entries = [{ seq: 100, sources: ['A'], items: [it('A')] }];
  for (let n = 101; n <= 120; n++) assert.deepEqual(applyQuiet({ items: [it('A'), it('B')], seq: n, entries, quietPosts: 20 }).map((i) => i.sourceIri), ['B'], `post ${n} is quiet on A`);
  assert.deepEqual(applyQuiet({ items: [it('A')], seq: 121, entries, quietPosts: 20 }).map((i) => i.sourceIri), ['A'], 'and A may surface again at N+21');
  assert.deepEqual(applyQuiet({ items: [it('A')], seq: 99, entries, quietPosts: 20 }).map((i) => i.sourceIri), ['A'], 'a LATER post never quiets an earlier one');
});

test('S2 the work queue: atomic, capped by sequence, reads back the same; an unreadable one is never overwritten', () => {
  const d = tmp(); const file = path.join(d, 'recall-queue.json');
  try {
    const s = createRecallQueue({ file, cap: 3 });
    assert.equal(s.load().ok, true);
    for (let n = 1; n <= 5; n++) s.decide(`p${n}`, { seq: n, at: new Date().toISOString(), none: true });
    assert.deepEqual(fs.readdirSync(d), ['recall-queue.json'], 'no temp file left behind');
    const back = createRecallQueue({ file, cap: 3 }); back.load();
    assert.equal(back.has('p1'), false); assert.equal(back.has('p2'), false); assert.equal(back.raw('p5').none, true);
    fs.writeFileSync(file, '{ torn');
    const torn = createRecallQueue({ file }); const l = torn.load();
    assert.equal(l.ok, false); assert.match(l.error, /recall-queue\.json/);
    assert.throws(() => torn.decide('p9', { seq: 9, none: true }), /not loaded/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ torn');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('S3 the offer cache: from its file, or rebuilt once from the graph; a missing file gives back the same answer', async () => {
  const d = tmp(); const file = path.join(d, 'recall-offers.json');
  try {
    let rebuilds = 0;
    const graph = new Map([['p1', { seq: 1, items: [it('S1', 0.7)] }]]);
    const rebuild = async () => { rebuilds++; return graph; };
    const a = createOfferProjection({ file }); await Promise.all([a.ensure(rebuild), a.ensure(rebuild)]);
    assert.equal(rebuilds, 1, 'single-flight');
    const first = JSON.stringify(a.publicOf('p1'));
    assert.deepEqual(JSON.parse(first), { items: [publicItem(it('S1', 0.7))] });
    const b = createOfferProjection({ file }); await b.ensure(rebuild);
    assert.equal(rebuilds, 1, 'the file is used when it is there');
    fs.rmSync(file);
    const c = createOfferProjection({ file }); await c.ensure(rebuild);
    assert.equal(rebuilds, 2); assert.equal(JSON.stringify(c.publicOf('p1')), first, 'the same recall on the same post');
    assert.equal(c.publicOf('p2'), undefined);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── the hook, over a fake offer writer that behaves as the graph does (fresh per post and source) ─────────────────────
function fakeGraph() {
  const nodes = new Map();   // `${post}|${source}` → item
  const g = { nodes, fail: null, landThenFail: false, writes: 0 };
  g.write = async (id, seq, items) => {
    g.writes++;
    if (g.fail) return { ok: false, reason: g.fail };
    const taken = items.filter((i) => nodes.has(`${id}|${i.sourceIri}`));
    if (taken.length) {   // the freshness refusal: read back what is there, as the server's writer does
      const back = [...nodes.entries()].filter(([k]) => k.startsWith(`${id}|`)).map(([, v]) => v);
      return back.length ? { ok: true, items: back, adopted: true } : { ok: false, reason: 'PRECONDITION_FAILED' };
    }
    for (const i of items) nodes.set(`${id}|${i.sourceIri}`, i);
    if (g.landThenFail) { g.landThenFail = false; return { ok: false, reason: 'the offer write is UNKNOWN: http 502' }; }
    return { ok: true, items };
  };
  return g;
}
function hookOver(dir, { embed = fakeEmbed(), rows = [claimRow({ gist: 'kiwi', src: 'SK', name: 'Kiwi' }), claimRow({ gist: 'plum', src: 'SP', name: 'Plum' })], texts = new Map() } = {}) {
  const { e } = engineOver(dir, rows, { embed, maxEmbed: 50 });
  const queue = createRecallQueue({ file: path.join(dir, 'recall-queue.json') }); queue.load();
  const projection = createOfferProjection({ file: path.join(dir, 'recall-offers.json') });
  const graph = fakeGraph();
  const hook = createRecallHook({ engine: e, queue, projection, ready: () => projection.ensure(async () => new Map()), readConfig: () => ({ ok: true, ...GOOD }),
    readPostText: async (id) => texts.get(id) ?? null, writeOffers: (...a) => graph.write(...a), log: () => {} });
  return { hook, queue, projection, embed, texts, graph };
}
const post = (h, id, seq, text) => { h.texts.set(id, text); h.hook.afterPost({ id, seq, text }); };
const shown = (h, id) => h.projection.publicOf(id) ?? h.queue.unavailableOf(id);

test('H1 the hook never makes its caller wait; one decision per post, stable on re-read', async () => {
  const d = tmp();
  try {
    const embed = fakeEmbed({ delayMs: 300 });
    const h = hookOver(d, { embed });
    const t0 = Date.now();
    post(h, 'a', 1, 'kiwi kiwi kiwi');
    assert.ok(Date.now() - t0 < 50, 'afterPost returned at once');
    assert.equal(h.queue.has('a'), false, 'nothing decided yet');
    await h.hook.idle();
    const first = JSON.stringify(shown(h, 'a'));
    assert.equal(JSON.parse(first).items[0].source.title, 'Kiwi');
    h.hook.afterPost({ id: 'a', seq: 1, text: 'plum plum' });   // the same post again: decided once
    await h.hook.idle();
    assert.equal(JSON.stringify(shown(h, 'a')), first);
    assert.equal(h.graph.writes, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('H2 unavailable → retried on later successes, oldest first, 2 per trigger, 3 tries in all, then gave up; H4 nothing is stored, absent', async () => {
  const d = tmp();
  try {
    const embed = fakeEmbed();
    const h = hookOver(d, { embed });
    embed.down = true;
    post(h, 'u1', 1, 'kiwi kiwi'); post(h, 'u2', 2, 'kiwi kiwi'); post(h, 'u3', 3, 'plum plum');
    await h.hook.idle();
    for (const id of ['u1', 'u2', 'u3']) assert.match(shown(h, id).unavailable, /embedder/);
    assert.equal(h.queue.raw('u1').tries, 1); assert.ok(h.queue.raw('u1').firstFailedAt);
    embed.down = false;
    post(h, 'ok4', 4, 'fig fig');   // succeeds (nothing above the bar) → retries u1, u2, not u3
    await h.hook.idle();
    assert.equal(shown(h, 'u1').items[0].source.title, 'Kiwi', 'the earlier post now carries its pointer');
    assert.equal(shown(h, 'u2'), undefined, 'u2 retried: Kiwi is quiet (u1 carries it, 1 post before) → nothing, absent');
    assert.equal(h.queue.raw('u2').none, true);
    assert.match(shown(h, 'u3').unavailable, /embedder/, 'the cap is 2 per trigger');
    assert.equal(shown(h, 'ok4'), undefined, 'computed, nothing surfaced: absent for readers');
    assert.equal(h.queue.raw('ok4').none, true, 'but stored, so it is never recomputed');
    const real = h.hook.engine.recall.bind(h.hook.engine);
    post(h, 'ok5', 5, 'pear pear'); await h.hook.idle();   // retries u3 (succeeds)
    embed.down = true; post(h, 'u6', 6, 'plum plum'); await h.hook.idle(); embed.down = false;
    assert.equal(h.queue.raw('u6').tries, 1);
    for (const [id, seq] of [['t7', 7], ['t8', 8]]) {
      h.hook.engine.recall = async (text, o) => (text === 'plum plum' ? { available: false, reason: `embedder answered 503 at ${id}`, items: [] } : real(text, o));
      post(h, id, seq, 'fig fig'); await h.hook.idle();
    }
    assert.equal(h.queue.raw('u6').tries, 3);
    assert.deepEqual(shown(h, 'u6'), { unavailable: 'embedder answered 503 at t8', gaveUp: true });
    h.hook.engine.recall = real;
    post(h, 't9', 9, 'fig fig'); await h.hook.idle();
    assert.equal(h.queue.raw('u6').tries, 3, 'no fourth try');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('H3 a retry decides as of its own sequence, and never rewrites a later post\'s offers', async () => {
  const d = tmp();
  try {
    const embed = fakeEmbed();
    const h = hookOver(d, { embed });
    embed.down = true; post(h, 'early', 10, 'kiwi kiwi'); await h.hook.idle(); embed.down = false;
    post(h, 'later', 11, 'kiwi kiwi'); await h.hook.idle();   // surfaces Kiwi itself (early had none yet), then retries early
    const laterBefore = JSON.stringify(shown(h, 'later'));
    assert.equal(shown(h, 'later').items[0].source.title, 'Kiwi');
    assert.equal(shown(h, 'early').items[0].source.title, 'Kiwi', 'the earlier post keeps the pointer: only PREVIOUS posts quiet it');
    assert.equal(JSON.stringify(shown(h, 'later')), laterBefore, 'the later post\'s offers are unchanged');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('H6 a post redacted while it waited for a retry is forgotten, not given up; forget drops a post from both files', async () => {
  const d = tmp();
  try {
    const embed = fakeEmbed();
    const h = hookOver(d, { embed });
    embed.down = true; post(h, 'gone', 1, 'kiwi kiwi'); await h.hook.idle(); embed.down = false;
    assert.ok(h.queue.has('gone'));
    h.texts.delete('gone');   // readPostText answers null: the post is a tombstone now
    post(h, 'next', 2, 'plum plum'); await h.hook.idle();
    assert.equal(h.queue.has('gone'), false, 'its id is kept nowhere, not even as gave up');
    assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'recall-queue.json'), 'utf8')).posts.gone, undefined);
    assert.ok(h.projection.has('next'));
    assert.deepEqual([h.queue.forget(['next', 'never']), h.projection.forget(['next', 'never'])], [1, 1]);
    assert.equal(h.projection.has('next'), false);
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(d, 'recall-offers.json'), 'utf8')).posts, 'next'), false, 'and the file says so');
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(d, 'recall-queue.json'), 'utf8')).posts, 'next'), false);
    assert.deepEqual([h.queue.forget(['next']), h.projection.forget(['next'])], [0, 0], 'a second forget writes nothing');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('H5 an offer exists only once APPLIED; a failed write is retried; one that landed though reported failed is taken back once', async () => {
  const d = tmp();
  try {
    const h = hookOver(d);
    h.graph.fail = 'the offer write is REJECTED: no';
    post(h, 'w1', 1, 'kiwi kiwi'); await h.hook.idle();
    assert.match(shown(h, 'w1').unavailable, /REJECTED/, 'not carried: the graph never accepted it');
    h.graph.fail = null;
    post(h, 'w2', 2, 'fig fig'); await h.hook.idle();
    assert.equal(shown(h, 'w1').items[0].source.title, 'Kiwi', 'the retry wrote it');
    h.graph.landThenFail = true;
    post(h, 'w3', 40, 'plum plum'); await h.hook.idle();
    assert.match(shown(h, 'w3').unavailable, /UNKNOWN/, 'reported failed, so not carried yet');
    assert.equal(h.graph.nodes.has('w3|SP'), true, 'though it landed');
    post(h, 'w4', 41, 'fig fig'); await h.hook.idle();
    assert.deepEqual(shown(h, 'w3').items.map((i) => i.source.title), ['Plum'], 'the retry took the landed offer back, exactly once');
    assert.equal([...h.graph.nodes.keys()].filter((k) => k.startsWith('w3|')).length, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('K1 the queue\'s counts', async () => {
  const d = tmp();
  try {
    const h = hookOver(d);
    h.hook.engine.recall = async () => ({ available: false, reason: 'embedder answered 500', items: [] });
    post(h, 'k3', 60, 'kiwi'); await h.hook.idle();
    assert.deepEqual(h.queue.counts(), { unavailable: 1, pendingRetries: 1, gaveUp: 0 });
    assert.deepEqual(h.queue.counts(new Date(Date.now() + 60_000).toISOString()), { unavailable: 0, pendingRetries: 0, gaveUp: 0 });
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
