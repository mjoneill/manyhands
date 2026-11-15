#!/usr/bin/env node
/**
 * scripts/browser-signin-code.mjs — #1906: a one-time code for a human's browser, minted at the terminal.
 *
 *   --seat <seat>                 print a one-time code for that seat (10 minutes, single use) on stdout, once. The person
 *                                 types it into the sign-in form on the board's settings page. The store keeps its hash.
 *   --revoke-all --seat <seat>    end every browser session of that seat, and burn its unused codes.
 *   --help                        this text, with the honest limit.
 *
 *   --file <path>    the store; else $SCRUM_BROWSER_SESSIONS; else $SCRUM_DATA_DIR/browser-sessions.json. No default beyond
 *                    those: a default naming the operator's tree would be a publication (scripts/credential.mjs's rule).
 *   --roster <path>  the roster; else $SCRUM_ROSTER_FILE; else the repository's roster.json.
 *
 * Refuses any seat the roster does not mark as a human person (`kind: "human"`); the board checks the live roster again
 * when the code is exchanged. Never speaks HTTP. Each mint and each revoke is an event beside the store, with no secret in it.
 */
import { loadRoster, rosterFilePath } from '../core/roster-config.mjs';
import { sessionsPath, updateStore, addCode, revokeAll, appendSessionEvent, groupCode, isHumanSeat, HONEST_LIMIT, CODE_TTL_MS } from '../core/browser-sessions.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(name);
const die = (msg) => { process.stderr.write(`browser-signin-code: ${msg}\n`); process.exit(1); };

const HELP = `usage:
  node scripts/browser-signin-code.mjs --seat <your-seat> [--file <store>] [--roster <roster.json>]
  node scripts/browser-signin-code.mjs --revoke-all --seat <your-seat> [--file <store>]

Prints a one-time code (${CODE_TTL_MS / 60000} minutes, single use) for a seat the roster marks as a human person
(kind: "human"). Type it into "Sign in this browser" on the board's settings page; the browser then holds an
HttpOnly session cookie for 30 days, and its writes are recorded as that seat. Sign out on the same page, or
end every session of the seat with --revoke-all.

The honest limit: ${HONEST_LIMIT}
`;
if (has('--help') || has('-h')) { process.stdout.write(HELP); process.exit(0); }

const store = sessionsPath({ file: opt('--file') });
if (!store) die('UNAVAILABLE: pass --file <browser-sessions.json>, or set SCRUM_BROWSER_SESSIONS or SCRUM_DATA_DIR');
const seat = opt('--seat');
if (!seat || !/^[a-z0-9][a-z0-9._-]*$/i.test(seat)) die('--seat <seat> is required (a seat key). See --help.');
const fromTerminal = !!process.stdin.isTTY;   // a hint for whoever reads the events, not a proof of anything

if (has('--revoke-all')) {
  const n = updateStore(store, (doc) => revokeAll(doc, seat));
  appendSessionEvent(store, { op: 'sessions-revoked', seat, count: n, via: 'script', fromTerminal });
  process.stderr.write(`browser-signin-code: ended ${n} browser session(s) for ${seat} and burned its unused codes\n`);
  process.exit(0);
}

const rosterFile = opt('--roster') || process.env.SCRUM_ROSTER_FILE || rosterFilePath();
let warned = null;
const roster = loadRoster(rosterFile, (m) => { warned = m; });
if (!roster) die(`REFUSED: no roster could be read at ${rosterFile}${warned ? ` (${warned})` : ''}, so no seat is marked as a human person`);
if (!Object.prototype.hasOwnProperty.call(roster, seat)) die(`REFUSED: ${seat} is not in the roster (${rosterFile})`);
if (!isHumanSeat(roster, seat)) die(`REFUSED: ${seat} is not marked as a human person in the roster (its entry needs "kind": "human"). Browser sign-in is for people, not seats run by a model.`);

const { code, expiresAt } = updateStore(store, (doc) => addCode(doc, seat));
appendSessionEvent(store, { op: 'code-minted', seat, expiresAt, via: 'script', fromTerminal });
process.stderr.write(`browser-signin-code: a one-time code for ${seat}, valid until ${expiresAt}, single use. Type it into "Sign in this browser" on the settings page. Shown once; the board keeps only its hash.\n`);
process.stdout.write(groupCode(code) + '\n');
