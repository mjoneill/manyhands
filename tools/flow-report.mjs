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
/**
 * #1027 — FINISHED, derived from TRANSITIONS rather than from a snapshot.
 *
 * `touchedAndDone` (below) counts a card that was ALREADY done and merely
 * edited — the PO grooming completed cards makes it rise. This counts a card
 * ENTERING done inside the window, from the change rows /api/changes serves
 * (history:true, with the #1027 `column` field). Per card, in seq order:
 *   non-done → done inside the window          ⇒ finished (once per card)
 *   created straight into done inside window    ⇒ finished
 *   first row in window is already done, not a create ⇒ AMBIGUOUS: the
 *     transition may have happened before the window; counted separately,
 *     never folded into finished. Absence must stay visible, not zero.
 * Rows without a column (an older server, posts) cannot be judged and are
 * skipped; a run over such rows reports finished: null.
 */
export function finishedFromChanges(changes) {
  if (!Array.isArray(changes)) return null;
  const rows = changes.filter((r) => r && r.kind === 'card' && typeof r.seq === 'number');
  if (rows.length && rows.every((r) => r.column === undefined)) return null;   // pre-#1027 server: no column field at all
  const byCard = new Map();
  for (const r of rows) {
    const id = r.id ?? r.shortId;
    if (!byCard.has(id)) byCard.set(id, []);
    byCard.get(id).push(r);
  }
  const isDone = (col) => String(col || '').endsWith('done');
  const finished = [], ambiguous = [];
  for (const [, evs] of byCard) {
    evs.sort((a, b) => a.seq - b.seq);
    let prev = null, counted = false;
    for (const r of evs) {
      if (r.column == null) continue;
      const done = isDone(r.column);
      if (done && !counted) {
        if (prev === null) {
          if (r.op === 'create') { finished.push(r.shortId); counted = true; }
          else { ambiguous.push(r.shortId); counted = true; }
        } else if (!prev) { finished.push(r.shortId); counted = true; }
      }
      prev = done;
    }
  }
  return { finished: finished.length, finishedShortIds: finished, ambiguous: ambiguous.length, ambiguousShortIds: ambiguous };
}

/**
 * #1027 — the deployed-sha set, from the #1008/#1020 stamp the board serves at
 * /api/checks (shaIntegrity.inDeployed: shas that are ANCESTORS of the deployed
 * sha, not merely resolvable). null when the stamp or the field is absent —
 * an older server, or no deploy yet — so the report says UNKNOWN, never 0.
 */
export function deployedShasFromChecks(checks) {
  const list = checks?.shaIntegrity?.inDeployed;
  if (!Array.isArray(list)) return null;
  return new Set(list.map((e) => (typeof e === 'string' ? e : e?.sha)).filter(Boolean));
}

export function flowReport({ cards, roster = [], now = Date.now(), windowHours = 24, staleClaimHours = 6, deployedShas = null, finished = null } = {}) {
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

  // #1027 — the transition count, when the caller could derive one. Stated
  // beside touched-and-done so the two numbers are never confused, and UNKNOWN
  // (not 0) when the change rows were unavailable.
  if (finished && typeof finished.finished === 'number') {
    lines.push(`  finished (entered done in window): ${finished.finished}`
      + (finished.finishedShortIds?.length ? ` — ${finished.finishedShortIds.map((s) => '#' + s).join(' ')}` : '')
      + (finished.ambiguous ? ` · +${finished.ambiguous} already done at first sight (${finished.ambiguousShortIds.map((s) => '#' + s).join(' ')}) — prior state outside the window, NOT counted` : ''));
  } else {
    lines.push('  finished (entered done in window): UNKNOWN — change rows unavailable or carry no column');
  }
  return { ok: true, touched, touchedAndDone, wip, staleClaims, blockedClaims, hasUndeployedWork, finished, lines, summary, windowHours };
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

  // #1027 — the two inputs the report used to lack on every real run: the
  // change rows (for a transition-based finished count) and the deployed-sha
  // set (from the stamp). Both degrade to null ⇒ UNKNOWN, never to 0.
  const sinceIso = new Date(Date.now() - windowHours * 3600_000).toISOString();
  const changesRaw = await get(`/api/changes?since=${encodeURIComponent(sinceIso)}&history=true&limitCards=500&limitPosts=1`);
  const finished = finishedFromChanges(Array.isArray(changesRaw?.changes) ? changesRaw.changes : null);
  const deployedShas = deployedShasFromChecks(await get('/api/checks'));

  const r = flowReport({ cards, roster, now: Date.now(), windowHours, deployedShas, finished });
  // #1042 — SAY WHICH SOURCE THIS MEASURED. Three correct tools were wrongly
  // accused in one night because their output named counts and files and never
  // named what they had read. A number without its source cannot be checked by
  // anyone except the person who ran it, and they are the one least likely to.
  //
  // ⚠️ Deliberately NOT extended to #1042's condition 2 (absence must refuse).
  // That condition exists for TREE ambiguity — this room has four trees and a
  // default is a guess about which. An API base is not that: there is one board,
  // localhost is not a guess about it, and refusing without SCRUM_API_BASE would
  // add friction to a read-only tool for a hazard it does not have.
  console.log(`source: ${base}`);
  console.log(r.summary);
  for (const l of r.lines) console.log(l);
  if (!r.ok) console.log('  (roster and WIP unknown for the same reason)');
  process.exit(0);
}
