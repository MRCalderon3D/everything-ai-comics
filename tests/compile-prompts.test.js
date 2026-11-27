'use strict';
/**
 * compile-prompts.js: prompt composition, determinism, the difference line
 * for visually adjacent characters, in_image versus overlay lettering,
 * repair packages, and the repair-cycle refusal. Runs on a throwaway copy
 * of the fixture workspace in tests/fixtures/prompt-pipeline/.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const fx = require('./fixtures/prompt-pipeline/setup');
const ws = require('../scripts/lib/workspace');
const yaml = require('../scripts/lib/yaml');
const { validateDoc, hashPage } = require('../scripts/lib/page-pipeline');
const { buildReferencePlan } = require('../scripts/build-reference-plan');
const { compilePage, compileAsset, selectFindings } = require('../scripts/compile-prompts');
const layout = require('../scripts/lib/layout-language');
const lang = require('../scripts/lib/panel-language');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'compile-prompts.js');
const NOW = new Date('2026-11-26T09:00:00Z');
const FLAGGED = 'PG_001_002_V01';

const STRINGS_P1 = ['Last crossing of the night.', 'SKRRT', 'Nothing on this deck moves by itself.'];
const STRINGS_P2 = ['Out. Slowly.', "Don't tell the patrol.", 'The launch was four minutes out.', 'Who cut you?'];

/** Write the reference plan of a page for a provider, as the CLI would. */
function writePlan(root, pageId, providerId) {
  const { doc } = buildReferencePlan(root, ws.loadPage(root, pageId), { now: NOW, providerId });
  fs.writeFileSync(path.join(fx.pageDir(root, pageId), 'reference-plan.yaml'), yaml.stringify(doc));
  return doc;
}

function compile(root, pageId, options = {}) {
  return compilePage(root, ws.loadPage(root, pageId), options);
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

function assertSchemaValid(pkg) {
  const check = validateDoc('prompt-package', pkg);
  assert.ok(check.valid, `violates prompt-package.schema.json: ${check.errors.join('; ')}`);
}

function section(prompt, title) {
  const start = prompt.indexOf(`\n\n${title}`);
  assert.ok(start !== -1, `prompt has no ${title} section`);
  const rest = prompt.slice(start + 2);
  const next = rest.search(/\n\n[A-Z][A-Z ,]+(\n|$)/);
  return next === -1 ? rest : rest.slice(0, next);
}

function testLanguageHelpers() {
  assert.strictEqual(lang.framingPhrase({ shot_size: 'close_up', angle: 'low_angle', view: 'profile' }),
    'close-up on the face; seen from below (low angle); subject in profile');
  assert.strictEqual(lang.framingPhrase({ shot_size: 'new_size' }), 'new size', 'unknown enums fall back to plain words');
  assert.strictEqual(lang.positionPhrase({ level: 'wheelhouse', side: 'right', landmark: 'ladder' }),
    'on the wheelhouse level, screen right, at the ladder');
  assert.strictEqual(lang.statePhrase(['cut_left_hand', 'soaked']), 'cut left hand, soaked');
  assert.strictEqual(lang.statePhrase([]), null);
  assert.strictEqual(lang.sentence('Who cut you?'), 'Who cut you?');
  assert.strictEqual(lang.sentence('Steers with one hand'), 'Steers with one hand.');

  const page = {
    id: 'PG_001_009',
    layout: { tiers: [1, 2], reading_order: [1, 2, 3] },
    panels: [{ id: 'c', order: 3 }, { id: 'a', order: 1 }, { id: 'b', order: 2 }],
  };
  assert.deepStrictEqual(layout.readingSequence(page).map((p) => p.id), ['a', 'b', 'c']);
  assert.strictEqual(layout.panelSlots(page, 'ltr').get('b').placement, 'left');
  assert.strictEqual(layout.panelSlots(page, 'rtl').get('b').placement, 'right', 'rtl starts a tier on the right');
  assert.strictEqual(layout.panelSlots(page, 'ltr').get('a').placement, 'full width');
  assert.strictEqual(layout.describeReading('rtl'), 'right to left, top to bottom');
  assert.throws(() => layout.panelSlots(Object.assign({}, page, { layout: { tiers: [2, 2] } })),
    (err) => err.code === 'layout_mismatch' && /sums to 4 but the page has 3/.test(err.message));
  assert.strictEqual(layout.nearestRatio(2, ['2:3', '1:1', '3:2', '16:9']), '16:9');
  assert.strictEqual(layout.nearestRatio(1.4, ['2:3', '1:1', '3:2', '16:9']), '3:2');
}

function testGeneratePackage() {
  return fx.withWorkspace((root) => {
    const plan1 = writePlan(root, fx.PAGE_1);
    const plan2 = writePlan(root, fx.PAGE_2);
    const styleBlock = ws.loadStyleBlock(root);

    const { pkg, spec, fileName } = compile(root, fx.PAGE_2);
    assertSchemaValid(pkg);
    assert.strictEqual(fileName, 'harness-native.yaml');
    assert.strictEqual(pkg.id, 'PP_PG_001_002_HARNESS-NATIVE');
    assert.strictEqual(pkg.page, fx.PAGE_2);
    assert.strictEqual(pkg.asset, null);
    assert.strictEqual(pkg.provider, 'harness-native');
    assert.strictEqual(pkg.model, 'harness-native', 'provider.compile() pins the model');
    assert.strictEqual(pkg.model, spec.model);
    assert.strictEqual(pkg.mode, 'generate');
    assert.strictEqual(pkg.edit_target, null);
    assert.ok(!('repair' in pkg), 'repair block only in repair mode');
    assert.strictEqual(pkg.status, 'compiled');
    assert.deepStrictEqual(pkg.parameters, { aspect_ratio: '2:3', resolution: '2000x3000', seed: null });
    assert.deepStrictEqual(Object.keys(pkg), ['id', 'page', 'asset', 'provider', 'model', 'mode', 'prompt',
      'negative_prompt', 'parameters', 'references', 'edit_target', 'lettering_text', 'status', 'source_hashes']);

    // References: the plan, in attachment order, with registry paths.
    assert.deepStrictEqual(pkg.references, [
      { asset_id: 'LOOK_NOIR_INK_MASTER_V01', role: 'style', image_path: 'references/style/LOOK_NOIR_INK_MASTER_V01.png' },
      { asset_id: 'CHAR_MARA_TURN_MASTER_V01', role: 'identity', image_path: 'characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png' },
      { asset_id: 'CHAR_OSKAR_TURN_MASTER_V01', role: 'identity', image_path: 'characters/CHAR_OSKAR/refs/CHAR_OSKAR_TURN_MASTER_V01.png' },
      { asset_id: 'PG_001_001_V01', role: 'spatial_continuity', image_path: 'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png' },
    ]);
    assert.strictEqual(pkg.references.length, plan2.required.length + plan2.optional.length);

    // 1. The frozen style block opens the prompt, verbatim.
    const prompt = pkg.prompt;
    assert.ok(prompt.startsWith(`${styleBlock}\n\nPAGE\n`), 'the style block must open the prompt verbatim');

    // 2. Page header.
    const header = section(prompt, 'PAGE');
    assert.ok(header.includes('One finished comic page, portrait format, aspect ratio 2:3.'));
    assert.ok(header.includes('Layout: 4 panels in 2 tiers, top to bottom. Tier 1: 2 panels side by side. Tier 2: 2 panels side by side. Planned grid: two tiers, 2 / 2.'));
    assert.ok(header.includes('Reading direction: left to right, top to bottom.'));
    assert.ok(header.includes('Color: monochrome. No color anywhere except the spot colors below.'));
    assert.ok(header.includes('Spot color: signal red (#C0392B). Flare light only.'));

    // 3. Reference legend: one line per image, by position, one role each.
    const legend = section(prompt, 'REFERENCE IMAGES').split('\n').filter((l) => /^Image \d+:/.test(l));
    assert.strictEqual(legend.length, pkg.references.length, 'one legend line per attached image');
    assert.ok(legend[0].startsWith('Image 1: drawing style only'));
    assert.ok(/Do not copy its characters, composition, or text\./.test(legend[0]));
    assert.ok(legend[1].startsWith('Image 2: identity of Mara.'));
    assert.ok(legend[2].startsWith('Image 3: identity of Oskar.'));
    assert.ok(legend[3].startsWith('Image 4: the previous page, for the setting and the staging only.'));
    assert.ok(!/[A-Z]+_[A-Z0-9_]*_V\d{2}/.test(prompt), 'asset and render IDs stay out of the model-facing text');
    assert.ok(!/\b(CHAR|PROP|LOC|WARD|PN|PG)_[A-Z0-9_]+/.test(prompt), 'entity IDs stay out of the model-facing text');

    // 4. One block per panel, in reading order.
    const panels = section(prompt, 'PANELS, in reading order');
    const heads = panels.split('\n').filter((l) => /^Panel \d of \d\./.test(l));
    assert.deepStrictEqual(heads, [
      'Panel 1 of 4. Tier 1 of 2, left. Medium panel.',
      'Panel 2 of 4. Tier 1 of 2, right. Medium panel.',
      'Panel 3 of 4. Tier 2 of 2, left. Medium panel.',
      'Panel 4 of 4. Tier 2 of 2, right. Medium panel.',
    ]);
    const block3 = panels.slice(panels.indexOf('Panel 3 of 4.'), panels.indexOf('Panel 4 of 4.'));
    assert.ok(block3.includes('Framing: close-up on the face; seen from above (high angle); subject seen from the front.'));
    assert.ok(block3.includes('Moment: Oskar looks up, his cut left hand held against his chest.'));
    assert.ok(block3.includes('Setting: Ferry deck. Open steel deck of a small river ferry at night'));
    assert.ok(block3.includes('Background: Shadow of the tarpaulin.'));
    assert.ok(block3.includes('Characters drawn in this panel: 1 (Oskar), each exactly once.'));
    assert.ok(block3.includes('- Oskar. Boy of about twelve with a round face, a dark uneven fringe and a hooded jacket.'));
    assert.ok(block3.includes('Position: on the deck level, screen left, at the crates.'));
    assert.ok(block3.includes('Facing: toward the reader.'));
    assert.ok(block3.includes('Action: Holds his cut left hand against his chest.'));
    assert.ok(block3.includes('Acting: Mouth pressed thin, not blinking.'));
    assert.ok(block3.includes('Wardrobe: Grey hooded jacket two sizes too big, canvas trousers, wet plimsolls.'));
    assert.ok(block3.includes('Physical state, visible in the drawing: cut left hand.'));
    assert.ok(block3.includes('Not drawn in this panel: Mara.'), 'off-panel ledger rows are named as not drawn');
    const block1 = panels.slice(panels.indexOf('Panel 1 of 4.'), panels.indexOf('Panel 2 of 4.'));
    assert.ok(block1.includes('Holding: Flare gun (Orange single-shot flare pistol with a wide stubby barrel).'));

    // Visually adjacent characters: an explicit difference line, both ways.
    // Only Mara lists Oskar; adjacency still applies to Oskar.
    const maraLine = '  Mara is not Oskar. Mara: broken nose, grey cropped hair, oilskin coat with a torn left cuff. ' +
      'Oskar: round face, hooded jacket, cut on his left hand. Do not swap or blend their features.';
    const oskarLine = '  Oskar is not Mara. Oskar: round face, hooded jacket, cut on his left hand. ' +
      'Mara: broken nose, grey cropped hair, oilskin coat with a torn left cuff. Do not swap or blend their features.';
    assert.ok(block1.includes(maraLine), 'difference line under Mara');
    assert.ok(block3.includes(oskarLine), 'difference line under Oskar, who lists nobody himself');
    assert.strictEqual(prompt.split(maraLine).length - 1, 3, 'once per panel that draws Mara');
    assert.strictEqual(prompt.split(oskarLine).length - 1, 3, 'once per panel that draws Oskar');

    // 6. Hard constraints.
    const hard = section(prompt, 'HARD CONSTRAINTS');
    assert.ok(hard.includes('- Exactly 4 panels, arranged as described. No extra panels, insets, or split frames.'));
    assert.ok(hard.includes('panel 1: Mara; panel 2: Mara and Oskar; panel 3: Oskar; panel 4: Mara and Oskar.'));
    assert.ok(hard.includes('- No text other than the lettering listed above.'));
    assert.ok(prompt.trimEnd().endsWith('- No watermark, signature, or page number.'), 'constraints close the prompt');

    // Source hashes: stable for the same inputs, blind to status changes.
    for (const key of ['page', 'reference_plan', 'style_block']) {
      assert.ok(/^[a-f0-9]{16}$/.test(pkg.source_hashes[key]), `source_hashes.${key}`);
    }
    const page = ws.loadPage(root, fx.PAGE_2);
    assert.strictEqual(pkg.source_hashes.page, hashPage(page));
    assert.strictEqual(hashPage(Object.assign({}, page, { status: 'reviewed', current_render: 'PG_001_002_V02' })),
      pkg.source_hashes.page, 'status and current_render do not make a package stale');
    const edited = JSON.parse(JSON.stringify(page));
    edited.panels[0].moment = 'Something else happens.';
    assert.notStrictEqual(hashPage(edited), pkg.source_hashes.page);

    // Page 1: props in view, an insert with nobody in it, an off-panel row.
    const p1 = compile(root, fx.PAGE_1).pkg;
    assertSchemaValid(p1);
    assert.strictEqual(p1.references.length, plan1.required.length + plan1.optional.length);
    assert.ok(p1.prompt.includes('Props in view:\n- Flare gun (Orange single-shot flare pistol with a wide stubby barrel). Position: on the wheelhouse level, screen right.'));
    assert.ok(p1.prompt.includes('Characters drawn in this panel: none of the named characters.'));
    assert.ok(p1.prompt.includes('Not drawn in this panel: Oskar.'));
    assert.ok(p1.prompt.includes('Mara is not Oskar.'), 'the difference is stated even when the other is off panel');
    assert.ok(p1.prompt.includes('Panel 1 of 4. Tier 1 of 3, full width. Wide panel.'));
    assert.ok(p1.prompt.includes('Image 3: the location Ferry deck.'));
    assert.ok(p1.prompt.includes('Image 4: wardrobe of Mara.'));
  });
}

function testDeterminism() {
  return fx.withWorkspace((rootA) => fx.withWorkspace((rootB) => {
    for (const root of [rootA, rootB]) {
      writePlan(root, fx.PAGE_1);
      writePlan(root, fx.PAGE_2);
    }
    for (const pageId of [fx.PAGE_1, fx.PAGE_2]) {
      const first = compile(rootA, pageId).pkg;
      const again = compile(rootA, pageId).pkg;
      const elsewhere = compile(rootB, pageId).pkg;
      assert.deepStrictEqual(again, first, `${pageId}: compiling twice gives the same package`);
      assert.deepStrictEqual(elsewhere, first, `${pageId}: the package does not depend on where the workspace lives`);
      assert.strictEqual(yaml.stringify(again), yaml.stringify(first));
      assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(first.prompt), 'no timestamps in the prompt');
      // The package survives a YAML round trip byte for byte.
      assert.deepStrictEqual(yaml.parse(yaml.stringify(first)), first, `${pageId}: YAML round trip`);
    }
    const repairA = compile(rootA, fx.PAGE_2, { repairReview: ws.loadReview(rootA, FLAGGED) }).pkg;
    const repairB = compile(rootB, fx.PAGE_2, { repairReview: ws.loadReview(rootB, FLAGGED) }).pkg;
    assert.deepStrictEqual(repairA, repairB, 'repair packages are deterministic too');
    // Rebuilding the plan on another day does not change the package.
    const { doc } = buildReferencePlan(rootB, ws.loadPage(rootB, fx.PAGE_2), { now: new Date('2027-01-05T00:00:00Z') });
    fs.writeFileSync(path.join(fx.pageDir(rootB, fx.PAGE_2), 'reference-plan.yaml'), yaml.stringify(doc));
    assert.deepStrictEqual(compile(rootB, fx.PAGE_2).pkg, compile(rootA, fx.PAGE_2).pkg);
  }));
}

