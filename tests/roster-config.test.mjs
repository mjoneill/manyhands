/**
 * Behavior tests for the configurable roster.
 *
 * The property that matters to a stranger: you can name your own people WITHOUT
 * editing tracked source, and getting it wrong costs you colours rather than
 * your board. Every test below asks what the software actually does when a
 * user's file is present, absent, or malformed — not whether the code exists.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  identityOf, roster, configureIdentities, usingDefaultRoster, DEFAULT_IDENTITIES,
} from '../core/identity.mjs';
import { loadRoster, rosterFilePath } from '../core/roster-config.mjs';
import { startRestServer } from './helpers/harness.mjs';

/** Write a throwaway roster file and return its path. */
function rosterFile(contents) {
  const p = path.join(os.tmpdir(), `roster-${process.pid}-${Math.floor(performance.now() * 1000)}.json`);
  fs.writeFileSync(p, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return p;
}

// Each test configures explicitly, so leave the module on the shipped default.
test.afterEach?.(() => configureIdentities(null));

// ── identity.mjs: the pure half ────────────────────────────────────────────

test('a configured roster replaces the example one', () => {
  configureIdentities({ ada: { name: 'Ada', glyph: '★', color: '#ff0000' } });
  assert.equal(identityOf('ada').name, 'Ada');
  assert.equal(identityOf('ada').color, '#ff0000');
  assert.equal(usingDefaultRoster(), false);
  // and the example seats are GONE — a replacement, not a merge, so a stranger
  // isn't stuck with our placeholder names showing up beside their own people.
  assert.equal(identityOf('sage').name, 'sage', 'example seat falls through to unknown');
  configureIdentities(null);
});

test('configuring with nothing falls back to the shipped example roster', () => {
  configureIdentities({ ada: { name: 'Ada', color: '#ff0000' } });
  configureIdentities(null);
  assert.equal(usingDefaultRoster(), true);
  assert.equal(identityOf('sage').name, DEFAULT_IDENTITIES.sage.name);
});

test('keys are matched case-insensitively however they were written in the file', () => {
  configureIdentities({ ADA: { name: 'Ada', color: '#ff0000' } });
  assert.equal(identityOf('ada').name, 'Ada', 'an uppercase key still matches a lowercase author');
  configureIdentities(null);
});

test('ONE malformed seat is dropped; the rest of the roster still works', () => {
  // The whole point of being forgiving here: a stray typo in one colour must
  // not cost you every other light on the board.
  const now = configureIdentities({
    ada: { name: 'Ada', color: '#ff0000' },
    broken: { name: 'Broken', color: 'not-a-colour' },
    nameless: { color: '#00ff00' },
  });
  assert.deepEqual(Object.keys(now), ['ada'], 'only the well-formed seat survives');
  assert.equal(identityOf('ada').color, '#ff0000');
  configureIdentities(null);
});

test('a dropped seat renders under its OWN name, never someone else\'s', () => {
  // This is why dropping is safe. The failure mode of a bad roster entry is a
  // grey name — misattribution would be a different and much worse bug.
  configureIdentities({ ada: { name: 'Ada', color: '#ff0000' } });
  const unknown = identityOf('someone-not-in-the-roster');
  assert.equal(unknown.name, 'someone-not-in-the-roster');
  assert.notEqual(unknown.color, identityOf('ada').color);
  configureIdentities(null);
});

test('a seat with no glyph still gets a usable one', () => {
  configureIdentities({ ada: { name: 'Ada', color: '#ff0000' } });
  assert.ok(identityOf('ada').glyph, 'glyph is optional in the file, not in the result');
  configureIdentities(null);
});

test('an empty or array roster falls back rather than emptying the room', () => {
  configureIdentities({});
  assert.equal(usingDefaultRoster(), true, 'an empty object is not a roster');
  configureIdentities([{ name: 'Ada', color: '#ff0000' }]);
  assert.equal(usingDefaultRoster(), true, 'an array is not a roster');
  configureIdentities(null);
});

test('roster() reflects the configured seats', () => {
  configureIdentities({ ada: { name: 'Ada', color: '#ff0000' } });
  assert.deepEqual(roster().map((r) => r.key), ['ada']);
  configureIdentities(null);
});

// ── roster-config.mjs: the node half ───────────────────────────────────────

test('a MISSING roster file is the normal case — no warning, no throw', () => {
  const warnings = [];
  const seats = loadRoster(path.join(os.tmpdir(), 'definitely-not-here.json'), (m) => warnings.push(m));
  assert.equal(seats, null);
  assert.deepEqual(warnings, [], 'not having configured a roster is not a problem worth reporting');
});

test('a CORRUPT roster file warns loudly and falls back — it does not throw', () => {
  const warnings = [];
  const seats = loadRoster(rosterFile('{ this is not json'), (m) => warnings.push(m));
  assert.equal(seats, null, 'falls back');
  assert.equal(warnings.length, 1, 'and says so — a silently ignored config gets debugged twice');
  assert.match(warnings[0], /JSON/i);
});

test('both file shapes work: a bare map and { seats: {...} }', () => {
  const bare = loadRoster(rosterFile({ ada: { name: 'Ada', color: '#ff0000' } }));
  const wrapped = loadRoster(rosterFile({ seats: { ada: { name: 'Ada', color: '#ff0000' } } }));
  assert.deepEqual(bare, wrapped, 'guessing the wrong shape should not cost anyone twenty minutes');
});

test('the roster path is overridable, so instances do not collide', () => {
  const prev = process.env.SCRUM_ROSTER_FILE;
  process.env.SCRUM_ROSTER_FILE = '/tmp/somewhere-else.json';
  try {
    assert.equal(rosterFilePath(), '/tmp/somewhere-else.json');
  } finally {
    if (prev === undefined) delete process.env.SCRUM_ROSTER_FILE; else process.env.SCRUM_ROSTER_FILE = prev;
  }
});

test('the shipped roster.example.json is itself valid and loadable', () => {
  // It is the file every new user copies. If it were malformed we would be
  // handing everyone a broken starting point.
  const seats = loadRoster(new URL('../roster.example.json', import.meta.url).pathname);
  assert.ok(seats && Object.keys(seats).length >= 1);
  const applied = configureIdentities(seats);
  assert.ok(Object.keys(applied).length >= 1, 'and it survives validation, not just parsing');
  configureIdentities(null);
});

// ── end to end: a user's file actually reaches a browser page ──────────────

test('END TO END: a user roster reaches both the API and the served HTML', async () => {
  const file = rosterFile({ seats: { ada: { name: 'Ada Lovelace', glyph: '★', color: '#ff0000' } } });
  const server = await startRestServer({ env: { SCRUM_ROSTER_FILE: file } });
  try {
    const api = await (await fetch(`${server.baseUrl}/api/roster`)).json();
    assert.equal(api.seats.ada.name, 'Ada Lovelace');
    assert.equal(api.usingDefaults, false);
    assert.ok(!api.seats.sage, 'the example seats are not silently merged in');

    // The page has to carry the roster itself: fetching it after load would
    // render the room in the wrong colours first and correct itself after.
    const html = await (await fetch(`${server.baseUrl}/index.html`)).text();
    assert.match(html, /__SCRUM_ROSTER__/, 'roster is inlined into the page');
    assert.match(html, /Ada Lovelace/, 'and it is the USER\'s roster, not the example');
  } finally {
    await server.stop();
  }
});

test('END TO END: with no roster file the board still serves and says it is using defaults', async () => {
  const server = await startRestServer({ env: { SCRUM_ROSTER_FILE: path.join(os.tmpdir(), 'nope.json') } });
  try {
    const api = await (await fetch(`${server.baseUrl}/api/roster`)).json();
    assert.equal(api.usingDefaults, true, 'a fresh clone must boot and render without any config');
    assert.ok(Object.keys(api.seats).length >= 1);
    const html = await (await fetch(`${server.baseUrl}/index.html`)).text();
    assert.match(html, /__SCRUM_ROSTER__/);
  } finally {
    await server.stop();
  }
});

test('END TO END: a name containing a script tag cannot break out of the inlined JSON', async () => {
  // The roster is user-supplied text landing inside a <script> element. A name
  // ending the tag early would turn a config file into stored markup.
  const file = rosterFile({ seats: { x: { name: '</script><b>pwn</b>', color: '#ff0000' } } });
  const server = await startRestServer({ env: { SCRUM_ROSTER_FILE: file } });
  try {
    const html = await (await fetch(`${server.baseUrl}/index.html`)).text();
    assert.ok(!html.includes('</script><b>pwn</b>'), 'the closing tag must not survive verbatim');
    assert.match(html, /\\u003c\/script/, 'it is escaped instead');
  } finally {
    await server.stop();
  }
});
