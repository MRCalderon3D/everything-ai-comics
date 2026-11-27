'use strict';
/**
 * Rename an entity ID, or merge one entity into another (TODO item 11).
 *
 * rename(from, to): every reference to `from` in the workspace becomes `to`:
 * the entity's own directory and file names (refs/CHAR_X_TURN_V01.png,
 * generations/CHAR_X/), the asset IDs of the registry, pages, scenes, the
 * story bible, wardrobe, reference plans, prompt packages and generation
 * records, and the story proposals and planner notes the studio keeps. Plan
 * approvals of pages that only changed by the rename stay approved.
 *
 * merge(from, into): `from` is the same person, place or object as `into`.
 * Every reference to `from` points at `into`; `into` keeps its own file and
 * its sheets, and the sheets of `from` go (its directory, its registry
 * entries, its generation records). Outfits of `from` that pages use become
 * the default outfit of `into` (or move into its wardrobe when it has none).
 * A panel, scene or bible list that now names `into` twice keeps one entry.
 * The name of `from` becomes an alias of `into`. When `into` has no file yet
 * (only the story bible or a proposal names it), a merge is a rename.
 * A merge is refused when pages were drawn from a sheet of `from`: those
 * pages would lose what they were drawn from.
 *
 * Both run the workspace checks before and after, and say what the edit broke,
 * if anything. The caller (actions.js) wraps them in one history commit.
 */

const fs = require('fs');
const path = require('path');
const S = require('./scaffold');
const story = require('./story');
const check = require('./workspace-check');
const { HttpError, toPosix } = require('./util');

const ENTITY_RE = /^(CHAR|LOC|PROP)_[A-Z][A-Z0-9_]*$/;
const DIRS = { CHAR: 'characters', LOC: 'locations', PROP: 'props' };
const FILES = { CHAR: 'character.yaml', LOC: 'location.yaml', PROP: 'prop.yaml' };
const TAGS = 'TURN|MODEL|EXPR|WARD|PLATE|SHEET|LOOK|DETAIL|REF|MASTER';
const TEXT_EXT = ['.yaml', '.yml', '.json'];

function esc(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The ID itself and the names built on it: asset IDs (CHAR_X_TURN_V01), records (GEN_CHAR_X_01), packages (PP_CHAR_X_...). */
function familyRe(id) {
  return new RegExp(`(?<![A-Za-z0-9])${esc(id)}(?![A-Za-z0-9])(?!_(?!(?:${TAGS}|\\d)))`, 'g');
}

/** The ID alone, as a value. */
function bareRe(id) {
  return new RegExp(`(?<![A-Za-z0-9_])${esc(id)}(?![A-Za-z0-9_])`, 'g');
}

function typeOf(id) {
  return String(id).split('_')[0];
}

function entityDirRel(id) {
  return `${DIRS[typeOf(id)]}/${id}`;
}

function hasDir(root, id) {
  return fs.existsSync(path.join(root, ...entityDirRel(id).split('/'), FILES[typeOf(id)]));
}

/** Every text file of the workspace an ID can appear in, except the person's own story text. */
function textFiles(root) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.startsWith('.') || child === 'story/source') continue;
      if (e.isDirectory()) stack.push(child);
      else if (TEXT_EXT.includes(path.extname(e.name).toLowerCase())) out.push(child);
    }
  }
  return out.sort();
}

/** Replace in every text file; returns the workspace paths that changed. */
function rewriteAll(root, files, re, replacement) {
  const changed = [];
  for (const rel of files) {
    const file = S.ws.abs(root, rel);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      continue;
    }
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const next = text.replace(re, replacement);
    if (next !== text) {
      fs.writeFileSync(file, next);
      changed.push(rel);
    }
  }
  return changed;
}

