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
 *
 * #1852 (supply): the extractor links each run it publishes to our cards (core/knowledge-linking-supply.mjs), and the end
 * post is where a person first sees that. It shows the few strongest proposed links, counts the rest, and points at the
 * run's readable page. A run whose links could not be made says so, with the reason.
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

const VERBS_SHOWN = 3;
/**
 * Count by the predicate actually WRITTEN; a proposed verb is summarised under it, never listed one per entry. On the
 * McKinsey PDF (2026-11-09) all 32 assertions were scrum:relatedTo with 32 different proposals, and listing each one
 * buried the edges. The verbs still appear on the edge lines.
 */
function byPredicate(published) {
  return tally(published.map((a) => a.predicate)).map(([p, n]) => {
    const verbs = published.filter((a) => a.predicate === p && a.proposedPredicate).map((a) => a.proposedPredicate);
    if (!verbs.length) return `${p} ${n}`;
    const distinct = tally(verbs).map(([v]) => v);
    const shown = distinct.slice(0, VERBS_SHOWN).join(', ') + (distinct.length > VERBS_SHOWN ? ', …' : '');
    return `${p} ${n} (${plural(verbs.length, 'proposed verb')}, ${distinct.length} distinct: ${shown})`;
  }).join(', ');
}

export function startBody({ url, modelKey, jobId, resumed = false }) {
  return `🧪 extraction ${resumed ? 'resuming' : 'started'}: ${url}\nmodel ${modelKey} · job ${jobId}${resumed ? ' (from its last checkpoint: the model is not asked again)' : ''} (#1862)`;
}

const LINKS_SHOWN = 3;
const TITLE_MAX = 60;
const GIST_MAX = 160;
const REASON_MAX = 200;
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cut = (s, max) => { const t = oneLine(s); return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t; };

/**
 * #1852 — the "may bear on" lines for one run, from what the linking step returned (null: the run was not linked, add nothing).
 * A card is shown once, by its strongest link, and the claim is shown by its GIST: the subject—verb→object triple is already
 * on the edge lines, and it is the gist that was searched. The total is always stated, so three lines never read as "three
 * links". Zero is said with the threshold and the number of claims searched, and a run that could not be linked says "not
 * made" with its reason: "no link" must never be able to mean "never searched" (#1851).
 */
function linkLines(links) {
  if (!links || typeof links !== 'object') return [];
  if (links.made !== true) return [`links: not made (${cut(links.reason, REASON_MAX) || 'no reason given'})`];
  const all = Array.isArray(links.links) ? links.links : [];
  if (all.length === 0) {
    const at = `at or above ${links.minScore}`;
    if (links.skipped > 0) return [`links: no new ones; ${plural(links.skipped, 'match', 'matches')} ${at} already had a link (proposed, confirmed or dismissed)`];
    return [`links: none of the ${plural(links.assertions ?? 0, 'claim')} matched a card ${at} (every claim was searched)`];
  }
  const out = [];
  const cards = new Set();
  for (const l of [...all].sort((a, b) => b.score - a.score)) {
    if (cards.has(l.card)) continue;
    cards.add(l.card);
    if (out.length >= LINKS_SHOWN) continue;   // keep counting the cards; show only the first few
    const what = [l.shortId != null ? `#${l.shortId}` : '', cut(l.title, TITLE_MAX)].filter(Boolean).join(' ');
    out.push(`🔗 may bear on ${what || 'a card'}: "${cut(l.gist, GIST_MAX)}"`);
  }
  out.push(`${plural(all.length, 'proposed link')} to ${plural(cards.size, 'card')} (machine guesses; answer them with link_decide)`);
  return out;
}

/**
 * #1852 — where a person reads the run: a page on this board, named by the last segment of the run IRI. It is a PATH, as
 * plain text: the commons renders bold, italic, lists and #NNN card links and nothing else (core/render.mjs), and nothing in
 * the code knows the board's public address, so there is no form of this that would be a link there today.
 */
const readingPath = (runId) => `/reading.html?run=${encodeURIComponent(String(runId).split('/').pop())}`;

export function finishBody({ url, result, links = null }) {
  const published = Array.isArray(result?.published) ? result.published : [];
  const rejected = Array.isArray(result?.rejected) ? result.rejected : [];
  const outcome = result?.outcome ?? 'unknown';
  const lines = [];
  lines.push(`${published.length ? '✅' : '⚠️'} extraction finished (${outcome}): ${url}`);
  if (published.length) {
    const withEdges = published.filter((a) => a.subject && a.object);
    lines.push(`wrote ${plural(published.length, 'assertion')} about ${plural(conceptCount(published), 'concept')}`
      + ` · by type: ${fmt(tally(published.map((a) => a.type ?? 'untyped')))}`
      + ` · by predicate: ${byPredicate(published)}`);
    if (withEdges.length) {
      for (const a of withEdges.slice(0, SHOWN)) lines.push(`  ${a.subject} —${a.predicate}→ ${a.object} (${a.type ?? 'untyped'}, ${a.proposedPredicate ? `proposed ${a.proposedPredicate}, ` : ''}${Number.isInteger(a.page) ? `page ${a.page}, ` : ''}block ${a.block})`);   // #1854: a file's claim names its page
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
    // #1867: the main call's finish reason, when the provider gave one ("stop" = the model finished on its own)
    const finish = typeof result?.stopReason === 'string' ? ` · model finished: ${result.stopReason}` : '';
    lines.push(`${proposals}span repairs ${repairs} · span inventions ${c.spanInventions ?? 0} · provider failures ${c.providerFailures ?? 0}${finish}`);
  }
  // #1870: the warning keys on the same verdict the failure count used, so a MISSING finish reason (finished:false) is
  // called out too, not left as an unexplained "provider failures 1".
  const unfinished = result?.finished === false || (typeof result?.stopReason === 'string' && result.stopReason !== 'stop');
  if (unfinished) {
    const why = typeof result?.stopReason === 'string' ? `"${result.stopReason}"` : 'no finish reason';
    lines.push(`⚠️ the model's answer did not finish (${why}), so none of it was used. This is not "the source had nothing more to say".`);
  }
  lines.push(...linkLines(links));
  if (result?.runId) {
    lines.push(`run ${result.runId}`);
    lines.push(`open it with graph_query: ${ofRunQuery(result.runId)}`);
    if (links) lines.push(`read it on the board: ${readingPath(result.runId)}`);
  }
  lines.push('(#1862)');
  return lines.join('\n');
}

/** `retryHow` says how a retry happens when it is not the tick (a file is resumed only by running it again, #1854). */
export function failBody({ url, reason, retry = false, retryHow = null }) {
  const pending = `still pending: ${retryHow || 'the next tick resumes it from its checkpoint'}.`;
  return `❌ extraction failed: ${url}\n${reason}\n${retry ? pending : 'not retried until someone shares it again.'} (#1862)`;
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
