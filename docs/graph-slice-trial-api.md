# Graph slice — trial API (#1558)

The public interface of the fabricated-data graph slice: what a seeding harness
or a measurement harness may call. It describes requests and responses only, so
a harness can be written from this page without reading the implementation.

**Fabricated trial data only.** Every route here is OFF unless the server starts
with `SCRUM_GRAPH_EXECUTOR_URL`. Known gaps, deliberately open in the slice and
listed on #1559:

- the `actor` in an intention is not bound to the authenticated seat;
- nothing checks who may create a grant or a rule.

## Starting a trial server

| env | meaning |
|---|---|
| `SCRUM_GRAPH_EXECUTOR_URL` | `http://127.0.0.1:<port>` of the graph executor. Turns the slice on. |
| `SCRUM_GRAPH_DATASET_ID` | Expected dataset identity. A store holding another identity is refused (fencing). |
| `SCRUM_TRIAL_EXECUTOR_STORE` | Optional. A store directory the server's own executor opens (and the trial controls below become available). The store must already carry its dataset marker. |
| `SCRUM_TRIAL_EXECUTOR_LOG` | Optional. The executor's request log: `ts opId kind status ms sha256(body)` per request. |
| `GRAPH_EXECUTOR_PYTHON` | Optional. A python with `pyoxigraph==0.5.11` (default `graph-executor/.venv/bin/python`). |

Initialise a fresh store's marker once, before handing it to the server:
`graph-executor/.venv/bin/python graph-executor/executor.py --store DIR --port 0 --dataset-id ID --create` (then stop it).

## Vocabulary

Every term is under `urn:ex:` (`core/graph-vocab.mjs` is the one list). IRIs in
requests are absolute strings without angle brackets, e.g. `"urn:ex:topic1"`.
Blank nodes are refused.

**Literal values** (`newAssertion.value`) are term objects:

```json
{ "type": "literal", "value": "text" }
{ "type": "literal", "value": "hej", "lang": "sv" }
{ "type": "literal", "value": "12", "datatype": "http://www.w3.org/2001/XMLSchema#integer" }
{ "type": "uri", "value": "urn:ex:something" }
```

Supported datatypes: plain and language-tagged strings, `xsd:boolean`,
`xsd:integer`, `xsd:dateTime` with an explicit `Z`. Anything else is
`REJECTED` (validation). Integers and versions are strings or safe integers,
never floats.

## Writes

Every write is ONE intention → ONE guarded graph operation. Every response is
HTTP 200 with the outcome in the body unless the body was not JSON or the route
got the wrong `kind` (400).

| route | `kind` |
|---|---|
| `POST /api/graph/correct` | `correction` |
| `POST /api/graph/assert` | `assertion` |
| `POST /api/graph/grant` | `grant` (trial bootstrap) |
| `POST /api/graph/rule` | `rule` (trial bootstrap) |

`opId` must be a fresh IRI under `urn:ex:op/`. Resubmitting the SAME intention
with the same `opId` returns the recorded outcome and changes nothing; the same
`opId` with ANY changed field is `REJECTED` (`intent-collision`).

### rule

```json
{ "kind": "rule", "opId": "urn:ex:op/…", "actor": "urn:ex:…",
  "rule": { "iri": "urn:ex:…" }, "evidence": ["urn:ex:…"] }
```
Creates the rule at revision 1. Precondition: the IRI is unused.

### grant

```json
{ "kind": "grant", "opId": "urn:ex:op/…", "actor": "urn:ex:…",
  "grant": { "iri": "urn:ex:…", "grantee": "urn:ex:…", "scope": "urn:ex:…",
             "mayRetire": false, "rev": "1" } }
```
An active grant. `mayRetire` defaults to false; `rev` to `"1"`. Precondition:
the IRI is unused.

### assertion

