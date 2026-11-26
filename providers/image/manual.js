'use strict';
/**
 * Manual image provider: a person generates the page by hand in a web UI or
 * a desktop tool the scaffold has no adapter for. No env vars, no network.
 * compile() builds a copy-paste handoff package (the final prompt, the
 * reference images to upload in order with the role of each, the aspect
 * ratio, the target output) and generate() always returns a dry_run record
 * telling the person where to save the download. Provenance works as for
 * any API provider: the record is completed with the saved file.
 */

const { compileHandoff, handoffRecord } = require('../lib/handoff');

const INSTRUCTIONS =
  'Manual generation. 1) Upload the images in body.images in the listed ' +
  'order; the prompt calls them Image 1, Image 2, and so on, and each has one ' +
  'role. If the tool takes fewer images than listed, stop and rebuild the ' +
  'reference plan for a smaller budget instead of dropping one by hand. ' +
  '2) Paste body.prompt unchanged and set the aspect ratio. 3) In repair ' +
  'mode Image 1 is the page to edit: use the tool\'s edit or inpaint feature ' +
  'and change only what the prompt lists. 4) Download the result to ' +
  'body.output.path. Never overwrite an earlier render. 5) Complete the ' +
  'generation record with the file and whatever the tool shows (model name, ' +
  'seed, cost); leave the rest unavailable.';

const provider = {
  id: 'manual',
  kind: 'image',
  label: 'Manual image generation (any web UI or desktop tool)',
  env: [],
  capabilities: {
    referenceImages: 4,
    aspectRatios: ['2:3', '3:4', '9:16', '1:1', '4:5', '3:2', '4:3', '16:9'],
    imageEditing: true,
    textRendering: 'unreliable',
  },

  /** prompt package -> copy-paste handoff spec. Pure, no I/O. */
  compile(promptPackage, options = {}) {
    return compileHandoff(provider, promptPackage, options, INSTRUCTIONS);
  },

  /** Always a dry_run record: the person generates the image, not this call. */
  async generate(requestSpec, options = {}) {
    return handoffRecord(requestSpec,
      'manual provider: there is no API to call. Generate the image by hand ' +
      'following body.instructions in the request spec.');
  },
};

module.exports = provider;
