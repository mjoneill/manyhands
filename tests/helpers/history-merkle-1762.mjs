/**
 * #1762 S4 v1.6 / v1.6.1 — an INDEPENDENT reference for the history tree's hashes, written by the row author from the contract text on #1762 and imported by nothing in the product.
 *
 *   leaf data  = LP("hist-v1") ‖ LP(N, base 10) ‖ LP(prov:used IRI) ‖ LP(scrum:op) ‖ LP(scrum:entityKind)          LP(x) = 4-byte big-endian byte length ‖ UTF-8 bytes of x
 *   leaf       = SHA-256(0x00 ‖ data)                 node = SHA-256(0x01 ‖ left ‖ right)            over raw 32-byte digests; RFC 6962's split rule (k = the largest power of 2 below n)
 *   commitment = SHA-256(0x02 ‖ LP(format) ‖ LP(epoch) ‖ LP(incarnation, 32 lowercase hex) ‖ LP(logSeq) ‖ LP(F.commitSeq) ‖ LP(L) ‖ LP(tree graph IRI) ‖ LP(root, 64 lowercase hex))
 *   stored and wire form of every digest: lowercase hex.
 *
 * Nothing here is RFC 6962's published test data: the vectors the rows pin are computed from THIS text (and re-computed in another language, see the vectors file).
 */
import crypto from 'node:crypto';

const sha = (...parts) => { const h = crypto.createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
export const LP = (x) => { const b = Buffer.from(String(x), 'utf8'); const n = Buffer.alloc(4); n.writeUInt32BE(b.length); return Buffer.concat([n, b]); };

export const FORMAT = 'hist-v1';
/** the canonical preimage of one leaf */
export const leafData = ({ N, used, op, entityKind }) => Buffer.concat([LP(FORMAT), LP(String(N)), LP(used), LP(op), LP(entityKind)]);
export const leafHash = (entry) => sha(Buffer.from([0x00]), leafData(entry));
export const nodeHash = (l, r) => sha(Buffer.from([0x01]), l, r);
const splitAt = (n) => { let k = 1; while (k * 2 < n) k *= 2; return k; };       // the largest power of two strictly below n (n > 1)
/** the Merkle tree hash of leaf hashes (raw digests); L = 0 has no tree: S6 refuses to establish F over an empty history */
export function mth(leaves) {
  if (!leaves.length) throw new Error('an empty history has no tree');
  if (leaves.length === 1) return leaves[0];
  const k = splitAt(leaves.length);
  return nodeHash(mth(leaves.slice(0, k)), mth(leaves.slice(k)));
}
/** RFC 6962 audit path for leaf `i` of `leaves`: the sibling hashes, deepest first */
export function auditPath(leaves, i) {
  if (leaves.length === 1) return [];
  const k = splitAt(leaves.length);
  return i < k ? [...auditPath(leaves.slice(0, k), i), mth(leaves.slice(k))] : [...auditPath(leaves.slice(k), i - k), mth(leaves.slice(0, k))];
}
/** the root a leaf hash, its rank, the leaf count and an audit path imply (RFC 6962 section 2.1.1's verification, written recursively here) */
export function rootFromPath(leaf, i, n, path) {
  if (n === 1) { if (path.length) throw new Error('a path for a one-leaf tree must be empty'); return leaf; }
  if (!path.length) throw new Error('the path is too short');
  const k = splitAt(n); const sibling = path.at(-1); const rest = path.slice(0, -1);
  return i < k ? nodeHash(rootFromPath(leaf, i, k, rest), sibling) : nodeHash(sibling, rootFromPath(leaf, i - k, n - k, rest));
}
export const hex = (b) => b.toString('hex');
export const commitment = ({ epoch, incarnation, logSeq, commitSeq, L, tree, root, format = FORMAT }) => hex(sha(Buffer.from([0x02]), LP(format), LP(epoch), LP(incarnation), LP(logSeq), LP(commitSeq), LP(L), LP(tree), LP(root)));
/** build a whole tree from entries (ascending, unique N): leaves, root */
export function build(entries) {
  for (let i = 1; i < entries.length; i++) if (!(entries[i].N > entries[i - 1].N)) throw new Error('N must be strictly increasing');
  const leaves = entries.map(leafHash);
  return { leaves, root: hex(mth(leaves)), L: leaves.length };
}
