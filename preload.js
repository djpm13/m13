const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('m13', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  scanFolder: (folderPath) => ipcRenderer.invoke('scan-folder', folderPath),
  getAudioUrl: (filePath) => ipcRenderer.invoke('get-audio-url', filePath),
  getMetadata: (filePath) => ipcRenderer.invoke('get-metadata', filePath),
  getArtwork: (filePath) => ipcRenderer.invoke('get-artwork', filePath),
  getLastFolder: () => ipcRenderer.invoke('get-last-folder'),
  saveLastFolder: (folderPath) => ipcRenderer.invoke('save-last-folder', folderPath),
  saveMetadata: (filePath, fields) => ipcRenderer.invoke('save-metadata', { filePath, fields }),
  scanSets: () => ipcRenderer.invoke('scan-sets'),
  scanRekordbox: (opts) => ipcRenderer.invoke('scan-rekordbox', opts),
  scanHistory: () => ipcRenderer.invoke('scan-history'),
  matchHistory: (opts) => ipcRenderer.invoke('match-history', opts),
  saveTracklist: (opts) => ipcRenderer.invoke('save-tracklist', opts),
  getSetTags: (filePath) => ipcRenderer.invoke('get-set-tags', filePath),
  saveSetTags: (filePath, tags) => ipcRenderer.invoke('save-set-tags', { filePath, tags }),
  exportSet: (srcPath, destFolder, setName, tags) => ipcRenderer.invoke('export-set', { srcPath, destFolder, setName, tags }),
  onSetExportProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('set-export-progress', handler);
    return () => ipcRenderer.removeListener('set-export-progress', handler);
  },
  exportCatalogue: (tracks, libraryFolder) => ipcRenderer.invoke('export-catalogue', { tracks, libraryFolder }),
  selectFolderFrom: (defaultPath) => ipcRenderer.invoke('select-folder-from', defaultPath),
  copyFolder: (srcFolder, destFolder) => ipcRenderer.invoke('copy-folder', { srcFolder, destFolder }),
  onFolderCopyProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('folder-copy-progress', handler);
    return () => ipcRenderer.removeListener('folder-copy-progress', handler);
  },
  savePlaylistFile: (opts) => ipcRenderer.invoke('save-playlist-file', opts),
  listDirectory: (dirPath) => ipcRenderer.invoke('list-directory', dirPath),
  onScanProgress: (callback) => {
    const handler = (_event, count) => callback(count);
    ipcRenderer.on('scan-progress', handler);
    return () => ipcRenderer.removeListener('scan-progress', handler);
  },
  selectDestFolder: () => ipcRenderer.invoke('select-dest-folder'),
  copyTrack: (srcPath, destFolder) => ipcRenderer.invoke('copy-track', { srcPath, destFolder }),
  copyTrackNumbered: (srcPath, destFolder, trackNumber, title) => ipcRenderer.invoke('copy-track-numbered', { srcPath, destFolder, trackNumber, title }),
  ensureExportFolder: (parent, folderName) => ipcRenderer.invoke('ensure-export-folder', { parent, folderName }),
  onCopyProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('copy-progress', handler);
    return () => ipcRenderer.removeListener('copy-progress', handler);
  },
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateAvailable: (callback) => {
    const handler = (_event, info) => callback(info);
    ipcRenderer.on('update-available', handler);
    return () => ipcRenderer.removeListener('update-available', handler);
  },
  onUpdateDownloadProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('update-download-progress', handler);
    return () => ipcRenderer.removeListener('update-download-progress', handler);
  },
  onUpdateDownloaded: (callback) => {
    const handler = (_event, info) => callback(info);
    ipcRenderer.on('update-downloaded', handler);
    return () => ipcRenderer.removeListener('update-downloaded', handler);
  },
  onVolumeMounted: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('volume-mounted', handler);
    return () => ipcRenderer.removeListener('volume-mounted', handler);
  },
  onVolumeUnmounted: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('volume-unmounted', handler);
    return () => ipcRenderer.removeListener('volume-unmounted', handler);
  },
  onMenuOpenLibrary: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('menu-open-library', handler);
    return () => ipcRenderer.removeListener('menu-open-library', handler);
  },
  loadBangers: () => ipcRenderer.invoke('load-bangers'),
  saveBangers: (bangers) => ipcRenderer.invoke('save-bangers', bangers),
  getMachineId: () => ipcRenderer.invoke('get-machine-id'),
  getLicenseInfo: () => ipcRenderer.invoke('get-license-info'),
  checkLicense: () => ipcRenderer.invoke('check-license'),
  activateLicense: (key) => ipcRenderer.invoke('activate-license', key),
  transferLicense: (key) => ipcRenderer.invoke('transfer-license', key),
  onOpenLicenseInfo: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('open-license-info', handler);
    return () => ipcRenderer.removeListener('open-license-info', handler);
  },
});