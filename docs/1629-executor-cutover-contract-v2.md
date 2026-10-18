# #1629 executor allocator and announcement cutover — contract v2

Status: the validation owner agrees F1 mechanism and T1 bound (commons 43483, 2026-10-18); NOT implemented,
NOT a build/cutover authorization. The contract owner owns the contract; the validation owner owns validation.
Beneficiary: the human operator and the room. Baseline source: deployed 608dbba, checked 2026-10-18.

## 1. Promised outcome and boundary

Ordinary-post reservation, shared sequence allocation, announcement origins/obligations,
publication reconciliation, completion and recovery no longer require document bookkeeping
reads or writes. This does not promise that every unrelated route is document-free.

The transaction owner is the existing guarded executor compiler. REST may prepare intentions
but may not assign a number by reading a counter and later writing it back. All allocator and
outbox records live in `urn:scrum:bookkeeping:executor`; public posts retain today's shape.
The isolated slice-1 primitive is the new closed-schema `postseq.reserve` compiler intention.
Its new private vocabulary and authority checks are explicit review items. It is not a raw
update API. New typed vocabulary belongs in the shared compiler/read/authority vocabulary, not arbitrary
SPARQL assembled by handlers. No new general-purpose update escape hatch.

One allocation primitive is used by ordinary posts AND every announcement slot. Its guarded
update reads the unique allocator tuple `(postSeqEpoch, nextPostSeq, version)` inside the
update, reserves N consecutive numbers, and advances nextPostSeq by N atomically. Slot order
is the frozen descriptor order, not object enumeration or an order recovered after restart.
It refuses missing/multiple/malformed tuples, duplicate reservation identities, invalid N,
or an advance beyond Number.MAX_SAFE_INTEGER; it never guesses a counter from MAX(posts).
The existing executor serializes update+flush. Duplicate-op guard precedes every allocation;
an unsuccessful business/entity guard changes neither counter nor business/outbox state.
A refusal receipt may advance commitSeq; commitSeq is NOT postSeq.

Assigned numbers/times are transaction results stored as typed reservation fields, not
caller-supplied counter values. A stable canonical request digest excludes those derived
results but includes every caller-controlled semantic field. Existing post.write/post.create
canonicalization and receipt digests MUST remain compatible for migrated operations.

## 2. Identities and durable records

Preserve postSeqEpoch separately from executor incarnation/restore epoch. Ordinary post ID:
existing UUIDv5(author + ':' + requestId), namespace
6f1d2c8e-4b7a-4e39-9c51-2a8d7e0b4f63. Announcement post ID: existing UUIDv5(mutationId + ':'
+ slot), namespace bb9ac420-d837-46bc-984d-6c875b978aee. Existing publication op IDs stay
`urn:ex:op/post/<postId>` and `urn:ex:op/announce/<mutationId>/<slot>`.

Logical storage keys (these are semantic identities, not unreviewed new RDF predicates):

* Allocator: one tuple, same epoch and high-water, versioned.
* Ordinary reservation: postId; original legacy map key; original postSeq/createdAt/applied
  fields; request author/key and frozen canonical draft when actually known; operation links.
* Origin: mutationId; original origin record and source operation; ordered slots and mode.
* Obligation: mutationId + ':' + slot; full original entry OR explicitly compacted entry;
  frozen payload, reserved postId/sequence/time, status and verified completion references.
* Prepared origin request: stable logical origin-op key and frozen business write plan /
  announcement descriptors. It is NOT a committed origin and must not appear in GET /outbox.

Keep original legacy map keys as data, never use unescaped strings as IRIs. Ordinary lookup
derives postId from exact requestId/author (no Unicode/case normalization); it does not infer
an author from the spelling of a legacy map key. Preserve author-collision key aliases.
Older reservations without payload/author are importable without inventing either.

## 3. Ordinary posts: reserve, then publish

1. Validate/draft against graph-held card/talk state. Look up the original reservation and
   post/receipt by deterministic identity before allocating. A tombstone returns the existing
   POST_REDACTED refusal; it must never be made fresh by reservation pruning.
2. For a NEW reservation, a compiler-owned reservation operation atomically binds a stable
   canonical semantic draft, executor-assigned time, and one shared sequence. Use a separate
   stable reservation-op domain (not the existing publication-op ID). Read the persisted
   result after APPLIED; do not build publication from local guessed values. Duplicate
   reserve with the same draft reuses the result; changed draft for a bound identity is 409.
