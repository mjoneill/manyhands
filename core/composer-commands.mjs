/**
 * #2026 — slash commands typed in the composer, expanded on send. Browser-safe, pure.
 *
 * `/shrug` works as in Slack: a post that BEGINS with the command is sent with the shrug in its place — alone it is just
 * the shrug; followed by words, the words come first and the shrug ends the line. A `/shrug` anywhere else (mid-sentence,
 * in code, `/shrugs`) is left exactly as typed. The page renders the shrug whole: markdown keeps its backslash.
 */
export const SHRUG = '¯\\_(ツ)_/¯';

export function expandComposerCommands(text) {
  const s = String(text ?? '');
  const m = /^\/shrug(?:\s+([\s\S]*))?$/i.exec(s);
  if (!m) return s;
  const rest = (m[1] || '').trim();
  return rest ? `${rest} ${SHRUG}` : SHRUG;
}
