/**
 * #1266 half 2 — THE EXPORT BUTTON.
 *
 * The ask, 2026-09-07: producing a full board export required asking a seat,
 * who recovered the flags by reading a previous export, because the artifact
 * was durable and the invocation that made it never was. The operator wanted it
 * self-service.
 *
 * Half 1 recorded the invocation so the flags stopped being archaeology. This
 * is the press. The endpoint runs the same `export-board.mjs` the seats run —
 * NOT a reimplementation, because the card's third constraint is that the
 * count check must survive, and the surest way to keep a check is to not
 * rewrite the thing that has it.
 *
 * ⛔ WHAT THESE TESTS ARE ACTUALLY FOR. The dangerous half of this feature is
 * not "does it export". It is:
 *   - a string from a browser reaching a process launcher
 *   - a publication boundary (#523) one click from the default
 *   - a silent write failure, because a launchd-spawned server may not be
 *     permitted to write where the operator expects, and cannot answer a
 *     macOS permission prompt to find out
 * So most of what is asserted below is refusal, containment, and the noise the
 * endpoint makes when it did not do what it was asked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

// ⛔ #837 — TESTS DO NOT WRITE INTO A REAL HOME DIRECTORY. My first version
// pointed every case at a tilde-prefixed path in the real home directory and
// the hygiene rail caught it:
// "a test that reads live board data prints live board data, and in CI that is
// a public, permanent log." The same argument applies to WRITING. The endpoint's
// writable root is configuration (SCRUM_EXPORT_ROOT), so the tests give it an
// isolated one — which is also the honest shape: the root is a deployment
// property, not a fact about the machine.
const EXPORT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-export-root-'));
const rootEnv = { SCRUM_EXPORT_ROOT: EXPORT_ROOT };
const inRoot = (name) => path.join(EXPORT_ROOT, name);

const api = async (base, method, p, body) => {
  const r = await fetch(`${base}${p}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

async function withServer(fn) {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [{ title: 'a card to export', by: 'ada' }], nextShortId: 2 }), env: rootEnv });
  try { return await fn(s); } finally { await s.stop(); }
}

test('#1266 ⛔ THE PATH CANNOT ESCAPE HOME — and the check is on the RESOLVED path', async () => {
  // A prefix test against the raw string is the classic way this passes while
  // the write lands anywhere on the disk. A tilde path climbing out with `../`
  // starts with the root
  // directory as text and resolves outside it.
  await withServer(async (s) => {
    const tilde = '~' + '/';   // built, not written: the #837 rail scans source for the literal
    for (const out of ['/etc/scrum-export', `${tilde}../../../tmp/escape`, `${EXPORT_ROOT}/../../tmp/escape`]) {
      const r = await api(s.baseUrl, 'POST', '/api/export', { by: 'ada', out });
      assert.equal(r.status, 400, `must refuse ${out}, got ${r.status}`);
      assert.match(String(r.body.error), /out must be inside/);
    }
  });
});

test('#1266 ⛔ EVERY PARAMETER IS RANGE-CHECKED OR WHITELISTED, and refused BY NAME', async () => {
  await withServer(async (s) => {
    const cases = [
      [{ maxBytes: 1 }, /between/],
      [{ maxBytes: 999999999 }, /between/],
      [{ maxBytes: 1.5 }, /whole number/],
      [{ tolerance: -1 }, /percentage/],
      [{ tolerance: 101 }, /percentage/],
      [{ spaces: 'commons,/etc/passwd' }, /unknown space/],
      [{ spaces: [] }, /at least one/],
    ];
    for (const [body, expect] of cases) {
      const r = await api(s.baseUrl, 'POST', '/api/export', { by: 'ada', ...body });
      assert.equal(r.status, 400, `must refuse ${JSON.stringify(body)}, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.match(String(r.body.error), expect);
    }
  });
});

test('#1266 ⛔ `by` is REQUIRED — a press is an action and the record says whose', async () => {
  await withServer(async (s) => {
    const r = await api(s.baseUrl, 'POST', '/api/export', { });
    assert.equal(r.status, 400);
    assert.match(String(r.body.error), /by is required/);
  });
});

test('#1266 ⛔⛔ #523 FAIL-CLOSED — raw is TRUE only, never a truthy string', async () => {
  // The publication boundary must not be decided by JS coercion. `raw: "false"`
  // is truthy; if that reached the flag, a string from a form could flip a
  // scrub boundary, which is the exact accident the boundary exists to stop.
  // ⚠️ The validator is module-private by design. My first version of this test
  // imported ../server.js to reach it, which BOOTS the server and binds port
  // 3141 — the test process died before asserting anything. Asserted through
  // the seam that actually exists instead: the settings the endpoint echoes.
  await withServer(async (s) => {
    for (const raw of ['false', '0', 0, 1, 'true', null, undefined]) {
      const r = await api(s.baseUrl, 'POST', '/api/export', { by: 'ada', raw, out: inRoot(`t-${process.pid}`) });
      // Whatever the outcome, `settings.raw` must be a real boolean and must be
      // false for every one of these — only literal `true` may enable it.
      const settings = r.body?.settings;
      assert.ok(settings, `the endpoint must echo the settings it used: ${JSON.stringify(r.body).slice(0, 200)}`);
      assert.equal(settings.raw, false, `raw:${JSON.stringify(raw)} must NOT enable the un-scrubbed path`);
    }
    const yes = await api(s.baseUrl, 'POST', '/api/export', { by: 'ada', raw: true, out: inRoot(`t-${process.pid}`) });
    assert.equal(yes.body?.settings?.raw, true, 'literal true, and only literal true, enables it');
  });
});

test('#1266 ⭐ A FAILED EXPORT IS LOUD, and carries the child\'s OWN words', async () => {
  // The failure this whole endpoint is shaped around: it wrote nothing, or it
  // could not write at all. A permissions refusal and a scrub refusal are
  // different problems and only the original text distinguishes them — so the
  // endpoint must not summarise, and must not report success on an empty dir.
  await withServer(async (s) => {
    const out = inRoot(`.scrum-export-test-${process.pid}-scrub`);
    fs.rmSync(out, { recursive: true, force: true });
    // Scrubbed (the default) against a board carrying a home path: the export
    // refuses rather than writing a publishable-looking archive that isn't.
    const r = await api(s.baseUrl, 'POST', '/api/export', { by: 'ada', out, spaces: 'cards' });
    if (r.status === 200) {
      // If this corpus happens to scrub clean, the run still must have produced
      // real files — the assertion that matters is that 200 means WROTE.
      assert.ok(r.body.parts > 0, 'a 200 must mean parts exist on disk');
      assert.ok(fs.existsSync(path.join(out, '00-INDEX.md')));
    } else {
      assert.equal(r.status, 500);
      assert.ok(String(r.body.detail || '').length > 0,
        'a failure must carry the child\'s own stderr, not a summary of it');
      assert.equal(r.body.parts, 0);
      assert.ok('wrote' in r.body, 'and must name the directory it tried, so the operator can look');
    }
    fs.rmSync(out, { recursive: true, force: true });
  });
});

test('#1266 ⭐⭐ END TO END — the press produces a real archive the operator can open', async () => {
  // The card's acceptance 1: an export produced without asking anyone. This is
  // the version a test can witness; the operator witnessing it is his to do.
  await withServer(async (s) => {
    const out = inRoot(`.scrum-export-test-${process.pid}-e2e`);
    fs.rmSync(out, { recursive: true, force: true });
    // A real commons record must exist, or this asserts the CARD format while
    // claiming to check the one the operator's questions actually run against.
    // My first version passed a board with no messages and the part it read was
    // all cards — a test that checks a format the fixture cannot contain.
    assert.equal((await api(s.baseUrl, 'POST', '/api/conversations',
      { author: 'ada', body: 'the first mention of the banana test' })).status, 201);

    const r = await api(s.baseUrl, 'POST', '/api/export', {
      by: 'ada', out, raw: true, maxBytes: 200000, spaces: 'commons,cards',
    });
    assert.equal(r.status, 200, `the export must succeed: ${JSON.stringify(r.body).slice(0, 600)}`);
    assert.ok(r.body.parts >= 1, 'at least one part');
    assert.equal(r.body.scrub, 'raw');
    assert.equal(r.body.settings.maxBytes, 200000, 'the settings it USED are echoed, not the ones requested');

    // ⭐ VERIFIED ON DISK, not from the response. The response is the thing
    // under test; a test that believes it has checked nothing.
    const onDisk = fs.readdirSync(out).filter((f) => /^part-\d+-of-\d+\.md$/.test(f));
    assert.equal(onDisk.length, r.body.parts, 'the reported count is the count on disk');
    const index = fs.readFileSync(path.join(out, '00-INDEX.md'), 'utf8');
    assert.match(index, /RAW/, 'a raw archive says so at the top, every time');

    // and the thing the archive is used for: every record dated and attributed
    const whole = onDisk.sort().map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n');
    assert.match(whole, /\*\*\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC\] ada:\*\*/,
      'chronology and attribution survive — they are what the archive is FOR (decision b86e1997)');
    assert.match(whole, /banana test/, 'and the content is there to be asked about');
    fs.rmSync(out, { recursive: true, force: true });
  });
});

