/**
 * #1206 (slice 1 of #1205) — REGISTER THE RESEARCH VOCABULARY.
 *
 * Nothing about a research run can be written until the graph knows the words.
 * This file holds the words, and one negative control that matters more than
 * the rest of it put together.
 *
 * ⭐ THE NEGATIVE CONTROL. A Run is a `prov:Activity` carrying `scrum:op
 * "research"` — the SAME class the event log already projects for every
 * mutation on the board (~19,900 of them). So the query that finds runs must
 * find runs and NOTHING ELSE. If `scrum:op` could ever carry "research" from
 * the event log, "what research have we done" would silently answer "every
 * write anyone has made", and it would answer it with a large confident
 * number. It cannot: `EVENT_OPS` is a closed vocabulary validated on the write
 * path, "research" is not in it, and the assertion below is what keeps that
 * true rather than merely currently-so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_OPS } from '../core/event-log.mjs';
import { kindByName, PROJECTED_TYPES } from '../core/kind-registry.mjs';
import { buildGraphStore, projectActivities, queryGraph } from '../core/graph-replica.mjs';

const PROC = 'https://scrumboard.local/entity/proc-1';
const VER = 'https://scrumboard.local/entity/proc-1-v1';
const RUN = 'https://scrumboard.local/entity/run-1';
const ART = 'https://scrumboard.local/entity/artifact-1';

/** A hand-built fixture: one procedure, one version, one run, one artifact. */
const fixture = () => ({
  '@graph': [
    {
      '@id': PROC, '@type': 'scrum:Procedure',
      name: 'research a YouTube video',
      dateCreated: '2026-09-05T18:00:00.000Z',
      'schema:creator': 'ada',
    },
    {
      '@id': VER, '@type': 'scrum:ProcedureVersion',
      name: 'research a YouTube video v1',
      'scrum:body': 'Fetch the transcript. Read the primary sources. Record what you could not verify.',
      'scrum:ofProcedure': PROC,
      dateCreated: '2026-09-05T18:00:00.000Z',
    },
    {
      '@id': ART, '@type': 'schema:CreativeWork',
      name: '2026-09-05-some-video-transcript.md',
      'schema:contentUrl': 'file:///research/2026-09-05-some-video-transcript.md',
      'schema:encodingFormat': 'text/markdown',
      'scrum:contentHash': 'sha256:' + 'b'.repeat(64),
      dateCreated: '2026-09-05T18:05:00.000Z',
    },
    {
      '@id': RUN, '@type': 'prov:Activity',
      'scrum:op': 'research',
      'prov:startedAtTime': '2026-09-05T18:01:00.000Z',
      'prov:wasAssociatedWith': ['ada'],
      'prov:used': ['https://www.youtube.com/watch?v=EXAMPLE'],
      'prov:generated': [ART],
      'scrum:performedUsing': VER,
    },
  ],
});

const rows = (store, q) => queryGraph(store, q).rows;

test('#1206 the kinds are DECLARED, not merely projected', () => {
  for (const name of ['scrum:Procedure', 'scrum:ProcedureVersion']) {
    assert.ok(PROJECTED_TYPES.has(name), `${name} must be in the kind registry`);
    const k = kindByName(name);
    assert.ok(k.definition.length > 80, `${name} needs a real definition, not a restatement`);
    assert.ok(k.createdBy, `${name} must name the verb that makes one`);
  }
  // A Run is NOT a new class, deliberately. If someone adds scrum:Run later,
  // this fails and they have to argue for two shapes instead of getting them.
  assert.equal(kindByName('scrum:Run'), null,
    'a Run is a prov:Activity with scrum:op "research" — minting scrum:Run beside it would make '
    + '"everything that happened here" two queries, and one of them would get forgotten');
});

test('#1206 a procedure and its version project, linked by the of<Thing> house shape', () => {
  const store = buildGraphStore(fixture());
  const got = rows(store, `SELECT ?name ?body WHERE {
    ?v a scrum:ProcedureVersion ; scrum:body ?body ; scrum:ofProcedure ?p .
    ?p a scrum:Procedure ; schema:name ?name . }`);
  assert.equal(got.length, 1, 'the version must resolve to its procedure');
  assert.equal(got[0].name, 'research a YouTube video');
  assert.match(got[0].body, /primary sources/);
});

test('#1206 a run names the VERSION it followed, so it survives the method improving', () => {
  const store = buildGraphStore(fixture());
  const got = rows(store, `SELECT ?body WHERE {
    ?r a prov:Activity ; scrum:op "research" ; scrum:performedUsing ?v .
    ?v scrum:body ?body . }`);
  assert.equal(got.length, 1);
  assert.match(got[0].body, /Fetch the transcript/,
    'the run resolves to the text as it stood, not to whatever the procedure says now');
});

test('#1206 an artifact is a POINTER and a HASH — the bytes are not in the graph', () => {
  const store = buildGraphStore(fixture());
  const got = rows(store, `SELECT ?url ?fmt ?hash WHERE {
    ?r a prov:Activity ; scrum:op "research" ; prov:generated ?a .
    ?a schema:contentUrl ?url ; schema:encodingFormat ?fmt ; scrum:contentHash ?hash . }`);
  assert.equal(got.length, 1, 'prov:generated must resolve to the artifact');
  assert.match(got[0].url, /^file:\/\/\/research\//);
  assert.equal(got[0].fmt, 'text/markdown');
  assert.match(got[0].hash, /^sha256:[0-9a-f]{64}$/);
});

test('#1206 ⭐ NEGATIVE CONTROL — the run query cannot select the board\'s write activities', () => {
  const doc = fixture();
  const store = buildGraphStore(doc);

  // Project write activities of EVERY event op beside the run, exactly as the
  // event log would. On the live board there are ~19,900 of these.
  const events = [...EVENT_OPS].map((op, i) => ({
    seq: i + 1, actor: 'ada', op, entity: { kind: 'card', id: `u-${i + 1}` },
  }));
  projectActivities(store, events);

  const all = rows(store, 'SELECT ?r WHERE { ?r a prov:Activity }');
  assert.equal(all.length, events.length + 1,
    'the fixture must actually contain both populations, or this control proves nothing');

  const research = rows(store, 'SELECT ?r WHERE { ?r a prov:Activity ; scrum:op "research" }');
  assert.equal(research.length, 1, 'exactly the run, and none of the write activities');
  // Results come back SHORTENED to prefixed names, not as full IRIs. Asserting
  // the full IRI here failed while the control itself was already correct —
  // worth keeping as a comment, because the reverse mistake (comparing a
  // shortened value against a full IRI in a FILTER) returns a clean zero rather
  // than an error, and a clean zero reads exactly like "nothing matched".
  assert.equal(research[0].r, 'entity:run-1');
});

test('#1206 "research" can never arrive from the event log — the control is structural', () => {
  assert.ok(!EVENT_OPS.has('research'),
    'EVENT_OPS is a closed vocabulary validated on the write path. If "research" were ever added '
    + 'to it, the run query would silently start returning every write activity carrying that op, '
    + 'and "what research have we done" would answer with a large confident wrong number.');
});
