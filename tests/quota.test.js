'use strict';
/**
 * providers/lib/quota.js: a usage-limit answer from a drawing or writing
 * tool is recognised as its own kind (tool_quota), with the reset time when
 * the tool gives one, and an ordinary failure is not.
 */

const assert = require('assert');
const { detectQuota, resetText } = require('../providers/lib/quota');
const common = require('../providers/lib/common');

const yes = [
  // Codex's image tool, in a real run.
  ['Image generation failed because the usage limit was reached.', null],
  ["The built-in tool's usage limit was reached.", null],
  // The Codex CLI.
  ["You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at 8:42 PM.", '8:42 PM'],
  ["Usage limit reached. You've reached your usage limit. Increase your limits to continue using codex.", null],
  // Claude Code, current and older wording.
  ['Usage limit reached · limit resets 5pm (Europe/Madrid)', '5pm (Europe/Madrid)'],
  ["You've hit your limit · resets 3pm", '3pm'],
  ['5-hour limit reached ∙ resets 2am', '2am'],
  ['Claude AI usage limit reached|1764264000', new Date(1764264000 * 1000).toISOString()],
  ['API Error: rate limited', null],
  ['Your credit balance is too low to access the API.', null],
  // HTTP image APIs.
  ['fal.ai responded HTTP 429 Too Many Requests', null],
  ['Quota exceeded for this project. Try again in 1 hour.', '1 hour'],
];
for (const [text, resets] of yes) {
  const found = detectQuota(text);
  assert.ok(found, `recognised: ${text}`);
  assert.strictEqual(found.kind, 'tool_quota');
  assert.strictEqual(found.resets, resets, `reset of: ${text}`);
}

const no = [
  'PG_001_002_V03: repair limit reached (repair_cycle 2, repair_policy.max_cycles 2).',
  'Context limit reached · /compact to continue',
  'codex exec exited with code 3 and saved no image. Last stderr line: stream error: unexpected status 500',
  'Codex passed 4 of the 5 reference images to its image tool',
  '',
];
for (const text of no) assert.strictEqual(detectQuota(text), null, `not a quota: ${text}`);

// Several texts: the first that says so wins; empty ones are skipped.
assert.strictEqual(detectQuota('', null, 'all fine', 'usage limit was reached, try again in 20 minutes').resets, '20 minutes');
assert.strictEqual(resetText('Try again later.'), null);

// markFailed records the kind and the reset on the generation record.
const spec = { provider: 'fal', model: 'm', endpoint: 'https://example.invalid', body: {}, meta: { page: 'PG_001_001' } };
const failed = common.markFailed(common.makeRecord(spec), new Error('HTTP 429 Too Many Requests: rate limit exceeded, retry after 60 seconds'));
assert.strictEqual(failed.response.error_kind, 'tool_quota');
const plain = common.markFailed(common.makeRecord(spec), new Error('HTTP 500 Internal Server Error'));
assert.strictEqual(plain.response.error_kind, undefined);
const told = common.markFailed(common.makeRecord(spec), Object.assign(new Error('out'), { kind: 'tool_quota', resets: 'tomorrow' }));
assert.deepStrictEqual([told.response.error_kind, told.response.resets], ['tool_quota', 'tomorrow']);
const cancelled = common.markFailed(common.makeRecord(spec), new Error('cancelled'));
assert.strictEqual(cancelled.response.error_kind, undefined);

console.log('quota: ok');
