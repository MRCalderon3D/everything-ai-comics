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
import { correction, lastCorrection, queueCorrection } from '/js/components/correction.js';
import { handoff, noDrawTool } from '/js/components/handoff.js';
import { versionName } from '/js/labels.js';
import { toast } from '/js/components/toast.js';
import { currentIssue, issueBar } from '/js/components/issues.js';
import { newsBar } from '/js/components/news.js';
import { deleteButton, cleanupButton } from '/js/components/deleting.js';

const mine = (j) => j.op === 'cover.create' || j.op === 'cover.correct'
  || (j.op === 'page.manual' && j.params && j.params.cover)
  || (j.op === 'page.review' && j.params && String(j.params.render || '').startsWith('CV_'));

export async function load(ctx) {
  const issue = currentIssue(ctx);
  const [cover, repairLimit] = await Promise.all([api.cover(ctx.projectId, issue), Promise.resolve(state.overview.repair_limit)]);
  return { issue, cover, repairLimit };
}

/** A new cover: from a description, or proposed by the AI when it is left empty. */
function createForm(ctx, issue, canDraw) {
  const about = textField({
    label: t('cover.describe'), multiline: true, rows: 4, optional: true, draft: ctx.draft('cover'),
    hint: t('cover.describe_hint'), placeholder: t('cover.describe_placeholder'),
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

/**
 * A cover that exists: draw it again exactly as its text says (the server
 * then writes nothing), or rewrite it from a new description and draw that.
 */
function againPanel(ctx, issue, canDraw, why, drawn) {
  const drawAgain = h('section', { class: 'stack-s' },
    h('h3', null, drawn ? t('cover.again_title') : t('cover.draw_title')),
    h('p', { class: 'muted' }, drawn ? t('cover.again_body') : t('cover.draw_body')),
    why,
    h('div', { class: 'row' },
      actionButton(drawn ? t('cover.draw_again') : t('cover.draw_now'), () => queueOp('cover.create', { issue }),
        { kind: 'primary', disabled: !canDraw }),
      canDraw ? h('span', { class: 'small muted' }, t('style.draw_time')) : null));
  const about = textField({
    label: t('cover.new_description'), multiline: true, rows: 4, draft: ctx.draft('cover-rewrite'),
    hint: canDraw ? t('cover.rewrite_hint') : t('cover.rewrite_hint_no_draw'), placeholder: t('cover.describe_placeholder'),
  });
  const rewrite = async () => {
    const text = about.value.trim();
    if (!text) {
      about.input.focus();
      toast(t('form.write_first'), { kind: 'warn' });
      return;
    }
    await queueOp('cover.create', { issue, description: text, draw: canDraw });
    about.clear();
  };
  const rewriteForm = h('form', { class: 'stack-s', onsubmit: (e) => e.preventDefault() },
    h('h3', null, t('cover.rewrite_title')),
    about.el,
    h('div', { class: 'row' }, actionButton(canDraw ? t('cover.rewrite') : t('cover.rewrite_only'), rewrite)));
  return h('div', { class: 'stack' }, drawAgain, rewriteForm);
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
      issueBar(ctx, issue),
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

  const flagged = !!current && outcomeOf(current.review) === 'flagged';
  const correctFinding = async (finding) => {
    const text = await confirmCorrection(finding);
    if (!text) return;
    await queueCorrection('cover.correct', { issue, render: current.id, text, region: finding.region || undefined, lettering: finding.check === 'lettering' });
  };
  let box = null;
  if (current) {
    box = correction(ctx, {
      key: 'cover',
      render: current,
      touchUpWarning: state.overview.touch_up_warning,
      send: (params) => queueCorrection('cover.correct', { issue, text: params.text, render: params.render, region: params.region, lettering: params.lettering, mode: params.mode }),
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
    newsBar('cover'),
    jobsFor(mine),
    h('section', { class: 'panel' },
      tabs(ctx, 'cover', [
        current ? { id: 'correct', label: t('cover.tab_correct'), render: () => box.form } : null,
        current ? { id: 'check', label: t('cover.tab_check'), render: () => reviewPanel((shown || current).review, { repairLimit, onCorrect: !shown || shown.id === current.id ? correctFinding : null }) } : null,
        { id: 'text', label: t('cover.tab_text'), render: () => docEditor(ctx, cover.cover, { key: 'cover', title: t('cover.text_title') }) },
        {
          id: 'again', label: current ? t('cover.tab_again') : t('cover.tab_draw'),
          render: () => againPanel(ctx, issue, canDraw, why, !!current),
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
          h('span', { class: 'row' },
            h('button', { type: 'button', class: 'link', onclick: () => openViewer(items, (shown || current).id, { title: t('cover.name') }) }, t('image.open_large_short')),
            deleteButton(ctx, { kind: 'render', id: (shown || current).id }, { label: t('page.delete_version') }))),
        shown && shown.id !== current.id
          ? frame(shown.lettered || shown.image, { alt: `${t('cover.name')}, ${versionName(shown.id)}`, onclick: () => openViewer(items, shown.id) })
          : box.stage,
        renders.length > 1 ? versionStrip(items.map((it) => {
          const r = renders.find((x) => x.id === it.id);
          return Object.assign({}, it, { badge: r && r.review ? verdictWords(r.review) : t('verdict.none') });
        }), (shown || current).id, (id) => { ctx.ui.version = id; ctx.refresh(); }) : null)
      : h('div', { class: 'art-empty' }, h('h2', null, t('cover.not_drawn_title')), h('p', null, t('cover.not_drawn_body')),
        canDraw ? h('div', { class: 'row' }, actionButton(t('cover.draw_now'), () => queueOp('cover.create', { issue }), { kind: 'primary' })) : null),
    decision,
    last,
    lookOk && (!draw.available || ctx.ui.manual)
      ? panel(t('handoff.title'), handoff(ctx, 'cover', { cover: issue }))
      : (lookOk ? h('button', { type: 'button', class: 'link small', onclick: () => { ctx.ui.manual = true; ctx.refresh(); } }, t('handoff.offer')) : null));

  return h('div', { class: 'screen' },
    screenHead({
      title: t('screen.cover'),
      lede: approved ? t('cover.lede_approved') : (current ? t('cover.lede_drawn') : t('cover.lede_written')),
      actions: renders.length > 1 ? [cleanupButton(ctx, `cover:${issue}`)] : null,
    }),
    issueBar(ctx, issue),
    bench(ctx, { text, images, chat: { key: cover.chat_key, examples: [t('cover.example_1')] } }));
}
