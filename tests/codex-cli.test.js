'use strict';
/**
 * The codex-cli image provider and the CLI spawn helper it is built on.
 * No real `codex` runs here: CODEX_BIN points at tests/fixtures/codex-stub,
 * a node script that reads the instruction on stdin and writes a small PNG
 * where it is told to. Covered: binary resolution (npm shims and batch files
 * on Windows), stdin and argument passing, the tree kill on timeout and
 * cancel, every failure mode of the provider, and the whole path through
 * generateAssets() on a throwaway copy of the example workspace.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cli = require('../providers/lib/cli-spawn');
const provider = require('../providers/image/codex-cli');
const common = require('../providers/lib/common');
const ws = require('../scripts/lib/workspace');
const yaml = require('../scripts/lib/yaml');
const { imageInfo } = require('../scripts/lib/image-info');
const { validateDoc } = require('../scripts/lib/page-pipeline');
const { compilePage } = require('../scripts/compile-prompts');
const gen = require('../scripts/generate-assets');
const { validateWorkspace } = require('../scripts/validate-workspace');

const ROOT = path.resolve(__dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples', 'the-night-ferry');
const STUB = path.join(__dirname, 'fixtures', 'codex-stub', 'codex-stub.js');
const IS_WIN = process.platform === 'win32';
const ENV_KEYS = ['CODEX_BIN', 'CODEX_IMAGE_TIMEOUT_MS', 'CODEX_IMAGE_MODEL', 'CODEX_STUB_MODE', 'CODEX_STUB_LOG',
  'CODEX_STUB_SIZE', 'CODEX_STUB_MODEL', 'CODEX_STUB_COUNT', 'CODEX_STUB_REF_MODE', 'CODEX_STUB_MARKER'];
const quiet = () => {};
const temps = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

/** A scratch copy of the example workspace. */
function makeWorkspace() {
  const root = path.join(tempDir('eac-codex-cli-'), 'production');
  copyTree(EXAMPLE, root);
  return root;
}

/** Set environment variables for one block; everything is restored afterwards. */
async function withEnv(values, fn) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, { CODEX_BIN: STUB }, values);
  try {
    return await fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function leftovers(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith('.codex-')) : [];
}

/** A request spec for page 1 of a scratch workspace, scoped the way generate-assets.js scopes it. */
function pageSpec(root, overrides = {}) {
  const pkg = Object.assign({
    id: 'PP_PG_001_001_CODEX-CLI',
    page: 'PG_001_001',
    asset: null,
    provider: 'codex-cli',
    model: 'pending',
    mode: 'generate',
    prompt: 'High-contrast ink noir comic art.\n\nPAGE\nOne finished comic page. Image 1 fixes the style, Image 2 the pilot.',
    negative_prompt: 'watermark, signature',
    parameters: { aspect_ratio: '2:3', resolution: '2000x3000', seed: null },
    references: [
      { asset_id: 'LOOK_NOIR_INK_MASTER_V01', role: 'style', image_path: 'references/style/LOOK_NOIR_INK_MASTER_V01.png' },
      { asset_id: 'CHAR_MARA_TURN_MASTER_V01', role: 'identity', image_path: 'characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png' },
    ],
    edit_target: null,
    lettering_text: [],
    status: 'compiled',
    source_hashes: { page: '0f3a9c1b2d4e5f60', reference_plan: '7b1c2d3e4f5a6b70', style_block: '9a8b7c6d5e4f3a20' },
  }, overrides);
  const spec = provider.compile(pkg);
  spec.meta.record_id = 'GEN_PG_001_001_05';
  spec.meta.output_render = 'PG_001_001_V02';
  return spec;
}

