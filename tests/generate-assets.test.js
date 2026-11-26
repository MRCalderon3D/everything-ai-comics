'use strict';
/**
 * generate-assets.js: dry-run by default with no network call, the comics
 * generation record, attempt numbering, render version increments, the
 * --live/--yes gate, and media that never overwrites a render. Runs on a
 * throwaway copy of the fixture workspace in tests/fixtures/prompt-pipeline/.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const fx = require('./fixtures/prompt-pipeline/setup');
const ws = require('../scripts/lib/workspace');
const yaml = require('../scripts/lib/yaml');
const { validateDoc } = require('../scripts/lib/page-pipeline');
const { buildReferencePlan } = require('../scripts/build-reference-plan');
const { compilePage, compileAsset } = require('../scripts/compile-prompts');
const assetPaths = require('../scripts/lib/asset-paths');
const gen = require('../scripts/generate-assets');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'generate-assets.js');
const NOW = new Date('2026-11-26T09:00:00Z');
const quiet = () => {};

/** Plan + compile a page for a provider and write both files, as the CLIs do. */
function prepare(root, pageId, providerId, options = {}) {
  const page = ws.loadPage(root, pageId);
  const dir = fx.pageDir(root, pageId);
  const { doc } = buildReferencePlan(root, page, { now: NOW, providerId });
  fs.writeFileSync(path.join(dir, 'reference-plan.yaml'), yaml.stringify(doc));
  const { pkg, fileName } = compilePage(root, page, Object.assign({ providerId }, options));
  const file = path.join(dir, 'prompts', fileName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.stringify(pkg));
  return { pkg, file };
}

function assertRecordValid(record) {
  const check = validateDoc('generation-record', record);
  assert.ok(check.valid, `violates generation-record.schema.json: ${check.errors.join('; ')}`);
}

function listFiles(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

async function expectReject(promise, code, pattern) {
  let caught = null;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `expected a rejection with code ${code}`);
  assert.strictEqual(caught.code, code, `expected code ${code}, got ${caught.code}: ${caught.message}`);
  if (pattern) assert.ok(pattern.test(caught.message), caught.message);
}

function testEstimates() {
  assert.strictEqual(gen.estimateCost({ provider: 'gemini', model: 'gemini-2.5-flash-image' }), 0.039);
  assert.strictEqual(gen.estimateCost({ provider: 'gemini', model: 'some/other-model' }), null,
    'a pinned model without a list price has no estimate');
  assert.strictEqual(gen.estimateCost({ provider: 'fal', model: 'pending' }), 0.025);
  assert.strictEqual(gen.estimateCost({ provider: 'comfyui', model: 'anything.safetensors' }), 0);
  assert.strictEqual(gen.estimateCost({ provider: 'harness-native', model: 'harness-native' }), null,
    'handoff providers are never estimated');
  assert.strictEqual(gen.estimateCost({ provider: 'manual', model: 'manual' }), null);
  assert.deepStrictEqual(gen.scopeOf({ id: 'PP_PG_001_002_FAL', page: 'PG_001_002', provider: 'fal' }),
    { scope: 'PG_001_002', page: 'PG_001_002', asset: null });
  // Asset scope is the entity: records live under generations/<ENTITY_ID>/.
  assert.deepStrictEqual(gen.scopeOf({ id: 'PP_CHAR_OSKAR_HARNESS-NATIVE-TURN', page: null, asset: 'CHAR_OSKAR', provider: 'harness-native' }),
    { scope: 'CHAR_OSKAR', page: null, asset: 'CHAR_OSKAR' });
  // Without an asset field the ID inside the package ID is the fallback.
  assert.deepStrictEqual(gen.scopeOf({ id: 'PP_CHAR_OSKAR_TURN_V02_HARNESS-NATIVE', page: null, asset: null, provider: 'harness-native' }),
    { scope: 'CHAR_OSKAR_TURN_V02', page: null, asset: 'CHAR_OSKAR_TURN_V02' });
  assert.strictEqual(gen.scopeOf({ id: 'PP_X', page: null, asset: null, provider: 'fal' }), null);
}