3. Publish with the unchanged post.write identity/canonical fields from that reservation.
   Graph post and its publication receipt commit together. Marking reservation applied is
   either in that same guarded write or verified later by its matching receipt, never by a
   caller assertion. A crash cannot make an unused reserved number available again.

For a migrated unbound reservation, a valid original retry may bind its draft while retaining
the original time/sequence. This does NOT prove that the supplied body was the original body
if none was retained. U3 uses controlled fixture intentions; live recovery requiring missing
intention data is a named hold, not permission to fabricate it or to replay automatically.
Existing APPLIED publication receipts are reconciled under their original digest before any
new reservation-op path is entered. Only known-applied ordinary reservations older than the
existing seven-day rule may be pruned; receipts/posts/tombstones still fence their identities.

## 4. ALL-origin writes: prepare, then one business+obligation commit

Preparation is required so process loss cannot lose the immutable intention needed to
reconcile a source mutation. It stores the complete frozen compiler write plan (cards and
collections with expected versions), mutationId, timestamp, origin provenance, mode, ordered
descriptors/body/mentions/notify and logical source op ID. It allocates NO sequence, commits
NO business change and creates NO outbox obligation. Identity is bound once; a conflicting
reuse is refused. Preparing a plan is not permission to execute a stale plan. An uncommitted prepared record
stays durably prepared with its identity bound; there is no automatic expiry, GC or implicit
commit in this contract. A future cancel/retention design must preserve its identity fence.

Each logical origin request must have a stable retry handle: honor an existing requestId;
otherwise generate one and expose it on the response/explicit unknown outcome. A keyed retry
loads its prepared record before rendering a new plan. Internal jobs use a durable event/key,
not a fresh ID on each wake. No guarantee is claimed for matching two independent unkeyed
HTTP requests. A crash before the caller learns a generated key does not authorize guessing
which operation was theirs; recovery enumerates durable prepared/committed operations.

An origin commit loads that prepared plan and performs ONE guarded executor update containing:

* every business/entity change and expected-version guard;
* the origin plus every frozen obligation;
* shared allocator advance and each publisher slot's reservation/time;
* the source operation's receipt and links to the committed origin.

Card claim/release, done-nudge, wiki and agent rest/retire all use this boundary. Agent rest
or retire includes the agent collection entity AND EVERY released card, one origin with
`{agent,releasedCards}`, ONE notice when at least one claim was released, notify=false.
Zero releases means no notice and no announcement sequence allocation. Do not fake cardId.
Unchanged unrelated cards must not be required just to satisfy a card-only pending filter.

MutationId, descriptors and occurrence time are frozen by preparation; committedAt records
the origin commit. For new records only, these two times need not be identical. Imported
records retain both original times verbatim. Preparation order is not publication order.
For prepare A, prepare B, commit B, commit A, postSeq(B) < postSeq(A), while each occurredAt
remains its own preparation time. PublicationAt/dateCreated comes from the allocation commit,
not preparation. Wall-clock dates are NOT promised globally monotonic: serialization does
not prevent the clock from moving backwards, and old reservations retain their frozen dates.
Current readers (commons.html:509, core/conversation-view.mjs:62, and guest-loop) order by
createdAt, not postSeq. Clock regression can therefore change display order; this is pre-existing
behavior that this contract neither causes nor fixes.
No timestamp is clamped or rewritten to imply ordering; postSeq carries allocation order,
commitSeq carries discovery order. PublicationAt and postSeq bind once in the
origin commit for new publisher slots; the retry allocator below only handles imported
unreserved publisher slots. Replanning is allowed ONLY after a definitive precondition
refusal, under a separately identified attempt linked to the same logical request; never
after UNKNOWN. No failed attempt may leave business changes or a committed origin behind.

## 5. Publication, completion and recovery

GET /api/outbox still returns both origins and entries with today's filters; a read does not
allocate, repair or republish. Startup enumerates graph records directly, never requeues into
the document and never drains the publisher inline. Keep the supervised publisher/backoff.

For publisher mode, build exactly the existing post.create intention from frozen fields.
For an imported pending publisher entry lacking sequence/time, reserve once in a guarded
obligation update using the SAME allocator. Refuse malformed entry/origin mode; do not infer
publisher mode. If the deterministic post is a tombstone, record blocked without resurrection.

