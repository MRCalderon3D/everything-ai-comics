'use strict';
/**
 * Workspace artifact registry: which schema governs which workspace file.
 *
 * One mapping for everyone. validate-workspace.js walks a workspace with it
 * and hooks/validate-after-write.js checks a single written file with it, so
 * the two can never disagree about what a path is. Layout:
 * docs/conventions.md ("production/ workspace layout").
 *
 * Paths are workspace-relative with forward slashes.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('./yaml');

/** Scaffold root = two levels up from scripts/lib/. */
const SCAFFOLD_ROOT = path.resolve(__dirname, '..', '..');
const SCHEMAS_DIR = path.join(SCAFFOLD_ROOT, 'schemas');

const PAGE_DIR = 'issues/[^/]+/pages/[^/]+';
const COVER_DIR = 'issues/[^/]+/cover';

/** Ordered: the first pattern that matches wins. */
const ARTIFACT_PATTERNS = [
  { schema: 'project', pattern: /^project\.ya?ml$/ },
  { schema: 'story-bible', pattern: /^story\/story-bible\.ya?ml$/ },
  { schema: 'series-plan', pattern: /^story\/series-plan\.ya?ml$/ },
  { schema: 'character', pattern: /^characters\/[^/]+\/character\.ya?ml$/ },
  { schema: 'wardrobe', pattern: /^characters\/[^/]+\/wardrobe\.ya?ml$/ },
  { schema: 'location', pattern: /^locations\/[^/]+\/location\.ya?ml$/ },
  { schema: 'location-map', pattern: /^locations\/[^/]+\/map\.ya?ml$/ },
  { schema: 'prop', pattern: /^props\/[^/]+\/prop\.ya?ml$/ },
  { schema: 'issue', pattern: /^issues\/[^/]+\/issue\.ya?ml$/ },
  { schema: 'scene', pattern: /^issues\/[^/]+\/scenes\/[^/]+\.ya?ml$/ },
  { schema: 'page', pattern: new RegExp(`^${PAGE_DIR}/page\\.ya?ml$`) },
  { schema: 'lettering', pattern: new RegExp(`^${PAGE_DIR}/lettering\\.ya?ml$`) },
  { schema: 'reference-plan', pattern: new RegExp(`^${PAGE_DIR}/reference-plan\\.ya?ml$`) },
  { schema: 'visual-review', pattern: new RegExp(`^${PAGE_DIR}/reviews/[^/]+\\.review\\.ya?ml$`) },
  // The cover of an issue is laid out like a page: cover.yaml, prompts/,
  // renders/, reviews/. Its reviews use the visual-review schema.
  { schema: 'cover', pattern: new RegExp(`^${COVER_DIR}/cover\\.ya?ml$`) },
  { schema: 'visual-review', pattern: new RegExp(`^${COVER_DIR}/reviews/[^/]+\\.review\\.ya?ml$`) },
  // Page-scoped packages live under the page; asset-scoped ones sit in a
  // prompts/ directory next to the asset they generate.
  { schema: 'prompt-package', pattern: /(^|\/)prompts\/[^/]+\.ya?ml$/ },
  { schema: 'generation-record', pattern: /^generations\/(?:[^/]+\/)*GEN_[^/]+\.ya?ml$/ },
  { schema: 'continuity-state', pattern: /^continuity\/[^/]+\.final-state\.ya?ml$/ },
  { schema: 'edition', pattern: /^editions\/[^/]+\/edition\.ya?ml$/ },
];

const SCHEMA_NAMES = [...new Set(ARTIFACT_PATTERNS.map((entry) => entry.schema))];

/**
 * Map a workspace-relative path to the schema name that governs it.
 * Returns null for files validation does not know (references/manifest.yaml,
 * style presets, Markdown, images).
 */
function schemaNameFor(relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  for (const entry of ARTIFACT_PATTERNS) {
    if (entry.pattern.test(rel)) return entry.schema;
  }
  return null;
}

/**
 * Load a schema by name from a schemas directory (default: the scaffold's).
 * Returns null when the file is missing or is not valid JSON; callers decide
 * whether that is a warning or silence.
 */
function loadSchema(name, schemasDir) {
  const file = path.join(schemasDir || SCHEMAS_DIR, `${name}.schema.json`);
  try {
    if (!fs.statSync(file).isFile()) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

/**
 * Read and parse a YAML file without throwing.
 * Returns { doc, error, missing }: doc is null when the file is absent or
 * unparseable; error is the parser message; missing is true when no file
 * exists at that path.
 */
function readYaml(file) {
  let text;
  try {
    if (!fs.statSync(file).isFile()) return { doc: null, error: null, missing: true };
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { doc: null, error: null, missing: true };
  }
  try {
    const doc = yaml.parse(text);
    return { doc: doc === undefined ? null : doc, error: null, missing: false };
  } catch (err) {
    return { doc: null, error: err.message, missing: false };
  }
}

module.exports = {
  SCAFFOLD_ROOT,
  SCHEMAS_DIR,
  ARTIFACT_PATTERNS,
  SCHEMA_NAMES,
  schemaNameFor,
  loadSchema,
  readYaml,
};
