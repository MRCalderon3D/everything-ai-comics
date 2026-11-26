#!/usr/bin/env node
'use strict';
/**
 * approve-asset.js: record a person's approval of a reference candidate.
 *
 * Generation saves a sheet as a candidate, <ENTITY_ID>_<TAG>_V## in the
 * entity's refs directory (a look page as <LOOK_ID>_V## under
 * references/style/). A candidate never carries _MASTER. When a person has
 * looked at it and approved it, this script does the bookkeeping the
 * conventions ask for, in one step:
 *
 *   1. copies the candidate to its master name, the same name with _MASTER
 *      before the version (CHAR_MARA_TURN_V02 -> CHAR_MARA_TURN_MASTER_V02).
 *      The candidate stays where it is, and no existing file is replaced;
 *   2. registers the master in references/manifest.yaml as approved, with
 *      its kind, its single default role, a sha256, who approved it and
 *      when, the candidate it came from, and the generation record that
 *      produced that candidate when there is one;
 *   3. adds the master to the entity file's references (and to the outfit's
 *      references for a wardrobe sheet);
 *   4. for a look master, freezes the style: project.style.look_refs lists
 *      the master and project.style.style_block names the block file, which
 *      from then on is reused word for word.
 *
 * A sheet that already has an approved master is refused unless --supersede
 * is given. Then the old entry becomes superseded and its file stays on
 * disk under its own versioned name; entity files and look_refs move to the
 * new master.
 *
 * The script records a decision. It does not make one: nothing here looks
 * at the image.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseArgs, helpIfRequested } = require('./lib/cli');
const { pipelineError, dateStamp } = require('./lib/page-pipeline');
const { toPosix } = require('./lib/fsx');
const assetPaths = require('./lib/asset-paths');
const edit = require('./lib/yaml-edit');
const ws = require('./lib/workspace');
const yaml = require('./lib/yaml');
const { roleOfAsset } = require('./build-reference-plan');

const HELP = `
approve-asset.js: promote an approved reference candidate to a master.

Usage:
  node scripts/approve-asset.js --candidate <path-or-stem> [--root <workspace>]
                                [--note "<text>"] [--supersede] [--by <name>] [--json]

Options:
  --candidate <x>  The candidate to approve: a path (absolute, or relative to
                   the workspace root) or its asset stem, e.g.
                   CHAR_MARA_TURN_V02 or LOOK_NOIR_INK_V03.
  --root <dir>     Workspace root. Default: the workspace found from the
                   candidate path, else from the current directory.
  --note <text>    Stored as the registry entry's notes.
  --supersede      Replace the approved master of the same sheet. The old
                   entry becomes superseded and its file stays on disk.
  --by <name>      Who approved. Default: human.
  --json           Print the result as JSON.
  --help           Show this help.

What it writes:
  <refs dir>/<STEM>_MASTER_V##.<ext>     a copy of the candidate
  references/manifest.yaml               the new approved entry
  the entity file                        its references list
  project.yaml (look masters only)       style.look_refs and style.style_block

Run it after a person has approved the image. It records the approval; it
does not judge the drawing.
`;

const ENTITY_FILES = {
  CHAR: (id) => `characters/${id}/character.yaml`,
  LOC: (id) => `locations/${id}/location.yaml`,
  PROP: (id) => `props/${id}/prop.yaml`,
};
const VERSION = /_V(\d{2})$/;

function sha256Of(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** LOOK entity IDs the workspace knows: the registry, look_refs, generation records, compiled packages. */
function knownLooks(root, assets) {
  const out = new Set();
  for (const asset of assets.values()) {
    if (/^LOOK_/.test(String(asset.entity || ''))) out.add(String(asset.entity));
  }
  const generations = path.join(root, 'generations');
  if (fs.existsSync(generations)) {
    for (const name of fs.readdirSync(generations)) if (/^LOOK_/.test(name) && ws.ID.entity.test(name)) out.add(name);
  }
  const prompts = ws.abs(root, 'references/style/prompts');
  if (fs.existsSync(prompts)) {
    for (const name of fs.readdirSync(prompts)) {
      const part = name.split('.').find((p) => /^LOOK_/.test(p) && ws.ID.entity.test(p));
      if (part) out.add(part);
    }
  }
  return [...out];
}

