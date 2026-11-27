'use strict';
/**
 * What the chat can do: the action catalog, the cards a reply proposes, and
 * the results that come back into the conversation.
 *
 * The catalog has two kinds of action. Every operation of
 * studio/server/ops/ except chat.turn is an action with the operation's own
 * `params` and `validate`, run as a job through the normal queue. The rest
 * are the decisions and commands the screens make without a job (approvals,
 * a story proposal decided, the project options, answering or cancelling a
 * job, a new issue); they are defined here once, and the API routes of the
 * screens call the same `run`, so a click on a screen and a card in the
 * chat do exactly the same thing.
 *
 * The model proposes, the server runs. A chat reply may return
 * data.actions: [{ action, params, why }]. Each one is checked with the
 * action's validate and stored as a card on the assistant message (see
 * conversation.js): what it will do, which tool and model, how long it
 * usually takes. A card runs when the person clicks Run, or when they confirm
 * in words and the next reply returns data.run_actions with its id. Nothing
 * that draws, approves, decides or answers ever runs by itself. Text-only
 * actions run at once only when the project's `chat_auto_run` setting is on.
 *
 * When a job started from a card settles, the card takes its outcome and an
 * event message goes into the conversation that started it: the outcome, the
 * images it made, links to the screens where they can be approved, the
 * questions of a paused job, the story proposal it left. A job that paused
 * because a tool ran out of its usage quota says so in plain words, with
 * when it may come back and what waits (job.resume picks it up again).
 *
 * In guide mode (studio/server/guide.js) every settled card is followed by
 * the guide's next message, without the person having to ask.
 */

const S = require('./scaffold');
const ops = require('./ops');
const files = require('./files');
const story = require('./story');
const issues = require('./issues');
const screens = require('./screens');
const history = require('./history');
const approvals = require('./approvals');
const conversation = require('./conversation');
const projectOptions = require('./project-options');
const deletion = require('./deletion');
const entityEdit = require('./entity-edit');
const letteringPlan = require('./lettering-plan');
const { msg } = require('./i18n');
const { HttpError, errorText, newId, nowIso } = require('./util');

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const MAX_CARDS = 6;
/**
 * Actions that wait for a click even when the person's message asked for
 * them in so many words: a delete, and a merge, which drops the sheets of
 * the merged entity.
 */
const ALWAYS_CONFIRM = ['delete', 'entity.merge'];
/**
 * Corrections that may need the person's choice: once an image has reached
 * the touch-up warning of the project, the card offers "touch up anyway" and
 * "redraw with the change" instead of Run (ops/correction.js).
 */
const CHOICE_ACTIONS = ['page.correct', 'cover.correct'];

// --- the operations, as actions -------------------------------------------------

const never = () => false;
const always = () => true;
/**
 * What each operation uses and whether it draws. `verbs` are the jobs of the
 * tools it calls (plan, look, draw), for the card's "which tool and model".
 * `text` marks the quick runs that only write text: the only ones the
 * chat_auto_run setting may start without a click.
 */
const OP_TRAITS = {
  'project.setup': { verbs: () => ['plan'], draws: never, text: always },
  'story.update': { verbs: () => ['plan'], draws: never, text: always },
  'story.draft': { verbs: () => ['plan'], draws: never, text: always },
  'story.complete': { verbs: () => ['plan'], draws: never, text: always },
  'story.suggest': { verbs: () => ['plan'], draws: never, text: always },
  'style.define': { verbs: () => ['plan'], draws: never, text: always },
  'style.look': { verbs: () => ['draw'], draws: always, text: never },
  'character.create': { verbs: (p) => (p.draw === false ? ['plan'] : ['plan', 'draw']), draws: (p) => p.draw !== false, text: (p) => p.draw === false },
  'character.update': { verbs: (p) => (p.draw === true ? ['plan', 'draw'] : ['plan']), draws: (p) => p.draw === true, text: (p) => p.draw !== true },
  // A revision round first rewrites the character file (the writing tool), then draws.
  'character.sheet': { verbs: (p) => (p.revise && p.update_file !== false ? ['plan', 'draw'] : ['draw']), draws: always, text: never },
  'entities.derive': { verbs: (p) => (p.plates === true ? ['plan', 'draw'] : ['plan']), draws: (p) => p.plates === true, text: (p) => p.plates !== true },
  'pages.plan': { verbs: () => ['plan'], draws: never, text: always },
  'pages.generate': { verbs: () => ['draw', 'look'], draws: always, text: never },
  'page.review': { verbs: () => ['look'], draws: never, text: never },
  'page.correct': { verbs: () => ['draw', 'look'], draws: always, text: never },
  'page.manual': { verbs: (p) => (p.upload ? ['look'] : []), draws: never, text: never },
  'cover.create': { verbs: (p) => (p.draw === false ? ['plan'] : ['plan', 'draw', 'look']), draws: (p) => p.draw !== false, text: (p) => p.draw === false },
  'cover.correct': { verbs: () => ['draw', 'look'], draws: always, text: never },
  'lettering.apply': { verbs: () => ['plan'], draws: never, text: always },
  'publish.build': { verbs: () => [], draws: never, text: never },
};

/**
 * How long a job usually takes when nothing was measured in the project yet:
 * the figures of the measured run in studio/README.md, in milliseconds.
 * `page` is per page.
 */
const REFERENCE_MS = {
  'project.setup': { ms: 92000 },
  'story.update': { ms: 90000 },
  'story.draft': { ms: 92000 },
  'story.complete': { ms: 92000 },
  'story.suggest': { ms: 60000 },
  'style.define': { ms: 152000 },
  'style.look': { ms: 157000 },
  'character.create': { ms: 165000 },
  'character.update': { ms: 90000 },
  'character.sheet': { ms: 150000 },
  'entities.derive': { ms: 120000 },
  'pages.plan': { page: 248000 },
  'pages.generate': { page: 957000 },
  'page.review': { ms: 60000 },
  'page.correct': { ms: 400000 },
  'page.manual': { ms: 5000 },
  'cover.create': { ms: 491000 },
  'cover.correct': { ms: 400000 },
  'lettering.apply': { ms: 120000 },
  'publish.build': { ms: 5000 },
};

// --- the actions that are not jobs --------------------------------------------------

/** The workspace directory of an entity: characters/<ID>, locations/<ID>, props/<ID>, or references/style for a look. */
function entityDir(entityId) {
  const refs = S.assetPaths.refsDir(String(entityId || ''));
  if (!refs) return null;
  return refs === 'references/style' ? refs : refs.replace(/\/refs$/, '');
}

function text(params, name, { required = false, max = 2000 } = {}) {
  const value = params[name];
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, 'bad_params', `"${name}" is required.`);
    return undefined;
  }
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, 'bad_params', `"${name}" must be text of at most ${max} characters.`);
  return value.trim();
}

