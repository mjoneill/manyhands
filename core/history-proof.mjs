/**
 * #1762 S4 v1.6–v1.6.3 — the history coverage proof: an RFC 6962 Merkle tree over the canonical seq-nodes ≤ F.logSeq,
 * committed in F. Pure functions only (no I/O); the lane reader supplies the stored hashes it reads.
 *
 *   leaf   = SHA-256(0x00 ‖ data)      data = LP("hist-v1") ‖ LP(N) ‖ LP(prov:used IRI) ‖ LP(scrum:op) ‖ LP(scrum:entityKind)
 *   node   = SHA-256(0x01 ‖ left ‖ right)                over RAW 32-byte digests
 *   LP(x)  = a 4-byte big-endian byte length, then x's UTF-8 bytes
 *   commitment = SHA-256(0x02 ‖ LP(format) ‖ LP(epoch) ‖ LP(incarnation) ‖ LP(logSeq) ‖ LP(F.commitSeq) ‖ LP(L) ‖ LP(tree IRI) ‖ LP(root))
 *                with integers in base 10 (no leading zeros), the incarnation as lowercase 32 hex, the root as lowercase 64 hex
 *
 * F's root is the trusted anchor. Every stored hash is untrusted INPUT: a leaf is always recomputed from a tuple, and a proof
 * consumes only the sibling subtree hashes on its own path, so an unused corrupted cache entry cannot refuse a sound proof.
 */
import { createHash } from 'node:crypto';

export const HISTORY_FORMAT = 'hist-v1';
const sha = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
const lp = (s) => { const b = Buffer.from(String(s), 'utf8'); const n = Buffer.alloc(4); n.writeUInt32BE(b.length); return Buffer.concat([n, b]); };
const hex = (b) => b.toString('hex');
const unhex = (s) => (typeof s === 'string' && /^[0-9a-f]{64}$/.test(s) ? Buffer.from(s, 'hex') : null);

/** the leaf hash (raw) of one canonical tuple */
export function leafHash({ N, used, op, kind }) {
  return sha(Buffer.from([0x00]), lp(HISTORY_FORMAT), lp(String(N)), lp(used), lp(op), lp(kind));
}
export const nodeHash = (left, right) => sha(Buffer.from([0x01]), left, right);

/** RFC 6962: the largest power of two strictly less than n (n ≥ 2) */
export const splitPoint = (n) => { let k = 1; while (k * 2 < n) k *= 2; return k; };

/** F's commitment (hex) over every advertised binding, in the pinned order and encoding */
export function historyCommitment({ format, epoch, incarnation, logSeq, commitSeq, leafCount, tree, root }) {
  return hex(sha(Buffer.from([0x02]), lp(format), lp(String(epoch)), lp(String(incarnation).replace(/-/g, '').toLowerCase()),
    lp(String(logSeq)), lp(String(commitSeq)), lp(String(leafCount)), lp(tree), lp(root)));
}

/**
 * The subtree ranges a proof of leaf `i` in a tree of `n` leaves CONSUMES (RFC 6962 audit path), as half-open [start, end).
 * A size-1 range is a leaf entry; anything larger is a stored internal subtree node.
 */
export function auditRanges(i, n, start = 0) {
  if (n <= 1) return [];
  const k = splitPoint(n);
  return i < k
    ? [...auditRanges(i, k, start), [start + k, start + n]]
    : [...auditRanges(i - k, n - k, start + k), [start, start + k]];
}

/**
 * Recompute the root from a leaf hash at index `i` and the stored hashes of the ranges its audit path consumes.
 * `siblingHash([start, end])` returns a raw digest or null (a missing or malformed stored hash). Returns the root (raw), or null.
 */
export function rootFromLeaf(i, n, leaf, siblingHash, start = 0) {
  if (n === 1) return leaf;
  const k = splitPoint(n);
  if (i < k) {
    const left = rootFromLeaf(i, k, leaf, siblingHash, start);
    const right = siblingHash([start + k, start + n]);
    return left && right ? nodeHash(left, right) : null;
  }
  const right = rootFromLeaf(i - k, n - k, leaf, siblingHash, start + k);
  const left = siblingHash([start, start + k]);
  return left && right ? nodeHash(left, right) : null;
}

/** true iff the tuple at rank `i` is a committed leaf of the tree with root `rootHex` and `n` leaves */
export function verifiesAt(i, n, tuple, rootHex, siblingHash) {
  const root = unhex(rootHex);
  if (!root || !Number.isSafeInteger(i) || i < 0 || i >= n) return false;
  const got = rootFromLeaf(i, n, leafHash(tuple), (r) => unhex(siblingHash(r)));
  return !!got && got.equals(root);
}
