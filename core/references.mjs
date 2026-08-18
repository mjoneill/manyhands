/**
 * core/references.mjs — card→card references, DERIVED from text (#656 step 3).
 *
 * Cards cite each other constantly, in prose: "follows on from #123",
 * "fix(#810): …", "see #45". Every one of those is a real connection that the
 * graph could not see, because it lived in a string. Measured on the live
 * board: 359 of 790 cards (45%) had no edge of any kind, and 265 of them
 * carried a `#NNN` in their own text.
 *
 * ⭐ NOTHING HERE IS STORED. The edges are computed at projection time from the
 * card text that is their only authority, and dropped on the way back in. There
 * is no second copy, so there is no sync code and nothing to drift: edit a
 * card's body and its edges are already correct on the next read.
 *
 * Pure functions, no I/O (ADR-002 D1) — the same shape as core/links.mjs, which
 * derives the wiki's `[[wikilink]]` graph and stores nothing either.
 */

/**
 * The predicate. WEAK by design: *"this card's text mentions that card."* True
 * of every edge it produces with zero interpretation.
 *
 * ⛔ NOT `relatedTo` — that is a deliberate assertion a person made and the
 * server maintains its inverse (#614). Pouring 2,695 incidental edges into it
 * would leave no way to tell the deliberate ones apart.
 *
 * ⛔ NOT the bare `mentions` — that term is already occupied by ~12k Comment
 * nodes holding regex-scraped person handles, and typing it @id would mint IRIs
 * for strangers who never touched this board (#619's consent guard; see the
 * @context in core/jsonld.mjs, where its absence is deliberate and pinned by a
 * test). @context terms are document-wide: one container cannot hold both
 * facts, because they need opposite treatments.
 */
export const MENTIONS_CARD = 'scrum:mentionsCard';

/**
 * A `#NNN` card reference. Word-boundary guarded so `abc#5` and URL fragments
 * don't match, numeric-only so `#heading` stays prose — the same shape the two
 * renderers already use (core/render.mjs, core/conversation-view.mjs), because
 * the graph should recognise exactly what a reader sees rendered as a link.
 */
const CARD_REF_RE = /(?<!\w)#(\d+)/g;

/**
 * Every `#NNN` shortId in `text`, first-seen order, deduplicated.
 *
 * Deduplicated because the predicate is "mentions", not "mentions N times": a
 * multiplicity the edge does not claim must not appear in the data.
 */
export function parseCardRefs(text) {
  if (typeof text !== 'string' || text === '') return [];
  const out = [];
  const seen = new Set();
  for (const m of text.matchAll(CARD_REF_RE)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(m[1]);
  }
  return out;
}

/**
 * The derived edges for one card node, as target @ids — or `null` when there
 * are none.
 *
 * `null` rather than `[]` on purpose: the caller emits the property only when
 * this returns something, keeping the projection presence-preserving. An empty
 * array on every card asserts "we looked and found none" 790 times.
 *
 * Both the title and the body are scanned: card titles routinely carry the
 * reference ("fix(#123): …"), and reading only the body would miss them
 * silently.
 *
 * Two kinds of reference are dropped:
 *   - SELF — true, and useless: it connects nothing to nothing.
 *   - UNRESOLVED — a `#NNN` naming no card in this graph. ⚠️ Deliberately
 *     unlike stored `relationships`, where an unknown shortId rides VERBATIM
 *     because a person put it there and losslessness beats tidiness. This is
 *     derived and re-derivable, so dropping loses nothing — and an @id edge to
 *     a node that is not in the graph is a dangling pointer, not a connection.
 *
 * @param {object} node        card node (nested-facet or flat — only name/text/@id are read)
 * @param {Map<string,string>} shortToId  shortId → @id, over the whole graph
 */
export function deriveCardReferences(node, shortToId) {
  const refs = parseCardRefs(`${node?.name ?? ''}\n${node?.text ?? ''}`);
  if (refs.length === 0) return null;
  const targets = [];
  for (const short of refs) {
    // ⛔ THE SHORTID IS A NUMBER ON THE LIVE BOARD AND A STRING OUT OF THE
    // REGEX. `shortToId` is keyed by whatever `identifier` actually holds, and
    // on all 792 cards of the real board that is a NUMBER — so `.get('98')`
    // misses `98` and every card silently produces no edges. Caught only
    // because the measuring script refused to print a zero it could not
    // distinguish from a broken instrument; a fixture using string identifiers
    // was green through the whole build.
    const id = shortToId.get(short) ?? shortToId.get(Number(short));
    if (id === undefined) continue;        // unresolved — not a traversable edge
    if (id === node['@id']) continue;      // self
    targets.push(id);
  }
  return targets.length > 0 ? targets : null;
}
