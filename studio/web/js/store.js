// What the interface knows right now: the tools found, the open project, its
// jobs and their live log. Screens read it and subscribe to changes.

import { api } from '/js/api.js';
import { setLang, getLang, localLanguage, rememberLanguage, onLangChange } from '/js/i18n.js';

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
  /** A language the person chose that the project has not saved yet. */
  langPending: null,
  /** The screen in front of the person, as a conversation message carries it: { key, label, route }. */
  screen: null,
  /** Example requests the current screen suggests for the conversation. */
  screenExamples: null,
  /** How long AI calls took in this project, per tool, model and job (GET .../settings). */
  timings: [],
};

/** Load the measured timings of the open project. Quiet on failure. */
export async function loadTimings() {
  if (!state.projectId) return;
  const id = state.projectId;
  try {
    const res = await api.settings(id);
    if (state.projectId === id) state.timings = res.timings || [];
  } catch (err) { /* the estimates fall back to the times measured before the build */ }
}

/**
 * The measured time of a kind of work ('plan', 'look', 'draw') with the tool
 * and model that do it now, or null when nothing ran yet:
 * { per_page_ms, average_ms, runs }.
 */
export function measured(job) {
  const list = state.timings || [];
  const now = state.overview && state.overview.tools ? state.overview.tools[job] : null;
  const tool = now ? now.tool : null;
  const model = now ? (now.model || null) : null;
  const exact = list.find((e) => e.job === job && e.tool === tool && (e.model || null) === model && e.runs > 0);
  const any = exact || list.find((e) => e.job === job && e.tool === tool && e.runs > 0);
  if (!any) return null;
  // A call under five seconds is not a real drawing or plan (the fake tools
  // answer at once); estimating from it would promise the impossible.
  if ((any.per_page_ms || any.average_ms || 0) < 5000) return null;
  return { per_page_ms: any.per_page_ms, average_ms: any.average_ms, runs: any.runs };
}

/** The screen the next conversation message is sent from. */
export function setScreen(screen) {
  state.screen = screen;
  bus.emit('screen', screen);
}

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
/** The job running in the main lane; a chat turn answering beside it comes second. */
export function runningJob() {
  const running = jobList().filter((j) => j.status === 'running');
  return running.find((j) => !j.read_only) || running[0] || null;
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
    loadTimings();
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
  const pendingAtStart = state.langPending;
  const overview = await api.overview(id);
  if (state.projectId !== id) return null;
  state.overview = overview;
  if (!state.issue) {
    // The issue chosen before a reload of the tab (components/issues.js keeps it).
    try { state.issue = sessionStorage.getItem(`studio.issue.${id}`) || null; } catch (err) { state.issue = null; }
  }
  if (!state.issue || !overview.issues.some((i) => i.id === state.issue)) {
    state.issue = overview.first_issue || (overview.issues[0] && overview.issues[0].id) || 'ISS_001';
  }
  // The project's interface language wins, unless the person just chose
  // another one and the project has not saved it yet.
  if (!pendingAtStart && !state.langPending && overview.settings.language !== getLang()) {
    setLang(overview.settings.language);
    return state.overview;
  }
  bus.emit('overview', overview);
  return overview;
}

let streamLang = null;

function connect(id) {
  if (source) source.close();
  streamLang = getLang();
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
  loadTimings();
  await loadJobs().catch(() => {});
  bus.emit('project', id);
  return state.overview;
}

export function closeProject() {
  if (source) source.close();
  source = null;
  streamLang = null;
  clearTimeout(filesTimer);
  clearTimeout(overviewTimer);
  pendingPaths = new Set();
  const had = state.projectId;
  state.projectId = null;
  state.overview = null;
  state.jobs = new Map();
  state.logs = new Map();
  state.issue = null;
  state.timings = [];
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

// --- language ---------------------------------------------------------------

// The server writes job titles, step labels, summaries and errors in the
// language each request asks for, and the event stream in the language it was
// opened with. When the language changes, what the interface holds is asked
// for again: the overview, the recent jobs, and a new stream.
onLangChange((lang) => {
  if (!state.projectId) return;
  if (source && streamLang !== lang) connect(state.projectId);
  loadJobs().catch(() => {});
  refreshOverview().catch(() => {});
});

/**
 * The person picks the interface language. It applies at once, so every
 * request from now on asks for it, and inside a project it is saved there.
 */
export async function changeLanguage(lang) {
  rememberLanguage(lang);
  if (!state.projectId) {
    setLang(lang);
    return;
  }
  state.langPending = lang;
  setLang(lang);
  try {
    await api.saveSettings(state.projectId, { language: lang });
  } catch (err) {
    // Not saved: the project's own language comes back.
    state.langPending = null;
    await refreshOverview().catch(() => {});
    throw err;
  }
  state.langPending = null;
  await refreshOverview();
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
