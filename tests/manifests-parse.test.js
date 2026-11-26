'use strict';
/** All 7 manifests parse and have the contracted shapes and counts. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadManifests, MANIFEST_FILES } = require('../scripts/lib/manifest');

const ROOT = path.resolve(__dirname, '..');

assert.strictEqual(MANIFEST_FILES.length, 7);
const { manifests, errors } = loadManifests();
assert.deepStrictEqual(errors, [], `manifest load errors: ${JSON.stringify(errors)}`);

// The one-line descriptions are authoritative in docs/conventions.md; every
// manifest description must appear there verbatim, as a table cell.
const conventions = fs.readFileSync(path.join(ROOT, 'docs', 'conventions.md'), 'utf8');
const verbatim = (kind, entry) => assert.ok(conventions.includes(`| ${entry.description} |`),
  `${kind} ${entry.name}: description is not verbatim from docs/conventions.md`);

// agents.json
const agents = manifests['agents.json'].agents;
assert.strictEqual(manifests['agents.json'].version, 1);
assert.strictEqual(agents.length, 16, `expected 16 agents, got ${agents.length}`);
for (const a of agents) {
  assert.ok(a.name && a.file && a.description, `agent entry incomplete: ${JSON.stringify(a)}`);
  assert.strictEqual(a.file, `agents/${a.name}.md`);
  verbatim('agent', a);
}
const agentNames = agents.map((a) => a.name);

// commands.json
const commands = manifests['commands.json'].commands;
assert.strictEqual(manifests['commands.json'].version, 1);
assert.strictEqual(commands.length, 27, `expected 27 commands, got ${commands.length}`);
for (const c of commands) {
  assert.ok(c.name && c.file && c.description, `command entry incomplete: ${c.name}`);
  assert.strictEqual(c.file, `commands/${c.name}.md`);
  assert.ok(Array.isArray(c.agents) && c.agents.length > 0, `${c.name}: agents[] required`);
  assert.ok(Array.isArray(c.skills) && c.skills.length > 0, `${c.name}: skills[] required`);
  assert.ok(conventions.includes(`| ${c.name} | ${c.description} | ${c.agents.join(', ')} | ${c.skills.join(', ')} |`),
    `command ${c.name}: row differs from the map in docs/conventions.md`);
}

// spot-check the authoritative map rows
const smartPage = commands.find((c) => c.name === 'smart-page');
assert.deepStrictEqual(smartPage.agents, [
  'art-director', 'layout-artist', 'comic-writer', 'penciller', 'letterer',
  'continuity-editor', 'prompt-director',
]);
assert.deepStrictEqual(smartPage.skills, [
  'scene-blocking', 'page-layout', 'sequential-storytelling', 'comic-scripting',
  'panel-composition', 'performance-direction', 'state-tracking',
  'reference-selection', 'prompt-compilation',
]);
const refPlan = commands.find((c) => c.name === 'reference-plan');
assert.deepStrictEqual(refPlan.agents, ['prompt-director', 'continuity-editor']);
assert.deepStrictEqual(refPlan.skills, ['reference-selection']);
const buildEdition = commands.find((c) => c.name === 'build-edition');
assert.deepStrictEqual(buildEdition.agents, ['prepress-specialist', 'editor-in-chief', 'production-qa']);
assert.deepStrictEqual(buildEdition.skills, ['edition-assembly']);

// skills.json
const skills = manifests['skills.json'].skills;
assert.strictEqual(manifests['skills.json'].version, 1);
assert.strictEqual(skills.length, 29, `expected 29 skills, got ${skills.length}`);
const categories = ['story', 'visual', 'production', 'generation', 'post'];
for (const s of skills) {
  assert.ok(s.name && s.file && s.description, `skill entry incomplete: ${s.name}`);
  assert.strictEqual(s.file, `skills/${s.name}/SKILL.md`);
  assert.ok(categories.includes(s.category), `${s.name}: bad category ${s.category}`);
  assert.ok(conventions.includes(`| ${s.name} | ${s.category} | ${s.description} |`),
    `skill ${s.name}: row differs from the table in docs/conventions.md`);
}
const skillNames = skills.map((s) => s.name);
assert.strictEqual(skills.find((s) => s.name === 'source-analysis').category, 'story');
assert.strictEqual(skills.find((s) => s.name === 'reference-selection').category, 'production');
assert.strictEqual(skills.find((s) => s.name === 'page-repair').category, 'generation');
assert.strictEqual(skills.find((s) => s.name === 'edition-assembly').category, 'post');

// rules.json
const rules = manifests['rules.json'];
assert.strictEqual(rules.version, 1);
assert.ok(Array.isArray(rules.layers) && rules.layers.length === 9, 'rules.json: 9 layers expected');
for (const layer of rules.layers) {
  assert.ok(layer.name && ['common', 'domain', 'format'].includes(layer.kind), `rule layer incomplete: ${layer.name}`);
  assert.ok(Array.isArray(layer.rules) && layer.rules.length > 0, `${layer.name}: rules[] required`);
  for (const r of layer.rules) assert.match(r, /^[a-z][a-z0-9-]*$/, `${layer.name}: bad rule name ${r}`);
}
assert.strictEqual(rules.layers.reduce((n, l) => n + l.rules.length, 0), 35);
assert.deepStrictEqual(rules.layers.filter((l) => l.kind === 'common').map((l) => l.name), ['common']);
assert.deepStrictEqual(rules.layers.filter((l) => l.kind === 'format').map((l) => l.name), ['paged', 'webtoon']);
assert.deepStrictEqual(rules.layers.find((l) => l.name === 'paged').rules, ['page-turn-grammar', 'print-specs']);
assert.deepStrictEqual(rules.layers.find((l) => l.name === 'webtoon').rules, ['scroll-grammar', 'episode-deliverables']);

// image providers (the only provider kind)
const img = manifests['image-providers.json'].providers;
assert.deepStrictEqual(img.map((p) => p.id).sort(),
  ['codex-cli', 'comfyui', 'fal', 'gemini', 'harness-native', 'manual', 'replicate']);
for (const p of img) {
  assert.ok(p.file && typeof p.label === 'string' && Array.isArray(p.env) &&
    p.capabilities && typeof p.capabilities === 'object',
    `provider entry incomplete: ${p.id}`);
  assert.strictEqual(p.file, `providers/image/${p.id}.js`);
}
for (const id of ['harness-native', 'codex-cli', 'manual']) {
  assert.deepStrictEqual(img.find((p) => p.id === id).env, [], `${id} needs no env var`);
}
for (const name of ['audio-providers.json', 'video-providers.json']) {
  assert.ok(!fs.existsSync(path.join(ROOT, 'manifests', name)), `manifests/${name} must not exist`);
}

// profiles
const profiles = manifests['profiles.json'].profiles;
assert.deepStrictEqual(Object.keys(profiles),
  ['full', 'writing-room', 'layout', 'generation', 'publishing']);
assert.deepStrictEqual(profiles.full.commands, commands.map((c) => c.name));
assert.deepStrictEqual(profiles.full.agents, agentNames);
assert.deepStrictEqual(profiles.full.skills, skillNames);
for (const [name, prof] of Object.entries(profiles)) {
  assert.ok(typeof prof.description === 'string' && prof.description, `${name}: description required`);
  for (const key of ['commands', 'agents', 'skills']) {
    assert.ok(Array.isArray(prof[key]) && prof[key].length > 0, `${name}: ${key}[] required`);
    assert.strictEqual(new Set(prof[key]).size, prof[key].length, `${name}: duplicate ${key}`);
  }
  // every agent and skill a profile's commands need ships with the profile
  for (const c of prof.commands) {
    const entry = commands.find((x) => x.name === c);
    assert.ok(entry, `${name}: unknown command ${c}`);
    for (const a of entry.agents) assert.ok(prof.agents.includes(a), `${name}: ${c} needs agent ${a}`);
    for (const s of entry.skills) assert.ok(prof.skills.includes(s), `${name}: ${c} needs skill ${s}`);
  }
}
const has = (profile, c) => profiles[profile].commands.includes(c);
assert.ok(has('writing-room', 'story-bible') && has('writing-room', 'series-plan'));
assert.ok(!has('writing-room', 'page-plan') && !has('writing-room', 'generate-pages'));
assert.ok(has('layout', 'thumbnails') && has('layout', 'panel-ledger') && has('layout', 'smart-page'));
assert.ok(!has('layout', 'generate-pages') && !has('layout', 'visual-development'));
assert.ok(has('generation', 'reference-plan') && has('generation', 'generate-pages'));
assert.ok(has('generation', 'visual-review') && has('generation', 'repair-page'));
assert.ok(!has('generation', 'build-edition'));
assert.ok(has('publishing', 'lettering') && has('publishing', 'continuity-review') && has('publishing', 'build-edition'));
assert.ok(!has('publishing', 'generate-pages'));

// project schema default_providers.image enum must match the provider
// manifest: adding a provider without updating the schema breaks user
// projects. Skipped until the schema layer is written.
const projectSchemaFile = path.join(ROOT, 'schemas', 'project.schema.json');
if (fs.existsSync(projectSchemaFile)) {
  const projectSchema = JSON.parse(fs.readFileSync(projectSchemaFile, 'utf8'));
  const dp = projectSchema.properties && projectSchema.properties.default_providers;
  const image = dp && dp.properties && dp.properties.image;
  if (image && Array.isArray(image.enum)) {
    assert.deepStrictEqual([...image.enum].sort(), img.map((p) => p.id).sort(),
      'project schema image providers enum != image-providers.json');
  }
}

// harnesses
const harnesses = manifests['harnesses.json'].harnesses;
assert.deepStrictEqual(harnesses.map((h) => h.id), ['claude', 'codex', 'cursor', 'opencode', 'agents']);
assert.deepStrictEqual(harnesses.map((h) => h.targetDir), ['.claude', '.codex', '.cursor', '.opencode', '.agents']);
assert.ok(!/film|shot|clip|video|audio/i.test(JSON.stringify(manifests['harnesses.json'])),
  'harnesses.json carries film wording');

console.log('manifests-parse: OK');
