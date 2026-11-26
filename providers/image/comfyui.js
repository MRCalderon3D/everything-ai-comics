'use strict';
/**
 * ComfyUI image provider (self-hosted).
 *
 * COMFYUI_HOST is a host:port (e.g. 127.0.0.1:8188). It is not a secret, but
 * it is still required before a live run. The workflow graph is
 * configuration: pass a full ComfyUI API-format workflow via
 * options.workflow. The default below is a minimal text-to-image graph for
 * the checkpoint named in options.model or the package's `model` field
 * (default 'sd_xl_base_1.0.safetensors'). That default graph wires no input
 * images, so compile() warns when a package carries references; the budget
 * of eight describes a graph of your own with reference conditioning nodes.
 * SDXL-class checkpoints do not draw legible lettering, hence
 * textRendering: 'none' (use overlay lettering).
 *
 * ComfyUI takes pixel sizes: ASPECT_TO_SIZE maps each supported ratio.
 */

const {
  assertEnv, checkCapabilities, makeRecord, markSucceeded, markFailed, applyReported,
  fetchJson, pollUntil, aspectRatioOf, attachments, baseMeta, resolveModel,
} = require('../lib/common');

const DEFAULT_MODEL = 'sd_xl_base_1.0.safetensors';
const SAMPLER_NODE = '5';

const ASPECT_TO_SIZE = {
  '2:3': [832, 1216],
  '3:4': [896, 1152],
  '9:16': [768, 1344],
  '1:1': [1024, 1024],
  '3:2': [1216, 832],
  '4:3': [1152, 896],
  '16:9': [1344, 768],
};

function defaultWorkflow(pkg, model, seed) {
  const [width, height] = ASPECT_TO_SIZE[aspectRatioOf(pkg)];
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: pkg.prompt || '', clip: ['1', 1] } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: pkg.negative_prompt || '', clip: ['1', 1] } },
    4: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    [SAMPLER_NODE]: {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
        seed: seed === null ? 0 : seed,
        steps: 28, cfg: 6.5, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
      },
    },
    6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: pkg.page || pkg.asset || 'eac' } },
  };
}

const provider = {
  id: 'comfyui',
  kind: 'image',
  label: 'ComfyUI (self-hosted)',
  env: ['COMFYUI_HOST'],
  capabilities: {
    referenceImages: 8,
    aspectRatios: Object.keys(ASPECT_TO_SIZE),
    imageEditing: false,
    textRendering: 'none',
  },

  /** prompt package -> ComfyUI /prompt request spec. Pure, no I/O. */
  compile(promptPackage, options = {}) {
    checkCapabilities(promptPackage, provider.capabilities, provider.id);
    const model = resolveModel(promptPackage, options, DEFAULT_MODEL);
    const meta = baseMeta(promptPackage);
    const images = attachments(promptPackage);
    const ownGraph = Boolean(options.workflow);
    if (!ownGraph && images.length) {
      meta.warnings.push(`the default ComfyUI graph is text-to-image and does not wire the ${images.length} input image(s); pass a workflow with reference conditioning nodes`);
    }
    // The default graph randomizes an unpinned seed at live time and records it.
    meta.randomize_seed = !ownGraph && meta.seed === null;
    return {
      provider: provider.id,
      kind: provider.kind,
      model,
      // Host is resolved from COMFYUI_HOST at generate() time; the request
      // spec stays host-independent so it is portable between machines.
      endpoint: '/prompt',
      method: 'POST',
      body: { prompt: options.workflow || defaultWorkflow(promptPackage, model, meta.seed) },
      meta,
    };
  },

  /** Dry-run by default; live mode queues the graph and polls the history. */
  async generate(requestSpec, { dryRun = true, outDir, root } = {}) {
    if (dryRun) {
      return makeRecord(requestSpec, {
        notes: 'Dry run: no network call. Re-run with --live --yes with COMFYUI_HOST set.',
      });
    }
    assertEnv(provider.env);
    const host = process.env.COMFYUI_HOST.replace(/\/$/, '');
    const base = host.startsWith('http') ? host : `http://${host}`;
    const record = makeRecord(requestSpec, { status: 'pending' });
    try {
      const body = JSON.parse(JSON.stringify(requestSpec.body));
      const sampler = body.prompt && body.prompt[SAMPLER_NODE];
      let usedSeed = null;
      if (requestSpec.meta && requestSpec.meta.randomize_seed && sampler && sampler.inputs) {
        usedSeed = Math.floor(Math.random() * 0xffffffff);
        sampler.inputs.seed = usedSeed;
      }
      const queued = await fetchJson(`${base}${requestSpec.endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const promptId = queued.prompt_id;
      const history = await pollUntil(async () => {
        const h = await fetchJson(`${base}/history/${promptId}`);
        return h && h[promptId] ? h[promptId] : null;
      }, { intervalMs: 2000 });
      const urls = [];
      for (const node of Object.values(history.outputs || {})) {
        for (const img of node.images || []) {
          urls.push(`${base}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${img.type || 'output'}`);
        }
      }
      markSucceeded(record, `ComfyUI workflow finished with ${urls.length} image(s).`, urls, promptId);
      if (usedSeed !== null) applyReported(record, { seed: usedSeed });
    } catch (err) {
      markFailed(record, err);
    }
    return record;
  },
};

module.exports = provider;
