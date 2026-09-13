#!/usr/bin/env node
/**
 * #1324 — after an MCP restart, NAME the seats that did not come back.
 *
 * deploy.sh verified the SERVER (mcp 200 · rest 200 · serving <sha>) and
 * called the deploy done. That proves the process returned; it proves nothing
 * about who RECONNECTED to it. A Claude Code seat bound to :3001 does not
 * reconnect on its own (#697) — a human runs /mcp reconnect — so every MCP
 * restart is a chance for a seat to go deaf while sending fine. Measured:
 * 57 min (09-09), 12 h (09-10), 51 h (09-10→09-13) — two seats, three deploys.
 *
 * The data was in a payload the deployer had already fetched. /channel/status
 * on :3001 carries, per seat, `streams` (RECEIVING) and `lastClientRequestAt`
 * (the newest request the seat's client made). Snapshot it BEFORE the restart
 * and again AFTER a settle window, and two shapes fall out:
 *
 *   dropped  the seat had a stream before and has none after (or is absent —
 *            sessionMeta is in-memory, a restart empties it, absence is the
 *            common case for a seat nothing rebound)
 *   held     the seat has a stream after, and its client has made no request
 *            since the restart. ⭐ THIS is the quiet shape: streams=1 read
 *            healthy for twelve hours with a dead client behind it. Read
 *            from source (mcp-server.mjs, the #717 stamp): every request
 *            that carries a session id moves lastClientRequestAt, and a
 *            restart empties sessionMeta, so a seat with a stream after a
 *            REAL restart has necessarily spoken after it. `held` after a
 *            deploy therefore means the restart did not actually empty the
 *            table (kickstart did not kill, or the clock is wrong) — a
 *            finding, not a false positive. The 12-hour shape between
 *            restarts belongs to the fanout watch (#717), not to a 30 s
 *            settle window.
 *
 * Only seats that were RECEIVING before the restart (streams > 0) are judged:
 * the healthcheck sits at streams=0 permanently and is fine, and a seat that
 * was already deaf is not this restart's doing (it is still deaf; a different
 * instrument — the fanout watch, #717 — owns that).
 *
 * ⛔ It REPORTS, it does not block: no seat can repair another's stream (#664),
 * so a deploy that refused to finish would strand the room. And a snapshot
 * that cannot be read is UNMEASURED, not clean — an all-clear from a missing
 * input is the exact false pass this room keeps paying for.
 *
 * CLI:   node scripts/deploy-seat-check.mjs <before.json> <after.json> <restart-iso> [settle-seconds]
 * Print: the report lines (empty when every receiving seat came back)
 * Exit:  0 report produced (even if seats are named) · 2 unmeasured
 */
import fs from 'node:fs';

const asSnapshot = (x, label) => {
  const obj = typeof x === 'string' ? (() => { try { return JSON.parse(x); } catch { return null; } })() : x;
  if (!obj || typeof obj !== 'object' || !obj.seats || typeof obj.seats !== 'object') {
    throw new Error(`unmeasured: ${label} snapshot is not a /channel/status payload with a seats table`);
  }
  return obj;
};

/**
 * @returns {{seat:string, shape:'dropped'|'held', lastClientRequestAt:string|null}[]}
 * sorted by seat name so the output is stable across runs.
 */
export function seatsNotBack(before, after, restartAtIso) {
  const b = asSnapshot(before, 'before');
  const a = asSnapshot(after, 'after');
  const restartAt = Date.parse(restartAtIso);
  if (!Number.isFinite(restartAt)) throw new Error('unmeasured: restart time is not a date');
  const out = [];
  for (const [seat, was] of Object.entries(b.seats)) {
    if ((was?.streams ?? 0) <= 0) continue;              // was not receiving — not this restart's loss
    const now = a.seats[seat];
    if (!now || (now.streams ?? 0) <= 0) {
      out.push({ seat, shape: 'dropped', lastClientRequestAt: now?.lastClientRequestAt ?? was.lastClientRequestAt ?? null });
      continue;
    }
    const last = now.lastClientRequestAt ? Date.parse(now.lastClientRequestAt) : NaN;
    // Absent stays unknown, and unknown is not "spoke since the restart".
    if (!Number.isFinite(last) || last < restartAt) {
      out.push({ seat, shape: 'held', lastClientRequestAt: now.lastClientRequestAt ?? null });
    }
  }
  return out.sort((x, y) => x.seat.localeCompare(y.seat));
}

/** Human-facing lines for the deploy log and the commons. Empty string when nothing is wrong. */
export function formatReport(rows, { restartAt, settleSeconds }) {
  if (!rows.length) return '';
  const what = (r) => r.shape === 'dropped'
    ? 'stream did not return'
    : `stream is open but the client has not spoken since the restart (last request ${r.lastClientRequestAt ?? 'never'})`;
  const lines = [
    `⛔ ${rows.length} seat${rows.length === 1 ? '' : 's'} not back ${settleSeconds}s after the MCP restart at ${restartAt} (#1324):`,
    ...rows.map((r) => `   ${r.seat.padEnd(12)} ${r.shape.padEnd(8)} ${what(r)}`),
    '   A Claude Code seat needs a human at its terminal to run /mcp reconnect (#697, #664). Sending still works from a deaf seat, so it will not notice on its own.',
    '   Re-check: curl -s http://127.0.0.1:3001/channel/status | jq .seats',
  ];
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [beforePath, afterPath, restartAt, settle = '0'] = process.argv.slice(2);
  try {
    const read = (p, label) => {
      if (!p || !fs.existsSync(p)) throw new Error(`unmeasured: ${label} snapshot file missing (${p ?? 'no path'})`);
      return fs.readFileSync(p, 'utf8');
    };
    const rows = seatsNotBack(read(beforePath, 'before'), read(afterPath, 'after'), restartAt);
    process.stdout.write(formatReport(rows, { restartAt, settleSeconds: Number(settle) }));
  } catch (e) {
    process.stderr.write(`deploy-seat-check: ${e.message}\n`);
    process.exit(2);
  }
}
