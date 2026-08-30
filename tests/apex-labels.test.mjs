/**
 * #902 item 4 — the WRITE-TIME GUARD: a card that gains a parent under an apex
 * gains the apex's label, so the litmus test's invariant (reachable ⇒
 * labelled) stays true by construction instead of by a nightly hand-pass.
 *
 * The apex declares its label with `apex:<label>` on itself (approved shape,
 * 2026-08-30). The rule is APPLY, additive, reparent-preserves — each of which
 * is a test below, including the two that keep the guard from over-reaching:
 * the parent's OTHER labels are not inherited, and moving out does not strip.
 *
 * Verified at the GRAPH where it matters (#917's lesson: a 200 and an echoed
 * field prove nothing about traversal), and through the REST surface a seat
 * actually reaches — card PATCH, card CREATE with parent, and the /api/nodes
 * PATCH — because the guard lives on every path that writes `parent`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apexLabelsAbove, applyApexLabels, descendantIds } from '../core/apex-labels.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const c = (id, parent = null, labels = []) => ({ id, parent, labels, title: id });

// ── the pure half ──────────────────────────────────────────────────────────

test('#902 apexLabelsAbove walks EVERY ancestor and collects each apex:<label>', () => {
  const cards = [c('apex', null, ['apex:manyhands', 'north-star']), c('mid', 'apex', ['phase']), c('leaf', 'mid')];
  assert.deepEqual([...apexLabelsAbove(cards, 'mid')], ['manyhands']);
  assert.deepEqual([...apexLabelsAbove(cards, 'apex')], ['manyhands']);
  assert.deepEqual([...apexLabelsAbove(cards, null)], []);
  assert.deepEqual([...apexLabelsAbove(cards, 'nope')], [], 'an unknown parent applies nothing');
});

test('#902 ⛔ the parent\'s OTHER labels are NOT inherited — only apex:<label> applies', () => {
  const cards = [c('apex', null, ['apex:manyhands', 'bug', 'p1']), c('kid', 'apex')];
  assert.deepEqual(applyApexLabels(cards, 'kid'), [{ id: 'kid', added: ['manyhands'] }]);
  assert.deepEqual(cards[1].labels, ['manyhands'], 'bug and p1 must not leak down');
});

test('#902 applying is ADDITIVE and idempotent — existing labels kept, no duplicates, no change reported twice', () => {
  const cards = [c('apex', null, ['apex:manyhands']), c('kid', 'apex', ['storage'])];
  assert.deepEqual(applyApexLabels(cards, 'kid'), [{ id: 'kid', added: ['manyhands'] }]);
  assert.deepEqual(cards[1].labels, ['storage', 'manyhands']);
  assert.deepEqual(applyApexLabels(cards, 'kid'), [], 'second application changes nothing');
});

test('#902 a moved SUBTREE is labelled all the way down', () => {
  const cards = [c('apex', null, ['apex:manyhands']), c('top', 'apex'), c('mid', 'top'), c('leaf', 'mid')];
  assert.deepEqual(descendantIds(cards, 'top').sort(), ['leaf', 'mid']);
  const changed = applyApexLabels(cards, 'top').map((x) => x.id).sort();
  assert.deepEqual(changed, ['leaf', 'mid', 'top']);
});

test('#902 two apexes stack; a cycle upstream terminates', () => {
  const cards = [c('a', null, ['apex:alpha']), c('b', 'a', ['apex:beta']), c('kid', 'b')];
  assert.deepEqual([...apexLabelsAbove(cards, 'b')].sort(), ['alpha', 'beta']);
  const loop = [c('x', 'y', ['apex:x']), c('y', 'x')];
  assert.deepEqual([...apexLabelsAbove(loop, 'x')], ['x'], 'a pre-existing cycle must not hang the walk');
});

// ── the wired half: every path that writes `parent` ────────────────────────

async function api(baseUrl, method, p, body) {
  const res = await fetch(`${baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function withApex(fn) {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const apex = (await api(s.baseUrl, 'POST', '/api/cards', { title: 'THE APEX', labels: ['apex:manyhands', 'north-star'], createdBy: 'ada' })).body;
    await fn(s.baseUrl, apex);
  } finally { await s.stop(); }
}
const labelsOf = async (baseUrl, id) => (await api(baseUrl, 'GET', `/api/cards/${id}`)).body.labels;
/** The litmus test itself, over the graph: is `id` reachable from the apex, and does it carry the label? */
async function graphSays(baseUrl, apexId, shortId) {
  const q = `SELECT ?reach ?lab WHERE { ?c schema:identifier "${shortId}" . BIND(EXISTS { ?c schema:isPartOf+ entity:${apexId} } AS ?reach) BIND(EXISTS { ?c scrum:label "manyhands" } AS ?lab) }`;
  const r = await api(baseUrl, 'POST', '/api/graph', { query: q, by: 'test' });
  return r.body.rows[0];
}

