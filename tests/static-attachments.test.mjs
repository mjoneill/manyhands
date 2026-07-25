/**
 * #251 — attachments must be readable ONLY through the hardened
 * /api/attachments/:id route (nosniff + forced download for non-images). The
 * static-file fallthrough (/attachments/<id>) sets Content-Type from the file
 * extension with no such hardening — a latent stored-XSS read path. The static
 * server now refuses the /attachments/ subtree outright.
 *
 * Uses a controlled staticDir whose tree DOES contain attachments/<file>, so
 * the test exercises the real fix (the default harness keeps attachments outside
 * the static root, which would pass trivially).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRestServer } from './helpers/harness.mjs';

test('#251 the /attachments/ static subtree is refused (forced through the hardened API route)', async () => {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-static-'));
  fs.mkdirSync(path.join(staticDir, 'attachments'));
  // An HTML file under attachments/ would, via the static route, be served as
  // text/html with no nosniff — i.e. executable in the board origin.
  fs.writeFileSync(path.join(staticDir, 'attachments', 'evil.html'), '<script>document.title="xss"</script>');
  fs.writeFileSync(path.join(staticDir, 'hello.txt'), 'hi');

  const server = await startRestServer({ staticDir });
  try {
    const viaStatic = await fetch(`${server.baseUrl}/attachments/evil.html`);
    assert.equal(viaStatic.status, 404, 'the static attachments subtree is blocked');

    // A normal static file is still served (the block is scoped to attachments/).
    const normal = await fetch(`${server.baseUrl}/hello.txt`);
    assert.equal(normal.status, 200, 'non-attachment static files still serve');
    assert.equal((await normal.text()).trim(), 'hi');
  } finally {
    await server.stop();
    fs.rmSync(staticDir, { recursive: true, force: true });
  }
});
