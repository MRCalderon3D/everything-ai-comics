'use strict';
/**
 * History of what a person does directly (a save, an approval, an upload
 * that lands in the workspace, a restore): the same commit-and-activity
 * record a job step gets, for actions that are not jobs.
 */

const git = require('./git');
const { snapshot, diffSnapshots, HttpError } = require('./util');

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

/**
 * Run an action, then commit what it changed and log it.
 * @param {object} services { events, touched }
 * @param {object} project
 * @param {{kind: string, title: string, actor?: string}} entry
 * @param {() => any} fn the action; may be async
 * @returns {Promise<{result: any, commit: string|null, activity: object|null, changes: object[]}>}
 */
async function record(services, project, entry, fn) {
  const before = snapshot(project.root, []);
  const result = await fn();
  const changes = diffSnapshots(before, snapshot(project.root, []));
  let commit = null;
  let activity = null;
  if (changes.length || entry.always) {
    if (changes.length) {
      try {
        commit = await git.commitAll(project.dir, entry.title);
      } catch (err) {
        commit = null;
      }
    }
    activity = project.addActivity({
      kind: entry.kind,
      title: entry.title,
      actor: entry.actor || 'person',
      files: changes.slice(0, 200),
      images: changes.filter((c) => c.change !== 'deleted' && IMAGE_RE.test(c.path)).map((c) => c.path).slice(0, 50),
      commit,
    });
    // A job step that is running right now must not claim these files as its own.
    if (services.touched) {
      if (!services.touched.has(project.id)) services.touched.set(project.id, new Set());
      for (const c of changes) services.touched.get(project.id).add(c.path);
    }
    if (changes.length) services.events.emit(project.id, 'files', { paths: changes.map((c) => c.path).slice(0, 200), job: null, commit });
    services.events.emit(project.id, 'activity', { entry: activity });
  }
  return { result, commit, activity, changes };
}

/**
 * Restore the project to a commit, as a new commit. The activity log is not
 * part of the history, so it keeps every entry and gains one for the restore.
 */
async function restore(services, project, commit) {
  if (!git.detect().installed) {
    throw new HttpError(409, 'history_unavailable', 'git is not installed on this machine, so earlier states cannot be restored. The activity log still records what was done.');
  }
  if (!git.isRepo(project.dir)) {
    throw new HttpError(409, 'history_unavailable', 'This project has no history to restore from.');
  }
  if (services.jobs.busy(project)) {
    throw new HttpError(409, 'project_busy', 'A job is running. Wait for it or cancel it, then restore.');
  }
  const before = snapshot(project.root, []);
  let outcome;
  try {
    outcome = await git.restore(project.dir, commit);
  } catch (err) {
    const status = err.code === 'bad_commit' ? 404 : 409;
    throw new HttpError(status, err.code || 'restore_failed', err.message);
  }
  const changes = diffSnapshots(before, snapshot(project.root, []));
  const activity = project.addActivity({
    kind: 'restore',
    title: `Restored to an earlier point: ${outcome.subject}`,
    actor: 'person',
    files: changes.slice(0, 200),
    images: [],
    commit: outcome.commit,
    restored_from: outcome.target,
  });
  services.events.emit(project.id, 'files', { paths: changes.map((c) => c.path).slice(0, 200), job: null, commit: outcome.commit });
  services.events.emit(project.id, 'activity', { entry: activity });
  return { commit: outcome.commit, restored: outcome.target, unchanged: outcome.unchanged, saved_first: outcome.saved, files: changes.length, activity };
}

module.exports = { record, restore };
