/**
 * #1648 — TEST-ONLY fault injection for tests/record-files-gaps-1648.test.mjs (G-C): "release with someone else's lock in place".
 * Loaded with NODE_OPTIONS=--import into the backup job. Inert unless RFB_LOCK_SWAP_FOREIGN is set.
 *
 * The moment the job creates its working set (a mkdir of DEST/records-*.partial) it has, by contract, already acquired DEST/.records.lock.
 * At that moment this hook REPLACES the lock's content with a foreign owner's record, as if another process had taken it over. The row then
 * asserts that the job's release left that foreign lock exactly as it was. The foreign record copies the job's own record's shape (JSON with a
 * different nonce and pid, or a bare pid) so a build cannot pass the row merely by failing to parse it.
 */
import fs from 'node:fs';
import path from 'node:path';

const FOREIGN_PID = process.env.RFB_LOCK_SWAP_FOREIGN;
if (FOREIGN_PID) {
  const realMkdir = fs.mkdirSync;
  let done = false;
  fs.mkdirSync = function patched(p, ...rest) {
    const out = realMkdir.call(this, p, ...rest);
    if (!done && typeof p === 'string' && /records-[^/]*\.partial$/.test(p)) {
      const lock = path.join(path.dirname(p), '.records.lock');
      try {
        const mine = fs.readFileSync(lock, 'utf8');
        let foreign;
        try {
          const j = JSON.parse(mine);
          foreign = typeof j === 'object' && j ? JSON.stringify({ ...j, pid: Number(FOREIGN_PID), nonce: 'foreign-owner-nonce', owner: 'another process' }) : String(FOREIGN_PID);
        } catch { foreign = String(FOREIGN_PID); }
        fs.writeFileSync(lock, foreign);
        fs.writeFileSync(`${lock}.swapped-by-test`, foreign);   // what was written, for the row to compare
        done = true;
      } catch { /* no lock file: the row's precondition reports it */ }
    }
    return out;
  };
}
