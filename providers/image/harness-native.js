'use strict';
/**
 * Harness-native image provider.
 * For harnesses with their own image generation: Codex generates with
 * gpt-image through the user's subscription, other harnesses may have an MCP
 * image tool. No env vars, no network. compile() builds a handoff package
 * (prompt, ordered reference images with one role each, target output) and
 * generate() always returns a dry_run record telling the harness where to
 * save the result. Provenance works as for any API provider: the package is
 * compiled first, the references are attached as input images, and the
 * record is completed after the tool call.
 */

const { compileHandoff, handoffRecord } = require('../lib/handoff');

const HARNESS_HINTS = {
  codex: 'Codex: generate with gpt-image and attach every listed image as an input, in the listed order.',
  claude: 'Claude Code: use a connected image-generation MCP tool; without one, hand the package to a person (provider manual).',
  cursor: 'Cursor: use a connected image tool, or hand the package to a person.',
  opencode: 'OpenCode: use a connected image tool, or hand the package to a person.',
};

const INSTRUCTIONS =
  'Generate this image with the harness\'s own image tool. Attach every image ' +
  'in body.images as an input, in the listed order: the prompt refers to them ' +
  'as Image 1, Image 2, and so on, and each has one role. In repair mode ' +
  'Image 1 is the page to edit; change only what the prompt lists. If the ' +
  'tool does not offer the exact aspect ratio (gpt-image renders 1:1, 3:2 and ' +
  '2:3), generate the nearest larger frame and crop to the target ratio, and ' +
  'say so in the record notes. Save the file at body.output.path. Never ' +
  'overwrite an earlier render: a new attempt is a new version.';

const provider = {
  id: 'harness-native',
  kind: 'image',
  label: 'Harness-native image generation (Codex gpt-image or an MCP image tool)',
  env: [],
  capabilities: {
    referenceImages: 4,
    aspectRatios: ['2:3', '3:4', '9:16', '1:1', '4:5', '3:2', '4:3', '16:9'],
    imageEditing: true,
    textRendering: 'unreliable',
  },

  /** prompt package -> handoff spec for the harness image tool. Pure, no I/O. */
  compile(promptPackage, options = {}) {
    return compileHandoff(provider, promptPackage, options, INSTRUCTIONS, {
      harness_hints: HARNESS_HINTS,
    });
  },

  /** Always a dry_run record: the harness produces the image, not this call. */
  async generate(requestSpec, options = {}) {
    return handoffRecord(requestSpec,
      'harness-native provider: there is no API to call. Generate the image with ' +
      'the harness\'s own image tool from the request spec (body.prompt, with ' +
      'body.images attached in order).');
  },
};

module.exports = provider;
