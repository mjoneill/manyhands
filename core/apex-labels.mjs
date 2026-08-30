/**
 * core/apex-labels.mjs — #902 item 4: THE WRITE-TIME GUARD for the litmus test.
 *
 * The North Star's acceptance (#902, the owner's ruling): membership is ASSERTED
 * by a parent edge, never inferred from a label — and every card reachable from
 * an apex must carry that apex's label. The invariant was closed by hand on
 * 2026-08-30 (66 → 0) and would drift by growth the moment the next card was
 * nested without the label. This keeps it true at write time.
 *
 * HOW AN APEX DECLARES ITS LABEL (approved by the owner, 2026-08-30T12:45Z):
 * a label of the form `apex:<label>` on the apex card itself. #857 carries
 * `apex:manyhands`. Nothing about any board's taxonomy lives in this file —
 * the rule is generic: "any ancestor carrying `apex:X` applies `X`".
 *
 * THE RULE — APPLY, additive, reparent-preserves (design state on #902):
 *   · when a card gains or changes its parent, walk UP its ancestors; every
 *     `apex:X` found applies label `X` to the card AND to its descendants
 *     (they moved with it, so their ancestry changed too)
 *   · labels are only ever ADDED. Moving a card out from under an apex does
 *     not strip the label — a card that WAS a member is still about the thing;
 *     the edge says where it lives, the label says what it is about (§V)
 *   · a card already carrying the label is untouched (no duplicates)
 *
 * NOT the rule, on purpose:
 *   · inheriting the parent's OTHER labels — over-labels (a parent tagged
 *     `bug` would make every child a bug)
 *   · REQUIRE (refuse the edge until the label is present) — fails noisy and
 *     trains the bypass; the direction #902 §V says holds is edge ⇒ label
 *
 * Pure, browser-safe, no I/O. server.js calls applyApexLabels inside the write
 * lock on every path that writes `parent`.
 */

export const APEX_PREFIX = 'apex:';

/** The labels the ancestors of `parentId` declare via `apex:<label>`, walking up. */
export function apexLabelsAbove(cards, parentId) {
  const byId = new Map((cards || []).filter((c) => c && c.id).map((c) => [c.id, c]));
  const out = new Set();
  const seen = new Set();
  let cur = parentId ?? null;
  while (cur != null && !seen.has(cur)) {
    seen.add(cur);
    const node = byId.get(cur);
    if (!node) break;
    for (const l of node.labels || []) {
      if (typeof l === 'string' && l.startsWith(APEX_PREFIX) && l.length > APEX_PREFIX.length) out.add(l.slice(APEX_PREFIX.length));
    }
    cur = node.parent ?? null;
  }
  return out;
}

/** Ids of every descendant of `cardId` (children, grandchildren, …). */
export function descendantIds(cards, cardId) {
  const children = new Map();
  for (const c of cards || []) {
    if (!c || !c.id || c.parent == null) continue;
    if (!children.has(c.parent)) children.set(c.parent, []);
    children.get(c.parent).push(c.id);
  }
  const out = [];
  const stack = [...(children.get(cardId) || [])];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const k of children.get(id) || []) stack.push(k);
  }
  return out;
}

/**
 * Apply the apex labels to `card` (and its descendants) after its parent was
 * set. Mutates the card objects in place — this runs inside the server's write
 * lock on the board it is about to write. Returns [{id, added:[…]}] for every
 * card that actually changed, so the caller can bump/version/log only those.
 */
export function applyApexLabels(cards, cardId) {
  const byId = new Map((cards || []).filter((c) => c && c.id).map((c) => [c.id, c]));
  const card = byId.get(cardId);
  if (!card) return [];
  const changed = [];
  const targets = [card.id, ...descendantIds(cards, card.id)];
  for (const id of targets) {
    const c = byId.get(id);
    if (!c) continue;
    const want = apexLabelsAbove(cards, c.parent);
    if (want.size === 0) continue;
    const have = new Set(Array.isArray(c.labels) ? c.labels : []);
    const added = [...want].filter((l) => !have.has(l));
    if (added.length === 0) continue;
    c.labels = [...(Array.isArray(c.labels) ? c.labels : []), ...added];
    changed.push({ id, added });
  }
  return changed;
}
