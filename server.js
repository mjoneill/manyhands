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
import { boardToDomain, domainToBoard, cardToNode } from './core/mapping.mjs';
import { buildTree, buildChildIndex } from './core/tree.mjs';
import { buildLinkIndex } from './core/links.mjs';
import { readConfig, writeConfig } from './channel-config.mjs';
import { loadRoster, writeRoster, rosterFilePath } from './core/roster-config.mjs';
import { configureIdentities, usingDefaultRoster } from './core/identity.mjs';

const PORT = process.env.SCRUM_PORT ? parseInt(process.env.SCRUM_PORT, 10) : 3141;
const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BOARD_DATA_FILE = process.env.SCRUM_BOARD_FILE || path.join(PROJECT_DIR, 'board-data.json');
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

    writeBoard(merged);

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
function writeBoard(data) {
  data.lastUpdated = new Date().toISOString();
  data._README = BOARD_README;
  saveDomain(BOARD_DATA_FILE, boardToDomain(data), { now: data.lastUpdated });
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
    relationships: normalizeRelationships(body.relationships),
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
function syncInverseRelationships(data, card, before, after) {
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
      }
    }
    for (const sid of prev) {
      if (next.has(sid)) continue;
      const target = data.cards.find((c) => c.shortId === sid);
      if (!target || !target.relationships || !Array.isArray(target.relationships[invType])) continue;
      target.relationships[invType] = target.relationships[invType].filter((x) => x !== card.shortId);
    }
  }
}

// Fields that PATCH must NOT change (preserve identity / history)
const IMMUTABLE_CARD_FIELDS = new Set(['id', 'shortId', 'createdAt']);

// #249 — id/type/priority/assignees are rendered into HTML attributes by the
// board client and are the trust boundary between agents. Constrain them at the
// API (defense in depth alongside the client-side escaping): an out-of-shape
// value must never be stored, whichever writer sent it.
const CARD_TYPES = new Set(['task', 'idea', 'goal', 'reference', 'feature']);
const CARD_PRIORITIES = new Set(['p0', 'p1', 'p2', 'p3']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSIGNEE_KEY_RE = /^[A-Za-z0-9_-]+$/;

// Returns an error string if any security-sensitive field is malformed, else
// null. Presence-conditional — a field absent from the payload keeps its default.
function validateCardFields(body, { checkId = true } = {}) {
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
]);

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
function handleListCards(req, res) {
  try {
    const data = readBoard();
    sendJSON(res, 200, data.cards);
  } catch (e) {
    console.error('GET /api/cards:', e.message);
    sendJSON(res, 500, { error: 'Failed to list cards' });
  }
}

function handleGetCard(req, res, idOrShortId) {
  try {
    const data = readBoard();
    const idx = findCardIndex(data, idOrShortId);
    if (idx < 0) return sendJSON(res, 404, { error: 'Card not found' });
    sendJSON(res, 200, data.cards[idx]);
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
    const verr = validateCardFields(body);
    if (verr) return sendJSON(res, 400, { error: verr });
    const created = await withWriteLock(async () => {
      const data = readBoard();
      const card = createCardFromPayload(body, data.nextShortId);
      data.cards.push(card);
      data.nextShortId = (data.nextShortId || 1) + 1;
      syncInverseRelationships(data, card, null, card.relationships); // #614
      writeBoard(data);
      return card;
    });
    sendJSON(res, 201, created);
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
    const updated = await withWriteLock(async () => {
      const data = readBoard();
      const idx = findCardIndex(data, idOrShortId);
      if (idx < 0) return null;
      const card = data.cards[idx];
      for (const [k, v] of Object.entries(patch)) {
        if (IMMUTABLE_CARD_FIELDS.has(k)) continue;
        if (!PATCHABLE_CARD_FIELDS.has(k)) continue; // #249 — ignore unknown keys
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
          syncInverseRelationships(data, card, before, merged);
          card.relationships = merged;
          continue;
        }
        card[k] = v;
      }
      card.updatedAt = new Date().toISOString();
      writeBoard(data);
      return card;
    });
    if (!updated) return sendJSON(res, 404, { error: 'Card not found' });
    sendJSON(res, 200, updated);
  } catch (e) {
    console.error('PATCH /api/cards/:id:', e.message);
    sendJSON(res, 500, { error: 'Failed to update card' });
  }
}

