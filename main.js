const { app, BrowserWindow, Menu, shell, dialog, ipcMain, session, net, nativeTheme, powerMonitor } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const url = require('url');
const { Transform } = require('stream');
const crypto = require('crypto');
const { execFile } = require('child_process');
const plist = require('plist');
const { YIN } = require('pitchfinder');
const trialLib = require('./trial');

// Test builds only: run with a separate profile (licence, trial, library) so
// trial testing never touches the real one. Must run before anything reads userData.
if (!app.isPackaged && process.env.M13_USER_DATA) app.setPath('userData', process.env.M13_USER_DATA);

// music-metadata is an ESM package whose CJS `require` entry resolves (in
// Electron's main process) to a stub that only exposes `loadMusicMetadata`,
// not `parseFile`. A dynamic `import()` resolves through the ESM/"node"
// conditions instead and yields the full API (parseFile, parseStream, ...).
let musicMetadataPromise;
function getMusicMetadata() {
  if (!musicMetadataPromise) {
    musicMetadataPromise = import('music-metadata');
  }
  return musicMetadataPromise;
}

const AUDIO_EXTENSIONS = new Set(['.aif', '.aiff', '.mp3', '.wav', '.flac', '.m4a']);
let audioPort = 41234;

// ── License system ─────────────────────────────────────────────────────────────

// Test builds may point at a private test deploy of the server (M13_LICENSE_API).
const LICENSE_API = (!app.isPackaged && process.env.M13_LICENSE_API) || 'https://m13app.com/.netlify/functions/license';

// Network-STABLE machine identity. The old formula hashed os.hostname(), which
// macOS rewrites from the DHCP server of whatever network you join — so joining
// a different network changed the ID, mismatched the stored license, and
// self-wiped the activation (the job-site-network lockout bug). We now anchor to
// the macOS hardware UUID (IOPlatformUUID — never changes across networks, OS
// reinstalls, etc). Fallbacks are also network-independent, and the final
// fallback persists a random UUID so it's stable per install even if every
// hardware probe fails. Never uses os.hostname().
let _machineIdCache = null;

