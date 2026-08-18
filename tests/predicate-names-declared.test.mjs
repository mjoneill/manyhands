/**
 * #875 — A RENAME BETWEEN THE STORE AND THE GRAPH MUST BE DECLARED.
 *
 * ⚰️ THE COST, MEASURED. Three times in one day, by all three seats, someone
 * searched one surface for the other surface's name, got nothing, and wrote up
 * a finding:
 *
 *   grep SOURCE for `isPartOf`      ⇒ "cards CANNOT set the hierarchy"     wrong
 *   grep STORE  for `parent`        ⇒ "no card USES the hierarchy"         wrong
 *   query `schema:additionalType`   ⇒ 0 rows from a field 795 cards carry  wrong
 *
 * ⇒ ⭐⭐⭐ A zero-row answer to the WRONG predicate is indistinguishable from a
 * zero-row answer to the right one. Both read as "the graph does not have this."
 *
 * ⛔ THIS TEST DOES NOT FORBID RENAMING, and that matters. `scrum:hasCheck`
 * reads better in SPARQL than `checks`; `scrum:assignee` is singular because
 * each value becomes its own triple. Those are good decisions and they should
 * stay legal. What must stop is a rename that only the projection knows about.
 *
 * ⚠️ AND THE AUTHOR OF THIS TEST COMMITTED THE DEFECT FOUR HOURS AFTER FILING
 * THE CARD ABOUT IT — `checks` → `scrum:hasCheck`, in the projection built to
 * catch claims that have gone false. Not inattention: the rename was chosen for
 * a good reason, which is the same reason the other five exist. That is what
 * makes it a class rather than a lapse, and why the guard is a test rather than
 * a note asking people to be careful.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREDICATE_SOURCE, RENAMED, STORED_NOT_PROJECTED } from '../core/predicate-names.mjs';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(PROJECT_DIR, 'core', 'graph-replica.mjs'), 'utf8');

/**
 * Every IRI the replica constructs, as a prefixed name.
 *
 * ⚠️ Reads the SOURCE rather than querying a built store, deliberately: a
 * predicate that no fixture happens to exercise would be invisible to a
 * query-based census, and the rarely-emitted ones are exactly where an
 * undeclared rename would hide.
 */
function emittedPredicates(src) {
  const out = new Set();
  const PREFIX = { S: 'scrum:', 'IRI.scrum': 'scrum:', SC: 'schema:', 'IRI.schema': 'schema:', 'IRI.prov': 'prov:' };
  for (const m of src.matchAll(/nn\((S|SC|IRI\.scrum|IRI\.schema|IRI\.prov)\s*\+\s*'([A-Za-z]+)'\)/g)) {
    out.add(PREFIX[m[1]] + m[2]);
  }
  return out;
}

const EMITTED = emittedPredicates(SRC);

test('#875 every predicate the replica emits is DECLARED with the store key it comes from', () => {
  const undeclared = [...EMITTED].filter((p) => !(p in PREDICATE_SOURCE)).sort();
  assert.deepEqual(
    undeclared, [],
    'These predicates are emitted by core/graph-replica.mjs and absent from\n'
    + 'core/predicate-names.mjs, so nothing tells a reader what STORE field they come\n'
    + 'from. A seat who greps the store for the predicate name gets zero rows and\n'
    + 'concludes the capability is missing — measured three times in one day. Found:\n'
    + undeclared.map((p) => `    ${p}`).join('\n')
    + '\n\n  Fix: add it to PREDICATE_SOURCE with its store key, or `null` if the\n'
    + '  projection mints it and no store field corresponds.\n',
  );
});

