#!/usr/bin/env node
/**
 * manyhands — Local File Sync Server
 *
 * Minimal HTTP server (no dependencies) that:
 *   - Serves static files from the project directory (index.html, etc.)
 *   - Legacy whole-board endpoints (used by the browser UI for now):
 *       POST /api/save   — write whole board-data.json
 *       GET  /api/load   — read whole board-data.json
 *   - Granular endpoints (#90 — agents talk to these instead of editing JSON):
 *       GET    /api/board                  — whole board (cards + columns + meta)
 *       GET    /api/cards                  — all cards
 *       GET    /api/cards/:id              — single card (UUID or shortId)
 *       POST   /api/cards                  — create card (server assigns shortId)
 *       PATCH  /api/cards/:id              — partial update
 *       DELETE /api/cards/:id              — remove card
 *       GET    /api/columns                — all columns
 *       GET    /api/columns/:id            — single column
 *       POST   /api/columns                — create column
 *       PATCH  /api/columns/:id            — partial update (rename, reorder, …)
 *       DELETE /api/columns/:id            — remove column
 *   - Writes are serialized through a single in-process promise mutex —
 *     concurrent PATCH requests from multiple agents do not interleave.
 *   - Same-origin only — no CORS headers, no cross-origin access
 *   - Bound to 127.0.0.1 — no LAN exposure
 *
 * Start: node server.js
 * Port:  3141
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadDomain, saveDomain } from './core/store.mjs';
import { appendEvent } from './core/event-log.mjs';
// #805 — the boot migration's inputs (the live flat sources) and its builder.
import { readPool, recentWhispers, DEFAULT_POOL, poolFilePath } from './whisper-store.mjs';
import { readTendingConfig } from './tending-config.mjs';
import { buildTendingEntities } from './core/tending-bootstrap.mjs';
import { resolveProvenance } from './core/tending-provenance.mjs';
import { boardToDomain, domainToBoard, cardToNode } from './core/mapping.mjs';
import { buildTree, buildChildIndex } from './core/tree.mjs';
import { buildLinkIndex } from './core/links.mjs';
import { commentMetadata } from './core/card-comments.mjs';
import { readConfig, writeConfig, LIMITS } from './channel-config.mjs';
import { loadRoster, writeRoster, rosterFilePath } from './core/roster-config.mjs';
import { extractMentions as extractMentionsFromRoster } from './core/people.mjs';
import { buildGraphStore, queryGraph, syncGraphStore } from './core/graph-replica.mjs';
import { readyFromStore, pageReady, READY_EXPLAIN } from './core/ready-query.mjs';
import { domainToJsonLd } from './core/jsonld.mjs';
import { deriveGraph, personByKey } from './core/people.mjs';
import { queryCards } from './core/cards-query.mjs';
import { queryChangesFromLog } from './core/changes-log-query.mjs';
import { readEvents, oldestRetainedAt } from './core/event-log.mjs';
// #683 — the deafness cure's server half. REST owns the event log, so it owns
// the cursors that index it; mcp-server asks over HTTP rather than learning a
// path it has no business knowing (#767).
import {
  deliveryIdentity, registerFor, serveFor, noteInbound, reachabilityReport,
  discardPendingServes, headSeq, PULL_LIMIT,
} from './core/cursor-service.mjs';
import { configureIdentities, usingDefaultRoster } from './core/identity.mjs';

const PORT = process.env.SCRUM_PORT ? parseInt(process.env.SCRUM_PORT, 10) : 3141;
const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BOARD_DATA_FILE = process.env.SCRUM_BOARD_FILE || path.join(PROJECT_DIR, 'board-data.json');
// #669 — the event log is named FOR ITS BOARD FILE, not merely placed beside it:
//   board-data.json  →  board-data-events/
//
// ⚠️ The first cut used `dirname(BOARD_DATA_FILE)/events` and the comment claimed
// each fixture "gets a throwaway log for free". That was FALSE and the wiring
// tests caught it: every test board lives directly in os.tmpdir(), so all of them
// shared ONE events dir and a fresh server saw 219 events from other test files.
// Isolation has to follow the board file's IDENTITY, not its folder — otherwise
// two stores in one directory silently share a log, which is the worst possible
// failure for an append-only record. Day-segmented files land inside.
const EVENT_LOG_DIR = process.env.SCRUM_EVENT_LOG_DIR
  || `${BOARD_DATA_FILE.replace(/\.json$/, '')}-events`;
// Root directory for static file serving. Defaults to the project dir;
// overridable so tests can exercise the traversal guard in isolation.
const STATIC_DIR = process.env.SCRUM_STATIC_DIR || PROJECT_DIR;
// Canonical form of STATIC_DIR (symlinks resolved) — the traversal guard
// compares resolved request paths against this.
const REAL_STATIC_DIR = fs.realpathSync(STATIC_DIR);

// ── Roster ──────────────────────────────────────────────────────────────────
// Loaded once at boot from an optional, gitignored roster.json. Read at startup
// rather than per-request so every page in a session agrees about who is who —
// a roster that changed mid-session would repaint the room under you.
const ROSTER = configureIdentities(loadRoster(undefined, (msg) => console.warn(`⚠️  roster: ${msg}`)));

/**
 * The roster, inlined into every HTML page so the browser has it before first
 * paint. Fetching it instead would leave a gap in which the room renders in the
 * wrong colours and then corrects itself, which reads as a bug.
 *
 * `<` is escaped because a name containing `</script>` would otherwise close the
 * tag and turn a roster entry into markup.
 */
const ROSTER_SCRIPT = `<script>globalThis.__SCRUM_ROSTER__=${
  JSON.stringify(ROSTER).replace(/</g, '\\u003c')
};</script>`;

// #119 — autonomous room. On a new commons post, fire a best-effort notify
// to the MCP server, which emits a Channels notification to live sessions.
// Unset → default to the localhost MCP server. Empty string → disabled.
//
// ⚠️ The port is DERIVED from MCP_PORT, not hardcoded, and that is load-bearing
// rather than tidy. It used to be the literal 3001. Running a second board on
// this machine — `SCRUM_PORT=3199 node server.js` — isolated the REST server and
// nothing else: the scratch board went on notifying the REAL board's MCP server,
// so a test post in the scratch room was delivered to everyone in the live one.
//
// The lesson is worth more than the fix: SETTING ONE PORT DOES NOT ISOLATE AN
// INSTANCE. Isolation is a property of every outbound reference, and a hardcoded
// default is an outbound reference that ignores your configuration. If you add
// another one below, derive it too.
const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : 3001;
const MCP_NOTIFY_URL = process.env.SCRUM_MCP_NOTIFY_URL ?? `http://127.0.0.1:${MCP_PORT}/internal/notify`;

// #513 — the rail the comment above could not be.
//
// That warning has sat here since #488 and it did not work: its own author read
// it, then started a scratch instance without SCRUM_MCP_NOTIFY_URL hours later
// and delivered a fixture message into another agent's live feed. A comment is
// read by whoever opens this file; the person starting a dev server never does.
// So the check moved to where the mistake is made — boot.
//
// The discriminator is the PORT, not the board file. A second instance on this
// machine must take a non-default port, because the live one holds the default;
// every observed incident (3199, 3272, 3979) did exactly that. Keying on the
// board file instead would refuse the LIVE service, whose data path is
// deliberately non-default — a gate that bricks the room it protects.
//
// Declared isolation always passes: SCRUM_MCP_NOTIFY_URL='' means "do not
// notify", an explicit URL means "notify that room on purpose". Only silence
// is refused, and only on a port that says you are not the main instance.
//
// KNOWN RESIDUAL, named rather than papered over: a dev instance started on the
// DEFAULT port while the REST service is down but the MCP is up would still
// reach the live room. Narrow — it requires deliberately taking the live port —
// and closing it would need the plist migration this design exists to avoid.
//
// MCP_PORT counts as a declaration too. Saying "notify the MCP on port N" names
// a target just as surely as giving the whole URL, and tests/instance-isolation
// does exactly that to exercise the derivation. The phantom incidents declared
// NEITHER — they inherited 3001 in silence. Silence is the fault, not brevity.
const DEFAULT_PORT = 3141;
const declaresTarget = process.env.SCRUM_MCP_NOTIFY_URL !== undefined
  || process.env.MCP_PORT !== undefined;
if (PORT !== DEFAULT_PORT && !declaresTarget) {
  console.error(`
✗ manyhands refuses to start.

  This instance is on port ${PORT}, not the default ${DEFAULT_PORT}, so it is a
  second board on this machine — but SCRUM_MCP_NOTIFY_URL is unset, so it would
  post notifications to the MCP server at ${MCP_NOTIFY_URL}.

  That is the live room. Its members would receive messages from this instance
  that do not exist on their board, and cannot be found afterwards.

  Setting one port does not isolate an instance. Declare what this one notifies:

    SCRUM_MCP_NOTIFY_URL='' node server.js            # isolated: notify nobody
    SCRUM_MCP_NOTIFY_URL=http://127.0.0.1:PORT/internal/notify node server.js
                                                      # a second room, on purpose
`);
  process.exit(2);
}

// Fire-and-forget. A dropped nudge is acceptable — the agent's ?since poll is
// the reliability backstop. Critically, a down/absent MCP server must NEVER
// break posting, so the fetch is not awaited and every error is swallowed.
function notifyMcpOfPost(conversation) {
  if (!MCP_NOTIFY_URL) return;
  fetch(MCP_NOTIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation }),
  }).catch(() => { /* MCP down / no listener — posting still succeeded */ });
}

// ── #578 — announcing a claim transition ────────────────────────────────
//
// A claim is the ONLY card mutation this server can attribute: `POST
// /api/cards/:id/claim` carries `by`. PATCH and the browser's whole-board
// /api/save are anonymous, so they cannot say who did anything.
//
// ⚠️ Read this before extending it: announcing a claim does NOT cover the case
// #576 was filed for — a seat writing to the DESCRIPTION of someone else's
// card. That event has no identity on any write path today. This is a floor.
//
// The author key is `board`, deliberately not the actor's: a post signed with
// a seat's own name that the seat did not write is impersonation, in a room
// where authorship is identity. `board` needs a roster entry to get a colour;
// until one is added it renders unstyled, which is a cosmetic cost, not a bug.
const CLAIM_ANNOUNCER = 'board';

/**
 * Build the one-line announcement for a claim transition, or null if there is
 * nothing truthful to say. Pure — the caller does the writing.
 *
 * Assignees other than the actor are @mentioned so the notification reaches the
 * person it is about; the actor is not mentioned (they just acted), and
 * `unassigned` is never mentioned because it names nobody.
 */
function claimAnnouncement(card, actor, action) {
  if (!card || typeof actor !== 'string' || !actor) return null;
  const others = (card.assignees || [])
    .filter(a => a && a !== actor && a !== 'unassigned');
  const who = others.length ? ` — assigned to ${others.map(a => `@${a}`).join(', ')}` : '';
  const title = typeof card.title === 'string' && card.title ? ` “${card.title}”` : '';
  return `🔔 ${actor} ${action} #${card.shortId}${title}${who}`;
}

/**
 * Append the announcement to `data.conversations` so it rides the caller's
 * write. Returns the conversation (for the post-lock notify) or null.
 *
 * Best-effort by construction: the claim is the coordination primitive and the
 * announcement is decoration on top of it, so a throw here must never cost
 * someone their claim.
 */
function appendClaimAnnouncement(data, card, actor, action) {
  try {
    const body = claimAnnouncement(card, actor, action);
    if (!body) return null;
    const conv = createConversationFromPayload({ body, author: CLAIM_ANNOUNCER });
    data.conversations.push(conv);
    return conv;
  } catch (e) {
    console.error('#578 claim announcement skipped:', e.message);
    return null;
  }
}

// README block injected into every write so the warning is the first thing
// anyone opening board-data.json sees. Source of truth lives here; the file
// is rewritten by every save (including the browser's whole-board save which
// would otherwise strip extra fields).
const BOARD_README = [
  '⚠️  DO NOT EDIT THIS FILE DIRECTLY.',
  '',
  'This is the canonical state of the scrum board. Writes from the browser UI,',
  'agent scripts, MCP tools, and curl all funnel through a single in-process',
  'mutex in server.js — but ONLY when they go through the API. Direct edits',
  'to this file BYPASS the mutex and race against every other writer.',
  '',
  'What happens when you edit directly: you overwrite cards added since you last',
  'read, reuse just-deleted shortIds, and clobber state that the API would have',
  'preserved. We lost the #93 Conversations card this way on 2026-05-18 — see',
  'commit e72f66d for the recovery and the lesson.',
  '',
  'Use the API instead:',
  '  REST:  http://127.0.0.1:3141/api/cards         (GET/POST/PATCH/DELETE)',
  '         http://127.0.0.1:3141/api/columns',
  '         http://127.0.0.1:3141/api/conversations (GET/POST — append-only commons, #93)',
  '         http://127.0.0.1:3141/api/board         (whole-state read)',
  '  MCP:   http://127.0.0.1:3001/mcp               (card_*/column_*/conversation_*/board_status)',
  '',
  'Full contract: SPEC.md → \'API Endpoints\'.',
  '',
  'If you absolutely must hand-edit (recovery scenarios, schema migrations),',
  'stop both servers first (lsof -i :3141 :3001) and make a backup:',
  '  cp board-data.json backups/board-data-backup-$(date +%Y%m%d-%H%M%S).json',
];

// MIME types for static file serving
// #605 — every TEXT type declares charset=utf-8. Without it the client guesses,
// and the usual guess (latin-1/cp1252) renders UTF-8 bytes as mojibake: an em
// dash becomes "â€”". HTML survived this for the life of the app only because
// each page carries <meta charset> in its own <head> — an in-band fallback that
// .txt and .md do not have and cannot have. robots.txt was the first file we
// served with no second chance, and it broke visibly within the hour.
// ⚠️ .json is deliberately EXEMPT: RFC 8259 mandates UTF-8 and a charset
// parameter there is undefined. Do not "fix" it.
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  // #588 — robots.txt is only honoured when served as text/plain. Without
  // this entry it falls through to application/octet-stream and the file
  // exists, looks installed, and does nothing. Verify with `curl -I`, never `ls`.
  '.txt': 'text/plain; charset=utf-8',
};

// ── Attachments (#113) ───────────────────────────────────────────────────
// Bytes live on disk (NOT in board-data.json — they'd bloat the live state on
// every read/write). Stored UUID-keyed; the original filename is metadata only
// (kills filename-collision AND path-traversal in one move).
const ATTACHMENTS_DIR = process.env.SCRUM_ATTACHMENTS_DIR || path.join(PROJECT_DIR, 'attachments');
const MAX_ATTACHMENT_BYTES = Number(process.env.SCRUM_MAX_ATTACHMENT_BYTES ?? 25 * 1024 * 1024);
// An attachment id is exactly "<token>.<ext>": no slashes, no `..`.
const ATTACHMENT_ID_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/;
// Only these render INLINE (served with their real image content-type). Anything
// else is forced to download as octet-stream — which neutralises stored-XSS from
// an html/svg/js upload regardless of what got stored.
const EXT_TO_INLINE_TYPE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MIME_TO_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv',
  'application/json': 'json', 'application/zip': 'zip', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'video/mp4': 'mp4',
};
// Blocked at upload (executables + browser-executable/script types).
const BLOCKED_ATTACHMENT_EXT = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.pif', '.dll', '.app', '.dmg', '.pkg',
  '.deb', '.rpm', '.jar', '.sh', '.bash', '.zsh', '.ps1', '.vbs', '.wsf', '.html', '.htm',
  '.xhtml', '.svg', '.js', '.mjs', '.cjs', '.php', '.py',
]);
const BLOCKED_ATTACHMENT_MIME = new Set([
  'text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/javascript', 'text/javascript',
  'application/x-msdownload', 'application/x-sh', 'application/x-executable',
  'application/vnd.microsoft.portable-executable',
]);

function isBlockedAttachment(name, mime) {
  const ext = path.extname(typeof name === 'string' ? name : '').toLowerCase();
  if (ext && BLOCKED_ATTACHMENT_EXT.has(ext)) return true;
  if (typeof mime === 'string' && BLOCKED_ATTACHMENT_MIME.has(mime.toLowerCase())) return true;
  return false;
}

// Keep only well-formed attachment refs on a conversation; drop anything whose
// id isn't a safe stored filename (blocks `../../etc/passwd`-style injection).
function sanitizeAttachments(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const a of input) {
    if (!a || typeof a !== 'object') continue;
    if (typeof a.id !== 'string' || !ATTACHMENT_ID_RE.test(a.id)) continue;
    out.push({
      id: a.id,
      name: typeof a.name === 'string' ? a.name.slice(0, 256) : 'file',
      mime: typeof a.mime === 'string' ? a.mime.slice(0, 128) : 'application/octet-stream',
      size: Number.isFinite(a.size) ? a.size : 0,
    });
    if (out.length >= 10) break; // cap attachments per message
  }
  return out;
}

