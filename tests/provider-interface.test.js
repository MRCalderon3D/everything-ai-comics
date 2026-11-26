'use strict';
/**
 * Every image provider in manifests/image-providers.json exports the
 * contracted interface (docs/conventions.md): the capability keys, a pure
 * compile() that enforces them, and a generate() that defaults to dry-run
 * and returns a comics generation record without touching the network.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { listProviders, loadProvider } = require('../scripts/lib/providers');
const common = require('../providers/lib/common');
const schemaLib = require('../scripts/lib/schema');

const ROOT = path.resolve(__dirname, '..');
const ROSTER = ['fal', 'replicate', 'comfyui', 'gemini', 'harness-native', 'manual'];
const PAGE_RATIOS = ['2:3', '3:4', '9:16', '1:1'];
const HANDOFF = ['harness-native', 'manual'];

function schema(name) {
  const file = path.join(ROOT, 'schemas', `${name}.schema.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

/** A prompt package per docs/data-model.md, fitted to the provider's limits. */
function samplePackage(provider, overrides = {}) {
  const caps = provider.capabilities;
  const refs = [
    { asset_id: 'LOOK_NOIR_INK_MASTER_V01', role: 'style', image_path: 'references/style/LOOK_NOIR_INK_MASTER_V01.png' },
    { asset_id: 'CHAR_MARA_TURN_MASTER_V01', role: 'identity', image_path: 'characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png' },
  ].slice(0, Math.min(2, caps.referenceImages));
  return Object.assign({
    id: `PP_PG_001_001_${common.providerTag(provider.id)}`,
    page: 'PG_001_001',
    asset: null,
    provider: provider.id,
    model: 'pending',
    mode: 'generate',
    prompt: 'High-contrast ink noir comic art.\n\nPAGE\nOne finished comic page, portrait format, aspect ratio 2:3.',
    negative_prompt: 'watermark, signature',
    parameters: { aspect_ratio: '2:3', resolution: '2000x3000', seed: null },
    references: refs,
    edit_target: null,
    lettering_text: caps.textRendering === 'none' ? [] : ['Last crossing of the night.'],
    status: 'compiled',
    source_hashes: { page: '0f3a9c1b2d4e5f60', reference_plan: '7b1c2d3e4f5a6b70', style_block: '9a8b7c6d5e4f3a20' },
  }, overrides);
}

function assertNoSecrets(mod, value, label) {
  const json = JSON.stringify(value);
  for (const envName of mod.env) {
    const val = process.env[envName];
    if (val && val.length > 3) assert.ok(!json.includes(val), `${label} leaked ${envName}`);
  }
}

