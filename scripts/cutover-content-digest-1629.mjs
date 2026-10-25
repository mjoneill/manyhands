/**
 * #1747 — the CONTENT PIN shared by step 2 (capture) and step 3 (mark): one digest of a store's quads, computed the same way
 * on both sides, so "the candidate is a copy of the captured content" is a comparison of two equal strings.
 *
 * The digest is sha256 over every quad of every graph as canonical N-Quads (blank-node labels kept as the store returns
 * them; measured to survive a file copy and a real --promote-epoch, #1747 46608), one per line, in a fixed total order:
 * by BUCKET (a quad's subject hashed to one of 16 hex buckets, blank-node subjects in a 17th), then sorted within the bucket.
 * Bucketing bounds memory to one bucket at a time at real size (the whole store as one SPARQL-JSON answer does not fit,
 * #1747 46635); the order is the same on both sides, so the digest is still a pure function of the content. Excluded: ONLY the
 * six dataset-marker predicates a promotion rewrites, at their defined location (subject <urn:ex:dataset>, in the
 * bookkeeping graph). commitSeq, datasetId and every other quad are digested (contract, approved 46611).
 *
 * Both sides are read through an executor's own SPARQL endpoint (step 2 serves the STOPPED source with --read-only, which
 * writes nothing), so there is one serialiser, never two that could disagree on escaping.
 */
import crypto from 'node:crypto';

export const DATASET_SUBJECT = 'urn:ex:dataset';
export const BOOKKEEPING = 'urn:scrum:bookkeeping:executor';
export const PROMOTION_PREDICATES = Object.freeze(['epoch', 'epochBase', 'incarnation', 'incarnationFrom', 'storeHome', 'storeHomeInode'].map((p) => `urn:ex:${p}`));
export const RECOVERY_GRAPH = 'urn:ex:postseq/recovery';

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
/** one SPARQL-JSON term as canonical N-Quads text */
export function termText(t) {
  if (!t) return '';
  if (t.type === 'uri') return `<${t.value}>`;
  if (t.type === 'bnode') return `_:${t.value}`;
  if (t.type === 'literal' || t.type === 'typed-literal') {
    if (t['xml:lang']) return `"${esc(t.value)}"@${t['xml:lang']}`;
    if (t.datatype && t.datatype !== 'http://www.w3.org/2001/XMLSchema#string') return `"${esc(t.value)}"^^<${t.datatype}>`;
    return `"${esc(t.value)}"`;
  }
  throw new Error(`content digest: an unknown term type ${t.type}`);
}

const excluded = (b) => b.g?.value === BOOKKEEPING && b.s.type === 'uri' && b.s.value === DATASET_SUBJECT && PROMOTION_PREDICATES.includes(b.p.value);

/**
 * The content digest of the store behind `baseUrl`. Returns { sha256, quads, recoveryQuads } where `quads` is the number of
 * digested lines and `recoveryQuads` the number in the recovery graph (a hold or record a caller may need to explain).
 */
export const BUCKETS = Object.freeze(['_', ...'0123456789abcdef']);
export async function contentDigest(baseUrl, { opId = `urn:ex:op/cutover/content-digest/${crypto.randomUUID()}` } = {}) {
  const h = crypto.createHash('sha256');
  let quads = 0, recoveryQuads = 0, excludedQuads = 0;
  for (const k of BUCKETS) {
    const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/query`, {
      method: 'POST', headers: { 'x-op-id': `${opId}/${k}` },
      body: `SELECT ?g ?s ?p ?o WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } FILTER(IF(isBlank(?s), "_", SUBSTR(SHA256(STR(?s)), 1, 1)) = "${k}") }`,
    });
    if (!r.ok) throw new Error(`content digest: the query for bucket ${k} answered ${r.status}`);
    const lines = [];
    for (const b of (await r.json()).results.bindings) {
      if (excluded(b)) { excludedQuads++; continue; }
      if (b.g?.value === RECOVERY_GRAPH) recoveryQuads++;
      lines.push(`${termText(b.s)} ${termText(b.p)} ${termText(b.o)}${b.g ? ` ${termText(b.g)}` : ''} .`);
    }
    lines.sort();
    for (const l of lines) h.update(`${l}\n`);
    quads += lines.length;
  }
  // the buckets must cover every quad: a quad whose bucket expression came back unbound would be silently left out
  const c = await fetch(`${baseUrl.replace(/\/+$/, '')}/query`, { method: 'POST', headers: { 'x-op-id': `${opId}/count` },
    body: 'SELECT (COUNT(*) AS ?n) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }' });
  if (!c.ok) throw new Error(`content digest: the count query answered ${c.status}`);
  const total = Number((await c.json()).results.bindings[0]?.n?.value);
  if (total !== quads + excludedQuads) throw new Error(`content digest: the buckets cover ${quads + excludedQuads} quads, the store holds ${total}`);
  return { sha256: h.digest('hex'), quads, recoveryQuads };
}
