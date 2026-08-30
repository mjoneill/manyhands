/**
 * #880/#857 §VI — STANDING CHECKS: corpus-scale claims nobody authored a tripwire for.
 *
 * ⚰️ THE GAP. #792's tripwires are PER-CARD and AUTHORED: a seat writes a claim
 * and the query that would falsify it. That mechanism cannot see a claim held by
 * an EDGE, and it cannot see a claim nobody thought to write down.
 *
 *     `#439 blockedBy #438`  and  `#438 is done`
 *
 * Both facts are true, structural, and stored. Together they say the board is
 * asserting a block that cannot block anything. Nobody wrote that claim, so no
 * tripwire watches it, and nothing changed on #439 when #438 shipped — no diff,
 * no review, no trigger. G1 by growth, at the edge rather than the card.
 *
 * ⛔ MEASURED, AND THIS IS WHY IT IS A QUERY AND NOT A HABIT. A careful manual
 * tidy pass on 2026-08-18 found FOUR phantom blocks and cleared them. The query
 * below, run twenty minutes later, found FIVE MORE it had missed:
 *
 *     cleared by hand   #439←#438  #740←#735  #804←#805  #200←#197
 *     missed by hand    #809←#815  #687←#686  #687←#685  #212←#215  #91←#90
 *
 * ⇒ ⭐ 4 of 9. Not carelessness — nine pairs across 795 cards is not a thing a
 * person reads their way to, and the person doing it was the room's most careful
 * seat on the day she was specifically looking for exactly this.
 *
 * ── THE DESIGN CONSTRAINT, INHERITED FROM #824 AND LOAD-BEARING ────────────
 *
 * #824: "a rule that always fires trains the room to dismiss the instrument
 * inside a week, taking the working rules down with it."
 *
 * ⇒ So a standing check must be TIER-A shaped: both facts structural, the
 * finding unambiguous, and actionable by one write. "This card looks stale" is
 * not that. "This card declares a block on a card that is done" is.
 *
 * ⚠️ AND IT MUST NOT BE AN ACCUSATION. A phantom block is evidence that nobody
 * cleared an edge, never that anyone did anything wrong — the edge was TRUE when
 * it was written. The payload says what it found, not what it means.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

const mk = (baseUrl, body) => fetch(`${baseUrl}/api/cards`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ createdBy: 'ada', ...body }),
}).then((r) => r.json());

const patch = (baseUrl, id, body) => fetch(`${baseUrl}/api/cards/${id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

const checks = async (baseUrl) => {
  const r = await fetch(`${baseUrl}/api/checks`);
  return { status: r.status, body: await r.json() };
};

const phantom = (body) => (body.standing || []).find((s) => s.id === 'phantom-block');

test('#880 a block on a DONE card is reported as a standing finding', async () => {
  const s = await startRestServer();
  try {
    const blocker = await mk(s.baseUrl, { title: 'the blocker' });
    const blocked = await mk(s.baseUrl, { title: 'the blocked', relationships: { blockedBy: [blocker.shortId] } });

    // ⭐ CONTROL FIRST: while the blocker is OPEN the block is real, so the
    // check must report NOTHING. A detector that fires on every blockedBy edge
    // would satisfy the assertion below and be worthless — #824's "a rule that
    // always fires" failure, which is the reason this file exists at all.
    const open = await checks(s.baseUrl);
    assert.equal(open.status, 200, `checks must answer: ${JSON.stringify(open.body).slice(0, 200)}`);
    assert.deepEqual(
      phantom(open.body)?.rows, [],
      'a block on an OPEN card is a REAL block and must not be reported. '
      + `got ${JSON.stringify(phantom(open.body)?.rows)}`,
    );

    // Now the blocker ships. Nothing on the blocked card changes — that is the
    // whole defect: there is no edit anywhere for a reviewer to notice.
    await patch(s.baseUrl, blocker.id, { column: 'done' });

    const after = await checks(s.baseUrl);
    const f = phantom(after.body);
    assert.ok(f, 'the standing check must be present in the payload');
    assert.deepEqual(
      f.rows, [{ blocked: String(blocked.shortId), blocker: String(blocker.shortId) }],
      'once the blocker is done the block cannot block anything, and NOTHING on the '
      + `blocked card changed to say so. got ${JSON.stringify(f.rows)}`,
    );
  } finally { await s.stop(); }
});

test('#880 the standing finding names what it found, not what it means', async () => {
  const s = await startRestServer();
  try {
    const blocker = await mk(s.baseUrl, { title: 'shipped' });
    await mk(s.baseUrl, { title: 'stale block', relationships: { blockedBy: [blocker.shortId] } });
    await patch(s.baseUrl, blocker.id, { column: 'done' });

    const f = phantom((await checks(s.baseUrl)).body);
    // #824's rule, applied: a public UNKNOWN, never an accusation. The edge was
    // TRUE when it was written; nobody did anything wrong by not clearing it.
    assert.match(f.claim, /block/i, 'the finding must state the structural fact');
    assert.ok(
      !/should|must|fail|wrong|neglect/i.test(f.claim),
      `a standing finding describes, it does not judge. got ${JSON.stringify(f.claim)}`,
    );
    assert.ok(f.query && /blockedBy/.test(f.query), 'and it must publish the query, so the reader can re-run it');
  } finally { await s.stop(); }
});

test('#880 standing checks are DISTINCT from authored tripwires in the payload', async () => {
  const s = await startRestServer();
  try {
    await mk(s.baseUrl, {
      title: 'a watched card', type: 'goal',
      checks: [{ claim: 'people exist', ask: 'ASK { ?p a schema:Person }', expect: true }],
    });
    const { body } = await checks(s.baseUrl);

    // ⭐ The two populations answer different questions and must not be summed.
    // `results` is "claims a seat wrote a tripwire for". `standing` is "claims
    // the SYSTEM checks because nobody would think to". Merging them would make
    // `stale: 0` mean two things at once — which is the confusion this endpoint
    // exists to refuse.
    assert.ok(Array.isArray(body.results), 'authored tripwires stay under results');
    assert.ok(Array.isArray(body.standing), 'and corpus-scale checks under standing');
    assert.equal(body.cardsWatched, 1, 'cardsWatched counts AUTHORED coverage only');
    assert.match(
      body.note, /standing/i,
      'the note must tell a reader the two are different, or an empty `standing` reads '
      + 'as an empty gap',
    );
  } finally { await s.stop(); }
});

test('#880 a board with no blocks at all reports an empty finding, not a missing one', async () => {
  const s = await startRestServer();
  try {
    await mk(s.baseUrl, { title: 'lonely' });
    const f = phantom((await checks(s.baseUrl)).body);
    assert.ok(f, 'the check must be listed even when it finds nothing');
    assert.deepEqual(
      f.rows, [],
      'ABSENCE OF A FINDING IS A RESULT. A missing entry reads as "not checked" and an '
      + 'empty one reads as "checked, none found".',
    );
  } finally { await s.stop(); }
});

test('#1112 a phantom block that the room has HANDLED — blocker entry status cleared — stops firing; an open entry does not silence it', async () => {
  const s = await startRestServer();
  try {
    const blocker = await mk(s.baseUrl, { title: 'shipped later' });
    const blocked = await mk(s.baseUrl, { title: 'waiting', relationships: { blockedBy: [blocker.shortId] } });
    await patch(s.baseUrl, blocker.id, { column: 'done' });

    // ⭐ CONTROL FIRST: an entry that says the block is still OPEN must not
    // silence the finding — otherwise annotating a block hides it.
    await patch(s.baseUrl, blocked.id, { blockers: [{ card: blocker.shortId, status: 'open', note: 'still real' }] });
    let f = phantom((await checks(s.baseUrl)).body);
    assert.equal(f.rows.length, 1, `an OPEN entry is not a clearance. got ${JSON.stringify(f.rows)}`);

    // The room handles it: the entry is CLEARED, with the note as the record.
    // The blockedBy EDGE stays — deleting history to quiet an instrument is the
    // cleanup the check's own comment forbids. The check consults the entry.
    await patch(s.baseUrl, blocked.id, { blockers: [{ card: blocker.shortId, status: 'cleared', note: 'blocker shipped; handled' }] });
    f = phantom((await checks(s.baseUrl)).body);
    assert.deepEqual(f.rows, [],
      'a cleared blocker entry IS the room saying "handled" — a check that keeps firing on it '
      + `is a stuck alarm (#824: an instrument that always fires gets dismissed). got ${JSON.stringify(f.rows)}`);
  } finally { await s.stop(); }
});