async function testResolveAndSpawn() {
  // A .js file runs with the current node binary; the override is named by its env var.
  await withEnv({}, async () => {
    const bin = cli.resolveBinary('codex', 'CODEX_BIN');
    assert.strictEqual(bin.found, true);
    assert.strictEqual(bin.source, 'env');
    assert.strictEqual(bin.via, 'node');
    assert.strictEqual(bin.command, process.execPath);
    assert.deepStrictEqual(bin.prefixArgs, [STUB]);
    assert.deepStrictEqual(cli.binaryVersion(bin), { ok: true, version: 'codex-cli 0.0.0-stub', error: null });

    // The override may also be given as the path itself.
    assert.strictEqual(cli.resolveBinary('codex', STUB).path, STUB);
  });

  // An override that points nowhere is an error; it does not fall back to PATH.
  const gone = cli.resolveBinary('node', path.join(os.tmpdir(), 'no-such-dir', 'codex.exe'));
  assert.strictEqual(gone.found, false);
  assert.ok(/not an executable file/.test(gone.error), gone.error);
  const noPath = cli.resolveBinary('codex', 'CODEX_BIN', { env: { PATH: '' } });
  assert.strictEqual(noPath.found, false);
  assert.ok(/not found on PATH and CODEX_BIN is not set/.test(noPath.error), noPath.error);
  assert.strictEqual(cli.binaryVersion(noPath).ok, false);
  await assert.rejects(() => cli.spawnCli({ bin: noPath, args: [] }), (err) => err.code === 'BINARY_NOT_FOUND');

  // node itself is found on PATH and runs directly.
  const node = cli.resolveBinary('node');
  assert.strictEqual(node.found, true);
  assert.strictEqual(node.via, 'direct');

  // stdin reaches the child, stdout arrives line by line, stderr is collected and not judged.
  const dir = tempDir('eac-cli-spawn-');
  const log = path.join(dir, 'log.json');
  const out = path.join(dir, 'last.txt');
  const lines = [];
  const errLines = [];
  const run = await cli.spawnCli({
    bin: STUB,
    args: ['exec', '-o', out, '-'],
    cwd: dir,
    stdin: 'line one\nline two\n',
    env: Object.assign({}, process.env, { CODEX_STUB_MODE: 'nofile', CODEX_STUB_LOG: log }),
    onStdout: (line) => lines.push(line),
    onStderr: (line) => errLines.push(line),
  });
  assert.strictEqual(run.code, 0);
  assert.strictEqual(run.timedOut, false);
  assert.strictEqual(run.cancelled, false);
  assert.ok(lines.length >= 3 && lines.every((l) => l.startsWith('{')), 'one JSONL event per stdout line');
  assert.ok(run.stdout.includes('thread.started'));
  assert.ok(/mcp server/.test(run.stderr) && errLines.length === 1, 'stderr is collected');
  const seen = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.strictEqual(seen.stdin, 'line one\nline two\n');
  assert.deepStrictEqual(seen.argv, ['exec', '-o', out, '-']);
  assert.strictEqual(fs.realpathSync(seen.cwd), fs.realpathSync(dir));

  // A non-zero exit resolves; only a process that cannot start rejects.
  const failed = await cli.spawnCli({
    bin: STUB, args: ['exec', '-'], stdin: 'x', env: Object.assign({}, process.env, { CODEX_STUB_MODE: 'fail' }),
  });
  assert.strictEqual(failed.code, 3);

  // A signal that is already aborted starts nothing.
  const aborted = new AbortController();
  aborted.abort();
  const never = await cli.spawnCli({ bin: STUB, args: ['exec', '-'], stdin: 'x', signal: aborted.signal });
  assert.deepStrictEqual(never, { code: null, signal: null, timedOut: false, cancelled: true, stdout: '', stderr: '' });
}

