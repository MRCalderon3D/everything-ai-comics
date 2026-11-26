'use strict';
/**
 * Change requests from a person, recorded as review findings.
 *
 * A person who reads a rendered page and wants something changed does not
 * write a review. Their request still has to reach the repair pipeline, and
 * the repair pipeline reads findings. addUserRequest() appends the request
 * to the review of that render as a finding with `source: user_request`,
 * optionally tied to a panel and to a region of the page, and sets the
 * verdict to `flagged`. `compile-prompts.js --repair` then picks it up with
 * the reviewer's own findings (selectRepairFindings below).
 *
 * A render that has no review yet gets one, opened by the request: every
 * check and both gates are recorded as `not_performed`, because nobody has
 * judged them. Such a review can only be `flagged`. /visual-review fills in
 * the checks later and keeps the request.
 *
 * The same call works for a cover render (CV_001_V01): the review file is
 * resolved through reviewFileOf(), which goes through scripts/lib/workspace.js.
 */

const fs = require('fs');
const path = require('path');
const ws = require('./workspace');
const yaml = require('./yaml');
const edit = require('./yaml-edit');
const { pipelineError, dateStamp, validateDoc } = require('./page-pipeline');

const CHECK_KEYS = [
  'identity', 'cast_count', 'position', 'movement', 'role_causality', 'object_identity',
  'object_custody', 'physical_state', 'wardrobe', 'spatial_logic', 'drawing_clarity',
  'lettering', 'page_structure', 'style_fidelity',
];
const SEVERITIES = ['blocking', 'minor'];
const USER_REQUEST = 'user_request';
/** What a repair prompt prints as the failed check of a request that names none. */
const REQUEST_CHECK_LABEL = 'user_request';
const NOT_PERFORMED_EVIDENCE =
  'Not judged. This review was opened by a change request before a reviewer looked at the render.';
const COVER_NOT_APPLICABLE_EVIDENCE = 'A cover has no panel ledger and no sequence for this check to judge.';

