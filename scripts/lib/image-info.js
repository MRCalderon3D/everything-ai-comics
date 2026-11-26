'use strict';
/**
 * Read width, height, and format from image headers without decoding pixels.
 * PNG, JPEG and WebP. Zero dependencies.
 */

const fs = require('fs');
const png = require('./png');

const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' };

/** SOF markers: C0-CF except C4 (DHT), C8 (JPG extension) and CC (DAC). */
function isSof(marker) {
  return marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
}

function jpegInfo(buffer) {
  let pos = 2;
  let adobeTransform = null;
  let jfif = false;
  while (pos < buffer.length) {
    if (buffer[pos] !== 0xFF) {
      throw new Error('jpeg: expected a marker before the image data (corrupt header?)');
    }
    while (pos < buffer.length && buffer[pos] === 0xFF) pos++; // fill bytes
    const marker = buffer[pos++];
    if (marker === undefined) break;
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue;
    if (marker === 0xD9 || marker === 0xDA) break; // EOI or start of scan: no frame header found
    if (pos + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(pos);
    if (length < 2 || pos + length > buffer.length) throw new Error('jpeg: segment runs past the end of the file');
    const start = pos + 2;
    if (marker === 0xE0 && buffer.toString('latin1', start, start + 4) === 'JFIF') jfif = true;
    if (marker === 0xEE && length >= 14 && buffer.toString('latin1', start, start + 5) === 'Adobe') {
      adobeTransform = buffer[start + 11];
    }
    if (isSof(marker)) {
      if (length < 8) throw new Error('jpeg: frame header too short');
      const components = buffer[start + 5];
      let colorSpace;
      if (components === 1) colorSpace = 'gray';
      else if (components === 3) colorSpace = adobeTransform === 0 && !jfif ? 'rgb' : 'ycbcr';
      else if (components === 4) colorSpace = adobeTransform === 2 ? 'ycck' : 'cmyk';
      else colorSpace = 'unknown';
      return {
        format: 'jpeg',
        mime: MIME.jpeg,
        ext: EXT.jpeg,
        width: buffer.readUInt16BE(start + 3),
        height: buffer.readUInt16BE(start + 1),
        bitsPerSample: buffer[start],
        components,
        colorSpace,
        cmyk: components === 4,
        progressive: marker === 0xC2 || marker === 0xC6 || marker === 0xCA || marker === 0xCE,
        lossless: marker === 0xC3 || marker === 0xC7 || marker === 0xCB || marker === 0xCF,
        arithmetic: marker >= 0xC9,
        adobe: adobeTransform !== null,
        adobeTransform,
      };
    }
    pos += length;
  }
  throw new Error('jpeg: no frame header (SOF marker) found');
}

function webpInfo(buffer) {
  if (buffer.length < 30) throw new Error('webp: file too short');
  const kind = buffer.toString('latin1', 12, 16);
  let width;
  let height;
  let alpha = false;
  if (kind === 'VP8 ') {
    if (buffer[23] !== 0x9D || buffer[24] !== 0x01 || buffer[25] !== 0x2A) {
      throw new Error('webp: bad VP8 start code');
    }
    width = buffer.readUInt16LE(26) & 0x3FFF;
    height = buffer.readUInt16LE(28) & 0x3FFF;
  } else if (kind === 'VP8L') {
    if (buffer[20] !== 0x2F) throw new Error('webp: bad VP8L signature');
    const bits = buffer.readUInt32LE(21);
    width = (bits & 0x3FFF) + 1;
    height = ((bits >>> 14) & 0x3FFF) + 1;
    alpha = ((bits >>> 28) & 1) === 1;
  } else if (kind === 'VP8X') {
    alpha = (buffer[20] & 0x10) !== 0;
    width = buffer.readUIntLE(24, 3) + 1;
    height = buffer.readUIntLE(27, 3) + 1;
  } else {
    throw new Error(`webp: unknown chunk "${kind}"`);
  }
  return { format: 'webp', mime: MIME.webp, ext: EXT.webp, width, height, alpha, variant: kind.trim() };
}

/** 'png' | 'jpeg' | 'webp' | null, from the magic bytes. */
function detectFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (png.isPng(buffer)) return 'png';
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'jpeg';
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/**
 * Describe an image from its header.
 *
 * @param {Buffer|string} input  File contents, or a path to read.
 * @returns {object} Always `{ format, mime, ext, width, height }`, plus:
 *   PNG:  bitDepth, colorType, colorTypeName, channels, interlaced, alpha
 *   JPEG: bitsPerSample, components, colorSpace ('gray' | 'ycbcr' | 'rgb' |
 *         'cmyk' | 'ycck'), cmyk, progressive, lossless, arithmetic, adobe,
 *         adobeTransform
 *   WebP: alpha, variant
 * @throws when the format is not recognised or the header is corrupt.
 */
function imageInfo(input) {
  const buffer = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  const format = detectFormat(buffer);
  if (format === 'png') {
    const header = png.readHeader(buffer);
    return {
      format: 'png',
      mime: MIME.png,
      ext: EXT.png,
      width: header.width,
      height: header.height,
      bitDepth: header.bitDepth,
      colorType: header.colorType,
      colorTypeName: header.colorTypeName,
      channels: header.channels,
      interlaced: header.interlaced,
      alpha: header.colorTypeName === 'rgba' || header.colorTypeName === 'grey-alpha',
    };
  }
  if (format === 'jpeg') return jpegInfo(buffer);
  if (format === 'webp') return webpInfo(buffer);
  throw new Error('unrecognised image format (expected PNG, JPEG or WebP)');
}

module.exports = { imageInfo, detectFormat, MIME, EXT };
