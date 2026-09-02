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
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadDomain, saveDomain } from './core/store.mjs';
import { cardContentKey } from './core/card-content-key.mjs';
import { applyApexLabels, APEX_PREFIX, descendantIds as apexDescendantIds } from './core/apex-labels.mjs';
import { inFlight } from './core/in-flight.mjs';
import { appendEvent } from './core/event-log.mjs';
// #805 — the boot migration's inputs (the live flat sources) and its builder.
import { readPool, recentWhispers, DEFAULT_POOL, poolFilePath } from './whisper-store.mjs';
import { readTendingConfig, writeTendingConfig } from './tending-config.mjs';
import { buildTendingEntities } from './core/tending-bootstrap.mjs';
import { resolveProvenance } from './core/tending-provenance.mjs';
import { boardToDomain, domainToBoard, cardToNode } from './core/mapping.mjs';
import { verifyShaIntegrity } from './core/sha-integrity.mjs';
import { buildTree, buildChildIndex } from './core/tree.mjs';
import { buildLinkIndex } from './core/links.mjs';
import { commentMetadata } from './core/card-comments.mjs';
import { validateDeclaration, seatState, tendingEligibility, UNKNOWN as SEAT_UNKNOWN } from './core/seat-state.mjs';
import { readConfig, writeConfig, LIMITS } from './channel-config.mjs';
import { loadRoster, writeRoster, rosterFilePath } from './core/roster-config.mjs';
import { extractMentions as extractMentionsFromRoster } from './core/people.mjs';
// #868 — the graph modules are imported LAZILY, at the bottom of this file's
// graph section, and deliberately NOT here. They reach `oxigraph`, an npm
// dependency, and a static import of it made `node server.js` on a fresh clone
// die with ERR_MODULE_NOT_FOUND before anything listened — under a README
// heading that says "no install step". The board does not need a SPARQL replica
// in order to serve a board, so boot must not require one.
import { domainToJsonLd } from './core/jsonld.mjs';
import { deriveGraph, personByKey } from './core/people.mjs';
import { queryCards, facetCards } from './core/cards-query.mjs';
import { similarCards } from './core/similar-cards.mjs';
import { queryChangesFromLog } from './core/changes-log-query.mjs';
import { readEvents, oldestRetainedAt, seqAsOf, seqOfEntityEvent } from './core/event-log.mjs';
// #683 — the deafness cure's server half. REST owns the event log, so it owns
// the cursors that index it; mcp-server asks over HTTP rather than learning a
// path it has no business knowing (#767).
import {
  deliveryIdentity, registerFor, serveFor, noteInbound, reachabilityReport, markServed,
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

    // #1039 — AN OMITTED KEY MEANS "NO OPINION", NEVER "DELETE".
    //
    // The loop below takes the cards array WHOLESALE, and #230's guard above
    // compares IDs. So a client that sends every id but omits a FIELD passes
    // both: nothing disappears, the guard stays silent, and the field is
    // erased on every card. #209 proposes exactly such a client — hydrating
    // the board list from a lightweight projection instead of pulling 7.1 MB
    // of descriptions on every load — and without this it would blank all 931
    // card bodies on its first save.
    //
    // Measured 2026-08-24: /api/load emits 28 per-card keys, /api/cards emits
    // 26; the two it drops are `description` (931 cards) and a legacy
    // `assignee` (2). The rule is general rather than description-only so the
    // projection can change shape later without re-opening this hazard.
    //
    // ⚠️ The distinction is already in the wire format, and JSON is what makes
    // it reliable: JSON.parse never yields an `undefined` VALUE, only an
    // ABSENT key. So spread order alone expresses the whole rule —
    //     absent      ⇒ falls through to the stored value   (a projection)
    //     "" / [] /   ⇒ overrides                           (a real clear;
    //     null / "x"                                         index.html:2717
    //                                                        sends "" for an
    //                                                        emptied box)
    // A card with no stored counterpart is new and passes through untouched.
    // `version` rides along and is then recomputed server-side below (#534).
    const storedById = new Map(
      (existing.cards || []).filter((c) => c && c.id).map((c) => [c.id, c]),
    );
    // #466 — what the client DECLARED it had, captured BEFORE carryForward fills
    // an absent `version` in from the store (which would make "never had the
    // token" indistinguishable from "current"). Compared below, never accepted.
    const declaredVersion = new Map(
      incoming.cards.filter((c) => c && c.id).map((c) => [c.id, c.version]),
    );
    const carryForward = (incomingCards) => incomingCards.map((c) => (
      c && c.id && storedById.has(c.id) ? { ...storedById.get(c.id), ...c } : c
    ));

    const merged = { ...existing };
    for (const k of ['cards', 'columns', 'nextShortId', 'lastUpdated']) {
      if (incoming[k] === undefined) continue;
      merged[k] = k === 'cards' ? carryForward(incoming[k]) : incoming[k];
    }

    // #534 — THE VERSION IS SERVER-COMPUTED HERE, NEVER ACCEPTED.
    //
    // The loop above takes the cards array WHOLESALE, so every per-card field
    // arrives from the client. For content that is the contract. For the
    // concurrency token it is fatal: a client that carries an old version
    // writes it back, and a client that never had the field erases it. Either
    // way the version moves BACKWARD, and a precondition built on a token that
    // can regress passes in exactly the case it exists to catch:
    //
    //   1 card at v5  2 browser hydrates at v5  3 a seat PATCHes ⇒ v6
    //   4 browser saves ⇒ v5 again  5 a writer holding v5 is told it is current
    //
    // So the server keeps its own value and advances it only when the incoming
    // card genuinely differs. Bumping a card the client did not touch is NOT
    // harmless — it would fail a legitimate holder's ifVersion, and a
    // precondition that over-refuses breaks working writers, which is the worse
    // of the two failures.
    //
    // ⚠️ This is the first per-card value /api/save COMPUTES rather than
    // ACCEPTS. That is deliberate and it is a step toward #118's whole point;
    // if #118 later deletes this endpoint, this block goes with it and nothing
    // is stranded.
    //
    // #466 — AND IT IS COMPARED. The client's declared version is the one
    // token that can tell a stale tab from a current one, and until this
    // block it was discarded on arrival: a tab that loaded a card at v1 and
    // saved after a seat PATCHed it to v2 got a 200 and put v1's content
    // back. The rule, with its edges pinned in tests/save-stale-refused.test.mjs:
    //
    //   REFUSE iff  the server holds an integer version for the card
    //           AND the client's declared version ≠ it (absent counts as ≠ —
    //               a client that cannot prove currency does not get to revert)
    //           AND the content differs (a stale NUMBER with identical content
    //               is not a revert; refusing it would be refusing a number)
    //
    // A card with no server-side version cannot be compared and passes as
    // before — vacuous on the unversioned share of the board (715 of 988 on
    // 2026-08-30), closing as cards get written. And a refusal writes NOTHING:
    // the save is one document, so "everything but the stale card" would be a
    // partial apply nobody asked for.
    const staleCards = [];
    if (Array.isArray(merged.cards)) {
      const priorById = new Map(
        (existing.cards || []).filter((c) => c && c.id).map((c) => [c.id, c]),
      );
      merged.cards = merged.cards.map((incomingCard) => {
        if (!incomingCard || !incomingCard.id) return incomingCard;
        const prior = priorById.get(incomingCard.id);
        if (!prior) {
          // A card this save INTRODUCES. It has no server history, so it is
          // born at 1 exactly as handleCreateCard mints it.
          return { ...incomingCard, version: 1 };
        }
        const differs = cardContentKey(prior) !== cardContentKey(incomingCard);
        if (differs && Number.isInteger(prior.version)) {
          const declared = declaredVersion.get(incomingCard.id);
          if (declared !== prior.version) {
            staleCards.push({
              id: incomingCard.id,
              shortId: prior.shortId ?? null,
              yourVersion: Number.isInteger(declared) ? declared : null,
              currentVersion: prior.version,
            });
          }
        }
        const settled = { ...incomingCard, version: prior.version };
        if (differs) bumpCardVersion(settled);
        else if (!Number.isInteger(settled.version)) bumpCardVersion(settled);
        return settled;
      });
    }
    if (staleCards.length) {
      const which = staleCards.slice(0, 10)
        .map((s) => `#${s.shortId ?? '?'} v${s.yourVersion ?? '—'}→v${s.currentVersion}`).join(', ');
      return sendJSON(res, 409, {
        error: `Refused: ${staleCards.length} card(s) changed on the server since this board was loaded `
          + `(${which}). Saving would silently revert those changes. `
          + 'Reload the page to resync, then reapply your edit.',
        staleCards,
      });
    }

    // #669 — the browser's whole-board save cannot say what it changed, so its
    // events are derived. A save that changed nothing writes nothing: there is no
    // event to record, and writeBoard refuses an empty list by design rather than
    // letting a no-op mint a meaningless entry in the log.
    const saveEvents = deriveEvents(existing, merged);
    if (saveEvents.length) writeBoard(merged, saveEvents);

    // #466 — hand the settled versions back. The tab's copies are now BEHIND
    // the server on every card this save changed; without this, the user's
    // very next edit of the same card would be refused as stale (declared ≠
    // current, content differs) by the comparison above. The client applies
    // these by id and re-baselines.
    const versions = Array.isArray(merged.cards)
      ? merged.cards.filter((c) => c && c.id).map((c) => ({ id: c.id, version: c.version }))
      : [];
    sendJSON(res, 200, { ok: true, cards: merged.cards.length, lastUpdated: merged.lastUpdated, versions });
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
// #651 — a memory write is an event like any other. Emitted for the IDENTITY,
// which is the entity whose id is stable across versions; the version entities
// ride in its state, so replay reconstructs both halves from one record.
const memoryEvent = (op, identity, actor = null) => ({
  op, actor, entity: { kind: 'memory', id: identity['@id'] }, state: identity,
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
  _graphGeneration++;   // #931 — and SAYS SO, so a sync in flight cannot clear it
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
// #949 — the seq the DOCUMENT half of the replica was projected from, derived
// from the snapshot's own `lastUpdated`. null means cold: never synced, so the
// replica cannot claim any position at all. ⛔ Deliberately NOT `_activitySeq`:
// events are read after an awaited, yielding projection, so that cursor can be
// newer than the bytes actually in the store.
let _graphProjectedThrough = null;
// #931 — HOW MANY WRITES HAVE HAPPENED. Monotonic, bumped beside every
// `_graphDirty = true`. The sync compares it before and after: if a write
// landed while the projection was yielding, the generation moved and the flag
// must NOT be cleared, because that write is not in the store.
let _graphGeneration = 0;
// #1112 item 3 — one warning per boot when the ledger cannot be projected here.
let _workStoreWarned = false;
const GRAPH_QUERY_LOG = path.join(path.dirname(BOARD_DATA_FILE), 'graph-query-log.jsonl');
// ── #1086 item 13 — QUERY → CARD retrieval, as a feature ──────────────────────
// The embedder is CONFIGURED, never assumed: an unset URL/model answers
// {available:false, reason} — this week's silent-zero theme must not arrive in
// a new surface. Ollama's /api/embed shape: POST {model, input:[…]} ⇒ {embeddings}.
// The index and the verbatim query log live BESIDE the board data (both are
// board content — .gitignored in the same commit that creates them).
const SEARCH_EMBED_URL = process.env.SEARCH_EMBED_URL || '';
const SEARCH_EMBED_MODEL = process.env.SEARCH_EMBED_MODEL || '';
const SEARCH_INDEX_FILE = path.join(path.dirname(BOARD_DATA_FILE), 'search-index.jsonl');
const SEARCH_LOG_FILE = path.join(path.dirname(BOARD_DATA_FILE), 'search-log.jsonl');
const numEnv = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) ? v : dflt; };
const SEARCH_ABSTAIN_BELOW = numEnv('SEARCH_ABSTAIN_BELOW', 0.5);
const SEARCH_ASK_WITHIN = numEnv('SEARCH_ASK_WITHIN', 0.03);
const SEARCH_MAX_EMBED = Math.max(1, Math.floor(numEnv('SEARCH_MAX_EMBED', 50)));
const SEARCH_MAX_EMBED_CHARS = Math.max(1, Math.floor(numEnv('SEARCH_MAX_EMBED_CHARS', 60000)));
// Below undici's own 300 s so the failure is NAMED here rather than surfacing as "fetch failed".
const SEARCH_EMBED_TIMEOUT_MS = Math.max(1, Math.floor(numEnv('SEARCH_EMBED_TIMEOUT_MS', 240000)));
let _searchModule = null;
async function loadSearchModule() {
  if (!_searchModule) _searchModule = await import('./core/semantic-search.mjs');
  return _searchModule;
}
async function embedTexts(texts) {
  let r;
  try {
    r = await fetch(SEARCH_EMBED_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // truncate:true is Ollama's default, said out loud: an over-context input
      // is embedded from its head, never refused.
      body: JSON.stringify({ model: SEARCH_EMBED_MODEL, input: texts, truncate: true }),
      signal: AbortSignal.timeout(SEARCH_EMBED_TIMEOUT_MS),
    });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error(`embedder timed out after ${SEARCH_EMBED_TIMEOUT_MS} ms on a batch of ${texts.length} text(s), ${texts.reduce((n, t) => n + t.length, 0)} chars`);
    }
    throw e;
  }
  if (!r.ok) throw new Error(`embedder answered ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j.embeddings) || j.embeddings.length !== texts.length) throw new Error('embedder returned the wrong number of vectors');
  return j.embeddings;
}

// #898 — a graph call at or above this wall time records the process's state
// beside its numbers. 2s is well above any warm query and well below the two
// unexplained rows; overridable so a test can exercise the record's shape.
const GRAPH_SLOW_MS = (() => {
  const v = Number(process.env.GRAPH_SLOW_MS);
  return Number.isFinite(v) && v >= 0 ? v : 2000;
})();
function processContextForSlowQuery(eluStart) {
  const mem = process.memoryUsage();
  const elu = performance.eventLoopUtilization(eluStart);
  return {
    loadavg1: Math.round(os.loadavg()[0] * 100) / 100,
    rssMb: Math.round(mem.rss / 1048576),
    heapUsedMb: Math.round(mem.heapUsed / 1048576),
    eventLoopUtilization: Math.round((Number.isFinite(elu.utilization) ? elu.utilization : 0) * 1000) / 1000,
    uptimeS: Math.round(process.uptime()),
  };
}

/**
 * Warm (or incrementally sync) the replica and return it. Shared by every
 * graph-derived read — /api/graph and /api/ready see the SAME store, so a
 * ready verdict and a hand-run SPARQL check can never disagree about which
 * world they measured.
 */
/**
 * #868 — load the graph modules on FIRST USE, not at boot.
 *
 * `core/graph-replica.mjs` imports `oxigraph`, and `core/ready-query.mjs`
 * imports graph-replica — so a static import of either put an npm dependency on
 * the boot path. Deferring both keeps `node server.js` working on a clone with
 * no `node_modules`, which is what the README promises and what a stranger
 * actually does first.
 *
 * ⚠️ The failure is REPORTED, not swallowed. If the dependency is genuinely
 * absent, the graph endpoints must say so in a way a caller can act on — a
 * board that silently returns an empty result set for every query would be a
 * worse defect than the crash this replaces.
 */
let _graphModules = null;
async function loadGraphModules() {
  if (_graphModules) return _graphModules;
  try {
    const [replica, ready] = await Promise.all([
      import('./core/graph-replica.mjs'),
      import('./core/ready-query.mjs'),
    ]);
    _graphModules = { ...replica, ...ready };
    return _graphModules;
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') {
      throw Object.assign(
        new Error(
          'The graph endpoints need the optional `oxigraph` dependency, which is not '
          + 'installed. Run `npm install` to enable /api/graph and /api/ready. The rest '
          + 'of the board works without it.',
        ),
        { code: 'GRAPH_DEPS_MISSING' },
      );
    }
    throw e;
  }
}

/**
 * #725 part 2 — the highest seq already projected as an activity.
 *
 * ⛔ WHY THIS COUNTER EXISTS RATHER THAN RE-READING THE LOG EVERY SYNC.
 * `projectActivities` is idempotent by `seq`, so correctness does not need this.
 * COST does: the log is append-only and unbounded (1,624 events over the first
 * four days), and re-reading all of it on every write to discover one new record
 * makes the replica's incremental sync — the whole point of #714 — pointless for
 * activities. We read forward from where we stopped.
 *
 * ⚠️ Reset to 0 whenever the store is rebuilt from empty, because the store and
 * this counter describe the same world and must be discarded together. A stale
 * counter against a fresh store is how the graph would silently lose all history
 * before the last write.
 */
let _activitySeq = 0;

async function warmGraphStore() {
  const { buildGraphStore, syncGraphStoreChunked, projectActivities, projectLabelAliases, projectWorkLedger } = await loadGraphModules();
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
    // #931 — THE GENERATION AT WHICH THIS PROJECTION BEGAN, captured before the
    // document is read. Everything below describes the board as of this moment;
    // if `_graphGeneration` has moved by the time we finish, it does not.
    const genAtStart = _graphGeneration;
    if (!_graphStore) { _graphStore = buildGraphStore({ '@graph': [] }); _activitySeq = 0; }
    // #949 — the document and its stamp are read as ONE act. `writeBoard`
    // stamps the board and its events with the same instant, so this snapshot's
    // `lastUpdated` maps exactly onto a position in the event log. Capturing it
    // here, beside the read, is the point: a stamp fetched later would describe
    // a different file than the one we are about to project.
    const domain = loadDomain(BOARD_DATA_FILE);
    const docStamp = typeof domain?.lastUpdated === 'string' ? domain.lastUpdated : null;
    const doc = domainToJsonLd(domain);
    // #884 — CHUNKED, so the projection yields to the event loop between batches.
    //
    // ⛔ Measured in production: a cold projection re-projects the whole store
    // and `oxigraph.store.add` is synchronous, so a boot blocked the server for
    // 13–29 SECONDS — /api/graph, /api/cards and the browser alike. The room
    // booted 85 times in one day. "The board is down" meant "someone restarted it."
    //
    // ⭐ This does the SAME total work and is marginally slower. The property is
    // that other requests get a turn, not that the sync is fast: a faster
    // projection that still blocks is the same outage, shorter.
    const stats = await syncGraphStoreChunked(_graphStore, doc, _graphHashes);
    _graphHashes = stats.hashes;

    // #857 §IV — declared label synonyms.
    //
    // ⛔ THE #725 DEFECT, COMMITTED AGAIN BY ME, HOURS AFTER NAMING IT.
    // `projectLabelAliases` was called from `buildGraphStore` only — the COLD
    // path. Every warm sync after a write skipped it, so a synonym declared at
    // runtime never reached the graph while its unit tests stayed green.
    // A projection wired to one of two paths is a projection that works exactly
    // until someone uses it.
    //
    // ⚠️ Idempotent by triple (set semantics) and rebuilt from ONE authority —
    // the declared rows — so re-projecting on every sync cannot drift.
    projectLabelAliases(_graphStore, doc._labelAliases);

    // #725 part 2 — THE EVENT LOG IS PART OF THE GRAPH, and until now it was not.
    //
    // The board has written structured PROV-shaped events for every mutation
    // since 2026-08-04, `projectActivities()` has existed and been unit-tested
    // since #725 landed, and the two had never been introduced: the function's
    // only callers were its own tests. So "who did what, and when" — the record
    // this room's whole coordination protocol produces — was invisible to every
    // query, while a green test suite reported the feature working.
    //
    // ⚠️ Failure here must NOT take the query surface with it. The document half
    // of the replica is already synced and correct at this point; an unreadable
    // or corrupt event log should cost the caller their ACTIVITIES, loudly, not
    // their ability to traverse the board. The log is append-only and carries
    // real junk by design — `projectActivities` already skips malformed records
    // rather than throwing, and this guard covers the read itself.
    let activities = 0;
    try {
      const fresh = readEvents(EVENT_LOG_DIR, { sinceSeq: _activitySeq });
      if (fresh.length) {
        projectActivities(_graphStore, fresh);
        _activitySeq = fresh.reduce((m, e) => (e?.seq > m ? e.seq : m), _activitySeq);
        activities = fresh.length;
      }
    } catch (e) {
      // Named, not swallowed: a silent zero here is indistinguishable from a
      // board where nothing has happened, which is the exact confusion #725 exists
      // to remove.
      console.error(`${new Date().toISOString()} graph-replica: ACTIVITIES NOT PROJECTED (${e?.message}) — traversal is unaffected, but prov:Activity is incomplete past seq ${_activitySeq}`);
    }

    // #1112 item 3 — the WORK LEDGER is part of the graph (Decision 3956b66b).
    // Same wiring lesson as the block above: projectWorkLedger existed for zero
    // minutes before this call site, on purpose. The store is small (53 rows on
    // 2026-08-30) and the projection is idempotent by (id, seq), so it re-runs
    // whole on every sync — no cursor to hold. An UNSET env is a named absence,
    // once per boot, not a silent zero: this server historically did not carry
    // SCRUM_WORK_STORE (only the MCP process did), and a deploy that forgets
    // the plist line must be discoverable from the log.
    try {
      const workDir = process.env.SCRUM_WORK_STORE;
      if (workDir) {
        const { readWorkObjectRows } = await import('./core/work-store.mjs');
        projectWorkLedger(_graphStore, readWorkObjectRows(workDir));
      } else if (!_workStoreWarned) {
        _workStoreWarned = true;
        console.error(`${new Date().toISOString()} graph-replica: WORK LEDGER NOT PROJECTED — SCRUM_WORK_STORE is unset on this process, so schema:Action answers zero for a protocol that has rows elsewhere`);
      }
    } catch (e) {
      console.error(`${new Date().toISOString()} graph-replica: WORK LEDGER NOT PROJECTED (${e?.message}) — traversal is unaffected, but schema:Action is incomplete`);
    }

    // #949 — recorded from the stamp of the bytes we actually projected, NOT
    // from the log's head at this instant. If a write landed during the awaited
    // sync above (#931's window), that write is not in this store and its seq is
    // not in this number — so the pair reports a gap instead of a false green.
    _graphProjectedThrough = docStamp ? seqAsOf(EVENT_LOG_DIR, docStamp) : null;

    // ⛔ #931 — THE RACE, AND WHY THIS IS A COMPARISON RATHER THAN AN ASSIGNMENT.
    //
    // `syncGraphStoreChunked` is AWAITED and yields to the event loop between
    // batches (#884, which fixed a 13–29s outage and opened this window). So a
    // write can land between the snapshot above and this line: it sets
    // `_graphDirty = true`, and an unconditional `= false` here CLOBBERS that —
    // the write is not in the store, nothing knows to re-sync, and the replica
    // serves a confident wrong answer until something unrelated re-dirties it.
    // Measured once: four minutes, against #857's own acceptance query, found by
    // accident.
    //
    // ⚠️ NOT the literal "clear the flag before the snapshot" this card proposed.
    // That closes the same window but breaks retry-on-failure: with the flag
    // already clear, a sync that THROWS leaves a partial projection that nothing
    // re-tries. The generation compare closes the window AND keeps a failed sync
    // dirty, because it only ever clears a flag it can prove is still ours.
    if (_graphGeneration === genAtStart) {
      _graphDirty = false;
    } else {
      console.error(`${new Date().toISOString()} graph-replica: a write landed mid-sync (generation ${genAtStart} → ${_graphGeneration}); staying dirty so the next query re-projects`);
    }
    rebuiltMs = Math.round(performance.now() - t);
    console.error(`${new Date().toISOString()} graph-replica: synced ${stats.updated} updated, ${stats.removed} removed of ${stats.total} entities, +${activities} activities (through seq ${_activitySeq}) → ${_graphStore.size} triples in ${rebuiltMs}ms`);
  }
  return { store: _graphStore, rebuiltMs, projectedThrough: _graphProjectedThrough };
}

/**
 * #949 — WHAT STORE STATE DOES THIS ANSWER REPRESENT?
 *
 * Every consumer on this board tracks a position against the event sequence
 * except the replica, whose answers the room treats as authoritative. So a
 * caller could not tell "current" from "four minutes behind" — which is exactly
 * what #931 produced against #857's own acceptance query, found by accident.
 *
 * ⭐ THE NAME IS DELIBERATELY NARROWER THAN THE THING (a warning raised on review, and
 * the board has three instruments that got this wrong the other way: `seats{}`
 * answers "who is BOUND" and reads as "who is online"; `cursors.json` measures
 * PULL PARTICIPATION and reads as liveness; `board_ready` counts CARD blockers
 * and says `no-open-blockers`). `projectedThrough` is not "the replica is
 * current" — it is one seq, and the payload says so beside it.
 *
 * ⚠️ AND IT PUBLISHES ITS OWN BLIND SPOTS, because the only two surfaces on this
 * board that have ever caught anything — /api/checks and /api/misses — are the
 * two that print what they cannot see next to the number.
 */
function graphWatermark(projectedThrough) {
  const storeHead = headSeq(EVENT_LOG_DIR);
  const cold = projectedThrough === null;
  return {
    projectedThrough,
    storeHead,
    behindBy: cold ? null : Math.max(0, storeHead - projectedThrough),
    current: cold ? false : projectedThrough >= storeHead,
    means: 'projectedThrough is the newest event seq reflected in the DOCUMENT '
      + 'bytes this replica was projected from, derived from that snapshot\'s lastUpdated.',
    blindTo: [
      'a change to the board file that produced NO event — writeBoard refuses '
      + 'those, so this means out-of-band edits only, and they move nothing here',
      'writes that land after storeHead was read — this is a point-in-time '
      + 'claim, never a lock: current:true can go stale one millisecond later',
      'whether the projection itself is CORRECT — the pair reports position, '
      + 'not fidelity. A faithfully-projected wrong document reads current',
    ],
  };
}

// ── POST /api/search — #1086 item 13: a seat types a question and reads cards ──
//
// What was measured first (#1095, frozen, k=8): dense embedding reproduces the
// room's findable targets 9/9 where BM25 gets 1/9 and recency 3/9; and no raw
// ranker abstains. So every answer here is one of answer | ask | abstain, with
// the thresholds published beside the verdict. The index is incremental (a
// card is re-embedded only when its text hash changes, at most SEARCH_MAX_EMBED
// per call) and every answer carries `coverage`, so a partial index reads as
// partial rather than as "found nothing".
async function handleSearch(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const q = typeof body.q === 'string' ? body.q.trim() : '';
    if (!q) return sendJSON(res, 400, { error: 'body.q (the question, in your own words) is required' });
    const S = await loadSearchModule();
    const k = Number.isInteger(body.k) && body.k > 0 ? Math.min(body.k, 50) : S.DEFAULTS.k;
    const thresholds = { abstainBelow: SEARCH_ABSTAIN_BELOW, askWithin: SEARCH_ASK_WITHIN };
    if (!SEARCH_EMBED_URL || !SEARCH_EMBED_MODEL) {
      return sendJSON(res, 200, {
        available: false,
        reason: 'no embedder is configured on this server — set SEARCH_EMBED_URL (an Ollama-shaped /api/embed) and SEARCH_EMBED_MODEL. Nothing was searched.',
        ...thresholds, k,
      });
    }
    const data = readBoard();
    const cards = data.cards.filter((c) => c && c.id);
    // Load the index under the model this server runs; a different generation
    // is refused with the remedy rather than silently mixed.
    let index;
    try {
      const text = fs.existsSync(SEARCH_INDEX_FILE) ? fs.readFileSync(SEARCH_INDEX_FILE, 'utf8') : '';
      index = S.parseIndex(text, { model: SEARCH_EMBED_MODEL, dims: null });
    } catch (e) {
      return sendJSON(res, 200, { available: false, reason: e.message, ...thresholds, k });
    }
    const plan = S.planIndexUpdate(cards, index.rows, { maxEmbed: SEARCH_MAX_EMBED, maxEmbedChars: SEARCH_MAX_EMBED_CHARS });
    // ONE embedder call: the query first, then this batch of changed cards.
    let vectors;
    try {
      vectors = await embedTexts([q, ...plan.toEmbed.map((t) => t.text)]);
    } catch (e) {
      return sendJSON(res, 200, { available: false, reason: `embedder unavailable — ${e.message}. Nothing was searched.`, ...thresholds, k });
    }
    const [qv, ...cardVecs] = vectors;
    const dims = qv.length;
    const generation = index.generation ?? { model: SEARCH_EMBED_MODEL, dims, textShape: S.TEXT_SHAPE, builtAt: new Date().toISOString() };
    if (generation.dims !== dims) {
      return sendJSON(res, 200, { available: false, reason: `search index: generation mismatch — file is ${generation.model}/${generation.dims}, the embedder now returns ${dims} dimensions. Delete ${SEARCH_INDEX_FILE} to rebuild.`, ...thresholds, k });
    }
    const fresh = plan.toEmbed.map((t, i) => ({ id: t.id, hash: t.hash, vec: cardVecs[i] }));
    const rows = [...plan.keep, ...fresh];
    try {
      fs.writeFileSync(SEARCH_INDEX_FILE, S.serializeIndex(generation, rows));
    } catch { /* the index is a cache of the model; failing to persist it costs re-embedding, not correctness */ }
    const coverage = { indexed: rows.length, total: plan.coverage.total, stale: plan.coverage.stale - fresh.length };
    const partial = coverage.stale > 0 || coverage.indexed < coverage.total;
    const ranked = S.rank(qv, rows, { k });
    const byId = new Map(cards.map((c) => [c.id, c]));
    const results = ranked.map((r) => {
      const c = byId.get(r.id);
      return { id: r.id, shortId: c?.shortId ?? null, title: c?.title ?? null, column: c?.column ?? null, score: Math.round(r.score * 1000) / 1000 };
    });
    const d = S.decide(ranked, thresholds);
    const pick = (r) => (r ? results.find((x) => x.id === r.id) ?? null : null);
    const out = {
      available: true, model: SEARCH_EMBED_MODEL, k,
      verdict: d.verdict, reason: d.reason,
      top: pick(d.top), contenders: d.contenders.map(pick).filter(Boolean),
      abstainBelow: d.abstainBelow, askWithin: d.askWithin,
      results, coverage, partial,
      generation: { model: generation.model, dims: generation.dims, builtAt: generation.builtAt },
      means: {
        verdict: 'answer = a clear top hit · ask = ≥2 candidates within askWithin of the top (they are the question) · abstain = top cosine below abstainBelow, or an empty index',
        partial: 'true when cards remain un-embedded; the answer was computed over `coverage.indexed` of `coverage.total` cards — could-not-search-everything is not found-nothing',
      },
    };
    // The verbatim query log — ask.py's guard 2: the first month's questions
    // are the least tool-shaped the room will ever produce. Keep them raw.
    try {
      fs.appendFileSync(SEARCH_LOG_FILE, JSON.stringify({
        at: new Date().toISOString(), by: (typeof body.by === 'string' && body.by) || null,
        q, verdict: d.verdict, top: results.slice(0, k).map((r) => r.shortId ?? r.id), coverage, partial,
      }) + '\n');
    } catch { /* telemetry, never a gate on the answer */ }
    sendJSON(res, 200, out);
  } catch (e) {
    console.error('POST /api/search:', e.message);
    sendJSON(res, 500, { error: 'search failed', detail: e.message });
  }
}

// ── GET /api/graph/vocabulary — #1104: is the unknown-term guard refusing a
// WORKING query right now? Runs vocabularyDrift over the SERVED replica (after
// the same sync every query gets), so the number is about production, not a
// fixture. `undeclared` non-empty means the dictionary fell behind the
// projection and the guard is worse than no guard until someone adds the term.
async function handleGraphVocabulary(req, res) {
  try {
    const { vocabularyDrift } = await loadGraphModules();
    const { store, rebuiltMs, projectedThrough } = await warmGraphStore();
    const drift = vocabularyDrift(store);
    sendJSON(res, 200, { ...drift, rebuiltMs: rebuiltMs ?? null, watermark: graphWatermark(projectedThrough) });
  } catch (e) {
    if (e.code === 'GRAPH_DEPS_MISSING') return sendJSON(res, 503, { error: e.message, code: e.code });
    console.error('GET /api/graph/vocabulary:', e.message);
    sendJSON(res, 500, { error: 'Failed to measure vocabulary drift' });
  }
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
    // #898 — event-loop utilization is sampled as a DELTA over this call, so a
    // slow row can say whether the loop was busy or the store was.
    const eluStart = performance.eventLoopUtilization();
    const { queryGraph } = await loadGraphModules();
    const { store, rebuiltMs, projectedThrough } = await warmGraphStore();
    const result = queryGraph(store, body.query, { limit: body.limit });
    // #949 — read AFTER the sync, so `storeHead` reflects anything that landed
    // during it. That ordering is the whole point: a write arriving mid-sync is
    // the #931 window, and it must widen the gap rather than disappear into it.
    result.watermark = graphWatermark(projectedThrough);
    const totalMs = Math.round(performance.now() - tCall);
    // #898 — WHAT THESE NUMBERS MEASURE, said beside them. Two production rows
    // (9,443ms and 28,610ms) reproduce in 1ms and 53ms and cannot be explained,
    // because nothing recorded what else was true of the process at that
    // moment; three shipped hints then quoted them as facts about query shape.
    // `ms` is the synchronous store.query() region — nothing interleaves inside
    // it — so a slow `ms` is time genuinely spent in the engine, and the only
    // way to explain it later is to capture the process's state NOW. Above the
    // threshold (published, env-overridable) the row carries that state.
    const slowAfterMs = GRAPH_SLOW_MS;
    const slow = totalMs >= slowAfterMs ? processContextForSlowQuery(eluStart) : undefined;
    result.timing = {
      ms: result.ms, rebuiltMs: rebuiltMs ?? null, totalMs, slowAfterMs,
      means: {
        ms: 'synchronous engine time inside store.query() — nothing interleaves; a slow ms was spent in the engine',
        rebuiltMs: 'projection sync that ran BEFORE the query in this call; null means no sync ran',
        totalMs: 'wall time of the whole call: module load + sync + engine',
        slow: 'present only when totalMs >= slowAfterMs: the process at that moment (load, memory, event-loop utilization over the call)',
      },
      ...(slow ? { slow } : {}),
    };
    try {
      fs.appendFileSync(GRAPH_QUERY_LOG, JSON.stringify({
        at: new Date().toISOString(), by: (typeof body.by === 'string' && body.by) || null,
        ms: result.ms, rebuiltMs, totalMs,
        returned: result.returned ?? 0, truncated: !!result.truncated,
        query: body.query.slice(0, 2000),
        ...(slow ? { slow } : {}),
      }) + '\n');
    } catch { /* the log is telemetry, never a gate on the answer */ }
    sendJSON(res, 200, result);
  } catch (e) {
    if (e.code === 'GRAPH_DEPS_MISSING') return sendJSON(res, 503, { error: e.message, code: e.code });
    if (e.code === 'READ_ONLY' || e.code === 'EMPTY_QUERY') return sendJSON(res, 400, { error: e.message, code: e.code });
    // #885 — an unbounded path refusal carries its OWN hint naming the query
    // that works, and it must survive to the caller. The generic branch below
    // would overwrite it with the prefix blurb, which is the three-list defect:
    // the thrower declared a hint and the consumer read a different one. Caught
    // by this card's own test, not by review.
    if (e.code === 'UNBOUNDED_PATH') return sendJSON(res, 400, { error: e.message, code: e.code, hint: e.hint });
    // #1104 — SAME REASON, AND IT WAS CAUGHT THE SAME WAY: the guard threw
    // UNKNOWN_TERM with a hint naming the term, the generic branch below
    // replaced the hint with the prefix blurb and dropped `code` entirely, and
    // the refusal arrived as an anonymous 400. The #885 comment above predicted
    // exactly this ("the thrower declared a hint and the consumer read a
    // different one") and it happened anyway, one branch down, to the seat who
    // had just read the comment. Its own test caught it, not review.
    if (e.code === 'UNKNOWN_TERM' || e.code === 'UNKNOWN_PREFIX') {
      return sendJSON(res, 400, { error: e.message, code: e.code, hint: e.hint, terms: e.terms });
    }
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
/**
 * #792 / #857 §VI — GET /api/checks. Run every authored tripwire and report
 * which claims the world has moved out from under.
 *
 * ⛔ WHY THIS EXISTS. #857 §IV listed three cards as NOT BUILT while they sat in
 * `done`, twice in thirty hours, and both times a person had to notice. §VI had
 * already specified the fix — "each load-bearing claim holds a pointer to the
 * live measurement that would falsify it" — and it was never built, so the card
 * that predicted its own rot rotted unobserved.
 *
 * ⚠️ THREE OUTCOMES, NOT TWO, and the third is the one that keeps this honest:
 *
 *   holds   the tripwire answered what its author expected
 *   stale   it answered the other way ⇒ the claim's world moved. NOT "the claim
 *           is false" — this surface cannot know that. Someone must look.
 *   error   the check could not run ⇒ reported as its own state, NEVER as holds.
 *           A broken watcher that reads green is a health signal blind to its
 *           own failure, which is the defect class this board keeps finding.
 *
 * ⭐ AND UNWATCHED IS COUNTED. `0 stale` on a board where nobody wrote a check
 * is a vibes number. The response says how many cards carry checks and how many
 * do not, so "nothing is wrong" can never be confused with "nothing is watched".
 */
// ── #857 §IV — labels as a CONTROLLED vocabulary: declared synonyms ──────────
//
// #687 minted one concept per distinct label string and stopped there, on
// purpose: merging spellings needs a mechanism, and identities are a
// prerequisite for every candidate mechanism.
//
// ⭐ MEASURED AFTER #687 SHIPPED — 393 concepts, SEVEN normalised collisions:
//     #561/561 · autonomous room/autonomous-room · jsonld/json-ld
//     schema.org/schema-org · MGMT:9230/mgmt:9230 · vtm/VTM
//     building scrum board / building-scrum-board / building-scrum board  ⇐ THREE
//
// ⚠️ Every post that night called that last one "two spellings". It is three,
// and nobody knew, because a bare-string vocabulary cannot be asked what it
// contains. Finding it took one query AFTER the identities existed.
//
// ⛔ NOTHING MERGES AUTOMATICALLY. Normalisation SURFACES candidates; a seat
// DECLARES the merge. Two strings that normalise alike are not necessarily one
// concept — and fusing them at write time would bake an unfalsifiable judgement
// into the store, which is the rule the room settled when it decided the replica
// emits facts and queries do the interpreting.
const normLabel = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function labelUniverse(data) {
  const counts = new Map();
  for (const c of data.cards || []) {
    for (const l of c.labels || []) counts.set(l, (counts.get(l) || 0) + 1);
  }
  return counts;
}

function handleLabelCollisions(req, res) {
  const data = readBoard();
  const counts = labelUniverse(data);
  const aliases = aliasMap(data);
  const groups = new Map();
  for (const label of counts.keys()) {
    const k = normLabel(label);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(label);
  }
  const collisions = [...groups.values()]
    .filter((members) => members.length > 1)
    .map((members) => {
      // ⚠️ DECLARED means every member but one points at a canonical. A group
      // where only some are declared is still OPEN — a half-merged concept is
      // the state that silently returns partial answers.
      const undeclared = members.filter((m) => !aliases[m]);
      return {
        members: members.sort(),
        cards: Object.fromEntries(members.map((m) => [m, counts.get(m) || 0])),
        declared: undeclared.length <= 1,
      };
    })
    .sort((a, b) => Number(a.declared) - Number(b.declared) || a.members[0].localeCompare(b.members[0]));

  sendJSON(res, 200, {
    concepts: counts.size,
    // ⭐ OPEN is the headline. A total that includes settled collisions is the
    // perishable-claim shape: true when written, false once decided, and a
    // reader planning from it re-decides what was already decided.
    open: collisions.filter((c) => !c.declared).length,
    declared: collisions.filter((c) => c.declared).length,
    note: 'collisions are CANDIDATES found by normalising case and punctuation. Two labels that '
      + 'normalise alike are not necessarily one concept — a seat declares the merge via '
      + 'POST /api/labels/aliases. Nothing is merged automatically.',
    collisions,
  });
}

/** Rows → the {alias: canonical} map callers actually want to read. */
function aliasMap(data) {
  return Object.fromEntries((data.labelAliases || []).map((r) => [r.alias, r.canonical]));
}

function handleGetLabelAliases(req, res) {
  sendJSON(res, 200, { aliases: aliasMap(readBoard()) });
}

async function handleDeclareLabelAlias(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const { alias, canonical } = body;
    if (!alias || !canonical) return sendJSON(res, 400, { error: 'alias and canonical are both required' });
    if (alias === canonical) {
      return sendJSON(res, 400, { error: 'a concept cannot be its own synonym — that is a cycle, not a merge' });
    }
    const saved = await withWriteLock(async () => {
      const data = readBoard();
      const counts = labelUniverse(data);
      // ⚠️ The canonical must be a label some card actually carries. Without
      // this a typo mints a canonical nothing uses and quietly orphans every
      // alias pointed at it — a merge that makes the set SMALLER than before.
      if (!counts.has(canonical)) {
        return { error: `canonical ${JSON.stringify(canonical)} is not a label any card carries` };
      }
      if (!counts.has(alias)) {
        return { error: `alias ${JSON.stringify(alias)} is not a label any card carries` };
      }
      // No chains: an alias pointing at another alias makes resolution depend on
      // traversal order. Collapse to the ultimate canonical at declaration time.
      const existing = aliasMap(data);
      let target = canonical;
      const seen = new Set([alias]);
      while (existing[target] && !seen.has(target)) { seen.add(target); target = existing[target]; }

      const rows = [...(data.labelAliases || [])];
      const at = rows.findIndex((r) => r.alias === alias);
      const row = {
        id: at >= 0 ? rows[at].id : crypto.randomUUID(),
        alias, canonical: target, by: body.by || null, at: new Date().toISOString(),
      };
      if (at >= 0) rows[at] = row; else rows.push(row);
      data.labelAliases = rows;
      writeBoard(data, [{
        op: at >= 0 ? 'update' : 'create', actor: body.by || null,
        entity: { kind: 'label', id: row.id }, state: row,
      }]);
      return { alias, canonical: target };
    });
    if (saved.error) return sendJSON(res, 400, { error: saved.error });
    sendJSON(res, 200, saved);
  } catch (e) {
    console.error('POST /api/labels/aliases:', e.message);
    sendJSON(res, 500, { error: e.message });
  }
}

// ── #651 — MEMORY as a graph type: queryable, versioned, tagged ──────────────
//
// "a new type of 'thing' in the graph: 'memory'… it would give an agent the
// ability to query, 'What are my important memories? what are the things I
// thought to hold closely?'"
//
// ⭐ VERSIONING IS THE LOAD-BEARING HALF, and the card's own evidence is why: a
// seat's index went 64 KB → 6.5 KB in ONE curation pass — a ~90% lossy event
// with no record of what was cut. Versioned memories make pruning SAFE: cut
// boldly, because the prior version is addressable. Today every prune is
// irreversible and therefore conservative, which is exactly why the file grows
// until it must be cut hard, which is when the loss happens.
//
// ⛔ WHAT IS DELIBERATELY ABSENT, on the card's own arguments:
//   · ACCESS FREQUENCY — a write-per-read on a flat store, AND it would rank the
//     auto-loaded index first forever, measuring the loading mechanism rather
//     than the value. The card proves the trap twice; it is not built.
//   · THE READ / CONSENT MODEL — put to the room, and correctly reframed there:
//     not "are these secret" but "whose information is in here, and did they
//     agree to how it is held?" A store can exist before that is answered; an
//     aggregation surface cannot. So there is no cross-seat aggregation here.
//   · ANY IMPORT — nothing reads an existing memory file. Every memory is one a
//     seat chose to write. Importing would answer the consent question by
//     default, which is the failure the card names.
const MEMORY_ID = (id) => `https://scrumboard.local/memory/${id}`;
const MEMORY_VERSION_ID = (id, v) => `https://scrumboard.local/memory/${id}/v${v}`;

// ── #613 — SEAT STATE: "I am here, and I am not taking this" ────────────────
//
// One row per seat, replaced on re-declaration. No version history: the card
// asks whether a seat is declining NOW, and a log of past rests answers a
// question nobody asked while making the live read a scan.
//
// ⛔ THE WRITE PATH TAKES THE SEAT FROM ITS CALLER, and the MCP tool takes it
// from the BOUND SESSION rather than the payload. #1106 is today's card about a
// tool that dropped `by` and silently signed every write with the owner's name;
// a declaration is a statement about WHO IS SPEAKING, so getting the speaker
// from the message is the one thing it must not do. At REST this is as
// declared-not-authenticated as every other write here (#125) — no new hole,
// and no pretence that there isn't an old one.
const SEAT_STATE_ID = (seat) => `https://scrumboard.local/seat-state/${encodeURIComponent(seat)}`;

function seatStatesOf(data) {
  return Array.isArray(data.seatStates) ? data.seatStates : [];
}
/** Stored JSON-LD row → the plain shape core/seat-state.mjs reasons about. */
function seatDeclFromNode(n) {
  return {
    seat: n['scrum:seat'], mode: n['scrum:mode'],
    acceptsRoutineWork: n['scrum:acceptsRoutineWork'],
    constraints: Array.isArray(n['scrum:constraint']) ? n['scrum:constraint'] : [],
    note: n['scrum:note'] ?? null,
    declaredAt: n['scrum:declaredAt'], expiresAt: n['scrum:expiresAt'],
  };
}
function seatDeclsOf(data) { return seatStatesOf(data).map(seatDeclFromNode); }

const seatStateEvent = (op, decl) => ({
  op, actor: decl.seat,
  entity: { kind: 'seat-state', id: decl.seat },
  state: decl,
});

function memoriesOf(data) {
  return Array.isArray(data.memories) ? data.memories : [];
}

/** The stored entities for one memory, newest version last. */
function memoryParts(data, id) {
  const all = memoriesOf(data);
  const iri = MEMORY_ID(id);
  const identity = all.find((e) => e['@type'] === 'scrum:Memory' && e['@id'] === iri) || null;
  const versions = all
    .filter((e) => e['@type'] === 'scrum:MemoryVersion' && e['scrum:ofMemory'] === iri)
    .sort((a, b) => (a['scrum:version'] || 0) - (b['scrum:version'] || 0));
  return { identity, versions };
}

function memoryToWire(identity, versions) {
  const newest = versions[versions.length - 1];
  return {
    id: identity.identifier,
    title: identity.name,
    owner: identity['scrum:owner'] || null,
    tags: [].concat(identity['scrum:tag'] || []),
    body: newest ? newest['scrum:body'] : '',
    version: newest ? newest['scrum:version'] : 0,
    updatedAt: newest ? newest.dateCreated : null,
  };
}

/**
 * #613 — GET /api/seats/state. Every roster seat, with UNKNOWN for the ones
 * that have not spoken. ⇒ The roster is the population, matching #1078's
 * inFlight: a second definition of "the seats" in a second payload is the
 * two-surfaces defect this board keeps paying for.
 */
function handleSeatStates(req, res) {
  const data = readBoard();
  const decls = seatDeclsOf(data);
  const now = new Date().toISOString();
  // ⚠️ The population is ROSTER, plus any seat that has actually declared.
  // Roster alone was the first cut and it hides a real declaration whenever the
  // roster is misconfigured or a seat was removed from it — the state would be
  // stored, honoured by the scheduler, and INVISIBLE on the surface that exists
  // to show it. A declaration is evidence that a seat exists; the union is the
  // honest population.
  const keys = [...new Set([
    ...Object.keys(ROSTER ?? {}),
    ...decls.map((d) => d.seat).filter(Boolean),
  ])];
  const seats = keys.map((seat) => seatState(decls, seat, now));
  const el = tendingEligibility(keys, decls, now);
  sendJSON(res, 200, {
    now, seats, eligible: el.eligible, declining: el.declining, anyEligible: el.anyEligible,
    means: 'UNKNOWN is the ABSENCE of a declaration, never a stated no. An UNKNOWN seat is '
      + 'ELIGIBLE and keeps its existing behaviour; only acceptsRoutineWork:false removes one.',
  });
}

/**
 * #613 — PUT /api/seats/:seat/state, and DELETE to clear.
 *
 * ⚠️ `seat` is the PATH, and the MCP tool fills it from the bound session. A
 * mismatch between the path and a `seat` in the body is REFUSED rather than
 * relayed: conversation_post records a mismatch as `onBehalfOf` because
 * relaying someone's words is a real act, but "ada says bo is resting" is a
 * THIRD-PARTY OBSERVATION, which is a different field with its own evidence
 * requirements and does not exist yet. Silently accepting it would store an
 * observation as a declaration.
 */
async function handleSeatDeclare(req, res, seat) {
  try {
    const body = JSON.parse(await readBody(req));
    if (body.seat && String(body.seat) !== seat) {
      return sendJSON(res, 403, {
        error: `this route declares state for '${seat}'; the body names '${body.seat}'. `
          + 'A declaration is a statement about who is speaking — it is not relayable. '
          + 'A third-party observation about another seat is a different thing and has no field yet.',
        code: 'SEAT_MISMATCH',
      });
    }
    let decl;
    try {
      decl = validateDeclaration(seat, body);
    } catch (e) {
      return sendJSON(res, 400, { error: e.message, code: e.code });
    }
    const saved = await withWriteLock(async () => {
      const data = readBoard();
      const node = {
        '@id': SEAT_STATE_ID(seat), '@type': 'scrum:SeatDeclaration',
        'scrum:seat': decl.seat, 'scrum:mode': decl.mode,
        'scrum:acceptsRoutineWork': decl.acceptsRoutineWork,
        ...(decl.constraints.length ? { 'scrum:constraint': [...decl.constraints] } : {}),
        ...(decl.note ? { 'scrum:note': decl.note } : {}),
        'scrum:declaredAt': decl.declaredAt, 'scrum:expiresAt': decl.expiresAt,
      };
      const prior = seatStatesOf(data).some((n) => n['scrum:seat'] === seat);
      data.seatStates = [...seatStatesOf(data).filter((n) => n['scrum:seat'] !== seat), node];
      // ⚠️ The event log has a CLOSED op vocabulary (create|update|delete|post|
      // redact) and refused a `declare` op outright — the rail working. Mapped
      // onto the existing verbs rather than widening them: a first declaration
      // is a create, a re-declaration replaces the row, a clear is a delete.
      // Widening the vocabulary is a protocol change and does not belong in a
      // slice that needed a word.
      writeBoard(data, [seatStateEvent(prior ? 'update' : 'create', decl)]);
      return decl;
    });
    sendJSON(res, 200, saved);
  } catch (e) {
    console.error(`PUT /api/seats/${seat}/state:`, e.message);
    sendJSON(res, 500, { error: e.message });
  }
}

async function handleSeatClear(req, res, seat) {
  const cleared = await withWriteLock(async () => {
    const data = readBoard();
    const before = seatStatesOf(data);
    const after = before.filter((n) => n['scrum:seat'] !== seat);
    if (after.length === before.length) return false;
    data.seatStates = after;
    writeBoard(data, [seatStateEvent('delete', { seat })]);
    return true;
  });
  // Idempotent: clearing an undeclared seat is already the desired end state.
  sendJSON(res, 200, { seat, mode: SEAT_UNKNOWN, cleared });
}

async function handleCreateMemory(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    if (!body.title || !String(body.title).trim()) return sendJSON(res, 400, { error: 'title is required' });
    if (typeof body.body !== 'string' || !body.body.trim()) return sendJSON(res, 400, { error: 'body is required — a memory with no text is a title pretending to be a memory' });
    const owner = body.owner || body.by || null;
    if (!owner) return sendJSON(res, 400, { error: 'owner is required: a memory with no owner cannot answer "what are MY memories", which is the question this type exists for' });
    if (body.tags !== undefined && !Array.isArray(body.tags)) return sendJSON(res, 400, { error: 'tags must be an array' });

    const created = await withWriteLock(async () => {
      const data = readBoard();
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const vIri = MEMORY_VERSION_ID(id, 1);
      const identity = {
        '@id': MEMORY_ID(id), '@type': 'scrum:Memory',
        identifier: id, name: String(body.title),
        'scrum:owner': owner,
        ...(body.tags?.length ? { 'scrum:tag': [...body.tags] } : {}),
        'scrum:currentVersion': vIri,
      };
      const version = {
        '@id': vIri, '@type': 'scrum:MemoryVersion',
        'scrum:ofMemory': MEMORY_ID(id), 'scrum:version': 1,
        'scrum:body': body.body, author: owner, dateCreated: now,
      };
      data.memories = [...memoriesOf(data), identity, version];
      writeBoard(data, [memoryEvent('create', identity, owner)]);
      return memoryToWire(identity, [version]);
    });
    sendJSON(res, 201, created);
  } catch (e) {
    console.error('POST /api/memories:', e.message);
    sendJSON(res, 500, { error: e.message });
  }
}