function _hwUuidMac() {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 3000 }).toString();
    const m = out.match(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

function _persistedFallbackId() {
  // Last resort — a random UUID written once to userData, so the ID is still
  // stable per install when no hardware identifier is available.
  const p = path.join(app.getPath('userData'), 'machine-id.json');
  try {
    const saved = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (saved && saved.id) return saved.id;
  } catch { /* not written yet */ }
  const id = crypto.randomUUID();
  try { fs.writeFileSync(p, JSON.stringify({ id }), 'utf8'); } catch { /* best effort */ }
  return id;
}

function getMachineId() {
  // Test builds only: a fake id, so trial testing never creates a server record
  // for a real Mac.
  if (!app.isPackaged && /^[0-9a-f]{32}$/.test(process.env.M13_FAKE_MACHINE_ID || '')) return process.env.M13_FAKE_MACHINE_ID;
  if (_machineIdCache) return _machineIdCache;
  let anchor = process.platform === 'darwin' ? _hwUuidMac() : null;
  // Stable, network-independent components only (NO hostname).
  if (!anchor) anchor = [os.cpus()[0]?.model || 'unknown', os.platform(), os.arch()].join('|') + '|' + _persistedFallbackId();
  _machineIdCache = crypto.createHash('sha256').update('m13|' + anchor).digest('hex').slice(0, 32);
  return _machineIdCache;
}

function getLicensePath() {
  return path.join(app.getPath('userData'), 'license.json');
}

function readStoredLicense() {
  try {
    const data = fs.readFileSync(getLicensePath(), 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// Decoupled identity (Option A migration):
//   serverMachineId — the id the activation server has BOUND to this key. Every
//     online call uses this, so a legit user is never told "wrong-machine" just
//     because their local hardware id evolved (or came from the old hostname
//     scheme). On a fresh activation it equals the current hardware id.
//   hardwareId — this machine's current stable id (getMachineId), used only for
//     local same-machine detection.
// The legacy `machineId` field is still written (= serverMachineId) for
// backward-compat and readability. Pass serverMachineId to PRESERVE an existing
// binding (re-persist / legacy migration); omit it for a fresh activation.
function writeStoredLicense(licenseKey, existingVerifiedAt, preOrder = false, serverMachineId = null) {
  const hardwareId = getMachineId();
  const boundId = serverMachineId || hardwareId;
  const now = new Date().toISOString();
  fs.writeFileSync(
    getLicensePath(),
    JSON.stringify({
      licenseKey,
      serverMachineId: boundId,
      hardwareId,
      machineId: boundId, // legacy field, kept in sync with the bound id
      storedAt: now,
      lastVerifiedAt: existingVerifiedAt || now,
      preOrder: !!preOrder,
    }),
    'utf8'
  );
}

function clearStoredLicense() {
  try { fs.unlinkSync(getLicensePath()); } catch { /* ignore */ }
}

// How long a license is trusted locally before asking the server again. 12
// hours so a refunded or switched-off key stops working the same day, while a
// Mac with no internet keeps working (checkLicenseState never locks out offline).
const VERIFY_INTERVAL_MS = 12 * 60 * 60 * 1000;

function needsOnlineVerification(stored) {
  if (!stored.lastVerifiedAt) return true;
  return Date.now() - new Date(stored.lastVerifiedAt).getTime() > VERIFY_INTERVAL_MS;
}

async function verifyLicenseOnline(licenseKey, machineId) {
  try {
    const res = await net.fetch(LICENSE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'check', licenseKey, machineId }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // offline or server unreachable
  }
}

// ── Entitlement: licensed, free trial, or trial ended (2.2) ─────────────────
// A license always wins. Without one, the free trial (trial.js) decides: 13
// calendar days with everything, then read-only. Read-only is enforced here, on
// the actions that create or change things, not only by hiding buttons.

// Everything that creates or changes something. Browsing, search, play history,
// recorded sets and playback stay open after the trial ends.
// tests/trial.test.js fails if an action is added without being classified.
const LOCKED_AFTER_TRIAL = new Set([
  // library & files
  'library-add-files', 'locations-add', 'locations-remove', 'delete-track-file',
  // copying & exporting
  'copy-folder', 'copy-track', 'copy-track-numbered', 'ensure-export-folder', 'export-track-converted',
  'export-catalogue', 'export-set', 'save-playlist-file', 'save-tracklist', 'save-set-tags',
  // changing tracks
  'convert-tuning', 'save-metadata', 'embed-artwork', 'search-artwork', 'apply-brand-artwork', 'prepare-brand-image',
  // crates, sessions, bangers, ratings & loved
  'crates-save', 'crates-delete', 'sessions-save', 'sessions-delete', 'save-bangers', 'save-track-state',
]);

// Approved wording (2026-09-15). index.html spots it to show the Buy / Enter key prompt instead.
const TRIAL_ENDED_MESSAGE = 'Your free trial has ended, saving, converting and exporting are locked. Your library is still here to browse and play.';
const BUY_URL = 'https://m13app.gumroad.com/l/fqprav';

function lockedResult(channel) {
  if (channel === 'ensure-export-folder') return null; // its callers treat null as "couldn't"
  return { ok: false, success: false, found: false, locked: true, error: TRIAL_ENDED_MESSAGE, reason: TRIAL_ENDED_MESSAGE, message: TRIAL_ENDED_MESSAGE };
}

// Every ipcMain.handle in this file goes through here, so a locked action can't
// be reached by any route once the trial has ended.
const _ipcHandlers = new Map(); // channel → wrapped handler (the dev self-test uses it)
const _ipcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => {
  const wrapped = async (event, ...args) => {
    if (LOCKED_AFTER_TRIAL.has(channel)) {
      const ent = await ensureEntitlement();
      if (!ent.canChange) return lockedResult(channel);
    }
    return handler(event, ...args);
  };
  _ipcHandlers.set(channel, wrapped);
  return _ipcHandle(channel, wrapped);
};

function getTrialPath() {
  return path.join(app.getPath('userData'), 'trial.json');
}

// Test builds only: pretend it is N days later (M13_TRIAL_DAYS_AHEAD), to see
// day 10, 13 and 14 without waiting. Server calls always use the real date.
function trialNow() {
  const ahead = !app.isPackaged ? Number(process.env.M13_TRIAL_DAYS_AHEAD || 0) : 0;
  return Date.now() + (Number.isFinite(ahead) ? ahead : 0) * trialLib.DAY_MS;
}

async function callTrialServer(start) {
  try {
    const res = await net.fetch(LICENSE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'trial',
        machineId: getMachineId(),
        localDate: trialLib.localDateString(Date.now()),
        appVersion: app.getVersion(),
        ...(start ? { start: true } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { problem: 'server' };      // reached it, but it can't help
    const data = await res.json();
    return data && ['none', 'active', 'expired'].includes(data.status) ? { data } : { problem: 'server' };
  } catch {
    return { problem: 'offline' };                   // couldn't reach it at all
  }
}

// Brings trial.json in line with the server. Returns { offline: true } when
// the server can't be reached, so nothing local is changed.
async function syncTrialWithServer({ start = false } = {}) {
  const { data: server, problem } = await callTrialServer(start);
  if (problem) return { offline: problem === 'offline', serverError: problem === 'server' };
  if (server.status === 'none') {
    trialLib.removeTrialFile(getTrialPath()); // the server is the record
  } else {
    trialLib.writeTrialFile(getTrialPath(), getMachineId(), trialLib.fromServer(server, Date.now()));
  }
  return { status: server.status };
}

function trialStateFromDisk() {
  const file = trialLib.readTrialFile(getTrialPath(), getMachineId());
  const now = trialNow();
  // Remember the latest time seen, so winding the clock back can't add days.
  if (file.valid && now > (Number(file.data.maxSeenMs) || 0) + 60 * 1000) {
    try { trialLib.writeTrialFile(getTrialPath(), getMachineId(), { ...file.data, maxSeenMs: now }); } catch { /* keep going */ }
  }
  return trialLib.computeTrialState(file, now);
}

async function computeEntitlement() {
  const license = await checkLicenseState();
  if (license.valid) return { kind: 'licensed', canChange: true, preOrder: !!license.preOrder };
  const trial = trialStateFromDisk();
  return { ...trial, canChange: trial.kind === 'trial' };
}

let _entitlement = null;
let _entitlementPromise = null;
let _trialSyncedThisLaunch = false;

async function refreshEntitlement() {
  const next = await computeEntitlement();
  const key = (e) => e && [e.kind, e.day, e.canChange, !!e.unverified].join('|');
  const changed = !!_entitlement && key(next) !== key(_entitlement);
  _entitlement = next;
  if (changed && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('entitlement-changed', next);
  return next;
}

function ensureEntitlement() {
  if (_entitlement) return Promise.resolve(_entitlement);
  if (!_entitlementPromise) _entitlementPromise = refreshEntitlement().finally(() => { _entitlementPromise = null; });
  return _entitlementPromise;
}

// Electron's bundled Chromium has no AIFF demuxer (canPlayType('audio/aiff') === '').
// AIFF is almost always uncompressed big-endian PCM, so we remux it into a
// little-endian WAV container on the fly, which Chromium does support.

function readExtendedFloatBE(buf) {
  const expon = ((buf[0] & 0x7f) << 8) | buf[1];
  const hi = buf.readUInt32BE(2);
  const lo = buf.readUInt32BE(6);

  if (expon === 0 && hi === 0 && lo === 0) return 0;

  const sign = (buf[0] & 0x80) ? -1 : 1;
  const exponent = expon - 16383 - 63;

  return sign * (hi * 2 ** 32 + lo) * 2 ** exponent;
}

function readAiffPcmInfo(filePath) {
  const fd = fs.openSync(filePath, 'r');

  try {
    const fileSize = fs.fstatSync(fd).size;
    let offset = 12; // past 'FORM' + size + 'AIFF'/'AIFC'
    let format = null;
    let sound = null;

    while (offset + 8 <= fileSize && (!format || !sound)) {
      const header = Buffer.alloc(8);
      fs.readSync(fd, header, 0, 8, offset);

      const chunkId = header.toString('ascii', 0, 4);
      const chunkSize = header.readUInt32BE(4);
      const dataStart = offset + 8;

      if (chunkId === 'COMM') {
        const body = Buffer.alloc(18);
        fs.readSync(fd, body, 0, 18, dataStart);

        format = {
          channels: body.readUInt16BE(0),
          bitsPerSample: body.readUInt16BE(6),
          sampleRate: Math.round(readExtendedFloatBE(body.subarray(8, 18))),
        };
      } else if (chunkId === 'SSND') {
        const ssndHeader = Buffer.alloc(8);
        fs.readSync(fd, ssndHeader, 0, 8, dataStart);

        const dataOffset = ssndHeader.readUInt32BE(0);

        sound = {
          start: dataStart + 8 + dataOffset,
          size: chunkSize - 8 - dataOffset,
        };
      }

      offset = dataStart + chunkSize + (chunkSize % 2);
    }

    if (!format || !sound) return null;

    return { ...format, ...sound };
  } finally {
    fs.closeSync(fd);
  }
}

function buildWavHeader({ channels, sampleRate, bitsPerSample, dataSize }) {
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return header;
}

// AIFF stores multi-byte PCM samples big-endian; WAV expects little-endian.
class SampleByteSwap extends Transform {
  constructor(bytesPerSample) {
    super();
    this.bytesPerSample = bytesPerSample;
    this.remainder = Buffer.alloc(0);
  }

  _transform(chunk, _encoding, callback) {
    if (this.bytesPerSample <= 1) {
      callback(null, chunk);
      return;
    }

    const data = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk;
    const usableLength = data.length - (data.length % this.bytesPerSample);
    this.remainder = Buffer.from(data.subarray(usableLength));

    const swapped = Buffer.from(data.subarray(0, usableLength));

    for (let i = 0; i < swapped.length; i += this.bytesPerSample) {
      swapped.subarray(i, i + this.bytesPerSample).reverse();
    }

    callback(null, swapped);
  }

  _flush(callback) {
    callback(null, this.remainder);
  }
}

// Drops `skip` bytes from the front of the stream and passes through at most
// `length` bytes after that — used to trim a sample-aligned read back down to
// the exact byte range a Range request asked for.
class SliceTransform extends Transform {
  constructor(skip, length) {
    super();
    this.skip = skip;
    this.remaining = length;
  }

  _transform(chunk, _encoding, callback) {
    if (this.remaining <= 0) {
      callback();
      return;
    }

    let data = chunk;

    if (this.skip > 0) {
      if (this.skip >= data.length) {
        this.skip -= data.length;
        callback();
        return;
      }

      data = data.subarray(this.skip);
      this.skip = 0;
    }

    if (data.length > this.remaining) {
      data = data.subarray(0, this.remaining);
    }

    this.remaining -= data.length;
    callback(null, data);
  }
}

// Read stream for the audio server whose open/read failures end the HTTP
// response instead of taking down the main process. An unhandled 'error' on a
// piped stream is an uncaught exception, and macOS TCC returns EPERM for files
// under Downloads/Documents/Desktop until the app is granted access — the
// tuning scan walks every file in the library, so one blocked folder used to
// kill the whole app mid-scan.
function serveReadStream(filePath, opts, res) {
  const stream = fs.createReadStream(filePath, opts || undefined);
  stream.on('error', (err) => {
    const code = (err && err.code) || 'EIO';
    console.warn(`audio stream ${code}: ${filePath}`);
    if (!res.headersSent) {
      const status = code === 'EPERM' || code === 'EACCES' ? 403 : 404;
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(status === 403 ? 'Permission denied' : 'Read error');
    } else {
      res.destroy();
    }
  });
  return stream;
}

function streamAiffAsWav(filePath, req, res) {
  const pcmInfo = readAiffPcmInfo(filePath);

  if (!pcmInfo) {
    res.writeHead(415, { 'Content-Type': 'text/plain' });
    res.end('Unsupported AIFF layout');
    return;
  }

  const bytesPerSample = pcmInfo.bitsPerSample / 8;
  const wavHeader = buildWavHeader({
    channels: pcmInfo.channels,
    sampleRate: pcmInfo.sampleRate,
    bitsPerSample: pcmInfo.bitsPerSample,
    dataSize: pcmInfo.size,
  });
  const totalLength = wavHeader.length + pcmInfo.size;

  let start = 0;
  let end = totalLength - 1;
  let status = 200;
  const range = req.headers.range;

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const rangeStart = match && match[1] ? parseInt(match[1], 10) : 0;
    const rangeEnd = match && match[2] ? parseInt(match[2], 10) : totalLength - 1;

    if (Number.isNaN(rangeStart) || Number.isNaN(rangeEnd) || rangeStart > rangeEnd || rangeEnd >= totalLength) {
      res.writeHead(416, { 'Content-Range': `bytes */${totalLength}` });
      res.end();
      return;
    }

    start = rangeStart;
    end = rangeEnd;
    status = 206;
  }

  const headers = {
    'Content-Type': 'audio/wav',
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };

  if (status === 206) {
    headers['Content-Range'] = `bytes ${start}-${end}/${totalLength}`;
  }

  res.writeHead(status, headers);

  if (start < wavHeader.length) {
    res.write(wavHeader.subarray(start, Math.min(end, wavHeader.length - 1) + 1));
  }

  if (end < wavHeader.length) {
    res.end();
    return;
  }

  // Position within the (virtual) WAV data chunk that the range actually wants.
  const dataStart = Math.max(start, wavHeader.length) - wavHeader.length;
  const dataEnd = end - wavHeader.length;

  if (bytesPerSample <= 1) {
    serveReadStream(filePath, {
      start: pcmInfo.start + dataStart,
      end: pcmInfo.start + dataEnd,
    }, res).pipe(res);
    return;
  }

  // Byte-swapping needs whole samples, so read a sample-aligned superset of the
  // requested range, swap it, then trim back down to exactly what was asked for.
  const alignedStart = Math.floor(dataStart / bytesPerSample) * bytesPerSample;
  const alignedEndExclusive = Math.min(
    pcmInfo.size,
    (Math.floor(dataEnd / bytesPerSample) + 1) * bytesPerSample,
  );

  serveReadStream(filePath, {
    start: pcmInfo.start + alignedStart,
    end: pcmInfo.start + alignedEndExclusive - 1,
  }, res)
    .pipe(new SampleByteSwap(bytesPerSample))
    .pipe(new SliceTransform(dataStart - alignedStart, dataEnd - dataStart + 1))
    .pipe(res);
}

let mainWindow;

let aboutWindow = null;

function createAboutWindow() {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.focus();
    return;
  }
  aboutWindow = new BrowserWindow({
    width: 340,
    height: 452,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'About M13',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#080810',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  aboutWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html,body{width:100%;height:100%;background:#080810;color:#efefef;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif;-webkit-font-smoothing:antialiased;user-select:none}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 32px 32px;gap:0;-webkit-app-region:drag}
  .logo{width:96px;height:96px;display:block;margin:0 auto 18px;-webkit-user-drag:none}
  .app-name{font-size:17px;font-weight:700;color:#efefef;margin-bottom:4px}
  .version{font-size:12px;color:#666;margin-bottom:18px;font-variant-numeric:tabular-nums}
  .tagline{font-size:13px;color:#bdbdbd;line-height:1.55;margin-bottom:6px}
  .desc{font-size:12px;color:#666;line-height:1.5;margin-bottom:24px;font-style:italic}
  .divider{width:40px;height:1px;background:#222;margin:0 auto 20px}
  .built-by{font-size:12px;color:#555;margin-bottom:6px}
  a{color:#a8d8ee;text-decoration:none;font-size:12px;font-weight:600;-webkit-app-region:no-drag}
  a:hover{text-decoration:underline;text-underline-offset:3px}
</style>
</head>
<body>
  <img class="logo" alt="M13" src="data:image/png;base64,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"/>
  <div class="app-name">DJ Library &amp; Discovery</div>
  <div class="version">Version ${app.getVersion()}</div>
  <div class="tagline">Your entire DJ career.<br>Finally organised.</div>
  <div class="desc">The library app built by a DJ, for DJs.</div>
  <div class="divider"></div>
  <div class="built-by">Built by dj pm</div>
  <a href="https://m13app.com" onclick="require('electron').shell.openExternal('https://m13app.com');return false">m13app.com</a>
</body>
</html>`));
  aboutWindow.on('closed', () => { aboutWindow = null; });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: 'M13',
      submenu: [
        {
          label: 'About M13',
          click: () => createAboutWindow(),
        },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('check-for-updates');
            }
          },
        },
        {
          label: 'Preferences…',
          accelerator: 'Cmd+,',
          enabled: false, // placeholder — wire up when preferences are implemented
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide M13' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit M13' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Add Library Location…',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('menu-open-library');
            }
          },
        },
        {
          label: 'Library Locations…',
          accelerator: 'CmdOrCtrl+L',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('menu-library-locations');
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Convert Folder to 432hz / 440hz…',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('menu-convert-folder');
            }
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : []),
      ],
    },
    {
      label: 'License',
      submenu: [
        {
          label: 'License Status…',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('open-license-info');
            }
          },
        },
        {
          label: 'Transfer to New Machine…',
          click: () => shell.openExternal('https://m13app.com/license/'),
        },
        {
          label: 'Manage License Online…',
          click: () => shell.openExternal('https://m13app.com/license/'),
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Guided Tutorial',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('open-tutorial');
          },
        },
        {
          label: 'Feature Tour',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('open-feature-tour');
          },
        },
        { type: 'separator' },
        {
          label: 'Visit m13app.com',
          click: () => shell.openExternal('https://m13app.com'),
        },
        {
          label: 'Send Feedback…',
          click: () => shell.openExternal('mailto:hello@m13app.com'),
        },
        { type: 'separator' },
        {
          label: 'Toggle Developer Tools',
          accelerator: 'CmdOrCtrl+Alt+I',
          click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.toggleDevTools(); },
        },
        ...(!isMac ? [{ type: 'separator' }, { label: 'About M13', click: () => createAboutWindow() }] : []),
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'M13',
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      experimentalFeatures: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // "What's New" gate — fires once per actual version bump, not per launch.
  // loadConfig/saveConfig is the same userData-backed key/value store already
  // used for lastFolder etc.; did-finish-load ensures the renderer's IPC
  // listeners (registered by its own <script>) are attached before we send.
  mainWindow.webContents.on('did-finish-load', () => {
    const currentVersion = app.getVersion();
    const lastSeenVersion = loadConfig().lastSeenVersion;
    if (lastSeenVersion !== currentVersion && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('show-whats-new', { version: currentVersion });
    }
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

function isAudioFile(fileName) {
  return AUDIO_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function getAudioMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.aif' || ext === '.aiff') return 'audio/aiff';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.flac') return 'audio/flac';

  return 'application/octet-stream';
}

// ── Apple Lossless (ALAC) on-demand transcode ─────────────────────────────────
// Chromium's bundled decoders don't cover ALAC (common in Apple Music CD rips),
// so when the audio server is asked for an ALAC .m4a we transcode it to a plain
// 16-bit WAV via macOS's built-in `afconvert` (no bundled binaries) and serve
// that instead — keeping ALAC tracks on the same shared audio chain, so the
// 432/440 toggle still applies. Plain AAC .m4a files are served untouched.
const _alacProbeCache = new Map(); // `${path}:${mtimeMs}` -> boolean (is ALAC)
const _alacWavCache   = new Map(); // `${path}:${mtimeMs}` -> transcoded wav path

function alacCacheDir() {
  const dir = path.join(app.getPath('userData'), 'alac-cache');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

async function isAlacFile(filePath) {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch (_) { return false; }
  const key = `${filePath}:${mtimeMs}`;
  if (_alacProbeCache.has(key)) return _alacProbeCache.get(key);
  let isAlac = false;
  try {
    const mm = await getMusicMetadata();
    const md = await mm.parseFile(filePath, { duration: false, skipCovers: true });
    const codec = ((md.format && md.format.codec) || '').toLowerCase();
    isAlac = codec.includes('alac');
  } catch (_) { isAlac = false; }
  _alacProbeCache.set(key, isAlac);
  return isAlac;
}

// Returns a path to a playable WAV for an ALAC source (transcoding + caching on
// first request), or null if the file isn't ALAC / can't be transcoded.
async function ensureAlacWav(filePath) {
  if (!(await isAlacFile(filePath))) return null;
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch (_) { return null; }
  const key = `${filePath}:${mtimeMs}`;
  const cached = _alacWavCache.get(key);
  if (cached && fs.existsSync(cached)) return cached;
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  const wavPath = path.join(alacCacheDir(), `${hash}.wav`);
  if (fs.existsSync(wavPath) && fs.statSync(wavPath).size > 0) {
    _alacWavCache.set(key, wavPath);
    return wavPath;
  }
  await new Promise((resolve, reject) => {
    // -f WAVE, little-endian signed 16-bit PCM; afconvert keeps the source rate.
    execFile('afconvert', ['-f', 'WAVE', '-d', 'LEI16', filePath, wavPath],
      { timeout: 120000 }, (err) => (err ? reject(err) : resolve()));
  });
  _alacWavCache.set(key, wavPath);
  return wavPath;
}

// Range-aware static file server (used for the transcoded ALAC WAVs).
function serveFileWithRange(filePath, req, res, mimeType) {
  const { size } = fs.statSync(filePath);
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match && match[1] ? parseInt(match[1], 10) : 0;
    const end = match && match[2] ? parseInt(match[2], 10) : size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': mimeType,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    serveReadStream(filePath, { start, end }, res).pipe(res);
    return;
  }
  res.writeHead(200, {
    'Content-Type': mimeType,
    'Content-Length': size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  serveReadStream(filePath, null, res).pipe(res);
}

// ── Apple Music library (read-only) ───────────────────────────────────────────
// Parses the user's exported "Music Library.xml" (an Apple plist) into a compact
// structure for the isolated Apple Music section. Never touches audio files and
// never feeds the DJ library. Returns { needsSetup:true } when the XML is absent
// or unreadable (the user must enable Share Library XML, or point us at it).
// Preferred first (modern Music.app export), then the legacy iTunes export that
// many long-time users still have. First one that exists on disk wins.
const APPLE_XML_CANDIDATES = [
  path.join(os.homedir(), 'Music', 'Music', 'Music Library.xml'),
  path.join(os.homedir(), 'Music', 'iTunes', 'iTunes Music Library.xml'),
];
function findAppleXml() {
  return APPLE_XML_CANDIDATES.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
}

function parseAppleLibrary(xmlPath) {
  try {
    if (!xmlPath || !fs.existsSync(xmlPath)) return { needsSetup: true };
    let raw;
    try {
      raw = fs.readFileSync(xmlPath, 'utf8');
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') return { needsSetup: true, reason: 'denied' };
      throw e;
    }
    const data = plist.parse(raw) || {};
    const updatedAt = fs.statSync(xmlPath).mtimeMs;

    // plist parses <date> to JS Date and <integer> to Number; normalise dates to ms.
    const toMs = (v) => v instanceof Date ? v.getTime() : (v ? (Date.parse(v) || 0) : 0);
    const trackDict = data.Tracks || {};
    const tracks = [];
    const byId = new Map();
    for (const k of Object.keys(trackDict)) {
      const t = trackDict[k] || {};
      const loc = t.Location;
      let fsPath = null;
      if (loc) { try { fsPath = url.fileURLToPath(loc); } catch (_) { fsPath = null; } }
      const kind = t.Kind || '';
      const ext = fsPath ? path.extname(fsPath).toLowerCase() : '';

      let state;
      if (!loc) state = 'notDownloaded';               // iCloud track, not on disk
      else if (!fsPath || !fs.existsSync(fsPath)) state = 'missing';
      else if (ext === '.m4p' || /protected/i.test(kind)) state = 'protected'; // FairPlay DRM
      else if (/lossless/i.test(kind)) state = 'alac';  // playable (transcoded on the fly)
      else state = 'playable';

      const track = {
        id: t['Track ID'],
        name: t.Name || 'Unknown',
        artist: t.Artist || t['Album Artist'] || '',
        albumArtist: t['Album Artist'] || t.Artist || '', // groups the way Apple's Artists view does
        // Various-artists comp: every track has a different Artist and usually NO
        // Album Artist, so without this the album splits one-per-artist.
        compilation: !!t.Compilation || /\/Compilations\//.test(fsPath || ''),
        trackNumber: t['Track Number'] || 0,
        discNumber: t['Disc Number'] || 0,   // only used to order multi-disc albums
        album: t.Album || '',
        duration: t['Total Time'] ? Math.round(t['Total Time'] / 1000) : 0,
        path: fsPath,
        state,
        tuning: '440', // uniform 432 behaviour: assume 440 so 432-mode shifts it down
        // Carried over from Apple so a migrant keeps their years of curation:
        rating: t.Rating || 0,          // 0–100 (Apple: 20 per star)
        playCount: t['Play Count'] || 0,
        loved: !!t.Loved,
        dateAdded: toMs(t['Date Added']),
        lastPlayed: toMs(t['Play Date UTC']),
        year: t.Year || 0,
      };
      tracks.push(track);
      if (track.id != null) byId.set(track.id, track);
    }

    const playlists = [];
    for (const p of (data.Playlists || [])) {
      if (!p || p.Master || p['Distinguished Kind'] != null || p.Visible === false) continue;
      if (p.Name === 'Library' || p.Name === 'Downloaded') continue;
      const trackIds = (p['Playlist Items'] || [])
        .map(it => it && it['Track ID'])
        .filter(id => byId.has(id));
      if (!trackIds.length) continue;
      playlists.push({
        id: p['Playlist Persistent ID'] || p['Playlist ID'] || p.Name,
        name: p.Name || 'Untitled',
        trackIds,
      });
    }

    return { ok: true, tracks, playlists, updatedAt, xmlPath };
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
}

// The actual media folder on disk. The exported XML is a static snapshot that
// Apple stopped updating after the iTunes→Music switch (long-time users' XML is
// frozen years in the past), so anything added since is invisible via XML alone.
// Scanning the media folder directly is the durable source of truth.
const APPLE_MEDIA_CANDIDATES = [
  path.join(os.homedir(), 'Music', 'iTunes', 'iTunes Media', 'Music'),      // legacy library that never migrated
  path.join(os.homedir(), 'Music', 'Music', 'Media.localized', 'Music'),    // modern managed library
  path.join(os.homedir(), 'Music', 'Music', 'Media', 'Music'),
];
function findAppleMediaDir() {
  return APPLE_MEDIA_CANDIDATES.find(p => {
    try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch (_) { return false; }
  }) || null;
}

// Lightweight recursive enumerator — audio file paths only, no tag reads or
// stats (those happen only for files the XML doesn't already describe).
function listAudioFilesShallowTags(dir, out) {
  out = out || [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) { listAudioFilesShallowTags(full, out); continue; }
      if (!e.isFile() || e.name.startsWith('._')) continue;
      if (!isAudioFile(e.name)) continue;
      out.push(full);
    } catch (_) { /* skip unreadable entry */ }
  }
  return out;
}

// Folder-scan (source of truth) MERGED with the XML (metadata enrichment).
// Every audio file on disk shows up; files the XML already knows about carry
// their Apple rating/plays/loved/dateAdded, and files the XML has never heard
// of (post-freeze additions) are read fresh from their embedded tags. New-file
// tag reads are cached (mtime+size) so only the first load pays for them.
async function loadAppleLibraryMerged() {
  try {
    const mediaDir = findAppleMediaDir();
    const xmlPath  = findAppleXml();
    const xmlRes   = xmlPath ? parseAppleLibrary(xmlPath) : null;

    // No media folder found → fall back to the old XML-only behaviour.
    if (!mediaDir) {
      if (xmlRes && xmlRes.ok) return { ...xmlRes, source: 'xml', mediaDir: null };
      return xmlRes || { needsSetup: true };
    }

    const xmlTracks = (xmlRes && xmlRes.ok) ? xmlRes.tracks : [];
    const playlists = (xmlRes && xmlRes.ok) ? xmlRes.playlists : [];
    const updatedAt = (xmlRes && xmlRes.ok) ? xmlRes.updatedAt : 0;

    // Index XML tracks by path. macOS stores filenames NFD on disk while the XML
    // may encode NFC, so normalise both sides or accented names won't match.
    const norm = (p) => (p ? p.normalize('NFC') : p);
    const xmlByPath = new Map();
    for (const t of xmlTracks) if (t.path) xmlByPath.set(norm(t.path), t);

    const files = listAudioFilesShallowTags(mediaDir);

    // New-file tag cache (keeps re-loads instant even for the post-freeze files).
    const cachePath = path.join(app.getPath('userData'), 'applemusic-media-index-v4.json'); // v4: added trackNumber/discNumber
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) || {}; } catch (_) {}
    const nextCache = {};

    const musicMetadata = await getMusicMetadata();
    const out = [];
    let diskId = 0, fromXml = 0, fromDisk = 0, tagsRead = 0;

    for (const fp of files) {
      const ext = path.extname(fp).toLowerCase();
      const xt = xmlByPath.get(norm(fp));
      if (xt) {
        // File is present on disk right now, so recompute a live state (the XML
        // could have said 'missing' from an old location; it clearly exists).
        xt.state = ext === '.m4p' ? 'protected' : (xt.state === 'alac' ? 'alac' : 'playable');
        if (!xt.compilation && /\/Compilations\//.test(fp)) xt.compilation = true;
        out.push(xt);
        fromXml++;
        continue;
      }

      // A file the XML never indexed — read (or reuse cached) embedded tags.
      let stat;
      try { stat = fs.statSync(fp); } catch (_) { continue; }
      if (stat.size < 100 * 1024) continue;

      const c = cache[fp];
      let meta;
      if (c && c.mtimeMs === stat.mtimeMs && c.size === stat.size) {
        meta = c;
      } else {
        let tags;
        try {
          const md = await musicMetadata.parseFile(fp, { skipCovers: true, skipPostHeaders: true });
          const common = md.common || {};
          tags = {
            name: common.title || path.basename(fp, ext),
            artist: Array.isArray(common.artist) ? common.artist.join(', ') : (common.artist || ''),
            albumArtist: Array.isArray(common.albumartist) ? common.albumartist.join(', ') : (common.albumartist || ''),
            compilation: !!common.compilation,
            trackNumber: (common.track && common.track.no) || 0,
            discNumber: (common.disk && common.disk.no) || 0,
            album: common.album || '',
            duration: Math.round((md.format && md.format.duration) || 0),
            year: common.year || 0,
          };
        } catch (_) {
          tags = { name: path.basename(fp, ext), artist: '', albumArtist: '', compilation: false, trackNumber: 0, discNumber: 0, album: '', duration: 0, year: 0 };
        }
        meta = { ...tags, mtimeMs: stat.mtimeMs, size: stat.size, birthtimeMs: stat.birthtimeMs || stat.mtimeMs };
        tagsRead++;
      }
      nextCache[fp] = meta;

      out.push({
        id: 'd' + (diskId++),
        name: meta.name || 'Unknown',
        artist: meta.artist || '',
        albumArtist: meta.albumArtist || meta.artist || '',
        compilation: !!meta.compilation || /\/Compilations\//.test(fp),
        trackNumber: meta.trackNumber || 0,
        discNumber: meta.discNumber || 0,
        album: meta.album || '',
        duration: meta.duration || 0,
        path: fp,
        state: ext === '.m4p' ? 'protected' : 'playable', // ALAC still auto-transcodes server-side
        tuning: '440',
        rating: 0, playCount: 0, loved: false,
        dateAdded: meta.birthtimeMs || 0, // file creation time → "Recently Added" surfaces new adds
        lastPlayed: 0,
        year: meta.year || 0,
      });
      fromDisk++;
    }

    try { fs.writeFileSync(cachePath, JSON.stringify(nextCache)); } catch (_) {}

    return {
      ok: true, tracks: out, playlists, updatedAt, xmlPath, mediaDir,
      source: 'folder', stats: { total: out.length, fromXml, fromDisk, tagsRead },
    };
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
}

async function readTrackTags(filePath) {
  try {
    const musicMetadata = await getMusicMetadata();
    // skipPostHeaders: see comment in readTrackTags below — prevents legacy APEv2
    // trailer tags (common on old download-site MP3 rips) from overriding clean ID3v2 data.
    const metadata = await musicMetadata.parseFile(filePath, { skipCovers: true, skipPostHeaders: true });
    const common = metadata.common || {};

    return {
      title: common.title || '',
      artist: Array.isArray(common.artist) ? common.artist.join(', ') : common.artist || '',
      bpm: common.bpm || '',
      key: common.initialKey || common.key || '',
      genre: Array.isArray(common.genre) ? common.genre.join(', ') : common.genre || '',
      album: common.album || '',
      albumartist: Array.isArray(common.albumartist) ? common.albumartist.join(', ') : common.albumartist || '',
      composer: Array.isArray(common.composer) ? common.composer.join(', ') : common.composer || '',
      grouping: Array.isArray(common.grouping) ? common.grouping.join(', ') : common.grouping || '',
      duration: metadata.format.duration || 0,
    };
  } catch (error) {
    return { title: '', artist: '', bpm: '', key: '', genre: '', album: '', albumartist: '', composer: '', grouping: '', duration: 0 };
  }
}

// DIAGNOSTIC: temporary instrumentation to find why folder scans silently
// drop files. Logs an "imported" or "SKIPPED ... reason: ..." line for every
// file the walker sees, and tallies skip reasons per top-level scan-folder call.
function scanLog(msg) {
  console.log(`[M13 scan] ${msg}`);
}

// `cache` (optional): Map of path → previously-indexed track object. When a
// file's mtime+size match its cached entry, the cached tags are reused and the
// expensive readTrackTags call is skipped — this is what makes incremental
// re-indexing of a stable library near-instant. All skip guards still run.
async function scanFolderRecursively(folderPath, onProgress, tally, cache) {
  const results = [];

  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    scanLog(`SKIPPED folder: ${folderPath} - reason: does not exist or is not a directory`);
    return results;
  }

  // Never scan a PIONEER REC folder — recordings belong in the Sets view only.
  // This guards both the top-level call (user opened PIONEER REC directly) and
  // any recursive call that somehow reaches one nested deeper in the tree.
  if (path.basename(folderPath) === 'PIONEER REC') {
    return results;
  }

  let entries;
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch (err) {
    scanLog(`SKIPPED folder (readdir failed): ${folderPath} - reason: ${err.message}`);
    if (tally) tally.readdirErrors.push({ folderPath, error: err.message });
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name);

    try {
      if (entry.isDirectory()) {
        if (entry.name === 'PIONEER REC') continue; // recordings belong in Sets view only
        results.push(...(await scanFolderRecursively(fullPath, onProgress, tally, cache)));
        continue;
      }

      if (!entry.isFile()) {
        scanLog(`SKIPPED: ${fullPath} - reason: not a regular file (symlink/device/etc, isFile()=false)`);
        if (tally) tally.notAFile.push(fullPath);
        continue;
      }

      if (entry.name.startsWith('._')) {
        scanLog(`SKIPPED: ${fullPath} - reason: macOS AppleDouble resource-fork file (._ prefix)`);
        if (tally) tally.resourceFork.push(fullPath);
        continue;
      }

      if (!isAudioFile(entry.name)) {
        const ext = path.extname(entry.name).toLowerCase();
        scanLog(`SKIPPED: ${fullPath} - reason: unsupported extension "${ext}" (allowed: ${[...AUDIO_EXTENSIONS].join(', ')})`);
        if (tally) tally.unsupportedExt.push({ fullPath, ext });
        continue;
      }

      let stats;
      try {
        stats = fs.statSync(fullPath);
      } catch (err) {
        scanLog(`SKIPPED: ${fullPath} - reason: stat() failed - ${err.message} (likely broken symlink or permissions)`);
        if (tally) tally.statErrors.push({ fullPath, error: err.message });
        continue;
      }

      if (stats.size < 100 * 1024) {
        scanLog(`SKIPPED: ${fullPath} - reason: file too small (${stats.size} bytes < 100KB minimum)`);
        if (tally) tally.tooSmall.push({ fullPath, size: stats.size });
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();

      // Incremental fast path: unchanged since last index → reuse cached entry
      if (cache) {
        const hit = cache.get(fullPath);
        if (hit && hit.mtimeMs === stats.mtimeMs && hit.size === stats.size) {
          results.push(hit);
          if (tally) tally.cacheHits.push(fullPath);
          if (onProgress) onProgress(results.length);
          continue;
        }
      }

      let tags;
      try {
        tags = await readTrackTags(fullPath);
      } catch (err) {
        // readTrackTags has its own try/catch and shouldn't throw, but guard
        // anyway so a metadata-parser crash can't silently kill the whole scan.
        scanLog(`WARNING: ${fullPath} - tag read threw unexpectedly: ${err.message} - importing with blank tags`);
        if (tally) tally.tagReadErrors.push({ fullPath, error: err.message });
        tags = { title: '', artist: '', bpm: '', key: '', genre: '', album: '', albumartist: '', composer: '', grouping: '', duration: 0 };
      }

      results.push({
        // Prefer a real embedded title tag when present — falls back to the
        // filename only when there's no tag, so once Clean Up successfully
        // writes a title, the next scan sees it as already-clean instead of
        // re-deriving the same messy filename and re-suggesting the same fix.
        name: tags.title || path.basename(entry.name, ext),
        filename: entry.name,
        path: fullPath,
        folder: folderPath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ext,
        artist: tags.artist,
        album: tags.album,
        albumartist: tags.albumartist,
        composer: tags.composer,
        grouping: tags.grouping,
        bpm: tags.bpm,
        key: tags.key,
        genre: tags.genre,
        duration: tags.duration,
      });
      scanLog(`imported: ${fullPath}`);
      if (tally) tally.imported.push(fullPath);
      if (onProgress) onProgress(results.length);
    } catch (err) {
      // Catch-all so one bad entry (e.g. unexpected throw from fs calls) can't
      // silently abort the whole recursive walk and drop every file that would
      // have been processed afterward.
      scanLog(`SKIPPED: ${fullPath} - reason: unexpected error - ${err.message}`);
      if (tally) tally.unexpectedErrors.push({ fullPath, error: err.message, stack: err.stack });
    }
  }

  return results;
}

app.whenReady().then(() => {
  // Test builds only: verify the trial locks inside real Electron, then quit.
  if (!app.isPackaged && process.env.M13_SELFTEST === 'entitlement') {
    runEntitlementSelfTest().then((code) => app.exit(code));
    return;
  }
  if (!app.isPackaged && process.env.M13_SELFTEST === 'trial-flow') {
    runTrialFlowSelfTest().then((code) => app.exit(code));
    return;
  }
  if (!app.isPackaged && process.env.M13_SELFTEST === 'phase5') {
    runPhase5SelfTest().then((code) => app.exit(code));
    return;
  }

  app.setName('M13');
  Menu.setApplicationMenu(buildMenu());

  session.defaultSession.protocol.registerFileProtocol('file', (request, callback) => {
    const url = new URL(request.url);
    callback({ path: decodeURIComponent(url.pathname) });
  });

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = url.parse(req.url || '', true);
      const requestedPath = requestUrl.query.path;

      if (!requestedPath) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing path');
        return;
      }

      const filePath = decodeURIComponent(requestedPath);

      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      // stat() succeeds on a TCC-protected file but open() returns EPERM, so
      // probe readability up front — otherwise headers go out and the response
      // tears mid-body, which reads to the client as a corrupt file rather than
      // a permissions problem.
      try {
        fs.closeSync(fs.openSync(filePath, 'r'));
      } catch (err) {
        const code = (err && err.code) || 'EIO';
        res.writeHead(code === 'EPERM' || code === 'EACCES' ? 403 : 404, {
          'Content-Type': 'text/plain',
        });
        res.end(code === 'EPERM' || code === 'EACCES' ? 'Permission denied' : 'Read error');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();

      if (ext === '.aif' || ext === '.aiff') {
        streamAiffAsWav(filePath, req, res);
        return;
      }

      // ALAC .m4a needs real decoding (Chromium can't) — transcode & serve WAV.
      // AAC .m4a returns null here and falls through to the plain byte stream.
      if (ext === '.m4a') {
        try {
          const wav = await ensureAlacWav(filePath);
          if (wav) { serveFileWithRange(wav, req, res, 'audio/wav'); return; }
        } catch (_) { /* fall through and serve the original bytes */ }
      }

      const { size } = fs.statSync(filePath);
      const mimeType = getAudioMimeType(filePath);
      const range = req.headers.range;

      if (range) {
        const match = /bytes=(\d*)-(\d*)/.exec(range);
        const start = match && match[1] ? parseInt(match[1], 10) : 0;
        const end = match && match[2] ? parseInt(match[2], 10) : size - 1;

        if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) {
          res.writeHead(416, {
            'Content-Range': `bytes */${size}`,
          });
          res.end();
          return;
        }

        res.writeHead(206, {
          'Content-Type': mimeType,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        });

        serveReadStream(filePath, { start, end }, res).pipe(res);
        return;
      }

      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });

      serveReadStream(filePath, null, res).pipe(res);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
    }
  });

  function startAudioServer(port) {
    server.listen(port, '127.0.0.1', () => {
      audioPort = port;
      console.log(`Audio server listening on http://127.0.0.1:${port}`);
    });
  }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const nextPort = server.address() ? server.address().port + 1 : audioPort + 1;
      console.warn(`Port ${audioPort} in use, trying ${nextPort}`);
      audioPort = nextPort;
      server.close(() => startAudioServer(nextPort));
    } else {
      console.error('Audio server error:', err);
    }
  });

  startAudioServer(audioPort);

  createWindow();

  // Test builds only: screenshot the window after optional scripted steps, then quit.
  const uiSnap = !app.isPackaged ? { file: process.env.M13_UI_SNAPSHOT, actions: process.env.M13_UI_ACTIONS, size: process.env.M13_WINDOW_SIZE } : {};
  if (uiSnap.file) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        if (uiSnap.size) {
          const [w, h] = uiSnap.size.split('x').map(Number);
          if (w && h) mainWindow.setContentSize(w, h);
        }
        await wait(3500);
        if (uiSnap.actions) await mainWindow.webContents.executeJavaScript(uiSnap.actions);
        await wait(1200);
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(uiSnap.file, image.toPNG());
      } catch (err) {
        console.error('[ui snapshot]', err && err.message);
      }
      app.exit(0);
    });
  }

  // Day 13 → 14 can happen while M13 is open, and a Mac can sleep through it.
  setInterval(() => { refreshEntitlement().catch(() => {}); }, 15 * 60 * 1000);
  powerMonitor.on('resume', () => { refreshEntitlement().catch(() => {}); });

  // ── Auto-updater ──────────────────────────────────────────────────────────
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null; // suppress verbose logs in production

  autoUpdater.on('update-available', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', {
        version: info.version,
        releaseNotes: info.releaseNotes || '',
      });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-download-progress', {
        percent: Math.round(progress.percent),
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-downloaded', { version: info.version });
    }
  });

  autoUpdater.on('error', (err) => {
    // Silently ignore update errors in dev / no-network scenarios
    console.error('[M13 updater]', err.message);
  });

  // Check 3 seconds after launch so the window is fully loaded
  setTimeout(() => {
    if (app.isPackaged) {
      autoUpdater.checkForUpdates().catch(() => {});
    }
  }, 3000);

  ipcMain.handle('install-update', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle('check-for-updates-now', () => {
    if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {});
  });

  // ── USB volume watcher ────────────────────────────────────────────────────
  const VOLUMES_DIR = '/Volumes';
  let knownVolumes = new Set(fs.readdirSync(VOLUMES_DIR));

  function checkVolume(name) {
    const volPath = path.join(VOLUMES_DIR, name);
    try {
      if (!fs.existsSync(volPath) || !fs.statSync(volPath).isDirectory()) return null;
      const entries = fs.readdirSync(volPath);
      const hasMusic   = entries.includes('MUSIC') || entries.includes('Music');
      const hasPioneer = entries.includes('PIONEER');
      if (!hasMusic && !hasPioneer) return null;
      const musicFolder = entries.includes('MUSIC')
        ? path.join(volPath, 'MUSIC')
        : entries.includes('Music')
          ? path.join(volPath, 'Music')
          : null;
      return { name, volPath, musicFolder, hasPioneer };
    } catch {
      return null;
    }
  }

  fs.watch(VOLUMES_DIR, (eventType, filename) => {
    if (!filename) return;
    const now = new Set(fs.readdirSync(VOLUMES_DIR));

    // Mounted
    if (!knownVolumes.has(filename) && now.has(filename)) {
      knownVolumes = now;
      setTimeout(() => {  // brief delay so the volume finishes mounting
        const info = checkVolume(filename);
        if (info && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('volume-mounted', info);
        }
      }, 1200);
    }

    // Unmounted
    if (knownVolumes.has(filename) && !now.has(filename)) {
      knownVolumes = now;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('volume-unmounted', { name: filename });
      }
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('select-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select a folder',
  });

  if (canceled || filePaths.length === 0) {
    return null;
  }

  return filePaths[0];
});

