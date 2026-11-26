'use strict';
/**
 * character.update: change an existing character from an instruction and
 * optional new photos. Optionally draws a new turnaround candidate.
 * Commands: ingest-references (with photos), character-bible.
 */

const S = require('../scaffold');
const { msg } = require('../i18n');
const prompts = require('../prompts');
const { runAi } = require('../ai');
const { HttpError } = require('../util');
const { str, bool, bad, matching, uploadIds, fileReferenceUploads, CHAR_RE } = require('./shared');
const sheets = require('./sheets');

module.exports = {
  name: 'character.update',
  params: [
    { name: 'character', type: 'string', required: true, description: 'Character ID, for example CHAR_MARTA.' },
    { name: 'instruction', type: 'string', required: false, description: 'What to change.' },
    { name: 'uploads', type: 'string[]', required: false, description: 'Ids of new uploaded photos or drawings.' },
    { name: 'draw', type: 'boolean', required: false, description: 'Draw a new turnaround candidate afterwards (default false).' },
  ],

  validate(params, { project }) {
    const character = matching(params, 'character', CHAR_RE, { what: 'a character ID such as CHAR_MARTA' });
    if (!S.ws.loadCharacter(project.root, character)) throw new HttpError(404, 'character_not_found', `${character} does not exist in this project.`);
    const instruction = str(params, 'instruction', { max: 8000 });
    const uploads = uploadIds(params, 'uploads', project, 'image');
    if (!instruction && !uploads.length) throw bad('Say what to change, upload a photo, or both.');
    return { character, instruction, uploads, draw: bool(params, 'draw', false) };
  },

  steps(params) {
    return [
      ...(params.uploads.length ? [{ id: 'photos', label: msg('step.photos') }] : []),
      { id: 'write', label: msg('step.character.update.write') },
      ...(params.draw ? sheets.steps('turnaround') : []),
    ];
  },

  async run(ctx) {
    const { project, params } = ctx;
    const root = project.root;
    const id = params.character;
    let references = [];
    if (params.uploads.length) {
      references = await ctx.step('photos', () => fileReferenceUploads(project, id, params.uploads, {
        role: 'identity',
        kind: 'detail',
        approved: true,
        note: 'asset.note.identity_ref',
      }));
    }
    const written = await ctx.step('write', (h) => runAi(ctx, h, {
      verb: 'plan',
      kind: 'character.write',
      vars: {
        update: true,
        character_id: id,
        description: params.instruction,
        references: prompts.fileList(references.map((r) => ({ path: S.ws.abs(root, r.path), note: `registered as ${r.id}` }))),
      },
      images: references.map((r) => S.ws.abs(root, r.path)),
      fakeText: params.instruction,
    }), { verb: 'plan' });
    const sheet = params.draw ? await sheets.draw(ctx, id, 'turnaround', {}) : null;
    return {
      character: id, summary: written.summary, decisions: written.decisions, files: written.files_written,
      tool: written.tool, references, sheet,
    };
  },
};
