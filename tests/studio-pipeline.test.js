'use strict';
/**
 * Studio: the whole fake pipeline through the HTTP API, the way the browser
 * drives it. Setup, style, look approval, characters, page plans, drawing
 * with a forced flagged page and its repair, corrections by both paths (an
 * edit, and a redraw once the repair limit is reached), cover, publishing in
 * every format, history and restore, chat.
 *
 * Fake mode: no CLI runs. What is checked is the plumbing and the files; a
 * placeholder image says nothing about artwork.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const png = require('../scripts/lib/png');
const ws = require('../scripts/lib/workspace');
const { validateWorkspace } = require('../scripts/validate-workspace');
const { checkContinuity } = require('../scripts/check-continuity');
const { start } = require('../studio/test-support/harness');

const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

function stepStates(job) {
  return job.steps.map((s) => `${s.id}:${s.status}`).join(' ');
}

function assertDone(job, label) {
  assert.strictEqual(job.status, 'done', `${label}: ${job.status} ${JSON.stringify(job.error)} [${stepStates(job)}]`);
}

async function main() {
  const started = Date.now();
  const s = await start();
  try {
    const tiny = png.encode({ width: 8, height: 8, data: Buffer.alloc(8 * 8 * 3, 120) });

    // --- health ------------------------------------------------------------------
    let r = await s.api('GET', '/api/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.fake, true);
    assert.deepStrictEqual(Object.keys(r.body.tools), ['claude', 'codex']);
    assert.strictEqual(r.body.tools.claude.installed, true);
    assert.strictEqual(typeof r.body.version, 'string');
    assert.strictEqual(r.body.git.installed, HAS_GIT);
    for (const f of ['pdf', 'cbz', 'epub', 'web', 'images']) assert.ok(r.body.formats.includes(f), `format ${f}`);

    // --- create a project from a description -----------------------------------------
    r = await s.api('POST', '/api/projects', {
      title: 'El último ferry',
      description: 'Una piloto de ferry encuentra a un polizón que la patrulla del puerto busca. Decide no entregarlo.',
      pages: 3,
      language: 'es',
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const id = r.body.project.id;
    assert.strictEqual(id, 'el-ultimo-ferry');
    const P = `/api/projects/${id}`;
    const root = path.join(s.home, id, 'production');
    assertDone(await s.waitJob(id, r.body.job.id), 'project.setup');
    assert.strictEqual(ws.loadProject(root).language, 'es');
    assert.strictEqual(ws.loadProject(root).default_providers.image, 'codex-cli');
    assert.strictEqual(fs.existsSync(path.join(s.home, id, '.git', 'HEAD')), HAS_GIT, 'the project has its own repository');

    r = await s.api('GET', '/api/projects');
    assert.deepStrictEqual(r.body.projects.map((p) => p.id), [id]);
    r = await s.api('GET', `${P}/story`);
    assert.strictEqual(r.body.written, true);
    assert.strictEqual(r.body.bible.schema, 'story-bible');
    assert.deepStrictEqual(r.body.bible.findings, []);
    assert.ok(r.body.bible.data.premise.includes('polizón'));
    assert.strictEqual(r.body.series_plan.data.issues[0].page_budget, 3);
    r = await s.api('GET', P);
    assert.strictEqual(r.body.screens.find((x) => x.key === 'story').status, 'done');
    assert.deepStrictEqual(r.body.next.screen, 'style');
    assert.deepStrictEqual(r.body.screens.map((x) => x.key),
      ['story', 'style', 'characters', 'places', 'pages', 'check', 'corrections', 'cover', 'publish']);

    // The repair limit of this project is one cycle, so the redraw path is reachable below.
    r = await s.api('PUT', `${P}/options`, { repair_limit: 1 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.options.repair_limit, 1);
    assert.strictEqual(ws.loadProject(root).repair_policy.max_cycles, 1);
    assert.ok(fs.readFileSync(path.join(root, 'project.yaml'), 'utf8').includes('# working title'), 'options keep the comments of project.yaml');

    // --- style: preset + words + an uploaded reference image ---------------------------
    r = await s.api('GET', `${P}/style`);
    assert.ok(r.body.presets.length >= 6);
    assert.ok(r.body.presets.every((p) => p.key && p.name && p.style_block && p.look_id.startsWith('LOOK_')));
    assert.strictEqual(r.body.look.id, null);
    const styleRef = await s.upload(id, 'referencia estilo.png', tiny, 'image/png');
    let job = await s.runOp(id, 'style.define', { preset: 'noir-ink', description: 'Tinta pesada, calles mojadas.', uploads: [styleRef.id] });
    assertDone(job, 'style.define');
    assert.strictEqual(job.result.look_id, 'LOOK_NOIR_INK');
    assert.deepStrictEqual(job.result.problems, []);
    assert.strictEqual(ws.loadProject(root).color_mode, 'monochrome', 'the preset sets the colour mode');
    const registered = ws.loadReferenceAssets(root).get('LOOK_NOIR_INK_REF_V01');
    assert.ok(registered && registered.status === 'approved' && registered.default_role === 'style' && registered.approved_by === 'person');

    // A sheet cannot be drawn before the look is approved: the steps are skipped, the files are written.
    job = await s.runOp(id, 'character.create', { name: 'Óscar', description: 'Un chico de doce años.' });
    assertDone(job, 'character.create before the look');
    assert.strictEqual(job.result.character, 'CHAR_OSCAR');
    assert.strictEqual(job.result.sheet.skipped, true);
    assert.ok(job.steps.filter((x) => x.id.startsWith('sheet-')).every((x) => x.status === 'skipped'));

    job = await s.runOp(id, 'style.look', {});
    assertDone(job, 'style.look');
    assert.strictEqual(job.result.candidate, 'references/style/LOOK_NOIR_INK_V01.png');
    assert.strictEqual(job.tools.draw, 'codex');
    r = await s.api('GET', `${P}/style`);
    assert.strictEqual(r.body.look.candidates.length, 1);
    assert.strictEqual(r.body.look.references.length, 1);
    assert.strictEqual(r.body.look.frozen, false);
    assert.ok(r.body.look.candidates[0].image.url.startsWith(`${P}/raw/references/style/`));
    assert.strictEqual(r.body.look.candidates[0].generation.provider, 'codex-cli');
    const lookPackage = r.body.look.packages[0];
    assert.ok(lookPackage.references.some((ref) => ref.asset_id === 'LOOK_NOIR_INK_REF_V01'), 'the uploaded image is attached to the look page');
    r = await s.raw('GET', r.body.look.candidates[0].image.url);
    assert.strictEqual(r.status, 200);
    assert.ok(png.isPng(r.buffer));

    // Look approval: promotes the candidate and freezes the style block.
    r = await s.api('POST', `${P}/approve/asset`, { candidate: 'LOOK_NOIR_INK_V01', note: 'Así.' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.asset_id, 'LOOK_NOIR_INK_MASTER_V01');
    assert.strictEqual(r.body.style_frozen, true);
    assert.deepStrictEqual(ws.loadProject(root).style.look_refs, ['LOOK_NOIR_INK_MASTER_V01']);
    r = await s.api('POST', `${P}/approve/asset`, { candidate: 'LOOK_NOIR_INK_V01' });
    assert.strictEqual(r.status, 409, 'approving the same candidate twice is refused');
    r = await s.api('PUT', `${P}/file`, { path: 'style/style-block.txt', text: 'Another style.\n' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error.code, 'style_frozen');
    r = await s.api('POST', `${P}/ops`, { op: 'style.define', params: { description: 'Otra cosa' } });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error.code, 'style_frozen');

    // --- characters: one from a photo, one from text ---------------------------------------
    const photo = await s.upload(id, 'mara.png', tiny, 'image/png');
    job = await s.runOp(id, 'character.create', { name: 'Mara', description: 'Piloto de ferry, cincuenta años.', uploads: [photo.id] });
    assertDone(job, 'character.create');
    assert.strictEqual(job.result.sheet.candidate_id, 'CHAR_MARA_TURN_V01');
    assert.strictEqual(job.result.references[0].id, 'CHAR_MARA_REF_V01');
    r = await s.api('POST', `${P}/ops`, { op: 'character.create', params: { name: 'Mara', description: 'x' } });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error.code, 'character_exists');
    job = await s.runOp(id, 'character.sheet', { character: 'CHAR_OSCAR', sheet: 'turnaround' });
    assertDone(job, 'character.sheet');
    for (const candidate of ['CHAR_MARA_TURN_V01', 'CHAR_OSCAR_TURN_V01']) {
      r = await s.api('POST', `${P}/approve/asset`, { candidate });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    }
    r = await s.api('GET', `${P}/characters`);
    assert.deepStrictEqual(r.body.characters.map((c) => [c.id, c.has_master]), [['CHAR_MARA', true], ['CHAR_OSCAR', true]]);
    r = await s.api('GET', `${P}/characters/CHAR_MARA`);
    assert.strictEqual(r.body.sheets.turnaround.master.id, 'CHAR_MARA_TURN_MASTER_V01');
    assert.strictEqual(r.body.assets.references.length, 1);
    assert.strictEqual(r.body.character.data.references.includes('CHAR_MARA_TURN_MASTER_V01'), true);
    job = await s.runOp(id, 'character.update', { character: 'CHAR_MARA', instruction: 'Tiene la nariz rota.' });
    assertDone(job, 'character.update');

    // --- pages: plan three, the second one forced to fail its first review ---------------------
    job = await s.runOp(id, 'pages.plan', {
      text: 'Mara cruza el río sola de noche. FLAG Oye moverse las cajas y baja a cubierta. NOTE Encuentra al chico y decide esconderlo.',
      pages: 3,
    });
    assertDone(job, 'pages.plan');
    assert.deepStrictEqual(job.result.pages.map((p) => p.id), ['PG_001_001', 'PG_001_002', 'PG_001_003']);
    assert.strictEqual(job.result.mechanical_errors, 0, JSON.stringify([job.result.continuity, job.result.validation.errors]));
    assert.ok(job.result.pages.every((p) => p.blockers.length === 0), JSON.stringify(job.result.pages));
    assert.ok(job.steps.find((x) => x.id === 'fix').status === 'skipped', 'no fix pass when the gates are clean');
    r = await s.api('GET', `${P}/entities`);
    assert.strictEqual(r.body.locations.length, 1);
    assert.strictEqual(r.body.locations[0].has_map, true);

    r = await s.api('GET', `${P}/pages/PG_001_002`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.plan.panels.length, 3);
    assert.ok(r.body.plan.text.includes('FLAG'));
    assert.ok(r.body.plan.panels[0].cast.some((c) => c.name === 'Mara'));
    assert.strictEqual(r.body.plan_approval.approved, false);
    assert.deepStrictEqual(r.body.findings.blockers, []);
    assert.deepStrictEqual(r.body.findings.schema, []);
    assert.deepStrictEqual(r.body.neighbors, { previous: 'PG_001_001', next: 'PG_001_003' });
    assert.strictEqual(r.body.chat_key, 'page:PG_001_002');

    // Drawing needs approved plans; an edit after approval makes the approval stale.
    r = await s.api('POST', `${P}/ops`, { op: 'pages.generate', params: { issue: 'ISS_001' } });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error.code, 'plan_not_approved');
    assert.deepStrictEqual(r.body.error.details.pages, ['PG_001_001', 'PG_001_002', 'PG_001_003']);
    r = await s.api('POST', `${P}/approve/plan`, { pages: ['PG_001_001', 'PG_001_002', 'PG_001_003'] });
    assert.strictEqual(r.status, 200);
    r = await s.api('GET', `${P}/file?path=issues/ISS_001/pages/PG_001_003/page.yaml`);
    const edited = r.body.file.text.replace('A closer view as the moment lands.', 'Mara cubre al chico con la lona.');
    assert.notStrictEqual(edited, r.body.file.text);
    r = await s.api('PUT', `${P}/file`, { path: 'issues/ISS_001/pages/PG_001_003/page.yaml', text: edited, base_etag: r.body.file.etag });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.findings, []);
    assert.deepStrictEqual(r.body.continuity.filter((f) => f.severity === 'error'), []);
    r = await s.api('POST', `${P}/ops`, { op: 'pages.generate', params: { issue: 'ISS_001' } });
    assert.strictEqual(r.status, 409, 'an edited plan needs approval again');
    assert.deepStrictEqual(r.body.error.details.pages, ['PG_001_003']);

    // --- draw: review, a flagged page, its automatic repair ------------------------------------------
    job = await s.runOp(id, 'pages.generate', { issue: 'ISS_001', approve_plans: true }, 60000);
    assertDone(job, 'pages.generate');
    assert.deepStrictEqual(job.result.pages.map((p) => [p.page, p.render, p.verdict, p.repairs]), [
      ['PG_001_001', 'PG_001_001_V01', 'pass', 0],
      ['PG_001_002', 'PG_001_002_V02', 'fixed', 1],
      ['PG_001_003', 'PG_001_003_V01', 'fixed', 0],
    ]);
    // Three outcomes: clean, repaired after a blocking finding, and passing with a minor note and no repair.
    assert.deepStrictEqual(job.result.pages.map((p) => [p.outcome, p.passes, p.open_findings]), [
      ['pass', true, 0], ['pass', true, 0], ['notes', true, 1],
    ]);
    assert.deepStrictEqual([job.result.passed, job.result.with_notes, job.result.flagged, job.result.failed], [3, 1, 0, 0]);
    assert.ok(!job.steps.some((x) => x.id.startsWith('PG_001_003:repair')), 'a minor finding triggers no repair');
    const noted = ws.loadReview(root, 'PG_001_003_V01');
    assert.deepStrictEqual([noted.verdict, noted.findings.length, noted.findings[0].severity, noted.findings[0].status],
      ['fixed', 1, 'minor', 'open'], 'a review whose only open finding is minor is fixed, with the note left open');
    assert.deepStrictEqual(noted.gates, { style_fidelity: 'pass', narrative_continuity: 'pass' });
    assert.strictEqual(ws.loadPage(root, 'PG_001_003').status, 'reviewed', 'a page with notes counts as reviewed');
    assert.deepStrictEqual(validateWorkspace(root).errors, [], 'validate-workspace.js accepts a fixed review with an open minor finding');
    assert.deepStrictEqual(job.result.tools, { draw: 'codex', look: 'claude' });
    assert.ok(job.steps.some((x) => x.id === 'PG_001_002:repair-1' && x.status === 'done'), stepStates(job));
    assert.ok(job.steps.some((x) => x.id === 'PG_001_002:review-1' && x.status === 'done'));
    const order = job.steps.map((x) => x.id);
    assert.ok(order.indexOf('PG_001_002:review-1') < order.indexOf('PG_001_003:prepare'), 'pages are drawn one at a time, in order');
    assert.ok(job.steps.filter((x) => x.status === 'done').every((x) => x.commit || !HAS_GIT), 'every step that wrote files has a commit');

    r = await s.api('GET', `${P}/pages/PG_001_002`);
    const p2 = r.body;
    assert.strictEqual(p2.status, 'reviewed');
    assert.strictEqual(p2.current_render, 'PG_001_002_V02');
    assert.deepStrictEqual(p2.renders.map((x) => [x.id, x.review.verdict, x.review.repair_cycle, x.review.independent]), [
      ['PG_001_002_V01', 'flagged', 0, true],
      ['PG_001_002_V02', 'fixed', 1, true],
    ]);
    const flagged = p2.renders[0].review;
    assert.strictEqual(flagged.findings.length, 1);
    assert.deepStrictEqual([flagged.findings[0].severity, flagged.findings[0].status, flagged.findings[0].check], ['blocking', 'open', 'identity']);
    assert.strictEqual(flagged.gates.narrative_continuity, 'fail');
    assert.strictEqual(flagged.checks.identity.result, 'fail');
    assert.ok(flagged.checks.identity.evidence.length > 0);
    const fixed = p2.renders[1].review;
    assert.strictEqual(fixed.supersedes, 'PG_001_002_V01');
    assert.deepStrictEqual([fixed.findings[0].status, fixed.findings[0].recheck.render], ['fixed', 'PG_001_002_V02']);
    // The project's interface language is Spanish, so the words the studio adds to a review file are Spanish.
    assert.ok(/Lectura automática hecha por Claude Code/.test(fixed.notes), 'a review says it is an automated reading');
    assert.strictEqual(p2.renders[0].generation.status, 'rejected', 'the replaced render\'s record is marked rejected');
    assert.strictEqual(p2.renders[1].generation.status, 'succeeded');
    const [v1, v2] = await Promise.all(p2.renders.map((x) => s.raw('GET', x.image.url)));
    assert.ok(png.isPng(v1.buffer) && png.isPng(v2.buffer));
    assert.ok(!v1.buffer.equals(v2.buffer), 'two versions of a page are visibly different images');
    assert.strictEqual(p2.renders[1].image.width / p2.renders[1].image.height, 2 / 3);
    // The repaired page 2 fed nothing forward by accident: page 3 attached the reviewed render of page 2.
    assert.ok(p2.reference_plan.entries.some((e) => e.asset_id === 'PG_001_001_V01' && e.role === 'spatial_continuity'),
      'the previous page\'s reviewed render is a reference of the next page');
    r = await s.api('GET', `${P}/pages/PG_001_003`);
    assert.ok(r.body.reference_plan.entries.some((e) => e.asset_id === 'PG_001_002_V02'), 'page 3 follows the repaired render of page 2');
    // Where each panel sits, as the plan says it: tier and place in the tier. The plan has no measured rectangles, so there is no rect.
    assert.deepStrictEqual(r.body.plan.tiers, [1, 2]);
    assert.deepStrictEqual(r.body.plan.panels.map((p) => [p.slot.tier, p.slot.tiers, p.slot.slot, p.slot.of]), [[1, 2, 1, 1], [2, 2, 1, 2], [2, 2, 2, 2]]);
    assert.ok(r.body.plan.panels.every((p) => p.rect === undefined));
    assert.deepStrictEqual([r.body.plan.text_code, r.body.plan.text.split('\n')[0].startsWith('Página 3: ')], ['plan.text', true]);
    assert.ok(r.body.prompts[0].references.every((ref) => ref.image && ref.image.url));
    assert.strictEqual(r.body.prompts[0].provider, 'codex-cli');

    r = await s.api('GET', `${P}/issues/ISS_001`);
    assert.deepStrictEqual(r.body.counts, { pages: 3, planned_budget: 3, plan_approved: 3, rendered: 3, passed: 3, with_notes: 1, flagged: 0 });
    assert.deepStrictEqual(r.body.pages.map((p) => p.outcome), ['pass', 'pass', 'notes']);
    assert.strictEqual(r.body.mechanical.errors, 0);
    assert.ok(r.body.pages.every((p) => p.image && p.image.url && p.verdict));

    // --- a review by the tool that drew the page is recorded as not independent -------------------
    r = await s.api('PUT', `${P}/settings`, { drivers: { look: 'codex' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.tools.look.tool, 'codex');
    job = await s.runOp(id, 'page.review', { page: 'PG_001_003' });
    assertDone(job, 'page.review');
    assert.strictEqual(job.result.independent, false);
    assert.strictEqual(ws.loadReview(root, 'PG_001_003_V01').independent, false);
    assert.ok(/No es independiente/.test(ws.loadReview(root, 'PG_001_003_V01').notes));
    r = await s.api('PUT', `${P}/settings`, { drivers: { look: 'claude' } });
    job = await s.runOp(id, 'page.review', { render: 'PG_001_003_V01' });
    assert.strictEqual(job.result.independent, true);
    r = await s.api('PUT', `${P}/settings`, { drivers: { look: 'gemini' } });
    assert.strictEqual(r.status, 400);

    // --- corrections, path one: edit the existing page ------------------------------------------------
    r = await s.api('POST', `${P}/ops`, { op: 'page.correct', params: { page: 'PG_001_001', text: 'x', region: { x: 0.9, y: 0, w: 0.5, h: 0.5 } } });
    assert.strictEqual(r.status, 400, 'a region outside the page is refused');
    job = await s.runOp(id, 'page.correct', {
      page: 'PG_001_001', text: 'La lámpara tiene que verse encendida.', panel: 'PN_001_001_02', region: { x: 0.1, y: 0.5, w: 0.3, h: 0.2 },
    });
    assertDone(job, 'page.correct (edit)');
    assert.strictEqual(job.result.path, 'edit');
    assert.deepStrictEqual([job.result.path_label_code, job.result.path_label], ['path.edit', 'Se editó la imagen que ya existía.']);
    assert.deepStrictEqual(job.steps.map((x) => x.id), ['request', 'compile', 'draw', 'review']);
    assert.deepStrictEqual([job.steps[2].label_code, job.steps[2].label], ['step.correct.draw.edit.page', 'Editar la página que ya existe']);
    assert.deepStrictEqual([job.result.from, job.result.render, job.result.verdict], ['PG_001_001_V01', 'PG_001_001_V02', 'fixed']);
    const requested = ws.loadReview(root, 'PG_001_001_V01');
    const request = requested.findings.find((f) => f.source === 'user_request');
    assert.deepStrictEqual(request.region, { x: 0.1, y: 0.5, w: 0.3, h: 0.2 });
    assert.strictEqual(request.panel, 'PN_001_001_02');
    assert.strictEqual(request.repair, 'La lámpara tiene que verse encendida.');
    assert.strictEqual(requested.verdict, 'flagged');
    const corrected = ws.loadReview(root, 'PG_001_001_V02');
    assert.deepStrictEqual([corrected.repair_cycle, corrected.supersedes, corrected.verdict], [1, 'PG_001_001_V01', 'fixed']);
    assert.strictEqual(corrected.findings.find((f) => f.source === 'user_request').status, 'fixed');
    const repairPackage = ws.loadYaml(path.join(ws.pageDir(root, 'PG_001_001'), 'prompts', 'codex-cli.yaml'));
    assert.strictEqual(repairPackage.mode, 'repair');
    assert.ok(repairPackage.prompt.includes('La lámpara tiene que verse encendida'));

    // --- corrections, path two: the repair limit is reached, so the plan changes and the page is redrawn
    assert.strictEqual(ws.loadReview(root, 'PG_001_002_V02').repair_cycle, 1);
    const planBefore = fs.readFileSync(path.join(ws.pageDir(root, 'PG_001_002'), 'page.yaml'), 'utf8');
    job = await s.runOp(id, 'page.correct', { page: 'PG_001_002', text: 'El chico tiene que llevar la capucha puesta.' });
    assertDone(job, 'page.correct (redraw)');
    assert.strictEqual(job.result.path, 'redraw');
    assert.deepStrictEqual([job.result.path_label_code, job.result.path_label], ['path.redraw', 'Se dibujó otra vez con el plan cambiado.']);
    assert.deepStrictEqual(job.steps.map((x) => x.id), ['request', 'plan', 'compile', 'draw', 'review']);
    assert.strictEqual(job.steps[1].label_code, 'step.correct.plan.page');
    assert.ok(/^Límite de arreglos alcanzado/.test(job.steps[1].label));
    assert.strictEqual(job.steps[3].label_code, 'step.correct.draw.redraw.page');
    assert.deepStrictEqual([job.result.from, job.result.render], ['PG_001_002_V02', 'PG_001_002_V03']);
    assert.strictEqual(job.result.passes, true);
    const redrawn = ws.loadReview(root, 'PG_001_002_V03');
    assert.deepStrictEqual([redrawn.repair_cycle, redrawn.supersedes], [0, null], 'a redraw starts a new lineage');
    assert.ok(/PG_001_002_V02 había llegado al límite de arreglos/.test(redrawn.notes));
    const carried = redrawn.findings.find((f) => f.source === 'user_request');
    assert.deepStrictEqual([carried.status, carried.recheck.render], ['fixed', 'PG_001_002_V03'], 'the requested change is checked in the new drawing');
    const planAfter = fs.readFileSync(path.join(ws.pageDir(root, 'PG_001_002'), 'page.yaml'), 'utf8');
    assert.notStrictEqual(planAfter, planBefore, 'the request went into the plan');
    assert.ok(planAfter.includes('capucha'));
    assert.strictEqual(ws.loadYaml(path.join(ws.pageDir(root, 'PG_001_002'), 'prompts', 'codex-cli.yaml')).mode, 'generate',
      'the redraw is a fresh generate package, not a repair');
    assert.strictEqual(ws.loadProject(root).repair_policy.max_cycles, 1, 'the limit was not raised');
    assert.strictEqual(ws.loadPage(root, 'PG_001_002').current_render, 'PG_001_002_V03');
    // The same request by the edit path would have been refused by the scaffold.
    r = await s.api('GET', `${P}/pages/PG_001_002`);
    assert.strictEqual(r.body.renders.length, 3);
    assert.strictEqual(r.body.repair_limit, 1);

    // --- approving a page -----------------------------------------------------------------------------------
    // A page that passed with a note: the note is in the API as an open minor finding, and approving the page accepts it.
    r = await s.api('GET', `${P}/pages/PG_001_003`);
    assert.deepStrictEqual([r.body.renders[0].review.outcome, r.body.renders[0].review.verdict, r.body.renders[0].review.open_findings, r.body.renders[0].review.open_blocking],
      ['notes', 'fixed', 1, 0]);
    r = await s.api('GET', P);
    assert.strictEqual(r.body.screens.find((x) => x.key === 'check').counts.with_notes, 1);
    r = await s.api('POST', `${P}/approve/page`, { page: 'PG_001_003' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.overruled, r.body.accepted_notes], [false, ['F01']], 'no overrule is needed for a page with notes');
    assert.strictEqual(ws.loadReview(root, 'PG_001_003_V01').findings[0].status, 'accepted');
    r = await s.api('GET', `${P}/pages/PG_001_003`);
    assert.strictEqual(r.body.renders[0].review.outcome, 'pass');
    r = await s.api('POST', `${P}/approve/page`, { page: 'PG_001_001' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.render, r.body.status, r.body.overruled], ['PG_001_001_V02', 'approved', false]);
    assert.strictEqual(ws.loadPage(root, 'PG_001_001').status, 'approved');
    assert.strictEqual(ws.loadReview(root, 'PG_001_001_V02').human_approval.status, 'approved');

    // --- cover: create, approve, correct ----------------------------------------------------------------------
    job = await s.runOp(id, 'cover.create', { description: 'Mara al timón, de noche, con el río detrás.' });
    assertDone(job, 'cover.create');
    assert.deepStrictEqual([job.result.render, job.result.verdict], ['CV_001_V01', 'pass']);
    const coverReview = ws.loadReview(root, 'CV_001_V01');
    assert.strictEqual(coverReview.page, 'CV_001');
    assert.strictEqual(coverReview.checks.position.result, 'not_applicable');
    r = await s.api('POST', `${P}/approve/cover`, { issue: 'ISS_001' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(ws.loadCover(root, 'ISS_001').approved_render, 'CV_001_V01');
    job = await s.runOp(id, 'cover.correct', { issue: 'ISS_001', text: 'El título más grande.', lettering: true });
    assertDone(job, 'cover.correct');
    assert.deepStrictEqual([job.result.path, job.result.render, job.result.verdict], ['edit', 'CV_001_V02', 'fixed']);
    assert.strictEqual(ws.loadCover(root, 'ISS_001').status, 'draft', 'a change request withdraws the approval of the cover');
    r = await s.api('POST', `${P}/approve/cover`, { issue: 'ISS_001', render: 'CV_001_V02' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await s.api('GET', `${P}/issues/ISS_001/cover`);
    assert.deepStrictEqual([r.body.status, r.body.approved_render, r.body.renders.length], ['approved', 'CV_001_V02', 2]);
    assert.ok(r.body.image.url);

    // --- the mechanical gates accept everything the fake wrote -----------------------------------------------------
    const validation = validateWorkspace(root);
    assert.deepStrictEqual(validation.errors, [], JSON.stringify(validation.errors.slice(0, 5), null, 1));
    assert.deepStrictEqual(checkContinuity(root).findings.filter((f) => f.severity === 'error'), []);

    // --- publish: every format, final because every page passed --------------------------------------------------------
    r = await s.api('GET', `${P}/issues/ISS_001/publish`);
    assert.strictEqual(r.body.readiness.final_possible, true, JSON.stringify(r.body.readiness.blockers));
    assert.strictEqual(r.body.next_edition.cover.render, 'CV_001_V02');
    job = await s.runOp(id, 'publish.build', { issue: 'ISS_001', formats: ['pdf', 'cbz', 'epub', 'web', 'images'], mode: 'final' });
    assertDone(job, 'publish.build');
    assert.strictEqual(job.result.draft, false);
    assert.strictEqual(job.result.edition, 'ED_001_01');
    assert.deepStrictEqual(job.result.written.map((w) => w.format).sort(), ['cbz', 'epub', 'images', 'pdf', 'web']);
    assert.deepStrictEqual(job.result.shipped.map((x) => x.render), ['CV_001_V02', 'PG_001_001_V02', 'PG_001_002_V03', 'PG_001_003_V01']);
    r = await s.api('GET', `${P}/issues/ISS_001/publish`);
    const edition = r.body.editions[0];
    assert.strictEqual(edition.status, 'reviewed');
    assert.strictEqual(edition.exports.length, 5);
    const magic = { pdf: '%PDF', cbz: 'PK', epub: 'PK', images: 'PK' };
    for (const exported of edition.exports) {
      assert.strictEqual(exported.exists, true, exported.file);
      assert.strictEqual(exported.draft, false);
      if (exported.format === 'web') {
        assert.strictEqual(exported.browsable, true);
        const page = await s.raw('GET', exported.url);
        assert.strictEqual(page.status, 200);
        assert.ok(/text\/html/.test(page.headers.get('content-type')));
        assert.ok(/sandbox/.test(page.headers.get('content-security-policy')), 'workspace HTML is served sandboxed');
        const src = /<img[^>]+src="([^"]+)"/.exec(page.buffer.toString('utf8'))[1];
        const image = await s.raw('GET', new URL(src, `${s.url}${exported.url}`).pathname);
        assert.strictEqual(image.status, 200, 'the web reader\'s relative images resolve through the raw endpoint');
        assert.ok(png.isPng(image.buffer));
      } else {
        const file = await s.raw('GET', exported.download_url);
        assert.strictEqual(file.status, 200);
        assert.ok(file.buffer.toString('latin1').startsWith(magic[exported.format]), `${exported.format} has the wrong signature`);
        assert.ok(/attachment/.test(file.headers.get('content-disposition')));
      }
    }
    // Building again changes nothing: the same edition, nothing overwritten.
    job = await s.runOp(id, 'publish.build', { issue: 'ISS_001', formats: ['pdf', 'cbz'] });
    assertDone(job, 'publish.build again');
    assert.deepStrictEqual([job.result.edition, job.result.reused, job.result.written.length, job.result.skipped.length], ['ED_001_01', true, 0, 2]);

    // --- chat: a reply that edits the screen's file ---------------------------------------------------------------------
    r = await s.api('POST', `${P}/chats/page:PG_001_003`, { text: 'EDIT acerca el último plano' });
    assert.strictEqual(r.status, 202);
    assert.strictEqual(r.body.message.role, 'user');
    assertDone(await s.waitJob(id, r.body.job.id), 'chat.turn');
    r = await s.api('GET', `${P}/chats/page:PG_001_003`);
    assert.deepStrictEqual(r.body.messages.map((m) => m.role), ['user', 'assistant']);
    const answer = r.body.messages[1];
    assert.deepStrictEqual(answer.files, ['issues/ISS_001/pages/PG_001_003/page.yaml']);
    assert.strictEqual(typeof answer.text, 'string');
    assert.strictEqual(!!answer.commit, HAS_GIT);
    assert.strictEqual(answer.tool, 'claude');
    assert.ok(ws.loadPage(root, 'PG_001_003').notes.includes('acerca'));
    r = await s.api('POST', `${P}/chats/page:PG_001_003`, { text: 'Gracias' });
    assertDone(await s.waitJob(id, r.body.job.id), 'chat.turn 2');
    r = await s.api('GET', `${P}/chats/page:PG_001_003`);
    assert.strictEqual(r.body.messages.length, 4);
    assert.deepStrictEqual(r.body.messages[3].files, [], 'a question changes no file');
    r = await s.api('POST', `${P}/chats/nonsense`, { text: 'x' });
    assert.strictEqual(r.status, 400);
    r = await s.api('POST', `${P}/chats/character:CHAR_NOBODY`, { text: 'x' });
    assert.strictEqual(r.status, 404);
    r = await s.api('GET', `${P}/chats`);
    assert.deepStrictEqual(r.body.chats.map((c) => [c.key, c.messages]), [['page:PG_001_003', 4]]);

    // --- history and restore -----------------------------------------------------------------------------------------------
    r = await s.api('GET', `${P}/history?limit=500`);
    const entries = r.body.entries;
    assert.strictEqual(r.body.total, entries.length);
    assert.ok(entries.length > 40, `only ${entries.length} history entries`);
    assert.ok(entries[0].at >= entries[entries.length - 1].at, 'newest first');
    const actors = new Set(entries.map((e) => e.actor));
    for (const actor of ['person', 'claude', 'codex', 'studio']) assert.ok(actors.has(actor), `no history entry by ${actor}`);
    const drew = entries.find((e) => e.step === 'PG_001_002:draw');
    assert.deepStrictEqual(drew.images.map((i) => i.path), ['issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V01.png']);
    assert.ok(drew.images[0].url, 'history entries carry the images they made');
    assert.strictEqual(r.body.restore.available, HAS_GIT);
    const paged = await s.api('GET', `${P}/history?limit=5&before=${entries[4].id}`);
    assert.deepStrictEqual(paged.body.entries.map((e) => e.id), entries.slice(5, 10).map((e) => e.id));

    if (HAS_GIT) {
      assert.ok(entries.filter((e) => e.files.length).every((e) => e.commit && e.restorable), 'every entry that changed files links to a commit');
      // Back to just before the first publish: the edition leaves the working tree and stays in git.
      const beforePublish = entries.find((e) => e.kind === 'approval' && e.title_code === 'activity.approved_cover');
      const exportFile = path.join(root, edition.exports.find((e) => e.format === 'pdf').file);
      assert.ok(fs.existsSync(exportFile));
      r = await s.api('POST', `${P}/history/restore`, { entry: beforePublish.id });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.restored, beforePublish.commit);
      assert.ok(r.body.commit && r.body.commit !== beforePublish.commit, 'a restore is a new commit');
      assert.ok(!fs.existsSync(exportFile), 'files added after that point leave the working tree');
      assert.ok(!fs.existsSync(path.join(root, 'editions', 'ED_001_01', 'edition.yaml')));
      assert.ok(!ws.loadPage(root, 'PG_001_003').notes, 'the chat edit is undone');
      assert.strictEqual(ws.loadCover(root, 'ISS_001').approved_render, 'CV_001_V02', 'what existed at that point is back');
      const after = await s.api('GET', `${P}/history?limit=500`);
      assert.strictEqual(after.body.total, entries.length + 1, 'the activity log keeps every entry and gains the restore');
      assert.strictEqual(after.body.entries[0].kind, 'restore');
      assert.ok(after.body.entries.find((e) => e.id === entries[0].id).restorable, 'later states are still in the history');
      // Forward again: nothing was lost.
      r = await s.api('POST', `${P}/history/restore`, { commit: entries[0].commit });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.ok(fs.existsSync(exportFile), 'the later state comes back from the history');
      assert.ok(ws.loadPage(root, 'PG_001_003').notes.includes('acerca'));
      r = await s.api('POST', `${P}/history/restore`, { commit: 'ffffffffffffffffffffffffffffffffffffffff' });
      assert.strictEqual(r.status, 404);
      r = await s.api('POST', `${P}/history/restore`, { commit: 'HEAD~1; rm -rf' });
      assert.strictEqual(r.status, 404);
      // The project's commits carry the studio's identity and never touch a repository above it.
      const log = spawnSync('git', ['--git-dir', path.join(s.home, id, '.git'), 'log', '-n', '1', '--format=%an <%ae>'], { encoding: 'utf8' });
      assert.strictEqual(log.stdout.trim(), 'Comics Studio <studio@localhost>');
      const status = spawnSync('git', ['--git-dir', path.join(s.home, id, '.git'), '--work-tree', path.join(s.home, id), 'status', '--porcelain'], { encoding: 'utf8' });
      assert.strictEqual(status.stdout.trim(), '', 'nothing is left uncommitted');
    } else {
      console.log('studio-pipeline: git is not installed, restore checks skipped');
      r = await s.api('POST', `${P}/history/restore`, { entry: entries[0].id });
      assert.strictEqual(r.status, 409);
    }

    // --- the overview at the end -----------------------------------------------------------------------------------------------
    r = await s.api('GET', P);
    const states = Object.fromEntries(r.body.screens.map((x) => [x.key, x.status]));
    assert.deepStrictEqual(states, {
      story: 'done', style: 'done', characters: 'done', places: 'optional', pages: 'done', check: 'done',
      corrections: 'optional', cover: 'optional', publish: 'done',
    });
    assert.strictEqual(r.body.next, null);
    assert.deepStrictEqual(r.body.active_jobs, []);

    // --- delete moves the project to the trash -------------------------------------------------------------------------------------
    r = await s.api('DELETE', P);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(/^\.trash\/el-ultimo-ferry-\d{14}$/.test(r.body.trash));
    assert.ok(fs.existsSync(path.join(s.home, r.body.trash, 'production', 'project.yaml')), 'the project is in the trash, intact');
    assert.ok(!fs.existsSync(path.join(s.home, id)));
    r = await s.api('GET', '/api/projects');
    assert.deepStrictEqual(r.body.projects, []);
    r = await s.api('GET', P);
    assert.strictEqual(r.status, 404);
  } finally {
    await s.close();
  }
  console.log(`studio-pipeline: ok (${Date.now() - started} ms)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
