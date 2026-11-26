'use strict';
/**
 * Studio without git: the activity log still records every step, and
 * restore is reported as unavailable instead of failing in a strange way.
 * STUDIO_NO_GIT=1 makes the server behave as on a machine with no git.
 */

process.env.STUDIO_NO_GIT = '1';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { start } = require('../studio/test-support/harness');

async function main() {
  const s = await start();
  try {
    let r = await s.api('GET', '/api/health');
    assert.deepStrictEqual(r.body.git, { installed: false, version: null });

    r = await s.api('POST', '/api/projects', { title: 'No History', description: 'A comic made on a machine without git.', pages: 1 });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const id = r.body.project.id;
    const P = `/api/projects/${id}`;
    const job = await s.waitJob(id, r.body.job.id);
    assert.strictEqual(job.status, 'done', JSON.stringify(job.error));
    assert.ok(job.steps.every((step) => step.commit === null), 'no commits without git');
    assert.ok(!fs.existsSync(path.join(s.home, id, '.git')), 'no repository is created');

    r = await s.api('PUT', `${P}/file`, { path: 'style/color-script.md', text: '# Color\n\nOne palette.\n' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.commit, null);

    r = await s.api('GET', `${P}/history`);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.entries.length >= 4, 'the activity log works without git');
    assert.ok(r.body.entries.every((e) => e.commit === null && e.restorable === false));
    assert.ok(r.body.entries.some((e) => e.kind === 'save' && e.files[0].path === 'style/color-script.md'));
    assert.ok(r.body.entries.some((e) => e.step === 'story' && e.files.some((f) => f.path === 'story/story-bible.yaml')));
    assert.deepStrictEqual(r.body.restore.available, false);
    assert.ok(/git is not installed/.test(r.body.restore.reason));

    r = await s.api('POST', `${P}/history/restore`, { entry: r.body.entries[0].id });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error.code, 'entry_not_restorable');
    r = await s.api('POST', `${P}/history/restore`, { commit: '0123456789abcdef0123456789abcdef01234567' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error.code, 'history_unavailable');
    assert.ok(/git is not installed/.test(r.body.error.message));

    // What a commit changed, and a file as it was, need the repository: a clear refusal, not an empty answer.
    r = await s.api('GET', `${P}/diff?commit=0123456789abcdef0123456789abcdef01234567`);
    assert.deepStrictEqual([r.status, r.body.error.code], [409, 'history_unavailable']);
    r = await s.api('GET', `${P}/diff?from=0123456789abcdef&to=fedcba9876543210`);
    assert.deepStrictEqual([r.status, r.body.error.code], [409, 'history_unavailable']);
    r = await s.api('GET', `${P}/at/0123456789abcdef0123456789abcdef01234567/raw/project.yaml`);
    assert.deepStrictEqual([r.status, r.body.error.code], [409, 'history_unavailable']);
    assert.ok(/git/.test(r.body.error.message));

    r = await s.api('GET', P);
    assert.strictEqual(r.body.history.git, false);
  } finally {
    await s.close();
  }
  console.log('studio-nogit: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
