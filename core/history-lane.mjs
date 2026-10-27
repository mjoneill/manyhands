/**
 * #1762 S4 v1.6–v1.6.3 — a LANE's log half once a valid, certified history frontier F exists.
 *
 * Past F the event log is not read. A lane is owed the canonical seq-nodes N with acked < N ≤ F.logSeq, and every advance
 * across them is PROVEN against F's committed Merkle root (core/history-proof.mjs):
 *
 *   1  the committed rank r of the first owed leaf is found by binary search over the tree's entries; every probed entry
 *      carries its FULL tuple, its leaf is recomputed from that tuple, and its audit path is verified at its claimed rank
 *      and L against F's root. The boundary N[r−1] ≤ acked < N[r] is read from those authenticated tuples, never from a
 *      count over the live graph (which is mutable).
 *   2  the page serves the CONSECUTIVE committed ranks r, r+1, …; each live canonical node must exist and its tuple must
 *      equal the authenticated entry's. A missing expected node, a substitution, a duplicate or a bad rank refuses.
 *   3  r = L (nothing owed) with acked < F.logSeq is the covered tail: authenticated by leaf L−1's N ≤ acked, it yields an
 *      empty page whose token moves the lane to F.logSeq, and only when acked.
 *
 * Every refusal is `HISTORY_COVERAGE_CHANGED` (or `HISTORY_LEGACY_POST_MISSING` for a post the conversations unit lost) and
 * happens before anything is served or committed. Scope (v1.6 §3): lossless coverage of the OWED range, not a re-proof of
 * facts already acked.
 */
import { leafHash, auditRanges, verifiesAt, HISTORY_FORMAT } from './history-proof.mjs';

const PROV = 'http://www.w3.org/ns/prov#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const BASE = 'https://scrumboard.local/';
const RS = `${BASE}ns#`, ACT = `${BASE}activity/`, ENT = `${BASE}entity/`, PERSON = `${BASE}person/`;
const HT = (p) => `urn:ex:ht${p}`;

const coverage = (why, extra = {}) => Object.assign(new Error(`the history coverage proof failed: ${why}`), { code: 'HISTORY_COVERAGE_CHANGED', ...extra });
const isInt = (b) => b && b.type !== 'uri' && b.datatype === `${XSD}integer` && /^-?\d+$/.test(b.value) && Number.isSafeInteger(Number(b.value));
const isLit = (b) => b && b.type !== 'uri';
const isHex = (b) => isLit(b) && /^[0-9a-f]{64}$/.test(b.value);

/** Reads the tree graph through `query` (one snapshot is the caller's fence), caching every subject it has read. */
function treeReader(query, tree) {
  const cache = new Map();   // subject IRI -> { pred: [terms] } | null (absent)
  const subjectOf = ([s, e]) => (e - s === 1 ? `${tree}/leaf/${s}` : `${tree}/node/${s}-${e}`);
  async function load(subjects) {
    const want = subjects.filter((x) => !cache.has(x));
    if (!want.length) return;
    const rows = await query(`SELECT ?s ?p ?o WHERE { GRAPH <${tree}> { VALUES ?s { ${want.map((x) => `<${x}>`).join(' ')} } ?s ?p ?o } }`);
    for (const x of want) cache.set(x, null);
    for (const b of rows) {
      const t = cache.get(b.s.value) || {};
      cache.set(b.s.value, t);
      (t[b.p.value] ||= []).push(b.o);
    }
  }
  const one = (t, p) => (t && t[p]?.length === 1 ? t[p][0] : null);
  /** a stored hash for a consumed range (a leaf entry's htLeaf, or a node's htHash with its own bounds checked), or null */
  function storedHash([s, e]) {
    const t = cache.get(subjectOf([s, e]));
    if (!t) return null;
    if (e - s === 1) { const h = one(t, HT('Leaf')); return isHex(h) ? h.value : null; }
    const st = one(t, HT('Start')), en = one(t, HT('End')), h = one(t, HT('Hash'));
    return isInt(st) && isInt(en) && Number(st.value) === s && Number(en.value) === e && isHex(h) ? h.value : null;
  }
  /** the AUTHENTICATED entry at committed rank i: its tuple recomputed, its leaf equal, its path verified to the root */
  async function entry(i, L, root) {
    const self = `${tree}/leaf/${i}`;
    const ranges = auditRanges(i, L);
    await load([self, ...ranges.map(subjectOf)]);
    const t = cache.get(self);
    if (!t) throw coverage(`no committed entry at rank ${i}`, { rank: i });
    const rank = one(t, HT('Rank')), N = one(t, HT('N')), used = one(t, HT('Used')), op = one(t, HT('Op')), kind = one(t, HT('Kind')), leaf = one(t, HT('Leaf'));
    if (!isInt(rank) || Number(rank.value) !== i) throw coverage(`the entry at rank ${i} names another rank`, { rank: i });
    if (!isInt(N) || Number(N.value) < 1 || !used || used.type !== 'uri' || !isLit(op) || !isLit(kind) || !isHex(leaf)) throw coverage(`the entry at rank ${i} is malformed`, { rank: i });
    const tuple = { N: Number(N.value), used: used.value, op: op.value, kind: kind.value };
    if (leafHash(tuple).toString('hex') !== leaf.value) throw coverage(`the entry at rank ${i} does not hash to its own leaf`, { rank: i });
    if (!verifiesAt(i, L, tuple, root, storedHash)) throw coverage(`the entry at rank ${i} is not committed under F's root`, { rank: i });
    return tuple;
  }
  return { entry };
}

