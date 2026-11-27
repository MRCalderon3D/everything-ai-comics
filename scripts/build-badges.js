#!/usr/bin/env node
'use strict';
/**
 * build-badges.js — write the README header badges as SVG files under
 * docs/images/badges/, with the counts read from the manifests.
 *
 * The badges are flat two-part images (grey label, coloured value) in the
 * style shields.io draws. Text widths come from a Verdana 11px advance-width
 * table, and every text element carries textLength, so a badge looks right
 * whatever font the viewer has. Output is deterministic, so
 * scripts/validate.js can compare the committed files byte for byte.
 */

const path = require('path');
const fs = require('fs');
const { ROOT, walk, exists, readJson, readText, writeFileEnsuring, toPosix } = require('./lib/fsx');
const { loadManifests, entries, ruleLayers, PROVIDER_KINDS } = require('./lib/manifest');
const { parseArgs, helpIfRequested } = require('./lib/cli');

const BADGE_DIR = 'docs/images/badges';

const HELP = `
build-badges.js — write the README badges to ${BADGE_DIR}/

Usage:
  node scripts/build-badges.js [--check] [--root <dir>]

Options:
  --check       Do not write; print the badges that differ from what would be
                generated, exit 1 when any does.
  --root <dir>  Scaffold root (default: this repository).
  --help        Show this help.

Counts come from manifests/ (agents, commands, skills, rules, providers,
harnesses), schemas/*.schema.json, and package.json (license). Run it after
any roster change; npm run validate fails while the badges are stale.
`;

/**
 * Verdana advance widths in font units (2048 per em), printable ASCII.
 * At 11px a width in pixels is units * 11 / 2048.
 */
const VERDANA_UNITS = {
  ' ': 720, '!': 805, '"': 942, '#': 1675, $: 1303, '%': 2216, '&': 1489, "'": 548,
  '(': 909, ')': 909, '*': 1303, '+': 1675, ',': 745, '-': 868, '.': 745, '/': 1302,
  0: 1302, 1: 1302, 2: 1302, 3: 1302, 4: 1302, 5: 1302, 6: 1302, 7: 1302, 8: 1302, 9: 1302,
  ':': 868, ';': 868, '<': 1675, '=': 1675, '>': 1675, '?': 1117, '@': 2048,
  A: 1401, B: 1405, C: 1430, D: 1577, E: 1294, F: 1178, G: 1587, H: 1540, I: 876,
  J: 903, K: 1418, L: 1145, M: 1735, N: 1529, O: 1620, P: 1247, Q: 1620, R: 1424,
  S: 1405, T: 1259, U: 1497, V: 1401, W: 2025, X: 1405, Y: 1252, Z: 1405,
  '[': 909, '\\': 1302, ']': 909, '^': 1675, _: 1303, '`': 1303,
  a: 1229, b: 1271, c: 1067, d: 1271, e: 1219, f: 719, g: 1271, h: 1292, i: 561,
  j: 678, k: 1206, l: 561, m: 1985, n: 1292, o: 1222, p: 1271, q: 1271, r: 868,
  s: 1065, t: 807, u: 1292, v: 1206, w: 1665, x: 1206, y: 1206, z: 1062,
  '{': 1303, '|': 909, '}': 1303, '~': 1675,
};
const FALLBACK_UNITS = 1302;
const FONT_PX = 11;
const PADDING = 5;
const LABEL_COLOR = '#555';

/** Named colours as shields.io defines them. */
const NAMED_COLORS = {
  blue: '#007ec6',
  blueviolet: '#8a2be2',
  orange: '#fe7d37',
  brightgreen: '#44cc11',
  yellow: '#dfb317',
  red: '#e05d44',
};

/** Width of a string in pixels at Verdana 11px, rounded to a whole pixel. */
function textWidth(text) {
  let units = 0;
  for (const ch of String(text)) units += VERDANA_UNITS[ch] || FALLBACK_UNITS;
  return Math.round((units * FONT_PX) / 2048);
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function hexColor(color) {
  const c = NAMED_COLORS[color] || color;
  return c.startsWith('#') ? c : `#${c}`;
}

/** True when white text would be hard to read on the colour (shields' rule). */
function isLight(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 255000 > 0.69;
}

/** One text element pair (shadow + text), in the tenfold coordinates the badge uses. */
function textPair(text, centerX, width, light) {
  const fill = light ? '#333' : '#fff';
  const shadow = light ? '#ccc' : '#010101';
  const t = escapeXml(text);
  return `<text aria-hidden="true" x="${centerX * 10}" y="150" fill="${shadow}" fill-opacity=".3" transform="scale(.1)" textLength="${width * 10}">${t}</text>` +
    `<text x="${centerX * 10}" y="140" transform="scale(.1)" fill="${fill}" textLength="${width * 10}">${t}</text>`;
}

/** A flat two-part badge as SVG text. */
function renderBadge(label, value, color) {
  const valueColor = hexColor(color);
  const lw = textWidth(label);
  const vw = textWidth(value);
  const left = lw + PADDING * 2;
  const right = vw + PADDING * 2;
  const total = left + right;
  const title = escapeXml(`${label}: ${value}`);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
    '<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>',
    `<clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>`,
    `<g clip-path="url(#r)"><rect width="${left}" height="20" fill="${LABEL_COLOR}"/><rect x="${left}" width="${right}" height="20" fill="${valueColor}"/><rect width="${total}" height="20" fill="url(#s)"/></g>`,
    '<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">',
    textPair(label, left / 2, lw, isLight(LABEL_COLOR)),
    textPair(value, left + right / 2, vw, isLight(valueColor)),
    '</g>',
    '</svg>',
    '',
  ].join('\n');
}