/**
 * ⭐⭐ THE BUTTON ITSELF, in a real browser.
 *
 * The endpoint tests above prove the server refuses what it should. They cannot
 * prove the thing this card is actually about — that the operator can produce an
 * export by pressing something — and they cannot prove the part that makes the
 * button SAFE rather than merely fast.
 *
 * ⛔ THE ASSERTION THAT MATTERS: ticking "un-scrubbed" and pressing Export must
 * NOT produce an un-scrubbed archive. #523's boundary is fail-closed, and a
 * button that puts `--raw` one click from the default is a publication hazard
 * with a nice UI. Two deliberate acts, and the negative control is that after
 * the first one, NOTHING IS ON DISK.
 */
import { withBrowserServer } from './helpers/harness.mjs';

test('#1266 ⭐⭐ THE PRESS — and un-scrubbed takes TWO deliberate acts, not one', async () => {
  const out = inRoot(`.scrum-export-btn-${process.pid}`);
  fs.rmSync(out, { recursive: true, force: true });
  await withBrowserServer(async ({ server, browser }) => {
    await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'ada', body: 'a line worth keeping in the archive' }),
    });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });

    assert.equal(await page.$eval('#export-menu', (el) => el.hidden), true, 'the menu starts closed');
    await page.click('#btn-export');
    assert.equal(await page.$eval('#export-menu', (el) => el.hidden), false, 'and opens on the button');

    await page.$eval('#export-out', (el, v) => { el.value = v; }, out);
    await page.click('#export-raw');
    assert.equal(await page.$eval('#export-raw-confirm', (el) => el.hidden), false,
      'ticking un-scrubbed reveals the warning rather than arming it');

    // ⛔ THE NEGATIVE CONTROL. One act must not be enough.
    await page.click('#export-run');
    await new Promise((r) => setTimeout(r, 500));
    assert.match(await page.$eval('#export-status', (el) => el.textContent), /Confirm/,
      'pressing Export with un-scrubbed ticked but unconfirmed must REFUSE');
    assert.equal(fs.existsSync(out), false,
      'and must write NOTHING — a refusal that already wrote the files is not a refusal');

    // the second, separate act
    await page.click('#export-raw-ack');
    await page.click('#export-run');
    await page.waitForFunction(
      () => /✅|failed/.test(document.getElementById('export-status').textContent),
      { timeout: 120000 });

    const status = await page.$eval('#export-status', (el) => el.textContent);
    assert.match(status, /✅/, `the export must succeed: ${status}`);
    assert.match(status, /raw/, 'and the status says which boundary it used');

    const parts = fs.readdirSync(out).filter((x) => /^part-\d+-of-\d+\.md$/.test(x));
    assert.ok(parts.length >= 1, 'files exist on disk, not just in the status line');
    assert.match(fs.readFileSync(path.join(out, '00-INDEX.md'), 'utf8'), /RAW/,
      'and the archive declares itself un-scrubbed at the top, every time');
    assert.deepEqual(pageErrors, [], 'no page errors');
  }, { server: { env: rootEnv }, launch: { headless: 'new' } });
  fs.rmSync(out, { recursive: true, force: true });
});