function testDryRun() {
  return fx.withWorkspace(async (root) => {
    const { pkg } = prepare(root, fx.PAGE_2, 'harness-native');
    const pageFile = fx.pageFile(root, fx.PAGE_2);
    const genDir = fx.abs(root, `generations/${fx.PAGE_2}`);
    const rendersDir = path.join(fx.pageDir(root, fx.PAGE_2), 'renders');
    const rendersBefore = listFiles(rendersDir);
    const network = fx.blockNetwork();
    const lines = [];
    try {
      // Dry run is the default: no flag asks for it.
      const outcome = await gen.generateAssets({ page: pageFile, log: (l) => lines.push(l) });
      assert.strictEqual(network.calls, 0, 'a dry run calls no network');
      assert.strictEqual(outcome.live, false);
      assert.deepStrictEqual(outcome.failures, []);
      assert.strictEqual(outcome.results.length, 1);
      assert.ok(lines[0].includes('mode: DRY RUN'));
      assert.ok(/estimated total cost: \$0\.000 .*plus 1 package\(s\) with no estimate/.test(lines[1]),
        'the cost estimate is printed first');

      // The record: comics shape, page scope, nothing invented.
      const { record, recordFile, requestFile } = outcome.results[0];
      assert.strictEqual(recordFile, path.join(genDir, 'GEN_PG_001_002_01.yaml'));
      const onDisk = yaml.parse(fs.readFileSync(recordFile, 'utf8'));
      assert.deepStrictEqual(onDisk, record, 'the record on disk is the record returned');
      assertRecordValid(onDisk);
      assert.strictEqual(onDisk.id, 'GEN_PG_001_002_01');
      assert.strictEqual(onDisk.page, fx.PAGE_2);
      assert.strictEqual(onDisk.asset, null);
      assert.strictEqual(onDisk.provider, 'harness-native');
      assert.strictEqual(onDisk.kind, 'image');
      assert.strictEqual(onDisk.prompt_package, pkg.id);
      assert.strictEqual(onDisk.status, 'dry_run');
      assert.strictEqual(onDisk.model, 'unreported');
      assert.deepStrictEqual(onDisk.cost, { currency: 'USD', amount: null, estimated: false, reported: false });
      assert.strictEqual(onDisk.seed, null);
      assert.deepStrictEqual(onDisk.metadata_unavailable, ['model', 'cost', 'seed']);
      assert.deepStrictEqual(onDisk.media_files, []);
      assert.strictEqual(onDisk.request.endpoint, null);
      // V01 exists and has a review, so the next free render is V02.
      assert.strictEqual(onDisk.output_render, 'PG_001_002_V02');
      const targetPath = 'issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V02.png';
      assert.ok(onDisk.notes.includes(targetPath), 'the handoff notes name the target output path');

      // The handoff package: prompt, ordered references with roles, target path.
      assert.strictEqual(requestFile, path.join(genDir, 'GEN_PG_001_002_01.request.json'));
      const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
      assert.strictEqual(request.handoff, true);
      assert.strictEqual(request.endpoint, null);
      assert.strictEqual(request.body.prompt, pkg.prompt, 'the handoff carries the compiled prompt unchanged');
      assert.deepStrictEqual(request.body.images.map((i) => [i.position, i.asset_id, i.role]), [
        [1, 'LOOK_NOIR_INK_MASTER_V01', 'style'],
        [2, 'CHAR_MARA_TURN_MASTER_V01', 'identity'],
        [3, 'CHAR_OSKAR_TURN_MASTER_V01', 'identity'],
        [4, 'PG_001_001_V01', 'spatial_continuity'],
      ]);
      assert.ok(request.body.images.every((i) => fs.existsSync(fx.abs(root, i.image_path))));
      assert.deepStrictEqual(request.body.output, { render: 'PG_001_002_V02', path: targetPath });
      assert.strictEqual(request.meta.record_id, 'GEN_PG_001_002_01');

      // No render file is created or touched by a dry run.
      assert.deepStrictEqual(listFiles(rendersDir), rendersBefore);
      assert.deepStrictEqual(listFiles(genDir), ['GEN_PG_001_002_01.request.json', 'GEN_PG_001_002_01.yaml']);

      // Second run: next attempt number, same planned render (nothing was saved).
      const second = await gen.generateAssets({ page: pageFile, log: quiet });
      assert.strictEqual(second.results[0].record.id, 'GEN_PG_001_002_02');
      assert.strictEqual(second.results[0].record.output_render, 'PG_001_002_V02');
      assert.ok(fs.existsSync(path.join(genDir, 'GEN_PG_001_002_02.yaml')));
      assert.strictEqual(yaml.parse(fs.readFileSync(recordFile, 'utf8')).id, 'GEN_PG_001_002_01', 'earlier records stay');

      // Render version increment: once V02 is on disk the next one is V03.
      fx.writePng(root, 'issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V02.png');
      const third = await gen.generateAssets({ page: pageFile, log: quiet });
      assert.strictEqual(third.results[0].record.id, 'GEN_PG_001_002_03');
      assert.strictEqual(third.results[0].record.output_render, 'PG_001_002_V03');

      // --package runs one file; a provider filter that does not match skips it.
      const byPackage = await gen.generateAssets({ package: outcome.results[0].file, log: quiet });
      assert.strictEqual(byPackage.results[0].record.id, 'GEN_PG_001_002_04');
      await expectReject(gen.generateAssets({ package: outcome.results[0].file, provider: 'fal', log: quiet }),
        'nothing_to_generate');

      // Handoff providers stay dry_run and offline even with --live --yes.
      const live = await gen.generateAssets({ page: pageFile, live: true, yes: true, log: quiet });
      assert.strictEqual(live.results[0].record.status, 'dry_run');
      assert.deepStrictEqual(live.results[0].record.media_files, []);
      assert.strictEqual(network.calls, 0, 'handoff providers never call the network');
    } finally {
      network.restore();
    }
  });
}

