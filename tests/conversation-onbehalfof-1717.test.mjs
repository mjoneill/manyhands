/**
 * #1717 — POST /api/conversations STORES `onBehalfOf` but reports it in `ignoredFields`: the CONSUMED_UNDECLARED shape
 * (#830/#856/#831) on the post route. createConversationFromPayload reads `body.onBehalfOf`; CONVERSATION_CONSUMED_FIELDS
 * does not list it, so one response says the field was stored AND that it was dropped. A seat that read only
 * `ignoredFields` told the room a relay "wasn't stored" (commons 43893 → 43894). TEST AUTHOR's rows, written before any fix.
 *
 *   O1  a post carrying onBehalfOf STORES it (read back), and the response does NOT name it in ignoredFields
 *   O2  EXACT SET: with onBehalfOf AND an unknown key, ignoredFields is exactly [the unknown key] — names what was dropped,
 *       not what was stored, and is not silenced wholesale. (Fails at main too: main reports both. The clean-post and
 *       junk-only controls already live in tests/conversation-column-diagnostics.test.mjs.)
 *   O3  SWEEP: every `body.<field>` the post constructor reads is in the route's consumed set (read from server.js), so the
 *       next field added to the constructor and not to the set fails here, not in a seat's report
 *
 * NOT covered: the auth-layer rewrite (#1343) that creates onBehalfOf from a bound seat's mismatched author — this row sends
 * onBehalfOf in the body directly, which the constructor stores the same way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRestServer, PROJECT_DIR } from './helpers/harness.mjs';

const JUNK = 'zzz_1717_probe_not_a_real_field';
const post = async (base, body) => {
  const r = await fetch(`${base}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

test('#1717 (O1) a post carrying onBehalfOf stores it, and the response does NOT report it as ignored', async () => {
  const s = await startRestServer();
  try {
    const r = await post(s.baseUrl, { body: 'relayed post', author: 'ada', onBehalfOf: 'grace' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const stored = await (await fetch(`${s.baseUrl}/api/conversations/${r.body.id}`)).json();
    assert.equal(stored.onBehalfOf, 'grace', `PRECONDITION: the relay is stored (${JSON.stringify(stored).slice(0, 200)})`);
    assert.ok(!(r.body.ignoredFields || []).includes('onBehalfOf'), `a stored field is not "ignored" (ignoredFields: ${JSON.stringify(r.body.ignoredFields)})`);
  } finally { await s.stop(); }
});

test('#1717 (O2) EXACT SET: with onBehalfOf and an unknown key, ignoredFields names only the unknown key', async () => {
  const s = await startRestServer();
  try {
    const r = await post(s.baseUrl, { body: 'relayed post', author: 'ada', onBehalfOf: 'grace', [JUNK]: 'x' });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.ignoredFields, [JUNK], `only the unknown key is named (${JSON.stringify(r.body.ignoredFields)})`);
  } finally { await s.stop(); }
});

test('#1717 (O3) SWEEP: every body.<field> the post constructor reads is in CONVERSATION_CONSUMED_FIELDS', () => {
  const src = fs.readFileSync(path.join(PROJECT_DIR, 'server.js'), 'utf8');
  const setM = src.match(/const CONVERSATION_CONSUMED_FIELDS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(setM, 'PRECONDITION: the consumed set was found in server.js');
  const consumed = new Set([...setM[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const at = src.indexOf('function createConversationFromPayload(');
  assert.ok(at > 0, 'PRECONDITION: the constructor was found');
  const end = src.indexOf('\n}\n', at);
  const readsBody = [...new Set([...src.slice(at, end).matchAll(/\bbody\.([A-Za-z_]\w*)/g)].map((m) => m[1]))];
  assert.ok(readsBody.length >= 3, `PRECONDITION: the constructor reads several body fields (${readsBody.join(', ')})`);
  const undeclared = readsBody.filter((k) => !consumed.has(k));
  assert.deepEqual(undeclared, [], `fields the constructor reads but the route reports as ignored: ${undeclared.join(', ')}`);
});
