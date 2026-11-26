// The 3D layer. three.js is vendored in /vendor/three/ and loaded only when
// a screen mounts a stage, so screens without 3D never download it.
//
// A stage is an element with a canvas and a flat fallback inside. The scene
// draws only while the stage is on screen and the tab is visible; with
// reduced motion it draws single still frames when something changes; with
// no WebGL the fallback stays and nothing else happens.

import { h } from '/js/dom.js';
import { bus } from '/js/store.js';

const THREE_URL = '/vendor/three/three.module.min.js';
let threePromise = null;
let glSupport = null;
const live = new Set();

/** True when the browser can make a WebGL context. Asked once. */
export function webglAvailable() {
  if (glSupport !== null) return glSupport;
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
    glSupport = !!gl;
    if (gl && gl.getExtension('WEBGL_lose_context')) gl.getExtension('WEBGL_lose_context').loseContext();
  } catch (err) {
    glSupport = false;
  }
  return glSupport;
}

export function motionReduced() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** The vendored three.js module, fetched on first use. */
export function loadThree() {
  if (!threePromise) threePromise = import(THREE_URL);
  return threePromise;
}

/** The colours of the current theme, as the scenes need them. */
export function palette() {
  const css = getComputedStyle(document.documentElement);
  const read = (name, fallback) => (css.getPropertyValue(name).trim() || fallback);
  return {
    board: read('--board', '#eceef2'),
    sheet: read('--sheet', '#ffffff'),
    sheet2: read('--sheet-2', '#f5f6f8'),
    ink: read('--panel-ink', '#1b1a22'),
    ink3: read('--ink-3', '#696876'),
    marker: read('--marker', '#ffd23d'),
    live: read('--live', '#c2185f'),
    cyan: read('--cyan', '#0e9fd4'),
    art: read('--art-bg', '#dfe2e8'),
    dark: document.documentElement.dataset.theme === 'dark'
      || (document.documentElement.dataset.theme !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches),
  };
}

/**
 * An image scaled down on a canvas before it becomes a texture, so a
 * 1024 x 1536 page costs a fraction of its size on the graphics card.
 */
export function smallTexture(THREE, url, maxWidth = 384) {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const scale = Math.min(1, maxWidth / (img.naturalWidth || maxWidth));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(2, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(2, Math.round(img.naturalHeight * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      resolve({ texture, width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * glStage({ className, label, fallback, scene }) -> element with
 * `el.controller` once it runs.
 *
 * scene(THREE, env) builds the scene and returns
 *   { render(time, dt) -> boolean (true while it still moves),
 *     resize(width, height), pointer?(x, y, inside), click?(x, y),
 *     theme?(palette), dispose?() }
 * env: { canvas, renderer, reduced, palette, invalidate }.
 */
export function glStage({ className = '', label, fallback, scene, onReady } = {}) {
  const canvas = h('canvas', { 'aria-hidden': label ? null : 'true', role: label ? 'img' : null, 'aria-label': label || null });
  const el = h('div', { class: `gl-stage ${className}`.trim(), dataset: { gl: 'pending' } },
    canvas, fallback ? h('div', { class: 'gl-fallback' }, fallback) : null);
  if (!webglAvailable()) {
    el.dataset.gl = 'off';
    return el;
  }
  // Start once the element is in the page and has a size.
  requestAnimationFrame(() => start(el, canvas, scene, onReady));
  return el;
}

async function start(el, canvas, build, onReady) {
  let THREE;
  try {
    THREE = await loadThree();
  } catch (err) {
    el.dataset.gl = 'off';
    return;
  }
  if (!document.contains(el)) {
    // Built for a screen that is already gone; a later mount starts again.
    el.dataset.gl = 'pending';
    const retry = () => { if (document.contains(el)) start(el, canvas, build, onReady); };
    setTimeout(retry, 300);
    return;
  }
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch (err) {
    el.dataset.gl = 'off';
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const state = {
    el, renderer, visible: true, raf: 0, last: 0, moving: true, disposed: false,
    reduced: motionReduced(), offs: [],
  };
  const invalidate = () => { state.moving = true; schedule(); };
  const env = { canvas, renderer, reduced: state.reduced, palette: palette(), invalidate };
  let sceneApi;
  try {
    sceneApi = build(THREE, env);
  } catch (err) {
    console.error(err);
    renderer.dispose();
    el.dataset.gl = 'off';
    return;
  }

  const size = () => {
    const rect = el.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const hgt = Math.max(1, Math.round(rect.height));
    renderer.setSize(w, hgt, false);
    if (sceneApi.resize) sceneApi.resize(w, hgt);
    invalidate();
  };

  function frame(now) {
    state.raf = 0;
    if (state.disposed) return;
    if (!document.contains(el)) { dispose(); return; }
    const dt = state.last ? Math.min(0.1, (now - state.last) / 1000) : 0.016;
    state.last = now;
    let keep = false;
    try {
      keep = sceneApi.render(now / 1000, state.reduced ? 1 : dt) && !state.reduced;
    } catch (err) {
      console.error(err);
      dispose();
      el.dataset.gl = 'off';
      return;
    }
    state.moving = keep;
    if (keep) schedule();
    else state.last = 0;
  }
  function schedule() {
    if (state.disposed || state.raf || !state.visible || document.hidden) return;
    state.raf = requestAnimationFrame(frame);
  }
  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    if (state.raf) cancelAnimationFrame(state.raf);
    for (const off of state.offs) off();
    try { if (sceneApi.dispose) sceneApi.dispose(); } catch (err) { /* already gone */ }
    renderer.dispose();
    live.delete(state);
  }

  const io = new IntersectionObserver((entries) => {
    state.visible = entries.some((e) => e.isIntersecting);
    if (state.visible) schedule();
  });
  io.observe(el);
  const ro = new ResizeObserver(() => size());
  ro.observe(el);
  const onVis = () => { if (!document.hidden) { state.last = 0; schedule(); } };
  document.addEventListener('visibilitychange', onVis);
  const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const onMotion = () => { state.reduced = motionReduced(); env.reduced = state.reduced; invalidate(); };
  if (mq && mq.addEventListener) mq.addEventListener('change', onMotion);
  const offTheme = bus.on('theme', () => {
    env.palette = palette();
    if (sceneApi.theme) sceneApi.theme(env.palette);
    invalidate();
  });
  state.offs.push(() => io.disconnect(), () => ro.disconnect(), offTheme,
    () => document.removeEventListener('visibilitychange', onVis),
    () => { if (mq && mq.removeEventListener) mq.removeEventListener('change', onMotion); });

  if (sceneApi.pointer) {
    const move = (event) => {
      const rect = el.getBoundingClientRect();
      sceneApi.pointer(((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1), true);
      invalidate();
    };
    const leave = () => { sceneApi.pointer(0, 0, false); invalidate(); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
  }
  if (sceneApi.click) {
    el.addEventListener('click', (event) => {
      const rect = el.getBoundingClientRect();
      sceneApi.click(((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1));
    });
  }

  live.add(state);
  size();
  el.dataset.gl = 'on';
  el.controller = { invalidate, dispose, api: sceneApi };
  if (onReady) onReady(el.controller);
}

// A stage removed from the page lets its graphics context go even while it
// is not drawing.
setInterval(() => {
  for (const s of [...live]) {
    if (!document.contains(s.el) && s.el.controller) s.el.controller.dispose();
  }
}, 3000);
