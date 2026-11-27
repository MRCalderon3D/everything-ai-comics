// Deleting what the person does not want to keep (TODO item 13): a delete
// control for one thing or several, and "Clean up unused tries" for a
// screen. The server says what a delete removes, or why it refuses
// (POST .../delete/check); the confirmation says it, says it can be brought
// back from History, and asks a second time when something depends on it
// (an approved master, a whole character, a drawn page).

import { h } from '/js/dom.js';
import { t, tn } from '/js/i18n.js';
import { api, errorText } from '/js/api.js';
import { button } from '/js/components/ui.js';
import { openDialog, confirmDialog } from '/js/components/dialog.js';
import { toast } from '/js/components/toast.js';
import { sheetName } from '/js/components/assets.js';
import { pageName, versionName } from '/js/labels.js';

/** What a thing to delete is called on the screens: "Mara: Turnaround, version 2", "Page 3, version 2". */
function labelOf(i) {
  const v = i.version ? t('version.n', { n: i.version }) : '';
  if (i.kind === 'asset') return `${i.label}: ${i.sheet === 'reference' ? t('asset.reference') : sheetName(i.sheet || 'sheet')} ${v}`.trim();
  if (i.kind === 'render') return /^CV_/.test(String(i.owner || i.id)) ? `${t('cover.name')}, ${versionName(i.id)}` : `${pageName(i.owner)}, ${versionName(i.id)}`;
  if (i.kind === 'page') return pageName(i.id);
  return i.label;
}

function thumb(item) {
  return item.image && item.image.url ? h('img', { class: 'delete-thumb', src: item.image.url, alt: '' }) : null;
}

function refusedDialog(items) {
  const refused = items.filter((i) => !i.deletable);
  const dialog = openDialog({
    title: tn('delete.refused_title', refused.length),
    body: h('ul', { class: 'delete-list' }, refused.map((i) => h('li', null, thumb(i),
      h('div', null, h('strong', null, labelOf(i)), h('p', { class: 'small' }, i.refused ? i.refused.message : ''))))),
    actions: [h('button', { type: 'button', class: 'btn primary', onclick: () => dialog.close() }, t('action.close'))],
  });
}

function itemList(items) {
  return h('ul', { class: 'delete-list' }, items.map((i) => h('li', null, thumb(i),
    h('div', null,
      h('strong', null, labelOf(i)),
      (i.notes || []).map((n) => h('p', { class: 'small muted' }, n)),
      (i.dependents || []).map((d) => h('p', { class: 'small action-warn' }, d))))));
}

/**
 * Delete one thing or several, after asking. Resolves to the server's answer,
 * or null when the person backs out or the server refuses.
 * @param {object} ctx screen context (refreshed after the delete)
 * @param {{kind?: string, id: string}[]} items
 */
export async function deleteFlow(ctx, items) {
  let plans;
  try {
    plans = (await api.deleteCheck(ctx.projectId, items)).items;
  } catch (err) {
    toast(errorText(err), { kind: 'bad' });
    return null;
  }
  if (plans.some((p) => !p.deletable)) {
    refusedDialog(plans);
    return null;
  }
  const undoable = plans.every((p) => p.undo === 'history');
  const twice = plans.filter((p) => p.confirm_twice);
  const first = await confirmDialog({
    title: plans.length === 1 ? t('delete.confirm_title_one', { what: labelOf(plans[0]) }) : tn('delete.confirm_title_many', plans.length),
    body: h('div', { class: 'stack-s' }, itemList(plans),
      h('p', null, undoable ? t('delete.undo_history') : t('delete.undo_none'))),
    confirm: twice.length ? t('delete.next') : t('delete.confirm'),
    danger: !twice.length,
    run: twice.length ? null : () => api.deleteItems(ctx.projectId, items),
  });
  if (!first) return null;
  let result = first.result;
  if (twice.length) {
    const second = await confirmDialog({
      title: t('delete.twice_title'),
      body: h('div', { class: 'stack-s' },
        h('p', null, t('delete.twice_body')),
        itemList(twice),
        h('p', null, t('delete.undo_history'))),
      check: { label: t('delete.twice_check') },
      confirm: t('delete.confirm'),
      danger: true,
      run: () => api.deleteItems(ctx.projectId, items, true),
    });
    if (!second) return null;
    result = second.result;
  }
  if (result) {
    const ok = !result.check || result.check.ok;
    toast(ok ? tn('delete.done', result.deleted.length) : t('delete.done_broken', { n: result.check.new_errors.length }), {
      kind: ok ? 'ok' : 'warn',
      link: undoable && result.commit ? { href: `/p/${encodeURIComponent(ctx.projectId)}/history`, label: t('delete.open_history') } : undefined,
    });
    ctx.refresh();
  }
  return result;
}

/** A small delete button for one thing. */
export function deleteButton(ctx, item, { label, small = true, kind = 'quiet' } = {}) {
  return button(label || t('delete.action'), {
    kind, small, icon: 'trash', title: t('delete.action_title'),
    onclick: () => deleteFlow(ctx, [item]),
  });
}

/** "Clean up unused tries" of a screen: every unused try, chosen in one list, deleted in one step. */
export function cleanupButton(ctx, scope, { label } = {}) {
  return button(label || t('cleanup.action'), {
    kind: 'quiet', small: true, icon: 'trash',
    onclick: async () => {
      let items;
      try {
        items = (await api.cleanup(ctx.projectId, scope)).items;
      } catch (err) {
        toast(errorText(err), { kind: 'bad' });
        return;
      }
      if (!items.length) {
        toast(t('cleanup.nothing'), { kind: 'ok' });
        return;
      }
      const chosen = new Set(items.map((i) => i.id));
      const list = h('ul', { class: 'delete-list cleanup-list' }, items.map((i) => {
        const box = h('input', { type: 'checkbox', checked: true, id: `cl-${i.id}` });
        box.addEventListener('change', () => { if (box.checked) chosen.add(i.id); else chosen.delete(i.id); });
        return h('li', null, h('div', { class: 'check' }, box, h('label', { for: `cl-${i.id}` }, thumb(i),
          h('span', null, h('strong', null, labelOf(i)), ' ', h('span', { class: 'small muted' }, i.reason)))));
      }));
      await confirmDialog({
        title: tn('cleanup.title', items.length),
        body: h('div', { class: 'stack-s' }, h('p', null, t('cleanup.body')), list, h('p', { class: 'small' }, t('delete.undo_history'))),
        confirm: t('cleanup.confirm'),
        danger: true,
        run: async () => {
          const picked = items.filter((i) => chosen.has(i.id)).map((i) => ({ kind: i.kind, id: i.id }));
          if (!picked.length) throw new Error(t('cleanup.none_chosen'));
          const res = await api.deleteItems(ctx.projectId, picked);
          toast(tn('delete.done', res.deleted.length), {
            kind: 'ok', link: res.commit ? { href: `/p/${encodeURIComponent(ctx.projectId)}/history`, label: t('delete.open_history') } : undefined,
          });
          ctx.refresh();
          return res;
        },
      });
    },
  });
}
