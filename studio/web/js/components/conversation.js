// The project conversation, docked beside every screen. One conversation per
// project: it keeps its messages while the person moves between screens, and
// each message carries the screen it was sent from, so "change this" means
// the thing in front of them. A reply can point at another screen with a
// link, change files (and say which), or bring a story proposal to review.
// A turn is a job: it waits its turn behind a drawing and can be cancelled.

import { h, icon, mount } from '/js/dom.js';
import { t, tn, formatTime, formatDateTime } from '/js/i18n.js';
import { api, errorText } from '/js/api.js';
import { state, bus, rememberJob, ACTIVE } from '/js/store.js';
import { toolName, jobStatus } from '/js/labels.js';
import { button } from '/js/components/ui.js';
import { openDialog, confirmDialog } from '/js/components/dialog.js';
import { showFile } from '/js/components/editor.js';
import { changesView } from '/js/components/diff.js';
import { toast } from '/js/components/toast.js';
import { dockFloats, dockExpanded, setLayout, setTransient, resizeHandle } from '/js/layout.js';

let root = null;
let conv = null; // the current conversation
let viewing = null; // an earlier conversation being read, or null
let loadedFor = null;
let pending = [];
let unread = 0;
let failed = null;
const openChanges = new Set();
let input = null;
let sendBtn = null;
let listEl = null;
let waitEl = null;
let contextEl = null;
let headEl = null;
let sending = false;
let miniEl = null;

/** The collapsed conversation: one button, with a marker when a reply arrived. */
function paintMini() {
  if (!miniEl) return;
  const label = unread ? t('convo.show_unread', { n: unread }) : t('convo.show');
  mount(miniEl, h('button', { type: 'button', class: 'btn icon-only quiet', 'aria-label': label, title: label, onclick: () => setDock(true, { focus: true }) },
    icon('chat'), unread ? h('span', { class: 'unread-dot', 'aria-hidden': 'true' }) : null));
}

function narrow() {
  return dockFloats();
}

/** Whether the conversation is showing (not collapsed to its rail, not hidden by focus mode). */
export function dockOpen() {
  return !!root && !root.hidden && dockExpanded();
}

/**
 * Show the conversation or collapse it. Beside the screen, the choice is part
 * of the person's layout; floating over the screen, it lasts until they leave.
 */
export function setDock(open, { focus = false } = {}) {
  if (!root) return;
  if (narrow()) setTransient({ dockFloat: !!open });
  else setLayout(open ? { dockCollapsed: false, focus: false } : { dockCollapsed: true });
  if (dockOpen()) {
    unread = 0;
    paintMini();
    paintList();
    if (focus && input) input.focus();
  }
  bus.emit('dock', dockOpen());
}

export function toggleDock() {
  const opening = !dockOpen();
  setDock(opening, { focus: opening });
}

export function unreadCount() {
  return unread;
}

/**
 * Open the dock with a request ready to send, or send it at once. Used by
 * screens that offer "ask in the conversation".
 */
export async function askInConversation(text, { send = false } = {}) {
  // A request goes to the current conversation, never to an earlier one being read.
  if (viewing) {
    viewing = null;
    paintHead();
    paintContext();
    paintList();
  }
  setDock(true, { focus: true });
  if (!input) return null;
  input.value = text;
  input.dispatchEvent(new Event('input'));
  if (send) return sendNow();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  return null;
}

function draftKey() {
  return `studio.convo.${state.projectId}`;
}

function messageLink(route, label) {
  return h('a', { class: 'msg-from', href: route, title: t('convo.open_screen', { name: label }) }, label);
}

function screenLabel(m) {
  return (m.screen && m.screen.label) || m.key || '';
}

function changesToggle(m) {
  const holder = h('div', { class: 'chat-changes' });
  const btn = h('button', { type: 'button', class: 'btn small quiet' });
  const paint = () => {
    const shown = openChanges.has(m.id);
    btn.setAttribute('aria-expanded', String(shown));
    mount(btn, icon(shown ? 'down' : 'right'), h('span', null, shown ? t('chat.hide_changes') : t('chat.show_changes')));
    if (shown && !holder.firstChild) holder.append(changesView(state.projectId, { commit: m.commit }));
    holder.hidden = !shown;
  };
  btn.addEventListener('click', () => {
    if (openChanges.has(m.id)) openChanges.delete(m.id); else openChanges.add(m.id);
    paint();
  });
  paint();
  return h('div', { class: 'stack-s' }, h('div', { class: 'row' }, btn), holder);
}

