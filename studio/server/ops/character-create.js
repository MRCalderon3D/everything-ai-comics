'use strict';
/**
 * character.create: a character from a name, a description and optional
 * photos, then (by default) a turnaround sheet candidate.
 * Commands: ingest-references (with photos), character-bible.
 */

const S = require('../scaffold');
const { msg } = require('../i18n');
const prompts = require('../prompts');
const { runAi } = require('../ai');
const { OpError } = require('../jobs');
const { HttpError, idToken } = require('../util');
const { str, bool, bad, uploadIds, fileReferenceUploads } = require('./shared');
const sheets = require('./sheets');

module.exports = {
  name: 'character.create',
  params: [
    { name: 'name', type: 'string', required: true, description: 'The character\'s name.' },
    { name: 'description', type: 'string', required: false, description: 'Who they are and what they look like.' },
    { name: 'uploads', type: 'string[]', required: false, description: 'Ids of uploaded photos or drawings of the character.' },
    { name: 'draw', type: 'boolean', required: false, description: 'Draw the turnaround sheet candidate after writing the files (default true).' },
  ],

  validate(params, { project }) {
    const name = str(params, 'name', { required: true, max: 80 });
    const description = str(params, 'description', { max: 8000 });
    const uploads = uploadIds(params, 'uploads', project, 'image');
    if (!description && !uploads.length) throw bad('Describe the character, upload a photo, or both.');
    const id = `CHAR_${idToken(name)}`;
    if (S.ws.loadCharacter(project.root, id)) {
      throw new HttpError(409, 'character_exists', `${id} already exists. Change it with character.update, or use another name.`, { character: id }, { character: id });
    }
    return { name, description, uploads, draw: bool(params, 'draw', true), character: id };
  },

  steps(params) {
    return [
      ...(params.uploads.length ? [{ id: 'photos', label: msg('step.photos') }] : []),
      { id: 'write', label: msg('step.character.create.write') },
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
        create: true,
        character_id: id,
        name: params.name,
        description: params.description,
        references: prompts.fileList(references.map((r) => ({ path: S.ws.abs(root, r.path), note: `registered as ${r.id}` }))),
      },
      images: references.map((r) => S.ws.abs(root, r.path)),
      fakeText: params.description,
    }), { verb: 'plan' });
    if (!S.ws.loadCharacter(root, id)) {
      throw new OpError('character_missing', `The character file of ${id} was not written.`);
    }
    const sheet = params.draw ? await sheets.draw(ctx, id, 'turnaround', {}) : null;
    return {
      character: id,
      summary: written.summary,
      decisions: written.decisions,
      files: written.files_written,
      tool: written.tool,
      references,
      sheet,
    };
  },
};
