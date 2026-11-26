// The queue. A job is anything the AI does or draws. The top bar shows the
// one that runs now; the drawer shows all of them with their steps, the live
// log on demand, the time, and a way to cancel. Nothing here blocks the rest
// of the interface: a drawing takes minutes and the person keeps working.

import { h, icon, mount, clear } from '/js/dom.js';
import { t, tn, formatDuration, formatTime } from '/js/i18n.js';
import { api, errorText } from '/js/api.js';
import { state, bus, jobList, activeJobs, runningJob, waitingJobs, rememberJob, measured, ACTIVE, ENDED } from '/js/store.js';
import { jobTitle, stepLabel, stepStatus, jobStatus, jobLink, jobOutcome, toolName, seconds } from '/js/labels.js';
import { button, actionButton, notice } from '/js/components/ui.js';
import { confirmDialog } from '/js/components/dialog.js';
import { toast } from '/js/components/toast.js';

// A note that is only an ID (a render name) says nothing to the person.
const ID_ONLY = /^[A-Z]{2,}(_[A-Z0-9]+)+$/;
const DRAW_STEP = /(^|:)(draw|sheet-draw|repair-\d+)$/;
const REVIEW_STEP = /(^|:)review(-\d+)?$/;
const openLogs = new Set();
const openJobs = new Set();
let drawerEl = null;
let tick = null;

function currentStep(job) {
  return job.steps && job.steps.find((s) => s.status === 'running');
}

/** What a step that takes minutes should tell the person. */
function waitHint(job, step) {
  if (!step) return null;
  if (DRAW_STEP.test(step.id) && step.tool !== 'person') return t('jobs.wait_draw');
  if (REVIEW_STEP.test(step.id)) return t('jobs.wait_review');
  if (step.tool !== 'claude' && step.tool !== 'codex') return null;
  if (job.op === 'pages.plan') return t('jobs.wait_plan_pages');
  if (job.op === 'style.define') return t('jobs.wait_style');
  if (['project.setup', 'story.draft', 'story.complete', 'story.suggest', 'story.update'].includes(job.op)) return t('jobs.wait_story');
  return t('jobs.wait_ai');
}

/**
 * How long the rest of a job is likely to take: from the times measured in
 * this project with the tool and model that do the work now, else from the
 * times measured with the real tools before the build (a drawing two to five
 * minutes, its check under a minute, planning about four minutes a page).
 */
function estimate(job) {
  if (job.status !== 'running' && job.status !== 'queued') return null;
  if (job.op === 'pages.generate') {
    const scopes = new Set();
    for (const step of job.steps || []) {
      const id = String(step.id);
      if (/:draw$/.test(id) && !['done', 'failed', 'skipped', 'cancelled'].includes(step.status)) scopes.add(id.split(':')[0]);
    }
    if (!scopes.size) return null;
    const draw = measured('draw');
    const look = measured('look');
    if (draw && (draw.per_page_ms || draw.average_ms)) {
      const per = (draw.per_page_ms || draw.average_ms) + ((look && (look.per_page_ms || look.average_ms)) || 0);
      return tn('jobs.estimate_measured', scopes.size, { time: formatDuration((per * scopes.size) / 1000) });
    }
    return tn('jobs.estimate_pages', scopes.size, { from: scopes.size * 3, to: scopes.size * 6 });
  }
  if (job.op === 'pages.plan') {
    const pages = Number(job.params && job.params.pages) || 1;
    const plan = measured('plan');
    if (plan && plan.per_page_ms) return t('jobs.estimate_plan_measured', { time: formatDuration((plan.per_page_ms * pages) / 1000) });
    return t('jobs.estimate_plan', { n: pages * 4 });
  }
  return null;
}

function stepRow(job, step) {
  const running = step.status === 'running';
  const time = step.started_at && (running || step.ended_at)
    ? formatDuration(seconds(step.started_at, running ? null : step.ended_at))
    : '';
  return h('li', { class: 'step', dataset: { status: step.status } },
    h('span', { class: 'step-mark', 'aria-hidden': 'true' }),
    h('div', { class: 'grow' },
      h('div', { class: 'step-line' },
        h('span', { class: 'step-label' }, stepLabel(job, step)),
        h('span', { class: 'step-state' }, stepStatus(step.status), step.tool ? ` · ${toolName(step.tool)}` : '')),
      step.note && !ID_ONLY.test(step.note) ? h('div', { class: 'step-note' }, step.note) : null),
    time ? h('span', { class: 'step-time', dataset: running ? { since: step.started_at } : null }, time) : null);
}