test('#902 ⛔ THE ACCEPTANCE: card PATCH parent ⇒ the child carries the apex label, and the GRAPH agrees', async () => {
  await withApex(async (baseUrl, apex) => {
    const kid = (await api(baseUrl, 'POST', '/api/cards', { title: 'a member', labels: ['storage'], createdBy: 'ada' })).body;
    assert.deepEqual(kid.labels, ['storage']);
    const r = await api(baseUrl, 'PATCH', `/api/cards/${kid.id}`, { parent: apex.id, by: 'ada' });
    assert.equal(r.status, 200);
    assert.deepEqual(await labelsOf(baseUrl, kid.id), ['storage', 'manyhands'], 'additive: storage kept, manyhands applied');
    const g = await graphSays(baseUrl, apex.id, kid.shortId);
    assert.equal(String(g.reach), 'true', 'reachable from the apex');
    assert.equal(String(g.lab), 'true', 'reachable ⇒ labelled — the invariant holds at write time');
  });
});

test('#902 CREATE with a parent under the apex is born labelled — never a moment unlabelled', async () => {
  await withApex(async (baseUrl, apex) => {
    const kid = (await api(baseUrl, 'POST', '/api/cards', { title: 'born nested', parent: apex.id, createdBy: 'ada' })).body;
    assert.ok(kid.labels.includes('manyhands'), `got ${JSON.stringify(kid.labels)}`);
  });
});

test('#902 the /api/nodes PATCH path (wiki reparent, drag-drop) applies it too', async () => {
  await withApex(async (baseUrl, apex) => {
    const kid = (await api(baseUrl, 'POST', '/api/cards', { title: 'a page', createdBy: 'ada' })).body;
    const r = await api(baseUrl, 'PATCH', `/api/nodes/${kid.shortId}`, { parent: apex.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok((await labelsOf(baseUrl, kid.id)).includes('manyhands'));
  });
});

test('#902 REPARENT PRESERVES: moving a card OUT from under the apex keeps its label (edge says where, label says what)', async () => {
  await withApex(async (baseUrl, apex) => {
    const other = (await api(baseUrl, 'POST', '/api/cards', { title: 'elsewhere', createdBy: 'ada' })).body;
    const kid = (await api(baseUrl, 'POST', '/api/cards', { title: 'mover', parent: apex.id, createdBy: 'ada' })).body;
    assert.ok(kid.labels.includes('manyhands'));
    await api(baseUrl, 'PATCH', `/api/cards/${kid.id}`, { parent: other.id, by: 'ada' });
    assert.ok((await labelsOf(baseUrl, kid.id)).includes('manyhands'), 'the label is never removed by the guard');
    await api(baseUrl, 'PATCH', `/api/cards/${kid.id}`, { parent: null, by: 'ada' });
    assert.ok((await labelsOf(baseUrl, kid.id)).includes('manyhands'));
  });
});

test('#902 a grandchild through a NON-apex middle card is still labelled — the walk is transitive', async () => {
  await withApex(async (baseUrl, apex) => {
    const mid = (await api(baseUrl, 'POST', '/api/cards', { title: 'phase', parent: apex.id, createdBy: 'ada' })).body;
    const leaf = (await api(baseUrl, 'POST', '/api/cards', { title: 'leaf', createdBy: 'ada' })).body;
    await api(baseUrl, 'PATCH', `/api/cards/${leaf.id}`, { parent: mid.id, by: 'ada' });
    assert.ok((await labelsOf(baseUrl, leaf.id)).includes('manyhands'));
  });
});

test('#902 ⛔ NEGATIVE CONTROL: nesting under a NON-apex applies nothing — the guard discriminates', async () => {
  await withApex(async (baseUrl) => {
    const plain = (await api(baseUrl, 'POST', '/api/cards', { title: 'plain parent', labels: ['bug'], createdBy: 'ada' })).body;
    const kid = (await api(baseUrl, 'POST', '/api/cards', { title: 'kid', createdBy: 'ada' })).body;
    await api(baseUrl, 'PATCH', `/api/cards/${kid.id}`, { parent: plain.id, by: 'ada' });
    assert.deepEqual(await labelsOf(baseUrl, kid.id), [], 'no apex above ⇒ nothing applied, and bug does not leak');
  });
});
