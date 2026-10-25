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

/** the size limits (measured 2026-10-25 on the 1.0 GB live backup: 2,467,536 quads, buckets 152k-156k quads, no blank-node
 *  subjects, the largest subject 547 quads; digest 101.9 s, Node peak 1.02 GiB, executor peak 959 MiB) */
export const MAX_BUCKET_QUADS = 400_000;
export const MAX_BUCKET_BYTES = 256 * 1024 * 1024;
const MAX_DEPTH = 3;

export class DigestTooLarge extends Error { constructor(msg) { super(msg); this.code = 'DIGEST_TOO_LARGE'; } }

const subjectKey = (b) => (b.s.type === 'bnode' ? '_' : crypto.createHash('sha256').update(b.s.value).digest('hex').slice(0, MAX_DEPTH));
const bucketFilter = (prefix) => (prefix === '_' ? 'FILTER(isBlank(?s))' : `FILTER(!isBlank(?s) && SUBSTR(SHA256(STR(?s)), 1, ${prefix.length}) = "${prefix}")`);
const ALL = '{ ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } }';

async function post(baseUrl, opId, body) {
  const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/query`, { method: 'POST', headers: { 'x-op-id': opId }, body });
  if (!r.ok) throw new Error(`content digest: a query answered ${r.status}`);
  return r;
}
/** a bucket's answer, read through the stream with a byte counter: past the cap the read is aborted and the digest refuses */
async function boundedJson(r, what) {
  const reader = r.body.getReader(); const chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_BUCKET_BYTES) { await reader.cancel(); throw new DigestTooLarge(`${what}'s answer exceeds ${MAX_BUCKET_BYTES} bytes`); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * The content digest of the store behind `baseUrl`. Returns { sha256, quads, recoveryQuads } where `quads` is the number of
 * digested lines and `recoveryQuads` the number in the recovery graph (a hold or record a caller may need to explain).
 *
 * The ORDER is defined by content alone, never by how the store was split to read it: every line is keyed by the first three
 * hex digits of sha256(its subject) ("_" for a blank-node subject, first), then by the line itself. A bucket over
 * MAX_BUCKET_QUADS is read as its 16 sub-buckets, to depth 3; one still over it at depth 3, or a blank-node bucket over it,
 * refuses DIGEST_TOO_LARGE before it is fetched. Each answer is also capped at MAX_BUCKET_BYTES as it streams.
 * STATED LIMIT: the caps bound what this process reads; the executor still materialises one bucket's answer before sending
 * it, so its memory is bounded only by the bucket split.
 */
export const BUCKETS = Object.freeze(['_', ...'0123456789abcdef']);
export async function contentDigest(baseUrl, { opId = `urn:ex:op/cutover/content-digest/${crypto.randomUUID()}` } = {}) {
  const h = crypto.createHash('sha256');
  let quads = 0, recoveryQuads = 0, excludedQuads = 0, q = 0;
  const leaves = [];
  const plan = async (prefix) => {
    const c = await boundedJson(await post(baseUrl, `${opId}/count/${prefix}/${q++}`, `SELECT (COUNT(*) AS ?n) WHERE { ${ALL} ${bucketFilter(prefix)} }`), `the count of bucket ${prefix}`);
    const n = Number(c.results.bindings[0]?.n?.value ?? 0);
    if (n <= MAX_BUCKET_QUADS) { if (n) leaves.push(prefix); return; }
    if (prefix === '_' || prefix.length >= MAX_DEPTH) throw new DigestTooLarge(`bucket ${prefix} holds ${n} quads, over ${MAX_BUCKET_QUADS}${prefix === '_' ? ' (blank-node subjects cannot be split)' : ` at depth ${MAX_DEPTH}`}`);
    for (const d of '0123456789abcdef') await plan(prefix + d);
  };
  for (const k of BUCKETS) await plan(k);
  for (const prefix of leaves) {
    const j = await boundedJson(await post(baseUrl, `${opId}/bucket/${prefix}/${q++}`, `SELECT ?g ?s ?p ?o WHERE { ${ALL} ${bucketFilter(prefix)} }`), `bucket ${prefix}`);
    const keyed = [];
    for (const b of j.results.bindings) {
      if (excluded(b)) { excludedQuads++; continue; }
      if (b.g?.value === RECOVERY_GRAPH) recoveryQuads++;
      keyed.push([subjectKey(b), `${termText(b.s)} ${termText(b.p)} ${termText(b.o)}${b.g ? ` ${termText(b.g)}` : ''} .`]);
    }
    keyed.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
    for (const [, l] of keyed) h.update(`${l}\n`);
    quads += keyed.length;
  }
  // the buckets must cover every quad: a quad whose bucket expression came back unbound would be silently left out
  const c = await boundedJson(await post(baseUrl, `${opId}/count`, `SELECT (COUNT(*) AS ?n) WHERE { ${ALL} }`), 'the total count');
  const total = Number(c.results.bindings[0]?.n?.value);
  if (total !== quads + excludedQuads) throw new Error(`content digest: the buckets cover ${quads + excludedQuads} quads, the store holds ${total}`);
  return { sha256: h.digest('hex'), quads, recoveryQuads };
}
