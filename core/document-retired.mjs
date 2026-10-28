// #1743 — the board document is RETIRED once a board runs with SCRUM_BOARD_DOCUMENT=off (the 10-26 cutover). The marker is a
// sibling file, `<board file>.retired`, written by the operator at switch-off and removed only by a deliberate rollback to
// mode on. Every writer of the document (saveDomain, and the one-off scripts that rewrite it directly) asks here first, so a
// dormant script run by hand months later refuses loudly instead of writing a file nothing reads. A board that never
// retired its document (every test fixture, every mode-on board) has no marker and is unaffected.
import fs from 'node:fs';

export const retiredMarkerPath = (boardFile) => `${boardFile}.retired`;

export function assertDocumentNotRetired(boardFile) {
  const marker = retiredMarkerPath(boardFile);
  if (fs.existsSync(marker)) {
    const err = new Error(`#1743 REFUSED: ${boardFile} is retired (${marker} exists): this board runs on the graph store, and nothing reads this file. Nothing was written. To write it anyway, a rollback to SCRUM_BOARD_DOCUMENT=on must remove the marker first.`);
    err.code = 'DOCUMENT_RETIRED';
    throw err;
  }
}
