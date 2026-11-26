'use strict';
/**
 * A change the person asks for on a rendered page or cover. Shared by
 * page.correct and cover.correct. Not an operation itself.
 *
 * Two paths, and the job says which one it took:
 *
 * - "edit": the request is recorded as a finding on the review of the
 *   render (source: user_request), a repair package is compiled, and the
 *   existing image is edited into a sibling version. The request counts
 *   toward repair_cycle like any repair.
 * - "redraw": the lineage has reached project.repair_policy.max_cycles, and
 *   compile-prompts.js refuses another repair. By the scaffold's
 *   repair-limits rule the fix then goes into the plan: the request is
 *   applied to page.yaml (or cover.yaml) by the planning driver, a fresh
 *   generate package is compiled, and a new render starts a new lineage at
 *   repair_cycle 0. The review checks the requested change in it.
 *
 * The limit is never raised and never bypassed.
 */

const S = require('../scaffold');
const pipeline = require('../pipeline');
const { runAi } = require('../ai');
const { OpError } = require('../jobs');
const { renderReviewRepair, requireDrawTool } = require('./shared');

const PATH_LABELS = {
  edit: 'edited the existing image',
  redraw: 'redrew it from an updated plan',
};

/** The scaffold's own repair limit (project.repair_policy.max_cycles, default 2). */
function scaffoldLimit(root) {
  const doc = S.ws.loadProject(root) || {};
  return doc.repair_policy && Number.isInteger(doc.repair_policy.max_cycles) ? doc.repair_policy.max_cycles : 2;
}

/** Which path a correction of this render takes right now. */
function pathFor(root, render) {
  const review = S.ws.loadReview(root, render);
  const cycle = review && Number.isInteger(review.repair_cycle) ? review.repair_cycle : 0;
  return cycle >= scaffoldLimit(root) ? 'redraw' : 'edit';
}

/** Step list for a correction, known when the job is created. */
function steps(what, path) {
  if (path === 'redraw') {
    return [
      { id: 'request', label: 'Record the request' },
      { id: 'plan', label: `Repair limit reached: put the change into the plan of ${what}` },
      { id: 'compile', label: 'Prepare a fresh drawing' },
      { id: 'draw', label: `Redraw ${what} from the updated plan` },
      { id: 'review', label: `Check the new ${what.replace(/^the /, '')}` },
    ];
  }
  return [
    { id: 'request', label: 'Record the request' },
    { id: 'compile', label: 'Prepare the correction' },
    { id: 'draw', label: `Edit the existing ${what.replace(/^the /, '')}` },
    { id: 'review', label: `Check the corrected ${what.replace(/^the /, '')}` },
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
  const compileRepair = (review) => (isCover
    ? pipeline.compileCover(root, spec.owner.issue, target.provider, { repair: review, model: target.model || undefined })
    : pipeline.compilePage(root, spec.owner.id, target.provider, { repairReview: review, model: target.model || undefined }));

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

  let path = pathFor(root, spec.render);
  let compiled = null;
  if (path === 'edit') {
    try {
      compiled = await ctx.step('compile', (h) => {
        const result = compileRepair(S.ws.loadReview(root, spec.render));
        for (const warning of result.warnings || []) h.log(`warning: ${warning}`);
        return { file: result.file, package: result.rel };
      });
    } catch (err) {
      if (err.code !== 'repair_limit') throw err;
      // The scaffold refused: the lineage is at its limit after all.
      path = 'redraw';
      const compileStep = ctx.job.steps.find((s) => s.id === 'compile');
      if (compileStep) {
        compileStep.status = 'pending';
        compileStep.note = null;
      }
    }
  }

  if (path === 'edit') {
    const outcome = await renderReviewRepair(ctx, {
      owner: spec.owner,
      prefix: '',
      label: 'Correction',
      compileGenerate: () => ({ file: compiled.file }),
      compileRepair,
      supersedes: spec.render,
      fakeText: spec.text,
    });
    return Object.assign({ from: spec.render, finding: request.finding, path, path_label: PATH_LABELS[path] }, outcome);
  }

  // Redraw: the change goes into the plan, then a fresh render starts a new lineage.
  ctx.addStep({ id: 'plan', label: `Repair limit reached: put the change into the plan of ${spec.what}` }, { after: 'request' });
  ctx.log(`${spec.render} has used its ${scaffoldLimit(root)} repair cycle(s): the change goes into the plan and ${spec.what} is drawn again`);
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
          description: `${spec.text}\n\nThe cover has used its repair cycles and is drawn again from this file: write the change into the concept, the composition or the cast so that a fresh drawing shows it.`,
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
    label: 'Redraw',
    compileGenerate: () => ({ file: fresh.file }),
    compileRepair,
    supersedes: null,
    requests: [spec.text],
    replaces: spec.render,
    lineageNote: `Drawn again from an updated plan: ${spec.render} had reached the repair limit, so this render starts a new lineage.`,
    fakeText: spec.text,
  });
  return Object.assign({ from: spec.render, finding: request.finding, path, path_label: PATH_LABELS[path] }, outcome);
}

module.exports = { run, steps, pathFor, scaffoldLimit, PATH_LABELS };
