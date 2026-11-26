#!/usr/bin/env node
'use strict';
/**
 * A stand-in for the `codex` binary, used in fake mode through CODEX_BIN.
 *
 * The codex-cli image provider runs `codex exec ... -o <file> -` with its
 * instruction on stdin and expects one PNG at the path the instruction
 * names. This script does exactly that with a placeholder image, so the
 * real provider, generate-assets.js and the naming of renders all run as
 * they do with the real tool. It never draws anything worth looking at.
 *
 * Words in the prompt change what it does, for tests:
 *   FAILDRAW   exit with code 1 and save no image
 *   SLOWDRAW   wait before drawing (STUDIO_FAKE_SLOW_MS, default 4000 ms)
 */

const fs = require('fs');
const path = require('path');
const { placeholder, sizeFor } = require('./images');

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function argAfter(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** What the image stands for and which version it is, read from where it will be saved. */
function describeTarget(outDir) {
  const dirName = path.basename(outDir);
  const parent = path.basename(path.dirname(outDir));
  let label = parent;
  let tiers = null;
  if (dirName === 'renders' && parent === 'cover') {
    const issue = path.basename(path.dirname(path.dirname(outDir)));
    label = issue.replace(/^ISS_/, 'CV_');
  } else if (dirName === 'renders') {
    try {
      const yaml = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'yaml.js'));
      const page = yaml.parse(fs.readFileSync(path.join(path.dirname(outDir), 'page.yaml'), 'utf8'));
      if (page && page.layout && Array.isArray(page.layout.tiers)) tiers = page.layout.tiers;
    } catch (err) {
      tiers = null;
    }
  } else if (dirName === 'style') {
    label = 'LOOK';
  }
  let version = 1;
  try {
    for (const name of fs.readdirSync(outDir)) {
      const m = /_V(\d{2})\.(png|jpe?g|webp)$/i.exec(name);
      if (m && !/_MASTER_/.test(name)) version = Math.max(version, parseInt(m[1], 10) + 1);
    }
  } catch (err) {
    version = 1;
  }
  return { label, tiers, version };
}

async function main() {
  if (process.argv.includes('--version')) {
    process.stdout.write('codex-cli 0.0.0-fake\n');
    return 0;
  }
  const input = await readStdin();
  const messageFile = argAfter('-o') || argAfter('--output-last-message');
  emit({ type: 'thread.started', thread_id: 'fake-thread-0001' });
  emit({ type: 'turn.started' });

  const out = /Save exactly one PNG file at this absolute path and nowhere else:\s*\r?\n(.+)/.exec(input);
  if (!out) {
    emit({ type: 'turn.failed', error: { message: 'the fake codex found no output path in its instruction' } });
    return 1;
  }
  const outputFile = out[1].trim();
  if (/\bFAILDRAW\b/.test(input)) {
    emit({ type: 'turn.failed', error: { message: 'the fake codex was told to fail (FAILDRAW)' } });
    return 1;
  }
  if (/\bSLOWDRAW\b/.test(input)) {
    const ms = Number.parseInt(process.env.STUDIO_FAKE_SLOW_MS || '', 10);
    await new Promise((resolve) => setTimeout(resolve, Number.isFinite(ms) && ms > 0 ? ms : 4000));
  }

  const ratio = (/(?:Target aspect ratio|Aspect ratio) (\d+:\d+)/.exec(input) || [])[1] || '2:3';
  const size = sizeFor(ratio);
  const target = describeTarget(path.dirname(outputFile));
  const repair = /\bREPAIR\b/.test(input) && /Edit Image 1/.test(input);
  emit({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'image_gen (fake)', status: 'in_progress' } });
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, placeholder({
    width: size.width,
    height: size.height,
    label: target.label,
    version: target.version,
    tiers: target.tiers,
    tag: repair ? 'REPAIR' : '',
  }));
  const reply = JSON.stringify({
    saved_path: outputFile, width: size.width, height: size.height, references_passed: true, model: null,
    notes: 'Placeholder from the fake drawing tool. Not art.',
  });
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: reply } });
  emit({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } });
  if (messageFile) fs.writeFileSync(messageFile, reply);
  return 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  process.stderr.write(`fake codex: ${err.message}\n`);
  process.exitCode = 1;
});
