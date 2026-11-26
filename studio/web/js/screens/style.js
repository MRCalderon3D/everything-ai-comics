// The style: choose a preset by its sample page, describe a look in words,
// upload reference images, or mix them; then draw look pages, compare them
// and approve one. Approval freezes the style. The general options of the
// project live in a tab here.

import { h, icon, nextId, mount } from '/js/dom.js';
import { t, tn, tv } from '/js/i18n.js';
import { api } from '/js/api.js';
import { state } from '/js/store.js';
import { screenHead, bench } from '/js/components/bench.js';
import { tabs, notice, panel, actionButton, button, textField, checkField, caption, disclosure } from '/js/components/ui.js';
import { docEditor } from '/js/components/editor.js';
import { queueOp } from '/js/components/ask.js';
import { uploader } from '/js/components/uploader.js';
import { jobsFor } from '/js/components/jobs.js';
import { frame, openViewer, compareBox } from '/js/components/viewer.js';
import { openDialog } from '/js/components/dialog.js';
import { assetGrid, viewerItems } from '/js/components/assets.js';
import { handoff, noDrawTool } from '/js/components/handoff.js';
import { optionsForm } from '/js/components/options.js';
import { toast } from '/js/components/toast.js';
import { glStage } from '/js/gl/stage.js';
import { ringScene } from '/js/gl/ring.js';
import { groupPresets } from '/js/preset-groups.js';

export async function load(ctx) {
  return api.style(ctx.projectId);
}

function presetArt(p, { large } = {}) {
  if (p && p.preview && p.preview.url) {
    return h('span', { class: 'preset-art' }, h('img', { src: p.preview.url, alt: t('style.sample_alt', { name: p.name || p.key }), loading: large ? 'eager' : 'lazy', decoding: 'async' }));
  }
  return h('span', { class: 'preset-art none' }, p ? t('style.no_sample') : t('style.own_no_sample'));
}

function presetDetails(p) {
  const rows = [['line', p.line], ['inking', p.inking], ['tone', p.tone], ['rendering', p.rendering], ['lettering_style', p.lettering_style],
    ['palette', Array.isArray(p.palette) ? p.palette.join('; ') : p.palette]].filter(([, v]) => v);
  return h('details', { class: 'preset-more' },
    h('summary', null, t('style.preset_details')),
    h('dl', { class: 'facts' },
      rows.map(([k, v]) => [h('dt', null, t(`style.preset_${k}`)), h('dd', null, v)]),
      p.drift_risks && p.drift_risks.length
        ? [h('dt', null, t('style.drift_title')), h('dd', null, h('ul', { class: 'bullets' }, p.drift_risks.map((d) => h('li', null, d))))]
        : null));
}

/** The large comparison of the presets the person ticked. */
function openCompare(presets) {
  const fig = h('div', { class: 'preset-compare' }, presets.map((p) => h('figure', null,
    p.preview ? h('img', { src: p.preview.url, alt: t('style.sample_alt', { name: p.name }) }) : presetArt(p),
    h('figcaption', null, h('strong', null, p.name), h('p', { class: 'small muted' }, p.intent)))));
  fig.style.setProperty('--n', String(presets.length));
  openDialog({ title: t('style.compare_presets_title'), wide: true, body: fig }).el.classList.add('viewer-dialog');
}

/**
 * The gallery of presets: large cards with their sample pages, grouped as in
 * the presets' README, with a ring of the same pages in 3D above when the
 * browser can draw it. Returns { el, value(), clear() }.
 */