// #250 — bound request bodies so a large POST to the only write path can't OOM
// the process. JSON write routes get a generous cap (the whole-board /api/save
// is well under it); attachments allow more (base64 of a 25MB file ≈ 34MB).
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_BODY_BYTES = 40 * 1024 * 1024;

/**
 * Read request body as a string, capped at maxBytes. Past the cap we stop
 * buffering and free what we held (memory stays bounded) but keep draining to
 * 'end' so a 413 response flushes without a mid-stream socket reset, then
 * reject with a 413-tagged error.
 */
function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooBig = true;
        chunks = [];
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/**
 * Send a JSON response
 */
function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Handle POST /api/save — write board-data.json to disk.
 *
 * The legacy browser save only sends { cards, columns, nextShortId, lastUpdated }.
 * It does NOT send conversations[]. If we wrote the payload verbatim, every UI
 * save would clobber the commons. So this handler reads the on-disk state first
 * and preserves any field the legacy payload doesn't manage (conversations, etc.).
 * Data loss event on 2026-05-19 forced this fix; pre-fix repro: open the board
 * in the browser, move a card, observe conversations[] wiped.
 */
// #230 — above this many cards removed in a single /api/save, the save is
// treated as a stale-client clobber and refused. The browser deletes one card
// per save, so legitimate saves never cross it.
const MAX_CARDS_DROPPED_PER_SAVE = 2;

async function handleSave(req, res) {
  try {
    const raw = await readBody(req);
    const incoming = JSON.parse(raw);

    // Validate structure
    if (!incoming || !Array.isArray(incoming.cards)) {
      return sendJSON(res, 400, { error: 'Invalid payload: "cards" array is required' });
    }

    const existing = readBoard();

    // #230 — clobber guard. The browser deletes ONE card per save, so a save
    // that vanishes many cards is a stale client overwriting newer state with
    // its old localStorage (the 2026-06-15 incident: 8 cards lost). Refuse it.
    // Interim defense until /api/save is retired for the granular API (#118).
    const incomingIds = new Set(incoming.cards.map((c) => c && c.id).filter(Boolean));
    const removed = existing.cards.filter((c) => c && c.id && !incomingIds.has(c.id));
    if (removed.length > MAX_CARDS_DROPPED_PER_SAVE) {
      const which = removed.map((c) => '#' + (c.shortId ?? '?')).slice(0, 10).join(', ');
      return sendJSON(res, 409, {
        error: `Refused: this save would delete ${removed.length} cards (${which}). `
          + 'That is the signature of a stale browser tab overwriting newer state. '
          + 'Reload the page to resync, then retry.',
      });
    }

    const merged = { ...existing };
    for (const k of ['cards', 'columns', 'nextShortId', 'lastUpdated']) {
      if (incoming[k] !== undefined) merged[k] = incoming[k];
    }

    // #669 — the browser's whole-board save cannot say what it changed, so its
    // events are derived. A save that changed nothing writes nothing: there is no
    // event to record, and writeBoard refuses an empty list by design rather than
    // letting a no-op mint a meaningless entry in the log.
    const saveEvents = deriveEvents(existing, merged);
    if (saveEvents.length) writeBoard(merged, saveEvents);

    sendJSON(res, 200, { ok: true, cards: merged.cards.length, lastUpdated: merged.lastUpdated });
  } catch (e) {
    console.error('Error in /api/save:', e.message);
    sendJSON(res, 500, { error: 'Failed to save board data' });
  }
}

// ═══════════════════════════════════════════════════════════════════
// Granular API (#90)
// ═══════════════════════════════════════════════════════════════════

// Read board state — through the node-domain port (#219). loadDomain handles
// the missing-file default + shape coercion; domainToBoard returns the legacy
// board shape the handlers operate on (lossless round-trip, proven in #215).
/**
 * The columns a brand-new board starts with.
 *
 * Their ids are not cosmetic — `backlog` is the literal string a newly created
 * card defaults to, so these have to exist or every card points at a column
 * that doesn't. See the note in readBoard().
 */
const DEFAULT_COLUMNS = [
  { id: 'backlog', name: 'Backlog', order: 0 },
  { id: 'in-progress', name: 'In Progress', order: 1 },
  { id: 'done', name: 'Done', order: 2 },
];

function readBoard() {
  const data = domainToBoard(loadDomain(BOARD_DATA_FILE));
  // #110 — backfill mentions on conversations created before the field existed.
  for (const c of data.conversations) {
    if (!Array.isArray(c.mentions)) c.mentions = extractMentions(c.body);
  }

  // A board with no columns is a brand-new install, and it used to be a trap.
  // New cards default to `column: 'backlog'`, the UI drew BACKLOG/IN PROGRESS/
  // DONE as placeholders that did not exist, and a card pointing at a column
  // that isn't there rendered NOWHERE. So a first-timer followed the quickstart
  // exactly — clone, run, create a card — opened the browser, saw "No cards
  // yet", and reasonably concluded the install was broken. The card was there
  // the whole time and unreachable.
  //
  // It never bit us because our own board has had real columns since before any
  // of us arrived; the empty-board path had simply never been walked. Seeding
  // here makes the placeholders' promise true.
  if (!data.columns.length) data.columns = DEFAULT_COLUMNS.map((c) => ({ ...c }));

  return data;
}

// Write board state — through the node-domain port (#219). saveDomain owns the
// atomic tmp+rename, _README-first ordering, and lastUpdated stamp. We still
// stamp data.lastUpdated here (callers read it back, e.g. handleSave) and force
// the canonical _README so it's refreshed even on the browser's whole-board
// save; saveDomain carries both through the domain unchanged.
//
// #669 — EVERY write declares what it did. `events` is REQUIRED and this throws
// without it, which is the whole point: the spec said "append at the chokepoint"
// and the chokepoint turned out to know nothing — it receives the whole board and
// cannot tell op from entity from actor. Handlers know all three. Making the
// parameter mandatory moves totality from a property we assert to one a forgotten
// argument cannot bypass: a future handler that doesn't say what it did cannot
// write at all.
//
// ⚠️ It is a LIST, not one event. Several handlers deliberately mutate more than
// one entity per write — a claim rides with its announcement so there is no window
// where the card is claimed and the room was never told (#578); a column delete
// reassigns every card in it; a create fans out through syncInverseRelationships
// into N other cards (#614). One event per write would have had to drop the
// announcement, which is the half the room actually reads.
//
// The log is the AUTHORITY and the store is its projection, so the order is
// validate → append → project: appendEvent validates and throws before writing a
// byte, every event lands before the store save, and a store failure is repaired
// by rebuild rather than by rolling back an append (which would mint a second
// permitted rewrite beside redaction's — the spec holds exactly one).
// #669 — event constructors. Kept next to writeBoard so a caller writing a new
// handler sees the shape it must supply. `actor` is DECLARED, not authenticated
// (the board's standing trust model): we record who the request said it was, and
// null when it said nothing, rather than inventing an attribution.
const cardEvent = (op, card, actor = null) => ({
  op, actor, entity: { kind: 'card', id: card.id, shortId: card.shortId }, state: card,
});
const convEvent = (conv, actor = null) => ({
  op: 'post', actor: actor ?? conv.author ?? null,
  entity: { kind: 'conversation', id: conv.id }, state: conv,
});
const columnEvent = (op, col, actor = null) => ({
  op, actor, entity: { kind: 'column', id: col.id }, state: col,
});

/**
 * #669 — derive events by comparing two whole boards.
 *
 * ⚠️ THE ONLY place in the server that infers `op` from absence, and deliberately
 * bounded to the two callers that genuinely cannot know what they changed: the
 * browser's whole-board save (`handleSave` — it merges an entire cards array from
 * a tab that may have touched anything) and the boot migration. Every other
 * handler DECLARES, because a declaration carries the actor and a diff cannot.
 * Deriving everywhere was the alternative and it loses `actor` permanently —
 * the "materialize a guess" move the room rejected for prose obligations.
 */
function deriveEvents(before, after, actor = null) {
  const out = [];
  const mk = {
    cards: (op, x) => cardEvent(op, x, actor),
    columns: (op, x) => columnEvent(op, x, actor),
    // A conversation's create op is `post`; only its removal is a `delete`.
    conversations: (op, x) => ({
      op: op === 'create' ? 'post' : op, actor: actor ?? x.author ?? null,
      entity: { kind: 'conversation', id: x.id }, state: x,
    }),
  };
  for (const key of ['cards', 'columns', 'conversations']) {
    const prev = new Map((before?.[key] || []).filter((x) => x?.id).map((x) => [x.id, x]));
    const next = new Map((after?.[key] || []).filter((x) => x?.id).map((x) => [x.id, x]));
    for (const [id, x] of next) {
      const was = prev.get(id);
      if (!was) out.push(mk[key]('create', x));
      else if (JSON.stringify(was) !== JSON.stringify(x)) out.push(mk[key]('update', x));
    }
    for (const [id, x] of prev) if (!next.has(id)) out.push(mk[key]('delete', x));
  }
  return out;
}

function writeBoard(data, events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error(
      'writeBoard requires a non-empty events[] (#669): every write must declare '
      + '{op, entity, actor, state}. If this is a bulk write that genuinely cannot '
      + 'name its entities, derive the events by diffing — see handleSave.',
    );
  }
  data.lastUpdated = new Date().toISOString();
  data._README = BOARD_README;
  for (const ev of events) appendEvent(EVENT_LOG_DIR, ev, { now: data.lastUpdated });
  // #686 — every server write is a ROSTERED save: Person nodes are
  // (re)materialized into @graph from this one authority on every write.
  saveDomain(BOARD_DATA_FILE, boardToDomain(data), { now: data.lastUpdated, roster: { seats: ROSTER } });
  _graphDirty = true;   // #694 — the replica rebuilds lazily on next query
}

// ── #694 — the graph traversal replica ──────────────────────────────────────
// In-process Oxigraph store projected from the DOCUMENT (the same bytes on
// disk), rebuilt lazily after any write. Disposable by construction: nothing
// writes through it, and boot starts dirty. Every query is LOGGED (#654's
// principle made continuous): "does graph-native have pull" is answered by
// this file, not by advocacy.
let _graphStore = null;
// #714 — per-entity content hashes from the last sync; null means cold.
let _graphHashes = null;
let _graphDirty = true;
const GRAPH_QUERY_LOG = path.join(path.dirname(BOARD_DATA_FILE), 'graph-query-log.jsonl');

/**
 * Warm (or incrementally sync) the replica and return it. Shared by every
 * graph-derived read — /api/graph and /api/ready see the SAME store, so a
 * ready verdict and a hand-run SPARQL check can never disagree about which
 * world they measured.
 */
function warmGraphStore() {
  let rebuiltMs = null;
  if (_graphDirty || !_graphStore) {
    // #714 — INCREMENTAL. The old path threw the store away and re-projected
    // 67k triples (3.7s) on the first query after ANY write, which is what
    // stopped anything being built on top of the graph. syncGraphStore diffs
    // the document by per-entity content hash (~165ms for the whole file) and
    // re-projects only what actually changed — normally one or two entities.
    // Correctness is not argued, it is pinned: the parity test asserts an
    // incrementally-maintained store is triple-for-triple identical to a full
    // rebuild, and goes red if the delete-before-re-emit step is removed.
    const t = performance.now();
    if (!_graphStore) _graphStore = buildGraphStore({ '@graph': [] });
    const stats = syncGraphStore(_graphStore, domainToJsonLd(loadDomain(BOARD_DATA_FILE)), _graphHashes);
    _graphHashes = stats.hashes;
    _graphDirty = false;
    rebuiltMs = Math.round(performance.now() - t);
    console.error(`${new Date().toISOString()} graph-replica: synced ${stats.updated} updated, ${stats.removed} removed of ${stats.total} entities → ${_graphStore.size} triples in ${rebuiltMs}ms`);
  }
  return { store: _graphStore, rebuiltMs };
}

async function handleGraphQuery(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    if (typeof body.query !== 'string' || !body.query.trim()) {
      return sendJSON(res, 400, { error: 'body.query (SPARQL SELECT or ASK) is required' });
    }
    // #654 — the caller's true cost is rebuild + engine, and only the engine half
    // used to be recorded. Two seats read `ms` as the cost of a call on 2026-08-05
    // (one reported 26ms for a call that took 3842ms) because the rebuild was
    // invisible here and timestamp-less in the console line, so neither could
    // correlate the two. Both halves are now measured and both are logged.
    const tCall = performance.now();
    const { store, rebuiltMs } = warmGraphStore();
    const result = queryGraph(store, body.query, { limit: body.limit });
    try {
      fs.appendFileSync(GRAPH_QUERY_LOG, JSON.stringify({
        at: new Date().toISOString(), by: (typeof body.by === 'string' && body.by) || null,
        ms: result.ms, rebuiltMs, totalMs: Math.round(performance.now() - tCall),
        returned: result.returned ?? 0, truncated: !!result.truncated,
        query: body.query.slice(0, 2000),
      }) + '\n');
    } catch { /* the log is telemetry, never a gate on the answer */ }
    sendJSON(res, 200, result);
  } catch (e) {
    if (e.code === 'READ_ONLY' || e.code === 'EMPTY_QUERY') return sendJSON(res, 400, { error: e.message, code: e.code });
    // a SPARQL parse error is the caller's to fix — teach, don't 500
    return sendJSON(res, 400, { error: e.message, hint: 'SELECT/ASK SPARQL; prefixes schema:, scrum:, entity:, person:, column: are pre-declared' });
  }
}

/**
 * #815 — GET /api/ready: the computed work queue. Cards that are unblocked,
 * unclaimed and actionable, ordered by priority, every inclusion and
 * exclusion explainable from graph state. Derived from the SAME replica
 * /api/graph serves — the graph stays authoritative, this is a projection.
 * `?explain=<shortId>` returns the verdict for one card instead of the queue.
 */
async function handleReady(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const { store } = warmGraphStore();
    // Verdicts are computed COMPLETE; explain consults them unpaged (a ready
    // card past the page window must answer ready, not 404 — bb2ccee6) and
    // the queue response pages both lists.
    const verdicts = readyFromStore(store);
    const explain = url.searchParams.get('explain');
    if (explain != null && explain !== '') {
      return sendJSON(res, 200, READY_EXPLAIN(verdicts, explain));
    }
    sendJSON(res, 200, pageReady(verdicts, { limit: url.searchParams.get('limit') ?? undefined }));
  } catch (e) {
    if (e.code === 'UNKNOWN_CARD') return sendJSON(res, 404, { error: e.message, code: e.code });
    if (e.code === 'READY_BAD_LIMIT') return sendJSON(res, 400, { error: e.message, code: e.code });
    if (e.code === 'READY_TRUNCATED') return sendJSON(res, 503, { error: e.message, code: e.code });
    console.error('GET /api/ready:', e.message);
    sendJSON(res, 500, { error: 'Failed to compute ready queue' });
  }
}

// Promise-chain mutex. All write paths run under this lock so two
// concurrent PATCH requests cannot interleave their read-modify-write.
let _writeLock = Promise.resolve();
function withWriteLock(fn) {
  const next = _writeLock.then(() => fn(), () => fn());
  _writeLock = next.catch(() => {});
  return next;
}

// Lookup helper: :id can be the card's UUID (data.id) or its shortId (numeric).
function findCardIndex(data, idOrShortId) {
  // Try numeric (shortId) first if the param parses as an integer
  if (/^\d+$/.test(idOrShortId)) {
    const sid = parseInt(idOrShortId, 10);
    const idx = data.cards.findIndex(c => c.shortId === sid);
    if (idx >= 0) return idx;
  }
  return data.cards.findIndex(c => c.id === idOrShortId);
}

function findColumnIndex(data, columnId) {
  return data.columns.findIndex(c => c.id === columnId);
}

// Generate a server-side card from a request body, applying defaults.
// #829 — the keys createCardFromPayload actually consumes. Its ONE home is
// immediately below: add a field there, add it here, or the field takes effect
// while the response reports it as ignored — a lie in the harder direction to
// debug. `tests/card-create-unknown-fields.test.mjs` sends every key in this
// set and asserts both that nothing is reported AND that each took effect, so
// drift in either direction fails.
//
// ⚠️ Deliberately NOT derived from the created card's own keys: `assignee`
// (singular alias) and `relationships` input shapes are consumed without ever
// appearing under that name on the stored object.
//
// ⚠️ Route-relative. `body` is a real field on /api/nodes; here it is unknown.
const CREATE_CONSUMED_FIELDS = new Set([
  'id', 'title', 'description', 'type', 'assignees', 'assignee',
  'labels', 'for', 'priority', 'column', 'order', 'createdBy', 'relationships',
  'implementedBy',   // #830
]);

