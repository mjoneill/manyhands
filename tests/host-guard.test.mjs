/**
 * #1338 — the Host guard, as a pure decision.
 *
 * DNS rebinding: an attacker's page at attacker.example:PORT flips its DNS to
 * 127.0.0.1 and then fetches http://attacker.example:PORT/api/… — SAME origin
 * from the browser's point of view, so no preflight and no CORS check ever
 * runs. The bind address, the "same-origin only" stance and #249's JSON
 * requirement are all satisfied. The one thing that differs from a real
 * request is the Host header, and until this card nothing read it.
 *
 * This file tests the DECISION in isolation. tests/host-guard-servers.test.mjs
 * crosses the seam and sends the hostile header at both real servers — a pure
 * test alone would leave that uncrossed, and the seam is where this matters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostAllowed, parseAllowedHosts } from '../core/host-guard.mjs';

// Not 3141: the #837 hygiene guard reads a `localhost:31xx` literal as a
// test reaching the LIVE board, and it cannot see that this file never opens a
// socket. The number is arbitrary here; the guard's caution is not.
const PORT = 4242;

test('#1338 loopback names are allowed, with the bound port or bare', () => {
  for (const h of ['localhost:4242', '127.0.0.1:4242', '[::1]:4242', 'localhost', '127.0.0.1', '[::1]', 'LOCALHOST:4242']) {
    assert.equal(hostAllowed(h, { port: PORT }), true, `expected ${h} allowed`);
  }
});

test('#1338 a foreign name is refused — the rebinding case', () => {
  for (const h of ['attacker.example', 'attacker.example:4242', 'localhost.attacker.example:4242', '127.0.0.1.attacker.example:4242', 'localhost.:4242']) {
    assert.equal(hostAllowed(h, { port: PORT }), false, `expected ${h} refused`);
  }
});

test('#1338 a loopback name on a FOREIGN port is refused — a request meant for another local service', () => {
  for (const h of ['localhost:3001', '127.0.0.1:80', '[::1]:9999']) {
    assert.equal(hostAllowed(h, { port: PORT }), false, `expected ${h} refused`);
  }
});

test('#1338 an ABSENT or malformed Host is refused, never treated as local', () => {
  for (const h of [undefined, null, '', '   ', ':4242', 'localhost:abc', 'localhost:4242:4242', '[::1', 'a b:4242']) {
    assert.equal(hostAllowed(h, { port: PORT }), false, `expected ${JSON.stringify(h)} refused`);
  }
});

test('#1338 SCRUM_ALLOWED_HOSTS adds exact names; a near-miss of one is still refused', () => {
  const extra = parseAllowedHosts('host.docker.internal, Board.Local:4242');
  assert.equal(hostAllowed('host.docker.internal:4242', { port: PORT, extra }), true);
  assert.equal(hostAllowed('host.docker.internal', { port: PORT, extra }), true);
  assert.equal(hostAllowed('board.local:4242', { port: PORT, extra }), true, 'case-insensitive');
  // The entry carried a port, so only that port is allowed for it.
  assert.equal(hostAllowed('board.local:3001', { port: PORT, extra }), false);
  assert.equal(hostAllowed('host.docker.internal.attacker.example:4242', { port: PORT, extra }), false, 'suffix is not a match');
  assert.equal(hostAllowed('docker.internal:4242', { port: PORT, extra }), false, 'substring is not a match');
});

test('#1338 parseAllowedHosts tolerates the shapes an operator will actually type', () => {
  assert.deepEqual(parseAllowedHosts(undefined), []);
  assert.deepEqual(parseAllowedHosts(''), []);
  assert.deepEqual(parseAllowedHosts(' a.local ,, B.local:4242 , '), ['a.local', 'b.local:4242']);
});

// ⛔ SABOTAGE CHECK, in the file so it stays run: a guard that allowed
// everything and a guard that allowed nothing must BOTH fail here. If either
// passes this suite, the suite is three spellings of one test.
test('#1338 the suite can tell allow-all from allow-none from the real guard', () => {
  const allowAll = () => true;
  const allowNone = () => false;
  assert.notEqual(allowAll('attacker.example:4242', { port: PORT }), hostAllowed('attacker.example:4242', { port: PORT }));
  assert.notEqual(allowNone('localhost:4242', { port: PORT }), hostAllowed('localhost:4242', { port: PORT }));
});
