'use strict';
/**
 * The cover of an issue: workspace helpers, compileCover (generate, overlay,
 * repair, budget), generation of a cover render, approval, and the cover
 * rules of validate-workspace.js. Runs on throwaway copies of the fixture
 * workspaces; nothing is written into the repository.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const fx = require('./fixtures/prompt-pipeline/setup');
const gates = require('./fixtures/gates/workspace-helper');
const ws = require('../scripts/lib/workspace');
const yaml = require('../scripts/lib/yaml');
const coverLib = require('../scripts/lib/cover');
const { validateDoc } = require('../scripts/lib/page-pipeline');
const { compileCover } = require('../scripts/compile-prompts');
const { generateAssets, collectPackages, runPackage, nextRenderId } = require('../scripts/generate-assets');
const { validateWorkspace } = require('../scripts/validate-workspace');
const { loadImageProvider } = require('../scripts/lib/providers');

const COMPILE = path.join(__dirname, '..', 'scripts', 'compile-prompts.js');
const GENERATE = path.join(__dirname, '..', 'scripts', 'generate-assets.js');
const COVER = 'issues/ISS_001/cover/cover.yaml';
const CHECK_KEYS = [
  'identity', 'cast_count', 'position', 'movement', 'role_causality', 'object_identity',
  'object_custody', 'physical_state', 'wardrobe', 'spatial_logic', 'drawing_clarity',
  'lettering', 'page_structure', 'style_fidelity',
];

function coverDoc(overrides = {}) {
  return Object.assign({
    id: 'CV_001',
    issue: 'ISS_001',
    concept: 'Mara stands in the wheelhouse doorway with the flare gun lowered.',
    composition: 'Low angle from the deck. The top third is left free for the title.',
    location: 'LOC_FERRY_DECK',
    time_of_day: 'night',
    cast: [{
      character: 'CHAR_MARA',
      wardrobe: 'WARD_MARA_OILSKIN',
      action: 'Stands in the doorway, flare gun lowered in her right hand.',
      acting: 'Still, eyes on the crates.',
      state: [],
      holding: ['PROP_FLARE_GUN'],
    }],
    props: [],
    lettering: { mode: 'in_image', title: 'The Night Ferry', issue_line: 'No. 1: Crossing', tagline: null, credits: null },
    generation: { provider: 'harness-native' },
    status: 'draft',
    approved_render: null,
  }, overrides);
}

/** A cover review in the visual-review shape. */
function coverReview(render, overrides = {}) {
  const checks = {};
  for (const key of CHECK_KEYS) {
    checks[key] = coverLib.NOT_APPLICABLE_CHECKS.includes(key)
      ? { result: 'not_applicable', evidence: 'A cover has no ledger and no sequence.' }
      : { result: 'pass', evidence: 'Matches cover.yaml and the references.' };
  }
  return Object.assign({
    page: 'CV_001',
    render,
    supersedes: null,
    reviewer: 'visual-reviewer',
    independent: true,
    compared_against: { references: ['LOOK_NOIR_INK_MASTER_V01'], neighbors: [] },
    checks,
    findings: [],
    gates: { style_fidelity: 'pass', narrative_continuity: 'pass' },
    verdict: 'pass',
    repair_cycle: 0,
    reviewed_at: '2026-11-26',
    human_approval: { status: 'pending', by: null, at: null },
  }, overrides);
}

function expectError(fn, code, pattern) {
  let caught = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `expected an error with code ${code}`);
  assert.strictEqual(caught.code, code, caught.message);
  if (pattern) assert.match(caught.message, pattern);
  return caught;
}

