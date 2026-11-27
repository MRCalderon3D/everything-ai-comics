'use strict';
/**
 * Delete what the person does not want to keep (TODO item 13).
 *
 * One module knows, for each kind of thing, which files and records belong
 * to it and what uses it:
 *
 *   asset    a sheet candidate, a superseded or approved master, a look page,
 *            a reference photo filed for an entity (<ENTITY>_..._V##)
 *   render   a page render or repair attempt (PG_..._V##), a cover version (CV_..._V##)
 *   upload   a file in the upload store (up_...)
 *   edition  a draft edition (ED_..._..)
 *   entity   a whole character, place or prop (CHAR_ / LOC_ / PROP_)
 *   page     a whole page (PG_..._...), the last one of its issue
 *
 * plan() says what a delete would remove and edit, or why it is refused:
 * an approved master that pages were drawn from, the render an edition
 * ships, a reference a planned page lists, a whole entity pages still use.
 * The reason says what to do first. Deleting an approved master (or a whole
 * entity, or a drawn page) is allowed only with a second confirmation, and
 * the plan lists what depends on it.
 *
 * apply() removes the files, the registry entries (references/manifest.yaml),
 * the generation records, the reviews of a render, and the references in
 * character files, wardrobes, project.yaml and the studio's own state; then
 * the workspace checks run (workspace-check.js). actions.js wraps one
 * request (one item or several) in one history commit, so History can bring
 * it back. Uploads live outside the workspace and its history: deleting one
 * cannot be undone, and the plan says so.
 *
 * cleanup() lists the unused tries of a screen: older sheet candidates,
 * superseded masters, page and cover versions nothing ships or cites, draft
 * editions that a newer edition replaced.
 */

const fs = require('fs');
const path = require('path');
const S = require('./scaffold');
const check = require('./workspace-check');
const assumptions = require('./assumptions');
const files = require('./files');
const { msg } = require('./i18n');
const { HttpError, toPosix } = require('./util');

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp'];
const ASSET_RE = /^(CHAR|LOC|PROP|LOOK)_[A-Z][A-Z0-9_]*_V\d{2}$/;
const ENTITY_RE = /^(CHAR|LOC|PROP)_[A-Z][A-Z0-9_]*$/;
const PAGE_RENDER_RE = /^PG_\d{3}_\d{3}_V\d{2}$/;
const COVER_RENDER_RE = /^CV_\d{3}_V\d{2}$/;
const PAGE_RE = /^PG_\d{3}_\d{3}$/;
const EDITION_RE = /^ED_\d{3}_\d{2}$/;
const UPLOAD_RE = /^up_[A-Za-z0-9_]{4,80}$/;
const KINDS = ['asset', 'render', 'upload', 'edition', 'entity', 'page'];
const SHEET_BY_TAG = { MODEL: 'model', TURN: 'turnaround', EXPR: 'expressions', WARD: 'wardrobe', PLATE: 'plate', SHEET: 'prop', DETAIL: 'detail', REF: 'reference' };
const ENTITY_DIRS = { CHAR: 'characters', LOC: 'locations', PROP: 'props' };
const ENTITY_FILES = { CHAR: 'character.yaml', LOC: 'location.yaml', PROP: 'prop.yaml' };

function attempt(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    return fallback;
  }
}

function exists(root, rel) {
  return fs.existsSync(S.ws.abs(root, rel));
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    return '';
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (err) {
    return [];
  }
}

/** The kind of an ID, when the request does not say it. */
function kindOf(id) {
  const text = String(id || '');
  if (UPLOAD_RE.test(text)) return 'upload';
  if (EDITION_RE.test(text)) return 'edition';
  if (PAGE_RENDER_RE.test(text) || COVER_RENDER_RE.test(text)) return 'render';
  if (PAGE_RE.test(text)) return 'page';
  if (ASSET_RE.test(text)) return 'asset';
  if (ENTITY_RE.test(text)) return 'entity';
  return null;
}

/** Check one requested item: { kind?, id }. */
function checkItem(item) {
  if (!item || typeof item !== 'object') throw new HttpError(400, 'bad_params', 'Each item is { "kind": "...", "id": "..." }.');
  const id = typeof item.id === 'string' ? item.id.trim() : '';
  const kind = item.kind === undefined || item.kind === null || item.kind === '' ? kindOf(id) : item.kind;
  if (!KINDS.includes(kind)) throw new HttpError(400, 'bad_params', `"kind" must be one of ${KINDS.join(', ')}.`);
  if (kindOf(id) !== kind) throw new HttpError(400, 'bad_params', `"${id.slice(0, 80)}" is not the ID of a ${kind}.`);
  return { kind, id };
}

// --- who uses what -------------------------------------------------------------------

