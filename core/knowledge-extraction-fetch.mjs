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
 * THE CONNECTION IS PINNED to the address that was checked (51204/51205): the request is made with http(s).request
 * and a `lookup` that returns that address, so there is no second resolution and a resolver that answers differently
 * moments later cannot swap the destination. A `request` seam is injected in tests; the default is the pinned one.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

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
 *  compatible ::/96, NAT64 64:ff9b::/96 and local-use 64:ff9b:1::/48, 6to4 2002::/16, Teredo 2001::/32 whose tail is complemented).
 *  A public v4 embedded any of those ways stays public: the EMBEDDED address is what is judged, never the prefix. */
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
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0x00 && b[5] === 0x01) return isPrivateAddress(dotted(b.slice(12)));   // 64:ff9b:1::/48 local-use NAT64 (RFC 8215)
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return isPrivateAddress(dotted(b.slice(12).map((x) => x ^ 0xff)));   // 2001::/32 Teredo: the client v4 is the COMPLEMENTED tail (RFC 4380 §4)
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

/**
 * The default request: http(s).request to `url`, CONNECTED TO `address` through a `lookup` that returns it and nothing
 * else, with TLS still verifying the url's hostname (servername is the hostname, not the address). Bytes are bounded
 * while streaming. Returns { status, headers: { get }, text }.
 */
export function pinnedRequest({ url, address, family, headers = {}, timeoutMs = 30_000, maxBytes = DEFAULT_MAX_BYTES }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'GET', headers,
      // the address that was CHECKED; no resolver is consulted here. Node ≥20 asks with {all:true} (autoSelectFamily) and
      // expects an ARRAY; a string there is 'Invalid IP address: undefined' (51221, run on node 22 and 24)
      lookup: (_host, opts, cb) => (opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
      servername: u.hostname, timeout: timeoutMs,
    }, (res) => {
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) { res.destroy(); return reject(new Error(`fetch: body is ${declared} bytes, over the ${maxBytes}-byte cap`)); }
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > maxBytes) { res.destroy(); reject(new Error(`fetch: body exceeds the ${maxBytes}-byte cap`)); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: { get: (k) => res.headers[String(k).toLowerCase()] ?? null }, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('fetch: timeout')); });
    req.on('error', reject);
    req.end();
  });
}

export function createFetcher({ allowHttp = false, allowPrivate = false, maxBytes = DEFAULT_MAX_BYTES, maxHops = MAX_HOPS, resolve = defaultResolve, request = pinnedRequest, timeoutMs = 30_000, userAgent = 'manyhands-extractor/1810' } = {}) {
  /** The check: scheme, then the literal or every resolved address. Returns the url AND the address to connect to. Never connects. */
  async function check(urlText) {
    let u;
    try { u = new URL(urlText); } catch { throw new RefusedDestination(urlText, 'not a url'); }
    if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw new RefusedDestination(urlText, `scheme ${u.protocol} (https only)`);
    if (u.username || u.password) throw new RefusedDestination(urlText, 'credentials in the url');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))) throw new RefusedDestination(urlText, `host ${host} is local`);
    if (net.isIP(host)) {
      if (!allowPrivate && isPrivateAddress(host)) throw new RefusedDestination(urlText, `address ${host} is not public`);
      return { u, address: host, family: net.isIPv6(host) ? 6 : 4 };
    }
    let answers;
    try { answers = await resolve(host); } catch (e) { throw new Error(`fetch: could not resolve ${host} (${e?.code ?? e?.message ?? e})`); }
    const addrs = (answers || []).map((x) => (typeof x === 'string' ? { address: x, family: x.includes(':') ? 6 : 4 } : x)).filter((x) => x && x.address);
    if (!addrs.length) throw new Error(`fetch: could not resolve ${host} (no addresses)`);
    if (!allowPrivate) { const bad = addrs.find((x) => isPrivateAddress(x.address)); if (bad) throw new RefusedDestination(urlText, `${host} resolves to ${bad.address}, which is not public`); }
    return { u, address: addrs[0].address, family: addrs[0].family ?? (addrs[0].address.includes(':') ? 6 : 4) };   // CONNECT TO THIS ONE
  }

  /** Fetch a shared link safely. Returns { text, encodingFormat, finalUrl }. */
  return async function fetchSource(urlText) {
    let current = String(urlText);
    for (let hop = 0; hop <= maxHops; hop++) {
      const { u, address, family } = await check(current);   // before EVERY connection, the first included
      const res = await request({ url: u.href, address, family, headers: { accept: 'text/html, text/plain;q=0.9, */*;q=0.1', 'user-agent': userAgent }, timeoutMs, maxBytes });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error(`fetch: ${res.status} without a Location`);
        if (hop === maxHops) throw new Error(`fetch: more than ${maxHops} redirects (hops)`);
        current = new URL(loc, u.href).href;   // a relative Location resolves against the hop; it is CHECKED on the next pass
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw new Error(`fetch: ${res.status}`);
      const type = (res.headers.get('content-type') || '').trim();
      if (type && !TEXT_TYPES.test(type)) throw new Error(`fetch: unsupported content type ${type.split(';')[0]} (text only)`);
      const body = String(res.text ?? '');
      if (Buffer.byteLength(body, 'utf8') > maxBytes) throw new Error(`fetch: body exceeds the ${maxBytes}-byte cap`);
      const html = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(body);
      return { text: html ? htmlToText(body) : body, encodingFormat: html ? 'text/html' : 'text/plain', finalUrl: u.href };
    }
    throw new Error(`fetch: more than ${maxHops} redirects (hops)`);
  };
}
