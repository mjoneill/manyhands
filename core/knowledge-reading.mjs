/**
 * #1894 — a run the board has read, as a page a person can open.
 *
 * The extraction job (#1810) writes a Source and its claims into the graph, but the owner cannot query the graph: until now
 * he saw a run's content only when an agent pasted it into chat. This module is the READER for the two routes behind
 * reading.html: the queries, and the shaping of their rows. It never writes, and the server does the I/O (LOGBORN.query).
 *
 * Three decisions worth knowing before changing it:
 *   - Claims are shown as the model's GIST plus the verbatim QUOTE, never as a sentence built from the subject-verb-object
 *     triple: measured 2026-11-14, the triple loses context the gist keeps. The proposed verb rides along as a small field.
 *   - SOURCE ORDER is the passage's block number, numerically (`block/8` before `block/10`). A lexical sort is wrong.
 *   - A claim's PAGE is not in the graph (#1854 says so). For a file the kept converted text is on disk, named by its hash,
 *     and the page is computed from it with the same function the finish post used. The path is DERIVED from the source's
 *     hash, never read from the graph, and the file is accepted only if its bytes hash back to that name.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LOGBORN_TERMS as TM } from './graph-compiler.mjs';
import { blocksOf } from './knowledge-extraction.mjs';
import { pageOfBlock } from './knowledge-extraction-file.mjs';

// `op` and `prov:used` are the run activity's own terms (written by the research verbs, not by a log-born record kind), so
// they are not in LOGBORN_TERMS. They are derived from namespaces that table does hold; the REST rows check them end to end.
const SCRUM = TM.Assertion.slice(0, -'Assertion'.length);
const PROV = TM.startedAtTime.slice(0, -'startedAtTime'.length);
const T = { ...TM, op: `${SCRUM}op`, used: `${PROV}used` };

const ACTIVITY = 'https://scrumboard.local/activity/';
const SOURCE = 'https://scrumboard.local/source/';
export const RUN_ID_RE = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** The run id goes into SPARQL, so only `run-` + a lowercase UUID is ever accepted. */
export const isRunId = (id) => typeof id === 'string' && RUN_ID_RE.test(id);
export const runIri = (id) => {
  if (!isRunId(id)) throw new Error(`not a run id: ${JSON.stringify(String(id).slice(0, 60))}`);
  return `${ACTIVITY}${id}`;
};
export const runIdOf = (iri) => String(iri).slice(ACTIVITY.length);

const lit = (r, k) => (r[k] ? r[k].value : null);
const int = (r, k) => (r[k] ? Number(r[k].value) : null);

/**
 * Every run the room started, with its source, its report (when it wrote one) and the post that asked for it. One row per
 * run; `only` narrows it to one run for the detail page. A run with no report died before it finished: it is still a row.
 */
export function runsQuery(only = null) {
  const pin = only ? `VALUES ?r { <${runIri(only)}> } ` : '';
  return `SELECT ?r ?src ?st ?out ?at ?name ?url ?abs ?seq ?asked WHERE { ${pin}?r <${T.op}> "extract" ; <${T.used}> ?src `
    + `OPTIONAL { ?r <${T.startedAtTime}> ?st } `
    + `OPTIONAL { ?rep a <${T.ExtractionReport}> ; <${T.ofRun}> ?r ; <${T.outcome}> ?out OPTIONAL { ?rep <${T.at}> ?at } } `
    + `OPTIONAL { ?src <${T.name}> ?name } OPTIONAL { ?src <${T.url}> ?url } OPTIONAL { ?src <${T.abstract}> ?abs } `
    + `OPTIONAL { ?src <${T.wasDerivedFrom}> ?post . ?post <${T.postSeq}> ?seq OPTIONAL { ?post <${T.dateCreated}> ?asked } } }`;
}

const valuesOf = (ids) => `VALUES ?r { ${ids.map((i) => `<${runIri(i)}>`).join(' ')} }`;

/** How many claims each run wrote, counted from the claims themselves (not the report's own count). */
export function claimCountsQuery(ids) {
  return `SELECT ?r (COUNT(DISTINCT ?a) AS ?n) WHERE { ${valuesOf(ids)} ?a <${T.ofRun}> ?r ; a <${T.Assertion}> } GROUP BY ?r`;
}

/** Links from a run's claims to cards, counted per status. */
export function linkCountsQuery(ids) {
  return `SELECT ?r ?st (COUNT(DISTINCT ?l) AS ?n) WHERE { ${valuesOf(ids)} ?a <${T.ofRun}> ?r ; a <${T.Assertion}> . `
    + `?l a <${T.BearsOn}> ; <${T.fromAssertion}> ?a ; <${T.status}> ?st } GROUP BY ?r ?st`;
}

/** Every claim of one run. The triple is never selected: a triple term in a result column is a 400 on the executor (#1846). */
export function claimsQuery(id) {
  return `SELECT ?a ?type ?verb ?pass ?gist ?span WHERE { ?a <${T.ofRun}> <${runIri(id)}> ; a <${T.Assertion}> `
    + `OPTIONAL { ?a <${T.expressedIn}> ?pass } OPTIONAL { ?a <${T.assertionType}> ?type } OPTIONAL { ?a <${T.proposedPredicate}> ?verb } `
    + `OPTIONAL { ?a <${T.gist}> ?gist } OPTIONAL { ?a <${T.anchorText}> ?span } }`;
}

/** Every link from one run's claims to a card. */
export function claimLinksQuery(id) {
  return `SELECT ?l ?a ?c ?st ?sc WHERE { ?a <${T.ofRun}> <${runIri(id)}> ; a <${T.Assertion}> . `
    + `?l a <${T.BearsOn}> ; <${T.fromAssertion}> ?a ; <${T.bearsOnCard}> ?c ; <${T.status}> ?st OPTIONAL { ?l <${T.score}> ?sc } }`;
}