function presetGallery(ctx, presets, { ring = true } = {}) {
  const draft = ctx.draft('preset');
  const name = nextId('preset');
  const compare = ctx.ui.compare || (ctx.ui.compare = new Set());
  const filter = ctx.ui.presetFilter || 'all';
  const groups = groupPresets(presets);
  const byKey = new Map(presets.map((p) => [p.key, p]));
  const items = presets.map((p) => ({ key: p.key, url: p.preview ? p.preview.url : null }));

  const captionEl = h('div', { class: 'row spread preset-caption', 'aria-live': 'polite' });
  let stage = null;
  if (ring && presets.length) {
    stage = ctx.persist('ring', () => glStage({
      className: 'preset-stage',
      scene: ringScene(items, {
        selected: draft.get() || presets[0].key,
        emptyText: t('style.no_sample'),
        // The stage outlives a refresh of the screen; it calls the gallery of the current view.
        onPick: (key) => { if (ctx.ui.ringPick) ctx.ui.ringPick(key, { fromRing: true }); },
      }),
    }));
  }
  // The arrows turn the ring to look; "choose" makes the page in front the look.
  let front = Math.max(0, presets.findIndex((x) => x.key === draft.get()));
  const paintCaption = () => {
    const p = presets[front];
    if (!p) return;
    const chosen = draft.get() === p.key;
    const turn = (d) => {
      front = (front + d + presets.length) % presets.length;
      if (stage && stage.controller) stage.controller.api.select(presets[front].key);
      paintCaption();
    };
    mount(captionEl,
      h('button', { type: 'button', class: 'btn icon-only quiet', 'aria-label': t('style.prev_preset'), onclick: () => turn(-1) }, icon('left')),
      h('div', { class: 'grow' },
        h('strong', null, p.name),
        h('span', { class: 'small muted' }, ' ', p.intent)),
      chosen
        ? h('span', { class: 'chip ok' }, icon('check'), t('style.chosen'))
        : button(t('style.choose_this'), { small: true, kind: 'accent', onclick: () => choose(p.key) }),
      h('button', { type: 'button', class: 'btn icon-only quiet', 'aria-label': t('style.next_preset'), onclick: () => turn(1) }, icon('right')));
  };
  const inputs = new Map();
  ctx.ui.ringPick = (key, opts) => choose(key, opts);
  function choose(key, { fromRing } = {}) {
    draft.set(key);
    const at = presets.findIndex((x) => x.key === key);
    if (at >= 0) front = at;
    const input = inputs.get(key);
    if (input) input.checked = true;
    if (stage && stage.controller && !fromRing) stage.controller.api.select(key);
    if (fromRing && input) input.closest('.preset').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    paintCaption();
    paintTray();
    if (onChange) onChange();
  }
  let onChange = null;

  const tray = h('div', { class: 'compare-tray', hidden: true });
  const paintTray = () => {
    const chosen = [...compare].map((k) => byKey.get(k)).filter(Boolean);
    tray.hidden = !chosen.length;
    mount(tray,
      h('div', { class: 'row' }, h('div', { class: 'tray-thumbs' }, chosen.map((p) => (p.preview ? h('img', { src: p.preview.url, alt: '' }) : null))),
        h('span', null, tn('style.compare_count', chosen.length))),
      h('div', { class: 'row' },
        button(t('style.compare_clear'), { kind: 'quiet', small: true, onclick: () => { compare.clear(); for (const b of boxes.values()) b.checked = false; paintTray(); } }),
        button(t('style.compare_open'), { kind: 'primary', small: true, icon: 'compare', disabled: chosen.length < 2, onclick: () => openCompare(chosen) })));
  };
  const boxes = new Map();

  const card = (p) => {
    const id = nextId('p');
    const input = h('input', { type: 'radio', name, id, value: p ? p.key : '', checked: (draft.get() || '') === (p ? p.key : '') });
    input.addEventListener('change', () => choose(p ? p.key : ''));
    inputs.set(p ? p.key : '', input);
    let tools = null;
    if (p) {
      const cid = nextId('cmp');
      const box = h('input', { type: 'checkbox', id: cid, checked: compare.has(p.key) });
      box.addEventListener('change', () => {
        if (box.checked) {
          if (compare.size >= 4) { box.checked = false; toast(t('style.compare_max'), { kind: 'warn' }); return; }
          compare.add(p.key);
        } else compare.delete(p.key);
        paintTray();
      });
      boxes.set(p.key, box);
      tools = h('div', { class: 'preset-tools' }, h('span', { class: 'check inline' }, box, h('label', { for: cid }, t('style.compare_pick'))));
    }
    return h('li', { class: 'preset' },
      input,
      h('label', { for: id },
        presetArt(p),
        h('span', { class: 'preset-name' }, p ? p.name : t('style.preset_none'),
          p ? h('span', { class: 'chip' }, tv('color', p.color_mode, p.color_mode)) : null),
        h('span', { class: 'preset-intent' }, p ? p.intent : t('style.preset_none_hint'))),
      tools,
      p ? presetDetails(p) : null);
  };

  const filters = h('div', { class: 'preset-filter', role: 'group', 'aria-label': t('style.filter_label') },
    ['all', ...groups.map(([g]) => g)].map((g) => {
      const b = h('button', { type: 'button', class: 'btn small', 'aria-pressed': String(filter === g) }, g === 'all' ? t('style.group_all') : tv('preset_group', g, g));
      b.addEventListener('click', () => { ctx.ui.presetFilter = g; ctx.refresh(); });
      return b;
    }));

  const shown = filter === 'all' ? groups : groups.filter(([g]) => g === filter);
  const el = h('fieldset', { class: 'presets' },
    h('legend', { class: 'sr-only' }, t('style.presets_legend')),
    stage,
    stage ? captionEl : null,
    filters,
    shown.map(([group, list]) => h('section', { class: 'preset-group' },
      h('h3', null, tv('preset_group', group, group)),
      h('ul', { class: 'preset-list' }, list.map((p) => card(p))))),
    h('section', { class: 'preset-group' },
      h('h3', null, t('style.own_group')),
      h('ul', { class: 'preset-list' }, card(null))),
    tray);
  paintCaption();
  paintTray();
  return {
    el,
    value: () => draft.get() || '',
    label: () => { const p = byKey.get(draft.get()); return p ? p.name : ''; },
    clear: () => draft.clear(),
    onChange: (fn) => { onChange = fn; },
  };
}

