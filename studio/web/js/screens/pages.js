// The pages of an issue: write what happens, read and approve the plan of
// each page, start the drawing for some or all of them, and watch the queue.
// The findings of the mechanical checks are always on screen.

import { h, nextId } from '/js/dom.js';
import { t, tn } from '/js/i18n.js';
import { api } from '/js/api.js';
import { state } from '/js/store.js';
import { screenHead, bench } from '/js/components/bench.js';
import { panel, actionButton, button, textField, notice, emptyState, disclosure, caption } from '/js/components/ui.js';
import { docEditor, continuityList } from '/js/components/editor.js';
import { queueOp } from '/js/components/ask.js';
import { jobsFor, liveNode, pageQueueState } from '/js/components/jobs.js';
import { frame } from '/js/components/viewer.js';
import { verdictChip, markOverrules } from '/js/components/verdict.js';
import { confirmDialog } from '/js/components/dialog.js';
import { noDrawTool } from '/js/components/handoff.js';
import { toast } from '/js/components/toast.js';
import { pageName } from '/js/labels.js';
import { blockerText } from '/js/screens/home.js';

export async function load(ctx) {
  const issue = ctx.query.get('issue') || state.issue || 'ISS_001';
  state.issue = issue;
  return markOverrules(ctx.projectId, await api.issue(ctx.projectId, issue));
}

/** The findings of the mechanical checks of an issue or a page. Errors are always shown. */
export function mechanicalBox(mech, { quietWhenClean = true } = {}) {
  const continuity = mech.continuity || [];
  const validation = mech.validation || { errors: [], warnings: [] };
  const errors = continuity.filter((f) => f.severity !== 'warning').length + validation.errors.length;
  const warnings = continuity.filter((f) => f.severity === 'warning').length + validation.warnings.length;
  if (!errors && !warnings) {
    return quietWhenClean
      ? h('p', { class: 'mech-clean small muted' }, t('mech.clean'))
      : notice('info', t('mech.clean'));
  }
  const fileItem = (f, word) => h('li', null, h('strong', null, word), ' ', f.file ? h('code', null, f.file) : null, ' ', f.message);
  return notice(errors ? 'bad' : 'warn',
    h('p', null, h('strong', null, errors ? tn('mech.errors', errors) : tn('mech.warnings', warnings))),
    continuityList(continuity),
    validation.errors.length || validation.warnings.length
      ? h('ul', { class: 'findings' },
        validation.errors.map((f) => fileItem(f, t('mech.error'))),
        validation.warnings.map((f) => fileItem(f, t('mech.warning'))))
      : null,
    h('p', { class: 'small' }, t('mech.note')));
}

export function queueLine(pageId) {
  return liveNode(() => {
    const q = pageQueueState(pageId);
    if (!q) return null;
    return h('span', { class: `queue-state ${q.state}` },
      q.state === 'waiting' ? null : h('span', { class: 'pulse', 'aria-hidden': 'true' }),
      t(`queue.${q.state}`));
  });
}

/** Ask for the approvals a drawing needs, then start it. */
export async function drawPages(ctx, pages, { unapproved = [], passing = [] } = {}) {
  const params = { pages };
  if (passing.length) {
    const ok = await confirmDialog({
      title: t('pages.redraw_title'),
      body: tn('pages.redraw_body', passing.length, { pages: passing.map(pageName).join(', ') }),
      confirm: t('pages.redraw_confirm'),
    });
    if (!ok) return null;
    params.regenerate = true;
  }
  if (unapproved.length) {
    const ok = await confirmDialog({
      title: t('pages.approve_and_draw_title'),
      body: h('div', { class: 'stack-s' },
        h('p', null, tn('pages.approve_and_draw_body', unapproved.length, { pages: unapproved.map(pageName).join(', ') })),
        h('p', { class: 'muted' }, t('pages.draw_time', { n: pages.length }))),
      confirm: t('pages.approve_and_draw_confirm'),
    });
    if (!ok) return null;
    params.approve_plans = true;
  }
  return queueOp('pages.generate', params);
}

