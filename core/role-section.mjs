/**
 * core/role-section.mjs — #1376: the ROLE SECTION of a seat's system prompt.
 *
 * A role that lives only in scrollback is re-interpreted every wake. So while
 * a seat's OPEN declaration holds a scrum:Role (#915), its prompt carries a
 * few lines: the role's name, the role's OWN short definition (the words the
 * room wrote, not a paraphrase), and the pointer to the card holding the full
 * text. Assembled at wake time from the live rows — never written into the
 * prompt version, because the prompt is identity (#1199) and a role is state.
 *
 * Absent means absent: a seat holding no live role gets '' — not an empty
 * heading — so "is this seat told it holds a role" is a string test.
 *
 * Browser-safe: pure, no node imports. Inputs are the wire shapes of
 * GET /api/seats/state (`seats[]`, each with `role` when held) and
 * GET /api/roles (`roles[]`).
 */

export const ROLE_SECTION_HEADING = 'ROLE ON THIS TEAM';

/** The live row for `seat` that holds a role, or null. UNKNOWN/expired rows hold nothing. */
export function heldRoleKey(seat, seats = []) {
  const row = (seats || []).find((s) => s && s.seat === seat);
  if (!row || !row.role || !row.mode || row.mode === 'unknown' || row.expired) return null;
  return String(row.role);
}

/** The section text for `seat`, or '' when it holds no live role. */
export function roleSectionFor({ seat, seats = [], roles = [] } = {}) {
  const key = heldRoleKey(seat, seats);
  if (!key) return '';
  const role = (roles || []).find((r) => r && r.key === key) || null;
  const name = role?.name || key;
  const lines = [
    `${ROLE_SECTION_HEADING} — you are currently serving as ${name} (role key: ${key}).`,
    'This helps the team live the values of scrum. The holding is a seat declaration on this board: it is yours for the declared interval and ends when released.',
  ];
  if (role?.definition) lines.push(role.definition.trim());
  const card = role?.definedBy && (role.definedBy.shortId != null) ? `#${role.definedBy.shortId}` : null;
  lines.push(card
    ? `Full definition: card ${card}${role.definedBy.title ? ` — ${role.definedBy.title}` : ''} (role_list shows every role this team defines).`
    : 'Full definition: role_list shows every role this team defines.');
  return lines.join('\n');
}
