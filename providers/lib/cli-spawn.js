'use strict';
/**
 * Run a command-line tool as a child process. Zero dependencies.
 *
 * Shared by the codex-cli image provider and by any caller that drives a CLI
 * (the web studio's own drivers). Three jobs:
 *
 *   resolveBinary(name, envOverride)   find the executable, on Windows and POSIX
 *   spawnCli({ bin, args, ... })       run it, feed stdin, collect output
 *   killTree(child)                    stop it and everything it started
 *
 * Rules this file keeps:
 * - No shell on the normal path. Arguments are passed as an array, so nothing
 *   in them is interpreted. Text written by a person (a prompt) belongs on
 *   stdin or in a file, never in `args`.
 * - On Windows a CLI installed with npm is a `.cmd` shim, which Node refuses
 *   to spawn directly. The shim is read to find the script it launches, and
 *   that script is run with Node. A batch file that is not such a shim runs
 *   through cmd.exe with every argument quoted and escaped.
 * - A `.js`, `.cjs` or `.mjs` file is run with the current Node binary, on
 *   every platform. Tests inject stubs this way.
 * - stderr is collected and reported, never judged. Whether a run failed is
 *   the caller's decision, from the exit code and the files it expected.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const SCRIPT_EXTENSIONS = ['.js', '.cjs', '.mjs'];
const WIN_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat'];
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
/** Keep at most this many characters of each output stream (the tail). */
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;
/** After a kill, wait this long for the streams to close before giving up on them. */
const CLOSE_GRACE_MS = 5000;

/** Children still running, so they can be stopped when this process exits. */
const active = new Set();
let exitHookInstalled = false;

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (err) {
    return false;
  }
}

function isRunnable(file) {
  if (!isFile(file)) return false;
  if (IS_WIN) return true;
  if (SCRIPT_EXTENSIONS.includes(path.extname(file).toLowerCase())) return true;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (err) {
    return false;
  }
}

function envValue(env, name) {
  if (!env) return undefined;
  if (env[name] !== undefined) return env[name];
  if (!IS_WIN) return undefined;
  // Windows environment names are case-insensitive (PATH is often "Path").
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}

/** A file path as given, or with one of the Windows executable extensions. */
function withExtension(file) {
  if (isRunnable(file)) return file;
  if (!IS_WIN || path.extname(file)) return null;
  for (const ext of WIN_EXTENSIONS) {
    if (isFile(file + ext)) return file + ext;
  }
  return null;
}

/** First match of a bare command name on PATH, or null. */
function findOnPath(name, env) {
  const dirs = String(envValue(env, 'PATH') || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const clean = dir.replace(/^"(.*)"$/, '$1');
    if (IS_WIN) {
      // npm also drops an extensionless shell script next to the .cmd shim;
      // Windows cannot run it, so only names with an extension count.
      const exts = path.extname(name) ? [''] : WIN_EXTENSIONS;
      for (const ext of exts) {
        const file = path.join(clean, name + ext);
        if (isFile(file)) return file;
      }
    } else {
      const file = path.join(clean, name);
      if (isRunnable(file)) return file;
    }
  }
  return null;
}

/**
 * The script an npm `.cmd` shim launches, or null when the file is not such
 * a shim. npm writes `"%dp0%\node_modules\<pkg>\bin\cli.js" %*` (older
 * versions `"%~dp0\node_modules\..."`).
 * @returns {{script: string, node: string}|null}
 */
function readNpmShim(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return null;
  }
  const m = /"%~?dp0%?\\?([^"\r\n]+?\.[cm]?js)"\s*%\*/i.exec(text);
  if (!m) return null;
  const dir = path.dirname(file);
  const script = path.join(dir, m[1]);
  if (!isFile(script)) return null;
  const bundledNode = path.join(dir, 'node.exe');
  return { script, node: isFile(bundledNode) ? bundledNode : process.execPath };
}

