'use strict';
/**
 * Studio: a whole comic made two ways, end to end, in fake mode.
 *
 * 1. Only through the conversation. After the project is created with the
 *    new-project form (a title and nothing else), every step goes through
 *    the conversation endpoints: a message, the cards it proposes, a click
 *    on Run or a confirmation in words, and the answer to a job's question.
 *    Story, style and look, a character from an attached photo and its
 *    sheet, places, pages planned, approved and drawn, a correction of the
 *    lettering, the cover, and a final edition.
 * 2. Hybrid. Some steps on the screens' routes, some in a fresh
 *    conversation. The conversation's state block reflects what the screens
 *    did, and the screens show what the conversation did.
 */

const assert = require('assert');
const path = require('path');
const { start } = require('../studio/test-support/harness');
const png = require('../scripts/lib/png');
const ws = require('../scripts/lib/workspace');
const { validateWorkspace } = require('../scripts/validate-workspace');

function done(job, label) {
  assert.strictEqual(job.status, 'done', `${label}: ${job.status} ${JSON.stringify(job.error)}`);
  return job;
}

function talker(s, id) {
  const P = `/api/projects/${id}`;
  const conv = async () => (await s.api('GET', `${P}/conversation`)).body.conversation;
  /** Send a message; the reply and the cards it proposed. */
  async function say(text, { screen = { key: 'story' }, attachments } = {}) {
    const res = await s.api('POST', `${P}/conversation`, { text, screen, attachments });
    assert.strictEqual(res.status, 202, `${text}: ${JSON.stringify(res.body)}`);
    const job = done(await s.waitJob(id, res.body.job.id), `turn "${text.slice(0, 40)}"`);
    const c = await conv();
    const reply = c.messages.find((m) => m.role === 'assistant' && m.job === job.id);
    assert.ok(reply, 'the reply is in the conversation');
    assert.deepStrictEqual(reply.dropped, [], `${text}: ${JSON.stringify(reply.dropped)}`);
    return { job, reply, cards: reply.actions };
  }
  /** Wait until the card's job (if any) settles; the card as it is now, and its result message. */
  async function settle(card) {
    for (let i = 0; i < 3000; i++) {
      const c = await conv();
      const msgWith = c.messages.find((m) => Array.isArray(m.actions) && m.actions.some((x) => x.id === card.id));
      const now = msgWith.actions.find((x) => x.id === card.id);
      if (!['pending', 'started', 'running'].includes(now.status)) {
        const result = c.messages.filter((m) => m.event === 'action_result' && m.card === card.id).pop() || null;
        return { card: now, result };
      }
      await new Promise((ok) => setTimeout(ok, 15));
    }
    throw new Error(`card ${card.id} did not settle`);
  }
  /** Click Run on a card and wait for it. */
  async function run(card, expect = 'done') {
    const res = await s.api('POST', `${P}/conversation/${card.conversation}/actions/${card.id}/run`, {});
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const out = await settle(card);
    assert.strictEqual(out.card.status, expect, `${card.action}: ${out.card.status} ${JSON.stringify(out.card.error)}`);
    return out;
  }
  /** Ask for one action and run it on a click. */
  async function ask(text, options) {
    const { cards } = await say(text, options);
    assert.strictEqual(cards.length, 1, `${text}: ${cards.length} cards`);
    return run(cards[0]);
  }
  return { P, conv, say, settle, run, ask };
}

