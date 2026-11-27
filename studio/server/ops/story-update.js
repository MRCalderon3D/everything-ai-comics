'use strict';
/**
 * story.update: apply a text instruction to the canon, or fold in an
 * uploaded source text. Commands: source-analyze (with a source),
 * story-bible, series-plan.
 */

const fs = require('fs');
const path = require('path');
const pipeline = require('../pipeline');
const { msg } = require('../i18n');
const { runAi } = require('../ai');
const { safeName } = require('../security');
const { str, bad } = require('./shared');

module.exports = {
  name: 'story.update',
  params: [
    { name: 'instruction', type: 'string', required: false, description: 'What to change in the story.' },
    { name: 'source_upload', type: 'string', required: false, description: 'Id of an uploaded text file (txt, md, fountain) to use as source.' },
  ],

  validate(params, { project }) {
    const instruction = str(params, 'instruction', { max: 20000 });
    const upload = params.source_upload ? project.upload(String(params.source_upload)) : null;
    if (params.source_upload && (!upload || upload.kind !== 'source')) throw bad('"source_upload" must be the id of an uploaded text file.');
    if (!instruction && !upload) throw bad('Give an instruction, a source text, or both.');
    return { instruction, source_upload: upload ? upload.id : null };
  },

  steps(params) {
    return [
      ...(params.source_upload ? [{ id: 'source', label: msg('step.story.update.source') }] : []),
      { id: 'update', label: msg('step.story.update.update') },
      { id: 'check', label: msg('step.check.files') },
    ];
  },

  async run(ctx) {
    const { project, params } = ctx;
    const root = project.root;
    let sourceFile = null;
    if (params.source_upload) {
      const stored = await ctx.step('source', () => {
        const upload = project.upload(params.source_upload);
        const dir = path.join(root, 'story', 'source');
        fs.mkdirSync(dir, { recursive: true });
        let name = safeName(upload.name, 'source.txt');
        for (let n = 2; fs.existsSync(path.join(dir, name)); n++) {
          const ext = path.extname(upload.name);
          name = `${safeName(path.basename(upload.name, ext), 'source')}-${n}${ext}`;
        }
        fs.copyFileSync(project.uploadFile(upload), path.join(dir, name));
        return { file: `story/source/${name}` };
      });
      sourceFile = stored.file;
    }
    const update = await ctx.step('update', (h) => runAi(ctx, h, {
      verb: 'plan',
      kind: 'story.update',
      vars: { instruction: params.instruction, source_file: sourceFile },
      fakeText: params.instruction,
    }), { verb: 'plan' });
    const check = await ctx.step('check', (h) => {
      const result = pipeline.mechanical(root, null, { provider: pipeline.compileProvider(ctx.project, ctx.services.drivers) });
      h.note(result.errors ? msg('note.problems', { n: result.errors }) : msg('note.no_problems'));
      return { errors: result.validation.errors, continuity: result.continuity.filter((f) => f.severity === 'error') };
    });
    return {
      summary: update.summary, decisions: update.decisions, files: update.files_written, tool: update.tool,
      source: sourceFile, problems: check.errors, continuity: check.continuity,
    };
  },
};
