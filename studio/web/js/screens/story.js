// The story. The person writes it: the screen opens with their own text and
// the story bible to fill in. The AI writes only when asked, through
// explicit actions that say beforehand what they will write, and what it
// writes arrives as a proposal the person accepts, edits or rejects part by
// part before any of it becomes canon.

import { h, icon, mount, nextId } from '/js/dom.js';
import { t, tn, tv, formatBytes } from '/js/i18n.js';
import { api, errorText } from '/js/api.js';
import { screenHead } from '/js/components/bench.js';
import { tabs, notice, actionButton, button, textField } from '/js/components/ui.js';
import { docEditor, showFile, findingsList } from '/js/components/editor.js';
import { queueOp } from '/js/components/ask.js';
import { uploader } from '/js/components/uploader.js';
import { jobsFor } from '/js/components/jobs.js';
import { openDialog, confirmDialog } from '/js/components/dialog.js';
import { askInConversation } from '/js/components/conversation.js';
import { toast } from '/js/components/toast.js';
import { state, bus } from '/js/store.js';

const OPS = ['project.setup', 'story.update', 'story.draft', 'story.complete', 'story.suggest'];
const PART_ORDER = ['premise', 'tone', 'world_rule', 'fact', 'arc', 'timeline', 'question'];

export async function load(ctx) {
  return api.story(ctx.projectId);
}

/** "CHAR_MARA" -> "Mara", for a part that names a character. */
function personName(id) {
  const raw = String(id || '').replace(/^CHAR_/, '').replace(/_/g, ' ').toLowerCase();
  return raw.replace(/\b\w/g, (c) => c.toUpperCase());
}

function sourcesTab(ctx, data) {
  const up = uploader(ctx, { kind: 'text', multiple: false, key: 'source' });
  return h('div', { class: 'stack' },
    h('div', { class: 'stack-s' },
      h('h3', null, t('story.sources_title')),
      data.sources.length
        ? h('ul', { class: 'file-list' }, data.sources.map((s) => h('li', null,
          h('button', { type: 'button', class: 'link', onclick: () => showFile(ctx.projectId, s.path) }, s.name),
          h('span', { class: 'faint small' }, ` ${formatBytes(s.bytes)}`))))
        : h('p', { class: 'muted' }, t('story.sources_none'))),
    h('div', { class: 'stack-s' },
      h('h3', null, t('story.upload_title')),
      h('p', { class: 'muted' }, t('story.upload_body')),
      up.el,
      h('div', { class: 'row' }, actionButton(t('story.upload_action'), async () => {
        const ids = up.ids();
        if (!ids.length) {
          toast(t('story.upload_need_file'), { kind: 'warn' });
          return;
        }
        await queueOp('story.update', { source_upload: ids[0] });
        up.clear();
      }))));
}

/** The person's own words, as they wrote them when creating the comic. */
function ownText(ctx, data) {
  const editing = !!ctx.ui.editOwn;
  const body = h('div');
  if (editing) {
    mount(body, h('p', { class: 'loading' }, t('state.loading')));
    api.file(ctx.projectId, 'story/source/description.md').then((doc) => {
      mount(body, docEditor(ctx, doc, { key: 'own', title: t('story.own_title'), rows: 8, onSaved: () => { ctx.ui.editOwn = false; ctx.refresh(); } }));
    }).catch((err) => mount(body, notice('bad', errorText(err))));
  }
  return h('section', { class: 'own-text' },
    h('div', { class: 'row spread' },
      h('h2', { class: 'panel-title' }, t('story.own_title')),
      button(editing ? t('story.own_done') : t('story.own_edit'), {
        kind: 'quiet', small: true, icon: editing ? 'check' : 'pen',
        onclick: () => {
          // Opening or closing the editor rebuilds the screen: unsaved edits elsewhere come first.
          if (ctx.hasUnsaved()) { toast(t('editor.switch_needs_save'), { kind: 'warn' }); return; }
          ctx.ui.editOwn = !editing; ctx.refresh(true);
        },
      })),
    editing ? body : (data.description
      ? h('blockquote', null, data.description)
      : h('p', { class: 'muted' }, t('story.own_empty'))),
    !editing ? h('p', { class: 'small muted' }, t('story.own_hint')) : null);
}

/** One of the things the AI can be asked to do, saying beforehand what it writes. */
function aiAction({ title, body, action, run, disabled, input }) {
  if (input) {
    return h('div', { class: 'ai-action with-input' },
      h('h3', null, title), h('p', null, body), input.el,
      actionButton(action, run, { small: true, disabled }));
  }
  return h('div', { class: 'ai-action' },
    h('h3', null, title), h('p', null, body),
    actionButton(action, run, { small: true, disabled }));
}

