"""#1558 graph executor: the ONE process that holds the embedded Oxigraph store.

Contract (D2 v1 §3, #1565; evidence #1555 T10/T11/T13):
  * one lock around update(); RocksDB itself refuses a second read-write process
  * flush() after EVERY update, inside the lock, BEFORE the acknowledgement:
    a replay that wrote nothing is flushed too (D2 proofs P6)
  * the outcome comes from the stored receipt (read back by opId), never from the
    engine's response: match and no-match both return success from update()
  * no in-process opId cache: the store is the only memory (proofs A2 §5)
  * no result cap on queries
  * localhost only; the dataset identity is checked at startup (fencing)

usage: python executor.py --store DIR --port N --dataset-id ID [--create] [--log FILE] [--exit-on-stdin-eof]
                           [--checkpoint-dir DIR] [--promote-epoch] [--adopt-home] [--read-only]
                           [--install-write-floor PROTOCOL] [--reconcile-postseq FILE]
"""
import argparse, hashlib, json, os, re, sys, threading, time, urllib.parse, uuid
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import pyoxigraph as px

NS = 'urn:ex:'
DATASET = px.NamedNode(NS + 'dataset')
# #1638 — every bookkeeping triple (the marker, receipts, the self-check probe, ver/recordedBy/entityJson)
# lives in this NAMED graph, which the public query dataset cannot reach. Domain stays in the default graph.
BK = 'urn:scrum:bookkeeping:executor'
def in_bk(pattern):
    return f'GRAPH <{BK}> {{ {pattern} }}'
LAYOUT_REFUSAL = ('REFUSED: store is in the pre-#1638 layout (its marker is in the default graph); '
                  'run graph-executor/migrate_bookkeeping.py --forward into a new store, then promote that store')
P_DATASET_ID = px.NamedNode(NS + 'datasetId')
P_EPOCH = px.NamedNode(NS + 'epoch')
P_COMMIT_SEQ = px.NamedNode(NS + 'commitSeq')
P_EPOCH_BASE = px.NamedNode(NS + 'epochBase')   # #1575 — the commitSeq the current epoch was promoted at
# #1577 — the store's INCARNATION: a random UUID minted at --create and RE-minted at every
# --promote-epoch (an ordinary restart keeps it). Two restores of one backup both promote to the
# same epoch with different histories; the incarnation is what tells them apart, so every
# executor cursor carries it. `incarnationFrom` = the incarnation the current one was promoted
# from (the only lineage a cursor can resync from exactly). `storeHome` = the realpath the store
# was created / promoted / adopted at: an ordinary start anywhere else is a COPY (it carries the
# original's incarnation, so cursors could not tell them apart) and is refused before any write.
P_INCARNATION = px.NamedNode(NS + 'incarnation')
P_INCARNATION_FROM = px.NamedNode(NS + 'incarnationFrom')
P_STORE_HOME = px.NamedNode(NS + 'storeHome')
# ...and the home DIRECTORY's inode: a restore copied INTO the home path (trash the live store, copy
# the backup to the same path) has the right path and a new directory. Inode only, not st_dev: a
# device number can change across mounts/reboots, which would refuse a healthy live store.
P_STORE_HOME_INODE = px.NamedNode(NS + 'storeHomeInode')
SYNC_MODE = 'flush'  # the observed acknowledgement level; F_FULLFSYNC is D3's, not built here
# #1748 (contract v2 F1, M2) — the WRITE PROTOCOL FLOOR. Once installed, every /update must declare exactly this protocol in
# PROTOCOL_HEADER, checked under the update lock BEFORE anything is applied or flushed: an old binary or job may start, read
# and learn the epoch, but cannot write. A compatibility fence against accidental old runtimes, not authentication.
FLOOR_S = px.NamedNode('urn:ex:write-floor')
FLOOR_P = px.NamedNode('urn:ex:write-floor/minProtocol')
PROTOCOL_HEADER = 'x-manyhands-write-protocol'
FLOOR_VIOLATION = 'urn:ex:write-floor/violation'   # #1748 a sentinel graph: never exists outside a refused update
FLOOR_INSTALLED_BY = px.NamedNode('urn:ex:write-floor/installedBy')   # #1748 written only by --install-write-floor
FLOOR_INSTALLER = 'install-write-floor'
# #1749 RESTORE SAFETY. A promoted restore of a store with a post-number allocator must not hand out a number until a
# recorded, human-approved reconciliation says where numbering resumes: the numbers issued after the backup died with the
# lost store, and may already be on posts. --promote-epoch writes the RECOVERY HOLD (in the same update as the epoch bump);
# the allocator guard refuses while it exists; only --reconcile-postseq <file>, a maintenance start on a stopped store,
# clears it, writing a ReconciliationRecord. The hold and every record are PROTECTED from /update (HOLD_PROTECTED).
PS = 'urn:ex:postseq/'
# #1749 (A7 v2, P2) the RECOVERY GRAPH: the hold and every ReconciliationRecord live here and nowhere else. It is
# AUTHORITATIVE: every reader reads only this graph, so a hold-shaped quad in any other graph is inert. Only
# --promote-epoch and --reconcile-postseq write it, at start; every /update is refused if it would change it (P1).
RG = PS + 'recovery'
def in_rg(pattern):
    return f'GRAPH <{RG}> {{ {pattern} }}'
XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer'
XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string'
HOLD_S = PS + 'recovery-hold'
HOLD_T = PS + 'RecoveryHold'
HOLD_EPOCH, HOLD_INCARNATION = PS + 'epoch', PS + 'incarnation'
HOLD_COMMIT_SEQ, HOLD_HIGH_WATER, HOLD_PRIOR_EPOCH = PS + 'restoredCommitSeq', PS + 'restoredHighWater', PS + 'priorHoldEpoch'
HOLD_PREDICATES = (HOLD_EPOCH, HOLD_INCARNATION, HOLD_COMMIT_SEQ, HOLD_HIGH_WATER, HOLD_PRIOR_EPOCH)
ALLOC_S, ALLOC_T = PS + 'allocator', PS + 'Allocator'
ALLOC_NEXT, ALLOC_VERSION = PS + 'nextPostSeq', PS + 'version'
RESERVATION_POSTSEQ = PS + 'postSeq'
POST_POSTSEQ = 'https://scrumboard.local/ns#postSeq'   # posts and their tombstones (RedactedPost) keep their number here
REC_T = PS + 'ReconciliationRecord'
REC_PREFIX = PS + 'reconciliation/'
REC = {k: PS + k for k in ('nextPostSeq', 'declaredGap', 'approvedBy', 'approvalRef', 'evidenceJson', 'evidenceSha256',
                           'fileSha256', 'reconciledAt', 'clearedHoldEpoch', 'clearedHoldIncarnation',
                           'clearedHoldCommitSeq', 'clearedHoldHighWater', 'priorNextPostSeq')}
RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
HOLD_VIOLATION = 'urn:ex:postseq/hold-violation'   # #1749 a sentinel graph: never exists outside a refused update
PERSON_IRI = 'https://scrumboard.local/person/'
MAX_SAFE = 2 ** 53 - 1
RECONCILE_KEYS = ('nextPostSeq', 'declaredGap', 'approvedBy', 'approvalRef', 'evidence', 'hold')
RECONCILE_HOLD_KEYS = ('datasetId', 'epoch', 'incarnation', 'restoredCommitSeq', 'restoredHighWater')
RECONCILE_EVIDENCE_KEYS = ('kind', 'location', 'sha256', 'maxPostSeqSeen')
# #1749 A8 THE DISPATCH HOLD. A held promotion records every obligation pending at promotion as an AmbiguousObligation in the
# recovery graph (it may already have been sent by the lost store; a restore cannot know). The compiled dispatch intentions
# refuse DISPATCH_HELD while it is "held"; only --dispose-obligation <file> settles it (published or retired), never
# releasing it to dispatch, and writes a DispositionRecord.
AO_T = PS + 'AmbiguousObligation'
AO_PREFIX = PS + 'ambiguous/'
AO = {k: PS + k for k in ('obligationIri', 'obligationId', 'mutationId', 'slot', 'payloadSha256', 'holdEpoch',
                          'holdIncarnation', 'state')}
AO_STATES = ('held', 'disposed')
DR_T = PS + 'DispositionRecord'
DR_PREFIX = PS + 'disposition/'
ORIGIN_NS = 'urn:ex:origin/'
OB_T = ORIGIN_NS + 'Obligation'
OB = {k: ORIGIN_NS + k for k in ('obligationId', 'mutationId', 'slot', 'status', 'reservation')}
RES_DRAFT = PS + 'draftJson'
ENTITY_IRI = 'https://scrumboard.local/entity/'
ANNOUNCE_POST_NAMESPACE = uuid.UUID('bb9ac420-d837-46bc-984d-6c875b978aee')   # core/announce-outbox.mjs announcePostId
SCHEMA = 'https://schema.org/'
SB = 'https://scrumboard.local/ns#'
POST_T = {'Comment': SCHEMA + 'Comment', 'RedactedPost': SB + 'RedactedPost'}
POST_P = {'text': SCHEMA + 'text', 'author': SCHEMA + 'author', 'postSeq': SB + 'postSeq', 'originOccurredAt': SB + 'originOccurredAt',
          'originMutation': SB + 'originMutation', 'originSlot': SB + 'originSlot', 'originActor': SB + 'originActor',
          'mentionsName': SB + 'mentionsName'}
XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean'
XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime'
DISPOSE_KEYS = ('obligationId', 'mutationId', 'slot', 'payloadSha256', 'lineage', 'currentStore', 'decision', 'notification',
                'notificationEvidence', 'approvedBy', 'approvalRef', 'note')
DISPOSE_OPTIONAL = ('notificationEvidence',)
DISPOSE_DECISIONS = {'settle-published': 'published', 'retire-unsent-unknown': 'retired'}
DISPOSE_NOTIFICATIONS = ('delivered-evidenced', 'not-delivered-evidenced', 'unknown')
DISPOSE_EVIDENCE_KINDS = ('notify-log', 'seat-cache', 'operator-statement')
UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
INSTANT_RE = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$')


