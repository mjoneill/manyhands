/**
 * core/attachment-capture.mjs — #1648: THE PAIRED CAPTURE. One executor snapshot and one copy of the attachments
 * directory, taken together while the attachment fence (core/attachment-fence.mjs) is held, so no attachment byte write
 * made through this app's code begins or finishes between the two.
 *
 *   capture({ attachmentsDir, outDir, executor, hooks, waitMs }) -> { status, manifest, refs }
 *
 * executor = { snapshot(), references(snapshot) }: the references are read ONLY from the snapshot taken here, never from a
 * later live read, so a reference added after the snapshot is not in the set.
 *
 * The steps, in order, each preceded by `await hooks.before(step)` (the injectable hold; nothing here sleeps):
 *   snapshot  read the directory (the fence's `before` reading and the file list) and take the executor snapshot
 *   copy      copy every listed file into outDir/attachments, hashing the bytes it wrote; a listed file that is gone
 *             FAILS the capture by name (a loss is never excused as a dangling reference)
 *   manifest  the fence's `after` reading; the directory must not have moved
 *   refs      the snapshot's references; `dangling` (referenced, no file) and `unknownMetadata` (contentSize 0 with the
 *             file present: neither dangling nor a size match); then refs.json, manifest.json, and COMPLETE, LAST
 *
 * outDir on success: attachments/, manifest.json (schema 1 {capturedAt, files, fence:{before,after}} as
 * scripts/attachments-restore-check.mjs reads it, plus dangling, unknownMetadata, status), refs.json ([{id,size}]) and
 * COMPLETE. status is 'COMPLETE', or 'DEGRADED' when dangling is not empty. On any failure it removes what it wrote,
 * releases the fence and rejects: no COMPLETE marker and no manifest.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withAttachmentFence, DEFAULT_WAIT_MS } from './attachment-fence.mjs';

export const STEPS = Object.freeze(['snapshot', 'copy', 'manifest', 'refs']);
const OUTPUTS = ['attachments', 'refs.json', 'manifest.json', 'COMPLETE'];

/** The directory as the restore checker's fence evidence reads it: how many files, and the newest mtime among them. */
function reading(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name).sort();
  let newestMtimeMs = 0;
  for (const n of files) newestMtimeMs = Math.max(newestMtimeMs, fs.statSync(path.join(dir, n)).mtimeMs);
  return { files, fence: { count: files.length, newestMtimeMs } };
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export async function capture({ attachmentsDir, outDir, executor, hooks = {}, waitMs = DEFAULT_WAIT_MS } = {}) {
  if (typeof attachmentsDir !== 'string' || !attachmentsDir) throw new TypeError('capture needs an attachmentsDir');
  if (typeof outDir !== 'string' || !outDir) throw new TypeError('capture needs an outDir');
  if (!executor || typeof executor.snapshot !== 'function' || typeof executor.references !== 'function') throw new TypeError('capture needs an executor { snapshot(), references(snapshot) }');
  fs.mkdirSync(outDir, { recursive: true });
  if (fs.readdirSync(outDir).length) throw new Error(`capture: ${outDir} must be empty`);
  const before = async (step) => { if (typeof hooks.before === 'function') await hooks.before(step); };
  const copyDir = path.join(outDir, 'attachments');

  try {
    return await withAttachmentFence(async () => {
      await before('snapshot');
      const start = reading(attachmentsDir);
      const snap = await executor.snapshot();

      await before('copy');
      fs.mkdirSync(copyDir);
      const files = [];
      for (const name of start.files) {
        let bytes;
        try { bytes = fs.readFileSync(path.join(attachmentsDir, name)); } catch (e) {
          throw new Error(`capture: ${name} existed when the capture began and cannot be read now (${e.code || e.message}); a loss is not a dangling reference`);
        }
        fs.writeFileSync(path.join(copyDir, name), bytes);
        files.push({ name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      }

      await before('manifest');
      const end = reading(attachmentsDir);
      if (end.fence.count !== start.fence.count || end.fence.newestMtimeMs !== start.fence.newestMtimeMs || end.files.join('\n') !== start.files.join('\n')) {
        throw new Error(`capture: the attachments directory changed while the fence was held (before ${JSON.stringify(start.fence)}, after ${JSON.stringify(end.fence)}): a writer outside the fence`);
      }

      await before('refs');
      const raw = await executor.references(snap);
      if (!Array.isArray(raw)) throw new Error('capture: executor.references(snapshot) did not return an array');
      const refs = raw.map((r) => ({ id: String(r.id), size: Number(r.size) }));
      const present = new Set(files.map((f) => f.name));
      const dangling = [...new Set(refs.filter((r) => !present.has(r.id)).map((r) => r.id))].sort();
      const unknownMetadata = [...new Set(refs.filter((r) => present.has(r.id) && (!Number.isFinite(r.size) || r.size === 0)).map((r) => r.id))].sort();
      const status = dangling.length ? 'DEGRADED' : 'COMPLETE';
      const manifest = { schema: 1, capturedAt: new Date().toISOString(), files, fence: { before: start.fence, after: end.fence }, dangling, unknownMetadata, status };
      writeAtomic(path.join(outDir, 'refs.json'), `${JSON.stringify(refs, null, 2)}\n`);
      writeAtomic(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      writeAtomic(path.join(outDir, 'COMPLETE'), `${status}\n`);
      return { status, manifest, refs };
    }, { attachmentsDir, waitMs, owner: 'attachment capture' });
  } catch (e) {
    for (const f of OUTPUTS) fs.rmSync(path.join(outDir, f), { recursive: true, force: true });
    throw e;
  }
}
