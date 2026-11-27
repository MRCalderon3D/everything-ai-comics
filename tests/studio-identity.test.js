'use strict';
/**
 * The identity chain and the full character sheet in the studio, in fake
 * mode:
 *
 * 1. A character made from a photo: the first turnaround attaches the photo
 *    as a likeness source, and no identity check runs (there is no master).
 * 2. Expressions and wardrobe sheets are refused before a drawn master is
 *    approved; a photo is not an identity.
 * 3. After approval, the expressions sheet attaches the master and not the
 *    photo, and is checked against it: a failed check draws it once more
 *    with what the check found.
 * 4. The full character sheet: the person's close-ups and poses are saved
 *    in the character file, the sheet is drawn from the approved turnaround.
 * 5. A revision round: the previous version is the edit target, the change
 *    goes into the character file, the next version is drawn. Approving a
 *    version makes it the identity master that pages use.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { start } = require('../studio/test-support/harness');
const ws = require('../scripts/lib/workspace');
const yaml = require('../scripts/lib/yaml');
const { findIdentityChain } = require('../scripts/build-reference-plan');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64');

function done(job, label) {
  assert.strictEqual(job.status, 'done', `${label}: ${job.status} ${JSON.stringify(job.error)}`);
  return job;
}

function stepIds(job) {
  return job.steps.map((s) => s.id);
}

async function main() {
  const started = Date.now();
  const s = await start();
  try {
    const id = await s.seedProject('Identity Chain');
    const P = `/api/projects/${id}`;
    const root = path.join(s.home, id, 'production');
    const pkgOf = (rel) => yaml.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

    // --- 1. a character from a photo ---------------------------------------------------------
    const photo = await s.upload(id, 'lia.png', PNG, 'image/png');
    let job = done(await s.runOp(id, 'character.create', {
      name: 'Lia', description: 'A painter with a scar on her left forearm. SHEETFLAG', uploads: [photo.id],
    }), 'character.create from a photo');
    assert.strictEqual(job.result.sheet.candidate_id, 'CHAR_LIA_TURN_V01');
    assert.ok(!stepIds(job).includes('sheet-check'), 'the first sheet has no master to be checked against');
    let pkg = pkgOf('characters/CHAR_LIA/refs/prompts/codex-cli.turnaround.yaml');
    assert.deepStrictEqual(pkg.references.map((r) => [r.asset_id, r.role]),
      [[pkg.references[0].asset_id, 'style'], ['CHAR_LIA_REF_V01', 'identity']], 'the photo goes to the first turnaround as a likeness source');
    assert.ok(/for likeness only/.test(pkg.prompt));

    // --- 2. nothing is drawn from a photo or an unapproved candidate ---------------------------
    let r = await s.api('POST', `${P}/ops`, { op: 'character.sheet', params: { character: 'CHAR_LIA', sheet: 'expressions' } });
    assert.deepStrictEqual([r.status, r.body.error.code], [409, 'master_required']);
    assert.ok(/never from a photo/.test(r.body.error.message), r.body.error.message);
    r = await s.api('POST', `${P}/ops`, { op: 'character.sheet', params: { character: 'CHAR_LIA', sheet: 'wardrobe' } });
    assert.strictEqual(r.status, 409);
    r = await s.api('GET', `${P}/characters/CHAR_LIA`);
    assert.strictEqual(r.body.has_identity, false, 'a photo is not an identity');
    assert.deepStrictEqual([r.body.identity.needs_master, r.body.identity.photos], [true, ['CHAR_LIA_REF_V01']]);
    r = await s.api('GET', `${P}/characters`);
    assert.strictEqual(r.body.characters.find((c) => c.id === 'CHAR_LIA').has_identity, false);

    // --- 3. approved master: expressions drawn from it, checked against it ---------------------
    r = await s.api('POST', `${P}/approve/asset`, { candidate: 'CHAR_LIA_TURN_V01' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    job = done(await s.runOp(id, 'character.sheet', { character: 'CHAR_LIA', sheet: 'expressions' }), 'expressions');
    pkg = pkgOf('characters/CHAR_LIA/refs/prompts/codex-cli.expressions.yaml');
    assert.deepStrictEqual(pkg.references.filter((x) => x.role === 'identity').map((x) => x.asset_id), ['CHAR_LIA_TURN_MASTER_V01'],
      'the master, never the photo');
    assert.deepStrictEqual(stepIds(job).slice(-5), ['sheet-compile', 'sheet-draw', 'sheet-check', 'sheet-redraw', 'sheet-recheck']);
    const sheet = job.result.sheet;
    assert.deepStrictEqual([sheet.first_candidate, sheet.candidate_id], ['CHAR_LIA_EXPR_V01', 'CHAR_LIA_EXPR_V02'], 'one more drawing after a failed check');
    assert.deepStrictEqual([sheet.identity_check.verdict, sheet.identity_check.redrawn, sheet.identity_check.master], ['pass', true, 'CHAR_LIA_TURN_MASTER_V01']);
    assert.ok(!sheet.warning);
    assert.ok(/\n\nCORRECTIONS\n/.test(pkg.prompt) && /face long and narrow/.test(pkg.prompt), 'the redraw carries what the check found');
    r = await s.api('GET', `${P}/characters/CHAR_LIA`);
    assert.strictEqual(r.body.identity.master.id, 'CHAR_LIA_TURN_MASTER_V01');
    const checks = Object.fromEntries(r.body.sheets.expressions.candidates.map((c) => [c.id, c.check && c.check.verdict]));
    assert.deepStrictEqual(checks, { CHAR_LIA_EXPR_V01: 'flagged', CHAR_LIA_EXPR_V02: 'pass' });

    // --- 4. the full character sheet ---------------------------------------------------------
    r = await s.api('GET', `${P}/characters/CHAR_LIA`);
    assert.ok(Array.isArray(r.body.sheet_plan.closeups) && r.body.sheet_plan.closeups.length > 0, 'default close-ups from the features');
    assert.ok(r.body.sheet_plan.poses.includes('neutral'));
    r = await s.api('POST', `${P}/ops`, { op: 'character.sheet', params: { character: 'CHAR_LIA', sheet: 'turnaround', poses: ['x'] } });
    assert.strictEqual(r.status, 400, 'close-ups and poses belong to the full sheet');
    job = done(await s.runOp(id, 'character.sheet', {
      character: 'CHAR_LIA', sheet: 'model', closeups: ['left forearm: a long scar'], poses: ['tired', 'painting'],
    }), 'full sheet');
    assert.ok(stepIds(job).includes('plan'));
    assert.deepStrictEqual(ws.loadCharacter(root, 'CHAR_LIA').sheet, { closeups: ['left forearm: a long scar'], poses: ['tired', 'painting'] });
    pkg = pkgOf('characters/CHAR_LIA/refs/prompts/codex-cli.model.yaml');
    assert.strictEqual(pkg.parameters.aspect_ratio, '3:2');
    assert.ok(pkg.references.some((x) => x.asset_id === 'CHAR_LIA_TURN_MASTER_V01' && x.role === 'identity'), 'drawn from the approved turnaround');
    assert.ok(pkg.prompt.includes('1. "left forearm": a long scar.') || pkg.prompt.includes('1. "left forearm": a long scar;') || pkg.prompt.includes('"left forearm": a long scar'), pkg.prompt);
    const firstModel = job.result.sheet.candidate_id;
    assert.ok(/^CHAR_LIA_MODEL_V0\d$/.test(firstModel), firstModel);

    // --- 5. a revision round -----------------------------------------------------------------
    r = await s.api('POST', `${P}/ops`, { op: 'character.sheet', params: { character: 'CHAR_LIA', sheet: 'model', revise: 'CHAR_LIA_MODEL_V09', text: 'x' } });
    assert.deepStrictEqual([r.status, r.body.error.code], [409, 'revise_target_missing']);
    r = await s.api('POST', `${P}/ops`, { op: 'character.sheet', params: { character: 'CHAR_LIA', sheet: 'model', revise: 'latest' } });
    assert.strictEqual(r.status, 400, 'a revision says what to change');
    r = await s.api('POST', `${P}/ops`, { op: 'character.sheet', params: { character: 'CHAR_LIA', sheet: 'model', text: 'shorter hair' } });
    assert.strictEqual(r.status, 400, 'a change goes with the version it changes');
    job = done(await s.runOp(id, 'character.sheet', {
      character: 'CHAR_LIA', sheet: 'model', revise: firstModel, text: 'shorter hair', region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    }), 'revision');
    assert.deepStrictEqual(stepIds(job), ['write', 'sheet-compile', 'sheet-draw']);
    assert.strictEqual(job.result.from, firstModel);
    const next = job.result.sheet.candidate_id;
    assert.ok(next > firstModel && /^CHAR_LIA_MODEL_V\d{2}$/.test(next), `${firstModel} -> ${next}`);
    pkg = pkgOf('characters/CHAR_LIA/refs/prompts/codex-cli.model.yaml');
    assert.strictEqual(pkg.mode, 'repair');
    assert.strictEqual(pkg.edit_target, `characters/CHAR_LIA/refs/${firstModel}.png`);
    assert.ok(/^In the area from 10% to 30% of the width .*: Shorter hair\.$/.test(pkg.repair.changes[0]), pkg.repair.changes[0]);
    assert.ok(job.steps.find((x) => x.id === 'write').status === 'done', 'the character file follows the change');

    r = await s.api('GET', `${P}/characters/CHAR_LIA`);
    const versions = r.body.model_versions.map((v) => v.id);
    assert.ok(versions.includes(firstModel) && versions.indexOf(next) === versions.length - 1, versions.join(', '));
    assert.ok(versions.every((v, i) => !i || v > versions[i - 1]), 'oldest first');

    // Approving a version makes it the identity master; approving another replaces it.
    r = await s.api('POST', `${P}/approve/asset`, { candidate: next });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    let chain = findIdentityChain(ws.loadReferenceAssets(root), 'CHAR_LIA', ws.loadCharacter(root, 'CHAR_LIA'));
    assert.strictEqual(chain.master.id, `${next.replace(/_V(\d{2})$/, '_MASTER_V$1')}`, 'the full sheet outranks the turnaround');
    r = await s.api('POST', `${P}/approve/asset`, { candidate: firstModel, supersede: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    chain = findIdentityChain(ws.loadReferenceAssets(root), 'CHAR_LIA', ws.loadCharacter(root, 'CHAR_LIA'));
    assert.strictEqual(chain.master.id, firstModel.replace(/_V(\d{2})$/, '_MASTER_V$1'), 'going back to an earlier version');
    assert.strictEqual(ws.loadReferenceAssets(root).get(next.replace(/_V(\d{2})$/, '_MASTER_V$1')).status, 'superseded');
    r = await s.api('GET', `${P}/characters/CHAR_LIA`);
    assert.deepStrictEqual([r.body.has_identity, r.body.identity.master.kind], [true, 'model']);
  } finally {
    await s.close();
  }
  console.log(`studio-identity: ok (${Date.now() - started} ms)`);
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
