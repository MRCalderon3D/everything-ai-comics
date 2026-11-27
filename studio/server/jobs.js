'use strict';
/**
 * Jobs: one queue per project, one job running at a time.
 *
 * A job is one operation (studio/server/ops/) with named steps. It is
 * persisted as <project>/.studio/jobs/<id>.json with a log beside it
 * (<id>.log), reports progress over the project's event stream, can be
 * cancelled (the abort signal reaches the CLI driver, which kills the
 * process tree), and can pause with questions (needs_decision). An answer
 * puts it back in the queue; finished steps are not run again, and the step
 * that asked runs again with the answers in its prompt.
 *
 * After every step that changed files the project directory is committed
 * and an activity entry links to the commit.
 *
 * A chat turn must not wait half an hour behind a drawing. An operation that
 * says `readOnlyLane: true` (chat.turn) goes to a second lane of the queue
 * when the main lane is busy, and runs at once in read-only mode: the job
 * has `read_only: true`, ctx.readOnly is true, and its steps never take a
 * snapshot or commit, so the job running in the main lane keeps every change
 * it makes. Jobs of that lane run one at a time, and never while a turn of
 * the main lane runs, so two turns of one conversation never overlap. When
 * the main lane is idle the turn runs there, as before, and may write.
 *
 * A job can carry an `origin` (the conversation card that started it). When
 * such a job settles (done, failed, cancelled, needs_decision) the manager
 * calls services.onJobSettled(project, job), which posts the result back.
 */

const fs = require('fs');
const path = require('path');
const git = require('./git');
const i18n = require('./i18n');
const {
  HttpError, errorText, newId, nowIso, readJson, writeJsonAtomic, snapshot, diffSnapshots,
} = require('./util');

const { msg } = i18n;

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const ACTIVE = ['queued', 'running', 'needs_decision'];
const FINISHED = ['done', 'failed', 'cancelled'];

/** Thrown inside a step when the AI needs an answer only the person can give. */
class NeedsDecision extends Error {
  constructor(questions, summary) {
    super(summary || 'A decision is needed.');
    this.code = 'needs_decision';
    this.questions = Array.isArray(questions) ? questions : [];
  }
}

/**
 * A failure an operation reports on purpose: it becomes the job's error.
 * `message` is a technical string or a message descriptor; `params` feed
 * the dictionary entry of the code (error.<code>).
 */
class OpError extends Error {
  constructor(code, message, details, params) {
    super(i18n.isMsg(message) ? i18n.t('en', message.$t, message.params) : message);
    this.code = code;
    this.opError = true;
    if (i18n.isMsg(message)) this.text = message;
    if (details !== undefined) this.details = details;
    if (params !== undefined) this.params = params;
  }
}

function isCancel(err) {
  return !!err && (err.code === 'cancelled' || err.name === 'AbortError');
}

/** The job as the API returns it (step results stay internal). */
function view(job) {
  if (!job) return null;
  const out = {};
  for (const key of ['id', 'project', 'op', 'title', 'params', 'status', 'created_at', 'started_at', 'ended_at',
    'current_step', 'steps', 'questions', 'answers', 'result', 'error', 'tools', 'commits', 'position', 'cost_usd',
    'read_only', 'origin', 'story_proposals']) {
    out[key] = job[key] === undefined ? null : job[key];
  }
  return out;
}

class JobManager {
  /**
   * @param {{events: object, ops: object, services: object}} deps
   *   ops: { get(name) -> operation module | null }
   */
  constructor({ events, ops, services }) {
    this.events = events;
    this.ops = ops;
    this.services = services || {};
    this.loaded = new Map(); // project id -> Map<job id, job>
    this.queues = new Map(); // project id -> { running: job|null, queued: string[] }
    this.controllers = new Map(); // job id -> AbortController
    this.settled = new Set(); // promises of running jobs
  }

  // --- storage ---------------------------------------------------------------

  jobs(project) {
    if (this.loaded.has(project.id)) return this.loaded.get(project.id);
    const map = new Map();
    let names = [];
    try {
      names = fs.readdirSync(project.jobsDir).filter((n) => /^job_.+\.json$/.test(n));
    } catch (err) {
      names = [];
    }
    for (const name of names) {
      const job = readJson(path.join(project.jobsDir, name), null);
      if (!job || !job.id) continue;
      // Stale-job recovery: nothing can be running when the index is first read.
      if (job.status === 'running' || job.status === 'queued') {
        const wasRunning = job.status === 'running';
        job.status = 'failed';
        job.ended_at = nowIso();
        job.error = {
          code: 'interrupted',
          message: msg(wasRunning ? 'error.interrupted' : 'error.interrupted_queued'),
        };
        for (const step of job.steps || []) {
          if (step.status === 'running') {
            step.status = 'failed';
            step.ended_at = job.ended_at;
          }
        }
        writeJsonAtomic(path.join(project.jobsDir, name), job);
      }
      map.set(job.id, job);
    }
    this.loaded.set(project.id, map);
    return map;
  }

