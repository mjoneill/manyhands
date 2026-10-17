#!/usr/bin/env node
/**
 * #1648 — THE ATTACHMENT RESTORE DRILL: capture, restore into scratch, check.
 *
 *   node scripts/attachments-drill.mjs --source-attachments DIR --source-executor URL|BACKUP_DIR --scratch EMPTY_DIR [--python PY]
 *
 * All three flags are REQUIRED. There is no default and no environment fallback for any of them: a drill that guessed its
 * source could drill the wrong store and report it as yours. The checks, in this order, are all refusals (exit 2, nothing
 * printed on stdout, nothing created under --scratch):
 *   1. a missing flag: named, before anything is read or created;
 *   2. a --scratch that is not an existing EMPTY directory: left exactly as it is;
 *   3. an UNSAFE executor source. A recursive copy of a store directory is not a consistent snapshot, so the only
 *      sources are:
 *        an executor URL (http://...) that answers /health. The snapshot is POST /checkpoint taken WHILE THE ATTACHMENT
 *          FENCE IS HELD, copied byte for byte and verified by scripts/graph-store-backup.mjs (single-link copy, read-only
 *          reopen in a separate process, quad count and commitSeq equal to the checkpoint's). The pair is a PAIRED capture:
 *          `paired: true`, with the checkpoint's commitSeq, quads, datasetId and takenAt under `pairing`.
 *        a directory that is a VERIFIED graph-store backup (its backup-manifest.json verifies). It was not taken under
 *          this capture's fence, so it proves an offline restore only: `paired: false`.
 *      Any other directory, or a URL that is invalid or does not answer, is refused and says why.
 *
 * Past those checks it runs CAPTURE (core/attachment-capture.mjs into SCRATCH/capture, the executor snapshot under
 * SCRATCH/executor-snapshot for a URL source), RESTORE (SCRATCH/capture/attachments into SCRATCH/restored) and CHECK
 * (checkRestore from scripts/attachments-restore-check.mjs), and prints ONE JSON object on stdout:
 *   { stage, error, source, paired, pairing, capture, references, restoredDir, notCovered, check }
 * `check` is checkRestore's result as is; when the capture failed there is no manifest, and `check` is checkRestore's
 * answer to that. Exit 0 exactly when check.ok, 1 otherwise. PAIRING IS NOT FOLDED INTO check.ok: a verified backup
 * directory can pass every byte check and is still `paired: false`, and a paired-capture gate must read `paired` too.
 *
 * References are read from the snapshot only, in BOTH shapes the graph holds them, de-duplicated by id:
 *   - a post's attachment node: ?a scrum:attachmentOf ?post ; schema:identifier ?id ; schema:contentSize ?size
 *   - an entity's JSON in the bookkeeping graph (a card's entityJson): its `attachments` array of { id, size }
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { capture } from '../core/attachment-capture.mjs';
import { BK } from '../core/graph-vocab.mjs';
import { checkRestore } from './attachments-restore-check.mjs';
import { DEFAULT_PYTHON, MANIFEST as BACKUP_MANIFEST, backupStore, verifyBackup } from './graph-store-backup.mjs';

/** What this drill does NOT prove, printed on every run so a reader does not infer coverage from a pass. */
export const NOT_COVERED = Object.freeze([
  'direct filesystem writes by an operator, a script or another process are operationally excluded and not fenced',
]);

const FLAGS = ['--source-attachments', '--source-executor', '--scratch'];
const USAGE = 'usage: node scripts/attachments-drill.mjs --source-attachments DIR --source-executor URL|BACKUP_DIR --scratch EMPTY_DIR [--python PY]';