function askPanel(ctx, data) {
  const noText = !data.has_text;
  const suggest = textField({ label: t('story.suggest_label'), placeholder: t('story.suggest_placeholder'), draft: ctx.draft('suggest'), multiline: true, rows: 2 });
  const change = textField({ label: t('story.change_label'), placeholder: t('story.ask_placeholder'), draft: ctx.draft('change'), multiline: true, rows: 2 });
  const need = (field) => {
    const text = field.value.trim();
    if (!text) {
      field.input.focus();
      toast(t('form.write_first'), { kind: 'warn' });
    }
    return text;
  };
  return h('section', { class: 'panel' },
    h('h2', { class: 'panel-title' }, icon('spark'), t('story.ai_title')),
    h('p', { class: 'muted small' }, t('story.ai_intro')),
    noText ? notice('warn', t('story.need_text')) : null,
    h('div', { class: 'ai-actions' },
      aiAction({
        title: t('story.draft_title'), body: t('story.draft_body'), action: t('story.draft_action'), disabled: noText,
        run: () => queueOp('story.draft', {}),
      }),
      aiAction({
        title: t('story.complete_title'), body: t('story.complete_body'), action: t('story.complete_action'), disabled: noText,
        run: () => queueOp('story.complete', {}),
      }),
      aiAction({
        title: t('story.suggest_title'), body: t('story.suggest_body'), action: t('story.suggest_action'), input: suggest,
        run: async () => {
          const text = need(suggest);
          if (!text) return;
          await queueOp('story.suggest', { instruction: text });
          suggest.clear();
        },
      }),
      aiAction({
        title: t('story.change_title'), body: t('story.change_body'), action: t('story.change_action'), input: change,
        run: async () => {
          const text = need(change);
          if (!text) return;
          await queueOp('story.update', { instruction: text });
          change.clear();
        },
      })),
    h('p', { class: 'small' }, h('button', { type: 'button', class: 'link', onclick: () => askInConversation('') }, t('story.or_chat'))));
}

function meter(counts) {
  const total = Math.max(1, counts.parts || 0);
  const pct = (n) => `${Math.round(((n || 0) / total) * 100)}%`;
  const acc = h('span', { class: 'm-accepted' });
  acc.style.setProperty('width', pct((counts.accepted || 0) + (counts.edited || 0)));
  const rej = h('span', { class: 'm-rejected' });
  rej.style.setProperty('width', pct(counts.rejected));
  return h('div', { class: 'proposal-meter', 'aria-hidden': 'true' }, acc, rej);
}

function proposalCards(ctx, proposals) {
  if (!proposals || !proposals.length) return null;
  return h('section', { class: 'stack-s', 'aria-label': t('story.proposals_title') },
    h('h2', { class: 'panel-title' }, tn('story.proposals_waiting', proposals.length)),
    proposals.map((p) => h('div', { class: 'proposal-card' },
      h('h3', null, p.title),
      p.instruction ? h('p', { class: 'small muted' }, `"${p.instruction}"`) : null,
      meter(p.counts || {}),
      h('p', { class: 'small' }, t('story.proposal_counts', { pending: p.counts.pending, parts: p.counts.parts })),
      h('div', { class: 'row' }, button(t('story.review'), { kind: 'primary', small: true, onclick: () => openReview(ctx, p.id) })))));
}

function provenanceChip(part) {
  if (part.type !== 'fact' || !part.provenance) return null;
  return h('span', { class: `prov ${part.provenance}` }, tv('provenance', part.provenance, part.provenance));
}

/** One part of a proposal, with its three choices: accept, edit and accept, reject. */
function partNode(part, decide) {
  const el = h('li', { class: 'prop-part', dataset: { status: part.status } });
  const tags = h('div', { class: 'prop-tags' },
    provenanceChip(part),
    part.type === 'arc' && part.character ? h('span', { class: 'chip' }, personName(part.character)) : null,
    part.type === 'question' && part.blocking ? h('span', { class: 'chip bad' }, t('story.blocking_chip')) : null);
  const details = [];
  if (part.source_ref) details.push([t('story.part_source'), part.source_ref]);
  if (part.affects && part.affects.length) details.push([t('story.part_affects'), part.affects.join(', ')]);
  const more = details.length ? h('details', { class: 'small' }, h('summary', { class: 'muted' }, t('form.details')),
    h('dl', { class: 'facts' }, details.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]))) : null;

  const paint = () => {
    const nodes = tags.childElementCount ? [tags] : [];
    if (part.status === 'pending') {
      nodes.push(h('p', { class: 'prop-text' }, part.text));
      if (part.type === 'question') nodes.push(questionControls(part, decide));
      else nodes.push(choiceRow(part, decide, el));
    } else {
      nodes.push(h('p', { class: 'prop-text' }, part.final_text || part.text));
      nodes.push(h('p', { class: 'small muted' }, tv('part_status', part.status, part.status),
        part.answer ? ` ${t('story.answered', { answer: part.answer })}` : ''));
    }
    if (more) nodes.push(more);
    mount(el, nodes);
  };
  el.repaint = (next) => { Object.assign(part, next); el.dataset.status = part.status; paint(); };
  paint();
  return el;
}

