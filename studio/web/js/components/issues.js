// The issues of the series: a picker that the Pages, Check, Corrections,
// Cover and Publish screens follow, and "New issue", which starts the next
// one from where the last one ended. The look, the characters, the places
// and the story bible are the project's, so the new issue uses them as they
// are.

import { h } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { api, errorText } from '/js/api.js';
import { state, refreshOverview } from '/js/store.js';
import { button, textField, notice } from '/js/components/ui.js';
import { openDialog } from '/js/components/dialog.js';
import { toast } from '/js/components/toast.js';

/** The issue a screen shows: ?issue= when the link names one, else the one chosen last. */
export function currentIssue(ctx) {
  const asked = ctx.query.get('issue');
  const known = (state.overview && state.overview.issues) || [];
  if (asked && known.some((i) => i.id === asked)) state.issue = asked;
  const issue = state.issue || 'ISS_001';
  // The choice outlives a reload of the tab.
  try { sessionStorage.setItem(`studio.issue.${ctx.projectId}`, issue); } catch (err) { /* storage is off */ }
  return issue;
}

/** Ask for a title and a rough page count, create the next issue, and open its Pages screen. */
export function openNewIssue(ctx) {
  const title = textField({ label: t('issues.title_label'), required: true, maxlength: 120 });
  const pages = textField({ label: t('issues.pages_label'), type: 'number', min: 1, max: 200, value: '4' });
  const problem = h('div');
  let busy = false;
  const dialog = openDialog({
    title: t('issues.new_title'),
    body: h('form', { class: 'stack-s', onsubmit: (e) => { e.preventDefault(); create(); } },
      h('p', { class: 'muted' }, t('issues.new_body')), title.el, pages.el, problem),
    actions: [
      button(t('action.cancel'), { kind: 'quiet', onclick: () => dialog.close() }),
      button(t('issues.create'), { kind: 'primary', onclick: () => create() }),
    ],
  });
  title.input.focus();
  async function create() {
    if (busy) return;
    problem.replaceChildren();
    const name = title.value.trim();
    const n = Number(pages.value || 4);
    if (!name) {
      problem.append(notice('bad', t('issues.title_needed')));
      title.input.focus();
      return;
    }
    busy = true;
    try {
      const res = await api.createIssue(ctx.projectId, { title: name, pages: Number.isInteger(n) ? n : 4 });
      await refreshOverview();
      state.issue = res.issue;
      dialog.close();
      toast(t('issues.created', { n: res.number }), { kind: 'ok' });
      ctx.navigate(`/p/${encodeURIComponent(ctx.projectId)}/pages?issue=${encodeURIComponent(res.issue)}`);
    } catch (err) {
      problem.append(notice('bad', errorText(err)));
    } finally {
      busy = false;
    }
  }
}

/** The issue picker with "New issue" beside it. Choosing an issue reloads the screen on it. */
export function issueBar(ctx, current) {
  const issues = (state.overview && state.overview.issues) || [];
  const id = `issue-pick-${Math.random().toString(36).slice(2, 7)}`;
  const select = h('select', {
    id,
    onchange: (e) => {
      state.issue = e.target.value;
      ctx.navigate(`${location.pathname}?issue=${encodeURIComponent(e.target.value)}`);
    },
  }, issues.map((i) => h('option', { value: i.id, selected: i.id === current }, `${i.number}. ${i.title}`)));
  return h('div', { class: 'issue-bar' },
    h('div', { class: 'field inline' }, h('label', { for: id }, t('issues.pick')), select),
    button(t('issues.new'), { kind: 'quiet', small: true, icon: 'plus', onclick: () => openNewIssue(ctx) }));
}
