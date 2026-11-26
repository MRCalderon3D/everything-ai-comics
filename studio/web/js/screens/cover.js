// The cover, which is optional: describe it or let the AI propose one, draw
// it, correct it, approve it.

import { h } from '/js/dom.js';
import { t, tn } from '/js/i18n.js';
import { api } from '/js/api.js';
import { state } from '/js/store.js';
import { screenHead, bench } from '/js/components/bench.js';
import { panel, tabs, notice, actionButton, textField, emptyState } from '/js/components/ui.js';
import { docEditor } from '/js/components/editor.js';
import { queueOp } from '/js/components/ask.js';
import { jobsFor } from '/js/components/jobs.js';
import { frame, openViewer, versionStrip } from '/js/components/viewer.js';
import { reviewPanel, verdictChip, verdictWords, outcomeOf, approveRender, confirmCorrection } from '/js/components/verdict.js';
import { correction, lastCorrection } from '/js/components/correction.js';
import { handoff, noDrawTool } from '/js/components/handoff.js';
import { versionName } from '/js/labels.js';
import { toast } from '/js/components/toast.js';

const mine = (j) => j.op === 'cover.create' || j.op === 'cover.correct'
  || (j.op === 'page.manual' && j.params && j.params.cover)
  || (j.op === 'page.review' && j.params && String(j.params.render || '').startsWith('CV_'));

export async function load(ctx) {
  const issue = state.issue || 'ISS_001';
  const [cover, repairLimit] = await Promise.all([api.cover(ctx.projectId, issue), Promise.resolve(state.overview.repair_limit)]);
  return { issue, cover, repairLimit };
}

function createForm(ctx, issue, canDraw, existing) {
  const about = textField({
    label: t('cover.describe'), multiline: true, rows: 4, optional: true, draft: ctx.draft('cover'),
    value: existing || '', hint: t('cover.describe_hint'), placeholder: t('cover.describe_placeholder'),
  });
  const go = async () => {
    await queueOp('cover.create', { issue, description: about.value.trim() || undefined, draw: canDraw });
    about.clear();
  };
  return h('form', { class: 'stack-s', onsubmit: (e) => e.preventDefault() },
    about.el,
    h('div', { class: 'row' },
      actionButton(canDraw ? t('cover.make') : t('cover.write_only'), go, { kind: 'primary' }),
      canDraw ? h('span', { class: 'small muted' }, t('style.draw_time')) : null));
}

