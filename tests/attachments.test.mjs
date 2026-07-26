/**
 * Server-side tests for commons attachments (#113).
 *
 * Isolated harness: each server gets a throwaway board file AND a throwaway
 * attachments dir (startRestServer creates + cleans both), so these never
 * touch the real board-data.json or attachments/.
 *
 * Behavior + security, not surface: upload/serve round-trips, the size cap,
 * the executable / HTML / SVG rejects (stored-XSS vectors), inline-vs-download
 * serve headers, path-traversal on serve, and conversation attachment plumbing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRestServer } from './helpers/harness.mjs';

// A real 1x1 transparent PNG.
const PNG_1x1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const post = (baseUrl, route, body) =>
  fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

async function withServer(opts, fn) {
  const rest = await startRestServer(opts);
  try {
    return await fn(rest);
  } finally {
    await rest.stop();
  }
}

const uploadPng = (rest) =>
  post(rest.baseUrl, '/api/attachments', { name: 'shot.png', mime: 'image/png', data: PNG_1x1_B64 });

test('#113: POST /api/attachments stores a valid image and returns metadata', async () => {
  await withServer({}, async (rest) => {
    const res = await uploadPng(rest);
    assert.equal(res.status, 201);
    const meta = await res.json();
    assert.match(meta.id, /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/, 'id is a safe stored filename');
    assert.equal(meta.name, 'shot.png');
    assert.equal(meta.mime, 'image/png');
    assert.ok(meta.size > 0, 'has a size');
    assert.ok(fs.existsSync(path.join(rest.attachmentsDir, meta.id)), 'bytes written to the isolated dir');
  });
});

test('#113: oversized upload is rejected (DoS guard)', async () => {
  await withServer({ env: { SCRUM_MAX_ATTACHMENT_BYTES: '2048' } }, async (rest) => {
    const big = Buffer.alloc(4096, 7).toString('base64'); // 4KB decoded > 2KB cap
    const res = await post(rest.baseUrl, '/api/attachments', { name: 'big.png', mime: 'image/png', data: big });
    assert.ok(res.status === 413 || res.status === 400, `oversize rejected (got ${res.status})`);
  });
});

test('#113: executable upload is rejected (non-executables only)', async () => {
  await withServer({}, async (rest) => {
    const res = await post(rest.baseUrl, '/api/attachments', {
      name: 'evil.exe',
      mime: 'application/x-msdownload',
      data: Buffer.from('MZ').toString('base64'),
    });
    assert.equal(res.status, 400);
  });
});

test('#113: HTML and SVG uploads are rejected (stored-XSS vectors)', async () => {
  await withServer({}, async (rest) => {
    const html = await post(rest.baseUrl, '/api/attachments', {
      name: 'x.html',
      mime: 'text/html',
      data: Buffer.from('<script>alert(1)</script>').toString('base64'),
    });
    assert.equal(html.status, 400, 'html blocked');
    const svg = await post(rest.baseUrl, '/api/attachments', {
      name: 'x.svg',
      mime: 'image/svg+xml',
      data: Buffer.from('<svg onload=alert(1)>').toString('base64'),
    });
    assert.equal(svg.status, 400, 'svg blocked');
  });
});

test('#113: a raster image serves INLINE with its image type + nosniff, no attachment disposition', async () => {
  await withServer({}, async (rest) => {
    const meta = await (await uploadPng(rest)).json();
    const res = await fetch(`${rest.baseUrl}/api/attachments/${meta.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(!(res.headers.get('content-disposition') || '').includes('attachment'), 'images render inline');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(buf, Buffer.from(PNG_1x1_B64, 'base64'), 'bytes round-trip intact');
  });
});

test('#113: a non-image serves as a forced DOWNLOAD (octet-stream + attachment + nosniff)', async () => {
  await withServer({}, async (rest) => {
    const meta = await (
      await post(rest.baseUrl, '/api/attachments', {
        name: 'notes.pdf',
        mime: 'application/pdf',
        data: Buffer.from('%PDF-1.4 fake').toString('base64'),
      })
    ).json();
    const res = await fetch(`${rest.baseUrl}/api/attachments/${meta.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.match(res.headers.get('content-disposition') || '', /attachment/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('#113: attachment serve rejects path traversal and never leaks source', async () => {
  await withServer({}, async (rest) => {
    for (const bad of ['..%2fserver.js', '%2e%2e%2fserver.js', '..', 'a%2fb']) {
      const res = await fetch(`${rest.baseUrl}/api/attachments/${bad}`);
      assert.ok(res.status >= 400, `traversal '${bad}' rejected (got ${res.status})`);
      const txt = await res.text();
      assert.ok(!txt.includes('handleRequest'), `must not leak server.js for '${bad}'`);
    }
  });
});

test('#113: a conversation carries attachments, and conversation_list returns them', async () => {
  await withServer({}, async (rest) => {
    const meta = await (await uploadPng(rest)).json();
    const conv = await (
      await post(rest.baseUrl, '/api/conversations', { author: 'sage', body: 'here is a pic', attachments: [meta] })
    ).json();
    assert.ok(Array.isArray(conv.attachments) && conv.attachments.length === 1, 'attachment stored on conversation');
    assert.equal(conv.attachments[0].id, meta.id);
    const list = await (await fetch(`${rest.baseUrl}/api/conversations`)).json();
    assert.equal(list[list.length - 1].attachments[0].name, 'shot.png');
  });
});

test('#113: a malicious attachment id on a conversation is not stored verbatim', async () => {
  await withServer({}, async (rest) => {
    const res = await post(rest.baseUrl, '/api/conversations', {
      author: 'sage',
      body: 'sneaky',
      attachments: [{ id: '../../etc/passwd', name: 'x', mime: 'image/png', size: 1 }],
    });
    if (res.status < 400) {
      const conv = await res.json();
      const ids = (conv.attachments || []).map((a) => a.id);
      assert.ok(!ids.includes('../../etc/passwd'), 'malicious id dropped, not stored verbatim');
    } else {
      assert.ok(res.status >= 400, 'or rejected outright');
    }
  });
});

test('#113: an attachment-only post (no body text) is allowed (paste-and-go)', async () => {
  await withServer({}, async (rest) => {
    const meta = await (await uploadPng(rest)).json();
    const res = await post(rest.baseUrl, '/api/conversations', { author: 'sage', body: '', attachments: [meta] });
    assert.equal(res.status, 201, 'empty body is fine when an attachment is present');
    const conv = await res.json();
    assert.equal(conv.body, '');
    assert.equal(conv.attachments.length, 1);
  });
});

test('#113: a post with neither body nor attachment is still rejected', async () => {
  await withServer({}, async (rest) => {
    const res = await post(rest.baseUrl, '/api/conversations', { author: 'sage', body: '   ' });
    assert.equal(res.status, 400);
  });
});

test('#113: a conversation without attachments still works (backward compat)', async () => {
  await withServer({}, async (rest) => {
    const conv = await (await post(rest.baseUrl, '/api/conversations', { author: 'sage', body: 'plain' })).json();
    assert.ok(Array.isArray(conv.attachments), 'attachments defaults to an array');
    assert.equal(conv.attachments.length, 0);
  });
});
