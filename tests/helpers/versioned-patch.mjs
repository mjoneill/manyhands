/**
 * #1132 — the read-version-then-PATCH helper.
 *
 * `acceptance`, `blockers` and `checks` are whole-array REPLACE fields with no
 * append verb, and PATCH refuses any of them sent without `ifVersion`. Every
 * test that writes one of those arrays is a seat-shaped caller: it must read
 * the card's current version and send it, exactly as a seat must. This helper
 * is that discipline in one place, so the tests exercise the rail instead of
 * being exempted from it.
 *
 * It deliberately does NOT retry on 409: a 409 is a yield, and a test that
 * silently re-reads and re-applies would hide the very race the rail exists
 * to surface. If a test expects a 409 it asserts on it.
 */

/** Read the card's current `version`, then PATCH with `ifVersion` set to it. */
export async function patchWithVersion(baseUrl, shortId, body) {
  const read = await fetch(`${baseUrl}/api/cards/${shortId}`);
  if (read.status !== 200) {
    return { status: read.status, body: await read.json().catch(() => ({})) };
  }
  const { version } = await read.json();
  // A card that has never been written has no `version`; the server's
  // compare-and-swap reads that as 0, and so does this helper — the same rule,
  // not a looser one.
  const ifVersion = Number.isInteger(version) ? version : 0;
  const res = await fetch(`${baseUrl}/api/cards/${shortId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ifVersion, ...body }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/**
 * The same discipline over MCP: `card_get` for the version, then `card_update`
 * with `ifVersion`. `callTool` is the test's own MCP invoker
 * (name, args) → result; the helper does not assume a client shape.
 */
export async function mcpUpdateWithVersion(callTool, args) {
  const got = await callTool('card_get', { id: String(args.id) });
  // The harness returns the RAW JSON-RPC envelope (`result.content`); a
  // higher-level client returns the result itself (`content`). Accept both.
  const content = got?.result?.content ?? got?.content ?? [];
  const text = content[0]?.text ?? '';
  const card = JSON.parse(text);
  const ifVersion = Number.isInteger(card.version) ? card.version : 0;
  return callTool('card_update', { ifVersion, ...args });
}
