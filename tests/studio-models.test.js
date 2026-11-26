'use strict';
/**
 * Studio: the models each tool offers, the timings per model, and the
 * sample pages of the style presets.
 *
 * The model lists are read from files the CLIs keep under the user's home.
 * Here those files live in a temporary home and the CLI runner is a stub, so
 * nothing outside the test is read and no CLI starts.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const png = require('../scripts/lib/png');
const models = require('../studio/server/models');
const i18n = require('../studio/server/i18n');
const { start } = require('../studio/test-support/harness');

function done(job, label) {
  assert.strictEqual(job.status, 'done', `${label}: ${job.status} ${JSON.stringify(job.error)}`);
  return job;
}

const CLAUDE_HELP = `Options:
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name.
  -n, --name <name>                     Set a display name for this session
`;

async function detection() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'comics-studio-models-'));
  const calls = [];
  const run = async (name, args) => {
    calls.push(`${name} ${args.join(' ')}`);
    if (name === 'claude' && args[0] === '--help') return { ok: true, stdout: CLAUDE_HELP };
    if (name === 'codex' && args[0] === 'debug') return { ok: true, stdout: JSON.stringify({ models: [{ slug: 'bundled-one', display_name: 'Bundled One', visibility: 'list', priority: 1 }] }) };
    return { ok: false, stdout: '' };
  };
  const env = {};
  try {
    // Nothing on disk: Claude Code falls back to the aliases its help names; Codex to its bundled list.
    let claude = await models.detectModels('claude', { installed: true, homeDir: home, env, run });
    assert.deepStrictEqual(claude.models.map((m) => [m.id, m.source]), [['fable', 'documented'], ['opus', 'documented'], ['sonnet', 'documented']]);
    assert.strictEqual(claude.models.some((m) => m.default), false, 'the help names no default');
    assert.strictEqual(claude.models_source.kind, 'documented');
    assert.deepStrictEqual(claude.jobs, ['plan', 'look']);
    let codex = await models.detectModels('codex', { installed: true, homeDir: home, env, run });
    assert.deepStrictEqual(codex.models.map((m) => [m.id, m.source]), [['bundled-one', 'cli']]);
    assert.strictEqual(codex.models_source.where, 'codex debug models --bundled');
    assert.deepStrictEqual(codex.jobs, ['plan', 'look', 'draw']);
    assert.deepStrictEqual(calls, ['claude --help', 'codex debug models --bundled']);

    // The files the CLIs keep: Claude Code's model catalog, Codex's cache and its configuration.
    const catalogDir = path.join(home, '.claude', 'cache', 'model-catalog');
    fs.mkdirSync(catalogDir, { recursive: true });
    fs.writeFileSync(path.join(catalogDir, '00000000-0000-0000-0000-000000000000-cc.json'), JSON.stringify({
      version: 2,
      catalog: {
        config: {
          models: [
            { id: 'model-big-2', name: 'Big 2', description: 'For hard work', section: 'main' },
            { id: 'model-small-2', name: 'Small 2', description: 'Quick answers', section: 'main' },
            { id: 'model-big-1', name: 'Big 1', section: 'overflow' },
          ],
          provider_alias_targets: { big: { default: 'model-big-2' }, small: { default: 'model-small-2' } },
        },
        state: { model: 'model-big-2' },
      },
    }));
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'models_cache.json'), JSON.stringify({
      models: [
        { slug: 'later', display_name: 'Later', visibility: 'list', priority: 2, description: 'Second' },
        { slug: 'hidden', display_name: 'Hidden', visibility: 'hide', priority: 0 },
        { slug: 'first', display_name: 'First', visibility: 'list', priority: 1, description: 'First one' },
      ],
    }));
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "later"\n\n[profiles.other]\nmodel = "first"\n');
    calls.length = 0;
    claude = await models.detectModels('claude', { installed: true, homeDir: home, env, run });
    assert.deepStrictEqual(claude.models.map((m) => [m.id, m.default, m.source, m.alias_of]), [
      ['big', true, 'cli', 'model-big-2'], ['small', false, 'cli', 'model-small-2'], ['model-big-1', false, 'cli', null],
    ]);
    assert.strictEqual(claude.models[0].note, 'For hard work');
    assert.strictEqual(claude.models_source.where, '~/.claude/cache/model-catalog/', 'the folder, not the file with an account id');
    codex = await models.detectModels('codex', { installed: true, homeDir: home, env, run });
    assert.deepStrictEqual(codex.models.map((m) => [m.id, m.default, m.source]), [['first', false, 'cli'], ['later', true, 'cli']]);
    assert.strictEqual(i18n.localize('en', codex.models_source).note_code, 'model.source.codex_cache');
    assert.deepStrictEqual(calls, [], 'no CLI runs when the files are there');

    // A configured model that is not in the list is added, marked as coming from the configuration.
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'profile = "other"\n[profiles.other]\nmodel = "custom-one"\n');
    codex = await models.detectModels('codex', { installed: true, homeDir: home, env, run });
    assert.deepStrictEqual(codex.models[0], { id: 'custom-one', label: 'custom-one', default: true, source: 'config', note: { $t: 'model.note.config.codex', params: {} }, alias_of: null });
    // Not installed: an empty list, and no lookup at all.
    calls.length = 0;
    const none = await models.detectModels('claude', { installed: false, homeDir: home, env, run });
    assert.deepStrictEqual([none.models, none.models_source.kind, calls], [[], 'none', []]);

    assert.deepStrictEqual(models.parseCodexConfigModel('# c\nmodel = \'x-1\'\n'), { model: 'x-1', profile: null });
    assert.strictEqual(models.modelStatus(null, codex.models), 'default');
    assert.strictEqual(models.modelStatus('custom-one', codex.models), 'listed');
    assert.strictEqual(models.modelStatus('big', claude.models), 'listed');
    assert.strictEqual(models.modelStatus('model-big-2', claude.models), 'listed', 'an alias target counts as listed');
    assert.strictEqual(models.modelStatus('typed-by-hand', claude.models), 'custom');

    // The server reads them through the same code, once at start and on request.
    const s = await start({ fake: false, home: fs.mkdtempSync(path.join(os.tmpdir(), 'comics-studio-models-home-')), modelOptions: { homeDir: home, env, run } });
    try {
      await s.app.services.drivers.modelsReady();
      const r = await s.api('GET', '/api/health');
      for (const tool of ['claude', 'codex']) {
        const t = r.body.tools[tool];
        assert.ok(Array.isArray(t.models) && Array.isArray(t.jobs) && t.models_source, `${tool}: ${JSON.stringify(t).slice(0, 200)}`);
        if (t.installed) assert.ok(t.models.length > 0);
        else assert.deepStrictEqual(t.models, []);
      }
    } finally {
      await s.close();
      fs.rmSync(s.home, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function server() {
  const previews = fs.mkdtempSync(path.join(os.tmpdir(), 'comics-studio-previews-'));
  const sample = png.encode({ width: 20, height: 30, data: Buffer.alloc(20 * 30 * 3, 90) });
  fs.writeFileSync(path.join(previews, 'noir-ink.png'), sample);
  fs.writeFileSync(path.join(previews, 'ligne-claire.png'), Buffer.from('not an image'));
  fs.writeFileSync(path.join(previews, 'not-a-preset.png'), sample);
  const s = await start({ previewsDir: previews });
  try {
    // --- fake mode: a fixed list per tool, marked as fake ------------------------------------------------
    let r = await s.api('GET', '/api/health');
    assert.deepStrictEqual(r.body.tools.claude.models.map((m) => [m.id, m.default, m.source]), [['fake-large', true, 'fake'], ['fake-fast', false, 'fake']]);
    assert.deepStrictEqual(r.body.tools.codex.models.map((m) => m.id), ['fake-codex', 'fake-codex-mini']);
    assert.deepStrictEqual(r.body.tools.codex.jobs, ['plan', 'look', 'draw']);
    assert.strictEqual(r.body.tools.claude.models_source.kind, 'fake');
    assert.strictEqual(r.body.tools.claude.models[0].note_code, 'model.note.fake');
    r = await s.api('POST', '/api/tools/refresh', {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.tools.claude.models.length, 2);
    r = await s.api('GET', '/api/health?refresh=1');
    assert.strictEqual(r.status, 200);

    // --- settings: lists, whether each choice is listed, free names still accepted, timings ----------------
    const id = await s.seedProject('Timed');
    const P = `/api/projects/${id}`;
    r = await s.api('PUT', `${P}/settings`, { models: { claude: { plan: 'fake-large', look: 'my-own-model' }, codex: { draw: null } } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.model_status, { claude: { plan: 'listed', look: 'custom' }, codex: { plan: 'default', look: 'default', draw: 'default' } });
    done(await s.runOp(id, 'pages.plan', { text: 'Mara crosses the river. She hears a noise.', pages: 2 }), 'pages.plan');
    done(await s.runOp(id, 'pages.generate', { issue: 'ISS_001', approve_plans: true }, 60000), 'pages.generate');
    r = await s.api('GET', `${P}/settings`);
    assert.strictEqual(r.body.installed.claude.models.length, 2);
    const timings = r.body.timings;
    const plan = timings.find((t) => t.tool === 'claude' && t.job === 'plan' && t.model === 'fake-large');
    assert.ok(plan && plan.runs >= 2, JSON.stringify(timings));
    assert.strictEqual(plan.kinds['pages.plan'].runs, 1);
    assert.ok(Number.isInteger(plan.kinds['pages.plan'].per_page_ms), 'planning time per page');
    const look = timings.find((t) => t.tool === 'claude' && t.job === 'look');
    assert.deepStrictEqual([look.model, look.kinds.review.runs], ['my-own-model', 2]);
    const draw = timings.find((t) => t.tool === 'codex' && t.job === 'draw');
    assert.ok(draw && draw.model === null && draw.kinds.page.runs === 2 && Number.isInteger(draw.per_page_ms), JSON.stringify(draw));
    assert.ok(draw.kinds.sheet.runs >= 1, 'sheet drawings are timed apart from pages');
    const file = path.join(s.home, id, '.studio', 'timings.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.every((l) => l.at && l.tool && l.job && Number.isInteger(l.ms) && typeof l.ok === 'boolean'));

    // --- the sample page of each preset -------------------------------------------------------------------------------
    r = await s.api('GET', '/api/presets');
    assert.ok(r.body.presets.length >= 6);
    const noir = r.body.presets.find((p) => p.key === 'noir-ink');
    assert.deepStrictEqual([noir.preview.width, noir.preview.height], [20, 30]);
    assert.ok(/^\/api\/presets\/noir-ink\/preview\?v=[a-z0-9]+$/.test(noir.preview.url), noir.preview.url);
    assert.strictEqual(r.body.presets.find((p) => p.key === 'ligne-claire').preview, null, 'a file that is not an image is no preview');
    assert.ok(r.body.presets.filter((p) => !['noir-ink'].includes(p.key)).every((p) => p.preview === null));
    assert.ok(r.body.presets.every((p) => Array.isArray(p.drift_risks)));
    let img = await s.raw('GET', noir.preview.url);
    assert.strictEqual(img.status, 200);
    assert.strictEqual(img.headers.get('content-type'), 'image/png');
    assert.ok(/immutable/.test(img.headers.get('cache-control')));
    assert.strictEqual(img.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(img.buffer.equals(sample));
    for (const bad of ['/api/presets/ligne-claire/preview', '/api/presets/not-a-preset/preview', '/api/presets/..%2F..%2Fpackage/preview',
      '/api/presets/noir-ink.png/preview', '/api/presets/NOIR-INK/preview']) {
      img = await s.raw('GET', bad);
      assert.strictEqual(img.status, 404, bad);
    }
    r = await s.api('GET', `${P}/style`);
    assert.strictEqual(r.body.presets.find((p) => p.key === 'noir-ink').preview.url, noir.preview.url);
  } finally {
    await s.close();
    fs.rmSync(previews, { recursive: true, force: true });
  }
}

async function main() {
  const started = Date.now();
  await detection();
  await server();
  console.log(`studio-models: ok (${Date.now() - started} ms)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
