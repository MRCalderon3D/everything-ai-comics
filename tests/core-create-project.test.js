'use strict';
/**
 * scripts/create-project.js: directory skeleton, project.yaml from a template
 * (with and without tokens) or the minimal fallback, --format, starter files,
 * and --force semantics. Works on temp directories outside the repo.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('../scripts/lib/yaml');
const schemaLib = require('../scripts/lib/schema');
const {
  createProject, buildProjectYaml, PRODUCTION_DIRS, STARTER_FILES, slugifyDir, slugifyId,
} = require('../scripts/create-project');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'create-project.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eac-create-project-'));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (file) => fs.readFileSync(file, 'utf8');
const today = new Date().toISOString().slice(0, 10);

const REQUIRED_PROJECT_KEYS = ['title', 'comic_format', 'publication', 'language',
  'reading_direction', 'page', 'color_mode', 'lettering', 'default_providers'];
const projectSchemaFile = path.join(ROOT, 'schemas', 'project.schema.json');
const projectSchema = fs.existsSync(projectSchemaFile) ? JSON.parse(read(projectSchemaFile)) : null;
function assertProjectShape(doc, label) {
  for (const key of REQUIRED_PROJECT_KEYS) assert.ok(doc[key] !== undefined, `${label}: ${key} missing`);
  if (projectSchema) {
    const result = schemaLib.validate(projectSchema, doc);
    assert.ok(result.valid, `${label} violates project.schema.json: ${JSON.stringify(result.errors.slice(0, 3))}`);
  }
}

try {
  // --- slugs -----------------------------------------------------------------
  assert.strictEqual(slugifyDir('The Night Ferry'), 'the-night-ferry');
  assert.strictEqual(slugifyDir('Crónica: Año 1!'), 'cronica-ano-1');
  assert.strictEqual(slugifyDir('???'), 'untitled');
  assert.strictEqual(slugifyId('The Night Ferry'), 'THE_NIGHT_FERRY');

  // --- the layout from docs/conventions.md -----------------------------------
  for (const dir of ['story/source', 'style', 'characters', 'locations', 'props',
    'references/inbox', 'references/style', 'references/docs', 'issues',
    'generations', 'continuity', 'editions']) {
    assert.ok(PRODUCTION_DIRS.includes(dir), `PRODUCTION_DIRS lacks ${dir}`);
  }
  assert.ok(!PRODUCTION_DIRS.some((d) => /shot|scenes|edit$|audio|video|prompts/.test(d)),
    'PRODUCTION_DIRS carries film directories');
  assert.deepStrictEqual(STARTER_FILES.map(([, to]) => to), [
    'story/story-bible.yaml', 'story/series-plan.yaml', 'style/style-bible.md',
    'style/style-block.txt', 'style/color-script.md', 'references/manifest.yaml',
  ]);

  // --- minimal fallback: no templates at all ---------------------------------
  const emptyTemplates = path.join(tmp, 'no-templates');
  fs.mkdirSync(emptyTemplates);
  const bare = createProject({ target: path.join(tmp, 'bare'), title: 'Bare Comic', templatesDir: emptyTemplates });
  assert.strictEqual(bare.projectFromTemplate, false);
  assert.deepStrictEqual(bare.copied, []);
  assert.strictEqual(bare.missing.length, STARTER_FILES.length, 'missing templates are skipped, not fatal');
  for (const dir of PRODUCTION_DIRS) {
    assert.ok(fs.statSync(path.join(bare.prodDir, dir)).isDirectory(), `${dir}/ not created`);
  }
  const bareDoc = yaml.parse(read(path.join(bare.prodDir, 'project.yaml')));
  assert.strictEqual(bareDoc.title, 'Bare Comic');
  assert.strictEqual(bareDoc.comic_format, 'paged');
  assert.strictEqual(bareDoc.default_providers.image, 'harness-native');
  assert.strictEqual(bareDoc.created_at, today);
  assertProjectShape(bareDoc, 'minimal paged project.yaml');
  const webtoonDoc = yaml.parse(buildProjectYaml('Scroll', null, 'webtoon'));
  assert.strictEqual(webtoonDoc.comic_format, 'webtoon');
  assert.strictEqual(webtoonDoc.publication, 'webtoon-series');
  assertProjectShape(webtoonDoc, 'minimal webtoon project.yaml');

  // --- template with tokens --------------------------------------------------
  const tokenTemplates = path.join(tmp, 'token-templates');
  write(path.join(tokenTemplates, 'project', 'project.yaml'), [
    '# project file',
    'title: "{{TITLE}}"   # required',
    'comic_format: paged   # required. paged | webtoon',
    'slug: {{PROJECT_ID}}',
    'created_at: "{{DATE}}"',
    '',
  ].join('\r\n'));
  write(path.join(tokenTemplates, 'story', 'story-bible.yaml'), 'title: "{{TITLE}}"\npremise: TODO\nfacts: []\n');
  write(path.join(tokenTemplates, 'style', 'style-bible.md'), '# Style bible: {{TITLE}}\n');
  write(path.join(tokenTemplates, 'style', 'style-block.txt'), 'Ink noir, heavy blacks.\n');
  write(path.join(tokenTemplates, 'references', 'manifest.yaml'), 'assets: []\n');
  const tricky = 'Ferry "Nine" $& Co';
  const tok = createProject({ target: path.join(tmp, 'tok'), title: tricky, format: 'webtoon', templatesDir: tokenTemplates });
  assert.strictEqual(tok.projectFromTemplate, true);
  const tokText = read(path.join(tok.prodDir, 'project.yaml'));
  assert.ok(!tokText.includes('\r'), 'project.yaml must be LF only');
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(tokText), 'tokens left in project.yaml');
  assert.ok(tokText.startsWith('# project file\n'), 'template comments must survive');
  const tokDoc = yaml.parse(tokText);
  assert.strictEqual(tokDoc.title, tricky, 'quotes and $ in the title survive substitution');
  assert.strictEqual(tokDoc.comic_format, 'webtoon', '--format rewrites comic_format');
  assert.ok(/^comic_format: webtoon\s+# required/m.test(tokText), 'comment after comic_format survives');
  assert.strictEqual(tokDoc.slug, 'FERRY_NINE_CO');
  assert.strictEqual(tokDoc.created_at, today);
  assert.deepStrictEqual(tok.copied,
    ['story/story-bible.yaml', 'style/style-bible.md', 'style/style-block.txt', 'references/manifest.yaml']);
  assert.deepStrictEqual(tok.missing, ['story/series-plan.yaml', 'style/color-script.md']);
  assert.strictEqual(yaml.parse(read(path.join(tok.prodDir, 'story', 'story-bible.yaml'))).title, tricky);
  assert.strictEqual(read(path.join(tok.prodDir, 'style', 'style-bible.md')), `# Style bible: ${tricky}\n`);
  assert.strictEqual(read(path.join(tok.prodDir, 'style', 'style-block.txt')), 'Ink noir, heavy blacks.\n');
  assert.deepStrictEqual(yaml.parse(read(path.join(tok.prodDir, 'references', 'manifest.yaml'))), { assets: [] });

  // --- template without tokens: lines rewritten in place ---------------------
  const plainTemplates = path.join(tmp, 'plain-templates');
  write(path.join(plainTemplates, 'project', 'project.yaml'), [
    'title: Untitled comic          # required',
    'comic_format: paged            # required. paged | webtoon',
    'logline: TODO',
    'created_at: "2026-01-01"',
    '',
  ].join('\n'));
  write(path.join(plainTemplates, 'story', 'series-plan.yaml'), 'title: Untitled comic   # required\nissues: []\n');
  const plain = createProject({ target: path.join(tmp, 'plain'), title: 'The Night Ferry', templatesDir: plainTemplates });
  const plainText = read(path.join(plain.prodDir, 'project.yaml'));
  const plainDoc = yaml.parse(plainText);
  assert.strictEqual(plainDoc.title, 'The Night Ferry');
  assert.strictEqual(plainDoc.comic_format, 'paged', 'no --format keeps the template value');
  assert.strictEqual(plainDoc.created_at, today);
  assert.strictEqual(plainDoc.logline, 'TODO');
  assert.ok(/^title: "The Night Ferry"\s+# required$/m.test(plainText), 'comment after title survives');
  assert.strictEqual(yaml.parse(read(path.join(plain.prodDir, 'story', 'series-plan.yaml'))).title, 'The Night Ferry');

  // --- --force semantics -----------------------------------------------------
  assert.throws(() => createProject({ target: path.join(tmp, 'plain'), title: 'Again', templatesDir: plainTemplates }),
    /already exists \(use --force/);
  const seriesPlan = path.join(plain.prodDir, 'story', 'series-plan.yaml');
  fs.writeFileSync(seriesPlan, 'title: Edited by hand\nissues: []\n');
  const forced = createProject({ target: path.join(tmp, 'plain'), title: 'Again', force: true, templatesDir: plainTemplates });
  assert.strictEqual(yaml.parse(read(path.join(forced.prodDir, 'project.yaml'))).title, 'Again');
  assert.deepStrictEqual(forced.kept, ['story/series-plan.yaml']);
  assert.strictEqual(read(seriesPlan), 'title: Edited by hand\nissues: []\n', '--force never overwrites starter files');

  // --- CLI against the repo's own templates ----------------------------------
  const cliTarget = path.join(tmp, 'cli');
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: tmp });
  const first = run(['--title', 'Test Comic', '--target', cliTarget, '--format', 'webtoon']);
  assert.strictEqual(first.status, 0, `create-project failed: ${first.stdout}${first.stderr}`);
  const cliDoc = yaml.parse(read(path.join(cliTarget, 'production', 'project.yaml')));
  assert.strictEqual(cliDoc.title, 'Test Comic');
  assert.strictEqual(cliDoc.comic_format, 'webtoon');
  assertProjectShape(cliDoc, 'project.yaml from the repo template');
  for (const dir of PRODUCTION_DIRS) {
    assert.ok(fs.existsSync(path.join(cliTarget, 'production', dir)), `CLI did not create ${dir}/`);
  }
  for (const [from, to] of STARTER_FILES) {
    if (!fs.existsSync(path.join(ROOT, 'templates', ...from.split('/')))) continue;
    const dest = path.join(cliTarget, 'production', ...to.split('/'));
    assert.ok(fs.existsSync(dest), `starter ${to} not copied`);
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(read(dest)), `tokens left in ${to}`);
    if (/\.ya?ml$/.test(to)) yaml.parse(read(dest));
  }
  const second = run(['--title', 'Test Comic', '--target', cliTarget]);
  assert.strictEqual(second.status, 1, 'second run without --force must fail');
  assert.match(second.stderr, /already exists/);
  assert.strictEqual(run(['--title', 'X', '--target', path.join(tmp, 'bad'), '--format', 'strip']).status, 1,
    'unknown --format must fail');
  assert.ok(!fs.existsSync(path.join(tmp, 'bad')), 'a rejected --format creates nothing');
  assert.strictEqual(run(['--target', path.join(tmp, 'untitled')]).status, 1, '--title is required');

  // no --target: the folder takes the title's slug, relative to the cwd
  const third = run(['--title', 'Slug Me']);
  assert.strictEqual(third.status, 0, third.stderr);
  assert.ok(fs.existsSync(path.join(tmp, 'slug-me', 'production', 'project.yaml')));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('core-create-project: OK');