function testVersionHelpers() {
  return fx.withWorkspace((root) => {
    // A page with no renders starts at V01.
    fs.rmSync(path.join(fx.pageDir(root, fx.PAGE_2), 'renders'), { recursive: true });
    fs.rmSync(path.join(fx.pageDir(root, fx.PAGE_2), 'reviews'), { recursive: true });
    assert.strictEqual(gen.nextRenderId(root, fx.PAGE_2), 'PG_001_002_V01');
    assert.strictEqual(gen.nextRenderId(root, fx.PAGE_1), 'PG_001_001_V02');
    // Versions are never reused: a gap or a jpg sibling still moves on.
    fx.writePng(root, 'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V04.jpg');
    assert.strictEqual(gen.nextRenderId(root, fx.PAGE_1), 'PG_001_001_V05');
    // A review of a render whose file was moved away still reserves its number.
    fs.mkdirSync(path.join(fx.pageDir(root, fx.PAGE_2), 'reviews'), { recursive: true });
    fs.writeFileSync(path.join(fx.pageDir(root, fx.PAGE_2), 'reviews', 'PG_001_002_V03.review.yaml'), 'page: PG_001_002\nrender: PG_001_002_V03\n');
    assert.strictEqual(gen.nextRenderId(root, fx.PAGE_2), 'PG_001_002_V04');

    const dir = fx.abs(root, 'generations/PG_001_001');
    assert.strictEqual(gen.nextAttempt(dir, 'PG_001_001'), 1);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'GEN_PG_001_001_01.yaml'), 'id: GEN_PG_001_001_01\n');
    fs.writeFileSync(path.join(dir, 'GEN_PG_001_001_07.yaml'), 'id: GEN_PG_001_001_07\n');
    fs.writeFileSync(path.join(dir, 'GEN_PG_001_001_09.request.json'), '{}');
    assert.strictEqual(gen.nextAttempt(dir, 'PG_001_001'), 8, 'next free attempt, request files do not count');
  });
}

function testLiveGate() {
  return fx.withWorkspace(async (root) => {
    prepare(root, fx.PAGE_1, 'gemini');
    const pageFile = fx.pageFile(root, fx.PAGE_1);
    const genDir = fx.abs(root, `generations/${fx.PAGE_1}`);
    const network = fx.blockNetwork();
    const savedKey = process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      // API provider dry run: the addressed model and a flagged estimate.
      const lines = [];
      const dry = await gen.generateAssets({ page: pageFile, provider: 'gemini', log: (l) => lines.push(l) });
      assert.ok(/estimated total cost: \$0\.039/.test(lines[1]));
      const record = dry.results[0].record;
      assertRecordValid(record);
      assert.strictEqual(record.status, 'dry_run');
      assert.strictEqual(record.model, 'gemini-2.5-flash-image');
      assert.deepStrictEqual(record.cost, { currency: 'USD', amount: 0.039, estimated: true, reported: false });
      assert.deepStrictEqual(record.metadata_unavailable, ['cost', 'seed']);
      assert.strictEqual(record.output_render, 'PG_001_001_V02');
      assert.ok(/generativelanguage\.googleapis\.com/.test(record.request.endpoint));
      const request = JSON.parse(fs.readFileSync(dry.results[0].requestFile, 'utf8'));
      assert.ok(!JSON.stringify(request).includes('inline_data'), 'the request spec on disk carries no image bytes');
      assert.strictEqual(network.calls, 0);

      // --live without --yes: refused after the estimate, nothing written.
      const before = listFiles(genDir);
      const gateLines = [];
      await expectReject(gen.generateAssets({ page: pageFile, provider: 'gemini', live: true, log: (l) => gateLines.push(l) }),
        'confirmation_required', /re-run with --yes/);
      assert.ok(gateLines.some((l) => /estimated total cost/.test(l)), 'the estimate is printed before the refusal');
      assert.deepStrictEqual(listFiles(genDir), before, 'a refused live run writes nothing');
      assert.strictEqual(network.calls, 0);

      // --live --yes without the env var: the provider refuses before any request.
      const noKey = await gen.generateAssets({ page: pageFile, provider: 'gemini', live: true, yes: true, log: quiet });
      assert.strictEqual(noKey.results.length, 0);
      assert.strictEqual(noKey.failures.length, 1);
      assert.ok(/GOOGLE_API_KEY/.test(noKey.failures[0]));
      assert.strictEqual(network.calls, 0, 'no request without credentials');

      // A live run refuses a package whose page changed after compiling.
      process.env.GOOGLE_API_KEY = 'test-key-not-real';
      fx.editYaml(root, `issues/ISS_001/pages/${fx.PAGE_1}/page.yaml`, (page) => { page.panels[0].moment = 'Changed.'; });
      const stale = await gen.generateAssets({ page: pageFile, provider: 'gemini', live: true, yes: true, log: quiet });
      assert.ok(/changed after this package was compiled/.test(stale.failures[0]));
      assert.strictEqual(network.calls, 0);
      // ...while a dry run only warns.
      const staleDry = await gen.generateAssets({ page: pageFile, provider: 'gemini', log: quiet });
      assert.ok(staleDry.results[0].warnings.some((w) => /re-run compile-prompts/.test(w)));

      // A live run refuses when an input image is missing from disk.
      prepare(root, fx.PAGE_1, 'gemini');
      fs.unlinkSync(fx.abs(root, 'characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png'));
      const missing = await gen.generateAssets({ page: pageFile, provider: 'gemini', live: true, yes: true, log: quiet });
      assert.ok(/input image\(s\) not on disk: characters\/CHAR_MARA\/refs\/CHAR_MARA_TURN_MASTER_V01\.png/.test(missing.failures[0]));
      assert.strictEqual(network.calls, 0);

      // No key ever reaches a record or a request spec.
      for (const name of listFiles(genDir)) {
        assert.ok(!fs.readFileSync(path.join(genDir, name), 'utf8').includes('test-key-not-real'), `${name} leaked the key`);
      }
    } finally {
      if (savedKey === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = savedKey;
      network.restore();
    }
  });
}

