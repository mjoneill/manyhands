/**
 * tools/flow-report.mjs — #1027. Does work FINISH?
 *
 * The room has watches for liveness, delivery, integrity, durability and code
 * quality, plus deploy-drift for published-vs-running. None of them asks
 * whether work ARRIVES. On 2026-08-23 seven commits across four p1 cards
 * produced ZERO completions and nobody noticed until the principal did, by eye.
 *
 * ⛔⛔ THE DEFECT THIS MUST NOT COMMIT, and it dictates the whole shape:
 *
 *     A report that derives its population FROM ACTIVITY CANNOT SEE INACTIVITY.
 *
 * Walk the claims to find the seats, and a seat holding nothing has no row —
 * so the one signal that mattered (a teammate who pulled nothing for hours) is
 * exactly the signal the natural implementation deletes. That is not a bug you
 * find in review; it is invisible by construction, and it is how a colleague
 * became invisible for an evening.
 *
 * ⇒ THE ROSTER IS AN INPUT, NOT AN INFERENCE. Absence needs somewhere to appear.
 *
 * Read-only, pure over its inputs, exits 0. It REPORTS; it does not gate —
 * a report that fails its caller teaches the caller to stop calling it.
 */

const HOUR = 3600_000;

/**
 * @param {{cards:Array|null, roster:string[], now:number, windowHours?:number, staleClaimHours?:number}} opts
 */
