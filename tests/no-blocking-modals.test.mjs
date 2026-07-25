/**
 * The UI must never call a native modal — alert(), confirm(), prompt().
 *
 * This is not a style rule. This board's whole premise is that agents and people
 * work the SAME interface. A native modal freezes the page for anyone driving a
 * browser programmatically: no command lands, Escape cannot reach the dialog,
 * and the only recovery is navigating away. So a modal is not a small annoyance,
 * it is an outage for half the room — and the worst case is an ERROR path, where
 * the party who most needs to read the message is the one who can no longer
 * interact with anything.
 *
 * Found by walking the board in a real browser: the wiki's "+ New page" called
 * prompt(), which killed an agent's tab for a full minute. The primary create
 * action of one of the three views was unusable by half the audience, and the
 * test suite was green throughout — nothing in a headless harness notices a
 * dialog that a human would simply click away.
 *
 * This test is a SOURCE scan on purpose. A DOM test would only cover the paths
 * a test happens to drive, and the modals that matter live on rare error
 * branches nobody exercises. Scanning the source catches the one added next
 * month in a hurry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** The pages a person or an agent actually loads. */
const UI_FILES = ['index.html', 'wiki.html', 'commons.html', 'settings.html'];

/**
 * A call to a bare `alert(` / `confirm(` / `prompt(` — not `foo.prompt(`, and
 * not the word appearing inside a longer identifier like `promptUser`.
 */
const MODAL_CALL = /(^|[^.\w$])(alert|confirm|prompt)\s*\(/;

/** Strip the obvious comment forms so a note ABOUT modals doesn't fail the test. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
    .replace(/<!--[\s\S]*?-->/g, '');
}

for (const file of UI_FILES) {
  test(`${file} calls no native modal (they freeze the page for an agent)`, () => {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) return; // a page we don't ship is not a failure

    const offenders = [];
    stripComments(fs.readFileSync(full, 'utf8')).split('\n').forEach((line, i) => {
      // A string containing the word (an error message, a test fixture) is not
      // a call; require the parenthesis form and ignore obvious string content.
      if (MODAL_CALL.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });

    assert.deepEqual(
      offenders, [],
      `native modal(s) found — use a non-blocking notice instead:\n  ${offenders.join('\n  ')}`,
    );
  });
}

test('the wiki offers an inline field for a new page, not a modal', () => {
  // The specific regression: "+ New page" must collect its title in the page,
  // so an automated browser can type into it like any other input.
  const src = fs.readFileSync(path.join(ROOT, 'wiki.html'), 'utf8');
  assert.match(src, /new-page-input/, 'an inline input exists for the create flow');
  assert.match(src, /class="new-page-input"|className = 'new-page-input'/, 'and it is actually rendered');
});

test('a non-blocking notice helper exists for error paths', () => {
  // Error paths are exactly where a modal does the most damage, so the
  // alternative has to be present rather than assumed.
  const wiki = fs.readFileSync(path.join(ROOT, 'wiki.html'), 'utf8');
  const board = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(wiki, /function notify\(/, 'wiki has a non-blocking notice');
  assert.match(board, /function showUndoToast\(/, 'board has a non-blocking notice');
});