function flag(params, name) {
  const value = params[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new HttpError(400, 'bad_params', `"${name}" must be true or false.`);
  return value;
}

/** A merge or a rename rewrites files a running job may be writing: it waits for the job. */
function requireIdle(services, project) {
  const running = services.jobs.running(project);
  if (running && running.op !== 'chat.turn') {
    throw new HttpError(409, 'project_busy', `A job is running (${running.op}). Wait for it to finish, then try again.`);
  }
}

function checkJob(services, project, params) {
  const id = text(params, 'job', { required: true, max: 80 });
  services.jobs.getRaw(project, id);
  return id;
}

/**
 * name -> { params, validate(params, { project, services }), run(services, project, params) }.
 * run returns what the matching API route answers.
 */
const DIRECT = {
  'approve.asset': {
    params: [
      { name: 'candidate', type: 'string', required: true, description: 'The candidate to approve: its ID (CHAR_MARA_TURN_V01, LOOK_NOIR_INK_V01, LOC_DOCK_PLATE_V01) or its workspace path. A look page approved freezes the style.' },
      { name: 'supersede', type: 'boolean', required: false, description: 'Replace a master that is already approved for the same sheet (default false).' },
      { name: 'note', type: 'string', required: false, description: 'A note kept with the approval.' },
    ],
    validate(p) {
      return { candidate: text(p, 'candidate', { required: true, max: 300 }), supersede: flag(p, 'supersede'), note: text(p, 'note', { max: 1000 }) };
    },
    async run(services, project, body) {
      let result;
      const saved = await history.record(services, project, {
        kind: 'approval',
        title: msg('activity.approved_asset', { candidate: String(body.candidate || '').split('/').pop() }),
        // The master, the registry, the entity's own directory (its file, its wardrobe), and project.yaml for a look.
        scope: (res) => (res ? [res.file, 'references/manifest.yaml', 'project.yaml', entityDir(res.entity)] : []),
      }, () => {
        result = approvals.approveAsset(project, body);
        return result;
      });
      return Object.assign({}, result, { image: files.image(project, result.file), style_frozen: result.kind === 'look', commit: saved.commit });
    },
  },

  'approve.plan': {
    params: [
      { name: 'pages', type: 'string[]', required: true, description: 'Page IDs whose plans the person has read and approves.' },
      { name: 'approved', type: 'boolean', required: false, description: 'false withdraws the approval (default true).' },
    ],
    validate(p) {
      if (!Array.isArray(p.pages) || !p.pages.length || p.pages.some((x) => typeof x !== 'string')) {
        throw new HttpError(400, 'bad_params', '"pages" must be a list of page IDs.');
      }
      return { pages: p.pages.slice(0, 200), approved: flag(p, 'approved') };
    },
    async run(services, project, body) {
      project.ensureStudioDirs();
      const result = approvals.approvePlans(project, body);
      const activity = project.addActivity({
        kind: 'approval',
        title: msg(body.approved === false ? 'activity.plan_unapproved' : 'activity.plan_approved', { pages: result.pages.map((p) => p.page) }),
        actor: 'person',
      });
      services.events.emit(project.id, 'activity', { entry: activity });
      return result;
    },
  },

  'approve.page': {
    params: [
      { name: 'page', type: 'string', required: true, description: 'Page ID.' },
      { name: 'render', type: 'string', required: false, description: 'The version to approve. Default: the current one.' },
      { name: 'overrule', type: 'boolean', required: false, description: 'Approve a page whose check is flagged, accepting its open findings (only when the person says so).' },
      { name: 'note', type: 'string', required: false, description: 'Why the person accepts it as drawn.' },
    ],
    validate(p) {
      return { page: text(p, 'page', { required: true, max: 40 }), render: text(p, 'render', { max: 40 }), overrule: flag(p, 'overrule'), note: text(p, 'note', { max: 1000 }) };
    },
    async run(services, project, body) {
      let result;
      const pageId = String(body.page || '');
      const saved = await history.record(services, project, {
        kind: 'approval', title: msg('activity.approved_page', { page: pageId }),
        scope: S.ws.ID.page.test(pageId) ? [S.ws.rel(project.root, S.ws.pageDir(project.root, pageId))] : [],
      }, () => {
        result = approvals.approvePage(project, body);
      });
      return Object.assign({}, result, { commit: saved.commit });
    },
  },

  'approve.cover': {
    params: [
      { name: 'issue', type: 'string', required: false, description: 'Issue ID. Default ISS_001.' },
      { name: 'render', type: 'string', required: false, description: 'The cover version to approve. Default: the newest one.' },
      { name: 'overrule', type: 'boolean', required: false, description: 'Approve a cover whose check is flagged (only when the person says so).' },
      { name: 'note', type: 'string', required: false, description: 'Why the person accepts it as drawn.' },
    ],
    validate(p) {
      return { issue: text(p, 'issue', { max: 10 }), render: text(p, 'render', { max: 40 }), overrule: flag(p, 'overrule'), note: text(p, 'note', { max: 1000 }) };
    },
    async run(services, project, body) {
      let result;
      const issueId = String(body.issue || 'ISS_001');
      const saved = await history.record(services, project, {
        kind: 'approval', title: msg('activity.approved_cover', { issue: issueId }),
        scope: S.ws.ID.issue.test(issueId) ? [`issues/${issueId}/cover`] : [],
      }, () => {
        result = approvals.approveCover(project, body);
      });
      return Object.assign({}, result, { commit: saved.commit });
    },
  },

  'story.text': {
    params: [
      { name: 'text', type: 'string', required: true, description: 'The person\'s own story, in their words, saved as their text (story/source/description.md). Nothing is invented or rewritten: it is what they wrote.' },
      { name: 'append', type: 'boolean', required: false, description: 'true adds the text after what is there (default false: the text replaces it).' },
    ],
    validate(p) {
      return { text: text(p, 'text', { required: true, max: 20000 }), append: flag(p, 'append') };
    },
    async run(services, project, params) {
      const path = require('path');
      const fs = require('fs');
      const root = project.root;
      const file = S.ws.abs(root, story.SOURCE);
      const title = (attempt(() => S.ws.loadProject(root), {}) || {}).title || '';
      const before = params.append ? (attempt(() => story.personText(project), '') || '').trim() : '';
      const body = [before, params.text.trim()].filter(Boolean).join('\n\n');
      const saved = await history.record(services, project, {
        kind: 'save', title: msg('activity.story_text'), scope: [story.SOURCE],
      }, () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `# ${title || 'Story'}\n\n${body}\n`);
      });
      return { file: story.SOURCE, words: body.split(/\s+/).filter(Boolean).length, commit: saved.commit };
    },
  },

  'proposal.decide': {
    params: [
      { name: 'proposal', type: 'string', required: true, description: 'Proposal id (prop_...).' },
      { name: 'decisions', type: 'object[]', required: false, description: '[{ "part": "P01", "decision": "accept" | "edit" | "reject", "text": "<edited text>", "answer": "<answer to a question part>" }].' },
      { name: 'all', type: 'string', required: false, description: '"accept" or "reject": the same decision for every part still pending, when the person says so.' },
    ],
    validate(p, { project }) {
      const id = text(p, 'proposal', { required: true, max: 80 });
      const proposal = story.read(project, id);
      if (p.all !== undefined && !['accept', 'reject'].includes(p.all)) throw new HttpError(400, 'bad_params', '"all" must be accept or reject.');
      if (p.all === undefined) story.checkDecisions(proposal, p.decisions);
      else if (proposal.status !== 'open') story.checkDecisions(proposal, []);
      return { proposal: id, decisions: p.all === undefined ? p.decisions : undefined, all: p.all };
    },
    async run(services, project, params) {
      const proposal = story.read(project, params.proposal);
      const decisions = params.all
        ? proposal.parts.filter((part) => part.status === 'pending').map((part) => ({ part: part.id, decision: params.all }))
        : params.decisions;
      const clean = story.checkDecisions(proposal, decisions);
      const accepting = clean.filter((d) => d.decision !== 'reject').length;
      let outcome;
      const saved = await history.record(services, project, {
        kind: 'proposal',
        title: msg('activity.proposal_decided', { accepted: accepting, rejected: clean.length - accepting }),
        scope: [story.BIBLE],
      }, () => {
        outcome = story.decide(project, proposal, clean);
      });
      if (saved.commit) proposal.commits.push(saved.commit);
      story.save(project, proposal);
      const bible = files.readDoc(project, story.BIBLE);
      return {
        proposal: story.view(proposal),
        accepted: outcome.accepted,
        rejected: outcome.rejected,
        comments_kept: outcome.preserved,
        findings: bible.findings,
        commit: saved.commit,
      };
    },
  },

  'proposal.discard': {
    params: [{ name: 'proposal', type: 'string', required: true, description: 'Proposal id (prop_...). Its pending parts are dropped; nothing is written.' }],
    validate(p, { project }) {
      const id = text(p, 'proposal', { required: true, max: 80 });
      story.read(project, id);
      return { proposal: id };
    },
    async run(services, project, params) {
      return { proposal: story.view(story.discard(project, story.read(project, params.proposal))) };
    },
  },

  'options.update': {
    params: [
      { name: 'options', type: 'object', required: true, description: `The options to change: any of title, logline, genre, language, comic_format, publication, reading_direction, color_mode, lettering_mode, rating, page_size, touch_up_warning (0 to 10: edits of one image before a correction warns and offers a redraw). Choices: ${Object.entries(projectOptions.CHOICES).map(([k, v]) => `${k} ${(Array.isArray(v) ? v : Object.keys(v)).join('|')}`).join('; ')}.` },
    ],
    validate(p) {
      if (!p.options || typeof p.options !== 'object' || Array.isArray(p.options)) throw new HttpError(400, 'bad_params', '"options" must be an object.');
      projectOptions.checkOptions(p.options);
      return { options: p.options };
    },
    async run(services, project, params) {
      const partial = projectOptions.checkOptions(params.options);
      const hasPages = S.ws.listIssues(project.root).some((issue) => S.ws.listPageIds(project.root, issue).length > 0);
      const current = projectOptions.readOptions(project.root);
      if (partial.comic_format && partial.comic_format !== current.comic_format && hasPages) {
        throw new HttpError(409, 'format_locked', 'The format cannot change once pages are planned: their layout depends on it.');
      }
      const saved = await history.record(services, project, { kind: 'save', title: msg('activity.options'), scope: ['project.yaml'] }, () => {
        projectOptions.applyToProject(project.root, partial);
      });
      const doc = files.readDoc(project, 'project.yaml');
      return { options: projectOptions.readOptions(project.root), findings: doc.findings, commit: saved.commit };
    },
  },

  'job.answer': {
    params: [
      { name: 'job', type: 'string', required: true, description: 'The job waiting for an answer (job_...).' },
      { name: 'answers', type: 'object', required: true, description: '{ "<question id>": "<the person\'s answer, in their words>" } for every question of the job.' },
    ],
    validate(p, { project, services }) {
      const id = checkJob(services, project, p);
      if (!p.answers || typeof p.answers !== 'object' || Array.isArray(p.answers)) throw new HttpError(400, 'bad_answers', 'Send { "answers": { "<question id>": "<answer>" } }.');
      return { job: id, answers: p.answers };
    },
    async run(services, project, params) {
      const job = services.jobs.answer(project, params.job, params.answers);
      // A card waiting on that job is running again.
      const origin = job.origin || {};
      if (origin.conversation && origin.card) {
        try {
          const card = conversation.getCard(project, origin.conversation, origin.card);
          if (card.status === 'needs_decision') {
            card.status = 'started';
            card.updated_at = nowIso();
            conversation.saveCard(project, origin.conversation, card);
            emitCard(services, project, card);
          }
        } catch (err) {
          // the card's conversation is gone: the job goes on
        }
      }
      return { job };
    },
  },

  'job.resume': {
    params: [{ name: 'job', type: 'string', required: true, description: 'A job paused because a tool ran out of its usage quota (job_...). It goes back to the queue where it stopped, with the jobs that paused behind it; what was drawn is not drawn again. Only when the person asks: the quota may still be out.' }],
    validate(p, { project, services }) {
      const id = checkJob(services, project, p);
      const job = services.jobs.getRaw(project, id);
      if (job.status !== 'paused') throw new HttpError(409, 'job_not_paused', 'This job is not paused.', undefined, { status: job.status });
      return { job: id };
    },
    async run(services, project, params) {
      return services.jobs.resume(project, params.job);
    },
  },

  'page.mode': {
    params: [
      { name: 'page', type: 'string', required: true, description: 'Page ID (PG_001_003).' },
      { name: 'mode', type: 'string', required: true, description: 'per_panel: draw the page panel by panel, each panel with only its own cast as references (for a page whose cast needs more reference images than the drawing tool takes; the panels are then put together and uploaded as the page). full_page: draw it as one image again. The reference plan is rebuilt for the new mode at once. Never change who is in a panel to fit the tool instead.' },
    ],
    validate(p, { project }) {
      const pageId = text(p, 'page', { required: true, max: 40 });
      if (!S.ws.ID.page.test(pageId)) throw new HttpError(400, 'bad_params', '"page" must be a page ID.');
      if (!S.ws.loadPage(project.root, pageId)) throw new HttpError(404, 'page_not_found', `${pageId} does not exist in this project.`);
      if (!['per_panel', 'full_page'].includes(p.mode)) throw new HttpError(400, 'bad_params', '"mode" must be per_panel or full_page.');
      return { page: pageId, mode: p.mode };
    },
    async run(services, project, params) {
      const pipeline = require('./pipeline');
      const root = project.root;
      const dir = S.ws.rel(root, S.ws.pageDir(root, params.page));
      let rebuilt = null;
      const saved = await history.record(services, project, {
        kind: 'save', title: msg(`activity.page_mode.${params.mode}`, { page: params.page }), scope: [dir],
      }, () => {
        const file = require('path').join(S.ws.pageDir(root, params.page), 'page.yaml');
        S.yamlEdit.rewriteYamlFile(file, (doc) => {
          if (!doc.generation || typeof doc.generation !== 'object') doc.generation = {};
          doc.generation.mode = params.mode;
        }, (lines) => {
          const gen = S.yamlEdit.findKey(lines, 'generation', 0);
          if (!gen) return false;
          const indent = S.yamlEdit.childIndent(lines, gen);
          if (indent === null) return false;
          const range = S.yamlEdit.findKey(lines, 'mode', indent, gen.line + 1, gen.end);
          if (!range) return false;
          return S.yamlEdit.setValue(lines, range, params.mode);
        });
        // Changing the mode rebuilds the reference plan in the same step, so the next drawing never meets a stale one.
        const provider = pipeline.compileProvider(project, services.drivers);
        try {
          const plan = pipeline.buildPlan(root, params.page, provider);
          rebuilt = { file: plan.file, mode: plan.doc.mode || params.mode, budget: plan.doc.budget === undefined ? null : plan.doc.budget };
        } catch (err) {
          rebuilt = { error: errorText(err) };
        }
      });
      return { page: params.page, mode: params.mode, reference_plan: rebuilt, commit: saved.commit };
    },
  },

  'job.cancel': {
    params: [{ name: 'job', type: 'string', required: true, description: 'The job to cancel (job_...), queued, running or waiting.' }],
    validate(p, { project, services }) {
      return { job: checkJob(services, project, p) };
    },
    async run(services, project, params) {
      return { job: services.jobs.cancel(project, params.job) };
    },
  },

  delete: {
    params: [
      { name: 'items', type: 'object[]', required: true, description: 'What to delete: [{ "id": "<ID>" }], each an image of a sheet or look (CHAR_MARA_TURN_V02, LOOK_NOIR_INK_V03), a page or cover version (PG_001_004_V02, CV_001_V01), an upload (up_...), a draft edition (ED_001_02), a whole character, place or prop (CHAR_MARA), or the last page of an issue (PG_001_012). "kind" (asset, render, upload, edition, entity, page) is optional.' },
      { name: 'confirm_master', type: 'boolean', required: false, description: 'true only after the person was told what depends on an approved master (or a whole entity, or a drawn page) and said again to delete it.' },
    ],
    validate(p) {
      if (!Array.isArray(p.items) || !p.items.length || p.items.length > 100) throw new HttpError(400, 'bad_params', '"items" must be a list of 1 to 100 things to delete.');
      return { items: p.items.map((i) => deletion.checkItem(typeof i === 'string' ? { id: i } : i)), confirm_master: flag(p, 'confirm_master') };
    },
    async run(services, project, params) {
      const clean = DIRECT.delete.validate(params);
      const plans = deletion.plan(project, services, clean.items);
      const refused = plans.filter((p) => p.refused);
      if (refused.length) {
        throw new HttpError(409, 'delete_refused', refused.map((p) => `${p.id}: ${require('./i18n').render('en', p.refused.message)}`).join(' '),
          { items: refused.map(deletion.publicView) }, { reasons: refused.map((p) => p.refused.message) });
      }
      const twice = plans.filter((p) => p.confirm_twice);
      if (twice.length && clean.confirm_master !== true) {
        throw new HttpError(409, 'delete_confirm_twice', `Deleting ${twice.map((p) => p.id).join(', ')} needs a second confirmation.`,
          { items: twice.map(deletion.publicView) }, { items: twice.map((p) => p.label).join(', ') });
      }
      let outcome;
      const label = plans.length === 1 ? plans[0].id : String(plans.length);
      const saved = await history.record(services, project, {
        kind: 'delete',
        title: msg(plans.length === 1 ? 'activity.deleted_one' : 'activity.deleted_many', { what: label, n: plans.length }),
        scope: (res) => (res ? res.files : []),
      }, () => {
        outcome = deletion.apply(project, plans);
        return outcome;
      });
      return Object.assign({}, outcome, { commit: saved.commit, can_undo: !!saved.commit });
    },
  },

  'entity.merge': {
    params: [
      { name: 'from', type: 'string', required: true, description: 'The ID to merge away: a character, place or prop that is the same as another one (CHAR_ORANGE_GREY).' },
      { name: 'into', type: 'string', required: true, description: 'The ID to keep (CHAR_GREY_HAIRED_MAN). It keeps its file and its sheets; every reference to "from" points at it.' },
    ],
    validate(p) {
      return { from: text(p, 'from', { required: true, max: 80 }), into: text(p, 'into', { required: true, max: 80 }) };
    },
    async run(services, project, params) {
      requireIdle(services, project);
      let outcome;
      const saved = await history.record(services, project, {
        kind: 'entity', title: msg('activity.entity_merged', { from: params.from, into: params.into }),
        scope: (res) => (res ? [...res.files, ...res.removed, ...(res.moved || []).flat()] : []),
      }, () => {
        outcome = entityEdit.merge(project, params.from, params.into);
        return outcome;
      });
      return Object.assign({}, outcome, { commit: saved.commit });
    },
  },

  'entity.rename': {
    params: [
      { name: 'from', type: 'string', required: true, description: 'The ID to rename (CHAR_ORANGE_GREY).' },
      { name: 'to', type: 'string', required: true, description: 'The new ID, same kind (CHAR_GREY_HAIRED_MAN). Files, sheets and every reference follow.' },
    ],
    validate(p) {
      return { from: text(p, 'from', { required: true, max: 80 }), to: text(p, 'to', { required: true, max: 80 }) };
    },
    async run(services, project, params) {
      requireIdle(services, project);
      let outcome;
      const saved = await history.record(services, project, {
        kind: 'entity', title: msg('activity.entity_renamed', { from: params.from, to: params.to }),
        scope: (res) => (res ? [...res.files, ...(res.moved || []).flat()] : []),
      }, () => {
        outcome = entityEdit.rename(project, params.from, params.to);
        return outcome;
      });
      return Object.assign({}, outcome, { commit: saved.commit });
    },
  },

  'page.lettering': {
    params: [
      { name: 'page', type: 'string', required: true, description: 'Page ID (PG_001_003).' },
      { name: 'panels', type: 'object[]', required: true, description: `The panels whose lettering changes, each with its whole new list in reading order: [{ "panel": "PN_001_003_02", "lettering": [{ "id": "L03", "type": "balloon", "speaker": "CHAR_MARA", "text": "..." }, { "type": "thought", "speaker": "CHAR_MARA", "text": "..." }] }]. Keep the "id" of an element that stays; a new one has none; leave an element out to remove it; [] empties the panel. Kinds: ${letteringPlan.KINDS.join(', ')}. ${letteringPlan.SPOKEN.join(', ')} need "speaker" (a character of the page; one who is not in that panel becomes a voice from off panel); the others have none. Panels not listed stay as they are.` },
    ],
    validate(p, { project }) {
      const pageId = text(p, 'page', { required: true, max: 40 });
      if (!S.ws.ID.page.test(pageId)) throw new HttpError(400, 'bad_params', '"page" must be a page ID.');
      const page = S.ws.loadPage(project.root, pageId);
      if (!page) throw new HttpError(404, 'page_not_found', `${pageId} does not exist in this project.`);
      return { page: pageId, panels: letteringPlan.checkPanels(p.panels, page) };
    },
    async run(services, project, params) {
      const page = S.ws.loadPage(project.root, params.page);
      if (!page) throw new HttpError(404, 'page_not_found', `${params.page} does not exist in this project.`);
      const res = await letteringPlan.savePlan(services, project, params.page, letteringPlan.applyPanels(page, params.panels), { by: 'chat' });
      // The card keeps what happened, not the whole file.
      return Object.assign({}, res, { file: { path: res.file.path, etag: res.file.etag } });
    },
  },

  'issue.create': {
    params: [
      { name: 'title', type: 'string', required: true, description: 'Title of the next issue.' },
      { name: 'pages', type: 'integer', required: false, description: 'Rough page count, 1 to 200. Default 4.' },
      { name: 'summary', type: 'string', required: false, description: 'What happens in it, in the person\'s words. Optional.' },
    ],
    validate(p) {
      const title = typeof p.title === 'string' ? p.title.replace(/\s+/g, ' ').trim() : '';
      if (!title || title.length > 120) throw new HttpError(400, 'bad_params', '"title" is required, at most 120 characters.');
      const pages = p.pages === undefined || p.pages === null || p.pages === '' ? 4 : p.pages;
      if (!Number.isInteger(pages) || pages < 1 || pages > 200) throw new HttpError(400, 'bad_params', '"pages" must be a whole number from 1 to 200.');
      return { title, pages, summary: text(p, 'summary', { max: 2000 }) };
    },
    async run(services, project, params) {
      const clean = DIRECT['issue.create'].validate(params);
      if (services.jobs.running(project) && services.jobs.running(project).op === 'pages.plan') {
        throw new HttpError(409, 'project_busy', 'Pages are being planned right now. Create the next issue when that job has finished.');
      }
      let made;
      const n = issues.allIssues(project.root).reduce((max, id) => Math.max(max, parseInt(id.slice(4), 10)), 0) + 1;
      const issueId = `ISS_${String(n).padStart(3, '0')}`;
      const saved = await history.record(services, project, {
        kind: 'issue', title: msg('activity.issue_created', { number: n, title: clean.title }),
        scope: [story.PLAN, `issues/${issueId}`, 'continuity'],
      }, () => {
        made = issues.createIssue(project, clean);
      });
      return Object.assign({}, made, { commit: saved.commit, screen: screens.screenOf(project, `pages:${made.issue}`) });
    },
  },
};

