#!/usr/bin/env node
'use strict';
/**
 * Hook: require-cost-confirmation (event: before a shell command runs).
 * Blocks `generate-assets ... --live` (and `npm run generate:assets --
 * ... --live`) unless the explicit `--yes` confirmation flag is present.
 * Cost-control policy: live page or reference generation always needs a
 * human-confirmed estimate. Exit 0 = allow; exit 2 = block.
 */

const { readStdinJson, eventCommand, run } = require('./lib');

async function handle(event) {
  const command = eventCommand(event || {});
  if (!command || typeof command !== 'string') return 0;
  const isGenerate = /generate-assets(\.js)?\b/.test(command) || /generate:assets/.test(command);
  if (!isGenerate) return 0;
  const live = /(^|\s)--live(\s|$|=)/.test(command);
  const confirmed = /(^|\s)--yes(\s|$|=)/.test(command);
  if (live && !confirmed) {
    process.stderr.write(
      'require-cost-confirmation: BLOCKED live generation without --yes.\n' +
      'Live runs spend provider credits on every page or reference image. Dry-run\n' +
      'first, show the request and the cost estimate to the person paying, then\n' +
      're-run with BOTH --live and --yes once they confirm.\n'
    );
    return 2;
  }
  return 0;
}

module.exports = { handle };

if (require.main === module) {
  run('require-cost-confirmation', async () => handle(await readStdinJson()));
}
