# #1629 slice 1 — postseq.reserve interface for A1/A2/C1/DS1

Specification, 2026-10-18. NOT implemented; no live route/cutover authorization.
Extends contract v2 without changing existing post.write/post.create canonicalization.
The validation owner owns independent rows; the contract owner owns this interface. Existing compiler/client are the
entry points; no raw-update API is introduced. All new fields below are closed-schema.

## Intention and deterministic identity

```js
{
  kind: 'postseq.reserve',
  opId: reserveOpId(reservations),
  actor: 'urn:ex:seat/ada',
  reservations: [ /* nonempty, ordered, unique derived postIds */ ]
}
```

Only kind/opId/actor/reservations are allowed at the root. No nextPostSeq, expectedVersion,
postSeq, assignedAt, createdAt, publicationAt, arbitrary SPARQL, or arbitrary result is input.
N is reservations.length, not a caller-supplied independent count. The allocator is read and
advanced INSIDE the guarded executor update, never a client read-counter/write-counter loop.

Each item is exactly one of:

```js
{ mode: 'ordinary', author: 'ada', requestId: 'exact-original-token',
  draft: { body: 'hello', attachedTo: null, mentions: [], attachments: [],
           conversation: null, onBehalfOf: null } }
{ mode: 'announcement', mutationId: 'original-mutation-id', slot: 'claim',
  draft: { body: 'Ada claimed card 1', author: 'board', originActor: 'ada',
           occurredAt: '2026-10-18T03:00:00.000Z', mentions: ['ada'], notify: false } }
```

Ordinary draft allowed keys: body, attachedTo, mentions, attachments, conversation,
onBehalfOf, recovered, opId, origin, originalAuthorToken, authorCorrectedAt, authorCorrectedBy.
Their value validation/defaults match the corresponding existing post.write fields. body is
required. author is supplied ONLY on the item. derived id/createdAt/postSeq are forbidden.
The draft's optional opId is the existing POST PAYLOAD field, not the reserve operation ID.
Announcement draft allowed keys are exactly body/author/originActor/occurredAt/mentions/notify;
all are required, notify is boolean. This mode's mutationId/slot are the origin identity;
there is no fake cardId. Lists and optional-field canonicalization use the existing field
semantics, not a new Unicode/case policy. Unknown keys at any level refuse validation.

Export `reserveOpId(reservations)` from new `core/postseq-reserve.mjs`. Derive each postId
with the EXISTING ordinary/announcement UUIDv5 rule in v2. Identity vector is the ordered
array of `[mode, postId]` pairs. Operation ID is
`urn:ex:op/postseq/reserve/` + lowercase SHA256 of UTF-8 JSON.stringify(identityVector).
The helper excludes actor/draft/time/sequence, so a changed draft for the same ordered
identities collides at the SAME opId, rather than getting a fresh reservation. The compiler
recomputes and requires this opId. Duplicate derived postIds in a batch refuse validation.
Changing batch composition cannot overwrite an already-reserved identity: the all-or-nothing
absence guard refuses that new operation, without allocating any of its other items.

Canonical reserve digest binds kind, opId, actor, ordered identities and EVERY canonical draft
field, including mentions and notification policy. It excludes executor-assigned fields.
No change to old DIGEST_V/CANON_V or existing publication digest bytes is permitted.

## Persisted result and client outcome

Use existing `compile(intention)` / `createGraphClient(...).update(intention)` and existing
receipt outcomes. A repeated identical intention returns APPLIED via its original receipt;
changed draft/actor with the same opId returns REJECTED/intent-collision. No HTTP claim is
made without an actual adapter. PRECONDITION_FAILED leaves allocator and reservations unchanged;
its receipt/commitSeq may advance under existing executor semantics. UNKNOWN stays UNKNOWN.
PRECONDITION_FAILED is terminal for that exact reserve opId: repairing the allocator does
not make replay of that operation allocate. Reconcile/retry returns its original refusal.
This slice adds no reset/receipt deletion/automatic new attempt or batch-reshaping escape.
Any future explicit replanning-attempt API belongs to the later origin protocol and must
preserve the old terminal receipt; it is not permission to refresh identity after UNKNOWN.

The production compile path must call and PASS the existing staticCheck guard discipline.
The scratch satisfiability implementation skipping staticCheck is NOT a production template.
Use guarded subject/value variables and shared private vocabulary; do not weaken the checker
or omit its call to make the new kind pass. Add a structural negative control: an allocator
or reservation template write without its ok-guard must fail staticCheck.

APPLIED is followed by persisted readback, never a locally reconstructed allocation result:

