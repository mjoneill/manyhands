import crypto from 'node:crypto';
import { LOGBORN_TERMS as TM } from './graph-compiler.mjs';   // every term from the compiler's own table, never retyped (#1850)
import { standingVerdicts } from './knowledge-linking.mjs';   // #1901 — a seat's standing verdict is #1852's rule, read once
import { SEAT_NS } from './graph-auth.mjs';
/**
 * #1852 (#1848 slice 3) — DELIVERY: the proposed links a seat is handed WITH a card, at the moment of work.
 *
 * #1850 measured that nobody goes looking for a proposed link, so a link that waits to be found is never used. Here the
 * board hands a card's links to the seat that claims it, and to a seat that reads it until she has answered them. The rules
 * are pure so they are tested without a graph; server.js does the two reads and the one write around them.
 *
 * A delivery is small on purpose: it rides on card_get, the most-called read on the board, and a seat that is shown ten
 * machine proposals reads none of them. So a card has at most DELIVERY_MAX, never two from one source, never a link the
 * room retired (status dismissed) and never one this seat dismissed herself: a dismiss is one seat's, and hides it from her.
 * Those two caps are for MACHINE proposals. A link a seat attached by hand (#1905) has its own lane, bounded by HAND_MAX.
 *
 * Each first showing is recorded as its own node (kind `link.show`), one per seat and link, so #1850 can count what a seat
 * was SHOWN beside what she USED. A repeat is shown again but never recorded again, and says `shownBefore`.
 */
export const DELIVERY_MAX = 2;
export const QUOTE_MAX_CHARS = 300;
/**
 * #1905 decision ee188cd5 — a link attached BY HAND is a person saying "read this, and here's why". The two caps above exist to
 * protect a reader from machine proposals she never asked for, so a hand link spends neither: it has its own lane, bounded
 * only so attaching cannot flood a reader. 8 is the PO's guess, not a measurement. reopensIf: a real card collects more than
 * 8 deliberate hand links, and a reader is shown "N more" where she needed them.
 */
export const HAND_MAX = 8;
/** The longest a delivery read may hold a claim or a card read: past it the answer goes out saying UNAVAILABLE. */
export const DELIVERY_DEADLINE_MS = 1500;
export const DELIVERY_MEANS = 'Claims from documents the room has read that a meaning search proposed as bearing on this card: MACHINE PROPOSALS, '
  + 'not endorsements, so read the quote before trusting the gist; a confirm means "this claim mattered to the work on this card", and a dismiss '
  + 'hides it from you alone (a second seat\'s dismiss retires it for everyone); a claim keeps appearing on this card until you answer it. '
  // #1901 — a small-model seat was shown another seat's confirm and posted "I accepted that claim". Said here AND per item.
  + 'Status "confirmed" is ANOTHER seat\'s verdict unless `yours` is true: `confirmedBy` names the seat and `confirmedAt` when, and '
  + '`whoConfirmed` says it in one sentence; never say you confirmed or accepted a claim whose `yours` is false. '
  // #1905 — a seat may attach a claim by hand; that item is one seat's judgement, never a machine proposal or a use
  + 'An item with `attachedBy` was attached to this card BY HAND by that seat, at `attachedAt`, for the reason in `attachReason` '
  + '(`whoAttached` says it in one sentence): one seat\'s judgement that it bears on the card, not a confirm and not a use.';

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
 * The card's delivery SET. A DELIVERY-BORN confirm first (a seat was handed the claim and said it mattered), then the higher
 * score, then the id, so the same card always yields the same set. A link whose source is unknown shares one slot with every other such link: two
 * unknowns are never assumed to be two sources.
 *
 * `unanswered` is the card READ's rule: only links this seat has given NO verdict on, shown before or not. A seat that saw
 * a claim and did not answer must find it again when she reopens the card (an agent in a new wake remembers nothing of the
 * first block), or the claim is counted as shown and can never be used. The filter comes BEFORE the cap, so answering one
 * claim lets the next one surface. A claim keeps the plain rule: it shows the card's two, one she confirmed among them.
 */
