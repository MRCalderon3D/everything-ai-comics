'use strict';
/** Resolve image provider modules from manifests/image-providers.json. */

const path = require('path');
const { ROOT, exists, readJson } = require('./fsx');

/** The scaffold has one provider kind. The map stays so callers can pass it. */
const KIND_TO_MANIFEST = {
  image: 'image-providers.json',
};

/** List provider manifest entries (kind is 'image' or omitted). */
function listProviders(kind = null, root = ROOT) {
  const kinds = kind ? [kind] : Object.keys(KIND_TO_MANIFEST);
  const out = [];
  for (const k of kinds) {
    if (!KIND_TO_MANIFEST[k]) continue;
    const file = path.join(root, 'manifests', KIND_TO_MANIFEST[k]);
    if (!exists(file)) continue;
    for (const entry of readJson(file).providers || []) {
      out.push(Object.assign({ kind: k }, entry));
    }
  }
  return out;
}

/**
 * Load a provider module by kind + id. Throws with the known ids when the
 * provider is unknown. Returns { entry, module }.
 */
function loadProvider(kind, id, root = ROOT) {
  const candidates = listProviders(kind || 'image', root);
  const entry = candidates.find((p) => p.id === id);
  if (!entry) {
    const known = candidates.map((p) => p.id).join(', ');
    throw new Error(`unknown image provider "${id}" (known: ${known || 'none, is manifests/image-providers.json missing?'})`);
  }
  const file = path.join(root, ...String(entry.file).split('/'));
  if (!exists(file)) throw new Error(`provider file missing: ${entry.file}`);
  return { entry, module: require(file) };
}

/** Shorthand: the module of an image provider. */
function loadImageProvider(id, root = ROOT) {
  return loadProvider('image', id, root).module;
}

/**
 * Which image provider a page uses: an explicit id, else the page's
 * generation.provider, else the project default, else harness-native.
 */
function resolveProviderId(explicit, page, project) {
  if (explicit && explicit !== true) return String(explicit);
  if (page && page.generation && page.generation.provider) return String(page.generation.provider);
  if (project && project.default_providers && project.default_providers.image) {
    return String(project.default_providers.image);
  }
  return 'harness-native';
}

module.exports = { listProviders, loadProvider, loadImageProvider, resolveProviderId, KIND_TO_MANIFEST };
