/**
 * #1215 SAY IT — the board announces a newly-seen unregistered kind ONCE, as
 * itself, naming the type, the count, an example and the verb; never again for
 * the same type while it stays unregistered; again if it clears and recurs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newlySeen, renderAnnouncement, emitterTick } from '../core/unregistered-emitter.mjs';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'unreg-')), 'state.json');
const GIZMO = { type: 'https://scrumboard.local/ns#Gizmo', n: '3', example: 'https://scrumboard.local/entity/zz-1' };
const WIDGET = { type: 'https://scrumboard.local/ns#Widget', n: '1', example: 'https://scrumboard.local/entity/zz-9' };

test('#1215 newlySeen: only types not yet announced are fresh; the announced set is the current set', () => {
  const a = newlySeen([GIZMO], []);
  assert.deepEqual(a.fresh, ['scrum:Gizmo']);
  const b = newlySeen([GIZMO, WIDGET], a.announced);
  assert.deepEqual(b.fresh, ['scrum:Widget']);
  assert.deepEqual(b.announced.sort(), ['scrum:Gizmo', 'scrum:Widget']);
});

test('#1215 the announcement names the type, the count, an example and the ONE verb', () => {
  const body = renderAnnouncement([GIZMO], ['scrum:Gizmo']);
  assert.match(body, /`scrum:Gizmo`/);
  assert.match(body, /3 instances/);
  assert.match(body, /entity:zz-1/);
  assert.match(body, /kind_register/);
  assert.match(body, /accepted and nothing was lost/, 'it says the write landed — the owner\'s worry, answered in the message');
});

test('#1215 ONE post per newly-seen type; nothing on the next tick; several new types in one tick → ONE post', async () => {
  const file = tmp(); const posts = [];
  const post = async (b) => { posts.push(b); };
  const t1 = await emitterTick({ now: '2026-09-06T10:00:00Z', file, rows: () => [GIZMO], post });
  assert.equal(t1.posted, true); assert.equal(posts.length, 1); assert.equal(posts[0].author, 'board');
  const t2 = await emitterTick({ now: '2026-09-06T10:01:00Z', file, rows: () => [GIZMO], post });
  assert.equal(t2.posted, false); assert.equal(t2.reason, 'nothing-new'); assert.equal(posts.length, 1);
  const t3 = await emitterTick({ now: '2026-09-06T10:02:00Z', file, rows: () => [GIZMO, WIDGET, { ...WIDGET, type: 'https://scrumboard.local/ns#Sprocket', example: null }], post });
  assert.equal(t3.posted, true); assert.equal(posts.length, 2, 'two new types, one post');
  assert.match(posts[1].body, /Widget/); assert.match(posts[1].body, /Sprocket/); assert.doesNotMatch(posts[1].body, /Gizmo/, 'already announced');
});

test('#1215 CLEAR then RECUR: a registered type is forgotten, so its reappearance is announced again as a new fact', async () => {
  const file = tmp(); const posts = []; const post = async (b) => { posts.push(b); };
  await emitterTick({ now: '2026-09-06T10:00:00Z', file, rows: () => [GIZMO], post });
  const cleared = await emitterTick({ now: '2026-09-07T10:00:00Z', file, rows: () => [], post });
  assert.equal(cleared.posted, false); assert.deepEqual(cleared.announced, []);
  const again = await emitterTick({ now: '2026-09-08T10:00:00Z', file, rows: () => [GIZMO], post });
  assert.equal(again.posted, true); assert.equal(posts.length, 2);
});

test('#1215 NEGATIVE CONTROL: no unregistered rows → no post, ever, and no state written', async () => {
  const file = tmp(); const posts = [];
  const r = await emitterTick({ now: '2026-09-06T10:00:00Z', file, rows: () => [], post: async (b) => posts.push(b) });
  assert.equal(r.posted, false); assert.equal(posts.length, 0); assert.equal(fs.existsSync(file), false);
});

test('#1215 a failed post is NOT recorded as announced, so the next tick retries; an unreadable surface says nothing', async () => {
  const file = tmp(); let fail = true; const posts = [];
  const post = async (b) => { if (fail) throw new Error('commons down'); posts.push(b); };
  const t1 = await emitterTick({ now: '2026-09-06T10:00:00Z', file, rows: () => [GIZMO], post });
  assert.equal(t1.posted, false); assert.equal(t1.reason, 'post-failed');
  fail = false;
  const t2 = await emitterTick({ now: '2026-09-06T10:01:00Z', file, rows: () => [GIZMO], post });
  assert.equal(t2.posted, true); assert.equal(posts.length, 1);
  const t3 = await emitterTick({ now: '2026-09-06T10:02:00Z', file, rows: () => { throw new Error('checks unreachable'); }, post });
  assert.equal(t3.reason, 'rows-unreadable'); assert.equal(posts.length, 1);
});

test('#1215 the emitter is WIRED: mcp-server.mjs calls emitterTick on the tending interval', () => {
  const src = fs.readFileSync(new URL('../mcp-server.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ emitterTick \} from '\.\/core\/unregistered-emitter\.mjs'/);
  assert.match(src, /emitterTick\(\{/);
});
