const { contextBridge, ipcRenderer } = require('electron');

// Free trial (2.2): main.js refuses these once the trial has ended. When it
// does, tell the page so it can show the Buy / Enter key prompt.
// tests/trial.test.js checks this list matches LOCKED_AFTER_TRIAL in main.js.
const LOCKED_AFTER_TRIAL = new Set([
  'library-add-files', 'locations-add', 'locations-remove', 'delete-track-file',
  'copy-folder', 'copy-track', 'copy-track-numbered', 'ensure-export-folder', 'export-track-converted',
  'export-catalogue', 'export-set', 'save-playlist-file', 'save-tracklist', 'save-set-tags',
  'convert-tuning', 'save-metadata', 'embed-artwork', 'search-artwork', 'apply-brand-artwork', 'prepare-brand-image',
  'crates-save', 'crates-delete', 'sessions-save', 'sessions-delete', 'save-bangers', 'save-track-state',
]);

async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (LOCKED_AFTER_TRIAL.has(channel) && result && result.locked) window.dispatchEvent(new Event('m13-locked'));
  return result;
}

contextBridge.exposeInMainWorld('m13', {
  selectFolder: () => invoke('select-folder'),
  scanFolder: (folderPath) => invoke('scan-folder', folderPath),
  getAudioUrl: (filePath) => invoke('get-audio-url', filePath),
  detectTuning: (windows, sampleRate) => invoke('detect-tuning', { windows, sampleRate }),
  convertTuning: (filePath, targetHz, destFolder) => invoke('convert-tuning', { filePath, targetHz, destFolder }),
  getMetadata: (filePath) => invoke('get-metadata', filePath),
  getArtwork: (filePath) => invoke('get-artwork', filePath),
  getLastFolder: () => invoke('get-last-folder'),
  saveLastFolder: (folderPath) => invoke('save-last-folder', folderPath),
  saveMetadata: (filePath, fields) => invoke('save-metadata', { filePath, fields }),
  scanSets: () => invoke('scan-sets'),
  scanRekordbox: (opts) => invoke('scan-rekordbox', opts),
  scanHistory: () => invoke('scan-history'),
  matchHistory: (opts) => invoke('match-history', opts),
  saveTracklist: (opts) => invoke('save-tracklist', opts),
  getSetTags: (filePath) => invoke('get-set-tags', filePath),
  saveSetTags: (filePath, tags) => invoke('save-set-tags', { filePath, tags }),
  exportSet: (srcPath, destFolder, setName, tags) => invoke('export-set', { srcPath, destFolder, setName, tags }),
  onSetExportProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('set-export-progress', handler);
    return () => ipcRenderer.removeListener('set-export-progress', handler);
  },
  exportCatalogue: (tracks, libraryFolder) => invoke('export-catalogue', { tracks, libraryFolder }),
  selectFolderFrom: (defaultPath) => invoke('select-folder-from', defaultPath),
  copyFolder: (srcFolder, destFolder) => invoke('copy-folder', { srcFolder, destFolder }),
  onFolderCopyProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('folder-copy-progress', handler);
    return () => ipcRenderer.removeListener('folder-copy-progress', handler);
  },
  savePlaylistFile: (opts) => invoke('save-playlist-file', opts),
  listDirectory: (dirPath) => invoke('list-directory', dirPath),
  onScanProgress: (callback) => {
    const handler = (_event, count) => callback(count);
    ipcRenderer.on('scan-progress', handler);
    return () => ipcRenderer.removeListener('scan-progress', handler);
  },
  selectDestFolder: () => invoke('select-dest-folder'),
  selectConvertDest: () => invoke('select-convert-dest'),
  copyTrack: (srcPath, destFolder) => invoke('copy-track', { srcPath, destFolder }),
  copyTrackNumbered: (srcPath, destFolder, trackNumber, title) => invoke('copy-track-numbered', { srcPath, destFolder, trackNumber, title }),
  exportTrackConverted: (opts) => invoke('export-track-converted', opts),
  ensureExportFolder: (parent, folderName) => invoke('ensure-export-folder', { parent, folderName }),
  onCopyProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('copy-progress', handler);
    return () => ipcRenderer.removeListener('copy-progress', handler);
  },
  installUpdate: () => invoke('install-update'),
  checkForUpdatesNow: () => invoke('check-for-updates-now'),
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
  onMenuTutorial: (callback) => {
    ipcRenderer.on('open-tutorial', callback);
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
  loadBangers: () => invoke('load-bangers'),
  saveBangers: (bangers) => invoke('save-bangers', bangers),
  loadTrackState: () => invoke('load-track-state'),
  saveTrackState: (state) => invoke('save-track-state', state),
  scanArtwork: (paths) => invoke('scan-artwork', { paths }),
  getBrandDefault: () => invoke('get-brand-default'),
  pickBrandImage: () => invoke('pick-brand-image'),
  prepareBrandImage: (sourcePath, size) => invoke('prepare-brand-image', { sourcePath, size }),
  applyBrandArtwork: (opts) => invoke('apply-brand-artwork', opts),
  onBrandArtworkProgress: (cb) => ipcRenderer.on('brand-artwork-progress', (_e, d) => cb(d)),
  getMachineId: () => invoke('get-machine-id'),
  getLicenseInfo: () => invoke('get-license-info'),
  checkLicense: () => invoke('check-license'),
  activateLicense: (key) => invoke('activate-license', key),
  transferLicense: (key) => invoke('transfer-license', key),
  // Free trial (2.2): { kind: 'licensed' | 'trial' | 'expired' | 'none', day, daysLeft, canChange, … }
  getEntitlement: () => invoke('get-entitlement'),
  startTrial: () => invoke('start-trial'),
  openBuyPage: () => invoke('open-buy-page'),
  onEntitlementChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('entitlement-changed', handler);
    return () => ipcRenderer.removeListener('entitlement-changed', handler);
  },
  onOpenLicenseInfo: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('open-license-info', handler);
    return () => ipcRenderer.removeListener('open-license-info', handler);
  },
  searchArtwork: (track) => invoke('search-artwork', track),
  embedArtwork: (filePath, imageUrl) => invoke('embed-artwork', { filePath, imageUrl }),
  getAppVersion: () => invoke('get-app-version'),
  markVersionSeen: (version) => invoke('mark-version-seen', version),
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
  revealInFinder: (filePath) => invoke('reveal-in-finder', filePath),
  deleteTrackFile: (filePath) => invoke('delete-track-file', filePath),
  locationsList: () => invoke('locations-list'),
  locationsAdd: (folderPath) => invoke('locations-add', folderPath),
  locationsRemove: (id) => invoke('locations-remove', id),
  locationsRescan: (id) => invoke('locations-rescan', id),
  libraryLoad: () => invoke('library-load'),
  libraryAddFiles: () => invoke('library-add-files'),
  appleMusicLoad: () => invoke('applemusic-load'),
  appleMusicLocate: () => invoke('applemusic-locate'),
  removedFoldersList: () => invoke('removed-folders-list'),
  removedFoldersSave: (list) => invoke('removed-folders-save', list),
  loadSessionState: () => invoke('load-session-state'),
  saveSessionState: (state) => invoke('save-session-state', state),
  sessionsList: () => invoke('sessions-list'),
  sessionsSave: (name, folderPaths, excludedPaths, overwriteId) => invoke('sessions-save', { name, folderPaths, excludedPaths, overwriteId }),
  chooseOption: (opts) => invoke('choose-option', opts),
  cratesList: () => invoke('crates-list'),
  cratesSave: (name, trackPaths, overwriteId) => invoke('crates-save', { name, trackPaths, overwriteId }),
  cratesDelete: (id) => invoke('crates-delete', id),
  sessionsDelete: (id) => invoke('sessions-delete', id),
  loadColumnConfig: () => invoke('load-column-config'),
  saveColumnConfig: (hiddenColumns) => invoke('save-column-config', hiddenColumns),
  setNativeTheme: (mode) => invoke('set-native-theme', mode),
  loadWaveformCache: () => invoke('load-waveform-cache'),
  saveWaveformCache: (cache) => invoke('save-waveform-cache', cache),
  loadTuningCache: () => invoke('load-tuning-cache'),
  saveTuningCache: (cache) => invoke('save-tuning-cache', cache),
  loadMissing: () => invoke('load-missing'),
  saveMissing: (missing) => invoke('save-missing', missing),
});