'use strict';
/**
 * SVG and text-layout helpers for letter-pages.js and build-board.js.
 * Zero dependencies.
 *
 * The text model is approximate on purpose: there is no font file to measure,
 * so widths come from a per-character table scaled by the font size. Good
 * enough to wrap a balloon and to flag text that clearly will not fit; not a
 * substitute for a typesetter.
 */

/** Escape text for XML/HTML content and attribute values; drops characters XML 1.0 forbids. */
function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Number for an SVG attribute: at most 2 decimals. */
function fmt(value) {
  const text = Number(value).toFixed(2).replace(/\.?0+$/, '');
  return text === '-0' ? '0' : text;
}

const NARROW = new Set("iljtfrI.,:;'!|`()[]{}".split(''));
const WIDE = new Set('mwMW@%'.split(''));

/** Advance width of one character as a fraction of the font size. */
function charWidth(ch) {
  if (ch === ' ') return 0.3;
  if (NARROW.has(ch)) return 0.32;
  if (WIDE.has(ch)) return 0.86;
  const code = ch.codePointAt(0);
  // CJK, kana, hangul and fullwidth forms take a full em.
  if ((code >= 0x1100 && code <= 0x11FF) || (code >= 0x2E80 && code <= 0xA4CF) ||
      (code >= 0xAC00 && code <= 0xD7A3) || (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xFF00 && code <= 0xFF60)) return 1;
  if (ch >= '0' && ch <= '9') return 0.56;
  if (ch !== ch.toLowerCase()) return 0.66; // uppercase
  return 0.52;
}

/** Approximate width in px of a single line of text. */
function measureText(text, fontSize) {
  let units = 0;
  for (const ch of String(text)) units += charWidth(ch);
  return units * fontSize;
}

/**
 * Greedy word wrap. Explicit newlines are kept as hard breaks. A word wider
 * than the limit stays on its own line (and will show up as overflow).
 * @returns {string[]} lines
 */
function wrapText(text, maxWidth, fontSize) {
  const lines = [];
  for (const paragraph of String(text).split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${line} ${words[i]}`;
      if (measureText(candidate, fontSize) <= maxWidth) line = candidate;
      else {
        lines.push(line);
        line = words[i];
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Width and height of a block of wrapped lines. */
function measureBlock(lines, fontSize, lineHeight) {
  let width = 0;
  for (const line of lines) width = Math.max(width, measureText(line, fontSize));
  return { width, height: lines.length * fontSize * lineHeight };
}

function ellipsePoint(cx, cy, rx, ry, t) {
  return { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) };
}

/** True when a point lies outside the ellipse. */
function outsideEllipse(cx, cy, rx, ry, point) {
  const dx = (point.x - cx) / rx;
  const dy = (point.y - cy) / ry;
  return dx * dx + dy * dy > 1;
}

/**
 * Path of an ellipse balloon. With a tail tip outside the ellipse the tail is
 * part of the same outline, so the stroke runs unbroken around both.
 */
function balloonPath(cx, cy, rx, ry, tail) {
  if (!tail || !outsideEllipse(cx, cy, rx, ry, tail)) {
    return `M ${fmt(cx - rx)} ${fmt(cy)} A ${fmt(rx)} ${fmt(ry)} 0 1 1 ${fmt(cx + rx)} ${fmt(cy)} ` +
      `A ${fmt(rx)} ${fmt(ry)} 0 1 1 ${fmt(cx - rx)} ${fmt(cy)} Z`;
  }
  const t = Math.atan2((tail.y - cy) / ry, (tail.x - cx) / rx);
  const spread = 0.2;
  const a = ellipsePoint(cx, cy, rx, ry, t + spread);
  const b = ellipsePoint(cx, cy, rx, ry, t - spread);
  return `M ${fmt(a.x)} ${fmt(a.y)} A ${fmt(rx)} ${fmt(ry)} 0 1 1 ${fmt(b.x)} ${fmt(b.y)} ` +
    `L ${fmt(tail.x)} ${fmt(tail.y)} Z`;
}

/** Points of a tail triangle from the edge of an ellipse to the tip, or null when the tip is inside. */
function tailPolygon(cx, cy, rx, ry, tail) {
  if (!tail || !outsideEllipse(cx, cy, rx, ry, tail)) return null;
  const t = Math.atan2((tail.y - cy) / ry, (tail.x - cx) / rx);
  const spread = 0.22;
  // Base points sit well inside the outline (a burst dips to 0.78 of the radius),
  // so the shape drawn on top covers the seam.
  const a = ellipsePoint(cx, cy, rx * 0.7, ry * 0.7, t + spread);
  const b = ellipsePoint(cx, cy, rx * 0.7, ry * 0.7, t - spread);
  return `${fmt(a.x)},${fmt(a.y)} ${fmt(tail.x)},${fmt(tail.y)} ${fmt(b.x)},${fmt(b.y)}`;
}

/** Star-shaped burst inscribed in the box, for shouts. */
function burstPoints(cx, cy, rx, ry, spikes = 14, inner = 0.78) {
  const points = [];
  for (let i = 0; i < spikes * 2; i++) {
    const t = -Math.PI / 2 + (i * Math.PI) / spikes;
    // Alternate long and short spikes a little so it reads as hand drawn.
    const outer = i % 4 === 0 ? 1 : 0.94;
    const k = i % 2 === 0 ? outer : inner;
    const p = ellipsePoint(cx, cy, rx * k, ry * k, t);
    points.push(`${fmt(p.x)},${fmt(p.y)}`);
  }
  return points.join(' ');
}

/** Scalloped cloud outline inscribed in the box, for thoughts. */
function cloudPath(cx, cy, rx, ry, bumps = 10) {
  const baseRx = rx * 0.9;
  const baseRy = ry * 0.86;
  const pts = [];
  for (let i = 0; i < bumps; i++) pts.push(ellipsePoint(cx, cy, baseRx, baseRy, (i * 2 * Math.PI) / bumps));
  let d = `M ${fmt(pts[0].x)} ${fmt(pts[0].y)}`;
  for (let i = 1; i <= bumps; i++) {
    const from = pts[i - 1];
    const to = pts[i % bumps];
    const r = Math.hypot(to.x - from.x, to.y - from.y) * 0.6;
    d += ` A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(to.x)} ${fmt(to.y)}`;
  }
  return d + ' Z';
}

/** Shrinking bubbles from a thought cloud toward the tail tip: [{cx, cy, r}], or [] when the tip is inside. */
function thoughtBubbles(cx, cy, rx, ry, tail) {
  if (!tail || !outsideEllipse(cx, cy, rx, ry, tail)) return [];
  const t = Math.atan2((tail.y - cy) / ry, (tail.x - cx) / rx);
  const edge = ellipsePoint(cx, cy, rx, ry, t);
  const size = Math.min(rx, ry);
  const bubbles = [];
  for (let i = 0; i < 3; i++) {
    const k = (i + 0.6) / 3;
    bubbles.push({
      cx: edge.x + (tail.x - edge.x) * k,
      cy: edge.y + (tail.y - edge.y) * k,
      r: Math.max(3, size * (0.16 - i * 0.045)),
    });
  }
  return bubbles;
}

module.exports = {
  escapeXml,
  fmt,
  charWidth,
  measureText,
  wrapText,
  measureBlock,
  outsideEllipse,
  balloonPath,
  tailPolygon,
  burstPoints,
  cloudPath,
  thoughtBubbles,
};
