/**
 * core/digest.mjs — #1216 THE DAILY DIGEST.
 *
 * "A new type of message that runs on a schedule that collects any current
 * unresolved errors of this type and prints a daily digest… every 24 hours at
 * 3 AM unless the room is active." — the owner, 2026-09-05.
 *
 * A digest is a whisper whose body is not stored text: it is RENDERED at fire
 * time from `/api/checks` `standing[]` — every failing standing check, one
 * line each, with the count, HOW LONG it has been unresolved, the specific
 * things, and the one verb that clears it. The registry's unregistered-kinds
 * check (#1215) is its first customer; it prints all of them.
 *
 * Reuse, don't build a second scheduler: the quiet rule is `tendingTick`'s
 * (#953 — board posts do not count as activity, so the digest cannot keep the
 * room "active" by posting), the window is claimed exactly like a whisper's
 * (once, before delivery, fail-silent — see tending-tick.mjs), and every
 * firing is a TendingMint carrying the rendered body, so "what did the digest
 * say on the 12th" is a query.
 *
 * Rails, each paid for once already:
 *   1. NEVER post an empty digest — "nothing wrong" is silence (#1212, #952).
 *   2. Render the check's own TEXT, never a ✅/❌ of our own (#1162).
 *   3. "Unless the room is active" = the tending quiet rule, not a second one.
 *   4. AGE is the defence against being ignored (#727): first-seen is kept
 *      per item and forgotten when the item clears.
 *   5. The board is UTC: 03:00 CDT is 08:00Z, stated as UTC so DST moves nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tendingTick } from './tending-tick.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DIGEST_NOT_BEFORE_UTC_HOUR = 8;                 // 08:00Z = 03:00 CDT
const DAY_MS = 24 * 3600 * 1000;

export function digestStateFilePath() {
  return process.env.SCRUM_DIGEST_STATE_FILE || path.join(__dirname, '..', 'digest-state.json');
}

/** The 24 h window key, days beginning at 08:00Z: `digest:YYYY-MM-DD`. */
export function digestWindow(now, notBeforeHour = DIGEST_NOT_BEFORE_UTC_HOUR) {
  const shifted = new Date(Date.parse(now) - notBeforeHour * 3600 * 1000);
  return `digest:${shifted.toISOString().slice(0, 10)}`;
}

// The one verb that clears each check, by id. Unknown ids fall back to the
// generic pointer; a new standing check needs no code change here to appear.
const VERB = {
  'unregistered-kinds': 'kind_register',
  'unregistered-predicates': 'predicate_register',
  'phantom-block': 'clear the blocker entry (blockersUpsert status:cleared) or move the card',
};

function ageLabel(firstSeenAt, now) {
  const ms = Date.parse(now) - Date.parse(firstSeenAt);
  if (!Number.isFinite(ms) || ms < DAY_MS) return 'new';
  return `${Math.floor(ms / DAY_MS)} d`;
}

function itemKey(check, row) {
  return `${check.id}|${JSON.stringify(row, Object.keys(row).sort())}`;
}

function describeRow(row) {
  return Object.entries(row).map(([k, v]) => `${k}=${v}`).join(' ');
}

/**
 * Pure. Renders the failing standing checks into one body, and returns the
 * next first-seen map (items that stopped failing are dropped).
 *
 * @param {{standing: Array<{id:string, claim:string, rows?:object[], error?:string}>, now: string, firstSeen: object}} a
 * @returns {{body: string|null, firstSeen: object, items: number}}
 */
