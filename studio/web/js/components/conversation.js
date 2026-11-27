// The project conversation, docked beside every screen. One conversation per
// project: it keeps its messages while the person moves between screens, and
// each message carries the screen it was sent from, so "change this" means
// the thing in front of them. A reply can point at another screen with a
// link, change files (and say which), or bring a story proposal to review.
// A turn is a job. While another job runs it answers at once, read-only.
//
// The person can attach images and text files (button, drop, paste). A
// reply can propose actions: each is a card that says what it will do, with
// which tool and how long it usually takes, and runs only on Run (or when the
// person confirms in words). A running card shows its job live; when it ends,
// the result comes back as a message with its images, links to the screens
// where it is approved, and the questions of a job that stopped to ask.

import { h, icon, mount, nextId } from '/js/dom.js';
import { t, tn, tv, formatTime, formatDateTime, formatDuration } from '/js/i18n.js';
import { api, errorText } from '/js/api.js';
import { state, bus, rememberJob, ACTIVE } from '/js/store.js';
import { toolName, jobStatus, jobOutcome } from '/js/labels.js';
import { button } from '/js/components/ui.js';
import { openDialog, confirmDialog } from '/js/components/dialog.js';
import { showFile } from '/js/components/editor.js';
import { changesView } from '/js/components/diff.js';
import { toast } from '/js/components/toast.js';
import { dockFloats, dockExpanded, setLayout, setTransient, resizeHandle } from '/js/layout.js';
import { jobCard, liveNode } from '/js/components/jobs.js';
import { openViewer } from '/js/components/viewer.js';
import { newsFor } from '/js/unseen.js';

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
let attachEl = null;
let fileInput = null;
// Files attached to the next message: { name, kind, pending, id, url }.
let attached = [];

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

/** Thumbnails of uploads: images open in the viewer, text files as a chip. */
function uploadThumbs(list) {
  const images = list.filter((u) => u.kind === 'image').map((u) => ({ id: u.id, label: u.name, image: { url: u.url } }));
  return h('div', { class: 'msg-attachments' }, list.map((u) => (u.kind === 'image'
    ? h('button', { type: 'button', class: 'attach-thumb', title: t('convo.attachment_open', { name: u.name }), 'aria-label': t('convo.attachment_open', { name: u.name }), onclick: () => openViewer(images, u.id) },
      h('img', { src: u.url, alt: '' }))
    : h('a', { class: 'attach-chip', href: u.url, target: '_blank', rel: 'noopener' }, icon('file'), h('span', null, u.name)))));
}

function cardTime(card) {
  const typical = card.typical || {};
  if (!typical.ms) return t('card.typical_unknown');
  const time = formatDuration(typical.ms / 1000);
  return typical.source === 'measured' ? t('card.typical_measured', { time }) : t('card.typical_reference', { time });
}

function cardTools(card) {
  const tools = card.tools || [];
  if (!tools.length) return null;
  if (tools.some((x) => !x.available)) return h('span', { class: 'bad' }, t('card.no_tool'));
  const names = [...new Set(tools.map((x) => (x.model ? t('card.tool_model', { tool: toolName(x.tool), model: x.model }) : t('card.tool', { tool: toolName(x.tool) }))))];
  return h('span', null, names.join(' · '));
}

async function runCard(card, choice) {
  try {
    const res = await api.runAction(state.projectId, card.conversation, card.id, choice);
    if (res.job) rememberJob(res.job);
    updateCard(res.card);
  } catch (err) {
    toast(errorText(err), { kind: 'bad' });
  }
}

async function dismissCard(card) {
  try {
    const res = await api.dismissAction(state.projectId, card.conversation, card.id);
    updateCard(res.card);
  } catch (err) {
    toast(errorText(err), { kind: 'bad' });
  }
}

/** A parameter of a card in plain words: its label from the dictionary, else the name with spaces. */
function paramLabel(name) {
  const label = t(`param.${name}`);
  return label === `param.${name}` ? String(name).replace(/_/g, ' ') : label;
}

/**
 * The parameters of a card: plain labels and values; the raw names and the
 * values as sent stay under a "Details" toggle.
 */
function cardDetails(card) {
  const details = card.details || [];
  if (!details.length) return null;
  return h('div', { class: 'action-params' },
    h('dl', { class: 'action-details plain' }, details.map((d) => [h('dt', null, paramLabel(d.name)), h('dd', null, d.name === 'sheet' ? tv('sheet', d.value, d.value) : d.name === 'mode' ? tv('correct_mode', d.value, d.value) : d.value)])),
    h('details', { class: 'action-raw' },
      h('summary', { class: 'small muted' }, t('card.raw_details')),
      h('dl', { class: 'action-details' }, Object.entries(card.params || {}).map(([name, value]) => [h('dt', null, h('code', null, name)),
        h('dd', null, h('code', null, typeof value === 'string' ? value : JSON.stringify(value)))]))));
}