function testLiveResultIsSavedAsNewVersion() {
  return fx.withWorkspace(async (root) => {
    // A stand-in provider that "succeeds" with inline bytes, to exercise the
    // saving path without any network.
    const { pkg, file } = prepare(root, fx.PAGE_2, 'gemini');
    const real = require('../providers/image/gemini');
    const common = require('../providers/lib/common');
    const bytes = Buffer.from('new render bytes');
    const fake = Object.assign({}, real, {
      async generate(spec) {
        const record = common.makeRecord(spec, { status: 'pending' });
        record._media = [{ data_base64: bytes.toString('base64'), format: 'png' }];
        return common.markSucceeded(record, 'Stand-in returned 1 image.', ['inline image 1 (png)']);
      },
    });
    const v01 = path.join(fx.pageDir(root, fx.PAGE_2), 'renders', 'PG_001_002_V01.png');
    const v01Before = fs.readFileSync(v01);

    const first = await gen.runPackage({ file, pkg, root }, { live: true, providerModule: fake });
    assert.strictEqual(first.record.status, 'succeeded');
    assert.strictEqual(first.record.output_render, 'PG_001_002_V02');
    assert.deepStrictEqual(first.record.media_files, ['issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V02.png']);
    assert.ok(fs.readFileSync(fx.abs(root, first.record.media_files[0])).equals(bytes));
    assert.ok(fs.readFileSync(v01).equals(v01Before), 'the earlier render is untouched');
    assert.ok(!('_media' in first.record), 'raw bytes never reach the record');
    assertRecordValid(yaml.parse(fs.readFileSync(first.recordFile, 'utf8')));

    // The next attempt is a sibling version, never an overwrite.
    const second = await gen.runPackage({ file, pkg, root }, { live: true, providerModule: fake });
    assert.strictEqual(second.record.id, 'GEN_PG_001_002_02');
    assert.strictEqual(second.record.output_render, 'PG_001_002_V03');
    assert.deepStrictEqual(ws.listRenders(root, fx.PAGE_2), ['PG_001_002_V01', 'PG_001_002_V02', 'PG_001_002_V03']);

    // persistMedia moves on when a file appears under the planned name.
    const record = { id: 'GEN_PG_001_002_09', media_files: [], _media: [{ data_base64: bytes.toString('base64'), format: 'jpeg' }] };
    fx.writePng(root, 'issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V04.png');
    await gen.persistMedia(record, { root, page: fx.PAGE_2, fullPage: true, dir: fx.abs(root, 'generations/PG_001_002') });
    assert.strictEqual(record.output_render, 'PG_001_002_V05');
    assert.deepStrictEqual(record.media_files, ['issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V05.jpg']);

    // A failed download keeps the URL and says so; nothing is invented.
    const remote = { id: 'GEN_PG_001_002_10', media_files: ['https://example.invalid/out.png'] };
    await gen.persistMedia(remote, {
      root, page: fx.PAGE_2, fullPage: true, dir: fx.abs(root, 'generations/PG_001_002'),
      fetchImpl: async () => { throw new Error('offline'); },
    });
    assert.deepStrictEqual(remote.media_files, ['https://example.invalid/out.png']);
    assert.strictEqual(remote.output_render, null);
    assert.ok(/could not download image 1 \(offline\)/.test(remote.notes));
    // A successful download lands as the next version.
    const fetched = { id: 'GEN_PG_001_002_11', media_files: ['https://example.invalid/out.webp?sig=1'] };
    await gen.persistMedia(fetched, {
      root, page: fx.PAGE_2, fullPage: true, dir: fx.abs(root, 'generations/PG_001_002'),
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }),
    });
    assert.deepStrictEqual(fetched.media_files, ['issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V06.webp']);
    assert.strictEqual(fetched.output_render, 'PG_001_002_V06');
  });
}

