/**
 * #1624 — the MUTABLE K13 families: graph-held collections through #1598's transaction machinery (review 08:37Z). Each
 * family registers { key (the board collection), unique(entity) → the values the graph must guard, requires(entity) →
 * the subjects a write that SETS a reference needs, inherits(entity) → the cached entity whose references it copies,
 * routes (URL prefixes that read or write it) }. ONE definition, shared by the server and the migration scripts, so a
 * migrated entity is guarded exactly as a REST write would be. Wakes stay on their own lock-free path
 * (core/smallkinds-unit.mjs).
 */
export const RS_NS = 'https://scrumboard.local/ns#';

/** A stored reference → the graph subject that must exist: an IRI names itself; a bare id is a card (cards unit only). */
export function referencedSubjects(v, { cardsUnit }) {
  if (typeof v !== 'string' || !v) return [];
  if (/^https?:\/\//.test(v)) return [v];
  return cardsUnit ? [`https://scrumboard.local/entity/${v}`] : [];
}

export function collectionFamilies({ cardsUnit = false } = {}) {
  const refs = (v) => referencedSubjects(v, { cardsUnit });
  return [
    // definitions (rows: definitions-graph-d1). A predicate's and a kind's IRI is derived from its name, so a twin
    // registration is the same entity (a revision), never a second node. A model key is unique among models. A
    // procedure version is unique by its procedure AND its name ("<procedure> v<n>"), which is how the number is
    // allocated.
    { key: 'predicates', routes: ['/api/predicates'] },
    { key: 'kinds', routes: ['/api/kinds'] },
    { key: 'models', routes: ['/api/models'],
      unique: (e) => (typeof e['scrum:modelKey'] === 'string' ? [{ predicate: `${RS_NS}modelKey`, value: { type: 'literal', value: e['scrum:modelKey'] } }] : []) },
    { key: 'procedures', routes: ['/api/procedures', '/api/procedure-versions'],
      unique: (e) => (e['@type'] === 'scrum:ProcedureVersion' && typeof e['scrum:ofProcedure'] === 'string' && typeof e.name === 'string'
        ? [{ all: [{ predicate: `${RS_NS}ofProcedure`, value: { type: 'uri', value: e['scrum:ofProcedure'] } }, { predicate: 'https://schema.org/name', value: { type: 'literal', value: e.name } }] }] : []) },
    { key: 'runs', routes: ['/api/runs'] },
    // agents (rows: agents-graph-a1). An agent's IRI is derived from its seat key and a prompt version's from the seat
    // and its number, so a twin is a fresh-subject collision; the seat key is also unique among agents.
    { key: 'agents', routes: ['/api/agents'],
      unique: (e) => (typeof e['scrum:seatKey'] === 'string' ? [{ predicate: `${RS_NS}seatKey`, value: { type: 'literal', value: e['scrum:seatKey'] } }] : []) },
    { key: 'agentPrompts', routes: ['/api/agents'] },
    // artifacts (rows: artifacts-graph-k1). Adding one also adds it to its run's prov:generated, in ONE guarded update.
    { key: 'artifacts', routes: ['/api/artifacts'] },
    // tending (rows: tending-graph-g1): prompts, versions, playlists and their versions, mints, state. Every IRI is
    // derived, so a twin is a fresh-subject collision; a playlist version's ordered prompts are an RDF list.
    { key: 'tending', routes: ['/api/tending', '/api/tending-config'] },
    // talks, roles and obligations. A role and its versions REFERENCE their defining card (`scrum:definedBy`); an
    // obligation references what it is `about`. A write that SETS such a reference requires its target in the same
    // guarded update; the target can still be deleted later.
    { key: 'talks', routes: ['/api/talks'] },
    { key: 'roles', routes: ['/api/roles'], requires: (e) => refs(e['scrum:definedBy']) },
    { key: 'roleVersions', routes: ['/api/roles'], requires: (e) => refs(e['scrum:definedBy']), inherits: (e) => e['scrum:ofRole'] },
    { key: 'obligations', routes: ['/api/obligations'], requires: (e) => refs(e.about) },
  ];
}