/**
 * The badges in README order: [{ name, label, value, color }].
 * Throws with a plain message when a source it reads is missing.
 */
function badgeSpecs(root = ROOT) {
  const { manifests, errors } = loadManifests(root);
  if (errors.length) {
    throw new Error(`cannot read the manifests: ${errors.map((e) => `${e.file} ${e.message}`).join('; ')}`);
  }
  const pkgFile = path.join(root, 'package.json');
  if (!exists(pkgFile)) throw new Error('package.json is missing');
  const license = readJson(pkgFile).license;
  if (!license) throw new Error('package.json has no license');
  const schemaDir = path.join(root, 'schemas');
  const schemas = walk(schemaDir, { filter: (f) => f.endsWith('.schema.json') }).length;
  if (!schemas) throw new Error('schemas/ holds no *.schema.json file');

  const layers = ruleLayers(manifests);
  const rules = layers.reduce((n, l) => n + l.rules.length, 0);
  const formats = layers.filter((l) => l.kind === 'format').map((l) => l.name);
  const providers = PROVIDER_KINDS
    .reduce((n, kind) => n + entries(manifests, `${kind}-providers.json`, 'providers').length, 0);
  const harnesses = (manifests['harnesses.json'].harnesses || []).length;

  return [
    { name: 'license', label: 'license', value: license, color: 'blue' },
    { name: 'agents', label: 'agents', value: entries(manifests, 'agents.json', 'agents').length, color: 'blueviolet' },
    { name: 'commands', label: 'commands', value: entries(manifests, 'commands.json', 'commands').length, color: 'orange' },
    { name: 'skills', label: 'skills', value: entries(manifests, 'skills.json', 'skills').length, color: 'brightgreen' },
    { name: 'rules', label: 'rules', value: rules, color: 'yellow' },
    { name: 'schemas', label: 'schemas', value: schemas, color: 'red' },
    { name: 'providers', label: 'providers', value: providers, color: '00b4c8' },
    { name: 'harnesses', label: 'harnesses', value: harnesses, color: '8b5e3c' },
    { name: 'formats', label: 'formats', value: formats.join(' | '), color: '9b30ff' },
  ].map((b) => ({ ...b, value: String(b.value) }));
}

/** { '<BADGE_DIR>/<name>.svg': svgText } for every badge. */
function buildBadges(root = ROOT) {
  const plan = {};
  for (const b of badgeSpecs(root)) plan[`${BADGE_DIR}/${b.name}.svg`] = renderBadge(b.label, b.value, b.color);
  return plan;
}

/** Differences between disk and the plan: missing, stale, and unexpected files. */
function diffBadges(root = ROOT, plan = null) {
  plan = plan || buildBadges(root);
  const drift = [];
  for (const [rel, content] of Object.entries(plan)) {
    const abs = path.join(root, ...rel.split('/'));
    if (!exists(abs)) drift.push(`missing: ${rel}`);
    else if (readText(abs).replace(/\r\n/g, '\n') !== content) drift.push(`stale: ${rel}`);
  }
  for (const file of walk(path.join(root, ...BADGE_DIR.split('/')))) {
    const rel = toPosix(path.relative(root, file));
    if (!(rel in plan)) drift.push(`unexpected: ${rel}`);
  }
  return drift;
}

/** Write the plan and remove files in the badge directory it does not name. */
function writeBadges(root = ROOT, plan = null) {
  plan = plan || buildBadges(root);
  let written = 0;
  let removed = 0;
  for (const [rel, content] of Object.entries(plan)) {
    const abs = path.join(root, ...rel.split('/'));
    const current = exists(abs) ? readText(abs).replace(/\r\n/g, '\n') : null;
    if (current !== content) {
      writeFileEnsuring(abs, content);
      written++;
    }
  }
  for (const file of walk(path.join(root, ...BADGE_DIR.split('/')))) {
    const rel = toPosix(path.relative(root, file));
    if (!(rel in plan)) {
      fs.unlinkSync(file);
      removed++;
    }
  }
  return { total: Object.keys(plan).length, written, removed };
}

function main() {
  helpIfRequested(process.argv.slice(2), HELP);
  const { flags } = parseArgs();
  const root = flags.root && flags.root !== true ? path.resolve(String(flags.root)) : ROOT;
  let plan;
  try {
    plan = buildBadges(root);
  } catch (err) {
    console.error(`build-badges: ${err.message}`);
    process.exit(1);
  }
  if (flags.check) {
    const drift = diffBadges(root, plan);
    if (drift.length) {
      console.log(`build-badges --check: ${drift.length} badge file(s) differ:`);
      for (const d of drift) console.log(`  ${d}`);
      console.log('Run "npm run badges" to regenerate.');
      process.exit(1);
    }
    console.log(`build-badges --check: ${Object.keys(plan).length} badges up to date.`);
    process.exit(0);
  }
  const result = writeBadges(root, plan);
  console.log(`build-badges: ${result.total} badges, ${result.written} written, ${result.removed} removed, in ${BADGE_DIR}/.`);
}

module.exports = {
  BADGE_DIR, badgeSpecs, buildBadges, diffBadges, writeBadges, renderBadge, textWidth,
};

if (require.main === module) main();