/** The studio's own records outside the workspace: proposals and planner notes. */
function rewriteStudio(project, re, replacement) {
  const files = [];
  try {
    for (const n of fs.readdirSync(path.join(project.studioDir, 'proposals'))) {
      if (/^prop_.+\.json$/.test(n)) files.push(path.join(project.studioDir, 'proposals', n));
    }
  } catch (err) {
    // no proposals yet
  }
  files.push(path.join(project.studioDir, 'assumptions.json'));
  for (const file of files) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      re.lastIndex = 0;
      const next = text.replace(re, replacement);
      if (next !== text) fs.writeFileSync(file, next);
    } catch (err) {
      // missing file
    }
  }
}

/** Pages whose plan the person approved and that still match it. */
function approvedPages(project) {
  const root = project.root;
  const approvals = project.state().plan_approvals || {};
  const out = [];
  for (const [id, entry] of Object.entries(approvals)) {
    const page = S.ws.ID.page.test(id) ? S.ws.loadPage(root, id) : null;
    if (page && entry && entry.hash === S.pipeline.hashPage(page)) out.push(id);
  }
  return out;
}

function keepApprovals(project, ids) {
  if (!ids.length) return;
  const approvals = Object.assign({}, project.state().plan_approvals || {});
  for (const id of ids) {
    const page = S.ws.loadPage(project.root, id);
    if (page && approvals[id]) approvals[id] = Object.assign({}, approvals[id], { hash: S.pipeline.hashPage(page) });
  }
  project.saveState({ plan_approvals: approvals });
}

function dropSheetChecks(project, id) {
  const checks = Object.assign({}, project.state().sheet_checks || {});
  let changed = false;
  for (const key of Object.keys(checks)) {
    if (key === id || key.startsWith(`${id}_`)) {
      delete checks[key];
      changed = true;
    }
  }
  if (changed) project.saveState({ sheet_checks: checks });
}

function renameSheetChecks(project, from, to) {
  const checks = project.state().sheet_checks || {};
  const re = familyRe(from);
  const next = {};
  let changed = false;
  for (const [key, value] of Object.entries(checks)) {
    re.lastIndex = 0;
    const k = key.replace(re, to);
    if (k !== key) changed = true;
    next[k] = value;
  }
  if (changed) project.saveState({ sheet_checks: next });
}

/** Rename files and directories whose names carry the ID, deepest first. Returns [[oldRel, newRel]]. */
function renamePaths(root, from, to) {
  const all = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(child);
      all.push(child);
    }
  }
  const re = familyRe(from);
  const moves = [];
  for (const rel of all.sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a))) {
    const base = path.posix.basename(rel);
    re.lastIndex = 0;
    const next = base.replace(re, to);
    if (next === base) continue;
    const target = `${path.posix.dirname(rel) === '.' ? '' : `${path.posix.dirname(rel)}/`}${next}`;
    if (fs.existsSync(S.ws.abs(root, target))) {
      throw new HttpError(409, 'rename_conflict', `${target} already exists.`, undefined, { path: target });
    }
    fs.renameSync(S.ws.abs(root, rel), S.ws.abs(root, target));
    moves.push([rel, target]);
  }
  // Report the final place of every moved path (a parent may have moved after its child).
  return moves.map(([oldRel, newRel]) => {
    let finalRel = newRel;
    for (const [o, n] of moves) {
      if (finalRel.startsWith(`${o}/`)) finalRel = n + finalRel.slice(o.length);
    }
    return [oldRel, finalRel];
  });
}

/** Where an ID is written down: its file, the story bible, an open proposal. */
function whereKnown(project, id) {
  const root = project.root;
  const out = { file: hasDir(root, id), bible: false, proposal: false, referenced: false };
  try {
    const bible = S.ws.loadYaml(S.ws.abs(root, story.BIBLE)) || {};
    out.bible = (Array.isArray(bible.characters) ? bible.characters : []).some((c) => c && c.id === id);
  } catch (err) {
    out.bible = false;
  }
  for (const p of story.list(project, { status: 'open' })) {
    try {
      if (JSON.stringify(story.read(project, p.id).parts).includes(`"${id}"`)) out.proposal = true;
    } catch (err) {
      // unreadable proposal
    }
  }
  const re = bareRe(id);
  out.referenced = out.file || out.bible || out.proposal || textFiles(root).some((rel) => {
    try {
      re.lastIndex = 0;
      return re.test(fs.readFileSync(S.ws.abs(root, rel), 'utf8'));
    } catch (err) {
      return false;
    }
  });
  return out;
}