// Every attachment reference in the snapshot, in both shapes, de-duplicated by id (a nonzero size wins over 0 = unknown).
const PY_REFS = `
import json, sys, pyoxigraph as px
s = px.Store.read_only(sys.argv[1])
refs = {}
shapes = {'attachmentOf': 0, 'entityJson': 0}
def add(i, size, shape):
    if not isinstance(i, str) or not i: return
    try: size = int(size)
    except (TypeError, ValueError): size = 0
    shapes[shape] += 1
    if i not in refs or (refs[i] == 0 and size): refs[i] = size
def val(r, k):
    try: t = r[k]
    except KeyError: return None
    return None if t is None else t.value
for r in s.query('SELECT ?id ?size WHERE { ?a <https://scrumboard.local/ns#attachmentOf> ?post ; <https://schema.org/identifier> ?id . OPTIONAL { ?a <https://schema.org/contentSize> ?size } }', use_default_graph_as_union=True):
    add(val(r, 'id'), val(r, 'size'), 'attachmentOf')
for r in s.query('SELECT ?j WHERE { GRAPH ${BK} { ?s <https://scrumboard.local/ns#entityJson> ?j } }'):
    try: e = json.loads(val(r, 'j') or '')
    except ValueError: continue
    atts = e.get('attachments') if isinstance(e, dict) else None
    if isinstance(atts, list):
        for a in atts:
            if isinstance(a, dict): add(a.get('id'), a.get('size'), 'entityJson')
print(json.dumps({'refs': [{'id': k, 'size': v} for k, v in sorted(refs.items())], 'shapes': shapes}))
`;

function readReferences(dir, python) {
  const r = spawnSync(python, ['-c', PY_REFS, dir], { encoding: 'utf8', timeout: 120000 });
  if (r.error) throw new Error(`reading the snapshot's references: ${python} could not run (${r.error.code || r.error.message})`);
  if (r.status !== 0) throw new Error(`reading the snapshot's references failed (exit ${r.status}): ${String(r.stderr).trim().split('\n').pop() || 'no output'}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const pairingOf = (m, extra = {}) => ({ takenAt: m.takenAt ?? null, commitSeq: m.commitSeq ?? null, quads: m.quads ?? null, datasetId: m.datasetId ?? null, epoch: m.epoch ?? null, ...extra });
const failedChecks = (checks) => checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ');

/**
 * Check 3: the executor source. Resolves { kind: 'url', url } or { kind: 'backup', dir, manifest }, or throws an Error
 * whose message is the refusal. Reads nothing under --scratch and writes nothing anywhere.
 */
export async function resolveSource(source, { python = DEFAULT_PYTHON, fetchImpl = fetch } = {}) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    let u; try { u = new URL(source); } catch { throw new Error(`--source-executor ${source} is not a valid URL`); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`--source-executor ${source}: only an http(s) executor URL is a source`);
    const url = source.replace(/\/+$/, '');
    let res; let health;
    try { res = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(10000) }); health = await res.json(); }
    catch (e) { throw new Error(`--source-executor ${url} does not answer /health (${e.cause?.code || e.name || e.message}): an unreachable executor is not a source`); }
    if (res.status !== 200 || !health || typeof health !== 'object') throw new Error(`--source-executor ${url}/health answered ${res.status}: not a usable executor`);
    return { kind: 'url', url };
  }
  const dir = path.resolve(source);
  let isDir = false; try { isDir = fs.statSync(dir).isDirectory(); } catch { /* reported below */ }
  if (!isDir) throw new Error(`--source-executor ${dir} is neither an executor URL nor a directory`);
  if (!fs.existsSync(path.join(dir, BACKUP_MANIFEST))) {
    throw new Error(`--source-executor ${dir} is not a verified graph-store backup (no ${BACKUP_MANIFEST}): a copy of a store directory is not a consistent snapshot, so it is an UNSAFE source. Give the executor's URL, or a backup made by scripts/graph-store-backup.mjs`);
  }
  const v = verifyBackup(dir, { python });
  if (!v.ok) throw new Error(`--source-executor ${dir} is a graph-store backup that does NOT verify (${failedChecks(v.checks)}): an UNSAFE source`);
  return { kind: 'backup', dir, manifest: JSON.parse(fs.readFileSync(path.join(dir, BACKUP_MANIFEST), 'utf8')) };
}

