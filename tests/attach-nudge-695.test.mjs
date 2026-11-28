/**
 * #695 — a post that names exactly one card and attaches to nothing is almost
 * certainly misfiled. The write path says so in its answer: "this names #N
 * only; attach it?" It never blocks and never attaches.
 *
 * Measured on the live board 2026-11-28 00:22Z: two seats, 26 and 17 posts
 * since 10:00Z, 5 and 0 of them attached. Board-wide on 2026-08-12: 13,907
 * floating posts, 2,974 naming exactly one real card, 10,933 naming several
 * or none.
 *
 * ⭐ THE PRECISION OF THE TRIGGER IS THE WHOLE FEATURE (the card's words).
 * Those 10,933 posts are correctly floating; a nudge that fires on them
 * trains the reflex to ignore it. So every silent row here carries a CONTROL
 * — the same body with exactly one real reference DOES nudge — because a
 * nudge that never fires passes every silence test written for it.
 *
 * Acceptance, verbatim from the card:
 *   - one #NNN + attachedTo:null → nudge names the card
 *   - two or more #NNN → SILENT (control: the same body with one reference nudges)
 *   - zero #NNN → silent
 *   - #NNN that resolves to no card → silent (a card number in prose is not a reference)
 *   - attachedTo already set → silent
 *   - nudging never blocks the post
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachNudge } from '../core/attach-nudge.mjs';
import { startRestServer, spawnBoardServer, makeBoardFixture } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

// ── the rule, as a pure function ─────────────────────────────────────────

const CARDS = [
  { id: 'uuid-a', shortId: 12 },
  { id: 'uuid-b', shortId: 345 },
];

test('#695 unit: one real #NNN with nothing attached → the nudge names that card', () => {
  const n = attachNudge({ body: 'Stopped building on #345: tests green.', attachedTo: null, cards: CARDS });
  assert.ok(n, 'a single-card floating post is nudged');
  assert.equal(n.card, 345);
  assert.equal(n.cardId, 'uuid-b');
  assert.match(n.hint, /#345/, 'the hint names the card a reader would attach to');
});

test('#695 unit: two different real cards → silent, and the one-reference control nudges', () => {
  assert.equal(attachNudge({ body: 'compare #12 with #345', attachedTo: null, cards: CARDS }), null);
  assert.ok(attachNudge({ body: 'compare #12 with nothing', attachedTo: null, cards: CARDS }), 'control: one reference nudges');
});

test('#695 unit: one real card plus a number naming no card → silent (two #NNN is two, however many resolve)', () => {
  // The card's rows read "two or more #NNN → SILENT" and "a #NNN naming no card is not a reference".
  // Where they meet, the quieter reading wins: precision is the feature, and a post that names
  // two numbers is commons-shaped whatever the second one turns out to be.
  assert.equal(attachNudge({ body: 'see #12 and #99999', attachedTo: null, cards: CARDS }), null);
  assert.ok(attachNudge({ body: 'see #12 and 99999', attachedTo: null, cards: CARDS }), 'control: without the second # it nudges');
});

test('#695 unit: the same card named twice is still one card → nudges', () => {
  const n = attachNudge({ body: '#345 is done. Next after #345: nothing.', attachedTo: null, cards: CARDS });
  assert.equal(n?.card, 345);
});

test('#695 unit: zero #NNN → silent', () => {
  assert.equal(attachNudge({ body: 'a quiet evening, nothing to report', attachedTo: null, cards: CARDS }), null);
  assert.ok(attachNudge({ body: 'a quiet evening, nothing to report on #12', attachedTo: null, cards: CARDS }), 'control');
});

test('#695 unit: a #NNN that resolves to no card → silent; the control with a real number nudges', () => {
  assert.equal(attachNudge({ body: 'we were #1 on the list', attachedTo: null, cards: CARDS }), null);
  assert.ok(attachNudge({ body: 'we were #12 on the list', attachedTo: null, cards: CARDS }), 'control');
});

test('#695 unit: a # inside a word or an HTML entity is not a reference (the renderer\'s own rule)', () => {
  // core/render.mjs links `#NNN` only where it is not preceded by a word character, `&` or `;`.
  // The nudge must agree with what a reader sees as a card link, or it nudges posts that show none.
  assert.equal(attachNudge({ body: 'issue abc#12 upstream', attachedTo: null, cards: CARDS }), null);
  assert.equal(attachNudge({ body: 'it&#12;s fine', attachedTo: null, cards: CARDS }), null);
  assert.ok(attachNudge({ body: 'issue abc #12 upstream', attachedTo: null, cards: CARDS }), 'control: a word boundary before # nudges');
});

test('#695 unit: attachedTo already set → silent, even when the body names a different card', () => {
  assert.equal(attachNudge({ body: 'about #345', attachedTo: 'uuid-a', cards: CARDS }), null);
  assert.equal(attachNudge({ body: 'about #345', attachedTo: 'uuid-b', cards: CARDS }), null);
  assert.ok(attachNudge({ body: 'about #345', attachedTo: null, cards: CARDS }), 'control: the same body unattached nudges');
});

// ── the REST write path, document store ──────────────────────────────────

const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const post = (base, body) => fetch(`${base}/api/conversations`, json(body));
const newCard = async (base, title) => (await (await fetch(`${base}/api/cards`, json({ title, createdBy: 'ada' }))).json());

test('#695 REST (document store): the answer carries the nudge, the post is stored unattached, and nothing is blocked', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  try {
    const card = await newCard(srv.baseUrl, 'the card a post forgot');
    const other = await newCard(srv.baseUrl, 'a second card');

    const one = await post(srv.baseUrl, { author: 'ada', body: `progress on #${card.shortId}` });
    assert.equal(one.status, 201, 'never blocks');
    const b1 = await one.json();
    assert.equal(b1.attachNudge?.card, card.shortId, 'the nudge names the card');
    assert.equal(b1.attachNudge?.cardId, card.id);
    assert.equal(b1.attachedTo ?? null, null, 'never auto-attaches');

    const two = await (await post(srv.baseUrl, { author: 'ada', body: `progress on #${card.shortId} and #${other.shortId}` })).json();
    assert.equal(two.attachNudge, undefined, 'two cards → silent');

    const none = await (await post(srv.baseUrl, { author: 'ada', body: 'nothing about any card' })).json();
    assert.equal(none.attachNudge, undefined, 'zero cards → silent');

    const attached = await (await post(srv.baseUrl, { author: 'ada', body: `progress on #${card.shortId}`, attachedTo: card.id })).json();
    assert.equal(attached.attachNudge, undefined, 'already attached → silent');

    // The nudge is advice in the ANSWER, never part of the stored post.
    const all = await (await fetch(`${srv.baseUrl}/api/conversations`)).json();
    const list = Array.isArray(all) ? all : all.conversations;
    assert.equal(list.length, 4, 'every post was written');
    assert.ok(list.every((c) => !('attachNudge' in c)), 'no stored post carries the nudge');
  } finally { await srv.stop(); }
});

// ── the REST write path, graph store (the path production runs) ──────────

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'attach-nudge-695';

test('#695 REST (graph store): the same nudge on the graph post path, and the two-card control stays silent', { skip: SKIP }, async () => {
  const store = tmpStore('an695-store-');
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'an695-'));
  const file = path.join(dir, 'board.json');
  fs.writeFileSync(file, JSON.stringify(makeBoardFixture({ cards: [], conversations: [] }), null, 2));
  const srv = await spawnBoardServer({
    readyTimeoutMs: 15000, label: 'attach-nudge-695 server',
    env: (port) => ({ ...process.env, SCRUM_BOARD_FILE: file, SCRUM_MCP_NOTIFY_URL: '',
      SCRUM_ATTACHMENTS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'an695-att-')),
      SCRUM_CHANNEL_CONFIG_FILE: path.join(os.tmpdir(), `an695-chan-${process.pid}-${port}.json`),
      SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' }),
  });
  try {
    const card = await newCard(srv.baseUrl, 'graph card');
    const other = await newCard(srv.baseUrl, 'graph card two');
    const one = await post(srv.baseUrl, { author: 'ada', body: `done with #${card.shortId}` });
    assert.equal(one.status, 201, `never blocks: ${await one.clone().text()}`);
    const b1 = await one.json();
    assert.equal(b1.attachNudge?.card, card.shortId, 'the graph path nudges too');
    assert.equal(b1.attachedTo ?? null, null, 'never auto-attaches');
    const two = await (await post(srv.baseUrl, { author: 'ada', body: `done with #${card.shortId} and #${other.shortId}` })).json();
    assert.equal(two.attachNudge, undefined, 'two cards → silent on the graph path');
  } finally { srv.stop(); await killExecutor(exec); }
});
