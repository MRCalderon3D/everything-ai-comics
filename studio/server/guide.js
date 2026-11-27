'use strict';
/**
 * "Guide me": a mode of the project conversation in which the chat leads
 * the person from an empty project to a published comic, one decision at a
 * time.
 *
 * The guide is a flag on the conversation (conversation.setGuide), not a
 * chat of its own. Leaving the mode keeps everything; the screens and the
 * conversation write the same files either way.
 *
 * Where the project stands comes from one place: aggregates.overview(), the
 * step state the side navigation paints (its `next` screen and the status of
 * each screen). step() takes that screen and narrows it to the one decision
 * the person has to make now (the look page waiting for approval, the plans
 * to read, the pages to draw), with what it is, why it comes now, what the
 * person decides, the choices that help, the images to look at, and what an
 * answer in words usually becomes. Nothing here orders the steps again: a
 * detour (a question, a screen, a job started elsewhere) changes the state,
 * and the next message reads it afresh.
 *
 * The guide speaks on its own at three moments, from templates and without
 * an AI call: when the mode is turned on, when a job it started is under way
 * ("drawing the look page; about 3 minutes; then you approve it"), and when
 * a job or a decision settles (the result, then the next question). The
 * person never has to send "next". The AI is called only when the person
 * writes: chat.txt gets the step and the guide's rules (guideBlock()).
 *
 * A choice the person clicks (choose()) goes through cards like any action:
 * one or more cards are made from it, marked as the person's explicit
 * request, and run at once; drawing says how long it takes.
 */

const S = require('./scaffold');
const conversation = require('./conversation');
const screens = require('./screens');
const looks = require('./looks');
const i18n = require('./i18n');
const { HttpError, newId } = require('./util');

const { msg } = i18n;

/** Terms the guide explains once per conversation, the first time a step uses them. */
const TERMS = ['look', 'sheet', 'plan', 'check', 'touch_up', 'edition'];

/** How many presets the gallery shows in the chat. */
const PRESET_LIMIT = 30;

function attempt(fn, fallback = null) {
  try {
    return fn();
  } catch (err) {
    return fallback;
  }
}

function pageNumber(id) {
  return parseInt(String(id).slice(-3), 10);
}

/** A minute count for a sentence, rounded up, at least 1. */
function minutes(ms) {
  return ms ? Math.max(1, Math.round(ms / 60000)) : null;
}

function choice(id, label, actions, extra = {}) {
  return Object.assign({ id, label, actions }, extra);
}

/**
 * The step the person is at, narrowed from the navigation's next screen.
 * @returns {{key: string, screen: string|null, sig: string, title: object, why: object|null, decide: object|null,
 *            terms: string[], choices: object[], presets: object[]|null, images: object[], expects: object|null,
 *            busy: object|null}}
 */