ipcMain.handle('save-playlist-file', async (_event, { defaultName, content, filters }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: filters || [{ name: 'All Files', extensions: ['*'] }],
    properties: ['createDirectory'],
  });
  if (canceled || !filePath) return { canceled: true };
  fs.writeFileSync(filePath, content, 'utf8');
  return { filePath };
});

ipcMain.handle('select-dest-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Copy track to…',
    buttonLabel: 'Copy Here',
  });

  if (canceled || filePaths.length === 0) {
    return null;
  }

  return filePaths[0];
});

// Dedicated folder picker for the 432hz conversion flow — same as above but with
// wording that fits "save the converted file here" rather than "copy". Supports
// creating a new folder inline (macOS picker's New Folder button).
ipcMain.handle('select-convert-dest', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Save converted files to…',
    buttonLabel: 'Save Here',
  });

  if (canceled || filePaths.length === 0) {
    return null;
  }

  return filePaths[0];
});

// Opens a folder picker starting at defaultPath (falls back to home if invalid).
ipcMain.handle('select-folder-from', async (_event, defaultPath) => {
  const opts = {
    properties: ['openDirectory'],
    title: 'Select source folder',
    buttonLabel: 'Select',
  };
  if (defaultPath && fs.existsSync(defaultPath)) {
    opts.defaultPath = defaultPath;
  }
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, opts);
  return canceled || filePaths.length === 0 ? null : filePaths[0];
});

// ── Folder copy ───────────────────────────────────────────────────────────────
//
// Collects every audio file under srcFolder (preserving sub-folder structure),
// copies them to destFolder, and streams per-file + overall progress events.
// Original files are never moved or modified.

function collectAudioFilesRecursively(folderPath, baseFolder, results = []) {
  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) return results;
  if (path.basename(folderPath) === 'PIONEER REC') return results;  // safety guard

  let entries;
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'PIONEER REC') continue;
      collectAudioFilesRecursively(fullPath, baseFolder, results);
    } else if (entry.isFile() && !entry.name.startsWith('._') && isAudioFile(entry.name)) {
      results.push({
        srcPath: fullPath,
        // Relative path from the selected source folder, used to mirror structure
        relPath: path.relative(baseFolder, fullPath),
        size: (() => { try { return fs.statSync(fullPath).size; } catch { return 0; } })(),
      });
    }
  }
  return results;
}

ipcMain.handle('copy-folder', (event, { srcFolder, destFolder }) => {
  if (!srcFolder || !fs.existsSync(srcFolder) || !fs.statSync(srcFolder).isDirectory()) {
    return { success: false, error: 'Source folder not found.' };
  }
  if (!destFolder || !fs.existsSync(destFolder) || !fs.statSync(destFolder).isDirectory()) {
    return { success: false, error: 'Destination folder not found.' };
  }
  if (srcFolder.includes('PIONEER REC')) {
    return { success: false, error: 'Cannot copy from a PIONEER REC folder.' };
  }
  if (destFolder.includes('PIONEER REC')) {
    return { success: false, error: 'Cannot copy into a PIONEER REC folder.' };
  }
  if (srcFolder === destFolder || destFolder.startsWith(srcFolder + path.sep)) {
    return { success: false, error: 'Destination cannot be inside the source folder.' };
  }

  const files = collectAudioFilesRecursively(srcFolder, srcFolder);
  if (files.length === 0) {
    return { success: false, error: 'No audio files found in the selected folder.' };
  }

  const totalFiles = files.length;
  const totalBytes = files.reduce((s, f) => s + f.size, 0);

  // Mirror source folder name at the destination so files land in
  // e.g. /Volumes/USB2/MUSIC/Salted Music/ rather than /Volumes/USB2/MUSIC/
  const srcFolderName = path.basename(srcFolder);
  const rootDestFolder = path.join(destFolder, srcFolderName);

  return new Promise((resolve) => {
    let fileIndex     = 0;
    let totalTransferred = 0;
    let currentPartialPath = null;

    function sendProgress(filename, fileTransferred, fileSize) {
      if (event.sender.isDestroyed()) return;
      const overallTransferred = totalTransferred + fileTransferred;
      const pct = totalBytes > 0 ? Math.floor((overallTransferred / totalBytes) * 100) : 0;
      event.sender.send('folder-copy-progress', {
        fileIndex,
        totalFiles,
        filename,
        fileTransferred,
        fileSize,
        totalTransferred: overallTransferred,
        totalBytes,
        pct,
      });
    }

    function copyNext() {
      if (fileIndex >= totalFiles) {
        resolve({ success: true, totalFiles, totalBytes, destFolder: rootDestFolder });
        return;
      }

      const file = files[fileIndex];
      const destPath = path.join(rootDestFolder, file.relPath);
      currentPartialPath = destPath;

      // Ensure destination sub-directory exists
      const destDir = path.dirname(destPath);
      try {
        fs.mkdirSync(destDir, { recursive: true });
      } catch (mkdirErr) {
        resolve({ success: false, error: `Could not create folder: ${mkdirErr.message}` });
        return;
      }

      let fileTransferred = 0;
      let lastPct = -1;

      const srcStream  = fs.createReadStream(file.srcPath);
      const destStream = fs.createWriteStream(destPath);

      srcStream.on('data', (chunk) => {
        fileTransferred += chunk.length;
        const filePct = file.size > 0 ? Math.floor((fileTransferred / file.size) * 100) : 100;
        if (filePct !== lastPct) {
          lastPct = filePct;
          sendProgress(path.basename(file.srcPath), fileTransferred, file.size);
        }
      });

      const cleanup = (err) => {
        srcStream.destroy();
        destStream.destroy();
        try { if (currentPartialPath) fs.unlinkSync(currentPartialPath); } catch { /* ignore */ }
        resolve({ success: false, error: err.message });
      };

      srcStream.on('error', cleanup);
      destStream.on('error', cleanup);

      destStream.on('finish', () => {
        currentPartialPath = null;
        totalTransferred += file.size;
        fileIndex += 1;
        copyNext();
      });

      srcStream.pipe(destStream);
    }

    copyNext();
  });
});

ipcMain.handle('copy-track', (event, { srcPath, destFolder }) => {
  if (!srcPath || !fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) {
    return { success: false, error: 'Source file not found.' };
  }

  if (!destFolder || !fs.existsSync(destFolder) || !fs.statSync(destFolder).isDirectory()) {
    return { success: false, error: 'Destination folder not found.' };
  }

  const filename = path.basename(srcPath);
  const destPath = path.join(destFolder, filename);
  const total = fs.statSync(srcPath).size;

  return new Promise((resolve) => {
    let transferred = 0;
    let lastReportedPct = -1;

    const srcStream = fs.createReadStream(srcPath);
    const destStream = fs.createWriteStream(destPath);

    srcStream.on('data', (chunk) => {
      transferred += chunk.length;
      const pct = Math.floor((transferred / total) * 100);
      if (pct !== lastReportedPct) {
        lastReportedPct = pct;
        // Guard: window may have been closed mid-copy
        if (!event.sender.isDestroyed()) {
          event.sender.send('copy-progress', { transferred, total, pct });
        }
      }
    });

    const cleanup = (err) => {
      srcStream.destroy();
      destStream.destroy();
      // Remove partial destination file on error — never touch source
      try { fs.unlinkSync(destPath); } catch { /* ignore */ }
      resolve({ success: false, error: err.message });
    };

    srcStream.on('error', cleanup);
    destStream.on('error', cleanup);

    destStream.on('finish', () => {
      resolve({ success: true, destPath, filename });
    });

    srcStream.pipe(destStream);
  });
});

// Create a named subfolder inside parent (if it doesn't already exist), return its path.
ipcMain.handle('ensure-export-folder', (event, { parent, folderName }) => {
  try {
    const dest = path.join(parent, folderName);
    fs.mkdirSync(dest, { recursive: true });
    return dest;
  } catch (err) {
    console.error('ensure-export-folder error:', err);
    return null;
  }
});

// Copy track to dest folder with a numbered prefix filename.
// AIFF/WAV: rename only — never touch the audio data (node-id3 corrupts these).
// MP3: rename + write trackNumber ID3 tag to the copy.
// Set export with optional format conversion and/or 432hz shift — one ffmpeg
// pass per track, tags + artwork re-stamped with M13's own writers (same
// proven pipeline as convert-tuning). format: 'aiff'|'wav'|'mp3'|'flac'|null
// (null = keep the source format); to432 pitch-shifts down 31.77¢ tempo-intact.
const EXPORT_FORMAT_EXT = { aiff: '.aiff', wav: '.wav', mp3: '.mp3', flac: '.flac' };