/** Keys the caller sent that create will silently drop. Empty when clean. */
function unconsumedCreateFields(body) {
  if (typeof body !== 'object' || body === null) return [];
  return Object.keys(body).filter((k) => !CREATE_CONSUMED_FIELDS.has(k));
}

function createCardFromPayload(body, nextShortId) {
  const now = new Date().toISOString();
  // Normalize assignees: accept string ('alex'), array (['alex','sage']),
  // or missing (→ ['unassigned']).
  // #508: the legacy 'both' sentinel is GONE from every input path. It expanded
  // to two hardcoded example seat keys, so on any configured board it minted two
  // people who do not exist. It is now an ordinary assignee key and fails the
  // same validation as any other unknown one.
  let assignees;
  if (Array.isArray(body.assignees) && body.assignees.length > 0) {
    assignees = body.assignees;
  } else if (typeof body.assignee === 'string' && body.assignee.length > 0) {
    assignees = [body.assignee];
  } else {
    assignees = ['unassigned'];
  }
  return {
    id: body.id || crypto.randomUUID(),
    shortId: nextShortId,
    title: (body.title || '').trim(),
    description: (body.description || '').trim(),
    type: body.type || 'task',
    assignees,
    labels: Array.isArray(body.labels) ? body.labels : [],
    for: body.for || '',
    priority: body.priority || null,
    column: body.column || 'backlog',
    order: typeof body.order === 'number' ? body.order : 0,
    createdAt: now,
    updatedAt: now,
    // #631 — who WROTE this, recorded at write time.
    //
    // DECLARED, not authenticated: the writing surface asserts an identity and
    // the server records it — the contract `conversation.author` has run on all
    // along. Server-side resolution would need caller identity the MCP tool path
    // does not have (17 tools, none read it), and that is a separate slice.
    //
    // Absent → null, never a guess. Not the assignee, not the claimant (that is
    // the #348 lease, cleared on release: it records custody, not writing). A
    // card whose author was never captured must READ as unknown, because
    // inventing one is worse than lacking one.
    createdBy: (typeof body.createdBy === 'string' && body.createdBy.trim()) ? body.createdBy.trim() : null,
    relationships: normalizeRelationships(body.relationships),
    // #830 — a card may be born knowing what implemented it. Retroactive cards
    // (work shipped before it was filed) carry the sha at creation, and the
    // two-call shape was friction with no benefit. The 40-char sha rule already
    // runs in validateCardFields on this route — only the consume step was
    // missing, which is why the field validated and then evaporated.
    ...(Array.isArray(body.implementedBy) ? { implementedBy: body.implementedBy } : {}),
    // #348 — coordination rail: first-write-wins claim, server-arbitrated.
    // Set only via POST /api/cards/:id/claim (never via PATCH), so a claim
    // is a compare-and-set under withWriteLock, not an unconditional overwrite.
    claimedBy: null,
    claimedAt: null,
  };
}

// #614 — the card-to-card edge vocabulary. Closed on purpose: a fixed verb
// set needs no adjudication, so growing it is a design decision, not data
// arriving. relatedTo is bidirectional; the other three are directional
// (A blockedBy B, A supersedes B, A derivedFrom B).
const RELATIONSHIP_TYPES = ['relatedTo', 'blockedBy', 'supersedes', 'derivedFrom'];

// Returns an error string if the relationships object is malformed, else null.
// Targets are shortIds (numbers). Stored legacy data mixes UUIDs in — that is
// a migration surface, not a write surface; new writes are held to shortIds.
function validateRelationships(rel) {
  if (typeof rel !== 'object' || rel === null || Array.isArray(rel)) {
    return 'relationships must be an object';
  }
  for (const [type, targets] of Object.entries(rel)) {
    if (!RELATIONSHIP_TYPES.includes(type)) {
      return `unknown relationship type '${type}' — valid: ${RELATIONSHIP_TYPES.join(', ')}`;
    }
    if (!Array.isArray(targets)) return `relationships.${type} must be an array`;
    for (const t of targets) {
      if (typeof t !== 'number' || !Number.isInteger(t)) {
        return `relationships.${type} targets must be card shortIds (integers)`;
      }
    }
  }
  return null;
}

// Maintained-only inverse keys: written by the server, rejected as input.
// supersededBy answers "what replaced this?" from the replaced card without
// a scan — the question #530's traversal demo failed on.
const MAINTAINED_RELATIONSHIP_KEYS = ['supersededBy'];

// Which writable types the server mirrors, and under what key on the target.
// relatedTo is symmetric (both ends carry relatedTo); supersedes writes the
// maintained supersededBy. This lives HERE, not in the browser (#42 did it
// client-side, so MCP-written edges were one-ended — 79% of live relatedTo).
const INVERSE_OF = { relatedTo: 'relatedTo', supersedes: 'supersededBy' };

// Every stored card carries every key so readers never branch on absence.
// Given keys land over the empty defaults; validation has already run.
function normalizeRelationships(rel) {
  const keys = [...RELATIONSHIP_TYPES, ...MAINTAINED_RELATIONSHIP_KEYS];
  const out = Object.fromEntries(keys.map((t) => [t, []]));
  if (rel && typeof rel === 'object') {
    for (const t of keys) {
      if (Array.isArray(rel[t])) out[t] = rel[t];
    }
  }
  return out;
}

// Reconcile inverse edges after `card`'s relationships changed from `before`
// to `after`: targets added under a mirrored type gain the inverse entry,
// targets removed lose it. Mutates sibling cards in `data`; caller holds the
// write lock and persists. Missing targets are skipped, not errors — dangling
// shortIds are a known corpus condition, and refusing the write here would
// make old data block new edges.
// #669 — RETURNS the sibling cards it mutated, so the caller can log an event
// for each. Without this, editing #669's `relatedTo` silently rewrites #455's
// relationships and #455's own history shows nothing — which would violate
// #642's "field-level change answerable" requirement while every test passed.
// The function doing the fan-out is the only thing that knows its extent;
// diffing for it afterwards would re-derive a guess where a precise answer is
// free. Deduped: one event per touched card even if several types moved.
function syncInverseRelationships(data, card, before, after) {
  const touched = new Set();
  for (const [type, invType] of Object.entries(INVERSE_OF)) {
    const prev = new Set((before && before[type]) || []);
    const next = new Set((after && after[type]) || []);
    for (const sid of next) {
      if (prev.has(sid)) continue;
      const target = data.cards.find((c) => c.shortId === sid);
      if (!target || target === card) continue;
      target.relationships = normalizeRelationships(target.relationships);
      if (!target.relationships[invType].includes(card.shortId)) {
        target.relationships[invType].push(card.shortId);
        touched.add(target);
      }
    }
    for (const sid of prev) {
      if (next.has(sid)) continue;
      const target = data.cards.find((c) => c.shortId === sid);
      if (!target || !target.relationships || !Array.isArray(target.relationships[invType])) continue;
      const len = target.relationships[invType].length;
      target.relationships[invType] = target.relationships[invType].filter((x) => x !== card.shortId);
      if (target.relationships[invType].length !== len) touched.add(target);
    }
  }
  return [...touched];
}

// Fields that PATCH must NOT change (preserve identity / history)
const IMMUTABLE_CARD_FIELDS = new Set(['id', 'shortId', 'createdAt', 'createdBy']); // #631 — authorship is a fact about the past

// #249 — id/type/priority/assignees are rendered into HTML attributes by the
// board client and are the trust boundary between agents. Constrain them at the
// API (defense in depth alongside the client-side escaping): an out-of-shape
// value must never be stored, whichever writer sent it.
// #573 — 'bug' added: the store already held 5 bug-typed cards the write
// path refused; a schema that cannot express existing data keeps surprising.
const CARD_TYPES = new Set(['task', 'idea', 'goal', 'reference', 'feature', 'bug']);
const CARD_PRIORITIES = new Set(['p0', 'p1', 'p2', 'p3']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSIGNEE_KEY_RE = /^[A-Za-z0-9_-]+$/;

// Returns an error string if any security-sensitive field is malformed, else
// null. Presence-conditional — a field absent from the payload keeps its default.
// #830 — `surface` exists because a field's rules are ROUTE-RELATIVE, exactly
// like its vocabulary. The park trio is real on PATCH and absent on create, so
// validating it on create produced the worst of the three states: the route
// reported the field in `ignoredFields`, refused malformed values for it, and
// stored nothing. A caller reading the diagnostic and a caller trusting the 400
// got opposite answers out of one request.
// Defaults to 'patch' so any future call site is validated rather than silently
// exempted — an exemption must be asked for.
function validateCardFields(body, { checkId = true, surface = 'patch' } = {}) {
  if (checkId && body.id && !UUID_RE.test(String(body.id))) return 'id must be a UUID';
  if (body.type && !CARD_TYPES.has(body.type)) return 'invalid card type';
  if (body.priority && !CARD_PRIORITIES.has(body.priority)) return 'invalid priority';
  // #508: 'both' is a RETIRED pre-#51 sentinel. It used to expand to two
  // hardcoded example seats, so on a configured board it assigned work to two
  // people who do not exist. Refused rather than reinterpreted: a caller sending
  // it is using a sentinel whose meaning ("the two people working on this") was
  // never recorded, only implied by a two-seat roster that is gone. Silently
  // converting would hide that from the caller; storing it literally would put a
  // non-person in the assignees array. Stored legacy data is a different surface
  // and CANNOT be refused — migrateAssigneesIfNeeded converts it loudly instead.
  if (body.assignee === 'both') {
    return "assignee 'both' is a retired sentinel (#508) — name the seats explicitly, e.g. assignees: ['ada','grace']";
  }
  if (body.assignee && !ASSIGNEE_KEY_RE.test(String(body.assignee))) {
    return 'invalid assignee';
  }
  if (body.assignees !== undefined) {
    if (!Array.isArray(body.assignees)) return 'assignees must be an array';
    for (const a of body.assignees) {
      if (typeof a !== 'string' || !ASSIGNEE_KEY_RE.test(a)) return 'invalid assignee';
    }
  }
  // #814 — a commit reference must be a FULL 40-char sha. A short sha is an
  // abbreviation whose expansion needs the repository; the graph cannot expand
  // it, so accepting both forms would mint two nodes for one commit and never
  // reconcile them. That is an aliasing bug shipped as a convenience.
  if (body.implementedBy !== undefined && body.implementedBy !== null) {
    if (!Array.isArray(body.implementedBy)) return 'implementedBy must be an array of commit shas';
    for (const sha of body.implementedBy) {
      if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
        return `implementedBy entries must be full 40-character lowercase git shas (got ${JSON.stringify(sha)}) — `
             + 'a short sha cannot be expanded by the graph and would create a second node for the same commit';
      }
    }
  }
  // A park is an AUTHORED, EXPIRING deferral. Both halves are enforced here
  // because either alone is a different thing: an author with no end date is a
  // permanent block nobody signed up for, and an end date with no author is a
  // rule from nowhere.
  // #830 — NOT validated on create: create does not consume these, and a
  // validator on a discarded field is a false-signal generator. PATCH is the
  // parking surface. Do not "fix" this by consuming them at create — that
  // invents a born-parked card, which is not a thing anyone asked for.
  const hasParker = surface !== 'create' && body.parkedBy !== undefined && body.parkedBy !== null;
  const hasUntil = surface !== 'create' && body.parkedUntil !== undefined && body.parkedUntil !== null;
  if (hasParker !== hasUntil) {
    return 'parkedBy and parkedUntil must be set together — a park needs an author and an end date';
  }
  if (hasParker) {
    if (typeof body.parkedBy !== 'string' || !ASSIGNEE_KEY_RE.test(body.parkedBy)) return 'invalid parkedBy';
    if (typeof body.parkedUntil !== 'string' || Number.isNaN(Date.parse(body.parkedUntil))) {
      return 'parkedUntil must be an ISO-8601 timestamp';
    }
    if (body.parkedReason !== undefined && body.parkedReason !== null && typeof body.parkedReason !== 'string') {
      return 'parkedReason must be a string';
    }
  }
  if (body.relationships !== undefined) {
    const rerr = validateRelationships(body.relationships); // #614
    if (rerr) return rerr;
  }
  return null;
}

// Fields a PATCH may set. Anything else (a crafted __proto__ or junk key) is
// ignored rather than blindly copied onto the stored card. #249.
const PATCHABLE_CARD_FIELDS = new Set([
  'title', 'description', 'type', 'assignees', 'assignee', 'labels',
  'for', 'priority', 'column', 'order', 'relationships', 'parent',
  // An authored, expiring deferral. ⚠️ Validation accepting a field and this
  // allowlist carrying it are DIFFERENT gates: a field that passes the first
  // and is missing from the second is accepted with a 200 and silently
  // discarded — the caller cannot tell. Measured here by a wire test that
  // failed on exactly that, the same day the MCP layer was found doing the
  // same thing with zod's default key-stripping.
  'parkedBy', 'parkedAt', 'parkedUntil', 'parkedReason',
  'implementedBy',
]);

// ── /api/changes — the returning-agent catch-up (#643) ──
// "What did I miss?" as one bounded call. Union of cards (creates+updates)
// and posts (exact — append-only by construction) behind a required since=.
// Same fail-closed unknown-param contract as the card list (#655/#657):
// the miss log is the roadmap, on this surface too.
// #679: the changes surface reads the LOG, not live-store fields. Legacy
// params (limit, order) stay accepted: `limit` maps onto both per-kind
// quotas; `order` other than asc refuses as before (the log's total order
// is the product). New params are the ruled contract + the principal's
// hand-run views (entity, actor).
const CHANGES_PARAMS = new Set([
  'since', 'before', 'limit', 'order', 'as', 'bestEffort',
  'history', 'entity', 'actor', 'limitCards', 'limitPosts',
]);

function handleChanges(req, res) {
  try {
    const q = parseQuery(req.url);
    const unsupported = Object.keys(q).filter((k) => !CHANGES_PARAMS.has(k));
    if (unsupported.length) {
      console.warn(
        `[changes-query] seat=${q.as || 'unknown'} unsupported=${unsupported.join(',')} url=${req.url}`,
      );
      if (q.bestEffort !== 'true') {
        return sendJSON(res, 400, {
          error: `unsupported param${unsupported.length > 1 ? 's' : ''}: `
            + `${unsupported.join(', ')} (supported: `
            + `${[...CHANGES_PARAMS].filter((p) => p !== 'as' && p !== 'bestEffort').join(', ')})`,
          unsupported,
        });
      }
    }
    if (q.order != null && q.order !== '' && q.order !== 'asc' && q.order !== 'desc') {
      return sendJSON(res, 400, { error: `unknown order: ${q.order} (valid: asc, desc)` });
    }
    const events = readEvents(EVENT_LOG_DIR, { sinceDate: q.since });
    // Coverage boundary (#679): refuse a pre-log `since` ONLY when unrecorded
    // history actually exists — the live board predates its log (birth
    // 2026-08-04), so pre-birth sinces would be silently partial there; a
    // fresh board's whole history IS its log, so any since is answerable.
    // The store is consulted for this boundary alone, never for envelope
    // state (the purity rule guards WHAT is served, not what is refused).
    const firstAt = oldestRetainedAt(EVENT_LOG_DIR);
    let oldestRetained = null;
    if (firstAt) {
      const b = readBoard();
      const preLog = (b?.cards || []).some((c) => typeof c?.createdAt === 'string' && c.createdAt < firstAt);
      if (preLog) oldestRetained = firstAt;
    }
    const result = queryChangesFromLog(events, {
      since: q.since,
      before: q.before,
      oldestRetained,
      history: q.history === 'true',
      entity: q.entity,
      actor: q.actor,
      limit: {
        cards: q.limitCards ?? q.limit,
        posts: q.limitPosts ?? q.limit,
      },
    });
    if (unsupported.length) result.unsupported = unsupported;
    sendJSON(res, 200, result);
  } catch (e) {
    if (e.code === 'MISSING_SINCE') return sendJSON(res, 400, { error: e.message });
    if (e.code === 'CURSOR_TOO_OLD') {
      return sendJSON(res, 400, {
        error: e.message, code: e.code, oldest_retained: e.oldest_retained, resync: true,
      });
    }
    if (e.code === 'UNKNOWN_CURSOR') return sendJSON(res, 400, { error: e.message, code: e.code });
    console.error('GET /api/changes:', e.message);
    sendJSON(res, 500, { error: 'Failed to compute changes' });
  }
}

