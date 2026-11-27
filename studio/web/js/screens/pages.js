// The pages of an issue: write what happens, read and approve the plan of
// each page, start the drawing for some or all of them, and watch the queue.
// The findings of the mechanical checks are always on screen.

import { h, nextId, icon } from '/js/dom.js';
import { t, tn } from '/js/i18n.js';
import { api } from '/js/api.js';
import { state, findJob } from '/js/store.js';
import { screenHead, bench } from '/js/components/bench.js';
import { panel, actionButton, button, textField, notice, emptyState, disclosure, caption } from '/js/components/ui.js';
import { docEditor, continuityList } from '/js/components/editor.js';
import { queueOp } from '/js/components/ask.js';
import { jobsFor, liveNode, pageQueueState } from '/js/components/jobs.js';
import { frame } from '/js/components/viewer.js';
import { verdictChip } from '/js/components/verdict.js';
import { confirmDialog } from '/js/components/dialog.js';
import { noDrawTool } from '/js/components/handoff.js';
import { toast } from '/js/components/toast.js';
import { pageName } from '/js/labels.js';
import { blockerText } from '/js/screens/home.js';
import { currentIssue, issueBar } from '/js/components/issues.js';
import { newsBar, newsMark } from '/js/components/news.js';
import { deleteButton, cleanupButton } from '/js/components/deleting.js';
import { mergeInto, renameEntity } from '/js/components/entity-tools.js';

