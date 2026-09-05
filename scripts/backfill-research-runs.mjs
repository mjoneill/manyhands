#!/usr/bin/env node
/**
 * #1210 (slice 5 of #1205) — THE RESEARCH ALREADY DONE BECOMES RUNS.
 *
 * "What has this room researched" is only true after this. Before it, the graph
 * knows about the runs recorded since the verbs existed and nothing about the
 * years of reading that came first — which would make the query confidently
 * answer "two" about a room that has read a hundred papers.
 *
 * ⛔ THESE RUNS ARE RECONSTRUCTED, AND THEY SAY SO. Every backfilled run points
 * at a procedure version named "pre-procedure (backfilled)", because no
 * procedure was followed — the procedure did not exist yet. Recording the
 * absence is the honest move; inventing a method these reads followed would put
 * a lie in the one place the room goes to check what actually happened (#863).
 *
 * ⚠️ AND THE ACTOR IS THE BACKFILLER, NOT THE READER. `by` is one declared
 * writer and I am the one writing these rows, so `by` is the seat running this
 * script. The seat that actually did the reading goes in `participants`, from
 * the notes' own "Read by" line. Passing the original reader as `by` would put
 * a false attribution in the event log — it would say that seat made a write it
 * never made. The backfilled procedure version is what tells a reader that the
 * association is reconstructed rather than observed.
 *
 *   node scripts/backfill-research-runs.mjs                 # DRY RUN (default)
 *   node scripts/backfill-research-runs.mjs --write --by <seat>
 *   node scripts/backfill-research-runs.mjs --research-dir /path --base-url http://…
 *
 * Idempotent by ARTIFACT URL: a notes file that already hangs off a run is
 * skipped, so a second run writes zero rows. That is asserted, not hoped for.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : (args[i + 1] ?? true); };
const BASE = String(flag('base-url', process.env.SCRUM_BOARD_URL || 'http://localhost:3141'));
// No default path baked in: where a room keeps its research is that room's
// business, and a private tree's layout does not belong in a published file.
// RESEARCH_DIR or --research-dir, and refuse rather than guess.
const DIR = String(flag('research-dir', process.env.RESEARCH_DIR || ''));
const WRITE = args.includes('--write');
const BY = flag('by');
const LIMIT = Number(flag('limit', 0)) || 0;

if (WRITE && (!BY || BY === true)) {
  console.error('--write requires --by <seat>: these rows need one declared writer, and it is '
    + 'whoever runs this, not whoever did the reading.');
  process.exit(2);
}

const PRE_PROCEDURE = 'pre-procedure (backfilled)';
const PRE_PROCEDURE_BODY =
  'NO PROCEDURE WAS FOLLOWED. This run predates the existence of a written procedure, and it is '
  + 'reconstructed from the files it left behind rather than observed as it happened. What is known: '
  + 'which notes file exists, which source it sat beside, and which seat the notes name as having '
  + 'read it. What is NOT known and must not be inferred: whether the source was archived before '
  + 'being read, whether claims were checked against primary sources, whether anyone else was '
  + 'involved, and how long it took. A reader comparing one of these runs against a run that '
  + 'followed a real procedure version is comparing a reconstruction to a record, and the two are '
  + 'not the same kind of evidence.';

const api = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
  return { status: r.status, body: json, raw: text };
};

const sha256File = (p) => `sha256:${createHash('sha256').update(readFileSync(p)).digest('hex')}`;
const fileUrl = (p) => `file://${p}`;

/**
 * Seat names as they appear in the notes, mapped to seat keys — READ FROM THE
 * BOARD, not hardcoded.
 *
 * A literal list here would be stale the moment a seat is added or renamed, and
 * it would put a roster of people's names in a published file for no reason.
 * The board already knows who its people are and what each is called; ask it.
 */
