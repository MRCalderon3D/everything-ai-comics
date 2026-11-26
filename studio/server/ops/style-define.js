'use strict';
/**
 * style.define: fix how the comic is drawn, from a preset, a description,
 * uploaded reference images, or a mix. Writes the style bible, the colour
 * script and the style block, and names the look.
 * Commands: ingest-references (with images), style-bible.
 *
 * A preset is applied the way templates/looks/README.md describes: its
 * style block is copied to style/style-block.txt and its colour mode set in
 * project.yaml, then the style-bible command fills the rest.
 */

const fs = require('fs');
const path = require('path');
const S = require('../scaffold');
const looks = require('../looks');
const pipeline = require('../pipeline');
const options = require('../project-options');
const prompts = require('../prompts');
const { runAi } = require('../ai');
const { HttpError } = require('../util');
const { str, bool, bad, uploadIds, fileReferenceUploads, lookState } = require('./shared');

module.exports = {
  name: 'style.define',
  title: 'Define the style',
  summary: 'Writes the style bible and the style block from a preset, a description, uploaded reference images, or a mix.',
  params: [
    { name: 'preset', type: 'string', required: false, description: 'Key of a preset from GET /style (for example "noir-ink").' },
    { name: 'description', type: 'string', required: false, description: 'The style in the person\'s words.' },
    { name: 'uploads', type: 'string[]', required: false, description: 'Ids of uploaded reference images.' },
    { name: 'attach_references', type: 'boolean', required: false, description: 'Attach the uploaded images to the look page as style references (default true). False: they only inform the written style.' },
  ],

  validate(params, { project }) {
    const presetKey = str(params, 'preset', { max: 80 });
    if (presetKey && !looks.preset(presetKey)) throw bad(`"${presetKey}" is not a preset. See the presets in GET /style.`);
    const description = str(params, 'description', { max: 8000 });
    const uploads = uploadIds(params, 'uploads', project, 'image');
    if (!presetKey && !description && !uploads.length) throw bad('Pick a preset, describe the style, upload a reference image, or mix them.');
    if (lookState(project).frozen) {
      throw new HttpError(409, 'style_frozen',
        'The look is approved and its style block is frozen: every page depends on it. A different style means a new project, or a new look defined by hand in the workspace.');
    }
    return { preset: presetKey || null, description, uploads, attach_references: bool(params, 'attach_references', true) };
  },

  steps() {
    return [
      { id: 'prepare', label: 'Apply the preset and file the reference images' },
      { id: 'bible', label: 'Write the style bible and the style block' },
      { id: 'check', label: 'Check the files' },
    ];
  },

  async run(ctx) {
    const { project, params } = ctx;
    const root = project.root;
    const chosen = params.preset ? looks.preset(params.preset) : null;

    const prepared = await ctx.step('prepare', () => {
      const lookId = chosen ? chosen.look_id : looks.lookIdFor(params.description);
      if (chosen) {
        const file = path.join(root, 'style', 'style-block.txt');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${chosen.style_block}\n`);
        if (chosen.color_mode) options.applyToProject(root, { color_mode: chosen.color_mode });
      }
      const references = fileReferenceUploads(project, lookId, params.uploads, {
        role: 'style',
        kind: 'look',
        approved: params.attach_references,
        note: 'Style reference supplied by the person through the studio.',
      });
      project.saveState({ look_id: lookId });
      return { look_id: lookId, references };
    });

    const bible = await ctx.step('bible', (h) => runAi(ctx, h, {
      verb: 'plan',
      kind: 'style.define',
      vars: {
        look_id: prepared.look_id,
        preset_file: chosen ? chosen.file : '',
        description: params.description,
        references: prompts.fileList(prepared.references.map((r) => ({ path: S.ws.abs(root, r.path), note: `registered as ${r.id}` }))),
        binding: params.attach_references ? 'canon' : 'inspiration',
      },
      images: prepared.references.map((r) => S.ws.abs(root, r.path)),
      fakeText: params.description,
    }), { verb: 'plan' });

    // The tool may have settled on another ID for the look; follow it only when it is well formed.
    const returned = bible.data && typeof bible.data.look_id === 'string' ? bible.data.look_id : null;
    const lookId = returned && /^LOOK_[A-Z][A-Z0-9_]*$/.test(returned) && !prepared.references.length ? returned : prepared.look_id;
    if (lookId !== prepared.look_id) project.saveState({ look_id: lookId });

    const check = await ctx.step('check', (h) => {
      const result = pipeline.mechanical(root, null);
      const block = S.ws.loadStyleBlock(root);
      const problems = result.validation.errors.slice();
      if (!block) problems.push({ file: 'style/style-block.txt', code: 'STYLE_BLOCK_EMPTY', message: 'The style block is empty.' });
      else if (/^#/m.test(block) || /<[^<>\n]+>/.test(block)) {
        problems.push({ file: 'style/style-block.txt', code: 'STYLE_BLOCK_TEMPLATE', message: 'The style block still has template lines.' });
      }
      h.note(problems.length ? `${problems.length} problem(s) to look at` : 'No problems found');
      return { errors: problems };
    });

    return {
      summary: bible.summary,
      decisions: bible.decisions,
      files: bible.files_written,
      tool: bible.tool,
      look_id: lookId,
      references: prepared.references,
      problems: check.errors,
    };
  },
};
