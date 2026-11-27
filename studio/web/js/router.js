// Routing in the browser. A screen is a module with load(ctx), which fetches
// what the screen shows, and view(ctx, data), which builds it. When files of
// the project change the screen is loaded and built again, keeping the scroll
// position, the focus and whatever the person was typing.

import { h, mount } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { errorText } from '/js/api.js';
import { state, bus, openProject, closeProject, setScreen } from '/js/store.js';
import { motionReduced } from '/js/gl/stage.js';
import { openScreen } from '/js/unseen.js';

const routes = [];
let current = null; // { route, ctx, path }
let token = 0;
let refreshTimer = null;
let firstRender = true;
let lastScreen = null;
// The order of the path, so moving along it can turn the page the right way.
const ORDER = ['projects', 'home', 'story', 'style', 'characters', 'places', 'pages', 'check', 'corrections', 'cover', 'publish', 'history', 'decisions', 'settings'];
const drafts = new Map();
const DRAFT_KEY = 'studio.drafts';

try {
  const saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || '{}');
  for (const [k, v] of Object.entries(saved)) drafts.set(k, v);
} catch (err) { /* storage is off */ }

function saveDrafts() {
  try {
    const out = {};
    for (const [k, v] of drafts) if (v !== '' && v !== null && v !== undefined) out[k] = v;
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(out));
  } catch (err) { /* storage is off */ }
}

/** route('/p/:id/pages/:page', () => import('/js/screens/page.js'), { screen: 'pages' }) */
export function route(pattern, loader, meta = {}) {
  const names = [];
  const source = pattern.split('/').map((part) => {
    if (part.startsWith(':')) {
      names.push(part.slice(1));
      return '([^/]+)';
    }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  routes.push({ pattern, regex: new RegExp(`^${source}/?$`), names, loader, meta });
}

function match(pathname) {
  for (const r of routes) {
    const m = r.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    r.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
    return { route: r, params };
  }
  return null;
}

export function currentRoute() {
  return current;
}

export function navigate(path, { replace = false } = {}) {
  if (path === location.pathname + location.search) {
    render();
    return;
  }
  if (current && current.ctx.hasUnsaved() && !window.confirm(t('editor.leave_unsaved'))) return;
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  render();
}

function makeContext(found, path) {
  const cleanups = [];
  const dirty = new Set();
  const keep = new Map();
  const ctx = {
    params: found.params,
    query: new URLSearchParams(location.search),
    meta: found.route.meta,
    path,
    projectId: found.params.id || null,
    /** Per-screen state that survives a refresh of the screen (open tabs and so on). */
    ui: {},
    title: null,
    navigate,
    /** Load and build the screen again. Unsaved edits are kept unless force is true. */
    refresh: (force) => refresh(!!force),
    onCleanup(fn) { cleanups.push(fn); },
    /** A text the person is typing: survives refreshes and a reload of the browser. */
    draft(key, initial = '') {
      const full = `${path}#${key}`;
      return {
        key: full,
        get: () => (drafts.has(full) ? drafts.get(full) : initial),
        set: (value) => { drafts.set(full, value); saveDrafts(); },
        clear: () => { drafts.delete(full); saveDrafts(); },
      };
    },
    /** An editor says it holds unsaved changes, so a refresh must not replace it. */
    setDirty(key, isDirty) {
      if (isDirty) dirty.add(key); else dirty.delete(key);
    },
    hasUnsaved: () => dirty.size > 0,
    /** Build something once and keep the same node across refreshes (the chat panel). */
    persist(key, factory) {
      if (!keep.has(key)) keep.set(key, factory());
      return keep.get(key);
    },
    cleanup() {
      for (const fn of cleanups.splice(0)) {
        try { fn(); } catch (err) { console.error(err); }
      }
    },
  };
  return ctx;
}

function errorView(err) {
  const notFound = err && (err.status === 404);
  return h('div', { class: 'empty' },
    h('h1', null, notFound ? t('error.not_found_title') : t('error.screen_title')),
    h('p', null, errorText(err)),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => render() }, t('action.try_again')),
      h('a', { class: 'btn quiet', href: '/', dataset: { link: '' } }, t('nav.projects'))));
}

