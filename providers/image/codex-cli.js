'use strict';
/**
 * Codex CLI image provider.
 *
 * Draws through the Codex command-line tool the user is signed in to:
 * `codex exec` runs headless, takes the reference images as attachments and
 * uses Codex's own image generation tool. No API key and no network call
 * from this process. Where harness-native writes a handoff package and waits
 * for the harness to act on it, this provider runs the tool itself and
 * returns the image.
 *
 * compile() is pure and builds the same package a handoff carries: the
 * prompt, the input images in attachment order with the one role of each,
 * the target ratio and the frame to render it in. The prompt refers to the
 * images as Image 1, Image 2, in that order; in repair mode Image 1 is the
 * page to edit.
 *
 * generate() in live mode spawns
 *   codex exec --skip-git-repo-check --ephemeral -s workspace-write
 *              -C <outDir> --json -o <last message file> [-m <model>]
 *              -i <image> ... -
 * with the instruction on stdin (`-i` takes several values, so a prompt on
 * the command line would be read as one more image). Codex saves one PNG at
 * a temporary path inside outDir; the file is read into the record's _media
 * field and deleted, and scripts/generate-assets.js names the render.
 *
 * Environment (all optional, none is a secret):
 *   CODEX_BIN               path of the codex executable, or of a stub
 *   CODEX_IMAGE_TIMEOUT_MS  limit for one image, default 900000 (15 minutes)
 *   CODEX_IMAGE_MODEL       model for the Codex session (`-m`)
 *
 * What is recorded: the image model is `unreported` unless Codex names it in
 * its reply, the cost is null (the run is covered by the Codex plan, and no
 * amount is reported), and a pinned seed is not honoured, so the seed stays
 * null. The run time goes into the response summary.
 *
 * A run fails on its exit code and on the missing output file, never on
 * what the tool writes to stderr: Codex prints unrelated noise there.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  checkCapabilities, makeRecord, markSucceeded, markFailed, applyReported, baseMeta,
  resolveModel, attachments, packageParams, aspectRatioOf, isRemote, resolveLocal,
} = require('../lib/common');
const { resolveBinary, spawnCli } = require('../lib/cli-spawn');
const { imageInfo } = require('../../scripts/lib/image-info');

const DEFAULT_TIMEOUT_MS = 900000;
/** Frames Codex's image tool renders. Any other ratio is drawn in the nearest one. */
const NATIVE_FRAMES = ['1:1', '2:3', '3:2'];

const INSTRUCTIONS =
  'Draw this image with your own image generation tool. Attach every image in ' +
  'body.images as an input, in the listed order: the prompt refers to them as ' +
  'Image 1, Image 2, and so on, and each has one role. In repair mode Image 1 ' +
  'is the page to edit; change only what the prompt lists. Render the frame ' +
  'body.frame names. Do not write code to draw the image. Save exactly one ' +
  'PNG at the path the run gives you.';

function ratioValue(ratio) {
  const m = /^(\d+):(\d+)$/.exec(String(ratio));
  return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : null;
}

/** The frame to render a target ratio in. Pure. */
function frameFor(ratio) {
  const target = ratioValue(ratio);
  if (NATIVE_FRAMES.includes(ratio) || target === null) {
    return { target: ratio, render: ratio, native: true };
  }
  let best = NATIVE_FRAMES[0];
  for (const frame of NATIVE_FRAMES) {
    if (Math.abs(Math.log(target / ratioValue(frame))) < Math.abs(Math.log(target / ratioValue(best)))) best = frame;
  }
  return { target: ratio, render: best, native: false };
}

function orientation(ratio) {
  const value = ratioValue(ratio);
  if (value === null || value === 1) return 'square';
  return value < 1 ? 'portrait' : 'landscape';
}

/**
 * The text Codex reads on stdin. Model-facing.
 * @param {object} body request spec body
 * @param {string} outputFile absolute path the PNG must be saved at
 */