function step(project, services) {
  const aggregates = require('./aggregates');
  const actions = require('./actions');
  const ov = aggregates.overview(project, services);
  const screenOf = (key) => ov.screens.find((x) => x.key === key) || { status: 'todo', counts: {} };
  const issue = ov.first_issue || 'ISS_001';
  const jobs = services.jobs.list(project, { limit: 60 });
  const base = { why: null, decide: null, terms: [], choices: [], presets: null, images: [], expects: null, busy: null };
  const make = (key, screen, sig, fields) => Object.assign({}, base, { key, screen, sig: `${key}:${sig}` }, fields);

  // What the person must answer first: a job waiting for a decision, or work paused for a tool's quota.
  const waiting = jobs.find((j) => j.status === 'needs_decision');
  if (waiting) {
    const q = (waiting.questions || [])[0] || { id: 'q1', question: '', options: [] };
    return make('answer', null, `${waiting.id}:${q.id}`, {
      title: msg('guide.answer.title', { title: waiting.title }),
      why: msg('guide.answer.why'),
      decide: msg('guide.answer.decide', { question: q.question }),
      choices: (waiting.questions || []).length === 1 ? (q.options || []).slice(0, 6).map((opt, i) => choice(`answer-${i + 1}`, opt,
        [{ action: 'job.answer', params: { job: waiting.id, answers: { [q.id]: opt } } }])) : [],
      expects: { action: 'job.answer', params: { job: waiting.id }, answer_of: q.id },
    });
  }
  const paused = jobs.filter((j) => j.status === 'paused');
  if (paused.length) {
    const first = paused.find((j) => j.paused && !j.paused.by) || paused[0];
    const view = actions.quotaView(services, project, Object.assign({}, first, { paused: first.paused || {} }));
    return make('paused', null, first.id, {
      // The first line says which tool ran out and what waits; the rest say when it may come back.
      title: view.lines[0],
      why: null,
      lines: view.lines.slice(1),
      decide: msg('guide.paused.decide'),
      choices: [choice('resume', msg('guide.paused.resume'), [{ action: 'job.resume', params: { job: first.id } }])],
    });
  }
  const busy = jobs.find((j) => ['queued', 'running'].includes(j.status) && j.op !== 'chat.turn');
  if (busy) {
    return make('waiting', null, busy.id, {
      title: msg('guide.waiting.title', { title: busy.title }),
      why: msg('guide.waiting.why'),
      busy: { job: busy.id, op: busy.op },
    });
  }

  const state = project.state().guide || {};
  const next = ov.next ? ov.next.screen : null;
  const chars = attempt(() => aggregates.characters(project).characters, []) || [];
  const pagesOf = () => attempt(() => aggregates.issue(project, issue, services.drivers, services.jobs).pages, []) || [];

  // --- the story
  if (next === 'story') {
    return make('story.tell', 'story', 'text', {
      title: msg('guide.story.title'),
      why: msg('guide.story.why'),
      decide: msg('guide.story.decide'),
      expects: { action: 'story.text', param: 'text' },
    });
  }

  // --- the style and its look page
  if (next === 'style') {
    const style = aggregates.style(project);
    const look = style.look || {};
    const waitingLook = (look.candidates || []).filter((c) => !c.promoted_to);
    if (waitingLook.length) {
      const c = waitingLook[waitingLook.length - 1];
      return make('style.approve', 'style', c.id, {
        title: msg('guide.look_approve.title'),
        why: msg('guide.look_approve.why'),
        decide: msg('guide.look_approve.decide'),
        terms: ['look'],
        images: c.image ? [Object.assign({ path: c.path, label: msg('guide.look_approve.image') }, c.image)] : [],
        choices: [choice('approve', msg('guide.look_approve.approve'), [{ action: 'approve.asset', params: { candidate: c.id } }])],
        expects: { action: 'style.define', param: 'description', note: 'the change describes the style again; then the look page is drawn again' },
      });
    }
    if (screenOf('style').status === 'in_progress') {
      const ms = actions.typical(project, services, 'style.look', {}).ms;
      return make('style.look', 'style', 'draw', {
        title: msg('guide.look.title'),
        why: msg('guide.look.why'),
        decide: msg('guide.look.decide', { minutes: minutes(ms) || 3 }),
        terms: ['look'],
        choices: [choice('draw', msg('guide.look.draw', { minutes: minutes(ms) || 3 }), [{ action: 'style.look', params: {} }], { draws: true, images: 1 })],
      });
    }
    const presets = attempt(() => looks.listPresets(), []).slice(0, PRESET_LIMIT).map((p) => ({
      key: p.key, name: p.name, intent: p.intent, preview: p.preview,
    }));
    return make('style.choose', 'style', 'choose', {
      title: msg('guide.style.title'),
      why: msg('guide.style.why'),
      decide: msg('guide.style.decide'),
      presets,
      choices: presets.map((p) => choice(`preset-${p.key}`, p.name, [{ action: 'style.define', params: { preset: p.key } }], { preset: p.key })),
      expects: { action: 'style.define', param: 'description' },
    });
  }

  // --- the characters and their sheets
  if (next === 'characters' && !(state.skip_characters && !chars.length)) {
    if (!chars.length) {
      return make('characters.add', 'characters', 'none', {
        title: msg('guide.characters.title'),
        why: msg('guide.characters.why'),
        decide: msg('guide.characters.decide'),
        terms: ['sheet'],
        choices: [choice('skip', msg('guide.characters.skip'), [], { guide_state: { skip_characters: true } })],
        expects: { action: 'character.create', param: 'description', name_from: 'text' },
      });
    }
    for (const c of chars) {
      if (c.has_master) continue;
      const assets = aggregates.entityAssets(project, c.id);
      const candidate = assets.candidates.filter((x) => !x.promoted_to).pop();
      if (candidate) {
        return make('characters.approve', `character:${c.id}`, candidate.id, {
          title: msg('guide.sheet_approve.title', { name: c.name }),
          why: msg('guide.sheet_approve.why'),
          decide: msg('guide.sheet_approve.decide', { name: c.name }),
          terms: ['sheet'],
          images: candidate.image ? [Object.assign({ path: candidate.path, label: c.name }, candidate.image)] : [],
          choices: [choice('approve', msg('guide.sheet_approve.approve', { name: c.name }), [{ action: 'approve.asset', params: { candidate: candidate.id } }])],
          expects: { action: 'character.update', param: 'instruction', params: { character: c.id, draw: true } },
        });
      }
    }
    const unsheeted = chars.filter((c) => !c.has_master && !c.candidates);
    if (unsheeted.length) {
      const ms = actions.typical(project, services, 'character.sheet', {}).ms;
      return make('characters.sheet', 'characters', unsheeted.map((c) => c.id).join(','), {
        title: msg('guide.sheets.title'),
        why: msg('guide.sheets.why'),
        decide: msg('guide.sheets.decide', { n: unsheeted.length, names: unsheeted.map((c) => c.name).join(', ') }),
        terms: ['sheet'],
        choices: [
          choice('all', msg('guide.sheets.all', { n: unsheeted.length, minutes: minutes((ms || 150000) * unsheeted.length) }),
            unsheeted.map((c) => ({ action: 'character.sheet', params: { character: c.id, sheet: 'turnaround' } })), { draws: true, images: unsheeted.length }),
          ...(unsheeted.length > 1 ? unsheeted.map((c) => choice(`one-${c.id}`, msg('guide.sheets.only', { name: c.name }),
            [{ action: 'character.sheet', params: { character: c.id, sheet: 'turnaround' } }], { draws: true, images: 1 })) : []),
        ],
      });
    }
  }

  // --- the pages: plan, approve the plans, draw, look at each one
  const pages = pagesOf();
  if (!pages.length && ['characters', 'pages', null].includes(next)) {
    const text = attempt(() => require('./story').personText(project), '') || '';
    const budget = (ov.issues.find((i) => i.id === issue) || {}).page_budget || 4;
    const counts = [...new Set([budget, 1, 2, 4].filter((n) => Number.isInteger(n) && n > 0 && n <= 24))].slice(0, 4);
    return make('pages.plan', `pages:${issue}`, 'none', {
      title: msg('guide.plan.title'),
      why: msg('guide.plan.why'),
      decide: msg(text.trim() ? 'guide.plan.decide_text' : 'guide.plan.decide', { n: budget }),
      terms: ['plan'],
      choices: text.trim() ? counts.map((n) => choice(`pages-${n}`, msg('guide.plan.count', { n }),
        [{ action: 'pages.plan', params: { issue, text: text.trim().slice(0, 19000), pages: n } }])) : [],
      expects: { action: 'pages.plan', param: 'text', params: { issue, pages: budget } },
    });
  }
  if (pages.length) {
    const unapproved = pages.filter((p) => !p.current_render && !p.plan_approved);
    if (unapproved.length) {
      const plans = unapproved.slice(0, 12).map((p) => msg('guide.plans.line', { n: p.number || pageNumber(p.id), purpose: p.purpose || '-', panels: p.panels }));
      return make('pages.approve_plan', `pages:${issue}`, unapproved.map((p) => p.id).join(','), {
        title: msg('guide.plans.title', { n: unapproved.length }),
        why: msg('guide.plans.why'),
        decide: msg('guide.plans.decide', { n: unapproved.length }),
        lines: plans,
        terms: ['plan'],
        choices: [choice('approve', msg('guide.plans.approve', { n: unapproved.length }), [{ action: 'approve.plan', params: { pages: unapproved.map((p) => p.id) } }])],
        links: unapproved.slice(0, 3).map((p) => `page:${p.id}`),
      });
    }
    const undrawn = pages.filter((p) => !p.current_render);
    if (undrawn.length) {
      const images = actions.imagesOf(project, 'pages.generate', { pages: undrawn.map((p) => p.id) }) || undrawn.length;
      const ms = actions.typical(project, services, 'pages.generate', { pages: undrawn.map((p) => p.id) }).ms;
      return make('pages.draw', `pages:${issue}`, undrawn.map((p) => p.id).join(','), {
        title: msg('guide.draw.title', { n: undrawn.length }),
        why: msg('guide.draw.why'),
        decide: msg('guide.draw.decide', { n: images, minutes: minutes(ms) || undrawn.length * 5 }),
        terms: ['check'],
        choices: [choice('draw', msg('guide.draw.draw', { n: images }), [{ action: 'pages.generate', params: { pages: undrawn.map((p) => p.id) } }], { draws: true, images })],
      });
    }
    const toApprove = pages.find((p) => p.current_render && p.status !== 'approved' && p.human_approval !== 'approved');
    if (toApprove) {
      const n = toApprove.number || pageNumber(toApprove.id);
      const img = toApprove.image ? [Object.assign({ path: toApprove.current_render, label: msg('guide.page.image', { n }) }, toApprove.image)] : [];
      const approve = toApprove.passes
        ? choice('approve', msg('guide.page.approve', { n }), [{ action: 'approve.page', params: { page: toApprove.id } }])
        : choice('approve', msg('guide.page.approve_anyway', { n }), [{ action: 'approve.page', params: { page: toApprove.id, overrule: true, note: 'Approved as drawn from the guide.' } }]);
      return make('pages.review', `page:${toApprove.id}`, `${toApprove.id}:${toApprove.current_render}`, {
        title: msg('guide.page.title', { n }),
        why: msg(toApprove.passes ? (toApprove.outcome === 'notes' ? 'guide.page.why_notes' : 'guide.page.why') : 'guide.page.why_flagged'),
        decide: msg('guide.page.decide', { n }),
        terms: ['check', 'touch_up'],
        images: img,
        choices: [approve],
        expects: { action: 'page.correct', param: 'text', params: { page: toApprove.id } },
      });
    }
  }

  // --- the cover, optional, then publishing
  const coverNow = attempt(() => aggregates.coverSummary(project, issue), {}) || {};
  const published = ((ov.screens.find((x) => x.key === 'publish') || {}).counts || {}).editions || 0;
  if (pages.length && coverNow.status !== 'approved' && !state.skip_cover && !published) {
    if (coverNow.current_render) {
      const params = { issue, render: coverNow.current_render };
      if (!coverNow.passes) Object.assign(params, { overrule: true, note: 'Approved as drawn from the guide.' });
      return make('cover.approve', `cover:${issue}`, coverNow.current_render, {
        title: msg('guide.cover_approve.title'),
        why: msg(coverNow.passes ? 'guide.cover_approve.why' : 'guide.cover_approve.why_flagged'),
        decide: msg('guide.cover_approve.decide'),
        terms: ['touch_up'],
        images: coverNow.image ? [Object.assign({ path: coverNow.current_render, label: msg('guide.cover_approve.image') }, coverNow.image)] : [],
        choices: [choice('approve', msg('guide.cover_approve.approve'), [{ action: 'approve.cover', params }])],
        expects: { action: 'cover.correct', param: 'text', params: { issue } },
      });
    }
    const ms = actions.typical(project, services, 'cover.create', {}).ms;
    return make('cover', `cover:${issue}`, 'none', {
      title: msg('guide.cover.title'),
      why: msg('guide.cover.why'),
      decide: msg('guide.cover.decide', { minutes: minutes(ms) || 8 }),
      choices: [
        choice('draw', msg('guide.cover.draw'), [{ action: 'cover.create', params: { issue } }], { draws: true, images: 1 }),
        choice('skip', msg('guide.cover.skip'), [], { guide_state: { skip_cover: true } }),
      ],
      expects: { action: 'cover.create', param: 'description', params: { issue } },
    });
  }
  const editions = (ov.screens.find((x) => x.key === 'publish') || { counts: {} }).counts.editions || 0;
  if (pages.length && !editions) {
    return make('publish', `publish:${issue}`, 'none', {
      title: msg('guide.publish.title'),
      why: msg('guide.publish.why'),
      decide: msg('guide.publish.decide'),
      terms: ['edition'],
      choices: [
        choice('pdf', msg('guide.publish.pdf'), [{ action: 'publish.build', params: { issue, formats: ['pdf', 'cbz'] } }]),
        choice('all', msg('guide.publish.all'), [{ action: 'publish.build', params: { issue, formats: S.editionFormats() } }]),
      ],
    });
  }
  if (editions) {
    return make('done', `publish:${issue}`, String(editions), {
      title: msg('guide.done.title'),
      why: msg('guide.done.why'),
      decide: msg('guide.done.decide'),
      expects: { action: 'issue.create', param: 'title' },
    });
  }
  // Nothing narrower fits: say where the navigation points.
  return make('screen', next, next || 'none', {
    title: msg('guide.screen.title'),
    why: ov.next ? ov.next.summary : null,
    decide: msg('guide.screen.decide'),
  });
}

