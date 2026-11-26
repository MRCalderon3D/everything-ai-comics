#!/usr/bin/env node
'use strict';
/**
 * check-continuity.js — audit the panel ledger of a workspace.
 *
 * Walks every issue (or one, with --issue), pages in reading order, panels by
 * `order`, and enforces the eleven ledger rules of docs/data-model.md
 * ("Ledger rules"). The tracker remembers, per character, the last appearance
 * (page, panel, scene, position, wardrobe, state tags) and, per prop, the last
 * holder or placed position. Off-panel cast rows count as appearances: being
 * outside the frame does not reset anyone's state.
 *
 * Finding codes (one per rule):
 *    1 DUPLICATE_CAST     a character twice in one panel's cast
 *    2 DOUBLE_CUSTODY     a prop in two hands, or held and also placed
 *    3 CUSTODY_JUMP       a prop changes holder with no transfers entry
 *    4 POSITION_JUMP      a level change inside a scene with no moved/ellipsis
 *    5 STATE_DROPPED      a state tag vanishes without state_changes.resolves
 *    6 WARDROBE_JUMP      a wardrobe change inside a scene with no reason
 *    7 HANDS_OVERLOAD     more than two hands in use
 *    8 SPEAKER_ABSENT     a speaker with no cast row in the panel
 *    9 LAYOUT_MISMATCH    reading_order / tiers / duplicate lettering order
 *   10 PAGE_CHAIN         enters_from / exits_to do not form one chain
 *   11 UNKNOWN_REFERENCE  character, prop, location, wardrobe, level or
 *                         landmark that the workspace does not define
 *      UNREADABLE_FILE    a page.yaml or state file that cannot be read
 *
 * Rules 1-10 are errors. Rule 11 is an error, except for levels and landmarks
 * of a location that has no map.yaml, which is a warning.
 *
 * This audits the written plan. It says nothing about the drawn pages.
 */

const fs = require('fs');
const path = require('path');
const ws = require('./lib/workspace');
const { readYaml } = require('./lib/artifacts');
const { parseArgs, helpIfRequested, fatal } = require('./lib/cli');
const { PASS, FAIL } = require('./lib/report');

const HELP = `
check-continuity.js — audit the panel ledger of a workspace.

Usage:
  node scripts/check-continuity.js --root <workspace> [--issue ISS_001] [--json]

Options:
  --root <dir>     Workspace root (the directory holding project.yaml).
                   Default: the nearest workspace above the current directory.
  --issue <id>     Audit one issue only.
  --json           Print the findings array as JSON.
  --help           Show this help.

Exit code 1 when any finding is an error, 0 otherwise.
`;

const CODES = {
  DUPLICATE_CAST: 'DUPLICATE_CAST',
  DOUBLE_CUSTODY: 'DOUBLE_CUSTODY',
  CUSTODY_JUMP: 'CUSTODY_JUMP',
  POSITION_JUMP: 'POSITION_JUMP',
  STATE_DROPPED: 'STATE_DROPPED',
  WARDROBE_JUMP: 'WARDROBE_JUMP',
  HANDS_OVERLOAD: 'HANDS_OVERLOAD',
  SPEAKER_ABSENT: 'SPEAKER_ABSENT',
  LAYOUT_MISMATCH: 'LAYOUT_MISMATCH',
  PAGE_CHAIN: 'PAGE_CHAIN',
  UNKNOWN_REFERENCE: 'UNKNOWN_REFERENCE',
  UNREADABLE_FILE: 'UNREADABLE_FILE',
};

