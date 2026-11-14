import crypto from 'node:crypto';
import { LOGBORN_TERMS as TM } from './graph-compiler.mjs';   // #1850 — the counts read exactly the terms link.decide writes
/**
 * #1851 (#1848 slice 2) — which of our cards does an extracted claim bear on.
 *
 * The unit is ONE CLAIM bearing on ONE CARD, not a source on a card: slice 3 (#1852) has to hand a seat the quoted claim that
 * matters, and a source-level link cannot say which one. A source's view is its claims' links grouped.
 *
 * Every link starts PROPOSED, by machine, with its score and the query that found it. A seat confirms or dismisses it; a pair
 * that has a link in ANY status is never proposed again, so a dismissal sticks and a re-run never doubles a link.
 *
 * Nothing here calls a model: `search` is the board's own card search (POST /api/search, the dense index search_all uses),
 * injected so the rows run without an embedder. A run that could not search every claim proposes NOTHING: "no link" must
 * never be able to mean "never searched".
 */

/** The text a claim is searched by: its gist, or its verbatim span when the model gave no gist. */
export function queryOf(assertion) {
  const g = typeof assertion?.gist === 'string' ? assertion.gist.trim() : '';
  return g || String(assertion?.span ?? '').trim();
}

export const linkKey = (assertion, card) => `${assertion}|${card}`;
/**
 * The key that survives re-extraction (review 52706 point 3): every run mints fresh assertion IRIs, so a dismissal keyed only
 * by IRI comes back on a re-run. The span is verbatim source text, so the same claim re-extracted carries the same span.
 * Case and whitespace are folded; a REWORDED claim is a different key and is proposed again (the documented limit).
 */
export const spanKey = (span, card) => `span:${crypto.createHash('sha256').update(String(span ?? '').trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex')}|${card}`;

export async function proposeLinks({ assertions, search, existing = [], minScore, perAssertion } = {}) {
  if (!Array.isArray(assertions)) throw new Error('proposeLinks needs the assertions');
  if (typeof search !== 'function') throw new Error('proposeLinks needs a search function');
  if (!Number.isFinite(minScore)) throw new Error('proposeLinks needs minScore: the threshold is config, never a hidden default');
  if (!Number.isInteger(perAssertion) || perAssertion < 1) throw new Error('proposeLinks needs perAssertion >= 1');
  const have = new Set(existing);
  const proposals = [];
  let skipped = 0;
  for (const a of assertions) {
    const query = queryOf(a);
    if (!query) continue;
    const r = await search(query);
    if (!r?.ok) return { ok: false, reason: `search unavailable for ${a.iri}: ${r?.reason ?? 'no answer'}`, proposals: [], skipped: 0 };
    const hits = (r.hits ?? [])
      .filter((h) => h && h.kind !== 'source' && typeof h.id === 'string' && Number.isFinite(h.score) && h.score >= minScore)
      .sort((x, y) => y.score - x.score);
    let taken = 0;
    for (const h of hits) {
      if (taken >= perAssertion) break;
      const sk = spanKey(a.span, h.id);
      if (have.has(linkKey(a.iri, h.id)) || have.has(sk)) { skipped += 1; continue; }
      // #1852: the card's title rides along when the search gave one, so the finish post can name the card. It is never written.
      proposals.push({ assertion: a.iri, card: h.id, shortId: h.shortId ?? null, score: h.score, query, spanKey: sk, ...(typeof h.title === 'string' ? { title: h.title } : {}) });
      have.add(linkKey(a.iri, h.id)); have.add(sk);
      taken += 1;
    }
  }
  return { ok: true, proposals, skipped };
}

const ENTITY = 'https://scrumboard.local/';
/** The link's IRI, derived from its span key: the same claim re-extracted names the same node (review 52706 point 3). */
export const linkIri = (key) => `${ENTITY}link/${crypto.createHash('sha256').update(String(key)).digest('hex')}`;