async function handleUpdateMemory(req, res, id) {
  try {
    const body = JSON.parse(await readBody(req));

    // #466 — validate the PRECONDITION'S SHAPE before taking the write lock. A
    // malformed request has no business acquiring a lock to be rejected, and
    // this needs no board state to decide.
    //
    // ⛔ 400, NOT 409, and the distinction is load-bearing. 409 means "you are
    // behind, re-read and retry" — a client may legitimately loop on it. 400
    // means "this request is malformed" and looping is futile. The first cut
    // compared `body.ifVersion !== current` strictly, so `ifVersion: "2"` on a
    // memory genuinely at version 2 returned a 409 reading "the current version
    // is 2" — a conflict that can NEVER clear, quoting back the value the caller
    // just sent, and sending a retrying client into a loop with no exit.
    // Found in review by a second seat, on the same night this shipped.
    //
    // ⚠️ REFUSE rather than COERCE, which was the other candidate: Number('2abc')
    // is NaN and NaN !== current for EVERY current, so coercion leaves the
    // unclearable 409 fully intact on malformed input while newly and SILENTLY
    // accepting null as 0 and true as 1. It fixes the example, not the class.
    // A precondition exists to be unambiguous about what the caller believed;
    // guessing is the one thing it must not do.
    if (body.ifVersion !== undefined
        && !(Number.isInteger(body.ifVersion) && body.ifVersion >= 0)) {
      return sendJSON(res, 400, {
        error: 'ifVersion must be a non-negative integer (the version you read). '
          + `Got ${JSON.stringify(body.ifVersion)}. This is a malformed request, `
          + 'not a version conflict — re-reading and retrying will not clear it.',
      });
    }

    // #1022 — bodyAppend / bodyPrepend: the byte-preserving verbs cards got in
    // #864/#906, on the store the room keeps its shared lessons in. Every
    // memory edit used to be a full-body replace: read, concatenate locally,
    // send the whole thing back — which is a read-modify-write, so two seats
    // appending seconds apart meant the second silently deleted the first
    // (#466's shape), and adding 1.7 KB cost 4.9 KB on the wire (measured on
    // this card). Composed HERE, inside the write lock, against the version
    // that is current at the moment of the write: neither caller sends the
    // existing text, and neither can lose the other's.
    //
    // Refused alongside `body`: replace and add are two intentions and one
    // write cannot mean both. Refused when empty: an append of nothing would
    // mint a version of unchanged text. Prepend and append COMPOSE
    // (prepend + existing + append) — #906 settled the ordering question and
    // this copies its answer rather than reopening it.
    const hasAppend = body.bodyAppend !== undefined;
    const hasPrepend = body.bodyPrepend !== undefined;
    if (hasAppend || hasPrepend) {
      for (const k of ['bodyAppend', 'bodyPrepend']) {
        if (body[k] === undefined) continue;
        if (typeof body[k] !== 'string') {
          return sendJSON(res, 400, { error: `${k} must be a string (the text to add)` });
        }
        if (!body[k].length) {
          return sendJSON(res, 400, { error: `${k} is empty — nothing to add, and a version of unchanged text is not minted` });
        }
      }
      if (body.body !== undefined) {
        return sendJSON(res, 400, {
          error: 'send either body (replace as a new version) or bodyAppend/bodyPrepend (add to the current text), not both — '
            + 'a replace and an addition in one write are two intentions and the result would be neither',
        });
      }
    }

    const updated = await withWriteLock(async () => {
      const data = readBoard();
      const { identity, versions } = memoryParts(data, id);
      if (!identity) return null;

      // #466 — OPTIONAL compare-and-swap. A caller that read version N and means
      // to write on top of THAT text can say so; if the memory has moved on, the
      // write is refused with the current version so it can re-read and retry.
      //
      // ⛔ OPT-IN BY CONSTRUCTION. A caller that sends no `ifVersion` is
      // unaffected — that is every existing writer, and a precondition applied
      // to callers who never asked for one is a worse defect than the one this
      // fixes. Pinned by test 1 in memory-ifversion-cas.test.mjs.
      //
      // Inside withWriteLock and BEFORE the append, so the version it compares
      // is the one the append is about to succeed. Outside the lock this is a
      // check-then-act race and would read as CAS while providing none.
      if (body.ifVersion !== undefined) {
        const current = versions[versions.length - 1]?.['scrum:version'] || 0;
        if (body.ifVersion !== current) {
          return { conflict: true, currentVersion: current };
        }
      }

      // ⛔ APPEND-ONLY. A caller naming an older version does NOT get to rewrite
      // it: the new text always becomes the NEXT version. History that can be
      // edited answers "what did this say before?" with whatever someone most
      // recently wished it had said, which is worse than no history at all.
      // #1022 — the addition is composed against the CURRENT version, read
      // under this same lock. That is what makes two concurrent appends both
      // survive: the second sees the first's text, not the snapshot it started
      // from, because it never held a snapshot at all.
      let nextBody = null;
      if (typeof body.body === 'string' && body.body.length) nextBody = body.body;
      else if (hasAppend || hasPrepend) {
        const current = versions[versions.length - 1]?.['scrum:body'] ?? '';
        nextBody = `${hasPrepend ? body.bodyPrepend : ''}${current}${hasAppend ? body.bodyAppend : ''}`;
      }
      if (nextBody !== null) {
        const next = (versions[versions.length - 1]?.['scrum:version'] || 0) + 1;
        const vIri = MEMORY_VERSION_ID(id, next);
        data.memories = [...memoriesOf(data), {
          '@id': vIri, '@type': 'scrum:MemoryVersion',
          'scrum:ofMemory': MEMORY_ID(id), 'scrum:version': next,
          'scrum:body': nextBody,
          author: body.by || identity['scrum:owner'] || null,
          dateCreated: new Date().toISOString(),
        }];
        identity['scrum:currentVersion'] = vIri;
      }
      // The IDENTITY is mutable — that is the point of the split. Retitling or
      // retagging a memory must not mint a version of unchanged text.
      if (typeof body.title === 'string' && body.title.trim()) identity.name = body.title;
      if (Array.isArray(body.tags)) identity['scrum:tag'] = [...body.tags];

      writeBoard(data, [memoryEvent('update', identity, body.by || identity['scrum:owner'] || null)]);
      const after = memoryParts(readBoard(), id);
      return memoryToWire(after.identity, after.versions);
    });
    if (!updated) return sendJSON(res, 404, { error: `no memory ${id}` });
    if (updated.conflict) {
      return sendJSON(res, 409, {
        error: `memory ${id} has moved on: you declared ifVersion but the current version is ${updated.currentVersion}`,
        currentVersion: updated.currentVersion,
      });
    }
    sendJSON(res, 200, updated);
  } catch (e) {
    console.error('PATCH /api/memories:', e.message);
    sendJSON(res, 500, { error: e.message });
  }
}

