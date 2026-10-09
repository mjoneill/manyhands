/**
 * #1570 follow-up, THE PERSISTENCE BOUNDARY OF THE QUERY-SHAPE LOGS (test author, written BEFORE the fix, 2026-10-09). A pre-existing leak, found by the caller/peer rows: the
 * `[card-query]` and `[changes-query]` warn lines printed `url=${req.url}`, and the SAME full URL is written to the durable miss log (board-data-misses.jsonl, served by /api/misses). A query
 * string can carry a token. The policy these rows pin, from the reviewer: URL query VALUES are never stored or logged; PARAMETER NAMES are kept, and the seat (`as`) is deliberately kept as a
 * SANITISED token. Sanitising is not redaction: a value made only of allowed characters survives unchanged, so M3 pins the seat exception explicitly. The rows read the durable file ON DISK and
 * /api/misses, not only stderr.
 *
 *   M0 CONTROL  an unsupported filter is still recorded, with its NAME and the seat, and the stored url names the param but not its value
 *   M1          a secret value in a param value or in a second, unknown param (token=...): absent from the miss FILE, from /api/misses, and from REST's stderr; the NAMES are kept
 *   M2          crafted names (%0A, %0D%0A) are stored as SAFE TOKENS: no stored field holds a line break or whitespace. (The FILE cannot be split by a newline whatever is stored, because records are
 *               JSON.stringify'd and a newline is escaped; so this row does NOT demonstrate a record split and must not be read as one. What CAN be split by a raw newline is the stderr warn line, which
 *               it also pins: one warn line per request.)
 *   M3          the seat exception: as=ada is kept as "ada"; a crafted seat (a newline, a quote, a forged JSON object) is ONE safe token and creates no extra record
 *   M4          bounded: a 5,000-character parameter name and a 500-character seat are cut to at most 64 characters each in what is stored
 *   M6          a plain SPACE in a seat or a name cannot forge a field: the stderr warn line is `key=value` pairs, so a seat `ada unsupported=forged` must not add a second `unsupported=` field; stored without whitespace
 *   M5          the /api/changes warn line: the name is kept, the value is absent
 *
 * NOT covered, by name: records already in the file (the fix is forward-only; historical entries are not touched), other routes that log req.url, the miss log's ranking in /api/misses beyond M0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const missLogPathFor = (boardFile) => boardFile.replace(/\.json$/, '') + '-misses.jsonl';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRest(body) {
  const rest = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try { return await body(rest); } finally { await rest.stop(); }
}
const get = async (rest, route) => { const r = await fetch(`${rest.baseUrl}${route}`, { signal: AbortSignal.timeout(30000) }); await r.text(); return r.status; };
const fileOf = (rest) => { const f = missLogPathFor(rest.boardFile); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; };
const recordsOf = (rest) => fileOf(rest).split('\n').filter(Boolean).map((l) => JSON.parse(l));   // throws if ANY line is not one JSON record
const missesApi = async (rest) => (await (await fetch(`${rest.baseUrl}/api/misses`)).text());

test('M0 CONTROL: an unsupported filter is still recorded with its NAME and the seat; the stored url names the param but not its value', async () => {
  await withRest(async (rest) => {
    await get(rest, '/api/cards?sortBy=SORTVALUE-31&as=ada');
    const recs = recordsOf(rest); assert.equal(recs.length, 1, 'one miss recorded');
    assert.equal(recs[0].param, 'sortBy'); assert.equal(recs[0].seat, 'ada'); assert.ok(recs[0].at);
    assert.ok(recs[0].url.startsWith('/api/cards'), `the url keeps the path: ${recs[0].url}`); assert.ok(recs[0].url.includes('sortBy'), 'and the param name');
    assert.ok(!recs[0].url.includes('SORTVALUE-31'), `and NOT its value: ${recs[0].url}`);
  });
});

test('M1 a secret value is absent from the miss file on disk, from /api/misses and from REST\'s stderr; the names are kept', async () => {
  await withRest(async (rest) => {
    await get(rest, '/api/cards?sortBy=SECRETVAL-77&token=QSECRET-4242&as=ada');
    await sleep(300);
    const recs = recordsOf(rest); assert.deepEqual(recs.map((r) => r.param).sort(), ['sortBy', 'token'], 'both unsupported NAMES are kept');
    for (const secret of ['SECRETVAL-77', 'QSECRET-4242']) {
      assert.ok(!fileOf(rest).includes(secret), `${secret} is in the miss FILE`);
      assert.ok(!(await missesApi(rest)).includes(secret), `${secret} is in /api/misses`);
      assert.ok(!rest.stderr().includes(secret), `${secret} is in REST's stderr`);
    }
  });
});

test('M2 crafted names are stored as safe tokens (no line break or whitespace in any stored field) and a name with a newline does not split the stderr warn line', async () => {
  await withRest(async (rest) => {
    await get(rest, '/api/cards?bad%0Aname=1&x%0D%0Ay=2&as=ada');
    await sleep(300);
    const text = fileOf(rest); const lines = text.split('\n').filter(Boolean);
    const recs = lines.map((l) => JSON.parse(l)); assert.equal(recs.length, 2, `two names -> two records (${lines.length} lines; the file is JSON-per-line, so this holds even when the stored name is raw)`);
    for (const r of recs) for (const [k, v] of Object.entries(r)) if (typeof v === 'string' && k !== 'at') assert.ok(!/[\r\n\s]/.test(v), `field ${k} holds whitespace or a line break: ${JSON.stringify(v)}`);
    const warns = rest.stderr().split('\n').filter((l) => l.includes('[card-query]'));
    assert.equal(warns.length, 1, `one warn line for one request (got ${warns.length}): a name with a newline must not split it`);
  });
});

test('M3 the seat exception: as=ada is kept as "ada"; a crafted seat is ONE safe token and creates no extra record', async () => {
  await withRest(async (rest) => {
    await get(rest, '/api/cards?sortBy=title&as=ada');
    await get(rest, `/api/cards?sortBy=title&as=${encodeURIComponent('ada\n{"forged":true,"seat":"root"}')}`);
    await sleep(300);
    const recs = recordsOf(rest); assert.equal(recs.length, 2, 'two requests -> two records, the crafted seat forged no third');
    assert.equal(recs[0].seat, 'ada', 'the seat is DELIBERATELY retained (a value made of allowed characters survives unchanged: sanitising is not redaction)');
    const crafted = recs[1].seat; assert.ok(typeof crafted === 'string' && crafted.length >= 1 && !/[\s"{}\n\r]/.test(crafted), `the crafted seat is one safe token: ${JSON.stringify(crafted)}`);
    assert.ok(recs.every((r) => r.seat !== 'root'), 'and a forged "seat":"root" did not become a field');
  });
});

test('M4 bounded: a 5,000-character parameter name and a 500-character seat are cut to at most 64 characters in what is stored', async () => {
  await withRest(async (rest) => {
    await get(rest, `/api/cards?${'p'.repeat(5000)}=1&as=${'s'.repeat(500)}`);
    await sleep(300);
    const recs = recordsOf(rest); assert.equal(recs.length, 1);
    assert.ok(recs[0].param.length >= 1 && recs[0].param.length <= 64, `param length ${recs[0].param.length}`);
    assert.ok(recs[0].seat.length >= 1 && recs[0].seat.length <= 64, `seat length ${recs[0].seat.length}`);
    assert.ok(recs[0].url.length <= 300, `the stored url is bounded too (${recs[0].url.length})`);
  });
});

test('M5 the /api/changes warn line keeps the name and drops the value', async () => {
  await withRest(async (rest) => {
    await get(rest, '/api/changes?bogus=CHANGESECRET-9&as=ada&bestEffort=true');
    assert.ok(await rest.waitForStderr(/\[changes-query\]/, 10000), 'CONTROL: the unsupported-parameter warn line is written');
    const line = rest.stderr().split('\n').find((l) => l.includes('[changes-query]'));
    assert.ok(line.includes('bogus'), `the name is kept: ${line}`); assert.ok(!line.includes('CHANGESECRET-9'), `the value is not: ${line}`);
  });
});

test('M6 a plain space in the seat or in a name cannot forge a field in the stderr warn line, and is stored without whitespace', async () => {
  await withRest(async (rest) => {
    await get(rest, `/api/cards?${encodeURIComponent('bad name=x')}=1&as=${encodeURIComponent('ada unsupported=forged seat=root')}`);
    await sleep(300);
    const warns = rest.stderr().split('\n').filter((l) => l.includes('[card-query]'));
    assert.equal(warns.length, 1, 'one warn line');
    assert.equal((warns[0].match(/\bseat=/g) || []).length, 1, `exactly one seat= field in: ${warns[0]}`);
    assert.equal((warns[0].match(/\bunsupported=/g) || []).length, 1, `exactly one unsupported= field in: ${warns[0]}`);
    const recs = recordsOf(rest); assert.ok(recs.length >= 1);
    for (const r of recs) for (const [k, v] of Object.entries(r)) if (typeof v === 'string' && k !== 'at') assert.ok(!/\s/.test(v), `field ${k} holds a space: ${JSON.stringify(v)}`);
  });
});
