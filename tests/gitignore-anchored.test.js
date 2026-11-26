'use strict';
/**
 * The workspace ignore rules must be anchored to the repository root.
 * An unanchored "production*" pattern also ignores scaffold directories such
 * as skills/production-orchestration/, which then never reach a clone.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadManifests } = require('../scripts/lib/manifest');

const ROOT = path.resolve(__dirname, '..');
const lines = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

// Every ignore pattern that names a directory is either root-anchored or one
// of the well-known tool directories that are ignored at any depth.
const ANY_DEPTH = new Set(['node_modules/', '.playwright-mcp/']);
for (const line of lines) {
  if (!line.endsWith('/') || line.startsWith('!')) continue;
  assert.ok(line.startsWith('/') || ANY_DEPTH.has(line),
    `.gitignore: directory pattern "${line}" must start with "/" so it only matches at the repository root`);
}

/** Minimal matcher for the patterns this repo uses: root-anchored directory globs. */
function ignoredByRootPattern(rel) {
  const first = rel.split('/')[0];
  for (const line of lines) {
    if (!line.startsWith('/') || !line.endsWith('/')) continue;
    const pattern = line.slice(1, -1);
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
    if (re.test(first)) return line;
  }
  return null;
}

// No file a manifest points at may sit under an ignored directory, at any depth.
const { manifests } = loadManifests(ROOT);
const files = [];
for (const [name, key] of [['agents.json', 'agents'], ['commands.json', 'commands'],
  ['skills.json', 'skills'], ['image-providers.json', 'providers']]) {
  for (const entry of (manifests[name] && manifests[name][key]) || []) files.push(entry.file);
}
assert.ok(files.length > 50, `expected manifest file entries, got ${files.length}`);
for (const file of files) {
  const hit = ignoredByRootPattern(file);
  assert.strictEqual(hit, null, `${file} is ignored by .gitignore pattern "${hit}"`);
  for (const segment of file.split('/').slice(0, -1)) {
    for (const line of lines) {
      if (line.startsWith('/') || line.startsWith('!') || !line.endsWith('/')) continue;
      assert.notStrictEqual(segment + '/', line, `${file}: directory "${segment}" matches ignore pattern "${line}"`);
    }
  }
}

console.log('gitignore-anchored: OK');
