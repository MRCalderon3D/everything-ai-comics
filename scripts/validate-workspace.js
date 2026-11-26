#!/usr/bin/env node
'use strict';
/**
 * validate-workspace.js — the mechanical gate for a production workspace.
 *
 * Checks, in order:
 *   a. Schemas: every schema-known file validates (path -> schema mapping in
 *      scripts/lib/artifacts.js). A missing schema file is a warning.
 *   b. Cross-references: IDs match paths, issue/scene/page lists agree, page
 *      and panel counts match the files, referenced assets are registered,
 *      current renders exist on disk. Bibles: an entity's references belong
 *      to it, default wardrobes and adjacent characters exist, story-bible
 *      facts point at real things, blocking open questions are resolved
 *      before generation, the reference manifest matches the disk, and the
 *      series plan matches the issue directories.
 *   c. Review rules (docs/data-model.md, "Review rules").
 *   d. Edition rules ("Edition rules"), except building exports.
 *   e. Generation records: metadata_unavailable agrees with the fields.
 *   f. Lettering: lettering.yaml text equals the page.yaml text.
 *   g. Panel ledger: the findings of check-continuity.js.
 *
 * Returns { errors, warnings } of { file, code, message }. A malformed
 * workspace is reported, never thrown.
 *
 * What this cannot do: look at an image. A clean result means the structured
 * data is coherent. Identity, anatomy, geography, and continuity of the drawn
 * pages are certified only by a visual review.
 */

const fs = require('fs');
const path = require('path');
const ws = require('./lib/workspace');
const artifacts = require('./lib/artifacts');
const schemaLib = require('./lib/schema');
const { walk } = require('./lib/fsx');
const { parseArgs, helpIfRequested, fatal } = require('./lib/cli');
const { PASS, FAIL } = require('./lib/report');
const { checkContinuity } = require('./check-continuity');

const HELP = `
validate-workspace.js — schema, cross-reference, review, and edition gates.

Usage:
  node scripts/validate-workspace.js [--root <workspace>] [--issue ISS_001] [--json]

Options:
  --root <dir>     Workspace root (the directory holding project.yaml).
                   Default: the nearest workspace above the current directory.
  --issue <id>     Limit issue-scoped checks to one issue. Bibles, references,
                   and project.yaml are always checked.
  --json           Print { errors, warnings } as JSON.
  --help           Show this help.

Exit code 1 when any error is found, 0 otherwise.
This is mechanical validation. It does not certify the drawn pages.
`;

const MAX_SCHEMA_ERRORS_PER_FILE = 8;
const DEFAULT_MAX_REPAIR_CYCLES = 2;
const COMPLETED_GENERATION = ['succeeded', 'approved', 'rejected'];

// --- small helpers -----------------------------------------------------------

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (err) {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (err) {
    return false;
  }
}

function listNames(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch (err) {
    return [];
  }
}

function show(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.join(', ')}]`;
  return String(v);
}

function hasText(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/** "ED_001_02" -> "ISS_001". */
function issueOfEdition(editionId) {
  const m = /^ED_(\d{3})_\d{2}$/.exec(String(editionId));
  return m ? `ISS_${m[1]}` : null;
}

// --- context -----------------------------------------------------------------

function createContext(root, opts, errors, warnings) {
  const docs = new Map(); // rel -> { doc, error, missing }
  const reportedParse = new Set();
  const ctx = {
    root,
    errors,
    parseFailed: (rel) => reportedParse.has(rel),
    issueFilter: opts.issue ? String(opts.issue) : null,
    schemasDir: opts.schemasDir || artifacts.SCHEMAS_DIR,
    err: (file, code, message) => errors.push({ file, code, message }),
    warn: (file, code, message) => warnings.push({ file, code, message }),
    abs: (rel) => ws.abs(root, rel),
    exists: (rel) => isFile(ws.abs(root, rel)),
    /** Parsed YAML of a workspace file, or null. A parse error is reported once. */
    load(rel) {
      if (!docs.has(rel)) docs.set(rel, artifacts.readYaml(ws.abs(root, rel)));
      const res = docs.get(rel);
      if (res.error && !reportedParse.has(rel)) {
        reportedParse.add(rel);
        ctx.err(rel, 'YAML_PARSE', `Not parseable YAML: ${res.error}`);
      }
      return res.doc;
    },
    /** Like load(), but only objects come back. */
    loadMap(rel) {
      const doc = ctx.load(rel);
      return isObj(doc) ? doc : null;
    },
  };

  let issues = [];
  try {
    issues = ws.listIssues(root);
  } catch (err) {
    issues = [];
  }
  ctx.allIssues = issues;
  ctx.issues = ctx.issueFilter ? issues.filter((id) => id === ctx.issueFilter) : issues;

  /** Pages of an issue in reading order: [{ id, rel, dir, doc }]. Cached. */
  const pageCache = new Map();
  ctx.pages = (issueId) => {
    if (pageCache.has(issueId)) return pageCache.get(issueId);
    let ids = [];
    try {
      ids = ws.listPageIds(root, issueId);
    } catch (err) {
      ids = [];
    }
    const pages = ids.map((id) => {
      const dir = `issues/${issueId}/pages/${id}`;
      const rel = `${dir}/page.yaml`;
      return { id, dir, rel, doc: ctx.loadMap(rel) };
    }).sort((a, b) => {
      const na = a.doc && typeof a.doc.number === 'number' ? a.doc.number : Infinity;
      const nb = b.doc && typeof b.doc.number === 'number' ? b.doc.number : Infinity;
      if (na !== nb) return na - nb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    pageCache.set(issueId, pages);
    return pages;
  };

  /** Is a workspace-relative file inside the --issue scope? */
  ctx.inScope = (rel) => {
    if (!ctx.issueFilter) return true;
    let m = /^issues\/([^/]+)\//.exec(rel);
    if (m) return m[1] === ctx.issueFilter;
    m = /^continuity\/([^/.]+)\.final-state\.ya?ml$/.exec(rel);
    if (m) return m[1] === ctx.issueFilter;
    m = /^editions\/([^/]+)\//.exec(rel);
    if (m) return issueOfEdition(m[1]) === ctx.issueFilter;
    m = /^generations\/([^/]+)\//.exec(rel);
    if (m && ws.ID.page.test(m[1])) return ws.issueOfPage(m[1]) === ctx.issueFilter;
    return true;
  };

  /** Render file on disk for a render ID, or null. Never throws. */
  ctx.renderOnDisk = (renderId) => {
    try {
      return ws.renderFile(root, renderId);
    } catch (err) {
      return null;
    }
  };

  /** Review doc of a render, or null. */
  ctx.review = (renderId) => {
    const pageId = ws.pageOfRender(renderId);
    if (!pageId) return null;
    return ctx.loadMap(`issues/${ws.issueOfPage(pageId)}/pages/${pageId}/reviews/${renderId}.review.yaml`);
  };

  let assets = null;
  ctx.assets = () => {
    if (assets) return assets;
    assets = new Map();
    const doc = ctx.loadMap('references/manifest.yaml');
    for (const asset of arr(doc && doc.assets)) {
      if (isObj(asset) && asset.id) assets.set(asset.id, asset);
    }
    return assets;
  };
  return ctx;
}

// --- a. schemas --------------------------------------------------------------

function checkSchemas(ctx) {
  const schemas = new Map(); // name -> schema | null
  const unchecked = new Map(); // name -> file count
  const files = walk(ctx.root, { filter: (f) => /\.ya?ml$/i.test(f) });
  for (const file of files) {
    const rel = ws.rel(ctx.root, file);
    const name = artifacts.schemaNameFor(rel);
    if (!name || !ctx.inScope(rel)) continue;
    if (!schemas.has(name)) schemas.set(name, artifacts.loadSchema(name, ctx.schemasDir));
    const doc = ctx.load(rel); // reports YAML_PARSE even when the schema is absent
    const schema = schemas.get(name);
    if (!schema) {
      unchecked.set(name, (unchecked.get(name) || 0) + 1);
      continue;
    }
    if (doc === null) {
      // A parse error is already reported; an empty document is a schema failure.
      if (!ctx.parseFailed(rel)) {
        ctx.err(rel, 'SCHEMA', `Empty document; expected a ${name} document (schemas/${name}.schema.json).`);
      }
      continue;
    }
    let result;
    try {
      result = schemaLib.validate(schema, doc);
    } catch (err) {
      ctx.err(rel, 'SCHEMA', `schemas/${name}.schema.json could not be applied: ${err.message}`);
      continue;
    }
    if (result.valid) continue;
    for (const e of result.errors.slice(0, MAX_SCHEMA_ERRORS_PER_FILE)) {
      ctx.err(rel, 'SCHEMA', `${e.path}: ${e.message} (schemas/${name}.schema.json)`);
    }
    if (result.errors.length > MAX_SCHEMA_ERRORS_PER_FILE) {
      ctx.err(rel, 'SCHEMA',
        `... and ${result.errors.length - MAX_SCHEMA_ERRORS_PER_FILE} more violation(s) of schemas/${name}.schema.json`);
    }
  }
  for (const [name, count] of unchecked) {
    ctx.warn(`schemas/${name}.schema.json`, 'SCHEMA_MISSING',
      `Schema file not found; ${count} ${name} file(s) were not schema-checked.`);
  }
}

// --- b. cross-references -----------------------------------------------------

function expectId(ctx, rel, field, actual, expected) {
  if (actual === expected) return;
  ctx.err(rel, 'ID_PATH_MISMATCH',
    `${field} is ${show(actual)}; expected ${expected} to match the file's path.`);
}