async function cancelJob(job) {
  const running = job.status === 'running';
  await confirmDialog({
    title: t('jobs.cancel_title'),
    body: running ? t('jobs.cancel_running_body') : t('jobs.cancel_queued_body'),
    confirm: t('jobs.cancel_confirm'),
    cancel: t('jobs.cancel_keep'),
    danger: true,
    run: async () => {
      const { job: after } = await api.cancelJob(job.project, job.id);
      rememberJob(after);
    },
  });
}

function logView(job) {
  const pre = h('pre', { class: 'log', tabIndex: 0, 'aria-label': t('jobs.log_label') }, t('state.loading'));
  let lines = [];
  const paint = () => {
    pre.textContent = lines.length ? lines.join('\n') : t('jobs.log_empty');
    pre.scrollTop = pre.scrollHeight;
  };
  api.jobLog(job.project, job.id, 300).then((res) => {
    lines = res.lines || [];
    paint();
  }).catch((err) => { pre.textContent = errorText(err); });
  const off = bus.on('log', (entry) => {
    if (entry.job !== job.id || !document.contains(pre)) {
      if (!document.contains(pre)) off();
      return;
    }
    lines.push(`${entry.at} ${entry.step || '-'} ${entry.line}`);
    if (lines.length > 400) lines.shift();
    paint();
  });
  return pre;
}

/** One job, in full. Used in the drawer and inline on screens that started it. */
export function jobCard(job, { compact = false, open } = {}) {
  const active = ACTIVE.includes(job.status);
  const isOpen = open !== undefined ? open : (active || openJobs.has(job.id));
  const step = currentStep(job);
  const hint = job.status === 'running' ? waitHint(job, step) : null;
  const link = jobLink(job);
  const outcome = jobOutcome(job);
  const elapsed = job.started_at ? formatDuration(seconds(job.started_at, job.ended_at)) : '';
  const head = h('summary', { class: 'job-head' },
    h('span', { class: 'job-title' }, jobTitle(job)),
    h('span', { class: 'job-state', dataset: { status: job.status } }, jobStatus(job)),
    elapsed ? h('span', { class: 'job-time', dataset: job.status === 'running' ? { since: job.started_at } : null }, elapsed) : null);
  const logHolder = h('div');
  const showLog = () => {
    if (openLogs.has(job.id)) {
      mount(logHolder, logView(job));
      logBtn.querySelector('span').textContent = t('jobs.hide_log');
    } else {
      clear(logHolder);
      logBtn.querySelector('span').textContent = t('jobs.show_log');
    }
    logBtn.setAttribute('aria-expanded', String(openLogs.has(job.id)));
  };
  const logBtn = button(t('jobs.show_log'), {
    kind: 'quiet', small: true, icon: 'file',
    onclick: () => {
      if (openLogs.has(job.id)) openLogs.delete(job.id); else openLogs.add(job.id);
      showLog();
    },
  });
  const el = h('details', { class: `job${compact ? ' compact' : ''}`, open: isOpen, dataset: { job: job.id, status: job.status } },
    head,
    h('div', { class: 'job-body' },
      job.status === 'queued' ? h('p', { class: 'muted small' }, t('jobs.queued_hint')) : null,
      job.steps && job.steps.length ? h('ol', { class: 'steps' }, job.steps.map((s) => stepRow(job, s))) : null,
      hint || estimate(job) ? h('p', { class: 'wait-hint' }, icon('clock'), ' ', h('span', null, [estimate(job), hint].filter(Boolean).join(' '))) : null,
      job.status === 'needs_decision'
        ? notice('next', h('strong', null, t('jobs.needs_decision')), ' ',
          h('a', { href: `/p/${encodeURIComponent(job.project)}/decisions` }, t('jobs.answer_link')))
        : null,
      ENDED.includes(job.status) && outcome
        ? h('p', { class: `job-outcome ${job.status === 'failed' ? 'bad' : ''}` }, outcome)
        : null,
      job.status === 'done' && job.result && Array.isArray(job.result.decisions) && job.result.decisions.length
        ? h('div', { class: 'decisions' }, h('p', { class: 'small muted' }, t('jobs.decisions_made')),
          h('ul', { class: 'bullets' }, job.result.decisions.map((d) => h('li', null, d))))
        : null,
      h('div', { class: 'row' },
        active ? button(t('jobs.cancel'), { kind: 'quiet', small: true, icon: 'close', onclick: () => cancelJob(job) }) : null,
        logBtn,
        link && job.status === 'done' ? h('a', { class: 'btn quiet small', href: link }, t('jobs.see_result')) : null,
        job.cost_usd ? h('span', { class: 'small faint' }, t('jobs.cost', { usd: Number(job.cost_usd).toFixed(2) })) : null),
      logHolder));
  el.addEventListener('toggle', () => {
    if (el.open) openJobs.add(job.id); else openJobs.delete(job.id);
  });
  showLog();
  return el;
}

