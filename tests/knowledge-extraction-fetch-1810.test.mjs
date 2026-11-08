/**
 * #1810 PR B — R9e (destinations): the fetcher never connects to a destination it has not checked.
 *
 * The service runs on the LAN, so a shared link is a request the service makes on the owner's behalf from inside the
 * network. Before EVERY connection, the first one included: the scheme is https (http only behind an explicit knob
 * the tests use for a loopback server), the host is resolved, and loopback, private and link-local addresses are
 * refused, for the literal-IP form and the resolved form alike. Redirects are followed by hand (redirect: 'manual'),
 * each hop checked the same way, at most five hops. The body is bounded in bytes and must be text.
 *
 *   R9e-1  loopback, private and link-local LITERALS are refused before any request (fetch count 0): localhost,
 *          127.0.0.1, 10.x, 172.16–31.x, 192.168.x, 169.254.x, ::1, fc00::/7, fe80::/10, and http:// by default
 *   R9e-2  a public-looking NAME that RESOLVES to a private address is refused before any request
 *   R9e-3  a public first hop that REDIRECTS to a private host: the first hop is fetched (public), the second is never
 *          requested (count stays 1); and five redirects is the ceiling
 *   R9e-4  a body over the byte cap, or a non-text content type (a PDF), is a recorded fetch failure, never text to a model
 *   R9e-5  the happy path: a public name that resolves public, text/html reduced to lines, finalUrl reported
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFetcher, isPrivateAddress, RefusedDestination } from '../core/knowledge-extraction-fetch.mjs';

const PUBLIC_V4 = '93.184.216.34';
/** A resolver by table: a name → its addresses. Unknown names resolve to nothing (ENOTFOUND). */
const resolverOf = (table) => async (host) => { if (!(host in table)) { const e = new Error(`getaddrinfo ENOTFOUND ${host}`); e.code = 'ENOTFOUND'; throw e; } return table[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 })); };
/** A request by table: url → {status, headers, body}; records every request WITH the address it was told to connect to. */
function fetchOf(table) {
  const calls = [];
  const fetch = async ({ url, address, family }) => {
    calls.push({ url: String(url), address, family });
    const r = table[String(url)];
    if (!r) return { status: 404, headers: { get: () => null }, text: 'not found' };
    const h = Object.fromEntries(Object.entries(r.headers ?? { 'content-type': 'text/plain' }).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: r.status ?? 200, headers: { get: (k) => h[String(k).toLowerCase()] ?? null }, text: r.body ?? '' };
  };
  return { calls, fetch };
}
const fetcher = (opts) => createFetcher({ request: opts.fetchImpl, ...Object.fromEntries(Object.entries(opts).filter(([k]) => k !== 'fetchImpl')) });

test('#1810 R9e-1 — private, loopback and link-local literals are refused before any request; http is refused by default', async () => {
  const { calls, fetch } = fetchOf({});
  const fetchSource = fetcher({ fetchImpl: fetch, resolve: resolverOf({}) });
  for (const u of ['https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.1/x', 'https://172.16.0.1/x', 'https://172.31.255.255/x', 'https://192.168.1.9/x', 'https://169.254.169.254/latest', 'https://[::1]/x', 'https://[fd00::1]/x', 'https://[fe80::1]/x', 'https://0.0.0.0/x', 'http://example.test/x', 'ftp://example.test/x', 'file:///etc/hosts']) {
    await assert.rejects(() => fetchSource(u), (e) => e instanceof RefusedDestination, `${u} refused as a destination`);
  }
  assert.equal(calls.length, 0, 'not one request was made');
  assert.equal(isPrivateAddress('172.32.0.1'), false, '172.32 is public (the private block ends at 172.31)');
  assert.equal(isPrivateAddress('100.64.0.1'), true, 'carrier-grade NAT space is not public either');
});

test('#1810 R9e-2 — a public-looking name that RESOLVES to a private address is refused before any request', async () => {
  const { calls, fetch } = fetchOf({ 'https://sneaky.example.test/x': { body: 'secret' } });
  const fetchSource = fetcher({ fetchImpl: fetch, resolve: resolverOf({ 'sneaky.example.test': ['192.168.1.9'], 'mixed.example.test': [PUBLIC_V4, '10.0.0.5'] }) });
  await assert.rejects(() => fetchSource('https://sneaky.example.test/x'), RefusedDestination);
  await assert.rejects(() => fetchSource('https://mixed.example.test/x'), RefusedDestination, 'ONE private address among the answers is enough to refuse');
  await assert.rejects(() => fetchSource('https://unknown.example.test/x'), /ENOTFOUND|resolve/, 'a name that does not resolve is a fetch failure, not a request');
  assert.equal(calls.length, 0);
});