ipcMain.handle('export-track-converted', async (_event, { srcPath, destFolder, trackNumber, format, to432 }) => {
  try {
    if (!srcPath || !fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) {
      return { success: false, error: 'Source file not found.' };
    }
    if (!destFolder || !fs.existsSync(destFolder) || !fs.statSync(destFolder).isDirectory()) {
      return { success: false, error: 'Destination folder not found.' };
    }
    const padded  = String(trackNumber).padStart(2, '0');
    const origExt = path.extname(srcPath).toLowerCase();
    const base    = path.basename(srcPath, path.extname(srcPath));
    const outExt  = (format && EXPORT_FORMAT_EXT[format]) || origExt;
    const destPath = path.join(destFolder, `${padded} - ${base}${to432 ? ' (432hz)' : ''}${outExt}`);

    // Fast path: no conversion at all → byte-perfect copy (existing behavior)
    if (!to432 && outExt === origExt) {
      fs.copyFileSync(srcPath, destPath);
      if (origExt === '.mp3') { try { NodeID3.update({ trackNumber: padded }, destPath); } catch { /* non-fatal */ } }
      return { success: true, destPath };
    }

    if (!_ffmpegPath || !fs.existsSync(_ffmpegPath)) return { success: false, error: 'ffmpeg unavailable.' };

    const musicMetadata = await getMusicMetadata();
    const meta = await musicMetadata.parseFile(srcPath, { skipCovers: false, skipPostHeaders: true });
    const common = meta.common || {};
    const sr = meta.format.sampleRate || 44100;
    const fields = {
      title:  common.title || base,
      artist: Array.isArray(common.artist) ? common.artist.join(', ') : (common.artist || ''),
      album:  common.album || '',
      genre:  Array.isArray(common.genre) ? common.genre.join(', ') : (common.genre || ''),
      year:   common.year ? String(common.year) : undefined,
      bpm:    common.bpm ? String(common.bpm) : undefined,
      key:    common.initialKey || common.key || undefined,
    };
    const cover = common.picture && common.picture[0];

    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', srcPath, '-map', '0:a', ...audioCodecArgs(outExt)];
    if (to432) {
      const ratio = 432 / 440;
      args.push('-filter:a', `asetrate=${Math.round(sr * ratio)},atempo=${(1 / ratio).toFixed(9)},aresample=${sr}`);
    }
    args.push(destPath);

    await new Promise((resolve, reject) => {
      const ff = spawn(_ffmpegPath, args);
      let stderr = '';
      ff.stderr.on('data', d => { stderr += d.toString(); });
      ff.on('error', reject);
      ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`)));
    });
    if (!fs.existsSync(destPath)) return { success: false, error: 'No output written.' };

    // Stamp tags with our own writers (ffmpeg drops ID3 for wav/aiff), then art.
    try {
      if (outExt === '.mp3') { saveMetadataId3(destPath, fields); NodeID3.update({ trackNumber: padded }, destPath); }
      else if (outExt === '.aiff' || outExt === '.aif') saveMetadataAiff(destPath, fields);
      else if (outExt === '.wav')  saveMetadataWav(destPath, fields);
      else if (outExt === '.flac') saveMetadataFlac(destPath, fields);
    } catch { /* tags failed — audio still valid */ }
    if (cover && cover.data) {
      try {
        const imageBuffer = Buffer.from(cover.data);
        const mime = cover.format || 'image/jpeg';
        if (outExt === '.mp3') NodeID3.update({ image: { mime, type: { id: 3, name: 'front cover' }, description: 'Cover', imageBuffer } }, destPath);
        else if (outExt === '.aiff' || outExt === '.aif') embedArtworkAiff(destPath, imageBuffer, mime);
        else if (outExt === '.flac') embedArtworkFlac(destPath, imageBuffer, mime);
      } catch { /* art failed — non-fatal */ }
    }
    return { success: true, destPath };
  } catch (err) {
    return { success: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('copy-track-numbered', (event, { srcPath, destFolder, trackNumber }) => {
  if (!srcPath || !fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) {
    return { success: false, error: 'Source file not found.' };
  }
  if (!destFolder || !fs.existsSync(destFolder) || !fs.statSync(destFolder).isDirectory()) {
    return { success: false, error: 'Destination folder not found.' };
  }

  const padded   = String(trackNumber).padStart(2, '0');
  const origName = path.basename(srcPath);
  const ext      = path.extname(origName).toLowerCase();
  const baseName = path.basename(origName, path.extname(origName));
  const newName  = `${padded} - ${baseName}${ext}`;
  const destPath = path.join(destFolder, newName);

  // Step 1 — byte-perfect copy, preserving every embedded tag and audio frame
  fs.copyFileSync(srcPath, destPath);

  // Step 2 — MP3 only: write trackNumber tag to the copy
  // AIFF and WAV are left untouched — the prefixed filename provides the order
  if (ext === '.mp3') {
    try {
      const result = NodeID3.update({ trackNumber: padded }, destPath);
      if (result instanceof Error) throw result;
    } catch (err) {
      console.warn('[M13] copy-track-numbered: ID3 write failed for', newName, err.message);
    }
  }

  console.log('[M13] Exported:', newName);
  return { success: true, destPath, filename: newName };
});

// ── Pioneer rekordbox PDB history parser ──────────────────────────────────────

function readDSString(buf, off) {
  if (off < 0 || off >= buf.length) return '';
  const kind = buf[off];
  if (!kind) return '';
  if (kind & 1) {
    // Short ASCII: the length is in the top 7 bits and includes the header byte
    const len = (kind >> 1) - 1;
    return buf.slice(off + 1, off + 1 + len).toString('ascii').replace(/\0/g, '');
  }
  // Long: kind, u16 length (includes this 4-byte header), a pad byte, then the text
  if ((kind !== 0x40 && kind !== 0x90) || off + 4 > buf.length) return '';
  const len = buf.readUInt16LE(off + 1) - 4;
  if (len <= 0) return '';
  return buf.slice(off + 4, off + 4 + len).toString(kind === 0x90 ? 'utf16le' : 'ascii').replace(/\0/g, '');
}

function getPdbRowOffsets(page) {
  const PAGE = 4096;
  if (page[27] & 0x40) return []; // index page — no rows
  // The row count is 13 bits: a history page holds more than 255 rows
  const numRows = page.readUInt16LE(24) & 0x1FFF;
  const ng = Math.ceil(numRows / 16);
  const rows = [];
  for (let g = 0; g < ng; g++) {
    const gOff = PAGE - (g + 1) * 36;
    if (gOff < 40) break;
    const present = page.readUInt16LE(gOff + 32); // one bit per row, cleared when the row is deleted
    for (let i = 0; i < 16; i++) {
      if (g * 16 + i >= numRows) continue;
      if (!((present >> i) & 1)) continue;
      const slot = 15 - i;
      const rOff = page.readUInt16LE(gOff + slot * 2);
      if (rOff !== 0xFFFF) rows.push({ row: g * 16 + i, absOff: 40 + rOff });
    }
  }
  return rows.sort((a, b) => a.absOff - b.absOff);
}

// Reads the four tables the history views need from one export.pdb
function readPDBTables(filePath) {
  const buf = fs.readFileSync(filePath);
  const PAGE = 4096;
  const numPages = Math.floor(buf.length / PAGE);
  const artists = new Map();
  const tracks = new Map();
  const histPlaylists = new Map();
  const histEntries = [];

  // Page 0 is the file header
  for (let pi = 1; pi < numPages; pi++) {
    const off = pi * PAGE;
    const ptype = buf.readUInt32LE(off + 8);
    const page = buf.slice(off, off + PAGE);

    if (ptype === 2) {
      // ARTISTS: id at row+4; the name's offset is a byte at row+9, or a u16 at row+10 on long-name rows (subtype bit 0x04)
      for (const { absOff } of getPdbRowOffsets(page)) {
        if (absOff + 12 > PAGE) continue;
        const id = page.readUInt32LE(absOff + 4);
        const nameOff = (page.readUInt16LE(absOff) & 0x04) ? page.readUInt16LE(absOff + 10) : page[absOff + 9];
        const name = readDSString(page, absOff + nameOff);
        if (id) artists.set(id, name);
      }
    } else if (ptype === 0) {
      // TRACKS: artist_id at +0x44 (+0x24 is ORIGINAL artist — fallback only), bpm*100 at +0x38, track_id at +0x48, title ptr at +0x80
      for (const { absOff: rs } of getPdbRowOffsets(page)) {
        if (rs + 0x88 > PAGE) continue;
        const artistId = page.readUInt32LE(rs + 0x44) || page.readUInt32LE(rs + 0x24);
        const bpm = page.readUInt32LE(rs + 0x38);
        const trackId = page.readUInt32LE(rs + 0x48);
        const titleOff = rs + page.readUInt16LE(rs + 0x80);
        const title = titleOff > rs && titleOff < PAGE ? readDSString(page, titleOff) : '';
        if (trackId) tracks.set(trackId, { title, artistId, bpm });
      }
    } else if (ptype === 11) {
      // HISTORY_PLAYLISTS: id at row+0, name at row+4
      for (const { absOff } of getPdbRowOffsets(page)) {
        if (absOff + 4 > PAGE) continue;
        const id = page.readUInt32LE(absOff);
        const name = readDSString(page, absOff + 4);
        if (id) histPlaylists.set(id, name);
      }
    } else if (ptype === 12) {
      // HISTORY_ENTRIES: 12-byte rows: track_id, playlist_id, entry_index
      for (const { absOff: rs } of getPdbRowOffsets(page)) {
        if (rs + 12 > PAGE) continue;
        const trackId = page.readUInt32LE(rs);
        const playlistId = page.readUInt32LE(rs + 4);
        const entryIndex = page.readUInt32LE(rs + 8);
        if (trackId) histEntries.push({ trackId, playlistId, entryIndex });
      }
    }
  }

  return { artists, tracks, histPlaylists, histEntries };
}

function parsePDB(filePath) {
  const { artists, tracks, histPlaylists, histEntries } = readPDBTables(filePath);

  histEntries.sort((a, b) => b.playlistId - a.playlistId || a.entryIndex - b.entryIndex);

  return histEntries.map(e => ({
    session: histPlaylists.get(e.playlistId) || `Session ${e.playlistId}`,
    playOrder: e.entryIndex,
    title: tracks.get(e.trackId)?.title || '',
    artist: artists.get(tracks.get(e.trackId)?.artistId) || '',
    bpm: tracks.get(e.trackId) ? (tracks.get(e.trackId).bpm / 100).toFixed(1) : '',
  }));
}

ipcMain.handle('scan-history', async () => {
  try {
    const results = [];
    const volumes = fs.readdirSync('/Volumes').filter(v => {
      try { return fs.statSync(`/Volumes/${v}`).isDirectory(); } catch { return false; }
    });
    for (const vol of volumes) {
      const pdbPath = `/Volumes/${vol}/PIONEER/rekordbox/export.pdb`;
      try {
        if (fs.existsSync(pdbPath)) {
          const entries = parsePDB(pdbPath);
          // Tag every session with its source drive — two USBs both have a
          // "HISTORY 001" and are indistinguishable without this.
          entries.forEach(e => { e.drive = vol; });
          results.push(...entries);
        }
      } catch (err) {
        console.warn(`[M13] PDB parse error for ${pdbPath}:`, err.message);
      }
    }
    return { success: true, entries: results };
  } catch (err) {
    return { success: false, error: err.message, entries: [] };
  }
});

// Returns all history sessions from all connected Pioneer USB drives, grouped
// by session, plus a bestMatch playlistId estimated from the set duration.
ipcMain.handle('match-history', async (_event, { filePath, duration }) => {
  try {
    // Collect all history data from every connected Pioneer USB
    const allArtists = new Map();
    const allTracks = new Map();
    const allHistPlaylists = new Map();
    const allHistEntries = [];

    const volumes = fs.readdirSync('/Volumes').filter(v => {
      try { return fs.statSync(`/Volumes/${v}`).isDirectory(); } catch { return false; }
    });

    for (const vol of volumes) {
      const pdbPath = `/Volumes/${vol}/PIONEER/rekordbox/export.pdb`;
      if (!fs.existsSync(pdbPath)) continue;
      try {
        // Re-use the low-level PDB read to get raw maps (not flattened entries)
        const t = readPDBTables(pdbPath);
        for (const [id, name] of t.artists) allArtists.set(id, name);
        for (const [id, track] of t.tracks) allTracks.set(id, track);
        for (const [id, name] of t.histPlaylists) allHistPlaylists.set(id, name);
        for (const e of t.histEntries) allHistEntries.push(e);
      } catch (err) {
        console.warn(`[M13] match-history PDB error for ${pdbPath}:`, err.message);
      }
    }

    // Group entries by session
    const sessionMap = new Map();
    for (const e of allHistEntries) {
      if (!sessionMap.has(e.playlistId)) sessionMap.set(e.playlistId, []);
      sessionMap.get(e.playlistId).push(e);
    }

    const sessions = [];
    for (const [playlistId, entries] of sessionMap) {
      entries.sort((a, b) => a.entryIndex - b.entryIndex);
      sessions.push({
        playlistId,
        session: allHistPlaylists.get(playlistId) || `Session ${playlistId}`,
        trackCount: entries.length,
        entries: entries.map(e => ({
          playOrder: e.entryIndex,
          title: allTracks.get(e.trackId)?.title || '',
          artist: allArtists.get(allTracks.get(e.trackId)?.artistId) || '',
          bpm: allTracks.get(e.trackId) ? (allTracks.get(e.trackId).bpm / 100).toFixed(1) : '',
        })),
      });
    }

    // Sort newest session first
    sessions.sort((a, b) => b.playlistId - a.playlistId);

    // Best-match heuristic: closest track count to estimated tracks from duration
    const AVG_TRACK_SECS = 390; // ~6.5 min average
    const estimatedTracks = Math.max(1, Math.round((duration || 0) / AVG_TRACK_SECS));
    let bestMatch = sessions[0]?.playlistId ?? null;
    let bestDelta = Infinity;
    for (const s of sessions) {
      const delta = Math.abs(s.trackCount - estimatedTracks);
      if (delta < bestDelta) { bestDelta = delta; bestMatch = s.playlistId; }
    }

    return { success: true, sessions, bestMatch };
  } catch (err) {
    return { success: false, error: err.message, sessions: [], bestMatch: null };
  }
});

ipcMain.handle('save-tracklist', (_event, { filePath, tracklist }) => {
  try {
    const filename = path.basename(filePath);
    const usbRoot  = usbRootFromRecordingPath(filePath);
    const driveData = readSetsJson(usbRoot);
    driveData[filename] = driveData[filename] || {};
    driveData[filename].tracklist = tracklist;
    writeSetsJson(usbRoot, driveData);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('scan-folder', async (_event, folderPath) => {
  if (!folderPath) return [];
  if (path.basename(folderPath) === 'PIONEER REC') return [];

  let last = 0;
  const onProgress = (count) => {
    if (count - last >= 10 && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scan-progress', count);
      last = count;
    }
  };

  const tally = {
    imported: [], unsupportedExt: [], resourceFork: [], notAFile: [],
    tooSmall: [], statErrors: [], readdirErrors: [], tagReadErrors: [], unexpectedErrors: [],
    cacheHits: [],
  };

  scanLog(`=== scan-folder start: ${folderPath} ===`);
  const results = await scanFolderRecursively(folderPath, onProgress, tally);
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('scan-progress', results.length);

  const skippedTotal = tally.unsupportedExt.length + tally.resourceFork.length + tally.notAFile.length +
    tally.tooSmall.length + tally.statErrors.length + tally.tagReadErrors.length + tally.unexpectedErrors.length;

  scanLog(`=== scan-folder summary: ${folderPath} ===`);
  scanLog(`  imported:            ${tally.imported.length}`);
  scanLog(`  unsupported ext:     ${tally.unsupportedExt.length}`);
  scanLog(`  resource fork (._):  ${tally.resourceFork.length}`);
  scanLog(`  not a regular file:  ${tally.notAFile.length}`);
  scanLog(`  too small (<100KB):  ${tally.tooSmall.length}`);
  scanLog(`  stat() errors:       ${tally.statErrors.length}`);
  scanLog(`  readdir() errors:    ${tally.readdirErrors.length}`);
  scanLog(`  tag-read errors:     ${tally.tagReadErrors.length} (imported anyway, blank tags)`);
  scanLog(`  unexpected errors:   ${tally.unexpectedErrors.length}`);
  scanLog(`  TOTAL skipped:       ${skippedTotal}`);

  if (tally.unsupportedExt.length) {
    const byExt = {};
    for (const { ext } of tally.unsupportedExt) byExt[ext] = (byExt[ext] || 0) + 1;
    scanLog(`  unsupported ext breakdown: ${JSON.stringify(byExt)}`);
  }
  if (tally.unexpectedErrors.length) {
    for (const e of tally.unexpectedErrors) scanLog(`  unexpected error detail: ${e.fullPath} -> ${e.error}`);
  }
  if (tally.statErrors.length) {
    for (const e of tally.statErrors) scanLog(`  stat error detail: ${e.fullPath} -> ${e.error}`);
  }

  return results;
});

const BANGERS_PATH = path.join(os.homedir(), 'M13', 'bangers.json');

ipcMain.handle('load-bangers', () => {
  try {
    if (!fs.existsSync(BANGERS_PATH)) return [];
    return JSON.parse(fs.readFileSync(BANGERS_PATH, 'utf8'));
  } catch { return []; }
});

ipcMain.handle('save-bangers', (_event, bangers) => {
  try {
    fs.mkdirSync(path.dirname(BANGERS_PATH), { recursive: true });
    fs.writeFileSync(BANGERS_PATH, JSON.stringify(bangers, null, 2), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Per-track state M13 owns itself: 0-5 rating and the loved flag, keyed by
// file path. Deliberately NOT written into audio tags and never pushed to
// Apple Music — the Apple XML is a read-only export, so anything we wrote
// there would be ignored and overwritten. Sits beside bangers.json so all of
// the user's own per-track marks live in one place.
//   { "/path/to/track.aiff": { "rating": 4, "loved": true } }
const TRACK_STATE_PATH = path.join(os.homedir(), 'M13', 'track-state.json');

ipcMain.handle('load-track-state', () => {
  try {
    if (!fs.existsSync(TRACK_STATE_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(TRACK_STATE_PATH, 'utf8'));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch { return {}; }
});

ipcMain.handle('save-track-state', (_event, state) => {
  try {
    fs.mkdirSync(path.dirname(TRACK_STATE_PATH), { recursive: true });
    // Write-then-rename: a crash mid-write can't leave a truncated file that
    // would silently lose every rating the user has ever set.
    const tmp = TRACK_STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, TRACK_STATE_PATH);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Unlike BANGERS_PATH (hardcoded into the home directory, shared by every
// app copy regardless of which one is running), this correctly uses
// Electron's per-app userData location — same pattern as CONFIG_PATH/license.
const MISSING_PATH = path.join(app.getPath('userData'), 'missing.json');

ipcMain.handle('load-missing', () => {
  try {
    if (!fs.existsSync(MISSING_PATH)) return [];
    return JSON.parse(fs.readFileSync(MISSING_PATH, 'utf8'));
  } catch { return []; }
});

ipcMain.handle('save-missing', (_event, missing) => {
  try {
    fs.writeFileSync(MISSING_PATH, JSON.stringify(missing, null, 2), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Permanently removed folders (browse-panel "Remove") ───────────────────────
// A persisted blocklist of folder paths the user has removed from the library.
// Files on disk are NEVER touched — the renderer hard-filters these out of the
// loaded library on every load. Whole registered locations use locations-remove
// instead; this covers sub-folders inside a still-registered location.
const REMOVED_FOLDERS_PATH = path.join(app.getPath('userData'), 'removed-folders.json');

ipcMain.handle('removed-folders-list', () => {
  try {
    if (!fs.existsSync(REMOVED_FOLDERS_PATH)) return [];
    const list = JSON.parse(fs.readFileSync(REMOVED_FOLDERS_PATH, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
});

ipcMain.handle('removed-folders-save', (_event, list) => {
  try {
    fs.writeFileSync(REMOVED_FOLDERS_PATH, JSON.stringify(Array.isArray(list) ? list : [], null, 2), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Tuning detection cache — { [path]: { tuning, mtimeMs } } — so a track's 432/440
// classification is computed once and reused on subsequent launches. Keyed with
// mtime so an edited/replaced file is re-detected rather than trusting a stale flag.
const TUNING_CACHE_PATH = path.join(app.getPath('userData'), 'tuning-cache.json');

ipcMain.handle('load-tuning-cache', () => {
  try {
    if (!fs.existsSync(TUNING_CACHE_PATH)) return {};
    return JSON.parse(fs.readFileSync(TUNING_CACHE_PATH, 'utf8'));
  } catch { return {}; }
});

ipcMain.handle('save-tuning-cache', (_event, cache) => {
  try {
    fs.writeFileSync(TUNING_CACHE_PATH, JSON.stringify(cache), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Ambient waveform peak cache ───────────────────────────────────────────────
// Decoding a track to peaks costs a few seconds of CPU, so the renderer caches
// the result here keyed by path + mtimeMs (same scheme as tuning-cache.json).
// Entries are tiny (~6KB: 3 bands x N columns of 0-255 bytes), so even a
// multi-thousand-track library stays trivial on disk.
const WAVEFORM_CACHE_PATH = path.join(app.getPath('userData'), 'waveform-cache.json');

// Native dialogs, menus and window chrome follow the OS appearance, not our
// CSS — so a light app on a dark Mac still gets dark alerts. Mirroring the
// renderer's Auto/Light/Dark choice onto nativeTheme keeps them consistent.
ipcMain.handle('set-native-theme', (_event, mode) => {
  try {
    nativeTheme.themeSource = (mode === 'light' || mode === 'dark') ? mode : 'system';
    return { ok: true, source: nativeTheme.themeSource };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('load-waveform-cache', () => {
  try {
    if (!fs.existsSync(WAVEFORM_CACHE_PATH)) return {};
    return JSON.parse(fs.readFileSync(WAVEFORM_CACHE_PATH, 'utf8'));
  } catch { return {}; }
});

ipcMain.handle('save-waveform-cache', (_event, cache) => {
  try {
    fs.writeFileSync(WAVEFORM_CACHE_PATH, JSON.stringify(cache), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('list-directory', (_event, dirPath) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const AUDIO_EXTS = new Set(['.aiff','.aif','.mp3','.wav','.flac','.m4a','.ogg','.opus','.alac']);
    let audioCount = 0;
    const dirs = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dirPath, e.name);
      if (e.isDirectory()) {
        dirs.push({ name: e.name, path: full });
      } else if (e.isFile() && AUDIO_EXTS.has(path.extname(e.name).toLowerCase())) {
        audioCount++;
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    return { dirs, audioCount };
  } catch { return { dirs: [], audioCount: 0 }; }
});

ipcMain.handle('scan-rekordbox', async (_event, { onlyVolumes } = {}) => {
  const dbPath = path.join(os.homedir(), 'Library', 'Pioneer', 'rekordbox', 'networkAnalyze6.db');
  if (!fs.existsSync(dbPath)) return { error: 'networkAnalyze6.db not found', tracks: [] };

  let db;
  try {
    const Database = require('better-sqlite3');
    db = new Database(dbPath, { readonly: true });
  } catch (e) {
    return { error: e.message, tracks: [] };
  }

  const rows = db.prepare('SELECT SongFilePath FROM manage_tbl ORDER BY SongFilePath').all();
  db.close();

  const AUDIO_EXTS = new Set(['.aiff', '.aif', '.mp3', '.wav', '.flac', '.m4a', '.ogg', '.opus', '.alac']);
  const results = [];

  for (const { SongFilePath } of rows) {
    if (!SongFilePath) continue;
    if (onlyVolumes && !SongFilePath.startsWith('/Volumes/')) continue;
    const ext = path.extname(SongFilePath).toLowerCase();
    if (!AUDIO_EXTS.has(ext)) continue;
    if (!fs.existsSync(SongFilePath)) continue;
    const stats = fs.statSync(SongFilePath);
    if (stats.size < 100 * 1024) continue;

    const tags = await readTrackTags(SongFilePath);
    results.push({
      name: tags.title || path.basename(SongFilePath, ext),
      filename: path.basename(SongFilePath),
      path: SongFilePath,
      folder: path.dirname(SongFilePath),
      size: stats.size,
      ext,
      artist: tags.artist,
      bpm: tags.bpm,
      key: tags.key,
      genre: tags.genre,
      albumartist: tags.albumartist,
      composer: tags.composer,
      grouping: tags.grouping,
    });
  }

  return { tracks: results };
});

ipcMain.handle('export-catalogue', (_event, { tracks, libraryFolder }) => {
  if (!libraryFolder) {
    return { success: false, error: 'No library folder is currently loaded.' };
  }
  if (libraryFolder !== 'rekordbox' && (!fs.existsSync(libraryFolder) || !fs.statSync(libraryFolder).isDirectory())) {
    return { success: false, error: 'Library folder no longer exists.' };
  }
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return { success: false, error: 'Library is empty — nothing to export.' };
  }

  // Walk up from the library path until we reach a direct child of /Volumes
  // (i.e. the USB drive root).  If the path is not under /Volumes at all,
  // fall back to the library folder itself.
  function usbRootFromPath(p) {
    const volumes = '/Volumes';
    let current = path.resolve(p);
    while (true) {
      const parent = path.dirname(current);
      if (parent === volumes) return current; // current is /Volumes/<drive>
      if (parent === current) return p;       // reached fs root without finding /Volumes
      current = parent;
    }
  }
  const saveFolder = usbRootFromPath(libraryFolder);
  const destPath   = path.join(saveFolder, 'M13_Library.txt');

  // Sort alphabetically by track name, case-insensitive
  const sorted = [...tracks].sort((a, b) =>
    (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase())
  );

  const totalBytes = sorted.reduce((sum, t) => sum + (t.size || 0), 0);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const pad = (str, len) => String(str ?? '').padEnd(len);
  const col = (str, len) => pad(String(str ?? '—').slice(0, len), len);

  function humanSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let v = bytes / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
  }

  const exportDate = new Date().toLocaleDateString('en-GB', {
    day: '2-digit', month: 'long', year: 'numeric',
  });

  // ── Build the text ────────────────────────────────────────────────────────
  const DIVIDER = '─'.repeat(110);
  const lines = [];

  lines.push('M13 Library Catalogue');
  lines.push(DIVIDER);
  lines.push(`Exported   : ${exportDate}`);
  lines.push(`Tracks     : ${sorted.length.toLocaleString()}`);
  lines.push(`Total size : ${humanSize(totalBytes)}`);
  lines.push(`Source     : ${libraryFolder}`);
  lines.push(DIVIDER);
  lines.push('');

  // Column header
  // Track(40) Artist(24) BPM(6) Key(6) Genre(14) Format(7) Size(9)
  lines.push(
    pad('TRACK', 40) +
    pad('ARTIST', 24) +
    pad('BPM', 6) +
    pad('KEY', 8) +
    pad('GENRE', 14) +
    pad('FORMAT', 8) +
    'SIZE'
  );
  lines.push(DIVIDER);

  for (const t of sorted) {
    lines.push(
      col(t.name,   40) +
      col(t.artist, 24) +
      col(t.bpm,     6) +
      col(t.key,     8) +
      col(t.genre,  14) +
      col((t.ext || '').replace('.', '').toUpperCase(), 8) +
      humanSize(t.size || 0)
    );
  }

  lines.push('');
  lines.push(DIVIDER);
  lines.push(`End of catalogue — ${sorted.length.toLocaleString()} tracks`);
  lines.push('');

  try {
    fs.writeFileSync(destPath, lines.join('\n'), 'utf8');
    return { success: true, destPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-audio-url', async (_event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) {
    return '';
  }

  return `http://127.0.0.1:${audioPort}/?path=${encodeURIComponent(filePath)}`;
});

// ── Add loose files to the library (managed "M13 Library" folder) ─────────────
// The library is folder-based; individual files are copied into ~/Music/M13
// Library (created + registered on first use) so a one-off download can be
// sampled without registering its whole source folder. Originals are untouched.
ipcMain.handle('library-add-files', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Add audio files to your library',
    buttonLabel: 'Add to Library',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'aif', 'aiff', 'm4a'] }],
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return { canceled: true };
  const destFolder = path.join(os.homedir(), 'Music', 'M13 Library');
  try { fs.mkdirSync(destFolder, { recursive: true }); }
  catch (e) { return { error: e.message }; }
  const skipped = [];
  let count = 0;
  for (const src of res.filePaths) {
    try {
      const ext = path.extname(src), base = path.basename(src, ext);
      let dest = path.join(destFolder, base + ext), n = 2;
      while (fs.existsSync(dest)) { dest = path.join(destFolder, `${base} (${n})${ext}`); n++; }
      fs.copyFileSync(src, dest);
      count++;
    } catch (e) { skipped.push(path.basename(src)); }
  }
  return { folder: destFolder, count, skipped };
});

// ── Apple Music section IPC (read-only, isolated from the DJ library) ──────────
ipcMain.handle('applemusic-load', async () => loadAppleLibraryMerged());

ipcMain.handle('applemusic-locate', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Locate your Music Library.xml',
    defaultPath: path.join(os.homedir(), 'Music', 'Music'),
    properties: ['openFile'],
    filters: [{ name: 'Music Library XML', extensions: ['xml'] }],
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { canceled: true };
  return parseAppleLibrary(res.filePaths[0]);
});

// ── 432hz tuning detection ───────────────────────────────────────────────────
//
// Classifies a track as A=432hz, A=440hz, or unknown from raw PCM sample
// windows decoded in the renderer (Chromium's codecs handle mp3/wav/aiff/flac
// for free; the Node main process has no audio decoder, so decode happens
// there and only small mono/downsampled windows cross IPC — see the renderer's
// detectTrackTuning()).
//
// Method (validated read-only against real studio tracks + pitch-shifted copies):
//
//  1. Low-pass each window (~250Hz) to isolate the BASSLINE. On dense polyphonic
//     music YIN returns null on ~99% of full-band frames (no single fundamental);
//     the bass is the most reliably monophonic, tuning-defining element, and
//     isolating it lifts usable readings from a handful to hundreds.
//  2. YIN gives a confident fundamental per short frame. We DON'T care about the
//     note — we fold each frequency onto the 440 equal-tempered grid and keep its
//     cents-deviation from the nearest semitone. A 440 bassline clusters near 0
//     cents; a 432 one near -31.8 ( = 1200*log2(432/440) ).
//  3. Aggregate with CIRCULAR statistics, not a plain median: deviations live on
//     a ring (mod 100 cents), so a linear median mis-handles readings straddling
//     the ±50 boundary. The circular mean gives the true centre, and the mean
//     resultant length R (0=diffuse, 1=perfectly concentrated) is our confidence.
//  4. Gate is deliberately CONSERVATIVE — needs enough readings AND concentrated
//     tuning AND the centre within ±12 cents of a target. Diffuse / atonal /
//     pitch-drifting (e.g. recorded DJ mixes) tracks fall to 'unknown' rather
//     than earn a wrong badge. False 440s are invisible; a false 432 is annoying.
const TUNING_432_CENTS     = 1200 * Math.log2(432 / 440); // ≈ -31.77
const TUNING_TARGET_WINDOW = 12;    // cents: how close the circular mean must sit to a target
const TUNING_MIN_READINGS  = 60;    // confident bass frames required to classify at all
const TUNING_MIN_R         = 0.35;  // circular concentration floor (cluster tightness)
const TUNING_BASS_CUTOFF   = 250;   // Hz: low-pass to isolate the bassline
const TUNING_FREQ_LO       = 55;    // Hz: plausible bass fundamental range
const TUNING_FREQ_HI       = 800;

function centsFrom440Grid(freqHz) {
  // total cents above A440, then deviation from the nearest equal-tempered semitone
  const cents = 1200 * Math.log2(freqHz / 440);
  const nearest = Math.round(cents / 100) * 100;
  return cents - nearest; // in (-50, 50]
}

// One-pole low-pass, applied per window (each window is contiguous audio).
function lowPass(samples, sampleRate, cutoffHz) {
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const a = dt / (rc + dt);
  const out = new Float32Array(samples.length);
  let y = 0;
  for (let i = 0; i < samples.length; i++) { y += a * (samples[i] - y); out[i] = y; }
  return out;
}

// Circular mean of cents-deviations (period 100). Returns { mean, R, n } where R
// is the mean resultant length in [0,1]. circularDist() is distance on the ring.
function circularStats(devs) {
  let sx = 0, sy = 0;
  for (const d of devs) { const a = (d / 100) * 2 * Math.PI; sx += Math.cos(a); sy += Math.sin(a); }
  const R = Math.sqrt(sx * sx + sy * sy) / devs.length;
  let mean = (Math.atan2(sy, sx) / (2 * Math.PI)) * 100;
  if (mean > 50) mean -= 100;
  if (mean < -50) mean += 100;
  return { mean, R, n: devs.length };
}
function circularDist(a, b) {
  let d = Math.abs(a - b) % 100;
  return d > 50 ? 100 - d : d;
}

function classifyTuning(windows, sampleRate) {
  const detectPitch = YIN({ sampleRate, threshold: 0.1 });
  const frameSize = 2048;
  const hop = 512;
  const deviations = [];

  for (const win of windows) {
    const raw = win instanceof Float32Array ? win : Float32Array.from(win);
    const samples = lowPass(raw, sampleRate, TUNING_BASS_CUTOFF);
    for (let i = 0; i + frameSize <= samples.length; i += hop) {
      const frame = samples.subarray(i, i + frameSize);
      // skip near-silent frames (RMS floor) — YIN returns noise on silence
      let sq = 0;
      for (let j = 0; j < frame.length; j++) sq += frame[j] * frame[j];
      if (Math.sqrt(sq / frame.length) < 0.01) continue;

      const f = detectPitch(frame);
      if (f && f >= TUNING_FREQ_LO && f <= TUNING_FREQ_HI) {
        deviations.push(centsFrom440Grid(f));
      }
    }
  }

  if (deviations.length < TUNING_MIN_READINGS) {
    return { tuning: 'unknown', reason: 'insufficient-readings', readings: deviations.length };
  }

  const { mean, R, n } = circularStats(deviations);
  let tuning = 'unknown';
  if (R >= TUNING_MIN_R) {
    if (circularDist(mean, 0) <= TUNING_TARGET_WINDOW) tuning = '440';
    else if (circularDist(mean, TUNING_432_CENTS) <= TUNING_TARGET_WINDOW) tuning = '432';
  }

  return {
    tuning,
    readings: n,
    meanCents: Math.round(mean * 10) / 10,
    R: Math.round(R * 100) / 100,
  };
}

ipcMain.handle('detect-tuning', async (_event, { windows, sampleRate }) => {
  try {
    if (!Array.isArray(windows) || !windows.length || !sampleRate) {
      return { tuning: 'unknown', reason: 'no-audio' };
    }
    return classifyTuning(windows, sampleRate);
  } catch (err) {
    return { tuning: 'unknown', reason: 'error', error: String(err && err.message || err) };
  }
});

// ── 432hz permanent conversion (Phase 3) ─────────────────────────────────────
// Non-destructive: ALWAYS writes a NEW file, never overwrites the original.
// Tempo-preserving pitch shift via bundled static ffmpeg. The static build has
// no librubberband, so we use the asetrate→atempo→aresample chain, which shifts
// pitch while restoring tempo and works in any ffmpeg build.
const { spawn } = require('child_process');

// ffmpeg-static resolves to a path inside the asar in a packaged app; the binary
// must be unpacked (see build.asarUnpack) and the path rewritten to reach it.
let _ffmpegPath = require('ffmpeg-static');
if (_ffmpegPath && _ffmpegPath.includes('app.asar') && !_ffmpegPath.includes('app.asar.unpacked')) {
  _ffmpegPath = _ffmpegPath.replace('app.asar', 'app.asar.unpacked');
}