function messageNode(m) {
  const base = `/p/${encodeURIComponent(state.projectId)}`;
  if (m.role === 'event') {
    return h('li', { class: 'msg event' }, h('p', { class: 'msg-text' }, m.text || ''));
  }
  const from = m.screen && m.screen.route ? messageLink(m.screen.route, screenLabel(m)) : h('span', { class: 'msg-from' }, screenLabel(m));
  if (m.role === 'user') {
    return h('li', { class: 'msg user' },
      h('div', { class: 'msg-meta' }, t('convo.from'), from, h('span', null, formatTime(m.at))),
      h('div', { class: 'msg-text' }, m.text));
  }
  const files = m.files || [];
  const links = m.links || [];
  return h('li', { class: `msg assistant${m.error ? ' failed' : ''}` },
    h('div', { class: 'msg-meta' }, h('strong', null, toolName(m.tool) || t('chat.assistant')), h('span', null, formatTime(m.at)),
      m.folded_from ? h('span', null, t('convo.folded')) : null),
    m.error
      ? h('div', { class: 'msg-text' }, t('chat.turn_failed'), ' ', typeof m.error === 'string' ? m.error : (m.error.message || ''))
      : h('div', { class: 'msg-text' }, m.text),
    links.length ? h('div', { class: 'msg-links' }, links.map((l) => h('a', { href: l.route }, icon('right'), h('span', null, l.label || l.screen_label)))) : null,
    m.proposal && m.proposal.id
      ? h('div', { class: 'msg-proposal' },
        h('strong', null, tn('convo.proposal', m.proposal.parts || 0)),
        h('span', { class: 'small muted' }, t('convo.proposal_hint')),
        h('a', { class: 'btn small primary', href: `${base}/story?proposal=${encodeURIComponent(m.proposal.id)}` }, t('convo.proposal_review')))
      : null,
    m.reverted && m.reverted.length ? h('p', { class: 'msg-extra small' }, t('convo.reverted')) : null,
    m.decisions && m.decisions.length
      ? h('div', { class: 'msg-extra' }, h('span', { class: 'muted' }, t('chat.decisions')),
        h('ul', { class: 'bullets' }, m.decisions.map((d) => h('li', null, d))))
      : null,
    files.length
      ? h('div', { class: 'msg-extra changed' },
        h('strong', null, tn('chat.changed', files.length)),
        h('details', null, h('summary', { class: 'small muted' }, t('convo.which_files')),
          h('ul', { class: 'file-list' }, files.map((path) => h('li', null,
            h('button', { type: 'button', class: 'link', onclick: () => showFile(state.projectId, path) }, path))))),
        m.commit ? changesToggle(m) : null,
        m.commit ? h('span', { class: 'muted' }, t('chat.undo_hint'), ' ', h('a', { href: `${base}/history` }, t('nav.history'))) : null)
      : null);
}

function emptyNode() {
  const examples = state.screenExamples || [];
  return h('li', { class: 'convo-empty' },
    h('h3', null, t('convo.empty_title')),
    h('p', null, t('convo.empty_body')),
    examples.length ? h('div', { class: 'chat-examples' }, examples.map((ex) => h('button', {
      type: 'button',
      onclick: () => { input.value = ex; input.dispatchEvent(new Event('input')); input.focus(); },
    }, ex))) : null);
}

function paintList() {
  if (!listEl) return;
  const shown = viewing || conv;
  if (failed && !shown) {
    mount(listEl, h('li', { class: 'convo-empty' }, h('p', null, failed), button(t('action.try_again'), { small: true, onclick: () => load(true) })));
    return;
  }
  if (!shown) {
    mount(listEl, h('li', { class: 'loading' }, t('state.loading')));
    return;
  }
  const msgs = shown.messages || [];
  mount(listEl, msgs.length ? msgs.map(messageNode) : emptyNode());
  listEl.scrollTop = listEl.scrollHeight;
  paintWait();
}

