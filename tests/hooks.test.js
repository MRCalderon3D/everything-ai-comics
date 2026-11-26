'use strict';
/**
 * hooks/: the four handlers, fed JSON events on stdin the way a harness does.
 * Exit 0 allows, exit 2 blocks. Schema-dependent cases run against a temp copy
 * of the scaffold with its own schemas/, so they do not depend on the real
 * schemas/ directory being written yet.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  REPO_ROOT, PAGE_1, PAGE_2, makeWorkspace, tempDir, castRow, createRunner,
} = require('./fixtures/gates/workspace-helper');

const HOOKS_DIR = path.join(REPO_ROOT, 'hooks');
const t = createRunner('hooks');

/** Run a hook as a child process with `event` on stdin. */
function runHook(name, event, { hooksDir = HOOKS_DIR, cwd, raw } = {}) {
  const res = spawnSync(process.execPath, [path.join(hooksDir, `${name}.js`)], {
    input: raw !== undefined ? raw : JSON.stringify(event),
    encoding: 'utf8',
    cwd: cwd || REPO_ROOT,
    timeout: 60000,
  });
  return { status: res.status, stderr: res.stderr || '', stdout: res.stdout || '' };
}

function allowed(res, message) {
  assert.strictEqual(res.status, 0, `${message || 'expected exit 0'}: ${res.stderr}`);
}

function blocked(res, message) {
  assert.strictEqual(res.status, 2, `${message || 'expected exit 2'}: ${res.stderr}`);
  assert.ok(res.stderr.length > 0, 'a block explains itself on stderr');
}

// --- hooks.json ------------------------------------------------------------------

t.test('hooks.json wires the four hooks with workspace-name-independent globs', () => {
  const config = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, 'hooks.json'), 'utf8'));
  assert.deepStrictEqual(config.hooks.map((h) => h.id).sort(),
    ['detect-continuity-drift', 'protect-approved-assets', 'require-cost-confirmation', 'validate-after-write']);
  const events = { 'before-file-write': 0, 'after-file-write': 0, 'before-shell-command': 0 };
  for (const hook of config.hooks) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, ...hook.script.split('/'))), `${hook.script} exists`);
    assert.ok(hook.event in events, `${hook.id}: known event ${hook.event}`);
    assert.strictEqual(typeof hook.match, 'string');
    assert.ok(!/production/.test(hook.match), `${hook.id}: match must not hardcode the workspace name (${hook.match})`);
    assert.strictEqual(typeof hook.blocking, 'boolean');
  }
  const byId = Object.fromEntries(config.hooks.map((h) => [h.id, h]));
  assert.strictEqual(byId['detect-continuity-drift'].blocking, false);
  for (const part of ['renders', 'exports', 'references', 'refs']) {
    assert.ok(byId['protect-approved-assets'].match.includes(part), `protect glob covers ${part}`);
  }
  assert.ok(byId['detect-continuity-drift'].match.endsWith('issues/*/pages/*/page.yaml'));
});

// --- protect-approved-assets -------------------------------------------------------

const MARA_SHEET = 'characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png';
const LOOK_MASTER = 'references/style/LOOK_NOIR_INK_MASTER_V01.png';
const GUN_DETAIL = 'props/PROP_FLARE_GUN/refs/PROP_FLARE_GUN_DETAIL_V01.png';
const RENDERS_P2 = 'issues/ISS_001/pages/PG_001_002/renders';

t.test('protect: writes to approved reference assets are blocked', () => {
  const w = makeWorkspace();
  for (const rel of [MARA_SHEET, LOOK_MASTER]) {
    const res = runHook('protect-approved-assets', { file: w.abs(rel) });
    blocked(res, rel);
    assert.ok(res.stderr.includes('approved'), res.stderr);
    assert.ok(/next version instead \((CHAR_MARA_TURN|LOOK_NOIR_INK)_MASTER_V02\)/.test(res.stderr), res.stderr);
  }
});

t.test('protect: unapproved assets, new assets, and the manifest stay writable', () => {
  const w = makeWorkspace();
  allowed(runHook('protect-approved-assets', { file: w.abs(GUN_DETAIL) }), 'status review is not approved');
  allowed(runHook('protect-approved-assets', { file: w.abs('characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V02.png') }));
  allowed(runHook('protect-approved-assets', { file: w.abs('references/manifest.yaml') }));
  allowed(runHook('protect-approved-assets', { file: w.abs('characters/CHAR_MARA/character.yaml') }));
  // Superseding the master in the manifest releases the file.
  w.edit('references/manifest.yaml', (m) => { m.assets[1].status = 'superseded'; });
  allowed(runHook('protect-approved-assets', { file: w.abs(MARA_SHEET) }));
});

