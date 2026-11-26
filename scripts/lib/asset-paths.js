'use strict';
/**
 * Names and places of asset-scoped work: reference sheets for characters,
 * locations, props, and looks. compile-prompts.js writes the packages,
 * generate-assets.js picks the candidate file; both read this file so they
 * cannot disagree.
 *
 *   package    characters/<ID>/refs/prompts/<provider>.<kind>.yaml
 *              locations/<ID>/refs/prompts/<provider>.<kind>.yaml
 *              props/<ID>/refs/prompts/<provider>.<kind>.yaml
 *              references/style/prompts/<provider>.<LOOK_ID>.yaml
 *   candidate  <refs dir>/<ENTITY_ID>_<TAG>_V##.png
 *              references/style/<LOOK_ID>_V##.png
 *
 * A candidate never takes the _MASTER name. Promotion to master is an
 * approval step; generation only ever adds the next free version.
 */

const fs = require('fs');
const path = require('path');
const ws = require('./workspace');
const { providerTag } = require('../../providers/lib/common');

const ENTITY_DIRS = { CHAR: 'characters', LOC: 'locations', PROP: 'props' };

/** Sheet kind (the registry's `kind`) -> tag used in package and file names. */
const SHEET_TAGS = {
  turnaround: 'TURN',
  expressions: 'EXPR',
  wardrobe: 'WARD',
  plate: 'PLATE',
  prop: 'PROP',
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

/** Workspace-relative path of an asset package. */
function packageFile(entityId, providerId, kind) {
  const dir = promptsDir(entityId);
  if (!dir) return null;
  // Looks share one prompts/ directory, so the LOOK ID is in the file name.
  if (entityType(entityId) === 'LOOK') {
    return `${dir}/${providerId}.${entityId}${kind === 'look' ? '' : `.${kind}`}.yaml`;
  }
  return `${dir}/${providerId}.${kind}.yaml`;
}

/** PP_<ENTITY_ID>_<PROVIDER>-<TAG>, inside the prompt-package ID pattern. */
function packageId(entityId, providerId, kind) {
  return `PP_${entityId}_${providerTag(providerId)}-${SHEET_TAGS[kind]}`;
}

/** The sheet a compiled asset package is for: { kind, tag }, or null. */
function sheetOfPackage(pkg) {
  if (!pkg || !pkg.asset || !pkg.provider) return null;
  const prefix = `PP_${pkg.asset}_${providerTag(pkg.provider)}-`;
  const id = String(pkg.id || '');
  if (!id.startsWith(prefix)) return null;
  const tag = id.slice(prefix.length);
  const kind = Object.keys(SHEET_TAGS).find((k) => SHEET_TAGS[k] === tag);
  return kind ? { kind, tag } : null;
}

/** Package files compiled for an entity, sorted (absolute paths). */
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

/** Stem shared by every version of a sheet: CHAR_MARA_TURN, LOOK_NOIR_INK. */
function candidateStem(entityId, tag) {
  return entityType(entityId) === 'LOOK' && tag === SHEET_TAGS.look ? entityId : `${entityId}_${tag}`;
}

/**
 * The next free candidate of a sheet: one above the highest version found
 * among the files in the refs directory and the registry entries, masters
 * included, so a version number is never reused.
 * @returns {{id: string, version: number, rel: string}} rel has the given extension
 */
function nextCandidate(root, entityId, tag, ext = '.png') {
  const stem = candidateStem(entityId, tag);
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
  packageFile,
  packageId,
  sheetOfPackage,
  listPackageFiles,
  candidateStem,
  nextCandidate,
};
