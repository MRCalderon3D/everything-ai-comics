#!/usr/bin/env node
'use strict';
/**
 * doctor.js — diagnose the scaffold (and optionally an installed target).
 *
 * Checks: Node version, repo integrity (manifests vs disk), harness wrapper
 * freshness, image provider env vars (reports SET/missing by NAME only;
 * values are never printed), the codex binary the codex-cli provider runs
 * (found or not, and its version; never a failure), and with --target: install-manifest plus every
 * workspace found there (layout, comic_format and its rule layer, default
 * image provider).
 */

const path = require('path');
const fs = require('fs');
const { ROOT, exists, readJson } = require('./lib/fsx');
const { loadManifests, entries, ruleLayers, MANIFEST_FILES, PROVIDER_KINDS } = require('./lib/manifest');
const { createReport } = require('./lib/report');
const { parseArgs, helpIfRequested } = require('./lib/cli');
const workspace = require('./lib/workspace');
const { resolveBinary, binaryVersion } = require('../providers/lib/cli-spawn');

const HELP = `
doctor.js — diagnose the scaffold and provider environment.

Usage:
  node scripts/doctor.js [--target <dir>]

Options:
  --target <dir>  Also check an installed comic project (install-manifest.json
                  and its production/ workspaces).
  --help          Show this help.

Provider env vars: FAL_KEY, REPLICATE_API_TOKEN, COMFYUI_HOST, GOOGLE_API_KEY.
Their values are NEVER printed, only whether each is set.

The codex-cli provider needs the codex binary instead of a key. The doctor
says whether it is found (on PATH, or at CODEX_BIN) and prints its version;
a missing binary is reported, not counted as a failure. Its optional
settings are CODEX_BIN, CODEX_IMAGE_TIMEOUT_MS and CODEX_IMAGE_MODEL.
`;

const COMIC_FORMATS = ['paged', 'webtoon'];
const WORKSPACE_DIRS = ['story', 'style', 'characters', 'locations', 'props',
  'references', 'issues', 'generations', 'continuity', 'editions'];

function checkNode(report) {
  report.section('Runtime');
  const major = parseInt(process.versions.node.split('.')[0], 10);
  report.check(major >= 18, `Node ${process.versions.node} (require >= 18)`);
  report.check(typeof fetch === 'function', 'global fetch available (needed for live generation)');
}

function checkRepo(report) {
  report.section('Repo integrity (manifests vs disk)');
  const { manifests, errors } = loadManifests(ROOT);
  for (const err of errors) report.fail(`manifests/${err.file}: ${err.message}`);
  if (!errors.length) report.pass(`all ${MANIFEST_FILES.length} manifests parse`);
  const lists = [
    ['agents.json', 'agents'], ['commands.json', 'commands'], ['skills.json', 'skills'],
    ...PROVIDER_KINDS.map((kind) => [`${kind}-providers.json`, 'providers']),
  ];
  let missing = 0;
  let total = 0;
  const need = (rel, source) => {
    total++;
    if (!exists(path.join(ROOT, ...String(rel).split('/')))) {
      missing++;
      report.fail(`${rel} missing (listed in ${source})`);
    }
  };
  for (const [file, key] of lists) {
    for (const entry of entries(manifests, file, key)) need(entry.file, file);
  }
  for (const layer of ruleLayers(manifests)) {
    for (const name of layer.rules) need(`rules/${layer.name}/${name}.md`, 'rules.json');
  }
  if (!missing) report.pass(`all ${total} manifest-listed files exist`);
  return manifests;
}

