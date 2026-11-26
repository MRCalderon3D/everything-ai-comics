'use strict';
/**
 * Studio drivers: the command lines built for Claude Code and Codex
 * (asserted as argument arrays, nothing is spawned), the parsing of their
 * event streams from recorded sample lines, driver selection with fallback,
 * and prompt building. No CLI runs here.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claude = require('../studio/server/drivers/claude');
const codex = require('../studio/server/drivers/codex');
const { createDrivers } = require('../studio/server/drivers');
const prompts = require('../studio/server/prompts');
const { mergeSettings } = require('../studio/server/registry');

const SCAFFOLD = path.resolve(__dirname, '..');
const PROJECT = path.join(os.tmpdir(), 'studio home', 'my-comic');
const WORKSPACE = path.join(PROJECT, 'production');

/** A stand-in for cli-spawn: records the call and replays stdout lines. */
function fakeSpawn(lines, result = {}) {
  const calls = [];
  return {
    calls,
    resolveBinary: (name) => ({ found: true, name, path: `/fake/${name}`, command: `/fake/${name}`, prefixArgs: [], via: 'direct', error: null }),
    spawnCli: async (options) => {
      calls.push(options);
      for (const line of lines) options.onStdout(line);
      if (typeof result.before === 'function') result.before(options);
      return Object.assign({ code: 0, signal: null, timedOut: false, cancelled: false, stdout: '', stderr: 'unrelated noise: MCP server not running' }, result.proc || {});
    },
  };
}

