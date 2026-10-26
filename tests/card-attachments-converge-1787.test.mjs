// #1787 (#138 review) — a card write REPLACES its attachment metadata, so the backfill converges. The review found that a
// stale attachment fact (a name the stored JSON no longer says) and an extra attachment node survived a reproject: a write
// deleted only the triples its prior projection named. The card's own write now removes every owned attachment triple
// (linked by attachmentOf AND under its /attachment/ prefix) before inserting the projection. Against a REAL executor:
// stale name + extra node → backfill --apply → exactly the projected node, then a re-run writes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { cardQuads, cardIriOf, shortIdMap } from '../core/cards-graph.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'backfill-card-attachments-1787.mjs');
const DS = 'att-conv-1787';
const run = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('close', (status) => resolve({ status, out, err }));
});

test('#1787 C1 a stale attachment name and an extra attachment node are REPLACED by the backfill, and a re-run writes nothing', { skip: !HAVE_PY && 'no executor python', timeout: 180000 }, async (t) => {
  const store = tmpStore('att-conv-1787-');
  const x = await startExecutor({ store, datasetId: DS, create: true });
  t.after(async () => { await killExecutor(x); fs.rmSync(store, { recursive: true, force: true }); });
  const g = createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: DS, timeoutMs: 30000, label: 'c1' });
  const card = { id: 'c-conv', shortId: 3, title: 'with one attachment', column: 'backlog', version: 1, attachments: [{ id: 'att-1', name: 'expected.txt', mime: 'text/plain', size: 3 }] };
  const iri = cardIriOf(card.id);
  const w = await g.update({ kind: 'card.write', opId: 'urn:ex:op/card/c1', actor: 'https://scrumboard.local/person/ada', parts: [{ iri, expectedVersion: null, version: '1', quads: cardQuads(card, shortIdMap([card])), json: JSON.stringify(card) }] });
  assert.equal(w.outcome, 'APPLIED', JSON.stringify(w));
  // corrupt: a stale name beside a removed real one, and an extra node the JSON does not have
  const ep = (await (await fetch(`${x.baseUrl}/health`)).json()).epoch;
  const raw = async (opId, body) => { const r = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': opId, 'x-epoch': String(ep) }, body }); assert.equal(r.status, 200, await r.text()); };
  await raw('urn:ex:op/test/c1-stale', `DELETE WHERE { <${iri}/attachment/0> <https://schema.org/name> ?n }`);
  await raw('urn:ex:op/test/c1-stale2', `INSERT DATA { <${iri}/attachment/0> <https://schema.org/name> "stale.txt" . <${iri}/attachment/1> <https://scrumboard.local/ns#attachmentOf> <${iri}> ; <https://schema.org/name> "extra.txt" . }`);
  const names = async () => (await g.query(`SELECT ?a ?n WHERE { ?a <https://scrumboard.local/ns#attachmentOf> <${iri}> . OPTIONAL { ?a <https://schema.org/name> ?n } }`)).rows.map((r) => `${r.a.value.slice(iri.length)}=${r.n?.value ?? '-'}`).sort();
  assert.deepEqual(await names(), ['/attachment/0=stale.txt', '/attachment/1=extra.txt'], 'PRECONDITION: the stale and extra facts are in the graph');

  const dry = await run(['--executor', x.baseUrl, '--dataset', DS]);
  assert.match(dry.out, /1 need attachment nodes/, `the dry run sees the card as differing (${dry.out})`);
  const apply = await run(['--executor', x.baseUrl, '--dataset', DS, '--apply']);
  assert.equal(apply.status, 0, apply.err);
  assert.match(apply.out, /reprojected 1/, apply.out);
  assert.deepEqual(await names(), ['/attachment/0=expected.txt'], 'exactly the projected attachment: the stale name and the extra node are gone');
  const again = await run(['--executor', x.baseUrl, '--dataset', DS, '--apply']);
  assert.match(again.out, /reprojected 0, already current 1/, `a re-run writes nothing (${again.out})`);
});