/** An asset ID must be registered; a render ID must exist on disk. */
function checkAssetId(ctx, rel, where, id) {
  if (typeof id !== 'string' || !id) return;
  if (ws.ID.render.test(id)) {
    if (!ctx.renderOnDisk(id)) {
      ctx.err(rel, 'MISSING_RENDER',
        `${where} names render ${id}; expected an image under ${ws.pageOfRender(id)}/renders/ and none is on disk.`);
    }
    return;
  }
  if (!ctx.assets().has(id)) {
    ctx.err(rel, 'UNKNOWN_ASSET',
      `${where} names asset ${id}; expected an entry in references/manifest.yaml and there is none.`);
  }
}

function sceneFiles(ctx, issueId) {
  const dir = `issues/${issueId}/scenes`;
  return listNames(ctx.abs(dir))
    .filter((n) => /\.ya?ml$/i.test(n))
    .map((n) => ({ id: n.replace(/\.ya?ml$/i, ''), rel: `${dir}/${n}` }));
}

function checkEntities(ctx) {
  const kinds = [
    { dir: 'characters', file: 'character.yaml', field: 'id' },
    { dir: 'characters', file: 'wardrobe.yaml', field: 'character' },
    { dir: 'locations', file: 'location.yaml', field: 'id' },
    { dir: 'locations', file: 'map.yaml', field: 'location' },
    { dir: 'props', file: 'prop.yaml', field: 'id' },
  ];
  for (const kind of kinds) {
    for (const id of listNames(ctx.abs(kind.dir))) {
      const rel = `${kind.dir}/${id}/${kind.file}`;
      if (!ctx.exists(rel)) continue;
      const doc = ctx.loadMap(rel);
      if (doc) expectId(ctx, rel, kind.field, doc[kind.field], id);
    }
  }
}

const ENTITY_FILES = {
  CHAR: ['characters', 'character.yaml'],
  LOC: ['locations', 'location.yaml'],
  PROP: ['props', 'prop.yaml'],
};

/** Does a CHAR_/LOC_/PROP_ entity have its bible file? */
function entityExists(ctx, id) {
  const m = /^(CHAR|LOC|PROP)_/.exec(String(id));
  return !!m && ctx.exists(`${ENTITY_FILES[m[1]][0]}/${id}/${ENTITY_FILES[m[1]][1]}`);
}

/** Directory names under characters/, locations/ or props/. */
function entityDirs(ctx, dir) {
  return listNames(ctx.abs(dir)).filter((id) => isDir(ctx.abs(`${dir}/${id}`)));
}

/** Outfit IDs of one character's wardrobe.yaml, or null when the file is absent or unreadable. */
function outfitIds(ctx, charId) {
  const rel = `characters/${charId}/wardrobe.yaml`;
  const doc = ctx.exists(rel) ? ctx.loadMap(rel) : null;
  if (!doc) return null;
  return arr(doc.outfits).filter(isObj).map((o) => o.id).filter(hasText);
}

/** A bible's references[]: every asset is registered, and registered for that entity. */
function checkEntityAssets(ctx, rel, where, ids, entityId) {
  for (const id of arr(ids)) {
    if (!hasText(id)) continue;
    const asset = ctx.assets().get(id);
    if (!asset) {
      ctx.err(rel, 'UNKNOWN_ASSET',
        `${where} lists asset ${id}; expected an entry in references/manifest.yaml and there is none.`);
    } else if (asset.entity !== entityId) {
      ctx.err(rel, 'ASSET_ENTITY_MISMATCH',
        `${where} lists ${id}, which references/manifest.yaml registers for ${show(asset.entity)}; expected an asset of ${entityId}.`);
    }
  }
}

