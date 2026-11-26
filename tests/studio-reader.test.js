'use strict';
/**
 * The exported web reader, opened from the app.
 *
 * Workspace HTML is served with `Content-Security-Policy: sandbox
 * allow-scripts`, so the reader runs with an opaque origin: it can never act
 * on the API as the app. That same opaque origin makes the reader's own
 * page images cross-site requests to this server, and a browser drops a
 * cross-site image whose response says `Cross-Origin-Resource-Policy:
 * same-origin`. This test asks for the reader and for one of its pages with
 * the headers a browser sends in that situation, and applies the browser's
 * rule to the answer. It also checks that nothing else in the workspace got
 * the wider policy.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const png = require('../scripts/lib/png');
const { start } = require('../studio/test-support/harness');

/** A GET with exactly these headers. */
function get(port, route, headers = {}, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: route, headers: Object.assign({ Host: `127.0.0.1:${port}` }, headers) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * The browser's Cross-Origin-Resource-Policy check for a no-cors request
 * (Fetch standard, "cross-origin resource policy check"), from a document
 * with an opaque origin: such a document is same-origin and same-site with
 * nothing, so only an absent header or `cross-origin` lets the response in.
 */
function opaqueOriginMayLoad(headers) {
  const policy = headers['cross-origin-resource-policy'];
  return policy === undefined || policy === 'cross-origin';
}

/** The headers of a navigation that opens the reader: embedded in the app, or in a tab of its own. */
const AS_IFRAME = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe', Accept: 'text/html' };
const AS_TAB = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-User': '?1', Accept: 'text/html' };
/** The headers of an <img> inside a sandboxed document: cross-site, no-cors, no Origin and no cookies of the app's origin. */
const AS_SANDBOXED_IMAGE = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image', Accept: 'image/avif,image/webp,image/png,*/*' };

async function main() {
  const s = await start();
  try {
    const id = await s.seedProject('Reader Test');
    const P = `/api/projects/${id}`;
    const root = path.join(s.home, id, 'production');
    let job = await s.runOp(id, 'pages.plan', { text: 'Mara crosses the river. She finds the boy.', pages: 2 });
    assert.strictEqual(job.status, 'done', JSON.stringify(job.error));
    job = await s.runOp(id, 'pages.generate', { approve_plans: true }, 60000);
    assert.strictEqual(job.status, 'done', JSON.stringify(job.error));
    job = await s.runOp(id, 'publish.build', { formats: ['web'] });
    assert.strictEqual(job.status, 'done', JSON.stringify(job.error));

    let r = await s.api('GET', `${P}/issues/ISS_001/publish`);
    const web = r.body.editions[0].exports.find((e) => e.format === 'web');
    assert.ok(web && web.browsable && web.url, JSON.stringify(r.body.editions[0].exports));
    const readerRoute = web.url.split('?')[0];
    assert.ok(/\/raw\/editions\/ED_001_01\/exports\/[^/]+-web\/index\.html$/.test(readerRoute), readerRoute);

    // --- the reader page: embedded and in a tab --------------------------------------------------
    for (const [how, headers] of [['embedded in the app', AS_IFRAME], ['opened in a tab', AS_TAB]]) {
      const page = await get(s.port, web.url, headers);
      assert.strictEqual(page.status, 200, how);
      assert.ok(/^text\/html/.test(page.headers['content-type']), how);
      // Sandboxed, scripts allowed (the reader pages with a script), and never the app's origin.
      assert.strictEqual(page.headers['content-security-policy'], 'sandbox allow-scripts', how);
      assert.ok(!/allow-same-origin/.test(page.headers['content-security-policy']), 'workspace HTML never runs with the app\'s origin');
      assert.strictEqual(page.headers['x-content-type-options'], 'nosniff');
      assert.strictEqual(page.headers['content-disposition'], undefined, 'the reader is shown, not downloaded');
      assert.strictEqual(page.headers['x-frame-options'], undefined, 'nothing forbids the app from framing it');
      // The page needs nothing but itself and its images: no script or stylesheet from another file.
      const html = page.buffer.toString('utf8');
      assert.ok(!/<script[^>]+src=/.test(html) && !/<link[^>]+rel="stylesheet"/.test(html), 'the reader is one self-contained file');
    }

    // --- its page images, asked for the way the sandboxed reader asks ----------------------------------
    const html = (await get(s.port, web.url, AS_IFRAME)).buffer.toString('utf8');
    const sources = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    assert.strictEqual(sources.length, 2, 'one image per page');
    assert.ok(sources.every((src) => /^pages\/[^/]+\.png$/.test(src)), sources.join(' '));
    for (const src of sources) {
      const route = new URL(src, `http://127.0.0.1:${s.port}${readerRoute}`).pathname;
      const image = await get(s.port, route, AS_SANDBOXED_IMAGE);
      assert.strictEqual(image.status, 200, route);
      assert.strictEqual(image.headers['content-type'], 'image/png');
      assert.ok(png.isPng(image.buffer));
      assert.strictEqual(image.headers['cross-origin-resource-policy'], 'cross-origin', 'the reader\'s pages may be loaded by the sandboxed reader');
      assert.ok(opaqueOriginMayLoad(image.headers), `a browser would block ${route}`);
      assert.strictEqual(image.headers['x-content-type-options'], 'nosniff');
      assert.strictEqual(image.headers['access-control-allow-origin'], undefined, 'loadable as an image, not readable by a script of another origin');
    }
    // The same page of the same edition as it was at a commit: the same rule.
    r = await s.api('GET', `${P}/history?limit=5`);
    const commit = r.body.entries.find((e) => e.commit);
    if (commit) {
      const relative = readerRoute.slice(`${P}/raw/`.length).replace(/index\.html$/, sources[0]);
      const old = await get(s.port, `${P}/at/${commit.commit}/raw/${relative}`, AS_SANDBOXED_IMAGE);
      assert.strictEqual(old.status, 200);
      assert.ok(opaqueOriginMayLoad(old.headers));
      const oldReader = await get(s.port, `${P}/at/${commit.commit}/raw/${relative.replace(sources[0], 'index.html')}`, AS_IFRAME);
      assert.deepStrictEqual([oldReader.status, oldReader.headers['content-security-policy']], [200, 'sandbox allow-scripts']);
    }

    // --- nothing else got wider ---------------------------------------------------------------------------
    // Any other image of the workspace still answers same-origin: a page of another site cannot embed it.
    r = await s.api('GET', `${P}/issues/ISS_001`);
    const render = r.body.pages[0].image.url;
    const direct = await get(s.port, render, AS_SANDBOXED_IMAGE);
    assert.strictEqual(direct.status, 200);
    assert.strictEqual(direct.headers['cross-origin-resource-policy'], 'same-origin');
    assert.ok(!opaqueOriginMayLoad(direct.headers), 'a render outside the reader stays closed to other origins');
    // Files a person or a tool could drop into the workspace.
    const readerDir = path.join(root, readerRoute.slice(`${P}/raw/`.length).replace(/\/index\.html$/, ''));
    fs.writeFileSync(path.join(readerDir, 'extra.html'), '<!doctype html><script>fetch("/api/projects")</script>');
    fs.writeFileSync(path.join(readerDir, 'drawing.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/projects")</script></svg>');
    fs.writeFileSync(path.join(readerDir, 'data.json'), '{}');
    fs.mkdirSync(path.join(root, 'story', 'fake-web', 'pages'), { recursive: true });
    fs.copyFileSync(path.join(readerDir, sources[0]), path.join(root, 'story', 'fake-web', 'pages', 'p.png'));
    fs.writeFileSync(path.join(root, 'story', 'notes.html'), '<!doctype html><script>fetch("/api/projects")</script>');
    const base = readerRoute.replace(/index\.html$/, '');
    for (const [route, sandboxed] of [
      [`${base}extra.html`, true],
      [`${base}drawing.svg`, true],
      [`${base}data.json`, false],
      [`${P}/raw/story/fake-web/pages/p.png`, false],
      [`${P}/raw/story/notes.html`, true],
    ]) {
      const other = await get(s.port, route, AS_SANDBOXED_IMAGE);
      assert.strictEqual(other.status, 200, route);
      assert.strictEqual(other.headers['cross-origin-resource-policy'], 'same-origin', `${route} must stay same-origin`);
      assert.strictEqual(other.headers['content-security-policy'], sandboxed ? 'sandbox allow-scripts' : undefined, route);
    }
    // And what a sandboxed page can do to the API: nothing that changes state.
    const body = JSON.stringify({ title: 'From The Sandbox', setup: false });
    const write = await get(s.port, '/api/projects', {
      Origin: 'null', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    }, 'POST', body);
    assert.strictEqual(write.status, 403);
    assert.strictEqual(JSON.parse(write.buffer.toString('utf8')).error.code, 'bad_origin');
    r = await s.api('GET', '/api/projects');
    assert.deepStrictEqual(r.body.projects.map((p) => p.id), [id]);
  } finally {
    await s.close();
  }
  console.log('studio-reader: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
