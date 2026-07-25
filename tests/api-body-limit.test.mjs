/**
 * #250 — request-body size cap. readBody() buffered every chunk with no limit,
 * so a large POST to any write route (the only write path) could OOM the single
 * process. A mutating /api request whose body exceeds the cap is now rejected
 * 413 and the server keeps serving. Isolated server per test — never live :3141.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

const jsonPost = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body,
});

test('#250 an oversized POST body is rejected 413 and the server survives', async () => {
  const server = await startRestServer();
  try {
    // ~11 MB body — over the JSON write cap.
    const huge = 'x'.repeat(11 * 1024 * 1024);
    const res = await fetch(`${server.baseUrl}/api/cards`, jsonPost(JSON.stringify({ title: 'big', description: huge })));
    assert.equal(res.status, 413, 'oversized body rejected');

    // The card did not persist…
    const list = await (await fetch(`${server.baseUrl}/api/cards`)).json();
    assert.equal(list.length, 0, 'oversized write did not persist');

    // …and the server is still alive and serving normal writes.
    const ok = await fetch(`${server.baseUrl}/api/cards`, jsonPost(JSON.stringify({ title: 'small' })));
    assert.equal(ok.status, 201, 'server still serving after the oversized request');
  } finally {
    await server.stop();
  }
});

test('#250 a normal-size POST is unaffected', async () => {
  const server = await startRestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/cards`, jsonPost(JSON.stringify({ title: 'normal' })));
    assert.equal(res.status, 201);
  } finally {
    await server.stop();
  }
});
