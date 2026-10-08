"""#1638 — move the executor's bookkeeping between the default graph and its named graph, OFFLINE, into a NEW store.

usage: python migrate_bookkeeping.py --source DIR --dest DIR (--forward | --reverse) [--batch N]

  --forward   pre-#1638 store -> new layout: every DEFAULT-graph quad that is bookkeeping moves into
              <urn:scrum:bookkeeping:executor>; every other quad keeps its graph.
  --reverse   new layout -> pre-#1638 store: every quad in <urn:scrum:bookkeeping:executor> moves back into the
              default graph; every other quad keeps its graph. (The rollback path, contract C7v4.)

Contract (card #1638, v4 + C9/C10):
  * The SOURCE is opened READ-ONLY and never written: nothing in its directory changes.
  * The SOURCE must not be held open by any process (C10): its RocksDB LOCK file is taken here, exclusively, for the
    whole run, so a live executor is refused before anything is written and none can start mid-copy. A quiet
    commitSeq is not proof that a store is stopped; the lock is.
  * The DEST must not exist, and nothing is ever written AT it until the copy is complete and verified: the store is
    built at <dest>.partial and renamed onto <dest> as the last step (C7). A run killed at any point leaves either no
    <dest> or a complete, verified one; a leftover <dest>.partial is never served and blocks a rerun until removed.
  * The copy is one streaming pass; nothing is moved in place.
  * The SOURCE must be in the layout the direction starts from, or nothing is written (exit 1, named).
  * What is bookkeeping is read from core/graph-vocab.mjs (BOOKKEEPING_PREDICATES, _SUBJECT_PREFIXES, _SUBJECTS)
    through node: there is ONE definition, and this script holds no copy of it.
  * Verified before exit 0: the dest's quads equal the source's quads with ONLY the moved quads' graph changed
    (a hash of the sorted multiset, not counts), and per-graph counts are printed.
  * The dest still records the SOURCE's home in its marker, so the executor refuses to serve it until it is
    started once with --promote-epoch (new incarnation, epoch bump, this path as home). That is deliberate.

No flag has a default that points at a live path. Exit 2 = a usage error (named); exit 1 = refused or failed.
"""
import argparse, fcntl, hashlib, json, os, shutil, subprocess, sys, time

import pyoxigraph as px

BK = 'urn:scrum:bookkeeping:executor'
DATASET = 'urn:ex:dataset'
HERE = os.path.dirname(os.path.abspath(__file__))
VOCAB = os.path.join(HERE, '..', 'core', 'graph-vocab.mjs')


def die(code, msg):
    print(f'migrate_bookkeeping: {msg}', file=sys.stderr)
    sys.exit(code)


def parse(argv):
    # argparse would exit 2 too, but its message does not always NAME the flag; check by hand, in order.
    a = {'batch': '50000'}
    i = 0
    while i < len(argv):
        x = argv[i]
        if x in ('--forward', '--reverse'):
            if 'direction' in a:
                die(2, 'give exactly one of --forward or --reverse')
            a['direction'] = x[2:]
            i += 1
            continue
        if x in ('--source', '--dest', '--batch'):
            if i + 1 >= len(argv) or argv[i + 1].startswith('--'):
                die(2, f'{x} needs a value')
            a[x[2:]] = argv[i + 1]
            i += 2
            continue
        die(2, f'unknown argument {x}')
    for k in ('source', 'dest'):
        if k not in a:
            die(2, f'missing --{k} (no default: every store path is given explicitly)')
    if 'direction' not in a:
        die(2, 'missing --forward or --reverse')
    try:
        a['batch'] = int(a['batch'])
        assert a['batch'] > 0
    except Exception:
        die(2, '--batch must be a positive integer')
    return a


def load_definition():
    node = shutil.which('node') or '/opt/homebrew/opt/node@22/bin/node'
    js = (f"import({json.dumps('file://' + os.path.abspath(VOCAB))}).then(v => console.log(JSON.stringify("
          "{p: v.BOOKKEEPING_PREDICATES, sp: v.BOOKKEEPING_SUBJECT_PREFIXES, s: v.BOOKKEEPING_SUBJECTS, g: v.BOOKKEEPING_GRAPH})))")
    try:
        out = subprocess.run([node, '--input-type=module', '-e', js], capture_output=True, text=True, timeout=60, check=True).stdout
        d = json.loads(out)
    except Exception as e:
        die(1, f'could not read the bookkeeping definition from {VOCAB} via {node}: {e}')
    strip = lambda x: x[1:-1] if x.startswith('<') and x.endswith('>') else x
    if d['g'] != BK:
        die(1, f'the vocabulary names the bookkeeping graph {d["g"]!r}, this script expects {BK!r}')
    return {strip(p) for p in d['p']}, list(d['sp']), set(d['s'])


def is_bk(q, preds, prefixes, subjects):
    s, p = q.subject, q.predicate
    sv = s.value if isinstance(s, px.NamedNode) else None
    return p.value in preds or (sv is not None and (sv in subjects or any(sv.startswith(x) for x in prefixes)))


def line(q, graph_override=None):
    g = q.graph_name if graph_override is None else graph_override
    gs = '' if isinstance(g, px.DefaultGraph) else str(g)
    return f'{q.subject} {q.predicate} {q.object} {gs}'


