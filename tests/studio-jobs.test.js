'use strict';
/**
 * Studio jobs: the queue (one job at a time per project), cancel (also of a
 * running drawing process), needs_decision and its answer, the event
 * stream, a drawing failure that does not stop the queue, a page that keeps
 * failing and is left flagged at the repair limit, and the recovery of jobs
 * a crashed server left behind. Fake mode, temporary home.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ws = require('../scripts/lib/workspace');
const S = require('../studio/server/scaffold');
const { start } = require('../studio/test-support/harness');

function states(job) {
  return job.steps.map((s) => `${s.id}:${s.status}`).join(' ');
}

async function waitUntil(fn, timeoutMs = 10000, what = 'condition') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function main() {
  // The fake's slow steps and slow drawings take this long unless cancelled.
  process.env.STUDIO_FAKE_SLOW_MS = '20000';
  const s = await start({ heartbeatMs: 150 });
  const home = s.home;
  let id;
  try {
    // --- needs_decision, the event stream, and the answer ----------------------------
    let r = await s.api('POST', '/api/projects', { title: 'Decision', setup: false });
    assert.strictEqual(r.status, 201);
    id = r.body.project.id;
    const P = `/api/projects/${id}`;
    const stream = s.openEvents(id);
    const hello = await stream.waitFor((e) => e.type === 'hello');
    assert.strictEqual(hello.status, 200);
    assert.ok(/text\/event-stream/.test(hello.contentType));
    assert.strictEqual(hello.data.project, id);
    assert.deepStrictEqual(hello.data.jobs, []);
    await stream.waitFor((e) => e.type === 'heartbeat', 3000);

    r = await s.api('POST', `${P}/ops`, { op: 'project.setup', params: { description: 'DECIDE how this story ends.', pages: 2 } });
    assert.strictEqual(r.status, 202);
    assert.strictEqual(r.body.job.status, 'queued');
    assert.deepStrictEqual(r.body.job.steps.map((x) => [x.id, x.status]), [['source', 'pending'], ['story', 'pending'], ['check', 'pending']],
      'a job lists its steps up front');
    const jobId = r.body.job.id;
    let job = await s.waitJob(id, jobId);
    assert.strictEqual(job.status, 'needs_decision', states(job));
    assert.strictEqual(job.questions.length, 1);
    assert.deepStrictEqual(Object.keys(job.questions[0]), ['id', 'question', 'options']);
    assert.strictEqual(job.questions[0].options.length, 2);
    assert.deepStrictEqual(job.steps.map((x) => x.status), ['done', 'waiting', 'pending']);
    assert.strictEqual(job.ended_at, null, 'a paused job has not ended');
    const sourceStarted = job.steps[0].started_at;
    const paused = await stream.waitFor((e) => e.type === 'job' && e.data.job.id === jobId && e.data.job.status === 'needs_decision');
    assert.strictEqual(paused.data.job.questions[0].id, 'q1');
    // A paused job does not hold the queue.
    r = await s.api('GET', `${P}/jobs?active=1`);
    assert.deepStrictEqual(r.body.jobs.map((j) => j.status), ['needs_decision']);
    assert.strictEqual(r.body.running, null);

    r = await s.api('POST', `${P}/jobs/${jobId}/answer`, { answers: {} });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(r.body.error.details.missing, ['q1']);
    r = await s.api('POST', `${P}/jobs/${jobId}/answer`, { answers: { q1: 'The second way' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    job = await s.waitJob(id, jobId);
    assert.strictEqual(job.status, 'done', `${states(job)} ${JSON.stringify(job.error)}`);
    assert.deepStrictEqual(job.steps.map((x) => x.status), ['done', 'done', 'done']);
    assert.strictEqual(job.steps[0].started_at, sourceStarted, 'a finished step does not run again after an answer');
    assert.deepStrictEqual(job.answers.q1.answer, 'The second way');
    assert.ok(job.result.decisions.some((d) => /The second way/.test(d)), 'the answer reached the step that asked');
    r = await s.api('POST', `${P}/jobs/${jobId}/answer`, { answers: { q1: 'again' } });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error.code, 'job_not_waiting');

    // What the stream carried.
    await stream.waitFor((e) => e.type === 'job' && e.data.job.id === jobId && e.data.job.status === 'done');
    const types = new Set(stream.events.map((e) => e.type));
    for (const type of ['hello', 'heartbeat', 'job', 'log', 'activity', 'files']) assert.ok(types.has(type), `no ${type} event`);
    const log = stream.events.find((e) => e.type === 'log' && /reading commands for story.propose/.test(e.data.line));
    assert.ok(log, 'tool use shows up as short progress lines');
    assert.deepStrictEqual(Object.keys(log.data).sort(), ['at', 'job', 'line', 'step']);
    assert.strictEqual(log.data.step, 'story');
    const filesEvent = stream.events.find((e) => e.type === 'files' && e.data.paths.includes('story/story-bible.yaml'));
    assert.ok(filesEvent, 'changed files are announced with workspace-relative paths');
    // The setup writes the description mechanically; the AI step only proposes and writes nothing.
    const activity = stream.events.find((e) => e.type === 'activity' && e.data.entry.step === 'source');
    assert.strictEqual(activity.data.entry.actor, 'studio');
    assert.ok(!stream.events.some((e) => e.type === 'activity' && e.data.entry.step === 'story'), 'the proposal step changes no file');
    assert.ok(stream.events.every((e) => e.id), 'every event has an id');
    r = await s.api('GET', `${P}/jobs/${jobId}?log=200`);
    assert.ok(r.body.log.some((line) => /waiting for a decision/.test(line)));
    r = await s.api('GET', `${P}/jobs/${jobId}/log`);
    assert.ok(r.body.lines.length >= r.body.lines.filter((l) => /story/.test(l)).length);

    // --- a failure the AI reports -----------------------------------------------------------
    job = await s.runOp(id, 'story.update', { instruction: 'FAILAI please' });
    assert.strictEqual(job.status, 'failed');
    assert.strictEqual(job.error.code, 'ai_reported_failure');
    assert.deepStrictEqual(job.steps.map((x) => x.status), ['failed', 'pending']);

    // --- cancel a running job, and one job at a time ---------------------------------------------
    r = await s.api('POST', `${P}/ops`, { op: 'story.update', params: { instruction: 'SLOW change' } });
    const slowId = r.body.job.id;
    r = await s.api('POST', `${P}/ops`, { op: 'story.update', params: { instruction: 'A quick change.' } });
    const secondId = r.body.job.id;
    r = await s.api('POST', `${P}/ops`, { op: 'story.update', params: { instruction: 'Another quick change.' } });
    const thirdId = r.body.job.id;
    await waitUntil(async () => (await s.api('GET', `${P}/jobs/${slowId}`)).body.job.status === 'running', 5000, 'the slow job to run');
    r = await s.api('GET', `${P}/jobs?active=1`);
    assert.deepStrictEqual(r.body.jobs.map((j) => [j.id, j.status, j.position]).reverse(),
      [[slowId, 'running', null], [secondId, 'queued', 1], [thirdId, 'queued', 2]], 'one job runs, the others wait in order');
    assert.strictEqual(r.body.running.id, slowId);
    await stream.waitFor((e) => e.type === 'job' && e.data.job.id === slowId && e.data.job.current_step === 'update');
    // Cancel a queued job, then the running one.
    r = await s.api('POST', `${P}/jobs/${thirdId}/cancel`, {});
    assert.strictEqual(r.body.job.status, 'cancelled');
    const cancelAt = Date.now();
    r = await s.api('POST', `${P}/jobs/${slowId}/cancel`, {});
    assert.strictEqual(r.status, 200);
    job = await s.waitJob(id, slowId, 5000);
    assert.strictEqual(job.status, 'cancelled', states(job));
    assert.ok(Date.now() - cancelAt < 4000, 'a cancel does not wait for the step to finish');
    assert.strictEqual(job.steps[0].status, 'cancelled');
    assert.strictEqual(job.error, null);
    job = await s.waitJob(id, secondId, 5000);
    assert.strictEqual(job.status, 'done', 'the next job runs after a cancel');
    r = await s.api('POST', `${P}/jobs/${slowId}/cancel`, {});
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error.code, 'job_finished');
    r = await s.api('POST', `${P}/jobs/job_nope/cancel`, {});
    assert.strictEqual(r.status, 404);
    r = await s.api('POST', `${P}/ops`, { op: 'no.such.op', params: {} });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error.code, 'unknown_operation');
    r = await s.api('POST', `${P}/ops`, { op: 'pages.plan', params: { pages: 99, text: 'x' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error.code, 'bad_params');
    stream.close();

    // --- drawing: a failed page does not stop the queue; a slow drawing is killed on cancel -----------
    const seeded = await s.seedProject('Drawing Jobs');
    const Q = `/api/projects/${seeded}`;
    const root = path.join(home, seeded, 'production');
    job = await s.runOp(seeded, 'pages.plan', { text: 'FAILDRAW the first page breaks. The second page is fine.', pages: 2 });
    assert.strictEqual(job.status, 'done', `${states(job)} ${JSON.stringify(job.error)}`);
    job = await s.runOp(seeded, 'pages.generate', { issue: 'ISS_001', approve_plans: true }, 60000);
    assert.strictEqual(job.status, 'done', `${states(job)} ${JSON.stringify(job.error)}`);
    assert.deepStrictEqual(job.result.pages.map((p) => [p.page, p.error ? p.error.code : p.verdict]),
      [['PG_001_001', 'draw_failed'], ['PG_001_002', 'pass']], 'the queue goes on after a page that could not be drawn');
    assert.strictEqual(job.result.failed, 1);
    assert.strictEqual(job.steps.find((x) => x.id === 'PG_001_001:draw').status, 'failed');
    assert.strictEqual(job.steps.find((x) => x.id === 'PG_001_001:review').status, 'skipped');
    assert.deepStrictEqual(ws.listRenders(root, 'PG_001_001'), []);
    const record = ws.loadYaml(path.join(root, 'generations', 'PG_001_001', 'GEN_PG_001_001_01.yaml'));
    assert.strictEqual(record.status, 'failed', 'the failed attempt keeps its generation record');

    job = await s.runOp(seeded, 'pages.plan', { text: 'SLOWDRAW this page takes very long to draw.', pages: 1 });
    assert.strictEqual(job.status, 'done', states(job));
    r = await s.api('POST', `${Q}/ops`, { op: 'pages.generate', params: { pages: ['PG_001_003'], approve_plans: true } });
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    const drawJob = r.body.job.id;
    await waitUntil(async () => {
      const j = (await s.api('GET', `${Q}/jobs/${drawJob}`)).body.job;
      return j.current_step === 'PG_001_003:draw';
    }, 10000, 'the drawing to start');
    await new Promise((res) => setTimeout(res, 400)); // let the drawing process start
    const killAt = Date.now();
    r = await s.api('POST', `${Q}/jobs/${drawJob}/cancel`, {});
    job = await s.waitJob(seeded, drawJob, 8000);
    assert.strictEqual(job.status, 'cancelled', `${states(job)} ${JSON.stringify(job.error)}`);
    assert.ok(Date.now() - killAt < 6000, 'cancel stops the drawing process instead of waiting for it');
    assert.deepStrictEqual(ws.listRenders(root, 'PG_001_003'), [], 'a cancelled drawing leaves no render');
    const leftovers = fs.readdirSync(path.join(ws.pageDir(root, 'PG_001_003'), 'renders')).filter((n) => n.startsWith('.codex-'));
    assert.deepStrictEqual(leftovers, [], 'the provider removes its temporary files');

    // --- a page that keeps failing is left flagged at the repair limit ------------------------------------
    job = await s.runOp(seeded, 'pages.plan', { text: 'FLAGALWAYS nothing fixes this page.', pages: 1 });
    assert.strictEqual(job.status, 'done', states(job));
    job = await s.runOp(seeded, 'pages.generate', { pages: ['PG_001_004'], approve_plans: true }, 60000);
    assert.strictEqual(job.status, 'done', `${states(job)} ${JSON.stringify(job.error)}`);
    const stuck = job.result.pages[0];
    assert.deepStrictEqual([stuck.render, stuck.verdict, stuck.flagged, stuck.repairs], ['PG_001_004_V03', 'flagged', true, 2]);
    assert.ok(/repair limit of 2/.test(stuck.stopped));
    assert.deepStrictEqual([stuck.stopped_code, stuck.stopped_params], ['stopped.limit', { limit: 2 }]);
    assert.deepStrictEqual(ws.listRenders(root, 'PG_001_004'), ['PG_001_004_V01', 'PG_001_004_V02', 'PG_001_004_V03'],
      'every version stays on disk');
    assert.deepStrictEqual(['V01', 'V02', 'V03'].map((v) => ws.loadReview(root, `PG_001_004_${v}`).repair_cycle), [0, 1, 2]);
    assert.strictEqual(ws.loadPage(root, 'PG_001_004').status, 'rendered', 'a flagged page is not marked reviewed');
    r = await s.api('GET', `${Q}/pages/PG_001_004`);
    assert.strictEqual(r.body.renders[2].review.open_findings, 1);
    assert.ok(r.body.renders[2].review.findings[0].visible.length > 0, 'the flagged page keeps its evidence');
    // The studio's own limit can stop earlier, never later.
    r = await s.api('PUT', `${Q}/settings`, { repair_limit: 0 });
    assert.strictEqual(r.status, 200);
    job = await s.runOp(seeded, 'pages.plan', { text: 'FLAG fixable, but no automatic repair is allowed.', pages: 1 });
    job = await s.runOp(seeded, 'pages.generate', { pages: ['PG_001_005'], approve_plans: true }, 60000);
    assert.deepStrictEqual([job.result.pages[0].render, job.result.pages[0].repairs, job.result.pages[0].flagged], ['PG_001_005_V01', 0, true]);
    r = await s.api('PUT', `${Q}/settings`, { repair_limit: null });
    // A review that says the cause is upstream is not repaired.
    job = await s.runOp(seeded, 'pages.plan', { text: 'FLAG UPSTREAM the plan itself is wrong.', pages: 1 });
    job = await s.runOp(seeded, 'pages.generate', { pages: ['PG_001_006'], approve_plans: true }, 60000);
    assert.deepStrictEqual([job.result.pages[0].repairs, job.result.pages[0].flagged], [0, true]);
    assert.strictEqual(job.result.pages[0].stopped_code, 'stopped.upstream');
    assert.ok(/plan or in the references/.test(job.result.pages[0].stopped));

    // A flagged page: approval needs an explicit overrule, and publishing is a draft.
    r = await s.api('POST', `${Q}/approve/page`, { page: 'PG_001_005' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error.code, 'review_flagged');
    assert.strictEqual(r.body.error.details.findings.length, 1);
    r = await s.api('POST', `${Q}/approve/page`, { page: 'PG_001_005', overrule: true, note: 'It is fine as drawn.' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.verdict, r.body.overruled], ['fixed', true]);
    const overruled = ws.loadReview(root, 'PG_001_005_V01');
    assert.deepStrictEqual([overruled.findings[0].status, overruled.findings[0].severity], ['accepted', 'minor']);
    // The overrule is data: a tag in the review's notes (the one free field of the schema), read back by the API.
    assert.ok(/\[overruled \d{4}-\d{2}-\d{2}: F01!, gate narrative_continuity; note: "It is fine as drawn\."\] Accepted by the person/.test(overruled.notes), overruled.notes);
    assert.deepStrictEqual(S.validateWorkspace(root).errors.filter((e) => /PG_001_005/.test(JSON.stringify(e))), [], 'the review file still fits its schema');
    r = await s.api('GET', `${Q}/pages/PG_001_005`);
    const overruledView = r.body.renders[0].review;
    assert.deepStrictEqual(
      [overruledView.overruled, /^\d{4}-\d{2}-\d{2}$/.test(overruledView.overruled_at), overruledView.overrule_note, overruledView.overruled_items],
      [true, true, 'It is fine as drawn.', ['F01!', 'gate narrative_continuity']]);
    assert.deepStrictEqual([overruledView.open_notes, overruledView.accepted_notes], [0, 1]);
    assert.strictEqual(r.body.renders[1], undefined);
    r = await s.api('GET', `${Q}/issues/ISS_001`);
    const summary = r.body.pages.find((p) => p.id === 'PG_001_005');
    assert.deepStrictEqual(
      [summary.overruled, summary.overruled_at, summary.overrule_note, summary.open_notes, summary.accepted_notes],
      [true, overruledView.overruled_at, 'It is fine as drawn.', 0, 1]);
    const plain = r.body.pages.find((p) => p.id === 'PG_001_004');
    assert.deepStrictEqual([plain.overruled, plain.overruled_at, plain.overrule_note], [false, null, null]);
    assert.strictEqual(overruled.checks.identity.result, 'fail', 'the reviewer\'s evidence stays');

    r = await s.api('GET', `${Q}/issues/ISS_001/publish`);
    assert.strictEqual(r.body.readiness.final_possible, false);
    assert.ok(r.body.readiness.blockers.some((b) => b.page === 'PG_001_004' && b.code === 'not_passing'));
    assert.ok(r.body.readiness.blockers.some((b) => b.page === 'PG_001_001' && b.code === 'no_render'));
    job = await s.runOp(seeded, 'publish.build', { formats: ['cbz'], mode: 'final' });
    assert.strictEqual(job.status, 'failed');
    assert.strictEqual(job.error.code, 'not_ready');
    assert.ok(job.error.details.blockers.length >= 2);

    // --- cover.create: writes the cover, or draws the one that is already written -----------------------
    job = await s.runOp(seeded, 'cover.create', {});
    assert.strictEqual(job.status, 'done', `${states(job)} ${JSON.stringify(job.error)}`);
    assert.deepStrictEqual(job.steps.map((x) => x.id), ['write', 'compile', 'draw', 'review'], 'no cover yet and no description: the AI proposes one');
    assert.deepStrictEqual([job.result.written, job.result.render, job.result.verdict], [true, 'CV_001_V01', 'pass']);
    const coverFile = path.join(root, 'issues', 'ISS_001', 'cover', 'cover.yaml');
    // The person edits the cover by hand. With no description the job draws it as written: no write step.
    const byHand = `${fs.readFileSync(coverFile, 'utf8')}# edited by hand\n`;
    fs.writeFileSync(coverFile, byHand);
    job = await s.runOp(seeded, 'cover.create', {});
    assert.strictEqual(job.status, 'done', `${states(job)} ${JSON.stringify(job.error)}`);
    assert.deepStrictEqual(job.steps.map((x) => x.id), ['compile', 'draw', 'review'], 'a cover that exists is drawn as written');
    assert.deepStrictEqual([job.result.written, job.result.summary, job.result.render, job.result.drawn], [false, null, 'CV_001_V02', true]);
    assert.strictEqual(fs.readFileSync(coverFile, 'utf8'), byHand, 'the AI did not touch the cover file');
    assert.strictEqual(job.steps.some((x) => x.tool === 'claude' && x.id !== 'review'), false, 'no planning tool ran');
    r = await s.api('POST', `${Q}/ops`, { op: 'cover.create', params: { draw: false } });
    assert.deepStrictEqual([r.status, r.body.error.code], [409, 'nothing_to_do'], 'written already and not to be drawn: nothing to do');
    // With a description the cover is rewritten, then drawn.
    job = await s.runOp(seeded, 'cover.create', { description: 'FLAGALWAYS Mara at the wheel, at night.' }, 60000);
    assert.strictEqual(job.status, 'done', `${states(job)} ${JSON.stringify(job.error)}`);
    assert.deepStrictEqual(job.steps.slice(0, 4).map((x) => x.id), ['write', 'compile', 'draw', 'review']);
    assert.strictEqual(job.result.written, true);
    assert.notStrictEqual(fs.readFileSync(coverFile, 'utf8'), byHand, 'a description rewrites the cover');
    assert.deepStrictEqual([job.result.flagged, job.result.stopped_code], [true, 'stopped.limit']);
    // The cover summary carries the same review data as a page summary, the overrule included.
    r = await s.api('GET', `${Q}/issues/ISS_001/cover`);
    assert.deepStrictEqual([r.body.outcome, r.body.overruled, r.body.overruled_at, r.body.overrule_note, r.body.open_notes, r.body.accepted_notes],
      ['flagged', false, null, null, 0, 0]);
    r = await s.api('POST', `${Q}/approve/cover`, { issue: 'ISS_001' });
    assert.deepStrictEqual([r.status, r.body.error.code], [409, 'review_flagged']);
    r = await s.api('POST', `${Q}/approve/cover`, { issue: 'ISS_001', overrule: true, note: 'Good enough for a draft.' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await s.api('GET', `${Q}/issues/ISS_001/cover`);
    assert.deepStrictEqual([r.body.outcome, r.body.overruled, /^\d{4}-\d{2}-\d{2}$/.test(r.body.overruled_at), r.body.overrule_note, r.body.open_notes, r.body.accepted_notes],
      ['pass', true, true, 'Good enough for a draft.', 0, 1]);
    const coverReviewView = r.body.renders[r.body.renders.length - 1].review;
    assert.deepStrictEqual([coverReviewView.overruled, coverReviewView.overrule_note, coverReviewView.overruled_items.length > 0], [true, 'Good enough for a draft.', true]);
    r = await s.api('GET', Q);
    assert.deepStrictEqual([r.body.issues[0].cover.overruled, r.body.issues[0].cover.overrule_note], [true, 'Good enough for a draft.']);

    // --- stale jobs are marked failed when a server starts -------------------------------------------------
    const jobsDir = path.join(home, seeded, '.studio', 'jobs');
    const template = JSON.parse(fs.readFileSync(path.join(jobsDir, fs.readdirSync(jobsDir).find((n) => n.endsWith('.json'))), 'utf8'));
    const stale = (suffix, status) => Object.assign({}, template, {
      id: `job_299901010000000000${suffix}_dead`, status, ended_at: null, error: null, result: null,
      steps: [{ id: 'a', label: 'A', status: 'done' }, { id: 'b', label: 'B', status: status === 'running' ? 'running' : 'pending' }],
    });
    fs.writeFileSync(path.join(jobsDir, 'job_2999010100000000001_dead.json'), JSON.stringify(stale('1', 'running')));
    fs.writeFileSync(path.join(jobsDir, 'job_2999010100000000002_dead.json'), JSON.stringify(stale('2', 'queued')));
    fs.writeFileSync(path.join(jobsDir, 'job_2999010100000000003_dead.json'), JSON.stringify(stale('3', 'needs_decision')));
  } finally {
    await s.close({ keep: true });
  }

  const again = await start({ home });
  try {
    const seeded = 'drawing-jobs';
    let r = await again.api('GET', `/api/projects/${seeded}/jobs?limit=5`);
    assert.strictEqual(r.status, 200);
    const byId = Object.fromEntries(r.body.jobs.map((j) => [j.id, j]));
    const running = byId.job_2999010100000000001_dead;
    assert.strictEqual(running.status, 'failed');
    assert.strictEqual(running.error.code, 'interrupted');
    assert.ok(running.ended_at);
    assert.deepStrictEqual(running.steps.map((x) => x.status), ['done', 'failed']);
    assert.strictEqual(byId.job_2999010100000000002_dead.status, 'failed');
    assert.strictEqual(byId.job_2999010100000000002_dead.error.code, 'interrupted');
    assert.strictEqual(byId.job_2999010100000000003_dead.status, 'needs_decision', 'a job waiting for an answer survives a restart');
    const onDisk = JSON.parse(fs.readFileSync(path.join(home, seeded, '.studio', 'jobs', 'job_2999010100000000001_dead.json'), 'utf8'));
    assert.strictEqual(onDisk.status, 'failed', 'the recovery is written to disk');
    assert.strictEqual(r.body.running, null);
    // The queue works after a recovery.
    const job = await again.runOp(seeded, 'story.update', { instruction: 'One more fact.' });
    assert.strictEqual(job.status, 'done');
  } finally {
    await again.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
  console.log('studio-jobs: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