async function chatOnly(s) {
  // The new-project form: a title and nothing else.
  const created = await s.api('POST', '/api/projects', { title: 'Only Words' });
  assert.strictEqual(created.status, 201);
  const id = created.body.project.id;
  const root = path.join(s.home, id, 'production');
  const c = talker(s, id);

  // Story: the person's text goes in through a change they ask for, then a proposal they decide in words.
  await c.ask('This is my story. ACTION:story.update {"instruction":"Mara, a ferry pilot, finds a stowaway boy in the hold and hides him from the patrol."}');
  const suggested = await c.ask('Suggest an ending. ACTION:story.suggest {"instruction":"suggest an ending"}');
  const proposalId = suggested.result.proposals[0].id;
  await c.ask(`Accept all of it. ACTION:proposal.decide {"proposal":"${proposalId}","all":"accept"}`);
  let r = await s.api('GET', `${c.P}/proposals/${proposalId}`);
  assert.strictEqual(r.body.proposal.status, 'closed');

  // Style and look, approved in words.
  await c.ask('Use the clear line style. ACTION:style.define {"preset":"ligne-claire"}', { screen: { key: 'style' } });
  const look = await c.ask('Draw a look page. ACTION:style.look {}', { screen: { key: 'style' } });
  assert.ok(look.result.images.length >= 1, 'the look page comes back as an image');
  const lookCandidate = look.card.result.candidate_id;
  await c.ask(`Approve it. ACTION:approve.asset {"candidate":"${lookCandidate}"}`, { screen: { key: 'style' } });

  // A character from an attached photo; the sheet comes back and is approved.
  const tiny = png.encode({ width: 8, height: 8, data: Buffer.alloc(8 * 8 * 3, 140) });
  const photo = await s.upload(id, 'mara-photo.png', tiny, 'image/png');
  const { cards } = await c.say('Make Mara from this photo in the comic\'s style. ACTION:character.create {"name":"Mara","description":"A ferry pilot in her fifties.","uploads":"@attachments"}',
    { screen: { key: 'characters' }, attachments: [photo.id] });
  assert.strictEqual(cards[0].photo_rights, true, 'the photo-rights notice shows on the card');
  const mara = await c.run(cards[0]);
  assert.ok(mara.result.images.some((img) => /CHAR_MARA_TURN_V01\.png$/.test(img.path)), JSON.stringify(mara.result.images));
  assert.ok(mara.result.links.some((l) => l.key === 'character:CHAR_MARA'));
  await c.ask(`Approve her sheet. ACTION:approve.asset {"candidate":"${mara.card.result.sheet.candidate_id}"}`, { screen: { key: 'character:CHAR_MARA' } });

  // Places, then pages planned with a question the job asks, answered in the chat.
  await c.ask('Write the places. ACTION:entities.derive {"text":"The ferry deck at night."}', { screen: { key: 'places' } });
  const screen = { key: 'pages:ISS_001' };
  const planCard = (await c.say('Plan two pages. ACTION:pages.plan {"text":"DECIDE Mara hears a sound in the hold. She finds the boy.","pages":2}', { screen })).cards[0];
  const paused = await c.run(planCard, 'needs_decision');
  assert.strictEqual(paused.result.questions[0].id, 'q1');
  const answer = await c.say(`The first way. ACTION:job.answer {"job":"${paused.result.job}","answers":{"q1":"The first way"}}`, { screen });
  await c.run(answer.cards[0]);
  const planned = await c.settle(planCard);
  assert.strictEqual(planned.card.status, 'done');
  const pages = ws.listPageIds(root, 'ISS_001');
  assert.deepStrictEqual(pages, ['PG_001_001', 'PG_001_002']);
  await c.ask(`I read them. ACTION:approve.plan {"pages":${JSON.stringify(pages)}}`, { screen });

  // Drawing, confirmed in words.
  const drawCard = (await c.say('ACTION:pages.generate {"issue":"ISS_001"}', { screen })).cards[0];
  const confirmed = await c.say('RUN yes, draw them', { screen });
  assert.deepStrictEqual(confirmed.job.result.ran.map((x) => x.card), [drawCard.id]);
  const drawn = await c.settle(drawCard);
  assert.strictEqual(drawn.card.status, 'done');
  assert.strictEqual(drawn.result.images.filter((img) => /renders\/PG_001_00\d_V01\.png$/.test(img.path)).length, 2);

  // A correction of the lettering, then both pages approved.
  const fixed = await c.ask('Change the caption. ACTION:page.correct {"page":"PG_001_001","text":"The caption should read: Last crossing.","lettering":true}', { screen: { key: 'page:PG_001_001' } });
  assert.ok(fixed.result.images.some((img) => /PG_001_001_V02\.png$/.test(img.path)), 'the corrected version comes back');
  for (const page of pages) await c.ask(`Approve it. ACTION:approve.page {"page":"${page}"}`, { screen: { key: `page:${page}` } });

  // The cover, approved, and a final edition.
  const cover = await c.ask('Draw the cover. ACTION:cover.create {"issue":"ISS_001","description":"Mara at the helm, the boy behind her."}', { screen: { key: 'cover:ISS_001' } });
  assert.ok(cover.result.images.some((img) => /CV_001_V01\.png$/.test(img.path)));
  await c.ask('Approve the cover. ACTION:approve.cover {"issue":"ISS_001"}', { screen: { key: 'cover:ISS_001' } });
  const published = await c.ask('Publish it. ACTION:publish.build {"issue":"ISS_001","formats":["pdf","cbz"]}', { screen: { key: 'publish:ISS_001' } });
  assert.strictEqual(published.card.result.draft, false, JSON.stringify(published.card.result));
  const edition = ws.loadEdition(root, published.card.result.edition);
  assert.deepStrictEqual([edition.pages.length, !!edition.cover], [2, true]);

  // Every job of the project came from the conversation.
  r = await s.api('GET', `${c.P}/jobs?limit=200`);
  const work = r.body.jobs.filter((j) => j.op !== 'chat.turn');
  assert.deepStrictEqual([...new Set(work.map((j) => j.op))].sort(), ['character.create', 'cover.create', 'entities.derive', 'page.correct', 'pages.generate', 'pages.plan', 'publish.build', 'story.suggest', 'story.update', 'style.define', 'style.look']);
  assert.deepStrictEqual(work.filter((j) => !j.origin).map((j) => j.op), [], 'every job was started from a card');
  for (const p of pages) assert.strictEqual(ws.loadPage(root, p).status, 'approved');
  assert.strictEqual(ws.loadCover(root, 'ISS_001').status, 'approved');
  assert.deepStrictEqual(validateWorkspace(root).errors, []);
}

