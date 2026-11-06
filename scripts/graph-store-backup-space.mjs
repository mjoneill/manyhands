// #1634 C6: how many bytes a set of backup copies PHYSICALLY holds on APFS.
//
// `du` counts a clone twice. sha256 cannot tell a clone from an independent copy with the same
// content. APFS reports both facts per file through getattrlist(2) with FSOPT_ATTR_CMN_EXTENDED:
//   ATTR_CMNEXT_CLONEID     shared by whole-file clones; a write to either gives the writer a new id
//   ATTR_CMNEXT_PRIVATESIZE bytes no other file shares (0 for a whole-file clone with a live sibling)
// Measured 2026-11-06 on this volume: a cp -c pair shares one id with private 0; an independent copy
// has its own id with private == allocated; a clone partly rewritten gets a new id and 0 < private < allocated.
//
// Rule, per file (each inode once):
//   private == allocated  -> wholly private: count allocated.
//   private == 0          -> whole-file clone: count allocated ONCE per clone id in the set.
//   anything else         -> partly shared: count allocated in full and set exact:false. The figure is then
//                            CONSERVATIVE (never below the truth), because a partial share cannot be apportioned per file.
// The bytes are the SET's allocation. They are not volume free space: a Time Machine local snapshot or any
// reference outside the set can keep blocks allocated after this says they are not counted.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PY_ATTRS = `
import ctypes, struct, sys, json
libc = ctypes.CDLL('libc.dylib', use_errno=True)
class AL(ctypes.Structure):
    _fields_ = [('bitmapcount', ctypes.c_ushort), ('reserved', ctypes.c_ushort), ('common', ctypes.c_uint),
                ('vol', ctypes.c_uint), ('dir', ctypes.c_uint), ('file', ctypes.c_uint), ('fork', ctypes.c_uint)]
def attr(p, bit):
    al = AL(5, 0, 0, 0, 0, 0, bit); buf = ctypes.create_string_buffer(64)
    if libc.getattrlist(p.encode(), ctypes.byref(al), buf, 64, 0x1 | 0x20) != 0:
        raise OSError(ctypes.get_errno(), 'getattrlist failed', p)
    if struct.unpack_from('<I', buf, 0)[0] < 12: raise OSError(0, 'attribute not returned', p)
    return struct.unpack_from('<Q', buf, 4)[0]
out = {}
for p in json.load(sys.stdin):
    out[p] = {'cloneId': attr(p, 0x100), 'privateBytes': attr(p, 0x8)}
print(json.dumps(out))
`;

function filesUnder(p, acc) {
  let st;
  try { st = fs.lstatSync(p); } catch { return acc; }
  if (st.isDirectory()) for (const n of fs.readdirSync(p)) filesUnder(path.join(p, n), acc);
  else if (st.isFile()) acc.push({ p, st });
  return acc;
}

/** Physical bytes held by every regular file under `paths`, each shared extent counted once. Synchronous, so a
 *  synchronous caller (the monitor) carries a number, never a Promise. */
export function uniqueBytesSync(paths, { python = process.env.GRAPH_STORE_SPACE_PYTHON || '/usr/bin/python3' } = {}) {
  const seen = new Set();
  const files = [];
  for (const root of paths) for (const f of filesUnder(root, [])) {
    const key = `${f.st.dev}:${f.st.ino}`;
    if (seen.has(key)) continue;
    seen.add(key); files.push(f);
  }
  if (!files.length) return { bytes: 0, exact: true };
  const r = spawnSync(python, ['-I', '-c', PY_ATTRS], { input: JSON.stringify(files.map((f) => f.p)), encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`uniqueBytes: APFS attributes unreadable (rc ${r.status}): ${(r.stderr || '').trim().split('\n').pop()}`);
  const attrs = JSON.parse(r.stdout);
  let bytes = 0;
  let exact = true;
  const families = new Set();
  for (const f of files) {
    const alloc = f.st.blocks * 512;
    const { cloneId, privateBytes } = attrs[f.p];
    if (privateBytes >= alloc) bytes += alloc;
    else if (privateBytes === 0) {
      const fam = `${f.st.dev}:${cloneId}`;
      if (!families.has(fam)) { families.add(fam); bytes += alloc; }
    } else { bytes += alloc; exact = false; }
  }
  return { bytes, exact };
}

/** The same figure for async callers. */
export async function uniqueBytes(paths, opts = {}) { return uniqueBytesSync(paths, opts); }
