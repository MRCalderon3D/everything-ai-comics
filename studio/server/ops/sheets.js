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
const { msg, render } = require('../i18n');
const { OpError } = require('../jobs');
const { lookState } = require('./shared');

/** Sheet kinds that have step labels of their own in the dictionary. */
const KINDS = ['turnaround', 'expressions', 'wardrobe', 'plate', 'prop', 'detail'];

function stepIds(kind, prefix = '') {
  return { compile: `${prefix}sheet-compile`, draw: `${prefix}sheet-draw`, kind };
}

/** The two steps of a sheet, for an operation's step list. */
function steps(kind, prefix = '', subject = '') {
  const which = KINDS.includes(kind) ? kind : 'turnaround';
  const of = subject ? '.of' : '';
  return [
    { id: `${prefix}sheet-compile`, label: msg(`step.sheet.compile.${which}${of}`, { subject }) },
    { id: `${prefix}sheet-draw`, label: msg(`step.sheet.draw.${which}${of}`, { subject }) },
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
    if (options.strict) throw new OpError('sheet_blocked', msg('error.sheet_blocked', { reason }));
    ctx.skipStep(ids.compile, reason);
    ctx.skipStep(ids.draw, reason);
    ctx.log(`sheet not drawn: ${render('en', reason)}`);
    return { skipped: true, reason };
  };
  if (!lookState(project).master) {
    return skip(msg('skip.look_not_approved.sheet'));
  }
  const target = pipeline.drawTarget(ctx);
  if (!target.available) {
    return skip(msg('skip.no_draw_tool.sheet', { reason: target.reason }));
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

module.exports = { steps, draw, KINDS };