/** The step, rendered for the prompt (English) and for the API. */
function publicStep(st) {
  return {
    key: st.key,
    screen: st.screen,
    sig: st.sig,
    title: st.title,
    why: st.why,
    decide: st.decide,
    choices: st.choices.map((c) => ({ id: c.id, label: c.label, draws: !!c.draws, images: c.images || null, preset: c.preset || null })),
    presets: st.presets,
    images: st.images,
    expects: st.expects,
    busy: st.busy,
  };
}

/**
 * The GUIDE block of chat.txt: where the project is and the one decision,
 * in English for the model. The rules are in the template itself.
 */
function guideBlock(project, services) {
  const st = step(project, services);
  const en = (v) => (v ? i18n.render('en', v) : '');
  const lines = [
    `Step now: ${en(st.title)}`,
    st.why ? `Why it comes now: ${en(st.why)}` : null,
    st.decide ? `What the person decides: ${en(st.decide)}` : null,
    st.lines && st.lines.length ? `Shown to the person:\n${st.lines.map((l) => `  - ${en(l)}`).join('\n')}` : null,
    st.choices.length ? `Choices on screen (the person may click one instead of writing): ${st.choices.slice(0, 12).map((c) => `"${en(c.label)}" = ${c.actions.length ? c.actions.map((a) => `${a.action} ${JSON.stringify(a.params)}`).join(' then ') : 'no action'}`).join('; ')}${st.choices.length > 12 ? '; and more' : ''}.` : null,
    st.expects ? `An answer in words to this step usually becomes the action ${st.expects.action}${st.expects.params ? ` with ${JSON.stringify(st.expects.params)}` : ''}, the person's words going into "${st.expects.param}"${st.expects.note ? ` (${st.expects.note})` : ''}.` : null,
    `Terms already explained in this conversation: ${(termsOf(project).join(', ')) || 'none'}.`,
  ];
  return { text: lines.filter(Boolean).join('\n'), step: st };
}

