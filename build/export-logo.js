#!/usr/bin/env node
/**
 * M13 logo exporter — converts SVG files to PNG at multiple resolutions.
 * Usage: node build/export-logo.js
 */

const sharp  = require('sharp');
const fs     = require('fs');
const path   = require('path');

const ROOT      = path.join(__dirname, '..');
const WEBSITE   = path.join(ROOT, '..', 'M13-website');
const OUT_DIR   = path.join(__dirname, 'logo-exports');

const LOGO_SVG      = path.join(WEBSITE, 'm13-logo.svg');
const WALLPAPER_SVG = path.join(WEBSITE, 'm13-wallpaper.svg');

const EXPORTS = [
  // App icons (square, from logo SVG)
  { src: LOGO_SVG, name: 'icon-1024.png',  w: 1024, h: 1024 },
  { src: LOGO_SVG, name: 'icon-512.png',   w: 512,  h: 512  },
  { src: LOGO_SVG, name: 'icon-256.png',   w: 256,  h: 256  },
  { src: LOGO_SVG, name: 'icon-128.png',   w: 128,  h: 128  },

  // Wallpapers (from wallpaper SVG)
  { src: WALLPAPER_SVG, name: 'wallpaper-4k.png',  w: 3840, h: 2160 },
  { src: WALLPAPER_SVG, name: 'wallpaper-hd.png',  w: 1920, h: 1080 },
  { src: WALLPAPER_SVG, name: 'wallpaper-mbp.png', w: 3024, h: 1964 }, // MacBook Pro 16"
  { src: WALLPAPER_SVG, name: 'wallpaper-mobile.png', w: 1290, h: 2796 }, // iPhone 15 Pro Max
];

async function exportAll() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const results = [];
  for (const exp of EXPORTS) {
    if (!fs.existsSync(exp.src)) {
      console.warn(`  ⚠  Source not found: ${exp.src}`);
      continue;
    }
    const outPath = path.join(OUT_DIR, exp.name);
    try {
      await sharp(exp.src, { density: Math.round((exp.w / 1024) * 300), limitInputPixels: false })
        .resize(exp.w, exp.h, { fit: 'fill' })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toFile(outPath);

      const { size } = fs.statSync(outPath);
      const kb = (size / 1024).toFixed(0);
      results.push({ name: exp.name, dims: `${exp.w}×${exp.h}`, kb });
      console.log(`  ✓  ${exp.name.padEnd(28)} ${exp.w}×${exp.h}  (${kb} KB)`);
    } catch (err) {
      console.error(`  ✗  ${exp.name}: ${err.message}`);
    }
  }

  console.log(`\nExported ${results.length}/${EXPORTS.length} files to:\n  ${OUT_DIR}\n`);

  // Also copy icon-1024 over the app build icon
  const appIcon = path.join(__dirname, 'icon_1024.png');
  const src1024  = path.join(OUT_DIR, 'icon-1024.png');
  if (fs.existsSync(src1024)) {
    fs.copyFileSync(src1024, appIcon);
    console.log(`  ↻  Copied icon-1024.png → build/icon_1024.png`);
  }
}

exportAll().catch(err => {
  console.error('Export failed:', err);
  process.exit(1);
});
