/**
 * #1815: ceremonies open themselves.
 *
 * A calendar-keyed bell. At a ceremony's slot the board posts exactly one
 * ordinary opener that names the seat holding the role that opens it, so a
 * post-driven seat is woken by the post, like any other.
 *
 * The tick is pure, with everything injected (clock, schedule, seat state,
 * store, post, record), like tendingTick. Deliberately NOT like tendingTick:
 * it is not gated on room silence. A busy room still has its ceremony.
 *
 * Bell key = `${kind}@${slotISO}`. A bell is due while slot <= now < slot + tolerance.
 * The key is reserved atomically (store.reserve) BEFORE the post: the check and the take
 * are one call (an O_EXCL marker for a file, 201/409 under REST's write lock), so neither a
 * race nor a crash between the two can post twice. The cost is that a post that throws is
 * not retried, and the after-window check flags it as missing.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BELL_TOLERANCE_MS = 5 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// ── schedule ───────────────────────────────────────────────────────────────

/**
 * Validate a parsed schedule file `{ enabled?, ceremonies: [...] }`.
 * Fails closed: one bad entry refuses the whole schedule, because a wrong
 * ceremony is worse than a missing one (and a missing one is flagged).
 */
export function validateSchedule(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.ceremonies)) {
    return { ok: false, error: 'schedule must be an object with a "ceremonies" array', entries: [] };
  }
  const problems = [];
  doc.ceremonies.forEach((c, i) => {
    const label = `ceremonies[${i}]${c && typeof c.kind === 'string' ? ` (${c.kind})` : ''}`;
    const p = [];
    if (!c || typeof c !== 'object') { problems.push(`${label}: not an object`); return; }
    if (typeof c.kind !== 'string' || !c.kind.trim()) p.push('missing kind');
    if (!Number.isInteger(c.weekday) || c.weekday < 0 || c.weekday > 6) p.push(`weekday ${JSON.stringify(c.weekday)} is not an integer 0–6 (0 = Sunday, UTC)`);
    if (typeof c.time !== 'string' || !TIME_RE.test(c.time)) p.push(`time ${JSON.stringify(c.time)} is not HH:MM UTC`);
    if (c.preRead !== undefined && typeof c.preRead !== 'string') p.push('preRead must be a card number as a string');
    if (p.length) problems.push(`${label}: ${p.join('; ')}`);
  });
  if (problems.length) return { ok: false, error: problems.join(' | '), entries: [] };
  return { ok: true, enabled: doc.enabled !== false, entries: doc.ceremonies.map((c) => ({ ...c })) };
}

/**
 * A schedule read from a JSON file on every tick, so an edit applies with no
 * restart. `changed` is true on the first read and whenever the file's bytes
 * change (by sha256, not mtime: two writes inside one mtime tick still count).
 */
export function scheduleSource(file) {
  let lastSha = null;
  return {
    path: file,
    read() {
      let raw;
      let mtime = null;
      try {
        raw = fs.readFileSync(file);
        mtime = fs.statSync(file).mtime.toISOString();
      } catch (err) {
        const sha = `missing:${err.code || err.message}`;
        const changed = sha !== lastSha;
        lastSha = sha;
        return { ok: false, changed, path: file, mtime, error: `cannot read ${file}: ${err.code || err.message}`, entries: [] };
      }
      const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
      const changed = sha256 !== lastSha;
      lastSha = sha256;
      let doc;
      try {
        doc = JSON.parse(raw.toString('utf8'));
      } catch (err) {
        return { ok: false, changed, path: file, mtime, sha256, error: `not JSON: ${err.message}`, entries: [] };
      }
      return { ...validateSchedule(doc), changed, path: file, mtime, sha256 };
    },
  };
}

function describeSlot(c) {
  return `${c.kind} ${DAY_NAMES[c.weekday]} ${c.time}Z`;
}

