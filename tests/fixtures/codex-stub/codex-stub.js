#!/usr/bin/env node
'use strict';
/**
 * A stand-in for the `codex` binary, for tests. Injected through CODEX_BIN.
 * It never draws: it reads the instruction on stdin, finds the path it is
 * told to save at, and writes a small valid PNG there.
 *
 * Behaviour is chosen with CODEX_STUB_MODE:
 *   ok (default)  save a PNG, write the JSON reply, exit 0
 *   exit-after    save a PNG, exit 2 (the image exists, the exit code is odd)
 *   fail          exit 3 without saving anything
 *   nofile        exit 0 without saving anything
 *   notimage      save a text file at the path, exit 0
 *   quota         what Codex did in a real run when its image tool hit its
 *                 usage limit: an error item, then a final JSON whose notes
 *                 say so, exit 0, no image
 *   quota-cli     the CLI itself out of quota: a failed turn with the
 *                 CLI's wording and a reset time, exit 1, no image
 *   hang          start a child that writes CODEX_STUB_MARKER after 1.5 s,
 *                 then wait forever (for the timeout and cancel tests)
 *
 * Other settings:
 *   CODEX_STUB_LOG     file that receives { argv, stdin } as JSON
 *   CODEX_STUB_SIZE    "WxH" of the PNG, default 20x30
 *   CODEX_STUB_MODEL   image model named in the reply (default: null)
 *   CODEX_STUB_COUNT   references_count in the reply (default: the number of
 *                      -i images, when every one of them exists)
 *   CODEX_STUB_REF_MODE  reference_mode in the reply (default:
 *                      referenced_image_paths); "omit" leaves both fields out
 *
 * Every run writes noise to stderr, the way the real tool does.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const png = require('../../../scripts/lib/png');

const argv = process.argv.slice(2);
const mode = process.env.CODEX_STUB_MODE || 'ok';

if (argv.includes('--version')) {
  console.log('codex-cli 0.0.0-stub');
  process.exit(0);
}

function valueOf(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : null;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function readStdin() {
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { text += chunk; });
    process.stdin.on('end', () => resolve(text));
  });
}

async function main() {
  const stdin = await readStdin();
  if (process.env.CODEX_STUB_LOG) {
    fs.writeFileSync(process.env.CODEX_STUB_LOG, JSON.stringify({ argv, stdin, cwd: process.cwd() }));
  }
  process.stderr.write('ERROR rmcp::transport: mcp server "example" failed to start: connection refused\n');
  emit({ type: 'thread.started', thread_id: 'stub-thread-0001' });
  emit({ type: 'turn.started' });

  const lines = stdin.split(/\r?\n/);
  const at = lines.findIndex((line) => /^Save exactly one PNG file at this absolute path/.test(line));
  const target = at !== -1 ? lines[at + 1].trim() : null;
  const lastMessageFile = valueOf('-o');
  const images = argv.reduce((list, arg, i) => (arg === '-i' ? list.concat(argv[i + 1]) : list), []);
  const say = (text) => {
    emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } });
    if (lastMessageFile) fs.writeFileSync(lastMessageFile, text);
  };

  if (mode === 'hang') {
    if (process.env.CODEX_STUB_MARKER) {
      // A grandchild that outlives a plain kill of this process: only a
      // tree kill stops it before it writes the marker.
      const code = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(process.env.CODEX_STUB_MARKER)}, 'alive'), 1500)`;
      spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
    }
    emit({ type: 'item.started', item: { id: 'item_0', type: 'image_generation' } });
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'fail') {
    process.stderr.write('stream error: unexpected status 500\n');
    process.exit(3);
  }
  if (mode === 'quota') {
    emit({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: "The built-in tool's usage limit was reached." } });
    say(JSON.stringify({ saved_path: null, width: null, height: null, reference_mode: 'none', references_count: 0, model: null,
      notes: 'Image generation failed because the usage limit was reached. Try again at 6:40 PM.' }));
    emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
    process.exit(0);
  }
  if (mode === 'quota-cli') {
    emit({ type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade to Pro or try again at Nov 30th, 2026 3:15 PM." } });
    process.exit(1);
  }
  if (mode === 'nofile') {
    say('I could not generate the image.');
    emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
    process.exit(0);
  }
  if (!target) {
    say('No output path in the instruction.');
    process.exit(4);
  }
  if (mode === 'notimage') {
    fs.writeFileSync(target, 'this is not an image\n');
    say(JSON.stringify({ saved_path: target, width: 0, height: 0, reference_mode: 'referenced_image_paths', references_count: images.length, model: null, notes: '' }));
    process.exit(0);
  }

  const [width, height] = (process.env.CODEX_STUB_SIZE || '20x30').split('x').map(Number);
  const data = Buffer.alloc(width * height * 3, 200);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, png.encode({ width, height, data, colorType: 'rgb' }));
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'image_generation' } });
  const reply = { saved_path: target, width, height };
  if (process.env.CODEX_STUB_REF_MODE !== 'omit') {
    reply.reference_mode = process.env.CODEX_STUB_REF_MODE || 'referenced_image_paths';
    reply.references_count = process.env.CODEX_STUB_COUNT !== undefined
      ? Number(process.env.CODEX_STUB_COUNT)
      : images.filter((file) => fs.existsSync(file)).length;
  }
  reply.model = process.env.CODEX_STUB_MODEL || null;
  reply.notes = '';
  say(JSON.stringify(reply));
  emit({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } });
  process.exit(mode === 'exit-after' ? 2 : 0);
}

main().catch((err) => {
  process.stderr.write(`stub crashed: ${err.stack || err}\n`);
  process.exit(9);
});