/** Character, wardrobe, location, and prop bibles: what they point at exists. */
function checkEntityReferences(ctx) {
  for (const charId of entityDirs(ctx, 'characters')) {
    const rel = `characters/${charId}/character.yaml`;
    const doc = ctx.exists(rel) ? ctx.loadMap(rel) : null;
    const outfits = outfitIds(ctx, charId);
    const wardrobeRel = `characters/${charId}/wardrobe.yaml`;
    const wardrobe = outfits ? ctx.loadMap(wardrobeRel) : null;
    for (const outfit of arr(wardrobe && wardrobe.outfits).filter(isObj)) {
      checkEntityAssets(ctx, wardrobeRel, `outfit ${show(outfit.id)} references`, outfit.references, charId);
    }
    if (!doc) continue;
    checkEntityAssets(ctx, rel, 'references', doc.references, charId);
    if (hasText(doc.default_wardrobe) && !(outfits && outfits.includes(doc.default_wardrobe))) {
      ctx.err(rel, 'UNKNOWN_WARDROBE',
        `default_wardrobe is ${doc.default_wardrobe}; expected an outfit of ${wardrobeRel} ` +
        `(${outfits ? show(outfits) : 'the file is missing'}).`);
    }
    for (const other of arr(doc.visually_adjacent_to)) {
      if (!hasText(other)) continue;
      if (other === charId) {
        ctx.err(rel, 'ADJACENT_CHARACTER_SELF',
          `visually_adjacent_to lists ${charId} itself; expected only other characters this one could be confused with.`);
      } else if (!ctx.exists(`characters/${other}/character.yaml`)) {
        ctx.err(rel, 'ADJACENT_CHARACTER_UNKNOWN',
          `visually_adjacent_to lists ${other}; expected characters/${other}/character.yaml and it does not exist.`);
      }
    }
    const first = doc.first_appearance;
    if (hasText(first) && ws.ID.page.test(first)) {
      const issueId = ws.issueOfPage(first);
      if (ctx.allIssues.includes(issueId) && !ctx.exists(`issues/${issueId}/pages/${first}/page.yaml`)) {
        ctx.err(rel, 'FIRST_APPEARANCE_UNKNOWN',
          `first_appearance is ${first}; expected issues/${issueId}/pages/${first}/page.yaml and ${issueId} has no such page.`);
      }
    }
  }
  for (const [dir, file] of [['locations', 'location.yaml'], ['props', 'prop.yaml']]) {
    for (const id of entityDirs(ctx, dir)) {
      const rel = `${dir}/${id}/${file}`;
      const doc = ctx.exists(rel) ? ctx.loadMap(rel) : null;
      if (doc) checkEntityAssets(ctx, rel, 'references', doc.references, id);
    }
  }
}

/** references/manifest.yaml: files on disk, unique IDs, entity prefixes, master status. */
function checkManifest(ctx) {
  const rel = 'references/manifest.yaml';
  if (!ctx.exists(rel)) return;
  const doc = ctx.loadMap(rel);
  const seen = new Map();
  for (const asset of arr(doc && doc.assets).filter(isObj)) {
    const id = asset.id;
    if (!hasText(id)) continue;
    seen.set(id, (seen.get(id) || 0) + 1);
    if (seen.get(id) === 2) {
      ctx.err(rel, 'ASSET_DUPLICATE_ID', `Asset ${id} is registered more than once; expected one entry per asset ID.`);
    }
    if (seen.get(id) > 1) continue;
    if (hasText(asset.entity) && !id.startsWith(`${asset.entity}_`)) {
      ctx.err(rel, 'ASSET_ENTITY_ID_MISMATCH',
        `Asset ${id} has entity ${asset.entity}; expected the entity the ID starts with (an ID of ${asset.entity} begins ${asset.entity}_).`);
    }
    const file = hasText(asset.path) ? asset.path.replace(/\\/g, '/') : null;
    if (!file || !ctx.exists(file)) {
      const message = `Asset ${id} (${show(asset.status)}) has path ${show(asset.path)}; expected that file on disk and it is not there.`;
      if (asset.status === 'approved') ctx.err(rel, 'ASSET_FILE_MISSING', message);
      else ctx.warn(rel, 'ASSET_FILE_MISSING', message);
    }
    if (/_MASTER(_|$)/.test(id) && asset.status !== 'approved' && asset.status !== 'superseded') {
      ctx.err(rel, 'MASTER_NOT_APPROVED',
        `Asset ${id} carries _MASTER with status ${show(asset.status)}; expected approved or superseded, ` +
        'because only an approved asset is a master. Drop _MASTER from the ID until it is approved.');
    }
  }
}

/** Issue IDs of story/series-plan.yaml as a Map id -> entry, or null when there is no plan. */
function plannedIssues(ctx) {
  const rel = 'story/series-plan.yaml';
  const doc = ctx.exists(rel) ? ctx.loadMap(rel) : null;
  if (!doc) return null;
  return new Map(arr(doc.issues).filter(isObj).filter((i) => hasText(i.id)).map((i) => [i.id, i]));
}

