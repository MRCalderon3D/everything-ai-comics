// One character: the written sheet, the drawn sheets, more sheets on request,
// the full character sheet refined round by round, and the approval of a
// master. The identity chain is said plainly: photos are where the face comes
// from, the approved drawn sheet is the face everything else is drawn from.

import { h } from '/js/dom.js';
import { t, tn } from '/js/i18n.js';
import { api } from '/js/api.js';
import { state } from '/js/store.js';
import { screenHead, bench } from '/js/components/bench.js';
import { tabs, panel, actionButton, notice, checkField, selectField, textField, button } from '/js/components/ui.js';
import { docEditor } from '/js/components/editor.js';
import { askForm, queueOp } from '/js/components/ask.js';
import { uploader } from '/js/components/uploader.js';
import { jobsFor } from '/js/components/jobs.js';
import { frame, openViewer, compareBox } from '/js/components/viewer.js';
import { regionPicker } from '/js/components/region.js';
import { assetGrid, viewerItems, sheetName, approveAsset } from '/js/components/assets.js';
import { handoff, noDrawTool } from '/js/components/handoff.js';
import { toast } from '/js/components/toast.js';
import { pageName } from '/js/labels.js';

const SHEETS = ['turnaround', 'model', 'expressions', 'wardrobe'];
const NEEDS_MASTER = ['expressions', 'wardrobe'];

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

/** Where the character stands: which image is the face, and why a sheet is missing. */
function identityNotice(ctx, data, draw) {
  const base = `/p/${encodeURIComponent(ctx.projectId)}`;
  const id = data.identity || {};
  const waiting = data.candidates > 0;
  if (id.master) {
    return notice('ok', h('p', null, t('character.identity_master', { sheet: sheetName(id.master.kind).toLowerCase() })));
  }
  if (!data.look_approved) {
    return notice('warn', h('p', null, h('strong', null, t('character.missing_sheet')), ' ', t('character.missing_look')),
      h('p', null, h('a', { href: `${base}/style` }, t('character.go_style'))));
  }
  if (!draw.available) return null;
  if (waiting) return notice('next', h('p', null, t('character.approve_first')), h('p', null, h('a', { href: '#sheets' }, t('character.go_sheets'))));
  return notice('next', h('p', null, h('strong', null, t('character.missing_sheet')), ' ',
    id.photos && id.photos.length ? t('character.missing_from_photos') : t('character.missing_none')));
}

/** Lines of a textarea, trimmed, without empties. */
function linesOf(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
}

function drawPanel(ctx, data, outfits) {
  const kind = ctx.ui.sheet || (data.identity && data.identity.master ? 'expressions' : 'turnaround');
  const blocked = NEEDS_MASTER.includes(kind) && data.identity && data.identity.needs_master;
  const sheetChoice = selectField({
    label: t('character.sheet_kind'), value: kind,
    options: SHEETS.map((s) => ({ value: s, label: NEEDS_MASTER.includes(s) && data.identity && data.identity.needs_master ? `${sheetName(s)} (${t('character.needs_master_short')})` : sheetName(s) })),
    onchange: (v) => { ctx.ui.sheet = v; ctx.refresh(); },
  });
  const outfitChoice = kind === 'wardrobe' && outfits.length > 1 ? selectField({
    label: t('character.outfit'), value: ctx.ui.outfit || '',
    options: [{ value: '', label: t('character.outfit_default') }, ...outfits.map((o) => ({ value: o.id, label: o.name || o.id }))],
    onchange: (v) => { ctx.ui.outfit = v; },
  }) : null;
  const nodes = [h('div', { class: 'field-pair' }, sheetChoice.el, outfitChoice ? outfitChoice.el : null)];
  nodes.push(h('p', { class: 'small muted' }, t(`character.sheet_about.${kind}`)));

  let lists = null;
  if (kind === 'model') {
    const plan = data.sheet_plan || { closeups: [], poses: [] };
    const closeups = textField({
      label: t('character.closeups'), multiline: true, rows: 4, draft: ctx.draft('closeups'),
      value: plan.closeups.join('\n'), hint: t('character.closeups_hint'),
    });
    const poses = textField({
      label: t('character.poses'), multiline: true, rows: 4, draft: ctx.draft('poses'),
      value: plan.poses.join('\n'), hint: t('character.poses_hint'),
    });
    lists = { closeups, poses };
    nodes.push(closeups.el, poses.el);
  }
  if (blocked) {
    nodes.push(notice('warn', h('p', null, t('character.needs_master')),
      h('p', null, h('a', { href: '#sheets' }, t('character.go_sheets')))));
  }
  const go = async () => {
    const params = { character: data.id, sheet: kind };
    if (kind === 'wardrobe' && ctx.ui.outfit) params.outfit = ctx.ui.outfit;
    if (lists) {
      const closeups = linesOf(lists.closeups.value);
      const poses = linesOf(lists.poses.value);
      if (closeups.length > 8 || poses.length > 8) throw new Error(t('character.lists_too_long'));
      params.closeups = closeups;
      params.poses = poses;
    }
    await queueOp('character.sheet', params);
  };
  nodes.push(h('div', { class: 'row' },
    actionButton(t('character.draw_sheet', { sheet: sheetName(kind) }), go, { kind: data.has_master ? '' : 'primary', disabled: blocked }),
    h('span', { class: 'small muted' }, t('style.draw_time'))));
  return { el: h('div', { class: 'panel stack-s' }, h('h2', { class: 'panel-title' }, t('character.more_sheets')), ...nodes), sheetChoice, kind };
}

