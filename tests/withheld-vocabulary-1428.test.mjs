/**
 * #1428 REVIEW — FIXED VOCABULARIES AT THE REST BOUNDARY.
 *
 * The runner's `withheldReason` and `withheldStateOutcome` are STABLE TOKENS,
 * not arbitrary strings. The production code paths in `core/guest-loop.mjs`
 * emit a closed set of values; a free-text string here would be either a
 * vocabulary drift or a caller smuggling a body field under another name.
 * The pre-fix boundary accepted any string <=120 chars, which is the exact
 * shape a privacy leak would take.
 *
 * This file exercises BOTH sides of the boundary:
 *
 *   - POSITIVE: every production token the runner writes is accepted and
 *     round-trips through POST → GET.
 *
 *   - NEGATIVE: arbitrary / free-text strings are REFUSED at the boundary
 *     with a 400, never silently nulled. The refusal cites the allowed set
 *     so a runner operator can diagnose a vocabulary drift.
 *
 * The vocabulary itself is the union of two arrays defined right next to
 * `modelCallEntityFrom` in `server.js`. Each value is annotated with the
 * production code path that emits it, so the test fixture and the source
 * agree on which values exist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const api = async (baseUrl, method, p, body) => {
  const r = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null; try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
};

// ⛔ ANONYMOUS FIXTURES — no seat names, no real-person references. A
// synthetic agent, a synthetic model, a synthetic wake. The boundary does
// not care WHO made the call; it cares what the field VALUES are.
const ANON_AGENT = 'seat-vocab';
const ANON_MODEL = 'm-vocab';

async function boot() {
  return await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
}

const baseRow = (extras = {}) => ({
  by: ANON_AGENT, agent: ANON_AGENT, model: ANON_MODEL, ok: true,
  stopReason: 'stop', latencyMs: 0, cost: 0,
  wake: { kind: 'mention', messageId: 'wv' },
  ...extras,
});

// ===========================================================================
// POSITIVE — every production token round-trips.
// ===========================================================================

test('#1428 withheldReason="standalone-no-reply" (the only production token) is accepted and round-trips', async () => {
  const srv = await boot();
  try {
    const posted = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({
      withheldReason: 'standalone-no-reply',
    }));
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const back = (await api(srv.baseUrl, 'GET', `/api/model-calls?agent=${ANON_AGENT}&limit=1`)).body.calls[0];
    assert.ok(back, 'a row is readable');
    assert.equal(back.withheldReason, 'standalone-no-reply');
  } finally { await srv.stop(); }
});

test('#1428 withheldStateOutcome="retained" (core/guest-loop.mjs:1152) is accepted and round-trips', async () => {
  const srv = await boot();
  try {
    const posted = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({
      withheldReason: 'standalone-no-reply',
      withheldStateOutcome: 'retained',
    }));
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const back = (await api(srv.baseUrl, 'GET', `/api/model-calls?agent=${ANON_AGENT}&limit=1`)).body.calls[0];
    assert.equal(back.withheldStateOutcome, 'retained');
    assert.equal(back.withheldReason, 'standalone-no-reply');
  } finally { await srv.stop(); }
});

test('#1428 withheldStateOutcome="cleared" (core/guest-loop.mjs:1161/1168) is accepted and round-trips', async () => {
  const srv = await boot();
  try {
    const posted = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({
      withheldStateOutcome: 'cleared',
    }));
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const back = (await api(srv.baseUrl, 'GET', `/api/model-calls?agent=${ANON_AGENT}&limit=1`)).body.calls[0];
    assert.equal(back.withheldStateOutcome, 'cleared');
  } finally { await srv.stop(); }
});

test('#1428 withheldStateOutcome="retain-failed" (core/guest-loop.mjs:1182) is accepted and round-trips', async () => {
  const srv = await boot();
  try {
    const posted = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({
      withheldReason: 'standalone-no-reply',
      withheldStateOutcome: 'retain-failed',
    }));
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const back = (await api(srv.baseUrl, 'GET', `/api/model-calls?agent=${ANON_AGENT}&limit=1`)).body.calls[0];
    assert.equal(back.withheldStateOutcome, 'retain-failed');
    assert.equal(back.withheldReason, 'standalone-no-reply');
  } finally { await srv.stop(); }
});

test('#1428 withheldStateOutcome="clear-failed" (core/guest-loop.mjs:1182) is accepted and round-trips', async () => {
  const srv = await boot();
  try {
    const posted = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({
      withheldStateOutcome: 'clear-failed',
    }));
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const back = (await api(srv.baseUrl, 'GET', `/api/model-calls?agent=${ANON_AGENT}&limit=1`)).body.calls[0];
    assert.equal(back.withheldStateOutcome, 'clear-failed');
  } finally { await srv.stop(); }
});

test('#1428 withheldStateOutcome="preserve-failed" (core/guest-loop.mjs:1182) is accepted and round-trips', async () => {
  const srv = await boot();
  try {
    const posted = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({
      withheldStateOutcome: 'preserve-failed',
    }));
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const back = (await api(srv.baseUrl, 'GET', `/api/model-calls?agent=${ANON_AGENT}&limit=1`)).body.calls[0];
    assert.equal(back.withheldStateOutcome, 'preserve-failed');
  } finally { await srv.stop(); }
});

test('#1428 unrelated rows (no decline, no hand-back) post with NO withheldReason and NO withheldStateOutcome — the fields are absent on the wire', async () => {
  const srv = await boot();
  try {
    const posted = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({
      stopReason: 'stop', postedText: 'A normal post, no sentinel, no recovery.',
    }));
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const back = (await api(srv.baseUrl, 'GET', `/api/model-calls?agent=${ANON_AGENT}&limit=1`)).body.calls[0];
    assert.equal(back.withheldReason, null,
      'withheldReason is null on an unrelated row — the runner omits it');
    assert.equal(back.withheldStateOutcome, null,
      'withheldStateOutcome is null on an unrelated row — the runner omits it');
  } finally { await srv.stop(); }
});

// ===========================================================================
// NEGATIVE — arbitrary / free-text strings are REFUSED, never silently nulled.
// ===========================================================================

test('#1428 an unknown withheldReason is REFUSED (400) — free text is not a vocabulary value', async () => {
  const srv = await boot();
  try {
    const posted = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({
      withheldReason: 'a note from the operator about what was really going on here',
    }));
    assert.equal(posted.status, 400,
      `unknown withheldReason is refused at 400 — got ${posted.status}: ${JSON.stringify(posted.body)}`);
    assert.match(String(posted.body?.error ?? ''), /withheldReason/,
      'the error message names the offending field');
    assert.match(String(posted.body?.error ?? ''), /standalone-no-reply/,
      'the error message lists the allowed vocabulary');
  } finally { await srv.stop(); }
});

test('#1428 a short free-text withheldReason (under 120 chars) is REFUSED — the bound is the vocabulary, not the length', async () => {
  // The pre-fix shape accepted any string <=120 chars. A 30-char note is
  // shorter than the cap, but it is not a vocabulary value. The vocabulary
  // check is the boundary.
  const srv = await boot();
  try {
    const posted = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({
      withheldReason: 'a short free-text note',
    }));
    assert.equal(posted.status, 400,
      `a free-text withheldReason is refused at 400 — got ${posted.status}: ${JSON.stringify(posted.body)}`);
  } finally { await srv.stop(); }
});

test('#1428 an unknown withheldStateOutcome is REFUSED (400) — free text is not a vocabulary value', async () => {
  const srv = await boot();
  try {
    const posted = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({
      withheldStateOutcome: 'we tried really hard but the seat was on fire',
    }));
    assert.equal(posted.status, 400,
      `unknown withheldStateOutcome is refused at 400 — got ${posted.status}: ${JSON.stringify(posted.body)}`);
    assert.match(String(posted.body?.error ?? ''), /withheldStateOutcome/,
      'the error message names the offending field');
    assert.match(String(posted.body?.error ?? ''), /retained/,
      'the error message lists the allowed vocabulary');
  } finally { await srv.stop(); }
});

test('#1428 a near-miss withheldStateOutcome (similar to a real token) is REFUSED — only exact matches pass', async () => {
  const srv = await boot();
  try {
    const nearMisses = [
      'retained ',     // trailing whitespace
      ' retained',     // leading whitespace
      'retained\n',    // trailing newline
      'Retained',      // wrong case
      'RETAINED',      // wrong case
      'ret-ained',     // typo
      'retainfailed',  // missing hyphen
      'clear-fail',    // close but not the token
    ];
    for (const v of nearMisses) {
      const posted = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({
        withheldStateOutcome: v,
      }));
      assert.equal(posted.status, 400,
        `near-miss "${v}" is REFUSED, not silently accepted — got ${posted.status}: ${JSON.stringify(posted.body)}`);
    }
  } finally { await srv.stop(); }
});

test('#1428 a non-string withheldStateOutcome (number, object) is REFUSED — the field is a string vocabulary', async () => {
  const srv = await boot();
  try {
    const numeric = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({
      withheldStateOutcome: 0,
    }));
    assert.equal(numeric.status, 400, `numeric withheldStateOutcome is refused — got ${numeric.status}`);
    const obj = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({
      withheldStateOutcome: { value: 'retained' },
    }));
    assert.equal(obj.status, 400, `object withheldStateOutcome is refused — got ${obj.status}`);
    const arr = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({
      withheldStateOutcome: ['retained'],
    }));
    assert.equal(arr.status, 400, `array withheldStateOutcome is refused — got ${arr.status}`);
    const bool = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({
      withheldStateOutcome: true,
    }));
    assert.equal(bool.status, 400, `boolean withheldStateOutcome is refused — got ${bool.status}`);
  } finally { await srv.stop(); }
});

test('#1428 a non-string withheldReason (number, object) is REFUSED — the field is a string vocabulary', async () => {
  const srv = await boot();
  try {
    const numeric = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({
      withheldReason: 42,
    }));
    assert.equal(numeric.status, 400, `numeric withheldReason is refused — got ${numeric.status}`);
    const obj = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({
      withheldReason: { reason: 'standalone-no-reply' },
    }));
    assert.equal(obj.status, 400, `object withheldReason is refused — got ${obj.status}`);
  } finally { await srv.stop(); }
});

test('#1428 null and absent withheldReason are ACCEPTED — the field is optional', async () => {
  const srv = await boot();
  try {
    const absent = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({}));
    assert.equal(absent.status, 201, JSON.stringify(absent.body));
    const nullVal = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({
      withheldReason: null,
    }));
    assert.equal(nullVal.status, 201, JSON.stringify(nullVal.body));
    const back = (await api(srv.baseUrl, 'GET', `/api/model-calls?agent=${ANON_AGENT}&limit=10`)).body.calls;
    for (const c of back) assert.equal(c.withheldReason, null,
      `withheldReason is null on unrelated rows — got ${JSON.stringify(c)}`);
  } finally { await srv.stop(); }
});

test('#1428 null and absent withheldStateOutcome are ACCEPTED — the field is optional', async () => {
  const srv = await boot();
  try {
    const absent = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({}));
    assert.equal(absent.status, 201, JSON.stringify(absent.body));
    const nullVal = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({
      withheldStateOutcome: null,
    }));
    assert.equal(nullVal.status, 201, JSON.stringify(nullVal.body));
    const back = (await api(srv.baseUrl, 'GET', `/api/model-calls?agent=${ANON_AGENT}&limit=10`)).body.calls;
    for (const c of back) assert.equal(c.withheldStateOutcome, null,
      `withheldStateOutcome is null on unrelated rows — got ${JSON.stringify(c)}`);
  } finally { await srv.stop(); }
});

// ===========================================================================
// PIN: the vocabulary check happens BEFORE the entity is built — a refused
// row leaves NO model-calls[] entry, so the secret phrase cannot be smuggled
// under either field. (Mirrors the existing withheld-privacy-1428 case for
// withheldText.)
// ===========================================================================

test('#1428 a refused vocabulary row leaves NO model-calls[] entry — the rejection is loud, not silent', async () => {
  const srv = await boot();
  try {
    const refused = await api(srv.baseUrl, 'POST', '/api/model-calls', baseRow({
      withheldStateOutcome: 'this is a free-text smuggled body field, not a vocabulary value',
    }));
    assert.equal(refused.status, 400);
    const calls = (await api(srv.baseUrl, 'GET', `/api/model-calls?agent=${ANON_AGENT}&limit=10`)).body.calls || [];
    assert.equal(calls.length, 0,
      'no row is created on a vocabulary refusal — the field check is the boundary');
  } finally { await srv.stop(); }
});
