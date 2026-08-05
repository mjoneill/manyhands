#!/usr/bin/env node
/**
 * scripts/redact.mjs — #681, the emergency redaction tool.
 *
 * Ruled on #642 R8, option (b): build the tool rather than rely on a refusal,
 * so that an emergency is met with something that works. This is that tool. It
 * removes named field content from BOTH surfaces — the event log and the served
 * store — and records what/when/who/why.
 *
 * ⚠️ DELIBERATELY NOT AN API ENDPOINT. Redaction over HTTP would be reachable by
 * anything that can reach the board, and the op rewrites history. It is a CLI a
 * human runs, on the host, citing who ordered it. The absence is the design; see
 * SPEC "structural rails" — a deleted option and a forbidden one look identical
 * from downstream, so this comment is the decision written down.
 *
 * DRY RUN IS THE DEFAULT. Nothing is written without --confirm.
 *
 *   node scripts/redact.mjs --kind card --id 681 --fields title,description \
 *     --actor <seat> --authority "<who ordered it, and where they said so>" \
 *     --reason "third-party name" [--confirm]
 *
 * ⚠️ THE CAS ABORT IS NOT COVERED BY THE SUITE. It is a race, so a test for it
 * is timing-based and would flake. It was verified by hand and the procedure is
 * recorded here so the proof is reproducible rather than merely claimed:
 *
 *   1. build a fixture board + a ~100k-event log (big enough to widen the window;
 *      ⚠️ stay under ~110k — above that `readEvents` throws, see #684)
 *   2. run a background process rewriting board-data.json in a tight loop
 *   3. run this tool with --confirm
 *   → observed: "✗ ABORT: board-data.json changed while the log was being
 *     redacted", exit 1, and ground-truth grep showing log clean / store dirty —
 *     exactly the partial state the ordering below is chosen to produce.
 *   4. re-run with no writer → 0 log carriers (idempotent), store cleaned,
 *     exit 0, and only ONE redact marker in the log — the aborted run left no
 *     duplicate. (Verified 2026-08-05.)
 *
 * ORDER OF OPERATIONS — log first, then store. The log is the AUTHORITY (#642
 * R2) and the store is a rebuildable projection of it. If the run dies between
 * the two, "log clean / store dirty" is repaired by a rebuild, while "store
 * clean / log dirty" leaves the content in the authority where the next rebuild
 * RESURRECTS it. There is no two-phase commit across two files here, so the
 * ordering is chosen to make the survivable failure the likely one. The sweep is
 * idempotent, so the remedy for a partial run is simply to run it again.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadDomain, saveDomain } from '../core/store.mjs';
import { boardToDomain, domainToBoard } from '../core/mapping.mjs';
import { readEvents, redactEntityEvents, findCarriers, REDACTION_MARKER } from '../core/event-log.mjs';

// Same convention as server.js: env var, else the board beside this checkout.
// ⚠️ Never hardcode a deployment path here — an operator's private tree layout
// is not this repo's business, and a default that only works on one machine is
// not a default. (Caught by the publication gate, which is the correct place
// for it to be caught and not the correct place to be reminded.)
const BOARD = process.env.SCRUM_BOARD_FILE
  || join(dirname(new URL(import.meta.url).pathname), '..', 'board-data.json');
const EVENT_DIR = process.env.SCRUM_EVENT_LOG_DIR || `${BOARD.replace(/\.json$/, '')}-events`;

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const has = (name) => argv.includes(`--${name}`);
const sha = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null);
const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

const kind = flag('kind');
const id = flag('id');
const fields = (flag('fields') || '').split(',').map((s) => s.trim()).filter(Boolean);
const actor = flag('actor');
const authority = flag('authority');
const reason = flag('reason');
const confirm = has('confirm');

if (!kind || !id || !fields.length || !actor || !authority) {
  die('required: --kind --id --fields --actor --authority   (see the header for the full form)');
}
if (!['card', 'conversation'].includes(kind)) die(`--kind must be card|conversation, got "${kind}"`);

// ── locate the target on BOTH surfaces before touching either ──────────────

const board = domainToBoard(loadDomain(BOARD));
const collection = kind === 'card' ? 'cards' : 'conversations';
const match = (x) => String(x.id) === String(id) || String(x.shortId) === String(id);
const entity = (board[collection] || []).find(match);

const logHits = readEvents(EVENT_DIR).filter((e) => e.op !== 'redact'
  && e.entity?.kind === kind
  && (entity ? String(e.entity.id) === String(entity.id) : String(e.entity.id) === String(id))
  && e.state && fields.some((f) => e.state[f] !== undefined && e.state[f] !== REDACTION_MARKER));

if (!entity && !logHits.length) {
  die(`no ${kind} "${id}" on either surface — nothing to redact, and a silent success here would be a lie`);
}

console.log(`\n  target      ${kind} ${id}${entity ? ` (${entity.id})` : '  ⚠️ not in store — log only'}`);
console.log(`  fields      ${fields.join(', ')}`);
console.log(`  authority   ${authority}`);
console.log(`  actor       ${actor}${reason ? `\n  reason      ${reason}` : ''}`);
console.log(`\n  LOG    ${logHits.length} event(s) carry content: seq ${logHits.map((e) => e.seq).join(', ') || '—'}`);
// ⚠️ The preview shows real content ONLY in a dry run. Under --confirm the
// output is a RECEIPT, and in this room receipts get pasted into the commons as
// evidence — which is how content leaks in the first place. The operator needs
// to see the value while DECIDING; once the decision is made, showing it again
// only creates a copy in a terminal buffer, a scrollback, and a paste.
for (const f of fields) {
  const v = entity?.[f];
  const present = v !== undefined && v !== REDACTION_MARKER;
  const shown = !present ? '— (absent or already redacted)'
    : confirm ? `present (${String(v).length} chars) — value withheld from the receipt`
      : `${JSON.stringify(String(v).slice(0, 60))}…`;
  console.log(`  STORE  ${f}: ${shown}`);
}

if (!confirm) {
  console.log('\n  DRY RUN — nothing written. Re-run with --confirm to apply.\n');
  process.exit(0);
}

// ── compare-and-swap: the board is served live and never quiesces ──────────
// `launchctl stop` is useless under KeepAlive and `bootout` disables the job, so
// the tool assumes a live writer rather than pretending to stop one. readBoard()
// reads per request, so no restart is needed either — only that nobody wrote
// between our read and our write.
const before = sha(BOARD);

// 1 ── LOG FIRST (see the header for why this order).
const { seqs, removedValues } = redactEntityEvents(EVENT_DIR, { kind, id: entity ? entity.id : id, fields, actor, authority, reason });
console.log(`\n  ✓ log    redacted ${seqs.length} event(s)${seqs.length ? `: seq ${seqs.join(', ')}` : ''}`);

// 2 ── STORE, under CAS.
if (entity) {
  if (sha(BOARD) !== before) {
    die('ABORT: board-data.json changed while the log was being redacted. The LOG is clean; '
      + 'the STORE is not. Re-run this command — the sweep is idempotent and will finish the job.');
  }
  const backups = join(dirname(BOARD), 'backups');
  if (!existsSync(backups)) mkdirSync(backups, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  copyFileSync(BOARD, join(backups, `board-data-backup-${stamp}-pre-redact.json`));

  const fresh = domainToBoard(loadDomain(BOARD));
  const target = (fresh[collection] || []).find(match);
  for (const f of fields) if (target[f] !== undefined) target[f] = REDACTION_MARKER;
  fresh.lastUpdated = new Date().toISOString();

  // Last check before the write. The window between this and saveDomain is
  // microseconds and synchronous, but it is NOT zero — this is the honest best
  // available without file locking, and calling it "atomic" would overclaim.
  if (sha(BOARD) !== before) die('ABORT: board-data.json changed at the write boundary. Log is clean; re-run.');
  saveDomain(BOARD, boardToDomain(fresh), { now: fresh.lastUpdated });
  console.log(`  ✓ store  ${fields.join(', ')} → ${REDACTION_MARKER}  (backup in backups/)`);
}

// 3 ── VERIFY, on the files as they now are — not on what we believe we wrote.
const logClean = !readEvents(EVENT_DIR).some((e) => e.entity?.kind === kind
  && e.state && fields.some((f) => e.state[f] !== undefined && e.state[f] !== REDACTION_MARKER
    && String(e.entity.id) === String(entity ? entity.id : id)));
const after = domainToBoard(loadDomain(BOARD));
const t = (after[collection] || []).find(match);
const storeClean = !t || fields.every((f) => t[f] === undefined || t[f] === REDACTION_MARKER);

console.log(`\n  verify   log ${logClean ? '✓' : '✗ CONTENT REMAINS'}   store ${storeClean ? '✓' : '✗ CONTENT REMAINS'}`);
if (!logClean || !storeClean) die('the redaction did NOT fully apply — do not report this as done');

// ── scope honesty (verification finding) ───────────────────────────
// Everything above proves THIS ENTITY is clean. The operator's actual goal is
// "the string is gone", which is a strictly larger claim — and in this room
// posts quote cards constantly, so copies are the norm rather than the edge
// case. Report other carriers by LOCATION ONLY; never echo what was found, and
// never auto-redact: a different entity is a different decision.
const others = findCarriers(EVENT_DIR, removedValues, { excludeSeqs: seqs });
const storeOthers = [];
for (const coll of ['cards', 'conversations']) {
  for (const x of after[coll] || []) {
    if (entity && String(x.id) === String(entity.id)) continue;
    for (const [f, v] of Object.entries(x)) {
      if (typeof v === 'string' && removedValues.some((n) => v.includes(n))) {
        storeOthers.push(`${coll.slice(0, -1)} ${x.shortId ?? x.id} · ${f}`);
      }
    }
  }
}

if (others.length || storeOthers.length) {
  console.log(`\n  ⚠️  THIS ENTITY IS CLEAN — THE STRING IS NOT GONE.`);
  console.log(`      ${others.length} other log event(s) and ${storeOthers.length} other store record(s) still carry it:`);
  for (const c of others) console.log(`        log    seq ${c.seq}  ${c.kind}/${c.id} · ${c.field}`);
  for (const s of storeOthers) console.log(`        store  ${s}`);
  console.log('      Locations only — the content is deliberately not echoed here.');
  console.log('      Each is a separate decision and a separate invocation. Nothing else was touched.\n');
} else {
  console.log('  done — both surfaces clean, and no other carriers found.\n');
}