def canonical_json(v):
    """#1749 P8-1 the agreed canonical JSON: object keys sorted recursively, arrays and every scalar as stored, no whitespace,
    UTF-8 (the JSON.stringify of the key-sorted value, which is what json.dumps with these options produces for JSON values).
    CAVEAT (#1758): sort_keys orders keys by code point, the JS canonicalJson by UTF-16 code unit; they agree for every key in the
    Basic Multilingual Plane and differ above U+FFFF. Every payload key today is an ASCII field name; #1758 makes both refuse."""
    return json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def sha256_hex(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def ao_subject(obligation_id):
    return AO_PREFIX + sha256_hex(obligation_id)


def announce_post_id(mutation_id, slot):
    return str(uuid.uuid5(ANNOUNCE_POST_NAMESPACE, f'{mutation_id}:{slot}'))
# The stdlib default listen backlog is 5. Measured in the D2 proofs (P5, 2026-10-04): with
# 8 concurrent writers, 5 connected at once and 3 waited ~30 ms for the OS to retry the
# connection. Correctness held, but concurrency was not exercised and latency carried a
# hidden tail. Callers are local and few; 128 removes the cliff without being unbounded.
LISTEN_BACKLOG = 128


class Server(ThreadingHTTPServer):
    request_queue_size = LISTEN_BACKLOG
    daemon_threads = True


def parse_args(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument('--store', required=True)
    ap.add_argument('--port', type=int, required=True)
    ap.add_argument('--dataset-id', required=True)
    ap.add_argument('--create', action='store_true',
                    help='initialise the marker in an EMPTY store; refused on a non-empty one')
    ap.add_argument('--log', default=None)
    ap.add_argument('--promote-epoch', action='store_true',
                    help='this store is a RESTORE being promoted: bump the epoch before serving, so writes from '
                         'callers still on the old epoch are refused with RECONCILE_REQUIRED (#1559, D1 v0.2)')
    ap.add_argument('--adopt-home', action='store_true',
                    help='#1577: this store was MOVED (not copied): record its current path as its home and keep its '
                         'incarnation. Refused while a store still exists at the recorded home (that is a copy: '
                         'promote it with --promote-epoch instead)')
    ap.add_argument('--read-only', action='store_true',
                    help='#1638: serve reads only. Opens the store read-only (nothing in the directory changes), skips '
                         'the startup self-check, and refuses every /update with 503 READ-ONLY. A fence for a store '
                         'that must not change (a cutover, a rollback copy). Not combinable with --create, '
                         '--promote-epoch or --adopt-home.')
    ap.add_argument('--install-write-floor', default=None, metavar='PROTOCOL',
                    help='#1748: install the WRITE PROTOCOL FLOOR before serving (the maintenance-activation hook): from then '
                         'on every /update must declare it in x-manyhands-write-protocol, or is refused 428 before anything is '
                         'applied. Installing the SAME protocol again is a no-op; a different one on a floored store refuses '
                         'to start. The floor survives restart, backup and promoted restore.')
    ap.add_argument('--reconcile-postseq', default=None, metavar='FILE',
                    help='#1749: a MAINTENANCE START on a stopped store: clear the recovery hold a promoted restore wrote, by the '
                         'human-approved declared gap in FILE (closed schema), in ONE store transaction that sets nextPostSeq '
                         'and writes a ReconciliationRecord, then serve. Any refusal (NO_HOLD, WRONG_LINEAGE, WRONG_HOLD, '
                         'BAD_GAP, BELOW_EVIDENCE, BELOW_NEXT, BAD_FILE) refuses to start with the store unchanged. Rerunning '
                         'the SAME file on the reconciled store writes nothing and serves (ALREADY reconciled).')
    ap.add_argument('--dispose-obligation', default=None, metavar='FILE',
                    help='#1749 A8: a MAINTENANCE START on a stopped store: settle ONE obligation a held promotion recorded as '
                         'AMBIGUOUS, by the operator\'s closed-schema FILE: settle-published (only with its post verified in THIS '
                         'store) or retire-unsent-unknown, in ONE transaction that also marks the AmbiguousObligation disposed '
                         'and writes a DispositionRecord; nothing is ever dispatched. Any refusal (BAD_FILE, WRONG_OBLIGATION, '
                         'POST_UNVERIFIED, NOT_AMBIGUOUS) refuses to start with the store unchanged; the SAME file again serves '
                         '(ALREADY disposed).')
    ap.add_argument('--exit-on-stdin-eof', action='store_true',
                    help='exit when stdin closes: a parent that dies (even by SIGKILL) takes the executor with it')
    ap.add_argument('--checkpoint-dir', default=None,
                    help='where POST /checkpoint writes RocksDB checkpoints (default: <store>.checkpoints). '
                         'Keep it on the store\'s disk: a checkpoint there is HARD LINKS, cheap, and NOT a backup '
                         'by itself; scripts/graph-store-backup.mjs copies it off into an independent directory.')
    return ap.parse_args(argv)


def term_json(t):
    if isinstance(t, px.NamedNode):
        return {'type': 'uri', 'value': t.value}
    if isinstance(t, px.BlankNode):
        return {'type': 'bnode', 'value': t.value}
    out = {'type': 'literal', 'value': t.value}
    if t.language:
        out['xml:lang'] = t.language
    elif t.datatype and t.datatype.value != 'http://www.w3.org/2001/XMLSchema#string':
        out['datatype'] = t.datatype.value
    return out


class Degraded(Exception):
    def __init__(self, info):
        super().__init__(info.get('reason'))
        self.info = info


class MarkerUnsound(Exception):
    """The commit marker is contradictory: nothing that reports a commit position may proceed."""


class ProtocolRequired(Exception):
    """#1748 — the request did not declare the installed write protocol: refused before anything is applied."""


class FloorProtected(Exception):
    """#1748 — the update would delete, rewrite or contradict the installed floor: refused before anything is applied."""


class HoldProtected(Exception):
    """#1749 — the update would delete, rewrite or add a triple on the recovery hold or a reconciliation record: refused
    before anything is applied, whatever protocol it declares."""


class ReconcileRefused(SystemExit):
    """#1749 — a --reconcile-postseq start that refuses: the store is unchanged and the process does not serve."""
    def __init__(self, code, detail):
        super().__init__(f'REFUSED: {code}: {detail} (--reconcile-postseq; the store is unchanged)')
        self.code = code


def _safe_int(v, minimum):
    """A JSON integer (never a bool, a float or a string) that is a safe integer at or above `minimum`."""
    return type(v) is int and minimum <= v <= MAX_SAFE


def _plain_str(v):
    return isinstance(v, str) and v != '' and v == v.strip() and not any(ord(ch) < 0x20 for ch in v)


def parse_reconcile_file(path):
    """#1749 (contract A6) the CLOSED reconcile schema. Returns (doc, canonical sha256) or raises ReconcileRefused BAD_FILE.
    The canonical form is the parsed document as JSON with sorted keys, no whitespace and UTF-8: it binds every field,
    the `hold` block included, so a ReconciliationRecord names exactly the file it applied."""
    bad = lambda why: ReconcileRefused('BAD_FILE', why)
    try:
        with open(path, 'rb') as f:
            raw = f.read()
        doc = json.loads(raw.decode('utf-8'), parse_constant=lambda c: (_ for _ in ()).throw(ValueError(f'{c} is not JSON')))
    except (OSError, UnicodeDecodeError, ValueError) as e:
        raise bad(f'the file could not be read as JSON: {e}')
    if not isinstance(doc, dict):
        raise bad('the file is not a JSON object')
    def closed(obj, keys, what):
        extra, missing = sorted(set(obj) - set(keys)), sorted(set(keys) - set(obj))
        if extra or missing:
            raise bad(f'{what}: ' + '; '.join(x for x in (f'unknown key(s) {extra}' if extra else '',
                                                          f'missing key(s) {missing}' if missing else '') if x))
    closed(doc, RECONCILE_KEYS, 'the reconcile file')
    if not _safe_int(doc['nextPostSeq'], 1):
        raise bad('nextPostSeq must be a safe JSON integer >= 1')
    if not _safe_int(doc['declaredGap'], 1):
        raise bad('declaredGap must be a safe JSON integer >= 1')
    ab = doc['approvedBy']
    if not (_plain_str(ab) and ab.startswith(PERSON_IRI) and len(ab) > len(PERSON_IRI)
            and not any(ch in ab[len(PERSON_IRI):] for ch in '/<>"{}|\\^` ')):
        raise bad(f'approvedBy must be a person IRI ({PERSON_IRI}<seat>)')
    if not _plain_str(doc['approvalRef']) or any(ch.isspace() for ch in doc['approvalRef']):
        raise bad('approvalRef must be a non-empty decision id string')
    if not isinstance(doc['evidence'], list):
        raise bad('evidence must be an array')
    for k, ev in enumerate(doc['evidence']):
        if not isinstance(ev, dict):
            raise bad(f'evidence[{k}] must be an object')
        closed(ev, RECONCILE_EVIDENCE_KEYS, f'evidence[{k}]')
        if not _plain_str(ev['kind']) or not _plain_str(ev['location']):
            raise bad(f'evidence[{k}].kind and .location must be non-empty strings')
        if not (isinstance(ev['sha256'], str) and len(ev['sha256']) == 64 and all(ch in '0123456789abcdef' for ch in ev['sha256'])):
            raise bad(f'evidence[{k}].sha256 must be 64 lowercase hex characters')
        if not _safe_int(ev['maxPostSeqSeen'], 0):
            raise bad(f'evidence[{k}].maxPostSeqSeen must be a safe JSON integer >= 0')
    h = doc['hold']
    if not isinstance(h, dict):
        raise bad('hold must be an object')
    closed(h, RECONCILE_HOLD_KEYS, 'hold')
    for key in ('datasetId', 'epoch', 'incarnation'):
        if not _plain_str(h[key]):
            raise bad(f'hold.{key} must be a non-empty string')
    for key in ('restoredCommitSeq', 'restoredHighWater'):
        if not _safe_int(h[key], 0):
            raise bad(f'hold.{key} must be a safe JSON integer >= 0')
    canon = json.dumps(doc, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    return doc, hashlib.sha256(canon).hexdigest()


class DisposeRefused(SystemExit):
    """#1749 A8 — a --dispose-obligation start that refuses: the store is unchanged and the process does not serve."""
    def __init__(self, code, detail):
        super().__init__(f'REFUSED: {code}: {detail} (--dispose-obligation; the store is unchanged)')
        self.code = code


def _hex64(v):
    return isinstance(v, str) and len(v) == 64 and all(ch in '0123456789abcdef' for ch in v)


def parse_dispose_file(path):
    """#1749 A8 AUTHORITATIVE SCHEMA, the CLOSED --dispose-obligation file. Returns (doc, canonical sha256) or raises
    DisposeRefused BAD_FILE. An obligationId that is not its own <mutationId>:<slot> is BAD_FILE (ruling 2)."""
    bad = lambda why: DisposeRefused('BAD_FILE', why)
    try:
        with open(path, 'rb') as f:
            raw = f.read()
        doc = json.loads(raw.decode('utf-8'), parse_constant=lambda c: (_ for _ in ()).throw(ValueError(f'{c} is not JSON')))
    except (OSError, UnicodeDecodeError, ValueError) as e:
        raise bad(f'the file could not be read as JSON: {e}')
    if not isinstance(doc, dict):
        raise bad('the file is not a JSON object')
    def closed(obj, keys, what, optional=()):
        extra = sorted(set(obj) - set(keys))
        missing = sorted(set(keys) - set(optional) - set(obj))
        if extra or missing:
            raise bad(f'{what}: ' + '; '.join(x for x in (f'unknown key(s) {extra}' if extra else '',
                                                          f'missing key(s) {missing}' if missing else '') if x))
    closed(doc, DISPOSE_KEYS, 'the dispose file', DISPOSE_OPTIONAL)
    for key in ('obligationId', 'mutationId', 'slot', 'note'):
        if not isinstance(doc[key], str) or not doc[key]:
            raise bad(f'{key} must be a non-empty string')
    if not UUID_RE.match(doc['mutationId']):
        raise bad('mutationId must be a lowercase UUID')
    if not _plain_str(doc['slot']):
        raise bad('slot must be a non-empty string without control characters or surrounding space')
    if doc['obligationId'] != f'{doc["mutationId"]}:{doc["slot"]}':
        raise bad(f'obligationId {doc["obligationId"]!r} is not its own mutationId:slot ({doc["mutationId"]}:{doc["slot"]})')
    if not _hex64(doc['payloadSha256']):
        raise bad('payloadSha256 must be 64 lowercase hex characters')
    lin = doc['lineage']
    if not isinstance(lin, dict):
        raise bad('lineage must be an object')
    closed(lin, ('holdEpoch', 'holdIncarnation'), 'lineage')
    if not all(_plain_str(lin[k]) for k in ('holdEpoch', 'holdIncarnation')):
        raise bad('lineage.holdEpoch and lineage.holdIncarnation must be non-empty strings')
    cs = doc['currentStore']
    if not isinstance(cs, dict):
        raise bad('currentStore must be an object')
    closed(cs, ('datasetId', 'epoch', 'incarnation'), 'currentStore')
    if not all(_plain_str(cs[k]) for k in ('datasetId', 'epoch', 'incarnation')):
        raise bad('currentStore.datasetId, .epoch and .incarnation must be non-empty strings')
    if doc['decision'] not in DISPOSE_DECISIONS:
        raise bad(f'decision must be one of {sorted(DISPOSE_DECISIONS)}')
    if doc['notification'] not in DISPOSE_NOTIFICATIONS:
        raise bad(f'notification must be one of {list(DISPOSE_NOTIFICATIONS)}')
    if doc['notification'] == 'unknown':
        if 'notificationEvidence' in doc:
            raise bad('notificationEvidence is FORBIDDEN when notification is "unknown"')
    else:
        ev = doc.get('notificationEvidence')
        if not isinstance(ev, list) or not ev:
            raise bad(f'notificationEvidence is REQUIRED and non-empty when notification is {doc["notification"]!r}')
        for k, e in enumerate(ev):
            if not isinstance(e, dict):
                raise bad(f'notificationEvidence[{k}] must be an object')
            closed(e, ('kind', 'location', 'sha256', 'observedAt'), f'notificationEvidence[{k}]')
            if e['kind'] not in DISPOSE_EVIDENCE_KINDS:
                raise bad(f'notificationEvidence[{k}].kind must be one of {list(DISPOSE_EVIDENCE_KINDS)}')
            if not _plain_str(e['location']):
                raise bad(f'notificationEvidence[{k}].location must be a non-empty string')
            if not _hex64(e['sha256']):
                raise bad(f'notificationEvidence[{k}].sha256 must be 64 lowercase hex characters')
            if not isinstance(e['observedAt'], str) or not INSTANT_RE.match(e['observedAt']):
                raise bad(f'notificationEvidence[{k}].observedAt must be an ISO-8601 instant with a zone')
    ab = doc['approvedBy']
    if not (_plain_str(ab) and ab.startswith(PERSON_IRI) and len(ab) > len(PERSON_IRI)
            and not any(ch in ab[len(PERSON_IRI):] for ch in '/<>"{}|\\^` ')):
        raise bad(f'approvedBy must be a person IRI ({PERSON_IRI}<seat>)')
    if not _plain_str(doc['approvalRef']) or any(ch.isspace() for ch in doc['approvalRef']):
        raise bad('approvalRef must be a non-empty string with no whitespace')
    return doc, sha256_hex(canonical_json(doc))


def sparql_term(t):
    """An N-Triples term for a stored IRI or literal (blank nodes are not expressible in a guard and are never written here)."""
    if isinstance(t, px.NamedNode):
        return f'<{t.value}>'
    if isinstance(t, px.Literal):
        if t.language:
            return f'{json.dumps(t.value)}@{t.language}'
        return f'{json.dumps(t.value)}^^<{t.datatype.value}>'
    return None


class ReconcileRequired(Exception):
    def __init__(self, info):
        super().__init__(info.get('reason'))
        self.info = info


def home_refusal(recorded_home, recorded_inode, home, home_inode, promote_epoch, adopt_home):
    """#1577 the copy guard's decision, as a message or None. A store whose recorded home is not where
    it is being started is a copy (a backup, a cp -R, a RocksDB checkpoint): it carries the original's
    incarnation, so cursors read from the original would be answered by the copy and silently miss
    whatever the two wrote apart. A copy serves only once promoted (a new incarnation)."""
    if recorded_home is not None and recorded_home != home and not promote_epoch:
        if not adopt_home:
            return (f'REFUSED: this store was copied from {recorded_home}; promote it (--promote-epoch) '
                    f'before serving, or start it at its home. (A store that was MOVED, not copied: --adopt-home.)')
        if os.path.exists(recorded_home):
            return (f'REFUSED: --adopt-home, but a store still exists at its recorded home {recorded_home}: '
                    f'this is a copy, not a move. Promote it (--promote-epoch) instead.')
    elif recorded_home == home and recorded_inode is not None and recorded_inode != home_inode \
            and not promote_epoch and not adopt_home:
        return (f'REFUSED: this store was copied from {recorded_home} into the same path (the directory is '
                f'not the one recorded there: a restore copied into place?); promote it (--promote-epoch) '
                f'before serving. (The same store moved to a new disk at the same path: --adopt-home.)')
    return None


def home_refusal_readonly(store_dir, promote_epoch, adopt_home):
    """#1577 read the recorded home through a READ-ONLY open (no file in the directory changes), close
    it, and decide. None = permitted, or the marker could not be read here (the backstop check after the
    read-write open then decides)."""
    try:
        ro = px.Store.read_only(store_dir)
    except Exception:
        return None
    try:
        if old_layout(ro):
            return LAYOUT_REFUSAL
        def one(pred):
            rows = list(ro.query(f'SELECT ?v WHERE {{ {in_bk(f"<{DATASET.value}> <{pred.value}> ?v")} }}'))
            return rows[0]['v'].value if len(rows) == 1 else None
        recorded_home, recorded_inode = one(P_STORE_HOME), one(P_STORE_HOME_INODE)
    except Exception:
        return None
    finally:
        del ro
    home = os.path.realpath(store_dir)
    return home_refusal(recorded_home, recorded_inode, home, str(os.stat(home).st_ino), promote_epoch, adopt_home)


def old_layout(store):
    """#1638 — True when the marker sits in the DEFAULT graph (the pre-#1638 layout). Such a store is refused,
    read-only or not: the new code never reads the old layout, and the migration is the only way across."""
    return bool(store.query(f'ASK {{ <{DATASET.value}> ?p ?o }}'))


class Executor:
    def __init__(self, store_dir, dataset_id, create=False, log=None, promote_epoch=False, checkpoint_dir=None,
                 adopt_home=False, read_only=False, install_write_floor=None, reconcile_postseq=None,
                 dispose_obligation=None):
        self.read_only = bool(read_only)
        self.reconciled = None
        self.disposed = None
        if dispose_obligation is not None and (self.read_only or create or promote_epoch or adopt_home
                                               or install_write_floor is not None or reconcile_postseq is not None):
            # #1749 A8, as --reconcile-postseq: refused before the store is opened, so a refusal changes nothing
            raise SystemExit('REFUSED: --dispose-obligation is a maintenance start of an existing, already promoted store: it '
                             'cannot be combined with --read-only, --create, --promote-epoch, --adopt-home, '
                             '--install-write-floor or --reconcile-postseq (run those as their own start)')
        if reconcile_postseq is not None and (self.read_only or create or promote_epoch or adopt_home
                                              or install_write_floor is not None):
            # refused before the store is even opened: each of those writes something of its own, and a reconcile start that
            # refuses must leave the store byte-unchanged (review finding 1). Run them as separate starts.
            raise SystemExit('REFUSED: --reconcile-postseq is a maintenance start of an existing, already promoted store: it '
                             'cannot be combined with --read-only, --create, --promote-epoch, --adopt-home or '
                             '--install-write-floor (run those as their own start, before or after)')
        if self.read_only and (create or promote_epoch or adopt_home):
            raise SystemExit('REFUSED: --read-only cannot be combined with --create, --promote-epoch or --adopt-home')
        if self.read_only and install_write_floor is not None:
            raise SystemExit('REFUSED: --read-only cannot install a write floor (it writes nothing)')
        self.write_floor = None
        # #1638 C7 — a migration builds its copy at <dest>.partial and renames it onto <dest> only once it is complete and
        # verified. A directory still named *.partial is an INTERRUPTED copy: never served, read-only or not.
        if os.path.basename(os.path.abspath(store_dir).rstrip('/')).endswith('.partial'):
            raise SystemExit(f'REFUSED: {store_dir} is an unpublished migration staging directory (*.partial): an interrupted '
                             'copy is never served; remove it and rerun graph-executor/migrate_bookkeeping.py')
        self.checkpoint_dir = os.path.abspath(checkpoint_dir or (os.path.abspath(store_dir).rstrip('/') + '.checkpoints'))
        # #1577 (a reviewer's v2.9 C0): the HOME check decides through a READ-ONLY open, BEFORE the
        # read-write open. A read-write open rewrites LOCK/LOG/WAL/MANIFEST/OPTIONS/CURRENT even when
        # nothing is written, so a refused start of a published backup directory used to leave a
        # backup that no longer verified against its own manifest. Read-write only once permitted.
        if os.path.isfile(os.path.join(store_dir, 'CURRENT')):
            refusal = home_refusal_readonly(store_dir, promote_epoch, adopt_home)
            if refusal:
                raise SystemExit(refusal)
        try:
            self.store = px.Store.read_only(store_dir) if self.read_only else px.Store(store_dir)
        except OSError as e:
            raise SystemExit(f'REFUSED: store could not be opened{" read-only" if self.read_only else " for writing (durability fault)"}: {e}')
        if old_layout(self.store):
            raise SystemExit(LAYOUT_REFUSAL)
        # #1577 where this store is (after the open: it creates the directory)
        self.home = os.path.realpath(store_dir)
        self.home_inode = str(os.stat(self.home).st_ino)
        self.lock = threading.Lock()
        self.flushes = 0
        # #1559 the durability LATCH: set by a storage error (OSError) from update or flush.
        # RocksDB's background error is sticky for the life of an open store (measured
        # 2026-10-04: flush keeps failing after the cause is removed), so the only recovery
        # is a process restart. Until then writes are refused before update(); reads go on.
        self.degraded = None
        self.updates = 0
        self.log_file = open(log, 'a', buffering=1) if log else None
        marker = self._marker()
        if marker is None:
            if not create:
                raise SystemExit(f'REFUSED: store has no dataset marker (use --create on an empty store)')
            if len(self.store) != 0:
                raise SystemExit('REFUSED: --create on a non-empty store')
            self.store.update(
                f'INSERT DATA {{ GRAPH <{BK}> {{ <{DATASET.value}> <{P_DATASET_ID.value}> {json.dumps(dataset_id)} ; '
                f'<{P_EPOCH.value}> 1 ; <{P_COMMIT_SEQ.value}> 0 ; '
                f'<{P_INCARNATION.value}> {json.dumps(str(uuid.uuid4()))} ; <{P_STORE_HOME.value}> {json.dumps(self.home)} ; '
                f'<{P_STORE_HOME_INODE.value}> {json.dumps(self.home_inode)} }} }}')   # #1577, #1638
            self.store.flush()
            marker = self._marker()
        elif create:
            raise SystemExit('REFUSED: --create on a store that already has a marker')
        if marker['datasetId'] != dataset_id:
            raise SystemExit(f'REFUSED: dataset identity mismatch: store holds {marker["datasetId"]!r}, '
                             f'expected {dataset_id!r}')
        self.dataset_id = dataset_id
        # #1577 HOME check — BEFORE the self-check, which writes. A store whose recorded home is not
        # where it is being started is a copy (a backup, a cp -R, a RocksDB checkpoint): it carries the
        # original's incarnation, so cursors read from the original would be answered by the copy and
        # silently miss whatever the two wrote apart. A copy serves only once promoted (a new
        # incarnation). A store with no recorded home predates #1577: its home is recorded below.
        ident0 = self._identity()
        # the same decision again, on the opened store (the read-only pre-check above is what keeps a
        # refused start byte-clean; this one is the backstop if the pre-check could not read the marker)
        refusal = home_refusal(ident0.get('storeHome'), ident0.get('storeHomeInode'), self.home, self.home_inode,
                               promote_epoch, adopt_home)
        if refusal:
            raise SystemExit(refusal)
        # #1559 startup self-check: a store that cannot flush must not serve. A persistent
        # fault then shows as a crash loop under the supervisor, never as a quietly broken service.
        # It must DIRTY the store: a flush with nothing pending can succeed without touching
        # the disk (a reviewer, #1559 13:28Z). So: write a self-check triple, flush, delete it,
        # flush. The store's logical content is unchanged.
        # #1749 everything that can refuse a start because of the RECOVERY GRAPH or the reconcile file is decided HERE, before
        # the first write of this start (the self-check below): a refusal leaves the store unchanged.
        self._check_recovery_graph_sound()
        self._check_ambiguous_sound()   # #1749 A8: every AmbiguousObligation complete and well-formed, or HOLD_UNSOUND
        if promote_epoch and not self.read_only and self._hold_present():
            self._prior_hold()   # a re-promotion replaces only a COMPLETE, well-formed hold (review finding 2)
        # #1749 A8-1 the obligations this promotion records as ambiguous, read (and their payloads hashed) before any write
        self._promotion_aos = (self._pending_unrecorded() if promote_epoch and not self.read_only
                               and (self._hold_present() or self._has_allocator()) else [])
        reconcile_plan = self._reconcile_check(reconcile_postseq) if reconcile_postseq is not None else None
        dispose_plan = self._dispose_check(dispose_obligation) if dispose_obligation is not None else None
        self.promoted = None
        if self.read_only:
            self.write_floor = self._floor_value()
            self._check_floor_provenance(self.write_floor)
            return   # #1638 a read-only fence writes nothing: no self-check, no promotion, no identity backfill
        probe = f'<{NS}selfcheck/{int(time.time() * 1000)}>'
        try:
            # a crash between an earlier self-check's insert and delete would leave its probe behind
            self.store.update(f'DELETE {{ GRAPH <{BK}> {{ ?stale <{NS}selfCheck> true }} }} WHERE {{ GRAPH <{BK}> {{ ?stale <{NS}selfCheck> true }} FILTER(STRSTARTS(STR(?stale), "{NS}selfcheck/")) }}')   # reserved namespace AND predicate only
            self.store.update(f'INSERT DATA {{ GRAPH <{BK}> {{ {probe} <{NS}selfCheck> true }} }}')
            self.store.flush()
            self.store.update(f'DELETE DATA {{ GRAPH <{BK}> {{ {probe} <{NS}selfCheck> true }} }}')
            self.store.flush()
        except OSError as e:
            raise SystemExit(f'REFUSED: startup self-check write+flush failed (durability fault): {e}')
        # #1559 restore PROMOTION: a new epoch, visible before any write is served. Never a rollback
        # of the commit sequence (D1 v0.2): commitSeq is left as the restored store recorded it.
        if promote_epoch:
            before_marker = self._marker()
            before = int(before_marker['epoch'])
            prev = self._identity().get('incarnation')
            new_inc = str(uuid.uuid4())
            # #1575 — and record WHERE the new epoch began: `epochBase` is the restored store's own
            # commitSeq at promotion. A change-feed / replay cursor from the epoch promoted FROM
            # resyncs to min(its commitSeq, epochBase): every row at or below it is common to both
            # stores, every row above it is new on this epoch.
            # #1577 — and a NEW INCARNATION (incarnationFrom = the one replaced, absent if the restored
            # store had none) and this path as its home. ONE update with the bump: a crash between them
            # would leave two promoted copies of one backup on the same epoch AND the same incarnation.
            D = DATASET.value
            hold_ops = self._hold_promotion_ops(str(before + 1), new_inc, before_marker['commitSeq'])
            self.store.update(
                f'DELETE {{ GRAPH <{BK}> {{ <{D}> <{P_EPOCH.value}> ?e . <{D}> <{P_EPOCH_BASE.value}> ?b . <{D}> <{P_INCARNATION.value}> ?i . '
                f'<{D}> <{P_INCARNATION_FROM.value}> ?f . <{D}> <{P_STORE_HOME.value}> ?h . <{D}> <{P_STORE_HOME_INODE.value}> ?n }} }} '
                f'INSERT {{ GRAPH <{BK}> {{ <{D}> <{P_EPOCH.value}> ?e1 . <{D}> <{P_EPOCH_BASE.value}> ?s . '
                f'<{D}> <{P_INCARNATION.value}> {json.dumps(new_inc)} . <{D}> <{P_INCARNATION_FROM.value}> ?i . '
                f'<{D}> <{P_STORE_HOME.value}> {json.dumps(self.home)} . <{D}> <{P_STORE_HOME_INODE.value}> {json.dumps(self.home_inode)} }} }} '
                f'WHERE {{ GRAPH <{BK}> {{ <{D}> <{P_EPOCH.value}> ?e ; <{P_COMMIT_SEQ.value}> ?s . '
                f'OPTIONAL {{ <{D}> <{P_EPOCH_BASE.value}> ?b }} OPTIONAL {{ <{D}> <{P_INCARNATION.value}> ?i }} '
                f'OPTIONAL {{ <{D}> <{P_INCARNATION_FROM.value}> ?f }} OPTIONAL {{ <{D}> <{P_STORE_HOME.value}> ?h }} '
                f'OPTIONAL {{ <{D}> <{P_STORE_HOME_INODE.value}> ?n }} }} '
                f'BIND(?e + 1 AS ?e1) }}' + hold_ops)
            self.store.flush()
            if hold_ops and self._marker()['epoch'] != str(before + 1):
                raise SystemExit('REFUSED: the promotion bumped the epoch to an unexpected value, so the recovery hold names '
                                 'the wrong one; this should be impossible')
            self.promoted = {'from': before, 'to': int(self._marker()['epoch']), 'incarnationFrom': prev,
                             'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        # #1577 IDENTITY outside create / promotion (each of those wrote it in its own update above).
        # An ordinary start KEEPS the incarnation. A store with no incarnation (made before #1577)
        # mints one ONCE, at its first start, and keeps it thereafter: cursors read from it before
        # then carry no incarnation and are judged by the legacy rule (core/changes-log-query.mjs:
        # answered only while the store has never been promoted), never matched against this value.
        # A store with no home records where it is now; --adopt-home (checked above) re-records it.
        ident = self._identity()
        if ident.get('incarnation') is None:
            self._set_identity(P_INCARNATION, str(uuid.uuid4()))
            self.store.flush()
        if adopt_home or ident.get('storeHome') is None or ident.get('storeHomeInode') is None:
            self._set_identity(P_STORE_HOME, self.home)
            self._set_identity(P_STORE_HOME_INODE, self.home_inode)
            self.store.flush()
        # #1748 the floor: read what the store holds; install it only when asked, and never over a DIFFERENT one
        held = self._floor_value()
        if install_write_floor is not None:
            want = str(install_write_floor)
            if not want or want != want.strip():
                raise SystemExit(f'REFUSED: --install-write-floor needs a non-empty protocol name, got {want!r}')
            if self._sentinel_present():
                raise SystemExit(f'REFUSED: the store holds the graph <{FLOOR_VIOLATION}>, which the floor guard needs to be '
                                 'absent; remove it offline before installing a floor')
            if held is None and self._stray_record():
                raise SystemExit('REFUSED: the store holds an install record for a floor it does not have, written some other '
                                 'way than --install-write-floor; remove it offline before installing a floor')
            if held is None or (held == want and not self._floor_recorded()):
                # the floor and its install record in ONE update: a floor never exists without the record, and the record
                # is how a start tells this procedure from an /update that wrote a floor by accident
                self.store.update(f'INSERT DATA {{ GRAPH <{BK}> {{ <{FLOOR_S.value}> <{FLOOR_P.value}> {json.dumps(want)} ; '
                                  f'<{FLOOR_INSTALLED_BY.value}> {json.dumps(FLOOR_INSTALLER)} }} }}')
                self.store.flush()
                held = self._floor_value()
            elif held != want:
                raise SystemExit(f'REFUSED: this store already has write floor {held!r}; --install-write-floor {want!r} '
                                 'would change it (a floor is never replaced or downgraded by a relaunch)')
        self._check_floor_provenance(held)
        self.write_floor = held
        # #1749 a store holding the hold guard's sentinel graph would refuse every write: refuse to start instead
        if self.store.contains_named_graph(px.NamedNode(HOLD_VIOLATION)):
            raise SystemExit(f'REFUSED: the store holds the graph <{HOLD_VIOLATION}>, which the recovery-hold guard needs to '
                             'be absent; remove it offline')
        if reconcile_postseq is not None:
            self.reconciled = self._reconcile_apply(reconcile_plan)
        if dispose_obligation is not None:
            self.disposed = self._dispose_apply(dispose_plan)

    # ── #1749 the recovery hold ──────────────────────────────────────────────────────────────────────────────────────

    def _rg_values(self, subject, predicate):
        return [r['v'] for r in self.store.query(f'SELECT ?v WHERE {{ {in_rg(f"<{subject}> <{predicate}> ?v")} }}')]

    def _bk_values(self, subject, predicate):
        return [r['v'] for r in self.store.query(f'SELECT ?v WHERE {{ {in_bk(f"<{subject}> <{predicate}> ?v")} }}')]

    def _hold_present(self):
        return bool(self.store.query(f'ASK {{ {in_rg(f"<{HOLD_S}> ?p ?o")} }}'))

    def _has_allocator(self):
        return bool(self.store.query(f'ASK {{ {in_bk(f"<{ALLOC_S}> a <{ALLOC_T}>")} }}'))

    @staticmethod
    def _int_term(t, what):
        if not isinstance(t, px.Literal) or t.datatype.value != XSD_INTEGER:
            raise SystemExit(f'REFUSED: {what} is not an xsd:integer ({t})')
        try:
            return int(t.value)
        except ValueError:
            raise SystemExit(f'REFUSED: {what} is not an integer ({t.value!r})')

    def _restored_high_water(self):
        """The max postSeq over posts and tombstones (default graph) and reservations (bookkeeping); 0 when none."""
        hw = 0
        for q, what in ((f'SELECT ?n WHERE {{ ?x <{POST_POSTSEQ}> ?n }}', 'a post\'s postSeq'),
                        (f'SELECT ?n WHERE {{ {in_bk(f"?x <{RESERVATION_POSTSEQ}> ?n")} }}', 'a reservation\'s postSeq')):
            for r in self.store.query(q):
                hw = max(hw, self._int_term(r['n'], what))
        return hw

    def _hold_promotion_ops(self, new_epoch, new_inc, commit_seq):
        """#1749 (V2-1, A4) the operations that REPLACE the hold, appended to the promotion's own update, or '' when this
        promotion writes none: a store with no allocator and no hold gets none (a cutover candidate is promoted before
        its import writes the allocator). A held store keeps a hold whatever it holds, re-bound to this promotion:
        restoredHighWater := max(the prior hold's, the recomputed one) and priorHoldEpoch := the replaced hold's epoch."""
        prior = self._hold_present()
        if not prior and not self._has_allocator():
            return ''
        hw = self._restored_high_water()
        prior_epoch = None
        if prior:
            old = self._prior_hold()
            hw = max(hw, old['restoredHighWater'])
            prior_epoch = old['epoch']
        if hw > MAX_SAFE:
            raise SystemExit(f'REFUSED: the restored high-water {hw} is not a safe integer')
        prior_t = f' ; <{HOLD_PRIOR_EPOCH}> {json.dumps(prior_epoch)}' if prior_epoch is not None else ''
        # #1749 A8-1 in the SAME update: one AmbiguousObligation per obligation pending now that has none yet, bound to THIS
        # hold's lineage; an existing AmbiguousObligation (held or disposed) is never touched (P8-5, P8-7)
        aos = ''.join(
            f' . <{a["subject"]}> a <{AO_T}> ; <{AO["obligationIri"]}> <{a["obligationIri"]}> ; '
            f'<{AO["obligationId"]}> {json.dumps(a["obligationId"])} ; <{AO["mutationId"]}> {json.dumps(a["mutationId"])} ; '
            f'<{AO["slot"]}> {json.dumps(a["slot"])} ; <{AO["payloadSha256"]}> {json.dumps(a["payloadSha256"])} ; '
            f'<{AO["holdEpoch"]}> {json.dumps(new_epoch)} ; <{AO["holdIncarnation"]}> {json.dumps(new_inc)} ; '
            f'<{AO["state"]}> "held"' for a in getattr(self, '_promotion_aos', []))
        return (f' ;\nDELETE WHERE {{ GRAPH <{RG}> {{ <{HOLD_S}> ?hp ?ho }} }} ;\n'
                f'INSERT DATA {{ GRAPH <{RG}> {{ <{HOLD_S}> a <{HOLD_T}> ; <{HOLD_EPOCH}> {json.dumps(new_epoch)} ; '
                f'<{HOLD_INCARNATION}> {json.dumps(new_inc)} ; <{HOLD_COMMIT_SEQ}> "{int(commit_seq)}"^^<{XSD_INTEGER}> ; '
                f'<{HOLD_HIGH_WATER}> "{hw}"^^<{XSD_INTEGER}>{prior_t}{aos} }} }}')

    # ── #1749 A8 the dispatch hold ───────────────────────────────────────────────────────────────────────────────────

    def _subject_rows(self, graph_pattern_fn, subject):
        out = {}
        for r in self.store.query(f'SELECT ?p ?o WHERE {{ {graph_pattern_fn(f"<{subject}> ?p ?o")} }}'):
            out.setdefault(r['p'].value, []).append(r['o'])
        return out

    @staticmethod
    def _plain_one(rows, pred):
        """the single plain-string value of pred, or None when it is not exactly one plain string"""
        vs = rows.get(pred, [])
        if len(vs) != 1 or not isinstance(vs[0], px.Literal) or vs[0].language or vs[0].datatype.value != XSD_STRING:
            return None
        return vs[0].value

    def _payload_sha(self, reservation_iri):
        """P8-1: sha256 of the obligation's stored payload (its reservation's frozen draft) as canonical JSON, or None"""
        rows = self._subject_rows(in_bk, reservation_iri)
        draft = self._plain_one(rows, RES_DRAFT)
        if draft is None:
            return None, None
        try:
            payload = json.loads(draft)
        except ValueError:
            return None, None
        return sha256_hex(canonical_json(payload)), payload

    def _check_ambiguous_sound(self):
        """#1749 A8 every AmbiguousObligation (any subject typed so, or under its prefix) must be complete: typed once, each
        field exactly once (obligationIri an IRI, the rest plain strings), state held|disposed, obligationId its own
        mutationId:slot, payloadSha256 64 hex, and the subject derived from the obligationId. Anything else refuses the start
        HOLD_UNSOUND before any write, naming the subject."""
        subs = {r['s'].value for r in self.store.query(
            f'SELECT DISTINCT ?s WHERE {{ GRAPH <{RG}> {{ {{ ?s a <{AO_T}> }} UNION {{ ?s ?p ?o FILTER(STRSTARTS(STR(?s), {json.dumps(AO_PREFIX)})) }} }} }}')}
        for subj in sorted(subs):
            rows = self._subject_rows(in_rg, subj)
            def unsound(why):
                return SystemExit(f'REFUSED: HOLD_UNSOUND: the AmbiguousObligation <{subj}> {why}. Inspect and repair it offline '
                                  '(the store is unchanged)')
            extra = sorted(set(rows) - {RDF_TYPE, *AO.values()})
            if extra:
                raise unsound(f'carries predicate(s) it never has: {extra}')
            if rows.get(RDF_TYPE, []) != [px.NamedNode(AO_T)]:
                raise unsound(f'is not typed <{AO_T}> exactly once')
            iris = rows.get(AO['obligationIri'], [])
            if len(iris) != 1 or not isinstance(iris[0], px.NamedNode):
                raise unsound(f'has {len(iris)} obligationIri value(s); exactly one IRI is required')
            vals = {}
            for k in ('obligationId', 'mutationId', 'slot', 'payloadSha256', 'holdEpoch', 'holdIncarnation', 'state'):
                v = self._plain_one(rows, AO[k])
                if v is None or v == '':
                    raise unsound(f'has no single non-empty plain-string {k}')
                vals[k] = v
            if vals['state'] not in AO_STATES:
                raise unsound(f'has an unknown state {vals["state"]!r} (expected one of {list(AO_STATES)})')
            if vals['obligationId'] != f'{vals["mutationId"]}:{vals["slot"]}':
                raise unsound('names an obligationId that is not its own mutationId:slot')
            if not _hex64(vals['payloadSha256']):
                raise unsound('has a payloadSha256 that is not 64 lowercase hex characters')
            if subj != ao_subject(vals['obligationId']):
                raise unsound('sits at a subject that is not derived from its obligationId')
            if vals['state'] == 'disposed':
                self._check_disposed_consistent(subj, vals, iris[0].value, unsound)

    def _check_disposed_consistent(self, subj, ao, ob_iri, unsound):
        """#1749 A8 (review D11) a DISPOSED AmbiguousObligation is sound only beside a DispositionRecord that references it
        and names the same obligationId, mutationId, slot and payloadSha256, AND an obligation that reads that disposition's
        terminal status (published for settle-published, retired for retire-unsent-unknown). Otherwise HOLD_UNSOUND."""
        recs = [r['r'].value for r in self.store.query(
            f'SELECT DISTINCT ?r WHERE {{ GRAPH <{RG}> {{ ?r a <{DR_T}> ; <{PS}ambiguousRecord> <{subj}> }} }}')]
        if not recs:
            raise unsound('is disposed, but no DispositionRecord references it')
        ob_rows = self._subject_rows(in_bk, ob_iri)
        status = self._plain_one(ob_rows, OB['status'])
        for rec in recs:
            rows = self._subject_rows(in_rg, rec)
            got = {k: self._plain_one(rows, PS + k) for k in ('obligationId', 'mutationId', 'slot', 'payloadSha256', 'decision',
                                                              'obligationStatusAfter')}
            if any(got[k] != ao[k] for k in ('obligationId', 'mutationId', 'slot', 'payloadSha256')):
                continue
            want = DISPOSE_DECISIONS.get(got['decision'])
            if want is None or got['obligationStatusAfter'] != want:
                continue
            if status != want or len(ob_rows.get(OB['status'], [])) != 1:
                raise unsound(f'is disposed by <{rec}> ({got["decision"]}), but its obligation <{ob_iri}> reads {status!r}, '
                              f'not {want!r}')
            return
        raise unsound(f'is disposed, but no DispositionRecord that references it ({", ".join(recs)}) names the same '
                      'obligation and payload')

    def _pending_unrecorded(self):
        """#1749 A8-1 every obligation whose status is pending now (any mode) and which has no AmbiguousObligation yet, with
        its payload hashed (P8-1). One that cannot be read completely refuses the promotion HOLD_UNSOUND, before any write:
        an obligation is never silently left unrecorded."""
        out = []
        q = (f'SELECT DISTINCT ?ob WHERE {{ GRAPH <{BK}> {{ ?ob a <{OB_T}> ; <{OB["status"]}> ?st . '
             f'FILTER(isLiteral(?st) && STR(?st) = "pending") }} }}')
        for r in self.store.query(q):
            ob = r['ob'].value
            rows = self._subject_rows(in_bk, ob)
            vals = {k: self._plain_one(rows, OB[k]) for k in ('obligationId', 'mutationId', 'slot')}
            res = rows.get(OB['reservation'], [])
            def unsound(why):
                return SystemExit(f'REFUSED: HOLD_UNSOUND: the pending obligation <{ob}> {why}, so this promotion cannot record it '
                                  'as ambiguous; repair it offline before promoting (the store is unchanged)')
            if any(v is None for v in vals.values()) or vals['obligationId'] != f'{vals["mutationId"]}:{vals["slot"]}':
                raise unsound('has no single, self-consistent obligationId/mutationId/slot')
            if len(rows.get(OB['status'], [])) != 1:
                raise unsound('has more than one status')
            if len(res) != 1 or not isinstance(res[0], px.NamedNode):
                raise unsound('names no single reservation')
            sha, _ = self._payload_sha(res[0].value)
            if sha is None:
                raise unsound('has no readable stored payload (its reservation\'s draft)')
            subj = ao_subject(vals['obligationId'])
            if bool(self.store.query(f'ASK {{ {in_rg(f"<{subj}> ?p ?o")} }}')):
                continue   # already recorded by an earlier promotion: never altered (P8-5)
            out.append({'subject': subj, 'obligationIri': ob, 'payloadSha256': sha, **vals})
        return out

    def _dispose_check(self, path):
        """#1749 A8 (AUTHORITATIVE SCHEMA) every check of --dispose-obligation, before this start's first write. Order:
        BAD_FILE (the closed schema); the file's currentStore is THIS store (P8-5) and an AmbiguousObligation exists for its
        obligationId, else WRONG_OBLIGATION; a disposed one answers ALREADY for the same file, NOT_AMBIGUOUS for any other;
        the held record's binding (mutationId, slot, payloadSha256, lineage) and the actual pending obligation and its payload
        sha in this store, else WRONG_OBLIGATION; for settle-published, the post verified in THIS store by its frozen fields,
        else POST_UNVERIFIED."""
        doc, digest = parse_dispose_file(path)
        wrong = lambda why: DisposeRefused('WRONG_OBLIGATION', why)
        ident, marker = self._identity(), self._marker()
        here = {'datasetId': self.dataset_id, 'epoch': str(marker['epoch']), 'incarnation': ident.get('incarnation')}
        for k in ('datasetId', 'epoch', 'incarnation'):
            if doc['currentStore'][k] != here[k]:
                raise wrong(f'the file\'s currentStore.{k} is {doc["currentStore"][k]!r}; this store\'s is {here[k]!r}')
        oid = doc['obligationId']
        subj = ao_subject(oid)
        rows = self._subject_rows(in_rg, subj)
        if not rows:
            raise wrong(f'no AmbiguousObligation exists for {oid} (at <{subj}>)')
        ao = {k: self._plain_one(rows, AO[k]) for k in ('obligationId', 'mutationId', 'slot', 'payloadSha256', 'holdEpoch',
                                                        'holdIncarnation', 'state')}
        record = DR_PREFIX + digest
        if ao['state'] == 'disposed':
            if bool(self.store.query(f'ASK {{ {in_rg(f"<{record}> a <{DR_T}> ; <{PS}fileSha256> {json.dumps(digest)}")} }}')):
                return {'already': True, 'record': record}
            raise DisposeRefused('NOT_AMBIGUOUS', f'{oid} was already disposed, by a different file')
        if ao['state'] != 'held':
            raise wrong(f'the AmbiguousObligation for {oid} is not held')
        for k, want in (('obligationId', oid), ('mutationId', doc['mutationId']), ('slot', doc['slot']),
                        ('payloadSha256', doc['payloadSha256']), ('holdEpoch', doc['lineage']['holdEpoch']),
                        ('holdIncarnation', doc['lineage']['holdIncarnation'])):
            if ao[k] != want:
                raise wrong(f'the file\'s {k} is {want!r}; the AmbiguousObligation\'s is {ao[k]!r}')
        ob_iri = rows[AO['obligationIri']][0].value
        ob_rows = self._subject_rows(in_bk, ob_iri)
        status_t = ob_rows.get(OB['status'], [])
        if (ob_rows.get(RDF_TYPE, []) != [px.NamedNode(OB_T)] or self._plain_one(ob_rows, OB['obligationId']) != oid
                or len(status_t) != 1 or self._plain_one(ob_rows, OB['status']) != 'pending'):
            raise wrong(f'the obligation <{ob_iri}> in this store is not the pending obligation {oid}')
        res = ob_rows.get(OB['reservation'], [])
        if len(res) != 1 or not isinstance(res[0], px.NamedNode):
            raise wrong(f'the obligation <{ob_iri}> names no single reservation')
        sha, payload = self._payload_sha(res[0].value)
        if sha != doc['payloadSha256']:
            raise wrong(f'the obligation\'s stored payload in this store has sha256 {sha}, not the file\'s')
        post = None
        if doc['decision'] == 'settle-published':
            post = self._verify_post(doc['mutationId'], doc['slot'], res[0].value, payload)
        if bool(self.store.query(f'ASK {{ {in_rg(f"<{record}> ?p ?o")} }}')):
            raise DisposeRefused('BAD_FILE', f'a record already sits at {record} while the obligation is held; repair it offline')
        return {'already': False, 'record': record, 'digest': digest, 'doc': doc, 'ao_subject': subj, 'ao_state': rows[AO['state']][0],
                'ob_iri': ob_iri, 'ob_status': status_t[0], 'post': post, 'here': here}

    def _verify_post(self, mid, slot, reservation_iri, payload):
        """#1749 A8 settle-published: the post announcePostId(mutationId, slot) exists in THIS store, live, and its FROZEN
        fields equal the payload's (author, body, mentions, originActor, occurredAt, origin mutationId and slot) and the
        obligation's reserved postSeq. Never a caller's claim, never a body hash alone."""
        unv = lambda why: DisposeRefused('POST_UNVERIFIED', why)
        post_id = announce_post_id(mid, slot)
        post_iri = ENTITY_IRI + post_id
        rows = {}
        for r in self.store.query(f'SELECT ?p ?o WHERE {{ <{post_iri}> ?p ?o }}'):
            rows.setdefault(r['p'].value, []).append(r['o'])
        if not rows:
            raise unv(f'the post {post_id} does not exist in this store')
        types = {t.value for t in rows.get(RDF_TYPE, []) if isinstance(t, px.NamedNode)}
        if POST_T['Comment'] not in types or POST_T['RedactedPost'] in types:
            raise unv(f'the post {post_id} is not a live post')
        if not isinstance(payload, dict):
            raise unv('the stored payload is not an object')
        def one(pred):
            vs = rows.get(pred, [])
            return vs[0] if len(vs) == 1 else None
        res_rows = self._subject_rows(in_bk, reservation_iri)
        ps = res_rows.get(RESERVATION_POSTSEQ, [])
        checks = [
            ('body', one(POST_P['text']), lambda t: isinstance(t, px.Literal) and t.value == payload.get('body')),
            ('author', one(POST_P['author']), lambda t: isinstance(t, px.NamedNode) and t.value == PERSON_IRI + str(payload.get('author'))),
            ('originActor', one(POST_P['originActor']), lambda t: isinstance(t, px.NamedNode) and t.value == PERSON_IRI + str(payload.get('originActor'))),
            ('occurredAt', one(POST_P['originOccurredAt']), lambda t: isinstance(t, px.Literal) and t.value == payload.get('occurredAt')),
            ('origin.mutationId', one(POST_P['originMutation']), lambda t: isinstance(t, px.Literal) and t.value == mid),
            ('origin.slot', one(POST_P['originSlot']), lambda t: isinstance(t, px.Literal) and t.value == slot),
            ('postSeq', one(POST_P['postSeq']), lambda t: isinstance(t, px.Literal) and t.datatype.value == XSD_INTEGER and len(ps) == 1
                and isinstance(ps[0], px.Literal) and t.value == ps[0].value),
        ]
        for what, term, ok in checks:
            if term is None or not ok(term):
                raise unv(f'the post {post_id}\'s {what} is not the obligation\'s ({term})')
        mentions = sorted(t.value for t in rows.get(POST_P['mentionsName'], []) if isinstance(t, px.Literal))
        if mentions != sorted(payload.get('mentions') or []) or len(mentions) != len(rows.get(POST_P['mentionsName'], [])):
            raise unv(f'the post {post_id}\'s mentions are not the obligation\'s')
        return {'postId': post_id, 'postIri': post_iri, 'postSeq': int(ps[0].value), 'bodySha256': sha256_hex(payload.get('body') or ''),
                'author': payload.get('author'), 'originActor': payload.get('originActor'), 'occurredAt': payload.get('occurredAt'),
                'mentions': mentions}

    def _dispose_apply(self, plan):
        """#1749 A8 the write half of --dispose-obligation: ONE transaction — the obligation published or retired, the
        AmbiguousObligation disposed, the DispositionRecord written. No dispatch receipt, announce receipt or delivery claim."""
        if plan['already']:
            return {'result': 'ALREADY', 'record': plan['record']}
        doc, record, post, here = plan['doc'], plan['record'], plan['post'], plan['here']
        after = DISPOSE_DECISIONS[doc['decision']]
        S = json.dumps
        I = lambda n: f'"{int(n)}"^^<{XSD_INTEGER}>'
        B = lambda b: f'"{"true" if b else "false"}"^^<{XSD_BOOLEAN}>'
        P = lambda k: f'<{PS}{k}>'
        fields = [
            (P('fileSha256'), S(plan['digest'])), (P('obligationIri'), f'<{plan["ob_iri"]}>'), (P('obligationId'), S(doc['obligationId'])),
            (P('mutationId'), S(doc['mutationId'])), (P('slot'), S(doc['slot'])), (P('payloadSha256'), S(doc['payloadSha256'])),
            (P('decision'), S(doc['decision'])), (P('obligationStatusAfter'), S(after)), (P('postVerified'), B(post is not None)),
            (P('notification'), S(doc['notification'])), (P('ambiguousRecord'), f'<{plan["ao_subject"]}>'),
            (P('holdEpoch'), S(doc['lineage']['holdEpoch'])), (P('holdIncarnation'), S(doc['lineage']['holdIncarnation'])),
            (P('currentDatasetId'), S(here['datasetId'])), (P('currentEpoch'), S(here['epoch'])), (P('currentIncarnation'), S(here['incarnation'])),
            (P('approvedBy'), f'<{doc["approvedBy"]}>'), (P('approvalRef'), S(doc['approvalRef'])), (P('note'), S(doc['note'])),
            (P('evidenceAuthenticated'), B(False)),
            (P('disposedAt'), f'"{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}"^^<{XSD_DATETIME}>'),
        ]
        if 'notificationEvidence' in doc:
            fields.append((P('notificationEvidenceJson'), S(canonical_json(doc['notificationEvidence']))))
        if post is not None:
            fields += [(P('verifiedPostId'), S(post['postId'])), (P('verifiedPost'), f'<{post["postIri"]}>'),
                       (P('verifiedPostSeq'), I(post['postSeq'])), (P('verifiedBodySha256'), S(post['bodySha256'])),
                       (P('verifiedAuthor'), S(post['author'])), (P('verifiedOriginActor'), S(post['originActor'])),
                       (P('verifiedOccurredAt'), S(post['occurredAt'])), (P('verifiedMentionsJson'), S(canonical_json(post['mentions']))),
                       (P('verifiedIn'), S('store'))]
        rec = f'<{record}> a <{DR_T}> ; ' + ' ; '.join(f'{p} {o}' for p, o in fields)
        try:
            self.store.update(
                f'DELETE DATA {{ GRAPH <{BK}> {{ <{plan["ob_iri"]}> <{OB["status"]}> {sparql_term(plan["ob_status"])} }} '
                f'GRAPH <{RG}> {{ <{plan["ao_subject"]}> <{AO["state"]}> {sparql_term(plan["ao_state"])} }} }} ;\n'
                f'INSERT DATA {{ GRAPH <{BK}> {{ <{plan["ob_iri"]}> <{OB["status"]}> {S(after)} }} '
                f'GRAPH <{RG}> {{ <{plan["ao_subject"]}> <{AO["state"]}> "disposed" . {rec} }} }}')
            self.store.flush()
        except OSError as e:
            raise SystemExit(f'REFUSED: the disposition write or its flush failed (durability fault; read the store before any '
                             f'rerun): {e}')
        return {'result': 'DISPOSED', 'record': record, 'status': after}

    def _check_recovery_graph_sound(self):
        """#1749 (review finding 3, the contract author's choice) the hold and the records use named terms only, so a blank
        node anywhere in the recovery graph is planted or corrupt state: refuse to start, naming the quad. With this, the
        /update snapshot guard only ever sees named quads, every one of which it can name."""
        for q in self.store.quads_for_pattern(None, None, None, px.NamedNode(RG)):
            if any(isinstance(t, px.BlankNode) for t in (q.subject, q.predicate, q.object)):
                raise SystemExit(f'REFUSED: HOLD_UNSOUND: the recovery graph <{RG}> holds a blank-node quad, {q}; the hold '
                                 'and the reconciliation records are named terms only, so this is planted or corrupt state. '
                                 'Inspect and repair it offline (the store is unchanged)')

    def _prior_hold(self):
        """#1749 (review finding 2) the stored hold, validated COMPLETE before anything replaces it: typed RecoveryHold exactly
        once; exactly one plain-string epoch and incarnation; exactly one xsd:integer restoredCommitSeq and restoredHighWater,
        each a safe integer >= 0; at most one priorHoldEpoch; nothing else. Anything less refuses HOLD_UNSOUND, so a missing
        field is never filled in from recomputed values."""
        rows = self._hold_rows() or {}
        def unsound(why):
            return SystemExit(f'REFUSED: HOLD_UNSOUND: the recovery hold <{HOLD_S}> {why}; a re-promotion replaces only a '
                              'complete hold. Inspect and repair it offline (the store is unchanged)')
        allowed = {RDF_TYPE, *HOLD_PREDICATES}
        extra = sorted(set(rows) - allowed)
        if extra:
            raise unsound(f'carries predicate(s) a hold never has: {extra}')
        if rows.get(RDF_TYPE, []) != [px.NamedNode(HOLD_T)]:
            raise unsound(f'is not typed <{HOLD_T}> exactly once')
        out = {}
        for key, pred in (('epoch', HOLD_EPOCH), ('incarnation', HOLD_INCARNATION)):
            vs = rows.get(pred, [])
            if len(vs) != 1 or not isinstance(vs[0], px.Literal) or vs[0].datatype.value != XSD_STRING or not vs[0].value:
                raise unsound(f'has {len(vs)} {key} value(s); exactly one non-empty plain string is required')
            out[key] = vs[0].value
        for key, pred in (('restoredCommitSeq', HOLD_COMMIT_SEQ), ('restoredHighWater', HOLD_HIGH_WATER)):
            vs = rows.get(pred, [])
            if len(vs) != 1 or not isinstance(vs[0], px.Literal) or vs[0].datatype.value != XSD_INTEGER:
                raise unsound(f'has {len(vs)} {key} value(s); exactly one xsd:integer is required')
            try:
                n = int(vs[0].value)
            except ValueError:
                raise unsound(f'has a {key} that is not an integer ({vs[0].value!r})')
            if not 0 <= n <= MAX_SAFE:
                raise unsound(f'has a {key} outside the safe integers >= 0 ({n})')
            out[key] = n
        if len(rows.get(HOLD_PRIOR_EPOCH, [])) > 1:
            raise unsound('has more than one priorHoldEpoch')
        return out

    def _recovery_snapshot(self):
        """#1749 (P1) every quad of the recovery graph, read under the update lock before an /update (empty when unheld)."""
        return [(r['s'], r['p'], r['o']) for r in self.store.query(f'SELECT ?s ?p ?o WHERE {{ {in_rg("?s ?p ?o")} }}')]

    def _recovery_changed(self, snapshot):
        """#1749 (P1) the pattern that matches when the recovery graph is not EXACTLY `snapshot`: a different quad count, or
        a snapshot quad gone. Protection by EFFECT: it reads the state the update produced, so every operation form is caught
        by what it does (DATA, WHERE with a computed GRAPH ?g, CLEAR/DROP, MOVE/COPY/ADD, LOAD), never by the request text."""
        terms = [(sparql_term(a), sparql_term(b), sparql_term(c)) for a, b, c in snapshot]
        branches = [f'{{ {{ SELECT (COUNT(*) AS ?hn) WHERE {{ GRAPH <{RG}> {{ ?hs ?hp ?ho }} }} }} FILTER(?hn != {len(snapshot)}) }}']
        branches += [f'{{ FILTER NOT EXISTS {{ GRAPH <{RG}> {{ {a} {b} {c} }} }} }}' for a, b, c in terms if None not in (a, b, c)]
        return ' UNION '.join(branches)

    def _guard_ops_hold(self, snapshot):
        return (f'INSERT {{ GRAPH <{HOLD_VIOLATION}> {{ <{HOLD_VIOLATION}> <{HOLD_VIOLATION}> <{HOLD_VIOLATION}> }} }} '
                f'WHERE {{ {self._recovery_changed(snapshot)} }} ;\n'
                f'CREATE GRAPH <{HOLD_VIOLATION}> ;\nDROP GRAPH <{HOLD_VIOLATION}>')

    def _hold_rows(self):
        """The stored hold as {predicate: [terms]}, or None when there is none."""
        rows = list(self.store.query(f'SELECT ?p ?o WHERE {{ {in_rg(f"<{HOLD_S}> ?p ?o")} }}'))
        if not rows:
            return None
        out = {}
        for r in rows:
            out.setdefault(r['p'].value, []).append(r['o'])
        return out

    def _reconcile_check(self, path):
        """#1749 (A2, A3, A5, A6) the ONLY path that clears the recovery hold. Checks in A6's order; success is ONE store
        transaction (the hold deleted, nextPostSeq := R with version + 1, the ReconciliationRecord written), flushed
        before serving. approvedBy and approvalRef are RECORDED and form-checked only: the approval is the act of running
        this maintenance start, and the record is its audit trail, not its proof."""
        doc, digest = parse_reconcile_file(path)
        record = REC_PREFIX + digest
        hold = self._hold_rows()
        # (1) no hold: the replay branch. A record is consulted ONLY here, so an old file can never clear a new hold.
        if hold is None:
            if bool(self.store.query(f'ASK {{ {in_rg(f"<{record}> a <{REC_T}> ; <{REC["fileSha256"]}> {json.dumps(digest)}")} }}')):
                return {'already': True, 'record': record}
            raise ReconcileRefused('NO_HOLD', 'this store holds no recovery hold, and no ReconciliationRecord for this file')
        def one(pred, kind):
            vs = hold.get(pred, [])
            if len(vs) != 1 or not isinstance(vs[0], px.Literal):
                raise ReconcileRefused('WRONG_LINEAGE', f'the stored hold has {len(vs)} {pred} values (expected exactly one literal)')
            if kind == 'int':
                if vs[0].datatype.value != XSD_INTEGER:
                    raise ReconcileRefused('WRONG_LINEAGE', f'the stored hold\'s {pred} is not an xsd:integer')
                return int(vs[0].value)
            return vs[0].value
        if hold.get(RDF_TYPE, []) != [px.NamedNode(HOLD_T)]:
            raise ReconcileRefused('WRONG_LINEAGE', 'the stored hold is not typed RecoveryHold exactly once')
        stored = {'epoch': one(HOLD_EPOCH, 'str'), 'incarnation': one(HOLD_INCARNATION, 'str'),
                  'restoredCommitSeq': one(HOLD_COMMIT_SEQ, 'int'), 'restoredHighWater': one(HOLD_HIGH_WATER, 'int')}
        # (2) the stored hold names THIS store's epoch and incarnation (a hold copied from another lineage never unlocks)
        ident, marker = self._identity(), self._marker()
        if stored['epoch'] != str(marker['epoch']) or stored['incarnation'] != ident.get('incarnation'):
            raise ReconcileRefused('WRONG_LINEAGE', f'the stored hold names epoch {stored["epoch"]!r}, incarnation '
                                   f'{stored["incarnation"]!r}; this store is epoch {marker["epoch"]!r}, incarnation '
                                   f'{ident.get("incarnation")!r}')
        # (3) the file was approved for THIS hold, field by field (and so for this store's identity)
        want = {'datasetId': self.dataset_id, **stored}
        for key in RECONCILE_HOLD_KEYS:
            if doc['hold'][key] != want[key]:
                raise ReconcileRefused('WRONG_HOLD', f'the file\'s hold.{key} is {doc["hold"][key]!r}; the stored hold\'s is {want[key]!r}')
        R, G, hw = doc['nextPostSeq'], doc['declaredGap'], stored['restoredHighWater']
        # (4) R is exactly restoredHighWater + G + 1, and a safe integer
        if hw + G + 1 > MAX_SAFE:
            raise ReconcileRefused('BAD_GAP', f'restoredHighWater {hw} + declaredGap {G} + 1 is not a safe integer')
        if R != hw + G + 1:
            raise ReconcileRefused('BAD_GAP', f'nextPostSeq {R} is not restoredHighWater {hw} + declaredGap {G} + 1 = {hw + G + 1}')
        # (5) above every number any evidence saw
        for k, ev in enumerate(doc['evidence']):
            if ev['maxPostSeqSeen'] >= R:
                raise ReconcileRefused('BELOW_EVIDENCE', f'evidence[{k}] saw postSeq {ev["maxPostSeqSeen"]}, not below {R}')
        # (6) never below the allocator's own next
        rows = list(self.store.query(f'SELECT ?n ?v WHERE {{ {in_bk(f"<{ALLOC_S}> a <{ALLOC_T}> ; <{ALLOC_NEXT}> ?n ; <{ALLOC_VERSION}> ?v")} }}'))
        if len(rows) != 1:
            raise ReconcileRefused('BELOW_NEXT', f'the allocator cannot be read as exactly one (next, version) tuple ({len(rows)} rows)')
        nxt_t, ver_t = rows[0]['n'], rows[0]['v']
        nxt, ver = self._int_term(nxt_t, 'the allocator\'s nextPostSeq'), self._int_term(ver_t, 'the allocator\'s version')
        if R < nxt:
            raise ReconcileRefused('BELOW_NEXT', f'nextPostSeq {R} is below the allocator\'s next {nxt}')
        if ver + 1 > MAX_SAFE:
            raise ReconcileRefused('BELOW_NEXT', f'the allocator\'s version {ver} cannot advance')
        if bool(self.store.query(f'ASK {{ {in_rg(f"<{record}> ?p ?o")} }}')):
            raise ReconcileRefused('BAD_FILE', f'a record already sits at {record} while a hold is present; repair it offline')
        return {'already': False, 'record': record, 'digest': digest, 'doc': doc, 'hold': hold, 'stored': stored,
                'nxt_t': nxt_t, 'ver_t': ver_t, 'nxt': nxt, 'ver': ver}

    def _reconcile_apply(self, plan):
        """#1749 the write half of --reconcile-postseq, run only after _reconcile_check passed (before this start's first
        write) and the start's own self-check: ONE transaction, the exact hold quads the check read deleted, the allocator
        advanced from the exact terms it read, the record written."""
        if plan['already']:
            return {'result': 'ALREADY', 'record': plan['record']}
        record, digest, doc, hold, stored = plan['record'], plan['digest'], plan['doc'], plan['hold'], plan['stored']
        nxt_t, ver_t, nxt, ver = plan['nxt_t'], plan['ver_t'], plan['nxt'], plan['ver']
        R, G, hw = doc['nextPostSeq'], doc['declaredGap'], stored['restoredHighWater']
        # ONE transaction: the exact hold triples read above deleted, the allocator advanced, the record written
        hold_del = ' . '.join(f'<{HOLD_S}> <{p}> {sparql_term(o)}' for p, os_ in hold.items() for o in os_)
        evidence_json = json.dumps(doc['evidence'], sort_keys=True, separators=(',', ':'), ensure_ascii=False)
        I = lambda n: f'"{int(n)}"^^<{XSD_INTEGER}>'
        rec = (f'<{record}> a <{REC_T}> ; <{REC["nextPostSeq"]}> {I(R)} ; <{REC["declaredGap"]}> {I(G)} ; '
               f'<{REC["approvedBy"]}> <{doc["approvedBy"]}> ; <{REC["approvalRef"]}> {json.dumps(doc["approvalRef"])} ; '
               f'<{REC["evidenceJson"]}> {json.dumps(evidence_json)} ; '
               f'<{REC["evidenceSha256"]}> {json.dumps(hashlib.sha256(evidence_json.encode("utf-8")).hexdigest())} ; '
               f'<{REC["fileSha256"]}> {json.dumps(digest)} ; '
               f'<{REC["reconciledAt"]}> "{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}"^^<http://www.w3.org/2001/XMLSchema#dateTime> ; '
               f'<{REC["clearedHoldEpoch"]}> {json.dumps(stored["epoch"])} ; <{REC["clearedHoldIncarnation"]}> {json.dumps(stored["incarnation"])} ; '
               f'<{REC["clearedHoldCommitSeq"]}> {I(stored["restoredCommitSeq"])} ; <{REC["clearedHoldHighWater"]}> {I(hw)} ; '
               f'<{REC["priorNextPostSeq"]}> {I(nxt)}')
        try:
            self.store.update(
                f'DELETE DATA {{ GRAPH <{RG}> {{ {hold_del} }} GRAPH <{BK}> {{ <{ALLOC_S}> <{ALLOC_NEXT}> {sparql_term(nxt_t)} . '
                f'<{ALLOC_S}> <{ALLOC_VERSION}> {sparql_term(ver_t)} }} }} ;\n'
                f'INSERT DATA {{ GRAPH <{BK}> {{ <{ALLOC_S}> <{ALLOC_NEXT}> {I(R)} . <{ALLOC_S}> <{ALLOC_VERSION}> {I(ver + 1)} }} '
                f'GRAPH <{RG}> {{ {rec} }} }}')
            self.store.flush()
        except OSError as e:
            raise SystemExit(f'REFUSED: the reconciliation write or its flush failed (durability fault; reconcile by reading the '
                             f'store before any rerun): {e}')
        if self._hold_present() or self._bk_values(ALLOC_S, ALLOC_NEXT) != [px.Literal(str(R), datatype=px.NamedNode(XSD_INTEGER))]:
            raise SystemExit('REFUSED: the reconciliation transaction did not leave the state it wrote; inspect the store offline')
        return {'result': 'RECONCILED', 'record': record, 'nextPostSeq': R}

    def _set_identity(self, pred, value):
        """Replace the single marker value of `pred` (or remove it when value is None)."""
        ins = f'INSERT {{ GRAPH <{BK}> {{ <{DATASET.value}> <{pred.value}> {json.dumps(value)} }} }} ' if value is not None else ''
        self.store.update(f'DELETE {{ GRAPH <{BK}> {{ <{DATASET.value}> <{pred.value}> ?v }} }} {ins}'
                          f'WHERE {{ OPTIONAL {{ GRAPH <{BK}> {{ <{DATASET.value}> <{pred.value}> ?v }} }} }}')

    def _floor_value(self):
        """#1748 the installed write protocol, or None. A store holding more than one value is contradictory: it refuses
        to start rather than pick one."""
        rows = list(self.store.query(f'SELECT ?v WHERE {{ {in_bk(f"<{FLOOR_S.value}> <{FLOOR_P.value}> ?v")} }}'))
        if not rows:
            return None
        if len(rows) != 1:
            raise SystemExit(f'REFUSED: the store holds {len(rows)} write floor values (expected at most 1)')
        v = rows[0]['v']
        if not isinstance(v, px.Literal) or v.language is not None or v.datatype.value != 'http://www.w3.org/2001/XMLSchema#string':
            raise SystemExit(f'REFUSED: the write floor is not a plain string literal ({v})')
        return v.value

    def _floor_recorded(self):
        return bool(self.store.query(f'ASK {{ {in_bk(f"<{FLOOR_S.value}> <{FLOOR_INSTALLED_BY.value}> {json.dumps(FLOOR_INSTALLER)}")} }}'))

    def _sentinel_present(self):
        # the graph's EXISTENCE, not its triples: the guard's CREATE GRAPH fails on an empty named graph too
        return self.store.contains_named_graph(px.NamedNode(FLOOR_VIOLATION))

    def _stray_record(self):
        return bool(self.store.query(f'ASK {{ {in_bk(f"<{FLOOR_S.value}> <{FLOOR_INSTALLED_BY.value}> ?v")} }}'))

    def _violated(self, floor_value):
        """#1748 the ONE pattern that says the floor or its install record is not exactly as installed. The write guard
        and the start check both use it, so a state a start accepts is a state every write accepts."""
        want, rec = json.dumps(floor_value), json.dumps(FLOOR_INSTALLER)
        floor, by = f'<{FLOOR_S.value}> <{FLOOR_P.value}>', f'<{FLOOR_S.value}> <{FLOOR_INSTALLED_BY.value}>'
        return (f'{{ FILTER NOT EXISTS {{ GRAPH <{BK}> {{ {floor} ?v0 . FILTER(sameTerm(?v0, {want})) }} }} }} UNION '
                f'{{ GRAPH <{BK}> {{ {floor} ?v1 . FILTER(!sameTerm(?v1, {want})) }} }} UNION '
                f'{{ FILTER NOT EXISTS {{ GRAPH <{BK}> {{ {by} ?v2 . FILTER(sameTerm(?v2, {rec})) }} }} }} UNION '
                f'{{ GRAPH <{BK}> {{ {by} ?v3 . FILTER(!sameTerm(?v3, {rec})) }} }}')

    def _check_floor_provenance(self, held):
        """#1748 a floor is honoured only with the install record written beside it by --install-write-floor. A floor
        without one got there some other way (an /update on an unfloored store, which is not guarded): refuse to start and
        name the fix, rather than serve 428 to every writer. Not a defence against a deliberate forger (the header never
        was); it ends the silent brick. A floored store whose sentinel graph exists would refuse every write: refuse that too."""
        if held is None:
            return
        if not self._floor_recorded():
            raise SystemExit(f'REFUSED: the store holds write floor {held!r} with no install record, so it was not installed by '
                             f'--install-write-floor. If it is intended, relaunch once with --install-write-floor {held} to '
                             'record it; if not, remove it offline')
        if bool(self.store.query(f'ASK {{ {self._violated(held)} }}')):
            raise SystemExit('REFUSED: the write floor or its install record is not exactly as --install-write-floor wrote '
                             'it (a second or rewritten value), so the floor guard would refuse every write; remove the '
                             'extra value offline')
        if self._sentinel_present():
            raise SystemExit(f'REFUSED: the store holds the graph <{FLOOR_VIOLATION}>, so the floor guard would refuse every '
                             'write; remove it offline')

    def _floor_guarded(self, sparql):
        """#1748 `sparql` followed, in the SAME update, by operations that fail the whole update unless the floor and its
        install record are still exactly the installed terms afterwards (_violated). Store.update is all-or-nothing, so a
        delete, a rewrite (to another value, a language tag or a datatype), a wipe, a second value, or an effect that
        depends on other data is never applied, and nothing has to be restored. The check reads the store state the update
        produced; it never parses the body. Floored stores only; the #1749 hold guard (_update_guarded) runs on every store.
        The join is always `;`, which ends the body's last operation, so nothing of the guard can fuse into it. A body
        whose own text leaves `;` nothing to follow (a comment after a final `;`, a comment-only or prologue-only body) is
        therefore a syntax error with nothing applied, like any malformed body: an honest 500, never a false success."""
        body = sparql.rstrip().rstrip(';')
        return (f'{body}\n;\n' if body.strip() else '') + (
                f'INSERT {{ GRAPH <{FLOOR_VIOLATION}> {{ <{FLOOR_VIOLATION}> <{FLOOR_VIOLATION}> <{FLOOR_VIOLATION}> }} }} '
                f'WHERE {{ {self._violated(self.write_floor)} }} ;\n'
                f'CREATE GRAPH <{FLOOR_VIOLATION}> ;\nDROP GRAPH <{FLOOR_VIOLATION}>')

    def _update_guarded(self, sparql):
        """#1748 + #1749 (A7 v2 P1, P3 v3) one guarded, all-or-nothing update, run exactly ONCE and never retried (a retry
        joined differently could fuse a body that is invalid on its own with the guard into something valid, and report a
        false success). EVERY /update on EVERY store runs as the body, the `;` join of _floor_guarded, then the floor's
        operations when a floor is installed, then the recovery graph's. Stated consequence (P3 v3): a body with no update
        operation (comment-only, prologue-only) is the engine's parse error, a 500 with nothing applied, on every store.
        The recovery snapshot is read here, inside the update lock (the executor's single-writer serialization)."""
        body = sparql.rstrip().rstrip(';')
        guarded = self._floor_guarded(sparql) if self.write_floor is not None else (f'{body}\n;\n' if body.strip() else '')
        sep = ' ;\n' if self.write_floor is not None else ''
        guarded = f'{guarded}{sep}{self._guard_ops_hold(self._recovery_snapshot())}'
        try:
            self.store.update(guarded)
        except OSError:
            raise
        except Exception as e:
            if FLOOR_VIOLATION in str(e):   # the floor guard failed the whole update: nothing was applied
                raise FloorProtected(self.write_floor)
            if HOLD_VIOLATION in str(e):    # the hold guard failed the whole update: nothing was applied
                raise HoldProtected()
            raise

    def _hold_present_or_none(self):
        try:
            return self._hold_present()
        except Exception:
            return None

    def _identity(self):
        """#1577 incarnation / incarnationFrom / storeHome / epochBase, each None when absent. Never raises."""
        out = {}
        for key, pred in (('incarnation', P_INCARNATION), ('incarnationFrom', P_INCARNATION_FROM),
                          ('storeHome', P_STORE_HOME), ('storeHomeInode', P_STORE_HOME_INODE), ('epochBase', P_EPOCH_BASE)):
            try:
                rows = list(self.store.query(f'SELECT ?v WHERE {{ {in_bk(f"<{DATASET.value}> <{pred.value}> ?v")} }}'))
                out[key] = rows[0]['v'].value if len(rows) == 1 else (None if not rows else f'CONTRADICTORY ({len(rows)} values)')
            except Exception:
                out[key] = None
        return out

    def _epoch_or_none(self):
        """The store's epoch for write fencing, or None when it cannot be read as exactly one
        integer. Never raises: _marker() refuses (SystemExit) on a contradictory marker, which is
        right at startup and fatal mid-request (it killed the process in the resolver suite)."""
        try:
            rows = list(self.store.query(f'SELECT ?e WHERE {{ {in_bk(f"<{DATASET.value}> <{P_EPOCH.value}> ?e")} }}'))
            return int(rows[0]['e'].value) if len(rows) == 1 else None
        except Exception:
            return None

    def _marker(self):
        rows = list(self.store.query(
            f'SELECT ?id ?e ?s WHERE {{ GRAPH <{BK}> {{ <{DATASET.value}> <{P_DATASET_ID.value}> ?id ; '
            f'<{P_EPOCH.value}> ?e ; <{P_COMMIT_SEQ.value}> ?s }} }}'))
        if not rows:
            return None
        if len(rows) != 1:
            raise SystemExit(f'REFUSED: {len(rows)} marker rows (expected 1)')
        r = rows[0]
        return {'datasetId': r['id'].value, 'epoch': r['e'].value, 'commitSeq': r['s'].value}

    def log(self, op_id, kind, status, ms, body_sha):
        if self.log_file:
            ts = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime()) + f'.{int(time.time()*1000)%1000:03d}Z'
            self.log_file.write(f'{ts} {op_id or "-"} {kind} {status} {ms:.3f} {body_sha}\n')

    def receipt(self, op_iri):
        rows = list(self.store.query(f'SELECT ?p ?o WHERE {{ {in_bk(f"<{op_iri}> ?p ?o")} }}'))
        if not rows:
            return None
        out = {}
        for r in rows:
            k = r['p'].value
            k = k[len(NS):] if k.startswith(NS) else k
            out.setdefault(k, []).append(term_json(r['o']))
        return out

    def update(self, sparql, op_iri, caller_epoch=None, protocol=None):
        """Returns the stored receipt. Raises Degraded before touching the store when
        latched; raises ReconcileRequired when the caller's epoch is not the store's and
        this opId has no receipt here; raises on engine or flush error (UNKNOWN).
        #1748: with a write floor installed, raises ProtocolRequired unless `protocol` (the request's declared
        protocol, a list of every header value) is exactly [floor], before even a receipt replay; and FloorProtected
        when the update would leave the floor or its install record anything but the installed terms, decided inside the
        same all-or-nothing update (_floor_guarded), so nothing of it is applied or flushed. #1749: on EVERY store, floored
        or not, raises HoldProtected when the update would leave the recovery hold or a reconciliation record anything but
        what it was, decided the same way inside the same update (_update_guarded)."""
        with self.lock:
            if self.degraded:
                raise Degraded(self.degraded)
            if self.write_floor is not None:
                if protocol != [self.write_floor]:
                    raise ProtocolRequired(self.write_floor)
            store_epoch = self._epoch_or_none()
            # a store with no readable marker cannot be epoch-fenced (startup guarantees one;
            # raw fixtures that wipe the store must not crash every write)
            if store_epoch is not None and ((caller_epoch is None and store_epoch > 1) or (caller_epoch is not None and str(caller_epoch) != str(store_epoch))):
                # A caller from another epoch: its intention was decided against a store that may
                # not be this one. A RECORDED outcome is still the outcome; anything else must be
                # reconciled downstream before a fresh opId is used. "Receipt absent" after a
                # restore does NOT make a blind replay safe (D2 section 7).
                rec = self.receipt(op_iri)
                if rec:
                    # a replay acknowledgement is flushed like any other (D2 proofs P6; a reviewer 14:11Z)
                    try:
                        self.store.flush()
                        self.flushes += 1
                    except OSError as e:
                        self.degraded = {'since': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                                         'reason': str(e)[:300], 'failedOpId': op_iri,
                                         'recovery': 'restart the executor; reconcile failedOpId by its receipt before any retry'}
                        raise
                    return rec
                raise ReconcileRequired({'reason': 'caller epoch differs from the store epoch and this opId has no receipt here',
                                         'storeEpoch': store_epoch, 'callerEpoch': caller_epoch})
            try:
                self._update_guarded(sparql)
                self.updates += 1
                self.store.flush()
                self.flushes += 1
            except OSError as e:
                # a storage fault: LATCH. The op may or may not have committed: never assume.
                self.degraded = {'since': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                                 'reason': str(e)[:300], 'failedOpId': op_iri,
                                 'recovery': 'restart the executor; reconcile failedOpId by its receipt before any retry'}
                raise
            return self.receipt(op_iri)

    def checkpoint(self):
        """#1559 a consistent snapshot for the backup script. Taken INSIDE the write lock, so no
        update lands between the checkpoint and the quad count + commit marker reported with it:
        those two numbers describe exactly the files in the directory. The directory name is
        the executor's, never the caller's (a localhost caller cannot aim a write).
        Observed (pyoxigraph 0.5.11, 2026-10-04): on the same filesystem the SSTs and OPTIONS
        are HARD LINKS to the live store's files (shared inode, nlink 2); only CURRENT,
        MANIFEST and the WAL are new files. So this is NOT an independent copy."""
        with self.lock:
            if self.degraded:
                raise Degraded(self.degraded)
            # read the marker FIRST: a contradictory one refuses before any checkpoint directory
            # exists, and never as SystemExit mid-request (the bb19875 rule, for this route too)
            try:
                marker = self._marker()
            except SystemExit as e:
                raise MarkerUnsound(str(e))
            os.makedirs(self.checkpoint_dir, exist_ok=True)
            name = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + f'-{os.getpid()}-{int(time.time() * 1000) % 1000:03d}'
            target = os.path.join(self.checkpoint_dir, name)
            self.store.backup(target)
            return {'path': target, 'quads': len(self.store), **marker}

    def query(self, sparql, public=False):
        # #1570 PUBLIC DATASET: the default graph only, and NO named graphs. Passed as an override, it wins
        # over the query's own FROM / FROM NAMED / GRAPH <...> (measured on pyoxigraph 0.5.11), so bookkeeping
        # kept in a named graph cannot be reached through a public read however the query is written.
        r = self.store.query(sparql, default_graph=px.DefaultGraph(), named_graphs=[]) if public else self.store.query(sparql)
        if isinstance(r, (bool, px.QueryBoolean)):
            return {'head': {}, 'boolean': bool(r)}
        if isinstance(r, px.QueryTriples):
            raise ValueError('CONSTRUCT/DESCRIBE not supported')
        vs = [v.value for v in r.variables]
        bs = []
        for row in r:
            b = {}
            for k in vs:
                t = row[k]
                if t is not None:
                    b[k] = term_json(t)
            bs.append(b)
        return {'head': {'vars': vs}, 'results': {'bindings': bs}}

    def health(self):
        # never SystemExit mid-request: a contradictory marker is REPORTED, not fatal here
        try:
            m = self._marker() or {}
        except SystemExit as e:
            m = {'markerError': str(e)}
        return {**m, **self._identity(), 'status': 'DEGRADED' if self.degraded else 'OK', 'degraded': self.degraded, 'promoted': self.promoted,
                'readOnly': self.read_only, 'layout': 'bookkeeping-graph', 'writeFloor': self.write_floor,
                'recoveryHold': self._hold_present_or_none(), 'reconciled': self.reconciled,
                'flushes': self.flushes, 'updates': self.updates, 'syncMode': SYNC_MODE, 'listenBacklog': LISTEN_BACKLOG}


def make_handler(ex):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, obj):
            data = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == '/health':
                return self._send(200, ex.health())
            if self.path.startswith('/receipt/'):
                op = urllib.parse.unquote(self.path[len('/receipt/'):])
                return self._send(200, {'opId': op, 'receipt': ex.receipt(op)})
            self._send(404, {'error': 'not found'})

        def do_POST(self):
            t0 = time.perf_counter()
            raw = self.rfile.read(int(self.headers.get('content-length', 0)))
            sha = hashlib.sha256(raw).hexdigest()
            body = raw.decode()
            op = self.headers.get('x-op-id')
            if self.path == '/update':
                if ex.read_only:   # #1638 the fence: nothing is written, and the writer is TOLD, never silently dropped
                    ex.log(op, 'update', 'REFUSED-READ-ONLY', 0, sha)
                    return self._send(503, {'error': 'READ-ONLY: this executor serves reads only (a cutover or rollback fence); writes are refused', 'readOnly': True})
                if not op:
                    ex.log(None, 'update', 'REFUSED-NO-OPID', 0, sha)
                    return self._send(400, {'error': 'x-op-id header required'})
                declared = self.headers.get_all(PROTOCOL_HEADER) or []
                try:
                    rec = ex.update(body, op, self.headers.get('x-epoch'), protocol=declared)
                except ProtocolRequired as f:  # #1748 refused before update(): applied nothing, flushed nothing
                    ex.log(op, 'update', 'REFUSED-WRITE-PROTOCOL', (time.perf_counter() - t0) * 1000, sha)
                    return self._send(428, {'error': 'WRITE_PROTOCOL_REQUIRED', 'applied': False, 'requiredProtocol': str(f),
                                            'reason': f'this store accepts writes only from clients declaring {PROTOCOL_HEADER}: {f}'})
                except FloorProtected as f:  # #1748 refused before update(): the floor is not writable through /update
                    ex.log(op, 'update', 'REFUSED-FLOOR-PROTECTED', (time.perf_counter() - t0) * 1000, sha)
                    return self._send(409, {'error': 'WRITE_FLOOR_PROTECTED', 'applied': False, 'floor': f.args[0],
                                            'reason': 'an /update may not delete, rewrite or contradict the installed write floor or its '
                                                      'install record'})
                except HoldProtected:  # #1749 refused whole inside the update: the hold and records are not writable here
                    ex.log(op, 'update', 'REFUSED-HOLD-PROTECTED', (time.perf_counter() - t0) * 1000, sha)
                    return self._send(409, {'error': 'HOLD_PROTECTED', 'applied': False,
                                            'reason': 'an /update may not delete, rewrite or add to the recovery hold or a '
                                                      'reconciliation record, whatever protocol it declares; only the '
                                                      'executor\'s --reconcile-postseq maintenance start clears the hold'})
                except ReconcileRequired as r:  # refused before update(): applied nothing
                    ex.log(op, 'update', 'RECONCILE-REQUIRED', (time.perf_counter() - t0) * 1000, sha)
                    return self._send(409, {'error': 'reconcile required', 'reconcileRequired': r.info})
                except Degraded as d:  # THIS attempt was refused before update(): it applied nothing
                    ex.log(op, 'update', 'REFUSED-DEGRADED', (time.perf_counter() - t0) * 1000, sha)
                    # ...but if this is the opId whose write faulted, that EARLIER attempt may have
                    # committed: the intention stays unknown until reconciled (a reviewer pin 1; a reviewer probe)
                    return self._send(503, {'error': 'degraded: writes refused until restart', 'degraded': d.info,
                                            'sameOpAsFailed': op == d.info.get('failedOpId')})
                except Exception as e:  # engine or flush error: caller must treat as UNKNOWN
                    ex.log(op, 'update', 'ERROR', (time.perf_counter() - t0) * 1000, sha)
                    return self._send(500, {'error': str(e)[:300]})
                ex.log(op, 'update', 'OK', (time.perf_counter() - t0) * 1000, sha)
                return self._send(200, {'opId': op, 'receipt': rec, 'bodySha256': sha, 'flushed': True})
            if self.path == '/checkpoint':
                try:
                    cp = ex.checkpoint()
                except Degraded as d:
                    return self._send(503, {'error': 'degraded: no checkpoint until restart', 'degraded': d.info})
                except MarkerUnsound as e:
                    ex.log(op, 'checkpoint', 'REFUSED', (time.perf_counter() - t0) * 1000, sha)
                    return self._send(409, {'error': f'checkpoint refused: commit marker unsound: {e}'[:300]})
                except Exception as e:
                    ex.log(op, 'checkpoint', 'ERROR', (time.perf_counter() - t0) * 1000, sha)
                    return self._send(500, {'error': str(e)[:300]})
                ex.log(op, 'checkpoint', 'OK', (time.perf_counter() - t0) * 1000, sha)
                return self._send(200, cp)
            if self.path in ('/query', '/query?dataset=public'):
                try:
                    out = ex.query(body, public=self.path == '/query?dataset=public')
                except Exception as e:
                    ex.log(op, 'query', 'ERROR', (time.perf_counter() - t0) * 1000, sha)
                    return self._send(400, {'error': str(e)[:300]})
                ex.log(op, 'query', 'OK', (time.perf_counter() - t0) * 1000, sha)
                return self._send(200, out)
            self._send(404, {'error': 'not found'})
    return H


def main(argv):
    a = parse_args(argv)
    ex = Executor(a.store, a.dataset_id, create=a.create, log=a.log, promote_epoch=a.promote_epoch,
                  checkpoint_dir=a.checkpoint_dir, adopt_home=a.adopt_home, read_only=a.read_only,
                  install_write_floor=a.install_write_floor, reconcile_postseq=a.reconcile_postseq,
                  dispose_obligation=a.dispose_obligation)
    if ex.disposed is not None:   # #1749 A8, to stderr like the reconcile result
        r = ex.disposed
        print(f'ALREADY disposed {r["record"]}' if r['result'] == 'ALREADY'
              else f'DISPOSED {r["record"]}: the obligation is {r["status"]}; nothing was dispatched', file=sys.stderr, flush=True)
    if ex.reconciled is not None:   # stdout's first line is the ready line; the maintenance result goes to stderr
        r = ex.reconciled
        print(f'ALREADY reconciled {r["record"]}' if r['result'] == 'ALREADY'
              else f'RECONCILED {r["record"]}: allocation resumes at {r["nextPostSeq"]}', file=sys.stderr, flush=True)
    srv = Server(('127.0.0.1', a.port), make_handler(ex))
    if a.exit_on_stdin_eof:
        def watch():
            sys.stdin.read()
            import os
            os._exit(0)
        threading.Thread(target=watch, daemon=True).start()
    print(json.dumps({'ready': True, 'port': srv.server_address[1], **ex.health()}), flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main(sys.argv[1:])
