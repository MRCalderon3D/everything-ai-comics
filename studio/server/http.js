'use strict';
/**
 * HTTP plumbing: a small router, body readers with size limits, JSON and
 * file responses (with Range), and static file serving.
 */

const fs = require('fs');
const path = require('path');
const i18n = require('./i18n');
const { HttpError, errorText, isFile } = require('./util');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.fountain': 'text/plain; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.cbz': 'application/vnd.comicbook+zip',
  '.zip': 'application/zip',
  '.epub': 'application/epub+zip',
  '.log': 'text/plain; charset=utf-8',
};

function contentTypeOf(file) {
  return CONTENT_TYPES[path.extname(String(file)).toLowerCase()] || 'application/octet-stream';
}

/** Route table: add(method, '/api/projects/:id/pages/:page', handler). */
class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, options = {}) {
    const names = [];
    // ":name" matches one segment; "*name" matches the rest of the path.
    const source = pattern.split('/').map((part) => {
      if (part.startsWith(':')) {
        names.push(part.slice(1));
        return '([^/]+)';
      }
      if (part.startsWith('*')) {
        names.push(part.slice(1));
        return '(.*)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    this.routes.push({ method, pattern, regex: new RegExp(`^${source}$`), names, handler, options });
  }

  /** @returns {{route, params}|{methodMismatch: true}|null} */
  match(method, pathname) {
    let mismatch = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) {
        mismatch = true;
        continue;
      }
      const params = {};
      try {
        route.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
      } catch (err) {
        throw new HttpError(400, 'bad_request', 'The URL has a malformed escape sequence.');
      }
      return { route, params };
    }
    return mismatch ? { methodMismatch: true } : null;
  }
}

/** Read the request body up to a limit. Rejects with 413 past it. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new HttpError(413, 'too_large', `The request body is larger than the ${limit} byte limit.`));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        chunks.length = 0;
        req.resume();
        reject(new HttpError(413, 'too_large', `The request body is larger than the ${limit} byte limit.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!done) reject(err);
    });
  });
}

/** Read and parse a JSON body. An empty body is an empty object. */
async function readJsonBody(req, limit) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  const body = await readBody(req, limit);
  if (!body.length) return {};
  if (!type.startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Send JSON with Content-Type: application/json.');
  }
  try {
    const value = JSON.parse(body.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return value;
  } catch (err) {
    throw new HttpError(400, 'bad_json', 'The request body is not a JSON object.');
  }
}

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function sendJson(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, Object.assign({}, BASE_HEADERS, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  }, headers));
  res.end(res.req && res.req.method === 'HEAD' ? undefined : body);
}

/**
 * Send an error as { error: { code, message, params, details? } }. The
 * message is the dictionary's sentence for the code, in the language of the
 * request; `params` are the values that went into it.
 */
function sendError(res, err, lang = i18n.DEFAULT_LANG) {
  const status = err && err.status ? err.status : 500;
  const code = (err && err.code && typeof err.code === 'string' && err.status) ? err.code : (status === 500 ? 'internal' : 'error');
  const text = errorText({ code, message: err && err.message ? err.message : 'Unexpected error.', params: err && err.params, text: err && err.text });
  const body = {
    error: {
      code,
      message: i18n.render(lang, text),
      params: i18n.plainParams(lang, text.params),
    },
  };
  if (err && err.details !== undefined) body.error.details = i18n.localize(lang, err.details);
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, status, body);
}

/** "bytes=0-99" -> { start, end } (inclusive), null when absent, false when unsatisfiable. */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (!suffix) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return false;
  return { start, end };
}

/**
 * Stream a file with Last-Modified, ETag, conditional GET, and one byte
 * range. `download` adds a Content-Disposition with the file name.
 */
function sendFile(req, res, file, options = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    throw new HttpError(404, 'not_found', 'File not found.');
  }
  if (!stat.isFile()) throw new HttpError(404, 'not_found', 'File not found.');
  const etag = `"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
  const headers = Object.assign({}, BASE_HEADERS, {
    'Content-Type': options.contentType || contentTypeOf(file),
    'Last-Modified': stat.mtime.toUTCString(),
    ETag: etag,
    'Accept-Ranges': 'bytes',
    'Cache-Control': options.cacheControl || 'no-cache',
  }, options.headers || {});
  if (options.download) {
    const name = path.basename(options.downloadName || file).replace(/[^A-Za-z0-9._-]+/g, '_');
    headers['Content-Disposition'] = `attachment; filename="${name}"`;
  }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const range = parseRange(req.headers.range, stat.size);
  if (range === false) {
    res.writeHead(416, Object.assign(headers, { 'Content-Range': `bytes */${stat.size}` }));
    res.end();
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : stat.size - 1;
  headers['Content-Length'] = stat.size === 0 ? 0 : end - start + 1;
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || stat.size === 0) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/** Extensions that are assets: a missing one is a 404, not the app shell. */
const ASSET_EXT = new Set(['.js', '.mjs', '.css', '.map', '.json', '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.svg', '.ico', '.woff', '.woff2', '.txt']);

/**
 * Serve a static file from webDir. A path that is not a file falls back to
 * index.html (the single-page app routes in the browser), except for asset
 * extensions, which get a 404.
 */
function serveStatic(req, res, webDir, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (err) {
    throw new HttpError(400, 'bad_request', 'The URL has a malformed escape sequence.');
  }
  if (rel.includes('\0')) throw new HttpError(400, 'bad_request', 'Bad path.');
  const parts = rel.split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p.includes('\\') || /^[A-Za-z]:/.test(p))) {
    throw new HttpError(404, 'not_found', 'Not found.');
  }
  const base = path.resolve(webDir);
  let file = path.resolve(base, ...parts);
  if (file !== base && !file.startsWith(base + path.sep)) throw new HttpError(404, 'not_found', 'Not found.');
  if (!parts.length || !isFile(file)) {
    if (parts.length && ASSET_EXT.has(path.extname(file).toLowerCase())) {
      throw new HttpError(404, 'not_found', 'Not found.');
    }
    file = path.join(base, 'index.html');
    if (!isFile(file)) throw new HttpError(404, 'not_found', 'The interface is not installed.');
  }
  sendFile(req, res, file, {
    headers: {
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
    },
  });
}

module.exports = {
  CONTENT_TYPES,
  contentTypeOf,
  Router,
  readBody,
  readJsonBody,
  sendJson,
  sendError,
  sendFile,
  parseRange,
  serveStatic,
};
