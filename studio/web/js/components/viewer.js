// Images: the frame used everywhere, the comparison of two versions (side by
// side, or one over the other with a slider), and the large viewer.

import { h, icon, mount, nextId } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { openDialog } from '/js/components/dialog.js';

/**
 * An image in a panel border. `image` is an image object of the API.
 * onclick makes it a button that opens the viewer.
 */
export function frame(image, { alt, caption, onclick, badge, ratio, placeholder } = {}) {
  const hasImage = image && image.url;
  const style = (el) => {
    const r = ratio || (hasImage && image.width && image.height ? `${image.width} / ${image.height}` : '2 / 3');
    el.style.setProperty('aspect-ratio', r);
    return el;
  };
  const inner = hasImage
    ? h('img', { src: image.url, alt: alt || '', loading: 'lazy', decoding: 'async' })
    : h('div', { class: 'frame-empty' }, placeholder || t('image.none_yet'));
  const body = onclick && hasImage
    ? style(h('button', { type: 'button', class: 'frame-art', onclick, 'aria-label': t('image.open_large', { name: alt || '' }) }, inner))
    : style(h('div', { class: 'frame-art' }, inner));
  return h('figure', { class: `frame${hasImage ? '' : ' empty'}` },
    body,
    badge ? h('div', { class: 'frame-badge' }, badge) : null,
    caption ? h('figcaption', null, caption) : null);
}

/**
 * Two images compared. mode 'side' puts them next to each other; mode
 * 'slider' stacks them and a range input reveals one over the other, which
 * also works from the keyboard.
 */
export function compare(a, b, mode = 'side') {
  if (mode === 'slider') {
    const id = nextId('cmp');
    const top = h('div', { class: 'cmp-top' }, h('img', { src: b.image.url, alt: b.alt || b.label }));
    const stage = h('div', { class: 'cmp-stage' },
      h('img', { class: 'cmp-base', src: a.image.url, alt: a.alt || a.label }),
      top,
      h('div', { class: 'cmp-handle', 'aria-hidden': 'true' }));
    if (a.image.width && a.image.height) stage.style.setProperty('aspect-ratio', `${a.image.width} / ${a.image.height}`);
    const set = (value) => stage.style.setProperty('--cut', `${value}%`);
    const range = h('input', { id, type: 'range', min: 0, max: 100, value: 50, class: 'cmp-range' });
    range.addEventListener('input', () => set(range.value));
    stage.addEventListener('pointerdown', (event) => {
      const move = (e) => {
        const rect = stage.getBoundingClientRect();
        const pct = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
        range.value = String(Math.round(pct));
        set(pct);
      };
      move(event);
      stage.setPointerCapture(event.pointerId);
      stage.addEventListener('pointermove', move);
      stage.addEventListener('pointerup', () => stage.removeEventListener('pointermove', move), { once: true });
    });
    set(50);
    return h('div', { class: 'cmp slider' },
      h('div', { class: 'cmp-labels' }, h('span', null, a.label), h('span', null, b.label)),
      stage,
      h('label', { for: id, class: 'sr-only' }, t('viewer.slider_label', { a: a.label, b: b.label })),
      range);
  }
  return h('div', { class: 'cmp side' },
    [a, b].map((x) => h('figure', null,
      h('img', { src: x.image.url, alt: x.alt || x.label }),
      h('figcaption', null, x.label))));
}

/**
 * A comparison with its own controls, for use inside a screen.
 * items: [{ id, label, image, alt }] in version order; at least two.
 */
export function compareBox(ctx, key, items, { left, right } = {}) {
  const usable = items.filter((i) => i.image && i.image.url);
  if (usable.length < 2) return h('div');
  const s = ctx.ui[`cmp:${key}`] || (ctx.ui[`cmp:${key}`] = {});
  if (!usable.some((i) => i.id === s.a)) s.a = left || usable[usable.length - 2].id;
  if (!usable.some((i) => i.id === s.b)) s.b = right || usable[usable.length - 1].id;
  if (!s.mode) s.mode = 'side';
  const stage = h('div');
  const paint = () => {
    mount(stage, compare(usable.find((i) => i.id === s.a), usable.find((i) => i.id === s.b), s.mode));
  };
  const pick = (which) => {
    const id = nextId('pick');
    const sel = h('select', { id }, usable.map((i) => h('option', { value: i.id, selected: i.id === s[which] }, i.label)));
    sel.addEventListener('change', () => { s[which] = sel.value; paint(); });
    return h('span', { class: 'cmp-pick' }, h('label', { for: id }, which === 'a' ? t('viewer.left') : t('viewer.right')), sel);
  };
  const modeBtn = (mode, label) => {
    const b = h('button', { type: 'button', class: 'btn small quiet', 'aria-pressed': String(s.mode === mode) }, label);
    b.addEventListener('click', () => {
      s.mode = mode;
      for (const other of bar.querySelectorAll('[aria-pressed]')) other.setAttribute('aria-pressed', String(other === b));
      paint();
    });
    return b;
  };
  const bar = h('div', { class: 'row cmp-bar' }, pick('a'), pick('b'),
    h('span', { class: 'row', role: 'group', 'aria-label': t('viewer.compare_mode') },
      modeBtn('side', t('viewer.side_by_side')), modeBtn('slider', t('viewer.slider'))));
  paint();
  return h('div', { class: 'compare-box' }, bar, stage);
}

