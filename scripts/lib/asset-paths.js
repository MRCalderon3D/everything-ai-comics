'use strict';
/**
 * Names and places of asset-scoped work: reference sheets for characters,
 * locations, props, and looks. compile-prompts.js writes the packages,
 * generate-assets.js picks the candidate file; both read this file so they
 * cannot disagree.
 *
 * A sheet is an entity, a kind, and sometimes a variant: the outfit of a
 * wardrobe sheet, the subject of a detail study, the time of day of a plate
 * that is not the location's default state. The variant is part of every
 * name, so two outfits or two details of one entity never share a file.
 *
 *   package    <refs dir>/prompts/<provider>.<kind>.yaml
 *              <refs dir>/prompts/<provider>.wardrobe.<WARD_ID>.yaml
 *              <refs dir>/prompts/<provider>.detail.<slug>.yaml
 *              <refs dir>/prompts/<provider>.plate.<state>.yaml   (non-default time)
 *              references/style/prompts/<provider>.<LOOK_ID>.yaml
 *              references/style/prompts/<provider>.<LOOK_ID>.detail.<slug>.yaml
 *   package id PP_<ENTITY_ID>_<PROVIDER>-<TAG>[-<VARIANT>]
 *   candidate  <refs dir>/<ENTITY_ID>_<TAG>[_<VARIANT>]_V##.png
 *              references/style/<LOOK_ID>_V##.png
 *
 * <refs dir> is characters/<ID>/refs, locations/<ID>/refs, or
 * props/<ID>/refs. A candidate never takes the _MASTER name. Promotion to
 * master is an approval step; generation only ever adds the next free
 * version.
 */

const fs = require('fs');
const path = require('path');
const ws = require('./workspace');
const { providerTag } = require('../../providers/lib/common');

const ENTITY_DIRS = { CHAR: 'characters', LOC: 'locations', PROP: 'props' };

/** Sheet kind (the registry's `kind`) -> tag used in package IDs and file names. */
const SHEET_TAGS = {
  turnaround: 'TURN',
  expressions: 'EXPR',
  wardrobe: 'WARD',
  plate: 'PLATE',
  prop: 'SHEET',
  look: 'LOOK',
  detail: 'DETAIL',
};

/** Sheet kinds each entity type accepts. */
const SHEET_KINDS = {
  CHAR: ['turnaround', 'expressions', 'wardrobe', 'detail'],
  LOC: ['plate', 'detail'],
  PROP: ['prop', 'detail'],
  LOOK: ['look', 'detail'],
};

const SLUG_MAX = 40;

/** "CHAR" | "LOC" | "PROP" | "LOOK", or null when the ID is not an entity ID. */
function entityType(entityId) {
  const id = String(entityId || '');
  if (!ws.ID.entity.test(id)) return null;
  return id.split('_')[0];
}

/** Workspace-relative directory that holds an entity's reference images. */
function refsDir(entityId) {
  const type = entityType(entityId);
  if (!type) return null;
  return type === 'LOOK' ? 'references/style' : `${ENTITY_DIRS[type]}/${entityId}/refs`;
}

function promptsDir(entityId) {
  const dir = refsDir(entityId);
  return dir ? `${dir}/prompts` : null;
}

/**
 * Lowercase-kebab slug of a detail subject: "The cut on his left hand." ->
 * "cut-on-his-left-hand". A leading article is dropped, and the slug is cut
 * at a word boundary once it passes 40 characters. Empty when the text has
 * no letter or digit.
 */
function subjectSlug(subject) {
  const words = String(subject || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (words.length > 1 && ['the', 'a', 'an'].includes(words[0])) words.shift();
  let slug = '';
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (slug && next.length > SLUG_MAX) break;
    slug = next;
  }
  return slug.slice(0, SLUG_MAX).replace(/-+$/, '');
}

/**
 * Variant of a sheet, in both spellings: `file` goes into the package file
 * name, `token` ([A-Z0-9_]) into the package ID and the candidate name.
 * Null for a sheet with no variant.
 * @param {string} entityId
 * @param {string} kind
 * @param {{outfit?: string, subject?: string, time?: string, defaultTime?: string}} [options]
 * @returns {{file: string, token: string}|null}
 */
function sheetVariant(entityId, kind, options = {}) {
  if (kind === 'wardrobe' && options.outfit) {
    const outfit = String(options.outfit);
    // WARD_MARA_OILSKIN on CHAR_MARA -> OILSKIN; any other shape keeps what follows WARD_.
    const own = `WARD_${String(entityId).replace(/^CHAR_/, '')}_`;
    const token = outfit.startsWith(own) && outfit.length > own.length
      ? outfit.slice(own.length) : outfit.replace(/^WARD_/, '');
    return { file: outfit, token: token.toUpperCase().replace(/[^A-Z0-9]+/g, '_') };
  }
  if (kind === 'detail') {
    const slug = subjectSlug(options.subject);
    return slug ? { file: slug, token: slug.toUpperCase().replace(/-/g, '_') } : null;
  }
  if (kind === 'plate' && options.time && options.time !== options.defaultTime) {
    const state = String(options.time).toLowerCase().replace(/[^a-z0-9]+/g, '_');
    return { file: state, token: state.toUpperCase() };
  }
  return null;
}

