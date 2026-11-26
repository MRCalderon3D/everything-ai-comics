// One character: the written sheet, the drawn sheets, more sheets on request,
// and the approval of a master.

import { h } from '/js/dom.js';
import { t, tn } from '/js/i18n.js';
import { api } from '/js/api.js';
import { state } from '/js/store.js';
import { screenHead, bench } from '/js/components/bench.js';
import { tabs, panel, actionButton, notice, checkField, selectField } from '/js/components/ui.js';
import { docEditor } from '/js/components/editor.js';
import { askForm, queueOp } from '/js/components/ask.js';
import { uploader } from '/js/components/uploader.js';
import { jobsFor } from '/js/components/jobs.js';
import { frame, openViewer } from '/js/components/viewer.js';
import { assetGrid, viewerItems, sheetName } from '/js/components/assets.js';
import { handoff, noDrawTool } from '/js/components/handoff.js';
import { pageName } from '/js/labels.js';

const SHEETS = ['turnaround', 'expressions', 'wardrobe'];

export async function load(ctx) {
  return api.character(ctx.projectId, ctx.params.char);
}

function changeForm(ctx, data, canDraw) {
  const photos = uploader(ctx, { kind: 'image', key: 'more-photos', label: t('characters.more_photos'), hint: t('characters.photo_rights') });
  const redraw = checkField({ label: t('character.redraw'), checked: false, disabled: !canDraw, hint: canDraw ? null : t('characters.draw_needs_look') });
  return askForm(ctx, {
    key: 'change',
    label: t('character.change_label'),
    placeholder: t('character.change_placeholder'),
    action: t('character.change_action'),
    required: false,
    extra: [photos.el, redraw.el],
    run: async (instruction) => {
      const params = { character: data.id, draw: canDraw && redraw.value };
      if (instruction) params.instruction = instruction;
      const ids = photos.ids();
      if (ids.length) params.uploads = ids;
      if (!instruction && !ids.length && !params.draw) throw new Error(t('character.change_nothing'));
      await queueOp('character.update', params);
      photos.clear();
    },
  });
}