// ── /api/board/status — the orientation projection (#573) ──
//
// board_status was "the first call a new agent makes"; it returned the whole
// board including every conversation ever posted (20.7MB), the transport
// choked, and the failure surfaced as a false "session expired" — sending
// agents to restart servers that were fine. Orientation needs the SHAPE of
// the board, not its history: counts, live claims, recent tails, meta. The
// payload is size-invariant to corpus growth — the property whose absence
// rotted the original tool (a control whose correctness depends on its input
// staying small is a control with a timer on it — #561's lesson, again).
//
// /api/board itself is deliberately UNCHANGED: it is also the board-state
// MCP resource (manyhands://board), a full-state contract something may
// rely on. Split, don't mutate (option 3 on the card).
function handleBoardStatus(req, res) {
  try {
    const data = readBoard();
    const cardsByColumn = {};
    for (const col of data.columns) cardsByColumn[col.id] = 0;
    for (const c of data.cards) {
      cardsByColumn[c.column] = (cardsByColumn[c.column] ?? 0) + 1;
    }
    // Live claims are orientation-critical — who is holding what right now —
    // and (audit #661, finding 1) no other surface a human or arriving agent
    // reads makes them visible.
    const claims = data.cards
      .filter((c) => c.claimedBy)
      .map((c) => ({ shortId: c.shortId, title: c.title, claimedBy: c.claimedBy, claimedAt: c.claimedAt }));
    const { cards: recentCards } = queryCards(data.cards, { limit: '10' });
    const convs = [...data.conversations].sort((a, b) =>
      String(a?.createdAt ?? '').localeCompare(String(b?.createdAt ?? '')));
    const recentConversations = convs.slice(-10).map((c) => ({
      id: c.id,
      author: c.author,
      attachedTo: c.attachedTo,
      createdAt: c.createdAt,
      body: typeof c.body === 'string' && c.body.length > 200 ? c.body.slice(0, 200) + '…' : c.body,
    }));
    sendJSON(res, 200, {
      cardsTotal: data.cards.length,
      cardsByColumn,
      columns: data.columns,
      nextShortId: data.nextShortId,
      conversationsTotal: data.conversations.length,
      claims,
      recentCards,
      recentConversations,
      lastUpdated: data.lastUpdated,
    });
  } catch (e) {
    console.error('GET /api/board/status:', e.message);
    sendJSON(res, 500, { error: 'Failed to derive board status' });
  }
}

// ── /api/board ──
function handleGetBoard(req, res) {
  try {
    const data = readBoard();
    sendJSON(res, 200, data);
  } catch (e) {
    console.error('GET /api/board:', e.message);
    sendJSON(res, 500, { error: 'Failed to read board' });
  }
}

// ── /api/roster — who's who, for anything that isn't an HTML page. ──
// The pages get the roster inlined; agents, scripts and the MCP layer read it
// here. `usingDefaults` is reported so a caller can tell "no roster configured"
// apart from "a roster that happens to match the example" — the difference
// matters when someone is trying to work out why their colours didn't take.
function handleGetRoster(req, res) {
  sendJSON(res, 200, { seats: ROSTER, usingDefaults: usingDefaultRoster() });
}

// ── POST /api/roster (#506) — a human edits their own room, no agent required.
//
// The roster is read ONCE at boot, deliberately: a roster that changed
// mid-session would repaint the room under whoever was reading it. So this
// writes the file and says so; it does not hot-swap ROSTER. The settings page
// carries that as one line of copy, which makes the delay documented behaviour
// rather than a bug someone reports later.
//
// Same trust model as POST /api/config: loopback-only, and write access to this
// board is already shell-equivalent (SECURITY.md). This adds no new authority —
// it removes the requirement to have a shell to use a feature of your own board.
async function handleSetRoster(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    let clean;
    try {
      clean = writeRoster(body);
    } catch (ve) {
      return sendJSON(res, 400, { error: ve.message });
    }
    sendJSON(res, 200, { seats: clean, file: rosterFilePath(), appliesOnRestart: true });
  } catch (e) {
    console.error('POST /api/roster:', e.message);
    sendJSON(res, 500, { error: 'Failed to save roster' });
  }
}

// ── /api/config — channel delivery settings (#263); read by the MCP scheduler
// live, so changes apply with no restart. ──
// #737 — the BOUNDS, served separately from the VALUES.
//
// The settings editor renders every timing in seconds and converts on save, so a
// refusal quoting `maxMs <= 300000` at someone who typed 360 is unreadable: the
// real limit (300) cannot be derived from it. The editor needs the ceiling to
// say so in its own units — and taking it from the server rather than hardcoding
// `300` keeps one fact in one place, so the message cannot outlive a change to
// the constant.
//
// Deliberately NOT folded into GET /api/config. That response is pinned to the
// exact config shape by a test that documents why each key is there, and that
// contract is worth more than saving a round trip.
function handleGetConfigLimits(req, res) {
  sendJSON(res, 200, LIMITS);
}

function handleGetConfig(req, res) {
  try {
    sendJSON(res, 200, readConfig());
  } catch (e) {
    console.error('GET /api/config:', e.message);
    sendJSON(res, 500, { error: 'Failed to read config' });
  }
}

async function handleSetConfig(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    let clean;
    try {
      clean = writeConfig(body); // validates; throws on out-of-bounds input
    } catch (ve) {
      return sendJSON(res, 400, { error: ve.message });
    }
    sendJSON(res, 200, clean);
  } catch (e) {
    console.error('POST /api/config:', e.message);
    sendJSON(res, 500, { error: 'Failed to save config' });
  }
}

// ── /api/channel-status (#303-7) — proxy the MCP scheduler's delivery status
// so the browser (same-origin on :3141) can show "N deliveries pending" without
// a cross-origin fetch to :3001. Best-effort: if the MCP server is down, report
// a benign idle status rather than erroring (the commons indicator just hides).
async function handleChannelStatus(req, res) {
  const url = (process.env.SCRUM_MCP_STATUS_URL
    ?? (MCP_NOTIFY_URL ? MCP_NOTIFY_URL.replace('/internal/notify', '/channel/status') : ''));
  if (!url) return sendJSON(res, 200, { pending: 0, mode: 'off', receivers: 0, sessions: 0, mcp: 'disabled' });
  try {
    const r = await fetch(url);
    if (!r.ok) return sendJSON(res, 200, { pending: 0, mode: 'unknown', receivers: 0, sessions: 0, mcp: 'error' });
    return sendJSON(res, 200, await r.json());
  } catch {
    return sendJSON(res, 200, { pending: 0, mode: 'unknown', receivers: 0, sessions: 0, mcp: 'down' });
  }
}

// ── /api/cards ──
// ── /api/people — the derived person graph (#619) ───────────────────────────
//
// The first surface that lets an agent ask the board a question about a person
// rather than fetch everything and filter. Both endpoints are projections of
// ONE derivation (core/people.mjs deriveGraph) — there is no stored person
// node and no maintained edge, so nothing here can fall out of sync with the
// cards and conversations it is computed from.
function handleListPeople(req, res) {
  try {
    sendJSON(res, 200, deriveGraph(readBoard(), { seats: ROSTER }));
  } catch (e) {
    console.error('GET /api/people:', e.message);
    sendJSON(res, 500, { error: 'Failed to derive people' });
  }
}

function handleGetPerson(req, res, key) {
  try {
    // #628 — backward-paging cursors; every list is bounded by default and
    // the full history is one explicit call away.
    const q = parseQuery(req.url);
    const person = personByKey(readBoard(), { seats: ROSTER }, decodeURIComponent(key), {
      assignedBefore: q.assignedBefore,
      authoredBefore: q.authoredBefore,
      claimingBefore: q.claimingBefore,
      createdBefore: q.createdBefore,
      limit: q.limit,
    });
    if (!person) return sendJSON(res, 404, { error: 'No such person' });
    sendJSON(res, 200, person);
  } catch (e) {
    if (e.code === 'UNKNOWN_CURSOR') return sendJSON(res, 400, { error: e.message });
    console.error('GET /api/people/:key:', e.message);
    sendJSON(res, 500, { error: 'Failed to derive person' });
  }
}

// #657/#659 — the params the card list understands TODAY. Anything else must
// refuse, not silently return the unfiltered world (#655: a wrong answer
// delivered fluently) — and every refusal is logged as demand (#659 shipped
// `column` because the miss log showed 3/5 day-one entries asking for it).
// Ranked/free-text search (`q`) is deliberately absent: different mechanism,
// waits for the log to demand it.
const CARD_LIST_PARAMS = new Set([
  'limit', 'before', 'fields', 'as', 'bestEffort',
  'column', 'label', 'assignee', 'type', 'since', 'updatedSince',
]);

function handleListCards(req, res) {
  try {
    const data = readBoard();
    const q = parseQuery(req.url);
    const keys = Object.keys(q);

    // Legacy compat: the no-param call keeps the bare full array — same
    // precedent as #202's no-param conversation list. The browser's own pages
    // and unknown external consumers keep working; the AGENT default flips at
    // the MCP layer, which always sends bounds.
    if (keys.length === 0) {
      return sendJSON(res, 200, data.cards);
    }

    const unsupported = keys.filter((k) => !CARD_LIST_PARAMS.has(k));
    if (unsupported.length) {
      // The miss log IS the roadmap: every unsupported param is a feature
      // request captured at the moment of real need, with the seat that
      // needed it. Logged on BOTH the refusal and the best-effort path.
      console.warn(
        `[card-query] seat=${q.as || 'unknown'} unsupported=${unsupported.join(',')} url=${req.url}`,
      );
      if (q.bestEffort !== 'true') {
        return sendJSON(res, 400, {
          // #659 verification finding: this string is the only place a seat
          // learns what the door can do — a stale version teaches them to
          // leave. Derive it from the param set so it cannot drift again.
          error: `unsupported param${unsupported.length > 1 ? 's' : ''}: `
            + `${unsupported.join(', ')} (supported: `
            + `${[...CARD_LIST_PARAMS].filter((p) => p !== 'as' && p !== 'bestEffort').join(', ')}`
            + ' — free-text q not yet; pass bestEffort=true to be served without the rest)',
          unsupported,
        });
      }
    }

    const result = queryCards(data.cards, {
      limit: q.limit, before: q.before, fields: q.fields,
      column: q.column, label: q.label, assignee: q.assignee, type: q.type, since: q.since,
      updatedSince: q.updatedSince,
    }, { validColumns: data.columns.map((c) => c.id) });
    if (unsupported.length) result.unsupported = unsupported; // best-effort confesses
    sendJSON(res, 200, result);
  } catch (e) {
    if (e.code === 'UNKNOWN_CURSOR' || e.code === 'UNKNOWN_FIELD' || e.code === 'UNKNOWN_FILTER_VALUE') {
      return sendJSON(res, 400, { error: e.message });
    }
    console.error('GET /api/cards:', e.message);
    sendJSON(res, 500, { error: 'Failed to list cards' });
  }
}

// #794 — bounded comment metadata for the SINGLE-CARD response.
//
// `card_get` returned the stored card object and nothing else, so a card's
// entire discussion was reachable only by a second call the reader had to know
// to make. Measured 2026-08-12: #755 carries 70 comments and a reader saw zero.
//
// ⚠️ That is worse than an ordinary omission because of this board's own
// convention: findings go in COMMENTS when a description is too large to
// rewrite safely (#534 — no compare-and-swap, so a PATCH races the whole body).
// The safe write surface was the invisible one.
//
// ⛔ DO NOT INLINE THE COMMENTS. Injecting them moves the size problem from the
// write path to the read path — the same defect wearing the other shoe. What is
// added must be bounded and must NOT grow with discussion length.
//
// ⚠️ AND THE BOUND IS ON THE INCREMENT, NOT THE RESPONSE. Review caught this
// before a line was written: #755's DESCRIPTION alone is ~100KB, so the total
// response is already unbounded against the MCP's budget. A test asserting
// "the response stays bounded" would be unsatisfiable, and would have been
// quietly reinterpreted at verification time. The honest claim is that adding
// comments beyond N does not grow what this function adds.
//
// ⭐ RESPONSE LAYER ONLY. This is derived, never stored: `cardToNode` /
// `nodeToCard` round-trip the domain object, and `domain.test.mjs:43,90` assert
// that round-trip is lossless. A derived count has no business surviving it,
// and those tests would break — correctly — if this moved onto the card.
function handleGetCard(req, res, idOrShortId) {
  try {
    const data = readBoard();
    const idx = findCardIndex(data, idOrShortId);
    if (idx < 0) return sendJSON(res, 404, { error: 'Card not found' });
    const card = data.cards[idx];
    // Spread rather than mutate: `data` came from readBoard() and the stored
    // object must not acquire a derived field.
    sendJSON(res, 200, { ...card, comments: commentMetadata(data.conversations, card.id) });
  } catch (e) {
    console.error('GET /api/cards/:id:', e.message);
    sendJSON(res, 500, { error: 'Failed to read card' });
  }
}

async function handleCreateCard(req, res) {
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw);
    if (!body.title || !body.title.trim()) {
      return sendJSON(res, 400, { error: 'title is required' });
    }
    const verr = validateCardFields(body, { surface: 'create' }); // #830
    if (verr) return sendJSON(res, 400, { error: verr });
    const created = await withWriteLock(async () => {
      const data = readBoard();
      const card = createCardFromPayload(body, data.nextShortId);
      data.cards.push(card);
      data.nextShortId = (data.nextShortId || 1) + 1;
      // #669 — the create AND every sibling its relationships rewrote (#614).
      const fanout = syncInverseRelationships(data, card, null, card.relationships);
      writeBoard(data, [
        cardEvent('create', card, card.createdBy),
        ...fanout.map((c) => cardEvent('update', c, card.createdBy)),
      ]);
      return card;
    });
    // #829 — create reports what it dropped, matching PATCH. Present only when
    // non-empty: an empty array on every response is noise a caller learns to
    // skip, which is how the original silence went unnoticed.
    const ignoredFields = unconsumedCreateFields(body);
    sendJSON(res, 201, ignoredFields.length ? { ...created, ignoredFields } : created);
  } catch (e) {
    console.error('POST /api/cards:', e.message);
    sendJSON(res, 500, { error: 'Failed to create card' });
  }
}

async function handleUpdateCard(req, res, idOrShortId) {
  try {
    const raw = await readBody(req);
    const patch = JSON.parse(raw);
    const verr = validateCardFields(patch, { checkId: false }); // id is immutable on PATCH — ignored, not validated
    if (verr) return sendJSON(res, 400, { error: verr });
    const ignoredFields = [];   // #823 — declared back to the caller
    // #831 — REFUSED is a different fact from IGNORED. "I did not recognise
    // this" and "I recognised it and will not let you change it" call for
    // different actions from the caller; one list would make a typo and a
    // policy violation indistinguishable.
    const refusedFields = [];
    const updated = await withWriteLock(async () => {
      const data = readBoard();
      const idx = findCardIndex(data, idOrShortId);
      if (idx < 0) return null;
      const card = data.cards[idx];
      const wasDone = card.column === 'done';
      let fanout = [];        // #669 — siblings this patch rewrites via #614
      let nudge = null;       // #669 — the done-nudge post, if this write emits one
      // #831 — mirror create's precedence: `assignees` (plural) wins over the
      // `assignee` alias when a caller sends both, so the result does not
      // depend on JSON key order.
      const pluralWins = Array.isArray(patch.assignees) && patch.assignees.length > 0;
      for (const [k, v] of Object.entries(patch)) {
        if (IMMUTABLE_CARD_FIELDS.has(k)) {
          // #831 — was a bare `continue`, which sat ABOVE the ignoredFields push
          // and made an immutable field the one input that vanished with no
          // diagnostic at all. Refusing it is correct (#631 — authorship is a
          // fact about the past); refusing it silently is the #823 defect.
          refusedFields.push(k);
          continue;
        }
        if (!PATCHABLE_CARD_FIELDS.has(k)) {
          // #823 — #249 keeps ignoring unknown keys (forward-compat), but it
          // must SAY SO. Silently skipping made a malformed write and a correct
          // one indistinguishable: `relatedTo` at the top level instead of
          // nested under `relationships` returned 200 and stored no edge.
          // `by` is meta (the declared editor, #675), not a card field.
          if (k !== 'by') ignoredFields.push(k);
          continue;
        }
        if (k === 'assignee') {
          // #831 — was `card[k] = v`, which wrote a RAW `assignee` key and left
          // `assignees` untouched: 200, nothing reported, intent voided, and a
          // phantom field left behind that looks like it worked. create has
          // always normalized the alias; PATCH now does the same.
          if (!pluralWins) card.assignees = [v];
          continue;
        }
        if (k === 'relationships') {
          // #614/#548 — a relationships patch is a MERGE at the type level:
          // only the keys the caller sent change; siblings survive. Clearing
          // a type takes an explicit empty array, never an omission. The
          // wholesale `card[k] = v` here was #548's silent sibling-delete.
          const before = normalizeRelationships(card.relationships);
          const merged = { ...before };
          for (const t of RELATIONSHIP_TYPES) {
            if (Array.isArray(v[t])) merged[t] = v[t];
          }
          fanout = syncInverseRelationships(data, card, before, merged); // #669
          card.relationships = merged;
          continue;
        }
        card[k] = v;
      }
      card.updatedAt = new Date().toISOString();
      // #665 — the board is the ignition: a card ENTERING done asks the room
      // for the next pull, riding the same write (#578's atomicity pattern).
      // The queue-pop rule lived in seats' intentions; rules decay, hooks
      // don't. Best-effort like every announcement — never costs the PATCH.
      if (!wasDone && card.column === 'done') {
        try {
          const conv = createConversationFromPayload({
            body: `✅ #${card.shortId} done — what's the next pull? (every done has a next: claim it, or name its gate)`,
            author: CLAIM_ANNOUNCER,
          });
          data.conversations.push(conv);
          nudge = conv;
        } catch (e) {
          console.error('#665 done-nudge skipped:', e.message);
        }
      }
      // #669 — the card, its #614 fan-out, and the done-nudge that rides this
      // same write all get their own seq, in the order they happened.
      // #675 — the declared editor (patch.by) reaches the log; the #249
      // unknown-key guard already keeps `by` off the card itself. Optional:
      // a silent caller records null, never an invented attribution.
      const by = typeof patch.by === 'string' && patch.by ? patch.by : null;
      writeBoard(data, [
        cardEvent('update', card, by),
        ...fanout.map((c) => cardEvent('update', c, by)),
        ...(nudge ? [convEvent(nudge)] : []),
      ]);
      return card;
    });
    if (!updated) return sendJSON(res, 404, { error: 'Card not found' });
    // #823 — present only when something WAS dropped, so a clean write never
    // claims it ignored something (an empty array on every response would be
    // noise the caller learns to skip).
    sendJSON(res, 200, {
      ...updated,
      ...(ignoredFields.length ? { ignoredFields } : {}),
      ...(refusedFields.length ? { refusedFields } : {}),
    });
  } catch (e) {
    console.error('PATCH /api/cards/:id:', e.message);
    sendJSON(res, 500, { error: 'Failed to update card' });
  }
}