function handleGetMemory(req, res, id) {
  const { identity, versions } = memoryParts(readBoard(), id);
  if (!identity) return sendJSON(res, 404, { error: `no memory ${id}` });
  sendJSON(res, 200, memoryToWire(identity, versions));
}

function handleMemoryVersions(req, res, id) {
  const { identity, versions } = memoryParts(readBoard(), id);
  if (!identity) return sendJSON(res, 404, { error: `no memory ${id}` });
  sendJSON(res, 200, {
    id, title: identity.name, owner: identity['scrum:owner'] || null,
    // ⭐ THE PRUNING GUARANTEE, as data: every prior text, in order, none of it
    // rewritable. This is what makes cutting hard a safe act.
    versions: versions.map((v) => ({
      version: v['scrum:version'], body: v['scrum:body'],
      author: v.author || null, at: v.dateCreated || null,
    })),
  });
}

function handleListMemories(req, res) {
  const q = parseQuery(req.url);
  const data = readBoard();
  const ids = memoriesOf(data)
    .filter((e) => e['@type'] === 'scrum:Memory')
    .map((e) => e.identifier);
  let out = ids.map((id) => {
    const { identity, versions } = memoryParts(data, id);
    return memoryToWire(identity, versions);
  });
  if (q.owner) out = out.filter((m) => m.owner === q.owner);
  if (q.tag) out = out.filter((m) => m.tags.includes(q.tag));
  sendJSON(res, 200, { total: out.length, memories: out });
}


// ── #918 — DECISIONS ARE FIRST-CLASS ────────────────────────────────────────
//
// A card is WORK. A decision is a CONSTRAINT ON FUTURE WORK, and its whole
// value is that it stops a conversation recurring. It has no column, no claim,
// no done state — it has a statement, a decider, a date, what it CONSTRAINS,
// and what would REOPEN it.
//
// ⭐ `reopensIf` is the field prose never carries and the reason this type is
// worth building. A ruling is only safe to INHERIT if the next reader can see
// what evidence would overturn it. Without it, a decision is either re-argued
// from scratch or obeyed superstitiously — and this room did both, four times
// in one day, with four rulings that lived only in commons posts.
//
// ⛔ `constrains` is a queryable TOPIC LIST, not a sentence, and that is the
// acceptance test: a reader who has never heard of a ruling must be able to
// find it by naming the thing they are about to do. If finding it requires
// knowing which decision to look for, this is a filing cabinet.
const DECISION_ID = (id) => `https://scrumboard.local/decision/${id}`;

// ── #945 slice 1 — the PREDICATE REGISTRY, as observation (Decision aad42bf5) ──
// Option D says a predicate must be registered with a definition before it can
// be used. THIS SLICE GATES NOTHING: it registers and lists, so the decision's
// own reopensIf experiment (can `relatedTo` be defined usably?) can run before
// any write path grows a refusal. Born in the graph per Decision aaf1774b —
// a PredicateDefinition is an entity with events, not a side-file.
const PREDICATE_ID = (name) => `https://scrumboard.local/predicate/${encodeURIComponent(name)}`;
const PREDICATE_NAME_RE = /^(schema|scrum|prov|rdf):[A-Za-z][A-Za-z0-9]*$/;

function predicatesOf(data) {
  return Array.isArray(data.predicates) ? data.predicates : [];
}

const predicateEvent = (op, e, actor) => ({
  op, actor, entity: { kind: 'predicate', id: e['@id'] }, state: e,
});

function predicateToWire(e) {
  return {
    name: e.name,
    definition: e['scrum:definition'],
    registeredBy: e['scrum:registeredBy'],
    registeredAt: e.dateCreated,
    revisedAt: e.dateModified ?? null,
  };
}

/** @returns {string|null} an error message, or null if sound. */
function validatePredicate(b) {
  if (typeof b.name !== 'string' || !PREDICATE_NAME_RE.test(b.name)) {
    return 'name must be a prefixed term like "scrum:relatedTo" or "schema:isPartOf" '
      + '(prefixes: schema, scrum, prov, rdf) — an unprefixed name cannot be matched '
      + 'against what the graph actually emits';
  }
  if (typeof b.definition !== 'string' || !b.definition.trim()) {
    return 'definition is required and must say what asserting this predicate MEANS — '
      + 'a registry of names without definitions is a logbook, not a vocabulary';
  }
  const who = b.by || b.registeredBy;
  if (typeof who !== 'string' || !who.trim()) {
    return 'by is required — who stands behind this definition. Declared, not authenticated.';
  }
  return null;
}

async function handleRegisterPredicate(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const err = validatePredicate(body);
    if (err) return sendJSON(res, 400, { error: err });
    const who = body.by || body.registeredBy;
    const result = await withWriteLock(async () => {
      const data = readBoard();
      const now = new Date().toISOString();
      const existing = predicatesOf(data).find((e) => e.name === body.name);
      if (existing) {
        // ONE entity per name: a re-register is a REVISION. The event log keeps
        // every prior definition; the entity carries the current one.
        const revised = {
          ...existing,
          'scrum:definition': String(body.definition),
          'scrum:registeredBy': who,
          dateModified: now,
        };
        data.predicates = predicatesOf(data).map((e) => (e.name === body.name ? revised : e));
        writeBoard(data, [predicateEvent('update', revised, who)]);
        return { status: 200, wire: predicateToWire(revised) };
      }
      const entity = {
        '@id': PREDICATE_ID(body.name), '@type': 'scrum:PredicateDefinition',
        name: body.name,
        'scrum:definition': String(body.definition),
        'scrum:registeredBy': who,
        dateCreated: now,
      };
      data.predicates = [...predicatesOf(data), entity];
      writeBoard(data, [predicateEvent('create', entity, who)]);
      return { status: 201, wire: predicateToWire(entity) };
    });
    sendJSON(res, result.status, result.wire);
  } catch (e) {
    console.error('POST /api/predicates:', e.message);
    sendJSON(res, 500, { error: e.message });
  }
}

function handleListPredicates(req, res) {
  const q = parseQuery(req.url);
  let out = predicatesOf(readBoard())
    .filter((e) => e['@type'] === 'scrum:PredicateDefinition')
    .map(predicateToWire);
  // An unknown name returns an EMPTY LIST, never an error: "unregistered" is
  // the common and correct answer while the registry is an observation.
  if (q.name) out = out.filter((p) => p.name === q.name);
  sendJSON(res, 200, out);
}

// ── #945 slice 2 — THE WRITE VERB (Decision aad42bf5, Option D) ─────────────
// N assertions (subject, predicate, object), ONE atomic call, gated on the
// registry: an unregistered predicate fails the write and names what to do.
// NOT a second write path — each assertion maps to the store's canonical
// shape (isPartOf→parent, blockedBy→relationships, implementedBy→sha array)
// and rides the same lock, the same events, the same projection boundary as
// every card write. NOT SPARQL Update on the replica: assertions land on the
// store and project forward.
//
// The mapping table is deliberate code. A registered predicate whose store
// mapping is unbuilt refuses honestly instead of inventing a parallel storage
// shape — assertability grows by deliberate act, which is the governance
// Option D bought. Derived predicates refuse with their own registered
// definition quoted: the registry constrains use, not just spelling.

const DERIVED_ASSERT_PREDICATES = new Set(['scrum:mentionsCard']);

