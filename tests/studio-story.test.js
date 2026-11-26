'use strict';
/**
 * Studio: the AI does not write the story unless asked. A new project holds
 * the person's text and an empty, valid story bible; story.draft,
 * story.complete, story.suggest and chat requests return proposals; the
 * person accepts, edits or rejects each part, and only accepted parts reach
 * story/story-bible.yaml, with their provenance, as one history commit that
 * keeps the file's comments.
 *
 * Fake mode: no CLI runs.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ws = require('../scripts/lib/workspace');
const yaml = require('../scripts/lib/yaml');
const { validateWorkspace } = require('../scripts/validate-workspace');
const { start } = require('../studio/test-support/harness');
const story = require('../studio/server/story');

const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

function done(job, label) {
  assert.strictEqual(job.status, 'done', `${label}: ${job.status} ${JSON.stringify(job.error)}`);
  return job;
}

async function main() {
  const started = Date.now();
  const s = await start();
  try {
    // --- create: no AI, an empty valid bible, the description as source ------------------------------
    let r = await s.api('POST', '/api/projects', {
      title: 'The Night Ferry', description: 'A ferry pilot finds a stowaway. She hides him from the harbour patrol.', pages: 2,
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.job, null);
    const id = r.body.project.id;
    const P = `/api/projects/${id}`;
    const root = path.join(s.home, id, 'production');
    const bibleFile = path.join(root, 'story', 'story-bible.yaml');
    assert.deepStrictEqual(validateWorkspace(root).errors, []);
    const fresh = ws.loadYaml(bibleFile);
    assert.deepStrictEqual(Object.keys(fresh), ['title', 'premise', 'tone', 'world_rules', 'facts', 'characters', 'timeline', 'open_questions']);
    assert.strictEqual(fresh.premise, 'A ferry pilot finds a stowaway. She hides him from the harbour patrol.');
    assert.ok(fs.readFileSync(bibleFile, 'utf8').startsWith('# production/story/story-bible.yaml'), 'the template\'s header comment is kept');
    r = await s.api('GET', P);
    assert.strictEqual(r.body.screens.find((x) => x.key === 'story').summary_code, 'screen.story.text');
    assert.strictEqual(r.body.next.screen, 'style', 'the person can go on to the style with only their text');

    // A project with no description: still valid, the premise is the title until someone writes one.
    r = await s.api('POST', '/api/projects', { title: 'Empty One' });
    assert.strictEqual(r.status, 201);
    const emptyRoot = path.join(s.home, r.body.project.id, 'production');
    assert.deepStrictEqual(validateWorkspace(emptyRoot).errors, []);
    assert.strictEqual(ws.loadYaml(path.join(emptyRoot, 'story', 'story-bible.yaml')).premise, 'Empty One');
    assert.ok(!fs.existsSync(path.join(emptyRoot, 'story', 'source', 'description.md')));
    r = await s.api('POST', `/api/projects/${r.body.project.id}/ops`, { op: 'story.draft', params: {} });
    assert.deepStrictEqual([r.status, r.body.error.code], [409, 'no_story_text'], 'nothing to draft from');

    // --- story.draft: a proposal, and the bible untouched ---------------------------------------------
    // Comments the person wrote in the bible survive the accepted parts.
    const commented = fs.readFileSync(bibleFile, 'utf8')
      .replace('tone: ""', 'tone: ""                 # in a few words')
      .replace('facts: []', 'facts: []   # the canon registry');
    fs.writeFileSync(bibleFile, commented);
    const bibleBefore = fs.readFileSync(bibleFile, 'utf8');
    let job = done(await s.runOp(id, 'story.draft', {}), 'story.draft');
    assert.strictEqual(fs.readFileSync(bibleFile, 'utf8'), bibleBefore, 'a draft writes no canon');
    assert.ok(job.steps.every((x) => !x.commit), 'the proposal step changed no workspace file');
    assert.strictEqual(job.result.questions, 1);
    const draftId = job.result.proposal;
    r = await s.api('GET', `${P}/proposals`);
    assert.deepStrictEqual(r.body.proposals.map((p) => [p.id, p.kind, p.status]), [[draftId, 'draft', 'open']]);
    assert.strictEqual(r.body.proposals[0].counts.pending, job.result.parts);
    r = await s.api('GET', `${P}/story`);
    assert.deepStrictEqual(r.body.proposals.map((p) => p.id), [draftId]);
    r = await s.api('GET', `${P}/proposals/${draftId}`);
    const parts = r.body.proposal.parts;
    const byType = (type) => parts.filter((p) => p.type === type);
    assert.deepStrictEqual([...new Set(parts.map((p) => p.type))], ['premise', 'tone', 'world_rule', 'fact', 'timeline', 'question']);
    assert.ok(byType('fact').some((p) => p.provenance === 'source' && p.source_ref === 'story/source/description.md#p1'));
    assert.ok(byType('fact').some((p) => p.provenance === 'addition'));
    assert.ok(parts.every((p) => p.status === 'pending'));
    assert.ok(fs.existsSync(path.join(s.home, id, '.studio', 'proposals', `${draftId}.json`)));

    // --- decide part by part ----------------------------------------------------------------------------
    const sourceFact = byType('fact').find((p) => p.provenance === 'source');
    const addition = byType('fact').find((p) => p.provenance === 'addition');
    r = await s.api('POST', `${P}/proposals/${draftId}/decide`, { decisions: [{ part: 'P99', decision: 'accept' }] });
    assert.deepStrictEqual([r.status, r.body.error.code], [404, 'part_not_found']);
    r = await s.api('POST', `${P}/proposals/${draftId}/decide`, { decisions: [{ part: addition.id, decision: 'edit' }] });
    assert.deepStrictEqual([r.status, r.body.error.code], [400, 'bad_params'], 'an edit needs its text');
    r = await s.api('POST', `${P}/proposals/${draftId}/decide`, { decisions: [{ part: addition.id, decision: 'maybe' }] });
    assert.strictEqual(r.status, 400);
    r = await s.api('POST', `${P}/proposals/${draftId}/decide`, {
      decisions: [
        { part: byType('tone')[0].id, decision: 'accept' },
        { part: sourceFact.id, decision: 'accept' },
        { part: addition.id, decision: 'edit', text: 'The crossing takes forty minutes.' },
        { part: byType('world_rule')[0].id, decision: 'reject' },
        { part: byType('timeline')[0].id, decision: 'accept' },
        { part: byType('question')[0].id, decision: 'accept', answer: 'She lets him go at dawn.' },
      ],
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.accepted, r.body.rejected, r.body.comments_kept], [5, 1, true]);
    assert.deepStrictEqual(r.body.findings, []);
    assert.strictEqual(!!r.body.commit, HAS_GIT, 'accepting is a history commit');
    assert.strictEqual(r.body.proposal.status, 'open', 'parts are still pending');
    const decided = Object.fromEntries(r.body.proposal.parts.map((p) => [p.id, p]));
    assert.strictEqual(decided[addition.id].status, 'edited');
    assert.strictEqual(decided[addition.id].final_text, 'The crossing takes forty minutes.');
    assert.deepStrictEqual(decided[sourceFact.id].written, { fact: 'FACT_001', provenance: 'source' });
    assert.deepStrictEqual(decided[addition.id].written, { fact: 'FACT_002', provenance: 'user_change' });

    const text = fs.readFileSync(bibleFile, 'utf8');
    assert.ok(text.includes('# in a few words') && text.includes('# the canon registry'), `comments are kept:\n${text}`);
    const bible = yaml.parse(text);
    assert.strictEqual(bible.tone, byType('tone')[0].text);
    assert.deepStrictEqual(bible.world_rules, [], 'a rejected part is not written');
    assert.deepStrictEqual(bible.facts, [
      { id: 'FACT_001', statement: sourceFact.text, provenance: 'source', source_ref: 'story/source/description.md#p1', replaces: null, affects: [] },
      { id: 'FACT_002', statement: 'The crossing takes forty minutes.', provenance: 'user_change', replaces: null, affects: [] },
    ]);
    assert.deepStrictEqual(bible.timeline, [{ order: 1, event: byType('timeline')[0].text, issue: 'ISS_001' }]);
    assert.deepStrictEqual(bible.open_questions, [{ question: byType('question')[0].text, blocking: false, resolution: 'She lets him go at dawn.' }]);
    assert.strictEqual(bible.premise, 'A ferry pilot finds a stowaway. She hides him from the harbour patrol.', 'the premise part is still pending');
    assert.deepStrictEqual(validateWorkspace(root).errors, []);

    r = await s.api('POST', `${P}/proposals/${draftId}/decide`, { decisions: [{ part: sourceFact.id, decision: 'reject' }] });
    assert.deepStrictEqual([r.status, r.body.error.code], [409, 'part_decided']);
    const rest = parts.filter((p) => p.status === 'pending' && !decided[p.id].decided_at).map((p) => ({ part: p.id, decision: 'reject' }));
    r = await s.api('POST', `${P}/proposals/${draftId}/decide`, { decisions: rest });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.proposal.status, 'closed', 'every part decided');
    assert.strictEqual(r.body.commit, null, 'rejecting writes nothing');
    r = await s.api('POST', `${P}/proposals/${draftId}/decide`, { decisions: [{ part: 'P01', decision: 'accept' }] });
    assert.deepStrictEqual([r.status, r.body.error.code], [409, 'proposal_closed']);

    r = await s.api('GET', `${P}/history?limit=50`);
    const entry = r.body.entries.find((e) => e.kind === 'proposal' && e.title_code === 'activity.proposal_decided');
    assert.ok(entry, 'the decision is in the history');
    assert.deepStrictEqual(entry.title_params, { accepted: 5, rejected: 1 });
    assert.deepStrictEqual(entry.files.map((f) => f.path), ['story/story-bible.yaml']);

    // --- complete and suggest -----------------------------------------------------------------------------
    job = done(await s.runOp(id, 'story.complete', {}), 'story.complete');
    r = await s.api('GET', `${P}/proposals/${job.result.proposal}`);
    assert.ok(!r.body.proposal.parts.some((p) => p.type === 'tone'), 'complete leaves out what is there');
    assert.ok(r.body.proposal.parts.some((p) => p.type === 'world_rule'), 'complete proposes what is missing');
    r = await s.api('DELETE', `${P}/proposals/${job.result.proposal}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.proposal.status, 'discarded');
    r = await s.api('DELETE', `${P}/proposals/${job.result.proposal}`);
    assert.deepStrictEqual([r.status, r.body.error.code], [409, 'proposal_closed']);
    r = await s.api('GET', `${P}/proposals?status=discarded`);
    assert.strictEqual(r.body.proposals.length, 1, 'a discarded proposal stays readable');
    r = await s.api('POST', `${P}/ops`, { op: 'story.suggest', params: {} });
    assert.strictEqual(r.status, 400, 'a suggestion needs a request');
    job = done(await s.runOp(id, 'story.suggest', { instruction: 'Suggest an ending.' }), 'story.suggest');
    assert.strictEqual(job.result.parts, 3);
    r = await s.api('GET', `${P}/proposals/${job.result.proposal}`);
    assert.strictEqual(r.body.proposal.instruction, 'Suggest an ending.');
    assert.ok(r.body.proposal.parts.filter((p) => p.type === 'fact').every((p) => p.provenance === 'addition'), 'a suggestion is marked invented');
    r = await s.api('POST', `${P}/proposals/${job.result.proposal}/decide`, { decisions: [{ part: 'P01', decision: 'accept' }] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(ws.loadYaml(bibleFile).facts[2].provenance, 'addition');
    r = await s.api('GET', `${P}/proposals/prop_nothing_here`);
    assert.deepStrictEqual([r.status, r.body.error.code], [404, 'proposal_not_found']);
    r = await s.api('GET', `${P}/proposals/..%2F..%2Fsettings`);
    assert.strictEqual(r.status, 404);

    // A question asked by the AI while drafting pauses the job instead of being decided for the person.
    fs.writeFileSync(path.join(root, 'story', 'source', 'more.md'), 'DECIDE The pilot has a brother.\n');
    job = await s.runOp(id, 'story.draft', { source: 'story/source/more.md' });
    assert.strictEqual(job.status, 'needs_decision');
    r = await s.api('POST', `${P}/jobs/${job.id}/answer`, { answers: { q1: 'The first way' } });
    job = done(await s.waitJob(id, job.id), 'story.draft after an answer');
    assert.ok(job.result.proposal);
    r = await s.api('POST', `${P}/ops`, { op: 'story.draft', params: { source: '../project.yaml' } });
    assert.strictEqual(r.status, 400);

    // --- the chat: story text is a proposal, a direct write is undone ----------------------------------------
    const beforeChat = fs.readFileSync(bibleFile, 'utf8');
    r = await s.api('POST', `${P}/conversation`, { text: 'PROPOSE Her name is Mara.', screen: { key: 'story' } });
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    done(await s.waitJob(id, r.body.job.id), 'chat proposal');
    r = await s.api('GET', `${P}/conversation`);
    let reply = r.body.conversation.messages.filter((m) => m.role === 'assistant').pop();
    assert.ok(reply.proposal && reply.proposal.id, JSON.stringify(reply));
    r = await s.api('GET', `${P}/proposals/${reply.proposal.id}`);
    assert.deepStrictEqual([r.body.proposal.kind, r.body.proposal.parts[0].provenance], ['chat', 'user_change']);
    assert.strictEqual(r.body.proposal.conversation, reply.conversation);
    assert.strictEqual(fs.readFileSync(bibleFile, 'utf8'), beforeChat, 'the chat wrote no canon');
    r = await s.api('POST', `${P}/conversation`, { text: 'WRITEBIBLE add it yourself', screen: { key: 'story' } });
    job = done(await s.waitJob(id, r.body.job.id), 'chat that writes the bible');
    assert.strictEqual(fs.readFileSync(bibleFile, 'utf8'), beforeChat, 'a direct write to the story bible is undone');
    assert.ok(!job.steps[0].changed.includes('story/story-bible.yaml'), 'the undone write is not in the step');
    r = await s.api('GET', `${P}/conversation`);
    reply = r.body.conversation.messages.filter((m) => m.role === 'assistant').pop();
    assert.deepStrictEqual(reply.reverted, ['story/story-bible.yaml']);

    // --- deprecated: "setup": true asks for a draft, as a proposal -------------------------------------------
    r = await s.api('POST', '/api/projects', { title: 'Old Client', description: 'A lighthouse keeper finds a bottle.', pages: 1, setup: true });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.job.op, 'project.setup');
    job = done(await s.waitJob(r.body.project.id, r.body.job.id), 'project.setup');
    assert.ok(job.result.proposal);
    const oldRoot = path.join(s.home, r.body.project.id, 'production');
    assert.deepStrictEqual(ws.loadYaml(path.join(oldRoot, 'story', 'story-bible.yaml')).facts, [], 'the setup writes no fact');
    assert.deepStrictEqual(validateWorkspace(oldRoot).errors, []);

    // --- the parts a tool returns are checked ---------------------------------------------------------------------
    const project = { root, studioDir: path.join(s.home, id, '.studio') };
    const checked = story.partsFrom({
      premise: '  ', facts: [
        { statement: 'Claimed source with no file.', provenance: 'source', source_ref: 'story/source/missing.md' },
        { statement: 'Bad affects.', provenance: 'addition', affects: ['CHAR_MARA', 'not an id'] },
        { provenance: 'addition' },
      ],
      arcs: [{ character: 'mara', arc: 'x' }, { character: 'CHAR_MARA', arc: 'From fear to choice.', role: 'hero' }],
      timeline: [{ order: 2, event: 'Second.' }, { order: 1, event: 'First.' }],
    }, project);
    assert.deepStrictEqual(checked.map((p) => [p.type, p.text, p.provenance || p.role || null]), [
      ['fact', 'Claimed source with no file.', 'addition'],
      ['fact', 'Bad affects.', 'addition'],
      ['arc', 'From fear to choice.', null],
      ['timeline', 'First.', null],
      ['timeline', 'Second.', null],
    ]);
    assert.deepStrictEqual(checked[1].affects, ['CHAR_MARA']);
  } finally {
    await s.close();
  }
  console.log(`studio-story: ok (${Date.now() - started} ms)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