async function main() {
  const schema = prompts.contractSchema();

  // --- Claude Code: argument array ---------------------------------------------
  let args = claude.buildArgs({ addDirs: [PROJECT], schema, model: 'sonnet', allowWrite: true });
  assert.deepStrictEqual(args, [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--json-schema', JSON.stringify(schema),
    '--setting-sources', 'project', '--strict-mcp-config',
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read,Write,Edit,Glob,Grep,Bash(node scripts/*)',
    '--add-dir', PROJECT,
    '--model', 'sonnet',
  ]);
  args = claude.buildArgs({ addDirs: [PROJECT], schema, allowWrite: false, sessionId: 'abc-123' });
  assert.deepStrictEqual(args, [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--json-schema', JSON.stringify(schema),
    '--setting-sources', 'project', '--strict-mcp-config',
    '--permission-mode', 'dontAsk',
    '--allowedTools', 'Read,Glob,Grep',
    '--add-dir', PROJECT,
    '--resume', 'abc-123',
  ]);
  assert.ok(!claude.buildArgs({ allowWrite: true }).includes('--model'), 'no model flag without a model');

  const env = claude.buildEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', HOME: '/h' });
  assert.deepStrictEqual(env, { PATH: '/bin', HOME: '/h' }, 'the nested-session variables are removed');

  // --- Claude Code: stream parsing from recorded sample lines ---------------------
  const claudeLines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-0001', tools: ['Read', 'Write'] }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I will read the command file first.' }] }, session_id: 'sess-0001' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: path.join(SCAFFOLD, 'docs', 'data-model.md') } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '...' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: path.join(WORKSPACE, 'story', 'story-bible.yaml'), content: 'x' } }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: `node scripts/validate-workspace.js --root "${WORKSPACE}" --json` } }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't4', name: 'Edit', input: { file_path: path.join(WORKSPACE, 'project.yaml') } }] } }),
    'this line is not JSON and is ignored',
    JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, session_id: 'sess-0001', num_turns: 6,
      result: 'Done.', total_cost_usd: 0.1234, duration_ms: 110000, permission_denials: [],
      structured_output: { status: 'done', summary: 'Wrote the story bible.', files_written: ['story/story-bible.yaml'] },
    }),
  ];
  const seen = [];
  const parser = claude.createParser({ cwd: SCAFFOLD, workspace: WORKSPACE, addDirs: [PROJECT], onEvent: (e) => seen.push(e.text) });
  for (const line of claudeLines) parser.push(line);
  assert.deepStrictEqual(seen, [
    'I will read the command file first.',
    'reading docs/data-model.md',
    'writing story/story-bible.yaml',
    `running node scripts/validate-workspace.js --root "${WORKSPACE}" --json`.slice(0, 128),
    'editing project.yaml',
  ]);
  let result = parser.result();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.sessionId, 'sess-0001');
  assert.strictEqual(result.costUsd, 0.1234);
  assert.strictEqual(result.durationMs, 110000);
  assert.deepStrictEqual(result.structured.files_written, ['story/story-bible.yaml']);

  const failing = claude.createParser({});
  failing.push(JSON.stringify({
    type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's2', result: 'Ran out of turns.',
    permission_denials: [{ tool_name: 'Bash' }],
  }));
  result = failing.result();
  assert.strictEqual(result.ok, false);
  assert.ok(/Ran out of turns/.test(result.error) && /Denied: Bash/.test(result.error));
  assert.strictEqual(claude.createParser({}).result().ok, false, 'no result event is a failure');
  // A result whose structured output is missing falls back to JSON in the text.
  const textOnly = claude.createParser({});
  textOnly.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Here it is: {"status":"done","summary":"s","files_written":[]}' }));
  assert.strictEqual(textOnly.result().structured.status, 'done');

  // --- Claude Code: run() with a stand-in spawn ---------------------------------------
  let spawn = fakeSpawn(claudeLines);
  result = await claude.run({
    cwd: SCAFFOLD, addDirs: [PROJECT], prompt: 'PROMPT TEXT with "quotes" & $pecial', schema, model: 'sonnet',
    allowWrite: true, workspace: WORKSPACE,
  }, spawn);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(spawn.calls.length, 1);
  const call = spawn.calls[0];
  assert.strictEqual(call.cwd, SCAFFOLD, 'the scaffold root is the working directory');
  assert.strictEqual(call.stdin, 'PROMPT TEXT with "quotes" & $pecial', 'the prompt goes in on stdin');
  assert.ok(!call.args.some((a) => a.includes('PROMPT TEXT')), 'no prompt text on the command line');
  assert.ok(!('CLAUDECODE' in call.env) && !('CLAUDE_CODE_ENTRYPOINT' in call.env));
  assert.ok(call.timeoutMs > 0);
  // stderr noise with exit code 0 is not a failure; a non-zero exit code is.
  spawn = fakeSpawn(claudeLines, { proc: { code: 1 } });
  result = await claude.run({ cwd: SCAFFOLD, prompt: 'x', schema }, spawn);
  assert.strictEqual(result.ok, false);
  assert.ok(/exited with code 1/.test(result.error));
  spawn = fakeSpawn([], { proc: { cancelled: true, code: null } });
  result = await claude.run({ cwd: SCAFFOLD, prompt: 'x', schema }, spawn);
  assert.strictEqual(result.cancelled, true);
  const missing = { resolveBinary: () => ({ found: false, error: '"claude" was not found on PATH' }), spawnCli: async () => { throw new Error('must not spawn'); } };
  result = await claude.run({ cwd: SCAFFOLD, prompt: 'x' }, missing);
  assert.strictEqual(result.ok, false);
  assert.ok(/not found/.test(result.error));

  // --- Codex: argument arrays ------------------------------------------------------------
  args = codex.buildArgs({
    cwd: SCAFFOLD, addDirs: [PROJECT], schemaFile: '/tmp/schema.json', outFile: '/tmp/last.txt',
    images: ['/a/render.png', '/a/ref.png'], allowWrite: true,
  });
  assert.deepStrictEqual(args, [
    'exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', SCAFFOLD, '--add-dir', PROJECT,
    '--json', '--output-schema', '/tmp/schema.json', '-o', '/tmp/last.txt',
    '-i', '/a/render.png', '-i', '/a/ref.png', '-',
  ]);
  assert.strictEqual(args[args.length - 1], '-', 'the prompt is read from stdin: -i takes several values');
  args = codex.buildArgs({ cwd: SCAFFOLD, addDirs: [PROJECT], schemaFile: '/tmp/s.json', outFile: '/tmp/o.txt', allowWrite: false, model: 'gpt-x' });
  assert.deepStrictEqual(args, [
    'exec', '--skip-git-repo-check', '-s', 'read-only', '-C', SCAFFOLD, '--add-dir', PROJECT,
    '--json', '--output-schema', '/tmp/s.json', '-o', '/tmp/o.txt', '-m', 'gpt-x', '-',
  ]);
  args = codex.buildArgs({
    cwd: SCAFFOLD, addDirs: [PROJECT], schemaFile: '/tmp/s.json', outFile: '/tmp/o.txt', allowWrite: true, sessionId: 'thread-9',
  });
  assert.deepStrictEqual(args, [
    'exec', 'resume', '--skip-git-repo-check', '-c', 'sandbox_mode=workspace-write',
    '-c', `sandbox_workspace_write.writable_roots=['${PROJECT.split(path.sep).join('/')}']`,
    '--json', '--output-schema', '/tmp/s.json', '-o', '/tmp/o.txt', 'thread-9', '-',
  ]);
  assert.ok(!args.includes('-C') && !args.includes('-s') && !args.includes('--add-dir'), 'resume takes none of -s, -C, --add-dir');
  assert.strictEqual(codex.tomlPath("C:\\it's\\here"), JSON.stringify("C:/it's/here"));

  // --- Codex: stream parsing from recorded sample lines -------------------------------------
  const codexLines = [
    JSON.stringify({ type: 'thread.started', thread_id: '0199-thread' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'Thinking about the files.' } }),
    JSON.stringify({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc "cat commands/story-bible.md"', status: 'in_progress' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc "cat commands/story-bible.md"', exit_code: 0, status: 'completed' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: path.join(WORKSPACE, 'story', 'story-bible.yaml'), kind: 'add' }, { path: path.join(WORKSPACE, 'project.yaml'), kind: 'update' }], status: 'completed' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: '{"status":"done","summary":"ok","files_written":["story/story-bible.yaml"]}' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } }),
  ];
  const codexSeen = [];
  const cparser = codex.createParser({ cwd: SCAFFOLD, workspace: WORKSPACE, addDirs: [PROJECT], onEvent: (e) => codexSeen.push(e.text) });
  for (const line of codexLines) cparser.push(line);
  assert.deepStrictEqual(codexSeen.slice(0, 3), [
    'running bash -lc "cat commands/story-bible.md"',
    'writing story/story-bible.yaml',
    'editing project.yaml',
  ]);
  assert.strictEqual(cparser.state().sessionId, '0199-thread', 'the session id comes from the JSON events');
  assert.ok(cparser.state().lastMessage.includes('"status":"done"'));
  const cfail = codex.createParser({});
  cfail.push(JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit reached' } }));
  assert.strictEqual(cfail.state().error, 'usage limit reached');

  // --- Codex: run() with a stand-in spawn --------------------------------------------------------
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-codex-'));
  spawn = fakeSpawn(codexLines, {
    before: (options) => {
      const out = options.args[options.args.indexOf('-o') + 1];
      fs.writeFileSync(out, '{"status":"done","summary":"from the -o file","files_written":[]}');
      const schemaFile = options.args[options.args.indexOf('--output-schema') + 1];
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(schemaFile, 'utf8')), schema, 'the schema is passed as a file');
    },
  });
  result = await codex.run({
    cwd: SCAFFOLD, addDirs: [PROJECT], prompt: 'THE PROMPT', schema, images: ['/a/render.png'], allowWrite: false, tmpDir,
  }, spawn);
  assert.strictEqual(result.ok, true, result.error);
  assert.strictEqual(result.structured.summary, 'from the -o file', 'the final message is read from the -o file');
  assert.strictEqual(result.sessionId, '0199-thread');
  assert.strictEqual(spawn.calls[0].stdin, 'THE PROMPT');
  assert.ok(!spawn.calls[0].args.includes('THE PROMPT'));
  assert.strictEqual(spawn.calls[0].cwd, SCAFFOLD);
  assert.deepStrictEqual(fs.readdirSync(tmpDir), [], 'the temporary schema and message files are removed');
  // stderr noise alone is not a failure; the exit code is.
  spawn = fakeSpawn(codexLines, { proc: { code: 2 } });
  result = await codex.run({ cwd: SCAFFOLD, prompt: 'x', schema, tmpDir }, spawn);
  assert.strictEqual(result.ok, false);
  assert.ok(/exited with code 2/.test(result.error));
  assert.ok(!/MCP server/.test(result.error), 'stderr text is not reported as the reason');
  spawn = fakeSpawn([JSON.stringify({ type: 'thread.started', thread_id: 't' })]);
  result = await codex.run({ cwd: SCAFFOLD, prompt: 'x', schema, tmpDir }, spawn);
  assert.strictEqual(result.ok, false, 'no final message is a failure');
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // --- which tool does which job ---------------------------------------------------------------------
  const settings = mergeSettings({});
  assert.deepStrictEqual(settings.drivers, { plan: 'claude', look: 'claude', draw: 'codex' });
  let drivers = createDrivers({ fake: true });
  let pick = drivers.pick('plan', settings);
  assert.deepStrictEqual([pick.available, pick.name, pick.fallback], [true, 'claude', false]);
  assert.strictEqual(drivers.pick('look', settings).model, 'sonnet', 'reviews default to a fast model on Claude');
  assert.strictEqual(drivers.pick('draw', settings).name, 'codex');
  drivers = createDrivers({ fake: true, fakeTools: ['codex'] });
  pick = drivers.pick('plan', settings);
  assert.deepStrictEqual([pick.available, pick.name, pick.requested, pick.fallback], [true, 'codex', 'claude', true],
    'a verb falls back to the other installed tool');
  drivers = createDrivers({ fake: true, fakeTools: ['claude'] });
  pick = drivers.pick('draw', settings);
  assert.strictEqual(pick.available, false, 'only Codex draws');
  assert.ok(/Codex is not installed/.test(pick.reason));
  assert.strictEqual(drivers.pick('look', mergeSettings({ drivers: { look: 'codex' } })).name, 'claude');
  drivers = createDrivers({ fake: true, fakeTools: [] });
  assert.strictEqual(drivers.pick('plan', settings).available, false);
  assert.strictEqual(createDrivers({ fake: true }).pick('draw', mergeSettings({ drivers: { draw: 'manual' } })).available, false);
  const assignment = createDrivers({ fake: true, fakeTools: ['codex'] }).assignment(settings);
  assert.deepStrictEqual(Object.keys(assignment), ['plan', 'look', 'draw']);
  assert.strictEqual(assignment.look.tool, 'codex');

  // --- prompts -------------------------------------------------------------------------------------------
  const prompt = prompts.build('project.setup', {
    title: 'The Night Ferry', description: 'A ferry pilot finds a stowaway.', pages: 4, source_file: 'story/source/description.md',
  }, { workspace: WORKSPACE, language: 'es', comicFormat: 'paged', answers: { q1: { question: 'Which ending?', answer: 'The quiet one' } } });
  for (const needle of [
    'commands/project-init.md', 'commands/story-bible.md', 'commands/series-plan.md',
    `Workspace root: ${WORKSPACE}`, 'Project language: es', 'A ferry pilot finds a stowaway.',
    'HEADLESS CONTRACT', 'needs_decision', `node scripts/validate-workspace.js --root "${WORKSPACE}" --json`,
    'ANSWERS FROM THE PERSON', 'The quiet one',
  ]) {
    assert.ok(prompt.includes(needle), `the prompt lacks: ${needle}`);
  }
  assert.ok(!/\{\{[#/a-z_ ]+\}\}/.test(prompt), 'no template token is left in a prompt');
  assert.ok(prompt.length < 6000, 'prompts stay short: the commands carry the method');
  for (const kind of Object.keys(prompts.TEMPLATES)) {
    // The chat template takes its command files from the screen it is for.
    const vars = kind === 'chat' ? { commands: prompts.fileList(['commands/story-bible.md']) } : {};
    const text = prompts.build(kind, vars, { workspace: WORKSPACE });
    assert.ok(!/\{\{[#/a-z_ ]+\}\}/.test(text), `${kind}: a template token is left`);
    assert.ok(/commands\/[a-z-]+\.md/.test(text), `${kind}: the prompt names no command file`);
    assert.ok(text.includes('HEADLESS CONTRACT'), `${kind}: the contract is missing`);
    for (const m of text.match(/commands\/[a-z-]+\.md/g)) {
      assert.ok(fs.existsSync(path.join(SCAFFOLD, m)), `${kind} names ${m}, which does not exist`);
    }
  }
  assert.strictEqual(prompts.render('a{{#if x}}[{{x}}{{#if y}}-{{y}}{{/if}}]{{/if}}b', { x: '1' }), 'a[1]b');
  assert.strictEqual(prompts.render('a{{#if x}}[{{x}}]{{/if}}b', {}), 'ab');
  const contract = prompts.contractSchema();
  assert.deepStrictEqual(contract.required, ['status', 'summary', 'files_written']);
  assert.deepStrictEqual(contract.properties.status.enum, ['done', 'needs_decision', 'failed']);
  assert.deepStrictEqual(prompts.reviewDataSchema().properties.review.properties.checks.required.length, 14);

  console.log('studio-drivers: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