async function hybrid(s) {
  const created = await s.api('POST', '/api/projects', { title: 'Both Ways', description: 'A lighthouse keeper finds a message in a bottle.', pages: 1 });
  const id = created.body.project.id;
  const root = path.join(s.home, id, 'production');
  const P = `/api/projects/${id}`;

  // Screens: the style and its look.
  done(await s.runOp(id, 'style.define', { preset: 'ligne-claire' }), 'style on the screen');
  const look = done(await s.runOp(id, 'style.look', {}), 'look on the screen');
  let r = await s.api('POST', `${P}/approve/asset`, { candidate: look.result.candidate_id });
  assert.strictEqual(r.status, 200);

  // A fresh conversation knows what the screens did.
  r = await s.api('POST', `${P}/conversation/new`, {});
  assert.strictEqual(r.status, 201);
  const c = talker(s, id);
  let t = await c.say('STATE where are we?');
  assert.ok(/look approved/.test(t.reply.text), t.reply.text);
  assert.ok(/Last jobs .*style\.look done, style\.define done/.test(t.reply.text), t.reply.text);

  // The chat makes the character; the screen shows it, and the person approves the sheet there.
  const keeper = await c.ask('Add the keeper. ACTION:character.create {"name":"Ivo","description":"A lighthouse keeper."}', { screen: { key: 'characters' } });
  r = await s.api('GET', `${P}/characters`);
  assert.deepStrictEqual(r.body.characters.map((ch) => ch.id), ['CHAR_IVO'], 'the screen shows what the chat made');
  r = await s.api('POST', `${P}/approve/asset`, { candidate: keeper.card.result.sheet.candidate_id });
  assert.strictEqual(r.status, 200);
  t = await c.say('STATE and now?');
  assert.ok(/Ivo \(CHAR_IVO\): sheet approved/.test(t.reply.text), 'the chat sees the approval made on the screen');

  // The screen plans the page; the chat approves the plan and draws it.
  const plan = done(await s.runOp(id, 'pages.plan', { text: 'Ivo finds the bottle on the rocks.', pages: 1 }), 'plan on the screen');
  const pageId = plan.result.pages[0].id;
  t = await c.say('STATE');
  assert.ok(new RegExp(`${pageId} \\(plan not approved, not drawn\\)`).test(t.reply.text), t.reply.text);
  await c.ask(`ACTION:approve.plan {"pages":["${pageId}"]}`, { screen: { key: 'pages:ISS_001' } });
  await c.ask(`ACTION:pages.generate {"pages":["${pageId}"]}`, { screen: { key: 'pages:ISS_001' } });
  r = await s.api('GET', `${P}/issues/ISS_001`);
  assert.ok(r.body.pages[0].current_render && r.body.pages[0].plan_approved !== undefined, 'the Pages screen shows the drawing the chat made');

  // The screen approves the page; the chat publishes; the screen shows the edition.
  r = await s.api('POST', `${P}/approve/page`, { page: pageId });
  assert.strictEqual(r.status, 200);
  t = await c.say('STATE');
  assert.ok(new RegExp(`${pageId} \\(${pageId}_V01 passes, approved\\)`).test(t.reply.text), t.reply.text);
  await c.ask('ACTION:publish.build {"formats":["cbz"]}', { screen: { key: 'publish:ISS_001' } });
  r = await s.api('GET', `${P}/issues/ISS_001/publish`);
  assert.strictEqual(r.body.editions.length, 1, 'the Publish screen shows the edition the chat built');
  assert.deepStrictEqual(validateWorkspace(root).errors, []);
}

async function main() {
  const started = Date.now();
  const s = await start();
  try {
    await chatOnly(s);
    await hybrid(s);
  } finally {
    await s.close();
  }
  console.log(`studio-chat-runs: ok (${Date.now() - started} ms)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
