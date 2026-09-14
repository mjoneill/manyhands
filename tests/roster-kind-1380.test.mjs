/**
 * #1380 — saving the roster must not change what the room IS.
 *
 * Two silent edits a save used to make: (1) `kind: system` on `board` and
 * `wiki` was dropped, and the history gate — which derives the guarded names
 * from the roster and lets ONLY `kind: system` opt a seat out (#600) — then
 * guarded the words "board" and "wiki" and refused every push; (2) the seats
 * the API MERGES from agent records (`agent: true`) were written into the
 * file as roster seats, where they would shadow the record and outlive it.
 *
 * Both are the same bug: the cleaner kept name · glyph · color · aliases and
 * treated everything else as noise. `kind` rides through; an agent seat is
 * refused by name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRoster, writeRoster, droppedAgentSeats } from '../core/roster-config.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'roster-1380-')), 'roster.json');
const ROOM = {
  ada: { name: 'Ada', glyph: '🅰', color: '#7cc4a0' },
  board: { name: 'board', glyph: '▦', color: '#888888', kind: 'system' },
  wiki: { name: 'wiki', glyph: '📖', color: '#999999', kind: 'system' },
};

test('#1380 `kind` SURVIVES a save — the gate\'s only opt-out is not something a Settings save may drop', () => {
  const file = tmp();
  writeRoster({ seats: ROOM }, file);
  const back = loadRoster(file);
  assert.equal(back.board.kind, 'system', 'board keeps kind: system');
  assert.equal(back.wiki.kind, 'system', 'wiki keeps kind: system');
  assert.equal('kind' in back.ada, false, 'a seat with no kind gains none — absence means person (#600)');
  // a round trip of the read shape (what Settings sends back) is a no-op on kind
  writeRoster({ seats: back }, file);
  assert.equal(loadRoster(file).board.kind, 'system');
  // and a non-string kind is not smuggled in
  writeRoster({ seats: { ...ROOM, bo: { name: 'Bo', color: '#123456', kind: 42 } } }, file);
  assert.equal('kind' in loadRoster(file).bo, false);
});

test('#1380 a MERGED agent seat (agent: true) is DROPPED by name — the file never absorbs a record it does not own', () => {
  const file = tmp();
  const input = { seats: { ...ROOM, gizmo: { name: 'Gizmo', glyph: '◍', color: '#abcdef', agent: true } } };
  assert.deepEqual(droppedAgentSeats(input), ['gizmo'], 'the save can say what it left out');
  writeRoster(input, file);
  const back = loadRoster(file);
  assert.equal('gizmo' in back, false, 'not written');
  assert.equal(back.board.kind, 'system', 'and the rest of the room is intact');
});

test('#1380 SERVED — POST /api/roster with the GET shape (merged agent seat, kind on board) keeps kind and does not persist the agent seat', async () => {
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ seats: ROOM }));
  const board = makeBoardFixture({ cards: [], nextShortId: 1 });
  board.agents = [{ '@id': 'https://scrumboard.local/agent/gizmo', '@type': 'scrum:Agent', 'scrum:seatKey': 'gizmo', name: 'Gizmo', 'scrum:state': 'invited' }];
  const srv = await startRestServer({ board, env: { SCRUM_ROSTER_FILE: file } });
  try {
    const got = await (await fetch(`${srv.baseUrl}/api/roster`)).json();
    assert.ok(got.seats.gizmo?.agent === true, `the read MERGES the agent seat and marks it — ${JSON.stringify(got.seats.gizmo)}`);
    assert.equal(got.seats.board.kind, 'system', 'the read carries kind');
    // what a naive client does: send the read back with a role set
    const r = await fetch(`${srv.baseUrl}/api/roster`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seats: got.seats, roles: { po: 'ada' } }) });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.seats.board.kind, 'system', 'kind survived the round trip on disk');
    assert.equal('gizmo' in onDisk.seats, false, 'the agent seat was NOT persisted into the file');
    assert.deepEqual(onDisk.roles, { po: 'ada' });
    assert.ok(Array.isArray(j.dropped) && j.dropped.includes('gizmo'), `the response names what it left out — ${JSON.stringify(j.dropped)}`);
  } finally { await srv.stop(); }
});