/** Text files of every page and the cover of every issue: page.yaml, reference plans, prompts, generation requests. */
function pageFiles(root) {
  const out = [];
  for (const issue of attempt(() => S.ws.listIssues(root), [])) {
    for (const entry of attempt(() => S.ws.listPages(root, issue), [])) {
      const drawn = attempt(() => S.ws.listRenders(root, entry.id), []).length > 0;
      const list = [
        { rel: S.ws.rel(root, entry.file), role: 'page' },
        { rel: S.ws.rel(root, path.join(entry.dir, 'reference-plan.yaml')), role: 'plan' },
        ...listDir(path.join(entry.dir, 'prompts')).filter((n) => /\.ya?ml$/i.test(n))
          .map((n) => ({ rel: S.ws.rel(root, path.join(entry.dir, 'prompts', n)), role: 'prompt' })),
        ...listDir(path.join(root, 'generations', entry.id)).filter((n) => /\.request\.json$/i.test(n))
          .map((n) => ({ rel: `generations/${entry.id}/${n}`, role: 'request' })),
      ];
      for (const f of list) out.push(Object.assign({ owner: entry.id, issue, drawn, cover: false }, f));
    }
    const coverId = S.ws.coverIdOfIssue(issue);
    const coverDir = S.ws.coverDir(root, issue);
    if (coverDir && fs.existsSync(coverDir)) {
      const drawn = attempt(() => S.ws.listCoverRenders(root, issue), []).length > 0;
      const list = [
        { rel: S.ws.rel(root, path.join(coverDir, 'cover.yaml')), role: 'page' },
        ...listDir(path.join(coverDir, 'prompts')).filter((n) => /\.ya?ml$/i.test(n))
          .map((n) => ({ rel: S.ws.rel(root, path.join(coverDir, 'prompts', n)), role: 'prompt' })),
        ...listDir(path.join(root, 'generations', coverId)).filter((n) => /\.request\.json$/i.test(n))
          .map((n) => ({ rel: `generations/${coverId}/${n}`, role: 'request' })),
      ];
      for (const f of list) out.push(Object.assign({ owner: coverId, issue, drawn, cover: true }, f));
    }
  }
  return out.filter((f) => exists(root, f.rel));
}

function idRe(id) {
  return new RegExp(`(?<![A-Za-z0-9_])${String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`);
}

/** Pages and covers that name an ID: { drawnFrom: [owner], planned: [owner] }. */
function citedBy(root, id, { ownPage = null, cache } = {}) {
  const re = idRe(id);
  const drawnFrom = new Set();
  const planned = new Set();
  for (const f of cache || pageFiles(root)) {
    if (f.owner === ownPage) continue;
    if (!re.test(readText(S.ws.abs(root, f.rel)))) continue;
    // A drawn page's plan and prompts are its history: it was drawn from what they name.
    if (f.drawn) drawnFrom.add(f.owner);
    else planned.add(f.owner);
  }
  return { drawnFrom: [...drawnFrom].sort(), planned: [...planned].sort() };
}

/** Editions that ship a render (or a page): [{ id, status }]. */
function editionsShipping(root, { render = null, page = null } = {}) {
  const out = [];
  for (const id of attempt(() => S.ws.listEditions(root), [])) {
    const doc = attempt(() => S.ws.loadEdition(root, id), null) || {};
    const pages = Array.isArray(doc.pages) ? doc.pages : [];
    const hit = (render && (pages.some((p) => p && p.render === render) || (doc.cover && doc.cover.render === render)))
      || (page && pages.some((p) => p && p.page === page));
    if (hit) out.push({ id, status: doc.status || 'draft' });
  }
  return out;
}

/** Generation records (yaml + request) of a scope that produced one of these files or renders. */
function recordsFor(root, scope, { media = [], render = null } = {}) {
  const dir = path.join(root, 'generations', scope);
  const out = { remove: [], trim: [] };
  for (const name of listDir(dir).filter((n) => /^GEN_.+\.ya?ml$/i.test(n))) {
    const rel = `generations/${scope}/${name}`;
    const doc = attempt(() => S.ws.loadYaml(path.join(dir, name)), null);
    if (!doc) continue;
    const list = Array.isArray(doc.media_files) ? doc.media_files.map((m) => String(m).replace(/\\/g, '/')) : [];
    const mine = list.filter((m) => media.includes(m));
    const byRender = render && doc.output_render === render;
    if (!mine.length && !byRender) continue;
    if (byRender || mine.length === list.length) {
      out.remove.push(rel);
      const request = rel.replace(/\.ya?ml$/i, '.request.json');
      if (exists(root, request)) out.remove.push(request);
    } else {
      out.trim.push({ rel, media: mine });
    }
  }
  return out;
}

// --- plans ---------------------------------------------------------------------------

function refuse(code, params) {
  return { code, message: msg(`delete.refused.${code}`, params) };
}