  /** Forget the in-memory index of a project (after it is moved to the trash). */
  forget(projectId) {
    this.loaded.delete(projectId);
    this.queues.delete(projectId);
  }

  save(project, job) {
    writeJsonAtomic(path.join(project.jobsDir, `${job.id}.json`), job);
  }

  logFile(project, jobId) {
    return path.join(project.jobsDir, `${jobId}.log`);
  }

  emit(project, job) {
    this.events.emit(project.id, 'job', { job: view(job) });
  }

  // --- queries ---------------------------------------------------------------

  /** Jobs of a project, newest first. */
  list(project, { limit = 50, active = false } = {}) {
    const all = [...this.jobs(project).values()].sort((a, b) => (a.id < b.id ? 1 : -1));
    const filtered = active ? all.filter((j) => ACTIVE.includes(j.status)) : all;
    return filtered.slice(0, limit).map(view);
  }

  getRaw(project, id) {
    const job = this.jobs(project).get(String(id));
    if (!job) throw new HttpError(404, 'job_not_found', 'There is no job with that id in this project.');
    return job;
  }

  get(project, id) {
    return view(this.getRaw(project, id));
  }

  /** Lines of a job's log. `tail` keeps the last N lines. */
  readLog(project, id, tail = 0) {
    this.getRaw(project, id);
    let text = '';
    try {
      text = fs.readFileSync(this.logFile(project, id), 'utf8');
    } catch (err) {
      text = '';
    }
    const lines = text.split('\n').filter(Boolean);
    return tail > 0 ? lines.slice(-tail) : lines;
  }

  /** True while a job of the project is queued or running, in either lane. */
  busy(project) {
    const q = this.queues.get(project.id);
    return !!(q && (q.running || q.queued.length || q.lane.running || q.lane.queued.length));
  }

  /** The job running in the main lane (the one that may write), or null. */
  running(project) {
    const q = this.queues.get(project.id);
    return q && q.running ? view(q.running) : null;
  }

  // --- commands --------------------------------------------------------------

  /**
   * Create a job and put it in the project's queue. Returns the job view.
   * @param {object} [meta] { origin } stored on the job: what started it
   *   (a conversation card), so its result can be posted back there.
   */
  enqueue(project, opName, params = {}, meta = {}) {
    const op = this.ops.get(opName);
    if (!op) throw new HttpError(400, 'unknown_operation', `"${opName}" is not an operation. See GET /api/ops.`);
    const clean = op.validate ? op.validate(params || {}, { project, services: this.services }) : (params || {});
    project.ensureStudioDirs();
    const q = this.queue(project);
    // A read-only lane job waits for nothing but other turns: it never sits behind a drawing.
    const lane = !!op.readOnlyLane && !!(q.running || q.queued.length);
    const job = {
      id: newId('job'),
      project: project.id,
      op: op.name,
      title: msg(`op.${op.name}.title`),
      params: clean,
      status: 'queued',
      created_at: nowIso(),
      started_at: null,
      ended_at: null,
      current_step: null,
      steps: op.steps(clean, { project, services: this.services }).map((s) => ({
        id: s.id, label: s.label, status: 'pending', started_at: null, ended_at: null,
        tool: null, commit: null, files: 0, note: null, changed: [],
      })),
      questions: [],
      answers: {},
      result: null,
      error: null,
      tools: {},
      commits: [],
      position: null,
      stepResults: {},
      read_only: lane,
      origin: meta && meta.origin ? meta.origin : null,
    };
    this.jobs(project).set(job.id, job);
    (lane ? q.lane.queued : q.queued).push(job.id);
    this.positions(project);
    this.save(project, job);
    this.emit(project, job);
    setImmediate(() => this.pump(project));
    return view(job);
  }

  queue(project) {
    if (!this.queues.has(project.id)) {
      this.queues.set(project.id, { running: null, queued: [], lane: { running: null, queued: [] } });
    }
    return this.queues.get(project.id);
  }

