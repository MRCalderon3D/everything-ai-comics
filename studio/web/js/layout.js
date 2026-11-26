// The layout of the frame: the width of the path on the left and of the
// conversation on the right, whether each is collapsed to a thin rail, and
// focus mode, which hides both. It belongs to the person, not to a project:
// it is kept in this browser and survives a reload. Below the tablet width
// the two sides are drawers that open on request and close on their own.

import { h } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { bus } from '/js/store.js';

const KEY = 'studio.layout';
export const LIMITS = { rail: [168, 340], dock: [300, 640] };
const DEFAULTS = { rail: 216, dock: 380, railCollapsed: false, dockCollapsed: false, focus: false };
/** Widths below which a side stops being a column. */
export const DOCK_FLOATS = 1240;
export const RAIL_DRAWER = 760;

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    return Object.assign({}, DEFAULTS, saved);
  } catch (err) {
    return Object.assign({}, DEFAULTS);
  }
}

export const layout = loadSaved();
/** What is not remembered: the drawers and the floating conversation. */
export const transient = { railDrawer: false, dockFloat: false };

const clamp = (side, v) => Math.round(Math.min(LIMITS[side][1], Math.max(LIMITS[side][0], Number(v) || DEFAULTS[side])));

export function dockFloats() {
  return window.innerWidth <= DOCK_FLOATS;
}
export function railIsDrawer() {
  return window.innerWidth <= RAIL_DRAWER;
}

/** Whether the conversation shows its full column (or, when it floats, its panel). */
export function dockExpanded() {
  if (dockFloats()) return transient.dockFloat;
  return !layout.dockCollapsed && !layout.focus;
}

export function applyLayout() {
  const app = document.getElementById('app');
  const root = document.documentElement;
  if (!app) return;
  layout.rail = clamp('rail', layout.rail);
  layout.dock = clamp('dock', layout.dock);
  root.style.setProperty('--rail', `${layout.rail}px`);
  root.style.setProperty('--dock', `${layout.dock}px`);
  app.dataset.focus = String(!!layout.focus);
  app.dataset.rail = railIsDrawer() ? (transient.railDrawer ? 'drawer-open' : 'drawer') : (layout.railCollapsed ? 'collapsed' : 'open');
  app.dataset.dock = dockExpanded() ? 'open' : 'collapsed';
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(layout)); } catch (err) { /* storage is off: the layout lasts this visit */ }
}

/** Change the layout, keep it, and tell the frame. */
export function setLayout(patch) {
  Object.assign(layout, patch);
  save();
  applyLayout();
  bus.emit('layout', layout);
}

export function setTransient(patch) {
  Object.assign(transient, patch);
  applyLayout();
  bus.emit('layout', layout);
}

export function toggleFocus() {
  setLayout({ focus: !layout.focus });
}

/**
 * A drag handle between a side and the screen. It is a separator the
 * keyboard can move: arrows by 16 px (Shift for 48), Home and End to the
 * limits, Enter or a double click back to the default width.
 */
export function resizeHandle(side) {
  const label = t(side === 'rail' ? 'layout.resize_rail' : 'layout.resize_dock');
  const el = h('div', {
    class: `resize-handle ${side}`, role: 'separator', tabIndex: 0,
    'aria-orientation': 'vertical', 'aria-label': label, title: `${label}. ${t('layout.resize_hint')}`,
    'aria-valuemin': String(LIMITS[side][0]), 'aria-valuemax': String(LIMITS[side][1]),
  });
  const sync = () => el.setAttribute('aria-valuenow', String(layout[side]));
  const set = (w) => { setLayout({ [side]: clamp(side, w) }); sync(); };
  // The rail grows to the right, the dock to the left.
  const dir = side === 'rail' ? 1 : -1;
  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = event.clientX;
    const from = layout[side];
    const app = document.getElementById('app');
    app.classList.add('resizing');
    el.setPointerCapture(event.pointerId);
    const move = (e) => {
      layout[side] = clamp(side, from + dir * (e.clientX - start));
      applyLayout();
      sync();
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      app.classList.remove('resizing');
      setLayout({});
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up, { once: true });
    el.addEventListener('pointercancel', up, { once: true });
  });
  el.addEventListener('dblclick', () => set(DEFAULTS[side]));
  el.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 48 : 16;
    let next = null;
    if (event.key === 'ArrowLeft') next = layout[side] - dir * step;
    else if (event.key === 'ArrowRight') next = layout[side] + dir * step;
    else if (event.key === 'Home') next = LIMITS[side][0];
    else if (event.key === 'End') next = LIMITS[side][1];
    else if (event.key === 'Enter') next = DEFAULTS[side];
    if (next === null) return;
    event.preventDefault();
    set(next);
  });
  sync();
  return el;
}

/** Start once: apply what was kept, follow the window, and the focus shortcut. */
export function startLayout() {
  applyLayout();
  let wasDrawer = railIsDrawer();
  let wasFloat = dockFloats();
  window.addEventListener('resize', () => {
    // Crossing a breakpoint closes the drawers it opened.
    if (railIsDrawer() !== wasDrawer) transient.railDrawer = false;
    if (dockFloats() !== wasFloat) transient.dockFloat = false;
    wasDrawer = railIsDrawer();
    wasFloat = dockFloats();
    applyLayout();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && transient.railDrawer && !document.querySelector('dialog[open]')) {
      setTransient({ railDrawer: false });
      const b = document.querySelector('.steps-toggle');
      if (b) b.focus();
      return;
    }
    // Ctrl+Shift+F (Cmd+Shift+F on a Mac) switches focus mode.
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'F' || event.key === 'f')) {
      event.preventDefault();
      toggleFocus();
    }
  });
  bus.on('route', () => {
    if (transient.railDrawer || (dockFloats() && transient.dockFloat)) setTransient({ railDrawer: false, dockFloat: false });
  });
}