/** story/story-bible.yaml: facts point at things that exist; blocking questions are resolved before generation. */
function checkStoryBible(ctx) {
  const rel = 'story/story-bible.yaml';
  const doc = ctx.exists(rel) ? ctx.loadMap(rel) : null;
  if (!doc) return;

  const facts = arr(doc.facts).filter(isObj);
  const factIds = new Set(facts.map((f) => f.id).filter(hasText));
  const planned = plannedIssues(ctx);
  let wardrobes = null;
  const affectsExists = (id) => {
    if (/^(CHAR|LOC|PROP)_/.test(id)) return entityExists(ctx, id);
    if (/^LOOK_/.test(id)) return [...ctx.assets().values()].some((a) => a.entity === id);
    if (/^ISS_/.test(id)) return ctx.allIssues.includes(id) || !!(planned && planned.has(id));
    if (/^WARD_/.test(id)) {
      if (!wardrobes) {
        wardrobes = new Set();
        for (const charId of entityDirs(ctx, 'characters')) {
          for (const outfit of outfitIds(ctx, charId) || []) wardrobes.add(outfit);
        }
      }
      return wardrobes.has(id);
    }
    return false;
  };
  for (const fact of facts) {
    const label = fact.id || 'A fact';
    for (const id of arr(fact.affects)) {
      if (hasText(id) && !affectsExists(id)) {
        ctx.err(rel, 'FACT_AFFECTS_UNKNOWN',
          `${label} affects ${id}; expected an existing character, location, prop, look, wardrobe, or issue ID and the workspace has none by that name.`);
      }
    }
    if (fact.replaces === null || fact.replaces === undefined) continue;
    if (fact.replaces === fact.id) {
      ctx.err(rel, 'FACT_REPLACES_SELF', `${label} replaces itself; expected the ID of the earlier fact it supersedes, or null.`);
    } else if (!factIds.has(fact.replaces)) {
      ctx.err(rel, 'FACT_REPLACES_UNKNOWN',
        `${label} (${show(fact.provenance)}) replaces ${show(fact.replaces)}; expected a FACT id of this file and there is none.`);
    }
  }

  for (const entry of arr(doc.characters).filter(isObj)) {
    if (hasText(entry.id) && !ctx.exists(`characters/${entry.id}/character.yaml`)) {
      ctx.warn(rel, 'BIBLE_CHARACTER_MISSING',
        `characters lists ${entry.id}; expected characters/${entry.id}/character.yaml, which is not written yet.`);
    }
  }

  const open = arr(doc.open_questions).filter(isObj)
    .filter((q) => q.blocking === true && !hasText(q.resolution));
  if (!open.length) return;
  let rendered = null;
  for (const issueId of ctx.allIssues) {
    rendered = ctx.pages(issueId).find((p) => p.doc && hasText(p.doc.current_render)) || null;
    if (rendered) break;
  }
  for (const q of open) {
    const question = JSON.stringify(String(q.question || '').slice(0, 80));
    if (rendered) {
      ctx.err(rel, 'BLOCKING_QUESTION_OPEN',
        `Blocking question ${question} has no resolution and ${rendered.id} already has a render ` +
        `(${rendered.doc.current_render}); expected every blocking question resolved before generation.`);
    } else {
      ctx.warn(rel, 'BLOCKING_QUESTION_OPEN',
        `Blocking question ${question} has no resolution; expected one before any page is generated.`);
    }
  }
}

/** story/series-plan.yaml against the issue directories. Both differences are warnings. */
function checkSeriesPlan(ctx) {
  const rel = 'story/series-plan.yaml';
  const planned = plannedIssues(ctx);
  if (!planned) return;
  for (const issueId of ctx.issues) {
    const entry = planned.get(issueId);
    if (!entry) {
      ctx.warn(rel, 'ISSUE_NOT_IN_SERIES_PLAN',
        `issues/${issueId}/ exists; expected ${issueId} in the series plan, which lists ${show([...planned.keys()])}.`);
      continue;
    }
    const issueRel = `issues/${issueId}/issue.yaml`;
    const issue = ctx.exists(issueRel) ? ctx.loadMap(issueRel) : null;
    if (issue && typeof entry.page_budget === 'number' && typeof issue.page_count === 'number' &&
        entry.page_budget !== issue.page_count) {
      ctx.warn(rel, 'PAGE_BUDGET_MISMATCH',
        `${issueId} has page_budget ${entry.page_budget}; expected it to match page_count ${issue.page_count} in ${issueRel}.`);
    }
  }
}