export async function load(ctx) {
  return api.issue(ctx.projectId, currentIssue(ctx));
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
    h('p', { class: 'small' }, mech.note || t('mech.note')));
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
  // Batch drawing says how many images it draws, so the person can weigh it against their plan.
  const asked = passing.length || unapproved.length;
  if (pages.length > 1 && !asked) {
    const ok = await confirmDialog({
      title: t('pages.batch_title'),
      body: h('div', { class: 'stack-s' }, h('p', null, tn('pages.batch_body', pages.length)), h('p', { class: 'muted' }, t('pages.draw_time', { n: pages.length }))),
      confirm: tn('pages.batch_confirm', pages.length),
    });
    if (!ok) return null;
  }
  if (passing.length) {
    const ok = await confirmDialog({
      title: t('pages.redraw_title'),
      body: h('div', { class: 'stack-s' }, h('p', null, tn('pages.redraw_body', passing.length, { pages: passing.map(pageName).join(', ') })),
        pages.length > 1 ? h('p', null, tn('pages.batch_body', pages.length)) : null),
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
        pages.length > 1 ? h('p', null, tn('pages.batch_body', pages.length)) : null,
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

/** What the last planning filled in that the person's text did not say, per page. */
function plannedAssumptions(ctx, data) {
  const job = findJob((j) => j.op === 'pages.plan' && j.status === 'done' && j.result && Array.isArray(j.result.assumptions) && j.result.assumptions.length
    && (!j.params || !j.params.issue || j.params.issue === data.id));
  if (!job) return null;
  const base = `/p/${encodeURIComponent(ctx.projectId)}`;
  const byPage = new Map();
  for (const a of job.result.assumptions) {
    if (!byPage.has(a.page)) byPage.set(a.page, []);
    byPage.get(a.page).push(a);
  }
  return h('section', { class: 'panel' },
    h('h2', { class: 'panel-title' }, tn('assume.title', job.result.assumptions.length)),
    h('p', { class: 'muted small' }, t('assume.intro_pages')),
    h('ul', { class: 'assumptions' }, [...byPage].map(([page, list]) => h('li', { class: 'assumption' },
      h('span', { class: 'assumption-where' }, pageName(page)),
      h('ul', { class: 'bullets small' }, list.map((a) => h('li', null, a.text))),
      h('a', { class: 'small', href: `${base}/pages/${page}` }, t('assume.open_page', { name: pageName(page) }))))));
}

/**
 * While the plan of this issue is being written its checks would report
 * pages that do not exist yet: the screen says how far the plan is instead,
 * and looks again every few seconds.
 */
export function planningBox(ctx, planning) {
  if (!ctx.ui.planTimer) {
    ctx.ui.planTimer = setInterval(() => ctx.refresh(), 4000);
  }
  ctx.onCleanup(() => { clearInterval(ctx.ui.planTimer); ctx.ui.planTimer = null; });
  const line = planning.phase === 'pages' && planning.pages
    ? t('plan.progress_pages', { current: planning.current, total: planning.pages })
    : planning.phase === 'breakdown' ? t('plan.progress_breakdown') : t('plan.progress_checks');
  return notice('info', h('p', null, h('span', { class: 'pulse', 'aria-hidden': 'true' }), ' ', h('strong', null, line)),
    h('p', { class: 'small muted' }, planning.status === 'needs_decision' ? t('plan.progress_waiting') : t('plan.progress_checks_later')));
}

/** What the last plan added: characters, places and objects, each with what can be done about it. */
function addedPanel(ctx, data) {
  const added = data.added && Array.isArray(data.added.entities) ? data.added.entities : [];
  if (!added.length) return null;
  const base = `/p/${encodeURIComponent(ctx.projectId)}`;
  const linkOf = (e) => (e.kind === 'character' ? `${base}/characters/${e.id}` : `${base}/places/${e.kind}/${e.id}`);
  return h('section', { class: 'panel stack-s added-panel' },
    h('h2', { class: 'panel-title' }, tn('added.title', added.length)),
    h('p', { class: 'small muted' }, t('added.intro')),
    h('ul', { class: 'added-list' }, added.map((e) => h('li', { class: 'added-item', dataset: { exists: String(e.exists) } },
      h('div', { class: 'row spread' },
        h('span', null, h('span', { class: 'chip' }, t(`added.kind.${e.kind}`)), ' ',
          e.exists ? h('a', { href: linkOf(e) }, e.name) : h('span', { class: 'muted' }, e.name)),
        e.needs_sheet ? h('span', { class: 'chip warn' }, t('added.needs_sheet')) : null),
      (e.duplicates || []).length ? null : newsMark(`${e.kind}:${e.id}`),
      !e.exists ? h('p', { class: 'small muted' }, t('added.gone', { id: e.id })) : null,
      e.exists ? (e.duplicates || []).map((d) => h('div', { class: 'notice warn small added-dup' },
        h('p', null, t(`added.duplicate.${d.source}`, { name: e.name, other: d.name, id: d.id })),
        h('div', { class: 'row' },
          button(d.has_file ? t('added.merge', { other: d.name }) : t('added.use_id', { id: d.id }), {
            kind: 'primary', small: true, onclick: () => mergeInto(ctx, e.id, d.id, { fromName: e.name, intoName: d.name, adopt: !d.has_file }),
          })))) : null,
      e.exists ? h('div', { class: 'row' },
        h('a', { class: 'btn quiet small', href: linkOf(e) }, t('added.edit')),
        button(t('added.rename'), { kind: 'quiet', small: true, onclick: () => renameEntity(ctx, e.id) })) : null))));
}

export function view(ctx, data) {
  ctx.title = t('screen.pages');
  const base = `/p/${encodeURIComponent(ctx.projectId)}`;
  const pages = data.pages;
  const counts = data.counts;
  const selected = ctx.ui.selected || (ctx.ui.selected = new Set());
  for (const id of [...selected]) if (!pages.some((p) => p.id === id)) selected.delete(id);
  const overruled = pages.filter((p) => p.overruled).length;
  const lastId = pages.length ? pages.map((p) => p.id).sort().pop() : null;

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
          h('h3', null, h('a', { href: `${base}/pages/${p.id}` }, pageName(p.id)), ' ', newsMark(`page:${p.id}`, { short: true })),
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
        // More reference images than the drawing tool takes: what to do is on the page itself.
        p.budget && p.budget.length
          ? h('p', { class: 'small action-warn' }, icon('alert'), ' ', h('a', { href: `${base}/pages/${p.id}` }, t('budget.on_page')))
          : null,
        h('div', { class: 'row page-links' },
          h('a', { href: `${base}/pages/${p.id}` }, t('pages.link_plan')),
          p.current_render ? h('a', { href: `${base}/check/${p.id}` }, t('pages.link_check')) : null,
          p.current_render ? h('a', { href: `${base}/corrections/${p.id}` }, t('pages.link_correct')) : null,
          // Only the last page can go: page numbers stay without gaps.
          p.id === lastId ? deleteButton(ctx, { kind: 'page', id: p.id }, { label: t('pages.delete_last') }) : null)));
  };

  const text = h('div', { class: 'stack' },
    newsBar('pages'),
    jobsFor((j) => j.op === 'pages.plan' || j.op === 'pages.generate'),
    addedPanel(ctx, data),
    plannedAssumptions(ctx, data),
    issueBar(ctx, data.id),
    panel(pages.length ? t('pages.more_title') : t('pages.first_title'), planForm(ctx, data)),
    panel(t('mech.title'), data.planning ? planningBox(ctx, data.planning) : mechanicalBox(data.mechanical)),
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
      actions: pages.length ? [cleanupButton(ctx, `pages:${data.id}`)] : null,
    }),
    bench(ctx, { text, images, chat: { key: data.chat_key, examples: [t('pages.example_1'), t('pages.example_2')] } }));
}
