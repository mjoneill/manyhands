/**
 * #1762 S4 v1.6 / v1.6.1 — the pinned test vectors and the properties of the history tree's hashes (ROW AUTHOR; no product code is imported).
 *
 *   MV1  the three vectors (L = 1, 2, 5) and the commitment vector are what the contract text yields, computed in JS and again, independently, in Python (hashlib), and equal to the hex pinned below
 *   MV2  every leaf of every tree of 1..12 leaves has an audit path that recomputes the root; a wrong rank, a wrong L, a rewritten sibling or a rewritten leaf does not
 *   MV3  the preimage is unambiguous: field boundaries matter (the same bytes split differently hash differently), the length is in BYTES, and every field changes the leaf
 *   MV4  the commitment binds EVERY field of v1.6.1 P2, including the tree graph IRI and F.commitSeq (the two v1.6 claimed to bind and did not)
 *
 * The implementation's own hashing is checked against these by the rows that need a certified store (they build their trees with this reference); whether the product
 * exposes a function for the hashes is not pinned, so no row calls one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as M from './helpers/history-merkle-1762.mjs';

const A = 'https://scrumboard.local/entity/uuid-a', B = 'https://scrumboard.local/entity/uuid-b', E = 'https://scrumboard.local/entity/uuid-é';
const T1 = [{ N: 1, used: A, op: 'create', entityKind: 'card' }];
const T2 = [...T1, { N: 2, used: A, op: 'update', entityKind: 'card' }];
const T5 = [...T2, { N: 5, used: B, op: 'create', entityKind: 'card' }, { N: 6, used: E, op: 'post', entityKind: 'conversation' }, { N: 9, used: B, op: 'delete', entityKind: 'card' }];
export const VECTORS = {
  L1: '17649e915fc455becb807eb4ea7e5d0c715e3ea42daae59008d157f55eb322b1',
  L2: '931697e7ba7cd6fc6e15d4ff5137aaee5dbbc767ce6f316d1fb414b2f4bd4096',
  L5: '2906ccc25d47f9d08c9cc609fb6e1fc7af6bf3791ba4a8054d1da86348985ce2',
  commitment: '923994b63406599f071f47e58c8cf892c957094259e5cad7f432ac8ca87af006',
};
const F = { epoch: 3, incarnation: '0123456789abcdef0123456789abcdef', logSeq: 9, commitSeq: 42, L: 5, tree: 'urn:scrum:history-tree:build-1' };

const PY = String.raw`
import hashlib, json, struct, sys
def lp(x):
    b = str(x).encode('utf-8'); return struct.pack('>I', len(b)) + b
def leaf(e):
    data = lp('hist-v1') + lp(e['N']) + lp(e['used']) + lp(e['op']) + lp(e['entityKind'])
    return hashlib.sha256(b'\x00' + data).digest()
def mth(ls):
    n = len(ls)
    if n == 1: return ls[0]
    k = 1 << ((n - 1).bit_length() - 1)          # the largest power of two strictly below n
    return hashlib.sha256(b'\x01' + mth(ls[:k]) + mth(ls[k:])).digest()
def commit(f, root):
    return hashlib.sha256(b'\x02' + lp('hist-v1') + lp(f['epoch']) + lp(f['incarnation']) + lp(f['logSeq']) + lp(f['commitSeq']) + lp(f['L']) + lp(f['tree']) + lp(root)).hexdigest()
d = json.load(sys.stdin)
out = {k: mth([leaf(e) for e in t]).hex() for k, t in d['trees'].items()}
out['commitment'] = commit(d['F'], out['L5'])
print(json.dumps(out))
`;

test('#1762 S4 MV1 — the L = 1, 2, 5 vectors and the commitment vector: JS, an independent Python computation and the pinned hex all agree', () => {
  const js = { L1: M.build(T1).root, L2: M.build(T2).root, L5: M.build(T5).root };
  js.commitment = M.commitment({ ...F, root: js.L5 });
  const r = spawnSync('python3', ['-I', '-c', PY], { input: JSON.stringify({ trees: { L1: T1, L2: T2, L5: T5 }, F }), encoding: 'utf8' });
  assert.equal(r.status, 0, `PRECONDITION: python3 ran (${r.stderr.slice(0, 300)})`);
  assert.deepEqual(JSON.parse(r.stdout), js, 'the two implementations of the contract text agree');
  assert.deepEqual(js, VECTORS, 'and equal the vectors pinned in this file');
  assert.equal(new Set(Object.values(VECTORS)).size, 4, 'four different values');
});

test('#1762 S4 MV2 — every leaf of every tree of 1..12 leaves has an audit path that recomputes the root; a wrong rank, a wrong L, a rewritten sibling or a rewritten leaf does not', () => {
  for (let L = 1; L <= 12; L++) {
    const entries = Array.from({ length: L }, (_, i) => ({ N: 2 * i + 1, used: `${A}-${i}`, op: 'update', entityKind: 'card' }));
    const leaves = entries.map(M.leafHash); const root = M.mth(leaves);
    for (let i = 0; i < L; i++) {
      const path = M.auditPath(leaves, i);
      assert.deepEqual(M.rootFromPath(leaves[i], i, L, path), root, `L=${L} i=${i}: the path recomputes the root`);
      if (L > 1) {
        assert.notDeepEqual(M.rootFromPath(M.leafHash({ ...entries[i], N: entries[i].N + 1 }), i, L, path), root, `L=${L} i=${i}: a rewritten leaf does not`);
        const bad = path.map((p, j) => (j === 0 ? Buffer.from(p.map((x) => x ^ 1)) : p));
        assert.notDeepEqual(M.rootFromPath(leaves[i], i, L, bad), root, `L=${L} i=${i}: a rewritten sibling does not`);
      }
    }
    if (L > 2) assert.notDeepEqual(M.rootFromPath(leaves[0], 1, L, M.auditPath(leaves, 0)), root, `L=${L}: a wrong rank with a valid path does not recompute the root`);
  }
});

test('#1762 S4 MV3 — the preimage is unambiguous: field boundaries matter, lengths are in BYTES, and every field changes the leaf', () => {
  const base = { N: 7, used: 'ab', op: 'c', entityKind: 'd' };
  assert.notEqual(M.hex(M.leafHash(base)), M.hex(M.leafHash({ ...base, used: 'a', op: 'bc' })), 'the same characters split at another field boundary are another leaf');
  assert.deepEqual([...M.LP('é')], [0, 0, 0, 2, 0xc3, 0xa9], 'the length prefix counts UTF-8 bytes, not characters');
  for (const [k, v] of [['N', 8], ['used', 'x'], ['op', 'update'], ['entityKind', 'column']]) assert.notEqual(M.hex(M.leafHash({ ...base, [k]: v })), M.hex(M.leafHash(base)), `${k} changes the leaf`);
  assert.notEqual(M.hex(M.leafHash(base)), M.hex(M.nodeHash(M.leafHash(base), M.leafHash(base))), 'a leaf and a node never collide (the 0x00 / 0x01 prefixes)');
  assert.throws(() => M.mth([]), /empty/, 'L = 0 has no tree');
  assert.throws(() => M.build([{ ...base, N: 3 }, { ...base, N: 3 }]), /increasing/, 'N must be strictly increasing and unique');
});

test('#1762 S4 MV4 — the commitment binds EVERY field of P2: the format, the epoch, the incarnation, the logSeq, F.commitSeq, L, the tree graph IRI and the root', () => {
  const root = M.build(T5).root; const base = M.commitment({ ...F, root });
  const variants = {
    format: M.commitment({ ...F, root, format: 'hist-v2' }), epoch: M.commitment({ ...F, root, epoch: 4 }), incarnation: M.commitment({ ...F, root, incarnation: 'fedcba9876543210fedcba9876543210' }),
    logSeq: M.commitment({ ...F, root, logSeq: 10 }), commitSeq: M.commitment({ ...F, root, commitSeq: 43 }), L: M.commitment({ ...F, root, L: 6 }),
    tree: M.commitment({ ...F, root, tree: 'urn:scrum:history-tree:build-2' }), root: M.commitment({ ...F, root: M.build(T2).root }),
  };
  for (const [k, v] of Object.entries(variants)) assert.notEqual(v, base, `${k} is bound`);
  assert.equal(new Set([base, ...Object.values(variants)]).size, 9, 'and the nine values are all different');
  assert.equal(M.commitment({ ...F, root, logSeq: '9' }), base, 'integers are their base-10 text, so 9 and "9" are one input');
});