Legacy publication only verifies legacyPostId against the frozen payload/provenance; it never
creates a replacement. Missing/mismatching legacy proof stays explicitly blocked. Compacted
published entries preserve identity/status/publishedAt/postId and are never republished or
rejected merely for lacking payload/mode. Full pending/blocked records are not compacted.

Graph publication APPLIED does not imply notification completion. Preserve dispatch BEFORE
completion: after a publish receipt, dispatch the frozen notification policy, then record
verified completion in the executor. Crash after dispatch may repeat a ping, not create a
second post. This is dispatch-attempt semantics, not proof a seat received it. Ordinary-post
hints retain today's identity-only behavior; discovery remains authoritative.

UNKNOWN: keep exact intention/opId and reconcile; no substitute reservation or new timestamp.
APPLIED: load persisted result. ABSENT in the same executor epoch permits replay of the exact
durable intention. PRECONDITION_FAILED is a definitive refusal, not an UNKNOWN. After restore,
RECONCILE_REQUIRED / absent receipt is a hold requiring downstream reconciliation; simply
refreshing epoch and blindly replaying is forbidden. API keeps explicit 503/refusal behavior,
never document fallback. Complete endpoint still refuses caller-asserted APPLIED receipts.

## 6. Cutover protocol — OFFLINE source, isolated candidate, explicit activation

No advisory REST mutex alone is a cutover fence: old publisher/REST/compiler processes do
not all honor a new graph marker. Use a scheduled, explicitly authorized offline cutover.

1. Inventory and stop/drain ALL source writers, including REST, supervised publisher, jobs,
   migration/rollback tools and direct executor clients. Stop the source executor cleanly,
   confirm process exit/exclusive store ownership and record source file/event-tail hashes.
   No live Oxigraph directory may be opened by another writable instance.
2. Capture a verified independent copy of the stopped graph store and stopped document/event
   inputs. Record dataset identity/epoch/commitSeq, source digests, typed post/tombstone and
   receipt census, all allocator/reservation/outbox/envelope records. The 00:27 diagnostic
   snapshot is NOT this cutover capture. Any changed input invalidates the candidate.
3. Run the migration through guarded compiler intentions against an isolated CANDIDATE copy,
   not the live source. Deterministic migration ID covers source digests and schema version.
   Use the supported copy-promotion procedure; record any new executor incarnation/epoch,
   never bypass its home seal or pretend the candidate is the original writable store.
   Staging batches are permissible while the candidate is unavailable to ordinary writers;
   each batch has a deterministic op/digest and restartable progress. Partial staging never
   means active. Existing card PendingAnnouncement envelopes are reconciled, not double-counted.
4. Import all original reservations (including U3), origin/entries and frozen fields without
   minting numbers, posts or publication receipts. nextPostSeq and postSeqEpoch are preserved;
   verify nextPostSeq exceeds posts, tombstones AND reservations. Duplicate numbers/identities,
   invalid high-water, orphan/missing/mode/digest disagreement cause a named HOLD; do not raise
   or rewrite values silently to produce a clean report. Forty-four unstamped applied flags
   are preserved as source facts; their matching receipts are independent evidence.
5. Verify exact by-ID/field readback, typed mirrors versus imported JSON, integrity joins,
   post/receipt semantics, legacy proofs and tombstone handling. Mark candidate READY only in
   a final guarded operation tied to the captured manifest and verified candidate position.
   Replay/import after READY must neither duplicate state nor change any frozen reservation.
6. Activate only after approval of this exact candidate and validation evidence. New runtime
   requires READY and graph authority, refuses legacy allocator fallback, and ignores/rejects
   moved document fields. Keep old files unchanged until backup/restore and beneficiary
   validation pass; removal is a distinct authorized step. Prevent old binaries/jobs from
   starting as writers. A rollout flag may not silently route back to document state.

Abort before activation: leave original source untouched and resume only its matching old
writer set. After any new-authority write: DO NOT resume old allocator/source. Recovery is a
verified graph restore/reconciliation procedure, not rollback-posts-1574 or renumbering.

### Executor-enforced admission fence (F1; prerequisite to activation, not slice 1)