function checkIds(from, to, word) {
  if (!ENTITY_RE.test(String(from || ''))) throw new HttpError(400, 'bad_params', '"from" must be a character, location or prop ID.');
  if (!ENTITY_RE.test(String(to || ''))) throw new HttpError(400, 'bad_params', `"${word}" must be a character, location or prop ID such as CHAR_MARTA.`);
  if (typeOf(from) !== typeOf(to)) throw new HttpError(400, 'bad_params', `${from} and ${to} are different kinds of thing.`);
  if (from === to) throw new HttpError(400, 'bad_params', 'The two IDs are the same.');
}

/**
 * Rename an entity ID everywhere.
 * @returns {{from, to, files: string[], moved: [string, string][], check: object}}
 */
function rename(project, from, to, { merging = false } = {}) {
  const root = project.root;
  checkIds(from, to, 'to');
  const where = whereKnown(project, from);
  if (!where.referenced) throw new HttpError(404, 'id_not_found', `${from} is not used anywhere in this project.`, undefined, { id: from });
  if (hasDir(root, to) || fs.existsSync(S.ws.abs(root, entityDirRel(to)))) {
    throw new HttpError(409, 'entity_exists', `${to} already exists. Merge ${from} into it instead.`, undefined, { entity: to, from });
  }
  const previous = check.before(root);
  const approved = approvedPages(project);
  const files = textFiles(root);
  const re = familyRe(from);
  const changed = rewriteAll(root, files, re, to);
  const moved = renamePaths(root, from, to);
  rewriteStudio(project, familyRe(from), to);
  renameSheetChecks(project, from, to);
  keepApprovals(project, approved);
  return { from, to, merged: merging, files: changed, moved, check: check.after(root, previous) };
}

/** Undrawn pages that cite assets of `id`, and drawn pages that were drawn from them. */
function pagesCiting(root, id) {
  const re = new RegExp(`(?<![A-Za-z0-9])${esc(id)}_(?:${TAGS})[A-Z0-9_]*_V\\d{2}`);
  const drawn = [];
  const planned = [];
  for (const issue of S.ws.listIssues(root)) {
    for (const entry of S.ws.listPages(root, issue)) {
      const files = [path.join(entry.dir, 'reference-plan.yaml')];
      try {
        for (const n of fs.readdirSync(path.join(entry.dir, 'prompts'))) files.push(path.join(entry.dir, 'prompts', n));
      } catch (err) {
        // no prompts yet
      }
      const cites = files.filter((f) => {
        try {
          return re.test(fs.readFileSync(f, 'utf8'));
        } catch (err) {
          return false;
        }
      });
      const inPage = entry.doc && entry.doc.references && ['required', 'optional']
        .some((k) => Array.isArray(entry.doc.references[k]) && entry.doc.references[k].some((x) => re.test(String(x))));
      if (!cites.length && !inPage) continue;
      if (S.ws.listRenders(root, entry.id).length) drawn.push(entry.id);
      else planned.push({ page: entry.id, files: cites.map((f) => toPosix(path.relative(root, f))), inPage });
    }
  }
  return { drawn, planned, re };
}

function rewriteYaml(root, rel, mutate) {
  const file = S.ws.abs(root, rel);
  if (!fs.existsSync(file)) return false;
  try {
    if (S.yamlEdit) return S.yamlEdit.rewriteYamlFile(file, mutate).changed;
    const doc = S.yaml.parse(fs.readFileSync(file, 'utf8'));
    mutate(doc);
    fs.writeFileSync(file, S.yaml.stringify(doc));
    return true;
  } catch (err) {
    return false;
  }
}

