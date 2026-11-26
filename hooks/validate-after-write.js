#!/usr/bin/env node
'use strict';
/**
 * Hook: validate-after-write (event: after a file write/edit).
 * Reads a JSON event from stdin ({file} or a harness tool-use payload).
 * If the file lives in a workspace and is a schema-known artifact (page,
 * scene, issue, review, edition, ...), parse it as YAML and validate it
 * against its schema. The path -> schema mapping is the one
 * validate-workspace.js uses (scripts/lib/artifacts.js).
 * Exit 0 = fine / not our business; exit 2 = validation failed (message on
 * stderr so the harness surfaces it to the agent).
 */

const fs = require('fs');
const {
  readStdinJson, eventFilePath, workspaceRelPath, displayPath, schemaNameFor,
  loadSchema, requireScriptsLib, run,
} = require('./lib');

const MAX_LINES = 10;

async function handle(event) {
  const file = eventFilePath(event || {});
  if (!file) return 0;
  const rel = workspaceRelPath(file);
  if (!rel) return 0; // not inside a workspace
  const schemaName = schemaNameFor(rel);
  if (!schemaName) return 0; // not a schema-known artifact
  const schema = loadSchema(schemaName);
  if (!schema) return 0; // schema not installed; nothing to enforce
  if (!fs.existsSync(file)) return 0;

  let yaml;
  let schemaLib;
  try {
    yaml = requireScriptsLib('yaml');
    schemaLib = requireScriptsLib('schema');
  } catch (err) {
    return 0; // tooling not installed alongside hooks; do not block
  }

  const shown = displayPath(file);
  let doc;
  try {
    doc = yaml.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    process.stderr.write(`validate-after-write: ${shown} is not parseable YAML: ${err.message}\n`);
    return 2;
  }
  const result = schemaLib.validate(schema, doc);
  if (!result.valid) {
    const lines = result.errors.slice(0, MAX_LINES).map((e) => `  ${e.path}: ${e.message}`);
    process.stderr.write(
      `validate-after-write: ${shown} violates schemas/${schemaName}.schema.json:\n` +
      lines.join('\n') +
      (result.errors.length > MAX_LINES ? `\n  ... and ${result.errors.length - MAX_LINES} more` : '') +
      '\nFix the file, then run "npm run validate:workspace" for the cross-file checks.\n'
    );
    return 2;
  }
  return 0;
}

module.exports = { handle };

if (require.main === module) {
  run('validate-after-write', async () => handle(await readStdinJson()));
}