function defineForm(ctx, data, { ring = true } = {}) {
  const presets = presetGallery(ctx, data.presets, { ring });
  const words = textField({
    label: t('style.words_label'), multiline: true, rows: 4, draft: ctx.draft('words'), optional: true,
    hint: t('style.words_hint'), placeholder: t('style.words_placeholder'),
  });
  const summary = h('span', { class: 'grow small' });
  const refs = uploader(ctx, { kind: 'image', key: 'style-refs', label: t('style.refs_label'), hint: t('style.refs_hint'), onchange: () => paint() });
  const attach = checkField({ label: t('style.attach_label'), checked: true, hint: t('style.attach_hint'), draft: ctx.draft('attach') });
  function paint() {
    const parts = [];
    if (presets.value()) parts.push(presets.label());
    if (words.value.trim()) parts.push(t('style.mix_words'));
    if (refs.count && refs.count()) parts.push(tn('style.mix_images', refs.count()));
    mount(summary, parts.length ? t('style.mix_summary', { parts: parts.join(' + ') }) : t('style.mix_nothing'));
  }
  presets.onChange(paint);
  words.input.addEventListener('input', paint);
  const go = async () => {
    const params = {};
    if (presets.value()) params.preset = presets.value();
    if (words.value.trim()) params.description = words.value.trim();
    const ids = refs.ids();
    if (ids.length) {
      params.uploads = ids;
      params.attach_references = attach.value;
    }
    if (!Object.keys(params).length) {
      toast(t('style.need_something'), { kind: 'warn' });
      return;
    }
    await queueOp('style.define', params);
    words.clear();
    refs.clear();
    presets.clear();
  };
  paint();
  return h('form', { class: 'stack', onsubmit: (e) => e.preventDefault() },
    h('div', { class: 'section-head' }, h('h2', null, t('style.choose_title')), h('p', null, t('style.define_intro'))),
    presets.el,
    h('section', { class: 'stack-s' },
      h('div', { class: 'section-head' }, h('h2', null, t('style.mix_title')), h('p', null, t('style.mix_intro'))),
      h('div', { class: 'define-mix' }, words.el, h('div', { class: 'stack-s' }, refs.el, attach.el))),
    h('div', { class: 'pages-toolbar style-go' }, summary,
      actionButton(data.look.id ? t('style.define_again') : t('style.define'), go, { kind: 'primary' })));
}

