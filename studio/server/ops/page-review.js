'use strict';
/**
 * page.review: run the visual review again for a render of a page or of a
 * cover. A person's open change requests on that render are kept.
 * Command: visual-review.
 */

const S = require('../scaffold');
const pipeline = require('../pipeline');
const { HttpError } = require('../util');
const { bad, RENDER_RE, PAGE_RE } = require('./shared');

module.exports = {
  name: 'page.review',
  title: 'Check a page again',
  summary: 'Runs the visual review again for one render of a page or a cover.',
  params: [
    { name: 'render', type: 'string', required: false, description: 'Render ID (PG_001_002_V01 or CV_001_V01).' },
    { name: 'page', type: 'string', required: false, description: 'Page ID: reviews its current render. Used when "render" is absent.' },
  ],

  validate(params, { project }) {
    const root = project.root;
    let render = params.render ? String(params.render) : null;
    if (!render) {
      const pageId = params.page ? String(params.page) : '';
      if (!PAGE_RE.test(pageId)) throw bad('Give "render" or "page".');
      const page = S.ws.loadPage(root, pageId);
      if (!page) throw new HttpError(404, 'page_not_found', `${pageId} does not exist in this project.`);
      render = page.current_render || S.ws.listRenders(root, pageId).pop() || null;
      if (!render) throw new HttpError(409, 'no_render', `${pageId} has no render to check yet.`);
    }
    if (!RENDER_RE.test(render)) throw bad(`"${render}" is not a render ID.`);
    if (!S.ws.renderFile(root, render)) throw new HttpError(404, 'render_not_found', `${render} has no image in this project.`);
    return { render };
  },

  steps() {
    return [{ id: 'review', label: 'Check the image against the plan' }];
  },

  async run(ctx) {
    const review = await ctx.step('review', (h) => pipeline.reviewRender(ctx, h, { render: ctx.params.render }), { verb: 'look' });
    return review;
  },
};
