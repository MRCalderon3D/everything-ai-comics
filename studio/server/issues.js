'use strict';
/**
 * Issues of a series: the next issue, and the continuity state it opens from.
 *
 * A project is a series. story/series-plan.yaml lists its issues, and each
 * issue has its own pages, cover and editions (docs/data-model.md). The look,
 * the characters, the places, the props and the story bible belong to the
 * project, so a new issue uses them as they are: nothing is copied.
 *
 * issue.yaml's `opens_from` names the continuity state the previous issue
 * ended in (continuity/<ISS_ID>.final-state.yaml), and check-continuity.js
 * seeds the ledger of the new issue from it. The scaffold's
 * /continuity-review writes that file when an issue closes. When it is not
 * there, the studio derives it from the panel ledger of the previous issue:
 * the last row of every character (where, in what, carrying what, in what
 * state) and the last known place of every prop. Such a file says so in its
 * `notes`, and it is derived again when pages are added to the previous issue
 * before the new one has pages of its own.
 */

const fs = require('fs');
const path = require('path');
const S = require('./scaffold');
const { HttpError, today } = require('./util');

const PLAN = 'story/series-plan.yaml';
const DERIVED = 'Derived by the studio from the panel ledger';
const TAG_RE = /^[a-z][a-z0-9_]*$/;

function issueNumber(id) {
  return parseInt(String(id).slice(4), 10);
}

function issueId(n) {
  return `ISS_${String(n).padStart(3, '0')}`;
}

function stateRel(issue) {
  return `continuity/${issue}.final-state.yaml`;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    return null;
  }
}

function headerOf(file, fallback) {
  const text = readText(file);
  const header = text && S.yamlEdit ? S.yamlEdit.leadingComments(text) : '';
  return header || fallback;
}

/** Every issue of the project: the directories under issues/ and the series plan's entries, in order. */
function allIssues(root) {
  const ids = new Set(S.ws.listIssues(root));
  const plan = S.ws.loadYaml(S.ws.abs(root, PLAN));
  for (const entry of plan && Array.isArray(plan.issues) ? plan.issues : []) {
    if (entry && S.ws.ID.issue.test(String(entry.id))) ids.add(entry.id);
  }
  return [...ids].sort();
}

/** The pages of an issue in reading order. */
function pagesInOrder(root, issue) {
  return S.ws.listPages(root, issue).filter((p) => p.doc)
    .sort((a, b) => ((a.doc.number || 0) - (b.doc.number || 0)) || (a.id < b.id ? -1 : 1));
}

function tags(list) {
  return (Array.isArray(list) ? list : []).map(String).filter((t) => TAG_RE.test(t));
}

function cleanPosition(position) {
  if (!position || typeof position !== 'object' || !TAG_RE.test(String(position.level || ''))) return null;
  const out = { level: position.level };
  if (['left', 'right', 'center'].includes(position.side)) out.side = position.side;
  out.landmark = TAG_RE.test(String(position.landmark || '')) ? position.landmark : null;
  return out;
}

/**
 * The state an issue ends in, read from its panel ledger, or null when the
 * issue has no page. Shaped as continuity-state.schema.json.
 */
