#!/usr/bin/env node
'use strict';
/**
 * Hook: protect-approved-assets (event: before a file write/edit).
 * Blocks three kinds of overwrite, each of which would destroy evidence:
 *   1. a reference asset whose status is "approved" in references/manifest.yaml
 *      (approved masters are immutable);
 *   2. any existing file under a page's renders/ directory (a repair is a
 *      sibling version, never an overwrite);
 *   3. any existing file under editions/<ED_ID>/exports/ (a rebuilt edition
 *      gets a new ID).
 * In every case the message says which next version to create instead.
 * Exit 0 = allow; exit 2 = block (message on stderr).
 */

const path = require('path');
const fs = require('fs');
const {
  readStdinJson, eventFilePath, findWorkspaceRoot, workspaceRelPath, displayPath,
  requireScriptsLib, run,
} = require('./lib');

const RENDER_PATH = /^issues\/[^/]+\/pages\/([^/]+)\/renders\/([^/]+)$/;
const EXPORT_PATH = /^editions\/([^/]+)\/exports\/.+$/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function listNames(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (err) {
    return [];
  }
}

/** Next free render ID of a page: highest _V## on disk plus one. */
function nextRenderId(rendersDir, pageId) {
  let max = 0;
  for (const name of listNames(rendersDir)) {
    const m = /_V(\d{2})(?:\.|$)/.exec(name);
    if (m && name.startsWith(pageId)) max = Math.max(max, Number(m[1]));
  }
  return `${pageId}_V${pad2(max + 1)}`;
}

/** Next free edition ID for the same issue: highest ED_<issue>_## plus one. */
function nextEditionId(editionsDir, editionId) {
  const m = /^(ED_\d{3})_(\d{2})$/.exec(editionId);
  if (!m) return 'a new edition ID';
  let max = Number(m[2]);
  for (const name of listNames(editionsDir)) {
    const other = /^(ED_\d{3})_(\d{2})$/.exec(name);
    if (other && other[1] === m[1]) max = Math.max(max, Number(other[2]));
  }
  return `${m[1]}_${pad2(max + 1)}`;
}

/** "CHAR_MARA_TURN_MASTER_V01" -> "CHAR_MARA_TURN_MASTER_V02". */
function nextAssetId(assetId) {
  const m = /^(.*_V)(\d{2})$/.exec(String(assetId));
  return m ? `${m[1]}${pad2(Number(m[2]) + 1)}` : `${assetId} with the next _V## suffix`;
}

function normalize(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

async function handle(event) {
  const file = eventFilePath(event || {});
  if (!file) return 0;
  const rel = workspaceRelPath(file);
  if (!rel) return 0;
  const root = findWorkspaceRoot(file);
  const shown = displayPath(file);
  const exists = fs.existsSync(file);

  // Renders: versioned candidates, never overwritten.
  const render = RENDER_PATH.exec(rel);
  if (render) {
    if (!exists) return 0;
    const next = nextRenderId(path.dirname(file), render[1]);
    process.stderr.write(
      `protect-approved-assets: BLOCKED write to ${shown}. A render is never overwritten: ` +
      'earlier versions stay on disk for comparison and for the review trail.\n' +
      `Create the next version instead (${next}) and point page.yaml current_render at it once it is reviewed.\n`
    );
    return 2;
  }

  // Exports: a built edition file is final.
  const exported = EXPORT_PATH.exec(rel);
  if (exported) {
    if (!exists) return 0;
    const next = nextEditionId(path.join(root, 'editions'), exported[1]);
    process.stderr.write(
      `protect-approved-assets: BLOCKED write to ${shown}. An export is never overwritten: ` +
      `${exported[1]} already shipped this file.\n` +
      `Create the next edition instead (${next}, with supersedes: ${exported[1]}) and build that.\n`
    );
    return 2;
  }

  // Reference assets: approved masters are immutable.
  if (rel === 'references/manifest.yaml') return 0; // status changes live here
  const manifestFile = path.join(root, 'references', 'manifest.yaml');
  if (!fs.existsSync(manifestFile)) return 0;
  let manifest;
  try {
    const yaml = requireScriptsLib('yaml');
    manifest = yaml.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (err) {
    return 0; // unreadable manifest: do not block on our own failure
  }
  const assets = (manifest && Array.isArray(manifest.assets)) ? manifest.assets : [];
  const base = rel.split('/').pop();
  const stem = base.replace(/\.[^.]+$/, '');
  const inReferenceDir = rel.startsWith('references/') || rel.split('/').includes('refs');
  for (const asset of assets) {
    if (!asset || asset.status !== 'approved') continue;
    const assetPath = normalize(asset.path).replace(/^production\//, '');
    const matches = (assetPath && assetPath === rel) ||
      (inReferenceDir && asset.id && stem === asset.id);
    if (!matches) continue;
    process.stderr.write(
      `protect-approved-assets: BLOCKED write to ${shown}. Asset ${asset.id || assetPath} is approved, ` +
      'and approved masters are immutable.\n' +
      `Create the next version instead (${nextAssetId(asset.id)}), register it in references/manifest.yaml, ` +
      'and mark the old one superseded once the new one is approved.\n'
    );
    return 2;
  }
  return 0;
}

module.exports = { handle, nextRenderId, nextEditionId, nextAssetId };

if (require.main === module) {
  run('protect-approved-assets', async () => handle(await readStdinJson()));
}