function paintWait() {
  if (!waitEl) return;
  const jobs = viewing ? [] : pending.map((id) => state.jobs.get(id)).filter((j) => j && ACTIVE.includes(j.status));
  mount(waitEl, jobs.map((job) => h('div', { class: 'chat-wait' },
    h('span', { class: 'pulse', 'aria-hidden': 'true' }),
    h('span', { class: 'grow' }, job.status === 'running' ? t('chat.thinking') : `${t('chat.waiting_turn')} ${jobStatus(job)}`),
    button(t('jobs.cancel'), {
      kind: 'quiet', small: true,
      onclick: async () => {
        try {
          const res = await api.cancelJob(state.projectId, job.id);
          rememberJob(res.job);
        } catch (err) { toast(errorText(err), { kind: 'bad' }); }
      },
    }))));
}

function paintContext() {
  if (!contextEl) return;
  const s = state.screen;
  if (viewing) {
    mount(contextEl, h('span', null, t('convo.reading_old')));
  } else {
    mount(contextEl, icon('chat'), h('span', null, t('convo.asking_about')), h('strong', null, s ? s.label : t('convo.no_screen')));
  }
  if (input) input.disabled = !!viewing || !s;
  if (sendBtn) sendBtn.disabled = !!viewing || !s || sending;
}

function paintHead() {
  if (!headEl) return;
  const session = conv && conv.session && conv.session.tool;
  mount(headEl,
    h('h2', { id: 'convo-title' }, t('convo.title'), session ? h('span', { class: 'tool-tag' }, toolName(session)) : null),
    button(t('convo.new'), { kind: 'quiet', small: true, icon: 'plus', onclick: newConversation }),
    h('button', { type: 'button', class: 'btn icon-only quiet small', 'aria-label': t('convo.earlier'), title: t('convo.earlier'), onclick: earlier }, icon('clock')),
    h('button', { type: 'button', class: 'btn icon-only quiet small', 'aria-label': t('convo.hide'), title: t('convo.hide'), onclick: () => { setDock(false); const b = root.querySelector('.dock-mini button') || document.querySelector('.dock-toggle'); if (b && b.offsetParent) b.focus(); else if (document.querySelector('.dock-toggle')) document.querySelector('.dock-toggle').focus(); } }, icon(narrow() ? 'close' : 'right')));
  const banner = root.querySelector('.convo-old');
  if (banner) banner.hidden = !viewing;
}

async function load(force) {
  if (!state.projectId) return;
  const id = state.projectId;
  if (!force && loadedFor === id && conv) return;
  loadedFor = id;
  failed = null;
  try {
    const res = await api.conversation(id);
    if (state.projectId !== id) return;
    conv = res.conversation;
    pending = (conv.pending || []).slice();
  } catch (err) {
    failed = errorText(err);
    conv = null;
  }
  paintHead();
  paintList();
}

async function sendNow() {
  const text = input.value.trim();
  if (!text) {
    input.focus();
    return null;
  }
  if (!state.screen || sending) return null;
  sending = true;
  paintContext();
  try {
    const res = await api.sendMessage(state.projectId, text, state.screen);
    if (!conv || conv.id !== res.conversation) await load(true);
    if (conv && !conv.messages.some((m) => m.id === res.message.id)) conv.messages.push(res.message);
    if (!pending.includes(res.job.id)) pending.push(res.job.id);
    rememberJob(res.job);
    input.value = '';
    try { sessionStorage.removeItem(draftKey()); } catch (err) { /* storage is off */ }
    paintList();
    return res;
  } catch (err) {
    toast(errorText(err), { kind: 'bad' });
    return null;
  } finally {
    sending = false;
    paintContext();
  }
}

async function newConversation() {
  const ok = await confirmDialog({
    title: t('convo.new_title'),
    body: t('convo.new_body'),
    confirm: t('convo.new_confirm'),
    run: () => api.newConversation(state.projectId),
  });
  if (!ok) return;
  conv = ok.result.conversation;
  viewing = null;
  pending = [];
  paintHead();
  paintContext();
  paintList();
  toast(t('convo.new_done'), { kind: 'ok' });
}

