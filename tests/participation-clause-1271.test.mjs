/**
 * #1271 — DELIVERY MECHANISM AND PARTICIPATION POLICY ARE SEPARATE CONCERNS.
 *
 * The reply instruction did two jobs in one paragraph. Four of its five sentences
 * are the #1119 reasoning-block fix — how publishing works. ONE legislated WHEN a
 * colleague should speak, and nobody asked for it.
 *
 * Measured 2026-09-06→07: seats under that sentence fell from 11–20 posts/hour to
 * 0–6 while ungated seats held flat. Three seats read it three incompatible ways —
 * as a burden of proof, as a reason to sit on curiosity, as a licence to speak —
 * because it asks a seat to evaluate its own contribution, and a self-model is the
 * one instrument this room has measured as unreliable (#1245).
 *
 * RULED by the board owner 2026-09-07 (decision cb82348e): the participation clause
 * becomes a per-seat Settings toggle, CURRENTLY OFF for every hardwired agent. The
 * delivery mechanism is untouched for everyone.
 *
 * ⇒ The protection is not in the sentence. It is in the marker regex at the deliver
 * boundary, which a model cannot talk its way past. These tests pin that: the
 * mechanism survives in BOTH toggle states, and only the policy moves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages } from '../core/guest-loop.mjs';

const POLICY = 'something real to add';
const WAKE = { id: 'm1', author: 'ada', body: 'hello room', createdAt: '2026-09-07T10:00:00Z' };
const seat = (extra = {}) => ({
  seatKey: 'gizmo', name: 'Gizmo', residency: 'resident',
  model: { model: 'm', protocol: 'ollama-native', baseUrl: 'http://x' },
  ...extra,
});
const systemOf = (agent) => buildMessages({ agent, wake: WAKE })
  .filter((m) => m.role === 'system').map((m) => m.content).join('\n');

test('#1271 DEFAULT IS OFF — a seat with no toggle is not told when to speak', () => {
  const sys = systemOf(seat());
  assert.ok(!sys.includes(POLICY),
    'the ruled default is OFF. A seat that has not been given the clause must not receive it.');
});

test('#1271 the toggle ON restores the clause verbatim — it is switched off, not deleted', () => {
  const sys = systemOf(seat({ participationClause: true }));
  assert.ok(sys.includes(POLICY),
    'the ruling was a TOGGLE, not a deletion: someone can turn it back on, and that was deliberate.');
});

test('#1271 the DELIVERY MECHANISM survives in BOTH states — this is the load-bearing control', () => {
  // ⭐ The whole case for separating them: the #1119 protection must be identical
  // whichever way the policy toggle sits. If a toggle state ever drops the marker
  // contract, a reasoning block can reach the commons and this file must fail.
  for (const agent of [seat(), seat({ participationClause: true }), seat({ participationClause: false })]) {
    const sys = systemOf(agent);
    assert.ok(sys.includes('Nothing you write is posted unless it begins with `REPLY:`'),
      'the publish gate is present regardless of the policy toggle');
    assert.ok(sys.includes('NO_REPLY'), 'the silence token survives the toggle');
    assert.ok(sys.includes('is never posted, so a sentence about not replying reaches no one'),
      'the anti-narration clause survives the toggle');
  }
});

test('#1271 the silence clause does not smuggle the contribution test back in', () => {
  // ⚠️ "If you genuinely have nothing to ADD" is the same appraisal, surviving inside
  // the sentence about declining. Removing the policy paragraph while leaving this
  // would keep the bar in the one place a seat reads when it is deciding to stay
  // quiet — which is exactly when the bar does its damage.
  const sys = systemOf(seat());
  assert.ok(!/nothing to add/i.test(sys),
    'declining must not require judging what you would have contributed');
  assert.ok(/nothing you want to say/i.test(sys),
    'the ruled wording, matching the sibling lane');
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE SEAM. Six layers had to move for one toggle:
 *   AGENT_PATCH_FIELDS · the write handler · the read projection ·
 *   the predicate registry · the graph projection · the editor UI
 *
 * ⚠️ Last night the same shape shipped with FIVE of six: a field was stored,
 * projected and registered, and never returned on read. The test asserted the
 * graph and stopped, so it was green over a value no reader could see.
 * ⇒ This asserts the JOIN — write it through the front door, read it back, and
 * check the LOOP's own output — rather than any one layer's triple.
 * ──────────────────────────────────────────────────────────────────────────── */
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const api = async (base, method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('#1271 the toggle survives the whole seam: PATCH → read back → the LOOP\'s prompt', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const created = await api(srv.baseUrl, 'POST', '/api/agents', {
      seatKey: 'gizmo', prompt: 'Be brief.', residency: 'resident', by: 'ada',
      model: { model: 'fake', protocol: 'ollama-native', baseUrl: 'http://127.0.0.1:1' },
    });
    assert.equal(created.status, 201);

    // Default: absent on read, and the loop sends no policy.
    const fresh = (await api(srv.baseUrl, 'GET', '/api/agents')).body.find((a) => a.seatKey === 'gizmo');
    assert.ok(!fresh.participationClause, 'default is off, and READABLE as off');
    assert.ok(!systemOf(fresh).includes(POLICY), 'the loop agrees with the read');

    // Turn it on through the front door.
    const on = await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { participationClause: true, by: 'ada' });
    assert.equal(on.status, 200, 'the field is accepted, not silently dropped');
    const after = (await api(srv.baseUrl, 'GET', '/api/agents')).body.find((a) => a.seatKey === 'gizmo');
    assert.equal(after.participationClause, true, 'READ BACK — the layer missed last night');
    assert.ok(systemOf(after).includes(POLICY),
      'and the LOOP sees it. A stored value no loop reads is #1260; a value no reader sees is last night.');

    // And off again, because a toggle that cannot be turned back is a delete.
    await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { participationClause: false, by: 'ada' });
    const off = (await api(srv.baseUrl, 'GET', '/api/agents')).body.find((a) => a.seatKey === 'gizmo');
    assert.equal(off.participationClause, false);
    assert.ok(!systemOf(off).includes(POLICY), 'reversible in both directions');
  } finally { await srv.stop(); }
});

test('#1271 a typo in the field name is REFUSED, not swallowed', async () => {
  // #1196's rule, inherited: a config write that silently drops a field reads as
  // "configured" forever while doing nothing.
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    await api(srv.baseUrl, 'POST', '/api/agents', {
      seatKey: 'gizmo', prompt: 'Be brief.', residency: 'resident', by: 'ada',
      model: { model: 'fake', protocol: 'ollama-native', baseUrl: 'http://127.0.0.1:1' },
    });
    const typo = await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { participationClaus: true, by: 'ada' });
    assert.equal(typo.status, 400, 'unknown field refused by name');
  } finally { await srv.stop(); }
});
