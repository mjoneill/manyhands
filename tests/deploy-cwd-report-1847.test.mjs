/**
 * #1847 slice 1 — a deploy SAYS which running services it left on an older tree.
 *
 * deploy.sh restarts only rest and mcp (#1138); every other job keeps running from the folder the swap just renamed to
 * `.previous`, and the NEXT deploy refuses at #1831's guard. Until now the deployer learned that only from that refusal.
 * This slice changes no behaviour: after the swap, deploy.sh runs `serve-cwd-check.mjs --serve <serve>` and
 *   - exit 1 (a job is on `previous` or GONE): prints the table, names those jobs, and posts ONE line to the commons;
 *   - exit 0: says every running job is current, posts nothing;
 *   - exit 2, or no check script: says UNMEASURED (never a pass), posts nothing;
 * and the deploy itself still succeeds in every case — a report is never fatal.
 *
 * THE SEAM: a fixture clone (as #1831's test) whose `scripts/serve-cwd-check.mjs` is a FAKE that records its argv and
 * prints a chosen table with a chosen exit code; the commons post goes to a capture server named by DEPLOY_BOARD_API,
 * never to a real board. R6 runs the REAL check with only launchctl/lsof faked. Covered: the `export` path. Not covered: the full deploy and --no-restart paths, which need
 * launchctl and a pull; they call the same function.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync, existsSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEPLOY = fileURLToPath(new URL('../scripts/deploy.sh', import.meta.url));
const DEPS = fileURLToPath(new URL('../scripts/deploy-deps-check.mjs', import.meta.url));

const ROOT_TMP = mkdtempSync(join(tmpdir(), 'cwd-1847-'));
after(() => { spawnSync('chmod', ['-R', 'u+w', ROOT_TMP]); rmSync(ROOT_TMP, { recursive: true, force: true }); });

const git = (clone, ...a) => spawnSync('git', ['-C', clone, ...a], { encoding: 'utf8' });
const commit = (clone, msg) => git(clone, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', msg);

/** A fixture clone; `check` is { table, code } for a fake serve-cwd-check, or null for none at all. */
function fixtureClone(check) {
  const dir = mkdtempSync(join(ROOT_TMP, 'seam-'));
  const clone = join(dir, 'clone'); const serve = join(dir, 'serve'); const argvFile = join(dir, 'check-argv.json');
  mkdirSync(join(clone, 'tools'), { recursive: true }); mkdirSync(join(clone, 'scripts'), { recursive: true });
  writeFileSync(join(clone, 'tools', 'ci-verdict.mjs'), 'process.exit(0);\n');
  copyFileSync(DEPS, join(clone, 'scripts', 'deploy-deps-check.mjs'));
  if (check) {
    writeFileSync(join(clone, 'scripts', 'serve-cwd-check.mjs'),
      `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`
      + `process.stdout.write(${JSON.stringify(check.table)});\nprocess.exit(${check.code});\n`);
  }
  writeFileSync(join(clone, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/a': { version: '1.0.0' } } }));
  writeFileSync(join(clone, '.gitignore'), 'node_modules/\n');
  mkdirSync(join(clone, 'node_modules', 'a'), { recursive: true });
  writeFileSync(join(clone, 'node_modules', 'a', 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0' }));
  writeFileSync(join(clone, 'release.txt'), '0\n');
  git(clone, 'init', '-q'); git(clone, 'add', '-A'); commit(clone, 'fixture');
  return { clone, serve, argvFile };
}

/** A capture server standing in for the board's commons. */
async function captureBoard() {
  const posts = [];
  const server = http.createServer((req, res) => {
    let s = ''; req.on('data', (d) => { s += d; }).on('end', () => {
      posts.push({ method: req.method, url: req.url, body: (() => { try { return JSON.parse(s); } catch { return s; } })() });
      res.writeHead(201, { 'Content-Type': 'application/json' }); res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, posts, close: () => new Promise((r) => server.close(r)) };
}

/** `deploy.sh export` ASYNC (the capture server must answer while it runs). */
function deploy(fx, n, boardUrl, pathPrefix) {
  writeFileSync(join(fx.clone, 'release.txt'), `${n}\n`); commit(fx.clone, `release ${n}`);
  return new Promise((resolve) => {
    const c = spawn('sh', [DEPLOY, 'export'], { env: { PATH: pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH, DEPLOY_CLONE: fx.clone, DEPLOY_SERVE: fx.serve, DEPLOY_BOARD_API: boardUrl } });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), 60000);
    c.on('close', (status) => { clearTimeout(t); resolve({ status, out: out + err }); });
  });
}

const TABLE_STALE = 'serve com.scrumboard.rest pid=11 cwd=/s (inode 1)\n'
  + 'previous com.scrumboard.graph-executor pid=12 cwd=/s.previous/graph-executor (inode 2)\n'
  + 'GONE com.scrumboard.activity-projector pid=13 cwd=/old (inode 3)\n'
  + 'serve-cwd: 3 running jobs checked against serve inode 1 and .previous 9; exit 1\n';

test('R1 A JOB LEFT BEHIND IS NAMED, AND THE ROOM IS TOLD ONCE: exit 1 → table printed, both stale jobs named, one commons post naming them and not the current one; the deploy still succeeds', async () => {
  const fx = fixtureClone({ table: TABLE_STALE, code: 1 }); const board = await captureBoard();
  try {
    const r = await deploy(fx, 1, board.url);
    assert.equal(r.status, 0, `the deploy succeeds: a report is never fatal\n${r.out}`);
    assert.deepEqual(JSON.parse(readFileSync(fx.argvFile, 'utf8')), ['--serve', fx.serve], 'the check is asked about THIS serve folder');
    assert.match(r.out, /previous com\.scrumboard\.graph-executor/, 'the table is printed');
    assert.match(r.out, /⚠️.*graph-executor.*activity-projector|⚠️.*activity-projector.*graph-executor/, `the warning names both stale jobs\n${r.out}`);
    assert.equal(board.posts.length, 1, `exactly ONE commons post (${JSON.stringify(board.posts)})`);
    const [p] = board.posts;
    assert.equal(p.method, 'POST'); assert.equal(p.url, '/api/conversations');
    assert.equal(p.body.author, 'board');
    assert.match(p.body.body, /graph-executor/); assert.match(p.body.body, /activity-projector/);
    assert.doesNotMatch(p.body.body, /com\.scrumboard\.rest/, 'a job on the current tree is not named as stale');
    assert.match(p.body.body, /next deploy will refuse/i, 'it says what this costs');
  } finally { await board.close(); }
});

test('R2 EVERYTHING CURRENT: exit 0 → a ✓ line, and no post', async () => {
  const fx = fixtureClone({ table: 'serve com.scrumboard.rest pid=11 cwd=/s (inode 1)\nserve-cwd: 1 running jobs checked; exit 0\n', code: 0 });
  const board = await captureBoard();
  try {
    const r = await deploy(fx, 1, board.url);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /✓.*running job/i, `says so\n${r.out}`);
    assert.equal(board.posts.length, 0, 'nothing to tell the room');
  } finally { await board.close(); }
});

test('R3 COULD NOT CHECK IS NEVER A PASS: exit 2 → UNMEASURED with the command to run, no ✓, no post; the deploy still succeeds', async () => {
  const fx = fixtureClone({ table: 'serve-cwd: CANNOT CHECK — launchctl list failed\n', code: 2 });
  const board = await captureBoard();
  try {
    const r = await deploy(fx, 1, board.url);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /UNMEASURED/, r.out);
    assert.match(r.out, /serve-cwd-check\.mjs --serve/, 'it names the command to run by hand');
    assert.doesNotMatch(r.out, /✓.*running job/i, 'and never reads as a pass');
    assert.equal(board.posts.length, 0);
  } finally { await board.close(); }
});

test('R4 NO CHECK SCRIPT IN THE CLONE: UNMEASURED, no post; the deploy still succeeds', async () => {
  const fx = fixtureClone(null); const board = await captureBoard();
  try {
    const r = await deploy(fx, 1, board.url);
    assert.equal(r.status, 0, r.out);
    assert.ok(!existsSync(fx.argvFile));
    assert.match(r.out, /UNMEASURED/, r.out);
    assert.equal(board.posts.length, 0);
  } finally { await board.close(); }
});

test('R6 THE REAL CHECK, NOT A COPY OF ITS FORMAT (#1847 review): the actual serve-cwd-check runs in the fixture, a fake launchctl/lsof reports one job whose cwd is the folder the swap just made `.previous`, and the deploy names THAT job', async () => {
  // R1's fake prints serve-cwd-check's line format by hand, so a format change would leave R1 green while the deploy
  // named nobody. Here only the OS is faked: launchctl lists one job, lsof says its cwd is the old serve folder's inode.
  const fx = fixtureClone(null);
  copyFileSync(fileURLToPath(new URL('../scripts/serve-cwd-check.mjs', import.meta.url)), join(fx.clone, 'scripts', 'serve-cwd-check.mjs'));
  const board = await captureBoard();
  try {
    const r1 = await deploy(fx, 1, board.url);   // serve exists; no .previous yet
    assert.equal(r1.status, 0, r1.out);
    const oldServeInode = statSync(fx.serve).ino;   // the swap RENAMES serve → .previous, so this inode is .previous after deploy 2
    const bin = join(fx.clone, '..', 'fakebin'); mkdirSync(bin);
    writeFileSync(join(bin, 'launchctl'), '#!/bin/sh\nprintf "PID\\tStatus\\tLabel\\n4242\\t0\\tcom.scrumboard.fixture-job\\n"\n');
    writeFileSync(join(bin, 'lsof'), `#!/bin/sh\ncase " $* " in *" -d cwd "*) printf "p4242\\nfcwd\\ni${oldServeInode}\\nn${join(fx.serve)}\\n"; exit 0 ;; esac\nexec /usr/sbin/lsof "$@"\n`);
    chmodSync(join(bin, 'launchctl'), 0o755); chmodSync(join(bin, 'lsof'), 0o755);
    const r2 = await deploy(fx, 2, board.url, bin);
    assert.equal(r2.status, 0, r2.out);
    assert.ok(existsSync(`${fx.serve}.previous`) && statSync(`${fx.serve}.previous`).ino === oldServeInode, 'CONTROL: the swap made the old serve folder `.previous` (same inode)');
    assert.match(r2.out, /previous com\.scrumboard\.fixture-job/, `the REAL check classified the job as previous\n${r2.out}`);
    assert.equal(board.posts.length, 1, `one commons post (${JSON.stringify(board.posts)})`);
    assert.match(board.posts[0].body.body, /fixture-job/, 'naming the job the real check found');
  } finally { await board.close(); }
});

test('R5 THE BOARD IS DOWN: exit 1 with no board to post to → the deploy still succeeds and says the room was NOT told', async () => {
  const fx = fixtureClone({ table: TABLE_STALE, code: 1 });
  const r = await deploy(fx, 1, 'http://127.0.0.1:9');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /not posted|tell the room by hand/i, r.out);
});