function testLetteringModes() {
  return fx.withWorkspace((root) => {
    writePlan(root, fx.PAGE_1);
    writePlan(root, fx.PAGE_2);

    // in_image: the exact strings, with type and speaker, in reading order.
    const inImage = compile(root, fx.PAGE_2);
    assert.deepStrictEqual(inImage.pkg.lettering_text, STRINGS_P2);
    const lettering = section(inImage.pkg.prompt, 'LETTERING');
    assert.ok(lettering.includes('Letter the page with exactly these 4 elements, in this reading order.'));
    assert.ok(lettering.includes('Set the lettering in capitals; the words stay exactly as written.'));
    assert.deepStrictEqual(lettering.split('\n').filter((l) => /^\d+\. /.test(l)), [
      '1. Panel 2, speech balloon, speaker Mara, tail pointing to Mara: "Out. Slowly."',
      '2. Panel 3, whisper balloon with a dashed outline, speaker Oskar, tail pointing to Oskar: "Don\'t tell the patrol."',
      '3. Panel 4, caption box: "The launch was four minutes out."',
      '4. Panel 4, speech balloon, speaker Mara, tail pointing to Mara: "Who cut you?"',
    ]);
    assert.ok(!/speech balloons/.test(inImage.pkg.negative_prompt));
    assert.ok(inImage.warnings.some((w) => /renders text unreliably/.test(w)),
      'an unreliable text renderer is called out for the review');
    const p1 = compile(root, fx.PAGE_1).pkg;
    assert.deepStrictEqual(p1.lettering_text, STRINGS_P1);
    assert.ok(p1.prompt.includes('2. Panel 3, sound effect lettered into the art: "SKRRT"'));
    assert.ok(p1.prompt.includes('3. Panel 4, thought balloon, speaker Mara, tail pointing to Mara: "Nothing on this deck moves by itself."'));

    // overlay: no text in the art, no strings in the prompt.
    fx.editYaml(root, 'project.yaml', (project) => { project.lettering.mode = 'overlay'; });
    const overlay = compile(root, fx.PAGE_2);
    assertSchemaValid(overlay.pkg);
    assert.deepStrictEqual(overlay.pkg.lettering_text, []);
    const none = section(overlay.pkg.prompt, 'LETTERING');
    assert.ok(none.includes('None in the image: lettering is added afterwards as an overlay.'));
    assert.ok(none.includes('Draw no text of any kind: no speech balloons, no caption boxes, no sound effects, no readable signs.'));
    assert.ok(none.includes('Leave calm, uncluttered space for the overlay in panels 2, 3, and 4'));
    for (const text of STRINGS_P2) {
      assert.ok(!overlay.pkg.prompt.includes(text), `overlay prompt must not carry "${text}"`);
    }
    assert.ok(section(overlay.pkg.prompt, 'HARD CONSTRAINTS').includes('- No text anywhere in the image.'));
    assert.ok(/speech balloons/.test(overlay.pkg.negative_prompt));
    assert.ok(!overlay.warnings.some((w) => /renders text unreliably/.test(w)));
    assert.notStrictEqual(overlay.pkg.prompt, inImage.pkg.prompt);

    // A provider that cannot draw text takes overlay pages but not in_image ones.
    writePlan(root, fx.PAGE_2, 'comfyui');
    assert.strictEqual(compile(root, fx.PAGE_2, { providerId: 'comfyui' }).pkg.model, 'sd_xl_base_1.0.safetensors');
    fx.editYaml(root, 'project.yaml', (project) => { project.lettering.mode = 'in_image'; });
    expectError(() => compile(root, fx.PAGE_2, { providerId: 'comfyui' }), 'provider_rejected',
      /in-image lettering is not supported/);
  });
}

