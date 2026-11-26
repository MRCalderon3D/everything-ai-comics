'use strict';
/**
 * Shared helpers for the publishing tests: tiny images, a temp workspace
 * copied from ./workspace, and a structural PDF reader.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const png = require('../../../scripts/lib/png');
const yaml = require('../../../scripts/lib/yaml');

const FIXTURE = path.join(__dirname, 'workspace');

/**
 * Hand-made baseline JPEG, 16x24 px, one grey component.
 * One Huffman code per table (DC category 0, AC end-of-block), so each 8x8
 * block costs two zero bits: six blocks are 12 bits, padded with ones.
 */
const GREY_JPEG_HEX = [
  'ffd8',                                             // SOI
  'ffe0' + '0010' + '4a46494600' + '0101' + '00' + '0001' + '0001' + '0000', // APP0 JFIF 1.1
  'ffdb' + '0043' + '00' + '01'.repeat(64),           // DQT, table 0, all ones
  'ffc0' + '000b' + '08' + '0018' + '0010' + '01' + '011100', // SOF0: 8 bit, 24 high, 16 wide, 1 component
  'ffc4' + '0014' + '00' + '01' + '00'.repeat(15) + '00', // DHT DC 0: one 1-bit code, symbol 0
  'ffc4' + '0014' + '10' + '01' + '00'.repeat(15) + '00', // DHT AC 0: one 1-bit code, symbol EOB
  'ffda' + '0008' + '01' + '0100' + '003f00',         // SOS
  '000f',                                             // 12 zero bits + 4 padding ones
  'ffd9',                                             // EOI
].join('');

/** Same image with three components (YCbCr 4:4:4): 18 blocks, 36 zero bits. */
const RGB_JPEG_HEX = [
  'ffd8',
  'ffe0' + '0010' + '4a46494600' + '0101' + '00' + '0001' + '0001' + '0000',
  'ffdb' + '0043' + '00' + '01'.repeat(64),
  'ffc0' + '0011' + '08' + '0018' + '0010' + '03' + '011100' + '021100' + '031100',
  'ffc4' + '0014' + '00' + '01' + '00'.repeat(15) + '00',
  'ffc4' + '0014' + '10' + '01' + '00'.repeat(15) + '00',
  'ffda' + '000c' + '03' + '0100' + '0200' + '0300' + '003f00',
  '000000000f',
  'ffd9',
].join('');

const greyJpeg = () => Buffer.from(GREY_JPEG_HEX, 'hex');
const rgbJpeg = () => Buffer.from(RGB_JPEG_HEX, 'hex');