/** The most recent slot instant at or before `nowMs` for one ceremony entry. */
function latestSlot(entry, nowMs) {
  const [hh, mm] = entry.time.split(':').map(Number);
  const now = new Date(nowMs);
  const back = (now.getUTCDay() - entry.weekday + 7) % 7;
  let slot = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm) - back * DAY_MS;
  if (slot > nowMs) slot -= 7 * DAY_MS;
  return slot;
}

// ── store ──────────────────────────────────────────────────────────────────

/**
 * Bell state persisted to one JSON file, re-read on every get so a restart
 * (a fresh store over the same file) sees what the last process committed.
 * Writes are tmp + rename, so a crash leaves the old file or the new one.
 */
export function fileBellStore(file) {
  const load = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  };
  return {
    get(key) { return load()[key]; },
    /**
     * Take the bell, atomically: true for exactly one caller per key, across
     * processes too, because the marker is created with O_EXCL ('wx'). A REST
     * store implements the same call as a 201/409 reservation.
     */
    reserve(key, value) {
      const marks = `${file}.reserved`;
      fs.mkdirSync(marks, { recursive: true });
      const mark = path.join(marks, crypto.createHash('sha256').update(key).digest('hex'));
      try { fs.writeFileSync(mark, key, { flag: 'wx' }); } catch (err) {
        if (err.code === 'EEXIST') return false;
        throw err;
      }
      this.put(key, value);
      return true;
    },
    put(key, value) {
      const all = load();
      all[key] = value;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
      fs.renameSync(tmp, file);
    },
  };
}

// ── opener ─────────────────────────────────────────────────────────────────

function held(s, role, nowMs) {
  if (!s || s.role !== role || s.expired) return false;
  if (s.expiresAt && Date.parse(s.expiresAt) <= nowMs) return false;
  return true;
}

/** Resolve the opener at bell time: the SM, else the PO, else nobody. */
function resolveOpener(state, nowMs) {
  const list = (state && state.seats) || [];
  const sm = list.find((s) => held(s, 'scrum-master', nowMs));
  if (sm) return { opener: sm.seat, openerSource: 'role' };
  const po = list.find((s) => held(s, 'po', nowMs));
  if (po) return { opener: po.seat, openerSource: 'po-fallback' };
  return { opener: null, openerSource: 'no-holder' };
}

function hhmm(ms) {
  return new Date(ms).toISOString().slice(11, 16);
}

function openerBody(entry, slotMs, { opener, openerSource }) {
  const pre = entry.preRead ? `; pre-read: #${entry.preRead}` : '';
  const head = `🔔 ${hhmm(slotMs)}Z: ${entry.kind}.`;
  if (openerSource === 'role') return `${head} @${opener} opens${pre}.`;
  if (openerSource === 'po-fallback') return `${head} The scrum master role is unheld, so the PO opens: @${opener}${pre}.`;
  if (openerSource === 'seat-state-unreadable') return `${head} The role holders could not be read, so nobody is named to open. Whoever is here, please start${pre}.`;
  return `${head} No scrum master or PO is declared, so nobody is named to open. Whoever is here, please start${pre}.`;
}

// ── tick ───────────────────────────────────────────────────────────────────

/**
 * One bell tick. Returns a summary; every decision about a due or just-closed
 * bell is also written through `record`, so "why didn't it ring" is a query.
 *
 * Accepted and ignored: `recentPosts`, `quietAfterMinutes` (the tending gate's
 * inputs). The bell does not read them, by design.
 */
