'use strict';
/**
 * The look presets of the scaffold (templates/looks/*.yaml), as the style
 * screen lists them and as style.define applies them, with the sample page
 * of each one (templates/looks/previews/<preset file stem>.jpg, .png or .webp) when it has
 * been drawn.
 */

const fs = require('fs');
const path = require('path');
const S = require('./scaffold');
const { msg, has } = require('./i18n');
const { SCAFFOLD_ROOT, idToken } = require('./util');

const LOOKS_DIR = path.join(SCAFFOLD_ROOT, 'templates', 'looks');
const PREVIEWS_DIR = path.join(LOOKS_DIR, 'previews');
const PREVIEW_EXT = ['.png', '.jpg', '.jpeg', '.webp'];
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

let previewsDir = PREVIEWS_DIR;

/** Where the sample pages are read from (tests point it at a temporary folder). */
function setPreviewsDir(dir) {
  previewsDir = dir ? path.resolve(dir) : PREVIEWS_DIR;
}

/**
 * The sample page of a preset: { file, ext, width, height, mtimeMs, bytes },
 * or null when there is none. Only image files, only directly in the
 * previews folder.
 */
function previewFile(key) {
  if (!KEY_RE.test(String(key))) return null;
  for (const ext of PREVIEW_EXT) {
    const file = path.join(previewsDir, `${key}${ext}`);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      continue;
    }
    if (!stat.isFile()) continue;
    let info = null;
    try {
      const fd = fs.openSync(file, 'r');
      const head = Buffer.alloc(Math.min(stat.size, 256 * 1024));
      fs.readSync(fd, head, 0, head.length, 0);
      fs.closeSync(fd);
      info = S.imageInfo(head);
    } catch (err) {
      info = null;
    }
    if (!info) continue;
    return { file, ext, width: info.width || null, height: info.height || null, mtimeMs: stat.mtimeMs, bytes: stat.size };
  }
  return null;
}

/** The preview object of GET /api/presets: { url, width, height }, or null. */
function previewOf(key) {
  const found = previewFile(key);
  if (!found) return null;
  const version = `${Math.round(found.mtimeMs).toString(36)}${found.bytes.toString(36)}`;
  return { url: `/api/presets/${key}/preview?v=${version}`, width: found.width, height: found.height };
}

/** Every preset: { key, file, id, look_id, name, intent, color_mode, ..., drift_risks, preview }. */
function listPresets() {
  let names = [];
  try {
    names = fs.readdirSync(LOOKS_DIR).filter((n) => /\.ya?ml$/i.test(n)).sort();
  } catch (err) {
    return [];
  }
  const out = [];
  for (const name of names) {
    let doc = null;
    try {
      doc = S.yaml.parse(fs.readFileSync(path.join(LOOKS_DIR, name), 'utf8'));
    } catch (err) {
      doc = null;
    }
    if (!doc || typeof doc !== 'object' || !doc.style_block) continue;
    const id = String(doc.id || '');
    const key = name.replace(/\.ya?ml$/i, '');
    out.push({
      key,
      file: `templates/looks/${name}`,
      id,
      look_id: /^LOOK_[A-Z][A-Z0-9_]*$/.test(id.replace(/_V\d{2}$/, '')) ? id.replace(/_V\d{2}$/, '') : `LOOK_${idToken(key)}`,
      // The scaffold's presets are written in English; the dictionary carries their name and
      // intent in the interface languages (preset.<key>.name, preset.<key>.intent).
      name: has(`preset.${key}.name`) ? msg(`preset.${key}.name`) : String(doc.name || name),
      intent: has(`preset.${key}.intent`) ? msg(`preset.${key}.intent`) : String(doc.intent || ''),
      color_mode: doc.color_mode || null,
      line: doc.line || '',
      inking: doc.inking || '',
      tone: doc.tone || '',
      rendering: doc.rendering || '',
      lettering_style: doc.lettering_style || '',
      palette: Array.isArray(doc.palette) ? doc.palette : [],
      pairs_with: doc.pairs_with || null,
      // What tends to drift across pages with this look: the preset's own English text.
      drift_risks: Array.isArray(doc.drift_risks) ? doc.drift_risks.map(String) : [],
      style_block: String(doc.style_block).replace(/\r\n/g, '\n').trim(),
      preview: previewOf(key),
    });
  }
  return out;
}

function preset(key) {
  return listPresets().find((p) => p.key === key) || null;
}

/** A look ID for a style described in words: LOOK_ plus up to three of its words. */
function lookIdFor(description) {
  const stop = new Set(['A', 'AN', 'THE', 'AND', 'OF', 'WITH', 'IN', 'ON', 'UN', 'UNA', 'EL', 'LA', 'DE', 'CON', 'Y', 'EN', 'LOS', 'LAS', 'ESTILO', 'STYLE', 'COMIC']);
  const tokens = idToken(description, '').split('_').filter((w) => w && !stop.has(w) && !/^\d/.test(w)).slice(0, 3);
  return tokens.length ? `LOOK_${tokens.join('_')}`.slice(0, 40).replace(/_+$/, '') : 'LOOK_CUSTOM';
}

module.exports = { listPresets, preset, lookIdFor, previewFile, previewOf, setPreviewsDir, LOOKS_DIR, PREVIEWS_DIR, KEY_RE };