async function handleDeleteCard(req, res, idOrShortId) {
  try {
    // #675 — a DELETE has no body by convention; the declared deleter rides
    // the query string. Optional, same trust model as every actor here.
    const by = parseQuery(req.url).by || null;
    const found = await withWriteLock(async () => {
      const data = readBoard();
      const idx = findCardIndex(data, idOrShortId);
      if (idx < 0) return false;
      const [removedCard] = data.cards.splice(idx, 1);
      // #669 — the tombstone carries the last known body, so a delete is a state
      // the log can still answer questions about, not an absence.
      writeBoard(data, [cardEvent('delete', removedCard, by)]);
      return true;
    });
    if (!found) return sendJSON(res, 404, { error: 'Card not found' });
    res.writeHead(204);
    res.end();
  } catch (e) {
    console.error('DELETE /api/cards/:id:', e.message);
    sendJSON(res, 500, { error: 'Failed to delete card' });
  }
}

// ── /api/cards/:id/claim — atomic first-write-wins claim (#348) ──
// The coordination primitive: two agents racing to claim the same card must
// resolve to exactly one winner. The compare-and-set (read claimedBy, set it
// only if empty, write) runs inside withWriteLock so the two halves cannot
// interleave — the mutex (#47) already serializes writes; this endpoint is the
// conditional that makes it first-write-wins. NOT patchable via PATCH by design.
async function handleClaimCard(req, res, idOrShortId) {
  try {
    const raw = await readBody(req);
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    // Claims serialize through the global withWriteLock; two claims on DIFFERENT
    // cards block each other unnecessarily. Fine at current scale (single-digit
    // agents, sub-Hz claims); per-card partitioning is a future optimization if
    // claim rate climbs.
    const result = await withWriteLock(async () => {
      const by = body.by;
      if (typeof by !== 'string' || !ASSIGNEE_KEY_RE.test(by)) {
        return { status: 400, payload: { error: 'invalid claimant' } };
      }
      const data = readBoard();
      const idx = findCardIndex(data, idOrShortId);
      if (idx < 0) return { status: 404, payload: { error: 'Card not found' } };
      const card = data.cards[idx];
      if (!card.claimedBy) {
        const now = new Date().toISOString();
        card.claimedBy = by;
        card.claimedAt = now;
        card.updatedAt = now;
        // #578 — the announcement rides the SAME write as the claim. Appending
        // it here rather than in a second write keeps the two atomic: there is
        // no window in which the card is claimed and the room was never told.
        const announced = appendClaimAnnouncement(data, card, by, 'claimed');
        // #669 — claim + its announcement, two events on ONE write (#578).
        writeBoard(data, [cardEvent('update', card, by),
          ...(announced ? [convEvent(announced, by)] : [])]);
        return {
          status: 200,
          payload: { claimed: true, holder: by, claimedAt: now },
          announced,
        };
      }
      // Already held — do NOT write; report the incumbent holder.
      return {
        status: 409,
        payload: { claimed: false, holder: card.claimedBy, claimedAt: card.claimedAt },
      };
    });
    // Outside the lock, fire-and-forget — same contract as an ordinary commons
    // post (#119): a down MCP server must never break claiming.
    if (result.announced) notifyMcpOfPost(result.announced);
    sendJSON(res, result.status, result.payload);
  } catch (e) {
    console.error('POST /api/cards/:id/claim:', e.message);
    sendJSON(res, 500, { error: 'Failed to claim card' });
  }
}

// ── DELETE /api/cards/:id/claim — release a claim (#348) ──
// Idempotent when already unclaimed. A held claim can only be released by its
// holder (a non-holder gets 409), so an agent can't steal a card by releasing it.
async function handleReleaseCard(req, res, idOrShortId) {
  try {
    const raw = await readBody(req);
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    const result = await withWriteLock(async () => {
      const by = body.by;
      const data = readBoard();
      const idx = findCardIndex(data, idOrShortId);
      if (idx < 0) return { status: 404, payload: { error: 'Card not found' } };
      const card = data.cards[idx];
      if (card.claimedBy && card.claimedBy !== by) {
        return { status: 409, payload: { error: 'held by other', holder: card.claimedBy } };
      }
      // Releasing an already-unclaimed card is idempotent and is NOT a
      // transition — announcing it would put a line in the room for an event
      // that did not happen.
      const wasHeld = Boolean(card.claimedBy);
      card.claimedBy = null;
      card.claimedAt = null;
      card.updatedAt = new Date().toISOString();
      const announced = wasHeld ? appendClaimAnnouncement(data, card, by, 'released') : null;
      writeBoard(data, [cardEvent('update', card, by),
        ...(announced ? [convEvent(announced, by)] : [])]);
      return { status: 200, payload: { released: true }, announced };
    });
    if (result.announced) notifyMcpOfPost(result.announced);
    sendJSON(res, result.status, result.payload);
  } catch (e) {
    console.error('DELETE /api/cards/:id/claim:', e.message);
    sendJSON(res, 500, { error: 'Failed to release card' });
  }
}

// ── /api/columns ──
function handleListColumns(req, res) {
  try {
    const data = readBoard();
    sendJSON(res, 200, data.columns);
  } catch (e) {
    console.error('GET /api/columns:', e.message);
    sendJSON(res, 500, { error: 'Failed to list columns' });
  }
}

function handleGetColumn(req, res, columnId) {
  try {
    const data = readBoard();
    const idx = findColumnIndex(data, columnId);
    if (idx < 0) return sendJSON(res, 404, { error: 'Column not found' });
    sendJSON(res, 200, data.columns[idx]);
  } catch (e) {
    console.error('GET /api/columns/:id:', e.message);
    sendJSON(res, 500, { error: 'Failed to read column' });
  }
}

async function handleCreateColumn(req, res) {
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw);
    if (!body.name || !body.name.trim()) {
      return sendJSON(res, 400, { error: 'name is required' });
    }
    const verr = validateColumnFields(body); // #299 — same shape rules as PATCH
    if (verr) return sendJSON(res, 400, { error: verr });
    const created = await withWriteLock(async () => {
      const data = readBoard();
      const id = body.id || ('col-' + Math.random().toString(36).slice(2, 10) + '-' + Math.random().toString(36).slice(2, 7));
      const order = typeof body.order === 'number' ? body.order : data.columns.length;
      const col = { id, name: body.name.trim(), order };
      data.columns.push(col);
      writeBoard(data, [columnEvent('create', col)]);
      return col;
    });
    sendJSON(res, 201, created);
  } catch (e) {
    console.error('POST /api/columns:', e.message);
    sendJSON(res, 500, { error: 'Failed to create column' });
  }
}

// #299 — columns get the same defense-in-depth cards got in #249: a patchable-
// field allowlist (no arbitrary/junk/__proto__ keys copied onto the stored
// column) + shape validation on the two fields that exist. `name` is rendered
// into an HTML attribute by the board client, so it's the same inter-agent
// trust boundary — constrain it at the API regardless of which writer sent it.
const PATCHABLE_COLUMN_FIELDS = new Set(['name', 'order']);
const MAX_COLUMN_NAME_LEN = 50; // matches the rename input's maxlength

// Returns an error string if a present column field is malformed, else null.
function validateColumnFields(body) {
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return 'name must be a string';
    if (body.name.length > MAX_COLUMN_NAME_LEN) return `name exceeds ${MAX_COLUMN_NAME_LEN} chars`;
  }
  if (body.order !== undefined && typeof body.order !== 'number') return 'order must be a number';
  return null;
}

async function handleUpdateColumn(req, res, columnId) {
  try {
    const raw = await readBody(req);
    const patch = JSON.parse(raw);
    const verr = validateColumnFields(patch);
    if (verr) return sendJSON(res, 400, { error: verr });
    const updated = await withWriteLock(async () => {
      const data = readBoard();
      const idx = findColumnIndex(data, columnId);
      if (idx < 0) return null;
      const col = data.columns[idx];
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'id') continue; // immutable
        if (!PATCHABLE_COLUMN_FIELDS.has(k)) continue; // #299 — ignore unknown keys
        col[k] = v;
      }
      writeBoard(data, [columnEvent('update', col)]);
      return col;
    });
    if (!updated) return sendJSON(res, 404, { error: 'Column not found' });
    sendJSON(res, 200, updated);
  } catch (e) {
    console.error('PATCH /api/columns/:id:', e.message);
    sendJSON(res, 500, { error: 'Failed to update column' });
  }
}

async function handleDeleteColumn(req, res, columnId) {
  try {
    const outcome = await withWriteLock(async () => {
      const data = readBoard();
      const idx = findColumnIndex(data, columnId);
      if (idx < 0) return 'missing';

      // Refuse to remove the last column. A board with none can display
      // nothing, and every card on it would point at something absent.
      if (data.columns.length <= 1) return 'last';

      // Cards in the doomed column move; they do NOT stay behind pointing at a
      // column that no longer exists. A card referencing a missing column
      // renders nowhere — it is still in the data, still in the API, and
      // invisible in the only place anyone looks. Losing work to a dangling
      // reference is far worse than finding it in an unexpected column, so the
      // rule is simple: deleting a container never deletes what's inside it.
      const [removed] = data.columns.splice(idx, 1);
      const fallback = data.columns[0].id;
      let moved = 0;
      const reassigned = [];
      for (const card of data.cards) {
        if (card.column === removed.id) { card.column = fallback; moved++; reassigned.push(card); }
      }
      // #669 — deleting a column MOVES every card in it. Each move is a real
      // change to that card and gets its own event; otherwise a card's history
      // shows it in a column it was never put in.
      writeBoard(data, [columnEvent('delete', removed),
        ...reassigned.map((c) => cardEvent('update', c))]);
      return { moved, fallback };
    });

    if (outcome === 'missing') return sendJSON(res, 404, { error: 'Column not found' });
    if (outcome === 'last') {
      return sendJSON(res, 400, { error: 'Cannot delete the last column — the board would have nowhere to show cards' });
    }
    if (outcome.moved) res.setHeader('X-Cards-Moved', `${outcome.moved} to ${outcome.fallback}`);
    res.writeHead(204);
    res.end();
  } catch (e) {
    console.error('DELETE /api/columns/:id:', e.message);
    sendJSON(res, 500, { error: 'Failed to delete column' });
  }
}

// ── /api/conversations (#93) ──
// Board-level Slack-like commons. Append-only, plain text, no shortId,
// no editing, no intent field. `attachedTo` is reserved for forward-compat
// with the future card-attached threads feature (#39) — v1 only uses null.

// #699 — mention extraction now validates against the ROSTER and canonicalises
// display names to seat keys. The #110 parser recorded any `@word`, which on
// the live board meant 86 distinct "people" for a six-person room. The harm it
// actually caused is narrow and real: `?mentions_me=<key>` missed posts that
// spelled a seat by its display name. Implementation + tests: core/people.mjs.
function extractMentions(text) {
  return extractMentionsFromRoster(text, ROSTER);
}

function createConversationFromPayload(body) {
  const now = new Date().toISOString();
  const text = (typeof body.body === 'string') ? body.body : '';
  return {
    id: crypto.randomUUID(),
    body: text,
    author: (typeof body.author === 'string' && body.author.length > 0) ? body.author : 'unassigned',
    // #688: the literal string "null" is a client's serialized absence, not a
    // card ref — 42 live posts proved this write path stores it verbatim.
    attachedTo: (typeof body.attachedTo === 'string' && body.attachedTo.length > 0 && body.attachedTo !== 'null') ? body.attachedTo : null,
    attachments: sanitizeAttachments(body.attachments),
    mentions: extractMentions(text),
    createdAt: now,
  };
}

function findConversationIndex(data, id) {
  return data.conversations.findIndex(c => c.id === id);
}

// Parse query string from req.url. Returns a plain object.
function parseQuery(reqUrl) {
  const qIdx = reqUrl.indexOf('?');
  if (qIdx < 0) return {};
  const qs = reqUrl.slice(qIdx + 1);
  const out = {};
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq));
    const v = decodeURIComponent(eq < 0 ? '' : pair.slice(eq + 1));
    out[k] = v;
  }
  return out;
}

// #210 — cap for the opt-in `limit` param (bounded load + load-older). No-param
// list stays uncapped (#202: the browser's full-history fetch).
const MAX_CONV_LIST_LIMIT = Number(process.env.SCRUM_MAX_CONV_LIST_LIMIT) || 200;

/**
 * #777 — the SUPPORTED set. An unknown param is REFUSED, not ignored.
 *
 * This endpoint used to drop unrecognised params silently and answer with its
 * entire corpus — 14,468 conversations the day this shipped — under a 200. So
 * `?athor=wren` (one keystroke from `author`) and `?` with no filter at all
 * returned byte-identical responses, and the typo read exactly like a filter
 * that matched everything.
 *
 * ⚠️ The pattern that refuses already existed one endpoint over: `/api/changes`
 * and `/api/cards` both 400 with the offending param AND the supported set, and
 * #683's `/api/cursors/*` shipped with `queryGuard` from birth citing this very
 * card. Nothing here is a new idea — it is the same guard, finally applied.
 *
 * ⚠️ Keep this list in step with the filters below. A param that is read but
 * missing from the set becomes a 400 for a caller who was doing nothing wrong,
 * which is a worse defect than the one being fixed — hence a positive control
 * per param in tests/conversations-params.test.mjs.
 */
const CONVERSATION_PARAMS = new Set([
  'attachedTo', 'author', 'since', 'mentions_me', 'before', 'limit',
]);

function handleListConversations(req, res) {
  try {
    const q = queryGuard(req, res, CONVERSATION_PARAMS);
    if (!q) return;                       // guard already sent the 400
    const data = readBoard();
    let convs = data.conversations;
    if (typeof q.attachedTo === 'string') {
      // Allow "null" string to filter to board-level conversations
      if (q.attachedTo === 'null') convs = convs.filter(c => c.attachedTo === null);
      else {
        // #778 — RESOLVE THE CARD, or refuse. `attachedTo` is not free text: it
        // names a card, and this server holds the card list, so "does this id
        // resolve?" is a question it can answer and used not to ask.
        //
        // Without this, a card id that resolves to nothing returned 200 and an
        // empty list — byte-identical to a real card with no discussion. On
        // 2026-08-10 that cost a reader a wrong conclusion: the number printed
        // on every card is its shortId, `attachedTo=755` matches no UUID, and
        // the answer was a well-formed empty thread that read as "never
        // discussed". This is the reader-facing half of #761; the join fix
        // (accepting both key formats) is separate and larger.
        //
        // ⚠️ The check asks the CARD list, not the post list. Refusing when the
        // RESULT is empty would collapse the same two states in the other
        // direction — a real, quiet card would refuse too.
        if (!data.cards.some((c) => c.id === q.attachedTo)) {
          const looksLikeShortId = /^\d+$/.test(q.attachedTo);
          return sendJSON(res, 404, {
            error: `no card with id ${q.attachedTo}`
              + (looksLikeShortId
                ? ' — that looks like a shortId (the number printed on the card); pass the card\'s UUID instead'
                : ''),
            code: 'NO_SUCH_CARD',
            attachedTo: q.attachedTo,
          });
        }
        convs = convs.filter(c => c.attachedTo === q.attachedTo);
      }
    }
    if (typeof q.author === 'string') {
      convs = convs.filter(c => c.author === q.author);
    }
    if (typeof q.since === 'string') {
      convs = convs.filter(c => typeof c.createdAt === 'string' && c.createdAt >= q.since);
    }
    if (typeof q.mentions_me === 'string') {
      const who = q.mentions_me.toLowerCase();
      convs = convs.filter(c => Array.isArray(c.mentions) && c.mentions.includes(who));
    }
    // #210 — backward pagination for the browser's bounded load + load-older.
    // `before`: strictly older than the cursor (same safe string-compare as
    // `since`). `limit`: the N most-recent of the filtered set, capped so a
    // client can't request an unbounded slice. No-param stays uncapped (#202).
    if (typeof q.before === 'string') {
      convs = convs.filter(c => typeof c.createdAt === 'string' && c.createdAt < q.before);
    }
    if (typeof q.limit === 'string' && q.limit !== '') {
      const n = parseInt(q.limit, 10);
      if (Number.isFinite(n) && n >= 0) {
        const capped = Math.min(n, MAX_CONV_LIST_LIMIT);
        convs = capped <= 0 ? [] : convs.slice(-capped);   // the N most-recent
      }
    }
    sendJSON(res, 200, convs);
  } catch (e) {
    console.error('GET /api/conversations:', e.message);
    sendJSON(res, 500, { error: 'Failed to list conversations' });
  }
}

