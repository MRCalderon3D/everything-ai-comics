'use strict';
/**
 * Studio: "Guide me" mode, in fake mode.
 *
 * 1. A whole comic made only by answering the guide: a project created with
 *    "guide": true and a title, then every step either a click on one of
 *    the guide's choices or an answer typed in words. Nobody sends "next":
 *    after each job or decision the guide's next message arrives by itself.
 * 2. A job result brings the next guide message with no message from the
 *    person in between.
 * 3. Detours: a question gets an answer and the step stays; an approval made
 *    on a screen moves the guide on; leaving the mode keeps everything and
 *    turning it on again picks up from the state.
 */

const assert = require('assert');
const path = require('path');
const { start } = require('../studio/test-support/harness');
const ws = require('../scripts/lib/workspace');
const { validateWorkspace } = require('../scripts/validate-workspace');

function guideTools(s, id) {
  const P = `/api/projects/${id}`;
  const conv = async () => (await s.api('GET', `${P}/conversation`)).body.conversation;
  /** Wait until no job runs and the guide shows a step that differs from `sig`. */
  async function nextStep(sig, label) {
    for (let i = 0; i < 4000; i++) {
      const jobs = (await s.api('GET', `${P}/jobs?active=1`)).body.jobs.filter((j) => ['queued', 'running'].includes(j.status));
      if (!jobs.length) {
        const c = await conv();
        if (c.guide.on && c.guide.step && c.guide.step.sig !== sig) return c;
      }
      await new Promise((ok) => setTimeout(ok, 15));
    }
    throw new Error(`the guide did not move on from ${sig} (${label})`);
  }
  async function choose(c, choiceId) {
    const step = c.guide.step;
    assert.ok(step.choices.some((x) => x.id === choiceId), `${step.key}: no choice ${choiceId} in ${step.choices.map((x) => x.id).join(', ')}`);
    const res = await s.api('POST', `${P}/conversation/guide/choose`, { step: step.sig, choice: choiceId, screen: { key: 'story' } });
    assert.strictEqual(res.status, 200, `${step.key} ${choiceId}: ${JSON.stringify(res.body)}`);
    return res.body;
  }
  async function answer(text, screen = { key: 'story' }) {
    const res = await s.api('POST', `${P}/conversation`, { text, screen });
    assert.strictEqual(res.status, 202, JSON.stringify(res.body));
    const job = await s.waitJob(id, res.body.job.id);
    assert.strictEqual(job.status, 'done', JSON.stringify(job.error));
    return job;
  }
  return { P, conv, nextStep, choose, answer };
}

