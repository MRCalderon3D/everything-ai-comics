// Short messages at the bottom of the window. They are announced to screen
// readers through the live region in index.html.

import { h, icon } from '/js/dom.js';
import { t } from '/js/i18n.js';

/** toast('Saved'), toast(message, { kind: 'bad' }), toast(message, { link: { href, label } }) */
export function toast(text, { kind = 'info', link, sticky } = {}) {
  const root = document.getElementById('toasts');
  if (!root) return;
  const el = h('div', { class: `toast ${kind}` },
    h('span', { class: 'grow' }, text),
    link ? h('a', { href: link.href }, link.label) : null,
    h('button', { type: 'button', class: 'btn icon-only quiet', 'aria-label': t('action.dismiss'), onclick: () => el.remove() }, icon('close')));
  root.append(el);
  while (root.children.length > 4) root.firstChild.remove();
  if (!sticky) setTimeout(() => el.remove(), kind === 'bad' ? 12000 : 6000);
}
