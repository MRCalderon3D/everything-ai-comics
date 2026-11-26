'use strict';
/** scripts/lib/png.js and scripts/lib/image-info.js: encode, decode, headers. */

const assert = require('assert');
const zlib = require('zlib');
const png = require('../scripts/lib/png');
const { crc32 } = require('../scripts/lib/crc32');
const { imageInfo, detectFormat } = require('../scripts/lib/image-info');
const { greyJpeg, rgbJpeg } = require('./fixtures/publishing/helpers');

// --- crc32 --------------------------------------------------------------------

assert.strictEqual(crc32(Buffer.from('123456789')), 0xCBF43926, 'CRC-32 check value');
assert.strictEqual(crc32(Buffer.alloc(0)), 0);
assert.strictEqual(crc32(Buffer.from('6789'), crc32(Buffer.from('12345'))), 0xCBF43926, 'running CRC');
if (typeof zlib.crc32 === 'function') {
  const sample = Buffer.from('The Night Ferry crosses without lights.');
  assert.strictEqual(crc32(sample), zlib.crc32(sample), 'matches zlib.crc32');
}

// --- helpers --------------------------------------------------------------------

function pattern(length, max = 255) {
  const data = Buffer.alloc(length);
  for (let i = 0; i < length; i++) data[i] = ((i * 37 + 11) ^ (i >> 3)) % (max + 1);
  return data;
}

/** Rebuild a PNG from [type, data] chunks. */
function chunks(buffer) {
  const out = [];
  let pos = 8;
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    out.push([buffer.toString('latin1', pos + 4, pos + 8), buffer.subarray(pos + 8, pos + 8 + length)]);
    pos += 12 + length;
  }
  return out;
}
function assemble(list) {
  const parts = [png.SIGNATURE];
  for (const [type, data] of list) {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body));
    parts.push(head, body, tail);
  }
  return Buffer.concat(parts);
}

// --- file structure of the encoder -------------------------------------------------

{
  const width = 7;
  const height = 5;
  const data = pattern(width * height * 3);
  const file = png.encode({ width, height, data, colorType: 'rgb' });
  assert.ok(file.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])), 'signature');
  const list = chunks(file);
  assert.deepStrictEqual(list.map((c) => c[0]), ['IHDR', 'IDAT', 'IEND']);
  const ihdr = list[0][1];
  assert.strictEqual(ihdr.length, 13);
  assert.strictEqual(ihdr.readUInt32BE(0), width);
  assert.strictEqual(ihdr.readUInt32BE(4), height);
  assert.deepStrictEqual([...ihdr.subarray(8)], [8, 2, 0, 0, 0], 'bit depth 8, colour type 2, no interlace');
  // Every chunk carries the CRC of its type + data.
  let pos = 8;
  while (pos < file.length) {
    const length = file.readUInt32BE(pos);
    assert.strictEqual(file.readUInt32BE(pos + 8 + length), crc32(file.subarray(pos + 4, pos + 8 + length)));
    pos += 12 + length;
  }
  assert.strictEqual(pos, file.length, 'chunks fill the file exactly');
  // IDAT is a zlib stream of filter byte + row, per row.
  const raw = zlib.inflateSync(list[1][1]);
  assert.strictEqual(raw.length, (width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    assert.strictEqual(raw[y * (width * 3 + 1)], 0, 'filter 0 on every row');
    assert.ok(raw.subarray(y * (width * 3 + 1) + 1, (y + 1) * (width * 3 + 1)).equals(data.subarray(y * width * 3, (y + 1) * width * 3)));
  }
  assert.deepStrictEqual(png.readSize(file), { width, height });
  assert.ok(png.isPng(file));
  assert.ok(!png.isPng(Buffer.from('not a png at all')));
}

// --- round trip: every colour type, every filter, 8 and 16 bit -----------------------------

for (const [colorType, channels] of [['grey', 1], ['grey-alpha', 2], ['rgb', 3], ['rgba', 4]]) {
  for (const filter of [0, 1, 2, 3, 4]) {
    for (const bitDepth of [8, 16]) {
      const width = 9;
      const height = 6;
      const data = pattern(width * height * channels);
      const file = png.encode({ width, height, data, colorType, filter, bitDepth });
      const image = png.decode(file);
      const label = `${colorType} filter ${filter} depth ${bitDepth}`;
      assert.strictEqual(image.width, width, label);
      assert.strictEqual(image.height, height, label);
      assert.strictEqual(image.bitDepth, bitDepth, label);
      assert.strictEqual(image.colorTypeName, colorType, label);
      assert.strictEqual(image.channels, channels, label);
      assert.strictEqual(image.hasAlpha, channels === 2 || channels === 4, label);
      assert.ok(image.data.equals(data), `${label}: pixels differ after the round trip`);
    }
  }
}

// --- palette ------------------------------------------------------------------------