async function main() {
  // --- workspace helpers --------------------------------------------------------------------
  assert.ok(ws.ID.cover.test('CV_001') && !ws.ID.cover.test('CV_01') && !ws.ID.cover.test('PG_001_001'));
  assert.ok(ws.ID.coverRender.test('CV_001_V02') && !ws.ID.render.test('CV_001_V02'), 'ID.render stays page-only');
  assert.strictEqual(ws.coverIdOfIssue('ISS_012'), 'CV_012');
  assert.strictEqual(ws.issueOfCover('CV_012'), 'ISS_012');
  assert.strictEqual(ws.coverOfRender('CV_012_V03'), 'CV_012');
  assert.strictEqual(ws.coverOfRender('PG_001_001_V01'), null);
  assert.strictEqual(ws.coverIdOfIssue('PG_001_001'), null);

  await fx.withWorkspace(async (root) => {
    const coverDir = path.join(root, 'issues', 'ISS_001', 'cover');
    assert.strictEqual(ws.coverDir(root, 'ISS_001'), coverDir);
    assert.strictEqual(ws.coverDir(root, 'CV_001'), coverDir, 'the cover ID resolves to the same directory');
    assert.strictEqual(ws.loadCover(root, 'ISS_001'), null, 'no cover yet');
    assert.deepStrictEqual(ws.listCoverRenders(root, 'ISS_001'), []);
    assert.strictEqual(ws.renderFile(root, 'CV_001_V01'), null);
    assert.strictEqual(ws.reviewFile(root, 'CV_001_V01'), path.join(coverDir, 'reviews', 'CV_001_V01.review.yaml'));
    assert.strictEqual(ws.coverReviewFile(root, 'CV_001_V01'), ws.reviewFile(root, 'CV_001_V01'));

    // --- compileCover refuses without a cover -------------------------------------------------
    expectError(() => compileCover({ root, issue: 'ISS_001' }), 'cover_missing', /\/cover/);
    expectError(() => compileCover({ root, issue: 'PG_001_001' }), 'bad_arguments');

    fx.writeYaml(root, COVER, coverDoc());
    assert.strictEqual(ws.loadCover(root, 'CV_001').id, 'CV_001');

    // --- generate package ---------------------------------------------------------------------
    const first = compileCover({ root, issue: 'ISS_001' });
    const again = compileCover({ root, issue: 'ISS_001' });
    assert.strictEqual(first.pkg.prompt, again.pkg.prompt, 'the same inputs give the same prompt');
    const pkg = first.pkg;
    assert.strictEqual(pkg.id, 'PP_CV_001_HARNESS-NATIVE');
    assert.strictEqual(pkg.page, 'CV_001', 'a cover package names the cover as its page');
    assert.strictEqual(pkg.asset, null);
    assert.strictEqual(pkg.mode, 'generate');
    assert.strictEqual(pkg.status, 'compiled');
    assert.strictEqual(first.fileName, 'harness-native.yaml');
    assert.strictEqual(first.fileRel, 'issues/ISS_001/cover/prompts/harness-native.yaml');
    assert.ok(!fs.existsSync(fx.abs(root, first.fileRel)), 'compileCover writes nothing unless asked');
    assert.deepStrictEqual(Object.keys(first).sort(), ['fileName', 'fileRel', 'pkg', 'spec', 'warnings']);
    const check = validateDoc('prompt-package', pkg);
    assert.ok(check.valid, check.errors.join('; '));

    // The page aspect ratio and size.
    assert.deepStrictEqual(pkg.parameters, { aspect_ratio: '2:3', resolution: '2000x3000', seed: null });

    // The frozen style block opens the prompt, verbatim.
    const styleBlock = ws.loadStyleBlock(root);
    assert.ok(pkg.prompt.startsWith(`${styleBlock}\n\nCOVER\n`), 'style block first, then the cover header');
    assert.match(pkg.prompt, /one single full-bleed illustration, portrait format, aspect ratio 2:3/);
    assert.match(pkg.prompt, /No panel grid, no panel borders, no gutters/);
    assert.ok(!/PANELS, in reading order/.test(pkg.prompt), 'a cover has no panel list');

    // References: one role each, the look first, then identity, then what the budget allows.
    assert.deepStrictEqual(pkg.references.map((r) => [r.asset_id, r.role]), [
      ['LOOK_NOIR_INK_MASTER_V01', 'style'],
      ['CHAR_MARA_TURN_MASTER_V01', 'identity'],
      ['LOC_FERRY_DECK_PLATE_MASTER_V01', 'spatial_continuity'],
      ['PROP_FLARE_GUN_SHEET_MASTER_V01', 'prop_consistency'],
    ]);
    assert.strictEqual(new Set(pkg.references.map((r) => r.asset_id)).size, pkg.references.length);
    assert.match(pkg.prompt, /Image 1: drawing style only/);
    assert.match(pkg.prompt, /Image 2: identity of Mara\./);
    assert.match(pkg.prompt, /Image 3: the location Ferry deck\./);
    assert.match(pkg.prompt, /Image 4: the prop Flare gun\./);

    // Subject from cover.yaml and the bibles.
    assert.match(pkg.prompt, /Concept: Mara stands in the wheelhouse doorway with the flare gun lowered\./);
    assert.match(pkg.prompt, /Characters on the cover: 1 \(Mara\), each exactly once\./);
    assert.match(pkg.prompt, /Holding: Flare gun \(/);
    assert.match(pkg.prompt, /Time of day: night\./);

    // The cover's own lettering, in order, exact.
    assert.deepStrictEqual(pkg.lettering_text, ['The Night Ferry', 'No. 1: Crossing']);
    assert.match(pkg.prompt, /Letter the cover with exactly these 2 elements\./);
    assert.match(pkg.prompt, /1\. Title, the largest text on the cover: "The Night Ferry"/);
    assert.match(pkg.prompt, /2\. Issue line, small, close to the title: "No\. 1: Crossing"/);
    assert.match(pkg.prompt, /- No text other than the lettering listed above\./);
    assert.ok(first.warnings.some((w) => /renders text unreliably/.test(w)));

    // Hashes: the cover and the style block; a cover has no reference plan.
    assert.deepStrictEqual(Object.keys(pkg.source_hashes).sort(), ['page', 'style_block']);
    assert.strictEqual(pkg.source_hashes.page, coverLib.hashCover(ws.loadCover(root, 'ISS_001')));
    const approved = Object.assign(ws.loadCover(root, 'ISS_001'), { status: 'approved', approved_render: 'CV_001_V01' });
    assert.strictEqual(coverLib.hashCover(approved), pkg.source_hashes.page, 'approval does not change the hash');

    // --- two adjacent characters: the difference is stated ----------------------------------
    fx.editYaml(root, COVER, (doc) => {
      doc.cast.push({ character: 'CHAR_OSKAR', action: 'Crouches between the crates.' });
    });
    const two = compileCover({ root, issue: 'ISS_001' });
    assert.match(two.pkg.prompt, /Characters on the cover: 2 \(Mara and Oskar\), each exactly once\./);
    assert.match(two.pkg.prompt, /Mara is not Oskar\./);
    assert.match(two.pkg.prompt, /- Named characters on the cover: Mara and Oskar, each exactly once\./);
    // Five candidates, four slots: both identities stay, the last optional one goes.
    assert.deepStrictEqual(two.pkg.references.map((r) => r.role), ['style', 'identity', 'identity', 'spatial_continuity']);
    assert.ok(two.warnings.some((w) => /PROP_FLARE_GUN_SHEET_MASTER_V01 \(prop_consistency\) not attached/.test(w)));
    // Oskar's default outfit is described although the row names none.
    assert.match(two.pkg.prompt, /- Oskar\..*Wardrobe: /);

    // A provider that cannot hold the required images is refused, with the roomier ones named.
    expectError(() => compileCover({ root, issue: 'ISS_001', provider: 'replicate' }), 'budget_exceeded', /replicate takes 1/);
    fx.writeYaml(root, COVER, coverDoc());

    // --- overlay mode: no text in the art ----------------------------------------------------
    fx.editYaml(root, COVER, (doc) => { doc.lettering.mode = 'overlay'; });
    const overlay = compileCover({ root, issue: 'ISS_001' });
    assert.deepStrictEqual(overlay.pkg.lettering_text, []);
    assert.match(overlay.pkg.prompt, /None in the image: the title and the other cover text are added afterwards/);
    assert.match(overlay.pkg.prompt, /- No text anywhere in the image\./);
    assert.ok(!overlay.pkg.prompt.includes('"The Night Ferry"'), 'the title string is not sent in overlay mode');
    assert.match(overlay.pkg.negative_prompt, /lettering/);
    // Without its own mode the cover follows the project.
    fx.editYaml(root, COVER, (doc) => { delete doc.lettering.mode; });
    assert.strictEqual(coverLib.letteringMode(ws.loadCover(root, 'ISS_001'), ws.loadProject(root)), 'in_image');
    assert.strictEqual(coverLib.letteringMode({ lettering: {} }, { lettering: { mode: 'overlay' } }), 'overlay');
    fx.writeYaml(root, COVER, coverDoc());

    // --- --model, write, and the CLI -----------------------------------------------------------
    const pinned = compileCover({ root, issue: 'ISS_001', provider: 'fal', model: 'fal-ai/custom' });
    assert.strictEqual(pinned.pkg.id, 'PP_CV_001_FAL');
    assert.strictEqual(pinned.pkg.model, 'fal-ai/custom');
    assert.strictEqual(pinned.fileRel, 'issues/ISS_001/cover/prompts/fal.yaml');

    const written = compileCover({ root, issue: 'ISS_001', write: true });
    assert.deepStrictEqual(fx.readYaml(root, written.fileRel), written.pkg);

    fs.rmSync(fx.abs(root, written.fileRel));
    const cli = spawnSync(process.execPath, [COMPILE, '--cover', 'ISS_001', '--root', root], { encoding: 'utf8' });
    assert.strictEqual(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /prompt package: PP_CV_001_HARNESS-NATIVE \(cover, generate, harness-native/);
    assert.deepStrictEqual(fx.readYaml(root, 'issues/ISS_001/cover/prompts/harness-native.yaml'), written.pkg);
    const badCli = spawnSync(process.execPath, [COMPILE, '--cover', 'ISS_009', '--root', root], { encoding: 'utf8' });
    assert.strictEqual(badCli.status, 1);
    assert.match(badCli.stderr, /ISS_009 has no cover/);
    const mixed = spawnSync(process.execPath, [COMPILE, '--cover', 'ISS_001', '--page', 'x', '--root', root], { encoding: 'utf8' });
    assert.strictEqual(mixed.status, 1);
    assert.match(mixed.stderr, /--cover and --page cannot be combined/);

    // --- generation: dry run ---------------------------------------------------------------
    const net = fx.blockNetwork();
    try {
      assert.strictEqual(nextRenderId(root, 'CV_001'), 'CV_001_V01');
      const dry = await generateAssets({ cover: 'ISS_001', root, log: () => {} });
      assert.strictEqual(dry.live, false);
      assert.strictEqual(dry.results.length, 1);
      const record = dry.results[0].record;
      assert.strictEqual(record.id, 'GEN_CV_001_01');
      assert.strictEqual(record.page, 'CV_001');
      assert.strictEqual(record.status, 'dry_run');
      assert.strictEqual(record.prompt_package, 'PP_CV_001_HARNESS-NATIVE');
      assert.strictEqual(record.output_render, 'CV_001_V01');
      assert.deepStrictEqual(dry.results[0].warnings.filter((w) => /violates/.test(w)), [], 'the record follows its schema');
      assert.ok(validateDoc('generation-record', record).valid);
      assert.strictEqual(ws.rel(root, dry.results[0].recordFile), 'generations/CV_001/GEN_CV_001_01.yaml');
      const request = JSON.parse(fs.readFileSync(dry.results[0].requestFile, 'utf8'));
      assert.strictEqual(request.meta.output_path, 'issues/ISS_001/cover/renders/CV_001_V01.png');
      assert.strictEqual(request.meta.output_render, 'CV_001_V01');
      assert.deepStrictEqual(ws.listCoverRenders(root, 'ISS_001'), [], 'a dry run draws nothing');
      assert.strictEqual(net.calls, 0);

      // The second attempt takes the next record number.
      const dry2 = await generateAssets({ cover: 'ISS_001', root, log: () => {} });
      assert.strictEqual(dry2.results[0].record.id, 'GEN_CV_001_02');

      // --- generation: a provider that returns an image -------------------------------------
      const real = loadImageProvider('harness-native');
      const drawing = Object.assign({}, real, {
        async generate(spec, options) {
          const record = await real.generate(spec, options);
          return Object.assign(record, { status: 'succeeded', _media: [{ data_base64: fx.PNG.toString('base64'), format: 'png' }] });
        },
      });
      const item = collectPackages({ cover: 'ISS_001', root }).items[0];
      const live1 = await runPackage(item, { live: true, providerModule: drawing });
      assert.strictEqual(live1.record.output_render, 'CV_001_V01');
      assert.deepStrictEqual(live1.record.media_files, ['issues/ISS_001/cover/renders/CV_001_V01.png']);
      assert.ok(fs.readFileSync(ws.renderFile(root, 'CV_001_V01')).equals(fx.PNG));
      // Again: the next free version, and V01 is untouched.
      fs.writeFileSync(ws.renderFile(root, 'CV_001_V01'), 'first version, must survive');
      const live2 = await runPackage(item, { live: true, providerModule: drawing });
      assert.strictEqual(live2.record.output_render, 'CV_001_V02');
      assert.deepStrictEqual(ws.listCoverRenders(root, 'CV_001'), ['CV_001_V01', 'CV_001_V02']);
      assert.strictEqual(fs.readFileSync(ws.renderFile(root, 'CV_001_V01'), 'utf8'), 'first version, must survive');
      // A review file alone reserves its version number.
      fx.writeYaml(root, 'issues/ISS_001/cover/reviews/CV_001_V05.review.yaml', coverReview('CV_001_V05'));
      assert.strictEqual(nextRenderId(root, 'CV_001'), 'CV_001_V06');
      fs.rmSync(fx.abs(root, 'issues/ISS_001/cover/reviews/CV_001_V05.review.yaml'));

      // A changed cover.yaml makes the package stale: a warning in a dry run, a refusal live.
      fx.editYaml(root, COVER, (doc) => { doc.concept = 'Mara alone at the wheel.'; });
      const stale = await runPackage(item, { live: false });
      assert.ok(stale.warnings.some((w) => /cover\.yaml of CV_001 changed after this package was compiled/.test(w)));
      await assert.rejects(runPackage(item, { live: true, providerModule: drawing }), (err) => err.code === 'package_stale');
      fx.writeYaml(root, COVER, coverDoc());

      // Selection errors.
      assert.throws(() => collectPackages({ cover: 'ISS_002', root }), (err) => err.code === 'cover_missing');
      assert.throws(() => collectPackages({ cover: 'CV_001', root }), (err) => err.code === 'bad_arguments');
      assert.throws(() => collectPackages({ cover: 'ISS_001', root, provider: 'fal' }), (err) => err.code === 'package_missing');
      assert.throws(() => collectPackages({ cover: 'ISS_001', page: 'x', root }), (err) => err.code === 'bad_arguments');

      const genCli = spawnSync(process.execPath, [GENERATE, '--cover', 'ISS_001', '--root', root], { encoding: 'utf8' });
      assert.strictEqual(genCli.status, 0, genCli.stderr);
      assert.match(genCli.stdout, /DRY_RUN GEN_CV_001_\d{2}/);
      assert.match(genCli.stdout, /target:\s+issues\/ISS_001\/cover\/renders\/CV_001_V03\.png \(render CV_001_V03\)/);
    } finally {
      net.restore();
    }

    // --- repair --------------------------------------------------------------------------------
    const flagged = coverReview('CV_001_V01', {
      verdict: 'flagged',
      gates: { style_fidelity: 'pass', narrative_continuity: 'fail' },
      findings: [{
        id: 'F01',
        panel: null,
        check: 'lettering',
        expected: 'The title reads THE NIGHT FERRY',
        visible: 'The title reads THE NIGHT FERY',
        severity: 'blocking',
        repair: 'Correct the spelling of the title',
        status: 'open',
        region: { x: 0.1, y: 0.05, w: 0.8, h: 0.2 },
      }],
    });
    flagged.checks.lettering = { result: 'fail', evidence: 'One letter is missing from the title.' };
    const reviewRel = 'issues/ISS_001/cover/reviews/CV_001_V01.review.yaml';
    fx.writeYaml(root, reviewRel, flagged);
    assert.deepStrictEqual(ws.loadReview(root, 'CV_001_V01').findings.length, 1, 'loadReview resolves a cover render');

    const repair = compileCover({ root, issue: 'ISS_001', repair: fx.abs(root, reviewRel) });
    assert.strictEqual(repair.pkg.mode, 'repair');
    assert.strictEqual(repair.pkg.edit_target, 'issues/ISS_001/cover/renders/CV_001_V01.png');
    assert.strictEqual(repair.pkg.repair.of_render, 'CV_001_V01');
    assert.deepStrictEqual(repair.pkg.repair.findings, ['F01']);
    assert.match(repair.pkg.repair.changes[0], /^In the area from 10% to 90% of the width .* and from 5% to 25% of the height .*: Correct the spelling of the title\. Expected result: The title reads THE NIGHT FERRY\.$/);
    assert.ok(repair.pkg.repair.locked.some((l) => /All lettering that CHANGES does not name/.test(l)));
    assert.match(repair.pkg.prompt, /REPAIR\nEdit Image 1, the rendered cover\./);
    assert.match(repair.pkg.prompt, /Image 1: the rendered cover to edit\./);
    assert.match(repair.pkg.prompt, /PLANNED CONTENT OF THE COVER\nConcept: /);
    assert.match(repair.pkg.prompt, /- Still one single image: no panels, no borders, no insets\./);
    // The edit target takes one of the four slots: the last optional reference gives way.
    assert.deepStrictEqual(repair.pkg.references.map((r) => r.role), ['style', 'identity', 'spatial_continuity']);
    assert.ok(validateDoc('prompt-package', repair.pkg).valid, validateDoc('prompt-package', repair.pkg).errors.join('; '));
    // The review document works as well as its path.
    assert.strictEqual(compileCover({ root, issue: 'ISS_001', repair: flagged }).pkg.prompt, repair.pkg.prompt);

    const repairCli = spawnSync(process.execPath, [COMPILE, '--cover', 'ISS_001', '--root', root, '--repair', fx.abs(root, reviewRel)], { encoding: 'utf8' });
    assert.strictEqual(repairCli.status, 0, repairCli.stderr);
    assert.match(repairCli.stdout, /repair of CV_001_V01: findings F01/);

    // Refusals: a page review, nothing open, the repair limit, a missing render.
    expectError(() => compileCover({ root, issue: 'ISS_001', repair: Object.assign({}, flagged, { page: 'PG_001_001' }) }), 'review_mismatch');
    expectError(() => compileCover({ root, issue: 'ISS_001', repair: coverReview('CV_001_V01') }), 'nothing_to_repair');
    expectError(() => compileCover({ root, issue: 'ISS_001', repair: Object.assign({}, flagged, { repair_cycle: 2 }) }), 'repair_limit');
    expectError(() => compileCover({ root, issue: 'ISS_001', repair: Object.assign({}, flagged, { render: 'CV_001_V09' }) }), 'edit_target_missing');
    expectError(() => compileCover({ root, issue: 'ISS_001', repair: path.join(root, 'missing.review.yaml') }), 'review_missing');

    // --- approval ------------------------------------------------------------------------------
    expectError(() => coverLib.approveCover({ root, issue: 'ISS_001', render: 'CV_001_V01' }), 'review_required', /flagged/);
    expectError(() => coverLib.approveCover({ root, issue: 'ISS_001', render: 'CV_001_V02' }), 'review_required', /no review/);
    expectError(() => coverLib.approveCover({ root, issue: 'ISS_001', render: 'CV_001_V09' }), 'render_missing');
    expectError(() => coverLib.approveCover({ root, issue: 'ISS_001', render: 'PG_001_001_V01' }), 'render_mismatch');
    expectError(() => coverLib.approveCover({ root, issue: 'ISS_002', render: 'CV_002_V01' }), 'cover_missing');
    assert.strictEqual(ws.loadCover(root, 'ISS_001').status, 'draft', 'a refused approval changes nothing');

    // cover.yaml with comments: approval edits two lines and keeps the rest.
    fs.writeFileSync(fx.abs(root, COVER), [
      '# The cover of the first issue.',
      yaml.stringify(coverDoc()).replace('status: draft', 'status: draft                          # draft | approved').trimEnd(),
      '',
    ].join('\n'));
    fx.writeYaml(root, 'issues/ISS_001/cover/reviews/CV_001_V02.review.yaml', coverReview('CV_001_V02', { supersedes: 'CV_001_V01', verdict: 'pass' }));
    const done = coverLib.approveCover({ root, issue: 'ISS_001', render: 'CV_001_V02' });
    assert.deepStrictEqual(done, { cover: 'CV_001', render: 'CV_001_V02', file: COVER, previous: null, preserved: true });
    const afterText = fs.readFileSync(fx.abs(root, COVER), 'utf8');
    assert.match(afterText, /^# The cover of the first issue\.\n/);
    assert.match(afterText, /^status: approved {2}# draft \| approved$/m);
    assert.match(afterText, /^approved_render: CV_001_V02$/m);
    assert.deepStrictEqual(ws.loadCover(root, 'ISS_001'), coverDoc({ status: 'approved', approved_render: 'CV_001_V02' }));
    // The cover ID works in place of the issue ID, and the earlier approval is reported.
    fx.writeYaml(root, reviewRel, coverReview('CV_001_V01'));
    const switched = coverLib.approveCover({ root, issue: 'CV_001', render: 'CV_001_V01' });
    assert.strictEqual(switched.previous, 'CV_001_V02');
    assert.strictEqual(ws.loadCover(root, 'ISS_001').approved_render, 'CV_001_V01');
    assert.ok(fs.existsSync(ws.renderFile(root, 'CV_001_V02')), 'the earlier render stays on disk');
  });

  // --- validate-workspace: cover rules --------------------------------------------------------
  {
    const run = gates.sharedWorkspace();
    const REVIEW = 'issues/ISS_001/cover/reviews/CV_001_V01.review.yaml';
    const RENDER = 'issues/ISS_001/cover/renders/CV_001_V01.png';
    const EDITION = 'editions/ED_001_01/edition.yaml';
    /** Add a clean, approved cover, break it with `mutate`, and validate with the real schemas. */
    const validate = (mutate) => run((w) => {
      w.write(COVER, coverDoc({ status: 'approved', approved_render: 'CV_001_V01' }));
      w.touch(RENDER);
      w.write(REVIEW, coverReview('CV_001_V01'));
      if (mutate) mutate(w);
    }, (w) => validateWorkspace(w.root));
    const codesOf = (result) => result.errors.map((e) => e.code);
    const hasError = (result, code, file) => {
      assert.ok(result.errors.some((e) => e.code === code && (!file || e.file === file)),
        `expected ${code}${file ? ` on ${file}` : ''}, got ${JSON.stringify(result.errors, null, 1)}`);
    };

    const baseline = run(null, (w) => validateWorkspace(w.root));
    assert.deepStrictEqual(baseline.errors, [], 'the fixture is clean before a cover is added');
    const clean = validate();
    assert.deepStrictEqual(clean.errors, [], JSON.stringify(clean.errors, null, 1));
    assert.deepStrictEqual(clean.warnings, baseline.warnings);

    hasError(validate((w) => w.edit(COVER, (c) => { c.id = 'CV_002'; })), 'ID_PATH_MISMATCH', COVER);
    hasError(validate((w) => w.edit(COVER, (c) => { c.issue = 'ISS_002'; })), 'ID_PATH_MISMATCH', COVER);
    hasError(validate((w) => w.edit(COVER, (c) => { c.location = 'LOC_NOWHERE'; })), 'UNKNOWN_ENTITY', COVER);
    hasError(validate((w) => w.edit(COVER, (c) => { c.cast[0].character = 'CHAR_NOBODY'; })), 'UNKNOWN_ENTITY', COVER);
    hasError(validate((w) => w.edit(COVER, (c) => { c.cast[0].wardrobe = 'WARD_MARA_GOWN'; })), 'UNKNOWN_WARDROBE', COVER);
    hasError(validate((w) => w.edit(COVER, (c) => { c.cast[0].holding = ['PROP_ANCHOR']; })), 'UNKNOWN_ENTITY', COVER);
    hasError(validate((w) => w.edit(COVER, (c) => { c.cast.push(Object.assign({}, c.cast[0])); })), 'COVER_CAST_DUPLICATE', COVER);
    hasError(validate((w) => w.edit(COVER, (c) => { c.props = ['PROP_FLARE_GUN']; })), 'COVER_PROP_HELD', COVER);
    hasError(validate((w) => w.edit(COVER, (c) => { delete c.concept; })), 'SCHEMA', COVER);
    hasError(validate((w) => w.edit(COVER, (c) => { c.status = 'review'; })), 'SCHEMA', COVER);
    hasError(validate((w) => w.remove(COVER)), 'MISSING_FILE', COVER);

    // Approval needs a render on disk with a passing review.
    hasError(validate((w) => w.remove(REVIEW)), 'COVER_APPROVAL_UNREVIEWED', COVER);
    hasError(validate((w) => w.edit(REVIEW, (r) => {
      r.verdict = 'flagged';
      r.gates.style_fidelity = 'fail';
    })), 'COVER_APPROVAL_UNREVIEWED', COVER);
    hasError(validate((w) => w.edit(COVER, (c) => { c.approved_render = null; })), 'COVER_APPROVAL_UNREVIEWED', COVER);
    hasError(validate((w) => w.edit(COVER, (c) => { c.approved_render = 'CV_002_V01'; })), 'ID_PATH_MISMATCH', COVER);
    hasError(validate((w) => w.remove(RENDER)), 'MISSING_RENDER', COVER);
    hasError(validate((w) => w.edit(COVER, (c) => { c.status = 'draft'; })), 'COVER_STATUS_MISMATCH', COVER);
    // A draft cover with a flagged review is a normal state.
    const draft = validate((w) => {
      w.edit(COVER, (c) => { c.status = 'draft'; c.approved_render = null; });
      w.edit(REVIEW, (r) => { r.verdict = 'flagged'; r.gates.style_fidelity = 'fail'; });
    });
    assert.deepStrictEqual(draft.errors, [], JSON.stringify(draft.errors, null, 1));

    // Cover reviews follow the review rules, plus the two cover additions.
    hasError(validate((w) => w.edit(REVIEW, (r) => { r.page = 'PG_001_001'; })), 'ID_PATH_MISMATCH', REVIEW);
    hasError(validate((w) => w.edit(REVIEW, (r) => { r.render = 'CV_001_V02'; })), 'ID_PATH_MISMATCH', REVIEW);
    hasError(validate((w) => w.edit(REVIEW, (r) => { r.checks.position = { result: 'pass', evidence: 'Mara is in the doorway.' }; })),
      'COVER_REVIEW_CHECK', REVIEW);
    hasError(validate((w) => w.edit(REVIEW, (r) => { r.checks.movement.result = 'fail'; })), 'COVER_REVIEW_CHECK', REVIEW);
    hasError(validate((w) => w.edit(REVIEW, (r) => {
      r.verdict = 'flagged';
      r.findings = [{
        id: 'F01', panel: 'PN_001_001_01', check: 'identity', expected: 'Mara', visible: 'Not Mara',
        severity: 'blocking', repair: 'Redraw the face', status: 'open',
      }];
    })), 'COVER_REVIEW_PANEL', REVIEW);
    hasError(validate((w) => w.edit(REVIEW, (r) => {
      r.findings = [{ id: 'F01', panel: null, check: 'identity', expected: 'Mara', visible: 'Not Mara', severity: 'blocking', repair: 'Redraw', status: 'open' }];
    })), 'REVIEW_PASS_NOT_CLEAN', REVIEW);
    hasError(validate((w) => w.edit(REVIEW, (r) => { r.repair_cycle = 5; })), 'REVIEW_REPAIR_LIMIT', REVIEW);
    hasError(validate((w) => {
      w.write('issues/ISS_001/cover/reviews/CV_001_V02.review.yaml', coverReview('CV_001_V02'));
    }), 'MISSING_RENDER', 'issues/ISS_001/cover/reviews/CV_001_V02.review.yaml');

    // Cover prompt packages and generation records.
    const PKG = 'issues/ISS_001/cover/prompts/harness-native.yaml';
    const withPackage = (change) => validate((w) => {
      // The gate fixture has no style block file, so the test supplies the text.
      const pkg = compileCover({ root: w.root, issue: 'ISS_001', styleBlock: 'High-contrast ink noir.' }).pkg;
      if (change) change(pkg);
      w.write(PKG, pkg);
    });
    assert.deepStrictEqual(withPackage().errors, []);
    hasError(withPackage((pkg) => { pkg.page = 'PG_001_001'; }), 'ID_PATH_MISMATCH', PKG);
    hasError(withPackage((pkg) => { pkg.references[0].asset_id = 'LOOK_NOIR_INK_MASTER_V09'; }), 'UNKNOWN_ASSET', PKG);
    const GEN = 'generations/CV_001/GEN_CV_001_01.yaml';
    const record = (render) => ({
      id: 'GEN_CV_001_01', page: 'CV_001', asset: null, provider: 'harness-native', model: 'unreported', kind: 'image',
      prompt_package: 'PP_CV_001_HARNESS-NATIVE', output_render: render,
      cost: { currency: 'USD', amount: null, estimated: false, reported: false },
      seed: null, metadata_unavailable: ['model', 'cost', 'seed'], status: 'succeeded', created_at: '2026-11-26T10:00:00Z',
    });
    assert.deepStrictEqual(validate((w) => w.write(GEN, record('CV_001_V01'))).errors, []);
    hasError(validate((w) => w.write(GEN, record('CV_001_V04'))), 'MISSING_RENDER', GEN);

    // The cover of an edition: a reviewed cover render of the same issue.
    const withEditionCover = (cover, more) => validate((w) => {
      w.edit(EDITION, (e) => { e.cover = cover; });
      if (more) more(w);
    });
    const listed = { render: 'CV_001_V01', file: RENDER, lettered_file: null };
    assert.deepStrictEqual(withEditionCover(listed).errors, []);
    hasError(withEditionCover({ render: 'CV_002_V01', file: RENDER }), 'EDITION_RENDER_MISMATCH', EDITION);
    hasError(withEditionCover({ render: 'CV_001_V01', file: 'issues/ISS_001/cover/renders/CV_001_V07.png' }), 'EDITION_RENDER_MISSING', EDITION);
    hasError(withEditionCover(Object.assign({}, listed, { lettered_file: 'issues/ISS_001/cover/renders/CV_001_V01.lettered.png' })),
      'EDITION_RENDER_MISSING', EDITION);
    hasError(withEditionCover({ render: 'PG_001_001_V01', file: RENDER }), 'SCHEMA', EDITION);
    // The fixture edition is reviewed, so an unreviewed cover is an error; in a draft it is a warning.
    const unreviewed = withEditionCover(listed, (w) => {
      w.remove(REVIEW);
      w.edit(COVER, (c) => { c.status = 'draft'; c.approved_render = null; });
    });
    hasError(unreviewed, 'EDITION_RENDER_UNREVIEWED', EDITION);
    const draftEdition = withEditionCover(listed, (w) => {
      w.remove(REVIEW);
      w.edit(COVER, (c) => { c.status = 'draft'; c.approved_render = null; });
      w.edit(EDITION, (e) => { e.status = 'draft'; });
    });
    assert.ok(!codesOf(draftEdition).includes('EDITION_RENDER_UNREVIEWED'));
    assert.ok(draftEdition.warnings.some((x) => x.code === 'EDITION_RENDER_UNREVIEWED' && /CV_001_V01 is listed as the cover/.test(x.message)));

    // --issue keeps another issue's cover records out of scope.
    const scoped = run((w) => {
      w.write('generations/CV_002/GEN_CV_002_01.yaml', Object.assign(record('CV_002_V01'), { id: 'GEN_CV_002_01', page: 'CV_002' }));
    }, (w) => validateWorkspace(w.root, { issue: 'ISS_001' }));
    assert.ok(!scoped.errors.some((e) => e.file.startsWith('generations/CV_002')), JSON.stringify(scoped.errors, null, 1));
    gates.cleanupAll();
  }

  // --- the template and the example ---------------------------------------------------------
  {
    const repo = path.join(__dirname, '..');
    const template = yaml.parse(fs.readFileSync(path.join(repo, 'templates', 'cover', 'cover.yaml'), 'utf8'));
    const result = validateDoc('cover', template);
    assert.ok(result.valid, result.errors.join('; '));
    assert.strictEqual(template.status, 'draft');
    assert.strictEqual(template.approved_render, null);

    const example = path.join(repo, 'examples', 'the-night-ferry');
    const cover = ws.loadCover(example, 'ISS_001');
    assert.strictEqual(cover.status, 'approved');
    assert.ok(ws.renderFile(example, cover.approved_render), 'the approved render is on disk');
    assert.ok(ws.reviewPasses(ws.loadReview(example, cover.approved_render)));
    // The shipped package is what the compiler produces from the shipped files.
    const shipped = ws.loadYaml(path.join(ws.coverDir(example, 'ISS_001'), 'prompts', 'harness-native.yaml'));
    assert.deepStrictEqual(shipped, compileCover({ root: example, issue: 'ISS_001' }).pkg, 'recompile the example cover package');
  }

  console.log('cover: OK');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
