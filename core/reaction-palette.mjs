/**
 * #449 — the reaction palette of slice 1, in ONE browser-safe module: the server refuses an emoji outside it, the MCP
 * tools offer exactly it, and the page's picker shows exactly it. Slice 2 adds an instance's own named shortcodes from
 * LOCAL config, so a room's private set never ships as manyhands' default.
 */
export const REACTION_PALETTE = Object.freeze(['👍', '❤️', '😂', '🤷', '👏', '👀']);
/** The most posts one batch read may name (GET /api/reactions?posts=…). */
export const REACTION_BATCH_MAX = 200;
