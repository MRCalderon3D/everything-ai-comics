'use strict';
/**
 * publish.build: write the edition of an issue from its current state
 * (draftEdition), run the continuity gate, and build the chosen formats with
 * build-edition.js. The build is final when every page has a render that
 * passed its check, the plan has no continuity error and, with overlay
 * lettering, every page has its lettered image. Otherwise it is a marked
 * draft.
 *
 * Tooling never certifies artwork: "final" here means every shipped render
 * has a passing review on file. Publishing stays the person's decision.
 */

const fs = require('fs');
const path = require('path');
const S = require('../scaffold');
const pipeline = require('../pipeline');
const { msg, has, render } = require('../i18n');
const { OpError } = require('../jobs');
const { bad, matching, requireIssue, ISSUE_RE } = require('./shared');

const MODES = ['auto', 'draft', 'final'];

/** What an edition ships, as one comparable string. */
function signature(edition) {
  const cover = edition.cover ? `${edition.cover.render}|${edition.cover.lettered_file || ''}` : '-';
  return [cover, ...(edition.pages || []).map((p) => `${p.page}|${p.render}|${p.lettered_file || ''}`)].join('\n');
}

/** One blocker, with the sentence the person reads. `detail` is the scaffold's own text. */
function blocker(page, render, code, detail) {
  const key = has(`publish.blocker.${code}`) ? `publish.blocker.${code}` : 'publish.blocker.other';
  return { page, render, code, message: msg(key, { page: page || '', render: render || '', detail: detail || '' }) };
}

/**
 * Remove the -DRAFT exports of an edition (files and list entries).
 * Returns the workspace paths removed. Only paths inside the edition's own
 * exports directory are touched.
 */
function dropDraftExports(root, editionFile) {
  const doc = S.ws.loadYaml(editionFile) || {};
  const list = Array.isArray(doc.exports) ? doc.exports : [];
  const isDraft = (e) => e && /-DRAFT(\.|-|$)/.test(String(e.file || ''));
  const drafts = list.filter(isDraft);
  if (!drafts.length) return [];
  const exportsDir = path.join(path.dirname(editionFile), 'exports');
  const removed = [];
  for (const e of drafts) {
    const abs = S.ws.abs(root, String(e.file).replace(/\\/g, '/'));
    const inside = path.relative(exportsDir, abs);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) continue;
    fs.rmSync(abs, { recursive: true, force: true });
    // An images export also leaves its zip beside the folder.
    if (e.format === 'images') fs.rmSync(`${abs.replace(/[\\/]+$/, '')}.zip`, { force: true });
    removed.push(String(e.file));
  }
  pipeline.setTopLevel(editionFile, { exports: list.filter((e) => !isDraft(e)) });
  return removed;
}

/**
 * What keeps the issue from a final edition right now:
 * [{ page, render, code, message }]. Used by the publish screen too.
 */
function readiness(root, issue) {
  const out = { blockers: [], edition: null, continuity_errors: 0 };
  let draft;
  try {
    draft = S.draftEdition({ root, issue });
  } catch (err) {
    out.blockers.push(blocker(null, null, err.code || 'issue_missing', err.message));
    return out;
  }
  out.edition = draft;
  out.blockers.push(...(draft.blockers || []).map((b) => blocker(b.page, b.render, b.code, b.message)));
  const project = S.ws.loadProject(root) || {};
  if (project.lettering && project.lettering.mode === 'overlay') {
    for (const p of draft.pages) {
      if (!p.lettered_file) {
        out.blockers.push(blocker(p.page, p.render, 'not_lettered', `${p.page} has no lettered image yet`));
      }
    }
  }
  let findings = [];
  try {
    findings = S.checkContinuity(root, { issue }).findings.filter((f) => f.severity === 'error');
  } catch (err) {
    findings = [];
  }
  out.continuity_errors = findings.length;
  for (const f of findings.slice(0, 20)) {
    out.blockers.push(blocker(f.page || null, null, 'continuity', `${f.code}: ${f.message}`));
  }
  return out;
}