function termsOf(project) {
  return attempt(() => conversation.guideState(project, conversation.current(project).id).terms, []) || [];
}

/** A short line on what a settled job came to, for the guide's message. */
function resultLine(job) {
  if (!job) return null;
  if (job.status === 'done') return msg('guide.result.done', { title: job.title });
  if (job.status === 'failed') return msg('guide.result.failed', { title: job.title, error: (job.error && job.error.message) || '' });
  if (job.status === 'cancelled') return msg('guide.result.cancelled', { title: job.title });
  return null;
}

/**
 * Post the guide's message for the current step, unless the last guide
 * message already said the same (same step and same subject). Returns the
 * message, or null.
 */
function post(services, project, convId, { result = null, force = false, intro = false } = {}) {
  const id = convId || conversation.current(project).id;
  const g = conversation.guideState(project, id);
  if (!g.on) return null;
  const st = step(project, services);
  const all = conversation.messages(project, id);
  const last = [...all].reverse().find((m) => m.guide && m.guide.key && m.guide.key !== 'started');
  if (!force && last && last.guide.sig === st.sig) return null;
  const explained = new Set(g.terms || []);
  const newTerms = st.terms.filter((term) => TERMS.includes(term) && !explained.has(term));
  const lines = [];
  if (intro) lines.push(msg('guide.intro'));
  if (result) lines.push(result);
  lines.push(st.title);
  if (st.why) lines.push(st.why);
  for (const term of newTerms) lines.push(msg(`guide.term.${term}`));
  if (st.lines) lines.push(...st.lines);
  if (st.decide) lines.push(st.decide);
  const linkKeys = [st.screen, ...(st.links || [])].filter(Boolean);
  const { links } = screens.checkLinks(project, linkKeys.map((key) => ({ screen: key })));
  const message = conversation.append(project, id, {
    role: 'assistant',
    tool: null,
    text: st.decide || st.title,
    screen: null,
    key: st.screen || null,
    links,
    guide: Object.assign(publicStep(st), { lines, terms_explained: newTerms }),
  });
  if (newTerms.length) conversation.setGuide(project, id, { terms: [...explained, ...newTerms] });
  services.events.emit(project.id, 'chat', { conversation: id, message });
  return message;
}

