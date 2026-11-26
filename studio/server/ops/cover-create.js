'use strict';
/**
 * cover.create: the optional cover of an issue. Writes cover.yaml from a
 * description (or lets the AI propose one), compiles it, draws it, and
 * reviews it, with the same automatic repair as a page.
 * Command: cover. Approval is a separate call (POST /approve/cover).
 */

const S = require('../scaffold');
const pipeline = require('../pipeline');
const { runAi } = require('../ai');
const { OpError } = require('../jobs');
const { HttpError } = require('../util');
const { str, bool, matching, requireIssue, lookState, renderReviewRepair, ISSUE_RE } = require('./shared');

module.exports = {
  name: 'cover.create',
  title: 'Make the cover',
  summary: 'Writes the cover of an issue from a description, or proposes one, then draws it and checks it.',
  params: [
    { name: 'issue', type: 'string', required: false, description: 'Issue ID. Default ISS_001.' },
    { name: 'description', type: 'string', required: false, description: 'What the cover shows. Empty: the AI proposes a cover.' },
    { name: 'draw', type: 'boolean', required: false, description: 'Draw the cover after writing it (default true).' },
  ],

  validate(params, { project }) {
    const issue = matching(params, 'issue', ISSUE_RE, { required: false, what: 'an issue ID such as ISS_001' }) || 'ISS_001';
    requireIssue(project, issue);
    if (!S.has('scripts/compile-prompts.js', 'compileCover')) {
      throw new HttpError(501, 'scaffold_missing', 'The scaffold has no cover support yet.');
    }
    return { issue, description: str(params, 'description', { max: 8000 }), draw: bool(params, 'draw', true) };
  },

  steps(params) {
    return [
      { id: 'write', label: 'Write the cover' },
      ...(params.draw ? [
        { id: 'compile', label: 'Prepare the cover' },
        { id: 'draw', label: 'Draw the cover' },
        { id: 'review', label: 'Check the cover' },
      ] : []),
    ];
  },

  async run(ctx) {
    const { project, params } = ctx;
    const root = project.root;
    const issue = params.issue;
    const provider = pipeline.compileProvider(project, ctx.services.drivers);
    const existing = S.ws.loadCover(root, issue);

    const written = await ctx.step('write', async (h) => {
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

    if (!params.draw) return { issue, summary: written.summary, decisions: written.decisions, drawn: false };

    const target = pipeline.drawTarget(ctx);
    const skip = (reason) => {
      for (const id of ['compile', 'draw', 'review']) ctx.skipStep(id, reason);
      return { issue, summary: written.summary, decisions: written.decisions, drawn: false, reason };
    };
    if (!lookState(project).master) return skip('The look is not approved yet: approve a look page, then draw the cover.');
    if (!target.available) return skip(`${target.reason} Use the manual handoff to make the cover by hand.`);

    const compiled = await ctx.step('compile', (h) => {
      const result = pipeline.compileCover(root, issue, target.provider, { model: target.model || undefined });
      for (const warning of result.warnings || []) h.log(`warning: ${warning}`);
      return { file: result.file, package: result.rel };
    });
    const outcome = await renderReviewRepair(ctx, {
      owner: { kind: 'cover', id: S.ws.coverIdOfIssue(issue), issue },
      prefix: '',
      label: 'Cover',
      compileGenerate: () => ({ file: compiled.file }),
      compileRepair: (review) => pipeline.compileCover(root, issue, target.provider, { repair: review, model: target.model || undefined }),
      fakeText: params.description,
    });
    return Object.assign({ issue, summary: written.summary, decisions: written.decisions, drawn: true }, outcome);
  },
};