export function selectDeliveries(links, opts = {}) {
  return selectDeliverySet(links, opts).items;
}
/**
 * The card's delivery set AND how many hand links did not fit (`moreAttached`). Two lanes: the MACHINE lane (every link with no
 * `attachedBy`) under the rules above, then the HAND lane: every deliverable hand link, oldest attach first, at most HAND_MAX.
 * The same filters (dismissed, dismissed by her, answered on a read) come BEFORE either bound, so an answered link frees a place.
 * The machine lane comes first: an attached link does not outrank machine links (#1905 design 7).
 */
export function selectDeliverySet(links, { max = DELIVERY_MAX, unanswered = false, handMax = HAND_MAX } = {}) {
  // #1901 — a confirm leads ONLY when it is delivery-born (linksOfDeliveryRows): a seat whose confirm stands had been SHOWN the
  // link before she gave it. The nine triage confirms of 11-13 (#1850/#1851: seats confirming from link_list, ruled not real
  // uses) predate every showing, so they fall back to score order with the proposed links; no history is rewritten.
  // reopensIf: seats confirm from link_list (or any surface that records no LinkShowing) in REAL work without ever being
  // shown the link. Those are real uses, and this rule would rank them by score as if they were triage. If that happens, the
  // showing is the wrong witness: record the surface a confirm came from on the decision, and rank by that instead.
  const rank = (l) => (l.status === 'confirmed' && l.deliveryBorn === true ? 0 : 1);
  const score = (l) => (Number.isFinite(l.score) ? l.score : -Infinity);
  const deliverable = (links ?? [])
    .filter((l) => l && l.status !== 'dismissed' && l.mine !== 'dismissed' && (l.span || l.gist) && !(unanswered && l.mine != null));
  const handLane = deliverable.filter((l) => l.attachedBy != null)
    .sort((a, b) => String(a.attachedAt ?? '').localeCompare(String(b.attachedAt ?? '')) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ordered = deliverable.filter((l) => l.attachedBy == null)
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
  return { items: [...out, ...handLane.slice(0, handMax)], moreAttached: Math.max(0, handLane.length - handMax) };
}

/** The part of a set this seat has not been shown: what a showing is RECORDED for. A repeat is delivered, never recorded twice. */
export const firstShowings = (set) => (set ?? []).filter((l) => !l.shown);

/**
 * The block as the seat reads it. The gist sits beside the quote; the subject-verb-object triple is never rendered
 * (measured 2026-11-14: the triple loses the context the gist keeps). A page is not known from the graph, so none is given.
 */
export function deliveryBlock({ items, shortId, sources = new Map(), recorded, reader = null, moreAttached = 0 } = {}) {
  if (!items || items.length === 0) return null;
  return {
    means: DELIVERY_MEANS,
    items: items.map((l) => {
      const { quote, truncated } = quoteOf(l.span || l.gist);
      const src = sources.get(l.source) ?? {};
      return {
        link: l.id, status: l.status, ...(l.status === 'confirmed' ? decider(l, reader) : {}), ...(l.attachedBy ? attacher(l, reader) : {}),
        gist: l.gist || quote, quote, ...(truncated ? { quoteTruncated: true } : {}),
        source: { title: src.title ?? null, url: src.url ?? null },
        score: Number.isFinite(l.score) ? l.score : null,
        answer: {
          confirm: { tool: 'link_decide', args: { link: l.id, verdict: 'confirmed', workingOn: shortId } },
          dismiss: { tool: 'link_decide', args: { link: l.id, verdict: 'dismissed' } },
        },
        ...(l.shown ? { shownBefore: true } : {}),   // a long-lived session can tell a repeat from news
      };
    }),
    ...(recorded === false ? { recorded: false } : {}),
    // #1905 decision ee188cd5 — hand links past HAND_MAX are counted, never silently dropped; the read that lists them all
    ...(moreAttached > 0 ? { moreAttached: { count: moreAttached,
      says: `${moreAttached} more claim${moreAttached === 1 ? ' was' : 's were'} attached to this card by hand than one read shows; list them all with link_list.`,
      read: { tool: 'link_list', args: { card: shortId } } } } : {}),
  };
}

/** A seat's key from her actor IRI; an actor that is not a seat keeps its whole IRI, never cut to something that reads as a seat. */
export const seatKeyOf = (actor) => (typeof actor === 'string' && actor.startsWith(SEAT_NS) ? actor.slice(SEAT_NS.length) : actor ?? null);
/**
 * #1901 — WHO confirmed a delivered claim, beside its status, in fields AND in one sentence. The sentence is for the reader that
 * reads only the block: it names the deciding seat, and names the READER, saying whether the verdict is hers. Before this a
 * confirmed item said `status: "confirmed"` and nothing else, and a seat shown another seat's confirm reported it as her own.
 */
function decider(l, reader) {
  const by = l.confirmedBy ?? null; const at = l.confirmedAt ?? null; const n = l.confirmedByCount ?? 0; const yours = l.yours === true;
  const me = seatKeyOf(reader);
  let who;
  // the code knows only THAT no confirm stands, not why: say just that (review of #1901)
  if (by == null) who = 'No seat\'s confirm of this claim stands now, so it is not your verdict.';
  else if (yours) who = `You (${me}) confirmed this claim at ${at}: this verdict is yours.${n > 1 ? ` ${n - 1} other seat${n - 1 === 1 ? '\'s confirm stands' : 's\' confirms stand'} too.` : ''}`;
  else {
    const head = `${by} confirmed this claim at ${at}${n > 1 ? ` (${n} seats' confirms stand; ${by}'s is the latest)` : ''}.`;
    who = me ? `${head} It is ${by}'s verdict, NOT yours: you (${me}) have given no verdict on this claim.`
      : `${head} It is ${by}'s verdict: this read carried no seat credential, so it is not a verdict of yours.`;
  }
  return { confirmedBy: by, confirmedAt: at, confirmedByCount: n, yours, whoConfirmed: who };
}

/**
 * #1905 — WHO attached a claim by hand, when and why, in fields AND in one sentence, as decider() says who confirmed it. Only a
 * hand link has these: a machine link's item is unchanged, so an item without `attachedBy` is a machine proposal.
 */
function attacher(l, reader) {
  const me = seatKeyOf(reader);
  const who = me && me === l.attachedBy ? `You (${me})` : l.attachedBy;
  return { attachedBy: l.attachedBy, attachedAt: l.attachedAt ?? null, attachReason: l.attachReason ?? null,
    whoAttached: `${who} attached this claim to the card by hand at ${l.attachedAt}, because: ${l.attachReason}. Attaching is not a confirm: it is one seat's judgement that the claim bears on the card.` };
}

/** The ONE node a (seat, link) showing lives at: a second showing names the same node, and the compiler's freshness guard refuses it. */
export const showIri = (link, actor) => `${link}/shown/${sha(actor)}`;

/** The write for one answer's first showings: ONE `link.show` update carrying all of them. */
export function showIntention({ links, card, how, actor, at = new Date().toISOString(), opId = `urn:ex:op/${crypto.randomUUID()}` } = {}) {
  return { kind: 'link.show', opId, actor, card, how, showings: (links ?? []).map((link) => ({ iri: showIri(link, actor), link })), at };
}

/**
 * The delivery read for one card: ONE query that starts from the card, so a card with no links costs one indexed miss.
 * It carries every seat's verdicts on each link (#1901: who confirmed it, and the reader's own verdict among them), and with a
 * seat, which links that seat has been shown. One row per decision; a link nobody decided gives one row.
 */
export function deliveryQuery({ card, actor = null } = {}) {
  return `SELECT ?l ?st ?sc ?span ?gist ?pass ?sh ?d ?dby ?dv ?dat ?dsh ?dshat ?ab ?ar ?lat WHERE { ?l <${TM.bearsOnCard}> <${card}> ; a <${TM.BearsOn}> ; <${TM.status}> ?st ; <${TM.fromAssertion}> ?a `
    + `FILTER(?st != "dismissed") OPTIONAL { ?l <${TM.score}> ?sc } OPTIONAL { ?a <${TM.anchorText}> ?span } OPTIONAL { ?a <${TM.gist}> ?gist } `
    // #1905 — a hand link's attacher, reason and time (a machine link has no attachedBy, so all three stay unbound)
    + `OPTIONAL { ?l <${TM.attachedBy}> ?ab ; <${TM.attachReason}> ?ar ; <${TM.dateCreated}> ?lat } `
    + `OPTIONAL { ?a <${TM.expressedIn}> ?pass } ${actor ? `OPTIONAL { ?sh a <${TM.LinkShowing}> ; <${TM.ofLink}> ?l ; <${TM.shownTo}> <${actor}> } ` : ''}`
    + `OPTIONAL { ?d a <${TM.LinkDecision}> ; <${TM.ofLink}> ?l ; <${TM.decidedBy}> ?dby ; <${TM.linkVerdict}> ?dv ; <${TM.dateCreated}> ?dat `
    // #1901 — the deciding seat's own showing of the link (at most one per seat and link), for "delivery-born"
    + `OPTIONAL { ?dsh a <${TM.LinkShowing}> ; <${TM.ofLink}> ?l ; <${TM.shownTo}> ?dby ; <${TM.dateCreated}> ?dshat } } }`;
}
/**
 * The delivery query's bindings as the links selectDeliveries reads, one per link. From each seat's STANDING verdict (her latest
 * decision, #1852's rule): `mine`, the reader's own; and, #1901, who confirmed the link. `confirmedBy` is the reader herself when
 * her confirm stands (so it never disagrees with `yours`), otherwise the seat whose standing confirm is the most recent;
 * `confirmedByCount` counts SEATS whose confirm stands. A confirm later replaced by that seat's dismiss is no one's confirm.
 * `deliveryBorn` (internal, never rendered): a standing confirm whose seat had a LinkShowing for the link dated before it.
 */
export function linksOfDeliveryRows(rows, { actor = null } = {}) {
  const byId = new Map();
  for (const r of rows ?? []) {
    const iri = r.l.value;
    if (!byId.has(iri)) {
      const sc = r.sc ? Number(r.sc.value) : null;
      byId.set(iri, { iri, id: iri.split('/').pop(), status: r.st.value, score: Number.isFinite(sc) ? sc : null,
        span: r.span?.value ?? null, gist: r.gist?.value ?? null, source: sourceOfPassage(r.pass?.value), shown: false, decisions: new Map(),
        attachedBy: r.ab ? seatKeyOf(r.ab.value) : null, attachReason: r.ar?.value ?? null, attachedAt: r.ab ? r.lat?.value ?? null : null });
    }
    const l = byId.get(iri);
    if (r.sh) l.shown = true;
    if (r.d) l.decisions.set(r.d.value, { decision: r.d.value, by: r.dby.value, verdict: r.dv.value, at: r.dat.value, shownAt: r.dshat?.value ?? null });
  }
  return [...byId.values()].map(({ decisions, ...l }) => {
    const standing = standingVerdicts([...decisions.values()]);
    const confirms = [...standing.values()].filter((d) => d.verdict === 'confirmed')
      .sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : a.decision > b.decision ? -1 : 1));
    const own = actor ? standing.get(actor) ?? null : null;
    const named = own?.verdict === 'confirmed' ? own : confirms[0] ?? null;
    return { ...l, mine: own?.verdict ?? null, confirmedBy: named ? seatKeyOf(named.by) : null, confirmedAt: named?.at ?? null,
      confirmedByCount: confirms.length, yours: own?.verdict === 'confirmed',
      // #1901 — delivery-born: some STANDING confirm whose seat had been shown the link before it (selectDeliveries ranks by it)
      deliveryBorn: confirms.some((d) => d.shownAt != null && d.shownAt < d.at) };
  });
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
