/**
 * #1196 — A ROLE'S THINKING SETTING IS DATA, AND THIS ROUTE STOPS SWALLOWING
 * FIELDS IT DOES NOT KNOW.
 *
 * Both halves were found the same way and within a minute of each other, live.
 * Swapping the resident to a reasoning model, I sent {model, thinking:false},
 * got a 200, and believed it. The model changed; `thinking` was dropped without
 * a word. The seat then spent its ENTIRE token budget reasoning on every wake
 * and answered nobody — 167 s per wake, no post, and a timer firing every 60 s.
 *
 * ⛔ The ledger route already learned this lesson: an unknown field is REFUSED
 * BY NAME, because a field silently dropped reads as "not recorded" forever.
 * The agent route had not, so a configuration change could appear to work and
 * do nothing. Reading the value back was the only reason it was caught, and
 * that is not a rule anyone can be relied on to follow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const api = async (base, method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const AGENT = {
  seatKey: 'gizmo', prompt: 'Be brief.',
  model: { model: 'fake', protocol: 'ollama-native', baseUrl: 'http://127.0.0.1:1' },
  residency: 'resident', contextPolicy: 'artifact-only', by: 'ada',
};

test('#1196 thinking is stored, read back, and reaches the loop', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    assert.equal((await api(srv.baseUrl, 'POST', '/api/agents', AGENT)).status, 201);

    const off = await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { thinking: false, by: 'ada' });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.thinking, false, 'the value must READ BACK: a 200 describes the request, not the state');

    const list = await api(srv.baseUrl, 'GET', '/api/agents');
    const a = (list.body.agents || list.body).find((x) => x.seatKey === 'gizmo');
    assert.equal(a.thinking, false, 'and it must survive to the reader the runner uses');

    const on = await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { thinking: true, by: 'ada' });
    assert.equal(on.body.thinking, true);

    // Unset is a third state, not a synonym for false: a model with no such
    // flag must be sent no flag at all.
    const clear = await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { thinking: null, by: 'ada' });
    assert.equal(clear.body.thinking, null);
  } finally { await srv.stop(); }
});

test('#1196 an agent write REFUSES an unknown field by name instead of dropping it', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    assert.equal((await api(srv.baseUrl, 'POST', '/api/agents', AGENT)).status, 201);

    const typo = await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { thinkng: false, by: 'ada' });
    assert.equal(typo.status, 400, 'a misspelled field must not read as success');
    assert.match(String(typo.body?.error), /thinkng/, 'and the refusal names it, so the caller can fix it');

    const invented = await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { totallyMadeUp: 123, by: 'ada' });
    assert.equal(invented.status, 400);
    assert.match(String(invented.body?.error), /totallyMadeUp/);

    // and every field the route DOES support still works, so the refusal is a
    // guard rather than a wall.
    const good = await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { toolGrants: ['card_get'], thinking: false, emoji: '🔎', by: 'ada' });
    assert.equal(good.status, 200, JSON.stringify(good.body));
    assert.deepEqual(good.body.toolGrants, ['card_get']);
    assert.equal(good.body.thinking, false);
  } finally { await srv.stop(); }
});

test('#1196 a tool grant is checked against the REAL tools — a typo cannot read back as a grant', async () => {
  // Same class as the dropped `thinking` field, one level over, and found by a
  // reviewer before it cost anything: the route took grants as free strings and
  // the resolver silently ignored any name it did not know. So "board-search"
  // or "cardGet" returned 200, read back EXACTLY as sent, and granted nothing —
  // and a read-back check, which is the discipline that caught the last one,
  // would have passed on the typo. A value that survives the round trip and
  // means nothing is worse than one that is dropped, because it looks verified.
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    assert.equal((await api(srv.baseUrl, 'POST', '/api/agents', AGENT)).status, 201);

    const typo = await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { toolGrants: ['board-search'], by: 'ada' });
    assert.equal(typo.status, 400, 'a grant that grants nothing must not return success');
    assert.match(String(typo.body?.error), /board-search/, 'the refusal names what was sent');
    assert.match(String(typo.body?.error), /board_search/, 'and lists what is real, so the caller can fix it without reading source');

    const real = await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { toolGrants: ['card_get', 'board_search'], by: 'ada' });
    assert.equal(real.status, 200, JSON.stringify(real.body));
    assert.deepEqual(real.body.toolGrants, ['card_get', 'board_search']);

    // card_claim is granted through this same list and is NOT a board-tool; it
    // must keep working, or the guard breaks the standing-claim protocol.
    const claim = await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { toolGrants: ['card_claim'], by: 'ada' });
    assert.equal(claim.status, 200, `card_claim is a real grant and must survive: ${JSON.stringify(claim.body)}`);

    const none = await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { toolGrants: [], by: 'ada' });
    assert.equal(none.status, 200, 'granting nothing is a legitimate state');
    assert.deepEqual(none.body.toolGrants, []);
  } finally { await srv.stop(); }
});