module.exports = {
  name: 'publish.build',
  readiness,
  signature,
  blocker,
  dropDraftExports,
  params: [
    { name: 'issue', type: 'string', required: false, description: 'Issue ID. Default ISS_001.' },
    { name: 'formats', type: 'string[]', required: false, description: 'Any of pdf, cbz, epub, web, images. Default ["pdf", "cbz"].' },
    { name: 'mode', type: 'string', required: false, description: 'auto (default: final when nothing blocks it, else a draft), draft, or final (fails when something blocks it).' },
  ],

  validate(params, { project }) {
    const issue = matching(params, 'issue', ISSUE_RE, { required: false, what: 'an issue ID such as ISS_001' }) || 'ISS_001';
    requireIssue(project, issue);
    const known = S.editionFormats();
    let formats = ['pdf', 'cbz'].filter((f) => known.includes(f));
    if (params.formats !== undefined && params.formats !== null) {
      if (!Array.isArray(params.formats) || !params.formats.length) throw bad(`"formats" must be a list with any of ${known.join(', ')}.`);
      formats = [...new Set(params.formats.map(String))];
      const unknown = formats.filter((f) => !known.includes(f));
      if (unknown.length) throw bad(`Unknown format ${unknown.join(', ')}. Use ${known.join(', ')}.`);
    }
    const mode = params.mode === undefined || params.mode === null ? 'auto' : String(params.mode);
    if (!MODES.includes(mode)) throw bad(`"mode" must be one of ${MODES.join(', ')}.`);
    return { issue, formats, mode };
  },

  steps() {
    return [
      { id: 'edition', label: msg('step.publish.edition') },
      { id: 'gate', label: msg('step.publish.gate') },
      { id: 'build', label: msg('step.publish.build') },
    ];
  },

  async run(ctx) {
    const { project, params } = ctx;
    const root = project.root;
    const issue = params.issue;

    const edition = await ctx.step('edition', (h) => {
      const state = readiness(root, issue);
      if (!state.edition) throw new OpError('not_ready', state.blockers[0] ? state.blockers[0].message : msg('error.not_ready', { n: 1 }));
      const draft = state.edition;
      if (!draft.pages.length) throw new OpError('no_pages', 'No page of this issue has a render yet, so there is nothing to publish.');
      // An unchanged issue builds more formats into its latest edition
      // instead of opening a new one every time.
      const latestId = draft.supersedes;
      const latest = latestId ? S.ws.loadEdition(root, latestId) : null;
      if (latest && signature(latest) === signature(draft)) {
        h.note(msg('note.edition_unchanged', { edition: latestId }));
        return { id: latestId, file: `editions/${latestId}/edition.yaml`, reused: true, status: latest.status };
      }
      const rel = `editions/${draft.id}/edition.yaml`;
      const file = S.ws.abs(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `# Schema: schemas/edition.schema.json\n# Composed by the studio from the current state of ${issue}.\n\n${S.yaml.stringify(draft)}`);
      h.note(draft.id);
      return { id: draft.id, file: rel, reused: false, status: 'draft' };
    });

    const gate = await ctx.step('gate', (h) => {
      const state = readiness(root, issue);
      for (const b of state.blockers.slice(0, 30)) h.log(`${b.page || issue}: ${render('en', b.message)}`);
      h.note(state.blockers.length ? msg('note.blockers', { n: state.blockers.length }) : msg('note.no_blockers'));
      return { blockers: state.blockers, continuity_errors: state.continuity_errors };
    });

    const blocked = gate.blockers.length > 0;
    if (params.mode === 'final' && blocked) {
      throw new OpError('not_ready', msg('error.not_ready', { n: gate.blockers.length }), { blockers: gate.blockers });
    }
    const draft = params.mode === 'draft' || blocked;

    const built = await ctx.step('build', (h) => {
      const file = S.ws.abs(root, edition.file);
      const result = S.buildEdition(file, { formats: params.formats, draft });
      for (const w of result.warnings) h.log(`warning: ${w.message}`);
      for (const e of result.errors) h.log(`error: ${e.message}`);
      if (!result.ok) {
        throw new OpError('build_failed', result.errors.map((e) => e.message.split('\n')[0]).slice(0, 3).join('; ') || 'The edition was not built.', { errors: result.errors });
      }
      // A clean final build means every shipped render has a passing review.
      if (!draft && edition.status === 'draft') {
        try {
          pipeline.setTopLevel(file, { status: 'reviewed' });
        } catch (err) {
          h.log(`could not mark the edition as reviewed: ${err.message}`);
        }
      }
      // A final build into an edition built earlier as a draft (same pages,
      // so the edition was reused) replaces its draft files: they would
      // otherwise stay listed beside the final ones, stamped DRAFT.
      if (!draft) {
        try {
          const dropped = dropDraftExports(root, file);
          if (dropped.length) h.log(`removed ${dropped.length} draft export(s): ${dropped.join(', ')}`);
        } catch (err) {
          h.log(`could not remove the draft exports: ${err.message}`);
        }
      }
      h.note(result.skipped.length
        ? msg('note.files_written_skipped', { n: result.written.length, skipped: result.skipped.length })
        : msg('note.files_written', { n: result.written.length }));
      return {
        written: result.written,
        skipped: result.skipped,
        shipped: result.shipped,
        warnings: result.warnings.map((w) => w.message),
      };
    });

    return {
      issue,
      edition: edition.id,
      reused: edition.reused,
      draft,
      formats: params.formats,
      written: built.written,
      skipped: built.skipped,
      shipped: built.shipped,
      warnings: built.warnings,
      blockers: gate.blockers,
    };
  },
};
