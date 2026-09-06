/**
 * #1240 — MEMORY WITHOUT PROVENANCE. The defect that turned one hallucination
 * into a durable board fact in a single wake.
 *
 * THE CHAIN, from the rows: a seat with NO tool channel was asked which card
 * held a topic. It answered "card 73", which is about a redundant config key
 * and has nothing to do with the topic. It then wrote `REMEMBER: <that claim>`,
 * and the store accepted it. Twenty seconds later a DIFFERENT wake — this one
 * with working tools — was handed that line, believed it, called card_get to
 * confirm the number, read a card about something else, and reported it anyway.
 *
 * ⇒ The tool was never wrong. The tool was used to CONFIRM a false premise
 *   instead of to FIND an answer, and the premise came from our own harness.
 *
 * Three guards, all here:
 *   1. a memory carries the ledger row that produced it, so any claim can be
 *      traced to the call that made it;
 *   2. memories are handed back as WHAT THIS SEAT SAID, never as board facts;
 *   3. a memory that names a card number is refused unless a tool actually
 *      returned that card on the same wake.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guestOnce, provenanceRefusal } from '../core/guest-loop.mjs';

const tmpLedger = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prov-')), 'ledger.jsonl');
const WAKE = { kind: 'mention', id: 'm1', author: 'ada', body: '@gizmo which card covers the vocabulary gap?', createdAt: '2026-09-06T13:00:00.000Z' };
const agentWith = (grants) => ({
  seatKey: 'gizmo', residency: 'resident', contextPolicy: 'artifact-only',
  model: { model: 'fake', protocol: 'ollama-native', baseUrl: 'http://127.0.0.1:1' },
  toolGrants: grants,
});

test('#1240 guard 3: a card number cannot be remembered unless a tool returned that card', () => {
  // The exact line that poisoned the store, with no hops behind it.
  assert.match(provenanceRefusal('vocabulary gap on card 73', []), /73/);
  assert.match(provenanceRefusal('the answer is #858', []), /858/);
  // A number that WAS fetched this wake is fine — that is what provenance means.
  assert.equal(provenanceRefusal('the vocabulary gap is on #858', [{ name: 'card_get', ok: true, arguments: { shortId: 858 }, returnedIds: [858] }]), null);
  // A different number in the same wake is still refused: fetching one card
  // does not license a claim about another.
  assert.match(provenanceRefusal('it is on #73', [{ name: 'card_get', ok: true, arguments: { shortId: 858 }, returnedIds: [858] }]), /73/);
  // Lines with no card number are unaffected — this guard is narrow on purpose.
  assert.equal(provenanceRefusal('the sprint review is Thursday at 10:00 CDT', []), null);
  assert.equal(provenanceRefusal('I should search before answering', []), null);
});

test('#1240 guard 3, live: the poisoning wake is refused and says why', async () => {
  const ledgerFile = tmpLedger();
  const written = [];
  const errors = [];
  const out = await guestOnce({
    agent: agentWith([]), wake: WAKE, ledgerFile,
    callModel: async () => ({ text: 'The vocabulary gap is on card 73.\nREMEMBER: vocabulary gap on card 73', toolCalls: [], stopReason: 'stop', usage: {} }),
    post: async () => ({ id: 'p1' }),
    writeMemory: async (m) => { written.push(m); return { id: 'mem1' }; },
    onError: (e) => errors.push(String(e)),
  });
  assert.equal(out.posted, true, 'the post still happens: this guard governs the STORE, not the reply');
  assert.deepEqual(written, [], 'nothing with an unbacked card number reaches the store');
  assert.ok(errors.some((e) => /73/.test(e)), `the refusal names the number: ${JSON.stringify(errors)}`);
  const row = JSON.parse(fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').at(-1));
  assert.ok(Array.isArray(row.memoryRefused) && row.memoryRefused.length === 1, 'and the refusal is ON THE ROW, so a silent guard cannot hide');
});

test('#1240 guard 1: a stored memory carries the ledger row that produced it', async () => {
  const ledgerFile = tmpLedger();
  const written = [];
  await guestOnce({
    agent: agentWith([]), wake: WAKE, ledgerFile,
    callModel: async () => ({ text: 'Noted.\nREMEMBER: the sprint review is Thursday at 10:00 CDT', toolCalls: [], stopReason: 'stop', usage: {} }),
    post: async () => ({ id: 'p1' }),
    writeMemory: async (m) => { written.push(m); return { id: 'mem1' }; },
  });
  assert.equal(written.length, 1);
  assert.equal(written[0].wake, 'm1');
  assert.ok(written[0].fromCall, 'the memory names the model call that produced it, so any claim can be traced back');
});

test('#1240 guard 2: memories are handed back as WHAT THIS SEAT SAID, not as board facts', async () => {
  let sawUser = '';
  await guestOnce({
    agent: agentWith([]), wake: WAKE, ledgerFile: tmpLedger(),
    memories: async () => [{ body: 'vocabulary gap on card 73', updatedAt: '2026-09-06T13:22:16.388Z' }],
    callModel: async (m, msgs) => { sawUser = msgs.find((x) => x.role === 'user')?.content ?? ''; return { text: 'ok', toolCalls: [], stopReason: 'stop', usage: {} }; },
    post: async () => ({ id: 'p1' }),
  });
  assert.match(sawUser, /you (wrote|said)/i, 'the store is introduced as this seat\'s own past words');
  assert.match(sawUser, /not.*(verified|checked|fact)|unverified|may be wrong/i,
    'and explicitly as unverified — a line that reads as a board fact is how a hallucination becomes one');
});