function imagesPart(ctx, data, draw) {
  const assets = data.assets;
  const all = [...assets.masters, ...assets.candidates, ...assets.references];
  const items = viewerItems(all);
  const lookOk = data.look_approved;
  const canDraw = lookOk && draw.available;
  const outfits = data.wardrobe && data.wardrobe.data && Array.isArray(data.wardrobe.data.outfits) ? data.wardrobe.data.outfits : [];
  const mine = (j) => (j.op === 'character.sheet' || j.op === 'character.update' || j.op === 'character.create' || j.op === 'page.manual')
    && j.params && (j.params.character === data.id || j.params.entity === data.id);
  const nodes = [jobsFor(mine)];

  if (data.image) {
    const main = all.find((a) => a.image && a.image.path === data.image.path);
    nodes.push(frame(data.image, {
      alt: t('characters.image_alt', { name: data.name }),
      onclick: () => openViewer(items, main ? main.id : items[0] && items[0].id),
      caption: data.has_master ? t('characters.has_master') : (main && main.sheet === 'reference' ? t('characters.photo_only') : t('character.newest_candidate')),
    }));
  } else {
    nodes.push(h('div', { class: 'art-empty' }, h('h2', null, t('character.no_image_title')),
      h('p', null, lookOk ? t('character.no_image_body') : t('characters.look_first'))));
  }

  if (!lookOk) {
    nodes.push(notice('info', t('characters.look_first'), ' ', h('a', { href: `/p/${encodeURIComponent(ctx.projectId)}/style` }, t('screen.style'))));
  } else if (!draw.available) {
    nodes.push(noDrawTool(t('character.no_draw_tool')));
  }

  const sheetChoice = selectField({
    label: t('character.sheet_kind'), value: ctx.ui.sheet || 'turnaround',
    options: SHEETS.map((s) => ({ value: s, label: sheetName(s) })),
    onchange: (v) => { ctx.ui.sheet = v; ctx.refresh(); },
  });
  const kind = ctx.ui.sheet || 'turnaround';
  const outfitChoice = kind === 'wardrobe' && outfits.length > 1 ? selectField({
    label: t('character.outfit'), value: ctx.ui.outfit || '',
    options: [{ value: '', label: t('character.outfit_default') }, ...outfits.map((o) => ({ value: o.id, label: o.name || o.id }))],
    onchange: (v) => { ctx.ui.outfit = v; },
  }) : null;

  if (canDraw) {
    nodes.push(h('div', { class: 'panel stack-s' },
      h('h2', { class: 'panel-title' }, t('character.more_sheets')),
      h('div', { class: 'field-pair' }, sheetChoice.el, outfitChoice ? outfitChoice.el : null),
      h('div', { class: 'row' },
        actionButton(t('character.draw_sheet', { sheet: sheetName(kind) }), () => queueOp('character.sheet', {
          character: data.id, sheet: kind, outfit: kind === 'wardrobe' && ctx.ui.outfit ? ctx.ui.outfit : undefined,
        }), { kind: data.has_master ? '' : 'primary' }),
        h('span', { class: 'small muted' }, t('style.draw_time')))));
  }

  for (const sheet of ['turnaround', 'expressions', 'wardrobe', 'detail']) {
    const group = data.sheets && data.sheets[sheet];
    if (!group || (!group.master && !group.candidates.length)) continue;
    // The candidate a master was made from is the same image: show it once.
    const list = [group.master, ...group.candidates.filter((c) => !c.promoted_to)].filter(Boolean);
    nodes.push(h('section', { class: 'stack-s' },
      h('h2', { class: 'panel-title' }, sheetName(sheet)),
      assetGrid(ctx, list, { all, masterOf: (s) => !!(data.sheets[s] && data.sheets[s].master) })));
  }
  if (assets.references.length) {
    nodes.push(h('section', { class: 'stack-s' },
      h('h2', { class: 'panel-title' }, t('character.references_title')),
      h('p', { class: 'small muted' }, t('character.references_hint')),
      assetGrid(ctx, assets.references, { all })));
  }
  if (lookOk && (!draw.available || ctx.ui.manual)) {
    nodes.push(panel(t('handoff.title'), canDraw ? null : sheetChoice.el, handoff(ctx, `char:${kind}`, { entity: data.id, sheet: kind })));
  } else if (lookOk) {
    nodes.push(h('button', { type: 'button', class: 'link small', onclick: () => { ctx.ui.manual = true; ctx.refresh(); } }, t('handoff.offer')));
  }
  return h('div', { class: 'stack' }, nodes);
}

export function view(ctx, data) {
  ctx.title = data.name;
  const draw = state.overview.tools.draw;
  const base = `/p/${encodeURIComponent(ctx.projectId)}`;
  const canDraw = data.look_approved && draw.available;
  const text = h('div', { class: 'stack' },
    panel(t('character.change_title'), changeForm(ctx, data, canDraw)),
    h('section', { class: 'panel' },
      tabs(ctx, 'char', [
        { id: 'sheet', label: t('character.tab_sheet'), render: () => docEditor(ctx, data.character, { key: 'character', title: t('character.sheet_title') }) },
        { id: 'wardrobe', label: t('character.tab_wardrobe'), render: () => docEditor(ctx, data.wardrobe, { key: 'wardrobe', title: t('character.wardrobe_title') }) },
      ], { label: data.name })),
    data.used_on && data.used_on.length
      ? h('p', { class: 'small muted' }, tn('character.used_on', data.used_on.length), ' ',
        data.used_on.map((p, i) => [i ? ', ' : '', h('a', { href: `${base}/pages/${p}` }, pageName(p))]))
      : null);
  return h('div', { class: 'screen' },
    screenHead({
      title: data.name,
      lede: data.summary || t('character.no_summary'),
      back: { href: `${base}/characters`, label: t('screen.characters') },
    }),
    bench(ctx, {
      text,
      images: imagesPart(ctx, data, draw),
      chat: { key: data.chat_key, title: t('chat.title_about', { name: data.name }), examples: [t('character.example_1')] },
    }));
}