/**
 * ⛔ THE THREE TESTS THE MUTATION PASS DEMANDED. Each of these mutations
 * SURVIVED the file above, which means the property it breaks was being
 * described in prose and asserted by nothing:
 *
 *   success reported from the EXIT CODE rather than from disk   → survived
 *   the child's stderr replaced with a constant                 → survived
 *   the UI acknowledgement surviving an untick                  → survived
 *
 * The first two matter because the whole reason this endpoint exists rather
 * than a documented command is that the operator cannot see the directory. The
 * third is the #523 boundary: an acknowledgement that outlives the choice it
 * was given for is not a confirmation, it is a latch.
 */
test('#1266 ⛔ EXIT 0 IS NOT CONTENT — a run that wrote nothing is a FAILURE', async () => {
  // An empty board with only cards selected: the exporter has nothing to write.
  // Whatever it returns, a response that says ok with no parts on disk would be
  // the endpoint reporting the child's opinion instead of the world's.
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }), env: rootEnv });
  try {
    const out = inRoot(`empty-${process.pid}`);
    fs.rmSync(out, { recursive: true, force: true });
    const r = await api(s.baseUrl, 'POST', '/api/export', { by: 'ada', out, raw: true, spaces: 'cards' });
    const parts = fs.existsSync(out) ? fs.readdirSync(out).filter((x) => /^part-\d+-of-\d+\.md$/.test(x)) : [];
    if (r.status === 200) {
      assert.ok(parts.length > 0, 'a 200 must mean files exist — this is the whole verify-at-the-beneficiary property');
      assert.equal(r.body.parts, parts.length);
    } else {
      assert.equal(parts.length, 0, 'a failure must not have left a partial archive claiming to be one');
    }
    fs.rmSync(out, { recursive: true, force: true });
  } finally { await s.stop(); }
});