function choiceRow(part, decide, el) {
  const row = h('div', { class: 'row' });
  const edit = () => {
    const id = nextId('pe');
    const area = h('textarea', { id, rows: 3 });
    area.value = part.text;
    const box = h('div', { class: 'stack-s' },
      h('label', { for: id, class: 'small' }, t('story.edit_label')), area,
      h('div', { class: 'row' },
        actionButton(t('story.accept_edit'), async () => {
          const text = area.value.trim();
          if (!text) { area.focus(); return; }
          await decide(part, { decision: 'edit', text });
        }, { kind: 'accent', small: true }),
        button(t('action.cancel'), { kind: 'quiet', small: true, onclick: () => el.repaint({}) })));
    row.replaceWith(box);
    area.focus();
  };
  row.append(
    actionButton(t('story.accept'), () => decide(part, { decision: 'accept' }), { kind: 'accent', small: true, icon: 'check' }),
    button(t('story.edit'), { small: true, icon: 'pen', onclick: edit }),
    actionButton(t('story.reject'), () => decide(part, { decision: 'reject' }), { kind: 'quiet', small: true, icon: 'close' }));
  return row;
}

function questionControls(part, decide) {
  const name = nextId('qa');
  const options = Array.isArray(part.options) ? part.options : [];
  let chosen = '';
  const ownId = nextId('own');
  const own = h('input', { type: 'text', id: ownId, placeholder: t('story.own_answer') });
  const radios = options.map((o) => {
    const id = nextId('o');
    return h('div', { class: 'check' },
      h('input', { type: 'radio', name, id, value: o, onchange: () => { chosen = o; own.value = ''; } }),
      h('label', { for: id }, o));
  });
  own.addEventListener('input', () => { if (own.value) chosen = ''; });
  return h('div', { class: 'stack-s' },
    radios.length ? h('fieldset', { class: 'radios' }, h('legend', { class: 'small' }, t('story.answer_legend')), radios) : null,
    h('div', { class: 'field' }, h('label', { for: ownId, class: 'small' }, radios.length ? t('story.or_own') : t('story.answer_legend')), own),
    h('div', { class: 'row' },
      actionButton(t('story.answer'), async () => {
        const answer = (own.value || chosen).trim();
        if (!answer) { own.focus(); toast(t('story.need_answer'), { kind: 'warn' }); return; }
        await decide(part, { decision: 'accept', answer });
      }, { kind: 'accent', small: true, icon: 'check' }),
      actionButton(t('story.keep_open'), () => decide(part, { decision: 'accept' }), { small: true }),
      actionButton(t('story.reject_question'), () => decide(part, { decision: 'reject' }), { kind: 'quiet', small: true })));
}

