'use strict';
/**
 * Approvals: decisions only the person makes. They are plain API calls, not
 * jobs. Each one is committed and logged like any other step.
 *
 *   asset  a candidate sheet or look page becomes a master (approve-asset.js;
 *          a look master also freezes the style block)
 *   plan   the page plans a person has read, before any drawing
 *   page   a rendered page, after its review
 *   cover  a rendered cover, after its review
 *
 * A review verdict is the reviewer's reading of the image. Approval is the
 * person's decision and is recorded apart from it. When the person disagrees
 * with a flagged review they may overrule it: the open findings are recorded
 * as accepted by the person, the review says so, and the evidence stays.
 */

const fs = require('fs');
const S = require('./scaffold');
const pipeline = require('./pipeline');
const { HttpError, nowIso, today } = require('./util');

function conflict(err, fallback = 'approval_refused') {
  if (err instanceof HttpError) return err;
  return new HttpError(409, typeof err.code === 'string' ? err.code : fallback, err.message);
}

/** Promote a candidate to a master. */
function approveAsset(project, body) {
  const candidate = typeof body.candidate === 'string' ? body.candidate.trim() : '';
  if (!candidate || candidate.includes('\0') || candidate.includes('..')) {
    throw new HttpError(400, 'bad_params', '"candidate" is required: a candidate ID such as CHAR_MARTA_TURN_V01, or its workspace path.');
  }
  try {
    return S.approveAsset({
      root: project.root,
      candidate,
      note: typeof body.note === 'string' ? body.note.slice(0, 1000) : undefined,
      supersede: body.supersede === true,
      by: 'person',
    });
  } catch (err) {
    throw conflict(err);
  }
}

/** Record (or withdraw) the person's approval of page plans. */
function approvePlans(project, body) {
  const root = project.root;
  if (!Array.isArray(body.pages) || !body.pages.length) {
    throw new HttpError(400, 'bad_params', '"pages" must be a list of page IDs.');
  }
  const approvals = Object.assign({}, project.state().plan_approvals);
  const out = [];
  for (const id of body.pages.map(String)) {
    const page = S.ws.ID.page.test(id) ? S.ws.loadPage(root, id) : null;
    if (!page) throw new HttpError(404, 'page_not_found', `${id} does not exist in this project.`);
    if (body.approved === false) delete approvals[id];
    else approvals[id] = { hash: S.pipeline.hashPage(page), at: nowIso() };
    out.push({ page: id, approved: body.approved !== false });
  }
  project.saveState({ plan_approvals: approvals });
  return { pages: out };
}

/**
 * Let the person's decision settle a flagged review. Open findings become
 * accepted (a blocking one is first recorded as minor, with a note that the
 * person overruled it), failed gates become pass, and the verdict follows
 * the review rules again.
 * @returns {object} the updated review document
 */
