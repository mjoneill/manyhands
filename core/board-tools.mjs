/**
 * #1196 slice B — THE READ-ONLY SURFACE A COLLEAGUE MAY REACH.
 *
 * The board is graph-native and until tonight the colleague sitting on it had
 * no way to read the graph: its whole input was a prompt, its own memory, and
 * the message that woke it. This is the smallest surface that makes it a
 * participant rather than a correspondent.
 *
 * THREE TOOLS, ALL READS. Read a card, search the board, query the graph.
 * Nothing here writes. A colleague that can look things up is what the epic
 * promised; a colleague that can change things is a different card and deserves
 * its own argument rather than arriving as a convenience alongside this one.
 *
 * ⭐ A GRANT IS NOW REAL. `toolGrants` used to change one sentence of an agent's
 * prompt and nothing else, so an agent granted everything and an agent granted
 * nothing differed by a line of English. Here the grant decides what is put in
 * front of the model at all: ungranted means absent from the request, and the
 * loop refuses it by name if the model asks anyway.
 *
 * ⚠️ ZERO ROWS CARRY A NOTE. Handed an empty result and no explanation, a small
 * model fills the silence — that is the defect measured all night, in three
 * shapes. Saying "nothing matched" is not politeness, it is the difference
 * between an absence the model can report and an absence it will narrate over.
 */

export const BOARD_TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'card_get',
      description: 'Read one card by its short id (the number people say out loud, like 1196). Returns its title, description and state. Use this when a message names a card number and you need what it actually says.',
      parameters: {
        type: 'object',
        properties: { shortId: { type: 'number', description: 'the card number, e.g. 1196' } },
        required: ['shortId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'board_search',
      description: 'Search every card by meaning rather than exact words, for when you know the topic but not the number. Returns ranked cards with a coverage figure. Use this before saying you do not know something.',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'what you are looking for, in your own words' },
          k: { type: 'number', description: 'how many results to return, default 8' },
        },
        required: ['q'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'graph_query',
      description: 'Ask the board a precise question in SPARQL when you need facts and their relationships rather than documents: who holds what, what changed when, which cards belong to a body of work.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'a SPARQL SELECT' } },
        required: ['query'],
      },
    },
  },
]);

const BY_NAME = new Map(BOARD_TOOLS.map((t) => [t.function.name, t]));

/**
 * What this agent may reach. ⛔ NO GRANTS MEANS NO TOOLS. A permissive default
 * would be the kind of quiet widening nobody reviews, and an agent that should
 * have been given one read would arrive holding three.
 */
export function toolsFor(agent = {}) {
  const grants = Array.isArray(agent.toolGrants) ? agent.toolGrants : [];
  return grants.map((g) => BY_NAME.get(g)).filter(Boolean);
}

/**
 * Bind the surface to a board. `get` and `post` are injected so the whole
 * contract is testable without a server, and so this module never decides how
 * the board is reached.
 */
export function makeExecutor({ get, post, by = 'board' }) {
  return async function execute(name, args = {}) {
    switch (name) {
      case 'card_get': {
        const id = args?.shortId;
        if (id === undefined || id === null || id === '') {
          throw new Error('card_get needs a shortId — the card number, e.g. {"shortId": 1196}');
        }
        return get(`/api/cards/${encodeURIComponent(id)}`);
      }
      case 'board_search': {
        const q = String(args?.q ?? '').trim();
        if (!q) throw new Error('board_search needs a q — what you are looking for, in words');
        const k = Number.isFinite(Number(args?.k)) ? Number(args.k) : 8;
        // ⚠️ POST, not GET, and `by` is not optional decoration: without it the
        // search log records actor null forever, and "who asked this" is the
        // question the log exists to answer.
        const out = await post('/api/search', { q, k, by });
        const results = Array.isArray(out?.results) ? out.results : [];
        return results.length ? out : { ...out, results, note: `no cards matched ${JSON.stringify(q)}. That is an answer: the board does not appear to hold this.` };
      }
      case 'graph_query': {
        const query = String(args?.query ?? '').trim();
        if (!query) throw new Error('graph_query needs a query — a SPARQL SELECT');
        const out = await post('/api/graph', { query, by });
        const bindings = Array.isArray(out?.bindings) ? out.bindings : [];
        return bindings.length ? out : { ...out, bindings, note: 'the query ran and matched nothing. That is an answer, not a failure.' };
      }
      default:
        throw new Error(`no such tool ${JSON.stringify(name)} — this seat can reach: ${[...BY_NAME.keys()].join(', ')}`);
    }
  };
}
