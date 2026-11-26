'use strict';
/**
 * project.setup: from a title and a description to project metadata, a
 * story bible and a series plan. Runs right after a project is created.
 * Commands: project-init, story-bible, series-plan.
 */

const fs = require('fs');
const path = require('path');
const S = require('../scaffold');
const { msg } = require('../i18n');
const pipeline = require('../pipeline');
const { runAi } = require('../ai');
const { str, int } = require('./shared');

const SOURCE = 'story/source/description.md';

module.exports = {
  name: 'project.setup',
  params: [
    { name: 'description', type: 'string', required: true, description: 'What the comic is about, in the person\'s words.' },
    { name: 'pages', type: 'integer', required: false, description: 'Page budget of the first issue, 1 to 200. Default 4.' },
  ],

  validate(params) {
    return { description: str(params, 'description', { required: true, max: 20000 }), pages: int(params, 'pages', { min: 1, max: 200, fallback: 4 }) };
  },

  steps() {
    return [
      { id: 'source', label: msg('step.project.setup.source') },
      { id: 'story', label: msg('step.project.setup.story') },
      { id: 'check', label: msg('step.check.files') },
    ];
  },

  async run(ctx) {
    const { project, params } = ctx;
    const root = project.root;
    const title = (S.ws.loadProject(root) || {}).title || 'Untitled';

    await ctx.step('source', () => {
      const file = S.ws.abs(root, SOURCE);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `# ${title}\n\n${params.description}\n`);
      project.saveState({ description: params.description });
      return { file: SOURCE };
    });

    const story = await ctx.step('story', (h) => runAi(ctx, h, {
      verb: 'plan',
      kind: 'project.setup',
      vars: { title, description: params.description, pages: params.pages, pages_count: params.pages, source_file: SOURCE },
      fakeText: params.description,
    }), { verb: 'plan' });

    const check = await ctx.step('check', (h) => {
      const result = pipeline.mechanical(root, null);
      for (const e of result.validation.errors.slice(0, 20)) h.log(`error ${e.file}: ${e.message}`);
      h.note(result.errors ? msg('note.problems', { n: result.errors }) : msg('note.no_problems'));
      return { errors: result.validation.errors, warnings: result.validation.warnings.length };
    });

    return {
      summary: story.summary,
      decisions: story.decisions,
      files: story.files_written,
      tool: story.tool,
      problems: check.errors,
    };
  },
};
