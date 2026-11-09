/**
 * #1751 — the outbox SUMMARY: what the announce-publisher's audit needs, from a FIXED number of flat SELECTs over the
 * bookkeeping graph, instead of one readCommittedOrigin per stored origin (~8.5k executor calls per audit, ~1.2 M a day,
 * measured 2026-11-09). On the live store the two lists answer in ~150 ms.
 *
 * What it checks, and what it does NOT:
 *   counts       origins, obligations, obligations by status
 *   orphan       an Obligation whose obligationId (`<mutationId>:<slot>`) names no Origin
 *   mismatch     an Origin whose slotCount differs from the number of its Obligations (one or more)
 *   missing      an Origin with no Obligation at all
 *   retiredWithoutDisposition   a `retired` Obligation with no DispositionRecord in the recovery graph naming it (#1749 A8).
 *                PRESENCE only: the record's binding to the payload hash is the deep check's (origin-commit.mjs
 *                retiredByDisposition), done when the obligation was retired.
 *   badStatus    an Obligation with no status, or one outside pending/published/blocked/retired (review post 51949)
 *   cardinality  a field with more than one value on one record (two slotCounts, two statuses, …). Rows are grouped by
 *                RECORD, so such a record is counted once and flagged, never silently resolved to its last value.
 *   unsettled    origins with any obligation not in ONE recognised settled state (pending, no status, unknown status,
 *                ambiguous), or whose own fields are ambiguous. These are the only ones whose deep validation
 *                (readCommittedOrigin) can still change meaning, so the caller deep-checks THESE and nothing else.
 *                Settlement, not commit, is the key: an obligation's status changes in later ops (review post 51939).
 * NOT checked here: slot NAMES against the descriptor, digests, reservations. That is readCommittedOrigin's, which runs
 * on every publish and on the unsettled set. Also not seen: an Origin with NO mutationId and no obligations (it never
 * enters the join); unlikely, since the commit writes both together.
 *
 * The join is done HERE, not in SPARQL: a NOT EXISTS with a string-prefix join over the same data ran past 30 s on the
 * live store (aborted, 2026-11-09). Two flat lists and a Map join is O(n) in memory and O(1) in round trips.
 *
 * An unreadable executor is UNAVAILABLE with NO failure counts, so nothing downstream can read a clean zero from it.
 */
import { ORIGIN_TERMS as T, BK } from './graph-vocab.mjs';

const RG = '<urn:ex:postseq/recovery>';
const PSQ = (k) => `<urn:ex:postseq/${k}>`;

// ?o / ?ob are selected so rows are grouped BY RECORD: a field with two values is one record with a cardinality fault,
// never two records, and never one value silently overwriting the other (review post 51949)
export const Q_ORIGINS = `SELECT ?o ?m ?sc WHERE { GRAPH ${BK} { ?o a ${T.Origin} ; ${T.mutationId} ?m . OPTIONAL { ?o ${T.slotCount} ?sc } } }`;
export const Q_OBLIGATIONS = `SELECT ?ob ?id ?st WHERE { GRAPH ${BK} { ?ob a ${T.Obligation} ; ${T.obligationId} ?id . OPTIONAL { ?ob ${T.status} ?st } } }`;
const STATUSES = new Set(['pending', 'published', 'blocked', 'retired']);   // origin-commit.mjs OBLIGATION_STATUSES
const SETTLED = new Set(['published', 'blocked', 'retired']);
export const Q_DISPOSED = `SELECT DISTINCT ?id WHERE { GRAPH ${RG} { ?r a ${PSQ('DispositionRecord')} ; ${PSQ('obligationId')} ?id ; ${PSQ('decision')} ?d ; ${PSQ('obligationStatusAfter')} ?a . FILTER(STR(?d) = "retire-unsent-unknown" && STR(?a) = "retired") } }`;

const FIELD_NAMES = { m: 'mutationId', sc: 'slotCount', id: 'obligationId', st: 'status' };

const mutationOf = (obligationId) => {
  const i = obligationId.lastIndexOf(':');
  return i > 0 ? obligationId.slice(0, i) : null;
};

