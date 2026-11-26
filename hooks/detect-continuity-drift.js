#!/usr/bin/env node
'use strict';
/**
 * Hook: detect-continuity-drift (event: after a page.yaml write).
 * When issues/<ISS_ID>/pages/<PG_ID>/page.yaml changes, run the panel ledger
 * audit (scripts/check-continuity.js) for that page's issue and print the
 * findings that touch the page: position jumps, custody changes without a
 * transfer, dropped state tags, wardrobe changes, broken page chain.
 * Advisory: it WARNS on stderr and always exits 0. The blocking gate is
 * "npm run validate:workspace".
 */

const path = require('path');
const {
  readStdinJson, eventFilePath, findWorkspaceRoot, workspaceRelPath, displayPath,
  SCAFFOLD_ROOT, run,
} = require('./lib');

const PAGE_FILE = /^issues\/([^/]+)\/pages\/([^/]+)\/page\.ya?ml$/i;
const MAX_FINDINGS = 12;

/** Findings of the issue's ledger audit that touch one page. Pure apart from reading the workspace. */
function findingsForPage(root, issueId, pageId) {
  const { checkContinuity } = require(path.join(SCAFFOLD_ROOT, 'scripts', 'check-continuity.js'));
  const { findings } = checkContinuity(root, { issue: issueId });
  return findings.filter((f) => f.page === pageId || String(f.message || '').includes(pageId));
}

async function handle(event) {
  const file = eventFilePath(event || {});
  if (!file) return 0;
  const rel = workspaceRelPath(file);
  if (!rel) return 0;
  const m = PAGE_FILE.exec(rel);
  if (!m) return 0;
  const [, issueId, pageId] = m;
  const root = findWorkspaceRoot(file);

  let findings;
  try {
    findings = findingsForPage(root, issueId, pageId);
  } catch (err) {
    return 0; // tooling not installed alongside hooks, or an unreadable workspace
  }
  if (!findings.length) return 0;

  const errors = findings.filter((f) => f.severity === 'error').length;
  const lines = findings.slice(0, MAX_FINDINGS).map((f) =>
    `  ${f.severity === 'error' ? 'x' : '!'} ${f.panel || f.page || issueId} [${f.code}] ${f.message}`);
  process.stderr.write(
    `detect-continuity-drift: the panel ledger disagrees with ${displayPath(file)} ` +
    `(${errors} error(s), ${findings.length - errors} warning(s)):\n` +
    lines.join('\n') +
    (findings.length > MAX_FINDINGS ? `\n  ... and ${findings.length - MAX_FINDINGS} more` : '') +
    `\n  Full audit with fix hints: npm run check:continuity -- --root ${path.basename(root)} --issue ${issueId}\n`
  );
  return 0; // advisory only: never block
}

module.exports = { handle, findingsForPage };

if (require.main === module) {
  run('detect-continuity-drift', async () => handle(await readStdinJson()));
}