function testIssueAndAssetScope() {
  return fx.withWorkspace(async (root) => {
    const network = fx.blockNetwork();
    try {
      prepare(root, fx.PAGE_1, 'harness-native');
      prepare(root, fx.PAGE_2, 'harness-native');
      const issueDir = fx.abs(root, 'issues/ISS_001');

      // --issue: pages in reading order; a reviewed page is skipped.
      const outcome = await gen.generateAssets({ issue: issueDir, log: quiet });
      assert.deepStrictEqual(outcome.results.map((r) => r.record.page), [fx.PAGE_2]);
      assert.ok(outcome.skipped.some((s) => /PG_001_001: status reviewed/.test(s)));
      assert.ok(!fs.existsSync(fx.abs(root, `generations/${fx.PAGE_1}`)));

      // A page without a compiled package is reported, not fatal, in a batch.
      fx.editYaml(root, `issues/ISS_001/pages/${fx.PAGE_1}/page.yaml`, (page) => { page.status = 'scripted'; });
      fs.rmSync(path.join(fx.pageDir(root, fx.PAGE_2), 'prompts'), { recursive: true });
      const batch = await gen.generateAssets({ issue: issueDir, log: quiet });
      assert.deepStrictEqual(batch.results.map((r) => r.record.page), [fx.PAGE_1]);
      assert.ok(batch.skipped.some((s) => /PG_001_002: no prompt package for harness-native/.test(s)));
      // ...but --page for that page is an error that names the fix.
      await expectReject(gen.generateAssets({ page: fx.pageFile(root, fx.PAGE_2), log: quiet }),
        'package_missing', /compile-prompts\.js/);

      // Selection errors.
      await expectReject(gen.generateAssets({ log: quiet }), 'bad_arguments');
      await expectReject(gen.generateAssets({ page: fx.pageFile(root, fx.PAGE_1), issue: issueDir, log: quiet }), 'bad_arguments');
      await expectReject(gen.generateAssets({ issue: fx.abs(root, 'issues'), log: quiet }), 'issue_missing');

      // A hand-written asset package with no sheet tag in its ID: the record
      // still lives under the entity, there is no render, and the target
      // sits next to the record because no sheet kind names a candidate.
      const assetPackage = fx.abs(root, 'characters/CHAR_OSKAR/prompts/harness-native.yaml');
      fs.mkdirSync(path.dirname(assetPackage), { recursive: true });
      fs.writeFileSync(assetPackage, yaml.stringify({
        id: 'PP_CHAR_OSKAR_HARNESS-NATIVE',
        page: null,
        asset: 'CHAR_OSKAR',
        provider: 'harness-native',
        model: 'harness-native',
        mode: 'generate',
        prompt: 'Character turnaround sheet: front, three-quarter, profile, back.',
        negative_prompt: '',
        parameters: { aspect_ratio: '3:2', seed: null },
        references: [{ asset_id: 'LOOK_NOIR_INK_MASTER_V01', role: 'style', image_path: 'references/style/LOOK_NOIR_INK_MASTER_V01.png' }],
        edit_target: null,
        lettering_text: [],
        status: 'compiled',
        source_hashes: { style_block: '9a8b7c6d5e4f3a20' },
      }));
      const asset = await gen.generateAssets({ package: assetPackage, log: quiet });
      const record = asset.results[0].record;
      assertRecordValid(record);
      assert.strictEqual(asset.results[0].recordFile,
        fx.abs(root, 'generations/CHAR_OSKAR/GEN_CHAR_OSKAR_01.yaml'));
      assert.strictEqual(record.id, 'GEN_CHAR_OSKAR_01');
      assert.strictEqual(record.page, null);
      assert.strictEqual(record.asset, 'CHAR_OSKAR');
      assert.strictEqual(record.output_render, null);
      const request = JSON.parse(fs.readFileSync(asset.results[0].requestFile, 'utf8'));
      assert.deepStrictEqual(request.body.output,
        { render: null, path: 'generations/CHAR_OSKAR/GEN_CHAR_OSKAR_01.png' });
      assert.ok(asset.results[0].warnings.some((w) => /style block changed/.test(w)), 'a stale style block hash is flagged');

      // A per-panel package yields a panel image, not a page render.
      const panel = prepare(root, fx.PAGE_1, 'harness-native', { panel: 'PN_001_001_02' });
      const panelRun = await gen.generateAssets({ package: panel.file, log: quiet });
      assert.strictEqual(panelRun.results[0].record.page, fx.PAGE_1);
      assert.strictEqual(panelRun.results[0].record.output_render, null);
      assert.strictEqual(panelRun.results[0].record.prompt_package, 'PP_PG_001_001_HARNESS-NATIVE-P02');
      assertRecordValid(panelRun.results[0].record);

      assert.strictEqual(network.calls, 0);
    } finally {
      network.restore();
    }
  });
}