export function view(ctx, { issue, cover, repairLimit }) {
  ctx.title = t('screen.cover');
  const draw = state.overview.tools.draw;
  const lookOk = cover.look_approved !== undefined ? cover.look_approved : (state.overview.look && state.overview.look.approved);
  const canDraw = draw.available && lookOk;
  const base = `/p/${encodeURIComponent(ctx.projectId)}`;
  const why = !lookOk ? notice('info', t('cover.look_first'), ' ', h('a', { href: `${base}/style` }, t('screen.style')))
    : (!draw.available ? noDrawTool(t('cover.no_draw_tool')) : null);

  if (!cover.exists) {
    return h('div', { class: 'screen narrow' },
      screenHead({ title: t('screen.cover'), lede: t('cover.lede_none') }),
      jobsFor(mine),
      why,
      panel(t('cover.new_title'), createForm(ctx, issue, canDraw)));
  }

  const renders = cover.renders || [];
  const current = renders.find((r) => r.current) || renders[renders.length - 1] || null;
  const shownId = renders.some((r) => r.id === ctx.ui.version) ? ctx.ui.version : (current && current.id);
  const shown = renders.find((r) => r.id === shownId) || null;
  const items = renders.map((r) => ({ id: r.id, label: versionName(r.id), image: r.lettered || r.image, alt: `${t('cover.name')}, ${versionName(r.id)}` }));
  const approved = cover.status === 'approved' && cover.approved_render;
  const concept = cover.cover && cover.cover.data ? cover.cover.data.concept : '';

  const flagged = !!current && outcomeOf(current.review) === 'flagged';
  const correctFinding = async (finding) => {
    const text = await confirmCorrection(finding);
    if (!text) return;
    await queueOp('cover.correct', { issue, render: current.id, text, region: finding.region || undefined, lettering: finding.check === 'lettering' });
  };
  let box = null;
  if (current) {
    box = correction(ctx, {
      key: 'cover',
      render: current,
      repairLimit,
      send: (params) => queueOp('cover.correct', { issue, text: params.text, render: params.render, region: params.region, lettering: params.lettering }),
    });
  }
  const last = current ? lastCorrection(ctx, {
    key: 'cover',
    test: (j) => j.op === 'cover.correct',
    renders,
    canAccept: !(approved && cover.approved_render === current.id),
    onAccept: () => approveRender(ctx, { kind: 'cover', issue, render: current.id }, current.review),
  }) : null;

  const text = h('div', { class: 'stack' },
    jobsFor(mine),
    h('section', { class: 'panel' },
      tabs(ctx, 'cover', [
        current ? { id: 'correct', label: t('cover.tab_correct'), render: () => box.form } : null,
        current ? { id: 'check', label: t('cover.tab_check'), render: () => reviewPanel((shown || current).review, { repairLimit, onCorrect: !shown || shown.id === current.id ? correctFinding : null }) } : null,
        { id: 'text', label: t('cover.tab_text'), render: () => docEditor(ctx, cover.cover, { key: 'cover', title: t('cover.text_title') }) },
        {
          id: 'again', label: current ? t('cover.tab_again') : t('cover.tab_draw'),
          render: () => h('div', { class: 'stack-s' },
            h('p', { class: 'muted' }, current ? t('cover.again_body') : t('cover.draw_body')),
            why,
            createForm(ctx, issue, canDraw, concept)),
        },
      ], { label: t('screen.cover') })));

  const decision = current ? h('div', { class: 'panel stack-s' },
    h('h2', { class: 'panel-title' }, t('review.your_decision')),
    approved
      ? h('p', null, t('cover.approved', { version: versionName(cover.approved_render) }))
      : h('p', { class: 'muted' }, flagged ? t('check.decide_flagged') : (outcomeOf(current.review) === 'notes' ? t('check.decide_notes') : t('cover.decide'))),
    h('div', { class: 'row' },
      !(approved && cover.approved_render === current.id)
        ? actionButton(flagged ? t('check.approve_anyway') : t('cover.approve'),
          () => approveRender(ctx, { kind: 'cover', issue, render: current.id }, current.review),
          { kind: flagged ? '' : 'primary' })
        : null,
      actionButton(current.review ? t('check.again') : t('check.now'), () => queueOp('page.review', { render: current.id }), { kind: 'quiet' }))) : null;

  const images = h('div', { class: 'stack' },
    current
      ? h('div', { class: 'stack-s' },
        h('div', { class: 'row spread' },
          h('span', null, h('strong', null, versionName((shown || current).id)), ' ', verdictChip((shown || current).review || {})),
          h('button', { type: 'button', class: 'link', onclick: () => openViewer(items, (shown || current).id, { title: t('cover.name') }) }, t('image.open_large_short'))),
        shown && shown.id !== current.id
          ? frame(shown.lettered || shown.image, { alt: `${t('cover.name')}, ${versionName(shown.id)}`, onclick: () => openViewer(items, shown.id) })
          : box.stage,
        renders.length > 1 ? versionStrip(items.map((it) => {
          const r = renders.find((x) => x.id === it.id);
          return Object.assign({}, it, { badge: r && r.review ? verdictWords(r.review) : t('verdict.none') });
        }), (shown || current).id, (id) => { ctx.ui.version = id; ctx.refresh(); }) : null)
      : h('div', { class: 'art-empty' }, h('h2', null, t('cover.not_drawn_title')), h('p', null, t('cover.not_drawn_body'))),
    decision,
    last,
    lookOk && (!draw.available || ctx.ui.manual)
      ? panel(t('handoff.title'), handoff(ctx, 'cover', { cover: issue }))
      : (lookOk ? h('button', { type: 'button', class: 'link small', onclick: () => { ctx.ui.manual = true; ctx.refresh(); } }, t('handoff.offer')) : null));

  return h('div', { class: 'screen' },
    screenHead({
      title: t('screen.cover'),
      lede: approved ? t('cover.lede_approved') : (current ? t('cover.lede_drawn') : t('cover.lede_written')),
    }),
    bench(ctx, { text, images, chat: { key: cover.chat_key, examples: [t('cover.example_1')] } }));
}