export function flowReport({ cards, roster = [], now = Date.now(), windowHours = 24, staleClaimHours = 6, deployedShas = null } = {}) {
  // ⛔ UNKNOWN ≠ ZERO. A failed read and an idle room produce identical counts,
  // and only one of them is information. `null` is "I could not find out";
  // `[]` is a genuine measurement of an empty board, and stays measurable.
  if (!Array.isArray(cards)) {
    const error = 'no cards available — could not read the board, so nothing about flow is known';
    return {
      ok: false, touched: null, touchedAndDone: null, wip: [], staleClaims: [], blockedClaims: [], hasUndeployedWork: null, lines: [],
      summary: `flow: UNKNOWN — ${error}`, error,
    };
  }

  const since = now - windowHours * HOUR;
  const at = (c) => Date.parse(c.updatedAt || c.createdAt || 0) || 0;
  const isDone = (c) => String(c.column || '').endsWith('done');

  const inWindow = cards.filter((c) => at(c) >= since);
  const touched = inWindow.length;

  // ⛔⛔ NOT `finished`. This is touched-in-window AND currently in done, which
  // counts a card that was ALREADY done and merely got EDITED.
  //
  // Found by review against production, 2026-08-24: two of the cards inflating
  // this number were a PO's own grooming — a blocker note and a successor-gap
  // append, both on cards closed days earlier.
  //
  // ⭐⭐⭐ The irony is the point: the more carefully someone annotates COMPLETED
  // cards, the more this report claims work is FINISHING. A metric built
  // because completions were not happening rises when nothing completes and
  // somebody tidies.
  //
  // A true finishing count needs a TRANSITION into done inside the window.
  // `updatedAt` cannot express that; the event log can (`state` is the full
  // entity after each write, so a column change is derivable) — but this is a
  // pure function over CARDS and has no events to read. Rather than infer a
  // transition from a timestamp that cannot carry one, it is named for what it
  // measures. Renaming is not a workaround here: `touched-and-done` is a true
  // number, and `finished` was a false one.
  const touchedAndDone = inWindow.filter(isDone).length;

  // ⭐ Built from the ROSTER, so a seat with zero claims still gets a row.
  const held = new Map(roster.map((s) => [s, []]));
  for (const c of cards) {
    if (!c.claimedBy) continue;
    const seat = String(c.claimedBy).replace(/^person:/, '');
    if (!held.has(seat)) held.set(seat, []);   // a holder off-roster is still real
    held.get(seat).push(c);
  }
  const wip = [...held.entries()]
    .map(([seat, cs]) => ({ seat, held: cs.length, cards: cs.map((c) => c.shortId) }))
    .sort((a, b) => b.held - a.held || String(a.seat).localeCompare(String(b.seat)));

  // A claim is a mutex, not a deed — and the holder is structurally the last to
  // notice they are still holding it, which is why this is reported rather than
  // left to whoever is holding.
  // #1027 condition 6 — A HELD CLAIM WAITING ON A HUMAN IS BLOCKED, NOT STALE.
  //
  // Found on production data 2026-08-24T04:00Z: two cards had been legitimately
  // held for hours while their holder waited on a human review, and this report
  // warned both as long-held claims. That is an accusation where the truth was
  // patience — and the holder had said so publicly, just not anywhere queryable.
  //
  // ⚠️ The discriminator is `status === 'open'`, NOT the presence of a blockers
  // array. A blocker answered days ago is an unexplained hold; treating any
  // non-empty array as "blocked" would silence such a card permanently.
  const heldTooLong = cards
    .filter((c) => c.claimedBy && c.claimedAt)
    .map((c) => {
      const open = (Array.isArray(c.blockers) ? c.blockers : [])
        .filter((b) => b && b.status === 'open');
      return {
        shortId: c.shortId,
        seat: String(c.claimedBy).replace(/^person:/, ''),
        hours: Math.round((now - Date.parse(c.claimedAt)) / HOUR),
        blockedOn: [...new Set(open.map((b) => b.person || b.owner).filter(Boolean))],
        isBlocked: open.length > 0,
      };
    })
    .filter((c) => c.hours >= staleClaimHours)
    .sort((a, b) => b.hours - a.hours);

  // A claim with a RECORDED open blocker is explained. It is reported so the
  // reader can go clear it, never as a warning about the holder.
  const blockedClaims = heldTooLong.filter((c) => c.isBlocked);

  // ⭐ And the rest ASK rather than ASSERT. This instrument cannot distinguish
  // neglect from a blocker nobody recorded, so it must not choose one: the
  // holder may be waiting with nowhere structured to say so, which is the
  // state that produced this condition in the first place.
  const staleClaims = heldTooLong.filter((c) => !c.isBlocked);

  const lines = [];
  for (const w of wip) {
    lines.push(w.held === 0
      // ⭐ Named explicitly rather than omitted. "Holding nothing" is the state
      // this whole instrument exists to make sayable.
      ? `  ${w.seat.padEnd(10)} holding nothing`
      : `  ${w.seat.padEnd(10)} ${w.held} card(s): ${w.cards.map((s) => '#' + s).join(' ')}`);
  }
  for (const b of blockedClaims) {
    lines.push(`  ⏸ #${b.shortId} held by ${b.seat} ${b.hours}h — BLOCKED on ${b.blockedOn.join(', ') || 'an unnamed party'} (recorded)`);
  }
  // ⚠️ The wording avoids the word "blocked" DELIBERATELY, and a test enforces
  // it. A consumer greps these lines to find what is blocked; a question that
  // contains the word would be collected as an answer. Same hazard as #606's
  // "up to date" inside its own UNKNOWN: a negation is invisible to a matcher.
  for (const s of staleClaims) {
    lines.push(`  ⚠️ #${s.shortId} claimed by ${s.seat} ${s.hours}h — NO RECORDED BLOCKER: `
      + `set aside, or waiting on something nobody wrote down?`);
  }

  // #726 — always stated, including when the numbers are fine. A line that
  // appears only on trouble is an alarm with extra steps, and zero-finished is
  // precisely the state that is indistinguishable from a quiet healthy day
  // unless it is printed.
  // #1027 — the three-state correction from review, adopted with its honest limit.
  // A card whose commits are not in production is a DIFFERENT fact from a card
  // nobody has started, and conflating them made last night's zero unreadable.
  //
  // ⛔ But "finished" is NOT derivable and this must not pretend otherwise. A
  // card can carry commits AND substantial remaining work — all four of last
  // night's did, and each says so only in PROSE. So this reports the fact it
  // can establish (commits not yet deployed) and refuses the one it cannot
  // (whether the work is done). Calling such a card "finished, awaiting
  // deploy" would be the overclaim this instrument exists to catch, committed
  // by the instrument.
  //
  // No deployment facts in ⇒ no deployment claims out: null, not an empty list.
  let hasUndeployedWork = null;
  if (deployedShas instanceof Set) {
    hasUndeployedWork = cards
      .filter((c) => !isDone(c) && Array.isArray(c.implementedBy) && c.implementedBy.length)
      .filter((c) => c.implementedBy.some((sha) => !deployedShas.has(sha)))
      .map((c) => ({ shortId: c.shortId, commits: c.implementedBy.length }));
  }

  const summary = `flow (last ${windowHours}h): ${touched} touched · ${touchedAndDone} touched-and-done`
    + (hasUndeployedWork ? ` · ${hasUndeployedWork.length} with undeployed commits` : '');

  // ⭐ The caveat travels WITH the number. A limit recorded only on a card is a
  // number that will be quoted without it — and this one reads as a completion
  // count to anybody who does not already know better.
  lines.push('  ⓘ touched-and-done counts cards in done that were EDITED in the window, '
    + 'including ones finished long ago — it is not a count of work FINISHING '
    + '(that needs a transition, which updatedAt cannot express)');

  if (hasUndeployedWork?.length) {
    lines.push(`  ⚠️ open cards carrying commits NOT in production: `
      + hasUndeployedWork.map((c) => '#' + c.shortId).join(' ')
      + '  (undeployed ≠ finished — the card body is the only thing that knows)');
  }

  return { ok: true, touched, touchedAndDone, wip, staleClaims, blockedClaims, hasUndeployedWork, lines, summary, windowHours };
}

// ── CLI ────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const base = arg('base', process.env.SCRUM_API_BASE || 'http://127.0.0.1:3141');
  const windowHours = Number(arg('window', 24));

  // ⚠️ Both fetches degrade to null, never to []. An unreachable board must
  // report UNKNOWN; reporting "0 touched, 0 finished, everyone idle" from a
  // failed request is the false all-clear this instrument exists to refuse.
  const get = async (path) => {
    try {
      const res = await fetch(`${base}${path}`);
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  };

  const cardsRaw = await get('/api/cards');
  const peopleRaw = await get('/api/people');
  const cards = Array.isArray(cardsRaw) ? cardsRaw : (cardsRaw?.cards ?? null);
  const roster = (Array.isArray(peopleRaw) ? peopleRaw : peopleRaw?.people ?? [])
    .map((p) => p.id || p.key || p.name).filter(Boolean);

  const r = flowReport({ cards, roster, now: Date.now(), windowHours });
  console.log(r.summary);
  for (const l of r.lines) console.log(l);
  if (!r.ok) console.log('  (roster and WIP unknown for the same reason)');
  process.exit(0);
}