test('#875 the declaration does not drift the other way — nothing declared has vanished', () => {
  // ⭐⭐ THE INVERSE, AND IT IS THE HALF THAT FOUND SOMETHING. The forward check
  // above passed clean on the first run; this one fired immediately, on
  // `schema:isPartOf` — and the table was right. The GRAPH was missing it.
  //
  // Without this direction the table would quietly become an archive of names
  // the graph stopped emitting, and a reader looking one up would trust the
  // answer. A guard that runs one direction certifies the other.
  const known = Object.keys(PREDICATE_SOURCE)
    .filter((p) => !p.startsWith('prov:'))
    .filter((p) => !(p in STORED_NOT_PROJECTED));
  const gone = known.filter((p) => !EMITTED.has(p)).sort();
  assert.deepEqual(
    gone, [],
    'These are declared in core/predicate-names.mjs and no longer emitted by the\n'
    + 'replica. A stale entry answers "what does the graph call this?" wrongly:\n'
    + `${gone.join(', ')}\n\n`
    + '  If the predicate is stored but deliberately unprojected, move it to\n'
    + '  STORED_NOT_PROJECTED with the card that owns the gap — do not delete it,\n'
    + '  or "the graph lacks this" and "nobody projected this" become the same answer.\n',
  );
});

test('#875 ⛔ every STORED_NOT_PROJECTED gap is REAL — measured, not assumed', async () => {
  // ⭐⭐⭐ An exemption list is the easiest place in a codebase to hide a fixed
  // problem forever. So each entry must still be TRUE: the store carries the
  // field, and the replica does not emit the predicate. When someone closes the
  // gap this goes red and tells them to cross it off — the list cannot rot into
  // a record of things that stopped being wrong.
  const { buildGraphStore, queryGraph } = await import('../core/graph-replica.mjs');
  const { domainToJsonLd } = await import('../core/jsonld.mjs');
  const iri = (p) => p.replace('schema:', 'https://schema.org/').replace('scrum:', 'https://scrumboard.local/ns#');
  const rowsFor = async (store, predicate) => {
    const res = await queryGraph(store, `SELECT ?o WHERE { ?s <${iri(predicate)}> ?o }`);
    return (res.rows ?? res).length;
  };

  // ⭐⭐ POSITIVE CONTROL, FIRST. Every assertion below is an ABSENCE, and an
  // absence passes for free against a malformed query, a wrong IRI expansion,
  // or an empty store. So prove the same machinery FINDS a predicate that IS
  // projected before trusting it to report that another one is not.
  {
    const doc = domainToJsonLd({
      nodes: [
        { '@type': 'CreativeWork', '@id': 'c-1', identifier: 1, name: 'cites #2', text: 'see #2', board: {} },
        { '@type': 'CreativeWork', '@id': 'c-2', identifier: 2, name: 'cited', text: '', board: {} },
      ],
      messages: [], people: [], columns: [],
    });
    assert.ok(
      await rowsFor(await buildGraphStore(doc), 'scrum:mentionsCard') > 0,
      'control: the query machinery must FIND a predicate the replica does emit. '
      + 'If this fails, every "not projected" result below is the instrument, not a finding.',
    );
  }

  for (const [predicate, { storeKey }] of Object.entries(STORED_NOT_PROJECTED)) {
    // A fixture that DOES carry the store field, so a zero result can only mean
    // "not projected" and never "nothing to project" — the distinction this
    // whole file is about.
    const doc = domainToJsonLd({
      nodes: [
        { '@type': 'CreativeWork', '@id': 'u-parent', identifier: 1, name: 'parent', text: '', board: {} },
        { '@type': 'CreativeWork', '@id': 'u-child', identifier: 2, name: 'child', text: '', board: {}, [storeKey]: 'u-parent' },
      ],
      messages: [], people: [], columns: [],
    });
    const child = doc['@graph'].find((e) => e.identifier === 2);
    assert.ok(
      child[storeKey] != null,
      `setup: the fixture must actually carry ${storeKey}, or the assertion below `
      + 'measures an empty document rather than an unprojected field',
    );

    const store = await buildGraphStore(doc);
    const res = await queryGraph(store, `SELECT ?o WHERE { ?s <${predicate.replace('schema:', 'https://schema.org/').replace('scrum:', 'https://scrumboard.local/ns#')}> ?o }`);
    const rows = res.rows ?? res;
    assert.equal(
      rows.length, 0,
      `${predicate} is listed in STORED_NOT_PROJECTED but the replica NOW EMITS IT — `
      + 'the gap is closed. Move it into PREDICATE_SOURCE and delete the entry, so the '
      + 'exemption list stays a list of live gaps rather than a museum.',
    );
  }
});

