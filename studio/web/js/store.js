// What the interface knows right now: the tools found, the open project, its
// jobs and their live log. Screens read it and subscribe to changes.

import { api } from '/js/api.js';
import { setLang, localLanguage } from '/js/i18n.js';

export const state = {
  health: null,
  projectId: null,
  overview: null,
  /** @type {Map<string, object>} */
  jobs: new Map(),
  /** Live log lines per job id, as they arrive. */
  logs: new Map(),
  connection: 'idle', // idle | connecting | live | lost
  issue: null,
};

const listeners = new Map();

export const bus = {
  on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type).delete(fn);
  },
  emit(type, data) {
    const set = listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(data); } catch (err) { console.error(err); }
    }
  },
};

export const ACTIVE = ['queued', 'running', 'needs_decision'];
export const ENDED = ['done', 'failed', 'cancelled'];

export function jobList() {
  return [...state.jobs.values()].sort((a, b) => (a.id < b.id ? 1 : -1));
}
export function activeJobs() {
  return jobList().filter((j) => ACTIVE.includes(j.status)).reverse();
}
export function runningJob() {
  return jobList().find((j) => j.status === 'running') || null;
}
export function waitingJobs() {
  return jobList().filter((j) => j.status === 'needs_decision');
}
/** The newest job that matches, whatever its state. */
export function findJob(test) {
  return jobList().find(test) || null;
}

export async function loadHealth(refresh) {
  state.health = await api.health(refresh);
  bus.emit('health', state.health);
  return state.health;
}

let source = null;
let filesTimer = null;
let pendingPaths = new Set();
let overviewTimer = null;

function putJob(job) {
  const before = state.jobs.get(job.id);
  state.jobs.set(job.id, job);
  bus.emit('job', { job, before: before || null });
  // Only a job seen while it was active counts as ending now: one loaded
  // already finished is old news.
  if (ENDED.includes(job.status) && before && !ENDED.includes(before.status)) {
    bus.emit('job-ended', job);
    scheduleOverview();
  }
  if (job.status === 'needs_decision' && (!before || before.status !== 'needs_decision')) {
    bus.emit('job-waiting', job);
  }
}

function scheduleOverview() {
  clearTimeout(overviewTimer);
  overviewTimer = setTimeout(() => { refreshOverview().catch(() => {}); }, 250);
}

export async function refreshOverview() {
  if (!state.projectId) return null;
  const id = state.projectId;
  const overview = await api.overview(id);
  if (state.projectId !== id) return null;
  state.overview = overview;
  if (!state.issue || !overview.issues.some((i) => i.id === state.issue)) {
    state.issue = overview.first_issue || (overview.issues[0] && overview.issues[0].id) || 'ISS_001';
  }
  setLang(overview.settings.language);
  bus.emit('overview', overview);
  return overview;
}

