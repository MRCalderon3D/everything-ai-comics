// Two ways of showing a page that are shared by the page screens: the page
// as a sheet on the desk (3D where the browser can draw it, the flat frame
// otherwise), and the waiting state while a page is drawn, which says what is
// happening, how long it usually takes, and that the person can keep working.

import { h, icon, mount } from '/js/dom.js';
import { t, formatDuration } from '/js/i18n.js';
import { bus, measured, state } from '/js/store.js';
import { pageQueueState } from '/js/components/jobs.js';
import { frame } from '/js/components/viewer.js';
import { toolName, seconds } from '/js/labels.js';
import { glStage } from '/js/gl/stage.js';
import { sheetScene } from '/js/gl/sheet.js';
import { inkingScene } from '/js/gl/inking.js';

/**
 * pageSheet(ctx, key, image, { alt, onOpen }) -> a 3D sheet with the flat
 * frame as fallback, kept across refreshes; a new image turns the sheet over.
 */
export function pageSheet(ctx, key, image, { alt, onOpen } = {}) {
  const want = image && image.url;
  const el = ctx.persist(`sheet:${key}`, () => glStage({
    className: 'page-stage',
    label: alt,
    fallback: frame(image, { alt, onclick: onOpen }),
    scene: sheetScene({ url: want, width: image && image.width, height: image && image.height, onOpen: () => { if (el.openHandler) el.openHandler(); } }),
    onReady: (c) => { if (el.dataset.want && el.dataset.want !== el.dataset.shown) { c.api.show(el.dataset.want); el.dataset.shown = el.dataset.want; } },
  }));
  // The handler of the current view: the stage itself is kept across refreshes.
  el.openHandler = onOpen;
  if (!el.dataset.shown) el.dataset.shown = want || '';
  el.dataset.want = want || '';
  if (el.controller && want && el.dataset.shown !== want) {
    el.controller.api.show(want);
    el.dataset.shown = want;
  }
  if (image && image.width && image.height) {
    el.style.setProperty('aspect-ratio', `${image.width} / ${image.height}`);
    el.style.setProperty('--ar', String(image.width / image.height));
  }
  return el;
}

/** The expected time of one page, in ms: measured in this project, else four minutes. */
function expectedMs() {
  const draw = measured('draw');
  const look = measured('look');
  const d = draw && (draw.per_page_ms || draw.average_ms);
  if (d) return d + ((look && (look.per_page_ms || look.average_ms)) || 0);
  return 4 * 60 * 1000;
}

/**
 * drawingWait(ctx, pageId, { tiers, name }) -> a node that shows itself while
 * a job draws, checks or repairs this page, and is empty otherwise.
 */
export function drawingWait(ctx, pageId, { tiers, name } = {}) {
  const holder = h('div', { class: 'stack-s drawing-wait' });
  let since = null;
  const progress = () => {
    if (!since) return 0;
    return Math.min(0.97, (Date.now() - new Date(since).getTime()) / expectedMs());
  };
  const stage = ctx.persist(`wait:${pageId}`, () => glStage({
    className: 'wait-stage',
    label: t('wait.stage_label'),
    fallback: h('div', null, h('span', { class: 'pulse', 'aria-hidden': 'true' }), h('strong', null, t('wait.flat'))),
    scene: inkingScene({ tiers, progress: () => (stage.progress ? stage.progress() : 0) }),
  }));
  stage.progress = progress;
  const card = h('div', { class: 'wait-card', role: 'status' });
  const paint = () => {
    if (!document.contains(holder) && holder.dataset.mounted) { off(); clearInterval(timer); return; }
    const q = pageQueueState(pageId);
    if (!q || q.state === 'waiting') {
      if (q && q.state === 'waiting') {
        mount(holder, h('div', { class: 'wait-card', role: 'status' },
          h('strong', null, t('wait.queued', { name })), h('span', { class: 'small' }, t('wait.queued_hint'))));
      } else {
        mount(holder);
      }
      holder.dataset.mounted = '1';
      since = null;
      return;
    }
    since = (q.step && q.step.started_at) || q.job.started_at;
    const exp = expectedMs();
    const elapsed = seconds(since);
    const pct = Math.round(progress() * 100);
    const bar = h('span');
    bar.style.setProperty('width', `${pct}%`);
    const tool = q.step && q.step.tool ? toolName(q.step.tool) : toolName((state.overview && state.overview.tools.draw.tool) || 'codex');
    mount(card,
      h('strong', null, t(`wait.${q.state}`, { name, tool })),
      h('span', { class: 'small' }, t('wait.elapsed', { elapsed: formatDuration(elapsed), usual: formatDuration(exp / 1000) }),
        measured('draw') ? ` ${t('wait.measured_here')}` : ` ${t('wait.measured_before')}`),
      h('div', { class: 'wait-bar', 'aria-hidden': 'true' }, bar),
      h('span', { class: 'small muted' }, icon('clock'), ' ', elapsed * 1000 > exp ? t('wait.longer') : t('wait.keep_working')));
    if (!holder.contains(stage)) mount(holder, q.state === 'drawing' || q.state === 'preparing' ? stage : null, card);
    holder.dataset.mounted = '1';
    if (stage.controller) stage.controller.invalidate();
  };
  const off = bus.on('job', paint);
  const timer = setInterval(paint, 5000);
  ctx.onCleanup(() => { off(); clearInterval(timer); });
  paint();
  return holder;
}