async function handleAssert(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : null;
    if (!by) {
      return sendJSON(res, 400, {
        error: 'by is required — who asserts. Declared, not authenticated (the board\'s standing trust model).',
      });
    }
    const assertions = body.assertions;
    if (!Array.isArray(assertions) || assertions.length === 0) {
      return sendJSON(res, 400, { error: 'assertions must be a non-empty array of {subject, predicate, object}' });
    }
    // Shape checks OUTSIDE the lock — they need no board state (#534's rule).
    for (let i = 0; i < assertions.length; i++) {
      const a = assertions[i];
      if (!a || typeof a !== 'object' || Array.isArray(a)) {
        return sendJSON(res, 400, { error: `assertions[${i}] must be an object {subject, predicate, object}` });
      }
      if (typeof a.predicate !== 'string' || !PREDICATE_NAME_RE.test(a.predicate)) {
        return sendJSON(res, 400, {
          error: `assertions[${i}].predicate must be a prefixed term like "scrum:blockedBy" or "schema:isPartOf" `
            + '(prefixes: schema, scrum, prov, rdf)',
        });
      }
    }
    const wire = (a, effect) => ({ subject: a.subject, predicate: a.predicate, object: a.object, effect });
    const result = await withWriteLock(async () => {
      const data = readBoard();
      const registered = new Map(predicatesOf(data)
        .filter((e) => e['@type'] === 'scrum:PredicateDefinition')
        .map((e) => [e.name, e]));

      // ── VALIDATE EVERYTHING before touching anything: the batch is ATOMIC.
      const plan = [];
      for (let i = 0; i < assertions.length; i++) {
        const a = assertions[i];
        const def = registered.get(a.predicate);
        if (!def) {
          return {
            status: 400,
            error: `assertions[${i}]: predicate ${a.predicate} is not registered — a predicate must be `
              + 'registered with a definition before it can be used (Decision aad42bf5). Register it first '
              + '(MCP predicate_register, or POST /api/predicates), then re-assert. Nothing in this batch was applied.',
          };
        }
        if (DERIVED_ASSERT_PREDICATES.has(a.predicate)) {
          return {
            status: 400,
            error: `assertions[${i}]: ${a.predicate} is derived and cannot be asserted — its registered `
              + `definition: "${def['scrum:definition']}". Nothing in this batch was applied.`,
          };
        }
        // #1118 slice B — the subject may be a CARD or an OBLIGATION. The first
        // non-card subject the verb resolves: Option D's "any node type" earning
        // its keep without a parallel storage shape.
        const subjIdx = findCardIndex(data, a.subject);
        const subjObligation = subjIdx < 0
          ? obligationsOf(data).find((e) => e['@id'] === String(a.subject)) ?? null
          : null;
        if (subjIdx < 0 && !subjObligation) {
          return {
            status: 400,
            error: `assertions[${i}]: subject ${JSON.stringify(a.subject)} does not resolve to a card `
              + '(shortId or uuid) or an obligation (@id). Nothing in this batch was applied.',
          };
        }
        if (a.predicate === 'scrum:dischargedBy') {
          if (!subjObligation) {
            return {
              status: 400,
              error: `assertions[${i}]: scrum:dischargedBy takes an OBLIGATION subject (its @id); `
                + `${JSON.stringify(a.subject)} is a card. Nothing in this batch was applied.`,
            };
          }
          // ONE object kind per predicate (the registry's own convention): a person.
          // The commit that met it is scrum:evidencedBy — the relation acceptance
          // evidence already uses, so "a commit" has one encoding in this graph.
          if (typeof a.object !== 'string' || !a.object.trim() || /^[0-9a-f]{40}$/.test(a.object)) {
            return {
              status: 400,
              error: `assertions[${i}]: scrum:dischargedBy takes a PERSON key as object (got ${JSON.stringify(a.object)}); `
                + 'a commit that met an obligation is scrum:evidencedBy with a full 40-character sha. Nothing in this batch was applied.',
            };
          }
          plan.push({ kind: 'discharge', obligation: subjObligation, who: a.object.trim(), a });
          continue;
        }
        if (a.predicate === 'scrum:evidencedBy' && subjObligation) {
          if (typeof a.object !== 'string' || !/^[0-9a-f]{40}$/.test(a.object)) {
            return {
              status: 400,
              error: `assertions[${i}]: scrum:evidencedBy on an obligation takes a full 40-character lowercase git sha `
                + `as object (got ${JSON.stringify(a.object)}) — one commit is one node. Nothing in this batch was applied.`,
            };
          }
          plan.push({ kind: 'evidence', obligation: subjObligation, sha: a.object, a });
          continue;
        }
        if (subjObligation) {
          return {
            status: 400,
            error: `assertions[${i}]: ${a.predicate} takes a card subject; ${JSON.stringify(a.subject)} is an `
              + 'obligation. Nothing in this batch was applied.',
          };
        }
        const subject = data.cards[subjIdx];
        if (a.predicate === 'scrum:implementedBy') {
          if (typeof a.object !== 'string' || !/^[0-9a-f]{40}$/.test(a.object)) {
            return {
              status: 400,
              error: `assertions[${i}]: scrum:implementedBy takes a full 40-character lowercase git sha as `
                + `object (got ${JSON.stringify(a.object)}) — a short sha cannot be expanded by the graph. `
                + 'Nothing in this batch was applied.',
            };
          }
          plan.push({ kind: 'sha', subject, sha: a.object, a });
          continue;
        }
        const objIdx = findCardIndex(data, a.object);
        if (objIdx < 0) {
          return {
            status: 400,
            error: `assertions[${i}]: object ${JSON.stringify(a.object)} does not resolve to a card `
              + '(shortId or uuid). Nothing in this batch was applied.',
          };
        }
        const object = data.cards[objIdx];
        if (a.predicate === 'schema:isPartOf') plan.push({ kind: 'parent', subject, object, a });
        else if (a.predicate === 'scrum:blockedBy') plan.push({ kind: 'blockedBy', subject, object, a });
        else {
          return {
            status: 400,
            error: `assertions[${i}]: ${a.predicate} is registered but has no store mapping in this verb yet — `
              + 'assertability grows by deliberate act (see #945). Nothing in this batch was applied.',
          };
        }
      }
      // Cycle check sees the batch's OWN earlier parent assignments, in order —
      // two individually-safe assertions can compose into a cycle.
      const parentOverlay = new Map();
      for (const p of plan) {
        if (p.kind !== 'parent') continue;
        const cards = data.cards.map((c) => (parentOverlay.has(c.id) ? { ...c, parent: parentOverlay.get(c.id) } : c));
        if (reparentWouldCycle(cards, p.subject.id, p.object.id)) {
          return {
            status: 400,
            error: `asserting schema:isPartOf(${p.subject.shortId}, ${p.object.shortId}) would create a cycle — `
              + 'a card with no path to a root is invisible to every tree walk. Nothing in this batch was applied.',
          };
        }
        parentOverlay.set(p.subject.id, p.object.id);
      }

      // ── APPLY — everything validated; one mutation pass, ONE event boundary.
      const now = new Date().toISOString();
      const touched = new Map(); // card.id → card
      const obligationEvents = [];
      const results = [];
      for (const p of plan) {
        if (p.kind === 'evidence') {
          const cur = obligationsOf(data).find((e) => e['@id'] === p.obligation['@id']) ?? p.obligation;
          const list = [].concat(cur['scrum:evidencedBy'] || []);
          if (list.includes(p.sha)) { results.push(wire(p.a, 'noop')); continue; }
          const next = { ...cur, 'scrum:evidencedBy': [...list, p.sha] };
          data.obligations = obligationsOf(data).map((e) => (e['@id'] === next['@id'] ? next : e));
          obligationEvents.push(obligationEvent('update', next, by));
          results.push(wire(p.a, 'evidence-recorded'));
        } else if (p.kind === 'discharge') {
          // The FIRST closure stands. A re-closure is a noop — LOUD when it differs:
          // the caller learns what stands instead of a silence indistinguishable
          // from success (#1118 review, item 4).
          if (p.obligation['scrum:status'] !== 'open') {
            const same = p.obligation['scrum:dischargedBy'] === p.who;
            results.push({ ...wire(p.a, same ? 'noop' : 'already-closed'),
              ...(same ? {} : { existing: { dischargedBy: p.obligation['scrum:dischargedBy'], dischargedAt: p.obligation['scrum:dischargedAt'] } }) });
            continue;
          }
          const closed = { ...p.obligation, 'scrum:status': 'discharged', 'scrum:dischargedBy': p.who, 'scrum:dischargedAt': now };
          data.obligations = obligationsOf(data).map((e) => (e['@id'] === closed['@id'] ? closed : e));
          p.obligation = closed;
          obligationEvents.push(obligationEvent('update', closed, by));
          results.push(wire(p.a, 'obligation-closed'));
        } else if (p.kind === 'parent') {
          if (p.subject.parent === p.object.id) { results.push(wire(p.a, 'noop')); continue; }
          p.subject.parent = p.object.id;
          p.subject.updatedAt = now;
          touched.set(p.subject.id, p.subject);
          applyApexLabels(data.cards, p.subject.id); // #902 item 4 — reachable ⇒ labelled, by construction
          results.push(wire(p.a, 'parent-set'));
        } else if (p.kind === 'blockedBy') {
          const before = normalizeRelationships(p.subject.relationships);
          if (before.blockedBy.includes(p.object.shortId)) { results.push(wire(p.a, 'noop')); continue; }
          const after = { ...before, blockedBy: [...before.blockedBy, p.object.shortId] };
          p.subject.relationships = after;
          p.subject.updatedAt = now;
          touched.set(p.subject.id, p.subject);
          for (const t of syncInverseRelationships(data, p.subject, before, after)) touched.set(t.id, t);
          results.push(wire(p.a, 'edge-added'));
        } else if (p.kind === 'sha') {
          const list = Array.isArray(p.subject.implementedBy) ? p.subject.implementedBy : [];
          if (list.includes(p.sha)) { results.push(wire(p.a, 'noop')); continue; }
          p.subject.implementedBy = [...list, p.sha];
          p.subject.updatedAt = now;
          touched.set(p.subject.id, p.subject);
          results.push(wire(p.a, 'sha-recorded'));
        }
      }
      if (touched.size > 0 || obligationEvents.length > 0) {
        for (const c of touched.values()) bumpCardVersion(c); // #534 — the ONE version rule
        // ONE writeBoard, ONE event boundary, across node kinds.
        writeBoard(data, [...[...touched.values()].map((c) => cardEvent('update', c, by)), ...obligationEvents]);
      }
      return {
        status: 200,
        wire: { applied: results.filter((r) => r.effect !== 'noop' && r.effect !== 'already-closed').length, results },
      };
    });
    if (result.error) return sendJSON(res, result.status, { error: result.error });
    sendJSON(res, result.status, result.wire);
  } catch (e) {
    console.error('POST /api/assert:', e.message);
    sendJSON(res, 500, { error: e.message });
  }
}

function decisionsOf(data) {
  return Array.isArray(data.decisions) ? data.decisions : [];
}

// ── #1118 slice A — OBLIGATIONS: what a seat promised, as a node ────────────
// "What did I PROMISE?" had no entity kind behind it: steward roles, review-
// owed, tripwires lived in desk-stamp prose. Born in the graph (Decision
// aaf1774b): event-logged, projected, and `about` may name ANY node — a
// card, a memory, a decision, a predicate — the any-node-type shape Option D
// (aad42bf5) promised and nothing had exercised.
const OBLIGATION_ID = () => `https://scrumboard.local/obligation/${crypto.randomUUID()}`;
const OBLIGATION_KINDS = new Set(['steward', 'review', 'promise', 'tripwire']);
const OBLIGATION_CLOSES = new Set(['discharged', 'lapsed']);

function obligationsOf(data) {
  return Array.isArray(data.obligations) ? data.obligations : [];
}

const obligationEvent = (op, e, actor) => ({
  op, actor, entity: { kind: 'obligation', id: e['@id'] }, state: e,
});

function obligationToWire(e) {
  return {
    id: e['@id'], owedBy: e['scrum:owedBy'], about: e.about, kind: e['scrum:kind'],
    status: e['scrum:status'], note: e.text ?? '', createdBy: e.creator, createdAt: e.dateCreated,
    dischargedBy: e['scrum:dischargedBy'] ?? null, dischargedAt: e['scrum:dischargedAt'] ?? null,
  };
}

/**
 * Resolve a reference to a node this store holds: a card (shortId or uuid) →
 * its id; any other entity → its @id, if one exists. null means DANGLING,
 * which is refused: an obligation about nothing is prose again.
 */
function resolveNodeId(data, ref) {
  if (ref === undefined || ref === null || ref === '') return null;
  const ci = findCardIndex(data, ref);
  if (ci >= 0) return data.cards[ci].id;
  const s = String(ref);
  const pools = [decisionsOf(data), predicatesOf(data), obligationsOf(data),
    Array.isArray(data.memories) ? data.memories : []];
  for (const pool of pools) if (pool.some((e) => e && e['@id'] === s)) return s;
  return null;
}

// ── #1118 slice C — WAKES: the one time-shaped fact attached to a seat ─────
// Append-only: a wake is never edited or deleted, so "when did I last wake" is
// the newest one, and "what changed since" is changes_since(its at).
const WAKE_ID = () => `https://scrumboard.local/wake/${crypto.randomUUID()}`;
function wakesOf(data) {
  return Array.isArray(data.wakes) ? data.wakes : [];
}
const wakeEvent = (e, actor) => ({ op: 'create', actor, entity: { kind: 'wake', id: e['@id'] }, state: e });
const wakeToWire = (e) => ({ id: e['@id'], seat: e['scrum:wokeSeat'], at: e['scrum:wokeAt'], note: e.text ?? '' });

async function handleCreateWake(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : null;
    if (!by) return sendJSON(res, 400, { error: 'by is required — the seat that woke. Declared, not authenticated.' });
    const result = await withWriteLock(async () => {
      const data = readBoard();
      const entity = {
        '@id': WAKE_ID(), '@type': 'scrum:Wake',
        'scrum:wokeSeat': by, 'scrum:wokeAt': new Date().toISOString(),
        text: typeof body.note === 'string' ? body.note : '',
      };
      data.wakes = [...wakesOf(data), entity];
      writeBoard(data, [wakeEvent(entity, by)]);
      return { status: 201, wire: wakeToWire(entity) };
    });
    sendJSON(res, result.status, result.wire);
  } catch (e) {
    console.error('POST /api/wakes:', e.message);
    sendJSON(res, 500, { error: e.message });
  }
}

function handleListWakes(req, res) {
  const q = parseQuery(req.url);
  let out = wakesOf(readBoard()).map(wakeToWire).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)); // newest first
  if (q.seat) out = out.filter((w) => w.seat === q.seat);
  const limit = Number.parseInt(q.limit, 10);
  if (Number.isInteger(limit) && limit > 0) out = out.slice(0, limit);
  sendJSON(res, 200, out);
}

async function handleCreateObligation(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : null;
    if (!by) return sendJSON(res, 400, { error: 'by is required — who records this obligation. Declared, not authenticated.' });
    const owedBy = typeof body.owedBy === 'string' && body.owedBy.trim() ? body.owedBy.trim() : null;
    if (!owedBy) return sendJSON(res, 400, { error: 'owedBy is required — the seat that owes this. One debtor per obligation; joint obligations are N separate ones.' });
    if (!OBLIGATION_KINDS.has(body.kind)) {
      return sendJSON(res, 400, { error: `kind must be one of steward | review | promise | tripwire (got ${JSON.stringify(body.kind)})` });
    }
    const result = await withWriteLock(async () => {
      const data = readBoard();
      const about = resolveNodeId(data, body.about);
      if (!about) {
        return { status: 400, wire: { error: `about ${JSON.stringify(body.about)} does not resolve to a node this board holds (card shortId/uuid, or the @id of a memory, decision, predicate or obligation). An obligation about nothing is refused.` } };
      }
      const now = new Date().toISOString();
      const entity = {
        '@id': OBLIGATION_ID(), '@type': 'scrum:Obligation',
        'scrum:owedBy': owedBy, about, 'scrum:kind': body.kind, 'scrum:status': 'open',
        text: typeof body.note === 'string' ? body.note : '',
        creator: by, dateCreated: now,
      };
      data.obligations = [...obligationsOf(data), entity];
      writeBoard(data, [obligationEvent('create', entity, by)]);
      return { status: 201, wire: obligationToWire(entity) };
    });
    sendJSON(res, result.status, result.wire);
  } catch (e) {
    console.error('POST /api/obligations:', e.message);
    sendJSON(res, 500, { error: e.message });
  }
}

function handleListObligations(req, res) {
  const q = parseQuery(req.url);
  let out = obligationsOf(readBoard()).map(obligationToWire);
  // Every filter is an exact match; a holder with nothing is an EMPTY LIST.
  if (q.owedBy) out = out.filter((o) => o.owedBy === q.owedBy);
  if (q.status) out = out.filter((o) => o.status === q.status);
  if (q.about) out = out.filter((o) => o.about === q.about);
  if (q.kind) out = out.filter((o) => o.kind === q.kind);
  sendJSON(res, 200, out);
}

async function handleUpdateObligation(req, res, rawId) {
  try {
    const id = decodeURIComponent(rawId);
    const body = JSON.parse(await readBody(req));
    const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : null;
    if (!by) return sendJSON(res, 400, { error: 'by is required — who closes this obligation. Declared, not authenticated.' });
    if (!OBLIGATION_CLOSES.has(body.status)) {
      return sendJSON(res, 400, { error: `status must be discharged or lapsed (got ${JSON.stringify(body.status)}) — an obligation closes; it does not reopen. Record a new one instead.` });
    }
    const result = await withWriteLock(async () => {
      const data = readBoard();
      const existing = obligationsOf(data).find((e) => e['@id'] === id);
      if (!existing) return { status: 404, wire: { error: `no obligation ${id}` } };
      // Already closed: the FIRST closure stands. A second is a noop, not an overwrite.
      if (existing['scrum:status'] !== 'open') return { status: 200, wire: obligationToWire(existing) };
      // An explicit dischargedAt records a closure learned about LATER; without
      // one, a backfilled row would carry a plausible, false "now" (#1118 review).
      let when = new Date().toISOString();
      if (body.dischargedAt !== undefined) {
        const t = new Date(String(body.dischargedAt));
        if (Number.isNaN(t.getTime())) return { status: 400, wire: { error: `dischargedAt must be an ISO-8601 timestamp (got ${JSON.stringify(body.dischargedAt)})` } };
        when = t.toISOString();
      }
      const closed = {
        ...existing, 'scrum:status': body.status, 'scrum:dischargedBy': by, 'scrum:dischargedAt': when,
        ...(typeof body.note === 'string' && body.note.trim() ? { text: `${existing.text ? existing.text + '\n' : ''}${body.note.trim()}` } : {}),
      };
      data.obligations = obligationsOf(data).map((e) => (e['@id'] === id ? closed : e));
      writeBoard(data, [obligationEvent('update', closed, by)]);
      return { status: 200, wire: obligationToWire(closed) };
    });
    sendJSON(res, result.status, result.wire);
  } catch (e) {
    console.error('PATCH /api/obligations:', e.message);
    sendJSON(res, 500, { error: e.message });
  }
}

const decisionEvent = (op, d, actor = null) => ({
  op, actor, entity: { kind: 'decision', id: d['@id'] }, state: d,
});

function decisionToWire(e) {
  return {
    id: e.identifier,
    statement: e['scrum:statement'],
    decidedBy: e['scrum:decidedBy'],
    constrains: [].concat(e['scrum:constrains'] || []),
    reopensIf: e['scrum:reopensIf'],
    decidedAt: e.dateCreated,
  };
}

/** @returns {string|null} an error message, or null if the payload is sound. */
function validateDecision(b) {
  if (typeof b.statement !== 'string' || !b.statement.trim()) return 'statement is required';
  const who = b.decidedBy || b.by;
  if (typeof who !== 'string' || !who.trim()) {
    return 'decidedBy is required — a ruling with no decider cannot be weighed by whoever inherits it';
  }
  if (!Array.isArray(b.constrains) || b.constrains.length === 0) {
    return 'constrains must be a non-empty array of topics — a decision that constrains nothing is '
         + 'invisible to the only query this type exists for, and would be found by nobody who needed it';
  }
  if (b.constrains.some((t) => typeof t !== 'string' || !t.trim())) {
    return 'each entry in constrains must be a non-empty topic string';
  }
  // ⇒ REQUIRED, deliberately. An optional field on a write path this room uses
  // will be omitted, and a decision nobody can overturn is an opinion with a
  // timestamp on it.
  if (typeof b.reopensIf !== 'string' || !b.reopensIf.trim()) {
    return 'reopensIf is required — what evidence would overturn this? A ruling without one is '
         + 'either re-argued from scratch later or obeyed superstitiously, and both have happened here';
  }
  return null;
}

async function handleCreateDecision(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const err = validateDecision(body);
    if (err) return sendJSON(res, 400, { error: err });
    const created = await withWriteLock(async () => {
      const data = readBoard();
      const id = crypto.randomUUID();
      const entity = {
        '@id': DECISION_ID(id), '@type': 'scrum:Decision',
        identifier: id,
        'scrum:statement': String(body.statement),
        'scrum:decidedBy': body.decidedBy || body.by,
        'scrum:constrains': [...body.constrains],
        'scrum:reopensIf': String(body.reopensIf),
        dateCreated: new Date().toISOString(),
      };
      data.decisions = [...decisionsOf(data), entity];
      writeBoard(data, [decisionEvent('create', entity, body.decidedBy || body.by)]);
      return decisionToWire(entity);
    });
    sendJSON(res, 201, created);
  } catch (e) {
    console.error('POST /api/decisions:', e.message);
    sendJSON(res, 500, { error: e.message });
  }
}

function handleListDecisions(req, res) {
  const q = parseQuery(req.url);
  let out = decisionsOf(readBoard())
    .filter((e) => e['@type'] === 'scrum:Decision')
    .map(decisionToWire);
  // ⚠️ An unknown topic returns an EMPTY LIST, never an error. "Nothing
  // constrains this" is the common and correct answer for most topics, and a
  // reader who meets a failure there learns to distrust the empty case and
  // stops asking.
  if (q.constrains) out = out.filter((d) => d.constrains.includes(q.constrains));
  if (q.decidedBy) out = out.filter((d) => d.decidedBy === q.decidedBy);
  sendJSON(res, 200, out);
}

// ── #801 — the retrieval miss log, made durable ──────────────────────────────
//
// #801 proposed a VOLUNTARY log (a card, comments, no code) because "automatic
// capture is NOT available", and named its own falsification: "if this card has
// zero entries in a week, the voluntary mechanism failed and THAT is the
// finding." Measured 2026-08-18: twelve entries, ALL dated 2026-08-13, none in
// the five days since. Not the zero it predicted — it fired once while everyone
// was watching and never again, which is the rail-that-fires-on-remembering
// class decaying exactly as that class does.
//
// ⭐ And the automatic capture it said was unavailable had already shipped one
// endpoint over. This makes it durable and queryable instead of stderr-only.
const MISS_LOG_FILE = BOARD_DATA_FILE.replace(/\.json$/, '') + '-misses.jsonl';

function recordMisses(params, seat, url) {
  const at = new Date().toISOString();
  try {
    const lines = params.map((param) => JSON.stringify({ at, seat, param, url })).join('\n') + '\n';
    fs.appendFileSync(MISS_LOG_FILE, lines);
  } catch (e) {
    // ⚠️ NEVER let bookkeeping break the request that produced it. The caller
    // asked for cards; failing their query because we could not write a note
    // about it would be a strictly worse board. Named on stderr so a broken
    // recorder is visible rather than silently producing an empty roadmap.
    console.error(`${new Date().toISOString()} miss-log: could not record (${e.message})`);
  }
}

/**
 * #801 — GET /api/misses. What seats asked this board for and did not get.
 *
 * ⚠️ THE POPULATION IS NAMED IN THE PAYLOAD, not left to the reader. This sees
 * only misses that ARRIVED AT THE DOOR. A seat who reaches for `grep` — which
 * is the population #801's whole argument was about — is invisible here, so a
 * low number must never be read as "few misses". It means "few misses of the
 * kind we can see".
 */
function handleMisses(req, res) {
  let rows = [];
  try {
    if (fs.existsSync(MISS_LOG_FILE)) {
      rows = fs.readFileSync(MISS_LOG_FILE, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    }
  } catch (e) {
    return sendJSON(res, 500, { error: `miss log unreadable: ${e.message}` });
  }

  // ⭐ A LIST, NOT A NUMBER. A count of misses is a vibes number; the ranked
  // params — with the seats who wanted each — are the actionable thing, and are
  // literally the roadmap the emitting comment already claimed to be.
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.param)) by.set(r.param, { param: r.param, count: 0, seats: new Set() });
    const e = by.get(r.param);
    e.count += 1;
    if (r.seat) e.seats.add(r.seat);
  }
  // #801 — AN ANSWERED NEED MUST STOP ASSERTING ITSELF.
  //
  // Found on prod minutes after #656 shipped `q`: the log went on listing `q` as
  // a want, because it is append-only and history does not retract itself. That
  // turns the roadmap into a perishable claim — true when recorded, false once
  // built, with nothing marking the difference — and a reader planning from it
  // would build the same thing twice.
  //
  // ⚠️ Deleting those rows would be the wrong fix: it destroys the evidence that
  // the need was real and that answering it took as long as it did. The RECORD
  // stays; its STATUS changes, decided against the live param set rather than
  // against a hand-maintained list that would rot the same way.
  const byParam = [...by.values()]
    .map((e) => ({
      param: e.param, count: e.count, seats: [...e.seats].sort(),
      answered: CARD_LIST_PARAMS.has(e.param),
    }))
    .sort((a, b) => Number(a.answered) - Number(b.answered)
      || b.count - a.count || a.param.localeCompare(b.param));

  sendJSON(res, 200, {
    total: rows.length,
    // The headline is OPEN needs. `total` counts all history, which is the
    // number that quietly stops meaning anything as the log ages.
    open: byParam.filter((p) => !p.answered).reduce((n, p) => n + p.count, 0),
    answered: byParam.filter((p) => p.answered).reduce((n, p) => n + p.count, 0),
    byParam,
    covers: 'retrieval needs that ARRIVED AT THE DOOR — a seat asked this board for '
      + 'something it could not serve, recorded at the moment of the ask',
    blindTo: 'a seat who wanted something and reached for grep, git, a file read or another '
      + 'tool without asking the board at all. That population is unmeasured here and is the '
      + 'one #801 was originally about.',
    misses: rows.slice(-200),
  });
}