/**
 * What a lettering card will change, before it runs: one line per balloon
 * added, removed, changed or moved, with the budgets it passes.
 */
function cardPreview(card) {
  const p = card.preview;
  if (!p || !Array.isArray(p.changes)) return null;
  return h('div', { class: 'action-preview' },
    p.changes.length
      ? h('ul', { class: 'letter-changes' }, p.changes.map((c) => h('li', { class: `letter-change ${c.change}` },
        h('span', { class: 'letter-change-kind' }, t(`letter.change_${c.change}`, { panel: c.panel })), ' ',
        h('span', { class: 'letter-glyph', 'aria-hidden': 'true' }, icon(c.kind)),
        h('span', null, ` ${t(`letter_kind.${c.kind}`)}${c.speaker ? `, ${c.speaker}` : ''}: `),
        c.before && c.change === 'changed' ? [h('del', null, c.before), ' '] : null,
        h('q', null, c.text))))
      : h('p', { class: 'small muted' }, t('letter.no_change')),
    (p.warnings || []).length ? h('p', { class: 'small action-warn' }, icon('alert'), ' ', tn('letter.card_over', p.warnings.length)) : null,
    p.drawn ? h('p', { class: 'small muted' }, t('letter.card_drawn')) : null);
}

/** A correction card at the touch-up warning: the warning and the person's two choices instead of Run. */
function cardChoice(card) {
  const c = card.choice;
  if (!c) return null;
  if (card.status !== 'pending') {
    return card.chosen ? h('p', { class: 'small muted' }, t('card.chosen', { choice: (c.options.find((o) => o.mode === card.chosen) || {}).label || card.chosen })) : null;
  }
  return h('div', { class: 'stack-s action-choice' },
    h('p', { class: 'small action-warn' }, icon('alert'), ' ', c.text),
    h('div', { class: 'row' },
      c.options.map((o, i) => button(o.label, { kind: i === 0 ? 'primary' : 'accent', small: true, onclick: () => runCard(card, o.mode) })),
      button(t('card.dismiss'), { kind: 'quiet', small: true, onclick: () => dismissCard(card) })));
}

/** The news marker of a screen a card or result links to (unseen.js). */
function linkNews(link) {
  const key = String(link.key || link.screen || '');
  const item = /^pages:/.test(key) ? key.replace(/^pages:/, 'plan:') : key;
  const list = item ? newsFor(item) : [];
  if (!list.length) return null;
  return h('span', { class: `news-dot${list.some((e) => e.tone === 'alert') ? ' alert' : ''}`, title: t('unseen.new'), 'aria-label': t('unseen.new') });
}

