#!/usr/bin/env node
'use strict';
/**
 * The comics studio server: a local web app on top of the scaffold.
 *
 *   node studio/server/index.js [--port 4310] [--home <dir>] [--no-open]
 *
 * It binds to 127.0.0.1 only, serves the interface from studio/web/ and a
 * JSON API under /api/ (studio/docs/api.md), and drives the AI through the
 * Claude Code and Codex command-line tools the person already has. With
 * STUDIO_FAKE_AI=1 every operation runs without either tool.
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const security = require('./security');
const i18n = require('./i18n');
const ops = require('./ops');
const S = require('./scaffold');
const { EventHub } = require('./events');
const { JobManager } = require('./jobs');
const { Registry, defaultHome } = require('./registry');
const { createDrivers } = require('./drivers');
const { createApi } = require('./api');
const { serveStatic, sendJson, sendError } = require('./http');
const { HttpError, STUDIO_ROOT } = require('./util');

const DEFAULT_PORT = 4310;
const HOST = '127.0.0.1';

const HELP = `
Comics studio: a local web app for making a comic with the everything-ai-comics scaffold.

Usage:
  node studio/server/index.js [--port <number>] [--home <dir>] [--no-open]

Options:
  --port <number>  Port to listen on (default ${DEFAULT_PORT}). Always on 127.0.0.1.
  --home <dir>     Where projects live (default: STUDIO_HOME, else <user home>/comics-studio).
  --no-open        Do not open the browser.
  --fake           Run without Claude Code or Codex (same as STUDIO_FAKE_AI=1):
                   every step finishes at once with placeholder files and images.
  --help           Show this help.

Environment:
  STUDIO_HOME            default for --home
  STUDIO_FAKE_AI=1       fake mode
  STUDIO_AI_TIMEOUT_MS   limit for one AI call (default 1800000)
  CLAUDE_BIN, CODEX_BIN  path of each tool, when it is not on PATH
`;

/**
 * Create the server without starting it.
 * @param {{port?: number, home?: string, fake?: boolean, fakeTools?: string[],
 *          heartbeatMs?: number, webDir?: string, previewsDir?: string, modelOptions?: object}} [options]
 *   port 0 picks a free port (tests). fakeTools: which tools the fake
 *   reports as installed (default both). previewsDir: where the sample
 *   pages of the presets are read from (default templates/looks/previews).
 *   modelOptions: passed to the model detection (tests).
 * @returns {{server, listen: () => Promise<{port, url}>, close: () => Promise<void>,
 *            services, port: () => number, url: () => string}}
 */
