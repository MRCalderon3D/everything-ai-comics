'use strict';
/**
 * The person's story, and the AI's proposals for it.
 *
 * A new project gets its starter story files written mechanically, from what
 * the person typed: the description as the source text, a story bible that is
 * empty but valid (its premise is the description), and a series plan of one
 * issue. No AI runs.
 *
 * When the person asks, an operation (story.draft, story.complete,
 * story.suggest, or a chat message) returns a proposal: parts the AI would
 * add to the story bible, stored in <project>/.studio/proposals/<id>.json.
 * Nothing reaches story/story-bible.yaml until the person accepts a part.
 * Accepting writes it through the scaffold's comment-keeping YAML helpers
 * (scripts/lib/yaml-edit.js) as one history commit.
 *
 * Provenance of an accepted fact, by the schema (schemas/story-bible.schema.json):
 *   accepted as proposed      the provenance the proposal gives: `source` with a
 *                             source_ref when the fact is stated in a file under
 *                             story/source/, `user_change` when it restates what
 *                             the person asked for, else `addition`
 *   accepted with edited text `user_change`: the words are the person's
 */

const fs = require('fs');
const path = require('path');
const S = require('./scaffold');
const { msg } = require('./i18n');
const { HttpError, newId, nowIso, readJson, writeJsonAtomic } = require('./util');

const SOURCE = 'story/source/description.md';
const BIBLE = 'story/story-bible.yaml';
const PLAN = 'story/series-plan.yaml';
const PART_TYPES = ['premise', 'tone', 'world_rule', 'fact', 'arc', 'timeline', 'question'];
const PROVENANCES = ['source', 'user_change', 'addition'];
const ROLES = ['protagonist', 'antagonist', 'supporting', 'background'];
const ENTITY_RE = /^(CHAR|LOC|PROP|LOOK)_[A-Z][A-Z0-9_]*$/;
const CHAR_RE = /^CHAR_[A-Z][A-Z0-9_]*$/;
const PROPOSAL_RE = /^prop_[a-z0-9_]{6,60}$/;
const TEXT_MAX = 4000;

// --- the starter files of a new project ------------------------------------------------

function headerOf(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const header = S.yamlEdit ? S.yamlEdit.leadingComments(text) : '';
    return header || fallback;
  } catch (err) {
    return fallback;
  }
}

/**
 * Write the person's description as the source text, an empty but valid
 * story bible and a one-issue series plan. Mechanical: no AI.
 * @param {object} project
 * @param {{title: string, description: string, pages: number}} input
 * @returns {string[]} the workspace-relative paths written
 */
