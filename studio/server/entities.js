'use strict';
/**
 * Characters, places and objects: which IDs exist, what a step added, and
 * which new ones look like someone the project already knows.
 *
 * Found in a real run (TODO item 11): a story proposal named two attackers
 * CHAR_GREY_HAIRED_MAN and CHAR_BEARDED_MAN, and a page plan running at about
 * the same time wrote their files as CHAR_ORANGE_GREY and CHAR_ORANGE_BEARD.
 * Two defences:
 *
 * - Every prompt that may create an entity gets the list of IDs that already
 *   exist (knownText): entity files, the story bible's characters, and the
 *   characters of proposals still waiting for the person. The prompt says to
 *   reuse an ID for the same person, place or object.
 * - After every step that wrote files, inspectStep finds the entity files it
 *   added and compares each one with what existed before. A close match is
 *   flagged as a possible duplicate on the job (job.added_entities), where
 *   the screens and the chat offer to merge or rename it.
 *
 * The comparison is a plain word match, in any language the files use: the
 * words of the new entity's name (and of each alias) are looked for in what
 * is written about the existing one (its name, aliases and description, or
 * the arc a proposal gives it), and the other way round; the words of the two
 * IDs count too. Generic words (man, woman, hombre, the, del...) do not
 * count. A flag is a question for the person, never a change.
 */

const fs = require('fs');
const path = require('path');
const S = require('./scaffold');
const story = require('./story');

const KINDS = [
  { kind: 'character', dir: 'characters', file: 'character.yaml', prefix: 'CHAR' },
  { kind: 'location', dir: 'locations', file: 'location.yaml', prefix: 'LOC' },
  { kind: 'prop', dir: 'props', file: 'prop.yaml', prefix: 'PROP' },
];
const ENTITY_FILE_RE = /^(characters|locations|props)\/((?:CHAR|LOC|PROP)_[A-Z][A-Z0-9_]*)\/(character|location|prop)\.yaml$/;

/** Words that say nothing about who someone is: articles, prepositions, people in general. */
const STOP = new Set([
  'the', 'and', 'with', 'without', 'for', 'from', 'his', 'her', 'their', 'who', 'that', 'this', 'one', 'two',
  'man', 'men', 'woman', 'women', 'boy', 'girl', 'person', 'people', 'guy', 'kid', 'child', 'character',
  'del', 'los', 'las', 'una', 'uno', 'con', 'por', 'para', 'que', 'sus', 'muy', 'mas', 'como', 'pero',
  'hombre', 'mujer', 'chico', 'chica', 'nino', 'nina', 'persona', 'senor', 'senora', 'tipo', 'joven',
  'des', 'les', 'une', 'avec', 'dans',
]);

function norm(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Distinct words of three letters or more, without the generic ones. */
function words(text) {
  const out = [];
  for (const w of norm(text).split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w) || out.includes(w)) continue;
    out.push(w);
  }
  return out;
}

const NEGATIONS = new Set(['no', 'not', 'without', 'sin', 'ni', 'sans', 'kein', 'ohne']);

/**
 * The words of a description, without the ones it denies: "no beard" and
 * "sin barba" say the person has none, so "beard" must not match a bearded man.
 */
function textWords(text) {
  const out = [];
  let skip = false;
  for (const w of norm(text).split(/[^a-z0-9]+/)) {
    if (!w) continue;
    if (NEGATIONS.has(w)) {
      skip = true;
      continue;
    }
    if (skip) {
      skip = false;
      continue;
    }
    if (w.length < 3 || STOP.has(w) || out.includes(w)) continue;
    out.push(w);
  }
  return out;
}

/** The words of an ID: CHAR_GREY_HAIRED_MAN -> grey, haired. */
function idWords(id) {
  return words(String(id || '').replace(/^(CHAR|LOC|PROP)_/, '').replace(/_/g, ' '));
}