/**
 * The tools a job needs (claude, codex), from the verbs of its operation and
 * the project's settings: the jobs that pause when one of them runs out of
 * quota (jobs.pauseQueuedFor).
 */
function toolsOf(services, project, job) {
  let verbs = [];
  if (job.op === 'chat.turn') verbs = ['plan'];
  else if (OP_TRAITS[job.op]) {
    try {
      verbs = OP_TRAITS[job.op].verbs(job.params || {});
    } catch (err) {
      verbs = [];
    }
  }
  const settings = project.settings();
  return [...new Set(verbs.map((verb) => {
    const pick = services.drivers.pick(verb, settings);
    return pick && pick.available ? pick.name : null;
  }).filter(Boolean))];
}

/**
 * How many images an action will draw before any automatic repair: one per
 * page (one per panel for a page drawn panel by panel), one per sheet. Null
 * for an action that draws nothing. Batch drawing says it before it runs.
 */
function imagesOf(project, name, params) {
  const root = project.root;
  const perPage = (id) => {
    const page = attempt(() => S.ws.loadPage(root, id), null);
    return page && page.generation && page.generation.mode === 'per_panel' && Array.isArray(page.panels) ? page.panels.length : 1;
  };
  switch (name) {
    case 'pages.generate': {
      let ids = Array.isArray(params.pages) ? params.pages : null;
      if (!ids) {
        ids = attempt(() => S.ws.listPages(root, params.issue || 'ISS_001')
          .filter((p) => p.doc && (params.regenerate || !['reviewed', 'approved'].includes(p.doc.status))).map((p) => p.id), []) || [];
      }
      return ids.reduce((sum, id) => sum + perPage(id), 0);
    }
    case 'style.look':
    case 'character.sheet':
    case 'cover.correct':
    case 'page.correct': return 1;
    case 'character.create':
    case 'cover.create': return params.draw === false ? null : 1;
    case 'character.update': return params.draw === true ? 1 : null;
    case 'entities.derive': return params.plates === true ? null : null;
    default: return null;
  }
}

