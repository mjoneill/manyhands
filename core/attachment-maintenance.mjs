/**
 * core/attachment-maintenance.mjs — #1648: the ONE fenced delete writer for the attachments directory.
 *
 * It takes the attachment fence (core/attachment-fence.mjs), so a removal never lands inside a paired capture: it is held
 * until the capture releases, or refused with the fence's retryable ATTACHMENT_FENCE_BUSY error.
 *
 * It is deliberately reachable from NO route and NO tool (tests/attachments-fence-1648.test.mjs F6c): an operator's
 * maintenance script imports it by name. Exposing it is a decision of its own, not a side effect of wiring.
 */
import fs from 'node:fs';
import path from 'node:path';
import { withAttachmentFence, DEFAULT_WAIT_MS } from './attachment-fence.mjs';

const ID_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/;   // server.js ATTACHMENT_ID_RE: a file name, never a path

/** Remove one attachment by id. A name that is not an attachment id is refused before the fence is taken. */
export async function removeAttachment(attachmentsDir, id, { waitMs = DEFAULT_WAIT_MS } = {}) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`removeAttachment: ${JSON.stringify(id)} is not an attachment id`);
  return withAttachmentFence(async () => { fs.rmSync(path.join(attachmentsDir, id)); }, { attachmentsDir, waitMs, owner: `attachment removal ${id}` });
}