export async function outboxSummary(client) {
  const unavailable = (reason) => ({ ok: false, status: 'UNAVAILABLE', reason });
  const [o, b] = [await client.query(Q_ORIGINS), await client.query(Q_OBLIGATIONS)];
  if (!o.ok) return unavailable(`origins: ${o.reason}`);
  if (!b.ok) return unavailable(`obligations: ${b.reason}`);

  const cardinality = [];
  const group = (rows, subjectVar, fields) => {   // subject → { field → sorted distinct values }
    const g = new Map();
    for (const r of rows) {
      const s = r[subjectVar].value;
      if (!g.has(s)) g.set(s, Object.fromEntries(fields.map((f) => [f, new Set()])));
      for (const f of fields) if (r[f]) g.get(s)[f].add(r[f].value);
    }
    for (const [s, v] of g) for (const f of fields) {
      v[f] = [...v[f]].sort();
      if (v[f].length > 1) cardinality.push({ subject: s, field: FIELD_NAMES[f], values: v[f] });
    }
    return g;
  };

  const origins = new Map();   // mutationId → { slotCount (null when absent or ambiguous), ambiguous }
  for (const [, v] of group(o.rows, 'o', ['m', 'sc'])) {
    const sc = v.sc.length === 1 ? Number(v.sc[0]) : null;
    for (const m of v.m) origins.set(m, { slotCount: Number.isSafeInteger(sc) ? sc : null, ambiguous: v.m.length > 1 || v.sc.length > 1 });
  }
  const byOrigin = new Map();   // mutationId → [{obligationId, status, suspect}]
  const byStatus = {};
  const orphan = [], retired = [], badStatus = [];
  let obligations = 0;
  for (const [, v] of group(b.rows, 'ob', ['id', 'st'])) {
    obligations += 1;
    const status = v.st.length === 1 ? v.st[0] : null;
    const key = v.st.length === 0 ? 'none' : v.st.length > 1 ? 'ambiguous' : status;
    byStatus[key] = (byStatus[key] ?? 0) + 1;
    for (const obligationId of v.id) {
      if (v.st.length <= 1 && !STATUSES.has(status)) badStatus.push({ obligationId, status });
      if (status === 'retired') retired.push(obligationId);
      const m = mutationOf(obligationId);
      if (m == null || !origins.has(m)) { orphan.push({ obligationId, mutationId: m }); continue; }
      if (!byOrigin.has(m)) byOrigin.set(m, []);
      // anything but ONE recognised settled status sends its origin to the deep check
      byOrigin.get(m).push({ obligationId, status, suspect: v.id.length > 1 || !SETTLED.has(status) });
    }
  }

  const mismatch = [], missing = [], unsettled = [];
  for (const [m, { slotCount, ambiguous }] of origins) {
    const obs = byOrigin.get(m) ?? [];
    if (!obs.length) { missing.push({ mutationId: m, slotCount }); continue; }
    if (slotCount !== obs.length) mismatch.push({ mutationId: m, slotCount, obligations: obs.length });
    if (ambiguous || obs.some((x) => x.suspect)) unsettled.push(m);
  }

  let retiredWithoutDisposition = [];
  if (retired.length) {   // the third query runs only when there is something to check
    const d = await client.query(Q_DISPOSED);
    if (!d.ok) return unavailable(`dispositions: ${d.reason}`);
    const disposed = new Set(d.rows.map((r) => r.id.value));
    retiredWithoutDisposition = retired.filter((id) => !disposed.has(id)).map((obligationId) => ({ obligationId }));
  }

  const sortBy = (k) => (a, z) => String(a[k]).localeCompare(String(z[k]));
  return {
    ok: true,
    counts: { origins: origins.size, obligations, byStatus: Object.fromEntries(Object.entries(byStatus).sort()) },
    failures: {
      orphan: orphan.sort(sortBy('obligationId')),
      mismatch: mismatch.sort(sortBy('mutationId')),
      missing: missing.sort(sortBy('mutationId')),
      retiredWithoutDisposition: retiredWithoutDisposition.sort(sortBy('obligationId')),
      badStatus: badStatus.sort(sortBy('obligationId')),
      cardinality: cardinality.sort((a, z) => `${a.subject} ${a.field}`.localeCompare(`${z.subject} ${z.field}`)),
    },
    unsettled: unsettled.sort(),
  };
}