/** One-line fix hint per code, printed under each finding. */
const HINTS = {
  DUPLICATE_CAST: 'Keep one cast row per character in the panel and delete the extra row.',
  DOUBLE_CUSTODY: 'Give the prop one place: in a single character\'s holding list, or one row under props.',
  CUSTODY_JUMP: 'Add a transfers entry (handoff, pickup, drop, set_down, ...) in the panel where the prop changes hands, or correct the holder.',
  POSITION_JUMP: 'Set moved on the row with how they got there, set ellipsis on the panel, or add a panel that shows the move.',
  STATE_DROPPED: 'Keep the tag in state, or list it in state_changes.resolves in the panel where it ends.',
  WARDROBE_JUMP: 'Set wardrobe_change with the reason, or restore the previous wardrobe.',
  HANDS_OVERLOAD: 'Free a hand first: transfer a prop away or end the carry in an earlier panel.',
  SPEAKER_ABSENT: 'Add a cast row for the speaker (off_panel: true when not drawn) or fix the speaker id.',
  LAYOUT_MISMATCH: 'Make reading_order list every panel order once, tiers sum to the panel count, and lettering order values unique.',
  PAGE_CHAIN: 'Point enters_from at the previous page and exits_to at the next one; null only at the two ends of the issue.',
  UNKNOWN_REFERENCE: 'Create the missing bible entry, or correct the id to one the workspace defines.',
  UNREADABLE_FILE: 'Fix the YAML so the file parses, or restore the missing file.',
};

// --- small helpers -----------------------------------------------------------

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function hasText(v) {
  return typeof v === 'string' ? v.trim().length > 0 : (v !== null && v !== undefined && v !== false);
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (err) {
    return false;
  }
}

function tagList(v) {
  return arr(v).filter((t) => typeof t === 'string' && t.length > 0);
}