function audioCodecArgs(ext) {
  switch (ext.toLowerCase()) {
    case '.aif':
    case '.aiff': return ['-c:a', 'pcm_s16be'];
    case '.wav':  return ['-c:a', 'pcm_s16le'];
    case '.flac': return ['-c:a', 'flac'];
    case '.mp3':  return ['-c:a', 'libmp3lame', '-b:a', '320k'];
    case '.m4a':  return ['-c:a', 'aac', '-b:a', '320k'];
    default:      return ['-c:a', 'pcm_s16le'];
  }
}

// Pick a new, non-colliding output path: "<base> (432hz).<ext>", suffixing a
// counter if that somehow already exists. Never returns an existing path.
// `destDir` overrides the folder (defaults to the source file's folder).
function tuningOutputPath(filePath, targetHz, destDir) {
  const dir = destDir && fs.existsSync(destDir) ? destDir : path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  let candidate = path.join(dir, `${base} (${targetHz}hz)${ext}`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${targetHz}hz) (${n})${ext}`);
    n++;
  }
  return candidate;
}

ipcMain.handle('convert-tuning', async (_event, { filePath, targetHz, destFolder }) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'file-not-found' };
    if (targetHz !== '432' && targetHz !== '440') return { ok: false, error: 'bad-target' };
    if (!_ffmpegPath || !fs.existsSync(_ffmpegPath)) return { ok: false, error: 'ffmpeg-missing' };

    // Read the ORIGINAL's tags + cover up front. ffmpeg's -map_metadata doesn't
    // reliably carry BPM/Key (it writes a RIFF INFO chunk for WAV that holds
    // neither), and mapping embedded art into a WAV/AIFF output actually fails
    // ("WAVE files have exactly one stream"). So we convert audio-only, then
    // stamp the full analysis back on with M13's own writers — the same ID3 that
    // M13 reads. BPM is unchanged (tempo preserved) and 32¢ is sub-semitone, so
    // the original's BPM/Key remain correct for the converted file.
    const musicMetadata = await getMusicMetadata();
    const meta = await musicMetadata.parseFile(filePath, { skipCovers: false, skipPostHeaders: true });
    const common = meta.common || {};
    const sr = meta.format.sampleRate || 44100;
    const origFields = {
      title:  common.title || path.basename(filePath, path.extname(filePath)),
      artist: Array.isArray(common.artist) ? common.artist.join(', ') : (common.artist || ''),
      album:  common.album || '',
      genre:  Array.isArray(common.genre) ? common.genre.join(', ') : (common.genre || ''),
      year:   common.year ? String(common.year) : undefined,
      bpm:    common.bpm ? String(common.bpm) : undefined,
      key:    common.initialKey || common.key || undefined,
    };
    const cover = common.picture && common.picture[0];

    // to sound like 432 → shift DOWN (ratio<1); to sound like 440 → shift UP.
    const ratio = targetHz === '432' ? 432 / 440 : 440 / 432;
    const asetrate = Math.round(sr * ratio);
    const atempo = 1 / ratio;
    const filter = `asetrate=${asetrate},atempo=${atempo.toFixed(9)},aresample=${sr}`;

    const ext = path.extname(filePath).toLowerCase();
    const outPath = tuningOutputPath(filePath, targetHz, destFolder);

    // Audio-only conversion — never maps a video/art stream, so it can't hit the
    // single-stream WAV/AIFF failure. Tags/art are restored below.
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', filePath,
      '-map', '0:a',
      ...audioCodecArgs(ext),
      '-filter:a', filter,
      outPath,
    ];

    await new Promise((resolve, reject) => {
      const ff = spawn(_ffmpegPath, args);
      let stderr = '';
      ff.stderr.on('data', d => { stderr += d.toString(); });
      ff.on('error', reject);
      ff.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
      });
    });

    if (!fs.existsSync(outPath)) return { ok: false, error: 'no-output-written' };

    // Stamp the original's analysis onto the new file with M13's writers so it
    // keeps BPM/Key/Genre/Year/Title/Artist/Album and stays in the Library
    // (not the RAW tab). Best-effort: a tag-write hiccup must not lose the file.
    try {
      if (ext === '.mp3')                         saveMetadataId3(outPath, origFields);
      else if (ext === '.aif' || ext === '.aiff') saveMetadataAiff(outPath, origFields);
      else if (ext === '.wav')                     saveMetadataWav(outPath, origFields);
      else if (ext === '.flac')                    saveMetadataFlac(outPath, origFields);
    } catch (e) { /* metadata stamp failed — file is still valid audio */ }

    // Re-embed artwork where the format supports it (WAV can't hold cover art).
    if (cover && cover.data) {
      try {
        const imageBuffer = Buffer.from(cover.data);
        const mime = cover.format || 'image/jpeg';
        if (ext === '.mp3') {
          NodeID3.update({ image: { mime, type: { id: 3, name: 'front cover' }, description: 'Cover', imageBuffer } }, outPath);
        } else if (ext === '.aif' || ext === '.aiff') {
          embedArtworkAiff(outPath, imageBuffer, mime);
        } else if (ext === '.flac') {
          embedArtworkFlac(outPath, imageBuffer, mime);
        }
      } catch (e) { /* art re-embed failed — non-fatal */ }
    }

    // Return the new file's mtime + known tuning so the renderer can seed the
    // detection cache authoritatively — we just MADE this file 432/440, so the
    // badge shouldn't depend on the conservative detector re-finding it.
    let mtimeMs = 0, size = 0;
    try { const st = fs.statSync(outPath); mtimeMs = st.mtimeMs; size = st.size; } catch {}
    return { ok: true, outPath, outName: path.basename(outPath), mtimeMs, size, tuning: targetHz };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

const CONFIG_PATH = path.join(app.getPath('userData'), 'm13-config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(data) {
  try {
    const current = loadConfig();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...current, ...data }, null, 2));
  } catch { /* ignore */ }
}

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('mark-version-seen', (_event, version) => {
  saveConfig({ lastSeenVersion: version });
});

// Library-table column layout — stored in m13-config.json alongside
// lastFolder / lastSeenVersion. `hiddenColumns` and `columnOrder` are arrays
// of column ids. (hiddenColumns predates columnOrder — both are optional.)
ipcMain.handle('load-column-config', () => {
  const config = loadConfig();
  return {
    hidden: Array.isArray(config.hiddenColumns) ? config.hiddenColumns : null,
    order:  Array.isArray(config.columnOrder)   ? config.columnOrder   : null,
    sort:   config.columnSort && typeof config.columnSort === 'object' ? config.columnSort : null,
  };
});

ipcMain.handle('save-column-config', (_event, payload) => {
  // Back-compat: a bare array is the old hidden-only format.
  if (Array.isArray(payload)) payload = { hidden: payload };
  const patch = {};
  if (Array.isArray(payload?.hidden)) patch.hiddenColumns = payload.hidden;
  if (Array.isArray(payload?.order))  patch.columnOrder   = payload.order;
  // sort: { column: string|null, dir: 'asc'|'desc' } — null column means "no sort"
  if (payload && 'sort' in payload)   patch.columnSort    = payload.sort || null;
  saveConfig(patch);
});

// ── Library Locations ─────────────────────────────────────────────────────────
// Persistent multi-source library. The registry lives in m13-config.json
// (`libraryLocations`); each location's scanned tracks are cached in their own
// library-index-<id>.json in userData (same pattern as tuning-cache.json).
// Re-indexing is incremental: unchanged files (mtime+size) reuse cached tags
// via scanFolderRecursively's cache fast-path, so stable libraries load fast.

// Session state (Part 6): sort/columns already persist via column-config;
// this carries the rest — search, filter pills, scroll position, last track.
ipcMain.handle('load-session-state', () => {
  const s = loadConfig().sessionState;
  return s && typeof s === 'object' ? s : null;
});
ipcMain.handle('save-session-state', (_event, state) => {
  saveConfig({ sessionState: state && typeof state === 'object' ? state : null });
});

// ── Sessions (Part 3) — named, saved FOLDER SCOPES (not playlists) ────────────
// Each is { id, name, folderPaths[], createdAt }. On list we annotate each with
// `missing` — folder paths that aren't currently reachable (drive offline /
// folder moved) — so the UI can flag them without failing to load the session.
function loadSessions() {
  const s = loadConfig().librarySessions;
  return Array.isArray(s) ? s : [];
}
function saveSessionsArr(arr) { saveConfig({ librarySessions: arr }); }

ipcMain.handle('sessions-list', () => {
  return loadSessions().map(s => ({
    ...s,
    missing: (Array.isArray(s.folderPaths) ? s.folderPaths : []).filter(p => {
      try { return !(fs.existsSync(p) && fs.statSync(p).isDirectory()); } catch { return true; }
    }),
  }));
});

ipcMain.handle('sessions-save', (_event, { name, folderPaths, excludedPaths, overwriteId }) => {
  const clean = (Array.isArray(folderPaths) ? folderPaths : []).filter(p => typeof p === 'string' && p);
  const cleanEx = (Array.isArray(excludedPaths) ? excludedPaths : []).filter(p => typeof p === 'string' && p);
  // A session needs a name and at least one rule — includes OR exclusions
  // ("everything except Eric Clapton" is a perfectly good session).
  if (!name || (!clean.length && !cleanEx.length)) return { ok: false, error: 'A session needs a name and at least one folder ticked or unticked.' };
  const sessions = loadSessions();
  // Overwrite path — updating an existing session keeps its id and slot.
  if (overwriteId) {
    const existing = sessions.find(s => s.id === overwriteId);
    if (!existing) return { ok: false, error: 'Session to overwrite not found.' };
    existing.name = String(name).trim().slice(0, 80);
    existing.folderPaths = clean;
    existing.excludedPaths = cleanEx;
    existing.updatedAt = Date.now();
    saveSessionsArr(sessions);
    return { ok: true, session: existing };
  }
  const session = {
    id: 'ses_' + crypto.randomBytes(4).toString('hex'),
    name: String(name).trim().slice(0, 80),
    folderPaths: clean,
    excludedPaths: cleanEx,
    createdAt: Date.now(),
  };
  sessions.push(session);
  saveSessionsArr(sessions);
  return { ok: true, session };
});

ipcMain.handle('sessions-delete', (_event, id) => {
  const sessions = loadSessions();
  const idx = sessions.findIndex(s => s.id === id);
  if (idx === -1) return { ok: false, error: 'Session not found.' };
  sessions.splice(idx, 1);
  saveSessionsArr(sessions);
  return { ok: true };
});

// ── Crates — saved Set Builder queues ────────────────────────────────────────
// A crate is a named, ORDERED list of track paths (order is the running order).
// Paths only — tracks resolve against the live library on load, so tags/
// analysis are always current and the config entry stays tiny.
function loadCrates() {
  const c = loadConfig().crates;
  return Array.isArray(c) ? c : [];
}
function saveCratesArr(arr) { saveConfig({ crates: arr }); }

ipcMain.handle('crates-list', () => loadCrates());

ipcMain.handle('crates-save', (_event, { name, trackPaths, overwriteId }) => {
  const clean = (Array.isArray(trackPaths) ? trackPaths : []).filter(p => typeof p === 'string' && p);
  if (!name || !clean.length) return { ok: false, error: 'A crate needs a name and at least one track.' };
  const crates = loadCrates();
  if (overwriteId) {
    const existing = crates.find(c => c.id === overwriteId);
    if (!existing) return { ok: false, error: 'Crate to overwrite not found.' };
    existing.name = String(name).trim().slice(0, 80);
    existing.trackPaths = clean;
    existing.updatedAt = Date.now();
    saveCratesArr(crates);
    return { ok: true, crate: existing };
  }
  const crate = {
    id: 'crate_' + crypto.randomBytes(4).toString('hex'),
    name: String(name).trim().slice(0, 80),
    trackPaths: clean,
    createdAt: Date.now(),
  };
  crates.push(crate);
  saveCratesArr(crates);
  return { ok: true, crate };
});

// Native multi-button chooser — window.confirm can only express two options,
// which made the crate-load Replace/Append flow ambiguous. Returns the index
// of the pressed button (cancelId when dismissed).
ipcMain.handle('choose-option', async (_event, { message, detail, buttons, defaultId = 0, cancelId }) => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    message: String(message || ''),
    detail: detail ? String(detail) : undefined,
    buttons: Array.isArray(buttons) && buttons.length ? buttons.map(String) : ['OK'],
    defaultId,
    cancelId: typeof cancelId === 'number' ? cancelId : (buttons ? buttons.length - 1 : 0),
    noLink: true,
  });
  return response;
});

ipcMain.handle('crates-delete', (_event, id) => {
  const crates = loadCrates();
  const idx = crates.findIndex(c => c.id === id);
  if (idx === -1) return { ok: false, error: 'Crate not found.' };
  crates.splice(idx, 1);
  saveCratesArr(crates);
  return { ok: true };
});

function loadLocations() {
  const config = loadConfig();
  return Array.isArray(config.libraryLocations) ? config.libraryLocations : [];
}

function saveLocations(locations) {
  saveConfig({ libraryLocations: locations });
}

function locationIndexPath(id) {
  // id is always generated by us (loc_<hex>), but sanitise anyway
  return path.join(app.getPath('userData'), `library-index-${String(id).replace(/[^\w-]/g, '')}.json`);
}

function readLocationIndex(id) {
  try {
    const raw = JSON.parse(fs.readFileSync(locationIndexPath(id), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

// Atomic write (tmp + rename) so a crash mid-write can't corrupt an index.
function writeLocationIndex(id, tracks) {
  const dest = locationIndexPath(id);
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(tracks), 'utf8');
  fs.renameSync(tmp, dest);
}

function locationOnline(loc) {
  try { return fs.existsSync(loc.path) && fs.statSync(loc.path).isDirectory(); }
  catch { return false; }
}

function deriveLocationName(folderPath) {
  // Prefer the volume name for external drives, else the folder's own name.
  const parts = path.resolve(folderPath).split(path.sep).filter(Boolean);
  if (parts[0] === 'Volumes' && parts.length >= 2) return parts[1];
  return path.basename(folderPath) || folderPath;
}

function locationStatus(loc) {
  return { ...loc, online: locationOnline(loc) };
}

// Full or incremental (re)index of one ONLINE location. Returns
// { tracks, missing } — `missing` = files present in the previous index but no
// longer on the (connected) drive, i.e. genuinely deleted at source (Part 7).
async function indexLocation(loc, { incremental = true, onProgress } = {}) {
  const previous = readLocationIndex(loc.id);
  const cache = incremental
    ? new Map(previous.map(t => [t.path, t]))
    : null;

  const tally = {
    imported: [], unsupportedExt: [], resourceFork: [], notAFile: [],
    tooSmall: [], statErrors: [], readdirErrors: [], tagReadErrors: [], unexpectedErrors: [],
    cacheHits: [],
  };
  scanLog(`=== index location start: ${loc.name} (${loc.path}) incremental=${incremental} ===`);
  const results = await scanFolderRecursively(loc.path, onProgress, tally, cache);
  results.forEach(t => { t.locationId = loc.id; });
  scanLog(`=== index location done: ${loc.name} — ${results.length} tracks (${tally.cacheHits.length} from cache) ===`);

  // Deletion detection: indexed before, drive connected, file gone now.
  const seen = new Set(results.map(t => t.path));
  const missing = previous.filter(t => !seen.has(t.path));

  writeLocationIndex(loc.id, results);
  const locations = loadLocations();
  const entry = locations.find(l => l.id === loc.id);
  if (entry) {
    entry.lastIndexed = Date.now();
    entry.trackCount = results.length;
    saveLocations(locations);
  }
  return { tracks: results, missing };
}

ipcMain.handle('locations-list', () => loadLocations().map(locationStatus));

ipcMain.handle('locations-add', async (_event, folderPath) => {
  try {
    if (!folderPath || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
      return { ok: false, error: 'Folder not found.' };
    }
    const resolved = path.resolve(folderPath);
    const locations = loadLocations();
    // Reject nesting in either direction — a track must belong to exactly one location.
    const withSep = p => p.endsWith(path.sep) ? p : p + path.sep;
    for (const l of locations) {
      const existing = path.resolve(l.path);
      // These aren't failures so much as "you already have this" — say what
      // that means and what to do instead, rather than a dead-end error.
      if (existing === resolved) {
        return { ok: false, alreadyIndexed: true, locationName: l.name,
          error: `This folder is already your "${l.name}" library location — its tracks are already in your library.` };
      }
      if (withSep(resolved).startsWith(withSep(existing))) {
        return { ok: false, alreadyIndexed: true, locationName: l.name,
          error: `These tracks are already in your library — this folder sits inside your "${l.name}" location, so it's already indexed.\n\nTo work with just this folder, tick it in the Browse sidebar to scope to it (and save that as a session).` };
      }
      if (withSep(existing).startsWith(withSep(resolved))) {
        return { ok: false, error: `This folder contains your existing location "${l.name}". Remove "${l.name}" from Library Locations first, then add this parent folder.` };
      }
    }
    const loc = {
      id: 'loc_' + crypto.randomBytes(4).toString('hex'),
      name: deriveLocationName(resolved),
      path: resolved,
      lastIndexed: null,
      trackCount: 0,
    };
    locations.push(loc);
    saveLocations(locations);

    const onProgress = _makeScanProgressSender();
    const { tracks } = await indexLocation(loc, { incremental: false, onProgress });
    return { ok: true, location: locationStatus(loadLocations().find(l => l.id === loc.id) || loc), tracks };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('locations-remove', (_event, id) => {
  const locations = loadLocations();
  const idx = locations.findIndex(l => l.id === id);
  if (idx === -1) return { ok: false, error: 'Location not found.' };
  locations.splice(idx, 1);
  saveLocations(locations);
  try { fs.unlinkSync(locationIndexPath(id)); } catch { /* index may not exist */ }
  return { ok: true };
});

