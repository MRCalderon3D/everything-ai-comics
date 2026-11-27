// Asking for a change on a drawn page or cover: mark a region or pick a
// panel, write what to change, send. The result is shown beside the version
// it came from, with the path the studio took said in plain words.

import { h, nextId } from '/js/dom.js';
import { t, tn } from '/js/i18n.js';
import { findJob, ENDED } from '/js/store.js';
import { textField, checkField, radioField, actionButton, button, notice } from '/js/components/ui.js';
import { confirmDialog } from '/js/components/dialog.js';
import { regionPicker } from '/js/components/region.js';
import { compare } from '/js/components/viewer.js';
import { verdictChip } from '/js/components/verdict.js';
import { queueOp } from '/js/components/ask.js';
import { toast } from '/js/components/toast.js';
import { correctionPath, versionName } from '/js/labels.js';

/** "row 1 of 2, panel 2 of 3": where a panel sits, from the numbers of its slot. */
export function slotWords(slot) {
  if (!slot) return '';
  return slot.of > 1
    ? t('slot.words', { tier: slot.tier, tiers: slot.tiers, slot: slot.slot, of: slot.of })
    : t('slot.words_full', { tier: slot.tier, tiers: slot.tiers });
}

/**
 * A small drawing of the rows of the page with a box per panel, from the
 * plan's tiers. The plan gives no sizes, so every row is as tall as the
 * others and every panel in a row as wide: it says which row and which
 * position, nothing more. The radios beside it stay the way to choose; a box
 * can also be clicked.
 */
export function tierSchematic(panels, selected, onPick) {
  const placed = panels.filter((p) => p.slot && p.slot.tiers);
  if (!placed.length || placed.length !== panels.length) return { el: null, select: () => {} };
  const tiers = placed[0].slot.tiers;
  const rows = [];
  for (let tier = 1; tier <= tiers; tier += 1) {
    rows.push(placed.filter((p) => p.slot.tier === tier).sort((a, b) => a.slot.slot - b.slot.slot));
  }
  const cells = new Map();
  const label = h('p', { class: 'small muted schematic-label', 'aria-live': 'polite' });
  const select = (id) => {
    for (const [pid, cell] of cells) cell.classList.toggle('on', pid === id);
    const p = placed.find((x) => x.id === id);
    label.textContent = p ? `${t('page.panel_n', { n: p.number })}: ${slotWords(p.slot)}` : t('correct.whole_page');
  };
  const grid = h('div', { class: 'schematic', 'aria-hidden': 'true' },
    rows.map((row) => h('div', { class: 'schematic-row' }, row.map((p) => {
      const cell = h('div', { class: 'schematic-cell', title: `${t('page.panel_n', { n: p.number })}: ${slotWords(p.slot)}` }, String(p.number));
      cell.addEventListener('click', () => { onPick(p.id); select(p.id); });
      cells.set(p.id, cell);
      return cell;
    }))));
  select(selected);
  return { el: h('div', { class: 'schematic-box' }, grid, label), select };
}

/** The warning at the touch-up limit, in the words of rules/common/repair-limits.md. */
function warningText(n, cover) {
  return tn(cover ? 'correct.at_warning_cover' : 'correct.at_warning', Number(n) || 0);
}

/**
 * Start a correction. When the image has reached the touch-up warning and no
 * choice was made yet, the server says so (409 touch_up_choice): the person
 * then chooses here between touching up anyway and a redraw with the change.
 * Returns the job, or null when they cancel.
 */
export async function queueCorrection(op, params) {
  try {
    return await queueOp(op, params);
  } catch (err) {
    if (!err || err.code !== 'touch_up_choice' || params.mode) throw err;
    const cover = op === 'cover.correct';
    let mode = 'touch_up';
    const choice = radioField({
      legend: t('correct.choose'), value: mode,
      options: [
        { value: 'touch_up', label: t('correct.touch_up_anyway'), hint: t('correct.touch_up_hint') },
        { value: 'redraw', label: t(cover ? 'correct.redraw_cover' : 'correct.redraw_page'), hint: t('correct.redraw_hint') },
      ],
      onchange: (value) => { mode = value; },
    });
    const ok = await confirmDialog({
      title: t('correct.at_warning_title'),
      body: h('div', { class: 'stack-s' }, h('p', null, warningText(err.details && err.details.touch_ups, cover)), choice.el),
      confirm: t('correct.send'),
    });
    if (!ok) return null;
    return queueOp(op, Object.assign({}, params, { mode }));
  }
}

