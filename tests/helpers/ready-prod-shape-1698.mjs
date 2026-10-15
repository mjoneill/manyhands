/**
 * #1698 test helper: a reproducible PRODUCTION-SHAPED board for the readiness read, and a world that can carry a shipped-sha stamp.
 *
 * Why it exists: the #1644 L1 fixture (1,500 cards, one relatedTo edge on all but the first, a blockedBy edge on one in ten) makes the readiness
 * UNION return 3,149 rows. Measured on a copy of the production graph (backup graph-store-20261015T134449Z, read-only, 2026-10-15): 1,620 nodes of
 * type CreativeWork, 6,390 context rows (relatedTo 6,127, derivedFrom 213, supersedes 25, supersededBy 25; one row per edge, no join multiplication),
 * 1,181 cards with at least one context edge, a median of 4 and a maximum of 56 edges on one card. The two shapes are not the same workload, so a
 * candidate query shape is checked on both (the L1 fixture stays for continuity).
 *
 * The generator is seeded and pure: the same seed gives the same board, byte for byte, so a row that fails can be reproduced.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  READY_ENV, DSID, ROSTER_FILE, card, startProxy, migrate, withOwned, startExecutor, killExecutor, startRestServer, makeBoardFixture,
} from './ready-world-1644.mjs';

/** What was measured on the production copy. Documented, never read by the code that builds a board; the self-check row compares the board to it. */
export const PROD_MEASURED = Object.freeze({
  cards: 1620, relatedToRows: 6127, derivedFromRows: 213, supersedesRows: 25, supersededByRows: 25, cardsWithContext: 1181, maxDegree: 56,
  blockersRows: 47, humanBlockerRows: 101, implementedByRows: 610, doneCards: 496, doneContextRows: 2642,
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * @returns {{ board: object, declared: object, shas: string[] }} `declared` is what the generator PUT in the board (counted from the board it built,
 * not typed in), so a row that compares an executor answer to it is comparing to the board, not to a constant.
 */
export function prodShapeBoard({ seed = 1698, cards: N = 1600 } = {}) {
  const rnd = mulberry32(seed);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  // Production: 496 of 1,620 cards are done (31%) and they carry 2,642 of the 6,390 context rows (41%): older cards are done more often and are also the busiest. Done is 55% likely among the
  // first 500 cards and 20% after that, which lands near both figures.
  const OPEN = ['backlog', 'backlog', 'backlog', 'backlog', 'backlog', 'backlog', 'planned', 'planned', 'planned', 'in-progress'];
  const columnFor = (i) => (rnd() < (i <= 500 ? 0.55 : 0.2) ? 'done' : pick(OPEN));
  const cs = Array.from({ length: N }, (_, k) => {
    const i = k + 1;
    return card(i, `shape-${i}`, {
      priority: pick(['p0', 'p1', 'p2', 'p2', 'p3']), column: columnFor(i),
      relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [] },
    });
  });
  const by = (n) => cs[n - 1];
  const add = (n, type, m) => { const l = by(n).relationships[type]; if (!l.includes(m)) l.push(m); };

  // relatedTo: undirected pairs, stored on BOTH cards (a directed row each), with a heavy tail capped at the measured maximum degree. Endpoints are drawn from the first 1,181 cards.
  const CONNECTED = Math.min(1181, N);
  const w = Array.from({ length: CONNECTED }, (_, k) => Math.pow(k + 1, -0.55));
  const cdf = []; let tot = 0; for (const x of w) { tot += x; cdf.push(tot); }
  const draw = () => { const r = rnd() * tot; let lo = 0, hi = cdf.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < r) lo = mid + 1; else hi = mid; } return lo + 1; };
  const PAIRS = Math.round(6126 / 2 * (N / 1600));
  let made = 0, guard = 0;
  while (made < PAIRS && guard++ < PAIRS * 400) {
    const a = draw(), b = draw();
    if (a === b || by(a).relationships.relatedTo.includes(b)) continue;
    if (by(a).relationships.relatedTo.length >= PROD_MEASURED.maxDegree || by(b).relationships.relatedTo.length >= PROD_MEASURED.maxDegree) continue;
    add(a, 'relatedTo', b); add(b, 'relatedTo', a); made++;
  }
  // derivedFrom: a later card derives from an earlier one
  for (let c = 0; c < 213;) { const a = 2 + Math.floor(rnd() * (N - 1)), b = 1 + Math.floor(rnd() * (a - 1)); if (!by(a).relationships.derivedFrom.includes(b)) { add(a, 'derivedFrom', b); c++; } }
  // supersession: 25 pairs, stored on both cards like the board does
  for (let c = 0, used = new Set(); c < 25;) { const a = 2 + Math.floor(rnd() * (N - 1)), b = 1 + Math.floor(rnd() * (a - 1)); if (used.has(a) || used.has(b)) continue; used.add(a); used.add(b); add(a, 'supersedes', b); add(b, 'supersededBy', a); c++; }
  // 47 card-to-card blockedBy edges, then 101 human blockers
  for (let c = 0; c < 47;) { const a = 2 + Math.floor(rnd() * (N - 1)), b = 1 + Math.floor(rnd() * (a - 1)); if (!by(a).relationships.blockedBy.includes(b)) { add(a, 'blockedBy', b); c++; } }
  for (let c = 0, seen = new Set(); c < 101;) { const a = 1 + Math.floor(rnd() * N); if (seen.has(a)) continue; seen.add(a); by(a).blockers = [c % 3 === 0 ? { anyHuman: true, status: 'open', note: 'shape' } : { person: 'ada', status: 'open', note: 'shape' }]; c++; }
  // a few claimed and parked cards, so those verdicts exist at this size
  for (let c = 0; c < 40; c++) { const a = 1 + Math.floor(rnd() * N); by(a).claimedBy = 'ada'; by(a).claimedAt = '2026-08-02T00:00:00.000Z'; }
  for (let c = 0; c < 30; c++) { const a = 1 + Math.floor(rnd() * N); Object.assign(by(a), { parkedBy: 'ada', parkedAt: '2026-08-03T00:00:00.000Z', parkedUntil: '2099-01-01T00:00:00.000Z', parkedReason: 'shape' }); }
  // 610 commit links over about 400 cards, as 40-hex shas
  const shas = [];
  for (let c = 0; c < 610; c++) { const sha = Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join(''); shas.push(sha); const a = 1 + Math.floor(rnd() * Math.min(N, 400)); (by(a).implementedBy ??= []).push(sha); }

  const board = makeBoardFixture({ cards: cs, nextShortId: N + 1, conversations: [] });
  const count = (type) => cs.reduce((n, c) => n + c.relationships[type].length, 0);
  const declared = {
    cards: N, relatedToRows: count('relatedTo'), derivedFromRows: count('derivedFrom'), supersedesRows: count('supersedes'), supersededByRows: count('supersededBy'),
    contextRows: count('relatedTo') + count('derivedFrom') + count('supersedes') + count('supersededBy'),
    doneCards: cs.filter((c) => c.column === 'done').length,
    contextRowsOpen: cs.filter((c) => c.column !== 'done').reduce((n, c) => n + ['relatedTo', 'derivedFrom', 'supersedes', 'supersededBy'].reduce((m, t) => m + c.relationships[t].length, 0), 0),
    blockedByEdges: count('blockedBy'), humanBlockerCards: cs.filter((c) => c.blockers?.length).length,
    implementedByRows: cs.reduce((n, c) => n + (c.implementedBy?.length ?? 0), 0),
    cardsWithContext: cs.filter((c) => ['relatedTo', 'derivedFrom', 'supersedes', 'supersededBy'].some((t) => c.relationships[t].length)).length,
    maxDegree: Math.max(...cs.map((c) => c.relationships.relatedTo.length)),
  };
  return { board, declared, shas, cardsList: cs };
}