function show(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.join(', ')}]`;
  return String(v);
}

function quoteShort(text) {
  const s = String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim();
  return `"${s.length > 40 ? `${s.slice(0, 37)}...` : s}"`;
}

// --- workspace lookups (cached, never throw) ---------------------------------

function createLookups(root) {
  const cache = new Map();
  const memo = (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  };
  return {
    hasCharacter: (id) => memo(`c:${id}`, () => isFile(path.join(root, 'characters', String(id), 'character.yaml'))),
    hasProp: (id) => memo(`p:${id}`, () => isFile(path.join(root, 'props', String(id), 'prop.yaml'))),
    hasLocation: (id) => memo(`l:${id}`, () => isFile(path.join(root, 'locations', String(id), 'location.yaml'))),
    /** Set of outfit ids of a character, or null when wardrobe.yaml is absent or unreadable. */
    wardrobes: (charId) => memo(`w:${charId}`, () => {
      const { doc } = readYaml(path.join(root, 'characters', String(charId), 'wardrobe.yaml'));
      if (!isObj(doc)) return null;
      return new Set(arr(doc.outfits).filter(isObj).map((o) => o.id).filter(Boolean));
    }),
    /** { levels: Set, landmarks: Set } of a location, or null when it has no readable map.yaml. */
    locationMap: (locId) => memo(`m:${locId}`, () => {
      const { doc } = readYaml(path.join(root, 'locations', String(locId), 'map.yaml'));
      if (!isObj(doc)) return null;
      return {
        levels: new Set(arr(doc.levels).filter(isObj).map((l) => l.id).filter(Boolean)),
        landmarks: new Set(arr(doc.landmarks).filter(isObj).map((l) => l.id).filter(Boolean)),
      };
    }),
    /** Hands a prop occupies: prop.hands_required, default 1. */
    handsRequired: (propId) => memo(`h:${propId}`, () => {
      const { doc } = readYaml(path.join(root, 'props', String(propId), 'prop.yaml'));
      return isObj(doc) && doc.hands_required === 2 ? 2 : 1;
    }),
  };
}

/** Pages of an issue in reading order, without throwing on a bad page.yaml. */
function loadPages(root, issueId) {
  let ids = [];
  try {
    ids = ws.listPageIds(root, issueId);
  } catch (err) {
    ids = [];
  }
  const pages = ids.map((id) => {
    const file = path.join(ws.pageDir(root, id), 'page.yaml');
    const res = readYaml(file);
    return { id, file, doc: isObj(res.doc) ? res.doc : null, error: res.error, missing: res.missing };
  });
  return pages.sort((a, b) => {
    const na = a.doc && typeof a.doc.number === 'number' ? a.doc.number : Infinity;
    const nb = b.doc && typeof b.doc.number === 'number' ? b.doc.number : Infinity;
    if (na !== nb) return na - nb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// --- seeding from the previous issue's end state -----------------------------

function resolveStateFile(root, issueId, opensFrom) {
  const value = String(opensFrom);
  const candidates = [];
  if (ws.ID.issue.test(value)) candidates.push(path.join(root, 'continuity', `${value}.final-state.yaml`));
  candidates.push(ws.abs(root, value));
  candidates.push(path.resolve(ws.issueDir(root, issueId), value));
  return candidates.find(isFile) || null;
}

function seedTracker(root, issueId, opensFrom, tracker, add) {
  const file = resolveStateFile(root, issueId, opensFrom);
  if (!file) {
    add(CODES.UNKNOWN_REFERENCE, 'error', null, null, String(opensFrom),
      `${issueId} opens_from is ${quoteShort(opensFrom)}; expected a continuity state file ` +
      '(continuity/<ISS_ID>.final-state.yaml) and the workspace has none at that path.');
    return;
  }
  const relFile = ws.rel(root, file);
  const res = readYaml(file);
  if (!isObj(res.doc)) {
    add(CODES.UNREADABLE_FILE, 'error', null, null, relFile,
      `${issueId} opens from ${relFile}; expected a readable continuity state and got ` +
      `${res.error ? `a parse error (${res.error})` : 'an empty document'}.`);
    return;
  }
  const state = res.doc;
  const where = `the end of ${state.issue || 'the previous issue'} (${relFile})`;
  for (const [charId, st] of Object.entries(isObj(state.characters) ? state.characters : {})) {
    if (!isObj(st)) continue;
    tracker.chars.set(charId, {
      where,
      page: state.after_page || null,
      panel: null,
      scene: null, // an issue boundary is never "the same scene"
      location: st.location || null,
      position: isObj(st.position) ? st.position : null,
      wardrobe: st.wardrobe || null,
      state: tagList(st.state),
    });
    for (const propId of tagList(st.holding)) {
      tracker.props.set(propId, { where, status: charId, pending: [] });
    }
  }
  for (const [propId, st] of Object.entries(isObj(state.props) ? state.props : {})) {
    if (!isObj(st)) continue;
    if (tracker.props.has(propId) && !('custody' in st)) continue;
    tracker.props.set(propId, { where, status: st.custody || null, pending: [] });
  }
}

// --- the audit ---------------------------------------------------------------

function holderText(status) {
  return status === null ? 'placed (in nobody\'s hands)' : `held by ${status}`;
}

function auditPage(page, lookups, tracker, add) {
  const doc = page.doc;
  const pageId = page.id;
  const scene = typeof doc.scene === 'string' ? doc.scene : null;
  const panels = arr(doc.panels).filter(isObj);
  const label = (panel, index) => (typeof panel.id === 'string' && panel.id ? panel.id : `panel #${index + 1}`);

  // Rule 9: layout and lettering order.
  const layout = isObj(doc.layout) ? doc.layout : {};
  const orders = panels.map((p) => p.order);
  const seenOrder = new Map();
  panels.forEach((panel, index) => {
    const key = String(panel.order);
    if (seenOrder.has(key)) {
      add(CODES.LAYOUT_MISMATCH, 'error', pageId, label(panel, index), pageId,
        `${label(panel, index)} and ${seenOrder.get(key)} both have order ${show(panel.order)}; ` +
        `expected a distinct reading position for each of the ${panels.length} panels of ${pageId}.`);
    } else {
      seenOrder.set(key, label(panel, index));
    }
  });
  const sortKey = (list) => list.map(String).sort().join(',');
  if (!Array.isArray(layout.reading_order) || sortKey(layout.reading_order) !== sortKey(orders)) {
    add(CODES.LAYOUT_MISMATCH, 'error', pageId, null, pageId,
      `${pageId} layout.reading_order is ${show(layout.reading_order)}; expected a permutation of ` +
      `the panel order values ${show(orders)}.`);
  }
  const tierSum = arr(layout.tiers).reduce((sum, n) => sum + (typeof n === 'number' ? n : 0), 0);
  if (!Array.isArray(layout.tiers) || tierSum !== panels.length) {
    add(CODES.LAYOUT_MISMATCH, 'error', pageId, null, pageId,
      `${pageId} layout.tiers is ${show(layout.tiers)} (sum ${tierSum}); expected the tiers to sum to ` +
      `the ${panels.length} panel(s) the page lists.`);
  }
  const seenLettering = new Map();
  panels.forEach((panel, index) => {
    for (const el of arr(panel.lettering).filter(isObj)) {
      if (el.order === undefined || el.order === null) continue;
      const key = String(el.order);
      const here = `${el.id || 'an element'} in ${label(panel, index)}`;
      if (seenLettering.has(key)) {
        add(CODES.LAYOUT_MISMATCH, 'error', pageId, label(panel, index), el.id || null,
          `Lettering order ${el.order} is used by ${seenLettering.get(key)} and by ${here}; ` +
          `expected unique order values across ${pageId}.`);
      } else {
        seenLettering.set(key, here);
      }
    }
  });

  // Panels in reading order; rows without a numeric order keep file order at the end.
  const ordered = panels
    .map((panel, index) => ({ panel, index }))
    .sort((a, b) => {
      const oa = typeof a.panel.order === 'number' ? a.panel.order : Infinity;
      const ob = typeof b.panel.order === 'number' ? b.panel.order : Infinity;
      return oa !== ob ? oa - ob : a.index - b.index;
    });

  const unmapped = new Set(); // locations without a map already reported on this page

  for (const { panel, index } of ordered) {
    const panelId = label(panel, index);
    const here = (code, severity, entity, message) => add(code, severity, pageId, panelId, entity, message);

    // Rule 11: location, then its map.
    const loc = typeof panel.location === 'string' ? panel.location : null;
    let locKnown = false;
    let map = null;
    if (loc) {
      if (lookups.hasLocation(loc)) {
        locKnown = true;
        map = lookups.locationMap(loc);
      } else {
        here(CODES.UNKNOWN_REFERENCE, 'error', loc,
          `${panelId} is set in ${loc}; expected locations/${loc}/location.yaml and the workspace has no such location.`);
      }
    }
    const checkPosition = (position, entity) => {
      if (!locKnown || !isObj(position)) return;
      const level = position.level;
      const landmark = position.landmark;
      const hasLevel = level !== null && level !== undefined;
      const hasLandmark = landmark !== null && landmark !== undefined;
      if (!hasLevel && !hasLandmark) return;
      if (!map) {
        if (unmapped.has(loc)) return;
        unmapped.add(loc);
        here(CODES.UNKNOWN_REFERENCE, 'warning', loc,
          `${loc} has no map.yaml, so the levels and landmarks used on ${pageId} (first for ${entity} in ` +
          `${panelId}) cannot be checked; expected locations/${loc}/map.yaml.`);
        return;
      }
      if (hasLevel && !map.levels.has(level)) {
        here(CODES.UNKNOWN_REFERENCE, 'error', entity,
          `${entity} is on level ${quoteShort(level)} in ${panelId}; expected one of the levels of ${loc} ` +
          `(${show([...map.levels])}).`);
      }
      if (hasLandmark && !map.landmarks.has(landmark)) {
        here(CODES.UNKNOWN_REFERENCE, 'error', entity,
          `${entity} is at landmark ${quoteShort(landmark)} in ${panelId}; expected one of the landmarks of ${loc} ` +
          `(${show([...map.landmarks])}).`);
      }
    };

    // Rule 1: one row per character. Later duplicates are reported and ignored.
    const rows = [];
    const castCount = new Map();
    for (const row of arr(panel.cast).filter(isObj)) {
      const id = row.character;
      if (typeof id !== 'string' || !id) continue;
      castCount.set(id, (castCount.get(id) || 0) + 1);
      if (castCount.get(id) === 1) rows.push(row);
    }
    for (const [id, count] of castCount) {
      if (count > 1) {
        here(CODES.DUPLICATE_CAST, 'error', id,
          `${id} has ${count} cast rows in ${panelId}; expected one row per character per panel.`);
      }
    }

    const holders = new Map(); // prop -> [character, ...]
    for (const row of rows) {
      const id = row.character;
      const known = lookups.hasCharacter(id);
      if (!known) {
        here(CODES.UNKNOWN_REFERENCE, 'error', id,
          `${panelId} lists ${id} in its cast; expected characters/${id}/character.yaml and the workspace has no such character.`);
      }
      if (known && typeof row.wardrobe === 'string' && row.wardrobe) {
        const outfits = lookups.wardrobes(id);
        if (!outfits || !outfits.has(row.wardrobe)) {
          here(CODES.UNKNOWN_REFERENCE, 'error', row.wardrobe,
            `${id} wears ${row.wardrobe} in ${panelId}; expected an outfit of characters/${id}/wardrobe.yaml ` +
            `(${outfits ? show([...outfits]) : 'the file is missing'}).`);
        }
      }
      checkPosition(row.position, id);

      // Rule 7: hands.
      const holding = [...new Set(tagList(row.holding))];
      const carrying = typeof row.carrying === 'string' && row.carrying ? row.carrying : null;
      let hands = 0;
      const load = [];
      if (carrying) {
        hands += 2;
        load.push(`carrying ${carrying} (2)`);
        if (!lookups.hasCharacter(carrying)) {
          here(CODES.UNKNOWN_REFERENCE, 'error', carrying,
            `${id} carries ${carrying} in ${panelId}; expected characters/${carrying}/character.yaml and the workspace has no such character.`);
        }
      }
      for (const propId of holding) {
        if (!holders.has(propId)) holders.set(propId, []);
        holders.get(propId).push(id);
        if (!lookups.hasProp(propId)) {
          here(CODES.UNKNOWN_REFERENCE, 'error', propId,
            `${id} holds ${propId} in ${panelId}; expected props/${propId}/prop.yaml and the workspace has no such prop.`);
        }
        const need = lookups.handsRequired(propId);
        hands += need;
        load.push(`${propId} (${need})`);
      }
      if (hands > 2) {
        here(CODES.HANDS_OVERLOAD, 'error', id,
          `${id} needs ${hands} hands in ${panelId}: ${load.join(' + ')}; expected at most 2.`);
      }

      // Rules 4, 5, 6 against the previous appearance.
      const prev = tracker.chars.get(id);
      const stateNow = tagList(row.state);
      if (prev) {
        const sameScene = !!scene && prev.scene === scene;
        const prevLevel = prev.position ? prev.position.level : null;
        const level = isObj(row.position) ? row.position.level : null;
        if (sameScene && prevLevel && level && prevLevel !== level &&
            !hasText(row.moved) && !hasText(panel.ellipsis)) {
          here(CODES.POSITION_JUMP, 'error', id,
            `${id} was on level ${quoteShort(prevLevel)} in ${prev.where} and is on ${quoteShort(level)} in ${panelId} ` +
            `(same scene ${scene}); expected the row to set moved or the panel to set ellipsis, and both are empty.`);
        }
        const resolved = new Set(tagList(isObj(row.state_changes) ? row.state_changes.resolves : null));
        const dropped = prev.state.filter((tag) => !stateNow.includes(tag) && !resolved.has(tag));
        if (dropped.length) {
          here(CODES.STATE_DROPPED, 'error', id,
            `${id} had state ${show(prev.state)} in ${prev.where} and ${panelId} lists ${show(stateNow)}; ` +
            `expected ${show(dropped)} to stay in state or appear in state_changes.resolves.`);
        }
        if (sameScene && prev.wardrobe && row.wardrobe && prev.wardrobe !== row.wardrobe &&
            !hasText(row.wardrobe_change)) {
          here(CODES.WARDROBE_JUMP, 'error', id,
            `${id} wore ${prev.wardrobe} in ${prev.where} and wears ${row.wardrobe} in ${panelId} ` +
            `(same scene ${scene}); expected wardrobe_change to give the reason, and it is empty.`);
        }
      }
      tracker.chars.set(id, {
        where: panelId,
        page: pageId,
        panel: panelId,
        scene,
        location: loc,
        position: isObj(row.position) ? row.position : null,
        wardrobe: row.wardrobe || null,
        state: stateNow,
      });
    }

    // Rule 2: one place per prop.
    const placed = new Map(); // prop -> rows under props
    for (const row of arr(panel.props).filter(isObj)) {
      const propId = row.prop;
      if (typeof propId !== 'string' || !propId) continue;
      placed.set(propId, (placed.get(propId) || 0) + 1);
      if (placed.get(propId) > 1) continue;
      if (!lookups.hasProp(propId)) {
        here(CODES.UNKNOWN_REFERENCE, 'error', propId,
          `${panelId} lists ${propId} under props; expected props/${propId}/prop.yaml and the workspace has no such prop.`);
      }
      checkPosition(row.position, propId);
    }
    const conflicted = new Set();
    for (const [propId, who] of holders) {
      if (who.length > 1) {
        conflicted.add(propId);
        here(CODES.DOUBLE_CUSTODY, 'error', propId,
          `${propId} is in the holding list of ${who.join(' and ')} in ${panelId}; expected one holder per panel.`);
      }
      if (placed.has(propId)) {
        conflicted.add(propId);
        here(CODES.DOUBLE_CUSTODY, 'error', propId,
          `${propId} is held by ${who[0]} and also listed under props in ${panelId}; expected it in one place only.`);
      }
    }
    for (const [propId, count] of placed) {
      if (count > 1) {
        conflicted.add(propId);
        here(CODES.DOUBLE_CUSTODY, 'error', propId,
          `${propId} has ${count} rows under props in ${panelId}; expected one row for one object.`);
      }
    }

    // Rule 3: custody changes need a transfers entry.
    const transfers = new Map(); // prop -> [transfer, ...] declared in this panel
    for (const t of arr(panel.transfers).filter(isObj)) {
      const propId = t.prop;
      if (typeof propId !== 'string' || !propId) continue;
      if (!lookups.hasProp(propId)) {
        here(CODES.UNKNOWN_REFERENCE, 'error', propId,
          `${panelId} transfers ${propId}; expected props/${propId}/prop.yaml and the workspace has no such prop.`);
      }
      for (const end of ['from', 'to']) {
        const who = t[end];
        if (typeof who === 'string' && who && !lookups.hasCharacter(who)) {
          here(CODES.UNKNOWN_REFERENCE, 'error', who,
            `${panelId} transfers ${propId} ${end} ${who}; expected characters/${who}/character.yaml and the workspace has no such character.`);
        }
      }
      if (!transfers.has(propId)) transfers.set(propId, []);
      transfers.get(propId).push({ from: t.from || null, to: t.to || null, how: t.how || null, panel: panelId });
    }

    const appearing = new Map(); // prop -> holder id, or null when placed
    for (const [propId, who] of holders) appearing.set(propId, who[0]);
    for (const propId of placed.keys()) if (!appearing.has(propId)) appearing.set(propId, null);

    for (const [propId, status] of appearing) {
      const prev = tracker.props.get(propId) || null;
      const pending = prev ? prev.pending : [];
      const current = transfers.get(propId) || [];
      const all = pending.concat(current);
      const last = all.length ? all[all.length - 1] : null;
      let keep = [];
      if (prev && prev.where && !conflicted.has(propId)) {
        if (status !== prev.status) {
          if (!last) {
            here(CODES.CUSTODY_JUMP, 'error', propId,
              `${propId} was ${holderText(prev.status)} in ${prev.where} and is ${holderText(status)} in ${panelId}; ` +
              `expected a transfers entry ending with to: ${show(status)} in ${panelId} or a panel in between, and the ledger has none.`);
          } else if (last.to !== status) {
            here(CODES.CUSTODY_JUMP, 'error', propId,
              `${propId} is ${holderText(status)} in ${panelId}; expected that from the transfers, and the last one ` +
              `(${last.how || 'transfer'} in ${last.panel}) sends it to ${show(last.to)}.`);
          } else if (all[0].from && prev.status && all[0].from !== prev.status) {
            here(CODES.CUSTODY_JUMP, 'error', propId,
              `The ${all[0].how || 'transfer'} in ${all[0].panel} takes ${propId} from ${all[0].from}; expected ` +
              `from: ${prev.status}, who holds it in ${prev.where}.`);
          }
        } else if (pending.length && !current.length && last.to !== status) {
          here(CODES.CUSTODY_JUMP, 'error', propId,
            `The ${last.how || 'transfer'} in ${last.panel} sends ${propId} to ${show(last.to)}; expected the ledger ` +
            `to show that, and ${panelId} still has it ${holderText(status)}.`);
        } else if (current.length && last.to !== status) {
          keep = all; // declared here, drawn before it lands: the next appearance must show it
        }
      } else if (!conflicted.has(propId) && current.length && last.to !== status) {
        keep = current;
      }
      tracker.props.set(propId, { where: panelId, status, pending: keep });
    }
    for (const [propId, list] of transfers) {
      if (appearing.has(propId)) continue;
      const prev = tracker.props.get(propId) || { where: null, status: null, pending: [] };
      prev.pending = prev.pending.concat(list);
      tracker.props.set(propId, prev);
    }

    // Rule 8: speakers have a cast row.
    for (const el of arr(panel.lettering).filter(isObj)) {
      const speaker = el.speaker;
      if (typeof speaker !== 'string' || !speaker) continue;
      if (!castCount.has(speaker)) {
        here(CODES.SPEAKER_ABSENT, 'error', speaker,
          `${el.id || 'A lettering element'} (${quoteShort(el.text)}) is spoken by ${speaker}; expected a cast row for ` +
          `${speaker} in ${panelId} and the cast is ${show([...castCount.keys()])}.`);
      }
    }
  }
}

