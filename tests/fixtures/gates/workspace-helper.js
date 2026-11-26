'use strict';
/**
 * Test helper for the gate tests (continuity, validate-workspace, hooks).
 *
 * tests/fixtures/gates/clean/ is a small workspace that passes every
 * mechanical gate. makeWorkspace() copies it into a temp directory, adds the
 * placeholder images the YAML refers to, and returns handles to break one
 * thing at a time. Nothing here touches examples/ or schemas/.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('../../../scripts/lib/yaml');

const CLEAN = path.join(__dirname, 'clean');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** A 1x1 PNG. The gates only check that a file exists. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

/** Images the clean fixture's YAML names (workspace-relative). */
const PLACEHOLDERS = [
  'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png',
  'issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V01.png',
  'issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V02.png',
  'references/style/LOOK_NOIR_INK_MASTER_V01.png',
  'characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png',
  'characters/CHAR_OSKAR/refs/CHAR_OSKAR_TURN_MASTER_V01.png',
  'locations/LOC_FERRY_DECK/refs/LOC_FERRY_DECK_PLATE_MASTER_V01.png',
  'props/PROP_FLARE_GUN/refs/PROP_FLARE_GUN_DETAIL_V01.png',
];

const PAGE_1 = 'issues/ISS_001/pages/PG_001_001/page.yaml';
const PAGE_2 = 'issues/ISS_001/pages/PG_001_002/page.yaml';

const created = [];

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

/** A fresh empty temp directory, removed by cleanupAll(). */
function tempDir(prefix = 'comics-gates-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * Copy the clean fixture into <temp>/<name>/ and return handles on it.
 * @param {string} [name]  workspace directory name (default "production")
 */
function makeWorkspace(name = 'production') {
  const base = tempDir();
  const root = path.join(base, name);
  copyDir(CLEAN, root);
  const abs = (rel) => path.join(root, ...rel.split('/'));

  // Every file changed through the handles is remembered, so restore() can
  // put the workspace back without copying the whole fixture again.
  const originals = new Map(); // rel -> Buffer, or null when the file did not exist
  const createdDirs = new Set(); // topmost directories that a write had to create
  const remember = (rel) => {
    if (originals.has(rel)) return;
    const file = abs(rel);
    if (fs.existsSync(file)) {
      originals.set(rel, fs.readFileSync(file));
      return;
    }
    originals.set(rel, null);
    let dir = path.dirname(file);
    let topmost = null;
    while (!fs.existsSync(dir)) {
      topmost = dir;
      dir = path.dirname(dir);
    }
    if (topmost) createdDirs.add(topmost);
  };
  const put = (rel, content) => {
    remember(rel);
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), content);
  };

  const w = {
    base,
    root,
    abs,
    exists: (rel) => fs.existsSync(abs(rel)),
    read: (rel) => yaml.parse(fs.readFileSync(abs(rel), 'utf8')),
    write: (rel, doc) => put(rel, yaml.stringify(doc)),
    writeText: (rel, text) => put(rel, text),
    /** Parse, let fn mutate (or return a replacement), write back. */
    edit(rel, fn) {
      const doc = w.read(rel);
      const out = fn(doc);
      w.write(rel, out === undefined ? doc : out);
    },
    /** Delete one file. */
    remove(rel) {
      remember(rel);
      fs.rmSync(abs(rel), { force: true });
    },
    touch: (rel) => put(rel, PNG),
    /** Undo every change made through these handles since the last restore(). */
    restore() {
      for (const [rel, content] of originals) {
        if (content === null) {
          fs.rmSync(abs(rel), { force: true });
        } else {
          fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
          fs.writeFileSync(abs(rel), content);
        }
      }
      for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
      originals.clear();
      createdDirs.clear();
    },
  };
  for (const rel of PLACEHOLDERS) w.touch(rel);
  originals.clear(); // the placeholders are part of the baseline
  createdDirs.clear();
  return w;
}

/**
 * One shared workspace, restored after each use. Copying the fixture per case
 * is slow on a busy disk; this copies it once per test file.
 * Returns run(mutate, check): mutate(w) breaks it, check(w) returns a result.
 */
function sharedWorkspace(name) {
  let w = null;
  return function withWorkspace(mutate, check) {
    if (!w) w = makeWorkspace(name);
    try {
      if (mutate) mutate(w);
      return check(w);
    } finally {
      w.restore();
    }
  };
}

/** Cast row of a character in a panel (panelIndex is 0-based file order). */
function castRow(page, panelIndex, characterId) {
  return page.panels[panelIndex].cast.find((row) => row.character === characterId);
}

function cleanupAll() {
  for (const dir of created.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      // a leftover temp dir is not a test failure
    }
  }
}

/**
 * Minimal test runner: run named cases, print failures, set the exit code.
 * Usage: const t = createRunner('name'); t.test('does x', () => {...}); t.finish();
 */
function createRunner(title) {
  const failures = [];
  let count = 0;
  return {
    test(name, fn) {
      count++;
      try {
        fn();
      } catch (err) {
        failures.push({ name, err });
      }
    },
    finish() {
      cleanupAll();
      if (failures.length) {
        for (const f of failures) {
          console.error(`not ok - ${f.name}`);
          console.error(String(f.err && f.err.stack ? f.err.stack : f.err).split('\n').map((l) => `    ${l}`).join('\n'));
        }
        console.error(`${title}: ${failures.length} of ${count} case(s) failed`);
        process.exitCode = 1;
      } else {
        console.log(`${title}: ${count} case(s) passed`);
      }
    },
  };
}

module.exports = {
  CLEAN,
  REPO_ROOT,
  PNG,
  PLACEHOLDERS,
  PAGE_1,
  PAGE_2,
  tempDir,
  makeWorkspace,
  sharedWorkspace,
  castRow,
  cleanupAll,
  createRunner,
};