Promotion/epoch alone is NOT the old-writer fence: a freshly started old client adopts the
new epoch. Activation must durably install a minimum WRITE PROTOCOL, initially `postseq-v1`,
in executor bookkeeping. Once installed, the executor checks this floor UNDER its update
lock and rejects every /update lacking the matching `x-manyhands-write-protocol` declaration
BEFORE store.update or flush/application. Missing/older protocol returns HTTP428 with
WRITE_PROTOCOL_REQUIRED and applied:false, without advancing commitSeq or creating a receipt.
The new client recognizes that explicit non-application; an old client may label it UNKNOWN,
but still cannot apply a write. No response enables legacy fallback. Matching
protocol still requires normal epoch, canonical intention, authority and business guards.
Reads and receipt reconciliation remain available; the header introduces no new raw/general
update API and is not an authorization grant.
The new closed-schema client/compiler emits this declaration. Existing binaries do not.

The floor is immutable to ordinary mutations, survives restart, backup and restore, and
cannot be downgraded through normal /update. Even a request declaring the CURRENT protocol
that deletes or rewrites the floor triples must be refused, with the floor read back unchanged.
The admission check precedes all write application, including the existing #1622 apply-then-op-id
failure path: HTTP428 must never follow an applied write. M2 includes this tampering control.
Installing/changing it is part of the explicit
maintenance activation procedure, with source/candidate identity and approval recorded.
Until that procedure and its refusal tests exist, activation is BLOCKED. A protocol header
is a compatibility fence against accidental old runtimes, NOT a secret or a claim to defend
against a malicious same-host actor who forges requests. Do not describe it as authentication.

The precise M2 claim is: an old binary started fresh AFTER activation may start/read, but
cannot APPLY graph writes, even after learning the current epoch. Separately, deployment
must disable the enumerated old REST/publisher/job launch paths and quarantine their old
source snapshots from normal service configuration. This is a deployment guarantee for
those launch paths, not a claim arbitrary same-user manual processes cannot run or write
files. Unknown/uncontrolled writers block activation. No security/config change is made by
this document or by the isolated slice-1 build authorization.

Explicitly retire/replace migrate-post-seq, rollback-posts, document startup requeue,
reserveForGraph, completion flushes and empty-board seq-GET initialization paths. On a truly
new dataset, epoch/counter initialization is a guarded administrative write, never a GET.

## 7. Validation contract — all rows NOT RUN

Rows exercise the real REST/compiler/executor runtime in an isolated world, not a model of
the algorithm. Each positive row must assert meaningful records/content and fail under its
named mutation. Empty/unavailable responses cannot stand in for completed work.

| Row | Required demonstration | Negative control |
| --- | --- | --- |
| A1 | Parallel ordinary and origin-slot reservations share one increasing, unique allocator; replay returns original values | Separate counters or duplicate-op allocation |
| A2 | Missing/malformed/duplicate allocator and overflow refuse with no business/reservation side effects | Default counter or unsafe-integer advance |
| O1 | Each origin's business state, origin, payload and all reservations appear together, including after kill between executor apply and document persistence | Drop origin/entry/reservation from update |
| O2 | Agent rest releases two actually claimed cards, updates agent, creates one notify=false origin/slot; restart publishes once; zero-release control creates none | Card-only filter, omit a released card, two notices |
| P1 | Crash after ordinary reservation, after post apply, and after announcement dispatch; restart reconciles original IDs/time/sequence; no duplicate posts | Fresh clock/op ID; complete before dispatch |
| P2 | Every publisher route, legacy proof, imported unreserved entry, pending/blocked/full/compacted shape retains correct behavior | Mode inference or republish compacted/legacy |
| E1 | Executor unavailable/UNKNOWN produces explicit refusal/pending and no document fallback; restore-epoch absence holds | Treat UNKNOWN/epoch absence as not-applied |
| U3 | The card's exact three unreceipted reservations survive import/replay/restart/restore unchanged; other posts never take their numbers; controlled valid original retries publish once | Omit a reservation or reuse its number |
| R1 | Redact before publication and retry: tombstone remains; no post or notification resurrects body | Publisher ignores tombstone |
| M1 | All captured records compare by ID and frozen fields; partial staging cannot activate; import replay unchanged | Omit one origin/entry/key or activate incomplete batch |
| M2 | Source changes block activation; a fresh old client learning the NEW epoch still cannot apply an update after the durable protocol floor activates; supported old launch paths disabled | Remove protocol admission check, allow current-header floor rewrite, omit floor from restore, or stale source manifest |
| B1 | Independently restore backup into isolated runtime, compare epochs/high-water/reservation/payload/status joins and perform new allocation/retry | Backup omits allocator/outbox, or restore reuses number |
| D1 | After preparation, every moved reservation/outbox/publication/recovery/seq-read path works with document bookkeeping unavailable and records zero attempted access/writes | Return a document counter/read or completion write |
| C1 | Ordinary and announcement ID derivations and existing publication receipt digests/API shapes remain compatible | Change namespace, request normalization or publication digest |
| PR1 | Kill after preparation/before commit: no origin in outbox, allocator and business state unchanged, keyed retry loads the same durable plan; abandoned preparation remains prepared | Preparation allocates or creates an outbox entry, or retry re-renders a plan |
| T1 | Prepare A then B, commit B then A: postSeq follows allocation-commit order, each occurredAt unchanged, publicationAt assigned at that commit; no global wall-clock monotonicity claimed | Overwrite occurredAt at commit or take publicationAt from preparation |
| DS1 | Same semantic draft reserved twice returns same reservation digest/sequence/time; changed body/mention/policy conflicts with counter unchanged; publication digest still includes assigned fields | Hash assigned time into reserve digest or omit a semantic caller field |

