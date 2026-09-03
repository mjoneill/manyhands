/**
 * #1152 — THE GRAPH-NATIVE INVARIANT, WIRED.
 *
 * Decision `aaf1774b`, ratified by three seats 2026-08-30 and prose for four
 * days: new entity kinds are born in the graph; a new side-file needs
 * the owner's explicit sign-off. All three seats said the same thing about it —
 * wire it as a check, "because a vision constraint that isn't a gate gets
 * eroded by good engineers being locally right."
 *
 * This is the gate. It runs in the server suite, which every push runs.
 *
 * ── THE POPULATION IS THE PROCESS, NOT A GREP ───────────────────────────────
 *
 * ⛔ I built the grep version far enough to disprove it. THREE scans of the same
 * tree returned THREE DIFFERENT SETS of stores — the env-name scan missed
 * SCRUM_SEAT_TOKENS, the const scan missed SCRUM_EVENTS_DIR, the union of both
 * missed the whisper and channel config files. A registry checked against a
 * scan is exactly as complete as the scan and then reports the invariant as
 * guarded, which is worse than reporting nothing.
 *
 * ⇒ So the server is run with an fs hook and asked what it OPENED. That is a
 * measurement. The scan survives only as a way to propose candidates.
 *
 * ⚠️ THE BOUND, stated because a check that hides its bound is the shape this
 * room keeps paying for: the recording is as complete as the requests the test
 * makes. A store opened only on a path nothing here exercises is invisible.
 * That is why test 3 asserts the recording CONTAINS KNOWN STORES — an empty or
 * broken recording and a board with no side-files are byte-identical otherwise,
 * and the broken one would pass forever.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { PERSISTENT_STORES, STORE_KINDS, storeFor, unregisteredStoreMessage } from '../core/persistent-stores.mjs';

const RECORDER = path.resolve(import.meta.dirname, 'helpers/fs-store-recorder.mjs');

/** Run a server with the fs recorder attached, exercise it, return the paths it opened. */
async function recordStores(exercise, { extraEnv = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'store-registry-'));
  const rec = path.join(tmp, 'opened.txt');
  fs.writeFileSync(rec, '');
  const srv = await startRestServer({
    board: makeBoardFixture(),
    env: { ...extraEnv, SCRUM_FS_RECORD: rec, NODE_OPTIONS: `--import ${RECORDER}` },
  });
  const boardFile = srv.boardFile;
  try {
    await exercise(srv);
  } finally {
    await srv.stop();
  }
  const lines = fs.readFileSync(rec, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { lines, boardFile };
}