function checkIssueReferences(ctx, issueId) {
  const issueRel = `issues/${issueId}/issue.yaml`;
  const issue = ctx.loadMap(issueRel);
  if (!ctx.exists(issueRel)) {
    ctx.err(issueRel, 'MISSING_FILE', `issues/${issueId}/ has no issue.yaml; expected one per issue directory.`);
  } else if (issue) {
    expectId(ctx, issueRel, 'id', issue.id, issueId);
  }

  // Scenes: file names, issue field, and the issue's list.
  const scenes = sceneFiles(ctx, issueId).map((s) => ({ ...s, doc: ctx.loadMap(s.rel) }));
  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  for (const scene of scenes) {
    if (!scene.doc) continue;
    expectId(ctx, scene.rel, 'id', scene.doc.id, scene.id);
    expectId(ctx, scene.rel, 'issue', scene.doc.issue, issueId);
    if (hasText(scene.doc.location) && !ctx.exists(`locations/${scene.doc.location}/location.yaml`)) {
      ctx.err(scene.rel, 'UNKNOWN_ENTITY',
        `location is ${scene.doc.location}; expected locations/${scene.doc.location}/location.yaml and it does not exist.`);
    }
    for (const charId of arr(scene.doc.cast)) {
      if (hasText(charId) && !ctx.exists(`characters/${charId}/character.yaml`)) {
        ctx.err(scene.rel, 'UNKNOWN_ENTITY',
          `cast lists ${charId}; expected characters/${charId}/character.yaml and it does not exist.`);
      }
    }
  }
  if (issue) {
    const listed = arr(issue.scenes);
    for (const id of listed) {
      if (!sceneById.has(id)) {
        ctx.err(issueRel, 'ISSUE_SCENES_MISMATCH',
          `scenes lists ${show(id)}; expected issues/${issueId}/scenes/${show(id)}.yaml and it does not exist.`);
      }
    }
    for (const scene of scenes) {
      if (!listed.includes(scene.id)) {
        ctx.err(issueRel, 'ISSUE_SCENES_MISMATCH',
          `scenes is ${show(listed)}; expected it to include ${scene.id}, which has a file at ${scene.rel}.`);
      }
    }
  }

  // Pages: IDs, counts, scene membership, renders, and referenced assets.
  const pages = ctx.pages(issueId);
  const pageById = new Map(pages.map((p) => [p.id, p]));
  let panelCount = 0;
  for (const page of pages) {
    if (ws.issueOfPage(page.id) !== issueId) {
      ctx.err(page.rel, 'ID_PATH_MISMATCH',
        `Page directory ${page.id} sits under ${issueId}; expected a page ID of that issue (PG_${issueId.slice(4)}_###).`);
    }
    if (!ctx.exists(page.rel)) {
      ctx.err(page.rel, 'MISSING_FILE', `${page.dir}/ has no page.yaml; expected one per page directory.`);
      continue;
    }
    const doc = page.doc;
    if (!doc) continue;
    expectId(ctx, page.rel, 'id', doc.id, page.id);
    expectId(ctx, page.rel, 'issue', doc.issue, issueId);
    const panels = arr(doc.panels).filter(isObj);
    panelCount += panels.length;
    const panelPrefix = `PN_${page.id.slice(3)}_`;
    for (const panel of panels) {
      if (typeof panel.id === 'string' && !panel.id.startsWith(panelPrefix)) {
        ctx.err(page.rel, 'ID_PATH_MISMATCH',
          `Panel id is ${panel.id}; expected the prefix ${panelPrefix} of page ${page.id}.`);
      }
    }

    // page.scene <-> scene.pages
    const scene = sceneById.get(doc.scene);
    if (!scene) {
      ctx.err(page.rel, 'SCENE_PAGES_MISMATCH',
        `scene is ${show(doc.scene)}; expected a scene of ${issueId} (${show(scenes.map((s) => s.id))}).`);
    } else if (scene.doc && !arr(scene.doc.pages).includes(page.id)) {
      ctx.err(page.rel, 'SCENE_PAGES_MISMATCH',
        `scene is ${doc.scene}; expected ${scene.rel} to list ${page.id} in pages, and it lists ${show(arr(scene.doc.pages))}.`);
    }

    // current_render exists and belongs to this page
    const current = doc.current_render;
    if (current !== null && current !== undefined) {
      if (ws.pageOfRender(current) !== page.id) {
        ctx.err(page.rel, 'ID_PATH_MISMATCH',
          `current_render is ${show(current)}; expected a render of this page (${page.id}_V##).`);
      } else if (!ctx.renderOnDisk(current)) {
        ctx.err(page.rel, 'MISSING_RENDER',
          `current_render is ${current}; expected ${page.dir}/renders/${current}.png (or jpg, webp) and no such file is on disk.`);
      }
    }

    // referenced assets
    const refs = isObj(doc.references) ? doc.references : {};
    for (const list of ['required', 'optional']) {
      for (const id of arr(refs[list])) checkAssetId(ctx, page.rel, `references.${list}`, id);
    }
    const planRel = `${page.dir}/reference-plan.yaml`;
    const plan = ctx.exists(planRel) ? ctx.loadMap(planRel) : null;
    if (plan) {
      expectId(ctx, planRel, 'page', plan.page, page.id);
      for (const list of ['required', 'optional']) {
        for (const entry of arr(plan[list]).filter(isObj)) {
          checkAssetId(ctx, planRel, `${list}[].asset_id`, entry.asset_id);
        }
      }
    }
    for (const name of listNames(ctx.abs(`${page.dir}/prompts`)).filter((n) => /\.ya?ml$/i.test(n))) {
      const pkgRel = `${page.dir}/prompts/${name}`;
      const pkg = ctx.loadMap(pkgRel);
      if (!pkg) continue;
      expectId(ctx, pkgRel, 'page', pkg.page, page.id);
      for (const entry of arr(pkg.references).filter(isObj)) {
        checkAssetId(ctx, pkgRel, 'references[].asset_id', entry.asset_id);
      }
    }
  }

  for (const scene of scenes) {
    if (!scene.doc) continue;
    for (const pageId of arr(scene.doc.pages)) {
      const page = pageById.get(pageId);
      if (!page) {
        ctx.err(scene.rel, 'SCENE_PAGES_MISMATCH',
          `pages lists ${show(pageId)}; expected issues/${issueId}/pages/${show(pageId)}/ and it does not exist.`);
      } else if (page.doc && page.doc.scene !== scene.id) {
        ctx.err(scene.rel, 'SCENE_PAGES_MISMATCH',
          `pages lists ${pageId}; expected that page to name ${scene.id} as its scene, and ${page.rel} says ${show(page.doc.scene)}.`);
      }
    }
    for (const beat of arr(scene.doc.beats).filter(isObj)) {
      for (const pageId of arr(beat.pages)) {
        if (!pageById.has(pageId)) {
          ctx.err(scene.rel, 'BEAT_PAGES_UNKNOWN',
            `Beat ${show(beat.id)} lists page ${show(pageId)}; expected a page of ${issueId} (${show(pages.map((p) => p.id))}).`);
        }
      }
    }
  }

  if (issue) {
    if (typeof issue.page_count === 'number' && issue.page_count !== pages.length) {
      ctx.err(issueRel, 'PAGE_COUNT_MISMATCH',
        `page_count is ${issue.page_count}; expected ${pages.length}, the number of page directories under issues/${issueId}/pages/.`);
    }
    if (typeof issue.panel_count === 'number' && issue.panel_count !== panelCount) {
      ctx.err(issueRel, 'PANEL_COUNT_MISMATCH',
        `panel_count is ${issue.panel_count}; expected ${panelCount}, the number of panels in the page files.`);
    }
  }

  const stateRel = `continuity/${issueId}.final-state.yaml`;
  if (ctx.exists(stateRel)) {
    const state = ctx.loadMap(stateRel);
    if (state) expectId(ctx, stateRel, 'issue', state.issue, issueId);
  }
}

function checkCrossReferences(ctx) {
  // Each part is independent: one malformed file must not hide the others.
  const parts = [checkEntities, checkEntityReferences, checkManifest, checkStoryBible, checkSeriesPlan];
  for (const part of parts) {
    try {
      part(ctx);
    } catch (err) {
      ctx.err('', 'INTERNAL_ERROR', `The cross-reference check ${part.name} stopped early: ${err.message}`);
    }
  }
  for (const issueId of ctx.issues) checkIssueReferences(ctx, issueId);
}

// --- c. review rules ---------------------------------------------------------

function maxRepairCycles(ctx) {
  const project = ctx.loadMap('project.yaml');
  const policy = project && isObj(project.repair_policy) ? project.repair_policy : null;
  return policy && Number.isInteger(policy.max_cycles) && policy.max_cycles >= 0
    ? policy.max_cycles
    : DEFAULT_MAX_REPAIR_CYCLES;
}

