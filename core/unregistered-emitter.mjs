/**
 * core/unregistered-emitter.mjs — #1215 SAY IT.
 *
 * The board posts, AS ITSELF, the first time a scrum: type with no
 * KindDefinition is seen in the graph: the type, how many instances, one
 * example, and the one verb that clears it. Public, so the room reconciles in
 * the open; on the path of the action, so the writer does not choose whether
 * to warn. KEEP SAYING IT is the digest (#1216), which prints the same row
 * every morning it is still true; CLEAR is automatic, because the row is a
 * live query over the registry and vanishes when the kind is registered.
 *
 * Rails:
 *   - ONE post per newly-seen type, not one per tick and not one per instance:
 *     every commons post wakes N harnesses (#1212, #952).
 *   - several new types in one tick → ONE post naming them all.
 *   - a type that clears is forgotten, so a recurrence is announced again —
 *     it is a new fact, not a thirty-day-old one.
 *   - an unreadable checks surface says nothing and forgets nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function emitterStateFilePath() {
  return process.env.SCRUM_UNREGISTERED_STATE_FILE || path.join(__dirname, '..', 'unregistered-state.json');
}

const shortType = (t) => String(t).replace(/^https?:\/\/[^#]+#/, 'scrum:');

/**
 * Pure. Given the current unregistered-kinds rows and the set of types already
 * announced, return the types to announce now and the next announced set.
 */
export function newlySeen(rows = [], announced = []) {
  const current = new Set((rows || []).map((r) => shortType(r.type)).filter(Boolean));
  const prev = new Set(announced || []);
  const fresh = [...current].filter((t) => !prev.has(t));
  return { fresh, announced: [...current] };
}

export function renderAnnouncement(rows = [], fresh = []) {
  const byType = new Map((rows || []).map((r) => [shortType(r.type), r]));
  const lines = fresh.map((t) => {
    const r = byType.get(t) || {};
    const n = r.n != null ? `${r.n} instance${String(r.n) === '1' ? '' : 's'}` : 'instances';
    const eg = r.example ? `, e.g. ${String(r.example).replace(/^https?:\/\/[^/]+\/entity\//, 'entity:')}` : '';
    return `⚠️ \`${t}\` is in the graph (${n}${eg}) and NOT in the registry — kind_register it, or say why not.`;
  });
  return `${lines.join('\n')}\n(#1215: a kind nobody has said the meaning of. The write was accepted and nothing was lost; this row stays in /api/checks standing[] and in the daily digest until the kind is registered.)`;
}

function readState(file) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return d && typeof d === 'object' ? d : {}; } catch { return {}; }
}
function writeState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2)); fs.renameSync(tmp, file);
}

/**
 * One tick. `rows` returns the unregistered-kinds standing rows (may throw).
 * Posts at most ONE message, only for types not yet announced; records what was
 * announced AFTER the post succeeds, so a failed post is retried next tick.
 */
export async function emitterTick({ now, file = emitterStateFilePath(), rows, post, onError = () => {} }) {
  let current;
  try { current = rows(); }
  catch (e) { onError(`[#1215] unregistered-kinds rows unreadable — saying nothing, forgetting nothing: ${e?.message ?? e}`); return { posted: false, reason: 'rows-unreadable' }; }
  const st = readState(file);
  const { fresh, announced } = newlySeen(current, st.announced || []);
  if (fresh.length === 0) {
    if (JSON.stringify(announced) !== JSON.stringify(st.announced || [])) writeState(file, { ...st, announced, at: now });
    return { posted: false, reason: 'nothing-new', announced };
  }
  try { await post({ author: 'board', body: renderAnnouncement(current, fresh) }); }
  catch (e) { onError(`[#1215] announcement failed, will retry next tick: ${e?.message ?? e}`); return { posted: false, reason: 'post-failed', fresh }; }
  writeState(file, { ...st, announced, at: now });
  return { posted: true, fresh, announced };
}