/** Workspace-relative path of an asset package. */
function packageFile(entityId, providerId, kind, variant = null) {
  const dir = promptsDir(entityId);
  if (!dir) return null;
  const suffix = variant ? `.${variant.file}` : '';
  // Looks share one prompts/ directory, so the LOOK ID is in the file name.
  if (entityType(entityId) === 'LOOK') {
    return `${dir}/${providerId}.${entityId}${kind === 'look' ? '' : `.${kind}`}${suffix}.yaml`;
  }
  return `${dir}/${providerId}.${kind}${suffix}.yaml`;
}

/** PP_<ENTITY_ID>_<PROVIDER>-<TAG>[-<VARIANT>], inside the prompt-package ID pattern. */
function packageId(entityId, providerId, kind, variant = null) {
  return `PP_${entityId}_${providerTag(providerId)}-${SHEET_TAGS[kind]}${variant ? `-${variant.token}` : ''}`;
}

/**
 * The sheet a compiled asset package is for, read from its ID:
 * { kind, tag, variant, stemTag }. stemTag is what follows the entity ID
 * in a candidate name (TURN, WARD_OILSKIN). Null when the ID names no sheet.
 */
function sheetOfPackage(pkg) {
  if (!pkg || !pkg.asset || !pkg.provider) return null;
  const prefix = `PP_${pkg.asset}_${providerTag(pkg.provider)}-`;
  const id = String(pkg.id || '');
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  const cut = rest.indexOf('-');
  const tag = cut === -1 ? rest : rest.slice(0, cut);
  const variant = cut === -1 ? null : rest.slice(cut + 1);
  const kind = Object.keys(SHEET_TAGS).find((k) => SHEET_TAGS[k] === tag);
  if (!kind || (variant !== null && !/^[A-Z0-9][A-Z0-9_]*$/.test(variant))) return null;
  return { kind, tag, variant, stemTag: variant ? `${tag}_${variant}` : tag };
}

/** Every package file compiled for an entity, sorted (absolute paths). */
function listPackageFiles(root, entityId) {
  const rel = promptsDir(entityId);
  const dir = rel ? ws.abs(root, rel) : null;
  if (!dir || !fs.existsSync(dir)) return [];
  const look = entityType(entityId) === 'LOOK';
  return fs.readdirSync(dir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .filter((name) => !look || name.split('.').includes(entityId))
    .sort()
    .map((name) => path.join(dir, name));
}

/**
 * Stem shared by every version of a sheet: CHAR_MARA_TURN,
 * CHAR_MARA_WARD_OILSKIN, PROP_FLARE_GUN_SHEET, LOOK_NOIR_INK.
 * @param {string} stemTag tag plus variant, as sheetOfPackage().stemTag
 */
function candidateStem(entityId, stemTag) {
  return entityType(entityId) === 'LOOK' && stemTag === SHEET_TAGS.look ? entityId : `${entityId}_${stemTag}`;
}

/**
 * The next free candidate of a sheet: one above the highest version found
 * among the files in the refs directory and the registry entries, masters
 * included, so a version number is never reused.
 * @returns {{id: string, version: number, rel: string}} rel has the given extension
 */
function nextCandidate(root, entityId, stemTag, ext = '.png') {
  const stem = candidateStem(entityId, stemTag);
  const pattern = new RegExp(`^${stem}(?:_MASTER)?_V(\\d{2})$`);
  let max = 0;
  const dirRel = refsDir(entityId);
  const dir = ws.abs(root, dirRel);
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      const m = pattern.exec(name.replace(/\.[^.]+$/, ''));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  for (const id of ws.loadReferenceAssets(root).keys()) {
    const m = pattern.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  if (max >= 99) throw new Error(`${stem} already has 99 versions`);
  const id = `${stem}_V${String(max + 1).padStart(2, '0')}`;
  return { id, version: max + 1, rel: `${dirRel}/${id}${ext}` };
}

module.exports = {
  ENTITY_DIRS,
  SHEET_TAGS,
  SHEET_KINDS,
  entityType,
  refsDir,
  promptsDir,
  subjectSlug,
  sheetVariant,
  packageFile,
  packageId,
  sheetOfPackage,
  listPackageFiles,
  candidateStem,
  nextCandidate,
};