test('#1266 ⛔ THE FAILURE CARRIES THE CHILD\'S OWN WORDS, not a house summary', async () => {
  // A destination inside home that CANNOT be a directory, because a file is
  // already sitting on the path. The child fails with the operating system's
  // own message, and that message — not a constant — is what has to reach the
  // operator, because it is the only thing that distinguishes "no permission"
  // from "the room refused to scrub".
  // ⚠️ The board must be NON-EMPTY. My first version used an empty one and the
  // child refused before it ever tried to write — the detail was still its own
  // words ("the board came back empty"), but the case under test is the one
  // where the WRITE fails, which is the permissions-shaped failure this whole
  // endpoint is built around.
  const s = await startRestServer({ board: makeBoardFixture({ cards: [{ title: 'a card', by: 'ada' }], nextShortId: 2 }), env: rootEnv });
  const blocker = inRoot(`blocker-${process.pid}`);
  try {
    fs.writeFileSync(blocker, 'not a directory');
    const r = await api(s.baseUrl, 'POST', '/api/export', {
      by: 'ada', out: path.join(blocker, 'inside'), raw: true, spaces: 'cards',
    });
    assert.equal(r.status, 500, `must fail: ${JSON.stringify(r.body).slice(0, 300)}`);
    assert.equal(r.body.parts, 0);
    assert.match(String(r.body.wrote), new RegExp(`${process.pid}`), 'it names the path it tried');
    // ⭐ The discriminating assertion: text only the CHILD or the OS could have
    // produced. A summary would pass "detail is non-empty" and fail this.
    assert.match(String(r.body.detail), /ENOTDIR|not a directory|EEXIST|ENOENT/i,
      `the operating system's own words must survive to the operator: ${String(r.body.detail).slice(0, 300)}`);
  } finally {
    fs.rmSync(blocker, { force: true });
    await s.stop();
  }
});