ipcMain.handle('locations-rescan', async (_event, id) => {
  try {
    const loc = loadLocations().find(l => l.id === id);
    if (!loc) return { ok: false, error: 'Location not found.' };
    if (!locationOnline(loc)) return { ok: false, error: `"${loc.name}" is not connected.` };
    const onProgress = _makeScanProgressSender();
    const { tracks, missing } = await indexLocation(loc, { incremental: false, onProgress });
    return { ok: true, tracks, missing, location: locationStatus(loadLocations().find(l => l.id === id) || loc) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// The unified startup load: every registered location, merged in registry
// order. Online locations are incrementally re-indexed (fast on stable
// libraries); offline locations serve their cached index with offline=true so
// their tracks grey out instead of vanishing.
ipcMain.handle('library-load', async () => {
  let locations = loadLocations();

  // One-time migration from the single-folder era: no registered locations but
  // a lastFolder from the previous version → register it automatically so the
  // user's library carries straight over. lastFolder itself is left in config
  // (harmless) but is no longer read after this.
  if (!locations.length) {
    const config = loadConfig();
    const lf = config.lastFolder;
    if (lf && lf !== 'rekordbox' && fs.existsSync(lf) && fs.statSync(lf).isDirectory()) {
      locations = [{
        id: 'loc_' + crypto.randomBytes(4).toString('hex'),
        name: deriveLocationName(lf),
        path: path.resolve(lf),
        lastIndexed: null,
        trackCount: 0,
      }];
      saveLocations(locations);
      scanLog(`=== migrated lastFolder to library location: ${lf} ===`);
    }
  }
  const allTracks = [];
  const allMissing = [];
  const statuses = [];
  let progressBase = 0;
  for (const loc of locations) {
    const online = locationOnline(loc);
    if (online) {
      const base = progressBase;
      const onProgress = _makeScanProgressSender(base);
      try {
        const { tracks, missing } = await indexLocation(loc, { incremental: true, onProgress });
        tracks.forEach(t => { t.offline = false; });
        allTracks.push(...tracks);
        missing.forEach(t => allMissing.push({ ...t, locationName: loc.name }));
        progressBase += tracks.length;
      } catch (err) {
        scanLog(`ERROR indexing ${loc.name}: ${err.message} — serving cached index`);
        const cached = readLocationIndex(loc.id);
        cached.forEach(t => { t.offline = false; t.locationId = loc.id; });
        allTracks.push(...cached);
        progressBase += cached.length;
      }
    } else {
      const cached = readLocationIndex(loc.id);
      cached.forEach(t => { t.offline = true; t.locationId = loc.id; });
      allTracks.push(...cached);
      progressBase += cached.length;
    }
    statuses.push({ ...locationStatus(loc), online });
  }
  return { tracks: allTracks, locations: statuses, missing: allMissing };
});

// Throttled scan-progress sender shared by the location scans — same channel
// and cadence the old scan-folder handler used, so the renderer UI is reused.
function _makeScanProgressSender(base = 0) {
  let last = 0;
  return (count) => {
    const total = base + count;
    if (total - last >= 25 || total < 25) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scan-progress', total);
      }
      last = total;
    }
  };
}

ipcMain.handle('get-artwork', async (_event, filePath) => {
  if (!filePath) return null;
  try {
    const musicMetadata = await getMusicMetadata();
    const metadata = await musicMetadata.parseFile(filePath, { skipCovers: false, skipPostHeaders: true });
    const cover = metadata.common.picture?.[0];
    if (!cover) return null;
    const b64 = Buffer.from(cover.data).toString('base64');
    return `data:${cover.format};base64,${b64}`;
  } catch {
    return null;
  }
});

ipcMain.handle('get-last-folder', () => {
  const config = loadConfig();
  const folder = config.lastFolder;
  if (folder && fs.existsSync(folder) && fs.statSync(folder).isDirectory()) {
    return folder;
  }
  return null;
});

ipcMain.handle('save-last-folder', (_event, folderPath) => {
  saveConfig({ lastFolder: folderPath });
});

ipcMain.handle('get-metadata', async (_event, filePath) => {
  if (!filePath) {
    return {};
  }

  try {
    const musicMetadata = await getMusicMetadata();
    const metadata = await musicMetadata.parseFile(filePath, { skipCovers: true, skipPostHeaders: true });
    const common = metadata.common || {};

    return {
      artist: Array.isArray(common.artist) ? common.artist.join(', ') : common.artist || '',
      bpm: common.bpm ? String(common.bpm) : '',
      genre: Array.isArray(common.genre) ? common.genre.join(', ') : common.genre || '',
      key: common.initialKey || common.key || '',
      title: common.title || path.basename(filePath),
      album: common.album || '',
      year: common.year ? String(common.year) : '',
    };
  } catch (error) {
    return {};
  }
});

// ── Metadata writing ──────────────────────────────────────────────────────────

const NodeID3 = require('node-id3');

// node-id3 only genuinely understands MP3 (a raw ID3v2 tag prepended to an
// MPEG stream) — it has zero RIFF/WAVE or FORM/AIFF chunk awareness. It's
// safe for real MP3 files only.
function saveMetadataId3(filePath, fields) {
  const tags = buildId3Tags(fields);
  const result = NodeID3.update(tags, filePath);
  if (result instanceof Error) throw result;
}

function buildId3Tags(fields) {
  const tags = {};
  if (fields.title  !== undefined) tags.title      = fields.title;
  if (fields.artist !== undefined) tags.artist     = fields.artist;
  if (fields.album  !== undefined) tags.album      = fields.album;
  if (fields.year   !== undefined) tags.year       = fields.year;
  if (fields.genre  !== undefined) tags.genre      = fields.genre;
  if (fields.bpm    !== undefined) tags.bpm        = fields.bpm;
  if (fields.key    !== undefined) tags.initialKey = fields.key;
  return tags;
}

// Builds a new ID3 tag buffer that preserves every existing frame from
// `existingId3Buffer` (if any) and overlays `overrides` on top — so a
// partial write (e.g. Clean Up sending only {title}) never wipes BPM/Key/
// Genre/Year/artwork that were already there. NodeID3.update() does this
// merge for real MP3s automatically (it reads the file's current tags
// before writing); chunk-based AIFF/WAV writes have to do it explicitly
// since they build the tag buffer themselves via NodeID3.create().
function mergeId3Tags(existingId3Buffer, overrides) {
  let existing = {};
  if (existingId3Buffer) {
    try {
      existing = NodeID3.read(existingId3Buffer) || {};
    } catch {
      existing = {};
    }
  }
  return NodeID3.create({ ...existing, ...overrides });
}

// Parses the top-level chunk list of an IFF-style container (AIFF or RIFF/WAV)
// starting at `offset`. `sizeReader` differs between formats: AIFF chunk
// sizes are big-endian, RIFF/WAV chunk sizes are little-endian. Stops (rather
// than throwing) on a truncated/malformed trailing chunk, keeping everything
// safely parsed up to that point — same defensive philosophy as the FLAC
// block parser.
function parseIffChunks(buf, offset, sizeReader) {
  const chunks = [];
  while (offset + 8 <= buf.length) {
    const id     = buf.toString('ascii', offset, offset + 4);
    const size   = sizeReader(buf, offset + 4);
    const start  = offset + 8;
    const padded = size + (size % 2); // chunks are word-aligned; pad byte isn't counted in size
    if (start + padded > buf.length) break;
    chunks.push({ id, start: offset, totalLen: 8 + padded });
    offset = start + padded;
  }
  return chunks;
}

// AIFF stores metadata in a dedicated "ID3 " chunk inside the FORM/AIFF
// container (the convention music-metadata, Mp3Tag, etc. all read) — never
// as a raw prepended ID3v2 tag, which destroys the FORM header (the node-id3
// bug this replaces; confirmed it rewrites a real AIFF's container type to
// "MPEG" and loses duration entirely). Every other chunk — including SSND,
// the actual audio data — is carried over byte-for-byte untouched.
function saveMetadataAiff(filePath, fields) {
  const buf = fs.readFileSync(filePath);

  if (buf.toString('ascii', 0, 4) !== 'FORM') {
    throw new Error('Not a valid AIFF file (missing FORM header).');
  }
  const formType = buf.toString('ascii', 8, 12);
  if (formType !== 'AIFF' && formType !== 'AIFC') {
    throw new Error('Not a valid AIFF file (unexpected FORM type).');
  }

  const chunks = parseIffChunks(buf, 12, (b, off) => b.readUInt32BE(off));
  const existingChunk = chunks.find(c => c.id === 'ID3 ');
  const kept = chunks.filter(c => c.id !== 'ID3 ');

  const existingId3 = existingChunk
    ? buf.subarray(existingChunk.start, existingChunk.start + existingChunk.totalLen).subarray(8)
    : null;

  const id3Buffer = mergeId3Tags(existingId3, buildId3Tags(fields));
  const id3Padded = id3Buffer.length % 2 === 0 ? id3Buffer : Buffer.concat([id3Buffer, Buffer.alloc(1)]);
  const id3Size   = Buffer.alloc(4);
  id3Size.writeUInt32BE(id3Buffer.length, 0);
  const id3Chunk  = Buffer.concat([Buffer.from('ID3 ', 'ascii'), id3Size, id3Padded]);

  const body = Buffer.concat([...kept.map(c => buf.subarray(c.start, c.start + c.totalLen)), id3Chunk]);

  const formSize = Buffer.alloc(4);
  formSize.writeUInt32BE(4 + body.length, 0); // +4 for the "AIFF"/"AIFC" type marker

  const newFile = Buffer.concat([Buffer.from('FORM', 'ascii'), formSize, Buffer.from(formType, 'ascii'), body]);
  fs.writeFileSync(filePath, newFile);
}

// WAV stores metadata in a dedicated "ID3 " chunk inside the RIFF/WAVE
// container — same convention as AIFF, just little-endian chunk sizes (RIFF's
// native byte order, vs AIFF's big-endian). Accepts an existing chunk in
// either "ID3 " or "id3 " casing (both are used in the wild) when replacing.
function saveMetadataWav(filePath, fields) {
  const buf = fs.readFileSync(filePath);

  if (buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('Not a valid WAV file (missing RIFF header).');
  }
  const riffType = buf.toString('ascii', 8, 12);
  if (riffType !== 'WAVE') {
    throw new Error('Not a valid WAV file (unexpected RIFF type).');
  }

  const chunks = parseIffChunks(buf, 12, (b, off) => b.readUInt32LE(off));
  const existingChunk = chunks.find(c => c.id === 'ID3 ' || c.id === 'id3 ');
  const kept = chunks.filter(c => c.id !== 'ID3 ' && c.id !== 'id3 ');
  const existingId3 = existingChunk
    ? buf.subarray(existingChunk.start, existingChunk.start + existingChunk.totalLen).subarray(8)
    : null;

  const id3Buffer = mergeId3Tags(existingId3, buildId3Tags(fields));
  const id3Padded = id3Buffer.length % 2 === 0 ? id3Buffer : Buffer.concat([id3Buffer, Buffer.alloc(1)]);
  const id3Size   = Buffer.alloc(4);
  id3Size.writeUInt32LE(id3Buffer.length, 0);
  const id3Chunk  = Buffer.concat([Buffer.from('ID3 ', 'ascii'), id3Size, id3Padded]);

  const body = Buffer.concat([...kept.map(c => buf.subarray(c.start, c.start + c.totalLen)), id3Chunk]);

  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(4 + body.length, 0); // +4 for the "WAVE" type marker

  const newFile = Buffer.concat([Buffer.from('RIFF', 'ascii'), riffSize, Buffer.from('WAVE', 'ascii'), body]);
  fs.writeFileSync(filePath, newFile);
}

// Same "ID3 " chunk approach as saveMetadataAiff, but for embedding cover
// art specifically (the embed-artwork handler was still calling
// NodeID3.update() directly on AIFF files — the exact same corruption bug,
// just reached via a different feature).
function embedArtworkAiff(filePath, imageBuffer, mime) {
  const buf = fs.readFileSync(filePath);

  if (buf.toString('ascii', 0, 4) !== 'FORM') {
    throw new Error('Not a valid AIFF file (missing FORM header).');
  }
  const formType = buf.toString('ascii', 8, 12);
  if (formType !== 'AIFF' && formType !== 'AIFC') {
    throw new Error('Not a valid AIFF file (unexpected FORM type).');
  }

  const chunks = parseIffChunks(buf, 12, (b, off) => b.readUInt32BE(off));
  const existingChunk = chunks.find(c => c.id === 'ID3 ');
  const kept = chunks.filter(c => c.id !== 'ID3 ');
  const existingId3 = existingChunk
    ? buf.subarray(existingChunk.start, existingChunk.start + existingChunk.totalLen).subarray(8)
    : null;

  const id3Buffer = mergeId3Tags(existingId3, {
    image: { mime, type: { id: 3, name: 'front cover' }, description: 'Cover', imageBuffer },
  });
  const id3Padded = id3Buffer.length % 2 === 0 ? id3Buffer : Buffer.concat([id3Buffer, Buffer.alloc(1)]);
  const id3Size   = Buffer.alloc(4);
  id3Size.writeUInt32BE(id3Buffer.length, 0);
  const id3Chunk  = Buffer.concat([Buffer.from('ID3 ', 'ascii'), id3Size, id3Padded]);

  const body = Buffer.concat([...kept.map(c => buf.subarray(c.start, c.start + c.totalLen)), id3Chunk]);

  const formSize = Buffer.alloc(4);
  formSize.writeUInt32BE(4 + body.length, 0);

  const newFile = Buffer.concat([Buffer.from('FORM', 'ascii'), formSize, Buffer.from(formType, 'ascii'), body]);
  fs.writeFileSync(filePath, newFile);
}

// FLAC stores metadata as Vorbis Comments — plain UTF-8 KEY=VALUE pairs inside
// a METADATA_BLOCK_VORBIS_COMMENT block.  We rewrite only that block in-place,
// preserving the STREAMINFO block and all audio frames untouched.
function saveMetadataFlac(filePath, fields) {
  const buf = fs.readFileSync(filePath);

  if (buf.toString('ascii', 0, 4) !== 'fLaC') {
    throw new Error('Not a valid FLAC file.');
  }

  // Parse all metadata block headers so we know their positions.
  const blocks = [];
  let offset = 4;
  while (offset + 4 <= buf.length) {
    const header = buf[offset];
    const isLast  = !!(header & 0x80);
    const type    = header & 0x7f;
    const length  = (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
    blocks.push({ type, isLast, start: offset, length });
    offset += 4 + length;
    if (isLast) break;
  }

  const audioStart = offset; // everything from here is audio frames — never touched

  // Read any existing VORBIS_COMMENT block's key=value pairs first, so a
  // partial write (e.g. Clean Up sending only {title}) merges onto what's
  // already there instead of discarding BPM/Key/Genre/Year that weren't
  // part of this particular call.
  const existingComments = {};
  const existingBlock = blocks.find(b => b.type === 4);
  if (existingBlock) {
    try {
      let p = existingBlock.start + 4; // skip block header
      const vendorLen = buf.readUInt32LE(p); p += 4 + vendorLen;
      const commentCount = buf.readUInt32LE(p); p += 4;
      for (let i = 0; i < commentCount; i++) {
        const len = buf.readUInt32LE(p); p += 4;
        const entry = buf.toString('utf8', p, p + len); p += len;
        const eq = entry.indexOf('=');
        if (eq !== -1) existingComments[entry.slice(0, eq).toUpperCase()] = entry.slice(eq + 1);
      }
    } catch {
      // malformed existing block — proceed with no merged-in comments
    }
  }

  // Build the new VORBIS_COMMENT block payload (type 4), merging explicit
  // overrides onto whatever was already there.
  const fieldMap = {
    ...existingComments,
    ...(fields.title  !== undefined ? { TITLE: fields.title }      : {}),
    ...(fields.artist !== undefined ? { ARTIST: fields.artist }    : {}),
    ...(fields.album  !== undefined ? { ALBUM: fields.album }      : {}),
    ...(fields.year   !== undefined ? { DATE: fields.year }        : {}),
    ...(fields.genre  !== undefined ? { GENRE: fields.genre }      : {}),
    ...(fields.bpm    !== undefined ? { BPM: fields.bpm }          : {}),
    ...(fields.key    !== undefined ? { INITIALKEY: fields.key }  : {}),
  };

  const vendor    = 'M13';
  const vendorBuf = Buffer.from(vendor, 'utf8');
  const comments  = Object.entries(fieldMap)
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => Buffer.from(`${k}=${v}`, 'utf8'));

  const vcParts = [];
  const vendorLen = Buffer.alloc(4); vendorLen.writeUInt32LE(vendorBuf.length, 0);
  vcParts.push(vendorLen, vendorBuf);
  const commentCount = Buffer.alloc(4); commentCount.writeUInt32LE(comments.length, 0);
  vcParts.push(commentCount);
  for (const c of comments) {
    const cLen = Buffer.alloc(4); cLen.writeUInt32LE(c.length, 0);
    vcParts.push(cLen, c);
  }
  const vcPayload = Buffer.concat(vcParts);

  // Rebuild the metadata section: keep all blocks except the old VORBIS_COMMENT
  // (type 4) and PADDING (type 1), insert the new VORBIS_COMMENT, then add
  // a small PADDING block so future small edits don't need a full rewrite.
  const kept = blocks.filter(b => b.type !== 4 && b.type !== 1);

  const newMetaBlocks = kept.map(b => {
    const raw = Buffer.from(buf.subarray(b.start, b.start + 4 + b.length));
    raw[0] = raw[0] & 0x7f; // clear last-block flag; we'll set it on the final block
    return raw;
  });

  // New VORBIS_COMMENT block
  const vcHeader = Buffer.alloc(4);
  vcHeader[0] = 4; // type=4, not-last
  vcHeader.writeUIntBE(vcPayload.length, 1, 3);
  newMetaBlocks.push(Buffer.concat([vcHeader, vcPayload]));

  // Padding block (256 bytes) — marked as last
  const padSize   = 256;
  const padHeader = Buffer.alloc(4);
  padHeader[0] = 0x81; // type=1 | last-block flag
  padHeader.writeUIntBE(padSize, 1, 3);
  newMetaBlocks.push(Buffer.concat([padHeader, Buffer.alloc(padSize)]));

  const newFile = Buffer.concat([
    Buffer.from('fLaC', 'ascii'),
    ...newMetaBlocks,
    buf.subarray(audioStart),
  ]);

  fs.writeFileSync(filePath, newFile);
}

ipcMain.handle('save-metadata', (_event, { filePath, fields }) => {
  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, error: 'File not found.' };
  }

  const ext = path.extname(filePath).toLowerCase();

  try {
    if (ext === '.mp3') {
      saveMetadataId3(filePath, fields);
    } else if (ext === '.aif' || ext === '.aiff') {
      saveMetadataAiff(filePath, fields);
    } else if (ext === '.wav') {
      saveMetadataWav(filePath, fields);
    } else if (ext === '.flac') {
      saveMetadataFlac(filePath, fields);
    } else {
      return { success: false, error: `Metadata writing is not supported for ${ext.toUpperCase()} files.` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('reveal-in-finder', (_event, filePath) => {
  if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
});

ipcMain.handle('delete-track-file', async (_event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, error: 'File not found.' };
  }
  try {
    await shell.trashItem(filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ── Artwork fetching ──────────────────────────────────────────────────────────
// Looks up album art via free, no-API-key services (iTunes Search, then
// MusicBrainz + Cover Art Archive as a fallback) and embeds it on request.
// Search only ever *suggests* — nothing here writes a file. Embedding happens
// in a separate handler, called only after the user approves in the preview
// modal, exactly like the metadata-cleanup feature.

function netFetchBuffer(requestUrl, headers) {
  return new Promise((resolve, reject) => {
    try {
      const req = net.request({ url: requestUrl, method: 'GET' });
      if (headers) {
        for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
      }
      const chunks = [];
      req.on('response', (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.on('data', () => {}); // drain so the request can close cleanly
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function netFetchJSON(requestUrl, headers) {
  const buf = await netFetchBuffer(requestUrl, headers);
  return JSON.parse(buf.toString('utf8'));
}

function normalizeForMatch(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Deliberately loose containment check rather than full fuzzy/edit-distance
// matching — good enough to reject obviously-wrong hits (different artist or
// album entirely) without needing an extra dependency. Either string being a
// substring of the other (after normalizing) counts as a match, so "DJ Snake"
// matches "DJ Snake" and "Pathaan" matches "Pathaan (2023)".
function fuzzyContains(a, b) {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

// iTunes serves a small thumbnail by default (100x100) — swapping the size
// in the URL gets a much larger image without an extra request.
function upscaleItunesArtwork(u) {
  if (!u) return u;
  return u.replace(/\d+x\d+(bb)?\.(jpg|png)(\?.*)?$/i, '600x600bb.$2');
}

// DIAGNOSTIC: verbose per-query tracing for "no match" investigation. Logs
// every candidate considered and whether fuzzyContains accepted/rejected it,
// plus whether MusicBrainz was actually attempted vs. skipped outright.
const ARTWORK_DEBUG = true;
function awLog(...args) { if (ARTWORK_DEBUG) console.log('[M13 artwork]', ...args); }

// Mirrors the DJ-prefix heuristic already used by the filename parser's
// Pattern C (index.html) — an Artist tag that's actually a remixer/DJ credit
// rather than the original recording artist. Common on DJ-pool tracks, where
// the tag holds "DJ Ravish & DJ Chico" instead of the actual artist (e.g.
// "B Praak"). When detected, that text is useless — often actively wrong —
// as a search term, so it's stripped from the query and the artist-match
// check is skipped (the tag is known-unreliable here, not just noisy).
function looksLikeRemixCredit(artist) {
  if (!artist) return false;
  const a = artist.trim();
  if (/^(?:DJ|MC|VDJ)\s+\S+/i.test(a)) return true;
  if (/\b(?:DJ|MC|VDJ)\b/i.test(a) && /[&,]/.test(a)) return true;
  return false;
}

// When the Artist tag is a remix/DJ credit, the Title tag is very often the
// same noise carried a second time, baked into a trailing parenthetical —
// e.g. "Mann Bharrya (DJ Ravish  DJ Chico Club Mix)". Stripping the artist
// out of the query alone isn't enough; the title needs the same treatment
// or the remix-DJ names still poison the search term. Search-only — never
// changes the actual stored title.
function stripRemixTagForSearch(title) {
  if (!title) return title;
  const stripped = title.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return stripped || title;
}

async function searchItunesArtwork(artist, album, title) {
  const remixCredit = looksLikeRemixCredit(artist);
  const queryArtist = remixCredit ? '' : artist;
  const queryTitle = remixCredit ? stripRemixTagForSearch(title) : title;
  if (remixCredit) {
    awLog(`Artist "${artist}" looks like a remix/DJ credit, not the original artist — stripping it from the search query, skipping the artist-match check, and cleaning the title query from "${title}" to "${queryTitle}"`);
  }

  if (album) {
    try {
      const term = encodeURIComponent(`${queryArtist} ${album}`.trim());
      awLog(`iTunes album search — term: "${queryArtist} ${album}".trim()`);
      const data = await netFetchJSON(`https://itunes.apple.com/search?term=${term}&media=music&entity=album&limit=5`);
      const results = Array.isArray(data.results) ? data.results : [];
      awLog(`  -> ${results.length} result(s):`, results.map(r => `${r.artistName} / ${r.collectionName}`));
      let matched = false;
      for (const r of results) {
        const artistOk = remixCredit ? true : fuzzyContains(r.artistName, artist);
        const albumOk  = fuzzyContains(r.collectionName, album);
        awLog(`  considering "${r.artistName} / ${r.collectionName}" — artistOk=${artistOk}${remixCredit ? ' (skipped, remix credit)' : ''} albumOk=${albumOk} hasArt=${!!r.artworkUrl100}`);
        if (artistOk && albumOk && r.artworkUrl100) {
          matched = true;
          awLog('  -> ACCEPTED (album search)');
          return {
            found: true, source: 'iTunes',
            artworkUrl: upscaleItunesArtwork(r.artworkUrl100),
            matchedArtist: r.artistName, matchedTitle: r.collectionName,
          };
        }
      }
      if (!matched) awLog('  -> no candidate passed artistOk && albumOk; falling through to song search');
    } catch (err) {
      console.warn('[M13] iTunes album-art search failed:', err.message);
      awLog('  -> iTunes album search threw:', err.message);
    }
  } else {
    awLog('iTunes album search — skipped (no Album tag)');
  }

  // Fall back to a song-level search — used when there's no album tag at
  // all, or the album search above found nothing.
  const songTarget = title || album;
  if (!songTarget) { awLog('iTunes song search — skipped (no title/album to search)'); return null; }
  const songQueryTarget = remixCredit ? stripRemixTagForSearch(songTarget) : songTarget;
  try {
    const term = encodeURIComponent(`${queryArtist} ${songQueryTarget}`.trim());
    awLog(`iTunes song search — term: "${queryArtist} ${songQueryTarget}".trim()`);
    const data = await netFetchJSON(`https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=5`);
    const results = Array.isArray(data.results) ? data.results : [];
    awLog(`  -> ${results.length} result(s):`, results.map(r => `${r.artistName} / ${r.trackName}`));
    for (const r of results) {
      const artistOk = remixCredit ? true : fuzzyContains(r.artistName, artist);
      // Validate against the original (uncleaned) title — a clean official
      // title is naturally a substring/prefix of the messier local one, so
      // fuzzyContains still passes; we only needed the query itself cleaned.
      const titleOk  = fuzzyContains(r.trackName, songTarget);
      awLog(`  considering "${r.artistName} / ${r.trackName}" — artistOk=${artistOk}${remixCredit ? ' (skipped, remix credit)' : ''} titleOk=${titleOk} hasArt=${!!r.artworkUrl100}`);
      if (artistOk && titleOk && r.artworkUrl100) {
        awLog('  -> ACCEPTED (song search)');
        return {
          found: true, source: 'iTunes',
          artworkUrl: upscaleItunesArtwork(r.artworkUrl100),
          matchedArtist: r.artistName, matchedTitle: r.trackName,
        };
      }
    }
    awLog('  -> no candidate passed artistOk && titleOk; iTunes exhausted, no match');
  } catch (err) {
    console.warn('[M13] iTunes song-art search failed:', err.message);
    awLog('  -> iTunes song search threw:', err.message);
  }
  return null;
}

async function searchMusicBrainzArtwork(artist, album) {
  if (!artist || !album) {
    awLog(`MusicBrainz search — SKIPPED ENTIRELY (needs both artist+album; artist=${JSON.stringify(artist)} album=${JSON.stringify(album)})`);
    return null; // MusicBrainz release-group search needs both
  }

  let data;
  try {
    const query = encodeURIComponent(`artist:"${artist}" AND release:"${album}"`);
    awLog(`MusicBrainz search — query: artist:"${artist}" AND release:"${album}"`);
    data = await netFetchJSON(
      `https://musicbrainz.org/ws/2/release-group/?query=${query}&fmt=json&limit=5`,
      { 'User-Agent': 'M13-DJ-Library/1.13 ( desktop app, local lookup )' },
    );
  } catch (err) {
    console.warn('[M13] MusicBrainz search failed:', err.message);
    awLog('  -> MusicBrainz request threw:', err.message);
    return null;
  }

  const groups = Array.isArray(data['release-groups']) ? data['release-groups'] : [];
  awLog(`  -> ${groups.length} release-group result(s):`, groups.map(g => `${(g['artist-credit']||[]).map(ac=>ac.name).join(', ')} / ${g.title}`));
  for (const g of groups) {
    const artistOk = (g['artist-credit'] || []).some(ac => fuzzyContains(ac.name, artist));
    const albumOk  = fuzzyContains(g.title, album);
    awLog(`  considering "${(g['artist-credit']||[]).map(ac=>ac.name).join(', ')} / ${g.title}" — artistOk=${artistOk} albumOk=${albumOk}`);
    if (!artistOk || !albumOk) continue;

    // Confirm art actually exists for this release group before suggesting it
    // — Cover Art Archive 404s for releases with no art on file.
    const caaUrl = `https://coverartarchive.org/release-group/${g.id}/front-500`;
    try {
      await netFetchBuffer(caaUrl);
      awLog('  -> ACCEPTED, cover art confirmed at', caaUrl);
      return { found: true, source: 'MusicBrainz', artworkUrl: caaUrl, matchedArtist: artist, matchedTitle: g.title };
    } catch (err) {
      awLog(`  -> matched release-group "${g.title}" but Cover Art Archive has no image (${err.message}); trying next candidate`);
      continue;
    }
  }
  if (groups.length) awLog('  -> no release-group both matched and had cover art');
  return null;
}

// Recording-level MusicBrainz search — used specifically when there's no
// Album tag, so the release-group search above (which requires both
// artist+album) can't run at all. Searches by title alone, fans out across
// every release MusicBrainz has for that recording (not just one), and
// checks Cover Art Archive at the release level for each until one hits.
async function searchMusicBrainzRecording(artist, title, remixCredit) {
  if (!title) {
    awLog('MusicBrainz recording search — skipped (no title to search)');
    return null;
  }

  const queryTitle = remixCredit ? stripRemixTagForSearch(title) : title;
  let data;
  try {
    const queryParts = [`recording:"${queryTitle}"`];
    if (artist && !remixCredit) queryParts.push(`AND artist:"${artist}"`);
    const queryStr = queryParts.join(' ');
    awLog(`MusicBrainz recording search — query: ${queryStr}${remixCredit ? ` (artist omitted — remix credit; title cleaned from "${title}" to "${queryTitle}")` : ''}`);
    data = await netFetchJSON(
      `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(queryStr)}&fmt=json&limit=5`,
      { 'User-Agent': 'M13-DJ-Library/1.13 ( desktop app, local lookup )' },
    );
  } catch (err) {
    console.warn('[M13] MusicBrainz recording search failed:', err.message);
    awLog('  -> MusicBrainz recording search threw:', err.message);
    return null;
  }

  const recordings = Array.isArray(data.recordings) ? data.recordings : [];
  awLog(`  -> ${recordings.length} recording result(s):`, recordings.map(r => `${(r['artist-credit'] || []).map(ac => ac.name).join(', ')} / ${r.title}`));

  for (const rec of recordings) {
    const recArtistNames = (rec['artist-credit'] || []).map(ac => ac.name).join(', ');
    const artistOk = remixCredit ? true : (rec['artist-credit'] || []).some(ac => fuzzyContains(ac.name, artist));
    const titleOk  = fuzzyContains(rec.title, title);
    awLog(`  considering recording "${recArtistNames} / ${rec.title}" — artistOk=${artistOk}${remixCredit ? ' (skipped, remix credit)' : ''} titleOk=${titleOk}`);
    if (!artistOk || !titleOk) continue;

    const releases = Array.isArray(rec.releases) ? rec.releases : [];
    for (const rel of releases) {
      if (!rel.id) continue;
      const caaUrl = `https://coverartarchive.org/release/${rel.id}/front-500`;
      try {
        await netFetchBuffer(caaUrl);
        awLog(`  -> ACCEPTED, cover art confirmed at ${caaUrl} (release ${rel.id})`);
        return { found: true, source: 'MusicBrainz', artworkUrl: caaUrl, matchedArtist: recArtistNames, matchedTitle: rec.title };
      } catch (err) {
        awLog(`  -> release ${rel.id} has no cover art (${err.message}); trying next release`);
      }
    }
  }
  if (recordings.length) awLog('  -> no recording/release combination both matched and had cover art');
  return null;
}

ipcMain.handle('search-artwork', async (_event, { artist, album, title }) => {
  awLog(`=== search-artwork: artist=${JSON.stringify(artist)} album=${JSON.stringify(album)} title=${JSON.stringify(title)} ===`);
  if (!artist || (!album && !title)) {
    awLog('-> rejected before any search: insufficient metadata');
    return { found: false, reason: 'Not enough metadata to search (need at least Artist + Album or Title).' };
  }
  try {
    const itunes = await searchItunesArtwork(artist, album, title);
    if (itunes) { awLog('=== RESULT: found via iTunes ==='); return itunes; }
  } catch (err) {
    console.warn('[M13] artwork search (iTunes) error:', err.message);
  }
  awLog('iTunes exhausted with no match — proceeding to MusicBrainz fallback');
  try {
    const mb = await searchMusicBrainzArtwork(artist, album);
    if (mb) { awLog('=== RESULT: found via MusicBrainz (release-group) ==='); return mb; }
  } catch (err) {
    console.warn('[M13] artwork search (MusicBrainz) error:', err.message);
  }
  if (!album && title) {
    awLog('No Album tag — trying MusicBrainz recording-level search as well');
    try {
      const mbRec = await searchMusicBrainzRecording(artist, title, looksLikeRemixCredit(artist));
      if (mbRec) { awLog('=== RESULT: found via MusicBrainz (recording) ==='); return mbRec; }
    } catch (err) {
      console.warn('[M13] artwork search (MusicBrainz recording) error:', err.message);
    }
  }
  awLog('=== RESULT: no match (both sources exhausted) ===');
  return { found: false, reason: 'No confident match found.' };
});

function sniffImageMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  return 'image/jpeg';
}

// FLAC has no concept of ID3 — artwork is its own native METADATA_BLOCK_PICTURE
// block (type 6). Same careful approach as saveMetadataFlac: parse the existing
// block headers, drop only the old PICTURE block (if any), keep everything
// else byte-identical, and never touch the audio frames.
function embedArtworkFlac(filePath, imageBuffer, mime) {
  const buf = fs.readFileSync(filePath);
  if (buf.toString('ascii', 0, 4) !== 'fLaC') throw new Error('Not a valid FLAC file.');

  const blocks = [];
  let offset = 4;
  while (offset + 4 <= buf.length) {
    const header = buf[offset];
    const isLast = !!(header & 0x80);
    const type   = header & 0x7f;
    const length = (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
    blocks.push({ type, isLast, start: offset, length });
    offset += 4 + length;
    if (isLast) break;
  }
  const audioStart = offset;

  const kept = blocks.filter(b => b.type !== 6); // drop any existing PICTURE block
  const newMetaBlocks = kept.map(b => {
    const raw = Buffer.from(buf.subarray(b.start, b.start + 4 + b.length));
    raw[0] = raw[0] & 0x7f; // clear last-block flag; the new final block will carry it
    return raw;
  });

  const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; };
  const mimeBuf = Buffer.from(mime, 'utf8');
  const descBuf = Buffer.alloc(0);

  const picPayload = Buffer.concat([
    u32be(3),                              // picture type 3 = "Cover (front)"
    u32be(mimeBuf.length), mimeBuf,
    u32be(descBuf.length), descBuf,
    u32be(0), u32be(0), u32be(0), u32be(0), // width, height, depth, indexed-colors — unknown
    u32be(imageBuffer.length), imageBuffer,
  ]);

  const picHeader = Buffer.alloc(4);
  picHeader[0] = 6; // type=6 (PICTURE), not last
  picHeader.writeUIntBE(picPayload.length, 1, 3);
  newMetaBlocks.push(Buffer.concat([picHeader, picPayload]));

  const padSize = 4;
  const padHeader = Buffer.alloc(4);
  padHeader[0] = 0x81; // type=1 (PADDING) | last-block flag
  padHeader.writeUIntBE(padSize, 1, 3);
  newMetaBlocks.push(Buffer.concat([padHeader, Buffer.alloc(padSize)]));

  const newFile = Buffer.concat([
    Buffer.from('fLaC', 'ascii'),
    ...newMetaBlocks,
    buf.subarray(audioStart),
  ]);
  fs.writeFileSync(filePath, newFile);
}

ipcMain.handle('embed-artwork', async (_event, { filePath, imageUrl }) => {
  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, error: 'File not found.' };
  }

  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.wav') {
    return { success: false, error: 'Artwork is not supported for WAV files.' };
  }
  if (!['.mp3', '.aif', '.aiff', '.flac'].includes(ext)) {
    return { success: false, error: `Artwork embedding is not supported for ${ext.toUpperCase()} files.` };
  }

  let imageBuffer;
  try {
    imageBuffer = await netFetchBuffer(imageUrl);
  } catch (err) {
    return { success: false, error: `Could not download artwork: ${err.message}` };
  }

  const mime = sniffImageMime(imageBuffer);

  try {
    if (ext === '.mp3') {
      const result = NodeID3.update({
        image: {
          mime,
          type: { id: 3, name: 'front cover' },
          description: 'Cover',
          imageBuffer,
        },
      }, filePath);
      if (result instanceof Error) throw result;
    } else if (ext === '.aif' || ext === '.aiff') {
      embedArtworkAiff(filePath, imageBuffer, mime);
    } else if (ext === '.flac') {
      embedArtworkFlac(filePath, imageBuffer, mime);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ── Brand Artwork ─────────────────────────────────────────────────────────────
// Stamps the user's own logo onto tracks that either have no cover art or carry
// a DJ pool's / label's branding image. Detection is by exact image hash: one
// identical picture spread across MANY DIFFERENT ALBUMS is branding, not cover
// art. We never decide that on the user's behalf — the counts are surfaced and
// they tick which groups to replace.

const ART_BACKUP_DIR = path.join(os.homedir(), 'M13', 'artwork-backup');

// The M13 emblem, 600x600 JPEG, embedded rather than shipped as a file: only
// main/preload/index/package.json are packaged, and sips needs a real path
// anyway. This is the CORRECTED zodiac wheel — build/logo-exports/ predates the
// key-mapping fix and must never be used as the source here.
const BRAND_LOGO_B64 = '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z7qq1x/i74q/Evx7Ett4x16+1CBPuQSTMIE/3YgRGo9goo0D3n/X9fmd9P8ABIaIDc/FPxbo2hsv3rZLj+1L76eTaeaqn2kkT3xVT/hIPgN4TG3w/oV94quV6XGtTfY7XPqLW1YyH/gVzj1FeGABRhRgUtFw5X1Z6x4i+NvxG8QaU3huK9XSdHfrpukxLY2hH+2kIXzPrKXb3ryZVVRtUYHtS0UrjSS2CiiigYUUUUAFFJz2ox3oAOT7UtFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFAH//0v4N6KKK9QzCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACkx3paKAEyR1paKKACik5oz60ALRRRQAUUUUAFFFFABRgHrRRQAzyo928KNw745rVtta1qy/48r24hx/zzlZf5Gs2igDsbf4ifEK0GLXxBqcf+7eTD+T1eb4sfFR08p/E+rlfQ30xH/odcBRTuxcqOqm8d+OrkYuNc1Fx/tXUp/8AZqybjXNcu12Xd9cSg9nldh+prLopXHYjEMQOQoz9KkwB0oooAKKKKACiiigAooooAKKKTPpQAtFJzS0AJknpRjvS0UAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQB//0/4N6KKK9QzCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAEx6Uc0tFACZ9aXIPSiigAopMUc0ALRRzSZPpQAtFFJkUALRRnNFABRRnFJkUALRRSZPpQAtFHNJzQAtGQOtJiloATPpRzS0UAJj1paKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD//1P4N6KKK9QzCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD//Z';

function brandDefaultPath() {
  const dir = path.join(app.getPath('userData'), 'brand');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'm13-emblem-600.jpg');
  if (!fs.existsSync(out)) fs.writeFileSync(out, Buffer.from(BRAND_LOGO_B64, 'base64'));
  return out;
}

ipcMain.handle('get-brand-default', () => {
  try {
    const p = brandDefaultPath();
    return { ok: true, path: p, bytes: fs.statSync(p).size,
             preview: `data:image/jpeg;base64,${BRAND_LOGO_B64}` };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Let the user point at their own image instead of the M13 emblem.
ipcMain.handle('pick-brand-image', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Choose artwork',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  return { canceled: false, path: res.filePaths[0] };
});

// Scan a list of files, bucketing them into "no artwork" and groups of shared
// artwork keyed by the SHA-1 of the image bytes.
ipcMain.handle('scan-artwork', async (_event, { paths }) => {
  if (!Array.isArray(paths) || !paths.length) return { missing: [], groups: [] };
  const musicMetadata = await getMusicMetadata();
  const missing = [];
  const byHash = new Map();
  let failed = 0;

  const queue = paths.slice();
  const worker = async () => {
    while (queue.length) {
      const f = queue.pop();
      try {
        const md = await musicMetadata.parseFile(f, { skipCovers: false, skipPostHeaders: true });
        const pic = md.common.picture && md.common.picture[0];
        if (!pic) { missing.push(f); continue; }
        const hash = crypto.createHash('sha1').update(pic.data).digest('hex').slice(0, 16);
        let g = byHash.get(hash);
        if (!g) {
          g = { hash, paths: [], albums: new Set(), artists: new Set(),
                bytes: pic.data.length, format: pic.format,
                // one small preview per GROUP, not per track
                thumb: `data:${pic.format};base64,${Buffer.from(pic.data).toString('base64')}` };
          byHash.set(hash, g);
        }
        g.paths.push(f);
        g.albums.add((md.common.album || '?').toLowerCase());
        g.artists.add((md.common.albumartist || md.common.artist || '?').toLowerCase());
      } catch { failed++; }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  const groups = [...byHash.values()]
    .map(g => ({ hash: g.hash, paths: g.paths, count: g.paths.length,
                 albums: g.albums.size, artists: g.artists.size,
                 bytes: g.bytes, format: g.format, thumb: g.thumb }))
    .filter(g => g.count > 1)              // a one-off cover is just a cover
    .sort((a, b) => b.albums - a.albums || b.count - a.count);

  return { missing, groups, failed, scanned: paths.length };
});

// Prepare the logo for embedding: square, downscaled, JPEG. The source export
// is a ~440KB PNG — stamped across a whole library that is hundreds of MB of
// bloat on files that live on USB sticks, and no jog wheel resolves it.
ipcMain.handle('prepare-brand-image', async (_event, { sourcePath, size }) => {
  try {
    if (!sourcePath || !fs.existsSync(sourcePath)) return { ok: false, error: 'Image not found.' };
    const px = Math.max(200, Math.min(1200, Number(size) || 600));
    fs.mkdirSync(path.join(app.getPath('userData'), 'brand'), { recursive: true });
    const out = path.join(app.getPath('userData'), 'brand', `brand-${px}.jpg`);
    await new Promise((resolve, reject) => {
      // sips ships with macOS — no image dependency to bundle. --padToHeightWidth
      // keeps it square without stretching a non-square source.
      execFile('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85',
                        '-Z', String(px), sourcePath, '--out', out],
        { timeout: 30000 }, (err) => (err ? reject(err) : resolve()));
    });
    const buf = fs.readFileSync(out);
    return { ok: true, path: out, bytes: buf.length,
             preview: `data:image/jpeg;base64,${buf.toString('base64')}` };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Embed the prepared image across the chosen files. backup:'keep' stashes the
// artwork being replaced so the change is reversible; 'discard' does not.
ipcMain.handle('apply-brand-artwork', async (event, { paths, imagePath, backup }) => {
  if (!Array.isArray(paths) || !paths.length) return { ok: false, error: 'Nothing selected.' };
  if (!imagePath || !fs.existsSync(imagePath)) return { ok: false, error: 'Prepared image missing.' };

  const imageBuffer = fs.readFileSync(imagePath);
  const mime = sniffImageMime(imageBuffer);
  const musicMetadata = backup === 'keep' ? await getMusicMetadata() : null;
  let stamp = null;
  if (backup === 'keep') {
    stamp = path.join(ART_BACKUP_DIR, new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(stamp, { recursive: true });
  }

  let done = 0, ok = 0, skipped = 0;
  const errors = [];
  for (const filePath of paths) {
    const ext = path.extname(filePath).toLowerCase();
    try {
      if (!fs.existsSync(filePath)) { skipped++; continue; }
      if (!['.mp3', '.aif', '.aiff', '.flac'].includes(ext)) { skipped++; continue; }

      // Save whatever art is there BEFORE overwriting it.
      if (stamp) {
        try {
          const md = await musicMetadata.parseFile(filePath, { skipCovers: false, skipPostHeaders: true });
          const pic = md.common.picture && md.common.picture[0];
          if (pic) {
            const ex = (pic.format || 'image/jpeg').includes('png') ? 'png' : 'jpg';
            const safe = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16);
            fs.writeFileSync(path.join(stamp, `${safe}.${ex}`), pic.data);
            fs.appendFileSync(path.join(stamp, 'index.tsv'), `${safe}.${ex}\t${filePath}\n`);
          }
        } catch { /* no readable art to back up — carry on */ }
      }

      if (ext === '.mp3') {
        const r = NodeID3.update({ image: { mime, type: { id: 3, name: 'front cover' },
                                            description: 'Cover', imageBuffer } }, filePath);
        if (r instanceof Error) throw r;
      } else if (ext === '.aif' || ext === '.aiff') {
        embedArtworkAiff(filePath, imageBuffer, mime);
      } else {
        embedArtworkFlac(filePath, imageBuffer, mime);
      }
      ok++;
    } catch (err) {
      errors.push({ path: filePath, error: err.message });
    }
    done++;
    if (done % 5 === 0 || done === paths.length) {
      if (!event.sender.isDestroyed()) {
        event.sender.send('brand-artwork-progress', { done, total: paths.length, ok });
      }
    }
  }
  return { ok: true, applied: ok, skipped, errors, backupDir: stamp };
});

// ── Recorded Sets ─────────────────────────────────────────────────────────────

ipcMain.handle('scan-sets', async () => {
  const volumesDir = '/Volumes';

  if (!fs.existsSync(volumesDir)) {
    return [];
  }

  let volumeEntries;
  try {
    volumeEntries = fs.readdirSync(volumesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const musicMetadata = await getMusicMetadata();
  const results = [];

  for (const entry of volumeEntries) {
    const recDir = path.join(volumesDir, entry.name, 'PIONEER REC');

    if (!fs.existsSync(recDir)) continue;

    let files;
    try {
      files = fs.readdirSync(recDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.isFile()) continue;
      if (file.name.startsWith('._')) continue;        // macOS resource fork (Rekordbox)
      if (path.extname(file.name).toLowerCase() !== '.wav') continue;

      const filePath = path.join(recDir, file.name);

      let stats;
      try {
        stats = fs.statSync(filePath);
      } catch {
        continue;
      }

      let duration = 0;
      try {
        // duration: true ensures music-metadata calculates duration for untagged WAVs
        const meta = await musicMetadata.parseFile(filePath, { skipCovers: true, duration: true, skipPostHeaders: true });
        duration = meta.format.duration || 0;
      } catch { /* leave duration as 0 */ }

      results.push({
        filename: file.name,
        path: filePath,
        size: stats.size,
        duration,
        volume: entry.name,
        mtime: stats.mtimeMs,
      });
    }
  }

  // Newest recordings first
  results.sort((a, b) => b.mtime - a.mtime);

  return results;
});

// ── Set tag storage ───────────────────────────────────────────────────────────
//
// Tags are written to M13_Sets.json at the root of the USB drive that contains
// the PIONEER REC folder.  The PIONEER REC directory itself is never written to.
//
// Given a recording path  /Volumes/<drive>/PIONEER REC/<file>.wav
//   USB root  = path.dirname(path.dirname(filePath))   →  /Volumes/<drive>
//   JSON path = <USB root>/M13_Sets.json
//
// Within M13_Sets.json the entries are keyed by filename (not full path) so the
// file remains portable if the drive is remounted under a different name.
//
// On read, the local userData config is checked as a fallback so that any tags
// saved by an older version of M13 are still surfaced.

function usbRootFromRecordingPath(filePath) {
  // /Volumes/<drive>/PIONEER REC/<file>  →  /Volumes/<drive>
  return path.dirname(path.dirname(filePath));
}

function setsJsonPath(usbRoot) {
  return path.join(usbRoot, 'M13_Sets.json');
}

function readSetsJson(usbRoot) {
  const jsonPath = setsJsonPath(usbRoot);
  try {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    return {};
  }
}

function writeSetsJson(usbRoot, data) {
  const jsonPath = setsJsonPath(usbRoot);
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
}

// Normalise a saved entry to the current schema regardless of which version
// of M13 wrote it.  Old entries used { label, notes }; new ones use the fuller
// { setName, venue, date, genre, bpmRange, notes } shape.
function normaliseSetTags(raw) {
  if (!raw || typeof raw !== 'object') {
    return { setName: '', venue: '', date: '', genre: '', bpmRange: '', notes: '' };
  }
  const out = {
    setName:  raw.setName  || raw.label || '',
    venue:    raw.venue    || '',
    date:     raw.date     || '',
    genre:    raw.genre    || '',
    bpmRange: raw.bpmRange || '',
    notes:    raw.notes    || '',
  };
  return out;
}

ipcMain.handle('get-set-tags', (_event, filePath) => {
  const filename = path.basename(filePath);
  const usbRoot  = usbRootFromRecordingPath(filePath);

  // Primary: M13_Sets.json on the USB drive
  const driveData = readSetsJson(usbRoot);
  if (driveData[filename]) {
    return normaliseSetTags(driveData[filename]);
  }

  // Fallback: local userData config (backwards compatibility with older M13)
  const localConfig = loadConfig();
  if (localConfig.setTags && localConfig.setTags[filePath]) {
    return normaliseSetTags(localConfig.setTags[filePath]);
  }

  return normaliseSetTags(null);
});

ipcMain.handle('save-set-tags', (_event, { filePath, tags }) => {
  const filename = path.basename(filePath);
  const usbRoot  = usbRootFromRecordingPath(filePath);

  try {
    const driveData = readSetsJson(usbRoot);
    driveData[filename] = {
      setName:  tags.setName  || '',
      venue:    tags.venue    || '',
      date:     tags.date     || '',
      genre:    tags.genre    || '',
      bpmRange: tags.bpmRange || '',
      notes:    tags.notes    || '',
    };
    writeSetsJson(usbRoot, driveData);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Sanitise a free-text set name into a safe filesystem filename (no extension).
// Any user-supplied .wav suffix is stripped first to prevent double extensions.
function sanitiseFilename(name) {
  return (name || '')
    .replace(/\.wav$/i, '')           // strip trailing .wav the user may have typed
    .replace(/[/\\:*?"<>|]/g, '-')   // characters illegal on Windows / macOS
    .replace(/\s+/g, ' ')
    .trim()
    || 'Recorded_Set';
}

// Return a destination path that does not yet exist, appending (2), (3)… as
// needed so we never overwrite an existing file.
function uniqueDestPath(destFolder, baseName) {
  let candidate = path.join(destFolder, `${baseName}.wav`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(destFolder, `${baseName} (${n}).wav`);
    n += 1;
  }
  return candidate;
}

// Embed metadata into a WAV file by appending a native LIST INFO chunk.
//
// node-id3 prepends raw ID3 bytes before the file content (Buffer.concat([id3,
// fileData])).  For MP3 that is correct, but for WAV it places the ID3 header
// before the RIFF marker, which destroys the file structure and makes every
// audio player reject the file.  Using WAV's own LIST INFO sub-chunks avoids
// that entirely: we append a new chunk at the end and update the RIFF size
// field.  The audio frames are never re-encoded or moved.
function appendWavListInfo(filePath, info) {
  // Map friendly field names to RIFF INFO four-character codes
  const fieldMap = [
    ['INAM', info.title],    // Name / Title
    ['IART', info.artist],   // Artist / Venue
    ['ICRD', info.date],     // Creation date
    ['IGNR', info.genre],    // Genre
    ['ICMT', info.comment],  // Comment (BPM range, notes, etc.)
  ];

  // Build each INFO sub-chunk: 4-byte FourCC + 4-byte LE size + null-terminated
  // string, padded to an even byte boundary.
  const subChunks = [];
  for (const [fourcc, value] of fieldMap) {
    if (!value) continue;
    const text    = Buffer.from(value + '\0', 'utf8');
    const padded  = text.length % 2 === 0 ? text : Buffer.concat([text, Buffer.alloc(1)]);
    const header  = Buffer.alloc(8);
    header.write(fourcc, 0, 'ascii');
    header.writeUInt32LE(text.length, 4); // size = actual bytes incl. null terminator
    subChunks.push(Buffer.concat([header, padded]));
  }

  if (subChunks.length === 0) return; // nothing to write

  // LIST chunk = 'LIST' + 4-byte LE size + 'INFO' + sub-chunks
  const infoPayload = Buffer.concat([Buffer.from('INFO', 'ascii'), ...subChunks]);
  const listHeader  = Buffer.alloc(8);
  listHeader.write('LIST', 0, 'ascii');
  listHeader.writeUInt32LE(infoPayload.length, 4);
  const listChunk = Buffer.concat([listHeader, infoPayload]);

  // Read the existing file, verify it is a valid WAV, then append.
  const original = fs.readFileSync(filePath);

  if (original.length < 12 ||
      original.toString('ascii', 0, 4) !== 'RIFF' ||
      original.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Destination is not a valid WAV file — cannot embed metadata.');
  }

  const newFile = Buffer.concat([original, listChunk]);
  // Fix the RIFF chunk size field (bytes 4–7 = total file size minus the 8-byte
  // RIFF header itself).
  newFile.writeUInt32LE(newFile.length - 8, 4);
  fs.writeFileSync(filePath, newFile);
}

ipcMain.handle('export-set', (event, { srcPath, destFolder, setName, tags }) => {
  // ── Safety checks ──────────────────────────────────────────────────────────
  if (!srcPath || !fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) {
    return { success: false, error: 'Source file not found.' };
  }
  if (!destFolder || !fs.existsSync(destFolder) || !fs.statSync(destFolder).isDirectory()) {
    return { success: false, error: 'Destination folder not found.' };
  }
  // The destination folder must never be inside the PIONEER REC directory.
  if (destFolder.includes('PIONEER REC')) {
    return { success: false, error: 'Cannot export into a PIONEER REC folder. Choose a different destination.' };
  }

  // ── Build destination path ─────────────────────────────────────────────────
  const baseName = sanitiseFilename(setName);
  const destPath = uniqueDestPath(destFolder, baseName);

  // Verify the result has the correct extension before proceeding.
  if (path.extname(destPath).toLowerCase() !== '.wav') {
    return { success: false, error: `Destination path has unexpected extension: ${destPath}` };
  }

  const total = fs.statSync(srcPath).size;

  return new Promise((resolve) => {
    let transferred = 0;
    let lastPct     = -1;

    const srcStream  = fs.createReadStream(srcPath);
    const destStream = fs.createWriteStream(destPath);

    srcStream.on('data', (chunk) => {
      transferred += chunk.length;
      const pct = Math.floor((transferred / total) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        if (!event.sender.isDestroyed()) {
          event.sender.send('set-export-progress', { transferred, total, pct });
        }
      }
    });

    const cleanup = (err) => {
      srcStream.destroy();
      destStream.destroy();
      // Remove the partial copy — the original is never touched
      try { fs.unlinkSync(destPath); } catch { /* ignore */ }
      resolve({ success: false, error: err.message });
    };

    srcStream.on('error', cleanup);
    destStream.on('error', cleanup);

    destStream.on('finish', () => {
      // ── Critical safety check before any write to the copy ──────────────
      // Abort if destPath somehow refers to anything inside PIONEER REC.
      // This is an absolute last line of defence — NodeID3 / appendWavListInfo
      // must never be called on an original recording.
      if (destPath.includes('PIONEER REC')) {
        try { fs.unlinkSync(destPath); } catch { /* ignore */ }
        resolve({ success: false, error: 'Safety abort: destination path is inside PIONEER REC.' });
        return;
      }

      // Verify the copy exists and has the correct extension.
      if (!fs.existsSync(destPath) || path.extname(destPath).toLowerCase() !== '.wav') {
        resolve({ success: false, error: `Exported file missing or has wrong extension: ${destPath}` });
        return;
      }

      // ── Write metadata to the COPY only ───────────────────────────────────
      // We use native WAV LIST INFO chunks rather than node-id3, because
      // node-id3 prepends ID3 bytes before the file content — correct for MP3
      // but fatal for WAV (it overwrites the RIFF header).
      try {
        const commentParts = [];
        if (tags.bpmRange) commentParts.push(`BPM: ${tags.bpmRange}`);
        if (tags.notes)    commentParts.push(tags.notes);

        appendWavListInfo(destPath, {
          title:   tags.setName  || '',
          artist:  tags.venue    || '',
          date:    tags.date     || '',
          genre:   tags.genre    || '',
          comment: commentParts.join(' | '),
        });
      } catch (metaErr) {
        // Metadata embedding failed — the audio copy is still intact and
        // playable, so we resolve success rather than deleting a good file.
        console.warn('[M13] WAV metadata write failed:', metaErr.message);
      }

      resolve({ success: true, destPath, destFilename: path.basename(destPath) });
    });

    srcStream.pipe(destStream);
  });
});

// ── License IPC handlers ──────────────────────────────────────────────────────

ipcMain.handle('get-machine-id', () => getMachineId());

ipcMain.handle('get-license-info', () => {
  const stored = readStoredLicense();
  const machineId = getMachineId();
  return { stored, machineId };
});

// Decides whether this Mac is licensed. Used at launch and by the entitlement check.
async function checkLicenseState() {
  const hardwareId = getMachineId();
  let stored = readStoredLicense();

  // No license file at all
  if (!stored || !stored.licenseKey) return { valid: false, reason: 'no-license' };

  // ── Legacy migration ──────────────────────────────────────────────────────
  // Older files (and every activation made before this build) carry only the
  // hostname-based `machineId`. That value is what the SERVER has bound, so we
  // preserve it as serverMachineId and record this machine's new stable
  // hardwareId. This NEVER invalidates the user — the binding is untouched, we
  // just stop deriving it from the network-volatile hostname.
  if (!stored.serverMachineId || !stored.hardwareId) {
    const boundId = stored.serverMachineId || stored.machineId;
    writeStoredLicense(stored.licenseKey, stored.lastVerifiedAt, stored.preOrder, boundId);
    stored = readStoredLicense();
  }

  const sameMachine = stored.hardwareId === hardwareId;

  // Same machine + recently verified → valid locally, no network needed.
  if (sameMachine && !needsOnlineVerification(stored)) {
    return { valid: true, licenseKey: stored.licenseKey, preOrder: !!stored.preOrder };
  }

  // Otherwise re-verify online — ALWAYS with the bound serverMachineId (the id
  // the server actually knows), never the local hardware id. So a stable-id
  // change (logic-board swap, migrated legacy file) is reconciled instead of
  // triggering a false "wrong-machine". We never wipe a local activation
  // without an explicit server verdict.
  const online = await verifyLicenseOnline(stored.licenseKey, stored.serverMachineId);
  if (online) {
    if (online.status === 'valid' || online.status === 'already-active') {
      // Refresh verify time + preOrder, keep the bound id, adopt current
      // hardwareId (self-heals the local same-machine check after a HW change).
      writeStoredLicense(stored.licenseKey, new Date().toISOString(), online.preOrder, stored.serverMachineId);
      return { valid: true, licenseKey: stored.licenseKey, preOrder: !!online.preOrder };
    }
    // Only an explicit server verdict revokes: the key was refunded/disabled,
    // or its binding was deliberately transferred to another machine.
    if (online.status === 'invalid') { clearStoredLicense(); return { valid: false, reason: 'invalid' }; }
    if (online.status === 'wrong-machine') { clearStoredLicense(); return { valid: false, reason: 'wrong-machine' }; }
    // Unknown status — don't lock the user out.
    return { valid: true, licenseKey: stored.licenseKey, preOrder: !!stored.preOrder, offline: true };
  }

  // Server unreachable — trust the authentic local file. NEVER lock out offline
  // (the 18-hour-flight case). Re-verification stays opportunistic.
  return { valid: true, licenseKey: stored.licenseKey, preOrder: !!stored.preOrder, offline: true };
}

ipcMain.handle('check-license', () => checkLicenseState());

ipcMain.handle('activate-license', async (_event, licenseKey) => {
  const machineId = getMachineId();
  try {
    const res = await net.fetch(LICENSE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'activate', licenseKey, machineId }),
    });
    if (!res.ok) return { success: false, status: 'server-error', message: `Server error ${res.status}. Try again shortly.` };
    const data = await res.json();

    if (data.status === 'success' || data.status === 'already-active') {
      writeStoredLicense(licenseKey, new Date().toISOString(), data.preOrder);
      await refreshEntitlement(); // everything unlocks straight away
      return { success: true, preOrder: !!data.preOrder };
    }
    return { success: false, status: data.status, message: data.message };
  } catch (err) {
    const msg = err && err.message ? err.message : '';
    if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('ERR_NAME_NOT_RESOLVED')) {
      return { success: false, status: 'offline', message: 'Could not reach activation server. Check your connection and try again.' };
    }
    return { success: false, status: 'server-error', message: 'Activation server unavailable. Try again shortly.' };
  }
});

ipcMain.handle('get-entitlement', async () => {
  const ent = await ensureEntitlement();
  // Once per launch, check the trial with the server in the background (the
  // server is the record; this also picks up a trial started on a reinstall).
  if (ent.kind !== 'licensed' && !_trialSyncedThisLaunch) {
    _trialSyncedThisLaunch = true;
    syncTrialWithServer().then((r) => { if (!r.offline && !r.serverError) refreshEntitlement(); });
  }
  return ent;
});

ipcMain.handle('start-trial', async () => {
  const current = await refreshEntitlement();
  if (current.kind === 'licensed' || current.kind === 'trial') return { ok: true, entitlement: current };
  const result = await syncTrialWithServer({ start: true });
  if (result.offline) {
    return { ok: false, error: 'offline', message: 'Starting your free trial needs an internet connection, just this once. Check your connection and try again.' };
  }
  // Reached the server but it couldn't start the trial — don't blame their wi-fi.
  if (result.serverError) {
    return { ok: false, error: 'server', message: 'Couldn’t start your trial just now. Please try again in a minute.' };
  }
  _trialSyncedThisLaunch = true;
  return { ok: true, entitlement: await refreshEntitlement() };
});

// A fixed address only — the page can't ask the app to open anything else.
ipcMain.handle('open-buy-page', () => shell.openExternal(BUY_URL));

ipcMain.handle('transfer-license', async (_event, licenseKey) => {
  const machineId = getMachineId();
  try {
    const res = await net.fetch(LICENSE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'transfer', licenseKey, machineId }),
    });
    if (!res.ok) return { status: 'server-error', message: `Server error ${res.status}.` };
    const data = await res.json();
    if (data.status === 'success') {
      clearStoredLicense();
      await refreshEntitlement();
    }
    return data;
  } catch {
    return { status: 'server-error', message: 'Could not reach server. Try again.' };
  }
});

// ── Entitlement self-test (test builds only) ─────────────────────────────────
// M13_SELFTEST=entitlement M13_USER_DATA=<empty folder> npx electron .
// Calls the real, wrapped action handlers. Only calls that stop at the lock, or
// that are harmless (a crate id that can't exist, listing crates), ever run.
async function runEntitlementSelfTest() {
  const results = [];
  const check = (name, pass, info) => results.push({ name, pass: !!pass, ...(pass ? {} : { info }) });
  const invoke = (channel, ...args) => _ipcHandlers.get(channel)({ sender: null }, ...args);

  const missing = [...LOCKED_AFTER_TRIAL].filter((c) => !_ipcHandlers.has(c));
  check('every locked action exists', missing.length === 0, missing);

  const real = await refreshEntitlement();
  check('a fresh profile has no licence and no trial', real.kind === 'none' && real.canChange === false, real);

  for (const kind of ['none', 'expired']) {
    _entitlement = { kind, canChange: false };
    const notLocked = [];
    for (const channel of LOCKED_AFTER_TRIAL) {
      const r = await invoke(channel, {});
      const locked = channel === 'ensure-export-folder' ? r === null : (r && r.locked === true);
      if (!locked) notLocked.push(channel);
    }
    check(`${kind}: all ${LOCKED_AFTER_TRIAL.size} locked actions refuse`, notLocked.length === 0, notLocked);
    const list = await invoke('crates-list');
    check(`${kind}: browsing (list crates) still works`, !(list && list.locked), list);
  }

  _entitlement = { kind: 'trial', canChange: true, day: 5 };
  const passThrough = await invoke('crates-delete', '__m13_selftest_no_such_crate__');
  check('trial: a locked action reaches its real handler', passThrough && passThrough.ok === false && !passThrough.locked, passThrough);

  _entitlement = { kind: 'licensed', canChange: true };
  const licensed = await invoke('crates-delete', '__m13_selftest_no_such_crate__');
  check('licensed: a locked action reaches its real handler', licensed && licensed.ok === false && !licensed.locked, licensed);

  const failed = results.filter((r) => !r.pass);
  console.log(JSON.stringify({ selftest: 'entitlement', passed: results.length - failed.length, failed: failed.length, results }, null, 2));
  return failed.length ? 1 : 0;
}

// M13_SELFTEST=trial-flow M13_USER_DATA=<empty folder> M13_FAKE_MACHINE_ID=<32 hex>
//   M13_LICENSE_API=<test deploy>/.netlify/functions/license npx electron .
// Starts a real trial on the server for the FAKE machine id and walks it to day 14.
async function runTrialFlowSelfTest() {
  const results = [];
  const check = (name, pass, info) => results.push({ name, pass: !!pass, ...(pass ? {} : { info }) });
  const invoke = (channel, ...args) => _ipcHandlers.get(channel)({ sender: null }, ...args);
  const ahead = (n) => { process.env.M13_TRIAL_DAYS_AHEAD = String(n); return refreshEntitlement(); };

  check('using the fake test machine id', getMachineId() === process.env.M13_FAKE_MACHINE_ID, getMachineId());
  let e = await ahead(0);
  check('fresh profile → no trial yet, locked', e.kind === 'none' && e.canChange === false, e);

  const started = await invoke('start-trial');
  check('Start trial reaches the server from Electron → day 1 of 13', started.ok && started.entitlement.kind === 'trial' && started.entitlement.day === 1 && started.entitlement.daysLeft === 13, started);
  const file = trialLib.readTrialFile(getTrialPath(), getMachineId());
  check('trial.json saved and signed', file.valid === true, file);
  const again = await invoke('start-trial');
  check('Start trial again → same trial, not restarted', again.ok && again.entitlement.day === 1, again);

  trialLib.removeTrialFile(getTrialPath());
  e = await refreshEntitlement();
  check('trial.json deleted (like a reinstall) → nothing locally', e.kind === 'none', e);
  const sync = await syncTrialWithServer();
  e = await refreshEntitlement();
  check('…the server hands the same trial back', !sync.offline && e.kind === 'trial' && e.day === 1, { sync, e });

  e = await ahead(9);
  check('day 10 → still full access', e.kind === 'trial' && e.day === 10 && e.daysLeft === 4 && e.canChange, e);
  e = await ahead(12);
  check('day 13 → last day, full access', e.kind === 'trial' && e.day === 13 && e.daysLeft === 1 && e.canChange, e);
  const beforeEnd = await invoke('crates-delete', '__m13_selftest_no_such_crate__');
  check('day 13 → a locked action still reaches its handler', beforeEnd && !beforeEnd.locked, beforeEnd);
  e = await ahead(13);
  check('day 14 → trial ended, read-only', e.kind === 'expired' && e.canChange === false, e);
  const afterEnd = await invoke('crates-save', { name: 'selftest', trackPaths: ['/nonexistent.mp3'] });
  check('day 14 → saving a crate is refused', afterEnd && afterEnd.locked === true, afterEnd);
  const browse = await invoke('crates-list');
  check('day 14 → browsing still works', !(browse && browse.locked), browse);

  e = await ahead(0);
  check('clock wound back to day 1 → still ended', e.kind === 'expired' && e.clockWoundBack === true, e);
  await syncTrialWithServer();
  e = await refreshEntitlement();
  check('next online check trusts the server’s real date again (test-only jump undone)', e.kind === 'trial' && e.day === 1, e);

  const failed = results.filter((r) => !r.pass);
  console.log(JSON.stringify({ selftest: 'trial-flow', passed: results.length - failed.length, failed: failed.length, results }, null, 2));
  return failed.length ? 1 : 0;
}

// M13_SELFTEST=phase5 M13_USER_DATA=<empty folder> M13_TEST_LICENSE_FILE=<copy of a real license.json>
//   M13_LICENSE_API=http://127.0.0.1:41999/license npx electron .
// The awkward cases: a licensed Mac (online and offline), a refunded key, and
// offline trials. It runs its own fake license server on that port, so nothing
// touches m13app.com or the real profile.
async function runPhase5SelfTest() {
  const results = [];
  const check = (name, pass, info) => results.push({ name, pass: !!pass, ...(pass ? {} : { info }) });
  const invoke = (channel, ...args) => _ipcHandlers.get(channel)({ sender: null }, ...args);
  const licensePath = getLicensePath();
  const trialPath = getTrialPath();
  const port = Number(new URL(LICENSE_API).port);

  let reply = null; // what the fake server answers; null = no server running
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const action = (() => { try { return JSON.parse(body).action; } catch { return ''; } })();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply && reply[action] ? reply[action] : { status: 'error' }));
    });
  });
  const online = (map) => new Promise((r) => { reply = map; server.listening ? r() : server.listen(port, '127.0.0.1', r); });
  const offline = () => new Promise((r) => { reply = null; server.listening ? server.close(() => r()) : r(); });

  const realLicense = fs.readFileSync(process.env.M13_TEST_LICENSE_FILE, 'utf8');
  // verifiedDaysAgo decides whether the app is due an online check (it only
  // re-checks a licence every VERIFY_INTERVAL_MS — 7 days).
  const setLicensed = (verifiedDaysAgo = 0) => {
    const data = JSON.parse(realLicense);
    data.lastVerifiedAt = new Date(Date.now() - verifiedDaysAgo * trialLib.DAY_MS).toISOString();
    fs.writeFileSync(licensePath, JSON.stringify(data));
  };
  const clearLicense = () => { try { fs.unlinkSync(licensePath); } catch {} };
  const setTrial = (startDaysAgo, { tamper = false } = {}) => {
    const startMs = Date.now() - startDaysAgo * trialLib.DAY_MS;
    trialLib.writeTrialFile(trialPath, getMachineId(), {
      startLocalDate: trialLib.localDateString(startMs),
      startedAt: new Date(startMs).toISOString(),
      hardEndsAt: new Date(startMs + 14 * trialLib.DAY_MS).toISOString(),
      converted: false,
      maxSeenMs: Date.now(),
    });
    if (tamper) {
      const data = JSON.parse(fs.readFileSync(trialPath, 'utf8'));
      data.startLocalDate = trialLib.localDateString(Date.now());  // "restart" it by hand
      fs.writeFileSync(trialPath, JSON.stringify(data));
    }
  };
  const reset = () => { clearLicense(); trialLib.removeTrialFile(trialPath); _entitlement = null; };
  const state = async () => { _entitlement = null; return refreshEntitlement(); };
  const lockedNow = async () => {
    const r = await invoke('crates-delete', '__m13_phase5_no_such_crate__');
    return !!(r && r.locked);
  };
  const trialServerAnswer = (extra = {}) => ({
    trial: {
      status: 'active', day: 1, daysTotal: 13, daysLeft: 13,
      startLocalDate: trialLib.localDateString(Date.now()),
      startedAt: new Date().toISOString(),
      hardEndsAt: new Date(Date.now() + 14 * trialLib.DAY_MS).toISOString(),
      serverTime: new Date().toISOString(), converted: false, ...extra,
    },
  });

  // ── A licensed Mac ─────────────────────────────────────────────────────────
  reset(); setLicensed();
  await offline();
  let e = await state();
  check('licensed + no internet → still licensed, everything works', e.kind === 'licensed' && e.canChange === true, e);
  check('licensed → no trial file is ever created', !fs.existsSync(trialPath));
  check('licensed → a locked action runs normally', (await lockedNow()) === false);

  await online({ check: { status: 'valid', preOrder: false } });
  e = await state();
  check('licensed + server says valid → still licensed', e.kind === 'licensed' && e.canChange === true, e);
  check('licensed → the licence file is kept', fs.existsSync(licensePath));

  // ── A refunded / switched-off key ──────────────────────────────────────────
  // Today's behaviour (unchanged since 1.0.1): a licence is only re-checked with
  // the server every 7 days, so a refund can take that long to bite.
  reset(); setLicensed(0.1);                      // checked ~2.5 hours ago
  await online({ check: { status: 'invalid' } });
  e = await state();
  check('refunded key, checked a couple of hours ago → still works until the next check', e.kind === 'licensed', e);
  check('…and the licence file is still there', fs.existsSync(licensePath));

  reset(); setLicensed(0.6);                        // the weekly check is due
  await online({ check: { status: 'invalid' } });
  e = await state();
  check('refunded key, 14 hours later → licence removed from this Mac', !fs.existsSync(licensePath));
  check('refunded key, no trial ever → asks to start one, and is read-only', e.kind === 'none' && e.canChange === false, e);
  check('refunded key → locked actions refuse', (await lockedNow()) === true);

  reset(); setLicensed(0.6); setTrial(20);          // an old trial, long finished
  await online({ check: { status: 'invalid' } });
  e = await state();
  check('refunded key with an old trial → read-only, not a fresh trial', e.kind === 'expired' && e.canChange === false, e);

  reset(); setLicensed(0.6);
  await offline();
  e = await state();
  check('check due but no internet → keeps working (never locked out on a plane)', e.kind === 'licensed' && e.canChange === true, e);

  // ── Trials without internet ────────────────────────────────────────────────
  reset(); setTrial(0);
  await offline();
  e = await state();
  check('day 1, no internet → trial keeps working', e.kind === 'trial' && e.day === 1 && e.canChange === true, e);
  check('day 1 offline → actions run normally', (await lockedNow()) === false);

  reset(); setTrial(12);
  e = await state();
  check('day 13, no internet → still on, 1 day left', e.kind === 'trial' && e.day === 13 && e.daysLeft === 1, e);

  reset(); setTrial(13);
  e = await state();
  check('day 14, no internet → read-only', e.kind === 'expired' && e.canChange === false, e);
  check('day 14 offline → locked actions refuse', (await lockedNow()) === true);

  reset();
  e = await state();
  const startOffline = await invoke('start-trial');
  check('no trial + no internet → can’t start, and says why', startOffline.ok === false && /internet/i.test(startOffline.message || ''), startOffline);
  check('…and the Mac is not left half-started', (await state()).kind === 'none' && !fs.existsSync(trialPath));

  await online({ trial: { status: 'nonsense' } });   // server answers, but can't help
  const serverBad = await invoke('start-trial');
  check('server reachable but unhappy → says "try again", not "check your connection"',
    serverBad.ok === false && serverBad.error === 'server' && /try again/i.test(serverBad.message || '') && !/connection/i.test(serverBad.message || ''), serverBad);

  await online(trialServerAnswer());
  const started = await invoke('start-trial');
  check('back online → starting the trial works', started.ok === true && started.entitlement.kind === 'trial' && started.entitlement.day === 1, started);

  // ── Hand-edited trial file ─────────────────────────────────────────────────
  reset(); setTrial(20, { tamper: true });
  await offline();
  e = await state();
  check('trial file edited to look new, offline → read-only', e.kind === 'expired' && e.unverified === true && e.canChange === false, e);
  await online({ trial: { ...trialServerAnswer().trial, status: 'expired', day: 21, daysLeft: 0, startLocalDate: trialLib.localDateString(Date.now() - 20 * trialLib.DAY_MS), startedAt: new Date(Date.now() - 20 * trialLib.DAY_MS).toISOString(), hardEndsAt: new Date(Date.now() - 6 * trialLib.DAY_MS).toISOString() } });
  await syncTrialWithServer();
  e = await state();
  check('…and the server confirms it really ended', e.kind === 'expired' && e.canChange === false, e);

  await offline();
  reset();
  const failed = results.filter((r) => !r.pass);
  console.log(JSON.stringify({ selftest: 'phase5', passed: results.length - failed.length, failed: failed.length, results }, null, 2));
  return failed.length ? 1 : 0;
}
