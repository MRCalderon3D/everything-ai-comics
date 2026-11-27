'use strict';
/**
 * The identity chain of a character, as the studio shows and enforces it.
 * The rule lives in the scaffold (scripts/build-reference-plan.js,
 * findIdentityChain); this file only reads it for the screens and the
 * operations:
 *
 * - photos and drawings the person uploaded are likeness sources, attached
 *   only to the first turnaround or full character sheet;
 * - the approved drawn turnaround or full sheet is the identity master, and
 *   every other drawing of the character (expressions, wardrobe, pages, the
 *   cover) is drawn from it;
 * - expression and wardrobe sheets wait for an approved master.
 *
 * It also keeps the result of the identity check run after a sheet is drawn
 * from the master (state.json, sheet_checks), so the screen can show it.
 */

const S = require('./scaffold');

const CHECKS_KEPT = 60;

/** One labelled sheet item back as the text the person edits: "label: what" or "label". */
function itemText(item) {
  return item.subject && item.subject !== item.label ? `${item.label}: ${item.subject}` : item.label;
}

/**
 * Where a character stands in the identity chain.
 * @returns {{master: {id: string, kind: string, path: string}|null, identity: string|null,
 *            photos: string[], photos_only: boolean, needs_master: boolean}}
 *   needs_master: expressions and wardrobe sheets cannot be drawn yet.
 */
function identityState(root, charId) {
  const assets = S.ws.loadReferenceAssets(root);
  const character = S.ws.loadCharacter(root, charId) || {};
  const plan = S.referencePlan;
  const chain = plan.findIdentityChain(assets, charId, character);
  return {
    master: chain.master
      ? { id: chain.master.id, kind: plan.identityKindOf(chain.master), path: String(chain.master.path || '') }
      : null,
    identity: chain.identity ? chain.identity.id : null,
    photos: chain.likeness.map((a) => a.id),
    photos_only: !chain.identity && chain.likeness.length > 0,
    needs_master: !chain.master,
  };
}

/**
 * The close-ups and the expressions and poses a full character sheet of
 * this character would show now, as editable text lines, and whether they
 * come from the character file.
 * @returns {{closeups: string[], poses: string[], saved: boolean}}
 */
function sheetPlan(root, charId) {
  const character = S.ws.loadCharacter(root, charId) || {};
  let states = [];
  try {
    states = S.storyStates(root, charId);
  } catch (err) {
    states = [];
  }
  const lists = S.sheetLanguage.modelLists(character, {}, states);
  return {
    closeups: lists.closeups.map(itemText),
    poses: lists.poses.map(itemText),
    saved: !!(character.sheet && typeof character.sheet === 'object'),
  };
}

/** Write the lists the person chose into the character file's `sheet` block. */
function saveSheetPlan(root, charId, { closeups, poses }) {
  const file = S.ws.abs(root, `characters/${charId}/character.yaml`);
  const edit = S.yamlEdit;
  const apply = (doc) => {
    const sheet = doc.sheet && typeof doc.sheet === 'object' ? doc.sheet : {};
    if (closeups) sheet.closeups = closeups.slice();
    if (poses) sheet.poses = poses.slice();
    doc.sheet = sheet;
  };
  if (edit) return edit.rewriteYamlFile(file, apply).changed;
  const fs = require('fs');
  const doc = S.yaml.parse(fs.readFileSync(file, 'utf8')) || {};
  apply(doc);
  fs.writeFileSync(file, S.yaml.stringify(doc));
  return true;
}

/** Record the identity check of a drawn sheet candidate. */
function recordCheck(project, candidateId, check) {
  const all = Object.assign({}, project.state().sheet_checks || {});
  all[candidateId] = check;
  const ids = Object.keys(all);
  for (const id of ids.slice(0, Math.max(0, ids.length - CHECKS_KEPT))) delete all[id];
  project.saveState({ sheet_checks: all });
}

/** The recorded identity check of a candidate, or null. */
function checkOf(project, candidateId) {
  const all = project.state().sheet_checks || {};
  return all[candidateId] || null;
}

module.exports = { identityState, sheetPlan, saveSheetPlan, recordCheck, checkOf, itemText };