/** Turn the mode on or off. On posts the first message at once. */
function setMode(services, project, on) {
  const entry = conversation.current(project);
  conversation.setGuide(project, entry.id, { on: !!on });
  const message = on ? post(services, project, entry.id, { force: true, intro: true }) : null;
  if (!on) {
    const note = conversation.append(project, entry.id, { role: 'event', event: 'guide_off', text: msg('guide.off') });
    services.events.emit(project.id, 'chat', { conversation: entry.id, message: note });
  }
  return { conversation: entry.id, on: !!on, message };
}

/**
 * actions.jobSettled and runCard call this when a job or a decision
 * settles: in guide mode, the result and the next question follow without
 * the person asking.
 */
function afterSettled(services, project, convId, job) {
  try {
    settled(services, project, convId, job);
  } catch (err) {
    if (process.env.STUDIO_DEBUG) console.error(err);
  }
}

function settled(services, project, convId, job) {
  if (job && !['done', 'failed', 'cancelled', 'needs_decision', 'paused'].includes(job.status)) return;
  if (job && job.status === 'paused' && job.paused && job.paused.by) return;
  // A project whose conversation was never opened has no guide to speak.
  if (!convId && !conversation.exists(project)) return;
  const id = convId || attempt(() => conversation.current(project).id, null);
  if (!id || !conversation.guideState(project, id).on) return;
  // A job that settles while the next one is queued: the guide speaks when the queue is clear.
  const st = step(project, services);
  if (st.key === 'waiting') return;
  // A job started from the conversation already posted its result message; one from a screen gets its line here.
  const fromScreen = job && !(job.origin && job.origin.conversation === id);
  post(services, project, id, { result: fromScreen ? resultLine(job) : null });
}