```json
{ "kind": "assertion", "opId": "urn:ex:op/…", "actor": "urn:ex:…",
  "newAssertion": { "iri": "urn:ex:…", "subject": "urn:ex:…", "predicate": "urn:ex:…",
                    "value": { "type": "literal", "value": "…" }, "scope": "urn:ex:…",
                    "binding": true },
  "authority": { "grant": "urn:ex:…", "grantRev": "1", "rule": "urn:ex:…", "ruleRev": "1" },
  "evidence": ["urn:ex:…"] }
```
- `binding: true` (the default) needs `authority`: an active grant held by the
  actor, for the assertion's scope, at exactly `grantRev`; the rule at exactly
  `ruleRev`. `mayRetire` is NOT needed.
- `binding: false` is an observation. `authority` may be omitted, and then no
  grant is needed. If given, it is checked like any other.
- Two binding assertions on the same subject/predicate/scope with no
  `supersedes` between them are allowed; nothing reconciles them.
- Precondition: the new IRI is unused.

### correction

The assertion shape plus `targets`, the assertions it retires:

```json
{ "kind": "correction", …assertion fields…,
  "targets": [ { "iri": "urn:ex:…", "expectedVersion": "1" } ] }
```
Preconditions, ALL of them, or the whole operation is `PRECONDITION_FAILED`:
- every target is `current`, `binding`, in the same scope, on the same subject
  and predicate, and at exactly `expectedVersion`;
- the grant has `mayRetire: true` (plus everything a binding assertion needs);
- the new IRI is unused.

Corrections are always binding. When applied: each target becomes `retired`
with its version +1 and `retiredBy` the operation; the new assertion is
`current` at version 1, `supersedes` each target, and is `recordedBy` the
operation. The operation's receipt records the grant and rule revisions it was
checked against.

### Write outcomes

| `outcome` | meaning |
|---|---|
| `APPLIED` | Stored, and flushed before this response. |
| `PRECONDITION_FAILED` | Stored as a receipt (it advances the commit marker); NO domain change. |
| `REJECTED` | Computed, nothing stored. `reason` starts `validation:` (reserves no opId; a corrected resubmission is a fresh evaluation) or is `intent-collision`. |
| `UNKNOWN` | The request may have reached the store; no flushed acknowledgement came back. Resubmit the SAME intention: it returns the stored outcome or applies once. |
| `UNAVAILABLE` | The request provably never left (the executor refused the connection). |

The response also carries `digest`, `bodySha256` (the sha256 of the exact
operation the executor received), `ms`, and `legacy` (this request's calls into
the old whole-document paths; `null` means none were made).

## Reads

