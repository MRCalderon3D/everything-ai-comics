'use strict';
/**
 * Shared plumbing for the prompt pipeline (build-reference-plan.js,
 * compile-prompts.js, generate-assets.js): locate the workspace from a
 * page file, hash the inputs a prompt package depends on, and validate an
 * output against its schema when that schema exists.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./fsx');
const ws = require('./workspace');
const schemaLib = require('./schema');
const { hashObject } = require('../../providers/lib/common');

/** An error the CLIs print without a stack trace. `code` names the rule. */
function pipelineError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Resolve a --page argument (page.yaml or its directory) to the workspace.
 * @returns {{root: string, pageFile: string, pageDir: string, page: object, project: object}}
 */
function loadPageContext(pageArg) {
  let pageFile = path.resolve(String(pageArg));
  if (fs.existsSync(pageFile) && fs.statSync(pageFile).isDirectory()) {
    pageFile = path.join(pageFile, 'page.yaml');
  }
  if (!fs.existsSync(pageFile)) throw pipelineError('page_missing', `page file not found: ${pageFile}`);
  const root = ws.findWorkspaceRoot(pageFile);
  if (!root) {
    throw pipelineError('workspace_missing', `no project.yaml above ${pageFile}: a workspace root is the nearest directory that contains project.yaml`);
  }
  const page = ws.loadYaml(pageFile);
  if (!page || typeof page !== 'object' || !page.id) {
    throw pipelineError('page_invalid', `${pageFile} is not a page document (no id)`);
  }
  const project = ws.loadProject(root) || {};
  return { root, pageFile, pageDir: path.dirname(pageFile), page, project };
}

/**
 * Hash of the parts of a page a prompt depends on. `status` and
 * `current_render` change as the page moves through the pipeline without
 * changing what should be drawn, so they stay out of the hash.
 */
function hashPage(page) {
  const copy = Object.assign({}, page);
  delete copy.status;
  delete copy.current_render;
  return hashObject(copy);
}

/** Hash of a reference plan without its creation date. */
function hashPlan(plan) {
  const copy = Object.assign({}, plan || {});
  delete copy.created_at;
  return hashObject(copy);
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/** "2026-11-26" (UTC) from a Date, for created_at fields. */
function dateStamp(now) {
  return (now instanceof Date ? now : new Date()).toISOString().slice(0, 10);
}

/**
 * Validate a document against schemas/<name>.schema.json.
 * A missing or unreadable schema is skipped, never an error: the scaffold's
 * schemas may not be installed next to the scripts.
 * @returns {{skipped: boolean, valid: boolean, errors: string[]}}
 */
function validateDoc(schemaName, doc, repoRoot = ROOT) {
  const file = path.join(repoRoot, 'schemas', `${schemaName}.schema.json`);
  if (!fs.existsSync(file)) return { skipped: true, valid: true, errors: [] };
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { skipped: true, valid: true, errors: [] };
  }
  try {
    const result = schemaLib.validate(schema, doc);
    return {
      skipped: false,
      valid: result.valid,
      errors: (result.errors || []).map((e) => `${e.path}: ${e.message}`),
    };
  } catch (err) {
    return { skipped: true, valid: true, errors: [] };
  }
}

/** Throw a pipeline error when a document violates its schema. */
function assertValid(schemaName, doc, label) {
  const result = validateDoc(schemaName, doc);
  if (!result.valid) {
    throw pipelineError('schema_violation',
      `${label} violates ${schemaName}.schema.json: ${result.errors.slice(0, 8).join('; ')}`);
  }
  return result;
}

module.exports = {
  pipelineError,
  loadPageContext,
  hashPage,
  hashPlan,
  hashText,
  dateStamp,
  validateDoc,
  assertValid,
};
