const { app, BrowserWindow, Menu, shell, dialog, ipcMain, session, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const url = require('url');
const { Transform } = require('stream');
const crypto = require('crypto');
const { YIN } = require('pitchfinder');

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

const LICENSE_API = 'https://m13app.com/.netlify/functions/license';

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

const VERIFY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
    fs.createReadStream(filePath, {
      start: pcmInfo.start + dataStart,
      end: pcmInfo.start + dataEnd,
    }).pipe(res);
    return;
  }

  // Byte-swapping needs whole samples, so read a sample-aligned superset of the
  // requested range, swap it, then trim back down to exactly what was asked for.
  const alignedStart = Math.floor(dataStart / bytesPerSample) * bytesPerSample;
  const alignedEndExclusive = Math.min(
    pcmInfo.size,
    (Math.floor(dataEnd / bytesPerSample) + 1) * bytesPerSample,
  );

  fs.createReadStream(filePath, {
    start: pcmInfo.start + alignedStart,
    end: pcmInfo.start + alignedEndExclusive - 1,
  })
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
    height: 420,
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
  .logo{font-size:52px;font-weight:900;color:#c8f135;letter-spacing:-0.05em;line-height:1;margin-bottom:4px}
  .dot{width:8px;height:8px;border-radius:50%;background:#c8f135;box-shadow:0 0 10px rgba(200,241,53,0.5);margin:0 auto 18px}
  .app-name{font-size:17px;font-weight:700;color:#efefef;margin-bottom:4px}
  .version{font-size:12px;color:#666;margin-bottom:18px;font-variant-numeric:tabular-nums}
  .tagline{font-size:13px;color:#bdbdbd;line-height:1.55;margin-bottom:6px}
  .desc{font-size:12px;color:#666;line-height:1.5;margin-bottom:24px;font-style:italic}
  .divider{width:40px;height:1px;background:#222;margin:0 auto 20px}
  .built-by{font-size:12px;color:#555;margin-bottom:6px}
  a{color:#c8f135;text-decoration:none;font-size:12px;font-weight:600;-webkit-app-region:no-drag}
  a:hover{text-decoration:underline;text-underline-offset:3px}
</style>
</head>
<body>
  <div class="logo">M13</div>
  <div class="dot"></div>
  <div class="app-name">DJ Library &amp; Discovery</div>
  <div class="version">Version 1.0.0</div>
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
  app.setName('M13');
  Menu.setApplicationMenu(buildMenu());

  session.defaultSession.protocol.registerFileProtocol('file', (request, callback) => {
    const url = new URL(request.url);
    callback({ path: decodeURIComponent(url.pathname) });
  });

  const server = http.createServer((req, res) => {
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

      const ext = path.extname(filePath).toLowerCase();

      if (ext === '.aif' || ext === '.aiff') {
        streamAiffAsWav(filePath, req, res);
        return;
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

        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });

      fs.createReadStream(filePath).pipe(res);
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
  const km = kind & 0xFE;
  if (km === 0x40) {
    const len = buf[off + 1] || 0;
    return buf.slice(off + 2, off + 2 + len).toString('ascii').replace(/\0/g, '');
  }
  if (km === 0x90) {
    const len = (buf[off + 1] || 0) * 2;
    return buf.slice(off + 2, off + 2 + len).toString('utf16le').replace(/\0/g, '');
  }
  const len = (kind - 1) >> 1;
  return buf.slice(off + 1, off + 1 + len).toString('ascii').replace(/\0/g, '');
}

function getPdbRowOffsets(page, numRows) {
  const PAGE = 4096;
  const ng = Math.ceil(numRows / 16);
  const rows = [];
  for (let g = 0; g < ng; g++) {
    const gOff = PAGE - (g + 1) * 36;
    for (let i = 0; i < 16; i++) {
      if (g * 16 + i >= numRows) continue;
      const slot = 15 - i;
      const rOff = page.readUInt16LE(gOff + slot * 2);
      if (rOff !== 0xFFFF) rows.push({ row: g * 16 + i, absOff: 40 + rOff });
    }
  }
  return rows.sort((a, b) => a.absOff - b.absOff);
}

function parsePDB(filePath) {
  const buf = fs.readFileSync(filePath);
  const PAGE = 4096;
  const numPages = Math.floor(buf.length / PAGE);
  const artists = new Map();
  const tracks = new Map();
  const histPlaylists = new Map();
  const histEntries = [];

  for (let pi = 0; pi < numPages; pi++) {
    const off = pi * PAGE;
    const ptype = buf.readUInt32LE(off + 8);
    const numRows = buf[off + 24];
    if (!numRows) continue;
    const page = buf.slice(off, off + PAGE);

    if (ptype === 2) {
      // ARTISTS: id at row+4, name at row+10
      for (const { absOff } of getPdbRowOffsets(page, numRows)) {
        const id = page.readUInt32LE(absOff + 4);
        const name = readDSString(page, absOff + 10);
        if (id) artists.set(id, name);
      }
    } else if (ptype === 0) {
      // TRACKS: artist_id at +0x24, bpm*100 at +0x38, track_id at +0x48, title ptr at +0x80
      const rows = getPdbRowOffsets(page, numRows);
      for (let ri = 0; ri < rows.length; ri++) {
        const rs = rows[ri].absOff;
        const re = ri + 1 < rows.length ? rows[ri + 1].absOff : PAGE - Math.ceil(numRows / 16) * 36;
        if (re - rs < 0x88) continue;
        const artistId = page.readUInt32LE(rs + 0x24);
        const bpm = page.readUInt32LE(rs + 0x38);
        const trackId = page.readUInt32LE(rs + 0x48);
        const titleOff = rs + page.readUInt16LE(rs + 0x80);
        const title = titleOff > rs && titleOff < PAGE ? readDSString(page, titleOff) : '';
        if (trackId) tracks.set(trackId, { title, artistId, bpm });
      }
    } else if (ptype === 11) {
      // HISTORY_PLAYLISTS: id at row+0, name at row+4
      for (const { absOff } of getPdbRowOffsets(page, numRows)) {
        const id = page.readUInt32LE(absOff);
        const name = readDSString(page, absOff + 4);
        if (id) histPlaylists.set(id, name);
      }
    } else if (ptype === 12) {
      // HISTORY_ENTRIES: fixed 12-byte rows: track_id, playlist_id, entry_index
      for (let r = 0; r < numRows; r++) {
        const rs = 40 + r * 12;
        if (rs + 12 > PAGE) break;
        const trackId = page.readUInt32LE(rs);
        const playlistId = page.readUInt32LE(rs + 4);
        const entryIndex = page.readUInt32LE(rs + 8);
        if (trackId) histEntries.push({ trackId, playlistId, entryIndex });
      }
    }
  }

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
        // Re-use low-level PDB parse to get raw maps (not flattened entries)
        const buf = fs.readFileSync(pdbPath);
        const PAGE = 4096;
        const numPages = Math.floor(buf.length / PAGE);

        for (let pi = 0; pi < numPages; pi++) {
          const off = pi * PAGE;
          const ptype = buf.readUInt32LE(off + 8);
          const numRows = buf[off + 24];
          if (!numRows) continue;
          const page = buf.slice(off, off + PAGE);

          if (ptype === 2) {
            for (const { absOff } of getPdbRowOffsets(page, numRows)) {
              const id = page.readUInt32LE(absOff + 4);
              const name = readDSString(page, absOff + 10);
              if (id) allArtists.set(id, name);
            }
          } else if (ptype === 0) {
            const rows = getPdbRowOffsets(page, numRows);
            for (let ri = 0; ri < rows.length; ri++) {
              const rs = rows[ri].absOff;
              const re = ri + 1 < rows.length ? rows[ri + 1].absOff : PAGE - Math.ceil(numRows / 16) * 36;
              if (re - rs < 0x88) continue;
              const artistId = page.readUInt32LE(rs + 0x24);
              const bpm = page.readUInt32LE(rs + 0x38);
              const trackId = page.readUInt32LE(rs + 0x48);
              const titleOff = rs + page.readUInt16LE(rs + 0x80);
              const title = titleOff > rs && titleOff < PAGE ? readDSString(page, titleOff) : '';
              if (trackId) allTracks.set(trackId, { title, artistId, bpm });
            }
          } else if (ptype === 11) {
            for (const { absOff } of getPdbRowOffsets(page, numRows)) {
              const id = page.readUInt32LE(absOff);
              const name = readDSString(page, absOff + 4);
              if (id) allHistPlaylists.set(id, name);
            }
          } else if (ptype === 12) {
            for (let r = 0; r < numRows; r++) {
              const rs = 40 + r * 12;
              if (rs + 12 > PAGE) break;
              const trackId = page.readUInt32LE(rs);
              const playlistId = page.readUInt32LE(rs + 4);
              const entryIndex = page.readUInt32LE(rs + 8);
              if (trackId) allHistEntries.push({ trackId, playlistId, entryIndex });
            }
          }
        }
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

ipcMain.handle('check-license', async () => {
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
});

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
    if (data.status === 'success') clearStoredLicense();
    return data;
  } catch {
    return { status: 'server-error', message: 'Could not reach server. Try again.' };
  }
});