test('#1810 R9e-3 — a public hop that redirects to a private host: the first hop is fetched, the second is never requested; five hops is the ceiling', async () => {
  const table = {
    'https://pub.example.test/a': { status: 302, headers: { location: 'https://192.168.1.9/secret' } },
    'https://pub.example.test/b': { status: 302, headers: { location: 'https://inner.example.test/c' } },
    'https://inner.example.test/c': { body: 'nope' },
    'https://pub.example.test/loop1': { status: 302, headers: { location: 'https://pub.example.test/loop2' } },
    'https://pub.example.test/loop2': { status: 302, headers: { location: 'https://pub.example.test/loop3' } },
    'https://pub.example.test/loop3': { status: 302, headers: { location: 'https://pub.example.test/loop4' } },
    'https://pub.example.test/loop4': { status: 302, headers: { location: 'https://pub.example.test/loop5' } },
    'https://pub.example.test/loop5': { status: 302, headers: { location: 'https://pub.example.test/loop6' } },
    'https://pub.example.test/loop6': { status: 302, headers: { location: 'https://pub.example.test/end' } },
    'https://pub.example.test/end': { body: 'the end' },
    'https://pub.example.test/rel': { status: 301, headers: { location: '/end' } },
  };
  const { calls, fetch } = fetchOf(table);
  const fetchSource = fetcher({ fetchImpl: fetch, resolve: resolverOf({ 'pub.example.test': [PUBLIC_V4], 'inner.example.test': ['10.1.2.3'] }) });
  await assert.rejects(() => fetchSource('https://pub.example.test/a'), RefusedDestination, 'the redirect target is a private literal');
  assert.deepEqual(calls.map((c) => c.url), ['https://pub.example.test/a'], 'exactly the public hop was requested');
  assert.ok(calls.every((c) => c.address === PUBLIC_V4), 'every connection went to the address that was checked');
  calls.length = 0;
  await assert.rejects(() => fetchSource('https://pub.example.test/b'), RefusedDestination, 'the redirect target RESOLVES private');
  assert.deepEqual(calls.map((c) => c.url), ['https://pub.example.test/b']);
  calls.length = 0;
  await assert.rejects(() => fetchSource('https://pub.example.test/loop1'), /redirect|hops/, 'six redirects is one too many');
  assert.equal(calls.length, 6, 'five hops followed, the sixth refused before the request');
  calls.length = 0;
  const r = await fetchSource('https://pub.example.test/rel');
  assert.equal(r.text, 'the end'); assert.equal(r.finalUrl, 'https://pub.example.test/end', 'a relative Location resolves against the hop');
});

test('#1810 R9e-4 — a body over the byte cap, or a non-text type, is a fetch failure, never text to a model', async () => {
  const big = 'x'.repeat(2000);
  const { fetch } = fetchOf({
    'https://pub.example.test/big': { body: big, headers: { 'content-type': 'text/plain' } },
    'https://pub.example.test/pdf': { body: '%PDF-1.7 binary', headers: { 'content-type': 'application/pdf' } },
    'https://pub.example.test/octet': { body: 'bytes', headers: { 'content-type': 'application/octet-stream' } },
    'https://pub.example.test/ok': { body: 'fine', headers: { 'content-type': 'text/plain; charset=utf-8' } },
  });
  const fetchSource = fetcher({ fetchImpl: fetch, resolve: resolverOf({ 'pub.example.test': [PUBLIC_V4] }), maxBytes: 1000 });
  await assert.rejects(() => fetchSource('https://pub.example.test/big'), /bytes|cap|too large/i);
  await assert.rejects(() => fetchSource('https://pub.example.test/pdf'), /type|pdf/i);
  await assert.rejects(() => fetchSource('https://pub.example.test/octet'), /type/i);
  assert.equal((await fetchSource('https://pub.example.test/ok')).text, 'fine');
});

test('#1810 R9e-5 — the happy path: a public name, text/html reduced to lines, the final url reported; the loopback knob admits a test server and nothing else', async () => {
  const html = '<html><head><title>T</title><style>p{}</style><script>x()</script></head><body><h1>What is a harness?</h1><p>A harness is the <b>layer</b> &amp; more.</p><p>Second.</p></body></html>';
  const { fetch } = fetchOf({ 'https://pub.example.test/page': { body: html, headers: { 'content-type': 'text/html; charset=utf-8' } }, 'http://127.0.0.1:1/local': { body: 'local text' } });
  const fetchSource = fetcher({ fetchImpl: fetch, resolve: resolverOf({ 'pub.example.test': [PUBLIC_V4] }) });
  const r = await fetchSource('https://pub.example.test/page');
  assert.equal(r.encodingFormat, 'text/html');
  assert.deepEqual(r.text.split('\n'), ['T', 'What is a harness?', 'A harness is the layer & more.', 'Second.'], 'scripts and styles gone, block tags to lines, entities decoded');
  assert.equal(r.finalUrl, 'https://pub.example.test/page');
  const local = fetcher({ fetchImpl: fetch, resolve: resolverOf({}), allowHttp: true, allowPrivate: true });
  assert.equal((await local('http://127.0.0.1:1/local')).text, 'local text', 'the knobs admit a loopback test server');
  await assert.rejects(() => local('https://192.168.1.9/x'), (e) => !(e instanceof RefusedDestination), 'with allowPrivate the private literal is not refused as a destination (it is simply not in the fake table: 404)');
});

