// Reference images of a look, a character, a place or an object: the approved
// master, the candidates waiting for a decision, and what the person uploaded.
// Approving a candidate is the person's call and is said plainly.

import { h } from '/js/dom.js';
import { t, tn, tv, formatDate } from '/js/i18n.js';
import { api } from '/js/api.js';
import { frame, openViewer } from '/js/components/viewer.js';
import { actionButton } from '/js/components/ui.js';
import { confirmDialog } from '/js/components/dialog.js';
import { toast } from '/js/components/toast.js';
import { deleteButton } from '/js/components/deleting.js';

export function sheetName(sheet) {
  return tv('sheet', sheet, sheet);
}

function assetLabel(asset) {
  const kind = asset.sheet === 'reference' ? t('asset.reference') : sheetName(asset.sheet);
  const state = asset.status === 'candidate' ? t('asset.candidate') : tv('asset_status', asset.status, asset.status);
  return `${kind} ${t('version.n', { n: asset.version })} (${state})`;
}

export function viewerItems(assets) {
  return assets.filter((a) => a && a.image).map((a) => ({
    id: a.id, label: assetLabel(a), image: a.image, alt: assetLabel(a),
    short: `${a.sheet === 'reference' ? t('asset.reference') : sheetName(a.sheet)} ${a.version}`,
    note: a.generation && a.generation.supplied_by_person ? t('asset.supplied') : '',
  }));
}

/**
 * Approve a candidate as the master of its sheet.
 *   isLook     approving a look freezes the style
 *   hasMaster  a master of the same sheet exists and would be replaced
 */
export async function approveAsset(ctx, candidate, { isLook, hasMaster } = {}) {
  const result = await confirmDialog({
    title: isLook ? t('approve.look_title') : (hasMaster ? t('approve.replace_title') : t('approve.sheet_title')),
    body: h('div', { class: 'stack-s' },
      candidate.image ? h('img', { class: 'confirm-art', src: candidate.image.url, alt: assetLabel(candidate) }) : null,
      h('p', null, isLook ? t('approve.look_body') : (hasMaster ? t('approve.replace_body') : t('approve.sheet_body')))),
    note: { label: t('approve.note_label'), hint: t('approve.note_hint') },
    confirm: isLook ? t('approve.look_confirm') : (hasMaster ? t('approve.replace_confirm') : t('approve.sheet_confirm')),
    run: (value) => api.approveAsset(ctx.projectId, { candidate: candidate.id, note: value.note || undefined, supersede: hasMaster ? true : undefined }),
  });
  if (!result) return false;
  // Characters added before the look was approved have no sheet yet: offer to draw them.
  let missing = 0;
  if (isLook) {
    try {
      const cast = await api.characters(ctx.projectId);
      missing = cast.characters.filter((c) => !c.has_master && !c.candidates).length;
    } catch (err) {
      missing = 0;
    }
  }
  if (missing) {
    toast(tn('approve.look_done_sheets', missing), {
      kind: 'ok', link: { href: `/p/${encodeURIComponent(ctx.projectId)}/characters`, label: t('approve.look_draw_sheets') },
    });
  } else {
    toast(isLook ? t('approve.look_done') : t('approve.sheet_done'), { kind: 'ok' });
  }
  ctx.refresh();
  return true;
}

/**
 * A grid of assets. Each candidate that is not yet a master gets an
 * "approve" button. `masterOf(sheet)` says whether that sheet has a master.
 */
export function assetGrid(ctx, assets, { all, isLook, masterOf, emptyText, canApprove = true, canDelete = true } = {}) {
  if (!assets.length) return emptyText ? h('p', { class: 'muted' }, emptyText) : h('div');
  const items = viewerItems(all || assets);
  return h('div', { class: 'asset-grid' }, assets.map((a) => {
    const open = () => openViewer(items, a.id);
    const pending = a.status === 'candidate' && !a.promoted_to;
    return h('div', { class: 'asset', dataset: { status: a.status } },
      frame(a.image, { alt: assetLabel(a), onclick: open }),
      h('div', { class: 'asset-meta' },
        h('strong', null, a.sheet === 'reference' ? t('asset.reference') : sheetName(a.sheet), ' ', t('version.n', { n: a.version })),
        h('span', { class: `asset-state ${a.status}` },
          a.status === 'candidate'
            ? (a.promoted_to ? t('asset.promoted') : t('asset.candidate'))
            : tv('asset_status', a.status, a.status)),
        a.approved_at && a.status === 'approved' ? h('span', { class: 'small faint' }, t('asset.approved_on', { date: formatDate(a.approved_at) })) : null,
        a.generation && a.generation.supplied_by_person ? h('span', { class: 'small faint' }, t('asset.supplied')) : null),
      h('div', { class: 'row asset-actions' },
        pending && canApprove
          ? actionButton(isLook ? t('approve.look_action') : t('approve.sheet_action'),
            () => approveAsset(ctx, a, { isLook, hasMaster: masterOf ? masterOf(a.sheet) : false }),
            { small: true, kind: 'primary' })
          : null,
        // The server says whether it can go: an approved master that pages were drawn from stays.
        canDelete && !a.promoted_to ? deleteButton(ctx, { kind: 'asset', id: a.id }) : null));
  }));
}