// --- the catalog ------------------------------------------------------------------------

function opActions() {
  return ops.names().filter((name) => name !== 'chat.turn' && OP_TRAITS[name]).map((name) => ops.get(name));
}

/** Every action: [{ name, kind: 'op'|'direct', title, summary, params, decision }]. */
function catalog() {
  const out = opActions().map((op) => ({
    name: op.name,
    kind: 'op',
    title: msg(`op.${op.name}.title`),
    summary: msg(`op.${op.name}.summary`),
    params: op.params,
    decision: false,
  }));
  for (const [name, def] of Object.entries(DIRECT)) {
    out.push({ name, kind: 'direct', title: msg(`action.${name}.title`), summary: msg(`action.${name}.summary`), params: def.params, decision: true });
  }
  return out;
}

function find(name) {
  if (typeof name !== 'string') return null;
  if (DIRECT[name]) return { kind: 'direct', name, def: DIRECT[name] };
  const op = name !== 'chat.turn' && OP_TRAITS[name] ? ops.get(name) : null;
  return op ? { kind: 'op', name, def: op } : null;
}

let promptCache = null;

/** The catalog for the chat prompt, in English: one block per action with its params. */
function promptText() {
  if (promptCache) return promptCache;
  const i18n = require('./i18n');
  const lines = [];
  for (const entry of catalog()) {
    const draws = entry.kind === 'op' && OP_TRAITS[entry.name].draws({});
    lines.push(`- ${entry.name}: ${i18n.render('en', entry.summary)}${draws ? ' [draws]' : ''}${entry.decision ? ' [the person\'s decision]' : ''}`);
    for (const p of entry.params) {
      lines.push(`    ${p.name} (${p.type}${p.required ? ', required' : ''}): ${p.description}`);
    }
    if (!entry.params.length) lines.push('    (no params)');
  }
  promptCache = lines.join('\n');
  return promptCache;
}