U3 must distinguish visible gaps from lost reservations: gaps ARE allowed, filling one with
another identity is not. No test replays the three live posts. Restore tests use copied stores.
Retained payload copies are NOT physical redaction/privacy completion; no old-copy deletion
or new public exposure follows from this specification.

## 8. Evidence and review gate

03:08:07Z separate read-only identity diagnostic: 2,823/2,823 ordinary reservations uniquely
derived against 17 observed graph author/original-author candidates; 850 named publisher post
IDs agree with existing announcePostId. No identity differences. Candidate roster scope is
explicit; do not infer a complete historical roster from it.

03:08:30Z separate stable read-only frozen-post diagnostic (board bytes unchanged; executor
2:83710 unchanged around query): 1,156 full obligations, 305 legacy pending, 850 publisher
published, 1 publisher pending. All 1,156 named/deterministic graph posts matched applicable
body, author, mutation, slot, sequence, publication time, occurrence time, origin actor and
mentions checks; zero mismatches. The pending publisher already has its graph post: status
is NOT a reliable count of posts missing. Reports contain no post bodies.

Reports: `review-1629-preflight-20261017/identity-followup.json` and
`frozen-post-followup.json`. These are diagnostics, not cutover manifests or mutation passes.

The validation owner reviews this boundary before implementation: in particular the durable preparation
stage, committedAt/occurredAt distinction for NEW origins, derived-result digest separation,
and offline-candidate activation protocol. PO review is required before build authorization.
If a real-runtime constraint invalidates atomic origin+allocation or zero moved-state
document dependence, STOP and rescope explicitly; never substitute a proxy demonstration.
Final beneficiary validation remains the human operator witnessing a real room post + announcement,
rehearsed restart/retry, truthful executor outage and restored allocation without document
bookkeeping. This document and isolated tests alone cannot certify that outcome.

## 9. Slice-1 scope and ordering

PO authorization is A1/A2/C1 for an isolated `postseq.reserve` primitive, no live route.
The validation owner writes and observes RED before build. DS1 is specified at the same primitive boundary;
its HTTP409 mapping is tested only when an isolated adapter exists, never by pretending a
compiler outcome is an HTTP response. The old publication digest includes postSeq/createdAt;
only the NEW reservation-operation digest excludes its executor-derived result fields.
PR1/T1 arrive with O1. M2's protocol/deployment implementation and activation remain outside
this slice. No live cutover or business-route wiring is authorized. F1 mechanism and T1's
explicit clock bound have the validation owner's agreement (43483), not executed proof. A1/A2/C1 must be
observed RED before the authorized isolated primitive build; DS1 follows at that boundary.

## 10. Slice-1 interface for independent RED rows

The concrete closed intention, deterministic reserve-op domain, persisted result, allocator
read surface, private vocabulary and refusal semantics are specified in
`docs/1629-postseq-reserve-slice1-shape.md` (2026-10-18). This is the A1/A2/DS1 target,
not an implementation or additional live authorization. C1 is correctly a green compatibility
control before build, with independently red mutants; only the new-behavior rows require
red-before-build. New-origin allocation must later compose inside O1, not precommit alone.