test('#858 the membership SPINE is queryable — parent edges reach SPARQL', async () => {
  // ⚰️ 19 cards carried this edge in the store and ZERO queries could see it:
  // the agent-interface seam (#281), the upgrade episode (#395), the wiki-cron
  // cluster (#867) and a conference hierarchy. Phase 2 chose `parent` over
  // `relatedTo` specifically so a membership edge would stay distinguishable
  // from a relatedness edge forever — and then the distinction existed only on
  // a surface nobody queries.
  const { buildGraphStore, queryGraph } = await import('../core/graph-replica.mjs');
  const { domainToJsonLd } = await import('../core/jsonld.mjs');

  const doc = domainToJsonLd({
    nodes: [
      { '@type': 'CreativeWork', '@id': 'seam', identifier: 1, name: 'a seam', text: '', board: {} },
      { '@type': 'CreativeWork', '@id': 'kid', identifier: 2, name: 'a child', text: '', board: {}, isPartOf: 'seam' },
      { '@type': 'CreativeWork', '@id': 'loner', identifier: 3, name: 'unparented', text: '', board: {} },
    ],
    messages: [], people: [], columns: [],
  });
  const store = await buildGraphStore(doc);

  const kids = await queryGraph(store, `PREFIX schema: <https://schema.org/>
    SELECT ?id WHERE { ?c schema:isPartOf ?p . ?p schema:identifier "1" . ?c schema:identifier ?id }`);
  const rows = kids.rows ?? kids;
  assert.equal(rows.length, 1, `"what belongs to this seam?" must be answerable. got ${JSON.stringify(rows)}`);
  assert.equal(String(rows[0].id), '2');

  // ⭐ CONTROL: an unparented card must contribute nothing, or a projection that
  // emitted the edge for EVERY card would satisfy the assertion above while
  // making the spine meaningless.
  const all = await queryGraph(store, 'SELECT ?c WHERE { ?c <https://schema.org/isPartOf> ?p }');
  assert.equal((all.rows ?? all).length, 1, 'exactly one card is parented here — the edge is not minted for all');
});

test('#875 the parser can see predicates at all, and the RENAMED set is non-empty — controls', () => {
  // ⭐⭐ TWO controls, because each guards a different way of measuring nothing.
  //
  // A regex that matched nothing would make BOTH assertions above pass — the
  // first vacuously (no undeclared) and the second... loudly, actually, which is
  // itself a piece of luck rather than design. Pinning both.
  assert.ok(EMITTED.size > 30, `control: expected the replica's full predicate set, parsed ${EMITTED.size}`);
  assert.ok(EMITTED.has('scrum:cardType'), 'control: a known-renamed predicate must be found by the parser');
  assert.ok(EMITTED.has('schema:identifier'), 'control: a known same-named predicate must be found too');

  // And the point of the file: the renames are real and enumerable, not a story.
  assert.ok(
    RENAMED.length >= 5,
    `control: the defect this file exists for must be VISIBLE in the data — `
    + `expected several store↔replica renames, got ${JSON.stringify(RENAMED)}`,
  );
});

test('#875 the renames a reader would otherwise have to discover by grepping', () => {
  // Not a guard — a REGRESSION PIN on the specific instances that cost time, so
  // that if one is ever unified the table is updated rather than silently right
  // for the wrong reason.
  const map = Object.fromEntries(RENAMED.map((r) => [r.predicate, r.storeKey]));
  assert.equal(map['scrum:cardType'], 'additionalType', 'the one that returned 0 rows on 795 cards');
  assert.equal(map['scrum:mentionsName'], 'mentions', '#875\'s original subject');
  assert.equal(map['scrum:hasCheck'], 'checks', 'committed by this file\'s author, hours after filing the card');
  assert.equal(map['schema:isPartOf'], 'parent', 'the one that fooled two seats in opposite directions');
});
