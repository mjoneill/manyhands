#!/usr/bin/env node
/**
 * export-wiki.mjs — publish a wiki node as a standalone HTML file (#459).
 *
 *   node export-wiki.mjs 12 --out ~/Desktop/architecture.html
 *   node export-wiki.mjs 12 --dry-run       # transform + check, emit nothing
 *
 * Why this exists as a build step rather than a careful manual pass: the room's
 * wiki keeps the room's real language, and adaptation for an outside reader
 * happens at this boundary. A manual pass can quietly widen its own scope — a
 * declared rule list in EXPORT_TRANSFORMS.json cannot, and the fail-closed
 * check below means "the scrub happened" is a property of the mechanism instead
 * of a claim by whoever ran it.
 *
 * Reads the LIVE node over the REST API (never board-data.json directly).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { transformForExport } from './core/export-transforms.mjs';
import { renderExportHtml } from './core/export-html.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = process.env.SCRUM_API || `http://127.0.0.1:${process.env.SCRUM_PORT || 3141}`;

const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };

/**
 * Where EXPORT_TRANSFORMS.json comes from when --config isn't given.
 *
 * The rule list describes the ROOM whose data is being exported — it is not a
 * property of the code doing the exporting. So it belongs beside the data.
 *
 * That distinction is invisible while code and data share a directory, and it
 * bites the moment they don't: run this script from a code checkout that is
 * separate from the board it's exporting, and `join(HERE, ...)` resolves to the
 * EXAMPLE rules shipped with the code — rules whose own README says they protect
 * nothing. The export then runs its fail-closed scrub check against the wrong
 * list and reports PASS. A silent leak that certifies itself.
 *
 * So: if SCRUM_BOARD_FILE is set, the data root is authoritative, and a missing
 * config there is a hard error rather than a quiet fallback to the examples.
 * If it is unset, code and data are colocated — a standalone install — and HERE
 * *is* the data root, so the shipped config is legitimately the operator's own.
 */
function defaultConfigPath() {
  const boardFile = process.env.SCRUM_BOARD_FILE;
  if (!boardFile) return join(HERE, 'EXPORT_TRANSFORMS.json');
  return join(dirname(resolve(boardFile)), 'EXPORT_TRANSFORMS.json');
}

function parseArgs(argv) {
  const args = { id: null, out: null, dryRun: false, config: defaultConfigPath() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--config') args.config = argv[++i];
    else if (!a.startsWith('-') && args.id === null) args.id = a;
    else die(`unrecognised argument: ${a}`);
  }
  if (!args.id) die('usage: node export-wiki.mjs <node-id> [--out FILE] [--dry-run]');
  if (!args.out && !args.dryRun) args.out = resolve(`wiki-${args.id}-export.html`);
  return args;
}

async function fetchNode(id) {
  let res;
  try {
    res = await fetch(`${API}/api/nodes/${id}`);
  } catch {
    die(`cannot reach the board API at ${API} — is server.js running?`);
  }
  if (!res.ok) die(`GET /api/nodes/${id} → HTTP ${res.status}`);
  const payload = await res.json();
  // GET returns {node, children, backlinks}; the content lives on node.text.
  const node = payload.node || payload;
  if (!node || typeof node.text !== 'string') die(`node ${id} has no text content`);
  return node;
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  let config;
  try {
    config = JSON.parse(readFileSync(args.config, 'utf8'));
  } catch (err) {
    // Fail closed. Falling back to another config here is exactly the leak this
    // resolution rule exists to prevent: an export that scrubs with the wrong
    // rule list and then certifies itself against it.
    //
    // But failing closed is only defensible if the way OUT is obvious. If your
    // data lives apart from this checkout — a supported, documented setup — the
    // first export you run lands here, and an error that only says "file not
    // found" turns a one-time setup step into a dead end. So say what to do.
    if (process.env.SCRUM_BOARD_FILE) {
      die(
        `no export transform config at ${args.config}\n\n` +
        `  The transform rules describe the BOARD being exported, so they are read from\n` +
        `  your data directory — the one holding the file in SCRUM_BOARD_FILE — and not\n` +
        `  from this checkout. That keeps one install's rules from silently scrubbing\n` +
        `  another install's export.\n\n` +
        `  Fix it either way:\n` +
        `    cp ${join(HERE, 'EXPORT_TRANSFORMS.json')} ${args.config}\n` +
        `  or point at one explicitly:\n` +
        `    node export-wiki.mjs <id> --config /path/to/EXPORT_TRANSFORMS.json\n\n` +
        `  (${err.message})`,
      );
    }
    die(`could not read transform config ${args.config}\n  resolved from the script directory (SCRUM_BOARD_FILE is unset)\n  ${err.message}`);
  }

  const node = await fetchNode(args.id);
  const title = node.name || `Node ${args.id}`;

  // Fail-closed: throws, loudly, if any forbidden term survived the rules.
  let scrubbed;
  try {
    scrubbed = transformForExport(node.text, config);
  } catch (err) {
    die(err.message);
  }

  const applied = (config.rules || []).filter((r) => {
    try { return new RegExp(r.find, r.flags || 'g').test(node.text); } catch { return false; }
  });

  const exportedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const digest = createHash('sha256').update(scrubbed).digest('hex').slice(0, 12);

  const html = renderExportHtml(scrubbed, {
    title,
    sourceLabel: `wiki #${node.identifier ?? args.id}`,
    exportedAt,
    digest,
    sourceModified: node.dateModified,
    note: 'Generated by export-wiki.mjs. Some in-house names are substituted at export; the source retains them.',
  });

  console.log(`\n  ${title}`);
  console.log(`  source        wiki #${node.identifier ?? args.id} (modified ${node.dateModified || 'unknown'})`);
  console.log(`  markdown      ${node.text.length.toLocaleString()} chars → html ${html.length.toLocaleString()} chars`);
  console.log(`  transforms    ${applied.length}/${(config.rules || []).length} rules matched:`);
  for (const r of applied) console.log(`                  ${r.find.slice(0, 58)}${r.find.length > 58 ? '…' : ''}`);
  console.log(`  scrub check   PASS — 0 of ${(config.forbidden || []).length} forbidden patterns present`);
  console.log(`  digest        ${digest}`);

  if (args.dryRun) { console.log('\n  --dry-run: nothing written.\n'); return; }

  writeFileSync(args.out, html, 'utf8');
  console.log(`  written       ${args.out}\n`);
};

main().catch((err) => die(err.stack || String(err)));
