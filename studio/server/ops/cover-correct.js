'use strict';
/**
 * cover.correct: a change the person asks for on a rendered cover. Same two
 * paths as page.correct (ops/correction.js): an edit of the existing cover,
 * or, once the repair limit is reached, the change goes into cover.yaml and
 * the cover is drawn again as a new lineage.
 */

const S = require('../scaffold');
const correction = require('./correction');
const { HttpError } = require('../util');
const { str, bad, matching, requireIssue, ISSUE_RE, RENDER_RE } = require('./shared');
const { checkRegion } = require('./page-correct');

module.exports = {
  name: 'cover.correct',
  title: 'Correct the cover',
  summary: 'Records a change the person asks for on the cover and produces a new version: an edit of the existing cover, or a redraw from an updated plan once the repair limit is reached.',
  params: [
    { name: 'issue', type: 'string', required: false, description: 'Issue ID. Default ISS_001.' },
    { name: 'text', type: 'string', required: true, description: 'What to change.' },
    { name: 'render', type: 'string', required: false, description: 'The cover render the request is about. Default: the newest one.' },
    { name: 'region', type: 'object', required: false, description: '{ x, y, w, h } as fractions of the image (0 to 1).' },
    { name: 'lettering', type: 'boolean', required: false, description: 'True when the request changes text in the image.' },
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
    return {
      issue, render, text: str(params, 'text', { required: true, max: 4000 }),
      region: checkRegion(params.region), lettering: params.lettering === true,
      path: correction.pathFor(root, render),
    };
  },

  steps(params) {
    return correction.steps('the cover', params.path);
  },

  async run(ctx) {
    const { params } = ctx;
    const outcome = await correction.run(ctx, {
      owner: { kind: 'cover', id: S.ws.coverIdOfIssue(params.issue), issue: params.issue },
      render: params.render,
      text: params.text,
      region: params.region,
      lettering: params.lettering,
      what: 'the cover',
    });
    return Object.assign({ issue: params.issue }, outcome);
  },
};
