// The project home: the path of the comic with what is done, what comes next
// and what holds it back. One obvious thing to do.

import { h } from '/js/dom.js';
import { t, tn, tv, has } from '/js/i18n.js';
import { state, refreshOverview } from '/js/store.js';
import { screenHead } from '/js/components/bench.js';
import { caption, notice } from '/js/components/ui.js';
import { frame, openViewer } from '/js/components/viewer.js';
import { jobsFor } from '/js/components/jobs.js';
import { toolName } from '/js/labels.js';
import { SCREENS } from '/js/shell.js';

export async function load() {
  return (await refreshOverview()) || state.overview;
}

/** What a screen's state is, in a sentence, from its status and its numbers. */
export function screenSummary(s) {
  const c = s.counts || {};
  switch (s.key) {
    case 'story':
      return s.status === 'done' ? tn('summary.story.done', c.facts || 0) : t('summary.story.todo');
    case 'style':
      if (s.status === 'done') return t('summary.style.done');
      if (c.candidates) return tn('summary.style.candidates', c.candidates);
      return s.status === 'in_progress' ? t('summary.style.defined') : t('summary.style.todo');
    case 'characters':
      if (!c.characters) return t('summary.characters.none');
      return t('summary.characters.count', { n: c.characters, approved: c.approved || 0 });
    case 'places':
      return t('summary.places', { locations: c.locations || 0, props: c.props || 0 });
    case 'pages':
      if (!c.planned) return t('summary.pages.none');
      return t('summary.pages.count', { planned: c.planned, drawn: c.rendered || 0, approved: c.plan_approved || 0 });
    case 'check':
      if (!c.passed && !c.flagged) return t('summary.check.none');
      return t('summary.check.count', { passed: c.passed || 0, flagged: c.flagged || 0 })
        + (c.with_notes ? ` ${tn('summary.check.with_notes', c.with_notes)}` : '')
        + (c.not_independent ? ` ${tn('summary.check.not_independent', c.not_independent)}` : '');
    case 'corrections':
      if (c.flagged) return tn('summary.corrections.flagged', c.flagged);
      return c.with_notes ? tn('summary.corrections.notes', c.with_notes) : t('summary.corrections.none');
    case 'cover':
      if (s.status === 'done' || s.done) return t('summary.cover.done');
      return c.renders ? tn('summary.cover.renders', c.renders) : t('summary.cover.none');
    case 'publish':
      return c.editions ? tn('summary.publish.editions', c.editions) : t('summary.publish.none');
    default:
      return s.summary || '';
  }
}

export function blockerText(b) {
  return has(`blocker.${b.code}`) ? t(`blocker.${b.code}`) : b.message;
}

function nextAction(overview) {
  const base = `/p/${encodeURIComponent(overview.project.id)}`;
  const waiting = overview.active_jobs.find((j) => j.status === 'needs_decision');
  if (waiting) {
    return { text: t('home.next_decision'), href: `${base}/decisions`, label: t('home.next_decision_action') };
  }
  if (!overview.next) {
    return { text: t('home.all_done'), href: `${base}/publish`, label: t('home.go_publish') };
  }
  const key = overview.next.screen;
  return { text: t(`home.next.${key}`), href: `${base}/${key}`, label: t(`home.next_action.${key}`) };
}

export function view(ctx, overview) {
  const project = overview.project;
  ctx.title = project.title;
  const base = `/p/${encodeURIComponent(project.id)}`;
  const byKey = new Map(overview.screens.map((s) => [s.key, s]));
  const next = nextAction(overview);
  const fallbacks = Object.entries(overview.tools || {}).filter(([, v]) => v.fallback || !v.available);
  return h('div', { class: 'screen home' },
    screenHead({
      title: project.title,
      lede: project.logline || project.description || t('home.no_description'),
    }),
    h('div', { class: 'home-top' },
      h('div', { class: 'stack' },
        caption(
          h('p', { class: 'caption-label' }, t('home.next_title')),
          h('p', { class: 'caption-text' }, next.text),
          h('a', { class: 'btn primary', href: next.href }, next.label)),
        jobsFor(() => true, { showLast: false }),
        fallbacks.length ? notice('warn', h('ul', { class: 'bullets' }, fallbacks.map(([verb, v]) => h('li', null,
          !v.available
            ? t(`home.tool_missing.${verb}`)
            : t('home.tool_fallback', { verb: tv('verb', verb), tool: toolName(v.tool), wanted: toolName(v.requested) }))))) : null),
      project.image
        ? h('div', { class: 'home-art' }, frame(project.image, {
          alt: t('projects.image_alt', { title: project.title }),
          onclick: () => openViewer([{ id: 'p', label: project.title, image: project.image }], 'p'),
        }))
        : null),
    h('section', { 'aria-label': t('nav.path') },
      h('ol', { class: 'path' }, SCREENS.map((key, index) => {
        const s = byKey.get(key) || { key, status: 'todo', blockers: [] };
        const isNext = overview.next && overview.next.screen === key;
        return h('li', { class: 'path-step', dataset: { status: s.status, next: String(!!isNext) } },
          h('a', { href: `${base}/${key}` },
            h('span', { class: 'path-n', 'aria-hidden': 'true' }, String(index + 1)),
            h('span', { class: 'path-name' }, t(`screen.${key}`)),
            h('span', { class: 'path-state' }, isNext ? t('status.next') : tv('status', s.status)),
            h('span', { class: 'path-summary' }, screenSummary(s)),
            s.blockers && s.blockers.length
              ? h('span', { class: 'path-blockers' }, h('strong', null, t('home.waits_for')), ' ',
                s.blockers.map((b) => blockerText(b)).join(' '))
              : null));
      }))),
    h('p', { class: 'small faint' }, t('home.folder', { path: project.path })));
}