/**
 * correction(ctx, { key, render, panels, touchUpWarning, send })
 *   render          the render the request is about (with image and review)
 *   panels          [{ id, number, moment, slot }] for a page; none for a cover
 *   touchUpWarning  edits of one image after which the person chooses (project setting)
 *   send(params)    starts the operation with { text, render, panel, region, lettering, mode }
 * -> { form, stage }: the form goes with the text, the stage with the images.
 */
export function correction(ctx, { key, render, panels = [], touchUpWarning, send }) {
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
  const schematic = tierSchematic(panels, ui.panel, (id) => {
    ui.panel = id;
    const radio = panelPick && panelPick.querySelector(`input[value="${CSS.escape(id)}"]`);
    if (radio) radio.checked = true;
  });
  const panelPick = panels.length ? h('fieldset', { class: 'radios' }, h('legend', null, t('correct.where')),
    [{ id: '', number: null, moment: t('correct.whole_page') }, ...panels].map((p) => {
      const id = nextId('pn');
      return h('div', { class: 'check' },
        h('input', { type: 'radio', name, id, value: p.id, checked: ui.panel === p.id, onchange: () => { ui.panel = p.id; schematic.select(p.id); } }),
        h('label', { for: id },
          p.number ? h('strong', null, `${t('page.panel_n', { n: p.number })}: `) : null, p.moment,
          p.slot ? h('span', { class: 'small faint slot-words' }, ` (${slotWords(p.slot)})`) : null));
    })) : null;

  const cover = String(render.id).startsWith('CV_');
  const cycle = review && typeof review.repair_cycle === 'number' ? review.repair_cycle : 0;
  const atWarning = Number.isInteger(touchUpWarning) && cycle >= touchUpWarning;

  const go = async (mode) => {
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
      mode: mode || undefined,
    });
    what.clear();
    letteringDraft.clear();
    lettering.input.checked = false;
    ui.region = null;
    ui.panel = '';
    picker.clear();
    schematic.select('');
    const whole = panelPick && panelPick.querySelector('input[value=""]');
    if (whole) whole.checked = true;
  };

  const form = h('form', { class: 'stack-s', onsubmit: (e) => e.preventDefault() },
    h('p', { class: 'muted' }, t('correct.intro', { version: versionName(render.id) })),
    panelPick ? h('div', { class: 'panel-pick' }, panelPick, schematic.el) : null,
    h('div', { class: 'row' }, h('span', { class: 'small muted' }, t('correct.region_help')), clearBtn),
    what.el,
    lettering.el,
    atWarning
      // At the warning the person decides: both paths, side by side, with what each costs.
      ? h('div', { class: 'stack-s touch-up-choice' },
        notice('warn', warningText(cycle, cover)),
        h('div', { class: 'row' },
          actionButton(t('correct.touch_up_anyway'), () => go('touch_up'), { kind: 'primary' }),
          actionButton(t(cover ? 'correct.redraw_cover' : 'correct.redraw_page'), () => go('redraw'), { kind: 'accent' })),
        h('p', { class: 'small muted' }, t('correct.choice_hint')))
      : h('div', { class: 'stack-s' },
        notice('info', Number.isInteger(touchUpWarning)
          ? tn(cover ? 'correct.will_edit_cover' : 'correct.will_edit', Math.max(0, touchUpWarning - cycle), { left: Math.max(0, touchUpWarning - cycle) })
          : t('correct.will_edit_unknown')),
        h('div', { class: 'row' },
          actionButton(t('correct.send'), () => go(), { kind: 'primary' }),
          h('span', { class: 'small muted' }, t('correct.time')))));

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
