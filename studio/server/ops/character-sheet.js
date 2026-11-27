'use strict';
/**
 * character.sheet: draw one more reference sheet of a character, or the
 * next version of its full character sheet. The result is a candidate;
 * approval is a separate call.
 *
 * - turnaround, model (the full character sheet: name and line, turnaround,
 *   labelled close-ups, labelled expressions and poses): the character's
 *   first identity sheet is drawn from the description and, while no drawn
 *   master is approved, from the photos the person supplied.
 * - expressions, wardrobe: drawn from the approved identity master, which
 *   they need. They are refused before one is approved.
 * - revise (with sheet model): a round of changes on a version of the full
 *   sheet. The written character file is updated to match the changes first
 *   (story facts the run tries to add become a proposal), then the previous
 *   version is edited into the next one with everything else locked.
 */

const S = require('../scaffold');
const identity = require('../identity');
const prompts = require('../prompts');
const { msg } = require('../i18n');
const { runAi } = require('../ai');
const { HttpError } = require('../util');
const { str, bool, bad, matching, uploadIds, fileReferenceUploads, CHAR_RE } = require('./shared');
const { checkRegion } = require('./page-correct');
const sheets = require('./sheets');

const KINDS = ['turnaround', 'model', 'expressions', 'wardrobe'];
const NEEDS_MASTER = ['expressions', 'wardrobe'];

/** A list of short lines (close-ups, poses, expressions), or null when not given. */
function lines(params, name, { max = 8, length = 200 } = {}) {
  const value = params[name];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > max) throw bad(`"${name}" must be a list of at most ${max} short lines.`);
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length > length) throw bad(`Each line of "${name}" is text of at most ${length} characters.`);
    const text = item.replace(/\s+/g, ' ').trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/** The change list of a revision: [{ text, region }], from `changes` or from `text` and `region`. */
function changeList(params) {
  const out = [];
  if (params.changes !== undefined && params.changes !== null) {
    if (!Array.isArray(params.changes) || params.changes.length > 12) throw bad('"changes" must be a list of at most 12 changes.');
    for (const item of params.changes) {
      const entry = typeof item === 'string' ? { text: item } : item;
      if (!entry || typeof entry !== 'object' || typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > 2000) {
        throw bad('Each change is { text, region? }: the text says what to change, at most 2000 characters.');
      }
      out.push({ text: entry.text.trim(), region: checkRegion(entry.region) });
    }
  }
  const text = str(params, 'text', { max: 4000 });
  if (text) out.push({ text, region: checkRegion(params.region) });
  return out;
}

/** The versions of a character's full sheet on disk, oldest first (candidates and masters). */
function modelVersions(root, charId) {
  const dir = S.assetPaths.refsDir(charId);
  const re = new RegExp(`^${charId}_MODEL(?:_MASTER)?_V\\d{2}$`);
  let names = [];
  try {
    names = require('fs').readdirSync(S.ws.abs(root, dir));
  } catch (err) {
    names = [];
  }
  return names.map((n) => n.replace(/\.[^.]+$/, '')).filter((stem) => re.test(stem)).sort((a, b) => a.slice(-2).localeCompare(b.slice(-2)) || a.localeCompare(b));
}