/** A flat PNG. `value` is one byte per channel. */
function solidPng(width, height, colorType, value) {
  const channels = png.COLOR_TYPES[colorType].channels;
  const data = Buffer.alloc(width * height * channels);
  for (let i = 0; i < data.length; i++) data[i] = value[i % channels];
  return png.encode({ width, height, data, colorType });
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

/**
 * Copy the fixture workspace into a fresh temp directory and add the render
 * images (pages 1 and 2 as 40x60 PNG, page 3 as the 16x24 JPEG; all 2:3).
 * @returns {string} the workspace root
 */
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eac-publishing-'));
  copyTree(FIXTURE, root);
  const renders = (page) => {
    const dir = path.join(root, 'issues', 'ISS_001', 'pages', page, 'renders');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  fs.writeFileSync(path.join(renders('PG_001_001'), 'PG_001_001_V01.png'), solidPng(40, 60, 'rgb', [220, 220, 220]));
  fs.writeFileSync(path.join(renders('PG_001_002'), 'PG_001_002_V01.png'), solidPng(40, 60, 'grey', [90]));
  fs.writeFileSync(path.join(renders('PG_001_002'), 'PG_001_002_V02.png'), solidPng(40, 60, 'rgba', [200, 180, 160, 128]));
  fs.writeFileSync(path.join(renders('PG_001_003'), 'PG_001_003_V01.jpg'), rgbJpeg());
  return root;
}

function cleanup(root) {
  if (root && root.startsWith(os.tmpdir())) fs.rmSync(root, { recursive: true, force: true });
}

/** Load a YAML file, let `change` edit the document, write it back. */
function editYaml(file, change) {
  const doc = yaml.parse(fs.readFileSync(file, 'utf8'));
  const next = change(doc) || doc;
  fs.writeFileSync(file, yaml.stringify(next));
  return next;
}

/**
 * Read the structure of a PDF by hand: header, startxref, the xref table, and
 * every object the table points at. Throws when an offset is wrong.
 * @returns {{version:string, startxref:number, size:number, trailer:string,
 *   objects:Array<{id:number, offset:number, body:string}>, text:string}}
 */
function readPdf(buffer) {
  const text = buffer.toString('latin1');
  const header = /^%PDF-(\d\.\d)\n/.exec(text);
  if (!header) throw new Error('pdf: missing %PDF header');
  if (!text.endsWith('%%EOF\n')) throw new Error('pdf: missing %%EOF at the end');
  const tail = /startxref\n(\d+)\n%%EOF\n$/.exec(text);
  if (!tail) throw new Error('pdf: missing startxref');
  const startxref = Number(tail[1]);
  if (text.slice(startxref, startxref + 5) !== 'xref\n') throw new Error('pdf: startxref does not point at "xref"');
  const head = /^xref\n0 (\d+)\n/.exec(text.slice(startxref, startxref + 40));
  if (!head) throw new Error('pdf: bad xref subsection header');
  const size = Number(head[1]);
  const tableStart = startxref + head[0].length;
  const objects = [];
  for (let i = 0; i < size; i++) {
    // Every entry is exactly 20 bytes: 10-digit offset, 5-digit generation, n or f, 2-byte line end.
    const entry = text.slice(tableStart + i * 20, tableStart + (i + 1) * 20);
    const m = /^(\d{10}) (\d{5}) ([nf]) \n$/.exec(entry);
    if (!m) throw new Error(`pdf: malformed xref entry ${i}: ${JSON.stringify(entry)}`);
    if (i === 0) {
      if (m[3] !== 'f' || m[2] !== '65535') throw new Error('pdf: xref entry 0 must be the free-list head');
      continue;
    }
    const offset = Number(m[1]);
    const marker = `${i} 0 obj\n`;
    if (text.slice(offset, offset + marker.length) !== marker) {
      throw new Error(`pdf: xref entry ${i} points at ${JSON.stringify(text.slice(offset, offset + 12))}, expected "${i} 0 obj"`);
    }
    const end = text.indexOf('\nendobj\n', offset);
    if (end === -1) throw new Error(`pdf: object ${i} has no endobj`);
    objects.push({ id: i, offset, body: text.slice(offset + marker.length, end) });
  }
  const trailerStart = tableStart + size * 20;
  if (text.slice(trailerStart, trailerStart + 8) !== 'trailer\n') throw new Error('pdf: trailer does not follow the xref table');
  const trailer = text.slice(trailerStart + 8, text.lastIndexOf('startxref'));
  return { version: header[1], startxref, size, trailer, objects, text };
}

/** Split a stream object body into its dictionary text and its data bytes (latin1 string). */
function streamOf(object) {
  const at = object.body.indexOf('\nstream\n');
  if (at === -1) return null;
  const dict = object.body.slice(0, at);
  const length = Number(/\/Length (\d+)/.exec(dict)[1]);
  const start = at + '\nstream\n'.length;
  const data = object.body.slice(start, start + length);
  const rest = object.body.slice(start + length);
  if (rest !== '\nendstream') throw new Error(`pdf: object ${object.id}: /Length ${length} does not end at endstream`);
  return { dict, length, data: Buffer.from(data, 'latin1') };
}

module.exports = {
  FIXTURE,
  GREY_JPEG_HEX,
  RGB_JPEG_HEX,
  greyJpeg,
  rgbJpeg,
  solidPng,
  makeWorkspace,
  cleanup,
  editYaml,
  readPdf,
  streamOf,
};
