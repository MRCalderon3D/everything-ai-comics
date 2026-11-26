'use strict';
/** CRC-32 (IEEE 802.3) as used by PNG chunks and ZIP entries. Zero dependencies. */

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC-32 of a Buffer. Pass a previous result as `seed` to continue a running
 * checksum over several buffers.
 * @param {Buffer|Uint8Array} buf
 * @param {number} [seed]
 * @returns {number} unsigned 32-bit integer
 */
function crc32(buf, seed = 0) {
  let c = (seed ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

module.exports = { crc32 };
