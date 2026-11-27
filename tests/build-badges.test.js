'use strict';
/**
 * scripts/build-badges.js: the README badges carry the manifest counts, the
 * committed files match what the script writes, and the validate gate
 * reports a stale, missing, or extra badge with the command that fixes it.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const badges = require('../scripts/build-badges');
const validate = require('../scripts/validate');
const { createReport } = require('../scripts/lib/report');
const { loadManifests, ruleLayers } = require('../scripts/lib/manifest');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'build-badges.js');

async function runBadgeSection(root) {
  const lines = [];
  const report = createReport({ log: (line) => lines.push(String(line)) });
  await validate.runSections(root, ['badges'], report);
  return { failed: report.failed, text: lines.join('\n') };
}

async function main() {
  // --- text widths: deterministic, wider text is wider -----------------------
  assert.strictEqual(badges.textWidth(''), 0);
  assert.ok(badges.textWidth('mmmm') > badges.textWidth('iiii'));
  assert.strictEqual(badges.textWidth('agents'), badges.textWidth('agents'));

  // --- one badge: two parts, sized from the text, escaped ----------------------
  const svg = badges.renderBadge('a&b', '<1>', 'blue');
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes('fill="#555"') && svg.includes('fill="#007ec6"'), svg);
  assert.ok(svg.includes('a&amp;b') && svg.includes('&lt;1&gt;'), 'label and value are escaped');
  const lw = badges.textWidth('a&b') + 10;
  const vw = badges.textWidth('<1>') + 10;
  assert.ok(svg.includes(`width="${lw + vw}" height="20"`), 'total width is label plus value with padding');
  assert.ok(svg.includes(`textLength="${(lw - 10) * 10}"`), 'label textLength matches the measured width');
  // a light colour gets dark text
  assert.ok(badges.renderBadge('x', 'y', 'eeeeee').includes('fill="#333"'));

  // --- the specs follow the manifests ------------------------------------------
  const specs = badges.badgeSpecs(ROOT);
  assert.deepStrictEqual(specs.map((s) => s.name),
    ['license', 'agents', 'commands', 'skills', 'rules', 'schemas', 'providers', 'harnesses', 'formats']);
  const by = Object.fromEntries(specs.map((s) => [s.name, s.value]));
  const { manifests } = loadManifests(ROOT);
  assert.strictEqual(by.agents, String(manifests['agents.json'].agents.length));
  assert.strictEqual(by.commands, String(manifests['commands.json'].commands.length));
  assert.strictEqual(by.skills, String(manifests['skills.json'].skills.length));
  assert.strictEqual(by.rules, String(ruleLayers(manifests).reduce((n, l) => n + l.rules.length, 0)));
  assert.strictEqual(by.providers, String(manifests['image-providers.json'].providers.length));
  assert.strictEqual(by.harnesses, String(manifests['harnesses.json'].harnesses.length));
  assert.strictEqual(by.schemas, String(fs.readdirSync(path.join(ROOT, 'schemas')).filter((f) => f.endsWith('.schema.json')).length));
  assert.strictEqual(by.formats, 'paged | webtoon');
  assert.strictEqual(by.license, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).license);

  // --- the committed badges are current -------------------------------------------
  assert.deepStrictEqual(badges.diffBadges(ROOT), [], 'committed badges are stale: run npm run badges');
  const ok = await runBadgeSection(ROOT);
  assert.strictEqual(ok.failed, 0, ok.text);

  // --- a copy with a changed roster drifts, and the write fixes it ----------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eac-badges-'));
  try {
    fs.cpSync(path.join(ROOT, 'manifests'), path.join(tmp, 'manifests'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'schemas'), path.join(tmp, 'schemas'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'docs', 'images', 'badges'), path.join(tmp, 'docs', 'images', 'badges'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(tmp, 'package.json'));
    assert.deepStrictEqual(badges.diffBadges(tmp), []);

    const agentsFile = path.join(tmp, 'manifests', 'agents.json');
    const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
    agents.agents.push({ name: 'extra', file: 'agents/extra.md', description: 'x' });
    fs.writeFileSync(agentsFile, JSON.stringify(agents));
    fs.writeFileSync(path.join(tmp, 'docs', 'images', 'badges', 'old.svg'), '<svg/>');
    fs.unlinkSync(path.join(tmp, 'docs', 'images', 'badges', 'rules.svg'));
    const drift = badges.diffBadges(tmp);
    assert.ok(drift.includes('stale: docs/images/badges/agents.svg'), drift.join('\n'));
    assert.ok(drift.includes('missing: docs/images/badges/rules.svg'), drift.join('\n'));
    assert.ok(drift.includes('unexpected: docs/images/badges/old.svg'), drift.join('\n'));

    const gate = await runBadgeSection(tmp);
    assert.ok(gate.failed > 0 && /npm run badges/.test(gate.text), gate.text);

    const check = spawnSync(process.execPath, [SCRIPT, '--check', '--root', tmp], { encoding: 'utf8' });
    assert.strictEqual(check.status, 1, check.stdout + check.stderr);
    assert.ok(/npm run badges/.test(check.stdout), check.stdout);

    const write = spawnSync(process.execPath, [SCRIPT, '--root', tmp], { encoding: 'utf8' });
    assert.strictEqual(write.status, 0, write.stdout + write.stderr);
    assert.deepStrictEqual(badges.diffBadges(tmp), []);
    assert.ok(!fs.existsSync(path.join(tmp, 'docs', 'images', 'badges', 'old.svg')));
    const agentsSvg = fs.readFileSync(path.join(tmp, 'docs', 'images', 'badges', 'agents.svg'), 'utf8');
    assert.ok(agentsSvg.includes(`agents: ${agents.agents.length}`), agentsSvg);

    const again = spawnSync(process.execPath, [SCRIPT, '--check', '--root', tmp], { encoding: 'utf8' });
    assert.strictEqual(again.status, 0, again.stdout + again.stderr);

    // without manifests the script refuses with a message, and the gate reports it
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    const refused = spawnSync(process.execPath, [SCRIPT, '--root', empty], { encoding: 'utf8' });
    assert.strictEqual(refused.status, 1);
    assert.ok(/cannot read the manifests/.test(refused.stderr), refused.stderr);
    const emptyGate = await runBadgeSection(empty);
    assert.ok(emptyGate.failed > 0 && !/crashed/.test(emptyGate.text), emptyGate.text);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('build-badges: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
