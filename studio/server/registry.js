'use strict';
/**
 * The studio home and the projects in it.
 *
 *   <home>/<project id>/production/   the scaffold workspace
 *   <home>/<project id>/.studio/      settings, state, activity, jobs, chats, uploads
 *   <home>/<project id>/.git/         one commit per finished step
 *   <home>/.trash/                    deleted projects (moved, never removed)
 *
 * A project is any directory under the home that holds production/project.yaml.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  HttpError, readJson, writeJsonAtomic, appendJsonl, readJsonl, isFile, isDir, slug, newId, nowIso,
} = require('./util');
const { safeName } = require('./security');

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const DEFAULT_SETTINGS = {
  language: 'en',
  drivers: { plan: 'claude', look: 'claude', draw: 'codex' },
  models: {
    claude: { plan: null, look: 'sonnet' },
    codex: { plan: null, look: null, draw: null },
  },
  repair_limit: null,
  // Text-only actions the chat proposes run at once (never drawings, approvals or answers).
  chat_auto_run: false,
};

const DRIVER_CHOICES = {
  plan: ['claude', 'codex'],
  look: ['claude', 'codex'],
  draw: ['codex', 'manual'],
};

const LANGUAGES = ['en', 'es'];

function defaultHome() {
  return process.env.STUDIO_HOME ? path.resolve(process.env.STUDIO_HOME) : path.join(os.homedir(), 'comics-studio');
}

/** Settings merged over the defaults, so an older file gains new keys. */
function mergeSettings(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (LANGUAGES.includes(s.language)) out.language = s.language;
  for (const verb of Object.keys(DRIVER_CHOICES)) {
    if (s.drivers && DRIVER_CHOICES[verb].includes(s.drivers[verb])) out.drivers[verb] = s.drivers[verb];
  }
  for (const driver of Object.keys(out.models)) {
    for (const verb of Object.keys(out.models[driver])) {
      const value = s.models && s.models[driver] ? s.models[driver][verb] : undefined;
      if (value === null || (typeof value === 'string' && /^[A-Za-z0-9._:\-[\]]{1,80}$/.test(value))) {
        out.models[driver][verb] = value;
      }
    }
  }
  if (s.repair_limit === null || (Number.isInteger(s.repair_limit) && s.repair_limit >= 0 && s.repair_limit <= 10)) {
    out.repair_limit = s.repair_limit === undefined ? null : s.repair_limit;
  }
  if (typeof s.chat_auto_run === 'boolean') out.chat_auto_run = s.chat_auto_run;
  return out;
}

/** Validate a settings patch from the API. Throws 400 with the first problem. */
function checkSettingsPatch(patch) {
  const bad = (message) => { throw new HttpError(400, 'bad_settings', message); };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) bad('Settings must be an object.');
  if (patch.language !== undefined && !LANGUAGES.includes(patch.language)) bad(`language must be one of ${LANGUAGES.join(', ')}.`);
  if (patch.drivers !== undefined) {
    if (!patch.drivers || typeof patch.drivers !== 'object') bad('drivers must be an object.');
    for (const [verb, value] of Object.entries(patch.drivers)) {
      if (!DRIVER_CHOICES[verb]) bad(`Unknown verb "${verb}" (use plan, look, draw).`);
      if (!DRIVER_CHOICES[verb].includes(value)) bad(`drivers.${verb} must be one of ${DRIVER_CHOICES[verb].join(', ')}.`);
    }
  }
  if (patch.models !== undefined) {
    if (!patch.models || typeof patch.models !== 'object') bad('models must be an object.');
    for (const [driver, verbs] of Object.entries(patch.models)) {
      if (!DEFAULT_SETTINGS.models[driver]) bad(`Unknown driver "${driver}" in models.`);
      if (!verbs || typeof verbs !== 'object') bad(`models.${driver} must be an object.`);
      for (const [verb, value] of Object.entries(verbs)) {
        if (!(verb in DEFAULT_SETTINGS.models[driver])) bad(`models.${driver}.${verb} is not a setting.`);
        if (value !== null && !(typeof value === 'string' && /^[A-Za-z0-9._:\-[\]]{1,80}$/.test(value))) {
          bad(`models.${driver}.${verb} must be a model name or null.`);
        }
      }
    }
  }
  if (patch.repair_limit !== undefined && patch.repair_limit !== null &&
      !(Number.isInteger(patch.repair_limit) && patch.repair_limit >= 0 && patch.repair_limit <= 10)) {
    bad('repair_limit must be null or a whole number from 0 to 10.');
  }
  if (patch.chat_auto_run !== undefined && typeof patch.chat_auto_run !== 'boolean') bad('chat_auto_run must be true or false.');
}

/** One project on disk. Cheap to create; holds no open handles. */
class Project {
  constructor(home, id) {
    this.home = home;
    this.id = id;
    this.dir = path.join(home, id);
    this.root = path.join(this.dir, 'production');
    this.studioDir = path.join(this.dir, '.studio');
    this.jobsDir = path.join(this.studioDir, 'jobs');
    this.chatsDir = path.join(this.studioDir, 'chats');
    this.uploadsDir = path.join(this.studioDir, 'uploads');
    this.tmpDir = path.join(this.studioDir, 'tmp');
  }

  exists() {
    return isFile(path.join(this.root, 'project.yaml'));
  }

