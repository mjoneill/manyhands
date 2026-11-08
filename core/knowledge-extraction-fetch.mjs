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
 * lookup moments later could swap the address (a DNS rebinding). Pinning the connection to the checked address needs
 * a dispatcher with its own lookup (undici's Agent), and undici is a dev-only dependency here; when it becomes a
 * production one, pin it and delete this paragraph.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

export const MAX_HOPS = 5;
export const DEFAULT_MAX_BYTES = 3_000_000;
const TEXT_TYPES = /^(text\/|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml))/i;

export class RefusedDestination extends Error {
  constructor(url, why) { super(`refused destination ${url}: ${why}`); this.name = 'RefusedDestination'; this.url = url; this.why = why; }
}

const v4 = (ip) => ip.split('.').map(Number);
/** Loopback, private (RFC 1918), link-local, CGNAT, unspecified, and their IPv6 counterparts and mappings. */
export function isPrivateAddress(ip) {
  if (typeof ip !== 'string' || !ip) return true;
  let a = ip.trim().replace(/^\[|\]$/g, '');
  if (net.isIPv6(a)) {
    const low = a.toLowerCase();
    if (low === '::1' || low === '::') return true;
    const m = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);   // IPv4-mapped
    if (m) return isPrivateAddress(m[1]);
    if (/^f[cd]/.test(low)) return true;            // fc00::/7 unique local
    if (/^fe[89ab]/.test(low)) return true;         // fe80::/10 link-local
    return false;
  }
  if (!net.isIPv4(a)) return true;                  // not an address at all
  const [o1, o2] = v4(a);
  if (o1 === 10 || o1 === 127 || o1 === 0) return true;
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
  if (o1 === 192 && o2 === 168) return true;
  if (o1 === 169 && o2 === 254) return true;
  if (o1 === 100 && o2 >= 64 && o2 <= 127) return true;   // 100.64.0.0/10 CGNAT
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