async function testWindowsShims() {
  if (!IS_WIN) return;
  // Paths with spaces, an ampersand and parentheses: what a project folder can look like.
  const dir = path.join(tempDir('eac-cli-shim-'), 'my comics & drafts (1)');
  const pkgBin = path.join(dir, 'node_modules', '@example', 'codex', 'bin');
  fs.mkdirSync(pkgBin, { recursive: true });
  fs.writeFileSync(path.join(pkgBin, 'codex.js'), `require(${JSON.stringify(STUB)});\n`);
  // The shim npm writes for a global install.
  fs.writeFileSync(path.join(dir, 'codex.cmd'), [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@example\\codex\\bin\\codex.js" %*',
    '',
  ].join('\r\n'));
  // A batch file that is not an npm shim: it goes through cmd.exe.
  fs.writeFileSync(path.join(dir, 'wrapper.cmd'), `@echo off\r\n"${process.execPath}" "${STUB}" %*\r\n`);

  const shim = cli.resolveBinary('codex', path.join(dir, 'codex.cmd'));
  assert.strictEqual(shim.via, 'npm-shim', 'an npm shim is resolved to the script it launches');
  assert.strictEqual(shim.prefixArgs[0], path.join(pkgBin, 'codex.js'));
  assert.strictEqual(cli.binaryVersion(shim).version, 'codex-cli 0.0.0-stub');

  // Found by name on PATH too, without the extension.
  const onPath = cli.resolveBinary('codex', undefined, { env: { PATH: dir } });
  assert.strictEqual(onPath.path, path.join(dir, 'codex.cmd'));

  const awkward = path.join(dir, 'out & in (final) 100%.txt');
  for (const name of ['codex.cmd', 'wrapper.cmd']) {
    const bin = cli.resolveBinary('codex', path.join(dir, name));
    if (name === 'wrapper.cmd') assert.strictEqual(bin.via, 'cmd');
    const log = path.join(dir, `${name}.log.json`);
    const run = await cli.spawnCli({
      bin,
      args: ['exec', '-C', dir, '-o', awkward, '-'],
      stdin: 'prompt with "quotes" & ampersands\n',
      env: Object.assign({}, process.env, { CODEX_STUB_MODE: 'nofile', CODEX_STUB_LOG: log }),
    });
    assert.strictEqual(run.code, 0, `${name}: ${run.stderr}`);
    const seen = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.deepStrictEqual(seen.argv, ['exec', '-C', dir, '-o', awkward, '-'], `${name}: arguments must arrive unchanged`);
    assert.strictEqual(seen.stdin, 'prompt with "quotes" & ampersands\n');
    assert.ok(fs.existsSync(awkward), `${name}: the stub wrote its last message at the awkward path`);
    fs.rmSync(awkward);
  }
}

async function testTreeKill() {
  const dir = tempDir('eac-cli-kill-');

  // Timeout: the stub hangs and has started a child of its own. Both must die.
  const marker = path.join(dir, 'timeout.marker');
  const started = Date.now();
  const timed = await cli.spawnCli({
    bin: STUB,
    args: ['exec', '-'],
    stdin: 'x',
    timeoutMs: 500,
    env: Object.assign({}, process.env, { CODEX_STUB_MODE: 'hang', CODEX_STUB_MARKER: marker }),
  });
  assert.strictEqual(timed.timedOut, true);
  assert.strictEqual(timed.cancelled, false);
  assert.ok(Date.now() - started < 5000, 'a timed out run returns promptly');

  // Cancel through the signal.
  const marker2 = path.join(dir, 'cancel.marker');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 400);
  const cancelled = await cli.spawnCli({
    bin: STUB,
    args: ['exec', '-'],
    stdin: 'x',
    signal: controller.signal,
    env: Object.assign({}, process.env, { CODEX_STUB_MODE: 'hang', CODEX_STUB_MARKER: marker2 }),
  });
  assert.strictEqual(cancelled.cancelled, true);
  assert.strictEqual(cancelled.timedOut, false);

  // The grandchildren would have written their markers 1.5 s after starting.
  await sleep(2200);
  assert.ok(!fs.existsSync(marker), 'timeout must stop the whole process tree');
  assert.ok(!fs.existsSync(marker2), 'cancel must stop the whole process tree');
  assert.strictEqual(cli.killTree(null), false, 'killTree on nothing is a no-op');
}

