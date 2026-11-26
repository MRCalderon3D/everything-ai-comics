// The frame around every screen: the top bar and, inside a project, the path
// of the comic down the left with what is done, what is next and what waits.

import { h, icon, mount } from '/js/dom.js';
import { t, tv, getLang, LANGUAGES } from '/js/i18n.js';
import { errorText } from '/js/api.js';
import { state, bus, getTheme, setTheme, effectiveTheme, changeLanguage } from '/js/store.js';
import { jobsIndicator } from '/js/components/jobs.js';
import { toast } from '/js/components/toast.js';

export const SCREENS = ['story', 'style', 'characters', 'places', 'pages', 'check', 'corrections', 'cover', 'publish'];

let indicator = null;
let activeScreen = null;

async function chooseLanguage(lang) {
  try {
    await changeLanguage(lang);
  } catch (err) {
    toast(errorText(err), { kind: 'bad' });
  }
}

function paintTopbar() {
  const bar = document.getElementById('topbar');
  if (!indicator) indicator = jobsIndicator();
  const project = state.overview ? state.overview.project : null;
  const theme = effectiveTheme();
  const langSelect = h('select', { class: 'lang-select', 'aria-label': t('settings.interface_language'), onchange: (e) => chooseLanguage(e.target.value) },
    LANGUAGES.map((l) => h('option', { value: l, selected: l === getLang() }, tv('language', l, l))));
  mount(bar,
    h('a', { class: 'brand', href: '/' }, h('span', { class: 'mark', 'aria-hidden': 'true' }), t('app.name')),
    project ? h('a', { class: 'crumb', href: `/p/${encodeURIComponent(project.id)}` }, project.title) : null,
    state.health && state.health.fake ? h('span', { class: 'fake-chip', title: t('fake.explain') }, t('fake.chip')) : null,
    h('span', { class: 'spacer' }),
    indicator,
    h('div', { class: 'tools' },
      langSelect,
      h('button', {
        type: 'button', class: 'btn icon-only quiet',
        'aria-label': theme === 'dark' ? t('theme.use_light') : t('theme.use_dark'),
        title: theme === 'dark' ? t('theme.use_light') : t('theme.use_dark'),
        onclick: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
      }, icon(theme === 'dark' ? 'sun' : 'moon')),
      h('a', {
        class: 'btn icon-only quiet', href: project ? `/p/${encodeURIComponent(project.id)}/settings` : '/settings',
        'aria-label': t('nav.settings'), title: t('nav.settings'),
      }, icon('gear'))));
}

function paintRail() {
  const rail = document.getElementById('rail');
  const overview = state.overview;
  if (!overview) {
    rail.hidden = true;
    mount(rail);
    return;
  }
  rail.hidden = false;
  rail.setAttribute('aria-label', t('nav.path'));
  const base = `/p/${encodeURIComponent(overview.project.id)}`;
  const byKey = new Map(overview.screens.map((s) => [s.key, s]));
  const current = (key) => (activeScreen === key ? 'page' : null);
  mount(rail,
    h('div', { class: 'rail-top' }, h('a', { href: base, 'aria-current': current('home') }, t('nav.home'))),
    h('ol', null, SCREENS.map((key, index) => {
      const s = byKey.get(key) || { status: 'todo' };
      const isNext = overview.next && overview.next.screen === key;
      return h('li', { dataset: { status: s.status, next: String(!!isNext) } },
        h('a', { href: `${base}/${key}`, 'aria-current': current(key) },
          h('span', { class: 'n', 'aria-hidden': 'true' }, String(index + 1)),
          h('span', { class: 'name' }, t(`screen.${key}`)),
          h('span', { class: 'state' }, isNext ? t('status.next') : tv('status', s.status))));
    })),
    h('div', { class: 'rail-foot' }, h('ul', null,
      h('li', null, h('a', { href: `${base}/history`, 'aria-current': current('history') }, t('nav.history'))),
      h('li', null, h('a', { href: `${base}/settings`, 'aria-current': current('settings') }, t('nav.settings'))))));
}

export function paintShell() {
  document.getElementById('skip-link').textContent = t('nav.skip');
  paintTopbar();
  paintRail();
}

export function startShell() {
  bus.on('overview', paintShell);
  bus.on('project', paintShell);
  bus.on('health', paintTopbar);
  bus.on('theme', paintTopbar);
  bus.on('route', (current) => {
    activeScreen = current ? current.route.meta.screen || null : null;
    paintRail();
  });
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', () => { if (getTheme() === 'auto') paintTopbar(); });
  }
  paintShell();
}