/**
 * #880/#857 §VI — STANDING CHECKS: corpus-scale claims nobody authored.
 *
 * #792's tripwires are per-card and AUTHORED — a seat writes a claim and the
 * query that would falsify it. That cannot see a claim held by an EDGE, and it
 * cannot see a claim nobody thought to write down.
 *
 *   `#439 blockedBy #438`  and  `#438 is done`
 *
 * Both facts true, structural, stored. Together they say the board is asserting
 * a block that cannot block anything — and NOTHING changed on #439 when #438
 * shipped, so there is no diff for a reviewer to catch.
 *
 * ⛔ WHY A QUERY AND NOT A HABIT, measured 2026-08-18: a careful manual tidy
 * pass, run by the room's most careful seat while specifically looking for this,
 * found FOUR and missed FIVE. Nine pairs across 795 cards is not something a
 * person reads their way to.
 *
 * ⚠️ EVERY STANDING CHECK MUST BE TIER-A SHAPED (#824): both facts structural,
 * the finding unambiguous, actionable by one write. "This card looks stale" is
 * not admissible; "this card declares a block on a card that is done" is —
 * because #824's rule is that a check which always fires trains the room to
 * dismiss the instrument inside a week, taking the working ones with it.
 *
 * ⚠️ AND IT IS A PUBLIC UNKNOWN, NEVER AN ACCUSATION. The edge was TRUE when it
 * was written. The payload says what it found and publishes the query so the
 * reader can re-run it; it does not say anyone was negligent.
 */
const STANDING_CHECKS = [
  {
    id: 'phantom-block',
    // ⛔⛔ #895 — THE CLAIM AND THE QUERY WERE TWO HALVES OF ONE RULE AND ONLY
    // ONE HALF WAS IN CODE. (Found by a peer seat; landed here because this file
    // was already open for #881, and the subject is the same: blockedBy semantics.)
    //
    // The claim said "nothing changed on the blocked card when the blocker
    // shipped". The query never constrained the blocked card's column, so it
    // could not possibly know that. Measured: all 5 rows it reported had a
    // blocked card that was ALSO done — the blocked cards HAD changed, they
    // shipped too. Zero of 5 were actionable, and the severity came entirely
    // from the claim's framing rather than from the rows.
    //
    // ⚠️ THE FIX IS A FILTER, NOT A CLEANUP. A blockedBy edge between two
    // finished cards is a true record of something that was once true; deleting
    // those edges to quiet the instrument would destroy history to make a
    // number look better. The instrument was wrong, not the data.
    //
    // ⭐ AND THE NARROWED POPULATION IS A REAL ZERO, checked before narrowing:
    // 4 open cards currently carry blockedBy edges, so this can still fire. A
    // filter that made the check unsatisfiable would be worse than the false
    // positives it removed — see R4, and `scored()` refusing an empty
    // denominator for the same reason.
    claim: 'an OPEN card declares blockedBy a card that is already done — the block cannot block '
      + 'anything, and the blocked card has not moved even though its blocker shipped',
    // #1112 item 1 — AND the room has not already HANDLED it. A blocker entry
    // with status "cleared" is the card saying "this block is dealt with, here
    // is the note" (#814 projects it as a scrum:Blocker node). Without this
    // clause the check fired forever on handled blocks — measured 2026-08-30:
    // five rows, every one carrying a cleared entry with a citation, still
    // reported. #824's rule again: an instrument that keeps firing after the
    // room acts gets dismissed, taking the real findings with it. The EDGE
    // stays (history); the ENTRY is what records the handling; the check reads
    // the entry.
    query: 'SELECT ?blocked ?blocker WHERE { ?a scrum:blockedBy ?b ; schema:identifier ?blocked ; '
      + 'scrum:column ?col . FILTER(?col != <https://scrumboard.local/column/done>) '
      + '?b schema:identifier ?blocker ; scrum:column <https://scrumboard.local/column/done> '
      + 'FILTER NOT EXISTS { ?bl scrum:blocks ?a ; scrum:blockedByCard ?b ; scrum:status "cleared" } }',
  },
];

// ── #902 — WHAT A CHECK ACTUALLY LOOKS AT ────────────────────────────────────
//
// `stale: 0` reads identically whether a claim is watched by a real measurement
// or by a proxy for someone's judgement, and the payload could not tell them
// apart. Measured 2026-08-19 across the live board:
//
//   ASK { ?a a prov:Activity ; scrum:shortId ?s }     a capability, in the store
//   ASK { ?c schema:identifier "858" ; scrum:column column:done }
//                                                     a CARD's state — a proxy for
//                                                     the same human judgement that
//                                                     rotted #857 five times
//   ASK { ?c schema:identifier "894" }                fires only if the card is DELETED
//   ASK { ?c a schema:CreativeWork }                  ⛔ CANNOT FAIL while any card
//                                                     exists. A green that is green
//                                                     by construction.
//
// ⭐ THIS REPORTS EVIDENCE, NOT A VERDICT. It lists the predicates each ASK
// references and derives nothing about whether the check is "good" — a classifier
// invented here would be one more judgement smuggled into a mechanical-looking
// half, which is the defect this room spent 2026-08-18 naming. The reader
// classifies; the payload just stops hiding what there is to classify.
//
// ⚠️ SYNTACTIC, and therefore fallible: it reads the query text, so an ASK that
// reaches card state through an unusual spelling will not be flagged. It raises
// the floor and closes nothing.
const CARD_IDENTITY_PREDICATES = new Set([
  'schema:identifier', 'scrum:column', 'scrum:claimedBy', 'scrum:priority',
  'scrum:cardType', 'scrum:assignee', 'rdf:type', 'a',
]);

function describeAsk(ask) {
  const text = String(ask || '');
  // Prefixed names (`scrum:column`) and the bare type shorthand `a`.
  const prefixed = text.match(/\b[a-z]+:[A-Za-z][A-Za-z0-9_]*/g) || [];
  // Full IRIs in angle brackets — column:done is often written out longhand.
  const iris = (text.match(/<[^>]+>/g) || []).map((s) => s.replace(/^<|>$/g, ''));
  const predicates = [...new Set(prefixed)].sort();
  const looksLikeType = /\{\s*\?\w+\s+a\s+[a-z]+:[A-Za-z]/.test(text);
  // ⛔ A WILDCARD PREDICATE IS THE OPPOSITE OF CARD-IDENTITY, and the first
  // version of this got it exactly backwards. `ASK { ?s ?p ?o . FILTER(...) }`
  // names NO predicates, so "everything it names is card identity" is VACUOUSLY
  // true — and #901/#902's whisper checks, which scan the whole graph, were
  // flagged as proxies. Caught by running against the live board; the fixture
  // could never have shown it, because nobody writes a wildcard ASK in a fixture.
  const wildcardPredicate = /\?\w+\s+\?\w+\s+\?\w+/.test(text);
  // Does every prefixed name it uses belong to card identity? If so the check
  // cannot see a capability — only whether a card exists or where it sits.
  const nonIdentity = predicates.filter((p) => !CARD_IDENTITY_PREDICATES.has(p)
    && !p.startsWith('column:') && !p.startsWith('entity:') && !p.startsWith('person:'));
  return {
    predicates,
    iris: iris.length ? iris : undefined,
    // TRUE when nothing outside card identity is referenced. Named for what was
    // measured, not for a verdict about the check's worth.
    referencesOnlyCardIdentity: !wildcardPredicate
      && nonIdentity.length === 0 && (predicates.length > 0 || looksLikeType),
  };
}

async function handleChecks(req, res) {
  try {
    // #949 (scope extension) — a VERDICT surface needs currency more than a
    // query surface does. A seat reading /api/graph re-runs a surprising number;
    // "this tripwire holds" and "this card is ready" get BELIEVED.
    const { store, projectedThrough } = await warmGraphStore();
    const { queryGraph } = await loadGraphModules();
    const data = readBoard();
    const results = [];
    let stale = 0, errors = 0, watched = 0, unwatched = 0;
    // #902 — how many armed checks can only see card identity, never a capability.
    let identityOnly = 0, checksTotal = 0;
    // #857 §VI — the unwatched COUNT is not actionable. `793` is
    // indistinguishable from 793 typo reports, and this room has now had to
    // convert a number into a list four times in one day (npm audit's "0",
    // isolation's "45%", the 475 actorless activities, and this).
    //
    // `unwatchedByType` is the distribution — the shape, before anyone pays for
    // rows (#629's count-then-refine). `unwatchedGoals` is the actual list, and
    // ONLY for goals: it is the type this room plans from (#857/#858/#859 are
    // all goals), the smallest type on the board, and the case that has already
    // bitten — §IV rotted four times, and Phase 2 closed on a corpus claim that
    // had gone stale by growth.
    //
    // ⚠️ Bounding the list to goals is a JUDGEMENT about where to start, not a
    // claim that other types need no watching. The note below says so, because
    // an empty `unwatchedGoals` beside a large `cardsUnwatched` is exactly the
    // kind of flattering half-answer this endpoint exists to refuse.
    const unwatchedByType = {};
    const unwatchedGoals = [];

    for (const card of data.cards || []) {
      const checks = Array.isArray(card.checks) ? card.checks : [];
      if (!checks.length) {
        unwatched += 1;
        const type = card.type || 'untyped';
        unwatchedByType[type] = (unwatchedByType[type] || 0) + 1;
        if (type === 'goal') unwatchedGoals.push({ shortId: card.shortId, title: card.title });
        continue;
      }
      watched += 1;
      const evaluated = checks.map((c) => {
        checksTotal += 1;
        try {
          const r = queryGraph(store, c.ask);
          // ⚠️ The ASK boolean arrives as `ask`, NOT `boolean` — read from
          // core/graph-replica.mjs rather than assumed. The first version of
          // this line guessed `.boolean`, which is always undefined, so every
          // check would have reported `error` and the endpoint would have looked
          // like it was working while measuring nothing. Anything non-boolean
          // means the shape moved and must be an error, never a coerced guess.
          const got = r.ask;
          if (typeof got !== 'boolean') {
            errors += 1;
            return { claim: c.claim, status: 'error', error: 'ASK did not return a boolean' };
          }
          const holds = got === c.expect;
          if (!holds) stale += 1;
          // #902 — what this check LOOKS AT, beside what it answered.
          const looks = describeAsk(c.ask);
          if (looks.referencesOnlyCardIdentity) identityOnly += 1;
          return {
            claim: c.claim, status: holds ? 'holds' : 'stale', expected: c.expect, actual: got,
            looksAt: looks,
          };
        } catch (e) {
          errors += 1;
          return { claim: c.claim, status: 'error', error: e?.message || String(e) };
        }
      });
      results.push({ shortId: card.shortId, title: card.title, checks: evaluated });
    }

    // #880 — the standing checks, run over the corpus rather than per card.
    // Kept in their own array: `results` answers "which claims did a seat write a
    // tripwire for?" and `standing` answers "which claims does the SYSTEM check
    // because nobody would think to". Summing them would make `stale` mean two
    // things at once, which is the confusion this endpoint exists to refuse.
    const standing = STANDING_CHECKS.map((c) => {
      try {
        const r = queryGraph(store, c.query);
        return { id: c.id, claim: c.claim, query: c.query, rows: r.rows ?? [] };
      } catch (e) {
        // An error is NOT an empty result. A standing check that cannot run must
        // never read as "nothing found" — the #792 lesson, on a second surface.
        return { id: c.id, claim: c.claim, query: c.query, error: e?.message || String(e) };
      }
    });

    // ⛔⛔ #896 — DOES EVERY SHA ON THE BOARD NAME A REAL COMMIT?
    //
    // Its own population and its own mechanism, so it sits beside `standing`
    // rather than inside it: standing checks are SPARQL over the replica, this
    // one shells out to git. Summing them would make one number mean two things,
    // which is the confusion this endpoint exists to refuse.
    //
    // ⚠️ NOT A WRITE-PATH VALIDATOR, and the difference was measured: the server
    // serves from the DEPLOY clone, and the real order is commit → push → write
    // the card → then pull and deploy. At write time the serving clone does not
    // have the object, so resolving on write would refuse legitimate shas for a
    // reason their author cannot act on. A rail whose failure mode is "the board
    // stops accepting truth" is worse than the defect it prevents.
    const shaIntegrity = await verifyShaIntegrity(data, {
      // ⭐ ONE process for the whole population. `--batch-check` reads every sha
      // on stdin and answers per line, so a 264-sha board costs one spawn rather
      // than 264 on an endpoint anyone can hit.
      resolve: async (shas) => {
        const { execFile } = await import('node:child_process');
        const out = await new Promise((ok, bad) => {
          const child = execFile('git', ['cat-file', '--batch-check'], { cwd: PROJECT_DIR, maxBuffer: 8 << 20 },
            (err, stdout) => (err ? bad(err) : ok(stdout)));
          child.stdin.end(shas.join('\n') + '\n');
        });
        const live = new Set();
        for (const line of out.split('\n')) {
          // "<sha> commit <size>" for a real object; "<sha> missing" otherwise.
          const [sha, kind] = line.trim().split(/\s+/);
          if (sha && kind === 'commit') live.add(sha);
        }
        return live;
      },
    });

    sendJSON(res, 200, {
      // #949 — WHICH STORE STATE THESE VERDICTS DESCRIBE. `stale: 0` computed
      // from a lagging projection is a true statement about the wrong board.
      watermark: graphWatermark(projectedThrough),
      cardsWatched: watched,
      cardsUnwatched: unwatched,
      // #902 — of the checks that ARE armed, how many can only see card identity
      // (does this card exist / where does it sit) rather than a capability in the
      // store? A high ratio means `stale: 0` is mostly reporting on the same human
      // judgement that authored the cards, not on the system.
      checksTotal,
      checksReferencingOnlyCardIdentity: identityOnly,
      shaIntegrity,
      unwatchedByType,
      unwatchedGoals,
      standing,
      stale,
      errors,
      // Stated in the payload rather than assumed by the reader: this counts
      // claims whose author wrote a tripwire. It says nothing about the rest.
      note: 'stale means an authored tripwire answered unexpectedly — a prompt to look, not a verdict. '
        + 'cardsUnwatched carry no checks and are therefore unmeasured, not passing. '
        + 'unwatchedByType covers ALL of them; unwatchedGoals is the named LIST for goal '
        + 'cards only — the type this board plans from. An empty unwatchedGoals means no '
        + 'GOAL is unwatched, never that the gap is closed: read cardsUnwatched for that. '
        + 'standing[] is a DIFFERENT population: corpus-scale claims the system checks '
        + 'because nobody authored a tripwire for them (an edge cannot author one). Its '
        + 'findings are public unknowns, not accusations — each publishes its query so you '
        + 'can re-run it, and each is counted separately from stale. '
        + 'shaIntegrity is a THIRD population and a different mechanism: it asks git whether '
        + 'every commit sha on the board resolves. It reports UNMEASURABLE rather than zero '
        + 'when the repository cannot be read, because "no fabrications found" and "I could '
        + 'not look" are otherwise identical — and it names what it cannot see, since this '
        + 'runs on the deploy clone and a freshly-pushed commit legitimately reads as missing.',
      results,
    });
  } catch (e) {
    if (e?.code === 'GRAPH_DEPS_MISSING') return sendJSON(res, 503, { error: e.message, code: e.code });
    console.error('GET /api/checks:', e.message);
    sendJSON(res, 500, { error: e.message });
  }
}

async function handleReady(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const { readyFromStore, pageReady, READY_EXPLAIN } = await loadGraphModules();
    // #949 (scope extension) — see the note on /api/checks. A readiness verdict
    // is acted on, not re-run.
    const { store, projectedThrough } = await warmGraphStore();
    // Verdicts are computed COMPLETE; explain consults them unpaged (a ready
    // card past the page window must answer ready, not 404 — bb2ccee6) and
    // the queue response pages both lists.
    const verdicts = readyFromStore(store);
    const explain = url.searchParams.get('explain');
    // #949 — BOTH exits carry it. A currency statement on one of two paths is
    // the shape this board keeps finding: correct, and blind on the route
    // nobody checked.
    const watermark = graphWatermark(projectedThrough);
    if (explain != null && explain !== '') {
      return sendJSON(res, 200, { ...READY_EXPLAIN(verdicts, explain), watermark });
    }
    sendJSON(res, 200, { ...pageReady(verdicts, { limit: url.searchParams.get('limit') ?? undefined }), watermark });
  } catch (e) {
    if (e.code === 'GRAPH_DEPS_MISSING') return sendJSON(res, 503, { error: e.message, code: e.code });
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
  // #792 — a claim can carry the measurement that would falsify it. Listed here
  // as well as in the validator and the constructor because a field present in
  // only two of the three is accepted with a 201 and silently dropped (#831).
  'checks',
  // #814 — blocker ownership. ⚠️ THIS LINE WAS MISSING and the field was
  // validated, stored, and still reported in `ignoredFields`: CONSUMED_UNDECLARED,
  // the #830/#856 shape. Both of my earlier edits landed in PATCHABLE_CARD_FIELDS
  // and neither reached here. Caught by #831's sweep, not by review.
  'blockers',
  'acceptance',   // #814 — on BOTH lists in one edit, having got this wrong once already
  // #254 — containment at birth. ⚠️ AND THE SWEEP CAUGHT ME THE SAME WAY IT
  // caught `blockers` above: I added the consume step in createCardFromPayload
  // and not this line, so the field was stored AND reported in `ignoredFields`
  // — CONSUMED_UNDECLARED, a caller told the opposite of what happened. Third
  // recorded instance of one edit landing on one list; the note two entries up
  // says "caught by #831's sweep, not by review", and that held again.
  'parent',
  // #862 — `by` is the word every OTHER surface uses for "who is doing this":
  // PATCH takes it, and /api/changes emits the event log's `actor` under that
  // name. Create took only `createdBy`, so a caller who learned `by` from the
  // update route was recorded as null here — and #631 makes `createdBy`
  // immutable, so that was permanent rather than repairable. Three cards from
  // 2026-08-18 carry it, including #857, the apex card arguing this board is
  // the room's record. Accepting the alias costs nothing and closes the trap.
  'by',
]);

/**
 * #862 — the author a create request DECLARES, under either spelling.
 *
 * `createdBy` first, then `by`. Neither is authenticated; both are the caller's
 * claim about itself, recorded as given. A blank or non-string value declares
 * nothing and yields null, which is the honest answer — see #631.
 */
function declaredAuthor(body) {
  for (const k of ['createdBy', 'by']) {
    const v = body?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** Keys the caller sent that create will silently drop. Empty when clean. */
function unconsumedCreateFields(body) {
  if (typeof body !== 'object' || body === null) return [];
  return Object.keys(body).filter((k) => !CREATE_CONSUMED_FIELDS.has(k));
}

/**
 * #917 — RESOLVE the parent to a canonical card id, or refuse.
 *
 * ⛔ THE DEFECT THIS CLOSES, shipped in #254 and found by a colleague using the
 * feature for its purpose twenty minutes later:
 *
 *     parent: "857"  →  stored verbatim  →  graph edge to `entity:857`
 *     the real #857  →  `entity:e5c3ad70-…`, 104 triples
 *     COUNT { <entity:857> ?p ?o }  →  0
 *
 * The write returned 200, `card_get` echoed the parent back, and only the
 * traversal disagreed. ⇒ ***It fails in the direction that looks like success***:
 * 120 membership assertions would give 120 green writes and a traversal still
 * returning zero, and the natural conclusion would be that the TRAVERSAL is
 * broken — the one part that is fine.
 *
 * ⚠️ Every other id-taking route in this API accepts id-or-shortId, so a seat
 * reaching for a shortId is following the house convention, not misusing it.
 * The fix is to honour that convention here rather than to forbid it.
 *
 * @returns {{ok: true, id: string|null} | {ok: false, error: string}}
 */
function resolveParentValue(data, value) {
  // `null` means "make this a root" and must not be dragged into the resolver
  // and refused as "a card that does not exist".
  if (value == null || value === '') return { ok: true, id: null };
  const idx = findCardIndex(data, value);
  if (idx < 0) {
    return {
      ok: false,
      error: `parent names no card: ${JSON.stringify(value)}. `
           + 'Pass a card id or shortId that exists — an unresolvable parent used to be '
           + 'stored verbatim and became a graph edge to a node with no triples (#917).',
    };
  }
  return { ok: true, id: data.cards[idx].id };
}

// #534 — THE card version rule, in ONE place. Six call sites share it, and they
// must share the RULE and not merely the field name: a token maintained by only
// some write paths is worse than no token, because the precondition built on it
// then reports "guarded" while providing nothing.
//
// Monotonic, server-controlled, and never read from a caller. A card with no
// version is treated as 0 ONLY here, at the moment it gains one — never as a
// value a comparison may trust.
function bumpCardVersion(card) {
  const current = Number.isInteger(card.version) && card.version >= 0 ? card.version : 0;
  card.version = current + 1;
  return card.version;
}

// #534/#466 — cardContentKey lives in core/card-content-key.mjs so the browser
// and this handler answer "did this card change?" with ONE definition.

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
    // #534 — a card is born WITH a version, so no card is ever 'absent'
    // and therefore never readable as 0 by a later comparison.
    version: 1,
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
    // #862 — `createdBy` OR `by`, and the precedence is pinned rather than
    // incidental: `createdBy` is this route's native field and wins when both
    // are sent, so the stored author cannot depend on JSON key order. (Same
    // reasoning as #831's assignees/assignee precedence, and the same failure
    // it prevents: a result that changes with the shape of the request.)
    //
    // ⚠️ Declaring NOTHING still stores null. This is an alias, not a backfill —
    // the trust model is DECLARED, not authenticated, and inventing an
    // attribution is worse than lacking one.
    createdBy: declaredAuthor(body),
    // #254 — THE CONSUME STEP, and it is the same omission #830 and #856 both
    // were. `parent` was writable on card PATCH and on the /api/nodes routes,
    // and silently dropped here — so a card could be reparented after birth but
    // never born nested. Exposing `parent` on the MCP create schema without this
    // would have been validated-then-discarded on a third surface in one file.
    //
    // ⚠️ No cycle check is needed at CREATE and its absence is deliberate: a card
    // that does not exist yet cannot be any card's ancestor, so the only edge it
    // can add is a leaf. The guard belongs on PATCH, where a subtree can move.
    ...(typeof body.parent === 'string' ? { parent: body.parent } : {}),
    relationships: normalizeRelationships(body.relationships),
    // #830 — a card may be born knowing what implemented it. Retroactive cards
    // (work shipped before it was filed) carry the sha at creation, and the
    // two-call shape was friction with no benefit. The 40-char sha rule already
    // runs in validateCardFields on this route — only the consume step was
    // missing, which is why the field validated and then evaporated.
    ...(Array.isArray(body.implementedBy) ? { implementedBy: body.implementedBy } : {}),
    // #792 — the CONSUME step. #830 and #856 were both "validated, then
    // evaporated" because exactly this line was missing while the schema and
    // the validator already knew the field.
    ...(Array.isArray(body.checks) ? { checks: body.checks } : {}),
    ...(Array.isArray(body.blockers) ? { blockers: body.blockers } : {}),
    ...(Array.isArray(body.acceptance) ? { acceptance: body.acceptance } : {}),
    // #348 — coordination rail: first-write-wins claim, server-arbitrated.
    // Set only via POST /api/cards/:id/claim (never via PATCH), so a claim
    // is a compare-and-set under withWriteLock, not an unconditional overwrite.
    claimedBy: null,
    claimedAt: null,
  };
}