function buildInstruction(body, outputFile) {
  const images = Array.isArray(body.images) ? body.images : [];
  const frame = body.frame || frameFor(body.aspect_ratio);
  const lines = [
    'You are drawing one image for a comic production. Use your built-in image generation tool.',
    'Do not write code, a script, SVG or HTML to draw or assemble the image. Do not edit or create any file other than the one named under OUTPUT.',
    '',
    'INPUT IMAGES',
  ];
  if (images.length) {
    lines.push(`${images.length} image${images.length === 1 ? ' is' : 's are'} attached to this message, in this order:`);
    for (const img of images) {
      lines.push(`Image ${img.position}: ${String(img.role || 'reference').replace(/_/g, ' ')}${img.asset_id ? ` (${img.asset_id})` : ''}`);
    }
    lines.push('The prompt refers to them by these numbers. Pass every one of them to the image tool as an input image, in this order.');
    if (body.mode === 'repair') {
      lines.push('Image 1 is the page to edit. Change only what the prompt lists and keep everything else exactly as it is.');
    }
  } else {
    lines.push('None. Draw from the prompt alone.');
  }
  lines.push('', 'FRAME');
  if (frame.native) {
    lines.push(`Aspect ratio ${frame.target} (${orientation(frame.target)}).`);
  } else {
    lines.push(
      `Target aspect ratio ${frame.target} (${orientation(frame.target)}). The image tool does not render that ratio: ` +
      `render the ${frame.render} frame, the nearest one it offers, and keep everything that matters inside a centred ` +
      `${frame.target} area. The file is cropped to ${frame.target} afterwards, so nothing may sit in the part that is cut away.`);
  }
  lines.push('', 'PROMPT', String(body.prompt || ''));
  if (body.negative_prompt) lines.push('', `Avoid: ${body.negative_prompt}`);
  lines.push(
    '',
    'OUTPUT',
    'Save exactly one PNG file at this absolute path and nowhere else:',
    outputFile,
    '',
    'REPLY',
    'When the file is saved, reply with one JSON object and nothing else:',
    '{"saved_path": "<the absolute path>", "width": <pixels>, "height": <pixels>, "references_passed": <true or false>, "model": <"name of the image model" or null>, "notes": "<anything that went differently, or an empty string>"}',
    '"references_passed" is true only when every attached image went into the image tool call. "model" is null when the tool does not name its model.');
  return `${lines.join('\n')}\n`;
}

/** The JSON object in Codex's last message, or null. */
function parseReply(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(source.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (err) {
    return null;
  }
}

/** One short line per JSONL event of `codex exec --json`, for progress display. */
function progressLine(line, state) {
  const text = String(line).trim();
  if (!text) return null;
  let event;
  try {
    event = JSON.parse(text);
  } catch (err) {
    return text.slice(0, 200);
  }
  if (!event || typeof event !== 'object') return null;
  if (typeof event.thread_id === 'string' && !state.threadId) state.threadId = event.thread_id;
  const item = event.item && typeof event.item === 'object' ? event.item : null;
  if (item && typeof item.text === 'string' && /message/.test(String(item.type))) state.lastMessage = item.text;
  const type = String(event.type || 'event');
  if (item) {
    const detail = typeof item.text === 'string' ? item.text
      : typeof item.command === 'string' ? item.command : '';
    const short = detail.replace(/\s+/g, ' ').trim().slice(0, 160);
    return `codex ${type}: ${item.type || 'item'}${short ? `: ${short}` : ''}`;
  }
  return `codex ${type}`;
}

function lastLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 300) : '';
}

function removeQuietly(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch (err) { /* a leftover temporary file is not worth failing over */ }
}