/** Same word, or one starts the other (beard, bearded) when both have four letters or more. */
function same(a, b) {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function matchCount(list, pool) {
  return list.filter((w) => pool.some((p) => same(w, p))).length;
}

/** "CHAR_GREY_HAIRED_MAN" -> "Grey haired man", for an ID nobody gave a name yet. */
function prettyId(id) {
  const text = String(id || '').replace(/^(CHAR|LOC|PROP)_/, '').toLowerCase().replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function attempt(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    return fallback;
  }
}

function kindOfId(id) {
  const prefix = String(id || '').split('_')[0];
  const found = KINDS.find((k) => k.prefix === prefix);
  return found ? found.kind : null;
}

/** An entity file as a known entity: its names (name, aliases) and everything written about it. */
function fromFile(root, kindDef, id) {
  const doc = attempt(() => S.ws.loadYaml(path.join(root, kindDef.dir, id, kindDef.file)), null);
  if (!doc) return null;
  const desc = doc.description && typeof doc.description === 'object' ? doc.description : {};
  const aliases = Array.isArray(doc.aliases) ? doc.aliases.filter((a) => typeof a === 'string') : [];
  const features = Array.isArray(desc.distinguishing_features) ? desc.distinguishing_features : [];
  return {
    id,
    kind: kindDef.kind,
    source: 'file',
    has_file: true,
    name: typeof doc.name === 'string' && doc.name.trim() ? doc.name : prettyId(id),
    names: [doc.name, ...aliases].filter((n) => typeof n === 'string' && n.trim()),
    text: [doc.name, ...aliases, desc.summary, doc.prompt_summary, ...features].filter((x) => typeof x === 'string').join(' '),
    path: `${kindDef.dir}/${id}/${kindDef.file}`,
  };
}

/**
 * Every entity the project knows, from the files, the story bible and the
 * proposals still open: [{ id, kind, source, has_file, name, names, text, proposal? }].
 * An ID found in several places is listed once: the file wins, the texts add up.
 */
function known(project, { skip = [] } = {}) {
  const root = project.root;
  const out = new Map();
  const add = (entry) => {
    if (!entry || skip.includes(entry.id)) return;
    const was = out.get(entry.id);
    if (!was) {
      out.set(entry.id, entry);
      return;
    }
    was.text = `${was.text} ${entry.text || ''}`.trim();
    if (!was.proposal && entry.proposal) was.proposal = entry.proposal;
    if (was.source !== 'file' && entry.source === 'file') Object.assign(was, entry, { text: was.text });
  };
  for (const def of KINDS) {
    for (const id of attempt(() => S.ws.listEntityIds(root, def.dir), [])) add(fromFile(root, def, id));
  }
  const bible = attempt(() => S.ws.loadYaml(S.ws.abs(root, story.BIBLE)), null) || {};
  const facts = Array.isArray(bible.facts) ? bible.facts : [];
  for (const row of Array.isArray(bible.characters) ? bible.characters : []) {
    if (!row || typeof row.id !== 'string' || !S.ws.ID.entity.test(row.id)) continue;
    const about = facts.filter((f) => f && Array.isArray(f.affects) && f.affects.includes(row.id)).map((f) => f.statement);
    add({
      id: row.id, kind: 'character', source: 'bible', has_file: false, name: prettyId(row.id), names: [],
      text: [row.arc, ...about].filter((x) => typeof x === 'string').join(' '),
    });
  }
  for (const summary of attempt(() => story.list(project, { status: 'open' }), [])) {
    const proposal = attempt(() => story.read(project, summary.id), null);
    if (!proposal) continue;
    for (const part of proposal.parts) {
      if (part.status === 'rejected') continue;
      if (part.type === 'arc' && part.character) {
        add({ id: part.character, kind: 'character', source: 'proposal', proposal: proposal.id, has_file: false, name: prettyId(part.character), names: [], text: part.text || '' });
      }
      if (part.type === 'fact') {
        for (const id of Array.isArray(part.affects) ? part.affects : []) {
          add({ id, kind: kindOfId(id), source: 'proposal', proposal: proposal.id, has_file: false, name: prettyId(id), names: [], text: part.text || '' });
        }
      }
    }
  }
  return [...out.values()].filter((e) => e.kind);
}

/**
 * How much two entities look like the same one.
 * @returns {{score: number, matched: number, ids: number, flagged: boolean}}
 */
function similarity(a, b) {
  const textA = textWords(a.text);
  const textB = textWords(b.text);
  let best = { cov: 0, matched: 0 };
  const consider = (nameList, pool) => {
    for (const name of nameList) {
      const list = words(name);
      if (!list.length) continue;
      const matched = matchCount(list, pool);
      const cov = matched / list.length;
      if (cov > best.cov || (cov === best.cov && matched > best.matched)) best = { cov, matched };
    }
  };
  // An ID stands in for a name only when nobody gave one; the words of IDs count below.
  const namesA = a.names && a.names.length ? a.names : [prettyId(a.id)];
  const namesB = b.names && b.names.length ? b.names : [prettyId(b.id)];
  consider(namesA, textB);
  consider(namesB, textA);
  const idsA = idWords(a.id);
  const idsB = idWords(b.id);
  const ids = idsA.length && idsB.length ? matchCount(idsA, idsB) / Math.min(idsA.length, idsB.length) : 0;
  const score = Math.round((best.cov + 0.5 * ids) * 100) / 100;
  // Two words of a name found, or one ID inside the other (CHAR_MARTA, CHAR_MARTA_LOPEZ).
  // One shared word of two IDs is not enough: CHAR_ORANGE_GREY and CHAR_ORANGE_BEARD are two people.
  const flagged = score >= 1 && (best.matched >= 2 || (ids === 1 && best.cov >= 0.5));
  return { score, matched: best.matched, ids, flagged };
}

/** The known entities a new one may duplicate, best first. */
function duplicatesOf(entry, universe) {
  return universe
    .filter((other) => other.id !== entry.id && other.kind === entry.kind)
    .map((other) => ({ other, sim: similarity(entry, other) }))
    .filter((x) => x.sim.flagged)
    .sort((x, y) => y.sim.score - x.sim.score)
    .slice(0, 3)
    .map(({ other, sim }) => ({
      id: other.id,
      name: other.name,
      source: other.source,
      has_file: !!other.has_file,
      proposal: other.proposal || null,
      score: sim.score,
    }));
}

/**
 * services.inspectStep: after a step that wrote files, note the entities it
 * added on the job, each with its possible duplicates.
 */
function inspectStep(project, job, step, changes) {
  const added = changes.filter((c) => c.change === 'added' && ENTITY_FILE_RE.test(c.path))
    .map((c) => ENTITY_FILE_RE.exec(c.path)[2]);
  if (!added.length) return;
  const universe = known(project, { skip: added });
  if (!Array.isArray(job.added_entities)) job.added_entities = [];
  for (const id of added) {
    if (job.added_entities.some((e) => e.id === id)) continue;
    const def = KINDS.find((k) => k.prefix === id.split('_')[0]);
    const entry = fromFile(project.root, def, id) || { id, kind: def.kind, name: prettyId(id), names: [], text: '', path: `${def.dir}/${id}/${def.file}` };
    const duplicates = duplicatesOf(entry, universe);
    job.added_entities.push({ id, kind: def.kind, name: entry.name, path: entry.path, step: step.id, duplicates });
    if (job.id && duplicates.length) {
      try {
        const line = `${id} may be the same as ${duplicates.map((d) => `${d.id} (${d.source})`).join(', ')}: the person can merge or rename it`;
        fs.appendFileSync(path.join(project.jobsDir, `${job.id}.log`), `${new Date().toISOString()} ${step.id} ${line}\n`);
      } catch (err) {
        // the log is a convenience
      }
    }
  }
}

/**
 * The entities a job added, as they stand now: still there, renamed or
 * merged away, whether a character still needs a sheet, and the possible
 * duplicates checked again against what exists now.
 */
function addedView(project, job) {
  const list = Array.isArray(job && job.added_entities) ? job.added_entities : [];
  if (!list.length) return [];
  const root = project.root;
  const assets = attempt(() => S.ws.loadReferenceAssets(root), new Map());
  const universe = known(project);
  return list.map((entry) => {
    const def = KINDS.find((k) => k.kind === entry.kind) || KINDS[0];
    const exists = fs.existsSync(path.join(root, def.dir, entry.id, def.file));
    const now = exists ? fromFile(root, def, entry.id) : null;
    const hasMaster = exists && [...assets.values()].some((a) => a && a.entity === entry.id && a.status === 'approved');
    const duplicates = now ? duplicatesOf(now, universe.filter((u) => u.id !== entry.id)) : [];
    return {
      id: entry.id,
      kind: entry.kind,
      name: now ? now.name : entry.name,
      path: entry.path,
      exists,
      needs_sheet: entry.kind === 'character' && exists && !hasMaster,
      duplicates,
    };
  });
}

/**
 * The known IDs as lines for a prompt. Empty when the project has none.
 */
function knownText(project) {
  const list = attempt(() => known(project), []);
  if (!list.length) return '';
  const where = (e) => (e.source === 'file' ? 'file' : e.source === 'bible' ? 'story bible, no file yet' : `open proposal ${e.proposal}, no file yet`);
  return list.slice(0, 120).map((e) => {
    const names = e.has_file ? (e.names || []).slice(0, 4).join(' / ') : '';
    const about = !e.has_file && e.text ? `: ${String(e.text).replace(/\s+/g, ' ').slice(0, 140)}` : '';
    return `- ${e.id}${names ? ` (${names})` : ''} [${where(e)}]${about}`;
  }).join('\n');
}

module.exports = {
  KINDS, ENTITY_FILE_RE, words, idWords, similarity, known, duplicatesOf, inspectStep, addedView, knownText, prettyId, kindOfId,
};