async function wholeComic(s) {
  const created = await s.api('POST', '/api/projects', { title: 'Guided Ferry', guide: true, pages: 2 });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  assert.strictEqual(created.body.guide, true);
  const id = created.body.project.id;
  const root = path.join(s.home, id, 'production');
  const g = guideTools(s, id);

  let c = await g.conv();
  assert.strictEqual(c.guide.on, true, 'the conversation starts in guide mode');
  assert.strictEqual(c.guide.step.key, 'story.tell');
  const first = c.messages.find((m) => m.guide);
  assert.ok(first && /guide you/.test(first.guide.lines[0]), 'the first message says what the guide does');

  const answers = [];
  const seen = [];
  for (let turn = 0; turn < 40; turn++) {
    const step = c.guide.step;
    seen.push(step.key);
    if (step.key === 'done') break;
    const sig = step.sig;
    switch (step.key) {
      case 'story.tell':
        answers.push('story');
        await g.answer('Mara, a ferry pilot, finds a stowaway boy in the hold and hides him from the night patrol.');
        break;
      case 'style.choose':
        assert.ok(step.presets.length >= 6, 'the style gallery comes as a pickable list');
        assert.ok(step.presets.some((p) => p.key === 'ligne-claire' && p.preview && /\/api\/presets\/ligne-claire\/preview/.test(p.preview.url)), 'presets carry their sample image');
        answers.push('style');
        await g.choose(c, 'preset-ligne-claire');
        break;
      case 'style.look':
      case 'pages.draw':
      case 'cover':
        answers.push(step.key);
        await g.choose(c, 'draw');
        break;
      case 'style.approve':
      case 'characters.approve':
      case 'pages.approve_plan':
      case 'pages.review':
      case 'cover.approve':
        assert.ok(step.key === 'pages.approve_plan' || step.images.length === 1, `${step.key} shows the image to approve`);
        answers.push(step.key);
        await g.choose(c, 'approve');
        break;
      case 'characters.add':
        answers.push('character');
        await g.answer('Mara: a ferry pilot in her fifties, grey braid, yellow raincoat.', { key: 'characters' });
        break;
      case 'pages.plan':
        answers.push('plan');
        await g.choose(c, 'pages-2');
        break;
      case 'publish':
        answers.push('publish');
        await g.choose(c, 'pdf');
        break;
      default:
        throw new Error(`unexpected guide step ${step.key}: ${JSON.stringify(step)}`);
    }
    c = await g.nextStep(sig, step.key);
  }
  assert.strictEqual(c.guide.step.key, 'done', `the guide reached the end: ${seen.join(' > ')}`);
  for (const key of ['story.tell', 'style.choose', 'style.look', 'style.approve', 'characters.add', 'characters.approve', 'pages.plan', 'pages.approve_plan', 'pages.draw', 'pages.review', 'cover', 'cover.approve', 'publish', 'done']) {
    assert.ok(seen.includes(key), `the guide went through ${key}: ${seen.join(' > ')}`);
  }
  assert.strictEqual(seen.filter((k) => k === 'pages.review').length, 2, 'each page is shown for approval');

  // Only answers came from the person: no "next", nothing else.
  const userMessages = c.messages.filter((m) => m.role === 'user');
  assert.strictEqual(userMessages.length, answers.length, `${userMessages.map((m) => m.text).join(' | ')}`);
  // Every term explained once.
  const explained = c.messages.filter((m) => m.guide && m.guide.terms_explained).flatMap((m) => m.guide.terms_explained);
  assert.deepStrictEqual([...new Set(explained)].length, explained.length, 'a term is explained only once');
  assert.ok(['look', 'sheet', 'plan', 'check'].every((term) => explained.includes(term)), explained.join(','));

  // The comic: a published edition, every page approved, every job from a card.
  const editions = ws.listEditions(root);
  assert.strictEqual(editions.length, 1);
  const edition = ws.loadEdition(root, editions[0]);
  assert.deepStrictEqual([edition.pages.length, !!edition.cover], [2, true]);
  for (const p of ws.listPageIds(root, 'ISS_001')) assert.strictEqual(ws.loadPage(root, p).status, 'approved');
  const r = await s.api('GET', `${g.P}/jobs?limit=200`);
  const work = r.body.jobs.filter((j) => j.op !== 'chat.turn');
  assert.deepStrictEqual(work.filter((j) => !j.origin).map((j) => j.op), [], 'every job was started from a card');
  assert.deepStrictEqual(validateWorkspace(root).errors, []);
  return id;
}