// --- cards ----------------------------------------------------------------------------------

function pageCount(project, name, params) {
  if (name === 'pages.plan') return Number.isInteger(params.pages) ? params.pages : 1;
  if (name !== 'pages.generate') return null;
  if (Array.isArray(params.pages) && params.pages.length) return params.pages.length;
  try {
    const issue = params.issue || 'ISS_001';
    const left = S.ws.listPages(project.root, issue).filter((p) => p.doc && !['reviewed', 'approved'].includes(p.doc.status));
    return left.length || 1;
  } catch (err) {
    return 1;
  }
}

/** How long the action usually takes: from this project's finished jobs, else the reference run. */
function typical(project, services, name, params) {
  const pages = pageCount(project, name, params);
  if (!OP_TRAITS[name]) return { ms: null, source: null, runs: 0, pages: null };
  const past = services.jobs.list(project, { limit: 500 })
    .filter((j) => j.op === name && j.status === 'done' && j.started_at && j.ended_at);
  if (past.length) {
    const per = past.map((j) => {
      const ms = new Date(j.ended_at).getTime() - new Date(j.started_at).getTime();
      const n = pages === null ? 1 : (pageCount(project, name, j.params || {}) || 1);
      return ms / n;
    });
    const avg = per.reduce((a, b) => a + b, 0) / per.length;
    return { ms: Math.round(avg * (pages || 1)), source: 'measured', runs: past.length, pages };
  }
  const ref = REFERENCE_MS[name] || {};
  const ms = ref.page ? ref.page * (pages || 1) : (ref.ms || null);
  return { ms, source: ms ? 'reference' : null, runs: 0, pages };
}

/** The name of a character, place or prop for a card, or the ID when it has no file. */
function entityName(project, id) {
  const m = /^(CHAR|LOC|PROP)_[A-Z][A-Z0-9_]*$/.exec(String(id));
  if (!m) return null;
  const dirs = { CHAR: ['characters', 'character.yaml'], LOC: ['locations', 'location.yaml'], PROP: ['props', 'prop.yaml'] }[m[1]];
  const doc = attempt(() => S.ws.loadYaml(S.ws.abs(project.root, `${dirs[0]}/${id}/${dirs[1]}`)), null);
  return doc && doc.name ? doc.name : null;
}

function plainValue(project, name, value) {
  if (Array.isArray(value)) {
    return value.map((v) => {
      if (typeof v === 'string' && /uploads?$/.test(name)) {
        const up = project.upload(v);
        return up ? up.name : v;
      }
      if (v && typeof v === 'object' && typeof v.id === 'string') return entityName(project, v.id) || v.id;
      if (typeof v === 'string') return entityName(project, v) || v;
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    }).join(', ');
  }
  if (typeof value === 'string' && entityName(project, value)) return entityName(project, value);
  if (value && typeof value === 'object') return JSON.stringify(value).slice(0, 400);
  if (typeof value === 'string' && name === 'upload') {
    const up = project.upload(value);
    return up ? up.name : value;
  }
  return String(value).slice(0, 400);
}

function uploadsOf(project, params) {
  const ids = [...(Array.isArray(params.uploads) ? params.uploads : []), ...(typeof params.upload === 'string' ? [params.upload] : [])];
  return ids.map((id) => project.upload(id)).filter(Boolean).map((u) => ({
    id: u.id, name: u.name, kind: u.kind, url: `/api/projects/${project.id}/uploads/${u.id}`,
  }));
}

/**
 * Check one proposed action and make its card. Throws the action's own
 * HttpError when it does not validate.
 */
function makeCard(project, services, item, { conversation: convId, message, job, after = null, deferred = null } = {}) {
  const found = find(item.action);
  if (!found) throw new HttpError(400, 'unknown_action', `"${String(item.action).slice(0, 60)}" is not an action of the studio.`);
  const params = item.params && typeof item.params === 'object' && !Array.isArray(item.params) ? JSON.parse(JSON.stringify(item.params)) : {};
  // A card that waits for an earlier one is checked again when it is about to run.
  let clean = params;
  let choice = null;
  if (!deferred && found.def.validate) {
    try {
      clean = found.def.validate(params, { project, services });
    } catch (err) {
      // An image at the touch-up warning: the person chooses on the card, the model does not.
      if (err.code !== 'touch_up_choice' || !CHOICE_ACTIONS.includes(found.name)) throw err;
      clean = found.def.validate(Object.assign({}, params, { mode: 'touch_up' }), { project, services });
      choice = choiceOf(err.details || {});
    }
  }
  const traits = found.kind === 'op' ? OP_TRAITS[found.name] : null;
  const settings = project.settings();
  const tools = (traits ? traits.verbs(clean) : []).map((verb) => {
    const pick = services.drivers.pick(verb, settings);
    return { verb, tool: pick.name, model: pick.model || null, available: !!pick.available };
  });
  const uploads = uploadsOf(project, params);
  const card = {
    id: newId('card').toLowerCase(),
    action: found.name,
    kind: found.kind,
    params,
    why: typeof item.why === 'string' ? item.why.replace(/\s+/g, ' ').trim().slice(0, 400) : '',
    title: found.kind === 'op' ? msg(`op.${found.name}.title`) : msg(`action.${found.name}.title`),
    summary: found.kind === 'op' ? msg(`op.${found.name}.summary`) : msg(`action.${found.name}.summary`),
    // A lettering card shows its change as a preview, not as the raw list of panels.
    details: Object.entries(params).filter(([name, v]) => v !== undefined && v !== null && v !== '' && !(found.name === 'page.lettering' && name === 'panels'))
      .map(([name, value]) => ({ name, value: plainValue(project, name, value) })),
    draws: traits ? !!traits.draws(clean) : false,
    // How many images it draws (before automatic repairs), so the person can weigh it against their plan.
    images: traits && traits.draws(clean) && !deferred ? imagesOf(project, found.name, clean) : null,
    auto: traits ? !!traits.text(clean) && !traits.draws(clean) : false,
    decision: found.kind === 'direct',
    tools,
    typical: typical(project, services, found.name, clean),
    uploads,
    preview: previewOf(project, found.name, clean),
    photo_rights: ['character.create', 'character.update'].includes(found.name) && uploads.some((u) => u.kind === 'image'),
    // The person's message asked for exactly this, now: the card starts in the same turn (see runRequested).
    // A card that still needs the person's choice never starts by itself.
    requested: item.run === true && !ALWAYS_CONFIRM.includes(found.name) && !choice,
    choice,
    chosen: null,
    always_confirm: ALWAYS_CONFIRM.includes(found.name),
    status: 'pending',
    // Proposed together with an earlier card that makes it possible ("approve the plan and draw it"):
    // it runs after that card has finished, and is cancelled when that card fails or is dismissed.
    after: after ? { card: after.id, n: after.n, title: after.title } : null,
    waits_for: deferred ? errorText(deferred) : null,
    job: null,
    result: null,
    error: null,
    run_by: null,
    conversation: convId || null,
    message: message || null,
    proposed_by_job: job || null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  return card;
}

/**
 * What a card will change, shown before it runs. For page.lettering: one
 * line per balloon added, removed, changed or moved, against the plan as it
 * is now.
 */
function previewOf(project, name, params) {
  if (name !== 'page.lettering' || !params || !Array.isArray(params.panels)) return null;
  return attempt(() => {
    const page = S.ws.loadPage(project.root, params.page);
    if (!page) return null;
    const after = letteringPlan.applyPanels(page, params.panels);
    letteringPlan.normalize(after);
    const changes = letteringPlan.changesOf(page, after);
    const limits = letteringPlan.limitsOf(S.ws.loadProject(project.root) || {});
    return {
      page: page.number || null,
      changes: letteringPlan.changeLines(changes, letteringPlan.namesOf(project.root, after)),
      warnings: letteringPlan.warnings(after, limits),
      drawn: !!page.current_render,
    };
  }, null);
}

/** What a correction card at the touch-up warning offers. */
function choiceOf(details) {
  const kind = details.kind === 'cover' ? 'cover' : 'page';
  return {
    touch_ups: Number.isInteger(details.touch_ups) ? details.touch_ups : null,
    warning: Number.isInteger(details.warning) ? details.warning : null,
    text: msg(`card.choice.warning.${kind}`, { n: details.touch_ups, warning: details.warning }),
    options: [
      { mode: 'touch_up', label: msg('card.choice.touch_up') },
      { mode: 'redraw', label: msg(`card.choice.redraw.${kind}`) },
    ],
  };
}

/**
 * Replace "@attachments" in params with the ids of the message's
 * attachments: the images for "uploads" and "upload", the text files for
 * "source_upload".
 */
function withAttachments(project, params, attachments) {
  if (!params || typeof params !== 'object' || !attachments || !attachments.length) return params;
  const kindOf = (id) => ((project.upload(id) || {}).kind);
  const pick = (key) => {
    const wanted = key === 'source_upload' ? 'source' : 'image';
    const list = attachments.filter((id) => kindOf(id) === wanted);
    return list.length ? list : attachments.slice();
  };
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === '@attachments') out[key] = key === 'upload' || key === 'source_upload' ? pick(key)[0] : pick(key);
    else if (Array.isArray(value) && value.includes('@attachments')) out[key] = value.flatMap((v) => (v === '@attachments' ? pick(key) : [v]));
    else out[key] = value;
  }
  return out;
}