/**
 * #814 — ACCEPTANCE EVIDENCE: which durable result discharged which release
 * condition.
 *
 * ⛔ EVIDENCE MUST BE DURABLE AND RESOLVABLE-SHAPED — a 40-char commit sha or an
 * entity uuid, never a sentence. "The tests passed" is precisely the prose this
 * field replaces, and accepting it would relocate the narration rather than
 * model the fact.
 *
 * ⚠️ This rule is the BF4 lesson generalised. `implementedBy` validated LENGTH
 * and not existence, so a real short sha padded to forty was accepted exactly as
 * readily as a real one — three reached production, and the guard had SELECTED
 * for the defect by refusing the honest short form. Evidence has the same
 * failure mode and a worse consequence: it is the record that a condition
 * was MET.
 */
const EVIDENCE_SHA = /^[0-9a-f]{40}$/;
const EVIDENCE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateAcceptance(acceptance) {
  if (!Array.isArray(acceptance)) return 'acceptance must be an array of {condition, evidence}';
  for (const a of acceptance) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return 'each acceptance entry must be an object {condition, evidence}';
    if (typeof a.condition !== 'string' || !a.condition.trim()) {
      return 'each acceptance entry needs a `condition`: evidence for nothing is not evidence';
    }
    if (a.evidence !== undefined && !Array.isArray(a.evidence)) {
      return `acceptance ${JSON.stringify(a.condition)}: evidence must be an array of durable references`;
    }
    for (const e of a.evidence || []) {
      if (typeof e !== 'string' || (!EVIDENCE_SHA.test(e) && !EVIDENCE_UUID.test(e))) {
        return `acceptance ${JSON.stringify(a.condition)}: evidence ${JSON.stringify(e)} is not a durable `
          + 'reference. Use a full 40-character commit sha or an entity uuid — a sentence is the prose '
          + 'this field replaces, and a short sha cannot be expanded by the graph.';
      }
    }
    if (a.note !== undefined && a.note !== null && typeof a.note !== 'string') return 'acceptance.note must be a string';
    // #1041 — condition-scoped blockers. Validated HERE and not only in the MCP
    // schema: the projection's guard was written defensively BECAUSE this
    // function checked condition/evidence/note only, and a REST caller could
    // write any shape at all. With both surfaces agreeing, a value that reaches
    // the projection is one it can resolve.
    if (a.blockedBy !== undefined) {
      if (!Array.isArray(a.blockedBy)) {
        return `acceptance ${JSON.stringify(a.condition)}: blockedBy must be an array of card shortIds`;
      }
      for (const b of a.blockedBy) {
        if (typeof b !== 'number' || !Number.isInteger(b)) {
          return `acceptance ${JSON.stringify(a.condition)}: blockedBy ${JSON.stringify(b)} must be a card `
            + 'shortId number — the same vocabulary relationships.blockedBy uses.';
        }
      }
    }
  }
  return null;
}

/**
 * #814 — blocker OWNERSHIP. `blockedBy` says WHAT blocks this card and is silent
 * on WHO is clearing it and WHETHER they still are, so that has lived in prose.
 *
 * ⛔ A BLOCKER MUST NAME A CARD THIS CARD IS ACTUALLY BLOCKED BY. Without that
 * the ownership record drifts free of the edge it describes and becomes a SECOND
 * source of truth about what blocks what — the drift the room has spent the day
 * making unrepresentable rather than merely discouraged.
 */
const BLOCKER_STATUSES = new Set(['open', 'cleared']);

function validateBlockers(blockers, current, incoming) {
  if (!Array.isArray(blockers)) return 'blockers must be an array of {card, owner, status}';
  // ⚠️ THE EFFECTIVE blockedBy AFTER THIS WRITE, not the one before it.
  //
  // The first cut read `current` only. On CREATE there is no current, so every
  // blocker was refused and the field was silently PATCH-only — a caller could
  // declare blockers and relationships in one payload and be told the edge did
  // not exist, while the same two writes split across two calls worked.
  //
  // ⛔ Found by #831's three-list sweep, not by me: "well-formed probe did not
  // create (status 400)". That audit exists for exactly this create/patch
  // asymmetry, and it caught the field on its first run.
  const incomingBlocked = incoming?.relationships?.blockedBy;
  const blockedBy = (Array.isArray(incomingBlocked)
    ? incomingBlocked
    : (current?.relationships?.blockedBy || [])).map(String);
  for (const b of blockers) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return 'each blocker must be an object {card, owner, status} or {person, status}';

    // ⭐⭐⭐ #881 — A BLOCKER MAY NAME A CARD OR A PERSON, AND THE TWO ARE NOT
    // THE SAME RELATION.
    //
    //   card + owner  → another CARD blocks this one; `owner` is who is chasing it
    //   person        → a person's own pending action IS the block
    //
    // ⛔ Conflating them would make "waiting on a person" indistinguishable from
    // "that person is chasing the card that blocks this" — OPPOSITE states, and the
    // concierge query must return only the first. That distinction is the whole
    // design; a single `blockedBy: <person>` field would have been smaller and
    // would have destroyed it.
    const hasCard = !(b.card === undefined || b.card === null || b.card === '');
    const hasPerson = !(b.person === undefined || b.person === null || b.person === '');

    // ⭐⭐⭐ #966 — AND A THIRD TARGET: "any human will do", naming nobody.
    //
    // ⛔ THE COST: #881 offered one slot, `person`. Measured 2026-08-20 — EIGHT
    // live person-blockers, all naming the same man, and one of them says in its
    // own note "ANY HUMAN CAN SUPPLY IT". Naming someone converts "anyone could
    // do this" into "X owes this", and the concierge query returns it as a clean
    // list of things he apparently owes. The list handed to him overstated it.
    //
    // ⚠️ A BOOLEAN PREDICATE, deliberately — NOT a sentinel identity
    // (`person: 'any-human'`) and NOT a nullable `person`. Both overload an
    // existing slot: "nobody recorded who" and "anyone will do" would become the
    // same triple, and separating them is the entire point of this rule. The fix
    // must not reintroduce the collapse it exists to remove.
    if (b.anyHuman !== undefined && b.anyHuman !== true) {
      return 'a blocker\'s `anyHuman` is either true or absent. `false` is refused because '
        + 'absence must not masquerade as a decision: a stored false would be a third state '
        + '("someone judged this is not any-human") that nothing else can express, and it '
        + 'would read identically to a blocker whose author never considered the question.';
    }
    const hasAnyHuman = b.anyHuman === true;

    if (!hasCard && !hasPerson && !hasAnyHuman) {
      return 'each blocker must name what blocks it: a `card` (the blocking card shortId), '
        + 'a `person` (whose pending action is itself the block), or `anyHuman: true` '
        + '(any human participant can clear it)';
    }
    // ⚠️ EXACTLY ONE TARGET, extended to three. `anyHuman` beside a named person
    // is the same ambiguity as card-beside-person: the concierge query would have
    // to guess whether the entry means "ada owes this" or "anyone does", and those
    // are the two states this card exists to keep apart.
    if (hasAnyHuman && (hasCard || hasPerson)) {
      return 'a blocker names EXACTLY ONE of `card`, `person`, or `anyHuman: true`. '
        + '`anyHuman` beside a named target cannot be read as either — and "anyone can '
        + 'clear it" versus "this person must" is precisely the distinction being recorded.';
    }
    // ⚠️ EXACTLY ONE. A blocker naming both is not richer, it is ambiguous: the
    // concierge query would have to guess which relation the entry means, and
    // whichever it guessed would be wrong half the time.
    if (hasCard && hasPerson) {
      return 'a blocker names EITHER a card or a person, not both — `card` means another card '
        + 'blocks this one (with `owner` chasing it), `person` means that person\'s own pending '
        + 'action is the block. An entry naming both cannot be read as either.';
    }

    if (hasAnyHuman) {
      // ⛔ NO blockedBy REQUIREMENT, for the same reason as a person-blocker and
      // one step further: there is no edge to describe AND no identity to check.
      // The whole content of the fact is "a human, unspecified, can clear this."
      // ⚠️ And no `owner` — owner names who is chasing a blocking CARD; there is
      // no card here, and attaching one would be the slot-overloading this card
      // exists to prevent. (Pinned by the three-kinds test.)
    } else if (hasPerson) {
      if (typeof b.person !== 'string') return 'blocker.person must be a seat or person key';
      // ⛔ NO blockedBy REQUIREMENT HERE, deliberately. A card-blocker must
      // describe an existing edge so ownership cannot become a second source of
      // truth about what blocks what. A person-blocker has no edge to describe —
      // the whole point is that the thing blocking this card is NOT a card, which
      // is precisely why it was unrepresentable and lived in prose.
    } else if (!blockedBy.includes(String(b.card))) {
      return `blocker names card ${JSON.stringify(b.card)}, which is not in this card's blockedBy `
        + `(${blockedBy.join(', ') || 'empty'}). Ownership must describe an edge that exists, or it becomes `
        + 'a second source of truth about what blocks what.';
    }
    if (b.owner !== undefined && b.owner !== null && typeof b.owner !== 'string') return 'blocker.owner must be a seat key';
    if (!BLOCKER_STATUSES.has(b.status)) {
      return `blocker for card ${b.card} has status ${JSON.stringify(b.status)} — must be one of `
        + `${[...BLOCKER_STATUSES].join(', ')}`;
    }
    if (b.note !== undefined && b.note !== null && typeof b.note !== 'string') return 'blocker.note must be a string';
  }
  return null;
}

/**
 * #792 / #857 §VI — validate a card's falsifier checks.
 *
 * ⛔ THE PROBLEM #792 STATES AND THEN DECLARES UNSOLVED: "a bot that diffs card
 * claims against the tree ⇒ needs claims to be machine-readable; THEY ARE PROSE,
 * DELIBERATELY." Every candidate design it lists has the same weakness as the
 * thing it fixes, and it closes with "nobody has found a way to make it happen
 * without someone choosing to do it."
 *
 * ⭐ The way through is to stop trying to read the prose. The author writing a
 * load-bearing claim is the one person who knows what would make it false, at
 * the moment they know it — so they attach the tripwire THEN. The prose stays
 * prose; the check is a separate, executable thing sitting beside it.
 *
 * ⚠️ ASK ONLY, and this is a correctness rule rather than a safety one. A SELECT
 * has no boolean to compare against, so `expect` would be meaningless and the
 * check could never fail — an unfailable check is worse than none, because it
 * reports as watched. (Writes are already impossible: queryGraph refuses
 * anything that is not SELECT or ASK. This refuses them EARLIER, at the door,
 * so a caller learns immediately instead of at evaluation time.)
 */
function validateChecks(checks) {
  if (!Array.isArray(checks)) return 'checks must be an array of {claim, ask, expect}';
  for (const c of checks) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return 'each check must be an object {claim, ask, expect}';
    if (typeof c.claim !== 'string' || !c.claim.trim()) {
      return 'each check needs a `claim`: the sentence in the author\'s own words that this check would falsify';
    }
    if (typeof c.ask !== 'string' || !c.ask.trim()) {
      return `check ${JSON.stringify(c.claim)} needs an \`ask\`: a SPARQL ASK whose answer would falsify the claim`;
    }
    if (typeof c.expect !== 'boolean') {
      return `check ${JSON.stringify(c.claim)} needs \`expect\` (true or false): without it the check can never fail, `
        + 'and a check that cannot fail reports the claim as watched while watching nothing';
    }
    // Strip comments and leading PREFIX declarations, then require ASK.
    const head = c.ask
      .replace(/#[^\n]*/g, ' ')
      .replace(/\bPREFIX\s+[^\s:]*:\s*<[^>]*>/gi, ' ')
      .trim();
    if (!/^ASK\b/i.test(head)) {
      return `check ${JSON.stringify(c.claim)}: \`ask\` must be a SPARQL ASK (got ${JSON.stringify(head.slice(0, 24))}). `
        + 'SELECT returns rows, not a boolean, so `expect` could never be compared and the check could never fail.';
    }
  }
  return null;
}

// #614 — the card-to-card edge vocabulary. Closed on purpose: a fixed verb
// set needs no adjudication, so growing it is a design decision, not data
// arriving. relatedTo is bidirectional; the other three are directional
// (A blockedBy B, A supersedes B, A derivedFrom B).
const RELATIONSHIP_TYPES = ['relatedTo', 'blockedBy', 'supersedes', 'derivedFrom'];

// Returns an error string if the relationships object is malformed, else null.
// Targets are shortIds (numbers). Stored legacy data mixes UUIDs in — that is
// a migration surface, not a write surface; new writes are held to shortIds.
// #844 — AN ECHO IS NOT AN ATTEMPT.
//
// A caller that GETs a card, changes one field and PATCHes it back is sending
// every immutable and every server-derived field verbatim. Reporting those as
// refused/ignored means the diagnostic fires on EVERY read-modify-write — the
// always-fires rule, living in the response body, which trains a caller to skip
// the field entirely and makes the one that matters invisible.
//
// So the predicate is "did the caller try to CHANGE it?", not "was the key
// present?". Deep-compares because relationships and arrays echo by value.
function isEchoOfStored(submitted, stored) {
  if (submitted === stored) return true;
  if (submitted === undefined || stored === undefined) return false;
  try { return JSON.stringify(submitted) === JSON.stringify(stored); } catch { return false; }
}

// #844 Class 4 — server-DERIVED relationship types. Emitted by GET on every
// card, maintained by the server as the inverse of an authored type, and never
// settable by a caller. Echoing one back must not 400; ASSERTING one still must.
const DERIVED_RELATIONSHIP_TYPES = ['supersededBy'];

// #844 — fields the API EMITS on read but never STORES on the card. A caller
// echoing one back has nothing to compare against (the stored value is
// undefined), so echo-suppression alone cannot see them. They are projections,
// not card fields, and reporting them turns every read-modify-write noisy.
//
// ⛔ #856 — `by` USED TO LIVE HERE AND DOES NOT BELONG. The comment above it
// already said so in prose — "it travels WITH a write (#675), it is not a field
// OF the card" — while the code put both keys in one Set and treated them
// identically. `by` is not dropped at all: it is CONSUMED, by the event log,
// in this same request. Reporting it as ignored, refused, or redirected would
// be false in all three directions. A comment asserting a runtime property is
// a test case in prose; this split is that comment, encoded.
// ⭐ #856 — ONE OBJECT, BOTH HALVES. A projection needs two things to behave:
// the value the route WOULD EMIT (the comparand, without which every send
// always-fires) and the destination to send the caller to. The first cut of
// this kept them in two containers with a boot-time check on ONE of them —
// which is worse than checking neither, because a contributor adds a field,
// boots, gets told about the missing destination, adds it, boots clean, and
// ships an always-fires diagnostic with a green start-up.
//
// ⇒ A RAIL THAT VALIDATES HALF OF A TWO-PART REQUIREMENT READS AS COMPLETENESS.
// Keeping the halves in one entry makes the mismatch unrepresentable rather
// than caught. (review finding, 2026-08-18)
const CARD_PROJECTIONS = {
  comments: {
    // The comparand echo-suppression was missing. #844 compared against
    // `card[field]` — undefined for every projection — so it could never tell
    // an RMW echo from a real attempt. This is the SAME call GET makes.
    value: (data, card) => commentMetadata(data.conversations, card.id),
    destination: 'POST /api/conversations with attachedTo (MCP: conversation_post attachedTo:) — comments are not a card field',
  },
};

const READ_PROJECTION_FIELDS = new Set(Object.keys(CARD_PROJECTIONS));

// #856 — consumed by a DIFFERENT subsystem in the same request. Not stored on
// the card, not discarded either, and therefore never reported.
// #534 — `ifVersion` is a PRECONDITION, consumed by the compare-and-swap check
// before any field is applied. #864's lesson taken before it bites: a verb in a
// field allowlist gets stored as a noun, and reporting a field that WAS consumed
// tells the caller the opposite of what happened.
const CONSUMED_ELSEWHERE_FIELDS = new Set(['by', 'ifVersion', 'return']);

// #1032 — the response shapes a caller may ask for. Opt-IN by construction:
// some callers legitimately use the echoed `version`, so changing the DEFAULT
// would break every existing consumer to save tokens — a worse trade than the
// one being fixed.
const RETURN_SHAPES = new Set(['id']);

// #856 — where a projection's caller should actually go. This is the whole
// reason the class is a MAP and not a list: `ignoredFields` can be bare because
// the key is the entire message ("I did not recognise `foo`"), but here the
// caller CAN do what they tried — through a different door — and a redirect
// that does not name the destination is a 404 wearing a signpost.
//
// ⚠️ The discriminator for this class is NOT "how real is the key". It is
// WHETHER THE CALLER HAS ANYWHERE ELSE TO GO:
//   id        REFUSED     you may not do this. There is no other door.
//   comments  REDIRECTED  you CAN do this. Different door.
// Folding a redirect into `refusedFields` tells a caller to STOP when the true
// answer is TURN LEFT — actionable and wrong, which is worse than silent.
// #856 — the halves cannot drift apart above, so this checks the only thing
// still expressible: an entry that omits one of them. It covers BOTH, because
// a rail that covers one is a rail that certifies a bug.
for (const [f, p] of Object.entries(CARD_PROJECTIONS)) {
  if (typeof p?.value !== 'function') {
    throw new Error(`#856: projection '${f}' has no value() — its comparand would be undefined, `
      + 'and isEchoOfStored returns false against undefined, so it would report on EVERY write');
  }
  if (!p.destination) {
    throw new Error(`#856: projection '${f}' has no destination — `
      + 'a redirect that cannot name where to go is a 404 wearing a signpost');
  }
}

