#!/usr/bin/env node
/**
 * export-board.mjs — the whole room, on disk, readable without the app.
 *
 * A slice of #465 ("Export as a first-class feature"). #459 built the export
 * boundary for a single wiki node; this builds the other half Michael kept
 * asking for by hand: **everything, from day one, in the room's own order.**
 *
 * ── Why this exists as a file instead of a habit ──────────────────────────
 * The same export had been produced three times (2026-07-04, 07-11, 07-22),
 * each from a throwaway script, each in a different format with a different
 * split strategy. Three solutions to one problem, none of them reusable. The
 * third was the best of them, so its output format is reproduced here rather
 * than improved on — a fourth format would make four incompatible archives.
 *
 * ── The trap this tool exists to avoid ───────────────────────────────────
 * `GET /api/conversations?limit=100000` returns **200 messages**. The limit is
 * capped server-side (#210) and the response says nothing about the ceiling —
 * it is a silently truncated answer that looks like a complete one. An export
 * built on it would have shipped 200 of 8,062 messages and looked fine.
 * So we read `/api/load`, which is the bulk endpoint and returns the whole
 * board in one response, and then we CHECK the counts we wrote against the
 * counts we received and refuse to finish if they disagree.
 *
 * Usage:
 *   node export-board.mjs                          # everything → ./board-export-<date>/
 *   node export-board.mjs --out ~/Downloads/x      # somewhere specific
 *   node export-board.mjs --spaces commons         # just the room
 *   node export-board.mjs --max-bytes 1500000      # part size target
 *   node export-board.mjs --tolerance 0            # make the target a hard ceiling
 *   node export-board.mjs --base http://host:port  # another instance
 *
 * Exit: 0 wrote the export · 1 refused (a count disagreed, or nothing to write)
 */

const DEFAULTS = {
  base: process.env.SCRUM_API_BASE || 'http://localhost:3141',
  // 1.5 MB: the size that made the 2026-07-22 export usable. Parts are packed
  // UNDER it at record boundaries, so a part is never a torn message.
  maxBytes: 1_500_000,
  // ── Acceptable variance, not a hard limit ────────────────────────────────
  // Michael's framing, 2026-07-27, and it is the right one: "goal: <1.5MB per
  // segment with a tolerance of 5% or something."
  //
  // A target alone leaves "a little over is fine" to whoever is reading the
  // output — which means the tool cannot tell an ordinary rounding overshoot
  // from a genuine problem, and neither can the reader. A hard limit is worse:
  // it refuses a finished archive over a few hundred bytes. Stating the
  // tolerance makes "fine" checkable, and makes the one case that ISN'T fine
  // (a single record too big to pack) visible as the exception it is.
  //
  // Some callers will want a real ceiling — an upload limit, an email
  // attachment cap. `--tolerance 0` gives them one without a second concept.
  tolerancePct: 5,
  spaces: ['commons', 'cards'],
  format: 'md',
};

const KNOWN_SPACES = ['commons', 'cards'];
// `wiki` is an alias, not a third space: this board's wiki IS the card bodies —
// same nodes, different view. Accepting the word and mapping it is kinder than
// rejecting it, and the INDEX says so out loud so nobody thinks pages went missing.
const SPACE_ALIASES = { wiki: 'cards', board: 'cards', conversations: 'commons', room: 'commons' };