/**
 * A card started a job: in guide mode, say what is happening, how long it
 * usually takes, and what comes after. A card made from a guide choice says
 * it in its own message (choose()).
 */
function afterStarted(services, project, convId, card, job) {
  if (!convId || card.guided || !conversation.guideState(project, convId).on) return;
  const message = conversation.append(project, convId, {
    role: 'assistant', tool: null, key: null, screen: null,
    text: startedText(project, services, card),
    guide: { key: 'started', sig: `started:${job.id}`, lines: [startedText(project, services, card)], choices: [], images: [] },
  });
  services.events.emit(project.id, 'chat', { conversation: convId, message });
}

/** "Drawing the look page. It usually takes about 3 minutes. Then: ...". */
function startedText(project, services, card) {
  const ms = card.typical && card.typical.ms;
  return msg(ms ? 'guide.started.time' : 'guide.started', {
    title: card.title, minutes: minutes(ms) || '', after: msg(`guide.after.${afterKey(card.action)}`),
  });
}

function afterKey(action) {
  const known = ['style.define', 'style.look', 'character.create', 'character.sheet', 'character.update', 'pages.plan', 'pages.generate',
    'page.correct', 'cover.create', 'cover.correct', 'publish.build', 'story.text', 'approve.asset', 'approve.plan', 'approve.page', 'approve.cover', 'job.resume'];
  return known.includes(action) ? action.replace(/\./g, '_') : 'other';
}