/** The review of one proposal: every part decided where the person reads it. */
export async function openReview(ctx, proposalId) {
  const body = h('div', { class: 'stack' }, h('p', { class: 'loading' }, t('state.loading')));
  const progress = h('span', { class: 'review-progress' });
  const status = h('div');
  const dialog = openDialog({ title: t('story.review_title'), wide: true, body, onClose: () => ctx.refresh() });
  let proposal;
  try {
    proposal = (await api.proposal(ctx.projectId, proposalId)).proposal;
  } catch (err) {
    mount(body, notice('bad', errorText(err)));
    return;
  }
  const nodes = new Map();
  const paintProgress = () => {
    const c = proposal.counts;
    mount(progress, t('story.review_progress', { done: c.parts - c.pending, parts: c.parts }));
    rest.disabled = !c.pending || proposal.status !== 'open';
    discard.disabled = !c.pending || proposal.status !== 'open';
  };
  const apply = (res) => {
    proposal = res.proposal;
    for (const p of proposal.parts) if (nodes.has(p.id)) nodes.get(p.id).repaint(p);
    mount(status, findingsList(res.findings));
    paintProgress();
  };
  const decide = async (part, decision) => {
    const res = await api.decideProposal(ctx.projectId, proposal.id, [Object.assign({ part: part.id }, decision)]);
    apply(res);
  };
  const rest = h('button', { type: 'button', class: 'btn' }, t('story.accept_rest'));
  rest.addEventListener('click', async () => {
    const pending = proposal.parts.filter((p) => p.status === 'pending');
    if (!pending.length) return;
    rest.disabled = true;
    try {
      apply(await api.decideProposal(ctx.projectId, proposal.id, pending.map((p) => ({ part: p.id, decision: 'accept' }))));
      toast(t('story.rest_accepted'), { kind: 'ok' });
    } catch (err) {
      toast(errorText(err), { kind: 'bad' });
      paintProgress();
    }
  });
  const discard = h('button', { type: 'button', class: 'btn quiet' }, t('story.discard_rest'));
  discard.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: t('story.discard_title'), body: t('story.discard_body'), confirm: t('story.discard_confirm'), danger: true,
      run: () => api.discardProposal(ctx.projectId, proposal.id),
    });
    if (!ok) return;
    dialog.close();
    toast(t('story.discarded'), { kind: 'ok' });
  });

  const groups = PART_ORDER.map((type) => [type, proposal.parts.filter((p) => p.type === type)]).filter(([, list]) => list.length);
  const others = proposal.parts.filter((p) => !PART_ORDER.includes(p.type));
  if (others.length) groups.push(['misc', others]);
  mount(body,
    h('div', { class: 'stack-s' },
      h('p', null, proposal.summary),
      h('p', { class: 'small muted' }, t('story.review_intro')),
      proposal.decisions && proposal.decisions.length
        ? h('details', { class: 'details-box' }, h('summary', null, t('jobs.decisions_made')),
          h('ul', { class: 'bullets small' }, proposal.decisions.map((d) => h('li', null, d))))
        : null),
    status,
    h('div', { class: 'parts' }, groups.map(([type, list]) => h('section', { class: 'prop-group' },
      h('h3', null, tv('part_group', type, type)),
      h('ol', { class: 'parts' }, list.map((p) => {
        const node = partNode(p, decide);
        nodes.set(p.id, node);
        return node;
      }))))));
  dialog.setActions(h('div', { class: 'review-foot' }, progress,
    h('div', { class: 'row' }, discard, rest, button(t('story.review_done'), { kind: 'primary', onclick: () => dialog.close() }))));
  paintProgress();
}

export function view(ctx, data) {
  ctx.title = t('screen.story');
  const project = state.overview.project;
  const working = jobsFor((j) => OPS.includes(j.op));

  // A proposal named in the address (from a chat reply or a finished job) opens at once.
  const wanted = ctx.query.get('proposal');
  if (wanted && ctx.ui.opened !== wanted) {
    ctx.ui.opened = wanted;
    setTimeout(() => openReview(ctx, wanted), 0);
  }
  // A proposal that just arrived from an action on this screen opens too.
  const off = bus.on('job-ended', (job) => {
    if (job.status === 'done' && ['story.draft', 'story.complete', 'story.suggest', 'project.setup'].includes(job.op) && job.result && job.result.proposal && location.pathname.endsWith('/story')) {
      setTimeout(() => openReview(ctx, job.result.proposal), 300);
    }
  });
  ctx.onCleanup(off);

  const bibleTabs = h('section', { class: 'panel' },
    tabs(ctx, 'story', [
      { id: 'bible', label: t('story.tab_bible'), render: () => h('div', { class: 'stack-s' }, h('p', { class: 'muted small' }, data.written ? t('story.bible_hint') : t('story.bible_empty_hint')), docEditor(ctx, data.bible, { key: 'bible', title: t('story.bible_title') })) },
      { id: 'plan', label: t('story.tab_plan'), render: () => docEditor(ctx, data.series_plan, { key: 'plan', title: t('story.plan_title') }) },
      { id: 'sources', label: t('story.tab_sources'), count: data.sources.length, render: () => sourcesTab(ctx, data) },
    ], { label: t('screen.story') }));

  const body = h('div', { class: 'stack' },
    working,
    data.blocking_questions && data.blocking_questions.length
      ? notice('warn', h('p', null, h('strong', null, tn('story.blocking', data.blocking_questions.length))),
        h('ul', { class: 'bullets' }, data.blocking_questions.map((q) => h('li', null, q.question || String(q)))),
        h('p', { class: 'small' }, t('story.blocking_hint')))
      : null,
    proposalCards(ctx, data.proposals),
    h('div', { class: 'story-top' }, ownText(ctx, data), askPanel(ctx, data)),
    bibleTabs);

  state.screenExamples = [t('story.example_1'), t('story.example_2')];
  return h('div', { class: 'screen' },
    screenHead({ title: t('screen.story'), lede: data.written ? t('story.lede', { title: project.title }) : t('story.lede_new') }),
    body);
}
