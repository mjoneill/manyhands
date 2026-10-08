/**
 * #1630 — A BUILDER MUST NOT BE ABLE TO REACH OR KILL THE LIVE SERVER, WHATEVER ITS PROMPT SAYS. On 2026-10-07 at 11:39Z a builder run under a "source only" instruction ran `lsof -ti:3141 | xargs kill` (which killed live REST), started `node server.js` on the default port and issued column CRUD
 * against the live API. A prompt-only rule failed; these rows pin an ENFORCED one. Written by the separate test author BEFORE the build, to the interface below (the builder's own design, from the feasibility spike on #1624, plus the checks the build owner added). If a name changes, the three constants at
 * the top of this file are the only things to change.
 *
 * ⛔ NOTHING IN THIS FILE EVER TOUCHES A REAL LIVE PORT. Every "protected" port is a DECOY server on a random port started by the row; the helpers refuse to run if that port is 3141 or 3143. The profile generator and the REST bind guard therefore take their protected ports from PARAMETERS.
 *
 * INTERFACE ASSUMED:
 *   `node scripts/builder-sandbox.mjs --protect-ports <p[,p...]> --worktree <dir> --tmp <dir> [--write-also <dir>]...` PRINTS a macOS sandbox profile and runs nothing; with no `--protect-ports` it protects 3141 and 3143. The builder is launched as `sandbox-exec -f <profile> <command>` (what `bc-build` does). The profile (a) denies outbound
 *   connections to the protected ports ((remote ip "localhost:P") covers IPv4 and IPv6 loopback), (b) denies BINDING them, (c) denies ALL signals except to itself and its children (`(deny signal (target others))` does NOT protect: shown by the spike and by my own first reference profile), (d) denies file writes outside
 *   <worktree>, <tmp> and each `--write-also` directory (a LINKED git worktree keeps its metadata in the main repository's .git, outside the worktree).
 *   server.js: when env `SCRUM_REQUIRE_LAUNCHD_MARKER` is set and env `SCRUM_LAUNCHD` (the marker the launchd plist sets) is absent, it refuses to bind: exits non-zero within 10 s with a message containing "launchd", listening on nothing. The marker is a MISLAUNCH GUARD only: a row records that setting it opens the door.
 *
 * HOW A DENIAL IS ASSERTED: by STATE, never by an exit status. In the probe that preceded these rows a sandboxed `kill <pid>` returned 0 and the target stayed alive (and under a weaker profile it was killed anyway), so every signal row checks, from OUTSIDE the sandbox, that the decoy PROCESS is alive and still answers.
 * The decoy runs in its OWN process group, as the live service does under launchd: a signal rule that only holds across process groups must be tested across them.
 *
 *   I0  CONTROL, NO SANDBOX: the three 11:39Z moves SUCCEED against a decoy (reach on 127.0.0.1, [::1], localhost; `lsof -ti:PORT | xargs kill` ends it; a second server then binds that port). If this fails the other rows prove nothing.
 *   I1  NO REACH: inside the sandbox the decoy is unreachable on 127.0.0.1, [::1] and localhost, from the command, a child and a grandchild; it still answers from outside.
 *   I2  NO KILL: inside the sandbox, `kill -9 <pid>`, `lsof -ti:PORT | xargs kill -9`, `pkill -9 -f <marker>`, a node `process.kill`, and the same from a grandchild: afterwards the decoy is alive and answers from outside. And a sandboxed process CAN still signal its OWN child.
 *   I3  NO BIND: with the port free, a sandboxed process cannot listen on it on 127.0.0.1 or `::`; a different, unprotected random port CAN be bound.
 *   I4  NO WRITE OUTSIDE: a write outside the worktree, tmp and `--write-also` directories fails and the file does not exist afterwards; writes inside each succeed.
 *   I5  THE LEGITIMATE WORK STILL WORKS: a fixture server on a random port is started and fetched; `node --test` runs in the worktree; `git status` and `git commit` work in a plain repository AND in a LINKED worktree (given `--write-also <main .git>`); per-run data and cache directories under tmp (XDG_DATA_HOME, XDG_CACHE_HOME) are writable;
 *       files outside (the repo, /usr/bin) can be READ. A profile that blocks all this gets switched off.
 *   I6  THE REST BIND GUARD: with SCRUM_REQUIRE_LAUNCHD_MARKER set and no marker, `node server.js` exits non-zero in 10 s naming "launchd" and listens on nothing, on a decoy port AND on a random port; with the marker it binds (forgeable: recorded); with SCRUM_REQUIRE_LAUNCHD_MARKER unset it binds (the guard is opt-in).
 *   I7  THE DEFAULTS PROTECT THE REAL PORTS WITHOUT TOUCHING THEM: the generated profile with no `--protect-ports` names 3141 and 3143.
 *
 * NOT COVERED, by name: that a given builder harness really launches through the wrapper, and that the guard's env variable is set in a builder's environment (properties of how it is started: only a check at launch time can show them; with the variable unset the guard is off and only layers (a) to (d) stop a stray server); the builder-control LEASE
 * COMPLETION (a write outside the worktree whose path and command I have not been given: it needs its own row once they are); denial of unix-domain sockets or of `launchctl` (the 11:39Z run used neither); resource limits; a builder that runs `sandbox-exec` itself with another profile; a protected port reached through a name other than the three tested;
 * OpenCode itself running under the profile (these rows use node, sh, git and lsof, not the real tool).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { PROJECT_DIR } from './helpers/harness.mjs';

const PROFILER = process.env.BUILDER_PROFILER || path.join(PROJECT_DIR, 'scripts', 'builder-sandbox.mjs');            // CONSTANT 1: the profile generator
const FLAGS = { ports: '--protect-ports', worktree: '--worktree', tmp: '--tmp', writeAlso: '--write-also' };          // CONSTANT 2: its flag names
const GUARD_ENV = { require: 'SCRUM_REQUIRE_LAUNCHD_MARKER', marker: 'SCRUM_LAUNCHD' };                               // CONSTANT 3: the bind guard's env names
const REAL_PORTS = [3141, 3143];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HAVE_SANDBOX_EXEC = spawnSync('which', ['sandbox-exec']).status === 0;
const SKIP = HAVE_SANDBOX_EXEC ? false : 'UNAVAILABLE: no sandbox-exec on this machine (a skip is not a pass)';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'iso1630-'));

const refuseReal = (port) => { assert.ok(!REAL_PORTS.includes(Number(port)), `REFUSING to run a row against the real port ${port}`); return Number(port); };
const cleanEnv = () => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; return e; };   // a child `node --test` inherits NODE_TEST_CONTEXT from this runner and refuses to run files
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 60000, env: cleanEnv(), ...opts });

/** a DECOY "live server": a separate process, in its OWN process group, answering on a random dual-stack port; its command line carries `marker` so a pkill row can find it */
async function startDecoy() {
  const marker = `decoy-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const child = spawn(process.execPath, ['-e', `const http=require('http');const s=http.createServer((q,r)=>r.end('decoy-alive'));s.listen(0,'::',()=>console.log(s.address().port)); /* ${marker} */`], { stdio: ['ignore', 'pipe', 'inherit'], detached: true });
  const port = await new Promise((res, rej) => { child.stdout.once('data', (d) => res(Number(String(d).trim()))); child.once('exit', () => rej(new Error('decoy exited'))); });
  refuseReal(port);
  const d = { pid: child.pid, port, marker, child };
  d.alive = () => { try { process.kill(d.pid, 0); return true; } catch { return false; } };
  d.answers = async () => { try { const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) }); return (await r.text()) === 'decoy-alive'; } catch { return false; } };
  d.stop = async () => { try { process.kill(d.pid, 'SIGKILL'); } catch { /* gone */ } child.stdout.destroy(); await sleep(300); };
  return d;
}
let profileN = 0;
const profileArgs = (ports, wt, tmp, writeAlso = []) => [PROFILER, ...(ports == null ? [] : [FLAGS.ports, String(ports)]), FLAGS.worktree, wt, FLAGS.tmp, tmp, ...writeAlso.flatMap((d) => [FLAGS.writeAlso, d])];
function profileFor(port, wt, tmp, writeAlso = []) {
  const r = sh(process.execPath, profileArgs(port == null ? null : refuseReal(port), wt, tmp, writeAlso)); assert.equal(r.status, 0, `the profile generator ran (exit ${r.status}: ${(r.stderr || '').slice(0, 200)})`);
  const file = path.join(TMP, `profile-${++profileN}.sb`); fs.writeFileSync(file, r.stdout); return file;
}
const wrap = (port, wt, tmp, cmd, { writeAlso = [], env = {} } = {}) => sh('sandbox-exec', ['-f', profileFor(port, wt, tmp, writeAlso), ...cmd], { env: { ...cleanEnv(), TMPDIR: tmp, ...env } });
const mkdirs = () => ({ wt: fs.mkdtempSync(path.join(TMP, 'wt-')), tmp: fs.mkdtempSync(path.join(TMP, 'tmp-')), out: fs.mkdtempSync(path.join(TMP, 'outside-')) });
const reachScript = (port) => `const t=(h)=>fetch('http://'+h+':${port}/',{signal:AbortSignal.timeout(2500)}).then(r=>r.text()).then(x=>x.trim(),e=>'FAIL'); (async()=>{console.log(JSON.stringify({v4:await t('127.0.0.1'),v6:await t('[::1]'),lh:await t('localhost')}))})()`;

test('I0 CONTROL, NO SANDBOX: the 11:39Z moves succeed against a decoy: reach on three addresses, kill by port, a second server binds', { timeout: 120000 }, async () => {
  const d = await startDecoy();
  try {
    const r = sh(process.execPath, ['-e', reachScript(d.port)]); const got = JSON.parse(r.stdout.trim());
    assert.deepEqual(got, { v4: 'decoy-alive', v6: 'decoy-alive', lh: 'decoy-alive' }, `the decoy is reachable on all three addresses (${r.stdout} ${r.stderr.slice(0, 120)})`);
    sh('sh', ['-c', `lsof -ti:${d.port} | xargs kill`]); await sleep(800);
    assert.equal(d.alive(), false, 'the kill-by-port ended the decoy (the attack is real; a row that cannot see it succeed proves nothing)');
    const second = spawn(process.execPath, ['-e', `require('http').createServer((q,r)=>r.end('second')).listen(${d.port},'127.0.0.1',()=>console.log('bound'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
    const line = await new Promise((res) => { second.stdout.once('data', (x) => res(String(x).trim())); second.once('exit', () => res('exited')); setTimeout(() => res('timeout'), 5000); }); second.kill('SIGKILL');
    assert.equal(line, 'bound', 'a second server then binds the freed port');
  } finally { await d.stop(); }
});

