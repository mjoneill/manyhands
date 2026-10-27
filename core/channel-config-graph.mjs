/**
 * #1784 — the channel delivery config (#263) as ONE graph node, `https://scrumboard.local/config/channel`, in the
 * `channelConfig` collection family (core/collection-families.mjs). Two paths, as every K13 family that once had a file
 * or document shape (label aliases, move fences):
 *   · the collections unit OFF: channel-config.json, read and written by channel-config.mjs, exactly as before;
 *   · the unit ON: this node is the config. The file is imported ONCE at boot (stamped with where it came from and when)
 *     and is never read or written again.
 * REST is the only reader of either; the MCP scheduler reads REST's GET /api/config (mcp-server.mjs).
 *
 * Pure: config ⇄ entity, validated by channel-config.mjs's own validateConfig, so the graph can hold only what the
 * Settings page could have saved.
 */
import { validateConfig, DEFAULT_CONFIG } from '../channel-config.mjs';

export const CHANNEL_CONFIG_IRI = 'https://scrumboard.local/config/channel';
export const CHANNEL_CONFIG_TYPE = 'scrum:ChannelConfig';

/** A validated config → the family's one entity. `imported` = { from, at } on the one-time file import only. */
export function channelConfigEntity(config, { imported = null, prior = null } = {}) {
  const c = validateConfig(config);
  const e = {
    '@id': CHANNEL_CONFIG_IRI, '@type': CHANNEL_CONFIG_TYPE,
    'scrum:channelMode': c.mode,
    'scrum:softMinMs': c.soft.minMs, 'scrum:softMaxMs': c.soft.maxMs,
    'scrum:hardTimeoutMs': c.hard.timeoutMs, 'scrum:tokenRingTimeoutMs': c.tokenRing.timeoutMs,
  };
  if (c.tokenRing.bearerSeats?.length) e['scrum:bearerSeat'] = [...c.tokenRing.bearerSeats];
  if (c.residents?.replyWakesPerPairPerHour !== undefined) e['scrum:residentReplyWakesPerPairPerHour'] = c.residents.replyWakesPerPairPerHour;
  // the import stamp is a fact about the RECORD: written once, carried through every later save
  const stamp = imported ?? (prior?.['scrum:configImportedAt'] ? { from: prior['scrum:configImportedFrom'], at: prior['scrum:configImportedAt'] } : null);
  if (stamp) { e['scrum:configImportedFrom'] = String(stamp.from); e['scrum:configImportedAt'] = String(stamp.at); }
  return e;
}

/** The family's entity → the config REST answers, in validateConfig's shape. No entity ⇒ the default (a missing file's answer). */
export function channelConfigFrom(entities) {
  const e = (Array.isArray(entities) ? entities : []).find((x) => x && x['@id'] === CHANNEL_CONFIG_IRI);
  if (!e) return validateConfig(DEFAULT_CONFIG);
  const seats = e['scrum:bearerSeat'] == null ? [] : [].concat(e['scrum:bearerSeat']);
  return validateConfig({
    mode: e['scrum:channelMode'],
    soft: { minMs: e['scrum:softMinMs'], maxMs: e['scrum:softMaxMs'] },
    hard: { timeoutMs: e['scrum:hardTimeoutMs'] },
    tokenRing: { timeoutMs: e['scrum:tokenRingTimeoutMs'], ...(seats.length ? { bearerSeats: seats } : {}) },
    ...(e['scrum:residentReplyWakesPerPairPerHour'] != null ? { residents: { replyWakesPerPairPerHour: e['scrum:residentReplyWakesPerPairPerHour'] } } : {}),
  });
}

/** Has the one-time file import happened? (A node saved from Settings without an import also counts: the graph already owns it.) */
export const channelConfigInGraph = (entities) => (Array.isArray(entities) ? entities : []).some((x) => x && x['@id'] === CHANNEL_CONFIG_IRI);
