'use strict';
/**
 * The models each installed CLI can use, for the settings screen.
 *
 * Neither CLI has a command that only lists models in plain words, so the
 * list is read from what each tool keeps on disk, and only falls back to
 * what its own help says when nothing is there. Nothing here starts a
 * session or spends anything.
 *
 * Claude Code (2.1.x)
 *   1. <CLAUDE_CONFIG_DIR or ~/.claude>/cache/model-catalog/*.json: the model
 *      catalog Claude Code downloads and caches. catalog.config.models lists
 *      the models (section "main" for the current ones, "overflow" for
 *      earlier ones), catalog.config.provider_alias_targets maps the aliases
 *      (fable, opus, sonnet, haiku) to model ids, and catalog.state.model is
 *      the account's default. source: "cli".
 *   2. `claude --help`: the --model option names aliases ('fable', 'opus',
 *      'sonnet'). source: "documented".
 *
 * Codex (0.16x)
 *   1. <CODEX_HOME or ~/.codex>/models_cache.json: the catalog Codex fetched
 *      and cached; entries with visibility "list" are the ones its picker
 *      shows, in "priority" order. source: "cli".
 *   2. `codex debug models --bundled`: the catalog shipped inside the binary,
 *      printed without going to the network. source: "cli".
 *   3. `model = "..."` in <CODEX_HOME or ~/.codex>/config.toml (or in the
 *      profile that `profile = "..."` selects) is the default. source:
 *      "config" when it is not in the list already.
 *   Codex's help names no model, so there is no documented fallback.
 *
 * Runs once when the server starts and again on request
 * (POST /api/tools/refresh), never per request.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { msg } = require('./i18n');
const { SCAFFOLD_ROOT, nowIso } = require('./util');

const JOBS = { claude: ['plan', 'look'], codex: ['plan', 'look', 'draw'] };

/** The fixed list of fake mode. */
const FAKE_MODELS = {
  claude: [
    { id: 'fake-large', label: 'Fake large model', default: true },
    { id: 'fake-fast', label: 'Fake fast model', default: false },
  ],
  codex: [
    { id: 'fake-codex', label: 'Fake Codex model', default: true },
    { id: 'fake-codex-mini', label: 'Fake small Codex model', default: false },
  ],
};

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

function clean(text, max = 200) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** "~/.claude/..." for a path under the home directory, so no user name shows. */
function homeRelative(file, homeDir) {
  const norm = (p) => path.resolve(p).split(path.sep).join('/');
  const abs = norm(file);
  const home = norm(homeDir);
  return abs.toLowerCase().startsWith(`${home.toLowerCase()}/`) ? `~/${abs.slice(home.length + 1)}` : abs;
}

// --- Claude Code ------------------------------------------------------------------

/** The newest catalog file Claude Code keeps, or null. */
function claudeCatalogFile(configDir) {
  const dir = path.join(configDir, 'cache', 'model-catalog');
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch (err) {
    return null;
  }
  let best = null;
  for (const name of names) {
    const file = path.join(dir, name);
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch (err) {
      continue;
    }
    // The Claude Code surface ("-cc") wins over any other catalog in the folder.
    const rank = (/-cc\.json$/.test(name) ? 1e15 : 0) + mtime;
    if (!best || rank > best.rank) best = { file, rank };
  }
  return best ? best.file : null;
}

/**
 * Entries from a Claude Code model catalog document. Aliases first (what a
 * person types, and what keeps pointing at the newest model), then the
 * models of the catalog that no alias points at.
 * @returns {object[]|null} null when the document has no model list
 */
function parseClaudeCatalog(doc) {
  const config = doc && doc.catalog && doc.catalog.config;
  const models = config && Array.isArray(config.models) ? config.models.filter((m) => m && typeof m.id === 'string') : null;
  if (!models || !models.length) return null;
  const aliases = config.provider_alias_targets && typeof config.provider_alias_targets === 'object' ? config.provider_alias_targets : {};
  const state = doc.catalog.state || {};
  const byId = new Map(models.map((m) => [m.id, m]));
  const out = [];
  const targets = new Set();
  for (const [alias, value] of Object.entries(aliases)) {
    const target = value && typeof value === 'object' ? value.default : value;
    if (!/^[a-z][a-z0-9-]*$/.test(alias) || typeof target !== 'string') continue;
    const model = byId.get(target);
    targets.add(target);
    out.push({
      id: alias,
      label: model ? clean(model.name || alias, 80) : alias,
      default: false,
      source: 'cli',
      note: model && model.description ? clean(model.description) : null,
      alias_of: target,
    });
  }
  for (const model of models) {
    if (targets.has(model.id)) continue;
    out.push({
      id: model.id,
      label: clean(model.name || model.id, 80),
      default: false,
      source: 'cli',
      note: model.description ? clean(model.description) : (model.section === 'overflow' ? msg('model.note.earlier') : null),
      alias_of: null,
    });
  }
  const current = typeof state.model === 'string' ? state.model : null;
  if (current) {
    const hit = out.find((e) => e.alias_of === current) || out.find((e) => e.id === current);
    if (hit) hit.default = true;
  }
  return out;
}