/** The executor stand-in capture() calls: snapshot() runs INSIDE the fence; references() reads that snapshot only. */
function sourceExecutor(source, { scratch, python, state }) {
  return {
    async snapshot() {
      if (source.kind === 'backup') {
        state.pairing = pairingOf(source.manifest, { backupDir: source.dir, note: 'an offline backup, not taken under this capture\'s fence' });
        return { dir: source.dir };
      }
      const r = await backupStore({ url: source.url, dest: path.join(scratch, 'executor-snapshot'), python });
      if (!r.ok) throw new Error(`the executor checkpoint did not verify: ${failedChecks(r.checks)} (left at ${r.path})`);
      state.pairing = pairingOf(JSON.parse(fs.readFileSync(path.join(r.path, BACKUP_MANIFEST), 'utf8')), { source: source.url, backupDir: r.path });
      state.paired = true;
      return { dir: r.path };
    },
    async references(snap) {
      const got = readReferences(snap.dir, python);
      state.references = { count: got.refs.length, shapes: got.shapes };
      return got.refs;
    },
  };
}

/**
 * Run the drill past the argument checks. `hooks.afterRestore(restoredDir)` is for rows only (a restore damaged on
 * purpose); the command line never passes it. Returns the report; the exit rule is the caller's (check.ok).
 */
export async function runDrill({ sourceAttachments, source, scratch, python = DEFAULT_PYTHON, hooks = {} }) {
  const captureDir = path.join(scratch, 'capture');
  const restored = path.join(scratch, 'restored');
  const state = { paired: false, pairing: null, references: null };
  const report = { stage: 'capture', error: null, source: source.kind === 'url' ? { kind: 'url', url: source.url } : { kind: 'backup', dir: source.dir },
    paired: false, pairing: null, capture: { dir: captureDir, status: null, dangling: null }, references: null, restoredDir: restored,
    notCovered: [...NOT_COVERED], check: null };
  let manifest; let refs;
  try {
    const got = await capture({ attachmentsDir: sourceAttachments, outDir: captureDir, executor: sourceExecutor(source, { scratch, python, state }), waitMs: 3000 });
    report.capture.status = got.status; report.capture.dangling = got.manifest.dangling;
    report.stage = 'restore';
    fs.cpSync(path.join(captureDir, 'attachments'), restored, { recursive: true, errorOnExist: true, force: false });
    if (typeof hooks.afterRestore === 'function') await hooks.afterRestore(restored);
    manifest = JSON.parse(fs.readFileSync(path.join(captureDir, 'manifest.json'), 'utf8'));
    refs = JSON.parse(fs.readFileSync(path.join(captureDir, 'refs.json'), 'utf8'));
    report.stage = 'check';
  } catch (e) { report.error = e.message; }
  Object.assign(report, { paired: state.paired, pairing: state.pairing, references: state.references });
  report.check = checkRestore({ manifest, restoredDir: restored, refs });
  if (report.check.ok && report.error === null) report.stage = 'done';
  return report;
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
  const scratch = path.resolve(flag(argv, '--scratch'));
  const python = flag(argv, '--python') || DEFAULT_PYTHON;
  if (!isDir(scratch)) { console.error(`--scratch ${scratch} is not a directory: give an existing empty directory`); return 2; }
  if (fs.readdirSync(scratch).length) { console.error(`--scratch ${scratch} is not empty: the drill writes only into an empty directory, and this one is left as it is`); return 2; }
  if (!isDir(sourceAttachments)) { console.error(`--source-attachments ${sourceAttachments} is not a directory`); return 2; }
  let source;
  try { source = await resolveSource(flag(argv, '--source-executor'), { python }); } catch (e) { console.error(`refused: ${e.message}`); return 2; }
  const report = await runDrill({ sourceAttachments, source, scratch, python });
  console.log(JSON.stringify(report));
  return report.check.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
