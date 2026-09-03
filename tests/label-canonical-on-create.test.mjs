/**
 * #1050 — A CARD IS BORN ON THE CANONICAL LABEL.
 *
 * The project has SEVEN spellings of itself (re-counted 2026-09-03: manyhands
 * 331, building scrum board 233, building-scrum-board 41, scrum-board 9,
 * scrum-board-presence 4, building-scrum board 1, apex:manyhands 1). Two of
 * those are NEW since 2026-08-24 — the tail is still generating variants while
 * everyone is being careful, which is the argument for closing the write path
 * rather than running another convergence pass that will be re-run.
 *
 * ⭐⭐⭐ WHY THIS RESOLVES THROUGH THE DECLARED ALIAS MAP AND NOT THROUGH
 * NORMALISATION — the whole design turns on this.
 *
 * #857 built the alias mechanism and then deliberately REFUSED to auto-merge:
 *
 *     "Normalisation SURFACES candidates; a seat DECLARES the merge. Two labels
 *      that normalise alike are not necessarily one concept, and a system that
 *      silently fused them would be making an unfalsifiable judgement at write
 *      time — the thing the room refused."
 *
 * A create-time rule that normalised-and-merged would reverse that decision
 * without anyone deciding to. So this rule makes NO vocabulary judgement in
 * code: it applies the map a seat already declared, and nothing else. A
 * spelling nobody has declared is left exactly as sent, even when it obviously
 * normalises onto a canonical one — that refusal is pinned by a test below,
 * because it is the property most likely to be "helpfully" removed later.
 *
 * ⇒ The consequence, and it is the point: the rule is DATA, not code. Today the
 * declared map says `building-scrum-board → building scrum board`, which
 * canonicalises onto the DEPRECATED token and contradicts the 08-24
 * ruling (decision 681628ca: the project is `manyhands`). Fixing that is the
 * owner half of #1050 and is NOT this card. When it is fixed, this rule starts
 * producing `manyhands` with no code change at all.
 *
 * ⛔ CREATE ONLY. PATCH is untouched, on purpose. Whether the existing 233
 * `building scrum board` cards should collapse into `manyhands` is unresolved —
 * some of them may genuinely mean the production instance, which the ruling explicitly preserves as a distinct thing. A rule that rewrote labels on
 * every update would decide that question silently, on cards nobody was editing
 * for that reason.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const card = (shortId, labels) => ({
  id: `u-${shortId}`, shortId, title: `card ${shortId}`, description: '',
  type: 'task', labels, assignees: [], column: 'backlog', order: shortId,
  createdAt: '2026-08-01T00:00:00.000Z', relationships: {},
});

// The alias rows are DECLARED state, exactly as `POST /api/labels/aliases`
// writes them. `scrum-board` is deliberately NOT declared: it is the control.
const board = () => makeBoardFixture({
  cards: [card(1, ['manyhands']), card(2, ['building-scrum-board'])],
  nextShortId: 3,
  labelAliases: [
    { alias: 'building-scrum-board', canonical: 'manyhands' },
    { alias: 'building-scrum board', canonical: 'manyhands' },
  ],
});

const api = async (baseUrl, method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
};

test('#1050 a card created with a DECLARED alias is born carrying the canonical', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const r = await api(s.baseUrl, 'POST', '/api/cards',
      { title: 'a new card', labels: ['building-scrum-board'], createdBy: 'ada' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.labels, ['manyhands'],
      'the alias must not survive the write — a card born non-canonical is the thing this closes');

    // ⛔ Read it BACK. A response that reports the canonical while the board
    // stored the alias is the shape a response-only assertion cannot see.
    const got = await api(s.baseUrl, 'GET', `/api/cards/${r.body.shortId}`);
    assert.deepEqual(got.body.labels, ['manyhands'], 'stored, not just reported');
  } finally { await s.stop(); }
});

test('#1050 ⛔ NEGATIVE CONTROL — an UNDECLARED spelling is left EXACTLY as sent', async () => {
  const s = await startRestServer({ board: board() });
  try {
    // `scrum-board` normalises onto nothing in the map. It is one hyphen away
    // from two declared aliases and a human would "obviously" merge it.
    const r = await api(s.baseUrl, 'POST', '/api/cards',
      { title: 'undeclared spelling', labels: ['scrum-board'], createdBy: 'ada' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.labels, ['scrum-board'],
      '#857: normalisation SURFACES candidates, a seat DECLARES the merge. '
      + 'If this ever returns "manyhands", the rule has started making vocabulary '
      + 'judgements at write time and #857 was reversed by accident.');
  } finally { await s.stop(); }
});

test('#1050 ⛔ NEGATIVE CONTROL — PATCH does NOT canonicalise; this is a CREATE-surface rule', async () => {
  const s = await startRestServer({ board: board() });
  try {
    // Card 2 already carries the alias. Updating it must not rewrite the label:
    // whether the existing population collapses is the unresolved owner half.
    const r = await api(s.baseUrl, 'PATCH', '/api/cards/2',
      { labels: ['building-scrum-board'], by: 'ada' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.labels, ['building-scrum-board'],
      'a PATCH that silently relabelled would decide the 233-card question on '
      + 'cards nobody was editing for that reason');
  } finally { await s.stop(); }
});

test('#1050 resolving an alias onto a label the card ALREADY carries yields ONE label, not two', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const r = await api(s.baseUrl, 'POST', '/api/cards', {
      title: 'both spellings at once',
      labels: ['manyhands', 'building-scrum-board', 'bug'],
      createdBy: 'ada',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    // ⚠️ The duplicate is created BY the resolution, so a rule that resolves
    // without de-duplicating ships a card carrying the same label twice — and
    // every count built on labels then double-counts it.
    assert.deepEqual(r.body.labels, ['manyhands', 'bug'],
      'one canonical, order otherwise preserved, unrelated labels untouched');
  } finally { await s.stop(); }
});

test('#1050 a card created with NO labels, or already canonical, is unchanged', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const none = await api(s.baseUrl, 'POST', '/api/cards',
      { title: 'no labels', createdBy: 'ada' });
    assert.equal(none.status, 201, JSON.stringify(none.body));
    assert.deepEqual(none.body.labels, [], 'absence stays absence');

    const already = await api(s.baseUrl, 'POST', '/api/cards',
      { title: 'already canonical', labels: ['manyhands'], createdBy: 'ada' });
    assert.deepEqual(already.body.labels, ['manyhands'], 'idempotent');
  } finally { await s.stop(); }
});
