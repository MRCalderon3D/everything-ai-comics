'use strict';
/**
 * The one place the studio reaches into the scaffold. Modules are loaded
 * lazily, when first used, so the server starts even while a script is
 * being changed, and a missing function is reported by name instead of
 * crashing at start.
 */

const fs = require('fs');
const path = require('path');
const { SCAFFOLD_ROOT, HttpError } = require('./util');

const cache = new Map();

function load(rel) {
  if (!cache.has(rel)) cache.set(rel, require(path.join(SCAFFOLD_ROOT, ...rel.split('/'))));
  return cache.get(rel);
}

/** A function of a scaffold module, or a 501 that names what is missing. */
function fn(rel, name) {
  let mod;
  try {
    mod = load(rel);
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' && !fs.existsSync(path.join(SCAFFOLD_ROOT, ...rel.split('/')))) {
      throw new HttpError(501, 'scaffold_missing', `The scaffold does not provide ${rel} yet.`);
    }
    throw err;
  }
  if (typeof mod[name] !== 'function') {
    throw new HttpError(501, 'scaffold_missing', `The scaffold's ${rel} does not export ${name} yet.`);
  }
  return mod[name];
}

function has(rel, name) {
  try {
    const mod = load(rel);
    return name ? typeof mod[name] === 'function' : true;
  } catch (err) {
    return false;
  }
}

const S = {
  ROOT: SCAFFOLD_ROOT,
  has,
  get ws() { return load('scripts/lib/workspace.js'); },
  get yaml() { return load('scripts/lib/yaml.js'); },
  get png() { return load('scripts/lib/png.js'); },
  get schema() { return load('scripts/lib/schema.js'); },
  get artifacts() { return load('scripts/lib/artifacts.js'); },
  get assetPaths() { return load('scripts/lib/asset-paths.js'); },
  get imageInfo() { return load('scripts/lib/image-info.js').imageInfo; },
  get providers() { return load('scripts/lib/providers.js'); },
  get pipeline() { return load('scripts/lib/page-pipeline.js'); },
  get coverLib() { return load('scripts/lib/cover.js'); },
  get yamlEdit() { return has('scripts/lib/yaml-edit.js') ? load('scripts/lib/yaml-edit.js') : null; },

  version() {
    try {
      return fs.readFileSync(path.join(SCAFFOLD_ROOT, 'VERSION'), 'utf8').trim();
    } catch (err) {
      return null;
    }
  },

  createProject: (...a) => fn('scripts/create-project.js', 'createProject')(...a),
  validateWorkspace: (...a) => fn('scripts/validate-workspace.js', 'validateWorkspace')(...a),
  checkContinuity: (...a) => fn('scripts/check-continuity.js', 'checkContinuity')(...a),
  hintFor: (...a) => fn('scripts/check-continuity.js', 'hintFor')(...a),
  buildReferencePlan: (...a) => fn('scripts/build-reference-plan.js', 'buildReferencePlan')(...a),
  compilePage: (...a) => fn('scripts/compile-prompts.js', 'compilePage')(...a),
  compileAsset: (...a) => fn('scripts/compile-prompts.js', 'compileAsset')(...a),
  compileCover: (...a) => fn('scripts/compile-prompts.js', 'compileCover')(...a),
  generateAssets: (...a) => fn('scripts/generate-assets.js', 'generateAssets')(...a),
  collectPackages: (...a) => fn('scripts/generate-assets.js', 'collectPackages')(...a),
  runPackage: (...a) => fn('scripts/generate-assets.js', 'runPackage')(...a),
  approveAsset: (...a) => fn('scripts/approve-asset.js', 'approveAsset')(...a),
  addUserRequest: (...a) => fn('scripts/lib/review-requests.js', 'addUserRequest')(...a),
  approveCover: (...a) => fn('scripts/lib/cover.js', 'approveCover')(...a),
  letterPage: (...a) => fn('scripts/letter-pages.js', 'letterPage')(...a),
  registerLetteredFile: (...a) => fn('scripts/letter-pages.js', 'registerLetteredFile')(...a),
  buildEdition: (...a) => fn('scripts/build-edition.js', 'buildEdition')(...a),
  draftEdition: (...a) => fn('scripts/build-edition.js', 'draftEdition')(...a),

  /** Formats build-edition.js knows (pdf, cbz, web, and images and epub once they land). */
  editionFormats() {
    try {
      const formats = load('scripts/build-edition.js').FORMATS;
      if (Array.isArray(formats)) return formats.slice();
      if (formats && typeof formats === 'object') return Object.keys(formats);
    } catch (err) {
      // fall through
    }
    return ['pdf', 'cbz', 'web'];
  },

  /** Image provider ids in manifests/image-providers.json. */
  providerIds() {
    try {
      return S.providers.listProviders('image').map((p) => p.id);
    } catch (err) {
      return [];
    }
  },

  /** Schema names with a file in schemas/. */
  schemaNames() {
    try {
      return fs.readdirSync(path.join(SCAFFOLD_ROOT, 'schemas'))
        .filter((n) => n.endsWith('.schema.json'))
        .map((n) => n.replace(/\.schema\.json$/, ''))
        .sort();
    } catch (err) {
      return [];
    }
  },

  loadSchema(name) {
    if (!/^[a-z][a-z0-9-]*$/.test(String(name))) return null;
    return S.artifacts.loadSchema(name);
  },

  /** Validate a document against a named schema: [{ path, message }]. */
  schemaFindings(name, doc) {
    const schema = S.loadSchema(name);
    if (!schema) return [];
    try {
      return S.schema.validate(schema, doc).errors.map((e) => ({ path: e.path, message: e.message }));
    } catch (err) {
      return [{ path: '$', message: `schema check failed: ${err.message}` }];
    }
  },
};

module.exports = S;
