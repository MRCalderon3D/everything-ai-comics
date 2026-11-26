'use strict';
/**
 * Workspace files as the API serves them: text artifacts with their parsed
 * data and schema findings, images with their size, and URLs ready to use.
 */

const fs = require('fs');
const path = require('path');
const S = require('./scaffold');
const { resolveInside } = require('./security');
const { HttpError, toPosix } = require('./util');

const TEXT_EXT = ['.yaml', '.yml', '.md', '.txt', '.fountain'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp'];
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const imageCache = new Map();

/** URL of a workspace file through the raw endpoint, with a cache-busting version. */
function rawUrl(project, rel, version) {
  const encoded = String(rel).split('/').map(encodeURIComponent).join('/');
  return `/api/projects/${project.id}/raw/${encoded}${version ? `?v=${version}` : ''}`;
}

/**
 * An image of the workspace: { path, url, width, height, bytes, mtime }.
 * Null when the file is missing or is not an image.
 */
function image(project, rel) {
  if (!rel) return null;
  const clean = toPosix(String(rel));
  const file = S.ws.abs(project.root, clean);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    return null;
  }
  if (!stat.isFile()) return null;
  const version = `${stat.size.toString(36)}${Math.round(stat.mtimeMs).toString(36)}`;
  const key = `${file}|${version}`;
  let dims = imageCache.get(key);
  if (!dims) {
    dims = { width: null, height: null };
    try {
      // The header is enough for PNG and usually for JPEG; fall back to the whole file.
      const fd = fs.openSync(file, 'r');
      const head = Buffer.alloc(Math.min(stat.size, 65536));
      fs.readSync(fd, head, 0, head.length, 0);
      fs.closeSync(fd);
      let info;
      try {
        info = S.imageInfo(head);
      } catch (err) {
        info = S.imageInfo(fs.readFileSync(file));
      }
      dims = { width: info.width, height: info.height };
    } catch (err) {
      dims = { width: null, height: null };
    }
    if (imageCache.size > 5000) imageCache.clear();
    imageCache.set(key, dims);
  }
  return {
    path: clean,
    url: rawUrl(project, clean, version),
    width: dims.width,
    height: dims.height,
    bytes: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

function kindOf(rel) {
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  if (ext === '.md') return 'markdown';
  return 'text';
}

function etagOf(stat) {
  return `${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}`;
}

/**
 * A text artifact: its raw text, its parsed data (YAML), the schema that
 * governs it, and what that schema says about it.
 * A missing file comes back with exists: false, so a screen can render an
 * empty state without a second call.
 */
function readDoc(project, rel) {
  const clean = toPosix(String(rel));
  const file = resolveInside(project.root, clean);
  const base = {
    path: clean,
    exists: false,
    kind: kindOf(clean),
    schema: S.artifacts.schemaNameFor(clean),
    text: '',
    data: null,
    parse_error: null,
    findings: [],
    etag: null,
    mtime: null,
    url: rawUrl(project, clean),
  };
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    return base;
  }
  if (!stat.isFile()) return base;
  if (stat.size > MAX_TEXT_BYTES) {
    throw new HttpError(413, 'too_large', `${clean} is too large to open as text.`);
  }
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const doc = Object.assign(base, { exists: true, text, etag: etagOf(stat), mtime: stat.mtime.toISOString() });
  if (doc.kind === 'yaml') {
    try {
      const data = S.yaml.parse(text);
      doc.data = data === undefined ? null : data;
      if (doc.schema && doc.data !== null) doc.findings = S.schemaFindings(doc.schema, doc.data);
    } catch (err) {
      doc.parse_error = { message: err.message, line: err.line || null };
    }
  }
  return doc;
}

/** Throws 400/415 unless `rel` is a text artifact the API may write. */
function checkWritable(project, rel) {
  const clean = toPosix(String(rel || ''));
  const file = resolveInside(project.root, clean);
  const ext = path.extname(clean).toLowerCase();
  if (!TEXT_EXT.includes(ext)) {
    throw new HttpError(415, 'not_text', 'Only YAML, Markdown and text files can be saved this way.');
  }
  if (clean.split('/').some((part) => part.startsWith('.'))) {
    throw new HttpError(400, 'bad_path', 'Hidden files cannot be written.');
  }
  if (/(^|\/)(renders|exports)\//.test(clean) || /^generations\//.test(clean)) {
    throw new HttpError(400, 'bad_path', 'Renders, exports and generation records are written by the pipeline, not by hand.');
  }
  return { clean, file };
}

/**
 * Check a text before it is saved: YAML has to parse. Returns the parsed
 * data and the schema findings.
 * @throws 422 with the line when the YAML does not parse
 */
function checkText(rel, text) {
  const kind = kindOf(rel);
  const schema = S.artifacts.schemaNameFor(rel);
  if (kind !== 'yaml') return { kind, schema: null, data: null, findings: [] };
  let data;
  try {
    data = S.yaml.parse(text);
  } catch (err) {
    throw new HttpError(422, 'yaml_parse', err.message, { line: err.line || null });
  }
  if (data === undefined || data === null) {
    throw new HttpError(422, 'yaml_empty', 'The file is empty. A YAML artifact needs content.', { line: 1 });
  }
  return { kind, schema, data, findings: schema ? S.schemaFindings(schema, data) : [] };
}

/** Files under a workspace directory, one level: [{ name, path, bytes, mtime, url }]. */
function listDir(project, relDir) {
  const dir = resolveInside(project.root, relDir);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  return entries.filter((e) => e.isFile()).map((e) => {
    const rel = `${toPosix(relDir).replace(/\/$/, '')}/${e.name}`;
    const stat = fs.statSync(path.join(dir, e.name));
    return { name: e.name, path: rel, bytes: stat.size, mtime: stat.mtime.toISOString(), url: rawUrl(project, rel) };
  }).sort((a, b) => (a.name < b.name ? -1 : 1));
}

module.exports = { TEXT_EXT, IMAGE_EXT, MAX_TEXT_BYTES, rawUrl, image, readDoc, checkWritable, checkText, listDir, etagOf, kindOf };
