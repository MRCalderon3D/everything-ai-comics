'use strict';
/**
 * History for a project directory: one local git repository per project,
 * one commit per finished step. Every command names the repository
 * explicitly (--git-dir, --work-tree), so a project can never commit into a
 * repository above it, and carries its own identity, so nothing depends on
 * the person's global git configuration.
 */

const { execFile, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const IDENTITY = [
  '-c', 'user.name=Comics Studio',
  '-c', 'user.email=studio@localhost',
  '-c', 'commit.gpgsign=false',
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
  '-c', 'core.quotepath=false',
  '-c', 'gc.auto=0',
];

const GITIGNORE = '# Written by the comics studio. Its own state stays out of the history.\n.studio/\n';

let detected = null;

/** { installed, version }. Cached; pass true to look again. */
function detect(refresh = false) {
  if (detected && !refresh) return detected;
  if (process.env.STUDIO_NO_GIT === '1') {
    detected = { installed: false, version: null };
    return detected;
  }
  try {
    const res = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const m = res.status === 0 ? /git version (\S+)/.exec(res.stdout || '') : null;
    detected = m ? { installed: true, version: m[1] } : { installed: false, version: null };
  } catch (err) {
    detected = { installed: false, version: null };
  }
  return detected;
}

function gitDir(dir) {
  return path.join(dir, '.git');
}

function isRepo(dir) {
  return fs.existsSync(path.join(gitDir(dir), 'HEAD'));
}

/** Run git against the project's own repository. Resolves { code, stdout, stderr }. */
function git(dir, args, options = {}) {
  return new Promise((resolve) => {
    const full = ['--git-dir', gitDir(dir), '--work-tree', dir, ...IDENTITY,
      '-c', `core.hooksPath=${path.join(gitDir(dir), 'studio-no-hooks')}`, ...args];
    execFile('git', full, {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.timeout || 120000,
      windowsHide: true,
      env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }),
    }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

const locks = new Map();

/**
 * Run one writing git operation at a time per project: a save by the person
 * and the commit of a job step can arrive together, and git allows one
 * writer on the index.
 */
function withLock(dir, fn) {
  const previous = locks.get(dir) || Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  locks.set(dir, tail);
  tail.then(() => {
    if (locks.get(dir) === tail) locks.delete(dir);
  });
  return run;
}

/** Create the repository of a project directory. False when git is missing or init fails. */
async function init(dir) {
  if (!detect().installed) return false;
  if (!isRepo(dir)) {
    const res = spawnSync('git', ['init', '-q', '.'], {
      cwd: dir, encoding: 'utf8', timeout: 20000, windowsHide: true,
      env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }),
    });
    if (res.status !== 0 || !isRepo(dir)) return false;
  }
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, GITIGNORE);
  return true;
}

/**
 * Commit everything that changed in the project directory.
 * @returns {Promise<string|null>} the commit id, or null when nothing changed
 *   or the project has no repository
 */
async function commitAll(dir, message) {
  if (!detect().installed || !isRepo(dir)) return null;
  return withLock(dir, () => commitNow(dir, message));
}

async function commitNow(dir, message) {
  const add = await git(dir, ['add', '-A']);
  if (add.code !== 0) return null;
  const before = headFromFiles(dir);
  const text = String(message || 'Change').replace(/\r/g, '').slice(0, 2000);
  // With nothing staged, commit exits non-zero and HEAD stays where it was.
  const commit = await git(dir, ['commit', '-q', '-m', text]);
  if (commit.code !== 0) return null;
  const after = headFromFiles(dir) || await head(dir);
  return after && after !== before ? after : null;
}