/** The screen object a response carries, at the top or one level down. */
function screenOf(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.screen && data.screen.key) return data.screen;
  // A screen that loads an issue and one of its pages is about the page.
  for (const key of ['page', 'cover']) {
    if (data[key] && data[key].screen && data[key].screen.key) return data[key].screen;
  }
  for (const value of Object.values(data)) {
    if (value && typeof value === 'object' && value.screen && value.screen.key) return value.screen;
  }
  return null;
}

/**
 * What a message sent from this screen is about. Screens with files of their
 * own say so in their response; the others send from the nearest screen that
 * has files, and the conversation shows which one.
 */
function screenFor(ctx, data) {
  if (!ctx.projectId) return null;
  const found = ctx.screen || screenOf(data);
  if (found) return { key: found.key, label: found.label, route: found.route };
  const base = `/p/${encodeURIComponent(ctx.projectId)}`;
  const page = ctx.params.page;
  switch (ctx.meta.screen) {
    case 'settings': return { key: 'options', label: t('nav.settings'), route: `${base}/settings` };
    case 'check':
    case 'corrections':
      if (page) return { key: `page:${page}`, label: t('page.n', { n: Number(String(page).slice(-3)) }), route: `${base}/pages/${page}` };
      return { key: `pages:${state.issue || 'ISS_001'}`, label: t('screen.pages'), route: `${base}/pages` };
    // The overview and the history have no files of their own: the message
    // goes with the story's, and the label says it is about the whole comic
    // (on History, "Story" read like the screen itself).
    case 'home':
    case 'history': return { key: 'story', label: t('home.about_comic'), route: `${base}/story` };
    default: return { key: 'story', label: t('screen.story'), route: `${base}/story` };
  }
}

/** Turn the page forward or back along the path; a plain fade elsewhere. */
function turnPage(main, screen) {
  const root = main.firstElementChild;
  if (!root || motionReduced()) return;
  const from = ORDER.indexOf(lastScreen);
  const to = ORDER.indexOf(screen);
  let cls = 'turn-fade';
  if (from >= 0 && to >= 0 && from !== to) cls = to > from ? 'turn-forward' : 'turn-back';
  root.classList.add(cls);
  root.addEventListener('animationend', () => root.classList.remove(cls), { once: true });
}

async function render() {
  const my = ++token;
  const main = document.getElementById('main');
  const path = location.pathname;
  const found = match(path);
  if (current) current.ctx.cleanup();
  current = null;
  clearTimeout(refreshTimer);
  if (!found) {
    mount(main, h('div', { class: 'empty' },
      h('h1', null, t('error.not_found_title')),
      h('p', null, t('error.no_such_screen')),
      h('a', { class: 'btn', href: '/', dataset: { link: '' } }, t('nav.projects'))));
    bus.emit('route', null);
    return;
  }
  const ctx = makeContext(found, path);
  const waiting = setTimeout(() => {
    if (my === token) mount(main, h('p', { class: 'loading' }, t('state.loading')));
  }, 180);
  try {
    if (ctx.projectId) await openProject(ctx.projectId);
    else closeProject();
    if (my !== token) return;
    const mod = await found.route.loader();
    const data = mod.load ? await mod.load(ctx) : null;
    if (my !== token) return;
    current = { route: found.route, ctx, path, mod };
    state.screenExamples = null;
    // What this screen shows in full is seen now; its markers stay until the person leaves.
    if (ctx.projectId) openScreen(found.route.meta.screen, found.params, state.issue);
    const node = mod.view(ctx, data);
    bus.emit('route', current);
    mount(main, node);
    setScreen(screenFor(ctx, data));
    if (!firstRender) turnPage(main, found.route.meta.screen);
    lastScreen = found.route.meta.screen;
    document.title = ctx.title ? `${ctx.title} · ${t('app.name')}` : t('app.name');
    window.scrollTo(0, 0);
    // After a move to another screen the focus goes to its content. On the
    // first load it stays where the browser put it, so the skip link works.
    if (!firstRender && !main.contains(document.activeElement)) main.focus({ preventScroll: true });
    firstRender = false;
  } catch (err) {
    if (my !== token) return;
    console.error(err);
    current = { route: found.route, ctx, path, mod: null };
    bus.emit('route', current);
    mount(main, errorView(err));
  } finally {
    clearTimeout(waiting);
  }
}

