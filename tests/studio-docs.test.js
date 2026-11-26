'use strict';
/**
 * Studio documentation stays in step with the server: every route, every
 * operation with its parameters, and every event type is in
 * studio/docs/api.md, every example block is filled, and the prose follows
 * the repository's writing rules. Nothing is started here.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ops = require('../studio/server/ops');
const { createServer } = require('../studio/server');
const { createApi } = require('../studio/server/api');

const ROOT = path.resolve(__dirname, '..');
const api = fs.readFileSync(path.join(ROOT, 'studio', 'docs', 'api.md'), 'utf8').replace(/\r\n/g, '\n');
const readme = fs.readFileSync(path.join(ROOT, 'studio', 'README.md'), 'utf8').replace(/\r\n/g, '\n');

/** The prose of a Markdown text: code fences, example blocks and inline code removed. */
function proseOf(markdown) {
  return markdown
    .replace(/<!-- example:[\s\S]*?<!-- \/example:[a-z0-9.-]+ -->/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '');
}

function main() {
  // --- every route is documented ------------------------------------------------
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'comics-studio-docs-'));
  const app = createServer({ port: 0, home, fake: true });
  const router = createApi(app.services);
  const routes = router.routes.map((r) => `${r.method} ${r.pattern}`);
  assert.ok(routes.length >= 45, `only ${routes.length} routes`);
  for (const route of routes) {
    assert.ok(api.includes(`### \`${route}\``), `studio/docs/api.md has no section for ${route}`);
  }
  const documented = (api.match(/^### `(GET|POST|PUT|DELETE) [^`]+`$/gm) || []).map((h) => h.slice(5, -1));
  for (const route of documented) {
    assert.ok(routes.includes(route), `studio/docs/api.md documents ${route}, which the server does not have`);
  }
  app.services.events.close();
  fs.rmSync(home, { recursive: true, force: true });

  // --- every operation, with every parameter ----------------------------------------
  for (const op of ops.catalog()) {
    const heading = `### \`${op.name}\``;
    const at = api.indexOf(heading);
    assert.ok(at !== -1, `studio/docs/api.md has no section for the operation ${op.name}`);
    const next = api.indexOf('\n### ', at + heading.length);
    const section = api.slice(at, next === -1 ? api.length : next);
    for (const param of op.params) {
      assert.ok(section.includes(`\`${param.name}\``), `${op.name}: parameter ${param.name} is not documented`);
    }
    assert.ok(section.includes(`<!-- example:op.${op.name} -->`), `${op.name}: no recorded example`);
    assert.ok(/\bsteps?\b/i.test(section.replace(/<!-- example:[\s\S]*$/, '')), `${op.name}: the steps are not listed`);
  }

  // --- every event type ---------------------------------------------------------------
  for (const event of ['hello', 'job', 'log', 'activity', 'files', 'chat', 'heartbeat']) {
    assert.ok(api.includes(`| \`${event}\` |`), `event ${event} is not in the events table`);
    assert.ok(api.includes(`<!-- example:event-${event} -->`), `event ${event} has no example`);
  }
  for (const status of ['queued', 'running', 'needs_decision', 'done', 'failed', 'cancelled']) {
    assert.ok(api.includes(`\`${status}\``), `job status ${status} is not documented`);
  }

  // --- every example block is filled with JSON ---------------------------------------------
  const blocks = [...api.matchAll(/<!-- example:([a-z0-9.-]+) -->\n([\s\S]*?)<!-- \/example:\1 -->/g)];
  assert.ok(blocks.length >= 80, `only ${blocks.length} example blocks`);
  for (const [, name, body] of blocks) {
    const m = /^```json\n([\s\S]+)\n```\n$/.exec(body);
    assert.ok(m, `example ${name} is empty: run node studio/test-support/record-api-examples.js`);
    assert.doesNotThrow(() => JSON.parse(m[1]), `example ${name} is not valid JSON`);
  }
  assert.strictEqual((api.match(/<!-- example:/g) || []).length, blocks.length, 'an example marker has no closing marker');

  // --- nothing local or private in the documents ----------------------------------------------
  for (const [name, text] of [['studio/docs/api.md', api], ['studio/README.md', readme]]) {
    assert.ok(!/[A-Za-z]:\\\\?Users|\/Users\/|\/home\/[a-z]/.test(text), `${name} carries a local path`);
    assert.ok(!/AppData|scratchpad/i.test(text), `${name} carries a local path`);
  }

  // --- prose rules (code and examples are exempt) ------------------------------------------------
  const banned = ['crucial', 'essential', 'robust', 'comprehensive', 'holistic', 'seamless', 'innovative', 'cutting-edge',
    'powerful', 'delve', 'dive into', 'landscape', 'realm', 'tapestry', 'testament', 'leverage', 'elevate', 'unlock',
    "it's worth noting", 'it is important to', 'in conclusion', 'in summary', 'ultimately', 'moreover', 'furthermore',
    'additionally'];
  for (const [name, text] of [['studio/docs/api.md', api], ['studio/README.md', readme]]) {
    const prose = proseOf(text);
    for (const word of banned) {
      assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(prose), `${name}: the prose uses "${word}"`);
    }
    assert.ok(!/—/.test(prose), `${name}: an em dash is used as a connector`);
    assert.ok(!/\*\*[^*]+\*\*/.test(prose), `${name}: bold text in the body`);
    for (const heading of text.match(/^#{1,4} .+$/gm) || []) {
      const words = heading.replace(/^#+ /, '').replace(/`[^`]*`/g, '').split(/\s+/).filter(Boolean);
      const capitals = words.slice(1).filter((w) => /^[A-Z][a-z]+$/.test(w) && !['Claude', 'Code', 'Codex', 'API', 'AI'].includes(w));
      assert.ok(capitals.length === 0, `${name}: heading "${heading}" is not in sentence case`);
    }
  }
  console.log('studio-docs: ok');
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
