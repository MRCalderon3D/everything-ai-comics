'use strict';
/**
 * Workspace access shared by every script and hook.
 *
 * A workspace root is any directory that contains project.yaml
 * ("production/" is only the default name). Layout: docs/conventions.md.
 * Shapes: docs/data-model.md. All returned paths are absolute; all "rel"
 * arguments are workspace-relative with forward slashes.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('./yaml');

const ID = {
  issue: /^ISS_\d{3}$/,
  scene: /^SC_\d{3}_\d{2}$/,
  beat: /^BT_\d{3}_\d{2}_\d{2}$/,
  page: /^PG_\d{3}_\d{3}$/,
  panel: /^PN_\d{3}_\d{3}_\d{2}$/,
  render: /^PG_\d{3}_\d{3}_V\d{2}$/,
  cover: /^CV_\d{3}$/,
  coverRender: /^CV_\d{3}_V\d{2}$/,
  lettering: /^L\d{2}$/,
  finding: /^F\d{2}$/,
  edition: /^ED_\d{3}_\d{2}$/,
  entity: /^(CHAR|LOC|PROP|LOOK)_[A-Z][A-Z0-9_]*$/,
  asset: /^(CHAR|LOC|PROP|LOOK)_[A-Z][A-Z0-9_]*_V\d{2}$/,
  wardrobe: /^WARD_[A-Z][A-Z0-9_]*$/,
};

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (err) {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (err) {
    return false;
  }
}

/** Walk up from a file or directory to the nearest dir holding project.yaml. */
function findWorkspaceRoot(start) {
  let dir = path.resolve(String(start || process.cwd()));
  if (isFile(dir)) dir = path.dirname(dir);
  for (let i = 0; i < 32; i++) {
    if (isFile(path.join(dir, 'project.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Parse a YAML file. Returns null when the file is missing; throws on bad YAML. */
function loadYaml(file) {
  if (!isFile(file)) return null;
  try {
    return yaml.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file}: ${err.message}`);
  }
}

function rel(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function abs(root, relPath) {
  return path.join(root, ...String(relPath).replace(/\\/g, '/').split('/'));
}

function loadProject(root) {
  return loadYaml(path.join(root, 'project.yaml'));
}

/** Issue IDs present under issues/, sorted. */
function listIssues(root) {
  const dir = path.join(root, 'issues');
  if (!isDir(dir)) return [];
  return fs.readdirSync(dir).filter((n) => ID.issue.test(n) && isDir(path.join(dir, n))).sort();
}

function issueDir(root, issueId) {
  return path.join(root, 'issues', issueId);
}

function loadIssue(root, issueId) {
  return loadYaml(path.join(issueDir(root, issueId), 'issue.yaml'));
}

/** Scene docs of an issue, sorted by ID: [{ id, file, doc }]. */
function listScenes(root, issueId) {
  const dir = path.join(issueDir(root, issueId), 'scenes');
  if (!isDir(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => /\.ya?ml$/i.test(n) && ID.scene.test(n.replace(/\.ya?ml$/i, '')))
    .sort()
    .map((n) => {
      const file = path.join(dir, n);
      return { id: n.replace(/\.ya?ml$/i, ''), file, doc: loadYaml(file) };
    });
}

/** Page IDs of an issue (directories under pages/), sorted. */
function listPageIds(root, issueId) {
  const dir = path.join(issueDir(root, issueId), 'pages');
  if (!isDir(dir)) return [];
  return fs.readdirSync(dir).filter((n) => ID.page.test(n) && isDir(path.join(dir, n))).sort();
}

/** "PG_001_004" -> "ISS_001". */
function issueOfPage(pageId) {
  const m = /^PG_(\d{3})_\d{3}$/.exec(String(pageId));
  return m ? `ISS_${m[1]}` : null;
}

/** "PG_001_004_V02" -> "PG_001_004". */
function pageOfRender(renderId) {
  const m = /^(PG_\d{3}_\d{3})_V\d{2}$/.exec(String(renderId));
  return m ? m[1] : null;
}

function pageDir(root, pageId) {
  return path.join(issueDir(root, issueOfPage(pageId)), 'pages', pageId);
}

function loadPage(root, pageId) {
  return loadYaml(path.join(pageDir(root, pageId), 'page.yaml'));
}

/**
 * Pages of an issue in reading order: [{ id, dir, file, doc }].
 * Sorted by page.number when present, else by ID. Pages whose page.yaml is
 * missing are returned with doc null.
 */
function listPages(root, issueId) {
  const pages = listPageIds(root, issueId).map((id) => {
    const dir = pageDir(root, id);
    const file = path.join(dir, 'page.yaml');
    return { id, dir, file, doc: loadYaml(file) };
  });
  return pages.sort((a, b) => {
    const na = a.doc && typeof a.doc.number === 'number' ? a.doc.number : Infinity;
    const nb = b.doc && typeof b.doc.number === 'number' ? b.doc.number : Infinity;
    if (na !== nb) return na - nb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Absolute path of a render image, trying each supported extension; null if
 * absent. Takes a page render (PG_001_004_V02) or a cover render (CV_001_V01).
 */
function renderFile(root, renderId) {
  if (ID.coverRender.test(String(renderId))) return coverRenderFile(root, renderId);
  const pageId = pageOfRender(renderId);
  if (!pageId) return null;
  const dir = path.join(pageDir(root, pageId), 'renders');
  for (const ext of IMAGE_EXTENSIONS) {
    const file = path.join(dir, renderId + ext);
    if (isFile(file)) return file;
  }
  return null;
}

/** Render IDs present on disk for a page, sorted by version. */
function listRenders(root, pageId) {
  const dir = path.join(pageDir(root, pageId), 'renders');
  if (!isDir(dir)) return [];
  const ids = new Set();
  for (const name of fs.readdirSync(dir)) {
    const ext = path.extname(name).toLowerCase();
    const base = name.slice(0, name.length - ext.length);
    if (IMAGE_EXTENSIONS.includes(ext) && ID.render.test(base)) ids.add(base);
  }
  return [...ids].sort();
}

/** Path of the review of a page render or a cover render (the file may not exist). */
function reviewFile(root, renderId) {
  if (ID.coverRender.test(String(renderId))) return coverReviewFile(root, renderId);
  const pageId = pageOfRender(renderId);
  if (!pageId) return null;
  return path.join(pageDir(root, pageId), 'reviews', `${renderId}.review.yaml`);
}

/** Visual review of a render, or null when none exists. */
function loadReview(root, renderId) {
  const file = reviewFile(root, renderId);
  return file ? loadYaml(file) : null;
}

/** All reviews of a page: [{ render, file, doc }], sorted by render ID. */
function listReviews(root, pageId) {
  const dir = path.join(pageDir(root, pageId), 'reviews');
  if (!isDir(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => /\.review\.ya?ml$/i.test(n))
    .sort()
    .map((n) => {
      const file = path.join(dir, n);
      return { render: n.replace(/\.review\.ya?ml$/i, ''), file, doc: loadYaml(file) };
    });
}

/** True when the review's verdict lets the render into a non-draft edition. */
function reviewPasses(review) {
  return !!review && (review.verdict === 'pass' || review.verdict === 'fixed');
}

// --- cover -------------------------------------------------------------------
// One cover per issue: issues/<ISS_ID>/cover/ holds cover.yaml, prompts/,
// renders/ and reviews/, laid out like a page directory. The cover ID carries
// the issue number (CV_001 is the cover of ISS_001).

/** "ISS_001" -> "CV_001". */
function coverIdOfIssue(issueId) {
  const m = /^ISS_(\d{3})$/.exec(String(issueId));
  return m ? `CV_${m[1]}` : null;
}

/** "CV_001" -> "ISS_001". */
function issueOfCover(coverId) {
  const m = /^CV_(\d{3})$/.exec(String(coverId));
  return m ? `ISS_${m[1]}` : null;
}

/** "CV_001_V02" -> "CV_001". */
function coverOfRender(renderId) {
  const m = /^(CV_\d{3})_V\d{2}$/.exec(String(renderId));
  return m ? m[1] : null;
}

/** An issue ID from an issue ID or a cover ID; null for anything else. */
function issueOfCoverArg(issueOrCover) {
  const text = String(issueOrCover);
  return ID.issue.test(text) ? text : issueOfCover(text);
}

/** Cover directory of an issue. Takes the issue ID or the cover ID. */
function coverDir(root, issueOrCover) {
  const issueId = issueOfCoverArg(issueOrCover);
  return issueId ? path.join(issueDir(root, issueId), 'cover') : null;
}

/** Path of cover.yaml (the file may not exist). Takes the issue ID or the cover ID. */
function coverFile(root, issueOrCover) {
  const dir = coverDir(root, issueOrCover);
  return dir ? path.join(dir, 'cover.yaml') : null;
}

/** cover.yaml of an issue, or null when the issue has no cover. */
function loadCover(root, issueOrCover) {
  const file = coverFile(root, issueOrCover);
  return file ? loadYaml(file) : null;
}

/** Absolute path of a cover render image, trying each supported extension; null if absent. */
function coverRenderFile(root, renderId) {
  const coverId = coverOfRender(renderId);
  if (!coverId) return null;
  const dir = path.join(coverDir(root, coverId), 'renders');
  for (const ext of IMAGE_EXTENSIONS) {
    const file = path.join(dir, renderId + ext);
    if (isFile(file)) return file;
  }
  return null;
}

/** Cover render IDs present on disk for an issue, sorted by version. */
function listCoverRenders(root, issueOrCover) {
  const base = coverDir(root, issueOrCover);
  const dir = base ? path.join(base, 'renders') : null;
  if (!dir || !isDir(dir)) return [];
  const ids = new Set();
  for (const name of fs.readdirSync(dir)) {
    const ext = path.extname(name).toLowerCase();
    const stem = name.slice(0, name.length - ext.length);
    if (IMAGE_EXTENSIONS.includes(ext) && ID.coverRender.test(stem)) ids.add(stem);
  }
  return [...ids].sort();
}

/** Path of the review of a cover render (the file may not exist). */
function coverReviewFile(root, renderId) {
  const coverId = coverOfRender(renderId);
  if (!coverId) return null;
  return path.join(coverDir(root, coverId), 'reviews', `${renderId}.review.yaml`);
}

/** All reviews of an issue's cover: [{ render, file, doc }], sorted by render ID. */
function listCoverReviews(root, issueOrCover) {
  const base = coverDir(root, issueOrCover);
  const dir = base ? path.join(base, 'reviews') : null;
  if (!dir || !isDir(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => /\.review\.ya?ml$/i.test(n))
    .sort()
    .map((n) => {
      const file = path.join(dir, n);
      return { render: n.replace(/\.review\.ya?ml$/i, ''), file, doc: loadYaml(file) };
    });
}

function loadCharacter(root, charId) {
  return loadYaml(path.join(root, 'characters', charId, 'character.yaml'));
}

function loadWardrobe(root, charId) {
  return loadYaml(path.join(root, 'characters', charId, 'wardrobe.yaml'));
}

function loadLocation(root, locId) {
  return loadYaml(path.join(root, 'locations', locId, 'location.yaml'));
}

function loadLocationMap(root, locId) {
  return loadYaml(path.join(root, 'locations', locId, 'map.yaml'));
}

function loadProp(root, propId) {
  return loadYaml(path.join(root, 'props', propId, 'prop.yaml'));
}

/** IDs of the entity directories under characters/, locations/ or props/. */
function listEntityIds(root, kind) {
  const dir = path.join(root, kind);
  if (!isDir(dir)) return [];
  return fs.readdirSync(dir).filter((n) => ID.entity.test(n) && isDir(path.join(dir, n))).sort();
}

/** references/manifest.yaml as a Map keyed by asset ID (empty when absent). */
function loadReferenceAssets(root) {
  const doc = loadYaml(path.join(root, 'references', 'manifest.yaml'));
  const map = new Map();
  for (const asset of (doc && Array.isArray(doc.assets) ? doc.assets : [])) {
    if (asset && asset.id) map.set(asset.id, asset);
  }
  return map;
}

/** "CHAR_MARA_TURN_MASTER_V01" -> "CHAR_MARA" using the registry, else null. */
function entityOfAsset(assets, assetId) {
  const asset = assets && assets.get ? assets.get(assetId) : null;
  return asset && asset.entity ? asset.entity : null;
}

/** The frozen style block text (project.style.style_block), or null. */
function loadStyleBlock(root, project) {
  const proj = project || loadProject(root);
  const relPath = (proj && proj.style && proj.style.style_block) || 'style/style-block.txt';
  const file = abs(root, relPath);
  return isFile(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim() : null;
}

function listEditions(root) {
  const dir = path.join(root, 'editions');
  if (!isDir(dir)) return [];
  return fs.readdirSync(dir).filter((n) => ID.edition.test(n) && isDir(path.join(dir, n))).sort();
}

function loadEdition(root, editionId) {
  return loadYaml(path.join(root, 'editions', editionId, 'edition.yaml'));
}

module.exports = {
  ID,
  IMAGE_EXTENSIONS,
  findWorkspaceRoot,
  loadYaml,
  rel,
  abs,
  loadProject,
  listIssues,
  issueDir,
  loadIssue,
  listScenes,
  listPageIds,
  issueOfPage,
  pageOfRender,
  pageDir,
  loadPage,
  listPages,
  renderFile,
  listRenders,
  reviewFile,
  loadReview,
  listReviews,
  reviewPasses,
  coverIdOfIssue,
  issueOfCover,
  coverOfRender,
  coverDir,
  coverFile,
  loadCover,
  coverRenderFile,
  listCoverRenders,
  coverReviewFile,
  listCoverReviews,
  loadCharacter,
  loadWardrobe,
  loadLocation,
  loadLocationMap,
  loadProp,
  listEntityIds,
  loadReferenceAssets,
  entityOfAsset,
  loadStyleBlock,
  listEditions,
  loadEdition,
};
