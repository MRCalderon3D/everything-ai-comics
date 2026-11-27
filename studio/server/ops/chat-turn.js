'use strict';
/**
 * chat.turn: one message of the project conversation. The context is the
 * files of the screen the message was sent from; the model may edit them,
 * except the story bible: story text comes back as a proposal the person
 * decides on (studio/server/story.js), and a direct write to it is undone
 * by the guard every AI call runs in (studio/server/bible-guard.js). The
 * reply can suggest screens to go to (`data.links`), checked against the
 * project's real screens.
 *
 * The prompt carries a short state of the project (what the screens and the
 * chat did so far), the files the person attached, and the catalog of
 * actions (studio/server/actions.js). The reply may propose actions
 * (`data.actions`), which become cards the person runs or dismisses, and
 * may run cards the person confirmed in words (`data.run_actions`). A card
 * the person's current message asks for explicitly ("draw the look page",
 * "acepta toda la propuesta") carries `run: true` and starts in the same
 * turn, drawing included, with run_by "request"; deletes and merges always
 * wait (actions.ALWAYS_CONFIRM). Anything the model suggests on its own
 * waits for a click.
 *
 * When another job runs, the turn runs in the read-only lane of the queue
 * (studio/server/jobs.js): it answers and proposes, and changes no file.
 *
 * The conversation continues through the tool's own session while the same
 * tool answers. When the answering tool changes, the new one starts a
 * session with a summary of the conversation so far, and the transcript
 * says so.
 */

const chats = require('../chats');
const conversation = require('../conversation');
const screens = require('../screens');
const story = require('../story');
const { msg } = require('../i18n');
const prompts = require('../prompts');
const S = require('../scaffold');
const { runAi, TOOL_LABELS } = require('../ai');
const { isCancel, NeedsDecision } = require('../jobs');
const { str, uploadIds } = require('./shared');
const { errorText, newId } = require('../util');

/** The keys the model may link to, for the prompt. */
function linkableKeys(project) {
  const keys = ['home', 'story', 'style', 'characters', 'places', 'check', 'corrections', 'history', 'settings'];
  const root = project.root;
  try {
    for (const id of S.ws.listEntityIds(root, 'characters')) keys.push(`character:${id}`);
    for (const id of S.ws.listEntityIds(root, 'locations')) keys.push(`location:${id}`);
    for (const id of S.ws.listEntityIds(root, 'props')) keys.push(`prop:${id}`);
    for (const issue of S.ws.listIssues(root)) {
      keys.push(`pages:${issue}`, `cover:${issue}`, `publish:${issue}`);
      for (const page of S.ws.listPageIds(root, issue).slice(0, 60)) keys.push(`page:${page}`);
    }
  } catch (err) {
    // a partly written workspace: the general screens are enough
  }
  return keys.filter((k) => screens.exists(project, k));
}

/** The attachments of a message as the transcript keeps them. */
function attachmentViews(project, ids) {
  return (ids || []).map((id) => project.upload(id)).filter(Boolean).map((u) => ({
    id: u.id, name: u.name, kind: u.kind, bytes: u.bytes, width: u.width || null, height: u.height || null,
    url: `/api/projects/${project.id}/uploads/${u.id}`,
  }));
}

