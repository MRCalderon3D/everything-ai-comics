'use strict';
/**
 * Drawing one reference sheet of an entity: compile its package, then draw
 * a candidate. Shared by the character, entity and style operations. Not an
 * operation itself.
 *
 * A sheet is drawn in the approved look, so before a look master exists the
 * two steps are skipped with the reason, and the operation still succeeds.
 */

const pipeline = require('../pipeline');
const { OpError } = require('../jobs');
const { lookState } = require('./shared');

const LABELS = {
  turnaround: 'turnaround sheet',
  expressions: 'expressions sheet',
  wardrobe: 'wardrobe sheet',
  plate: 'location plate',
  prop: 'prop sheet',
  detail: 'detail study',
};

function stepIds(kind, prefix = '') {
  return { compile: `${prefix}sheet-compile`, draw: `${prefix}sheet-draw`, kind };
}

/** The two steps of a sheet, for an operation's step list. */
function steps(kind, prefix = '', subject = '') {
  const what = `${LABELS[kind] || 'sheet'}${subject ? ` of ${subject}` : ''}`;
  return [
    { id: `${prefix}sheet-compile`, label: `Prepare the ${what}` },
    { id: `${prefix}sheet-draw`, label: `Draw the ${what}` },
  ];
}

/**
 * Compile and draw one sheet candidate.
 * @param {object} ctx job context
 * @param {string} entityId CHAR_*, LOC_* or PROP_*
 * @param {string} kind turnaround | expressions | wardrobe | plate | prop | detail
 * @param {{outfit?: string, subject?: string, time?: string, prefix?: string, strict?: boolean}} [options]
 *   strict: fail instead of skipping when the sheet cannot be drawn yet.
 * @returns {Promise<{candidate: string, candidate_id: string, record: string}|{skipped: true, reason: string}>}
 */
async function draw(ctx, entityId, kind, options = {}) {
  const { project } = ctx;
  const root = project.root;
  const ids = stepIds(kind, options.prefix || '');
  const skip = (reason) => {
    if (options.strict) throw new OpError('sheet_blocked', reason);
    ctx.skipStep(ids.compile, reason);
    ctx.skipStep(ids.draw, reason);
    ctx.log(`sheet not drawn: ${reason}`);
    return { skipped: true, reason };
  };
  if (!lookState(project).master) {
    return skip('The look is not approved yet. Draw a look page and approve it, then draw this sheet.');
  }
  const target = pipeline.drawTarget(ctx);
  if (!target.available) {
    return skip(`${target.reason} Use the manual handoff to make this sheet by hand.`);
  }
  const compiled = await ctx.step(ids.compile, (h) => {
    const result = pipeline.compileSheet(root, entityId, target.provider, {
      sheet: kind,
      outfit: options.outfit || undefined,
      subject: options.subject || undefined,
      time: options.time || undefined,
      model: target.model || undefined,
    });
    for (const note of result.notes) h.log(note);
    for (const warning of result.warnings) h.log(`warning: ${warning}`);
    return { package: result.rel, file: result.file };
  });
  const drawn = await ctx.step(ids.draw, async (h) => {
    h.setTool('codex');
    const result = await pipeline.draw(ctx, h, compiled.file);
    h.note(result.file);
    return result;
  }, { verb: 'draw' });
  return {
    candidate: drawn.file,
    candidate_id: drawn.file.split('/').pop().replace(/\.[^.]+$/, ''),
    record: drawn.record,
    kind,
  };
}

module.exports = { steps, draw, LABELS };
