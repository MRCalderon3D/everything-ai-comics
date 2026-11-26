'use strict';
/**
 * Placeholder images for fake mode. They are not art: flat shapes, a panel
 * grid when the page has one, the label of what the image stands for, and a
 * large version number. Each version gets its own background colour and
 * moves its figures, so two versions can be told apart at a glance and in a
 * side-by-side comparison.
 */

const path = require('path');
const { SCAFFOLD_ROOT } = require('../util');

const png = require(path.join(SCAFFOLD_ROOT, 'scripts', 'lib', 'png.js'));

const FONT = {
  0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111',
  4: '101101111001001', 5: '111100111001111', 6: '111100111101111', 7: '111001001001001',
  8: '111101111101111', 9: '111101111001111',
  A: '111101111101101', B: '110101110101110', C: '111100100100111', D: '110101101101110',
  E: '111100111100111', F: '111100111100100', G: '111100101101111', H: '101101111101101',
  I: '111010010010111', J: '001001001101111', K: '101101110101101', L: '100100100100111',
  M: '101111111101101', N: '111101101101101', O: '111101101101111', P: '111101111100100',
  Q: '111101101111001', R: '111101110101101', S: '111100111001111', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
  Y: '101101010010010', Z: '111001010100111', _: '000000000000111', '-': '000000111000000',
  ' ': '000000000000000', '.': '000000000000010', ':': '000010000010000',
};

/** Background per version: the same slot never repeats within six versions. */
const VERSION_COLORS = [
  [214, 226, 240], [247, 222, 196], [213, 236, 214], [240, 214, 232], [244, 238, 196], [208, 234, 236],
];
const ACCENTS = [
  [196, 62, 48], [44, 100, 170], [52, 140, 88], [150, 82, 170], [200, 130, 30], [30, 140, 150],
];

function hash(text) {
  let h = 2166136261;
  for (const ch of String(text)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** "2:3" -> { width, height } for a placeholder (long side 900 px). */
function sizeFor(ratio, longSide = 900) {
  const m = /^(\d+):(\d+)$/.exec(String(ratio || '2:3'));
  const w = m ? Number(m[1]) : 2;
  const h = m && Number(m[2]) > 0 ? Number(m[2]) : 3;
  if (w >= h) return { width: longSide, height: Math.max(8, Math.round((longSide * h) / w)) };
  return { width: Math.max(8, Math.round((longSide * w) / h)), height: longSide };
}

/**
 * @param {{width: number, height: number, label?: string, version?: number,
 *          tiers?: number[], tag?: string, seed?: string}} options
 *   tiers: panels per tier for a page; absent for a sheet or a cover.
 * @returns {Buffer} PNG
 */
function placeholder(options) {
  const width = Math.max(64, Math.round(options.width));
  const height = Math.max(64, Math.round(options.height));
  const version = Math.max(1, options.version || 1);
  const label = String(options.label || 'IMAGE').toUpperCase();
  const seed = hash(options.seed || label);
  const palette = [
    VERSION_COLORS[(version - 1) % VERSION_COLORS.length],
    [255, 255, 255],
    [24, 24, 28],
    ACCENTS[seed % ACCENTS.length],
    [150, 150, 156],
    ACCENTS[(seed + 2 + version) % ACCENTS.length],
  ];
  const data = Buffer.alloc(width * height, 0);

  const rect = (x, y, w, h, color) => {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(width, Math.round(x + w));
    const y1 = Math.min(height, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) data.fill(color, yy * width + x0, yy * width + Math.max(x0, x1));
  };
  const frame = (x, y, w, h, t, color) => {
    rect(x, y, w, t, color);
    rect(x, y + h - t, w, t, color);
    rect(x, y, t, h, color);
    rect(x + w - t, y, t, h, color);
  };
  const disc = (cx, cy, r, color) => {
    for (let yy = Math.max(0, Math.floor(cy - r)); yy < Math.min(height, Math.ceil(cy + r)); yy++) {
      const dy = yy - cy;
      const half = Math.sqrt(Math.max(0, r * r - dy * dy));
      const x0 = Math.max(0, Math.round(cx - half));
      const x1 = Math.min(width, Math.round(cx + half));
      if (x1 > x0) data.fill(color, yy * width + x0, yy * width + x1);
    }
  };
  const text = (str, x, y, scale, color) => {
    let cx = x;
    for (const ch of String(str).toUpperCase()) {
      const glyph = FONT[ch] || FONT[' '];
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 3; col++) {
          if (glyph[row * 3 + col] === '1') rect(cx + col * scale, y + row * scale, scale, scale, color);
        }
      }
      cx += 4 * scale;
    }
    return cx;
  };
  const figure = (px, py, pw, ph, index) => {
    // The figure slides sideways with the version, so a repair is visible.
    const shift = ((version - 1) % 4) * 0.12;
    const cx = px + pw * (0.25 + ((index * 0.37 + shift) % 0.5));
    const r = Math.max(4, Math.min(pw, ph) * 0.11);
    const cy = py + ph * 0.42;
    disc(cx, cy, r, index % 2 ? 5 : 3);
    rect(cx - r * 0.8, cy + r, r * 1.6, Math.min(ph * 0.35, r * 2.6), index % 2 ? 5 : 3);
  };

  const margin = Math.round(width * 0.04);
  const header = Math.round(height * 0.045) + 10;
  rect(0, 0, width, header, 2);
  const title = `${label} V${String(version).padStart(2, '0')}${options.tag ? ` ${options.tag}` : ''}`;
  const scale = Math.max(1, Math.min(Math.floor((header - 8) / 5), Math.floor((width - 16) / (4 * title.length))));
  text(title, 8, Math.round((header - 5 * scale) / 2), scale, 1);

  const top = header + margin;
  const areaH = height - top - margin;
  const areaW = width - margin * 2;
  const gutter = Math.max(4, Math.round(width * 0.015));
  const tiers = Array.isArray(options.tiers) && options.tiers.length && options.tiers.every((n) => Number.isInteger(n) && n > 0)
    ? options.tiers : null;
  if (tiers) {
    const tierH = (areaH - gutter * (tiers.length - 1)) / tiers.length;
    let index = 0;
    tiers.forEach((count, t) => {
      const panelW = (areaW - gutter * (count - 1)) / count;
      for (let c = 0; c < count; c++) {
        const px = margin + c * (panelW + gutter);
        const py = top + t * (tierH + gutter);
        rect(px, py, panelW, tierH, 1);
        frame(px, py, panelW, tierH, 3, 2);
        figure(px, py, panelW, tierH, index);
        text(String(index + 1), px + 8, py + 8, 3, 4);
        index += 1;
      }
    });
  } else {
    rect(margin, top, areaW, areaH, 1);
    frame(margin, top, areaW, areaH, 3, 2);
    for (let i = 0; i < 3; i++) figure(margin + (areaW / 3) * i, top, areaW / 3, areaH * 0.8, i);
  }

  // The version, large, where a comparison slider crosses it.
  const big = Math.max(4, Math.floor(Math.min(width, height) / 40));
  const stamp = `V${String(version).padStart(2, '0')}`;
  const stampW = stamp.length * 4 * big;
  rect(width - margin - stampW - big * 2, height - margin - big * 8, stampW + big * 2, big * 7, 2);
  text(stamp, width - margin - stampW - big, height - margin - big * 7, big, 1);

  return png.encode({ width, height, data, colorType: 'palette', bitDepth: 8, palette, level: 1 });
}

module.exports = { placeholder, sizeFor, hash };