async function checkProvider(entry, network) {
  const mod = require(path.join(ROOT, ...entry.file.split('/')));
  const where = entry.file;

  // exact interface
  assert.deepStrictEqual(Object.keys(mod).sort(),
    ['capabilities', 'compile', 'env', 'generate', 'id', 'kind', 'label'],
    `${where}: must export exactly id/kind/label/env/capabilities/compile/generate`);
  assert.strictEqual(mod.id, entry.id, `${where}: id differs from the manifest`);
  assert.strictEqual(mod.kind, 'image', `${where}: kind must be image`);
  assert.ok(typeof mod.label === 'string' && mod.label, `${where}: label`);
  assert.strictEqual(mod.label, entry.label, `${where}: label differs from the manifest`);
  assert.deepStrictEqual(mod.env, entry.env, `${where}: env differs from the manifest`);
  assert.deepStrictEqual(mod.capabilities, entry.capabilities, `${where}: capabilities differ from the manifest`);

  // capability keys per docs/conventions.md
  const caps = mod.capabilities;
  assert.deepStrictEqual(Object.keys(caps).sort(),
    ['aspectRatios', 'imageEditing', 'referenceImages', 'textRendering'],
    `${where}: capabilities must be referenceImages/aspectRatios/imageEditing/textRendering`);
  assert.ok(Number.isInteger(caps.referenceImages) && caps.referenceImages >= 0, `${where}: referenceImages`);
  assert.strictEqual(typeof caps.imageEditing, 'boolean', `${where}: imageEditing`);
  assert.ok(['reliable', 'unreliable', 'none'].includes(caps.textRendering), `${where}: textRendering`);
  assert.ok(Array.isArray(caps.aspectRatios) && caps.aspectRatios.every((r) => /^\d+:\d+$/.test(r)),
    `${where}: aspectRatios`);
  for (const ratio of PAGE_RATIOS) {
    assert.ok(caps.aspectRatios.includes(ratio), `${where}: comic page ratio ${ratio} must be supported`);
  }
  if (HANDOFF.includes(mod.id)) assert.deepStrictEqual(mod.env, [], `${where}: handoff providers need no env`);

  // compile(): pure, request spec shape, scope carried in meta
  const pkg = samplePackage(mod);
  const frozen = JSON.stringify(pkg);
  const spec = mod.compile(pkg);
  assert.strictEqual(JSON.stringify(pkg), frozen, `${where}: compile() must not mutate the package`);
  assert.deepStrictEqual(mod.compile(pkg), spec, `${where}: compile() must be deterministic`);
  assert.strictEqual(spec.provider, mod.id);
  assert.strictEqual(spec.kind, 'image');
  assert.ok(typeof spec.model === 'string' && spec.model && spec.model !== 'pending', `${where}: spec.model`);
  assert.ok('endpoint' in spec && 'method' in spec && spec.body && typeof spec.body === 'object',
    `${where}: spec needs endpoint, method, body`);
  assert.strictEqual(spec.meta.page, 'PG_001_001', `${where}: spec.meta.page`);
  assert.strictEqual(spec.meta.asset, null, `${where}: spec.meta.asset`);
  assert.strictEqual(spec.meta.prompt_package_id, pkg.id, `${where}: spec.meta.prompt_package_id`);
  assert.ok(/^[a-f0-9]{16}$/.test(spec.meta.prompt_package_hash), `${where}: spec.meta.prompt_package_hash`);
  assert.deepStrictEqual(spec.meta.references_used, pkg.references.map((r) => r.asset_id));
  assert.deepStrictEqual(spec.meta.reference_paths, pkg.references.map((r) => r.image_path));
  assert.ok(Array.isArray(spec.meta.warnings), `${where}: spec.meta.warnings`);
  assert.ok(JSON.stringify(spec.body).includes('High-contrast ink noir comic art.'),
    `${where}: the prompt must reach the request body unchanged`);
  assertNoSecrets(mod, spec, `${where}: request spec`);

  // model precedence: options.model, then the package pin, never 'pending'
  assert.strictEqual(mod.compile(pkg, { model: 'custom/model-id' }).model, 'custom/model-id',
    `${where}: options.model ignored`);
  assert.strictEqual(mod.compile(Object.assign({}, pkg, { model: 'package/pinned-model' })).model,
    'package/pinned-model', `${where}: package model ignored`);

  // every declared ratio compiles; an unsupported one is a clear error
  for (const ratio of caps.aspectRatios) {
    const fitted = samplePackage(mod, { parameters: { aspect_ratio: ratio, seed: null } });
    assert.doesNotThrow(() => mod.compile(fitted), `${where}: declared ratio ${ratio} must compile`);
  }
  assert.throws(
    () => mod.compile(samplePackage(mod, { parameters: { aspect_ratio: '7:13', seed: null } })),
    (err) => /aspect ratio 7:13 is not supported \(supported: /.test(err.message) && err.message.includes(mod.id),
    `${where}: unsupported aspect ratio must be rejected with the supported list`);

  // reference budget is a hard limit
  const tooMany = Array.from({ length: caps.referenceImages + 1 }, (_, i) => ({
    asset_id: `CHAR_EXTRA_TURN_MASTER_V${String(i + 1).padStart(2, '0')}`,
    role: 'identity',
    image_path: `characters/CHAR_EXTRA/refs/extra-${i + 1}.png`,
  }));
  assert.throws(() => mod.compile(samplePackage(mod, { references: tooMany })),
    /exceed the provider limit/, `${where}: over-budget package must be rejected`);

  // repair needs imageEditing; the edit target counts as an input image
  const repair = samplePackage(mod, {
    mode: 'repair',
    model: 'editing/model',
    references: pkg.references.slice(0, Math.max(0, caps.referenceImages - 1)),
    edit_target: 'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png',
    repair: { of_render: 'PG_001_001_V01', findings: ['F01'], changes: ['Panel 3: fix the face.'], locked: ['All lettering.'] },
  });
  if (caps.imageEditing) {
    const repairSpec = mod.compile(repair);
    assert.strictEqual(repairSpec.meta.reference_paths[0], repair.edit_target,
      `${where}: the edit target must be the first attached image`);
    assert.strictEqual(repairSpec.meta.mode, 'repair');
  } else {
    assert.throws(() => mod.compile(repair), /image editing is not supported/,
      `${where}: a repair must be rejected without imageEditing`);
  }

  // in-image lettering needs text rendering
  if (caps.textRendering === 'none') {
    assert.throws(() => mod.compile(samplePackage(mod, { lettering_text: ['Out. Slowly.'] })),
      /in-image lettering is not supported/, `${where}: lettering must be rejected without text rendering`);
  }

  // generate(): dry-run by default, no network, comics record shape
  const before = network.calls;
  const scoped = mod.compile(pkg);
  scoped.meta.record_id = 'GEN_PG_001_001_01';
  scoped.meta.output_render = 'PG_001_001_V01';
  const record = await mod.generate(scoped);
  assert.strictEqual(network.calls, before, `${where}: default generate() touched the network`);
  assert.strictEqual(record.status, 'dry_run', `${where}: default generate() status was ${record.status}`);
  assert.strictEqual(record.id, 'GEN_PG_001_001_01');
  assert.strictEqual(record.page, 'PG_001_001');
  assert.strictEqual(record.asset, null);
  assert.strictEqual(record.provider, mod.id);
  assert.strictEqual(record.kind, 'image');
  assert.strictEqual(record.prompt_package, pkg.id);
  assert.strictEqual(record.output_render, 'PG_001_001_V01');
  assert.ok(record.request.summary && /^[a-f0-9]{16}$/.test(record.request.payload_hash), `${where}: record.request`);
  assert.deepStrictEqual(record.media_files, []);
  assert.ok(record.created_at, `${where}: record.created_at`);
  // nothing invented: no cost, no seed, and no model for a handoff
  assert.deepStrictEqual(record.cost, { currency: 'USD', amount: null, estimated: false, reported: false },
    `${where}: cost must be unreported, not invented`);
  assert.strictEqual(record.seed, null, `${where}: seed must be null when none is pinned`);
  if (HANDOFF.includes(mod.id)) {
    assert.strictEqual(record.model, 'unreported', `${where}: a handoff cannot know the model`);
    assert.deepStrictEqual(record.metadata_unavailable, ['model', 'cost', 'seed']);
    assert.strictEqual(record.request.endpoint, null);
  } else {
    assert.strictEqual(record.model, scoped.model, `${where}: the record names the addressed model`);
    assert.deepStrictEqual(record.metadata_unavailable, ['cost', 'seed']);
  }
  assertNoSecrets(mod, record, `${where}: record`);

  const recordSchema = schema('generation-record');
  if (recordSchema) {
    const check = schemaLib.validate(recordSchema, record);
    assert.ok(check.valid,
      `${where}: dry-run record violates generation-record.schema.json: ${JSON.stringify(check.errors.slice(0, 5))}`);
  }
  return mod;
}

async function main() {
  const providers = listProviders();
  assert.deepStrictEqual(providers.map((p) => p.id), ROSTER,
    'manifests/image-providers.json must list the image roster of docs/conventions.md, in order');
  assert.ok(providers.every((p) => p.kind === 'image'), 'image providers only');
  assert.deepStrictEqual(listProviders('image').map((p) => p.id), ROSTER);
  assert.throws(() => loadProvider('image', 'nowhere'), /unknown image provider "nowhere" \(known: fal, /);

  // No provider may reach the network in this test.
  const originalFetch = global.fetch;
  const network = { calls: 0 };
  global.fetch = async () => {
    network.calls++;
    throw new Error('network access is not allowed in tests');
  };

  try {
    const mods = {};
    for (const entry of providers) mods[entry.id] = await checkProvider(entry, network);

    // Handoff providers: a package a person can execute, never a network call,
    // and a dry_run record even when asked to run live.
    for (const id of HANDOFF) {
      const mod = mods[id];
      const spec = mod.compile(samplePackage(mod));
      assert.strictEqual(spec.handoff, true, `${id}: spec.handoff`);
      assert.strictEqual(spec.endpoint, null);
      assert.strictEqual(spec.body.prompt, samplePackage(mod).prompt, `${id}: handoff carries the prompt`);
      assert.deepStrictEqual(spec.body.images, [
        { position: 1, asset_id: 'LOOK_NOIR_INK_MASTER_V01', role: 'style', image_path: 'references/style/LOOK_NOIR_INK_MASTER_V01.png' },
        { position: 2, asset_id: 'CHAR_MARA_TURN_MASTER_V01', role: 'identity', image_path: 'characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png' },
      ], `${id}: handoff lists the references in order, each with its role`);
      assert.ok('output' in spec.body && typeof spec.body.instructions === 'string', `${id}: handoff output + instructions`);
      spec.meta.output_path = 'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png';
      const live = await mod.generate(spec, { dryRun: false });
      assert.strictEqual(live.status, 'dry_run', `${id}: must return dry_run even when asked to run live`);
      assert.ok(live.notes.includes(spec.meta.output_path), `${id}: notes name the target output path`);
    }

    // The edit target is image 1 for the handoff list too.
    const hn = mods['harness-native'];
    const repairSpec = hn.compile(samplePackage(hn, {
      mode: 'repair',
      edit_target: 'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png',
      repair: { of_render: 'PG_001_001_V01', findings: ['F01'], changes: ['x'], locked: ['y'] },
    }));
    assert.deepStrictEqual(repairSpec.body.images.map((i) => [i.position, i.role]),
      [[1, 'edit_target'], [2, 'style'], [3, 'identity']]);
    assert.strictEqual(repairSpec.body.images[0].asset_id, 'PG_001_001_V01');

    // A pinned seed and a list-price estimate are recorded as what they are.
    const gemini = mods.gemini;
    const seeded = gemini.compile(samplePackage(gemini, { parameters: { aspect_ratio: '2:3', seed: 41 } }));
    seeded.meta.cost_estimate = 0.039;
    const seededRecord = await gemini.generate(seeded);
    assert.strictEqual(seededRecord.seed, 41);
    assert.deepStrictEqual(seededRecord.cost, { currency: 'USD', amount: 0.039, estimated: true, reported: false });
    assert.deepStrictEqual(seededRecord.metadata_unavailable, ['cost']);

    // Reported metadata replaces the gaps; nothing else changes.
    const reported = common.applyReported(await hn.generate(hn.compile(samplePackage(hn))),
      { model: 'gpt-image-1', seed: 7 });
    assert.strictEqual(reported.model, 'gpt-image-1');
    assert.strictEqual(reported.seed, 7);
    assert.deepStrictEqual(reported.metadata_unavailable, ['cost']);
    assert.strictEqual(reported.cost.amount, null);

    // Asset-scoped packages produce asset-scoped records.
    const assetSpec = hn.compile(samplePackage(hn, {
      id: 'PP_CHAR_OSKAR_HARNESS-NATIVE', page: null, asset: 'CHAR_OSKAR', references: [],
    }));
    const assetRecord = await hn.generate(assetSpec);
    assert.strictEqual(assetRecord.page, null);
    assert.strictEqual(assetRecord.asset, 'CHAR_OSKAR');
    assert.strictEqual(assetRecord.id, 'GEN_CHAR_OSKAR_01');
    assert.strictEqual(assetRecord.output_render, null);
    assert.throws(() => common.makeRecord({ provider: 'fal', model: 'm', body: {}, meta: {} }),
      /neither a page nor an asset scope/);

    // Text-to-image defaults say so instead of silently ignoring the images.
    const fal = mods.fal;
    assert.ok(fal.compile(samplePackage(fal)).meta.warnings.some((w) => /ignores the 2 input image/.test(w)),
      'fal: the default model must warn that it ignores input images');
    assert.throws(() => fal.compile(samplePackage(fal, {
      mode: 'repair', references: [], edit_target: 'renders/x.png',
    })), /cannot edit a page/, 'fal: the default model must refuse a repair');

    // Live mode refuses without the env vars, before any request.
    for (const id of ['fal', 'replicate', 'comfyui', 'gemini']) {
      const mod = mods[id];
      const saved = {};
      for (const name of mod.env) {
        saved[name] = process.env[name];
        delete process.env[name];
      }
      try {
        const before = network.calls;
        await assert.rejects(() => mod.generate(mod.compile(samplePackage(mod)), { dryRun: false }),
          new RegExp(mod.env[0]), `${id}: live mode without ${mod.env[0]} must refuse`);
        assert.strictEqual(network.calls, before, `${id}: refused live run touched the network`);
      } finally {
        for (const name of mod.env) if (saved[name] !== undefined) process.env[name] = saved[name];
      }
    }
    assert.strictEqual(network.calls, 0, 'no provider may call the network in this test');
  } finally {
    global.fetch = originalFetch;
  }

  console.log(`provider-interface: OK (${providers.length} image providers)`);
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
