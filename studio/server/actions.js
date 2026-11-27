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
 * questions of a paused job, the story proposal it left.
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
const { msg } = require('./i18n');
const { HttpError, errorText, newId, nowIso } = require('./util');

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const MAX_CARDS = 6;

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
  'character.sheet': { verbs: () => ['draw'], draws: always, text: never },
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
        kind: 'approval', title: msg('activity.approved_asset', { candidate: String(body.candidate || '').split('/').pop() }),
      }, () => {
        result = approvals.approveAsset(project, body);
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
      const saved = await history.record(services, project, { kind: 'approval', title: msg('activity.approved_page', { page: String(body.page || '') }) }, () => {
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
      const saved = await history.record(services, project, { kind: 'approval', title: msg('activity.approved_cover', { issue: String(body.issue || 'ISS_001') }) }, () => {
        result = approvals.approveCover(project, body);
      });
      return Object.assign({}, result, { commit: saved.commit });
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
      { name: 'options', type: 'object', required: true, description: `The options to change: any of title, logline, genre, language, comic_format, publication, reading_direction, color_mode, lettering_mode, rating, page_size. Choices: ${Object.entries(projectOptions.CHOICES).map(([k, v]) => `${k} ${(Array.isArray(v) ? v : Object.keys(v)).join('|')}`).join('; ')}.` },
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
      const saved = await history.record(services, project, { kind: 'save', title: msg('activity.options') }, () => {
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

  'job.cancel': {
    params: [{ name: 'job', type: 'string', required: true, description: 'The job to cancel (job_...), queued, running or waiting.' }],
    validate(p, { project, services }) {
      return { job: checkJob(services, project, p) };
    },
    async run(services, project, params) {
      return { job: services.jobs.cancel(project, params.job) };
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
      const saved = await history.record(services, project, { kind: 'issue', title: msg('activity.issue_created', { number: n, title: clean.title }) }, () => {
        made = issues.createIssue(project, clean);
      });
      return Object.assign({}, made, { commit: saved.commit, screen: screens.screenOf(project, `pages:${made.issue}`) });
    },
  },
};

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

function plainValue(project, name, value) {
  if (Array.isArray(value)) {
    return value.map((v) => {
      if (typeof v === 'string' && /uploads?$/.test(name)) {
        const up = project.upload(v);
        return up ? up.name : v;
      }
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    }).join(', ');
  }
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
function makeCard(project, services, item, { conversation: convId, message, job } = {}) {
  const found = find(item.action);
  if (!found) throw new HttpError(400, 'unknown_action', `"${String(item.action).slice(0, 60)}" is not an action of the studio.`);
  const params = item.params && typeof item.params === 'object' && !Array.isArray(item.params) ? JSON.parse(JSON.stringify(item.params)) : {};
  const clean = found.def.validate ? found.def.validate(params, { project, services }) : params;
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
    details: Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([name, value]) => ({ name, value: plainValue(project, name, value) })),
    draws: traits ? !!traits.draws(clean) : false,
    auto: traits ? !!traits.text(clean) && !traits.draws(clean) : false,
    decision: found.kind === 'direct',
    tools,
    typical: typical(project, services, found.name, clean),
    uploads,
    photo_rights: ['character.create', 'character.update'].includes(found.name) && uploads.some((u) => u.kind === 'image'),
    status: 'pending',
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
      const card = makeCard(project, services, Object.assign({}, item, { params: withAttachments(project, item.params, attachments) }), { conversation: convId, message, job });
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
async function runCard(services, project, convId, cardId, { by = 'click' } = {}) {
  const card = conversation.getCard(project, convId, cardId);
  if (card.status !== 'pending') {
    throw new HttpError(409, 'card_not_pending', `This card was already ${card.status}.`, undefined, { status: card.status });
  }
  const found = find(card.action);
  card.run_by = by;
  card.updated_at = nowIso();
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
  return { card, job };
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
  if (!origin.conversation || !origin.card) return;
  let card;
  try {
    card = conversation.getCard(project, origin.conversation, origin.card);
  } catch (err) {
    return;
  }
  card.status = job.status === 'needs_decision' ? 'needs_decision' : job.status;
  card.updated_at = nowIso();
  card.error = job.error || null;
  if (job.status === 'done') card.result = compact(job.result);
  conversation.saveCard(project, origin.conversation, card);
  emitCard(services, project, card);
  if (!['done', 'failed', 'cancelled', 'needs_decision'].includes(job.status)) return;

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
    reply_to: origin.message || null,
  });
  services.events.emit(project.id, 'chat', { conversation: origin.conversation, message });
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
  for (const issue of attempt(() => aggregates.issues(project).issues, []) || []) {
    const pages = attempt(() => S.ws.listPages(root, issue.id), []) || [];
    const words = pages.slice(0, 30).map((entry) => {
      const p = attempt(() => aggregates.pageSummary(project, entry, provider), null);
      if (!p || p.broken) return `${entry.id} broken`;
      // Once a page is drawn its plan approval no longer matters.
      const bits = p.current_render ? [] : [p.plan_approved ? 'plan approved' : 'plan not approved'];
      if (p.current_render) {
        bits.push(`${p.current_render} ${p.passes ? (p.outcome === 'notes' ? 'passes with notes' : 'passes') : 'flagged'}`);
        if (p.status === 'approved' || p.human_approval === 'approved') bits.push('approved');
      } else bits.push('not drawn');
      return `${entry.id} (${bits.join(', ')})`;
    });
    const cover = issue.cover || {};
    const coverText = !cover.exists ? 'no cover' : cover.status === 'approved' ? `cover approved (${cover.approved_render})`
      : cover.current_render ? `cover ${cover.current_render} ${cover.passes ? 'passes' : 'flagged'}, not approved` : 'cover written, not drawn';
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
  OP_TRAITS, DIRECT, REFERENCE_MS, MAX_CARDS,
  catalog, find, promptText, makeCard, propose, runCard, dismissCard, jobSettled, stateBlock, typical, resultScreens, withAttachments,
};
