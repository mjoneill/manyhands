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
 * The key is reserved atomically (store.reserve) BEFORE the post and before any
 * await, so neither a race nor a crash between the two can post twice; the cost is that
 * a post that throws is not retried, and the after-window check flags it as missing.
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
    const prior = store.get(key);

    if (inWindow) {
      // Take the bell BEFORE any await: the check and the take are one call, so
      // two ticks racing (in one process or two) cannot both pass. A crash after
      // this line can never post twice; the after-window check flags it missing.
      if (prior || !(await store.reserve(key, { state: 'attempted', at: tickAt }))) {
        const p = prior || store.get(key) || {};
        record({ ...base, outcome: 'suppressed-duplicate', opener: p.opener ?? null, openerSource: p.openerSource ?? null });
        continue;
      }
      const who = resolveOpener(await seatState(), nowMs);
      const outcome = who.openerSource === 'no-holder' ? 'fired-no-holder' : 'fired';
      store.put(key, { state: 'attempted', at: tickAt, ...who });
      try {
        const res = await post({ kind: 'opener', key, body: openerBody(entry, slotMs, who) });
        store.put(key, { state: 'posted', at: tickAt, ...who, postId: res && res.id, createdAt: res && res.createdAt });
        summary.posted++;
        record({ ...base, outcome, ...who });
      } catch (err) {
        record({ ...base, outcome: 'post-failed', ...who, error: String(err && err.message || err) });
      }
      continue;
    }

    // After the window: check once whether the opener landed, and on time.
    if (!prior) {
      store.put(key, { state: 'missed', at: tickAt, checked: true });
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
      flag = `⚠️ The ${entry.kind} opener for ${hhmm(slotMs)}Z is missing: no opener post landed by ${hhmm(slotMs + BELL_TOLERANCE_MS)}Z.`;
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
    store.put(key, { ...prior, checked: true, checkedAt: tickAt, checkOutcome: outcome });
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