  ensureStudioDirs() {
    for (const dir of [this.studioDir, this.jobsDir, this.chatsDir, this.uploadsDir, this.tmpDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  settings() {
    return mergeSettings(readJson(path.join(this.studioDir, 'settings.json'), {}));
  }

  saveSettings(patch) {
    checkSettingsPatch(patch);
    const current = this.settings();
    const next = mergeSettings({
      language: patch.language !== undefined ? patch.language : current.language,
      drivers: Object.assign({}, current.drivers, patch.drivers || {}),
      models: {
        claude: Object.assign({}, current.models.claude, (patch.models && patch.models.claude) || {}),
        codex: Object.assign({}, current.models.codex, (patch.models && patch.models.codex) || {}),
      },
      repair_limit: patch.repair_limit !== undefined ? patch.repair_limit : current.repair_limit,
      chat_auto_run: patch.chat_auto_run !== undefined ? patch.chat_auto_run : current.chat_auto_run,
    });
    writeJsonAtomic(path.join(this.studioDir, 'settings.json'), next);
    return next;
  }

  /** Studio-side state that is not part of the scaffold workspace. */
  state() {
    const state = readJson(path.join(this.studioDir, 'state.json'), {}) || {};
    return Object.assign({ description: '', look_id: null, plan_approvals: {}, chat_sessions: {}, setup: {} }, state);
  }

  saveState(patch) {
    const next = Object.assign(this.state(), patch);
    writeJsonAtomic(path.join(this.studioDir, 'state.json'), next);
    return next;
  }

  // --- activity -----------------------------------------------------------

  activityFile() {
    return path.join(this.studioDir, 'activity.jsonl');
  }

  /** Append an activity entry and return it with its id and time. */
  addActivity(entry) {
    const full = Object.assign({
      id: newId('act'),
      at: nowIso(),
      kind: 'step',
      title: '',
      actor: 'studio',
      job: null,
      op: null,
      step: null,
      files: [],
      images: [],
      commit: null,
    }, entry);
    appendJsonl(this.activityFile(), full);
    return full;
  }

  /** Activity entries, newest first. */
  activity() {
    return readJsonl(this.activityFile()).reverse();
  }

  // --- uploads ------------------------------------------------------------

  uploadsIndexFile() {
    return path.join(this.uploadsDir, 'index.json');
  }

  uploads() {
    const list = readJson(this.uploadsIndexFile(), []);
    return Array.isArray(list) ? list : [];
  }

  addUpload(meta, buffer) {
    this.ensureStudioDirs();
    const id = newId('up');
    const stored = `${id}-${safeName(meta.name)}`;
    fs.writeFileSync(path.join(this.uploadsDir, stored), buffer);
    const entry = Object.assign({ id, stored, at: nowIso() }, meta);
    const list = this.uploads();
    list.push(entry);
    writeJsonAtomic(this.uploadsIndexFile(), list);
    return entry;
  }

  upload(id) {
    return this.uploads().find((u) => u.id === id) || null;
  }

  uploadFile(entry) {
    return path.join(this.uploadsDir, entry.stored);
  }

  removeUpload(id) {
    const list = this.uploads();
    const entry = list.find((u) => u.id === id);
    if (!entry) return false;
    try { fs.unlinkSync(this.uploadFile(entry)); } catch (err) { /* already gone */ }
    writeJsonAtomic(this.uploadsIndexFile(), list.filter((u) => u.id !== id));
    return true;
  }
}

class Registry {
  constructor(home) {
    this.home = path.resolve(home || defaultHome());
    fs.mkdirSync(this.home, { recursive: true });
  }

  trashDir() {
    return path.join(this.home, '.trash');
  }

  /** Project ids present in the home, sorted. */
  list() {
    let names;
    try {
      names = fs.readdirSync(this.home, { withFileTypes: true });
    } catch (err) {
      return [];
    }
    return names
      .filter((e) => e.isDirectory() && PROJECT_ID_RE.test(e.name))
      .map((e) => e.name)
      .filter((name) => isFile(path.join(this.home, name, 'production', 'project.yaml')))
      .sort();
  }

  /** The project with this id. Throws 404 when there is none. */
  get(id) {
    if (!PROJECT_ID_RE.test(String(id))) throw new HttpError(404, 'project_not_found', 'There is no project with that id.');
    const project = new Project(this.home, id);
    if (!project.exists()) throw new HttpError(404, 'project_not_found', 'There is no project with that id.');
    return project;
  }

  /** A free project id for a title: the slug, then slug-2, slug-3... */
  freeId(title) {
    const base = slug(title).slice(0, 56).replace(/-+$/, '') || 'untitled';
    let id = base;
    for (let n = 2; isDir(path.join(this.home, id)) || fs.existsSync(path.join(this.home, id)); n++) {
      id = `${base}-${n}`;
      if (n > 999) throw new HttpError(409, 'too_many_projects', 'Too many projects share that name.');
    }
    return id;
  }

  /** Move a project directory into the trash. Returns the trash-relative name. */
  trash(id) {
    const project = this.get(id);
    fs.mkdirSync(this.trashDir(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    let name = `${id}-${stamp}`;
    for (let n = 2; fs.existsSync(path.join(this.trashDir(), name)); n++) name = `${id}-${stamp}-${n}`;
    const target = path.join(this.trashDir(), name);
    try {
      fs.renameSync(project.dir, target);
    } catch (err) {
      throw new HttpError(409, 'project_busy',
        `The project could not be moved to the trash (${err.code || err.message}). Close any program that has its files open and try again.`);
    }
    return name;
  }
}

module.exports = {
  Project, Registry, defaultHome, mergeSettings, checkSettingsPatch,
  DEFAULT_SETTINGS, DRIVER_CHOICES, LANGUAGES, PROJECT_ID_RE,
};