module.exports = {
  name: 'character.sheet',
  params: [
    { name: 'character', type: 'string', required: true, description: 'Character ID.' },
    { name: 'sheet', type: 'string', required: false, description: 'turnaround (default), model (the full character sheet: turnaround, labelled close-ups, labelled expressions and poses, in one landscape image), expressions, or wardrobe. Expressions and wardrobe need an approved turnaround or full sheet.' },
    { name: 'outfit', type: 'string', required: false, description: 'Wardrobe ID for a wardrobe sheet. Default: the character\'s default outfit.' },
    { name: 'closeups', type: 'string[]', required: false, description: 'model only: the labelled close-ups, one per line, "label: what it shows" (for example "left forearm: a long scar"). Saved in the character file. Default: what the file lists, else the distinguishing features.' },
    { name: 'poses', type: 'string[]', required: false, description: 'model only: the labelled expressions and poses, one per line (for example "tired", "sitting"). Saved in the character file.' },
    { name: 'revise', type: 'string', required: false, description: 'model only: the version of the full sheet to change, for example CHAR_MARTA_MODEL_V01. Use "latest" for the newest version. Draws the next version from it with the changes, and keeps everything else.' },
    { name: 'text', type: 'string', required: false, description: 'With revise: what to change, in the person\'s words ("shorter hair", "the wound on the other arm", "add a sitting pose").' },
    { name: 'region', type: 'object', required: false, description: 'With revise and text: { x, y, w, h } as fractions of the sheet (0 to 1) from its top-left corner, the part the change is about.' },
    { name: 'changes', type: 'object[]', required: false, description: 'With revise: several changes at once, each { text, region? }.' },
    { name: 'uploads', type: 'string[]', required: false, description: 'With revise: ids of new uploaded photos of the character, used for likeness in this round.' },
    { name: 'update_file', type: 'boolean', required: false, description: 'With revise: update the written character file to match the changes first (default true).' },
  ],

  validate(params, { project }) {
    const root = project.root;
    const character = matching(params, 'character', CHAR_RE, { what: 'a character ID such as CHAR_MARTA' });
    if (!S.ws.loadCharacter(root, character)) throw new HttpError(404, 'character_not_found', `${character} does not exist in this project.`);
    const sheet = str(params, 'sheet', { max: 20 }) || 'turnaround';
    if (!KINDS.includes(sheet)) throw bad(`"sheet" must be one of ${KINDS.join(', ')}.`);
    const outfit = str(params, 'outfit', { max: 80 });
    if (outfit && !/^WARD_[A-Z][A-Z0-9_]*$/.test(outfit)) throw bad('"outfit" must be a wardrobe ID such as WARD_MARTA_COAT.');
    const closeups = lines(params, 'closeups');
    const poses = lines(params, 'poses');
    if ((closeups || poses) && sheet !== 'model') throw bad('"closeups" and "poses" apply to the full character sheet (sheet "model").');
    let revise = str(params, 'revise', { max: 80 }) || null;
    const changes = changeList(params);
    const uploads = uploadIds(params, 'uploads', project, 'image');
    if (revise && sheet !== 'model') throw bad('"revise" applies to the full character sheet (sheet "model").');
    if (!revise && (changes.length || uploads.length)) throw bad('"text", "changes" and "uploads" go with "revise", the version to change.');
    if (revise) {
      const versions = modelVersions(root, character);
      if (revise === 'latest') revise = versions[versions.length - 1] || null;
      if (!revise || !versions.includes(revise)) {
        throw new HttpError(409, 'revise_target_missing', msg('error.revise_target_missing', { character }), { versions }, { character });
      }
      if (!changes.length) throw bad('Say what to change: "text", or a list of "changes".');
    }
    if (NEEDS_MASTER.includes(sheet)) {
      const state = identity.identityState(root, character);
      if (state.needs_master) {
        throw new HttpError(409, 'master_required', msg('error.master_required', { character }),
          { character, photos: state.photos }, { character });
      }
    }
    return {
      character, sheet, outfit: outfit || null, closeups, poses, revise, changes, uploads,
      update_file: bool(params, 'update_file', true),
    };
  },

  steps(params) {
    if (params.revise) {
      return [
        ...(params.uploads.length ? [{ id: 'photos', label: msg('step.photos') }] : []),
        ...(params.update_file ? [{ id: 'write', label: msg('step.character.revise.write') }] : []),
        ...sheets.steps('model', '', '', { revise: true }),
      ];
    }
    return [
      ...(params.closeups || params.poses ? [{ id: 'plan', label: msg('step.sheet.plan') }] : []),
      ...sheets.steps(params.sheet),
    ];
  },

  async run(ctx) {
    const { params, project } = ctx;
    const root = project.root;
    const id = params.character;
    const character = S.ws.loadCharacter(root, id) || {};
    const fakeText = [character.prompt_summary, character.description && character.description.summary].filter(Boolean).join(' ');

    if (params.revise) {
      let references = [];
      if (params.uploads.length) {
        references = await ctx.step('photos', () => fileReferenceUploads(project, id, params.uploads, {
          role: 'identity', kind: 'detail', approved: true, note: 'asset.note.identity_ref',
        }));
      }
      let written = null;
      if (params.update_file) {
        const request = params.changes.map((c, i) => `${i + 1}. ${c.text}`).join('\n');
        written = await ctx.step('write', (h) => runAi(ctx, h, {
          verb: 'plan',
          kind: 'character.write',
          vars: {
            update: true,
            sheet_change: true,
            character_id: id,
            description: request,
            references: prompts.fileList(references.map((r) => ({ path: S.ws.abs(root, r.path), note: `registered as ${r.id}` }))),
          },
          images: references.map((r) => S.ws.abs(root, r.path)),
          fakeText: request,
        }), { verb: 'plan' });
      }
      const sheet = await sheets.draw(ctx, id, 'model', {
        strict: true, revise: params.revise, changes: params.changes, likeness: references.map((r) => r.id), fakeText,
      });
      return {
        character: id, sheet, from: params.revise, references,
        summary: written ? written.summary : null, files: written ? written.files_written : [], bible: written ? written.bible : null,
      };
    }

    if (params.closeups || params.poses) {
      await ctx.step('plan', () => {
        identity.saveSheetPlan(root, id, { closeups: params.closeups, poses: params.poses });
        return { closeups: params.closeups, poses: params.poses };
      });
    }
    const sheet = await sheets.draw(ctx, id, params.sheet, { outfit: params.outfit, strict: true, fakeText });
    return { character: id, sheet };
  },
};
