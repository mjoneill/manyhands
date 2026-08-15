/**
 * #805 — the boot migration, against a real spawned server on a throwaway board.
 *
 * The safety argument being tested is an ORDERING one: the migration runs before
 * `listen()`, so no request can interleave with it. That is not something a unit
 * test can assert — it needs a real server, started against a real file, and a
 * first request that already sees migrated data.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { DEFAULT_POOL } from '../whisper-store.mjs';

const POOL = ['prompt alpha', 'prompt beta'];
// The tracked example manifest covers exactly DEFAULT_POOL, with synthetic seats.
const EXAMPLE_MANIFEST = new URL('../tending-provenance.example.json', import.meta.url).pathname;
// ⚠️ FIXTURE SEATS ARE FICTIONAL ('ada'), never real room identities. A test
// fixture naming a real seat asserts, in a file the publication gate reads, that
// that person did the thing — and the gate then needs a baseline key to permit
// the name, which widens the exemption for every future match. (#808.)
const HISTORY = [{
  window: '2026-08-14T22:00:00.000Z', seat: 'ada',
  at: '2026-08-14T22:45:36.788Z', reached: [],
}];

/** A scratch dir carrying the three live flat sources the migration reads. */
function flatSources({ pool = POOL, config = { enabled: true }, history = HISTORY } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tending-boot-'));
  writeFileSync(join(dir, 'whisper-pool.json'), JSON.stringify(pool));
  writeFileSync(join(dir, 'tending-config.json'), JSON.stringify(config));
  writeFileSync(join(dir, 'whisper-state.json'), JSON.stringify({ history }));
  return dir;
}

// SCRUM_EVENT_LOG_DIR is NOT in the harness's override list (it pins only
// PORT/BOARD_FILE/ATTACHMENTS/CHANNEL_CONFIG/STATIC/NOTIFY), so it survives.
const bootEnv = (dir) => ({
  SCRUM_WHISPER_POOL_FILE: join(dir, 'whisper-pool.json'),
  SCRUM_TENDING_CONFIG_FILE: join(dir, 'tending-config.json'),
  SCRUM_WHISPER_STATE_FILE: join(dir, 'whisper-state.json'),
  SCRUM_EVENT_LOG_DIR: join(dir, 'events'),
});

/**
 * Assert a server REFUSES to start — and release the child if it starts anyway.
 *
 * ⛔ THIS HELPER EXISTS BECAUSE ITS ABSENCE COST SEVEN HOURS. Written inline as
 * `assert.rejects(() => startRestServer(...))`, the unexpected-success branch
 * leaks the child: `node --test` then waits on the open handle forever and the
 * whole file reports NOTHING. A control that leaks on the branch it is trying to
 * prove impossible converts its own failure into a hang — strictly worse than a
 * red test, because a red test reports.
 *
 * Returns null when the server correctly refused. Returns the (already stopped)
 * handle when it started anyway, so the caller can assert on it — the release
 * happens here regardless of what the caller does with the result.
 */
async function mustRefuseToStart(opts) {
  let srv = null;
  try {
    srv = await startRestServer(opts);
  } catch (e) {
    if (!/failed to start/.test(String(e && e.message))) throw e;
    return null;                                    // refused, as required
  }
  // Unexpected success: RELEASE THE CHILD BEFORE ANYTHING ELSE CAN THROW.
  await srv.stop();
  return srv;
}

const tendingOf = (boardFile) => {
  const doc = JSON.parse(readFileSync(boardFile, 'utf8'));
  return (doc['@graph'] || []).filter((e) => String(e['@type'] || '').startsWith('scrum:Tending'));
};
const tendingEvents = (dir) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    .filter((ev) => ev.entity?.kind === 'tending');
};

test('⭐ FIRST BOOT writes the tending entities and explicit tending events', async () => {
  const flat = flatSources();
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: bootEnv(flat) });
  try {
    const ents = tendingOf(srv.boardFile);
    // 2 prompts × (prompt + version) + playlist + playlistVersion + state
    // + legacy mint + legacy claim attempt
    assert.ok(ents.length >= 9, `expected the bootstrap's entities, got ${ents.length}`);
    assert.ok(ents.some((e) => e['@type'] === 'scrum:TendingPlaylistVersion'));
    assert.ok(ents.some((e) => e['@type'] === 'scrum:TendingState'));

    const evs = tendingEvents(join(flat, 'events'));
    assert.ok(evs.length >= 9, 'every entity is declared by its own event');
    assert.ok(evs.every((e) => e.entity.kind === 'tending'),
      'events name the tending entity — not smuggled through card/column diffing');
    assert.ok(evs.every((e) => typeof e.state === 'object' && e.state['@id']),
      'each event carries the full entity state');
  } finally { await srv.stop(); }
});