function writeStarterStory(project, { title, description, pages }) {
  const root = project.root;
  const written = [];
  const text = String(description || '').trim();
  if (text) {
    const file = S.ws.abs(root, SOURCE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# ${title}\n\n${text}\n`);
    written.push(SOURCE);
  }
  const bibleFile = S.ws.abs(root, BIBLE);
  const bible = {
    title,
    // The premise is the person's own text until they or an accepted proposal change it.
    premise: text || title,
    tone: '',
    world_rules: [],
    facts: [],
    characters: [],
    timeline: [],
    open_questions: [],
  };
  fs.mkdirSync(path.dirname(bibleFile), { recursive: true });
  fs.writeFileSync(bibleFile, headerOf(bibleFile, '# Schema: schemas/story-bible.schema.json\n\n') + S.yaml.stringify(bible));
  written.push(BIBLE);
  const planFile = S.ws.abs(root, PLAN);
  const issue = { id: 'ISS_001', number: 1, title, page_budget: pages, status: 'planning' };
  if (text) issue.source_span = SOURCE;
  fs.writeFileSync(planFile, headerOf(planFile, '# Schema: schemas/series-plan.schema.json\n\n') + S.yaml.stringify({ title, issues: [issue] }));
  written.push(PLAN);
  return written;
}

/** The person's own story text: the description and the files under story/source/. */
function sourceFiles(project) {
  const dir = path.join(project.root, 'story', 'source');
  try {
    return fs.readdirSync(dir)
      .filter((n) => /\.(md|txt|fountain)$/i.test(n) && fs.statSync(path.join(dir, n)).isFile())
      .sort((a, b) => (a === 'description.md' ? -1 : b === 'description.md' ? 1 : a.localeCompare(b)))
      .map((n) => `story/source/${n}`);
  } catch (err) {
    return [];
  }
}

// --- proposals: storage -------------------------------------------------------------------

function dirOf(project) {
  return path.join(project.studioDir, 'proposals');
}

function fileOf(project, id) {
  return path.join(dirOf(project), `${id}.json`);
}

function counts(proposal) {
  const out = { parts: proposal.parts.length, pending: 0, accepted: 0, edited: 0, rejected: 0 };
  for (const part of proposal.parts) out[part.status] = (out[part.status] || 0) + 1;
  return out;
}

/** The proposal as the API returns it. */
function view(proposal) {
  return Object.assign({}, proposal, { counts: counts(proposal) });
}

function summaryView(proposal) {
  return {
    id: proposal.id,
    kind: proposal.kind,
    status: proposal.status,
    title: proposal.title,
    instruction: proposal.instruction || null,
    summary: proposal.summary || '',
    created_at: proposal.created_at,
    updated_at: proposal.updated_at,
    job: proposal.job || null,
    tool: proposal.tool || null,
    counts: counts(proposal),
  };
}

function read(project, id) {
  if (!PROPOSAL_RE.test(String(id))) throw new HttpError(404, 'proposal_not_found', 'There is no proposal with that id.');
  const proposal = readJson(fileOf(project, id), null);
  if (!proposal || !Array.isArray(proposal.parts)) throw new HttpError(404, 'proposal_not_found', 'There is no proposal with that id.');
  return proposal;
}

function save(project, proposal) {
  proposal.updated_at = nowIso();
  writeJsonAtomic(fileOf(project, proposal.id), proposal);
}

/** Every proposal, newest first. `status` filters (open, closed, discarded). */
function list(project, { status } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(dirOf(project)).filter((n) => /^prop_.+\.json$/.test(n));
  } catch (err) {
    return [];
  }
  return names
    .map((n) => readJson(path.join(dirOf(project), n), null))
    .filter((p) => p && Array.isArray(p.parts) && (!status || p.status === status))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)))
    .map(summaryView);
}

// --- proposals: from what a tool returned -----------------------------------------------

function textOf(value, max = TEXT_MAX) {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim().slice(0, max) : '';
}

/**
 * Parts from the `proposal` object a tool returned:
 * { premise, tone, world_rules[], facts[], arcs[], timeline[], questions[] }.
 * Anything malformed is left out. Ids are P01, P02... in that order.
 */
function partsFrom(data, project) {
  const d = data && typeof data === 'object' ? data : {};
  const parts = [];
  const add = (part) => parts.push(Object.assign({ id: `P${String(parts.length + 1).padStart(2, '0')}` }, part, {
    status: 'pending', decided_at: null, final_text: null, written: null,
  }));
  const premise = textOf(d.premise);
  if (premise) add({ type: 'premise', text: premise });
  const tone = textOf(d.tone, 300);
  if (tone) add({ type: 'tone', text: tone });
  for (const rule of Array.isArray(d.world_rules) ? d.world_rules.slice(0, 30) : []) {
    const text = textOf(typeof rule === 'string' ? rule : rule && rule.text, 600);
    if (text) add({ type: 'world_rule', text });
  }
  const sources = new Set(project ? sourceFiles(project) : []);
  for (const fact of Array.isArray(d.facts) ? d.facts.slice(0, 60) : []) {
    if (!fact || typeof fact !== 'object') continue;
    const text = textOf(fact.statement || fact.text, 600);
    if (!text) continue;
    let provenance = PROVENANCES.includes(fact.provenance) ? fact.provenance : 'addition';
    const ref = typeof fact.source_ref === 'string' ? fact.source_ref.trim() : '';
    // A fact said to come from the person's text has to point at a file of story/source/.
    if (provenance === 'source' && !sources.has(ref.split('#')[0])) provenance = 'addition';
    add({
      type: 'fact',
      text,
      provenance,
      source_ref: provenance === 'source' ? ref : null,
      affects: (Array.isArray(fact.affects) ? fact.affects : []).filter((x) => typeof x === 'string' && ENTITY_RE.test(x)).slice(0, 12),
    });
  }
  for (const arc of Array.isArray(d.arcs) ? d.arcs.slice(0, 30) : []) {
    if (!arc || typeof arc !== 'object' || !CHAR_RE.test(String(arc.character || ''))) continue;
    const text = textOf(arc.arc || arc.text, 600);
    if (!text) continue;
    add({ type: 'arc', text, character: String(arc.character), role: ROLES.includes(arc.role) ? arc.role : null });
  }
  const events = (Array.isArray(d.timeline) ? d.timeline.slice(0, 60) : [])
    .filter((e) => e && typeof e === 'object' && textOf(e.event || e.text, 600))
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (Number(a.e.order) || a.i + 1) - (Number(b.e.order) || b.i + 1));
  for (const { e } of events) {
    add({
      type: 'timeline',
      text: textOf(e.event || e.text, 600),
      issue: /^ISS_\d{3}$/.test(String(e.issue || '')) ? String(e.issue) : null,
    });
  }
  for (const q of Array.isArray(d.questions) ? d.questions.slice(0, 30) : []) {
    if (!q || typeof q !== 'object') continue;
    const text = textOf(q.question || q.text, 600);
    if (!text) continue;
    add({
      type: 'question',
      text,
      blocking: q.blocking === true,
      options: (Array.isArray(q.options) ? q.options : []).map((o) => textOf(o, 300)).filter(Boolean).slice(0, 6),
      answer: null,
    });
  }
  return parts;
}