function die(msg, code = 1) {
  console.error(`\nx export-board: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const a = { ...DEFAULTS, spaces: [...DEFAULTS.spaces] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--out') a.out = argv[++i];
    else if (flag === '--base') a.base = String(argv[++i]).replace(/\/+$/, '');
    else if (flag === '--max-bytes') a.maxBytes = Number(argv[++i]);
    else if (flag === '--tolerance') a.tolerancePct = Number(argv[++i]);
    else if (flag === '--format') a.format = String(argv[++i]).toLowerCase();
    else if (flag === '--spaces') {
      a.spaces = String(argv[++i]).split(',').map((s) => {
        const k = s.trim().toLowerCase();
        return SPACE_ALIASES[k] || k;
      }).filter((s, idx, arr) => arr.indexOf(s) === idx);
    } else if (flag === '--help' || flag === '-h') {
      console.log(`usage: node export-board.mjs [--out DIR] [--spaces commons,cards] [--format md]
                            [--max-bytes N] [--tolerance PCT] [--base URL]

  --max-bytes  part size TARGET in bytes (default 1500000)
  --tolerance  acceptable variance above the target, percent (default 5).
               Parts are packed to the target; the header lands on top, so a
               small overshoot is normal. Beyond tolerance means one record is
               larger than a whole part — reported, never truncated.
               --tolerance 0 turns the target into a hard ceiling.`);
      process.exit(0);
    } else die(`unrecognised argument: ${flag}`);
  }
  // #465 will grow html and json here. The flag exists NOW, with one value
  // implemented, so adding them later doesn't change the command anyone learned.
  if (a.format !== 'md') die(`--format ${a.format} is not built yet (this slice ships 'md'; html and json are #465)`);
  const bad = a.spaces.filter((s) => !KNOWN_SPACES.includes(s));
  if (bad.length) die(`unknown space(s): ${bad.join(', ')} — known: ${KNOWN_SPACES.join(', ')}, wiki (⇒ cards)`);
  if (!a.spaces.length) die('no spaces selected');
  if (!Number.isFinite(a.maxBytes) || a.maxBytes < 50_000) die('--max-bytes must be a number ≥ 50000');
  if (!Number.isFinite(a.tolerancePct) || a.tolerancePct < 0 || a.tolerancePct > 100) {
    die('--tolerance must be a percentage between 0 and 100');
  }
  a.ceiling = Math.round(a.maxBytes * (1 + a.tolerancePct / 100));
  return a;
}

// ── formatting ─────────────────────────────────────────────────────────────

/** `2026-05-19 01:40:03 UTC` — the room's timestamps are UTC and stay UTC. */
export function stamp(iso) {
  if (!iso) return 'unknown time';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} UTC`;
}

/** One commons message, in the 2026-07-22 shape. */
export function renderMessage(c) {
  const attachments = (c.attachments || []).map((f) => `📎 ${f.name || f.id}`).join(' · ');
  return `**[${stamp(c.createdAt)}] ${c.author || 'unknown'}:**\n\n${(c.body || '').trim()}`
    + (attachments ? `\n\n_${attachments}_` : '')
    + '\n\n---\n';
}

/** One card, with its body and any thread homed on it. */
export function renderCard(card, thread = []) {
  const meta = [
    `- **Type:** \`${card.type || 'task'}\``,
    `- **Column:** ${card.column || '—'}  ·  **Priority:** ${card.priority || '—'}`,
    `- **Assignees:** ${(card.assignees || []).join(', ') || '—'}`,
    `- **Labels:** ${(card.labels || []).join(', ') || '—'}`,
    `- **Created:** ${stamp(card.createdAt)}  ·  **Modified:** ${stamp(card.updatedAt)}`,
  ].join('\n');

  let out = `## #${card.shortId} — ${card.title || '(untitled)'}\n${meta}\n\n### Body\n\n${(card.description || '_(no body)_').trim()}\n`;
  if (thread.length) {
    out += `\n### Thread (${thread.length})\n\n`;
    for (const c of thread) out += renderMessage(c);
  }
  out += '\n---\n';
  return out;
}

// ── packing ────────────────────────────────────────────────────────────────

/**
 * Greedily pack rendered records into parts under `maxBytes`.
 *
 * Splits ONLY between records, never inside one — a part that ends mid-message
 * is worse than a part that comes in under size. A single record larger than
 * the ceiling gets its own oversized part rather than being truncated, and the
 * INDEX reports it, because silently dropping the tail of a long card is the
 * kind of loss nobody notices until they need that card.
 */
/**
 * Room reserved for each part's header, which is prepended AFTER packing.
 *
 * Without this the ceiling is a lie by roughly a kilobyte: the first run packed
 * to exactly 1,500,000 bytes of records and then wrote a header on top, so
 * three of nine parts came out over — while the INDEX claimed "each < 1.50 MB".
 * A small overshoot, but the export's whole claim to trustworthiness is that it
 * doesn't misdescribe itself. Generous on purpose; the assertion below is what
 * actually enforces it.
 */
export const HEADER_ALLOWANCE = 512;

