/**
 * #1762 S4 — the `cursors.json` RELOCATION (S4 CONTRACT v1 section 5; S4 v2 option (i)), black-box, rows first.
 *
 * ROW AUTHOR's rows for `scripts/cursors-relocate-1762.mjs --from <event-log dir> --to <SCRUM_DATA_DIR> [--apply]` and for what REST does with the moved file.
 * Written before the script exists, from the contract and the reviewer's S4 v2 review. These rows do NOT depend on the two departures from S4 v2 that the
 * contract proposes and the reviewer has yet to rule on (no new L1/g1 token; a page never ends inside a commit): they are about where lane state lives and
 * how it moves, not about the lane's position grammar. Those rows wait for the ruling.
 *
 * Real lanes are made through REST (register, pull, ack), REST is stopped (the relocation is an explicit step with all cursor writers quiesced), and the
 * script runs as a child process against two throwaway directories. Nothing here imports the builder's code, and nothing touches a live data folder.
 *
 *   RC-P  the script exists
 *   RC1   the default is a DRY RUN: exit 0, ONE JSON object saying so, and NOTHING in either directory changes
 *   RC2   --apply: the new file holds every lane exactly as the old one did (all fields, including a served-but-unacked page and its session), the old file
 *         is renamed cursors.json.migrated with its ORIGINAL bytes (never deleted), no .tmp is left, and the new file has the old file's mode
 *   RC3   re-running a finished relocation is a no-op (exit 0, both directories byte-identical)
 *   RC4   the crash seam (SCRUM_CURSORS_RELOCATE_CRASH_AT = after-temp | after-rename | after-verify) exits 70 at that point, leaves exactly the files
 *         that step implies, never loses or alters the old file's lanes, and a plain re-run finishes from ANY of them
 *   RC5   it will not overwrite a different file already at the destination (exit non-zero, both files untouched) and a missing --to is a usage error (exit 2)
 *   RC6   REST serves from the NEW file once it exists: a known lane keeps its cursor, `envelope.cursor_file` names the new path, the owed events are served,
 *         an ack advances the NEW file and leaves the .migrated copy's bytes alone (it is an archive, so an older copy must not make a later ack invalid)
 *   RC7   a CORRUPT relocated file: pull, ack and register all refuse 503 CURSOR_STATE_INVALID naming the file; nothing starts fresh; no file is rewritten
 *   RC8   both files present, the old not yet .migrated, and they DISAGREE: 503 CURSOR_STATE_INVALID, both files untouched
 *   RC9   --from and --to that name the SAME directory (spelled differently, or through a symlink) are refused before any write: the one cursors.json is never
 *         renamed onto its own archive (found by the integration review: it exited 0 and the destination no longer existed)
 *   RC10  an archive (cursors.json.migrated) that already exists with DIFFERENT bytes is never overwritten: apply refuses, both directories untouched
 *   RC11  the ownership evidence survives the event-log directory's retirement: relocate, archive the old directory (S6's action) and leave a fresh empty one at its
 *         path, then lose the destination's cursors.json: pull, ack and register refuse 503 CURSOR_STATE_INVALID and nothing starts fresh at head. Control: with the
 *         destination file present the same restart serves the lane. (A contract correction is owed: the S4 v1.1 A3 check reads `.migrated` under the ORIGINAL path.)
 *
 * ── Assumptions, each one line to correct ─────────────────────────────────────────────────────────────────────────────────────
 *   A1  the dry run and the apply each print ONE JSON object on stdout with a boolean `dryRun`; no other report key is asserted.
 *   A2  exit codes: 0 done (or nothing to do), 2 usage / unreadable input, 3 refusal (a different file already at the destination), 70 the test crash seam.
 *   A3  `envelope.cursor_file` is the path the lane state was served from, compared after realpath (macOS /var vs /private/var).
 *   A4  REST resolves cursors from `<SCRUM_DATA_DIR>/cursors.json` when that exists, else `<SCRUM_EVENT_LOG_DIR>/cursors.json`.
 *   NOT PINNED, so not written: the report's other keys; the .tmp file's exact name beyond "ends in .tmp"; the order of lanes in the file; the exact
 *   `file` value for RC8 (one of the two paths).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'cursors-relocate-1762.mjs');
const owned = { dirs: [], servers: [] };
after(async () => { for (const s of owned.servers) await s.stop().catch(() => {}); for (const d of owned.dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); owned.dirs.push(d); return d; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const real = (p) => fs.realpathSync(p);

const run = (args, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => p.kill('SIGKILL'), 60000);
  p.on('close', (status) => { clearTimeout(timer); resolve({ status, out, err }); });
});
const script = async (args, env) => {
  const r = await run(args, env);
  if (r.status === 1 && /Cannot find module/.test(r.err)) assert.fail('PRECONDITION: scripts/cursors-relocate-1762.mjs does not exist yet — the contract names it, so these rows are RED until it does');
  return r;
};
const jsonOf = (r, label) => { let j = null; try { j = JSON.parse(r.out); } catch { /* below */ } assert.ok(j && typeof j === 'object' && !Array.isArray(j), `${label}: stdout is ONE JSON object (got ${JSON.stringify(r.out.slice(0, 160))}; stderr ${JSON.stringify(r.err.slice(0, 160))})`); return j; };
/** every file in a directory (not recursive) as name -> sha256 */
const snap = (d) => Object.fromEntries(fs.readdirSync(d).sort().map((f) => [f, fs.statSync(path.join(d, f)).isFile() ? sha(fs.readFileSync(path.join(d, f))) : 'dir']));