function deriveFinalState(root, issue, { forIssue = null } = {}) {
  const pages = pagesInOrder(root, issue);
  if (!pages.length) return null;
  const characters = {};
  const props = {};
  for (const page of pages) {
    const panels = (Array.isArray(page.doc.panels) ? page.doc.panels : []).filter((p) => p && typeof p === 'object')
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    for (const panel of panels) {
      const location = typeof panel.location === 'string' ? panel.location : null;
      for (const row of Array.isArray(panel.cast) ? panel.cast : []) {
        if (!row || !/^CHAR_[A-Z][A-Z0-9_]*$/.test(String(row.character || ''))) continue;
        const entry = {
          location: location || (characters[row.character] && characters[row.character].location) || null,
          wardrobe: typeof row.wardrobe === 'string' ? row.wardrobe : null,
          state: tags(row.state),
          holding: (Array.isArray(row.holding) ? row.holding : []).map(String).filter((p) => /^PROP_[A-Z][A-Z0-9_]*$/.test(p)),
        };
        const position = cleanPosition(row.position);
        if (position) entry.position = position;
        characters[row.character] = entry;
        for (const prop of entry.holding) props[prop] = { custody: row.character, location: entry.location, state: (props[prop] && props[prop].state) || [] };
      }
      for (const row of Array.isArray(panel.props) ? panel.props : []) {
        if (!row || !/^PROP_[A-Z][A-Z0-9_]*$/.test(String(row.prop || ''))) continue;
        props[row.prop] = { custody: null, location, state: tags(row.state) };
      }
    }
  }
  // Only what the schema can hold: a row without a place or an outfit says nothing reliable.
  for (const [id, entry] of Object.entries(characters)) {
    if (!/^LOC_[A-Z][A-Z0-9_]*$/.test(String(entry.location || '')) || !/^WARD_[A-Z][A-Z0-9_]*$/.test(String(entry.wardrobe || ''))) {
      delete characters[id];
    }
  }
  for (const entry of Object.values(props)) {
    if (!/^LOC_[A-Z][A-Z0-9_]*$/.test(String(entry.location || ''))) delete entry.location;
  }
  const last = pages[pages.length - 1].id;
  return {
    issue,
    after_page: last,
    characters,
    props,
    open_threads: [],
    open_issues: [],
    last_validated: today(),
    notes: `${DERIVED} of ${issue}, up to ${last}${forIssue ? `, so that ${forIssue} opens from where it ended` : ''}. ` +
      'It has no open threads: /continuity-review writes a reviewed state with them.',
  };
}

function writeState(root, doc) {
  const rel = stateRel(doc.issue);
  const problems = S.schemaFindings('continuity-state', doc);
  if (problems.length) {
    throw new HttpError(409, 'state_invalid', `The end state of ${doc.issue} could not be written: ${problems[0].path} ${problems[0].message}`);
  }
  const file = S.ws.abs(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, headerOf(file, `# Schema: schemas/continuity-state.schema.json\n# The state ${doc.issue} ends in. The next issue opens from it (issue.yaml opens_from).\n\n`) + S.yaml.stringify(doc));
  return rel;
}

function isDerived(doc) {
  return !!doc && typeof doc.notes === 'string' && doc.notes.startsWith(DERIVED);
}

/**
 * The end state of an issue as a file the next one can open from: the one
 * on disk, or one derived from the ledger now.
 * @returns {{rel: string|null, written: boolean}}
 */
function ensureFinalState(root, issue, { forIssue = null } = {}) {
  const rel = stateRel(issue);
  const existing = S.ws.loadYaml(S.ws.abs(root, rel));
  const last = pagesInOrder(root, issue).map((p) => p.id).pop() || null;
  if (existing && (!isDerived(existing) || existing.after_page === last)) return { rel, written: false };
  const doc = deriveFinalState(root, issue, { forIssue });
  if (!doc) return { rel: existing ? rel : null, written: false };
  writeState(root, doc);
  return { rel, written: true };
}

/**
 * Create the next issue: its entry in the series plan and its issue.yaml,
 * opening from the state the previous issue ended in. Nothing else.
 * @returns {{issue, number, title, page_budget, previous, opens_from, state_written, files: string[]}}
 */
