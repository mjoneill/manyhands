// #1789 — in mode off the in-process copy is retired, so nothing may read its leftover snapshot (graph-snapshot.json, last
// written 2026-10-18): the store meter refuses BEFORE it reads the snapshot meta, and its hourly log timer is not started.
// Structural, against server.js's source: the live file-access proof is the mode-off recorder world (board-without-document).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js'), 'utf8');

test('#1789 S1 graphStoreMeter refuses (REPLICA_RETIRED) without the copy, BEFORE it calls readSnapshotMeta', () => {
  const body = SRC.slice(SRC.indexOf('function graphStoreMeter() {'), SRC.indexOf('\n}\n', SRC.indexOf('function graphStoreMeter() {')));
  const guard = body.indexOf('if (!DOCUMENT_READS) throw');
  const read = body.indexOf('readSnapshotMeta()');
  assert.ok(guard > -1, 'the meter has a retired-copy guard');
  assert.ok(read > -1 && guard < read, 'the guard comes before the snapshot read');
  assert.match(body, /REPLICA_RETIRED/);
});

test('#1789 S2 the hourly meter log timer starts only while the copy exists', () => {
  const at = SRC.indexOf('// One line an hour so the trend is in the log');
  assert.ok(at > -1);
  assert.match(SRC.slice(at, at + 200), /if \(DOCUMENT_READS\) setInterval\(/);
});

test('#1789 S3 CONTROL: readSnapshotMeta has exactly two callers, each unreachable without the copy (a NEW caller fails here)', () => {
  const at = [...SRC.matchAll(/readSnapshotMeta\(\)/g)].map((m) => m.index);
  assert.equal(at.length, 3, 'the definition, graphStoreMeter (guarded above), and the replica sync\'s first-replay meter line');
  const syncCall = at.find((i) => SRC.slice(Math.max(0, i - 400), i).includes('if (_graphReplayTailMs === null)'));
  assert.ok(syncCall != null, 'the third is the replica sync\'s first-replay line, which runs only after the in-process store was built (never in mode off)');
});
