/**
 * #1894 — the READER behind reading.html, without a store: the shaping of rows, source order, the page of a claim, the
 * run id that goes into SPARQL, and the page file itself (it renders text from a web page, so it must never build markup
 * from it and never reach outside the board).
 *
 *   R1  a run id is `run-` + a lowercase UUID and nothing else; anything else is refused before it reaches a query
 *   R2  claims come back in SOURCE order: block 8 before block 10 (a lexical sort puts 10 first)
 *   R3  a claim carries its gist, its verbatim quote, its type, its verb (secondary), and the cards it may bear on
 *   R4  a dismissed link is listed on its claim but is not counted as a link the run has
 *   R5  a PDF's page comes from the kept text, only when that text hashes back to the source; a web article has no page
 *   R6  runs are newest first, a run that never wrote a report is `unfinished`, and `truncated` is honest
 *   R7  every IRI in a query comes from LOGBORN_TERMS (a mistyped one silently returns zero rows)
 *   R8  reading.html: no innerHTML/outerHTML/insertAdjacentHTML/document.write, no external URL, links only for http(s)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOGBORN_TERMS as TM } from '../core/graph-compiler.mjs';
import {
  isRunId, runIri, headersOf, blockOfPassage, shapeReading, shapeRuns, pagesOf, runsQuery, claimsQuery, claimLinksQuery, claimCountsQuery, linkCountsQuery,
} from '../core/knowledge-reading.mjs';

const RUN = 'run-44d706e1-16af-4a45-8671-d4baef63563b';
const R2 = 'run-61b68b31-9196-44af-a223-d16d4b6f61e0';
const iri = (v) => ({ type: 'uri', value: v });
const l = (v) => ({ type: 'literal', value: String(v) });
const claimRow = (id, block, extra = {}) => ({
  a: iri(`https://scrumboard.local/assertion/${id}`), pass: iri(`https://scrumboard.local/source/${'a'.repeat(64)}/block/${block}`),
  ...Object.fromEntries(Object.entries({ type: extra.type ?? 'definition', verb: extra.verb, gist: extra.gist ?? `gist ${id}`, span: extra.span ?? `quote ${id}` }).filter(([, v]) => v != null).map(([k, v]) => [k, l(v)])),
});
const header = { id: RUN, outcome: 'complete', startedAt: '2026-11-14T15:42:50.448Z', finishedAt: '2026-11-14T15:45:51.430Z', source: { title: 'T', url: 'https://example.com/a', synopsis: 'S' }, askedIn: null, sourceIri: `https://scrumboard.local/source/${'a'.repeat(64)}` };

test('R1 a run id is run- plus a lowercase UUID, and nothing else', () => {
  assert.equal(isRunId(RUN), true);
  for (const bad of ['', null, undefined, 42, `${RUN} `, ` ${RUN}`, RUN.toUpperCase(), 'run-44d706e1', `${RUN}>`, `${RUN}/extraction`, `x${RUN}`, '44d706e1-16af-4a45-8671-d4baef63563b', `${RUN}\n`, `${RUN}> } ; DROP`]) {
    assert.equal(isRunId(bad), false, `refused: ${JSON.stringify(bad)}`);
  }
  assert.throws(() => runIri(`${RUN}> } SELECT`), /not a run id/);
  assert.equal(runIri(RUN), `https://scrumboard.local/activity/${RUN}`);
  for (const q of [claimsQuery, claimLinksQuery]) assert.throws(() => q('run-x'), /not a run id/);
  assert.throws(() => claimCountsQuery([RUN, 'nope']), /not a run id/);
  assert.throws(() => runsQuery('nope'), /not a run id/);
});

test('R2 claims come back in source order: block 8 before block 10 (numeric, not lexical)', () => {
  const claimRows = [claimRow('c10', 10), claimRow('c2', 2), claimRow('c100', 100), claimRow('c8', 8), claimRow('c9', 9)];
  const r = shapeReading({ header, claimRows, linkRows: [], cardOf: () => null });
  assert.deepEqual(r.claims.map((c) => c.block), [2, 8, 9, 10, 100]);
  assert.deepEqual(r.claims.map((c) => c.id), ['c2', 'c8', 'c9', 'c10', 'c100']);
  assert.equal(r.run.claims, 5);
});

test('R2b a claim with no passage sorts last, and a tie in one block is stable (by id)', () => {
  const noPass = claimRow('zz', 1); delete noPass.pass;
  const r = shapeReading({ header, claimRows: [noPass, claimRow('b', 3), claimRow('a', 3)], linkRows: [], cardOf: () => null });
  assert.deepEqual(r.claims.map((c) => c.id), ['a', 'b', 'zz']);
  assert.equal(r.claims[2].block, null);
});

test('R3 a claim carries gist, quote, type, verb and its links to cards (best score first)', () => {
  const a = claimRow('c1', 4, { type: 'recommendation', verb: 'should_hold', gist: 'Keep memory small.', span: 'memory should only hold what it cannot look up' });
  const link = (id, st, sc, card) => ({ l: iri(`https://scrumboard.local/link/${id}`), a: a.a, c: iri(`https://scrumboard.local/entity/${card}`), st: l(st), ...(sc == null ? {} : { sc: l(sc) }) });
  const cards = { 'uuid-2': { shortId: 2, title: 'card two' }, 'uuid-3': { shortId: 3, title: 'card three' } };
  const r = shapeReading({ header, claimRows: [a], linkRows: [link('x'.repeat(64), 'proposed', '0.61', 'uuid-3'), link('y'.repeat(64), 'confirmed', '0.72', 'uuid-2')], cardOf: (i) => cards[i.split('/').pop()] ?? null });
  const c = r.claims[0];
  assert.equal(c.gist, 'Keep memory small.');
  assert.equal(c.quote, 'memory should only hold what it cannot look up');
  assert.equal(c.type, 'recommendation');
  assert.equal(c.verb, 'should_hold');
  assert.deepEqual(c.links.map((x) => [x.card.shortId, x.card.title, x.status, x.score]), [[2, 'card two', 'confirmed', 0.72], [3, 'card three', 'proposed', 0.61]]);
  assert.equal(c.page, null, 'no page for a claim of a web source');
  assert.equal(r.source.synopsis, 'S');
});

test('R3b a claim the model gave no gist for keeps its quote and a null gist (the page falls back, nothing is invented)', () => {
  const row = claimRow('c1', 1); delete row.gist;
  const c = shapeReading({ header, claimRows: [row], linkRows: [], cardOf: () => null }).claims[0];
  assert.equal(c.gist, null);
  assert.equal(c.quote, 'quote c1');
});

test('R4 a dismissed link is listed on its claim but is not counted as a link the run has', () => {
  const a = claimRow('c1', 4);
  const link = (id, st) => ({ l: iri(`https://scrumboard.local/link/${id}`), a: a.a, c: iri('https://scrumboard.local/entity/uuid-2'), st: l(st) });
  const r = shapeReading({ header, claimRows: [a], linkRows: [link('1', 'dismissed'), link('2', 'proposed')], cardOf: () => ({ shortId: 2, title: 't' }) });
  assert.equal(r.claims[0].links.length, 2);
  assert.equal(r.run.links, 1);
});

test('R5 a PDF claim\'s page comes from the kept text, and only when that text hashes back to the source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr1894-'));
  try {
    // block 0,1 on page 1; the form feed opens page 2 at block 2; page 3 at block 4
    const text = ['alpha line', 'beta line', '\fgamma line', 'delta line', '\fepsilon line'].join('\n');
    const hex = crypto.createHash('sha256').update(text).digest('hex');
    fs.mkdirSync(path.join(dir, 'sources'));
    fs.writeFileSync(path.join(dir, 'sources', `${hex}.txt`), text);
    const sourceIri = `https://scrumboard.local/source/${hex}`;
    const pageOf = pagesOf({ sourceIri, url: 'urn:sha256:' + 'b'.repeat(64), dataDir: dir });
    assert.deepEqual([0, 1, 2, 3, 4].map(pageOf), [1, 1, 2, 2, 3]);
    assert.equal(pageOf(99), null, 'a block past the text has no page');
    // a web article never gets a page, even with the same bytes on disk
    assert.equal(pagesOf({ sourceIri, url: 'https://example.com/x', dataDir: dir }), null);
    // a file whose bytes do not hash to its name is not the text the claims were anchored in
    fs.writeFileSync(path.join(dir, 'sources', `${hex}.txt`), text + ' tampered');
    assert.equal(pagesOf({ sourceIri, url: 'urn:sha256:' + 'b'.repeat(64), dataDir: dir }), null);
    // a source IRI that is not hash-shaped never becomes a path
    assert.equal(pagesOf({ sourceIri: 'https://scrumboard.local/source/../../etc/passwd', url: 'urn:sha256:x', dataDir: dir }), null);
    assert.equal(pagesOf({ sourceIri: 'https://elsewhere.example/source/' + hex, url: 'urn:sha256:x', dataDir: dir }), null);
    // no kept text on disk: no pages, no throw
    assert.equal(pagesOf({ sourceIri: `https://scrumboard.local/source/${'c'.repeat(64)}`, url: 'urn:sha256:x', dataDir: dir }), null);
    // the pages reach the claims
    fs.writeFileSync(path.join(dir, 'sources', `${hex}.txt`), text);
    const r = shapeReading({ header: { ...header, sourceIri }, claimRows: [claimRow('c', 3)], linkRows: [], cardOf: () => null, pageOf });
    assert.equal(r.claims[0].page, 2);
    assert.equal(r.source.hasPages, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R6 runs are newest first, an unreported run is "unfinished", and truncated says when the list was cut', () => {
  const row = (id, extra) => ({ r: iri(`https://scrumboard.local/activity/${id}`), src: iri(`https://scrumboard.local/source/${'a'.repeat(64)}`), ...extra });
  const runRows = [
    row(RUN, { st: l('2026-11-14T15:42:50.448Z'), at: l('2026-11-14T15:45:51.430Z'), out: l('complete'), name: l('Newest') }),
    row('run-60180d55-bad5-4661-bc45-8acbbf206ee7', { st: l('2026-11-08T15:52:01.902Z') }),
    row(R2, { st: l('2026-11-14T15:54:16.111Z'), at: l('2026-11-14T15:55:50.404Z'), out: l('complete'), url: l('https://example.com/a') }),
  ];
  const claimRows = [{ r: runRows[0].r, n: l(45) }, { r: runRows[2].r, n: l(22) }];
  const linkRows = [{ r: runRows[0].r, st: l('proposed'), n: l(3) }, { r: runRows[0].r, st: l('dismissed'), n: l(2) }, { r: runRows[0].r, st: l('confirmed'), n: l(1) }];
  const all = shapeRuns({ runRows, claimRows, linkRows, limit: 10 });
  assert.deepEqual(all.readings.map((x) => x.id), [R2, RUN, 'run-60180d55-bad5-4661-bc45-8acbbf206ee7']);
  assert.equal(all.truncated, false);
  const mine = all.readings.find((x) => x.id === RUN);
  assert.deepEqual([mine.claims, mine.links, mine.outcome, mine.title], [45, 4, 'complete', 'Newest']);
  assert.deepEqual(mine.linksByStatus, { proposed: 3, confirmed: 1, dismissed: 2 });
  const dead = all.readings[2];
  assert.deepEqual([dead.outcome, dead.claims, dead.links, dead.finishedAt], ['unfinished', 0, 0, null]);
  const cut = shapeRuns({ runRows, claimRows, linkRows, limit: 2 });
  assert.equal(cut.readings.length, 2);
  assert.equal(cut.truncated, true);
  assert.equal(shapeRuns({ runRows, claimRows, linkRows, limit: 3 }).truncated, false, 'CONTROL: exactly the limit is not a cut');
});

test('R6b one run asked for in two posts is ONE reading, naming the first post that asked (production had two such runs)', () => {
  const run = iri(`https://scrumboard.local/activity/${RUN}`); const src = iri(`https://scrumboard.local/source/${'a'.repeat(64)}`);
  const rows = [{ r: run, src, seq: l(51509), st: l('2026-11-08T19:40:18.326Z'), out: l('failed') }, { r: run, src, seq: l(51492), st: l('2026-11-08T19:40:18.326Z'), out: l('failed') }];
  const all = shapeRuns({ runRows: rows, claimRows: [], linkRows: [], limit: 10 });
  assert.equal(all.readings.length, 1);
  assert.equal(all.readings[0].askedIn.postSeq, 51492);
  assert.equal(headersOf(rows.slice().reverse()).length, 1);
  assert.equal(headersOf(rows.slice().reverse())[0].askedIn.postSeq, 51492, 'whichever row arrives first');
});

test('R7 every IRI in every query is one the compiler\'s term table (or its namespaces) names', () => {
  const known = new Set([...Object.values(TM)]);
  const SCRUM = TM.Assertion.slice(0, -'Assertion'.length); const PROV = TM.startedAtTime.slice(0, -'startedAtTime'.length);
  known.add(`${SCRUM}op`); known.add(`${PROV}used`);
  const ids = [RUN, R2];
  for (const q of [runsQuery(), runsQuery(RUN), claimCountsQuery(ids), linkCountsQuery(ids), claimsQuery(RUN), claimLinksQuery(RUN)]) {
    for (const [, v] of q.matchAll(/<([^>]+)>/g)) {
      if (v.startsWith('https://scrumboard.local/activity/')) continue;   // the run id, validated
      assert.ok(known.has(v), `${v} is not a term the compiler names (in: ${q.slice(0, 80)}…)`);
    }
  }
});

// ── R8: the page ─────────────────────────────────────────────────────────────────────────────────────────────────────
const PAGE = fs.readFileSync(new URL('../reading.html', import.meta.url), 'utf8');
const SCRIPTS = [...PAGE.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

test('R8a reading.html never builds markup from graph text: no innerHTML / outerHTML / insertAdjacentHTML / document.write / eval', () => {
  assert.ok(SCRIPTS.length > 500, 'the page has its own script to inspect');
  for (const bad of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function\s*\(/, /\.srcdoc\b/, /setAttribute\(\s*['"]on/i]) {
    assert.ok(!bad.test(SCRIPTS), `page script must not use ${bad}`);
  }
  // the shared nav is the one exception the other pages use: it comes from a static constant module, not from this page
  assert.ok(!/mountTopNav/.test(SCRIPTS) || /import \{ mountTopNav \} from '\.\/core\/header\.mjs'/.test(PAGE));
});

test('R8b reading.html reaches nothing outside the board: no external URL, no CDN, no remote font or style', () => {
  const urls = [...PAGE.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
  assert.deepEqual(urls, [], `external URL in the page: ${urls.join(' ')}`);
  assert.ok(!/@import\s+url|<link[^>]+href="https?:/i.test(PAGE));
  assert.ok(!/<script[^>]+src="(?!\.\/core\/)/i.test(PAGE), 'only the board\'s own scripts');
});

test('R8c a source url becomes a link only for http: and https:, and a urn: source is shown as text', () => {
  assert.match(SCRIPTS, /\^https\?:/, 'the page checks the scheme before it makes a link');
  assert.match(SCRIPTS, /textContent/);
  assert.ok(/noopener/.test(SCRIPTS) && /noreferrer/.test(SCRIPTS), 'an outbound link carries rel noopener noreferrer');
});

test('R8d the page says plainly what happened in each state: loading, empty, error, unavailable', () => {
  for (const s of ['Loading', 'has not read anything yet', 'are not available on this board', 'could not']) assert.ok(PAGE.includes(s), `the page names its ${JSON.stringify(s)} state`);
});