export async function ceremonyBellTick({ now, schedule, seatState, store, post, record = () => {} }) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const tickAt = new Date(nowMs).toISOString();
  const summary = { posted: 0, flagged: 0 };

  let entries;
  if (Array.isArray(schedule)) {
    entries = schedule;
  } else {
    const res = schedule.read();
    if (res.changed) {
      if (res.ok) {
        record({ type: 'schedule-loaded', tickAt, path: res.path, mtime: res.mtime, sha256: res.sha256, enabled: res.enabled, slots: res.entries.map(describeSlot) });
      } else {
        record({ type: 'schedule-refused', tickAt, path: res.path, mtime: res.mtime, sha256: res.sha256 || null, error: res.error });
      }
    }
    if (!res.ok || !res.enabled) return { ...summary, refused: !res.ok, disabled: res.ok && !res.enabled };
    entries = res.entries;
  }

  for (const entry of entries) {
    const slotMs = latestSlot(entry, nowMs);
    const slot = new Date(slotMs).toISOString();
    const key = `${entry.kind}@${slot}`;
    const base = { type: 'bell', key, kind: entry.kind, slot, tickAt };
    const inWindow = nowMs < slotMs + BELL_TOLERANCE_MS;
    const prior = await store.get(key);

    if (inWindow) {
      // `prior` is only a fast path. The decision is store.reserve, where the
      // check and the take are one atomic call, so two ticks racing (in one
      // process or two) cannot both pass, however long anything before it
      // awaited. A crash after it can never post twice; the after-window
      // check flags it missing.
      if (prior || !(await store.reserve(key, { state: 'attempted', at: tickAt }))) {
        const p = prior || (await store.get(key)) || {};
        record({ ...base, outcome: 'suppressed-duplicate', opener: p.opener ?? null, openerSource: p.openerSource ?? null });
        continue;
      }
      // The bell is already taken, so a seat-state read that throws must not cost the ceremony; and "I could not ask"
      // is not "nobody holds the role", so it gets its own source and its own words. The error rides the event only.
      let who, seatStateError;
      try {
        who = resolveOpener(await seatState(), nowMs);
      } catch (err) {
        who = { opener: null, openerSource: 'seat-state-unreadable' };
        seatStateError = String(err && err.message || err);
      }
      const outcome = who.opener === null ? 'fired-no-holder' : 'fired';
      const extra = seatStateError ? { seatStateError } : {};
      await store.put(key, { state: 'attempted', at: tickAt, ...who });
      let res;
      try {
        res = await post({ kind: 'opener', key, body: openerBody(entry, slotMs, who) });
      } catch (err) {
        record({ ...base, outcome: 'post-failed', ...who, ...extra, error: String(err && err.message || err) });
        continue;
      }
      summary.posted++;
      // The opener has landed. A failure to save that fact is its own outcome, never a failed post; the after-window
      // check will then find no posted state, and its flag says only what the store knows.
      const postId = res && res.id;
      try {
        await store.put(key, { state: 'posted', at: tickAt, ...who, postId, createdAt: res && res.createdAt });
      } catch (err) {
        record({ ...base, outcome: 'fired-state-not-saved', ...who, ...extra, postId, error: String(err && err.message || err) });
        continue;
      }
      record({ ...base, outcome, ...who, ...extra });
      continue;
    }

    // After the window: check once whether the opener landed, and on time.
    if (!prior) {
      await store.put(key, { state: 'missed', at: tickAt, checked: true });
      record({ ...base, outcome: 'missed-past-window', opener: null, openerSource: null });
      continue;
    }
    if (prior.checked) continue;

    const who = { opener: prior.opener ?? null, openerSource: prior.openerSource ?? null };
    const createdMs = prior.state === 'posted' && prior.createdAt ? Date.parse(prior.createdAt) : NaN;
    let flag = null;
    let outcome;
    if (Number.isNaN(createdMs)) {
      outcome = 'flag-missing';
      flag = `⚠️ The ${entry.kind} opener for ${hhmm(slotMs)}Z is missing: no posted opener was recorded by ${hhmm(slotMs + BELL_TOLERANCE_MS)}Z.`;
    } else {
      const lagS = Math.round((createdMs - slotMs) / 1000);
      if (createdMs - slotMs <= BELL_TOLERANCE_MS) {
        outcome = 'landed-on-time';
      } else {
        outcome = 'flag-late';
        flag = `⚠️ The ${entry.kind} opener for ${hhmm(slotMs)}Z landed late: ${lagS} s (${Math.round(lagS / 60)} min) after the slot, over the ${BELL_TOLERANCE_MS / 1000} s tolerance.`;
      }
      who.lagSeconds = lagS;
    }
    // Commit the check before posting the flag, for the same reason as above.
    await store.put(key, { ...prior, checked: true, checkedAt: tickAt, checkOutcome: outcome });
    if (flag) {
      try {
        await post({ kind: 'flag', key, body: flag });
        summary.flagged++;
      } catch (err) {
        record({ ...base, outcome: 'flag-post-failed', ...who, error: String(err && err.message || err) });
        continue;
      }
    }
    record({ ...base, outcome, ...who });
  }
  return summary;
}

