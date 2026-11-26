'use strict';
/** Load all scaffold manifests and parse the rosters from docs/conventions.md. */

const path = require('path');
const fs = require('fs');
const { ROOT, readJson, readText } = require('./fsx');

const MANIFEST_FILES = [
  'profiles.json',
  'agents.json',
  'commands.json',
  'skills.json',
  'rules.json',
  'image-providers.json',
  'harnesses.json',
];

/** Provider kinds the scaffold ships. Each has manifests/<kind>-providers.json. */
const PROVIDER_KINDS = ['image'];

/**
 * Load every manifest from <root>/manifests.
 * Returns { manifests: {basename: parsed|null}, errors: [{file, message}] }.
 */
function loadManifests(root = ROOT) {
  const dir = path.join(root, 'manifests');
  const manifests = {};
  const errors = [];
  for (const name of MANIFEST_FILES) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      manifests[name] = null;
      errors.push({ file: name, message: 'missing' });
      continue;
    }
    try {
      manifests[name] = readJson(file);
    } catch (err) {
      manifests[name] = null;
      errors.push({ file: name, message: `invalid JSON: ${err.message}` });
    }
  }
  return { manifests, errors };
}

/** Convenience accessors on a loadManifests() result. */
function entries(manifests, name, key) {
  const m = manifests[name];
  if (!m || !Array.isArray(m[key])) return [];
  return m[key];
}

/** Layers of rules.json as [{ name, kind, rules: [] }]; [] when absent. */
function ruleLayers(manifests) {
  const m = manifests['rules.json'];
  if (!m || !Array.isArray(m.layers)) return [];
  return m.layers.map((l) => ({
    name: l.name,
    kind: l.kind,
    rules: Array.isArray(l.rules) ? l.rules : [],
  }));
}

function extractList(md, label) {
  // Matches e.g. "**Agents (16):** a, b,\nc, d." — list ends at the first period.
  const re = new RegExp(`\\*\\*${label} \\((\\d+)\\):\\*\\*([^.]*)\\.`);
  const m = md.match(re);
  if (!m) return null;
  const names = m[2]
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { count: parseInt(m[1], 10), names };
}

/**
 * File-name rosters ("**Scripts (13):** install.js, doctor.js, ...") cannot
 * stop at the first period, so they read the whole paragraph and keep the
 * tokens that carry the given extension.
 */
function extractFileList(md, label, extension) {
  const re = new RegExp(`\\*\\*${label} \\((\\d+)\\):\\*\\*([\\s\\S]*?)(?:\\n\\s*\\n|$)`);
  const m = md.match(re);
  if (!m) return null;
  const ext = extension.replace(/\./g, '\\.');
  const names = m[2].match(new RegExp(`(?<![\\w/-])[a-z0-9][a-z0-9-]*${ext}(?![a-z0-9])`, 'g')) || [];
  return { count: parseInt(m[1], 10), names };
}

/**
 * Rules roster: the block after "**Rules (35):**", one line per layer:
 *   `common/`: source-of-truth, project-structure.
 *   `paged/` (format layer): page-turn-grammar, print-specs.
 * Kind is "common" for common/, "format" when the line says so, else "domain".
 */
function extractRules(md) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => /^\*\*Rules \((\d+)\):\*\*\s*$/.test(l.trim()));
  if (start === -1) return null;
  const count = parseInt(lines[start].match(/\((\d+)\)/)[1], 10);
  const layers = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].trim().match(/^`([a-z0-9-]+)\/`\s*(?:\(([^)]*)\))?\s*:\s*(.*)$/);
    if (!m) break;
    const rules = m[3].replace(/\.\s*$/, '').split(',').map((s) => s.trim()).filter(Boolean);
    const kind = m[1] === 'common' ? 'common' : (/format/i.test(m[2] || '') ? 'format' : 'domain');
    layers.push({ name: m[1], kind, rules });
  }
  return { count, layers };
}

/**
 * Parse rosters from docs/conventions.md.
 * Returns {
 *   agents, commands, skills,            name lists
 *   providers: { image: [] },
 *   rules: [{ name, kind, rules: [] }],  same shape as rules.json layers
 *   contexts, schemas, profiles,         name lists
 *   manifests, scripts, hooks,           file-name lists
 *   counts: { agents, commands, skills, providers, rules, contexts, schemas,
 *             manifests, scripts, hooks, profiles }   the declared (N) values
 * }
 * Throws when the file is missing.
 */
function parseConventionsRosters(root = ROOT) {
  const file = path.join(root, 'docs', 'conventions.md');
  const md = readText(file).replace(/\r\n/g, '\n');
  const agents = extractList(md, 'Agents');
  const commands = extractList(md, 'Commands');
  const skills = extractList(md, 'Skills');
  const contexts = extractList(md, 'Contexts');
  const schemas = extractList(md, 'Schemas');
  const profiles = extractList(md, 'Profiles');
  const manifests = extractFileList(md, 'Manifests', '.json');
  const scripts = extractFileList(md, 'Scripts', '.js');
  const hooks = extractFileList(md, 'Hooks', '.js');
  const rules = extractRules(md);

  // Providers line: "**Providers (6):** image: fal, replicate, ... manual."
  // Several kinds, if ever listed, are separated by "·".
  const provMatch = md.match(/\*\*Providers \((\d+)\):\*\*([^.]*)\./);
  const providers = {};
  for (const kind of PROVIDER_KINDS) providers[kind] = [];
  let providerCount = 0;
  if (provMatch) {
    providerCount = parseInt(provMatch[1], 10);
    for (const part of provMatch[2].split('·')) {
      const seg = part.trim();
      const idx = seg.indexOf(':');
      if (idx === -1) continue;
      const kind = seg.slice(0, idx).trim();
      const names = seg.slice(idx + 1).split(',').map((s) => s.trim()).filter(Boolean);
      if (providers[kind]) providers[kind] = names;
    }
  }

  const names = (list) => (list ? list.names : []);
  const count = (list) => (list ? list.count : 0);
  return {
    agents: names(agents),
    commands: names(commands),
    skills: names(skills),
    providers,
    rules: rules ? rules.layers : [],
    contexts: names(contexts),
    schemas: names(schemas),
    profiles: names(profiles),
    manifests: names(manifests),
    scripts: names(scripts),
    hooks: names(hooks),
    counts: {
      agents: count(agents),
      commands: count(commands),
      skills: count(skills),
      providers: providerCount,
      rules: rules ? rules.count : 0,
      contexts: count(contexts),
      schemas: count(schemas),
      profiles: count(profiles),
      manifests: count(manifests),
      scripts: count(scripts),
      hooks: count(hooks),
    },
  };
}

module.exports = {
  MANIFEST_FILES,
  PROVIDER_KINDS,
  loadManifests,
  entries,
  ruleLayers,
  parseConventionsRosters,
};