test('I1 NO REACH: inside the sandbox the decoy is unreachable on three addresses, from the command, a child and a grandchild; it still answers from outside', { skip: SKIP, timeout: 120000 }, async () => {
  const d = await startDecoy(); const { wt, tmp } = mkdirs();
  try {
    const file = path.join(wt, 'reach.cjs'); fs.writeFileSync(file, reachScript(d.port));
    for (const [label, cmd] of [['the command', [process.execPath, file]], ['a child', ['sh', '-c', `${process.execPath} '${file}'`]], ['a grandchild', ['sh', '-c', `sh -c "${process.execPath} '${file}'"`]]]) {
      const r = wrap(d.port, wt, tmp, cmd); assert.equal(r.status, 0, `${label}: the command ran under the profile (exit ${r.status}; ${(r.stderr || '').slice(0, 200)})`);
      assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { v4: 'FAIL', v6: 'FAIL', lh: 'FAIL' }, `${label}: the decoy is unreachable on 127.0.0.1, [::1] and localhost`);
    }
    assert.ok(await d.answers(), 'and the decoy still answers from OUTSIDE the sandbox (the row did not simply break the decoy)');
  } finally { await d.stop(); }
});

test('I2 NO KILL: inside the sandbox every way of signalling the decoy leaves it alive and answering, judged by state; a sandboxed process can still signal its own child', { skip: SKIP, timeout: 180000 }, async () => {
  const d = await startDecoy(); const { wt, tmp } = mkdirs();
  try {
    const attempts = [['kill -9 pid', `kill -9 ${d.pid}`], ['lsof | xargs kill -9', `lsof -ti:${d.port} | xargs kill -9`], ['pkill -9 -f marker', `pkill -9 -f ${d.marker}`], ['from a grandchild', `sh -c 'sh -c "kill -9 ${d.pid}"'`], ['node process.kill', `${process.execPath} -e "try{process.kill(${d.pid},'SIGKILL')}catch(e){}"`]];
    for (const [label, cmd] of attempts) {
      const r = wrap(d.port, wt, tmp, ['sh', '-c', cmd]); assert.ok(r.error === undefined, `${label}: the command ran (${r.error})`);
      await sleep(400);
      assert.ok(d.alive(), `${label}: the decoy process must still be ALIVE (exit status was ${r.status}, which proves nothing: a denied kill can return 0)`);
      assert.ok(await d.answers(), `${label}: and it must still answer from outside`);
    }
    const own = wrap(d.port, wt, tmp, ['sh', '-c', 'sleep 30 & P=$!; kill -9 $P; wait $P 2>/dev/null; kill -0 $P 2>/dev/null && echo STILL || echo GONE']);
    assert.match(own.stdout.trim(), /GONE/, `a sandboxed process CAN signal its own child (got "${own.stdout.trim()}" ${(own.stderr || '').slice(0, 120)})`);
  } finally { await d.stop(); }
});