/**
 * Store a new proposal. `data` is the proposal object a tool returned.
 * @returns {object} the stored proposal
 */
function create(project, { kind, instruction, data, summary, decisions, job, tool, conversation, message }) {
  const parts = partsFrom(data, project);
  const at = nowIso();
  const proposal = {
    id: newId('prop').toLowerCase(),
    kind,
    title: msg(`proposal.title.${kind}`),
    instruction: instruction || null,
    status: parts.length ? 'open' : 'closed',
    created_at: at,
    updated_at: at,
    job: job || null,
    tool: tool || null,
    summary: String(summary || ''),
    decisions: Array.isArray(decisions) ? decisions.map(String) : [],
    conversation: conversation || null,
    message: message || null,
    parts,
    commits: [],
  };
  fs.mkdirSync(dirOf(project), { recursive: true });
  save(project, proposal);
  return proposal;
}

// --- proposals: the person decides --------------------------------------------------------

const DECISIONS = ['accept', 'edit', 'reject'];

/** Check the decisions of a request against a proposal. Throws 400/409. Returns them clean. */
function checkDecisions(proposal, decisions) {
  if (proposal.status !== 'open') {
    throw new HttpError(409, 'proposal_closed', `This proposal is ${proposal.status}: nothing more can be decided on it.`);
  }
  if (!Array.isArray(decisions) || !decisions.length || decisions.length > 200) {
    throw new HttpError(400, 'bad_params', 'Send { "decisions": [{ "part": "P01", "decision": "accept" | "edit" | "reject", "text": "..." }] }.');
  }
  const seen = new Set();
  return decisions.map((d) => {
    if (!d || typeof d !== 'object') throw new HttpError(400, 'bad_params', 'Every decision is an object.');
    const part = proposal.parts.find((p) => p.id === d.part);
    if (!part) throw new HttpError(404, 'part_not_found', `This proposal has no part ${String(d.part).slice(0, 20)}.`);
    if (seen.has(part.id)) throw new HttpError(400, 'bad_params', `Part ${part.id} is decided twice in this request.`);
    seen.add(part.id);
    if (part.status !== 'pending') throw new HttpError(409, 'part_decided', `Part ${part.id} is already ${part.status}.`);
    if (!DECISIONS.includes(d.decision)) throw new HttpError(400, 'bad_params', `"decision" must be accept, edit or reject (part ${part.id}).`);
    const text = d.decision === 'edit' ? textOf(d.text, part.type === 'premise' ? TEXT_MAX : 600) : '';
    if (d.decision === 'edit' && !text) throw new HttpError(400, 'bad_params', `"text" is required to accept part ${part.id} with edited text.`);
    const answer = part.type === 'question' && d.decision !== 'reject' ? textOf(d.answer, 2000) || null : null;
    return { part, decision: d.decision, text, answer };
  });
}

function entityExists(root, id) {
  try {
    if (/^CHAR_/.test(id)) return !!S.ws.loadCharacter(root, id);
    if (/^LOC_/.test(id)) return !!S.ws.loadLocation(root, id);
    if (/^PROP_/.test(id)) return !!S.ws.loadProp(root, id);
    if (/^LOOK_/.test(id)) return [...S.ws.loadReferenceAssets(root).values()].some((a) => a.entity === id);
  } catch (err) {
    return false;
  }
  return false;
}

function nextFactId(facts) {
  const max = facts.reduce((m, f) => Math.max(m, parseInt(String((f && f.id) || '').slice(5), 10) || 0), 0);
  return `FACT_${String(max + 1).padStart(3, '0')}`;
}

