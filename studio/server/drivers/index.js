'use strict';
/**
 * Which tool does which job.
 *
 * Three verbs: plan (run a scaffold command and write files), look (read an
 * image and answer), draw (produce an image). Claude Code plans and looks;
 * Codex plans, looks and draws. A project's settings name one driver per
 * verb. When that one is not installed the other installed driver takes the
 * verb, and the result says which tool did the work.
 *
 * Every driver has the same interface:
 *   detect() -> { installed, version }
 *   run({ cwd, addDirs, prompt, schema, images, model, allowWrite,
 *         sessionId, signal, onEvent })
 *     -> { ok, structured, text, sessionId, costUsd, durationMs, error }
 *
 * In fake mode (STUDIO_FAKE_AI=1) the fake driver stands in for both tools
 * under their own names, so the same code paths run with no CLI.
 */

const claude = require('./claude');
const codex = require('./codex');
const fake = require('./fake');
const models = require('../models');
const { msg } = require('../i18n');

const DRIVERS = { claude, codex };
const OTHER = { claude: 'codex', codex: 'claude' };
const DETECT_TTL_MS = 60000;

/**
 * @param {{fake?: boolean, fakeTools?: string[], modelOptions?: object}} options
 *   fakeTools: the tools the fake reports as installed (default both).
 *   modelOptions: passed to models.detectModels (tests point it at a
 *   temporary home and a stub runner).
 */
function createDrivers(options = {}) {
  const isFake = !!options.fake;
  const fakeTools = options.fakeTools || ['claude', 'codex'];
  let cached = null;
  let cachedAt = 0;
  // The model lists: found once at start and on request, never per request.
  let modelLists = null;
  let modelsPending = null;

  function installedTools(refresh) {
    if (isFake) {
      const out = {};
      for (const name of Object.keys(DRIVERS)) {
        const installed = fakeTools.includes(name);
        out[name] = { installed, version: installed ? 'fake' : null, fake: true };
      }
      return out;
    }
    if (!cached || refresh || Date.now() - cachedAt > DETECT_TTL_MS) {
      cached = {};
      for (const [name, driver] of Object.entries(DRIVERS)) {
        const found = driver.detect();
        cached[name] = { installed: !!found.installed, version: found.version || null };
      }
      cachedAt = Date.now();
    }
    return cached;
  }

  /** Look for the models of every tool again. Resolves with the lists. */
  function refreshModels() {
    if (modelsPending) return modelsPending;
    const tools = installedTools(true);
    if (isFake) {
      modelLists = {};
      for (const name of Object.keys(DRIVERS)) modelLists[name] = models.fakeModels(name, tools[name].installed);
      return Promise.resolve(modelLists);
    }
    modelsPending = (async () => {
      const lists = {};
      for (const name of Object.keys(DRIVERS)) {
        lists[name] = await models.detectModels(name, Object.assign({}, options.modelOptions || {}, {
          installed: tools[name].installed, fake: isFake,
        }));
      }
      modelLists = lists;
      return lists;
    })().finally(() => { modelsPending = null; });
    return modelsPending;
  }

  /** The list of a tool, or a placeholder while the first detection runs. */
  function modelsOf(name) {
    if (modelLists && modelLists[name]) return modelLists[name];
    return {
      jobs: models.JOBS[name].slice(), models: [], models_source: { kind: 'detecting', where: null, note: msg('model.source.detecting') },
      models_detected_at: null,
    };
  }

  /**
   * { claude: { installed, version, jobs, models, models_source, models_detected_at }, codex: {...} }
   * `refresh` looks for the tools again (the model lists change only through refreshModels).
   */
  function detect(refresh = false) {
    const tools = installedTools(refresh);
    if (!modelLists && !modelsPending) refreshModels().catch(() => {});
    const out = {};
    for (const [name, info] of Object.entries(tools)) out[name] = Object.assign({}, info, modelsOf(name));
    return out;
  }

  /**
   * The driver for a verb under a project's settings.
   * @returns {{available: boolean, name: string|null, requested: string, fallback: boolean,
   *            driver: object|null, model: string|null, fake: boolean, reason: string|null}}
   */
  function pick(verb, settings) {
    const requested = settings.drivers[verb];
    const tools = detect();
    const base = { requested, fake: isFake, driver: null, model: null, name: null, fallback: false, available: false, reason: null };
    if (verb === 'draw') {
      if (requested === 'manual') {
        return Object.assign(base, { reason: msg('reason.draw_manual') });
      }
      if (!tools.codex.installed) {
        return Object.assign(base, { reason: msg('reason.no_codex') });
      }
      return Object.assign(base, {
        available: true, name: 'codex', driver: isFake ? fake : codex, model: settings.models.codex.draw || null,
      });
    }
    let name = requested;
    if (!tools[name] || !tools[name].installed) {
      const other = OTHER[requested];
      if (!other || !tools[other].installed) {
        return Object.assign(base, { reason: msg('reason.no_tools') });
      }
      name = other;
    }
    return Object.assign(base, {
      available: true,
      name,
      fallback: name !== requested,
      driver: isFake ? fake : DRIVERS[name],
      model: (settings.models[name] && settings.models[name][verb]) || null,
    });
  }

  /** Per-verb summary for the API: which tool would do each job right now. */
  function assignment(settings) {
    const out = {};
    for (const verb of ['plan', 'look', 'draw']) {
      const p = pick(verb, settings);
      out[verb] = {
        requested: p.requested, tool: p.name, available: p.available, fallback: p.fallback, model: p.model, reason: p.reason,
      };
    }
    return out;
  }

  /** Per tool and verb: whether the model setting is the tool's default, a listed model, or a custom name. */
  function modelStatus(settings) {
    const out = {};
    for (const name of Object.keys(DRIVERS)) {
      out[name] = {};
      for (const verb of Object.keys(settings.models[name] || {})) {
        out[name][verb] = models.modelStatus(settings.models[name][verb], modelsOf(name).models);
      }
    }
    return out;
  }

  /** Resolves once the first model detection has finished (tests, the refresh route). */
  function modelsReady() {
    if (modelLists && !modelsPending) return Promise.resolve(modelLists);
    return modelsPending || refreshModels();
  }

  return { fake: isFake, detect, pick, assignment, refreshModels, modelsReady, modelStatus };
}

module.exports = { createDrivers, DRIVERS };
