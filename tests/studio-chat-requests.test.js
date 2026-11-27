'use strict';
/**
 * The chat does what the person asks for in so many words, in order, in one
 * message (fake mode).
 *
 * 1. "Approve the plan of page 1 and draw it": two cards proposed together.
 *    The drawing would be refused on its own (the plan is not approved yet),
 *    so it is kept as "after card 1", and both carry run: true. The approval
 *    runs, then the drawing starts, in the same turn.
 * 2. The same two cards without run: both wait. Running the second first
 *    makes it wait for the first; dismissing the first cancels the second,
 *    with the reason.
 * 3. A first card that fails cancels the card that waited for it.
 * 4. A card the model only suggests waits for a click.
 * 5. The person's own text: a chat turn that saves story/source/description.md
 *    shows on the Story screen at once (the file is the source of truth).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { start } = require('../studio/test-support/harness');
const ws = require('../scripts/lib/workspace');

function done(job, label) {
  assert.strictEqual(job.status, 'done', `${label}: ${job.status} ${JSON.stringify(job.error)}`);
  return job;
}

async function main() {
  const started = Date.now();
  const s = await start();
  try {
    const id = await s.seedProject('Chat Requests');
    const P = `/api/projects/${id}`;
    const root = path.join(s.home, id, 'production');
    const say = async (text, screen = 'pages:ISS_001') => {
      const r = await s.api('POST', `${P}/conversation`, { screen, text });
      assert.strictEqual(r.status, 202, JSON.stringify(r.body));
      return done(await s.waitJob(id, r.body.job.id), 'chat turn');
    };
    const cardOf = async (conv, cardId) => {
      const c = (await s.api('GET', `${P}/conversations/${conv}`)).body.conversation;
      for (const m of c.messages) for (const card of m.actions || []) if (card.id === cardId) return card;
      return null;
    };
    const waitCard = async (conv, cardId, statuses) => {
      for (let i = 0; i < 400; i++) {
        const card = await cardOf(conv, cardId);
        if (card && statuses.includes(card.status)) return card;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`card ${cardId} never reached ${statuses.join('/')}: ${JSON.stringify(await cardOf(conv, cardId))}`);
    };

    done(await s.runOp(id, 'pages.plan', { text: 'Mara opens the box.', pages: 2 }), 'pages.plan');
    const [first, second] = ws.listPageIds(root, 'ISS_001');

    // --- 1. approve and draw, in one message ----------------------------------------------------------
    let turn = await say(`DO:approve.plan {"pages": ["${first}"]} DO:pages.generate {"pages": ["${first}"]}`);
    let [approve, draw] = turn.result.message.actions;
    assert.deepStrictEqual([approve.action, draw.action], ['approve.plan', 'pages.generate']);
    assert.strictEqual(draw.after.card, approve.id, 'the drawing waits for the approval');
    assert.strictEqual(draw.after.n, 1);
    assert.ok(draw.waits_for, 'it says what it waited for');
    assert.deepStrictEqual([approve.requested, draw.requested], [true, true]);
    assert.deepStrictEqual(turn.result.ran.map((x) => x.requested), [true, true]);
    approve = await cardOf(turn.result.conversation, approve.id);
    assert.deepStrictEqual([approve.status, approve.run_by], ['done', 'request']);
    draw = await waitCard(turn.result.conversation, draw.id, ['done', 'failed']);
    assert.strictEqual(draw.status, 'done', JSON.stringify(draw.error));
    assert.strictEqual(draw.run_by, 'request', 'it records that it ran on an explicit request');
    assert.ok(draw.typical && draw.typical.ms, 'the card says how long it usually takes');
    assert.ok(ws.loadPage(root, first).current_render, 'the page was drawn');

    // --- 2. the same without run: both wait; order is kept; dismissing the first cancels the second -----
    turn = await say(`ACTION:approve.plan {"pages": ["${second}"]} ACTION:pages.generate {"pages": ["${second}"]}`);
    [approve, draw] = turn.result.message.actions;
    assert.deepStrictEqual([approve.status, draw.status, draw.requested], ['pending', 'pending', false]);
    let r = await s.api('POST', `${P}/conversation/${turn.result.conversation}/actions/${draw.id}/run`, {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.card.status, 'waiting', 'run out of order, it waits for the card before it');
    r = await s.api('POST', `${P}/conversation/${turn.result.conversation}/actions/${approve.id}/dismiss`, {});
    assert.strictEqual(r.status, 200);
    draw = await cardOf(turn.result.conversation, draw.id);
    assert.strictEqual(draw.status, 'cancelled');
    assert.ok(/did not finish/.test(draw.error), JSON.stringify(draw.error));
    assert.strictEqual(ws.loadPage(root, second).current_render, null, 'nothing was drawn');

    // --- 3. a first card that fails cancels the next --------------------------------------------------
    turn = await say('DO:approve.asset {"candidate": "CHAR_NOBODY_TURN_V01"} DO:character.sheet {"character": "CHAR_NOBODY"}', 'characters');
    const [bad, sheet] = turn.result.message.actions;
    assert.strictEqual(sheet.after.card, bad.id);
    assert.strictEqual((await cardOf(turn.result.conversation, bad.id)).status, 'failed');
    assert.strictEqual((await waitCard(turn.result.conversation, sheet.id, ['cancelled'])).status, 'cancelled');

    // A card that fails for a reason no earlier card could change is left out, as before.
    turn = await say('ACTION:style.look {} ACTION:pages.plan {"text": "x", "pages": 99}');
    assert.strictEqual(turn.result.message.actions.length, 1);
    assert.strictEqual(turn.result.message.dropped[0].action, 'pages.plan');

    // --- 4. a suggestion waits --------------------------------------------------------------------------
    assert.strictEqual(turn.result.message.actions[0].status, 'pending');
    assert.strictEqual(turn.result.ran.length, 0);

    // --- 5. the person's own text --------------------------------------------------------------------------
    await say('MYTEXT A painter finds a door in the sea and goes through it.', 'story');
    const storyScreen = (await s.api('GET', `${P}/story`)).body;
    assert.strictEqual(storyScreen.description, 'A painter finds a door in the sea and goes through it.');
    assert.ok(fs.readFileSync(path.join(root, 'story', 'source', 'description.md'), 'utf8').includes('door in the sea'));
    const card = (await s.api('GET', '/api/projects')).body.projects.find((p) => p.id === id);
    assert.strictEqual(card.description, storyScreen.description, 'the project card reads the same file');
  } finally {
    await s.close();
  }
  console.log(`studio-chat-requests: ok (${Date.now() - started} ms)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