/**
 * Apply accepted parts to a parsed story bible, in place. Returns, per part,
 * what was written ({ fact: 'FACT_004' }, { dropped_affects: [...] }...).
 */
function applyParts(doc, accepted, root) {
  const written = new Map();
  for (const key of ['world_rules', 'facts', 'characters', 'timeline', 'open_questions']) {
    if (!Array.isArray(doc[key])) doc[key] = [];
  }
  for (const { part, decision, text, answer } of accepted) {
    const words = decision === 'edit' ? text : part.text;
    const out = {};
    switch (part.type) {
      case 'premise':
        doc.premise = words;
        break;
      case 'tone':
        doc.tone = words;
        break;
      case 'world_rule':
        doc.world_rules.push(words);
        break;
      case 'fact': {
        const id = nextFactId(doc.facts);
        const provenance = decision === 'edit' ? 'user_change' : part.provenance;
        const affects = (part.affects || []).filter((x) => entityExists(root, x));
        const dropped = (part.affects || []).filter((x) => !affects.includes(x));
        const fact = { id, statement: words, provenance };
        if (provenance === 'source' && part.source_ref) fact.source_ref = part.source_ref;
        fact.replaces = null;
        fact.affects = affects;
        doc.facts.push(fact);
        out.fact = id;
        out.provenance = provenance;
        if (dropped.length) out.dropped_affects = dropped;
        break;
      }
      case 'arc': {
        let row = doc.characters.find((c) => c && c.id === part.character);
        if (!row) {
          row = { id: part.character };
          if (part.role) row.role = part.role;
          doc.characters.push(row);
          out.added_character = part.character;
        }
        row.arc = words;
        out.character = part.character;
        break;
      }
      case 'timeline': {
        const order = doc.timeline.reduce((m, e) => Math.max(m, Number(e && e.order) || 0), 0) + 1;
        const event = { order, event: words };
        if (part.issue) event.issue = part.issue;
        doc.timeline.push(event);
        out.order = order;
        break;
      }
      case 'question': {
        const q = { question: words, blocking: !!part.blocking, resolution: answer || null };
        doc.open_questions.push(q);
        out.resolved = !!answer;
        break;
      }
      default:
        break;
    }
    written.set(part.id, out);
  }
  return written;
}

// --- writing into the file and keeping its comments ------------------------------------------

function itemLines(value, indent) {
  return S.yaml.stringify([value]).replace(/\n$/, '').split('\n').map((l) => `${' '.repeat(indent)}${l}`);
}

/**
 * The same change as applyParts, made on the lines of the file: scalars are
 * set where they are, list items are added at the end of their list. Returns
 * false when a change cannot be placed; rewriteYamlFile then writes the file
 * from the document, keeping only its top comments.
 */
function editLines(before, doc) {
  const E = S.yamlEdit;
  return (lines) => {
    for (const key of ['title', 'premise', 'tone']) {
      if (doc[key] === before[key] || doc[key] === undefined) continue;
      const range = E.findKey(lines, key, 0);
      if (range) {
        if (!E.setValue(lines, range, doc[key])) return false;
      } else {
        const after = E.findKey(lines, key === 'tone' ? 'premise' : 'title', 0);
        const at = after ? after.end : 0;
        lines.splice(at, 0, `${key}: ${E.scalarText(doc[key])}`);
      }
    }
    for (const key of ['world_rules', 'facts', 'timeline', 'open_questions']) {
      const old = Array.isArray(before[key]) ? before[key] : [];
      const added = doc[key].slice(old.length);
      if (!added.length) continue;
      if (JSON.stringify(doc[key].slice(0, old.length)) !== JSON.stringify(old)) return false;
      if (!appendItems(lines, key, added)) return false;
    }
    // characters: an arc on an existing row is set in place; a new row is appended.
    const oldChars = Array.isArray(before.characters) ? before.characters : [];
    for (const row of doc.characters) {
      const was = oldChars.find((c) => c && c.id === row.id);
      if (!was) continue;
      if (was.arc === row.arc) continue;
      const item = E.findItem(lines, 'id', row.id);
      if (!item) return false;
      const arc = E.findKey(lines, 'arc', item.fieldIndent, item.line + 1, item.end);
      if (arc) {
        if (!E.setValue(lines, arc, row.arc)) return false;
      } else {
        lines.splice(item.end, 0, `${' '.repeat(item.fieldIndent)}arc: ${E.scalarText(row.arc)}`);
      }
    }
    const newRows = doc.characters.filter((row) => !oldChars.some((c) => c && c.id === row.id));
    if (newRows.length && !appendItems(lines, 'characters', newRows)) return false;
    return true;
  };
}