function baseView(kind, id) {
  return {
    kind, id, label: id, image: null, remove: [], edits: [], refused: null,
    confirm_twice: false, dependents: [], undo: 'history', notes: [],
  };
}

function imageFilesOf(root, dirRel, stem) {
  return listDir(S.ws.abs(root, dirRel))
    .filter((n) => IMAGE_EXT.includes(path.extname(n).toLowerCase()) && n.slice(0, -path.extname(n).length) === stem)
    .map((n) => `${dirRel}/${n}`);
}

/** The entity an asset ID belongs to: the registry says it, else the longest entity directory that starts it. */
function entityOfAssetId(root, id, assets) {
  const registered = assets.get(id);
  if (registered && registered.entity) return registered.entity;
  if (id.startsWith('LOOK_')) {
    return id.replace(/_(MASTER_)?V\d{2}$/, '').replace(/_(DETAIL|REF)(_[A-Z0-9_]+)?$/, '');
  }
  const type = id.split('_')[0];
  const ids = attempt(() => S.ws.listEntityIds(root, ENTITY_DIRS[type]), []).filter((e) => id.startsWith(`${e}_`));
  return ids.sort((a, b) => b.length - a.length)[0] || null;
}

function planAsset(project, id, ctx) {
  const root = project.root;
  const out = baseView('asset', id);
  const assets = ctx.assets;
  const entity = entityOfAssetId(root, id, assets);
  const dirRel = entity ? S.assetPaths.refsDir(entity) : null;
  const registered = assets.get(id) || null;
  const filesOnDisk = dirRel ? imageFilesOf(root, dirRel, id) : [];
  if (!registered && !filesOnDisk.length) throw new HttpError(404, 'not_found', `${id} is not an image of this project.`);
  out.entity = entity;
  // The name the screens use for the entity: its file's name, else its ID.
  if (entity && !entity.startsWith('LOOK_')) {
    const type = entity.split('_')[0];
    const doc = attempt(() => S.ws.loadYaml(S.ws.abs(root, `${ENTITY_DIRS[type]}/${entity}/${ENTITY_FILES[type]}`)), null);
    out.label = (doc && doc.name) || entity;
  } else if (entity) out.label = entity;
  out.version = parseInt(id.slice(-2), 10);
  const tag = entity ? id.slice(entity.length + 1).replace(/_?(MASTER_)?V\d{2}$/, '').split('_')[0] : '';
  out.sheet = entity && entity.startsWith('LOOK_') && (!tag || tag === 'MASTER') ? 'look' : (SHEET_BY_TAG[tag] || 'sheet');
  if (filesOnDisk[0]) out.image = files.image(project, filesOnDisk[0]);
  const isMaster = /_MASTER_V\d{2}$/.test(id);
  const status = registered ? registered.status : 'candidate';
  out.status = status;
  // A try that was approved is the same image as its master: delete the master to remove both.
  const promotedTo = [...assets.values()].find((a) => a && a.promoted_from === id);
  if (promotedTo && !isMaster) {
    out.refused = refuse('promoted', { master: promotedTo.id });
    return out;
  }
  const cited = citedBy(root, id, { cache: ctx.pageFiles });
  if (cited.drawnFrom.length) {
    out.refused = refuse('drawn_from', { pages: cited.drawnFrom.join(', ') });
    return out;
  }
  if (cited.planned.length) {
    out.refused = refuse('planned_reference', { pages: cited.planned.join(', ') });
    return out;
  }
  // Sheets of the same entity drawn from this one (an expressions sheet from the master).
  const sheetsFrom = [];
  for (const f of attempt(() => S.assetPaths.listPackageFiles(root, entity), [])) {
    if (idRe(id).test(readText(f))) sheetsFrom.push(toPosix(path.relative(root, f)));
  }
  out.remove.push(...filesOnDisk);
  const media = [...filesOnDisk];
  const ids = [id];
  if (isMaster && registered && registered.promoted_from) {
    const candidate = String(registered.promoted_from);
    const candidateFiles = dirRel ? imageFilesOf(root, dirRel, candidate) : [];
    if (candidateFiles.length) {
      out.remove.push(...candidateFiles);
      media.push(...candidateFiles);
      ids.push(candidate);
      out.notes.push(msg('delete.note.with_candidate', { candidate }));
    }
  }
  const records = recordsFor(root, entity, { media });
  out.remove.push(...records.remove);
  out.edits.push({ type: 'records', trim: records.trim });
  out.edits.push({ type: 'manifest', ids });
  out.edits.push({ type: 'entity_refs', entity, ids });
  out.edits.push({ type: 'sheet_checks', ids });
  if (status === 'approved' && (isMaster || (registered && registered.default_role === 'style'))) {
    out.confirm_twice = true;
    const projectDoc = attempt(() => S.ws.loadProject(root), null) || {};
    const lookRefs = projectDoc.style && Array.isArray(projectDoc.style.look_refs) ? projectDoc.style.look_refs : [];
    if (lookRefs.includes(id)) out.dependents.push(msg('delete.dep.look_frozen'));
    if (entity && !entity.startsWith('LOOK_')) out.dependents.push(msg('delete.dep.entity_master', { entity: out.label || entity }));
    if (sheetsFrom.length) out.dependents.push(msg('delete.dep.sheets_from', { n: sheetsFrom.length }));
    out.edits.push({ type: 'look_refs', ids });
  }
  if (registered && /_REF_V\d{2}$/.test(id)) out.notes.push(msg('delete.note.reference'));
  return out;
}

