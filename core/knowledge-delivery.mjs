import crypto from 'node:crypto';
import { LOGBORN_TERMS as TM } from './graph-compiler.mjs';   // every term from the compiler's own table, never retyped (#1850)
/**
 * #1852 (#1848 slice 3) — DELIVERY: the proposed links a seat is handed WITH a card, at the moment of work.
 *
 * #1850 measured that nobody goes looking for a proposed link, so a link that waits to be found is never used. Here the
 * board hands a card's links to the seat that claims it, and to a seat the first time she reads it. The rules are pure so
 * they are tested without a graph; server.js does the two reads and the one write around them.
 *
 * A delivery is small on purpose: it rides on card_get, the most-called read on the board, and a seat that is shown ten
 * machine proposals reads none of them. So a card has at most DELIVERY_MAX, never two from one source, never a link the
 * room retired (status dismissed) and never one this seat dismissed herself: a dismiss is one seat's, and hides it from her.
 *
 * Each first showing is recorded as its own node (kind `link.show`), one per seat and link, so #1850 can count what a seat
 * was SHOWN beside what she USED, and so a re-read does not show the same block again.
 */
export const DELIVERY_MAX = 2;
export const QUOTE_MAX_CHARS = 300;
/** The longest a delivery read may hold a claim or a card read: past it the answer goes out saying UNAVAILABLE. */
export const DELIVERY_DEADLINE_MS = 1500;
export const DELIVERY_MEANS = 'Claims from documents the room has read that a meaning search proposed as bearing on this card: MACHINE PROPOSALS, '
  + 'not endorsements, so read the quote before trusting the gist; a confirm means "this claim mattered to the work on this card", and a dismiss '
  + 'hides it from you alone (a second seat\'s dismiss retires it for everyone).';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
/** A passage is `<source>/block/<n>` (core/knowledge-extraction.mjs); the graph holds no other edge from a claim to its source. */
export function sourceOfPassage(passage) {
  const m = /^(.+)\/block\/\d+$/.exec(String(passage ?? ''));
  return m ? m[1] : null;
}

/** The verbatim span, cut so one long passage cannot swamp a card read. The cut never splits a surrogate pair. */
export function quoteOf(span) {
  const s = String(span ?? '');
  if (s.length <= QUOTE_MAX_CHARS) return { quote: s, truncated: false };
  let head = s.slice(0, QUOTE_MAX_CHARS);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return { quote: `${head}…`, truncated: true };
}

/**
 * The card's delivery SET. Confirmed first (a seat already said it mattered), then the higher score, then the id, so the
 * same card always yields the same set. A link whose source is unknown shares one slot with every other such link: two
 * unknowns are never assumed to be two sources.
 */