function auditIssue(root, issueId, lookups, findings) {
  const add = (code, severity, page, panel, entity, message) => {
    findings.push({ code, severity, issue: issueId, page, panel, entity, message });
  };
  const tracker = { chars: new Map(), props: new Map() };

  const issueRes = readYaml(path.join(ws.issueDir(root, issueId), 'issue.yaml'));
  const issueDoc = isObj(issueRes.doc) ? issueRes.doc : null;
  if (issueDoc && issueDoc.opens_from) seedTracker(root, issueId, issueDoc.opens_from, tracker, add);

  const pages = loadPages(root, issueId);
  for (const page of pages) {
    if (page.doc) continue;
    const relFile = ws.rel(root, page.file);
    add(CODES.UNREADABLE_FILE, 'error', page.id, null, page.id,
      `${relFile}: expected a readable page file and got ` +
      `${page.missing ? 'no file' : page.error ? `a parse error (${page.error})` : 'an empty document'}.`);
  }

  // Rule 10: one unbroken chain per issue.
  pages.forEach((page, i) => {
    if (!page.doc) return;
    const prevId = i > 0 ? pages[i - 1].id : null;
    const nextId = i < pages.length - 1 ? pages[i + 1].id : null;
    const c = isObj(page.doc.continuity) ? page.doc.continuity : null;
    if (!c) {
      add(CODES.PAGE_CHAIN, 'error', page.id, null, page.id,
        `${page.id} has no continuity block; expected enters_from: ${show(prevId)} and exits_to: ${show(nextId)}.`);
      return;
    }
    const enters = c.enters_from === undefined ? null : c.enters_from;
    const exits = c.exits_to === undefined ? null : c.exits_to;
    if (enters !== prevId) {
      add(CODES.PAGE_CHAIN, 'error', page.id, null, page.id,
        `${page.id} continuity.enters_from is ${show(enters)}; expected ${show(prevId)} ` +
        `(${prevId ? 'the previous page in reading order' : `it is the first page of ${issueId}`}).`);
    }
    if (exits !== nextId) {
      add(CODES.PAGE_CHAIN, 'error', page.id, null, page.id,
        `${page.id} continuity.exits_to is ${show(exits)}; expected ${show(nextId)} ` +
        `(${nextId ? 'the next page in reading order' : `it is the last page of ${issueId}`}).`);
    }
  });

  for (const page of pages) {
    if (page.doc) auditPage(page, lookups, tracker, add);
  }
  return { pages: pages.length, panels: pages.reduce((n, p) => n + (p.doc ? arr(p.doc.panels).length : 0), 0) };
}