/** Add items at the end of a top-level list, in the style the file uses. */
function appendItems(lines, key, items) {
  const E = S.yamlEdit;
  const range = E.findKey(lines, key, 0);
  if (!range) {
    let end = lines.length;
    while (end > 0 && lines[end - 1].trim() === '') end -= 1;
    lines.splice(end, 0, `${key}:`, ...items.flatMap((item) => itemLines(item, 2)));
    return true;
  }
  const head = /^([^:#]+:)(.*)$/.exec(lines[range.line]);
  const rest = head ? head[2].replace(/#.*$/, '').trim() : '';
  if (rest === '[]') {
    const comment = /#.*$/.exec(head[2]);
    lines.splice(range.line, range.end - range.line, `${key}:${comment ? `  ${comment[0]}` : ''}`, ...items.flatMap((item) => itemLines(item, 2)));
    return true;
  }
  if (rest !== '') {
    // A flow list with items: only lists of plain strings can stay flow.
    if (!items.every((i) => typeof i === 'string')) return false;
    const current = S.yaml.parse(`${key}: ${rest}`)[key];
    return E.setValue(lines, range, [...(Array.isArray(current) ? current : []), ...items]);
  }
  const indent = E.childIndent(lines, range);
  lines.splice(range.end, 0, ...items.flatMap((item) => itemLines(item, indent === null ? 2 : indent)));
  return true;
}

/**
 * Write the accepted parts into story/story-bible.yaml.
 * @returns {{written: Map, preserved: boolean}}
 */
function writeAccepted(project, accepted) {
  const root = project.root;
  const file = S.ws.abs(root, BIBLE);
  if (!fs.existsSync(file)) {
    const title = ((S.ws.loadProject(root) || {}).title) || project.id;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# Schema: schemas/story-bible.schema.json\n\n${S.yaml.stringify({ title, premise: title, facts: [], characters: [] })}`);
  }
  let before;
  try {
    before = S.yaml.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new HttpError(422, 'workspace_yaml', `story/story-bible.yaml does not parse: ${err.message}`);
  }
  if (!before || typeof before !== 'object' || Array.isArray(before)) {
    throw new HttpError(422, 'workspace_yaml', 'story/story-bible.yaml is not a map.');
  }
  let written = new Map();
  let target = null;
  const result = S.yamlEdit.rewriteYamlFile(file, (doc) => {
    written = applyParts(doc, accepted, root);
    target = doc;
  }, (lines) => editLines(before, target)(lines));
  return { written, preserved: result.preserved };
}

/**
 * Record the person's decisions on a proposal. Accepted parts are written
 * first; the proposal file is updated after. The caller wraps this in a
 * history record, so the write is one commit.
 */
function decide(project, proposal, clean) {
  const accepted = clean.filter((d) => d.decision !== 'reject');
  let written = new Map();
  let preserved = true;
  if (accepted.length) ({ written, preserved } = writeAccepted(project, accepted));
  const at = nowIso();
  for (const d of clean) {
    d.part.status = d.decision === 'reject' ? 'rejected' : d.decision === 'edit' ? 'edited' : 'accepted';
    d.part.decided_at = at;
    d.part.final_text = d.decision === 'edit' ? d.text : (d.decision === 'accept' ? d.part.text : null);
    if (d.part.type === 'question' && d.answer) d.part.answer = d.answer;
    d.part.written = written.get(d.part.id) || null;
  }
  if (proposal.parts.every((p) => p.status !== 'pending')) proposal.status = 'closed';
  return { accepted: accepted.length, rejected: clean.length - accepted.length, preserved };
}

function discard(project, proposal) {
  if (proposal.status !== 'open') {
    throw new HttpError(409, 'proposal_closed', `This proposal is ${proposal.status} already.`);
  }
  proposal.status = 'discarded';
  proposal.discarded_at = nowIso();
  save(project, proposal);
  return proposal;
}

module.exports = {
  SOURCE, BIBLE, PLAN, PART_TYPES, PROPOSAL_RE,
  writeStarterStory, sourceFiles,
  partsFrom, create, read, save, list, view, summaryView, checkDecisions, decide, discard, applyParts,
};
