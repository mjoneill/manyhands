/**
 * #1196 slice B — THE READ-ONLY SURFACE A COLLEAGUE MAY REACH.
 *
 * The board is graph-native and until tonight the colleague sitting on it had
 * no way to read the graph: its whole input was a prompt, its own memory, and
 * the message that woke it. This is the smallest surface that makes it a
 * participant rather than a correspondent.
 *
 * FIVE TOOLS, ALL READS. Read a card, search the board, query the graph, ask
 * what kinds of thing the board records, and ask what the predicates mean and
 * what shape their objects take.
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
      // ⛔ WHEN NOT TO USE IT is the load-bearing half, found live: asked which
      // card held a topic, the model called card_get with a number it had
      // INVENTED, read that the card was about something else entirely, and
      // reported it as the answer anyway. It never searched. A description that
      // only says what a tool does sends a model that lacks the argument to make
      // one up, because this is the tool shaped like the question.
      description: 'Read one card by its short id and return what it says. ONLY use this when a card number is ALREADY in front of you — someone wrote it, or a search returned it. If you do not have a number, you must use board_search first: never invent a card number to pass here, and never treat a card you fetched by guess as the answer to "which card is this on".',
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
      description: 'Search every card by meaning rather than exact words. THIS IS THE TOOL FOR "which card is about X" and for any question where you do not already have a card number. Returns ranked cards with their numbers and a coverage figure. Use it before answering from memory and before saying the board does not cover something.',
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
  {
    type: 'function',
    function: {
      // ⛔ THE FACT THAT ACTUALLY COSTS HOPS. A colleague asked which cards sit
      // in a column, used the RIGHT predicate, and passed a literal where the
      // graph holds an IRI. Clean zero, indistinguishable from "no such cards".
      // The definitions alone would not have saved it — measured: the registry
      // carries meaning and no shape. So this tool answers BOTH, and the shape
      // is sampled from the live store rather than written down by hand.
      name: 'predicate_list',
      description: 'List the predicates you may use in a graph_query — what each one MEANS, and what SHAPE its object takes (an IRI with a prefix like column:, or a quoted literal). USE THIS BEFORE WRITING A FILTER, and use it when a query you believe is correct returns zero rows: the most common cause is filtering an IRI predicate against a quoted string, which returns nothing and looks exactly like "nothing matched". Pass a name for one predicate.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'optional — one predicate, e.g. "scrum:column"' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      // ⭐ THE ORIENTATION TOOL. The other three answer questions about the
      // board's CONTENTS and assume you already know its SHAPE. This one
      // answers "what kind of thing lives here at all" — every registered kind,
      // what it means, and the verb that creates one. It is what a colleague
      // needs on arrival and when a query keeps coming back empty, and it was
      // measured missing: a seat spent 3 min 21 s guessing SPARQL predicates
      // while this list sat one call away.
      name: 'kind_list',
      description: 'List every kind of thing this board records — cards, decisions, memories, obligations and the rest — each with what it means and the verb that creates one. USE THIS FIRST when you are new here, when you do not know what the board holds, or when a graph_query keeps returning nothing and you suspect you are guessing at names. Pass a name to get that one kind\'s full definition instead of the summary of all of them.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'optional — one kind, e.g. "scrum:Card", for its full definition' } },
      },
    },
  },
]);

/** The opening sentence of a definition — orientation, not the whole register. */
function firstSentence(text) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  const m = s.match(/[.!?](\s|$)/);
  return m ? s.slice(0, m.index + 1) : s.slice(0, 200);
}

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
        // ⛔ THE ANSWER IS IN `rows`. This read `bindings` — a name the route has
        // never used — so the check found an empty array on EVERY call and
        // attached "matched nothing" to results that had matched plenty. The
        // model was handed rows and a note contradicting them. Same family as
        // the three defects of 2026-09-06: a field read by a name nothing
        // writes, accepted in silence. Read the name the route answers with.
        const rows = Array.isArray(out?.rows) ? out.rows : [];
        return rows.length ? out : { ...out, rows, note: 'the query ran and matched nothing. That is an answer, not a failure. If you are guessing at names, call kind_list to see what this board actually records.' };
      }
      case 'predicate_list': {
        const wanted = String(args?.name ?? '').trim();
        const path = wanted
          ? `/api/predicates?shapes=true&name=${encodeURIComponent(wanted)}`
          : '/api/predicates?shapes=true';
        const all = await get(path);
        const list = Array.isArray(all) ? all : (Array.isArray(all?.predicates) ? all.predicates : []);
        if (wanted && !list.length) {
          return { name: wanted, found: false, note: `no predicate named ${JSON.stringify(wanted)} is registered. A graph_query naming it will be refused rather than answered, so this is worth knowing before you write one.` };
        }
        return { predicates: list, note: 'objectShape is SAMPLED from the live graph, not declared. shape "iri" means filter against the prefixed form; "literal" means a quoted string; "none" means registered but never used, which is not the same as a literal.' };
      }
      case 'kind_list': {
        const all = await get('/api/kinds?declared=true');
        const kinds = Array.isArray(all) ? all : (Array.isArray(all?.kinds) ? all.kinds : []);
        const wanted = String(args?.name ?? '').trim();
        if (wanted) {
          const one = kinds.find((k) => k?.name === wanted);
          if (!one) {
            return { name: wanted, found: false, note: `no kind named ${JSON.stringify(wanted)} is registered. That is an answer: this board does not record such a thing. The registered names are: ${kinds.map((k) => k.name).join(', ')}` };
          }
          return one;
        }
        // ⚠️ SUMMARISED ON PURPOSE. The full register is ~18 KB of prose and a
        // small model spends its whole budget reading it. One sentence each
        // plus the creating verb is what orientation needs; `name` fetches the
        // rest for the one kind that turned out to matter.
        return {
          kinds: kinds.map((k) => ({ name: k?.name, createdBy: k?.createdBy ?? null, definition: firstSentence(k?.definition) })),
          note: 'One sentence each. Call kind_list again with a name for that kind\'s full definition.',
        };
      }
      default:
        throw new Error(`no such tool ${JSON.stringify(name)} — this seat can reach: ${[...BY_NAME.keys()].join(', ')}`);
    }
  };
}
