/**
 * core/card-content-key.mjs — "did this card change?", as ONE definition.
 *
 * #534 — content identity, EXCLUDING the version itself. The server uses it in
 * handleSave to decide whether an incoming card actually differs from the
 * stored one, because bumping a card the client did not touch is not
 * harmless: it would fail a legitimate holder's ifVersion, and over-refusing
 * is how a precondition breaks working writers.
 *
 * #466 — the BROWSER now needs the same answer: on a refused save it must
 * tell a stale card it never touched (take the server's copy, retry) from a
 * stale card it edited (a real conflict, keep the edit on screen). Two
 * implementations of "did this change" that could disagree would be #466's
 * defect one layer up — a card the server calls changed and the client calls
 * untouched is a silent revert with extra steps. So there is one function,
 * pure and browser-safe, imported by both. tests/save-stale-merge.test.mjs
 * pins that server.js does not grow a private copy again.
 */

export function cardContentKey(card) {
  const seen = new Set();
  return JSON.stringify(card, (k, v) => {
    if (k === 'version') return undefined;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (seen.has(v)) return v;
      seen.add(v);
      return Object.fromEntries(Object.keys(v).sort().map((kk) => [kk, v[kk]]));
    }
    return v;
  });
}
