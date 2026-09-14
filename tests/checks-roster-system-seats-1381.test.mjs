/**
 * #1381 (#1380 item 3) — a STANDING check that the roster's `board` and
 * `wiki` seats carry `kind: system`. The history gate exempts those names by
 * that mark; without it their names become guarded words and every push is
 * refused (#600 in July, #1380 at 15:25Z today). The save path was fixed by
 * #1380; this watches the FILE, through /api/checks standing[] — the array
 * the daily digest already renders, so a drop is announced, not discovered
 * at the gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'roster-check-')), 'roster.json');
const SEATS = (wikiKind) => ({ ada: { name: 'Ada', color: '#7cc4a0' }, board: { name: 'Board', color: '#888888', kind: 'system' }, wiki: { name: 'Wiki', color: '#999999', ...(wikiKind ? { kind: wikiKind } : {}) } });

async function standing(baseUrl) {
  const j = await (await fetch(`${baseUrl}/api/checks`)).json();
  const c = (j.standing || []).find((x) => x.id === 'roster-system-seats');
  assert.ok(c, 'the check is in standing[]: ' + JSON.stringify((j.standing || []).map((x) => x.id)));
  return c;
}

test('#1381 both system seats marked → zero rows; wiki unmarked → one row naming wiki and what it carries', async () => {
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ seats: SEATS('system') }));
  const srv = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: file } });
  try {
    let c = await standing(srv.baseUrl);
    assert.equal(c.error, undefined, 'no error');
    assert.deepEqual(c.rows, [], 'a healthy roster is a real zero');
    assert.match(c.claim, /kind: system/);
    // the incident shape: wiki loses its mark (a hand-edit, a restored backup, a regressed cleaner)
    fs.writeFileSync(file, JSON.stringify({ seats: SEATS(null) }));
    c = await standing(srv.baseUrl);
    assert.deepEqual(c.rows, [{ seat: 'wiki', kind: null }], 'the row names the seat and what it carries instead');
  } finally { await srv.stop(); }
});

test('#1381 no roster file → zero rows and NO error (the defaults are code, not the file)', async () => {
  const file = path.join(os.tmpdir(), `absent-${Date.now()}.json`);
  const srv = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: file } });
  try {
    const c = await standing(srv.baseUrl);
    assert.equal(c.error, undefined);
    assert.deepEqual(c.rows, []);
  } finally { await srv.stop(); }
});