test('I3 NO BIND: with the port free, a sandboxed process cannot listen on it (127.0.0.1 or ::); an unprotected random port can be bound', { skip: SKIP, timeout: 120000 }, async () => {
  const d = await startDecoy(); const { wt, tmp } = mkdirs(); const port = d.port; await d.stop();
  assert.equal(await d.answers(), false, 'PRECONDITION: the port is free (the decoy was stopped from outside)');
  const bind = (host, p) => `const s=require('net').createServer();s.on('error',e=>{console.log('ERR '+e.code);process.exit(0)});s.listen(${p},'${host}',()=>{console.log('BOUND');s.close()})`;
  for (const host of ['127.0.0.1', '::']) {
    const r = wrap(port, wt, tmp, [process.execPath, '-e', bind(host, port)]); assert.equal(r.status, 0, `the command ran under the profile (${(r.stderr || '').slice(0, 160)})`);
    assert.match(r.stdout.trim(), /^ERR /, `binding the protected port on ${host} fails (got "${r.stdout.trim()}")`);
  }
  const free = wrap(port, wt, tmp, [process.execPath, '-e', bind('127.0.0.1', 0)]); assert.equal(free.stdout.trim(), 'BOUND', 'an unprotected random port can still be bound');
});

test('I4 NO WRITE OUTSIDE: a write outside the worktree, tmp and --write-also fails and leaves no file; writes inside each work', { skip: SKIP, timeout: 120000 }, async () => {
  const d = await startDecoy(); const { wt, tmp, out } = mkdirs(); const also = fs.mkdtempSync(path.join(TMP, 'also-')); await d.stop();
  const write = (file) => ['sh', '-c', `echo x > '${file}'`];
  const bad = path.join(out, 'outside.txt'); const r = wrap(d.port, wt, tmp, write(bad), { writeAlso: [also] }); assert.ok(r.error === undefined, `the command ran (${r.error})`);
  assert.equal(fs.existsSync(bad), false, 'the file outside the worktree, tmp and --write-also does NOT exist afterwards');
  for (const [label, dir] of [['the worktree', wt], ['tmp', tmp], ['--write-also', also]]) { const f = path.join(dir, 'inside.txt'); wrap(d.port, wt, tmp, write(f), { writeAlso: [also] }); assert.equal(fs.existsSync(f), true, `a write inside ${label} works`); }
});