function createIssue(project, { title, pages, summary }) {
  const root = project.root;
  const existing = allIssues(root);
  const number = existing.reduce((max, id) => Math.max(max, issueNumber(id)), 0) + 1;
  if (number > 999) throw new HttpError(409, 'too_many_issues', 'A series holds at most 999 issues.');
  const id = issueId(number);
  const previous = existing.length ? existing[existing.length - 1] : null;
  const files = [];
  let opensFrom = null;
  let stateWritten = false;
  if (previous) {
    const state = ensureFinalState(root, previous, { forIssue: id });
    opensFrom = state.rel;
    stateWritten = state.written;
    if (state.written) files.push(state.rel);
  }

  const planFile = S.ws.abs(root, PLAN);
  const plan = S.ws.loadYaml(planFile) || { title: (S.ws.loadProject(root) || {}).title || project.id, issues: [] };
  if (!Array.isArray(plan.issues)) plan.issues = [];
  const entry = { id, number, title, page_budget: pages, status: 'planning' };
  if (summary) entry.summary = summary;
  plan.issues.push(entry);
  const planProblems = S.schemaFindings('series-plan', plan);
  if (planProblems.length) {
    throw new HttpError(409, 'plan_invalid', `The series plan could not be updated: ${planProblems[0].path} ${planProblems[0].message}`);
  }
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, headerOf(planFile, '# Schema: schemas/series-plan.schema.json\n\n') + S.yaml.stringify(plan));
  files.push(PLAN);

  const doc = {
    id,
    number,
    title,
    summary: summary || title,
    scenes: [],
    page_count: 0,
    panel_count: 0,
    opens_from: opensFrom,
    status: 'planning',
  };
  const problems = S.schemaFindings('issue', doc);
  if (problems.length) throw new HttpError(409, 'issue_invalid', `The issue could not be written: ${problems[0].path} ${problems[0].message}`);
  const issueFile = path.join(S.ws.issueDir(root, id), 'issue.yaml');
  fs.mkdirSync(path.dirname(issueFile), { recursive: true });
  fs.writeFileSync(issueFile, `# Schema: schemas/issue.schema.json\n# Created by the studio. /issue-breakdown fills in the scenes and pages.\n\n${S.yaml.stringify(doc)}`);
  files.push(`issues/${id}/issue.yaml`);
  return { issue: id, number, title, page_budget: pages, previous, opens_from: opensFrom, state_written: stateWritten, files };
}

/**
 * Before the first pages of an issue are planned: make sure the state it
 * opens from is there and current. A derived state is derived again when the
 * previous issue gained pages since; an issue created before the previous
 * one had pages gets its opens_from now.
 * @returns {{opens_from: string|null, file: string|null, previous: string|null}}
 */
function openingState(project, issue) {
  const root = project.root;
  const n = issueNumber(issue);
  const previous = n > 1 ? issueId(n - 1) : null;
  const issueFile = path.join(S.ws.issueDir(root, issue), 'issue.yaml');
  const doc = S.ws.loadYaml(issueFile);
  const firstPages = !S.ws.listPageIds(root, issue).length;
  let opensFrom = doc && typeof doc.opens_from === 'string' ? doc.opens_from : null;
  if (previous && firstPages && (!opensFrom || opensFrom === stateRel(previous))) {
    const state = ensureFinalState(root, previous, { forIssue: issue });
    if (state.rel && !opensFrom && doc) {
      // Only the one line changes: the comments of the file stay.
      const text = readText(issueFile);
      const next = /^opens_from:.*$/m.test(text)
        ? text.replace(/^opens_from:.*$/m, `opens_from: ${state.rel}`)
        : `${text.replace(/\n*$/, '\n')}opens_from: ${state.rel}\n`;
      fs.writeFileSync(issueFile, next);
    }
    if (state.rel) opensFrom = state.rel;
  }
  const file = opensFrom ? S.ws.abs(root, opensFrom) : null;
  return { opens_from: opensFrom, file: file && fs.existsSync(file) ? file : null, previous };
}

/**
 * Put opens_from back when a planning run dropped or changed it in issue.yaml.
 * @returns {boolean} true when it had to be restored
 */
function keepOpensFrom(project, issue, opensFrom) {
  if (!opensFrom) return false;
  const issueFile = path.join(S.ws.issueDir(project.root, issue), 'issue.yaml');
  const doc = S.ws.loadYaml(issueFile);
  if (!doc || doc.opens_from === opensFrom) return false;
  const text = readText(issueFile);
  const next = /^opens_from:.*$/m.test(text)
    ? text.replace(/^opens_from:.*$/m, `opens_from: ${opensFrom}`)
    : `${text.replace(/\n*$/, '\n')}opens_from: ${opensFrom}\n`;
  fs.writeFileSync(issueFile, next);
  return true;
}

module.exports = {
  DERIVED, allIssues, pagesInOrder, deriveFinalState, ensureFinalState, createIssue, openingState, keepOpensFrom, stateRel, issueId,
};