/** Load and build the current screen again without moving the person. */
async function refresh(force) {
  if (!current || !current.mod) return;
  const { ctx, mod } = current;
  const my = token;
  const main = document.getElementById('main');
  if (ctx.hasUnsaved() && !force) {
    staleBanner(true);
    return;
  }
  let data;
  try {
    data = mod.load ? await mod.load(ctx) : null;
  } catch (err) {
    if (my === token && force) mount(main, errorView(err));
    return;
  }
  if (my !== token || current.ctx !== ctx) return;
  if (ctx.hasUnsaved() && !force) {
    staleBanner(true);
    return;
  }
  const scroll = { x: window.scrollX, y: window.scrollY };
  const active = document.activeElement;
  const keepKey = active && main.contains(active) && active.dataset ? active.dataset.keep : null;
  const selection = keepKey && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  const scrolled = [...main.querySelectorAll('[data-scroll]')].map((el) => [el.dataset.scroll, el.scrollTop]);
  ctx.cleanup();
  const examples = state.screenExamples;
  state.screenExamples = null;
  const node = mod.view(ctx, data);
  if (!state.screenExamples) state.screenExamples = examples;
  mount(main, node);
  setScreen(screenFor(ctx, data));
  document.title = ctx.title ? `${ctx.title} · ${t('app.name')}` : t('app.name');
  for (const [key, top] of scrolled) {
    const el = main.querySelector(`[data-scroll="${CSS.escape(key)}"]`);
    if (el) el.scrollTop = top;
  }
  window.scrollTo(scroll.x, scroll.y);
  if (keepKey) {
    const el = main.querySelector(`[data-keep="${CSS.escape(keepKey)}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      if (selection && 'setSelectionRange' in el) {
        try { el.setSelectionRange(selection[0], selection[1]); } catch (err) { /* not a text control */ }
      }
    }
  }
}

/** Files changed while the person has unsaved edits: say so, and let them decide. */
function staleBanner(show) {
  const main = document.getElementById('main');
  const old = main.querySelector('.stale-banner');
  if (!show) {
    if (old) old.remove();
    return;
  }
  if (old) return;
  main.prepend(h('div', { class: 'notice warn stale-banner', role: 'status' },
    h('span', null, t('editor.stale_screen')), ' ',
    h('button', { type: 'button', class: 'btn small', onclick: () => refresh(true) }, t('editor.stale_reload'))));
}

/** Ask for a refresh soon; several requests close together make one. */
export function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh(false), 120);
}

export function start() {
  window.addEventListener('popstate', () => render());
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest && event.target.closest('a[href]');
    if (!link || link.target || link.hasAttribute('download')) return;
    const href = link.getAttribute('href');
    if (!href || !href.startsWith('/') || href.startsWith('/api/')) return;
    event.preventDefault();
    navigate(href);
  });
  window.addEventListener('beforeunload', (event) => {
    if (current && current.ctx.hasUnsaved()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  bus.on('files', () => scheduleRefresh());
  bus.on('job-ended', () => scheduleRefresh());
  bus.on('job-waiting', () => scheduleRefresh());
  render();
}

export function rerender() {
  render();
}

export { state };
