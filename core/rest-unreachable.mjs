/**
 * #1442 — WHY A CALL TO THE BOARD'S REST API FAILED, not just that it did.
 *
 * Node's fetch (undici) reports every connection-level failure with the same
 * message, "fetch failed"; the reason lives on `err.cause` (`code`: refused,
 * reset, socket closed, timed out …). The MCP adapter used to rethrow all of
 * them as "Cannot reach … Start the dev server" — 2,492 such lines in one
 * log, many of them with the server up and answering, and no way to tell a
 * dead server from a reused keep-alive socket the server had already closed.
 *
 * So: carry the cause, and say "start the dev server" only when that is the
 * true remedy — nothing was listening (ECONNREFUSED).
 */
export function causeOf(err) {
  const c = err?.cause;
  if (!c || typeof c !== 'object') return { code: null, message: null };
  return {
    code: typeof c.code === 'string' ? c.code : null,
    message: typeof c.message === 'string' && c.message ? c.message : null,
  };
}

export function unreachableMessage(base, err) {
  const { code, message } = causeOf(err);
  const why = code
    ? `${err?.message ?? 'fetch failed'}: ${code}${message ? ` ${message}` : ''}`
    : `${err?.message ?? String(err)}; no cause code`;
  const hint = code === 'ECONNREFUSED'
    ? ' Nothing is listening there: start the dev server (`node server.js`).'
    : '';
  return `Cannot reach scrum board REST API at ${base} (${why}).${hint}`;
}