/** two lanes made through REST: A has acked 2 of 5; B was served a page and never acked it. Returns the dirs and the old file's bytes. */
async function world(body) {
  const evdir = tmp('cr1762-events-'), datadir = tmp('cr1762-data-'), boardDir = tmp('cr1762-board-');
  const env = { SCRUM_EVENT_LOG_DIR: evdir, SCRUM_DATA_DIR: datadir, SCRUM_BOARD_FILE: path.join(boardDir, 'board-data.json') };
  const startRest = async () => { const s = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), boardFile: path.join(boardDir, 'board-data.json'), env }); owned.servers.push(s); return s; };
  const mk = (srv) => async (method, route, payload) => {
    const r = await fetch(`${srv.baseUrl}${route}`, { method, headers: payload ? { 'content-type': 'application/json' } : {}, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(30000) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, text, json };
  };
  let srv = await startRest(); let call = mk(srv);
  const lane = (n) => `registry:${n}`;
  for (const n of ['rc.a', 'rc.b']) assert.equal((await call('POST', '/api/cursors/register', { registrySeatId: n })).status, 200, 'PRECONDITION: lane registered');
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/cards', { title: `relocation ${i}`, description: 'x', createdBy: 'ada' })).status, 201, 'PRECONDITION: a write the lanes are owed');
  const pa = await call('GET', `/api/cursors/pull?identity=${encodeURIComponent(lane('rc.a'))}&limit=2`);
  assert.equal((await call('POST', '/api/cursors/ack', { identity: lane('rc.a'), token: pa.json.ack_token })).status, 200, 'PRECONDITION: lane A acked its first page');
  assert.equal((await call('GET', `/api/cursors/pull?identity=${encodeURIComponent(lane('rc.b'))}&limit=3`)).status, 200, 'PRECONDITION: lane B was served a page and never acked it');
  await srv.stop(); owned.servers = owned.servers.filter((s) => s !== srv);
  const oldFile = path.join(evdir, 'cursors.json');
  assert.ok(fs.existsSync(oldFile), `PRECONDITION: the lanes live in ${oldFile}`);
  fs.chmodSync(oldFile, 0o600);                                   // cursor state is access-restricted: a script that resets the mode to the default is caught by a file that is not the default
  const original = fs.readFileSync(oldFile);
  const OLD = JSON.parse(original.toString('utf8'));
  assert.equal(OLD.seats[lane('rc.a')].acked, 2); assert.equal(OLD.seats[lane('rc.b')].served, 3, 'PRECONDITION: B has a served-but-unacked page, the state a careless move would lose');
  const newFile = path.join(datadir, 'cursors.json');
  const ctx = { evdir, datadir, oldFile, newFile, original, OLD, lane, env, startRest, mk, args: (extra = []) => ['--from', evdir, '--to', datadir, ...extra] };
  try { await body(ctx); } finally { for (const s of owned.servers) await s.stop().catch(() => {}); owned.servers = []; }
}