function testRefusals() {
  return fx.withWorkspace((root) => {
    // No reference plan yet.
    expectError(() => compile(root, fx.PAGE_2), 'plan_missing', /build-reference-plan\.js/);
    writePlan(root, fx.PAGE_2);

    // The frozen style block is mandatory.
    const blockFile = fx.abs(root, 'style/style-block.txt');
    const block = fs.readFileSync(blockFile, 'utf8');
    fs.unlinkSync(blockFile);
    expectError(() => compile(root, fx.PAGE_2), 'style_block_missing', /style\/style-block\.txt/);
    fs.writeFileSync(blockFile, '   \n');
    expectError(() => compile(root, fx.PAGE_2), 'style_block_missing');
    fs.writeFileSync(blockFile, block);

    // Unsupported aspect ratio: a clear provider error.
    fx.editYaml(root, 'project.yaml', (project) => { project.page.aspect_ratio = '5:7'; });
    expectError(() => compile(root, fx.PAGE_2), 'provider_rejected',
      /aspect ratio 5:7 is not supported \(supported: 2:3, 3:4, 9:16, 1:1/);
    fx.editYaml(root, 'project.yaml', (project) => { project.page.aspect_ratio = '2:3'; });

    // A plan built for a roomier provider is re-checked against this one.
    writePlan(root, fx.PAGE_2, 'comfyui');
    const trimmed = compile(root, fx.PAGE_2);
    assert.strictEqual(trimmed.pkg.references.length, 4, 'optional references are trimmed to the budget');
    assert.ok(trimmed.warnings.some((w) => /built for comfyui/.test(w)));
    expectError(() => compile(root, fx.PAGE_2, { providerId: 'replicate' }), 'budget_exceeded',
      /Rebuild the reference plan for replicate/);

    // A required reference that lost its approval stops the compile.
    writePlan(root, fx.PAGE_2);
    fx.editYaml(root, 'references/manifest.yaml', (doc) => {
      doc.assets.find((a) => a.id === 'CHAR_OSKAR_TURN_MASTER_V01').status = 'superseded';
    });
    expectError(() => compile(root, fx.PAGE_2), 'reference_unusable', /is superseded, not approved/);
    fx.editYaml(root, 'references/manifest.yaml', (doc) => {
      doc.assets.find((a) => a.id === 'CHAR_OSKAR_TURN_MASTER_V01').status = 'approved';
    });

    // An optional previous render that lost its passing review is dropped.
    fs.unlinkSync(ws.reviewFile(root, 'PG_001_001_V01'));
    const dropped = compile(root, fx.PAGE_2);
    assert.strictEqual(dropped.pkg.references.length, 3);
    assert.ok(dropped.warnings.some((w) => /PG_001_001_V01 dropped: it no longer has a passing review/.test(w)));

    // Model pinning per provider and by option.
    writePlan(root, fx.PAGE_2, 'gemini');
    assert.strictEqual(compile(root, fx.PAGE_2, { providerId: 'gemini' }).pkg.model, 'gemini-2.5-flash-image');
    assert.strictEqual(compile(root, fx.PAGE_2, { providerId: 'gemini', model: 'custom/model' }).pkg.model, 'custom/model');
    assert.strictEqual(compile(root, fx.PAGE_2, { providerId: 'gemini' }).pkg.id, 'PP_PG_001_002_GEMINI');
  });
}

function testRepair() {
  return fx.withWorkspace((root) => {
    writePlan(root, fx.PAGE_2);
    const review = ws.loadReview(root, FLAGGED);
    const target = 'issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V01.png';

    // Open blocking findings win; the minor one waits.
    assert.deepStrictEqual(selectFindings(review).map((f) => f.id), ['F01']);

    const { pkg, spec, warnings, fileName } = compile(root, fx.PAGE_2, { repairReview: review });
    assertSchemaValid(pkg);
    assert.strictEqual(fileName, 'harness-native.yaml');
    assert.strictEqual(pkg.mode, 'repair');
    assert.strictEqual(pkg.edit_target, target, 'the edit target is the reviewed render');
    assert.deepStrictEqual(pkg.repair.of_render, FLAGGED);
    assert.deepStrictEqual(pkg.repair.findings, ['F01']);
    assert.deepStrictEqual(pkg.repair.changes, [
      "Panel 3: Redraw the boy's head and jacket from Oskar's sheet. Expected result: Oskar has a round face, a dark uneven fringe and a hooded jacket.",
    ], 'each change carries finding.repair and finding.expected');
    assert.deepStrictEqual(pkg.repair.locked, [
      'Panels 1, 2, and 4: every figure, object, background, and line stays as it is.',
      'All lettering: every balloon, caption, and sound effect keeps its exact text, shape, and position.',
      'Panel borders, gutters, and the grid of 4 panels.',
      'Inside the changed panels, everything CHANGES does not name.',
      'The drawing style, and the identity and wardrobe of every character CHANGES does not name.',
    ]);
    assert.deepStrictEqual(pkg.lettering_text, STRINGS_P2, 'the repaired page must still carry every string');

    // The edit target takes one image slot: the optional previous page goes.
    assert.deepStrictEqual(pkg.references.map((r) => r.asset_id),
      ['LOOK_NOIR_INK_MASTER_V01', 'CHAR_MARA_TURN_MASTER_V01', 'CHAR_OSKAR_TURN_MASTER_V01']);
    assert.ok(warnings.some((w) => /PG_001_001_V01 \(spatial_continuity\) not attached: .*one of them the edit target/.test(w)));
    assert.deepStrictEqual(spec.body.images.map((i) => i.role), ['edit_target', 'style', 'identity', 'identity']);
    assert.strictEqual(spec.body.images[0].image_path, target);
    assert.strictEqual(spec.body.mode, 'repair');

    // The repair prompt: style block, legend with the page as image 1,
    // failing panels, exact changes, locked elements.
    const prompt = pkg.prompt;
    assert.ok(prompt.startsWith(`${ws.loadStyleBlock(root)}\n\nREPAIR\nEdit Image 1, the rendered comic page.`));
    const legend = section(prompt, 'REFERENCE IMAGES').split('\n').filter((l) => /^Image \d+:/.test(l));
    assert.strictEqual(legend.length, 4);
    assert.ok(legend[0].startsWith('Image 1: the rendered page to edit.'));
    assert.ok(legend[1].startsWith('Image 2: drawing style only'));
    assert.ok(legend[3].startsWith('Image 4: identity of Oskar.'));
    const failing = section(prompt, 'FAILING PANELS');
    assert.ok(failing.includes('Panel 3 (tier 2 of 2, left). Failed check: identity.'));
    assert.ok(failing.includes("Visible now: The boy has Mara's long face, broken nose and cropped grey hair."));
    assert.ok(failing.includes('Expected: Oskar has a round face, a dark uneven fringe and a hooded jacket.'));
    assert.ok(section(prompt, 'CHANGES').includes(`1. ${pkg.repair.changes[0]}`));
    const planned = section(prompt, 'PLANNED CONTENT OF THE CHANGED PANELS');
    assert.ok(planned.includes('Panel 3 of 4.') && !planned.includes('Panel 2 of 4.'), 'only the failing panel is restated');
    assert.ok(planned.includes('Oskar is not Mara.'), 'the repair restates how the two differ');
    const locked = section(prompt, 'LOCKED, DO NOT CHANGE');
    for (const line of pkg.repair.locked) assert.ok(locked.includes(`- ${line}`));
    assert.ok(section(prompt, 'HARD CONSTRAINTS').includes('The page still has exactly 4 panels in the same positions.'));

    // With no blocking finding open, every open finding is repaired.
    const minorOnly = JSON.parse(JSON.stringify(review));
    minorOnly.findings[0].status = 'fixed';
    const minor = compile(root, fx.PAGE_2, { repairReview: minorOnly }).pkg;
    assert.deepStrictEqual(minor.repair.findings, ['F02']);
    assert.ok(minor.repair.changes[0].startsWith("Panel 4: Tear the left cuff of Mara's coat. Expected result:"));
    assert.ok(minor.repair.locked[0].startsWith('Panels 1, 2, and 3:'));

    // A lettering finding unlocks only the lettering it names.
    const letteringFinding = JSON.parse(JSON.stringify(review));
    letteringFinding.findings[0] = Object.assign({}, letteringFinding.findings[0], {
      check: 'lettering', repair: 'Reletter the whisper balloon with the exact text.', expected: 'The balloon reads: Don\'t tell the patrol.',
    });
    assert.ok(compile(root, fx.PAGE_2, { repairReview: letteringFinding }).pkg.repair.locked
      .includes('All lettering that CHANGES does not name: text, shape, and position stay as they are.'));

    // A page-level finding locks no panel wholesale and restates every panel.
    const pageLevel = JSON.parse(JSON.stringify(review));
    pageLevel.findings[0] = Object.assign({}, pageLevel.findings[0], {
      panel: null, check: 'page_structure', repair: 'Remove the fifth inset frame', expected: 'Four panels in a 2 / 2 grid.',
    });
    const whole = compile(root, fx.PAGE_2, { repairReview: pageLevel }).pkg;
    assert.ok(whole.repair.changes[0].startsWith('Whole page: Remove the fifth inset frame.'));
    assert.ok(!whole.repair.locked.some((l) => /^Panels? \d/.test(l)));
    assert.ok(whole.prompt.includes('Whole page. Failed check: page structure.'));
    assert.ok(section(whole.prompt, 'PLANNED CONTENT OF THE CHANGED PANELS').includes('Panel 1 of 4.'));

    // Nothing open: nothing to repair.
    const clean = JSON.parse(JSON.stringify(review));
    clean.findings.forEach((f) => { f.status = 'fixed'; });
    expectError(() => compile(root, fx.PAGE_2, { repairReview: clean }), 'nothing_to_repair');

    // The review must belong to this page, and its render must exist.
    expectError(() => compile(root, fx.PAGE_1, { repairReview: review, plan: writePlan(root, fx.PAGE_1) }),
      'review_mismatch');
    const lost = Object.assign({}, review, { render: 'PG_001_002_V07' });
    expectError(() => compile(root, fx.PAGE_2, { repairReview: lost }), 'edit_target_missing', /not on disk/);
    expectError(() => compile(root, fx.PAGE_2, { repairReview: review, panel: 'PN_001_002_03' }), 'bad_arguments');

    // Repair needs a provider that can edit images.
    fx.editYaml(root, 'project.yaml', (project) => { project.lettering.mode = 'overlay'; });
    expectError(() => compile(root, fx.PAGE_2, { repairReview: review, providerId: 'comfyui' }), 'provider_rejected',
      /image editing is not supported/);
    // fal's text-to-image default refuses; an editing model pinned by hand passes.
    expectError(() => compile(root, fx.PAGE_2, { repairReview: review, providerId: 'fal' }), 'provider_rejected',
      /cannot edit a page/);
    const falRepair = compile(root, fx.PAGE_2, { repairReview: review, providerId: 'fal', model: 'some/editing-model' });
    assert.strictEqual(falRepair.pkg.model, 'some/editing-model');
    assert.strictEqual(falRepair.spec.body.image_urls[0], target, 'the edit target is the first image sent');
  });
}

function testRepairCycleLimit() {
  return fx.withWorkspace((root) => {
    writePlan(root, fx.PAGE_2);
    const review = ws.loadReview(root, FLAGGED);

    // One cycle used of two: still allowed.
    assert.strictEqual(compile(root, fx.PAGE_2, { repairReview: Object.assign({}, review, { repair_cycle: 1 }) }).pkg.mode, 'repair');

    // repair_cycle equals repair_policy.max_cycles: refused.
    const err = expectError(
      () => compile(root, fx.PAGE_2, { repairReview: Object.assign({}, review, { repair_cycle: 2 }) }),
      'repair_limit', /repair limit reached \(repair_cycle 2, repair_policy\.max_cycles 2\)/);
    assert.ok(/Fix the page plan or the references first/.test(err.message),
      'the refusal tells the user what to do instead');
    expectError(() => compile(root, fx.PAGE_2, { repairReview: Object.assign({}, review, { repair_cycle: 3 }) }), 'repair_limit');

    // The project sets the limit.
    fx.editYaml(root, 'project.yaml', (project) => { project.repair_policy.max_cycles = 1; });
    expectError(() => compile(root, fx.PAGE_2, { repairReview: Object.assign({}, review, { repair_cycle: 1 }) }), 'repair_limit');
    fx.editYaml(root, 'project.yaml', (project) => { project.repair_policy.max_cycles = 0; });
    expectError(() => compile(root, fx.PAGE_2, { repairReview: review }), 'repair_limit', /max_cycles 0/);
    // Default is two when the project is silent.
    fx.editYaml(root, 'project.yaml', (project) => { delete project.repair_policy; });
    assert.strictEqual(compile(root, fx.PAGE_2, { repairReview: Object.assign({}, review, { repair_cycle: 1 }) }).pkg.mode, 'repair');
    expectError(() => compile(root, fx.PAGE_2, { repairReview: Object.assign({}, review, { repair_cycle: 2 }) }), 'repair_limit');
  });
}

function testPerPanel() {
  return fx.withWorkspace((root) => {
    writePlan(root, fx.PAGE_2);
    const { pkg, fileName } = compile(root, fx.PAGE_2, { panel: 'PN_001_002_03' });
    assertSchemaValid(pkg);
    assert.strictEqual(fileName, 'harness-native.PN_001_002_03.yaml');
    assert.strictEqual(pkg.id, 'PP_PG_001_002_HARNESS-NATIVE-P03');
    assert.strictEqual(pkg.page, fx.PAGE_2);
    assert.deepStrictEqual(pkg.references.map((r) => r.asset_id),
      ['LOOK_NOIR_INK_MASTER_V01', 'CHAR_OSKAR_TURN_MASTER_V01', 'PG_001_001_V01'],
      'only the images this panel needs are attached');
    assert.strictEqual(pkg.parameters.aspect_ratio, '2:3', 'half-width panel of a two-tier 2:3 page');
    assert.ok(!('resolution' in pkg.parameters));
    assert.deepStrictEqual(pkg.lettering_text, ["Don't tell the patrol."]);
    assert.ok(pkg.prompt.includes('One single comic panel drawn as its own image'));
    assert.ok(pkg.prompt.includes('Image 2: identity of Oskar.'));
    assert.ok(!pkg.prompt.includes('identity of Mara'));
    assert.ok(pkg.prompt.includes('- Named characters in the image: Oskar, each exactly once.'));
    expectError(() => compile(root, fx.PAGE_2, { panel: 'PN_001_002_09' }), 'panel_missing');
  });
}

function testCli() {
  return fx.withWorkspace((root) => {
    writePlan(root, fx.PAGE_2);
    const pageFile = fx.pageFile(root, fx.PAGE_2);
    const out = path.join(path.dirname(pageFile), 'prompts', 'harness-native.yaml');
    const expected = compile(root, fx.PAGE_2).pkg;

    const ok = spawnSync(process.execPath, [SCRIPT, '--page', pageFile], { encoding: 'utf8' });
    assert.strictEqual(ok.status, 0, ok.stderr);
    assert.deepStrictEqual(yaml.parse(fs.readFileSync(out, 'utf8')), expected,
      'the file on disk parses back to the compiled package, prompt included');
    assert.ok(/PP_PG_001_002_HARNESS-NATIVE \(generate, harness-native, model harness-native\)/.test(ok.stdout));

    // --repair writes the repair package to the same path.
    const reviewFile = ws.reviewFile(root, FLAGGED);
    const repair = spawnSync(process.execPath, [SCRIPT, '--page', pageFile, '--repair', reviewFile], { encoding: 'utf8' });
    assert.strictEqual(repair.status, 0, repair.stderr);
    const repaired = yaml.parse(fs.readFileSync(out, 'utf8'));
    assert.strictEqual(repaired.mode, 'repair');
    assert.deepStrictEqual(repaired.repair.findings, ['F01']);

    // The repair-cycle refusal exits 1, explains itself, and leaves the file alone.
    const before = fs.readFileSync(out, 'utf8');
    fx.editYaml(root, `issues/ISS_001/pages/${fx.PAGE_2}/reviews/${FLAGGED}.review.yaml`, (r) => { r.repair_cycle = 2; });
    const refused = spawnSync(process.execPath, [SCRIPT, '--page', pageFile, '--repair', reviewFile], { encoding: 'utf8' });
    assert.strictEqual(refused.status, 1);
    assert.ok(/repair limit reached/.test(refused.stderr) && /Fix the page plan or the references first/.test(refused.stderr),
      refused.stderr);
    assert.strictEqual(fs.readFileSync(out, 'utf8'), before);

    // --provider picks another adapter and file.
    const other = spawnSync(process.execPath, [SCRIPT, '--page', pageFile, '--provider', 'gemini'], { encoding: 'utf8' });
    assert.strictEqual(other.status, 0, other.stderr);
    const gemini = yaml.parse(fs.readFileSync(path.join(path.dirname(out), 'gemini.yaml'), 'utf8'));
    assert.strictEqual(gemini.provider, 'gemini');
    assert.strictEqual(gemini.model, 'gemini-2.5-flash-image');
    assert.strictEqual(gemini.references.length, 3, 'gemini takes 3 images; the optional previous page is trimmed');
    assert.ok(/warning: the reference plan was built for harness-native/.test(other.stdout), other.stdout);
    assert.strictEqual(fs.readFileSync(out, 'utf8'), before, 'another provider writes its own file');

    // Missing --page and a missing plan both exit 1 with a way forward.
    const noPage = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.strictEqual(noPage.status, 1);
    const noPlan = spawnSync(process.execPath, [SCRIPT, '--page', fx.pageFile(root, fx.PAGE_1)], { encoding: 'utf8' });
    assert.strictEqual(noPlan.status, 1);
    assert.ok(/build-reference-plan\.js/.test(noPlan.stderr), noPlan.stderr);
  });
}

const LOOK = { asset_id: 'LOOK_NOIR_INK_MASTER_V01', role: 'style', image_path: 'references/style/LOOK_NOIR_INK_MASTER_V01.png' };
const MARA_ID = { asset_id: 'CHAR_MARA_TURN_MASTER_V01', role: 'identity', image_path: 'characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png' };
const MARA_IS_NOT_OSKAR = 'Mara is not Oskar. Mara: broken nose, grey cropped hair, oilskin coat with a torn left cuff. ' +
  'Oskar: round face, hooded jacket, cut on his left hand. Do not swap or blend their features.';

/** Checks every asset package shares: scope, shape, style block, no IDs. */
function assertSheetPackage(root, result, expected) {
  const { pkg, spec, fileRel } = result;
  assertSchemaValid(pkg);
  assert.strictEqual(pkg.id, expected.id);
  assert.strictEqual(fileRel, expected.file);
  assert.strictEqual(pkg.page, null, 'asset scope: page is null');
  assert.strictEqual(pkg.asset, expected.asset);
  assert.strictEqual(pkg.mode, 'generate');
  assert.strictEqual(pkg.edit_target, null);
  assert.strictEqual(pkg.status, 'compiled');
  assert.deepStrictEqual(pkg.lettering_text, []);
  assert.strictEqual(pkg.model, spec.model);
  assert.deepStrictEqual(pkg.references, expected.references);
  assert.strictEqual(pkg.parameters.aspect_ratio, expected.ratio);
  assert.strictEqual(pkg.parameters.seed, null);
  assert.deepStrictEqual(Object.keys(pkg), ['id', 'page', 'asset', 'provider', 'model', 'mode', 'prompt',
    'negative_prompt', 'parameters', 'references', 'edit_target', 'lettering_text', 'status', 'source_hashes']);
  assert.deepStrictEqual(Object.keys(pkg.source_hashes), ['style_block']);
  assert.ok(/^[a-f0-9]{16}$/.test(pkg.source_hashes.style_block));
  assert.ok(pkg.prompt.startsWith(`${ws.loadStyleBlock(root)}\n\nSHEET\n`), 'the style block opens the prompt verbatim');
  assert.ok(pkg.prompt.trimEnd().split('\n\n').pop().startsWith('HARD CONSTRAINTS\n'), 'constraints close the prompt');
  assert.ok(!/\b(CHAR|PROP|LOC|LOOK|WARD)_[A-Z0-9_]+/.test(pkg.prompt), 'IDs stay out of the model-facing text');
  const legend = section(pkg.prompt, 'REFERENCE IMAGES').split('\n').filter((l) => /^Image \d+:/.test(l));
  assert.strictEqual(legend.length, pkg.references.length, 'one legend line per attached image');
  return pkg;
}

function testSheets() {
  return fx.withWorkspace((root) => {
    // --- character: turnaround -------------------------------------------
    const turn = assertSheetPackage(root, compileAsset(root, 'CHAR_MARA', { sheet: 'turnaround' }), {
      id: 'PP_CHAR_MARA_HARNESS-NATIVE-TURN',
      file: 'characters/CHAR_MARA/refs/prompts/harness-native.turnaround.yaml',
      asset: 'CHAR_MARA',
      references: [LOOK],
      ratio: '1:1',
    });
    const turnBrief = section(turn.prompt, 'SHEET');
    assert.ok(turnBrief.includes('Character turnaround sheet of one character: Mara.'));
    assert.ok(turnBrief.includes('Four full-figure views of the same person in one row, left to right: front, three-quarter, profile, back.'));
    assert.ok(turnBrief.includes('All four figures at the same scale, heads level, feet on one baseline.'));
    assert.ok(turnBrief.includes('The face is fully readable in the front, three-quarter, and profile views.'));
    assert.ok(turnBrief.includes('Plain light background with nothing in it. Flat, even light: no cast shadow across the face or the subject, no dramatic or scene lighting.'));
    assert.ok(turnBrief.includes('One image, square format, aspect ratio 1:1.'));
    assert.ok(section(turn.prompt, 'REFERENCE IMAGES').includes('Image 1: drawing style only'));
    const turnSubject = section(turn.prompt, 'SUBJECT');
    assert.deepStrictEqual(turnSubject.split('\n'), [
      'SUBJECT',
      'Name: Mara.',
      'In one line: Wiry woman in her fifties with cropped grey hair, a broken nose and an oilskin coat torn at the left cuff.',
      'Summary: Ferry pilot in her fifties, weathered, economical in movement.',
      'Age: fifties.',
      'Build: wiry, slightly stooped.',
      'Hair: grey, cropped.',
      'Face: long face, deep-set eyes, broken nose.',
      'Distinguishing features, all visible: broken nose; grey cropped hair; oilskin coat with a torn left cuff.',
      'Outfit: Black oilskin coat torn at the left cuff, wool cap, rubber boots.',
      'Layers: oilskin coat; wool jumper; wool cap; rubber boots.',
      'Hands: bare.',
      MARA_IS_NOT_OSKAR,
    ], 'the canonical description comes from the bible, with the difference line');
    const turnHard = section(turn.prompt, 'HARD CONSTRAINTS');
    assert.ok(turnHard.includes('- One character only, Mara, shown exactly four times: front, three-quarter, profile, back. No other figure.'));
    assert.ok(turnHard.includes('- No text, labels, arrows, numbers, or color swatches.'));
    assert.ok(!turn.prompt.includes('identity of'), 'a turnaround does not inherit from an older sheet');
    assert.ok(/labels/.test(turn.negative_prompt));

    // The difference line also runs the other way: Oskar lists nobody.
    const oskar = compileAsset(root, 'CHAR_OSKAR', { sheet: 'turnaround' }).pkg;
    assert.ok(section(oskar.prompt, 'SUBJECT').includes('Oskar is not Mara. Oskar: round face, hooded jacket, cut on his left hand.'));

    // --- character: expressions, with the identity master ------------------
    const exprResult = compileAsset(root, 'CHAR_MARA', { sheet: 'expressions' });
    const expr = assertSheetPackage(root, exprResult, {
      id: 'PP_CHAR_MARA_HARNESS-NATIVE-EXPR',
      file: 'characters/CHAR_MARA/refs/prompts/harness-native.expressions.yaml',
      asset: 'CHAR_MARA',
      references: [LOOK, MARA_ID],
      ratio: '1:1',
    });
    assert.deepStrictEqual(exprResult.notes, []);
    const exprLegend = section(expr.prompt, 'REFERENCE IMAGES');
    assert.ok(exprLegend.includes('Image 1: drawing style only'));
    assert.ok(exprLegend.includes('Image 2: identity of Mara. Match the face, hair, build, and proportions exactly.'));
    assert.deepStrictEqual(exprResult.spec.body.images.map((i) => [i.position, i.role]), [[1, 'style'], [2, 'identity']]);
    const exprBrief = section(expr.prompt, 'SHEET');
    assert.ok(exprBrief.includes('6 head-and-shoulders drawings of the same head in a grid of 3 columns and 2 rows, read left to right, top to bottom: ' +
      '1. neutral; 2. wary; 3. angry; 4. afraid; 5. in pain; 6. relieved.'));
    assert.ok(exprBrief.includes('Only the expression changes.'));
    assert.ok(section(expr.prompt, 'HARD CONSTRAINTS').includes('- One character only: the head of Mara, exactly 6 times. No other figure.'));
    // A chosen set of expressions.
    const four = compileAsset(root, 'CHAR_MARA', { sheet: 'expressions', expressions: 'Neutral, listening , angry,neutral, spent' }).pkg;
    assert.ok(four.prompt.includes('4 head-and-shoulders drawings of the same head in a grid of 2 columns and 2 rows, read left to right, top to bottom: ' +
      '1. neutral; 2. listening; 3. angry; 4. spent.'));
    assert.ok(four.prompt.includes('exactly 4 times'));
    // No approved identity master yet: refused, the face is not settled.
    const oskarExpr = fx.withWorkspace((other) => {
      fx.editYaml(other, 'references/manifest.yaml', (doc) => {
        doc.assets.find((a) => a.id === 'CHAR_OSKAR_TURN_MASTER_V01').status = 'review';
      });
      return expectError(() => compileAsset(other, 'CHAR_OSKAR', { sheet: 'expressions' }), 'master_required',
        /expressions sheet is drawn from the approved identity master of Oskar .*CHAR_OSKAR_TURN_MASTER_V01 is review/);
    });

    // --- character: wardrobe ------------------------------------------------
    const ward = assertSheetPackage(root, compileAsset(root, 'CHAR_MARA', { sheet: 'wardrobe' }), {
      id: 'PP_CHAR_MARA_HARNESS-NATIVE-WARD-OILSKIN',
      file: 'characters/CHAR_MARA/refs/prompts/harness-native.wardrobe.WARD_MARA_OILSKIN.yaml',
      asset: 'CHAR_MARA',
      references: [LOOK, MARA_ID],
      ratio: '1:1',
    });
    assert.ok(section(ward.prompt, 'SHEET').includes('Two full-figure views of the same person side by side: front on the left, back on the right.'));
    assert.deepStrictEqual(section(ward.prompt, 'OUTFIT').split('\n'), [
      'OUTFIT',
      'The outfit on this sheet: Black oilskin coat torn at the left cuff, wool cap, rubber boots.',
      'Layers: oilskin coat; wool jumper; wool cap; rubber boots.',
      'Hands: bare.',
    ], 'the outfit comes from wardrobe.yaml (default_wardrobe when --outfit is not given)');
    assert.ok(section(ward.prompt, 'SUBJECT').includes(MARA_IS_NOT_OSKAR));
    assert.ok(!section(ward.prompt, 'SUBJECT').includes('Outfit:'), 'the outfit is stated once, in its own section');
    // --outfit picks another outfit of the character.
    fx.editYaml(root, 'characters/CHAR_MARA/wardrobe.yaml', (doc) => {
      doc.outfits.push({ id: 'WARD_MARA_SUNDAY', description: 'Dark wool suit, white shirt buttoned to the neck', accessories: ['brooch'], hands: 'gloved' });
    });
    const sundayResult = compileAsset(root, 'CHAR_MARA', { sheet: 'wardrobe', outfit: 'WARD_MARA_SUNDAY' });
    const sunday = sundayResult.pkg;
    assert.strictEqual(sundayResult.fileRel, 'characters/CHAR_MARA/refs/prompts/harness-native.wardrobe.WARD_MARA_SUNDAY.yaml',
      'a second outfit gets its own package file');
    assert.deepStrictEqual(section(sunday.prompt, 'OUTFIT').split('\n'), [
      'OUTFIT',
      'The outfit on this sheet: Dark wool suit, white shirt buttoned to the neck.',
      'Accessories: brooch.',
      'Hands: gloved.',
    ]);
    assert.strictEqual(sunday.id, 'PP_CHAR_MARA_HARNESS-NATIVE-WARD-SUNDAY');
    assertSchemaValid(sunday);
    expectError(() => compileAsset(root, 'CHAR_MARA', { sheet: 'wardrobe', outfit: 'WARD_MARA_NONE' }), 'outfit_missing',
      /outfits on file: WARD_MARA_OILSKIN, WARD_MARA_SUNDAY/);

    // --- any entity: detail -------------------------------------------------
    const detail = assertSheetPackage(root,
      compileAsset(root, 'CHAR_OSKAR', { sheet: 'detail', subject: 'the cut on his left hand.' }), {
        id: 'PP_CHAR_OSKAR_HARNESS-NATIVE-DETAIL-CUT_ON_HIS_LEFT_HAND',
        file: 'characters/CHAR_OSKAR/refs/prompts/harness-native.detail.cut-on-his-left-hand.yaml',
        asset: 'CHAR_OSKAR',
        references: [LOOK],
        ratio: '1:1',
      });
    assert.ok(detail.prompt.includes('Detail sheet: a close study of one detail of Oskar: the cut on his left hand.\n'));
    expectError(() => compileAsset(root, 'CHAR_OSKAR', { sheet: 'detail' }), 'bad_arguments', /--subject/);
    assert.strictEqual(compileAsset(root, 'PROP_FLARE_GUN', { sheet: 'detail', subject: 'the lanyard ring' }).fileRel,
      'props/PROP_FLARE_GUN/refs/prompts/harness-native.detail.lanyard-ring.yaml');
    // A second detail of the same entity is a second package.
    const fringe = compileAsset(root, 'CHAR_OSKAR', { sheet: 'detail', subject: 'His dark, uneven fringe' });
    assert.strictEqual(fringe.fileRel, 'characters/CHAR_OSKAR/refs/prompts/harness-native.detail.his-dark-uneven-fringe.yaml');
    assert.strictEqual(fringe.pkg.id, 'PP_CHAR_OSKAR_HARNESS-NATIVE-DETAIL-HIS_DARK_UNEVEN_FRINGE');
    assertSchemaValid(fringe.pkg);
    expectError(() => compileAsset(root, 'CHAR_OSKAR', { sheet: 'detail', subject: '?!' }), 'bad_arguments', /no letter or digit/);

    // --- location: plate ----------------------------------------------------
    const plate = assertSheetPackage(root, compileAsset(root, 'LOC_FERRY_DECK', { sheet: 'plate' }), {
      id: 'PP_LOC_FERRY_DECK_HARNESS-NATIVE-PLATE',
      file: 'locations/LOC_FERRY_DECK/refs/prompts/harness-native.plate.yaml',
      asset: 'LOC_FERRY_DECK',
      references: [LOOK],
      ratio: '3:2',
    });
    const plateBrief = section(plate.prompt, 'SHEET');
    assert.ok(plateBrief.includes('Establishing plate of one location: Ferry deck.'));
    assert.ok(plateBrief.includes('One wide view of the whole place, empty: no characters, no figures, no silhouettes.'));
    assert.ok(plateBrief.includes("Lit by the location's own light sources as described below, at night."));
    assert.ok(plateBrief.includes('One image, landscape format, aspect ratio 3:2.'));
    assert.ok(!plateBrief.includes('Flat, even light'), 'a plate keeps the light of the place');
    assert.deepStrictEqual(section(plate.prompt, 'SUBJECT').split('\n'), [
      'SUBJECT',
      'Name: Ferry deck.',
      'In one line: Open steel deck of a small river ferry at night with a raised wheelhouse aft and two lashed crates.',
      'Summary: Open steel car deck of a small river ferry, wheelhouse raised aft.',
      'Architecture: Flat deck, low bulwarks, a steel ladder up to the wheelhouse.',
      'Dressing: Coiled mooring lines, two lashed crates, a fire bucket.',
      'Light: One shielded lamp on the wheelhouse; otherwise moonlight.',
    ]);
    assert.deepStrictEqual(section(plate.prompt, 'GEOGRAPHY').split('\n'), [
      'GEOGRAPHY',
      'Side convention: Bow is screen left, stern is screen right when facing port.',
      'Screen left is the bow. Screen right is the stern.',
      'Levels, bottom to top:',
      '1. Deck: Car deck, at water level.',
      '2. Wheelhouse: Raised cabin, reached by the ladder.',
      'Landmarks:',
      '- Crates: on the deck level, screen left. Two lashed crates near the bow.',
      '- Ladder: on the deck level, screen right. Steel ladder to the wheelhouse.',
      'The deck level connects to the wheelhouse level by the ladder.',
    ], 'levels, landmarks, and the side convention come from map.yaml');
    assert.ok(section(plate.prompt, 'HARD CONSTRAINTS').includes('- No characters, figures, or silhouettes anywhere in the image.'));
    assert.ok(/people, figures/.test(plate.negative_prompt));
    // The plate ratio follows what the provider offers.
    const landscapeless = { referenceImages: 4, aspectRatios: ['2:3', '1:1'], imageEditing: true, textRendering: 'unreliable' };
    const stub = Object.assign({}, require('../providers/image/manual'), { capabilities: landscapeless });
    assert.strictEqual(compileAsset(root, 'LOC_FERRY_DECK', { sheet: 'plate', provider: stub, providerId: 'manual' }).pkg.parameters.aspect_ratio,
      '2:3', 'no landscape ratio on offer: the page ratio');
    // A plate without a map compiles, with a warning.
    fs.unlinkSync(fx.abs(root, 'locations/LOC_FERRY_DECK/map.yaml'));
    const mapless = compileAsset(root, 'LOC_FERRY_DECK', { sheet: 'plate' });
    assert.ok(!mapless.pkg.prompt.includes('GEOGRAPHY'));
    assert.ok(mapless.warnings.some((w) => /map\.yaml is missing/.test(w)));

    // --- prop ---------------------------------------------------------------
    const prop = assertSheetPackage(root, compileAsset(root, 'PROP_FLARE_GUN', { sheet: 'prop' }), {
      id: 'PP_PROP_FLARE_GUN_HARNESS-NATIVE-SHEET',
      file: 'props/PROP_FLARE_GUN/refs/prompts/harness-native.prop.yaml',
      asset: 'PROP_FLARE_GUN',
      references: [LOOK],
      ratio: '1:1',
    });
    assert.ok(section(prop.prompt, 'SHEET').includes('Add a second, smaller side view when it shows a feature the first view hides.'));
    assert.deepStrictEqual(section(prop.prompt, 'SUBJECT').split('\n'), [
      'SUBJECT',
      'Name: Flare gun.',
      'In one line: Orange single-shot flare pistol with a wide stubby barrel.',
      'Summary: Orange single-shot flare pistol with a wide barrel.',
      'Distinguishing features, all visible: wide stubby barrel; lanyard ring.',
      'Size: held in one hand.',
    ]);
    assert.ok(section(prop.prompt, 'HARD CONSTRAINTS').includes('- One object only, Flare gun, shown once or twice. No hands, no figures, no setting.'));

    // --- look: a new version of an approved look attaches its master -------
    const look = assertSheetPackage(root, compileAsset(root, 'LOOK_NOIR_INK', { sheet: 'look' }), {
      id: 'PP_LOOK_NOIR_INK_HARNESS-NATIVE-LOOK',
      file: 'references/style/prompts/harness-native.LOOK_NOIR_INK.yaml',
      asset: 'LOOK_NOIR_INK',
      references: [LOOK],
      ratio: '2:3',
    });
    assert.strictEqual(look.parameters.resolution, '2000x3000', 'a look page is page-shaped');
    const lookBrief = section(look.prompt, 'SHEET');
    assert.ok(lookBrief.includes('Look page: one sample comic page that demonstrates the drawing style above and nothing else.'));
    assert.ok(lookBrief.includes('one anonymous adult figure who belongs to no story, in a plain everyday setting that suits a noir story.'));
    assert.ok(lookBrief.includes('Include one speech balloon and one caption box in the lettering style'));
    assert.ok(!look.prompt.includes('SUBJECT'), 'a look is built from the style only: no story content');
    assert.ok(!/Mara|Oskar|Ferry/.test(look.prompt));

    // --- first look: no approved master, no references, a note --------------
    const firstResult = compileAsset(root, 'LOOK_DAWN_WASH', { sheet: 'look' });
    const first = assertSheetPackage(root, firstResult, {
      id: 'PP_LOOK_DAWN_WASH_HARNESS-NATIVE-LOOK',
      file: 'references/style/prompts/harness-native.LOOK_DAWN_WASH.yaml',
      asset: 'LOOK_DAWN_WASH',
      references: [],
      ratio: '2:3',
    });
    assert.deepStrictEqual(firstResult.notes,
      ['LOOK_DAWN_WASH has no approved master yet: this is its first look, compiled with no reference image.']);
    assert.ok(section(first.prompt, 'REFERENCE IMAGES').includes('No reference images are attached.'));
    assert.deepStrictEqual(firstResult.spec.body.images, []);
    // The project's only look losing its approval makes it a first look again...
    fx.editYaml(root, 'references/manifest.yaml', (doc) => {
      doc.assets.find((a) => a.id === 'LOOK_NOIR_INK_MASTER_V01').status = 'review';
    });
    assert.deepStrictEqual(compileAsset(root, 'LOOK_NOIR_INK', { sheet: 'look' }).pkg.references, []);
    // ...and every other sheet waits for the look.
    const noLook = expectError(() => compileAsset(root, 'CHAR_MARA', { sheet: 'turnaround' }), 'look_unapproved',
      /LOOK_NOIR_INK_MASTER_V01 is review/);
    assert.ok(/finish the look first/.test(noLook.message));
    fx.editYaml(root, 'references/manifest.yaml', (doc) => {
      doc.assets = doc.assets.filter((a) => a.entity !== 'LOOK_NOIR_INK');
    });
    expectError(() => compileAsset(root, 'PROP_FLARE_GUN', { sheet: 'prop' }), 'look_missing');
    // Overlay lettering: the look page carries no text at all.
    fx.editYaml(root, 'project.yaml', (project) => { project.lettering.mode = 'overlay'; });
    const overlayLook = compileAsset(root, 'LOOK_NOIR_INK', { sheet: 'look' }).pkg;
    assert.ok(overlayLook.prompt.includes('No balloons, captions, or text of any kind'));
    assert.ok(section(overlayLook.prompt, 'HARD CONSTRAINTS').includes('- No text anywhere in the image.'));

    return oskarExpr;
  }).then((oskarExpr) => {
    assert.ok(/Draw the turnaround or the full character sheet, approve it, then draw this sheet\./.test(oskarExpr.message));
  });
}

/** Register a photo the person supplied, the way ingestion files it (kind detail, role identity, approved). */
function addPhoto(root, charId, n = 1, { listFirst = false } = {}) {
  const id = `${charId}_REF_V${String(n).padStart(2, '0')}`;
  const rel = `characters/${charId}/refs/${id}.jpg`;
  fx.writePng(root, rel);
  fx.editYaml(root, 'references/manifest.yaml', (doc) => {
    doc.assets.push({ id, entity: charId, kind: 'detail', path: rel, status: 'approved', default_role: 'identity', approved_by: 'person' });
  });
  if (listFirst) {
    fx.editYaml(root, `characters/${charId}/character.yaml`, (doc) => { doc.references = [id, ...(doc.references || [])]; });
  }
  return { asset_id: id, role: 'identity', image_path: rel };
}

/** Take every drawn sheet of a character out of the registry: only what the person supplied is left. */
function dropSheets(root, charId) {
  fx.editYaml(root, 'references/manifest.yaml', (doc) => {
    doc.assets = doc.assets.filter((a) => a.entity !== charId || a.kind === 'detail');
  });
  fx.editYaml(root, `characters/${charId}/character.yaml`, (doc) => { doc.references = []; });
}

const LIKENESS_LINE = /Image 2: a photo or drawing of the person Oskar is based on, for likeness only\. Translate this person into the comic style above: match the face, hair, and build\. Do not copy the photo's rendering, light, clothes, or background\./;

function testIdentityChain() {
  return fx.withWorkspace((root) => {
    // --- the first sheet of a character made from a photo ---------------------
    const photo = addPhoto(root, 'CHAR_OSKAR');
    dropSheets(root, 'CHAR_OSKAR');
    const turn = compileAsset(root, 'CHAR_OSKAR', { sheet: 'turnaround' });
    assertSchemaValid(turn.pkg);
    assert.deepStrictEqual(turn.pkg.references, [LOOK, photo], 'the turnaround attaches the photo as a likeness source');
    assert.match(section(turn.pkg.prompt, 'REFERENCE IMAGES'), LIKENESS_LINE);
    assert.ok(!turn.pkg.prompt.includes('Match the face, hair, build, and proportions exactly'), 'a photo is not a drawn identity sheet');
    assert.ok(turn.notes.some((n) => /CHAR_OSKAR_REF_V01 as likeness source/.test(n)), turn.notes.join(' | '));

    // Expressions and wardrobe wait for an approved drawn master.
    const refused = expectError(() => compileAsset(root, 'CHAR_OSKAR', { sheet: 'expressions' }), 'master_required');
    assert.ok(/CHAR_OSKAR_REF_V01\) are likeness sources for that first sheet only/.test(refused.message), refused.message);
    expectError(() => compileAsset(root, 'CHAR_OSKAR', { sheet: 'wardrobe' }), 'master_required');

    // A page with only a photo is refused: a photo is never a page reference.
    const pageErr = expectError(() => buildReferencePlan(root, ws.loadPage(root, fx.PAGE_2), { now: NOW }), 'identity_missing',
      /CHAR_OSKAR is drawn here but has no approved drawn sheet, only CHAR_OSKAR_REF_V01/);
    assert.ok(/never attached to a page or a cover/.test(pageErr.message));

    // --- once a drawn master is approved, the photo leaves the chain ----------
    const mara = addPhoto(root, 'CHAR_MARA', 1, { listFirst: true });
    const expr = compileAsset(root, 'CHAR_MARA', { sheet: 'expressions' });
    assert.deepStrictEqual(expr.pkg.references, [LOOK, MARA_ID], 'expressions: the master, not the photo listed first');
    assert.ok(!expr.pkg.references.some((r) => r.asset_id === mara.asset_id));
    assert.deepStrictEqual(compileAsset(root, 'CHAR_MARA', { sheet: 'wardrobe' }).pkg.references, [LOOK, MARA_ID]);
    // A new turnaround next to an approved one is a redesign: no photo, no old sheet.
    const redesign = compileAsset(root, 'CHAR_MARA', { sheet: 'turnaround' });
    assert.deepStrictEqual(redesign.pkg.references, [LOOK]);
    assert.ok(redesign.notes.some((n) => /CHAR_MARA_TURN_MASTER_V01 is the approved turnaround/.test(n)));
    // A page with the photo listed first still gets the turnaround.
    const plan = buildReferencePlan(root, ws.loadPage(root, fx.PAGE_1), { now: NOW }).doc;
    const identity = plan.required.filter((e) => e.role === 'identity').map((e) => e.asset_id);
    assert.deepStrictEqual(identity, ['CHAR_MARA_TURN_MASTER_V01'], 'the page attaches the drawn master only');

    // An entry with no kind is read from its tag (older registries).
    fx.editYaml(root, 'references/manifest.yaml', (doc) => { delete doc.assets.find((a) => a.id === 'CHAR_MARA_TURN_MASTER_V01').kind; });
    assert.deepStrictEqual(compileAsset(root, 'CHAR_MARA', { sheet: 'expressions' }).pkg.references, [LOOK, MARA_ID]);
  }).then(() => fx.withWorkspace((root) => {
    // A cover with only a photo of a character on it is refused too.
    addPhoto(root, 'CHAR_MARA');
    dropSheets(root, 'CHAR_MARA');
    fx.writeYaml(root, 'issues/ISS_001/cover/cover.yaml', {
      id: 'CV_001', issue: 'ISS_001', concept: 'Mara alone.', composition: 'Centred.', location: null, time_of_day: 'night',
      cast: [{ character: 'CHAR_MARA', wardrobe: 'WARD_MARA_OILSKIN', action: 'Stands.', acting: 'Still.', state: [], holding: [] }],
      props: [], lettering: { mode: 'overlay', title: 'The Night Ferry', issue_line: null, tagline: null, credits: null },
      generation: { provider: 'harness-native' }, status: 'draft', approved_render: null,
    });
    expectError(() => require('../scripts/compile-prompts').compileCover({ root, issue: 'ISS_001' }), 'identity_missing',
      /CV_001: CHAR_MARA is drawn here but has no approved drawn sheet, only CHAR_MARA_REF_V01/);
  }));
}

