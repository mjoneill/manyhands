#!/usr/bin/env node
/**
 * #1648 — THE ATTACHMENT RESTORE DRILL: capture, restore into scratch, check.
 *
 *   node scripts/attachments-drill.mjs --source-attachments DIR --source-executor DIR --scratch EMPTY_DIR [--python PY]
 *
 * All three flags are REQUIRED. There is no default and no environment fallback for any of them: a drill that guessed its
 * source could drill the wrong store and report it as yours. A missing flag exits 2 and names the flag, before anything
 * is read or created. A --scratch that is not an existing EMPTY directory is refused the same way and left untouched.
 *
 * Past those checks it runs, in order:
 *   1. CAPTURE  core/attachment-capture.mjs into SCRATCH/capture, holding the attachment fence on the source attachments
 *               directory. The executor snapshot is a byte copy of --source-executor into SCRATCH/executor-snapshot taken
 *               under that fence; the references are read from that COPY (read-only, by a separate python process with
 *               pyoxigraph), never from the source.
 *   2. RESTORE  SCRATCH/capture/attachments into SCRATCH/restored.
 *   3. CHECK    scripts/attachments-restore-check.mjs checkRestore() over the restore, the manifest and refs.json.
 * and prints ONE JSON object on stdout: { ok, stage, error, capture, notCovered, check }. `check` is checkRestore's result
 * as is; when the capture failed there is no manifest, and `check` is checkRestore's answer to that (manifest-invalid), so a
 * failure still carries a check and the "not covered" list. Exit 0 exactly when check.ok, 1 otherwise, 2 on a refusal.
 *
 * The executor copy is a plain byte copy: pointed at a store a running executor is writing, it can be torn. Point it at a
 * stopped store or a published checkpoint (scripts/graph-store-backup.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { capture } from '../core/attachment-capture.mjs';
import { checkRestore } from './attachments-restore-check.mjs';
import { DEFAULT_PYTHON } from './graph-store-backup.mjs';

/** What this drill does NOT prove, printed on every run so a reader does not infer coverage from a pass. */
export const NOT_COVERED = Object.freeze([
  'direct filesystem writes by an operator, a script or another process are operationally excluded and not fenced',
]);

const FLAGS = ['--source-attachments', '--source-executor', '--scratch'];
const USAGE = 'usage: node scripts/attachments-drill.mjs --source-attachments DIR --source-executor DIR --scratch EMPTY_DIR [--python PY]';

// Every attachment reference in the graph: its id and its contentSize (0 or absent = unknown), from any graph.
const PY_REFS = `
import json, sys, pyoxigraph as px
s = px.Store.read_only(sys.argv[1])
q = 'SELECT ?id ?size WHERE { ?a <https://scrumboard.local/ns#attachmentOf> ?post ; <https://schema.org/identifier> ?id . OPTIONAL { ?a <https://schema.org/contentSize> ?size } }'
out = []
for r in s.query(q, use_default_graph_as_union=True):
    size = r['size'].value if r['size'] is not None else '0'
    try: size = int(size)
    except ValueError: size = 0
    out.append({'id': r['id'].value, 'size': size})
print(json.dumps(out))
`;

/** The executor stand-in for the drill: snapshot = a byte copy of the store; references = read from that copy only. */
function storeExecutor(source, snapshotDir, python) {
  return {
    async snapshot() {
      fs.cpSync(source, snapshotDir, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      return { dir: snapshotDir };
    },
    async references(snap) {
      const r = spawnSync(python, ['-c', PY_REFS, snap.dir], { encoding: 'utf8', timeout: 60000 });
      if (r.error) throw new Error(`reading the snapshot's references: ${python} could not run (${r.error.code || r.error.message})`);
      if (r.status !== 0) throw new Error(`reading the snapshot's references failed (exit ${r.status}): ${String(r.stderr).trim().split('\n').pop() || 'no output'}`);
      return JSON.parse(r.stdout);
    },
  };
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && typeof argv[i + 1] === 'string' && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

export async function main(argv) {
  const missing = FLAGS.filter((f) => !flag(argv, f));
  if (missing.length) { console.error(`${USAGE}\nmissing required flag${missing.length > 1 ? 's' : ''}: ${missing.join(', ')} (no default, no environment fallback)`); return 2; }
  const sourceAttachments = path.resolve(flag(argv, '--source-attachments'));
  const sourceExecutor = path.resolve(flag(argv, '--source-executor'));
  const scratch = path.resolve(flag(argv, '--scratch'));
  const python = flag(argv, '--python') || DEFAULT_PYTHON;
  for (const [f, p] of [['--source-attachments', sourceAttachments], ['--source-executor', sourceExecutor], ['--scratch', scratch]]) {
    if (!isDir(p)) { console.error(`${f} ${p} is not a directory`); return 2; }
  }
  if (fs.readdirSync(scratch).length) { console.error(`--scratch ${scratch} is not empty: the drill writes only into an empty directory, and this one is left as it is`); return 2; }

  const captureDir = path.join(scratch, 'capture');
  const restored = path.join(scratch, 'restored');
  const report = { ok: false, stage: 'capture', error: null, capture: { dir: captureDir, status: null }, restoredDir: restored, notCovered: [...NOT_COVERED], check: null };
  let manifest; let refs;
  try {
    const got = await capture({ attachmentsDir: sourceAttachments, outDir: captureDir, executor: storeExecutor(sourceExecutor, path.join(scratch, 'executor-snapshot'), python), waitMs: 3000 });
    report.capture.status = got.status;
    report.stage = 'restore';
    fs.cpSync(path.join(captureDir, 'attachments'), restored, { recursive: true, errorOnExist: true, force: false });
    manifest = JSON.parse(fs.readFileSync(path.join(captureDir, 'manifest.json'), 'utf8'));
    refs = JSON.parse(fs.readFileSync(path.join(captureDir, 'refs.json'), 'utf8'));
    report.stage = 'check';
  } catch (e) { report.error = e.message; }
  report.check = checkRestore({ manifest, restoredDir: restored, refs });
  report.ok = report.check.ok === true && report.error === null;
  if (report.ok) report.stage = 'done';
  console.log(JSON.stringify(report));
  return report.check.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