/**
 * Audit the panel ledger of a workspace.
 * @param {string} root  workspace root (the directory holding project.yaml)
 * @param {{issue?: string}} [opts]
 * @returns {{findings: Array<{code: string, severity: 'error'|'warning', issue: string, page: string|null, panel: string|null, entity: string|null, message: string}>}}
 */
function checkContinuity(root, opts = {}) {
  const findings = [];
  const wsRoot = path.resolve(String(root || '.'));
  let issues = [];
  try {
    issues = ws.listIssues(wsRoot);
  } catch (err) {
    issues = [];
  }
  if (opts.issue) {
    if (!issues.includes(opts.issue)) {
      findings.push({
        code: CODES.UNKNOWN_REFERENCE,
        severity: 'error',
        issue: String(opts.issue),
        page: null,
        panel: null,
        entity: String(opts.issue),
        message: `Issue ${opts.issue} was requested; expected issues/${opts.issue}/ and the workspace has ${show(issues)}.`,
      });
      return { findings };
    }
    issues = [opts.issue];
  }
  const lookups = createLookups(wsRoot);
  for (const issueId of issues) {
    try {
      auditIssue(wsRoot, issueId, lookups, findings);
    } catch (err) {
      findings.push({
        code: CODES.UNREADABLE_FILE,
        severity: 'error',
        issue: issueId,
        page: null,
        panel: null,
        entity: issueId,
        message: `${issueId} could not be audited; expected readable ledger files and hit: ${err.message}`,
      });
    }
  }
  return { findings };
}

