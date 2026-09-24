/**
 * #1406 slice 1 — assemble ONE seat's memories to a byte BUDGET.
 *
 * A session-start hook asks this instead of loading a hand-maintained file of
 * copies: the store stays the only copy, and the ceiling becomes a parameter.
 *
 *   order     priority (p0 → p3, then unset), then newest first
 *   fill      greedy: an entry that does not fit is skipped, and a later,
 *             smaller one may still fit — the output keeps the order
 *   omitted   every skipped memory is NAMED (id + title) in the payload and,
 *             as far as the budget allows, in the text. #1438: a budget can
 *             silently truncate what mattered; naming the loss is what lets
 *             the seat walk back to it by id.
 *   empty     an owner with no memories gets an explicit sentence, never ''
 *
 * Pure: no I/O. The caller hands in the wire-shaped memories (memoryToWire).
 */

const RANK = { p0: 0, p1: 1, p2: 2, p3: 3 };
const rank = (m) => (m.priority in RANK ? RANK[m.priority] : 4);
const bytes = (s) => Buffer.byteLength(s, 'utf8');

function render(m) {
  const meta = [m.id, m.priority || 'unset', m.updatedAt ? m.updatedAt.slice(0, 10) : null].filter(Boolean).join(' · ');
  return `## ${m.title}  (${meta})\n${m.body}\n\n`;
}

/**
 * @param {Array<{id,title,owner,priority?,body,updatedAt}>} memories
 * @param {{owner: string, budgetBytes: number, tag?: string|null}} opts
 * @returns {{owner, budgetBytes, bytes, text, included: string[], omitted: Array<{id,title}>}}
 */
export function assembleMemories(memories, { owner, budgetBytes, tag = null } = {}) {
  if (typeof owner !== 'string' || !owner) throw new Error('owner is required — whose memories to assemble');
  if (!Number.isInteger(budgetBytes) || budgetBytes <= 0) {
    throw new Error(`budget must be a positive integer number of bytes (got ${JSON.stringify(budgetBytes)})`);
  }

  const mine = memories
    .filter((m) => m.owner === owner)
    // #1473 — an optional tag narrows the SET (a resident's `agent-memory`, her
    // "this belongs in my wake" marker). Filtered out is not omitted: those
    // memories were never candidates, so they are not named in the footer.
    .filter((m) => !tag || (Array.isArray(m.tags) && m.tags.includes(tag)))
    .sort((a, b) => rank(a) - rank(b) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  if (mine.length === 0) {
    const sentence = `No memories for ${owner}.\n`;
    const text = bytes(sentence) <= budgetBytes ? sentence : '';   // a budget too small for even this sentence
    return { owner, budgetBytes, bytes: bytes(text), text, included: [], omitted: [] };
  }

  // Everything fits: return it whole. The footer reserve below is held back
  // only when something overflows — held unconditionally, it cost a seat
  // whose memories fit its budget exactly one of them (found in review).
  const pieces = mine.map(render);
  const whole = pieces.join('');
  if (bytes(whole) <= budgetBytes) {
    return { owner, budgetBytes, bytes: bytes(whole), text: whole, included: mine.map((m) => m.id), omitted: [] };
  }

  // Something overflows. Reserve room for the omitted footer's head AND its
  // first line up front, so a full body can never crowd out the fact that
  // something was left behind.
  const footerHead = (n) => `---\n${n} memor${n === 1 ? 'y' : 'ies'} not included (budget ${budgetBytes} bytes). Fetch by id:\n`;
  const FIRST_LINE_ALLOWANCE = 120;
  const reserve = bytes(footerHead(mine.length)) + FIRST_LINE_ALLOWANCE;

  const included = [];
  const omitted = [];
  let body = '';
  for (const m of mine) {
    const piece = render(m);
    if (bytes(body) + bytes(piece) + reserve <= budgetBytes) {
      body += piece;
      included.push(m.id);
    } else {
      omitted.push({ id: m.id, title: m.title });
    }
  }

  let text = body;
  if (omitted.length) {
    let footer = footerHead(omitted.length);
    for (const o of omitted) {
      const line = `- ${o.id}  ${o.title}\n`;
      if (bytes(text) + bytes(footer) + bytes(line) > budgetBytes) break;
      footer += line;
    }
    if (bytes(text) + bytes(footer) <= budgetBytes) text += footer;
  }
  return { owner, budgetBytes, bytes: bytes(text), text, included, omitted };
}
