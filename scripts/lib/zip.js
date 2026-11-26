'use strict';
/**
 * Minimal ZIP writer and reader. Zero dependencies (zlib is a Node built-in).
 *
 * Writer: store (default) or deflate per entry, CRC-32, UTF-8 names,
 * deterministic output (every entry is stamped 1980-01-01 00:00:00 unless a
 * date is given). No ZIP64, no encryption, no data descriptors.
 *
 * Reader: reads what the writer produces plus ordinary store/deflate archives
 * without ZIP64. It exists so tests can verify a round trip.
 */

const zlib = require('zlib');
const { crc32 } = require('./crc32');

const SIG_LOCAL = 0x04034B50;
const SIG_CENTRAL = 0x02014B50;
const SIG_END = 0x06054B50;
const FLAG_UTF8 = 0x0800;
const MAX_32 = 0xFFFFFFFF;

/** Date -> { time, date } in MS-DOS format. Dates before 1980 clamp to 1980-01-01. */
function dosDateTime(date) {
  if (!date) return { time: 0, date: (1 << 5) | 1 };
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error('zip: invalid date');
  const year = d.getUTCFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

function checkName(name) {
  if (typeof name !== 'string' || !name) throw new Error('zip: entry name must be a non-empty string');
  if (name.includes('\\')) throw new Error(`zip: entry name "${name}" must use forward slashes`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) {
    throw new Error(`zip: entry name "${name}" must be a relative path inside the archive`);
  }
}

/**
 * Build a ZIP archive in memory.
 *
 * @param {Array<{name:string, data:Buffer|string, compress?:boolean, date?:Date}>} entries
 *   In archive order. `compress: true` deflates the entry; images are already
 *   compressed and are best stored.
 * @param {{date?:Date, comment?:string}} [options]  Default timestamp for
 *   every entry (UTC), and an archive comment.
 * @returns {Buffer}
 */
function createZip(entries, options = {}) {
  if (!Array.isArray(entries)) throw new Error('zip: entries must be an array');
  if (entries.length > 0xFFFF) throw new Error('zip: more than 65535 entries needs ZIP64, which is not supported');
  const seen = new Set();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    checkName(entry.name);
    if (seen.has(entry.name)) throw new Error(`zip: duplicate entry name "${entry.name}"`);
    seen.add(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const method = entry.compress ? 8 : 0;
    const stored = method === 8 ? zlib.deflateRawSync(data, { level: 9 }) : data;
    const crc = crc32(data);
    const stamp = dosDateTime(entry.date || options.date);
    if (data.length > MAX_32 || stored.length > MAX_32 || offset > MAX_32) {
      throw new Error('zip: archive larger than 4 GB needs ZIP64, which is not supported');
    }
    const version = method === 8 ? 20 : 10;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(version, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by: 2.0, MS-DOS attribute compatibility
    central.writeUInt16LE(version, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += 30 + name.length + stored.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  if (offset > MAX_32 || centralSize > MAX_32) {
    throw new Error('zip: archive larger than 4 GB needs ZIP64, which is not supported');
  }
  const comment = Buffer.from(options.comment || '', 'utf8');
  if (comment.length > 0xFFFF) throw new Error('zip: archive comment too long');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);

  return Buffer.concat([...localParts, ...centralParts, end, comment]);
}

/**
 * Read a ZIP archive from memory. Verifies the CRC-32 of every entry.
 *
 * @param {Buffer} buffer
 * @returns {Array<{name:string, data:Buffer, method:number, crc32:number,
 *   compressedSize:number, size:number, offset:number, flags:number,
 *   dosTime:number, dosDate:number}>} entries in central-directory order
 */
function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('zip: not a ZIP archive (too short)');
  let endPos = -1;
  const floor = Math.max(0, buffer.length - 22 - 0xFFFF);
  for (let i = buffer.length - 22; i >= floor; i--) {
    if (buffer.readUInt32LE(i) === SIG_END) {
      endPos = i;
      break;
    }
  }
  if (endPos === -1) throw new Error('zip: end of central directory not found');
  const count = buffer.readUInt16LE(endPos + 10);
  const centralSize = buffer.readUInt32LE(endPos + 12);
  const centralOffset = buffer.readUInt32LE(endPos + 16);
  if (centralOffset + centralSize > endPos) throw new Error('zip: central directory overlaps the end record');

  const entries = [];
  let pos = centralOffset;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(pos) !== SIG_CENTRAL) throw new Error(`zip: bad central directory header at ${pos}`);
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    const dosTime = buffer.readUInt16LE(pos + 12);
    const dosDate = buffer.readUInt16LE(pos + 14);
    const crc = buffer.readUInt32LE(pos + 16);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const size = buffer.readUInt32LE(pos + 24);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const offset = buffer.readUInt32LE(pos + 42);
    const name = buffer.toString(flags & FLAG_UTF8 ? 'utf8' : 'latin1', pos + 46, pos + 46 + nameLength);
    pos += 46 + nameLength + extraLength + commentLength;

    if (buffer.readUInt32LE(offset) !== SIG_LOCAL) throw new Error(`zip: bad local header for "${name}"`);
    if (flags & 0x0001) throw new Error(`zip: "${name}" is encrypted, which is not supported`);
    const localNameLength = buffer.readUInt16LE(offset + 26);
    const localExtraLength = buffer.readUInt16LE(offset + 28);
    const localName = buffer.toString(flags & FLAG_UTF8 ? 'utf8' : 'latin1', offset + 30, offset + 30 + localNameLength);
    if (localName !== name) throw new Error(`zip: local header name "${localName}" does not match "${name}"`);
    const dataStart = offset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    if (raw.length !== compressedSize) throw new Error(`zip: "${name}" runs past the end of the archive`);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`zip: "${name}" uses compression method ${method}, which is not supported`);
    if (data.length !== size) throw new Error(`zip: "${name}" has size ${data.length}, header says ${size}`);
    if (crc32(data) !== crc) throw new Error(`zip: CRC mismatch for "${name}"`);
    entries.push({ name, data, method, crc32: crc, compressedSize, size, offset, flags, dosTime, dosDate });
  }
  return entries;
}

module.exports = { createZip, readZip, dosDateTime };
