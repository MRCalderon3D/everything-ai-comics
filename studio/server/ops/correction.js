'use strict';
/**
 * A change the person asks for on a rendered page or cover. Shared by
 * page.correct and cover.correct. Not an operation itself.
 *
 * Two paths, and the job says which one it took:
 *
 * - "edit" (a touch-up): the request is recorded as a finding on the review
 *   of the render (source: user_request), a repair package is compiled, and
 *   the existing image is edited into a sibling version. Every edit counts
 *   toward repair_cycle.
 * - "redraw": the request is applied to page.yaml (or cover.yaml) by the
 *   planning driver, a fresh generate package is compiled, and a new render
 *   starts a new lineage at repair_cycle 0. The review checks the requested
 *   change in it.
 *
 * Who picks the path (rules/common/repair-limits.md): below the project's
 * touch-up warning (project.repair_policy.touch_up_warning, default 2) a
 * correction is a touch-up. At or past it the person chooses between
 * "touch up anyway" (mode touch_up) and "redraw the whole page with the
 * change" (mode redraw); without a choice the request is refused with the
 * warning, never decided for them. A touch-up the person chose may go past
 * project.repair_policy.max_cycles, which only stops the automatic repairs:
 * the automatic repairs that follow it keep that limit, so no loop runs on
 * its own.
 */

const S = require('../scaffold');
const pipeline = require('../pipeline');
const projectOptions = require('../project-options');
const { msg } = require('../i18n');
const { runAi } = require('../ai');
const { OpError } = require('../jobs');
const { HttpError } = require('../util');
const { renderReviewRepair, requireDrawTool } = require('./shared');

/** What the result says about the path taken, for the person. */
const PATH_LABELS = {
  edit: msg('path.edit'),
  redraw: msg('path.redraw'),
};

/** The choices a person has once an image reached the warning. */
const MODES = ['touch_up', 'redraw'];

/** The scaffold's limit on automatic repairs (project.repair_policy.max_cycles, default 2). */
function scaffoldLimit(root) {
  const doc = S.ws.loadProject(root) || {};
  return doc.repair_policy && Number.isInteger(doc.repair_policy.max_cycles) ? doc.repair_policy.max_cycles : 2;
}

/** Edits of one image after which a touch-up comes with the warning (default 2). */
function touchUpWarning(root) {
  return projectOptions.touchUpWarning(S.ws.loadProject(root) || {});
}

/** How many times this image has been edited: the repair_cycle of its review. */
function touchUps(root, render) {
  const review = S.ws.loadReview(root, render);
  return review && Number.isInteger(review.repair_cycle) ? review.repair_cycle : 0;
}

/**
 * Which path a correction of this render takes: "edit", "redraw", or null
 * when the image is at the warning and the person has not chosen.
 */
function pathFor(root, render, mode) {
  if (mode === 'redraw') return 'redraw';
  if (mode === 'touch_up') return 'edit';
  return touchUps(root, render) >= touchUpWarning(root) ? null : 'edit';
}

/** The mode param: undefined, or one of MODES. */
function checkMode(params) {
  if (params.mode === undefined || params.mode === null || params.mode === '') return undefined;
  if (!MODES.includes(params.mode)) {
    throw new HttpError(400, 'bad_params', `"mode" must be ${MODES.join(' or ')}.`);
  }
  return params.mode;
}

/**
 * The path of a correction being validated, or the 409 that asks the person
 * to choose (its details carry the count and the warning, for the form and
 * the chat card).
 */
function choosePath(root, render, mode, kind) {
  const path = pathFor(root, render, mode);
  if (path) return path;
  const n = touchUps(root, render);
  const warning = touchUpWarning(root);
  throw new HttpError(409, 'touch_up_choice',
    `${render} has had ${n} touch-up(s), the warning set for this project (repair_policy.touch_up_warning ${warning}). ` +
    'More edits may degrade the image. Send mode "touch_up" to edit it anyway, or mode "redraw" to draw it again with the change in its plan.',
    { render, touch_ups: n, warning, kind, modes: MODES }, { n, warning });
}

/** Step list for a correction, known when the job is created. */
function steps(kind, path) {
  const what = kind === 'cover' ? 'cover' : 'page';
  if (path === 'redraw') {
    return [
      { id: 'request', label: msg('step.correct.request') },
      { id: 'plan', label: msg(`step.correct.plan.${what}`) },
      { id: 'compile', label: msg('step.correct.compile.redraw') },
      { id: 'draw', label: msg(`step.correct.draw.redraw.${what}`) },
      { id: 'review', label: msg(`step.correct.review.redraw.${what}`) },
    ];
  }
  return [
    { id: 'request', label: msg('step.correct.request') },
    { id: 'compile', label: msg('step.correct.compile.edit') },
    { id: 'draw', label: msg(`step.correct.draw.edit.${what}`) },
    { id: 'review', label: msg(`step.correct.review.edit.${what}`) },
  ];
}

/**
 * Run a correction.
 * @param {object} ctx job context
 * @param {{owner: {kind: 'page'|'cover', id: string, issue: string}, render: string, text: string,
 *          panel?: string|null, region?: object|null, lettering?: boolean, what: string}} spec
 */