module.exports = {
  name: 'chat.turn',
  readOnlyLane: true,
  params: [
    { name: 'screen', type: 'object', required: true, description: 'The screen the message was sent from: { key, label, route }. key is a screen key: story, style, options, characters, places, character:<ID>, location:<ID>, prop:<ID>, pages:<ISS_ID>, page:<PAGE_ID>, cover:<ISS_ID>, publish:<ISS_ID>.' },
    { name: 'text', type: 'string', required: true, description: 'The person\'s message.' },
    { name: 'conversation', type: 'string', required: false, description: 'Conversation id. Default: the current conversation of the project.' },
    { name: 'attachments', type: 'string[]', required: false, description: 'Ids of uploaded files (images or text) sent with the message. The prompt lists them by path, and images also go to the tool.' },
    { name: 'key', type: 'string', required: false, description: 'Deprecated: the screen key alone, as the per-screen chat sent it.' },
  ],

  attachmentViews,

  validate(params, { project }) {
    const screen = screens.checkScreen(project, params.screen !== undefined ? params.screen : String(params.key || ''));
    const conv = params.conversation ? conversation.get(project, String(params.conversation)) : conversation.current(project);
    const attachments = uploadIds(params, 'attachments', project, null);
    return {
      key: screen.key,
      screen,
      conversation: conv.id,
      text: str(params, 'text', { required: true, max: 8000 }),
      message: params.message ? String(params.message) : null,
      attachments,
    };
  },

  steps() {
    return [{ id: 'reply', label: msg('step.chat.reply') }];
  },

  async run(ctx) {
    // Required here: actions.js reads the operations registry, which loads this file.
    const actions = require('../actions');
    const { project, params, services } = ctx;
    const root = project.root;
    const convId = params.conversation;
    const screen = params.screen || screens.checkScreen(project, params.key);
    const context = chats.contextOf(project, screen.key);
    const emit = (message) => services.events.emit(project.id, 'chat', { conversation: convId, key: message.key || screen.key, message });
    const record = (message) => {
      const stored = conversation.append(project, convId, message);
      emit(stored);
      return stored;
    };
    const entry = conversation.get(project, convId);
    const session = entry.session || null;
    const readOnly = !!ctx.readOnly;
    const attached = (params.attachments || []).map((id) => project.upload(id)).filter(Boolean)
      .map((u) => ({ id: u.id, name: u.name, kind: u.kind, file: project.uploadFile(u) }));
    const pendingCards = Object.values(conversation.cards(project, convId)).filter((c) => c.status === 'pending').map((c) => c.id);
    const call = (sessionId, history) => ({
      verb: 'plan',
      kind: 'chat',
      vars: {
        screen: context.screen,
        screen_key: screen.key,
        files: prompts.fileList(context.files.map((rel) => S.ws.abs(root, rel))),
        file_list: context.files,
        commands: prompts.fileList(context.commands),
        message: params.text,
        history,
        screens: linkableKeys(project).join(', '),
        bible: S.ws.abs(root, story.BIBLE),
        state: actions.stateBlock(project, services, convId),
        actions: actions.promptText(),
        attachments: attached.map((a) => `- ${a.file} (upload id ${a.id}, ${a.kind === 'image' ? 'an image: open it and look at it' : 'a text file: read it'}, sent as "${a.name}")`).join('\n'),
        attachment_ids: attached.map((a) => a.id),
        pending_cards: pendingCards,
        busy: readOnly,
      },
      images: attached.filter((a) => a.kind === 'image').map((a) => a.file),
      allowWrite: !readOnly,
      sessionId,
      fakeText: params.text,
    });

    let reply;
    try {
      reply = await ctx.step('reply', async (h) => {
        const wanted = services.drivers.pick('plan', project.settings());
        const sameTool = session && wanted.available && session.tool === wanted.name;
        const summary = () => conversation.summaryFor(project, convId, { exceptId: params.message });
        if (sameTool) {
          try {
            return await runAi(ctx, h, call(session.id, ''));
          } catch (err) {
            // A session the tool no longer has: start a new one once, with the summary.
            if (isCancel(err) || err instanceof NeedsDecision || err.code !== 'ai_failed') throw err;
            h.log('the earlier session could not be continued: starting a new one with a summary');
            record({ role: 'event', event: 'session_restarted', text: msg('conversation.session_restarted', { tool: TOOL_LABELS[wanted.name] }), tool: wanted.name, job: ctx.job.id });
            return runAi(ctx, h, call(null, summary()));
          }
        }
        if (session && wanted.available && session.tool !== wanted.name) {
          record({
            role: 'event', event: 'tool_changed', tool: wanted.name, from_tool: session.tool, job: ctx.job.id,
            text: msg('conversation.tool_changed', { from: TOOL_LABELS[session.tool] || session.tool, to: TOOL_LABELS[wanted.name] }),
          });
        }
        return runAi(ctx, h, call(null, summary()));
      }, { verb: 'plan' });
    } catch (err) {
      if (!isCancel(err) && !(err instanceof NeedsDecision)) {
        record({ role: 'assistant', text: '', error: errorText(err), job: ctx.job.id, reply_to: params.message, screen, key: screen.key, read_only: readOnly });
      }
      throw err;
    }
    const reverted = reply.bible && reply.bible.reverted ? [story.BIBLE] : [];

    if (reply.sessionId) conversation.setSession(project, convId, { tool: reply.tool, id: reply.sessionId });
    let proposal = null;
    if (reply.data && reply.data.proposal && typeof reply.data.proposal === 'object') {
      const made = story.create(project, {
        kind: 'chat', instruction: params.text, data: reply.data.proposal, summary: reply.summary, decisions: reply.decisions,
        job: ctx.job.id, tool: reply.tool, conversation: convId, message: params.message,
      });
      if (made.parts.length) proposal = { id: made.id, parts: made.parts.length };
    }
    const { links, dropped } = screens.checkLinks(project, reply.data && reply.data.links);
    if (dropped) ctx.log(`${dropped} suggested link(s) named no screen of this project and were left out`);

    // The actions the reply proposes become cards; the ones that do not check out are left out, with the reason.
    const messageId = newId('msg');
    const proposed = actions.propose(project, services, reply.data && reply.data.actions, {
      conversation: convId, message: messageId, job: ctx.job.id, attachments: params.attachments || [],
    });
    for (const d of proposed.dropped) {
      ctx.log(`the proposed action ${d.action} was left out: ${require('../i18n').render('en', d.reason)}`);
    }
    const step = ctx.job.steps.find((s) => s.id === 'reply') || {};
    // The transcript keeps the card ids; the event and the job carry the cards themselves.
    const stored = conversation.append(project, convId, {
      id: messageId,
      role: 'assistant',
      text: String(reply.summary || ''),
      tool: reply.tool,
      job: ctx.job.id,
      reply_to: params.message,
      screen,
      key: screen.key,
      files: (step.changed || []).filter((p) => !reverted.includes(p)),
      commit: step.commit || null,
      decisions: reply.decisions,
      links,
      proposal,
      reverted,
      story_proposal: reply.bible && reply.bible.proposal ? reply.bible.proposal : null,
      actions: proposed.cards.map((c) => c.id),
      dropped: proposed.dropped,
      read_only: readOnly,
    });
    const message = Object.assign({}, stored, { actions: proposed.cards });
    emit(message);

    // Cards the person asked for in this very message ("draw the look page", "acepta toda la
    // propuesta") start now, drawing included; cards the model only suggests wait for a click.
    const ran = [];
    for (const card of proposed.cards.filter((c) => c.requested)) {
      try {
        const out = await actions.runCard(services, project, convId, card.id, { by: 'request' });
        ran.push({ card: card.id, status: out.card.status, job: out.job ? out.job.id : null, requested: true });
        ctx.log(`ran card ${card.id} (${card.action}) at once: the person's message asked for it`);
      } catch (err) {
        ctx.log(`card ${card.id} could not run: ${err.message}`);
      }
    }
    // Cards the person confirmed in words, then text-only cards when the setting allows it.
    const asked = Array.isArray(reply.data && reply.data.run_actions) ? reply.data.run_actions.map(String).slice(0, 6) : [];
    for (const id of asked) {
      if (!pendingCards.includes(id)) {
        ctx.log(`the reply asked to run ${id.slice(0, 60)}, which is not a waiting card of this conversation`);
        continue;
      }
      try {
        const out = await actions.runCard(services, project, convId, id, { by: 'text' });
        ran.push({ card: id, status: out.card.status, job: out.job ? out.job.id : null });
        ctx.log(`ran card ${id} (${out.card.action}) as the person confirmed: ${out.card.status}`);
      } catch (err) {
        ctx.log(`card ${id} could not run: ${err.message}`);
      }
    }
    if (project.settings().chat_auto_run) {
      for (const card of proposed.cards.filter((c) => c.auto && !c.requested)) {
        try {
          const out = await actions.runCard(services, project, convId, card.id, { by: 'auto' });
          ran.push({ card: card.id, status: out.card.status, job: out.job ? out.job.id : null });
          ctx.log(`ran card ${card.id} (${card.action}) at once: text only, and the setting allows it`);
        } catch (err) {
          ctx.log(`card ${card.id} could not run: ${err.message}`);
        }
      }
    }
    return { conversation: convId, key: screen.key, message, ran, read_only: readOnly };
  },
};

