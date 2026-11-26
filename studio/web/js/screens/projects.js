// The comics on this machine: a shelf of covers (in 3D where the browser can
// draw it) over the grid of cards, which stays the real way to open, create
// and move a comic to the trash. A first run starts with the tools found.

import { h, icon } from '/js/dom.js';
import { t, tn, formatDate } from '/js/i18n.js';
import { api } from '/js/api.js';
import { state, loadHealth } from '/js/store.js';
import { button, emptyState, disclosure } from '/js/components/ui.js';
import { confirmDialog } from '/js/components/dialog.js';
import { toolsPanel } from '/js/components/tools.js';
import { frame } from '/js/components/viewer.js';
import { toast } from '/js/components/toast.js';
import { glStage } from '/js/gl/stage.js';
import { shelfScene } from '/js/gl/shelf.js';

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

function card(ctx, project, hover) {
  const href = `/p/${encodeURIComponent(project.id)}`;
  const c = project.counts || {};
  const el = h('li', { class: 'project-card' },
    h('a', { class: 'project-art', href, 'aria-label': t('projects.open', { title: project.title }) },
      frame(project.image, { alt: t('projects.image_alt', { title: project.title }), placeholder: t('projects.no_image') })),
    h('div', { class: 'project-body' },
      h('h2', null, h('a', { href }, project.title)),
      project.logline || project.description ? h('p', { class: 'muted clamp small' }, project.logline || project.description) : null,
      h('p', { class: 'small faint' },
        c.pages ? t('projects.progress', { drawn: c.rendered || 0, pages: c.pages }) : t('projects.no_pages'), '. ',
        t('projects.changed', { date: formatDate(project.updated_at) })),
      project.busy ? h('p', { class: 'busy-line' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), t('projects.busy')) : null,
      h('div', { class: 'row' },
        button(t('projects.trash'), { kind: 'quiet', small: true, icon: 'trash', onclick: () => trash(ctx, project) }))));
  const on = () => hover(project.id);
  const off = () => hover(null);
  el.addEventListener('pointerenter', on);
  el.addEventListener('pointerleave', off);
  el.addEventListener('focusin', on);
  el.addEventListener('focusout', off);
  return el;
}

function newCard() {
  return h('li', { class: 'project-card project-new' },
    h('a', { class: 'project-art', href: '/new' },
      h('div', { class: 'frame' }, h('div', { class: 'frame-art' }, h('span', { class: 'plus', 'aria-hidden': 'true' }, '+'), h('span', null, t('projects.new'))))));
}

/** The flat stand-in for the 3D shelf: up to three covers fanned out. */
function fan(projects) {
  const shown = projects.slice(0, 3);
  const angles = shown.length === 1 ? [0] : (shown.length === 2 ? [-8, 8] : [-14, 0, 14]);
  return h('div', { class: 'cover-fan', 'aria-hidden': 'true' }, shown.map((p, i) => {
    const node = p.image ? h('img', { src: p.image.url, alt: '' }) : h('div', { class: 'fan-blank' });
    node.style.setProperty('transform', `translateX(-50%) rotate(${angles[i]}deg)`);
    return node;
  }));
}

export function view(ctx, { list, health }) {
  ctx.title = t('nav.projects');
  const projects = list.projects;
  const missing = !health.tools.claude.installed || !health.tools.codex.installed || !health.git.installed;
  const first = projects.length === 0;
  const tools = toolsPanel(health, { onChecked: () => ctx.refresh() });

  if (first) {
    return h('div', { class: 'screen projects' },
      h('section', { class: 'gallery-hero' },
        h('div', null,
          h('h1', null, t('projects.title_first')),
          h('p', { class: 'lede' }, t('projects.lede_first')),
          h('a', { class: 'btn primary large', href: '/new' }, icon('plus'), h('span', null, t('projects.new')))),
        h('div', { class: 'gallery-stage gl-stage', dataset: { gl: 'off' } }, h('div', { class: 'gl-fallback' }, fan([{}, {}, {}])))),
      h('div', { class: 'first-run' },
        h('section', { class: 'panel' }, h('h2', { class: 'panel-title' }, t('tools.title')), tools),
        emptyState(t('projects.empty_title'), t('projects.empty_body'))),
      h('p', { class: 'small faint home-path' }, t('projects.home', { home: list.home })));
  }

  const items = projects.map((p) => ({ id: p.id, title: p.title, url: p.image ? p.image.url : null }));
  const stage = ctx.persist(`shelf:${items.map((i) => `${i.id}@${i.url || ''}`).join('|')}`, () => glStage({
    className: 'gallery-stage',
    fallback: fan(projects),
    scene: shelfScene(items, { onOpen: (item) => ctx.navigate(`/p/${encodeURIComponent(item.id)}`) }),
  }));
  const hover = (id) => {
    if (stage.controller && stage.controller.api.setHot) stage.controller.api.setHot(id);
  };

  return h('div', { class: 'screen projects' },
    h('section', { class: 'gallery-hero' },
      h('div', null,
        h('h1', null, t('projects.title')),
        h('p', { class: 'lede' }, tn('projects.lede', projects.length)),
        h('a', { class: 'btn primary large', href: '/new' }, icon('plus'), h('span', null, t('projects.new')))),
      stage),
    h('ul', { class: 'project-grid', 'aria-label': t('projects.title') }, projects.map((p) => card(ctx, p, hover)), newCard()),
    h('div', { class: 'stack' },
      disclosure(ctx, 'tools', missing ? t('tools.title_missing') : t('tools.title'), () => tools, { open: missing })),
    h('p', { class: 'small faint home-path' }, t('projects.home', { home: list.home })));
}
