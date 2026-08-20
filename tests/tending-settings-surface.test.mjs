/**
 * #953 slice 4 — ACCEPTANCE 1: @michael can change `quietAfterMinutes` HIMSELF.
 *
 * ⛔ THE STEWARD DISQUALIFIER, verbatim and binding:
 *
 *   "A control @michael cannot reach. 'Editable by any seat' is a TOOL surface.
 *    He is not a seat. [#804]'s acceptance says the former and his request was
 *    the latter, and only the former got written down."
 *
 * ⇒ So slices 1–3 do not close this card, however green they are. The gate
 * works, the value persists, the runtime re-reads it live — and until it is
 * reachable from the Settings page it is still a setting only we can change,
 * which is precisely the complaint:
 *
 *   @michael, 15:53Z: "I have not set any time. there was no way for me to set
 *   the time intervals… part of the work was building administration so I could
 *   do that very thing. :P"
 *
 * ── WHY THIS MIRRORS /api/config RATHER THAN INVENTING A SHAPE ──────────────
 * #263's channel settings already solve this exact problem on this exact page:
 * loopback-only write, validate-then-persist, 400 with the validator's own
 * message on bad input, and a live re-read so no restart is needed. Copying
 * that contract keeps one pattern instead of two.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const api = async (baseUrl, method, p, body) => {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
};

function withConfigFile() {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tending953-api-')), 'tending-config.json');
  fs.writeFileSync(f, JSON.stringify({ enabled: true, quietAfterMinutes: 20 }, null, 2));
  return f;
}

test('#953 GET /api/tending-config exposes the setting to the page', async () => {
  const file = withConfigFile();
  const s = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_TENDING_CONFIG_FILE: file } });
  try {
    const r = await api(s.baseUrl, 'GET', '/api/tending-config');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.quietAfterMinutes, 20);
    assert.equal(r.body.enabled, true);
  } finally { await s.stop(); }
});

/**
 * ⭐⭐⭐ THE ACCEPTANCE-1 TEST. He changes the value, and it is PERSISTED — which
 * is also acceptance 5, because a restart is a fresh read of this file.
 */
test('#953 POST /api/tending-config changes the value AND persists it', async () => {
  const file = withConfigFile();
  const s = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_TENDING_CONFIG_FILE: file } });
  try {
    const w = await api(s.baseUrl, 'POST', '/api/tending-config', { enabled: true, quietAfterMinutes: 45 });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.equal(w.body.quietAfterMinutes, 45);

    // On disk — acceptance 5. A restart reads this file and nothing else.
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).quietAfterMinutes, 45,
      'the setting must survive the process, or "restart preserves it" is untrue');

    // And readable back through the surface he used.
    assert.equal((await api(s.baseUrl, 'GET', '/api/tending-config')).body.quietAfterMinutes, 45);
  } finally { await s.stop(); }
});

/**
 * ⛔ REFUSE WITH THE VALIDATOR'S OWN MESSAGE. A settings page that silently
 * coerces a typo into a threshold is worse than one that rejects it: the owner
 * would believe he had set something he had not, which is this card's original
 * complaint with an extra step.
 */
test('#953 an invalid value is REFUSED with a readable reason, not coerced', async () => {
  const file = withConfigFile();
  const s = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_TENDING_CONFIG_FILE: file } });
  try {
    for (const bad of [0, -5, '20', null]) {
      const r = await api(s.baseUrl, 'POST', '/api/tending-config', { enabled: true, quietAfterMinutes: bad });
      assert.equal(r.status, 400, `quietAfterMinutes ${JSON.stringify(bad)} must be refused: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /quietAfterMinutes/,
        'the refusal must name the field, or the page cannot tell him what to fix');
    }
    // ⭐ CONTROL: the refusals did not corrupt the stored value.
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).quietAfterMinutes, 20,
      'a rejected write must leave the previous setting intact');
  } finally { await s.stop(); }
});

/**
 * ⛔ THE PAGE ITSELF. An endpoint he cannot see is still a tool surface — the
 * exact disqualifier. This asserts the control exists in the shipped HTML with
 * the id the script binds to, so the two cannot drift apart silently.
 */
test('#953 the Settings PAGE carries the control, not just the API', () => {
  const html = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'settings.html'), 'utf8');
  assert.match(html, /id="quietAfterMinutes"/,
    'settings.html has no quietAfterMinutes input — the value is reachable by seats and not by him, '
    + 'which is the steward disqualifier this card was written against');
  assert.match(html, /\/api\/tending-config/,
    'the page must actually talk to the endpoint');
  assert.match(html, /tending|quiet/i, 'and label it in words he can recognise');
});
