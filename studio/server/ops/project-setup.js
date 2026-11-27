'use strict';
/**
 * project.setup (deprecated: use story.draft). Kept so older clients keep
 * working, and run by POST /api/projects only when the body asks for it
 * with "setup": true.
 *
 * It no longer writes the story. It saves the description as the person's
 * source text, makes sure the starter story files exist (an empty story
 * bible and a one-issue series plan, written mechanically), and asks the AI
 * for a draft of the story bible as a proposal, exactly like story.draft.
 */

const fs = require('fs');
const S = require('../scaffold');
const story = require('../story');
const { msg } = require('../i18n');
const pipeline = require('../pipeline');
const { propose } = require('./story-propose');
const { str, int } = require('./shared');

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
      const bible = S.ws.loadYaml(S.ws.abs(root, story.BIBLE));
      // A template, or the starter bible nobody has written in yet, takes the new description.
      const untouched = bible && (!Array.isArray(bible.facts) || !bible.facts.length) &&
        [title, story.personText(project)].includes(String(bible.premise || ''));
      const template = !bible || untouched || (typeof bible.premise === 'string' && /^TODO/i.test(bible.premise));
      if (template) {
        story.writeStarterStory(project, { title, description: params.description, pages: params.pages });
      } else {
        const file = S.ws.abs(root, story.SOURCE);
        fs.mkdirSync(require('path').dirname(file), { recursive: true });
        fs.writeFileSync(file, `# ${title}\n\n${params.description}\n`);
      }
      project.saveState({ description: params.description });
      return { file: story.SOURCE };
    });

    const drafted = await propose(ctx, 'story', { mode: 'draft' });

    const check = await ctx.step('check', (h) => {
      const result = pipeline.mechanical(root, null, { provider: pipeline.compileProvider(ctx.project, ctx.services.drivers) });
      for (const e of result.validation.errors.slice(0, 20)) h.log(`error ${e.file}: ${e.message}`);
      h.note(result.errors ? msg('note.problems', { n: result.errors }) : msg('note.no_problems'));
      return { errors: result.validation.errors, warnings: result.validation.warnings.length };
    });

    return {
      summary: drafted.summary,
      decisions: drafted.decisions,
      files: [],
      tool: drafted.tool,
      proposal: drafted.proposal,
      parts: drafted.parts,
      problems: check.errors,
    };
  },
};