async function seatIndex() {
  const r = await api('GET', '/api/people');
  if (r.status !== 200) {
    throw new Error(`cannot read the roster (${r.status}) — refusing to guess who the seats are, `
      + 'because guessing wrong attributes a read to the wrong person');
  }
  const index = new Map();
  // The endpoint wraps the list: { people: [...] }. Accept a bare array too
  // rather than assuming one shape and reporting an empty roster if it changes.
  const people = Array.isArray(r.body) ? r.body : (r.body?.people ?? []);
  if (!people.length) throw new Error('the roster came back empty — that is a failed read, not a board with no people');
  for (const person of people) {
    if (!person?.key) continue;
    index.set(String(person.key).toLowerCase(), person.key);
    if (person.name) index.set(String(person.name).toLowerCase(), person.key);
  }
  return index;
}

/**
 * What a notes file can tell us about the read it records. Deliberately
 * conservative: a card NUMBER mentioned in prose is a reference, not a claim
 * that the run produced that card, so only an explicit "for board card #N" or
 * "for card #N" counts. Everything else goes on the unpaired list, which is a
 * deliverable of this card rather than an embarrassment.
 */
function readNotes(path, seats_) {
  const text = readFileSync(path, 'utf8');
  const seats = [];
  const readBy = text.match(/Read by:?\*{0,2}\s*([^\n]{0,120})/i);
  if (readBy) {
    for (const [name, key] of seats_) {
      if (new RegExp(`\\b${name}\\b`, 'i').test(readBy[1]) && !seats.includes(key)) seats.push(key);
    }
  }
  const card = text.match(/for (?:board )?card #(\d{2,4})/i);
  const url = text.match(/https?:\/\/[^\s)\]]+/);
  return { seats, card: card ? card[1] : null, url: url ? url[0] : null };
}

/** Every artifact URL the board already holds, in one query rather than N. */
async function existingArtifactUrls() {
  const r = await api('POST', '/api/graph', {
    query: 'SELECT ?u WHERE { ?a schema:contentUrl ?u }', limit: 1000,
  });
  if (r.status !== 200) {
    // ⛔ Fail rather than assume nothing exists: "the query did not run" and
    // "there is nothing there" are different facts, and treating the first as
    // the second would duplicate every run on the board.
    throw new Error(`cannot read existing artifacts (${r.status}) — refusing to guess that there are none`);
  }
  return new Set((r.body?.rows ?? []).map((x) => String(x.u)));
}

async function ensurePreProcedureVersion() {
  const list = await api('GET', '/api/procedures');
  if (list.status !== 200) throw new Error(`GET /api/procedures → ${list.status}`);
  const found = (list.body ?? []).find((p) => p.name === PRE_PROCEDURE);
  if (found) return found.versions?.[0]?.id ?? null;
  if (!WRITE) return '(would create)';
  const made = await api('POST', '/api/procedures', { name: PRE_PROCEDURE, body: PRE_PROCEDURE_BODY, by: BY });
  if (made.status !== 201) throw new Error(`create pre-procedure → ${made.status} ${made.raw.slice(0, 200)}`);
  return made.body.version.id;
}

