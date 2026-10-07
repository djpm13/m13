'use strict';
// Pioneer history tests — run: npm test
// Builds a tiny export.pdb in memory and reads it back with the parser in
// main.js.  1. Names and titles.  2. Which artist a track shows.
// 3. Play history: long pages, deleted plays, index pages.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
const ok = (label, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''}`); }
};

// main.js needs Electron to load, so lift the parser out of its source
const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const from = src.indexOf('function readDSString');
const to = src.indexOf("ipcMain.handle('scan-history'");
if (from < 0 || to < from) { console.log('  ✗ parser not found in main.js'); process.exit(1); }
const pdb = new Function('fs', `${src.slice(from, to)}; return { readDSString, readPDBTables, parsePDB };`)(fs);

// ── Builders ────────────────────────────────────────────────────────────────
const PAGE = 4096;
const u32 = (...nums) => { const b = Buffer.alloc(nums.length * 4); nums.forEach((n, i) => b.writeUInt32LE(n, i * 4)); return b; };
const shortStr = s => Buffer.concat([Buffer.from([((s.length + 1) << 1) | 1]), Buffer.from(s, 'ascii')]);
const longStr = (s, enc) => {
  const body = Buffer.from(s, enc);
  const head = Buffer.alloc(4);
  head[0] = enc === 'utf16le' ? 0x90 : 0x40;
  head.writeUInt16LE(body.length + 4, 1);
  return Buffer.concat([head, body]);
};
const JUNK = Buffer.from('zzzz');   // what sits after a string on a real page: the next row

function artistRow(id, name, { nameAt = 10, far = false } = {}) {
  const row = Buffer.alloc(nameAt);
  row.writeUInt16LE(far ? 0x64 : 0x60, 0);
  row.writeUInt32LE(id, 4);
  row[8] = 0x03;
  if (far) row.writeUInt16LE(nameAt, 10); else row[9] = nameAt;
  return Buffer.concat([row, name, JUNK]);
}
function trackRow(id, title, { artist = 0, originalArtist = 0, bpm = 12400 } = {}) {
  const row = Buffer.alloc(0x88);
  row.writeUInt32LE(originalArtist, 0x24);
  row.writeUInt32LE(bpm, 0x38);
  row.writeUInt32LE(artist, 0x44);
  row.writeUInt32LE(id, 0x48);
  row.writeUInt16LE(0x88, 0x80);
  return Buffer.concat([row, title, JUNK]);
}
function page(type, rows, { deleted = [], index = false } = {}) {
  const p = Buffer.alloc(PAGE);
  p.writeUInt32LE(type, 8);
  p.writeUInt16LE(rows.length, 24);
  p[27] = index ? 0x64 : 0x24;
  let off = 0;
  rows.forEach((row, i) => {
    const base = PAGE - (Math.floor(i / 16) + 1) * 36;
    row.copy(p, 40 + off);
    p.writeUInt16LE(off, base + (15 - (i % 16)) * 2);
    if (!deleted.includes(i)) p.writeUInt16LE(p.readUInt16LE(base + 32) | (1 << (i % 16)), base + 32);
    off += row.length;
  });
  return p;
}

// ── 1. Names and titles ─────────────────────────────────────────────────────
console.log('\n1. Names and titles come back exactly as written');
const read = b => pdb.readDSString(Buffer.concat([Buffer.alloc(3), b, JUNK]), 3);
const THIRTY_ONE = 'Lotus Thoughts (Scott Diaz Dub)';
const LONG = 'Chus & Ceballos, DJ Chus, Pablo Ceballos, Astrid Suryanto, David Morales '.repeat(2).trim();
ok('a short name has no extra letter on the end', read(shortStr('Stardust')) === 'Stardust', read(shortStr('Stardust')));
ok('a 31-character title keeps its first letter', THIRTY_ONE.length === 31 && read(shortStr(THIRTY_ONE)) === THIRTY_ONE, read(shortStr(THIRTY_ONE)));
ok('a name longer than 126 characters', LONG.length > 126 && read(longStr(LONG, 'ascii')) === LONG, read(longStr(LONG, 'ascii')));
ok('an accented name', read(longStr('Röyksopp', 'utf16le')) === 'Röyksopp', read(longStr('Röyksopp', 'utf16le')));
ok('an empty or unknown string is blank, not an error', read(Buffer.from([0])) === '' && read(Buffer.from([0x20, 9, 9, 9])) === '' && pdb.readDSString(Buffer.alloc(4), 99) === '');

// ── 2 + 3. A whole drive ────────────────────────────────────────────────────
const plays = [];                                 // session 2: 280 plays on one page, the 100th deleted
for (let i = 1; i <= 280; i++) plays.push(u32(i === 100 ? 4 : 1 + ((i - 1) % 3), 2, i));
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm13-pdb-test-')), 'export.pdb');
fs.writeFileSync(file, Buffer.concat([
  Buffer.alloc(PAGE),                             // file header
  page(2, [
    artistRow(7, shortStr('Stardust')),
    artistRow(8, shortStr('Chus & Ceballos, David Herrero')),
    artistRow(9, longStr('NÈO-X', 'utf16le'), { nameAt: 12 }),
    artistRow(10, longStr(LONG, 'ascii'), { nameAt: 12, far: true }),
    artistRow(11, shortStr('Deleted Artist')),
  ], { deleted: [4] }),
  page(0, [
    trackRow(1, shortStr('La Colombiana (David Herrero Remix)'), { artist: 8, originalArtist: 7, bpm: 12450 }),
    trackRow(2, shortStr('Music Sounds Better With You'), { originalArtist: 7 }),
    trackRow(3, longStr('Do You Realise? (Original Mix)', 'utf16le'), { artist: 9 }),
    trackRow(4, shortStr('Removed From The Drive'), { artist: 10 }),
  ]),
  page(11, [Buffer.concat([u32(1), shortStr('HISTORY 001')]), Buffer.concat([u32(2), shortStr('HISTORY 002')])]),
  page(12, [u32(3, 1, 1), u32(4, 1, 2)]),
  page(12, plays, { deleted: [99] }),
  page(12, [u32(1, 9, 1), u32(1, 9, 2)], { index: true }),
]));
const tables = pdb.readPDBTables(file);
const entries = pdb.parsePDB(file);
const s1 = entries.filter(e => e.session === 'HISTORY 001');
const s2 = entries.filter(e => e.session === 'HISTORY 002');

console.log('\n2. A track shows its artist, not only the original artist');
ok('a remix shows the full credit', s2[0].artist === 'Chus & Ceballos, David Herrero' && s2[0].title === 'La Colombiana (David Herrero Remix)', s2[0]);
ok('falls back to the original artist when that is all there is', s2[1].artist === 'Stardust' && s2[1].title === 'Music Sounds Better With You', s2[1]);
ok('an accented artist whose name sits further into the row', s1[0].artist === 'NÈO-X' && s1[0].title === 'Do You Realise? (Original Mix)', s1[0]);
ok('a very long artist name', s1[1].artist === LONG, s1[1]);
ok('tempo is kept', s2[0].bpm === '124.5', s2[0].bpm);
ok('a deleted artist is not read', tables.artists.size === 4 && !tables.artists.has(11), [...tables.artists.keys()]);

console.log('\n3. Every play is read, and only plays that still exist');
ok('newest session first', entries[0].session === 'HISTORY 002' && entries[entries.length - 1].session === 'HISTORY 001');
ok('a page of more than 255 plays is read to the end', s2.length === 279 && s2[s2.length - 1].playOrder === 280, s2.length);
ok('a deleted play is left out', !s2.some(e => e.playOrder === 100));
ok('plays stay in the order they were played', s2.every((e, i) => i === 0 || e.playOrder > s2[i - 1].playOrder));
ok('an index page is not mistaken for plays', entries.length === 281 && !entries.some(e => e.session === 'Session 9'), entries.length);
ok('Match History reads through the same code', /ipcMain\.handle\('match-history'[\s\S]*?readPDBTables\(pdbPath\)/.test(src) && (src.match(/readUInt32LE\(rs \+ 0x44\)/g) || []).length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