/** The aliases the --model option of `claude --help` names, in order. */
function parseClaudeHelp(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^\s*--model\b/.test(l));
  if (start === -1) return [];
  const chunk = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*-{1,2}[a-z]/.test(lines[i]) || /^\S/.test(lines[i])) break;
    chunk.push(lines[i]);
  }
  const names = [];
  for (const m of chunk.join(' ').matchAll(/'([a-z][a-z0-9-]*)'/g)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names.map((id) => ({
    id, label: id, default: false, source: 'documented', note: msg('model.note.documented.claude'), alias_of: null,
  }));
}

async function detectClaude({ homeDir, env, run }) {
  const configDir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(homeDir, '.claude');
  const file = claudeCatalogFile(configDir);
  if (file) {
    const models = parseClaudeCatalog(readJsonFile(file));
    if (models && models.length) {
      return {
        models,
        // The folder, not the file: the file name carries an account id.
        source: { kind: 'cli', where: `${homeRelative(path.dirname(file), homeDir)}/`, note: msg('model.source.claude_catalog') },
      };
    }
  }
  const help = await run('claude', ['--help']);
  const models = parseClaudeHelp(help.ok ? help.stdout : '');
  if (models.length) {
    return { models, source: { kind: 'documented', where: 'claude --help', note: msg('model.source.claude_help') } };
  }
  return { models: [], source: { kind: 'none', where: null, note: msg('model.source.none') } };
}

// --- Codex --------------------------------------------------------------------------

/** Entries from a Codex model catalog ({ models: [...] }): the ones its picker lists. */
function parseCodexCatalog(doc) {
  const list = doc && Array.isArray(doc.models) ? doc.models : null;
  if (!list) return null;
  return list
    .filter((m) => m && typeof m.slug === 'string' && (m.visibility === undefined || m.visibility === 'list'))
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
    .map((m) => ({
      id: m.slug,
      label: clean(m.display_name || m.slug, 80),
      default: false,
      source: 'cli',
      note: m.description ? clean(m.description) : null,
      alias_of: null,
    }));
}

/**
 * The model config.toml sets: the top-level `model`, or the `model` of the
 * profile a top-level `profile` names. A line reader, enough for these two keys.
 */
