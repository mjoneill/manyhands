/**
 * #1290 — SHADOW INSIGHTS. Recommend, chart, change nothing.
 *
 * The wake tick is a flat 60s for every seat, and a tick landing during a live
 * turn is a no-op because the runner holds a lock. Measured 2026-09-07 over
 * 341 ledger rows: one seat's median turn is 100s, another's 39s, a third's 28s.
 * So the timer is mistuned per seat, in OPPOSITE DIRECTIONS, and the ledger
 * had known for two days because nothing read it back.
 *
 * ⛔ EVERY FUNCTION HERE IS READ-ONLY AND ADVISORY. Nothing in this module
 * changes an interval, writes a config, or affects a wake. The dashboard shows
 * what a model WOULD recommend; a human decides whether it ever acts.
 *
 * ⛔ AND THE THREE RULES THAT KEEP IT HONEST, each learned the hard way today:
 *   1. too few rows        ⇒ NO recommendation. A confident number from n=3
 *                            is the failure this file exists to avoid.
 *   2. a model change      ⇒ the window RESETS. An average across a provider
 *                            swap is an average of two different worlds, and
 *                            the ledger stamps the model so this is TOLD,
 *                            never learned.
 *   3. a missing datum     ⇒ reported MISSING. Today produced three separate
 *                            instruments whose silence read as health.
 */

/** The deployed launchd StartInterval. Pinned by a test so a drift is loud. */
export const TICK_MS = 60_000;
/** Below this, no recommendation is emitted at all. */
export const MIN_ROWS_FOR_RECOMMENDATION = 12;
/** Bounds on anything we would ever suggest, so a wild sample cannot propose absurdity. */
export const MIN_INTERVAL_MS = 15_000;
export const MAX_INTERVAL_MS = 15 * 60_000;
/** A turn is "covered" by a tick if the tick period exceeds it; the slack multiplier. */
const HEADROOM = 1.1;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const at = (r) => Date.parse(r?.calledAt ?? '') || 0;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

/**
 * Split a seat's rows into contiguous runs of the same model/provider.
 * ⭐ This is the regime detector, and it is DECLARATIVE: the ledger records
 * which model produced each call, so a swap is a fact in the data rather than
 * a change-point we have to infer from the numbers.
 */
export function regimeSegments(rows = []) {
  const sorted = [...(rows || [])].filter(Boolean).sort((a, b) => at(a) - at(b));
  const segs = [];
  for (const r of sorted) {
    const key = `${r.model ?? '?'}|${r.provider ?? '?'}`;
    const last = segs.at(-1);
    if (last && last.key === key) { last.rows.push(r); last.to = r.calledAt; continue; }
    segs.push({ key, model: r.model ?? null, provider: r.provider ?? null, from: r.calledAt, to: r.calledAt, rows: [r] });
  }
  return segs;
}

/**
 * One seat's current picture. ⚠️ Deliberately describes the CURRENT REGIME
 * only — the blended median across a model swap is the number that misleads.
 */
export function summariseSeat(rows = []) {
  const all = [...(rows || [])].filter(Boolean);
  const segs = regimeSegments(all);
  const current = segs.at(-1);
  const scope = current ? current.rows : [];

  const lat = scope.map((r) => num(r.latencyMs)).filter((v) => v !== null);
  const missing = scope.length - lat.length;

  return {
    agent: scope[0]?.agent ?? all[0]?.agent ?? null,
    model: current?.model ?? null,
    provider: current?.provider ?? null,
    // ⛔ `n` is the MEASURED population, `rowsSeen` is what we looked at. A
    // dashboard that reports only one of these hides its own gaps.
    n: lat.length,
    rowsSeen: scope.length,
    missingLatency: missing,
    regimeChanged: segs.length > 1,
    regimes: segs.length,
    medianLatencyMs: median(lat),
    p90LatencyMs: percentile(lat, 0.9),
    // A tick every TICK_MS lands on a held lock whenever a turn is longer than
    // the gap. Fraction of a turn's duration that overlaps the next tick.
    wastedTickFraction: lat.length
      ? lat.filter((v) => v > TICK_MS).length / lat.length
      : null,
  };
}

