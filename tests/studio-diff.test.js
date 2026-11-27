'use strict';
/**
 * What a point of the history changed: GET /diff, and a file as it was at a
 * commit: GET /at/:commit/raw/*. Both read the project's own repository
 * through git and write nothing. Without git the routes answer 409
 * (tests/studio-nogit.test.js).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const png = require('../scripts/lib/png');
const { start } = require('../studio/test-support/harness');

const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

async function main() {
  if (!HAS_GIT) {
    console.log('studio-diff: git is not installed, skipped');
    return;
  }
  const s = await start();
  try {
    const id = await s.seedProject('Diff Test');
    const P = `/api/projects/${id}`;
    const root = path.join(s.home, id, 'production');
    const git = (...args) => spawnSync('git', ['--git-dir', path.join(s.home, id, '.git'), '--work-tree', path.join(s.home, id), ...args], { encoding: 'utf8' }).stdout.trim();
    const headBefore = git('rev-parse', 'HEAD');

    // --- a text file changed twice -----------------------------------------------------------------
    let r = await s.api('PUT', `${P}/file`, { path: 'style/color-script.md', text: '# Color\n\nOne palette: river blue.\n' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const first = r.body.commit;
    r = await s.api('PUT', `${P}/file`, { path: 'style/color-script.md', text: '# Color\n\nOne palette: river green.\n' });
    const second = r.body.commit;
    assert.ok(/^[0-9a-f]{40}$/.test(first) && /^[0-9a-f]{40}$/.test(second) && first !== second);

    r = await s.api('GET', `${P}/diff?commit=${second}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.from, r.body.to, r.body.total, r.body.more], [first, second, 1, false]);
    assert.deepStrictEqual(Object.keys(r.body.files[0]), ['path', 'status', 'kind', 'before', 'after', 'before_url', 'after_url']);
    const changed = r.body.files[0];
    assert.deepStrictEqual([changed.path, changed.status, changed.kind], ['style/color-script.md', 'modified', 'text']);
    assert.deepStrictEqual(changed.before, { text: '# Color\n\nOne palette: river blue.\n', bytes: 34, truncated: false });
    assert.deepStrictEqual(changed.after, { text: '# Color\n\nOne palette: river green.\n', bytes: 35, truncated: false });
    assert.strictEqual(changed.before_url, `${P}/at/${first}/raw/style/color-script.md`);
    assert.strictEqual(changed.after_url, `${P}/at/${second}/raw/style/color-script.md`);
    // A short id works too, as git prints it.
    r = await s.api('GET', `${P}/diff?commit=${second.slice(0, 10)}`);
    assert.deepStrictEqual([r.status, r.body.to], [200, second]);

    // --- a file as it was: the old text is still there after the file changed --------------------------
    let old = await s.raw('GET', changed.before_url);
    assert.strictEqual(old.status, 200);
    assert.strictEqual(old.buffer.toString('utf8'), '# Color\n\nOne palette: river blue.\n');
    assert.ok(/^text\/markdown|^text\/plain/.test(old.headers.get('content-type')), old.headers.get('content-type'));
    assert.ok(/immutable/.test(old.headers.get('cache-control')), 'a file at a commit never changes');
    assert.strictEqual(old.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(old.headers.get('cross-origin-resource-policy'), 'same-origin');
    const now = await s.raw('GET', `${P}/raw/style/color-script.md`);
    assert.strictEqual(now.buffer.toString('utf8'), '# Color\n\nOne palette: river green.\n');
    old = await s.raw('GET', `${changed.before_url}?download=1`);
    assert.ok(/attachment; filename="color-script.md"/.test(old.headers.get('content-disposition')));

    // --- a step that made images: the two URLs, each served from its commit ---------------------------------
    r = await s.api('GET', `${P}/history?limit=200`);
    const entries = r.body.entries;
    const drew = entries.find((e) => e.op === 'style.look' && e.step === 'draw');
    assert.ok(drew && drew.commit, 'the look page was drawn in a step with a commit');
    r = await s.api('GET', `${P}/diff?commit=${drew.commit}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const image = r.body.files.find((f) => f.kind === 'image');
    assert.ok(image, JSON.stringify(r.body.files.map((f) => f.path)));
    assert.deepStrictEqual([image.status, image.before, image.after, image.before_url], ['added', null, null, null]);
    assert.ok(/^references\/style\/LOOK_[A-Z_]+_V01\.png$/.test(image.path), image.path);
    const drawn = await s.raw('GET', image.after_url);
    assert.strictEqual(drawn.status, 200);
    assert.strictEqual(drawn.headers.get('content-type'), 'image/png');
    assert.ok(png.isPng(drawn.buffer));
    assert.ok(drawn.buffer.equals(fs.readFileSync(path.join(root, image.path))), 'the bytes at the commit are the bytes that were drawn');
    assert.ok(r.body.files.some((f) => f.kind === 'text' && f.status === 'added' && f.before === null && f.after.text.length > 0), 'the record written beside the image is a text file');
    assert.ok(r.body.files.every((f) => !f.path.startsWith('.') && !f.path.includes('/.')), 'the studio\'s own files are not part of the workspace diff');

    // --- a range: from one commit to another --------------------------------------------------------------------
    r = await s.api('GET', `${P}/diff?from=${headBefore}&to=${second}`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual([r.body.from, r.body.to], [headBefore, second]);
    const ranged = r.body.files.find((f) => f.path === 'style/color-script.md');
    assert.strictEqual(ranged.after.text, '# Color\n\nOne palette: river green.\n');
    assert.notStrictEqual(ranged.before.text, ranged.after.text);
    // Backwards is a diff too: what going back would change.
    r = await s.api('GET', `${P}/diff?from=${second}&to=${first}`);
    assert.deepStrictEqual([r.body.files[0].before.text, r.body.files[0].after.text],
      ['# Color\n\nOne palette: river green.\n', '# Color\n\nOne palette: river blue.\n']);

    // --- the first commit of a project has nothing before it --------------------------------------------------------
    const rootCommit = git('rev-list', '--max-parents=0', 'HEAD');
    r = await s.api('GET', `${P}/diff?commit=${rootCommit}&limit=5`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.from, null);
    assert.ok(r.body.total > 5 && r.body.more === true && r.body.files.length === 5, `${r.body.total} files in the first commit`);
    assert.ok(r.body.files.every((f) => f.status === 'added' && f.before === null && f.before_url === null));

    // --- a deletion: restoring an earlier point removes later files, and the diff says so ----------------------------
    r = await s.api('POST', `${P}/history/restore`, { commit: drew.commit });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await s.api('GET', `${P}/diff?commit=${r.body.commit}`);
    const gone = r.body.files.filter((f) => f.status === 'deleted');
    assert.ok(gone.length > 0, 'the restore deleted files');
    assert.ok(gone.every((f) => f.after === null && f.after_url === null && f.before_url));
    const goneText = gone.find((f) => f.kind === 'text');
    assert.ok(goneText && goneText.before.text.length > 0);
    const back = r.body.files.find((f) => f.path === 'style/color-script.md');
    assert.deepStrictEqual([back.status, back.before.text], ['modified', '# Color\n\nOne palette: river green.\n']);

    // --- a large text file is cut, and says so -----------------------------------------------------------------------
    const big = `# Notes\n\n${'A long line of notes about the river. '.repeat(8000)}\n`;
    r = await s.api('PUT', `${P}/file`, { path: 'story/notes.md', text: big });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await s.api('GET', `${P}/diff?commit=${r.body.commit}`);
    const large = r.body.files.find((f) => f.path === 'story/notes.md');
    assert.deepStrictEqual([large.status, large.after.truncated, large.after.bytes, large.after.text.length], ['added', true, Buffer.byteLength(big), 200 * 1024]);
    const whole = await s.raw('GET', large.after_url);
    assert.strictEqual(whole.buffer.length, Buffer.byteLength(big), 'the URL serves the whole file');

    // --- HTML from the history runs sandboxed, like HTML from the workspace ---------------------------------------------
    // A save commits only its own file, so the HTML file goes into the history by a commit of its own.
    fs.writeFileSync(path.join(root, 'story', 'page.html'), '<!doctype html><script>fetch("/api/projects")</script>');
    const withHtml = await require('../studio/server/git').commitAll(path.join(s.home, id), 'An HTML file');
    assert.ok(withHtml);
    r = await s.api('GET', `${P}/diff?commit=${withHtml}`);
    const html = r.body.files.find((f) => f.path === 'story/page.html');
    assert.deepStrictEqual([html.status, html.kind], ['added', 'text']);
    const served = await s.raw('GET', html.after_url);
    assert.strictEqual(served.headers.get('content-security-policy'), 'sandbox allow-scripts');

    // --- refusals -------------------------------------------------------------------------------------------------------
    r = await s.api('GET', `${P}/diff`);
    assert.deepStrictEqual([r.status, r.body.error.code], [400, 'bad_params']);
    r = await s.api('GET', `${P}/diff?from=${first}`);
    assert.deepStrictEqual([r.status, r.body.error.code], [400, 'bad_params']);
    for (const bad of ['ffffffffffffffffffffffffffffffffffffffff', 'HEAD', 'HEAD~1', 'main', '--all', `${first};ls`, 'abc']) {
      r = await s.api('GET', `${P}/diff?commit=${encodeURIComponent(bad)}`);
      assert.deepStrictEqual([r.status, r.body.error.code], [404, 'commit_not_found'], bad);
      r = await s.api('GET', `${P}/at/${encodeURIComponent(bad)}/raw/project.yaml`);
      assert.deepStrictEqual([r.status, r.body.error.code], [404, 'commit_not_found'], bad);
    }
    r = await s.api('GET', `${P}/diff?from=${first}&to=ffffffffffffffffffffffffffffffffffffffff`);
    assert.strictEqual(r.status, 404);
    // Only files of the workspace, by a plain relative path.
    for (const bad of ['nothing.txt', '..%2f.studio%2fsettings.json', '.gitignore', 'story/..%2f..%2f.studio/settings.json', 'story//page.html', 'story%5cpage.html']) {
      r = await s.api('GET', `${P}/at/${withHtml}/raw/${bad}`);
      assert.deepStrictEqual([r.status, r.body.error.code], [404, 'not_found'], bad);
    }
    assert.ok(git('ls-tree', '-r', '--name-only', withHtml).split('\n').some((n) => n === '.gitignore'), 'the repository has files outside the workspace, which the route does not serve');
    r = await s.api('POST', `${P}/diff?commit=${first}`, {});
    assert.strictEqual(r.status, 405);
    r = await s.api('GET', `/api/projects/nobody/diff?commit=${first}`);
    assert.deepStrictEqual([r.status, r.body.error.code], [404, 'project_not_found']);

    // --- read-only: nothing above moved the repository or the working tree --------------------------------------------------
    assert.strictEqual(git('status', '--porcelain'), '', 'reading the history leaves nothing uncommitted');
    assert.strictEqual(git('rev-parse', 'HEAD'), withHtml);
  } finally {
    await s.close();
  }
  console.log('studio-diff: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
