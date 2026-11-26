#!/usr/bin/env node
'use strict';
/**
 * Refresh the examples in studio/docs/api.md from a real run.
 *
 *   node studio/test-support/record-api-examples.js [--check]
 *
 * It starts the server in fake mode on a temporary home, drives the whole
 * pipeline over HTTP, and writes each recorded response between its markers
 * in the document:
 *
 *   <!-- example:health -->  ...  <!-- /example:health -->
 *
 * Responses are shortened so the document stays readable: long lists keep
 * their first items and end with a "... n more" entry, long strings end
 * with "…", and local paths are replaced by <studio home> and <scaffold>.
 * --check reports markers without a recording and recordings without a
 * marker, and writes nothing.
 */

const fs = require('fs');
const path = require('path');
const { start } = require('./harness');
const { placeholder } = require('../server/fake/images');

const DOC = path.join(__dirname, '..', 'docs', 'api.md');
const SCAFFOLD = path.resolve(__dirname, '..', '..');

const examples = new Map();

/**
 * Shorten a value for the document.
 * opts: maxArray (items kept), maxString (characters kept), maxKeys (keys
 * kept in an object), maxDepth (levels kept below this point), drop (keys
 * left out), keys (options for the value of a named key, at any depth).
 */
const DEFAULT_KEYS = {
  // A parsed YAML document is shown by its first fields: the file itself is in "text".
  data: { maxDepth: 2, maxKeys: 8 },
  // Fourteen checks of the same shape: two are enough to show it.
  checks: { maxKeys: 2 },
};