async function resultBringsNextMessage(s) {
  const created = await s.api('POST', '/api/projects', { title: 'Guide Result', description: 'A lighthouse keeper finds a bottle.', pages: 1 });
  const id = created.body.project.id;
  const g = guideTools(s, id);
  let r = await s.api('POST', `${g.P}/conversation/guide`, { on: true });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.conversation.guide.step.key, 'style.choose', 'with a description, the story step is done');
  let c = r.body.conversation;
  await g.choose(c, 'preset-noir-ink');
  c = await g.nextStep(c.guide.step.sig, 'style.choose');
  assert.strictEqual(c.guide.step.key, 'style.look');
  const before = c.messages.length;
  await g.choose(c, 'draw');
  c = await g.nextStep(c.guide.step.sig, 'style.look');
  assert.strictEqual(c.guide.step.key, 'style.approve');
  const after = c.messages.slice(before);
  // The click, the guide's "starting now", the job's result, the guide's next question: no user message after the click.
  const users = after.filter((m) => m.role === 'user');
  assert.strictEqual(users.length, 1, 'only the click is the person\'s');
  const resultAt = after.findIndex((m) => m.event === 'action_result');
  const nextAt = after.findIndex((m) => m.guide && m.guide.key === 'style.approve');
  assert.ok(resultAt !== -1 && nextAt > resultAt, `the result, then the next question: ${after.map((m) => m.event || (m.guide && m.guide.key) || m.role).join(', ')}`);
  assert.ok(after.slice(after.indexOf(users[0]) + 1).every((m) => m.role !== 'user'));
  assert.ok(after[nextAt].guide.images.length === 1, 'the next question shows the look page');
  assert.ok(after.some((m) => m.guide && m.guide.key === 'started' && /about \d+ min/.test(m.guide.lines[0])), 'drawing says how long it takes');

  // A stale choice is refused with the step it is at now.
  r = await s.api('POST', `${g.P}/conversation/guide/choose`, { step: 'style.look:draw', choice: 'draw' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error.code, 'guide_moved');
  assert.strictEqual(r.body.error.details.step.key, 'style.approve');

  // A detour: a question gets an answer, the step stays, and no second guide message repeats it.
  const count = c.messages.filter((m) => m.guide && m.guide.key === 'style.approve').length;
  const turn = await g.answer('What is a look page?', { key: 'style' });
  c = await g.conv();
  assert.strictEqual(c.guide.step.key, 'style.approve');
  const reply = c.messages.find((m) => m.role === 'assistant' && m.job === turn.id);
  assert.ok(/still at the step "style\.approve"/.test(reply.text), reply.text);
  assert.strictEqual(c.messages.filter((m) => m.guide && m.guide.key === 'style.approve').length, count);

  // A screen change: the look approved on the Style screen, and the guide goes on by itself.
  const candidate = c.guide.step.choices[0];
  assert.strictEqual(candidate.id, 'approve');
  const look = (await s.api('GET', `${g.P}/style`)).body.look.candidates.filter((x) => !x.promoted_to).pop();
  r = await s.api('POST', `${g.P}/approve/asset`, { candidate: look.id });
  assert.strictEqual(r.status, 200);
  c = await g.conv();
  assert.strictEqual(c.guide.step.key, 'characters.add');
  assert.ok(c.messages[c.messages.length - 1].guide && c.messages[c.messages.length - 1].guide.key === 'characters.add', 'the guide posted the next step after the screen approval');

  // Leaving keeps everything; turning it on again picks up from the state.
  r = await s.api('POST', `${g.P}/conversation/guide`, { on: false });
  assert.strictEqual(r.body.conversation.guide.on, false);
  const style = (await s.api('GET', `${g.P}/style`)).body;
  assert.strictEqual(style.look.frozen, true, 'what was made stays');
  r = await s.api('POST', `${g.P}/conversation/guide`, { on: true });
  assert.strictEqual(r.body.conversation.guide.step.key, 'characters.add');
  assert.ok(!r.body.message.guide.terms_explained.includes('look'), 'a term explained before is not explained again');

  // A new conversation keeps the mode.
  r = await s.api('POST', `${g.P}/conversation/new`, {});
  assert.strictEqual(r.body.conversation.guide.on, true);
  assert.ok(r.body.conversation.messages.some((m) => m.guide && m.guide.key === 'characters.add'));
}

async function main() {
  const started = Date.now();
  const s = await start();
  try {
    await resultBringsNextMessage(s);
    await wholeComic(s);
  } finally {
    await s.close();
  }
  console.log(`studio-guide: ok (${Date.now() - started} ms)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
