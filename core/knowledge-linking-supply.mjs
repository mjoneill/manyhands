/**
 * #1852 (supply) — the extractor LINKS each run it publishes, so a new run's claims reach our cards without anyone running
 * scripts/link-run.mjs by hand. One helper, shared by the tick (knowledge-extraction-intake.mjs) and the named-file path
 * (knowledge-extraction-file.mjs): after a run publishes, propose its "bears on" links (#1851's linkRun, the board's own
 * meaning search, no paid model call) and hand the result to the finish post.
 *
 * Three rules, each from a way this could go quietly wrong:
 *   - The threshold comes from the tracked file (knowledge-linking-config.mjs) and nowhere else. A file that is missing or
 *     refused means the run is NOT linked, and says so. No number in this file stands in for it.
 *   - Linking can never turn a published run into a failed one. The claims are already on the graph; a search that is down is
 *     a line in the finish post and in the tick's JSON, not a failed job. linkPublished never throws.
 *   - "No link" must never be able to mean "never searched" (#1851). Every way of not searching is `made:false` with its
 *     reason, including a run whose claims the graph did not return.
 *
 * A retried tick or a re-extraction doubles nothing: linkRun reads every existing link's span key before it proposes.
 * That is also what makes a refused run safe to try again: the tick does (knowledge-extraction-intake.mjs, pendingLinks).
 */
import { linkRun, createRestSearch } from './knowledge-linking.mjs';
import { readLinkingConfig, LINKING_CONFIG_FILE } from './knowledge-linking-config.mjs';

const PERSON = 'https://scrumboard.local/person/';

/**
 * The linking step for one extractor process. `actor` is the key the run was published under, so the links are proposed by
 * the same actor. `search` and `model` are injected by the rows; live, the search is the board's POST /api/search with the
 * config's k, and the model is read from its answer. The config file is read on every call, so an edit applies to the next run.
 */
export function createRunLinker({ graphClient, boardUrl, token = null, actor = 'extractor', configFile = LINKING_CONFIG_FILE, search = null, model = null, now = () => new Date().toISOString() } = {}) {
  if (!graphClient) throw new Error('createRunLinker needs the graphClient the run was published with');
  if (typeof search !== 'function' && !boardUrl) throw new Error('createRunLinker needs the boardUrl to search');
  return async function link(result) {
    const config = readLinkingConfig(configFile);
    // A refused config does not fix itself, so it is the one refusal a tick does not retry.
    if (!config.ok) return { made: false, reason: config.error, retryable: false };
    const refused = (reason) => ({ made: false, reason, retryable: true, minScore: config.minScore });
    const find = typeof search === 'function' ? search : createRestSearch({ base: boardUrl, token, by: actor, k: config.k });
    const r = await linkRun({ graphClient, search: find, run: result.runId, minScore: config.minScore, perAssertion: config.perAssertion,
      model: model ?? (() => (typeof find.model === 'function' ? find.model() : null)), actor: `${PERSON}${actor}`, at: now() });
    if (!r.ok) return refused(r.reason);
    // The run published claims and the graph returned none of them: nothing was searched, so this is not "no card matched".
    if (!r.assertions) return refused('the graph returned no claims for this run, so nothing was searched');
    return { made: true, minScore: config.minScore, perAssertion: config.perAssertion, k: config.k, assertions: r.assertions, proposed: r.proposed, skipped: r.skipped,
      // `gist` is the text the claim was searched by: its gist, or its verbatim span when the model gave none
      links: (r.links ?? []).map((l) => ({ card: l.card, shortId: l.shortId ?? null, title: l.title ?? null, score: l.score, gist: l.query, assertion: l.assertion })) };
  };
}

/**
 * Link one finished run, if there is a linker and the run published something. null means "not linked, and nothing to say":
 * the finish post is then the one #1862 wrote. Never throws: a linker that does is `made:false` with its message.
 */
export async function linkPublished(link, result) {
  if (typeof link !== 'function') return null;
  if (typeof result?.runId !== 'string' || !result.runId || !Array.isArray(result.published) || result.published.length === 0) return null;
  return linkAgain(link, result.runId);
}

/**
 * One linking attempt at a run by its IRI: the first one, or a tick's retry of a refused one. Never throws. `retryable`
 * says whether trying again could help: a search or a graph that did not answer, yes; a refused config, no.
 */
export async function linkAgain(link, runId) {
  try {
    const r = await link({ runId });
    return r && typeof r === 'object' ? r : { made: false, reason: 'the linking step returned nothing', retryable: true };
  } catch (e) { return { made: false, reason: `the linking step failed: ${e?.message ?? e}`, retryable: true }; }
}

/** The short form for a summary line: the counts or the reason, never the list of links. `willRetry`: a tick has it queued. */
export function linkSummary(links) {
  if (links?.made !== true) return { made: false, reason: links?.reason ?? 'no reason given', willRetry: !!links?.retry };
  return { made: true, proposed: links.proposed, skipped: links.skipped, cards: new Set((links.links ?? []).map((l) => l.card)).size, assertions: links.assertions, minScore: links.minScore };
}
