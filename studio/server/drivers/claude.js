'use strict';
/**
 * Claude Code driver: `claude -p`, headless, with the scaffold root as the
 * working directory and the project directory added.
 *
 *   claude -p --output-format stream-json --verbose --json-schema <schema>
 *          --setting-sources project --strict-mcp-config
 *          --permission-mode acceptEdits|dontAsk --allowedTools <list>
 *          --add-dir <dir>... [--model <alias>] [--resume <session id>]
 *
 * The prompt goes in on stdin. CLAUDECODE and CLAUDE_CODE_ENTRYPOINT are
 * removed from the child's environment, so a studio started from inside a
 * Claude Code session still runs its own. Tool calls in the event stream
 * become short progress lines.
 */

const path = require('path');
const { SCAFFOLD_ROOT } = require('../util');

const WRITE_TOOLS = 'Read,Write,Edit,Glob,Grep,Bash(node scripts/*)';
const READ_TOOLS = 'Read,Glob,Grep';
const STRIPPED_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function cliSpawn() {
  return require(path.join(SCAFFOLD_ROOT, 'providers', 'lib', 'cli-spawn.js'));
}

/**
 * The argument array of one run. Pure. No text written by a person is in it.
 * @param {{addDirs?: string[], schema?: object, model?: string, allowWrite?: boolean, sessionId?: string}} options
 */
function buildArgs(options = {}) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (options.schema) args.push('--json-schema', JSON.stringify(options.schema));
  args.push('--setting-sources', 'project', '--strict-mcp-config');
  args.push('--permission-mode', options.allowWrite ? 'acceptEdits' : 'dontAsk');
  args.push('--allowedTools', options.allowWrite ? WRITE_TOOLS : READ_TOOLS);
  for (const dir of options.addDirs || []) args.push('--add-dir', String(dir));
  if (options.model) args.push('--model', String(options.model));
  if (options.sessionId) args.push('--resume', String(options.sessionId));
  return args;
}

/** The child's environment: the parent's without the variables that mark a nested session. */
function buildEnv(env = process.env) {
  const out = Object.assign({}, env);
  for (const name of STRIPPED_ENV) delete out[name];
  return out;
}

/** A path as a person would say it: relative to the workspace, else to the scaffold. */
function shortPath(file, roots) {
  const text = String(file || '');
  if (!text) return '';
  const norm = (p) => path.resolve(p).split(path.sep).join('/');
  let abs;
  try {
    abs = norm(path.isAbsolute(text) ? text : path.join(roots.cwd || '.', text));
  } catch (err) {
    return text;
  }
  const lower = abs.toLowerCase();
  for (const root of [roots.workspace, ...(roots.addDirs || []), roots.cwd].filter(Boolean)) {
    const base = norm(root);
    if (lower === base.toLowerCase()) return '.';
    if (lower.startsWith(`${base.toLowerCase()}/`)) return abs.slice(base.length + 1);
  }
  return abs;
}

/** One progress line for a tool call, or null when the call is not worth showing. */
function toolLine(name, input, roots) {
  const i = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'Read': return `reading ${shortPath(i.file_path, roots)}`;
    case 'Write': return `writing ${shortPath(i.file_path, roots)}`;
    case 'Edit':
    case 'MultiEdit': return `editing ${shortPath(i.file_path, roots)}`;
    case 'Glob': return `looking for ${String(i.pattern || '').slice(0, 80)}`;
    case 'Grep': return `searching for ${String(i.pattern || '').slice(0, 80)}`;
    case 'Bash': return `running ${String(i.command || '').replace(/\s+/g, ' ').slice(0, 120)}`;
    case 'Task':
    case 'Agent': return `asking a helper: ${String(i.description || '').slice(0, 80)}`;
    default: return name ? `using ${name}` : null;
  }
}

/**
 * Parser for `--output-format stream-json` lines.
 * push(line) returns the progress events of that line (also sent to onEvent);
 * result() returns what the run produced.
 * @param {{cwd?: string, workspace?: string, addDirs?: string[], onEvent?: Function}} options
 */
