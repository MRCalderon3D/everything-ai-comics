// The style: pick a preset, describe one, upload references, or mix them;
// draw look pages, compare them, approve one. Approval freezes the style.
// The general options of the project live in a tab here.

import { h, nextId } from '/js/dom.js';
import { t, tn, tv } from '/js/i18n.js';
import { api } from '/js/api.js';
import { state } from '/js/store.js';
import { screenHead, bench } from '/js/components/bench.js';
import { tabs, notice, panel, actionButton, textField, checkField, caption, disclosure } from '/js/components/ui.js';
import { docEditor } from '/js/components/editor.js';
import { queueOp } from '/js/components/ask.js';
import { uploader } from '/js/components/uploader.js';
import { jobsFor } from '/js/components/jobs.js';
import { frame, openViewer, compareBox } from '/js/components/viewer.js';
import { assetGrid, viewerItems } from '/js/components/assets.js';
import { handoff, noDrawTool } from '/js/components/handoff.js';
import { optionsForm } from '/js/components/options.js';
import { toast } from '/js/components/toast.js';

export async function load(ctx) {
  return api.style(ctx.projectId);
}

function presetPicker(ctx, presets) {
  const draft = ctx.draft('preset');
  const name = nextId('preset');
  const cards = presets.map((p) => {
    const id = nextId('p');
    const input = h('input', { type: 'radio', name, id, value: p.key, checked: draft.get() === p.key });
    input.addEventListener('change', () => draft.set(p.key));
    return h('li', { class: 'preset' },
      input,
      h('label', { for: id },
        h('span', { class: 'preset-name' }, tv('preset', p.key, p.name)),
        h('span', { class: 'preset-color' }, tv('color', p.color_mode, p.color_mode)),
        h('span', { class: 'preset-intent' }, p.intent)),
      h('details', { class: 'preset-more' },
        h('summary', null, t('style.preset_details')),
        h('dl', { class: 'facts' },
          [['line', p.line], ['inking', p.inking], ['tone', p.tone], ['rendering', p.rendering], ['lettering_style', p.lettering_style],
            ['palette', Array.isArray(p.palette) ? p.palette.join('; ') : p.palette]]
            .filter(([, v]) => v).map(([k, v]) => [h('dt', null, t(`style.preset_${k}`)), h('dd', null, v)]))));
  });
  const noneId = nextId('p');
  const none = h('input', { type: 'radio', name, id: noneId, value: '', checked: !draft.get() });
  none.addEventListener('change', () => draft.set(''));
  return {
    el: h('fieldset', { class: 'presets' }, h('legend', null, t('style.presets_legend')),
      h('ul', { class: 'preset-list' },
        h('li', { class: 'preset' }, none, h('label', { for: noneId }, h('span', { class: 'preset-name' }, t('style.preset_none')),
          h('span', { class: 'preset-intent' }, t('style.preset_none_hint')))),
        cards)),
    value: () => draft.get() || '',
    clear: () => draft.clear(),
  };
}

function defineForm(ctx, data) {
  const presets = presetPicker(ctx, data.presets);
  const words = textField({
    label: t('style.words_label'), multiline: true, rows: 3, draft: ctx.draft('words'), optional: true,
    hint: t('style.words_hint'), placeholder: t('style.words_placeholder'),
  });
  const refs = uploader(ctx, { kind: 'image', key: 'style-refs', label: t('style.refs_label'), hint: t('style.refs_hint') });
  const attach = checkField({ label: t('style.attach_label'), checked: true, hint: t('style.attach_hint'), draft: ctx.draft('attach') });
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
  };
  return h('form', { class: 'stack', onsubmit: (e) => e.preventDefault() },
    h('p', { class: 'muted' }, t('style.define_intro')),
    presets.el, words.el, refs.el, attach.el,
    h('div', { class: 'row' }, actionButton(data.look.id ? t('style.define_again') : t('style.define'), go, { kind: 'primary' })));
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
      h('p', { class: 'caption-text' }, t('style.draw_first'))));
  }

  nodes.push(jobsFor((j) => j.op === 'style.look' || (j.op === 'page.manual' && j.params && j.params.sheet === 'look')));

  if (defined) {
    if (draw.available) {
      nodes.push(h('div', { class: 'row' },
        actionButton(candidates.length ? t('style.draw_another') : t('style.draw_look'), () => queueOp('style.look', {}),
          { kind: look.master ? 'quiet' : 'primary' }),
        h('span', { class: 'small muted' }, t('style.draw_time'))));
    } else {
      nodes.push(noDrawTool(t('style.no_draw_tool')));
    }
  }

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
    // The style is frozen: the other look pages are kept to look at, not to choose again.
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
  const lede = frozen ? t('style.lede_frozen')
    : (look.id ? t('style.lede_defined') : t('style.lede_empty'));

  const text = h('div', { class: 'stack' },
    jobsFor((j) => j.op === 'style.define'),
    h('section', { class: 'panel' },
      tabs(ctx, 'style', [
        frozen || look.id ? null : { id: 'define', label: t('style.tab_define'), render: () => defineForm(ctx, data) },
        look.id ? { id: 'bible', label: t('style.tab_bible'), render: () => docEditor(ctx, data.style_bible, { key: 'bible', title: t('style.bible_title') }) } : null,
        look.id ? {
          id: 'block', label: t('style.tab_block'),
          render: () => h('div', { class: 'stack-s' },
            h('p', { class: 'muted' }, t('style.block_intro')),
            docEditor(ctx, data.style_block, { key: 'block', title: t('style.block_title'), readonly: frozen ? t('style.block_frozen') : null, rows: 10 })),
        } : null,
        look.id ? { id: 'color', label: t('style.tab_color'), render: () => docEditor(ctx, data.color_script, { key: 'color', title: t('style.color_title') }) } : null,
        !frozen && look.id ? { id: 'define', label: t('style.tab_redefine'), render: () => defineForm(ctx, data) } : null,
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
      focus: look.id ? 'images' : 'text',
      images: imagesPart(ctx, data, draw),
      chat: { key: data.chat_key, examples: [t('style.example_1'), t('style.example_2')] },
    }));
}
