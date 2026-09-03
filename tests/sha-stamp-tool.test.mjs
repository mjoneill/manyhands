/**
 * #1008 — the STAMPER, end to end: a real throwaway git repository, a board
 * carrying one real sha and one fabricated one, and the tool writes a stamp that
 * NAMES the fabrication and attributes the real one to the root that answered.
 *
 * ⛔ The assertion is on the DETECTION. "No fabrications found" is exactly what
 * a blind instrument returns, so a test that only checks a clean stamp would
 * pass against a stamper that resolved nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const TOOL = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'tools', 'stamp-sha-integrity.mjs');

// ⚠️ DIFFERENT content per repo. Two repos with identical content, identity
// and second mint the SAME commit sha — the fixture then cannot tell the roots
// apart, and the first run of this test proved it.
const mkRepo = (dir, content) => {
  execFileSync('git', ['init', '-q', dir]);
  fs.writeFileSync(path.join(dir, 'f'), content);
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).toString().trim();
  g('add', 'f'); g('commit', '-q', '-m', 'one');
  return g('rev-parse', 'HEAD');
};

test('#1008 ⭐ the stamper resolves across roots and NAMES the planted fabrication', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sha-stamp-'));
  const pub = path.join(tmp, 'pub'), ops = path.join(tmp, 'ops'), noGit = path.join(tmp, 'plain');
  fs.mkdirSync(noGit);
  const realPub = mkRepo(pub, 'public');
  const realOps = mkRepo(ops, 'private');
  assert.notEqual(realPub, realOps, 'the fixture must have two distinguishable commits');
  const fake = 'f'.repeat(40);
  const srv = await startRestServer({ board: makeBoardFixture() });
  try {
    const mk = async (title, extra) => {
      const r = await fetch(`${srv.baseUrl}/api/cards`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, createdBy: 'ada', ...extra }) });
      assert.equal(r.status, 201);
      return r.json();
    };
    const c1 = await mk('real in pub', { implementedBy: [realPub] });
    const c2 = await mk('real in ops', { implementedBy: [realOps] });
    const c3 = await mk('fabricated', { implementedBy: [fake] });
    const out = path.join(tmp, 'stamp.json');
    const stdout = execFileSync('node', [TOOL, '--api', srv.baseUrl, '--roots', `${pub}:${ops}:${noGit}`, '--out', out, '--deployed', 'a'.repeat(40)]).toString();
    const stamp = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(stamp.status, 'measured');
    assert.equal(stamp.partial, true, 'the plain dir is unreadable and must be named, not hidden');
    assert.deepEqual(stamp.roots.map((r) => [r.root, r.status, r.resolved]), [[pub, 'read', 1], [ops, 'read', 1], [noGit, 'unreadable', 0]]);
    assert.deepEqual(stamp.resolvedBy, { [realPub]: [pub], [realOps]: [ops] });
    assert.deepEqual(stamp.unresolved, [{ sha: fake, cards: [c3.shortId] }], 'THE DETECTION');
    assert.equal(stamp.enumerated, 3);
    assert.equal(stamp.deployedSha, 'a'.repeat(40));
    assert.match(stamp.resolvedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(stdout, new RegExp(fake.slice(0, 12)), 'the deploy log names the finding too');
    assert.ok(c1 && c2);
  } finally {
    await srv.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
