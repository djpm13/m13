const { app } = require('electron');
const path = require('path');

let musicMetadataPromise;
function getMusicMetadata() {
  if (!musicMetadataPromise) musicMetadataPromise = import('music-metadata');
  return musicMetadataPromise;
}

async function readTrackTags(filePath) {
  try {
    const musicMetadata = await getMusicMetadata();
    const metadata = await musicMetadata.parseFile(filePath, { skipCovers: true });
    const common = metadata.common || {};
    return {
      artist: Array.isArray(common.artist) ? common.artist.join(', ') : common.artist || '',
      bpm: common.bpm || '',
    };
  } catch (error) {
    return { artist: '', bpm: '', error: error.message };
  }
}

app.whenReady().then(async () => {
  const target = '/Volumes/BACKUP/MUSIC/2025/Minimal Tech #2/Alec Lino - Maharaja (Original Mix).aiff';
  console.log('RESULT:', JSON.stringify(await readTrackTags(target)));
  app.quit();
  process.exit(0);
});
