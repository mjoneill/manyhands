/**
 * tools/release-notes.mjs — #1026. The notes for one deploy, and the tag that
 * names it.
 *
 * The customer question, verbatim (2026-08-23): "there's not an obvious way
 * that I can tell that helps me understand what's changing. no version
 * numbers. how would I understand the evolution of this project over time?"
 *
 * That sentence holds TWO asks, and this file answers exactly ONE of them:
 *
 *   "what's changing … no version numbers"     ⇒ THIS. A tag per deploy and the
 *                                                 commits between it and the last.
 *   "understand the EVOLUTION over time"       ⇒ NOT this. That needs a
 *                                                 narrative layer over retros,
 *                                                 and the card gates it on a
 *                                                 retro corpus that does not
 *                                                 exist yet.
 *
 * ⛔ The notes SAY which half they are, in every release, because a partial
 * answer presented as whole is worse than none — the reader stops asking.
 *
 * ⚠️ A GENERATED CHANGELOG IS ONLY AS LEGIBLE AS ITS WORST COMMIT SUBJECT.
 * This runs on nights nobody was writing for a reader. So a subject that does
 * not read (no conventional prefix, or too short to mean anything) is set
 * apart under "Other" AND COUNTED in a line the reader sees — visibly thin,
 * never confidently opaque.
 *
 * ⛔ NOT A SECOND COMMIT-WALKER. `commitsBetween` is the drift tool's listing
 * (tools/deploy-drift.mjs), extracted so both share one idea of "the commits
 * in a range". Runtime vs test-only comes from there too.
 *
 * WHY A TAG + GITHUB RELEASE, NOT A CHANGELOG.md IN THE TREE: a file in the
 * tree needs a commit, which changes the range it describes — every entry
 * would be one commit behind itself. A tag names the deployed sha without
 * touching history, and a Release attached to it is what a downstream reader
 * (someone who pulls the public repo and never sees this board) actually
 * opens to ask "did they fix my thing?"
 *
 * Usage (deploy.sh calls this; a human can too):
 *   node tools/release-notes.mjs --repo <clone> --from <sha> --to <sha> --tag <name>
 *   node tools/release-notes.mjs --repo <clone> --next-tag       # prints the next tag name
 */

import { execFileSync } from 'node:child_process';
import { commitsBetween } from './deploy-drift.mjs';

// Conventional prefixes, and what the reader sees them as. Anything else is
// "Other" — named, counted, and not dressed up.
const GROUPS = [
  { key: 'feat', heading: 'Features' },
  { key: 'fix', heading: 'Fixes' },
  { key: 'perf', heading: 'Performance' },
  { key: 'refactor', heading: 'Refactors' },
  { key: 'docs', heading: 'Documentation' },
];
const PREFIX = /^(feat|fix|perf|refactor|docs|test|tests|chore|build|ci|style)(\([^)]*\))?!?:\s*(.+)$/i;

/** A subject a reader can act on: prefixed, and with a clause after the prefix. */
export function readable(subject) {
  const m = PREFIX.exec(subject || '');
  if (!m) return null;
  const body = m[3].trim();
  if (body.split(/\s+/).length < 3) return null;   // "fix: stuff" is not a note
  return { kind: m[1].toLowerCase(), scope: (m[2] || '').slice(1, -1), body };
}

/**
 * Sort commits into the groups a reader wants. Test-only commits (from the
 * drift tool's runtime split) go under their own heading regardless of prefix:
 * deploying them changed nothing that runs, and the reader should know that.
 */
export function groupCommits(commits) {
  const out = { groups: new Map(GROUPS.map((g) => [g.key, []])), testOnly: [], other: [], unreadable: 0 };
  for (const c of commits) {
    if (!c.isRuntime) { out.testOnly.push(c); continue; }
    const r = readable(c.subject);
    if (!r) { out.other.push(c); out.unreadable++; continue; }
    if (out.groups.has(r.kind)) out.groups.get(r.kind).push({ ...c, parsed: r });
    else out.other.push(c);   // test/chore/ci on a runtime file — real, but not a feature or a fix
  }
  return out;
}

