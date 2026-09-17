/**
 * #1405 — a server-side FOLD read (decisions, seat declarations, memories)
 * sees every row or refuses; it never answers short.
 *
 * The public queryGraph caps every query at LIMIT_CEILING (1,000 rows) and
 * confesses the cut in `truncated` — a field a fold never reads. On
 * 2026-09-17 the memory list returned 128 of 395 that way (a prod copy; fixed
 * in ffd0b89 with queryGraphAll), and the decisions reader had the same
 * shape: a cap of 20,000 against a ceiling of 1,000, silently short past
 * ~72 decisions. Sabotage: route liveDecisions back through queryGraph ⇒
 * "every decision, not the first thousand rows' worth" red at ~70.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const json = async (r) => ({ status: r.status, body: await r.json() });
const get = (base, path) => fetch(`${base}${path}`).then(json);
const LEGACY = (n) => ({
  '@id': `https://scrumboard.local/decision/00000000-0000-4000-8000-${String(200000 + n).padStart(12, '0')}`, '@type': 'scrum:Decision',
  identifier: `00000000-0000-4000-8000-${String(200000 + n).padStart(12, '0')}`,
  'scrum:statement': `ruling ${n}`, 'scrum:decidedBy': 'ada',
  'scrum:constrains': [`topic-${n}`, `topic-${n + 1}`, `topic-${n + 2}`, 'shared', 'wide'],   // 5 constrains ⇒ ~11 rows per decision
  'scrum:reopensIf': `evidence ${n}`, dateCreated: `2026-08-01T00:${String(n % 60).padStart(2, '0')}:00.000Z`,
});

test('#1405 GET /api/decisions returns EVERY decision — 160 of them, ~1,800 rows, past the public read\'s 1,000-row ceiling', async () => {
  const decisions = Array.from({ length: 160 }, (_, i) => LEGACY(i));
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], decisions }) });
  try {
    const count = await fetch(`${s.baseUrl}/api/graph`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'SELECT (COUNT(*) AS ?n) WHERE { ?d a scrum:Decision ; ?p ?o }' }) }).then(json);
    assert.ok(Number(count.body.rows[0].n) > 1000, `the fixture must exceed the ceiling to mean anything: ${count.body.rows[0].n} rows`);
    const l = await get(s.baseUrl, '/api/decisions');
    assert.equal(l.status, 200, JSON.stringify(l.body).slice(0, 200));
    const list = Array.isArray(l.body) ? l.body : l.body.decisions;
    assert.equal(list.length, 160, `every decision, not the first thousand rows' worth: ${list.length}`);
    assert.ok(list.every((d) => d.constrains.length === 5), 'and every decision is whole — no constrains lost mid-node');
  } finally { await s.stop(); }
});
