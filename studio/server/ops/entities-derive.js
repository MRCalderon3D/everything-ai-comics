'use strict';
/**
 * entities.derive: write the location and prop files the planned pages
 * need, and optionally draw a plate for each location without one.
 * Commands: location-bible, prop-bible.
 */

const S = require('../scaffold');
const { msg } = require('../i18n');
const { runAi } = require('../ai');
const { str, bool, matching, requireIssue, ISSUE_RE } = require('./shared');
const sheets = require('./sheets');

module.exports = {
  name: 'entities.derive',
  params: [
    { name: 'issue', type: 'string', required: false, description: 'Limit the scope to one issue (ISS_001). Default: the whole project.' },
    { name: 'text', type: 'string', required: false, description: 'What happens on the pages being planned, when they are not written yet.' },
    { name: 'plates', type: 'boolean', required: false, description: 'Draw a plate candidate for each location that has no approved plate (default false).' },
  ],

  validate(params, { project }) {
    const issue = matching(params, 'issue', ISSUE_RE, { required: false, what: 'an issue ID such as ISS_001' });
    if (issue) requireIssue(project, issue);
    return { issue, text: str(params, 'text', { max: 20000 }), plates: bool(params, 'plates', false) };
  },

  steps() {
    return [{ id: 'write', label: msg('step.entities.derive.write') }];
  },

  async run(ctx) {
    const { project, params } = ctx;
    const root = project.root;
    const written = await ctx.step('write', (h) => runAi(ctx, h, {
      verb: 'plan',
      kind: 'entities.derive',
      vars: {
        scope: params.issue ? `issue ${params.issue}` : 'every issue of the project',
        text: params.text,
      },
      fakeText: params.text,
    }), { verb: 'plan' });

    const plates = [];
    if (params.plates) {
      const assets = S.ws.loadReferenceAssets(root);
      for (const locId of S.ws.listEntityIds(root, 'locations')) {
        const hasPlate = [...assets.values()].some((a) => a.entity === locId && a.status === 'approved');
        if (hasPlate || !S.ws.loadLocation(root, locId)) continue;
        const prefix = `${locId}:`;
        for (const step of sheets.steps('plate', prefix, locId)) ctx.addStep(step);
        plates.push(Object.assign({ location: locId }, await sheets.draw(ctx, locId, 'plate', { prefix })));
      }
    }
    return {
      summary: written.summary,
      decisions: written.decisions,
      files: written.files_written,
      tool: written.tool,
      locations: S.ws.listEntityIds(root, 'locations'),
      props: S.ws.listEntityIds(root, 'props'),
      plates,
    };
  },
};