/** Paths that are not persistent state: source, node internals, the recorder's own sink. */
const isCandidateStore = (p) => {
  const base = path.basename(p);
  if (/\.(mjs|js|cjs|json)$/.test(base) && /node_modules|package(-lock)?\.json$/.test(p)) return false;
  if (/\/(node_modules|\.git)\//.test(p)) return false;
  if (/\.(mjs|cjs|map|ts|html|css|md|svg|png|ico|woff2?)$/.test(base)) return false;
  if (base === 'opened.txt') return false;
  return /\.(json|jsonl)$/.test(base) || /events-\d{4}-\d{2}-\d{2}/.test(base);
};

test('#1152 the registry is well-formed: every entry declares a kind and a reason', () => {
  assert.ok(PERSISTENT_STORES.length > 0, 'an empty registry would pass every other test here');
  for (const s of PERSISTENT_STORES) {
    assert.ok(s.match, `entry with no match: ${JSON.stringify(s)}`);
    assert.ok(STORE_KINDS.includes(s.kind), `${s.match}: kind ${s.kind} is not one of ${STORE_KINDS}`);
    assert.ok(typeof s.why === 'string' && s.why.length > 40,
      `${s.match}: needs a REASON, not a label — "why is this allowed" is the whole content of the registry`);
  }
  // #857's "what is native" line should be derivable from this rather than typed.
  assert.ok(PERSISTENT_STORES.some((s) => s.kind === 'RECORD'), 'some store must be a RECORD');
  assert.ok(PERSISTENT_STORES.some((s) => s.kind === 'PROJECTION'), 'and some a PROJECTION');
});

test('#1152 ⭐ THE GATE — every persistent store the RUNNING SERVER opens is registered', async () => {
  const opened = await recordStores(async (srv) => {
    // Exercise the paths that touch state: read, write, graph, queue, checks.
    await fetch(`${srv.baseUrl}/api/load`);
    const r = await fetch(`${srv.baseUrl}/api/cards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'store registry probe', createdBy: 'ada' }),
    });
    await r.json();
    await fetch(`${srv.baseUrl}/api/checks`);
    await fetch(`${srv.baseUrl}/api/ready?limit=5`);
  });

  // A store RELOCATED by its env var is the same store: the invariant is about
  // what KIND of thing exists, not where it lives. The harness points
  // SCRUM_BOARD_FILE at `board.json`, so that basename IS the board here —
  // resolving it from the env the server was given is honest, where widening
  // the registry's pattern to /^board.*\.json$/ would quietly admit any new
  // store whose name began with "board".
  const relocated = new Set([path.basename(opened.boardFile)]);
  const candidates = [...new Set(opened.lines.filter(isCandidateStore).map((p) => path.basename(p)))];
  const unregistered = candidates.filter((b) => !storeFor(b) && !relocated.has(b));
  assert.deepEqual(unregistered, [], unregisteredStoreMessage(unregistered));
  // ⛔ AND THE GATE MUST HAVE SEEN SOMETHING. A filter that rejected every path
  // would leave `candidates` empty and this test green forever.
  assert.ok(candidates.length >= 3,
    `the gate examined only ${candidates.length} candidate store(s) — too few to be a measurement of a `
    + `server that reads a board, an event log and several configs. Recorded: ${opened.lines.length} paths.`);
});

test('#1152 ⛔ POSITIVE CONTROL — the recording is REAL: it contains stores we know were opened', async () => {
  const opened = await recordStores(async (srv) => {
    await fetch(`${srv.baseUrl}/api/load`);
    await fetch(`${srv.baseUrl}/api/cards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'positive control', createdBy: 'ada' }),
    });
  });
  const bases = new Set(opened.lines.map((p) => path.basename(p)));
  // ⛔ THE ANTI-VACUITY ASSERTION. Without it, a recorder that silently records
  // NOTHING passes the gate above forever, and the suite reports the invariant
  // guarded on a measurement that never happened.
  assert.ok(bases.size > 0, 'the recorder wrote nothing — the gate above measured an empty set');
  assert.ok(bases.has(path.basename(opened.boardFile)),
    'THE BOARD ITSELF must appear. The first version of this recorder monkeypatched fs.readFileSync '
    + 'and did NOT intercept `import { readFileSync } from \'node:fs\'` — which is how core/store.mjs '
    + 'opens the board — so the board was absent from a recording of a server that had just written it, '
    + 'and the gate passed on five unrelated paths.');
  assert.ok([...bases].some((b) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(b)),
    `expected the board or its event log among the opened paths, got: ${[...bases].sort().join(', ')}`);
});

test('#1152 ⛔ NEGATIVE CONTROL — an UNREGISTERED store is refused, in the invariant\'s words', () => {
  // The gate's own logic, put to a store nobody registered. If this passes,
  // the check cannot fail and every other test here is decoration.
  assert.equal(storeFor('seat-feelings.jsonl'), null, 'an unknown store must not resolve');
  const msg = unregisteredStoreMessage(['seat-feelings.jsonl']);
  assert.match(msg, /aaf1774b/, 'the refusal cites the decision, so a seat reads the ruling not a test name');
  assert.match(msg, /born in the graph/, 'and states the invariant');
  assert.match(msg, /sign-off/, 'and names what a RECORD needs');
  assert.match(msg, /seat-feelings\.jsonl/, 'and names the offending store');
});

test('#1152 a registered store resolves however the operator relocated it', () => {
  // The invariant is about what KIND of thing exists, not where it lives — a
  // store moved by an env var is the same store.
  assert.equal(storeFor('board-data.json')?.kind, 'RECORD');
  assert.equal(storeFor('events-2026-09-03.jsonl')?.kind, 'RECORD');
  assert.equal(storeFor('sha-integrity.json')?.kind, 'PROJECTION');
  assert.equal(storeFor('roster.json')?.kind, 'CONFIG');
  assert.equal(storeFor('graph-query-log.jsonl')?.kind, 'LOG');
});
