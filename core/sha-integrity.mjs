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

  // ⚠️ `cards`, and `nodes` as a fallback. THE FIRST VERSION READ ONLY `nodes` —
  // the domain shape — while the server hands this function `readBoard()`, which
  // returns `cards`. It found ZERO shas on a board carrying 264 of them.
  //
  // ⭐ AND THE INSTRUMENT CAUGHT ITS OWN WIRING BUG, because it refuses to call
  // an empty population clean: it reported UNMEASURABLE / "this is an empty
  // population, not a clean one" rather than "0 unresolved". A version that
  // printed a zero would have looked like a passing audit of a board it had
  // never actually read. That is the whole discipline of this file, arriving one
  // minute after the file was written, aimed at its author.
  for (const card of board?.cards || board?.nodes || []) {
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

// ── #1008 — resolve at DEPLOY time, across EVERY known root; read the STAMP live ──
//
// The live server runs from a read-only export with no `.git` BY DESIGN (#535,
// #586), so `verifyShaIntegrity` above is structurally unmeasurable where it
// runs (measured 2026-08-23 and 2026-09-02). The ruling (Option B on #1008):
// keep the export git-free and move the resolving to the deploy, which stands
// beside a clone. #1112 item 4 refined it after a real instance — the board
// spans TWO repositories, and nine real commits resolve only in the private
// ops tree — so the resolver takes N roots and says which one answered.

/** The population, stated beside every number so "294 checked" cannot be read as "292 checked". */
export const SHA_POPULATION = 'implementedBy ∪ acceptance[].evidence';

/**
 * @param {object} board
 * @param {{ roots: Array<{ root: string, resolve: (shas: string[]) => Promise<Set<string>> }> }} opts
 */
export async function verifyShaIntegrityAcrossRoots(board, { roots, deployedSha = null }) {
  const found = collectShas(board);
  const shas = [...found.keys()];
  const cardsFor = (sha) => [...found.get(sha)].sort((a, b) => a - b);
  const enumerated = shas.length;
  if (!Array.isArray(roots) || roots.length === 0) {
    return { status: 'unmeasurable', population: SHA_POPULATION, enumerated,
      missingInput: 'no root was configured to resolve against — set the roots explicitly; a resolver with nothing to ask is not a clean board' };
  }
  if (enumerated === 0) {
    return { status: 'unmeasurable', population: SHA_POPULATION, enumerated,
      missingInput: 'no card references a commit sha, so there is nothing to verify — this is an empty population, not a clean one' };
  }
  const rootResults = [];
  const resolvedBy = {};
  // #1020 — RESOLUTION IS NOT ANCESTRY, and conflating them would hide work.
  //
  // `resolvedBy` answers "does this commit EXIST in a root". The queue needs
  // "is it in the history production is serving" — a different question.
  // Measured on prod 2026-09-03 (deployedSha 18b28908a): of 381 resolved shas,
  // TEN were not ancestors of it — branches, abandoned experiments, local
  // integration candidates. Seven cards carry one, and #1029 was in backlog
  // being offered as ready. A `shipped` mark keyed on resolvedBy would have
  // taken it out of the queue: real unstarted work, hidden by the fix meant to
  // reveal hidden work — strictly worse than the defect, because today's error
  // is visible the moment you open the card.
  //
  // ⭐ Computed HERE because this is where the git roots are. Production serves
  // an export with no `.git` beside it (#1008's whole reason this stamp
  // exists), so a reader cannot answer it — a version that computed it in the
  // reader would pass every test on a dev box and be blind exactly in prod.
  //
  // ⚠️ Per (sha, root): only the root that BOTH resolved it AND has it merged
  // vouches. Two roots can hold the same object with one of them not having
  // merged it; an "any root" answer would re-import the defect one level up.
  const inDeployed = {};
  const ancestryBlind = [];
  for (const r of roots) {
    try {
      const live = await r.resolve(shas);
      let n = 0;
      for (const s of shas) if (live.has(s)) { n += 1; (resolvedBy[s] ||= []).push(r.root); }
      rootResults.push({ root: r.root, status: 'read', resolved: n });
      if (deployedSha) {
        // FAIL CLOSED. A root that cannot answer — no `ancestors`, or a walk
        // that throws — vouches for nothing and is NAMED. The failure that
        // matters here is hiding work, so an unknown answer stays plain ready.
        if (typeof r.ancestors !== 'function') {
          ancestryBlind.push(`${r.root}: resolver has no ancestors() — nothing from it is marked in-deployed`);
        } else {
          try {
            const anc = await r.ancestors(deployedSha);
            for (const s of shas) if (live.has(s) && anc.has(s)) (inDeployed[s] ||= []).push(r.root);
          } catch (e) {
            ancestryBlind.push(`${r.root}: ${String(e?.message || e).trim().split('\n')[0]}`);
          }
        }
      }
    } catch (e) {
      rootResults.push({ root: r.root, status: 'unreadable', resolved: 0, error: String(e?.message || e) });
    }
  }
  const unreadable = rootResults.filter((r) => r.status === 'unreadable');
  if (unreadable.length === rootResults.length) {
    // ⛔⛔ THE CELL THIS MODULE EXISTS TO NOT PRINT: every root failed, so nothing was looked at.
    return { status: 'unmeasurable', population: SHA_POPULATION, enumerated, roots: rootResults,
      missingInput: 'no root could be read, so no sha was resolved: '
        + unreadable.map((r) => `${r.root}: ${r.error}`).join(' · ') };
  }
  const unresolved = shas.filter((s) => !resolvedBy[s]).sort().map((sha) => ({ sha, cards: cardsFor(sha) }));
  const partial = unreadable.length > 0;
  const blindTo = (partial
    ? `root(s) that could not be read this time — ${unreadable.map((r) => r.root).join(', ')} — so a commit living only there reads as unresolved here. `
    : '')
    + 'A real commit not yet fetched into a root resolves as MISSING there. Unresolvable means UNVERIFIABLE FROM THESE ROOTS, not fabricated — re-check after a fetch before treating a row as an invention.';
  // #1020 — ABSENT, not empty, when no deployed sha was given. An empty map
  // reads as "nothing is shipped" and would silently flip every card back to
  // plain ready; absence says the question was never asked. Same reason the
  // blind list is stated rather than implied (#1146).
  const ancestryBlindTo = !deployedSha
    ? 'ancestry was NOT computed: no deployed sha was given to resolve against, so no sha is marked in-deployed'
    : (ancestryBlind.length
      ? `root(s) that could not answer the ancestry question — ${ancestryBlind.join(' · ')} — so a commit merged only there is NOT marked in-deployed`
      : null);
  return { status: 'measured', population: SHA_POPULATION, enumerated, checked: enumerated,
    roots: rootResults, resolvedBy, unresolved, ...(partial ? { partial: true } : {}),
    ...(deployedSha ? { inDeployed } : {}),
    ...(ancestryBlindTo ? { ancestryBlindTo } : {}),
    blindTo };
}

/**
 * Read a deploy-time stamp against the LIVE board. A stamp is a point-in-time
 * claim, so the result carries its date, its roots and its population, and
 * separates three things a reader would otherwise conflate:
 *   unresolved            in NO root at the stamp, and still on the board
 *   unverifiedSinceStamp  written after the stamp — the deploy never saw it.
 *                         Never "missing": the serving tree lags the push by
 *                         design, and "missing" is this room's word for invented.
 *   (dropped)             a stamp finding whose sha has since left the board
 */
export function readShaStamp(stamp, board) {
  const found = collectShas(board);
  const cardsFor = (sha) => [...(found.get(sha) || [])].sort((a, b) => a - b);
  const enumerated = found.size;
  const base = { resolvedAt: stamp?.resolvedAt ?? null, deployedSha: stamp?.deployedSha ?? null,
    population: stamp?.population ?? SHA_POPULATION, enumerated };
  if (!stamp || stamp.status !== 'measured') {
    return { ...base, status: 'unmeasurable', roots: stamp?.roots,
      missingInput: `the last deploy stamp was itself unmeasurable: ${stamp?.missingInput ?? 'no stamp status'}` };
  }
  const seen = new Set([...Object.keys(stamp.resolvedBy || {}), ...(stamp.unresolved || []).map((u) => u.sha)]);
  const unresolved = (stamp.unresolved || []).filter((u) => found.has(u.sha)).map((u) => ({ sha: u.sha, cards: cardsFor(u.sha) }));
  const unverifiedSinceStamp = [...found.keys()].filter((s) => !seen.has(s)).sort().map((sha) => ({ sha, cards: cardsFor(sha) }));
  // #1146 — DEPARTURES, named with members. A sha the stamp checked that the
  // live board no longer carries is the ONE way the unresolved count can fall
  // without anything resolving: someone removed the evidence entry. That can
  // be a correction (dead pre-rebase shas) or a tidy-up (swapping an orphan
  // for a resolvable sha to make the check go green); the instrument cannot
  // tell them apart, so it names the sha and the cards it was on at stamp
  // time and lets a reader ask. A count would only say it happened.
  // #1020 condition 3 — THE PROXY IS RETIRED WHERE IT IS READ, not only where
  // it is queued.
  //
  // ⛔ The first two commits of #1020 got `inDeployed` as far as `board_ready`
  // and no further: this function did not pass it through, so `/api/checks` —
  // where a reader actually looks at sha state — could not see it. The queue
  // got smarter and every human and agent tally stayed wrong, which is exactly
  // the failure the condition names. A seat counted `column != done` and
  // published the wrong number twice on 2026-08-24.
  //
  // Shaped like `unresolved` (sha → the cards it is on) so a reader goes from
  // "this shipped" to "so these cards can close" without a second query, and
  // filtered to shas the LIVE board still carries — a stamp entry for a sha
  // nobody references any more is a departure, not a finding (#1146).
  const inDeployed = stamp.inDeployed
    ? Object.entries(stamp.inDeployed)
      .filter(([sha]) => found.has(sha))
      .map(([sha, roots]) => ({ sha, cards: cardsFor(sha), roots: [...(roots || [])].sort() }))
      .sort((a, b) => (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0))
    : null;
  const stampCards = new Map((stamp.unresolved || []).map((u) => [u.sha, [...(u.cards || [])].sort((a, b) => a - b)]));
  const departedSinceStamp = [...seen].filter((s) => !found.has(s)).sort().map((sha) => ({ sha, cards: stampCards.get(sha) || [] }));
  // The identity the three counters must satisfy, ASSERTED rather than only
  // documented: a documented invariant is a claim, an asserted one is a rail.
  // If it ever stops holding the payload says so instead of serving three
  // numbers shaped like ones that reconcile.
  const expectedChecked = enumerated + departedSinceStamp.length - unverifiedSinceStamp.length;
  const reconciles = Number.isInteger(stamp.checked) && stamp.checked === expectedChecked;
  return { ...base, status: 'stamped', checked: stamp.checked, roots: stamp.roots, ...(stamp.partial ? { partial: true } : {}),
    unresolved, unverifiedSinceStamp, departedSinceStamp,
    // ABSENT, never []. An empty list reads as "nothing has shipped", which
    // would tell a reader every card is still open — a false negative on the
    // exact question this field exists to answer.
    ...(inDeployed ? { inDeployed } : {}),
    ...(reconciles ? {} : { inconsistent: { checked: stamp.checked ?? null, expectedChecked,
      means: 'checked (at stamp) should equal enumerated (live) + departures − arrivals and does not: the stamp and the board disagree about the population in a way these lists do not explain. Do not quote these counters until re-stamped.' } }),
    means: 'inDeployed lists the shas that are ANCESTORS of the deployed sha — in the history production serves, not merely resolvable in a clone (ten of 381 live shas resolve in a root and are NOT in the deployed history), so a card whose every sha is listed here is shipped and its remaining work is verification. enumerated is the LIVE population (the board now); checked is the population AT THE STAMP (resolvedAt). '
      + 'They differ by arrivals (unverifiedSinceStamp) minus departures (departedSinceStamp). A departure is a sha the '
      + 'stamp checked that no card carries any more — the only way unresolved can shrink without anything resolving — '
      + 'so it is listed with the cards it left, for a reader to ask whether it was corrected or dropped.',
    blindTo: `${stamp.inDeployed ? '' : 'inDeployed is ABSENT: this stamp was written before ancestry was recorded, so nothing is claimed to be shipped — do NOT read resolvedBy as ancestry. '}resolved at deploy (${stamp.resolvedAt}), not now: a sha written since is listed under unverifiedSinceStamp, not accused. ${stamp.blindTo || ''}`.trim() };
}

/** `git cat-file --batch-check` in one root, one process for the whole population. */
export function gitRootResolver(root) {
  return {
    root,
    resolve: async (shas) => {
      const { execFile } = await import('node:child_process');
      const out = await new Promise((ok, bad) => {
        const child = execFile('git', ['cat-file', '--batch-check'], { cwd: root, maxBuffer: 8 << 20 },
          (err, stdout, stderr) => (err ? bad(new Error(String(stderr || err.message).trim().split('\n')[0])) : ok(stdout)));
        child.on('error', bad);
        child.stdin.end(shas.join('\n') + '\n');
      });
      const live = new Set();
      for (const line of out.split('\n')) {
        const [sha, kind] = line.trim().split(/\s+/);
        if (sha && kind === 'commit') live.add(sha);
      }
      return live;
    },
    /**
     * #1020 — the full ancestor set of `of`, in ONE `git rev-list` per root.
     *
     * The alternative is `merge-base --is-ancestor` per sha: 381 processes on
     * today's board against one. This walk is the whole history once, and the
     * caller does set membership.
     *
     * ⚠️ THROWS rather than returning an empty set when the sha is unknown to
     * this root — `git rev-list <unknown>` exits non-zero, and the caller
     * treats a throw as "this root vouches for nothing" and names it. An empty
     * set would be indistinguishable from "the deployed commit has no history",
     * which is the empty-versus-blind confusion this room keeps paying for.
     */
    ancestors: async (of) => {
      const { execFile } = await import('node:child_process');
      const out = await new Promise((ok, bad) => {
        execFile('git', ['rev-list', of], { cwd: root, maxBuffer: 64 << 20 },
          (err, stdout, stderr) => (err ? bad(new Error(String(stderr || err.message).trim().split('\n')[0])) : ok(stdout)));
      });
      const anc = new Set();
      for (const line of out.split('\n')) { const s = line.trim(); if (s) anc.add(s); }
      return anc;
    },
  };
}