function testCli() {
  return fx.withWorkspace((root) => {
    prepare(root, fx.PAGE_2, 'harness-native');
    const pageFile = fx.pageFile(root, fx.PAGE_2);
    const env = Object.assign({}, process.env);
    for (const name of ['FAL_KEY', 'REPLICATE_API_TOKEN', 'COMFYUI_HOST', 'GOOGLE_API_KEY']) delete env[name];

    const dry = spawnSync(process.execPath, [SCRIPT, '--page', pageFile], { encoding: 'utf8', env });
    assert.strictEqual(dry.status, 0, dry.stderr);
    assert.ok(/mode: DRY RUN/.test(dry.stdout));
    assert.ok(/DRY_RUN GEN_PG_001_002_01 \[harness-native, model unreported\] no estimate/.test(dry.stdout), dry.stdout);
    assert.ok(/target:\s+issues\/ISS_001\/pages\/PG_001_002\/renders\/PG_001_002_V02\.png \(render PG_001_002_V02\)/.test(dry.stdout));
    assert.ok(fs.existsSync(fx.abs(root, 'generations/PG_001_002/GEN_PG_001_002_01.yaml')));

    // --live without --yes exits 1 after printing the estimate.
    const gate = spawnSync(process.execPath, [SCRIPT, '--page', pageFile, '--live'], { encoding: 'utf8', env });
    assert.strictEqual(gate.status, 1);
    assert.ok(/estimated total cost/.test(gate.stdout));
    assert.ok(/re-run with --yes/.test(gate.stderr), gate.stderr);
    assert.ok(!fs.existsSync(fx.abs(root, 'generations/PG_001_002/GEN_PG_001_002_02.yaml')));

    const none = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env });
    assert.strictEqual(none.status, 1);
    assert.ok(/exactly one of --package, --page, --issue, --asset/.test(none.stderr));
  });
}

/** Compile a sheet and write its package where the CLI would. */
function prepareSheet(root, entityId, options) {
  const { pkg, fileRel } = compileAsset(root, entityId, options);
  const file = fx.abs(root, fileRel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.stringify(pkg));
  return { pkg, file, fileRel };
}

