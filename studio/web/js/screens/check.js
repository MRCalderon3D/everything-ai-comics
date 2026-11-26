// The check of each page: the verdict with every check and its evidence, the
// automatic repairs that were tried, and every version of the page. The
// person's approval is theirs to give, also against the automated reading.

import { h } from '/js/dom.js';
import { t, tn, formatDate } from '/js/i18n.js';
import { api } from '/js/api.js';
import { state } from '/js/store.js';
import { screenHead, bench } from '/js/components/bench.js';
import { panel, actionButton, notice, emptyState } from '/js/components/ui.js';
import { queueOp } from '/js/components/ask.js';
import { jobsFor } from '/js/components/jobs.js';
import { frame, openViewer, versionStrip, compareBox } from '/js/components/viewer.js';
import { reviewPanel, verdictChip, verdictWords, verdictClass, outcomeOf, approveRender, confirmCorrection } from '/js/components/verdict.js';
import { pageName, versionName } from '/js/labels.js';
import { renderItems } from '/js/screens/page.js';
import { queueLine } from '/js/screens/pages.js';

export async function load(ctx) {
  const issueId = state.issue || 'ISS_001';
  const issue = await api.issue(ctx.projectId, issueId);
  const wanted = ctx.params.page
    || (issue.pages.find((p) => p.flagged) || issue.pages.find((p) => p.current_render) || issue.pages[0] || {}).id;
  const page = wanted ? await api.page(ctx.projectId, wanted) : null;
  return { issue, page };
}

/** The strip of pages at the top of the check and corrections screens. */
export function pageStrip(ctx, issue, currentId, section) {
  const base = `/p/${encodeURIComponent(ctx.projectId)}/${section}`;
  return h('nav', { class: 'page-strip', 'aria-label': t('check.pages_nav') },
    h('ul', null, issue.pages.map((p) => h('li', null,
      h('a', { href: `${base}/${p.id}`, 'aria-current': p.id === currentId ? 'page' : null, class: 'strip-item', dataset: { verdict: verdictClass(p) } },
        p.image ? h('img', { src: p.image.url, alt: '' }) : h('span', { class: 'thumb-empty' }),
        h('span', { class: 'strip-name' }, pageName(p.id)),
        h('span', { class: 'strip-verdict' }, p.current_render ? verdictWords(p) : t('pages.not_drawn')))))));
}

/** How each version came to be, oldest first. */
function versionHistory(renders, repairLimit) {
  return h('ol', { class: 'version-history' }, renders.map((r, index) => {
    const review = r.review;
    const gen = r.generation || {};
    let origin;
    if (gen.supplied_by_person) origin = t('check.origin_person');
    else if (review && review.supersedes) origin = t('check.origin_repair', { n: review.repair_cycle, from: versionName(review.supersedes) });
    else if (index > 0) origin = t('check.origin_redraw');
    else origin = t('check.origin_first');
    const fixed = review ? (review.findings || []).filter((f) => f.status === 'fixed' && f.recheck && f.recheck.render === r.id) : [];
    const open = review ? (review.findings || []).filter((f) => f.status === 'open') : [];
    return h('li', { class: 'version-step', dataset: { current: String(!!r.current) } },
      h('div', null, h('strong', null, versionName(r.id)), r.current ? h('span', { class: 'faint' }, ` · ${t('page.current_version')}`) : null),
      h('p', { class: 'small' }, origin),
      h('p', { class: 'small' }, review ? verdictWords(review) : t('verdict.none'),
        review && review.independent === false ? ` · ${t('verdict.not_independent_short')}` : ''),
      fixed.length ? h('ul', { class: 'bullets small' }, fixed.map((f) => h('li', null, t('check.fixed_line', { what: f.repair || f.expected }), ' ', h('span', { class: 'muted' }, f.recheck.evidence)))) : null,
      open.length ? h('ul', { class: 'bullets small' }, open.map((f) => h('li', null, outcomeOf(review) === 'notes' ? t('check.note_line', { what: f.visible || f.repair }) : t('check.open_line', { what: f.visible || f.repair })))) : null,
      gen.status === 'rejected' ? h('p', { class: 'small faint' }, t('check.replaced')) : null);
  }),
  h('li', { class: 'version-limit small muted' }, tn('check.repair_limit', repairLimit)));
}

