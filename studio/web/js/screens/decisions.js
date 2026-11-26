// "The AI needs a decision": a job stopped on a choice only the person can
// make. The questions, their options, and room for another answer.

import { h, nextId } from '/js/dom.js';
import { t, tn } from '/js/i18n.js';
import { api, errorText } from '/js/api.js';
import { state, bus, waitingJobs, rememberJob, loadJobs } from '/js/store.js';
import { screenHead } from '/js/components/bench.js';
import { actionButton, button, notice, emptyState } from '/js/components/ui.js';
import { confirmDialog } from '/js/components/dialog.js';
import { toast } from '/js/components/toast.js';
import { jobTitle, stepLabel, jobLink } from '/js/labels.js';

export async function load() {
  await loadJobs();
  return waitingJobs();
}

function questionBlock(ctx, job, q, answers) {
  const name = nextId('q');
  const options = Array.isArray(q.options) ? q.options : [];
  const draft = ctx.draft(`${job.id}:${q.id}`);
  const otherId = nextId('other');
  const other = h('input', { type: 'text', id: otherId, placeholder: t('decisions.other_placeholder') });
  other.dataset.keep = draft.key;
  const stored = draft.get();
  if (stored && !options.includes(stored)) other.value = stored;
  if (stored) answers[q.id] = stored;
  const radios = options.map((opt) => {
    const id = nextId('o');
    const input = h('input', { type: 'radio', name, id, value: opt, checked: stored === opt });
    input.addEventListener('change', () => {
      answers[q.id] = opt;
      draft.set(opt);
      other.value = '';
    });
    return h('div', { class: 'check' }, input, h('label', { for: id }, opt));
  });
  other.addEventListener('input', () => {
    const value = other.value.trim();
    if (value) {
      answers[q.id] = value;
      draft.set(value);
      for (const r of radios) r.querySelector('input').checked = false;
    } else {
      delete answers[q.id];
      draft.clear();
    }
  });
  return h('fieldset', { class: 'question' },
    h('legend', null, q.question),
    radios,
    h('div', { class: 'field' }, h('label', { for: otherId }, options.length ? t('decisions.other_answer') : t('decisions.answer')), other));
}

function jobBlock(ctx, job) {
  const answers = {};
  const problem = h('div');
  const waitingStep = (job.steps || []).find((s) => s.status === 'waiting');
  const send = async () => {
    problem.replaceChildren();
    const missing = job.questions.filter((q) => !answers[q.id]);
    if (missing.length) {
      problem.append(notice('bad', tn('decisions.missing', missing.length)));
      return;
    }
    try {
      const res = await api.answerJob(job.project, job.id, answers);
      rememberJob(res.job);
      for (const q of job.questions) ctx.draft(`${job.id}:${q.id}`).clear();
      toast(t('decisions.sent'), { kind: 'ok' });
      const link = jobLink(job);
      if (waitingJobs().length) ctx.refresh();
      else ctx.navigate(link || `/p/${encodeURIComponent(job.project)}`);
    } catch (err) {
      problem.append(notice('bad', errorText(err)));
    }
  };
  const cancel = async () => {
    const ok = await confirmDialog({
      title: t('jobs.cancel_title'),
      body: t('decisions.cancel_body'),
      confirm: t('jobs.cancel_confirm'),
      cancel: t('jobs.cancel_keep'),
      danger: true,
      run: async () => {
        const res = await api.cancelJob(job.project, job.id);
        rememberJob(res.job);
      },
    });
    if (ok) ctx.refresh();
  };
  return h('section', { class: 'panel stack decision' },
    h('div', null,
      h('h2', { class: 'panel-title' }, jobTitle(job)),
      h('p', { class: 'muted' }, waitingStep ? t('decisions.stopped_at', { step: stepLabel(job, waitingStep) }) : t('decisions.stopped')),
      job.params && (job.params.instruction || job.params.text || job.params.description)
        ? h('p', null, h('span', { class: 'muted' }, t('decisions.you_asked')), ' ', h('q', null, job.params.instruction || job.params.text || job.params.description)) : null),
    job.questions.map((q) => questionBlock(ctx, job, q, answers)),
    problem,
    h('div', { class: 'row' },
      actionButton(t('decisions.send'), send, { kind: 'primary' }),
      button(t('decisions.cancel_job'), { kind: 'quiet', onclick: cancel })),
    h('p', { class: 'small muted' }, t('decisions.what_next')));
}

export function view(ctx, jobs) {
  ctx.title = t('decisions.title');
  const base = `/p/${encodeURIComponent(ctx.projectId)}`;
  const off = bus.on('job', ({ job, before }) => {
    if ((job.status === 'needs_decision') !== (before && before.status === 'needs_decision')) ctx.refresh();
  });
  ctx.onCleanup(off);
  return h('div', { class: 'screen narrow' },
    screenHead({ title: t('decisions.title'), lede: jobs.length ? t('decisions.lede') : t('decisions.lede_none') }),
    jobs.length
      ? h('div', { class: 'stack' }, jobs.map((j) => jobBlock(ctx, j)))
      : emptyState(t('decisions.none_title'), t('decisions.none_body'), h('a', { class: 'btn primary', href: base }, t('nav.home'))));
}
