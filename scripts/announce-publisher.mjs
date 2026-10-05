#!/usr/bin/env node
/**
 * #1574 C3b — the announcement PUBLISHER: a clock, not a decider.
 *
 *   node scripts/announce-publisher.mjs --board URL --key-file FILE --status FILE [--once] [--batch N]
 *        [--scan-every-ms N] [--audit-every-ms N]
 *
 * A scan reads the board's pending obligations (GET /api/outbox?status=pending), oldest first by the frozen
 * payload's occurredAt, and asks the board to publish at most N of them (POST /api/outbox/:id/publish), one at
 * a time. Every decision — verify a legacy proof, write a post, block — is the SERVER's, under its lock; this
 * process only says "now". An audit reads the whole outbox and counts integrity failures (auditOutbox).
 *
 * --once   one scan then one audit; exit 0 when both completed (a BLOCKED entry is an outcome, not an error),
 *          non-zero when the board could not be reached or answered with an error.
 * default  loop forever on the nextActions() schedule (scan every 5 s, audit every 60 s).
 *
 * The status file is rewritten on every run/tick:
 *   {checkedAt, lastScanCompletedAt, pendingCount, oldestPendingAt, blockedCount, lastError, auditIntegrityFailures}
 * It is the only thing this process writes, and it keeps no other state. It ENABLES detection of a dead
 * publisher (a stale checkedAt); nothing consumes it yet.
 *
 * The key file holds the board bearer token. It is sent as `Authorization: Bearer …` and never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditOutbox } from '../core/announce-outbox.mjs';

/**
 * PURE schedule. A side that has never run is due; otherwise it is due when now - last >= every.
 * The two sides are independent.
 */
export function nextActions({ nowMs, lastScanAt, lastAuditAt, scanEveryMs, auditEveryMs }) {
  const due = (last, every) => last == null || nowMs - last >= every;
  return { scan: due(lastScanAt, scanEveryMs), audit: due(lastAuditAt, auditEveryMs) };
}

const occurredAtOf = (e) => {
  const t = Date.parse(e?.payload?.occurredAt);
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
};
/** Oldest first; ties broken by obligationId so the order is total. */
export const oldestFirst = (entries) => [...entries].sort((a, b) => (occurredAtOf(a) - occurredAtOf(b))
  || String(a.obligationId).localeCompare(String(b.obligationId)));

function parseArgs(argv) {
  const out = { once: false, batch: 50, scanEveryMs: 5000, auditEveryMs: 60000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--board') out.board = val().replace(/\/$/, '');
    else if (a === '--key-file') out.keyFile = val();
    else if (a === '--status') out.status = val();
    else if (a === '--once') out.once = true;
    else if (a === '--batch') out.batch = Number(val());
    else if (a === '--scan-every-ms') out.scanEveryMs = Number(val());
    else if (a === '--audit-every-ms') out.auditEveryMs = Number(val());
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.board || !out.keyFile || !out.status) throw new Error('--board, --key-file and --status are required');
  if (!Number.isInteger(out.batch) || out.batch < 1) throw new Error('--batch must be a positive integer');
  return out;
}

