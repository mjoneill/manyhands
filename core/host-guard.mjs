/**
 * #1338 — the Host guard. Both servers call this at their choke point, before
 * any routing, and refuse with 421 when it says no.
 *
 * ⛔ WHY A LOOPBACK-BOUND SERVER NEEDS THIS AT ALL.
 *
 * The board binds 127.0.0.1 and sets no CORS headers, and #249 made every
 * mutation require application/json so a cross-origin page cannot get through
 * the preflight. All of that assumes the attacker's request is CROSS-origin.
 * DNS rebinding makes it same-origin:
 *
 *     1  the operator opens http://attacker.example:3141/  (attacker's page, DNS → attacker's IP, TTL 1s)
 *     2  the attacker flips DNS:  attacker.example → 127.0.0.1
 *     3  the page fetches http://attacker.example:3141/api/cards
 *          browser:  same origin as the page ⇒ no preflight, no CORS, nothing to refuse
 *          board:    receives  Host: attacker.example  ⇒ answers
 *
 * Bind address, CORS stance and #249 are all satisfied. The one thing that
 * differs from a real request is the Host header. Reproduced live 2026-09-10:
 * `Host: attacker.example` → 200 with real commons content. Found by a seat at
 * a second installation evaluating that install's security; the fix is hers.
 *
 * ⚠️ WHAT THIS GUARD DECIDES. A request is served only when its Host names
 * this server: a loopback name (localhost · 127.0.0.1 · [::1]) bare or with
 * this server's port, or an exact name from SCRUM_ALLOWED_HOSTS. Everything
 * else — a foreign name, a loopback name on a FOREIGN port, an absent or
 * malformed Host — is refused. "Absent" is refused on purpose: a header the
 * attacker can omit is not a header the guard can default.
 *
 * ⚠️ WHAT IT MUST NOT DO. Read X-Forwarded-Host, or any header a client can
 * add. This server is loopback-bound; the wire Host is the whole question.
 *
 * ⛔ A WRONG ALLOWLIST MUTES EVERY SEAT AT ONCE — the browser, every MCP client,
 * the deploy probes, the fanout watch, the guest wake, the prior-art hook.
 * That is why SCRUM_ALLOWED_HOSTS exists (an install that reaches its board by
 * another local name is one line of config, not a broken room) and why the
 * refusal names it. Every legitimate client on this machine was enumerated
 * before this shipped: all send 127.0.0.1 or localhost.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Split `name[:port]` into its parts, or return null when the header cannot be
 * read as one authority. Bracketed IPv6 (`[::1]:3141`) is the only place a
 * colon may appear inside the name.
 */
function parseAuthority(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s || /\s/.test(s)) return null;
  let name, portText;
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    if (close < 0) return null;
    name = s.slice(0, close + 1);
    const rest = s.slice(close + 1);
    if (rest === '') portText = undefined;
    else if (rest.startsWith(':')) portText = rest.slice(1);
    else return null;
  } else {
    const parts = s.split(':');
    if (parts.length > 2) return null;
    [name, portText] = parts;
  }
  if (!name) return null;
  let port;
  if (portText !== undefined) {
    if (!/^\d{1,5}$/.test(portText)) return null;
    port = Number(portText);
    if (port < 1 || port > 65535) return null;
  }
  return { name, port };
}

/**
 * SCRUM_ALLOWED_HOSTS → the entries an operator typed, lower-cased, trimmed,
 * empties dropped. An entry may carry its own port; one that does is allowed
 * only on that port, one that does not is allowed bare or on this server's.
 */
export function parseAllowedHosts(text) {
  if (typeof text !== 'string') return [];
  return text.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
}

/**
 * The decision. `port` is the port THIS server is bound to; `extra` is the
 * parsed SCRUM_ALLOWED_HOSTS list.
 */
export function hostAllowed(rawHost, { port, extra = [] } = {}) {
  const got = parseAuthority(rawHost);
  if (!got) return false;
  const portOk = got.port === undefined || got.port === port;
  if (LOOPBACK.has(got.name)) return portOk;
  for (const entry of extra) {
    const want = parseAuthority(entry);
    if (!want || want.name !== got.name) continue;
    if (want.port !== undefined) { if (got.port === want.port) return true; continue; }
    if (portOk) return true;
  }
  return false;
}

/**
 * The refusal, written once so both servers say the same thing. 421
 * Misdirected Request is the status for "this server is not the one your
 * Host names". The body names the override and carries nothing from the
 * board: a refusal that leaked content would be the attack with a worse code.
 */
export function refuseHost(res, rawHost) {
  // The echoed value is attacker-chosen. Plain text, nosniff, printable ASCII
  // only, capped — so it can neither render nor forge a line in a log.
  const shown = typeof rawHost === 'string' && rawHost.length > 0
    ? rawHost.slice(0, 120).replace(/[^\x20-\x7e]/g, '?')
    : '(absent)';
  res.writeHead(421, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(`421 Misdirected Request — this board serves localhost / 127.0.0.1 only; got Host: ${shown}. `
    + `If you reach the board by another local name, list it in SCRUM_ALLOWED_HOSTS (comma-separated). (#1338)\n`);
}