test('⭐⭐ BOOT ORDERING — the FIRST request already sees the migrated graph', async () => {
  // DEFECT: a migration scheduled after listen(), or on a timer, leaves a window
  // where the server is up and the tending system is absent. A client that asks
  // in that window gets a confident empty answer.
  const flat = flatSources();
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: bootEnv(flat) });
  try {
    // ⚠️ NO FALLBACK BRANCH. A first draft fell back to reading the board file
    // when the route 404'd — and the route DID 404, because it is POST /api/graph
    // with a JSON body and the draft sent GET with a query param. The control
    // passed every run while never once querying the graph: it silently became a
    // duplicate of the first test. A control with a degraded path is a control
    // that cannot fail for its stated reason.
    const res = await fetch(`${srv.baseUrl}/api/graph`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'SELECT ?s WHERE { ?s a scrum:TendingPromptVersion }',
      }),
    });
    assert.equal(res.status, 200, 'the graph route must answer the very first request');
    const body = await res.json();
    assert.ok(body.rows.length >= 2,
      'the FIRST graph query this server can answer already returns tending data — '
      + 'there is no "up but not yet migrated" window');
  } finally { await srv.stop(); }
});

test('⭐ SECOND BOOT is a no-op — no data growth, no duplicate events', async () => {
  // DEFECT: a bootstrap keyed on anything non-deterministic appends a second
  // copy of everything on every restart, and a restarting service does that
  // silently, forever.
  const flat = flatSources();
  const first = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: bootEnv(flat) });
  const boardFile = first.boardFile;
  const migrated = JSON.parse(readFileSync(boardFile, 'utf8'));
  const afterFirst = tendingOf(boardFile).length;
  const eventsAfterFirst = tendingEvents(join(flat, 'events')).length;
  assert.ok(afterFirst >= 9 && eventsAfterFirst >= 9, 'first boot must actually have migrated');
  await first.stop();

  // A genuine second boot: the same ALREADY-MIGRATED document, same flat
  // sources. The harness pins SCRUM_BOARD_FILE itself, so the way to re-boot on
  // migrated data is to hand it back as the fixture.
  const second = await startRestServer({ board: migrated, env: bootEnv(flat) });
  try {
    assert.equal(tendingOf(second.boardFile).length, afterFirst, 'entity count must not grow');
    assert.equal(tendingEvents(join(flat, 'events')).length, eventsAfterFirst,
      'a second boot must append no further tending events');
  } finally { await second.stop(); }
});

test('unknown provenance stays absent through the real migration', () => {
  // The flat pool carries no authors, so no author may appear. Asserted on the
  // artifact the server actually wrote, not on the builder's return value.
  const flat = flatSources();
  return startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: bootEnv(flat) })
    .then(async (srv) => {
      try {
        for (const v of tendingOf(srv.boardFile).filter((e) => e['@type'] === 'scrum:TendingPromptVersion')) {
          assert.equal('author' in v, false, 'the flat pool has no authors — none may be invented');
        }
      } finally { await srv.stop(); }
    });
});

test('legacy history stays LEGACY — a clock window, never a silence', async () => {
  const flat = flatSources();
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: bootEnv(flat) });
  try {
    const mints = tendingOf(srv.boardFile).filter((e) => e['@type'] === 'scrum:TendingMint');
    assert.equal(mints.length, 1);
    assert.equal(mints[0]['scrum:legacyClockWindow'], '2026-08-14T22:00:00.000Z');
    assert.equal('scrum:ofSilence' in mints[0], false);
    assert.equal(tendingOf(srv.boardFile).filter((e) => e['@type'] === 'scrum:TendingSilence').length, 0);
  } finally { await srv.stop(); }
});

