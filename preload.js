const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('m13', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  scanFolder: (folderPath) => ipcRenderer.invoke('scan-folder', folderPath),
  getAudioUrl: (filePath) => ipcRenderer.invoke('get-audio-url', filePath),
  detectTuning: (windows, sampleRate) => ipcRenderer.invoke('detect-tuning', { windows, sampleRate }),
  convertTuning: (filePath, targetHz, destFolder) => ipcRenderer.invoke('convert-tuning', { filePath, targetHz, destFolder }),
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
  selectConvertDest: () => ipcRenderer.invoke('select-convert-dest'),
  copyTrack: (srcPath, destFolder) => ipcRenderer.invoke('copy-track', { srcPath, destFolder }),
  copyTrackNumbered: (srcPath, destFolder, trackNumber, title) => ipcRenderer.invoke('copy-track-numbered', { srcPath, destFolder, trackNumber, title }),
  exportTrackConverted: (opts) => ipcRenderer.invoke('export-track-converted', opts),
  ensureExportFolder: (parent, folderName) => ipcRenderer.invoke('ensure-export-folder', { parent, folderName }),
  onCopyProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('copy-progress', handler);
    return () => ipcRenderer.removeListener('copy-progress', handler);
  },
  installUpdate: () => ipcRenderer.invoke('install-update'),
  checkForUpdatesNow: () => ipcRenderer.invoke('check-for-updates-now'),
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
  onCheckForUpdates: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('check-for-updates', handler);
    return () => ipcRenderer.removeListener('check-for-updates', handler);
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
  onMenuLibraryLocations: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('menu-library-locations', handler);
    return () => ipcRenderer.removeListener('menu-library-locations', handler);
  },
  onMenuConvertFolder: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('menu-convert-folder', handler);
    return () => ipcRenderer.removeListener('menu-convert-folder', handler);
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
  searchArtwork: (track) => ipcRenderer.invoke('search-artwork', track),
  embedArtwork: (filePath, imageUrl) => ipcRenderer.invoke('embed-artwork', { filePath, imageUrl }),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  markVersionSeen: (version) => ipcRenderer.invoke('mark-version-seen', version),
  onShowWhatsNew: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('show-whats-new', handler);
    return () => ipcRenderer.removeListener('show-whats-new', handler);
  },
  onOpenFeatureTour: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('open-feature-tour', handler);
    return () => ipcRenderer.removeListener('open-feature-tour', handler);
  },
  revealInFinder: (filePath) => ipcRenderer.invoke('reveal-in-finder', filePath),
  deleteTrackFile: (filePath) => ipcRenderer.invoke('delete-track-file', filePath),
  locationsList: () => ipcRenderer.invoke('locations-list'),
  locationsAdd: (folderPath) => ipcRenderer.invoke('locations-add', folderPath),
  locationsRemove: (id) => ipcRenderer.invoke('locations-remove', id),
  locationsRescan: (id) => ipcRenderer.invoke('locations-rescan', id),
  libraryLoad: () => ipcRenderer.invoke('library-load'),
  libraryAddFiles: () => ipcRenderer.invoke('library-add-files'),
  removedFoldersList: () => ipcRenderer.invoke('removed-folders-list'),
  removedFoldersSave: (list) => ipcRenderer.invoke('removed-folders-save', list),
  loadSessionState: () => ipcRenderer.invoke('load-session-state'),
  saveSessionState: (state) => ipcRenderer.invoke('save-session-state', state),
  sessionsList: () => ipcRenderer.invoke('sessions-list'),
  sessionsSave: (name, folderPaths, excludedPaths, overwriteId) => ipcRenderer.invoke('sessions-save', { name, folderPaths, excludedPaths, overwriteId }),
  chooseOption: (opts) => ipcRenderer.invoke('choose-option', opts),
  cratesList: () => ipcRenderer.invoke('crates-list'),
  cratesSave: (name, trackPaths, overwriteId) => ipcRenderer.invoke('crates-save', { name, trackPaths, overwriteId }),
  cratesDelete: (id) => ipcRenderer.invoke('crates-delete', id),
  sessionsDelete: (id) => ipcRenderer.invoke('sessions-delete', id),
  loadColumnConfig: () => ipcRenderer.invoke('load-column-config'),
  saveColumnConfig: (hiddenColumns) => ipcRenderer.invoke('save-column-config', hiddenColumns),
  loadTuningCache: () => ipcRenderer.invoke('load-tuning-cache'),
  saveTuningCache: (cache) => ipcRenderer.invoke('save-tuning-cache', cache),
  loadMissing: () => ipcRenderer.invoke('load-missing'),
  saveMissing: (missing) => ipcRenderer.invoke('save-missing', missing),
});