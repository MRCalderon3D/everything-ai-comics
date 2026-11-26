// Asking for a change on a drawn page or cover: mark a region or pick a
// panel, write what to change, send. The result is shown beside the version
// it came from, with the path the studio took said in plain words.

import { h, nextId } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { findJob, ENDED } from '/js/store.js';
import { textField, checkField, actionButton, button, notice } from '/js/components/ui.js';
import { regionPicker } from '/js/components/region.js';
import { compare } from '/js/components/viewer.js';
import { verdictChip } from '/js/components/verdict.js';
import { queueOp } from '/js/components/ask.js';
import { toast } from '/js/components/toast.js';
import { correctionPath, versionName } from '/js/labels.js';

/**
 * correction(ctx, { key, render, panels, repairLimit, send })
 *   render       the render the request is about (with image and review)
 *   panels       [{ id, number, moment }] for a page; none for a cover
 *   send(params) starts the operation with { text, render, panel, region, lettering }
 * -> { form, stage }: the form goes with the text, the stage with the images.
 */
export function correction(ctx, { key, render, panels = [], repairLimit, send }) {
  const ui = ctx.ui[`corr:${key}`] || (ctx.ui[`corr:${key}`] = { region: null, panel: '' });
  const review = render.review;
  const past = review ? (review.findings || []).filter((f) => f.region).map((f) => ({ region: f.region, label: f.repair })) : [];
  const picker = regionPicker(render.lettered || render.image, {
    value: ui.region,
    alt: t('correct.image_alt', { version: versionName(render.id) }),
    marks: past,
    onchange: (region) => {
      ui.region = region;
      clearBtn.hidden = !region;
    },
  });
  const clearBtn = button(t('correct.clear_region'), { kind: 'quiet', small: true, onclick: () => picker.clear() });
  clearBtn.hidden = !ui.region;

  const what = textField({
    label: t('correct.what'), multiline: true, rows: 4, draft: ctx.draft(`corr:${key}`),
    placeholder: t('correct.what_placeholder'), hint: t('correct.what_hint'),
  });
  const letteringDraft = ctx.draft(`corr-let:${key}`);
  const lettering = checkField({ label: t('correct.lettering'), hint: t('correct.lettering_hint'), draft: letteringDraft });

  const name = nextId('panel');
  const panelPick = panels.length ? h('fieldset', { class: 'radios' }, h('legend', null, t('correct.where')),
    [{ id: '', number: null, moment: t('correct.whole_page') }, ...panels].map((p) => {
      const id = nextId('pn');
      return h('div', { class: 'check' },
        h('input', { type: 'radio', name, id, value: p.id, checked: ui.panel === p.id, onchange: () => { ui.panel = p.id; } }),
        h('label', { for: id }, p.number ? h('strong', null, `${t('page.panel_n', { n: p.number })}: `) : null, p.moment));
    })) : null;

  const cycle = review && typeof review.repair_cycle === 'number' ? review.repair_cycle : 0;
  const willRedraw = typeof repairLimit === 'number' && cycle >= repairLimit;

  const go = async () => {
    const text = what.value.trim();
    if (!text) {
      what.input.focus();
      toast(t('form.write_first'), { kind: 'warn' });
      return;
    }
    await send({
      text,
      render: render.id,
      panel: ui.panel || undefined,
      region: ui.region || undefined,
      lettering: lettering.value,
    });
    what.clear();
    letteringDraft.clear();
    lettering.input.checked = false;
    ui.region = null;
    ui.panel = '';
    picker.clear();
  };

  const form = h('form', { class: 'stack-s', onsubmit: (e) => e.preventDefault() },
    h('p', { class: 'muted' }, t('correct.intro', { version: versionName(render.id) })),
    panelPick,
    h('div', { class: 'row' }, h('span', { class: 'small muted' }, t('correct.region_help')), clearBtn),
    what.el,
    lettering.el,
    notice(willRedraw ? 'warn' : 'info', willRedraw
      ? t('correct.will_redraw', { limit: repairLimit })
      : t('correct.will_edit', { used: cycle, limit: repairLimit ?? '?' })),
    h('div', { class: 'row' },
      actionButton(t('correct.send'), go, { kind: 'primary' }),
      h('span', { class: 'small muted' }, t('correct.time'))));

  return { form, stage: h('div', { class: 'stack-s' }, picker.el) };
}

/**
 * What the last correction of this page or cover produced: the old and the
 * new version together, and which path was taken.
 *   test(job)   picks the correction jobs of this page or cover
 *   renders     the renders of the page or cover
 */
export function lastCorrection(ctx, { key, test, renders, onAccept, canAccept }) {
  const job = findJob((j) => test(j) && ENDED.includes(j.status));
  if (!job || job.status !== 'done' || !job.result) return null;
  const r = job.result;
  const from = renders.find((x) => x.id === r.from);
  const to = renders.find((x) => x.id === r.render);
  if (!from || !to || !from.image || !to.image) return null;
  const s = ctx.ui[`last:${key}`] || (ctx.ui[`last:${key}`] = { mode: 'side' });
  const a = { id: from.id, label: `${versionName(from.id)} (${t('correct.before')})`, image: from.lettered || from.image };
  const b = { id: to.id, label: `${versionName(to.id)} (${t('correct.after')})`, image: to.lettered || to.image };
  const stage = h('div');
  const paint = () => stage.replaceChildren(compare(a, b, s.mode));
  const mode = (m, label) => {
    const btn = h('button', { type: 'button', class: 'btn small quiet', 'aria-pressed': String(s.mode === m) }, label);
    btn.addEventListener('click', () => {
      s.mode = m;
      for (const other of bar.querySelectorAll('[aria-pressed]')) other.setAttribute('aria-pressed', String(other === btn));
      paint();
    });
    return btn;
  };
  const bar = h('div', { class: 'row', role: 'group', 'aria-label': t('viewer.compare_mode') }, mode('side', t('viewer.side_by_side')), mode('slider', t('viewer.slider')));
  paint();
  const request = job.params && job.params.text;
  return h('section', { class: 'panel stack-s last-correction' },
    h('h2', { class: 'panel-title' }, t('correct.result_title')),
    request ? h('p', null, h('span', { class: 'muted' }, t('correct.you_asked')), ' ', h('q', null, request)) : null,
    h('p', { class: `path-taken ${r.path}` }, h('strong', null, correctionPath(r)), ' ',
      r.path === 'redraw' ? t('correct.redraw_note') : t('correct.edit_note')),
    h('p', null, verdictChip(to.review || r)),
    bar,
    stage,
    h('div', { class: 'row' },
      canAccept && to.current ? actionButton(t('correct.accept'), onAccept, { kind: 'primary' }) : null,
      h('span', { class: 'small muted' }, to.current ? t('correct.or_ask_again') : t('correct.newer_exists'))));
}