async function earlier() {
  const list = h('div', { class: 'convo-history' }, h('p', { class: 'loading' }, t('state.loading')));
  const dialog = openDialog({ title: t('convo.earlier'), body: list });
  try {
    const { conversations } = await api.conversations(state.projectId);
    mount(list, conversations.length ? conversations.map((c) => h('button', {
      type: 'button', 'aria-current': String(!!c.current),
      onclick: async () => {
        dialog.close();
        if (c.current) {
          viewing = null;
        } else {
          try {
            viewing = (await api.conversationById(state.projectId, c.id)).conversation;
          } catch (err) {
            toast(errorText(err), { kind: 'bad' });
            return;
          }
        }
        setDock(true);
        paintHead();
        paintContext();
        paintList();
      },
    },
    h('span', null, h('strong', null, c.current ? t('convo.current') : formatDateTime(c.started_at)),
      c.folded && c.folded.length ? h('span', { class: 'small muted' }, ` ${t('convo.folded_note')}`) : null),
    h('span', { class: 'small muted' }, tn('convo.messages', c.messages || 0)))) : h('p', { class: 'muted' }, t('convo.none_earlier')));
  } catch (err) {
    mount(list, h('p', { class: 'notice bad' }, errorText(err)));
  }
}

function build() {
  headEl = h('div', { class: 'convo-head' });
  listEl = h('ol', { class: 'convo-list', tabIndex: 0, 'aria-label': t('chat.transcript'), 'aria-live': 'polite' });
  waitEl = h('div', { 'aria-live': 'polite' });
  contextEl = h('div', { class: 'convo-context' });
  input = h('textarea', { rows: 3, placeholder: t('chat.placeholder'), 'aria-label': t('chat.input_label'), maxLength: 8000 });
  try { input.value = sessionStorage.getItem(draftKey()) || ''; } catch (err) { /* storage is off */ }
  input.addEventListener('input', () => {
    try { sessionStorage.setItem(draftKey(), input.value); } catch (err) { /* storage is off */ }
  });
  sendBtn = button(t('chat.send'), { kind: 'accent', small: true, onclick: () => sendNow() });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      sendNow();
    }
  });
  const back = button(t('convo.back_current'), { kind: 'quiet', small: true, onclick: () => { viewing = null; paintHead(); paintContext(); paintList(); } });
  miniEl = h('div', { class: 'dock-mini' });
  paintMini();
  mount(root, resizeHandle('dock'), miniEl, h('section', { class: 'convo', 'aria-labelledby': 'convo-title' },
    headEl,
    h('div', { class: 'convo-old', hidden: true }, h('span', null, t('convo.old_banner')), back),
    listEl,
    waitEl,
    h('div', { class: 'convo-form' }, contextEl, input,
      h('div', { class: 'row spread' }, h('span', { class: 'small faint' }, t('chat.send_hint')), sendBtn))));
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && narrow()) {
      setDock(false);
      const b = document.querySelector('.dock-toggle');
      if (b) b.focus();
    }
  });
  paintHead();
  paintContext();
  paintList();
}

/** Start once with the shell. */
export function startConversation() {
  root = document.getElementById('dock');
  bus.on('project', (id) => {
    conv = null;
    viewing = null;
    pending = [];
    unread = 0;
    loadedFor = null;
    if (!id) {
      root.hidden = true;
      bus.emit('dock', false);
      return;
    }
    root.hidden = false;
    build();
    load(true);
    bus.emit('dock', dockOpen());
  });
  bus.on('layout', () => {
    if (dockOpen() && unread) { unread = 0; paintMini(); }
    bus.emit('dock', dockOpen());
  });
  bus.on('screen', () => {
    paintContext();
    if (conv && !(conv.messages || []).length) paintList();
  });
  bus.on('repaint', () => { if (state.projectId) { build(); load(true); } });
  bus.on('chat', (data) => {
    if (!data.message || !conv || data.conversation !== conv.id) return;
    if (!conv.messages.some((m) => m.id === data.message.id)) {
      conv.messages.push(data.message);
      if (data.message.role === 'assistant' && !dockOpen()) {
        unread += 1;
        paintMini();
        bus.emit('dock', false);
      }
    }
    if (data.message.job && data.message.role !== 'user') pending = pending.filter((id) => id !== data.message.job);
    if (data.message.role === 'event' && data.message.tool && conv.session) conv.session.tool = data.message.tool;
    if (!viewing) paintList();
    paintHead();
  });
  bus.on('job', ({ job }) => {
    if (!pending.includes(job.id)) return;
    if (job.status === 'cancelled' || job.status === 'failed') {
      pending = pending.filter((id) => id !== job.id);
      load(true);
      return;
    }
    paintWait();
  });
}
