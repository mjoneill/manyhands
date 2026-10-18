/**
 * #1640 — rows for moving the label-alias map into the executor. TEST AUTHOR's, written before any build.
 *
 * Today the only writer is `POST /api/labels/aliases`, which writes the document collection `_labelAliases`; `aliasMap()` reads it for card creation and
 * `GET /api/labels/aliases`; the replica projects `schema:sameAs` triples from it and the executor does not. These rows are black-box: REST routes plus
 * direct reads of the executor's public dataset, so they do not care how the build stores the alias rows.
 *
 *   AL0  CONTROL, passes today: what must NOT change. Declare answers `{alias, canonical}`; GET answers `{aliases: {alias: canonical}}`; a self-alias, an alias or a
 *        canonical no card carries are 400; a chain collapses to the ultimate canonical at declaration; a spelling nobody declared is left exactly as sent.
 *   AL1  The executor's public dataset holds a `schema:sameAs` triple (concept IRI of the alias to concept IRI of the canonical) for EVERY declared alias, and not for an
 *        undeclared pair. RED today: the executor holds none.
 *   AL2  The document no longer carries `_labelAliases` after declarations, and GET still answers the whole map. RED today.
 *   AL3  Card creation uses the executor's aliases and NOT the file: with the file's alias rows removed, a new card with an aliased label is stored on the canonical one,
 *        and an undeclared spelling is untouched. RED today.
 *   AL4  A fresh REST process (cold start) on the same executor, with the file's alias rows removed, answers the same map. RED today.
 *   AL5  Re-declaring an alias to a different canonical REPLACES it: the executor holds the new triple and not the old, the count does not grow, GET shows the new target. RED today.
 *   AL7  #857's OWN FALSIFIER ROW holds on the executor: `ASK { ?a a schema:DefinedTerm ; schema:sameAs ?b }` (the apex's §IV row, verbatim) is FALSE before
 *        any declaration (so the row measures the declaration, not a triple some other writer left) and TRUE after one, and both ends of a declared
 *        link are typed schema:DefinedTerm, so an untyped IRI cannot satisfy it. RED today (added 2026-10-18 at 608dbba, after #1640's 00:23Z finding).
 *   AL6  PROPOSED, OPEN TO THE OWNER (it follows the pattern the card names, where an unreadable executor is a 503 and never an empty answer dressed as "none"): with the executor
 *        down, GET answers 503, not `{aliases: {}}`, and a declaration is refused, not written to the file alone. RED today.
 *
 * NOT covered, by name: the 8-triple count on the PRODUCTION data (that is the migration step's check, run on a copy of the real store); a PATCH to a card's labels (create only,
 * as today); the flag name (see the helper); concurrent declarations; the document-removal of `_labelAliases` on the PRODUCTION file (the live step, under the standing deploy go).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP, killExecutor } from './helpers/ready-world-1644.mjs';
import { labelBoard, labelWorld, concept } from './helpers/label-aliases-world-1640.mjs';

const LABELS = ['jsonld', 'json-ld', 'schema-org', 'schema.org', 'vtm', 'VTM', 'plain', 'plain-spelling'];
const T = { skip: SKIP, timeout: 600000 };
// The rows that need a STORED sameAs edge on the executor (AL1, AL5, AL7) wait on the owner's (a)/(b)/(c) choice on #1640: storing
// the edge needs a new, reviewed compiler permission (a shared concept carrying one owned triple). Reported on every run, never
// failing CI; delete SAMEAS_PENDING if (a) is chosen and built, or retire the three rows if it is not.
const SAMEAS_PENDING = { ...T, todo: "waits on the owner's (a)/(b)/(c) choice on #1640 (a stored sameAs edge needs a new compiler permission)" };

async function declared(w) {
  const a = await w.declare('jsonld', 'json-ld'); const b = await w.declare('schema-org', 'schema.org'); const c = await w.declare('VTM', 'vtm');
  for (const r of [a, b, c]) assert.equal(r.status, 200, `PRECONDITION: the declaration is accepted (${r.status}) ${r.text.slice(0, 120)}`);
  return { jsonld: 'json-ld', 'schema-org': 'schema.org', VTM: 'vtm' };
}

test('#1640 (AL0 CONTROL) the alias contract that must not change: declare, read, refusals, chain collapse, an undeclared spelling is left alone', T, async () => {
  await labelWorld(labelBoard(LABELS), async (w) => {
    await w.start();
    const d = await w.declare('jsonld', 'json-ld'); assert.equal(d.status, 200); assert.deepEqual(d.json, { alias: 'jsonld', canonical: 'json-ld' });
    assert.deepEqual((await w.aliases()).json, { aliases: { jsonld: 'json-ld' } });
    assert.equal((await w.declare('vtm', 'vtm')).status, 400, 'a concept cannot be its own synonym');
    assert.equal((await w.declare('jsonld', 'nobody-carries-this')).status, 400, 'a canonical no card carries is refused');
    assert.equal((await w.declare('nobody-carries-this', 'json-ld')).status, 400, 'an alias no card carries is refused');
    const chain = await w.declare('schema-org', 'jsonld'); assert.equal(chain.status, 200); assert.equal(chain.json.canonical, 'json-ld', 'a chain collapses to the ultimate canonical at declaration time');
    assert.deepEqual((await w.aliases()).json, { aliases: { jsonld: 'json-ld', 'schema-org': 'json-ld' } }, 'and the STORED map has the collapsed target, not the chain link');
    const made = await w.createCard('born on the canonical label', ['jsonld', 'plain-spelling']); assert.equal(made.status, 201, made.text.slice(0, 200));
    assert.deepEqual([...made.json.labels].sort(), ['json-ld', 'plain-spelling'], 'an aliased label is stored on the canonical one; an undeclared spelling is left exactly as sent');
  });
});

test('#1640 (AL1) the executor holds a sameAs triple for every declared alias, and none for an undeclared pair', SAMEAS_PENDING, async () => {
  await labelWorld(labelBoard(LABELS), async (w) => {
    await w.start(); const map = await declared(w);
    for (const [alias, canonical] of Object.entries(map)) assert.equal(await w.executorHasSameAs(alias, canonical), true, `the executor holds ${alias} sameAs ${canonical}`);
    assert.equal(await w.executorHasSameAs('jsonld', 'schema.org'), false, 'CONTROL: an undeclared pair has no triple');
    assert.equal(await w.executorHasSameAs('json-ld', 'jsonld'), false, 'CONTROL: and the link is not symmetric: only the declared direction');
    assert.equal(await w.executorSameAsCount(), Object.keys(map).length, 'exactly one triple per declared alias');
  });
});

test('#1640 (AL2) the document no longer carries _labelAliases after declarations, and GET still answers the whole map', T, async () => {
  await labelWorld(labelBoard(LABELS), async (w) => {
    await w.start(); const map = await declared(w);
    assert.equal(Object.hasOwn(w.readFile(), '_labelAliases'), false, 'board-data.json has no _labelAliases');
    assert.deepEqual((await w.aliases()).json, { aliases: map }, 'and the map is still served, from the executor');
  });
});

test('#1640 (AL3) card creation uses the executor\'s aliases and not the file: with the file\'s rows removed a new card is still born on the canonical label', T, async () => {
  await labelWorld(labelBoard(LABELS), async (w) => {
    await w.start(); await declared(w); w.dropFileAliases();
    const made = await w.createCard('born with the file\'s rows gone', ['jsonld', 'schema-org', 'plain-spelling']); assert.equal(made.status, 201, made.text.slice(0, 200));
    assert.deepEqual([...made.json.labels].sort(), ['json-ld', 'plain-spelling', 'schema.org'], 'aliased labels are stored canonical; the undeclared spelling is untouched');
    const read = await w.req('GET', `/api/cards/${made.json.shortId}`); assert.deepEqual([...read.json.labels].sort(), ['json-ld', 'plain-spelling', 'schema.org'], 'and that is what a read of the card returns');
  });
});

test('#1640 (AL4) a cold REST on the same executor, with the file\'s rows removed, answers the same map', T, async () => {
  await labelWorld(labelBoard(LABELS), async (w) => {
    await w.start(); const map = await declared(w); w.dropFileAliases();
    await w.start();   // a new REST process: nothing in memory
    assert.deepEqual((await w.aliases()).json, { aliases: map });
  });
});

test('#1640 (AL5) re-declaring an alias to another canonical replaces it: the new triple, not the old, and the count does not grow', SAMEAS_PENDING, async () => {
  await labelWorld(labelBoard(LABELS), async (w) => {
    await w.start(); await declared(w); const before = await w.executorSameAsCount();
    const r = await w.declare('jsonld', 'plain'); assert.equal(r.status, 200, r.text.slice(0, 160)); assert.equal(r.json.canonical, 'plain');
    assert.equal(await w.executorHasSameAs('jsonld', 'plain'), true, 'the executor holds the new target');
    assert.equal(await w.executorHasSameAs('jsonld', 'json-ld'), false, 'and no longer the old one');
    assert.equal(await w.executorSameAsCount(), before, 'one triple per alias, still');
    assert.equal((await w.aliases()).json.aliases.jsonld, 'plain');
  });
});

test('#1640 (AL6, PROPOSED) with the executor down, GET answers 503 and not an empty map, and a declaration is refused rather than written to the file alone', T, async () => {
  await labelWorld(labelBoard(LABELS), async (w) => {
    await w.start(); await declared(w);
    await killExecutor(w.exec);
    const g = await w.aliases(); assert.equal(g.status, 503, `GET answers 503 when the executor cannot be read (got ${g.status}: ${g.text.slice(0, 160)}); an empty map would read as "no aliases"`);
    const d = await w.declare('jsonld', 'plain'); assert.equal(d.status, 503, `a declaration is refused when the executor cannot be written (got ${d.status})`);
    assert.ok(!Object.hasOwn(w.readFile(), '_labelAliases') || w.readFile()._labelAliases.every((r) => r.canonical !== 'plain'), 'and nothing was written to the file instead');
  });
});

test('#1640 (AL7) #857\'s own falsifier row holds on the executor: false before any declaration, true after, with both ends typed DefinedTerm', SAMEAS_PENDING, async () => {
  await labelWorld(labelBoard(LABELS), async (w) => {
    const ASK857 = 'PREFIX schema: <https://schema.org/> ASK { ?a a schema:DefinedTerm ; schema:sameAs ?b }';
    await w.start();
    assert.equal(await w.executorAsk(ASK857), false, 'CONTROL: before any declaration, no DefinedTerm has a sameAs (the row measures the declaration)');
    await declared(w);
    assert.equal(await w.executorAsk(ASK857), true, '#857 \u00a7IV: after a declaration, a DefinedTerm carries a sameAs edge on the executor');
    const typed = `PREFIX schema: <https://schema.org/> ASK { <${concept('jsonld')}> a schema:DefinedTerm ; schema:sameAs <${concept('json-ld')}> . <${concept('json-ld')}> a schema:DefinedTerm }`;
    assert.equal(await w.executorAsk(typed), true, 'and the declared link joins two typed concepts: jsonld and json-ld are both schema:DefinedTerm');
  });
});
