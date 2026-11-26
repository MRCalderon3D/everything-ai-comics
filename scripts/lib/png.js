'use strict';
/**
 * Minimal PNG encoder and decoder. Zero dependencies (zlib is a Node built-in).
 *
 * Encoder: greyscale, greyscale + alpha, RGB, RGBA and palette images, bit
 * depths 1/2/4/8/16 where the colour type allows them, one fixed row filter
 * per image, no interlacing.
 *
 * Decoder: every standard colour type and bit depth, all five row filters,
 * tRNS transparency. Output is always normalised to 8-bit samples with 1
 * (grey), 2 (grey + alpha), 3 (RGB) or 4 (RGBA) channels; 16-bit samples keep
 * their high byte. Interlaced (Adam7) files are rejected with a clear error.
 */

const zlib = require('zlib');
const { crc32 } = require('./crc32');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

const COLOR_TYPES = {
  grey: { code: 0, channels: 1, depths: [1, 2, 4, 8, 16] },
  rgb: { code: 2, channels: 3, depths: [8, 16] },
  palette: { code: 3, channels: 1, depths: [1, 2, 4, 8] },
  'grey-alpha': { code: 4, channels: 2, depths: [8, 16] },
  rgba: { code: 6, channels: 4, depths: [8, 16] },
};

const NAME_BY_CODE = { 0: 'grey', 2: 'rgb', 3: 'palette', 4: 'grey-alpha', 6: 'rgba' };

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Pack 8-bit-per-sample input rows into the PNG sample layout for a bit depth. */
function packRows(data, width, height, channels, bitDepth) {
  const samplesPerRow = width * channels;
  if (bitDepth === 8) return { rows: data, rowBytes: samplesPerRow };
  if (bitDepth === 16) {
    const rows = Buffer.alloc(data.length * 2);
    for (let i = 0; i < data.length; i++) {
      rows[i * 2] = data[i];
      rows[i * 2 + 1] = data[i];
    }
    return { rows, rowBytes: samplesPerRow * 2 };
  }
  const rowBytes = Math.ceil((samplesPerRow * bitDepth) / 8);
  const rows = Buffer.alloc(rowBytes * height);
  const max = (1 << bitDepth) - 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < samplesPerRow; x++) {
      const value = data[y * samplesPerRow + x];
      if (value > max) {
        throw new Error(`png: sample value ${value} does not fit a ${bitDepth}-bit image`);
      }
      const bit = x * bitDepth;
      rows[y * rowBytes + (bit >> 3)] |= value << (8 - bitDepth - (bit & 7));
    }
  }
  return { rows, rowBytes };
}

function applyFilter(rows, rowBytes, height, bpp, filter) {
  const out = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = y * rowBytes;
    const dst = y * (rowBytes + 1);
    out[dst] = filter;
    for (let x = 0; x < rowBytes; x++) {
      const value = rows[src + x];
      const a = x >= bpp ? rows[src + x - bpp] : 0;
      const b = y > 0 ? rows[src - rowBytes + x] : 0;
      const c = x >= bpp && y > 0 ? rows[src - rowBytes + x - bpp] : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) predicted = paeth(a, b, c);
      out[dst + 1 + x] = (value - predicted) & 0xFF;
    }
  }
  return out;
}

/**
 * Encode raw pixels as a PNG file.
 *
 * @param {object} image
 * @param {number} image.width
 * @param {number} image.height
 * @param {Buffer|Uint8Array} image.data  One byte per sample, row by row.
 *   For `palette` images each byte is a palette index. For bit depths below 8
 *   each byte holds a value that fits the depth (0..1, 0..3, 0..15).
 * @param {'grey'|'grey-alpha'|'rgb'|'rgba'|'palette'} [image.colorType='rgb']
 * @param {number} [image.bitDepth=8]
 * @param {Array<number[]>} [image.palette]  [[r, g, b] or [r, g, b, a], ...] for palette images.
 * @param {number} [image.filter=0]  Row filter 0..4, applied to every row.
 * @param {number} [image.level=9]   zlib compression level.
 * @returns {Buffer}
 */