async function testCompile() {
  const root = makeWorkspace();
  const spec = pageSpec(root);
  assert.strictEqual(spec.provider, 'codex-cli');
  assert.strictEqual(spec.handoff, undefined, 'codex-cli runs the tool itself: it is not a handoff');
  assert.strictEqual(spec.endpoint, null);
  assert.strictEqual(spec.model, 'codex-cli');
  assert.deepStrictEqual(spec.body.frame, { target: '2:3', render: '2:3', native: true });
  assert.deepStrictEqual(spec.body.images.map((i) => [i.position, i.role, i.asset_id]), [
    [1, 'style', 'LOOK_NOIR_INK_MASTER_V01'], [2, 'identity', 'CHAR_MARA_TURN_MASTER_V01'],
  ]);
  assert.deepStrictEqual(spec.meta.warnings, []);

  // A ratio the image tool does not render: nearest frame, and a crop warning.
  const frames = { '3:4': '2:3', '9:16': '2:3', '4:5': '2:3', '4:3': '3:2', '16:9': '3:2', '1:1': '1:1', '3:2': '3:2' };
  for (const [ratio, render] of Object.entries(frames)) {
    const fitted = pageSpec(root, { parameters: { aspect_ratio: ratio, seed: null } });
    assert.strictEqual(fitted.body.frame.render, render, `${ratio} renders in ${render}`);
    assert.strictEqual(fitted.body.frame.native, ratio === render);
    assert.strictEqual(fitted.meta.warnings.some((w) => /needs a crop/.test(w)), ratio !== render);
  }
  // A pinned seed is said to be ignored instead of being recorded as honoured.
  const seeded = pageSpec(root, { parameters: { aspect_ratio: '2:3', seed: 7 } });
  assert.ok(seeded.meta.warnings.some((w) => /takes no seed/.test(w)));
  const seededRecord = await provider.generate(seeded);
  assert.strictEqual(seededRecord.seed, null);
  assert.deepStrictEqual(seededRecord.metadata_unavailable, ['model', 'cost', 'seed']);
}

