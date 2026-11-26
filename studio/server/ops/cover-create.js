'use strict';
/**
 * cover.create: the optional cover of an issue. Three cases:
 *
 * - no cover yet: the cover is written (from the description, or proposed
 *   by the AI when there is none), then compiled, drawn and reviewed;
 * - a cover exists and a description is given: cover.yaml is rewritten from
 *   it, then drawn and reviewed;
 * - a cover exists and no description is given: the cover is drawn as it is
 *   written. The write step is not part of the job, so a cover the person
 *   edited by hand is drawn without the AI touching it.
 *
 * The drawing has the same automatic repair as a page. Command: cover.
 * Approval is a separate call (POST /approve/cover).
 */

const S = require('../scaffold');
const pipeline = require('../pipeline');
const { msg } = require('../i18n');
const { runAi } = require('../ai');
const { OpError } = require('../jobs');
const { HttpError } = require('../util');
const { str, bool, matching, requireIssue, lookState, renderReviewRepair, ISSUE_RE } = require('./shared');

module.exports = {
  name: 'cover.create',
  params: [
    { name: 'issue', type: 'string', required: false, description: 'Issue ID. Default ISS_001.' },
    { name: 'description', type: 'string', required: false, description: 'What the cover shows. Empty with no cover yet: the AI proposes one. Empty with a cover already written: that cover is drawn as it is.' },
    { name: 'draw', type: 'boolean', required: false, description: 'Draw the cover after writing it (default true).' },
  ],

  validate(params, { project }) {
    const issue = matching(params, 'issue', ISSUE_RE, { required: false, what: 'an issue ID such as ISS_001' }) || 'ISS_001';
    requireIssue(project, issue);
    if (!S.has('scripts/compile-prompts.js', 'compileCover')) {
      throw new HttpError(501, 'scaffold_missing', 'The scaffold has no cover support yet.');
    }
    const description = str(params, 'description', { max: 8000 });
    const draw = bool(params, 'draw', true);
    // With a cover already written and nothing new to say, the job draws it as written.
    const write = !!description || !S.ws.loadCover(project.root, issue);
    if (!write && !draw) {
      throw new HttpError(409, 'nothing_to_do', 'The cover is already written and "draw" is false: there is nothing to do.');
    }
    return { issue, description, draw, write };
  },

  steps(params) {
    return [
      ...(params.write ? [{ id: 'write', label: msg('step.cover.write') }] : []),
      ...(params.draw ? [
        { id: 'compile', label: msg('step.cover.compile') },
        { id: 'draw', label: msg('step.cover.draw') },
        { id: 'review', label: msg('step.cover.review') },
      ] : []),
    ];
  },

  async run(ctx) {
    const { project, params } = ctx;
    const root = project.root;
    const issue = params.issue;
    const provider = pipeline.compileProvider(project, ctx.services.drivers);
    const existing = S.ws.loadCover(root, issue);

    let written = { summary: null, decisions: [], tool: null };
    if (params.write) {
      written = await ctx.step('write', async (h) => {
        const result = await runAi(ctx, h, {
          verb: 'plan',
          kind: 'cover.write',
          vars: {
            issue,
            create: !existing,
            update: !!existing,
            description: params.description,
            propose: !params.description,
            provider,
          },
          fakeText: params.description,
        });
        if (!S.ws.loadCover(root, issue)) throw new OpError('cover_missing', 'The cover file was not written.');
        return { summary: result.summary, decisions: result.decisions, tool: result.tool };
      }, { verb: 'plan' });
    } else if (!existing) {
      throw new OpError('cover_missing', 'The cover file is gone.');
    }
    const base = { issue, written: params.write, summary: written.summary, decisions: written.decisions };

    if (!params.draw) return Object.assign(base, { drawn: false });

    const target = pipeline.drawTarget(ctx);
    const skip = (reason) => {
      for (const id of ['compile', 'draw', 'review']) ctx.skipStep(id, reason);
      return Object.assign(base, { drawn: false, reason });
    };
    if (!lookState(project).master) return skip(msg('skip.look_not_approved.cover'));
    if (!target.available) return skip(msg('skip.no_draw_tool.cover', { reason: target.reason }));

    const compiled = await ctx.step('compile', (h) => {
      const result = pipeline.compileCover(root, issue, target.provider, { model: target.model || undefined });
      for (const warning of result.warnings || []) h.log(`warning: ${warning}`);
      return { file: result.file, package: result.rel };
    });
    const outcome = await renderReviewRepair(ctx, {
      owner: { kind: 'cover', id: S.ws.coverIdOfIssue(issue), issue },
      prefix: '',
      kind: 'cover',
      compileGenerate: () => ({ file: compiled.file }),
      compileRepair: (review) => pipeline.compileCover(root, issue, target.provider, { repair: review, model: target.model || undefined }),
      fakeText: params.description,
    });
    return Object.assign(base, { drawn: true }, outcome);
  },
};
