'use strict';
/**
 * Studio server: the checks that keep a local web app local. Host header,
 * Origin of writes, path confinement, upload types and sizes, static files.
 * Fake mode, temporary home.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const png = require('../scripts/lib/png');
const { start } = require('../studio/test-support/harness');
const security = require('../studio/server/security');
const { parseRange } = require('../studio/server/http');

/** A request with full control over the headers (fetch refuses to set Host). */
function rawRequest(port, { method = 'GET', route = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: route, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (err) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const s = await start();
  try {
    const host = `127.0.0.1:${s.port}`;

    // --- Host header (DNS rebinding) -------------------------------------------
    let r = await rawRequest(s.port, { route: '/api/health', headers: { Host: host } });
    assert.strictEqual(r.status, 200);
    r = await rawRequest(s.port, { route: '/api/health', headers: { Host: `localhost:${s.port}` } });
    assert.strictEqual(r.status, 200, 'localhost on the bound port is accepted');
    for (const bad of ['evil.example', `evil.example:${s.port}`, '127.0.0.1:1', '127.0.0.1', `127.0.0.1.evil.example:${s.port}`]) {
      r = await rawRequest(s.port, { route: '/api/health', headers: { Host: bad } });
      assert.strictEqual(r.status, 403, `Host ${bad} must be refused`);
      assert.strictEqual(r.json.error.code, 'bad_host');
    }
    r = await rawRequest(s.port, { route: '/', headers: { Host: 'evil.example' } });
    assert.strictEqual(r.status, 403, 'static files check the Host too');

    // --- Origin on writes --------------------------------------------------------
    const create = JSON.stringify({ title: 'Origin Test', setup: false });
    r = await rawRequest(s.port, {
      method: 'POST', route: '/api/projects', body: create,
      headers: { Host: host, Origin: 'http://evil.example', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(create) },
    });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.error.code, 'bad_origin');
    r = await rawRequest(s.port, {
      method: 'POST', route: '/api/projects', body: create,
      headers: { Host: host, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(create) },
    });
    assert.strictEqual(r.status, 403, 'a cross-site fetch is refused even without Origin');
    r = await rawRequest(s.port, { route: '/api/health', headers: { Host: host, Origin: 'http://evil.example' } });
    assert.strictEqual(r.status, 200, 'a read with a foreign Origin is answered (and carries no CORS header)');
    assert.strictEqual(r.headers['access-control-allow-origin'], undefined);
    r = await rawRequest(s.port, {
      method: 'POST', route: '/api/projects', body: create,
      headers: { Host: host, Origin: `http://127.0.0.1:${s.port}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(create) },
    });
    assert.strictEqual(r.status, 201, 'the app\'s own origin may write');
    const id = r.json.project.id;
    assert.strictEqual(r.json.job, null, 'setup: false starts no job');

    // --- JSON bodies -----------------------------------------------------------------
    r = await s.api('POST', '/api/projects', 'title=x', { 'Content-Type': 'text/plain' });
    assert.strictEqual(r.status, 415, 'a body that is not JSON is refused');
    r = await s.api('POST', '/api/projects', '{not json', { 'Content-Type': 'application/json' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error.code, 'bad_json');
    r = await s.api('POST', '/api/projects', { title: 'x'.repeat(2 * 1024 * 1024) });
    assert.strictEqual(r.status, 413, 'a JSON body over the limit is refused');

    // --- routes ------------------------------------------------------------------------
    r = await s.api('GET', '/api/nope');
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.error.code, 'not_found');
    r = await s.api('PUT', '/api/health', {});
    assert.strictEqual(r.status, 405);
    r = await s.api('GET', '/api/projects/no-such-project');
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.error.code, 'project_not_found');
    r = await s.api('GET', '/api/projects/..%2F..');
    assert.strictEqual(r.status, 404, 'a project id is a slug, never a path');

    // --- path confinement ----------------------------------------------------------------
    const P = `/api/projects/${id}`;
    const outside = path.join(s.home, 'secret.txt');
    fs.writeFileSync(outside, 'outside the project');
    for (const attempt of ['../secret.txt', '..%2Fsecret.txt', '%2e%2e/secret.txt', '..\\secret.txt', '..%5Csecret.txt',
      'story/../../secret.txt', '/etc/passwd', 'C:/Windows/win.ini', 'C:%5CWindows%5Cwin.ini']) {
      r = await rawRequest(s.port, { route: `${P}/raw/${attempt}`, headers: { Host: host } });
      assert.ok([400, 404].includes(r.status), `raw ${attempt} must not be served (got ${r.status})`);
      assert.ok(!r.text.includes('outside the project'));
    }
    r = await s.api('GET', `${P}/raw/project.yaml`);
    assert.strictEqual(r.status, 200, 'a file inside the workspace is served');
    r = await rawRequest(s.port, { route: `${P}/raw/../.studio/settings.json`, headers: { Host: host } });
    assert.ok([400, 404].includes(r.status), 'the studio\'s own folder is not reachable through raw');
    for (const attempt of ['../secret.txt', '..\\secret.txt', '/abs/file.yaml', 'C:\\x.yaml', 'story/../../secret.txt']) {
      r = await s.api('GET', `${P}/file?path=${encodeURIComponent(attempt)}`);
      assert.strictEqual(r.status, 400, `file ${attempt} must be refused`);
      assert.strictEqual(r.body.error.code, 'bad_path');
      r = await s.api('PUT', `${P}/file`, { path: attempt, text: 'x: 1\n' });
      assert.strictEqual(r.status, 400, `saving ${attempt} must be refused`);
    }
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'outside the project');
    r = await s.api('PUT', `${P}/file`, { path: 'story/evil.exe', text: 'x' });
    assert.strictEqual(r.status, 415, 'only text artifacts are writable');
    r = await s.api('PUT', `${P}/file`, { path: '.hidden/x.yaml', text: 'x: 1\n' });
    assert.strictEqual(r.status, 400);

    // resolveInside directly, including a link that leaves the base.
    const base = path.join(s.home, id, 'production');
    assert.throws(() => security.resolveInside(base, '../x'), /cannot leave/);
    assert.throws(() => security.resolveInside(base, 'a\0b'), /required/);
    assert.throws(() => security.resolveInside(base, ''), /required/);
    assert.strictEqual(security.resolveInside(base, 'story/story-bible.yaml'), path.join(base, 'story', 'story-bible.yaml'));
    let linked = false;
    try {
      fs.symlinkSync(s.home, path.join(base, 'story', 'escape'), 'junction');
      linked = true;
    } catch (err) {
      linked = false; // no permission to create links here: the direct checks above still hold
    }
    if (linked) {
      assert.throws(() => security.resolveInside(base, 'story/escape/secret.txt'), /cannot leave/);
      r = await s.api('GET', `${P}/raw/story/escape/secret.txt`);
      assert.strictEqual(r.status, 400, 'a link out of the workspace is not followed');
      fs.unlinkSync(path.join(base, 'story', 'escape'));
    }
    assert.strictEqual(security.safeName('../../etc/pass wd?.png'), 'pass-wd-.png');

    // --- uploads -----------------------------------------------------------------------------
    const image = png.encode({ width: 4, height: 4, data: Buffer.alloc(4 * 4 * 3, 200) });
    const up = await s.upload(id, 'photo.png', image, 'image/png');
    assert.strictEqual(up.kind, 'image');
    assert.strictEqual(up.width, 4);
    assert.ok(up.url.endsWith(up.id));
    r = await s.raw('GET', up.url);
    assert.strictEqual(r.status, 200);
    assert.ok(r.buffer.equals(image));
    const text = await s.upload(id, 'notes.md', Buffer.from('# Source\n\nText.\n'), 'text/markdown');
    assert.strictEqual(text.kind, 'source');
    for (const [name, body, code] of [
      ['run.exe', Buffer.from('MZ'), 'unsupported_file'],
      ['page.svg', Buffer.from('<svg/>'), 'unsupported_file'],
      ['script.js', Buffer.from('x'), 'unsupported_file'],
      ['index.html', Buffer.from('<html>'), 'unsupported_file'],
      ['fake.png', Buffer.from('this is not a png'), 'not_an_image'],
      ['wrong.jpg', image, 'not_an_image'],
      ['binary.txt', Buffer.from([65, 0, 66]), 'not_text'],
    ]) {
      await assert.rejects(() => s.upload(id, name, body), (err) => {
        assert.strictEqual(err.status, 415, `${name} must be refused with 415`);
        assert.strictEqual(err.body.error.code, code);
        return true;
      });
    }
    await assert.rejects(() => s.upload(id, 'big.txt', Buffer.alloc(3 * 1024 * 1024, 65)), (err) => err.status === 413);
    await assert.rejects(() => s.upload(id, 'empty.png', Buffer.alloc(0)), (err) => err.status === 400);
    const traversal = await s.upload(id, '../../outside.png', image, 'image/png');
    assert.strictEqual(traversal.name, 'outside.png', 'an upload name keeps its last segment only');
    assert.ok(!fs.existsSync(path.join(s.home, 'outside.png')));
    r = await s.api('GET', `${P}/uploads`);
    assert.strictEqual(r.body.uploads.length, 3);

    // --- static files ------------------------------------------------------------------------------
    r = await s.raw('GET', '/');
    assert.strictEqual(r.status, 200);
    assert.ok(/text\/html/.test(r.headers.get('content-type')));
    assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(r.buffer.toString().includes('Comics studio'));
    r = await s.raw('GET', '/projects/some/deep/route');
    assert.strictEqual(r.status, 200, 'an unknown path falls back to the app shell');
    assert.ok(/text\/html/.test(r.headers.get('content-type')));
    r = await s.raw('GET', '/missing.js');
    assert.strictEqual(r.status, 404, 'a missing asset is a 404, not the app shell');
    r = await rawRequest(s.port, { route: '/../server/index.js', headers: { Host: host } });
    assert.ok(!r.text.includes('createServer'), 'static files cannot leave studio/web');
    r = await rawRequest(s.port, { route: '/..%2Fserver%2Findex.js', headers: { Host: host } });
    assert.ok(r.status === 404 && !r.text.includes('createServer'));
    r = await s.raw('POST', '/');
    assert.strictEqual(r.status, 405);

    // --- ranges ---------------------------------------------------------------------------------------
    assert.deepStrictEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
    assert.deepStrictEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
    assert.deepStrictEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
    assert.strictEqual(parseRange('bytes=200-', 100), false);
    assert.strictEqual(parseRange(undefined, 100), null);
    r = await s.raw('GET', `${P}/raw/project.yaml`, undefined, { Range: 'bytes=0-9' });
    assert.strictEqual(r.status, 206);
    assert.strictEqual(r.buffer.length, 10);
    assert.ok(/^bytes 0-9\/\d+$/.test(r.headers.get('content-range')));
    const etag = r.headers.get('etag');
    r = await s.raw('GET', `${P}/raw/project.yaml`, undefined, { 'If-None-Match': etag });
    assert.strictEqual(r.status, 304);
    r = await s.raw('GET', `${P}/raw/project.yaml`, undefined, { Range: 'bytes=999999-' });
    assert.strictEqual(r.status, 416);
    r = await s.raw('GET', `${P}/raw/project.yaml?download=1`);
    assert.ok(/attachment; filename="project.yaml"/.test(r.headers.get('content-disposition')));
  } finally {
    await s.close();
  }
  console.log('studio-security: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