/**
 * What interval would we suggest, and why? ⛔ ADVISORY ONLY.
 *
 * The rule is deliberately dull: poll a little slower than the seat's own p90
 * turn, so a tick rarely lands on a held lock, and never outside sane bounds.
 * A dull rule that states its reasoning beats a clever one that cannot.
 */
export function recommendInterval(summary) {
  const s = summary || {};
  if (!s.n || s.medianLatencyMs === null) {
    return {
      recommended: false,
      intervalMs: null,
      why: s.missingLatency
        ? `no latency recorded on ${s.missingLatency} row(s) — the measurement is missing, so no interval is proposed`
        : 'no measured rows',
    };
  }
  if (s.n < MIN_ROWS_FOR_RECOMMENDATION) {
    return {
      recommended: false,
      intervalMs: null,
      why: `too few rows in the current regime (n=${s.n}, need ${MIN_ROWS_FOR_RECOMMENDATION}) — a confident interval from a thin sample is worse than none`,
    };
  }
  const basis = s.p90LatencyMs ?? s.medianLatencyMs;
  const raw = Math.round(basis * HEADROOM);
  const intervalMs = Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, raw));
  const slower = intervalMs > TICK_MS;
  return {
    recommended: true,
    intervalMs,
    basisMs: basis,
    why: slower
      ? `turns are slow (median ${Math.round(s.medianLatencyMs / 1000)}s, p90 ${Math.round(basis / 1000)}s) — a ${TICK_MS / 1000}s tick lands on a held lock ${Math.round((s.wastedTickFraction ?? 0) * 100)}% of the time; poll less often`
      : `turns are fast (median ${Math.round(s.medianLatencyMs / 1000)}s) — the seat is idle between ticks and could be reached sooner`,
    // ⚠️ Stated so the dashboard never implies more than a shadow run can know.
    caveat: 'advisory only — nothing is applied, and this predicts TURN DURATION, which the lock already observes exactly. The unknown quantity is ARRIVAL.',
  };
}

/**
 * Mentions received vs answered, and the age of what is owed.
 * ⛔ `staleAfterMinutes` REPORTS what an expiry policy would drop. It applies
 * nothing — `expiryApplied` is always false, and a test pins that.
 */
export function backlogFor({ mentions = [], answered = 0, now = Date.now(), staleAfterMinutes = null } = {}) {
  const times = (mentions || [])
    .map((m) => Date.parse(m?.createdAt ?? '') || null)
    .filter((v) => v !== null)
    .sort((a, b) => a - b);
  const received = times.length;
  const done = Math.max(0, Math.min(received, Number(answered) || 0));
  // #1274: the loop drains OLDEST FIRST, so what remains is the newest tail.
  const owedTimes = times.slice(done);
  const ages = owedTimes.map((t) => Math.round((now - t) / 60_000));
  const out = {
    received,
    answered: done,
    owed: owedTimes.length,
    owedAgesMinutes: ages,
    oldestOwedMinutes: ages.length ? Math.max(...ages) : null,
    expiryApplied: false,
  };
  if (typeof staleAfterMinutes === 'number') {
    out.staleAfterMinutes = staleAfterMinutes;
    out.wouldExpire = ages.filter((a) => a > staleAfterMinutes).length;
    out.wouldRemain = out.owed - out.wouldExpire;
  }
  return out;
}

/**
 * #1290 — COST COVERAGE, added after a ground-truth check refuted the ledger.
 *
 * ⛔ THE FINDING: on 2026-09-07 the ledger reported $0.0007 across 347 rows
 * while OpenRouter's own dashboard showed $2.05 over 429 requests and 5.82M
 * tokens — spend under-reported ~3,010x, tokens ~200x. 344 of 347 rows carry
 * cost = 0, because the row is priced from `costIn`/`costOut` on the model
 * spec and those are unset for most seats.
 *
 * ⇒ So a naive sum renders an UNPRICED ledger as a FREE one, on the single
 * number the operator is actually paying. This function refuses that: rows
 * that were never priced are reported as unpriced, never as zero.
 */
/**
 * ⭐ A LOCAL model is genuinely free. A HOSTED one that reports 0 has had its
 * usage dropped. A cost of 0 for a genuinely free local model and a cost of 0
 * because usage was dropped were indistinguishable, which is what hid this
 * across 145 calls.
 * ⇒ The provider is on every row, so the two need not be conflated.
 */