export function selectDeliveries(links, { max = DELIVERY_MAX } = {}) {
  const rank = (l) => (l.status === 'confirmed' ? 0 : 1);
  const score = (l) => (Number.isFinite(l.score) ? l.score : -Infinity);
  const ordered = (links ?? [])
    .filter((l) => l && l.status !== 'dismissed' && l.mine !== 'dismissed' && (l.span || l.gist))
    .sort((a, b) => rank(a) - rank(b) || score(b) - score(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const taken = new Set();
  const out = [];
  for (const l of ordered) {
    if (out.length >= max) break;
    const source = l.source ?? '';
    if (taken.has(source)) continue;
    taken.add(source);
    out.push(l);
  }
  return out;
}

/**
 * What a card READ shows: the part of the set this seat has not been shown. It filters the capped set, never the whole
 * list, or every re-read would walk two further down a long list and the cap would mean nothing.
 */
export const firstShowings = (set) => (set ?? []).filter((l) => !l.shown);

/**
 * The block as the seat reads it. The gist sits beside the quote; the subject-verb-object triple is never rendered
 * (measured 2026-11-14: the triple loses the context the gist keeps). A page is not known from the graph, so none is given.
 */
export function deliveryBlock({ items, shortId, sources = new Map(), recorded } = {}) {
  if (!items || items.length === 0) return null;
  return {
    means: DELIVERY_MEANS,
    items: items.map((l) => {
      const { quote, truncated } = quoteOf(l.span || l.gist);
      const src = sources.get(l.source) ?? {};
      return {
        link: l.id, status: l.status, gist: l.gist || quote, quote, ...(truncated ? { quoteTruncated: true } : {}),
        source: { title: src.title ?? null, url: src.url ?? null },
        score: Number.isFinite(l.score) ? l.score : null,
        answer: {
          confirm: { tool: 'link_decide', args: { link: l.id, verdict: 'confirmed', workingOn: shortId } },
          dismiss: { tool: 'link_decide', args: { link: l.id, verdict: 'dismissed' } },
        },
      };
    }),
    ...(recorded === false ? { recorded: false } : {}),
  };
}

/** The ONE node a (seat, link) showing lives at: a second showing names the same node, and the compiler's freshness guard refuses it. */
export const showIri = (link, actor) => `${link}/shown/${sha(actor)}`;

/** The write for one answer's first showings: ONE `link.show` update carrying all of them. */
export function showIntention({ links, card, how, actor, at = new Date().toISOString(), opId = `urn:ex:op/${crypto.randomUUID()}` } = {}) {
  return { kind: 'link.show', opId, actor, card, how, showings: (links ?? []).map((link) => ({ iri: showIri(link, actor), link })), at };
}

/**
 * The delivery read for one card: ONE query that starts from the card, so a card with no links costs one indexed miss.
 * With a seat it also says which links that seat has been shown, and every verdict she gave on them.
 */
export function deliveryQuery({ card, actor = null } = {}) {
  return `SELECT ?l ?st ?sc ?span ?gist ?pass ?sh ?md ?mv ?mat WHERE { ?l <${TM.bearsOnCard}> <${card}> ; a <${TM.BearsOn}> ; <${TM.status}> ?st ; <${TM.fromAssertion}> ?a `
    + `FILTER(?st != "dismissed") OPTIONAL { ?l <${TM.score}> ?sc } OPTIONAL { ?a <${TM.anchorText}> ?span } OPTIONAL { ?a <${TM.gist}> ?gist } `
    + `OPTIONAL { ?a <${TM.expressedIn}> ?pass } ${actor ? `OPTIONAL { ?sh a <${TM.LinkShowing}> ; <${TM.ofLink}> ?l ; <${TM.shownTo}> <${actor}> } `
    + `OPTIONAL { ?md a <${TM.LinkDecision}> ; <${TM.ofLink}> ?l ; <${TM.decidedBy}> <${actor}> ; <${TM.linkVerdict}> ?mv ; <${TM.dateCreated}> ?mat } ` : ''}}`;
}
/** The delivery query's bindings as the links selectDeliveries reads, one per link. `mine` is the seat's own standing verdict. */
export function linksOfDeliveryRows(rows) {
  const byId = new Map();
  for (const r of rows ?? []) {
    const iri = r.l.value;
    if (!byId.has(iri)) {
      const sc = r.sc ? Number(r.sc.value) : null;
      byId.set(iri, { iri, id: iri.split('/').pop(), status: r.st.value, score: Number.isFinite(sc) ? sc : null,
        span: r.span?.value ?? null, gist: r.gist?.value ?? null, source: sourceOfPassage(r.pass?.value), shown: !!r.sh, mine: null, mineAt: null });
    }
    // a seat that decided a link more than once gives one row per verdict: the latest is the one that stands
    const l = byId.get(iri);
    if (r.md && (l.mineAt === null || r.mat.value > l.mineAt.at || (r.mat.value === l.mineAt.at && r.md.value > l.mineAt.d))) {
      l.mine = r.mv.value; l.mineAt = { at: r.mat.value, d: r.md.value };
    }
  }
  return [...byId.values()].map(({ mineAt, ...l }) => l);
}
const IRI_SAFE = /^[^\s<>"{}|\\^`]+$/;
/** The title and address of the delivered items' sources: a second read, made only when something is delivered. */
export function deliverySourcesQuery(sources) {
  const safe = (sources ?? []).filter((s) => typeof s === 'string' && IRI_SAFE.test(s));
  if (safe.length === 0) return null;
  return `SELECT ?s ?name ?url WHERE { VALUES ?s { ${safe.map((s) => `<${s}>`).join(' ')} } OPTIONAL { ?s <${TM.name}> ?name } OPTIONAL { ?s <${TM.url}> ?url } }`;
}
export function sourcesOfRows(rows) {
  const out = new Map();
  for (const r of rows ?? []) if (!out.has(r.s.value)) out.set(r.s.value, { title: r.name?.value ?? null, url: r.url?.value ?? null });
  return out;
}