function planRender(project, id, ctx) {
  const root = project.root;
  const out = baseView('render', id);
  const isCover = COVER_RENDER_RE.test(id);
  const file = S.ws.renderFile(root, id);
  if (!file) throw new HttpError(404, 'not_found', `${id} is not a render of this project.`);
  out.image = files.image(project, S.ws.rel(root, file));
  const owner = isCover ? S.ws.coverOfRender(id) : S.ws.pageOfRender(id);
  out.owner = owner;
  const shipping = editionsShipping(root, { render: id });
  if (shipping.length) {
    const draft = shipping.every((e) => e.status === 'draft');
    out.refused = refuse(draft ? 'in_draft_edition' : 'in_edition', { editions: shipping.map((e) => e.id).join(', ') });
    return out;
  }
  const dir = path.dirname(file);
  const dirRel = S.ws.rel(root, dir);
  if (isCover) {
    const cover = attempt(() => S.ws.loadCover(root, owner), null) || {};
    if (cover.approved_render === id) {
      out.refused = refuse('approved_cover', {});
      return out;
    }
  } else {
    const page = attempt(() => S.ws.loadPage(root, owner), null) || {};
    if (page.current_render === id && page.status === 'approved') {
      out.refused = refuse('approved_page', { page: owner });
      return out;
    }
    const geometry = attempt(() => S.ws.loadYaml(path.join(S.ws.pageDir(root, owner), 'lettering.yaml')), null);
    if (geometry && geometry.render === id) {
      out.refused = refuse('lettered', { page: owner });
      return out;
    }
    const cited = citedBy(root, id, { ownPage: owner, cache: ctx.pageFiles });
    const others = [...cited.drawnFrom, ...cited.planned];
    if (others.length) {
      out.refused = refuse('render_reference', { pages: others.join(', ') });
      return out;
    }
    if (page.current_render === id) {
      const left = S.ws.listRenders(root, owner).filter((r) => r !== id);
      out.dependents.push(left.length ? msg('delete.dep.current_back', { render: left[left.length - 1] }) : msg('delete.dep.current_none'));
      out.edits.push({ type: 'page_current', page: owner, render: id });
    }
  }
  // The image, its lettered versions, its review, and the records that made it.
  for (const name of listDir(dir)) {
    if (name === `${path.basename(file)}` || name.startsWith(`${id}.lettered.`)) out.remove.push(`${dirRel}/${name}`);
  }
  const reviewRel = S.ws.rel(root, S.ws.reviewFile(root, id));
  if (exists(root, reviewRel)) out.remove.push(reviewRel);
  const records = recordsFor(root, owner, { media: [S.ws.rel(root, file)], render: id });
  out.remove.push(...records.remove);
  out.edits.push({ type: 'records', trim: records.trim });
  return out;
}

function planUpload(project, id, ctx) {
  const out = baseView('upload', id);
  const entry = project.upload(id);
  if (!entry) throw new HttpError(404, 'upload_not_found', 'There is no upload with that id.');
  out.label = entry.name;
  if (entry.kind === 'image') out.image = { url: `/api/projects/${project.id}/uploads/${entry.id}`, path: null };
  out.undo = 'none';
  const busy = (ctx.activeJobs || []).find((j) => JSON.stringify(j.params || {}).includes(`"${id}"`));
  if (busy) {
    out.refused = refuse('upload_in_job', { job: busy.id });
    return out;
  }
  out.edits.push({ type: 'upload', id });
  out.notes.push(msg('delete.note.upload'));
  return out;
}

function planEdition(project, id) {
  const root = project.root;
  const out = baseView('edition', id);
  const doc = attempt(() => S.ws.loadEdition(root, id), null);
  if (!doc && !exists(root, `editions/${id}`)) throw new HttpError(404, 'edition_not_found', `${id} is not an edition of this project.`);
  out.label = (doc && doc.title) || id;
  if (doc && doc.status && doc.status !== 'draft') {
    out.refused = refuse('edition_published', { status: doc.status });
    return out;
  }
  const later = attempt(() => S.ws.listEditions(root), []).filter((e) => e !== id && (attempt(() => S.ws.loadEdition(root, e), null) || {}).supersedes === id);
  if (later.length) {
    out.refused = refuse('edition_superseded_by', { editions: later.join(', ') });
    return out;
  }
  out.remove.push(`editions/${id}`);
  return out;
}

