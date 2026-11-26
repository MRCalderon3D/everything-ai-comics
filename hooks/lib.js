'use strict';
/**
 * Shared helpers for hook handlers.
 * Hooks read one JSON event from stdin, print human messages to stderr,
 * and exit 0 (allow) or 2 (block). They must never crash the harness:
 * unknown events exit 0.
 */

const path = require('path');
const fs = require('fs');

/** Scaffold root: hooks/ lives directly under it (repo or installed target). */
const SCAFFOLD_ROOT = path.dirname(__dirname);

/** Read all of stdin and parse it as JSON. Resolves to {} on empty/bad input. */
function readStdinJson() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      try {
        const event = data.trim() ? JSON.parse(data) : {};
        resolve(event && typeof event === 'object' ? event : {});
      } catch (err) {
        resolve({});
      }
    });
    process.stdin.on('error', () => resolve({}));
  });
}

/**
 * Extract the written file path from the event, across harness dialects.
 * A relative path is resolved against the event's cwd when the harness
 * sends one, else against the process cwd.
 */
function eventFilePath(event) {
  const file = event.file ||
    event.path ||
    event.file_path ||
    (event.tool_input && (event.tool_input.file_path || event.tool_input.path)) ||
    null;
  if (!file || typeof file !== 'string') return null;
  if (path.isAbsolute(file)) return file;
  return path.resolve(typeof event.cwd === 'string' && event.cwd ? event.cwd : process.cwd(), file);
}

/** Extract the shell command from the event, across harness dialects. */
function eventCommand(event) {
  return event.command ||
    (event.tool_input && event.tool_input.command) ||
    null;
}

/**
 * Locate the workspace that contains the given file. Returns the absolute
 * path of the workspace root, or null when the file is not in a workspace.
 */
function findWorkspaceRoot(file) {
  const abs = path.resolve(file);
  // A workspace root is any ancestor directory containing project.yaml.
  // "production" is the default name, not a requirement: parallel
  // productions rename their workspaces (production-night-ferry/).
  let dir = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
  for (let i = 0; i < 32; i++) {
    if (fs.existsSync(path.join(dir, 'project.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: a literal "production" path segment, for a fresh workspace
  // whose project.yaml has not been written yet.
  const parts = abs.split(path.sep);
  const idx = parts.lastIndexOf('production');
  if (idx === -1 || idx === parts.length - 1) return null;
  return parts.slice(0, idx + 1).join(path.sep);
}

/** Path inside the workspace with forward slashes, or null. */
function workspaceRelPath(file) {
  const root = findWorkspaceRoot(file);
  if (!root) return null;
  return path.relative(root, path.resolve(file)).split(path.sep).join('/');
}

/** "production/issues/..." style label for messages, using the real workspace name. */
function displayPath(file) {
  const root = findWorkspaceRoot(file);
  if (!root) return String(file);
  return `${path.basename(root)}/${path.relative(root, path.resolve(file)).split(path.sep).join('/')}`;
}

function requireScriptsLib(name) {
  return require(path.join(SCAFFOLD_ROOT, 'scripts', 'lib', name));
}

/**
 * Map a workspace-relative path to the schema name that governs it, or null.
 * The mapping itself lives in scripts/lib/artifacts.js, shared with
 * validate-workspace.js. Without the tooling installed, nothing is known.
 */
function schemaNameFor(relPath) {
  try {
    return requireScriptsLib('artifacts').schemaNameFor(relPath);
  } catch (err) {
    return null;
  }
}

/** Load a schema by name from the scaffold's schemas/ dir, or null. */
function loadSchema(name) {
  const file = path.join(SCAFFOLD_ROOT, 'schemas', `${name}.schema.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

/** Run a handler: exit with its code, and never block on an internal error. */
function run(name, handler) {
  handler().then((code) => process.exit(code || 0)).catch((err) => {
    process.stderr.write(`${name}: internal error: ${err.message}\n`);
    process.exit(0); // never block on our own bugs
  });
}

module.exports = {
  SCAFFOLD_ROOT,
  readStdinJson,
  eventFilePath,
  eventCommand,
  findWorkspaceRoot,
  workspaceRelPath,
  displayPath,
  schemaNameFor,
  loadSchema,
  requireScriptsLib,
  run,
};