{
  const palette = [[0, 0, 0], [255, 255, 255], [192, 57, 43], [30, 60, 90]];
  const width = 5;
  const height = 4;
  const indices = pattern(width * height, 3);
  for (const bitDepth of [2, 4, 8]) {
    for (const filter of [0, 4]) {
      const image = png.decode(png.encode({ width, height, data: indices, colorType: 'palette', palette, bitDepth, filter }));
      assert.strictEqual(image.colorTypeName, 'palette');
      assert.strictEqual(image.channels, 3, 'opaque palette decodes to RGB');
      for (let i = 0; i < indices.length; i++) {
        assert.deepStrictEqual([...image.data.subarray(i * 3, i * 3 + 3)], palette[indices[i]], `palette depth ${bitDepth} pixel ${i}`);
      }
    }
  }
  // Palette with transparency decodes to RGBA.
  const withAlpha = [[0, 0, 0, 0], [255, 255, 255, 255], [192, 57, 43, 128]];
  const data = Buffer.from([0, 1, 2, 2, 1, 0]);
  const image = png.decode(png.encode({ width: 3, height: 2, data, colorType: 'palette', palette: withAlpha }));
  assert.strictEqual(image.channels, 4);
  assert.ok(image.hasAlpha);
  assert.deepStrictEqual([...image.data.subarray(0, 12)], [0, 0, 0, 0, 255, 255, 255, 255, 192, 57, 43, 128]);
  // One-bit palette.
  const bw = png.decode(png.encode({ width: 9, height: 1, data: Buffer.from([1, 0, 1, 1, 0, 0, 1, 0, 1]), colorType: 'palette', palette: [[10, 20, 30], [200, 210, 220]], bitDepth: 1 }));
  assert.deepStrictEqual([...bw.data.subarray(0, 6)], [200, 210, 220, 10, 20, 30]);
  assert.deepStrictEqual([...bw.data.subarray(24, 27)], [200, 210, 220], 'ninth pixel sits in the second byte');
}

// --- grey below 8 bits scales to 0..255 ------------------------------------------------

{
  const one = png.decode(png.encode({ width: 4, height: 1, data: Buffer.from([0, 1, 1, 0]), colorType: 'grey', bitDepth: 1 }));
  assert.deepStrictEqual([...one.data], [0, 255, 255, 0]);
  const two = png.decode(png.encode({ width: 4, height: 1, data: Buffer.from([0, 1, 2, 3]), colorType: 'grey', bitDepth: 2 }));
  assert.deepStrictEqual([...two.data], [0, 85, 170, 255]);
  const four = png.decode(png.encode({ width: 3, height: 2, data: Buffer.from([0, 5, 15, 15, 10, 0]), colorType: 'grey', bitDepth: 4, filter: 2 }));
  assert.deepStrictEqual([...four.data], [0, 85, 255, 255, 170, 0]);
}

// --- tRNS colour key on RGB and grey ------------------------------------------------------

{
  const data = Buffer.from([255, 0, 255, 10, 20, 30, 255, 0, 255, 40, 50, 60]);
  const list = chunks(png.encode({ width: 2, height: 2, data, colorType: 'rgb' }));
  list.splice(1, 0, ['tRNS', Buffer.from([0, 255, 0, 0, 0, 255])]); // magenta is transparent
  const image = png.decode(assemble(list));
  assert.strictEqual(image.channels, 4);
  assert.deepStrictEqual([...image.data], [255, 0, 255, 0, 10, 20, 30, 255, 255, 0, 255, 0, 40, 50, 60, 255]);

  const greyList = chunks(png.encode({ width: 3, height: 1, data: Buffer.from([7, 100, 7]), colorType: 'grey' }));
  greyList.splice(1, 0, ['tRNS', Buffer.from([0, 7])]);
  const grey = png.decode(assemble(greyList));
  assert.strictEqual(grey.channels, 2);
  assert.deepStrictEqual([...grey.data], [7, 0, 100, 255, 7, 0]);
}

// --- splitAlpha ---------------------------------------------------------------------------

