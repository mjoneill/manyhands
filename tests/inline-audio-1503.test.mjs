/**
 * #1503 — an audio attachment plays in the page instead of downloading.
 *
 * Measured 2026-09-27: every voice take on #1494 came back as
 * `application/octet-stream` + `Content-Disposition: attachment`, so listening
 * meant downloading and opening another app. #113's guard (nothing uploaded may
 * execute in our origin) is kept: audio cannot execute, and html/svg/js/pdf are
 * still forced to download.
 *
 * Range support is not a nicety: Safari will not play <audio> from a server
 * that ignores `Range`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startRestServer } from './helpers/harness.mjs';
import { attachmentKind } from '../core/conversation-view.mjs';

// A real, minimal 16-bit mono PCM WAV: 44-byte header + 8 samples of silence.
function tinyWav() {
  const samples = 8, bytes = samples * 2;
  const b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(bytes, 40);
  return b;
}

const post = (baseUrl, body) => fetch(`${baseUrl}/api/attachments`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function withServer(fn) {
  const rest = await startRestServer({});
  try { return await fn(rest); } finally { await rest.stop(); }
}

const uploadWav = async (rest) =>
  (await post(rest.baseUrl, { name: 'take.wav', mime: 'audio/wav', data: tinyWav().toString('base64') })).json();

test('#1503 a .wav serves INLINE as audio/wav with nosniff and no attachment disposition', async () => {
  await withServer(async (rest) => {
    const meta = await uploadWav(rest);
    assert.match(meta.id, /\.wav$/);
    const res = await fetch(`${rest.baseUrl}/api/attachments/${meta.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/wav');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(!(res.headers.get('content-disposition') || '').includes('attachment'), 'audio plays in the page');
    assert.equal(res.headers.get('accept-ranges'), 'bytes', 'the player is told it may seek');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), tinyWav());
  });
});

test('#1503 a Range request gets 206 with exactly the requested bytes and a Content-Range', async () => {
  await withServer(async (rest) => {
    const meta = await uploadWav(rest);
    const whole = tinyWav();
    const res = await fetch(`${rest.baseUrl}/api/attachments/${meta.id}`, { headers: { Range: 'bytes=4-11' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes 4-11/${whole.length}`);
    assert.equal(res.headers.get('content-length'), '8');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), whole.subarray(4, 12));
  });
});

test('#1503 an open-ended Range (bytes=N-) and an unsatisfiable Range behave per RFC 9110', async () => {
  await withServer(async (rest) => {
    const meta = await uploadWav(rest);
    const whole = tinyWav();
    const open = await fetch(`${rest.baseUrl}/api/attachments/${meta.id}`, { headers: { Range: 'bytes=40-' } });
    assert.equal(open.status, 206);
    assert.deepEqual(Buffer.from(await open.arrayBuffer()), whole.subarray(40));
    const bad = await fetch(`${rest.baseUrl}/api/attachments/${meta.id}`, { headers: { Range: `bytes=${whole.length + 10}-` } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get('content-range'), `bytes */${whole.length}`);
  });
});

test('#1503 PIN for #113: a pdf is STILL a forced download, and html is still refused at upload', async () => {
  await withServer(async (rest) => {
    const pdf = await (await post(rest.baseUrl, { name: 'n.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4').toString('base64') })).json();
    const res = await fetch(`${rest.baseUrl}/api/attachments/${pdf.id}`);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.match(res.headers.get('content-disposition') || '', /attachment/);
    const html = await post(rest.baseUrl, { name: 'x.html', mime: 'text/html', data: Buffer.from('<script>1</script>').toString('base64') });
    assert.equal(html.status, 400);
  });
});

test('#1503 attachmentKind: images and audio render in place, everything else is a file', () => {
  assert.equal(attachmentKind('image/png'), 'image');
  assert.equal(attachmentKind('audio/wav'), 'audio');
  assert.equal(attachmentKind('audio/mpeg'), 'audio');
  assert.equal(attachmentKind('audio/ogg'), 'audio');
  assert.equal(attachmentKind('application/pdf'), 'file');
  assert.equal(attachmentKind('image/svg+xml'), 'file', 'svg can execute; it must never render in place');
  assert.equal(attachmentKind(undefined), 'file');
});

test('#1503 all three renderers draw an <audio controls> for audio, not only the shared view', () => {
  // index.html and wiki.html are inline scripts that cannot import the module,
  // so they mirror it (as they already do for tokenizeCardRefs). Pin that each
  // one actually has the audio branch, or a fix to one page leaves the others
  // downloading.
  for (const page of ['index.html', 'wiki.html', 'core/conversation-view.mjs']) {
    const src = fs.readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    assert.match(src, /createElement\('audio'\)|el\('audio'/, `${page} renders audio attachments with an <audio> element`);
    assert.match(src, /\.controls\s*=\s*true/, `${page} gives the player controls`);
  }
});

test('#1503 a suffix Range (bytes=-N) returns exactly the LAST N bytes', async () => {
  await withServer(async (rest) => {
    const meta = await uploadWav(rest);
    const whole = tinyWav();
    const res = await fetch(`${rest.baseUrl}/api/attachments/${meta.id}`, { headers: { Range: 'bytes=-4' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes ${whole.length - 4}-${whole.length - 1}/${whole.length}`);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), whole.subarray(whole.length - 4));
  });
});

test('#1503 an INVALID range (last byte before first) is ignored: 200 with the whole body, per RFC 9110', async () => {
  await withServer(async (rest) => {
    const meta = await uploadWav(rest);
    const res = await fetch(`${rest.baseUrl}/api/attachments/${meta.id}`, { headers: { Range: 'bytes=5-3' } });
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), tinyWav());
  });
});
