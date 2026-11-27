'use strict';
/**
 * Studio: the chat can do what the screens do. The action catalog covers the
 * web flow and takes its params from the operations; proposed actions become
 * cards (the invalid ones are left out with a reason); cards run on a click,
 * on a confirmation in words, or at once for text-only work when the setting
 * allows it; results come back into the conversation; a chat turn runs in
 * the read-only lane while another job runs; attachments reach the prompt
 * and the driver; an AI run cannot write the story bible; the next issue
 * opens from where the last one ended; and pages added after a publish make
 * the next edition.
 *
 * Fake mode: no CLI runs.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { start } = require('../studio/test-support/harness');
const actions = require('../studio/server/actions');
const ops = require('../studio/server/ops');
const fake = require('../studio/server/drivers/fake');
const png = require('../scripts/lib/png');
const ws = require('../scripts/lib/workspace');
const yaml = require('../scripts/lib/yaml');
const { validateWorkspace } = require('../scripts/validate-workspace');
const { checkContinuity } = require('../scripts/check-continuity');

function done(job, label) {
  assert.strictEqual(job.status, 'done', `${label}: ${job.status} ${JSON.stringify(job.error)}`);
  return job;
}

async function main() {
  const started = Date.now();

  // --- the catalog -------------------------------------------------------------------------
  const catalog = actions.catalog();
  const names = catalog.map((a) => a.name);
  // Every step a person takes on the screens to finish a comic, screen by screen.
  const webFlow = [
    'story.draft', 'story.complete', 'story.suggest', 'story.update', 'proposal.decide', 'proposal.discard', // Story
    'style.define', 'style.look', 'approve.asset', 'options.update', // Style and options
    'character.create', 'character.update', 'character.sheet', // Characters
    'entities.derive', // Places
    'pages.plan', 'approve.plan', 'pages.generate', 'issue.create', // Pages
    'page.review', 'approve.page', 'page.correct', 'page.manual', // Check and corrections
    'cover.create', 'cover.correct', 'approve.cover', // Cover
    'lettering.apply', 'publish.build', // Publish
    'job.answer', 'job.cancel', // Questions and the queue
  ];
  for (const name of webFlow) assert.ok(names.includes(name), `the catalog lacks ${name}`);
  assert.ok(!names.includes('chat.turn'), 'a chat turn is not an action');
  for (const name of ops.names().filter((n) => n !== 'chat.turn')) {
    const entry = catalog.find((a) => a.name === name);
    assert.ok(entry, `operation ${name} is not in the catalog`);
    assert.strictEqual(entry.params, ops.get(name).params, `${name}: the params come from the operation itself`);
  }
  const promptText = actions.promptText();
  for (const name of names) assert.ok(promptText.includes(`- ${name}: `), `the prompt does not list ${name}`);
  assert.ok(/pages\.generate: .*\[draws\]/.test(promptText) && /approve\.page: .*\[the person's decision\]/.test(promptText));

  process.env.STUDIO_FAKE_SLOW_MS = '1500';
  const s = await start();
  try {
    let r = await s.api('GET', '/api/actions');
    assert.deepStrictEqual(r.body.actions.map((a) => a.name), names);

    const id = await s.seedProject('Chat Actions');
    const P = `/api/projects/${id}`;
    const projectDir = path.join(s.home, id);
    const root = path.join(projectDir, 'production');
    const screen = { key: 'pages:ISS_001' };

    const conv = async () => (await s.api('GET', `${P}/conversation`)).body.conversation;
    const chat = async (text, extra = {}) => {
      const res = await s.api('POST', `${P}/conversation`, Object.assign({ text, screen }, extra));
      assert.strictEqual(res.status, 202, JSON.stringify(res.body));
      const job = await s.waitJob(id, res.body.job.id);
      const c = await conv();
      const reply = c.messages.filter((m) => m.role === 'assistant' && m.job === job.id).pop();
      return { job, reply, conv: c, sent: res.body };
    };
    const idle = async () => {
      for (let i = 0; i < 2000; i++) {
        const res = await s.api('GET', `${P}/jobs?active=1`);
        if (!res.body.jobs.some((j) => ['queued', 'running'].includes(j.status))) return;
        await new Promise((ok) => setTimeout(ok, 20));
      }
      throw new Error('the queue did not go idle');
    };
    const run = async (card) => {
      const res = await s.api('POST', `${P}/conversation/${card.conversation}/actions/${card.id}/run`, {});
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      return res.body;
    };

    // --- cards: checked, the invalid ones left out with the reason ---------------------------------
    let t = await chat('Plan it. ACTION:pages.plan {"text":"Mara opens the box on the table.","pages":1} ACTION:pages.plan {"pages":2} ACTION:nonsense.thing {}');
    done(t.job, 'turn with actions');
    assert.strictEqual(t.reply.actions.length, 1);
    const planCard = t.reply.actions[0];
    assert.deepStrictEqual([planCard.action, planCard.kind, planCard.status, planCard.draws, planCard.auto], ['pages.plan', 'op', 'pending', false, true]);
    assert.deepStrictEqual(planCard.tools.map((x) => [x.verb, x.tool]), [['plan', 'claude']]);
    assert.ok(planCard.typical && planCard.typical.ms > 0 && planCard.typical.source === 'reference', JSON.stringify(planCard.typical));
    assert.strictEqual(planCard.title, 'Plan pages');
    assert.ok(planCard.details.some((d) => d.name === 'text' && /opens the box/.test(d.value)));
    assert.deepStrictEqual(t.reply.dropped.map((d) => d.action), ['pages.plan', 'nonsense.thing']);
    assert.ok(/"text" is required/.test(t.reply.dropped[0].reason_params.detail || t.reply.dropped[0].reason));
    r = await s.api('GET', `${P}/jobs/${t.job.id}/log`);
    assert.ok(r.body.lines.some((l) => /proposed action nonsense\.thing was left out/.test(l)));
    assert.ok(!fs.existsSync(path.join(root, 'issues', 'ISS_001', 'pages')), 'a proposed action does nothing by itself');

    // --- dismiss, then run on a click: the job carries its origin and the result comes back -----------------
    t = await chat('Another one. ACTION:character.sheet {"character":"CHAR_MARA","sheet":"expressions"}');
    const sheetCard = t.reply.actions[0];
    assert.deepStrictEqual([sheetCard.draws, sheetCard.auto], [true, false]);
    r = await s.api('POST', `${P}/conversation/${sheetCard.conversation}/actions/${sheetCard.id}/dismiss`, {});
    assert.strictEqual(r.body.card.status, 'dismissed');
    r = await s.api('POST', `${P}/conversation/${sheetCard.conversation}/actions/${sheetCard.id}/run`, {});
    assert.deepStrictEqual([r.status, r.body.error.code], [409, 'card_not_pending']);

    const ran = await run(planCard);
    assert.strictEqual(ran.card.status, 'started');
    assert.deepStrictEqual(ran.job.origin, { conversation: planCard.conversation, card: planCard.id, message: planCard.message });
    done(await s.waitJob(id, ran.job.id), 'the planned card');
    let c = await conv();
    let event = c.messages.find((m) => m.event === 'action_result' && m.card === planCard.id);
    assert.ok(event, 'the result came back into the conversation');
    assert.strictEqual(event.status, 'done');
    assert.ok(event.links.some((l) => l.key === 'pages:ISS_001') && event.links.some((l) => l.key === 'page:PG_001_001'), JSON.stringify(event.links));
    assert.strictEqual(c.messages.find((m) => m.id === planCard.message).actions[0].status, 'done', 'the card on the message shows the outcome');

    // --- a confirmation in words runs the waiting card; drawn images come back -------------------------------
    t = await chat('ACTION:pages.generate {"pages":["PG_001_001"],"approve_plans":true}');
    const drawCard = t.reply.actions[0];
    assert.strictEqual(drawCard.draws, true);
    t = await chat('RUN yes, draw it');
    assert.deepStrictEqual(t.job.result.ran.map((x) => x.card), [drawCard.id]);
    await idle();
    c = await conv();
    event = c.messages.find((m) => m.event === 'action_result' && m.card === drawCard.id);
    assert.ok(event && event.status === 'done', JSON.stringify(event));
    assert.ok(event.images.some((img) => /PG_001_001_V01\.png$/.test(img.path) && img.url), JSON.stringify(event.images));
    assert.strictEqual(c.messages.find((m) => m.id === drawCard.message).actions[0].run_by, 'text');

    // --- a decision card runs on the spot ----------------------------------------------------------------
    t = await chat('ACTION:approve.page {"page":"PG_001_001"}');
    const approveCard = t.reply.actions[0];
    assert.deepStrictEqual([approveCard.kind, approveCard.decision, approveCard.auto], ['direct', true, false]);
    const approved = await run(approveCard);
    assert.strictEqual(approved.card.status, 'done', JSON.stringify(approved.card.error));
    assert.strictEqual(ws.loadPage(root, 'PG_001_001').status, 'approved');

    // --- text-only cards run at once when the setting allows it; drawings never do ------------------------------
    r = await s.api('PUT', `${P}/settings`, { chat_auto_run: true });
    assert.strictEqual(r.body.settings.chat_auto_run, true);
    t = await chat('ACTION:story.suggest {"instruction":"suggest an ending"} ACTION:character.sheet {"character":"CHAR_MARA","sheet":"expressions"}');
    assert.deepStrictEqual(t.job.result.ran.map((x) => x.card), [t.reply.actions[0].id]);
    await idle();
    c = await conv();
    const [suggestCard, sheetCard2] = c.messages.find((m) => m.id === t.reply.id).actions;
    assert.deepStrictEqual([suggestCard.status, suggestCard.run_by, sheetCard2.status], ['done', 'auto', 'pending']);
    event = c.messages.find((m) => m.event === 'action_result' && m.card === suggestCard.id);
    assert.ok(event.proposals.length === 1 && event.proposals[0].id, 'the story proposal is linked from the result');
    r = await s.api('PUT', `${P}/settings`, { chat_auto_run: false });

    // --- a job that stops to ask: the questions come back, the answer goes as an action -------------------------
    t = await chat('ACTION:pages.plan {"text":"DECIDE where she goes next.","pages":1}');
    const askCard = t.reply.actions[0];
    const askRun = await run(askCard);
    let job = await s.waitJob(id, askRun.job.id);
    assert.strictEqual(job.status, 'needs_decision');
    c = await conv();
    event = c.messages.find((m) => m.event === 'action_result' && m.card === askCard.id);
    assert.deepStrictEqual([event.status, event.questions[0].id], ['needs_decision', 'q1']);
    t = await chat(`The first way. ACTION:job.answer {"job":"${job.id}","answers":{"q1":"The first way"}}`);
    const answerCard = t.reply.actions[0];
    assert.strictEqual(answerCard.action, 'job.answer');
    assert.strictEqual((await run(answerCard)).card.status, 'done');
    job = done(await s.waitJob(id, job.id), 'the answered plan');
    c = await conv();
    assert.strictEqual(c.messages.filter((m) => m.event === 'action_result' && m.card === askCard.id).pop().status, 'done');

    // --- the state block: what the screens did is in the prompt ----------------------------------------------
    t = await chat('STATE where are we?');
    assert.ok(/Mara \(CHAR_MARA\): sheet approved/.test(t.reply.text), t.reply.text);
    assert.ok(/PG_001_001 \(PG_001_001_V01 passes, approved\); PG_001_002 \(plan not approved, not drawn\)/.test(t.reply.text), t.reply.text);
    assert.ok(/Last jobs \(newest first, from the screens or the chat\): pages\.plan done \(from the chat\)/.test(t.reply.text));
    assert.ok(/Action cards in this conversation waiting for the person: card_\S+ character\.sheet/.test(t.reply.text));
    assert.ok(/look approved/.test(t.reply.text));

    // --- the read-only lane: a turn does not wait behind a long job -------------------------------------------
    r = await s.api('POST', `${P}/ops`, { op: 'pages.plan', params: { text: 'SLOW Mara walks to the window.', pages: 1 } });
    const longJob = r.body.job;
    for (let i = 0; i < 200 && (await s.api('GET', `${P}/jobs/${longJob.id}`)).body.job.status !== 'running'; i++) await new Promise((ok) => setTimeout(ok, 10));
    const sourceFile = path.join(root, 'story', 'series-plan.yaml');
    const planBefore = fs.readFileSync(sourceFile, 'utf8');
    const turn = await s.api('POST', `${P}/conversation`, { text: 'EDIT What is going on?', screen: { key: 'story' } });
    assert.strictEqual(turn.body.job.read_only, true, 'the turn went to the read-only lane');
    job = done(await s.waitJob(id, turn.body.job.id), 'turn beside the long job');
    assert.strictEqual((await s.api('GET', `${P}/jobs/${longJob.id}`)).body.job.status, 'running', 'the turn finished while the long job ran');
    assert.ok(job.result.read_only && /Another job is running, so I changed nothing/.test(job.result.message.text));
    assert.deepStrictEqual([job.steps[0].commit, job.steps[0].changed], [null, []], 'a read-only turn commits nothing');
    assert.strictEqual(fs.readFileSync(sourceFile, 'utf8'), planBefore, 'a read-only turn writes nothing');
    done(await s.waitJob(id, longJob.id), 'the long job');
    await idle();
    // Two turns never overlap: one sent while another turn runs waits for it, then runs where it may write.
    const slowTurn = await s.api('POST', `${P}/conversation`, { text: 'SLOW think about it', screen });
    const nextTurn = await s.api('POST', `${P}/conversation`, { text: 'and this', screen });
    const a = done(await s.waitJob(id, slowTurn.body.job.id), 'slow turn');
    const b = done(await s.waitJob(id, nextTurn.body.job.id), 'next turn');
    assert.ok(b.started_at >= a.ended_at, `the second turn started at ${b.started_at}, before the first ended at ${a.ended_at}`);
    assert.strictEqual(b.read_only, false, 'the main lane was free when it started');
    t = await chat('EDIT now change it', { screen: { key: 'story' } });
    assert.strictEqual(t.job.read_only, false, 'with the queue idle the turn runs in the main lane');
    assert.ok(t.job.steps[0].changed.length >= 1 && t.job.steps[0].commit, 'and may write');

    // --- attachments: in the prompt with their paths, images to the driver, usable by an action --------------------
    const tiny = png.encode({ width: 8, height: 8, data: Buffer.alloc(8 * 8 * 3, 90) });
    const photo = await s.upload(id, 'lia.png', tiny, 'image/png');
    const note = await s.upload(id, 'notes.txt', Buffer.from('Lia wears a red scarf.'), 'text/plain');
    const seen = [];
    const realRun = fake.run;
    fake.run = (options) => {
      if (options.task && options.task.kind === 'chat') seen.push({ prompt: options.prompt, images: options.images, addDirs: options.addDirs });
      return realRun(options);
    };
    try {
      t = await chat('Make her from this photo. ACTION:character.create {"name":"Lia","description":"A painter.","uploads":"@attachments"}',
        { attachments: [photo.id, note.id], screen: { key: 'characters' } });
    } finally {
      fake.run = realRun;
    }
    done(t.job, 'turn with attachments');
    const userMsg = t.conv.messages.find((m) => m.id === t.sent.message.id);
    assert.deepStrictEqual(userMsg.attachments.map((a) => [a.name, a.kind]), [['lia.png', 'image'], ['notes.txt', 'source']]);
    assert.ok(userMsg.attachments[0].url.endsWith(`/uploads/${photo.id}`));
    const photoFile = path.join(projectDir, '.studio', 'uploads');
    const call = seen.pop();
    assert.ok(call.prompt.includes(photoFile) && call.prompt.includes(photo.id) && call.prompt.includes(note.id), 'the prompt lists the files');
    assert.strictEqual(call.images.length, 1);
    assert.ok(call.images[0].startsWith(projectDir) && call.addDirs.includes(projectDir), 'the image is inside a directory the tool may read');
    assert.ok(/I got 2 attachment\(s\), 1 of them image\(s\)/.test(t.reply.text));
    const liaCard = t.reply.actions[0];
    assert.deepStrictEqual([liaCard.action, liaCard.photo_rights, liaCard.params.uploads], ['character.create', true, [photo.id]]);
    assert.deepStrictEqual(liaCard.uploads.map((u) => u.name), ['lia.png']);
    r = await s.api('POST', `${P}/conversation`, { text: 'x', screen, attachments: ['up_nothing'] });
    assert.strictEqual(r.status, 400, 'an unknown attachment is refused');

    // --- pages after a published edition: they go after the last one, and the next publish makes the next edition ---------
    await idle();
    job = done(await s.runOp(id, 'publish.build', { issue: 'ISS_001', formats: ['cbz'] }), 'first publish');
    const firstEdition = job.result.edition;
    const pagesBefore = ws.listPageIds(root, 'ISS_001');
    job = done(await s.runOp(id, 'pages.plan', { text: 'Mara closes the window.', pages: 1 }), 'a page after the edition');
    const added = job.result.pages.map((p) => p.id);
    assert.ok(added.every((pg) => !pagesBefore.includes(pg)) && parseInt(added[0].slice(-3), 10) === pagesBefore.length + 1, `${added} after ${pagesBefore}`);
    job = done(await s.runOp(id, 'pages.generate', { issue: 'ISS_001', approve_plans: true }), 'draw the rest');
    assert.ok(!job.result.failed && !job.result.flagged, JSON.stringify(job.result));
    job = done(await s.runOp(id, 'publish.build', { issue: 'ISS_001', formats: ['cbz'] }), 'second publish');
    assert.notStrictEqual(job.result.edition, firstEdition);
    const edition = ws.loadEdition(root, job.result.edition);
    assert.strictEqual(edition.supersedes, firstEdition);
    assert.strictEqual(edition.pages.length, ws.listPageIds(root, 'ISS_001').length, JSON.stringify([edition.pages.map((p) => p.page), job.result]));

    // --- the next issue opens from where the last one ended -----------------------------------------------
    const lastPage = ws.listPageIds(root, 'ISS_001').sort().pop();
    const pageFile = path.join(ws.pageDir(root, lastPage), 'page.yaml');
    const pageDoc = ws.loadYaml(pageFile);
    const lastPanel = pageDoc.panels[pageDoc.panels.length - 1];
    lastPanel.cast[0].state = ['soaked'];
    lastPanel.cast[0].state_changes = { adds: ['soaked'], resolves: [] };
    fs.writeFileSync(pageFile, yaml.stringify(pageDoc));
    assert.deepStrictEqual(checkContinuity(root, { issue: 'ISS_001' }).findings.filter((f) => f.severity === 'error'), []);

    r = await s.api('POST', `${P}/issues`, { title: 'The Second Crossing', pages: 2 });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.issue, r.body.previous, r.body.opens_from, r.body.state_written], ['ISS_002', 'ISS_001', 'continuity/ISS_001.final-state.yaml', true]);
    assert.ok(r.body.commit);
    const plan = ws.loadYaml(path.join(root, 'story', 'series-plan.yaml'));
    assert.deepStrictEqual(plan.issues.map((i) => [i.id, i.page_budget]), [['ISS_001', plan.issues[0].page_budget], ['ISS_002', 2]]);
    const issue2 = ws.loadIssue(root, 'ISS_002');
    assert.deepStrictEqual([issue2.opens_from, issue2.page_count, issue2.scenes], ['continuity/ISS_001.final-state.yaml', 0, []]);
    const state = ws.loadYaml(path.join(root, 'continuity', 'ISS_001.final-state.yaml'));
    assert.strictEqual(state.after_page, lastPage);
    assert.deepStrictEqual(state.characters.CHAR_MARA.state, ['soaked']);
    assert.ok(!fs.existsSync(path.join(root, 'characters', 'ISS_002')), 'nothing is copied');
    assert.deepStrictEqual(validateWorkspace(root).errors, [], 'the workspace still validates with an empty next issue');
    r = await s.api('POST', `${P}/issues`, { title: '' });
    assert.strictEqual(r.status, 400);

    job = done(await s.runOp(id, 'pages.plan', { text: 'Mara wakes on the far bank.', pages: 1, issue: 'ISS_002' }), 'first page of issue 2');
    assert.strictEqual(job.result.opens_from, 'continuity/ISS_001.final-state.yaml');
    r = await s.api('GET', `${P}/jobs/${job.id}/log`);
    assert.ok(r.body.lines.some((l) => /ISS_002 opens from continuity\/ISS_001\.final-state\.yaml/.test(l)));
    const first = ws.loadPage(root, 'PG_002_001');
    assert.deepStrictEqual(first.panels[0].cast.find((row) => row.character === 'CHAR_MARA').state, ['soaked'], 'the plan starts from the end state');
    assert.strictEqual(ws.loadIssue(root, 'ISS_002').opens_from, 'continuity/ISS_001.final-state.yaml', 'the breakdown kept opens_from');
    assert.deepStrictEqual(checkContinuity(root, { issue: 'ISS_002' }).findings.filter((f) => f.severity === 'error'), []);
    // The check really reads the end state: a first page that drops the state is an error.
    const broken = JSON.parse(JSON.stringify(first));
    for (const p of broken.panels) for (const row of p.cast) row.state = [];
    fs.writeFileSync(path.join(ws.pageDir(root, 'PG_002_001'), 'page.yaml'), yaml.stringify(broken));
    assert.ok(checkContinuity(root, { issue: 'ISS_002' }).findings.some((f) => f.severity === 'error'), 'the gate compares with ISS_001\'s end');
    fs.writeFileSync(path.join(ws.pageDir(root, 'PG_002_001'), 'page.yaml'), yaml.stringify(first));

    // The screens follow the chosen issue.
    for (const route of [`${P}/issues/ISS_002`, `${P}/issues/ISS_002/cover`, `${P}/issues/ISS_002/publish`]) {
      r = await s.api('GET', route);
      assert.strictEqual(r.status, 200, `${route}: ${JSON.stringify(r.body)}`);
    }
    r = await s.api('GET', P);
    assert.deepStrictEqual(r.body.issues.map((i) => i.id), ['ISS_001', 'ISS_002']);

    // And the chat can create one too.
    t = await chat('ACTION:issue.create {"title":"Third","pages":3}');
    const issueCard = t.reply.actions[0];
    const madeIssue = await run(issueCard);
    assert.deepStrictEqual([madeIssue.card.status, madeIssue.card.result.issue, madeIssue.card.result.opens_from], ['done', 'ISS_003', 'continuity/ISS_002.final-state.yaml']);
    // --- no AI run writes the story bible: the change is undone and becomes a proposal --------------------------------
    const bibleFile = path.join(root, 'story', 'story-bible.yaml');
    const bibleBefore = fs.readFileSync(bibleFile, 'utf8');
    job = done(await s.runOp(id, 'character.create', { name: 'Nils', description: 'A harbour clerk. WRITEBIBLE', draw: false }), 'careless character run');
    assert.strictEqual(fs.readFileSync(bibleFile, 'utf8'), bibleBefore, 'the story bible is as it was');
    assert.ok(!job.steps.some((st) => (st.changed || []).includes('story/story-bible.yaml')), 'the undone change is in no commit');
    assert.strictEqual(job.story_proposals.length, 1);
    r = await s.api('GET', `${P}/proposals/${job.story_proposals[0].id}`);
    assert.deepStrictEqual([r.body.proposal.kind, r.body.proposal.parts[0].type, r.body.proposal.parts[0].provenance], ['guard', 'fact', 'addition']);
    assert.ok(/older brother/.test(r.body.proposal.parts[0].text));
    r = await s.api('GET', `${P}/jobs/${job.id}/log`);
    assert.ok(r.body.lines.some((l) => /changed the story bible directly: the change was undone/.test(l)));

  } finally {
    await s.close();
    delete process.env.STUDIO_FAKE_SLOW_MS;
  }
  console.log(`studio-chat-actions: ok (${Date.now() - started} ms)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