/** Entity of a look candidate: the longest known LOOK ID it starts with, else what its name says. */
function lookEntityOf(root, assets, base) {
  const known = knownLooks(root, assets)
    .filter((id) => base === id || base.startsWith(`${id}_`))
    .sort((a, b) => b.length - a.length);
  if (known.length) return known[0];
  const cut = base.indexOf('_DETAIL_');
  return cut > 0 ? base.slice(0, cut) : base;
}

/** Find the image file of a candidate stem in the workspace's reference directories. */
function findByStem(root, stem) {
  const dirs = ['references/style'];
  for (const [prefix, folder] of Object.entries(assetPaths.ENTITY_DIRS)) {
    if (!stem.startsWith(`${prefix}_`)) continue;
    for (const id of ws.listEntityIds(root, folder)) {
      if (stem.startsWith(`${id}_`)) dirs.push(`${folder}/${id}/refs`);
    }
  }
  const found = [];
  for (const dir of dirs) {
    for (const ext of ws.IMAGE_EXTENSIONS) {
      const rel = `${dir}/${stem}${ext}`;
      if (fs.existsSync(ws.abs(root, rel))) found.push(rel);
    }
  }
  return found;
}

/**
 * Work out what a candidate is from its place and its name.
 * @returns {{rel: string, stem: string, ext: string, dir: string, entity: string, type: string,
 *            kind: string, base: string, version: string}}
 */
function describeCandidate(root, candidate, assets) {
  const given = String(candidate || '').trim();
  if (!given) throw pipelineError('bad_arguments', 'candidate is required: a path or an asset stem such as CHAR_MARA_TURN_V02');
  const looksLikePath = /[\\/]/.test(given) || ws.IMAGE_EXTENSIONS.includes(path.extname(given).toLowerCase());

  let rel;
  if (looksLikePath) {
    const absolute = path.isAbsolute(given) ? given : ws.abs(root, given);
    rel = ws.rel(root, absolute);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw pipelineError('candidate_invalid', `${toPosix(given)} is outside the workspace ${toPosix(root)}`);
    }
    if (!fs.existsSync(absolute)) throw pipelineError('candidate_missing', `candidate file not found: ${rel}`);
  } else {
    const found = findByStem(root, given);
    if (!found.length) {
      throw pipelineError('candidate_missing',
        `no image named ${given} in the reference directories (characters|locations|props/<ID>/refs/, references/style/)`);
    }
    if (found.length > 1) {
      throw pipelineError('candidate_invalid', `${given} matches more than one file (${found.join(', ')}); pass the path instead`);
    }
    rel = found[0];
  }

  const ext = path.extname(rel).toLowerCase();
  const stem = path.basename(rel).slice(0, path.basename(rel).length - path.extname(rel).length);
  const dir = path.posix.dirname(rel);
  if (!ws.IMAGE_EXTENSIONS.includes(ext)) {
    throw pipelineError('candidate_invalid', `${rel} is not an image (expected ${ws.IMAGE_EXTENSIONS.join(', ')})`);
  }
  if (/_MASTER(_|$)/.test(stem)) {
    throw pipelineError('candidate_invalid', `${stem} already carries _MASTER: it is a master, not a candidate`);
  }
  if (!ws.ID.asset.test(stem)) {
    throw pipelineError('candidate_invalid',
      `${stem} is not a candidate name; expected <ENTITY_ID>_<TAG>_V## (a look page: <LOOK_ID>_V##)`);
  }
  const base = stem.replace(VERSION, '');
  const version = VERSION.exec(stem)[1];

  let entity = null;
  const inEntityDir = /^(characters|locations|props)\/([^/]+)\/refs$/.exec(dir);
  if (inEntityDir) entity = inEntityDir[2];
  else if (dir === 'references/style') entity = lookEntityOf(root, assets, base);
  if (!entity) {
    throw pipelineError('candidate_invalid',
      `${rel} is not in a reference directory; a candidate lives in characters|locations|props/<ID>/refs/ or references/style/`);
  }
  const type = assetPaths.entityType(entity);
  if (!type || assetPaths.refsDir(entity) !== dir) {
    throw pipelineError('candidate_invalid', `${rel} is not in the refs directory of an entity (${entity})`);
  }
  if (base !== entity && !base.startsWith(`${entity}_`)) {
    throw pipelineError('candidate_invalid', `${stem} does not belong to ${entity}: a candidate's name starts with its entity ID`);
  }

  const rest = base === entity ? '' : base.slice(entity.length + 1);
  const tag = rest.split('_')[0];
  const kind = rest === '' ? (type === 'LOOK' ? 'look' : null)
    : Object.keys(assetPaths.SHEET_TAGS).find((k) => assetPaths.SHEET_TAGS[k] === tag && k !== 'look') || null;
  if (!kind || !assetPaths.SHEET_KINDS[type].includes(kind)) {
    throw pipelineError('candidate_invalid',
      `${stem} names no sheet of a ${type} entity; expected a tag for ${assetPaths.SHEET_KINDS[type].join(', ')}`);
  }
  return { rel, stem, ext, dir, entity, type, kind, base, version, variant: rest.split('_').slice(1).join('_') };
}

