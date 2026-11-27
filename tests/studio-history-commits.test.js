'use strict';
/**
 * One commit holds the files of its own step or approval, and nothing else
 * (TODO item 11). Found in a real run: a page plan wrote three character
 * files while the person approved a sheet, and the approval's commit swept
 * them in, because commits were made from the whole working tree.
 *
 * 1. git.commitPaths commits exactly the paths it is given: other changes in
 *    the working tree and in the index stay out, a deleted path is removed,
 *    a path that never existed is ignored.
 * 2. Two writers at once: a job step writes files over time while a person's
 *    action (history.record, as every approval and save uses) writes its own
 *    file in the middle. The action's commit has only its file; the step's
 *    commit has only the step's files; the action's file is not claimed by
 *    the step.
 * 3. The same through the HTTP API: a slow page plan (SLOW) runs while the
 *    person saves a file; the save's commit holds only that file, and the
 *    plan's commits do not hold it.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../studio/server/git');
const history = require('../studio/server/history');
const { JobManager } = require('../studio/server/jobs');
const { Project } = require('../studio/server/registry');
const { start } = require('../studio/test-support/harness');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function write(root, rel, text) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

async function filesOf(dir, commit) {
  return (await git.filesOf(dir, commit)).map((f) => `${f.change}:${f.path}`).sort();
}

async function main() {
  const started = Date.now();
  if (!git.detect().installed) {
    console.log('git is not installed: skipped');
    return;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-commits-'));
  try {
    // --- 1. commitPaths --------------------------------------------------------------------
    const dir = path.join(home, 'plain');
    fs.mkdirSync(dir);
    assert.ok(await git.init(dir));
    write(dir, 'production/a.yaml', 'a: 1\n');
    write(dir, 'production/gone.yaml', 'x: 1\n');
    assert.ok(await git.commitAll(dir, 'start'));
    write(dir, 'production/a.yaml', 'a: 2\n');
    write(dir, 'production/new.yaml', 'n: 1\n');
    write(dir, 'production/other.yaml', 'someone else\n');
    fs.rmSync(path.join(dir, 'production', 'gone.yaml'));
    const c1 = await git.commitPaths(dir, 'mine', ['production/a.yaml', 'production/new.yaml', 'production/gone.yaml', 'production/never.yaml']);
    assert.ok(c1, 'a commit was made');
    assert.deepStrictEqual(await filesOf(dir, c1),
      ['added:production/new.yaml', 'deleted:production/gone.yaml', 'modified:production/a.yaml'],
      'only the given paths, a deletion included; a path that never existed is ignored');
    assert.strictEqual(await git.commitPaths(dir, 'again', ['production/a.yaml']), null, 'nothing changed: no commit');
    assert.strictEqual(await git.commitPaths(dir, 'empty', []), null);
    const c2 = await git.commitAll(dir, 'the rest');
    assert.deepStrictEqual(await filesOf(dir, c2), ['added:production/other.yaml'],
      'the index followed the first commit: the next full commit holds only what was left');
    const log = await git.log(dir);
    assert.deepStrictEqual(log.map((c) => c.subject), ['the rest', 'mine', 'start']);

    // --- 2. a job step and a person's action at the same time ---------------------------------
    const events = { emit: () => {} };
    let release;
    const gate = new Promise((r) => { release = r; });
    let stepReachedGate;
    const atGate = new Promise((r) => { stepReachedGate = r; });
    const op = {
      name: 'test.slow',
      steps: () => [{ id: 'write', label: 'write' }, { id: 'more', label: 'more' }],
      async run(ctx) {
        await ctx.step('write', async () => {
          write(ctx.project.root, 'characters/CHAR_STRANGER/character.yaml', 'id: CHAR_STRANGER\n');
          stepReachedGate();
          await gate;
          write(ctx.project.root, 'characters/CHAR_STRANGER/wardrobe.yaml', 'character: CHAR_STRANGER\n');
        });
        await ctx.step('more', async () => {
          write(ctx.project.root, 'issues/ISS_001/notes.yaml', 'n: 1\n');
        });
        return { ok: true };
      },
    };
    const services = { events };
    const jobs = new JobManager({ events, ops: { get: (n) => (n === op.name ? op : null) }, services });
    services.jobs = jobs;
    fs.mkdirSync(path.join(home, 'proj', 'production'), { recursive: true });
    const project = new Project(home, 'proj');
    write(project.root, 'project.yaml', 'title: Test\n');
    write(project.root, 'characters/CHAR_MARA/refs/CHAR_MARA_TURN_V01.png', 'png');
    assert.ok(await git.init(project.dir));
    assert.ok(await git.commitAll(project.dir, 'Create'));

    const queued = jobs.enqueue(project, 'test.slow', {});
    await atGate;
    // The person approves while the step is half way: the approval writes its own file.
    const saved = await history.record(services, project, {
      kind: 'approval', title: 'Approved CHAR_MARA_TURN_V01', scope: ['characters/CHAR_MARA', 'references/manifest.yaml'],
    }, () => {
      write(project.root, 'characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png', 'png');
      write(project.root, 'references/manifest.yaml', 'assets: []\n');
    });
    release();
    await jobs.idle();
    const job = jobs.get(project, queued.id);
    assert.strictEqual(job.status, 'done', JSON.stringify(job.error));
    assert.ok(saved.commit, 'the approval made a commit');
    assert.deepStrictEqual(await filesOf(project.dir, saved.commit),
      ['added:production/characters/CHAR_MARA/refs/CHAR_MARA_TURN_MASTER_V01.png', 'added:production/references/manifest.yaml'],
      'the approval commit holds the approval files only, not the character the job had just written');
    const [writeStep, moreStep] = job.steps;
    assert.deepStrictEqual(await filesOf(project.dir, writeStep.commit),
      ['added:production/characters/CHAR_STRANGER/character.yaml', 'added:production/characters/CHAR_STRANGER/wardrobe.yaml'],
      'the step commit holds the step files only');
    assert.deepStrictEqual(writeStep.changed.sort(), ['characters/CHAR_STRANGER/character.yaml', 'characters/CHAR_STRANGER/wardrobe.yaml'],
      'the step does not claim the approval files');
    assert.deepStrictEqual(await filesOf(project.dir, moreStep.commit), ['added:production/issues/ISS_001/notes.yaml']);
    // The approval came first in the history and holds nothing of the job, so undoing it takes back the approval alone.
    const subjects = (await git.log(project.dir)).map((c) => c.subject);
    assert.strictEqual(subjects.indexOf('Approved CHAR_MARA_TURN_V01'), 2, subjects.join(' | '));

    // A scope keeps out a file the job wrote during a slow action.
    const scoped = await history.record(services, project, { kind: 'save', title: 'Edited a file', scope: ['story/notes.md'] }, () => {
      write(project.root, 'story/notes.md', 'mine\n');
      write(project.root, 'characters/CHAR_STRANGER/character.yaml', 'id: CHAR_STRANGER\nname: written by a job meanwhile\n');
    });
    assert.deepStrictEqual(await filesOf(project.dir, scoped.commit), ['added:production/story/notes.md'],
      'outside the scope is not the action\'s');
    assert.deepStrictEqual(scoped.changes.map((c) => c.path), ['story/notes.md']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }

  // --- 3. through the API: a slow page plan and a save at the same time --------------------------
  process.env.STUDIO_FAKE_SLOW_MS = '1500';
  const s = await start();
  try {
    const id = await s.seedProject('Two Writers');
    const P = `/api/projects/${id}`;
    const res = await s.api('POST', `${P}/ops`, { op: 'pages.plan', params: { text: 'She opens the box. SLOW', pages: 3 } });
    assert.strictEqual(res.status, 202, JSON.stringify(res.body));
    const jobId = res.body.job.id;
    // Wait until the plan is writing pages, then save a file of another part of the project.
    for (let i = 0; i < 200; i++) {
      const j = (await s.api('GET', `${P}/jobs/${jobId}`)).body.job;
      if (j.current_step === 'pages') break;
      await sleep(20);
    }
    const saved = await s.api('PUT', `${P}/file`, { path: 'style/color-script.md', text: '# Color script\n\nWarm.\n' });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
    // While the plan writes, the issue screen shows progress instead of the plan's checks.
    const during = (await s.api('GET', `${P}/issues/ISS_001`)).body;
    assert.ok(during.planning, 'the issue says a plan is being written');
    assert.strictEqual(during.mechanical.skipped, true);
    assert.deepStrictEqual([during.mechanical.continuity.length, during.mechanical.validation.errors.length], [0, 0]);
    assert.strictEqual(during.planning.pages, 3);
    const job = await s.waitJob(id, jobId, 60000);
    assert.strictEqual(job.status, 'done', JSON.stringify(job.error));
    const dir = path.join(s.home, id);
    assert.deepStrictEqual(await filesOf(dir, saved.body.commit), ['modified:production/style/color-script.md']);
    for (const commit of job.commits) {
      assert.ok(!(await filesOf(dir, commit)).some((f) => f.endsWith('color-script.md')), 'no plan commit holds the saved file');
    }
    const after = (await s.api('GET', `${P}/issues/ISS_001`)).body;
    assert.strictEqual(after.planning, null);
    assert.strictEqual(after.mechanical.skipped, false);
  } finally {
    await s.close();
    delete process.env.STUDIO_FAKE_SLOW_MS;
  }
  console.log(`studio-history-commits: ok (${Date.now() - started} ms)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
