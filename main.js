const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const url = require('url');
const { Transform } = require('stream');

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
    const metadata = await musicMetadata.parseFile(filePath, { skipCovers: true });
    const common = metadata.common || {};

    return {
      artist: Array.isArray(common.artist) ? common.artist.join(', ') : common.artist || '',
      bpm: common.bpm || '',
      key: common.initialKey || common.key || '',
      genre: Array.isArray(common.genre) ? common.genre.join(', ') : common.genre || '',
    };
  } catch (error) {
    return { artist: '', bpm: '', key: '', genre: '' };
  }
}

async function scanFolderRecursively(folderPath, onProgress) {
  const results = [];

  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    return results;
  }

  // Never scan a PIONEER REC folder — recordings belong in the Sets view only.
  // This guards both the top-level call (user opened PIONEER REC directly) and
  // any recursive call that somehow reaches one nested deeper in the tree.
  if (path.basename(folderPath) === 'PIONEER REC') {
    return results;
  }

  const entries = fs.readdirSync(folderPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === 'PIONEER REC') continue; // recordings belong in Sets view only
      results.push(...(await scanFolderRecursively(fullPath, onProgress)));
      continue;
    }

    if (!entry.isFile() || entry.name.startsWith('._') || !isAudioFile(entry.name)) {
      continue;
    }

    const stats = fs.statSync(fullPath);

    if (stats.size < 100 * 1024) {
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    const tags = await readTrackTags(fullPath);

    results.push({
      name: path.basename(entry.name, ext),
      filename: entry.name,
      path: fullPath,
      folder: folderPath,
      size: stats.size,
      ext,
      artist: tags.artist,
      bpm: tags.bpm,
      key: tags.key,
      genre: tags.genre,
    });
    if (onProgress) onProgress(results.length);
  }

  return results;
}

app.whenReady().then(() => {
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

  server.listen(41234, '127.0.0.1', () => {
    console.log('Audio server listening on http://127.0.0.1:41234');
  });

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
  const results = await scanFolderRecursively(folderPath, onProgress);
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('scan-progress', results.length);
  return results;
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
      name: path.basename(SongFilePath, ext),
      filename: path.basename(SongFilePath),
      path: SongFilePath,
      folder: path.dirname(SongFilePath),
      size: stats.size,
      ext,
      artist: tags.artist,
      bpm: tags.bpm,
      key: tags.key,
      genre: tags.genre,
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

  return `http://127.0.0.1:41234/?path=${encodeURIComponent(filePath)}`;
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

ipcMain.handle('get-artwork', async (_event, filePath) => {
  if (!filePath) return null;
  try {
    const musicMetadata = await getMusicMetadata();
    const metadata = await musicMetadata.parseFile(filePath, { skipCovers: false });
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
    const metadata = await musicMetadata.parseFile(filePath, { skipCovers: true });
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

// node-id3 handles MP3, WAV, and AIFF (all use ID3 tags).
function saveMetadataId3(filePath, fields) {
  const tags = {};
  if (fields.title  !== undefined) tags.title      = fields.title;
  if (fields.artist !== undefined) tags.artist     = fields.artist;
  if (fields.album  !== undefined) tags.album      = fields.album;
  if (fields.year   !== undefined) tags.year       = fields.year;
  if (fields.genre  !== undefined) tags.genre      = fields.genre;
  if (fields.bpm    !== undefined) tags.bpm        = fields.bpm;
  if (fields.key    !== undefined) tags.initialKey = fields.key;

  const result = NodeID3.update(tags, filePath);
  if (result instanceof Error) throw result;
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

  // Build the new VORBIS_COMMENT block payload (type 4).
  const fieldMap = {
    TITLE:      fields.title,
    ARTIST:     fields.artist,
    ALBUM:      fields.album,
    DATE:       fields.year,
    GENRE:      fields.genre,
    BPM:        fields.bpm,
    INITIALKEY: fields.key,
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
    if (ext === '.mp3' || ext === '.wav' || ext === '.aif' || ext === '.aiff') {
      saveMetadataId3(filePath, fields);
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
        const meta = await musicMetadata.parseFile(filePath, { skipCovers: true, duration: true });
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
