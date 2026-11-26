#!/usr/bin/env node
'use strict';
/**
 * generate-assets.js: run compiled prompt packages through an image provider.
 *
 * DRY RUN is the default: no network call. Each package gets a request spec
 * and a dry_run generation record so the request can be read before any
 * money is spent. --live submits the request; it needs the provider's env
 * vars, prints a cost estimate first, and refuses to run without --yes
 * (hooks/require-cost-confirmation.js enforces the same rule).
 *
 * Per package it writes, under <workspace>/generations/<PAGE_ID or ASSET_ID>/:
 *   GEN_<scope>_<attempt##>.yaml          the generation record
 *   GEN_<scope>_<attempt##>.request.json  the full request spec (the prompt,
 *                                         the ordered reference images with
 *                                         their roles, the target output);
 *                                         for manual and harness-native this
 *                                         is the handoff package
 * The attempt number is the next free one. A page package is assigned the
 * next free render version (<PAGE_ID>_V##) as its output_render, and a live
 * result is saved under the page's renders/ directory. An existing render
 * file is never overwritten. Records never contain API keys.
 *
 * A cover package (compile-prompts.js --cover) names the cover ID as its
 * page and behaves like a page package: it is recorded under
 * generations/CV_###/ and yields the next free cover render,
 * issues/<ISS_ID>/cover/renders/CV_###_V##.png.
 *
 * An asset-scoped package (a reference sheet compiled with
 * compile-prompts.js --asset) is recorded under generations/<ENTITY_ID>/
 * and targets the next free candidate in the entity's refs directory:
 * <ENTITY_ID>_<TAG>_V##.png, or references/style/<LOOK_ID>_V##.png for a
 * look. TAG carries the sheet's variant (the outfit of a wardrobe sheet,
 * the subject of a detail), so each sheet has its own version sequence. A candidate never takes the _MASTER name: promotion to master is an
 * approval step, not something generation does.
 */

const fs = require('fs');
const path = require('path');
const { writeFileEnsuring, toPosix } = require('./lib/fsx');
const { loadImageProvider, resolveProviderId } = require('./lib/providers');
const { parseArgs, helpIfRequested } = require('./lib/cli');
const {
  pipelineError, loadPageContext, hashPage, hashPlan, hashText, validateDoc,
} = require('./lib/page-pipeline');
const assetPaths = require('./lib/asset-paths');
const coverLib = require('./lib/cover');
const ws = require('./lib/workspace');
const yaml = require('./lib/yaml');
const { providerTag, isRemote, resolveLocal } = require('../providers/lib/common');

/**
 * Directory that holds the renders of a page or of a cover. A cover package
 * names the cover ID (CV_001) as its page.
 */
function rendersDir(root, pageId) {
  const base = ws.ID.cover.test(String(pageId)) ? ws.coverDir(root, pageId) : ws.pageDir(root, pageId);
  return path.join(base, 'renders');
}

const HELP = `
generate-assets.js: generate images from compiled prompt packages.

Usage:
  node scripts/generate-assets.js (--package <prompt-package.yaml> | --page <page.yaml> |
                                   --issue <issue dir> | --asset <ENTITY_ID> [--root <workspace>] |
                                   --cover <ISS_ID> [--root <workspace>])
                                  [--provider <id>] [--live --yes]

Options:
  --package <file>   One compiled prompt package (page or asset scoped).
  --page <page.yaml> The page's package for its provider (prompts/<provider>.yaml).
  --issue <dir>      Every page of the issue, in reading order. Pages that are
                     already reviewed or approved are skipped.
  --asset <ID>       Every sheet package compiled for a CHAR_*, LOC_*, PROP_*
                     or LOOK_* entity (its refs/prompts/ directory).
  --cover <ISS_ID>   The cover package of an issue
                     (issues/<ISS_ID>/cover/prompts/<provider>.yaml).
  --root <dir>       Workspace root for --asset and --cover. Default: the
                     workspace found from the current directory.
  --provider <id>    Use the packages compiled for this provider instead of
                     the page's own provider. With --asset: only that provider.
  --live             Call the provider API (default: DRY RUN).
  --yes              Confirm the printed cost estimate. Required with --live.
  --help             Show this help.

Dry run writes the request spec and a dry_run record and calls no network.

Written under <workspace>/generations/<PAGE_ID or ENTITY_ID>/:
  GEN_<scope>_<attempt##>.yaml and GEN_<scope>_<attempt##>.request.json
Image targets, always the next free version, never an overwrite:
  page    <page dir>/renders/<PAGE_ID>_V##.png
  sheet   characters|locations|props/<ID>/refs/<ID>_<TAG>_V##.png
          TAG: TURN, EXPR, WARD_<OUTFIT>, PLATE (PLATE_<STATE> for a
          non-default time of day), SHEET (props), DETAIL_<SUBJECT>
  look    references/style/<LOOK_ID>_V##.png
  cover   issues/<ISS_ID>/cover/renders/CV_###_V##.png, recorded under
          generations/CV_###/ as GEN_CV_###_<attempt##>
A sheet candidate never takes the _MASTER name; approval promotes it.
`;