/**
 * The large viewer. items: [{ id, label, image, alt, note }]. Opens on
 * `start` (an id). Arrow keys move between images; "Compare" puts two
 * versions together.
 */
export function openViewer(items, start, { title } = {}) {
  const usable = items.filter((i) => i.image && i.image.url);
  if (!usable.length) return;
  let at = Math.max(0, usable.findIndex((i) => i.id === start));
  let mode = 'single';
  let other = usable.length > 1 ? (at === 0 ? 1 : at - 1) : 0;
  let zoom = false;
  const stage = h('div', { class: 'viewer-stage' });
  const bar = h('div', { class: 'viewer-bar' });
  const strip = h('div', { class: 'viewer-strip', role: 'group', 'aria-label': t('viewer.all_images') });

  const paint = () => {
    const item = usable[at];
    if (mode === 'single') {
      const img = h('img', { src: item.image.url, alt: item.alt || item.label, class: zoom ? 'actual' : 'fit' });
      mount(stage, h('div', { class: `viewer-single${zoom ? ' zoomed' : ''}`, tabIndex: zoom ? 0 : -1 }, img));
    } else {
      const a = usable[Math.min(at, other)];
      const b = usable[Math.max(at, other)];
      mount(stage, a === b ? h('p', { class: 'muted' }, t('viewer.pick_two')) : compare(a, b, mode));
    }
    const press = (m, label) => h('button', { type: 'button', class: 'btn small quiet', 'aria-pressed': String(mode === m), onclick: () => { mode = m; paint(); } }, label);
    const otherId = nextId('vs');
    mount(bar,
      h('div', { class: 'viewer-name' }, h('strong', null, item.label),
        item.image.width ? h('span', { class: 'faint small' }, ` ${item.image.width} × ${item.image.height}`) : null,
        item.note ? h('span', { class: 'muted small' }, ` ${item.note}`) : null),
      h('div', { class: 'row' },
        usable.length > 1 ? h('span', { class: 'row', role: 'group', 'aria-label': t('viewer.compare_mode') },
          press('single', t('viewer.single')), press('side', t('viewer.side_by_side')), press('slider', t('viewer.slider'))) : null,
        mode !== 'single' && usable.length > 1
          ? h('span', { class: 'cmp-pick' }, h('label', { for: otherId }, t('viewer.compare_with')),
            h('select', { id: otherId, onchange: (e) => { other = Number(e.target.value); paint(); } },
              usable.map((u, i) => (i === at ? null : h('option', { value: String(i), selected: i === other }, u.label)))))
          : null,
        mode === 'single' ? h('button', { type: 'button', class: 'btn small quiet', 'aria-pressed': String(zoom), onclick: () => { zoom = !zoom; paint(); } }, icon('zoom'), h('span', null, t('viewer.actual_size'))) : null,
        h('a', { class: 'btn small quiet', href: item.image.url, target: '_blank', rel: 'noopener' }, icon('open'), h('span', null, t('viewer.open_tab')))));
    mount(strip, usable.length > 1 ? usable.map((u, i) => h('button', {
      type: 'button', class: 'thumb', 'aria-pressed': String(i === at), 'aria-label': u.label,
      onclick: () => { if (mode !== 'single' && i !== at) other = at; at = i; paint(); },
    }, h('img', { src: u.image.url, alt: '' }), h('span', null, u.short || u.label))) : []);
  };

  const dialog = openDialog({ title: title || t('viewer.title'), wide: true, body: h('div', { class: 'viewer' }, bar, stage, strip) });
  dialog.el.classList.add('viewer-dialog');
  dialog.el.addEventListener('keydown', (event) => {
    if (event.target.tagName === 'SELECT' || event.target.tagName === 'INPUT') return;
    if (event.key === 'ArrowRight' && at < usable.length - 1) { at += 1; paint(); }
    else if (event.key === 'ArrowLeft' && at > 0) { at -= 1; paint(); }
  });
  paint();
}

/**
 * A row of versions with the current one large. Clicking opens the viewer.
 * items: [{ id, label, image, alt, note, badge }]; `selected` is an id.
 */
export function versionStrip(items, selected, onSelect) {
  return h('div', { class: 'version-strip', role: 'group', 'aria-label': t('viewer.versions') },
    items.map((item) => h('button', {
      type: 'button', class: 'thumb', 'aria-pressed': String(item.id === selected), onclick: () => onSelect(item.id),
    },
    item.image && item.image.url ? h('img', { src: item.image.url, alt: '' }) : h('span', { class: 'thumb-empty' }),
    h('span', null, item.label),
    item.badge ? h('span', { class: 'thumb-badge' }, item.badge) : null)));
}