function timeoutFromEnv() {
  const value = Number.parseInt(process.env.CODEX_IMAGE_TIMEOUT_MS || '', 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

/**
 * The record of a Codex run. The request names the session model at most:
 * the image model is whatever Codex's tool uses, so it starts as unreported,
 * and a seed cannot be pinned.
 */
function codexRecord(requestSpec, extra) {
  const record = makeRecord(Object.assign({}, requestSpec, { handoff: true }), extra);
  record.request.summary = record.request.summary.replace(/^Handoff, no endpoint/, 'codex exec');
  return record;
}

const provider = {
  id: 'codex-cli',
  kind: 'image',
  label: 'Codex CLI (codex exec with its image tool)',
  env: [],
  capabilities: {
    referenceImages: 4,
    aspectRatios: ['2:3', '3:4', '9:16', '1:1', '4:5', '3:2', '4:3', '16:9'],
    imageEditing: true,
    textRendering: 'unreliable',
  },

  /** prompt package -> request spec for a Codex run. Pure, no I/O. */
  compile(promptPackage, options = {}) {
    checkCapabilities(promptPackage, provider.capabilities, provider.id);
    const params = packageParams(promptPackage);
    const ratio = aspectRatioOf(promptPackage);
    const frame = frameFor(ratio);
    const meta = baseMeta(promptPackage);
    if (!frame.native) {
      meta.warnings.push(
        `aspect ratio ${ratio} is not a frame the Codex image tool renders: the image comes back as ${frame.render} ` +
        `with the content inside a centred ${ratio} area, and needs a crop to ${ratio}`);
    }
    if (Number.isInteger(params.seed)) {
      meta.warnings.push('the Codex image tool takes no seed: the pinned seed is ignored and recorded as unavailable');
    }
    return {
      provider: provider.id,
      kind: provider.kind,
      model: resolveModel(promptPackage, options, provider.id),
      endpoint: null,
      method: null,
      body: {
        mode: promptPackage.mode || 'generate',
        prompt: promptPackage.prompt,
        negative_prompt: promptPackage.negative_prompt || null,
        aspect_ratio: ratio,
        frame,
        resolution: params.resolution || null,
        images: attachments(promptPackage),
        edit_target: promptPackage.edit_target || null,
        instructions: INSTRUCTIONS,
      },
      meta,
    };
  },

  /**
   * Dry-run by default. Live mode runs `codex exec` and returns a succeeded
   * record with the image on `_media`, or a failed record with a plain
   * message. It never throws for something the tool did.
   * @param {object} requestSpec
   * @param {{dryRun?: boolean, outDir?: string, root?: string, signal?: AbortSignal,
   *          onProgress?: (line: string) => void}} [options]
   */
  async generate(requestSpec, { dryRun = true, outDir, root, signal, onProgress } = {}) {
    if (dryRun) {
      return codexRecord(requestSpec, {
        notes: 'Dry run: nothing was started. Re-run with --live --yes to draw with the Codex CLI ' +
          '(codex exec), which uses the Codex account signed in on this machine.',
      });
    }
    const record = codexRecord(requestSpec, { status: 'pending' });
    const body = requestSpec.body || {};
    const meta = requestSpec.meta || {};
    const tell = (line) => {
      if (typeof onProgress !== 'function' || !line) return;
      try {
        onProgress(line);
      } catch (err) { /* a progress listener must not break the run */ }
    };

    if (signal && signal.aborted) return markFailed(record, new Error('cancelled'));

    const bin = resolveBinary('codex', 'CODEX_BIN');
    if (!bin.found) {
      return markFailed(record, new Error(
        `codex binary not found: ${bin.error}. Install the Codex CLI and sign in, or set CODEX_BIN to its path.`));
    }

    // Input images, in attachment order, as absolute paths.
    const images = [];
    for (const ref of meta.reference_paths || []) {
      if (isRemote(ref)) {
        return markFailed(record, new Error(`the Codex CLI attaches local files only, got ${String(ref).slice(0, 60)}`));
      }
      const file = resolveLocal(root, ref);
      if (!fs.existsSync(file)) return markFailed(record, new Error(`reference image not found: ${ref}`));
      images.push(file);
    }

    const dir = path.resolve(outDir || root || process.cwd());
    const token = `${record.id}-${crypto.randomBytes(4).toString('hex')}`;
    const outputFile = path.join(dir, `.codex-${token}.png`);
    const messageFile = path.join(dir, `.codex-${token}.last-message.txt`);
    const sessionModel = process.env.CODEX_IMAGE_MODEL ||
      (requestSpec.model && requestSpec.model !== provider.id ? requestSpec.model : null);
    const timeoutMs = timeoutFromEnv();

    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'workspace-write',
      '-C', dir, '--json', '-o', messageFile];
    if (sessionModel) args.push('-m', String(sessionModel));
    for (const file of images) args.push('-i', file);
    args.push('-');

    const state = { threadId: null, lastMessage: null };
    const started = Date.now();
    try {
      fs.mkdirSync(dir, { recursive: true });
      tell(`codex: drawing ${record.id} with ${images.length} input image(s), limit ${Math.round(timeoutMs / 1000)} s`);
      let run;
      try {
        run = await spawnCli({
          bin,
          args,
          cwd: dir,
          stdin: buildInstruction(body, outputFile),
          signal,
          timeoutMs,
          onStdout: (line) => tell(progressLine(line, state)),
        });
      } catch (err) {
        return markFailed(record, new Error(err.code === 'BINARY_NOT_FOUND'
          ? `codex binary not found: ${err.message}`
          : `codex could not be started: ${err.message}`));
      }
      const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));

      if (run.cancelled) return markFailed(record, new Error('cancelled'));
      if (run.timedOut) {
        return markFailed(record, new Error(
          `codex exec timed out after ${Math.round(timeoutMs / 1000)} s and its process tree was stopped ` +
          '(raise CODEX_IMAGE_TIMEOUT_MS to wait longer)'));
      }

      let lastMessage = state.lastMessage;
      try {
        if (fs.existsSync(messageFile)) lastMessage = fs.readFileSync(messageFile, 'utf8');
      } catch (err) { /* keep what the event stream gave */ }
      const reply = parseReply(lastMessage);

      if (!fs.existsSync(outputFile)) {
        const said = lastLine(lastMessage);
        const hint = said ? ` Codex said: ${said}` : (lastLine(run.stderr) ? ` Last stderr line: ${lastLine(run.stderr)}` : '');
        return markFailed(record, new Error(run.code === 0
          ? `codex exec finished without saving the image at the requested path.${hint}`
          : `codex exec exited with code ${run.code === null ? `(signal ${run.signal})` : run.code} and saved no image.${hint}`));
      }

      const buffer = fs.readFileSync(outputFile);
      let info;
      try {
        info = imageInfo(buffer);
      } catch (err) {
        return markFailed(record, new Error(
          `the file Codex saved is not an image (${err.message}); ${buffer.length} bytes were discarded`));
      }

      record._media = [{ data_base64: buffer.toString('base64'), format: info.format }];
      const passed = reply && typeof reply.references_passed === 'boolean' ? reply.references_passed : null;
      const refsText = !images.length ? 'no reference images'
        : passed === null ? `${images.length} reference image(s) attached, use not reported`
          : passed ? `${images.length} reference image(s) passed to the image tool, as Codex reports`
            : `${images.length} reference image(s) attached, and Codex reports they were NOT passed to the image tool`;
      markSucceeded(record,
        `Codex saved one ${info.width}x${info.height} ${info.format.toUpperCase()} in ${seconds} s; ${refsText}.`,
        [`inline image 1 (${info.format})`], state.threadId);
      if (reply && typeof reply.model === 'string' && reply.model.trim() && !/^(unknown|unreported|null|none)$/i.test(reply.model.trim())) {
        applyReported(record, { model: reply.model.trim() });
      }

      const notes = [];
      if (sessionModel) notes.push(`Codex session model: ${sessionModel} (the image model is recorded separately).`);
      if (run.code !== 0) notes.push(`codex exec exited with code ${run.code} after saving the image.`);
      if (images.length && passed === false) {
        notes.push('Codex reports the reference images did not reach the image tool: review identity and style as unconditioned.');
      }
      const frame = body.frame || frameFor(body.aspect_ratio);
      const want = ratioValue(frame.target);
      if (!frame.native) {
        notes.push(`Rendered as ${frame.render} because ${frame.target} is not a frame of the image tool: crop the file to ${frame.target} before lettering or export.`);
      } else if (want && Math.abs((info.width / info.height) / want - 1) > 0.02) {
        notes.push(`The image is ${info.width}x${info.height}, which is not ${frame.target}: crop or regenerate before lettering or export.`);
      }
      if (reply && typeof reply.notes === 'string' && reply.notes.trim()) {
        notes.push(`Codex notes: ${reply.notes.trim().replace(/\s+/g, ' ').slice(0, 400)}`);
      }
      if (notes.length) record.notes = notes.join(' ');
      return record;
    } catch (err) {
      return markFailed(record, err);
    } finally {
      removeQuietly(outputFile);
      removeQuietly(messageFile);
    }
  },
};

module.exports = provider;
