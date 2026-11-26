'use strict';
/**
 * The mechanical half of making a page, shared by the operations: build the
 * reference plan, compile the prompt package, draw through the scaffold's
 * generate-assets.js, have the look driver review the render, and write the
 * review file by the review rules of docs/data-model.md.
 *
 * Tooling never certifies artwork: what this file writes about a drawing
 * comes from a reviewer that opened the image. The mechanical gates
 * (validateWorkspace, checkContinuity) are reported separately.
 */

const fs = require('fs');
const path = require('path');
const S = require('./scaffold');
const prompts = require('./prompts');
const timings = require('./timings');
const i18n = require('./i18n');

const { msg } = i18n;
const { runAi, TOOL_LABELS } = require('./ai');
const { OpError } = require('./jobs');
const { abortError, today, toPosix } = require('./util');

const RENDER_RE = /^(PG_\d{3}_\d{3}|CV_\d{3})_V\d{2}$/;
const ASSET_RE = /^(CHAR|LOC|PROP|LOOK)_[A-Z][A-Z0-9_]*_V\d{2}$/;
const PAGE_RENDER_RE = /^PG_\d{3}_\d{3}_V\d{2}$/;

// --- small workspace helpers --------------------------------------------------

/** What a render belongs to: { kind: 'page'|'cover', id, issue } or null. */
function ownerOfRender(renderId) {
  const ws = S.ws;
  const pageId = ws.pageOfRender(renderId);
  if (pageId) return { kind: 'page', id: pageId, issue: ws.issueOfPage(pageId) };
  const coverId = typeof ws.coverOfRender === 'function' ? ws.coverOfRender(renderId) : null;
  return coverId ? { kind: 'cover', id: coverId, issue: ws.issueOfCover(coverId) } : null;
}

function ownerDir(root, owner) {
  return owner.kind === 'cover' ? S.ws.coverDir(root, owner.issue) : S.ws.pageDir(root, owner.id);
}

function planFileOf(root, owner) {
  return path.join(ownerDir(root, owner), owner.kind === 'cover' ? 'cover.yaml' : 'page.yaml');
}

function loadOwnerDoc(root, owner) {
  return S.ws.loadYaml(planFileOf(root, owner));
}

/** Render IDs of a page or a cover, oldest first. */
function listRendersOf(root, owner) {
  return owner.kind === 'cover' ? S.ws.listCoverRenders(root, owner.issue) : S.ws.listRenders(root, owner.id);
}

/** Change top-level scalar keys of a YAML file, keeping its comments when possible. */
function setTopLevel(file, changes) {
  const edit = S.yamlEdit;
  if (edit && typeof edit.rewriteYamlFile === 'function') {
    return edit.rewriteYamlFile(file, (doc) => { Object.assign(doc, changes); }, (lines) => {
      for (const [key, value] of Object.entries(changes)) {
        const range = edit.findKey(lines, key, 0);
        if (!range) return false;
        if (edit.setValue(lines, range, value) === false) return false;
      }
      return true;
    });
  }
  const doc = S.ws.loadYaml(file) || {};
  Object.assign(doc, changes);
  fs.writeFileSync(file, S.yaml.stringify(doc));
  return { changed: true, preserved: false, doc };
}

/** Move a page through the pipeline: status and current_render. */
function setPageState(root, pageId, changes) {
  const file = path.join(S.ws.pageDir(root, pageId), 'page.yaml');
  const page = S.ws.loadYaml(file);
  if (!page) return;
  const wanted = {};
  for (const [key, value] of Object.entries(changes)) {
    if (page[key] !== value) wanted[key] = value;
  }
  if (Object.keys(wanted).length) setTopLevel(file, wanted);
}

/** The generation record that produced a render, with its file; or null. */
function recordOfRender(root, renderId) {
  const owner = ownerOfRender(renderId);
  if (!owner) return null;
  const dir = path.join(root, 'generations', owner.id);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^GEN_.+\.ya?ml$/i.test(n)).sort();
  } catch (err) {
    return null;
  }
  for (const name of names.reverse()) {
    let doc = null;
    try {
      doc = S.ws.loadYaml(path.join(dir, name));
    } catch (err) {
      doc = null;
    }
    if (doc && doc.output_render === renderId) return { file: path.join(dir, name), doc };
  }
  return null;
}

