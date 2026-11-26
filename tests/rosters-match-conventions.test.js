'use strict';
/** The rosters parsed from docs/conventions.md match the manifests exactly. */

const assert = require('assert');
const {
  loadManifests, parseConventionsRosters, ruleLayers, MANIFEST_FILES, PROVIDER_KINDS,
} = require('../scripts/lib/manifest');

const rosters = parseConventionsRosters();
const { manifests, errors } = loadManifests();
assert.deepStrictEqual(errors, [], `manifest load errors: ${JSON.stringify(errors)}`);

function asSortedSet(list) {
  return [...new Set(list)].sort();
}

// counts declared in conventions.md headers
assert.strictEqual(rosters.counts.agents, 16);
assert.strictEqual(rosters.counts.commands, 27);
assert.strictEqual(rosters.counts.skills, 29);
assert.strictEqual(rosters.counts.providers, 7);
assert.strictEqual(rosters.counts.rules, 35);
assert.strictEqual(rosters.agents.length, 16, `parsed ${rosters.agents.length} agent names`);
assert.strictEqual(rosters.commands.length, 27);
assert.ok(rosters.commands.includes('cover'));
assert.strictEqual(rosters.skills.length, 29);

// every roster lists as many names as its header declares
for (const key of ['contexts', 'schemas', 'profiles', 'manifests', 'scripts', 'hooks']) {
  assert.strictEqual(rosters[key].length, rosters.counts[key],
    `${key}: header declares ${rosters.counts[key]}, parsed ${rosters[key].length}`);
  assert.strictEqual(new Set(rosters[key]).size, rosters[key].length, `${key}: duplicate names`);
}
assert.deepStrictEqual(rosters.contexts, ['development', 'preproduction', 'production', 'publishing', 'review']);
assert.deepStrictEqual(rosters.profiles, ['full', 'writing-room', 'layout', 'generation', 'publishing']);
assert.strictEqual(rosters.schemas.length, 19);
assert.ok(rosters.schemas.includes('visual-review') && rosters.schemas.includes('edition'));
assert.ok(rosters.schemas.includes('cover'));
assert.strictEqual(rosters.scripts.length, 14);
assert.ok(rosters.scripts.includes('build-edition.js') && rosters.scripts.includes('letter-pages.js'));
assert.ok(rosters.scripts.includes('approve-asset.js'));
assert.deepStrictEqual(rosters.hooks, ['validate-after-write.js', 'protect-approved-assets.js',
  'detect-continuity-drift.js', 'require-cost-confirmation.js']);
assert.deepStrictEqual(asSortedSet(rosters.manifests), asSortedSet(MANIFEST_FILES),
  'MANIFEST_FILES does not match the conventions manifest roster');

assert.deepStrictEqual(
  asSortedSet(manifests['agents.json'].agents.map((a) => a.name)),
  asSortedSet(rosters.agents),
  'agents.json does not match the conventions roster');

assert.deepStrictEqual(
  asSortedSet(manifests['commands.json'].commands.map((c) => c.name)),
  asSortedSet(rosters.commands),
  'commands.json does not match the conventions roster');

assert.deepStrictEqual(
  asSortedSet(manifests['skills.json'].skills.map((s) => s.name)),
  asSortedSet(rosters.skills),
  'skills.json does not match the conventions roster');

// providers: image only
assert.deepStrictEqual(PROVIDER_KINDS, ['image']);
assert.deepStrictEqual(Object.keys(rosters.providers), ['image']);
assert.strictEqual(rosters.providers.image.length, rosters.counts.providers);
assert.deepStrictEqual(rosters.providers.image,
  ['fal', 'replicate', 'comfyui', 'gemini', 'harness-native', 'codex-cli', 'manual']);
assert.deepStrictEqual(
  asSortedSet(manifests['image-providers.json'].providers.map((p) => p.id)),
  asSortedSet(rosters.providers.image),
  'image-providers.json does not match the conventions roster');

// rules: layers, kinds, and names
const rosterRuleCount = rosters.rules.reduce((n, l) => n + l.rules.length, 0);
assert.strictEqual(rosterRuleCount, 35, `parsed ${rosterRuleCount} rule names`);
assert.deepStrictEqual(rosters.rules.map((l) => l.name),
  ['common', 'writing', 'visual', 'layout', 'lettering', 'image', 'publishing', 'paged', 'webtoon']);
assert.deepStrictEqual(rosters.rules.map((l) => l.kind),
  ['common', 'domain', 'domain', 'domain', 'domain', 'domain', 'domain', 'format', 'format']);
assert.strictEqual(manifests['rules.json'].version, 1);
assert.deepStrictEqual(ruleLayers(manifests), rosters.rules,
  'rules.json does not match the conventions rules roster');
for (const layer of rosters.rules) {
  assert.ok(layer.rules.length > 0, `${layer.name}: no rules parsed`);
  assert.strictEqual(new Set(layer.rules).size, layer.rules.length, `${layer.name}: duplicate rule`);
}

// commands.json agents/skills arrays reference roster names only
for (const c of manifests['commands.json'].commands) {
  for (const a of c.agents) assert.ok(rosters.agents.includes(a), `${c.name}: unknown agent ${a}`);
  for (const s of c.skills) assert.ok(rosters.skills.includes(s), `${c.name}: unknown skill ${s}`);
}

// profiles.json: the roster's profile names, roster members only
assert.deepStrictEqual(asSortedSet(Object.keys(manifests['profiles.json'].profiles)),
  asSortedSet(rosters.profiles), 'profiles.json does not match the conventions roster');
for (const [name, prof] of Object.entries(manifests['profiles.json'].profiles)) {
  for (const c of prof.commands) assert.ok(rosters.commands.includes(c), `${name}: unknown command ${c}`);
  for (const a of prof.agents) assert.ok(rosters.agents.includes(a), `${name}: unknown agent ${a}`);
  for (const s of prof.skills) assert.ok(rosters.skills.includes(s), `${name}: unknown skill ${s}`);
}

console.log('rosters-match-conventions: OK');
