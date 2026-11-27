// A character, place or object: merge it into another one that is the same,
// give it another ID, or delete it (TODO items 11 and 13). The server
// rewrites every reference and runs the workspace checks; History can undo
// each of these.

import { h } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { api, errorText } from '/js/api.js';
import { button } from '/js/components/ui.js';
import { confirmDialog } from '/js/components/dialog.js';
import { deleteFlow } from '/js/components/deleting.js';
import { toast } from '/js/components/toast.js';
import { markSeen } from '/js/unseen.js';

/** The news about an ID that no longer exists is seen: it was merged away or renamed. */
function forget(id) {
  const kind = id.startsWith('CHAR_') ? 'character' : id.startsWith('LOC_') ? 'location' : 'prop';
  markSeen(`${kind}:${id}`);
}

/** "CHAR_GREY_MAN" from what the person typed: "grey man", "CHAR_GREY_MAN". */
export function idFrom(prefix, text) {
  const token = String(text || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(new RegExp(`^${prefix}_`), '').replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  if (!token) return '';
  return `${prefix}_${/^[A-Z]/.test(token) ? token : `X_${token}`}`;
}

function routeOf(ctx, id) {
  const base = `/p/${encodeURIComponent(ctx.projectId)}`;
  if (id.startsWith('CHAR_')) return `${base}/characters/${id}`;
  return `${base}/places/${id.startsWith('LOC_') ? 'location' : 'prop'}/${id}`;
}

function listRoute(ctx, id) {
  const base = `/p/${encodeURIComponent(ctx.projectId)}`;
  return id.startsWith('CHAR_') ? `${base}/characters` : `${base}/places`;
}

function checkLine(result) {
  return result && result.check && !result.check.ok ? t('entity.check_broken', { n: result.check.new_errors.length }) : '';
}

/** Merge `from` into `into`, after asking. */
export async function mergeInto(ctx, from, into, { fromName, intoName, adopt = false } = {}) {
  // adopt: the one to keep has no file yet (only the story names it): the file of "from" takes its ID.
  const words = { from: fromName || from, into: intoName || into, id: into };
  const done = await confirmDialog({
    title: t(adopt ? 'entity.adopt_title' : 'entity.merge_title', words),
    body: h('div', { class: 'stack-s' }, h('p', null, t(adopt ? 'entity.adopt_body' : 'entity.merge_body', words)), h('p', { class: 'small' }, t('delete.undo_history'))),
    confirm: t(adopt ? 'entity.adopt_confirm' : 'entity.merge_confirm'),
    run: () => api.mergeEntity(ctx.projectId, from, into),
  });
  if (!done) return null;
  const warn = checkLine(done.result);
  forget(from);
  toast(warn || (adopt ? t('entity.renamed', { to: into }) : t('entity.merged', { into: intoName || into })), { kind: warn ? 'warn' : 'ok' });
  ctx.navigate(routeOf(ctx, into));
  return done.result;
}

/** Rename an ID, after asking for the new one. */
export async function renameEntity(ctx, from, { suggestion = '' } = {}) {
  const prefix = from.split('_')[0];
  const done = await confirmDialog({
    title: t('entity.rename_title', { id: from }),
    body: h('p', null, t('entity.rename_body')),
    note: { label: t('entity.rename_label'), hint: t('entity.rename_hint', { prefix }), required: true, value: suggestion },
    confirm: t('entity.rename_confirm'),
    run: (value) => {
      const to = idFrom(prefix, value.note);
      if (!to || to === from) throw new Error(t('entity.rename_same'));
      return api.renameEntity(ctx.projectId, from, to);
    },
  });
  if (!done) return null;
  const warn = checkLine(done.result);
  forget(from);
  toast(warn || t('entity.renamed', { to: done.result.to }), { kind: warn ? 'warn' : 'ok' });
  ctx.navigate(routeOf(ctx, done.result.to));
  return done.result;
}

/**
 * The tools panel of an entity screen: merge into another one, rename, delete.
 * @param {{id: string, name: string, others: () => Promise<{id, name}[]>}} entity
 */
export function entityTools(ctx, { id, name, others }) {
  const merge = button(t('entity.merge_action'), {
    kind: 'quiet', small: true,
    onclick: async () => {
      let list = [];
      try {
        list = (await others()).filter((o) => o.id !== id);
      } catch (err) {
        toast(errorText(err), { kind: 'bad' });
        return;
      }
      if (!list.length) {
        toast(t('entity.merge_none'), { kind: 'info' });
        return;
      }
      const select = h('select', { id: 'merge-into' }, list.map((o) => h('option', { value: o.id }, `${o.name} (${o.id})`)));
      const done = await confirmDialog({
        title: t('entity.merge_pick_title', { name }),
        body: h('div', { class: 'stack-s' },
          h('p', null, t('entity.merge_pick_body', { name })),
          h('div', { class: 'field' }, h('label', { for: 'merge-into' }, t('entity.merge_pick_label')), select),
          h('p', { class: 'small' }, t('delete.undo_history'))),
        confirm: t('entity.merge_confirm'),
        run: () => api.mergeEntity(ctx.projectId, id, select.value),
      });
      if (!done) return;
      forget(id);
      const target = list.find((o) => o.id === select.value);
      const warn = checkLine(done.result);
      toast(warn || t('entity.merged', { into: target ? target.name : select.value }), { kind: warn ? 'warn' : 'ok' });
      ctx.navigate(routeOf(ctx, select.value));
    },
  });
  const rename = button(t('entity.rename_action'), { kind: 'quiet', small: true, onclick: () => renameEntity(ctx, id) });
  const remove = button(t('entity.delete_action'), {
    kind: 'quiet', small: true, icon: 'trash',
    onclick: async () => {
      const result = await deleteFlow(ctx, [{ kind: 'entity', id }]);
      if (result) {
        forget(id);
        ctx.navigate(listRoute(ctx, id));
      }
    },
  });
  return h('section', { class: 'panel stack-s entity-tools' },
    h('h2', { class: 'panel-title' }, t('entity.tools_title')),
    h('p', { class: 'small muted' }, t('entity.tools_intro', { id })),
    h('div', { class: 'row' }, merge, rename, remove));
}