/** The versions of the full sheet side by side, approval, and a round of changes on one of them. */
function modelPart(ctx, data, all, canDraw) {
  const versions = (data.model_versions || []).filter((v) => v.image);
  if (!versions.length) return null;
  const items = viewerItems(all);
  const master = data.sheets && data.sheets.model && data.sheets.model.master;
  const latest = versions[versions.length - 1];
  const s = ctx.ui.model || (ctx.ui.model = { base: null, region: null });
  // The newest version, unless the person chose an earlier one to go back to.
  if (!s.chosen || !versions.some((v) => v.id === s.base)) s.base = latest.id;
  const base = versions.find((v) => v.id === s.base);

  const cards = h('div', { class: 'asset-grid' }, versions.map((v) => {
    const isMaster = v.status === 'approved';
    const check = v.check || null;
    return h('div', { class: 'asset', dataset: { status: v.status } },
      frame(v.image, { alt: t('character.model_version', { n: v.version }), onclick: () => openViewer(items, v.id) }),
      h('div', { class: 'asset-meta' },
        h('strong', null, t('character.model_version', { n: v.version })),
        h('span', { class: `asset-state ${v.status}` }, isMaster ? t('character.model_master') : (v.status === 'superseded' ? t('character.model_old') : t('asset.candidate'))),
        check && check.verdict === 'flagged' ? h('span', { class: 'small state-wait' }, t('character.check_flagged')) : null),
      h('div', { class: 'row' },
        !isMaster && v.status !== 'superseded' && v.status === 'candidate'
          ? actionButton(t('character.model_approve'), () => approveAsset(ctx, v, { hasMaster: !!master }), { small: true, kind: 'primary' })
          : null,
        s.base === v.id
          ? h('span', { class: 'small muted' }, t('character.model_is_base'))
          : button(t('character.model_use_base'), { small: true, kind: 'quiet', onclick: () => { s.base = v.id; s.chosen = v.id !== latest.id; s.region = null; ctx.refresh(); } })));
  }));

  const nodes = [h('h2', { class: 'panel-title' }, sheetName('model')), h('p', { class: 'small muted' }, t('character.model_intro')), cards];
  if (versions.length > 1) {
    nodes.push(compareBox(ctx, `model:${data.id}`, versions.map((v) => ({ id: v.id, label: t('character.model_version', { n: v.version }), image: v.image }))));
  }

  if (canDraw && base) {
    const picker = regionPicker(base.image, {
      value: s.region, alt: t('character.model_version', { n: base.version }),
      onchange: (region) => { s.region = region; clearBtn.hidden = !region; },
    });
    const clearBtn = button(t('correct.clear_region'), { kind: 'quiet', small: true, onclick: () => picker.clear() });
    clearBtn.hidden = !s.region;
    const what = textField({
      label: t('character.revise_what'), multiline: true, rows: 4, draft: ctx.draft(`revise:${data.id}`),
      placeholder: t('character.revise_placeholder'), hint: t('character.revise_hint'),
    });
    const photos = uploader(ctx, { kind: 'image', key: 'revise-photos', label: t('character.revise_photo'), hint: t('characters.photo_rights') });
    const send = async () => {
      const text = what.value.trim();
      if (!text) {
        what.input.focus();
        toast(t('form.write_first'), { kind: 'warn' });
        return;
      }
      const params = { character: data.id, sheet: 'model', revise: base.id, text };
      if (s.region) params.region = s.region;
      const ids = photos.ids();
      if (ids.length) params.uploads = ids;
      await queueOp('character.sheet', params);
      what.clear();
      photos.clear();
      s.region = null;
      picker.clear();
    };
    nodes.push(h('section', { class: 'stack-s revise' },
      h('h3', null, t('character.revise_title', { n: base.version })),
      h('p', { class: 'small muted' }, t('character.revise_intro')),
      picker.el,
      h('div', { class: 'row' }, h('span', { class: 'small muted' }, t('correct.region_help')), clearBtn),
      what.el,
      photos.el,
      h('div', { class: 'row' },
        actionButton(t('character.revise_send'), send, { kind: 'primary' }),
        h('span', { class: 'small muted' }, t('style.draw_time')))));
  }
  return h('section', { class: 'panel stack-s', id: 'model' }, ...nodes);
}