def main(argv):
    a = parse(argv)
    src, dst = os.path.abspath(a['source']), os.path.abspath(a['dest'])
    if not os.path.isfile(os.path.join(src, 'CURRENT')):
        die(2, f'--source {src} is not a store directory (no CURRENT)')
    if os.path.exists(dst):
        die(2, f'--dest {dst} already exists: the migration writes a NEW store and never overwrites one')
    part = dst + '.partial'
    if os.path.exists(part):
        die(2, f'{part} exists: a previous run did not finish. It was never served; inspect it, remove it, then rerun.')
    if not os.path.isdir(os.path.dirname(dst)):
        die(2, f'the parent of --dest ({os.path.dirname(dst)}) does not exist')
    # C10 — the source must be STOPPED, proven by its lock, and kept stopped until the copy is verified. RocksDB holds
    # an fcntl write lock on <dir>/LOCK for as long as a read-write open lasts; a read-only open takes none, which is
    # why this check exists. The lock is held (not just probed) so no executor can open the source mid-copy.
    try:
        lock_fd = os.open(os.path.join(src, 'LOCK'), os.O_RDWR)
        fcntl.lockf(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except FileNotFoundError:
        die(2, f'--source {src} has no LOCK file: not a RocksDB store directory')
    except OSError:
        die(1, f'REFUSED: --source {src} is held open by another process (its LOCK is taken): stop the executor and '
               'confirm it has exited before migrating. Nothing written.')
    # a stated, greppable moment: from here until exit no other process can open the source (a row waits for this line)
    print(f'migrate_bookkeeping: SOURCE LOCKED {src} (held until exit)', file=sys.stderr, flush=True)
    preds, prefixes, subjects = load_definition()
    bkg = px.NamedNode(BK)
    t0 = time.time()
    ro = px.Store.read_only(src)

    marker_default = bool(ro.query(f'ASK {{ <{DATASET}> ?p ?o }}'))
    marker_bk = bool(ro.query(f'ASK {{ GRAPH <{BK}> {{ <{DATASET}> ?p ?o }} }}'))
    if a['direction'] == 'forward' and not (marker_default and not marker_bk):
        die(1, f'REFUSED: --forward needs a pre-#1638 store (marker in the default graph only); '
               f'this one has marker in default={marker_default}, in bookkeeping graph={marker_bk}. Nothing written.')
    if a['direction'] == 'reverse' and not (marker_bk and not marker_default):
        die(1, f'REFUSED: --reverse needs a #1638-layout store (marker in the bookkeeping graph only); '
               f'this one has marker in default={marker_default}, in bookkeeping graph={marker_bk}. Nothing written.')

    def target(q):
        if a['direction'] == 'forward':
            return bkg if isinstance(q.graph_name, px.DefaultGraph) and is_bk(q, preds, prefixes, subjects) else q.graph_name
        return px.DefaultGraph() if q.graph_name == bkg else q.graph_name

    out = px.Store(part)   # C7 — built aside; it becomes <dest> only by the rename at the very end
    batch, moved, total = [], 0, 0
    src_lines = []
    for q in ro.quads_for_pattern(None, None, None, None):
        g = target(q)
        if g != q.graph_name:
            moved += 1
        total += 1
        src_lines.append(line(q, g))
        batch.append(px.Quad(q.subject, q.predicate, q.object, g))
        if len(batch) >= a['batch']:
            out.bulk_extend(batch)
            batch = []
    if batch:
        out.bulk_extend(batch)
    out.flush()
    t_copy = time.time() - t0

    # VERIFY: the dest holds exactly the source's quads with only the moved quads' graph changed (a multiset hash)
    dst_lines = [line(q) for q in out.quads_for_pattern(None, None, None, None)]
    h = lambda xs: hashlib.sha256('\n'.join(sorted(xs)).encode()).hexdigest()
    hs, hd = h(src_lines), h(dst_lines)
    per_graph = {}
    for q in out.quads_for_pattern(None, None, None, None):
        k = 'default' if isinstance(q.graph_name, px.DefaultGraph) else q.graph_name.value
        per_graph[k] = per_graph.get(k, 0) + 1
    report = {'direction': a['direction'], 'source': src, 'dest': dst, 'quads': total, 'moved': moved,
              'destQuads': len(dst_lines), 'perGraph': per_graph, 'multisetSha256': hd,
              'copySeconds': round(t_copy, 2), 'totalSeconds': round(time.time() - t0, 2)}
    if hs != hd or len(dst_lines) != total:
        print(json.dumps(report, indent=1))
        die(1, f'VERIFY FAILED: the dest multiset ({hd[:16]}, {len(dst_lines)} quads) differs from the mapped source '
               f'({hs[:16]}, {total} quads). Nothing was placed at {dst}; the incomplete copy is {part}.')
    after_default = bool(out.query(f'ASK {{ <{DATASET}> ?p ?o }}'))
    after_bk = bool(out.query(f'ASK {{ GRAPH <{BK}> {{ <{DATASET}> ?p ?o }} }}'))
    want_bk = a['direction'] == 'forward'
    if after_bk != want_bk or after_default == want_bk:
        die(1, f'VERIFY FAILED: the dest marker is in default={after_default}, bookkeeping graph={after_bk}; '
               f'nothing was placed at {dst}')
    # C7 — PUBLISH: close the store (flushed above), then one rename on the same filesystem. Until this line runs there
    # is no <dest>; after it, <dest> is the complete, verified copy. fsync the parent so the rename itself is durable.
    del out
    import gc; gc.collect()
    os.rename(part, dst)
    pfd = os.open(os.path.dirname(dst), os.O_RDONLY)
    try:
        os.fsync(pfd)
    finally:
        os.close(pfd)
    print(json.dumps(report, indent=1))
    print('migrate_bookkeeping: OK. Start the executor on the dest ONCE with --promote-epoch before serving it.')


if __name__ == '__main__':
    main(sys.argv[1:])
