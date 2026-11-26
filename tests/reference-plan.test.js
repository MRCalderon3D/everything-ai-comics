'use strict';
/**
 * build-reference-plan.js: roles, order, the provider budget, the approval
 * rule, and the previous-render rule. Runs on a throwaway copy of the
 * fixture workspace in tests/fixtures/prompt-pipeline/.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const fx = require('./fixtures/prompt-pipeline/setup');
const ws = require('../scripts/lib/workspace');
const yaml = require('../scripts/lib/yaml');
const { validateDoc } = require('../scripts/lib/page-pipeline');
const { buildReferencePlan, roleOfAsset } = require('../scripts/build-reference-plan');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'build-reference-plan.js');
const NOW = new Date('2026-11-26T09:00:00Z');
const ROLES = ['style', 'identity', 'wardrobe', 'spatial_continuity', 'prop_consistency', 'composition', 'edit_target'];

const LOOK = 'LOOK_NOIR_INK_MASTER_V01';
const MARA = 'CHAR_MARA_TURN_MASTER_V01';
const MARA_COAT = 'CHAR_MARA_OILSKIN_MASTER_V01';
const OSKAR = 'CHAR_OSKAR_TURN_MASTER_V01';
const PLATE = 'LOC_FERRY_DECK_PLATE_MASTER_V01';
const GUN = 'PROP_FLARE_GUN_SHEET_MASTER_V01';
const PREV = 'PG_001_001_V01';

function plan(root, pageId, options = {}) {
  return buildReferencePlan(root, ws.loadPage(root, pageId), Object.assign({ now: NOW }, options)).doc;
}

function ids(entries) {
  return entries.map((e) => e.asset_id);
}

function byId(doc, id) {
  return [...doc.required, ...doc.optional].find((e) => e.asset_id === id);
}

function expectError(fn, code, pattern) {
  let caught = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `expected an error with code ${code}`);
  assert.strictEqual(caught.code, code, `expected code ${code}, got ${caught.code}: ${caught.message}`);
  if (pattern) assert.ok(pattern.test(caught.message), `message does not match ${pattern}: ${caught.message}`);
  return caught;
}

/** One role per entry, each asset once, valid enums, schema-valid. */
function assertWellFormed(doc) {
  const all = [...doc.required, ...doc.optional];
  assert.strictEqual(new Set(ids(all)).size, all.length, 'an asset appears once');
  for (const e of all) {
    assert.ok(ROLES.includes(e.role), `role ${e.role}`);
    assert.ok(['critical', 'high', 'medium', 'low'].includes(e.priority), `priority ${e.priority}`);
    assert.ok(e.reason && e.reason.length, `${e.asset_id}: reason`);
  }
  assert.ok(all.length <= doc.budget, 'the plan fits the provider budget');
  for (const id of doc.exclude) assert.ok(!ids(all).includes(id), `${id} is both attached and excluded`);
  const check = validateDoc('reference-plan', doc);
  assert.ok(check.valid, `violates reference-plan.schema.json: ${check.errors.join('; ')}`);
}

