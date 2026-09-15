'use strict';
// M13 free trial — 13 calendar days with everything, then read-only.
//
// The license server decides when a Mac's trial started, so reinstalling the
// app never restarts it. This keeps a signed local copy so the trial also works
// offline, and a clock that has been wound back never adds days.
// No Electron in here, so it can be tested with plain Node (tests/trial.test.js).

const crypto = require('crypto');
const fs = require('fs');

const TRIAL_DAYS = 13;
const DAY_MS = 24 * 60 * 60 * 1000;
// A clock reading more than this behind the latest time we've seen was wound back.
const CLOCK_SLACK_MS = 10 * 60 * 1000;

// The user's own calendar date, in their time zone, as YYYY-MM-DD.
function localDateString(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayNumber(isoDate) {
  return Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / DAY_MS);
}

// Signed with a key tied to this Mac, so hand-editing the dates or copying the
// file to another Mac is detected. It deters casual tampering; the server stays
// the real record and overwrites this file whenever the app is online.
function sign(data, machineId) {
  const fields = Object.keys(data).filter((k) => k !== 'sig').sort().map((k) => [k, data[k]]);
  const key = crypto.createHash('sha256').update(`m13-trial|${machineId}`).digest();
  return crypto.createHmac('sha256', key).update(JSON.stringify(fields)).digest('hex');
}

function readTrialFile(filePath, machineId) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { exists: !(e && e.code === 'ENOENT'), valid: false, data: null };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { exists: true, valid: false, data: null };
  }
  const valid = !!data && typeof data === 'object'
    && typeof data.sig === 'string' && /^[0-9a-f]{64}$/.test(data.sig)
    && data.machineId === machineId
    && crypto.timingSafeEqual(Buffer.from(data.sig), Buffer.from(sign(data, machineId)));
  return { exists: true, valid, data: valid ? data : null };
}

function writeTrialFile(filePath, machineId, fields) {
  const data = { ...fields, machineId };
  delete data.sig;
  data.sig = sign(data, machineId);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath); // a crash mid-write can't leave a half-written file
  return data;
}

function removeTrialFile(filePath) {
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
}

// The server's answer becomes the local record. Its clock is trusted over the
// Mac's, which also undoes any time the Mac's clock was set too far ahead.
function fromServer(server, nowMs) {
  const serverMs = Date.parse(server.serverTime);
  return {
    startLocalDate: server.startLocalDate,
    startedAt: server.startedAt,
    hardEndsAt: server.hardEndsAt,
    converted: !!server.converted,
    lastServerCheckMs: nowMs,
    maxSeenMs: Number.isFinite(serverMs) ? serverMs : nowMs,
  };
}

// file: the result of readTrialFile. Returns what the app should do right now.
function computeTrialState(file, nowMs) {
  if (!file || !file.exists) return { kind: 'none', daysTotal: TRIAL_DAYS };
  // Edited, corrupt or copied from another Mac: read-only until the server
  // confirms the real dates on the next online launch.
  if (!file.valid) return { kind: 'expired', day: null, daysTotal: TRIAL_DAYS, daysLeft: 0, unverified: true };

  const t = file.data;
  const seenMs = Number(t.maxSeenMs) || 0;
  const effectiveNow = Math.max(nowMs, seenMs);
  const day = dayNumber(localDateString(effectiveNow)) - dayNumber(t.startLocalDate) + 1;
  const hardEndMs = Date.parse(t.hardEndsAt);
  const expired = !Number.isFinite(day) || day > TRIAL_DAYS || (Number.isFinite(hardEndMs) && effectiveNow >= hardEndMs);
  const shownDay = Number.isFinite(day) ? Math.max(1, day) : null;

  return {
    kind: expired ? 'expired' : 'trial',
    day: shownDay,
    daysTotal: TRIAL_DAYS,
    daysLeft: expired ? 0 : TRIAL_DAYS - shownDay + 1,
    startLocalDate: t.startLocalDate,
    clockWoundBack: nowMs < seenMs - CLOCK_SLACK_MS,
    converted: !!t.converted,
  };
}

module.exports = {
  TRIAL_DAYS,
  DAY_MS,
  localDateString,
  dayNumber,
  readTrialFile,
  writeTrialFile,
  removeTrialFile,
  fromServer,
  computeTrialState,
};
