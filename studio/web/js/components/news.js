// The markers of what is new (unseen.js) inside a screen: a dot with a
// short line on an item, and a strip at the top of a screen that lists what
// is new there, with "Mark all as seen". Failures and questions are alerts,
// in their own colour, and come first.

import { h, mount } from '/js/dom.js';
import { t, tn } from '/js/i18n.js';
import { bus } from '/js/store.js';
import { newsFor, newsOfScreen, entryText, markScreenSeen } from '/js/unseen.js';

/** A node repainted whenever the news changes, until it leaves the page. */
function live(build, tag = 'span') {
  const el = h(tag, { class: 'live' });
  const paint = () => {
    if (!document.contains(el) && el.dataset.mounted) {
      off();
      return;
    }
    mount(el, build());
    el.dataset.mounted = '1';
  };
  const off = bus.on('unseen', paint);
  paint();
  return el;
}

/** The marker of one item: a dot and what is new, or nothing. */
export function newsMark(item, { short = false } = {}) {
  return live(() => {
    const list = newsFor(item);
    if (!list.length) return null;
    const alert = list.some((e) => e.tone === 'alert');
    const first = list.find((e) => e.tone === 'alert') || list[0];
    return h('span', { class: `news-mark${alert ? ' alert' : ''}`, role: 'status' },
      h('span', { class: 'news-dot', 'aria-hidden': 'true' }),
      short ? h('span', { class: 'sr-only' }, entryText(first)) : h('span', { class: 'news-text' }, entryText(first)));
  });
}

/** The strip of a screen: what is new here, links to each item, and "Mark all as seen". */
export function newsBar(screen) {
  return live(() => {
    const list = newsOfScreen(screen);
    if (!list.length) return null;
    const fresh = list.filter((e) => !e.shown && !e.live);
    const alerts = list.filter((e) => e.tone === 'alert').length;
    return h('section', { class: `news-bar${alerts ? ' alert' : ''}`, 'aria-label': t('unseen.title') },
      h('div', { class: 'row spread' },
        h('strong', null, alerts ? tn('unseen.title_alerts', alerts) : tn('unseen.title_count', list.length)),
        fresh.length ? h('button', { type: 'button', class: 'btn quiet small', onclick: () => markScreenSeen(screen) }, t('unseen.mark_all')) : null),
      h('ul', { class: 'news-list' }, list.slice(0, 12).map((e) => h('li', { class: `news-item${e.tone === 'alert' ? ' alert' : ''}${e.shown ? ' shown' : ''}` },
        h('span', { class: 'news-dot', 'aria-hidden': 'true' }),
        e.link ? h('a', { href: e.link }, entryText(e)) : h('span', null, entryText(e))))));
  }, 'div');
}