function validateRelationships(rel, current = undefined) {
  if (typeof rel !== 'object' || rel === null || Array.isArray(rel)) {
    return 'relationships must be an object';
  }
  for (const [type, targets] of Object.entries(rel)) {
    if (!RELATIONSHIP_TYPES.includes(type)) {
      // #844 Class 4 — a DERIVED type echoed back unchanged is not a client
      // error; it is the server's own output returning home. Calling it
      // "unknown" sent a caller to check spelling that was already correct.
      if (DERIVED_RELATIONSHIP_TYPES.includes(type)) {
        if (current && isEchoOfStored(targets, current[type])) continue;
        return `relationship type '${type}' is maintained by the server and cannot be set directly`;
      }
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
function validateCardFields(body, { checkId = true, surface = 'patch', current = undefined } = {}) {
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
  // #1132 — a whole-array REPLACE without a precondition is REFUSED. These
  // three fields have no append verb, so every write replaces the array, and
  // the #534 compare-and-swap is their ONLY defence against a concurrent
  // writer. It was optional — and a seat who fetched, mutated, wrote once and
  // read back still could not detect an entry that arrived while she composed
  // (measured 2026-09-02 05:18Z on #209). Absence must not masquerade as a
  // decision. An EMPTY array is a CLEAR and clobbers the same way: not exempt.
  {
    const wholesale = ['acceptance', 'blockers', 'checks'].filter((k) => Array.isArray(body[k]));
    // PATCH only: create has no prior version to compare, and nothing to clobber.
    if (surface === 'patch' && wholesale.length && body.ifVersion === undefined) {
      return `${wholesale.join(', ')} REPLACE the whole array and need ifVersion — the card version you read — `
        + 'or a concurrent write is silently deleted (#1132). Read the card, pass its version, write once; '
        + 'a moved version is refused with 409 so you can re-read and reapply.';
    }
  }
  if (body.acceptance !== undefined && body.acceptance !== null) {
    const aerr = validateAcceptance(body.acceptance);
    if (aerr) return aerr;
  }
  if (body.blockers !== undefined && body.blockers !== null) {
    const berr = validateBlockers(body.blockers, current, body);
    if (berr) return berr;
  }
  if (body.checks !== undefined && body.checks !== null) {
    const cerr = validateChecks(body.checks);
    if (cerr) return cerr;
  }
  // #1137 — acceptanceUpsert / blockersUpsert / checksUpsert. PATCH-ONLY (an
  // upsert into a card that does not exist yet is a create, and create takes
  // the arrays). Each entry is validated by the SAME validator as the
  // whole-array write, so a malformed upsert is refused in the same words and
  // an upsert blocker must still name a card in blockedBy. Refused beside the
  // whole-array field of the same name: replace and upsert in one write are
  // two intentions. Refused when empty: nothing to upsert. Needs NO ifVersion —
  // the write sends only what changed and the server composes under its lock,
  // so there is nothing to clobber by construction (still honoured if sent).
  if (surface !== 'create') {
    for (const [verb, field] of Object.entries(ARRAY_UPSERT_VERBS)) {
      if (body[verb] === undefined) continue;
      if (!Array.isArray(body[verb])) return `${verb} must be an array of ${field} entries (each matched on its key, inserted or replaced)`;
      if (!body[verb].length) return `${verb} is empty — nothing to upsert`;
      if (body[field] !== undefined) {
        return `send either ${field} (replace the whole array, with ifVersion) or ${verb} (insert-or-replace the entries `
          + 'sent, matched on their key), not both — a replace and an upsert in one write are two intentions and the '
          + 'result would be neither';
      }
      const err = field === 'acceptance' ? validateAcceptance(body[verb])
        : field === 'blockers' ? validateBlockers(body[verb], current, body)
        : validateChecks(body[verb]);
      if (err) return err;
    }
  }
  // #864 — the byte-preserving append. PATCH-ONLY, per #830's route-relative
  // rule: appending to a card that does not exist yet is not an operation, and
  // create takes `description`. Validating it here on create would produce the
  // exact three-state mess #830 was written about — the route refusing
  // malformed values for a field it then silently discards, so a caller reading
  // the 400 and a caller reading `ignoredFields` get opposite answers.
  //
  // ⚠️ Found by #831's own audit, which reported `descriptionAppend:
  // VALIDATED_THEN_DISCARDED` on the create surface minutes after this field
  // was added. Left unguarded it would have been the third instance of a class
  // that already has two.
  if (surface !== 'create' && body.descriptionAppend !== undefined) {
    if (typeof body.descriptionAppend !== 'string') {
      // Coercing would turn a caller's mistake into a permanent edit to a long
      // card — `String({})` appends "[object Object]" and the original bytes are
      // still fine, so nothing downstream would ever flag it.
      return 'descriptionAppend must be a string (the text to add to the end of the description)';
    }
    if (body.description !== undefined) {
      // ⛔ REFUSE rather than order them. These are two DIFFERENT edits to one
      // field, so any precedence rule makes the result depend on a convention
      // the caller cannot see. #831 and #862 pinned precedence where two
      // spellings meant the SAME thing; "replace it" and "add to it" do not,
      // and picking one silently discards an intent the caller stated.
      return 'send either description (replace) or descriptionAppend (add to the end), not both — '
        + 'they are different edits to the same field and there is no correct order for them';
    }
  }
  // #906 — the mirror of the above, and it exists because the ABSENCE of it was
  // shaping the room's writing. With only `description` (replace) and
  // `descriptionAppend` (add to the end), the safe verb could only produce cards
  // where corrections sit BELOW the text they correct, and the readable shape
  // required resending the whole body. The result was named on #857 by the
  // person this board is built for:
  // "a willingness to read things that were appended at the bottom to correct
  // for things at the top. that doesn't seem useful." Five cards had drifted
  // into it, by five authors, none of whom chose it.
  //
  // PATCH-ONLY for the same reason as append (#830): prepending to a card that
  // does not exist yet is not an operation, and create takes `description`.
  if (surface !== 'create' && body.descriptionPrepend !== undefined) {
    if (typeof body.descriptionPrepend !== 'string') {
      // Coercing is worse here than on append: `String({})` would write
      // "[object Object]" at the TOP of the card, where it is the first thing
      // every reader sees and still nothing downstream would flag it.
      return 'descriptionPrepend must be a string (the text to add to the beginning of the description)';
    }
    if (body.description !== undefined) {
      // ⛔ Same rule as append, same reason: "replace it" and "add to the front
      // of it" are two DIFFERENT edits to one field, so any precedence makes the
      // result depend on a convention the caller cannot see.
      return 'send either description (replace) or descriptionPrepend (add to the beginning), not both — '
        + 'they are different edits to the same field and there is no correct order for them';
    }
    // ⚠️ DELIBERATELY NOT REFUSED: descriptionPrepend + descriptionAppend.
    // Unlike the pairs above, these touch DISJOINT ends and compose to exactly
    // one result — pre + old + post — with no ordering question to get wrong.
    // Refusing it would be an over-refusal, and a rail whose failure mode is
    // "the board stops accepting truth" is worse than the defect it prevents.
  }
  // #254 — `parent` is now consumed on BOTH surfaces, so it must be validated on
  // both. ⚠️ Added because the #830 scope test caught the gap the moment create
  // started consuming it: my consume step took `typeof === 'string'`, so
  // `parent: 42` was dropped AND — since the field had just joined
  // CREATE_CONSUMED_FIELDS — no longer reported in ignoredFields. Silently
  // discarded on both channels at once, which is worse than either alone.
  if (body.parent !== undefined && body.parent !== null && typeof body.parent !== 'string') {
    return 'parent must be a card id string, or null to make this card a root';
  }
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
    const rerr = validateRelationships(body.relationships, current?.relationships); // #614/#844
    if (rerr) return rerr;
  }
  return null;
}

// Fields a PATCH may set. Anything else (a crafted __proto__ or junk key) is
// ignored rather than blindly copied onto the stored card. #249.
// #1137 — the upsert verb for each whole-array field, and the KEY an entry is
// matched on. A verb, so deliberately NOT in PATCHABLE_CARD_FIELDS: a verb in
// a field allowlist gets stored as a noun (the #864 rule).
const ARRAY_UPSERT_VERBS = { acceptanceUpsert: 'acceptance', blockersUpsert: 'blockers', checksUpsert: 'checks' };
const ARRAY_UPSERT_KEY = {
  acceptance: (a) => `condition:${a.condition}`,
  blockers: (b) => (b.anyHuman === true ? 'anyHuman'
    : (b.person !== undefined && b.person !== null && b.person !== '') ? `person:${b.person}`
    : `card:${b.card}`),
  checks: (c) => `claim:${c.claim}`,
};
function upsertArrayEntries(field, existing, entries) {
  const keyOf = ARRAY_UPSERT_KEY[field];
  const next = Array.isArray(existing) ? existing.map((e) => ({ ...e })) : [];
  for (const entry of entries) {
    const k = keyOf(entry);
    const i = next.findIndex((e) => keyOf(e) === k);
    if (i >= 0) next[i] = { ...entry }; else next.push({ ...entry });
  }
  return next;
}

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
  'checks',   // #792 — falsifier tripwires, editable as the claim they watch changes
  'blockers', // #814 — who owns clearing each blocker, and whether they still do
  'acceptance', // #814 — which durable result discharged which release condition
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
    // #1130 — "what lives here": the cards that DECLARE themselves the top of
    // a body of work (`apex:<label>`, core/apex-labels.mjs), with how much is
    // contained under each. Containment, never the label (the owner's ruling
    // of 2026-08-19): an apex with nothing asserted under it reports 0.
    const apexes = [];
    for (const c of data.cards) {
      for (const l of c.labels || []) {
        if (typeof l !== 'string' || !l.startsWith(APEX_PREFIX) || l.length <= APEX_PREFIX.length) continue;
        apexes.push({ shortId: c.shortId, title: c.title, label: l.slice(APEX_PREFIX.length),
          members: apexDescendantIds(data.cards, c.id).length });
      }
    }
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
      apexes,
      // #1078 — ONE answer to "what is in flight": the claim is authoritative,
      // the column is a derived stage, and every disagreement is named.
      inFlight: inFlight(data.cards, { now: new Date().toISOString() }),
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

// ── /api/tending-config (#953) — the tending silence threshold, editable from
// the Settings page. ──
//
// ⛔ WHY THIS EXISTS AT ALL, and it is the card's whole point. The value was
// already persisted and already live-reloaded by the MCP tick — but only a seat
// could change it. The Value Steward's disqualifier is explicit:
//
//   "A control @michael cannot reach. 'Editable by any seat' is a TOOL surface.
//    He is not a seat."
//
// And his own words: "there was no way for me to set the time intervals… part of
// the work was building administration so I could do that very thing."
//
// Deliberately mirrors /api/config (#263) rather than inventing a shape: same
// loopback trust model, same validate-then-persist, same 400-with-the-
// validator's-own-message. One pattern on one page beats two.
function handleGetTendingConfig(req, res) {
  try {
    sendJSON(res, 200, readTendingConfig());
  } catch (e) {
    console.error('GET /api/tending-config:', e.message);
    sendJSON(res, 500, { error: 'Failed to read tending config' });
  }
}

async function handleSetTendingConfig(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    let clean;
    try {
      // Validates and refuses; a rejected write leaves the previous file
      // untouched, so a typo cannot silently become the room's threshold.
      clean = writeTendingConfig(body);
    } catch (ve) {
      return sendJSON(res, 400, { error: ve.message });
    }
    sendJSON(res, 200, clean);
  } catch (e) {
    console.error('POST /api/tending-config:', e.message);
    sendJSON(res, 500, { error: 'Failed to save tending config' });
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
  'q',   // #656 — free-text over title+description+labels. The miss log asked for it.
  'facet',  // #629 — count → facet → refine, before paying for rows
  // #912 — "everything under apex X, containment only, depth ≤ N".
  //
  // ⭐ The capability already existed as a SPARQL property path and nobody used
  // it, because using it meant hand-writing `?c schema:isPartOf+ ?apex`. That is
  // the difference between a capability that exists and one anyone reaches for.
  'under', 'depth',
  // #209 — the two the board's own list view needs, both OPT-IN so no other
  // caller's shape changes: `excerpt=N` adds `descriptionExcerpt` (a CAP, never
  // `description` — see core/cards-query.mjs for why that distinction is what
  // keeps an editor from saving a truncation over a body), and `legacyIndex=1`
  // adds `legacyArrayIndex`, the store position the board's tie-break already
  // depends on. Retirement for the second: #923 slice 0.
  'excerpt', 'legacyIndex',
]);

/**
 * #912 — the ids CONTAINED BY `apexId`, following `parent` and nothing else.
 *
 * ⛔ CONTAINMENT ONLY, and that is the whole point. The board's unbounded
 * traversal returns ~87% of the cards because it follows association edges;
 * a subtree that includes everything anyone ever mentioned is not a subtree.
 * `relatedTo` and `mentionsCard` are not consulted here.
 *
 * ⚠️ `seen` is not an optimisation. #254 guards against CREATING a cycle, but a
 * walk that trusts its input to be acyclic is one bad row away from spinning
 * forever on an endpoint anyone can hit — and the guard and the walk protect
 * different things. A cycle would be a data defect; an infinite loop would be
 * an outage.
 */
function descendantIds(cards, apexId, maxDepth) {
  const kids = new Map();          // parentId → [childId]
  for (const c of cards) {
    if (!c.parent) continue;
    if (!kids.has(c.parent)) kids.set(c.parent, []);
    kids.get(c.parent).push(c.id);
  }
  const out = new Set();
  const seen = new Set([apexId]);
  let frontier = [apexId];
  for (let d = 1; d <= maxDepth && frontier.length; d += 1) {
    const next = [];
    for (const id of frontier) {
      for (const kid of kids.get(id) || []) {
        if (seen.has(kid)) continue;   // cycle or diamond: visit once
        seen.add(kid);
        out.add(kid);
        next.push(kid);
      }
    }
    frontier = next;
  }
  return out;
}

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
      // #801 — AND PERSIST IT. The line above has captured real retrieval needs
      // since #656 step 2 shipped, which means #801's premise ("automatic
      // capture is NOT available") was already false when the card was written.
      // But stderr is not queryable and does not survive a deploy, so the
      // board's most honest signal about its own gaps was being written where
      // nobody reads and nothing keeps. Measured on the live log: `q` — free-text
      // search — wanted four times, by seats who then went elsewhere.
      recordMisses(unsupported, q.as || null, req.url);
      if (q.bestEffort !== 'true') {
        return sendJSON(res, 400, {
          // #659 verification finding: this string is the only place a seat
          // learns what the door can do — a stale version teaches them to
          // leave. Derive it from the param set so it cannot drift again.
          error: `unsupported param${unsupported.length > 1 ? 's' : ''}: `
            + `${unsupported.join(', ')} (supported: `
            + `${[...CARD_LIST_PARAMS].filter((p) => p !== 'as' && p !== 'bestEffort').join(', ')}`
            + ' — q is substring over title+description+labels, not stemmed; '
            + 'pass bestEffort=true to be served without the rest)',
          unsupported,
        });
      }
    }

    // #629 — a facet request answers with the SHAPE of the set and no rows.
    if (q.facet != null && q.facet !== '') {
      return sendJSON(res, 200, facetCards(data.cards, {
        facet: q.facet,
        column: q.column, label: q.label, assignee: q.assignee, type: q.type,
        since: q.since, updatedSince: q.updatedSince, q: q.q,
      }, { validColumns: data.columns.map((c) => c.id) }));
    }

    // #912 — narrow to a subtree BEFORE the ordinary filters, so `under`
    // composes with them instead of competing. A caller asking for
    // `under=X&label=y` means "in this subtree AND labelled", never "either".
    let pool = data.cards;
    if (q.under != null && q.under !== '') {
      const apexIdx = findCardIndex(data, q.under);
      if (apexIdx < 0) {
        // ⛔ REFUSE rather than return an empty set. "No children" and "no such
        // card" are different facts; sharing a response makes a typo'd id look
        // like an empty subtree, and the caller concludes the question was
        // answered when it was never asked. Every apex on this board has zero
        // children today, so the empty case is the COMMON one — which is
        // exactly why it must not also mean "not found".
        return sendJSON(res, 400, {
          error: `unknown apex for under=${q.under} — no card with that id or shortId. `
               + 'An apex with no children returns an empty set; this is a different answer.',
        });
      }
      const depth = q.depth == null || q.depth === '' ? Infinity : Number(q.depth);
      if (!Number.isFinite(depth) ? q.depth != null && q.depth !== '' : !(Number.isInteger(depth) && depth >= 1)) {
        return sendJSON(res, 400, { error: `depth must be a positive integer (got ${JSON.stringify(q.depth)})` });
      }
      const ids = descendantIds(data.cards, data.cards[apexIdx].id, depth);
      pool = data.cards.filter((c) => ids.has(c.id));
    }

    const result = queryCards(pool, {
      // #209 — opt-in projection extras; absent unless asked for, so no other
      // caller's shape moves.
      excerpt: q.excerpt, legacyIndex: q.legacyIndex,
      limit: q.limit, before: q.before, fields: q.fields,
      column: q.column, label: q.label, assignee: q.assignee, type: q.type, since: q.since,
      updatedSince: q.updatedSince, q: q.q,
    }, { validColumns: data.columns.map((c) => c.id), storeCards: data.cards });
    if (unsupported.length) result.unsupported = unsupported; // best-effort confesses
    sendJSON(res, 200, result);
  } catch (e) {
    if (e.code === 'UNKNOWN_CURSOR' || e.code === 'UNKNOWN_FIELD' || e.code === 'UNKNOWN_FILTER_VALUE'
        || e.code === 'UNKNOWN_FACET') {
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
    let createErr = null;
    // #280 — the dup warning. Computed against the board AS READ inside the
    // lock, so "a similar card was created a second ago" is inside the window
    // it is meant to catch. Derived only: it rides on the 201 and is never
    // stored — see core/similar-cards.mjs for the limits it declares.
    let similar = [];
    const created = await withWriteLock(async () => {
      const data = readBoard();
      // #917 — resolve before constructing, so the card is never built with a
      // value that would mint a dangling IRI. Inside the lock because it reads
      // the board it is resolving against.
      const rp = resolveParentValue(data, body.parent);
      if (!rp.ok) { createErr = rp.error; return null; }
      if (body.parent !== undefined) body.parent = rp.id;
      similar = similarCards(data.cards, body.title);
      const card = createCardFromPayload(body, data.nextShortId);
      data.cards.push(card);
      if (card.parent != null) applyApexLabels(data.cards, card.id);   // #902 item 4 — born labelled
      data.nextShortId = (data.nextShortId || 1) + 1;
      // #669 — the create AND every sibling its relationships rewrote (#614).
      const fanout = syncInverseRelationships(data, card, null, card.relationships);
      writeBoard(data, [
        cardEvent('create', card, card.createdBy),
        ...fanout.map((c) => cardEvent('update', c, card.createdBy)),
      ]);
      return card;
    });
    // #917 — THE REFUSAL, read outside the lock because that is where the
    // response is written.
    //
    // ⚠️ Left dangling for half an hour while I did something else: `createErr`
    // was assigned inside the lock and never read, so an unresolvable parent
    // would have returned null and fallen through to whatever the generic path
    // does. That is the accepted-then-something-else shape — the exact class I
    // had filed a card about the same afternoon. Naming it here rather than
    // quietly closing it, because the near-miss is the useful part.
    if (createErr) return sendJSON(res, 400, { error: createErr });
    // #829 — create reports what it dropped, matching PATCH. Present only when
    // non-empty: an empty array on every response is noise a caller learns to
    // skip, which is how the original silence went unnoticed.
    const ignoredFields = unconsumedCreateFields(body);
    sendJSON(res, 201, {
      ...created,
      ...(ignoredFields.length ? { ignoredFields } : {}),
      ...(similar.length ? { similarCards: similar } : {}),
    });
  } catch (e) {
    console.error('POST /api/cards:', e.message);
    sendJSON(res, 500, { error: 'Failed to create card' });
  }
}

