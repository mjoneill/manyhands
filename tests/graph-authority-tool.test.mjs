/**
 * #1558 — the resident `graph_authority` tool: it reaches the shared resolver
 * route, and a failed read comes back as UNAVAILABLE, never as an exception the
 * model narrates over and never as an empty answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_TOOLS, toolsFor, makeExecutor } from '../core/board-tools.mjs';

const ARGS = { topic: 'urn:ex:topic1', predicate: 'urn:ex:policy', scope: 'urn:ex:scopeX' };

test('#1558 graph_authority is a tool only for an agent granted it (no grant, no tool)', () => {
  assert.ok(BOARD_TOOLS.some((t) => t.function.name === 'graph_authority'));
  assert.ok(!toolsFor({ toolGrants: ['graph_query'] }).some((t) => t.function.name === 'graph_authority'));
  assert.ok(toolsFor({ toolGrants: ['graph_authority'] }).some((t) => t.function.name === 'graph_authority'));
});

test('#1558 graph_authority asks the shared resolver route and returns its envelope unaltered', async () => {
  const seen = [];
  const envelope = { status: 'CURRENT', governing: { iri: 'urn:ex:N1' } };
  const exec = makeExecutor({ get: async (p) => { seen.push(p); return envelope; }, post: async () => ({}) });
  assert.deepEqual(await exec('graph_authority', ARGS), envelope);
  assert.equal(seen.length, 1);
  const u = new URL(seen[0], 'http://x');
  assert.equal(u.pathname, '/api/graph/authority');
  assert.equal(u.searchParams.get('topic'), ARGS.topic);
  assert.equal(u.searchParams.get('predicate'), ARGS.predicate);
  assert.equal(u.searchParams.get('scope'), ARGS.scope);
});

test('#1558 graph_authority: a failed read is UNAVAILABLE, not a thrown error and not empty', async () => {
  const exec = makeExecutor({ get: async (p) => { throw new Error(`GET ${p} → 503`); }, post: async () => ({}) });
  const r = await exec('graph_authority', ARGS);
  assert.equal(r.status, 'UNAVAILABLE');
  assert.match(r.note, /NOT "nothing governs it"/);
});

test('#1558 graph_authority refuses a call missing topic, predicate or scope', async () => {
  const exec = makeExecutor({ get: async () => ({}), post: async () => ({}) });
  for (const k of Object.keys(ARGS)) {
    const a = { ...ARGS }; delete a[k];
    await assert.rejects(exec('graph_authority', a), new RegExp(`needs a ${k}`));
  }
});
