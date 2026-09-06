/**
 * #1195 — THE WATCH MUST NAME THE STALE SEAT, NOT COUNT STREAMS.
 *
 * The 2026-09-05 instance, both sides instrumented: a deploy restarted the MCP
 * server at 05:44Z; one seat's client kept re-sending a session id the server
 * had already reaped (3 hits over 7.5 h) and held no open stream; the OTHER
 * seat re-registered in 18 minutes and held streams all night. So `receivers`
 * never fell below the floor, no drop was ever armed, and the durable watch —
 * built for exactly this — said nothing for seven and a half hours while
 * /channel/status carried `staleSessions: [{seat, firstAt, lastAt, hits}]`
 * the whole time.
 *
 * Counting streams cannot see one deaf seat among hearing ones. Naming can.
 * These cases are the shape of that night, with the seat names generalised.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, staleSeats, staleFacts } from '../scripts/fanout-decide.mjs';

const HOUR = 3600 * 1000;
const T0 = 1_757_050_000_000;
const base = { floor: 3, cooldownMs: 6 * HOUR, now: T0, receivers: 3, sessions: 6 };
const healthy = { r: 3, s: 6, pendingFrom: null, warned: false, sigTimes: {}, hist: [3, 3, 3, 3, 3, 3] };

// /channel/status as it read at 06:00Z that night, seat names generalised.
const STATUS_THAT_NIGHT = {
  binding: 'active',
  receivers: 3, sessions: 6, unbound: 2,
  seats: { alpha: { streams: 0, sessions: 1 }, beta: { streams: 3, sessions: 2 }, healthcheck: { streams: 0, sessions: 1 } },
  staleSessions: [
    { sid: '68e2fb34', seat: 'alpha', hits: 3, firstAt: '2026-09-05T05:44:34.000Z', lastAt: '2026-09-05T13:19:41.000Z' },
    { sid: 'ff5832be', seat: 'beta', hits: 2, firstAt: '2026-09-05T05:44:34.000Z', lastAt: '2026-09-05T06:02:03.000Z' },
    { sid: 'c0ffee00', seat: null, hits: 9, firstAt: '2026-09-05T05:44:35.000Z', lastAt: '2026-09-05T13:00:00.000Z' },
  ],
};

test('#1195 staleSeats(): a seat is STALE only when it loops on a reaped id AND holds no stream', () => {
  const stale = staleSeats(STATUS_THAT_NIGHT);
  assert.deepEqual(stale.map((s) => s.seat), ['alpha'],
    'beta re-registered (3 streams) so she can hear; the unbound sid names nobody and cannot be a seat');
  assert.equal(stale[0].firstAt, '2026-09-05T05:44:34.000Z');
  assert.equal(stale[0].hits, 3);
});

test('#1195 the night itself: receivers at the floor, nothing armed — and the watch still names the deaf seat', () => {
  const stale = staleSeats(STATUS_THAT_NIGHT);
  const { warnBody } = decide({ ...base, state: healthy, staleSeats: stale });
  assert.ok(warnBody, 'no drop, no floor breach — the stream counters were silent all night and this must not be');
  assert.match(warnBody, /alpha/, 'the SEAT is named');
  assert.match(warnBody, /05:44/, 'and since WHEN');
  assert.match(warnBody, /no open stream|deaf/i);
  assert.doesNotMatch(warnBody, /beta/, 'a seat that re-registered is not accused');
  assert.match(warnBody, /human|restart/i, 'the only measured repair is named, not a tool-call cure (#664 header)');
});

test('#1195 one episode warns ONCE; a new episode (new firstAt) warns again', () => {
  const stale = staleSeats(STATUS_THAT_NIGHT);
  const t1 = decide({ ...base, state: healthy, staleSeats: stale });
  assert.ok(t1.warnBody);
  const t2 = decide({ ...base, now: T0 + 300_000, state: t1.state, staleSeats: stale });
  assert.equal(t2.warnBody, null, 'same seat, same episode — silent on the next tick');
  const later = [{ ...stale[0], firstAt: '2026-09-06T01:00:00.000Z', hits: 1 }];
  const t3 = decide({ ...base, now: T0 + 600_000, state: t2.state, staleSeats: later });
  assert.ok(t3.warnBody, 'a NEW deafness episode for the same seat is a new fact');
  assert.match(t3.warnBody, /alpha/);
});

test('#1195 CONTROL: no stale seats → unchanged behaviour, no warning', () => {
  const { warnBody, state } = decide({ ...base, state: healthy, staleSeats: [] });
  assert.equal(warnBody, null);
  assert.equal(state.r, 3);
});

test('#1195 CONTROL: a stale seat that recovers (streams > 0) stops being named and the episode clears', () => {
  const stale = staleSeats(STATUS_THAT_NIGHT);
  const t1 = decide({ ...base, state: healthy, staleSeats: stale });
  assert.ok(t1.warnBody);
  const recovered = { ...STATUS_THAT_NIGHT, seats: { ...STATUS_THAT_NIGHT.seats, alpha: { streams: 1, sessions: 1 } } };
  const t2 = decide({ ...base, now: T0 + 300_000, state: t1.state, staleSeats: staleSeats(recovered) });
  assert.equal(t2.warnBody, null);
  assert.deepEqual(t2.state.staleEpisodes ?? {}, {}, 'the episode is forgotten once the seat can hear');
});

test('#1195 a stale seat AND a floor breach in one tick produce ONE body carrying both', () => {
  const stale = staleSeats(STATUS_THAT_NIGHT);
  const { warnBody } = decide({ ...base, receivers: 1, sessions: 6, state: { ...healthy, r: 1, hist: [1, 1, 1, 1] }, staleSeats: stale });
  assert.ok(warnBody);
  assert.match(warnBody, /only 1 of 6/);
  assert.match(warnBody, /alpha/);
});


// 2026-09-06 — FLAP: the same reaped-id fact, the seat's stream restarted by its
// own health monitor between ticks, re-warned four times in forty minutes.
test('#1195 an episode is the reaped-id FACT: a seat that briefly holds a stream and drops again on the same firstAt is NOT re-warned; a new firstAt is', () => {
  const T0 = 1_757_060_000_000; const MIN = 60_000;
  const base = { floor: 3, cooldownMs: 6 * 3600 * 1000, receivers: 5, sessions: 12 };
  const mk = (streams, firstAt = '2026-09-06T00:16:29.799Z') => ({
    receivers: 5, sessions: 12, seats: { alpha: { streams }, beta: { streams: 1 } },
    staleSessions: [{ seat: 'alpha', firstAt, lastAt: firstAt, hits: 2 }],
  });
  let state = { r: 5, s: 12, sigTimes: {}, hist: [5, 5, 5, 5, 5, 5] };
  const posts = [];
  const tick = (t, status) => {
    const out = decide({ ...base, now: t, state, staleSeats: staleSeats(status), staleFacts: staleFacts(status), stoppedSeats: [] });
    state = out.state; if (out.warnBody && /DEAF SEAT NAMED/.test(out.warnBody)) posts.push(t);
  };
  tick(T0, mk(0));                       // deaf: named
  tick(T0 + 5 * MIN, mk(1));             // stream restarted by the health monitor; fact still present
  tick(T0 + 10 * MIN, mk(0));            // dropped again, SAME fact → silent
  tick(T0 + 15 * MIN, mk(1));
  tick(T0 + 20 * MIN, mk(0));
  assert.equal(posts.length, 1, `one alarm for one fact, got ${posts.length}`);
  // The fact leaves the payload, then a NEW episode (new firstAt) → warns again.
  const clean = { receivers: 5, sessions: 12, seats: { alpha: { streams: 1 }, beta: { streams: 1 } }, staleSessions: [] };
  tick(T0 + 25 * MIN, clean);
  assert.deepEqual(state.staleEpisodes, {}, 'the episode ends when the fact is gone');
  tick(T0 + 30 * MIN, mk(0, '2026-09-06T01:00:00.000Z'));
  assert.equal(posts.length, 2, 'a new reaped-id fact is a new episode');
  // Backward compatibility: without staleFacts the old rule applies (documented, not silently changed).
  let old = { r: 5, s: 12, sigTimes: {}, hist: [5, 5, 5, 5, 5, 5] }; let n = 0;
  for (const [t, st] of [[T0, mk(0)], [T0 + 5 * MIN, mk(1)], [T0 + 10 * MIN, mk(0)]]) { const o = decide({ ...base, now: t, state: old, staleSeats: staleSeats(st), stoppedSeats: [] }); old = o.state; if (o.warnBody) n++; }
  assert.equal(n, 2, 'the pre-fix rule re-warns on the flap — this is the defect, kept reachable so the fix is falsifiable');
});
