'use strict';
/**
 * Helpers shared by the operations: parameter checks, uploads, the
 * reference registry, and the draw-review-repair loop for a page or a cover.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const S = require('../scaffold');
const pipeline = require('../pipeline');
const { OpError, isCancel, NeedsDecision } = require('../jobs');
const { HttpError, today, toPosix } = require('../util');

const ISSUE_RE = /^ISS_\d{3}$/;
const PAGE_RE = /^PG_\d{3}_\d{3}$/;
const PANEL_RE = /^PN_\d{3}_\d{3}_\d{2}$/;
const ENTITY_RE = /^(CHAR|LOC|PROP|LOOK)_[A-Z][A-Z0-9_]*$/;
const CHAR_RE = /^CHAR_[A-Z][A-Z0-9_]*$/;
const RENDER_RE = /^(PG_\d{3}_\d{3}|CV_\d{3})_V\d{2}$/;

// --- parameters -----------------------------------------------------------------

function bad(message, details) {
  return new HttpError(400, 'bad_params', message, details);
}

/** A trimmed string parameter. Throws 400 when required and empty, or too long. */
function str(params, name, { required = false, max = 20000 } = {}) {
  const value = params[name];
  if (value === undefined || value === null || String(value).trim() === '') {
    if (required) throw bad(`"${name}" is required.`);
    return '';
  }
  if (typeof value !== 'string') throw bad(`"${name}" must be text.`);
  if (value.length > max) throw bad(`"${name}" is longer than ${max} characters.`);
  return value.trim();
}

function int(params, name, { min, max, fallback }) {
  const value = params[name];
  if (value === undefined || value === null || value === '') return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw bad(`"${name}" must be a whole number from ${min} to ${max}.`);
  return value;
}

function bool(params, name, fallback = false) {
  const value = params[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw bad(`"${name}" must be true or false.`);
  return value;
}

function matching(params, name, pattern, { required = true, what = 'an ID' } = {}) {
  const value = params[name];
  if (value === undefined || value === null || value === '') {
    if (required) throw bad(`"${name}" is required.`);
    return null;
  }
  if (typeof value !== 'string' || !pattern.test(value)) throw bad(`"${name}" must be ${what}.`);
  return value;
}

/** A list of upload ids that exist in the project, of the given kind. */
function uploadIds(params, name, project, kind) {
  const value = params[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 12) throw bad(`"${name}" must be a list of at most 12 upload ids.`);
  for (const id of value) {
    const entry = typeof id === 'string' ? project.upload(id) : null;
    if (!entry) throw bad(`"${name}" names an upload that does not exist: ${String(id).slice(0, 60)}.`);
    if (kind && entry.kind !== kind) throw bad(`Upload ${entry.name} is a ${entry.kind} file; "${name}" takes ${kind} files.`);
  }
  return value.slice();
}

function requireIssue(project, issueId) {
  if (!S.ws.loadIssue(project.root, issueId) && !S.ws.listIssues(project.root).includes(issueId)) {
    throw new HttpError(404, 'issue_not_found', `${issueId} does not exist in this project.`);
  }
}

function requirePage(project, pageId) {
  const page = S.ws.loadPage(project.root, pageId);
  if (!page) throw new HttpError(404, 'page_not_found', `${pageId} does not exist in this project.`);
  return page;
}

// --- the reference registry -------------------------------------------------------

function manifestFile(root) {
  return path.join(root, 'references', 'manifest.yaml');
}

/** Add an entry to references/manifest.yaml, keeping the comment block at its top. */
function registerAsset(root, entry) {
  const file = manifestFile(root);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    text = '';
  }
  const doc = (text && S.yaml.parse(text)) || {};
  if (!Array.isArray(doc.assets)) doc.assets = [];
  if (doc.assets.some((a) => a && a.id === entry.id)) throw new OpError('asset_exists', `${entry.id} is already registered.`);
  doc.assets.push(entry);
  const header = S.yamlEdit ? S.yamlEdit.leadingComments(text) : '';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, header + S.yaml.stringify(doc));
}