/** The one-line fix hint for a finding. */
function hintFor(finding) {
  if (finding.code === CODES.UNKNOWN_REFERENCE && finding.severity === 'warning') {
    return 'Write the location\'s map.yaml (levels and landmarks) so positions can be checked.';
  }
  return HINTS[finding.code] || 'See docs/data-model.md, "Ledger rules".';
}

/** Human report: findings grouped by issue and page, one fix hint under each. */
function formatFindings(findings) {
  const lines = [];
  const byIssue = new Map();
  for (const f of findings) {
    const issueKey = f.issue || '(workspace)';
    if (!byIssue.has(issueKey)) byIssue.set(issueKey, new Map());
    const byPage = byIssue.get(issueKey);
    const pageKey = f.page || '(issue level)';
    if (!byPage.has(pageKey)) byPage.set(pageKey, []);
    byPage.get(pageKey).push(f);
  }
  for (const [issueKey, byPage] of byIssue) {
    lines.push(issueKey);
    for (const [pageKey, list] of byPage) {
      lines.push(`  ${pageKey}`);
      for (const f of list) {
        const mark = f.severity === 'error' ? FAIL : '!';
        lines.push(`    ${mark} ${f.panel || '(page)'} [${f.code}] ${f.message}`);
        lines.push(`        fix: ${hintFor(f)}`);
      }
    }
  }
  return lines;
}