/** The live canonical nodes for the given N, by a bounded query: N -> { used, op, kind, actor, shortId, at } */
async function liveNodes(query, Ns) {
  if (!Ns.length) return new Map();
  const P = { used: `${PROV}used`, op: `${RS}op`, kind: `${RS}entityKind`, actor: `${PROV}wasAssociatedWith`, shortId: `${RS}shortId`, at: `${RS}logRecordedAt` };
  const rows = await query(`SELECT ?a ?p ?o WHERE { VALUES ?a { ${Ns.map((n) => `<${ACT}seq-${n}>`).join(' ')} } ?a ?p ?o . FILTER(?p IN (${Object.values(P).map((x) => `<${x}>`).join(', ')})) }`);
  const by = new Map();
  for (const b of rows) {
    const n = Number(b.a.value.slice(`${ACT}seq-`.length));
    const t = by.get(n) || {}; by.set(n, t);
    const k = Object.keys(P).find((x) => P[x] === b.p.value);
    (t[k] ||= []).push(b.o);
  }
  return by;
}

/**
 * The log half of one lane page past F. `query(sparql)` → bindings; `readPost(id)` → {post} | {redacted} | {absent} | {unavailable}.
 * Returns { events, logHigh } — logHigh is the token's log half (the last served N, or F.logSeq for a proven covered tail,
 * or null when nothing in the log half moves). Throws HISTORY_COVERAGE_CHANGED / HISTORY_LEGACY_POST_MISSING before serving.
 */
export async function lanePageFromHistory({ query, readPost, F, acked, limit }) {
  const H = F.history;
  if (!H || H.format !== HISTORY_FORMAT) throw coverage('the frontier carries no history certificate');
  const L = H.leafCount;
  const tr = treeReader(query, H.tree);
  // 1 — the committed rank r of the first owed leaf: authenticated binary search (N strictly increases by rank)
  let lo = 0, hi = L;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((await tr.entry(mid, L, H.root)).N > acked) hi = mid; else lo = mid + 1;
  }
  const r = lo;
  if (r > 0 && (await tr.entry(r - 1, L, H.root)).N > acked) throw coverage(`the authenticated predecessor of rank ${r} is past the lane's position`);
  if (r === L) {
    // 3 — nothing owed below F: the covered tail, proven by leaf L−1 (authenticated above when L > 0) lying at or below acked
    return { events: [], logHigh: acked < F.logSeq ? F.logSeq : null };
  }
  // 2 — consecutive committed ranks, each matched to its LIVE node
  const k = Math.min(limit, L - r);
  const expected = [];
  for (let i = r; i < r + k; i++) expected.push(await tr.entry(i, L, H.root));
  if (expected[0].N <= acked) throw coverage(`the authenticated first owed entry (rank ${r}) is not past the lane's position`);   // the boundary's upper side
  for (let j = 1; j < expected.length; j++) if (expected[j].N <= expected[j - 1].N) throw coverage(`committed N does not strictly increase at rank ${r + j}`);
  const live = await liveNodes(query, expected.map((e) => e.N));
  const events = [];
  for (const [j, e] of expected.entries()) {
    const n = live.get(e.N);
    const one = (k2) => (n && n[k2]?.length === 1 ? n[k2][0] : null);
    if (!n) throw coverage(`the expected node N=${e.N} (rank ${r + j}) is missing`, { rank: r + j });
    const used = one('used'), op = one('op'), kind = one('kind');
    if (!used || used.type !== 'uri' || used.value !== e.used || !isLit(op) || op.value !== e.op || !isLit(kind) || kind.value !== e.kind) {
      throw coverage(`the live node N=${e.N} does not match its committed entry (rank ${r + j})`, { rank: r + j });
    }
    const id = e.used.startsWith(ENT) ? e.used.slice(ENT.length) : e.used;
    const actor = one('actor'); const sid = one('shortId'); const at = one('at');
    const ev = {
      seq: e.N, op: e.op, actor: actor && actor.value.startsWith(PERSON) ? decodeURIComponent(actor.value.slice(PERSON.length)) : null,
      recorded_at: at ? at.value : null,
      entity: { kind: e.kind, id, shortId: sid && /^\d+$/.test(sid.value) ? Number(sid.value) : null },
      state: null,
    };
    if (e.kind === 'conversation') {
      // A1 — a legacy post is served from the conversations unit; a redacted one is still an event, its text withheld
      const p = await readPost(id);
      if (p.unavailable) throw Object.assign(new Error(`the graph could not be read: ${p.unavailable}`), { code: 'GRAPH_EXECUTOR_UNAVAILABLE' });
      if (p.absent) throw Object.assign(new Error(`the legacy post ${id} (seq ${e.N}) is missing from the conversations unit`), { code: 'HISTORY_LEGACY_POST_MISSING', seq: e.N, entity: id });
      ev.state = p.redacted ? { id, redacted: true } : p.post;
    }
    events.push(ev);
  }
  return { events, logHigh: events.at(-1).seq };
}
