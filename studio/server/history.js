'use strict';
/**
 * History of what a person does directly (a save, an approval, an upload
 * that lands in the workspace, a restore): the same commit-and-activity
 * record a job step gets, for actions that are not jobs.
 */

const git = require('./git');
const i18n = require('./i18n');
const { snapshot, diffSnapshots, HttpError } = require('./util');

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

/** True when a workspace path is one of the scope's paths or lies under one of its directories. */
function inScope(rel, scope) {
  return scope.some((s) => {
    const clean = String(s).replace(/\\/g, '/').replace(/\/+$/, '');
    return rel === clean || rel.startsWith(`${clean}/`);
  });
}

/**
 * Run an action, then commit what it changed and log it.
 *
 * The commit holds only the action's own files. A job may be writing in the
 * same workspace at the same moment (a page plan while the person approves a
 * sheet), and its files belong to its own step. So an action says what it
 * writes in `entry.scope`: workspace-relative files or directories, or a
 * function of the action's result that returns them. Changes outside the
 * scope are left alone. Without a scope, every change seen during the action
 * counts. Either way the paths go into one commit of exactly those paths
 * (git.commitPaths), and every job step running now is told to leave them
 * out of its own commit.
 *
 * @param {object} services { events, jobs }
 * @param {object} project
 * @param {{kind: string, title: string, actor?: string, always?: boolean,
 *          scope?: string[] | ((result: any) => string[])}} entry
 * @param {() => any} fn the action; may be async
 * @returns {Promise<{result: any, commit: string|null, activity: object|null, changes: object[]}>}
 */
async function record(services, project, entry, fn) {
  const before = snapshot(project.root, []);
  const result = await fn();
  let changes = diffSnapshots(before, snapshot(project.root, []));
  const scope = typeof entry.scope === 'function' ? entry.scope(result) : entry.scope;
  if (Array.isArray(scope)) changes = changes.filter((c) => inScope(c.path, scope.filter(Boolean)));
  let commit = null;
  let activity = null;
  if (changes.length || entry.always) {
    // A job step running now must not claim these files as its own.
    if (changes.length && services.jobs && typeof services.jobs.claimPaths === 'function') {
      services.jobs.claimPaths(project, changes.map((c) => c.path));
    }
    if (changes.length) {
      try {
        commit = await git.commitPaths(project.dir, i18n.render('en', entry.title), changes.map((c) => `production/${c.path}`));
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
  // Name the point by its own history entry when there is one, so it reads in any language.
  const entry = project.activity().find((e) => e.commit === outcome.target);
  const activity = project.addActivity({
    kind: 'restore',
    title: i18n.msg('activity.restore', { what: entry ? entry.title : outcome.subject }),
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

module.exports = { record, restore, inScope };
