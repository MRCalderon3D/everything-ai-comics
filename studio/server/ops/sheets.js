'use strict';
/**
 * Drawing one reference sheet of an entity: compile its package, then draw
 * a candidate. Shared by the character, entity and style operations. Not an
 * operation itself.
 *
 * A sheet is drawn in the approved look, so before a look master exists the
 * two steps are skipped with the reason, and the operation still succeeds.
 *
 * A character sheet drawn from the character's identity master (an
 * expressions or wardrobe sheet, a full sheet drawn from an approved
 * turnaround) is then checked against that master for identity: same face,
 * hair, build, and marks on the same side. When the check fails, the sheet
 * is drawn once more with what the check found, checked again, and shown
 * with a warning if it still differs. The person always sees the result.
 */

const S = require('../scaffold');
const pipeline = require('../pipeline');
const prompts = require('../prompts');
const identity = require('../identity');
const { msg, render } = require('../i18n');
const { runAi } = require('../ai');
const { OpError } = require('../jobs');
const { today } = require('../util');
const { lookState, rethrowIfFatal } = require('./shared');

/** Sheet kinds that have step labels of their own in the dictionary. */
const KINDS = ['turnaround', 'model', 'expressions', 'wardrobe', 'plate', 'prop', 'detail'];

function stepIds(kind, prefix = '') {
  return {
    compile: `${prefix}sheet-compile`,
    draw: `${prefix}sheet-draw`,
    check: `${prefix}sheet-check`,
    redraw: `${prefix}sheet-redraw`,
    recheck: `${prefix}sheet-recheck`,
    kind,
  };
}

/** The two steps of a sheet, for an operation's step list. A revision has its own labels. */
function steps(kind, prefix = '', subject = '', { revise = false } = {}) {
  const which = KINDS.includes(kind) ? kind : 'turnaround';
  const of = subject ? '.of' : '';
  if (revise) {
    return [
      { id: `${prefix}sheet-compile`, label: msg('step.sheet.compile.revision') },
      { id: `${prefix}sheet-draw`, label: msg('step.sheet.draw.revision') },
    ];
  }
  return [
    { id: `${prefix}sheet-compile`, label: msg(`step.sheet.compile.${which}${of}`, { subject }) },
    { id: `${prefix}sheet-draw`, label: msg(`step.sheet.draw.${which}${of}`, { subject }) },
  ];
}

/** The drawn identity master a compiled package attached (role identity, not a photo), or null. */
function masterOfPackage(root, pkg) {
  const assets = S.ws.loadReferenceAssets(root);
  for (const ref of Array.isArray(pkg.references) ? pkg.references : []) {
    if (!ref || ref.role !== 'identity') continue;
    const asset = assets.get(ref.asset_id);
    if (asset && !S.referencePlan.isLikenessSource(asset)) return { id: asset.id, path: String(ref.image_path) };
  }
  return null;
}

/**
 * Look at a drawn sheet next to the master it was drawn from.
 * @returns {Promise<{same: boolean, findings: object[], tool: string}>}
 */
async function identityCheck(ctx, handle, { entityId, kind, candidate, master, round, fakeText }) {
  const root = ctx.project.root;
  const character = S.ws.loadCharacter(root, entityId) || {};
  const features = character.description && Array.isArray(character.description.distinguishing_features)
    ? character.description.distinguishing_features : [];
  const candidateFile = S.ws.abs(root, candidate);
  const masterFile = S.ws.abs(root, master.path);
  const result = await runAi(ctx, handle, {
    verb: 'look',
    kind: 'sheet.check',
    vars: {
      character_id: entityId,
      name: character.name || entityId,
      sheet: render('en', msg(`sheet.${kind}`)),
      candidate_file: candidateFile,
      master_file: masterFile,
      master_id: master.id,
      features: features.map((f) => `  - ${String(f)}`).join('\n'),
      round,
    },
    images: [candidateFile, masterFile],
    allowWrite: false,
    dataSchema: prompts.sheetCheckDataSchema(),
    fakeText: fakeText || '',
  });
  const data = result.data && result.data.check;
  if (!data || typeof data.same_identity !== 'boolean') {
    throw new OpError('ai_bad_result', msg('error.ai_bad_result', { tool: result.tool, detail: 'no identity check in the result' }));
  }
  const findings = (Array.isArray(data.findings) ? data.findings : [])
    .filter((f) => f && typeof f === 'object' && f.repair)
    .slice(0, 8)
    .map((f) => ({
      aspect: ['face', 'hair', 'build', 'mark', 'style'].includes(f.aspect) ? f.aspect : 'face',
      expected: String(f.expected || '').slice(0, 500),
      visible: String(f.visible || '').slice(0, 500),
      repair: String(f.repair || '').slice(0, 500),
    }));
  const same = data.same_identity === true && !findings.length;
  handle.log(`identity check of ${candidate.split('/').pop()}: ${same ? 'same person' : `${findings.length} difference(s)`}`);
  return { same, findings, tool: result.tool };
}

