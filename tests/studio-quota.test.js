'use strict';
/**
 * Studio: a drawing or writing tool that runs out of its usage quota, in
 * fake mode. The fake codex answers the way Codex did in a real run while
 * STUDIO_FAKE_QUOTA_FILE exists (a number in it lets that many drawings
 * through first); the fake writing tool answers with Claude Code's wording
 * for the word QUOTAAI.
 *
 * - pages.generate stops at the page that met the quota: the job pauses
 *   (not failed), the pages after it are not tried, the jobs queued behind
 *   it that need the same tool pause untouched, and the others run.
 * - Resuming goes on where it stopped: what was drawn is not drawn again,
 *   and no attempt counts toward a repair or touch-up limit.
 * - A card's job that pauses says so in the conversation, in plain words,
 *   with the reset time and what waits; job.resume picks it up.
 * - A correction that meets the quota keeps its one change request and its
 *   touch-up count.
 * - Batch drawing says how many images it will draw.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../studio/test-support/harness');
const ws = require('../scripts/lib/workspace');
const { validateWorkspace } = require('../scripts/validate-workspace');

const QUOTA = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-quota-')), '.fake-quota');
process.env.STUDIO_FAKE_QUOTA_FILE = QUOTA;
const runOut = (allow = 0) => fs.writeFileSync(QUOTA, String(allow));
const comeBack = () => fs.rmSync(QUOTA, { force: true });

async function waitStatus(s, id, jobId, statuses, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = (await s.api('GET', `/api/projects/${id}/jobs/${jobId}`)).body.job;
    if (statuses.includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`${jobId} stayed ${job.status}`);
    await new Promise((ok) => setTimeout(ok, 15));
  }
}

function records(root, scope) {
  const dir = path.join(root, 'generations', scope);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^GEN_.+\.yaml$/.test(n)).map((n) => ws.loadYaml(path.join(dir, n)));
}

async function pagesStopAndResume(s) {
  const id = await s.seedProject('Quota Pages', { pages: 3 });
  const root = path.join(s.home, id, 'production');
  const P = `/api/projects/${id}`;
  const plan = await s.runOp(id, 'pages.plan', { text: 'Mara wakes. Mara walks the deck. Mara finds the boy.', pages: 3 });
  assert.strictEqual(plan.status, 'done');
  const pages = ws.listPageIds(root, 'ISS_001');
  let r = await s.api('POST', `${P}/approve/plan`, { pages });
  assert.strictEqual(r.status, 200);

  // One drawing left, then the quota is out: page 1 is drawn, page 2 meets it.
  runOut(1);
  const draw = (await s.api('POST', `${P}/ops`, { op: 'pages.generate', params: { issue: 'ISS_001', regenerate: false } })).body.job;
  // Queued behind it: a sheet (needs the drawing tool) and a story suggestion (needs only the writing tool).
  const sheet = (await s.api('POST', `${P}/ops`, { op: 'character.sheet', params: { character: 'CHAR_MARA', sheet: 'expressions' } })).body.job;
  const words = (await s.api('POST', `${P}/ops`, { op: 'story.suggest', params: { instruction: 'suggest a title' } })).body.job;

  const paused = await waitStatus(s, id, draw.id, ['paused', 'done', 'failed']);
  assert.strictEqual(paused.status, 'paused', JSON.stringify(paused.error));
  assert.strictEqual(paused.error.code, 'tool_quota');
  assert.deepStrictEqual([paused.paused.reason, paused.paused.tool, paused.paused.resets], ['tool_quota', 'codex', '6:40 PM']);
  assert.ok(/Codex ran out of its usage quota and says the limit resets: 6:40 PM/.test(paused.error.message), paused.error.message);
  const stepOf = (stepId) => paused.steps.find((x) => x.id === stepId);
  assert.strictEqual(stepOf(`${pages[0]}:review`).status, 'done', 'page 1 was drawn and checked');
  assert.strictEqual(stepOf(`${pages[1]}:draw`).status, 'paused', 'page 2 met the quota');
  assert.strictEqual(stepOf(`${pages[2]}:prepare`).status, 'pending', 'page 3 was not tried');
  assert.strictEqual(records(root, pages[2]).length, 0, 'no attempt at page 3');
  const failedRecord = records(root, pages[1]).find((rec) => rec.status === 'failed');
  assert.deepStrictEqual([failedRecord.response.error_kind, failedRecord.response.resets], ['tool_quota', '6:40 PM']);

  const sheetNow = await waitStatus(s, id, sheet.id, ['paused', 'done', 'failed']);
  assert.strictEqual(sheetNow.status, 'paused', 'the queued sheet pauses without starting');
  assert.deepStrictEqual([sheetNow.paused.tool, sheetNow.paused.by, sheetNow.started_at], ['codex', draw.id, null]);
  const wordsNow = await waitStatus(s, id, words.id, ['done', 'failed', 'paused']);
  assert.strictEqual(wordsNow.status, 'done', 'work that does not need the drawing tool goes on');

  // The project home and the chat's state say it.
  r = await s.api('GET', P);
  assert.ok(r.body.active_jobs.some((j) => j.id === draw.id && j.status === 'paused'), 'a paused job is listed as active');

  // The quota comes back; one click resumes the job and the sheet behind it.
  comeBack();
  r = await s.api('POST', `${P}/jobs/${draw.id}/resume`, {});
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.resumed.map((j) => j.id), [draw.id, sheet.id]);
  const done = await waitStatus(s, id, draw.id, ['done', 'failed', 'paused']);
  assert.strictEqual(done.status, 'done', JSON.stringify(done.error));
  assert.strictEqual((await waitStatus(s, id, sheet.id, ['done', 'failed', 'paused'])).status, 'done');
  for (const p of pages) assert.deepStrictEqual(ws.listRenders(root, p), [`${p}_V01`], `${p} drawn once`);
  assert.strictEqual(records(root, pages[0]).filter((rec) => rec.status !== 'failed').length, 1, 'page 1 was not drawn again');
  for (const p of pages) assert.strictEqual(ws.loadReview(root, `${p}_V01`).repair_cycle, 0, 'no attempt counted as a repair');
  r = await s.api('POST', `${P}/jobs/${draw.id}/resume`, {});
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error.code, 'job_not_paused');
  assert.deepStrictEqual(validateWorkspace(root).errors, []);
  return id;
}

async function chatCardAndCorrection(s, id) {
  const root = path.join(s.home, id, 'production');
  const P = `/api/projects/${id}`;
  const say = async (text, screen = { key: 'pages:ISS_001' }) => {
    const res = await s.api('POST', `${P}/conversation`, { text, screen });
    assert.strictEqual(res.status, 202, JSON.stringify(res.body));
    return s.waitJob(id, res.body.job.id);
  };
  const conv = async () => (await s.api('GET', `${P}/conversation`)).body.conversation;

  // A correction from a card meets the quota: the card and a plain message say so.
  const render = ws.loadPage(root, 'PG_001_001').current_render;
  const before = ws.loadReview(root, render);
  runOut(0);
  await say('Fix the sky. DO:page.correct {"page":"PG_001_001","text":"Make the sky darker."}', { key: 'page:PG_001_001' });
  let c;
  let result;
  for (let i = 0; i < 2000 && !result; i++) {
    c = await conv();
    result = c.messages.find((m) => m.event === 'action_result' && m.status === 'paused');
    if (!result) await new Promise((ok) => setTimeout(ok, 15));
  }
  assert.ok(result, 'the paused job reports in the conversation');
  assert.strictEqual(result.quota.tool, 'codex');
  assert.strictEqual(result.quota.resets, '6:40 PM');
  assert.ok(/Codex ran out of its usage quota\. Nothing is wrong with the work/.test(result.quota.lines[0]), result.quota.lines[0]);
  assert.ok(/resets: 6:40 PM/.test(result.quota.lines[1]));
  const card = c.messages.flatMap((m) => m.actions || []).find((x) => x.action === 'page.correct');
  assert.strictEqual(card.status, 'paused');
  const mid = ws.loadReview(root, render);
  assert.strictEqual(mid.repair_cycle, before.repair_cycle, 'the failed attempt does not count as a touch-up');
  const requests = (review) => review.findings.filter((f) => f.source === 'user_request').length;
  assert.strictEqual(requests(mid), requests(before) + 1, 'the change request is recorded once');

  // The chat knows, and resumes when asked.
  let turn = await say('STATE NOGUIDE what happened?');
  c = await conv();
  let reply = c.messages.find((m) => m.role === 'assistant' && m.job === turn.id);
  assert.ok(/Paused because a tool ran out of its usage quota/.test(reply.text) && /page\.correct/.test(reply.text), reply.text);
  comeBack();
  turn = await say(`Resume it. DO:job.resume {"job":"${result.job}"}`);
  const resumed = await waitStatus(s, id, result.job, ['done', 'failed', 'paused']);
  assert.strictEqual(resumed.status, 'done', JSON.stringify(resumed.error));
  const after = ws.loadReview(root, render);
  assert.strictEqual(requests(after), requests(before) + 1, 'resuming does not record the request again');
  const next = ws.loadPage(root, 'PG_001_001').current_render;
  assert.notStrictEqual(next, render);
  assert.strictEqual(ws.loadReview(root, next).repair_cycle, (before.repair_cycle || 0) + 1, 'only the edit that was drawn counts');
  c = await conv();
  assert.strictEqual(c.messages.flatMap((m) => m.actions || []).find((x) => x.id === card.id).status, 'done');

  // Batch drawing says how many images it will draw.
  await say('ACTION:pages.generate {"issue":"ISS_001","regenerate":true}');
  c = await conv();
  const batch = c.messages.flatMap((m) => m.actions || []).filter((x) => x.action === 'pages.generate').pop();
  assert.strictEqual(batch.images, 3);
}

async function writingToolQuota(s) {
  const created = await s.api('POST', '/api/projects', { title: 'Quota Words', description: 'A short story.', pages: 1 });
  const id = created.body.project.id;
  const job = await s.runOp(id, 'story.suggest', { instruction: 'QUOTAAI suggest an ending' });
  assert.strictEqual(job.status, 'paused');
  assert.strictEqual(job.paused.tool, 'claude');
  assert.strictEqual(job.paused.resets, new Date(1764264000 * 1000).toISOString());
  assert.ok(/Claude Code ran out of its usage quota/.test(job.error.message), job.error.message);
  // Cancelling a paused job works as for any waiting job.
  const r = await s.api('POST', `/api/projects/${id}/jobs/${job.id}/cancel`, {});
  assert.strictEqual(r.body.job.status, 'cancelled');
}

async function main() {
  const started = Date.now();
  comeBack();
  const s = await start();
  try {
    const id = await pagesStopAndResume(s);
    await chatCardAndCorrection(s, id);
    await writingToolQuota(s);
  } finally {
    comeBack();
    await s.close();
  }
  console.log(`studio-quota: ok (${Date.now() - started} ms)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
