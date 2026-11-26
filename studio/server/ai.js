'use strict';
/**
 * One AI call inside a job step: pick the driver for the verb, build the
 * prompt, run it with the scaffold root as working directory and the project
 * directory added, and read the headless contract's result.
 */

const prompts = require('./prompts');
const { msg } = require('./i18n');
const S = require('./scaffold');
const { NeedsDecision, OpError } = require('./jobs');
const { SCAFFOLD_ROOT, abortError } = require('./util');

const TOOL_LABELS = { claude: 'Claude Code', codex: 'Codex' };

function aiTimeoutMs() {
  const value = Number.parseInt(process.env.STUDIO_AI_TIMEOUT_MS || '', 10);
  return Number.isFinite(value) && value > 0 ? value : 30 * 60 * 1000;
}

function projectContext(project) {
  let doc = null;
  try {
    doc = S.ws.loadProject(project.root);
  } catch (err) {
    doc = null;
  }
  return {
    workspace: project.root,
    // What the person reads comes in the interface language; the story in the project's.
    interfaceLanguage: project.settings().language,
    language: (doc && doc.language) || 'en',
    comicFormat: (doc && doc.comic_format) || 'paged',
  };
}

/**
 * @param {object} ctx job context (project, signal, answers, services, job)
 * @param {object} handle step handle (setTool, log)
 * @param {{verb: 'plan'|'look', kind: string, vars: object, images?: string[],
 *          allowWrite?: boolean, dataSchema?: object, sessionId?: string,
 *          fakeText?: string}} call
 *   kind: a prompt template name. fakeText: the person's own words, which
 *   the fake driver scans for its test markers.
 * @returns {Promise<object>} the contract result plus { tool, sessionId, costUsd, durationMs, fallback }
 */
async function runAi(ctx, handle, call) {
  const { project } = ctx;
  const settings = project.settings();
  const pick = ctx.services.drivers.pick(call.verb, settings);
  if (!pick.available) {
    throw new OpError('no_tool', msg('error.no_tool', { reason: pick.reason }));
  }
  handle.setTool(pick.name);
  if (pick.fallback) {
    handle.log(`${TOOL_LABELS[pick.requested] || pick.requested} is not installed: ${TOOL_LABELS[pick.name]} does this step instead`);
  }
  const context = projectContext(project);
  const allowWrite = call.allowWrite !== false;
  const prompt = prompts.build(call.kind, call.vars || {}, Object.assign({ answers: ctx.answers, readOnly: !allowWrite }, context));
  const started = Date.now();
  handle.log(`${TOOL_LABELS[pick.name]} started${pick.model ? ` (${pick.model})` : ''}`);
  const result = await pick.driver.run({
    cwd: SCAFFOLD_ROOT,
    addDirs: [project.dir],
    prompt,
    schema: prompts.contractSchema(call.dataSchema),
    images: call.images || [],
    model: pick.model,
    allowWrite,
    sessionId: call.sessionId || null,
    signal: ctx.signal,
    onEvent: (event) => {
      if (event && event.text) handle.log(event.text);
    },
    workspace: project.root,
    tmpDir: project.tmpDir,
    timeoutMs: aiTimeoutMs(),
    // Read by the fake driver only: what this call is, without parsing the prompt.
    task: {
      kind: call.kind,
      vars: call.vars || {},
      root: project.root,
      projectDir: project.dir,
      answers: ctx.answers || {},
      text: call.fakeText || '',
      tool: pick.name,
      allowWrite,
    },
  });
  if (ctx.signal.aborted || result.cancelled) throw abortError();
  const seconds = Math.max(1, Math.round((result.durationMs || (Date.now() - started)) / 1000));
  if (typeof result.costUsd === 'number') {
    ctx.job.cost_usd = Math.round(((ctx.job.cost_usd || 0) + result.costUsd) * 10000) / 10000;
  }
  if (!result.ok) {
    throw new OpError('ai_failed', msg('error.ai_failed', { tool: TOOL_LABELS[pick.name], detail: result.error || 'no reason given' }));
  }
  const out = result.structured;
  if (!out || typeof out !== 'object' || typeof out.status !== 'string') {
    const said = String(result.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    throw new OpError('ai_bad_result', msg('error.ai_bad_result', { tool: TOOL_LABELS[pick.name], detail: said || '-' }));
  }
  handle.log(`${TOOL_LABELS[pick.name]} finished in ${seconds} s: ${String(out.summary || '').replace(/\s+/g, ' ').slice(0, 300)}`);
  for (const decision of Array.isArray(out.decisions) ? out.decisions : []) handle.log(`decided: ${String(decision).slice(0, 300)}`);
  if (out.status === 'needs_decision') {
    const questions = Array.isArray(out.questions) ? out.questions.filter((q) => q && q.question) : [];
    if (!questions.length) {
      throw new OpError('ai_bad_result', msg('error.ai_bad_result', { tool: TOOL_LABELS[pick.name], detail: 'needs_decision with no questions' }));
    }
    throw new NeedsDecision(questions, out.summary);
  }
  if (out.status === 'failed') {
    // The summary is the tool's own explanation, written in the interface language.
    throw new OpError('ai_reported_failure', msg('error.ai_reported_failure', { tool: TOOL_LABELS[pick.name], detail: String(out.summary || '-') }));
  }
  return Object.assign({}, out, {
    files_written: Array.isArray(out.files_written) ? out.files_written.map(String) : [],
    decisions: Array.isArray(out.decisions) ? out.decisions.map(String) : [],
    data: out.data && typeof out.data === 'object' ? out.data : {},
    tool: pick.name,
    fallback: pick.fallback,
    sessionId: result.sessionId || null,
    costUsd: typeof result.costUsd === 'number' ? result.costUsd : null,
    durationMs: result.durationMs || (Date.now() - started),
  });
}

module.exports = { runAi, projectContext, TOOL_LABELS };
