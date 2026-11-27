'use strict';
/**
 * cover.correct: a change the person asks for on a rendered cover. Same two
 * paths as page.correct (ops/correction.js): an edit of the existing cover
 * (a touch-up), or the change goes into cover.yaml and the cover is drawn
 * again as a new lineage. At the project's touch-up warning the person
 * picks one with `mode`.
 */

const S = require('../scaffold');
const correction = require('./correction');
const { HttpError } = require('../util');
const { str, bad, matching, requireIssue, ISSUE_RE, RENDER_RE } = require('./shared');
const { checkRegion } = require('./page-correct');

module.exports = {
  name: 'cover.correct',
  params: [
    { name: 'issue', type: 'string', required: false, description: 'Issue ID. Default ISS_001.' },
    { name: 'text', type: 'string', required: true, description: 'What to change.' },
    { name: 'render', type: 'string', required: false, description: 'The cover render the request is about. Default: the newest one.' },
    { name: 'region', type: 'object', required: false, description: '{ x, y, w, h } as fractions of the image (0 to 1).' },
    { name: 'lettering', type: 'boolean', required: false, description: 'True when the request changes text in the image.' },
    { name: 'mode', type: 'string', required: false, description: 'touch_up or redraw: what the person chose once the image has reached the touch-up warning of the project (the request is refused without it then). touch_up edits the image anyway; redraw writes the change into the plan and draws it again. Set it only when the person said which.' },
  ],

  validate(params, { project }) {
    const root = project.root;
    const issue = matching(params, 'issue', ISSUE_RE, { required: false, what: 'an issue ID such as ISS_001' }) || 'ISS_001';
    requireIssue(project, issue);
    if (!S.ws.loadCover(root, issue)) throw new HttpError(409, 'no_cover', `${issue} has no cover yet.`);
    const renders = S.ws.listCoverRenders(root, issue);
    const render = params.render ? String(params.render) : renders[renders.length - 1];
    if (!render) throw new HttpError(409, 'no_render', 'The cover has no render to correct yet. Draw it first.');
    if (!RENDER_RE.test(render) || !renders.includes(render)) throw bad(`"${render}" is not a render of this cover.`);
    const text = str(params, 'text', { required: true, max: 4000 });
    const mode = correction.checkMode(params);
    return {
      issue, render, text,
      region: checkRegion(params.region), lettering: params.lettering === true,
      mode, path: correction.choosePath(root, render, mode, 'cover'),
    };
  },

  steps(params) {
    return correction.steps('cover', params.path);
  },

  async run(ctx) {
    const { params } = ctx;
    const outcome = await correction.run(ctx, {
      owner: { kind: 'cover', id: S.ws.coverIdOfIssue(params.issue), issue: params.issue },
      render: params.render,
      text: params.text,
      region: params.region,
      lettering: params.lettering,
      path: params.path,
    });
    return Object.assign({ issue: params.issue }, outcome);
  },
};
