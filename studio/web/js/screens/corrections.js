// Corrections: open a page, mark where, write what to change, send. The new
// version shows beside the old one; accept it or ask again.

import { h } from '/js/dom.js';
import { t, tn } from '/js/i18n.js';
import { api } from '/js/api.js';
import { state } from '/js/store.js';
import { screenHead, bench } from '/js/components/bench.js';
import { panel, emptyState, notice } from '/js/components/ui.js';
import { queueOp } from '/js/components/ask.js';
import { jobsFor } from '/js/components/jobs.js';
import { correction, lastCorrection } from '/js/components/correction.js';
import { approveRender, verdictChip, markOverrules } from '/js/components/verdict.js';
import { pageName, versionName } from '/js/labels.js';
import { pageStrip } from '/js/screens/check.js';

export async function load(ctx) {
  const issueId = state.issue || 'ISS_001';
  const issue = await markOverrules(ctx.projectId, await api.issue(ctx.projectId, issueId));
  const wanted = ctx.params.page
    || (issue.pages.find((p) => p.flagged) || issue.pages.find((p) => p.current_render) || issue.pages[0] || {}).id;
  const page = wanted ? await api.page(ctx.projectId, wanted) : null;
  return { issue, page };
}

function requests(renders) {
  const rows = [];
  for (const r of renders) {
    if (!r.review) continue;
    for (const f of r.review.findings || []) {
      if (f.source === 'user_request') rows.push({ render: r.id, finding: f });
    }
  }
  // The same request is carried from a render's review to the next one's.
  const seen = new Map();
  for (const row of rows) seen.set(`${row.finding.id}:${row.finding.repair}`, row);
  return [...seen.values()];
}

export function view(ctx, { issue, page }) {
  ctx.title = t('screen.corrections');
  const base = `/p/${encodeURIComponent(ctx.projectId)}`;
  if (!page || !issue.pages.some((p) => p.current_render)) {
    return h('div', { class: 'screen' },
      screenHead({ title: t('screen.corrections'), lede: t('correct.lede') }),
      emptyState(t('correct.empty_title'), t('correct.empty_body'), h('a', { class: 'btn primary', href: `${base}/pages` }, t('screen.pages'))));
  }
  const name = pageName(page.id);
  const renders = page.renders || [];
  const current = renders.find((r) => r.current) || renders[renders.length - 1] || null;
  const mine = (j) => j.op === 'page.correct' && j.params && j.params.page === page.id;

  if (!current) {
    return h('div', { class: 'screen' },
      screenHead({ title: t('screen.corrections'), lede: t('correct.lede') }),
      pageStrip(ctx, issue, page.id, 'corrections'),
      emptyState(t('check.not_drawn_title', { name }), t('correct.not_drawn_body'), h('a', { class: 'btn', href: `${base}/pages/${page.id}` }, t('pages.link_plan'))));
  }

  const box = correction(ctx, {
    key: page.id,
    render: current,
    panels: page.plan.panels.map((p) => ({ id: p.id, number: p.number, moment: p.moment })),
    repairLimit: page.repair_limit,
    send: (params) => queueOp('page.correct', Object.assign({ page: page.id }, params)),
  });
  const asked = requests(renders);
  const last = lastCorrection(ctx, {
    key: page.id,
    test: mine,
    renders,
    canAccept: !(current.review && current.review.human_approval && current.review.human_approval.status === 'approved'),
    onAccept: () => approveRender(ctx, { kind: 'page', page: page.id, render: current.id }, current.review),
  });

  const text = h('div', { class: 'stack' },
    jobsFor(mine),
    panel(t('correct.form_title', { name }), box.form),
    asked.length ? panel(tn('correct.requests_title', asked.length),
      h('ul', { class: 'request-list' }, asked.map(({ render, finding }) => h('li', null,
        h('q', null, finding.repair), ' ',
        h('span', { class: 'small faint' }, `${versionName(render)} · ${finding.status === 'fixed' ? t('finding_status.fixed') : (finding.status === 'accepted' ? t('finding_status.dropped') : t('finding_status.open'))}`),
        finding.recheck ? h('p', { class: 'small muted' }, finding.recheck.evidence) : null)))) : null);

  const images = h('div', { class: 'stack' },
    h('div', { class: 'row spread' },
      h('span', null, h('strong', null, `${name}, ${versionName(current.id)}`), ' ', verdictChip(current.review || {})),
      h('a', { href: `${base}/check/${page.id}` }, t('page.see_evidence'))),
    last,
    last ? h('h2', { class: 'panel-title' }, t('correct.mark_title')) : null,
    box.stage);

  return h('div', { class: 'screen' },
    screenHead({ title: t('screen.corrections'), lede: t('correct.lede') }),
    pageStrip(ctx, issue, page.id, 'corrections'),
    bench(ctx, { text, images, chat: { key: page.chat_key, title: t('chat.title_about', { name }) } }));
}