function drawerBody() {
  const jobs = jobList();
  const active = activeJobs();
  const ended = jobs.filter((j) => ENDED.includes(j.status)).slice(0, 12);
  if (!state.projectId) return h('p', { class: 'muted' }, t('jobs.no_project'));
  return h('div', { class: 'stack-s' },
    state.connection === 'lost' ? notice('warn', t('jobs.connection_lost')) : null,
    h('section', null,
      h('h3', null, t('jobs.now')),
      active.length
        ? h('div', { class: 'stack-s' }, active.map((j) => jobCard(j)))
        : h('p', { class: 'muted' }, t('jobs.none_active'))),
    active.length > 1 ? h('p', { class: 'small muted' }, t('jobs.one_at_a_time')) : null,
    h('section', null,
      h('h3', null, t('jobs.finished')),
      ended.length
        ? h('div', { class: 'stack-s' }, ended.map((j) => jobCard(j, { open: openJobs.has(j.id) })))
        : h('p', { class: 'muted' }, t('jobs.none_finished'))));
}

function paintDrawer() {
  if (!drawerEl) return;
  const body = drawerEl.querySelector('.drawer-body');
  const top = body.scrollTop;
  const active = document.activeElement;
  const focusJob = active && body.contains(active) && active.closest('[data-job]') ? active.closest('[data-job]').dataset.job : null;
  const wasSummary = active && active.tagName === 'SUMMARY';
  mount(body, drawerBody());
  body.scrollTop = top;
  if (focusJob) {
    const card = body.querySelector(`[data-job="${CSS.escape(focusJob)}"]`);
    const target = card && (wasSummary ? card.querySelector('summary') : card.querySelector('button, a') || card.querySelector('summary'));
    if (target) target.focus({ preventScroll: true });
  }
}

export function closeDrawer() {
  if (!drawerEl) return;
  const opener = drawerEl.opener;
  drawerEl.remove();
  drawerEl = null;
  bus.emit('drawer', false);
  // The button that opened the drawer is repainted on every job event.
  const back = opener && document.contains(opener) ? opener : document.querySelector('.job-chip');
  if (back) back.focus();
}

export function openDrawer() {
  if (drawerEl) {
    drawerEl.querySelector('.drawer-close').focus();
    return;
  }
  const closeBtn = h('button', { type: 'button', class: 'btn icon-only quiet drawer-close', 'aria-label': t('action.close'), onclick: closeDrawer }, icon('close'));
  drawerEl = h('aside', { class: 'drawer', 'aria-label': t('jobs.title') },
    h('div', { class: 'drawer-head' }, h('h2', null, t('jobs.title')), closeBtn),
    h('div', { class: 'drawer-body', dataset: { scroll: 'jobs' } }));
  drawerEl.opener = document.activeElement;
  drawerEl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer();
  });
  document.getElementById('drawer-root').append(drawerEl);
  paintDrawer();
  closeBtn.focus();
  bus.emit('drawer', true);
}

export function toggleDrawer() {
  if (drawerEl) closeDrawer(); else openDrawer();
}

/** The button in the top bar: the running job as a caption box, or a quiet "Queue". */
export function jobsIndicator() {
  const el = h('div', { class: 'jobs-indicator' });
  const paint = () => {
    const running = runningJob();
    const active = activeJobs();
    const waiting = waitingJobs();
    const queued = active.filter((j) => j.status === 'queued').length;
    const nodes = [];
    if (waiting.length && state.projectId) {
      nodes.push(h('a', { class: 'decision-chip', href: `/p/${encodeURIComponent(state.projectId)}/decisions` },
        icon('alert'), h('span', null, t('jobs.decision_chip'))));
    }
    if (running) {
      const step = currentStep(running);
      nodes.push(h('button', { type: 'button', class: 'job-chip running', onclick: toggleDrawer, 'aria-expanded': String(!!drawerEl), title: t('jobs.open') },
        h('span', { class: 'pulse', 'aria-hidden': 'true' }),
        h('span', { class: 'chip-text' },
          h('strong', null, jobTitle(running)),
          step && stepLabel(running, step) !== jobTitle(running) ? h('span', { class: 'chip-step' }, stepLabel(running, step)) : null),
        h('span', { class: 'chip-time', dataset: { since: (step && step.started_at) || running.started_at } },
          formatDuration(seconds((step && step.started_at) || running.started_at))),
        queued ? h('span', { class: 'chip-more' }, t('jobs.more_queued', { n: queued })) : null));
    } else {
      nodes.push(h('button', { type: 'button', class: 'job-chip', onclick: toggleDrawer, 'aria-expanded': String(!!drawerEl), disabled: !state.projectId },
        icon('queue'),
        h('span', null, queued ? tn('jobs.queued_count', queued) : t('jobs.title'))));
    }
    const focused = el.contains(document.activeElement) ? document.activeElement.className : null;
    mount(el, nodes);
    if (focused) {
      const again = [...el.children].find((c) => c.className === focused);
      if (again) again.focus({ preventScroll: true });
    }
  };
  paint();
  bus.on('job', paint);
  bus.on('project', paint);
  bus.on('drawer', paint);
  bus.on('repaint', paint);
  return el;
}

