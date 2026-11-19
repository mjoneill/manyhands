/**
 * #1885 — THE POSTS THE TWO DECISION-MAKERS READ, FROM THE GRAPH.
 *
 * stale-claims (#455) and role-expiry (#1400) were switched off under the graph conversations unit (#1574) because they read
 * the DOCUMENT's posts, and with the unit on an ordinary post lives only in the graph. Each needs a narrow slice, never the
 * whole corpus:
 *   stale-claims  each holder's posts ON the card they hold   → {author, attachedTo, createdAt, body}
 *   role-expiry   each lapsed holder's latest post after the lapse → {author, createdAt}
 * Both answer in the shape the engines already take (`conversations`), so the engines are unchanged.
 *
 * Pure: query builders and binding readers only. The caller runs the query; a failed read throws there, and the standing loop
 * reports it as an ERROR, never as "nothing found" (#792).
 */

const SCHEMA = 'https://schema.org/';
const ENTITY = 'https://scrumboard.local/entity/';
const PERSON = 'https://scrumboard.local/person/';
const COMMENT = `${SCHEMA}Comment`;

// A seat key or a card id goes into an IRI: refuse anything that could break out of one, rather than escape it.
const SAFE = /^[A-Za-z0-9_.:-]+$/;
const safe = (v, what) => { if (typeof v !== 'string' || !SAFE.test(v)) throw new Error(`check-posts-graph: unsafe ${what}: ${JSON.stringify(v)}`); return v; };
const lit = (s) => JSON.stringify(String(s));
const strip = (v, prefix) => (typeof v === 'string' && v.startsWith(prefix) ? v.slice(prefix.length) : v);

/** The (holder, card) pairs of the held cards. */
export function heldPairs(cards = []) {
  const out = [];
  for (const c of cards) if (c && c.claimedBy && c.id && SAFE.test(c.claimedBy) && SAFE.test(c.id)) out.push({ holder: c.claimedBy, cardId: c.id });
  return out;
}

/** Every post by each holder on the card they hold. Null when there is nothing to ask (no held card). */
export function holderCardPostsQuery(pairs) {
  if (!pairs.length) return null;
  const values = pairs.map((p) => `(<${PERSON}${safe(p.holder, 'seat')}> <${ENTITY}${safe(p.cardId, 'card id')}>)`).join(' ');
  return `SELECT ?a ?card ?d ?t WHERE {
  VALUES (?a ?card) { ${values} }
  ?p a <${COMMENT}> ; <${SCHEMA}author> ?a ; <${SCHEMA}about> ?card ; <${SCHEMA}dateCreated> ?d .
  OPTIONAL { ?p <${SCHEMA}text> ?t }
}`;
}

/** The query's bindings as engine posts: {author, attachedTo, createdAt, body}. */
export function holderCardPostsFrom(bindings = []) {
  return bindings.map((b) => ({
    author: strip(b.a?.value, PERSON),
    attachedTo: strip(b.card?.value, ENTITY),
    createdAt: b.d?.value,
    body: b.t?.value ?? '',
  }));
}

/** The lapsed declarations role-expiry reads posts for: expired, within the window, with a seat and a role. */
export function lapsedSeats(decls = [], now, windowMs = 7 * 24 * 3.6e6) {
  const t = Date.parse(now);
  const out = [];
  for (const d of decls || []) {
    if (!d || !d.role || !d.seat || !SAFE.test(d.seat)) continue;
    const exp = Date.parse(d.expiresAt);
    if (!Number.isFinite(exp) || exp > t || t - exp > windowMs) continue;
    out.push({ seat: d.seat, since: d.expiresAt });
  }
  return out;
}

/** Each lapsed holder's posts after the lapse. Null when no role has lapsed. The engine keeps only the latest. */
export function postsSinceQuery(items) {
  if (!items.length) return null;
  const values = items.map((i) => `(<${PERSON}${safe(i.seat, 'seat')}> ${lit(i.since)})`).join(' ');
  return `SELECT ?a ?d WHERE {
  VALUES (?a ?since) { ${values} }
  ?p a <${COMMENT}> ; <${SCHEMA}author> ?a ; <${SCHEMA}dateCreated> ?d .
  FILTER(STR(?d) > ?since)
}`;
}

/** The query's bindings as engine posts: {author, createdAt}. The engine re-compares the times as instants. */
export function postsSinceFrom(bindings = []) {
  return bindings.map((b) => ({ author: strip(b.a?.value, PERSON), createdAt: b.d?.value }));
}