  positions(project) {
    const q = this.queue(project);
    const jobs = this.jobs(project);
    for (const list of [q.queued, q.lane.queued]) {
      list.forEach((id, index) => {
        const job = jobs.get(id);
        if (job) job.position = index + 1;
      });
    }
  }

  cancel(project, id) {
    const job = this.getRaw(project, id);
    if (FINISHED.includes(job.status)) {
      throw new HttpError(409, 'job_finished', `This job already ended (${job.status}).`, undefined, { status: job.status });
    }
    if (job.status === 'running') {
      job.cancel_requested = true;
      const controller = this.controllers.get(job.id);
      if (controller) controller.abort();
      this.log(project, job, 'cancel requested');
      return view(job);
    }
    const q = this.queue(project);
    q.queued = q.queued.filter((x) => x !== job.id);
    q.lane.queued = q.lane.queued.filter((x) => x !== job.id);
    job.status = 'cancelled';
    job.ended_at = nowIso();
    job.position = null;
    for (const step of job.steps) if (step.status === 'waiting') step.status = 'cancelled';
    this.positions(project);
    this.save(project, job);
    this.emit(project, job);
    this.settledHook(project, job);
    return view(job);
  }

  /** Tell whoever started a job (a conversation card) that it settled. Never throws. */
  settledHook(project, job) {
    if (!job.origin || typeof this.services.onJobSettled !== 'function') return;
    try {
      this.services.onJobSettled(project, job);
    } catch (err) {
      if (process.env.STUDIO_DEBUG) console.error(err);
    }
  }

