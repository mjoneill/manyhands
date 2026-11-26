# #2025 fixtures: three real red CI runs from 2026-11-21 (PR #262)

Each folder holds one failed run, trimmed from the `gh run view <id> --attempt <n> --log-failed` output.

- `failed.log` keeps the lines a verdict can use: every top-level `not ok` block that is not a `# TODO` or
  `# SKIP` row, the TAP summary counts, `# ⛔ FILE EXITED`, `# tmp: ⛔` (new temp leaks) and the runner's
  `⛔` and `##[error]` lines. Lines keep gh's `job<TAB>step<TAB>timestamp message` shape.
- `meta.json` gives the run (sha, run id, attempt, event), the full log's sha256, line count and byte count
  (so the trim can be checked against a fresh download), the files the diff changed, and `newTokens`:
  identifiers of 4+ characters that the diff's added lines contain and the base tree (`git grep` at `base`)
  never had. `otherRunsSameSha` is what CI reported for the same sha in other runs.

The hand verdicts these must reproduce (corrected 2026-11-21, see #2025):

| run | what a seat found by hand |
|---|---|
| 05ed720-pr | four guard tests failed in files the diff did NOT touch; the diff caused all four (each message names something the diff added). The run ALSO had the reactions-449 new temp leak: the hand read missed it, and fixing only the four cost a second red round (9231d64) |
| 9231d64-pr | `# fail 0`, but a new temp leak in `tests/reactions-449.test.mjs`, a file the diff added |
| 29871cc-main-a1 | one failure in a file the diff did not touch, naming nothing the diff added; the same sha passed on the PR run, so a probable flake: rerun once |