/** HEAD read straight from the repository files (no process); null when it cannot be read that way. */
function headFromFiles(dir) {
  try {
    const text = fs.readFileSync(path.join(gitDir(dir), 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(text)) return text;
    const m = /^ref: (refs\/[A-Za-z0-9._/-]+)$/.exec(text);
    if (!m || m[1].includes('..')) return null;
    const id = fs.readFileSync(path.join(gitDir(dir), ...m[1].split('/')), 'utf8').trim();
    return /^[0-9a-f]{40}$/.test(id) ? id : null;
  } catch (err) {
    return null;
  }
}

async function head(dir) {
  if (!isRepo(dir)) return null;
  const res = await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']);
  const id = res.stdout.trim();
  return res.code === 0 && /^[0-9a-f]{40}$/.test(id) ? id : null;
}

/** Commits, newest first: [{ id, at, subject }]. */
async function log(dir, limit = 200) {
  if (!detect().installed || !isRepo(dir)) return [];
  const res = await git(dir, ['log', `-n${Math.max(1, Math.min(2000, limit))}`, '--format=%H%x09%cI%x09%s']);
  if (res.code !== 0) return [];
  return res.stdout.split('\n').filter(Boolean).map((line) => {
    const [id, at, ...rest] = line.split('\t');
    return { id, at, subject: rest.join('\t') };
  });
}

/** Files a commit touched: [{ path, change }]. */
async function filesOf(dir, commit) {
  if (!detect().installed || !isRepo(dir) || !/^[0-9a-f]{7,40}$/.test(String(commit))) return [];
  const res = await git(dir, ['show', '--name-status', '--format=', '--no-renames', commit]);
  if (res.code !== 0) return [];
  const names = { A: 'added', M: 'modified', D: 'deleted' };
  return res.stdout.split('\n').filter(Boolean).map((line) => {
    const [status, ...rest] = line.split('\t');
    return { path: rest.join('\t'), change: names[status[0]] || 'modified' };
  });
}

/**
 * Bring the working tree back to a commit, as a new commit on top of the
 * history. Files added after that commit leave the working tree and stay in
 * git. Unsaved changes are committed first so nothing is lost.
 * @returns {Promise<{commit: string|null, saved: string|null, unchanged: boolean}>}
 */
async function restore(dir, commit) {
  if (!detect().installed) throw Object.assign(new Error('git is not installed, so there is no history to restore from'), { code: 'git_missing' });
  if (!isRepo(dir)) throw Object.assign(new Error('this project has no history yet'), { code: 'no_history' });
  if (!/^[0-9a-f]{7,40}$/.test(String(commit))) throw Object.assign(new Error('not a commit id'), { code: 'bad_commit' });
  const exists = await git(dir, ['cat-file', '-e', `${commit}^{commit}`]);
  if (exists.code !== 0) throw Object.assign(new Error('that point is not in this project\'s history'), { code: 'bad_commit' });
  const full = (await git(dir, ['rev-parse', `${commit}^{commit}`])).stdout.trim();
  const subject = (await git(dir, ['log', '-n1', '--format=%s', full])).stdout.trim();
  return withLock(dir, async () => {
    const saved = await commitNow(dir, 'Unsaved changes before a restore');
    const read = await git(dir, ['read-tree', '--reset', '-u', full]);
    if (read.code !== 0) {
      throw Object.assign(new Error(`could not restore: ${read.stderr.trim().split('\n')[0] || 'git read-tree failed'}`), { code: 'restore_failed' });
    }
    const made = await commitNow(dir, `Restore to ${full.slice(0, 8)}: ${subject}`);
    return { commit: made, saved, unchanged: made === null, target: full, subject };
  });
}

/** The tree every repository has: what a first commit is compared with. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** The full id of a commit of this project, or null. Accepts 7 to 40 hex digits only. */
async function resolveCommit(dir, id) {
  if (!detect().installed || !isRepo(dir) || !/^[0-9a-f]{7,40}$/.test(String(id))) return null;
  const res = await git(dir, ['rev-parse', '--verify', '-q', `${id}^{commit}`]);
  const full = res.stdout.trim();
  return res.code === 0 && /^[0-9a-f]{40}$/.test(full) ? full : null;
}

/** The parent of a commit, or the empty tree for the first commit. */
async function parentOf(dir, commit) {
  const res = await git(dir, ['rev-parse', '--verify', '-q', `${commit}^`]);
  const full = res.stdout.trim();
  return res.code === 0 && /^[0-9a-f]{40}$/.test(full) ? full : EMPTY_TREE;
}

/** Files that differ between two trees: [{ path, status }], paths relative to the project directory. */
async function changedBetween(dir, from, to) {
  const res = await git(dir, ['diff', '--name-status', '--no-renames', '-z', from, to]);
  if (res.code !== 0) return [];
  const parts = res.stdout.split('\0').filter((p) => p !== '');
  const names = { A: 'added', M: 'modified', D: 'deleted', T: 'modified' };
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    out.push({ path: parts[i + 1], status: names[parts[i][0]] || 'modified' });
  }
  return out;
}

/**
 * A file as it was at a commit. Read-only: `git cat-file` and `git show`.
 * @returns {Promise<{buffer: Buffer|null, bytes: number, tooLarge: boolean}|null>} null when the commit has no such file
 */
function fileAt(dir, commit, repoPath, maxBytes = 64 * 1024 * 1024) {
  return new Promise((resolve) => {
    if (!/^[0-9a-f]{40}$/.test(String(commit)) || commit === EMPTY_TREE) {
      resolve(null);
      return;
    }
    const spec = `${commit}:${repoPath}`;
    const base = ['--git-dir', gitDir(dir), '--work-tree', dir];
    const options = { cwd: dir, windowsHide: true, timeout: 60000, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }) };
    execFile('git', [...base, 'cat-file', '-s', spec], Object.assign({ encoding: 'utf8' }, options), (err, stdout) => {
      const bytes = err ? NaN : Number.parseInt(String(stdout).trim(), 10);
      if (!Number.isFinite(bytes)) {
        resolve(null);
        return;
      }
      if (bytes > maxBytes) {
        resolve({ buffer: null, bytes, tooLarge: true });
        return;
      }
      execFile('git', [...base, 'show', spec], Object.assign({ encoding: 'buffer', maxBuffer: maxBytes + 1024 }, options), (err2, out) => {
        resolve(err2 ? null : { buffer: out, bytes, tooLarge: false });
      });
    });
  });
}

module.exports = {
  detect, isRepo, init, commitAll, head, log, filesOf, restore, GITIGNORE,
  EMPTY_TREE, resolveCommit, parentOf, changedBetween, fileAt,
};
