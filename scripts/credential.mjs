#!/usr/bin/env node
/**
 * scripts/credential.mjs — #1343: mint / list / revoke / migrate seat credentials.
 *
 * This is the RECOVERY PATH and the only minting path: it edits the file at
 * the box and never speaks HTTP, so it works whatever SCRUM_AUTH a server runs
 * (a process in `required` refuses loopback and network alike — there is no
 * exempt HTTP door; the way in is this script).
 *
 *   mint     --seat <seat> --scope read|act|admin --by <who> [--days 30] [--note …] [--write-runner-file <path>]
 *            prints the plaintext ONCE on stdout (and nothing else, so it can be piped);
 *            with --write-runner-file it prints NOTHING and writes the value 0600 to that path
 *            (the residents' mechanism: SCRUM_SEAT_TOKEN_FILE on the runner's plist).
 *   list     seats, scopes, expiry, state — never a value, never a hash
 *   revoke   --seat <seat> --by <who>      sets revokedAt on the seat's live credentials (an event, not a deletion)
 *   migrate  --by <who> [--days 90]        rewrites #703 plaintext rows as hashes, in place; idempotent
 *
 * The file: --file <path>, else $SCRUM_SEAT_TOKENS. No default — a default
 * naming the operator's private tree would be a publication (redact.mjs's rule).
 * Writes are atomic (temp + rename) and keep the file 0600.
 */
import fs from 'node:fs';
import path from 'node:path';
import { mintToken, hashToken, loadCredentials, migrateCredentialsDoc, SCOPES, README } from '../core/credentials.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(name);
const die = (msg) => { process.stderr.write(`credential: ${msg}\n`); process.exit(1); };

const file = opt('--file') || process.env.SCRUM_SEAT_TOKENS;
if (!cmd || !['mint', 'list', 'revoke', 'migrate'].includes(cmd)) die('usage: credential.mjs mint|list|revoke|migrate … (see the header of this script)');
if (!file) die('UNAVAILABLE: pass --file <seat-tokens.json> or set SCRUM_SEAT_TOKENS');

function readDoc() {
  if (!fs.existsSync(file)) return { _README: README, seats: {} };
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die(`${file} is not JSON (${e.message}) — fix it by hand before minting into it`); }
}
function writeDoc(doc) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}
const now = new Date().toISOString();
const by = opt('--by');
const needBy = () => { if (!by) die('--by <who> is required — the issuer is part of the record'); };

if (cmd === 'mint') {
  needBy();
  const seat = opt('--seat'); if (!seat || !/^[a-z0-9][a-z0-9._-]*$/i.test(seat)) die('--seat <seat> is required (a seat key)');
  const scope = opt('--scope'); if (!SCOPES.includes(scope)) die(`--scope must be one of ${SCOPES.join('|')}`);
  const days = Number(opt('--days') ?? 30); if (!(days > 0)) die('--days must be a positive number');
  const note = opt('--note') ?? null;
  const runnerFile = opt('--write-runner-file');
  const plain = mintToken();
  const doc = readDoc();
  doc.seats ??= {};
  doc.seats[seat] ??= {};
  doc.seats[seat].credentials ??= [];
  doc.seats[seat].credentials.push({
    tokenHash: hashToken(plain), scope, issuedAt: now,
    expiresAt: new Date(Date.now() + days * 86400_000).toISOString(),
    issuedBy: by, revokedAt: null, note,
  });
  if (!Array.isArray(doc._README) || !doc._README.some((l) => /hash/i.test(l))) doc._README = README;
  writeDoc(doc);
  if (runnerFile) {
    fs.mkdirSync(path.dirname(runnerFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(runnerFile, plain + '\n', { mode: 0o600 });
    fs.chmodSync(runnerFile, 0o600);
    process.stderr.write(`credential: minted ${scope} for ${seat} (expires in ${days} d); value written to ${runnerFile} (0600), not printed\n`);
  } else {
    process.stderr.write(`credential: minted ${scope} for ${seat} (expires in ${days} d) — the value below is shown ONCE; the file holds its hash\n`);
    process.stdout.write(plain + '\n');
  }
} else if (cmd === 'list') {
  const creds = loadCredentials(file, { warn: () => {} });
  const doc = readDoc();
  const legacy = new Set(creds.legacy);
  const rows = [];
  for (const [seat, entry] of Object.entries(doc.seats ?? {})) {
    for (const c of Array.isArray(entry.credentials) ? entry.credentials : []) {
      const state = c.revokedAt ? 'revoked' : (c.expiresAt && Date.parse(c.expiresAt) <= Date.now()) ? 'EXPIRED' : 'live';
      rows.push([seat, c.scope ?? 'act', (c.issuedAt ?? '').slice(0, 10), (c.expiresAt ?? '').slice(0, 10), state, c.note ?? '']);
    }
    if (legacy.has(seat)) rows.push([seat, 'act', '', '', 'PLAINTEXT (#703 row — run migrate)', '']);
  }
  if (!rows.length) { process.stdout.write(`(no credentials in ${file})\n`); process.exit(0); }
  const w = rows.reduce((a, r) => r.map((c, i) => Math.max(a[i] ?? 0, String(c).length)), [4, 5, 6, 7, 5, 4]);
  const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd() + '\n';
  process.stdout.write(line(['seat', 'scope', 'issued', 'expires', 'state', 'note']));
  for (const r of rows) process.stdout.write(line(r));
} else if (cmd === 'revoke') {
  needBy();
  const seat = opt('--seat'); if (!seat) die('--seat <seat> is required');
  const doc = readDoc();
  const entry = doc.seats?.[seat];
  if (!entry) die(`no seat ${seat} in ${file}`);
  let n = 0;
  for (const c of Array.isArray(entry.credentials) ? entry.credentials : []) {
    if (!c.revokedAt) { c.revokedAt = now; c.revokedBy = by; n++; }
  }
  if (typeof entry.token === 'string') die(`${seat} holds a #703 PLAINTEXT row — run migrate first, then revoke`);
  writeDoc(doc);
  process.stderr.write(`credential: revoked ${n} credential(s) for ${seat} at ${now} (kept in the file as events)\n`);
} else if (cmd === 'migrate') {
  needBy();
  const days = Number(opt('--days') ?? 90); if (!(days > 0)) die('--days must be a positive number');
  const { doc, migrated } = migrateCredentialsDoc(readDoc(), { now, issuedBy: by, days });
  if (!migrated.length) { process.stdout.write(`nothing to migrate: ${file} holds no plaintext rows\n`); process.exit(0); }
  writeDoc(doc);
  process.stdout.write(`migrated ${migrated.length} plaintext row(s) to hashes (scope act, ${days} d): ${migrated.join(', ')}\n`);
}