/** What a card does, its tool and time, and Run / Dismiss while it waits. A running card shows its job live. */
function actionCard(card) {
  const pending = card.status === 'pending';
  const status = h('span', { class: 'card-status', dataset: { status: card.status } }, tv('card_status', card.status, card.status));
  const live = card.job ? liveNode(() => {
    const job = state.jobs.get(card.job);
    if (!job || !ACTIVE.includes(job.status)) return null;
    return jobCard(job, { compact: true, open: job.status === 'running' });
  }, 'div') : null;
  const error = card.error ? (card.error.message || String(card.error)) : '';
  return h('section', { class: 'action-card', dataset: { status: card.status, card: card.id }, 'aria-label': `${t('card.label')}: ${card.title}` },
    h('div', { class: 'action-head' }, h('strong', null, card.title), status),
    h('p', { class: 'small muted' }, card.summary),
    card.why ? h('p', { class: 'action-why' }, h('span', { class: 'muted' }, t('card.why')), ' ', card.why) : null,
    cardDetails(card),
    cardPreview(card),
    card.after ? h('p', { class: 'small action-after' }, icon('right'), ' ', t('card.after', { n: card.after.n, title: card.after.title || '' })) : null,
    card.uploads && card.uploads.length ? uploadThumbs(card.uploads) : null,
    card.photo_rights ? h('p', { class: 'notice warn small' }, t('characters.photo_rights')) : null,
    h('p', { class: 'action-meta small' }, cardTools(card), card.tools && card.tools.length ? ' · ' : '', cardTime(card)),
    pending && card.draws && !card.choice ? h('p', { class: 'small action-warn' }, icon('alert'), ' ', t('card.draws')) : null,
    pending && card.decision ? h('p', { class: 'small action-warn' }, icon('alert'), ' ', t('card.decision')) : null,
    pending && card.always_confirm ? h('p', { class: 'small action-warn' }, icon('alert'), ' ', t('card.always_confirm')) : null,
    card.status === 'waiting' ? h('p', { class: 'small muted' }, t('card.waiting_for', { n: card.after ? card.after.n : '?' })) : null,
    card.status === 'cancelled' && card.error ? h('p', { class: 'small muted' }, error) : null,
    cardChoice(card),
    pending && !card.choice
      ? h('div', { class: 'row' },
        button(t('card.run'), { kind: card.draws ? 'accent' : 'primary', small: true, onclick: () => runCard(card) }),
        button(t('card.dismiss'), { kind: 'quiet', small: true, onclick: () => dismissCard(card) }))
      : null,
    card.run_by === 'text' && !pending ? h('p', { class: 'small muted' }, t('card.by_text')) : null,
    card.run_by === 'request' && !pending ? h('p', { class: 'small muted' }, t('card.by_request')) : null,
    card.run_by === 'auto' && !pending ? h('p', { class: 'small muted' }, t('card.by_auto')) : null,
    card.status === 'dismissed' ? h('p', { class: 'small muted' }, t('card.dismissed')) : null,
    card.status === 'done' && card.kind === 'direct' ? h('p', { class: 'small state-ok' }, t('card.done')) : null,
    card.status === 'failed' ? h('p', { class: 'small bad' }, t('card.failed'), ' ', error) : null,
    card.links && card.links.length ? h('div', { class: 'msg-links' }, card.links.map((l) => h('a', { href: l.route }, icon('right'), h('span', null, l.label || l.screen_label), linkNews(l)))) : null,
    live);
}

/** The questions of a paused job, answered here. */
function questionsForm(m) {
  const answers = {};
  const problem = h('p', { class: 'small bad', hidden: true });
  const blocks = (m.questions || []).map((q) => {
    const name = nextId('q');
    const otherId = nextId('qa');
    const other = h('input', { type: 'text', id: otherId, placeholder: t('decisions.other_placeholder') });
    const radios = (q.options || []).map((opt) => {
      const id = nextId('qo');
      const input = h('input', { type: 'radio', name, id, value: opt });
      input.addEventListener('change', () => { answers[q.id] = opt; other.value = ''; });
      return h('div', { class: 'check' }, input, h('label', { for: id }, opt));
    });
    other.addEventListener('input', () => {
      if (other.value.trim()) {
        answers[q.id] = other.value.trim();
        for (const r of radios) r.querySelector('input').checked = false;
      } else delete answers[q.id];
    });
    return h('fieldset', { class: 'question' }, h('legend', null, q.question), radios,
      h('div', { class: 'field' }, h('label', { for: otherId }, (q.options || []).length ? t('decisions.other_answer') : t('result.answer')), other));
  });
  const send = async () => {
    problem.hidden = true;
    if ((m.questions || []).some((q) => !answers[q.id])) {
      problem.textContent = t('result.missing_answer');
      problem.hidden = false;
      return;
    }
    try {
      const res = await api.answerJob(state.projectId, m.job, answers);
      rememberJob(res.job);
      toast(t('result.answered'), { kind: 'ok' });
    } catch (err) {
      problem.textContent = errorText(err);
      problem.hidden = false;
    }
  };
  return liveNode(() => {
    const job = state.jobs.get(m.job);
    if (job && job.status !== 'needs_decision') return null;
    return h('form', { class: 'result-questions stack-s', onsubmit: (e) => { e.preventDefault(); send(); } },
      h('p', null, h('strong', null, t('result.questions'))), blocks, problem,
      h('div', { class: 'row' }, button(t('result.send_answer'), { kind: 'primary', small: true, type: 'submit' })));
  }, 'div');
}

/** What the job added (characters, places, objects), each with its link and any possible duplicate. */
function addedLines(list) {
  const base = `/p/${encodeURIComponent(state.projectId)}`;
  return h('div', { class: 'result-added' },
    h('p', { class: 'small' }, h('strong', null, tn('added.title', list.length))),
    h('ul', { class: 'bullets small' }, list.map((e) => h('li', null,
      h('a', { href: e.kind === 'character' ? `${base}/characters/${e.id}` : `${base}/places/${e.kind}/${e.id}` }, e.name),
      e.needs_sheet ? ` · ${t('added.needs_sheet')}` : '',
      (e.duplicates || []).length ? h('span', { class: 'action-warn' }, ` · ${t('added.maybe_same', { other: e.duplicates[0].name })}`) : null))),
    h('a', { class: 'small', href: `${base}/pages` }, t('added.review_link')));
}