function testSheets() {
  return fx.withWorkspace(async (root) => {
    const network = fx.blockNetwork();
    try {
      // Candidate naming: next free version, masters counted, never _MASTER.
      assert.deepStrictEqual(assetPaths.nextCandidate(root, 'CHAR_MARA', 'TURN'),
        { id: 'CHAR_MARA_TURN_V02', version: 2, rel: 'characters/CHAR_MARA/refs/CHAR_MARA_TURN_V02.png' },
        'CHAR_MARA_TURN_MASTER_V01 exists, so the next candidate is V02');
      assert.strictEqual(assetPaths.nextCandidate(root, 'CHAR_MARA', 'EXPR').id, 'CHAR_MARA_EXPR_V01');
      assert.strictEqual(assetPaths.nextCandidate(root, 'CHAR_MARA', 'WARD').rel,
        'characters/CHAR_MARA/refs/CHAR_MARA_WARD_V01.png');
      assert.strictEqual(assetPaths.nextCandidate(root, 'LOC_FERRY_DECK', 'PLATE').rel,
        'locations/LOC_FERRY_DECK/refs/LOC_FERRY_DECK_PLATE_V02.png');
      assert.strictEqual(assetPaths.nextCandidate(root, 'PROP_FLARE_GUN', 'PROP').rel,
        'props/PROP_FLARE_GUN/refs/PROP_FLARE_GUN_PROP_V01.png');
      assert.strictEqual(assetPaths.nextCandidate(root, 'PROP_FLARE_GUN', 'DETAIL', '.jpg').rel,
        'props/PROP_FLARE_GUN/refs/PROP_FLARE_GUN_DETAIL_V01.jpg');
      assert.strictEqual(assetPaths.nextCandidate(root, 'LOOK_NOIR_INK', 'LOOK').rel,
        'references/style/LOOK_NOIR_INK_V02.png', 'a look has no tag; the master V01 is counted');
      assert.strictEqual(assetPaths.nextCandidate(root, 'LOOK_DAWN_WASH', 'LOOK').rel,
        'references/style/LOOK_DAWN_WASH_V01.png');
      // A registry entry reserves its version even when its file is gone.
      assert.strictEqual(assetPaths.nextCandidate(root, 'CHAR_OSKAR', 'TURN').id, 'CHAR_OSKAR_TURN_V03',
        'CHAR_OSKAR_TURN_V02 is registered (in review)');
      fs.unlinkSync(fx.abs(root, 'characters/CHAR_OSKAR/refs/CHAR_OSKAR_TURN_V02.png'));
      assert.strictEqual(assetPaths.nextCandidate(root, 'CHAR_OSKAR', 'TURN').id, 'CHAR_OSKAR_TURN_V03');

      // Dry run of a turnaround: entity scope, candidate target, no render.
      const turn = prepareSheet(root, 'CHAR_MARA', { sheet: 'turnaround' });
      const refsBefore = listFiles(fx.abs(root, 'characters/CHAR_MARA/refs')).filter((n) => /\.png$/.test(n));
      const first = await gen.generateAssets({ package: turn.file, log: quiet });
      const record = first.results[0].record;
      assertRecordValid(record);
      assert.strictEqual(first.results[0].recordFile, fx.abs(root, 'generations/CHAR_MARA/GEN_CHAR_MARA_01.yaml'));
      assert.strictEqual(record.id, 'GEN_CHAR_MARA_01');
      assert.strictEqual(record.page, null);
      assert.strictEqual(record.asset, 'CHAR_MARA');
      assert.strictEqual(record.output_render, null, 'a sheet is not a page render');
      assert.strictEqual(record.prompt_package, 'PP_CHAR_MARA_HARNESS-NATIVE-TURN');
      assert.strictEqual(record.status, 'dry_run');
      assert.strictEqual(record.model, 'unreported');
      assert.deepStrictEqual(record.metadata_unavailable, ['model', 'cost', 'seed']);
      const target = 'characters/CHAR_MARA/refs/CHAR_MARA_TURN_V02.png';
      assert.ok(record.notes.includes(target), 'the handoff names the candidate file');
      const request = JSON.parse(fs.readFileSync(first.results[0].requestFile, 'utf8'));
      assert.deepStrictEqual(request.body.output, { render: null, path: target });
      assert.strictEqual(request.body.prompt, turn.pkg.prompt);
      assert.ok(!/_MASTER/.test(request.body.output.path), 'generation never targets a master name');
      assert.deepStrictEqual(listFiles(fx.abs(root, 'characters/CHAR_MARA/refs')).filter((n) => /\.png$/.test(n)),
        refsBefore, 'a dry run adds no image');

      // Every sheet of the entity shares one record sequence.
      const expr = prepareSheet(root, 'CHAR_MARA', { sheet: 'expressions' });
      const second = await gen.generateAssets({ package: expr.file, log: quiet });
      assert.strictEqual(second.results[0].record.id, 'GEN_CHAR_MARA_02');
      assert.strictEqual(JSON.parse(fs.readFileSync(second.results[0].requestFile, 'utf8')).body.output.path,
        'characters/CHAR_MARA/refs/CHAR_MARA_EXPR_V01.png');

      // --asset runs every package under the entity's refs/prompts/.
      prepareSheet(root, 'CHAR_MARA', { sheet: 'wardrobe' });
      prepareSheet(root, 'CHAR_MARA', { sheet: 'expressions', providerId: 'gemini' });
      const all = await gen.generateAssets({ asset: 'CHAR_MARA', root, log: quiet });
      assert.deepStrictEqual(all.results.map((r) => r.record.prompt_package), [
        'PP_CHAR_MARA_GEMINI-EXPR',
        'PP_CHAR_MARA_HARNESS-NATIVE-EXPR',
        'PP_CHAR_MARA_HARNESS-NATIVE-TURN',
        'PP_CHAR_MARA_HARNESS-NATIVE-WARD',
      ]);
      assert.deepStrictEqual(all.results.map((r) => r.record.id),
        ['GEN_CHAR_MARA_03', 'GEN_CHAR_MARA_04', 'GEN_CHAR_MARA_05', 'GEN_CHAR_MARA_06']);
      assert.ok(all.results.every((r) => r.record.asset === 'CHAR_MARA' && r.record.page === null));
      for (const r of all.results) assertRecordValid(r.record);
      // --provider narrows it.
      const onlyGemini = await gen.generateAssets({ asset: 'CHAR_MARA', root, provider: 'gemini', log: quiet });
      assert.deepStrictEqual(onlyGemini.results.map((r) => r.record.provider), ['gemini']);
      assert.strictEqual(onlyGemini.skipped.length, 3);
      await expectReject(gen.generateAssets({ asset: 'CHAR_OSKAR', root, log: quiet }), 'package_missing',
        /compile-prompts\.js --asset CHAR_OSKAR --sheet/);
      await expectReject(gen.generateAssets({ asset: 'PG_001_001', root, log: quiet }), 'bad_arguments');
      await expectReject(gen.generateAssets({ asset: 'CHAR_MARA', package: turn.file, log: quiet }), 'bad_arguments');

      // Looks share references/style/prompts/; --asset picks only its own.
      const firstLook = prepareSheet(root, 'LOOK_DAWN_WASH', { sheet: 'look' });
      prepareSheet(root, 'LOOK_NOIR_INK', { sheet: 'look' });
      const look = await gen.generateAssets({ asset: 'LOOK_DAWN_WASH', root, log: quiet });
      assert.strictEqual(look.results.length, 1);
      assert.strictEqual(look.results[0].file, firstLook.file);
      assert.strictEqual(look.results[0].record.id, 'GEN_LOOK_DAWN_WASH_01');
      assert.strictEqual(look.results[0].record.asset, 'LOOK_DAWN_WASH');
      assert.strictEqual(JSON.parse(fs.readFileSync(look.results[0].requestFile, 'utf8')).body.output.path,
        'references/style/LOOK_DAWN_WASH_V01.png');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(look.results[0].requestFile, 'utf8')).body.images, [],
        'a first look attaches no image');

      // Plate and prop targets.
      const plate = await gen.generateAssets({ package: prepareSheet(root, 'LOC_FERRY_DECK', { sheet: 'plate' }).file, log: quiet });
      assert.strictEqual(plate.results[0].record.id, 'GEN_LOC_FERRY_DECK_01');
      assert.ok(plate.results[0].record.notes.includes('locations/LOC_FERRY_DECK/refs/LOC_FERRY_DECK_PLATE_V02.png'));
      const prop = await gen.generateAssets({ package: prepareSheet(root, 'PROP_FLARE_GUN', { sheet: 'prop' }).file, log: quiet });
      assert.ok(prop.results[0].record.notes.includes('props/PROP_FLARE_GUN/refs/PROP_FLARE_GUN_PROP_V01.png'));

      // A live result is saved as the next candidate; each attempt is a new
      // version, and the approved master is never touched.
      const real = require('../providers/image/gemini');
      const common = require('../providers/lib/common');
      const bytes = Buffer.from('new sheet bytes');
      const fake = Object.assign({}, real, {
        async generate(spec) {
          const rec = common.makeRecord(spec, { status: 'pending' });
          rec._media = [{ data_base64: bytes.toString('base64'), format: 'png' }];
          return common.markSucceeded(rec, 'Stand-in returned 1 image.', ['inline image 1 (png)']);
        },
      });
      const master = fx.abs(root, 'characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png');
      const masterBefore = fs.readFileSync(master);
      const geminiTurn = prepareSheet(root, 'CHAR_MARA', { sheet: 'turnaround', providerId: 'gemini' });
      const item = { file: geminiTurn.file, pkg: geminiTurn.pkg, root };
      const live1 = await gen.runPackage(item, { live: true, providerModule: fake });
      assert.strictEqual(live1.record.status, 'succeeded');
      assert.deepStrictEqual(live1.record.media_files, ['characters/CHAR_MARA/refs/CHAR_MARA_TURN_V02.png']);
      assert.strictEqual(live1.record.output_render, null);
      assert.ok(fs.readFileSync(fx.abs(root, live1.record.media_files[0])).equals(bytes));
      assertRecordValid(yaml.parse(fs.readFileSync(live1.recordFile, 'utf8')));
      const live2 = await gen.runPackage(item, { live: true, providerModule: fake });
      assert.deepStrictEqual(live2.record.media_files, ['characters/CHAR_MARA/refs/CHAR_MARA_TURN_V03.png'],
        'version increment: the second attempt is a sibling');
      assert.ok(fs.readFileSync(master).equals(masterBefore), 'the approved master is untouched');
      assert.ok(!listFiles(fx.abs(root, 'characters/CHAR_MARA/refs')).some((n) => /_MASTER_V0[2-9]/.test(n)),
        'generation never creates a master');
      // The next dry run plans the version after the saved ones.
      const after = await gen.generateAssets({ package: turn.file, log: quiet });
      assert.ok(after.results[0].record.notes.includes('characters/CHAR_MARA/refs/CHAR_MARA_TURN_V04.png'));

      // A look result lands in references/style/ under the LOOK ID.
      const lookItem = { file: firstLook.file, pkg: Object.assign({}, firstLook.pkg, { provider: 'gemini', id: 'PP_LOOK_DAWN_WASH_GEMINI-LOOK' }), root };
      const liveLook = await gen.runPackage(lookItem, { live: true, providerModule: fake });
      assert.deepStrictEqual(liveLook.record.media_files, ['references/style/LOOK_DAWN_WASH_V01.png']);

      assert.strictEqual(network.calls, 0);
    } finally {
      network.restore();
    }
  });
}

