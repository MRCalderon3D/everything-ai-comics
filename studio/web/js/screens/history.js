// Everything that was done, newest first: who did it, the files it touched,
// the images it made. Any point that changed files can be restored.

import { h } from '/js/dom.js';
import { t, tn, tv, formatDateTime } from '/js/i18n.js';
import { api } from '/js/api.js';
import { state, bus } from '/js/store.js';
import { screenHead } from '/js/components/bench.js';
import { actionButton, button, notice, emptyState } from '/js/components/ui.js';
import { confirmDialog } from '/js/components/dialog.js';
import { showFile } from '/js/components/editor.js';
import { openViewer } from '/js/components/viewer.js';
import { toast } from '/js/components/toast.js';
import { actorName, jobTitle, stepLabel } from '/js/labels.js';

const PAGE = 60;

export async function load(ctx) {
  const limit = ctx.ui.limit || PAGE;
  return api.history(ctx.projectId, `?limit=${limit}`);
}

function entryTitle(entry) {
  if (entry.kind === 'step' && entry.op) {
    const fake = { op: entry.op, params: {}, title: null };
    const job = state.jobs.get(entry.job) || fake;
    const title = tv('job', entry.op, null);
    if (title && entry.step) {
      const label = stepLabel(Object.assign({}, job, { op: entry.op }), { id: entry.step, label: null });
      if (label && label !== entry.step) return label === title ? title : `${title}: ${label}`;
    }
  }
  if (entry.kind === 'save' && entry.files && entry.files.length === 1) return t('history.saved_file', { path: entry.files[0].path });
  return entry.title;
}

async function restore(ctx, entry) {
  const busy = state.overview && state.overview.active_jobs && state.overview.active_jobs.some((j) => j.status !== 'needs_decision');
  const result = await confirmDialog({
    title: t('history.restore_title'),
    body: h('div', { class: 'stack-s' },
      h('p', null, t('history.restore_point', { title: entryTitle(entry), when: formatDateTime(entry.at) })),
      h('ul', { class: 'bullets' },
        h('li', null, t('history.restore_what_1')),
        h('li', null, t('history.restore_what_2')),
        h('li', null, t('history.restore_what_3'))),
      busy ? h('p', { class: 'notice warn' }, t('history.restore_busy')) : null),
    confirm: t('history.restore_confirm'),
    danger: true,
    run: () => api.restore(ctx.projectId, entry.id),
  });
  if (!result) return;
  const res = result.result;
  toast(res.unchanged ? t('history.restore_unchanged') : tn('history.restored', res.files), { kind: 'ok' });
  ctx.refresh();
}

function entryRow(ctx, entry, canRestore) {
  const images = (entry.images || []).filter((i) => i && i.url);
  const gone = (entry.images || []).filter((i) => i && i.missing).length;
  const items = images.map((i, n) => ({ id: String(n), label: i.path.split('/').pop(), image: i }));
  const files = entry.files || [];
  return h('li', { class: 'history-entry', dataset: { kind: entry.kind, actor: entry.actor } },
    h('div', { class: 'history-when' },
      h('time', { dateTime: entry.at }, formatDateTime(entry.at)),
      h('span', { class: `actor ${entry.actor}` }, actorName(entry.actor))),
    h('div', { class: 'history-what' },
      h('h3', null, entryTitle(entry)),
      images.length ? h('ul', { class: 'history-images' }, items.slice(0, 8).map((it) => h('li', null,
        h('button', { type: 'button', class: 'thumb', 'aria-label': t('image.open_large', { name: it.label }), onclick: () => openViewer(items, it.id, { title: entryTitle(entry) }) },
          h('img', { src: it.image.url, alt: '', loading: 'lazy' })))),
      images.length > 8 ? h('li', { class: 'small faint' }, t('history.more_images', { n: images.length - 8 })) : null) : null,
      gone ? h('p', { class: 'small faint' }, tn('history.images_gone', gone)) : null,
      files.length ? h('details', { class: 'disclosure' },
        h('summary', null, tn('history.files', files.length)),
        h('ul', { class: 'file-list' }, files.map((f) => h('li', null,
          h('span', { class: `change ${f.change}` }, tv('change', f.change, f.change)), ' ',
          f.change === 'deleted' || !/\.(ya?ml|md|txt|fountain)$/i.test(f.path)
            ? h('span', null, f.path)
            : h('button', { type: 'button', class: 'link', onclick: () => showFile(ctx.projectId, f.path) }, f.path)))))
        : h('p', { class: 'small faint' }, t('history.no_files'))),
    h('div', { class: 'history-actions' },
      entry.restorable && canRestore
        ? button(t('history.restore'), { kind: 'quiet', small: true, onclick: () => restore(ctx, entry) })
        : null));
}

export function view(ctx, data) {
  ctx.title = t('nav.history');
  const off = bus.on('activity', () => ctx.refresh());
  ctx.onCleanup(off);
  const canRestore = data.restore && data.restore.available;
  return h('div', { class: 'screen history' },
    screenHead({ title: t('nav.history'), lede: tn('history.lede', data.total) }),
    !canRestore ? notice('warn', t('history.no_git')) : h('p', { class: 'muted' }, t('history.restore_intro')),
    data.entries.length
      ? h('ol', { class: 'history-list' }, data.entries.map((e) => entryRow(ctx, e, canRestore)))
      : emptyState(t('history.empty_title'), t('history.empty_body')),
    data.more ? h('div', { class: 'row' }, actionButton(t('history.load_more'), async () => {
      ctx.ui.limit = Math.min(1000, (ctx.ui.limit || PAGE) + PAGE);
      await ctx.refresh();
    })) : null);
}