export function renderDigest({ standing, now, firstSeen = {} }) {
  const next = {};
  const lines = [];
  for (const check of standing || []) {
    if (!check || !check.id) continue;
    if (check.error) {
      // A check that could not run is NOT a clean check (#1162): it is printed
      // as what it is, so "anything automated sees green" cannot happen here.
      const key = `${check.id}|error`;
      next[key] = firstSeen[key] || now;
      lines.push(`🔴 ${check.id} could not run · ${ageLabel(next[key], now)} · ${check.error}  → fix the instrument before trusting its silence`);
      continue;
    }
    const rows = Array.isArray(check.rows) ? check.rows : [];
    if (rows.length === 0) continue;
    let oldest = now;
    const named = [];
    for (const row of rows) {
      const key = itemKey(check, row);
      next[key] = firstSeen[key] || now;
      if (next[key] < oldest) oldest = next[key];
      named.push(describeRow(row));
    }
    const shown = named.slice(0, 6).join(' · ') + (named.length > 6 ? ` · +${named.length - 6} more` : '');
    lines.push(`⚠️ ${rows.length} ${check.id} · oldest ${ageLabel(oldest, now)} · ${check.claim} · ${shown}  → ${VERB[check.id] || 'see /api/checks standing[]'}`);
  }
  if (lines.length === 0) return { body: null, firstSeen: {}, items: 0 };
  const total = Object.keys(next).length;
  const prev = Object.keys(firstSeen).length;
  const trend = prev ? ` (was ${prev} yesterday)` : '';
  const body = `${lines.length} standing check${lines.length === 1 ? '' : 's'} failing, ${total} item${total === 1 ? '' : 's'}${trend} — everything the board knows is wrong that nobody fixed:\n${lines.join('\n')}`;
  return { body, firstSeen: next, items: total };
}

function readState(file) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return d && typeof d === 'object' ? d : {}; }
  catch { return {}; }
}
function writeState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * One tick of the digest schedule. Everything injected, like tendingTick.
 *
 *   standing        () => standing[]  (from /api/checks) — may throw
 *   post            ({author, body}) => Promise
 *   onMinted        ({window, mintedAt, body}) => void   (provenance)
 *   quietAfterMinutes / lastActivityAt — the tending quiet rule, passed through
 *
 * Fails CLOSED on an unreadable checks surface: a skipped window self-heals
 * on the next tick; posting stale or empty words would not.
 */
export async function digestTick({
  now, file = digestStateFilePath(), standing, post, onMinted = null,
  quietAfterMinutes = null, lastActivityAt = null, log = () => {}, onError = () => {},
}) {
  const window = digestWindow(now);
  const st = readState(file);
  if (st.lastMintedWindow === window) return { minted: false, delivered: false, reason: 'already-minted', key: window };

  let checks;
  try { checks = standing(); }
  catch (e) {
    onError(`[#1216] standing checks unreadable — SKIPPING this window rather than posting stale words: ${e?.message ?? e}`);
    return { minted: false, delivered: false, reason: 'standing-unreadable', key: window };
  }
  const rendered = renderDigest({ standing: checks, now, firstSeen: st.firstSeen || {} });
  if (!rendered.body) {
    // Rail 1. The first-seen map is still advanced (items that cleared are
    // forgotten) but the window is NOT claimed — nothing was said.
    if (Object.keys(st.firstSeen || {}).length) writeState(file, { ...st, firstSeen: {} });
    return { minted: false, delivered: false, reason: 'nothing-to-say', key: window };
  }

  let mintedBody = null;
  const r = await tendingTick({
    now,
    quietAfterMinutes,
    lastActivityAt,
    // The mint claims the window (before delivery, fail-silent, like a whisper)
    // and carries the rendered body; a second call in the same window returns
    // null because the state file already names it.
    mint: ({ now: n }) => {
      const cur = readState(file);
      if (cur.lastMintedWindow === window) return null;
      writeState(file, { ...cur, lastMintedWindow: window, lastMintedAt: n, firstSeen: rendered.firstSeen });
      mintedBody = rendered.body;
      return { window: window.replace(/^digest:/, ''), body: rendered.body, mintedAt: n, slug: 'digest', versionId: null };
    },
    post: (b) => post({ author: 'board', body: b.body.replace(/^\[tending /, '[digest ') }),
    onMinted: (prompt, reached) => onMinted && onMinted({ window, mintedAt: prompt.mintedAt, body: mintedBody, reached }),
    log, onError,
  });
  return { ...r, key: window, items: rendered.items };
}
