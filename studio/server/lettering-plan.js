'use strict';
/**
 * The lettering of a planned page: the balloons, captions and sound effects
 * of each panel in page.yaml, edited from the plan review of the page screen
 * or by the chat (the page.lettering action). Both go through savePlan, so a
 * click and a card do the same thing.
 *
 * What it keeps true (rules/lettering/balloons-and-captions.md and
 * reading-order.md):
 * - every element has an id unique within the page (L01..L99); kept ones
 *   keep theirs, because lettering.yaml and the reviews refer to them;
 * - `order` is the reading order of the page, renumbered from the panel
 *   order and the order of the elements in each panel;
 * - caption, narration, sign and sfx have no speaker; a spoken element has
 *   one, and that character has a row in the panel's cast. A voice from
 *   outside the frame gets an off-panel row copied from the character's
 *   nearest row on the page;
 * - the word budgets and the ceiling of elements per panel are warnings, not
 *   refusals: the person sees them before saving and decides.
 *
 * Tail direction is not a field of page.yaml: the rule derives it from the
 * speaker (at the mouth) and, off panel, from the side the character stands
 * on in the ledger. The screen says where it points; nothing is stored.
 */

const fs = require('fs');
const path = require('path');
const S = require('./scaffold');
const files = require('./files');
const history = require('./history');
const { msg } = require('./i18n');
const { HttpError } = require('./util');

/** letteringElement.type in schemas/page.schema.json, in the order the screen offers them. */
const KINDS = ['balloon', 'thought', 'shout', 'whisper', 'radio', 'caption', 'narration', 'sfx', 'sign'];
/** Kinds that have a speaker (rules/lettering/balloons-and-captions.md). */
const SPOKEN = ['balloon', 'thought', 'whisper', 'shout', 'radio'];
/** The rule's defaults when project.yaml sets no budget; elements per panel has no project field. */
const RULE_DEFAULTS = { words_per_balloon: 25, words_per_panel: 50, per_panel: 4 };
const CHAR_RE = /^CHAR_[A-Z][A-Z0-9_]*$/;
const ID_RE = /^L\d{2}$/;
const MAX_TEXT = 600;

/** The budgets of a project: project.lettering, else the rule's defaults. */
function limitsOf(projectDoc) {
  const l = (projectDoc && projectDoc.lettering) || {};
  return {
    words_per_balloon: Number.isInteger(l.max_words_per_balloon) && l.max_words_per_balloon > 0 ? l.max_words_per_balloon : RULE_DEFAULTS.words_per_balloon,
    words_per_panel: Number.isInteger(l.max_words_per_panel) && l.max_words_per_panel > 0 ? l.max_words_per_panel : RULE_DEFAULTS.words_per_panel,
    per_panel: RULE_DEFAULTS.per_panel,
  };
}