const LOCAL_PROVIDER = /localhost|127\.0\.0\.1|ollama|mlx|local/i;
export const isLocalRow = (r) => LOCAL_PROVIDER.test(`${r?.provider ?? ''} ${r?.model ?? ''}`);

export function costCoverage(rows = []) {
  const rs = (rows || []).filter(Boolean);
  const local = rs.filter(isLocalRow);
  const hosted = rs.filter((r) => !isLocalRow(r));
  const hostedUnpriced = hosted.filter((r) => !((Number(r.cost) || 0) > 0));
  const priced = rs.filter((r) => (Number(r.cost) || 0) > 0);
  const withTokens = rs.filter((r) => (Number(r.tokensIn) || 0) + (Number(r.tokensOut) || 0) > 0);
  const sum = priced.reduce((n, r) => n + (Number(r.cost) || 0), 0);
  return {
    rows: rs.length,
    pricedRows: priced.length,
    unpricedRows: rs.length - priced.length,
    // ⛔ null, never 0, when nothing was priced — "we did not measure" is not "it was free".
    // null only when something billable went unmeasured; a purely local seat is a true 0.
    spent: priced.length ? Math.round(sum * 10000) / 10000 : (hosted.length ? null : 0),
    tokensIn: rs.reduce((n, r) => n + (Number(r.tokensIn) || 0), 0),
    tokensOut: rs.reduce((n, r) => n + (Number(r.tokensOut) || 0), 0),
    rowsWithNoTokens: rs.length - withTokens.length,
    localRows: local.length,
    hostedRows: hosted.length,
    hostedUnpricedRows: hostedUnpriced.length,
    // ⛔ Trustworthy means every row that COULD cost money was priced. A local
    // row costing nothing is a fact, not a gap.
    trustworthy: rs.length > 0 && hostedUnpriced.length === 0,
    note: rs.length === 0 ? 'no rows'
      : hosted.length === 0 ? `FREE — all ${rs.length} row(s) ran on a local model; $0 here is a fact, not a missing measurement`
      : hostedUnpriced.length === hosted.length ? `UNMEASURED — ${hosted.length} hosted row(s) carry no cost. The provider billed for these; the ledger did not record it. This is not $0.`
      : hostedUnpriced.length ? `PARTIAL — ${hostedUnpriced.length} of ${hosted.length} hosted rows unpriced; the total is a floor, not a spend`
      : 'all billable rows priced',
  };
}

/**
 * #1290 — IS THE BUDGET GATE ACTUALLY ARMED?
 *
 * ⛔⛔ THE LIVE CASE, 2026-09-07: a seat has `budgetPerDay: 2`, the
 * halt is correctly implemented, and it CANNOT FIRE — because it compares
 * against a ledger that records 0 on all 145 of her rows. OpenRouter's own
 * dashboard says $2.05. `0 >= 2` is never true.
 *
 * ⇒ A correct rail wired to a meter that reads zero is not a partial control.
 * It is NO control, and it looks identical to a working one from outside.
 * So the dashboard states the gate's status rather than showing a number
 * beside a cap and letting a reader assume the comparison happens.
 */
export function budgetGateStatus({ budgetPerDay = null, coverage = null } = {}) {
  const c = coverage || {};
  if (budgetPerDay == null) {
    return { status: 'NO_BUDGET', armed: false, why: 'no budgetPerDay set — nothing to enforce' };
  }
  if (!c.rows) {
    return { status: 'NO_DATA', armed: false, why: 'no calls in this window, so the gate is untested' };
  }
  if (c.spent === null) {
    return {
      status: 'INERT', armed: false,
      why: `budget $${budgetPerDay} exists and the meter reads nothing — all ${c.rows} row(s) are unpriced, so the halt compares 0 against ${budgetPerDay} and can never trigger`,
    };
  }
  if (!c.trustworthy) {
    return {
      status: 'PARTIAL', armed: false,
      why: `budget $${budgetPerDay}, but only ${c.pricedRows} of ${c.rows} rows are priced — the gate would fire late, on a number known to be low`,
    };
  }
  return {
    status: 'ARMED', armed: true,
    why: `budget $${budgetPerDay}, spend $${c.spent} measured across all ${c.rows} rows`,
  };
}