function testRolesAndOrder() {
  return fx.withWorkspace((root) => {
    // Page 1: Mara alone on panel; Oskar only has an off-panel ledger row.
    const p1 = plan(root, fx.PAGE_1);
    assertWellFormed(p1);
    assert.strictEqual(p1.page, fx.PAGE_1);
    assert.strictEqual(p1.provider, 'harness-native', 'provider comes from the page');
    assert.strictEqual(p1.budget, 4);
    assert.strictEqual(p1.created_at, '2026-11-26');
    assert.deepStrictEqual(ids(p1.required), [LOOK, MARA], 'look master first, then on-panel identities');
    assert.deepStrictEqual(p1.required[0],
      Object.assign({}, p1.required[0], { entity: 'LOOK_NOIR_INK', role: 'style', priority: 'critical' }));
    assert.strictEqual(byId(p1, MARA).role, 'identity');
    assert.strictEqual(byId(p1, MARA).priority, 'critical');
    assert.strictEqual(byId(p1, MARA).entity, 'CHAR_MARA');
    assert.ok(!byId(p1, OSKAR), 'an off-panel character needs no identity master');
    // optional: plate (high, no previous page), then the default-outfit sheet (medium)
    assert.deepStrictEqual(ids(p1.optional), [PLATE, MARA_COAT]);
    assert.strictEqual(byId(p1, PLATE).role, 'spatial_continuity');
    assert.strictEqual(byId(p1, PLATE).priority, 'high');
    assert.strictEqual(byId(p1, MARA_COAT).role, 'wardrobe');
    // Oskar's sheet is left out on purpose (off panel all page); the visible
    // flare gun is plot-relevant but does not fit the budget of 4
    assert.deepStrictEqual(p1.exclude, [OSKAR, GUN]);
    assert.ok(new RegExp(`${OSKAR} left out: Oskar is off panel on this whole page`).test(p1.notes));
    assert.ok(p1.notes.includes(GUN) && /does not fit/.test(p1.notes), 'dropped optional is explained');
    assert.ok(/enters_from is null/.test(p1.notes), 'first page has no previous render to attach');

    // Page 2: both characters drawn; the reviewed previous page is attached.
    const p2 = plan(root, fx.PAGE_2);
    assertWellFormed(p2);
    assert.deepStrictEqual(ids(p2.required), [LOOK, MARA, OSKAR]);
    assert.ok(p2.required.every((e) => e.priority === 'critical'));
    assert.deepStrictEqual(ids(p2.optional), [PREV]);
    assert.deepStrictEqual(byId(p2, PREV),
      Object.assign({}, byId(p2, PREV), { entity: null, role: 'spatial_continuity', priority: 'high' }));
    assert.deepStrictEqual(p2.exclude, [MARA_COAT, PLATE, GUN], 'optional entries drop lowest priority first');
    assert.ok(!ids([...p2.required, ...p2.optional]).includes('CHAR_OSKAR_TURN_V02'),
      'a newer sheet in review never replaces the approved master');

    // A style entry is never also identity.
    for (const doc of [p1, p2]) {
      assert.strictEqual(doc.required.filter((e) => e.role === 'style').length, 1);
      assert.strictEqual(doc.required[0].role, 'style');
    }

    // A roomier provider keeps everything.
    const roomy = plan(root, fx.PAGE_2, { providerId: 'comfyui' });
    assertWellFormed(roomy);
    assert.strictEqual(roomy.provider, 'comfyui');
    assert.strictEqual(roomy.budget, 8);
    assert.deepStrictEqual(ids(roomy.optional), [PREV, MARA_COAT, PLATE, GUN]);
    assert.strictEqual(byId(roomy, PLATE).priority, 'medium', 'the plate ranks below an attached previous page');
    assert.strictEqual(byId(roomy, GUN).role, 'prop_consistency');
    assert.deepStrictEqual(roomy.exclude, []);
    assert.strictEqual(roomy.notes, undefined);

    // Deterministic for the same inputs.
    assert.deepStrictEqual(plan(root, fx.PAGE_2), p2);
  });
}

function testBudgetOverflow() {
  return fx.withWorkspace((root) => {
    // Replicate takes one image; page 2 needs three required ones.
    const err = expectError(() => plan(root, fx.PAGE_2, { providerId: 'replicate' }), 'budget_exceeded',
      /needs 3 required reference images .* but replicate takes 1/);
    assert.ok(err.message.includes(LOOK) && err.message.includes(MARA) && err.message.includes(OSKAR),
      'the error lists the required images');
    assert.ok(/use a provider with a larger budget: comfyui \(8\)/.test(err.message),
      'the error names providers that fit');
    assert.ok(!/per_panel/.test(err.message), 'per_panel is not suggested when a single panel is already too full');
    assert.ok(/never dropped/.test(err.message));

    // When no panel holds the whole cast, per_panel is the concrete way out.
    const page = ws.loadPage(root, fx.PAGE_2);
    const split = JSON.parse(JSON.stringify(page));
    split.panels[1].cast = split.panels[1].cast.filter((r) => r.character === 'CHAR_MARA');
    split.panels[3].cast = split.panels[3].cast.filter((r) => r.character === 'CHAR_OSKAR');
    const two = { referenceImages: 2, aspectRatios: ['2:3'], imageEditing: true, textRendering: 'unreliable' };
    const tight = expectError(
      () => buildReferencePlan(root, split, { now: NOW, providerId: 'manual', capabilities: two }),
      'budget_exceeded', /set generation\.mode to per_panel .*fullest panel needs 2/);
    assert.ok(/takes 2/.test(tight.message));

    split.generation.mode = 'per_panel';
    const perPanel = buildReferencePlan(root, split, { now: NOW, providerId: 'manual', capabilities: two }).doc;
    assert.deepStrictEqual(ids(perPanel.required), [LOOK, MARA, OSKAR],
      'per_panel budgets each panel, so the page-level list may exceed one request');
    assert.deepStrictEqual(perPanel.optional, []);
    assert.ok(/Per-panel mode/.test(perPanel.notes));

    // per_panel does not rescue a panel that is itself over budget.
    const full = JSON.parse(JSON.stringify(page));
    full.generation.mode = 'per_panel';
    expectError(() => buildReferencePlan(root, full, { now: NOW, providerId: 'manual', capabilities: two }),
      'budget_exceeded', /panel PN_001_002_02 needs 3/);
  });
}