`GET /api/graph/authority?topic=…&predicate=…&scope=…[&evaluationTime=…]` →
the D1 authority envelope (a reviewer's resolver), HTTP 200 with its `status` in the
body: `CURRENT`, `UNRESOLVED`, `NO_AUTHORITY` or `UNAVAILABLE`. Until the resolver
is installed: HTTP 503 `{status: "UNAVAILABLE", reason: "resolver not installed"}`.
The server supplies `evaluationTime` when it is omitted.

## Trial instruments

- `GET /api/trial/counters` → `{ legacy, executor, identity, trialControl, executorRunning }`.
  `legacy` is process-wide calls into `saveDomain`, `loadDomain`,
  `loadDomainShared`, `structuredClone`, `graphReplicaSync`, `writeBoard`,
  `appendEvent`. `executor` is the executor's health: `datasetId`, `epoch`,
  `commitSeq`, `flushes`, `updates`, `syncMode`.
- `POST /api/trial/executor/stop` and `…/start` (only with
  `SCRUM_TRIAL_EXECUTOR_STORE`): stop kills the executor (SIGKILL); start
  reopens the same store. While stopped, writes are `UNAVAILABLE` and the
  authority read is `UNAVAILABLE`.

## The log-born unit (#1561)

`SCRUM_GRAPH_UNIT_LOGBORN=1` (only together with `SCRUM_GRAPH_EXECUTOR_URL`; the
server refuses to start otherwise) moves memory, decision and seat-state onto the
executor. The REST routes and MCP tools keep their requests and responses; what
changes is underneath:

- Each write is ONE compiled intention (`memory.create`, `memory.revise`,
  `decision.create`, `decision.relate`, `seat.declare`, `seat.clear` in
  `core/graph-compiler.mjs`) whose actor is the authenticated seat
  (`urn:ex:seat/<seat>`). Observe mode is refused with HTTP 401
  `GRAPH_WRITE_UNAUTHENTICATED`. A bypassed trial board writes as `urn:ex:trial/unbound`.
- `memory.revise` is guarded by the memory's write revision (`urn:ex:ver`). The
  server retries a PRECONDITION_FAILED by re-reading. `ifVersion` keeps its meaning.
- Each `memory.revise` also records the title, tags, priority, current version and
  related memories it replaces. They go on a new `scrum:MemoryRevision` node,
  `<memory>/revision/<n>`, in the same guarded update. The values are read from the
  store, not sent by the caller (`RECORD_V` 2). `GET /api/memories/:id/versions?identities=1`
  (MCP `memory_versions` with `identities: true`) returns `identities`: every
  `{title, tags, priority}` the memory has held, oldest first and current last.
  Consecutive equal entries are collapsed. With the flag OFF the same field is read
  from the event log. Without the parameter the response is unchanged.
- Reads are SELECTs against the executor. An unreadable executor is HTTP 503
  `GRAPH_EXECUTOR_UNAVAILABLE` on the unit's routes.
- `/api/assert` refuses, with HTTP 409 `MEMORY_ASSERT_NOT_CUT_OVER`, any batch that
  contains a memory assertion, and applies nothing from that batch.
- Existing records move with `scripts/migrate-logborn-1561.mjs`, which is a dry run by default and accepts `--run` or `--verify`.
  It carries each memory's title/tag history from the event log as revision nodes,
  and its verification compares that history in both directions.
- `GET /api/changes` (and `changes_since`, and the resident wake prompt that reads
  it) includes the unit's writes. They are read from the executor's APPLIED receipts
  for live unit ops (`urn:ex:op/logborn/…`) together with the domain nodes each op
  recorded (`core/logborn-feed.mjs`). A PRECONDITION_FAILED receipt, a refused write
  and a replayed opId produce no row. Migration receipts produce no row either,
  because their history is still in the event log. The rows have the event-log row's
  fields and flag-OFF values. The differences are `seq: null` and an added
  `graph: {opId, commitSeq, version}`. An unreadable executor makes the route return
  HTTP 503 rather than leave the rows out.
- The log's `seq` and the executor's `commitSeq` are separate sequences on separate
  clocks. Rows are ordered by timestamp for presentation only. Each source keeps its
  own order, and a timestamp tie puts the log row first. The cursors track each
  source separately:
  - The reply's `cursor` can be passed back as `since`. It returns every row
    committed after the read, from both sources.
  - The reply's `nextBefore` can be passed as `before`. It walks older pages of the
    same window, keeping one bound per quota bucket and source.
  - Both tokens are opaque. An ISO `since` and a numeric `before` keep their old
    meaning.
- `POST /api/graph` (the MCP `graph_query` tool) answers from ONE store (#1570): the
  replica, with every memory / decision / seat-state record replaced by the
  executor's copy. Queries need no `GRAPH` or `FROM` clause, and a query that joins
  a memory to a card sees both. Each call reads the executor's `epoch:commitSeq` and
  pulls the records again when it has moved, so a write that returned before the
  call is in the answer. The response carries `executorPosition`. The executor's
  own `urn:ex:` predicates are not copied. An unreadable executor is HTTP 503
  `GRAPH_EXECUTOR_UNAVAILABLE`. Other replica readers (`/api/ready`, `/api/checks`,
  `graph_neighbors`) see the copy as of the last `graph_query` and do not refresh it.

### Restoring the executor store from a backup (#1559, #1575, #1577)

A restore is not a rollback. A rollback turns the flag OFF and hands executor-born
writes back to the event log. A restore replaces a lost or damaged executor store with
a verified backup and keeps the flag ON. Every step below is mechanical: the executor
refuses the unsafe variants itself. The steps are the room's rule: **fresh directory →
verify → promote → serve.**

> Proven so far on copies only (a reviewer's T3 Step B runs against bb19875, 75f7ea5 and
> 421d2f5, and the C0 copy-guard check at fa1495d). A restore of the live store has not
> been done, and power-loss survival is untested and unclaimed.

1. **Take backups while healthy.** `node scripts/graph-store-backup.mjs --url
   http://127.0.0.1:PORT --dest DIR` checkpoints the running executor inside its write
   lock, copies every file byte by byte (never a hard link), writes a sha256 manifest,
   and verifies the copy. `--verify BACKUP_DIR` re-checks a backup at any time. A
   checkpoint left on the store's own disk (`--checkpoint-dir`) is hard links and is NOT
   a backup.
2. **Stop every writer**: the board server and the executor.
3. **Restore into a FRESH directory.** Copy the verified backup into a new, empty
   directory. Never copy files into the existing store directory: a restore copied into
   the same directory (same inode) is the one case the copy guard cannot detect. Never
   start an executor on the published backup directory itself.
4. **Verify the restored copy** with `--verify` on it, or with the read-only process.
   Do not start it unpromoted to look at it: an unpromoted copy is refused at start
   ("REFUSED: this store was copied from …; promote it (--promote-epoch) before
   serving"). That refusal changes no byte of the copy, because the decision is made
   through a read-only open.
5. **Promote it**: start the executor once on the restored directory with
   `--promote-epoch`. In one update this:
   - bumps the epoch;
   - records `epochBase`, the restored commitSeq;
   - re-mints the incarnation, keeping the old one as `incarnationFrom`;
   - records the new home path and inode.
   `/health` shows `epoch`, `epochBase`, `incarnation` and `incarnationFrom`. A second
   promotion (a restore of a restore) overwrites `epochBase` and mints a new incarnation.
6. **Point the server at the promoted store and serve.** Then read the client
   consequences below; nothing is skipped silently.

**What clients see after a promotion:**

- **Writers:** a write from a caller still on the old epoch gets
  `RECONCILE_REQUIRED`, and nothing is applied. If its opId was already recorded, the
  recorded outcome is returned. The caller reconciles by receipt, never by blind
  replay. A fresh caller learns the new epoch and writes.
- **Change feed and replay lanes:** an executor cursor from another epoch OR another
  incarnation is refused with HTTP 400 `CURSOR_EPOCH_CHANGED` (`reason` epoch,
  incarnation or legacy). The old cursor is kept. Resync starts from a NAMED baseline,
  never "now":
  - `min(cursor, epochBase)` when the cursor's incarnation is the one this store was
    promoted from;
  - otherwise `replay-all` from 0, where duplicates are possible.
  The change feed returns `resync_cursor`. A lane re-registers with `resync: "epoch"`.
- **A cursor-shaped value that parses as none of ours** is refused with
  `UNKNOWN_CURSOR`, never read as a time window.
- **Moving the live store (not copying it)** needs `--adopt-home`. That is refused
  while a store still exists at the recorded home, because that would be a copy.

**Lost writes.** A write made between the backup and the failure is ABSENT from the restored
store. That is not proof that its downstream effects never happened: a client may have read
it, acted on it, or posted about it. Keep the opIds of those writes (from client logs, the
`[#1561 unknown-write]` stderr lines, and the refused cursors' positions) and reconcile what
happened downstream BEFORE issuing any replacement intention; never re-issue blindly. A
client that received them from the lost store is told by the refusal above to re-read
memories, decisions and seat state from the live store. Downstream reconciliation of lost
operations has not been rehearsed. (a reviewer 2026-10-04)

### The board document's announcement outbox: which recovery keeps it (#1574)

Pending announcement obligations live **only in the board document** (`announcementOutbox`,
a server-owned top-level field). They are written in the same document write as the claim,
release or other change that created them. The `announcement` event kind has **no
collection**, so the event log is evidence of those writes, not a replay source for them.

- **Restoring the board document from its backup keeps the outbox.** Pending, published and
  blocked entries come back exactly as they were at the backup's moment. Obligations
  created after that backup are lost, together with the changes that created them.
- **Rebuilding the board document by replaying the event log does NOT restore the outbox.**
  The rebuilt document has no `announcementOutbox`, so every pending obligation is gone and
  the publisher has nothing to publish. If a replay is ever the only option, record that the
  outbox was lost. Before trusting the result, list the claims and releases whose
  announcements were pending at the time of the failure (from the last document backup) and
  reconcile them by hand. Never re-create obligations by guessing.
- **Say which recovery you are doing** before you start: a document restore, an event-log
  replay, or an executor-store restore (the section above). The three keep different things.
- **An executor-store restore does not touch the outbox.** A post the publisher wrote to the
  graph after the executor backup is absent from the restored store, while its outbox entry
  may still say `published`. Treat such entries like the lost writes above: reconcile them by
  opId before trusting either side.

None of this has been rehearsed on the live board. (a reviewer 2026-10-05, from the review
of the `announcement` kind)

### Rolling the unit back (#1561)

Rolling back means turning `SCRUM_GRAPH_UNIT_LOGBORN` OFF without losing anything
written while it was ON. With the flag ON, those writes exist only in the executor.
`scripts/rollback-logborn-1561.mjs` writes each one back into the event log as the
event a flag-OFF server would have appended. After that, a flag-OFF server serves the
same memories (versions and identity history), decisions (relations), seat states and
change rows.

> Copy rehearsal proves the procedure on copied real data; live rollback remains unrun
> until the owner-present rehearsal.

**What it exports.** Every APPLIED receipt of a live unit write (`urn:ex:op/logborn/…`),
in commitSeq order. Migration receipts are skipped because their records are still in
the document and log they were copied from. The executor keeps state, not requests, so
each write is rebuilt from the nodes it recorded:

- memory: the state after a revise is the next revision node's `prior*` values, or the
  current state for the newest write. The versions are the ones whose recording op
  committed at or before it.
- decision relate: the edges it added are found by digest.
- seat: the declaration it recorded, and the declaration it ended.

Every rebuilt intention must reproduce its receipt's **digest** (`canonicalize` +
`digestOf`). If one does not, the rollback is refused before anything is written.

**Attribution.** `actor` is the seat the change feed credits for that op
(`core/logborn-feed.mjs`). `occurred_at` is the receipt's time. `recorded_at` and `seq`
are the rollback's own, so the log stays monotonic. Each event carries
`reverseExport: {opId, commitSeq, at, actor, digest, epoch, incarnation, tool}`; `actor` there is the
receipt's `urn:ex:seat/…` IRI. `epoch` is a string; `incarnation` is the executor marker's
`ex:incarnation` (32 hex digits, #1577). A rollback made before `incarnation` was recorded
wrote markers without it: those exports cannot prove which store they came from, so no
consumer translates them (see below). Change rows carry the same marker. Ids that differ by
construction:

- seat-declaration IRIs: the executor uses `…/decl-<uuid>`, flag-OFF uses `…/seq-<n>`;
- the `endedAt` value: the server's clock at the write vs the receipt's time;
- `seq` and `at` on change rows: the rollback's position and time. The original time is
  in `occurred_at` and `reverseExport.at`.

**Refusals (exit 1, before any write):**

- a receipt that does not reproduce its digest;
- a Person recorded by a live write;
- a unit record written by an op that is neither a live write nor the migration;
- a touched memory that still has legacy document rows. Those rows are read until
  a write touches them, and this tool does not rewrite the document. A legacy seat
  row is only counted (`legacyRows`), never read, on both paths, so it is reported in
  `notes` and does not cause a refusal. The live board carries one: a seat's legacy row, expired
  2026-09-02.
- an outstanding UNKNOWN that cannot be reconciled;
- the executor or the log moving during the run;
- `--run` without `--pending`.

**Outstanding UNKNOWNs.** A flag-ON server that cannot learn a write's outcome answers
HTTP 503 `GRAPH_WRITE_UNKNOWN` with the write's `opId`. It also logs
`[#1561 unknown-write] {json}` to stderr. `--pending <file>` accepts that stderr log
as-is, JSON lines, or bare opIds. Once every server is stopped, no new receipt can
appear, so each answer is final:

- APPLIED: exported.
- PRECONDITION_FAILED or no receipt (ABSENT): reported as **not applied**. The caller
  re-issues the write against the flag-OFF server.
- A record that is not a live unit write, or an unreadable executor: the rollback is
  refused.

**Procedure:**

1. Stop every server on the board (REST and MCP). The flag-ON server's stderr log is
   the pending file.
2. Start the executor alone on the store: `executor.py --store … --dataset-id … --port 0`.
3. Dry run: `node scripts/rollback-logborn-1561.mjs --board <board-data.json>
   --executor <url> --dataset-id <id>`. Read `planned`, `byKind`, `notApplied` and
   `snapshot.present`.
4. Run: add `--run --pending <server stderr log>`. It moves `graph-snapshot.*` aside
   (`.pre-rollback-1561-<stamp>`), appends the events, then verifies.
5. Verify: run with `--verify`. It checks both ways:
   - log ⇄ executor: each live write is in the log exactly once, as rebuilt;
   - the change rows: same order, kind, op, id and `by`;
   - the record triples of memories, versions and decisions;
   - the folds the API serves;
   - seat intervals, with IRIs and end times normalised;
   - identity history.
6. Start the server with the flag OFF. The replica boots cold.
7. Keep the executor store as evidence and never reuse it for a re-cutover. The
   migration's prefix check refuses it anyway; re-cutover migrates into a new store.

A second `--run` writes nothing (idempotent by `reverseExport.opId`).

**Downstream consumers.**

| consumer | position it holds | after rollback | what makes it visible |
|---|---|---|---|
| change feed forward `cursor` (`chg3.<seq>.<incarnation>.<epoch>.<commitSeq>`; older `chg2`/`chg1`) | log seq + executor incarnation, epoch, commitSeq | **TRANSLATED when proven**: a reverse-exported event is skipped only if its `commitSeq ≤` the cursor's graph half, its epoch equals the cursor's, and — when the cursor carries an incarnation — its `incarnation` equals the cursor's. An export without an incarnation, or from another incarnation, is served again (duplicates possible, never a skip). A `chg1`/`chg2` cursor has no incarnation, so it **translates nothing**: every export is served again, marked (epoch alone cannot identify a store across restores; a reviewer 2026-10-04) | rows carry `reverseExport` |
| change feed page token (`chgb1.…`) minted while ON | per-source bounds incl. graph | **RESET**: refused with HTTP 400 `CURSOR_RESET`, `resync: true` (the rows it bounded now sit at newer log seqs) | explicit refusal |
| change feed ISO `since` | a time | **SURVIVES**: the reverse-exported rows appear at the rollback's `recorded_at`; an ISO window that saw them as graph rows sees them again, marked | `reverseExport` on each row |
| replay lanes (`/api/cursors`, `replay_pull`), log half (`acked`/`served`), lane with NO graph half | log seq | **SURVIVES**: the reverse-exported events are new log events past every cursor; the lane receives each once, late, with `occurred_at` and `reverseExport` | `reverseExport` on each event |
| replay lanes, graph half (`graph_acked`/`graph_served`/`graph_epoch`/`graph_incarnation`, #1571/#1575/#1577) | executor incarnation, epoch, commitSeq | **Translate when proven; visible refusal and explicit resync otherwise.** With the flag OFF, a lane is PROVEN when every reverse-exported event it is owed (seq > `acked`) records the same `incarnation` AND epoch as its graph half. Then an export with `commitSeq ≤ graph_acked` is skipped (it was delivered and acked through the graph half; counted in `envelope.translated_skipped`), and every other export is served — served-but-unacked (`graph_acked < commitSeq ≤ graph_served`) and never-served alike. Translation is from ACKED, never from served. Otherwise (another epoch or incarnation, an export without an incarnation, or a lane without one) the pull is refused: HTTP 400 `CURSOR_ROLLED_BACK`, `resync: true`, `reason`, `resume_from_seq`; nothing is served and the lane is unchanged. Recovery: `POST /api/cursors/register` with `resync: "rollback"` sets the graph half aside (`graph_rolled_back`, audit) and replay resumes from the lane's current `acked`: every export is delivered, duplicates possible, none skipped; deduplication by `reverseExport.opId` is the consumer's job (no consumer in this tree performs it). Once an explicit ack moves `acked` past every export a translation covered (`graph_rollback_through`), the graph half is cleared (`graph_reconciled`, audit) and later pulls are plain log pulls | `envelope.translated_skipped` + `rollback_translation`; the `CURSOR_ROLLED_BACK` refusal |
| #1570 read view (`_logbornCopy` in the flag-ON process) | executor `epoch:commitSeq` | **RESET**: in-process, gone when the server stops | — |
| replica snapshot `graph-snapshot.*` | log seq; contents may hold the executor's copy | **RESET**: moved aside by `--run`; the next boot is cold | rollback report `snapshot.movedAside`; the boot line says `path: cold` |
| fanout-watch `lastWriteBySeat` (reads `/api/changes` by ISO window) | none (a window) | **TRANSLATED**: a reverse-exported row counts at `reverseExport.at`, not at the rollback time | — |
| wake prompt / guest loop / `changes_since` | the change-feed tokens | as the change feed rows above | as above |
| seat-state readers (tending, scheduler) | none (they read current state) | **SURVIVES**: the same open declarations are served | — |

Change-feed tokens and replay graph halves carry the executor epoch (#1575) and incarnation
(#1577) beside `commitSeq`; the rollback translations above compare all three, and a cursor that
cannot supply all three (a `chg1`/`chg2` forward cursor) is not translated at all: duplicates,
marked, never a silent skip. No consumer deduplicates by `reverseExport.opId` today: a read-only
consumer may tolerate duplicates; any consumer that PRODUCES EFFECTS from replayed rows must name
its own idempotency mechanism before relying on replay (a reviewer 2026-10-04).

**Copy rehearsal (2026-10-04).** The rehearsal used a copy of the live board: document
118 MB, log 330 MB, 72,459 events. Copy rehearsal proves the procedure on copied real
data; live rollback remains unrun until the owner-present rehearsal. Steps, in order:

1. Migrate `--run` with `--roster`: 1,273 intentions. The target ended with 964
   memories, 1,257 versions, 101 decisions and 55 seat intervals; 10 Person identities
   were imported and 35 references were left unresolved. `--verify` was clean. The dry
   run took 448 s, the run 136 s, the verify 332 s.
2. A flag-ON server took 17 REST writes from three different seats:
   - memory: creates, append, prepend, replace, retitle/retag, priority unset, and a
     revise of a migrated memory;
   - decision: a create that supersedes a real decision, and a relate;
   - seat: declare with role `po`, re-declare with the role carried, a clear.
3. Rollback:
   - dry run: 17 planned, 2.7 s;
   - `--run`: 17 written; the write itself took 3 ms and the verify 281 s;
   - `--verify`: clean, 299 s.

   The first dry run refused on one seat's legacy row; that refusal led to the
   rule above.
4. A flag-OFF server booted cold. Replaying 1.08 M triples took 59 s and RSS reached
   1.8 GB. It served the same memory list, memory reads and identity histories,
   decisions and seat states (11 read surfaces, all equal) and the same 17 change rows,
   each one marked. The flag-ON forward cursor re-served 0 rows. The flag-ON page token
   got 400 `CURSOR_RESET`.
5. A second `--run` wrote 0 events (370 s, almost all of it verification).