/** The write for one linking run: ONE `link.propose` update carrying every proposal, guarded by the compiler. */
export function linkIntention({ proposals, minScore, model, at, actor, opId = `urn:ex:op/${crypto.randomUUID()}` } = {}) {
  return {
    kind: 'link.propose', opId, actor,
    links: (proposals ?? []).map((p) => ({ iri: linkIri(p.spanKey), assertion: p.assertion, card: `${ENTITY}entity/${p.card}`,
      score: p.score, minScore, query: p.query, spanKey: p.spanKey, model })),
    at,
  };
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RS = 'https://scrumboard.local/ns#';

/**
 * One linking run over one extraction Run: read its published claims, read EVERY existing link's span key (no status filter,
 * so a dismissed pair stays out), search, and write what is new as ONE link.propose. Nothing new ⇒ no update is sent.
 * Search or graph unavailable ⇒ ok:false and nothing written: a run that could not look never reports "no links".
 */
export async function linkRun({ graphClient, search, run, minScore, perAssertion, model, actor, at = new Date().toISOString(), dryRun = false } = {}) {
  if (!graphClient || typeof run !== 'string' || !run) throw new Error('linkRun needs a graphClient and the run IRI');
  const claims = await graphClient.query(`SELECT ?a ?span ?gist WHERE { ?a <${RDF_TYPE}> <${RS}Assertion> ; <${RS}ofRun> <${run}> ; `
    + `<${RS}anchorText> ?span OPTIONAL { ?a <${RS}gist> ?gist } } ORDER BY ?a`);
  if (!claims.ok) return { ok: false, reason: `the run's claims could not be read: ${claims.reason}`, proposed: 0 };
  const assertions = claims.rows.map((r) => ({ iri: r.a.value, span: r.span.value, ...(r.gist ? { gist: r.gist.value } : {}) }));
  const have = await graphClient.query(`SELECT ?k WHERE { ?l <${RDF_TYPE}> <${RS}BearsOn> ; <${RS}spanKey> ?k }`);
  if (!have.ok) return { ok: false, reason: `the existing links could not be read: ${have.reason}`, proposed: 0 };
  const p = await proposeLinks({ assertions, search, existing: have.rows.map((r) => r.k.value), minScore, perAssertion });
  if (!p.ok) return { ok: false, reason: p.reason, proposed: 0 };
  if (p.proposals.length === 0) return { ok: true, assertions: assertions.length, proposed: 0, skipped: p.skipped, outcome: 'nothing-to-write' };
  if (dryRun) return { ok: true, assertions: assertions.length, proposed: p.proposals.length, skipped: p.skipped, outcome: 'dry-run', links: p.proposals };
  const m = typeof model === 'function' ? model() : model;   // the live search learns the model from its first answer
  const w = await graphClient.update(linkIntention({ proposals: p.proposals, minScore, model: m, at, actor }));
  if (w.outcome !== 'APPLIED') return { ok: false, reason: `the links were not written: ${w.outcome} ${w.reason ?? ''}`.trim(), proposed: 0 };
  return { ok: true, assertions: assertions.length, proposed: p.proposals.length, skipped: p.skipped, outcome: w.outcome, links: p.proposals };
}

/**
 * A seat's verdict on one proposed link: ONE `link.decide`, appending a LinkDecision under the link. A dismiss is that
 * seat's alone; `retiresWith` (#1852) names ANOTHER seat's standing dismissal, and only then is the link retired for everyone.
 */
export function decideIntention({ link, verdict, workingOn = null, retiresWith = null, actor, at = new Date().toISOString(), opId = `urn:ex:op/${crypto.randomUUID()}` } = {}) {
  return {
    kind: 'link.decide', opId, actor, link, verdict, decision: `${link}/decision/${crypto.randomUUID()}`,
    workingOn: workingOn == null ? null : `${ENTITY}entity/${workingOn}`, ...(retiresWith ? { retiresWith } : {}), at,
  };
}

/**
 * #1852 — a dismiss is ONE SEAT'S: it hides the link from her, and the link is retired for everyone only when two distinct
 * seats' STANDING verdicts are both dismissals. A seat's standing verdict is her latest decision (by time, then by the
 * decision IRI, so one instant has one order). These three read the decisions; the compiler guards what they conclude.
 */
export function standingVerdicts(decisions) {
  const per = new Map();
  for (const d of decisions ?? []) {
    const cur = per.get(d.by);
    if (!cur || d.at > cur.at || (d.at === cur.at && d.decision > cur.decision)) per.set(d.by, d);
  }
  return per;
}
/** ANOTHER seat's standing dismissal for a dismiss by `actor` to retire the link with, or null: the first, so the answer is fixed. */
export function retiringDecision(decisions, actor) {
  const others = [...standingVerdicts(decisions).values()].filter((d) => d.by !== actor && d.verdict === 'dismissed')
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.decision < b.decision ? -1 : 1));
  return others.length ? others[0].decision : null;
}
/** How many seats' standing verdict is a dismissal: seats, never decisions. */
export const dismissalCount = (decisions) => [...standingVerdicts(decisions).values()].filter((d) => d.verdict === 'dismissed').length;
/** Every decision on one link, or on every link: the rows the three rules above read. */
export function linkDecisionsQuery(link = null) {
  return `SELECT ?l ?d ?by ?v ?at WHERE { ?d a <${TM.LinkDecision}> ; <${TM.ofLink}> ?l ; <${TM.linkVerdict}> ?v ; <${TM.decidedBy}> ?by ; <${TM.dateCreated}> ?at `
    + `${link ? `FILTER(?l = <${link}>) ` : ''}}`;
}
export const decisionsOfRows = (rows) => (rows ?? []).map((r) => ({ link: r.l.value, decision: r.d.value, by: r.by.value, verdict: r.v.value, at: r.at.value }));