export function view(ctx, { issue, page }) {
  ctx.title = t('screen.check');
  const base = `/p/${encodeURIComponent(ctx.projectId)}`;
  if (!page || !issue.pages.some((p) => p.current_render)) {
    return h('div', { class: 'screen' },
      screenHead({ title: t('screen.check'), lede: t('check.lede') }),
      emptyState(t('check.empty_title'), t('check.empty_body'), h('a', { class: 'btn primary', href: `${base}/pages` }, t('screen.pages'))));
  }
  const name = pageName(page.id);
  const overruledCount = issue.pages.filter((p) => p.overruled).length;
  const notesCount = typeof issue.counts.with_notes === 'number'
    ? issue.counts.with_notes
    : issue.pages.filter((p) => !p.overruled && outcomeOf(p) === 'notes').length;
  const renders = page.renders || [];
  const current = renders.find((r) => r.current) || renders[renders.length - 1] || null;
  const shownId = renders.some((r) => r.id === ctx.ui.version) ? ctx.ui.version : (current && current.id);
  const shown = renders.find((r) => r.id === shownId) || null;
  const items = renderItems(renders);
  const panels = {};
  for (const p of page.plan.panels) panels[p.id] = p.number;
  const review = shown ? shown.review : null;
  const approved = review && review.human_approval && review.human_approval.status === 'approved';
  const outcome = outcomeOf(review) || 'pass';
  // A finding of the check becomes a correction: the same operation as a
  // request written by hand, with the finding's panel and region.
  const correctFinding = async (finding) => {
    const text = await confirmCorrection(finding);
    if (!text) return;
    await queueOp('page.correct', {
      page: page.id, render: shown.id, text, panel: finding.panel || undefined, region: finding.region || undefined,
      lettering: finding.check === 'lettering',
    });
  };
  const mine = (j) => {
    const p = j.params || {};
    if (j.op === 'pages.generate') return Array.isArray(p.pages) && p.pages.includes(page.id);
    return ['page.correct', 'page.review', 'page.manual'].includes(j.op) && (p.page === page.id || String(p.render || '').startsWith(page.id));
  };

  if (!shown) {
    return h('div', { class: 'screen' },
      screenHead({ title: t('screen.check'), lede: t('check.lede') }),
      pageStrip(ctx, issue, page.id, 'check'),
      jobsFor(mine),
      emptyState(t('check.not_drawn_title', { name }), t('check.not_drawn_body'), h('a', { class: 'btn', href: `${base}/pages/${page.id}` }, t('pages.link_plan'))));
  }

  const text = h('div', { class: 'stack' },
    jobsFor(mine),
    h('section', { class: 'panel' },
      h('h2', { class: 'panel-title' }, t('check.review_of', { name, version: versionName(shown.id) })),
      !shown.current ? notice('info', t('check.older_version')) : null,
      reviewPanel(review, { panels, repairLimit: page.repair_limit, onCorrect: shown.current ? correctFinding : null })),
    panel(t('check.history_title'), versionHistory(renders, page.repair_limit)));

  const decision = h('div', { class: 'panel stack-s' },
    h('h2', { class: 'panel-title' }, t('review.your_decision')),
    approved
      ? h('p', null, t('review.human_approved', { date: formatDate(review.human_approval.at) }))
      : h('p', { class: 'muted' }, !review ? t('check.decide_no_review') : t(`check.decide_${outcome}`)),
    h('div', { class: 'row' },
      !approved && review && shown.current
        ? actionButton(outcome === 'flagged' ? t('check.approve_anyway') : t('check.approve'),
          () => approveRender(ctx, { kind: 'page', page: page.id, render: shown.id }, review),
          { kind: outcome === 'flagged' ? '' : 'primary' })
        : null,
      shown.current ? h('a', { class: `btn ${outcome === 'flagged' ? 'primary' : ''}`, href: `${base}/corrections/${page.id}` }, t('check.ask_correction')) : null,
      actionButton(review ? t('check.again') : t('check.now'), () => queueOp('page.review', { render: shown.id }), { kind: 'quiet' })));

  const images = h('div', { class: 'stack' },
    frame(shown.lettered || shown.image, { alt: `${name}, ${versionName(shown.id)}`, onclick: () => openViewer(items, shown.id, { title: name }) }),
    h('div', { class: 'row spread' }, h('span', null, verdictChip(review || {})), queueLine(page.id)),
    renders.length > 1 ? versionStrip(items.map((it) => {
      const r = renders.find((x) => x.id === it.id);
      return Object.assign({}, it, { badge: r && r.review ? verdictWords(r.review) : t('verdict.none') });
    }), shown.id, (id) => { ctx.ui.version = id; ctx.refresh(); }) : null,
    decision,
    renders.length > 1 ? panel(t('check.compare_title'), compareBox(ctx, `check:${page.id}`, items)) : null);

  return h('div', { class: 'screen' },
    screenHead({
      title: t('screen.check'),
      lede: t('check.lede_counts', { passed: issue.counts.passed - overruledCount - notesCount, notes: notesCount, flagged: issue.counts.flagged, drawn: issue.counts.rendered })
        + (overruledCount ? ` ${tn('pages.lede_overruled', overruledCount)}` : '') + ` ${t('check.lede_tail')}`,
    }),
    pageStrip(ctx, issue, page.id, 'check'),
    bench(ctx, { text, images, focus: 'even', chat: { key: page.chat_key, title: t('chat.title_about', { name }) } }));
}