async function handleUpdateCard(req, res, idOrShortId) {
  try {
    const raw = await readBody(req);
    const patch = JSON.parse(raw);
    // #844 — the stored relationships are needed to tell an ECHO of a derived
    // type from an ASSERTION of one.
    const _existing = (() => {
      try { const d = readBoard(); const i = findCardIndex(d, idOrShortId);
            return i < 0 ? null : d.cards[i]; } catch { return null; }
    })();
    const verr = validateCardFields(patch, { checkId: false, current: _existing }); // id is immutable on PATCH
    if (verr) return sendJSON(res, 400, { error: verr });

    // #534 — THE PRECONDITION'S SHAPE, checked OUTSIDE the write lock. It needs
    // no board state, and a malformed request has no business acquiring a lock
    // in order to be rejected.
    //
    // ⛔ 400, NOT 409, and the distinction is load-bearing. 409 means "you are
    // behind, re-read and retry" and a client may legitimately LOOP on it. 400
    // means "this request is malformed" and looping is futile. Answering a type
    // error with 409 sends a retrying client into a loop with no exit — and the
    // 409 would quote back the very version the caller sent, which is the
    // confusing failure this shape was found by on the memory surface (7b4f909).
    //
    // ⚠️ REFUSE rather than COERCE: Number('2abc') is NaN and NaN !== current
    // for EVERY current, so a coercion leaves the unclearable 409 fully intact
    // on malformed input while newly and SILENTLY accepting null as 0 and true
    // as 1. It fixes the example and not the class.
    if (patch.ifVersion !== undefined
        && !(Number.isInteger(patch.ifVersion) && patch.ifVersion >= 0)) {
      return sendJSON(res, 400, {
        error: 'ifVersion must be a non-negative integer (the version you read). '
          + `Got ${JSON.stringify(patch.ifVersion)}. This is a malformed request, `
          + 'not a version conflict — re-reading and retrying will not clear it.',
      });
    }
    // #1032 — the response SHAPE, validated before the write.
    //
    // Every card write echoes the whole body back: a one-line append to the
    // largest card costs ~35,000 tokens of response nobody requested. The
    // gradient is perverse — this room writes long card bodies on purpose,
    // because that is how findings survive compaction, so better
    // record-keeping taxes every subsequent write.
    //
    // ⛔ REFUSED, not ignored. A caller asking for a shape we do not support is
    // trying to spend less; silently handing them the full body fails at the
    // one thing they asked for and they cannot tell. "Accepts and ignores" is
    // unobservable from outside.
    //
    // ⚠️ And refused HERE, before the write, so a rejected response shape is a
    // pure no-op rather than a half-applied edit.
    if (patch.return !== undefined && !RETURN_SHAPES.has(patch.return)) {
      return sendJSON(res, 400, {
        error: `unsupported return shape ${JSON.stringify(patch.return)}. `
          + `Supported: ${[...RETURN_SHAPES].map((v) => JSON.stringify(v)).join(', ')}, `
          + 'or omit `return` for the full card. Nothing was written.',
        code: 'UNSUPPORTED_RETURN_SHAPE',
        hint: 'return:"id" answers what an append caller actually needs — id, '
          + 'version and descriptionBytes — without shipping the body back. '
          + 'Omitting `return` is unchanged, so existing callers are unaffected.',
      });
    }
    // #254 — THE SAME PREDICATE, not a second copy of it.
    //
    // `parent` sits in PATCHABLE_CARD_FIELDS, so this route has always accepted
    // it — while `reparentWouldCycle` had exactly ONE call site, in the /api/nodes
    // handler. Two routes wrote one field and only one of them checked the write
    // was legal, so a cycle could be created here with a 200 and a card that
    // reads back exactly as sent. The damage is a property of the GRAPH, not of
    // any record, so nothing downstream would ever report it.
    //
    // ⚠️ #890's lesson, and the reason this calls the node route's function
    // instead of re-deriving the rule: sharing a CONSTANT is not sharing a RULE.
    // Both routes already shared the field and the store; what they did not share
    // was the predicate deciding a write is legal. A second implementation here
    // would pass its own tests and drift on the first edit to either copy.
    if ('parent' in patch && _existing) {
      // #917 — RESOLVE FIRST, then guard. The cycle check compares ids, so a
      // shortId would have been compared against uuids and matched nothing:
      // the guard was intact and simply looking at the wrong values.
      try {
        const d0 = readBoard();
        const rp = resolveParentValue(d0, patch.parent);
        if (!rp.ok) return sendJSON(res, 400, { error: rp.error });
        patch.parent = rp.id;
      } catch { /* board unreadable: the write below fails on its own terms */ }
    }
    if ('parent' in patch && patch.parent != null && _existing) {
      try {
        const d = readBoard();
        if (reparentWouldCycle(d.cards, _existing.id, patch.parent)) {
          // 409, matching the /api/nodes route exactly. My first version answered
          // 400 and the agreement test caught it: both routes REFUSED — they
          // agreed on the decision — and disagreed on the code, which is the
          // #890 defect surviving inside its own fix. The incumbent defines the
          // contract; a caller must not have to know which route it came in on.
          return sendJSON(res, 409, { error: 'That move would make the page a descendant of itself.' });
        }
      } catch { /* board unreadable: the write below will fail on its own terms */ }
    }
    const ignoredFields = [];   // #823 — declared back to the caller
    // #831 — REFUSED is a different fact from IGNORED. "I did not recognise
    // this" and "I recognised it and will not let you change it" call for
    // different actions from the caller; one list would make a typo and a
    // policy violation indistinguishable.
    const refusedFields = [];
    // #856 — the third fact, and a MAP rather than a list because its whole
    // value is the destination. Same test as #831's split: a name earns its own
    // channel when it changes what the caller does next.
    const redirectedFields = {};
    // #1081 — declared OUT here, not inside the callback, so the handler's exit
    // path can ring the doorbell for it. Reset per attempt inside the lock, so a
    // retried write can never notify with a stale nudge from an earlier pass.
    let nudge = null;
    const updated = await withWriteLock(async () => {
      const data = readBoard();
      const idx = findCardIndex(data, idOrShortId);
      if (idx < 0) return null;
      const card = data.cards[idx];

      // #534 — THE COMPARE-AND-SWAP, inside the lock and BEFORE any field is
      // applied, so the version it compares is the one the write is about to
      // advance. Outside the lock this is a check-then-act race: it would read
      // as CAS while providing none.
      //
      // ⭐ This is only honest because slice 1 made the version server-controlled
      // on EVERY path including handleSave. While /api/save wrote back the
      // client's copy, a save between a seat's read and its write could move the
      // version BACKWARD and make this comparison pass against a card that had
      // moved on twice — a precondition reporting "you are current" in exactly
      // the case it exists to catch. Pinned by the COUPLING test.
      if (patch.ifVersion !== undefined) {
        const current = Number.isInteger(card.version) ? card.version : 0;
        if (patch.ifVersion !== current) {
          return { conflict: true, currentVersion: current };
        }
      }

      const wasDone = card.column === 'done';
      let fanout = [];        // #669 — siblings this patch rewrites via #614
      nudge = null;           // #1081 — reset per attempt; declared above the lock
      // #831 — mirror create's precedence: `assignees` (plural) wins over the
      // `assignee` alias when a caller sends both, so the result does not
      // depend on JSON key order.
      const pluralWins = Array.isArray(patch.assignees) && patch.assignees.length > 0;
      // #864 — THE BYTE-PRESERVING EDIT. Applied here, as an OPERATION on the
      // stored value, and deliberately not a member of PATCHABLE_CARD_FIELDS:
      // it is a verb, and a verb in a field allowlist gets stored as a noun.
      //
      // ⚰️ Why it exists. `description` is all-or-nothing, so a seat whose only
      // write path is MCP cannot add a paragraph without regenerating the whole
      // field from context — a re-composition, not a copy. Measured on a live
      // 9,770-byte card: 99.98% byte-identical, prose untouched, formatting
      // untouched, and four backslashes inserted inside the SPARQL blocks,
      // turning `"805"` into `\"805\"` and both example queries into syntax
      // errors. Re-composition damages precisely the content that has a
      // correctness property, because QUOTING is where a model diverges and
      // quoting is where the runnable things live.
      //
      // ⇒ #857 §I calls this room "several minds working as PEERS". A seat that
      // cannot edit a long card without corrupting it is not a peer, and the
      // asymmetry ran along the central write path.
      //
      // The guarantee is structural rather than careful: the new value is the
      // old value plus a suffix, so the original cannot be mangled by an edit
      // that never retypes it.
      if (patch.descriptionAppend !== undefined) {
        card.description = `${card.description ?? ''}${patch.descriptionAppend}`;
        card.updatedAt = new Date().toISOString();
      }
      // #906 — the same structural guarantee at the other end: the new value is
      // a prefix plus the old value, so the original cannot be mangled by an
      // edit that never retypes it. Applied AFTER append so that sending both
      // yields pre + old + post regardless of key order in the request body —
      // the composition must not depend on JSON key ordering.
      if (patch.descriptionPrepend !== undefined) {
        card.description = `${patch.descriptionPrepend}${card.description ?? ''}`;
        card.updatedAt = new Date().toISOString();
      }
      // #1137 — the same structural guarantee for the three arrays: composed
      // HERE, inside the lock, against the array current at the write. Neither
      // of two concurrent upserters holds a snapshot, so neither can delete the
      // other's entry — the #466 clobber is impossible rather than detected.
      for (const [verb, field] of Object.entries(ARRAY_UPSERT_VERBS)) {
        if (patch[verb] === undefined) continue;
        card[field] = upsertArrayEntries(field, card[field], patch[verb]);
        card.updatedAt = new Date().toISOString();
      }
      for (const [k, v] of Object.entries(patch)) {
        // #864 — consumed immediately above. Listed here rather than in
        // PATCHABLE_CARD_FIELDS so it is never written as a literal key, and
        // reported as neither ignored (#823) nor refused: it was honoured.
        if (k === 'descriptionAppend' || k === 'descriptionPrepend') continue;
        if (k in ARRAY_UPSERT_VERBS) continue; // #1137 — consumed above, same reason
        // #844 — an unchanged value was not an attempt. Silent.
        if (isEchoOfStored(v, card[k])) continue;
        if (IMMUTABLE_CARD_FIELDS.has(k)) {
          // #831 — was a bare `continue`, which sat ABOVE the ignoredFields push
          // and made an immutable field the one input that vanished with no
          // diagnostic at all. Refusing it is correct (#631 — authorship is a
          // fact about the past); refusing it silently is the #823 defect.
          refusedFields.push(k);
          continue;
        }
        // #856 — consumed by another subsystem in this same request (`by` ->
        // the event log). Not stored, not discarded, so never reported.
        if (CONSUMED_ELSEWHERE_FIELDS.has(k)) continue;
        const projection = CARD_PROJECTIONS[k];
        if (projection) {
          // #856 — #844's rule with the comparand it was missing. Echoing the
          // projection back is the ordinary GET/modify/PATCH cycle and must stay
          // SILENT; sending something DIFFERENT is a caller who meant to do a
          // real thing and needs to be told where that thing actually lives.
          if (!isEchoOfStored(v, projection.value(data, card))) {
            redirectedFields[k] = projection.destination;
          }
          continue;
        }
        if (!PATCHABLE_CARD_FIELDS.has(k)) {
          // #823 — #249 keeps ignoring unknown keys (forward-compat), but it
          // must SAY SO. Silently skipping made a malformed write and a correct
          // one indistinguishable: `relatedTo` at the top level instead of
          // nested under `relationships` returned 200 and stored no edge.
          // `by` is meta (the declared editor, #675), not a card field.
          ignoredFields.push(k);
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
      // #902 item 4 — THE WRITE-TIME GUARD. A card that gained a parent walks
      // up; any ancestor carrying `apex:X` applies label X to it and to its
      // descendants (they moved with it). Additive only; never strips. Runs
      // AFTER the fields are applied so it sees the parent this write set.
      if ('parent' in patch && patch.parent != null) applyApexLabels(data.cards, card.id);
      card.updatedAt = new Date().toISOString();
      bumpCardVersion(card);   // #534 — one bump per accepted PATCH, not per field
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
    // #534 — the CAS refusal, read outside the lock because that is where the
    // response is written. 409 carries the CURRENT version: a refusal that says
    // "no" without saying "no, and here is where we are" forces a blind retry.
    if (updated.conflict) {
      return sendJSON(res, 409, {
        error: `Card has moved on: you declared ifVersion but the current version is ${updated.currentVersion}. `
          + 'Re-read the card and reapply your edit — this is a yield, not a retry.',
        currentVersion: updated.currentVersion,
      });
    }
    // #823 — present only when something WAS dropped, so a clean write never
    // claims it ignored something (an empty array on every response would be
    // noise the caller learns to skip).
    // #1032 — the disclosure fields ride BOTH shapes. A caller who opted into a
    // small response must still learn that something was dropped; making the
    // cheap shape also the quiet one would trade tokens for silent data loss.
    // #1081 — ring the doorbell for the done-nudge, exactly as claim (:3649)
    // and release (:3687) do for theirs. The nudge was persisted, versioned and
    // event-logged and never notified, so a card entering `done` asked the room
    // for the next pull and reached NO seat, awake or idle. Three seats across
    // two toolchains confirmed zero live receipts before anyone noticed, and
    // only because a human screenshotted the board.
    //
    // Placed HERE deliberately: outside the write lock, after persistence, and
    // after the 404/409 guards — a refused write must never ring the bell. It
    // sits above both response shapes so it fires exactly once either way, and
    // notifyMcpOfPost stays fire-and-forget, so a down MCP server still cannot
    // break a PATCH.
    if (nudge) notifyMcpOfPost(nudge);

    const disclosures = {
      ...(ignoredFields.length ? { ignoredFields } : {}),
      ...(refusedFields.length ? { refusedFields } : {}),
      // #856 — same discipline: present only when a caller actually tried
      // something, absent on every read-modify-write echo.
      ...(Object.keys(redirectedFields).length ? { redirectedFields } : {}),
    };
    if (patch.return === 'id') {
      // ⭐ Not merely cheaper — it answers the question an append caller
      // actually has: "did my text land, and is the rest untouched?" They have
      // been answering that with len(before)+len(added)==len(after) and paying
      // for the whole body to do it.
      //
      // ⚠️ BYTES, in UTF-8, and the name says so. JS `.length` counts UTF-16
      // units and Python `len()` counts code points; those disagree on every
      // astral character, and this board's text is full of them. Bytes is the
      // one unit a caller in any language can reproduce.
      return sendJSON(res, 200, {
        id: updated.id,
        shortId: updated.shortId,
        version: updated.version,
        updatedAt: updated.updatedAt,
        descriptionBytes: Buffer.byteLength(updated.description || '', 'utf8'),
        ...disclosures,
      });
    }
    sendJSON(res, 200, { ...updated, ...disclosures });
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
        bumpCardVersion(card);   // #534 — a claim is a card write
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
      bumpCardVersion(card);   // #534 — a release is a card write
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
    // #843 — the discards this route already performed silently, now named.
    // #844 — AN ECHO IS NOT AN ATTEMPT: a read-modify-write client GETs a
    // column, changes `name`, and sends the whole object back. `id` comes along
    // unchanged. Reporting it there would fire the diagnostic on the most
    // ordinary client pattern in existence and train the room to skip the field.
    const ignoredFields = [];
    const refusedFields = [];
    const updated = await withWriteLock(async () => {
      const data = readBoard();
      const idx = findColumnIndex(data, columnId);
      if (idx < 0) return null;
      const col = data.columns[idx];
      for (const [k, v] of Object.entries(patch)) {
        if (isEchoOfStored(v, col[k])) continue;        // #844 — nothing was attempted
        if (k === 'id') { refusedFields.push(k); continue; } // immutable, and now said so
        if (!PATCHABLE_COLUMN_FIELDS.has(k)) { ignoredFields.push(k); continue; } // #299
        col[k] = v;
      }
      writeBoard(data, [columnEvent('update', col)]);
      return col;
    });
    if (!updated) return sendJSON(res, 404, { error: 'Column not found' });
    sendJSON(res, 200, {
      ...updated,
      ...(ignoredFields.length ? { ignoredFields: ignoredFields.sort() } : {}),
      ...(refusedFields.length ? { refusedFields: refusedFields.sort() } : {}),
    });
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

// #843 — the conversation route's OWN consumed-set, deliberately beside its own
// constructor rather than shared with any other route.
//
// ⛔ DO NOT MERGE THIS WITH `CREATE_CONSUMED_FIELDS` OR THE COLUMN SET. "Unknown"
// is route-relative and this family has proven it three times: `body` is real on
// /api/nodes and unknown on /api/cards, `priority` is the reverse, and a
// conversation has its own vocabulary again. A union would make every route
// accept every key silently; an intersection would make each route report its
// own real fields as ignored. `tests/conversation-column-diagnostics.test.mjs`
// fails on that refactor on purpose.
//
// ⚠️ Derived from what the CONSTRUCTOR reads, not from the stored object's keys:
// `id`, `mentions` and `createdAt` appear on the result but are computed here,
// so a client that sends them is sending something the server will discard.
const CONVERSATION_CONSUMED_FIELDS = new Set(['body', 'author', 'attachedTo', 'attachments']);

/**
 * Keys the caller sent that this route will silently drop. Empty when clean.
 *
 * Sorted, unlike the cards route's equivalent: the order is otherwise the
 * caller's own key order, which makes the diagnostic vary between two requests
 * that are wrong in exactly the same way. Nothing depends on the cards route's
 * unsorted output, so this is a divergence worth having rather than a
 * consistency worth keeping.
 */
function unconsumedConversationFields(body) {
  if (typeof body !== 'object' || body === null) return [];
  return Object.keys(body).filter((k) => !CONVERSATION_CONSUMED_FIELDS.has(k)).sort();
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
    // #125 — the DECLARED name, kept when it differs from the authenticated one.
    //
    // The MCP layer resolves the caller's seat from its session and writes that
    // into `author`; whatever the caller declared lands here instead of being
    // discarded. Both facts survive, separately named — which is the shape the
    // #258 comment in mcp-server.mjs insists on: folding an authenticated fact
    // and a self-declared one into one field produces a value that is sometimes
    // proven and sometimes not, with nothing on the surface saying which.
    //
    // ⚠️ THIS FIELD IS A RECORD, NOT A PROOF. It says "the caller asked to speak
    // as X", never "X was verified". A relay is a legitimate act in this room —
    // seats relay each other and @michael constantly — so it is preserved rather
    // than refused.
    //
    // ⛔ AND THERE IS DELIBERATELY NO `authorAuthenticated` FLAG HERE, though
    // #125's criterion 4 asks for one. `apiCall` in mcp-server.mjs sends NO auth
    // header, so this endpoint cannot distinguish the MCP server from any other
    // client that can reach the port. A proof flag accepted from the payload
    // would be MINTABLE BY ANYONE — a badge that anyone can forge is worse than
    // no badge, because it converts an open question into a false answer
    // (#593/#845, the lying-label class). Criterion 4 needs a verifiable trust
    // link between the two processes and that link does not exist yet.
    onBehalfOf: (typeof body.onBehalfOf === 'string' && body.onBehalfOf.length > 0) ? body.onBehalfOf : null,
    createdAt: now,
  };
}

function findConversationIndex(data, id) {
  return data.conversations.findIndex(c => c.id === id);
}

// Parse query string from req.url. Returns a plain object.
// #764 — USE URLSearchParams, NOT decodeURIComponent, and the difference is a
// whole class of silent zero-result queries.
//
// The hand-rolled version split on & and ran each half through
// decodeURIComponent. That decodes %20 but leaves `+` alone — and `+` is how
// application/x-www-form-urlencoded (and therefore URLSearchParams, and
// therefore the MCP adapter) encodes a space. So `label=building+scrum+board`
// was searched for as the literal string "building+scrum+board", which no card
// carries.
//
// ⛔ 200 OK. Zero cards. No error. The board's most-used label — 158 cards —
// was unqueryable by any agent using the MCP tool, and the caller could not
// distinguish "nothing matches" from "your query was mangled in transit".
//
// ⚠️ It was never label-specific. The parser is shared, so EVERY filter whose
// value can contain a space had it: assignee, `for`, column ids, and any filter
// added later. Renaming the data to suit a broken parser would have left the
// parser broken for the next value.
//
// URLSearchParams implements the form-urlencoded rules exactly: `+` decodes to
// a space, and a literal plus survives as %2B. Both directions are covered by
// tests/query-plus-encoding.test.mjs, including the paired control that a
// naive `.replace(/\+/g, ' ')` would fail.
function parseQuery(reqUrl) {
  const qIdx = reqUrl.indexOf('?');
  if (qIdx < 0) return {};
  const out = {};
  for (const [k, v] of new URLSearchParams(reqUrl.slice(qIdx + 1))) out[k] = v;
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
  'attachedTo', 'author', 'since', 'mentions_me', 'before', 'limit', 'q',
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
    // #1010 — FULL-TEXT SEARCH OVER THE WHOLE CORPUS, and it is 14ms.
    //
    // The commons UI has always had a search box. It filtered the messages the
    // client had already LOADED — 50 by default (#210) plus whatever "Load
    // older" had pulled in — and then rendered "No messages match your search."
    // A corpus-wide negative, asserted from a buffer-local check. @michael read
    // it the only way it can be read ("it routinely finds nothing even when I
    // know those terms exist") and diagnosed it himself: "maybe search is
    // intersecting that [load-older button]." It was.
    //
    // ⚠️ ORDER MATTERS: this filters BEFORE `limit`, so `?q=x&limit=50` means
    // "the 50 most recent MATCHES", not "matches among the 50 most recent".
    // The second is the bug this fixes, one layer down.
    //
    // Substring, case-insensitive, over the message body. Not an index, not a
    // tokeniser, no ranking — measured at 11-14ms across 18,489 messages, which
    // is why ADR-002's "JSON blob can't do full-text search" did not survive a
    // stopwatch (#319).
    if (typeof q.q === 'string' && q.q.trim() !== '') {
      const needle = q.q.trim().toLowerCase();
      // #1010 — body OR author, because the box's local filter always matched
      // both and the corpus search must not find LESS than the window did.
      convs = convs.filter((c) =>
        (typeof c.body === 'string' && c.body.toLowerCase().includes(needle))
        || (typeof c.author === 'string' && c.author.toLowerCase().includes(needle)));
    }
    // #210 — backward pagination for the browser's bounded load + load-older.
    // `before`: strictly older than the cursor (same safe string-compare as
    // `since`). `limit`: the N most-recent of the filtered set, capped so a
    // client can't request an unbounded slice. No-param stays uncapped (#202).
    if (typeof q.before === 'string') {
      convs = convs.filter(c => typeof c.createdAt === 'string' && c.createdAt < q.before);
    }
    // #1010 — THE MATCH COUNT, captured BEFORE the limit is applied.
    //
    // Measured 2026-08-24: `?q=deaf` returns all 671 matches (no-param stays
    // uncapped, #202), while `?q=deaf&limit=1000` returns 200 and says nothing.
    // So the defect is narrow and precise: a caller who asks for MORE than
    // MAX_CONV_LIST_LIMIT is silently clamped -- #1028's class on a second
    // endpoint ("returns fewer than asked without saying it clamped").
    //
    // ⭐ AND THE COST THIS REMOVES: obtaining the true count today means
    // fetching the uncapped set -- 1,736,095 bytes for `deaf`, because there is
    // no count-only mode. The header supplies the number for nothing, which is
    // what makes a "671 matches" surface affordable at all.
    //
    // ⛔ A HEADER, NOT AN ENVELOPE. This body is a BARE ARRAY and several
    // callers consume it as one; wrapping it in {messages, total} would break
    // every one of them to add a number. The header is additive -- a caller
    // that ignores it sees byte-identical output, and a test pins that.
    //
    // ⚠️ Counted after `q` AND `before`, i.e. over exactly the set `limit` is
    // about to slice. That is the only count from which a caller can compute
    // "I got N of M" without inference.
    //
    // ⚠️ Same-origin only, by omission: this server serves the board page, so
    // browser JS can read this header. A CROSS-origin caller would additionally
    // need Access-Control-Expose-Headers, and this endpoint sends no CORS
    // headers at all (#234). Not added here -- an Expose-Headers without an
    // Allow-Origin would be cargo, and the cross-origin case is #234's.
    const matchTotal = convs.length;
    res.setHeader('X-Total-Count', String(matchTotal));

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
    // #843 — say what was dropped. Present only when non-empty: an empty array
    // on every post is noise every seat learns to skip, which is how the
    // original silence went unnoticed. The stored record is NOT touched — the
    // diagnostic rides the response only.
    const ignoredFields = unconsumedConversationFields(body);
    sendJSON(res, 201, ignoredFields.length ? { ...created, ignoredFields } : created);
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
      if (card.parent != null) applyApexLabels(data.cards, card.id);   // #902 item 4 — born labelled
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
      if ('parent' in patch && patch.parent != null) applyApexLabels(data.cards, card.id);   // #902 item 4
      if ('attachments' in patch) card.attachments = sanitizeAttachments(patch.attachments); // #222
      card.updatedAt = new Date().toISOString();
      bumpCardVersion(card);   // #534 — a node update is a card write
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

/**
 * POST /api/cursors/served — #782 / Decision 5b43edcd. The MCP host reports that
 * it has WRITTEN conversation `conversationId` to the stream of the session
 * named by {identity, via}. Resolves the conversation's event seq here (the
 * log is REST's) and records it as served. Unknown lane or unknown event answer
 * `served:false` with a code — never a 200 that looks like success.
 */
async function handleCursorServed(req, res) {
  try {
    const body = JSON.parse((await readBody(req)) || '{}');
    const key = body.identity || deliveryIdentity(body)?.key;
    if (!key) return sendJSON(res, 400, { error: 'identity is required', code: 'NO_DELIVERY_IDENTITY' });
    if (!body.conversationId) return sendJSON(res, 400, { error: 'conversationId is required', code: 'NO_CONVERSATION' });
    const seq = seqOfEntityEvent(EVENT_LOG_DIR, { kind: 'conversation', id: String(body.conversationId), op: 'post' });
    if (seq == null) return sendJSON(res, 200, { served: false, code: 'EVENT_NOT_FOUND', identity: key });
    const out = markServed(EVENT_LOG_DIR, key, { seq, via: body.via ?? null });
    if (!out.known) return sendJSON(res, 200, { served: false, code: 'UNKNOWN_LANE', identity: key, seq });
    sendJSON(res, 200, { served: out.served === seq, identity: key, seq, last_served_seq: out.served, last_acked_seq: out.acked });
  } catch (e) {
    console.error('POST /api/cursors/served:', e.message);
    sendJSON(res, 500, { error: 'Failed to record served' });
  }
}

// ── Router: regex-based match against API_ROUTES ──
const API_ROUTES = [
  { method: 'GET',    re: /^\/api\/changes$/,              fn: (req, res) => handleChanges(req, res) },
  { method: 'GET',    re: /^\/api\/cursors$/,              fn: (req, res) => handleCursorReport(req, res) },
  { method: 'POST',   re: /^\/api\/cursors\/register$/,    fn: (req, res) => handleCursorRegister(req, res) },
  { method: 'GET',    re: /^\/api\/cursors\/pull$/,        fn: (req, res) => handleCursorPull(req, res) },
  { method: 'POST',   re: /^\/api\/cursors\/inbound$/,     fn: (req, res) => handleCursorInbound(req, res) },
  { method: 'POST',   re: /^\/api\/cursors\/served$/,      fn: (req, res) => handleCursorServed(req, res) },
  { method: 'POST',   re: /^\/api\/graph$/,                fn: (req, res) => handleGraphQuery(req, res) },
  { method: 'POST',   re: /^\/api\/search$/,               fn: (req, res) => handleSearch(req, res) },
  { method: 'GET',    re: /^\/api\/graph\/vocabulary$/,    fn: (req, res) => handleGraphVocabulary(req, res) },   // #1104
  { method: 'GET',    re: /^\/api\/ready$/,                fn: (req, res) => handleReady(req, res) },       // #815
  { method: 'GET',    re: /^\/api\/checks$/,               fn: (req, res) => handleChecks(req, res) },      // #792
  { method: 'GET',    re: /^\/api\/misses$/,               fn: (req, res) => handleMisses(req, res) },      // #801
  // #857 §IV — the controlled vocabulary. `collisions` is declared before the
  // bare aliases routes for the same reason the memory versions route is:
  // a static segment must not be swallowed as an id.
  { method: 'GET',    re: /^\/api\/labels\/collisions$/,    fn: (req, res) => handleLabelCollisions(req, res) },
  { method: 'GET',    re: /^\/api\/labels\/aliases$/,       fn: (req, res) => handleGetLabelAliases(req, res) },
  { method: 'POST',   re: /^\/api\/labels\/aliases$/,       fn: (req, res) => handleDeclareLabelAlias(req, res) },
  // #651 — memories. The versions route is declared BEFORE the bare :id route
  // so `/memories/<id>/versions` cannot be swallowed as an id containing a slash.
  { method: 'GET',    re: /^\/api\/decisions$/,            fn: (req, res) => handleListDecisions(req, res) },
  { method: 'GET',    re: /^\/api\/predicates$/,           fn: (req, res) => handleListPredicates(req, res) },
  { method: 'POST',   re: /^\/api\/predicates$/,           fn: (req, res) => handleRegisterPredicate(req, res) },
  { method: 'POST',   re: /^\/api\/assert$/,               fn: (req, res) => handleAssert(req, res) },
  { method: 'POST',   re: /^\/api\/decisions$/,            fn: (req, res) => handleCreateDecision(req, res) },
  { method: 'GET',    re: /^\/api\/wakes$/,                fn: (req, res) => handleListWakes(req, res) },
  { method: 'POST',   re: /^\/api\/wakes$/,                fn: (req, res) => handleCreateWake(req, res) },
  { method: 'GET',    re: /^\/api\/obligations$/,          fn: (req, res) => handleListObligations(req, res) },
  { method: 'POST',   re: /^\/api\/obligations$/,          fn: (req, res) => handleCreateObligation(req, res) },
  { method: 'PATCH',  re: /^\/api\/obligations\/([^\/]+)$/, fn: (req, res, m) => handleUpdateObligation(req, res, m[1]) },
  { method: 'GET',    re: /^\/api\/memories$/,             fn: (req, res) => handleListMemories(req, res) },
  { method: 'POST',   re: /^\/api\/memories$/,             fn: (req, res) => handleCreateMemory(req, res) },
  { method: 'GET',    re: /^\/api\/memories\/([^\/]+)\/versions$/, fn: (req, res, m) => handleMemoryVersions(req, res, m[1]) },
  { method: 'GET',    re: /^\/api\/memories\/([^\/]+)$/,   fn: (req, res, m) => handleGetMemory(req, res, m[1]) },
  { method: 'PATCH',  re: /^\/api\/memories\/([^\/]+)$/,   fn: (req, res, m) => handleUpdateMemory(req, res, m[1]) },
  { method: 'GET',    re: /^\/api\/board\/status$/,         fn: (req, res) => handleBoardStatus(req, res) },
  { method: 'GET',    re: /^\/api\/board$/,                fn: (req, res) => handleGetBoard(req, res) },
  { method: 'GET',    re: /^\/api\/seats\/state$/,          fn: (req, res) => handleSeatStates(req, res) },
  { method: 'PUT',    re: /^\/api\/seats\/([^\/]+)\/state$/, fn: (req, res, m) => handleSeatDeclare(req, res, decodeURIComponent(m[1])) },
  { method: 'DELETE', re: /^\/api\/seats\/([^\/]+)\/state$/, fn: (req, res, m) => handleSeatClear(req, res, decodeURIComponent(m[1])) },
  { method: 'GET',    re: /^\/api\/roster$/,               fn: (req, res) => handleGetRoster(req, res) },
  { method: 'GET',    re: /^\/api\/config\/limits$/,       fn: (req, res) => handleGetConfigLimits(req, res) },
  { method: 'GET',    re: /^\/api\/config$/,               fn: (req, res) => handleGetConfig(req, res) },
  { method: 'GET',    re: /^\/api\/channel-status$/,       fn: (req, res) => handleChannelStatus(req, res) },
  { method: 'POST',   re: /^\/api\/config$/,               fn: (req, res) => handleSetConfig(req, res) },
  // #953 — the tending silence threshold, same trust model as /api/config.
  { method: 'GET',    re: /^\/api\/tending-config$/,       fn: (req, res) => handleGetTendingConfig(req, res) },
  { method: 'POST',   re: /^\/api\/tending-config$/,       fn: (req, res) => handleSetTendingConfig(req, res) },
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
