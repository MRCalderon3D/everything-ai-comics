'use strict';
/**
 * Studio: projects, text artifacts (read, save, validation on save),
 * schemas, settings and options, the manual handoff when no drawing tool is
 * installed, tool fallback, and overlay lettering. Fake mode, temporary home.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const png = require('../scripts/lib/png');
const ws = require('../scripts/lib/workspace');
const { validateWorkspace } = require('../scripts/validate-workspace');
const { start } = require('../studio/test-support/harness');
const { placeholder } = require('../studio/server/fake/images');

function assertDone(job, label) {
  assert.strictEqual(job.status, 'done', `${label}: ${job.status} ${JSON.stringify(job.error)} [${job.steps.map((s) => `${s.id}:${s.status}`).join(' ')}]`);
  return job;
}

async function projectsAndFiles() {
  const s = await start();
  try {
    // --- projects: create, list, validation ----------------------------------------
    let r = await s.api('POST', '/api/projects', { description: 'no title' });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(Object.keys(r.body.error), ['code', 'message'], 'the error format is { error: { code, message } }');
    assert.strictEqual(r.body.error.code, 'bad_params');
    r = await s.api('POST', '/api/projects', { title: 'x', format: 'film' });
    assert.strictEqual(r.status, 400);
    r = await s.api('POST', '/api/projects', { title: 'x', pages: 0 });
    assert.strictEqual(r.status, 400);
    r = await s.api('POST', '/api/projects', { title: 'x', options: { colour: 'red' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error.code, 'bad_options');
    assert.deepStrictEqual(fs.readdirSync(s.home), [], 'a refused request creates nothing');

    r = await s.api('POST', '/api/projects', { title: 'Tira vertical', format: 'webtoon', setup: false, language: 'es', options: { color_mode: 'limited', reading_direction: 'ltr' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const webtoon = r.body.project.id;
    assert.strictEqual(webtoon, 'tira-vertical');
    assert.strictEqual(r.body.project.comic_format, 'webtoon');
    let doc = ws.loadProject(path.join(s.home, webtoon, 'production'));
    assert.deepStrictEqual([doc.comic_format, doc.page.aspect_ratio, doc.language, doc.color_mode], ['webtoon', '9:16', 'es', 'limited']);
    r = await s.api('GET', `/api/projects/${webtoon}/settings`);
    assert.strictEqual(r.body.settings.language, 'es', 'the interface language follows the project language when it is one the interface has');

    r = await s.api('POST', '/api/projects', { title: 'Files Test', setup: false });
    const id = r.body.project.id;
    r = await s.api('POST', '/api/projects', { title: 'Files Test', setup: false });
    assert.strictEqual(r.body.project.id, 'files-test-2', 'a second project with the same title gets its own folder');
    r = await s.api('GET', '/api/projects');
    assert.deepStrictEqual(r.body.projects.map((p) => p.id).sort(), ['files-test', 'files-test-2', 'tira-vertical']);
    assert.strictEqual(r.body.home, s.home);
    // Only directories that hold production/project.yaml are projects.
    fs.mkdirSync(path.join(s.home, 'not-a-project'));
    r = await s.api('GET', '/api/projects');
    assert.strictEqual(r.body.projects.length, 3);
    const P = `/api/projects/${id}`;
    const root = path.join(s.home, id, 'production');

    // --- text artifacts ------------------------------------------------------------------
    r = await s.api('GET', `${P}/file?path=story/story-bible.yaml`);
    assert.strictEqual(r.status, 200);
    let file = r.body.file;
    assert.deepStrictEqual([file.exists, file.kind, file.schema], [true, 'yaml', 'story-bible']);
    assert.strictEqual(typeof file.text, 'string');
    assert.strictEqual(file.data.title, 'Files Test');
    assert.ok(Array.isArray(file.findings));
    assert.ok(file.etag && file.mtime);
    r = await s.api('GET', `${P}/file?path=story/nothing-here.yaml`);
    assert.deepStrictEqual([r.status, r.body.file.exists, r.body.file.text], [200, false, ''], 'a missing file reads as an empty state');
    r = await s.api('GET', `${P}/file`);
    assert.strictEqual(r.status, 400);

    // YAML that does not parse is rejected with the line, and nothing is written.
    const before = fs.readFileSync(path.join(root, 'story', 'story-bible.yaml'), 'utf8');
    r = await s.api('PUT', `${P}/file`, { path: 'story/story-bible.yaml', text: 'title: ok\npremise: "unclosed\nfacts: []\n' });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.error.code, 'yaml_parse');
    assert.strictEqual(r.body.error.details.line, 2);
    assert.ok(/line 2/.test(r.body.error.message));
    assert.strictEqual(fs.readFileSync(path.join(root, 'story', 'story-bible.yaml'), 'utf8'), before);
    r = await s.api('PUT', `${P}/file`, { path: 'story/story-bible.yaml', text: '# only a comment\n' });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.error.code, 'yaml_empty');

    // YAML that parses and breaks the schema is saved, and the findings come back.
    r = await s.api('PUT', `${P}/file`, {
      path: 'story/story-bible.yaml', base_etag: file.etag,
      text: 'title: Files Test\nfacts:\n  - id: FACT_1\n    statement: Short id.\n    provenance: rumour\ncharacters: []\n',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.saved, true);
    const messages = r.body.findings.map((f) => `${f.path} ${f.message}`).join('\n');
    assert.ok(/premise/.test(messages), messages);
    assert.ok(/provenance|rumour/.test(messages), messages);
    assert.ok(r.body.findings.every((f) => typeof f.path === 'string' && typeof f.message === 'string'));
    assert.strictEqual(r.body.file.data.facts[0].provenance, 'rumour');
    assert.ok(r.body.commit === null || /^[0-9a-f]{40}$/.test(r.body.commit));
    // A save against a version that is no longer current is refused.
    r = await s.api('PUT', `${P}/file`, { path: 'story/story-bible.yaml', base_etag: file.etag, text: 'title: x\n' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error.code, 'file_changed');
    // Saving parsed data keeps the comment block at the top of the file.
    r = await s.api('GET', `${P}/file?path=story/series-plan.yaml`);
    assert.ok(r.body.file.text.startsWith('#'));
    const plan = r.body.file.data;
    plan.issues = [{ id: 'ISS_001', number: 1, title: 'One', page_budget: 5, status: 'planning' }];
    r = await s.api('PUT', `${P}/file`, { path: 'story/series-plan.yaml', data: plan });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.findings, []);
    assert.ok(r.body.file.text.startsWith('#'), 'the header comments survive a data save');
    assert.strictEqual(ws.loadYaml(path.join(root, 'story', 'series-plan.yaml')).issues[0].page_budget, 5);
    // Markdown and new files.
    r = await s.api('PUT', `${P}/file`, { path: 'style/style-bible.md', text: '# Style\n\nThick line.' });
    assert.deepStrictEqual([r.status, r.body.created, r.body.file.kind], [200, false, 'markdown']);
    r = await s.api('PUT', `${P}/file`, { path: 'references/docs/notes.md', text: 'Notes.\n' });
    assert.deepStrictEqual([r.status, r.body.created], [200, true]);
    r = await s.api('PUT', `${P}/file`, { path: 'issues/ISS_001/pages/PG_001_001/renders/x.yaml', text: 'a: 1\n' });
    assert.strictEqual(r.status, 400, 'renders are written by the pipeline only');
    r = await s.api('PUT', `${P}/file`, { path: 'story/x.yaml' });
    assert.strictEqual(r.status, 400);
    r = await s.api('GET', `${P}/history`);
    assert.ok(r.body.entries.some((e) => e.kind === 'save' && e.title === 'Edited story/story-bible.yaml' && e.actor === 'person'));

    // --- schemas and the operation catalog --------------------------------------------------
    r = await s.api('GET', '/api/schemas');
    for (const name of ['project', 'page', 'character', 'visual-review', 'edition', 'cover']) assert.ok(r.body.schemas.includes(name), name);
    r = await s.api('GET', '/api/schemas/page');
    assert.strictEqual(r.body.schema.type, 'object');
    assert.ok(r.body.schema.properties.panels);
    r = await s.api('GET', '/api/schemas/nope');
    assert.strictEqual(r.status, 404);
    r = await s.api('GET', '/api/schemas/..%2F..%2Fpackage');
    assert.strictEqual(r.status, 404);
    r = await s.api('GET', '/api/ops');
    assert.deepStrictEqual(r.body.operations.map((o) => o.name), [
      'project.setup', 'story.update', 'style.define', 'style.look', 'character.create', 'character.update',
      'character.sheet', 'entities.derive', 'pages.plan', 'pages.generate', 'page.review', 'page.correct',
      'page.manual', 'cover.create', 'cover.correct', 'lettering.apply', 'publish.build', 'chat.turn',
    ]);
    assert.ok(r.body.operations.every((o) => o.title && o.summary && Array.isArray(o.params)));

    // --- settings and options ------------------------------------------------------------------
    r = await s.api('GET', `${P}/settings`);
    assert.deepStrictEqual(r.body.settings.drivers, { plan: 'claude', look: 'claude', draw: 'codex' });
    assert.strictEqual(r.body.settings.repair_limit, null);
    for (const bad of [{ language: 'fr' }, { drivers: { plan: 'gpt' } }, { drivers: { draw: 'claude' } }, { models: { claude: { plan: 'x; rm -rf' } } },
      { repair_limit: -1 }, { models: { nope: {} } }]) {
      r = await s.api('PUT', `${P}/settings`, bad);
      assert.strictEqual(r.status, 400, JSON.stringify(bad));
      assert.strictEqual(r.body.error.code, 'bad_settings');
    }
    r = await s.api('PUT', `${P}/settings`, { language: 'es', drivers: { plan: 'codex' }, models: { claude: { look: 'haiku' } }, repair_limit: 1 });
    assert.strictEqual(r.status, 200);
    r = await s.api('GET', `${P}/settings`);
    assert.deepStrictEqual([r.body.settings.language, r.body.settings.drivers.plan, r.body.settings.drivers.look, r.body.settings.models.claude.look, r.body.settings.repair_limit],
      ['es', 'codex', 'claude', 'haiku', 1]);
    assert.strictEqual(r.body.tools.plan.tool, 'codex');
    r = await s.api('GET', `${P}/options`);
    assert.deepStrictEqual([r.body.options.comic_format, r.body.options.page_size, r.body.options.repair_limit], ['paged', 'comic-2-3', 2]);
    assert.ok(r.body.choices.page_size.length >= 3);
    r = await s.api('PUT', `${P}/options`, { page_size: 'square', color_mode: 'monochrome', lettering_mode: 'overlay', reading_direction: 'rtl', title: 'Renamed' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    doc = ws.loadProject(root);
    assert.deepStrictEqual([doc.page.aspect_ratio, doc.page.width_px, doc.color_mode, doc.lettering.mode, doc.reading_direction, doc.title],
      ['1:1', 2048, 'monochrome', 'overlay', 'rtl', 'Renamed']);
    assert.deepStrictEqual(r.body.findings, [], 'the saved options still follow the project schema');
    r = await s.api('PUT', `${P}/options`, { color_mode: 'sepia' });
    assert.strictEqual(r.status, 400);
    r = await s.api('PUT', `${P}/options`, { default_providers: { image: 'fal' } });
    assert.strictEqual(r.status, 400, 'only the listed options are writable');
  } finally {
    await s.close();
  }
}

async function manualHandoff() {
  // Only Claude Code is installed: nothing here can draw.
  const s = await start({ fakeTools: ['claude'] });
  try {
    const tiny = (version) => placeholder({ width: 400, height: 600, label: 'BY HAND', version });
    let r = await s.api('GET', '/api/health');
    assert.deepStrictEqual([r.body.tools.claude.installed, r.body.tools.codex.installed, r.body.draw.available], [true, false, false]);
    r = await s.api('POST', '/api/projects', { title: 'By Hand', description: 'A short story made without a drawing tool.', pages: 1 });
    const id = r.body.project.id;
    const P = `/api/projects/${id}`;
    const root = path.join(s.home, id, 'production');
    assertDone(await s.waitJob(id, r.body.job.id), 'project.setup');
    assert.strictEqual(ws.loadProject(root).default_providers.image, 'codex-cli');
    assertDone(await s.runOp(id, 'style.define', { description: 'Soft pencil, warm paper.' }), 'style.define');
    r = await s.api('POST', `${P}/ops`, { op: 'style.look', params: {} });
    const refused = await s.waitJob(id, r.body.job.id);
    assert.strictEqual(refused.status, 'failed');
    assert.strictEqual(refused.error.code, 'no_draw_tool');
    assert.ok(/manual handoff/.test(refused.error.message));

    // The handoff for the look page, then the person's upload becomes the candidate.
    let job = assertDone(await s.runOp(id, 'page.manual', { entity: 'LOOK_SOFT_PENCIL_WARM', sheet: 'look' }), 'page.manual look handoff');
    let handoff = job.result.handoff;
    assert.ok(handoff.prompt.length > 100);
    assert.ok(handoff.prompt.includes('Soft pencil'));
    assert.strictEqual(handoff.output_path, 'references/style/LOOK_SOFT_PENCIL_WARM_V01.png');
    assert.deepStrictEqual(handoff.images, []);
    assert.ok(fs.existsSync(path.join(root, handoff.request)));
    let upload = await s.upload(id, 'look.png', tiny(1), 'image/png');
    job = assertDone(await s.runOp(id, 'page.manual', { entity: 'LOOK_SOFT_PENCIL_WARM', sheet: 'look', upload: upload.id }), 'page.manual look upload');
    assert.deepStrictEqual([job.result.candidate, job.result.supplied_by], ['references/style/LOOK_SOFT_PENCIL_WARM_V01.png', 'person']);
    r = await s.api('POST', `${P}/approve/asset`, { candidate: job.result.candidate_id });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    job = assertDone(await s.runOp(id, 'character.create', { name: 'Nell', description: 'A lighthouse keeper.' }), 'character.create');
    assert.strictEqual(job.result.sheet.skipped, true);
    assert.ok(/manual handoff/.test(job.result.sheet.reason));
    upload = await s.upload(id, 'nell.png', tiny(2), 'image/png');
    job = assertDone(await s.runOp(id, 'page.manual', { entity: 'CHAR_NELL', sheet: 'turnaround', upload: upload.id }), 'page.manual sheet upload');
    r = await s.api('POST', `${P}/approve/asset`, { candidate: job.result.candidate_id });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    assertDone(await s.runOp(id, 'pages.plan', { text: 'Nell climbs the stairs with the lamp.', pages: 1 }), 'pages.plan');
    r = await s.api('POST', `${P}/ops`, { op: 'pages.generate', params: { issue: 'ISS_001', approve_plans: true } });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error.code, 'no_draw_tool');
    r = await s.api('GET', P);
    const pagesScreen = r.body.screens.find((x) => x.key === 'pages');
    assert.ok(pagesScreen.blockers.some((b) => b.code === 'no_draw_tool'));
    assert.deepStrictEqual([r.body.tools.draw.available, r.body.tools.plan.tool], [false, 'claude']);

    job = assertDone(await s.runOp(id, 'page.manual', { page: 'PG_001_001' }), 'page.manual page handoff');
    handoff = job.result.handoff;
    assert.strictEqual(handoff.output_path, 'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png');
    assert.deepStrictEqual(handoff.images.map((i) => [i.position, i.role]), [[1, 'style'], [2, 'identity']],
      'the handoff lists the references in order, one role each');
    assert.ok(handoff.images.every((i) => fs.existsSync(path.join(root, i.path))));
    assert.strictEqual(handoff.aspect_ratio, '2:3');
    assert.ok(/Image 1/.test(handoff.prompt));
    assert.strictEqual(ws.loadYaml(path.join(root, handoff.record)).status, 'dry_run');

    upload = await s.upload(id, 'page1.png', tiny(3), 'image/png');
    job = assertDone(await s.runOp(id, 'page.manual', { page: 'PG_001_001', upload: upload.id }), 'page.manual page upload');
    assert.deepStrictEqual([job.result.render, job.result.verdict, job.result.supplied_by, job.result.reviewed], ['PG_001_001_V01', 'pass', 'person', true]);
    assert.strictEqual(job.result.independent, true, 'a review of a hand-made image is independent of the reviewer');
    assert.strictEqual(job.steps.find((x) => x.id === 'store').tool, 'person');
    const record = ws.loadYaml(path.join(root, 'generations', 'PG_001_001', `${job.result.record}.yaml`));
    assert.deepStrictEqual([record.provider, record.status, record.output_render, record.model], ['manual', 'succeeded', 'PG_001_001_V01', 'unreported']);
    assert.ok(/Supplied by a person/.test(record.notes), 'the generation record says a person supplied the image');
    assert.deepStrictEqual(record.cost, { currency: 'USD', amount: null, estimated: false, reported: false }, 'nothing is invented in the record');
    assert.ok(fs.readFileSync(path.join(root, 'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png')).equals(tiny(3)));
    assert.strictEqual(ws.loadPage(root, 'PG_001_001').status, 'reviewed');
    r = await s.api('GET', `${P}/pages/PG_001_001`);
    assert.strictEqual(r.body.renders[0].generation.supplied_by_person, true);
    assert.strictEqual(r.body.draw.available, false);
    r = await s.api('POST', `${P}/ops`, { op: 'page.manual', params: { page: 'PG_001_001', cover: 'ISS_001' } });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(validateWorkspace(root).errors, []);
  } finally {
    await s.close();
  }

  // Only Codex is installed: it plans and reviews too, and a review of its own drawing is not independent.
  const c = await start({ fakeTools: ['codex'] });
  try {
    const id = await c.seedProject('Codex Only');
    let r = await c.api('GET', `/api/projects/${id}/jobs?limit=50`);
    const setup = r.body.jobs.find((j) => j.op === 'project.setup');
    assert.strictEqual(setup.tools.plan, 'codex', 'the result says which tool did the work');
    assert.strictEqual(setup.steps.find((x) => x.id === 'story').tool, 'codex');
    r = await c.api('GET', `/api/projects/${id}/jobs/${setup.id}/log`);
    assert.ok(r.body.lines.some((l) => /Claude Code is not installed: Codex does this step instead/.test(l)));
    assertDone(await c.runOp(id, 'pages.plan', { text: 'One quiet page.', pages: 1 }), 'pages.plan');
    const job = assertDone(await c.runOp(id, 'pages.generate', { issue: 'ISS_001', approve_plans: true }), 'pages.generate');
    assert.deepStrictEqual(job.result.tools, { draw: 'codex', look: 'codex' });
    assert.strictEqual(job.result.pages[0].independent, false, 'the tool that drew the page reviewed it');
    r = await c.api('GET', `/api/projects/${id}`);
    assert.strictEqual(r.body.screens.find((x) => x.key === 'check').counts.not_independent, 1);
  } finally {
    await c.close();
  }

  // No tool at all: an AI step fails with a plain message.
  const n = await start({ fakeTools: [] });
  try {
    const r = await n.api('POST', '/api/projects', { title: 'No Tools', description: 'Nothing is installed.' });
    const job = await n.waitJob(r.body.project.id, r.body.job.id);
    assert.strictEqual(job.status, 'failed');
    assert.strictEqual(job.error.code, 'no_tool');
    assert.ok(/Install Claude Code or Codex/.test(job.error.message));
  } finally {
    await n.close();
  }
}

async function overlayLettering() {
  const s = await start();
  try {
    const id = await s.seedProject('Overlay Letters', { options: { lettering_mode: 'overlay' } });
    const P = `/api/projects/${id}`;
    const root = path.join(s.home, id, 'production');
    assert.strictEqual(ws.loadProject(root).lettering.mode, 'overlay');
    assertDone(await s.runOp(id, 'pages.plan', { text: 'Mara reads the letter aloud.', pages: 1 }), 'pages.plan');
    let job = assertDone(await s.runOp(id, 'pages.generate', { issue: 'ISS_001', approve_plans: true }), 'pages.generate');
    assert.strictEqual(job.result.pages[0].verdict, 'pass');
    const pkg = ws.loadYaml(path.join(ws.pageDir(root, 'PG_001_001'), 'prompts', 'codex-cli.yaml'));
    assert.deepStrictEqual(pkg.lettering_text, [], 'an overlay page is drawn without text');

    let r = await s.api('GET', `${P}/issues/ISS_001/publish`);
    assert.strictEqual(r.body.lettering.mode, 'overlay');
    assert.deepStrictEqual(r.body.lettering.pages.map((p) => [p.page, p.lettered_file, p.needs_placement]), [['PG_001_001', null, true]]);
    assert.ok(r.body.readiness.blockers.some((b) => b.code === 'not_lettered'), 'an unlettered overlay page keeps the edition a draft');
    r = await s.api('GET', `${P}/pages/PG_001_001/lettering`);
    assert.strictEqual(r.body.ok, false, 'no geometry yet');

    job = assertDone(await s.runOp(id, 'lettering.apply', { issue: 'ISS_001' }), 'lettering.apply');
    assert.deepStrictEqual(job.steps.map((x) => x.status), ['done', 'done']);
    assert.strictEqual(job.result.pages[0].ok, true, JSON.stringify(job.result.pages[0].errors));
    assert.strictEqual(job.result.pages[0].svg, 'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.lettered.svg');
    assert.strictEqual(job.result.pages[0].elements, 2);
    const geometry = ws.loadYaml(path.join(ws.pageDir(root, 'PG_001_001'), 'lettering.yaml'));
    assert.strictEqual(geometry.elements[0].text, ws.loadPage(root, 'PG_001_001').panels[0].lettering[0].text);
    // Running it again places nothing new.
    job = assertDone(await s.runOp(id, 'lettering.apply', { pages: ['PG_001_001'] }), 'lettering.apply again');
    assert.strictEqual(job.steps[0].status, 'skipped');

    r = await s.api('GET', `${P}/pages/PG_001_001/lettering`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(r.body.svg.startsWith('<?xml'));
    assert.ok(/href="data:image\/png;base64,/.test(r.body.svg), 'the overlay embeds the render, so a canvas can draw it');
    assert.deepStrictEqual([r.body.width, r.body.height, r.body.render], [2000, 3000, 'PG_001_001_V01']);

    // The browser rasterizes the overlay and sends the PNG back.
    const lettered = placeholder({ width: 400, height: 600, label: 'LETTERED', version: 1 });
    r = await s.raw('POST', `${P}/pages/PG_001_001/lettered?render=PG_001_001_V01`, Buffer.from('not an image'), { 'Content-Type': 'image/png' });
    assert.strictEqual(r.status, 415);
    r = await s.raw('POST', `${P}/pages/PG_001_001/lettered?render=PG_001_009_V01`, lettered, { 'Content-Type': 'image/png' });
    assert.strictEqual(r.status, 400);
    r = await s.raw('POST', `${P}/pages/PG_001_001/lettered?render=PG_001_001_V01`, lettered, { 'Content-Type': 'image/png' });
    assert.strictEqual(r.status, 201, r.buffer.toString());
    const stored = JSON.parse(r.buffer.toString());
    assert.strictEqual(stored.path, 'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.lettered.png');
    assert.ok(stored.image.url);
    assert.ok(fs.readFileSync(path.join(root, stored.path)).equals(lettered));

    r = await s.api('GET', `${P}/pages/PG_001_001`);
    assert.strictEqual(r.body.lettering.mode, 'overlay');
    assert.strictEqual(r.body.renders[0].lettered.path, stored.path);
    assert.ok(r.body.renders[0].overlay.url.endsWith('.lettered.svg'));
    r = await s.api('GET', `${P}/issues/ISS_001/publish`);
    assert.strictEqual(r.body.readiness.final_possible, true, JSON.stringify(r.body.readiness.blockers));
    assert.strictEqual(r.body.next_edition.pages[0].lettered_file, stored.path);
    job = assertDone(await s.runOp(id, 'publish.build', { formats: ['cbz', 'images'] }), 'publish.build');
    assert.strictEqual(job.result.draft, false);
    const edition = ws.loadEdition(root, job.result.edition);
    assert.strictEqual(edition.pages[0].lettered_file, stored.path, 'the edition ships the lettered image');
    assert.deepStrictEqual(validateWorkspace(root).errors, []);

    // A project that letters in the image has no overlay step.
    const other = await s.api('POST', '/api/projects', { title: 'In Image', setup: false });
    r = await s.api('POST', `/api/projects/${other.body.project.id}/ops`, { op: 'lettering.apply', params: {} });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error.code, 'not_overlay');
  } finally {
    await s.close();
  }
}

async function main() {
  await projectsAndFiles();
  await manualHandoff();
  await overlayLettering();
  console.log('studio-files: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
