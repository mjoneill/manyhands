/**
 * #1639 — THE BOARD'S COLUMNS in the graph, behind `SCRUM_GRAPH_UNIT_COLUMNS=1`. The same machinery as the #1624
 * collections (core/collections-unit.mjs): ONE family, key `columns`, so a column is written through the compiler's
 * `entity.put` kind 'collection' (guarded by its version, its bookkeeping — `ver`, `entityJson`, recordedBy — in the
 * bookkeeping graph) and read back from the graph only.
 *
 * Node shape (the builder's decision on the card, 2026-10-09 03:32Z), at `https://scrumboard.local/column/<id>`:
 *   <iri> a scrum:Column ; schema:identifier "<id>" ; schema:name "<name>" ; scrum:order <xsd:integer> ; scrum:inCollection "columns"
 * The projection is the replica's own (`projectEntity` on a `scrum:Column` node), so graph_query reads the same triples.
 *
 * The board speaks plain columns ({id, name, order, …}); the unit speaks the document's typed nodes. The two
 * translations below are the document's own (core/jsonld.mjs #687): lossless both ways.
 */
import { createCollectionsUnit, CollectionsUnavailable } from './collections-unit.mjs';
import { durableUpdate } from './durable-update.mjs';
import { columnIri } from './jsonld.mjs';

export const COLUMNS_KEY = 'columns';
export const COLUMNS_FAMILY = Object.freeze({ key: COLUMNS_KEY, routes: ['/api/columns'] });

/**
 * {id, name, order, …rest} → the typed node the graph stores (the document's columnToNode). The IRI is `columnIri(id)`
 * (core/jsonld.mjs), the same rule a card's scrum:column uses, so the two join; the id itself is kept whole in
 * `identifier`, which is what a read gives back.
 */
export const columnToNode = ({ id, name, order, ...rest }) => ({ '@type': 'scrum:Column', '@id': columnIri(id), identifier: id, name, 'scrum:order': order, ...rest });
/** The typed node → the plain column the board and the wire use (the document's nodeToColumn). */
export const nodeToColumn = ({ '@type': _t, '@id': _i, identifier, name, 'scrum:order': order, ...rest }) => ({ id: identifier, name, order, ...rest });

/** The stored order, then the id: the order a board shows and the order "the first remaining column" is taken from. */
const byOrder = (a, b) => (Number(a.order) - Number(b.order)) || String(a.id).localeCompare(String(b.id));

export function createColumnsUnit({ client, mintId, actorIri = (who) => `https://scrumboard.local/person/${encodeURIComponent(who || 'board')}` }) {
  const inner = createCollectionsUnit({ client, families: [COLUMNS_FAMILY], mintId, actorIri });
  const asData = (columns) => ({ [COLUMNS_KEY]: (Array.isArray(columns) ? columns : []).filter((c) => c && typeof c.id === 'string' && c.id).map(columnToNode) });

  /** A fresh mutable array of the graph's columns, in their stored order. Throws CollectionsUnavailable when not current. */
  function snapshot() {
    return inner.snapshot()[COLUMNS_KEY].map(nodeToColumn).sort(byOrder);
  }
  /** The guarded collection parts that turn the cache into `columns` ([] when nothing changed). */
  const plan = (columns) => inner.plan(asData(columns));
  /** After APPLIED: the cache becomes `columns`. */
  const applied = (columns, parts) => inner.applied(asData(columns), parts);

  /**
   * A write of column parts, with any other collection parts riding the SAME update (one conjunctive guard): one
   * entity.put kind 'collection'. `extraParts` are another unit's (the caller calls that unit's `applied` itself).
   */
  async function commit(columns, { actor, opId, extraParts = [] } = {}) {
    const own = plan(columns);
    const parts = [...extraParts, ...own];
    if (!parts.length) return { outcome: 'NOOP' };
    const intention = { kind: 'entity.put', opId: opId || `urn:ex:op/columns/${mintId()}`, actor: actorIri(actor), entity: { kind: 'collection', parts } };
    let r;
    try { r = await durableUpdate(client, intention); } catch (e) { inner.markUncertain(); throw new CollectionsUnavailable(e.message); }
    if (r.outcome !== 'APPLIED') {
      if (r.outcome !== 'UNAVAILABLE') inner.markUncertain();
      if (r.outcome === 'PRECONDITION_FAILED') throw Object.assign(new Error(`collection write refused: ${r.outcome}${r.reason ? `: ${r.reason}` : ''}`), { code: 'CARD_WRITE_CONFLICT' });
      if (r.outcome === 'REJECTED') throw new Error(`the executor rejected a column write: ${r.reason || 'no reason given'}`);
      throw new CollectionsUnavailable(`the write's outcome is ${r.outcome}${r.reason ? `: ${r.reason}` : ''}`);
    }
    if (own.length) applied(columns, own);
    return { outcome: 'APPLIED', parts: parts.length };
  }

  return {
    load: inner.load, ensureFresh: inner.ensureFresh, reachable: inner.reachable, markUncertain: inner.markUncertain,
    snapshot, plan, applied, commit,
    get generation() { return inner.generation; }, get loaded() { return inner.loaded; }, get uncertain() { return inner.uncertain; },
  };
}
