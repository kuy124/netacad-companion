/**
 * Packages a Chromium or Firefox build without extra dependencies.
 * Firefox's unsigned .xpi contains the same bytes as its .zip.
 *
 * Use about:debugging for temporary Firefox installation, or submit the zip to AMO.
 *
 * No dependencies: the zip container is written by hand on top of node:zlib.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] || 'firefox';
if (!['chromium', 'firefox'].includes(target)) throw new Error('Use chromium or firefox.');
const srcDir = path.join(root, target === 'firefox' ? 'dist-firefox' : 'dist');
const outDir = path.join(root, 'release');

const {name, version} = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

if (!fs.existsSync(path.join(srcDir, 'manifest.json'))) {
  console.error(`${srcDir}/manifest.json is missing — build ${target} first.`);
  process.exit(1);
}

const collectFiles = (dir, prefix = '') => fs.readdirSync(dir, {withFileTypes: true})
  .sort((a, b) => a.name.localeCompare(b.name))
  .flatMap(entry => {
    const name = prefix + entry.name;

    if (entry.isDirectory())
      return collectFiles(path.join(dir, entry.name), name + '/');

    return [{name, data: fs.readFileSync(path.join(dir, entry.name))}];
  });

// Fixed 1980-01-01 timestamp: reproducible archives, and the earliest date the
// DOS zip format can express.
const DOS_TIME = 0;
const DOS_DATE = 0x21;

const buildZip = files => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const compressed = zlib.deflateRawSync(file.data, {level: 9});
    const crc = zlib.crc32(file.data) >>> 0;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);   // local file header signature
    header.writeUInt16LE(20, 4);          // version needed to extract
    header.writeUInt16LE(0, 6);           // general purpose flags
    header.writeUInt16LE(8, 8);           // compression method: deflate
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(file.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);          // extra field length

    localParts.push(header, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);  // central directory signature
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed to extract
    central.writeUInt16LE(0, 8);           // general purpose flags
    central.writeUInt16LE(8, 10);          // compression method: deflate
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);          // extra field length
    central.writeUInt16LE(0, 32);          // file comment length
    central.writeUInt16LE(0, 34);          // disk number start
    central.writeUInt16LE(0, 36);          // internal attributes
    central.writeUInt32LE(0, 38);          // external attributes
    central.writeUInt32LE(offset, 42);     // offset of local header

    centralParts.push(central, name);

    offset += header.length + name.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);        // end of central directory signature
  end.writeUInt16LE(0, 4);                 // number of this disk
  end.writeUInt16LE(0, 6);                 // disk with central directory
  end.writeUInt16LE(files.length, 8);      // entries on this disk
  end.writeUInt16LE(files.length, 10);     // total entries
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);           // offset of central directory
  end.writeUInt16LE(0, 20);                // comment length

  return Buffer.concat([...localParts, ...centralParts, end]);
};

const files = collectFiles(srcDir);
const archive = buildZip(files);

fs.mkdirSync(outDir, {recursive: true});

const base = `${name}-v${version}-${target}`;

if (target === 'firefox') fs.writeFileSync(path.join(outDir, `${base}.xpi`), archive);
fs.writeFileSync(path.join(outDir, `${base}.zip`), archive);

const checksums = fs.readdirSync(outDir).filter(file => file.startsWith(`${name}-v${version}-`) && /\.(zip|xpi)$/.test(file))
  .sort().map(name => `${createHash('sha256').update(fs.readFileSync(path.join(outDir, name))).digest('hex')}  ${name}`);
fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
console.log(`packaged ${files.length} files -> release/${base}.zip (${archive.length} bytes)`);