/** The request as sent for a record: the JSON written next to it, or null. */
function requestOfRecord(record) {
  if (!record) return null;
  const file = record.file.replace(/\.ya?ml$/i, '.request.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

/** Mark the record of a replaced render as rejected (the file stays on disk). */
function markRejected(root, renderId, why) {
  const record = recordOfRender(root, renderId);
  if (!record || record.doc.status === 'rejected') return;
  const doc = Object.assign({}, record.doc, { status: 'rejected' });
  doc.notes = [record.doc.notes, why].filter(Boolean).join(' ');
  fs.writeFileSync(record.file, S.yaml.stringify(doc));
}

/** Repair cycles the studio spends on its own before it stops and shows the page as flagged. */
function repairLimit(project) {
  const doc = S.ws.loadProject(project.root) || {};
  const scaffoldMax = doc.repair_policy && Number.isInteger(doc.repair_policy.max_cycles) ? doc.repair_policy.max_cycles : 2;
  const override = project.settings().repair_limit;
  return Number.isInteger(override) ? Math.min(override, scaffoldMax) : scaffoldMax;
}

// --- mechanical gates -----------------------------------------------------------

/**
 * The two mechanical gates for an issue (or the whole workspace).
 * @returns {{continuity: object[], validation: {errors: object[], warnings: object[]}, errors: number}}
 */
function mechanical(root, issue) {
  let continuity = [];
  let validation = { errors: [], warnings: [] };
  try {
    continuity = S.checkContinuity(root, issue ? { issue } : {}).findings.map((f) => {
      let hint = null;
      try {
        hint = S.hintFor(f) || null;
      } catch (err) {
        hint = null;
      }
      return Object.assign({ hint }, f);
    });
  } catch (err) {
    continuity = [{ code: 'CHECK_FAILED', severity: 'error', issue: issue || null, page: null, panel: null, entity: null, message: err.message, hint: null }];
  }
  try {
    const result = S.validateWorkspace(root, issue ? { issue } : {});
    validation = { errors: result.errors || [], warnings: result.warnings || [] };
  } catch (err) {
    validation = { errors: [{ file: '', code: 'VALIDATE_FAILED', message: err.message }], warnings: [] };
  }
  const errors = continuity.filter((f) => f.severity === 'error').length + validation.errors.length;
  return { continuity, validation, errors };
}

// --- draw target ------------------------------------------------------------------

/** Which image provider draws for this project right now. */
function drawTarget(ctx) {
  const settings = ctx.project.settings();
  const pick = ctx.services.drivers.pick('draw', settings);
  const hasCodexCli = S.providerIds().includes('codex-cli');
  if (pick.available && !hasCodexCli) {
    return { available: false, provider: 'manual', tool: null, model: null, reason: msg('reason.no_codex_provider') };
  }
  return {
    available: pick.available,
    provider: pick.available ? 'codex-cli' : 'manual',
    tool: pick.available ? 'codex' : null,
    model: pick.model,
    reason: pick.reason,
  };
}

/** The provider prompt packages are compiled for: the draw provider, or manual for a handoff. */
function compileProvider(project, drivers) {
  const pick = drivers.pick('draw', project.settings());
  return pick.available && S.providerIds().includes('codex-cli') ? 'codex-cli' : 'manual';
}

// --- compile ------------------------------------------------------------------------

function pipelineMessage(err) {
  return err && err.message ? err.message : String(err);
}

/** Build and write reference-plan.yaml of a page. Throws OpError with the scaffold's reason. */
function buildPlan(root, pageId, provider) {
  const page = S.ws.loadPage(root, pageId);
  if (!page) throw new OpError('page_missing', `${pageId} has no page.yaml.`);
  let result;
  try {
    result = S.buildReferencePlan(root, page, { providerId: provider });
  } catch (err) {
    throw new OpError(err.code || 'reference_plan_failed', pipelineMessage(err));
  }
  const file = path.join(S.ws.pageDir(root, pageId), 'reference-plan.yaml');
  S.pipeline.assertValid('reference-plan', result.doc, `reference plan of ${pageId}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, S.yaml.stringify(result.doc));
  return { file: S.ws.rel(root, file), doc: result.doc };
}

/**
 * What stops a page from being drawn right now, without writing anything:
 * [{ code, message }]. Empty when the reference plan can be built.
 */
function pageBlockers(root, pageId, provider) {
  const page = S.ws.loadPage(root, pageId);
  if (!page) return [blockerOf('page_missing', `${pageId} has no page.yaml.`, pageId)];
  const out = [];
  if (!S.ws.loadStyleBlock(root)) {
    out.push(blockerOf('style_block_missing', 'The style is not defined yet: there is no style block.', pageId));
  }
  try {
    S.buildReferencePlan(root, page, { providerId: provider });
  } catch (err) {
    out.push(blockerOf(err.code || 'reference_plan_failed', pipelineMessage(err), pageId));
  }
  return out;
}

/**
 * One blocker: { code, message, detail }. `message` is the sentence the
 * person reads (blocker.<code> in the dictionary); `detail` keeps the
 * scaffold script's own text, which names the files and the fix.
 */
function blockerOf(code, detail, pageId) {
  const key = i18n.has(`blocker.${code}`) ? `blocker.${code}` : 'blocker.other';
  const who = /\b((?:CHAR|LOC|PROP|LOOK)_[A-Z][A-Z0-9_]*?)(?:_[A-Z]+)?(?:_MASTER)?(?:_V\d{2})?\b/.exec(String(detail || ''));
  return {
    code,
    message: msg(key, { page: pageId || '', entity: who ? who[1] : '', detail: String(detail || '') }),
    detail: String(detail || ''),
  };
}

/** Compile and write the prompt package of a page (a repair when repairReview is given). */
function compilePage(root, pageId, provider, options = {}) {
  const page = S.ws.loadPage(root, pageId);
  if (!page) throw new OpError('page_missing', `${pageId} has no page.yaml.`);
  let result;
  try {
    result = S.compilePage(root, page, {
      providerId: provider,
      model: options.model || undefined,
      repairReview: options.repairReview || undefined,
    });
    S.pipeline.assertValid('prompt-package', result.pkg, `prompt package ${result.pkg.id}`);
  } catch (err) {
    throw new OpError(err.code || 'compile_failed', pipelineMessage(err));
  }
  const file = path.join(S.ws.pageDir(root, pageId), 'prompts', result.fileName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, S.yaml.stringify(result.pkg));
  return { file, rel: S.ws.rel(root, file), pkg: result.pkg, warnings: result.warnings };
}

/** Compile and write the package of a reference sheet. */
function compileSheet(root, entityId, provider, options = {}) {
  let result;
  try {
    result = S.compileAsset(root, entityId, Object.assign({ providerId: provider }, options));
    S.pipeline.assertValid('prompt-package', result.pkg, `prompt package ${result.pkg.id}`);
  } catch (err) {
    throw new OpError(err.code || 'compile_failed', pipelineMessage(err));
  }
  const file = S.ws.abs(root, result.fileRel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, S.yaml.stringify(result.pkg));
  return { file, rel: result.fileRel, pkg: result.pkg, warnings: result.warnings, notes: result.notes || [] };
}

/** Compile and write the package of a cover (a repair when `repair` is a review document). */
function compileCover(root, issueId, provider, options = {}) {
  let result;
  try {
    result = S.compileCover({
      root, issue: issueId, provider, model: options.model || undefined, repair: options.repair || undefined, write: true,
    });
  } catch (err) {
    throw new OpError(err.code || 'compile_failed', pipelineMessage(err));
  }
  const rel = result.fileRel || toPosix(path.join('issues', issueId, 'cover', 'prompts', result.fileName));
  const file = S.ws.abs(root, rel);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, S.yaml.stringify(result.pkg));
  }
  return { file, rel, pkg: result.pkg, warnings: result.warnings };
}

// --- draw ------------------------------------------------------------------------------

/**
 * Run one compiled package live through generate-assets.js.
 * @param {object} ctx job context
 * @param {object} handle step handle
 * @param {string} packageFile absolute path of the compiled package
 * @param {{providerModule?: object}} [options] a provider module to run the
 *   package with instead of its own (the upload of a hand-made image)
 * @returns {Promise<{record: string, recordFile: string, file: string, render: string|null, warnings: string[]}>}
 */
async function draw(ctx, handle, packageFile, options = {}) {
  const root = ctx.project.root;
  const log = (line) => {
    const text = String(line || '').trim();
    if (text) handle.log(text);
  };
  let result;
  if (options.providerModule) {
    let items;
    try {
      items = S.collectPackages({ package: packageFile }).items;
    } catch (err) {
      throw new OpError(err.code || 'draw_failed', pipelineMessage(err));
    }
    if (!items.length) throw new OpError('draw_failed', 'There is no prompt package to run.');
    try {
      result = await S.runPackage(items[0], { live: true, log, providerModule: options.providerModule, signal: ctx.signal });
    } catch (err) {
      throw new OpError(err.code || 'draw_failed', pipelineMessage(err));
    }
  } else {
    let outcome;
    const started = Date.now();
    const timing = (ok) => {
      const rel = toPosix(String(packageFile));
      const kind = /\/cover\//.test(rel) ? 'cover' : /\/pages\//.test(rel) ? 'page' : 'sheet';
      timings.record(ctx.project, {
        tool: 'codex', model: drawTarget(ctx).model, job: 'draw', kind, op: ctx.job && ctx.job.op,
        ms: Date.now() - started, ok, pages: kind === 'page' ? 1 : null,
      });
    };
    try {
      outcome = await S.generateAssets({
        package: packageFile,
        live: true,
        yes: true,
        log,
        signal: ctx.signal,
        onProgress: log,
      });
    } catch (err) {
      if (ctx.signal.aborted) throw abortError();
      timing(false);
      throw new OpError(err.code || 'draw_failed', pipelineMessage(err));
    }
    if (ctx.signal.aborted) throw abortError();
    const drawnRecord = outcome.results[0] && outcome.results[0].record;
    timing(!!drawnRecord && drawnRecord.status === 'succeeded');
    if (!outcome.results.length) {
      throw new OpError('draw_failed', outcome.failures[0] || 'The image was not drawn.');
    }
    result = outcome.results[0];
  }
  const record = result.record;
  const error = record.response && record.response.error;
  if (record.status !== 'succeeded') {
    if (error === 'cancelled' || ctx.signal.aborted) throw abortError();
    throw new OpError('draw_failed', msg('error.draw_failed', { detail: error || `the record ended as ${record.status}` }));
  }
  const media = (record.media_files || [])[0] || null;
  if (!media || !fs.existsSync(S.ws.abs(root, media))) {
    throw new OpError('draw_failed', 'The drawing tool reported success but no image file was saved.');
  }
  let render = record.output_render || null;
  if (!render) {
    const stem = path.basename(media).replace(/\.[^.]+$/, '');
    if (RENDER_RE.test(stem)) render = stem;
  }
  return {
    record: record.id,
    recordFile: S.ws.rel(root, result.recordFile),
    file: toPosix(media),
    render,
    warnings: result.warnings || [],
    notes: record.notes || null,
  };
}

// --- review ------------------------------------------------------------------------------

/** Which tool drew a render: 'codex', 'person', or null when the record does not say. */
function drawerOf(root, renderId) {
  const record = recordOfRender(root, renderId);
  if (!record) return null;
  if (record.doc.provider === 'codex-cli') return 'codex';
  if (record.doc.provider === 'manual' || record.doc.provider === 'harness-native') return 'person';
  return record.doc.provider || null;
}

function cleanText(value, fallback) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function nextFindingId(findings) {
  let max = 0;
  for (const f of findings) {
    const m = /^F(\d{2})$/.exec(String(f && f.id));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `F${String(max + 1).padStart(2, '0')}`;
}

/**
 * Compose a review document from what the reviewer returned, by the review
 * rules: any open finding, failed gate, open change request or check nobody
 * judged makes it flagged; no findings and every check passing is a pass;
 * findings that were all repaired and rechecked make it fixed.
 */
function composeReview(input) {
  const {
    owner, render, supersedes, previous, existing, returned, independent, repairCycle, references, neighbors,
    toolLabel, panelIds, notApplicable,
  } = input;
  // The words the studio adds to a review file are in the project's interface language.
  const say = (key, params) => i18n.t(input.lang || 'en', key, params);
  const requests = Array.isArray(input.requests) ? input.requests : [];
  const data = returned && typeof returned === 'object' ? returned : {};

  // Checks: all fourteen, each with a result and evidence.
  const checks = {};
  for (const key of prompts.REVIEW_CHECKS) {
    const given = data.checks && typeof data.checks === 'object' ? data.checks[key] : null;
    const result = given && ['pass', 'fail', 'not_applicable'].includes(given.result) ? given.result : null;
    if (notApplicable.includes(key) && result !== 'fail') {
      checks[key] = {
        result: 'not_applicable',
        evidence: cleanText(given && given.evidence, say('review.evidence.cover_na')),
      };
    } else if (result) {
      checks[key] = { result, evidence: cleanText(given.evidence, say('review.evidence.missing')) };
    } else {
      checks[key] = { result: 'not_performed', evidence: say('review.evidence.not_returned') };
    }
  }

  // Findings kept from before.
  const findings = [];
  const rechecks = new Map((Array.isArray(data.rechecks) ? data.rechecks : [])
    .filter((r) => r && r.id).map((r) => [String(r.id), r]));
  if (existing && Array.isArray(existing.findings)) {
    // A second look at the same render: what was settled stays, a person's
    // open request stays, and the reviewer's own open findings are judged again.
    for (const f of existing.findings) {
      if (!f || typeof f !== 'object') continue;
      if (f.status !== 'open' || f.source === 'user_request') findings.push(Object.assign({}, f));
    }
  } else if (previous && Array.isArray(previous.findings)) {
    for (const f of previous.findings) {
      if (!f || typeof f !== 'object') continue;
      const copy = Object.assign({}, f);
      if (f.status === 'open') {
        const re = rechecks.get(String(f.id));
        if (re && re.fixed === true) {
          copy.status = 'fixed';
          copy.recheck = { render, evidence: cleanText(re.evidence, say('review.recheck.default', { render })) };
        }
      }
      findings.push(copy);
    }
  }

  // Changes a person asked for that a fresh drawing was meant to carry (a
  // redraw from an updated plan has no earlier render to recheck against).
  for (const request of requests) {
    const re = rechecks.get(String(request.id));
    const finding = {
      id: nextFindingId(findings),
      panel: null,
      source: 'user_request',
      expected: say('review.request.expected'),
      visible: cleanText(re && re.evidence, say('review.request.visible_missing')),
      severity: 'minor',
      repair: cleanText(request.text, say('review.request.repair_default')),
      status: 'open',
    };
    if (re && re.fixed === true) {
      finding.status = 'fixed';
      finding.recheck = { render, evidence: cleanText(re.evidence, say('review.recheck.default', { render })) };
    }
    findings.push(finding);
  }

  // New findings from this look.
  for (const f of Array.isArray(data.findings) ? data.findings : []) {
    if (!f || typeof f !== 'object') continue;
    const finding = {
      id: nextFindingId(findings),
      panel: f.panel && panelIds.includes(String(f.panel)) ? String(f.panel) : null,
      check: prompts.REVIEW_CHECKS.includes(f.check) ? f.check : 'drawing_clarity',
      expected: cleanText(f.expected, say('review.finding.expected_default')),
      visible: cleanText(f.visible, say('review.finding.visible_default')),
      severity: f.severity === 'minor' ? 'minor' : 'blocking',
      repair: cleanText(f.repair, say('review.finding.repair_default')),
      status: 'open',
    };
    findings.push(finding);
  }

  // A failed check with no open finding behind it still has to be visible as one.
  for (const key of prompts.REVIEW_CHECKS) {
    if (checks[key].result !== 'fail') continue;
    if (findings.some((f) => f.status === 'open' && f.check === key)) continue;
    findings.push({
      id: nextFindingId(findings),
      panel: null,
      check: key,
      expected: say('review.failed_check.expected', { check: key.replace(/_/g, ' ') }),
      visible: checks[key].evidence,
      severity: 'blocking',
      repair: say('review.failed_check.repair'),
      status: 'open',
    });
  }

  const gateOf = (name) => (data.gates && ['pass', 'fail'].includes(data.gates[name]) ? data.gates[name] : 'not_performed');
  const gates = { style_fidelity: gateOf('style_fidelity'), narrative_continuity: gateOf('narrative_continuity') };

  // The review rules of docs/data-model.md: flagged is for an open blocking
  // finding, a failed gate, an open change request, or a check nobody made.
  // A review whose only open findings are minor is fixed: nothing blocks, and
  // the notes stay listed as open for the person to read.
  const open = findings.filter((f) => f.status === 'open');
  const notPerformed = Object.values(checks).some((c) => c.result === 'not_performed') ||
    Object.values(gates).includes('not_performed');
  const gateFail = Object.values(gates).includes('fail');
  const openBlocking = open.some((f) => f.severity === 'blocking');
  const openRequest = open.some((f) => f.source === 'user_request');
  let verdict;
  if (openBlocking || openRequest || gateFail || notPerformed) verdict = 'flagged';
  else if (!findings.length) verdict = 'pass';
  else verdict = 'fixed';

  const doc = {
    page: owner.id,
    render,
    supersedes: supersedes || (existing && existing.supersedes) || null,
    reviewer: 'visual-reviewer',
    independent,
    compared_against: {
      references: [...new Set(references.filter((id) => ASSET_RE.test(id)))],
      neighbors: [...new Set(neighbors.filter((id) => PAGE_RENDER_RE.test(id)))],
    },
    checks,
    findings,
    gates,
    verdict,
    repair_cycle: repairCycle,
    reviewed_at: today(),
    human_approval: { status: 'pending', by: null, at: null },
    notes: [
      say('review.note.automated', { tool: toolLabel }),
      input.lineageNote || null,
      independent ? null : say('review.note.not_independent'),
    ].filter(Boolean).join(' '),
  };
  return doc;
}

/**
 * Review a render with the look driver and write its review file.
 * @param {object} ctx job context
 * @param {object} handle step handle
 * @param {{render: string, supersedes?: string|null, fakeText?: string,
 *          requests?: string[], lineageNote?: string, replaces?: string}} options
 *   requests: changes a person asked for that this fresh drawing was made to
 *   carry; each is checked in the image and recorded as a finding.
 * @returns {Promise<{render, verdict, repairable, findings, open, independent, file, tool, repair_cycle}>}
 */
async function reviewRender(ctx, handle, options) {
  const ws = S.ws;
  const root = ctx.project.root;
  const render = String(options.render);
  const owner = ownerOfRender(render);
  if (!owner) throw new OpError('bad_render', `${render} is not a page or cover render.`);
  const renderFile = ws.renderFile(root, render);
  if (!renderFile) throw new OpError('render_missing', `${render} has no image on disk, so there is nothing to review.`);
  const doc = loadOwnerDoc(root, owner);
  if (!doc) throw new OpError('plan_missing', `${owner.id} has no plan file to review the image against.`);
  const project = ws.loadProject(root) || {};
  const isCover = owner.kind === 'cover';
  const lang = i18n.normalize(ctx.project.settings().language) || 'en';

  const existing = ws.loadReview(root, render);
  const supersedes = options.supersedes || (existing && existing.supersedes) || null;
  const previous = supersedes ? ws.loadReview(root, supersedes) : null;
  const repairCycle = existing && Number.isInteger(existing.repair_cycle) ? existing.repair_cycle
    : previous && Number.isInteger(previous.repair_cycle) ? previous.repair_cycle + 1 : 0;

  // What the image was drawn from: the request as sent, else the current package.
  const record = recordOfRender(root, render);
  const request = requestOfRecord(record);
  let attached = request && request.body && Array.isArray(request.body.images) ? request.body.images : null;
  if (!attached) {
    const dir = path.join(ownerDir(root, owner), 'prompts');
    let pkg = null;
    try {
      const name = fs.readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n) && !/\.PN_/.test(n)).sort()[0];
      pkg = name ? ws.loadYaml(path.join(dir, name)) : null;
    } catch (err) {
      pkg = null;
    }
    attached = pkg && Array.isArray(pkg.references) ? pkg.references : [];
  }
  const refs = attached
    .filter((a) => a && a.image_path && a.role !== 'edit_target' && ASSET_RE.test(String(a.asset_id || '')))
    .filter((a) => fs.existsSync(ws.abs(root, a.image_path)));

  // The previous page as drawn, when it has a passing review.
  let neighbor = null;
  if (!isCover && doc.continuity && doc.continuity.enters_from) {
    const prevPage = ws.loadPage(root, doc.continuity.enters_from);
    const prevRender = prevPage && prevPage.current_render;
    if (prevRender && ws.reviewPasses(ws.loadReview(root, prevRender)) && ws.renderFile(root, prevRender)) {
      neighbor = { render: prevRender, file: ws.renderFile(root, prevRender) };
    }
  }

  const letteringMode = isCover
    ? S.coverLib.letteringMode(doc, project)
    : (project.lettering && project.lettering.mode === 'overlay' ? 'overlay' : 'in_image');
  let strings = [];
  if (letteringMode === 'in_image') {
    if (isCover) strings = S.coverLib.letteringElements(doc).map((el) => el.text);
    else {
      for (const panel of Array.isArray(doc.panels) ? doc.panels : []) {
        for (const el of Array.isArray(panel.lettering) ? panel.lettering : []) {
          if (el && el.text) strings.push({ order: el.order, text: String(el.text) });
        }
      }
      strings = strings.sort((a, b) => (a.order || 0) - (b.order || 0)).map((s) => s.text);
    }
  }
  const toRecheck = previous && !existing
    ? (Array.isArray(previous.findings) ? previous.findings : []).filter((f) => f && f.status === 'open')
    : [];
  // Which of them the repair was compiled to fix (the scaffold's own selection).
  let addressed = new Set(toRecheck.map((f) => String(f.id)));
  if (previous && toRecheck.length) {
    try {
      addressed = new Set(S.selectRepairFindings(previous).map((f) => String(f.id)));
    } catch (err) {
      // keep them all marked as addressed
    }
  }
  const notApplicable = isCover ? (S.coverLib.NOT_APPLICABLE_CHECKS || []) : [];
  const requests =(Array.isArray(options.requests) ? options.requests : [])
    .map((text, i) => ({ id: `REQ${i + 1}`, text: String(text) }));

  const vars = {
    kind: isCover ? 'cover' : 'page',
    render,
    render_file: renderFile,
    plan_file: planFileOf(root, owner),
    references: refs.map((a) => `- Reference, ${String(a.role || 'reference').replace(/_/g, ' ')}, ${a.asset_id}: ${ws.abs(root, a.image_path)}`).join('\n'),
    neighbor: neighbor ? `${neighbor.render} at ${neighbor.file}` : '',
    lettering: strings.map((s, i) => `${i + 1}. ${JSON.stringify(s)}`).join('\n'),
    overlay: letteringMode === 'overlay',
    supersedes: supersedes && toRecheck.length ? supersedes : '',
    previous: toRecheck.map((f) => {
      const where = f.panel ? ` (${f.panel})` : '';
      const kind = f.source === 'user_request' ? 'a change the person asked for' : `${f.severity || 'minor'} finding`;
      const part = addressed.has(String(f.id)) ? 'the repair was asked to fix this' : 'a note, not part of the repair';
      return `- ${f.id}${where} [${kind}; ${part}]: expected ${cleanText(f.expected, '')} Asked for: ${cleanText(f.repair, '')}`;
    }).join('\n'),
    not_applicable: notApplicable.join(', '),
    requests: requests.map((r) => `- ${r.id}: ${cleanText(r.text, '')}`).join('\n'),
  };

  const result = await runAi(ctx, handle, {
    verb: 'look',
    kind: 'review',
    vars,
    images: [renderFile, ...refs.map((a) => ws.abs(root, a.image_path)), ...(neighbor ? [neighbor.file] : [])].slice(0, 8),
    allowWrite: false,
    dataSchema: prompts.reviewDataSchema(),
    fakeText: options.fakeText || '',
    pages: /^PG_/.test(render) ? 1 : undefined,
  });
  const returned = result.data && result.data.review;
  if (!returned || typeof returned !== 'object') {
    throw new OpError('ai_bad_result', msg('error.ai_bad_result', { tool: TOOL_LABELS[result.tool], detail: 'no review in the result' }));
  }

  const drawer = drawerOf(root, render);
  const independent = !(drawer && drawer === result.tool);
  const review = composeReview({
    owner,
    render,
    supersedes,
    previous,
    existing,
    returned,
    independent,
    repairCycle,
    references: refs.map((a) => String(a.asset_id)),
    neighbors: neighbor ? [neighbor.render] : [],
    toolLabel: TOOL_LABELS[result.tool] || result.tool,
    lang,
    panelIds: isCover ? [] : (Array.isArray(doc.panels) ? doc.panels.map((p) => p && p.id).filter(Boolean) : []),
    notApplicable,
    requests,
    lineageNote: options.lineageNote ? i18n.render(lang, options.lineageNote) : null,
  });
  const problems = S.schemaFindings('visual-review', review);
  if (problems.length) {
    throw new OpError('review_invalid',
      `The review could not be written: ${problems.slice(0, 3).map((p) => `${p.path} ${p.message}`).join('; ')}`);
  }
  const file = ws.reviewFile(root, render);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# Schema: schemas/visual-review.schema.json\n# Written by the studio from what the reviewer returned after opening the image.\n\n${S.yaml.stringify(review)}`);

  const passes = ws.reviewPasses(review);
  if (!isCover) {
    setPageState(root, owner.id, { status: passes ? 'reviewed' : 'rendered', current_render: render });
  }
  if (passes && supersedes) {
    markRejected(root, supersedes, i18n.t(lang, 'record.replaced', { render }));
  } else if (passes && options.replaces) {
    markRejected(root, options.replaces, i18n.t(lang, 'record.replaced_redraw', { render }));
  }
  const open = review.findings.filter((f) => f.status === 'open');
  const outcome = outcomeOf(review);
  // A repair is for what blocks: an open blocking finding, or a failed gate
  // with a finding to act on. Minor notes never trigger one, and a change
  // request that did not land is the person's to send again.
  const blocking = open.filter((f) => f.severity === 'blocking');
  const gateFailed = Object.values(review.gates || {}).includes('fail');
  const repairable = !passes && returned.repairable !== false &&
    (blocking.length > 0 || (gateFailed && open.length > 0));
  let why = null;
  if (!passes && !repairable) {
    if (returned.repairable === false) why = msg('stopped.upstream');
    else if (open.some((f) => f.source === 'user_request')) why = msg('stopped.request_open');
    else if (gateFailed) why = msg('stopped.gate_no_finding');
    else why = msg('stopped.incomplete');
  }
  handle.log(`review of ${render}: ${review.verdict}${open.length ? `, ${open.length} open finding(s), ${blocking.length} blocking` : ''}${independent ? '' : ' (not independent)'}`);
  return {
    render,
    verdict: review.verdict,
    outcome,
    passes,
    repairable,
    not_repaired_because: why,
    findings: review.findings.length,
    open: open.length,
    open_blocking: blocking.length,
    independent,
    file: ws.rel(root, file),
    tool: result.tool,
    repair_cycle: review.repair_cycle,
  };
}

/**
 * What a review comes to, for the person: "pass" (it passes and nothing is
 * open), "notes" (it passes and lists open minor findings), or "flagged".
 */
function outcomeOf(review) {
  if (!review) return null;
  if (!S.ws.reviewPasses(review)) return 'flagged';
  const open = (Array.isArray(review.findings) ? review.findings : []).filter((f) => f && f.status === 'open');
  return open.length ? 'notes' : 'pass';
}

module.exports = {
  outcomeOf,
  ownerOfRender,
  ownerDir,
  planFileOf,
  loadOwnerDoc,
  listRendersOf,
  setTopLevel,
  setPageState,
  recordOfRender,
  requestOfRecord,
  markRejected,
  repairLimit,
  mechanical,
  drawTarget,
  compileProvider,
  buildPlan,
  pageBlockers,
  blockerOf,
  compilePage,
  compileSheet,
  compileCover,
  draw,
  drawerOf,
  composeReview,
  reviewRender,
};