test('⛔ a DEGENERATE pool falls back to defaults — it never writes an empty system', async () => {
  // ⚠️ THIS CONTROL REPLACES A VACUOUS ONE, AND FINDING THAT OUT FOUND A BUG.
  //
  // The original asserted `playlists.length <= 1` — satisfied by 0 AND by 1, so
  // it passed either way. Mutation proved it: deleting `if (!pool.length)
  // return;` from migrateTendingIfNeeded left all 7 tests green.
  //
  // Writing the exact assertion (`=== []`) then FAILED, and the failure was the
  // interesting part: an explicitly empty pool file produced the three REAL
  // default prompts. readPool() is total — [], corrupt, missing, non-array, and
  // ["",""] all measured length 3 — so the guard could never run. The vacuous
  // control was concealing dead code, and the dead code was concealing the fact
  // that "an empty tending system" is not a reachable state.
  //
  // So this asserts what is TRUE and reachable: a degenerate pool file yields
  // the default system, fully formed. That is a defensible behaviour for a
  // sender that must not go silent — but it is a fallback, and it must be
  // VISIBLE as one rather than discovered by a reader three layers down.
  // ⚠️ AND THE ANSWER CHANGED AGAIN once blockers 3+4 landed, which is the
  // interesting part: because the fallback yields the KNOWN DEFAULTS, and known
  // prompts now REQUIRE a provenance manifest, a degenerate pool with no
  // manifest is refused outright. #809's silent substitution becomes a loud
  // failure at migration time — the operator finds out.
  for (const pool of [[], 'not-an-array', ['', '']]) {
    const flat = flatSources({ pool });
    await assert.rejects(
      () => startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: bootEnv(flat) }),
      /failed to start/,
      `pool ${JSON.stringify(pool)} fell back to the known defaults and migrated them `
      + 'WITHOUT provenance — that mint is immutable and permanent',
    );
  }
});

// ── ACTIVATION: absence buys a NO-OP, never a mint ────────────────────────
// Ruled after the first cut refused to boot on the product's DEFAULT config.
// The three controls below are the ruling's three cases, in its own order.

/** An installation with NO legacy artifacts at all — a stranger's fresh clone. */
const freshInstall = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tending-fresh-'));
  return {                                    // every path points at nothing
    SCRUM_WHISPER_POOL_FILE: join(dir, 'whisper-pool.json'),
    SCRUM_TENDING_CONFIG_FILE: join(dir, 'tending-config.json'),
    SCRUM_WHISPER_STATE_FILE: join(dir, 'whisper-state.json'),
    SCRUM_TENDING_PROVENANCE_FILE: join(dir, 'tending-provenance.json'),
    SCRUM_EVENT_LOG_DIR: join(dir, 'events'),
    _dir: dir,
  };
};

test('⭐⭐ a FRESH CLONE boots, and writes ZERO tending entities and ZERO events', async () => {
  // DEFECT: the first cut made this exact case fail to start. readPool is total,
  // so a stranger with no config has the three known defaults by fallback, no
  // manifest, and got a dead server citing provenance they never had — 55 red
  // in api.test.mjs, which was the product's default configuration.
  //
  // ⚠️ And it must write NOTHING rather than explicit-unknown: an install that
  // HAS a past but LOST its state file comes through this same door, and a mint
  // there is immutable and permanent. A deferral is recoverable.
  const env = freshInstall();
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env });
  try {
    assert.deepEqual(tendingOf(srv.boardFile), [], 'no tending entity may be written');
    assert.deepEqual(tendingEvents(join(env._dir, 'events')), [], 'and no tending event');
    // The server is genuinely SERVING — a no-op migration is not a dead boot.
    const res = await fetch(`${srv.baseUrl}/api/board`);
    assert.equal(res.status, 200, 'a fresh install must actually serve');
  } finally { await srv.stop(); }
});

test('⛔⛔ PROD-SHAPED history with NO manifest refuses BEFORE any write', async () => {
  // DEFECT: the prod-bricking case. Legacy history present means this machine
  // has a tending past, so migrating the known defaults authorless would mint
  // immutable nodes the correct author could never replace. It must refuse, and
  // it must refuse with the board untouched — a partial mint is the failure.
  // ⚠️ THE POOL MUST HOLD THE KNOWN DEFAULTS. A first draft used the file's
  // custom POOL fixture ('prompt alpha'), which has no recorded provenance — so
  // the migration correctly proceeded and the control failed with "missing
  // expected rejection". Worse, the server it did not expect to start was never
  // stopped, so `node --test` waited on the open handle and the whole file hung
  // for seven hours with zero output. Both symptoms, one wrong fixture.
  const flat = flatSources({ pool: [...DEFAULT_POOL] });       // known + history
  const started = await mustRefuseToStart({
    board: makeBoardFixture({ cards: [], conversations: [] }),
    env: { ...bootEnv(flat), SCRUM_TENDING_PROVENANCE_FILE: join(flat, 'absent.json') },
  });
  assert.equal(started, null, 'the server must not have started at all');
  assert.deepEqual(tendingEvents(join(flat, 'events')), [],
    'refusal must precede every write — no event may survive a failed migration');
});

