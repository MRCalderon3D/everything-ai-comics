// The layout every working screen shares: the text of what is being made and
// its artwork, which gets the larger share. The conversation is not part of
// a screen any more: it lives in the dock and follows the person; a screen
// only tells it what to suggest.

import { h, icon } from '/js/dom.js';
import { state } from '/js/store.js';

/** The title of a screen with its one-line state and its actions. */
export function screenHead({ title, lede, actions, back } = {}) {
  return h('header', { class: 'screen-head' },
    h('div', { class: 'titles' },
      back ? h('a', { class: 'back-link', href: back.href }, icon('left'), h('span', null, back.label)) : null,
      h('h1', null, title),
      lede ? h('p', { class: 'lede' }, lede) : null),
    actions && actions.length ? h('div', { class: 'actions' }, actions) : null);
}

/**
 * bench(ctx, { text, images, chat: { examples }, focus })
 * `images` may be null for a screen that has none. focus: 'text' gives the
 * text the wider column, for a screen whose images do not exist yet.
 */
export function bench(ctx, { text, images, chat, focus } = {}) {
  if (chat && chat.examples) state.screenExamples = chat.examples;
  return h('div', { class: 'bench', dataset: { images: images ? 'yes' : 'none', focus: focus || 'images' } },
    h('div', { class: 'part part-text' }, text),
    images ? h('div', { class: 'part part-images' }, images) : '');
}
