'use strict';
/**
 * One conversation per project that follows the person across screens.
 *
 * Every message carries the screen it was sent from ({ key, label, route }),
 * and the AI gets that screen's files as context. The person can start a
 * fresh conversation; the earlier ones stay readable.
 *
 *   <project>/.studio/conversations/index.json   { current, conversations: [{ id, started_at, session, folded }] }
 *   <project>/.studio/conversations/<id>.jsonl   the messages, oldest first
 *
 * The tool's own session (`--resume` for Claude Code, `codex exec resume`
 * for Codex) carries the conversation from one message to the next while the
 * same tool answers. When another tool answers, it starts a session of its
 * own and gets a short summary of the conversation so far; the transcript
 * records that as an event message.
 *
 * The conversations per screen of earlier versions (.studio/chats/) are
 * folded into the first project conversation, in time order and tagged with
 * their screen, the first time the conversation is read. Their files stay
 * where they are.
 */

const fs = require('fs');
const path = require('path');
const chats = require('./chats');
const screens = require('./screens');
const { msg } = require('./i18n');
const { HttpError, appendJsonl, readJsonl, readJson, writeJsonAtomic, newId, nowIso } = require('./util');

const CONV_RE = /^conv_[a-z0-9_]{6,60}$/;
const SUMMARY_MESSAGES = 12;

function dirOf(project) {
  return path.join(project.studioDir, 'conversations');
}

function indexFile(project) {
  return path.join(dirOf(project), 'index.json');
}

function fileOf(project, id) {
  return path.join(dirOf(project), `${id}.jsonl`);
}

function readIndex(project) {
  const doc = readJson(indexFile(project), null);
  return doc && Array.isArray(doc.conversations) && doc.current ? doc : null;
}

function writeIndex(project, index) {
  writeJsonAtomic(indexFile(project), index);
}

/** A screen object for a key of an earlier transcript, without requiring the screen to exist still. */
function legacyScreen(project, key) {
  return { key, label: screens.labelOf(project, key), route: screens.routeOf(project.id, key) };
}

/** The messages of the per-screen transcripts, merged in time order and tagged with their screen. */
function foldLegacy(project, conversationId) {
  const listed = chats.list(project);
  const merged = [];
  let seq = 0;
  for (const entry of listed) {
    for (const m of chats.transcript(project, entry.key)) {
      merged.push({ m, key: entry.key, seq: seq++ });
    }
  }
  merged.sort((a, b) => String(a.m.at).localeCompare(String(b.m.at)) || a.seq - b.seq);
  const lines = merged.map(({ m, key }) => Object.assign({}, m, {
    conversation: conversationId,
    key,
    screen: legacyScreen(project, key),
    folded_from: key,
  }));
  return { lines, keys: listed.map((e) => e.key) };
}

/**
 * The index, created on first use: a first conversation that holds the
 * folded per-screen transcripts.
 */
function ensure(project) {
  const existing = readIndex(project);
  if (existing) return existing;
  fs.mkdirSync(dirOf(project), { recursive: true });
  const id = newId('conv').toLowerCase();
  const { lines, keys } = foldLegacy(project, id);
  for (const line of lines) appendJsonl(fileOf(project, id), line);
  if (keys.length) {
    appendJsonl(fileOf(project, id), {
      id: newId('msg'), at: nowIso(), conversation: id, role: 'event', event: 'folded',
      text: msg('conversation.folded', { n: keys.length }), keys,
    });
  }
  const index = { current: id, conversations: [{ id, started_at: nowIso(), session: null, folded: keys }] };
  writeIndex(project, index);
  return index;
}

function entryOf(index, id) {
  const entry = index.conversations.find((c) => c.id === id);
  if (!entry) throw new HttpError(404, 'conversation_not_found', 'There is no conversation with that id in this project.');
  return entry;
}

/** The messages of a conversation, oldest first. */
function messages(project, id) {
  return readJsonl(fileOf(project, id));
}

/** The conversations, newest first: [{ id, started_at, current, messages, last_at }]. */
function list(project) {
  const index = ensure(project);
  return index.conversations.slice().reverse().map((c) => {
    const all = messages(project, c.id).filter((m) => m.role !== 'event');
    return {
      id: c.id,
      started_at: c.started_at,
      current: c.id === index.current,
      messages: all.length,
      last_at: all.length ? all[all.length - 1].at : null,
      folded: c.folded || [],
    };
  });
}

function current(project) {
  const index = ensure(project);
  return entryOf(index, index.current);
}

function get(project, id) {
  if (!CONV_RE.test(String(id))) throw new HttpError(404, 'conversation_not_found', 'There is no conversation with that id in this project.');
  return entryOf(ensure(project), id);
}

/** Start a fresh conversation. The earlier one stays readable. */
function start(project) {
  const index = ensure(project);
  const id = newId('conv').toLowerCase();
  index.conversations.push({ id, started_at: nowIso(), session: null, folded: [] });
  index.current = id;
  writeIndex(project, index);
  return entryOf(index, id);
}

/** Append a message and return it with its id and time. */
function append(project, conversationId, message) {
  const full = Object.assign({ id: newId('msg'), at: nowIso(), conversation: conversationId, role: 'assistant', text: '', job: null }, message);
  if (full.screen && !full.key) full.key = full.screen.key;
  appendJsonl(fileOf(project, conversationId), full);
  return full;
}

/** Remember the tool session of a conversation. */
function setSession(project, conversationId, session) {
  const index = ensure(project);
  const entry = entryOf(index, conversationId);
  entry.session = session;
  writeIndex(project, index);
}

/**
 * A short summary of the conversation so far, for a tool that starts a new
 * session in the middle of it: the last messages, each with its screen.
 * Plain text for the prompt.
 */
function summaryFor(project, conversationId, { exceptId } = {}) {
  const all = messages(project, conversationId).filter((m) => m.role !== 'event' && m.id !== exceptId && (m.text || '').trim());
  if (!all.length) return '';
  const recent = all.slice(-SUMMARY_MESSAGES);
  const lines = recent.map((m) => {
    const where = m.screen && m.screen.key ? ` (from the ${m.screen.key} screen)` : '';
    const who = m.role === 'user' ? 'The person' : `The assistant${m.tool ? ` (${m.tool})` : ''}`;
    return `- ${who}${where}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 400)}`;
  });
  const skipped = all.length - recent.length;
  return [skipped > 0 ? `${skipped} earlier message(s) left out.` : null, ...lines].filter(Boolean).join('\n');
}

/** Messages sent from one screen (the read-only view behind GET /chats/:key). */
function byScreen(project, key) {
  const index = ensure(project);
  return messages(project, index.current).filter((m) => m.role !== 'event' && (m.key === key || (m.screen && m.screen.key === key)));
}

/** Screens with messages in the current conversation: [{ key, messages, last_at }]. */
function screensUsed(project) {
  const index = ensure(project);
  const out = new Map();
  for (const m of messages(project, index.current)) {
    if (m.role === 'event') continue;
    const key = m.key || (m.screen && m.screen.key);
    if (!key) continue;
    const entry = out.get(key) || { key, messages: 0, last_at: null };
    entry.messages += 1;
    entry.last_at = m.at;
    out.set(key, entry);
  }
  return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

module.exports = {
  CONV_RE, ensure, list, current, get, start, append, messages, setSession, summaryFor, byScreen, screensUsed,
};
