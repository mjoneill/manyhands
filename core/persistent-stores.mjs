/**
 * core/persistent-stores.mjs — #1152: the graph-native invariant, as DATA.
 *
 * Decision `aaf1774b`, ratified by three seats on 2026-08-30 and prose ever
 * since: **new entity kinds are born in the graph; a new side-file needs
 * the owner's explicit sign-off.** All three said it should be wired as a check
 * rather than written down, "because a vision constraint that isn't a gate gets
 * eroded by good engineers being locally right."
 *
 * This file is the registry the check reads. Adding a persistent store without
 * adding it here makes the suite fail in the invariant's words.
 *
 * ── WHY THE CHECK MEASURES THE RUNTIME AND NOT A GREP ───────────────────────
 *
 * ⛔ The obvious implementation — scan the source for open sites, compare to a
 * list — is one I built far enough to disprove. THREE greps over the same tree
 * returned THREE DIFFERENT SETS (2026-09-03):
 *
 *   `SCRUM_*(FILE|DIR|STORE|PATH)` env names   → 13, and MISSED SCRUM_SEAT_TOKENS
 *   `^const [A-Z_]+ =` path constants          → found SEAT_TOKENS, missed SCRUM_EVENTS_DIR
 *   every `SCRUM_*` in core+server+mcp         → missed the whisper/channel/tending config files
 *
 * ⇒ A registry validated against a scan is only as complete as the scan, and a
 * check that claims completeness it does not have is worse than no check: it
 * tells the next reader the invariant is guarded. So the population comes from
 * the PROCESS — every path the running server actually opens, recorded by an
 * fs hook — and the scan is kept only as a cross-check that can add candidates,
 * never as the authority.
 *
 * ⚠️ WHAT THIS STILL CANNOT SEE, stated rather than papered over: a store the
 * runtime opens only on a code path no test exercises. The recording is as
 * complete as the requests the check makes, and no more. So this registry
 * deliberately lists stores the SCAN found but the recording has NOT yet
 * observed — seat-tokens, the channel and tending configs, search-index —
 * because a registry that held only what one test run happened to touch would
 * shrink to whatever the newest test exercised. ⇒ Entries here are ALLOWANCES,
 * not observations: presence means "if the runtime opens this, that is
 * expected", never "the runtime opened this".
 */

/**
 * RECORD      — the store IS the authority for its content. A new one is the
 *               thing the invariant gates: it needs the owner's sign-off.
 * PROJECTION  — derived from a RECORD and rebuildable by discarding it. Adding
 *               one is ordinary engineering; losing one costs time, not truth.
 * CONFIG      — operator-supplied input, not board content. Not a side-file in
 *               the invariant's sense: it holds no entities.
 * LOG         — append-only telemetry read by humans, never by the board.
 * SECRET      — credentials. ⛔ Never printed, never pasted, never diffed.
 */
export const STORE_KINDS = ['RECORD', 'PROJECTION', 'CONFIG', 'LOG', 'SECRET'];

/**
 * Every persistent store the runtime is ALLOWED to open.
 *
 * `match` is tested against the basename of an opened path, so a store keeps
 * its identity when an operator relocates it with an env var — the invariant is
 * about what KIND of thing exists, not where it lives.
 */
