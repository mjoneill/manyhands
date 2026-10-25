// #1760 — origin-slice4-1744's rows live in ./origin-slice4-1744.rows.mjs. They run in two files so each stays under the runner's
// 300 s per-file bound on CI; this file registers rows 1–57, and origin-slice4-1744-part2.test.mjs the others.
import './origin-slice4-1744.rows.mjs?part=1';
