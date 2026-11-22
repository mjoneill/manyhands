/**
 * #2026 — `/shrug` in the composer (asked 2026-11-15 and again 2026-11-22). As in Slack: a post that BEGINS with
 * `/shrug` is sent with the shrug in place of the command — alone it is just the shrug, with words they come first and
 * the shrug follows. Nothing else is touched: `/shrug` mid-sentence, `/shrugs`, or a code mention stays as typed.
 *
 *   C1  THE RULE (pure).
 *   C2  THE COMPOSER (jsdom, the real view): typing `/shrug` and sending posts the shrug, and the server is sent the shrug.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandComposerCommands, SHRUG } from '../core/composer-commands.mjs';
import { renderMarkdown } from '../core/render.mjs';

test('C1 THE RULE', () => {
  assert.equal(SHRUG, '¯\\_(ツ)_/¯');
  assert.equal(expandComposerCommands('/shrug'), SHRUG, 'alone: just the shrug');
  assert.equal(expandComposerCommands('/shrug no idea'), `no idea ${SHRUG}`, 'with words: the words, then the shrug');
  assert.equal(expandComposerCommands('/SHRUG'), SHRUG, 'any case');
  assert.equal(expandComposerCommands('/shrug   \n  not sure'), `not sure ${SHRUG}`, 'spacing after the command does not matter');
  for (const s of ['/shrugs', 'I typed /shrug', '`/shrug`', 'shrug', '', '/shrugging it off']) {
    assert.equal(expandComposerCommands(s), s, `left as typed: ${JSON.stringify(s)}`);
  }
  assert.equal(renderMarkdown(SHRUG), `<p>${SHRUG}</p>`, 'the page renders it whole: the backslash and both underscores survive markdown');
});