test('I5 THE LEGITIMATE WORK STILL WORKS: fixture server, node --test, git in a plain AND a linked worktree, per-run data/cache dirs, reading outside', { skip: SKIP, timeout: 240000 }, async () => {
  const d = await startDecoy(); const { wt, tmp } = mkdirs(); await d.stop();
  const serve = `const http=require('http');const s=http.createServer((q,r)=>r.end('fixture-ok'));s.listen(0,'127.0.0.1',async()=>{const p=s.address().port;const t=await (await fetch('http://127.0.0.1:'+p+'/')).text();console.log(t);s.close()})`;
  let r = wrap(d.port, wt, tmp, [process.execPath, '-e', serve]); assert.equal(r.stdout.trim(), 'fixture-ok', `a fixture server on a random port starts and answers inside the sandbox (${(r.stderr || '').slice(0, 200)})`);
  fs.writeFileSync(path.join(wt, 'trivial.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('trivial', () => assert.equal(1 + 1, 2));\n");
  r = wrap(d.port, wt, tmp, [process.execPath, '--test', '--test-reporter=tap', path.join(wt, 'trivial.test.mjs')]); assert.match(r.stdout, /# pass 1/, `node --test runs inside the sandbox (${r.stdout.slice(-200)} ${(r.stderr || '').slice(0, 200)})`);
  const gitIdent = ['-c', 'user.email=x@example.invalid', '-c', 'user.name=x', '-c', 'commit.gpgsign=false'];
  sh('git', ['init', '-q'], { cwd: wt });
  r = wrap(d.port, wt, tmp, ['sh', '-c', `cd '${wt}' && git status --short && git add -A && git ${gitIdent.join(' ')} commit -q -m t && git log --oneline | wc -l`]); assert.match(r.stdout.trim().split('\n').pop().trim(), /^1$/, `git status and commit work in a plain repository (${r.stdout.slice(-160)} ${(r.stderr || '').slice(0, 200)})`);
  const main = fs.mkdtempSync(path.join(TMP, 'main-')); const linked = path.join(TMP, `linked-${process.pid}`); sh('git', ['init', '-q'], { cwd: main }); sh('git', [...gitIdent, 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: main }); sh('git', ['worktree', 'add', '-q', '-b', 'b1', linked], { cwd: main });
  const lt = fs.mkdtempSync(path.join(TMP, 'tmp-'));
  r = wrap(d.port, linked, lt, ['sh', '-c', `cd '${linked}' && echo y > f.txt && git add -A && git ${gitIdent.join(' ')} commit -q -m linked && git log --oneline | wc -l`], { writeAlso: [path.join(main, '.git')] });
  assert.match(r.stdout.trim().split('\n').pop().trim(), /^2$/, `git commit works in a LINKED worktree when its main .git is passed as --write-also (${r.stdout.slice(-160)} ${(r.stderr || '').slice(0, 240)})`);
  r = wrap(d.port, wt, tmp, ['sh', '-c', `mkdir -p '${tmp}/data' '${tmp}/cache' && XDG_DATA_HOME='${tmp}/data' XDG_CACHE_HOME='${tmp}/cache' sh -c 'echo d > "$XDG_DATA_HOME/f" && echo c > "$XDG_CACHE_HOME/f" && cat "$XDG_DATA_HOME/f" "$XDG_CACHE_HOME/f"'`]); assert.equal(r.stdout.trim().replace(/\n/g, ''), 'dc', `per-run data and cache directories under tmp are writable (${(r.stderr || '').slice(0, 160)})`);
  r = wrap(d.port, wt, tmp, ['sh', '-c', `ls /usr/bin | head -1 >/dev/null && head -c 20 '${path.join(PROJECT_DIR, 'package.json')}' >/dev/null`]); assert.equal(r.status, 0, `files outside the worktree can be READ (${(r.stderr || '').slice(0, 160)})`);
});

test('I6 THE REST BIND GUARD: required + no marker is refused (decoy and random port); the marker opens it (forgeable: recorded); not required, it binds', { timeout: 240000 }, async () => {
  const d = await startDecoy(); const port = d.port; await d.stop();
  const boardFile = path.join(TMP, 'guard-board.json'); fs.writeFileSync(boardFile, JSON.stringify({ '@context': {}, '@graph': [] }));
  const baseEnv = cleanEnv(); baseEnv.SCRUM_BOARD_FILE = boardFile; baseEnv.SCRUM_MCP_NOTIFY_URL = ''; baseEnv.SCRUM_ATTACHMENTS_DIR = path.join(TMP, 'attachments'); baseEnv.SCRUM_CHANNEL_CONFIG_FILE = path.join(TMP, 'channel-config.json');   // the isolation server.js itself demands of a second board (the harness sets the same)
  fs.mkdirSync(baseEnv.SCRUM_ATTACHMENTS_DIR, { recursive: true }); fs.writeFileSync(baseEnv.SCRUM_CHANNEL_CONFIG_FILE, '{}'); for (const k of [GUARD_ENV.require, GUARD_ENV.marker]) delete baseEnv[k];
  const run = async (env) => { const c = spawn(process.execPath, [path.join(PROJECT_DIR, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: PROJECT_DIR }); let err = ''; c.stderr.on('data', (x) => { err += x; }); c.stdout.on('data', (x) => { err += x; });
    const exited = await Promise.race([new Promise((res) => c.once('exit', (code) => res(code))), sleep(10000).then(() => 'still-running')]); return { c, exited, err }; };
  for (const [label, p] of [['a decoy port', port], ['a random port', 0]]) {
    const refused = await run({ ...baseEnv, SCRUM_PORT: String(p), [GUARD_ENV.require]: '1' });
    try { assert.ok(typeof refused.exited === 'number' && refused.exited !== 0, `${label}: required and no marker, it exits non-zero within 10 s (got ${refused.exited})`); assert.match(refused.err, /launchd/i, `${label}: and the message names "launchd" (${refused.err.slice(0, 200)})`); } finally { refused.c.kill('SIGKILL'); }
  }
  const marked = await run({ ...baseEnv, SCRUM_PORT: '0', [GUARD_ENV.require]: '1', [GUARD_ENV.marker]: '1' });
  try { assert.equal(marked.exited, 'still-running', `with the marker it starts (a MISLAUNCH GUARD, forgeable by anyone who sets the variable: this row records that it is not protection) (${marked.err.slice(0, 200)})`); } finally { marked.c.kill('SIGKILL'); }
  const open = await run({ ...baseEnv, SCRUM_PORT: '0' });
  try { assert.equal(open.exited, 'still-running', `not required, it starts (the guard is opt-in) (${open.err.slice(0, 200)})`); } finally { open.c.kill('SIGKILL'); }
});

test('I7 THE DEFAULTS PROTECT THE REAL PORTS WITHOUT TOUCHING THEM: the generated profile with no --protect-ports names 3141 and 3143', { timeout: 60000 }, () => {
  const { wt, tmp } = mkdirs(); const r = sh(process.execPath, profileArgs(null, wt, tmp));
  assert.equal(r.status, 0, `the generator prints and runs nothing (${(r.stderr || '').slice(0, 160)})`);
  for (const p of REAL_PORTS) assert.match(r.stdout, new RegExp(`\\b${p}\\b`), `the default profile names ${p}`);
});