function testSheetCli() {
  return fx.withWorkspace((root) => {
    const turn = prepareSheet(root, 'CHAR_MARA', { sheet: 'turnaround' });
    // --root points at the workspace.
    const byRoot = spawnSync(process.execPath, [SCRIPT, '--asset', 'CHAR_MARA', '--root', root], { encoding: 'utf8' });
    assert.strictEqual(byRoot.status, 0, byRoot.stderr);
    assert.ok(/DRY_RUN GEN_CHAR_MARA_01 \[harness-native, model unreported\]/.test(byRoot.stdout), byRoot.stdout);
    assert.ok(/target:\s+characters\/CHAR_MARA\/refs\/CHAR_MARA_TURN_V02\.png/.test(byRoot.stdout), byRoot.stdout);
    // Without --root the workspace is found from the current directory.
    const byCwd = spawnSync(process.execPath, [SCRIPT, '--asset', 'CHAR_MARA'],
      { encoding: 'utf8', cwd: path.dirname(turn.file) });
    assert.strictEqual(byCwd.status, 0, byCwd.stderr);
    assert.ok(/GEN_CHAR_MARA_02/.test(byCwd.stdout));
    const outside = spawnSync(process.execPath, [SCRIPT, '--asset', 'CHAR_MARA'], { encoding: 'utf8', cwd: path.parse(root).root });
    assert.strictEqual(outside.status, 1);
    assert.ok(/--root <workspace>/.test(outside.stderr), outside.stderr);
  });
}

async function main() {
  testEstimates();
  await testDryRun();
  await testVersionHelpers();
  await testLiveGate();
  await testLiveResultIsSavedAsNewVersion();
  await testIssueAndAssetScope();
  await testSheets();
  await testSheetCli();
  await testCli();
  console.log('generate-assets: OK');
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