/**
 * The cards of a reply: every proposed action checked; the ones that fail
 * are left out with their reason.
 * @returns {{cards: object[], dropped: {action: string, reason: object}[]}}
 */
function propose(project, services, list, { conversation: convId, message, job, attachments = [] } = {}) {
  const out = { cards: [], dropped: [] };
  const items = Array.isArray(list) ? list : [];
  for (const item of items.slice(0, MAX_CARDS)) {
    const name = item && typeof item.action === 'string' ? item.action : String((item && item.action) || '?');
    try {
      if (!item || typeof item !== 'object') throw new HttpError(400, 'unknown_action', 'An action must be an object.');
      const prepared = Object.assign({}, item, { params: withAttachments(project, item.params, attachments) });
      const options = { conversation: convId, message, job };
      let card;
      try {
        card = makeCard(project, services, prepared, options);
      } catch (err) {
        // The cards are a sequence: what fails now only because of the state of the project
        // (a plan not approved yet, a character not made yet) may be what an earlier card of
        // this reply makes true. It is kept, to run after that card, and checked again then.
        const previous = out.cards[out.cards.length - 1];
        if (!previous || !stateDependent(err)) throw err;
        card = makeCard(project, services, prepared, Object.assign({}, options, {
          after: { id: previous.id, n: out.cards.length, title: previous.title }, deferred: err,
        }));
      }
      conversation.saveCard(project, convId, card);
      out.cards.push(card);
    } catch (err) {
      out.dropped.push({ action: name.slice(0, 60), reason: errorText(err) });
    }
  }
  for (const item of items.slice(MAX_CARDS)) {
    out.dropped.push({ action: String((item && item.action) || '?').slice(0, 60), reason: msg('action.too_many', { limit: MAX_CARDS }) });
  }
  return out;
}

/** An error about the project as it is now (404, 409), not about the request itself. */
function stateDependent(err) {
  return !!err && (err.status === 404 || err.status === 409) && err.code !== 'unknown_action';
}

function emitCard(services, project, card) {
  services.events.emit(project.id, 'chat', { conversation: card.conversation, card });
}

/** A result small enough to keep on a card. */
function compact(result) {
  try {
    const textOut = JSON.stringify(result);
    return textOut && textOut.length <= 6000 ? JSON.parse(textOut) : { note: 'the result is too large to keep on the card' };
  } catch (err) {
    return null;
  }
}

/**
 * Run a card: queue its job, or make its decision now. Action errors end on
 * the card (status failed, with the reason); a card that is not pending is
 * refused.
 * @param {{by: 'click'|'text'|'auto'}} how
 * @returns {Promise<{card: object, job: object|null}>}
 */
async function runCard(services, project, convId, cardId, { by = 'click', chained = false, choice = undefined } = {}) {
  const card = conversation.getCard(project, convId, cardId);
  if (card.status !== 'pending' && !(chained && card.status === 'waiting')) {
    throw new HttpError(409, 'card_not_pending', `This card was already ${card.status}.`, undefined, { status: card.status });
  }
  // A correction at the touch-up warning runs only with the person's choice.
  if (card.choice && !card.chosen) {
    const modes = card.choice.options.map((o) => o.mode);
    if (!modes.includes(choice)) {
      if (chained) {
        // Its turn came, but it waits for the person's click on one of the choices.
        card.status = 'pending';
        card.updated_at = nowIso();
        conversation.saveCard(project, convId, card);
        emitCard(services, project, card);
        return { card, job: null };
      }
      throw new HttpError(409, 'choice_needed', `This card needs the person's choice: ${modes.join(' or ')}.`, { modes });
    }
    card.chosen = choice;
    card.params = Object.assign({}, card.params, { mode: choice });
    card.details = (card.details || []).filter((d) => d.name !== 'mode').concat([{ name: 'mode', value: choice }]);
  }
  const found = find(card.action);
  if (!chained) card.run_by = by;
  card.updated_at = nowIso();
  // A card that runs after an earlier one: it waits until that one is done, or goes with it.
  if (card.after && card.after.card) {
    let before = null;
    try {
      before = conversation.getCard(project, convId, card.after.card);
    } catch (err) {
      before = null;
    }
    const status = before ? before.status : 'done';
    if (['failed', 'cancelled', 'dismissed'].includes(status)) {
      card.status = 'cancelled';
      card.error = msg('card.cancelled_after', { title: card.after.title, n: card.after.n });
      conversation.saveCard(project, convId, card);
      emitCard(services, project, card);
      afterSettled(services, project, convId, card);
      return { card, job: null };
    }
    if (status !== 'done') {
      card.status = 'waiting';
      conversation.saveCard(project, convId, card);
      emitCard(services, project, card);
      return { card, job: null };
    }
  }
  let job = null;
  if (!found) {
    card.status = 'failed';
    card.error = errorText(new HttpError(400, 'unknown_action', `"${card.action}" is no longer an action of the studio.`));
  } else if (found.kind === 'op') {
    try {
      job = services.jobs.enqueue(project, card.action, card.params, {
        origin: { conversation: convId, card: card.id, message: card.message },
      });
      card.status = 'started';
      card.job = job.id;
      card.started_at = nowIso();
    } catch (err) {
      card.status = 'failed';
      card.error = errorText(err);
    }
  } else {
    card.status = 'running';
    conversation.saveCard(project, convId, card);
    emitCard(services, project, card);
    try {
      const clean = found.def.validate(card.params, { project, services });
      const result = await found.def.run(services, project, clean);
      card.status = 'done';
      card.result = compact(result);
      if (card.action === 'issue.create' && result && result.screen) card.links = [{ key: result.screen.key, route: result.screen.route, label: result.screen.label, screen_label: result.screen.label }];
    } catch (err) {
      card.status = 'failed';
      card.error = errorText(err);
    }
  }
  card.updated_at = nowIso();
  conversation.saveCard(project, convId, card);
  emitCard(services, project, card);
  afterSettled(services, project, convId, card);
  // A decision made from a card (an approval, a proposal accepted): the guide goes on from the new state.
  if (found && found.kind === 'direct' && card.status === 'done') guideAfter(services, project, convId, null);
  // A job started from a card: the guide says what is happening and what comes after.
  if (job) {
    try {
      require('./guide').afterStarted(services, project, convId, card, job);
    } catch (err) {
      if (process.env.STUDIO_DEBUG) console.error(err);
    }
  }
  return { card, job };
}

/**
 * A card settled: the cards waiting for it run now (when it is done), or are
 * cancelled with the reason (when it failed, was cancelled or dismissed).
 */
function afterSettled(services, project, convId, card) {
  const ok = card.status === 'done';
  const over = ['failed', 'cancelled', 'dismissed'].includes(card.status);
  if (!ok && !over) return;
  let all = {};
  try {
    all = conversation.cards(project, convId) || {};
  } catch (err) {
    return;
  }
  for (const next of Object.values(all)) {
    if (!next || !next.after || next.after.card !== card.id) continue;
    if (ok && next.status === 'waiting') {
      setImmediate(() => {
        runCard(services, project, convId, next.id, { chained: true }).catch(() => {});
      });
    } else if (over && ['pending', 'waiting'].includes(next.status)) {
      next.status = 'cancelled';
      next.error = msg('card.cancelled_after', { title: card.title, n: next.after.n });
      next.updated_at = nowIso();
      conversation.saveCard(project, convId, next);
      emitCard(services, project, next);
      afterSettled(services, project, convId, next);
    }
  }
}