/** Words as a reader counts them: runs of letters or digits, punctuation alone is no word. */
function wordCount(text) {
  return String(text || '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function panelsInOrder(page) {
  return (Array.isArray(page.panels) ? page.panels : [])
    .map((p, i) => ({ p, i }))
    .filter((x) => x.p && typeof x.p === 'object')
    .sort((a, b) => ((a.p.order || 0) - (b.p.order || 0)) || (a.i - b.i))
    .map((x) => x.p);
}

/** A copy of a character's ledger row for a panel where they only speak from outside the frame. */
function offPanelRow(page, panel, character) {
  const ordered = panelsInOrder(page);
  const at = ordered.indexOf(panel);
  const rowIn = (p) => (Array.isArray(p.cast) ? p.cast : []).find((r) => r && r.character === character);
  let source = null;
  let later = false;
  for (let i = at - 1; i >= 0 && !source; i -= 1) source = rowIn(ordered[i]) || null;
  for (let i = at + 1; i < ordered.length && !source; i += 1) {
    source = rowIn(ordered[i]) || null;
    later = !!source;
  }
  if (!source) return null;
  let state = Array.isArray(source.state) ? source.state.slice() : [];
  if (later && source.state_changes) {
    // The state before that later panel: what it gained is not there yet, what it lost still is.
    const adds = Array.isArray(source.state_changes.adds) ? source.state_changes.adds : [];
    const resolves = Array.isArray(source.state_changes.resolves) ? source.state_changes.resolves : [];
    state = state.filter((t) => !adds.includes(t)).concat(resolves.filter((t) => !state.includes(t)));
  }
  const row = {
    character,
    off_panel: true,
    position: JSON.parse(JSON.stringify(source.position || {})),
    action: 'Speaks from outside the frame.',
    wardrobe: source.wardrobe,
    state,
  };
  if (source.facing) row.facing = source.facing;
  if (Array.isArray(source.holding) && source.holding.length) row.holding = source.holding.slice();
  if (source.carrying) row.carrying = source.carrying;
  return row;
}

/**
 * Make the lettering of a page consistent, in place. Returns what it did and
 * what it could not do: { added: [{panel, character}], problems: [{panel, element, code, detail}] }.
 */
function normalize(page) {
  const added = [];
  const problems = [];
  const ordered = panelsInOrder(page);
  const used = new Set();
  const fresh = [];
  for (const panel of ordered) {
    if (!Array.isArray(panel.lettering)) panel.lettering = [];
    panel.lettering = panel.lettering.filter((el) => el && typeof el === 'object');
    for (const el of panel.lettering) {
      if (typeof el.id === 'string' && ID_RE.test(el.id) && !used.has(el.id)) used.add(el.id);
      else fresh.push(el);
    }
  }
  let next = 1;
  for (const el of fresh) {
    while (used.has(`L${String(next).padStart(2, '0')}`)) next += 1;
    if (next > 99) {
      problems.push({ panel: null, element: null, code: 'too_many', detail: 'a page holds at most 99 lettering elements (L01 to L99)' });
      break;
    }
    el.id = `L${String(next).padStart(2, '0')}`;
    used.add(el.id);
  }
  let order = 0;
  for (const panel of ordered) {
    if (!Array.isArray(panel.cast)) panel.cast = [];
    for (const el of panel.lettering) {
      order += 1;
      el.order = order;
      el.text = String(el.text === undefined || el.text === null ? '' : el.text).replace(/[ \t]+/g, ' ').trim();
      if (!KINDS.includes(el.type)) {
        problems.push({ panel: panel.id, element: el.id, code: 'bad_type', detail: `${el.id}: "${el.type}" is not a kind of lettering (${KINDS.join(', ')})` });
        continue;
      }
      if (!el.text) problems.push({ panel: panel.id, element: el.id, code: 'empty', detail: `${el.id}: the text is empty` });
      if (!SPOKEN.includes(el.type)) {
        el.speaker = null;
        continue;
      }
      if (!el.speaker || !CHAR_RE.test(String(el.speaker))) {
        problems.push({ panel: panel.id, element: el.id, code: 'no_speaker', detail: `${el.id}: a ${el.type} needs a speaker` });
        continue;
      }
      if (panel.cast.some((r) => r && r.character === el.speaker)) continue;
      const row = offPanelRow(page, panel, el.speaker);
      if (!row) {
        problems.push({ panel: panel.id, element: el.id, code: 'speaker_unknown', detail: `${el.id}: ${el.speaker} is in no panel of this page, so there is no ledger row to place them off panel` });
        continue;
      }
      panel.cast.push(row);
      added.push({ panel: panel.id, character: el.speaker });
    }
    // Element keys in the schema's order, so the file reads the same as one the planner wrote.
    panel.lettering = panel.lettering.map((el) => {
      const out = { id: el.id, type: el.type };
      if (SPOKEN.includes(el.type) || el.speaker !== undefined) out.speaker = el.speaker === undefined ? null : el.speaker;
      out.text = el.text;
      out.order = el.order;
      return out;
    });
  }
  return { added, problems };
}

/** Where the budgets are passed: [{ panel, number, code, element, words, count, limit }]. */
function warnings(page, limits) {
  const out = [];
  panelsInOrder(page).forEach((panel, index) => {
    const list = Array.isArray(panel.lettering) ? panel.lettering.filter(Boolean) : [];
    let total = 0;
    for (const el of list) {
      const words = wordCount(el.text);
      total += words;
      if (el.type !== 'sfx' && words > limits.words_per_balloon) {
        out.push({ panel: panel.id, number: index + 1, code: 'balloon_words', element: el.id, words, limit: limits.words_per_balloon });
      }
    }
    if (total > limits.words_per_panel) out.push({ panel: panel.id, number: index + 1, code: 'panel_words', element: null, words: total, limit: limits.words_per_panel });
    const counted = list.filter((el) => el.type !== 'sfx').length;
    if (counted > limits.per_panel) out.push({ panel: panel.id, number: index + 1, code: 'panel_count', element: null, count: counted, limit: limits.per_panel });
  });
  return out;
}

/**
 * Check a list of panels with their new lettering, as the chat sends it:
 * [{ panel: 'PN_001_002_03', lettering: [{ id?, type, speaker?, text }] }].
 */
function checkPanels(list, page) {
  if (!Array.isArray(list) || !list.length || list.length > 30) {
    throw new HttpError(400, 'bad_params', '"panels" must be a list of { panel, lettering } for 1 to 30 panels.');
  }
  const ids = new Set((Array.isArray(page.panels) ? page.panels : []).map((p) => p && p.id));
  const seen = new Set();
  return list.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.panel !== 'string') throw new HttpError(400, 'bad_params', 'Each entry of "panels" needs "panel": a panel ID of the page.');
    if (!ids.has(entry.panel)) throw new HttpError(400, 'bad_params', `"${entry.panel}" is not a panel of ${page.id}.`);
    if (seen.has(entry.panel)) throw new HttpError(400, 'bad_params', `"${entry.panel}" is listed twice.`);
    seen.add(entry.panel);
    if (!Array.isArray(entry.lettering) || entry.lettering.length > 12) {
      throw new HttpError(400, 'bad_params', `"lettering" of ${entry.panel} must be the whole new list of the panel (at most 12 elements; [] removes them all).`);
    }
    return {
      panel: entry.panel,
      lettering: entry.lettering.map((el) => {
        if (!el || typeof el !== 'object') throw new HttpError(400, 'bad_params', 'A lettering element must be an object { type, speaker, text }.');
        if (!KINDS.includes(el.type)) throw new HttpError(400, 'bad_params', `"${el.type}" is not a kind of lettering. Kinds: ${KINDS.join(', ')}.`);
        if (typeof el.text !== 'string' || !el.text.trim() || el.text.length > MAX_TEXT) throw new HttpError(400, 'bad_params', `Each element needs "text" of 1 to ${MAX_TEXT} characters.`);
        if (SPOKEN.includes(el.type) && !(typeof el.speaker === 'string' && CHAR_RE.test(el.speaker))) {
          throw new HttpError(400, 'bad_params', `A ${el.type} needs "speaker": the character ID of who says it.`);
        }
        const out = { type: el.type, speaker: SPOKEN.includes(el.type) ? el.speaker : null, text: el.text };
        if (typeof el.id === 'string' && ID_RE.test(el.id)) out.id = el.id;
        return out;
      }),
    };
  });
}

