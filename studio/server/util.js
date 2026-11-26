'use strict';
/**
 * Small helpers shared by the studio server. Zero dependencies.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** The scaffold root: two levels up from studio/server/. */
const SCAFFOLD_ROOT = path.resolve(__dirname, '..', '..');
const STUDIO_ROOT = path.resolve(__dirname, '..');

/** An error the HTTP layer turns into a JSON error body with this status. */
class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

let counter = 0;
/** Sortable unique id: <prefix>_<utc timestamp>_<4 hex>. */
function newId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
  counter = (counter + 1) % 1296;
  return `${prefix}_${stamp}${counter.toString(36).padStart(2, '0')}_${crypto.randomBytes(2).toString('hex')}`;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

/** Write JSON through a temporary file so a crash never leaves half a file. */
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows can refuse a rename over a file another handle has open.
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      // A torn last line after a crash is dropped, the rest is kept.
    }
  }
  return out;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (err) {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (err) {
    return false;
  }
}

function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

/** Lowercase folder-friendly slug (accents folded). */
function slug(text, fallback = 'untitled') {
  return String(text || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || fallback;
}

/** Upper-case ID token: "Marta la Brava" -> "MARTA_LA_BRAVA". */
function idToken(text, fallback = 'UNNAMED') {
  const token = String(text || '').toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32).replace(/_+$/, '');
  if (!token) return fallback;
  return /^[A-Z]/.test(token) ? token : `X_${token}`;
}

/**
 * Snapshot of the files under a directory: Map of posix relative path ->
 * "size:mtimeMs". Skips .git and the listed top-level names.
 */
function snapshot(dir, skipTop = ['.git', '.studio']) {
  const out = new Map();
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      if (!rel && skipTop.includes(entry.name)) continue;
      if (entry.name === '.git') continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) stack.push(childRel);
      else if (entry.isFile()) {
        try {
          const st = fs.statSync(path.join(dir, childRel));
          out.set(childRel, `${st.size}:${Math.round(st.mtimeMs)}`);
        } catch (err) {
          // vanished between readdir and stat
        }
      }
    }
  }
  return out;
}

/** Difference between two snapshots: [{ path, change }], sorted by path. */
function diffSnapshots(before, after) {
  const out = [];
  for (const [file, sig] of after) {
    if (!before.has(file)) out.push({ path: file, change: 'added' });
    else if (before.get(file) !== sig) out.push({ path: file, change: 'modified' });
  }
  for (const file of before.keys()) {
    if (!after.has(file)) out.push({ path: file, change: 'deleted' });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError() {
  const err = new Error('cancelled');
  err.code = 'cancelled';
  return err;
}

/** Rewrite a top-level "key: value" line of a YAML text, keeping a trailing comment. Null when the key has no line. */
function setTopLevelLine(text, key, rendered) {
  const re = new RegExp(`^(${key}:[^\\n#]*)(#.*)?$`, 'm');
  if (!re.test(text)) return null;
  return text.replace(re, (m, head, comment) => {
    const line = `${key}: ${rendered}`;
    return comment ? line.padEnd(Math.max(head.length, line.length + 1)) + comment : line;
  });
}

module.exports = {
  SCAFFOLD_ROOT,
  STUDIO_ROOT,
  HttpError,
  nowIso,
  today,
  newId,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  readJsonl,
  isFile,
  isDir,
  toPosix,
  slug,
  idToken,
  snapshot,
  diffSnapshots,
  sleep,
  abortError,
  setTopLevelLine,
};
