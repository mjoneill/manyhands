/**
 * #1862 — an extraction run reports itself in the room, so a person can watch it happen and see what it wrote.
 *
 * Two posts per run, never a stream: one when a job starts on a source, one when it ends. The end post says what was
 * written BY TYPE (assertions, distinct concepts, each assertion type, each predicate, rejections by reason), shows a
 * few assertions as edges (subject —predicate→ object), names the run, and gives the graph query that opens exactly
 * that run's assertions. A job that fails gets one post naming the reason and whether it will be retried.
 *
 * Pure text here; the caller posts it. createAnnouncer wraps a `post(body)` so that a report can NEVER fail a job: a
 * post that throws comes back as { ok:false, error }, and the caller counts it.
 */
import { conceptIri } from './knowledge-extraction.mjs';

const SHOWN = 5;
const RS = 'https://scrumboard.local/ns#';

/**
 * The graph_query that opens one run's assertions, with the triple each one quotes UNPACKED into ?s ?p ?o: a triple
 * term in a result column is a 400 on the executor today (#1846), so the query never returns one.
 */
export function ofRunQuery(runId) {
  return `SELECT ?a ?type ?s ?p ?o ?proposed ?passage WHERE { ?a <${RS}ofRun> <${runId}> ; a <${RS}Assertion> ; `
    + `<http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies> ?t . BIND(SUBJECT(?t) AS ?s) BIND(PREDICATE(?t) AS ?p) BIND(OBJECT(?t) AS ?o) `
    + `OPTIONAL { ?a <${RS}assertionType> ?type } OPTIONAL { ?a <${RS}proposedPredicate> ?proposed } OPTIONAL { ?a <${RS}expressedIn> ?passage } }`;
}

const tally = (xs) => {
  const m = new Map();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
};
const fmt = (pairs) => pairs.map(([k, n]) => `${k} ${n}`).join(', ');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function conceptCount(published) {
  const iris = new Set();
  for (const a of published) for (const name of [a.subject, a.object]) {
    if (typeof name !== 'string' || !name.trim()) continue;
    try { iris.add(conceptIri(name)); } catch { /* a nameless concept is not counted */ }
  }
  return iris.size;
}

export function startBody({ url, modelKey, jobId, resumed = false }) {
  return `🧪 extraction ${resumed ? 'resuming' : 'started'}: ${url}\nmodel ${modelKey} · job ${jobId}${resumed ? ' (from its last checkpoint: the model is not asked again)' : ''} (#1862)`;
}

export function finishBody({ url, result }) {
  const published = Array.isArray(result?.published) ? result.published : [];
  const rejected = Array.isArray(result?.rejected) ? result.rejected : [];
  const outcome = result?.outcome ?? 'unknown';
  const lines = [];
  lines.push(`${published.length ? '✅' : '⚠️'} extraction finished (${outcome}): ${url}`);
  if (published.length) {
    const withEdges = published.filter((a) => a.subject && a.object);
    lines.push(`wrote ${plural(published.length, 'assertion')} about ${plural(conceptCount(published), 'concept')}`
      + ` · by type: ${fmt(tally(published.map((a) => a.type ?? 'untyped')))}`
      + ` · by predicate: ${fmt(tally(published.map((a) => a.proposedPredicate ? `${a.predicate} (proposed ${a.proposedPredicate})` : a.predicate)))}`);
    if (withEdges.length) {
      for (const a of withEdges.slice(0, SHOWN)) lines.push(`  ${a.subject} —${a.predicate}→ ${a.object} (${a.type ?? 'untyped'}, ${Number.isInteger(a.page) ? `page ${a.page}, ` : ''}block ${a.block})`);   // #1854: a file's claim names its page
      if (withEdges.length > SHOWN) lines.push(`  …and ${withEdges.length - SHOWN} more`);
    }
  } else {
    lines.push('nothing was written to the graph.');
  }
  if (rejected.length) lines.push(`${rejected.length} rejected: ${fmt(tally(rejected.map((r) => r.reason ?? 'unknown')))}`);
  const c = result?.counters;
  if (c && typeof c === 'object') {
    const proposals = Number.isInteger(result?.proposals) ? `${result.proposals} proposed · ` : '';
    const repairs = Number.isInteger(result?.repairs) ? result.repairs : 'not counted';
    lines.push(`${proposals}span repairs ${repairs} · span inventions ${c.spanInventions ?? 0} · provider failures ${c.providerFailures ?? 0}`);
  }
  if (result?.runId) {
    lines.push(`run ${result.runId}`);
    lines.push(`open it with graph_query: ${ofRunQuery(result.runId)}`);
  }
  lines.push('(#1862)');
  return lines.join('\n');
}

export function failBody({ url, reason, retry = false }) {
  return `❌ extraction failed: ${url}\n${reason}\n${retry ? 'still pending: the next tick resumes it from its checkpoint.' : 'not retried until someone shares it again.'} (#1862)`;
}

const BODIES = { start: startBody, finish: finishBody, fail: failBody };

/** Wrap a `post(body)` so that reporting never fails a job: every outcome is RETURNED, nothing is thrown. */
export function createAnnouncer({ post }) {
  if (typeof post !== 'function') throw new Error('createAnnouncer needs post(body)');
  return async function announce(event) {
    const make = BODIES[event?.kind];
    if (!make) return { ok: false, error: `unknown report kind ${JSON.stringify(event?.kind)}` };
    let body;
    try { body = make(event); } catch (e) { return { ok: false, error: `format: ${e?.message ?? e}` }; }
    try { const r = await post(body); return { ok: true, id: r?.id ?? null }; } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  };
}
