/**
 * #1640 test helper: a REST server with the graph slice on and a real executor behind it, over a board whose cards carry the labels the rows
 * declare aliases between. The rows are black-box over REST plus direct reads of the executor, so they do not depend on how the build stores
 * the alias rows.
 *
 * THE FLAGS ARE THE BUILDER'S TO NAME. Every unit flag this repo knows is switched on, plus `SCRUM_GRAPH_UNIT_LABELS` (a PROPOSED name: unknown
 * flags are ignored by the server). If the build gates the alias rows behind a flag with another name, change `UNIT_ENV` below, in this one place,
 * and say so on the card.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DSID, ROSTER_FILE, card, startProxy, migrate, withOwned, startExecutor, killExecutor, startRestServer, makeBoardFixture,
} from './ready-world-1644.mjs';

export const UNIT_ENV = Object.freeze({ SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_UNIT_LABELS: '1' });
export { card, makeBoardFixture };

/** Cards that carry the labels the rows use (a canonical must be a label some card carries, and so must an alias). */
export const labelBoard = (labels) => makeBoardFixture({
  cards: labels.map((l, i) => card(i + 1, `carries ${l}`, { labels: [l] })), nextShortId: labels.length + 1, conversations: [],
});

export const CONCEPT = 'https://scrumboard.local/concept/';
export const concept = (label) => `${CONCEPT}${encodeURIComponent(label)}`;

export async function labelWorld(board, body, { env = {} } = {}) {
  return withOwned(async (own) => {
    const store = own.dir('r40-store-');
    const exec = await startExecutor({ store, datasetId: DSID, create: true }); own.adopt(() => killExecutor(exec));
    const proxy = await startProxy(exec.baseUrl); own.adopt(async () => { try { await proxy.down(); } catch { /* down */ } });
    const dir = own.dir('r40-board-'); const boardFile = path.join(dir, 'board.json');
    fs.writeFileSync(boardFile, JSON.stringify(board));
    let rest = null; own.adopt(async () => { if (rest) await rest.stop(); });
    const w = {
      exec, proxy, boardFile,
      async start() {
        if (rest) await rest.stop();
        rest = await startRestServer({ boardFile, env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1', ...UNIT_ENV, ...env } });
        w.base = rest.baseUrl; return w;
      },
      async stop() { if (rest) { await rest.stop(); rest = null; } },
      async req(method, route, body) {
        const r = await fetch(`${w.base}${route}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
        const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, text, json };
      },
      declare: (alias, canonical) => w.req('POST', '/api/labels/aliases', { alias, canonical, by: 'ada' }),
      aliases: () => w.req('GET', '/api/labels/aliases'),
      createCard: (title, labels) => w.req('POST', '/api/cards', { title, labels, createdBy: 'ada' }),
      /** ASK the executor's public dataset directly (not through REST) whether alias sameAs canonical is there. */
      async executorHasSameAs(alias, canonical) {
        const q = `PREFIX schema: <https://schema.org/> ASK { <${concept(alias)}> schema:sameAs <${concept(canonical)}> }`;
        const r = await fetch(`${exec.baseUrl}/query?dataset=public`, { method: 'POST', body: q, signal: AbortSignal.timeout(30000) });
        const j = await r.json(); if (typeof j.boolean !== 'boolean') throw new Error(`the executor did not answer an ASK: ${JSON.stringify(j).slice(0, 200)}`); return j.boolean;
      },
      /** ASK the executor's public dataset an arbitrary ASK (for #857's own falsifier row, verbatim). */
      async executorAsk(q) {
        const r = await fetch(`${exec.baseUrl}/query?dataset=public`, { method: 'POST', body: q, signal: AbortSignal.timeout(30000) });
        const j = await r.json(); if (typeof j.boolean !== 'boolean') throw new Error(`the executor did not answer an ASK: ${JSON.stringify(j).slice(0, 200)}`); return j.boolean;
      },
      async executorSameAsCount() {
        const r = await fetch(`${exec.baseUrl}/query?dataset=public`, { method: 'POST', body: 'PREFIX schema: <https://schema.org/> SELECT (COUNT(*) AS ?n) WHERE { ?a schema:sameAs ?b }', signal: AbortSignal.timeout(30000) });
        return Number((await r.json()).results.bindings[0].n.value);
      },
      readFile: () => JSON.parse(fs.readFileSync(boardFile, 'utf8')),
      /** Remove the document's own alias rows, as if the file never carried them (the build must not need them). */
      dropFileAliases() { const j = w.readFile(); const had = Object.hasOwn(j, '_labelAliases'); delete j._labelAliases; fs.writeFileSync(boardFile, JSON.stringify(j)); return had; },
    };
    const m = await migrate(boardFile, exec.baseUrl);
    if (m.code !== 0) throw new Error(`precondition: the cards are copied into the executor (exit ${m.code}): ${m.out.slice(0, 300)}`);
    return await body(w);
  });
}