function dismissCard(services, project, convId, cardId) {
  const card = conversation.getCard(project, convId, cardId);
  if (card.status !== 'pending') {
    throw new HttpError(409, 'card_not_pending', `This card was already ${card.status}.`, undefined, { status: card.status });
  }
  card.status = 'dismissed';
  card.updated_at = nowIso();
  conversation.saveCard(project, convId, card);
  emitCard(services, project, card);
  afterSettled(services, project, convId, card);
  return card;
}

// --- results back into the conversation ------------------------------------------------------

/** The screens where what a job made is seen and approved. */
function resultScreens(job) {
  const p = job.params || {};
  const issue = p.issue || 'ISS_001';
  const r = job.result || {};
  switch (job.op) {
    case 'project.setup':
    case 'story.update':
    case 'story.draft':
    case 'story.complete':
    case 'story.suggest': return ['story'];
    case 'style.define':
    case 'style.look': return ['style'];
    case 'character.create':
    case 'character.update':
    case 'character.sheet': return p.character ? [`character:${p.character}`, 'characters'] : ['characters'];
    case 'entities.derive': return ['places'];
    case 'pages.plan': return [`pages:${r.issue || issue}`, ...((r.pages || []).slice(0, 3).map((pg) => `page:${pg.id}`))];
    case 'pages.generate': {
      const pages = Array.isArray(p.pages) && p.pages.length ? p.pages : [];
      const first = pages.length ? S.ws.issueOfPage(pages[0]) : issue;
      return [`pages:${first}`, ...pages.slice(0, 3).map((pg) => `page:${pg}`), 'check'];
    }
    case 'page.review':
    case 'page.correct':
    case 'page.manual': {
      const page = p.page || (p.render && /^PG_/.test(p.render) ? String(p.render).replace(/_V\d{2}$/, '') : null);
      if (page) return [`page:${page}`, 'check'];
      return [`cover:${p.cover || issue}`];
    }
    case 'cover.create':
    case 'cover.correct': return [`cover:${issue}`];
    case 'lettering.apply':
    case 'publish.build': return [`publish:${issue}`];
    default: return [];
  }
}