t.test('protect: an existing render is never overwritten; the next version is named', () => {
  const w = makeWorkspace();
  const res = runHook('protect-approved-assets', { file: w.abs(`${RENDERS_P2}/PG_001_002_V01.png`) });
  blocked(res);
  assert.ok(res.stderr.includes('PG_001_002_V03'), `should name the next free version: ${res.stderr}`);
  allowed(runHook('protect-approved-assets', { file: w.abs(`${RENDERS_P2}/PG_001_002_V03.png`) }), 'a new version is fine');
  // Any existing file in renders/ counts, including a lettered overlay.
  w.writeText(`${RENDERS_P2}/PG_001_002_V02.lettered.svg`, '<svg/>');
  blocked(runHook('protect-approved-assets', { file: w.abs(`${RENDERS_P2}/PG_001_002_V02.lettered.svg`) }));
});

t.test('protect: an existing export is never overwritten; the next edition is named', () => {
  const w = makeWorkspace();
  const exportRel = 'editions/ED_001_01/exports/the-night-ferry-ed01.cbz';
  allowed(runHook('protect-approved-assets', { file: w.abs(exportRel) }), 'first build');
  w.writeText(exportRel, 'cbz');
  const res = runHook('protect-approved-assets', { file: w.abs(exportRel) });
  blocked(res);
  assert.ok(res.stderr.includes('ED_001_02'), res.stderr);
  // edition.yaml itself is plain data and stays editable.
  allowed(runHook('protect-approved-assets', { file: w.abs('editions/ED_001_01/edition.yaml') }));
});

t.test('protect: renamed workspaces, harness dialects, and relative paths all resolve', () => {
  const w = makeWorkspace('production-night-ferry');
  const render = w.abs(`${RENDERS_P2}/PG_001_002_V02.png`);
  blocked(runHook('protect-approved-assets', { file: render }), 'renamed workspace');
  blocked(runHook('protect-approved-assets', { tool_name: 'Write', tool_input: { file_path: render } }), 'Claude dialect');
  blocked(runHook('protect-approved-assets', { path: render }), 'path dialect');
  blocked(runHook('protect-approved-assets', {
    cwd: w.base,
    tool_input: { file_path: `production-night-ferry/${MARA_SHEET}` },
  }), 'relative path resolved against the event cwd');
  blocked(runHook('protect-approved-assets', { file: `production-night-ferry/${MARA_SHEET}` }, { cwd: w.base }),
    'relative path resolved against the process cwd');
});

t.test('protect: files outside a workspace and bad events are allowed', () => {
  const outside = tempDir();
  fs.mkdirSync(path.join(outside, 'renders'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'renders', 'PG_001_001_V01.png'), 'x');
  allowed(runHook('protect-approved-assets', { file: path.join(outside, 'renders', 'PG_001_001_V01.png') }));
  allowed(runHook('protect-approved-assets', {}));
  allowed(runHook('protect-approved-assets', null, { raw: '' }));
  allowed(runHook('protect-approved-assets', null, { raw: '{not json' }));
  allowed(runHook('protect-approved-assets', null, { raw: '[1, 2]' }));
});

// --- validate-after-write ----------------------------------------------------------

/** A temp copy of hooks/ and scripts/ with its own schemas/ directory. */
function scaffoldCopy(schemas) {
  const root = tempDir('comics-scaffold-');
  const copy = (relDir, filter) => {
    const from = path.join(REPO_ROOT, ...relDir.split('/'));
    const to = path.join(root, ...relDir.split('/'));
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      if (filter(name) && fs.statSync(path.join(from, name)).isFile()) {
        fs.copyFileSync(path.join(from, name), path.join(to, name));
      }
    }
  };
  copy('hooks', (n) => n.endsWith('.js'));
  copy('scripts/lib', (n) => n.endsWith('.js'));
  copy('scripts', (n) => n === 'check-continuity.js');
  fs.mkdirSync(path.join(root, 'schemas'));
  for (const [name, schema] of Object.entries(schemas)) {
    fs.writeFileSync(path.join(root, 'schemas', `${name}.schema.json`), JSON.stringify(schema));
  }
  return { root, hooksDir: path.join(root, 'hooks') };
}