function testFullSheet() {
  return fx.withWorkspace((root) => {
    // --- the first full sheet of a character with an approved turnaround -------
    const result = compileAsset(root, 'CHAR_OSKAR', { sheet: 'model' });
    const pkg = assertSheetPackageModel(root, result);
    assert.deepStrictEqual(pkg.references, [LOOK,
      { asset_id: 'CHAR_OSKAR_TURN_MASTER_V01', role: 'identity', image_path: 'characters/CHAR_OSKAR/refs/CHAR_OSKAR_TURN_MASTER_V01.png' }],
    'the full sheet is drawn from the approved turnaround');
    const brief = section(pkg.prompt, 'SHEET');
    assert.ok(brief.includes('Full character sheet of one character: Oskar.'));
    assert.ok(brief.includes('Header, top left: the name "Oskar" lettered large, and under it a smaller line: "The Night Ferry · Character sheet 01".'));
    assert.ok(brief.includes('Top band, the turnaround: four full-figure views of the same person, left to right: front, three-quarter, profile, back.'));
    // Close-ups default to the distinguishing features; poses to four defaults plus the states the pages give.
    const oskar = ws.loadCharacter(root, 'CHAR_OSKAR');
    const features = oskar.description.distinguishing_features;
    assert.ok(brief.includes(`each with its label lettered under it: 1. "${features[0]}"`), brief);
    assert.ok(brief.includes('Bottom band, expressions and poses: 5 drawings of the same person in one row, each with its label lettered under it: 1. "neutral"; 2. "angry"; 3. "afraid"; 4. "sitting"; 5. "cut left hand".'), brief);
    assert.ok(brief.includes('Lettering on the sheet: only the name, the line under it, and the labels listed here, copied exactly'));
    assert.ok(section(pkg.prompt, 'HARD CONSTRAINTS').includes(`- Exactly ${features.length} close-up${features.length === 1 ? '' : 's'} and exactly 5 expression or pose drawings, each with its own label.`));
    assert.deepStrictEqual(pkg.lettering_text, ['Oskar', 'The Night Ferry · Character sheet 01', ...features, 'neutral', 'angry', 'afraid', 'sitting', 'cut left hand']);
    assert.ok(!/labels/.test(pkg.negative_prompt), 'the full sheet is lettered on purpose');

    // The person's lists win, then the character file's sheet block. The line follows the project language.
    const chosen = compileAsset(root, 'CHAR_OSKAR', { sheet: 'model', closeups: 'left hand: the cut across the palm; hood', poses: 'tired;crouching;tired' }).pkg;
    assert.ok(chosen.prompt.includes('2 framed close-ups drawn large, each with its label lettered under it: 1. "left hand": the cut across the palm; 2. "hood".'), chosen.prompt);
    assert.ok(chosen.prompt.includes('2 drawings of the same person in one row, each with its label lettered under it: 1. "tired"; 2. "crouching".'));
    fx.editYaml(root, 'characters/CHAR_OSKAR/character.yaml', (doc) => { doc.sheet = { closeups: ['mano izquierda: el corte'], poses: ['agotado'] }; });
    fx.editYaml(root, 'project.yaml', (doc) => { doc.language = 'es'; });
    const fromFile = compileAsset(root, 'CHAR_OSKAR', { sheet: 'model' }).pkg;
    assert.ok(fromFile.prompt.includes('"The Night Ferry · Hoja de personaje 01"'));
    assert.ok(fromFile.prompt.includes('1. "mano izquierda": el corte.'), fromFile.prompt);
    assert.ok(fromFile.prompt.includes('1 drawing of the same person in one row, each with its label lettered under it: 1. "agotado".'));

    // --- revision rounds ------------------------------------------------------
    fx.writePng(root, 'characters/CHAR_OSKAR/refs/CHAR_OSKAR_MODEL_V01.png');
    const revision = compileAsset(root, 'CHAR_OSKAR', {
      sheet: 'model',
      revise: 'CHAR_OSKAR_MODEL_V01',
      changes: [{ text: 'shorter hair' }, { text: 'the cut on the other hand', region: { x: 0.5, y: 0.25, w: 0.25, h: 0.25 } }],
    });
    const rev = revision.pkg;
    assertSchemaValid(rev);
    assert.strictEqual(rev.mode, 'repair');
    assert.strictEqual(rev.edit_target, 'characters/CHAR_OSKAR/refs/CHAR_OSKAR_MODEL_V01.png');
    assert.strictEqual(rev.id, 'PP_CHAR_OSKAR_HARNESS-NATIVE-MODEL', 'the next version of the same sheet');
    assert.deepStrictEqual(rev.references, [LOOK], 'the previous version carries the identity');
    assert.deepStrictEqual(rev.repair.changes, ['Shorter hair.',
      'In the area from 50% to 75% of the width (left to right) and from 25% to 50% of the height (top to bottom): The cut on the other hand.']);
    assert.ok(rev.repair.locked[0].startsWith('Everything CHANGES does not name'));
    assert.ok(rev.prompt.includes('\n\nREVISION\nEdit Image 1, the previous version of the full character sheet of Oskar.'));
    assert.ok(section(rev.prompt, 'REFERENCE IMAGES').includes('Image 1: the previous version of this character sheet, to edit.'));
    assert.ok(section(rev.prompt, 'CHANGES').includes('1. Shorter hair.'));
    assert.ok(section(rev.prompt, 'LOCKED, DO NOT CHANGE').includes('- The name header and the line under it, except for the sheet number.'));
    assert.ok(rev.prompt.includes('"The Night Ferry · Hoja de personaje 02"'), 'the next version number');
    assert.deepStrictEqual(revision.spec.body.images.map((i) => [i.position, i.role]), [[1, 'edit_target'], [2, 'style']]);
    // A photo attached to this round, for likeness only.
    const photo = addPhoto(root, 'CHAR_OSKAR');
    const withPhoto = compileAsset(root, 'CHAR_OSKAR', { sheet: 'model', revise: 'CHAR_OSKAR_MODEL_V01', changes: 'closer to the photo', likeness: photo.asset_id }).pkg;
    assert.deepStrictEqual(withPhoto.references, [LOOK, photo]);
    assert.match(withPhoto.prompt, /Image 3: a photo or drawing of the person Oskar is based on, for likeness only\./);
    // Refusals.
    expectError(() => compileAsset(root, 'CHAR_OSKAR', { sheet: 'model', revise: 'CHAR_OSKAR_MODEL_V01' }), 'bad_arguments', /--revise needs --changes/);
    expectError(() => compileAsset(root, 'CHAR_OSKAR', { sheet: 'model', changes: 'x' }), 'bad_arguments', /need --revise/);
    expectError(() => compileAsset(root, 'CHAR_OSKAR', { sheet: 'turnaround', revise: 'CHAR_OSKAR_TURN_V02', changes: 'x' }), 'bad_arguments', /apply to --sheet model only/);
    expectError(() => compileAsset(root, 'CHAR_OSKAR', { sheet: 'model', revise: 'CHAR_OSKAR_MODEL_V07', changes: 'x' }), 'revise_target_missing');
    expectError(() => compileAsset(root, 'CHAR_OSKAR', { sheet: 'model', revise: 'CHAR_OSKAR_MODEL_V01', changes: 'x', likeness: 'CHAR_OSKAR_TURN_MASTER_V01' }),
      'bad_arguments', /not an approved photo or drawing/);
    expectError(() => compileAsset(root, 'CHAR_OSKAR', { sheet: 'model', revise: 'CHAR_OSKAR_MODEL_V01', changes: 'x', providerId: 'comfyui' }), 'provider_rejected');

    // --- an approved full sheet is the identity master ------------------------
    fx.writePng(root, 'characters/CHAR_OSKAR/refs/CHAR_OSKAR_MODEL_MASTER_V01.png');
    fx.editYaml(root, 'references/manifest.yaml', (doc) => {
      doc.assets.push({ id: 'CHAR_OSKAR_MODEL_MASTER_V01', entity: 'CHAR_OSKAR', kind: 'model', path: 'characters/CHAR_OSKAR/refs/CHAR_OSKAR_MODEL_MASTER_V01.png', status: 'approved', default_role: 'identity' });
    });
    const MODEL = { asset_id: 'CHAR_OSKAR_MODEL_MASTER_V01', role: 'identity', image_path: 'characters/CHAR_OSKAR/refs/CHAR_OSKAR_MODEL_MASTER_V01.png' };
    assert.deepStrictEqual(compileAsset(root, 'CHAR_OSKAR', { sheet: 'expressions' }).pkg.references, [LOOK, MODEL]);
    assert.deepStrictEqual(compileAsset(root, 'CHAR_OSKAR', { sheet: 'turnaround' }).pkg.references, [LOOK, MODEL],
      'a turnaround drawn after the full sheet is drawn from it');
    // (The fixture page names the old turnaround itself; a page that names nothing gets the master.)
    fx.editYaml(root, `issues/ISS_001/pages/${fx.PAGE_2}/page.yaml`, (page) => { page.references.required = []; });
    const plan = buildReferencePlan(root, ws.loadPage(root, fx.PAGE_2), { now: NOW }).doc;
    assert.ok(plan.required.some((e) => e.asset_id === 'CHAR_OSKAR_MODEL_MASTER_V01' && e.role === 'identity'));
    assert.ok(!plan.required.some((e) => e.asset_id === 'CHAR_OSKAR_TURN_MASTER_V01'), 'one identity image per character');
    // The page legend keeps the sheet's labels out of the drawing.
    writePlan(root, fx.PAGE_2);
    const page = compile(root, fx.PAGE_2).pkg;
    assert.ok(/identity of Oskar\. Match the face, hair, build, and proportions exactly\. Do not copy the sheet's poses, layout, background, or labels, and letter none of its text\./.test(page.prompt));
    // A new full sheet next to the approved one is a redesign.
    const again = compileAsset(root, 'CHAR_OSKAR', { sheet: 'model' });
    assert.deepStrictEqual(again.pkg.references, [LOOK]);
    assert.ok(again.notes.some((n) => /revise it \(--revise\)/.test(n)));
  });
}

function assertSheetPackageModel(root, result) {
  const { pkg, fileRel } = result;
  assertSchemaValid(pkg);
  assert.strictEqual(pkg.id, 'PP_CHAR_OSKAR_HARNESS-NATIVE-MODEL');
  assert.strictEqual(fileRel, 'characters/CHAR_OSKAR/refs/prompts/harness-native.model.yaml');
  assert.strictEqual(pkg.mode, 'generate');
  assert.strictEqual(pkg.parameters.aspect_ratio, '3:2', 'a full sheet is landscape');
  assert.ok(pkg.prompt.startsWith(`${ws.loadStyleBlock(root)}\n\nSHEET\n`));
  assert.ok(!/\b(CHAR|PROP|LOC|LOOK|WARD)_[A-Z0-9_]+/.test(pkg.prompt), 'IDs stay out of the model-facing text');
  return pkg;
}

function testSheetRefusalsAndDeterminism() {
  return fx.withWorkspace((rootA) => fx.withWorkspace((rootB) => {
    // Deterministic: same inputs, same package, wherever the workspace lives.
    const cases = [
      ['CHAR_MARA', { sheet: 'turnaround' }],
      ['CHAR_MARA', { sheet: 'expressions' }],
      ['CHAR_MARA', { sheet: 'wardrobe' }],
      ['CHAR_OSKAR', { sheet: 'detail', subject: 'the cut on his left hand' }],
      ['LOC_FERRY_DECK', { sheet: 'plate' }],
      ['PROP_FLARE_GUN', { sheet: 'prop' }],
      ['LOOK_NOIR_INK', { sheet: 'look' }],
      ['LOOK_DAWN_WASH', { sheet: 'look' }],
    ];
    for (const [id, options] of cases) {
      const first = compileAsset(rootA, id, options).pkg;
      assert.deepStrictEqual(compileAsset(rootA, id, options).pkg, first, `${id} ${options.sheet}: compiling twice`);
      assert.deepStrictEqual(compileAsset(rootB, id, options).pkg, first, `${id} ${options.sheet}: another workspace copy`);
      assert.deepStrictEqual(yaml.parse(yaml.stringify(first)), first, `${id} ${options.sheet}: YAML round trip`);
      assert.ok(!/\d{4}-\d{2}-\d{2}/.test(first.prompt), 'no dates in the prompt');
    }

    // Kinds are checked against the entity type.
    const root = rootA;
    expectError(() => compileAsset(root, 'CHAR_MARA', { sheet: 'plate' }), 'bad_arguments',
      /a CHAR entity takes turnaround \| expressions \| wardrobe \| detail/);
    expectError(() => compileAsset(root, 'LOC_FERRY_DECK', { sheet: 'turnaround' }), 'bad_arguments', /a LOC entity takes plate \| detail/);
    expectError(() => compileAsset(root, 'PROP_FLARE_GUN', { sheet: 'look' }), 'bad_arguments', /a PROP entity takes prop \| detail/);
    expectError(() => compileAsset(root, 'LOOK_NOIR_INK', { sheet: 'prop' }), 'bad_arguments', /a LOOK entity takes look \| detail/);
    expectError(() => compileAsset(root, 'CHAR_MARA', {}), 'bad_arguments', /--sheet \(missing\)/);
    expectError(() => compileAsset(root, 'PG_001_001', { sheet: 'look' }), 'bad_arguments', /entity ID/);
    // The bible entry must exist.
    expectError(() => compileAsset(root, 'CHAR_NOBODY', { sheet: 'turnaround' }), 'entity_missing',
      /characters\/CHAR_NOBODY\/character\.yaml not found/);
    expectError(() => compileAsset(root, 'LOC_NOWHERE', { sheet: 'plate' }), 'entity_missing');
    expectError(() => compileAsset(root, 'PROP_NOTHING', { sheet: 'prop' }), 'entity_missing');

    // Provider budget and capabilities apply as for pages.
    assert.strictEqual(compileAsset(root, 'CHAR_MARA', { sheet: 'turnaround', providerId: 'replicate' }).pkg.references.length, 1);
    const over = expectError(() => compileAsset(root, 'CHAR_MARA', { sheet: 'expressions', providerId: 'replicate' }),
      'budget_exceeded', /needs 2 reference image\(s\) .* but replicate takes 1/);
    assert.ok(/Use a provider with a larger budget: comfyui \(8\)/.test(over.message));
    const gemini = compileAsset(root, 'CHAR_MARA', { sheet: 'expressions', providerId: 'gemini' });
    assert.strictEqual(gemini.pkg.id, 'PP_CHAR_MARA_GEMINI-EXPR');
    assert.strictEqual(gemini.pkg.model, 'gemini-2.5-flash-image');
    assert.strictEqual(gemini.fileRel, 'characters/CHAR_MARA/refs/prompts/gemini.expressions.yaml');
    assert.strictEqual(compileAsset(root, 'CHAR_MARA', { sheet: 'turnaround', providerId: 'gemini', model: 'custom/model' }).pkg.model, 'custom/model');
    // A provider that draws no text still takes sheets: they carry no lettering.
    assert.strictEqual(compileAsset(root, 'LOOK_NOIR_INK', { sheet: 'look', providerId: 'comfyui' }).pkg.model, 'sd_xl_base_1.0.safetensors');
    assert.ok(compileAsset(root, 'CHAR_MARA', { sheet: 'turnaround', providerId: 'fal' }).warnings
      .some((w) => /ignores the 1 input image/.test(w)));

    // The style block is mandatory here too.
    fs.unlinkSync(fx.abs(root, 'style/style-block.txt'));
    expectError(() => compileAsset(root, 'CHAR_MARA', { sheet: 'turnaround' }), 'style_block_missing');
  }));
}

function testSheetCli() {
  return fx.withWorkspace((root) => {
    const out = fx.abs(root, 'characters/CHAR_MARA/refs/prompts/harness-native.expressions.yaml');
    const expected = compileAsset(root, 'CHAR_MARA', { sheet: 'expressions' }).pkg;
    const ok = spawnSync(process.execPath, [SCRIPT, '--asset', 'CHAR_MARA', '--sheet', 'expressions', '--root', root], { encoding: 'utf8' });
    assert.strictEqual(ok.status, 0, ok.stderr);
    assert.deepStrictEqual(yaml.parse(fs.readFileSync(out, 'utf8')), expected, 'the file on disk is the compiled package');
    assert.ok(/PP_CHAR_MARA_HARNESS-NATIVE-EXPR \(asset CHAR_MARA, harness-native, model harness-native\)/.test(ok.stdout), ok.stdout);
    assert.ok(/2 reference image\(s\), aspect 1:1/.test(ok.stdout));

    // Without --root the workspace is found from the current directory.
    const cwd = spawnSync(process.execPath, [SCRIPT, '--asset', 'LOC_FERRY_DECK', '--sheet', 'plate', '--provider', 'gemini'],
      { encoding: 'utf8', cwd: fx.abs(root, 'issues/ISS_001') });
    assert.strictEqual(cwd.status, 0, cwd.stderr);
    assert.strictEqual(yaml.parse(fs.readFileSync(fx.abs(root, 'locations/LOC_FERRY_DECK/refs/prompts/gemini.plate.yaml'), 'utf8')).id,
      'PP_LOC_FERRY_DECK_GEMINI-PLATE');

    // The first look says on the console that it has no reference.
    const first = spawnSync(process.execPath, [SCRIPT, '--asset', 'LOOK_DAWN_WASH', '--sheet', 'look', '--root', root], { encoding: 'utf8' });
    assert.strictEqual(first.status, 0, first.stderr);
    assert.ok(/note: LOOK_DAWN_WASH has no approved master yet: this is its first look, compiled with no reference image\./.test(first.stdout), first.stdout);
    assert.ok(fs.existsSync(fx.abs(root, 'references/style/prompts/harness-native.LOOK_DAWN_WASH.yaml')));

    // Flags with a value in quotes, and the refusals.
    const detail = spawnSync(process.execPath,
      [SCRIPT, '--asset', 'PROP_FLARE_GUN', '--sheet', 'detail', '--subject', 'the lanyard ring', '--root', root], { encoding: 'utf8' });
    assert.strictEqual(detail.status, 0, detail.stderr);
    assert.ok(fs.readFileSync(fx.abs(root, 'props/PROP_FLARE_GUN/refs/prompts/harness-native.detail.lanyard-ring.yaml'), 'utf8').includes('the lanyard ring'));
    const bad = spawnSync(process.execPath, [SCRIPT, '--asset', 'CHAR_MARA', '--sheet', 'plate', '--root', root], { encoding: 'utf8' });
    assert.strictEqual(bad.status, 1);
    assert.ok(/a CHAR entity takes/.test(bad.stderr), bad.stderr);
    const both = spawnSync(process.execPath,
      [SCRIPT, '--asset', 'CHAR_MARA', '--sheet', 'turnaround', '--page', fx.pageFile(root, fx.PAGE_1), '--root', root], { encoding: 'utf8' });
    assert.strictEqual(both.status, 1);
    assert.ok(/--asset and --page cannot be combined/.test(both.stderr));
    const outside = spawnSync(process.execPath, [SCRIPT, '--asset', 'CHAR_MARA', '--sheet', 'turnaround'],
      { encoding: 'utf8', cwd: path.parse(root).root });
    assert.strictEqual(outside.status, 1);
    assert.ok(/--root <workspace>/.test(outside.stderr), outside.stderr);
  });
}

function testSafeMarginAndPanelNotes() {
  return fx.withWorkspace((root) => {
    writePlan(root, fx.PAGE_1);
    writePlan(root, fx.PAGE_2);
    const MARGIN = 'Safe margin: keep every balloon, caption, and sound effect at least 4% of the page width away from the left and right edges, ' +
      'and at least 3% of the page height away from the top and bottom edges.';

    // Safe margin: 6 mm on a 168 x 260 mm trim, as shares of the page, rounded up.
    const pkg = compile(root, fx.PAGE_2).pkg;
    const lettering = section(pkg.prompt, 'LETTERING').split('\n');
    assert.strictEqual(lettering[lettering.length - 1], MARGIN, 'the safe margin closes the lettering block');
    assert.strictEqual(pkg.prompt.split('Safe margin:').length - 1, 1);

    // Panel notes: a line in that panel's block, only when there is text.
    const panels = section(pkg.prompt, 'PANELS, in reading order');
    const block1 = panels.slice(panels.indexOf('Panel 1 of 4.'), panels.indexOf('Panel 2 of 4.'));
    const block2 = panels.slice(panels.indexOf('Panel 2 of 4.'), panels.indexOf('Panel 3 of 4.'));
    assert.ok(block1.includes('\nNote: Keep the ladder in frame so the change of level is drawn, not implied.\n'),
      'a panel note becomes a line of its block');
    assert.ok(block1.indexOf('Background:') < block1.indexOf('Note:') && block1.indexOf('Note:') < block1.indexOf('Characters drawn'));
    assert.ok(!block2.includes('Note:'), 'an empty note adds nothing');
    assert.strictEqual(pkg.prompt.split('\nNote: ').length - 1, 1, 'panels without notes get no line');
    assert.deepStrictEqual(compile(root, fx.PAGE_2).pkg, pkg, 'still deterministic');

    // The note travels with its panel into per-panel and repair prompts.
    assert.ok(compile(root, fx.PAGE_2, { panel: 'PN_001_002_01' }).pkg.prompt.includes('Note: Keep the ladder in frame'));
    const review = ws.loadReview(root, FLAGGED);
    review.findings[0].panel = 'PN_001_002_01';
    const repair = compile(root, fx.PAGE_2, { repairReview: review }).pkg.prompt;
    assert.ok(section(repair, 'PLANNED CONTENT OF THE CHANGED PANELS').includes('Note: Keep the ladder in frame'));
    // A panel image has no page edge, and a repair locks lettering: no margin line.
    assert.ok(!compile(root, fx.PAGE_2, { panel: 'PN_001_002_02' }).pkg.prompt.includes('Safe margin:'));
    assert.ok(!repair.includes('Safe margin:'));

    // A whitespace-only note is no note; a new note changes the page hash.
    fx.editYaml(root, `issues/ISS_001/pages/${fx.PAGE_2}/page.yaml`, (page) => { page.panels[1].notes = '   '; });
    assert.strictEqual(compile(root, fx.PAGE_2).pkg.prompt, pkg.prompt);
    fx.editYaml(root, `issues/ISS_001/pages/${fx.PAGE_2}/page.yaml`, (page) => { page.panels[1].notes = 'The gun never points at the boy'; });
    const noted = compile(root, fx.PAGE_2).pkg;
    assert.ok(noted.prompt.includes('\nNote: The gun never points at the boy.\n'));
    assert.notStrictEqual(noted.source_hashes.page, pkg.source_hashes.page);

    // No trim size: the distance alone. No safe margin: no line.
    fx.editYaml(root, 'project.yaml', (project) => { delete project.page.trim_mm; });
    assert.ok(section(compile(root, fx.PAGE_1).pkg.prompt, 'LETTERING')
      .endsWith('Safe margin: keep every balloon, caption, and sound effect clear of the page edges, inside a margin of 6 mm on the printed page.'));
    fx.editYaml(root, 'project.yaml', (project) => { delete project.page.safe_margin_mm; });
    assert.ok(!compile(root, fx.PAGE_1).pkg.prompt.includes('Safe margin:'));
    // Overlay lettering: nothing is lettered in the image, so no margin line.
    fx.editYaml(root, 'project.yaml', (project) => {
      project.page.safe_margin_mm = 6;
      project.lettering.mode = 'overlay';
    });
    assert.ok(!compile(root, fx.PAGE_1).pkg.prompt.includes('Safe margin:'));
  });
}

function testPlateTime() {
  return fx.withWorkspace((root) => {
    // The fixture location has two states: [night, dusk]. The first is the default.
    const night = compileAsset(root, 'LOC_FERRY_DECK', { sheet: 'plate' });
    assert.strictEqual(night.fileRel, 'locations/LOC_FERRY_DECK/refs/prompts/harness-native.plate.yaml');
    assert.strictEqual(night.pkg.id, 'PP_LOC_FERRY_DECK_HARNESS-NATIVE-PLATE');
    assert.ok(section(night.pkg.prompt, 'SHEET').includes('\nTime of day: night.\n'), 'the prompt states the time of day');
    assert.deepStrictEqual(compileAsset(root, 'LOC_FERRY_DECK', { sheet: 'plate', time: 'night' }), night,
      'naming the default state changes nothing');

    const dusk = compileAsset(root, 'LOC_FERRY_DECK', { sheet: 'plate', time: 'dusk' });
    assertSchemaValid(dusk.pkg);
    assert.strictEqual(dusk.fileRel, 'locations/LOC_FERRY_DECK/refs/prompts/harness-native.plate.dusk.yaml',
      'a non-default state is in the file name');
    assert.strictEqual(dusk.pkg.id, 'PP_LOC_FERRY_DECK_HARNESS-NATIVE-PLATE-DUSK');
    const brief = section(dusk.pkg.prompt, 'SHEET');
    assert.ok(brief.includes('\nTime of day: dusk.\n'));
    assert.ok(brief.includes("Lit by the location's own light sources as described below, at dusk."));
    assert.ok(!dusk.pkg.prompt.includes('Time of day: night.'));

    // The state must be one the location was designed for.
    const err = expectError(() => compileAsset(root, 'LOC_FERRY_DECK', { sheet: 'plate', time: 'dawn' }), 'time_unknown',
      /--time dawn is not one of the location's time_of_day_states \(night, dusk\)/);
    assert.ok(/location\.yaml/.test(err.message));
    expectError(() => compileAsset(root, 'CHAR_MARA', { sheet: 'turnaround', time: 'dusk' }), 'bad_arguments', /--time applies to --sheet plate only/);
    expectError(() => compileAsset(root, 'LOC_FERRY_DECK', { sheet: 'detail', subject: 'the ladder', time: 'dusk' }), 'bad_arguments');

    // CLI.
    const cli = spawnSync(process.execPath, [SCRIPT, '--asset', 'LOC_FERRY_DECK', '--sheet', 'plate', '--time', 'dusk', '--root', root], { encoding: 'utf8' });
    assert.strictEqual(cli.status, 0, cli.stderr);
    assert.deepStrictEqual(yaml.parse(fs.readFileSync(fx.abs(root, dusk.fileRel), 'utf8')), dusk.pkg);
    const bad = spawnSync(process.execPath, [SCRIPT, '--asset', 'LOC_FERRY_DECK', '--sheet', 'plate', '--time', 'noon', '--root', root], { encoding: 'utf8' });
    assert.strictEqual(bad.status, 1);
    assert.ok(/--time noon is not one of/.test(bad.stderr), bad.stderr);

    // A location with no states on file compiles a plate with no time, and refuses --time.
    fx.editYaml(root, 'locations/LOC_FERRY_DECK/location.yaml', (loc) => { delete loc.time_of_day_states; });
    const timeless = compileAsset(root, 'LOC_FERRY_DECK', { sheet: 'plate' });
    assert.ok(!timeless.pkg.prompt.includes('Time of day:'));
    assert.strictEqual(timeless.fileRel, night.fileRel);
    expectError(() => compileAsset(root, 'LOC_FERRY_DECK', { sheet: 'plate', time: 'night' }), 'time_unknown', /none on file/);
  });
}

async function main() {
  testLanguageHelpers();
  await testGeneratePackage();
  await testDeterminism();
  await testLetteringModes();
  await testRefusals();
  await testRepair();
  await testRepairCycleLimit();
  await testPerPanel();
  await testCli();
  await testSheets();
  await testSheetRefusalsAndDeterminism();
  await testSheetCli();
  await testSafeMarginAndPanelNotes();
  await testPlateTime();
  await testIdentityChain();
  await testFullSheet();
  console.log('compile-prompts: OK');
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