function overrule(root, renderId, note) {
  const file = S.ws.reviewFile(root, renderId);
  const review = S.ws.loadReview(root, renderId);
  if (!review) throw new HttpError(409, 'no_review', `${renderId} has no review yet. Check it first.`);
  const unjudged = Object.values(review.checks || {}).some((c) => c && c.result === 'not_performed') ||
    Object.values(review.gates || {}).includes('not_performed');
  if (unjudged) {
    throw new HttpError(409, 'review_incomplete', `Nobody has checked ${renderId} yet. Run the check first, then decide.`);
  }
  const overruled = [];
  for (const finding of Array.isArray(review.findings) ? review.findings : []) {
    if (!finding || finding.status !== 'open') continue;
    if (finding.severity === 'blocking') {
      finding.severity = 'minor';
      overruled.push(`${finding.id} (recorded as blocking by the reviewer)`);
    } else {
      overruled.push(finding.id);
    }
    finding.status = 'accepted';
  }
  for (const gate of Object.keys(review.gates || {})) {
    if (review.gates[gate] === 'fail') {
      review.gates[gate] = 'pass';
      overruled.push(`gate ${gate}`);
    }
  }
  const findings = Array.isArray(review.findings) ? review.findings : [];
  review.verdict = findings.length ? 'fixed' : 'pass';
  if (!findings.length) {
    // A pass needs every check to pass: a failed check with no finding becomes an accepted finding.
    for (const [key, check] of Object.entries(review.checks || {})) {
      if (check && check.result === 'fail') {
        findings.push({
          id: `F${String(findings.length + 1).padStart(2, '0')}`, panel: null, check: key,
          expected: `The ${key.replace(/_/g, ' ')} check passes.`, visible: check.evidence,
          severity: 'minor', repair: 'None: accepted by the person.', status: 'accepted',
        });
      }
    }
    review.findings = findings;
    if (findings.length) review.verdict = 'fixed';
  }
  if (overruled.length) {
    const line = `Overruled by the person on ${today()}: ${overruled.join(', ')} accepted as drawn.${note ? ` Their note: ${String(note).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`;
    review.notes = [review.notes, line].filter(Boolean).join(' ');
  }
  const problems = S.schemaFindings('visual-review', review);
  if (problems.length) {
    throw new HttpError(409, 'review_invalid', `The review could not be updated: ${problems[0].path} ${problems[0].message}`);
  }
  const header = S.yamlEdit ? S.yamlEdit.leadingComments(fs.readFileSync(file, 'utf8')) : '';
  fs.writeFileSync(file, header + S.yaml.stringify(review));
  return review;
}

/**
 * Record the person's approval on a review. Approving a render that passed
 * with notes accepts those notes: its open minor findings become accepted.
 * @returns {string[]} ids of the findings accepted by this approval
 */
function setHumanApproval(root, renderId, status) {
  const file = S.ws.reviewFile(root, renderId);
  const review = S.ws.loadReview(root, renderId);
  if (!review) return [];
  review.human_approval = { status, by: 'person', at: today() };
  const accepted = [];
  if (status === 'approved' && S.ws.reviewPasses(review)) {
    for (const finding of Array.isArray(review.findings) ? review.findings : []) {
      if (finding && finding.status === 'open' && finding.severity === 'minor' && finding.source !== 'user_request') {
        finding.status = 'accepted';
        accepted.push(finding.id);
      }
    }
  }
  const header = S.yamlEdit ? S.yamlEdit.leadingComments(fs.readFileSync(file, 'utf8')) : '';
  fs.writeFileSync(file, header + S.yaml.stringify(review));
  return accepted;
}

/** Approve a rendered page. `overrule: true` is needed when its review is flagged. */
function approvePage(project, body) {
  const root = project.root;
  const pageId = String(body.page || '');
  const page = S.ws.ID.page.test(pageId) ? S.ws.loadPage(root, pageId) : null;
  if (!page) throw new HttpError(404, 'page_not_found', `${pageId} does not exist in this project.`);
  const render = body.render ? String(body.render) : (page.current_render || null);
  if (!render || S.ws.pageOfRender(render) !== pageId || !S.ws.renderFile(root, render)) {
    throw new HttpError(409, 'no_render', `${pageId} has no render to approve.`);
  }
  let review = S.ws.loadReview(root, render);
  if (!review) throw new HttpError(409, 'no_review', `${render} has no review yet. Check it first.`);
  let overruled = false;
  if (!S.ws.reviewPasses(review)) {
    if (body.overrule !== true) {
      const open = (review.findings || []).filter((f) => f && f.status === 'open');
      throw new HttpError(409, 'review_flagged',
        `The check of ${render} is flagged with ${open.length} open finding(s). Ask for a correction, or approve it anyway with "overrule": true.`,
        { findings: open.map((f) => ({ id: f.id, severity: f.severity, expected: f.expected, visible: f.visible })) });
    }
    review = overrule(root, render, body.note);
    overruled = true;
  }
  const accepted = setHumanApproval(root, render, 'approved');
  pipeline.setPageState(root, pageId, { status: 'approved', current_render: render });
  return { page: pageId, render, verdict: review.verdict, overruled, accepted_notes: accepted, status: 'approved' };
}

/** Approve a rendered cover (cover.yaml: status approved, approved_render). */
function approveCover(project, body) {
  const root = project.root;
  const issue = String(body.issue || 'ISS_001');
  if (!S.ws.ID.issue.test(issue) || !S.ws.loadCover(root, issue)) {
    throw new HttpError(404, 'no_cover', `${issue} has no cover in this project.`);
  }
  const renders = S.ws.listCoverRenders(root, issue);
  const render = body.render ? String(body.render) : renders[renders.length - 1];
  if (!render || !renders.includes(render)) throw new HttpError(409, 'no_render', 'The cover has no render to approve.');
  let review = S.ws.loadReview(root, render);
  if (!review) throw new HttpError(409, 'no_review', `${render} has no review yet. Check it first.`);
  let overruled = false;
  if (!S.ws.reviewPasses(review)) {
    if (body.overrule !== true) {
      const open = (review.findings || []).filter((f) => f && f.status === 'open');
      throw new HttpError(409, 'review_flagged',
        `The check of ${render} is flagged with ${open.length} open finding(s). Ask for a correction, or approve it anyway with "overrule": true.`,
        { findings: open.map((f) => ({ id: f.id, severity: f.severity, expected: f.expected, visible: f.visible })) });
    }
    review = overrule(root, render, body.note);
    overruled = true;
  }
  let result;
  try {
    result = S.approveCover({ root, issue, render });
  } catch (err) {
    throw conflict(err);
  }
  const accepted = setHumanApproval(root, render, 'approved');
  return { issue, cover: result.cover, render, previous: result.previous, verdict: review.verdict, overruled, accepted_notes: accepted, status: 'approved' };
}

module.exports = { approveAsset, approvePlans, approvePage, approveCover, overrule };