const PAGE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['id', 'issue', 'number', 'scene', 'layout', 'panels', 'continuity', 'status'],
  properties: {
    id: { type: 'string', pattern: '^PG_\\d{3}_\\d{3}$' },
    status: { enum: ['planned', 'scripted', 'prompted', 'rendered', 'reviewed', 'approved'] },
    panels: { type: 'array', minItems: 1 },
  },
};

t.test('validate-after-write: a valid artifact passes, a schema violation blocks', () => {
  const scaffold = scaffoldCopy({ page: PAGE_SCHEMA });
  const w = makeWorkspace('production-night-ferry');
  allowed(runHook('validate-after-write', { file: w.abs(PAGE_1) }, scaffold), 'clean page');

  w.edit(PAGE_1, (p) => {
    p.id = 'PAGE-ONE';
    p.status = 'drawn';
  });
  const res = runHook('validate-after-write', { tool_input: { file_path: w.abs(PAGE_1) } }, scaffold);
  blocked(res);
  assert.ok(res.stderr.includes('schemas/page.schema.json'), res.stderr);
  assert.ok(res.stderr.includes('production-night-ferry/issues/ISS_001/pages/PG_001_001/page.yaml'),
    `the message uses the real workspace name: ${res.stderr}`);
  assert.ok(res.stderr.includes('$.id') && res.stderr.includes('$.status'), res.stderr);
});

t.test('validate-after-write: unparseable YAML blocks', () => {
  const scaffold = scaffoldCopy({ page: PAGE_SCHEMA });
  const w = makeWorkspace();
  w.writeText(PAGE_2, 'id: PG_001_002\n  panels: [oops\n');
  const res = runHook('validate-after-write', { file: w.abs(PAGE_2) }, scaffold);
  blocked(res);
  assert.ok(res.stderr.includes('not parseable YAML'), res.stderr);
});

t.test('validate-after-write: unknown files, missing schemas, and bad events are allowed', () => {
  const scaffold = scaffoldCopy({ page: PAGE_SCHEMA });
  const w = makeWorkspace();
  w.writeText('references/manifest.yaml', 'assets: definitely not a list\n');
  allowed(runHook('validate-after-write', { file: w.abs('references/manifest.yaml') }, scaffold), 'no schema governs it');
  w.writeText('issues/ISS_001/issue.yaml', 'nothing: valid\n');
  allowed(runHook('validate-after-write', { file: w.abs('issues/ISS_001/issue.yaml') }, scaffold),
    'issue.schema.json is not installed in this scaffold copy');
  allowed(runHook('validate-after-write', { file: w.abs('issues/ISS_001/pages/PG_001_009/page.yaml') }, scaffold),
    'file does not exist');
  allowed(runHook('validate-after-write', { file: path.join(tempDir(), 'page.yaml') }, scaffold), 'outside a workspace');
  allowed(runHook('validate-after-write', {}, scaffold));
  allowed(runHook('validate-after-write', null, { ...scaffold, raw: 'garbage' }));
});

t.test('validate-after-write: the real scaffold accepts the clean fixture', () => {
  // Uses whatever schemas/ holds right now; with none, every file is allowed.
  const w = makeWorkspace();
  for (const rel of [PAGE_1, PAGE_2, 'project.yaml', 'issues/ISS_001/issue.yaml', 'editions/ED_001_01/edition.yaml']) {
    allowed(runHook('validate-after-write', { file: w.abs(rel) }), rel);
  }
});

// --- detect-continuity-drift -------------------------------------------------------

t.test('drift: silent on a consistent page, and on files that are not page.yaml', () => {
  const w = makeWorkspace();
  let res = runHook('detect-continuity-drift', { file: w.abs(PAGE_2) });
  allowed(res);
  assert.strictEqual(res.stderr, '');
  res = runHook('detect-continuity-drift', { file: w.abs('issues/ISS_001/issue.yaml') });
  allowed(res);
  assert.strictEqual(res.stderr, '');
  allowed(runHook('detect-continuity-drift', {}));
});

