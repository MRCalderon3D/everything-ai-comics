'use strict';
/**
 * Codex driver: `codex exec`, headless, with the scaffold root as its
 * working root and the project directory added as writable.
 *
 *   codex exec --skip-git-repo-check -s workspace-write|read-only
 *              -C <scaffold root> --add-dir <project dir> --json
 *              --output-schema <file> -o <file> [-m <model>] [-i <image>]... -
 *
 * The prompt goes in on stdin: `-i` takes several values, so a prompt on the
 * command line would be read as one more image. A chat continues with
 *
 *   codex exec resume --skip-git-repo-check -c sandbox_mode=<mode>
 *              [-c sandbox_workspace_write.writable_roots=[...]] --json
 *              --output-schema <file> -o <file> [-m <model>] [-i <image>]...
 *              <session id> -
 *
 * (`resume` takes no -s, -C or --add-dir, so the sandbox goes in as config
 * overrides and the working root is the process's own directory.)
 *
 * The session id comes from the JSON events, the final message from the -o
 * file. A run fails on its exit code or a missing final message, never on
 * what the tool prints to stderr.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SCAFFOLD_ROOT } = require('../util');
const { parseJsonObject, shortPath } = require('./claude');

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function cliSpawn() {
  return require(path.join(SCAFFOLD_ROOT, 'providers', 'lib', 'cli-spawn.js'));
}

/**
 * A TOML string for a path: a literal string, forward slashes, nothing to
 * escape. Backslashes become slashes on Windows only; on POSIX a backslash
 * is an ordinary character of a file name.
 */
function tomlPath(file, platform = process.platform) {
  const sep = platform === 'win32' ? /[\\/]/ : /\//;
  const text = String(file).split(sep).join('/');
  return text.includes("'") ? JSON.stringify(text) : `'${text}'`;
}

/**
 * The argument array of one run. Pure. No text written by a person is in it.
 * @param {{cwd: string, addDirs?: string[], schemaFile?: string, outFile: string, images?: string[],
 *          model?: string, allowWrite?: boolean, sessionId?: string}} options
 */
function buildArgs(options) {
  const mode = options.allowWrite ? 'workspace-write' : 'read-only';
  const addDirs = options.addDirs || [];
  const images = options.images || [];
  const args = ['exec'];
  if (options.sessionId) {
    args.push('resume', '--skip-git-repo-check', '-c', `sandbox_mode=${mode}`);
    if (options.allowWrite && addDirs.length) {
      args.push('-c', `sandbox_workspace_write.writable_roots=[${addDirs.map((dir) => tomlPath(dir)).join(', ')}]`);
    }
  } else {
    args.push('--skip-git-repo-check', '-s', mode, '-C', String(options.cwd));
    for (const dir of addDirs) args.push('--add-dir', String(dir));
  }
  args.push('--json');
  if (options.schemaFile) args.push('--output-schema', String(options.schemaFile));
  args.push('-o', String(options.outFile));
  if (options.model) args.push('-m', String(options.model));
  for (const image of images) args.push('-i', String(image));
  if (options.sessionId) args.push(String(options.sessionId));
  args.push('-');
  return args;
}

/**
 * Parser for `codex exec --json` lines.
 * @param {{cwd?: string, workspace?: string, addDirs?: string[], onEvent?: Function}} options
 */
function createParser(options = {}) {
  const roots = { cwd: options.cwd, workspace: options.workspace, addDirs: options.addDirs };
  const state = { sessionId: null, lastMessage: '', error: null, usage: null };
  const emit = (event) => {
    if (typeof options.onEvent === 'function') {
      try { options.onEvent(event); } catch (err) { /* a listener must not break the run */ }
    }
    return event;
  };
  return {
    push(line) {
      const text = String(line).trim();
      if (!text) return [];
      let event;
      try {
        event = JSON.parse(text);
      } catch (err) {
        return [];
      }
      if (!event || typeof event !== 'object') return [];
      const out = [];
      const type = String(event.type || '');
      if (typeof event.thread_id === 'string' && event.thread_id && !state.sessionId) state.sessionId = event.thread_id;
      if (typeof event.session_id === 'string' && event.session_id && !state.sessionId) state.sessionId = event.session_id;
      const item = event.item && typeof event.item === 'object' ? event.item : null;
      if (item) {
        const kind = String(item.type || item.item_type || '');
        if (/message/.test(kind) && typeof item.text === 'string') {
          if (type === 'item.completed' || !type) {
            state.lastMessage = item.text;
            const short = item.text.replace(/\s+/g, ' ').trim().slice(0, 200);
            if (short) out.push(emit({ type: 'text', text: short }));
          }
        } else if (kind === 'command_execution' && type === 'item.started') {
          out.push(emit({ type: 'tool', tool: 'shell', text: `running ${String(item.command || '').replace(/\s+/g, ' ').slice(0, 120)}` }));
        } else if (kind === 'file_change' && type === 'item.completed') {
          for (const change of Array.isArray(item.changes) ? item.changes : []) {
            if (!change || !change.path) continue;
            const verb = change.kind === 'delete' ? 'deleting' : change.kind === 'add' ? 'writing' : 'editing';
            out.push(emit({ type: 'tool', tool: 'file', text: `${verb} ${shortPath(change.path, roots)}` }));
          }
        } else if (kind === 'mcp_tool_call' && type === 'item.started') {
          out.push(emit({ type: 'tool', tool: 'mcp', text: `using ${String(item.tool || item.server || 'a tool')}` }));
        } else if (kind === 'web_search' && type === 'item.started') {
          out.push(emit({ type: 'tool', tool: 'web', text: 'searching the web' }));
        } else if (kind === 'error' && typeof item.message === 'string') {
          state.error = item.message;
        }
      }
      if (type === 'turn.failed') {
        state.error = (event.error && event.error.message) || 'the turn failed';
      } else if (type === 'error' && typeof event.message === 'string') {
        state.error = event.message;
      } else if (type === 'turn.completed' && event.usage) {
        state.usage = event.usage;
      }
      return out;
    },
    state() {
      return state;
    },
  };
}

