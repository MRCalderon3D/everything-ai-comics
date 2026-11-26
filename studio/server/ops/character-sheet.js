'use strict';
/**
 * character.sheet: draw one more reference sheet of a character
 * (turnaround, expressions, or a wardrobe sheet of one outfit). The result
 * is a candidate; approval is a separate call.
 */

const S = require('../scaffold');
const { HttpError } = require('../util');
const { str, bad, matching, CHAR_RE } = require('./shared');
const sheets = require('./sheets');

const KINDS = ['turnaround', 'expressions', 'wardrobe'];

module.exports = {
  name: 'character.sheet',
  title: 'Draw a character sheet',
  summary: 'Draws a turnaround, expressions or wardrobe sheet candidate for a character.',
  params: [
    { name: 'character', type: 'string', required: true, description: 'Character ID.' },
    { name: 'sheet', type: 'string', required: false, description: 'turnaround (default), expressions, or wardrobe.' },
    { name: 'outfit', type: 'string', required: false, description: 'Wardrobe ID for a wardrobe sheet. Default: the character\'s default outfit.' },
  ],

  validate(params, { project }) {
    const character = matching(params, 'character', CHAR_RE, { what: 'a character ID such as CHAR_MARTA' });
    if (!S.ws.loadCharacter(project.root, character)) throw new HttpError(404, 'character_not_found', `${character} does not exist in this project.`);
    const sheet = str(params, 'sheet', { max: 20 }) || 'turnaround';
    if (!KINDS.includes(sheet)) throw bad(`"sheet" must be one of ${KINDS.join(', ')}.`);
    const outfit = str(params, 'outfit', { max: 80 });
    if (outfit && !/^WARD_[A-Z][A-Z0-9_]*$/.test(outfit)) throw bad('"outfit" must be a wardrobe ID such as WARD_MARTA_COAT.');
    return { character, sheet, outfit: outfit || null };
  },

  steps(params) {
    return sheets.steps(params.sheet);
  },

  async run(ctx) {
    const { params } = ctx;
    const sheet = await sheets.draw(ctx, params.character, params.sheet, { outfit: params.outfit, strict: true });
    return { character: params.character, sheet };
  },
};
