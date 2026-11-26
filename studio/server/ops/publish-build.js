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
const { OpError } = require('../jobs');
const { bad, matching, requireIssue, ISSUE_RE } = require('./shared');

const MODES = ['auto', 'draft', 'final'];

/** What an edition ships, as one comparable string. */
function signature(edition) {
  const cover = edition.cover ? `${edition.cover.render}|${edition.cover.lettered_file || ''}` : '-';
  return [cover, ...(edition.pages || []).map((p) => `${p.page}|${p.render}|${p.lettered_file || ''}`)].join('\n');
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
    out.blockers.push({ page: null, render: null, code: err.code || 'issue_missing', message: err.message });
    return out;
  }
  out.edition = draft;
  out.blockers.push(...(draft.blockers || []));
  const project = S.ws.loadProject(root) || {};
  if (project.lettering && project.lettering.mode === 'overlay') {
    for (const p of draft.pages) {
      if (!p.lettered_file) {
        out.blockers.push({ page: p.page, render: p.render, code: 'not_lettered', message: `${p.page} has no lettered image yet` });
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
    out.blockers.push({ page: f.page || null, render: null, code: 'continuity', message: `${f.code}: ${f.message}` });
  }
  return out;
}

module.exports = {
  name: 'publish.build',
  title: 'Publish',
  summary: 'Writes the edition of an issue and builds the chosen formats, as a final edition when every page passed its check and as a marked draft otherwise.',
  readiness,
  signature,
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
      { id: 'edition', label: 'Write the edition' },
      { id: 'gate', label: 'Check continuity and reviews' },
      { id: 'build', label: 'Build the files' },
    ];
  },

  async run(ctx) {
    const { project, params } = ctx;
    const root = project.root;
    const issue = params.issue;

    const edition = await ctx.step('edition', (h) => {
      const state = readiness(root, issue);
      if (!state.edition) throw new OpError('not_ready', state.blockers[0] ? state.blockers[0].message : 'The issue cannot be published yet.');
      const draft = state.edition;
      if (!draft.pages.length) throw new OpError('no_pages', 'No page of this issue has a render yet, so there is nothing to publish.');
      // An unchanged issue builds more formats into its latest edition
      // instead of opening a new one every time.
      const latestId = draft.supersedes;
      const latest = latestId ? S.ws.loadEdition(root, latestId) : null;
      if (latest && signature(latest) === signature(draft)) {
        h.note(`${latestId}, unchanged since it was written`);
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
      for (const b of state.blockers.slice(0, 30)) h.log(`${b.page || issue}: ${b.message}`);
      h.note(state.blockers.length ? `${state.blockers.length} thing(s) keep this from being final` : 'Nothing blocks a final edition');
      return { blockers: state.blockers, continuity_errors: state.continuity_errors };
    });

    const blocked = gate.blockers.length > 0;
    if (params.mode === 'final' && blocked) {
      throw new OpError('not_ready',
        `A final edition is not possible yet: ${gate.blockers.slice(0, 3).map((b) => b.message).join('; ')}${gate.blockers.length > 3 ? '; and more' : ''}.`,
        { blockers: gate.blockers });
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
      h.note(`${result.written.length} file(s) written${result.skipped.length ? `, ${result.skipped.length} already there` : ''}`);
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