function handleGetConversation(req, res, id) {
  try {
    const data = readBoard();
    const idx = findConversationIndex(data, id);
    if (idx < 0) return sendJSON(res, 404, { error: 'Conversation not found' });
    sendJSON(res, 200, data.conversations[idx]);
  } catch (e) {
    console.error('GET /api/conversations/:id:', e.message);
    sendJSON(res, 500, { error: 'Failed to read conversation' });
  }
}

async function handleCreateConversation(req, res) {
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw);
    // Validation: body and author required + non-empty
    // #113 — body OR an attachment is required (enables paste-and-go image posts).
    const hasAttachments = sanitizeAttachments(body.attachments).length > 0;
    if ((typeof body.body !== 'string' || body.body.trim().length === 0) && !hasAttachments) {
      return sendJSON(res, 400, { error: 'body or an attachment is required' });
    }
    if (typeof body.author !== 'string' || body.author.trim().length === 0) {
      return sendJSON(res, 400, { error: 'author is required (non-empty string)' });
    }
    const created = await withWriteLock(async () => {
      const data = readBoard();
      const conv = createConversationFromPayload(body);
      data.conversations.push(conv);
      writeBoard(data, [convEvent(conv)]);
      return conv;
    });
    notifyMcpOfPost(created);
    sendJSON(res, 201, created);
  } catch (e) {
    console.error('POST /api/conversations:', e.message);
    sendJSON(res, 500, { error: 'Failed to create conversation' });
  }
}

// POST /api/attachments (#113) — base64-JSON upload, stored UUID-keyed on disk.
async function handleCreateAttachment(req, res) {
  try {
    const raw = await readBody(req, MAX_ATTACHMENT_BODY_BYTES); // #250 — larger cap; base64 of a 25MB file ≈ 34MB
    // Memory guard: the JSON envelope can't dwarf the byte cap (base64 ~1.34x + slop).
    if (raw.length > MAX_ATTACHMENT_BYTES * 1.4 + 1024 * 1024) {
      return sendJSON(res, 413, { error: 'attachment too large' });
    }
    let body;
    try { body = JSON.parse(raw); } catch { return sendJSON(res, 400, { error: 'invalid JSON' }); }
    if (typeof body.data !== 'string' || body.data.length === 0) {
      return sendJSON(res, 400, { error: 'data (base64) is required' });
    }
    const name = (typeof body.name === 'string' && body.name.trim()) ? body.name.trim() : 'file';
    const mime = (typeof body.mime === 'string' && body.mime) ? body.mime.toLowerCase() : 'application/octet-stream';
    if (isBlockedAttachment(name, mime)) {
      return sendJSON(res, 400, { error: 'file type not allowed (executables, scripts, html and svg are blocked)' });
    }
    const bytes = Buffer.from(body.data, 'base64');
    if (bytes.length === 0) return sendJSON(res, 400, { error: 'empty or invalid base64 data' });
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      return sendJSON(res, 413, { error: `attachment exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit` });
    }
    const ext = MIME_TO_EXT[mime] || 'bin';
    const id = `${crypto.randomUUID()}.${ext}`;
    fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(ATTACHMENTS_DIR, id), bytes);
    sendJSON(res, 201, { id, name, mime, size: bytes.length });
  } catch (e) {
    console.error('POST /api/attachments:', e.message);
    sendJSON(res, 500, { error: 'Failed to store attachment' });
  }
}

// GET /api/attachments/:id (#113) — serve raster images inline, everything else
// as a forced download (octet-stream + attachment), always nosniff. This is the
// stored-XSS guard: nothing uploaded can execute in our origin.
function serveAttachment(req, res, rawId) {
  let id;
  try { id = decodeURIComponent(rawId); } catch { id = rawId; }
  if (!ATTACHMENT_ID_RE.test(id)) {
    res.writeHead(400, { 'X-Content-Type-Options': 'nosniff' });
    return res.end('Bad Request');
  }
  let realDir, realFile;
  try {
    realDir = fs.realpathSync(ATTACHMENTS_DIR);
    realFile = fs.realpathSync(path.join(ATTACHMENTS_DIR, id));
  } catch {
    res.writeHead(404, { 'X-Content-Type-Options': 'nosniff' });
    return res.end('Not Found');
  }
  // Defense in depth: resolved file must stay within the attachments dir.
  if (realFile !== realDir && !realFile.startsWith(realDir + path.sep)) {
    res.writeHead(403, { 'X-Content-Type-Options': 'nosniff' });
    return res.end('Forbidden');
  }
  let content;
  try { content = fs.readFileSync(realFile); } catch {
    res.writeHead(404, { 'X-Content-Type-Options': 'nosniff' });
    return res.end('Not Found');
  }
  const ext = path.extname(id).toLowerCase().slice(1);
  const inlineType = EXT_TO_INLINE_TYPE[ext] || null;
  const headers = { 'Content-Length': content.length, 'X-Content-Type-Options': 'nosniff' };
  if (inlineType) {
    headers['Content-Type'] = inlineType;
  } else {
    headers['Content-Type'] = 'application/octet-stream';
    headers['Content-Disposition'] = 'attachment';
  }
  res.writeHead(200, headers);
  res.end(content);
}

// ── /api/nodes (the wiki read API) — node-shaped projection + page view ──
// Built on the proven foundation: loadDomain → nodes, buildTree (hierarchy),
// buildChildIndex (children), buildLinkIndex (backlinks). Read-only.
function handleListNodes(req, res) {
  try {
    const { nodes } = loadDomain(BOARD_DATA_FILE);
    sendJSON(res, 200, { nodes, tree: buildTree(nodes) });
  } catch (e) {
    console.error('GET /api/nodes:', e.message);
    sendJSON(res, 500, { error: 'Failed to list nodes' });
  }
}

function handleGetNode(req, res, idOrShortId) {
  try {
    const { nodes } = loadDomain(BOARD_DATA_FILE);
    const node = nodes.find(
      (n) => n['@id'] === idOrShortId || String(n.identifier) === idOrShortId,
    );
    if (!node) return sendJSON(res, 404, { error: 'Node not found' });
    const byId = new Map(nodes.map((n) => [n['@id'], n]));
    const { children } = buildChildIndex(nodes);
    const { backlinks } = buildLinkIndex(nodes);
    sendJSON(res, 200, {
      node,
      children: (children.get(node['@id']) || []).map((id) => byId.get(id)),
      backlinks: (backlinks.get(node['@id']) || []).map((id) => byId.get(id)),
    });
  } catch (e) {
    console.error('GET /api/nodes/:id:', e.message);
    sendJSON(res, 500, { error: 'Failed to read node' });
  }
}

// #223 — events→subscribers: a page create/content-edit posts a compact notice
// to the commons FEED so the room sees wiki activity (ADR-002 D1, minimal form).
// The `#NNN` linkifies to the card in the commons (#291/#303-1). Appended into
// the SAME board write as the node change (one file write). Deliberately feed-
// only — NOT channel-broadcast — so page-saves show up for whoever's looking
// without waking every agent's reply loop (channel-push is a future toggle).
function appendWikiNotice(data, verb, card) {
  const title = (card.title || 'untitled').trim();
  const body = `📄 page ${verb}: **${title}** (#${card.shortId})`;
  const conv = createConversationFromPayload({ body, author: 'wiki' });
  data.conversations.push(conv);
  return conv;
}

// Create a node (wiki page). Node-shaped in (title/body/parent/type) and out.
// Internally a card; the node ↔ card mapping is the single source of truth.
async function handleCreateNode(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    if (!body.title || !body.title.trim()) return sendJSON(res, 400, { error: 'title is required' });
    const verr = validateCardFields({ type: body.type });
    if (verr) return sendJSON(res, 400, { error: verr });
    let notice = null;
    const created = await withWriteLock(async () => {
      const data = readBoard();
      // #631 — createdBy MUST be forwarded explicitly. This route hand-builds
      // its payload instead of passing `body` through, so teaching
      // createCardFromPayload about a new field does NOT reach the wiki surface:
      // a card made here would silently have no author. Same shape as
      // settings.html's collectRoster() dropping roster fields its form had no
      // input for. THE SHARED FUNCTION IS NEVER THE GUARANTEE — THE CALLERS ARE.
      const card = createCardFromPayload(
        {
          title: body.title,
          description: body.body || '',
          type: body.type || 'reference',
          createdBy: body.createdBy,
        },
        data.nextShortId,
      );
      if (typeof body.parent === 'string') card.parent = body.parent;
      if (body.attachments !== undefined) card.attachments = sanitizeAttachments(body.attachments); // #222
      data.cards.push(card);
      data.nextShortId = (data.nextShortId || 1) + 1;
      const notice = appendWikiNotice(data, 'created', card); // #223
      writeBoard(data, [cardEvent('create', card, card.createdBy),
        ...(notice ? [convEvent(notice)] : [])]);
      return card;
    });
    sendJSON(res, 201, cardToNode(created));
  } catch (e) {
    console.error('POST /api/nodes:', e.message);
    sendJSON(res, 500, { error: 'Failed to create node' });
  }
}