/**
 * Compile and draw one sheet candidate (and check it against the master
 * it was drawn from).
 * @param {object} ctx job context
 * @param {string} entityId CHAR_*, LOC_* or PROP_*
 * @param {string} kind turnaround | model | expressions | wardrobe | plate | prop | detail
 * @param {{outfit?: string, subject?: string, time?: string, prefix?: string, strict?: boolean,
 *          closeups?: string[], poses?: string[], expressions?: string[],
 *          revise?: string, changes?: object[], likeness?: string[], fakeText?: string}} [options]
 *   strict: fail instead of skipping when the sheet cannot be drawn yet.
 *   revise/changes/likeness: a revision of a full character sheet.
 * @returns {Promise<{candidate: string, candidate_id: string, record: string, kind: string,
 *          identity_check?: object, warning?: object}|{skipped: true, reason: string}>}
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
  const compileOptions = {
    sheet: kind,
    outfit: options.outfit || undefined,
    subject: options.subject || undefined,
    time: options.time || undefined,
    expressions: options.expressions && options.expressions.length ? options.expressions : undefined,
    closeups: options.closeups || undefined,
    poses: options.poses || undefined,
    revise: options.revise || undefined,
    changes: options.changes && options.changes.length ? options.changes : undefined,
    likeness: options.likeness && options.likeness.length ? options.likeness : undefined,
    model: target.model || undefined,
  };
  const compiled = await ctx.step(ids.compile, (h) => {
    const result = pipeline.compileSheet(root, entityId, target.provider, compileOptions);
    for (const note of result.notes) h.log(note);
    for (const warning of result.warnings) h.log(`warning: ${warning}`);
    return { package: result.rel, file: result.file, master: masterOfPackage(root, result.pkg) };
  });
  const drawn = await ctx.step(ids.draw, async (h) => {
    h.setTool('codex');
    const result = await pipeline.draw(ctx, h, compiled.file);
    h.note(result.file);
    return result;
  }, { verb: 'draw' });
  const stemOf = (file) => file.split('/').pop().replace(/\.[^.]+$/, '');
  const out = {
    candidate: drawn.file,
    candidate_id: stemOf(drawn.file),
    record: drawn.record,
    kind,
  };
  if (options.revise) out.from = options.revise;
  if (!compiled.master || options.check === false) return out;

  // Drawn from the master: check that it shows the same person.
  const check = async (stepId, candidate, round) => ctx.step(stepId, async (h) => {
    try {
      return await identityCheck(ctx, h, { entityId, kind, candidate, master: compiled.master, round, fakeText: options.fakeText });
    } catch (err) {
      rethrowIfFatal(err);
      if (err && err.code === 'no_tool') throw err;
      h.log(`identity check not made: ${err.message}`);
      return { same: null, findings: [], error: err.message };
    }
  }, { verb: 'look' });
  const save = (candidateId, result, redrawn) => {
    const verdict = result.same === true ? 'pass' : result.same === false ? 'flagged' : 'not_checked';
    const record = { verdict, master: compiled.master.id, findings: result.findings, redrawn, at: today() };
    identity.recordCheck(project, candidateId, record);
    return record;
  };
  const pick = ctx.services.drivers.pick('look', project.settings());
  if (!pick.available) {
    ctx.addStep({ id: ids.check, label: msg('step.sheet.check') }, { after: ids.draw });
    ctx.skipStep(ids.check, msg('skip.no_look_tool.sheet', { reason: pick.reason }));
    out.identity_check = save(out.candidate_id, { same: null, findings: [] }, false);
    return out;
  }
  ctx.addStep({ id: ids.check, label: msg('step.sheet.check') }, { after: ids.draw });
  const first = await check(ids.check, drawn.file, 1);
  if (first.same !== false) {
    out.identity_check = save(out.candidate_id, first, false);
    return out;
  }
  // One more drawing with what the check found, then the person decides.
  save(out.candidate_id, first, false);
  ctx.addStep({ id: ids.redraw, label: msg('step.sheet.redraw') }, { after: ids.check });
  ctx.addStep({ id: ids.recheck, label: msg('step.sheet.recheck') }, { after: ids.redraw });
  const again = await ctx.step(ids.redraw, async (h) => {
    h.setTool('codex');
    const corrections = first.findings.map((f) => `${f.repair} (${f.visible})`);
    const result = pipeline.compileSheet(root, entityId, target.provider, Object.assign({}, compileOptions, { corrections }));
    const made = await pipeline.draw(ctx, h, result.file);
    h.note(made.file);
    return made;
  }, { verb: 'draw' });
  const second = await check(ids.recheck, again.file, 2);
  out.first_candidate = out.candidate_id;
  out.candidate = again.file;
  out.candidate_id = stemOf(again.file);
  out.record = again.record;
  out.identity_check = save(out.candidate_id, second, true);
  if (second.same === false) out.warning = msg('sheet.identity_warning');
  return out;
}

module.exports = { steps, draw, KINDS, masterOfPackage };
