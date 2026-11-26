'use strict';
/**
 * Studio: one conversation per project that follows the person across
 * screens. Messages carry their screen; the conversations per screen of
 * earlier versions are folded in on first read; the tool session resumes
 * while the same tool answers, and a change of tool starts a new session
 * with a summary, recorded in the transcript; navigation links are checked
 * against the project's screens; a fresh conversation keeps the old one
 * readable; the deprecated routes per screen keep answering.
 *
 * Fake mode: no CLI runs.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { start } = require('../studio/test-support/harness');
const screens = require('../studio/server/screens');

function done(job, label) {
  assert.strictEqual(job.status, 'done', `${label}: ${job.status} ${JSON.stringify(job.error)}`);
  return job;
}

async function main() {
  const started = Date.now();
  const s = await start();
  try {
    const id = await s.seedProject('Talk Project');
    const P = `/api/projects/${id}`;

    // --- earlier transcripts per screen, written the old way, before the conversation is read ----------
    const chatsDir = path.join(s.home, id, '.studio', 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });
    const line = (key, at, role, text) => JSON.stringify({ id: `msg_${at.replace(/\D/g, '')}_${role}`, at, key, role, text, job: null });
    fs.writeFileSync(path.join(chatsDir, 'style.jsonl'), [
      line('style', '2026-11-20T10:00:00Z', 'user', 'Older question about the style.'),
      line('style', '2026-11-20T10:02:00Z', 'assistant', 'Older answer about the style.'),
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(chatsDir, 'character--CHAR_MARA.jsonl'), [
      line('character:CHAR_MARA', '2026-11-20T10:01:00Z', 'user', 'Older question about Mara.'),
    ].join('\n') + '\n');

    let r = await s.api('GET', `${P}/conversation`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const first = r.body.conversation;
    assert.strictEqual(first.current, true);
    assert.deepStrictEqual(first.folded.sort(), ['character:CHAR_MARA', 'style']);
    assert.deepStrictEqual(first.messages.map((m) => [m.role, m.screen && m.screen.key]), [
      ['user', 'style'], ['user', 'character:CHAR_MARA'], ['assistant', 'style'], ['event', undefined],
    ], 'folded in time order, tagged with their screen');
    assert.deepStrictEqual([first.messages[1].screen.label, first.messages[1].screen.route, first.messages[1].folded_from],
      ['Character: Mara', `/p/${id}/characters/CHAR_MARA`, 'character:CHAR_MARA']);
    assert.deepStrictEqual([first.messages[3].event, first.messages[3].text_code, first.messages[3].text_params.n], ['folded', 'conversation.folded', 2]);
    assert.ok(fs.existsSync(path.join(chatsDir, 'style.jsonl')), 'the old files stay where they were');
    // Reading again does not fold twice.
    r = await s.api('GET', `${P}/conversation`);
    assert.strictEqual(r.body.conversation.messages.length, 4);
    assert.deepStrictEqual(r.body.conversations.map((c) => [c.id, c.messages]), [[first.id, 3]]);

    // --- a message from one screen, then from another: one conversation, one session -----------------------
    const stream = s.openEvents(id);
    await stream.waitFor((e) => e.type === 'hello');
    r = await s.api('POST', `${P}/conversation`, { text: 'How do I add a character?', screen: { key: 'style', label: 'Style screen', route: `/p/${id}/style` } });
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.message.screen, { key: 'style', label: 'Style screen', route: `/p/${id}/style` });
    assert.strictEqual(r.body.conversation, first.id);
    assert.strictEqual(r.body.job.params.conversation, first.id);
    let job = done(await s.waitJob(id, r.body.job.id), 'turn on style');
    assert.ok(/joined with a summary of 3 earlier message/.test(job.result.message.text), 'a new session gets the conversation so far');
    const chatEvent = await stream.waitFor((e) => e.type === 'chat' && e.data.message.role === 'assistant');
    assert.deepStrictEqual([chatEvent.data.conversation, chatEvent.data.key], [first.id, 'style'], 'chat events carry the project conversation');

    r = await s.api('POST', `${P}/conversation`, { text: 'LINK And now?', screen: { key: 'character:CHAR_MARA' } });
    job = done(await s.waitJob(id, r.body.job.id), 'turn on the character');
    const reply = job.result.message;
    assert.ok(!/joined with a summary/.test(reply.text), 'the same tool resumes its session: no summary');
    assert.deepStrictEqual(reply.screen, { key: 'character:CHAR_MARA', label: 'Character: Mara', label_code: 'screen_label.character', label_params: { name: 'Mara' }, route: `/p/${id}/characters/CHAR_MARA` });
    assert.deepStrictEqual(reply.links.map((l) => [l.key, l.route, l.label]), [['characters', `/p/${id}/characters`, 'Characters']],
      'links to screens that do not exist are dropped');
    r = await s.api('GET', `${P}/jobs/${job.id}/log`);
    assert.ok(r.body.lines.some((l) => /2 suggested link\(s\) named no screen/.test(l)));

    // --- the answering tool changes: a new session, a summary, and an event in the transcript ---------------
    r = await s.api('PUT', `${P}/settings`, { drivers: { plan: 'codex' } });
    assert.strictEqual(r.status, 200);
    r = await s.api('POST', `${P}/conversation`, { text: 'Is she ready?', screen: { key: 'character:CHAR_MARA' } });
    job = done(await s.waitJob(id, r.body.job.id), 'turn with codex');
    assert.strictEqual(job.result.message.tool, 'codex');
    assert.ok(/joined with a summary/.test(job.result.message.text));
    r = await s.api('GET', `${P}/conversation`);
    const events = r.body.conversation.messages.filter((m) => m.role === 'event' && m.event === 'tool_changed');
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual([events[0].from_tool, events[0].tool, events[0].text_code], ['claude', 'codex', 'conversation.tool_changed']);
    assert.ok(/Codex answers from here on instead of Claude Code/.test(events[0].text));
    assert.deepStrictEqual(r.body.conversation.session, { tool: 'codex' });
    await s.api('PUT', `${P}/settings`, { drivers: { plan: 'claude' } });

    // --- refusals ------------------------------------------------------------------------------------------
    for (const body of [
      { text: 'x' },
      { text: 'x', screen: { key: 'nonsense' } },
      { text: 'x', screen: { key: 'home' } },
      { text: '', screen: { key: 'story' } },
    ]) {
      r = await s.api('POST', `${P}/conversation`, body);
      assert.strictEqual(r.status, 400, JSON.stringify(body));
    }
    r = await s.api('POST', `${P}/conversation`, { text: 'x', screen: { key: 'character:CHAR_NOBODY' } });
    assert.strictEqual(r.status, 404);

    // --- deprecated per-screen routes: they read and write the project conversation ---------------------------
    r = await s.api('POST', `${P}/chats/style`, { text: 'Old client message.' });
    assert.strictEqual(r.status, 202);
    assert.strictEqual(r.body.message.screen.key, 'style');
    done(await s.waitJob(id, r.body.job.id), 'old route turn');
    r = await s.api('GET', `${P}/chats/style`);
    assert.deepStrictEqual(r.body.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    assert.strictEqual(r.body.conversation, first.id);
    r = await s.api('GET', `${P}/chats`);
    assert.deepStrictEqual(r.body.chats.map((c) => [c.key, c.messages]), [['character:CHAR_MARA', 5], ['style', 6]]);

    // --- a fresh conversation; the old one stays readable ---------------------------------------------------------
    r = await s.api('POST', `${P}/conversation/new`, {});
    assert.strictEqual(r.status, 201);
    const second = r.body.conversation;
    assert.notStrictEqual(second.id, first.id);
    assert.deepStrictEqual([second.messages, second.session, second.current], [[], null, true]);
    assert.deepStrictEqual(r.body.conversations.map((c) => [c.id, c.current]), [[second.id, true], [first.id, false]]);
    r = await s.api('POST', `${P}/conversation`, { text: 'A new start.', screen: { key: 'story' } });
    job = done(await s.waitJob(id, r.body.job.id), 'turn in the new conversation');
    assert.ok(!/joined with a summary/.test(job.result.message.text), 'a fresh conversation carries nothing over');
    r = await s.api('GET', `${P}/conversations/${first.id}`);
    assert.strictEqual(r.body.conversation.current, false);
    assert.ok(r.body.conversation.messages.length >= 13);
    r = await s.api('GET', `${P}/conversations`);
    assert.deepStrictEqual(r.body.conversations.map((c) => c.messages), [2, 11]);
    r = await s.api('GET', `${P}/conversations/conv_nothing_here`);
    assert.deepStrictEqual([r.status, r.body.error.code], [404, 'conversation_not_found']);
    r = await s.api('GET', `${P}/chats/style`);
    assert.deepStrictEqual(r.body.messages, [], 'the old route reads the current conversation');
    stream.close();

    // --- screens: every screen route answers with its screen ---------------------------------------------------------
    r = await s.api('GET', `${P}/characters/CHAR_MARA`);
    assert.deepStrictEqual([r.body.screen.key, r.body.screen.route], ['character:CHAR_MARA', `/p/${id}/characters/CHAR_MARA`]);
    r = await s.api('GET', `${P}/style?lang=es`);
    assert.strictEqual(r.body.screen.label, 'Estilo');
    const proj = s.app.services.registry.get(id);
    assert.strictEqual(screens.keyOfRoute(proj, `/p/${id}/pages/PG_001_002`), 'page:PG_001_002');
    assert.strictEqual(screens.keyOfRoute(proj, `/p/${id}/places/location/LOC_X`), 'location:LOC_X');
    assert.strictEqual(screens.keyOfRoute(proj, '/p/other-project/story'), null);
    assert.strictEqual(screens.keyOfRoute(proj, `/p/${id}`), 'home');
  } finally {
    await s.close();
  }
  console.log(`studio-conversation: ok (${Date.now() - started} ms)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