/** A shipped-sha stamp file (the `inDeployed` map REST reads from SCRUM_SHA_INTEGRITY_FILE): half of the shas are "deployed". */
export function writeStamp(dir, shas) {
  const file = path.join(dir, 'sha-integrity.json');
  fs.writeFileSync(file, JSON.stringify({ inDeployed: Object.fromEntries(shas.filter((_, i) => i % 2 === 0).map((s) => [s, true])) }));
  return file;
}

/** Runs `body(env)` with REST env that names a stamp file (or no env at all), in a directory this call makes and removes. */
export async function withStampEnv(stamped, shas, body) {
  return withOwned(async (own) => body(stamped ? { SCRUM_SHA_INTEGRITY_FILE: writeStamp(own.dir('r98-stamp-'), shas) } : {}));
}

/** Like the #1644 helper's `world`, with extra REST env (so a stamp can be on or off) and the proxy's answer-rewrite hook exposed for counting rows by kind. */
export async function worldWithEnv(board, extraEnv, body) {
  return withOwned(async (own) => {
    const store = own.dir('r98-store-');
    const exec = await startExecutor({ store, datasetId: DSID, create: true }); own.adopt(() => killExecutor(exec));
    const proxy = await startProxy(exec.baseUrl); own.adopt(async () => { try { await proxy.down(); } catch { /* down */ } });
    const dir = own.dir('r98-board-'); const boardFile = path.join(dir, 'board.json');
    fs.writeFileSync(boardFile, JSON.stringify(board));
    let rest = null; own.adopt(async () => { if (rest) await rest.stop(); });
    const w = {
      exec, proxy, boardFile, dir,
      async start({ ready = false } = {}) {
        if (rest) await rest.stop();
        rest = await startRestServer({ boardFile, env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1', ...extraEnv, ...(ready ? { [READY_ENV]: 'executor' } : {}) } });
        w.base = rest.baseUrl; w.rest = rest; return w;
      },
      async get(route) { const r = await fetch(`${w.base}${route}`, { signal: AbortSignal.timeout(120000) }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, text, json }; },
      async patch(id, b) { const r = await fetch(`${w.base}/api/cards/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by: 'ada', ...b }), signal: AbortSignal.timeout(120000) }); return { status: r.status, text: await r.text() }; },
    };
    const m = await migrate(boardFile, exec.baseUrl);
    if (m.code !== 0) throw new Error(`precondition: the cards are copied into the executor (exit ${m.code}): ${m.out.slice(0, 300)}`);
    return await body(w);
  });
}
