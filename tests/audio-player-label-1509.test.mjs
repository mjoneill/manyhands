/**
 * #1509 — the audio player's only name label was the DOWNLOAD link.
 *
 * Measured 2026-09-28 00:08Z: the owner's first click after #1503 downloaded the
 * take. The page drew a player, but the only visible file name was
 * `<a download>⬇ take1.wav</a>` beside it, so the natural click (the
 * name) downloaded. Both the build and the review had checked "served safely
 * and correctly"; neither asked what the reader would click.
 *
 * So this test asks exactly that, in a real browser: the NAME must be visible
 * and must not be a download link; the download affordance must not carry the
 * name as its visible text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withBrowserServer } from './helpers/harness.mjs';

const TS = '2026-09-28T04:00:00.000Z';
const board = {
  cards: [],
  columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
  conversations: [{
    id: 'm1', body: 'three takes', author: 'sage', attachedTo: null, createdAt: TS, mentions: [],
    attachments: [{ id: 'abc.wav', name: 'warm-take2.wav', mime: 'audio/wav', size: 10 }],
  }],
  nextShortId: 1,
};

test('#1509 BENEFICIARY: in the commons the take is NAMED on the player, and the name is not a download', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('audio', { timeout: 5000 });
    const seen = await page.evaluate(() => {
      const audio = document.querySelector('audio');
      const box = audio.parentElement;
      const texts = [...box.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent.trim());
      const nameEl = texts.find((e) => e.textContent.includes('warm-take2.wav'));
      const dl = box.querySelector('a[download]');
      return {
        nameShown: !!nameEl,
        nameIsDownload: !!(nameEl && nameEl.closest('a[download]')),
        nameIsLink: !!(nameEl && nameEl.closest('a')),
        dlText: dl ? dl.textContent.trim() : null,
        dlLabel: dl ? (dl.getAttribute('aria-label') || '') : null,
      };
    });
    assert.ok(seen.nameShown, 'the file name is visible beside the player');
    assert.equal(seen.nameIsDownload, false, 'clicking the name must not download');
    assert.equal(seen.nameIsLink, false, 'the name is a label, not a link');
    assert.ok(seen.dlText !== null, 'a download affordance still exists');
    assert.ok(!seen.dlText.includes('warm-take2.wav'), `the download's visible text is not the name: "${seen.dlText}"`);
    assert.match(seen.dlLabel, /download.*warm-take2\.wav/i, 'the download still says what it downloads, for screen readers');
  }, { server: { board } });
});

test('#1509 the board and wiki renderers carry the same label, not only the shared view', () => {
  // index.html and wiki.html mirror core/conversation-view.mjs inline (as for
  // #1503). Pin that none of the three puts the name back into the download text.
  for (const page of ['index.html', 'wiki.html', 'core/conversation-view.mjs']) {
    const src = fs.readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /'⬇ ' \+ \(a\.name/, `${page}: the download link's text must not be the file name`);
    assert.match(src, /attach-audio-name|cv-attach-name|conv-attach-name/, `${page}: a visible name label for the player`);
  }
});