/** A job started from a card ended or paused: its outcome, images, links and questions. */
function resultNode(m) {
  const base = `/p/${encodeURIComponent(state.projectId)}`;
  const images = (m.images || []).map((img, i) => ({ id: `r${i}`, label: img.path, image: img }));
  const job = state.jobs.get(m.job);
  const outcome = job && job.status === m.status ? jobOutcome(job) : '';
  return h('li', { class: 'msg result', dataset: { status: m.status } },
    h('div', { class: 'msg-meta' }, h('strong', null, t('card.label')), h('span', null, formatTime(m.at))),
    h('div', { class: 'result-body' },
      h('p', null, h('strong', null, m.text || '')),
      outcome ? h('p', { class: 'small' }, outcome) : (m.summary ? h('p', { class: 'small' }, m.summary) : null),
      m.status === 'failed' && m.error && !outcome ? h('p', { class: 'small bad' }, m.error.message || '') : null,
      images.length
        ? h('div', { class: 'result-images', 'aria-label': t('result.images') }, images.map((img) => h('button', {
          type: 'button', class: 'attach-thumb', title: img.label, 'aria-label': t('convo.attachment_open', { name: img.label.split('/').pop() }),
          onclick: () => openViewer(images, img.id),
        }, h('img', { src: img.image.url, alt: '' }))))
        : null,
      (m.proposals || []).map((p) => h('a', { class: 'btn small primary', href: `${base}/story?proposal=${encodeURIComponent(p.id)}` },
        p.guard ? t('result.guard_proposal') : t('result.review_proposal'))),
      (m.added || []).length ? addedLines(m.added) : null,
      m.links && m.links.length ? h('div', { class: 'msg-links' }, m.links.map((l) => h('a', { href: l.route }, icon('right'), h('span', null, l.label || l.screen_label), linkNews(l)))) : null,
      m.status === 'needs_decision' && (m.questions || []).length ? questionsForm(m) : null));
}

