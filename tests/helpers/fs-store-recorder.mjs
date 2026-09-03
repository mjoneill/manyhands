/**
 * tests/helpers/fs-store-recorder.mjs — #1152: what did the RUNTIME actually open?
 *
 * Loaded into a server child with `NODE_OPTIONS=--import`, this registers a
 * module-resolve hook that substitutes a WRAPPED `node:fs` for every importer,
 * and appends every distinct path the process reaches for to `SCRUM_FS_RECORD`.
 * The #1152 check then asks whether each is a registered store.
 *
 * ── WHY A LOADER HOOK AND NOT A MONKEYPATCH ─────────────────────────────────
 *
 * ⛔ I BUILT THE MONKEYPATCH FIRST AND IT WAS A FALSE GREEN. Patching
 * `fs.readFileSync` on the default export does NOT intercept
 * `import { readFileSync } from 'node:fs'` — an ESM named import binds to the
 * module's export, not to the object property, so a later mutation is invisible
 * to it. Measured directly (2026-09-03): a two-file experiment reported
 * "named-import call intercepted? NO".
 *
 * ⇒ `core/store.mjs` — which opens `board-data.json`, THE record — uses exactly
 * that named form, as do six other runtime modules. So the monkeypatch recorded
 * 5 paths out of a much larger population, the gate passed, and `board-data.json`
 * was absent from the recording of a server that had just written it. **A check
 * that measures an arbitrary subset and reports a clean result is the defect
 * this card exists to close, arriving inside the card's own instrument.**
 *
 * Substituting the module reaches both forms; the same experiment reports YES.
 *
 * ⚠️ TEST-ONLY. Inert unless `SCRUM_FS_RECORD` is set, so a stray `--import`
 * cannot change behaviour. It records PATHS ONLY, never content — one of the
 * registered stores holds seat tokens.
 *
 * ⚠️ It records the ATTEMPT, not the success: a read of a file that does not
 * exist still names a store the runtime reaches for, which is the population
 * the invariant cares about.
 */
import { register } from 'node:module';

if (process.env.SCRUM_FS_RECORD) {
  register(new URL('./fs-store-hooks.mjs', import.meta.url));
}