function parseCodexConfigModel(text) {
  const values = { '': {} };
  let section = '';
  for (const raw of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/^\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const head = /^\[([^\]]+)\]\s*(#.*)?$/.exec(line);
    if (head) {
      section = head[1].trim();
      if (!values[section]) values[section] = {};
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*("((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(line);
    if (kv) values[section][kv[1]] = kv[3] !== undefined ? kv[3] : kv[4];
  }
  const profile = values[''].profile;
  if (profile && values[`profiles.${profile}`] && values[`profiles.${profile}`].model) {
    return { model: values[`profiles.${profile}`].model, profile };
  }
  return { model: values[''].model || null, profile: null };
}

async function detectCodex({ homeDir, env, run }) {
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(homeDir, '.codex');
  let models = null;
  let source = null;
  const cacheFile = path.join(codexHome, 'models_cache.json');
  const cached = parseCodexCatalog(readJsonFile(cacheFile));
  if (cached && cached.length) {
    models = cached;
    source = { kind: 'cli', where: homeRelative(cacheFile, homeDir), note: msg('model.source.codex_cache') };
  } else {
    const bundled = await run('codex', ['debug', 'models', '--bundled']);
    let doc = null;
    try {
      doc = bundled.ok ? JSON.parse(bundled.stdout) : null;
    } catch (err) {
      doc = null;
    }
    const list = parseCodexCatalog(doc);
    if (list && list.length) {
      models = list;
      source = { kind: 'cli', where: 'codex debug models --bundled', note: msg('model.source.codex_bundled') };
    }
  }
  if (!models) {
    models = [];
    source = { kind: 'none', where: null, note: msg('model.source.none') };
  }
  let configText = '';
  try {
    configText = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  } catch (err) {
    configText = '';
  }
  const configured = parseCodexConfigModel(configText);
  if (configured.model) {
    const hit = models.find((m) => m.id === configured.model);
    if (hit) {
      hit.default = true;
    } else {
      models.unshift({
        id: configured.model, label: configured.model, default: true, source: 'config',
        note: msg('model.note.config.codex'), alias_of: null,
      });
      if (source.kind === 'none') source = { kind: 'config', where: homeRelative(path.join(codexHome, 'config.toml'), homeDir), note: msg('model.source.codex_config') };
    }
  }
  source.default_from = configured.model ? homeRelative(path.join(codexHome, 'config.toml'), homeDir) : null;
  return { models, source };
}

// --- running a CLI for its help or its catalog ------------------------------------------

/**
 * Run a CLI with arguments that start no session, collect its standard
 * output. Never throws: { ok, stdout }.
 */
async function runCli(name, args, { env = process.env, timeoutMs = 20000 } = {}) {
  try {
    const lib = require(path.join(SCAFFOLD_ROOT, 'providers', 'lib', 'cli-spawn.js'));
    const bin = lib.resolveBinary(name, name === 'claude' ? 'CLAUDE_BIN' : 'CODEX_BIN', { env });
    if (!bin.found) return { ok: false, stdout: '' };
    const childEnv = Object.assign({}, env);
    delete childEnv.CLAUDECODE;
    delete childEnv.CLAUDE_CODE_ENTRYPOINT;
    const lines = [];
    const proc = await lib.spawnCli({
      bin, args, cwd: os.tmpdir(), env: childEnv, timeoutMs, onStdout: (line) => lines.push(line),
    });
    return { ok: proc.code === 0, stdout: lines.join('\n') };
  } catch (err) {
    return { ok: false, stdout: '' };
  }
}

/**
 * The models of one tool.
 * @param {'claude'|'codex'} tool
 * @param {{installed: boolean, fake?: boolean, homeDir?: string, env?: object,
 *          run?: (name: string, args: string[]) => Promise<{ok, stdout}>}} options
 * @returns {Promise<{jobs: string[], models: object[], models_source: object, models_detected_at: string}>}
 */
async function detectModels(tool, options = {}) {
  const jobs = JOBS[tool].slice();
  const at = nowIso();
  if (options.fake) return fakeModels(tool, options.installed);
  if (!options.installed) {
    return { jobs, models: [], models_source: { kind: 'none', where: null, note: msg('model.source.not_installed') }, models_detected_at: at };
  }
  const env = options.env || process.env;
  const deps = {
    homeDir: options.homeDir || os.homedir(),
    env,
    run: options.run || ((name, args) => runCli(name, args, { env })),
  };
  let found;
  try {
    found = tool === 'claude' ? await detectClaude(deps) : await detectCodex(deps);
  } catch (err) {
    found = { models: [], source: { kind: 'none', where: null, note: msg('model.source.none') } };
  }
  return { jobs, models: found.models, models_source: found.source, models_detected_at: at };
}

/** The fixed list of fake mode, at once. */
function fakeModels(tool, installed) {
  return {
    jobs: JOBS[tool].slice(),
    models: installed ? FAKE_MODELS[tool].map((m) => Object.assign({}, m, { source: 'fake', note: msg('model.note.fake'), alias_of: null })) : [],
    models_source: { kind: installed ? 'fake' : 'none', where: null, note: msg(installed ? 'model.source.fake' : 'model.source.not_installed') },
    models_detected_at: nowIso(),
  };
}

/** 'default' (null), 'listed' (a model of the list) or 'custom' (a name typed by the person). */
function modelStatus(value, models) {
  if (value === null || value === undefined) return 'default';
  return (models || []).some((m) => m.id === value || m.alias_of === value) ? 'listed' : 'custom';
}

module.exports = {
  JOBS, FAKE_MODELS, detectModels, fakeModels, modelStatus,
  parseClaudeCatalog, parseClaudeHelp, parseCodexCatalog, parseCodexConfigModel, claudeCatalogFile, homeRelative,
};
