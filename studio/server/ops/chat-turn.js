'use strict';
/**
 * chat.turn: one message of the project conversation. The context is the
 * files of the screen the message was sent from; the model may edit them,
 * except the story bible: story text comes back as a proposal the person
 * decides on (studio/server/story.js). The reply can suggest screens to go
 * to (`data.links`), checked against the project's real screens.
 *
 * The conversation continues through the tool's own session while the same
 * tool answers. When the answering tool changes, the new one starts a
 * session with a summary of the conversation so far, and the transcript
 * says so.
 */

const fs = require('fs');
const chats = require('../chats');
const conversation = require('../conversation');
const screens = require('../screens');
const story = require('../story');
const { msg } = require('../i18n');
const prompts = require('../prompts');
const S = require('../scaffold');
const { runAi, TOOL_LABELS } = require('../ai');
const { isCancel, NeedsDecision } = require('../jobs');
const { str } = require('./shared');
const { errorText } = require('../util');

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

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    return null;
  }
}

module.exports = {
  name: 'chat.turn',
  params: [
    { name: 'screen', type: 'object', required: true, description: 'The screen the message was sent from: { key, label, route }. key is a screen key: story, style, options, characters, places, character:<ID>, location:<ID>, prop:<ID>, pages:<ISS_ID>, page:<PAGE_ID>, cover:<ISS_ID>, publish:<ISS_ID>.' },
    { name: 'text', type: 'string', required: true, description: 'The person\'s message.' },
    { name: 'conversation', type: 'string', required: false, description: 'Conversation id. Default: the current conversation of the project.' },
    { name: 'key', type: 'string', required: false, description: 'Deprecated: the screen key alone, as the per-screen chat sent it.' },
  ],

  validate(params, { project }) {
    const screen = screens.checkScreen(project, params.screen !== undefined ? params.screen : String(params.key || ''));
    const conv = params.conversation ? conversation.get(project, String(params.conversation)) : conversation.current(project);
    return {
      key: screen.key,
      screen,
      conversation: conv.id,
      text: str(params, 'text', { required: true, max: 8000 }),
      message: params.message ? String(params.message) : null,
    };
  },

  steps() {
    return [{ id: 'reply', label: msg('step.chat.reply') }];
  },

  async run(ctx) {
    const { project, params } = ctx;
    const root = project.root;
    const convId = params.conversation;
    const screen = params.screen || screens.checkScreen(project, params.key);
    const context = chats.contextOf(project, screen.key);
    const emit = (message) => ctx.services.events.emit(project.id, 'chat', { conversation: convId, key: message.key || screen.key, message });
    const record = (message) => {
      const stored = conversation.append(project, convId, message);
      emit(stored);
      return stored;
    };
    const entry = conversation.get(project, convId);
    const session = entry.session || null;
    const bibleFile = S.ws.abs(root, story.BIBLE);
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
        bible: bibleFile,
      },
      sessionId,
      fakeText: params.text,
    });

    const bibleBefore = readText(bibleFile);
    let bibleStat = null;
    try {
      bibleStat = fs.statSync(bibleFile);
    } catch (err) {
      bibleStat = null;
    }
    // The story bible changes only through a proposal the person accepts. A
    // reply that wrote it anyway is undone inside the step, so the step's
    // commit never carries it.
    const guardBible = async (h, fn) => {
      const reverted = [];
      let result;
      try {
        result = await fn();
      } finally {
        if (readText(bibleFile) !== bibleBefore) {
          if (bibleBefore === null) fs.rmSync(bibleFile, { force: true });
          else {
            fs.writeFileSync(bibleFile, bibleBefore);
            // Back to its old time too, so the step's diff sees no change.
            if (bibleStat) fs.utimesSync(bibleFile, bibleStat.atime, bibleStat.mtime);
          }
          reverted.push(story.BIBLE);
          h.log('the reply changed the story bible directly: the change was undone; story text goes through a proposal');
        }
      }
      return Object.assign(result, { reverted });
    };
    let reply;
    try {
      reply = await ctx.step('reply', (h) => guardBible(h, async () => {
        const wanted = ctx.services.drivers.pick('plan', project.settings());
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
      }), { verb: 'plan' });
    } catch (err) {
      if (!isCancel(err) && !(err instanceof NeedsDecision)) {
        record({ role: 'assistant', text: '', error: errorText(err), job: ctx.job.id, reply_to: params.message, screen, key: screen.key });
      }
      throw err;
    }
    const reverted = reply.reverted || [];

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
    // The step diff knows what changed; a reverted bible is not among the reply's changes.
    const step = ctx.job.steps.find((s) => s.id === 'reply') || {};
    const message = record({
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
    });
    return { conversation: convId, key: screen.key, message };
  },
};