async function testProvider() {
  const root = makeWorkspace();
  const outDir = path.join(ws.pageDir(root, 'PG_001_001'), 'renders');
  const before = fs.readdirSync(outDir).sort();

  // Dry run: nothing is resolved or started, even with a broken CODEX_BIN.
  await withEnv({ CODEX_BIN: path.join(root, 'no-such-codex') }, async () => {
    const record = await provider.generate(pageSpec(root), { outDir, root });
    assert.strictEqual(record.status, 'dry_run');
    assert.strictEqual(record.model, 'unreported');
    assert.ok(/codex exec \(generate, 2 input image/.test(record.request.summary), record.request.summary);
    assert.ok(validateDoc('generation-record', record).valid);

    // Live with that broken path: a failed record, not a throw.
    const live = await provider.generate(pageSpec(root), { dryRun: false, outDir, root });
    assert.strictEqual(live.status, 'failed');
    assert.ok(/^codex binary not found: CODEX_BIN points at/.test(live.response.error), live.response.error);
    assert.ok(/set CODEX_BIN/.test(live.response.error));
    assert.ok(validateDoc('generation-record', live).valid);
  });

  // Success: the image rides on _media, nothing temporary is left behind.
  const log = path.join(tempDir('eac-codex-log-'), 'log.json');
  await withEnv({ CODEX_STUB_LOG: log }, async () => {
    const progress = [];
    const record = await provider.generate(pageSpec(root), { dryRun: false, outDir, root, onProgress: (l) => progress.push(l) });
    assert.strictEqual(record.status, 'succeeded', record.response.error);
    assert.strictEqual(record._media.length, 1);
    assert.strictEqual(record._media[0].format, 'png');
    const info = imageInfo(Buffer.from(record._media[0].data_base64, 'base64'));
    assert.deepStrictEqual([info.width, info.height], [20, 30]);
    assert.ok(/^Codex saved one 20x30 PNG in \d+ s; 2 of 2 reference image\(s\) passed to the image tool as referenced_image_paths, as Codex reports\.$/
      .test(record.response.summary), record.response.summary);
    assert.strictEqual(record.response.provider_job_id, 'stub-thread-0001');
    assert.strictEqual(record.model, 'unreported', 'the stub named no image model');
    assert.deepStrictEqual(record.cost, { currency: 'USD', amount: null, estimated: false, reported: false });
    assert.strictEqual(record.seed, null);
    assert.deepStrictEqual(record.metadata_unavailable, ['model', 'cost', 'seed']);
    assert.strictEqual(record.notes, undefined, 'a clean run needs no notes');
    assert.deepStrictEqual(fs.readdirSync(outDir).sort(), before, 'the temporary PNG and message file are deleted');
    assert.ok(progress.length >= 3 && progress[0].startsWith('codex: drawing GEN_PG_001_001_05'), progress.join(' | '));
    assert.ok(progress.some((l) => /^codex thread\.started/.test(l)));

    // What Codex was started with: fixed flags, the images in order, the prompt on stdin only.
    const seen = JSON.parse(fs.readFileSync(log, 'utf8'));
    const ref = (rel) => path.join(root, ...rel.split('/'));
    assert.deepStrictEqual(seen.argv.slice(0, 8),
      ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'workspace-write', '-C', outDir, '--json']);
    assert.strictEqual(seen.argv[8], '-o');
    assert.ok(path.dirname(seen.argv[9]) === outDir && path.basename(seen.argv[9]).startsWith('.codex-GEN_PG_001_001_05-'));
    assert.deepStrictEqual(seen.argv.slice(10), [
      '-i', ref('references/style/LOOK_NOIR_INK_MASTER_V01.png'),
      '-i', ref('characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png'),
      '-',
    ]);
    assert.ok(!seen.argv.join(' ').includes('ink noir'), 'no prompt text on the command line');
    assert.ok(seen.stdin.includes('High-contrast ink noir comic art.'), 'the prompt arrives on stdin');
    assert.ok(seen.stdin.includes('Image 1: style (LOOK_NOIR_INK_MASTER_V01)'));
    assert.ok(seen.stdin.includes('Image 2: identity (CHAR_MARA_TURN_MASTER_V01)'));
    assert.ok(/Do not write code/.test(seen.stdin));
    assert.ok(/Aspect ratio 2:3 \(portrait\)/.test(seen.stdin));
    assert.ok(seen.stdin.includes('Avoid: watermark, signature'));
    assert.ok(/reply with one JSON object/.test(seen.stdin) && /"reference_mode"/.test(seen.stdin) && /"references_count"/.test(seen.stdin));
    // The images also go to the image tool as file paths: absolute, in attachment order.
    const lookFile = ref('references/style/LOOK_NOIR_INK_MASTER_V01.png');
    const maraFile = ref('characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png');
    assert.ok(seen.stdin.includes(`  file: ${lookFile}`) && seen.stdin.includes(`  file: ${maraFile}`));
    assert.ok(seen.stdin.indexOf(lookFile) < seen.stdin.indexOf(maraFile));
    assert.ok(/referenced_image_paths set to exactly these 2 file paths, in this order/.test(seen.stdin));
    assert.ok(/Do not use num_last_images_to_include/.test(seen.stdin));
    const target = seen.stdin.split('\n')[seen.stdin.split('\n').findIndex((l) => /^Save exactly one PNG/.test(l)) + 1];
    assert.ok(path.isAbsolute(target) && path.dirname(target) === outDir && target.endsWith('.png'), target);
  });

  // The session model goes on the command line; a model Codex names fills the record.
  await withEnv({ CODEX_STUB_LOG: log, CODEX_IMAGE_MODEL: 'gpt-test', CODEX_STUB_MODEL: 'gpt-image-9' }, async () => {
    const record = await provider.generate(pageSpec(root), { dryRun: false, outDir, root });
    assert.strictEqual(record.status, 'succeeded');
    assert.strictEqual(record.model, 'gpt-image-9');
    assert.deepStrictEqual(record.metadata_unavailable, ['cost', 'seed']);
    assert.ok(/Codex session model: gpt-test/.test(record.notes));
    const seen = JSON.parse(fs.readFileSync(log, 'utf8'));
    const at = seen.argv.indexOf('-m');
    assert.ok(at > 0 && seen.argv[at + 1] === 'gpt-test' && at < seen.argv.indexOf('-i'));
  });

  // Repair: Image 1 is the page to edit. A frame the tool lacks: a crop note.
  await withEnv({ CODEX_STUB_LOG: log, CODEX_STUB_REF_MODE: 'num_last_images_to_include' }, async () => {
    const repair = pageSpec(root, {
      mode: 'repair',
      parameters: { aspect_ratio: '3:4', seed: null },
      edit_target: 'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png',
      repair: { of_render: 'PG_001_001_V01', findings: ['F01'], changes: ['Panel 3: fix the face.'], locked: ['All lettering.'] },
    });
    const record = await provider.generate(repair, { dryRun: false, outDir, root });
    assert.strictEqual(record.status, 'succeeded');
    assert.ok(/3 of 3 reference image\(s\) passed to the image tool as num_last_images_to_include/.test(record.response.summary),
      record.response.summary);
    assert.ok(/not as referenced_image_paths: that way takes at most 5 images/.test(record.notes), record.notes);
    assert.ok(/Rendered as 2:3 because 3:4 is not a frame of the image tool: crop the file to 3:4/.test(record.notes), record.notes);
    const seen = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.ok(seen.stdin.includes('Image 1: edit target (PG_001_001_V01)'));
    assert.ok(seen.stdin.includes('Image 1 is the page to edit.'));
    assert.ok(/render the 2:3 frame/.test(seen.stdin) && /cropped to 3:4 afterwards/.test(seen.stdin));
    assert.strictEqual(seen.argv.filter((a) => a === '-i').length, 3);
  });

  // The image tool out of its usage quota (a real run's wording): not a failed drawing but tool_quota, with the reset time.
  await withEnv({ CODEX_STUB_MODE: 'quota' }, async () => {
    const record = await provider.generate(pageSpec(root), { dryRun: false, outDir, root });
    assert.strictEqual(record.status, 'failed');
    assert.strictEqual(record.response.error_kind, 'tool_quota');
    assert.strictEqual(record.response.resets, '6:40 PM');
    assert.ok(/^Codex ran out of its usage quota and saved no image: Image generation failed because the usage limit was reached./.test(record.response.error), record.response.error);
    assert.ok(validateDoc('generation-record', record).valid, 'a quota record is a valid generation record');
    assert.deepStrictEqual(leftovers(outDir), []);
  });
  // The CLI itself out of quota: its own wording, exit 1.
  await withEnv({ CODEX_STUB_MODE: 'quota-cli' }, async () => {
    const record = await provider.generate(pageSpec(root), { dryRun: false, outDir, root });
    assert.strictEqual(record.response.error_kind, 'tool_quota');
    assert.strictEqual(record.response.resets, 'Nov 30th, 2026 3:15 PM');
  });
  // A plain failure is not a quota.
  await withEnv({ CODEX_STUB_MODE: 'nofile' }, async () => {
    const record = await provider.generate(pageSpec(root), { dryRun: false, outDir, root });
    assert.strictEqual(record.response.error_kind, undefined);
  });

  // Fewer references reached the image tool than were sent: a failed run, the image discarded.
  await withEnv({ CODEX_STUB_COUNT: '1' }, async () => {
    const record = await provider.generate(pageSpec(root), { dryRun: false, outDir, root });
    assert.strictEqual(record.status, 'failed');
    assert.ok(/^Codex passed 1 of the 2 reference images to its image tool \(as referenced_image_paths\), so the image was drawn without 1 of them and was discarded\./
      .test(record.response.error), record.response.error);
    assert.strictEqual(record._media, undefined);
    assert.ok(validateDoc('generation-record', record).valid);
    assert.deepStrictEqual(leftovers(outDir), []);
  });
  // None reached it: failed too.
  await withEnv({ CODEX_STUB_REF_MODE: 'none', CODEX_STUB_COUNT: '2' }, async () => {
    const record = await provider.generate(pageSpec(root), { dryRun: false, outDir, root });
    assert.strictEqual(record.status, 'failed');
    assert.ok(/received none of the 2 reference images/.test(record.response.error), record.response.error);
  });
  // A reply that does not say: the image is kept, and the record says the count is unknown.
  await withEnv({ CODEX_STUB_REF_MODE: 'omit' }, async () => {
    const record = await provider.generate(pageSpec(root), { dryRun: false, outDir, root });
    assert.strictEqual(record.status, 'succeeded');
    assert.ok(/2 reference image\(s\) sent, how many reached the image tool not reported/.test(record.response.summary));
    assert.ok(/did not report how many reference images reached its image tool/.test(record.notes), record.notes);
  });

  // The image exists but the exit code is not zero: the image counts, the code is noted.
  await withEnv({ CODEX_STUB_MODE: 'exit-after' }, async () => {
    const record = await provider.generate(pageSpec(root), { dryRun: false, outDir, root });
    assert.strictEqual(record.status, 'succeeded');
    assert.ok(/exited with code 2 after saving the image/.test(record.notes));
  });

  // A size that is not the requested ratio is said.
  await withEnv({ CODEX_STUB_SIZE: '30x30' }, async () => {
    const record = await provider.generate(pageSpec(root), { dryRun: false, outDir, root });
    assert.ok(/The image is 30x30, which is not 2:3/.test(record.notes), record.notes);
  });

  // Failure modes: each a failed record with a plain message.
  const failures = [
    ['fail', /^codex exec exited with code 3 and saved no image\. Last stderr line: stream error/],
    ['nofile', /^codex exec finished without saving the image at the requested path\. Codex said: I could not generate the image\.$/],
    ['notimage', /^the file Codex saved is not an image \(unrecognised image format/],
  ];
  for (const [mode, pattern] of failures) {
    await withEnv({ CODEX_STUB_MODE: mode }, async () => {
      const record = await provider.generate(pageSpec(root), { dryRun: false, outDir, root });
      assert.strictEqual(record.status, 'failed', mode);
      assert.ok(pattern.test(record.response.error), `${mode}: ${record.response.error}`);
      assert.strictEqual(record._media, undefined);
      assert.deepStrictEqual(record.media_files, []);
      assert.ok(validateDoc('generation-record', record).valid, mode);
      assert.deepStrictEqual(leftovers(outDir), [], `${mode}: no temporary file left`);
    });
  }

  // Timeout, from CODEX_IMAGE_TIMEOUT_MS.
  await withEnv({ CODEX_STUB_MODE: 'hang', CODEX_IMAGE_TIMEOUT_MS: '500' }, async () => {
    const record = await provider.generate(pageSpec(root), { dryRun: false, outDir, root });
    assert.strictEqual(record.status, 'failed');
    assert.ok(/^codex exec timed out after 1 s and its process tree was stopped/.test(record.response.error), record.response.error);
    assert.deepStrictEqual(leftovers(outDir), []);
  });

  // Cancel, through the signal.
  await withEnv({ CODEX_STUB_MODE: 'hang' }, async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);
    const record = await provider.generate(pageSpec(root), { dryRun: false, outDir, root, signal: controller.signal });
    assert.strictEqual(record.status, 'failed');
    assert.strictEqual(record.response.error, 'cancelled');

    const already = new AbortController();
    already.abort();
    const skipped = await provider.generate(pageSpec(root), { dryRun: false, outDir, root, signal: already.signal });
    assert.strictEqual(skipped.response.error, 'cancelled');
  });

  // A reference that is gone is a failed record too.
  await withEnv({}, async () => {
    const spec = pageSpec(root, {
      references: [{ asset_id: 'CHAR_GONE_TURN_MASTER_V01', role: 'identity', image_path: 'characters/CHAR_GONE/refs/x.png' }],
    });
    const record = await provider.generate(spec, { dryRun: false, outDir, root });
    assert.strictEqual(record.status, 'failed');
    assert.ok(/reference image not found: characters\/CHAR_GONE\/refs\/x\.png/.test(record.response.error));
  });
  assert.deepStrictEqual(fs.readdirSync(outDir).sort(), before, 'the provider itself never adds a file to renders/');
}

