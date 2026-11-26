// The one place that talks to the server. Every route of studio/docs/api.md
// the interface uses goes through request().

import { t, getLang } from '/js/i18n.js';

/**
 * A refusal. For an answer of the server, `message` is its sentence in the
 * language of the request and `params.detail` the exact technical text (the
 * file, the ID, the value). `local` marks an error the browser made itself
 * (no answer at all, or one that is not the server's JSON).
 */
export class ApiError extends Error {
  constructor(status, code, message, { details, params, local } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details || null;
    this.params = params || {};
    this.detail = this.params.detail || null;
    this.local = !!local;
  }
}

/** Every request carries the language of the interface, so the server writes in it. */
export function withLang(path) {
  return `${path}${path.includes('?') ? '&' : '?'}lang=${encodeURIComponent(getLang())}`;
}

async function request(method, path, { body, raw, signal } = {}) {
  const init = { method, headers: {}, signal };
  path = withLang(path);
  if (raw !== undefined) {
    init.body = raw;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'offline', t('error.offline'), { local: true });
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (err) { data = null; }
  }
  if (!res.ok) {
    const e = data && data.error ? data.error : null;
    if (!e || !e.message) {
      throw new ApiError(res.status, (e && e.code) || 'http_error', t('error.http', { status: res.status }), { local: true });
    }
    throw new ApiError(res.status, e.code || 'http_error', e.message, { details: e.details, params: e.params });
  }
  return data;
}

/**
 * The message to show for a failed call. The server already wrote it in the
 * language of the request; the browser words only what it found itself.
 */
export function errorText(err) {
  if (!err) return '';
  return err.message || String(err);
}

const enc = encodeURIComponent;
/** A query string from the values that are set: q({ tail: 20 }) is "?tail=20". */
const q = (params) => {
  const parts = Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== false && v !== '');
  return parts.length ? `?${parts.map(([k, v]) => `${k}=${enc(v)}`).join('&')}` : '';
};
const project = (id) => `/api/projects/${enc(id)}`;

