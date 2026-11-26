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

const DRIVERS = { claude, codex };
const OTHER = { claude: 'codex', codex: 'claude' };
const DETECT_TTL_MS = 60000;

/**
 * @param {{fake?: boolean, fakeTools?: string[]}} options
 *   fakeTools: the tools the fake reports as installed (default both).
 */
function createDrivers(options = {}) {
  const isFake = !!options.fake;
  const fakeTools = options.fakeTools || ['claude', 'codex'];
  let cached = null;
  let cachedAt = 0;

  /** { claude: { installed, version }, codex: { installed, version } } */
  function detect(refresh = false) {
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
        return Object.assign(base, { reason: 'The project is set to draw by hand.' });
      }
      if (!tools.codex.installed) {
        return Object.assign(base, { reason: 'Codex is not installed, and it is the only tool here that draws.' });
      }
      return Object.assign(base, {
        available: true, name: 'codex', driver: isFake ? fake : codex, model: settings.models.codex.draw || null,
      });
    }
    let name = requested;
    if (!tools[name] || !tools[name].installed) {
      const other = OTHER[requested];
      if (!other || !tools[other].installed) {
        return Object.assign(base, { reason: 'Neither Claude Code nor Codex is installed.' });
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

  return { fake: isFake, detect, pick, assignment };
}

module.exports = { createDrivers, DRIVERS };