/** Cover checks that never apply; read from the cover helpers when they are installed. */
function coverNotApplicable() {
  try {
    const list = require('./cover').NOT_APPLICABLE_CHECKS;
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
}

/** What a render belongs to: { kind: 'page' | 'cover', id } or null. */
function ownerOfRender(renderId) {
  const pageId = ws.pageOfRender(renderId);
  if (pageId) return { kind: 'page', id: pageId };
  const coverId = typeof ws.coverOfRender === 'function' ? ws.coverOfRender(renderId) : null;
  return coverId ? { kind: 'cover', id: coverId } : null;
}

/**
 * Path of the review of a render (the file may not exist). The one place
 * this module asks where reviews live, for pages and covers alike.
 */
function reviewFileOf(root, renderId) {
  return ws.reviewFile(root, renderId);
}

function isUserRequest(finding) {
  return Boolean(finding) && finding.source === USER_REQUEST;
}

/**
 * The findings a repair addresses: the open blocking ones (or every open
 * finding when none is blocking), plus every open user request whatever its
 * severity, in file order. A request that names no check is returned as a
 * copy whose `check` reads "user_request", which is what the repair prompt
 * prints; the review file is not changed.
 */
function selectRepairFindings(review) {
  const open = (Array.isArray(review && review.findings) ? review.findings : [])
    .filter((f) => f && f.status === 'open');
  const blocking = open.filter((f) => f.severity === 'blocking');
  const base = blocking.length ? blocking : open;
  return open
    .filter((f) => base.includes(f) || isUserRequest(f))
    .map((f) => (isUserRequest(f) && !f.check ? Object.assign({}, f, { check: REQUEST_CHECK_LABEL }) : f));
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/** A clean { x, y, w, h } in fractions of the page, or an error naming the problem. */
function normalizeRegion(region) {
  if (region === undefined || region === null) return null;
  if (typeof region !== 'object' || Array.isArray(region)) {
    throw pipelineError('bad_arguments', 'region must be an object { x, y, w, h } in fractions of the page');
  }
  const out = {};
  for (const key of ['x', 'y', 'w', 'h']) {
    const value = Number(region[key]);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw pipelineError('bad_arguments', `region.${key} must be a number from 0 to 1 (a fraction of the page), got ${JSON.stringify(region[key])}`);
    }
    out[key] = round4(value);
  }
  if (out.w <= 0 || out.h <= 0) throw pipelineError('bad_arguments', 'region.w and region.h must be greater than 0');
  if (out.x + out.w > 1.0001 || out.y + out.h > 1.0001) {
    throw pipelineError('bad_arguments', 'region reaches past the page: x + w and y + h must not exceed 1');
  }
  out.w = round4(Math.min(out.w, 1 - out.x));
  out.h = round4(Math.min(out.h, 1 - out.y));
  return out;
}

function nextFindingId(findings) {
  let max = 0;
  for (const f of findings) {
    const m = /^F(\d{2})$/.exec(String(f && f.id));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  if (max >= 99) throw pipelineError('findings_exhausted', 'the review already has 99 findings');
  return `F${String(max + 1).padStart(2, '0')}`;
}

/**
 * Where a render with no review stands in the repair count: when the request
 * that produced it was a repair, it supersedes the edited render and its
 * cycle is that render's cycle plus one. Otherwise it is a first render.
 */
function lineageOf(root, owner, renderId) {
  const first = { supersedes: null, repair_cycle: 0 };
  const dir = path.join(root, 'generations', owner.id);
  if (!fs.existsSync(dir)) return first;
  for (const name of fs.readdirSync(dir).filter((n) => /^GEN_.*\.ya?ml$/i.test(n)).sort().reverse()) {
    let record;
    try {
      record = ws.loadYaml(path.join(dir, name));
    } catch (err) {
      continue;
    }
    if (!record || record.output_render !== renderId) continue;
    const requestFile = path.join(dir, name.replace(/\.ya?ml$/i, '.request.json'));
    if (!fs.existsSync(requestFile)) return first;
    try {
      const meta = JSON.parse(fs.readFileSync(requestFile, 'utf8')).meta || {};
      if (meta.mode !== 'repair' || !meta.edit_target) return first;
      const parent = path.basename(String(meta.edit_target)).replace(/\.[^.]+$/, '');
      if (!ownerOfRender(parent) || ownerOfRender(parent).id !== owner.id || parent === renderId) return first;
      const parentReview = ws.loadYaml(reviewFileOf(root, parent));
      const cycle = parentReview && Number.isInteger(parentReview.repair_cycle) ? parentReview.repair_cycle : 0;
      return { supersedes: parent, repair_cycle: cycle + 1 };
    } catch (err) {
      return first;
    }
  }
  return first;
}

/** A review opened by a request: nothing judged, verdict flagged. */
function openReview(root, owner, renderId, now) {
  const lineage = lineageOf(root, owner, renderId);
  const skip = owner.kind === 'cover' ? coverNotApplicable() : [];
  const checks = {};
  for (const key of CHECK_KEYS) {
    checks[key] = skip.includes(key)
      ? { result: 'not_applicable', evidence: COVER_NOT_APPLICABLE_EVIDENCE }
      : { result: 'not_performed', evidence: NOT_PERFORMED_EVIDENCE };
  }
  return {
    page: owner.id,
    render: renderId,
    supersedes: lineage.supersedes,
    reviewer: 'human',
    independent: true,
    compared_against: { references: [], neighbors: [] },
    checks,
    findings: [],
    gates: { style_fidelity: 'not_performed', narrative_continuity: 'not_performed' },
    verdict: 'flagged',
    repair_cycle: lineage.repair_cycle,
    reviewed_at: dateStamp(now),
    human_approval: { status: 'pending', by: null, at: null },
    notes: 'Opened by a change request. The checks and the gates have not been judged; a visual review fills them in.',
  };
}

function setTopLevel(file, changes) {
  return edit.rewriteYamlFile(file, (doc) => {
    Object.assign(doc, changes);
  }, (lines) => {
    for (const [key, value] of Object.entries(changes)) {
      const range = edit.findKey(lines, key, 0);
      if (!range || !edit.setValue(lines, range, value)) return false;
    }
    return true;
  });
}

/**
 * A flagged review cannot stay the passing review a page or a cover relies
 * on, so the page falls back to `rendered` and the cover to `draft`.
 * @returns {{file: string, from: string, to: string}|null}
 */
function withdrawStatus(root, owner, renderId) {
  if (owner.kind === 'page') {
    const file = path.join(ws.pageDir(root, owner.id), 'page.yaml');
    const page = ws.loadYaml(file);
    if (!page || page.current_render !== renderId || !['reviewed', 'approved'].includes(page.status)) return null;
    setTopLevel(file, { status: 'rendered' });
    return { file: ws.rel(root, file), from: page.status, to: 'rendered' };
  }
  const file = typeof ws.coverFile === 'function' ? ws.coverFile(root, owner.id) : null;
  const cover = file ? ws.loadYaml(file) : null;
  if (!cover || cover.status !== 'approved' || cover.approved_render !== renderId) return null;
  setTopLevel(file, { status: 'draft', approved_render: null });
  return { file: ws.rel(root, file), from: 'approved', to: 'draft' };
}

/**
 * Record a person's change request on a render.
 *
 * @param {object} options
 * @param {string} options.root Workspace root.
 * @param {string} [options.page] Page ID of the render (or the cover ID for a
 *   cover render). Optional: the render ID already names it. When given it
 *   must match.
 * @param {string} options.render Render ID: PG_001_002_V01, or CV_001_V01 for a cover.
 * @param {string} options.text What the person wants changed, in their words.
 * @param {string|null} [options.panel] Panel ID the request is about, or null for the whole page.
 * @param {{x: number, y: number, w: number, h: number}} [options.region]
 *   The area the request is about, in fractions of the page from its top-left corner.
 * @param {string} [options.check] One of the fourteen check keys, when the
 *   request clearly belongs to one (`lettering` unlocks the lettering in the repair).
 * @param {'minor'|'blocking'} [options.severity] Default minor.
 * @param {string} [options.visible] What the person sees now, when they said it.
 * @param {Date} [options.now] Clock, for tests.
 * @returns {{reviewFile: string, finding: object, created: boolean, verdict: 'flagged',
 *   statusChange: {file: string, from: string, to: string}|null}}
 *   `reviewFile` is absolute. `created` is true when the render had no review.
 *   `statusChange` reports a page that fell back to `rendered` (or a cover to
 *   `draft`) because its current render is flagged again.
 * @throws an Error with `code` on a bad argument or a render that is not on disk.
 */
function addUserRequest(options = {}) {
  if (!options.root) throw pipelineError('bad_arguments', 'root is required: the workspace directory that holds project.yaml');
  const root = path.resolve(String(options.root));
  if (!fs.existsSync(path.join(root, 'project.yaml'))) {
    throw pipelineError('workspace_missing', `${root} has no project.yaml: not a workspace root`);
  }
  const renderId = String(options.render || '');
  const owner = ownerOfRender(renderId);
  if (!owner) {
    throw pipelineError('bad_arguments', `render must be a page render (PG_001_002_V01) or a cover render (CV_001_V01), got "${renderId}"`);
  }
  if (options.page && String(options.page) !== owner.id) {
    throw pipelineError('bad_arguments', `${renderId} is a render of ${owner.id}, not of ${options.page}`);
  }
  const text = String(options.text === undefined || options.text === null ? '' : options.text).replace(/\s+/g, ' ').trim();
  if (!text) throw pipelineError('bad_arguments', 'text is required: what the person wants changed');
  if (!ws.renderFile(root, renderId)) {
    throw pipelineError('render_missing', `${renderId} is not on disk: a change request needs the image it is about`);
  }

  const panel = options.panel ? String(options.panel) : null;
  if (panel) {
    if (owner.kind === 'cover') throw pipelineError('bad_arguments', 'a cover has no panels: leave panel out');
    const page = ws.loadPage(root, owner.id);
    const panels = page && Array.isArray(page.panels) ? page.panels.map((p) => p && p.id) : [];
    if (!panels.includes(panel)) {
      throw pipelineError('bad_arguments', `${panel} is not a panel of ${owner.id} (${panels.join(', ') || 'no panels'})`);
    }
  }
  const region = normalizeRegion(options.region);
  const check = options.check ? String(options.check) : null;
  if (check && !CHECK_KEYS.includes(check)) {
    throw pipelineError('bad_arguments', `check must be one of ${CHECK_KEYS.join(', ')}, got "${check}"`);
  }
  const severity = options.severity ? String(options.severity) : 'minor';
  if (!SEVERITIES.includes(severity)) {
    throw pipelineError('bad_arguments', `severity must be minor or blocking, got "${severity}"`);
  }

  const reviewFile = reviewFileOf(root, renderId);
  const existingText = fs.existsSync(reviewFile) ? fs.readFileSync(reviewFile, 'utf8') : null;
  const created = existingText === null;
  const review = created ? openReview(root, owner, renderId, options.now) : yaml.parse(existingText);
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    throw pipelineError('review_invalid', `${ws.rel(root, reviewFile)} is not a review document`);
  }
  // Schema problems the file already had are not this call's to refuse over.
  const knownErrors = created ? [] : validateDoc('visual-review', review).errors;
  if (!Array.isArray(review.findings)) review.findings = [];

  const where = panel ? 'panel' : region ? 'marked area' : (owner.kind === 'cover' ? 'cover' : 'page');
  const finding = { id: nextFindingId(review.findings), panel, source: USER_REQUEST };
  if (check) finding.check = check;
  if (region) finding.region = region;
  Object.assign(finding, {
    expected: `The requested change shows in the ${where}, and nothing else differs.`,
    visible: options.visible && String(options.visible).trim()
      ? String(options.visible).replace(/\s+/g, ' ').trim()
      : `The ${where} as drawn in ${renderId}, before the requested change.`,
    severity,
    repair: text,
    status: 'open',
  });
  review.findings.push(finding);
  review.verdict = 'flagged';
  // The person asking for a change has not accepted the render as it stands.
  if (review.human_approval && review.human_approval.status === 'approved') {
    review.human_approval = { status: 'pending', by: null, at: null };
  }

  const newErrors = validateDoc('visual-review', review).errors.filter((e) => !knownErrors.includes(e));
  if (newErrors.length) {
    throw pipelineError('schema_violation',
      `${ws.rel(root, reviewFile)} would violate visual-review.schema.json: ${newErrors.slice(0, 5).join('; ')}`);
  }

  const header = created
    ? '# Schema: schemas/visual-review.schema.json\n# Opened by a change request. No reviewer has judged this render yet.\n\n'
    : edit.leadingComments(existingText);
  fs.mkdirSync(path.dirname(reviewFile), { recursive: true });
  fs.writeFileSync(reviewFile, header + yaml.stringify(review));

  const statusChange = withdrawStatus(root, owner, renderId);
  return { reviewFile, finding, created, verdict: 'flagged', statusChange };
}

module.exports = {
  CHECK_KEYS,
  USER_REQUEST,
  addUserRequest,
  selectRepairFindings,
  isUserRequest,
  normalizeRegion,
  reviewFileOf,
  ownerOfRender,
};
