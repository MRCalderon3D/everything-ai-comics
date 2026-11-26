'use strict';
/**
 * Shared helpers for image provider adapters. Zero dependencies.
 * compile() stays pure; the only I/O a provider does is inside a live
 * generate() call (reading reference files and the HTTP request itself).
 * Writing records, request specs, and media belongs to
 * scripts/generate-assets.js.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Comic pages are portrait; this is the ratio used when a package names none. */
const DEFAULT_ASPECT_RATIO = '2:3';

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** Stable JSON stringify (sorted keys) for hashing. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function hashObject(obj) {
  return crypto.createHash('sha256').update(stableStringify(obj)).digest('hex').slice(0, 16);
}

/** Throw when required env vars are missing. Never echoes values. */
function assertEnv(envNames) {
  const missing = (envNames || []).filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`missing required environment variable(s): ${missing.join(', ')}. Refusing to run live`);
  }
}

/** parameters.{aspect_ratio, resolution, seed} of a prompt package. */
function packageParams(pkg) {
  return (pkg && typeof pkg.parameters === 'object' && pkg.parameters) || {};
}

function aspectRatioOf(pkg) {
  return packageParams(pkg).aspect_ratio || DEFAULT_ASPECT_RATIO;
}

function refImage(ref) {
  return ref.image_path || ref.path || ref.url || null;
}

function refId(ref) {
  return ref.asset_id || ref.id || ref.image_path;
}

function packageRefs(pkg) {
  return pkg && Array.isArray(pkg.references) ? pkg.references : [];
}

/**
 * Every image a request carries, in attachment order. The edit target of a
 * repair goes first, then the package references in their own order. The
 * prompt's reference legend numbers images with this same function, so the
 * legend and the request cannot disagree.
 * @returns {{position: number, asset_id: string|null, role: string, image_path: string|null}[]}
 */
function attachments(pkg) {
  const out = [];
  if (pkg && pkg.edit_target) {
    out.push({
      asset_id: (pkg.repair && pkg.repair.of_render) || null,
      role: 'edit_target',
      image_path: String(pkg.edit_target),
    });
  }
  for (const ref of packageRefs(pkg)) {
    out.push({ asset_id: refId(ref), role: ref.role || null, image_path: refImage(ref) });
  }
  return out.map((a, i) => Object.assign({ position: i + 1 }, a));
}

/**
 * Capability checks shared by every compile(). Throws one error that lists
 * each violated limit. Checked: image count (the edit target counts as an
 * image), aspect ratio, image editing for repairs, and in-image lettering.
 */
function checkCapabilities(pkg, capabilities, providerId) {
  const problems = [];
  const caps = capabilities || {};
  const ratio = aspectRatioOf(pkg);
  const images = attachments(pkg);
  const editing = pkg.mode === 'repair' || Boolean(pkg.edit_target);

  if (typeof caps.referenceImages === 'number' && images.length > caps.referenceImages) {
    problems.push(`${images.length} input image(s)${editing ? ' (edit target included)' : ''} exceed the provider limit of ${caps.referenceImages}`);
  }
  if (!/^\d+:\d+$/.test(String(ratio))) {
    problems.push(`aspect ratio "${ratio}" is not in W:H form`);
  } else if (Array.isArray(caps.aspectRatios) && !caps.aspectRatios.includes(ratio)) {
    problems.push(`aspect ratio ${ratio} is not supported (supported: ${caps.aspectRatios.join(', ')})`);
  }
  if (editing && caps.imageEditing !== true) {
    problems.push('image editing is not supported, so this provider cannot run a repair; use a provider with imageEditing');
  }
  if (pkg.mode === 'repair' && !pkg.edit_target) {
    problems.push('repair package has no edit_target');
  }
  if (caps.textRendering === 'none' && Array.isArray(pkg.lettering_text) && pkg.lettering_text.length) {
    problems.push('in-image lettering is not supported (textRendering: none); set lettering.mode to overlay or use another provider');
  }
  if (problems.length) {
    throw new Error(`prompt package ${pkg.id || '(no id)'} violates ${providerId} capabilities: ${problems.join('; ')}`);
  }
}

