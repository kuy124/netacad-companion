// Runnable release check: validate real archive entries, not only their filenames.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {name, version} = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const allowed = ['background.js', 'content.js', 'intercept.js', 'catcher.js', 'manifest.json',
  'icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png', 'NOTICE.md', 'LICENSE-webextension-polyfill.txt'];

for (const target of ['chromium', 'firefox']) {
  const file = path.join(root, 'release', `${name}-v${version}-${target}.zip`);
  const bytes = fs.readFileSync(file);
  const entries = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 8, 'deflate compression');
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const start = offset + 30 + nameLength + bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const data = zlib.inflateRawSync(bytes.subarray(start, start + size));
    if (/\.(js|json|md|txt)$/.test(name))
      assert(!/\p{Emoji_Presentation}|\uFE0F|\u200D/u.test(data.toString('utf8')), `${name}: no emoji`);
    assert.equal(data.length, bytes.readUInt32LE(offset + 22), `${name}: size`);
    assert.equal(zlib.crc32(data) >>> 0, bytes.readUInt32LE(offset + 14), `${name}: CRC`);
    assert(!entries.has(name), 'no duplicate entries');
    entries.set(name, data);
    offset = start + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50, 'central directory exists');
  assert.deepEqual([...entries.keys()].sort(), [...allowed].sort(), 'only distribution files');
  const manifest = JSON.parse(entries.get('manifest.json').toString());
  assert.equal(manifest.version, version);
  assert.equal(manifest.name, 'NetAcad Companion');
  assert(entries.get('NOTICE.md').toString().includes('ingui-n/netacad-solver'));
  if (target === 'firefox') {
    assert.equal(manifest.browser_specific_settings.gecko.id, 'meowcad-solver@kuy124.github.io');
    assert.deepEqual(manifest.background.scripts, ['background.js']);
    assert(!manifest.background.service_worker);
    assert(fs.readFileSync(file.replace(/\.zip$/, '.xpi')).equals(bytes));
  } else assert.equal(manifest.background.service_worker, 'background.js');
}
console.log('Release archives passed: contents, versions, CRCs, attribution and browser manifests.');