function encode(image) {
  const { width, height } = image;
  const colorType = image.colorType || 'rgb';
  const bitDepth = image.bitDepth || 8;
  const filter = image.filter || 0;
  const spec = COLOR_TYPES[colorType];
  if (!spec) throw new Error(`png: unknown colour type "${colorType}"`);
  if (!spec.depths.includes(bitDepth)) {
    throw new Error(`png: bit depth ${bitDepth} is not valid for colour type "${colorType}"`);
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('png: width and height must be positive integers');
  }
  if (!Number.isInteger(filter) || filter < 0 || filter > 4) {
    throw new Error('png: filter must be an integer from 0 to 4');
  }
  const data = Buffer.isBuffer(image.data) ? image.data : Buffer.from(image.data);
  const expected = width * height * spec.channels;
  if (data.length !== expected) {
    throw new Error(`png: expected ${expected} bytes of pixel data, got ${data.length}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = spec.code;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  const chunks = [SIGNATURE, chunk('IHDR', ihdr)];

  if (colorType === 'palette') {
    const palette = image.palette;
    if (!Array.isArray(palette) || palette.length < 1 || palette.length > (1 << bitDepth)) {
      throw new Error(`png: a ${bitDepth}-bit palette image needs 1 to ${1 << bitDepth} palette entries`);
    }
    const plte = Buffer.alloc(palette.length * 3);
    const trns = Buffer.alloc(palette.length, 255);
    let hasAlpha = false;
    palette.forEach((entry, i) => {
      plte[i * 3] = entry[0];
      plte[i * 3 + 1] = entry[1];
      plte[i * 3 + 2] = entry[2];
      if (entry.length > 3 && entry[3] !== 255) {
        trns[i] = entry[3];
        hasAlpha = true;
      }
    });
    for (const index of data) {
      if (index >= palette.length) throw new Error(`png: palette index ${index} out of range`);
    }
    chunks.push(chunk('PLTE', plte));
    if (hasAlpha) chunks.push(chunk('tRNS', trns));
  }

  const { rows, rowBytes } = packRows(data, width, height, spec.channels, bitDepth);
  const bpp = Math.max(1, Math.ceil((spec.channels * bitDepth) / 8));
  const filtered = applyFilter(rows, rowBytes, height, bpp, filter);
  const level = image.level == null ? 9 : image.level;
  chunks.push(chunk('IDAT', zlib.deflateSync(filtered, { level })));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 8).equals(SIGNATURE);
}

/**
 * Read the IHDR of a PNG without decoding pixels.
 * @returns {{width:number, height:number, bitDepth:number, colorType:number,
 *   colorTypeName:string, interlaced:boolean, channels:number}}
 */
function readHeader(buffer) {
  if (!isPng(buffer)) throw new Error('png: not a PNG file (bad signature)');
  if (buffer.length < 33 || buffer.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error('png: missing IHDR chunk');
  }
  const colorType = buffer[25];
  const name = NAME_BY_CODE[colorType];
  if (!name) throw new Error(`png: unknown colour type ${colorType}`);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType,
    colorTypeName: name,
    interlaced: buffer[28] !== 0,
    channels: COLOR_TYPES[name].channels,
  };
}

/** Width and height of a PNG, read from its header. */
function readSize(buffer) {
  const header = readHeader(buffer);
  return { width: header.width, height: header.height };
}

function unfilter(raw, rowBytes, height, bpp) {
  if (raw.length < (rowBytes + 1) * height) {
    throw new Error('png: image data is shorter than the header says (truncated file?)');
  }
  const out = Buffer.alloc(rowBytes * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = y * rowBytes;
    if (filter > 4) throw new Error(`png: unknown row filter ${filter} on row ${y}`);
    for (let x = 0; x < rowBytes; x++) {
      const value = raw[pos++];
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = y > 0 ? out[row - rowBytes + x] : 0;
      const c = x >= bpp && y > 0 ? out[row - rowBytes + x - bpp] : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) predicted = paeth(a, b, c);
      out[row + x] = (value + predicted) & 0xFF;
    }
  }
  return out;
}

/** Read sample `index` of a row at the given bit depth (16-bit returns the full value). */
function sampleAt(rows, rowStart, index, bitDepth) {
  if (bitDepth === 8) return rows[rowStart + index];
  if (bitDepth === 16) return (rows[rowStart + index * 2] << 8) | rows[rowStart + index * 2 + 1];
  const bit = index * bitDepth;
  return (rows[rowStart + (bit >> 3)] >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
}

/**
 * Decode a PNG file into 8-bit samples.
 *
 * @param {Buffer} buffer
 * @returns {{width:number, height:number, bitDepth:number, colorType:number,
 *   colorTypeName:string, channels:number, hasAlpha:boolean, data:Buffer}}
 *   `channels` describes `data`: 1 grey, 2 grey + alpha, 3 RGB, 4 RGBA.
 *   Palette images come back as RGB (or RGBA when the file has tRNS).
 */
function decode(buffer) {
  const header = readHeader(buffer);
  const { width, height, bitDepth, colorType, colorTypeName } = header;
  if (header.interlaced) {
    throw new Error('png: interlaced (Adam7) PNG files are not supported; re-save the image without interlacing');
  }
  if (!COLOR_TYPES[colorTypeName].depths.includes(bitDepth)) {
    throw new Error(`png: bit depth ${bitDepth} is not valid for colour type ${colorType}`);
  }
  if (width < 1 || height < 1) throw new Error('png: zero-sized image');

  let palette = null;
  let transparency = null;
  const idat = [];
  let pos = 8;
  let ended = false;
  while (pos + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('latin1', pos + 4, pos + 8);
    const start = pos + 8;
    const end = start + length;
    if (end + 4 > buffer.length) throw new Error(`png: chunk ${type} runs past the end of the file`);
    const stored = buffer.readUInt32BE(end);
    if (crc32(buffer.subarray(pos + 4, end)) !== stored) {
      throw new Error(`png: CRC mismatch in ${type} chunk`);
    }
    const data = buffer.subarray(start, end);
    if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') transparency = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') {
      ended = true;
      break;
    }
    pos = end + 4;
  }
  if (!ended) throw new Error('png: missing IEND chunk (truncated file?)');
  if (!idat.length) throw new Error('png: no image data (IDAT) found');
  if (colorTypeName === 'palette' && !palette) throw new Error('png: palette image without a PLTE chunk');

  const srcChannels = header.channels;
  const rowBytes = Math.ceil((width * srcChannels * bitDepth) / 8);
  const bpp = Math.max(1, Math.ceil((srcChannels * bitDepth) / 8));
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch (err) {
    throw new Error(`png: corrupt image data (${err.message})`);
  }
  const rows = unfilter(raw, rowBytes, height, bpp);

  const max = (1 << bitDepth) - 1;
  const to8 = (v) => {
    if (bitDepth === 8) return v;
    if (bitDepth === 16) return v >> 8;
    return Math.round((v * 255) / max);
  };

  let channels;
  let data;
  if (colorTypeName === 'palette') {
    const entries = palette.length / 3;
    channels = transparency ? 4 : 3;
    data = Buffer.alloc(width * height * channels);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = sampleAt(rows, y * rowBytes, x, bitDepth);
        if (index >= entries) throw new Error(`png: palette index ${index} out of range`);
        const o = (y * width + x) * channels;
        data[o] = palette[index * 3];
        data[o + 1] = palette[index * 3 + 1];
        data[o + 2] = palette[index * 3 + 2];
        if (channels === 4) data[o + 3] = index < transparency.length ? transparency[index] : 255;
      }
    }
  } else {
    // tRNS on grey / RGB names one fully transparent colour.
    let key = null;
    if (transparency && colorTypeName === 'grey' && transparency.length >= 2) {
      key = [transparency.readUInt16BE(0)];
    } else if (transparency && colorTypeName === 'rgb' && transparency.length >= 6) {
      key = [transparency.readUInt16BE(0), transparency.readUInt16BE(2), transparency.readUInt16BE(4)];
    }
    channels = srcChannels + (key ? 1 : 0);
    data = Buffer.alloc(width * height * channels);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * channels;
        let matchesKey = !!key;
        for (let ch = 0; ch < srcChannels; ch++) {
          const v = sampleAt(rows, y * rowBytes, x * srcChannels + ch, bitDepth);
          if (key && v !== key[ch]) matchesKey = false;
          data[o + ch] = to8(v);
        }
        if (key) data[o + srcChannels] = matchesKey ? 0 : 255;
      }
    }
  }

  return {
    width,
    height,
    bitDepth,
    colorType,
    colorTypeName,
    channels,
    hasAlpha: channels === 2 || channels === 4,
    data,
  };
}

/**
 * Split a decoded image into colour samples and an alpha plane.
 * @param {ReturnType<typeof decode>} image
 * @returns {{color:Buffer, colorChannels:1|3, alpha:Buffer|null, opaque:boolean}}
 *   `alpha` is null when the image has no alpha channel; `opaque` is true when
 *   there is no alpha or every alpha sample is 255.
 */
function splitAlpha(image) {
  const { width, height, channels, data } = image;
  if (channels === 1 || channels === 3) {
    return { color: data, colorChannels: channels, alpha: null, opaque: true };
  }
  const colorChannels = channels - 1;
  const pixels = width * height;
  const color = Buffer.alloc(pixels * colorChannels);
  const alpha = Buffer.alloc(pixels);
  let opaque = true;
  for (let i = 0; i < pixels; i++) {
    for (let ch = 0; ch < colorChannels; ch++) color[i * colorChannels + ch] = data[i * channels + ch];
    const a = data[i * channels + colorChannels];
    alpha[i] = a;
    if (a !== 255) opaque = false;
  }
  return { color, colorChannels, alpha, opaque };
}

module.exports = { SIGNATURE, COLOR_TYPES, encode, decode, readHeader, readSize, isPng, splitAlpha };
