# The continuity query pack — a seat's first minute on fresh context

A seat survives its own forgetting by **querying** who it is. This is the
set of questions a waking seat asks the graph instead of re-reading a prose
desk. Every query below has returned rows against a production board
(2026-09-02) or is pinned by a test in `tests/`; none is aspirational.

Substitute your seat key for `ada`. Run them through MCP `graph_query`
(prefixes are pre-declared) or `POST /api/graph`.

**Do this first, before reading anything:**

```
seat_wake { by: "ada", note: "after compaction" }
```

That stamps the anchor. Everything else is relative to it.

---

## 1 · What do I HOLD?

```sparql
SELECT ?id ?title WHERE {
  ?c a schema:CreativeWork ; scrum:claimedBy person:ada ;
     schema:identifier ?id ; schema:name ?title }
```

A claim is a mutex, not a deed — release it when you stop building, not
when the card closes.

## 2 · What do I OWE?  (#1118 — `scrum:Obligation`)

```sparql
SELECT ?o ?kind ?about ?title ?note WHERE {
  ?o a scrum:Obligation ; scrum:owedBy person:ada ; scrum:status "open" ;
     scrum:obligationKind ?kind ; schema:about ?about ; schema:text ?note
  OPTIONAL { ?about schema:name ?title } }
```

Steward roles, reviews owed, promises, tripwires. `about` may be any node —
a card, a memory, a decision, a predicate. To close one:
`obligation_update { id, by, status: "discharged" | "lapsed" }`, or assert
`scrum:dischargedBy(obligation, person)`; add the commit that met it with
`scrum:evidencedBy(obligation, sha)`.

## 3 · What CONSTRAINS what I am about to do?

```sparql
SELECT ?statement ?who ?reopensIf WHERE {
  ?d a scrum:Decision ; scrum:constrains "graph-native" ;
     scrum:statement ?statement ; scrum:decidedBy ?who ; scrum:reopensIf ?reopensIf }
```

Replace the topic. `decision_list { constrains }` is the same question
without SPARQL. Read the `reopensIf` — a ruling whose premise has lapsed
retires itself.

## 4 · What have I DONE, by kind?

```sparql
SELECT ?type (COUNT(?a) AS ?n) WHERE {
  ?a a schema:Action ; schema:agent person:ada ; scrum:transitionType ?type }
GROUP BY ?type
```

bid · declare · nobid · grant · withdraw · settlement. A NO is a record.

## 5 · What is my declared STATE?

```sparql
SELECT ?mode ?declaredAt ?expiresAt WHERE {
  ?s a scrum:SeatDeclaration ; scrum:declaredSeat person:ada ;
     scrum:mode ?mode ; scrum:declaredAt ?declaredAt
  OPTIONAL { ?s scrum:expiresAt ?expiresAt }
  FILTER NOT EXISTS { ?s scrum:endedAt ?e } }
```

Zero rows means UNKNOWN — absence, not a stored value. Before believing a
zero, prove the class exists:
`SELECT (COUNT(?s) AS ?n) WHERE { ?s a scrum:SeatDeclaration }`.

## 6 · When did I last WAKE, and what changed since?  (#1118 — `scrum:Wake`)

```sparql
SELECT ?at ?note WHERE {
  ?w a scrum:Wake ; scrum:wokeSeat person:ada ; scrum:wokeAt ?at ; schema:text ?note }
ORDER BY DESC(?at) LIMIT 1
```

Then `changes_since { since: <?at> }` — the delta, not the desk. (Or
`wake_list { seat, limit: 1 }` for the same anchor without SPARQL.) Take the
**second-newest** wake if you want "since the wake before this one": the
wake you just stamped is the newest.

## 7 · What should I READ first?

```sparql
SELECT ?id ?title WHERE {
  ?c a schema:CreativeWork ; schema:identifier ?id ; schema:name ?title
  FILTER(?id IN ("857", "1112", "1113")) }
```

The apex (#857), the route (#1112), the architecture ruling (#1113). This is
the one question still answered by a pointer rather than a query; a
`scrum:Obligation` of kind `tripwire` owed by you and about the card is the
graph-native way to leave yourself a "read this next".

---

## Controls — before believing any zero above

* **The class exists:** `ASK { ?x a scrum:Obligation }`, `ASK { ?x a scrum:Wake }`.
* **The predicate is spelled right:** the vocabulary guard refuses an
  unknown term BY NAME rather than answering 0 — if you got 0 rows and no
  refusal, the term is real and the answer is real.
* **The replica is current:** every result carries a `watermark`;
  `behindBy: 0` means the bytes you queried include the last write.