/** The page with the lettering of the listed panels replaced (a copy). */
function applyPanels(page, list) {
  const out = JSON.parse(JSON.stringify(page));
  for (const entry of list) {
    const panel = out.panels.find((p) => p && p.id === entry.panel);
    panel.lettering = entry.lettering.map((el) => Object.assign({}, el));
  }
  return out;
}

function letteringOf(page) {
  const out = new Map();
  panelsInOrder(page).forEach((panel, index) => {
    for (const el of Array.isArray(panel.lettering) ? panel.lettering : []) {
      if (el && el.id) out.set(el.id, { panel: panel.id, number: index + 1, type: el.type, speaker: el.speaker || null, text: el.text, order: el.order });
    }
  });
  return out;
}

/**
 * What changed in the lettering, element by element:
 * [{ change: 'added'|'removed'|'changed'|'moved', id, panel, number, type, speaker, text, before? }].
 */
function changesOf(before, after) {
  const a = letteringOf(before);
  const b = letteringOf(after);
  // Reading position among the elements both versions have: an element only
  // pushed along by one added or removed before it has not moved.
  const kept = (map, other) => [...map.entries()].filter(([id]) => other.has(id))
    .sort((x, y) => (x[1].order || 0) - (y[1].order || 0)).map(([id]) => id);
  const rankA = kept(a, b);
  const rankB = kept(b, a);
  const out = [];
  for (const [id, el] of b) {
    const old = a.get(id);
    if (!old) out.push(Object.assign({ change: 'added', id }, el));
    else if (old.type !== el.type || old.speaker !== el.speaker || old.text !== el.text || old.panel !== el.panel) {
      out.push(Object.assign({ change: 'changed', id, before: old }, el));
    } else if (rankA.indexOf(id) !== rankB.indexOf(id)) out.push(Object.assign({ change: 'moved', id }, el));
  }
  for (const [id, el] of a) if (!b.has(id)) out.push(Object.assign({ change: 'removed', id }, el));
  return out.sort((x, y) => (x.number - y.number) || ((x.order || 0) - (y.order || 0)));
}

