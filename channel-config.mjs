/**
 * channel-config.mjs — persisted, validated config for channel delivery
 * (#263). The settings page (via REST :3141) WRITES it; the scheduler (in the
 * MCP server :3001) READS it fresh on every dispatch — so a saved change applies
 * with no restart. Decoupled across the two processes by a shared JSON file
 * (atomic write via tmp+rename, so a read never sees a half-written file).
 *
 * This is a node module (does file I/O); the pure scheduling logic lives in
 * core/channel-scheduler.mjs and is handed the values via a getConfig() getter.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_CONFIG = {
  mode: 'soft', // 'soft' (#265) | 'hard' (#266) | 'off' | 'token-ring' (#410, ring/lease)
  soft: { minMs: 30000, maxMs: 60000 },
  hard: { timeoutMs: 300000 },
  tokenRing: { timeoutMs: 300000 }, // #410 — lease TTL (dead-seat recovery TIMEOUT)
};

// Sane bounds so a bad save can't wedge delivery (e.g. a 9-hour timeout).
const SOFT_CEIL_MS = 300000; // 5 min
const HARD_MIN_MS = 30000; // 30 s
const HARD_MAX_MS = 1800000; // 30 min
// #410 — the token-ring lease TTL must comfortably EXCEED the presence-side cognition
// debounce (~60s observed) so a live holder isn't reaped before its model even
// wakes. 90s floor keeps margin; refine once Increment-2 proves the exact
// lease-vs-debounce relationship against real invocation logs.
const TOKEN_RING_MIN_MS = 90000; // 90 s
const TOKEN_RING_MAX_MS = 1800000; // 30 min

/**
 * #737 — the bounds, published rather than private.
 *
 * The settings page presents every one of these fields in SECONDS and converts
 * on save, so a rejection quoting raw milliseconds reads as nonsense: typing
 * 360 into a seconds field and being told the limit is 300000 offers no way to
 * work out that the ceiling is 300. The editor has to be able to say the bound
 * in the units it asked for.
 *
 * Exported instead of duplicated in the UI, because a copied `300` is a second
 * place holding one fact and it drifts the first time this ceiling moves. These
 * are the SAME constants validateConfig enforces below — the advertised bound
 * cannot disagree with the enforced one, and a test asserts exactly that.
 */
export const LIMITS = {
  soft: { minMs: 0, maxMs: SOFT_CEIL_MS },
  hard: { minMs: HARD_MIN_MS, maxMs: HARD_MAX_MS },
  tokenRing: { minMs: TOKEN_RING_MIN_MS, maxMs: TOKEN_RING_MAX_MS },
};

/** The config file path, resolved per-call so SCRUM_CHANNEL_CONFIG_FILE (tests) works at runtime. */
export function configFilePath() {
  return process.env.SCRUM_CHANNEL_CONFIG_FILE || path.join(__dirname, 'channel-config.json');
}

/** Validate + normalize an incoming config; throws Error(message) on anything out of bounds. */
export function validateConfig(input) {
  if (!input || typeof input !== 'object') throw new Error('config must be an object');
  const mode = input.mode;
  if (!['soft', 'hard', 'off', 'token-ring'].includes(mode)) throw new Error('mode must be one of: soft, hard, off, token-ring');

  const soft = input.soft && typeof input.soft === 'object' ? input.soft : DEFAULT_CONFIG.soft;
  const hard = input.hard && typeof input.hard === 'object' ? input.hard : DEFAULT_CONFIG.hard;
  const tokenRing = input.tokenRing && typeof input.tokenRing === 'object' ? input.tokenRing : DEFAULT_CONFIG.tokenRing;
  const minMs = Number(soft.minMs);
  const maxMs = Number(soft.maxMs);
  const timeoutMs = Number(hard.timeoutMs);
  const tokenRingTimeoutMs = Number(tokenRing.timeoutMs);

  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) throw new Error('soft.minMs and soft.maxMs must be numbers');
  if (minMs < 0 || maxMs < minMs || maxMs > SOFT_CEIL_MS) {
    throw new Error(`soft window must satisfy 0 <= minMs <= maxMs <= ${SOFT_CEIL_MS}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < HARD_MIN_MS || timeoutMs > HARD_MAX_MS) {
    throw new Error(`hard.timeoutMs must be between ${HARD_MIN_MS} and ${HARD_MAX_MS}`);
  }
  if (!Number.isFinite(tokenRingTimeoutMs) || tokenRingTimeoutMs < TOKEN_RING_MIN_MS || tokenRingTimeoutMs > TOKEN_RING_MAX_MS) {
    throw new Error(`token-ring.timeoutMs must be between ${TOKEN_RING_MIN_MS} and ${TOKEN_RING_MAX_MS}`);
  }
  return { mode, soft: { minMs, maxMs }, hard: { timeoutMs }, tokenRing: { timeoutMs: tokenRingTimeoutMs } };
}

/** Read the current config; always returns a valid object (missing/corrupt → defaults). */
export function readConfig(file = configFilePath()) {
  try {
    return validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Validate + persist (atomically). Returns the clean config; throws on invalid input. */
export function writeConfig(input, file = configFilePath()) {
  const clean = validateConfig(input);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
  fs.renameSync(tmp, file);
  return clean;
}