function makeClient(board, key) {
  return async function call(method, route) {
    let res;
    try {
      res = await fetch(`${board}${route}`, {
        method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        ...(method === 'POST' ? { body: '{}' } : {}), signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw new Error(`board unreachable: ${method} ${route}: ${e?.cause?.code || e?.name || e?.message || e}`);
    }
    const text = await res.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, body };
  };
}

async function readOutbox(call, query = '') {
  const r = await call('GET', `/api/outbox${query}`);
  if (r.status !== 200 || !r.body || !Array.isArray(r.body.entries) || !Array.isArray(r.body.origins)) {
    throw new Error(`GET /api/outbox${query}: HTTP ${r.status}`);
  }
  return r.body;
}

/** One scan: publish at most `batch` pending entries, oldest first. Throws on a transport or server error. */
async function scan(call, batch) {
  const { entries } = await readOutbox(call, '?status=pending');
  for (const e of oldestFirst(entries).slice(0, batch)) {
    const r = await call('POST', `/api/outbox/${encodeURIComponent(e.obligationId)}/publish`);
    if (r.status === 404) continue;   // gone since the read: nothing to do
    if (r.status >= 500 || !r.body || typeof r.body.status !== 'string') {
      throw new Error(`publish ${e.obligationId}: HTTP ${r.status}`);
    }
  }
}

/** The audit and the counts, from ONE read of the whole outbox. */
async function survey(call) {
  const ob = await readOutbox(call);
  const doc = { announcementOutbox: {
    origins: Object.fromEntries(ob.origins.map((o) => [o.mutationId, o])),
    entries: Object.fromEntries(ob.entries.map((e) => [e.obligationId, e])),
  } };
  const pending = oldestFirst(ob.entries.filter((e) => e.status === 'pending'));
  return {
    pendingCount: pending.length,
    oldestPendingAt: pending.length ? (pending[0].payload?.occurredAt ?? null) : null,
    blockedCount: ob.entries.filter((e) => e.status === 'blocked').length,
    auditIntegrityFailures: auditOutbox(doc).failures.length,
  };
}

function writeStatus(file, status) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

async function tick(opts, call, mem, { doScan, doAudit }) {
  let lastError = null;
  try {
    if (doScan) { await scan(call, opts.batch); mem.lastScanCompletedAt = new Date().toISOString(); mem.lastScanAt = Date.now(); }
    if (doAudit || doScan) {
      const s = await survey(call);
      Object.assign(mem.counts, s);
      if (doAudit) mem.lastAuditAt = Date.now();
    }
  } catch (e) {
    lastError = String(e?.message || e);
  }
  writeStatus(opts.status, {
    checkedAt: new Date().toISOString(),
    lastScanCompletedAt: mem.lastScanCompletedAt,
    pendingCount: mem.counts.pendingCount,
    oldestPendingAt: mem.counts.oldestPendingAt,
    blockedCount: mem.counts.blockedCount,
    lastError,
    auditIntegrityFailures: mem.counts.auditIntegrityFailures,
  });
  return lastError;
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(`announce-publisher: ${e.message}`); return 2; }
  const mem = { lastScanAt: null, lastAuditAt: null, lastScanCompletedAt: null,
    counts: { pendingCount: null, oldestPendingAt: null, blockedCount: null, auditIntegrityFailures: null } };
  let key;
  try { key = fs.readFileSync(opts.keyFile, 'utf8').trim(); } catch (e) {
    const msg = `key file unreadable: ${e.code || e.message}`;
    try { writeStatus(opts.status, { checkedAt: new Date().toISOString(), lastScanCompletedAt: null, pendingCount: null, oldestPendingAt: null, blockedCount: null, lastError: msg, auditIntegrityFailures: null }); } catch { /* nowhere to say it */ }
    console.error(`announce-publisher: ${msg}`);
    return 2;
  }
  const call = makeClient(opts.board, key);
  if (opts.once) {
    const err = await tick(opts, call, mem, { doScan: true, doAudit: true });
    if (err) console.error(`announce-publisher: ${err}`);
    return err ? 1 : 0;
  }
  for (;;) {
    const due = nextActions({ nowMs: Date.now(), lastScanAt: mem.lastScanAt, lastAuditAt: mem.lastAuditAt, scanEveryMs: opts.scanEveryMs, auditEveryMs: opts.auditEveryMs });
    if (due.scan || due.audit) {
      const err = await tick(opts, call, mem, { doScan: due.scan, doAudit: due.audit });
      if (err) { console.error(`${new Date().toISOString()} announce-publisher: ${err}`); mem.lastScanAt = Date.now(); }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`announce-publisher: ${e?.stack || e}`); process.exit(1); });
}