function checkReviewDoc(ctx, rel, doc, pageId, fileRender, maxCycles) {
  expectId(ctx, rel, 'render', doc.render, fileRender);
  expectId(ctx, rel, 'page', doc.page, pageId);
  if (ws.ID.render.test(fileRender) && !ctx.renderOnDisk(fileRender)) {
    ctx.err(rel, 'MISSING_RENDER',
      `Review of ${fileRender}; expected that image under ${pageId}/renders/ and none is on disk. A review needs pixels to judge.`);
  }

  const findings = arr(doc.findings).filter(isObj);
  const checks = isObj(doc.checks) ? doc.checks : {};
  const gates = isObj(doc.gates) ? doc.gates : {};
  const verdict = doc.verdict;
  const failedChecks = Object.keys(checks).filter((key) => {
    const result = isObj(checks[key]) ? checks[key].result : checks[key];
    return result !== 'pass' && result !== 'not_applicable';
  });
  const openBlocking = findings.filter((f) => f.severity === 'blocking' && f.status === 'open');
  const failedGates = Object.keys(gates).filter((key) => gates[key] === 'fail');
  const ids = (list) => show(list.map((f) => f.id || '?'));

  if (verdict === 'pass') {
    if (findings.length) {
      ctx.err(rel, 'REVIEW_PASS_NOT_CLEAN',
        `verdict is pass with ${findings.length} finding(s) ${ids(findings)}; expected zero findings for a pass.`);
    }
    if (failedChecks.length) {
      ctx.err(rel, 'REVIEW_PASS_NOT_CLEAN',
        `verdict is pass while checks ${show(failedChecks)} are not pass or not_applicable; expected every check to pass.`);
    }
  }
  if (verdict === 'fixed' && !findings.length) {
    ctx.err(rel, 'REVIEW_FIXED_WITHOUT_FINDINGS',
      'verdict is fixed with no findings; expected at least one finding that was repaired (use pass when nothing was wrong).');
  }
  for (const f of findings.filter((x) => x.status === 'fixed')) {
    const recheck = isObj(f.recheck) ? f.recheck : null;
    if (!recheck || !hasText(recheck.render) || !hasText(recheck.evidence)) {
      ctx.err(rel, 'REVIEW_RECHECK_MISSING',
        `Finding ${f.id || '?'} is fixed; expected recheck.render and recheck.evidence from reopening the corrected render, ` +
        `and the review has ${recheck ? `render ${show(recheck.render)}, evidence ${show(recheck.evidence)}` : 'no recheck'}.`);
    } else if (ws.ID.render.test(recheck.render) && recheck.render !== fileRender &&
        !ctx.renderOnDisk(recheck.render)) {
      // The review's own render is covered by MISSING_RENDER above.
      ctx.err(rel, 'REVIEW_RECHECK_MISSING',
        `Finding ${f.id || '?'} was rechecked against ${recheck.render}; expected that render on disk and it is not there.`);
    }
  }
  if (verdict !== 'flagged' && (openBlocking.length || failedGates.length)) {
    const why = [];
    if (openBlocking.length) why.push(`open blocking finding(s) ${ids(openBlocking)}`);
    if (failedGates.length) why.push(`failed gate(s) ${show(failedGates)}`);
    ctx.err(rel, 'REVIEW_MUST_BE_FLAGGED',
      `verdict is ${show(verdict)} with ${why.join(' and ')}; expected flagged.`);
  }
  for (const f of findings) {
    if (f.severity === 'blocking' && f.status === 'accepted') {
      ctx.err(rel, 'REVIEW_BLOCKING_ACCEPTED',
        `Finding ${f.id || '?'} is blocking and accepted; expected open or fixed, because a blocking finding cannot be accepted.`);
    }
  }
  if (typeof doc.repair_cycle === 'number' && doc.repair_cycle > maxCycles) {
    ctx.err(rel, 'REVIEW_REPAIR_LIMIT',
      `repair_cycle is ${doc.repair_cycle}; expected at most ${maxCycles} (project.repair_policy.max_cycles). ` +
      'Fix the plan or the references before generating again.');
  }
}

function checkReviews(ctx) {
  const maxCycles = maxRepairCycles(ctx);
  for (const issueId of ctx.issues) {
    for (const page of ctx.pages(issueId)) {
      const dir = `${page.dir}/reviews`;
      for (const name of listNames(ctx.abs(dir)).filter((n) => /\.review\.ya?ml$/i.test(n))) {
        const rel = `${dir}/${name}`;
        const doc = ctx.loadMap(rel);
        if (doc) checkReviewDoc(ctx, rel, doc, page.id, name.replace(/\.review\.ya?ml$/i, ''), maxCycles);
      }
      const doc = page.doc;
      if (!doc || (doc.status !== 'reviewed' && doc.status !== 'approved')) continue;
      const current = doc.current_render;
      if (!hasText(current)) {
        ctx.err(page.rel, 'PAGE_STATUS_UNREVIEWED',
          `status is ${doc.status} and current_render is ${show(current)}; expected a render with a passing review.`);
        continue;
      }
      const review = ctx.review(current);
      if (!ws.reviewPasses(review)) {
        ctx.err(page.rel, 'PAGE_STATUS_UNREVIEWED',
          `status is ${doc.status}; expected ${page.dir}/reviews/${current}.review.yaml with verdict pass or fixed, and ` +
          `${review ? `its verdict is ${show(review.verdict)}` : 'there is no such review'}.`);
      }
    }
  }
}

// --- d. edition rules --------------------------------------------------------