function planEntity(project, id, ctx) {
  const root = project.root;
  const out = baseView('entity', id);
  const type = id.split('_')[0];
  const dirRel = `${ENTITY_DIRS[type]}/${id}`;
  if (!exists(root, `${dirRel}/${ENTITY_FILES[type]}`)) throw new HttpError(404, 'entity_not_found', `${id} does not exist in this project.`);
  const doc = attempt(() => S.ws.loadYaml(S.ws.abs(root, `${dirRel}/${ENTITY_FILES[type]}`)), null) || {};
  out.label = doc.name || id;
  // Pages, scenes and covers that name it: it cannot go while they do.
  const re = idRe(id);
  const users = new Set();
  for (const f of ctx.pageFiles) if (f.role === 'page' && re.test(readText(S.ws.abs(root, f.rel)))) users.add(f.owner);
  for (const issue of attempt(() => S.ws.listIssues(root), [])) {
    for (const scene of attempt(() => S.ws.listScenes(root, issue), [])) {
      if (re.test(readText(scene.file))) users.add(scene.id);
    }
  }
  if (users.size) {
    out.refused = refuse('entity_in_use', { users: [...users].sort().slice(0, 12).join(', ') });
    return out;
  }
  const masters = [...ctx.assets.values()].filter((a) => a && a.entity === id && a.status === 'approved');
  if (masters.length) {
    out.confirm_twice = true;
    out.dependents.push(msg('delete.dep.entity_sheets', { n: masters.length }));
  }
  const bible = attempt(() => S.ws.loadYaml(S.ws.abs(root, 'story/story-bible.yaml')), null) || {};
  if ((Array.isArray(bible.characters) ? bible.characters : []).some((c) => c && c.id === id)
    || (Array.isArray(bible.facts) ? bible.facts : []).some((f) => f && Array.isArray(f.affects) && f.affects.includes(id))) {
    out.notes.push(msg('delete.note.bible_keeps', { entity: id }));
  }
  out.remove.push(dirRel);
  if (exists(root, `generations/${id}`)) out.remove.push(`generations/${id}`);
  out.edits.push({ type: 'manifest_entity', entity: id });
  out.edits.push({ type: 'entity_mentions', entity: id });
  out.edits.push({ type: 'sheet_checks', ids: [id] });
  return out;
}

function planPage(project, id, ctx) {
  const root = project.root;
  const out = baseView('page', id);
  const issue = S.ws.issueOfPage(id);
  const page = attempt(() => S.ws.loadPage(root, id), null);
  if (!page && !fs.existsSync(S.ws.pageDir(root, id))) throw new HttpError(404, 'page_not_found', `${id} does not exist in this project.`);
  const ids = S.ws.listPageIds(root, issue);
  if (ids[ids.length - 1] !== id) {
    out.refused = refuse('page_not_last', { last: ids[ids.length - 1] });
    return out;
  }
  const shipping = editionsShipping(root, { page: id });
  if (shipping.length) {
    out.refused = refuse('page_in_edition', { editions: shipping.map((e) => e.id).join(', ') });
    return out;
  }
  const renders = S.ws.listRenders(root, id);
  for (const r of renders) {
    const cited = citedBy(root, r, { ownPage: id, cache: ctx.pageFiles });
    const others = [...cited.drawnFrom, ...cited.planned];
    if (others.length) {
      out.refused = refuse('render_reference', { pages: others.join(', ') });
      return out;
    }
  }
  if (renders.length) {
    out.confirm_twice = true;
    out.dependents.push(msg('delete.dep.page_renders', { n: renders.length }));
  }
  const current = page && page.current_render ? S.ws.renderFile(root, page.current_render) : null;
  if (current) out.image = files.image(project, S.ws.rel(root, current));
  out.remove.push(S.ws.rel(root, S.ws.pageDir(root, id)));
  if (exists(root, `generations/${id}`)) out.remove.push(`generations/${id}`);
  out.edits.push({ type: 'page_links', page: id, issue });
  return out;
}

const PLANNERS = { asset: planAsset, render: planRender, upload: planUpload, edition: planEdition, entity: planEntity, page: planPage };

function context(project, services) {
  const root = project.root;
  return {
    assets: attempt(() => S.ws.loadReferenceAssets(root), new Map()),
    pageFiles: pageFiles(root),
    activeJobs: services && services.jobs ? services.jobs.list(project, { active: true }) : [],
  };
}