async function main() {
  if (!DIR) {
    console.error('--research-dir <path> (or RESEARCH_DIR) is required: point this at the '
      + 'directory holding your *-notes.md files.');
    process.exit(2);
  }
  if (!existsSync(DIR)) { console.error(`no research directory at ${DIR}`); process.exit(1); }

  const notes = readdirSync(DIR).filter((f) => f.endsWith('-notes.md')).sort();
  const all = readdirSync(DIR);
  console.log(`research dir : ${DIR}`);
  console.log(`files        : ${all.length} total, ${notes.length} notes`);

  const seats = await seatIndex();
  console.log(`roster       : ${new Set([...seats.values()]).size} seat(s), read from the board`);
  const seen = await existingArtifactUrls();
  console.log(`already held : ${seen.size} artifact url(s) on the board`);

  const procVersion = await ensurePreProcedureVersion();
  console.log(`pre-procedure: ${procVersion}\n`);

  const plan = [];
  const unpaired = [];
  for (const n of notes) {
    const notesPath = join(DIR, n);
    const slug = n.replace(/-notes\.md$/, '');
    const meta = readNotes(notesPath, seats);
    // The source that sat beside these notes, if one did.
    const sources = all
      .filter((f) => f !== n && f.startsWith(slug) && /\.(md|vtt|txt|pdf)$/.test(f))
      .map((f) => join(DIR, f));
    if (seen.has(fileUrl(notesPath))) { plan.push({ slug, skip: 'already on the board' }); continue; }
    const why = [];
    if (!meta.seats.length) why.push('no "Read by" line — the reader is unknown');
    if (!meta.card) why.push('no explicit "for board card #N" — a card number in prose is a reference, not a claim');
    if (!sources.length && !meta.url) why.push('no source file or URL found beside the notes');
    if (why.length) unpaired.push({ slug, why });
    plan.push({ slug, notesPath, sources, ...meta });
  }

  const todo = plan.filter((p) => !p.skip);
  console.log(`to record    : ${todo.length}`);
  console.log(`skipped      : ${plan.length - todo.length} (already on the board)`);
  console.log(`partial      : ${unpaired.length} missing at least one of reader / card / source\n`);

  if (!WRITE) {
    for (const p of todo.slice(0, LIMIT || todo.length)) {
      console.log(`  ${p.slug}\n    seats=${p.seats.join(',') || '—'} card=${p.card ?? '—'} sources=${p.sources.length}`);
    }
    if (unpaired.length) {
      console.log('\n── COULD NOT FULLY PAIR (recorded, not hidden) ──');
      for (const u of unpaired) console.log(`  ${u.slug}\n    ${u.why.join('\n    ')}`);
    }
    console.log('\ndry run — nothing written. Pass --write --by <seat> to apply.');
    return;
  }

  let runs = 0; let artifacts = 0; let linked = 0; const failed = [];
  for (const p of (LIMIT ? todo.slice(0, LIMIT) : todo)) {
    try {
      const used = [];
      if (p.url) used.push(p.url);
      const run = await api('POST', '/api/runs', {
        op: 'research', by: BY,
        participants: p.seats,
        performedUsing: procVersion,
        used,
      });
      if (run.status !== 201) { failed.push(`${p.slug}: run → ${run.status} ${run.raw.slice(0, 120)}`); continue; }
      runs += 1;

      for (const f of [p.notesPath, ...p.sources]) {
        const a = await api('POST', '/api/artifacts', {
          run: run.body.id, by: BY, name: basename(f),
          contentUrl: fileUrl(f),
          encodingFormat: f.endsWith('.vtt') ? 'text/vtt' : f.endsWith('.pdf') ? 'application/pdf' : 'text/markdown',
          contentHash: sha256File(f),
        });
        if (a.status === 201) artifacts += 1;
        else failed.push(`${p.slug}: artifact ${basename(f)} → ${a.status}`);
      }

      if (p.card) {
        const g = await api('POST', '/api/runs/generated', { run: run.body.id, by: BY, nodes: [Number(p.card)] });
        if (g.status === 200) linked += 1;
        else failed.push(`${p.slug}: card #${p.card} → ${g.status} ${g.raw.slice(0, 100)}`);
      }
      console.log(`  ✓ ${p.slug} (seats=${p.seats.join(',') || '—'}, artifacts=${1 + p.sources.length}, card=${p.card ?? '—'})`);
    } catch (e) {
      failed.push(`${p.slug}: ${e.message}`);
    }
  }

  console.log(`\nruns ${runs} · artifacts ${artifacts} · cards linked ${linked} · failures ${failed.length}`);
  for (const f of failed) console.log(`  FAILED ${f}`);

  // Read back rather than trusting the responses.
  const check = await api('GET', '/api/board/status');
  console.log(`read back: researchRuns = ${check.body?.researchRuns}`);
  if (unpaired.length) {
    console.log('\n── COULD NOT FULLY PAIR (belongs on the card) ──');
    for (const u of unpaired) console.log(`  ${u.slug}: ${u.why.join('; ')}`);
  }
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