// #220 — would setting node `childId`'s parent to `newParentId` create a cycle?
// True if newParentId IS the node, or is one of its descendants (walk up from
// newParentId via `parent`; if we reach childId, it's a cycle). Guards drag-drop
// reparent so a node can't vanish into a cycle (no root path).
function reparentWouldCycle(cards, childId, newParentId) {
  if (newParentId == null) return false;         // clearing → root, never a cycle
  if (newParentId === childId) return true;      // self-parent
  const parentOf = new Map(cards.map((c) => [c.id, c.parent ?? null]));
  let cur = newParentId;
  const seen = new Set();
  while (cur != null) {
    if (cur === childId) return true;            // childId is an ancestor of newParent → cycle
    if (seen.has(cur)) break;                    // pre-existing cycle upstream — stop
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}

// #841 — the keys this route actually consumes, kept HERE rather than beside
// PATCHABLE_CARD_FIELDS on purpose.
//
// ⛔ DO NOT MERGE THIS WITH THE CARDS ALLOWLIST. The two routes have different
// vocabularies over the same stored record: `body` is real here (it becomes
// card.description) and unknown on /api/cards; `priority` is the reverse. A
// shared set would either start reporting the wiki's own field as ignored or
// stop reporting a genuinely dropped one — and the failure would be silent on
// the surface where the lost data is hand-written prose. The physical distance
// from the cards sets is the cheapest guard available against a future tidying
// pass; tests/nodes-ignored-fields.test.mjs (RC3) is the one that actually bites.
const NODE_PATCH_CONSUMED_FIELDS = new Set(['title', 'body', 'parent', 'attachments']);

// Edit a node — title / body / parent (parent: null clears it → becomes a root).
async function handleUpdateNode(req, res, idOrShortId) {
  try {
    const patch = JSON.parse(await readBody(req));
    // #841 — computed from the REQUEST, before any write, so it describes what
    // the caller sent rather than what survived. Reported only when non-empty:
    // an empty array on every response is noise a caller learns to skip past,
    // which is how the diagnostic stops being read at all.
    const ignoredFields = Object.keys(patch).filter((k) => !NODE_PATCH_CONSUMED_FIELDS.has(k));
    let cycle = false;
    // #223 — notice only on CONTENT change (title/body); a parent-only reparent
    // (e.g. a drag) is silent so tree-reorg doesn't spam the room.
    const contentChanged = ('title' in patch) || ('body' in patch);
    const updated = await withWriteLock(async () => {
      const data = readBoard();
      const idx = findCardIndex(data, idOrShortId);
      if (idx < 0) return null;
      const card = data.cards[idx];
      if ('parent' in patch && reparentWouldCycle(data.cards, card.id, patch.parent)) {
        cycle = true;
        return card; // don't write; reported as 409 below
      }
      if ('title' in patch) card.title = patch.title;
      if ('body' in patch) card.description = patch.body;
      if ('parent' in patch) card.parent = patch.parent;
      if ('attachments' in patch) card.attachments = sanitizeAttachments(patch.attachments); // #222
      card.updatedAt = new Date().toISOString();
      const notice = contentChanged ? appendWikiNotice(data, 'updated', card) : null; // #223
      writeBoard(data, [cardEvent('update', card),
        ...(notice ? [convEvent(notice)] : [])]);
      return card;
    });
    if (!updated) return sendJSON(res, 404, { error: 'Node not found' });
    if (cycle) return sendJSON(res, 409, { error: 'That move would make the page a descendant of itself.' });
    const node = cardToNode(updated);
    sendJSON(res, 200, ignoredFields.length ? { ...node, ignoredFields } : node);
  } catch (e) {
    console.error('PATCH /api/nodes/:id:', e.message);
    sendJSON(res, 500, { error: 'Failed to update node' });
  }
}

// ── /api/cursors — #683: the deafness cure's production path ──
//
// PUSH IS A DOORBELL, PULL IS THE GUARANTEE. Fan-out never advances anything;
// what a lane has actually received is tracked here, server-side, because the
// clients are measurably heterogeneous and a guarantee that depends on client
// cooperation is not a guarantee.
//
// These endpoints live on REST rather than in mcp-server because REST owns the
// event log — the same reason /api/changes lives here. mcp-server knows seat
// identity and asks; it never learns a log path (#767's shape).
//
// ⚠️ FAIL-CLOSED ON UNKNOWN PARAMS from birth. `/api/conversations` silently
// ignores them and returns its whole corpus with a 200 (#777, found the night
// this shipped); the pattern that refuses already existed one endpoint over and
// was simply never applied. A new surface starts with it.
const CURSOR_PARAMS = new Set(['identity', 'limit', 'via', 'as']);

function queryGuard(req, res, extra = CURSOR_PARAMS) {
  const q = parseQuery(req.url);
  const unsupported = Object.keys(q).filter((k) => !extra.has(k));
  if (unsupported.length) {
    sendJSON(res, 400, {
      error: `unsupported param${unsupported.length > 1 ? 's' : ''}: ${unsupported.join(', ')} `
        + `(supported: ${[...extra].join(', ')})`,
      unsupported,
    });
    return null;
  }
  return q;
}

/** GET /api/cursors — the reachability projection, inbound-evidence only. */
function handleCursorReport(req, res) {
  const q = queryGuard(req, res, new Set(['as', 'inputs', 'streamOpen']));
  if (!q) return;
  try {
    // `inputs=stream_open` is the card's POSITIVE CONTROL and nothing else: the
    // banned instrument, kept runnable so its disagreement with the inbound
    // projection can be demonstrated rather than argued. It scored a seat
    // healthy for eight hours while it received nothing.
    const report = reachabilityReport(EVENT_LOG_DIR, {
      inputs: q.inputs === 'stream_open' ? 'stream_open' : 'inbound',
    });
    sendJSON(res, 200, { head_seq: headSeq(EVENT_LOG_DIR), lanes: report });
  } catch (e) {
    console.error('GET /api/cursors:', e.message);
    sendJSON(res, 500, { error: 'Failed to compute reachability' });
  }
}

/** POST /api/cursors/register — a lane announces itself. Known lanes KEEP their cursor. */
async function handleCursorRegister(req, res) {
  try {
    const body = JSON.parse((await readBody(req)) || '{}');
    const id = deliveryIdentity(body || {});
    if (!id) {
      // An anonymous connection gets NO cursor and is told so. Inventing a key
      // would create replay state nothing can ever resume and pin retention.
      return sendJSON(res, 400, {
        error: 'no durable delivery identity: pass registrySeatId (a #410 lane) or bearerSeat',
        code: 'NO_DELIVERY_IDENTITY',
      });
    }
    const out = registerFor(EVENT_LOG_DIR, id.key);
    sendJSON(res, 200, { identity: id, ...out });
  } catch (e) {
    console.error('POST /api/cursors/register:', e.message);
    sendJSON(res, 500, { error: 'Failed to register cursor' });
  }
}

/**
 * GET /api/cursors/pull — what this lane missed.
 *
 * ⚠️ The commit happens AFTER the response is written, not before. Recording at
 * the moment of deciding what to send is #624 reimplemented inside its own
 * cure: a response that dies in flight would still advance the cursor.
 */
function handleCursorPull(req, res) {
  const q = queryGuard(req, res);
  if (!q) return;
  if (!q.identity) {
    // #799 — the example must TEACH the format without naming a real seat. This
    // is the only seat name that ever reached an API response body; every other
    // occurrence in the tree is a comment or test-internal fixture.
    return sendJSON(res, 400, { error: 'identity is required (e.g. registry:<seat>.<client>)' });
  }
  try {
    const limit = q.limit ? Math.min(Number(q.limit) || PULL_LIMIT, PULL_LIMIT) : PULL_LIMIT;
    const pull = serveFor(EVENT_LOG_DIR, q.identity, { limit, via: q.via || null });
    if (pull.refused === 'CURSOR_TOO_OLD') {
      // Refuse, never answer partially — the same contract /api/changes has had
      // since #679. Serving "whatever survived" would let the lane ack past
      // events it can never receive, which is the silent loss this cures.
      return sendJSON(res, 400, {
        error: `this lane's cursor (${pull.envelope.last_acked_seq}) predates the log's `
          + `retention (oldest surviving seq ${pull.gap.oldestSeq}) — events ${pull.gap.missingFrom}`
          + `–${pull.gap.missingTo} are gone and cannot be replayed`,
        code: 'CURSOR_TOO_OLD', resync: true, hint: pull.resync,
        oldest_retained_seq: pull.gap.oldestSeq, oldest_retained_at: pull.gap.oldestAt,
        envelope: pull.envelope,
      });
    }
    if (!pull.known) {
      return sendJSON(res, 404, {
        error: `no cursor for ${q.identity} — register the lane first`,
        code: 'LANE_NOT_REGISTERED', envelope: pull.envelope,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events: pull.events, envelope: pull.envelope }), () => {
      // The response is on the wire. Only now is it honest to say it was served.
      try { pull.commit(); } catch (e) { console.error('[#683] commit failed:', e.message); }
    });
  } catch (e) {
    console.error('GET /api/cursors/pull:', e.message);
    sendJSON(res, 500, { error: 'Failed to serve replay' });
  }
}

/** POST /api/cursors/inbound — the implicit ack: the lane was alive AFTER the response. */
async function handleCursorInbound(req, res) {
  try {
    const body = JSON.parse((await readBody(req)) || '{}');
    const key = body.identity || deliveryIdentity(body)?.key;
    if (!key) return sendJSON(res, 400, { error: 'identity is required', code: 'NO_DELIVERY_IDENTITY' });
    const out = noteInbound(EVENT_LOG_DIR, key, { via: body.via ?? null });
    if (out.fenced) {
      // Named, because the symptom of duplicate lane config is THRASH, not
      // loss, and thrash reads as "replay is broken" unless the log says
      // otherwise. Identity only — no secrets.
      console.warn(
        `[#683] CURSOR_PENDING_INVALIDATED_BY_SUPERSESSION identity=${key} `
        + `via=${body.via ?? 'null'} — a session acked a range served to another; re-serving`,
      );
    }
    sendJSON(res, 200, out);
  } catch (e) {
    console.error('POST /api/cursors/inbound:', e.message);
    sendJSON(res, 500, { error: 'Failed to record inbound' });
  }
}

// ── Router: regex-based match against API_ROUTES ──
const API_ROUTES = [
  { method: 'GET',    re: /^\/api\/changes$/,              fn: (req, res) => handleChanges(req, res) },
  { method: 'GET',    re: /^\/api\/cursors$/,              fn: (req, res) => handleCursorReport(req, res) },
  { method: 'POST',   re: /^\/api\/cursors\/register$/,    fn: (req, res) => handleCursorRegister(req, res) },
  { method: 'GET',    re: /^\/api\/cursors\/pull$/,        fn: (req, res) => handleCursorPull(req, res) },
  { method: 'POST',   re: /^\/api\/cursors\/inbound$/,     fn: (req, res) => handleCursorInbound(req, res) },
  { method: 'POST',   re: /^\/api\/graph$/,                fn: (req, res) => handleGraphQuery(req, res) },
  { method: 'GET',    re: /^\/api\/ready$/,                fn: (req, res) => handleReady(req, res) },       // #815
  { method: 'GET',    re: /^\/api\/board\/status$/,         fn: (req, res) => handleBoardStatus(req, res) },
  { method: 'GET',    re: /^\/api\/board$/,                fn: (req, res) => handleGetBoard(req, res) },
  { method: 'GET',    re: /^\/api\/roster$/,               fn: (req, res) => handleGetRoster(req, res) },
  { method: 'GET',    re: /^\/api\/config\/limits$/,       fn: (req, res) => handleGetConfigLimits(req, res) },
  { method: 'GET',    re: /^\/api\/config$/,               fn: (req, res) => handleGetConfig(req, res) },
  { method: 'GET',    re: /^\/api\/channel-status$/,       fn: (req, res) => handleChannelStatus(req, res) },
  { method: 'POST',   re: /^\/api\/config$/,               fn: (req, res) => handleSetConfig(req, res) },
  { method: 'POST',   re: /^\/api\/roster$/,               fn: (req, res) => handleSetRoster(req, res) },   // #506
  { method: 'GET',    re: /^\/api\/people$/,               fn: (req, res) => handleListPeople(req, res) },       // #619
  { method: 'GET',    re: /^\/api\/people\/([^\/]+)$/,     fn: (req, res, m) => handleGetPerson(req, res, m[1]) }, // #619
  { method: 'GET',    re: /^\/api\/cards$/,                fn: (req, res) => handleListCards(req, res) },
  { method: 'POST',   re: /^\/api\/cards$/,                fn: (req, res) => handleCreateCard(req, res) },
  { method: 'POST',   re: /^\/api\/cards\/([^\/]+)\/claim$/, fn: (req, res, m) => handleClaimCard(req, res, m[1]) },
  { method: 'DELETE', re: /^\/api\/cards\/([^\/]+)\/claim$/, fn: (req, res, m) => handleReleaseCard(req, res, m[1]) },
  { method: 'GET',    re: /^\/api\/cards\/([^\/]+)$/,      fn: (req, res, m) => handleGetCard(req, res, m[1]) },
  { method: 'PATCH',  re: /^\/api\/cards\/([^\/]+)$/,      fn: (req, res, m) => handleUpdateCard(req, res, m[1]) },
  { method: 'DELETE', re: /^\/api\/cards\/([^\/]+)$/,      fn: (req, res, m) => handleDeleteCard(req, res, m[1]) },
  { method: 'GET',    re: /^\/api\/columns$/,              fn: (req, res) => handleListColumns(req, res) },
  { method: 'POST',   re: /^\/api\/columns$/,              fn: (req, res) => handleCreateColumn(req, res) },
  { method: 'GET',    re: /^\/api\/columns\/([^\/]+)$/,    fn: (req, res, m) => handleGetColumn(req, res, m[1]) },
  { method: 'PATCH',  re: /^\/api\/columns\/([^\/]+)$/,    fn: (req, res, m) => handleUpdateColumn(req, res, m[1]) },
  { method: 'DELETE', re: /^\/api\/columns\/([^\/]+)$/,    fn: (req, res, m) => handleDeleteColumn(req, res, m[1]) },
  { method: 'GET',    re: /^\/api\/conversations$/,                fn: (req, res) => handleListConversations(req, res) },
  { method: 'POST',   re: /^\/api\/conversations$/,                fn: (req, res) => handleCreateConversation(req, res) },
  { method: 'GET',    re: /^\/api\/conversations\/([^\/]+)$/,      fn: (req, res, m) => handleGetConversation(req, res, m[1]) },
  { method: 'POST',   re: /^\/api\/attachments$/,                  fn: (req, res) => handleCreateAttachment(req, res) },
  { method: 'GET',    re: /^\/api\/attachments\/([^\/]+)$/,        fn: (req, res, m) => serveAttachment(req, res, m[1]) },
  { method: 'GET',    re: /^\/api\/nodes$/,                        fn: (req, res) => handleListNodes(req, res) },
  { method: 'POST',   re: /^\/api\/nodes$/,                        fn: (req, res) => handleCreateNode(req, res) },
  { method: 'GET',    re: /^\/api\/nodes\/([^\/]+)$/,              fn: (req, res, m) => handleGetNode(req, res, m[1]) },
  { method: 'PATCH',  re: /^\/api\/nodes\/([^\/]+)$/,              fn: (req, res, m) => handleUpdateNode(req, res, m[1]) },
];

function routeApi(method, urlPath, req, res) {
  for (const r of API_ROUTES) {
    if (r.method !== method) continue;
    const m = urlPath.match(r.re);
    if (m) {
      r.fn(req, res, m);
      return true;
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════
// Legacy whole-board endpoints (browser UI still uses these — out of
// scope to migrate per #90's "Out of Scope")
// ═══════════════════════════════════════════════════════════════════

/**
 * Handle GET /api/load — read board-data.json from disk
 */
function handleLoad(req, res) {
  try {
    // #235 — project through the node-domain to the legacy {cards, conversations,
    // columns, …} shape the browser parses. Must NOT return the raw on-disk file:
    // since #227 that's schema.org JSON-LD (@graph), which has no `cards` key, so
    // the board would fail to hydrate and fall back to (stale) localStorage.
    // readBoard() handles the missing-file case (empty domain → empty board).
    //
    // #657 — conversations are omitted: 18.7MB of the 20.4MB payload was
    // conversation history that index.html transfers, parses, and never reads
    // (its commons panel is fed exclusively by bounded /api/conversations
    // fetches; /api/save never writes conversations, so nothing can echo this
    // empty list back to disk). The key stays present-but-empty with an
    // explicit flag so a reader can tell "none exist" from "not sent".
    //
    // #671 — but BULK CONSUMERS still need the whole board, and #657 broke one
    // silently: export-board.mjs reads the room from here, its source went to
    // zero, and only its own fail-closed guard turned that into a visible break
    // instead of five months of truncated archives. The honest flag was not
    // enough — nothing consumed it. So the omission stays the DEFAULT (the
    // browser keeps its lean payload) and bulk callers opt in explicitly.
    //
    // ⚠️ Do NOT "fix" such a consumer by pointing it at /api/conversations
    // instead: that endpoint is capped server-side at 200 (#210) with no
    // cursor, so it returns a silently truncated answer that looks complete.
    // That trap is why export-board reads this endpoint at all, and it was
    // proposed twice on 2026-08-04 by people who had both read the warning.
    const board = readBoard();
    if (parseQuery(req.url).conversations === '1') { sendJSON(res, 200, board); return; }
    const { conversations, ...rest } = board;
    sendJSON(res, 200, { ...rest, conversations: [], conversationsOmitted: true });
  } catch (e) {
    console.error('Error in /api/load:', e.message);
    sendJSON(res, 500, { error: 'Failed to load board data' });
  }
}

/**
 * Serve a static file from the project directory
 */
function serveStaticFile(req, res) {
  let urlPath = req.url.split('?')[0]; // strip query string
  if (urlPath === '/') urlPath = '/index.html';

  // #251 — the attachments subtree is read ONLY through the hardened
  // /api/attachments/:id route (nosniff + forced download for non-images).
  // Refuse to serve it as a static file, where Content-Type would come from the
  // extension with no such hardening — keep exactly one read path for untrusted
  // bytes, regardless of where the attachments dir sits relative to the root.
  //
  // #300 — the static root IS the project dir, which also holds sensitive
  // subtrees that no client needs: .git (full history, incl. reworded/deleted
  // content — #217), backups/ (states the live board lost), and node_modules/.
  // They pass the traversal guard (they're genuinely inside the root), so deny
  // them explicitly by prefix. Matched on the leading path segment so a
  // legitimate file like /backups-guide.html is unaffected.
  const DENY_STATIC_PREFIXES = ['/attachments', '/.git', '/backups', '/node_modules'];
  if (DENY_STATIC_PREFIXES.some((p) => urlPath === p || urlPath.startsWith(p + '/'))) {
    res.writeHead(404);
    return res.end('Not Found');
  }

  // #488 — every browser asks for /favicon.ico unprompted, and this project ships
  // none, so every first page load logged a console 404. Found by the served lane
  // being made intolerant of page errors: the check's first act was to surface a
  // real blemish on the surface we call the product.
  //
  // 204 rather than an allow-list entry in the test, because removing the error
  // is stronger than agreeing to tolerate it — and it means the served lane keeps
  // a zero-exception promise. 204 also tells the browser to stop asking. Shipping
  // an actual icon is a separate, cosmetic choice; this only kills the error.
  if (urlPath === '/favicon.ico' && !fs.existsSync(path.join(STATIC_DIR, 'favicon.ico'))) {
    res.writeHead(204);
    return res.end();
  }

  const requestedPath = path.join(STATIC_DIR, urlPath);

  // Resolve symlinks and `..` to a canonical path BEFORE the boundary
  // check. A plain startsWith() is fooled by a symlink inside the root
  // that points outside it, and by a sibling directory whose name shares
  // the root as a prefix (e.g. <root> vs <root>-secrets).
  let realPath;
  try {
    realPath = fs.realpathSync(requestedPath);
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' ? 404 : 403);
    return res.end(e.code === 'ENOENT' ? 'Not Found' : 'Forbidden');
  }

  // Prevent directory traversal: the resolved path must be the static
  // root itself or genuinely nested beneath it.
  if (realPath !== REAL_STATIC_DIR && !realPath.startsWith(REAL_STATIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  if (fs.statSync(realPath).isDirectory()) {
    res.writeHead(404);
    return res.end('Not Found');
  }

  const ext = path.extname(realPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    let content = fs.readFileSync(realPath);

    // Inline the roster into HTML so the page has it before first paint. Done
    // here rather than in each page so a new page can never forget to ask.
    if (ext === '.html') {
      const html = content.toString('utf8');
      const marker = html.includes('</head>') ? '</head>' : '<body>';
      content = Buffer.from(
        html.includes(marker) ? html.replace(marker, `${ROSTER_SCRIPT}${marker}`) : ROSTER_SCRIPT + html,
        'utf8',
      );
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
    });
    res.end(content);
  } catch (e) {
    res.writeHead(500);
    res.end('Internal Server Error');
  }
}

/**
 * Main request handler
 */
function handleRequest(req, res) {
  const method = req.method.toUpperCase();
  const urlPath = req.url.split('?')[0];

  // #588 — noindex on EVERY response, set here at the single choke point
  // rather than per-route. Deliberate: a route list has to be maintained and
  // a grep for '/api/...' undercounts the real routes, so any enumeration
  // ships a gap. Set once before routing and /api/*, static files, errors,
  // and every future route are covered by construction rather than by memory.
  //
  // This is the layer that survives robots.txt being served from the wrong
  // root or deleted later; it does NOT travel with copied HTML, which is what
  // the per-page <meta robots> is for. Three layers, three failure modes.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  // #249 — CSRF hardening. A mutating /api request must declare Content-Type:
  // application/json. That media type is NOT a CORS "simple" content-type, so
  // requiring it forces a preflight that a cross-origin page (no CORS here)
  // cannot satisfy — closing the drive-by "simple request" POST vector. Every
  // first-party writer (board, wiki, MCP, conversation-view) already
  // sends it. DELETE carries no body and is non-simple anyway, so it's exempt.
  if ((method === 'POST' || method === 'PATCH' || method === 'PUT') && urlPath.startsWith('/api/')) {
    const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') {
      return sendJSON(res, 415, { error: 'Content-Type must be application/json' });
    }
    // #250 — reject an over-cap body up front (cheap, by Content-Length) so we
    // never start buffering it. readBody is the streaming backstop for bodies
    // sent without a Content-Length (chunked).
    const cap = urlPath === '/api/attachments' ? MAX_ATTACHMENT_BODY_BYTES : MAX_BODY_BYTES;
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > cap) {
      req.resume(); // drain the incoming body so the 413 flushes cleanly
      return sendJSON(res, 413, { error: 'Request body too large' });
    }
  }

  // Granular API (#90) — regex router
  if (routeApi(method, urlPath, req, res)) return;

  // Legacy whole-board endpoints (still used by browser UI)
  if (urlPath === '/api/save' && method === 'POST') {
    return handleSave(req, res);
  }
  if (urlPath === '/api/load' && method === 'GET') {
    return handleLoad(req, res);
  }

  // Everything else: serve static files
  return serveStaticFile(req, res);
}

// #303-3 — one-time boot migration, run before we start serving so it goes
// through the store in-process (no mutex race with a live writer). Idempotent:
// it writes ONLY if it changed something, so a clean board isn't rewritten (and
// no needless backup/lastUpdated churn on every restart).
//   (a) Backfill missing shortIds — cards predating shortIds render as
//       `#undefined` and can't be #NNN-linked/deep-linked (#303).
//   (b) Normalize columns to {id,name,order} — drop any stray key (e.g. a
//       pre-#299 junk-key write) so the on-disk shape matches the contract.
const CANONICAL_COLUMN_KEYS = ['id', 'name', 'order'];
function migrateBoardIfNeeded() {
  let data;
  try {
    data = readBoard();
  } catch (e) {
    console.error(`boot migration skipped (board unreadable): ${e.message}`);
    return;
  }
  // #669 — the boot migration is the SECOND caller that cannot name its entities:
  // it runs outside any request, has no actor, and may rewrite every card and
  // column. Snapshot before mutating so its events can be derived. Consequence
  // worth expecting: the log's first entries after a boot may be a migration.
  const preMigration = JSON.parse(JSON.stringify({
    cards: data.cards, columns: data.columns, conversations: data.conversations,
  }));
  let changed = false;

  // (a) shortId backfill. Start the counter above the highest id in use AND the
  // stored nextShortId, so a backfilled id can never collide with an existing or
  // future one.
  const existingMax = data.cards.reduce(
    (m, c) => (typeof c.shortId === 'number' && c.shortId > m ? c.shortId : m),
    0,
  );
  let counter = Math.max(existingMax, (data.nextShortId || 1) - 1);
  let backfilled = 0;
  for (const card of data.cards) {
    if (typeof card.shortId !== 'number') {
      card.shortId = ++counter;
      backfilled++;
      changed = true;
    }
  }
  if (backfilled > 0) data.nextShortId = Math.max(data.nextShortId || 1, counter + 1);

  // (b) column key normalization.
  for (const col of data.columns) {
    for (const k of Object.keys(col)) {
      if (!CANONICAL_COLUMN_KEYS.includes(k)) { delete col[k]; changed = true; }
    }
  }

  if (changed) {
    const migEvents = deriveEvents(preMigration, data);
    if (migEvents.length) writeBoard(data, migEvents);
    console.log(`boot migration: backfilled ${backfilled} shortId(s), normalized columns`);
  }
}
/**
 * #805 — THE INTERNAL TENDING-WRITE SEAM.
 *
 * The one primitive through which tending entities reach disk. Deliberately NOT
 * a route, NOT an MCP tool, and NOT exported: a public surface whose only job is
 * to run a one-time migration is a permanent mutation endpoint bought to solve a
 * temporary problem, and it would still need a restart to load.
 *
 * Two callers, two DIFFERENT safety arguments, on purpose:
 *   #805 boot     safe because `listen()` has not been called — no request can
 *                 enter, so there is nothing to interleave with.
 *   #804 runtime  will call this INSIDE `withWriteLock`, which is what orders it
 *                 against concurrent mutations.
 *
 * ⚠️ Neither argument is "saveDomain is safe." It is not: atomic rename prevents
 * corruption, not lost updates, and stale-basis/CAS remains open under #466.
 *
 * Returns the number of entities written; 0 means the graph already matched and
 * NOTHING was written — no board save, no events, no `lastUpdated` churn.
 */
/**
 * #805 — read the provenance sidecar. Missing is a CASE; corrupt is an ERROR.
 *
 * ⛔ THE DISTINCTION IS THE WHOLE FUNCTION, and it is the one `readPool` gets
 * wrong (#809): that function swallows corrupt, missing, non-array and empty
 * alike into a silent default, so an operator with a trailing comma in their
 * config gets substituted content and no signal.
 *
 * Here a missing file returns null, which resolveProvenance is entitled to
 * handle — it refuses only if the pool contains prompts whose provenance we
 * know. But an UNPARSEABLE file throws, because "I could not read your
 * provenance" and "you have no provenance" are different facts, and collapsing
 * them is precisely how known authorship gets silently downgraded to unknown —
 * permanently, since the version it mints is immutable.
 */
function readTendingProvenance(
  file = process.env.SCRUM_TENDING_PROVENANCE_FILE || path.join(PROJECT_DIR, 'tending-provenance.json'),
) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;                    // absent: a case
    throw new Error(`tending provenance: cannot read ${file} — ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `tending provenance: ${file} is present but unparseable — ${e.message}. `
      + 'Refusing to treat a broken manifest as an absent one: that would mint the '
      + 'known prompts as authorless, and a prompt version cannot be rewritten.',
    );
  }
}

function writeTendingEntities(entities, { actor = null, op = 'update' } = {}) {
  if (!Array.isArray(entities) || entities.length === 0) return 0;
  const data = readBoard();
  const prior = new Map((data.tending || []).map((e) => [e['@id'], e]));

  // ⛔ CREATE-STAMPED, THEN FROZEN.
  //
  // `scrum:importedAt` answers "when did this node arrive in the graph" — a
  // fact about the RECORD, not about the world (contrast mintedAt/receivedAt,
  // which are facts about the world and are never touched here).
  //
  // The caller recomputes `new Date()` on every boot. If that value reached the
  // diff below, every restart would rewrite every node, and for the two
  // IMMUTABLE types it would trip the guard and fail the boot. So the stored
  // value WINS over the incoming one, always, for any @id that already exists.
  //
  // This lives here and not in the builder because the builder is pure and
  // cannot see what is already stored. This is the only seam that can — which
  // is what makes "stamped once" a property of the system rather than a
  // promise about how callers behave. (#805, at @minimo's requirement: the
  // migration time must answer from graph_query directly, not from a join
  // against a second API with an externally-supplied cutoff.)
  const CREATE_STAMPED = ['scrum:importedAt'];
  const stamped = entities.map((e) => {
    const was = prior.get(e['@id']);
    if (!was) return e;
    const keep = {};
    for (const k of CREATE_STAMPED) if (k in was) keep[k] = was[k];
    return Object.keys(keep).length ? { ...e, ...keep } : e;
  });

  const before = new Map([...prior].map(([id, e]) => [id, JSON.stringify(e)]));
  const changed = stamped.filter((e) => before.get(e['@id']) !== JSON.stringify(e));
  if (changed.length === 0) return 0;          // idempotent: second run is a no-op

  // ⛔ IMMUTABILITY, enforced rather than documented. A PromptVersion is
  // immutable by contract, so "upsert" must never mean "silently redefine". If
  // the same lineage/version @id arrives carrying different content, that is a
  // slug collision or a rewrite — either way a bug — and it fails loudly here
  // instead of replacing a node other entities already point at.
  const IMMUTABLE = new Set(['scrum:TendingPromptVersion', 'scrum:TendingPlaylistVersion']);
  for (const e of changed) {
    if (IMMUTABLE.has(e['@type']) && before.has(e['@id'])) {
      throw new Error(
        `#805: refusing to overwrite immutable ${e['@type']} ${e['@id']} with different content. `
        + 'A version is written once; a change is a NEW version.',
      );
    }
  }

  const merged = new Map(prior);
  for (const e of stamped) merged.set(e['@id'], e);
  data.tending = [...merged.values()];

  // Explicit tending events — NOT derived by diffing cards/columns/conversations.
  // Each names the entity it actually changed, so the log says what happened
  // rather than that something did.
  const events = changed.map((e) => ({
    op: before.has(e['@id']) ? op : 'create',
    entity: { kind: 'tending', id: e['@id'] },
    actor,
    state: e,
  }));
  writeBoard(data, events);
  return changed.length;
}