function createParser(options = {}) {
  const roots = { cwd: options.cwd, workspace: options.workspace, addDirs: options.addDirs };
  const state = { sessionId: null, final: null, lastText: '', denied: [] };
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
      if (typeof event.session_id === 'string' && event.session_id) state.sessionId = event.session_id;
      if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
        for (const block of event.message.content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'tool_use') {
            const lineText = toolLine(block.name, block.input, roots);
            if (lineText) out.push(emit({ type: 'tool', tool: block.name, text: lineText }));
          } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            state.lastText = block.text;
            out.push(emit({ type: 'text', text: block.text.replace(/\s+/g, ' ').trim().slice(0, 200) }));
          }
        }
      } else if (event.type === 'result') {
        state.final = event;
        if (Array.isArray(event.permission_denials)) {
          state.denied = event.permission_denials.map((d) => (d && (d.tool_name || d.tool)) || 'a tool');
        }
      }
      return out;
    },
    result() {
      const final = state.final;
      if (!final) {
        return {
          ok: false, structured: null, text: state.lastText, sessionId: state.sessionId,
          costUsd: null, durationMs: null, error: 'Claude Code ended without a result.',
        };
      }
      let structured = final.structured_output && typeof final.structured_output === 'object' ? final.structured_output : null;
      const text = typeof final.result === 'string' ? final.result : state.lastText;
      if (!structured && text) structured = parseJsonObject(text);
      const failed = final.is_error === true || (final.subtype && final.subtype !== 'success');
      let error = null;
      if (failed) {
        error = text ? String(text).slice(0, 600) : `Claude Code ended with ${final.subtype || 'an error'}.`;
        if (state.denied.length) error += ` Denied: ${[...new Set(state.denied)].join(', ')}.`;
      }
      return {
        ok: !failed,
        structured,
        text: text || '',
        sessionId: state.sessionId,
        costUsd: typeof final.total_cost_usd === 'number' ? final.total_cost_usd : null,
        durationMs: typeof final.duration_ms === 'number' ? final.duration_ms : null,
        error,
        denied: [...new Set(state.denied)],
      };
    },
  };
}

/** The JSON object in a text (the whole text, or the outermost braces), or null. */
function parseJsonObject(text) {
  const source = String(text || '').trim();
  const tryParse = (s) => {
    try {
      const value = JSON.parse(s);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch (err) {
      return null;
    }
  };
  const whole = tryParse(source);
  if (whole) return whole;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  return start !== -1 && end > start ? tryParse(source.slice(start, end + 1)) : null;
}

function lastLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 300) : '';
}

/** { installed, version, path }. Runs `claude --version`, which starts no session. */
function detect() {
  try {
    const { resolveBinary, binaryVersion } = cliSpawn();
    const bin = resolveBinary('claude', 'CLAUDE_BIN');
    if (!bin.found) return { installed: false, version: null, path: null };
    const res = binaryVersion(bin, { env: buildEnv() });
    const m = res.ok && res.version ? /(\d+\.\d+\.\d+\S*)/.exec(res.version) : null;
    return { installed: true, version: m ? m[1] : (res.version || null), path: bin.path };
  } catch (err) {
    return { installed: false, version: null, path: null };
  }
}

/**
 * Run one prompt.
 * @param {{cwd: string, addDirs?: string[], prompt: string, schema?: object, images?: string[],
 *          model?: string, allowWrite?: boolean, sessionId?: string, signal?: AbortSignal,
 *          onEvent?: Function, workspace?: string, timeoutMs?: number}} options
 *   `images` are not attached: Claude Code opens image files with its Read
 *   tool, so the prompt lists their paths.
 * @param {{spawnCli?: Function, resolveBinary?: Function}} [deps] test doubles
 * @returns {Promise<{ok, structured, text, sessionId, costUsd, durationMs, error}>}
 */
async function run(options, deps = {}) {
  const lib = deps.spawnCli && deps.resolveBinary ? deps : Object.assign({}, cliSpawn(), deps);
  const started = Date.now();
  const bin = lib.resolveBinary('claude', 'CLAUDE_BIN');
  if (!bin.found) {
    return {
      ok: false, structured: null, text: '', sessionId: null, costUsd: null, durationMs: 0,
      error: `Claude Code was not found: ${bin.error}.`,
    };
  }
  const parser = createParser({
    cwd: options.cwd, workspace: options.workspace, addDirs: options.addDirs, onEvent: options.onEvent,
  });
  let proc;
  try {
    proc = await lib.spawnCli({
      bin,
      args: buildArgs(options),
      cwd: options.cwd,
      stdin: String(options.prompt || ''),
      env: buildEnv(),
      signal: options.signal,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      onStdout: (line) => parser.push(line),
    });
  } catch (err) {
    return {
      ok: false, structured: null, text: '', sessionId: null, costUsd: null, durationMs: Date.now() - started,
      error: `Claude Code could not be started: ${err.message}`,
    };
  }
  const result = parser.result();
  if (!result.durationMs) result.durationMs = Date.now() - started;
  if (proc.cancelled) return Object.assign(result, { ok: false, error: 'cancelled', cancelled: true });
  if (proc.timedOut) return Object.assign(result, { ok: false, error: 'Claude Code took too long and was stopped.' });
  // The exit code decides, together with the result event. stderr is context only.
  if (proc.code !== 0 && result.ok) {
    result.ok = false;
    result.error = `Claude Code exited with code ${proc.code}.`;
  }
  if (!result.ok && !result.error) result.error = `Claude Code exited with code ${proc.code}.`;
  if (!result.ok && result.error === 'Claude Code ended without a result.' && lastLine(proc.stderr)) {
    result.error += ` Last message: ${lastLine(proc.stderr)}`;
  }
  return result;
}

module.exports = {
  name: 'claude',
  label: 'Claude Code',
  verbs: ['plan', 'look'],
  WRITE_TOOLS,
  READ_TOOLS,
  buildArgs,
  buildEnv,
  createParser,
  parseJsonObject,
  toolLine,
  shortPath,
  detect,
  run,
};