// ── REST store and recorder (#1815 wiring step A) ─────────────────────────────

/**
 * The bell store over REST (POST/PATCH/GET /api/ceremony-bells), for production: REST decides the reservation under its
 * write lock, so two processes' stores racing one key get one true and one false. Any answer other than the expected ones
 * throws, so a refused write is never mistaken for a taken bell.
 */
export function restBellStore({ base, fetch: f = globalThis.fetch, by = 'board', timeoutMs = 30000 }) {
  const call = async (method, route, body) => {
    const r = await f(`${base}${route}`, { method, signal: AbortSignal.timeout(timeoutMs),
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text };
  };
  const refused = (what, r) => new Error(`ceremony bell ${what}: ${r.status} ${r.text.slice(0, 200)}`);
  return {
    async get(key) {
      const r = await call('GET', `/api/ceremony-bells?key=${encodeURIComponent(key)}`);
      if (r.status === 404) return undefined;
      if (r.status !== 200) throw refused('read', r);
      return r.json.value;
    },
    async reserve(key, value) {
      const r = await call('POST', '/api/ceremony-bells', { key, value, by });
      if (r.status === 201) return true;
      if (r.status === 409) return false;
      throw refused('reserve', r);
    },
    async put(key, value) {
      const r = await call('PATCH', '/api/ceremony-bells', { key, value, by });
      if (r.status !== 200) throw refused('write', r);
    },
  };
}

/**
 * The tick's `record`, over REST (POST /api/ceremony-bells/events). Writes go one at a time, in order. A failed write is
 * logged and counted, never thrown: the bell posts whether or not its diary does. The next write that lands carries
 * `droppedSince` (the count since this boot's last landed write) and `firstDropAt`. Every event carries bootId and bootAt.
 * Limit: the count lives in memory, so a restart before the next landed write loses it; the new boot's bootAt bounds that.
 * `record.flush()` resolves when every write queued so far has settled.
 */
export function restRecorder({ base, bootId, bootAt, fetch: f = globalThis.fetch, by = 'board', log = (m) => console.error(m), timeoutMs = 30000 }) {
  let chain = Promise.resolve();
  let dropped = 0, firstDropAt = null;
  const send = async (event) => {
    const { key = null } = event;
    const body = { key, by, event: { ...event, bootId, bootAt, ...(dropped ? { droppedSince: dropped, firstDropAt } : {}) } };
    try {
      const r = await f(`${base}/api/ceremony-bells/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      if (r.status !== 201) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
      dropped = 0; firstDropAt = null;
    } catch (err) {
      if (!dropped) firstDropAt = new Date().toISOString();
      dropped++;
      log(`[#1815] ceremony bell event not recorded (${dropped} since the last that landed): ${event.type}${event.outcome ? ` ${event.outcome}` : ''}${key ? ` ${key}` : ''}: ${err && err.message || err}`);
    }
  };
  const record = (event) => { chain = chain.then(() => send(event)); return chain; };
  record.flush = () => chain;
  return record;
}