test('#1762 S4 RC-P — scripts/cursors-relocate-1762.mjs exists', () => {
  assert.ok(fs.existsSync(SCRIPT), 'the contract names scripts/cursors-relocate-1762.mjs; it is not there yet, so every other relocation row is RED for that one reason');
});

test('#1762 S4 RC1 — the default is a DRY RUN: exit 0, one JSON object that says so, and NOTHING in either directory changes', async () => {
  await world(async (w) => {
    const before = [snap(w.evdir), snap(w.datadir)];
    const r = await script(w.args());
    assert.equal(r.status, 0, `a clean dry run exits 0 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    assert.equal(jsonOf(r, 'dry run').dryRun, true, 'the report says it was a dry run (A1)');
    assert.deepEqual([snap(w.evdir), snap(w.datadir)], before, 'not one byte, file or rename in either directory');
  });
});

test('#1762 S4 RC2 — --apply: every lane moves exactly, the old file is archived with its original bytes, no .tmp remains, the mode is kept', async () => {
  await world(async (w) => {
    const mode = fs.statSync(w.oldFile).mode & 0o777;
    assert.equal(mode, 0o600, 'PRECONDITION: the fixture\'s old file is restrictive (0600), so keeping the mode and resetting it to the default differ');
    const r = await script(w.args(['--apply']));
    assert.equal(r.status, 0, `exit 0 (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    assert.equal(jsonOf(r, 'apply').dryRun, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(w.newFile, 'utf8')).seats, w.OLD.seats, 'the new file holds EVERY lane exactly as the old one did: acked, served, the served-but-unacked page and its session fields');
    assert.equal(fs.existsSync(w.oldFile), false, 'the old path is vacated ...');
    assert.deepEqual(fs.readFileSync(`${w.oldFile}.migrated`), w.original, '... by RENAMING it: the archive has its original bytes, it was not deleted or rewritten');
    for (const d of [w.evdir, w.datadir]) assert.deepEqual(fs.readdirSync(d).filter((f) => f.endsWith('.tmp')), [], `no temp file is left in ${path.basename(d)}`);
    assert.equal(fs.statSync(w.newFile).mode & 0o777, mode, 'the new file keeps the old file\'s mode (cursor state is access-restricted state)');
  });
});

test('#1762 S4 RC3 — re-running a finished relocation is a no-op: exit 0 and both directories byte-identical', async () => {
  await world(async (w) => {
    assert.equal((await script(w.args(['--apply']))).status, 0);
    const before = [snap(w.evdir), snap(w.datadir)];
    const r = await script(w.args(['--apply']));
    assert.equal(r.status, 0, `(got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    assert.deepEqual([snap(w.evdir), snap(w.datadir)], before, 'nothing moved');
  });
});

// ── RC4 the crash seam ──
const STEPS = {
  'after-temp': (w) => {
    assert.ok(fs.readdirSync(w.datadir).some((f) => f.endsWith('.tmp')), 'a temp file for the new state exists');
    assert.equal(fs.existsSync(w.newFile), false, 'the new file is NOT yet in place');
    assert.deepEqual(fs.readFileSync(w.oldFile), w.original, 'and the old file is exactly as it was');
  },
  'after-rename': (w) => {
    assert.deepEqual(JSON.parse(fs.readFileSync(w.newFile, 'utf8')).seats, w.OLD.seats, 'the new file is in place with every lane');
    assert.deepEqual(fs.readFileSync(w.oldFile), w.original, 'the old file is still in place, unchanged (not yet archived)');
    assert.equal(fs.existsSync(`${w.oldFile}.migrated`), false);
  },
  'after-verify': (w) => {
    assert.deepEqual(JSON.parse(fs.readFileSync(w.newFile, 'utf8')).seats, w.OLD.seats, 'the new file is in place and was verified');
    assert.deepEqual(fs.readFileSync(w.oldFile), w.original, 'the old file is not yet archived');
    assert.equal(fs.existsSync(`${w.oldFile}.migrated`), false);
  },
};
for (const [step, check] of Object.entries(STEPS)) {
  test(`#1762 S4 RC4 — a crash ${step}: exit 70, exactly the files that step implies, the old lanes intact, and a plain re-run finishes`, async () => {
    await world(async (w) => {
      const crashed = await script(w.args(['--apply']), { SCRUM_CURSORS_RELOCATE_CRASH_AT: step });
      assert.equal(crashed.status, 70, `the seam exits 70 at ${step} (got ${crashed.status}: ${(crashed.err || crashed.out).slice(-300)})`);
      check(w);
      const done = await script(w.args(['--apply']));
      assert.equal(done.status, 0, `a plain re-run finishes from ${step} (got ${done.status}: ${(done.err || done.out).slice(-300)})`);
      assert.deepEqual(JSON.parse(fs.readFileSync(w.newFile, 'utf8')).seats, w.OLD.seats, 'every lane is in the new file exactly once, as it was');
      assert.deepEqual(fs.readFileSync(`${w.oldFile}.migrated`), w.original, 'the old file is archived with its original bytes');
      assert.equal(fs.existsSync(w.oldFile), false);
      for (const d of [w.evdir, w.datadir]) assert.deepEqual(fs.readdirSync(d).filter((f) => f.endsWith('.tmp')), [], 'and no temp file remains');
    });
  });
}

// ── RC5 refusals ──
test('#1762 S4 RC5a — it will NOT overwrite a different file already at the destination: non-zero exit, both files untouched', async () => {
  await world(async (w) => {
    const newer = JSON.parse(w.original.toString('utf8')); newer.seats[w.lane('rc.a')].acked = 4;          // the destination already holds NEWER progress
    fs.writeFileSync(w.newFile, `${JSON.stringify(newer, null, 2)}\n`);
    const before = [snap(w.evdir), snap(w.datadir)];
    const r = await script(w.args(['--apply']));
    assert.ok([2, 3].includes(r.status), `a different destination file is a refusal, exit 2 or 3 (A2), never a silent overwrite (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    assert.deepEqual([snap(w.evdir), snap(w.datadir)], before, 'and nothing changed: newer progress is never overwritten');
  });
});
test('#1762 S4 RC5b — a missing --to is a usage error: exit 2 and nothing written', async () => {
  await world(async (w) => {
    const before = [snap(w.evdir), snap(w.datadir)];
    const r = await script(['--from', w.evdir, '--apply']);
    assert.equal(r.status, 2, `(got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    assert.deepEqual([snap(w.evdir), snap(w.datadir)], before);
  });
});

// ── RC6 REST after the move ──
test('#1762 S4 RC6 — REST serves from the NEW file: a known lane keeps its cursor, cursor_file names the new path, owed events are served, an ack advances the new file and leaves the archive alone', async () => {
  await world(async (w) => {
    assert.equal((await script(w.args(['--apply']))).status, 0);
    const archive = fs.readFileSync(`${w.oldFile}.migrated`);
    const srv = await w.startRest(); const call = w.mk(srv);
    const reg = await call('POST', '/api/cursors/register', { registrySeatId: 'rc.a' });
    assert.equal(reg.status, 200, `(got ${reg.status}: ${reg.text.slice(0, 200)})`);
    assert.equal(reg.json.fresh, false, 'a known lane is not fresh after the move');
    assert.equal(reg.json.envelope.last_acked_seq, 2, 'and keeps the cursor it had');
    assert.equal(real(reg.json.envelope.cursor_file), real(w.newFile), 'envelope.cursor_file names the file the state was served from (A3)');
    const pull = await call('GET', `/api/cursors/pull?identity=${encodeURIComponent(w.lane('rc.a'))}&limit=10`);
    assert.deepEqual(pull.json.events.map((e) => e.seq).slice(0, 3), [3, 4, 5], 'the events it was owed are served, from the first unacked one');
    const ack = await call('POST', '/api/cursors/ack', { identity: w.lane('rc.a'), token: pull.json.ack_token });
    assert.equal(ack.status, 200, `an ack is accepted although the archive is older (got ${ack.status}: ${ack.text.slice(0, 200)})`);
    assert.ok(JSON.parse(fs.readFileSync(w.newFile, 'utf8')).seats[w.lane('rc.a')].acked >= 5, 'the NEW file advanced');
    assert.deepEqual(fs.readFileSync(`${w.oldFile}.migrated`), archive, 'and the archive was not touched');
    assert.equal(fs.existsSync(w.oldFile), false, 'nothing recreated the old path');
  });
});

// ── RC7 / RC8 refuse, never start fresh ──
test('#1762 S4 RC7 — a CORRUPT relocated file: pull, ack and register all refuse 503 CURSOR_STATE_INVALID naming the file; nothing starts fresh; no file is rewritten', async () => {
  await world(async (w) => {
    fs.writeFileSync(w.newFile, '{ this is not json');
    const cursorFiles = () => [sha(fs.readFileSync(w.oldFile)), sha(fs.readFileSync(w.newFile))];
    const logLines = () => fs.readdirSync(w.evdir).filter((f) => /^events-.*\.jsonl$/.test(f)).sort().flatMap((f) => fs.readFileSync(path.join(w.evdir, f), 'utf8').split('\n').filter(Boolean));
    const before = cursorFiles(); const logBefore = logLines();
    const srv = await w.startRest(); const call = w.mk(srv);
    const pull = await call('GET', `/api/cursors/pull?identity=${encodeURIComponent(w.lane('rc.a'))}`);
    assert.equal(pull.status, 503, `pull is refused (got ${pull.status}: ${pull.text.slice(0, 200)})`);
    assert.equal(pull.json.code, 'CURSOR_STATE_INVALID');
    assert.equal(real(pull.json.file), real(w.newFile), 'and names the file that is wrong');
    const ack = await call('POST', '/api/cursors/ack', { identity: w.lane('rc.a'), token: 'x' });
    assert.equal(ack.status, 503, 'an ack is refused too (a corrupt state cannot be acked into)'); assert.equal(ack.json.code, 'CURSOR_STATE_INVALID');
    const reg = await call('POST', '/api/cursors/register', { registrySeatId: 'rc.brand-new' });
    assert.equal(reg.status, 503, 'and registering a NEW lane is refused: nothing starts a fresh state over a corrupt one'); assert.equal(reg.json.code, 'CURSOR_STATE_INVALID');
    await srv.stop(); owned.servers = owned.servers.filter((s) => s !== srv);
    assert.deepEqual(cursorFiles(), before, 'neither cursors.json was rewritten by any of those');
    // the event log MAY grow: a refused write is itself recorded (#1217: refused rows), which is today's behaviour and not cursor state. It may gain refusals and nothing else.
    const gained = logLines().slice(logBefore.length).map((l) => JSON.parse(l));
    assert.ok(gained.every((e) => e.op === 'refused'), `the only thing the event log gained is refusal records (got ${JSON.stringify(gained.map((e) => e.op))})`);
  });
});
test('#1762 S4 RC8 — both files present, the old not yet archived, and they DISAGREE: 503 CURSOR_STATE_INVALID, both files untouched', async () => {
  await world(async (w) => {
    const other = JSON.parse(w.original.toString('utf8')); other.seats[w.lane('rc.a')].acked = 1;
    fs.writeFileSync(w.newFile, `${JSON.stringify(other, null, 2)}\n`);
    const before = [snap(w.evdir), snap(w.datadir)];
    const srv = await w.startRest(); const call = w.mk(srv);
    const pull = await call('GET', `/api/cursors/pull?identity=${encodeURIComponent(w.lane('rc.a'))}`);
    assert.equal(pull.status, 503, `(got ${pull.status}: ${pull.text.slice(0, 200)})`);
    assert.equal(pull.json.code, 'CURSOR_STATE_INVALID');
    assert.ok([w.oldFile, w.newFile].some((f) => { try { return real(pull.json.file) === real(f); } catch { return false; } }), `and names one of the two files (got ${pull.json.file})`);
    await srv.stop(); owned.servers = owned.servers.filter((s) => s !== srv);
    assert.deepEqual([snap(w.evdir), snap(w.datadir)], before, 'both files untouched');
  });
});

// ── RC9 the same directory ──
for (const [label, alias] of [
  ['spelled differently (a trailing slash and a dot segment)', (d) => `${d}${path.sep}.${path.sep}`],
  ['named through a symlink', (d) => { const l = `${d}-link`; fs.symlinkSync(d, l); owned.dirs.push(l); return l; }],
  ['named identically', (d) => d],
]) {
  test(`#1762 S4 RC9 — --from and --to naming the SAME directory (${label}) is refused before any write: the one cursors.json is not archived away`, async () => {
    await world(async (w) => {
      const d = tmp('cr1762-same-');
      fs.writeFileSync(path.join(d, 'cursors.json'), w.original); fs.chmodSync(path.join(d, 'cursors.json'), 0o600);
      const to = alias(d);
      const before = snap(d);
      const r = await script(['--from', d, '--to', to, '--apply']);
      assert.ok([2, 3].includes(r.status), `the same directory is a refusal, exit 2 or 3 (A2), never a done (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
      assert.deepEqual(snap(d), before, 'the directory is byte-identical: no archive, no temp, and the state file is still there');
      assert.ok(fs.readFileSync(path.join(d, 'cursors.json')).equals(w.original), 'and the lanes in it are exactly as they were');
    });
  });
}

// ── RC10 an existing archive ──
test('#1762 S4 RC10 — an archive that already exists with DIFFERENT bytes is never overwritten: apply refuses and both directories are untouched', async () => {
  await world(async (w) => {
    const archive = path.join(w.evdir, 'cursors.json.migrated');
    fs.writeFileSync(archive, 'AN EARLIER ARCHIVE THAT MUST NOT BE OVERWRITTEN\n');
    const before = [snap(w.evdir), snap(w.datadir)];
    const r = await script(w.args(['--apply']));
    assert.ok([2, 3].includes(r.status), `a contradictory archive is a refusal, exit 2 or 3 (A2) (got ${r.status}: ${(r.err || r.out).slice(-300)})`);
    assert.equal(fs.readFileSync(archive, 'utf8'), 'AN EARLIER ARCHIVE THAT MUST NOT BE OVERWRITTEN\n', 'the earlier archive keeps its bytes');
    assert.deepEqual([snap(w.evdir), snap(w.datadir)], before, 'and nothing else moved: the state file is still the source, nothing was written at the destination');
  });
});

// ── RC11 ownership evidence outlives the retired directory ──
test('#1762 S4 RC11 — after the event-log directory is retired, losing the destination cursors.json must refuse (503 CURSOR_STATE_INVALID), never start a known lane fresh at head', async () => {
  await world(async (w) => {
    const done = await script(w.args(['--apply']));
    assert.equal(done.status, 0, `PRECONDITION: the relocation finished (got ${done.status}: ${(done.err || done.out).slice(-300)})`);
    assert.ok(fs.existsSync(w.newFile), 'PRECONDITION: the destination holds the lanes');
    fs.renameSync(w.evdir, `${w.evdir}-archived`); owned.dirs.push(`${w.evdir}-archived`);      // S6's action: the old directory (and its .migrated) leaves the path
    fs.mkdirSync(w.evdir);                                                                         // and a fresh, empty one takes its place
    const lane = w.lane('rc.a');
    {   // control: the same restart with the destination PRESENT serves the lane at its cursor
      const srv = await w.startRest(); owned.servers.push(srv); const call = w.mk(srv);
      const pull = await call('GET', `/api/cursors/pull?identity=${encodeURIComponent(lane)}&limit=2`);
      assert.equal(pull.status, 200, `CONTROL: with the destination present the known lane is served (got ${pull.status}: ${pull.text.slice(0, 200)})`);
      await srv.stop(); owned.servers = owned.servers.filter((x) => x !== srv);
    }
    fs.renameSync(w.newFile, `${w.newFile}.lost`);                                                // the destination's state file is lost
    const srv = await w.startRest(); owned.servers.push(srv); const call = w.mk(srv);
    const pull = await call('GET', `/api/cursors/pull?identity=${encodeURIComponent(lane)}&limit=2`);
    assert.equal(pull.status, 503, `a known lane whose state file is gone must not be served from an empty state (got ${pull.status}: ${pull.text.slice(0, 200)})`);
    assert.equal(pull.json?.code, 'CURSOR_STATE_INVALID', `named (got ${pull.text.slice(0, 200)})`);
    const ack = await call('POST', '/api/cursors/ack', { identity: lane, token: 'x' });
    assert.equal(ack.json?.code, 'CURSOR_STATE_INVALID', `ack refuses the same way (got ${ack.status}: ${ack.text.slice(0, 200)})`);
    const reg = await call('POST', '/api/cursors/register', { registrySeatId: 'rc.new' });
    assert.equal(reg.json?.code, 'CURSOR_STATE_INVALID', `and register: nothing starts fresh (got ${reg.status}: ${reg.text.slice(0, 200)})`);
    assert.ok(!fs.existsSync(w.newFile) && !fs.existsSync(path.join(w.evdir, 'cursors.json')), 'and no state file was created in either place');
  });
});