/** Start once: repaint the drawer on changes, tick the clocks, say when a job ends. */
export function startJobs() {
  bus.on('job', paintDrawer);
  bus.on('project', (id) => {
    if (!id) closeDrawer(); else paintDrawer();
  });
  bus.on('connection', paintDrawer);
  bus.on('repaint', paintDrawer);
  bus.on('job-ended', (job) => {
    if (job.op === 'chat.turn') return;
    const link = jobLink(job);
    const here = link && location.pathname === link;
    // On the screen that shows the result, a finished job needs no announcement.
    if (here && job.status === 'done') return;
    const text = `${jobTitle(job)}: ${jobOutcome(job) || jobStatus(job)}`;
    toast(text, {
      kind: job.status === 'failed' ? 'bad' : (job.status === 'cancelled' ? 'warn' : 'ok'),
      link: link && !here ? { href: link, label: t('jobs.see_result') } : null,
    });
  });
  bus.on('job-waiting', (job) => {
    toast(t('jobs.needs_decision'), { kind: 'warn', link: { href: `/p/${encodeURIComponent(job.project)}/decisions`, label: t('jobs.answer_link') } });
  });
  clearInterval(tick);
  tick = setInterval(() => {
    for (const el of document.querySelectorAll('[data-since]')) {
      el.textContent = formatDuration(seconds(el.dataset.since));
    }
  }, 1000);
}

/**
 * The state of the jobs that match, for a screen that started them: the
 * active ones in full, and the last finished one with its outcome. Repaints
 * itself as events arrive.
 */
export function jobsFor(test, { showLast = true, emptyNode = null } = {}) {
  const el = h('div', { class: 'jobs-inline' });
  const paint = () => {
    if (!document.contains(el) && el.dataset.mounted) {
      off();
      return;
    }
    const all = jobList().filter(test);
    const active = all.filter((j) => ACTIVE.includes(j.status)).reverse();
    const last = showLast ? all.find((j) => ENDED.includes(j.status)) : null;
    const nodes = active.map((j) => jobCard(j, { compact: true, open: true }));
    if (!active.length && last && (last.status === 'failed' || last.status === 'cancelled')) {
      nodes.push(jobCard(last, { compact: true, open: openJobs.has(last.id) }));
    }
    if (!nodes.length && emptyNode) nodes.push(emptyNode);
    mount(el, nodes);
    el.dataset.mounted = '1';
  };
  const off = bus.on('job', paint);
  paint();
  return el;
}

export { formatTime };

/** A small node rebuilt on every job event, for a line that follows the queue. */
export function liveNode(build, tag = 'span') {
  const el = h(tag, { class: 'live' });
  const paint = () => {
    if (!document.contains(el) && el.dataset.mounted) {
      off();
      return;
    }
    mount(el, build());
    el.dataset.mounted = '1';
  };
  const off = bus.on('job', paint);
  paint();
  return el;
}

/**
 * Where a page stands in the drawing queue right now, or null when no job
 * is working on it: { state: 'drawing' | 'checking' | 'repairing' | 'preparing' | 'waiting', job, step }.
 */
export function pageQueueState(pageId) {
  for (const job of activeJobs()) {
    if (!['pages.generate', 'page.correct', 'page.review', 'page.manual'].includes(job.op)) continue;
    const p = job.params || {};
    const single = p.page === pageId || (p.render && String(p.render).startsWith(pageId));
    const steps = (job.steps || []).filter((s) => (single ? true : String(s.id).startsWith(`${pageId}:`)));
    if (!single && !steps.length) continue;
    if (!single && steps.every((s) => ['done', 'skipped', 'failed', 'cancelled'].includes(s.status))) continue;
    const running = steps.find((s) => s.status === 'running');
    if (!running) return { state: 'waiting', job, step: null };
    const id = String(running.id).split(':').pop();
    let kind = 'preparing';
    if (/^repair/.test(id)) kind = 'repairing';
    else if (/^review/.test(id)) kind = 'checking';
    else if (id === 'draw') kind = 'drawing';
    return { state: kind, job, step: running };
  }
  return null;
}