function resultImages(project, job) {
  const seen = new Set();
  const out = [];
  for (const step of job.steps || []) {
    for (const rel of step.changed || []) {
      if (!IMAGE_RE.test(rel) || /\/prompts\//.test(rel) || /_REF_V\d{2}\./.test(rel) || seen.has(rel)) continue;
      seen.add(rel);
      const image = files.image(project, rel);
      if (image) out.push(Object.assign({ path: rel }, image));
    }
  }
  return out.slice(-8);
}

/**
 * services.onJobSettled: a job started from a card ended or paused. The card
 * takes the outcome, and an event message goes into its conversation.
 */
function jobSettled(services, project, job) {
  const origin = job.origin || {};
  if (!origin.conversation || !origin.card) {
    // A job started on a screen: the guide still picks up from the new state.
    guideAfter(services, project, null, job);
    return;
  }
  let card;
  try {
    card = conversation.getCard(project, origin.conversation, origin.card);
  } catch (err) {
    return;
  }
  // A resumed job is running again (jobs.resume): its card follows.
  card.status = job.status === 'queued' ? 'started' : job.status;
  card.updated_at = nowIso();
  card.error = job.error || null;
  if (job.status === 'done') card.result = compact(job.result);
  conversation.saveCard(project, origin.conversation, card);
  emitCard(services, project, card);
  afterSettled(services, project, origin.conversation, card);
  if (!['done', 'failed', 'cancelled', 'needs_decision', 'paused'].includes(job.status)) return;
  // A job paused behind the one that met the quota: its card says paused, the first job's message tells the rest.
  if (job.status === 'paused' && job.paused && job.paused.by) return;

  const { links } = screens.checkLinks(project, resultScreens(job).map((key) => ({ screen: key })));
  const r = job.result || {};
  const proposals = [];
  if (job.status === 'done' && r.proposal) proposals.push({ id: r.proposal, parts: r.parts || 0 });
  for (const p of Array.isArray(job.story_proposals) ? job.story_proposals : []) proposals.push(Object.assign({ guard: true }, p));
  const message = conversation.append(project, origin.conversation, {
    role: 'event',
    event: 'action_result',
    card: card.id,
    action: card.action,
    job: job.id,
    status: job.status,
    text: msg(`action.result.${job.status}`, { title: job.title }),
    summary: typeof r.summary === 'string' ? r.summary.slice(0, 1200) : '',
    error: job.error || null,
    images: job.status === 'cancelled' ? [] : resultImages(project, job),
    links,
    proposals,
    questions: job.status === 'needs_decision' ? job.questions : [],
    // The characters, places and objects the job added, with possible duplicates (entities.js).
    added: job.status === 'done' ? attempt(() => require('./entities').addedView(project, job), []) : [],
    // Out of quota: which tool, when it may come back, what waits, and that nothing is wrong with the work.
    quota: job.status === 'paused' ? quotaView(services, project, job) : null,
    // An image to make outside the studio: the references in order and the prompt (page.manual without an upload).
    handoff: job.status === 'done' && r.handoff ? handoffView(r.handoff) : null,
    reply_to: origin.message || null,
  });
  services.events.emit(project.id, 'chat', { conversation: origin.conversation, message });
  guideAfter(services, project, origin.conversation, job);
}

/** The part of a page.manual handoff the conversation shows: target, prompt, references in order. */
function handoffView(ho) {
  return {
    target: ho.target || {},
    mode: ho.mode || 'generate',
    prompt: ho.prompt || '',
    negative_prompt: ho.negative_prompt || null,
    aspect_ratio: ho.aspect_ratio || null,
    resolution: ho.resolution || null,
    images: (ho.images || []).filter((img) => img && img.image).map((img) => ({
      position: img.position, role: img.role, path: img.path, image: img.image,
    })),
  };
}

/**
 * What a job paused for a tool's quota tells the person: the tool, when it
 * said it comes back (null when it did not), the pages not drawn yet, and
 * the other jobs that paused with it.
 */
function quotaView(services, project, job) {
  const paused = job.paused || {};
  const { TOOL_LABELS } = require('./ai');
  const steps = job.steps || [];
  const waiting = new Set();
  for (const step of steps) {
    const m = /^(PG_\d{3}_\d{3}):/.exec(String(step.id));
    if (m && ['pending', 'paused'].includes(step.status)) waiting.add(m[1]);
  }
  const others = attempt(() => services.jobs.pausedJobs(project), []).filter((j) => j.id !== job.id && j.paused && j.paused.by === job.id);
  return {
    tool: paused.tool || null,
    tool_label: TOOL_LABELS[paused.tool] || paused.tool || null,
    resets: paused.resets || null,
    pages: [...waiting],
    jobs: others.map((j) => ({ id: j.id, op: j.op, title: j.title })),
    lines: [
      msg(waiting.size ? 'quota.message' : 'quota.message.none', { tool: TOOL_LABELS[paused.tool] || paused.tool || '', n: waiting.size }),
      paused.resets ? msg('quota.reset', { resets: paused.resets }) : msg('quota.no_reset'),
      ...(others.length ? [msg('quota.others', { n: others.length })] : []),
    ],
  };
}

/** In guide mode, the guide's next message after a job or a decision (guide.js). Never throws. */
function guideAfter(services, project, convId, job) {
  try {
    require('./guide').afterSettled(services, project, convId, job);
  } catch (err) {
    if (process.env.STUDIO_DEBUG) console.error(err);
  }
}

// --- the project state, for every chat prompt ----------------------------------------------------

function attempt(fn, fallback = null) {
  try {
    return fn();
  } catch (err) {
    return fallback;
  }
}

function clip(value, max = 80) {
  const textOut = String(value || '').replace(/\s+/g, ' ').trim();
  return textOut.length > max ? `${textOut.slice(0, max - 1)}...` : textOut;
}

/**
 * A short, plain description of where the project stands, for the chat
 * prompt: what was done on the screens and what the chat did, alike.
 */
function stateBlock(project, services, convId) {
  const aggregates = require('./aggregates');
  const pipeline = require('./pipeline');
  const root = project.root;
  const lines = [];
  const options = attempt(() => projectOptions.readOptions(root), {}) || {};
  lines.push(`- Options: format ${options.comic_format || 'paged'}, story language ${options.language || 'en'}, lettering ${options.lettering_mode || 'in_image'}${options.title ? `, title "${clip(options.title, 60)}"` : ''}.`);

  const storyState = attempt(() => aggregates.story(project), null);
  if (storyState) {
    const facts = storyState.bible.data && Array.isArray(storyState.bible.data.facts) ? storyState.bible.data.facts.length : 0;
    lines.push(`- Story: ${storyState.has_text ? 'the person\'s text is there' : 'no text yet'}; story bible ${storyState.written ? `written (${facts} facts)` : 'holds only the description'}.${storyState.blocking_questions.length ? ` Blocking questions: ${storyState.blocking_questions.slice(0, 3).map((q) => `"${clip(q, 80)}"`).join('; ')}.` : ''}`);
  }
  const proposals = attempt(() => story.list(project, { status: 'open' }), []) || [];
  if (proposals.length) {
    lines.push(`- Open story proposals: ${proposals.slice(0, 5).map((p) => `${p.id} (${(p.counts && p.counts.pending) || 0} of ${(p.counts && p.counts.parts) || 0} parts pending)`).join(', ')}.`);
  }

  const styleState = attempt(() => aggregates.style(project), null);
  if (styleState) {
    const look = styleState.look;
    const waiting = (look.candidates || []).filter((c) => !c.promoted_to).map((c) => c.id);
    let text2 = 'not defined yet';
    if (look.frozen) text2 = `look approved (${look.master ? look.master.id : look.id}); the style is fixed`;
    else if (waiting.length) text2 = `look page candidate(s) waiting for approval: ${waiting.slice(-3).join(', ')}`;
    else if (styleState.style_block && styleState.style_block.exists && !styleState.style_block.template) text2 = 'style written; no look page drawn yet (style.look)';
    lines.push(`- Style: ${text2}.`);
  }

  const chars = attempt(() => aggregates.characters(project).characters, []) || [];
  if (chars.length) {
    lines.push(`- Characters: ${chars.slice(0, 12).map((c) => {
      const assets = attempt(() => aggregates.entityAssets(project, c.id), { candidates: [] });
      const waiting = assets.candidates.filter((x) => !x.promoted_to).map((x) => x.id);
      const status = c.has_master ? 'sheet approved' : waiting.length ? `candidate ${waiting[waiting.length - 1]} waiting for approval` : (c.has_identity ? 'photo reference only' : 'no sheet yet');
      return `${c.name} (${c.id}): ${status}`;
    }).join('; ')}.`);
  } else {
    lines.push('- Characters: none yet.');
  }
  const ent = attempt(() => aggregates.entities(project), { locations: [], props: [] });
  if (ent.locations.length || ent.props.length) {
    lines.push(`- Places: ${ent.locations.map((l) => l.id).slice(0, 10).join(', ') || 'none'}; objects: ${ent.props.map((p) => p.id).slice(0, 10).join(', ') || 'none'}.`);
  }

  const provider = attempt(() => pipeline.compileProvider(project, services.drivers), 'manual');
  const warning = projectOptions.touchUpWarning(attempt(() => S.ws.loadProject(root), {}) || {});
  const edits = (render) => attempt(() => {
    const review = S.ws.loadReview(root, render);
    return review && Number.isInteger(review.repair_cycle) ? review.repair_cycle : 0;
  }, 0);
  const atWarning = (render) => (render && edits(render) >= warning
    ? `, edited ${edits(render)} time(s): at the touch-up warning of ${warning}, a correction needs the person's choice`
    : '');
  for (const issue of attempt(() => aggregates.issues(project).issues, []) || []) {
    const pages = attempt(() => S.ws.listPages(root, issue.id), []) || [];
    const words = pages.slice(0, 30).map((entry) => {
      const p = attempt(() => aggregates.pageSummary(project, entry, provider), null);
      if (!p || p.broken) return `${entry.id} broken`;
      // Once a page is drawn its plan approval no longer matters.
      const bits = p.current_render ? [] : [p.plan_approved ? 'plan approved' : 'plan not approved'];
      if (p.current_render) {
        bits.push(`${p.current_render} ${p.passes ? (p.outcome === 'notes' ? 'passes with notes' : 'passes') : 'flagged'}${atWarning(p.current_render)}`);
        if (p.status === 'approved' || p.human_approval === 'approved') bits.push('approved');
      } else bits.push('not drawn');
      return `${entry.id} (${bits.join(', ')})`;
    });
    const cover = issue.cover || {};
    const coverText = !cover.exists ? 'no cover' : cover.status === 'approved' ? `cover approved (${cover.approved_render})`
      : cover.current_render ? `cover ${cover.current_render} ${cover.passes ? 'passes' : 'flagged'}${atWarning(cover.current_render)}, not approved` : 'cover written, not drawn';
    const editions = attempt(() => S.ws.listEditions(root).filter((e) => e.startsWith(`ED_${issue.id.slice(4)}_`)), []) || [];
    const editionText = editions.length ? `editions ${editions.map((e) => {
      const doc = attempt(() => S.ws.loadEdition(root, e), {}) || {};
      return `${e} (${doc.status || 'draft'})`;
    }).join(', ')}` : 'not published';
    const opens = attempt(() => (S.ws.loadIssue(root, issue.id) || {}).opens_from, null);
    lines.push(`- ${issue.id} "${clip(issue.title, 60)}", about ${issue.page_budget || '?'} pages${opens ? `, opens from ${opens}` : ''}: ${words.length ? words.join('; ') : 'no pages planned'}${pages.length > 30 ? `; and ${pages.length - 30} more` : ''}. ${coverText}; ${editionText}.`);
  }

  const jobs = services.jobs.list(project, { limit: 40 });
  const active = jobs.filter((j) => ['queued', 'running'].includes(j.status) && j.op !== 'chat.turn');
  if (active.length) {
    lines.push(`- Jobs now: ${active.map((j) => {
      const step = (j.steps || []).find((s) => s.status === 'running');
      const label = step ? require('./i18n').render('en', step.label) : null;
      return `${j.op} ${j.id} ${j.status}${label ? ` (${clip(label, 60)})` : ''}`;
    }).join('; ')}.`);
  }
  const pausedNow = jobs.filter((j) => j.status === 'paused');
  if (pausedNow.length) {
    const { TOOL_LABELS } = require('./ai');
    lines.push(`- Paused because a tool ran out of its usage quota (nothing is wrong with the work; job.resume picks it up when the person asks): ${pausedNow.map((j) => `${j.op} ${j.id} (${TOOL_LABELS[(j.paused || {}).tool] || (j.paused || {}).tool || 'a tool'}${(j.paused || {}).resets ? `, resets ${j.paused.resets}` : ''})`).join('; ')}.`);
  }
  const waiting = jobs.filter((j) => j.status === 'needs_decision');
  for (const j of waiting.slice(0, 3)) {
    lines.push(`- Waiting for the person's answer: ${j.op} ${j.id} asks ${(j.questions || []).map((q) => `[${q.id}] "${clip(q.question, 120)}"${q.options && q.options.length ? ` (options: ${q.options.map((o) => clip(o, 40)).join(' / ')})` : ''}`).join('; ')}.`);
  }
  const recent = jobs.filter((j) => ['done', 'failed', 'cancelled'].includes(j.status) && j.op !== 'chat.turn').slice(0, 6);
  if (recent.length) {
    lines.push(`- Last jobs (newest first, from the screens or the chat): ${recent.map((j) => `${j.op} ${j.status}${j.origin ? ' (from the chat)' : ''}`).join(', ')}.`);
  }
  const cards = convId ? Object.values(attempt(() => conversation.cards(project, convId), {}) || {}) : [];
  const pendingCards = cards.filter((c) => c.status === 'pending').sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  if (pendingCards.length) {
    lines.push(`- Action cards in this conversation waiting for the person: ${pendingCards.slice(-6).map((c) => `${c.id} ${c.action} ${clip(JSON.stringify(c.params), 160)}`).join('; ')}.`);
  }
  const uploads = attempt(() => project.uploads(), []) || [];
  if (uploads.length) {
    lines.push(`- Uploaded files: ${uploads.slice(-8).map((u) => `${u.id} ${u.name} (${u.kind})`).join(', ')}.`);
  }
  return lines.join('\n');
}

module.exports = {
  OP_TRAITS, DIRECT, REFERENCE_MS, MAX_CARDS, ALWAYS_CONFIRM, CHOICE_ACTIONS,
  catalog, find, promptText, makeCard, propose, runCard, dismissCard, jobSettled, stateBlock, typical, resultScreens, withAttachments,
  toolsOf, imagesOf, quotaView,
};