function createServer(options = {}) {
  const fake = options.fake !== undefined ? !!options.fake : process.env.STUDIO_FAKE_AI === '1';
  const fakeTools = options.fakeTools ||
    (process.env.STUDIO_FAKE_TOOLS ? process.env.STUDIO_FAKE_TOOLS.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
  const registry = new Registry(options.home || defaultHome());
  const events = new EventHub({
    heartbeatMs: options.heartbeatMs || 15000,
    languageOf: (projectId) => registry.get(projectId).settings().language,
  });
  const drivers = createDrivers({ fake, fakeTools, modelOptions: options.modelOptions });
  // The model lists of the installed tools are looked up once at start (and on request).
  drivers.refreshModels().catch(() => {});
  if (options.previewsDir) require('./looks').setPreviewsDir(options.previewsDir);
  const services = { registry, events, drivers, ops, fake };
  const jobs = new JobManager({ events, ops, services });
  services.jobs = jobs;
  // After a step that wrote files: the characters, places and objects it added, and possible duplicates.
  services.inspectStep = (project, job, step, changes, before) => require('./entities').inspectStep(project, job, step, changes, before);
  // A job started from a card of the conversation posts its result back there.
  services.onJobSettled = (project, job) => require('./actions').jobSettled(services, project, job);
  // The tools a job needs: the queued work that pauses when one runs out of quota.
  services.toolsOf = (project, job) => require('./actions').toolsOf(services, project, job);
  const webDir = options.webDir || path.join(STUDIO_ROOT, 'web');
  let port = options.port === undefined ? DEFAULT_PORT : options.port;

  // In fake mode the scaffold's codex-cli provider runs a stand-in binary,
  // so drawing goes through the real provider and generate-assets.js.
  const previousCodexBin = process.env.CODEX_BIN;
  if (fake) process.env.CODEX_BIN = path.join(__dirname, 'fake', 'codex-stub.js');
  // Fake mode: the drawing tool runs out of quota while this file exists (fake/codex-stub.js).
  const previousQuotaFile = process.env.STUDIO_FAKE_QUOTA_FILE;
  if (fake && !previousQuotaFile) process.env.STUDIO_FAKE_QUOTA_FILE = path.join(registry.home, '.fake-quota');

  const router = createApi(services);

  /**
   * The language of a request: ?lang=, else the interface language of the
   * project in the path, else Accept-Language, else English.
   */
  function languageOf(req, url) {
    let projectLanguage = null;
    const m = url ? /^\/api\/projects\/([a-z0-9][a-z0-9-]*)(?:\/|$)/.exec(url.pathname) : null;
    if (m) {
      try {
        projectLanguage = registry.get(m[1]).settings().language;
      } catch (err) {
        projectLanguage = null;
      }
    }
    return i18n.pickLang({
      query: url ? url.searchParams.get('lang') : null,
      projectLanguage,
      acceptLanguage: req.headers['accept-language'],
    });
  }

  async function handle(req, res) {
    let lang = i18n.fromAcceptLanguage(req.headers['accept-language']) || i18n.DEFAULT_LANG;
    try {
      security.checkHost(req, port);
      security.checkOrigin(req, port);
      let url;
      try {
        url = new URL(req.url, `http://${HOST}`);
      } catch (err) {
        throw new HttpError(400, 'bad_request', 'The URL is malformed.');
      }
      const pathname = url.pathname;
      lang = languageOf(req, url);
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        const match = router.match(req.method, pathname);
        if (!match) throw new HttpError(404, 'not_found', 'There is no such API route.');
        if (match.methodMismatch) throw new HttpError(405, 'method_not_allowed', `${req.method} is not allowed on this route.`);
        const result = await match.route.handler(req, res, { params: match.params, query: url.searchParams, url, lang });
        // Message descriptors anywhere in the result become text in the request's language.
        if (result !== undefined && !res.headersSent) sendJson(res, res.statusCode || 200, i18n.localize(lang, result));
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'method_not_allowed', `${req.method} is not allowed here.`);
      }
      serveStatic(req, res, webDir, pathname);
    } catch (err) {
      // Whatever was not read of the request body is discarded.
      try { req.resume(); } catch (e) { /* ignore */ }
      let error = err;
      if (!(err instanceof HttpError)) {
        if (/YAML parse error/.test(String(err && err.message))) {
          error = new HttpError(422, 'workspace_yaml', `A file of the workspace does not parse: ${err.message}`);
        } else if (err && typeof err.code === 'string' && /^[a-z_]+$/.test(err.code) && !err.status) {
          // A refusal from a scaffold script, with its own reason.
          error = new HttpError(409, err.code, err.message);
        } else {
          if (process.env.STUDIO_DEBUG) console.error(err);
          error = new HttpError(500, 'internal', err && err.message ? err.message : 'Unexpected error.');
        }
      }
      sendError(res, error, lang);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      try { sendError(res, new HttpError(500, 'internal', err.message)); } catch (e) { res.destroy(); }
    });
  });
  server.keepAliveTimeout = 5000;

  function listen() {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        port = server.address().port;
        // Jobs a crashed server left running are marked failed before anything else runs.
        for (const id of registry.list()) {
          try {
            jobs.jobs(registry.get(id));
          } catch (err) {
            // a broken project does not stop the server
          }
        }
        resolve({ port, url: `http://${HOST}:${port}` });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, HOST);
    });
  }

  async function close() {
    await jobs.shutdown();
    events.close();
    if (options.previewsDir) require('./looks').setPreviewsDir(null);
    if (fake) {
      if (previousCodexBin === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previousCodexBin;
      if (previousQuotaFile === undefined) delete process.env.STUDIO_FAKE_QUOTA_FILE;
    }
    await new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
  }

  return {
    server, listen, close, services,
    port: () => port,
    url: () => `http://${HOST}:${port}`,
  };
}

function openBrowser(url) {
  try {
    const opts = { stdio: 'ignore', detached: true, windowsHide: true };
    let child;
    if (process.platform === 'win32') child = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '""', url], opts);
    else if (process.platform === 'darwin') child = spawn('open', [url], opts);
    else child = spawn('xdg-open', [url], opts);
    child.on('error', () => {});
    child.unref();
  } catch (err) {
    // The address is printed; opening the browser is a convenience.
  }
}

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, home: null, open: true, fake: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--no-open') out.open = false;
    else if (arg === '--fake') out.fake = true;
    else if (arg === '--port') {
      const port = Number.parseInt(value(), 10);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a number from 0 to 65535');
      out.port = port;
    } else if (arg.startsWith('--port=')) {
      out.port = Number.parseInt(arg.slice(7), 10);
      if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error('--port must be a number from 0 to 65535');
    } else if (arg === '--home') out.home = value();
    else if (arg.startsWith('--home=')) out.home = arg.slice(7);
    else throw new Error(`unknown option ${arg} (see --help)`);
  }
  return out;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(HELP);
    return;
  }
  const app = createServer({ port: args.port, home: args.home || undefined, fake: args.fake });
  let info;
  try {
    info = await app.listen();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`error: port ${args.port} is already in use. The studio may already be running at http://${HOST}:${args.port}, or pick another port with --port.`);
    } else {
      console.error(`error: the server could not start: ${err.message}`);
    }
    process.exit(1);
  }
  const tools = app.services.drivers.detect();
  console.log(`Comics studio (scaffold ${S.version() || 'unknown'}) at ${info.url}`);
  console.log(`  projects: ${app.services.registry.home}`);
  if (app.services.fake) {
    console.log('  FAKE MODE: no AI tool is called. Texts and images are placeholders.');
  } else {
    console.log(`  Claude Code: ${tools.claude.installed ? tools.claude.version || 'found' : 'not found'}`);
    console.log(`  Codex: ${tools.codex.installed ? tools.codex.version || 'found' : 'not found'}`);
  }
  console.log('  Press Ctrl+C to stop.');
  if (args.open) openBrowser(info.url);
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log('\nStopping: running jobs are cancelled.');
    app.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { createServer, parseArgs, DEFAULT_PORT, HOST };

if (require.main === module) main();