  /** Answer the questions of a paused job and put it back at the front of the queue. */
  answer(project, id, answers) {
    const job = this.getRaw(project, id);
    if (job.status !== 'needs_decision') {
      throw new HttpError(409, 'job_not_waiting', 'This job is not waiting for an answer.');
    }
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      throw new HttpError(400, 'bad_answers', 'Send { "answers": { "<question id>": "<answer>" } }.');
    }
    const missing = job.questions.map((q) => q.id).filter((qid) => {
      const value = answers[qid];
      return value === undefined || value === null || String(value).trim() === '';
    });
    if (missing.length) {
      throw new HttpError(400, 'bad_answers', msg('error.bad_answers.missing', { missing }), { missing });
    }
    for (const q of job.questions) {
      job.answers[q.id] = { question: q.question, answer: String(answers[q.id]).slice(0, 4000) };
    }
    job.questions = [];
    job.status = 'queued';
    job.error = null;
    for (const step of job.steps) if (step.status === 'waiting') step.status = 'pending';
    const q = this.queue(project);
    (job.read_only ? q.lane.queued : q.queued).unshift(job.id);
    this.positions(project);
    this.save(project, job);
    this.emit(project, job);
    setImmediate(() => this.pump(project));
    return view(job);
  }

  // --- running ---------------------------------------------------------------

  log(project, job, line, stepId) {
    const at = nowIso();
    const text = String(line).replace(/\s+$/, '').slice(0, 2000);
    if (!text) return;
    try {
      fs.appendFileSync(this.logFile(project, job.id), `${at} ${stepId || job.current_step || '-'} ${text.replace(/\n/g, ' | ')}\n`);
    } catch (err) {
      // the project directory went away (moved to the trash); keep going
    }
    this.events.emit(project.id, 'log', { job: job.id, step: stepId || job.current_step || null, at, line: text });
  }

  pump(project) {
    this.pumpMain(project);
    this.pumpLane(project);
  }

  /** The main lane: one job at a time, the only one that may write. */
  pumpMain(project) {
    const q = this.queue(project);
    if (q.running || !q.queued.length) return;
    const job = this.jobs(project).get(q.queued[0]);
    if (!job || job.status !== 'queued') {
      q.queued.shift();
      this.pumpMain(project);
      return;
    }
    // Two turns of one conversation never run side by side.
    if (q.lane.running && this.isLaneOp(job)) return;
    q.queued.shift();
    this.start(project, job, q, 'main');
  }

  /** The read-only lane: chat turns that came while the main lane was busy. */
  pumpLane(project) {
    const q = this.queue(project);
    if (q.lane.running || !q.lane.queued.length) return;
    const job = this.jobs(project).get(q.lane.queued[0]);
    if (!job || job.status !== 'queued') {
      q.lane.queued.shift();
      this.pumpLane(project);
      return;
    }
    if (q.running && this.isLaneOp(q.running)) return;
    q.lane.queued.shift();
    if (!q.running && !q.queued.length) {
      // The main lane went idle while this turn waited: it runs there and may write.
      job.read_only = false;
      q.queued.unshift(job.id);
      this.positions(project);
      this.pumpMain(project);
      return;
    }
    job.read_only = true;
    this.start(project, job, q.lane, 'lane');
  }

  isLaneOp(job) {
    const op = job && this.ops.get(job.op);
    return !!(op && op.readOnlyLane);
  }

  start(project, job, slot, laneName) {
    slot.running = job;
    this.positions(project);
    const done = this.run(project, job)
      .catch((err) => {
        // run() handles its own errors; this is a last line of defence.
        job.status = 'failed';
        job.error = { code: 'internal', message: errorText({ code: 'internal', message: err && err.message ? err.message : String(err) }) };
        job.ended_at = nowIso();
        try { this.save(project, job); } catch (e) { /* ignore */ }
      })
      .then(() => {
        slot.running = null;
        this.controllers.delete(job.id);
        this.settled.delete(done);
        setImmediate(() => this.pump(project));
      });
    this.settled.add(done);
    return laneName;
  }

  async run(project, job) {
    const op = this.ops.get(job.op);
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    job.status = 'running';
    job.position = null;
    if (!job.started_at) job.started_at = nowIso();
    job.ended_at = null;
    this.save(project, job);
    this.emit(project, job);
    this.log(project, job, `${i18n.render('en', job.title)} started`, '-');

    const manager = this;
    const ctx = {
      project,
      job,
      params: job.params,
      answers: job.answers,
      // A turn of the read-only lane: no file of the workspace may change.
      readOnly: !!job.read_only,
      signal: controller.signal,
      services: this.services,
      log: (line) => manager.log(project, job, line),
      /** Add a step that was not known up front (a repair, for example). */
      addStep(def, { after = null } = {}) {
        if (job.steps.some((s) => s.id === def.id)) return;
        const step = {
          id: def.id, label: def.label, status: 'pending', started_at: null, ended_at: null,
          tool: null, commit: null, files: 0, note: null, changed: [],
        };
        const index = after ? job.steps.findIndex((s) => s.id === after) : -1;
        if (index === -1) job.steps.push(step);
        else job.steps.splice(index + 1, 0, step);
        manager.save(project, job);
        manager.emit(project, job);
      },
      /** Mark a step as not needed. */
      skipStep(id, note) {
        const step = job.steps.find((s) => s.id === id);
        if (!step || step.status !== 'pending') return;
        step.status = 'skipped';
        step.note = note || null;
        manager.save(project, job);
        manager.emit(project, job);
      },
      step: (id, fn, options) => manager.runStep(project, job, controller.signal, id, fn, options || {}),
    };

    try {
      if (!op) throw new OpError('unknown_operation', `Operation ${job.op} no longer exists.`, undefined, { op: job.op });
      const result = await op.run(ctx);
      job.result = result === undefined ? null : result;
      job.status = 'done';
      for (const step of job.steps) if (step.status === 'pending') step.status = 'skipped';
      this.log(project, job, `${i18n.render('en', job.title)} finished`, '-');
    } catch (err) {
      if (err instanceof NeedsDecision) {
        job.status = 'needs_decision';
        job.questions = err.questions.map((q, i) => ({
          id: String(q.id || `q${i + 1}`),
          question: String(q.question || ''),
          options: Array.isArray(q.options) ? q.options.map(String) : [],
        }));
        job.error = null;
        this.log(project, job, `waiting for a decision: ${job.questions.map((q) => q.question).join(' / ')}`, '-');
      } else if (isCancel(err) || controller.signal.aborted) {
        job.status = 'cancelled';
        job.error = null;
        for (const step of job.steps) if (step.status === 'running') step.status = 'cancelled';
        this.log(project, job, 'cancelled', '-');
      } else {
        job.status = 'failed';
        const code = typeof err.code === 'string' ? err.code : 'failed';
        // The technical text stays in the log; the person reads the dictionary's sentence.
        job.error = { code, message: errorText({ code, message: err && err.message ? err.message : String(err), params: err.params, text: err.text }) };
        if (err && err.details !== undefined) job.error.details = err.details;
        if (!err.opError && !err.code && process.env.STUDIO_DEBUG) console.error(err);
        this.log(project, job, `failed: ${err && err.message ? err.message : String(err)}`, '-');
      }
    }
    job.current_step = null;
    if (job.status !== 'needs_decision') job.ended_at = nowIso();
    try {
      this.save(project, job);
    } catch (err) {
      // project directory gone
    }
    this.emit(project, job);
    this.settledHook(project, job);
  }

  /**
   * Run one named step. A step that already finished (the job is resuming
   * after an answer) returns its stored result without running again.
   * fn receives a handle: { setTool(name), note(text), log(line) }.
   */
  async runStep(project, job, signal, id, fn, options) {
    let step = job.steps.find((s) => s.id === id);
    if (!step) {
      step = {
        id, label: options.label || id, status: 'pending', started_at: null, ended_at: null,
        tool: null, commit: null, files: 0, note: null, changed: [],
      };
      job.steps.push(step);
    }
    if (step.status === 'done') return job.stepResults[id];
    if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });

    step.status = 'running';
    step.started_at = nowIso();
    step.ended_at = null;
    step.note = null;
    job.current_step = id;
    this.save(project, job);
    this.emit(project, job);
    this.log(project, job, `${i18n.render('en', step.label)}`, id);

    // A read-only turn runs beside a job that writes: what changes on disk now is that job's.
    const readOnly = !!job.read_only;
    const before = readOnly ? null : snapshot(project.root, []);
    const handle = {
      setTool: (name) => {
        step.tool = name;
        if (options.verb) job.tools[options.verb] = name;
      },
      // A note is a descriptor (i18n.msg) for words, or a plain string for an id or a path.
      note: (text) => { step.note = i18n.isMsg(text) ? text : String(text).slice(0, 500); },
      log: (line) => this.log(project, job, line, id),
    };

    let result;
    let failure = null;
    try {
      result = await fn(handle);
    } catch (err) {
      failure = err;
    }

    // Whatever happened, what changed on disk goes into the history.
    let changes = [];
    try {
      changes = readOnly ? [] : diffSnapshots(before, snapshot(project.root, []));
    } catch (err) {
      changes = [];
    }
    // Files the person saved or approved while this step ran are theirs, not the step's.
    const manual = this.services.touched && !readOnly ? this.services.touched.get(project.id) : null;
    if (manual && manual.size) {
      changes = changes.filter((c) => !manual.has(c.path));
      manual.clear();
    }
    if (changes.length) {
      const suffix = failure
        ? (failure instanceof NeedsDecision ? '.paused' : isCancel(failure) ? '.cancelled' : '.unfinished')
        : '';
      const title = msg(`activity.step${suffix}`, { title: job.title, label: step.label });
      let commit = null;
      try {
        // Commit messages are in English: the person reads the activity log, which is localized.
        commit = await git.commitAll(project.dir, i18n.render('en', title));
      } catch (err) {
        commit = null;
      }
      step.commit = commit;
      step.files = changes.length;
      step.changed = changes.map((c) => c.path).slice(0, 100);
      if (commit) job.commits.push(commit);
      const entry = project.addActivity({
        kind: 'step',
        title,
        actor: step.tool || 'studio',
        job: job.id,
        op: job.op,
        step: id,
        files: changes.slice(0, 200),
        images: changes.filter((c) => c.change !== 'deleted' && IMAGE_RE.test(c.path)).map((c) => c.path).slice(0, 50),
        commit,
      });
      this.events.emit(project.id, 'files', { paths: changes.map((c) => c.path).slice(0, 200), job: job.id, commit });
      this.events.emit(project.id, 'activity', { entry });
    }

    step.ended_at = nowIso();
    if (failure) {
      step.status = failure instanceof NeedsDecision ? 'waiting' : isCancel(failure) ? 'cancelled' : 'failed';
      if (!(failure instanceof NeedsDecision) && !isCancel(failure) && !step.note) {
        step.note = errorText({ code: typeof failure.code === 'string' ? failure.code : 'failed', message: failure.message || String(failure), params: failure.params, text: failure.text });
      }
      this.save(project, job);
      this.emit(project, job);
      throw failure;
    }
    step.status = 'done';
    job.stepResults[id] = result === undefined ? null : result;
    this.save(project, job);
    this.emit(project, job);
    return result;
  }

  /** Resolves when no job is running or queued in any project (tests, shutdown). */
  async idle() {
    for (;;) {
      const pending = [...this.settled];
      const queued = [...this.queues.values()].some((q) => q.running || q.queued.length || q.lane.running || q.lane.queued.length);
      if (!pending.length && !queued) return;
      await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 20))]);
      await new Promise((r) => setImmediate(r));
    }
  }

  /** Abort every running job (server shutdown). */
  async shutdown() {
    for (const q of this.queues.values()) {
      q.queued = [];
      q.lane.queued = [];
    }
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.all([...this.settled]);
  }
}

module.exports = { JobManager, NeedsDecision, OpError, view, isCancel, ACTIVE, FINISHED };
