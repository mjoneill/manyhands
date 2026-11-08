/**
 * #1810 PR B — the fetcher (R9e, destinations). The service runs on the LAN, so a shared link is a request it makes
 * on the owner's behalf from INSIDE the network. Nothing here connects to a destination it has not checked.
 *
 * Before EVERY connection, the first one included: the scheme must be https (http only behind an explicit knob the
 * tests use for a loopback server); the host is resolved, and loopback, private, link-local, carrier-grade-NAT and
 * unspecified addresses are refused, for a literal IP and for every address a name resolves to alike (one private
 * answer among several is enough). Redirects are followed BY HAND (redirect: 'manual'), each hop checked the same
 * way, at most MAX_HOPS. The body is bounded in bytes and must be a text type; HTML is reduced to lines.
 *
 * Stated gap: the check and the connection are two steps, so a resolver that answers differently to the client's own
 * lookup moments later could swap the address (a DNS rebinding). Closing it means connecting to the address that was
 * checked: `https.request` takes a `lookup` option that does exactly that without a new dependency (51203); until then
 * the sharers are a configured, trusted list, and this paragraph names what is not yet pinned.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

export const MAX_HOPS = 5;
export const DEFAULT_MAX_BYTES = 3_000_000;
const TEXT_TYPES = /^(text\/|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml))/i;

export class RefusedDestination extends Error {
  constructor(url, why) { super(`refused destination ${url}: ${why}`); this.name = 'RefusedDestination'; this.url = url; this.why = why; }
}

// ── what is not public, as RANGES, never as text patterns (51203: the URL parser rewrites `[::ffff:127.0.0.1]` into hex,
// `[::ffff:7f00:1]`, and a dotted-form pattern let a bracketed link reach the LAN) ─────────────────────────────────────────
const V4_NOT_PUBLIC = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]];
const V6_NOT_PUBLIC = [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]];   // unspecified, loopback, unique-local, link-local, multicast
const BLOCK = new net.BlockList();
for (const [n, p] of V4_NOT_PUBLIC) BLOCK.addSubnet(n, p, 'ipv4');
for (const [n, p] of V6_NOT_PUBLIC) BLOCK.addSubnet(n, p, 'ipv6');

/** The 16 bytes of an IPv6 literal (any textual form, a trailing dotted v4 included), or null if it is not one. */
export function v6Bytes(text) {
  let t = String(text).trim().replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (!net.isIPv6(t)) return null;
  const halves = t.split('::');
  if (halves.length > 2) return null;
  const groups = (part) => (part === '' ? [] : part.split(':'));
  let left = groups(halves[0]), right = halves.length === 2 ? groups(halves[1]) : [];
  const tail = right.length ? right : left;
  if (tail.length && tail[tail.length - 1].includes('.')) {   // a trailing dotted v4 is two groups
    const d = tail.pop().split('.').map(Number);
    if (d.length !== 4 || d.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
    tail.push(((d[0] << 8) | d[1]).toString(16), ((d[2] << 8) | d[3]).toString(16));
  }
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const all = [...left, ...new Array(Math.max(0, missing)).fill('0'), ...right];
  if (all.length !== 8) return null;
  const out = [];
  for (const g of all) { const n = parseInt(g, 16); if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null; out.push(n >> 8, n & 0xff); }
  return out;
}
const dotted = (b) => b.join('.');

/** Not public: a non-address, or any address in the ranges above, or an IPv6 that EMBEDS a non-public IPv4 (mapped ::ffff:0:0/96,
 *  compatible ::/96, NAT64 64:ff9b::/96, 6to4 2002::/16). A public v4 embedded any of those ways stays public. */
export function isPrivateAddress(ip) {
  if (typeof ip !== 'string' || !ip.trim()) return true;
  const a = ip.trim().replace(/^\[|\]$/g, '');
  if (net.isIPv4(a)) return BLOCK.check(a, 'ipv4');
  const b = v6Bytes(a);
  if (!b) return true;   // not an address at all
  if (BLOCK.check(a.split('%')[0], 'ipv6')) return true;
  const zero = (from, to) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateAddress(dotted(b.slice(12)));      // ::ffff:a.b.c.d
  if (zero(0, 12)) return isPrivateAddress(dotted(b.slice(12)));                                           // ::a.b.c.d (compatible)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return isPrivateAddress(dotted(b.slice(12)));   // 64:ff9b::/96 NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateAddress(dotted(b.slice(2, 6)));                       // 2002::/16 6to4
  return false;
}

/** A readable text from a page: scripts and styles gone, block tags to lines, tags stripped, a few entities decoded. */
export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|section|article|h[1-6]|li|blockquote|pre|tr|title|head|body|html)\s*>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, '\'')
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