async function run(ctx, spec) {
  const { project } = ctx;
  const root = project.root;
  const target = requireDrawTool(ctx);
  const isCover = spec.owner.kind === 'cover';
  // The automatic repairs after the touch-up keep the scaffold's limit; only
  // the person's own touch-up is compiled past it (touchUp).
  const compileRepair = (review, options = {}) => (isCover
    ? pipeline.compileCover(root, spec.owner.issue, target.provider, { repair: review, model: target.model || undefined, touchUp: options.touchUp })
    : pipeline.compilePage(root, spec.owner.id, target.provider, { repairReview: review, model: target.model || undefined, touchUp: options.touchUp }));

  const request = await ctx.step('request', () => {
    let result;
    try {
      result = S.addUserRequest({
        root,
        render: spec.render,
        text: spec.text,
        panel: spec.panel || undefined,
        region: spec.region || undefined,
        check: spec.lettering ? 'lettering' : undefined,
      });
    } catch (err) {
      throw new OpError(err.code || 'request_failed', err.message);
    }
    return { finding: result.finding.id, review: S.ws.rel(root, result.reviewFile) };
  });

  // The path was settled when the job was created (the person's choice at the warning).
  const path = spec.path === 'redraw' ? 'redraw' : 'edit';
  let compiled = null;
  if (path === 'edit') {
    const n = touchUps(root, spec.render);
    if (n >= touchUpWarning(root)) ctx.log(`${spec.render} has had ${n} touch-up(s), at or past the warning: the person chose to touch it up anyway`);
    compiled = await ctx.step('compile', (h) => {
      const result = compileRepair(S.ws.loadReview(root, spec.render), { touchUp: true });
      for (const warning of result.warnings || []) h.log(`warning: ${warning}`);
      return { file: result.file, package: result.rel };
    });
  }

  if (path === 'edit') {
    const outcome = await renderReviewRepair(ctx, {
      owner: spec.owner,
      prefix: '',
      kind: 'correction',
      compileGenerate: () => ({ file: compiled.file }),
      compileRepair,
      supersedes: spec.render,
      fakeText: spec.text,
    });
    return Object.assign({ from: spec.render, finding: request.finding, path, path_label: PATH_LABELS[path] }, outcome);
  }

  // Redraw: the change goes into the plan, then a fresh render starts a new lineage.
  ctx.addStep({ id: 'plan', label: msg(`step.correct.plan.${isCover ? 'cover' : 'page'}`) }, { after: 'request' });
  ctx.log(`the person chose a redraw of ${spec.render}: the change goes into the plan and it is drawn again`);
  const old = S.ws.loadReview(root, spec.render);
  const open = (old && Array.isArray(old.findings) ? old.findings : [])
    .filter((f) => f && f.status === 'open' && f.source !== 'user_request');
  await ctx.step('plan', async (h) => {
    if (isCover) {
      await runAi(ctx, h, {
        verb: 'plan',
        kind: 'cover.write',
        vars: {
          issue: spec.owner.issue,
          update: true,
          description: `${spec.text}\n\nThe person chose to have the cover drawn again from this file rather than edit the image once more: write the change into the concept, the composition or the cast so that a fresh drawing shows it.`,
          provider: target.provider,
        },
        fakeText: spec.text,
      });
    } else {
      await runAi(ctx, h, {
        verb: 'plan',
        kind: 'page.revise',
        vars: {
          page: spec.owner.id,
          issue: spec.owner.issue,
          request: spec.text,
          plan_file: pipeline.planFileOf(root, spec.owner),
          findings: open.map((f) => `- ${f.id}: expected ${f.expected} Visible: ${f.visible}`).join('\n'),
        },
        fakeText: spec.text,
      });
    }
    return { updated: S.ws.rel(root, pipeline.planFileOf(root, spec.owner)) };
  }, { verb: 'plan' });

  const fresh = await ctx.step('compile', (h) => {
    let result;
    if (isCover) {
      result = pipeline.compileCover(root, spec.owner.issue, target.provider, { model: target.model || undefined });
    } else {
      pipeline.buildPlan(root, spec.owner.id, target.provider);
      result = pipeline.compilePage(root, spec.owner.id, target.provider, { model: target.model || undefined });
    }
    for (const warning of result.warnings || []) h.log(`warning: ${warning}`);
    return { file: result.file, package: result.rel };
  });

  const outcome = await renderReviewRepair(ctx, {
    owner: spec.owner,
    prefix: '',
    kind: 'correction',
    compileGenerate: () => ({ file: fresh.file }),
    compileRepair,
    supersedes: null,
    requests: [spec.text],
    replaces: spec.render,
    lineageNote: msg('review.note.redrawn', { render: spec.render }),
    fakeText: spec.text,
  });
  return Object.assign({ from: spec.render, finding: request.finding, path, path_label: PATH_LABELS[path] }, outcome);
}

module.exports = { run, steps, pathFor, choosePath, checkMode, scaffoldLimit, touchUpWarning, touchUps, PATH_LABELS, MODES };
