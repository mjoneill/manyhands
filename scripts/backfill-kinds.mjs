#!/usr/bin/env node
/**
 * #1214 — REGISTER THE DECLARED KINDS.
 *
 * The registry ships knowing its own vocabulary (core/kind-registry.mjs), so a
 * board answers "what kinds of thing live here" with an empty `kinds` table.
 * This walks that vocabulary into the graph so the definitions are queryable
 * as data — `?k a scrum:KindDefinition` — and not only readable as source.
 *
 * ⚠️ DRY RUN BY DEFAULT. Registering is a WRITE to a live board: it appends one
 * event per kind and revises any row already there. Pass --write to mean it.
 *
 *   node scripts/backfill-kinds.mjs                        # show what would change
 *   node scripts/backfill-kinds.mjs --write --by <seat>    # do it
 *   node scripts/backfill-kinds.mjs --base-url http://localhost:3141
 *
 * Re-runnable: a re-register REVISES one entity rather than minting a second
 * row, so running this twice is not a duplication. It is, however, a second
 * event with a new author, which is why `--by` is required for a write rather
 * than defaulted — the record should say who stood behind the definitions.
 */
import { KIND_DECLARATIONS } from '../core/kind-registry.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? true);
};

const BASE = flag('base-url', process.env.SCRUM_BOARD_URL || 'http://localhost:3141');
const WRITE = args.includes('--write');
const BY = flag('by');

const declared = KIND_DECLARATIONS.filter((k) => k.name);

if (WRITE && (!BY || BY === true)) {
  console.error('--write requires --by <seat>: the registry records who stands behind a '
    + 'definition, and "declared, not authenticated" is only honest if something is declared.');
  process.exit(2);
}

async function main() {
  // Read first. A backfill that does not know the current state cannot tell
  // "registered it" from "revised someone else's wording", and those are
  // different things to do to a shared board.
  let existing = [];
  try {
    const r = await fetch(`${BASE}/api/kinds`);
    if (!r.ok) throw new Error(`GET /api/kinds → ${r.status}`);
    existing = await r.json();
  } catch (e) {
    console.error(`Cannot read the registry at ${BASE}: ${e.message}`);
    console.error('If this is a 404, the board is running a build older than #1214 — deploy first.');
    process.exit(1);
  }
  const have = new Map(existing.map((k) => [k.name, k]));

  const toCreate = declared.filter((k) => !have.has(k.name));
  const toRevise = declared.filter((k) => have.has(k.name) && have.get(k.name).definition !== k.definition);
  const unchanged = declared.length - toCreate.length - toRevise.length;

  console.log(`registry at ${BASE}`);
  console.log(`  declared in this build : ${declared.length}`);
  console.log(`  already registered     : ${have.size}`);
  console.log(`  would create           : ${toCreate.length}`);
  console.log(`  would revise wording   : ${toRevise.length}`);
  console.log(`  identical, untouched   : ${unchanged}`);

  // Rows on the board this build has never heard of. NOT an error and not this
  // script's business to remove: someone declared a kind the runtime does not
  // implement, which is a real state (#1215 announces it), and deleting it here
  // would destroy a definition somebody wrote.
  const foreign = existing.filter((k) => !declared.some((d) => d.name === k.name));
  if (foreign.length) {
    console.log(`  registered but NOT in this build (left alone): ${foreign.map((k) => k.name).join(', ')}`);
  }

  if (!WRITE) {
    for (const k of [...toCreate, ...toRevise]) console.log(`    ${have.has(k.name) ? 'revise' : 'create'}  ${k.name}`);
    console.log('\ndry run — nothing was written. Pass --write --by <seat> to apply.');
    return;
  }

  let created = 0; let revised = 0; const failed = [];
  for (const k of [...toCreate, ...toRevise]) {
    const r = await fetch(`${BASE}/api/kinds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: k.name, definition: k.definition, createdBy: k.createdBy,
        eventKind: k.eventKind ?? undefined, by: BY,
      }),
    });
    if (r.status === 201) created++;
    else if (r.status === 200) revised++;
    else failed.push(`${k.name} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  }

  // Read back. A 2xx is a response, not a write.
  const after = await (await fetch(`${BASE}/api/kinds`)).json();
  console.log(`\ncreated ${created} · revised ${revised} · failed ${failed.length}`);
  for (const f of failed) console.log(`  FAILED ${f}`);
  console.log(`read back from the board: ${after.length} registered`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