async function testGenerateAssets() {
  const root = makeWorkspace();
  const pageId = 'PG_001_001';
  const pageDir = ws.pageDir(root, pageId);
  const pageFile = path.join(pageDir, 'page.yaml');
  const rendersDir = path.join(pageDir, 'renders');
  const genDir = path.join(root, 'generations', pageId);

  // Compile the page for codex-cli with the existing compiler, as compile-prompts.js --provider does.
  const { pkg, fileName } = compilePage(root, ws.loadPage(root, pageId), { providerId: 'codex-cli' });
  assert.strictEqual(pkg.id, `PP_${pageId}_${common.providerTag('codex-cli')}`);
  assert.strictEqual(pkg.model, 'codex-cli');
  assert.ok(validateDoc('prompt-package', pkg).valid);
  fs.writeFileSync(path.join(pageDir, 'prompts', fileName), yaml.stringify(pkg));

  await withEnv({}, async () => {
    // Dry run first: a record and a request file, nothing drawn.
    const dry = await gen.generateAssets({ page: pageFile, provider: 'codex-cli', log: quiet });
    assert.strictEqual(dry.results[0].record.status, 'dry_run');
    assert.strictEqual(dry.unestimated, 1, 'a Codex run has no price estimate');
    assert.deepStrictEqual(ws.listRenders(root, pageId), ['PG_001_001_V01']);

    // Live needs the confirmation, as for every provider.
    await assert.rejects(() => gen.generateAssets({ page: pageFile, provider: 'codex-cli', live: true, log: quiet }),
      (err) => err.code === 'confirmation_required');

    const progress = [];
    const live = await gen.generateAssets({
      page: pageFile, provider: 'codex-cli', live: true, yes: true, log: quiet, onProgress: (l) => progress.push(l),
    });
    assert.deepStrictEqual(live.failures, []);
    assert.strictEqual(live.live, true);
    assert.strictEqual(live.results.length, 1);
    const result = live.results[0];
    const record = result.record;
    assert.strictEqual(record.status, 'succeeded');
    assert.strictEqual(record.id, 'GEN_PG_001_001_03', 'the example has one record, the dry run took 02');
    assert.strictEqual(record.provider, 'codex-cli');
    assert.strictEqual(record.model, 'unreported');
    assert.strictEqual(record.output_render, 'PG_001_001_V02');
    assert.deepStrictEqual(record.media_files, ['issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V02.png']);
    assert.strictEqual(record._media, undefined, 'image bytes never reach the record on disk');
    assert.ok(validateDoc('generation-record', record).valid);
    assert.ok(progress.some((l) => /^codex: drawing GEN_PG_001_001_03/.test(l)), 'onProgress is handed through');

    const saved = path.join(root, ...record.media_files[0].split('/'));
    assert.strictEqual(imageInfo(saved).format, 'png');
    assert.deepStrictEqual(fs.readdirSync(rendersDir).sort(), ['PG_001_001_V01.png', 'PG_001_001_V02.png']);
    const onDisk = yaml.parse(fs.readFileSync(result.recordFile, 'utf8'));
    assert.strictEqual(onDisk.status, 'succeeded');
    assert.deepStrictEqual(onDisk.media_files, record.media_files);
    const request = JSON.parse(fs.readFileSync(result.requestFile, 'utf8'));
    assert.strictEqual(request.provider, 'codex-cli');
    assert.strictEqual(request.meta.output_path, 'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V02.png');
    assert.strictEqual(request.body.prompt, pkg.prompt);

    // The workspace still passes the mechanical gates with the new candidate in it.
    const check = await validateWorkspace(root, {});
    assert.deepStrictEqual((check.errors || []).map((e) => `${e.file}: ${e.code}`), []);
  });

  // A failing tool gives a failed record on disk and a failure line, and the batch call still returns.
  await withEnv({ CODEX_STUB_MODE: 'fail' }, async () => {
    const out = await gen.generateAssets({ page: pageFile, provider: 'codex-cli', live: true, yes: true, log: quiet });
    assert.strictEqual(out.results[0].record.status, 'failed');
    assert.ok(/^GEN_PG_001_001_04: codex exec exited with code 3/.test(out.failures[0]), out.failures[0]);
    assert.ok(fs.existsSync(path.join(genDir, 'GEN_PG_001_001_04.yaml')));
    assert.deepStrictEqual(ws.listRenders(root, pageId), ['PG_001_001_V01', 'PG_001_001_V02']);
  });

  // Cancel through generateAssets: the running package fails with "cancelled".
  await withEnv({ CODEX_STUB_MODE: 'hang' }, async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);
    const out = await gen.generateAssets({
      page: pageFile, provider: 'codex-cli', live: true, yes: true, log: quiet, signal: controller.signal,
    });
    assert.strictEqual(out.results[0].record.response.error, 'cancelled');
    assert.deepStrictEqual(out.failures, ['GEN_PG_001_001_05: cancelled']);

    // A package that has not started when the signal is already aborted is skipped: no record.
    const again = await gen.generateAssets({
      page: pageFile, provider: 'codex-cli', live: true, yes: true, log: quiet, signal: controller.signal,
    });
    assert.strictEqual(again.results.length, 0);
    assert.strictEqual(again.failures.length, 1);
    assert.ok(/: cancelled$/.test(again.failures[0]));
    assert.ok(!fs.existsSync(path.join(genDir, 'GEN_PG_001_001_06.yaml')));
  });
  assert.deepStrictEqual(leftovers(rendersDir), []);
}

async function main() {
  try {
    await testResolveAndSpawn();
    await testWindowsShims();
    await testTreeKill();
    await testCompile();
    await testProvider();
    await testGenerateAssets();
  } finally {
    for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('codex-cli: OK');
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