function main(argv = process.argv.slice(2)) {
  helpIfRequested(argv, HELP);
  const { flags } = parseArgs(argv);
  if (flags.root === true) fatal('--root needs a directory (see --help)');
  if (flags.issue === true) fatal('--issue needs an issue ID such as ISS_001 (see --help)');
  const root = ws.findWorkspaceRoot(flags.root ? path.resolve(String(flags.root)) : process.cwd());
  if (!root) {
    fatal(`no workspace found at ${flags.root || process.cwd()} (a workspace root holds project.yaml)`);
  }
  if (flags.issue && !ws.listIssues(root).includes(String(flags.issue))) {
    fatal(`issue not found: ${flags.issue} (looked in ${path.join(root, 'issues')})`);
  }

  const { findings } = checkContinuity(root, { issue: flags.issue ? String(flags.issue) : undefined });
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity !== 'error');

  if (flags.json) {
    console.log(JSON.stringify(findings, null, 2));
    return errors.length ? 1 : 0;
  }

  const issues = flags.issue ? [String(flags.issue)] : ws.listIssues(root);
  console.log(`check-continuity: ${root.split(path.sep).join('/')}`);
  console.log(`Panel ledger audit of ${issues.length} issue(s): ${issues.join(', ') || 'none'}`);
  console.log('');
  if (!findings.length) {
    console.log(`  ${PASS} the ledger is consistent: no findings`);
  } else {
    for (const line of formatFindings(findings)) console.log(line);
  }
  console.log('');
  console.log(`${errors.length ? FAIL : PASS} ${errors.length} error(s), ${warnings.length} warning(s)`);
  console.log('This audit reads the written ledger. It does not review the drawn pages.');
  return errors.length ? 1 : 0;
}

module.exports = { checkContinuity, formatFindings, hintFor, CODES, HINTS, main };

// exitCode, not exit(): lets a long --json report flush through a pipe.
if (require.main === module) process.exitCode = main();