export const PERSISTENT_STORES = [
  { match: 'board-data.json', kind: 'RECORD', env: 'SCRUM_BOARD_FILE',
    why: 'THE board. schema.org JSON-LD @graph since #227; the authority for cards, columns, people, decisions written before #1147, memories, tending, obligations, wakes.' },
  { match: /^events-\d{4}-\d{2}-\d{2}\.jsonl$/, kind: 'RECORD', env: 'SCRUM_EVENT_LOG_DIR',
    why: 'The event log, day-segmented (#679). RECORD and not a projection since #1143/#1147: seat state and decisions are born here and the document carries no row, so discarding it loses facts.' },
  { match: /^work-objects\.jsonl$/, kind: 'RECORD', env: 'SCRUM_WORK_STORE',
    why: 'The work-declaration ledger (#442/#451). Its own store because the protocol predates the graph; dormant since 2026-08-18 and a migration candidate, not a new side-file.' },
  { match: /^(cursors)\.json$/, kind: 'RECORD', env: 'SCRUM_WORK_STORE',
    why: 'Per-consumer read positions for the work ledger. Small, RECORD because a lost cursor re-delivers work that was already taken.' },
  { match: /^attachments?$/, kind: 'RECORD', env: 'SCRUM_ATTACHMENTS_DIR',
    why: 'Uploaded bytes (#238). Blobs cannot live in JSON-LD; the graph holds the reference and this holds the content.' },
  { match: 'sha-integrity.json', kind: 'PROJECTION', env: 'SCRUM_SHA_INTEGRITY_FILE',
    why: 'The deploy-time sha stamp (#1008, ancestry added #1020). Rebuilt by every deploy from the board plus the git roots; the live server serves an export with no .git, which is why it is a file at all.' },
  { match: 'search-index.jsonl', kind: 'PROJECTION', env: null,
    why: 'Semantic search embeddings. Rebuildable from card text at the cost of an embedding pass.' },
  { match: 'tending-provenance.json', kind: 'PROJECTION', env: 'SCRUM_TENDING_PROVENANCE_FILE',
    why: 'What the tending loop has already said, so it does not repeat itself. Derived from tending state.' },
  { match: 'roster.json', kind: 'CONFIG', env: 'SCRUM_ROSTER_FILE',
    why: 'Who the seats are. Operator-supplied, gitignored on purpose (#1149); holds no board entities.' },
  { match: /^(tending-config|channel-config)\.json$/, kind: 'CONFIG', env: null,
    why: 'Operator configuration for the tending loop and the channels. Inputs, not content.' },
  { match: /^whisper-(state|pool)\.json$/, kind: 'CONFIG', env: null,
    why: 'The whisper mechanism state and key pool (#613). Operator-facing coordination config.' },
  { match: /^(graph-query-log|search-log)\.jsonl$/, kind: 'LOG', env: null,
    why: 'Append-only query telemetry — the only unbiased evidence of what seats actually ask (#1037). Read by humans; nothing reads it back.' },
  { match: /-misses\.jsonl$/, kind: 'LOG', env: null,
    why: 'The miss log: searches that found nothing. Evidence for what the board cannot answer.' },
  { match: /^seat-tokens\.json$/, kind: 'SECRET', env: 'SCRUM_SEAT_TOKENS',
    why: 'Seat authentication tokens. ⛔ Contents are never printed, diffed or pasted; this entry exists so the check does not flag it, and for no other purpose.' },
];

/** Does an opened path correspond to a registered store? */
export function storeFor(basename) {
  return PERSISTENT_STORES.find((s) => (typeof s.match === 'string'
    ? s.match === basename
    : s.match.test(basename))) || null;
}

/**
 * The refusal, in the invariant's own words — so a seat who trips it reads the
 * decision rather than a test name.
 */
export function unregisteredStoreMessage(basenames) {
  return 'GRAPH-NATIVE INVARIANT (Decision aaf1774b): new entity kinds are born in the graph; '
    + 'a new side-file needs the owner\'s explicit sign-off.\n'
    + `The runtime opened ${basenames.length} persistent store(s) that the registry does not allow: `
    + `${basenames.join(', ')}.\n`
    + 'If this is a PROJECTION, a CONFIG, a LOG or a SECRET, add it to PERSISTENT_STORES in '
    + 'core/persistent-stores.mjs with the reason it is allowed. If it is a RECORD — if it is the '
    + 'authority for some kind of entity — it is the thing the invariant gates, and it needs the '
    + 'owner\'s sign-off recorded on a card BEFORE it ships, not this line edited.';
}