```js
readPostSeqReservation(client, postId)
// {ok:true, reservation:{postId, mode, reserveOpId, reserveDigest,
//   postSeqEpoch, postSeq, createdAt, index, draft, identity}}
// identity ordinary: {author,requestId}; announcement: {mutationId,slot}
// index is the original zero-based batch slot; createdAt is allocation-commit time.
```

Export this helper from `core/postseq-reserve.mjs`. For announcements createdAt maps to
publicationAt in the later post.create adapter; occurredAt stays in the frozen draft.
Every item in a batch gets one executor-side NOW binding from that same guarded update;
no Node wall clock is used. Replays preserve exact persisted time/sequence/draft.
No helper may turn an unsuccessful/malformed read into APPLIED or substitute a fresh clock.
Missing reservation: `{ok:true,reservation:null}`. Transport/query failure:
`{ok:false,status:'UNAVAILABLE',reason}`. Malformed/duplicate stored reservation:
`{ok:false,status:'INVALID',reason}`; never silently pick one.

A same-identity request in a DIFFERENT batch does not independently allocate or pretend a
partial batch succeeded. Future route adapters may reconcile existing identical reservations
before choosing a batch; this primitive remains all-or-nothing.

## Allocator read surface and private vocabulary

Export `readPostSeqAllocator(client)` from the same module:

```js
{ok:true, allocator:{postSeqEpoch:'original-epoch', nextPostSeq:100, version:1}}
```

It uses the existing internal client.query SELECT with an explicit
`GRAPH <urn:scrum:bookkeeping:executor>` clause, NOT public-dataset REST /api/graph and NOT
the document. Missing/multiple/malformed allocator is `{ok:false,status:'INVALID',reason}`;
transport/query failure is UNAVAILABLE. Read helpers perform NO writes/repair/defaulting.
Do not include commitSeq in this read or imply the separate reservation/allocator reads are
one atomic snapshot. Tests can inspect unchanged domain state plus the existing receipt API.

Shared compiler/read/authority vocabulary: export `POSTSEQ_TERMS` in core/graph-vocab.mjs;
all following subjects and predicates are classified bookkeeping, never public domain data:

- allocator subject `urn:ex:postseq/allocator`, type `urn:ex:postseq/Allocator`;
- reservation subject `urn:ex:postseq/reservation/<derived-UUID>`, type `urn:ex:postseq/Reservation`;
- predicates under `urn:ex:postseq/`: postSeqEpoch, nextPostSeq, version, postId, mode,
  reserveOpId, reserveDigest, postSeq, createdAt, index, identityJson, draftJson.

Integer mirrors nextPostSeq/version/postSeq/index use xsd:integer (index may be zero);
createdAt uses xsd:dateTime; reserveOpId is an IRI. Epoch/postId/mode/digest and canonical
identityJson/draftJson are string literals. The reader validates cardinality, types, values,
and identity/digest joins rather than trusting JSON alone. Namespace classification changes
must be shared across JS compiler/read/authority and executor bookkeeping enforcement.
No unrestricted mutation of bookkeeping is authorized by adding this kind.

## Atomic guards and test setup

Exactly one allocator with one nonempty epoch and one positive safe integer nextPostSeq and
version is required. The update requires all target reservation identities absent, reserves
nextPostSeq+i in frozen item order, and atomically sets nextPostSeq+N and version+1. Reject
non-safe overflow of EITHER advance; do not reset, infer MAX, or skip corrupt rows. Therefore
an allocation whose resulting nextPostSeq would exceed MAX_SAFE_INTEGER refuses, even if
its last assigned number alone would fit. All inserts/advance/receipt are one commit.

For A1/A2 the test seeds the private allocator directly in the ISOLATED executor fixture,
through its existing trusted test setup path. There is NO production initializer/reset API
in this slice. A2 deliberately seeds missing/duplicate/malformed tuples and boundary values.
A1 races ordinary and announcement-mode batches against ONE allocator, then repeats exact
intentions; assert numbers, contiguous within-batch order, high-water/version and immutable
readback, not just APPLIED receipts. DS1 uses changed body, mentions and notify with same IDs.
C1 is a must-not-change control and may be GREEN before this build; its mutants must be RED.

Announcement-mode items in this slice demonstrate the shared primitive ONLY: they do not
create an origin/outbox record or wire a business route. In O1 a new origin must compose this
same allocation plan INSIDE its business+origin+obligation transaction; it must NOT commit a
standalone reservation first. Imported-unreserved publication retries may use the later
specified guarded reservation adapter. Legacy import/binding, live floor activation, and
business-route wiring remain outside slice 1.