/**
 * The live `search(q)`: the board's own POST /api/search (the dense index search_all uses). Every answer that did not search
 * EVERYTHING is refused (available:false, partial:true, a non-200, a transport error), because the linker writes nothing from
 * a refused search and "no link" must never mean "never searched". The verdict (answer/ask/abstain) is not read: the linker
 * thresholds the scores itself.
 */
export function createRestSearch({ base, token, by, k = 8, fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  let model = null;
  const search = async (q) => {
    let res;
    try {
      res = await fetchImpl(`${String(base).replace(/\/$/, '')}/api/search`, { method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ q, k, by }), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) { return { ok: false, reason: `search transport: ${e?.message ?? e}` }; }
    if (res.status !== 200) return { ok: false, reason: `search answered ${res.status}` };
    let j; try { j = await res.json(); } catch { return { ok: false, reason: 'search answer is not JSON' }; }
    if (j?.available !== true) return { ok: false, reason: `search unavailable: ${j?.reason ?? 'no reason given'}` };
    if (j.partial === true) return { ok: false, reason: `search was partial (${JSON.stringify(j.coverage ?? {})}): it could not search everything` };
    if (typeof j.model === 'string' && j.model) model = j.model;
    const hits = (j.results ?? []).map((r) => ({ id: r.id, shortId: r.shortId ?? null, title: typeof r.title === 'string' ? r.title : null, score: r.score, kind: r.kind === 'source' ? 'source' : 'card' }));   // #1852: the title, for the finish post
    return { ok: true, hits };
  };
  /** The embed model the board answered with: read from its answer, never assumed (null until a search succeeded). */
  search.model = () => model;
  return search;
}

/**
 * #1850 (#1848 slice 1) — SHOWN and USED, two numbers never merged, read from what #1851 and #1852 record (accepted by the Value
 * Steward, commons 52810). Per seat, over DISTINCT links:
 *   shown      links the seat decided (confirmed or dismissed: a seat cannot decide a link it was never shown) or was DELIVERED
 *              (#1852: handed to her with a card she claimed or read). A link_list READ is not counted: reads are not recorded.
 *   delivered  the delivered part of shown, as its own number, so what the board pushed is never mistaken for what a seat found.
 *   used       links the seat confirmed at least once. A confirm must name the card the seat was working on (the compiler refuses one
 *              without it), so it records acting on the claim, not agreeing with it. A later dismiss does not unmake that act.
 * `deciders` counts the seats that DECIDED something; being delivered a link does not make a seat one. `label` is set while fewer
 * than three have: the numbers are then the builder's and reviewer's own, and read as self-attributed. It is a count, never a
 * list of names.
 */
export const LINK_COUNTS_MIN_DECIDERS = 3;
export function linkCountsQuery(since) {
  // every term from the compiler's own table, never retyped: dateCreated is schema.org's, not scrum:'s, and a hand-typed IRI that
  // matches nothing returns a clean zero, which would read as "nobody used anything". A showing has no verdict: ?v stays unbound.
  return `SELECT ?by ?l ?v WHERE { { ?d a <${TM.LinkDecision}> ; <${TM.ofLink}> ?l ; <${TM.linkVerdict}> ?v ; <${TM.decidedBy}> ?by ; <${TM.dateCreated}> ?at } `
    + `UNION { ?d a <${TM.LinkShowing}> ; <${TM.ofLink}> ?l ; <${TM.shownTo}> ?by ; <${TM.dateCreated}> ?at } `
    + `FILTER(?at >= ${JSON.stringify(since)}) }`;
}
/** rows: a decision `{ by, link, verdict }` or a delivery `{ by, link, delivered: true }`. */
export function countLinkUse(rows, { seatNs = 'urn:ex:seat/' } = {}) {
  const per = new Map();
  for (const r of rows) {
    const seat = r.by.startsWith(seatNs) ? r.by.slice(seatNs.length) : r.by;
    if (!per.has(seat)) per.set(seat, { shown: new Set(), delivered: new Set(), used: new Set(), decided: false });
    const p = per.get(seat);
    p.shown.add(r.link);
    if (r.delivered) { p.delivered.add(r.link); continue; }
    p.decided = true;
    if (r.verdict === 'confirmed') p.used.add(r.link);
  }
  const seats = [...per].map(([seat, p]) => ({ seat, shown: p.shown.size, delivered: p.delivered.size, used: p.used.size })).sort((a, b) => (a.seat < b.seat ? -1 : a.seat > b.seat ? 1 : 0));
  const deciders = [...per.values()].filter((p) => p.decided).length;
  return { seats, deciders, label: deciders < LINK_COUNTS_MIN_DECIDERS ? `self-attributed: ${deciders} seat(s) have decided a link, fewer than ${LINK_COUNTS_MIN_DECIDERS}, so these numbers come from the seats that built and reviewed the linker` : null };
}
