/**
 * #1567 PC5 — the handed-bytes capture records EVERY model dispatch of a wake
 * (the first call and each tool hop), before the call goes out, with the exact
 * messages and tools, and never a credential.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { makeHandedCapture, dispatchPosition } from '../core/handed-dump.mjs';
import { runToolLoop } from '../core/tool-loop.mjs';
import { BOARD_TOOLS } from '../core/board-tools.mjs';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'handed-')), 'dump.jsonl');
const read = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('#1567 PC5: every dispatch of a tool-using wake is captured, labelled by position', async () => {
  const file = tmpFile();
  let call = 0;
  const stub = async () => {
    call += 1;
    if (call === 1) return { text: '', toolCalls: [{ id: 't1', name: 'graph_authority', arguments: { topic: 'urn:ex:t', predicate: 'urn:ex:p', scope: 'urn:ex:s' } }] };
    return { text: 'done', toolCalls: [] };
  };
  const callModel = makeHandedCapture({ file, wakeId: 'w1' })(stub);
  const tools = BOARD_TOOLS.filter((t) => t.function.name === 'graph_authority');
  await runToolLoop({
    agent: { id: 'm', model: 'x' },
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }],
    tools,
    execute: async () => ({ status: 'CURRENT', marker: 'RESOLVER-RESULT' }),
    callModel,
    opts: { apiKey: 'sk-SHOULD-NEVER-APPEAR', temperature: 0 },
  });
  const rows = read(file);
  assert.equal(rows.length, 2, 'both dispatches captured, not only the first');
  assert.equal(rows[0].position, 'initial');
  assert.equal(rows[1].position, 'after-tool-result-1');
  assert.ok(JSON.stringify(rows[1].handed.messages).includes('RESOLVER-RESULT'), 'the tool result the model was handed is in the capture');
  assert.equal(rows[0].handed.tools[0].function.name, 'graph_authority', 'the tools payload is captured');
  for (const r of rows) {
    assert.equal(r.sha256, createHash('sha256').update(JSON.stringify(r.handed)).digest('hex'));
    assert.equal(r.wakeId, 'w1');
  }
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('sk-SHOULD-NEVER-APPEAR'), 'no credential reaches the file');
  assert.deepEqual(rows[0].droppedOptionKeys, ['apiKey']);
});

test('#1567 PC5: a dispatch is recorded BEFORE the call, so a failing call is still on record', async () => {
  const file = tmpFile();
  const callModel = makeHandedCapture({ file })(async () => { throw new Error('provider down'); });
  await assert.rejects(callModel({ id: 'm' }, [{ role: 'user', content: 'x' }], {}), /provider down/);
  assert.equal(read(file).length, 1);
});

test('#1567 PC5: position counts tool results handed so far', () => {
  assert.equal(dispatchPosition([{ role: 'user' }]), 'initial');
  assert.equal(dispatchPosition([{ role: 'user' }, { role: 'assistant' }, { role: 'tool' }, { role: 'tool' }]), 'after-tool-result-2');
});
