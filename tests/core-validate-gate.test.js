'use strict';
/**
 * scripts/validate.js: every section reports instead of throwing, on an empty
 * root as much as on a broken one, and the rules, contexts, and example
 * sections accept a correct tree and reject the documented failures.
 * Works on synthetic scaffold roots in a temp directory.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createReport } = require('../scripts/lib/report');
const { parseConventionsRosters } = require('../scripts/lib/manifest');
const validate = require('../scripts/validate');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eac-validate-gate-'));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/** Run sections against a root and capture the report lines. */
async function run(root, names) {
  const lines = [];
  const report = createReport({ log: (line) => lines.push(String(line)) });
  await validate.runSections(root, names, report);
  return { failed: report.failed, passed: report.passed, text: lines.join('\n') };
}

const RULE_DOC = '# Title\n\n## Purpose\nWhy.\n\n## Scope\nWhere.\n\n## Core Principles\n- One.\n\n## Validation\nHow.\n';

async function main() {
  const sections = Object.keys(validate.SECTIONS);
  assert.deepStrictEqual(sections, ['manifests', 'files', 'agents', 'commands', 'skills',
    'rules', 'contexts', 'schemas', 'templates', 'providers', 'hooks', 'example', 'harnesses']);
  assert.strictEqual(validate.SCHEMA_NAMES.length, 19);
  assert.strictEqual(validate.SCHEMA_ID_BASE, 'https://everything-ai-comics.dev/schemas/');
  assert.deepStrictEqual(validate.RULE_SECTIONS, ['Purpose', 'Scope', 'Core Principles', 'Validation']);

  // --- an empty root: every section fails with a message, none crashes -------
  const empty = path.join(tmp, 'empty');
  fs.mkdirSync(empty);
  for (const name of sections) {
    const result = await run(empty, [name]);
    assert.ok(result.failed > 0, `section "${name}" must fail on an empty root`);
    assert.ok(!/crashed/.test(result.text), `section "${name}" crashed on an empty root:\n${result.text}`);
  }
  await assert.rejects(() => run(empty, ['nope']), /unknown section "nope"/);

  // --- a synthetic scaffold: contract docs + manifests from this repo --------
  const root = path.join(tmp, 'scaffold');
  write(path.join(root, 'docs', 'conventions.md'), fs.readFileSync(path.join(ROOT, 'docs', 'conventions.md')));
  for (const name of ['agents.json', 'commands.json', 'skills.json', 'rules.json', 'profiles.json', 'harnesses.json']) {
    write(path.join(root, 'manifests', name), fs.readFileSync(path.join(ROOT, 'manifests', name)));
  }
  const rosters = parseConventionsRosters(root);
  write(path.join(root, 'manifests', 'image-providers.json'), JSON.stringify({
    version: 1,
    providers: rosters.providers.image.map((id) => ({
      id, file: `providers/image/${id}.js`, label: id, env: [], capabilities: {},
    })),
  }));

  // manifests: the real manifests agree with the real conventions
  const manifests = await run(root, ['manifests']);
  assert.strictEqual(manifests.failed, 0, `manifests section failed:\n${manifests.text}`);

  // a profile that lacks an agent its commands need is rejected
  const profilesFile = path.join(root, 'manifests', 'profiles.json');
  const profilesText = fs.readFileSync(profilesFile, 'utf8');
  const broken = JSON.parse(profilesText);
  broken.profiles.publishing.agents = broken.profiles.publishing.agents.filter((a) => a !== 'letterer');
  fs.writeFileSync(profilesFile, JSON.stringify(broken));
  const incomplete = await run(root, ['manifests']);
  assert.ok(incomplete.failed > 0 && /lettering needs agent letterer/.test(incomplete.text), incomplete.text);
  fs.writeFileSync(profilesFile, profilesText);

  // --- rules ------------------------------------------------------------------
  for (const layer of rosters.rules) {
    for (const name of layer.rules) write(path.join(root, 'rules', layer.name, `${name}.md`), RULE_DOC);
  }
  write(path.join(root, 'rules', 'README.md'), '# rules\n');
  write(path.join(root, 'rules', 'common', 'README.md'), '# common\n');
  const rulesOk = await run(root, ['rules']);
  assert.strictEqual(rulesOk.failed, 0, `rules section failed on a correct tree:\n${rulesOk.text}`);

  const victim = path.join(root, 'rules', 'layout', 'pacing.md');
  fs.writeFileSync(victim, RULE_DOC.replace('## Validation\nHow.\n', ''));
  const noHeading = await run(root, ['rules']);
  assert.ok(noHeading.failed === 1 && /rules\/layout\/pacing\.md: missing sections: Validation/.test(noHeading.text),
    noHeading.text);
  fs.unlinkSync(victim);
  const noFile = await run(root, ['rules']);
  assert.ok(noFile.failed === 1 && /rules\/layout\/pacing\.md does not exist/.test(noFile.text), noFile.text);
  fs.writeFileSync(victim, RULE_DOC);

  write(path.join(root, 'rules', 'extra', 'unlisted-rule.md'), RULE_DOC);
  const stray = await run(root, ['rules']);
  assert.ok(stray.failed === 1 && /files outside the roster: extra\/unlisted-rule\.md/.test(stray.text), stray.text);
  fs.rmSync(path.join(root, 'rules', 'extra'), { recursive: true });

  const rulesFile = path.join(root, 'manifests', 'rules.json');
  const rulesText = fs.readFileSync(rulesFile, 'utf8');
  const drifted = JSON.parse(rulesText);
  drifted.layers.find((l) => l.name === 'paged').kind = 'domain';
  fs.writeFileSync(rulesFile, JSON.stringify(drifted));
  const wrongKind = await run(root, ['rules']);
  assert.ok(wrongKind.failed > 0 && /paged\/ differs from the roster/.test(wrongKind.text), wrongKind.text);
  fs.writeFileSync(rulesFile, rulesText);

  // --- contexts -----------------------------------------------------------------
  for (const name of validate.CONTEXT_NAMES) write(path.join(root, 'contexts', `${name}.md`), `# ${name}\n\nText.\n`);
  assert.strictEqual((await run(root, ['contexts'])).failed, 0);
  fs.writeFileSync(path.join(root, 'contexts', 'review.md'), '  \n');
  fs.unlinkSync(path.join(root, 'contexts', 'publishing.md'));
  const contexts = await run(root, ['contexts']);
  assert.strictEqual(contexts.failed, 2, contexts.text);
  assert.ok(/contexts\/publishing\.md missing/.test(contexts.text), contexts.text);

  // --- example ------------------------------------------------------------------
  const noExample = await run(root, ['example']);
  assert.ok(noExample.failed === 1 && /example workspace is not written yet/.test(noExample.text), noExample.text);

  write(path.join(root, 'examples', 'the-night-ferry', 'project.yaml'), 'title: The Night Ferry\n');
  const noScript = await run(root, ['example']);
  assert.ok(noScript.failed === 1 && /validate-workspace\.js is not written yet/.test(noScript.text), noScript.text);

  // each stub lives in its own root so require() never serves a cached module
  const stubRoot = (name, source) => {
    const dir = path.join(tmp, name);
    write(path.join(dir, 'examples', 'the-night-ferry', 'project.yaml'), 'title: The Night Ferry\n');
    write(path.join(dir, 'scripts', 'validate-workspace.js'), source);
    return dir;
  };
  const clean = await run(stubRoot('stub-clean',
    'module.exports = { validateWorkspace: (root, opts) => ({ errors: [], warnings: [{ file: "a", code: "W", message: "m" }] }) };'),
  ['example']);
  assert.ok(clean.failed === 0 && clean.passed === 1 && /1 warning/.test(clean.text), clean.text);

  const dirty = await run(stubRoot('stub-dirty',
    'module.exports = { validateWorkspace: async () => ({ errors: [{ file: "issues/ISS_001/issue.yaml", code: "SCHEMA", message: "bad" }], warnings: [] }) };'),
  ['example']);
  assert.ok(dirty.failed === 1 && /\[SCHEMA\] bad/.test(dirty.text), dirty.text);

  const throwing = await run(stubRoot('stub-throwing',
    'module.exports = { validateWorkspace: () => { throw new Error("boom"); } };'), ['example']);
  assert.ok(throwing.failed === 1 && /crashed on examples\/the-night-ferry: boom/.test(throwing.text), throwing.text);

  const wrongExport = await run(stubRoot('stub-other','module.exports = { main() {} };'), ['example']);
  assert.ok(wrongExport.failed === 1 && /does not export validateWorkspace\(\)/.test(wrongExport.text), wrongExport.text);

  const unloadable = await run(stubRoot('stub-broken', 'require("./lib/not-there");'), ['example']);
  assert.ok(unloadable.failed === 1 && /require failed/.test(unloadable.text), unloadable.text);

  const withLedger = stubRoot('stub-ledger', 'module.exports = { validateWorkspace: () => ({ errors: [], warnings: [] }) };');
  write(path.join(withLedger, 'scripts', 'check-continuity.js'),
    'module.exports = { checkContinuity: () => ({ findings: [{ code: "CUSTODY", severity: "error", page: "PG_001_002", message: "gun teleports" }] }) };');
  const ledger = await run(withLedger, ['example']);
  assert.ok(ledger.failed === 1 && ledger.passed === 1 && /\[CUSTODY\] gun teleports/.test(ledger.text), ledger.text);

  // --- CLI: exit code and unknown sections --------------------------------------
  const cli = (args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'validate.js'), ...args], { encoding: 'utf8' });
  assert.strictEqual(cli(['--root', root, '--section', 'rules']).status, 0);
  assert.strictEqual(cli(['--root', empty, '--section', 'rules']).status, 1);
  const unknown = cli(['--section', 'nope']);
  assert.strictEqual(unknown.status, 1);
  assert.match(unknown.stderr, /unknown section "nope"/);
  const whole = cli(['--root', empty]);
  assert.strictEqual(whole.status, 1);
  assert.ok(!/crashed/.test(whole.stdout), `a section crashed on an empty root:\n${whole.stdout}`);
}

main().then(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('core-validate-gate: OK');
}, (err) => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.error(err);
  process.exit(1);
});