function planForm(ctx, data) {
  const text = textField({
    label: t('pages.what_happens'), multiline: true, rows: 6, draft: ctx.draft('what'),
    placeholder: t('pages.what_placeholder'), hint: t('pages.what_hint'),
  });
  const count = textField({ label: t('pages.how_many'), type: 'number', min: 1, max: 24, value: '1', draft: ctx.draft('count'), hint: t('pages.how_many_hint') });
  const go = async () => {
    const what = text.value.trim();
    const n = Number(count.value || 1);
    if (!what) {
      text.input.focus();
      toast(t('form.write_first'), { kind: 'warn' });
      return;
    }
    if (!Number.isInteger(n) || n < 1 || n > 24) {
      count.input.focus();
      toast(t('pages.bad_count'), { kind: 'warn' });
      return;
    }
    await queueOp('pages.plan', { text: what, pages: n, issue: data.id });
    text.clear();
    count.clear();
  };
  return h('form', { class: 'stack-s', onsubmit: (e) => e.preventDefault() },
    text.el, count.el,
    h('div', { class: 'row' }, actionButton(t('pages.plan_action'), go, { kind: data.pages.length ? '' : 'primary' }),
      h('span', { class: 'small muted' }, t('pages.plan_time'))));
}

export function view(ctx, data) {
  ctx.title = t('screen.pages');
  const base = `/p/${encodeURIComponent(ctx.projectId)}`;
  const pages = data.pages;
  const counts = data.counts;
  const selected = ctx.ui.selected || (ctx.ui.selected = new Set());
  for (const id of [...selected]) if (!pages.some((p) => p.id === id)) selected.delete(id);
  const issues = state.overview.issues || [];
  const overruled = pages.filter((p) => p.overruled).length;

  const toolbar = h('div', { class: 'pages-toolbar' });
  const paintToolbar = () => {
    const chosen = pages.filter((p) => selected.has(p.id));
    const missing = pages.filter((p) => !p.passes);
    const target = chosen.length ? chosen : missing;
    const unapproved = target.filter((p) => !p.plan_approved);
    const toApprove = (chosen.length ? chosen : pages).filter((p) => !p.plan_approved);
    const nodes = [];
    if (toApprove.length) {
      nodes.push(actionButton(
        chosen.length ? tn('pages.approve_selected', toApprove.length) : tn('pages.approve_all', toApprove.length),
        async () => {
          await api.approvePlan(ctx.projectId, toApprove.map((p) => p.id));
          toast(tn('pages.plans_approved', toApprove.length), { kind: 'ok' });
          ctx.refresh();
        }, { kind: unapproved.length && data.draw.available ? '' : 'primary' }));
    }
    if (data.draw.available && target.length) {
      nodes.push(actionButton(
        chosen.length ? tn('pages.draw_selected', chosen.length) : tn('pages.draw_missing', missing.length),
        () => drawPages(ctx, target.map((p) => p.id), {
          unapproved: unapproved.map((p) => p.id),
          passing: chosen.filter((p) => p.passes).map((p) => p.id),
        }), { kind: 'primary' }));
      nodes.push(h('span', { class: 'small muted' }, t('pages.draw_time', { n: target.length })));
    }
    if (chosen.length) {
      nodes.push(button(t('pages.clear_selection'), { kind: 'quiet', small: true, onclick: () => { selected.clear(); ctx.refresh(); } }));
    }
    toolbar.replaceChildren(...nodes);
  };

  const pageCard = (p) => {
    const id = nextId('pg');
    const box = h('input', { type: 'checkbox', id, checked: selected.has(p.id) });
    box.addEventListener('change', () => {
      if (box.checked) selected.add(p.id); else selected.delete(p.id);
      paintToolbar();
    });
    return h('li', { class: 'page-card', dataset: { status: p.status } },
      h('a', { class: 'page-art', href: `${base}/pages/${p.id}`, 'aria-label': t('pages.open', { name: pageName(p.id) }) },
        frame(p.image, { alt: t('pages.render_alt', { name: pageName(p.id) }), placeholder: t('pages.not_drawn') })),
      h('div', { class: 'page-info' },
        h('div', { class: 'row spread' },
          h('h3', null, h('a', { href: `${base}/pages/${p.id}` }, pageName(p.id))),
          h('span', { class: 'check inline' }, box, h('label', { for: id }, t('pages.select')))),
        h('p', { class: 'page-purpose clamp' }, p.purpose),
        h('p', { class: 'small faint' }, tn('pages.panels', p.panels || 0),
          p.renders > 1 ? `, ${tn('pages.versions', p.renders)}` : ''),
        h('p', { class: `small ${p.plan_approved ? 'state-ok' : 'state-wait'}` }, p.plan_approved ? t('pages.plan_approved') : t('pages.plan_not_approved')),
        queueLine(p.id),
        p.current_render ? h('p', null, verdictChip(p)) : null,
        p.blockers && p.blockers.length
          ? h('ul', { class: 'blockers small' }, p.blockers.map((b) => h('li', null, blockerText(b))))
          : null,
        h('div', { class: 'row page-links' },
          h('a', { href: `${base}/pages/${p.id}` }, t('pages.link_plan')),
          p.current_render ? h('a', { href: `${base}/check/${p.id}` }, t('pages.link_check')) : null,
          p.current_render ? h('a', { href: `${base}/corrections/${p.id}` }, t('pages.link_correct')) : null)));
  };

  const text = h('div', { class: 'stack' },
    jobsFor((j) => j.op === 'pages.plan' || j.op === 'pages.generate'),
    issues.length > 1 ? h('div', { class: 'field' },
      h('label', { for: 'issue-pick' }, t('pages.issue')),
      h('select', { id: 'issue-pick', onchange: (e) => { state.issue = e.target.value; ctx.refresh(); } },
        issues.map((i) => h('option', { value: i.id, selected: i.id === data.id }, `${i.number}. ${i.title}`)))) : null,
    panel(pages.length ? t('pages.more_title') : t('pages.first_title'), planForm(ctx, data)),
    panel(t('mech.title'), mechanicalBox(data.mechanical)),
    disclosure(ctx, 'issue-file', t('pages.advanced_issue'), () => docEditor(ctx, data.issue, { key: 'issue', title: t('pages.issue_file') })));

  let images;
  if (!pages.length) {
    images = emptyState(t('pages.empty_title'), t('pages.empty_body'));
  } else {
    const missing = pages.filter((p) => !p.passes).length;
    images = h('div', { class: 'stack' },
      !data.draw.look_approved ? notice('warn', t('pages.look_first'), ' ', h('a', { href: `${base}/style` }, t('screen.style')))
        : (!data.draw.available ? noDrawTool(t('pages.no_draw_tool')) : null),
      missing && data.draw.available && data.draw.look_approved && counts.plan_approved < counts.pages
        ? caption(h('p', { class: 'caption-text' }, t('pages.read_then_draw'))) : null,
      toolbar,
      h('ul', { class: 'page-grid' }, pages.map(pageCard)));
    paintToolbar();
  }

  return h('div', { class: 'screen' },
    screenHead({
      title: t('screen.pages'),
      lede: pages.length
        ? t('pages.lede', { pages: counts.pages, approved: counts.plan_approved, drawn: counts.rendered, passed: counts.passed - overruled, flagged: counts.flagged })
          + (overruled ? ` ${tn('pages.lede_overruled', overruled)}` : '')
        : t('pages.lede_empty', { budget: counts.planned_budget || 0 }),
    }),
    bench(ctx, { text, images, chat: { key: data.chat_key, examples: [t('pages.example_1'), t('pages.example_2')] } }));
}