test('⭐⭐ the UNEXPECTED-SUCCESS branch releases its child — the anti-hang control', async () => {
  // DEFECT, and it is not hypothetical: this exact branch, written inline without
  // capturing the handle, hung the whole file for SEVEN HOURS at zero bytes while
  // the room waited. The refusal assertion was correct; it simply had no way to
  // report, because the leaked child kept `node --test` alive forever.
  //
  // So the branch is exercised DELIBERATELY here, against a config that starts
  // cleanly (fresh install — no legacy artifacts, so the migration no-ops and the
  // server serves). mustRefuseToStart must therefore return a handle AND have
  // already stopped it.
  const env = freshInstall();
  const started = await mustRefuseToStart({
    board: makeBoardFixture({ cards: [], conversations: [] }), env,
  });
  assert.ok(started, 'precondition: this config MUST start, or the branch is untested');

  // ⛔ THE ACTUAL ASSERTION: the child is gone. Not "we called stop()" — that is
  // the world-after-failure-looks-the-same trap. The port must refuse.
  await assert.rejects(
    () => fetch(`${started.baseUrl}/api/board`),
    'the released child must no longer answer — a stop() that did not stop is the hang',
  );
});

test('⭐⭐ a RESTORED install (state + manifest back) then migrates correctly', async () => {
  // The third leg, and the one that makes the deferral honest: if a lost-state
  // restore was misclassified as fresh, putting the artifacts back must ACTIVATE
  // the migration rather than leave it permanently skipped.
  const flat = flatSources({ pool: [] });                      // ⇒ DEFAULT_POOL
  const srv = await startRestServer({
    board: makeBoardFixture({ cards: [], conversations: [] }),
    env: { ...bootEnv(flat), SCRUM_TENDING_PROVENANCE_FILE: EXAMPLE_MANIFEST },
  });
  try {
    const versions = tendingOf(srv.boardFile).filter((e) => e['@type'] === 'scrum:TendingPromptVersion');
    assert.equal(versions.length, 3, 'restoring the artifacts activates the migration');
    assert.ok(versions.every((v) => v.author), 'and it migrates WITH provenance, not without');
  } finally { await srv.stop(); }
});

test('⭐⭐ a degenerate pool WITH a covering manifest migrates fully provenanced', async () => {
  // The success half of the control above. Without this, "it refused" would be
  // satisfied by a migration that can never succeed at all — a refusal that
  // fires on everything measures nothing.
  const flat = flatSources({ pool: [] });                     // ⇒ DEFAULT_POOL
  const srv = await startRestServer({
    board: makeBoardFixture({ cards: [], conversations: [] }),
    env: { ...bootEnv(flat), SCRUM_TENDING_PROVENANCE_FILE: EXAMPLE_MANIFEST },
  });
  try {
    const versions = tendingOf(srv.boardFile).filter((e) => e['@type'] === 'scrum:TendingPromptVersion');
    assert.equal(versions.length, 3, 'all three default prompts migrated');
    for (const v of versions) {
      assert.ok(v.author, 'every known prompt carries its author — blocker 3');
      // ⛔ IDENTITY IS THE MANIFEST'S LINEAGE, NOT THE BODY HASH — blocker 4.
      // The old call site produced `p-<12 hex>`; a hash-shaped slug here means
      // identity regressed to content.
      assert.doesNotMatch(v['@id'], /\/p-[0-9a-f]{12}\//,
        'a hash-derived slug means identity came from the body again');
    }
    assert.ok(versions.some((v) => v['@id'].includes('hello-ladies')),
      'the lineage slug the manifest assigned is the one in the graph');
  } finally { await srv.stop(); }
});

// ── scrum:importedAt — CREATE-STAMPED, THEN FROZEN ─────────────────────────
// Required at review (#805, commons 24ae52b3): the card promises graph_query
// retrieves every prompt version with provenance AND timestamps. A join against
// /api/changes with an external cutoff does not discharge that promise, so the
// value lives on the node.

test('⭐ the FIRST bootstrap stamps importedAt on every migrated entity', async () => {
  const flat = flatSources();
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: bootEnv(flat) });
  try {
    const ents = tendingOf(srv.boardFile);
    assert.ok(ents.length >= 9, 'the migration must actually have run');
    for (const e of ents) {
      const v = e['scrum:importedAt'];
      assert.ok(v, `${e['@type']} ${e['@id']} carries no importedAt`);
      assert.equal(new Date(v).toISOString(), v, 'must be a canonical UTC instant');
    }
  } finally { await srv.stop(); }
});

