'use strict';
// Free trial tests — run: npm test
// 1. Day counting in several time zones (each in its own process, since Node
//    reads TZ at start-up).  2. The signed local file.  3. Trial states.
// 4. How main.js, preload.js and package.json are wired, so a new action can't
//    slip in without being classified as locked or allowed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const T = require('../trial');

const DAY = T.DAY_MS;
const MACHINE = 'a'.repeat(32);

// ── Child mode: one time zone ───────────────────────────────────────────────
if (process.argv[2] === '--tz-case') {
  const [y, mo, d] = process.argv[3].split('-').map(Number);
  const startMs = new Date(y, mo - 1, d, 23, 30).getTime();           // started 11:30pm local
  const file = {
    exists: true,
    valid: true,
    data: {
      startLocalDate: T.localDateString(startMs),
      startedAt: new Date(startMs).toISOString(),
      hardEndsAt: new Date(startMs + 14 * DAY).toISOString(),
      maxSeenMs: startMs,
    },
  };
  const at = (dayOffset, h, m) => new Date(y, mo - 1, d + dayOffset, h, m).getTime();
  const out = {
    day1: T.computeTrialState(file, at(0, 23, 45)),
    day13Late: T.computeTrialState(file, at(12, 23, 59)),
    day14Early: T.computeTrialState(file, at(13, 0, 1)),
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

let pass = 0;
let fail = 0;
const ok = (label, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''}`); }
};

// ── 1. Day counting across time zones ───────────────────────────────────────
console.log('\n1. Day 13 lasts until local midnight, in every time zone');
for (const [tz, start] of [
  ['Pacific/Guam', '2026-09-15'],
  ['Pacific/Honolulu', '2026-09-15'],
  ['Pacific/Kiritimati', '2026-09-15'],
  ['Europe/London', '2026-10-20'],          // crosses the end of British Summer Time
  ['America/Los_Angeles', '2026-10-25'],    // crosses the end of US daylight time
]) {
  const r = JSON.parse(execFileSync(process.execPath, [__filename, '--tz-case', start], { env: { ...process.env, TZ: tz } }).toString());
  ok(`${tz}: started 11:30pm → day 1`, r.day1.kind === 'trial' && r.day1.day === 1 && r.day1.daysLeft === 13, r.day1);
  ok(`${tz}: 11:59pm on day 13 → still on`, r.day13Late.kind === 'trial' && r.day13Late.day === 13 && r.day13Late.daysLeft === 1, r.day13Late);
  ok(`${tz}: 12:01am on day 14 → ended`, r.day14Early.kind === 'expired' && r.day14Early.daysLeft === 0, r.day14Early);
}

// ── 2. The signed local file ────────────────────────────────────────────────
console.log('\n2. trial.json can’t be edited, copied or corrupted into more days');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm13-trial-test-'));
const file = path.join(dir, 'trial.json');
const record = { startLocalDate: '2026-09-15', startedAt: '2026-09-15T02:00:00.000Z', hardEndsAt: '2026-09-29T02:00:00.000Z', converted: false, maxSeenMs: Date.parse('2026-09-15T02:00:00Z') };

ok('no file → exists: false', T.readTrialFile(file, MACHINE).exists === false);
T.writeTrialFile(file, MACHINE, record);
const good = T.readTrialFile(file, MACHINE);
ok('written file reads back valid', good.exists && good.valid && good.data.startLocalDate === '2026-09-15', good);
ok('no temp file left behind', !fs.existsSync(`${file}.tmp`));

const edited = JSON.parse(fs.readFileSync(file, 'utf8'));
edited.startLocalDate = '2026-12-01';
fs.writeFileSync(path.join(dir, 'edited.json'), JSON.stringify(edited));
ok('start date edited by hand → invalid', T.readTrialFile(path.join(dir, 'edited.json'), MACHINE).valid === false);
ok('copied to another Mac → invalid', T.readTrialFile(file, 'b'.repeat(32)).valid === false);
fs.writeFileSync(path.join(dir, 'garbage.json'), '{not json');
const garbage = T.readTrialFile(path.join(dir, 'garbage.json'), MACHINE);
ok('corrupt file → exists but invalid', garbage.exists === true && garbage.valid === false, garbage);
fs.writeFileSync(path.join(dir, 'badsig.json'), JSON.stringify({ ...record, machineId: MACHINE, sig: 'ünïcödé' }));
let threw = false;
try { T.readTrialFile(path.join(dir, 'badsig.json'), MACHINE); } catch { threw = true; }
ok('odd signature value → invalid, never a crash', !threw && T.readTrialFile(path.join(dir, 'badsig.json'), MACHINE).valid === false);
T.removeTrialFile(file);
ok('remove → gone (and removing again is fine)', !fs.existsSync(file) && (T.removeTrialFile(file), true));
fs.rmSync(dir, { recursive: true, force: true });

// ── 3. Trial states ─────────────────────────────────────────────────────────
console.log('\n3. What the app is allowed to do');
const valid = (data) => ({ exists: true, valid: true, data });
const base = { ...record };
const utcNoon = (iso) => Date.parse(`${iso}T12:00:00`); // local noon, avoids midnight edges

ok('no file → "none"', T.computeTrialState({ exists: false }, Date.now()).kind === 'none');
const unverified = T.computeTrialState({ exists: true, valid: false }, Date.now());
ok('tampered/corrupt → read-only until the server confirms', unverified.kind === 'expired' && unverified.unverified === true, unverified);

const s1 = T.computeTrialState(valid({ ...base, startLocalDate: '2026-09-15', maxSeenMs: 0, hardEndsAt: '2026-10-15T00:00:00Z' }), utcNoon('2026-09-15'));
ok('start day → trial, day 1 of 13', s1.kind === 'trial' && s1.day === 1 && s1.daysLeft === 13 && s1.daysTotal === 13, s1);
const s13 = T.computeTrialState(valid({ ...base, maxSeenMs: 0, hardEndsAt: '2026-10-15T00:00:00Z' }), utcNoon('2026-09-27'));
ok('day 13 → trial, 1 day left', s13.kind === 'trial' && s13.day === 13 && s13.daysLeft === 1, s13);
const s14 = T.computeTrialState(valid({ ...base, maxSeenMs: 0, hardEndsAt: '2026-10-15T00:00:00Z' }), utcNoon('2026-09-28'));
ok('day 14 → expired', s14.kind === 'expired' && s14.daysLeft === 0 && s14.day === 14, s14);
const cap = T.computeTrialState(valid({ ...base, maxSeenMs: 0, hardEndsAt: '2026-09-20T00:00:00Z' }), utcNoon('2026-09-22'));
ok('server hard cap reached → expired even on "day 8"', cap.kind === 'expired', cap);

const woundBack = T.computeTrialState(valid({ ...base, maxSeenMs: utcNoon('2026-09-28'), hardEndsAt: '2026-10-15T00:00:00Z' }), utcNoon('2026-09-18'));
ok('clock wound back from day 14 to day 4 → still expired', woundBack.kind === 'expired' && woundBack.clockWoundBack === true, woundBack);
const smallDrift = T.computeTrialState(valid({ ...base, maxSeenMs: utcNoon('2026-09-18') + 5 * 60 * 1000, hardEndsAt: '2026-10-15T00:00:00Z' }), utcNoon('2026-09-18'));
ok('a few minutes of clock drift is not treated as winding back', smallDrift.clockWoundBack === false, smallDrift);

const serverNow = '2026-09-18T01:00:00.000Z';
const merged = T.fromServer({ status: 'active', startLocalDate: '2026-09-15', startedAt: base.startedAt, hardEndsAt: base.hardEndsAt, serverTime: serverNow, converted: true }, Date.parse('2030-01-01T00:00:00Z'));
ok('server answer → local record, trusting the server’s clock over a wrong Mac clock', merged.maxSeenMs === Date.parse(serverNow) && merged.converted === true && merged.startLocalDate === '2026-09-15', merged);

// ── 4. Wiring ───────────────────────────────────────────────────────────────
console.log('\n4. main.js / preload.js / package.json wiring');
const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

ok('trial.js is packaged into the app', pkg.build.files.includes('trial.js'), pkg.build.files);

const registered = [...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]);
const lockedMatch = main.match(/const LOCKED_AFTER_TRIAL = new Set\(\[([\s\S]*?)\]\);/);
const locked = lockedMatch ? [...lockedMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
const ALLOWED = [
  // updates, dialogs, reading & browsing
  'install-update', 'check-for-updates-now', 'select-folder', 'select-dest-folder', 'select-convert-dest', 'select-folder-from',
  'choose-option', 'list-directory', 'scan-folder', 'library-load', 'locations-list', 'locations-rescan',
  'get-metadata', 'get-artwork', 'get-audio-url', 'reveal-in-finder', 'get-last-folder',
  // play history, recorded sets, Rekordbox, My Collection
  'scan-history', 'match-history', 'scan-sets', 'get-set-tags', 'scan-rekordbox', 'applemusic-load', 'applemusic-locate',
  // reading saved things
  'load-bangers', 'load-track-state', 'sessions-list', 'crates-list', 'load-missing', 'removed-folders-list',
  // analysis & artwork scans that only read
  'detect-tuning', 'scan-artwork', 'pick-brand-image', 'get-brand-default',
  // the app's own housekeeping (caches, layout, theme, last session)
  'save-missing', 'removed-folders-save', 'load-tuning-cache', 'save-tuning-cache', 'load-waveform-cache', 'save-waveform-cache',
  'set-native-theme', 'get-app-version', 'mark-version-seen', 'load-column-config', 'save-column-config',
  'load-session-state', 'save-session-state', 'save-last-folder',
  // licence & trial
  'get-machine-id', 'get-license-info', 'check-license', 'activate-license', 'transfer-license', 'get-entitlement', 'start-trial',
  'open-buy-page',
];
const unclassified = registered.filter((c) => !locked.includes(c) && !ALLOWED.includes(c));
const both = locked.filter((c) => ALLOWED.includes(c));
const stale = [...locked, ...ALLOWED].filter((c) => !registered.includes(c));
ok(`all ${registered.length} actions are classified (${locked.length} locked, ${ALLOWED.length} allowed)`, unclassified.length === 0, unclassified);
ok('no action is both locked and allowed', both.length === 0, both);
ok('no classified action is missing from main.js', stale.length === 0, stale);
for (const c of ['save-track-state', 'save-bangers', 'convert-tuning', 'export-set', 'copy-track', 'crates-save', 'save-metadata', 'library-add-files']) {
  ok(`"${c}" is locked after the trial`, locked.includes(c));
}
for (const c of ['get-audio-url', 'scan-history', 'library-load', 'activate-license']) {
  ok(`"${c}" stays open after the trial`, ALLOWED.includes(c) && !locked.includes(c));
}

ok('a licence is re-checked with the server every 12 hours', /const VERIFY_INTERVAL_MS = 12 \* 60 \* 60 \* 1000;/.test(main));
const wrapAt = main.indexOf('ipcMain.handle = (channel, handler)');
const firstHandle = main.search(/ipcMain\.handle\('/);
ok('the lock is installed before the first action is registered', wrapAt > 0 && wrapAt < firstHandle, { wrapAt, firstHandle });

// The self-test functions at the end of main.js only run behind a guarded switch.
const appCode = main.slice(0, main.indexOf('// ── Entitlement self-test (test builds only)'));
ok('self-tests only start behind the test-build guard', /if \(!app\.isPackaged && process\.env\.M13_SELFTEST === 'entitlement'\)/.test(appCode) && /if \(!app\.isPackaged && process\.env\.M13_SELFTEST === 'trial-flow'\)/.test(appCode));
const envLines = appCode.split('\n').filter((l) => /process\.env\.M13_/.test(l));
const unguarded = envLines.filter((l) => !/isPackaged/.test(l));
ok(`test-build switches (${envLines.length}) are all ignored in a packaged app`, envLines.length >= 4 && unguarded.length === 0, unguarded);

for (const fn of ['getEntitlement', 'startTrial', 'onEntitlementChanged']) {
  ok(`preload exposes ${fn}`, new RegExp(`\\b${fn}:`).test(preload));
}
ok('activating a key refreshes the entitlement', /writeStoredLicense\(licenseKey[^\n]*\n\s*await refreshEntitlement\(\)/.test(main));
ok('transferring a key away refreshes the entitlement', /clearStoredLicense\(\);\s*\n\s*await refreshEntitlement\(\);/.test(main));

const preloadLocked = (preload.match(/const LOCKED_AFTER_TRIAL = new Set\(\[([\s\S]*?)\]\);/) || [, ''])[1].match(/'([^']+)'/g) || [];
ok('preload’s locked list matches main.js exactly', JSON.stringify(preloadLocked.map((x) => x.slice(1, -1)).sort()) === JSON.stringify([...locked].sort()), { preload: preloadLocked.length, main: locked.length });
ok('every preload call goes through the lock-aware invoke()', !/exposeInMainWorld[\s\S]*ipcRenderer\.invoke\(/.test(preload));
ok('Buy opens a fixed address only', /ipcMain\.handle\('open-buy-page', \(\) => shell\.openExternal\(BUY_URL\)\)/.test(main) && /BUY_URL = 'https:\/\/m13app\.gumroad\.com\/l\/fqprav'/.test(main));

// ── 5. Screens (index.html) ─────────────────────────────────────────────────
console.log('\n5. Trial screens — approved wording, gates, old pre-order screen gone');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const APPROVED = [
  'Welcome to M13',
  'Try everything free for 13 days. No card, no sign-up.',
  'Start free trial',
  'I have a license key',
  'Starting the trial needs internet once. After that, M13 works offline.',
  '· Buy',
  'Last day · Buy',
  "You're on day ${_ent.day} of your free trial. Everything's unlocked until ${trialLastDayLabel(_ent)}.",
  'Buy M13, $199',
  '${ent.daysLeft} days left in your free trial',
  'Everything stays unlocked until ${trialLastDayLabel(ent)}. Buy now and nothing changes: your library, crates and sets carry straight on.',
  'Maybe later',
  'Last day of your free trial',
  'From tomorrow, M13 is read-only. You can still browse and play your library, but saving, converting and exporting will need a license key.',
  'Not now',
  'Your free trial has ended. Your library is still here to browse and play.',
  'This needs a license',
  'Your free trial has ended, saving, converting and exporting are locked. Your library is still here to browse and play.',
  "Everything's unlocked. Enjoy M13.",
];
for (const text of APPROVED) ok(`wording present: "${text.length > 70 ? text.slice(0, 67) + '…' : text}"`, html.includes(text));
ok('main.js locked message is the approved one', main.includes("'Your free trial has ended, saving, converting and exporting are locked. Your library is still here to browse and play.'"));
ok('the old pre-order screen is gone', !/preOrderModal|showPreOrderScreen|LAUNCH_DATE/.test(html));
ok('startup asks for the entitlement, not the old licence check', /applyEntitlement\(await window\.m13\.getEntitlement\(\)\)/.test(html) && !/await window\.m13\.checkLicense\(\)/.test(html));
ok('the broken require("electron") Buy link is gone', !/require\('electron'\)/.test(html));
ok('What’s New fits a small screen: card bounded, list scrolls, buttons pinned',
  /\.whats-new-card \{[^}]*max-height: calc\(100vh - 48px\)/s.test(html) &&
  /\.whats-new-features \{[^}]*overflow-y: auto/s.test(html) &&
  /\.whats-new-actions \{[^}]*flex-shrink: 0/s.test(html));
ok('the Feature Tour card fits a small screen too', /\.tour-card \{[^}]*max-height: calc\(100vh - 48px\)/s.test(html));
const gates = (html.match(/needsLicense\(\)/g) || []).length;
ok(`change points are gated in the screens (${gates} gates)`, gates >= 45, gates);
for (const fn of ['_tsSet', 'addBanger', 'removeBanger', 'addToPlaylist', 'doArrange', 'openM8ForTrack', 'openTuningConvertModal', 'addFilesToLibrary', 'startCopy', '_commitCrateSave', '_commitSessionSave', 'saveMetadata', 'openBrandModal', 'efOpen']) {
  ok(`"${fn}" stops before changing anything`, new RegExp(`function ${fn}\\([^)]*\\) \\{\\n\\s*if \\(needsLicense\\(\\)\\) return;`).test(html));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