/** How to launch a resolved file: the command and the arguments that go before the caller's. */
function launcherOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (SCRIPT_EXTENSIONS.includes(ext)) {
    return { command: process.execPath, prefixArgs: [file], via: 'node' };
  }
  if (IS_WIN && (ext === '.cmd' || ext === '.bat')) {
    const shim = readNpmShim(file);
    if (shim) return { command: shim.node, prefixArgs: [shim.script], via: 'npm-shim' };
    return { command: file, prefixArgs: [], via: 'cmd' };
  }
  return { command: file, prefixArgs: [], via: 'direct' };
}

/**
 * Find a command-line tool.
 *
 * @param {string} name The command name ("codex", "claude").
 * @param {string} [envOverride] The NAME of an environment variable that may
 *   hold a path to use instead ("CODEX_BIN"). A string that is not shaped
 *   like a variable name (it has a path separator, a dot, or lowercase
 *   letters) is taken as the override path itself.
 * @param {{env?: object}} [options] Environment to read; default process.env.
 * @returns {{found: boolean, name: string, path: string|null, command: string|null,
 *   prefixArgs: string[], via: 'direct'|'node'|'npm-shim'|'cmd'|null,
 *   source: 'env'|'path', error: string|null}}
 *   `command` plus `prefixArgs` is what gets spawned. When `found` is false,
 *   `error` says where it looked. An override that points nowhere is an
 *   error: it does not fall back to PATH.
 */
function resolveBinary(name, envOverride, options = {}) {
  const env = options.env || process.env;
  const result = {
    found: false, name: String(name), path: null, command: null, prefixArgs: [], via: null, source: 'path', error: null,
  };
  let override = null;
  let overrideLabel = 'the override';
  if (envOverride) {
    if (ENV_NAME.test(String(envOverride))) {
      override = envValue(env, String(envOverride)) || null;
      overrideLabel = String(envOverride);
    } else {
      override = String(envOverride);
    }
  }

  let file = null;
  if (override) {
    result.source = 'env';
    const bare = !/[\\/]/.test(override);
    file = withExtension(path.resolve(override)) || (bare ? findOnPath(override, env) : null);
    if (!file) {
      result.error = `${overrideLabel} points at "${override}", which is not an executable file`;
      return result;
    }
  } else {
    file = /[\\/]/.test(result.name) ? withExtension(path.resolve(result.name)) : findOnPath(result.name, env);
    if (!file) {
      result.error = `"${result.name}" was not found on PATH` +
        (envOverride && ENV_NAME.test(String(envOverride)) ? ` and ${envOverride} is not set` : '');
      return result;
    }
  }

  const launcher = launcherOf(file);
  return Object.assign(result, { found: true, path: file }, launcher);
}

// --- cmd.exe quoting (only for a batch file that is not an npm shim) ----------

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdArgument(arg) {
  let text = String(arg);
  // Backslashes before a quote are doubled and the quote escaped; trailing
  // backslashes are doubled because a closing quote follows them.
  text = text.replace(/(\\*)"/g, '$1$1\\"');
  text = text.replace(/(\\*)$/, '$1$1');
  return `"${text}"`.replace(CMD_META, '^$1');
}

/** command + args + spawn options for a resolved binary. */
function launchPlan(bin, args) {
  const list = (args || []).map(String);
  if (bin.via === 'cmd') {
    const line = [path.normalize(bin.command).replace(CMD_META, '^$1')]
      .concat(list.map(escapeCmdArgument)).join(' ');
    return {
      command: process.env.comspec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      options: { windowsVerbatimArguments: true },
    };
  }
  return { command: bin.command, args: bin.prefixArgs.concat(list), options: {} };
}

function asBinary(bin, env) {
  if (bin && typeof bin === 'object') return bin;
  return resolveBinary(String(bin), undefined, { env });
}

// --- kill ---------------------------------------------------------------------

function taskkillPath() {
  const file = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'taskkill.exe');
  return isFile(file) ? file : 'taskkill';
}

/**
 * Stop a child process and every process it started.
 * Windows: `taskkill /T /F /PID`. POSIX: SIGTERM to the process group
 * (spawnCli starts the child as a group leader), then SIGKILL after two
 * seconds. Safe to call on a child that already exited.
 * @returns {boolean} false when there was nothing to stop
 */