function testApprovalRule() {
  return fx.withWorkspace((root) => {
    const setStatus = (id, status) => fx.editYaml(root, 'references/manifest.yaml', (doc) => {
      doc.assets.find((a) => a.id === id).status = status;
    });

    // An on-panel character whose master is not approved is an error.
    setStatus(OSKAR, 'review');
    const err = expectError(() => plan(root, fx.PAGE_2), 'identity_unapproved',
      /CHAR_OSKAR is drawn on this page but has no approved identity master/);
    assert.ok(err.message.includes(`${OSKAR} is review`));
    // Page 1 only has Oskar off panel, so it still plans.
    assert.deepStrictEqual(ids(plan(root, fx.PAGE_1).required), [LOOK, MARA]);

    // No registered master at all.
    fx.editYaml(root, 'references/manifest.yaml', (doc) => {
      doc.assets = doc.assets.filter((a) => a.entity !== 'CHAR_OSKAR');
    });
    expectError(() => plan(root, fx.PAGE_2), 'identity_missing', /registers no identity master/);
  }).then(() => fx.withWorkspace((root) => {
    // The look master is required on every page and must be approved.
    fx.editYaml(root, 'references/manifest.yaml', (doc) => {
      doc.assets.find((a) => a.id === LOOK).status = 'draft';
    });
    expectError(() => plan(root, fx.PAGE_1), 'look_unapproved', /look master is not approved/);
    fx.editYaml(root, 'references/manifest.yaml', (doc) => {
      doc.assets = doc.assets.filter((a) => a.id !== LOOK);
    });
    expectError(() => plan(root, fx.PAGE_1), 'look_missing', /no look master is registered/);
  })).then(() => fx.withWorkspace((root) => {
    // An unapproved optional candidate is left out and explained, not an error.
    fx.editYaml(root, 'references/manifest.yaml', (doc) => {
      doc.assets.find((a) => a.id === PLATE).status = 'review';
    });
    const doc = plan(root, fx.PAGE_1);
    assert.ok(!byId(doc, PLATE));
    assert.ok(doc.exclude.includes(PLATE));
    assert.ok(new RegExp(`${PLATE} left out: .*is review, not approved`).test(doc.notes));

    // Assets a page names under references.required must be approved.
    fx.editYaml(root, `issues/ISS_001/pages/${fx.PAGE_1}/page.yaml`, (page) => {
      page.references.required.push(PLATE);
    });
    expectError(() => plan(root, fx.PAGE_1), 'reference_unapproved', /Only approved assets can be required/);
    fx.editYaml(root, `issues/ISS_001/pages/${fx.PAGE_1}/page.yaml`, (page) => {
      page.references.required = [LOOK, MARA, 'LOC_NOWHERE_PLATE_MASTER_V01'];
    });
    expectError(() => plan(root, fx.PAGE_1), 'reference_unregistered');
  })).then(() => fx.withWorkspace((root) => {
    // references.required promotes an optional candidate without changing its role.
    fx.editYaml(root, `issues/ISS_001/pages/${fx.PAGE_2}/page.yaml`, (page) => {
      page.references.required.push(PLATE);
    });
    const doc = plan(root, fx.PAGE_2);
    assert.deepStrictEqual(ids(doc.required), [LOOK, MARA, OSKAR, PLATE]);
    assert.strictEqual(byId(doc, PLATE).role, 'spatial_continuity');
    assert.deepStrictEqual(doc.optional, [], 'four required images fill the budget of four');
    assert.ok(doc.exclude.includes(PREV));
    assertWellFormed(doc);

    // A wardrobe sheet is required when the outfit is not the default one.
    fx.editYaml(root, 'characters/CHAR_MARA/character.yaml', (c) => { c.default_wardrobe = 'WARD_MARA_SUNDAY'; });
    const p1 = plan(root, fx.PAGE_1);
    assert.deepStrictEqual(ids(p1.required), [LOOK, MARA, MARA_COAT]);
    assert.strictEqual(byId(p1, MARA_COAT).priority, 'high');
  }));
}