/**
 * Approximate list prices in USD per image, each tied to the model it was
 * read for. Estimates only: a pinned model with no entry here has no
 * estimate, and handoff providers (manual, harness-native) are never
 * estimated because the cost depends on the tool the person uses.
 */
const COST_TABLE = {
  fal: { model: 'fal-ai/flux/dev', usd: 0.025 },
  replicate: { model: 'black-forest-labs/flux-dev', usd: 0.03 },
  gemini: { model: 'gemini-2.5-flash-image', usd: 0.039 },
  comfyui: { model: null, usd: 0 }, // self-hosted: no per-image charge
};

const EXT_BY_FORMAT = { png: '.png', jpeg: '.jpg', jpg: '.jpg', webp: '.webp' };
const SKIP_STATUSES = ['reviewed', 'approved'];

/** List-price estimate for one package, or null when there is none on file. */
function estimateCost(pkg, providerId = pkg && pkg.provider) {
  const row = COST_TABLE[providerId];
  if (!row) return null;
  if (row.model && pkg && pkg.model && pkg.model !== 'pending' && pkg.model !== row.model) return null;
  return row.usd;
}

/** Next free attempt number for GEN_<scope>_##.yaml in a generations dir. */
function nextAttempt(dir, scope) {
  if (!fs.existsSync(dir)) return 1;
  const prefix = `GEN_${scope}_`;
  let max = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue;
    const m = /^(\d{2,})\.ya?ml$/i.exec(name.slice(prefix.length));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

function versionOfRender(renderId) {
  const m = /_V(\d{2})$/.exec(String(renderId));
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * The next free render ID of a page: one above the highest version found
 * among the render files and the review files, so a version number is never
 * reused even when an old file was moved away.
 */
function nextRenderId(root, pageId) {
  // A cover keeps its own version sequence under issues/<ISS_ID>/cover/.
  if (ws.ID.cover.test(String(pageId))) return coverLib.nextRenderId(root, pageId);
  let max = 0;
  for (const id of ws.listRenders(root, pageId)) max = Math.max(max, versionOfRender(id));
  for (const review of ws.listReviews(root, pageId)) {
    if (ws.pageOfRender(review.render) === pageId) max = Math.max(max, versionOfRender(review.render));
  }
  if (max >= 99) throw pipelineError('render_versions_exhausted', `${pageId} already has 99 render versions`);
  return `${pageId}_V${String(max + 1).padStart(2, '0')}`;
}

/**
 * Scope of a package: its page, else the entity it is for. Records of an
 * asset-scoped package live under generations/<ENTITY_ID>/. A package with
 * no asset field falls back to the ID inside its package ID.
 */
function scopeOf(pkg) {
  if (pkg.page) return { scope: String(pkg.page), page: String(pkg.page), asset: null };
  if (pkg.asset && ws.ID.entity.test(String(pkg.asset))) {
    return { scope: String(pkg.asset), page: null, asset: String(pkg.asset) };
  }
  const tag = `_${providerTag(pkg.provider)}`;
  const id = String(pkg.id || '');
  let fromId = id.startsWith('PP_') ? id.slice(3) : '';
  if (fromId.endsWith(tag)) fromId = fromId.slice(0, -tag.length);
  if (ws.ID.asset.test(fromId) || ws.ID.entity.test(fromId)) {
    return { scope: fromId, page: null, asset: pkg.asset || fromId };
  }
  if (pkg.asset) return { scope: String(pkg.asset), page: null, asset: String(pkg.asset) };
  return null;
}

function loadPackage(file) {
  const pkg = ws.loadYaml(file);
  if (!pkg || typeof pkg !== 'object' || !pkg.provider || !pkg.prompt) {
    throw pipelineError('package_invalid', `${toPosix(file)} is not a compiled prompt package (needs provider and prompt)`);
  }
  return pkg;
}

/** Package files of one page for one provider (per-panel packages in per_panel mode). */
function pagePackageFiles(pageDir, page, providerId) {
  const dir = path.join(pageDir, 'prompts');
  const whole = path.join(dir, `${providerId}.yaml`);
  const perPanel = page.generation && page.generation.mode === 'per_panel';
  if (perPanel && fs.existsSync(dir)) {
    const prefix = `${providerId}.PN_`;
    const panels = fs.readdirSync(dir)
      .filter((n) => n.startsWith(prefix) && /\.ya?ml$/i.test(n))
      .sort()
      .map((n) => path.join(dir, n));
    if (panels.length) return panels;
  }
  return fs.existsSync(whole) ? [whole] : [];
}

/**
 * Resolve the CLI selection to package files.
 * @returns {{items: {file: string, pkg: object, root: string}[], skipped: string[]}}
 */
function collectPackages(options) {
  const items = [];
  const skipped = [];
  const selected = ['package', 'page', 'issue', 'asset', 'cover'].filter((k) => options[k] && options[k] !== true);
  if (selected.length !== 1) {
    throw pipelineError('bad_arguments', 'exactly one of --package, --page, --issue, --asset, --cover is required (see --help)');
  }
  const wanted = options.provider && options.provider !== true ? String(options.provider) : null;

  if (options.package) {
    const file = path.resolve(String(options.package));
    if (!fs.existsSync(file)) throw pipelineError('package_missing', `prompt package not found: ${file}`);
    const root = ws.findWorkspaceRoot(file);
    if (!root) throw pipelineError('workspace_missing', `no project.yaml above ${file}: generation records live in the workspace`);
    const pkg = loadPackage(file);
    if (wanted && pkg.provider !== wanted) {
      skipped.push(`${toPosix(file)}: compiled for ${pkg.provider}, not ${wanted}`);
    } else {
      items.push({ file, pkg, root });
    }
    return { items, skipped };
  }

  const addPage = (root, pageDir, page, project, strict) => {
    const providerId = resolveProviderId(wanted, page, project);
    const files = pagePackageFiles(pageDir, page, providerId);
    if (!files.length) {
      const message = `${page.id}: no prompt package for ${providerId} (run compile-prompts.js --page ${toPosix(path.join(pageDir, 'page.yaml'))}${wanted ? ` --provider ${wanted}` : ''})`;
      if (strict) throw pipelineError('package_missing', message);
      skipped.push(message);
      return;
    }
    for (const file of files) items.push({ file, pkg: loadPackage(file), root });
  };

  if (options.asset) {
    const entityId = String(options.asset);
    if (!assetPaths.entityType(entityId)) {
      throw pipelineError('bad_arguments', `--asset needs an entity ID (CHAR_*, LOC_*, PROP_* or LOOK_*), got "${entityId}"`);
    }
    const start = options.root && options.root !== true ? path.resolve(String(options.root)) : process.cwd();
    const root = ws.findWorkspaceRoot(start);
    if (!root) {
      throw pipelineError('workspace_missing', `no project.yaml at or above ${start}: pass --root <workspace> or run from inside the workspace`);
    }
    const files = assetPaths.listPackageFiles(root, entityId);
    if (!files.length) {
      throw pipelineError('package_missing',
        `${entityId}: no sheet package under ${assetPaths.promptsDir(entityId)}/ (run compile-prompts.js --asset ${entityId} --sheet <kind>)`);
    }
    for (const file of files) {
      const pkg = loadPackage(file);
      if (pkg.asset !== entityId) skipped.push(`${toPosix(file)}: compiled for ${pkg.asset || pkg.page}, not ${entityId}`);
      else if (wanted && pkg.provider !== wanted) skipped.push(`${toPosix(file)}: compiled for ${pkg.provider}, not ${wanted}`);
      else items.push({ file, pkg, root });
    }
    return { items, skipped };
  }

  if (options.cover) {
    // The cover of an issue: issues/<ISS_ID>/cover/prompts/<provider>.yaml.
    const issueId = String(options.cover);
    if (!ws.ID.issue.test(issueId)) {
      throw pipelineError('bad_arguments', `--cover needs an issue ID (ISS_###), got "${issueId}"`);
    }
    const start = options.root && options.root !== true ? path.resolve(String(options.root)) : process.cwd();
    const root = ws.findWorkspaceRoot(start);
    if (!root) {
      throw pipelineError('workspace_missing', `no project.yaml at or above ${start}: pass --root <workspace> or run from inside the workspace`);
    }
    const cover = ws.loadCover(root, issueId);
    if (!cover) {
      throw pipelineError('cover_missing', `${issueId} has no cover: issues/${issueId}/cover/cover.yaml not found (write it with /cover)`);
    }
    const providerId = resolveProviderId(wanted, cover, ws.loadProject(root) || {});
    const file = path.join(ws.coverDir(root, issueId), 'prompts', `${providerId}.yaml`);
    if (!fs.existsSync(file)) {
      throw pipelineError('package_missing',
        `${ws.coverIdOfIssue(issueId)}: no prompt package for ${providerId} (run compile-prompts.js --cover ${issueId}${wanted ? ` --provider ${wanted}` : ''})`);
    }
    items.push({ file, pkg: loadPackage(file), root });
    return { items, skipped };
  }

  if (options.page) {
    const ctx = loadPageContext(options.page);
    addPage(ctx.root, ctx.pageDir, ctx.page, ctx.project, true);
    return { items, skipped };
  }

  const issueDirPath = path.resolve(String(options.issue));
  const issueId = path.basename(issueDirPath);
  const root = ws.findWorkspaceRoot(issueDirPath);
  if (!root || !ws.ID.issue.test(issueId) || !fs.existsSync(issueDirPath)) {
    throw pipelineError('issue_missing', `not an issue directory inside a workspace: ${issueDirPath} (expected <workspace>/issues/ISS_###)`);
  }
  const project = ws.loadProject(root) || {};
  const pages = ws.listPages(root, issueId);
  if (!pages.length) throw pipelineError('issue_empty', `${issueId} has no pages`);
  for (const entry of pages) {
    if (!entry.doc) {
      skipped.push(`${entry.id}: page.yaml missing`);
    } else if (SKIP_STATUSES.includes(entry.doc.status)) {
      skipped.push(`${entry.id}: status ${entry.doc.status}, already has a reviewed render (use --page or --package to generate again)`);
    } else {
      addPage(root, entry.dir, entry.doc, project, false);
    }
  }
  return { items, skipped };
}

function extensionFor(format, url) {
  if (format && EXT_BY_FORMAT[String(format).toLowerCase()]) return EXT_BY_FORMAT[String(format).toLowerCase()];
  if (url) {
    const clean = String(url).split('?')[0].split('#')[0];
    const ext = path.extname(clean).toLowerCase();
    if (ws.IMAGE_EXTENSIONS.includes(ext)) return ext === '.jpeg' ? '.jpg' : ext;
  }
  return '.png';
}

/** Write a new file; fails instead of replacing an existing one. */
function writeNew(file, buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer, { flag: 'wx' });
}

/**
 * Save the media of a succeeded record into the workspace and rewrite
 * media_files as workspace-relative paths. Page renders go to the page's
 * renders/ directory under the next free version; anything else goes next
 * to the record. Nothing is ever overwritten: a taken name moves on to the
 * next free version.
 * A sheet (ctx.sheet) goes to the entity's refs directory as the next free
 * candidate version, never under a _MASTER name.
 * @param {object} record generation record (mutated)
 * @param {{root: string, page: string|null, fullPage: boolean, dir: string,
 *          sheet?: {entity: string, stemTag: string}, fetchImpl?: Function}} ctx
 */
async function persistMedia(record, ctx) {
  const inline = Array.isArray(record._media) ? record._media : null;
  const sources = inline
    ? inline.map((m) => ({ buffer: Buffer.from(m.data_base64, 'base64'), format: m.format, url: null }))
    : (record.media_files || []).map((url) => ({ buffer: null, format: null, url: String(url) }));
  delete record._media;
  const saved = [];
  const problems = [];
  const fetchImpl = ctx.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  let firstRender = null;

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    let buffer = src.buffer;
    if (!buffer) {
      if (!/^https?:/i.test(src.url) || !fetchImpl) {
        saved.push(src.url);
        continue;
      }
      try {
        const res = await fetchImpl(src.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buffer = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        problems.push(`could not download image ${i + 1} (${err.message}); its URL is kept in media_files`);
        saved.push(src.url);
        continue;
      }
    }
    const ext = extensionFor(src.format, src.url);
    let file = null;
    if (ctx.page && ctx.fullPage) {
      for (let tries = 0; tries < 5 && !file; tries++) {
        const renderId = nextRenderId(ctx.root, ctx.page);
        const candidate = path.join(rendersDir(ctx.root, ctx.page), `${renderId}${ext}`);
        try {
          writeNew(candidate, buffer);
          file = candidate;
          if (!firstRender) firstRender = renderId;
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
        }
      }
    } else if (ctx.sheet) {
      // nextCandidate counts every extension, so a taken version moves on.
      for (let tries = 0; tries < 5 && !file; tries++) {
        const next = assetPaths.nextCandidate(ctx.root, ctx.sheet.entity, ctx.sheet.stemTag, ext);
        const candidate = ws.abs(ctx.root, next.rel);
        try {
          writeNew(candidate, buffer);
          file = candidate;
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
        }
      }
    } else {
      const base = `${record.id}${sources.length > 1 ? `_${i + 1}` : ''}`;
      const candidate = path.join(ctx.dir, `${base}${ext}`);
      if (!fs.existsSync(candidate)) {
        writeNew(candidate, buffer);
        file = candidate;
      }
    }
    if (file) saved.push(ws.rel(ctx.root, file));
    else problems.push(`image ${i + 1} was not saved: no free file name`);
  }

  record.media_files = saved;
  if (ctx.page && ctx.fullPage) record.output_render = firstRender;
  if (problems.length) {
    record.notes = [record.notes, ...problems].filter(Boolean).join(' ');
  }
  return record;
}

/**
 * Warnings about a package whose sources changed after it was compiled:
 * the page, its reference plan, or the frozen style block. Each is compared
 * with the hash compile-prompts.js stored in source_hashes.
 */
function staleness(root, pkg) {
  const out = [];
  const hashes = pkg.source_hashes || {};
  if (pkg.page && hashes.page && ws.ID.cover.test(String(pkg.page))) {
    const cover = ws.loadCover(root, pkg.page);
    if (cover && coverLib.hashCover(cover) !== hashes.page) out.push(`cover.yaml of ${pkg.page} changed after this package was compiled`);
  } else if (pkg.page && hashes.page) {
    const page = ws.loadPage(root, pkg.page);
    if (page && hashPage(page) !== hashes.page) out.push(`${pkg.page}/page.yaml changed after this package was compiled`);
  }
  if (pkg.page && hashes.reference_plan && ws.ID.page.test(String(pkg.page))) {
    const plan = ws.loadYaml(path.join(ws.pageDir(root, pkg.page), 'reference-plan.yaml'));
    if (!plan) {
      out.push(`${pkg.page}/reference-plan.yaml is gone, and this package was compiled from it`);
    } else if (hashPlan(plan) !== hashes.reference_plan) {
      out.push(`${pkg.page}/reference-plan.yaml changed after this package was compiled`);
    }
  }
  if (hashes.style_block) {
    const block = ws.loadStyleBlock(root);
    if (block !== null && hashText(block) !== hashes.style_block) out.push('the style block changed after this package was compiled');
  }
  return out;
}

/**
 * Run one package: compile the request, write the request spec, call the
 * provider (dry-run unless live), save media, write the record.
 * @param {{file: string, pkg: object, root: string}} item
 * @param {{live?: boolean, log?: Function, providerModule?: object, fetchImpl?: Function,
 *          signal?: AbortSignal, onProgress?: (line: string) => void}} [options]
 * @returns {Promise<{record: object, recordFile: string, requestFile: string, cost: number|null, warnings: string[]}>}
 */
async function runPackage(item, options = {}) {
  const { file, pkg, root } = item;
  const live = options.live === true;
  const log = options.log || (() => {});
  const provider = options.providerModule || loadImageProvider(pkg.provider);
  const warnings = [];

  const target = scopeOf(pkg);
  if (!target) {
    throw pipelineError('scope_missing', `${toPosix(file)}: the package has neither a page nor an asset scope`);
  }
  const spec = provider.compile(pkg);
  warnings.push(...((spec.meta && spec.meta.warnings) || []));

  const stale = staleness(root, pkg);
  if (stale.length && live) {
    throw pipelineError('package_stale', `${pkg.id}: ${stale.join('; ')}. Re-run compile-prompts.js before a live run.`);
  }
  warnings.push(...stale.map((s) => `${s}; re-run compile-prompts.js`));

  const missing = ((spec.meta && spec.meta.reference_paths) || [])
    .filter((ref) => !isRemote(ref) && !fs.existsSync(resolveLocal(root, ref)));
  if (missing.length && live && !spec.handoff) {
    throw pipelineError('reference_file_missing', `${pkg.id}: input image(s) not on disk: ${missing.join(', ')}. Nothing was sent.`);
  }
  for (const ref of missing) warnings.push(`input image not on disk: ${ref}`);

  // Only the page's own package (PP_<PAGE>_<PROVIDER>) yields a page render.
  // A per-panel package (suffix -P03) yields a panel image kept next to the
  // record.
  const fullPage = Boolean(target.page) &&
    String(pkg.id || '') === `PP_${target.page}_${providerTag(pkg.provider)}`;
  const dir = path.join(root, 'generations', target.scope);
  const recordId = `GEN_${target.scope}_${String(nextAttempt(dir, target.scope)).padStart(2, '0')}`;
  const renderId = fullPage ? nextRenderId(root, target.page) : null;
  // A compiled sheet package targets the next candidate in the entity's refs
  // directory; anything else without a page stays next to its record.
  const sheet = !target.page ? assetPaths.sheetOfPackage(pkg) : null;
  const sheetTarget = sheet ? { entity: target.asset, stemTag: sheet.stemTag } : null;
  let outputFile = path.join(dir, `${recordId}.png`);
  if (fullPage) outputFile = path.join(rendersDir(root, target.page), `${renderId}.png`);
  else if (sheetTarget) outputFile = ws.abs(root, assetPaths.nextCandidate(root, sheetTarget.entity, sheetTarget.stemTag).rel);
  const outputPath = ws.rel(root, outputFile);
  const cost = estimateCost(Object.assign({}, pkg, { model: spec.model }), pkg.provider);

  spec.meta = Object.assign({}, spec.meta, {
    record_id: recordId,
    scope: target.scope,
    page: target.page,
    asset: target.asset,
    output_render: renderId,
    output_path: outputPath,
  });
  if (cost !== null) spec.meta.cost_estimate = cost;
  if (spec.handoff && spec.body && typeof spec.body === 'object') {
    spec.body.output = { render: renderId, path: outputPath };
  }

  // The request spec is written before the call, so the exact request of
  // every attempt survives whatever the provider does with it.
  const requestFile = path.join(dir, `${recordId}.request.json`);
  writeFileEnsuring(requestFile, `${JSON.stringify(spec, null, 2)}\n`);

  // signal and onProgress are handed through for providers that run a local
  // tool (codex-cli): aborting the signal stops the tool and yields a failed
  // record with the error "cancelled". API providers ignore both.
  const record = await provider.generate(spec, {
    dryRun: !live,
    outDir: path.dirname(outputFile),
    root,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  if (record.status === 'succeeded') {
    await persistMedia(record, {
      root, page: target.page, fullPage, dir, sheet: sheetTarget, fetchImpl: options.fetchImpl,
    });
  } else {
    delete record._media;
  }

  const recordFile = path.join(dir, `${record.id}.yaml`);
  writeFileEnsuring(recordFile, yaml.stringify(record));
  const check = validateDoc('generation-record', record);
  if (!check.valid) {
    warnings.push(`record ${record.id} violates generation-record.schema.json: ${check.errors.slice(0, 3).join('; ')}`);
  }

  const costText = cost === null ? 'no estimate' : `$${cost.toFixed(3)} approx`;
  log(`  ${String(record.status).toUpperCase()} ${record.id} [${pkg.provider}, model ${record.model}] ${costText}`);
  log(`    record:  ${toPosix(recordFile)}`);
  log(`    request: ${toPosix(requestFile)}`);
  if (record.status === 'dry_run') log(`    target:  ${outputPath}${renderId ? ` (render ${renderId})` : ''}`);
  if (record.response && record.response.error) log(`    error: ${record.response.error}`);
  for (const out of record.media_files || []) log(`    media: ${out}`);
  for (const w of warnings) log(`    warning: ${w}`);
  return { record, recordFile, requestFile, cost, warnings };
}

/**
 * Programmatic entry point (what the CLI runs).
 * @param {{package?: string, page?: string, issue?: string, asset?: string, cover?: string, root?: string,
 *          provider?: string, live?: boolean, yes?: boolean, log?: Function,
 *          fetchImpl?: Function, signal?: AbortSignal, onProgress?: (line: string) => void}} options
 *   signal and onProgress are optional and handed to provider.generate():
 *   aborting the signal stops a provider that runs a local tool (its record
 *   fails with the error "cancelled") and skips the packages not started yet.
 * @returns {Promise<{live: boolean, results: object[], failures: string[], skipped: string[], totalCost: number, unestimated: number}>}
 */
async function generateAssets(options = {}) {
  const log = options.log || ((line) => console.log(line));
  const live = options.live === true;
  const { items, skipped } = collectPackages(options);

  let totalCost = 0;
  let unestimated = 0;
  for (const item of items) {
    const cost = estimateCost(item.pkg);
    if (cost === null) unestimated++;
    else totalCost += cost;
  }
  log(`generate-assets: ${items.length} package(s), mode: ${live ? 'LIVE' : 'DRY RUN'}`);
  log(`estimated total cost: $${totalCost.toFixed(3)} (approximate list prices; check your provider)` +
    (unestimated ? `, plus ${unestimated} package(s) with no estimate (handoff provider or pinned model)` : ''));
  for (const line of skipped) log(`  skip ${line}`);
  if (live && options.yes !== true) {
    throw pipelineError('confirmation_required',
      '--live spends provider credits: re-run with --yes to confirm the estimate above');
  }
  if (!live) log('(dry run: request specs and dry_run records only; add --live --yes to submit)');
  if (!items.length) throw pipelineError('nothing_to_generate', 'no prompt package to run');

  const results = [];
  const failures = [];
  for (const item of items) {
    try {
      if (options.signal && options.signal.aborted) {
        failures.push(`${toPosix(item.file)}: cancelled`);
        log(`  CANCELLED ${toPosix(item.file)}: not started`);
        continue;
      }
      const result = await runPackage(item, {
        live, log, fetchImpl: options.fetchImpl, signal: options.signal, onProgress: options.onProgress,
      });
      results.push(Object.assign({ file: item.file }, result));
      if (result.record.status === 'failed') failures.push(`${result.record.id}: ${result.record.response.error}`);
    } catch (err) {
      failures.push(`${toPosix(item.file)}: ${err.message}`);
      log(`  FAILED ${toPosix(item.file)}: ${err.message}`);
    }
  }
  if (results.some((r) => (r.record.media_files || []).length)) {
    log('A saved image is a candidate, not a pass: open it and run the visual review before it feeds the next page.');
  }
  return { live, results, failures, skipped, totalCost, unestimated };
}

async function main() {
  helpIfRequested(process.argv.slice(2), HELP);
  const { flags } = parseArgs();
  const outcome = await generateAssets({
    package: flags.package,
    page: flags.page,
    issue: flags.issue,
    asset: flags.asset,
    cover: flags.cover,
    root: flags.root,
    provider: flags.provider,
    live: flags.live === true,
    yes: flags.yes === true,
  });
  if (outcome.failures.length) {
    console.error(`generate-assets: ${outcome.failures.length} failure(s)`);
    process.exit(1);
  }
}

module.exports = {
  COST_TABLE,
  estimateCost,
  nextAttempt,
  nextRenderId,
  scopeOf,
  collectPackages,
  persistMedia,
  staleness,
  runPackage,
  generateAssets,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}
