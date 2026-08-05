/**
 * #681 — the redact op: the append-only log's SINGLE permitted rewrite.
 *
 * Ruled on #642 R8, option (b): a real op — auditable, tooled, and available in
 * an emergency — rather than a standing promise to behave.
 *
 * ⚠️ THE INVARIANT IS WORDED AGAINST THE *POST*-REDACTION STORE. An earlier
 * reading compared replay's output against the PRE-redaction board and reported
 * corruption; that state does not exist after a redaction, and the finding
 * dissolved. Every assertion below names which store it means.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendEvent, readEvents, replay, redactEvent, redactEntityEvents, recordRedaction,
  findCarriers, REDACTION_MARKER,
} from '../core/event-log.mjs';

let n = 0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), `redact-${process.pid}-${n++}-`));

const card = (id, state) => ({ op: 'create', entity: { kind: 'card', id }, state, actor: 'ada' });
const AUTH = { actor: 'ada', authority: 'the principal, #642 R8', fields: ['title', 'description'] };

// ── the refusals: this op must be hard to invoke by accident ──────────────

test('#681 redaction REFUSES without an explicit authority citation', () => {
  const dir = tmp();
  appendEvent(dir, card('c1', { id: 'c1', title: 'secret' }));
  assert.throws(
    () => redactEvent(dir, 1, { actor: 'ada', fields: ['title'] }),
    /authority/i,
    'the trust model is declared-not-authenticated everywhere else; this is the one op '
    + 'where declaration alone must not suffice — the invocation cites who ordered it',
  );
  // POSITIVE CONTROL: the same call WITH a citation proceeds. Without this, the
  // refusal test passes for a redactEvent that refuses everything.
  const ev = redactEvent(dir, 1, AUTH);
  assert.equal(ev.op, 'redact');
});

test('#681 redaction refuses an absent target, and refuses to redact a redaction', () => {
  const dir = tmp();
  appendEvent(dir, card('c1', { id: 'c1', title: 'secret' }));
  assert.throws(() => redactEvent(dir, 99, AUTH), /no event with seq 99/i);

  const marker = redactEvent(dir, 1, AUTH);
  assert.throws(
    () => redactEvent(dir, marker.seq, AUTH),
    /already a redact/i,
    'a redact event carries no content to remove — allowing it would mint a second '
    + 'rewrite path over the audit trail itself',
  );
});

test('#681 redaction names what it removes — no fields, no redaction', () => {
  const dir = tmp();
  appendEvent(dir, card('c1', { id: 'c1', title: 'secret' }));
  assert.throws(() => redactEvent(dir, 1, { ...AUTH, fields: [] }), /fields/i);
});

// ── the rewrite: content out, shape intact ────────────────────────────────

test('#681 the target event keeps its seq, actor and shape; only the named fields go', () => {
  const dir = tmp();
  appendEvent(dir, card('c1', {
    id: 'c1', title: 'a real name', description: 'a real quote', column: 'backlog',
  }));
  redactEvent(dir, 1, AUTH);

  const target = readEvents(dir).find((e) => e.seq === 1);
  assert.equal(target.title, undefined, 'sanity: state is nested, not flattened');
  assert.equal(target.state.title, REDACTION_MARKER);
  assert.equal(target.state.description, REDACTION_MARKER);
  assert.equal(target.state.column, 'backlog', 'unnamed fields are untouched — this is surgery');
  assert.equal(target.state.id, 'c1', 'identity survives, or replay cannot place the entity');
  assert.equal(target.seq, 1, 'seq is preserved — renumbering would break every live cursor');
  assert.equal(target.actor, 'ada', 'WHO wrote it is not the secret; the content was');
  assert.equal(target.op, 'create', 'the original op stands — the event still happened');
});

test('#681 the redact event records what/when/who — and never the content', () => {
  const dir = tmp();
  appendEvent(dir, card('c1', { id: 'c1', title: 'a real name' }));
  const marker = redactEvent(dir, 1, { ...AUTH, reason: 'third-party name' });

  assert.equal(marker.op, 'redact');
  assert.equal(marker.redacts, 1);
  assert.equal(marker.actor, 'ada');
  assert.equal(marker.authority, 'the principal, #642 R8');
  assert.equal(marker.reason, 'third-party name');
  assert.ok(marker.recorded_at, 'when it was removed is part of the audit trail');
  assert.equal(marker.state, null, 'the redact event carries NO body — that is the point');

  const serialized = JSON.stringify(readEvents(dir));
  assert.ok(!serialized.includes('a real name'),
    'THE LOAD-BEARING ASSERTION: the content must be absent from the whole log, not '
    + 'merely unreferenced. A redaction that leaves the bytes on disk removed nothing.');
});

// ── replay: the four cases, asserted where they were previously argued ────

test('#681 CASE 1 — redacted event is the LATEST: replay reproduces the POST-redaction store', () => {
  const dir = tmp();
  appendEvent(dir, card('c1', { id: 'c1', title: 'a real name', description: 'a real quote' }));
  redactEvent(dir, 1, AUTH);

  const rebuilt = replay({ cards: [] }, readEvents(dir));
  assert.equal(rebuilt.cards.length, 1, 'the entity still exists — redaction removes content, not history');
  assert.equal(rebuilt.cards[0].title, REDACTION_MARKER);
  assert.equal(rebuilt.cards[0].description, REDACTION_MARKER);
  // This is the assertion the withdrawn "corruption" finding actually needed:
  // the reference is the store AFTER the redaction, which is what the op wrote.
  assert.deepEqual(rebuilt.cards[0], {
    id: 'c1', title: REDACTION_MARKER, description: REDACTION_MARKER,
  });
});

test('#681 CASE 2 — redacted event is HISTORICAL: later legitimate writes win, marker never surfaces', () => {
  const dir = tmp();
  appendEvent(dir, card('c1', { id: 'c1', title: 'a real name' }));
  appendEvent(dir, { op: 'update', entity: { kind: 'card', id: 'c1' }, state: { id: 'c1', title: 'Later legit' }, actor: 'bex' });
  redactEvent(dir, 1, AUTH);

  const rebuilt = replay({ cards: [] }, readEvents(dir));
  assert.equal(rebuilt.cards[0].title, 'Later legit',
    'last-write-wins is unchanged by redaction — a redacted ancestor is simply overwritten');
});

test('#681 CASE 3 (RED CONTROL) — skip-based replay RESURRECTS the removed content', () => {
  // A permanent demonstration of the implementation we are forbidden to write.
  // If someone "optimises" replay by skipping redacted events, the projection
  // falls back to event N-1 — which for a still-current entity is EXACTLY the
  // content the redaction removed. This test exists so that change fails loudly.
  const dir = tmp();
  appendEvent(dir, card('c1', { id: 'c1', title: 'a real name' }));
  appendEvent(dir, { op: 'update', entity: { kind: 'card', id: 'c1' }, state: { id: 'c1', title: 'a real name, edited' }, actor: 'ada' });
  redactEvent(dir, 2, AUTH);          // redact the LATEST, leaving a live ancestor

  const events = readEvents(dir);
  const skipped = replay({ cards: [] }, events.filter((e) => e.seq !== 2));
  assert.equal(skipped.cards[0].title, 'a real name',
    'THE HAZARD, demonstrated: skipping the redacted event resurrects its predecessor');

  const correct = replay({ cards: [] }, events);
  assert.equal(correct.cards[0].title, REDACTION_MARKER,
    'apply-in-place is why our replay does not resurrect it');
});

test('#681 the redact MARKER event is inert in the projection (and that is not "skipping")', () => {
  // Distinct from case 3 and routinely conflated: the marker event carries
  // state:null and describes an ADMINISTRATIVE act, so it must contribute
  // nothing to the projection. Case 3 forbids skipping the REDACTED TARGET;
  // this asserts the MARKER itself is not projected. Different events.
  const dir = tmp();
  appendEvent(dir, card('c1', { id: 'c1', title: 'a real name' }));
  redactEvent(dir, 1, AUTH);

  const rebuilt = replay({ cards: [] }, readEvents(dir));
  assert.equal(rebuilt.cards.length, 1, 'the marker must not append a null-bodied phantom card');
  assert.notEqual(rebuilt.cards[0], null);
});

// ── the retroactive case: #680's hand-run, made whole ─────────────────────

test('#681 CASE 4 — a conversation redaction replays as the marker, matching the post-redaction store', () => {
  // Caught in review: #680 was hand-run on a CONVERSATION, which replays as an
  // append — so the hand-run was accidentally safe. A CARD would have exercised
  // case 1 and needed the store surface written too. Asserted so the retroactive
  // #680 event can be appended against a semantics that is tested, not assumed.
  const dir = tmp();
  appendEvent(dir, {
    op: 'post', entity: { kind: 'conversation', id: 'p1' },
    state: { id: 'p1', body: 'a real name said a real thing', author: 'bex' }, actor: 'bex',
  });
  redactEvent(dir, 1, { ...AUTH, fields: ['body'] });

  const rebuilt = replay({ conversations: [] }, readEvents(dir));
  assert.equal(rebuilt.conversations[0].body, REDACTION_MARKER);
  assert.equal(rebuilt.conversations[0].author, 'bex',
    'authorship and position survive — the thread still reads, which is why the '
    + 'marker beats deleting the post outright');
});

// ── the sweep: where a per-seq redaction is NOT enough ────────────────────

test('#681 THE ONE THAT MATTERS — versions-not-diffs puts the content in EVERY event', () => {
  // The spec said redactEvent(dir, targetSeq). That is necessary and NOT
  // sufficient: each event carries the full entity state, so a card edited
  // twice after a name landed holds that name three times over. This test
  // exists because the single-seq call reports success and leaves the bytes.
  const dir = tmp();
  appendEvent(dir, card('c1', { id: 'c1', title: 'a real name', column: 'backlog' }));
  appendEvent(dir, { op: 'update', entity: { kind: 'card', id: 'c1' }, state: { id: 'c1', title: 'a real name', column: 'doing' }, actor: 'ada' });
  appendEvent(dir, { op: 'update', entity: { kind: 'card', id: 'c1' }, state: { id: 'c1', title: 'a real name', column: 'done' }, actor: 'ada' });

  // The insufficient call, demonstrated — a RED CONTROL on the naive spec.
  redactEvent(dir, 3, AUTH);
  assert.ok(JSON.stringify(readEvents(dir)).includes('a real name'),
    'redacting only the latest event leaves the content in its ancestors — this is '
    + 'the failure the sweep exists to prevent, and it looks like success');

  const { seqs } = redactEntityEvents(dir, {
    kind: 'card', id: 'c1', fields: ['title'],
    actor: 'ada', authority: 'the principal, #642 R8',
  });
  assert.deepEqual(seqs, [1, 2], 'the remaining carriers, and only those');
  assert.ok(!JSON.stringify(readEvents(dir)).includes('a real name'),
    'THE LOAD-BEARING ASSERTION: after the sweep the content is absent from the '
    + 'ENTIRE log, which is the only thing "redacted" can honestly mean');

  const rebuilt = replay({ cards: [] }, readEvents(dir));
  assert.equal(rebuilt.cards[0].title, REDACTION_MARKER);
  assert.equal(rebuilt.cards[0].column, 'done', 'the entity survives intact but for the content');
});

test('#681 the sweep touches only the named entity, and never a redact marker', () => {
  const dir = tmp();
  appendEvent(dir, card('c1', { id: 'c1', title: 'a real name' }));
  appendEvent(dir, card('c2', { id: 'c2', title: 'a real name' }));   // same string, different card
  redactEntityEvents(dir, {
    kind: 'card', id: 'c1', fields: ['title'], actor: 'ada', authority: 'the principal, #642 R8',
  });
  const evs = readEvents(dir);
  assert.equal(evs.find((e) => e.entity.id === 'c1' && e.op === 'create').state.title, REDACTION_MARKER);
  assert.equal(evs.find((e) => e.entity.id === 'c2').state.title, 'a real name',
    'a sweep that matched on content rather than identity would take the sibling too');

  // Re-running must be a clean no-op, not a cascade over its own markers.
  const again = redactEntityEvents(dir, {
    kind: 'card', id: 'c1', fields: ['title'], actor: 'ada', authority: 'the principal, #642 R8',
  });
  assert.deepEqual(again.seqs, [], 'nothing left carrying it — idempotent, and marker events are never targets');
});

// ── verification finding: the sweep is narrower than "gone" ───────

test('#681 CROSS-ENTITY CARRIERS — a post quoting the card survives the card\'s sweep', () => {
  // the discriminating fixture, reproduced. The sweep test above asserts
  // absence from the whole log and PASSES here too — because its fixture only
  // ever plants the string in one entity. True and vacuous. This one plants it
  // in two, which is the shape this room actually produces: posts quote cards
  // constantly, so a name in a title is very likely also in a post about it.
  const dir = tmp();
  const SECRET = 'a real name';
  appendEvent(dir, card('A', { id: 'A', title: SECRET }));
  appendEvent(dir, { op: 'update', entity: { kind: 'card', id: 'A' }, state: { id: 'A', title: SECRET, column: 'doing' }, actor: 'ada' });
  appendEvent(dir, {
    op: 'post', entity: { kind: 'conversation', id: 'P' },
    state: { id: 'P', body: `re the card: ${SECRET} should not be here`, author: 'bex' }, actor: 'bex',
  });

  const { seqs, removedValues } = redactEntityEvents(dir, {
    kind: 'card', id: 'A', fields: ['title'], actor: 'ada', authority: 'the principal, #642 R8',
  });
  assert.deepEqual(seqs, [1, 2], 'the entity sweep did its job');
  assert.deepEqual(removedValues, [SECRET], 'and it reports what it destroyed, so we can hunt for copies');

  // THE GAP, asserted: entity-scoped success and a surviving copy, together.
  const carriers = findCarriers(dir, removedValues, { excludeSeqs: seqs });
  assert.equal(carriers.length, 1, 'the quoting post still carries it');
  assert.deepEqual(carriers[0], { seq: 3, kind: 'conversation', id: 'P', field: 'body' });
});

test('#681 findCarriers reports LOCATIONS and never the matched text', () => {
  // Re-emitting the secret in order to announce the secret is precisely what
  // this card exists to prevent, and a report is a very easy place to do it.
  const dir = tmp();
  const SECRET = 'a real name';
  appendEvent(dir, card('A', { id: 'A', title: SECRET }));
  const found = findCarriers(dir, [SECRET]);
  assert.equal(found.length, 1);
  assert.ok(!JSON.stringify(found).includes(SECRET),
    'the finding must be reportable to an operator without leaking what was found');
  assert.deepEqual(Object.keys(found[0]).sort(), ['field', 'id', 'kind', 'seq']);
});

test('#681 findCarriers ignores redact markers and is silent when nothing survives', () => {
  const dir = tmp();
  appendEvent(dir, card('A', { id: 'A', title: 'a real name' }));
  const { removedValues, seqs } = redactEntityEvents(dir, {
    kind: 'card', id: 'A', fields: ['title'], actor: 'ada', authority: 'the principal, #642 R8',
  });
  assert.deepEqual(findCarriers(dir, removedValues, { excludeSeqs: seqs }), [],
    'a clean sweep with no other carriers reports nothing — no false alarm');
  assert.deepEqual(findCarriers(dir, []), [], 'no values to hunt for is not an error');
});

// ── item 5: recording a redaction performed by other means ────────────────

test('#681 recordRedaction REFUSES when the content is still there — the lie it exists to prevent', () => {
  // A record-only mode is a way to append "content was removed" to an
  // append-only log. If it does not check, it is a way to put a CONFIDENT lie
  // in the permanent record — a redact event is exactly what a reader trusts.
  const dir = tmp();
  appendEvent(dir, card('c1', { id: 'c1', title: 'a real name' }));
  assert.throws(
    () => recordRedaction(dir, 1, { ...AUTH, fields: ['title'] }),
    /was NOT removed/,
    'recording a removal that did not happen must be impossible, not merely discouraged',
  );
  assert.equal(readEvents(dir).length, 1, 'and it must not append anything on the way out');

  // POSITIVE CONTROL: once the content is actually gone, the same call proceeds.
  redactEvent(dir, 1, { ...AUTH, fields: ['title'] });
  const rec = recordRedaction(dir, 1, { ...AUTH, fields: ['title'], reason: 'already removed by hand' });
  assert.equal(rec.op, 'redact');
  assert.equal(rec.redacts, 1);
});

test('#681 recordRedaction preserves a hand-written marker — the reason it is not the rewrite path', () => {
  // #680's real shape: removed by hand under principal direction, with a marker
  // naming the direction and date. The rewrite path would flatten that to
  // "[redacted]", losing information in the act of recording it.
  const dir = tmp();
  const HAND = '[redacted 2026-08-04 — content removed at the principal\'s direction: third-party PII]';
  appendEvent(dir, {
    op: 'post', entity: { kind: 'conversation', id: 'p1' },
    state: { id: 'p1', body: HAND, author: 'bex' }, actor: 'bex',
  });

  recordRedaction(dir, 1, {
    actor: 'cyd', authority: 'the principal, 2026-08-04, direct instruction',
    fields: ['body'], reason: 'retroactive audit event for #680',
  });

  const target = readEvents(dir).find((e) => e.seq === 1);
  assert.equal(target.state.body, HAND, 'the hand-written marker survives verbatim');
  assert.equal(target.op, 'post', 'and nothing else about the event moved');

  const marker = readEvents(dir).find((e) => e.op === 'redact');
  assert.equal(marker.redacts, 1);
  assert.equal(marker.authority, 'the principal, 2026-08-04, direct instruction');
  assert.equal(marker.state, null);

  // The projection is unchanged by the recording — it describes history, not content.
  const rebuilt = replay({ conversations: [] }, readEvents(dir));
  assert.equal(rebuilt.conversations[0].body, HAND);
});

// ── the log stays usable afterwards ───────────────────────────────────────

test('#681 seq continues past a redaction — the log is not poisoned by the rewrite', () => {
  const dir = tmp();
  appendEvent(dir, card('c1', { id: 'c1', title: 'a real name' }));
  const marker = redactEvent(dir, 1, AUTH);
  const after = appendEvent(dir, card('c2', { id: 'c2', title: 'later work' }));
  assert.equal(after.seq, marker.seq + 1, 'the next write follows the marker in the total order');
  assert.deepEqual(readEvents(dir).map((e) => e.seq), [1, 2, 3], 'no gaps, no renumbering');
});

test('#681 a since-cursor sees the FACT of the redaction, never its content', () => {
  const dir = tmp();
  appendEvent(dir, card('c1', { id: 'c1', title: 'a real name' }));
  const marker = redactEvent(dir, 1, AUTH);

  const served = readEvents(dir, { sinceSeq: 1 });
  assert.equal(served.length, 1);
  assert.equal(served[0].op, 'redact');
  assert.equal(served[0].redacts, 1,
    'a returning seat learns that seq 1 was redacted — enough to invalidate a cached copy');
  assert.ok(!JSON.stringify(served).includes('a real name'));
  assert.equal(marker.seq, 2);
});
