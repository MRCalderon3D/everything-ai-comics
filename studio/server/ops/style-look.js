'use strict';
/**
 * style.look: compile the look sheet package and draw one look page
 * candidate. Approving a candidate is a separate call (POST /approve/asset),
 * which promotes it to the look master and freezes the style block.
 */

const S = require('../scaffold');
const pipeline = require('../pipeline');
const { HttpError } = require('../util');
const { lookState, requireDrawTool } = require('./shared');

module.exports = {
  name: 'style.look',
  title: 'Draw a look page',
  summary: 'Compiles the look sheet and draws a look page candidate in the defined style.',
  params: [],

  validate(params, { project }) {
    const state = lookState(project);
    if (!state.lookId) throw new HttpError(409, 'style_missing', 'Define the style first: there is no look to draw yet.');
    if (!S.ws.loadStyleBlock(project.root)) throw new HttpError(409, 'style_missing', 'Define the style first: the style block is empty.');
    return {};
  },

  steps() {
    return [
      { id: 'compile', label: 'Prepare the look page' },
      { id: 'draw', label: 'Draw the look page' },
    ];
  },

  async run(ctx) {
    const { project } = ctx;
    const root = project.root;
    const { lookId } = lookState(project);
    const target = requireDrawTool(ctx);
    const compiled = await ctx.step('compile', (h) => {
      const result = pipeline.compileSheet(root, lookId, target.provider, { sheet: 'look', model: target.model || undefined });
      for (const note of result.notes) h.log(note);
      for (const warning of result.warnings) h.log(`warning: ${warning}`);
      return { package: result.rel, file: result.file };
    });
    const drawn = await ctx.step('draw', async (h) => {
      h.setTool('codex');
      const result = await pipeline.draw(ctx, h, compiled.file);
      h.note(result.file);
      return result;
    }, { verb: 'draw' });
    return {
      look_id: lookId,
      candidate: drawn.file,
      candidate_id: drawn.file.split('/').pop().replace(/\.[^.]+$/, ''),
      record: drawn.record,
      tool: 'codex',
    };
  },
};
