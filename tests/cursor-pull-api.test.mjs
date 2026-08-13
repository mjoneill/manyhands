/**
 * #799 — the /api/cursors/pull 400 contract, and why it is tested at the WIRE.
 *
 * The endpoint had no wire tests at all. That is how a real seat name shipped
 * inside an HTTP response body and survived a publication review: every other
 * seat-name occurrence in the published tree is a comment or a test-internal
 * fixture, and this one was neither — a stranger calling the API read it
 * without ever opening the source.
 *
 * ⚠️ THE ASSERTION THAT MATTERS IS THE SECOND ONE. Removing a name from an
 * error message is trivial; removing it and leaving the message useless is a
 * regression that no "does it contain a seat name" test can see. An example
 * exists to TEACH the format, so the control asserts the message still shows
 * the shape a caller has to produce. A placeholder that stops teaching is a
 * worse error message than the one it replaced.
 *
 * ⭐⭐ AND WHY THIS TESTS A SHAPE RATHER THAN A LIST OF NAMES.
 * The first version of this file held `SEATS = ['…', '…', '…', '…']` and
 * asserted none appeared. Two things were wrong with that, and they are the
 * same thing twice:
 *
 *   1  it introduced four real seat names into published source in order to
 *      assert that no seat name is published
 *   2  it was a CHECK against a known population, so a seat added tomorrow
 *      would silently fall outside it — a hardcoded denominator, which is the
 *      defect class this repo spent two days on
 *
 * Asserting the placeholder SHAPE instead makes a concrete identity
 * unrepresentable in that position: every `registry:` the caller is shown must
 * be followed by `<`. That covers names nobody has thought of yet, and it
 * names no one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

test('#799 the identity-required 400 illustrates the format without a concrete identity', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  try {
    const res = await fetch(`${srv.baseUrl}/api/cursors/pull`);
    assert.equal(res.status, 400, 'a pull with no identity is refused, not answered');

    const body = await res.json();
    const raw = JSON.stringify(body);

    // ── the regression: no CONCRETE identity is illustrated ──────────────
    // Every `registry:` shown to a caller must introduce a placeholder. A real
    // value — `registry:someone.somewhere` — fails here without this test ever
    // needing to know who "someone" is.
    for (const m of raw.matchAll(/registry:(.)/g)) {
      assert.equal(m[1], '<', `an example identity is not a placeholder: ${raw}`);
    }

    // ── ⭐ THE POSITIVE CONTROL: it must still be a usable example ────────
    // Without these, `{ error: 'identity is required' }` passes everything
    // above while telling the caller nothing about what to send.
    assert.match(body.error, /registry:/, 'the example still shows the identity prefix');
    assert.match(body.error, /<seat>/, 'and the seat placeholder');
    assert.match(body.error, /<client>/, 'and the client placeholder, so the shape is complete');
  } finally {
    await srv.stop();
  }
});
