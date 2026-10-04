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
                           [--checkpoint-dir DIR] [--promote-epoch] [--adopt-home]
"""
import argparse, hashlib, json, os, sys, threading, time, urllib.parse, uuid
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import pyoxigraph as px

NS = 'urn:ex:'
DATASET = px.NamedNode(NS + 'dataset')
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
        def one(pred):
            rows = list(ro.query(f'SELECT ?v WHERE {{ <{DATASET.value}> <{pred.value}> ?v }}'))
            return rows[0]['v'].value if len(rows) == 1 else None
        recorded_home, recorded_inode = one(P_STORE_HOME), one(P_STORE_HOME_INODE)
    except Exception:
        return None
    finally:
        del ro
    home = os.path.realpath(store_dir)
    return home_refusal(recorded_home, recorded_inode, home, str(os.stat(home).st_ino), promote_epoch, adopt_home)


class Executor:
    def __init__(self, store_dir, dataset_id, create=False, log=None, promote_epoch=False, checkpoint_dir=None,
                 adopt_home=False):
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
            self.store = px.Store(store_dir)
        except OSError as e:
            raise SystemExit(f'REFUSED: store could not be opened for writing (durability fault): {e}')
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
                f'INSERT DATA {{ <{DATASET.value}> <{P_DATASET_ID.value}> {json.dumps(dataset_id)} ; '
                f'<{P_EPOCH.value}> 1 ; <{P_COMMIT_SEQ.value}> 0 ; '
                f'<{P_INCARNATION.value}> {json.dumps(str(uuid.uuid4()))} ; <{P_STORE_HOME.value}> {json.dumps(self.home)} ; '
                f'<{P_STORE_HOME_INODE.value}> {json.dumps(self.home_inode)} }}')   # #1577
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
        probe = f'<{NS}selfcheck/{int(time.time() * 1000)}>'
        try:
            # a crash between an earlier self-check's insert and delete would leave its probe behind
            self.store.update(f'DELETE {{ ?stale <{NS}selfCheck> true }} WHERE {{ ?stale <{NS}selfCheck> true . FILTER(STRSTARTS(STR(?stale), "{NS}selfcheck/")) }}')   # reserved namespace AND predicate only
            self.store.update(f'INSERT DATA {{ {probe} <{NS}selfCheck> true }}')
            self.store.flush()
            self.store.update(f'DELETE DATA {{ {probe} <{NS}selfCheck> true }}')
            self.store.flush()
        except OSError as e:
            raise SystemExit(f'REFUSED: startup self-check write+flush failed (durability fault): {e}')
        # #1559 restore PROMOTION: a new epoch, visible before any write is served. Never a rollback
        # of the commit sequence (D1 v0.2): commitSeq is left as the restored store recorded it.
        self.promoted = None
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
            self.store.update(
                f'DELETE {{ <{D}> <{P_EPOCH.value}> ?e . <{D}> <{P_EPOCH_BASE.value}> ?b . <{D}> <{P_INCARNATION.value}> ?i . '
                f'<{D}> <{P_INCARNATION_FROM.value}> ?f . <{D}> <{P_STORE_HOME.value}> ?h . <{D}> <{P_STORE_HOME_INODE.value}> ?n }} '
                f'INSERT {{ <{D}> <{P_EPOCH.value}> ?e1 . <{D}> <{P_EPOCH_BASE.value}> ?s . '
                f'<{D}> <{P_INCARNATION.value}> {json.dumps(new_inc)} . <{D}> <{P_INCARNATION_FROM.value}> ?i . '
                f'<{D}> <{P_STORE_HOME.value}> {json.dumps(self.home)} . <{D}> <{P_STORE_HOME_INODE.value}> {json.dumps(self.home_inode)} }} '
                f'WHERE {{ <{D}> <{P_EPOCH.value}> ?e ; <{P_COMMIT_SEQ.value}> ?s . '
                f'OPTIONAL {{ <{D}> <{P_EPOCH_BASE.value}> ?b }} OPTIONAL {{ <{D}> <{P_INCARNATION.value}> ?i }} '
                f'OPTIONAL {{ <{D}> <{P_INCARNATION_FROM.value}> ?f }} OPTIONAL {{ <{D}> <{P_STORE_HOME.value}> ?h }} '
                f'OPTIONAL {{ <{D}> <{P_STORE_HOME_INODE.value}> ?n }} '
                f'BIND(?e + 1 AS ?e1) }}')
            self.store.flush()
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

    def _set_identity(self, pred, value):
        """Replace the single marker value of `pred` (or remove it when value is None)."""
        ins = f'INSERT {{ <{DATASET.value}> <{pred.value}> {json.dumps(value)} }} ' if value is not None else ''
        self.store.update(f'DELETE {{ <{DATASET.value}> <{pred.value}> ?v }} {ins}'
                          f'WHERE {{ OPTIONAL {{ <{DATASET.value}> <{pred.value}> ?v }} }}')

    def _identity(self):
        """#1577 incarnation / incarnationFrom / storeHome / epochBase, each None when absent. Never raises."""
        out = {}
        for key, pred in (('incarnation', P_INCARNATION), ('incarnationFrom', P_INCARNATION_FROM),
                          ('storeHome', P_STORE_HOME), ('storeHomeInode', P_STORE_HOME_INODE), ('epochBase', P_EPOCH_BASE)):
            try:
                rows = list(self.store.query(f'SELECT ?v WHERE {{ <{DATASET.value}> <{pred.value}> ?v }}'))
                out[key] = rows[0]['v'].value if len(rows) == 1 else (None if not rows else f'CONTRADICTORY ({len(rows)} values)')
            except Exception:
                out[key] = None
        return out

    def _epoch_or_none(self):
        """The store's epoch for write fencing, or None when it cannot be read as exactly one
        integer. Never raises: _marker() refuses (SystemExit) on a contradictory marker, which is
        right at startup and fatal mid-request (it killed the process in the resolver suite)."""
        try:
            rows = list(self.store.query(f'SELECT ?e WHERE {{ <{DATASET.value}> <{P_EPOCH.value}> ?e }}'))
            return int(rows[0]['e'].value) if len(rows) == 1 else None
        except Exception:
            return None

    def _marker(self):
        rows = list(self.store.query(
            f'SELECT ?id ?e ?s WHERE {{ <{DATASET.value}> <{P_DATASET_ID.value}> ?id ; '
            f'<{P_EPOCH.value}> ?e ; <{P_COMMIT_SEQ.value}> ?s }}'))
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
        rows = list(self.store.query(f'SELECT ?p ?o WHERE {{ <{op_iri}> ?p ?o }}'))
        if not rows:
            return None
        out = {}
        for r in rows:
            k = r['p'].value
            k = k[len(NS):] if k.startswith(NS) else k
            out.setdefault(k, []).append(term_json(r['o']))
        return out

    def update(self, sparql, op_iri, caller_epoch=None):
        """Returns the stored receipt. Raises Degraded before touching the store when
        latched; raises ReconcileRequired when the caller's epoch is not the store's and
        this opId has no receipt here; raises on engine or flush error (UNKNOWN)."""
        with self.lock:
            if self.degraded:
                raise Degraded(self.degraded)
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
                self.store.update(sparql)
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

    def query(self, sparql):
        r = self.store.query(sparql)
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
                if not op:
                    ex.log(None, 'update', 'REFUSED-NO-OPID', 0, sha)
                    return self._send(400, {'error': 'x-op-id header required'})
                try:
                    rec = ex.update(body, op, self.headers.get('x-epoch'))
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
            if self.path == '/query':
                try:
                    out = ex.query(body)
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
                  checkpoint_dir=a.checkpoint_dir, adopt_home=a.adopt_home)
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