/**
 * #805 — bootstrap the live tending system into the graph, once, at boot.
 *
 * Runs BEFORE `listen()`. That ordering is the entire safety argument: the
 * migration cannot race a request because no request can arrive yet, and the
 * first request served therefore already sees the migrated graph. There is no
 * "up but not yet migrated" window to observe.
 *
 * Idempotent through `writeTendingEntities`: a second boot computes identical
 * @ids, finds no change, and writes nothing at all.
 */
function migrateTendingIfNeeded() {
  try {
    // ⛔ THERE IS NO EMPTY-POOL GUARD HERE, and its absence is a decision.
    //
    // A `if (!pool.length) return;` stood here and was UNREACHABLE. readPool()
    // is total: every failure path — explicit [], corrupt JSON, missing file,
    // non-array, array of empty strings — is swallowed by one catch that
    // returns [...DEFAULT_POOL]. Measured, all six inputs: length 3.
    //
    // It survived because the control guarding it asserted `playlists <= 1`,
    // which 0 and 1 both satisfy. Deleting the guard left all 7 tests green.
    // A dead branch under a bound that admits both answers is invisible twice.
    //
    // Removing it does not weaken anything: buildTendingEntities REFUSES an
    // empty prompts array with a tested throw, and the catch below turns that
    // into exit 1. So the impossible case now fails loudly through a path that
    // has coverage, instead of returning quietly through one that never ran.
    //
    // ⚠️ readPool's silent fallback is a REAL defect and is NOT mine to fix
    // here: an operator who corrupts whisper-pool.json gets the defaults with
    // no signal, and the tending system keeps sending. Filed separately.
    // ⛔ THE GRAPH IS AUTHORITATIVE FOR MIGRATED BOOTSTRAP STATE — and this
    // early return is what makes that true rather than aspirational.
    //
    // ⚠️ Read that scope exactly. It is a claim about BOOT, not about sending.
    // The runtime send path does NOT consult the graph: the hourly tick still
    // reads whisper-pool.json through readPool() (mcp-server.mjs → mintOnce →
    // whisper-store.mjs). Wiring the sender to the graph is #804's slice, not
    // this one. An earlier draft of this comment said only "authoritative once
    // migrated", which a reader scanning for "does the sender use the graph
    // yet?" could fairly have read as yes. (#809)
    //
    // Without it, every boot re-resolves the sidecar, so a sidecar that is
    // missing, renamed or rotated AFTER a successful migration would fail the
    // boot of a server whose graph is already complete and correct. The sidecar
    // is an input to a ONE-TIME import, not a runtime dependency, and a
    // migration that keeps needing its source has not finished.
    //
    // It also makes the whole thing genuinely one-shot: the idempotence below
    // (recompute, diff, write nothing) still holds, but it is no longer the
    // only thing standing between a rotated sidecar and a dead server.
    if ((readBoard().tending || []).length) return;

    // ⛔ ACTIVATION, NOT AUTHORISATION. Absence buys a NO-OP, never a mint.
    //
    // The first cut of this refused to boot whenever the pool held known
    // default prompts and no manifest covered them. That is correct for OUR
    // deployment and catastrophic everywhere else: readPool is total (#809), so
    // a stranger who clones manyhands and runs `node server.js` has the three
    // known defaults by fallback, no manifest, and got a dead server citing
    // provenance they have never had. Measured: 55 red in api.test.mjs, which
    // was the product's default configuration failing to start.
    //
    // The predicate "is this body a known default" is true for every install on
    // earth. The predicate that matters is "does THIS installation carry legacy
    // migration artifacts" — and when it does not, the answer is to do NOTHING,
    // not to invent an unknown-provenance mint.
    //
    // ⚠️ WHY NO-OP AND NOT explicit-unknown, which is the ruling's sharp edge:
    // an install that HAS a past but LOST its state file (partial restore, moved
    // workspace, hand-rebuilt prod) walks through this same door. Minting
    // explicit-unknown there would poison immutable nodes for exactly the
    // machine the rule most wants to protect. Writing nothing merely DEFERS the
    // migration — restore the state and sidecar and it activates correctly.
    // A deferral is recoverable; an immutable mint is not.
    const hasHistory = recentWhispers().length > 0;
    const hasPoolFile = fs.existsSync(poolFilePath());
    const manifest = readTendingProvenance();

    if (!hasHistory && !hasPoolFile && !manifest) {
      // Observable, and deliberately NOT a claim about any prompt's provenance —
      // it describes the INSTALLATION, so it goes to the log and nowhere near
      // the graph.
      console.log('boot migration (#805) no-op — fresh-install: no legacy migration artifacts');
      return;
    }

    // Past this line the installation has at least one legacy artifact, so this
    // is an intentional migration. Known defaults still require their manifest;
    // genuinely custom prompts may record explicit unknown provenance.
    const pool = readPool();

    // ⚠️ IDENTITY COMES FROM THE MANIFEST NOW, NOT FROM THE BODY.
    //
    // This call site used to be `pool.map((body) => ({ slug: promptSlugFor(body), body }))`
    // — hashing the text for identity and passing NO provenance at all, while
    // the bootstrap supported author, influencedBy, evidencedBy and a note, and
    // the board carried the evidence for all of them. Two defects, one fix:
    //
    //   3  provenance we HELD was discarded at the last step before the graph
    //   4  hash identity collapsed identical texts into one lineage, and made a
    //      REWORD start a new one instead of a new version
    //
    // resolveProvenance assigns identity explicitly (lineage + occurrence) and
    // demotes the hash to verification: it now only answers "is this still the
    // text the provenance was written about?", which is the one question a
    // content hash is actually good at.
    //
    // ⚠️⚠️ It resolves the WHOLE pool or throws. Not per-prompt, because a
    // prompt version is IMMUTABLE: minting three good ones and then failing on
    // the fourth leaves the fourth permanently wrong and unfixable, and the next
    // boot carrying the correction exits 1 rather than serving. Measured on two
    // real boots before this was written. All-or-nothing is not tidiness here —
    // it is the only ordering where a failure is still recoverable.
    const entities = buildTendingEntities({
      prompts: resolveProvenance({
        pool,
        manifest,
        // The prompts we KNOW the provenance of. If one of these is in the pool
        // and the manifest does not cover it, resolveProvenance refuses rather
        // than minting it authorless — the silent downgrade that cannot be undone.
        knownDefaults: [...DEFAULT_POOL],
      }),
      config: readTendingConfig(),
      // ⚠️ readWhisperState() returns the SETTLEMENT fields only and carries no
      // history. Passing it here would have imported zero legacy grants and
      // reported success. recentWhispers() is the accessor that reads history.
      state: { history: recentWhispers() },
      importedAt: new Date().toISOString(),
    });
    const n = writeTendingEntities(entities, { actor: 'board', op: 'update' });
    if (n) console.log(`boot migration (#805): ${n} tending entit${n === 1 ? 'y' : 'ies'} written to the graph`);
  } catch (e) {
    // ⛔ FAIL THE BOOT. Do not serve.
    //
    // A first cut logged and continued to listen(). That is worse than the
    // crash it avoids: the locked condition for this migration is that the
    // FIRST request already sees the tending graph, and a server that starts
    // after a failed migration serves a board silently missing it — with a
    // reassuring line in a log nobody reads at boot.
    //
    // The board itself is untouched either way: writeBoard is reached once, at
    // the end, after every entity is built, so a throw above it writes neither
    // data nor events. What changes here is that the OPERATOR finds out.
    console.error(`boot migration (#805) FAILED — refusing to serve: ${e?.message ?? e}`);
    console.error('The board on disk is unchanged. Fix the migration or revert the deploy;');
    console.error('a server that starts here would answer queries about a system it never migrated.');
    process.exit(1);
  }
}

migrateBoardIfNeeded();
migrateTendingIfNeeded();

// ── Start Server ──
const server = http.createServer(handleRequest);

server.listen(PORT, '127.0.0.1', () => {
  // #683 — drop every served-but-unacked range at boot. NOT tidiness: the fence
  // discriminates on the registry epoch, and seat-registry keeps its counter in
  // a closure with no persistence, so epochs restart at 1 with the process
  // (measured across three restarts: 3,4 → 5,6 → 1,2 — backwards). A fence that
  // survived a restart could be satisfied by coincidence. The DURABLE cursor is
  // untouched; the cost is at most a re-serve, which the contract permits.
  try {
    const dropped = discardPendingServes(EVENT_LOG_DIR);
    if (dropped) console.log(`   [#683] discarded ${dropped} pending serve(s) — epochs do not survive a restart`);
  } catch (e) {
    console.error('[#683] could not clear pending serves:', e.message);
  }
  console.log(`manyhands server running at http://localhost:${PORT}`);
  console.log(`   Static files served from: ${PROJECT_DIR}`);
  console.log(`   Granular API: /api/{board,cards,columns}  (#90)`);
  console.log(`   Legacy API:   POST /api/save  |  GET /api/load  (browser UI)`);
  console.log(`   Board data file: ${BOARD_DATA_FILE}`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Kill the existing process or change PORT.`);
    process.exit(1);
  } else {
    throw e;
  }
});
