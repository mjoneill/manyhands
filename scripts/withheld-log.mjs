#!/usr/bin/env node
/**
 * scripts/withheld-log.mjs — #1952 read a seat's withheld-reply log, locally.
 *
 *   node scripts/withheld-log.mjs --seat <seat> [--state-file <path>]
 *
 * Prints the seat's held-back replies, newest first: when, which wake, why,
 * how many tokens, which model, and the full text.
 *
 * Which file: the log sits beside the runner's state file
 * (`<state file>.withheld-log.json`, core/withheld-log.mjs). The state file is
 *   1. --state-file <path>, else
 *   2. $SCRUM_GUEST_STATE_FILE (what the launchd job sets), else
 *   3. ~/.claude/scrum-guest-wake-<seat>.state.json — the path
 *      scripts/install-guest-wake.sh gives that job.
 *
 * ⛔ PRIVACY LINE (#1952): for the machine's owner. Never post or quote it to
 * the room without the seat's say-so; a standalone NO_REPLY is a deliberate
 * choice of silence (#1351), so some entries are drafts she chose not to send.
 * This command reads ONLY the log file. It never reads the state file itself,
 * a token or key file, or anything on the board.
 */
import os from 'node:os';
import path from 'node:path';
import { readWithheldLog, defaultWithheldLogPath, formatWithheldLog } from '../core/withheld-log.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const usage = 'usage: withheld-log.mjs --seat <seat> [--state-file <path>]';

const seat = opt('--seat');
if (!seat) { console.error(usage); process.exit(2); }
// A seat key is a name, never a path: it is spliced into the default file name.
if (!/^[A-Za-z0-9_-]+$/.test(seat)) { console.error(`not a seat key: ${JSON.stringify(seat)}\n${usage}`); process.exit(2); }

const stateFile = opt('--state-file') || process.env.SCRUM_GUEST_STATE_FILE
  || path.join(os.homedir(), '.claude', `scrum-guest-wake-${seat}.state.json`);
const file = defaultWithheldLogPath(path.resolve(stateFile));

const { entries, status } = readWithheldLog(file);
console.log(`Withheld replies for ${seat} — ${file}`);
if (status === 'corrupt') { console.error('the log file exists but could not be read as a withheld log'); process.exit(1); }
console.log(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (kept: the last 10, and only the last 7 days)\n`);
console.log(formatWithheldLog(entries));
