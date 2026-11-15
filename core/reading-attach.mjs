/**
 * #1905 — attaching a claim to a card from the Reading page: the page's rules, kept apart from the DOM so they are tested under node
 * (tests/reading-attach-page-1905.test.mjs). Browser-safe ESM with no imports, like core/recall-line.mjs.
 *
 * The actor is never chosen here. The request carries no `by`: a browser signed in through Settings (#1906) holds an HttpOnly
 * session cookie, and the server records the write as that cookie's seat. What the page shows afterwards is the seat the server
 * says it recorded, never a guess.
 */

/** The longest reason the server accepts. Mirrors ATTACH_REASON_MAX in core/graph-compiler.mjs (a test pins them equal). */
export const ATTACH_REASON_MAX = 300;

const cardNumber = (card) => {
  const s = String(card ?? '').trim().replace(/^#/, '');
  return /^[1-9][0-9]*$/.test(s) ? Number(s) : null;
};

/** null when the input can be sent, or one sentence saying what to fix. The same rules the server applies, checked first. */
export function checkAttachInput({ card, reason } = {}) {
  if (cardNumber(card) == null) return 'Give a card number, like 1905.';
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (!r) return 'Give a reason: one line on why this claim bears on that card.';
  if (/[\r\n]/.test(r)) return 'The reason is one line.';
  if (r.length > ATTACH_REASON_MAX) return `The reason is at most ${ATTACH_REASON_MAX} characters.`;
  return null;
}

/** The request the page sends: { url, init } for fetch. The claim is the bare id the page shows; no identity is sent. */
export function attachRequest({ claim, card, reason } = {}) {
  return {
    url: '/api/links/attach',
    init: {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ claim, card: cardNumber(card), reason: typeof reason === 'string' ? reason.trim() : '' }),
    },
  };
}

/**
 * What the page shows for the board's answer: { ok, text, signIn }. Never an empty text: a refusal says the server's own reason,
 * or, when it gave none, the status it answered.
 */
export function attachOutcome(status, body) {
  const b = body && typeof body === 'object' ? body : {};
  if (status === 201 || status === 200) {
    if (b.card == null) return { ok: false, signIn: false, text: `The board answered ${status} but did not say which card; reload the page to see whether the link was made.` };
    const by = typeof b.by === 'string' && b.by.trim() ? b.by.trim() : null;
    return { ok: true, signIn: false, text: by ? `Attached to #${b.card} by ${by}` : `Attached to #${b.card} (the board did not say by whom)` };
  }
  const why = typeof b.error === 'string' && b.error.trim() ? b.error.trim() : null;
  if (status === 401) return { ok: false, signIn: true, text: 'Sign in this browser first (Settings page).' + (why ? ` The board said: ${why}` : '') };
  return { ok: false, signIn: false, text: why || `The board answered ${status} and gave no reason.` };
}
