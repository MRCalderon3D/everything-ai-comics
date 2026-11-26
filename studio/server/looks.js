'use strict';
/**
 * The look presets of the scaffold (templates/looks/*.yaml), as the style
 * screen lists them and as style.define applies them.
 */

const fs = require('fs');
const path = require('path');
const S = require('./scaffold');
const { msg, has } = require('./i18n');
const { SCAFFOLD_ROOT, idToken } = require('./util');

const LOOKS_DIR = path.join(SCAFFOLD_ROOT, 'templates', 'looks');

/** Every preset: { key, file, id, look_id, name, intent, color_mode, ... }. */
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
    out.push({
      key: name.replace(/\.ya?ml$/i, ''),
      file: `templates/looks/${name}`,
      id,
      look_id: /^LOOK_[A-Z][A-Z0-9_]*$/.test(id.replace(/_V\d{2}$/, '')) ? id.replace(/_V\d{2}$/, '') : `LOOK_${idToken(name.replace(/\.ya?ml$/i, ''))}`,
      // The scaffold's presets are written in English; the dictionary carries their name and
      // intent in the interface languages (preset.<key>.name, preset.<key>.intent).
      name: has(`preset.${name.replace(/\.ya?ml$/i, '')}.name`) ? msg(`preset.${name.replace(/\.ya?ml$/i, '')}.name`) : String(doc.name || name),
      intent: has(`preset.${name.replace(/\.ya?ml$/i, '')}.intent`) ? msg(`preset.${name.replace(/\.ya?ml$/i, '')}.intent`) : String(doc.intent || ''),
      color_mode: doc.color_mode || null,
      line: doc.line || '',
      inking: doc.inking || '',
      tone: doc.tone || '',
      rendering: doc.rendering || '',
      lettering_style: doc.lettering_style || '',
      palette: Array.isArray(doc.palette) ? doc.palette : [],
      pairs_with: doc.pairs_with || null,
      style_block: String(doc.style_block).replace(/\r\n/g, '\n').trim(),
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

module.exports = { listPresets, preset, lookIdFor, LOOKS_DIR };