t.test('drift: warns with the findings of the written page and never blocks', () => {
  const w = makeWorkspace('production-night-ferry');
  w.edit(PAGE_2, (p) => {
    p.panels[0].transfers = [];
    castRow(p, 1, 'CHAR_OSKAR').state = [];
  });
  const res = runHook('detect-continuity-drift', { tool_input: { file_path: w.abs(PAGE_2) } });
  allowed(res, 'advisory hooks exit 0');
  for (const part of ['[CUSTODY_JUMP]', '[STATE_DROPPED]', 'PN_001_002_01', 'PN_001_002_02', '--issue ISS_001',
    'production-night-ferry/issues/ISS_001/pages/PG_001_002/page.yaml']) {
    assert.ok(res.stderr.includes(part), `stderr should mention ${part}: ${res.stderr}`);
  }
  // The other page has no findings of its own, so writing it stays silent.
  const other = runHook('detect-continuity-drift', { file: w.abs(PAGE_1) });
  allowed(other);
  assert.strictEqual(other.stderr, '');
});

t.test('drift: a chain break on a neighbour that names the page is reported', () => {
  const w = makeWorkspace();
  w.edit(PAGE_1, (p) => { p.continuity.exits_to = null; });
  const res = runHook('detect-continuity-drift', { file: w.abs(PAGE_2) });
  allowed(res);
  assert.ok(res.stderr.includes('[PAGE_CHAIN]') && res.stderr.includes('PG_001_002'), res.stderr);
});

t.test('drift: an unparseable page does not crash or block', () => {
  const w = makeWorkspace();
  w.writeText(PAGE_2, 'id: PG_001_002\n  panels: [oops\n');
  allowed(runHook('detect-continuity-drift', { file: w.abs(PAGE_2) }));
});

// --- require-cost-confirmation -----------------------------------------------------

t.test('cost: live generation without --yes is blocked', () => {
  const page = 'production/issues/ISS_001/pages/PG_001_001/page.yaml';
  for (const command of [
    `node scripts/generate-assets.js --page ${page} --live`,
    `node scripts/generate-assets.js --live --page ${page}`,
    'npm run generate:assets -- --issue production/issues/ISS_001 --live',
    'node scripts/generate-assets --package x.yaml --live=true',
  ]) {
    blocked(runHook('require-cost-confirmation', { command }), command);
  }
  const res = runHook('require-cost-confirmation', {
    tool_name: 'Bash',
    tool_input: { command: `node scripts/generate-assets.js --page ${page} --live` },
  });
  blocked(res, 'Claude dialect');
  assert.ok(res.stderr.includes('--yes'), res.stderr);
});

t.test('cost: dry runs, confirmed runs, and other commands are allowed', () => {
  for (const command of [
    'node scripts/generate-assets.js --page page.yaml',
    'node scripts/generate-assets.js --page page.yaml --live --yes',
    'npm run generate:assets -- --issue production/issues/ISS_001 --yes --live',
    'node scripts/build-edition.js --edition edition.yaml --live',
    'npm test',
  ]) {
    allowed(runHook('require-cost-confirmation', { command }), command);
  }
  allowed(runHook('require-cost-confirmation', {}));
  allowed(runHook('require-cost-confirmation', { command: 42 }));
  allowed(runHook('require-cost-confirmation', null, { raw: '' }));
});

// --- handle() exports --------------------------------------------------------------

let inProcess = Promise.resolve([]);

t.test('each handler exports handle(event) returning the exit code', () => {
  const w = makeWorkspace();
  const pending = [];
  const expect = (name, event, code) => {
    const { handle } = require(path.join(HOOKS_DIR, `${name}.js`));
    assert.strictEqual(typeof handle, 'function', `${name} exports handle`);
    pending.push(handle(event).then((actual) => ({ name, actual, code })));
  };
  // Silence the handlers' stderr while calling them in-process.
  const write = process.stderr.write;
  process.stderr.write = () => true;
  expect('protect-approved-assets', { file: w.abs(MARA_SHEET) }, 2);
  expect('protect-approved-assets', { file: w.abs(GUN_DETAIL) }, 0);
  expect('require-cost-confirmation', { command: 'node scripts/generate-assets.js --live' }, 2);
  expect('detect-continuity-drift', { file: w.abs(PAGE_1) }, 0);
  expect('validate-after-write', { file: w.abs('references/manifest.yaml') }, 0);
  inProcess = Promise.all(pending).finally(() => { process.stderr.write = write; });
});

// The in-process case is async: wait for it before reporting.
Promise.resolve().then(() => inProcess).then((results) => {
  t.test('in-process handler results match their exit codes', () => {
    for (const r of results) assert.strictEqual(r.actual, r.code, r.name);
    assert.strictEqual(results.length, 5);
  });
  t.finish();
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
  t.finish();
});