/** What deleting each item would do, or why it is refused. Nothing is written. */
function plan(project, services, items) {
  const ctx = context(project, services);
  const out = [];
  const seen = new Set();
  for (const raw of items) {
    const item = checkItem(raw);
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const view = PLANNERS[item.kind](project, item.id, ctx);
    // A job working on this right now: wait for it.
    const running = ctx.activeJobs.find((j) => j.status === 'running' && j.op !== 'chat.turn' && JSON.stringify(j.params || {}).includes(String(view.entity || view.owner || item.id)));
    if (!view.refused && running && item.kind !== 'upload') view.refused = refuse('job_running', { job: running.id });
    out.push(view);
  }
  return out;
}

/** The view of a plan the API returns: without the internal edit list. */
function publicView(p) {
  return {
    kind: p.kind,
    id: p.id,
    label: p.label,
    image: p.image,
    status: p.status || null,
    // For a plain label on the screens: the entity and sheet of an image, the page or cover of a version.
    entity: p.entity || null,
    sheet: p.sheet || null,
    version: p.version || (/_V\d{2}$/.test(p.id) ? parseInt(p.id.slice(-2), 10) : null),
    owner: p.owner || null,
    deletable: !p.refused,
    refused: p.refused,
    confirm_twice: p.confirm_twice,
    dependents: p.dependents,
    notes: p.notes,
    files: p.remove,
    undo: p.undo,
  };
}

// --- apply ---------------------------------------------------------------------------

function rewriteYaml(root, rel, mutate) {
  const file = S.ws.abs(root, rel);
  if (!fs.existsSync(file)) return false;
  if (S.yamlEdit) return S.yamlEdit.rewriteYamlFile(file, mutate).changed;
  const doc = S.yaml.parse(fs.readFileSync(file, 'utf8'));
  mutate(doc);
  fs.writeFileSync(file, S.yaml.stringify(doc));
  return true;
}

