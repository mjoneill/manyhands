/**
 * core/sha-integrity.mjs — #896: does every sha on the board name a real commit?
 *
 * ⛔ THE DEFECT THIS WATCHES FOR, measured on its author. Two `implementedBy`
 * shas written forty minutes apart were both FABRICATED: seven characters read
 * out of `git push` output, forty characters typed, thirty-three invented. Both
 * passed every check the write path has, because the field validates SHAPE —
 * forty lowercase hex — and not EXISTENCE.
 *
 * ⚠️ And the diagnosis is not carelessness, which is why this is code and not a
 * resolution: **a sha reads as a formality rather than a claim, so it gets typed
 * at the speed of the prose around it.** It sits in a structured field beside
 * sentences that are being composed, and composition is exactly the mode in
 * which invention is normal and correct. An opaque identifier is the one kind of
 * content where being fluent is the hazard.
 *
 * ── WHY A STANDING CHECK AND NOT A VALIDATOR ────────────────────────────────
 *
 * Resolving on write is the obvious fix and it is MEASURED wrong:
 *
 *     a dev-only commit     dev resolves it    YES
 *                           PROD resolves it   NO
 *
 * The server serves from the deploy clone; the real order is commit → push →
 * write the card → THEN pull and deploy. At write time the serving clone does
 * not have the object. ⇒ A write-path check would refuse legitimate shas for a
 * reason their author cannot act on.
 *
 * ⭐ A rail whose failure mode is "the board stops accepting truth" is worse
 * than the defect it prevents. This one refuses nothing.
 */

/** A full git object name. Deliberately strict: an abbreviation is a different defect (#BF4). */
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Every sha the board references, mapped to the cards carrying it.
 *
 * ⚠️ BOTH FIELDS. The fabrication landed in `implementedBy` AND in five
 * `acceptance[].evidence` slots on the same card. Checking only the first would
 * have declared the card fixed while five copies of the invented sha remained —
 * a correction has to reach every copy, and an instrument that reads one field
 * teaches the next reader that the other field is safe.
 */
export function collectShas(board) {
  const found = new Map();
  const note = (raw, shortId) => {
    if (typeof raw !== 'string') return;
    // `commit:<sha>` is how evidence namespaces a durable source; a bare sha is
    // how implementedBy writes one. An `entity:<uuid>` reference is neither, and
    // reporting a uuid as an unresolvable COMMIT would be a false accusation.
    const sha = raw.startsWith('commit:') ? raw.slice(7) : raw;
    if (!SHA_RE.test(sha)) return;
    if (!found.has(sha)) found.set(sha, new Set());
    found.get(sha).add(shortId);
  };

  for (const card of board?.nodes || []) {
    for (const s of card.implementedBy || []) note(s, card.shortId);
    for (const a of card.acceptance || []) {
      for (const e of a?.evidence || []) note(e, card.shortId);
    }
  }
  return found;
}

/**
 * ⭐⭐⭐ Verify the whole population, and REFUSE TO REPORT A ZERO IT DID NOT EARN.
 *
 * @param {object} board
 * @param {object} opts
 * @param {(shas: string[]) => Promise<Set<string>>} opts.resolve
 *        Given every sha at once, return the subset that exists. ONE call for
 *        the whole population — a resolver invoked per sha would spawn a process
 *        per row on an endpoint anyone can hit.
 */
export async function verifyShaIntegrity(board, { resolve }) {
  const found = collectShas(board);
  const shas = [...found.keys()];
  const cardsFor = (sha) => [...found.get(sha)].sort((a, b) => a - b);

  // ⚠️ Named in the OUTPUT, not in a comment only maintainers read. This check
  // runs on the deploy clone, which LAGS the push by design, so a real commit
  // written minutes ago legitimately resolves as missing here.
  const blindTo = 'a real commit not yet fetched into this clone resolves as MISSING here. '
    + 'Unresolvable means UNVERIFIABLE FROM HERE, not fabricated — this runs on the deploy '
    + 'clone, which lags the push by design. Re-check after a pull before treating a row as an invention.';

  // ⛔ AN EMPTY POPULATION IS UNMEASURABLE, NOT CLEAN. Zero shas checked and zero
  // unresolved is a structural zero — the same cell `scored()` refuses one module
  // over, and the same shape as a rail whose covered population is empty (R4).
  if (shas.length === 0) {
    return {
      status: 'unmeasurable',
      checked: 0,
      missingInput: 'no card references a commit sha, so there is nothing to verify — '
        + 'this is an empty population, not a clean one',
      blindTo,
    };
  }

  let live;
  try {
    live = await resolve(shas);
  } catch (e) {
    // ⛔⛔ THE CELL THIS FUNCTION EXISTS TO NOT PRINT. "No fabrications found"
    // and "I could not look" are byte-identical from outside unless the
    // instrument says which one it is. A server with no git repository beside it
    // must report UNMEASURABLE, never a reassuring zero over a real denominator.
    return {
      status: 'unmeasurable',
      checked: shas.length,
      missingInput: `the git repository could not be read, so no sha could be resolved: ${e?.message || e}`,
      blindTo,
    };
  }

  const unresolved = shas
    .filter((s) => !live.has(s))
    .sort()
    .map((sha) => ({ sha, cards: cardsFor(sha) }));

  return { status: 'measured', checked: shas.length, unresolved, blindTo };
}