function connect(id) {
  if (source) source.close();
  state.connection = 'connecting';
  bus.emit('connection', state.connection);
  source = new EventSource(api.eventsUrl(id));
  const parse = (event) => {
    try { return JSON.parse(event.data); } catch (err) { return null; }
  };
  source.addEventListener('open', () => {
    state.connection = 'live';
    bus.emit('connection', state.connection);
  });
  source.addEventListener('error', () => {
    state.connection = 'lost';
    bus.emit('connection', state.connection);
  });
  source.addEventListener('hello', (event) => {
    const data = parse(event);
    if (!data || state.projectId !== id) return;
    state.connection = 'live';
    bus.emit('connection', state.connection);
    for (const job of data.jobs || []) putJob(job);
    // A job that ended while the stream was down is not in "hello".
    const live = new Set((data.jobs || []).map((j) => j.id));
    const stale = jobList().filter((j) => ACTIVE.includes(j.status) && !live.has(j.id));
    if (stale.length) loadJobs().catch(() => {});
  });
  source.addEventListener('job', (event) => {
    const data = parse(event);
    if (data && data.job && state.projectId === id) putJob(data.job);
  });
  source.addEventListener('log', (event) => {
    const data = parse(event);
    if (!data || state.projectId !== id) return;
    if (!state.logs.has(data.job)) state.logs.set(data.job, []);
    const lines = state.logs.get(data.job);
    lines.push(data);
    if (lines.length > 400) lines.splice(0, lines.length - 400);
    bus.emit('log', data);
  });
  source.addEventListener('activity', (event) => {
    const data = parse(event);
    if (data && state.projectId === id) bus.emit('activity', data.entry);
  });
  source.addEventListener('chat', (event) => {
    const data = parse(event);
    if (data && state.projectId === id) bus.emit('chat', data);
  });
  source.addEventListener('files', (event) => {
    const data = parse(event);
    if (!data || state.projectId !== id) return;
    for (const p of data.paths || []) pendingPaths.add(p);
    clearTimeout(filesTimer);
    filesTimer = setTimeout(() => {
      const paths = [...pendingPaths];
      pendingPaths = new Set();
      scheduleOverview();
      bus.emit('files', { paths });
    }, 350);
  });
}

export async function loadJobs() {
  if (!state.projectId) return;
  const id = state.projectId;
  const { jobs } = await api.jobs(id, '?limit=40');
  if (state.projectId !== id) return;
  for (const job of jobs) putJob(job);
}

/** Open a project: its overview, its recent jobs, and the live stream. */
export async function openProject(id) {
  if (state.projectId === id && state.overview) return state.overview;
  closeProject();
  state.projectId = id;
  try {
    await refreshOverview();
  } catch (err) {
    state.projectId = null;
    throw err;
  }
  connect(id);
  await loadJobs().catch(() => {});
  bus.emit('project', id);
  return state.overview;
}

export function closeProject() {
  if (source) source.close();
  source = null;
  clearTimeout(filesTimer);
  clearTimeout(overviewTimer);
  pendingPaths = new Set();
  const had = state.projectId;
  state.projectId = null;
  state.overview = null;
  state.jobs = new Map();
  state.logs = new Map();
  state.issue = null;
  state.connection = 'idle';
  if (had) {
    setLang(localLanguage());
    bus.emit('project', null);
  }
}

/** Start an operation in the open project and keep its job. */
export async function startOp(op, params) {
  const { job } = await api.startOp(state.projectId, op, params);
  rememberJob(job);
  return state.jobs.get(job.id) || job;
}

/**
 * Keep a job that came back from a request. The event stream can be ahead of
 * the answer to the request that started the job, so a state the stream
 * already delivered is never replaced by an older one.
 */
export function rememberJob(job) {
  if (!job) return;
  const known = state.jobs.get(job.id);
  if (known && ENDED.includes(known.status)) return;
  if (known && job.status === 'queued' && known.status === 'running') return;
  putJob(job);
}

/** Resolves when the job ends or pauses for a decision. */
export function whenJobSettles(jobId) {
  return new Promise((resolve) => {
    const check = () => {
      const job = state.jobs.get(jobId);
      if (job && (ENDED.includes(job.status) || job.status === 'needs_decision')) {
        off();
        resolve(job);
        return true;
      }
      return false;
    };
    const off = bus.on('job', check);
    check();
  });
}

// --- theme ------------------------------------------------------------------

const THEME_KEY = 'studio.theme';

export function getTheme() {
  let stored = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch (err) { /* storage is off */ }
  return ['light', 'dark'].includes(stored) ? stored : 'auto';
}

export function setTheme(theme) {
  try {
    if (theme === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch (err) { /* storage is off */ }
  applyTheme();
}

export function applyTheme() {
  const theme = getTheme();
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  bus.emit('theme', theme);
}

export function effectiveTheme() {
  const theme = getTheme();
  if (theme !== 'auto') return theme;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
