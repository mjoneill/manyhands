/**
 * #1152 — a recording `node:fs`. Re-exports the real module with the
 * path-taking calls wrapped. Named exports are declared EXPLICITLY: a
 * `export * from` would re-export the originals and the wrap would be
 * invisible to exactly the named-import form this exists to catch.
 */
import * as real from 'node:fs';
import { recordPath } from './fs-store-sink.mjs';

const wrap = (fn) => (typeof fn === 'function'
  ? function recorded(p, ...rest) { recordPath(p); return fn.call(this, p, ...rest); }
  : fn);

export const readFileSync = wrap(real.readFileSync);
export const writeFileSync = wrap(real.writeFileSync);
export const appendFileSync = wrap(real.appendFileSync);
export const readdirSync = wrap(real.readdirSync);
export const existsSync = wrap(real.existsSync);
export const statSync = wrap(real.statSync);
export const openSync = wrap(real.openSync);
export const mkdirSync = wrap(real.mkdirSync);
export const renameSync = wrap(real.renameSync);
export const unlinkSync = wrap(real.unlinkSync);
export const rmSync = wrap(real.rmSync);
export const createReadStream = wrap(real.createReadStream);
export const createWriteStream = wrap(real.createWriteStream);
export const realpathSync = wrap(real.realpathSync);
export const promises = real.promises;

const patched = {
  readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync, statSync,
  openSync, mkdirSync, renameSync, unlinkSync, rmSync, createReadStream,
  createWriteStream, realpathSync,
};
// The default export must carry EVERYTHING the real module has (the runtime
// uses fs.watch, fs.constants and others), with the recorded ones overriding.
export default Object.assign(Object.create(null), real, patched);