function testPreviousRenderRule() {
  return fx.withWorkspace((root) => {
    const reviewFile = ws.reviewFile(root, PREV);

    // Unreviewed: excluded, and the notes say why.
    const saved = fs.readFileSync(reviewFile, 'utf8');
    fs.unlinkSync(reviewFile);
    const unreviewed = plan(root, fx.PAGE_2);
    assert.ok(!byId(unreviewed, PREV), 'an unreviewed render is never a reference');
    assert.ok(unreviewed.exclude.includes(PREV));
    assert.ok(new RegExp(`${PREV} left out: .*no visual review yet`).test(unreviewed.notes));
    assert.deepStrictEqual(ids(unreviewed.optional), [PLATE], 'its slot goes to the next optional entry');
    assert.strictEqual(byId(unreviewed, PLATE).priority, 'high');
    assertWellFormed(unreviewed);

    // Flagged: excluded as well.
    fs.writeFileSync(reviewFile, saved.replace('verdict: pass', 'verdict: flagged'));
    const flagged = plan(root, fx.PAGE_2);
    assert.ok(!byId(flagged, PREV) && flagged.exclude.includes(PREV));
    assert.ok(/verdict flagged/.test(flagged.notes));

    // Fixed counts as passing.
    fs.writeFileSync(reviewFile, saved.replace('verdict: pass', 'verdict: fixed'));
    assert.ok(byId(plan(root, fx.PAGE_2), PREV));
    fs.writeFileSync(reviewFile, saved);

    // Reviewed, but the file is gone.
    const renderFile = ws.renderFile(root, PREV);
    fs.renameSync(renderFile, `${renderFile}.bak`);
    const gone = plan(root, fx.PAGE_2);
    assert.ok(gone.exclude.includes(PREV) && /not on disk/.test(gone.notes));
    fs.renameSync(`${renderFile}.bak`, renderFile);

    // The page decides: attach_previous_render false leaves it out silently.
    fx.editYaml(root, `issues/ISS_001/pages/${fx.PAGE_2}/page.yaml`, (page) => {
      page.continuity.attach_previous_render = false;
    });
    const off = plan(root, fx.PAGE_2);
    assert.ok(!byId(off, PREV) && !off.exclude.includes(PREV));

    // A previous page with no render yet is a note, not an exclusion.
    fx.editYaml(root, `issues/ISS_001/pages/${fx.PAGE_2}/page.yaml`, (page) => {
      page.continuity.attach_previous_render = true;
    });
    fx.editYaml(root, `issues/ISS_001/pages/${fx.PAGE_1}/page.yaml`, (page) => { page.current_render = null; });
    assert.ok(/has no current render yet/.test(plan(root, fx.PAGE_2).notes));
  });
}

function testCli() {
  return fx.withWorkspace((root) => {
    const pageFile = fx.pageFile(root, fx.PAGE_2);
    const out = path.join(path.dirname(pageFile), 'reference-plan.yaml');
    const ok = spawnSync(process.execPath, [SCRIPT, '--page', pageFile], { encoding: 'utf8' });
    assert.strictEqual(ok.status, 0, ok.stderr);
    const written = yaml.parse(fs.readFileSync(out, 'utf8'));
    assert.strictEqual(written.page, fx.PAGE_2);
    assert.strictEqual(written.provider, 'harness-native');
    assert.deepStrictEqual(ids(written.required), [LOOK, MARA, OSKAR]);
    assert.deepStrictEqual(ids(written.optional), [PREV]);
    assert.ok(validateDoc('reference-plan', written).valid);

    // --provider overrides the page; an error exits 1 and writes nothing new.
    fs.unlinkSync(out);
    const bad = spawnSync(process.execPath, [SCRIPT, '--page', pageFile, '--provider', 'replicate'], { encoding: 'utf8' });
    assert.strictEqual(bad.status, 1);
    assert.ok(/replicate takes 1/.test(bad.stderr), bad.stderr);
    assert.ok(!fs.existsSync(out), 'no plan is written when a required reference does not fit');

    const missing = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.strictEqual(missing.status, 1);
    assert.ok(/--page/.test(missing.stderr));
  });
}

async function main() {
  assert.strictEqual(roleOfAsset({ id: 'X', kind: 'plate', default_role: 'composition' }), 'composition');
  assert.strictEqual(roleOfAsset({ id: 'X', kind: 'expressions' }), 'identity');
  assert.strictEqual(roleOfAsset({ id: 'PROP_X_V01', entity: 'PROP_X' }), 'prop_consistency');

  await testRolesAndOrder();
  await testBudgetOverflow();
  await testApprovalRule();
  await testPreviousRenderRule();
  await testCli();
  console.log('reference-plan: OK');
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