async function handleDeleteCard(req, res, idOrShortId) {
  try {
    const found = await withWriteLock(async () => {
      const data = readBoard();
      const idx = findCardIndex(data, idOrShortId);
      if (idx < 0) return false;
      data.cards.splice(idx, 1);
      writeBoard(data);
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
        writeBoard(data);
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
      writeBoard(data);
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
      writeBoard(data);
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
      writeBoard(data);
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
      for (const card of data.cards) {
        if (card.column === removed.id) { card.column = fallback; moved++; }
      }
      writeBoard(data);
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

// Extract @mentions from a conversation body — lowercased, de-duplicated.
// Light parser (#110): @(\w+) is good enough for the agent handles we use.
function extractMentions(text) {
  if (typeof text !== 'string') return [];
  const found = new Set();
  for (const m of text.matchAll(/@(\w+)/g)) {
    found.add(m[1].toLowerCase());
  }
  return [...found];
}

function createConversationFromPayload(body) {
  const now = new Date().toISOString();
  const text = (typeof body.body === 'string') ? body.body : '';
  return {
    id: crypto.randomUUID(),
    body: text,
    author: (typeof body.author === 'string' && body.author.length > 0) ? body.author : 'unassigned',
    attachedTo: (typeof body.attachedTo === 'string' && body.attachedTo.length > 0) ? body.attachedTo : null,
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

function handleListConversations(req, res) {
  try {
    const data = readBoard();
    const q = parseQuery(req.url);
    let convs = data.conversations;
    if (typeof q.attachedTo === 'string') {
      // Allow "null" string to filter to board-level conversations
      if (q.attachedTo === 'null') convs = convs.filter(c => c.attachedTo === null);
      else convs = convs.filter(c => c.attachedTo === q.attachedTo);
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
      writeBoard(data);
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
      const card = createCardFromPayload(
        { title: body.title, description: body.body || '', type: body.type || 'reference' },
        data.nextShortId,
      );
      if (typeof body.parent === 'string') card.parent = body.parent;
      if (body.attachments !== undefined) card.attachments = sanitizeAttachments(body.attachments); // #222
      data.cards.push(card);
      data.nextShortId = (data.nextShortId || 1) + 1;
      appendWikiNotice(data, 'created', card); // #223
      writeBoard(data);
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

// Edit a node — title / body / parent (parent: null clears it → becomes a root).
async function handleUpdateNode(req, res, idOrShortId) {
  try {
    const patch = JSON.parse(await readBody(req));
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
      if (contentChanged) appendWikiNotice(data, 'updated', card); // #223
      writeBoard(data);
      return card;
    });
    if (!updated) return sendJSON(res, 404, { error: 'Node not found' });
    if (cycle) return sendJSON(res, 409, { error: 'That move would make the page a descendant of itself.' });
    sendJSON(res, 200, cardToNode(updated));
  } catch (e) {
    console.error('PATCH /api/nodes/:id:', e.message);
    sendJSON(res, 500, { error: 'Failed to update node' });
  }
}

// ── Router: regex-based match against API_ROUTES ──
const API_ROUTES = [
  { method: 'GET',    re: /^\/api\/board$/,                fn: (req, res) => handleGetBoard(req, res) },
  { method: 'GET',    re: /^\/api\/roster$/,               fn: (req, res) => handleGetRoster(req, res) },
  { method: 'GET',    re: /^\/api\/config$/,               fn: (req, res) => handleGetConfig(req, res) },
  { method: 'GET',    re: /^\/api\/channel-status$/,       fn: (req, res) => handleChannelStatus(req, res) },
  { method: 'POST',   re: /^\/api\/config$/,               fn: (req, res) => handleSetConfig(req, res) },
  { method: 'POST',   re: /^\/api\/roster$/,               fn: (req, res) => handleSetRoster(req, res) },   // #506
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
    sendJSON(res, 200, readBoard());
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
    writeBoard(data);
    console.log(`boot migration: backfilled ${backfilled} shortId(s), normalized columns`);
  }
}
migrateBoardIfNeeded();

// ── Start Server ──
const server = http.createServer(handleRequest);

server.listen(PORT, '127.0.0.1', () => {
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
