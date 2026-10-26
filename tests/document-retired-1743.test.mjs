// #1743 — a RETIRED board document (`<file>.retired` beside it) is never written again, and nothing else is touched on the
// way to refusing: saveDomain refuses, and every one of the six dormant CLIs that write the document refuses at ENTRY,
// before any graph read, any history (event log) write, any backup and any document write (review 129-8036650: two
// scripts appended history and redact rewrote it before the first version's guard). With no marker (every mode-on board,
// every other test) nothing changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { saveDomain } from '../core/store.mjs';
import { retiredMarkerPath } from '../core/document-retired.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEAD_EXECUTOR = 'http://127.0.0.1:9';   // nothing listens: a CLI that got past its entry guard would fail differently

function world({ marked }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-1743-'));
  const file = path.join(dir, 'board-data.json');
  fs.writeFileSync(file, JSON.stringify({ cards: [{ id: 'c1', shortId: 1, title: 'one' }], conversations: [{ id: 'p1', body: 'one' }], columns: [] }, null, 2));
  const events = path.join(dir, 'board-data-events');
  fs.mkdirSync(events);
  fs.writeFileSync(path.join(events, 'events-2026-10-26.jsonl'), JSON.stringify({ seq: 1, recorded_at: '2026-10-26T00:00:00.000Z', occurred_at: '2026-10-26T00:00:00.000Z', actor: 'test-actor', op: 'create', entity: { kind: 'card', id: 'c1', shortId: 1 }, state: { id: 'c1', title: 'one' } }) + '\n');
  if (marked) fs.writeFileSync(retiredMarkerPath(file), 'retired by the 10-26 cutover\n');
  return { dir, file, events, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
// every file under the world, with its sha256: the "nothing changed, nothing new" fingerprint
function fingerprint(dir) {
  const out = {};
  const walk = (d) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } };
  walk(dir);
  return out;
}
function run(w, script, args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, SCRUM_EVENT_LOG_DIR: w.events, SCRUM_BOARD_FILE: w.file, ...env } });
}

const CLIS = {
  'migrate-post-seq-1592': (w) => ['scripts/migrate-post-seq-1592.mjs', ['--board-file', w.file]],
  'retire-collections-1624 --apply': (w) => ['scripts/retire-collections-1624.mjs', ['--board-data', w.file, '--executor', DEAD_EXECUTOR, '--dataset', 'x', '--apply']],
  'retire-unit3-collections-1582 --apply': (w) => ['scripts/retire-unit3-collections-1582.mjs', ['--board-data', w.file, '--executor', DEAD_EXECUTOR, '--dataset', 'x', '--apply']],
  'rollback-posts-1574': (w) => ['scripts/rollback-posts-1574.mjs', ['--board-file', w.file, '--executor-url', DEAD_EXECUTOR, '--dataset-id', 'x']],
  'rollback-columns-1639': (w) => ['scripts/rollback-columns-1639.mjs', ['--board-file', w.file, '--executor-url', DEAD_EXECUTOR, '--dataset-id', 'x']],
  'redact --confirm, an entity present in the document': () => ['scripts/redact.mjs', ['--kind', 'card', '--id', '1', '--fields', 'title', '--actor', 'test-actor', '--authority', 'test #1743', '--reason', 'test', '--confirm']],
  'redact --confirm, a history-only target (no document entity)': () => ['scripts/redact.mjs', ['--kind', 'card', '--id', 'gone-only-in-history', '--fields', 'title', '--actor', 'test-actor', '--authority', 'test #1743', '--reason', 'test', '--confirm']],
};

for (const [name, argsOf] of Object.entries(CLIS)) {
  test(`#1743 ${name}: on a RETIRED document it refuses at entry: non-zero exit, the reason on stderr, every file (document, event log) byte-identical and nothing new`, (t) => {
    const w = world({ marked: true }); t.after(w.done);
    const before = fingerprint(w.dir);
    const [script, args] = argsOf(w);
    const r = run(w, script, args);
    assert.notEqual(r.status, 0, `${name} must exit non-zero`);
    assert.match(r.stderr, /#1743 REFUSED/, `${name} must name the refusal`);
    assert.deepEqual(fingerprint(w.dir), before, `${name}: nothing changed and nothing was created`);
  });
}

test('#1743 R1 saveDomain refuses a retired document (DOCUMENT_RETIRED), and the file is byte-identical with no tmp left', (t) => {
  const w = world({ marked: true }); t.after(w.done);
  const before = fingerprint(w.dir);
  assert.throws(() => saveDomain(w.file, { nodes: [], messages: [], columns: [], nextShortId: 1 }), (e) => e.code === 'DOCUMENT_RETIRED' && /#1743 REFUSED/.test(e.message));
  assert.deepEqual(fingerprint(w.dir), before);
});

test('#1743 R2 CONTROL: with no marker, saveDomain writes as before', (t) => {
  const w = world({ marked: false }); t.after(w.done);
  const before = fs.readFileSync(w.file, 'utf8');
  saveDomain(w.file, { nodes: [], messages: [], columns: [], nextShortId: 1 }, { now: '2026-10-26T00:00:00.000Z' });
  assert.notEqual(fs.readFileSync(w.file, 'utf8'), before);
});

test('#1743 R4 CONTROL: with no marker the post-seq migration runs and numbers the post (the guard is not a blanket refusal)', (t) => {
  const w = world({ marked: false }); t.after(w.done);
  execFileSync(process.execPath, ['scripts/migrate-post-seq-1592.mjs', '--board-file', w.file], { cwd: ROOT, stdio: 'pipe' });
  assert.equal(JSON.parse(fs.readFileSync(w.file, 'utf8')).conversations[0].postSeq, 1);
});

test('#1743 R6 CONTROL: with no marker, a dry-run redact gets past the entry guard (it reaches its own logic, not a #1743 refusal)', (t) => {
  const w = world({ marked: false }); t.after(w.done);
  const r = run(w, 'scripts/redact.mjs', ['--kind', 'card', '--id', '1', '--fields', 'title', '--actor', 'test-actor', '--authority', 'test #1743', '--reason', 'test']);
  assert.doesNotMatch(r.stderr, /#1743 REFUSED/);
});