function killTree(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return false;
  const pid = child.pid;
  if (IS_WIN) {
    try {
      spawnSync(taskkillPath(), ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } catch (err) { /* fall through to child.kill */ }
    try {
      child.kill();
    } catch (err) { /* already gone */ }
    return true;
  }
  const signalGroup = (sig) => {
    try {
      process.kill(-pid, sig);
    } catch (err) {
      try {
        child.kill(sig);
      } catch (inner) { /* already gone */ }
    }
  };
  signalGroup('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalGroup('SIGKILL');
  }, 2000);
  if (typeof timer.unref === 'function') timer.unref();
  return true;
}

function stopActive() {
  for (const child of active) {
    try {
      if (IS_WIN) killTree(child);
      else process.kill(-child.pid, 'SIGKILL');
    } catch (err) { /* nothing left to stop */ }
  }
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', stopActive);
  if (IS_WIN) return;
  // POSIX children run in their own process group, so a Ctrl-C in the
  // terminal does not reach them, and a process killed by a signal fires no
  // 'exit' event. Stop them here, then let the signal do what it would have
  // done. When the host program has its own handler, that handler decides.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => {
      stopActive();
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    });
  }
}

// --- spawn --------------------------------------------------------------------

/** Split a stream into lines for a callback; `flush` emits the unterminated rest. */
function lineSplitter(onLine) {
  let rest = '';
  const emit = (line) => {
    try {
      onLine(line);
    } catch (err) { /* a listener must not break the run */ }
  };
  return {
    push(text) {
      rest += text;
      let cut = rest.indexOf('\n');
      while (cut !== -1) {
        emit(rest.slice(0, cut).replace(/\r$/, ''));
        rest = rest.slice(cut + 1);
        cut = rest.indexOf('\n');
      }
    },
    flush() {
      if (rest) emit(rest.replace(/\r$/, ''));
      rest = '';
    },
  };
}

/**
 * Run a CLI and wait for it.
 *
 * @param {object} options
 * @param {object|string} options.bin A resolveBinary() result, or a command
 *   name or path to resolve.
 * @param {string[]} [options.args] Arguments, passed as an array. No text
 *   written by a person: use `stdin` or a file.
 * @param {string} [options.cwd] Working directory.
 * @param {string|Buffer} [options.stdin] Written to the child's stdin, which
 *   is then closed. Without it stdin is closed from the start.
 * @param {object} [options.env] The child's whole environment. Default: process.env.
 * @param {AbortSignal} [options.signal] Aborting kills the process tree.
 * @param {number} [options.timeoutMs] Kill the process tree after this long. 0 or absent: no limit.
 * @param {(line: string) => void} [options.onStdout] Called once per stdout line.
 * @param {(line: string) => void} [options.onStderr] Called once per stderr line.
 * @param {number} [options.maxBuffer] Characters kept per stream (the tail). Default 4 MB.
 * @returns {Promise<{code: number|null, signal: string|null, timedOut: boolean,
 *   cancelled: boolean, stdout: string, stderr: string}>}
 *   Resolves when the process has ended, whatever its exit code. `cancelled`
 *   is true when the signal stopped it (also when it was aborted before the
 *   start, in which case nothing is spawned). Rejects only when the process
 *   cannot be started: err.code is 'BINARY_NOT_FOUND' or 'SPAWN_FAILED'.
 */