/** The generation record that produced a candidate file, or null. */
function generationRecordOf(root, entity, candidateRel) {
  const dir = path.join(root, 'generations', entity);
  if (!fs.existsSync(dir)) return null;
  let planned = null;
  for (const name of fs.readdirSync(dir).filter((n) => /^GEN_.*\.ya?ml$/i.test(n)).sort()) {
    let record;
    try {
      record = ws.loadYaml(path.join(dir, name));
    } catch (err) {
      continue;
    }
    if (!record || !record.id) continue;
    const media = Array.isArray(record.media_files) ? record.media_files.map((m) => String(m).replace(/\\/g, '/')) : [];
    if (media.includes(candidateRel)) return String(record.id);
    // A handoff record names its target in the request file, not in media_files.
    const requestFile = path.join(dir, name.replace(/\.ya?ml$/i, '.request.json'));
    if (!planned && fs.existsSync(requestFile)) {
      try {
        const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
        if (request && request.meta && String(request.meta.output_path || '').replace(/\\/g, '/') === candidateRel) {
          planned = String(record.id);
        }
      } catch (err) { /* unreadable request file: no provenance from it */ }
    }
  }
  return planned;
}

/** Append one entry to the `assets:` list of the registry text. */
function appendAssetLines(lines, entry) {
  const range = edit.findKey(lines, 'assets', 0);
  if (!range) return false;
  const inline = lines[range.line].replace(/^assets:/, '').replace(/#.*$/, '').trim();
  let itemIndent = 2;
  for (let i = range.line + 1; i < range.end; i++) {
    if (/^\s*-(\s|$)/.test(lines[i])) {
      itemIndent = edit.indentOf(lines[i]);
      break;
    }
  }
  const pad = ' '.repeat(itemIndent);
  const block = yaml.stringify([entry]).replace(/\n$/, '').split('\n').map((line) => pad + line);
  if (inline === '[]') {
    lines.splice(range.line, 1, lines[range.line].replace(/^assets:\s*\[\]/, 'assets:'), ...block);
    return true;
  }
  if (inline !== '') return false;
  lines.splice(range.end, 0, ...block);
  return true;
}

/** Mark a registry entry superseded in the text. */
function supersedeAssetLines(lines, oldId, newId) {
  const assets = edit.findKey(lines, 'assets', 0);
  if (!assets) return false;
  const item = edit.findItem(lines, 'id', oldId, assets.line + 1, assets.end);
  if (!item) return false;
  const status = edit.findKey(lines, 'status', item.fieldIndent, item.line + 1, item.end);
  if (!status || !edit.setValue(lines, status, 'superseded')) return false;
  const existing = edit.findKey(lines, 'superseded_by', item.fieldIndent, item.line + 1, item.end);
  if (existing) return edit.setValue(lines, existing, newId);
  lines.splice(status.line + 1, 0, `${' '.repeat(item.fieldIndent)}superseded_by: ${newId}`);
  return true;
}

/** A list with every superseded ID swapped for the new master. */
function swapIds(list, masterId, replaced) {
  const out = [];
  for (const id of Array.isArray(list) ? list : []) {
    const next = replaced.includes(id) ? masterId : id;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

/** The same swap, and the new master appended when the list does not have it yet. */
function withMaster(list, masterId, replaced) {
  const out = swapIds(list, masterId, replaced);
  if (!out.includes(masterId)) out.push(masterId);
  return out;
}

function replaceTokens(lines, replaced, masterId) {
  for (let i = 0; i < lines.length; i++) {
    for (const oldId of replaced) {
      lines[i] = lines[i].replace(new RegExp(`(?<![A-Za-z0-9_])${oldId}(?![A-Za-z0-9_])`, 'g'), masterId);
    }
  }
}

/** Workspace files that still cite a superseded asset ID (they are stale and need recompiling). */
function findStale(root, replaced) {
  if (!replaced.length) return [];
  const stale = [];
  const visit = (file) => {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      return;
    }
    if (replaced.some((id) => text.includes(id))) stale.push(ws.rel(root, file));
  };
  for (const issueId of ws.listIssues(root)) {
    for (const pageId of ws.listPageIds(root, issueId)) {
      const dir = ws.pageDir(root, pageId);
      visit(path.join(dir, 'page.yaml'));
      visit(path.join(dir, 'reference-plan.yaml'));
    }
    visit(path.join(ws.issueDir(root, issueId), 'cover', 'cover.yaml'));
  }
  return stale;
}

/**
 * Promote an approved candidate to a master and register it.
 *
 * @param {object} options
 * @param {string} options.root Workspace root.
 * @param {string} options.candidate Workspace-relative (or absolute) path of
 *   the candidate image, or its asset stem (`CHAR_MARTA_TURN_V02`).
 * @param {string} [options.note] Stored as the entry's notes.
 * @param {boolean} [options.supersede] Replace the approved master of the same sheet.
 * @param {string} [options.by] Who approved. Default "human".
 * @param {Date} [options.now] Clock, for tests.
 * @returns {{asset_id: string, file: string, entity: string, role: string,
 *   superseded: string|null, kind: string, candidate: string, sha256: string,
 *   generation_record: string|null, approved_by: string, approved_at: string,
 *   updated: string[], stale: string[], style_block: string|null, warnings: string[]}}
 *   `file` is the master's workspace-relative path. `superseded` is the ID of
 *   the master this one replaces, or null. `updated` lists every file
 *   written, `stale` the pages and plans that still cite a superseded ID.
 * @throws an Error with `code` on any refusal; nothing is written before the last check.
 */
function approveAsset(options = {}) {
  if (!options.root) throw pipelineError('bad_arguments', 'root is required: the workspace directory that holds project.yaml');
  const root = path.resolve(String(options.root));
  if (!fs.existsSync(path.join(root, 'project.yaml'))) {
    throw pipelineError('workspace_missing', `${toPosix(root)} has no project.yaml: not a workspace root`);
  }
  const manifestFile = ws.abs(root, 'references/manifest.yaml');
  const assets = ws.loadReferenceAssets(root);
  const cand = describeCandidate(root, options.candidate, assets);
  const masterId = `${cand.base}_MASTER_V${cand.version}`;
  const masterRel = `${cand.dir}/${masterId}${cand.ext}`;
  const masterFile = ws.abs(root, masterRel);
  const warnings = [];

  if (assets.has(masterId)) {
    throw pipelineError('already_master',
      `${masterId} is already registered (status ${assets.get(masterId).status}). ${cand.stem} was promoted before; generate a new candidate to change the sheet.`);
  }
  for (const ext of ws.IMAGE_EXTENSIONS) {
    if (fs.existsSync(ws.abs(root, `${cand.dir}/${masterId}${ext}`))) {
      throw pipelineError('master_file_exists',
        `${cand.dir}/${masterId}${ext} exists on disk but is not registered. A master file is never overwritten: register or remove it by hand first.`);
    }
  }
  const pattern = new RegExp(`^${cand.base}_MASTER_V\\d{2}$`);
  const current = [...assets.values()]
    .filter((a) => pattern.test(String(a.id)) && a.status === 'approved')
    .map((a) => String(a.id))
    .sort();
  if (current.length && options.supersede !== true) {
    throw pipelineError('master_exists',
      `${current.join(', ')} is the approved master of this sheet. Approve ${cand.stem} with supersede (--supersede) to replace it: ` +
      'the old file stays on disk and its registry entry becomes superseded.');
  }

  const entityRel = ENTITY_FILES[cand.type] ? ENTITY_FILES[cand.type](cand.entity) : null;
  if (entityRel && !fs.existsSync(ws.abs(root, entityRel))) {
    throw pipelineError('entity_missing', `${entityRel} not found: ${cand.entity} needs its bible file before a master is approved`);
  }
  const project = ws.loadProject(root) || {};
  let styleBlockRel = null;
  if (cand.kind === 'look') {
    styleBlockRel = (project.style && project.style.style_block) || 'style/style-block.txt';
    const block = ws.loadStyleBlock(root, project);
    if (!block) {
      throw pipelineError('style_block_missing',
        `${styleBlockRel} is missing or empty. Approving a look master freezes the style block with it; write the block with /style-bible first.`);
    }
    if (/^#/m.test(block) || /<[^<>\n]+>/.test(block)) {
      warnings.push(`${styleBlockRel} still has template lines (# comments or <placeholders>); it is frozen as it stands`);
    }
  }

  const by = options.by ? String(options.by) : 'human';
  const approvedAt = dateStamp(options.now);
  const role = roleOfAsset({ id: masterId, entity: cand.entity, kind: cand.kind });
  const generationRecord = generationRecordOf(root, cand.entity, cand.rel);
  if (!generationRecord) warnings.push(`${cand.rel} has no generation record: the entry records it as unknown provenance`);

  // Everything is checked. From here on, write.
  fs.mkdirSync(path.dirname(masterFile), { recursive: true });
  fs.copyFileSync(ws.abs(root, cand.rel), masterFile, fs.constants.COPYFILE_EXCL);
  const sha256 = sha256Of(masterFile);
  const updated = [masterRel];

  const entry = {
    id: masterId,
    entity: cand.entity,
    kind: cand.kind,
    path: masterRel,
    status: 'approved',
    default_role: role,
    sha256,
    approved_by: by,
    approved_at: approvedAt,
    promoted_from: cand.stem,
    generation_record: generationRecord,
    notes: options.note ? String(options.note) : '',
  };
  if (!fs.existsSync(manifestFile)) {
    fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
    fs.writeFileSync(manifestFile, 'assets: []\n');
  }
  edit.rewriteYamlFile(manifestFile, (doc) => {
    if (!Array.isArray(doc.assets)) doc.assets = [];
    for (const asset of doc.assets) {
      if (asset && current.includes(asset.id)) {
        asset.status = 'superseded';
        asset.superseded_by = masterId;
      }
    }
    doc.assets.push(entry);
  }, (lines) => {
    for (const oldId of current) {
      if (!supersedeAssetLines(lines, oldId, masterId)) return false;
    }
    return appendAssetLines(lines, entry);
  });
  updated.push('references/manifest.yaml');

  if (entityRel) {
    const result = edit.rewriteYamlFile(ws.abs(root, entityRel), (doc) => {
      doc.references = withMaster(doc.references, masterId, current);
    }, (lines, doc) => {
      replaceTokens(lines, current, masterId);
      const range = edit.findKey(lines, 'references', 0);
      return range ? edit.setValue(lines, range, doc.references) : false;
    });
    if (result.changed) updated.push(entityRel);
  }

  if (cand.type === 'CHAR') {
    const wardrobeRel = `characters/${cand.entity}/wardrobe.yaml`;
    if (fs.existsSync(ws.abs(root, wardrobeRel))) {
      const outfitOf = (outfit) => {
        const variant = assetPaths.sheetVariant(cand.entity, 'wardrobe', { outfit: outfit.id });
        return cand.kind === 'wardrobe' && variant && variant.token === cand.variant;
      };
      const result = edit.rewriteYamlFile(ws.abs(root, wardrobeRel), (doc) => {
        for (const outfit of Array.isArray(doc.outfits) ? doc.outfits : []) {
          if (!outfit || typeof outfit !== 'object') continue;
          const cites = Array.isArray(outfit.references) && outfit.references.some((id) => current.includes(id));
          // The outfit a wardrobe sheet draws gets the master; any other
          // outfit only follows a master it already cited.
          if (outfitOf(outfit)) outfit.references = withMaster(outfit.references, masterId, current);
          else if (cites) outfit.references = swapIds(outfit.references, masterId, current);
        }
      }, (lines, doc) => {
        replaceTokens(lines, current, masterId);
        const outfits = edit.findKey(lines, 'outfits', 0);
        if (!outfits) return false;
        for (const outfit of Array.isArray(doc.outfits) ? doc.outfits : []) {
          if (!outfit || !outfitOf(outfit)) continue;
          const item = edit.findItem(lines, 'id', outfit.id, outfits.line + 1, edit.findKey(lines, 'outfits', 0).end);
          if (!item) return false;
          const range = edit.findKey(lines, 'references', item.fieldIndent, item.line + 1, item.end);
          if (range) {
            if (!edit.setValue(lines, range, outfit.references)) return false;
          } else {
            lines.splice(item.end, 0, `${' '.repeat(item.fieldIndent)}references: [${outfit.references.join(', ')}]`);
          }
        }
        return true;
      });
      if (result.changed) updated.push(wardrobeRel);
    }
  }

  if (cand.kind === 'look') {
    const result = edit.rewriteYamlFile(path.join(root, 'project.yaml'), (doc) => {
      if (!doc.style || typeof doc.style !== 'object') doc.style = {};
      doc.style.look_refs = withMaster(doc.style.look_refs, masterId, current);
      if (!doc.style.style_block) doc.style.style_block = styleBlockRel;
    }, (lines, doc) => {
      replaceTokens(lines, current, masterId);
      const style = edit.findKey(lines, 'style', 0);
      if (!style) return false;
      const indent = edit.childIndent(lines, style);
      const refs = indent === null ? null : edit.findKey(lines, 'look_refs', indent, style.line + 1, style.end);
      if (!refs || !edit.setValue(lines, refs, doc.style.look_refs)) return false;
      return true;
    });
    if (result.changed) updated.push('project.yaml');
  }

  return {
    asset_id: masterId,
    file: masterRel,
    entity: cand.entity,
    role,
    superseded: current.length ? current[current.length - 1] : null,
    kind: cand.kind,
    candidate: cand.rel,
    sha256,
    generation_record: generationRecord,
    approved_by: by,
    approved_at: approvedAt,
    updated,
    stale: findStale(root, current),
    style_block: styleBlockRel,
    warnings,
  };
}

function main() {
  helpIfRequested(process.argv.slice(2), HELP);
  const { flags } = parseArgs();
  const asJson = flags.json === true;
  try {
    if (!flags.candidate || flags.candidate === true) {
      throw pipelineError('bad_arguments', '--candidate <path-or-stem> is required (see --help)');
    }
    const candidate = String(flags.candidate);
    let start = flags.root && flags.root !== true ? path.resolve(String(flags.root)) : null;
    if (!start && path.isAbsolute(candidate) && fs.existsSync(candidate)) start = candidate;
    const root = ws.findWorkspaceRoot(start || process.cwd());
    if (!root) {
      throw pipelineError('workspace_missing',
        `no project.yaml at or above ${toPosix(start || process.cwd())}: pass --root <workspace> or run from inside the workspace`);
    }
    const result = approveAsset({
      root,
      candidate,
      note: flags.note && flags.note !== true ? String(flags.note) : undefined,
      supersede: flags.supersede === true,
      by: flags.by && flags.by !== true ? String(flags.by) : undefined,
    });
    if (asJson) {
      console.log(JSON.stringify(Object.assign({ ok: true }, result), null, 2));
      return;
    }
    console.log(`approved: ${result.asset_id} (${result.kind}, role ${result.role}) for ${result.entity}`);
    console.log(`  master:    ${result.file}`);
    console.log(`  candidate: ${result.candidate} (kept)`);
    console.log(`  record:    ${result.generation_record || 'none found'}`);
    if (result.superseded) console.log(`  supersedes: ${result.superseded} (file kept, entry marked superseded)`);
    if (result.style_block) console.log(`  style block frozen: ${result.style_block}`);
    for (const file of result.updated) console.log(`  wrote: ${file}`);
    for (const file of result.stale) console.log(`  stale, cites the superseded master: ${file}`);
    for (const w of result.warnings) console.log(`  warning: ${w}`);
    console.log('The approval is recorded. Nothing here checked the drawing.');
  } catch (err) {
    if (asJson) console.log(JSON.stringify({ ok: false, code: err.code || 'error', error: err.message }, null, 2));
    else console.error(`error: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { approveAsset, describeCandidate, generationRecordOf };

if (require.main === module) main();
