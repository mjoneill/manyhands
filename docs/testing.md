# Testing in depth

Moved here verbatim from the README on 2026-10-11 (#1678), so the README could stay short enough to read. Nothing below was rewritten; where it quotes a count or a date, that is what was true when it was written.

## The verdict ledger

`npm run test:server` records what it said — verdict, failing files, and the tree it ran against — to an append-only log outside the repo. Read it with `npm run test:ledger`.

This exists because **a green rerun destroys the evidence.** The usual response to a suspicious failure is to run it again, and once it passes there is nothing left to count; a file that flaked every morning would be correctly detected each time and never once counted. Three such flakes went by in a single morning here, and all three are known only because somebody happened to be watching for something else.

⚠️ It records **verdicts, not flakes** — at write time you cannot know a red is a flake, since that needs a later green. Classification is left to whoever reads it.

Three boundaries the reader states out loud, because a true number about a smaller world than you assume is the same defect as calling a subset-green a suite-green:

- a bare `node --test` is **not** recorded, and neither is `npm run test:browser`;
- a run over a dirty tree is recorded but **not counted**, because a verdict about uncommitted work describes a state that never shipped;
- a **timed-out** run produces no event at all — its process tree is killed before the runner can write one.

Hence the denominator is *recorded clean completed server-suite runs*, never "runs". Each of those qualifiers was a false denominator until somebody named it.

⚠️ **The timeout seam is a dependency, not a gap.** Timed-out runs are absent here because the suite watch already makes them loud — it posts, names the incomplete files, and terminates the tree. If that alarm ever regresses, timeouts become invisible in *both* instruments simultaneously and nothing will say so. Two instruments with a stated seam beat one instrument with an unstated hole, but only while the seam is written down.

If a write fails, the run says so on stderr and its verdict is unchanged — a suite result must never depend on whether a log could be written, and an instrument that cannot report its own failure is the thing this was built to fix.

**The two browser lanes prove different things, and neither implies the other:**

| Lane | What it loads | Page errors |
|---|---|---|
| **Served** | real pages from `node server.js` | **zero tolerated** — the served page is the product |
| **Direct-file** | `index.html` over `file://` | a **named** set of sandbox CORS failures is expected; anything else fails |

Under `file://`, Chromium refuses cross-origin module imports and `fetch`, so module-backed features genuinely cannot load there. That lane is not a claim that the app works without a server — it guards the narrow core workflow (the page renders from the fallback roster, a card can be created, it survives a reload) so that "renders" never quietly means "renders only when our server dressed it."

The expected `file://` errors are enumerated in `run-tests.js`, each with a reason, and a bare `Failed to load resource` is allowed only up to the number of requests known to have been CORS-blocked. **An unexpected page error fails the run even when every test passes** — because for a while it didn't, and a runner that prints errors while exiting 0 is a runner that has taught you to ignore it.