/** { installed, version, path }. Runs `codex --version`, which starts no session. */
function detect() {
  try {
    const { resolveBinary, binaryVersion } = cliSpawn();
    const bin = resolveBinary('codex', 'CODEX_BIN');
    if (!bin.found) return { installed: false, version: null, path: null };
    const res = binaryVersion(bin);
    const m = res.ok && res.version ? /(\d+\.\d+\.\d+\S*)/.exec(res.version) : null;
    return { installed: true, version: m ? m[1] : (res.version || null), path: bin.path };
  } catch (err) {
    return { installed: false, version: null, path: null };
  }
}

function removeQuietly(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch (err) { /* a leftover temporary file is not worth failing over */ }
}

/**
 * Run one prompt.
 * @param {{cwd: string, addDirs?: string[], prompt: string, schema?: object, images?: string[],
 *          model?: string, allowWrite?: boolean, sessionId?: string, signal?: AbortSignal,
 *          onEvent?: Function, workspace?: string, tmpDir?: string, timeoutMs?: number}} options
 * @param {{spawnCli?: Function, resolveBinary?: Function}} [deps] test doubles
 * @returns {Promise<{ok, structured, text, sessionId, costUsd, durationMs, error}>}
 */
async function run(options, deps = {}) {
  const lib = deps.spawnCli && deps.resolveBinary ? deps : Object.assign({}, cliSpawn(), deps);
  const started = Date.now();
  const fail = (error, extra = {}) => Object.assign({
    ok: false, structured: null, text: '', sessionId: null, costUsd: null, durationMs: Date.now() - started, error,
  }, extra);
  const bin = lib.resolveBinary('codex', 'CODEX_BIN');
  if (!bin.found) return fail(`Codex was not found: ${bin.error}.`);

  const tmpDir = options.tmpDir || os.tmpdir();
  fs.mkdirSync(tmpDir, { recursive: true });
  const token = crypto.randomBytes(5).toString('hex');
  const outFile = path.join(tmpDir, `codex-${token}.last-message.txt`);
  const schemaFile = options.schema ? path.join(tmpDir, `codex-${token}.schema.json`) : null;
  if (schemaFile) fs.writeFileSync(schemaFile, JSON.stringify(options.schema));

  const parser = createParser({
    cwd: options.cwd, workspace: options.workspace, addDirs: options.addDirs, onEvent: options.onEvent,
  });
  try {
    let proc;
    try {
      proc = await lib.spawnCli({
        bin,
        args: buildArgs(Object.assign({}, options, { schemaFile, outFile })),
        cwd: options.cwd,
        stdin: String(options.prompt || ''),
        signal: options.signal,
        timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
        onStdout: (line) => parser.push(line),
      });
    } catch (err) {
      return fail(`Codex could not be started: ${err.message}`);
    }
    const state = parser.state();
    let text = state.lastMessage;
    try {
      if (fs.existsSync(outFile)) text = fs.readFileSync(outFile, 'utf8');
    } catch (err) { /* keep what the event stream gave */ }
    const base = { sessionId: state.sessionId, text: text || '', durationMs: Date.now() - started };
    if (proc.cancelled) return fail('cancelled', Object.assign(base, { cancelled: true }));
    if (proc.timedOut) return fail('Codex took too long and was stopped.', base);
    if (proc.code !== 0) {
      return fail(`Codex exited with code ${proc.code === null ? `(signal ${proc.signal})` : proc.code}${state.error ? `: ${state.error}` : ''}.`, base);
    }
    if (!text || !String(text).trim()) {
      return fail(`Codex finished without a final message${state.error ? `: ${state.error}` : ''}.`, base);
    }
    return Object.assign({
      ok: true,
      structured: parseJsonObject(text),
      costUsd: null,
      error: null,
    }, base);
  } finally {
    removeQuietly(outFile);
    if (schemaFile) removeQuietly(schemaFile);
  }
}

module.exports = {
  name: 'codex',
  label: 'Codex',
  verbs: ['plan', 'look', 'draw'],
  buildArgs,
  createParser,
  tomlPath,
  detect,
  run,
};