function checkHarnesses(report) {
  report.section('Harness wrapper freshness');
  let sync;
  try {
    sync = require('./sync-harnesses');
  } catch (err) {
    report.fail(`cannot load sync-harnesses.js: ${err.message}`);
    return;
  }
  try {
    const plan = sync.buildPlan(ROOT);
    if (!Object.keys(plan).length) {
      report.warn('nothing to generate yet (source layers or harnesses.json missing)');
      return;
    }
    const drift = sync.diffPlan(ROOT, plan);
    report.check(drift.length === 0,
      drift.length === 0 ? `${Object.keys(plan).length} generated files up to date`
        : `${drift.length} wrapper file(s) stale — run "npm run sync:harnesses"`);
  } catch (err) {
    report.fail(`drift check failed: ${err.message}`);
  }
}

function checkEnv(report, manifests) {
  report.section('Provider environment (names only, values never shown)');
  const files = PROVIDER_KINDS.map((kind) => `${kind}-providers.json`);
  // Capability staleness: provider limits change between model releases.
  // Manifests may carry a snapshot_date; past 30 days, verify against the
  // providers' current docs before trusting reference or aspect-ratio limits.
  for (const file of files) {
    const snap = manifests[file] && manifests[file].snapshot_date;
    if (!snap) continue;
    const ageDays = Math.floor((Date.now() - Date.parse(snap)) / 86400000);
    if (Number.isFinite(ageDays) && ageDays > 30) {
      report.warn(`${file}: capabilities snapshot is ${ageDays} days old (${snap}) — verify limits against current provider docs`);
    }
  }
  const seen = new Map(); // env var -> [provider ids]
  const keyless = [];
  for (const file of files) {
    for (const p of entries(manifests, file, 'providers')) {
      if (!(p.env || []).length) keyless.push(p.id);
      for (const name of p.env || []) {
        if (!seen.has(name)) seen.set(name, []);
        seen.get(name).push(`${p.id} (${file.split('-')[0]})`);
      }
    }
  }
  if (!seen.size && !keyless.length) {
    report.warn('no providers declared (provider manifest missing?)');
    return;
  }
  for (const [name, users] of [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (process.env[name]) report.pass(`${name} is set — enables ${users.join(', ')}`);
    else report.info(`${name} NOT set — ${users.join(', ')} limited to dry-run`);
  }
  if (keyless.length) report.info(`no env var needed: ${keyless.join(', ')}`);
}

/**
 * The codex-cli provider draws through the Codex command-line tool. Report
 * whether the binary is there and which version it is. A missing binary is
 * information, never a failure: every other provider works without it.
 */
function checkCliTools(report, manifests) {
  const ids = entries(manifests, 'image-providers.json', 'providers').map((p) => p.id);
  if (!ids.includes('codex-cli')) return;
  report.section('Command-line tools (provider codex-cli)');
  const bin = resolveBinary('codex', 'CODEX_BIN');
  if (!bin.found) {
    report.info(`codex not found (${bin.error}): codex-cli is limited to dry-run. Install the Codex CLI or set CODEX_BIN.`);
  } else {
    const where = `${bin.source === 'env' ? 'CODEX_BIN' : 'PATH'}: ${bin.path}`;
    const version = binaryVersion(bin);
    if (version.ok) report.pass(`codex found (${where}), version: ${version.version || 'not printed'}`);
    else report.info(`codex found (${where}) but "--version" did not answer: ${version.error}`);
  }
  const timeout = process.env.CODEX_IMAGE_TIMEOUT_MS;
  if (timeout !== undefined) {
    const ok = /^\d+$/.test(timeout) && Number(timeout) > 0;
    report.info(ok ? `CODEX_IMAGE_TIMEOUT_MS is ${timeout} ms per image`
      : `CODEX_IMAGE_TIMEOUT_MS is "${timeout}", not a positive number of milliseconds: the default of 900000 applies`);
  }
  if (process.env.CODEX_IMAGE_MODEL) report.info(`CODEX_IMAGE_MODEL is set: Codex sessions run with -m ${process.env.CODEX_IMAGE_MODEL}`);
}

/** Workspace roots inside a target: every child directory holding project.yaml. */
function findWorkspaces(targetDir) {
  const roots = [];
  for (const d of fs.readdirSync(targetDir)) {
    const full = path.join(targetDir, d);
    try {
      if (fs.statSync(full).isDirectory() && exists(path.join(full, 'project.yaml'))) roots.push(full);
    } catch (err) { /* unreadable entry: skip */ }
  }
  return roots.sort();
}

function checkWorkspace(report, prod, manifests) {
  const name = path.basename(prod);
  let project = null;
  try {
    project = workspace.loadProject(prod);
  } catch (err) {
    report.fail(`${name}/project.yaml does not parse: ${err.message}`);
  }
  if (project && typeof project === 'object') {
    report.pass(`${name}/project.yaml parses ("${project.title || 'untitled'}")`);
    const format = project.comic_format;
    report.check(COMIC_FORMATS.includes(format),
      COMIC_FORMATS.includes(format)
        ? `${name}: comic_format "${format}" — loads rules/${format}/, never rules/${COMIC_FORMATS.find((f) => f !== format)}/`
        : `${name}: comic_format is "${format}" (expected paged or webtoon)`);
    const image = project.default_providers && project.default_providers.image;
    const known = entries(manifests, 'image-providers.json', 'providers').map((p) => p.id);
    if (known.length) {
      report.check(known.includes(image),
        known.includes(image) ? `${name}: default image provider "${image}" is in the roster`
          : `${name}: default image provider "${image}" is not one of ${known.join(', ')}`);
    }
    const lettering = project.lettering && project.lettering.mode;
    if (lettering) report.info(`${name}: lettering mode ${lettering}`);
  }
  for (const dir of WORKSPACE_DIRS) {
    report.check(exists(path.join(prod, dir)), `${name}/${dir}/ exists`);
  }
  const issues = workspace.listIssues(prod);
  report.info(`${name}: ${issues.length} issue(s)${issues.length ? ` (${issues.join(', ')})` : ''}`);
}

function checkTarget(report, targetDir, manifests) {
  report.section(`Target project: ${targetDir}`);
  if (!exists(targetDir)) {
    report.fail('target directory does not exist');
    return;
  }
  const manifestFile = path.join(targetDir, 'install-manifest.json');
  if (!exists(manifestFile)) {
    report.fail('install-manifest.json missing — run scripts/install.js --target <dir>');
  } else {
    try {
      const im = readJson(manifestFile);
      report.pass(`installed ${im.installedAt} — harness(es) ${(im.harnesses || []).join(', ')}, profile "${im.profile}"`);
      let missing = 0;
      for (const rel of im.files || []) {
        if (!exists(path.join(targetDir, ...rel.split('/')))) {
          missing++;
          if (missing <= 5) report.fail(`installed file missing: ${rel}`);
        }
      }
      if (missing > 5) report.fail(`... and ${missing - 5} more missing files`);
      if (!missing) report.pass(`all ${(im.files || []).length} installed files present`);
    } catch (err) {
      report.fail(`install-manifest.json unreadable: ${err.message}`);
    }
  }
  // Workspace roots: production/ plus any sibling directory holding a
  // project.yaml (parallel productions in one project).
  const roots = findWorkspaces(targetDir);
  if (!roots.length) {
    report.info('no workspace found (no directory with project.yaml) — run scripts/create-project.js');
    return;
  }
  for (const prod of roots) checkWorkspace(report, prod, manifests);
}

function main() {
  helpIfRequested(process.argv.slice(2), HELP);
  const { flags } = parseArgs();
  const report = createReport();
  checkNode(report);
  const manifests = checkRepo(report);
  checkHarnesses(report);
  checkEnv(report, manifests);
  checkCliTools(report, manifests);
  if (flags.target && flags.target !== true) {
    checkTarget(report, path.resolve(String(flags.target)), manifests);
  }
  process.exit(report.finish());
}

module.exports = { findWorkspaces, WORKSPACE_DIRS };

if (require.main === module) main();