/** What the identity check found on candidates drawn from the master. */
function checkNotes(list) {
  const flagged = list.filter((c) => c && c.check && c.check.verdict === 'flagged' && Array.isArray(c.check.findings) && c.check.findings.length);
  if (!flagged.length) return null;
  return notice('warn', ...flagged.map((c) => h('div', null,
    h('p', null, h('strong', null, t('character.check_title', { sheet: sheetName(c.sheet), n: c.version }))),
    h('ul', { class: 'bullets' }, c.check.findings.map((f) => h('li', null, f.visible, f.repair ? ` ${f.repair}` : ''))))));
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

  const status = identityNotice(ctx, data, draw);
  if (status) nodes.push(status);
  if (lookOk && !draw.available) nodes.push(noDrawTool(t('character.no_draw_tool')));

  let sheetChoice = null;
  let kind = ctx.ui.sheet || 'turnaround';
  if (canDraw) {
    const part = drawPanel(ctx, data, outfits);
    nodes.push(part.el);
    sheetChoice = part.sheetChoice;
    kind = part.kind;
  }

  const model = modelPart(ctx, data, all, canDraw);
  if (model) nodes.push(model);

  const groups = [];
  for (const sheet of ['turnaround', 'expressions', 'wardrobe', 'detail']) {
    const group = data.sheets && data.sheets[sheet];
    if (!group || (!group.master && !group.candidates.length)) continue;
    // The candidate a master was made from is the same image: show it once.
    const list = [group.master, ...group.candidates.filter((c) => !c.promoted_to)].filter(Boolean);
    groups.push(h('section', { class: 'stack-s' },
      h('h2', { class: 'panel-title' }, sheetName(sheet)),
      assetGrid(ctx, list, { all, masterOf: (s) => !!(data.sheets[s] && data.sheets[s].master) }),
      checkNotes(list)));
  }
  if (groups.length) nodes.push(h('div', { class: 'stack', id: 'sheets' }, groups));
  if (assets.references.length) {
    nodes.push(h('section', { class: 'stack-s' },
      h('h2', { class: 'panel-title' }, t('character.references_title')),
      h('p', { class: 'small muted' }, t('character.references_hint')),
      assetGrid(ctx, assets.references, { all })));
  }
  if (lookOk && (!draw.available || ctx.ui.manual)) {
    const choice = sheetChoice || selectField({
      label: t('character.sheet_kind'), value: kind,
      options: ['turnaround', 'expressions', 'wardrobe'].map((s) => ({ value: s, label: sheetName(s) })),
      onchange: (v) => { ctx.ui.sheet = v; ctx.refresh(); },
    });
    const handKind = kind === 'model' ? 'turnaround' : kind;
    nodes.push(panel(t('handoff.title'), canDraw ? null : choice.el, handoff(ctx, `char:${handKind}`, { entity: data.id, sheet: handKind })));
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
      chat: { key: data.chat_key, title: t('chat.title_about', { name: data.name }), examples: [t('character.example_1'), t('character.example_2')] },
    }));
}
