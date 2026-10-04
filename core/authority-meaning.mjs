// #1558/#1559 — shared by the resolver and the route's own UNAVAILABLE envelope (which must work
// even when the resolver module is not installed), so it lives in neither.
/**
 * What each status MEANS for whoever acts on it, in plain words, on every envelope.
 * G1 (2026-10-04) observed the reader acting on its own remembered beliefs when the
 * answer was NO_AUTHORITY (reason was an empty string) or UNAVAILABLE (reason named a
 * transport error, not what to do). The status alone did not carry its consequence.
 * The no-offer sentence (a resident, after the N1 demo 2026-10-04): the meaning text stopped the
 * order, but the reader still OFFERED the remembered value as a branch to act on.
 */
export const STATUS_MEANING = Object.freeze({
  CURRENT: 'One assertion governs this topic now (see currentAuthorities and the reason for why). Act on it. A remembered or newer belief that differs does not override it unless it appears here as governing.',
  UNRESOLVED: 'Binding assertions conflict, or the record is incomplete or malformed (see reason). NOTHING governs until that is settled. Do not pick one, and do not act on a remembered belief; say the conflict exists and who must settle it.',
  NO_AUTHORITY: 'Nothing governs this topic in this scope: no binding assertion exists. A belief you remember is NOT authority. Do not act on it as if decided; say that no decision exists and, if one is needed, ask who should make it. Do not offer a remembered value as an option to act on (not even "shall I go ahead on my recollection?"); you may mention it only labelled as your memory, not as a choice.',
  UNAVAILABLE: 'The authority could not be read, so you do NOT know what governs this. This is not "nothing governs it", and a remembered belief does not fill the gap. Do not act on anything that depends on it; say it is unavailable and stop or retry later. Do not offer a remembered value as an option to act on; you may mention it only labelled as your memory, not as a choice.',
});