/** A plain line per change, for a chat card (English; the card shows the person's own words). */
function changeLines(changes, names) {
  const who = (id) => (id ? (names.get(id) || id) : null);
  return changes.map((c) => {
    const voice = who(c.speaker);
    const what = `${c.type}${voice ? ` (${voice})` : ''}`;
    return { change: c.change, panel: c.number, kind: c.type, speaker: voice, text: c.text, before: c.before ? c.before.text : null, line: `${what}: ${c.text}` };
  });
}

/** Character names of a project, read once per call. */
function namesOf(root, page) {
  const names = new Map();
  for (const panel of Array.isArray(page.panels) ? page.panels : []) {
    for (const row of panel && Array.isArray(panel.cast) ? panel.cast : []) {
      if (!row || !row.character || names.has(row.character)) continue;
      let doc = null;
      try {
        doc = S.ws.loadYaml(path.join(root, 'characters', row.character, 'character.yaml'));
      } catch (err) {
        doc = null;
      }
      names.set(row.character, (doc && doc.name) || row.character);
    }
  }
  return names;
}

/**
 * Save a page plan whose lettering may have changed, from the plan review or
 * the chat. Normalizes the lettering, refuses a lettering that cannot be
 * right (a kind that does not exist, an empty text, a speaker with no row on
 * the page), writes page.yaml as one step of the history, runs the
 * continuity check for the page, and says what a drawn page needs now.
 * @returns {{saved, file, findings, continuity, lettering: {warnings, changes, added_cast, limits}, redraw, commit}}
 */
async function savePlan(services, project, pageId, data, { base_etag: baseEtag, by = 'plan' } = {}) {
  const root = project.root;
  if (!S.ws.ID.page.test(String(pageId))) throw new HttpError(404, 'page_not_found', `${pageId} is not a page ID.`);
  const file = path.join(S.ws.pageDir(root, pageId), 'page.yaml');
  if (!fs.existsSync(file)) throw new HttpError(404, 'page_not_found', `${pageId} does not exist in this project.`);
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.panels)) {
    throw new HttpError(400, 'bad_params', '"data" must be the page plan, with its panels.');
  }
  if (baseEtag !== undefined && baseEtag !== null) {
    const current = files.etagOf(fs.statSync(file));
    if (current !== baseEtag) throw new HttpError(409, 'file_changed', 'The file changed since it was opened. Reload it and apply the change again.', { etag: current });
  }
  if (data.id !== undefined && data.id !== pageId) throw new HttpError(400, 'bad_params', `The plan is for ${data.id}, not ${pageId}.`);
  const before = S.ws.loadYaml(file) || {};
  const page = JSON.parse(JSON.stringify(data));
  const { added, problems } = normalize(page);
  if (problems.length) {
    throw new HttpError(422, 'lettering_invalid', problems.map((p) => p.detail).join('; '), { problems });
  }
  const rel = S.ws.rel(root, file);
  const original = fs.readFileSync(file, 'utf8');
  const header = S.yamlEdit ? S.yamlEdit.leadingComments(original) : '';
  const text = header + S.yaml.stringify(page);
  const checked = files.checkText(rel, text);
  const projectDoc = S.ws.loadProject(root) || {};
  const changes = changesOf(before, page);
  const saved = await history.record(services, project, {
    kind: 'save',
    title: changes.length && by === 'chat' ? msg('activity.lettering_edited', { page: pageId }) : msg('activity.edited', { path: rel }),
    scope: [rel],
  }, () => {
    fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
  });
  let continuity = [];
  try {
    continuity = S.checkContinuity(root, { issue: S.ws.issueOfPage(pageId) }).findings.filter((f) => f.page === pageId);
  } catch (err) {
    continuity = [];
  }
  const overlay = projectDoc.lettering && projectDoc.lettering.mode === 'overlay';
  const drawn = page.current_render || S.ws.listRenders(root, pageId).slice(-1)[0] || null;
  const textChanged = changes.length > 0;
  return {
    saved: saved.changes.length > 0,
    file: files.readDoc(project, rel),
    findings: checked.findings,
    continuity,
    lettering: { warnings: warnings(page, limitsOf(projectDoc)), changes, added_cast: added, limits: limitsOf(projectDoc) },
    // A drawn page shows the old words until it is drawn again (in_image) or lettered again (overlay).
    redraw: textChanged && drawn ? { render: drawn, mode: overlay ? 'reletter' : 'draw' } : null,
    commit: saved.commit,
  };
}

module.exports = {
  KINDS, SPOKEN, RULE_DEFAULTS,
  limitsOf, wordCount, normalize, warnings, checkPanels, applyPanels, changesOf, changeLines, namesOf, savePlan,
};
