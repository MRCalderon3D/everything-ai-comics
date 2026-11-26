'use strict';
/** scripts/lib/zip.js: archive layout, CRC-32, round trip, determinism. */

const assert = require('assert');
const zlib = require('zlib');
const { createZip, readZip, dosDateTime } = require('../scripts/lib/zip');
const { crc32 } = require('../scripts/lib/crc32');
const { solidPng } = require('./fixtures/publishing/helpers');

const image = solidPng(8, 12, 'rgb', [200, 200, 200]);
const xml = '<?xml version="1.0"?>\n<ComicInfo><Title>Crossing</Title></ComicInfo>\n'.repeat(20);
const entries = [
  { name: '001.png', data: image },
  { name: 'notes/señal-夜.txt', data: 'Bow is screen left.' },
  { name: 'ComicInfo.xml', data: xml, compress: true },
  { name: 'empty.bin', data: Buffer.alloc(0) },
];

const archive = createZip(entries);

// --- layout, read by hand ----------------------------------------------------------

{
  // First local header sits at offset 0.
  assert.strictEqual(archive.readUInt32LE(0), 0x04034B50, 'local file header signature');
  assert.strictEqual(archive.readUInt16LE(6) & 0x0800, 0x0800, 'UTF-8 name flag');
  assert.strictEqual(archive.readUInt16LE(8), 0, 'first entry is stored');
  assert.strictEqual(archive.readUInt32LE(14), crc32(image), 'CRC-32 in the local header');
  assert.strictEqual(archive.readUInt32LE(18), image.length, 'compressed size equals size when stored');
  assert.strictEqual(archive.readUInt32LE(22), image.length);
  const nameLength = archive.readUInt16LE(26);
  assert.strictEqual(archive.toString('utf8', 30, 30 + nameLength), '001.png');
  assert.ok(archive.subarray(30 + nameLength, 30 + nameLength + image.length).equals(image), 'stored bytes are the file bytes');

  // End of central directory: last 22 bytes (no archive comment).
  const end = archive.length - 22;
  assert.strictEqual(archive.readUInt32LE(end), 0x06054B50, 'end of central directory signature');
  assert.strictEqual(archive.readUInt16LE(end + 8), entries.length, 'entries on this disk');
  assert.strictEqual(archive.readUInt16LE(end + 10), entries.length, 'entries in total');
  const centralSize = archive.readUInt32LE(end + 12);
  const centralOffset = archive.readUInt32LE(end + 16);
  assert.strictEqual(centralOffset + centralSize, end, 'central directory ends where the end record starts');
  assert.strictEqual(archive.readUInt32LE(centralOffset), 0x02014B50, 'central directory signature');

  // Walk the central directory: every entry points at a local header.
  let pos = centralOffset;
  for (const entry of entries) {
    assert.strictEqual(archive.readUInt32LE(pos), 0x02014B50);
    const length = archive.readUInt16LE(pos + 28);
    assert.strictEqual(archive.toString('utf8', pos + 46, pos + 46 + length), entry.name);
    const offset = archive.readUInt32LE(pos + 42);
    assert.strictEqual(archive.readUInt32LE(offset), 0x04034B50, `${entry.name}: local header offset`);
    assert.strictEqual(archive.readUInt32LE(pos + 16), archive.readUInt32LE(offset + 14), `${entry.name}: both headers carry the same CRC`);
    pos += 46 + length;
  }
  assert.strictEqual(pos, end);
}

// --- round trip ---------------------------------------------------------------------

{
  const read = readZip(archive);
  assert.deepStrictEqual(read.map((e) => e.name), entries.map((e) => e.name), 'names and order survive');
  assert.ok(read[0].data.equals(image));
  assert.strictEqual(read[0].method, 0);
  assert.strictEqual(read[0].crc32, crc32(image));
  assert.strictEqual(read[1].data.toString('utf8'), 'Bow is screen left.');
  assert.strictEqual(read[2].method, 8, 'compress: true deflates');
  assert.strictEqual(read[2].data.toString('utf8'), xml);
  assert.ok(read[2].compressedSize < read[2].size, 'deflate made the XML smaller');
  assert.strictEqual(read[2].crc32, crc32(Buffer.from(xml)));
  assert.strictEqual(read[3].size, 0);
  assert.strictEqual(read[3].crc32, 0);
  if (typeof zlib.crc32 === 'function') {
    for (const entry of read) assert.strictEqual(entry.crc32, zlib.crc32(entry.data), `${entry.name}: CRC agrees with zlib`);
  }
  // Every entry carries the fixed 1980-01-01 00:00:00 stamp.
  for (const entry of read) {
    assert.strictEqual(entry.dosTime, 0);
    assert.strictEqual(entry.dosDate, (1 << 5) | 1);
  }
  assert.deepStrictEqual(readZip(createZip([])), [], 'empty archive');
}

// --- determinism and timestamps ---------------------------------------------------------

{
  assert.ok(createZip(entries).equals(archive), 'same input, same bytes');
  const dated = readZip(createZip([{ name: 'a.txt', data: 'a' }], { date: new Date(Date.UTC(2026, 10, 26, 10, 30, 44)) }));
  assert.strictEqual(dated[0].dosDate, ((2026 - 1980) << 9) | (11 << 5) | 26);
  assert.strictEqual(dated[0].dosTime, (10 << 11) | (30 << 5) | 22);
  assert.deepStrictEqual(dosDateTime(new Date(Date.UTC(1970, 0, 1))), { time: 0, date: 33 }, 'dates before 1980 clamp');
}

// --- errors -------------------------------------------------------------------------

{
  const broken = Buffer.from(archive);
  broken[40] ^= 0xFF; // a byte of the first stored file
  assert.throws(() => readZip(broken), /CRC mismatch for "001.png"/);
  assert.throws(() => readZip(Buffer.from('this is not a zip archive at all, sorry')), /end of central directory not found/);
  assert.throws(() => createZip([{ name: 'a', data: '1' }, { name: 'a', data: '2' }]), /duplicate entry name/);
  assert.throws(() => createZip([{ name: '../escape.txt', data: '' }]), /relative path inside the archive/);
  assert.throws(() => createZip([{ name: '/abs.txt', data: '' }]), /relative path inside the archive/);
  assert.throws(() => createZip([{ name: 'back\\slash.txt', data: '' }]), /forward slashes/);
  assert.throws(() => createZip([{ name: '', data: '' }]), /non-empty string/);
}

console.log('zip: OK');