function applyEdit(project, edit, touched) {
  const root = project.root;
  const mark = (rel, changed) => { if (changed) touched.add(rel); };
  switch (edit.type) {
    case 'records':
      for (const t of edit.trim || []) {
        mark(t.rel, rewriteYaml(root, t.rel, (doc) => {
          doc.media_files = (Array.isArray(doc.media_files) ? doc.media_files : []).filter((m) => !t.media.includes(String(m).replace(/\\/g, '/')));
        }));
      }
      break;
    case 'manifest':
      mark('references/manifest.yaml', rewriteYaml(root, 'references/manifest.yaml', (doc) => {
        if (Array.isArray(doc.assets)) doc.assets = doc.assets.filter((a) => !a || !edit.ids.includes(a.id));
      }));
      break;
    case 'manifest_entity':
      mark('references/manifest.yaml', rewriteYaml(root, 'references/manifest.yaml', (doc) => {
        if (Array.isArray(doc.assets)) doc.assets = doc.assets.filter((a) => !a || a.entity !== edit.entity);
      }));
      break;
    case 'entity_refs': {
      if (!edit.entity || edit.entity.startsWith('LOOK_')) break;
      const type = edit.entity.split('_')[0];
      const base = `${ENTITY_DIRS[type]}/${edit.entity}`;
      mark(`${base}/${ENTITY_FILES[type]}`, rewriteYaml(root, `${base}/${ENTITY_FILES[type]}`, (doc) => {
        if (Array.isArray(doc.references)) doc.references = doc.references.filter((r) => !edit.ids.includes(r));
      }));
      if (type === 'CHAR') {
        mark(`${base}/wardrobe.yaml`, rewriteYaml(root, `${base}/wardrobe.yaml`, (doc) => {
          for (const o of Array.isArray(doc.outfits) ? doc.outfits : []) {
            if (o && Array.isArray(o.references)) o.references = o.references.filter((r) => !edit.ids.includes(r));
          }
        }));
      }
      break;
    }
    case 'look_refs':
      mark('project.yaml', rewriteYaml(root, 'project.yaml', (doc) => {
        if (doc.style && Array.isArray(doc.style.look_refs)) doc.style.look_refs = doc.style.look_refs.filter((r) => !edit.ids.includes(r));
      }));
      break;
    case 'sheet_checks': {
      const checks = Object.assign({}, project.state().sheet_checks || {});
      let changed = false;
      for (const key of Object.keys(checks)) {
        if (edit.ids.some((id) => key === id || key.startsWith(`${id}_`))) {
          delete checks[key];
          changed = true;
        }
      }
      if (changed) project.saveState({ sheet_checks: checks });
      break;
    }
    case 'entity_mentions': {
      // Other characters that said they could be confused with it, and doors that led to it.
      for (const id of attempt(() => S.ws.listEntityIds(root, 'characters'), [])) {
        const rel = `characters/${id}/character.yaml`;
        mark(rel, rewriteYaml(root, rel, (doc) => {
          if (Array.isArray(doc.visually_adjacent_to)) doc.visually_adjacent_to = doc.visually_adjacent_to.filter((x) => x !== edit.entity);
        }));
      }
      if (edit.entity.startsWith('LOC_')) {
        for (const id of attempt(() => S.ws.listEntityIds(root, 'locations'), [])) {
          const rel = `locations/${id}/map.yaml`;
          mark(rel, rewriteYaml(root, rel, (doc) => {
            for (const exit of Array.isArray(doc.exits) ? doc.exits : []) if (exit && exit.leads_to === edit.entity) exit.leads_to = null;
          }));
        }
      }
      break;
    }
    case 'page_current': {
      const left = S.ws.listRenders(root, edit.page).filter((r) => r !== edit.render);
      const render = left[left.length - 1] || null;
      const review = render ? attempt(() => S.ws.loadReview(root, render), null) : null;
      const pageRel = `issues/${S.ws.issueOfPage(edit.page)}/pages/${edit.page}/page.yaml`;
      const hasPrompts = listDir(path.join(S.ws.pageDir(root, edit.page), 'prompts')).some((n) => /\.ya?ml$/i.test(n));
      const status = render ? (review && S.ws.reviewPasses(review) ? 'reviewed' : 'rendered') : (hasPrompts ? 'prompted' : 'scripted');
      mark(pageRel, rewriteYaml(root, pageRel, (doc) => {
        doc.current_render = render;
        doc.status = status;
      }));
      break;
    }
    case 'page_links': {
      const ids = S.ws.listPageIds(root, edit.issue).filter((p) => p !== edit.page);
      const prev = ids[ids.length - 1] || null;
      if (prev) {
        const rel = `issues/${edit.issue}/pages/${prev}/page.yaml`;
        mark(rel, rewriteYaml(root, rel, (doc) => {
          if (doc.continuity && doc.continuity.exits_to === edit.page) doc.continuity.exits_to = null;
        }));
      }
      const emptied = [];
      for (const scene of attempt(() => S.ws.listScenes(root, edit.issue), [])) {
        if (!scene.doc || !JSON.stringify(scene.doc).includes(edit.page)) continue;
        const rel = S.ws.rel(root, scene.file);
        const pages = (Array.isArray(scene.doc.pages) ? scene.doc.pages : []).filter((p) => p !== edit.page);
        if (!pages.length) {
          fs.rmSync(scene.file, { force: true });
          touched.add(rel);
          emptied.push(scene.id);
          continue;
        }
        mark(rel, rewriteYaml(root, rel, (doc) => {
          doc.pages = pages;
          doc.beats = (Array.isArray(doc.beats) ? doc.beats : [])
            .map((b) => Object.assign({}, b, { pages: (Array.isArray(b.pages) ? b.pages : []).filter((p) => p !== edit.page) }))
            .filter((b) => b.pages.length);
        }));
      }
      const issueRel = `issues/${edit.issue}/issue.yaml`;
      let panels = 0;
      for (const p of ids) {
        const doc = attempt(() => S.ws.loadPage(root, p), null);
        panels += doc && Array.isArray(doc.panels) ? doc.panels.length : 0;
      }
      mark(issueRel, rewriteYaml(root, issueRel, (doc) => {
        if (typeof doc.page_count === 'number') doc.page_count = ids.length;
        if (typeof doc.panel_count === 'number') doc.panel_count = panels;
        if (Array.isArray(doc.scenes)) doc.scenes = doc.scenes.filter((s) => !emptied.includes(s));
      }));
      mark('story/series-plan.yaml', rewriteYaml(root, 'story/series-plan.yaml', (doc) => {
        const entry = Array.isArray(doc.issues) ? doc.issues.find((i) => i && i.id === edit.issue) : null;
        if (entry && typeof entry.page_budget === 'number' && entry.page_budget > ids.length) entry.page_budget = Math.max(1, ids.length);
      }));
      const approvals = Object.assign({}, project.state().plan_approvals || {});
      if (approvals[edit.page]) {
        delete approvals[edit.page];
        project.saveState({ plan_approvals: approvals });
      }
      attempt(() => assumptions.save(project, [edit.page], [], null), null);
      break;
    }
    case 'upload':
      project.removeUpload(edit.id);
      break;
    default:
      break;
  }
}

/**
 * Delete what the plans say. The caller has checked that none is refused.
 * @returns {{deleted: object[], files: string[], check: object}}
 */
function apply(project, plans) {
  const root = project.root;
  const previous = check.before(root);
  const touched = new Set();
  for (const p of plans) {
    for (const rel of p.remove) {
      fs.rmSync(S.ws.abs(root, rel), { recursive: true, force: true });
      touched.add(rel);
    }
    for (const edit of p.edits) applyEdit(project, edit, touched);
  }
  return {
    deleted: plans.map((p) => ({ kind: p.kind, id: p.id, label: p.label, files: p.remove.length, undo: p.undo })),
    files: [...touched].sort(),
    check: check.after(root, previous),
  };
}