function shorten(value, opts) {
  const maxArray = opts.maxArray === undefined ? 2 : opts.maxArray;
  const maxString = opts.maxString === undefined ? 150 : opts.maxString;
  if (typeof value === 'string') {
    return value.length > maxString ? `${value.slice(0, maxString)}…` : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (opts.maxDepth !== undefined && opts.maxDepth <= 0) {
    if (Array.isArray(value)) return value.length ? `[${value.length} item${value.length === 1 ? '' : 's'}]` : [];
    return Object.keys(value).length ? '{…}' : {};
  }
  const inner = opts.maxDepth === undefined ? opts : Object.assign({}, opts, { maxDepth: opts.maxDepth - 1 });
  if (Array.isArray(value)) {
    const kept = value.slice(0, maxArray).map((v) => shorten(v, inner));
    if (value.length > maxArray) kept.push(`... ${value.length - maxArray} more`);
    return kept;
  }
  const out = {};
  const names = Object.keys(value).filter((key) => !(opts.drop && opts.drop.includes(key)));
  const limit = opts.maxKeys === undefined ? names.length : opts.maxKeys;
  for (const key of names.slice(0, limit)) {
    const own = Object.assign({}, DEFAULT_KEYS[key] || {}, (opts.keys && opts.keys[key]) || {});
    const keyOpts = Object.keys(own).length ? Object.assign({}, inner, { maxKeys: undefined }, own) : Object.assign({}, inner, { maxKeys: undefined });
    out[key] = shorten(value[key], keyOpts);
  }
  if (names.length > limit) out['...'] = `${names.length - limit} more`;
  return out;
}

/** JSON with small objects and lists kept on one line, so the examples stay short. */
function inline(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
  const rows = Object.entries(value).map(([key, v]) => `${JSON.stringify(key)}: ${inline(v)}`);
  return rows.length ? `{ ${rows.join(', ')} }` : '{}';
}

function pretty(value, indent = '') {
  const flat = inline(value);
  if (value === null || typeof value !== 'object' || flat.length + indent.length <= 110) return flat;
  const next = `${indent}  `;
  const NL = '\n';
  if (Array.isArray(value)) {
    return `[${NL}${value.map((v) => next + pretty(v, next)).join(`,${NL}`)}${NL}${indent}]`;
  }
  const rows = Object.entries(value).map(([key, v]) => `${next}${JSON.stringify(key)}: ${pretty(v, next)}`);
  return `{${NL}${rows.join(`,${NL}`)}${NL}${indent}}`;
}

function cap(name, value, given = {}) {
  if (examples.has(name)) throw new Error(`example ${name} recorded twice`);
  // An operation example shows every step: their ids are part of the contract.
  const opts = name.startsWith('op.')
    ? Object.assign({}, given, { keys: Object.assign({ steps: { maxArray: 16 } }, given.keys || {}) })
    : given;
  examples.set(name, shorten(JSON.parse(JSON.stringify(value === undefined ? null : value)), opts));
}

function jobExample(job) {
  return { params: job.params, steps: job.steps.map((s) => ({ id: s.id, label: s.label, status: s.status })), result: job.result };
}

function done(job, what) {
  if (job.status !== 'done') throw new Error(`${what}: ${job.status} ${JSON.stringify(job.error)}`);
  return job;
}

async function record() {
  const s = await start({ heartbeatMs: 200 });
  const homes = [s.home];
  try {
    const tiny = placeholder({ width: 200, height: 300, label: 'UPLOAD', version: 1 });
    let r = await s.api('GET', '/api/health');
    cap('health', r.body, { maxArray: 6, keys: { models: { maxArray: 1 } } });
    r = await s.api('POST', '/api/tools/refresh', {});
    cap('tools-refresh', r.body, { keys: { models: { maxArray: 2 } } });
    r = await s.api('GET', '/api/ops');
    cap('ops', r.body, { maxArray: 2, keys: { params: { maxArray: 5 } } });
    r = await s.api('GET', '/api/ops?lang=es');
    cap('language-es', { operations: r.body.operations.slice(8, 9) }, { keys: { params: { maxArray: 1 } } });
    r = await s.api('GET', '/api/schemas');
    cap('schemas', r.body, { maxArray: 6 });
    r = await s.api('GET', '/api/schemas/series-plan');
    cap('schema', r.body, { maxArray: 6, maxString: 90 });
    r = await s.api('GET', '/api/presets');
    // The first preset that has a sample page, so the example shows one.
    const withPreview = r.body.presets.findIndex((p) => p.preview);
    if (withPreview > 0) r.body.presets.unshift(r.body.presets.splice(withPreview, 1)[0]);
    cap('presets', r.body, { maxArray: 1, maxString: 110, keys: { choices: { maxArray: 6 }, drift_risks: { maxArray: 2 } } });

    // --- a project ---------------------------------------------------------------
    const createBody = {
      title: 'The Night Ferry',
      description: 'A ferry pilot finds a stowaway the harbour patrol is hunting. She decides not to hand him over.',
      format: 'paged',
      language: 'en',
      pages: 3,
      options: { reading_direction: 'ltr' },
    };
    r = await s.api('POST', '/api/projects', createBody);
    cap('project-create-request', createBody);
    cap('project-create', r.body, { keys: { steps: { maxArray: 3 } } });
    const id = r.body.project.id;
    const P = `/api/projects/${id}`;
    const stream = s.openEvents(id);
    const hello = await stream.waitFor((e) => e.type === 'hello');
    cap('event-hello', hello.data, { keys: { steps: { maxArray: 1 } } });
    r = await s.api('GET', '/api/projects');
    cap('projects', r.body);
    r = await s.api('GET', `${P}/story`);
    cap('story-new', r.body, { maxString: 120, keys: { facts: { maxArray: 1 } } });

    // --- the story: a draft proposal, decided part by part --------------------------------------------
    let job = done(await s.runOp(id, 'story.draft', {}), 'story.draft');
    cap('op.story.draft', jobExample(job));
    const draftId = job.result.proposal;
    r = await s.api('GET', `${P}/proposals/${draftId}`);
    cap('proposal', r.body, { maxArray: 4, maxString: 120 });
    const parts = r.body.proposal.parts;
    const pick = (type, n = 0) => parts.filter((p) => p.type === type)[n];
    const decideBody = {
      decisions: [
        { part: pick('premise').id, decision: 'accept' },
        { part: pick('tone').id, decision: 'edit', text: 'Quiet and tense, with dry humour.' },
        { part: pick('world_rule').id, decision: 'reject' },
        { part: pick('fact').id, decision: 'accept' },
        { part: pick('fact', 1).id, decision: 'accept' },
        { part: pick('timeline').id, decision: 'accept' },
        { part: pick('question').id, decision: 'accept', answer: 'She lets him go at dawn.' },
      ],
    };
    r = await s.api('POST', `${P}/proposals/${draftId}/decide`, decideBody);
    cap('proposal-decide-request', decideBody);
    cap('proposal-decide', r.body, { maxArray: 2, maxString: 100 });
    job = done(await s.runOp(id, 'story.complete', {}), 'story.complete');
    cap('op.story.complete', jobExample(job));
    r = await s.api('DELETE', `${P}/proposals/${job.result.proposal}`);
    cap('proposal-discard', r.body, { maxArray: 1, maxString: 100 });
    job = done(await s.runOp(id, 'story.suggest', { instruction: 'Suggest an ending.' }), 'story.suggest');
    cap('op.story.suggest', jobExample(job));
    r = await s.api('GET', `${P}/proposals`);
    cap('proposals', r.body, { maxArray: 3 });
    r = await s.api('GET', `${P}/story`);
    cap('story', r.body, { maxString: 120, keys: { facts: { maxArray: 1 }, proposals: { maxArray: 1 } } });
    r = await s.api('PUT', `${P}/options`, { repair_limit: 1, reading_direction: 'ltr' });
    cap('options-put', r.body);
    r = await s.api('GET', `${P}/options`);
    cap('options', r.body, { maxString: 120, maxArray: 3, drop: ['data'] });
    r = await s.api('GET', `${P}/settings`);
    cap('settings', r.body, { maxArray: 4 });
    r = await s.api('PUT', `${P}/settings`, { language: 'en', models: { claude: { look: 'sonnet' } } });
    cap('settings-put', r.body);

    // --- uploads and text files -------------------------------------------------------
    const styleRef = await s.upload(id, 'style reference.png', tiny, 'image/png');
    cap('upload', { upload: styleRef });
    r = await s.api('GET', `${P}/uploads`);
    cap('uploads', r.body);
    r = await s.api('GET', `${P}/file?path=story/series-plan.yaml`);
    cap('file-get', r.body, { maxString: 200 });
    const etag = r.body.file.etag;
    r = await s.api('PUT', `${P}/file`, { path: 'story/series-plan.yaml', text: r.body.file.text.replace(/(\n\s+title: )The Night Ferry/, '$1Crossing'), base_etag: etag });
    cap('file-put', r.body, { maxString: 120 });
    if (r.body.commit) {
      const diff = await s.api('GET', `${P}/diff?commit=${r.body.commit}`);
      cap('diff', diff.body, { maxString: 160 });
    }
    r = await s.api('PUT', `${P}/file`, { path: 'story/series-plan.yaml', text: 'title: "unclosed\nissues: []\n' });
    cap('file-put-yaml-error', r.body);
    r = await s.api('PUT', `${P}/file`, { path: 'story/series-plan.yaml', text: 'title: The Night Ferry\nissues:\n  - id: ISS_1\n    number: 1\n    title: Crossing\n    page_budget: 3\n    status: planning\n' });
    cap('file-put-findings', { findings: r.body.findings, saved: r.body.saved });
    r = await s.api('PUT', `${P}/file`, { path: 'story/series-plan.yaml', text: 'title: The Night Ferry\nissues:\n  - id: ISS_001\n    number: 1\n    title: Crossing\n    page_budget: 3\n    status: planning\n' });

    // --- style ---------------------------------------------------------------------------
    job = done(await s.runOp(id, 'style.define', { preset: 'noir-ink', description: 'Heavy ink and wet streets.', uploads: [styleRef.id] }), 'style.define');
    cap('op.style.define', jobExample(job));
    r = await s.api('POST', `${P}/ops`, { op: 'style.look', params: {} });
    cap('op-start', r.body);
    job = done(await s.waitJob(id, r.body.job.id), 'style.look');
    cap('op.style.look', jobExample(job));
    r = await s.api('POST', `${P}/approve/asset`, { candidate: 'LOOK_NOIR_INK_V01', note: 'This is the look.' });
    cap('approve-asset', r.body, { maxArray: 4 });
    r = await s.api('GET', `${P}/style`);
    cap('style', r.body, {
      maxArray: 1, maxString: 100,
      keys: { presets: { maxDepth: 0 }, masters: { maxDepth: 0 }, packages: { maxDepth: 2 }, choices: { maxDepth: 0 }, options: { maxDepth: 0 } },
    });

    // --- characters ------------------------------------------------------------------------
    const photo = await s.upload(id, 'mara.png', tiny, 'image/png');
    job = done(await s.runOp(id, 'character.create', { name: 'Mara', description: 'Ferry pilot in her fifties, grey cropped hair.', uploads: [photo.id] }), 'character.create');
    cap('op.character.create', jobExample(job));
    await s.api('POST', `${P}/approve/asset`, { candidate: 'CHAR_MARA_TURN_V01' });
    job = done(await s.runOp(id, 'character.update', { character: 'CHAR_MARA', instruction: 'She has a broken nose.' }), 'character.update');
    cap('op.character.update', jobExample(job));
    job = done(await s.runOp(id, 'character.sheet', { character: 'CHAR_MARA', sheet: 'expressions' }), 'character.sheet');
    cap('op.character.sheet', jobExample(job));
    r = await s.api('GET', `${P}/characters`);
    cap('characters', r.body);
    r = await s.api('GET', `${P}/characters/CHAR_MARA`);
    cap('character', r.body, { maxArray: 1, maxString: 100, keys: { assets: { maxDepth: 3 }, sheets: { maxDepth: 2 }, packages: { maxDepth: 2 } } });

    // --- pages -----------------------------------------------------------------------------
    job = done(await s.runOp(id, 'pages.plan', { text: 'Mara crosses the river alone at night. FLAG She hears the crates shift and goes down to the deck. NOTE She finds the boy and decides to hide him.', pages: 3 }), 'pages.plan');
    cap('op.pages.plan', jobExample(job), { maxArray: 6, keys: { pages: { maxArray: 1 } } });
    job = done(await s.runOp(id, 'entities.derive', { issue: 'ISS_001' }), 'entities.derive');
    cap('op.entities.derive', jobExample(job));
    r = await s.api('GET', `${P}/entities`);
    cap('entities', r.body);
    r = await s.api('GET', `${P}/locations/LOC_MAIN_ROOM`);
    cap('location', r.body, { maxArray: 1, maxString: 100, keys: { assets: { maxDepth: 1 }, map: { maxDepth: 1 } } });
    r = await s.api('POST', `${P}/ops`, { op: 'pages.generate', params: { issue: 'ISS_001' } });
    cap('error-plan-not-approved', r.body);
    r = await s.api('POST', `${P}/approve/plan`, { pages: ['PG_001_001', 'PG_001_002', 'PG_001_003'] });
    cap('approve-plan', r.body, { maxArray: 3 });
    r = await s.api('POST', `${P}/ops`, { op: 'pages.generate', params: { issue: 'ISS_001' } });
    const generateId = r.body.job.id;
    const running = await stream.waitFor((e) => e.type === 'job' && e.data.job.id === generateId && e.data.job.status === 'running' && e.data.job.current_step);
    cap('event-job', running.data, { maxArray: 3 });
    job = done(await s.waitJob(id, generateId, 60000), 'pages.generate');
    cap('op.pages.generate', jobExample(job), { maxArray: 20, keys: { pages: { maxArray: 2 } } });
    cap('job', { job }, { maxArray: 4, keys: { pages: { maxArray: 1 }, params: { maxArray: 3 } } });
    r = await s.api('GET', `${P}/settings`);
    cap('settings-timings', { timings: r.body.timings }, { maxArray: 4 });
    r = await s.api('GET', `${P}/jobs?limit=2`);
    cap('jobs', r.body, { maxArray: 1, keys: { steps: { maxArray: 1 }, pages: { maxArray: 1 }, commits: { maxArray: 1 } } });
    r = await s.api('GET', `${P}/jobs/${generateId}/log?tail=6`);
    cap('job-log', r.body, { maxArray: 6 });
    cap('event-log', stream.events.find((e) => e.type === 'log' && /writing/.test(e.data.line)).data);
    cap('event-files', stream.events.find((e) => e.type === 'files' && e.data.job === generateId).data);
    cap('event-activity', stream.events.find((e) => e.type === 'activity' && e.data.entry.job === generateId && e.data.entry.images.length).data);
    cap('event-heartbeat', (await stream.waitFor((e) => e.type === 'heartbeat')).data);

    r = await s.api('GET', `${P}/issues`);
    cap('issues', r.body);
    r = await s.api('GET', `${P}/issues/ISS_001`);
    cap('issue', r.body, { maxArray: 1, maxString: 110, keys: { text: { maxString: 80 } } });
    r = await s.api('GET', `${P}/pages/PG_001_002`);
    const noted = await s.api('GET', `${P}/pages/PG_001_003`);
    cap('review-notes', noted.body.renders[0].review, { maxArray: 2 });
    cap('page', r.body, {
      maxArray: 1, maxString: 110,
      keys: { renders: { maxArray: 2 }, tiers: { maxArray: 4 }, prompts: { maxDepth: 2 }, lettering: { maxDepth: 2 }, entries: { maxArray: 1 } },
    });

    job = done(await s.runOp(id, 'page.review', { page: 'PG_001_003' }), 'page.review');
    cap('op.page.review', jobExample(job));
    job = done(await s.runOp(id, 'page.correct', {
      page: 'PG_001_001', text: 'The lamp over the wheel must be lit.', panel: 'PN_001_001_02', region: { x: 0.1, y: 0.5, w: 0.3, h: 0.2 },
    }), 'page.correct edit');
    cap('op.page.correct', jobExample(job));
    job = done(await s.runOp(id, 'page.correct', { page: 'PG_001_002', text: 'The boy must wear his hood up.' }), 'page.correct redraw');
    cap('op.page.correct.redraw', jobExample(job));
    r = await s.api('POST', `${P}/approve/page`, { page: 'PG_001_001' });
    cap('approve-page', r.body);

    // --- needs_decision and cancel -----------------------------------------------------------
    r = await s.api('POST', `${P}/ops`, { op: 'story.update', params: { instruction: 'DECIDE whether the patrol knows the boy by name.' } });
    job = await s.waitJob(id, r.body.job.id);
    cap('job-needs-decision', { job }, { maxArray: 3 });
    r = await s.api('POST', `${P}/jobs/${job.id}/answer`, { answers: { q1: 'The second way' } });
    cap('job-answer', r.body, { maxArray: 3 });
    cap('op.story.update', jobExample(done(await s.waitJob(id, job.id), 'story.update')));
    process.env.STUDIO_FAKE_SLOW_MS = '20000';
    r = await s.api('POST', `${P}/ops`, { op: 'story.update', params: { instruction: 'SLOW change that will be cancelled.' } });
    const slowId = r.body.job.id;
    await stream.waitFor((e) => e.type === 'job' && e.data.job.id === slowId && e.data.job.status === 'running');
    await s.api('POST', `${P}/jobs/${slowId}/cancel`, {});
    job = await s.waitJob(id, slowId);
    cap('job-cancel', { job }, { maxArray: 3 });

    // --- cover ----------------------------------------------------------------------------------
    job = done(await s.runOp(id, 'cover.create', { description: 'Mara at the wheel at night, the river behind her.' }), 'cover.create');
    cap('op.cover.create', jobExample(job));
    job = done(await s.runOp(id, 'cover.create', {}), 'cover.create existing');
    cap('op.cover.create.existing', jobExample(job));
    job = done(await s.runOp(id, 'cover.correct', { issue: 'ISS_001', text: 'Make the title larger.', lettering: true }), 'cover.correct');
    cap('op.cover.correct', jobExample(job));
    r = await s.api('POST', `${P}/approve/cover`, { issue: 'ISS_001' });
    cap('approve-cover', r.body);
    r = await s.api('GET', `${P}/issues/ISS_001/cover`);
    cap('cover', r.body, { maxArray: 1, maxString: 100, keys: { prompts: { maxDepth: 0 } } });

    // --- publish ---------------------------------------------------------------------------------
    job = done(await s.runOp(id, 'publish.build', { issue: 'ISS_001', formats: ['pdf', 'cbz', 'epub', 'web', 'images'] }), 'publish.build');
    cap('op.publish.build', jobExample(job), { maxArray: 5 });
    r = await s.api('GET', `${P}/issues/ISS_001/publish`);
    cap('publish', r.body, { maxArray: 2, keys: { formats: { maxArray: 5 }, exports: { maxArray: 3 } } });

    // --- the project conversation -------------------------------------------------------------------
    const sendBody = { text: 'EDIT bring the last panel closer', screen: { key: 'page:PG_001_003', label: 'Page 3', route: `/p/${id}/pages/PG_001_003` } };
    r = await s.api('POST', `${P}/conversation`, sendBody);
    cap('conversation-post-request', sendBody);
    cap('conversation-post', r.body, { maxArray: 1, drop: ['steps'] });
    job = done(await s.waitJob(id, r.body.job.id), 'chat.turn');
    cap('op.chat.turn', jobExample(job));
    cap('event-chat', stream.events.filter((e) => e.type === 'chat').pop().data);
    r = await s.api('POST', `${P}/conversation`, { text: 'LINK PROPOSE Where do I add the boy? He is twelve.', screen: { key: 'style', label: 'Style', route: `/p/${id}/style` } });
    done(await s.waitJob(id, r.body.job.id), 'chat.turn with links');
    await s.api('PUT', `${P}/settings`, { drivers: { plan: 'codex' } });
    r = await s.api('POST', `${P}/conversation`, { text: 'Is the cover ready?', screen: { key: 'cover:ISS_001' } });
    done(await s.waitJob(id, r.body.job.id), 'chat.turn with codex');
    await s.api('PUT', `${P}/settings`, { drivers: { plan: 'claude' } });
    r = await s.api('GET', `${P}/conversation`);
    const convMessages = r.body.conversation.messages;
    const linked = convMessages.find((m) => m.role === 'assistant' && m.links && m.links.length);
    const changed = convMessages.find((m) => m.role === 'event' && m.event === 'tool_changed');
    cap('conversation', Object.assign({}, r.body, {
      conversation: Object.assign({}, r.body.conversation, { messages: [convMessages[0], convMessages[1], linked, changed] }),
    }), { maxString: 160, keys: { messages: { maxArray: 4 } } });
    r = await s.api('GET', `${P}/chats/page:PG_001_003`);
    cap('chat', r.body);
    r = await s.api('GET', `${P}/chats`);
    cap('chats', r.body);
    r = await s.api('POST', `${P}/chats/style`, { text: 'Sent the old way.' });
    cap('chat-post', r.body, { maxArray: 1, drop: ['steps'] });
    done(await s.waitJob(id, r.body.job.id), 'chat.turn old route');
    const oldConversation = convMessages[0].conversation;
    r = await s.api('POST', `${P}/conversation/new`, {});
    cap('conversation-new', r.body);
    r = await s.api('GET', `${P}/conversations`);
    cap('conversations', r.body);
    r = await s.api('GET', `${P}/conversations/${oldConversation}`);
    cap('conversation-old', r.body, { maxArray: 2, maxString: 120 });

    // --- history -------------------------------------------------------------------------------------
    r = await s.api('GET', `${P}/history?limit=3`);
    cap('history', r.body, { maxArray: 3, keys: { entries: { maxArray: 2 } } });
    const all = await s.api('GET', `${P}/history?limit=500`);
    const target = all.body.entries.find((e) => e.kind === 'approval' && e.title_code === 'activity.approved_cover');
    const drew = all.body.entries.find((e) => e.step === 'PG_001_003:draw' && e.commit);
    if (drew) {
      const diff = await s.api('GET', `${P}/diff?commit=${drew.commit}`);
      cap('diff-image', diff.body, { maxArray: 4, maxString: 90 });
    }
    if (target && target.restorable) {
      r = await s.api('POST', `${P}/history/restore`, { entry: target.id });
      cap('restore', r.body, { maxArray: 2 });
      await s.api('POST', `${P}/history/restore`, { commit: all.body.entries[0].commit });
    }

    // --- errors ---------------------------------------------------------------------------------------
    r = await s.api('GET', `${P}/pages/PG_001_099`);
    cap('error-404', r.body);
    r = await s.api('GET', `${P}/pages/PG_001_099?lang=es`);
    cap('error-404-es', r.body);
    r = await s.api('POST', `${P}/ops`, { op: 'pages.plan', params: { pages: 99, text: 'x' } });
    cap('error-400', r.body);
    r = await s.api('POST', `${P}/ops`, { op: 'style.define', params: { description: 'Something else' } });
    cap('error-409', r.body);

    r = await s.api('GET', P);
    cap('overview', r.body, { maxArray: 3, maxString: 120, keys: { screens: { maxArray: 2 } } });
    stream.close();

    // --- a flagged page and overlay lettering, in a second project --------------------------------------
    const other = await s.seedProject('Overlay Letters', { options: { lettering_mode: 'overlay' } });
    const Q = `/api/projects/${other}`;
    done(await s.runOp(other, 'pages.plan', { text: 'Mara reads the letter aloud. FLAGALWAYS Nobody answers.', pages: 2 }), 'pages.plan');
    job = done(await s.runOp(other, 'pages.generate', { issue: 'ISS_001', approve_plans: true }, 60000), 'pages.generate');
    cap('result-flagged-page', job.result.pages[1]);
    r = await s.api('POST', `${Q}/approve/page`, { page: 'PG_001_002' });
    cap('error-review-flagged', r.body);
    r = await s.api('POST', `${Q}/approve/page`, { page: 'PG_001_002', overrule: true, note: 'It reads fine to me.' });
    cap('approve-page-overrule', r.body);
    r = await s.api('GET', `${Q}/pages/PG_001_002`);
    cap('review-overruled', r.body.renders[r.body.renders.length - 1].review, { maxArray: 2, drop: ['compared_against'] });
    r = await s.api('GET', `${Q}/issues/ISS_001`);
    cap('page-summary-overruled', r.body.pages.find((p) => p.id === 'PG_001_002'));
    job = done(await s.runOp(other, 'lettering.apply', { issue: 'ISS_001' }), 'lettering.apply');
    cap('op.lettering.apply', jobExample(job), { keys: { pages: { maxArray: 1 }, warnings: { maxArray: 1 } } });
    r = await s.api('GET', `${Q}/pages/PG_001_001/lettering`);
    cap('lettering-get', r.body, { maxString: 260, maxArray: 1 });
    const lettered = placeholder({ width: 400, height: 600, label: 'LETTERED', version: 1 });
    r = await s.raw('POST', `${Q}/pages/PG_001_001/lettered?render=PG_001_001_V01`, lettered, { 'Content-Type': 'image/png' });
    cap('lettered-post', JSON.parse(r.buffer.toString()));
    r = await s.api('DELETE', Q);
    cap('project-delete', r.body);

    // --- deprecated: a client that still asks for the setup when it creates a project ---------------------
    r = await s.api('POST', '/api/projects', { title: 'Old Client', description: 'A lighthouse keeper finds a bottle with a map in it.', pages: 1, setup: true });
    cap('op.project.setup', jobExample(done(await s.waitJob(r.body.project.id, r.body.job.id), 'project.setup')));
  } finally {
    await s.close();
  }

  // --- the manual handoff, on a machine with no drawing tool ----------------------------------------------
  const m = await start({ fakeTools: ['claude'] });
  homes.push(m.home);
  try {
    let r = await m.api('POST', '/api/projects', { title: 'By Hand', description: 'A short story made without a drawing tool.', pages: 1 });
    const id = r.body.project.id;
    done(await m.runOp(id, 'style.define', { description: 'Soft pencil, warm paper.' }), 'style.define');
    let upload = await m.upload(id, 'look.png', placeholder({ width: 400, height: 600, label: 'HAND', version: 1 }), 'image/png');
    let job = done(await m.runOp(id, 'page.manual', { entity: 'LOOK_SOFT_PENCIL_WARM', sheet: 'look', upload: upload.id }), 'look upload');
    await m.api('POST', `/api/projects/${id}/approve/asset`, { candidate: job.result.candidate_id });
    done(await m.runOp(id, 'character.create', { name: 'Nell', description: 'A lighthouse keeper.' }), 'character.create');
    upload = await m.upload(id, 'nell.png', placeholder({ width: 400, height: 400, label: 'NELL', version: 1 }), 'image/png');
    job = done(await m.runOp(id, 'page.manual', { entity: 'CHAR_NELL', sheet: 'turnaround', upload: upload.id }), 'sheet upload');
    await m.api('POST', `/api/projects/${id}/approve/asset`, { candidate: job.result.candidate_id });
    done(await m.runOp(id, 'pages.plan', { text: 'Nell climbs the stairs with the lamp.', pages: 1 }), 'pages.plan');
    r = await m.api('POST', `/api/projects/${id}/ops`, { op: 'pages.generate', params: { issue: 'ISS_001', approve_plans: true } });
    cap('error-no-draw-tool', r.body);
    job = done(await m.runOp(id, 'page.manual', { page: 'PG_001_001' }), 'handoff');
    cap('op.page.manual', jobExample(job), { maxString: 240 });
    upload = await m.upload(id, 'page1.png', placeholder({ width: 400, height: 600, label: 'PAGE', version: 1 }), 'image/png');
    job = done(await m.runOp(id, 'page.manual', { page: 'PG_001_001', upload: upload.id }), 'page upload');
    cap('op.page.manual.upload', jobExample(job));
  } finally {
    await m.close();
  }
  return homes;
}

/** Replace local paths so the document carries none. */
function sanitize(text, homes) {
  let out = text;
  const variants = (p) => [p, p.split(path.sep).join('/'), p.split(path.sep).join('\\\\')];
  for (const home of homes) {
    for (const v of variants(home)) out = out.split(v).join('<studio home>');
  }
  for (const v of variants(SCAFFOLD)) out = out.split(v).join('<scaffold>');
  // Whatever is left of a path under a temp or home directory.
  out = out.replace(/[A-Za-z]:(?:\\\\|\/)[^"\s]*?(?=<studio home>|<scaffold>)/g, '');
  return out.replace(/<studio home>\\\\/g, '<studio home>/').replace(/(<studio home>[^"]*)/g, (m) => m.replace(/\\\\/g, '/'));
}

async function main() {
  const check = process.argv.includes('--check');
  const homes = await record();
  const dumpAt = process.argv.indexOf('--dump');
  if (dumpAt !== -1 && process.argv[dumpAt + 1]) {
    // Every recording in one file, for whoever writes the prose around them.
    const all = {};
    for (const [name, value] of examples) all[name] = value;
    fs.writeFileSync(process.argv[dumpAt + 1], sanitize(JSON.stringify(all, null, 2), homes));
  }
  let doc = fs.readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n');
  const marker = /<!-- example:([a-z0-9.-]+) -->[\s\S]*?<!-- \/example:\1 -->/g;
  const inDoc = new Set();
  doc = doc.replace(marker, (whole, name) => {
    inDoc.add(name);
    if (!examples.has(name)) return whole;
    const json = sanitize(pretty(examples.get(name)), homes);
    return `<!-- example:${name} -->\n\`\`\`json\n${json}\n\`\`\`\n<!-- /example:${name} -->`;
  });
  const unused = [...examples.keys()].filter((name) => !inDoc.has(name));
  const missing = [...inDoc].filter((name) => !examples.has(name));
  if (missing.length) console.log(`markers with no recording: ${missing.join(', ')}`);
  if (unused.length) console.log(`recordings with no marker: ${unused.join(', ')}`);
  if (check) {
    process.exitCode = missing.length ? 1 : 0;
    return;
  }
  fs.writeFileSync(DOC, doc);
  console.log(`studio/docs/api.md: ${inDoc.size - missing.length} example(s) refreshed`);
  if (missing.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
