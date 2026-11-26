// The list of comics. On a first run it starts with the tools that were
// found, because nothing else works without them.

import { h } from '/js/dom.js';
import { t, tn, formatDate } from '/js/i18n.js';
import { api } from '/js/api.js';
import { state, loadHealth } from '/js/store.js';
import { screenHead } from '/js/components/bench.js';
import { button, emptyState, disclosure } from '/js/components/ui.js';
import { confirmDialog } from '/js/components/dialog.js';
import { toolsPanel } from '/js/components/tools.js';
import { frame } from '/js/components/viewer.js';
import { toast } from '/js/components/toast.js';

export async function load() {
  const [list, health] = await Promise.all([api.projects(), state.health ? Promise.resolve(state.health) : loadHealth()]);
  return { list, health };
}

async function trash(ctx, project) {
  const result = await confirmDialog({
    title: t('projects.trash_title', { title: project.title }),
    body: h('div', { class: 'stack-s' },
      h('p', null, t('projects.trash_body')),
      project.busy ? h('p', { class: 'notice warn' }, t('projects.trash_busy')) : null),
    confirm: t('projects.trash_confirm'),
    danger: true,
    run: () => api.deleteProject(project.id, project.busy),
  });
  if (!result) return;
  toast(t('projects.trashed', { title: project.title, where: result.result.trash }), { kind: 'ok' });
  ctx.refresh();
}

function card(ctx, project) {
  const href = `/p/${encodeURIComponent(project.id)}`;
  const c = project.counts || {};
  return h('li', { class: 'project-card' },
    h('a', { class: 'project-art', href, 'aria-label': t('projects.open', { title: project.title }) },
      frame(project.image, { alt: t('projects.image_alt', { title: project.title }), placeholder: t('projects.no_image') })),
    h('div', { class: 'project-body' },
      h('h2', null, h('a', { href }, project.title)),
      project.logline || project.description ? h('p', { class: 'muted clamp' }, project.logline || project.description) : null,
      h('p', { class: 'small faint' },
        t(`format.${project.comic_format === 'webtoon' ? 'webtoon' : 'paged'}`), ', ',
        c.pages ? t('projects.progress', { drawn: c.rendered || 0, pages: c.pages }) : t('projects.no_pages'), ', ',
        t('projects.changed', { date: formatDate(project.updated_at) })),
      project.busy ? h('p', { class: 'busy-line' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), t('projects.busy')) : null,
      h('div', { class: 'row' },
        h('a', { class: 'btn primary small', href }, t('projects.open_short')),
        button(t('projects.trash'), { kind: 'quiet', small: true, icon: 'trash', onclick: () => trash(ctx, project) }))));
}

export function view(ctx, { list, health }) {
  ctx.title = t('nav.projects');
  const projects = list.projects;
  const missing = !health.tools.claude.installed || !health.tools.codex.installed || !health.git.installed;
  const first = projects.length === 0;
  const tools = toolsPanel(health, { onChecked: () => ctx.refresh() });
  return h('div', { class: 'screen projects' },
    screenHead({
      title: t('projects.title'),
      lede: first ? t('projects.lede_first') : tn('projects.lede', projects.length),
      actions: [h('a', { class: 'btn primary', href: '/new' }, t('projects.new'))],
    }),
    first
      ? h('div', { class: 'first-run' },
        h('section', { class: 'panel' }, h('h2', { class: 'panel-title' }, t('tools.title')), tools),
        emptyState(t('projects.empty_title'), t('projects.empty_body'), h('a', { class: 'btn primary', href: '/new' }, t('projects.new'))))
      : h('div', { class: 'stack' },
        h('ul', { class: 'project-grid' }, projects.map((p) => card(ctx, p))),
        disclosure(ctx, 'tools', missing ? t('tools.title_missing') : t('tools.title'), () => tools, { open: missing || health.fake })),
    h('p', { class: 'small faint home-path' }, t('projects.home', { home: list.home })));
}
