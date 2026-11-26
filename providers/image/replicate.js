'use strict';
/**
 * Replicate image provider.
 *
 * The default model 'black-forest-labs/flux-dev' is configuration; override
 * it with options.model or the prompt package's `model` field. flux-dev
 * takes its aspect ratio by name and accepts one input image, which it uses
 * as an image-to-image source. That is why this adapter declares a budget of
 * one input image and no image editing: a page with a look master and an
 * identity sheet does not fit, and build-reference-plan.js says so instead
 * of dropping a reference.
 */

const {
  assertEnv, checkCapabilities, makeRecord, markSucceeded, markFailed,
  fetchJson, pollUntil, aspectRatioOf, attachments, baseMeta, resolveModel, toDataUri,
} = require('../lib/common');

const DEFAULT_MODEL = 'black-forest-labs/flux-dev';

const provider = {
  id: 'replicate',
  kind: 'image',
  label: 'Replicate (FLUX)',
  env: ['REPLICATE_API_TOKEN'],
  capabilities: {
    referenceImages: 1,
    aspectRatios: ['2:3', '3:4', '9:16', '1:1', '3:2', '4:3', '16:9'],
    imageEditing: false,
    textRendering: 'unreliable',
  },

  /** prompt package -> Replicate prediction request spec. Pure, no I/O. */
  compile(promptPackage, options = {}) {
    checkCapabilities(promptPackage, provider.capabilities, provider.id);
    const model = resolveModel(promptPackage, options, DEFAULT_MODEL);
    const images = attachments(promptPackage);
    const meta = baseMeta(promptPackage);
    const input = {
      prompt: promptPackage.prompt,
      aspect_ratio: aspectRatioOf(promptPackage),
      num_outputs: 1,
      output_format: 'png',
    };
    if (meta.seed !== null) input.seed = meta.seed;
    if (images.length) {
      // Workspace-relative path here; live generate() inlines it as a data URI.
      input.image = images[0].image_path;
      if (model === DEFAULT_MODEL) {
        meta.warnings.push(`${DEFAULT_MODEL} uses its one input image as an image-to-image source, so the result follows that image's composition; expect weak style or identity control`);
      }
    }
    return {
      provider: provider.id,
      kind: provider.kind,
      model,
      endpoint: `https://api.replicate.com/v1/models/${model}/predictions`,
      method: 'POST',
      body: { input },
      meta,
    };
  },

  /** Dry-run by default; live mode creates a prediction and polls it. */
  async generate(requestSpec, { dryRun = true, outDir, root } = {}) {
    if (dryRun) {
      return makeRecord(requestSpec, {
        notes: 'Dry run: no network call. Re-run with --live --yes to submit to Replicate.',
      });
    }
    assertEnv(provider.env);
    const headers = {
      Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
    };
    const record = makeRecord(requestSpec, { status: 'pending' });
    try {
      const input = Object.assign({}, requestSpec.body.input);
      if (input.image) input.image = toDataUri(input.image, root);
      const prediction = await fetchJson(requestSpec.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ input }),
      });
      const pollUrl = (prediction.urls && prediction.urls.get) ||
        `https://api.replicate.com/v1/predictions/${prediction.id}`;
      const done = await pollUntil(async () => {
        const st = await fetchJson(pollUrl, { headers });
        if (st.status === 'succeeded') return st;
        if (st.status === 'failed' || st.status === 'canceled') {
          throw new Error(`replicate prediction ${st.status}: ${st.error || 'no detail'}`);
        }
        return null;
      }, { intervalMs: 3000 });
      const output = Array.isArray(done.output) ? done.output : (done.output ? [done.output] : []);
      markSucceeded(record, `Replicate prediction succeeded with ${output.length} output(s).`,
        output, prediction.id);
    } catch (err) {
      markFailed(record, err);
    }
    return record;
  },
};

module.exports = provider;
