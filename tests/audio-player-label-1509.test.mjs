/**
 * #1509 — clicking a take's NAME plays it.
 *
 * Measured 2026-09-28 00:08Z: the owner's first click after #1503 downloaded the
 * take. The page drew a player, but the only visible file name was
 * `<a download>⬇ take1.wav</a>` beside it, so the natural click (the name)
 * downloaded.
 *
 * The first fix made the name an inert label, and its test asserted only that
 * the name was NOT a download: the absence of the wrong behaviour. Review
 * (PR #4) caught that the promised behaviour, "clicks the name and HEARS it",
 * never happened. So this test clicks the name and asserts that THAT take's
 * audio was told to play, then that a second click pauses it.
 *
 * `play()` is spied, because a stub wav cannot really play in headless Chrome;
 * the spy records which element was asked, which is the property under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withBrowserServer } from './helpers/harness.mjs';

const TS = '2026-09-28T04:00:00.000Z';
const takes = [
  { id: 'a.wav', name: 'warm-take1.wav', mime: 'audio/wav', size: 10 },
  { id: 'b.wav', name: 'warm-take2.wav', mime: 'audio/wav', size: 10 },
];
const board = {
  cards: [],
  columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
  conversations: [{ id: 'm1', body: 'two takes', author: 'sage', attachedTo: null, createdAt: TS, mentions: [], attachments: takes }],
  nextShortId: 1,
};

// Installed before any page script runs: record which element play()/pause()
// were called on, and make `paused` reflect it so the toggle can be observed.
function spyOnMedia() {
  window.__media = [];
  const P = HTMLMediaElement.prototype;
  P.play = function play() {
    window.__media.push({ call: 'play', src: this.getAttribute('src') || this.src });
    this.__playing = true;
    Object.defineProperty(this, 'paused', { configurable: true, get: () => !this.__playing });
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  };
  P.pause = function pause() {
    window.__media.push({ call: 'pause', src: this.getAttribute('src') || this.src });
    this.__playing = false;
    this.dispatchEvent(new Event('pause'));
  };
}

async function clickTheNameAndListen(page) {
  await page.waitForSelector('audio', { timeout: 5000 });
  return page.evaluate(async () => {
    const boxes = [...document.querySelectorAll('audio')].map((a) => a.parentElement);
    const box = boxes.find((b) => b.textContent.includes('warm-take2.wav'));
    const name = [...box.querySelectorAll('button, a, span')].find((e) => e.textContent.includes('warm-take2.wav'));
    const dl = box.querySelector('a[download]');
    const out = {
      nameTag: name && name.tagName,
      nameIsDownload: !!(name && name.closest('a[download]')),
      dlText: dl ? dl.textContent.trim() : null,
      dlLabel: dl ? dl.getAttribute('aria-label') || '' : null,
    };
    name.click();
    await new Promise((r) => setTimeout(r, 50));
    out.afterFirst = window.__media.slice();
    out.glyphPlaying = name.textContent.trim();
    name.click();
    await new Promise((r) => setTimeout(r, 50));
    out.afterSecond = window.__media.slice();
    out.glyphPaused = name.textContent.trim();
    return out;
  });
}

function assertTheOutcome(seen, where) {
  assert.equal(seen.nameIsDownload, false, `${where}: the name must not be a download`);
  assert.equal(seen.nameTag, 'BUTTON', `${where}: the name is a real, keyboard-reachable button`);
  // The promised behaviour: clicking the name plays THAT take, not the other one.
  assert.deepEqual(seen.afterFirst.map((m) => m.call), ['play'], `${where}: one click → play()`);
  assert.match(seen.afterFirst[0].src, /b\.wav$/, `${where}: it played the take whose name was clicked`);
  assert.match(seen.glyphPlaying, /^⏸/, `${where}: the name shows it is playing`);
  // And clicking it again pauses it.
  assert.deepEqual(seen.afterSecond.map((m) => m.call), ['play', 'pause'], `${where}: second click → pause()`);
  assert.match(seen.glyphPaused, /^▶/, `${where}: the name shows it is paused again`);
  // The download stays available, but is not what the name does.
  assert.equal(seen.dlText, '⬇', `${where}: the download shows only ⬇`);
  assert.match(seen.dlLabel, /download.*warm-take2\.wav/i, `${where}: the download says what it downloads`);
}

test('#1509 BENEFICIARY (commons): clicking a take\'s name plays that take, and clicking again pauses it', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(spyOnMedia);
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    assertTheOutcome(await clickTheNameAndListen(page), 'commons');
  }, { server: { board } });
});

test('#1509 BENEFICIARY (board page): the conversations panel behaves the same', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(spyOnMedia);
    await page.goto(`${server.baseUrl}/index.html`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => openConvsPanelBody());   // eslint-disable-line no-undef
    assertTheOutcome(await clickTheNameAndListen(page), 'index');
  }, { server: { board } });
});

test('#1509 the wiki renderer carries the same play-on-name button (source pin; not rendered here)', () => {
  const src = fs.readFileSync(new URL('../wiki.html', import.meta.url), 'utf8');
  assert.match(src, /el\('button', 'attach-audio-name'\)/, 'wiki: the name is a button');
  assert.match(src, /audio\.play\(\)/, 'wiki: the name button plays the audio');
  assert.doesNotMatch(src, /'⬇ ' \+ \(a\.name/, "wiki: the download text is not the file name");
});
