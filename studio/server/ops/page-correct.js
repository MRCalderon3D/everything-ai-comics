'use strict';
/**
 * page.correct: a change the person asks for on a rendered page, optionally
 * tied to a panel or a region. The request is recorded as a finding
 * (source: user_request) on the review of that render. Then, by
 * ops/correction.js, the existing page is edited into a new version, or,
 * once the lineage has used the project's repair cycles, the change goes
 * into the plan and the page is drawn again as a new lineage. Either way the
 * new version is reviewed, and the result says which path was taken.
 * Commands: repair-page, visual-review (and the plan commands on a redraw).
 */

const S = require('../scaffold');
const correction = require('./correction');
const { HttpError } = require('../util');
const { str, bad, requirePage, PAGE_RE, PANEL_RE, RENDER_RE } = require('./shared');

/** { x, y, w, h } as fractions of the page, or null. Throws 400 on a bad shape. */
function checkRegion(region) {
  if (region === undefined || region === null) return null;
  const ok = region && typeof region === 'object' &&
    ['x', 'y', 'w', 'h'].every((k) => typeof region[k] === 'number' && Number.isFinite(region[k])) &&
    region.x >= 0 && region.y >= 0 && region.w > 0 && region.h > 0 &&
    region.x + region.w <= 1.0001 && region.y + region.h <= 1.0001;
  if (!ok) throw bad('"region" must be { x, y, w, h } as fractions of the page between 0 and 1, inside the page.');
  const round = (n) => Math.round(n * 10000) / 10000;
  const x = round(region.x);
  const y = round(region.y);
  return { x, y, w: round(Math.min(region.w, 1 - x)), h: round(Math.min(region.h, 1 - y)) };
}

module.exports = {
  name: 'page.correct',
  checkRegion,
  params: [
    { name: 'page', type: 'string', required: true, description: 'Page ID.' },
    { name: 'text', type: 'string', required: true, description: 'What to change, in the person\'s words.' },
    { name: 'render', type: 'string', required: false, description: 'The render the request is about. Default: the page\'s current render.' },
    { name: 'panel', type: 'string', required: false, description: 'Panel ID the request is about.' },
    { name: 'region', type: 'object', required: false, description: '{ x, y, w, h } as fractions of the page (0 to 1) from its top-left corner.' },
    { name: 'lettering', type: 'boolean', required: false, description: 'True when the request changes text in the image, which unlocks the lettering in the repair.' },
  ],

  validate(params, { project }) {
    const root = project.root;
    const pageId = String(params.page || '');
    if (!PAGE_RE.test(pageId)) throw bad('"page" must be a page ID.');
    const page = requirePage(project, pageId);
    const text = str(params, 'text', { required: true, max: 4000 });
    const render = params.render ? String(params.render) : (page.current_render || S.ws.listRenders(root, pageId).pop() || null);
    if (!render) throw new HttpError(409, 'no_render', `${pageId} has no render to correct yet. Draw the page first.`);
    if (!RENDER_RE.test(render) || S.ws.pageOfRender(render) !== pageId) throw bad(`"${render}" is not a render of ${pageId}.`);
    if (!S.ws.renderFile(root, render)) throw new HttpError(404, 'render_not_found', `${render} has no image in this project.`);
    let panel = null;
    if (params.panel) {
      panel = String(params.panel);
      const ids = Array.isArray(page.panels) ? page.panels.map((p) => p && p.id) : [];
      if (!PANEL_RE.test(panel) || !ids.includes(panel)) throw bad(`"${panel}" is not a panel of ${pageId}.`);
    }
    return {
      page: pageId, text, render, panel, region: checkRegion(params.region), lettering: params.lettering === true,
      path: correction.pathFor(root, render),
    };
  },

  steps(params) {
    return correction.steps('page', params.path);
  },

  async run(ctx) {
    const { params } = ctx;
    const outcome = await correction.run(ctx, {
      owner: { kind: 'page', id: params.page, issue: S.ws.issueOfPage(params.page) },
      render: params.render,
      text: params.text,
      panel: params.panel,
      region: params.region,
      lettering: params.lettering,
    });
    return Object.assign({ page: params.page }, outcome);
  },
};