const defaultResolve = (host) => dns.lookup(host, { all: true, verbatim: true });

export function createFetcher({ allowHttp = false, allowPrivate = false, maxBytes = DEFAULT_MAX_BYTES, maxHops = MAX_HOPS, resolve = defaultResolve, fetchImpl = fetch, timeoutMs = 30_000, userAgent = 'manyhands-extractor/1810' } = {}) {
  /** The check: scheme, then the literal or every resolved address. Throws RefusedDestination; never connects. */
  async function check(urlText) {
    let u;
    try { u = new URL(urlText); } catch { throw new RefusedDestination(urlText, 'not a url'); }
    if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw new RefusedDestination(urlText, `scheme ${u.protocol} (https only)`);
    if (u.username || u.password) throw new RefusedDestination(urlText, 'credentials in the url');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate) {
      if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new RefusedDestination(urlText, `host ${host} is local`);
      if (net.isIP(host)) { if (isPrivateAddress(host)) throw new RefusedDestination(urlText, `address ${host} is not public`); return u; }
      let answers;
      try { answers = await resolve(host); } catch (e) { throw new Error(`fetch: could not resolve ${host} (${e?.code ?? e?.message ?? e})`); }
      const addrs = (answers || []).map((x) => (typeof x === 'string' ? x : x.address)).filter(Boolean);
      if (!addrs.length) throw new Error(`fetch: could not resolve ${host} (no addresses)`);
      const bad = addrs.find(isPrivateAddress);
      if (bad) throw new RefusedDestination(urlText, `${host} resolves to ${bad}, which is not public`);
    }
    return u;
  }

  async function readBounded(res) {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`fetch: body is ${declared} bytes, over the ${maxBytes}-byte cap`);
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { try { await reader.cancel(); } catch { /* closing */ } throw new Error(`fetch: body exceeds the ${maxBytes}-byte cap`); }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  }

  /** Fetch a shared link safely. Returns { text, encodingFormat, finalUrl }. */
  return async function fetchSource(urlText) {
    let current = String(urlText);
    for (let hop = 0; hop <= maxHops; hop++) {
      const u = await check(current);   // before EVERY connection, the first included
      const res = await fetchImpl(u.href, { redirect: 'manual', headers: { accept: 'text/html, text/plain;q=0.9, */*;q=0.1', 'user-agent': userAgent }, signal: AbortSignal.timeout(timeoutMs) });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error(`fetch: ${res.status} without a Location`);
        if (hop === maxHops) throw new Error(`fetch: more than ${maxHops} redirects (hops)`);
        current = new URL(loc, u.href).href;   // a relative Location resolves against the hop; it is CHECKED on the next pass
        continue;
      }
      if (!res.ok) throw new Error(`fetch: ${res.status}`);
      const type = (res.headers.get('content-type') || '').trim();
      if (type && !TEXT_TYPES.test(type)) throw new Error(`fetch: unsupported content type ${type.split(';')[0]} (text only)`);
      const body = await readBounded(res);
      const html = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(body);
      return { text: html ? htmlToText(body) : body, encodingFormat: html ? 'text/html' : 'text/plain', finalUrl: u.href };
    }
    throw new Error(`fetch: more than ${maxHops} redirects (hops)`);
  };
}