function messageNode(m) {
  const base = `/p/${encodeURIComponent(state.projectId)}`;
  if (m.role === 'event' && m.event === 'action_result') return resultNode(m);
  if (m.role === 'event') {
    return h('li', { class: 'msg event' }, h('p', { class: 'msg-text' }, m.text || ''));
  }
  const from = m.screen && m.screen.route ? messageLink(m.screen.route, screenLabel(m)) : h('span', { class: 'msg-from' }, screenLabel(m));
  if (m.role === 'user') {
    return h('li', { class: 'msg user' },
      h('div', { class: 'msg-meta' }, t('convo.from'), from, h('span', null, formatTime(m.at))),
      h('div', { class: 'msg-text' }, m.text),
      m.attachments && m.attachments.length ? uploadThumbs(m.attachments) : null);
  }
  const dropped = m.dropped || [];
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
    m.story_proposal && m.story_proposal.id
      ? h('a', { class: 'btn small', href: `${base}/story?proposal=${encodeURIComponent(m.story_proposal.id)}` }, t('result.guard_proposal'))
      : null,
    m.read_only ? h('p', { class: 'msg-extra small muted' }, t('convo.read_only')) : null,
    (m.actions || []).length ? h('div', { class: 'msg-actions' }, m.actions.map(actionCard)) : null,
    dropped.length
      ? h('div', { class: 'msg-extra small' }, h('span', { class: 'muted' }, tn('convo.dropped', dropped.length)),
        h('ul', { class: 'bullets' }, dropped.map((d) => h('li', null, h('code', null, d.action), ' ', d.reason))))
      : null,
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
    h('span', { class: 'grow' }, job.status === 'running'
      ? (job.read_only ? t('convo.answering_beside') : t('chat.thinking'))
      : `${t('chat.waiting_turn')} ${jobStatus(job)}`),
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
  if (attached.some((a) => a.pending)) {
    toast(t('convo.attach_wait'), { kind: 'warn' });
    return null;
  }
  sending = true;
  paintContext();
  try {
    const res = await api.sendMessage(state.projectId, text, state.screen, attached.map((a) => a.id).filter(Boolean));
    attached = [];
    paintAttached();
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

function paintAttached() {
  if (!attachEl) return;
  attachEl.hidden = !attached.length;
  mount(attachEl, attached.map((item, index) => h('li', { class: 'attach-item' },
    item.kind === 'image' && item.url ? h('img', { src: item.url, alt: '' }) : icon('file'),
    h('span', { class: 'grow' }, item.name, item.pending ? h('span', { class: 'faint small' }, ` ${t('convo.attach_sending')}`) : null),
    h('button', {
      type: 'button', class: 'btn icon-only quiet small', 'aria-label': t('convo.attach_remove', { name: item.name }), title: t('convo.attach_remove', { name: item.name }),
      onclick: () => {
        attached.splice(index, 1);
        paintAttached();
        if (item.id) api.deleteUpload(state.projectId, item.id).catch(() => {});
      },
    }, icon('close')))));
}

const ATTACH_EXT = /\.(png|jpe?g|webp|txt|md|fountain)$/i;

/** Send picked, dropped or pasted files to the upload store; the next message carries their ids. */
async function attachFiles(list) {
  for (const raw of [...list].slice(0, 12)) {
    let file = raw;
    // A pasted image has no useful name.
    if (!file.name || !ATTACH_EXT.test(file.name)) {
      const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'text/plain': '.txt' }[file.type];
      if (!ext) {
        toast(`${file.name || file.type}: ${t('upload.image_limits')}`, { kind: 'bad' });
        continue;
      }
      file = new File([file], `pasted-${Date.now()}${ext}`, { type: file.type });
    }
    const item = { name: file.name, kind: /\.(png|jpe?g|webp)$/i.test(file.name) ? 'image' : 'source', pending: true };
    attached.push(item);
    paintAttached();
    try {
      const { upload } = await api.upload(state.projectId, file);
      Object.assign(item, upload, { pending: false });
    } catch (err) {
      attached.splice(attached.indexOf(item), 1);
      toast(`${file.name}: ${errorText(err)}`, { kind: 'bad' });
    }
    paintAttached();
  }
}

function build() {
  attached = [];
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
  attachEl = h('ul', { class: 'attach-list', hidden: true, 'aria-label': t('convo.attach') });
  fileInput = h('input', { type: 'file', multiple: true, accept: '.png,.jpg,.jpeg,.webp,.txt,.md,.fountain', class: 'sr-only', tabIndex: -1, 'aria-hidden': 'true' });
  fileInput.addEventListener('change', () => { attachFiles(fileInput.files); fileInput.value = ''; });
  const attachBtn = h('button', { type: 'button', class: 'btn icon-only quiet small', 'aria-label': t('convo.attach'), title: `${t('convo.attach')}. ${t('convo.attach_hint')}`, onclick: () => fileInput.click() }, icon('upload'));
  input.addEventListener('paste', (event) => {
    const filesIn = event.clipboardData && event.clipboardData.files;
    if (filesIn && filesIn.length) {
      event.preventDefault();
      attachFiles(filesIn);
    }
  });
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
    h('div', { class: 'convo-form', dataset: { drop: t('convo.drop_here') } }, contextEl, attachEl, input, fileInput,
      h('div', { class: 'row spread' }, h('span', { class: 'row' }, attachBtn, h('span', { class: 'small faint' }, t('chat.send_hint'))), sendBtn))));
  const form = root.querySelector('.convo-form');
  form.addEventListener('dragover', (event) => {
    if (!event.dataTransfer || ![...event.dataTransfer.types].includes('Files') || viewing) return;
    event.preventDefault();
    form.classList.add('over');
  });
  form.addEventListener('dragleave', () => form.classList.remove('over'));
  form.addEventListener('drop', (event) => {
    form.classList.remove('over');
    if (!event.dataTransfer || !event.dataTransfer.files.length || viewing) return;
    event.preventDefault();
    attachFiles(event.dataTransfer.files);
  });
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

/** A card changed (run, dismissed, its job ended): put it in its message and paint again. */
function updateCard(card) {
  for (const holder of [conv, viewing]) {
    if (!holder || holder.id !== card.conversation) continue;
    for (const m of holder.messages || []) {
      if (!Array.isArray(m.actions)) continue;
      const at = m.actions.findIndex((c) => c && c.id === card.id);
      if (at !== -1) m.actions[at] = card;
    }
  }
  const keep = listEl ? listEl.scrollTop : 0;
  const atBottom = listEl ? listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40 : true;
  paintList();
  if (listEl && !atBottom) listEl.scrollTop = keep;
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
    if (data.card) {
      updateCard(data.card);
      return;
    }
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