{
  const rgba = png.decode(png.encode({ width: 2, height: 1, data: Buffer.from([1, 2, 3, 255, 4, 5, 6, 128]), colorType: 'rgba' }));
  const split = png.splitAlpha(rgba);
  assert.deepStrictEqual([...split.color], [1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual([...split.alpha], [255, 128]);
  assert.strictEqual(split.colorChannels, 3);
  assert.strictEqual(split.opaque, false);
  const solid = png.splitAlpha(png.decode(png.encode({ width: 1, height: 2, data: Buffer.from([9, 255, 8, 255]), colorType: 'grey-alpha' })));
  assert.strictEqual(solid.opaque, true);
  assert.strictEqual(solid.colorChannels, 1);
  const rgb = png.splitAlpha(png.decode(png.encode({ width: 1, height: 1, data: Buffer.from([1, 2, 3]), colorType: 'rgb' })));
  assert.strictEqual(rgb.alpha, null);
  assert.strictEqual(rgb.opaque, true);
}

// --- rejections ---------------------------------------------------------------------------

{
  const file = png.encode({ width: 2, height: 2, data: pattern(12), colorType: 'rgb' });

  const interlaced = chunks(file);
  interlaced[0][1] = Buffer.from(interlaced[0][1]);
  interlaced[0][1][12] = 1;
  assert.throws(() => png.decode(assemble(interlaced)), /interlaced/i);
  assert.strictEqual(png.readHeader(assemble(interlaced)).interlaced, true);

  const corrupt = Buffer.from(file);
  corrupt[corrupt.length - 20] ^= 0xFF; // inside IDAT
  assert.throws(() => png.decode(corrupt), /CRC mismatch/);

  assert.throws(() => png.decode(Buffer.from('GIF89a, definitely not a PNG file')), /not a PNG/);
  assert.throws(() => png.decode(file.subarray(0, file.length - 12)), /IEND|truncated/);
  assert.throws(() => png.readSize(Buffer.alloc(4)), /not a PNG/);

  assert.throws(() => png.encode({ width: 2, height: 2, data: Buffer.alloc(11), colorType: 'rgb' }), /expected 12 bytes/);
  assert.throws(() => png.encode({ width: 2, height: 2, data: Buffer.alloc(12), colorType: 'cmyk' }), /unknown colour type/);
  assert.throws(() => png.encode({ width: 2, height: 2, data: Buffer.alloc(12), colorType: 'rgb', bitDepth: 4 }), /bit depth 4/);
  assert.throws(() => png.encode({ width: 0, height: 2, data: Buffer.alloc(0), colorType: 'rgb' }), /positive integers/);
  assert.throws(() => png.encode({ width: 1, height: 1, data: Buffer.from([5]), colorType: 'palette', palette: [[0, 0, 0]] }), /out of range/);
  assert.throws(() => png.encode({ width: 1, height: 1, data: Buffer.from([2]), colorType: 'grey', bitDepth: 1 }), /does not fit/);
}

// --- image-info --------------------------------------------------------------------------

{
  const info = imageInfo(png.encode({ width: 40, height: 60, data: Buffer.alloc(40 * 60 * 4, 200), colorType: 'rgba' }));
  assert.strictEqual(info.format, 'png');
  assert.strictEqual(info.width, 40);
  assert.strictEqual(info.height, 60);
  assert.strictEqual(info.mime, 'image/png');
  assert.strictEqual(info.ext, 'png');
  assert.strictEqual(info.alpha, true);
  assert.strictEqual(info.interlaced, false);

  const grey = imageInfo(greyJpeg());
  assert.strictEqual(grey.format, 'jpeg');
  assert.strictEqual(grey.width, 16);
  assert.strictEqual(grey.height, 24);
  assert.strictEqual(grey.components, 1);
  assert.strictEqual(grey.colorSpace, 'gray');
  assert.strictEqual(grey.bitsPerSample, 8);
  assert.strictEqual(grey.progressive, false);
  assert.strictEqual(grey.cmyk, false);
  assert.strictEqual(grey.ext, 'jpg');

  const rgb = imageInfo(rgbJpeg());
  assert.strictEqual(rgb.components, 3);
  assert.strictEqual(rgb.colorSpace, 'ycbcr');
  assert.strictEqual(rgb.width, 16);
  assert.strictEqual(rgb.height, 24);

  // Progressive: same header with SOF2 instead of SOF0.
  const progressive = rgbJpeg();
  const sof = progressive.indexOf(Buffer.from([0xFF, 0xC0]));
  progressive[sof + 1] = 0xC2;
  assert.strictEqual(imageInfo(progressive).progressive, true);

  // CMYK with an Adobe APP14 marker (header only; nothing decodes the scan here).
  const cmyk = Buffer.concat([
    Buffer.from('ffd8', 'hex'),
    Buffer.from('ffee000e41646f626500640000000000', 'hex'), // APP14 "Adobe", transform 0
    Buffer.from('ffc0001408003c002804' + '011100' + '021100' + '031100' + '041100', 'hex'), // 40x60, 4 components
    Buffer.from('ffd9', 'hex'),
  ]);
  const cmykInfo = imageInfo(cmyk);
  assert.strictEqual(cmykInfo.components, 4);
  assert.strictEqual(cmykInfo.cmyk, true);
  assert.strictEqual(cmykInfo.colorSpace, 'cmyk');
  assert.strictEqual(cmykInfo.adobe, true);
  assert.strictEqual(cmykInfo.width, 40);
  assert.strictEqual(cmykInfo.height, 60);

  // WebP (VP8X header): canvas 400 x 600.
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'latin1');
  webp.writeUInt32LE(22, 4);
  webp.write('WEBPVP8X', 8, 'latin1');
  webp.writeUInt32LE(10, 16);
  webp[20] = 0x10;
  webp.writeUIntLE(399, 24, 3);
  webp.writeUIntLE(599, 27, 3);
  const webpInfo = imageInfo(webp);
  assert.deepStrictEqual([webpInfo.format, webpInfo.width, webpInfo.height, webpInfo.alpha], ['webp', 400, 600, true]);

  assert.strictEqual(detectFormat(Buffer.from('plain text, nothing else')), null);
  assert.throws(() => imageInfo(Buffer.from('plain text, nothing else')), /unrecognised image format/);
  assert.throws(() => imageInfo(Buffer.from('ffd8ffd9000000000000000000', 'hex')), /no frame header/);
}

console.log('png: OK');