/** The next free "<ENTITY>_REF_V##" ID: a reference image a person supplied. */
function nextReferenceId(root, entityId) {
  const assets = S.ws.loadReferenceAssets(root);
  const dir = S.ws.abs(root, S.assetPaths.refsDir(entityId));
  const pattern = new RegExp(`^${entityId}_REF_V(\\d{2})$`);
  let max = 0;
  for (const id of assets.keys()) {
    const m = pattern.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  try {
    for (const name of fs.readdirSync(dir)) {
      const m = pattern.exec(name.replace(/\.[^.]+$/, ''));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch (err) {
    // no refs directory yet
  }
  return `${entityId}_REF_V${String(max + 1).padStart(2, '0')}`;
}

/**
 * File the images a person uploaded as references of an entity: copy each
 * into the entity's refs directory under the next <ENTITY>_REF_V## name and
 * register it. An upload is the person's own material, so it is registered
 * as approved when `approved` is true (it can then be attached to requests),
 * else as a draft that only informs the written description.
 * @returns {{id: string, path: string}[]}
 */
function fileReferenceUploads(project, entityId, ids, { role, kind, approved, note }) {
  const root = project.root;
  const out = [];
  for (const id of ids) {
    const upload = project.upload(id);
    if (!upload) continue;
    const buffer = fs.readFileSync(project.uploadFile(upload));
    const ext = path.extname(upload.name).toLowerCase().replace('.jpeg', '.jpg') || '.png';
    const assetId = nextReferenceId(root, entityId);
    const rel = `${S.assetPaths.refsDir(entityId)}/${assetId}${ext}`;
    const file = S.ws.abs(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer, { flag: 'wx' });
    registerAsset(root, {
      id: assetId,
      entity: entityId,
      kind,
      path: rel,
      status: approved ? 'approved' : 'draft',
      default_role: role,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      approved_by: approved ? 'person' : null,
      approved_at: approved ? today() : null,
      notes: `${note} Original file name: ${upload.name}. Licence and likeness rights are the person's responsibility and are not recorded here.`,
    });
    out.push({ id: assetId, path: rel });
  }
  return out;
}

/** The project's look: the ID being defined and its approved master, if any. */
function lookState(project) {
  const root = project.root;
  const doc = S.ws.loadProject(root) || {};
  const assets = S.ws.loadReferenceAssets(root);
  const listed = doc.style && Array.isArray(doc.style.look_refs) ? doc.style.look_refs : [];
  let master = null;
  for (const id of listed) {
    const asset = assets.get(id);
    if (asset && asset.status === 'approved') {
      master = asset;
      break;
    }
  }
  let lookId = project.state().look_id || null;
  if (master) lookId = master.entity;
  if (!lookId) {
    const any = [...assets.values()].find((a) => /^LOOK_/.test(String(a.entity || '')));
    if (any) lookId = any.entity;
  }
  return { lookId, master, frozen: !!master };
}

// --- draw, review, repair -----------------------------------------------------------

function fatalDrawError(err) {
  return ['no_tool', 'no_draw_tool'].includes(err && err.code) ||
    /binary not found|could not be started/i.test(String(err && err.message));
}

/**
 * Draw a page or a cover from its compiled package, review it, and repair it
 * while the review says a repair can fix it and the limit allows.
 *
 * @param {object} ctx job context
 * @param {{owner: {kind: 'page'|'cover', id: string, issue: string},
 *          prefix: string, label: string,
 *          compileGenerate: () => {file: string},
 *          compileRepair: (review: object) => {file: string},
 *          first?: {render: string, supersedes?: string|null},
 *          fakeText?: string}} job
 *   prefix: step id prefix ("PG_001_002:" or ""). `first`, when given, is a
 *   render that already exists and only needs its review (and repairs).
 * @returns {Promise<{render, verdict, passes, repairs, flagged, independent, stopped}>}
 */
async function renderReviewRepair(ctx, job) {
  const root = ctx.project.root;
  const limit = pipeline.repairLimit(ctx.project);
  const stepId = (name) => `${job.prefix}${name}`;
  let render;
  // A correction's first drawing already replaces the render it corrects.
  let supersedes = job.supersedes || null;

  if (job.first) {
    render = job.first.render;
    supersedes = job.first.supersedes || null;
  } else {
    const drawn = await ctx.step(stepId('draw'), async (h) => {
      h.setTool('codex');
      const pkg = job.compileGenerate();
      const result = await pipeline.draw(ctx, h, pkg.file);
      if (job.owner.kind === 'page') pipeline.setPageState(root, job.owner.id, { status: 'rendered', current_render: result.render });
      h.note(result.render);
      return result;
    }, { verb: 'draw' });
    render = drawn.render;
  }

  let review = await ctx.step(stepId('review'), (h) => pipeline.reviewRender(ctx, h, {
    render, supersedes, fakeText: job.fakeText, requests: job.requests, lineageNote: job.lineageNote, replaces: job.replaces,
  }), { verb: 'look' });
  let repairs = 0;
  let stopped = null;
  while (!review.passes) {
    if (!review.repairable) {
      stopped = 'The review says another render would repeat the problem: the cause is in the plan or the references.';
      break;
    }
    const doc = S.ws.loadReview(root, review.render);
    const cycle = doc && Number.isInteger(doc.repair_cycle) ? doc.repair_cycle : 0;
    if (cycle >= limit) {
      stopped = `The repair limit of ${limit} was reached.`;
      break;
    }
    repairs += 1;
    const n = cycle + 1;
    const from = review.render;
    const drawId = stepId(`repair-${n}`);
    const reviewId = stepId(`review-${n}`);
    ctx.addStep({ id: drawId, label: `${job.label}: repair ${n}` }, { after: n === 1 ? stepId('review') : stepId(`review-${n - 1}`) });
    ctx.addStep({ id: reviewId, label: `${job.label}: check repair ${n}` }, { after: drawId });
    const drawn = await ctx.step(drawId, async (h) => {
      h.setTool('codex');
      const pkg = job.compileRepair(S.ws.loadReview(root, from));
      const result = await pipeline.draw(ctx, h, pkg.file);
      if (job.owner.kind === 'page') pipeline.setPageState(root, job.owner.id, { status: 'rendered', current_render: result.render });
      h.note(result.render);
      return result;
    }, { verb: 'draw' });
    review = await ctx.step(reviewId, (h) => pipeline.reviewRender(ctx, h, { render: drawn.render, supersedes: from, fakeText: job.fakeText }), { verb: 'look' });
  }
  return {
    render: review.render,
    verdict: review.verdict,
    passes: review.passes,
    open_findings: review.open,
    repairs,
    flagged: !review.passes,
    independent: review.independent,
    stopped,
  };
}

/** Rethrow what must stop a whole job: a cancel, a pause for a decision, a missing tool. */
function rethrowIfFatal(err) {
  if (isCancel(err) || err instanceof NeedsDecision || fatalDrawError(err)) throw err;
}

/** The draw provider, or an OpError that tells the person what to do instead. */
function requireDrawTool(ctx) {
  const target = pipeline.drawTarget(ctx);
  if (!target.available) {
    throw new OpError('no_draw_tool',
      `${target.reason} Use the manual handoff instead: the studio prepares the prompt and the references, and you upload the image you made.`);
  }
  return target;
}

function relOf(root, file) {
  return toPosix(path.relative(root, file));
}

module.exports = {
  ISSUE_RE, PAGE_RE, PANEL_RE, ENTITY_RE, CHAR_RE, RENDER_RE,
  bad, str, int, bool, matching, uploadIds, requireIssue, requirePage,
  registerAsset, nextReferenceId, fileReferenceUploads, lookState,
  renderReviewRepair, rethrowIfFatal, requireDrawTool, fatalDrawError, relOf,
};
