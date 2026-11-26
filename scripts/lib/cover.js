'use strict';
/**
 * Cover helpers shared by compile-prompts.js, generate-assets.js,
 * validate-workspace.js and build-edition.js, so they agree on what a cover
 * is. Shape: docs/data-model.md ("cover"). Layout: issues/<ISS_ID>/cover/
 * holds cover.yaml, prompts/, renders/ and reviews/, like a page directory.
 *
 * A cover has no panels and sits outside the panel ledger. Wherever a
 * prompt package, a generation record or a review names its `page`, the
 * cover's files name the cover ID (CV_001).
 */

const fs = require('fs');
const util = require('util');
const ws = require('./workspace');
const yaml = require('./yaml');
const { hashObject } = require('../../providers/lib/common');

/**
 * Review checks that never apply to a cover: they judge the panel ledger and
 * the sequence, and a cover has neither. A cover review records them as
 * not_applicable.
 */
const NOT_APPLICABLE_CHECKS = ['position', 'movement', 'role_causality'];

/** Cover lettering fields in the order they are listed in a prompt. */
const LETTERING_FIELDS = [
  { key: 'title', label: 'Title, the largest text on the cover' },
  { key: 'issue_line', label: 'Issue line, small, close to the title' },
  { key: 'tagline', label: 'Tagline, smaller than the title' },
  { key: 'credits', label: 'Credit line, small, along the bottom' },
];

function coverError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** in_image | overlay: the cover's own mode, else the project's. */
function letteringMode(cover, project) {
  const own = cover && cover.lettering && cover.lettering.mode;
  if (own === 'in_image' || own === 'overlay') return own;
  return project && project.lettering && project.lettering.mode === 'overlay' ? 'overlay' : 'in_image';
}

/** The cover's text, in prompt order: [{ key, label, text }]. Empty fields are left out. */
function letteringElements(cover) {
  const lettering = (cover && cover.lettering) || {};
  return LETTERING_FIELDS
    .map((field) => ({ key: field.key, label: field.label, text: lettering[field.key] }))
    .filter((el) => typeof el.text === 'string' && el.text.trim().length > 0)
    .map((el) => Object.assign(el, { text: String(el.text) }));
}

/**
 * Hash of the parts of cover.yaml a prompt depends on. `status` and
 * `approved_render` change with approval, not with what is drawn.
 */
function hashCover(cover) {
  const copy = Object.assign({}, cover);
  delete copy.status;
  delete copy.approved_render;
  return hashObject(copy);
}

function versionOf(renderId) {
  const m = /_V(\d{2})$/.exec(String(renderId));
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * The next free render ID of a cover: one above the highest version found
 * among the render files and the review files, so a number is never reused.
 */
function nextRenderId(root, coverId) {
  let max = 0;
  for (const id of ws.listCoverRenders(root, coverId)) max = Math.max(max, versionOf(id));
  for (const review of ws.listCoverReviews(root, coverId)) {
    if (ws.coverOfRender(review.render) === coverId) max = Math.max(max, versionOf(review.render));
  }
  if (max >= 99) throw coverError('render_versions_exhausted', `${coverId} already has 99 render versions`);
  return `${coverId}_V${String(max + 1).padStart(2, '0')}`;
}

/**
 * New text of cover.yaml with `status` and `approved_render` set. Only those
 * two top-level lines change, which keeps comments and formatting; the
 * result is accepted only when it parses to exactly the intended document.
 * Otherwise the document goes through the YAML library.
 * @returns {{text: string, preserved: boolean}}
 */
function coverText(originalText, cover) {
  try {
    const lines = String(originalText).split(/\r?\n/);
    const set = (key, value) => {
      const at = lines.findIndex((line) => new RegExp(`^${key}:(\\s|$)`).test(line));
      const comment = at === -1 ? null : /\s(#.*)$/.exec(lines[at]);
      const text = `${key}: ${value === null ? 'null' : value}${comment ? `  ${comment[1]}` : ''}`;
      if (at === -1) {
        while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
        lines.push(text);
      } else {
        lines[at] = text;
      }
    };
    set('status', cover.status);
    set('approved_render', cover.approved_render);
    const text = `${lines.join('\n').trimEnd()}\n`;
    if (util.isDeepStrictEqual(yaml.parse(text), cover)) return { text, preserved: true };
  } catch (err) {
    // Fall through to the full rewrite.
  }
  return { text: yaml.stringify(cover), preserved: false };
}

/**
 * Approve a cover render: set cover.yaml to `status: approved` with
 * `approved_render`. Like a page in an edition, the render needs a review
 * with verdict pass or fixed. The render file is not touched; an earlier
 * approved render stays on disk.
 *
 * @param {{root: string, issue: string, render: string}} options
 *   `issue` is the ISS_### (or the CV_### of the cover).
 * @returns {{cover: string, render: string, file: string, previous: string|null, preserved: boolean}}
 *   `file` is the workspace-relative path of cover.yaml; `previous` is the
 *   render that was approved before, if any.
 * @throws an Error with `code` when the cover, the render or a passing
 *   review is missing
 */
function approveCover(options = {}) {
  const root = options.root;
  const issueId = ws.ID.issue.test(String(options.issue)) ? String(options.issue) : ws.issueOfCover(options.issue);
  if (!root || !issueId) {
    throw coverError('bad_arguments', 'approveCover needs { root, issue: "ISS_###", render: "CV_###_V##" }');
  }
  const coverId = ws.coverIdOfIssue(issueId);
  const file = ws.coverFile(root, issueId);
  const cover = ws.loadCover(root, issueId);
  if (!cover || typeof cover !== 'object') {
    throw coverError('cover_missing', `${issueId} has no cover: issues/${issueId}/cover/cover.yaml not found`);
  }
  const renderId = String(options.render || '');
  if (ws.coverOfRender(renderId) !== coverId) {
    throw coverError('render_mismatch', `"${renderId}" is not a render of ${coverId} (expected ${coverId}_V##)`);
  }
  if (!ws.coverRenderFile(root, renderId)) {
    throw coverError('render_missing', `${renderId}: no image under issues/${issueId}/cover/renders/`);
  }
  const review = ws.loadReview(root, renderId);
  if (!ws.reviewPasses(review)) {
    throw coverError('review_required',
      `${renderId} cannot be approved: ${review ? `its review verdict is ${review.verdict || 'missing'}` : 'it has no review'}. ` +
      'A cover render is approved only after a review with verdict pass or fixed.');
  }
  const previous = cover.status === 'approved' && cover.approved_render ? String(cover.approved_render) : null;
  const next = Object.assign({}, cover, { status: 'approved', approved_render: renderId });
  const updated = coverText(fs.readFileSync(file, 'utf8'), next);
  fs.writeFileSync(file, updated.text);
  return {
    cover: coverId,
    render: renderId,
    file: ws.rel(root, file),
    previous: previous && previous !== renderId ? previous : null,
    preserved: updated.preserved,
  };
}

module.exports = {
  NOT_APPLICABLE_CHECKS,
  LETTERING_FIELDS,
  letteringMode,
  letteringElements,
  hashCover,
  nextRenderId,
  coverText,
  approveCover,
};
