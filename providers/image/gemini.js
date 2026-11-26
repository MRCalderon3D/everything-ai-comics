'use strict';
/**
 * Google Gemini image provider.
 *
 * The default model 'gemini-2.5-flash-image' is configuration; override it
 * with options.model or the prompt package's `model` field. The model takes
 * its aspect ratio by name, reads input images as inline parts, and edits an
 * image it is given, so it can run repairs. Input images are attached in
 * attachment order (the edit target of a repair first), which is the order
 * the prompt's reference legend numbers them in.
 *
 * Gemini-class models respond to prose, not keyword lists. The compiled
 * prompt is written as sentences; keep it that way for this provider.
 */

const {
  assertEnv, checkCapabilities, makeRecord, markSucceeded, markFailed,
  aspectRatioOf, baseMeta, resolveModel, readImages, sleep,
} = require('../lib/common');

const DEFAULT_MODEL = 'gemini-2.5-flash-image';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const provider = {
  id: 'gemini',
  kind: 'image',
  label: 'Google Gemini',
  env: ['GOOGLE_API_KEY'],
  capabilities: {
    referenceImages: 3,
    aspectRatios: ['2:3', '3:4', '9:16', '1:1', '4:5', '3:2', '4:3', '5:4', '16:9', '21:9'],
    imageEditing: true,
    textRendering: 'unreliable',
  },

  /** prompt package -> generateContent request spec. Pure, no I/O. */
  compile(promptPackage, options = {}) {
    checkCapabilities(promptPackage, provider.capabilities, provider.id);
    const model = resolveModel(promptPackage, options, DEFAULT_MODEL);
    let text = promptPackage.prompt;
    if (promptPackage.negative_prompt) {
      // Gemini takes exclusions as prose, not as a separate field.
      text += `\n\nAvoid: ${promptPackage.negative_prompt}.`;
    }
    return {
      provider: provider.id,
      kind: provider.kind,
      model,
      endpoint: `${API_BASE}/models/${model}:generateContent`,
      method: 'POST',
      body: {
        // Live generate() appends meta.reference_paths as inline image parts.
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio: aspectRatioOf(promptPackage) },
        },
      },
      meta: baseMeta(promptPackage),
    };
  },

  /** Dry-run by default; live mode calls generateContent with retry and backoff. */
  async generate(requestSpec, { dryRun = true, outDir, root } = {}) {
    if (dryRun) {
      return makeRecord(requestSpec, {
        notes: 'Dry run: no network call. Re-run with --live --yes to submit to the Gemini API.',
      });
    }
    assertEnv(provider.env);
    const record = makeRecord(requestSpec, { status: 'pending' });
    try {
      // Inline the input images on a copy; the request spec on disk stays small.
      const body = JSON.parse(JSON.stringify(requestSpec.body));
      const parts = body.contents[0].parts;
      for (const img of readImages((requestSpec.meta && requestSpec.meta.reference_paths) || [], root)) {
        if (img.remote) throw new Error(`Gemini needs local reference files, got ${img.ref.slice(0, 60)}`);
        parts.push({ inline_data: { mime_type: img.mime, data: img.base64 } });
      }
      // 429/5xx: bounded exponential backoff.
      let res = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const raw = await fetch(requestSpec.endpoint, {
          method: 'POST',
          headers: {
            'x-goog-api-key': process.env.GOOGLE_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        if (raw.status === 429 || raw.status >= 500) {
          await sleep(2000 * Math.pow(2, attempt));
          continue;
        }
        res = await raw.json().catch(() => null);
        if (!raw.ok) {
          const msg = (res && res.error && res.error.message) || `HTTP ${raw.status}`;
          throw new Error(`Gemini API error: ${String(msg).slice(0, 300)}`);
        }
        break;
      }
      if (!res) throw new Error('Gemini API unavailable after retries (rate limit or server errors)');

      const candidate = (res.candidates && res.candidates[0]) || {};
      const images = ((candidate.content && candidate.content.parts) || [])
        .filter((pt) => pt.inlineData && pt.inlineData.data);
      if (!images.length) {
        const block = (res.promptFeedback && res.promptFeedback.blockReason) ||
          candidate.finishReason || 'no image parts in response';
        // A safety block is a prompt defect to fix upstream. Reroll as a new
        // attempt so provenance shows both.
        throw new Error(`Gemini returned no image (${block}). If it was safety-blocked, rephrase the flagged content and generate a new attempt.`);
      }
      // Raw bytes ride on the non-persisted _media field; generate-assets.js
      // writes the files and fills media_files with their real paths.
      record._media = images.map((pt) => ({
        data_base64: pt.inlineData.data,
        format: (pt.inlineData.mimeType || 'image/png').split('/')[1],
      }));
      markSucceeded(record, `Gemini returned ${images.length} image(s).`,
        record._media.map((m, i) => `inline image ${i + 1} (${m.format})`));
    } catch (err) {
      markFailed(record, err);
    }
    return record;
  },
};

module.exports = provider;
