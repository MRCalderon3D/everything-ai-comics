'use strict';
/**
 * Test helper for the prompt-pipeline tests (reference plan, prompt
 * compiler, generation). The fixture workspace under ./workspace holds text
 * files only; each test works on a throwaway copy in the OS temp directory,
 * where this helper drops placeholder PNGs for the registered reference
 * assets and the page renders. Nothing is ever written into the repository.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('../../../scripts/lib/yaml');

const FIXTURE = path.join(__dirname, 'workspace');

/** A valid 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64');

const PAGE_1 = 'PG_001_001';
const PAGE_2 = 'PG_001_002';

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

function abs(root, rel) {
  return path.join(root, ...String(rel).split('/'));
}

function pageDir(root, pageId) {
  return abs(root, `issues/ISS_001/pages/${pageId}`);
}

function pageFile(root, pageId) {
  return path.join(pageDir(root, pageId), 'page.yaml');
}

function writePng(root, rel) {
  const file = abs(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG);
  return file;
}

function readYaml(root, rel) {
  return yaml.parse(fs.readFileSync(abs(root, rel), 'utf8'));
}

function writeYaml(root, rel, doc) {
  const file = abs(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.stringify(doc));
}

/** Load a YAML file, let `mutate` change it, write it back. */
function editYaml(root, rel, mutate) {
  const doc = readYaml(root, rel);
  const next = mutate(doc);
  writeYaml(root, rel, next === undefined ? doc : next);
}

/**
 * A fresh copy of the fixture workspace with placeholder images:
 * every registered reference asset, plus the renders PG_001_001_V01 and
 * PG_001_002_V01 that the fixture pages name as current.
 * @returns {string} absolute workspace root
 */
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eac-prompt-pipeline-'));
  copyTree(FIXTURE, root);
  for (const asset of readYaml(root, 'references/manifest.yaml').assets) writePng(root, asset.path);
  writePng(root, `issues/ISS_001/pages/${PAGE_1}/renders/${PAGE_1}_V01.png`);
  writePng(root, `issues/ISS_001/pages/${PAGE_2}/renders/${PAGE_2}_V01.png`);
  return root;
}

function cleanup(root) {
  if (root && root.startsWith(os.tmpdir())) fs.rmSync(root, { recursive: true, force: true });
}

/** Run fn(root) on a fresh workspace and always remove it afterwards. */
async function withWorkspace(fn) {
  const root = makeWorkspace();
  try {
    return await fn(root);
  } finally {
    cleanup(root);
  }
}

/**
 * Replace global fetch with a counter that fails the call. Returns
 * { calls, restore }. Dry runs and handoff providers must leave calls at 0.
 */
function blockNetwork() {
  const original = global.fetch;
  const state = { calls: 0, restore: () => { global.fetch = original; } };
  global.fetch = async () => {
    state.calls++;
    throw new Error('network access is not allowed in tests');
  };
  return state;
}

module.exports = {
  FIXTURE,
  PNG,
  PAGE_1,
  PAGE_2,
  abs,
  pageDir,
  pageFile,
  writePng,
  readYaml,
  writeYaml,
  editYaml,
  makeWorkspace,
  cleanup,
  withWorkspace,
  blockNetwork,
};
