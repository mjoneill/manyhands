/**
 * #1086 slice 2 — the reader over top-k. Pure half: prompt, parse, rails.
 * The model is a stub. What is under test is that the reader cannot lie:
 * a pick outside the candidates, a malformed reply, an unreachable model —
 * each is a REFUSAL with a reason, never an abstain and never a coerced answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, readerPrompt, readerCandidates, parseReaderReply, READER_PROMPT_VERSION, READER_SAMPLING } from '../core/semantic-search.mjs';

const cards = new Map([
  ['u1', { id: 'u1', shortId: 1, title: 'The deploy script asks CI before it exports', description: 'deploy refuses unless CI is green' }],
  ['u2', { id: 'u2', shortId: 2, title: 'Semantic search over cards', description: 'query to card' }],
  ['u3', { id: 'u3', shortId: 3, title: 'The push gate reads pushed objects', description: '' }],
]);
const ranked = [{ id: 'u1', score: 0.7 }, { id: 'u2', score: 0.65 }, { id: 'u3', score: 0.6 }];
const cands = readerCandidates(ranked, cards);
const agent = { model: 'stub', protocol: 'ollama-native', baseUrl: 'http://stub' };
const stub = (text) => async () => ({ text, stopReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 } });

test('candidates are numbered 1..K with title, snippet head and score; a missing card still yields a row', () => {
  assert.deepEqual(cands.map((c) => c.n), [1, 2, 3]);
  assert.equal(cands[0].snippet, 'deploy refuses unless CI is green');
  assert.equal(cands[2].snippet, '');
  const withGhost = readerCandidates([{ id: 'ghost', score: 0.5 }], cards);
  assert.equal(withGhost[0].title, ''); assert.equal(withGhost[0].n, 1);
});

test('the prompt carries the question, every candidate by number, and the three verdicts by name', () => {
  const p = readerPrompt('how does deploy work', cands);
  assert.match(p, /QUESTION: how does deploy work/);
  for (const c of cands) assert.match(p, new RegExp(`\\n${c.n}\\. ${c.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  for (const v of ['answer', 'ask', 'abstain']) assert.match(p, new RegExp(`- ${v}:`));
});

test('answer with one candidate parses to that card; ask with two; abstain with none', () => {
  assert.deepEqual(parseReaderReply('{"verdict":"answer","cards":[1],"reason":"it says so"}', cands).picks.map((c) => c.id), ['u1']);
  const ask = parseReaderReply('{"verdict":"ask","cards":[1,3],"reason":"either"}', cands);
  assert.equal(ask.verdict, 'ask'); assert.deepEqual(ask.picks.map((c) => c.id), ['u1', 'u3']);
  const ab = parseReaderReply('prose first {"verdict":"ABSTAIN","cards":[],"reason":"none"} prose after', cands);
  assert.equal(ab.ok, true); assert.equal(ab.verdict, 'abstain'); assert.equal(ab.picks.length, 0);
});

test('RAIL: a pick outside the candidates REFUSES the whole reply — it is not dropped and the rest kept', () => {
  const r = parseReaderReply('{"verdict":"answer","cards":[7],"reason":"x"}', cands);
  assert.equal(r.ok, false); assert.match(r.reason, /named candidate 7/); assert.equal('verdict' in r, false);
  const r2 = parseReaderReply('{"verdict":"ask","cards":[1,9],"reason":"x"}', cands);
  assert.equal(r2.ok, false); assert.match(r2.reason, /9/);
});

test('RAIL: verdict and pick count must agree — answer with 2, ask with 1, abstain with 1 are all refused by name', () => {
  assert.match(parseReaderReply('{"verdict":"answer","cards":[1,2]}', cands).reason, /exactly one/);
  assert.match(parseReaderReply('{"verdict":"ask","cards":[1]}', cands).reason, /two or more/);
  assert.match(parseReaderReply('{"verdict":"abstain","cards":[2]}', cands).reason, /names no card/);
  assert.match(parseReaderReply('{"verdict":"maybe","cards":[]}', cands).reason, /not one of/);
  assert.match(parseReaderReply('I think card 1.', cands).reason, /no JSON/);
  assert.match(parseReaderReply('{"verdict":"answer","cards":[1],}', cands).reason, /malformed/);
});

test('read(): a good reply is available:true carrying model, prompt version, sampling, usage and the raw text', async () => {
  const r = await read({ q: 'deploy?', candidates: cands, callModel: stub('{"verdict":"answer","cards":[1],"reason":"card 1 says CI gates deploy"}'), agent });
  assert.equal(r.available, true); assert.equal(r.verdict, 'answer'); assert.equal(r.picks[0].id, 'u1');
  assert.equal(r.model, 'stub'); assert.equal(r.promptVersion, READER_PROMPT_VERSION); assert.deepEqual(r.sampling, READER_SAMPLING);
  assert.equal(r.usage.promptTokens, 10); assert.match(r.raw, /card 1 says/);
});

test('RAIL: an unreachable model is available:false with the reason — NEVER an abstain', async () => {
  const r = await read({ q: 'deploy?', candidates: cands, callModel: async () => { throw new Error('fetch failed'); }, agent });
  assert.equal(r.available, false); assert.match(r.reason, /could not be reached — fetch failed/); assert.equal('verdict' in r, false);
});

test('RAIL: a malformed reply is available:false with the parse reason and the raw text kept for the reader of the ledger', async () => {
  const r = await read({ q: 'deploy?', candidates: cands, callModel: stub('Sure! Card 1 is the one.'), agent });
  assert.equal(r.available, false); assert.match(r.reason, /no JSON/); assert.equal(r.raw, 'Sure! Card 1 is the one.');
});

test('RAIL: no reader configured, or no candidates, is available:false without calling the model', async () => {
  let calls = 0; const counting = async () => { calls++; return { text: '{}' }; };
  const a = await read({ q: 'x', candidates: cands, callModel: counting, agent: null });
  const b = await read({ q: 'x', candidates: [], callModel: counting, agent });
  assert.equal(a.available, false); assert.match(a.reason, /no reader model/);
  assert.equal(b.available, false); assert.match(b.reason, /no candidates/);
  assert.equal(calls, 0);
});

test('the prompt the model receives is the prompt readerPrompt builds — one message, role user, verbatim', async () => {
  let seen;
  await read({ q: 'the q', candidates: cands, callModel: async (_a, msgs) => { seen = msgs; return { text: '{"verdict":"abstain","cards":[]}' }; }, agent });
  assert.equal(seen.length, 1); assert.equal(seen[0].role, 'user'); assert.equal(seen[0].content, readerPrompt('the q', cands));
});
