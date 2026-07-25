#!/usr/bin/env node
/**
 * scripts/migrate-to-jsonld.mjs (#227) — one-time, self-verifying, reversible
 * migration of a board-data file from the legacy `{cards, conversations, …}`
 * blob to schema.org-primary JSON-LD on disk.
 *
 *   node scripts/migrate-to-jsonld.mjs <board-data.json>
 *
 * - Idempotent: a no-op (exit 0) if the file is already JSON-LD.
 * - Reversible: backs up the legacy file to <file>.legacy.bak first.
 * - Self-verifying: re-reads the JSON-LD and projects it back to the legacy
 *   shape, asserting cards/conversations/columns/nextShortId/_README are
 *   byte-for-byte preserved. On ANY mismatch it RESTORES the backup and exits
 *   non-zero — it will not leave a partially-migrated file behind.
 * - lastUpdated is preserved (passed as the save stamp), so a successful
 *   migration changes ONLY the on-disk format, nothing observable.
 */

import { readFileSync, existsSync, copyFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { loadDomain, saveDomain } from '../core/store.mjs';
import { domainToBoard } from '../core/mapping.mjs';
import { isJsonLdDocument } from '../core/jsonld.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/migrate-to-jsonld.mjs <board-data.json>');
  process.exit(2);
}
if (!existsSync(file)) {
  console.error('no such file: ' + file);
  process.exit(2);
}

const legacy = JSON.parse(readFileSync(file, 'utf8'));
if (isJsonLdDocument(legacy)) {
  console.log('✓ already JSON-LD — nothing to migrate');
  process.exit(0);
}

const legacyCards = legacy.cards || [];
const legacyConvs = legacy.conversations || [];
const legacyCols = legacy.columns || [];
console.log(`legacy board: ${legacyCards.length} cards, ${legacyConvs.length} conversations, ${legacyCols.length} columns`);

const bak = file + '.legacy.bak';
copyFileSync(file, bak);
console.log('backup → ' + bak);

// Migrate: load (legacy) → save (JSON-LD). Keep lastUpdated as-is.
const domain = loadDomain(file);
saveDomain(file, domain, { now: legacy.lastUpdated || new Date().toISOString() });

// Verify: reload the JSON-LD, project back to the legacy shape, demand equality.
const back = domainToBoard(loadDomain(file));
try {
  assert.deepEqual(back.cards, legacyCards, 'cards');
  assert.deepEqual(back.conversations, legacyConvs, 'conversations');
  assert.deepEqual(back.columns, legacyCols, 'columns');
  assert.deepEqual(back.nextShortId, legacy.nextShortId, 'nextShortId');
  assert.deepEqual(back._README, legacy._README, '_README');
} catch (e) {
  console.error('✗ VERIFICATION FAILED — restoring the legacy file from backup');
  copyFileSync(bak, file);
  console.error(e.message);
  process.exit(1);
}

console.log(`✓ migrated + verified lossless: ${back.cards.length} cards, ${back.conversations.length} conversations, ${back.columns.length} columns preserved`);
console.log('  on-disk format is now schema.org JSON-LD (@graph + scrum:meta).');