test('⭐⭐ a SECOND boot PRESERVES the exact value and writes nothing', async () => {
  // DEFECT: the caller passes a fresh `new Date()` every boot. Without the
  // freeze at the write seam, run 2 computes different bytes at the same @id —
  // every node rewrites, every node emits an event, and the two IMMUTABLE types
  // trip the overwrite guard and FAIL THE BOOT. This is blocker 2's mechanism,
  // and restoring the field re-armed it; the freeze is what disarms it.
  const flat = flatSources();
  const first = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: bootEnv(flat) });
  const stamps = Object.fromEntries(
    tendingOf(first.boardFile).map((e) => [e['@id'], e['scrum:importedAt']]),
  );
  const migrated = JSON.parse(readFileSync(first.boardFile, 'utf8'));
  const eventsAfterFirst = tendingEvents(join(flat, 'events')).length;
  await first.stop();

  const second = await startRestServer({ board: migrated, env: bootEnv(flat) });
  try {
    for (const e of tendingOf(second.boardFile)) {
      assert.equal(e['scrum:importedAt'], stamps[e['@id']],
        `${e['@id']} was re-stamped on the second boot — importedAt is not frozen`);
    }
    assert.equal(tendingEvents(join(flat, 'events')).length, eventsAfterFirst,
      'a preserved stamp means no diff, so no second-boot event may be appended');
  } finally { await second.stop(); }
});

test('⭐⭐ SPARQL retrieves importedAt DIRECTLY — no second API, no join', async () => {
  // This is the control that actually discharges that review requirement. The
  // /api/changes route can also answer, but only given a cutoff the caller must
  // already possess; that is audit evidence, not the promised graph readback.
  const flat = flatSources();
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: bootEnv(flat) });
  try {
    const res = await fetch(`${srv.baseUrl}/api/graph`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'PREFIX scrum: <https://scrumboard.local/ns#>\n'
          + 'SELECT ?v ?body ?at WHERE { ?v a scrum:TendingPromptVersion ; '
          + 'scrum:body ?body ; scrum:importedAt ?at }',
      }),
    });
    assert.equal(res.status, 200);
    const { rows } = await res.json();
    assert.ok(rows.length >= 2, 'every prompt version must answer with its stamp');
    for (const r of rows) {
      assert.ok(r.body, 'text and timestamp come back in ONE query');
      assert.equal(new Date(r.at).toISOString(), r.at);
    }
  } finally { await srv.stop(); }
});

test('⛔ importedAt does NOT overwrite a real-world timestamp', async () => {
  // DEFECT: collapsing "when this record arrived" into "when this happened".
  // The legacy grant occurred at 2026-08-14T22:45:36.788Z; the migration ran
  // whenever it ran. Both must survive, distinct, on the same node — otherwise
  // a historical fact silently acquires the date of its import.
  const flat = flatSources();
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: bootEnv(flat) });
  try {
    const [mint] = tendingOf(srv.boardFile).filter((e) => e['@type'] === 'scrum:TendingMint');
    assert.equal(mint['scrum:mintedAt'], '2026-08-14T22:45:36.788Z',
      'the world-fact is untouched');
    assert.notEqual(mint['scrum:importedAt'], mint['scrum:mintedAt'],
      'arrival time and event time must not be collapsed');
    // And unknown provenance stays unknown — a timestamp is not an author.
    assert.equal('author' in mint, false);
    assert.equal('scrum:actor' in mint, false);
  } finally { await srv.stop(); }
});

test('⭐ NO LIVE ENTRY POINT — the bootstrap is unreachable after startup', () => {
  // DEFECT: a route or exported hook that can rerun the migration is a permanent
  // mutation surface created to solve a one-time problem — and it would run
  // OUTSIDE the boot window, where the ordering safety argument does not hold.
  const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.equal(/export\s+(function\s+)?(writeTendingEntities|migrateTendingIfNeeded)/.test(src), false,
    'neither the seam nor the boot caller may be exported');
  // The only call site is the boot sequence, before listen().
  const calls = [...src.matchAll(/migrateTendingIfNeeded\s*\(/g)];
  assert.equal(calls.length, 2, 'exactly one definition and one call');
  const callIdx = src.lastIndexOf('migrateTendingIfNeeded()');
  const listenIdx = src.indexOf('server.listen(');
  assert.ok(callIdx < listenIdx, 'the migration must be invoked BEFORE server.listen()');
});