function checkEditions(ctx) {
  for (const editionId of listNames(ctx.abs('editions'))) {
    const rel = `editions/${editionId}/edition.yaml`;
    if (!isDir(ctx.abs(`editions/${editionId}`)) || !ctx.exists(rel) || !ctx.inScope(rel)) continue;
    const doc = ctx.loadMap(rel);
    if (!doc) continue;
    expectId(ctx, rel, 'id', doc.id, editionId);
    if (ctx.issueFilter && doc.issue !== ctx.issueFilter) continue;

    const draft = doc.status === 'draft';
    const issuePages = ctx.allIssues.includes(doc.issue) ? ctx.pages(doc.issue).map((p) => p.id) : null;
    if (!issuePages) {
      ctx.err(rel, 'EDITION_PAGE_UNKNOWN',
        `issue is ${show(doc.issue)}; expected an issue of the workspace (${show(ctx.allIssues)}).`);
    }
    const seen = new Set();
    let lastIndex = -1;
    for (const entry of arr(doc.pages).filter(isObj)) {
      const pageId = entry.page;
      const renderId = entry.render;
      if (seen.has(pageId)) {
        ctx.err(rel, 'EDITION_PAGE_DUPLICATE', `${show(pageId)} is listed more than once; expected each page once.`);
        continue;
      }
      seen.add(pageId);
      if (issuePages) {
        const index = issuePages.indexOf(pageId);
        if (index === -1) {
          ctx.err(rel, 'EDITION_PAGE_UNKNOWN',
            `pages lists ${show(pageId)}; expected a page of ${doc.issue} (${show(issuePages)}).`);
        } else {
          if (index < lastIndex) {
            ctx.err(rel, 'EDITION_PAGE_ORDER',
              `${pageId} is listed after ${issuePages[lastIndex]}; expected page-number order (${show(issuePages)}).`);
          }
          lastIndex = Math.max(lastIndex, index);
        }
      }

      if (ws.pageOfRender(renderId) !== pageId) {
        ctx.err(rel, 'EDITION_RENDER_MISMATCH',
          `${show(pageId)} ships render ${show(renderId)}; expected a render of that page (${show(pageId)}_V##).`);
        continue;
      }
      const file = hasText(entry.file) ? entry.file.replace(/\\/g, '/') : null;
      if (!file || !ctx.exists(file)) {
        ctx.err(rel, 'EDITION_RENDER_MISSING',
          `${pageId} ships file ${show(entry.file)}; expected that image on disk and it is not there.`);
      } else if (!path.posix.basename(file).startsWith(renderId)) {
        ctx.err(rel, 'EDITION_RENDER_MISMATCH',
          `${pageId} names render ${renderId} and file ${file}; expected the file of that exact render.`);
      }
      if (hasText(entry.lettered_file) && !ctx.exists(entry.lettered_file.replace(/\\/g, '/'))) {
        ctx.err(rel, 'EDITION_RENDER_MISSING',
          `${pageId} ships lettered_file ${entry.lettered_file}; expected that file on disk and it is not there.`);
      }
      const review = ctx.review(renderId);
      if (!ws.reviewPasses(review)) {
        const message = `${renderId} is listed; expected a review with verdict pass or fixed, and ` +
          `${review ? `its verdict is ${show(review.verdict)}` : 'it has no review file'}.`;
        if (draft) {
          ctx.warn(rel, 'EDITION_RENDER_UNREVIEWED', `${message} Allowed while the edition is a draft.`);
        } else {
          ctx.err(rel, 'EDITION_RENDER_UNREVIEWED', `${message} Edition status is ${show(doc.status)}.`);
        }
      }
    }

    if (issuePages) {
      // Gaps: a page missing before the last listed one is always an error;
      // a draft may stop short of the end of the issue.
      issuePages.forEach((pageId, index) => {
        if (seen.has(pageId)) return;
        const message = `${pageId} is not listed; expected every page of ${doc.issue} once, with no gaps (${show(issuePages)}).`;
        if (index > lastIndex && draft) {
          ctx.warn(rel, 'EDITION_PAGE_GAP', `${message} Allowed at the end of a draft.`);
        } else {
          ctx.err(rel, 'EDITION_PAGE_GAP', message);
        }
      });
    }
  }
}

// --- e. generation records ---------------------------------------------------

function checkGenerations(ctx) {
  const dir = ctx.abs('generations');
  const files = walk(dir, { filter: (f) => /(^|[\\/])GEN_[^\\/]+\.ya?ml$/i.test(f) });
  for (const file of files) {
    const rel = ws.rel(ctx.root, file);
    if (!ctx.inScope(rel)) continue;
    const doc = ctx.loadMap(rel);
    if (!doc) continue;
    expectId(ctx, rel, 'id', doc.id, path.basename(file).replace(/\.ya?ml$/i, ''));

    const unavailable = arr(doc.metadata_unavailable);
    const cost = isObj(doc.cost) ? doc.cost : {};
    const completed = COMPLETED_GENERATION.includes(doc.status);
    const fields = [
      { name: 'model', isUnavailable: doc.model === 'unreported', shown: `model is ${show(doc.model)}`, want: 'model: unreported' },
      { name: 'cost', isUnavailable: cost.reported === false, shown: `cost.reported is ${show(cost.reported)}`, want: 'cost.reported: false' },
      { name: 'seed', isUnavailable: doc.seed === null || doc.seed === undefined, shown: `seed is ${show(doc.seed)}`, want: 'seed: null' },
    ];
    for (const field of fields) {
      const listed = unavailable.includes(field.name);
      if (listed && !field.isUnavailable) {
        ctx.err(rel, 'GENERATION_METADATA_INCONSISTENT',
          `metadata_unavailable lists ${field.name} but ${field.shown}; expected ${field.want}, or ${field.name} removed from the list if the tool did report it.`);
      } else if (!listed && field.isUnavailable && completed) {
        ctx.warn(rel, 'GENERATION_METADATA_INCONSISTENT',
          `${field.shown} on a ${doc.status} record; expected ${field.name} in metadata_unavailable (it lists ${show(unavailable)}).`);
      }
    }
    if (cost.reported === false && typeof cost.amount === 'number' && cost.estimated !== true) {
      ctx.err(rel, 'GENERATION_METADATA_INCONSISTENT',
        `cost.amount is ${cost.amount} with reported: false and estimated: ${show(cost.estimated)}; expected null, ` +
        'because a number the tool did not report and nobody estimated is invented.');
    }
    if ((doc.status === 'succeeded' || doc.status === 'approved') && hasText(doc.output_render) &&
        ws.ID.render.test(doc.output_render) && !ctx.renderOnDisk(doc.output_render)) {
      ctx.err(rel, 'MISSING_RENDER',
        `output_render is ${doc.output_render} on a ${doc.status} record; expected that image on disk and it is not there.`);
    }
  }
}

// --- f. lettering ------------------------------------------------------------

function checkLettering(ctx) {
  for (const issueId of ctx.issues) {
    for (const page of ctx.pages(issueId)) {
      const rel = `${page.dir}/lettering.yaml`;
      if (!ctx.exists(rel)) continue;
      const doc = ctx.loadMap(rel);
      if (!doc || !page.doc) continue;
      expectId(ctx, rel, 'page', doc.page, page.id);

      const planned = new Map(); // lettering id -> { text, panel }
      for (const panel of arr(page.doc.panels).filter(isObj)) {
        for (const el of arr(panel.lettering).filter(isObj)) {
          if (el.id && !planned.has(el.id)) planned.set(el.id, { text: el.text, panel: panel.id });
        }
      }
      const placed = new Set();
      for (const el of arr(doc.elements).filter(isObj)) {
        if (!el.id) continue;
        placed.add(el.id);
        const source = planned.get(el.id);
        if (!source) {
          ctx.err(rel, 'LETTERING_UNKNOWN_ELEMENT',
            `Element ${el.id} is placed; expected a lettering id of ${page.rel} (${show([...planned.keys()])}).`);
        } else if (String(el.text) !== String(source.text)) {
          ctx.err(rel, 'LETTERING_TEXT_MISMATCH',
            `Element ${el.id} reads ${JSON.stringify(el.text)}; expected the page.yaml text ${JSON.stringify(source.text)} (${source.panel}).`);
        }
      }
      for (const [id, source] of planned) {
        if (!placed.has(id)) {
          ctx.warn(rel, 'LETTERING_MISSING_ELEMENT',
            `${id} (${source.panel}) has no element here; expected every lettering id of ${page.rel} to be placed.`);
        }
      }
    }
  }
}

