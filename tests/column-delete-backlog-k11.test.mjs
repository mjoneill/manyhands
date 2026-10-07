/**
 * #1598 / the board page (K11): WHERE A DELETED COLUMN'S CARDS GO, as the board owner decided it (2026-10-06 22:11Z): to BACKLOG, and if Backlog itself is deleted, to the first remaining column. This replaces the four page-level rows that pinned the page's old
 * behaviour (a deleted column's cards moved to an "Orphanage" column the page created, with a `sent-to-orphanage` label and a `previousColumn` field): the page now deletes through `DELETE /api/columns/:id`, which never creates such a column, so those rows
 * describe behaviour that is gone and are retired with it. This file pins the decision itself, on the server route, so the rule is a test and not a sentence in a commit message. A REAL REST server, no executor, no browser, synthetic content.
 *
 *   D1  A COLUMN WITH CARDS IS DELETED: every card it held is now in `backlog`, none is lost, the column is gone from the column list, and no `orphanage` column was created.
 *   D2  BACKLOG ITSELF IS DELETED while it holds cards and another column exists: its cards go to the FIRST REMAINING column (the order of the column list), none lost.
 *   D3  AN EMPTY COLUMN is deleted: it is gone, nothing else moved, no `orphanage` column appears.
 *   D4  THE RULE IS "BACKLOG", NOT "THE FIRST COLUMN": with another column ordered AHEAD of backlog, a deleted column's cards still go to backlog. (On a board where backlog is first the two rules are the same, which is why D1 alone cannot tell the owner's decision from the server's older
 *       one; a mutant that sends cards to the first column survived D1 to D3 until this row.)
 *
 * NOT COVERED, by name: the position of the re-homed cards within the destination column (their order numbers are not pinned); deleting the last remaining column; cards' labels (no label is added: not asserted either way beyond "not lost"); a column delete racing a card write; the page's own confirmation and wording (the browser rows).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';

const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const ALNUM = () => `${process.pid}x${Date.now().toString(36)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const columns = async (base) => { const r = (await api(base, 'GET', '/api/columns')).body; return Array.isArray(r) ? r : (r.columns ?? []); };
const cardsOf = async (base, tag) => { const r = (await api(base, 'GET', '/api/cards?limit=500')).body; return (Array.isArray(r) ? r : r.cards).filter((c) => String(c.title).startsWith(tag)); };
const mkCard = async (base, title, column) => { const r = await api(base, 'POST', '/api/cards', { title, description: 'x', createdBy: 'ada', column }); assert.equal(r.status, 201, `a card is created in ${column} (${r.status} ${r.text.slice(0, 100)})`); return r.body; };
const mkColumn = async (base, name) => { const r = await api(base, 'POST', '/api/columns', { name }); assert.ok(r.status < 300, `a column is created (${r.status} ${r.text.slice(0, 100)})`); return r.body.id ?? r.body.column?.id; };

test('D1 A COLUMN WITH CARDS IS DELETED: its cards go to backlog, none is lost, no orphanage column appears', { timeout: 120000 }, async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const tag = ALNUM(); const col = await mkColumn(s.baseUrl, `${tag} temp`);
    const a = await mkCard(s.baseUrl, `${tag} a`, col); const b = await mkCard(s.baseUrl, `${tag} b`, col); const keep = await mkCard(s.baseUrl, `${tag} stays`, 'planned');
    const del = await api(s.baseUrl, 'DELETE', `/api/columns/${col}`); assert.ok(del.status < 300, `the delete is accepted (${del.status} ${del.text.slice(0, 120)})`);
    const after = await cardsOf(s.baseUrl, tag); assert.equal(after.length, 3, 'no card is lost');
    for (const c of [a, b]) assert.equal(after.find((x) => x.id === c.id).column, 'backlog', `${c.title} is in backlog`);
    assert.equal(after.find((x) => x.id === keep.id).column, 'planned', 'a card in another column did not move');
    const cols = await columns(s.baseUrl); assert.ok(!cols.some((c) => c.id === col), 'the deleted column is gone'); assert.ok(!cols.some((c) => /orphan/i.test(`${c.id} ${c.name}`)), 'and no orphanage column was created');
  } finally { await s.stop(); }
});

test('D2 BACKLOG ITSELF IS DELETED: its cards go to the first remaining column', { timeout: 120000 }, async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const tag = ALNUM(); const a = await mkCard(s.baseUrl, `${tag} a`, 'backlog'); const b = await mkCard(s.baseUrl, `${tag} b`, 'backlog');
    const before = await columns(s.baseUrl); const first = before.filter((c) => c.id !== 'backlog').sort((x, y) => x.order - y.order)[0];
    assert.ok(first, 'CONTROL: another column exists'); const del = await api(s.baseUrl, 'DELETE', '/api/columns/backlog'); assert.ok(del.status < 300, `backlog can be deleted (${del.status} ${del.text.slice(0, 120)})`);
    const after = await cardsOf(s.baseUrl, tag); assert.equal(after.length, 2, 'no card is lost');
    for (const c of [a, b]) assert.equal(after.find((x) => x.id === c.id).column, first.id, `${c.title} is in the first remaining column (${first.id})`);
    assert.ok(!(await columns(s.baseUrl)).some((c) => /orphan/i.test(`${c.id} ${c.name}`)), 'and no orphanage column was created');
  } finally { await s.stop(); }
});

test('D3 AN EMPTY COLUMN IS DELETED: it is gone, nothing else moves, no orphanage column appears', { timeout: 120000 }, async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const tag = ALNUM(); const col = await mkColumn(s.baseUrl, `${tag} empty`); const c = await mkCard(s.baseUrl, `${tag} stays`, 'planned');
    const del = await api(s.baseUrl, 'DELETE', `/api/columns/${col}`); assert.ok(del.status < 300, `the delete is accepted (${del.status})`);
    assert.equal((await cardsOf(s.baseUrl, tag)).find((x) => x.id === c.id).column, 'planned', 'a card elsewhere did not move');
    const cols = await columns(s.baseUrl); assert.ok(!cols.some((x) => x.id === col), 'the column is gone'); assert.ok(!cols.some((x) => /orphan/i.test(`${x.id} ${x.name}`)), 'and no orphanage column appears');
  } finally { await s.stop(); }
});

test('D4 THE RULE IS BACKLOG, NOT THE FIRST COLUMN: with another column ahead of backlog, a deleted column\'s cards still go to backlog', { timeout: 120000 }, async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const tag = ALNUM(); const before = await columns(s.baseUrl); const low = Math.min(...before.map((c) => Number(c.order)));
    const mv = await api(s.baseUrl, 'PATCH', '/api/columns/planned', { order: low - 1 }); assert.ok(mv.status < 300, `PRECONDITION: planned is moved ahead of backlog (${mv.status} ${mv.text.slice(0, 120)})`);
    const ordered = (await columns(s.baseUrl)).sort((a, b) => Number(a.order) - Number(b.order)); assert.equal(ordered[0].id, 'planned', `PRECONDITION: the first column is now planned, not backlog (${JSON.stringify(ordered.map((c) => c.id))})`);
    const col = await mkColumn(s.baseUrl, `${tag} temp`); const a = await mkCard(s.baseUrl, `${tag} a`, col);
    const del = await api(s.baseUrl, 'DELETE', `/api/columns/${col}`); assert.ok(del.status < 300, `the delete is accepted (${del.status})`);
    assert.equal((await cardsOf(s.baseUrl, tag)).find((x) => x.id === a.id).column, 'backlog', 'the card went to BACKLOG, though planned is now the first column');
  } finally { await s.stop(); }
});