export const api = {
  health: (refresh) => request('GET', `/api/health${q({ refresh: refresh ? 1 : null })}`),
  presets: () => request('GET', '/api/presets'),
  schema: (name) => request('GET', `/api/schemas/${enc(name)}`),

  projects: () => request('GET', '/api/projects'),
  createProject: (body) => request('POST', '/api/projects', { body }),
  overview: (id) => request('GET', project(id)),
  deleteProject: (id, force) => request('DELETE', `${project(id)}${q({ force: force ? 1 : null })}`),

  settings: (id) => request('GET', `${project(id)}/settings`),
  saveSettings: (id, body) => request('PUT', `${project(id)}/settings`, { body }),
  options: (id) => request('GET', `${project(id)}/options`),
  saveOptions: (id, body) => request('PUT', `${project(id)}/options`, { body }),

  story: (id) => request('GET', `${project(id)}/story`),
  style: (id) => request('GET', `${project(id)}/style`),
  characters: (id) => request('GET', `${project(id)}/characters`),
  character: (id, char) => request('GET', `${project(id)}/characters/${enc(char)}`),
  entities: (id) => request('GET', `${project(id)}/entities`),
  location: (id, loc) => request('GET', `${project(id)}/locations/${enc(loc)}`),
  prop: (id, prop) => request('GET', `${project(id)}/props/${enc(prop)}`),
  issues: (id) => request('GET', `${project(id)}/issues`),
  issue: (id, issue) => request('GET', `${project(id)}/issues/${enc(issue)}`),
  page: (id, page) => request('GET', `${project(id)}/pages/${enc(page)}`),
  cover: (id, issue) => request('GET', `${project(id)}/issues/${enc(issue)}/cover`),
  publish: (id, issue) => request('GET', `${project(id)}/issues/${enc(issue)}/publish`),

  file: (id, path) => request('GET', `${project(id)}/file${q({ path })}`),
  saveFile: (id, body) => request('PUT', `${project(id)}/file`, { body }),

  uploads: (id) => request('GET', `${project(id)}/uploads`),
  upload: (id, file) => request('POST', `${project(id)}/uploads${q({ name: file.name })}`, { raw: file }),
  deleteUpload: (id, upload) => request('DELETE', `${project(id)}/uploads/${enc(upload)}`),

  startOp: (id, op, params) => request('POST', `${project(id)}/ops`, { body: { op, params: params || {} } }),
  jobs: (id, query = '') => request('GET', `${project(id)}/jobs${query}`),
  job: (id, job) => request('GET', `${project(id)}/jobs/${enc(job)}`),
  jobLog: (id, job, tail) => request('GET', `${project(id)}/jobs/${enc(job)}/log${q({ tail })}`),
  cancelJob: (id, job) => request('POST', `${project(id)}/jobs/${enc(job)}/cancel`, { body: {} }),
  answerJob: (id, job, answers) => request('POST', `${project(id)}/jobs/${enc(job)}/answer`, { body: { answers } }),

  /** The project conversation: one per project, every message tagged with its screen. */
  conversation: (id) => request('GET', `${project(id)}/conversation`),
  sendMessage: (id, text, screen) => request('POST', `${project(id)}/conversation`, { body: { text, screen } }),
  newConversation: (id) => request('POST', `${project(id)}/conversation/new`, { body: {} }),
  conversations: (id) => request('GET', `${project(id)}/conversations`),
  conversationById: (id, conv) => request('GET', `${project(id)}/conversations/${enc(conv)}`),
  /** Deprecated per-screen chats; the server keeps them for older clients. Not used by the screens. */
  chats: (id) => request('GET', `${project(id)}/chats`),
  chat: (id, key) => request('GET', `${project(id)}/chats/${enc(key)}`),
  sendChat: (id, key, text) => request('POST', `${project(id)}/chats/${enc(key)}`, { body: { text } }),

  proposals: (id, status) => request('GET', `${project(id)}/proposals${q({ status })}`),
  proposal: (id, prop) => request('GET', `${project(id)}/proposals/${enc(prop)}`),
  decideProposal: (id, prop, decisions) => request('POST', `${project(id)}/proposals/${enc(prop)}/decide`, { body: { decisions } }),
  discardProposal: (id, prop) => request('DELETE', `${project(id)}/proposals/${enc(prop)}`),

  refreshTools: () => request('POST', '/api/tools/refresh', { body: {} }),

  history: (id, query = '') => request('GET', `${project(id)}/history${query}`),
  restore: (id, entry) => request('POST', `${project(id)}/history/restore`, { body: { entry } }),
  /** What a commit changed ({ commit }), or what changed between two ({ from, to }). */
  diff: (id, { commit, from, to, limit }) => request('GET', `${project(id)}/diff${q({ commit, from, to, limit })}`),

  approveAsset: (id, body) => request('POST', `${project(id)}/approve/asset`, { body }),
  approvePlan: (id, pages, approved = true) => request('POST', `${project(id)}/approve/plan`, { body: { pages, approved } }),
  approvePage: (id, body) => request('POST', `${project(id)}/approve/page`, { body }),
  approveCover: (id, body) => request('POST', `${project(id)}/approve/cover`, { body }),

  lettering: (id, page, render) => request('GET', `${project(id)}/pages/${enc(page)}/lettering${q({ render })}`),
  sendLettered: (id, page, render, blob) => request('POST', `${project(id)}/pages/${enc(page)}/lettered${q({ render })}`, { raw: blob }),

  eventsUrl: (id) => withLang(`${project(id)}/events`),
  /** A file of the workspace as it was at a commit (an image to load, not JSON). */
  atRawUrl: (id, commit, path) => `${project(id)}/at/${enc(commit)}/raw/${String(path).split('/').map(enc).join('/')}`,
};