function uniq(list) {
  return [...new Set(list)];
}

/**
 * Merge `from` into `into`.
 * @returns {{from, into, files: string[], removed: string[], check: object, renamed?: boolean}}
 */
function merge(project, from, into) {
  const root = project.root;
  checkIds(from, into, 'into');
  const source = whereKnown(project, from);
  if (!source.referenced) throw new HttpError(404, 'id_not_found', `${from} is not used anywhere in this project.`, undefined, { id: from });
  const target = whereKnown(project, into);
  if (!target.referenced) throw new HttpError(404, 'id_not_found', `${into} is not used anywhere in this project.`, undefined, { id: into });
  // Nobody has a file for the one to keep yet: the file of `from` takes its ID.
  if (!target.file && source.file) {
    const out = rename(project, from, into, { merging: true });
    return Object.assign(out, { into, renamed: true, removed: [] });
  }
  const type = typeOf(from);
  const citing = source.file ? pagesCiting(root, from) : { drawn: [], planned: [] };
  if (citing.drawn.length) {
    throw new HttpError(409, 'merge_refused', `Pages were drawn from a sheet of ${from}: ${citing.drawn.join(', ')}.`,
      { pages: citing.drawn }, { entity: from, pages: citing.drawn.join(', ') });
  }
  const previous = check.before(root);
  const changed = new Set();
  const removed = [];

  // Undrawn pages that cite a sheet of `from`: their reference plan and prompts are rebuilt before drawing.
  for (const p of citing.planned) {
    for (const rel of p.files) {
      fs.rmSync(S.ws.abs(root, rel), { force: true });
      removed.push(rel);
    }
    const pageRel = `issues/${S.ws.issueOfPage(p.page)}/pages/${p.page}/page.yaml`;
    if (p.inPage && rewriteYaml(root, pageRel, (doc) => {
      for (const k of ['required', 'optional']) {
        if (doc.references && Array.isArray(doc.references[k])) doc.references[k] = doc.references[k].filter((x) => !citing.re.test(String(x)));
      }
    })) changed.add(pageRel);
  }

  // Outfits of `from`: pages that use them get the outfit of `into`.
  const wardMap = new Map();
  if (type === 'CHAR' && source.file) {
    const fromWard = S.ws.loadWardrobe(root, from) || {};
    const intoChar = S.ws.loadCharacter(root, into) || {};
    const intoWard = S.ws.loadWardrobe(root, into) || null;
    const intoOutfits = intoWard && Array.isArray(intoWard.outfits) ? intoWard.outfits.filter((o) => o && o.id) : [];
    const fallback = intoChar.default_wardrobe || (intoOutfits[0] && intoOutfits[0].id) || null;
    const fromOutfits = Array.isArray(fromWard.outfits) ? fromWard.outfits.filter((o) => o && o.id) : [];
    if (fallback) {
      for (const o of fromOutfits) if (o.id !== fallback) wardMap.set(o.id, fallback);
    } else if (fromOutfits.length) {
      const rel = `${entityDirRel(into)}/wardrobe.yaml`;
      const moved = fromOutfits.map((o) => Object.assign({}, o, { references: [] }));
      if (intoWard) {
        rewriteYaml(root, rel, (doc) => { doc.outfits = [...(Array.isArray(doc.outfits) ? doc.outfits : []), ...moved]; });
      } else {
        fs.writeFileSync(S.ws.abs(root, rel), `# Schema: schemas/wardrobe.schema.json\n\n${S.yaml.stringify({ character: into, outfits: moved })}`);
      }
      changed.add(rel);
      rewriteYaml(root, `${entityDirRel(into)}/character.yaml`, (doc) => { if (!doc.default_wardrobe) doc.default_wardrobe = moved[0].id; });
    }
  }

  // The name of `from` is an alias of `into` from now on.
  const fromDoc = source.file ? S.ws.loadYaml(S.ws.abs(root, `${entityDirRel(from)}/${FILES[type]}`)) || {} : {};
  if (target.file && fromDoc.name) {
    const rel = `${entityDirRel(into)}/${FILES[type]}`;
    if (rewriteYaml(root, rel, (doc) => {
      if (doc.name === fromDoc.name) return;
      const aliases = Array.isArray(doc.aliases) ? doc.aliases : [];
      if (!aliases.includes(fromDoc.name)) doc.aliases = [...aliases, fromDoc.name];
    })) changed.add(rel);
  }

  // The sheets of `from` go: its directory, its registry entries, its generation records.
  if (source.file) {
    fs.rmSync(S.ws.abs(root, entityDirRel(from)), { recursive: true, force: true });
    removed.push(entityDirRel(from));
    const gen = `generations/${from}`;
    if (fs.existsSync(S.ws.abs(root, gen))) {
      fs.rmSync(S.ws.abs(root, gen), { recursive: true, force: true });
      removed.push(gen);
    }
    if (rewriteYaml(root, 'references/manifest.yaml', (doc) => {
      if (Array.isArray(doc.assets)) doc.assets = doc.assets.filter((a) => !a || a.entity !== from);
    })) changed.add('references/manifest.yaml');
    dropSheetChecks(project, from);
  }

  // Every remaining reference to `from` names `into`; outfits follow the map.
  const files = textFiles(root);
  for (const rel of rewriteAll(root, files, bareRe(from), into)) changed.add(rel);
  for (const [oldWard, newWard] of wardMap) {
    for (const rel of rewriteAll(root, files.filter((f) => f.startsWith('issues/') || f.startsWith('continuity/')), bareRe(oldWard), newWard)) changed.add(rel);
  }
  rewriteStudio(project, bareRe(from), into);

  // Lists that now name `into` twice keep one entry.
  for (const rel of [...changed]) {
    if (!/\.ya?ml$/.test(rel) || !fs.existsSync(S.ws.abs(root, rel))) continue;
    rewriteYaml(root, rel, (doc) => dedupe(doc, into, rel));
  }
  return { from, into, renamed: false, files: [...changed].filter((rel) => fs.existsSync(S.ws.abs(root, rel))), removed, check: check.after(root, previous) };
}