function spawnCli(options = {}) {
  const env = options.env || process.env;
  const bin = asBinary(options.bin, env);
  const signal = options.signal || null;
  const maxBuffer = options.maxBuffer > 0 ? options.maxBuffer : DEFAULT_MAX_BUFFER;

  return new Promise((resolve, reject) => {
    if (!bin || !bin.found) {
      const err = new Error((bin && bin.error) || 'binary not found');
      err.code = 'BINARY_NOT_FOUND';
      reject(err);
      return;
    }
    const outcome = { code: null, signal: null, timedOut: false, cancelled: false, stdout: '', stderr: '' };
    if (signal && signal.aborted) {
      outcome.cancelled = true;
      resolve(outcome);
      return;
    }

    const plan = launchPlan(bin, options.args);
    const hasInput = options.stdin !== undefined && options.stdin !== null;
    let child;
    try {
      child = spawn(plan.command, plan.args, Object.assign({
        cwd: options.cwd || undefined,
        env,
        stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // POSIX: own process group, so killTree reaches grandchildren.
        detached: !IS_WIN,
      }, plan.options));
    } catch (cause) {
      const err = new Error(`could not start ${bin.name}: ${cause.message}`);
      err.code = 'SPAWN_FAILED';
      reject(err);
      return;
    }

    installExitHook();
    active.add(child);
    let settled = false;
    let timer = null;
    let graceTimer = null;
    const splitOut = lineSplitter(options.onStdout || (() => {}));
    const splitErr = lineSplitter(options.onStderr || (() => {}));
    const keep = (name, text) => {
      outcome[name] += text;
      if (outcome[name].length > maxBuffer) outcome[name] = outcome[name].slice(-maxBuffer);
    };

    const onAbort = () => {
      outcome.cancelled = true;
      stop();
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      active.delete(child);
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      splitOut.flush();
      splitErr.flush();
      if (error) reject(error);
      else resolve(outcome);
    };
    function stop() {
      killTree(child);
      // A grandchild that survived may hold the pipes open; do not wait for it.
      if (!graceTimer) {
        graceTimer = setTimeout(() => {
          for (const stream of [child.stdout, child.stderr]) {
            if (stream) stream.destroy();
          }
          finish();
        }, CLOSE_GRACE_MS);
        if (typeof graceTimer.unref === 'function') graceTimer.unref();
      }
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => {
      keep('stdout', text);
      splitOut.push(text);
    });
    child.stderr.on('data', (text) => {
      keep('stderr', text);
      splitErr.push(text);
    });
    child.on('error', (cause) => {
      const err = new Error(`could not start ${bin.name}: ${cause.message}`);
      err.code = 'SPAWN_FAILED';
      finish(err);
    });
    child.on('exit', (code, sig) => {
      outcome.code = code;
      outcome.signal = sig;
    });
    child.on('close', (code, sig) => {
      if (outcome.code === null && code !== null) outcome.code = code;
      if (outcome.signal === null && sig) outcome.signal = sig;
      finish();
    });

    if (hasInput) {
      child.stdin.on('error', () => { /* the child closed stdin early; its exit code tells the story */ });
      child.stdin.end(options.stdin);
    }
    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        outcome.timedOut = true;
        stop();
      }, options.timeoutMs);
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Ask a binary for its version, synchronously (for doctor.js).
 * @param {object|string} bin A resolveBinary() result, or a name or path.
 * @param {{args?: string[], timeoutMs?: number, env?: object}} [options]
 * @returns {{ok: boolean, version: string|null, error: string|null}}
 *   `version` is the first non-empty line the command printed.
 */
function binaryVersion(bin, options = {}) {
  const env = options.env || process.env;
  const resolved = asBinary(bin, env);
  if (!resolved || !resolved.found) {
    return { ok: false, version: null, error: (resolved && resolved.error) || 'binary not found' };
  }
  const plan = launchPlan(resolved, options.args || ['--version']);
  let res;
  try {
    res = spawnSync(plan.command, plan.args, Object.assign({
      env,
      encoding: 'utf8',
      timeout: options.timeoutMs > 0 ? options.timeoutMs : 10000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }, plan.options));
  } catch (err) {
    return { ok: false, version: null, error: err.message };
  }
  if (res.error) return { ok: false, version: null, error: res.error.message };
  const line = `${res.stdout || ''}\n${res.stderr || ''}`.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
  if (res.status !== 0) {
    return { ok: false, version: null, error: `exited with code ${res.status}${line ? `: ${line.slice(0, 200)}` : ''}` };
  }
  return { ok: true, version: line ? line.slice(0, 200) : null, error: null };
}

module.exports = { resolveBinary, spawnCli, killTree, binaryVersion };
