// #1648 test helper: a separate PROCESS that takes the attachment fence through capture() and then holds it, so a row can
// kill it (F3a) or see a live owner it must not steal from (F3b). Usage:
//   node attachment-capture-child-1648.mjs <attachmentsDir> <outDir> <markerFile>
// It writes <markerFile> once capture() is paused inside its `copy` step, i.e. while the fence is held, and then waits forever.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [attachmentsDir, outDir, marker] = process.argv.slice(2);
const { capture } = await import(path.join(REPO, 'core', 'attachment-capture.mjs'));
const executor = {
  async snapshot() { return { id: 'child-snapshot' }; },
  async references() { return []; },
};
await capture({
  attachmentsDir, outDir, executor, waitMs: 5000,
  hooks: {
    async before(step) {
      if (step !== 'copy') return;
      fs.writeFileSync(marker, String(process.pid));
      setInterval(() => {}, 1000);   // keep the event loop alive: a bare never-settling promise lets node exit on an unsettled top-level await
      await new Promise(() => {});
    },
  },
});
