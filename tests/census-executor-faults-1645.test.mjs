/**
 * #1645 2b — FAULT ROWS for the executor census (/api/board/status `kinds`): an aggregate answer the census cannot trust must make it say
 * `unavailable`, never `live` with a count quietly dropped or zeroed. Asked for in code review of a5a1778 (43486): "malformed aggregate counts are
 * silently dropped, producing census: live and false zero counts". TEST AUTHOR's.
 *
 * THE SHAPE: the whole-board fixture under production's flags, with REST talking to the executor THROUGH A PROXY that rewrites only the census
 * aggregate's answer (the one request whose body holds `GROUP BY ?t`); every other request passes through unchanged. The proxy counts what it
 * rewrote, so a row whose fault never reached the census fails its precondition instead of passing on an untouched answer.
 *
 *   CF0  CONTROL: the proxy in pass-through mode changes nothing: census live, Card 3 (so the proxy is not itself the fault).
 *   CF1  one row's count is not a number ("abc")       } each: census is NOT "live", and no kind reports an instance count that the
 *   CF2  one row has no count binding at all          }  executor did not give (no 0 or number for scrum:Card, the corrupted kind); the
 *   CF3  one row's count is negative ("-1")           }  note says why (non-empty censusNote). The rewritten row is scrum:Card's.
 *   CF4  one row's count is not an integer ("2.5")    }
 *   CF5  one row's count is past Number.MAX_SAFE_INTEGER ("9007199254740993", which a Number silently rounds): added from review (43497)
 *   CF6  one row's count is the empty string ("", which Number() reads as 0): unavailable, like CF1-CF5. Added from review (43502)
 *   CF7  CONTROL against over-refusal: a count of "0" is a well-formed count, so the census stays live and reports exactly what the executor
 *        said (Card 0). A check so strict it refuses every count would pass CF1-CF6; it fails here. Added from review (43502)
 *
 * NOT covered, by name: a malformed TYPE binding (?t not an IRI: the query filters isIRI, so the executor cannot send one honestly); a truncated
 * page (selectExecutorAll's own paging).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld } from './helpers/whole-board-1645.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const PROD = { SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_QUERY_SOURCE: 'executor', SCRUM_GRAPH_READY_SOURCE: 'executor', SCRUM_GRAPH_CHECKS_SOURCE: 'executor' };

/** A proxy in front of the executor that rewrites the census aggregate's bindings with `fault(bindings)`; all else passes through. */
function censusProxy(fault) {
  const state = { rewritten: 0, cardSeen: false, server: null };
  const start = (execUrl) => new Promise((resolve) => {
    state.server = http.createServer((req, res) => {
      const chunks = []; req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k)));
        try {
          const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers, body: req.method === 'GET' ? undefined : body });
          let t = await f.text();
          if (fault && req.method === 'POST' && req.url.startsWith('/query') && body.toString().includes('GROUP BY ?t') && f.status === 200) {
            const j = JSON.parse(t);
            const card = j.results?.bindings?.find((b) => b.t?.value?.endsWith('#Card') || b.t?.value?.endsWith('/Card'));
            if (card) { state.cardSeen = true; state.cardIri = card.t.value; fault(card); state.rewritten += 1; t = JSON.stringify(j); }
          }
          res.writeHead(f.status, { 'content-type': f.headers.get('content-type') || 'application/json' }); res.end(t);
        } catch { try { req.socket.destroy(); } catch { /* gone */ } }
      });
    });
    state.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${state.server.address().port}`));
  });
  return { state, start, stop: () => new Promise((r) => (state.server ? state.server.close(() => r()) : r())) };
}

async function census(fault) {
  const proxy = censusProxy(fault);
  const w = await wholeBoardWorld({ env: PROD, front: proxy.start });
  try {
    const r = await fetch(`${w.rest.baseUrl}/api/board/status`, { signal: AbortSignal.timeout(60000) });
    const t = await r.text(); assert.equal(r.status, 200, `PRECONDITION: board status answered 200 (${t.slice(0, 200)})`);
    return { kinds: JSON.parse(t).kinds, proxy: proxy.state };
  } finally { await w.stop(); await proxy.stop(); }
}
const cardKind = (kinds) => kinds?.kinds?.find((k) => k.name === 'scrum:Card');

test('#1645 (CF0 CONTROL) the census proxy in pass-through mode changes nothing: census live, Card 3', { skip: SKIP, timeout: 240000 }, async () => {
  const { kinds } = await census(null);
  assert.equal(kinds?.census, 'live', `the census is live through the proxy (${JSON.stringify(kinds).slice(0, 300)})`);
  assert.equal(cardKind(kinds)?.instances, 3, 'and counts the fixture\'s three cards');
});

const FAULTS = [
  ['CF1', 'a count that is not a number', (b) => { b.n = { ...b.n, value: 'abc' }; }],
  ['CF2', 'a row with no count binding', (b) => { delete b.n; }],
  ['CF3', 'a negative count', (b) => { b.n = { ...b.n, value: '-1' }; }],
  ['CF4', 'a count that is not an integer', (b) => { b.n = { ...b.n, value: '2.5' }; }],
  ['CF5', 'a count past the safe-integer range', (b) => { b.n = { ...b.n, value: '9007199254740993' }; }],
  ['CF6', 'an empty-string count', (b) => { b.n = { ...b.n, value: '' }; }],
];
for (const [id, label, fault] of FAULTS) {
  test(`#1645 (${id}) ${label} in the census aggregate makes the census unavailable, never live with a made-up count`, { skip: SKIP, timeout: 240000 }, async () => {
    const { kinds, proxy } = await census(fault);
    assert.ok(proxy.rewritten >= 1 && proxy.cardSeen, `PRECONDITION: the fault reached the census aggregate (rewrote ${proxy.rewritten}; Card row seen ${proxy.cardSeen})`);
    assert.notEqual(kinds?.census, 'live', `${label}: the census must not say live (${JSON.stringify(kinds).slice(0, 300)})`);
    const card = cardKind(kinds);
    assert.ok(card == null || card.instances == null, `${label}: and scrum:Card reports no count the executor did not give (got ${JSON.stringify(card)})`);
    assert.ok(typeof kinds?.censusNote === 'string' && kinds.censusNote.length > 0, `${label}: and the note says why (${JSON.stringify(kinds?.censusNote)})`);
  });
}

test('#1645 (CF7 CONTROL) a count of "0" is well formed: the census stays live and reports exactly what the executor said', { skip: SKIP, timeout: 240000 }, async () => {
  const { kinds, proxy } = await census((b) => { b.n = { ...b.n, value: '0' }; });
  assert.ok(proxy.rewritten >= 1 && proxy.cardSeen, `PRECONDITION: the rewrite reached the census aggregate (rewrote ${proxy.rewritten})`);
  assert.equal(kinds?.census, 'live', `a well-formed count is not refused (${JSON.stringify(kinds).slice(0, 300)})`);
  assert.equal(cardKind(kinds)?.instances, 0, 'and the census reports the executor\'s 0, not a substitute');
});
