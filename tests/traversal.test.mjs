/**
 * Server-side tests for directory traversal protection (#120).
 *
 * The static file guard must resolve symlinks and `..` before deciding a
 * path is inside the static root. A plain `startsWith` check is fooled by:
 *   - a symlink inside the root that points outside it
 *   - a sibling directory whose name has the root as a prefix
 *
 * These tests run the server against an isolated temp static dir
 * (SCRUM_STATIC_DIR) so they can plant a symlink and a sibling dir without
 * touching the repo.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startRestServer } from './helpers/harness.mjs';

/** GET with a NON-normalized path — fetch() would collapse `..` itself. */
function rawGet(baseUrl, rawPath) {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, method: 'GET', path: rawPath },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Build an isolated serving sandbox:
 *   <base>/public/             ← static root
 *   <base>/public/ok.txt       ← a legitimate file
 *   <base>/public/evil-link    ← symlink → <base>/secret.txt (escape!)
 *   <base>/secret.txt          ← secret, outside the root
 *   <base>/public-secrets/...  ← sibling dir, name prefixed by the root
 */
function makeStaticSandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-traversal-'));
  const staticDir = path.join(base, 'public');
  fs.mkdirSync(staticDir);
  fs.writeFileSync(path.join(staticDir, 'ok.txt'), 'legitimate content');

  const secretFile = path.join(base, 'secret.txt');
  fs.writeFileSync(secretFile, 'TOP SECRET - should never be served');
  fs.symlinkSync(secretFile, path.join(staticDir, 'evil-link'));

  const siblingDir = `${staticDir}-secrets`;
  fs.mkdirSync(siblingDir);
  fs.writeFileSync(path.join(siblingDir, 'sibling-secret.txt'), 'SIBLING SECRET');

  return {
    staticDir,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

/** Run a test body with a server rooted at a fresh traversal sandbox. */
function traversalTest(name, fn) {
  test(name, async () => {
    const sandbox = makeStaticSandbox();
    const server = await startRestServer({ staticDir: sandbox.staticDir });
    try {
      await fn(server);
    } finally {
      await server.stop();
      sandbox.cleanup();
    }
  });
}

// ── The real bugs ───────────────────────────────────────────────────────

traversalTest('a symlink escaping the static root is blocked (403)', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/evil-link`);
  assert.equal(res.status, 403, 'symlink escape must be Forbidden');
  const body = await res.text();
  assert.ok(!body.includes('TOP SECRET'), 'secret contents must not leak');
});

traversalTest('a sibling-prefix directory is not reachable (403)', async ({ baseUrl }) => {
  const res = await rawGet(baseUrl, '/../public-secrets/sibling-secret.txt');
  assert.equal(res.status, 403, 'sibling-prefix escape must be Forbidden');
  assert.ok(!res.body.includes('SIBLING SECRET'), 'sibling secret must not leak');
});

// ── Regression guards (correct before and after the fix) ────────────────

traversalTest('legitimate files inside the static root still serve (200)', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/ok.txt`);
  assert.equal(res.status, 200);
  assert.equal((await res.text()).trim(), 'legitimate content');
});

traversalTest('a nonexistent path returns 404', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/does-not-exist.txt`);
  assert.equal(res.status, 404);
});

traversalTest('a raw ../ escape to a system path is blocked (403)', async ({ baseUrl }) => {
  const res = await rawGet(baseUrl, '/../../../../../../../etc/hosts');
  assert.equal(res.status, 403);
});

// ── #300: sensitive subtrees inside the root must not be served ──────────
// The static root IS the project dir, which also holds .git (full history,
// including reworded/deleted content — #217), backups/ (states the live board
// lost), and node_modules/. These live legitimately inside the root, so the
// traversal guard passes them — they need an explicit deny (same shape as the
// #251 /attachments refusal).
function makeSensitiveSandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-sensitive-'));
  const staticDir = path.join(base, 'public');
  fs.mkdirSync(staticDir);
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>ok</h1>');
  for (const [dir, file, secret] of [
    ['.git', 'config', 'GIT SECRET url = git@…'],
    ['backups', 'board-data-backup-x.json', 'BACKUP SECRET'],
    ['node_modules', 'pkg.txt', 'NODE MODULES'],
  ]) {
    fs.mkdirSync(path.join(staticDir, dir), { recursive: true });
    fs.writeFileSync(path.join(staticDir, dir, file), secret);
  }
  return { staticDir, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function sensitiveTest(name, fn) {
  test(name, async () => {
    const sb = makeSensitiveSandbox();
    const server = await startRestServer({ staticDir: sb.staticDir });
    try { await fn(server); } finally { await server.stop(); sb.cleanup(); }
  });
}

sensitiveTest('#300 /.git is not served (404), git history stays private', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/.git/config`);
  assert.equal(res.status, 404, 'git internals must not be served');
  assert.ok(!(await res.text()).includes('GIT SECRET'), 'git contents must not leak');
});

sensitiveTest('#300 /backups is not served (404), lost-state copies stay private', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/backups/board-data-backup-x.json`);
  assert.equal(res.status, 404, 'backups must not be served');
  assert.ok(!(await res.text()).includes('BACKUP SECRET'), 'backup contents must not leak');
});

sensitiveTest('#300 /node_modules is not served (404)', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/node_modules/pkg.txt`);
  assert.equal(res.status, 404);
});

sensitiveTest('#300 legitimate files still serve (deny-list is prefix-scoped, not a blanket)', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/index.html`);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('ok'));
});