test('#1810 R9e-6 — an IPv4 embedded in an IPv6 literal (mapped, compatible, NAT64 incl. RFC 8215 local-use, 6to4, Teredo) is refused before any request, in the hex form the URL parser produces; the dotted shorthands are refused too', async () => {
  const { calls, fetch } = fetchOf({});
  const fetchSource = fetcher({ fetchImpl: fetch, resolve: resolverOf({}) });
  // the URL parser rewrites a mapped v4 into hex: `[::ffff:127.0.0.1]` → hostname `[::ffff:7f00:1]` (51203, run not read)
  for (const u of ['https://[::ffff:127.0.0.1]/', 'https://[::ffff:192.168.7.68]/', 'https://[::ffff:7f00:1]/', 'https://[::ffff:c0a8:744]/',
    'https://[::127.0.0.1]/', 'https://[::7f00:1]/', 'https://[64:ff9b::7f00:1]/', 'https://[64:ff9b::c0a8:1]/', 'https://[2002:7f00:1::1]/', 'https://[2002:c0a8:101::1]/',
    'https://[2002:c0a8:0744::1]/', 'https://[2001:0:4136:e378:8000:63bf:80ff:fffe]/', 'https://[2001:0:4136:e378:8000:63bf:3fff:fdff]/', 'https://[64:ff9b:1::7f00:1]/', 'https://[64:ff9b:1:0:0:0:c0a8:744]/',   // 6to4 of 192.168.7.68; Teredo (RFC 4380 §4, client v4 is the complemented tail: 7f00:1→80ff:fffe, c000:200→3fff:fdff); RFC 8215 local-use NAT64
    'https://127.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://[::]/', 'https://[0:0:0:0:0:0:0:1]/']) {
    await assert.rejects(() => fetchSource(u), (e) => e instanceof RefusedDestination, `${u} refused as a destination`);
  }
  assert.equal(calls.length, 0, 'not one request was made');
  for (const ip of ['::ffff:7f00:1', '::ffff:c0a8:744', '::7f00:1', '64:ff9b::7f00:1', '2002:c0a8:101::1', '::ffff:10.0.0.1', '2001:0:4136:e378:8000:63bf:80ff:fffe', '64:ff9b:1::c0a8:744']) assert.equal(isPrivateAddress(ip), true, `${ip} is not public`);
  for (const ip of ['::ffff:5db8:d822', '64:ff9b::5db8:d822', '2002:5db8:d822::1', '2001:0:4136:e378:8000:63bf:a247:27dd', '64:ff9b:1::5db8:d822', '2001:db8::1', '2607:f8b0:4005:80a::200e']) assert.equal(isPrivateAddress(ip), false, `${ip} is public (a mapped or NAT64 PUBLIC v4 stays public; documentation and a real global address are not refused by shape)`);
});

test('#1810 R9e-7 — the connection is PINNED to the checked address: a resolver that answers public on the check and private on any later lookup never gets a connection to the private address, and is consulted exactly once per hop', async () => {
  let asks = 0;
  const flipping = async (host) => { asks += 1; return [{ address: asks === 1 ? PUBLIC_V4 : '192.168.1.9', family: 4 }]; };   // public once, then private forever
  const { calls, fetch } = fetchOf({ 'https://flip.example.test/x': { body: 'from the public address' } });
  const fetchSource = fetcher({ fetchImpl: fetch, resolve: flipping });
  const r = await fetchSource('https://flip.example.test/x');
  assert.equal(r.text, 'from the public address');
  assert.deepEqual(calls.map((c) => c.address), [PUBLIC_V4], 'the ONE connection went to the address that was checked');
  assert.equal(asks, 1, 'the resolver was consulted once, at the check; the connection resolved nothing');
  assert.ok(!calls.some((c) => c.address === '192.168.1.9'), 'the private answer was never connected to');
  // and across a redirect: each hop is checked once and connected to what its check returned
  asks = 0;
  const table = { 'https://flip.example.test/a': { status: 302, headers: { location: 'https://flip.example.test/b' } }, 'https://flip.example.test/b': { body: 'b' } };
  const twice = fetchOf(table);
  const perHop = async () => { asks += 1; return [{ address: asks <= 2 ? PUBLIC_V4 : '10.0.0.9', family: 4 }]; };
  const f2 = fetcher({ fetchImpl: twice.fetch, resolve: perHop });
  assert.equal((await f2('https://flip.example.test/a')).text, 'b');
  assert.deepEqual(twice.calls.map((c) => c.address), [PUBLIC_V4, PUBLIC_V4]);
  assert.equal(asks, 2, 'one resolution per hop, none at connect');
});