export function outcomeOf(r) {
  // no report = the run never finished writing: say so, never "complete"
  return lit(r, 'out') ?? 'unfinished';
}

/** One run's header fields from a row of runsQuery. */
export function runHeader(r) {
  return {
    id: runIdOf(r.r.value),
    outcome: outcomeOf(r),
    startedAt: lit(r, 'st'),
    finishedAt: lit(r, 'at'),
    source: { title: lit(r, 'name'), url: lit(r, 'url'), synopsis: lit(r, 'abs') },
    askedIn: r.seq ? { postSeq: int(r, 'seq'), at: lit(r, 'asked') } : null,
    sourceIri: r.src.value,
  };
}

/**
 * One header per run. The same source can be asked for in more than one post (production, 2026-11-14: two runs name two posts each),
 * and the query then returns a row per post; they are one run, and the post named is the FIRST one that asked.
 */
export function headersOf(rows) {
  const byId = new Map();
  for (const r of rows) {
    const h = runHeader(r);
    const kept = byId.get(h.id);
    if (!kept || (h.askedIn && (!kept.askedIn || h.askedIn.postSeq < kept.askedIn.postSeq))) byId.set(h.id, h);
  }
  return [...byId.values()];
}

const when = (h) => h.finishedAt ?? h.startedAt ?? '';

/** The runs, newest first (an ISO instant sorts as text), and `truncated` honest about the cap. */
export function shapeRuns({ runRows, claimRows, linkRows, limit }) {
  const claims = new Map(claimRows.map((r) => [runIdOf(r.r.value), int(r, 'n')]));
  const links = new Map();
  for (const r of linkRows) {
    const id = runIdOf(r.r.value);
    const m = links.get(id) ?? { proposed: 0, confirmed: 0, dismissed: 0 };
    if (r.st.value in m) m[r.st.value] += int(r, 'n');
    links.set(id, m);
  }
  const heads = headersOf(runRows).sort((a, b) => (when(a) < when(b) ? 1 : when(a) > when(b) ? -1 : a.id.localeCompare(b.id)));
  const truncated = heads.length > limit;
  return {
    readings: heads.slice(0, limit).map(({ sourceIri, source, ...h }) => {
      const by = links.get(h.id) ?? { proposed: 0, confirmed: 0, dismissed: 0 };
      return { ...h, title: source.title, url: source.url, claims: claims.get(h.id) ?? 0, links: by.proposed + by.confirmed, linksByStatus: by };
    }),
    truncated,
  };
}

/** The block number a passage IRI ends in (`.../block/<n>`), or null. */
export function blockOfPassage(iri) {
  const m = /\/block\/(\d+)$/.exec(String(iri ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * Pages for a file's claims, or null when they cannot be told. Only a file source (a `urn:sha256:` url) has pages; a web
 * article read as page 1 for every claim would be a false number. The kept text is looked up by the SOURCE'S hash under
 * `<dataDir>/sources/`, and used only if it hashes back to that name (the text the claims were anchored in).
 */
export function pagesOf({ sourceIri, url, dataDir }) {
  if (typeof url !== 'string' || !url.startsWith('urn:sha256:')) return null;
  if (typeof sourceIri !== 'string' || !sourceIri.startsWith(SOURCE) || !dataDir) return null;
  const hex = sourceIri.slice(SOURCE.length);
  if (!HEX64.test(hex)) return null;
  let text;
  try { text = fs.readFileSync(path.join(dataDir, 'sources', `${hex}.txt`), 'utf8'); } catch { return null; }
  if (crypto.createHash('sha256').update(text).digest('hex') !== hex) return null;
  if (!text.includes('\f')) return null;
  const blocks = blocksOf(text);
  return (block) => (Number.isInteger(block) && block >= 0 && block < blocks.length ? pageOfBlock(blocks, block) : null);
}

/** The whole run: header, then every claim in SOURCE order, each with its links to cards. */
export function shapeReading({ header, claimRows, linkRows, cardOf, pageOf = null }) {
  const byClaim = new Map();
  for (const r of linkRows) {
    const card = cardOf(r.c.value);
    const row = { id: r.l.value.split('/').pop(), status: r.st.value, score: r.sc ? Number(r.sc.value) : null, card: { shortId: card?.shortId ?? null, title: card?.title ?? null } };
    byClaim.set(r.a.value, [...(byClaim.get(r.a.value) ?? []), row]);
  }
  for (const list of byClaim.values()) list.sort((x, y) => (y.score ?? -1) - (x.score ?? -1) || (x.card.shortId ?? 0) - (y.card.shortId ?? 0));
  const claims = claimRows.map((r) => {
    const block = blockOfPassage(lit(r, 'pass'));
    return { id: r.a.value.split('/').pop(), gist: lit(r, 'gist'), quote: lit(r, 'span'), type: lit(r, 'type'), verb: lit(r, 'verb'),
      block, page: pageOf ? pageOf(block) : null, links: byClaim.get(r.a.value) ?? [] };
  }).sort((x, y) => (x.block ?? Infinity) - (y.block ?? Infinity) || x.id.localeCompare(y.id));
  let total = 0;   // a dismissed link is the owner's "no": it is listed on its claim, but not counted as a link the run has
  for (const c of claims) for (const l of c.links) if (l.status !== 'dismissed') total += 1;
  const { sourceIri, source, ...run } = header;
  return {
    run: { ...run, claims: claims.length, links: total },
    source: { ...source, iri: sourceIri, hasPages: pageOf != null },
    claims,
  };
}
