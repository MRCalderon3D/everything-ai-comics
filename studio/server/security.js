'use strict';
/**
 * Checks that keep a local web app local: the Host header (DNS rebinding),
 * the Origin of state-changing requests (cross-site requests from another
 * page in the same browser), and path confinement for every file path a
 * client sends.
 */

const fs = require('fs');
const path = require('path');
const { HttpError } = require('./util');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Host values a browser on this machine uses to reach the server. */
function allowedHosts(port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

/** Throws 403 when the Host header is not this server on loopback. */
function checkHost(req, port) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!allowedHosts(port).includes(host)) {
    throw new HttpError(403, 'bad_host', 'This server only answers requests addressed to 127.0.0.1 or localhost on its own port.');
  }
}

/**
 * Throws 403 when a state-changing request comes from another site. A request
 * with no Origin header (a script, curl, a test) is allowed: the Host check
 * already holds and a browser always sends Origin on cross-site writes.
 */
function checkOrigin(req, port) {
  if (SAFE_METHODS.has(req.method)) return;
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'cross-site') {
    throw new HttpError(403, 'bad_origin', 'Cross-site requests cannot change anything here.');
  }
  const origin = req.headers.origin;
  if (origin === undefined) return;
  const allowed = allowedHosts(port).map((h) => `http://${h}`);
  if (!allowed.includes(String(origin).toLowerCase())) {
    throw new HttpError(403, 'bad_origin', 'Requests from another origin cannot change anything here.');
  }
}

/**
 * Resolve a client-supplied relative path inside a base directory.
 * Rejects absolute paths, drive letters, NUL bytes, and anything that
 * resolves outside the base, including through a symbolic link.
 * @returns {string} absolute path
 */
function resolveInside(base, relPath) {
  const rel = String(relPath == null ? '' : relPath);
  if (!rel || rel.includes('\0')) throw new HttpError(400, 'bad_path', 'A file path is required.');
  const normalized = rel.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new HttpError(400, 'bad_path', 'File paths are relative to the workspace.');
  }
  if (normalized.split('/').some((part) => part === '..')) {
    throw new HttpError(400, 'bad_path', 'File paths cannot leave the workspace.');
  }
  const baseAbs = path.resolve(base);
  const target = path.resolve(baseAbs, ...normalized.split('/'));
  if (target !== baseAbs && !target.startsWith(baseAbs + path.sep)) {
    throw new HttpError(400, 'bad_path', 'File paths cannot leave the workspace.');
  }
  // A link inside the workspace must not lead out of it.
  let existing = target;
  while (existing !== baseAbs && !fs.existsSync(existing)) existing = path.dirname(existing);
  try {
    const realBase = fs.realpathSync(baseAbs);
    const real = fs.realpathSync(existing);
    if (real !== realBase && !real.startsWith(realBase + path.sep)) {
      throw new HttpError(400, 'bad_path', 'File paths cannot leave the workspace.');
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // base does not exist yet: nothing to follow
  }
  return target;
}

/** A single path segment that is safe as a file or directory name. */
function safeName(name, fallback = 'file') {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  const clean = base.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 80);
  return clean || fallback;
}

module.exports = { SAFE_METHODS, allowedHosts, checkHost, checkOrigin, resolveInside, safeName };
