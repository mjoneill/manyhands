#!/usr/bin/env node
/**
 * #1008 — THE STAMPER. Run by the deploy, where a clone exists: resolve every
 * sha the board references against every known root, and write the result as
 * a dated stamp the live endpoint reports (SCRUM_SHA_INTEGRITY_FILE).
 *
 *   node tools/stamp-sha-integrity.mjs --roots /clone:/ops --out /path/stamp.json
 *        [--api http://127.0.0.1:3141] [--deployed <40-char sha>]
 *
 * ⛔ NO PATH IS BAKED IN — this file is published; the operator names the roots.
 * The board is read over the API (the file lives in the private tree). Exit 0
 * whenever a stamp was written, even an unmeasurable one: the deploy must not
 * refuse on this, and an honest "could not look" stamp is better than none.
 */
import fs from 'node:fs';
import { verifyShaIntegrityAcrossRoots, gitRootResolver } from '../core/sha-integrity.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : d; };
const API = arg('--api', 'http://127.0.0.1:3141');
const OUT = arg('--out', null);
const ROOTS = (arg('--roots', '') || '').split(':').filter(Boolean);
const DEPLOYED = arg('--deployed', null);
if (!OUT) { console.error('stamp-sha-integrity: --out <file> is required'); process.exit(2); }

async function allCards() {
  const cards = [];
  let before = null;
  for (;;) {
    const u = new URL('/api/cards', API);
    u.searchParams.set('limit', '500'); u.searchParams.set('fields', 'all');
    if (before != null) u.searchParams.set('before', String(before));
    const r = await fetch(u);
    if (!r.ok) throw new Error(`GET ${u} → ${r.status}`);
    const page = await r.json();
    const rows = page.cards || [];
    cards.push(...rows);
    if (rows.length === 0 || (page.cardsTotal != null && cards.length >= page.cardsTotal)) break;
    before = rows[rows.length - 1].shortId;
  }
  return cards;
}

const cards = await allCards();
const result = await verifyShaIntegrityAcrossRoots({ cards }, { roots: ROOTS.map(gitRootResolver) });
const stamp = { resolvedAt: new Date().toISOString(), deployedSha: DEPLOYED, ...result };
fs.writeFileSync(OUT, JSON.stringify(stamp, null, 2) + '\n');
const rootsLine = (stamp.roots || []).map((r) => `${r.root} ${r.status}${r.status === 'read' ? ` ${r.resolved}` : ` (${r.error})`}`).join(' · ');
console.log(`sha-integrity ${stamp.status} · ${stamp.population} · enumerated ${stamp.enumerated}` + (stamp.checked != null ? ` · checked ${stamp.checked}` : '') + ` · ${rootsLine}`);
for (const u of stamp.unresolved || []) console.log(`   ⛔ unresolved in every readable root: ${u.sha} on #${u.cards.join(', #')}`);
if (stamp.status !== 'measured') console.log(`   ⚠️ ${stamp.missingInput}`);
console.log(`   stamp → ${OUT}`);
