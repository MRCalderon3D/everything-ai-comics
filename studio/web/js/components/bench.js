// The layout every working screen shares: the text of what is being made,
// its images, and the chat of that screen.

import { h, icon } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { chatPanel } from '/js/components/chat.js';

const CHAT_KEY = 'studio.chat';

function chatWanted() {
  let stored = null;
  try { stored = localStorage.getItem(CHAT_KEY); } catch (err) { /* storage is off */ }
  if (stored === 'open') return true;
  if (stored === 'closed') return false;
  return window.innerWidth > 1240;
}

/** The title of a screen with its one-line state and its actions. */
export function screenHead({ title, lede, actions, back } = {}) {
  return h('header', { class: 'screen-head' },
    h('div', { class: 'titles' },
      back ? h('a', { class: 'back-link', href: back.href }, `‹ ${back.label}`) : null,
      h('h1', null, title),
      lede ? h('p', { class: 'lede' }, lede) : null),
    actions && actions.length ? h('div', { class: 'actions' }, actions) : null);
}

/**
 * bench(ctx, { text, images, chat: { key, title, examples } })
 * `images` may be null for a screen that has none. focus: 'text' gives the
 * text the wider column, for a screen whose images do not exist yet.
 */
export function bench(ctx, { text, images, chat, focus } = {}) {
  let open = chat ? chatWanted() : false;
  const el = h('div', { class: 'bench', dataset: { chat: open ? 'open' : 'closed', images: images ? 'yes' : 'none', focus: focus || 'images' } });
  const toggle = chat ? h('button', { type: 'button', class: 'btn quiet small chat-toggle', 'aria-expanded': String(open) },
    icon('chat'), h('span', null, open ? t('chat.hide') : t('chat.show'))) : null;
  const setOpen = (value, remember) => {
    open = value;
    el.dataset.chat = open ? 'open' : 'closed';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.querySelector('span').textContent = open ? t('chat.hide') : t('chat.show');
    if (remember) {
      try { localStorage.setItem(CHAT_KEY, open ? 'open' : 'closed'); } catch (err) { /* storage is off */ }
    }
  };
  let chatPart = null;
  if (chat) {
    const panel = ctx.persist(`chat:${chat.key}`, () => chatPanel(ctx, chat.key, chat));
    const close = h('button', { type: 'button', class: 'btn icon-only quiet chat-close', 'aria-label': t('chat.hide'), onclick: () => { setOpen(false, true); toggle.focus(); } }, icon('close'));
    chatPart = h('div', { class: 'part part-chat' }, close, panel);
    toggle.addEventListener('click', () => {
      setOpen(!open, true);
      if (open) {
        const input = panel.querySelector('textarea');
        if (input) input.focus();
      }
    });
    chatPart.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && window.innerWidth <= 1240) {
        setOpen(false, true);
        toggle.focus();
      }
    });
  }
  el.append(
    h('div', { class: 'part part-text' }, toggle ? h('div', { class: 'bench-tools' }, toggle) : null, text),
    images ? h('div', { class: 'part part-images' }, images) : '',
    chatPart || '');
  return el;
}