// --- clean up ------------------------------------------------------------------------

/** The unused tries of a screen, each deletable now: [{ kind, id, label, image, reason }]. */
function cleanup(project, services, scope) {
  const root = project.root;
  const text = String(scope || '');
  const candidates = [];
  const assets = attempt(() => S.ws.loadReferenceAssets(root), new Map());
  const entityTries = (entity) => {
    const agg = require('./aggregates');
    const set = attempt(() => agg.entityAssets(project, entity), { masters: [], candidates: [] });
    const bySheet = new Map();
    for (const c of set.candidates.filter((x) => !x.promoted_to)) {
      if (!bySheet.has(c.sheet)) bySheet.set(c.sheet, []);
      bySheet.get(c.sheet).push(c);
    }
    for (const [sheet, list] of bySheet) {
      const hasMaster = set.masters.some((m) => m.sheet === sheet && m.status === 'approved');
      list.sort((a, b) => a.version - b.version);
      // The newest try of a sheet with no master is still waiting for a decision: it stays.
      const old = hasMaster ? list : list.slice(0, -1);
      for (const c of old) candidates.push({ kind: 'asset', id: c.id, reason: hasMaster ? 'not_chosen' : 'older_try' });
    }
    for (const m of set.masters.filter((x) => x.status === 'superseded')) candidates.push({ kind: 'asset', id: m.id, reason: 'superseded' });
  };
  const issueTries = (issue) => {
    for (const entry of attempt(() => S.ws.listPages(root, issue), [])) {
      const current = entry.doc && entry.doc.current_render;
      for (const r of attempt(() => S.ws.listRenders(root, entry.id), [])) {
        if (r !== current) candidates.push({ kind: 'render', id: r, reason: 'old_version' });
      }
    }
  };
  const coverTries = (issue) => {
    const cover = attempt(() => S.ws.loadCover(root, issue), null) || {};
    const renders = attempt(() => S.ws.listCoverRenders(root, issue), []);
    const keep = cover.approved_render || renders[renders.length - 1];
    for (const r of renders) if (r !== keep) candidates.push({ kind: 'render', id: r, reason: 'old_version' });
  };
  const editionTries = (issue) => {
    const list = attempt(() => S.ws.listEditions(root), []).filter((e) => e.startsWith(`ED_${issue.slice(4)}_`));
    for (const e of list.slice(0, -1)) {
      const doc = attempt(() => S.ws.loadEdition(root, e), null) || {};
      if ((doc.status || 'draft') === 'draft') candidates.push({ kind: 'edition', id: e, reason: 'old_draft' });
    }
  };
  let m;
  if ((m = /^(character|location|prop):((?:CHAR|LOC|PROP)_[A-Z][A-Z0-9_]*)$/.exec(text))) entityTries(m[2]);
  else if (text === 'characters') for (const id of attempt(() => S.ws.listEntityIds(root, 'characters'), [])) entityTries(id);
  else if (text === 'places') {
    for (const id of attempt(() => S.ws.listEntityIds(root, 'locations'), [])) entityTries(id);
    for (const id of attempt(() => S.ws.listEntityIds(root, 'props'), [])) entityTries(id);
  } else if (text === 'style') {
    const looks = new Set([...assets.values()].filter((a) => a && /^LOOK_/.test(String(a.entity || ''))).map((a) => a.entity));
    const state = attempt(() => require('./ops/shared').lookState(project), {});
    if (state.lookId) looks.add(state.lookId);
    for (const id of looks) entityTries(id);
  } else if ((m = /^(?:pages|issue|check|corrections):(ISS_\d{3})$/.exec(text))) issueTries(m[1]);
  else if ((m = /^cover:(ISS_\d{3})$/.exec(text))) coverTries(m[1]);
  else if ((m = /^publish:(ISS_\d{3})$/.exec(text))) editionTries(m[1]);
  else throw new HttpError(400, 'bad_params', '"scope" must be characters, places, style, character:<ID>, location:<ID>, prop:<ID>, pages:<ISS>, cover:<ISS> or publish:<ISS>.');
  if (!candidates.length) return [];
  const plans = plan(project, services, candidates);
  return plans.filter((p) => !p.refused && !p.confirm_twice).map((p) => Object.assign(publicView(p), {
    reason: msg(`cleanup.reason.${(candidates.find((c) => c.id === p.id) || {}).reason || 'old_version'}`),
  }));
}

module.exports = { KINDS, kindOf, checkItem, plan, publicView, apply, cleanup, citedBy, editionsShipping };