/**
 * The person clicked a choice of the guide's message: a user message with
 * its label, then the cards it makes, run at once as the person's explicit
 * request, in one guide message that says what happens now.
 * @param {{step: string, choice: string, screen?: object}} body
 */
async function choose(services, project, body) {
  const actions = require('./actions');
  const entry = conversation.current(project);
  if (!conversation.guideState(project, entry.id).on) throw new HttpError(409, 'guide_off', 'Guide mode is off in this conversation.');
  const st = step(project, services);
  if (!body || body.step !== st.sig) {
    throw new HttpError(409, 'guide_moved', 'The project moved on since this choice was shown: here is the step it is at now.', { step: publicStep(st) });
  }
  const picked = st.choices.find((c) => c.id === body.choice);
  if (!picked) throw new HttpError(400, 'bad_params', '"choice" is not one of the choices of this step.');
  const screen = body.screen ? attempt(() => screens.checkScreen(project, body.screen), null) : null;
  const user = conversation.append(project, entry.id, {
    role: 'user', text: i18n.render(project.settings().language || 'en', picked.label), screen, key: screen ? screen.key : null, guide_choice: { step: st.key, choice: picked.id },
  });
  services.events.emit(project.id, 'chat', { conversation: entry.id, message: user });
  if (picked.guide_state) project.saveState({ guide: Object.assign({}, project.state().guide || {}, picked.guide_state) });

  const messageId = newId('msg');
  const proposed = actions.propose(project, services, picked.actions.map((a) => ({ action: a.action, params: a.params, run: true, why: '' })), {
    conversation: entry.id, message: messageId, job: null,
  });
  for (const card of proposed.cards) {
    card.guided = true;
    conversation.saveCard(project, entry.id, card);
  }
  let reply = null;
  if (proposed.cards.length) {
    const lines = proposed.cards.map((c) => (c.kind === 'op' ? startedText(project, services, c) : msg('guide.deciding', { title: c.title })));
    reply = conversation.append(project, entry.id, {
      id: messageId, role: 'assistant', tool: null, key: st.screen, screen: null,
      text: lines[0],
      actions: proposed.cards.map((c) => c.id),
      dropped: proposed.dropped,
      guide: { key: 'started', sig: `chosen:${messageId}`, lines, choices: [], images: [] },
    });
    services.events.emit(project.id, 'chat', { conversation: entry.id, message: Object.assign({}, reply, { actions: proposed.cards }) });
  }
  const ran = [];
  for (const card of proposed.cards.filter((c) => c.requested)) {
    try {
      const out = await actions.runCard(services, project, entry.id, card.id, { by: 'guide' });
      ran.push({ card: card.id, status: out.card.status, job: out.job ? out.job.id : null });
    } catch (err) {
      ran.push({ card: card.id, status: 'failed', error: err.message });
    }
  }
  // A choice with no action (skip the cover) moves the guide on at once.
  if (!proposed.cards.length) post(services, project, entry.id, {});
  return { message: user, reply, cards: proposed.cards.map((c) => conversation.getCard(project, entry.id, c.id)), dropped: proposed.dropped, ran };
}

module.exports = { TERMS, step, publicStep, guideBlock, post, setMode, afterSettled, afterStarted, choose, startedText };
