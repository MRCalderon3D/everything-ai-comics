'use strict';
/**
 * fal.ai image provider (queue API).
 *
 * The default model 'fal-ai/flux/dev' is configuration. It is a text-to-image
 * model: it reads no input images, so it cannot hold a look master or an
 * identity sheet and cannot repair a page. Pin a multi-image model on the
 * prompt package (`model` field, or `compile-prompts.js --model`) for real
 * page work. Input images travel in `image_urls`, the field fal's
 * multi-image endpoints read; compile() warns when the default model would
 * ignore them and refuses a repair it could not perform.
 *
 * fal takes pixel sizes, not ratios: ASPECT_TO_IMAGE_SIZE maps each
 * supported ratio to a size preset or an explicit width and height.
 */

const {
  assertEnv, checkCapabilities, makeRecord, markSucceeded, markFailed, applyReported,
  fetchJson, pollUntil, packageParams, aspectRatioOf, attachments, baseMeta,
  resolveModel, toDataUri,
} = require('../lib/common');

const DEFAULT_MODEL = 'fal-ai/flux/dev';

const ASPECT_TO_IMAGE_SIZE = {
  '2:3': { width: 1024, height: 1536 },
  '3:4': 'portrait_4_3',
  '9:16': 'portrait_16_9',
  '1:1': 'square_hd',
  '3:2': { width: 1536, height: 1024 },
  '4:3': 'landscape_4_3',
  '16:9': 'landscape_16_9',
};

const provider = {
  id: 'fal',
  kind: 'image',
  label: 'fal.ai',
  env: ['FAL_KEY'],
  capabilities: {
    referenceImages: 4,
    aspectRatios: Object.keys(ASPECT_TO_IMAGE_SIZE),
    imageEditing: true,
    textRendering: 'unreliable',
  },

  /** prompt package (schemas/prompt-package.schema.json) -> fal request spec. Pure. */
  compile(promptPackage, options = {}) {
    checkCapabilities(promptPackage, provider.capabilities, provider.id);
    const model = resolveModel(promptPackage, options, DEFAULT_MODEL);
    const params = packageParams(promptPackage);
    const ratio = aspectRatioOf(promptPackage);
    const images = attachments(promptPackage);
    const meta = baseMeta(promptPackage);
    if (model === DEFAULT_MODEL && promptPackage.mode === 'repair') {
      throw new Error(`prompt package ${promptPackage.id || '(no id)'}: ${DEFAULT_MODEL} is text-to-image and cannot edit a page; pin an image-editing fal model on the package before a repair`);
    }
    if (model === DEFAULT_MODEL && images.length) {
      meta.warnings.push(`${DEFAULT_MODEL} is text-to-image and ignores the ${images.length} input image(s); pin a multi-image fal model so the look master and identity sheets are used`);
    }
    const body = {
      prompt: promptPackage.prompt,
      image_size: ASPECT_TO_IMAGE_SIZE[ratio],
      num_images: 1,
    };
    if (meta.seed !== null) body.seed = meta.seed;
    if (promptPackage.negative_prompt) body.negative_prompt = promptPackage.negative_prompt;
    // Workspace-relative paths here; live generate() inlines them as data URIs.
    if (images.length) body.image_urls = images.map((a) => a.image_path);
    if (params.resolution) meta.target_resolution = params.resolution;
    return {
      provider: provider.id,
      kind: provider.kind,
      model,
      endpoint: `https://queue.fal.run/${model}`,
      method: 'POST',
      body,
      meta,
    };
  },

  /** Dry-run by default; live mode uses the fal queue API and polls. */
  async generate(requestSpec, { dryRun = true, outDir, root } = {}) {
    if (dryRun) {
      return makeRecord(requestSpec, {
        notes: 'Dry run: no network call. Re-run with --live --yes to submit to fal.ai.',
      });
    }
    assertEnv(provider.env);
    const headers = {
      Authorization: `Key ${process.env.FAL_KEY}`,
      'Content-Type': 'application/json',
    };
    const record = makeRecord(requestSpec, { status: 'pending' });
    try {
      const body = Object.assign({}, requestSpec.body);
      if (Array.isArray(body.image_urls)) {
        body.image_urls = body.image_urls.map((ref) => toDataUri(ref, root));
      }
      const queued = await fetchJson(requestSpec.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const statusUrl = queued.status_url || `${requestSpec.endpoint}/requests/${queued.request_id}/status`;
      const responseUrl = queued.response_url || `${requestSpec.endpoint}/requests/${queued.request_id}`;
      await pollUntil(async () => {
        const st = await fetchJson(statusUrl, { headers });
        if (st.status === 'COMPLETED') return st;
        if (st.status === 'FAILED' || st.status === 'ERROR') {
          throw new Error(`fal request failed with status ${st.status}`);
        }
        return null;
      }, { intervalMs: 3000 });
      const result = await fetchJson(responseUrl, { headers });
      const images = (result && (result.images || (result.response && result.response.images))) || [];
      markSucceeded(record, `fal completed with ${images.length} image(s).`,
        images.map((img) => img.url || img), queued.request_id);
      if (result && Number.isInteger(result.seed)) applyReported(record, { seed: result.seed });
    } catch (err) {
      markFailed(record, err);
    }
    return record;
  },
};

module.exports = provider;
