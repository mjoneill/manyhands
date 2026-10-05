/**
 * #1574 G1–G3 — the strict board-file check for migration and rollback scripts.
 *
 * The application reads a missing board file as an EMPTY board (loadDomain's default), which is right for a
 * fresh server and wrong for a script that copies or rewrites data: a mistyped path, a half-copied file or a
 * truncated write would read as "no posts", the backfill would report a clean run of nothing, and the rollback
 * would write a fresh board holding only the graph's posts. Scripts call this BEFORE they contact anything.
 *
 * Returns null when the file is a board; otherwise a one-line reason that names the path. Reads only.
 */
import fs from 'node:fs';
import { isJsonLdDocument } from './jsonld.mjs';

export function boardFileProblem(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return `board file ${file} cannot be read (${e.code || e.message}); nothing was done`; }
  if (!st.isFile()) return `board file ${file} is not a regular file; nothing was done`;
  if (st.size === 0) return `board file ${file} is empty (0 bytes): a truncated or half-copied file, not an empty board; nothing was done`;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return `board file ${file} is not valid JSON (${e.message}); nothing was done`; }
  const isBoard = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (isJsonLdDocument(parsed) || Array.isArray(parsed.cards));
  return isBoard ? null : `board file ${file} is JSON but not a board document; nothing was done`;
}