// The scope — almost always a card number here — is the reader's handle back
// to the board, and the one thing a downstream reader will search for. It
// leads the line; the prefix is folded into the heading.
const line = (c) => c.parsed
  ? `- ${c.parsed.scope ? `${c.parsed.scope} · ` : ''}${c.parsed.body} (${c.short})`
  : `- ${c.subject} (${c.short})`;

/** The markdown for one release. Pure: no git, no clock. */
export function renderReleaseNotes({ tag, from, to, commits }) {
  const g = groupCommits(commits);
  const parts = [];
  parts.push(`# ${tag}`);
  parts.push('');
  parts.push(`Deployed \`${String(to).slice(0, 7)}\` · range \`${String(from).slice(0, 7)}..${String(to).slice(0, 7)}\` · ${commits.length} commit${commits.length === 1 ? '' : 's'}`);
  parts.push('');
  if (commits.length === 0) {
    parts.push('_No commits in this range — the deploy re-served the same sha._');
  }
  for (const { key, heading } of GROUPS) {
    const list = g.groups.get(key);
    if (!list.length) continue;
    parts.push(`## ${heading}`);
    for (const c of list) parts.push(line(c));
    parts.push('');
  }
  if (g.other.length) {
    parts.push('## Other');
    for (const c of g.other) parts.push(line(c));
    parts.push('');
  }
  if (g.testOnly.length) {
    parts.push('## Tests and tooling only');
    parts.push('_These changed nothing that runs; listed so the range is complete._');
    for (const c of g.testOnly) parts.push(line(c));
    parts.push('');
  }
  if (g.unreadable > 0) {
    parts.push(`> ⚠️ ${g.unreadable} of ${commits.length} commit${commits.length === 1 ? '' : 's'} ha${g.unreadable === 1 ? 's' : 've'} no readable subject and ${g.unreadable === 1 ? 'is' : 'are'} listed under Other as written. These notes are only as clear as the commits they summarise.`);
    parts.push('');
  }
  parts.push('---');
  parts.push('_This is what changed between two deploys. It is not an account of the project\'s evolution over time — that is a different question, and it is not answered here (#1026)._');
  parts.push('');
  return parts.join('\n');
}

/**
 * Date-based, not semver: nothing here carries a compatibility contract, and
 * a number that implied one would be a lie. A second deploy on the same day
 * gets `.2`, a third `.3`; a new day starts clean.
 */
export function nextTagName(now, existingTags) {
  const d = new Date(now);
  const base = `v${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCDate()).padStart(2, '0')}`;
  const taken = new Set(existingTags);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const t = `${base}.${n}`;
    if (!taken.has(t)) return t;
  }
  throw new Error(`release-notes: more than 999 tags for ${base}`);
}

function git(repoDir, args) {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function existingReleaseTags(repoDir) {
  const out = git(repoDir, ['tag', '--list', 'v20*']);
  return out ? out.split('\n').filter(Boolean) : [];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
  };
  const repo = arg('repo', process.cwd());
  if (process.argv.includes('--next-tag')) {
    process.stdout.write(nextTagName(new Date(), existingReleaseTags(repo)) + '\n');
    process.exit(0);
  }
  const from = arg('from'); const to = arg('to'); const tag = arg('tag');
  if (!from || !to || !tag) {
    console.error('usage: node tools/release-notes.mjs --repo <clone> --from <sha> --to <sha> --tag <name>   |   --repo <clone> --next-tag');
    process.exit(2);
  }
  let commits;
  try { commits = commitsBetween(repo, from, to); }
  catch (e) { console.error(`release-notes: could not list ${from.slice(0, 7)}..${to.slice(0, 7)}: ${e.message.split('\n')[0]}`); process.exit(1); }
  process.stdout.write(renderReleaseNotes({ tag, from, to, commits }));
}
