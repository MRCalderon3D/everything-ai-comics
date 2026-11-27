'use strict';
/**
 * The workspace checks run around an edit the studio makes on the person's
 * behalf (a merge, a rename, a delete): validate-workspace.js and
 * check-continuity.js over the whole workspace, before and after, so the
 * answer can say what the edit broke, if anything, apart from what was
 * already wrong. These are checks of the files. They say nothing about any
 * drawing.
 */

const S = require('./scaffold');

function keyOf(f) {
  return `${f.code}|${f.file || f.page || ''}|${f.panel || ''}|${f.message}`;
}

/** Every error the checks report now: [{ code, file, message, check }]. */
function errorsNow(root) {
  const out = [];
  try {
    const result = S.validateWorkspace(root, {});
    for (const e of result.errors || []) out.push(Object.assign({ check: 'structure' }, e));
  } catch (err) {
    out.push({ check: 'structure', code: 'VALIDATE_FAILED', file: '', message: err.message });
  }
  try {
    for (const f of S.checkContinuity(root, {}).findings || []) {
      if (f.severity === 'error') out.push(Object.assign({ check: 'continuity', file: f.page || f.issue || '' }, f));
    }
  } catch (err) {
    out.push({ check: 'continuity', code: 'CHECK_FAILED', file: '', message: err.message });
  }
  return out;
}

/** A snapshot of the errors, to compare with after the edit. */
function before(root) {
  return new Set(errorsNow(root).map(keyOf));
}

/**
 * What the checks say after an edit.
 * @returns {{ok: boolean, new_errors: object[], errors: number, note: string}}
 *   ok: the edit added no error (errors already there before do not count)
 */
function after(root, previous) {
  const now = errorsNow(root);
  const fresh = now.filter((e) => !previous.has(keyOf(e)));
  return {
    ok: fresh.length === 0,
    new_errors: fresh.slice(0, 30).map((e) => ({ check: e.check, code: e.code, file: e.file || null, message: e.message })),
    errors: now.length,
  };
}

module.exports = { errorsNow, before, after };
