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
const { compilePage, selectFindings } = require('../scripts/compile-prompts');
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
  console.log('compile-prompts: OK');
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
