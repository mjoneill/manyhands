/**
 * #1567 trial isolation — preloaded with `node --import` into a trial process.
 * Every filesystem WRITE whose target resolves outside TRIAL_DIR throws, and
 * the refusal is printed with a fixed marker, so "the trial wrote into the real
 * tree" is a loud crash with a grep-able line, never a quiet success.
 *
 * Reads are not fenced: the trial process runs a COPY of the tracked code that
 * lives inside TRIAL_DIR (scripts/trial-server.sh), so the data paths it would
 * read by default are inside the fence as well.
 */
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const ROOT = process.env.TRIAL_DIR && fs.realpathSync(process.env.TRIAL_DIR);
if (!ROOT) {
  console.error('TRIAL-FS-GUARD: TRIAL_DIR is not set; refusing to start');
  process.exit(3);
}
// #1559: the evidence a server checks before honouring SCRUM_GRAPH_TRIAL_UNBOUND_ACTORS
globalThis.__TRIAL_FS_GUARD_ROOT__ = ROOT;

function inside(p) {
  if (p == null) return true;                   // fds and the like: not a path
  if (typeof p !== 'string' && !(p instanceof URL) && !Buffer.isBuffer(p)) return true;
  let abs = path.resolve(String(p instanceof URL ? p.pathname : p));
  // resolve the deepest existing ancestor through symlinks (/var → /private/var)
  let probe = abs; const tail = [];
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) { tail.unshift(path.basename(probe)); probe = path.dirname(probe); }
  try { abs = path.join(fs.realpathSync(probe), ...tail); } catch { /* keep abs */ }
  return abs === ROOT || abs.startsWith(ROOT + path.sep);
}
function refuse(op, p) {
  const msg = `TRIAL-FS-GUARD REFUSED ${op} outside ${ROOT}: ${String(p)}`;
  console.error(msg);
  throw Object.assign(new Error(msg), { code: 'TRIAL_FS_GUARD' });
}
const WRITE_FLAGS = /[wa+]/;

const guard = (obj, name, pathArgs, isWrite = () => true) => {
  const orig = obj[name];
  if (typeof orig !== 'function') return;
  obj[name] = function guarded(...args) {
    if (isWrite(args)) for (const i of pathArgs) if (!inside(args[i])) refuse(name, args[i]);
    return orig.apply(this, args);
  };
};
const flagWrite = (i) => (args) => {
  const f = typeof args[i] === 'object' && args[i] ? args[i].flags : args[i];
  return typeof f === 'string' ? WRITE_FLAGS.test(f) : (typeof f === 'number' ? (f & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0 : false);
};

for (const o of [fs, fs.promises]) {
  for (const n of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync', 'rm', 'rmSync',
    'rmdir', 'rmdirSync', 'unlink', 'unlinkSync', 'truncate', 'truncateSync', 'mkdtemp', 'mkdtempSync', 'utimes', 'utimesSync', 'chmod', 'chmodSync']) guard(o, n, [0]);
  for (const n of ['rename', 'renameSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'symlink', 'symlinkSync', 'link', 'linkSync']) guard(o, n, [0, 1]);
  guard(o, 'open', [0], flagWrite(1));
  guard(o, 'openSync', [0], flagWrite(1));
}
guard(fs, 'createWriteStream', [0]);
syncBuiltinESMExports();
