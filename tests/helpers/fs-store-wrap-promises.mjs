/** #1152 — the promises face, same discipline. */
import * as real from 'node:fs/promises';
import { recordPath } from './fs-store-sink.mjs';
const wrap = (fn) => (typeof fn === 'function'
  ? function recorded(p, ...rest) { recordPath(p); return fn.call(this, p, ...rest); }
  : fn);
export const readFile = wrap(real.readFile);
export const writeFile = wrap(real.writeFile);
export const appendFile = wrap(real.appendFile);
export const readdir = wrap(real.readdir);
export const stat = wrap(real.stat);
export const mkdir = wrap(real.mkdir);
export const rename = wrap(real.rename);
export const unlink = wrap(real.unlink);
export const rm = wrap(real.rm);
export default Object.assign(Object.create(null), real,
  { readFile, writeFile, appendFile, readdir, stat, mkdir, rename, unlink, rm });