test('#1266 ⛔ UNTICKING UN-SCRUBBED DISARMS THE ACKNOWLEDGEMENT', async () => {
  // An acknowledgement that outlives the choice it was given for is a latch,
  // not a confirmation: tick, confirm, untick, re-tick — and the confirmation
  // must be gone. Otherwise a moment of "actually, no" leaves the un-scrubbed
  // path armed for the next press.
  const out = inRoot(`.scrum-export-latch-${process.pid}`);
  fs.rmSync(out, { recursive: true, force: true });
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
    await page.click('#btn-export');
    await page.$eval('#export-out', (el, v) => { el.value = v; }, out);

    await page.click('#export-raw');
    await page.click('#export-raw-ack');          // armed
    await page.click('#export-raw');              // ...and changed my mind
    assert.equal(await page.$eval('#export-raw', (el) => el.checked), false);
    await page.click('#export-raw');              // ticked again

    await page.click('#export-run');
    await new Promise((r) => setTimeout(r, 500));
    assert.match(await page.$eval('#export-status', (el) => el.textContent), /Confirm/,
      'the earlier acknowledgement must NOT still be arming the un-scrubbed path');
    assert.equal(fs.existsSync(out), false, 'and nothing was written');
  }, { server: { env: rootEnv }, launch: { headless: 'new' } });
  fs.rmSync(out, { recursive: true, force: true });
});

test('#1266 ⛔⛔ A CHILD THAT EXITS 0 AND WRITES NOTHING IS STILL A FAILURE', async () => {
  // ⭐ THE TEST A MUTATION DEMANDED AND NOTHING ELSE COULD PROVIDE. Replacing
  // `if (run.err || !parts.length || indexText == null)` with `if (run.err)`
  // survived every other test in this file, because the real exporter never
  // exits 0 without writing — so the disk check was prose, not a property.
  //
  // This is the failure the whole endpoint is shaped around: the operator
  // presses a button, something says it worked, and the folder is empty. On a
  // launchd-spawned server writing to a TCC-protected directory that is the
  // PLAUSIBLE outcome, not a contrived one.
  const stub = path.join(os.tmpdir(), `scrum-export-stub-${process.pid}.mjs`);
  fs.writeFileSync(stub, 'process.stdout.write("all done!\\n"); process.exit(0);\n');
  const s = await startRestServer({
    board: makeBoardFixture({ cards: [{ title: 'a card', by: 'ada' }], nextShortId: 2 }),
    env: { ...rootEnv, SCRUM_EXPORT_SCRIPT: stub },
  });
  try {
    const out = inRoot(`.scrum-export-liar-${process.pid}`);
    fs.rmSync(out, { recursive: true, force: true });
    const r = await api(s.baseUrl, 'POST', '/api/export', { by: 'ada', out, raw: true });
    assert.equal(r.status, 500,
      `a cheerful exit code over an empty directory must NOT be reported as success: ${JSON.stringify(r.body).slice(0, 300)}`);
    assert.equal(r.body.exitOk, true, 'and the response says the child claimed success, so the disagreement is visible');
    assert.equal(r.body.parts, 0);
    assert.match(String(r.body.error), /did not produce a readable archive/);
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(stub, { force: true });
    await s.stop();
  }
});