/** Remove the duplicates a merge leaves in a document: one row per character in a panel, one ID per list. */
function dedupe(doc, id, rel) {
  if (!doc || typeof doc !== 'object') return;
  if (/^story\/story-bible\.ya?ml$/.test(rel)) {
    if (Array.isArray(doc.characters)) {
      const rows = doc.characters.filter((c) => c && c.id === id);
      if (rows.length > 1) {
        const keep = rows[0];
        for (const r of rows.slice(1)) {
          if (!keep.arc && r.arc) keep.arc = r.arc;
          if (!keep.role && r.role) keep.role = r.role;
        }
        doc.characters = doc.characters.filter((c) => !(c && c.id === id) || c === keep);
      }
    }
    for (const f of Array.isArray(doc.facts) ? doc.facts : []) if (f && Array.isArray(f.affects)) f.affects = uniq(f.affects);
    return;
  }
  if (Array.isArray(doc.cast)) doc.cast = uniq(doc.cast);
  if (Array.isArray(doc.visually_adjacent_to)) doc.visually_adjacent_to = uniq(doc.visually_adjacent_to).filter((x) => x !== doc.id);
  for (const panel of Array.isArray(doc.panels) ? doc.panels : []) {
    if (!panel || !Array.isArray(panel.cast)) continue;
    const rows = panel.cast.filter((r) => r && r.character === id);
    if (rows.length > 1) {
      const keep = rows.find((r) => r.off_panel !== true) || rows[0];
      panel.cast = panel.cast.filter((r) => !(r && r.character === id) || r === keep);
    }
  }
}

module.exports = { rename, merge, whereKnown, familyRe, bareRe, textFiles };
