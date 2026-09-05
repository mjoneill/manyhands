#!/usr/bin/env node
/**
 * #1209 — ONE TEXT, TWO HOMES, AND THE FILE IS DERIVED.
 *
 * A procedure is a ProcedureVersion in the graph AND a loadable skill on disk.
 * The obvious way to get both is to write it twice, which is the defect this
 * board keeps finding under other names: a fact with two homes cannot
 * contradict itself visibly, so nothing detects that it did.
 *
 * ⇒ So the skill file is GENERATED FROM THE VERSION, never copied. If the two
 * ever differ, the generator is broken — not the text. `--check` asserts
 * exactly that and is what a test (and CI) runs.
 *
 *   node tools/export-procedure-skill.mjs --name "research a YouTube video"
 *   node tools/export-procedure-skill.mjs --name "…" --check     # exit 1 on drift
 *   node tools/export-procedure-skill.mjs --name "…" --from-file tools/procedure-texts/research-video.md
 *   node tools/export-procedure-skill.mjs --name "…" --out-dir /tmp/x   # generate elsewhere
 *
 * Source of truth order: the live board's newest version for that procedure,
 * or --from-file when seeding a procedure that does not exist yet.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : (args[i + 1] ?? true); };
const BASE = flag('base-url', process.env.SCRUM_BOARD_URL || 'http://localhost:3141');
const NAME = flag('name');
const CHECK = args.includes('--check');
const FROM_FILE = flag('from-file');

if (!NAME) { console.error('--name <procedure name> is required'); process.exit(2); }

/** A stable slug for the on-disk home. */
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * The skill file. Front matter is what a harness reads to list the skill; the
 * body is the version text VERBATIM. Nothing is rewritten here — a generator
 * that improves its input is a second author.
 */
function render(name, body, meta) {
  return `---
name: ${slug(name)}
description: ${meta.description}
---

<!-- GENERATED — DO NOT EDIT.
     Source of truth: the scrum:ProcedureVersion in the board graph.
     Regenerate: node tools/export-procedure-skill.mjs --name "${name}"
     Verify:     node tools/export-procedure-skill.mjs --name "${name}" --check
     Editing this file makes it disagree with the graph, and the graph is what a
     run records itself as having followed. Change the procedure, not the copy:
     procedure_version_create. -->

# ${name}

${body.trim()}
`;
}

async function versionFromBoard(name) {
  const res = await fetch(`${BASE}/api/procedures`);
  if (!res.ok) throw new Error(`GET /api/procedures → ${res.status}`);
  const procs = await res.json();
  const proc = procs.find((p) => p.name === name);
  if (!proc) return null;
  // NEWEST version wins: the file follows the current method, and past runs
  // still name the version they actually followed.
  const versions = [...(proc.versions ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return versions[0] ?? null;
}

async function main() {
  let body = null; let source = null;
  try {
    const v = await versionFromBoard(NAME);
    if (v) { body = v.body; source = `board ${v.id}`; }
  } catch (e) {
    if (!FROM_FILE) {
      // ⛔ Fail rather than silently fall back: a skill generated from an
      // unknown source is exactly the drift this file exists to prevent.
      console.error(`cannot read the board at ${BASE}: ${e.message}`);
      console.error('pass --from-file to seed a procedure that does not exist on the board yet.');
      process.exit(1);
    }
  }
  if (body === null && FROM_FILE) {
    body = readFileSync(join(ROOT, String(FROM_FILE)), 'utf8');
    source = `file ${FROM_FILE} (NOT yet on the board — seed it with procedure_create)`;
  }
  if (body === null) {
    console.error(`no procedure named ${JSON.stringify(NAME)} on the board, and no --from-file given`);
    process.exit(1);
  }

  // ⚠️ `.claude/` is GITIGNORED and seat-local by design, so the skill file is
  // a GENERATED ARTIFACT rather than a committed one: a clone runs this and
  // gets a skill that matches ITS board. What is tracked is the text and this
  // generator. --out-dir exists so a test can prove the generator without
  // depending on an untracked file being present (it would pass locally and
  // fail on a fresh checkout, which is a trap this repo has already sprung).
  const OUT_DIR = flag('out-dir', join(ROOT, '.claude', 'skills'));
  const out = join(String(OUT_DIR), slug(NAME), 'SKILL.md');
  const rendered = render(NAME, body, {
    description: `How this room researches a video: identify, capture the raw bytes first, verify every claim against a primary source, and record the run in the graph so the finding outlives the session.`,
  });

  if (CHECK) {
    if (!existsSync(out)) { console.error(`MISSING: ${out}\nrun without --check to generate it`); process.exit(1); }
    const onDisk = readFileSync(out, 'utf8');
    if (onDisk !== rendered) {
      console.error(`DRIFT: ${out} differs from the procedure text (${source}).`);
      console.error('The generator is not broken by default — the FILE was edited, or the version changed.');
      console.error(`Regenerate: node tools/export-procedure-skill.mjs --name ${JSON.stringify(NAME)}`);
      process.exit(1);
    }
    console.log(`ok — ${out} matches ${source}`);
    return;
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, rendered);
  console.log(`wrote ${out}\n  from ${source}\n  ${rendered.length} bytes`);
}

main().catch((e) => { console.error(e); process.exit(1); });
