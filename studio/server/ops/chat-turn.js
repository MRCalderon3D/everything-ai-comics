'use strict';
/**
 * chat.turn: one message of the chat of a screen. The context is the
 * screen's files; the model may edit them. The reply, the files it changed
 * and the commit go into the transcript. A conversation continues through
 * the driver's own session support while the same tool answers.
 */

const chats = require('../chats');
const { msg } = require('../i18n');
const prompts = require('../prompts');
const S = require('../scaffold');
const { runAi } = require('../ai');
const { isCancel, NeedsDecision } = require('../jobs');
const { str } = require('./shared');
const { errorText } = require('../util');

module.exports = {
  name: 'chat.turn',
  params: [
    { name: 'key', type: 'string', required: true, description: 'Screen key: story, style, options, characters, places, character:<ID>, location:<ID>, prop:<ID>, pages:<ISS_ID>, page:<PAGE_ID>, cover:<ISS_ID>, publish:<ISS_ID>.' },
    { name: 'text', type: 'string', required: true, description: 'The person\'s message.' },
  ],

  validate(params, { project }) {
    const key = String(params.key || '');
    chats.contextOf(project, key);
    return { key, text: str(params, 'text', { required: true, max: 8000 }), message: params.message ? String(params.message) : null };
  },

  steps() {
    return [{ id: 'reply', label: msg('step.chat.reply') }];
  },

  async run(ctx) {
    const { project, params } = ctx;
    const root = project.root;
    const context = chats.contextOf(project, params.key);
    const emit = (message) => ctx.services.events.emit(project.id, 'chat', { key: params.key, message });
    const session = (project.state().chat_sessions || {})[params.key] || null;
    const call = (sessionId) => ({
      verb: 'plan',
      kind: 'chat',
      vars: {
        screen: context.screen,
        files: prompts.fileList(context.files.map((rel) => S.ws.abs(root, rel))),
        file_list: context.files,
        commands: prompts.fileList(context.commands),
        message: params.text,
      },
      sessionId,
      fakeText: params.text,
    });

    let reply;
    try {
      reply = await ctx.step('reply', async (h) => {
        const wanted = ctx.services.drivers.pick('plan', project.settings());
        const resume = session && wanted.available && session.tool === wanted.name ? session.id : null;
        try {
          return await runAi(ctx, h, call(resume));
        } catch (err) {
          // A session the tool no longer has: start a new conversation once.
          if (!resume || isCancel(err) || err instanceof NeedsDecision || err.code !== 'ai_failed') throw err;
          h.log('the earlier conversation could not be continued: starting a new one');
          return runAi(ctx, h, call(null));
        }
      }, { verb: 'plan' });
    } catch (err) {
      if (!isCancel(err) && !(err instanceof NeedsDecision)) {
        emit(chats.append(project, params.key, {
          role: 'assistant', text: '', error: errorText(err), job: ctx.job.id, reply_to: params.message,
        }));
      }
      throw err;
    }

    if (reply.sessionId) {
      const sessions = Object.assign({}, project.state().chat_sessions);
      sessions[params.key] = { tool: reply.tool, id: reply.sessionId };
      project.saveState({ chat_sessions: sessions });
    }
    const step = ctx.job.steps.find((s) => s.id === 'reply') || {};
    const message = chats.append(project, params.key, {
      role: 'assistant',
      text: String(reply.summary || ''),
      tool: reply.tool,
      job: ctx.job.id,
      reply_to: params.message,
      files: step.changed || [],
      commit: step.commit || null,
      decisions: reply.decisions,
    });
    emit(message);
    return { key: params.key, message };
  },
};
