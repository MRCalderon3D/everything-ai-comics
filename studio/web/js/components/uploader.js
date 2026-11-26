// Uploads. Files go to the project's staging area as soon as they are
// picked; the operation that uses them gets their ids.

import { h, icon, mount, nextId } from '/js/dom.js';
import { t, formatBytes } from '/js/i18n.js';
import { api, errorText } from '/js/api.js';

const IMAGE_TYPES = '.png,.jpg,.jpeg,.webp';
const TEXT_TYPES = '.txt,.md,.fountain';

/**
 * uploader(ctx, { kind: 'image' | 'text', multiple, label, hint, key })
 *   -> { el, ids(), clear(), count() }
 * The list of staged files survives a refresh of the screen.
 */
export function uploader(ctx, { kind = 'image', multiple = true, label, hint, key = 'uploads', onchange } = {}) {
  const stateKey = `up:${key}`;
  const items = ctx.ui[stateKey] || (ctx.ui[stateKey] = []);
  const id = nextId('up');
  const listEl = h('ul', { class: 'upload-list' });
  const problem = h('p', { class: 'hint bad', role: 'alert', hidden: true });
  const input = h('input', { id, type: 'file', accept: kind === 'image' ? IMAGE_TYPES : TEXT_TYPES, multiple: !!multiple, class: 'sr-only' });
  const zone = h('label', { for: id, class: 'dropzone' },
    icon('upload'),
    h('span', null, label || (kind === 'image' ? t('upload.pick_images') : t('upload.pick_text'))),
    h('span', { class: 'small faint' }, kind === 'image' ? t('upload.image_limits') : t('upload.text_limits')));

  const paint = () => {
    mount(listEl, items.map((item, index) => h('li', { class: 'upload-item' },
      item.kind === 'image' && item.url ? h('img', { src: item.url, alt: '' }) : icon('file'),
      h('span', { class: 'grow' }, item.name, ' ', h('span', { class: 'faint small' }, item.pending ? t('upload.sending') : formatBytes(item.bytes))),
      h('button', {
        type: 'button', class: 'btn icon-only quiet', 'aria-label': t('upload.remove', { name: item.name }), title: t('form.remove'),
        onclick: async () => {
          items.splice(index, 1);
          paint();
          if (onchange) onchange();
          if (item.id) api.deleteUpload(ctx.projectId, item.id).catch(() => {});
        },
      }, icon('close')))));
  };

  async function add(files) {
    problem.hidden = true;
    const list = multiple ? [...files] : [...files].slice(0, 1);
    if (!multiple) items.splice(0);
    for (const file of list) {
      const item = { name: file.name, bytes: file.size, pending: true, kind };
      items.push(item);
      paint();
      try {
        const { upload } = await api.upload(ctx.projectId, file);
        Object.assign(item, upload, { pending: false });
      } catch (err) {
        items.splice(items.indexOf(item), 1);
        problem.textContent = `${file.name}: ${errorText(err)}`;
        problem.hidden = false;
      }
      paint();
    }
    if (onchange) onchange();
  }

  input.addEventListener('change', () => {
    add(input.files);
    input.value = '';
  });
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('over');
    if (event.dataTransfer && event.dataTransfer.files.length) add(event.dataTransfer.files);
  });
  paint();

  return {
    el: h('div', { class: 'uploader' }, input, zone, hint ? h('p', { class: 'hint' }, hint) : null, problem, listEl),
    ids: () => items.filter((i) => i.id && !i.pending).map((i) => i.id),
    count: () => items.length,
    busy: () => items.some((i) => i.pending),
    clear() {
      items.splice(0);
      paint();
    },
  };
}
