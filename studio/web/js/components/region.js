// Marking a part of an image: drag a rectangle with the pointer, or move and
// resize it with the keyboard. The region is kept as fractions of the image
// from its top-left corner, which is what the server takes.

import { h } from '/js/dom.js';
import { t } from '/js/i18n.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v) => Math.round(v * 1000) / 1000;

/**
 * regionPicker(image, { value, onchange, alt, marks })
 *   value   { x, y, w, h } or null
 *   marks   [{ region, label }] shown as outlines that cannot be edited
 * -> { el, value(), set(region), clear() }
 */
export function regionPicker(image, { value = null, onchange, alt, marks = [] } = {}) {
  let region = value;
  const box = h('div', { class: 'region-box', hidden: !region });
  const img = h('img', { src: image.url, alt: alt || '', draggable: false });
  const stage = h('div', {
    class: 'region-stage', tabIndex: 0, role: 'application',
    'aria-label': t('region.stage_label'),
  }, img, marks.map((m) => {
    const el = h('div', { class: 'region-mark', title: m.label || '' });
    el.style.setProperty('left', `${m.region.x * 100}%`);
    el.style.setProperty('top', `${m.region.y * 100}%`);
    el.style.setProperty('width', `${m.region.w * 100}%`);
    el.style.setProperty('height', `${m.region.h * 100}%`);
    return el;
  }), box);
  if (image.width && image.height) stage.style.setProperty('aspect-ratio', `${image.width} / ${image.height}`);
  const readout = h('p', { class: 'small muted region-readout', 'aria-live': 'polite' });

  const paint = () => {
    box.hidden = !region;
    if (region) {
      box.style.setProperty('left', `${region.x * 100}%`);
      box.style.setProperty('top', `${region.y * 100}%`);
      box.style.setProperty('width', `${region.w * 100}%`);
      box.style.setProperty('height', `${region.h * 100}%`);
      readout.textContent = t('region.readout', {
        x: Math.round(region.x * 100), y: Math.round(region.y * 100), w: Math.round(region.w * 100), h: Math.round(region.h * 100),
      });
    } else {
      readout.textContent = t('region.none');
    }
  };
  const commit = (next) => {
    if (next) {
      // Rounded so that x + w and y + h never pass 1, which the server refuses.
      const x = round(clamp(next.x, 0, 0.98));
      const y = round(clamp(next.y, 0, 0.98));
      region = {
        x,
        y,
        w: Math.floor(Math.min(next.w, 1 - x) * 1000) / 1000,
        h: Math.floor(Math.min(next.h, 1 - y) * 1000) / 1000,
      };
    } else {
      region = null;
    }
    paint();
    if (onchange) onchange(region);
  };

  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stage.focus({ preventScroll: true });
    const rect = stage.getBoundingClientRect();
    const at = (e) => ({ x: clamp((e.clientX - rect.left) / rect.width, 0, 1), y: clamp((e.clientY - rect.top) / rect.height, 0, 1) });
    const start = at(event);
    let moved = false;
    const move = (e) => {
      const p = at(e);
      const w = Math.abs(p.x - start.x);
      const hh = Math.abs(p.y - start.y);
      if (w < 0.01 && hh < 0.01) return;
      moved = true;
      region = { x: Math.min(p.x, start.x), y: Math.min(p.y, start.y), w, h: hh };
      paint();
    };
    const up = () => {
      stage.removeEventListener('pointermove', move);
      if (moved && region && region.w >= 0.02 && region.h >= 0.02) commit(region);
      else if (moved) commit(null);
    };
    stage.setPointerCapture(event.pointerId);
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up, { once: true });
    stage.addEventListener('pointercancel', up, { once: true });
  });

  // Keyboard: Enter starts a region in the middle, arrows move it, Shift with
  // arrows resizes it, Delete removes it.
  stage.addEventListener('keydown', (event) => {
    const step = 0.02;
    if ((event.key === 'Enter' || event.key === ' ') && !region) {
      event.preventDefault();
      commit({ x: 0.3, y: 0.3, w: 0.4, h: 0.4 });
      return;
    }
    if (!region) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      commit(null);
      return;
    }
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!dir) return;
    event.preventDefault();
    const next = Object.assign({}, region);
    if (event.shiftKey) {
      next.w = clamp(next.w + dir[0] * step, 0.02, 1 - next.x);
      next.h = clamp(next.h + dir[1] * step, 0.02, 1 - next.y);
    } else {
      next.x = clamp(next.x + dir[0] * step, 0, 1 - next.w);
      next.y = clamp(next.y + dir[1] * step, 0, 1 - next.h);
    }
    commit(next);
  });

  paint();
  return {
    el: h('div', { class: 'region' }, stage, readout),
    value: () => region,
    set: (next) => commit(next),
    clear: () => commit(null),
  };
}