// --- g. panel ledger ---------------------------------------------------------

function checkLedger(ctx) {
  if (ctx.issueFilter && !ctx.issues.length) return; // reported by validateWorkspace()
  const { findings } = checkContinuity(ctx.root, { issue: ctx.issueFilter || undefined });
  for (const f of findings) {
    const file = f.page && f.issue ? `issues/${f.issue}/pages/${f.page}/page.yaml`
      : f.issue ? `issues/${f.issue}/issue.yaml` : '';
    // A page that failed to parse or is missing was already reported above.
    if (f.code === 'UNREADABLE_FILE' &&
        ctx.errors.some((e) => e.file === file && (e.code === 'YAML_PARSE' || e.code === 'MISSING_FILE'))) continue;
    (f.severity === 'error' ? ctx.err : ctx.warn)(file, f.code, f.message);
  }
}

// --- entry points ------------------------------------------------------------

const SECTIONS = [
  ['schemas', checkSchemas],
  ['cross-references', checkCrossReferences],
  ['review rules', checkReviews],
  ['edition rules', checkEditions],
  ['generation records', checkGenerations],
  ['lettering', checkLettering],
  ['panel ledger', checkLedger],
];

/**
 * Validate a workspace mechanically.
 * @param {string} root  workspace root (the directory holding project.yaml)
 * @param {{issue?: string, schemasDir?: string}} [opts]
 * @returns {{errors: Array<{file: string, code: string, message: string}>, warnings: Array<{file: string, code: string, message: string}>}}
 */
function validateWorkspace(root, opts = {}) {
  const errors = [];
  const warnings = [];
  const wsRoot = path.resolve(String(root || '.'));
  if (!isFile(path.join(wsRoot, 'project.yaml'))) {
    errors.push({
      file: 'project.yaml',
      code: 'NOT_A_WORKSPACE',
      message: `${wsRoot.split(path.sep).join('/')} has no project.yaml; expected a workspace root (run create-project.js to scaffold one).`,
    });
    return { errors, warnings };
  }
  const ctx = createContext(wsRoot, opts || {}, errors, warnings);
  if (ctx.issueFilter && !ctx.issues.length) {
    ctx.err(`issues/${ctx.issueFilter}/issue.yaml`, 'MISSING_FILE',
      `Issue ${ctx.issueFilter} was requested; expected issues/${ctx.issueFilter}/ and the workspace has ${show(ctx.allIssues)}.`);
  }
  for (const [name, fn] of SECTIONS) {
    try {
      fn(ctx);
    } catch (err) {
      ctx.err('', 'INTERNAL_ERROR', `The ${name} check stopped early: ${err.message}`);
    }
  }
  return { errors, warnings };
}

/**
 * Recorded verdicts for each page's current render. Read from the review
 * files; this script never looks at an image.
 */
function reviewSummary(root, opts = {}) {
  const summary = { pages: 0, no_render: 0, pass: 0, fixed: 0, flagged: 0, unreviewed: 0 };
  const wsRoot = path.resolve(String(root || '.'));
  let issues = [];
  try {
    issues = ws.listIssues(wsRoot);
  } catch (err) {
    issues = [];
  }
  for (const issueId of issues.filter((id) => !opts.issue || id === opts.issue)) {
    for (const pageId of listNames(path.join(wsRoot, 'issues', issueId, 'pages')).filter((n) => ws.ID.page.test(n))) {
      const pageDir = path.join(wsRoot, 'issues', issueId, 'pages', pageId);
      const page = artifacts.readYaml(path.join(pageDir, 'page.yaml')).doc;
      summary.pages++;
      const current = isObj(page) ? page.current_render : null;
      if (!hasText(current)) {
        summary.no_render++;
        continue;
      }
      const review = artifacts.readYaml(path.join(pageDir, 'reviews', `${current}.review.yaml`)).doc;
      const verdict = isObj(review) ? review.verdict : null;
      if (verdict === 'pass' || verdict === 'fixed' || verdict === 'flagged') summary[verdict]++;
      else summary.unreviewed++;
    }
  }
  return summary;
}

/** Human report. Mechanical validation and visual review stay under separate headings. */
function formatReport(root, result, summary) {
  const lines = [];
  const line = (item, mark) => `  ${mark} ${item.file || '(workspace)'} [${item.code}] ${item.message}`;
  lines.push(`validate-workspace: ${path.resolve(root).split(path.sep).join('/')}`);
  lines.push('');
  lines.push('## Mechanical validation');
  lines.push('  Schemas, cross-references, review and edition rules, generation records, lettering text, panel ledger.');
  for (const item of result.errors) lines.push(line(item, FAIL));
  for (const item of result.warnings) lines.push(line(item, '!'));
  lines.push(`  ${result.errors.length ? FAIL : PASS} ${result.errors.length} error(s), ${result.warnings.length} warning(s)`);
  lines.push('');
  lines.push('## Visual review');
  lines.push('  Not performed by this script. Verdicts recorded in the review files for each page\'s current render:');
  lines.push(`  - ${summary.pages} page(s): ${summary.pass} pass, ${summary.fixed} fixed, ${summary.flagged} flagged, ` +
    `${summary.unreviewed} rendered without a review, ${summary.no_render} with no render yet`);
  lines.push('');
  lines.push('Mechanical validation does not certify the drawn pages. Only a visual review of the rendered pixels does.');
  return lines;
}

function main(argv = process.argv.slice(2)) {
  helpIfRequested(argv, HELP);
  const { flags } = parseArgs(argv);
  if (flags.root === true) fatal('--root needs a directory (see --help)');
  if (flags.issue === true) fatal('--issue needs an issue ID such as ISS_001 (see --help)');
  const root = ws.findWorkspaceRoot(flags.root ? path.resolve(String(flags.root)) : process.cwd());
  if (!root) {
    fatal(`no workspace found at ${flags.root || process.cwd()} (a workspace root holds project.yaml)`);
  }
  const opts = { issue: flags.issue ? String(flags.issue) : undefined };
  const result = validateWorkspace(root, opts);
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const line of formatReport(root, result, reviewSummary(root, opts))) console.log(line);
  }
  return result.errors.length ? 1 : 0;
}

module.exports = { validateWorkspace, reviewSummary, formatReport, main };

// exitCode, not exit(): lets a long --json report flush through a pipe.
if (require.main === module) process.exitCode = main();