/** Model precedence: options.model, then the package's own pin, then the default. */
function resolveModel(pkg, options, defaultModel) {
  return (options && options.model) ||
    (pkg.model && pkg.model !== 'pending' && pkg.model) ||
    defaultModel;
}

/** The meta block every compile() attaches to its request spec. Pure. */
function baseMeta(pkg) {
  const seed = packageParams(pkg).seed;
  const images = attachments(pkg);
  return {
    page: pkg.page || null,
    asset: pkg.asset || null,
    mode: pkg.mode || 'generate',
    prompt_package_id: pkg.id || null,
    prompt_package_hash: hashObject(pkg),
    references_used: packageRefs(pkg).map(refId),
    // Workspace-relative files, in attachment order (edit target first).
    reference_paths: images.map((a) => a.image_path).filter(Boolean),
    edit_target: pkg.edit_target || null,
    seed: Number.isInteger(seed) ? seed : null,
    warnings: [],
  };
}

function providerTag(id) {
  return String(id || 'X').toUpperCase().replace(/[^A-Z0-9_-]+/g, '-');
}

/**
 * Build a generation record (schemas/generation-record.schema.json).
 *
 * Nothing is invented. `model` is the model the request addresses, or
 * "unreported" for a handoff (the person or the harness tool picks it).
 * `cost.amount` is null unless the caller supplied a list-price estimate,
 * which is flagged `estimated: true`; `reported` only turns true when the
 * tool returns billing data. `seed` is the seed the request pins, else null.
 * Whatever the tool has not reported is listed in `metadata_unavailable`.
 * The record carries no secrets: endpoint, model, and a payload hash.
 */
function makeRecord(requestSpec, extra = {}) {
  const meta = requestSpec.meta || {};
  const page = meta.page || null;
  const asset = meta.asset || null;
  const scope = meta.scope || page || asset;
  if (!scope) {
    throw new Error('request spec has neither a page nor an asset scope; set page or asset on the prompt package');
  }
  const handoff = requestSpec.handoff === true;
  const modelKnown = !handoff && typeof requestSpec.model === 'string' && requestSpec.model.length > 0;
  const estimate = typeof meta.cost_estimate === 'number' && meta.cost_estimate >= 0
    ? meta.cost_estimate : null;
  const seed = !handoff && Number.isInteger(meta.seed) ? meta.seed : null;

  const unavailable = [];
  if (!modelKnown) unavailable.push('model');
  unavailable.push('cost');
  if (seed === null) unavailable.push('seed');

  const target = requestSpec.endpoint
    ? `${requestSpec.method || 'POST'} ${requestSpec.endpoint}`
    : 'Handoff, no endpoint';
  const record = {
    id: meta.record_id || `GEN_${scope}_01`,
    page,
    asset,
    provider: requestSpec.provider,
    model: modelKnown ? requestSpec.model : 'unreported',
    kind: 'image',
    prompt_package: meta.prompt_package_id || `PP_${scope}_${providerTag(requestSpec.provider)}`,
    output_render: meta.output_render || null,
    request: {
      summary: `${target} (${meta.mode === 'repair' ? 'repair' : 'generate'}, ${(meta.reference_paths || []).length} input image(s))`,
      endpoint: requestSpec.endpoint || null,
      payload_hash: hashObject(requestSpec.body || {}),
    },
    response: {
      summary: 'No request sent (dry run).',
      provider_job_id: null,
      error: null,
    },
    media_files: [],
    cost: {
      currency: 'USD',
      amount: estimate,
      estimated: estimate !== null,
      reported: false,
    },
    seed,
    metadata_unavailable: unavailable,
    status: 'dry_run',
    created_at: new Date().toISOString(),
  };
  if (extra.status === 'pending') record.response.summary = 'Request not completed yet.';
  return Object.assign(record, extra);
}

/**
 * Fold metadata the tool actually returned into the record and drop it from
 * metadata_unavailable. Pass only values the response contains.
 * @param {{model?: string, seed?: number, cost?: number}} reported
 */