function imagesPart(ctx, data, draw) {
  const look = data.look;
  const defined = !!look.id && !data.style_block.template;
  const candidates = look.candidates || [];
  const pending = candidates.filter((c) => !c.promoted_to);
  const all = [...(look.masters || []), ...candidates, ...(look.references || [])];
  const nodes = [];

  if (look.master) {
    nodes.push(h('section', { class: 'stack-s' },
      h('h2', { class: 'panel-title' }, t('style.master_title')),
      frame(look.master.image, {
        alt: t('style.master_alt'),
        onclick: () => openViewer(viewerItems(all), look.master.id),
      }),
      notice('info', h('strong', null, t('style.frozen_title')), ' ', t('style.frozen_body'))));
  } else if (!defined) {
    nodes.push(h('div', { class: 'art-empty' }, h('h2', null, t('style.no_look_title')), h('p', null, t('style.no_look_body'))));
  } else if (!candidates.length) {
    nodes.push(caption(
      h('p', { class: 'caption-label' }, t('home.next_title')),
      h('p', { class: 'caption-text' }, t('style.draw_first')),
      draw.available ? actionButton(t('style.draw_look'), () => queueOp('style.look', {}), { kind: 'primary' }) : null));
  }

  nodes.push(jobsFor((j) => j.op === 'style.look' || (j.op === 'page.manual' && j.params && j.params.sheet === 'look')));

  if (defined && candidates.length && !look.master) {
    if (draw.available) {
      nodes.push(h('div', { class: 'row' },
        actionButton(t('style.draw_another'), () => queueOp('style.look', {}), { kind: 'quiet' }),
        h('span', { class: 'small muted' }, t('style.draw_time'))));
    }
  }
  if (defined && !draw.available) nodes.push(noDrawTool(t('style.no_draw_tool')));

  if (candidates.length && !look.master) {
    nodes.push(h('section', { class: 'stack-s' },
      h('h2', { class: 'panel-title' }, tn('style.candidates_title', candidates.length)),
      h('p', { class: 'muted' }, t('style.candidates_hint')),
      assetGrid(ctx, candidates, { all, isLook: true, masterOf: () => false }),
      candidates.length > 1
        ? h('div', { class: 'stack-s' }, h('h3', null, t('style.compare_title')),
          compareBox(ctx, 'looks', viewerItems(candidates)))
        : null));
  } else if (look.master && pending.length) {
    nodes.push(disclosure(ctx, 'old-looks', tn('style.earlier_candidates', pending.length),
      () => assetGrid(ctx, pending, { all, isLook: true, masterOf: () => true, canApprove: false })));
  }

  if (look.references && look.references.length) {
    nodes.push(h('section', { class: 'stack-s' },
      h('h2', { class: 'panel-title' }, t('style.references_title')),
      assetGrid(ctx, look.references, { all })));
  }

  if (defined && (!draw.available || ctx.ui.manualLook)) {
    nodes.push(panel(t('handoff.title'), handoff(ctx, 'look', { entity: look.id, sheet: 'look' })));
  } else if (defined && !look.master) {
    nodes.push(h('button', { type: 'button', class: 'link small', onclick: () => { ctx.ui.manualLook = true; ctx.refresh(); } }, t('handoff.offer')));
  }
  return h('div', { class: 'stack' }, nodes);
}

export function view(ctx, data) {
  ctx.title = t('screen.style');
  const look = data.look;
  const draw = state.overview.tools.draw;
  const frozen = look.frozen;
  const examples = [t('style.example_1'), t('style.example_2')];

  if (!look.id) {
    state.screenExamples = examples;
    return h('div', { class: 'screen' },
      screenHead({ title: t('screen.style'), lede: t('style.lede_empty') }),
      h('div', { class: 'stack' },
        jobsFor((j) => j.op === 'style.define'),
        defineForm(ctx, data),
        disclosure(ctx, 'options-early', t('style.tab_options'), () => optionsForm(ctx, { options: data.options, choices: data.choices }))));
  }

  const lede = frozen ? t('style.lede_frozen') : t('style.lede_defined');
  const text = h('div', { class: 'stack' },
    jobsFor((j) => j.op === 'style.define'),
    h('section', { class: 'panel' },
      tabs(ctx, 'style', [
        { id: 'bible', label: t('style.tab_bible'), render: () => docEditor(ctx, data.style_bible, { key: 'bible', title: t('style.bible_title') }) },
        {
          id: 'block', label: t('style.tab_block'),
          render: () => h('div', { class: 'stack-s' },
            h('p', { class: 'muted' }, t('style.block_intro')),
            docEditor(ctx, data.style_block, { key: 'block', title: t('style.block_title'), readonly: frozen ? t('style.block_frozen') : null, rows: 10 })),
        },
        { id: 'color', label: t('style.tab_color'), render: () => docEditor(ctx, data.color_script, { key: 'color', title: t('style.color_title') }) },
        !frozen ? { id: 'define', label: t('style.tab_redefine'), render: () => defineForm(ctx, data, { ring: false }) } : null,
        {
          id: 'options', label: t('style.tab_options'),
          render: () => h('div', { class: 'stack' },
            optionsForm(ctx, { options: data.options, choices: data.choices }),
            h('p', { class: 'small muted' }, t('style.tools_link_before'), ' ',
              h('a', { href: `/p/${encodeURIComponent(ctx.projectId)}/settings` }, t('nav.settings')), '.')),
        },
      ], { label: t('screen.style') })));

  return h('div', { class: 'screen' },
    screenHead({ title: t('screen.style'), lede }),
    bench(ctx, {
      text,
      focus: 'images',
      images: imagesPart(ctx, data, draw),
      chat: { examples },
    }));
}
