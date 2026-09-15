/**
 * #455 — THE ASK. One commons line per silence episode, addressed to the holder,
 * in the owner's own words from 2026-09-15: "what happened?"
 *
 * Consumes the `stale-claims` rows of the shared /api/checks read (#1388's
 * tick — this is a consumer, it never fetches). For each row it posts ONCE
 * per episode and remembers that it did, in a small state file beside the
 * adapter's other tending state, so a restart does not ask twice.
 *
 * An EPISODE is one stretch of silence: (card, claimedAt, the holder's last
 * write on the card, the next check they named). Any holder write on the
 * card changes that key — so a one-line "still on it, next observable is X"
 * clears it (#1001: the answer must be sayable in one line and must count),
 * and a fresh N of silence after that answer is a NEW episode, asked once
 * again. The same silence is never asked twice (#1359: an alarm that
 * re-fires on the seat that already answered it is noise the room learns
 * to ignore). Keys whose rows are gone are pruned, so the file stays small.
 *
 * ⛔ Nothing here releases or reclaims. Only the holder releases.
 * ⛔ The holder is named, not @-mentioned: a mention is a paid wake for some
 *    seats, and the line is meant to be READ by the room, not to bill it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The state lives beside the tending config (the board's data dir on prod,
// which the MCP plist already names) — never in the serve tree, which a
// deploy refreshes. An explicit env wins; with neither, the tree is the
// fallback a dev checkout expects.
export function staleClaimStateFilePath() {
  if (process.env.SCRUM_STALE_CLAIM_STATE_FILE) return process.env.SCRUM_STALE_CLAIM_STATE_FILE;
  if (process.env.SCRUM_TENDING_CONFIG_FILE) return path.join(path.dirname(process.env.SCRUM_TENDING_CONFIG_FILE), 'stale-claim-state.json');
  return path.join(__dirname, '..', 'stale-claim-state.json');
}

export const episodeKey = (r) => `${r.id}|${r.claimedAt}|${r.lastHolderWriteAt}|${r.quietUntil || ''}`;

const hours = (h) => (h >= 48 ? `${Math.round(h / 24)} d` : `${h} h`);

export function renderAsk(r) {
  const held = r.claimedAt ? hours(Math.round((Date.parse(r.lastHolderWriteAt) - Date.parse(r.claimedAt)) / 3.6e6 * 10) / 10 + r.silentHours) : '?';
  return `🕰 #${r.shortId} «${r.title}» — ${r.holder}, what happened? You've held it ${held} and nothing from you has landed on the card for ${hours(r.silentHours)}. `
    + `One line clears this, here or on the card: "still on it, next observable is <when>" — or release it with the exact remainder. `
    + `(#455: the board asks, it never reclaims.)`;
}

function readState(file) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return d && typeof d === 'object' && d.asked && typeof d.asked === 'object' ? d : { asked: {} }; } catch { return { asked: {} }; }
}
function writeState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2)); fs.renameSync(tmp, file);
}

/**
 * Pure: which rows have not been asked yet, and the pruned asked-set.
 * @param {Array<object>} rows   stale-claims rows
 * @param {Record<string,string>} asked   episodeKey → askedAt
 */
export function unasked(rows = [], asked = {}) {
  const keys = new Set(rows.map(episodeKey));
  const fresh = rows.filter((r) => !Object.prototype.hasOwnProperty.call(asked, episodeKey(r)));
  const kept = {};
  for (const [k, v] of Object.entries(asked)) if (keys.has(k)) kept[k] = v;
  return { fresh, asked: kept };
}

/**
 * @param {object} args
 * @param {string} args.now ISO
 * @param {Array<object>|null} args.rows  the `stale-claims` standing rows; null/undefined = unreadable ⇒ do nothing, forget nothing
 * @param {(body: object) => Promise<any>} args.post  POST /api/conversations
 * @param {string} [args.file]
 * @param {(line: string) => void} [args.log]
 */
export async function staleClaimAskTick({ now, rows, post, file = staleClaimStateFilePath(), log = () => {} }) {
  if (!Array.isArray(rows)) return { asked: 0, reason: 'rows unreadable' };
  const state = readState(file);
  const { fresh, asked } = unasked(rows, state.asked);
  let n = 0;
  for (const r of fresh) {
    try {
      await post({ author: 'board', body: renderAsk(r), attachedTo: null });
      asked[episodeKey(r)] = now;
      n += 1;
      log(`[#455] asked ${r.holder} about #${r.shortId} (silent ${r.silentHours} h)`);
    } catch (e) {
      log(`[#455] could not ask about #${r.shortId}: ${e?.message ?? e}`);   // not recorded: asked next tick
    }
  }
  writeState(file, { asked });
  return { asked: n };
}