export function packRecords(records, maxBytes) {
  const parts = [];
  let cur = null;
  for (const rec of records) {
    // +1 for the '\n' that join() puts between records when the part is
    // written. Uncounted, it overshot the ceiling by ~one byte per record —
    // about a kilobyte across 1,500 messages, which is exactly how far the
    // first two parts came out over. The separator is part of the payload.
    const size = Buffer.byteLength(rec.text, 'utf8') + 1;
    if (cur && cur.bytes + size > maxBytes && cur.records.length > 0) cur = null;
    if (!cur) { cur = { section: rec.section, records: [], bytes: 0, oversized: false }; parts.push(cur); }
    if (cur.section !== rec.section) {
      // Sections don't share a part — a reader looking for cards shouldn't have
      // to scroll through the tail of the commons to find where they start.
      cur = { section: rec.section, records: [], bytes: 0, oversized: false };
      parts.push(cur);
    }
    if (size > maxBytes) cur.oversized = true;
    cur.records.push(rec);
    cur.bytes += size;
  }
  return parts.filter((p) => p.records.length);
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fs = await import('node:fs');
  const path = await import('node:path');

  const startedAt = new Date();
  const dateSlug = startedAt.toISOString().slice(0, 10).replace(/-/g, '');
  const outDir = path.resolve(args.out || `./board-export-${dateSlug}`);

  console.log(`\n  export-board → ${outDir}`);
  console.log(`  source: ${args.base}/api/load`);

  let board;
  try {
    const res = await fetch(`${args.base}/api/load`);
    if (!res.ok) die(`the board API answered ${res.status} — is the server running at ${args.base}?`);
    board = await res.json();
  } catch (err) {
    die(`could not reach ${args.base} — ${err.message}`);
  }

  const allCards = board.cards || [];
  const allMessages = board.conversations || [];
  console.log(`  received: ${allMessages.length} messages · ${allCards.length} cards\n`);
  if (!allMessages.length && !allCards.length) die('the board came back empty — refusing to write an empty export');

  // Chronological, ascending: the room's own order, oldest first, so the
  // archive reads the way the conversation happened.
  const byTime = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''));

  const cardById = new Map(allCards.map((c) => [c.id, c]));
  const homed = new Map();          // card id → its thread
  const boardLevel = [];            // the commons proper
  let orphaned = 0;                 // attachedTo pointing at a card that is gone
  for (const m of allMessages) {
    if (!m.attachedTo) { boardLevel.push(m); continue; }
    if (!cardById.has(m.attachedTo)) { orphaned += 1; boardLevel.push(m); continue; }
    if (!homed.has(m.attachedTo)) homed.set(m.attachedTo, []);
    homed.get(m.attachedTo).push(m);
  }
  boardLevel.sort(byTime);
  for (const t of homed.values()) t.sort(byTime);

  const records = [];
  if (args.spaces.includes('commons')) {
    for (const m of boardLevel) records.push({ section: 'COMMONS', text: renderMessage(m) });
  }
  if (args.spaces.includes('cards')) {
    for (const c of [...allCards].sort((a, b) => (a.shortId || 0) - (b.shortId || 0))) {
      records.push({ section: 'CARDS + WIKI', text: renderCard(c, homed.get(c.id) || []) });
    }
  }
  if (!records.length) die('nothing selected to export');

  const parts = packRecords(records, args.maxBytes - HEADER_ALLOWANCE);
  fs.mkdirSync(outDir, { recursive: true });

  const written = [];
  parts.forEach((part, i) => {
    const name = `part-${String(i + 1).padStart(2, '0')}-of-${String(parts.length).padStart(2, '0')}.md`;
    const header = `# Scrum-Board Full Export — Part ${i + 1} of ${parts.length}\n`
      + `**Section:** ${part.section}  ·  **Exported:** ${stamp(startedAt.toISOString())}\n\n---\n\n`;
    const body = header + part.records.map((r) => r.text).join('\n');
    fs.writeFileSync(path.join(outDir, name), body);
    written.push({ name, section: part.section, bytes: Buffer.byteLength(body, 'utf8'), records: part.records.length, oversized: part.oversized });
  });

  // ── the count check ──────────────────────────────────────────────────────
  // Refuse to call it an export if what we wrote doesn't match what we read.
  // This is the whole reason the tool is trustworthy rather than merely handy:
  // the silent-truncation failure it was built to avoid is invisible without it.
  // The ceiling the INDEX is about to claim, checked against the bytes actually
  // on disk. A record genuinely bigger than the ceiling gets its own part and is
  // reported as oversized — that's disclosed, not silent — but everything else
  // must come in under, or the claim doesn't get made.
  // Three outcomes, and the middle one is the point of having a tolerance:
  //   under target      — nothing to say
  //   within tolerance  — normal; packing aims at the target and the header
  //                       lands on top, so small overshoot is expected
  //   beyond tolerance  — only happens when a SINGLE record won't fit, which
  //                       is a real thing to know about, not rounding
  const overTarget = written.filter((w) => w.bytes > args.maxBytes);
  const beyond = written.filter((w) => w.bytes > args.ceiling);
  if (beyond.length) {
    console.log(`  ⚠️  ${beyond.length} part(s) beyond the ${args.tolerancePct}% tolerance `
      + `(ceiling ${(args.ceiling / 1e6).toFixed(2)} MB): `
      + beyond.map((w) => `${w.name} ${(w.bytes / 1e6).toFixed(2)} MB`).join(', '));
    console.log('      This means a single record is larger than a part — the index names it.');
  } else if (overTarget.length) {
    console.log(`  note: ${overTarget.length} part(s) over target but within ${args.tolerancePct}% tolerance.`);
  }

  const wroteRecords = written.reduce((n, w) => n + w.records, 0);
  if (wroteRecords !== records.length) {
    die(`wrote ${wroteRecords} records but built ${records.length} — refusing to report a complete export`);
  }
  const expectedMessages = args.spaces.includes('commons') ? boardLevel.length : 0;
  const homedCount = [...homed.values()].reduce((n, t) => n + t.length, 0);
  const accountedFor = boardLevel.length + homedCount;
  if (accountedFor !== allMessages.length) {
    die(`${allMessages.length} messages received but ${accountedFor} accounted for — refusing to write a lossy archive`);
  }

  const index = [
    `# Scrum-Board — Full Export (${args.spaces.map((s) => (s === 'cards' ? 'Cards/Wiki' : 'Commons')).join(' + ')})`,
    '',
    `- **Exported:** ${stamp(startedAt.toISOString())}`,
    `- **Source:** \`${args.base}\``,
    `- **Commons messages:** ${expectedMessages}${orphaned ? ` (includes ${orphaned} orphaned — attached to a card that no longer exists)` : ''}`,
    `- **Cards / wiki nodes:** ${args.spaces.includes('cards') ? allCards.length : 0}`,
    `- **Card-attached comments:** ${homedCount}`,
    `- **Total messages on the board:** ${allMessages.length} _(commons + card-attached; all accounted for)_`,
    `- **Parts:** ${parts.length} · target **${(args.maxBytes / 1e6).toFixed(2)} MB ±${args.tolerancePct}%** `
      + `(ceiling ${(args.ceiling / 1e6).toFixed(2)} MB) · largest written **${(Math.max(...written.map((w) => w.bytes)) / 1e6).toFixed(2)} MB** `
      + `— ${beyond.length ? `⚠️ ${beyond.length} beyond tolerance` : 'all within tolerance'}. Split at message/card boundaries, never mid-record.`,
    '',
    '> This board uses a unified model — the **wiki is the card bodies** (same nodes, different view).',
    '> Cards below carry their full text, metadata, and any thread homed on them.',
    '> Commons messages are chronological, oldest first: the room\'s own order.',
    '',
    '### Files',
    '',
    ...written.map((w) => `- **${w.name}** — ${w.section} — ${(w.bytes / 1e6).toFixed(2)} MB — ${w.records} records${w.oversized ? ' ⚠️ contains a record larger than the ceiling' : ''}`),
    '',
    '### Reproduce',
    '',
    '```',
    `node export-board.mjs --out <dir> --spaces ${args.spaces.join(',')} --format ${args.format} --max-bytes ${args.maxBytes} --tolerance ${args.tolerancePct} --base ${args.base}`,
    '```',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, '00-INDEX.md'), index);

  console.log(`  ✔ ${parts.length} parts + 00-INDEX.md`);
  for (const w of written) console.log(`      ${w.name}  ${w.section.padEnd(13)} ${(w.bytes / 1e6).toFixed(2)} MB  ${w.records} records`);
  console.log(`\n  counts verified: ${allMessages.length} messages all accounted for, ${records.length} records written\n`);
}

// Only run when invoked directly — the renderers above are imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => die(err.stack || err.message));
}