function applyReported(record, reported = {}) {
  const drop = (name) => {
    record.metadata_unavailable = (record.metadata_unavailable || []).filter((n) => n !== name);
  };
  if (typeof reported.model === 'string' && reported.model) {
    record.model = reported.model;
    drop('model');
  }
  if (Number.isInteger(reported.seed)) {
    record.seed = reported.seed;
    drop('seed');
  }
  if (typeof reported.cost === 'number' && reported.cost >= 0) {
    record.cost = { currency: record.cost.currency || 'USD', amount: reported.cost, estimated: false, reported: true };
    drop('cost');
  }
  return record;
}

/** Flip a record to succeeded with a response summary and media URLs/paths. */
function markSucceeded(record, summary, mediaFiles = [], jobId = null) {
  record.status = 'succeeded';
  record.response = {
    summary,
    provider_job_id: jobId === null || jobId === undefined ? null : String(jobId),
    error: null,
  };
  record.media_files = mediaFiles.filter(Boolean).map(String);
  if (!record.media_files.length) {
    record.status = 'failed';
    record.response.error = 'provider reported success but returned no media';
  }
  return record;
}

/** Flip a record to failed with the error message. */
function markFailed(record, err) {
  record.status = 'failed';
  record.response = {
    summary: 'Request failed.',
    provider_job_id: null,
    error: err && err.message ? err.message : String(err),
  };
  return record;
}

function isRemote(ref) {
  return /^(https?:|data:)/i.test(String(ref));
}

/** Absolute path of a workspace-relative reference file. */
function resolveLocal(root, ref) {
  const clean = String(ref).replace(/\\/g, '/');
  if (path.isAbsolute(clean)) return clean;
  return path.join(root || process.cwd(), ...clean.split('/'));
}

function mimeOf(file) {
  return MIME_BY_EXT[path.extname(String(file)).toLowerCase()] || 'image/png';
}

/**
 * Read reference images for a live request. Remote URLs and data URIs pass
 * through untouched. A missing local file is an error: a request that
 * silently drops an identity reference produces the wrong character.
 * @returns {{ref: string, remote: boolean, mime?: string, base64?: string}[]}
 */
function readImages(refs, root) {
  return (refs || []).map((ref) => {
    if (isRemote(ref)) return { ref: String(ref), remote: true };
    const file = resolveLocal(root, ref);
    if (!fs.existsSync(file)) throw new Error(`reference image not found: ${ref}`);
    return { ref: String(ref), remote: false, mime: mimeOf(file), base64: fs.readFileSync(file).toString('base64') };
  });
}

/** Local file -> data URI; remote URLs pass through. Live generate() only. */
function toDataUri(ref, root) {
  const [img] = readImages([ref], root);
  return img.remote ? img.ref : `data:${img.mime};base64,${img.base64}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** JSON fetch wrapper. Never logs headers (they may carry credentials). */
async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (err) {
    // non-JSON body; keep raw text
  }
  if (!res.ok) {
    const detail = json && (json.error && (json.error.message || json.error)) ||
      (text ? text.slice(0, 300) : res.statusText);
    throw new Error(`HTTP ${res.status} from ${url.split('?')[0]}: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}`);
  }
  return json;
}

/**
 * Poll an async job until check() returns a truthy result or the timeout hits.
 * @param {() => Promise<any>} check resolves to a truthy value when finished
 */
async function pollUntil(check, { intervalMs = 5000, timeoutMs = 600000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error('polling timed out');
    await sleep(intervalMs);
  }
}

module.exports = {
  DEFAULT_ASPECT_RATIO,
  stableStringify,
  hashObject,
  assertEnv,
  packageParams,
  aspectRatioOf,
  refImage,
  refId,
  attachments,
  checkCapabilities,
  resolveModel,
  baseMeta,
  providerTag,
  makeRecord,
  applyReported,
  markSucceeded,
  markFailed,
  isRemote,
  resolveLocal,
  mimeOf,
  readImages,
  toDataUri,
  sleep,
  fetchJson,
  pollUntil,
};
