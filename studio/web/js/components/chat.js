// The chat of one screen. The AI is given the files of that screen and may
// change them; a reply lists what it changed. A turn is a job, so it waits
// behind whatever is running and can be cancelled like one.

import { h, icon, mount } from '/js/dom.js';
import { t, tn, formatTime } from '/js/i18n.js';
import { api, errorText } from '/js/api.js';
import { state, bus, rememberJob, ACTIVE } from '/js/store.js';
import { toolName, jobStatus } from '/js/labels.js';
import { actionButton, button } from '/js/components/ui.js';
import { showFile } from '/js/components/editor.js';
import { toast } from '/js/components/toast.js';

function messageNode(projectId, m) {
  if (m.role === 'user') {
    return h('li', { class: 'msg user' },
      h('div', { class: 'msg-meta' }, t('chat.you'), ' · ', formatTime(m.at)),
      h('div', { class: 'msg-text' }, m.text));
  }
  const files = m.files || [];
  return h('li', { class: `msg assistant${m.error ? ' failed' : ''}` },
    h('div', { class: 'msg-meta' }, toolName(m.tool) || t('chat.assistant'), ' · ', formatTime(m.at)),
    m.error
      ? h('div', { class: 'msg-text' }, t('chat.turn_failed'), ' ', typeof m.error === 'string' ? m.error : (m.error.message || ''))
      : h('div', { class: 'msg-text' }, m.text),
    m.decisions && m.decisions.length
      ? h('div', { class: 'msg-extra' }, h('p', { class: 'small muted' }, t('chat.decisions')),
        h('ul', { class: 'bullets small' }, m.decisions.map((d) => h('li', null, d))))
      : null,
    files.length
      ? h('div', { class: 'msg-extra changed' },
        h('p', { class: 'small' }, h('strong', null, tn('chat.changed', files.length))),
        h('ul', { class: 'file-list' }, files.map((path) => h('li', null,
          h('button', { type: 'button', class: 'link', onclick: () => showFile(projectId, path) }, path)))),
        m.commit ? h('p', { class: 'small muted' }, t('chat.undo_hint'), ' ',
          h('a', { href: `/p/${encodeURIComponent(projectId)}/history` }, t('nav.history'))) : null)
      : (m.error ? null : h('p', { class: 'msg-extra small faint' }, t('chat.no_changes'))));
}

/**
 * chatPanel(ctx, key, { title }) -> a node that keeps itself up to date.
 * Use ctx.persist() so the same panel survives refreshes of the screen.
 */
export function chatPanel(ctx, key, { title, examples } = {}) {
  const projectId = ctx.projectId;
  const list = h('ol', { class: 'chat-list', dataset: { scroll: `chat:${key}` }, tabIndex: 0, 'aria-label': t('chat.transcript') });
  const pendingBox = h('div', { class: 'chat-pending', 'aria-live': 'polite' });
  const draft = ctx.draft(`chat:${key}`);
  const input = h('textarea', { rows: 3, placeholder: t('chat.placeholder'), 'aria-label': t('chat.input_label'), maxLength: 8000 });
  input.value = draft.get();
  input.dataset.keep = draft.key;
  input.addEventListener('input', () => draft.set(input.value));
  let messages = [];
  let pending = [];
  let contextFiles = [];
  let loaded = false;
  let failed = false;

  const scrollDown = () => { list.scrollTop = list.scrollHeight; };

  const paintPending = () => {
    const jobs = pending.map((id) => state.jobs.get(id)).filter((j) => j && ACTIVE.includes(j.status));
    mount(pendingBox, jobs.map((job) => h('div', { class: 'chat-wait' },
      h('span', { class: 'pulse', 'aria-hidden': 'true' }),
      h('span', { class: 'grow' }, job.status === 'running' ? t('chat.thinking') : `${t('chat.waiting_turn')} ${jobStatus(job)}`),
      button(t('jobs.cancel'), {
        kind: 'quiet', small: true,
        onclick: async () => {
          try {
            const res = await api.cancelJob(projectId, job.id);
            rememberJob(res.job);
          } catch (err) { toast(errorText(err), { kind: 'bad' }); }
        },
      }))));
  };

  const paint = () => {
    if (!loaded) return;
    if (!messages.length) {
      mount(list, h('li', { class: 'chat-empty' },
        h('p', null, t('chat.empty')),
        examples && examples.length ? h('ul', { class: 'chat-examples' }, examples.map((ex) => h('li', null,
          h('button', { type: 'button', class: 'link', onclick: () => { input.value = ex; draft.set(ex); input.focus(); } }, ex)))) : null,
        contextFiles.length ? h('p', { class: 'small faint' }, tn('chat.context', contextFiles.length)) : null));
    } else {
      mount(list, messages.map((m) => messageNode(projectId, m)));
    }
    paintPending();
    scrollDown();
  };

  const load = async () => {
    try {
      const res = await api.chat(projectId, key);
      messages = res.messages || [];
      pending = res.pending || [];
      contextFiles = res.files || [];
      loaded = true;
      failed = false;
      paint();
    } catch (err) {
      loaded = true;
      failed = true;
      // The thing this chat is about may not exist yet (an issue before its first plan).
      mount(list, h('li', { class: 'chat-empty' }, err.code === 'chat_target_not_found' ? t('chat.not_yet') : errorText(err)));
    }
  };

  const send = async () => {
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    if (failed) await load();
    const res = await api.sendChat(projectId, key, text);
    // The event stream may have delivered the same message already.
    if (!messages.some((m) => m.id === res.message.id)) messages.push(res.message);
    if (!pending.includes(res.job.id)) pending.push(res.job.id);
    rememberJob(res.job);
    input.value = '';
    draft.clear();
    paint();
  };

  const sendBtn = actionButton(t('chat.send'), send, { kind: 'primary' });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      sendBtn.click();
    }
  });

  const offChat = bus.on('chat', (data) => {
    if (data.key !== key || !data.message) return;
    if (!messages.some((m) => m.id === data.message.id)) messages.push(data.message);
    if (data.message.role === 'assistant' && data.message.job) pending = pending.filter((id) => id !== data.message.job);
    paint();
  });
  const offJob = bus.on('job', ({ job }) => {
    if (!pending.includes(job.id)) return;
    if (job.status === 'cancelled' || job.status === 'failed') {
      pending = pending.filter((id) => id !== job.id);
      // A failed turn leaves an assistant message with the error; fetch it.
      load();
      return;
    }
    paintPending();
  });
  const offFiles = bus.on('files', () => {
    if (failed) load();
  });
  const offRoute = bus.on('route', () => {
    offChat();
    offJob();
    offFiles();
    offRoute();
  });

  load();

  return h('section', { class: 'chat panel', 'aria-label': title || t('chat.title') },
    h('h2', { class: 'panel-title' }, icon('chat'), ' ', title || t('chat.title')),
    h('p', { class: 'small muted chat-scope' }, t('chat.scope')),
    list,
    pendingBox,
    h('div', { class: 'chat-form' }, input,
      h('div', { class: 'row spread' }, h('span', { class: 'small faint' }, t('chat.send_hint')), sendBtn)));
}
