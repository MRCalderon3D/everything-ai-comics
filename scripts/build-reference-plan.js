#!/usr/bin/env node
'use strict';
/**
 * build-reference-plan.js: decide which approved reference images a page
 * conditions on (skills/reference-selection as code). Writes
 * reference-plan.yaml next to page.yaml; the output follows
 * schemas/reference-plan.schema.json.
 *
 * The plan is derived from the page, in this order:
 *   1. The look master: role style, priority critical, required, always first.
 *   2. The identity master of every character drawn on the page (cast rows
 *      that are not off_panel): role identity, critical, required.
 *   3. Wardrobe sheets registered for the outfits worn on the page: required
 *      (high) when the outfit is not the character's default, otherwise
 *      optional (medium), because the identity master shows the default.
 *   4. The previous page's current render, when
 *      continuity.attach_previous_render is true and that render has a
 *      passing review: role spatial_continuity, optional. An unreviewed or
 *      flagged render is left out and the notes say why.
 *   5. The location plate: role spatial_continuity (or composition when the
 *      registry says so), optional.
 *   6. Plot-relevant props that are held or visible: role prop_consistency,
 *      optional.
 *   7. Assets the page lists under references.required / references.optional.
 *
 * One role per asset, each asset once. Only assets whose status is
 * `approved` in references/manifest.yaml can be attached. Required entries
 * that do not fit the provider's referenceImages budget are an error with a
 * concrete way out; optional entries are dropped lowest priority first and
 * listed under `exclude`.
 */

const path = require('path');
const { writeFileEnsuring, toPosix } = require('./lib/fsx');
const { loadImageProvider, listProviders, resolveProviderId } = require('./lib/providers');
const { parseArgs, helpIfRequested } = require('./lib/cli');
const { pipelineError, loadPageContext, dateStamp, assertValid } = require('./lib/page-pipeline');
const { readingSequence } = require('./lib/layout-language');
const ws = require('./lib/workspace');
const yaml = require('./lib/yaml');

const HELP = `
build-reference-plan.js: write the reference plan of a page.

Usage:
  node scripts/build-reference-plan.js --page <page.yaml> [--provider <id>]

Options:
  --page <file>      page.yaml (or its directory). Required.
  --provider <id>    Image provider whose reference budget applies. Default:
                     the page's generation.provider, then the project's
                     default_providers.image.
  --help             Show this help.

Output: reference-plan.yaml next to page.yaml. Exit 1 when a required
reference is missing, unapproved, or does not fit the provider's budget.
`;

const ROLES = ['style', 'identity', 'wardrobe', 'spatial_continuity', 'prop_consistency', 'composition'];
const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const KIND_ROLE = {
  turnaround: 'identity',
  expressions: 'identity',
  wardrobe: 'wardrobe',
  plate: 'spatial_continuity',
  look: 'style',
  prop: 'prop_consistency',
  detail: 'prop_consistency',
};
const PREFIX_ROLE = {
  CHAR: 'identity',
  LOC: 'spatial_continuity',
  PROP: 'prop_consistency',
  LOOK: 'style',
};
const IDENTITY_KIND_RANK = { turnaround: 0, expressions: 1 };

function versionOf(id) {
  const m = /_V(\d{2})$/.exec(String(id || ''));
  return m ? parseInt(m[1], 10) : 0;
}

/** The single role an asset plays when attached. */
function roleOfAsset(asset) {
  if (asset.default_role && ROLES.includes(asset.default_role)) return asset.default_role;
  if (KIND_ROLE[asset.kind]) return KIND_ROLE[asset.kind];
  return PREFIX_ROLE[String(asset.entity || asset.id || '').split('_')[0]] || 'composition';
}

/**
 * Best approved asset of a list: assets the bible lists first, then by
 * kind rank, then masters, then the highest version.
 */
function bestApproved(list, preferIds = [], kindRank = {}) {
  const rank = (a) => {
    const listed = preferIds.indexOf(a.id);
    return [
      listed === -1 ? preferIds.length : listed,
      kindRank[a.kind] === undefined ? 9 : kindRank[a.kind],
      /_MASTER_/.test(a.id) ? 0 : 1,
      -versionOf(a.id),
    ];
  };
  return list
    .filter((a) => a.status === 'approved')
    .sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })[0] || null;
}

/** Assets still waiting for approval (superseded ones are history, not candidates). */
function pending(list) {
  return list.filter((a) => a.status !== 'approved' && a.status !== 'superseded');
}

function entityAssets(assets, entityId) {
  return [...assets.values()].filter((a) => a.entity === entityId);
}

/**
 * The project's look master: the first approved asset of style.look_refs,
 * or, when the project lists none, the best approved look in the registry.
 * @returns {{look: object|null, pool: object[], unregistered: string[]}}
 */
function findLookMaster(project, assets) {
  const listed = project && project.style && Array.isArray(project.style.look_refs) ? project.style.look_refs : [];
  const pool = listed.length
    ? listed.map((id) => assets.get(id)).filter(Boolean)
    : [...assets.values()].filter((a) => a.kind === 'look' || a.default_role === 'style' || /^LOOK_/.test(String(a.entity || '')));
  return {
    look: bestApproved(pool, listed),
    pool,
    unregistered: listed.filter((id) => !assets.has(id)),
  };
}

/**
 * A character's identity master: the best approved turnaround or
 * expression sheet, preferring the ones character.yaml lists.
 * @returns {{identity: object|null, pool: object[]}}
 */
function findIdentityMaster(assets, charId, character) {
  const listed = character && Array.isArray(character.references) ? character.references : [];
  const pool = entityAssets(assets, charId).filter((a) =>
    a.default_role === 'identity' || (!a.default_role && IDENTITY_KIND_RANK[a.kind] !== undefined));
  return { identity: bestApproved(pool, listed, IDENTITY_KIND_RANK), pool };
}

/**
 * What the page draws, in reading order.
 * @returns {{characters: string[], panelsOfCharacter: Map, outfits: Map, locations: string[], panelsOfLocation: Map, props: string[], panelsOfProp: Map, panelIds: string[]}}
 */
function pageDemand(page) {
  const characters = [];
  const panelsOfCharacter = new Map();
  const outfits = new Map(); // "CHAR|WARD" -> { character, wardrobe, panels: Set }
  const locations = [];
  const panelsOfLocation = new Map();
  const props = [];
  const panelsOfProp = new Map();
  const panelIds = [];
  const offPanel = [];
  const note = (list, map, id, panelId) => {
    if (!id) return;
    if (!map.has(id)) {
      map.set(id, new Set());
      list.push(id);
    }
    map.get(id).add(panelId);
  };
  for (const panel of readingSequence(page)) {
    panelIds.push(panel.id);
    note(locations, panelsOfLocation, panel.location, panel.id);
    for (const row of Array.isArray(panel.cast) ? panel.cast : []) {
      if (!row || !row.character) continue;
      if (row.off_panel === true) {
        if (!offPanel.includes(row.character)) offPanel.push(row.character);
        continue;
      }
      note(characters, panelsOfCharacter, row.character, panel.id);
      if (row.wardrobe) {
        const key = `${row.character}|${row.wardrobe}`;
        if (!outfits.has(key)) outfits.set(key, { character: row.character, wardrobe: row.wardrobe, panels: new Set() });
        outfits.get(key).panels.add(panel.id);
      }
      for (const propId of Array.isArray(row.holding) ? row.holding : []) {
        note(props, panelsOfProp, propId, panel.id);
      }
    }
    for (const row of Array.isArray(panel.props) ? panel.props : []) {
      if (row && row.prop && row.visible === true) note(props, panelsOfProp, row.prop, panel.id);
    }
  }
  return {
    characters,
    panelsOfCharacter,
    // Characters that only have off-panel ledger rows on this page.
    offPanelOnly: offPanel.filter((id) => !characters.includes(id)),
    outfits,
    locations,
    panelsOfLocation,
    props,
    panelsOfProp,
    panelIds,
  };
}

/** Providers that can carry `count` images, for the budget error. */
function roomierProviders(count, currentId, providers) {
  return providers
    .filter((p) => p.id !== currentId && p.capabilities &&
      typeof p.capabilities.referenceImages === 'number' && p.capabilities.referenceImages >= count)
    .sort((a, b) => b.capabilities.referenceImages - a.capabilities.referenceImages)
    .map((p) => `${p.id} (${p.capabilities.referenceImages})`);
}

/**
 * Build the reference plan document of a page.
 * @param {string} root workspace root
 * @param {object} page page.yaml document
 * @param {{providerId?: string, capabilities?: object, project?: object, now?: Date, providers?: object[]}} [options]
 * @returns {{doc: object, providerId: string}}
 * @throws an Error with `code` when a required reference is missing,
 *   unapproved, or over budget
 */
function buildReferencePlan(root, page, options = {}) {
  const project = options.project || ws.loadProject(root) || {};
  const providerId = resolveProviderId(options.providerId, page, project);
  const capabilities = options.capabilities || loadImageProvider(providerId).capabilities;
  const capacity = typeof capabilities.referenceImages === 'number' ? capabilities.referenceImages : Infinity;
  const assets = ws.loadReferenceAssets(root);
  const demand = pageDemand(page);
  const perPanel = Boolean(page.generation && page.generation.mode === 'per_panel');

  const notes = [];
  const exclude = [];
  const chosen = new Map(); // asset_id -> candidate, in insertion order

  const leaveOut = (id, why) => {
    if (!exclude.includes(id)) exclude.push(id);
    notes.push(`${id} left out: ${why}.`);
  };
  /** panels: Set of panel IDs the image is needed for, or null for every panel. */
  const add = (candidate) => {
    const existing = chosen.get(candidate.asset_id);
    if (!existing) {
      chosen.set(candidate.asset_id, candidate);
      return;
    }
    if (candidate.required && !existing.required) {
      existing.required = true;
      existing.priority = PRIORITY_RANK[candidate.priority] < PRIORITY_RANK[existing.priority]
        ? candidate.priority : existing.priority;
    }
    // A page-level mention (panels: null) does not widen an image whose
    // panels were derived from the ledger; the derived scope is the precise one.
    if (existing.panels !== null && candidate.panels !== null) {
      for (const id of candidate.panels) existing.panels.add(id);
    }
  };

  // 1. Look master.
  const { look, pool: lookPool, unregistered: unregisteredLook } = findLookMaster(project, assets);
  if (!look) {
    if (lookPool.length) {
      throw pipelineError('look_unapproved',
        `${page.id}: the look master is not approved (${lookPool.map((a) => `${a.id} is ${a.status}`).join(', ')}). ` +
        'Every request attaches an approved look master; approve it in references/manifest.yaml or register a new version.');
    }
    throw pipelineError('look_missing',
      `${page.id}: no look master is registered` +
      (unregisteredLook.length ? ` (project.style.look_refs lists ${unregisteredLook.join(', ')}, which references/manifest.yaml does not register)` : '') +
      '. Create and approve one with /visual-development, then list it under style.look_refs in project.yaml.');
  }
  add({
    asset_id: look.id,
    entity: look.entity || null,
    role: 'style',
    priority: 'critical',
    required: true,
    panels: null,
    reason: 'Fixed drawing style, attached to every request.',
    omission_risk: 'Line, tone, and rendering drift toward the model default.',
  });

  // 2. Identity master per on-panel character.
  for (const charId of demand.characters) {
    const character = ws.loadCharacter(root, charId) || {};
    const { identity, pool } = findIdentityMaster(assets, charId, character);
    if (!identity) {
      if (pool.length) {
        throw pipelineError('identity_unapproved',
          `${page.id}: ${charId} is drawn on this page but has no approved identity master ` +
          `(${pool.map((a) => `${a.id} is ${a.status}`).join(', ')}). ` +
          'Approve the sheet in references/manifest.yaml, or generate and approve a new version, before planning references.');
      }
      throw pipelineError('identity_missing',
        `${page.id}: ${charId} is drawn on this page but references/manifest.yaml registers no identity master for it. ` +
        'Create a character sheet with /visual-development and approve it first.');
    }
    add({
      asset_id: identity.id,
      entity: charId,
      role: 'identity',
      priority: 'critical',
      required: true,
      panels: new Set(demand.panelsOfCharacter.get(charId)),
      reason: `Identity master of ${character.name || charId}, drawn in ${demand.panelsOfCharacter.get(charId).size} panel(s).`,
      omission_risk: `${character.name || charId} is drawn off-model or with another character's face.`,
    });
  }

  // A character who is only off panel here keeps a ledger row but gets no
  // image: an attached sheet is a reason for the model to draw them.
  for (const charId of demand.offPanelOnly) {
    const character = ws.loadCharacter(root, charId) || {};
    const { identity } = findIdentityMaster(assets, charId, character);
    if (identity) leaveOut(identity.id, `${character.name || charId} is off panel on this whole page`);
  }

  // 3. Wardrobe sheets registered for the outfits worn on this page.
  for (const outfit of demand.outfits.values()) {
    const character = ws.loadCharacter(root, outfit.character) || {};
    const wardrobe = ws.loadWardrobe(root, outfit.character);
    const entry = wardrobe && Array.isArray(wardrobe.outfits)
      ? wardrobe.outfits.find((o) => o && o.id === outfit.wardrobe) : null;
    const listed = entry && Array.isArray(entry.references) ? entry.references : [];
    const sheets = listed
      .map((id) => assets.get(id))
      .filter((a) => a && (a.kind === 'wardrobe' || a.default_role === 'wardrobe'));
    if (!sheets.length) continue;
    const sheet = bestApproved(sheets, listed);
    if (!sheet) {
      for (const a of pending(sheets)) leaveOut(a.id, `wardrobe sheet for ${outfit.wardrobe} is ${a.status}, not approved`);
      continue;
    }
    const isDefault = character.default_wardrobe === outfit.wardrobe;
    add({
      asset_id: sheet.id,
      entity: outfit.character,
      role: 'wardrobe',
      // The identity master already shows the default outfit, so its sheet
      // ranks below the previous page and the location plate.
      priority: isDefault ? 'medium' : 'high',
      required: !isDefault,
      panels: new Set(outfit.panels),
      reason: isDefault
        ? `Wardrobe sheet for ${outfit.wardrobe}, the default outfit of ${character.name || outfit.character}.`
        : `Wardrobe sheet for ${outfit.wardrobe}, which differs from the default outfit of ${character.name || outfit.character}.`,
      omission_risk: `${character.name || outfit.character}'s clothing changes between panels.`,
    });
  }

  // 4. Previous page render, only when it has a passing review.
  let previousAttached = false;
  const continuity = page.continuity || {};
  if (continuity.attach_previous_render === true) {
    const prevId = continuity.enters_from;
    const prev = prevId ? ws.loadPage(root, prevId) : null;
    const renderId = prev && prev.current_render;
    if (!prevId) {
      notes.push('continuity.attach_previous_render is true but enters_from is null: there is no previous page to attach.');
    } else if (!prev) {
      notes.push(`Previous page ${prevId} has no page.yaml: nothing to attach.`);
    } else if (!renderId) {
      notes.push(`Previous page ${prevId} has no current render yet: nothing to attach.`);
    } else {
      const review = ws.loadReview(root, renderId);
      if (!ws.renderFile(root, renderId)) {
        leaveOut(renderId, `the render file of previous page ${prevId} is not on disk`);
      } else if (!review) {
        leaveOut(renderId, `previous page ${prevId} has a render but no visual review yet, and an unreviewed page is not a continuity reference`);
      } else if (!ws.reviewPasses(review)) {
        leaveOut(renderId, `the review of previous page ${prevId} has verdict ${review.verdict}, and only pass or fixed renders are continuity references`);
      } else {
        previousAttached = true;
        add({
          asset_id: renderId,
          entity: null,
          role: 'spatial_continuity',
          priority: 'high',
          required: false,
          panels: null,
          reason: `Previous page ${prevId}, reviewed (${review.verdict}), for environment and staging continuity.`,
          omission_risk: 'Setting and staging drift between consecutive pages.',
        });
      }
    }
  }

  // 5. Location plates.
  demand.locations.forEach((locId, index) => {
    const location = ws.loadLocation(root, locId) || {};
    const listed = Array.isArray(location.references) ? location.references : [];
    const pool = entityAssets(assets, locId);
    if (!pool.length) return;
    const plate = bestApproved(pool, listed, { plate: 0 });
    if (!plate) {
      for (const a of pending(pool)) leaveOut(a.id, `location reference for ${locId} is ${a.status}, not approved`);
      return;
    }
    add({
      asset_id: plate.id,
      entity: locId,
      role: plate.default_role === 'composition' ? 'composition' : 'spatial_continuity',
      priority: index === 0 && !previousAttached ? 'high' : 'medium',
      required: false,
      panels: new Set(demand.panelsOfLocation.get(locId)),
      reason: `Location plate of ${location.name || locId}: architecture, landmarks, and light.`,
      omission_risk: `${location.name || locId} changes layout between pages.`,
    });
  });

  // 6. Plot-relevant props that are held or visible.
  for (const propId of demand.props) {
    const prop = ws.loadProp(root, propId);
    if (!prop || prop.plot_relevant !== true) continue;
    const listed = Array.isArray(prop.references) ? prop.references : [];
    const pool = entityAssets(assets, propId);
    const sheet = bestApproved(pool, listed);
    if (!sheet) {
      if (pool.length) {
        for (const a of pending(pool)) leaveOut(a.id, `prop reference for ${propId} is ${a.status}, not approved`);
      } else {
        notes.push(`${propId} is plot-relevant and on this page but has no registered reference: the prompt describes it in words only.`);
      }
      continue;
    }
    add({
      asset_id: sheet.id,
      entity: propId,
      role: 'prop_consistency',
      priority: 'medium',
      required: false,
      panels: new Set(demand.panelsOfProp.get(propId)),
      reason: `${prop.name || propId} is held or visible on this page and must keep its shape.`,
      omission_risk: `${prop.name || propId} changes type or shape between appearances.`,
    });
  }

  // 7. Assets the page names itself.
  const named = page.references || {};
  for (const id of Array.isArray(named.required) ? named.required : []) {
    const asset = assets.get(id);
    if (!asset) {
      throw pipelineError('reference_unregistered',
        `${page.id}: references.required lists ${id}, which references/manifest.yaml does not register.`);
    }
    if (asset.status !== 'approved') {
      throw pipelineError('reference_unapproved',
        `${page.id}: references.required lists ${id}, which is ${asset.status}. Only approved assets can be required; approve it or remove it from the page.`);
    }
    add({
      asset_id: id,
      entity: asset.entity || null,
      role: roleOfAsset(asset),
      priority: 'high',
      required: true,
      panels: null,
      reason: 'Listed under references.required in page.yaml.',
    });
  }
  for (const id of Array.isArray(named.optional) ? named.optional : []) {
    if (chosen.has(id)) continue;
    const asset = assets.get(id);
    if (!asset) {
      notes.push(`references.optional lists ${id}, which references/manifest.yaml does not register.`);
      continue;
    }
    if (asset.status !== 'approved') {
      leaveOut(id, `listed under references.optional but ${asset.status}, not approved`);
      continue;
    }
    add({
      asset_id: id,
      entity: asset.entity || null,
      role: roleOfAsset(asset),
      priority: 'low',
      required: false,
      panels: null,
      reason: 'Listed under references.optional in page.yaml.',
    });
  }

  // Budget.
  const candidates = [...chosen.values()];
  const required = candidates.filter((c) => c.required);
  const optional = candidates
    .filter((c) => !c.required)
    .map((c, index) => ({ c, index }))
    .sort((a, b) => (PRIORITY_RANK[a.c.priority] - PRIORITY_RANK[b.c.priority]) || (a.index - b.index))
    .map((x) => x.c);
  const panelLoad = (panelId) => required.filter((c) => c.panels === null || c.panels.has(panelId)).length;
  const heaviest = demand.panelIds
    .map((id) => ({ id, load: panelLoad(id) }))
    .sort((a, b) => b.load - a.load)[0] || { id: null, load: required.length };
  const load = perPanel ? heaviest.load : required.length;

  if (load > capacity) {
    const providers = options.providers || listProviders('image');
    const roomier = roomierProviders(load, providerId, providers);
    const ways = [];
    if (!perPanel && heaviest.load <= capacity && heaviest.load < required.length) {
      ways.push(`set generation.mode to per_panel in page.yaml so each request carries one panel's cast (the fullest panel needs ${heaviest.load})`);
    }
    ways.push(roomier.length
      ? `use a provider with a larger budget: ${roomier.join(', ')}`
      : 'no listed provider takes that many images, so split the cast across pages or panels');
    throw pipelineError('budget_exceeded',
      `${page.id}: ${perPanel ? `panel ${heaviest.id} needs ${load}` : `the page needs ${load}`} required reference images ` +
      `(${(perPanel ? required.filter((c) => c.panels === null || c.panels.has(heaviest.id)) : required).map((c) => c.asset_id).join(', ')}) ` +
      `but ${providerId} takes ${capacity}. Required references are never dropped: ${ways.join(', or ')}.`);
  }

  const room = capacity === Infinity ? optional.length : Math.max(0, capacity - load);
  const kept = optional.slice(0, room);
  for (const dropped of optional.slice(room)) {
    leaveOut(dropped.asset_id, `${dropped.role} reference of ${dropped.priority} priority does not fit, ${providerId} takes ${capacity} image(s)`);
  }
  if (perPanel) {
    notes.push(`Per-panel mode: each request attaches only the required images of its panel (the fullest panel, ${heaviest.id}, needs ${heaviest.load} of ${capacity}).`);
  }

  const toEntry = (c) => {
    const entry = { asset_id: c.asset_id, entity: c.entity, role: c.role, priority: c.priority, reason: c.reason };
    if (c.omission_risk) entry.omission_risk = c.omission_risk;
    return entry;
  };
  const doc = { page: page.id, provider: providerId };
  if (capacity !== Infinity) doc.budget = capacity;
  doc.required = required.map(toEntry);
  doc.optional = kept.map(toEntry);
  // An asset the page asked for by name is attached, whatever left it out earlier.
  const attached = new Set([...required, ...kept].map((c) => c.asset_id));
  doc.exclude = exclude.filter((id) => !attached.has(id));
  doc.created_at = dateStamp(options.now);
  if (notes.length) doc.notes = notes.join(' ');

  return { doc, providerId };
}

function main() {
  helpIfRequested(process.argv.slice(2), HELP);
  const { flags } = parseArgs();
  if (!flags.page || flags.page === true) {
    console.error('error: --page <page.yaml> is required (see --help)');
    process.exit(1);
  }
  let result;
  let ctx;
  try {
    ctx = loadPageContext(flags.page);
    result = buildReferencePlan(ctx.root, ctx.page, { providerId: flags.provider, project: ctx.project });
    const check = assertValid('reference-plan', result.doc, `reference plan of ${ctx.page.id}`);
    if (check.skipped) console.warn('warning: schemas/reference-plan.schema.json not found, schema validation skipped');
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
  const { doc } = result;
  const outFile = path.join(ctx.pageDir, 'reference-plan.yaml');
  writeFileEnsuring(outFile, yaml.stringify(doc));
  console.log(`reference plan: ${doc.required.length} required + ${doc.optional.length} optional for ${doc.page} via ${doc.provider} (budget ${doc.budget === undefined ? 'unlimited' : doc.budget})`);
  console.log(`  -> ${toPosix(outFile)}`);
  for (const e of doc.required) console.log(`  + ${e.asset_id} [${e.role}/${e.priority}] ${e.reason}`);
  for (const e of doc.optional) console.log(`  ~ ${e.asset_id} [${e.role}/${e.priority}] ${e.reason}`);
  for (const id of doc.exclude) console.log(`  x ${id}`);
  if (doc.notes) console.log(`  notes: ${doc.notes}`);
}

module.exports = {
  buildReferencePlan,
  pageDemand,
  roleOfAsset,
  bestApproved,
  versionOf,
  entityAssets,
  findLookMaster,
  findIdentityMaster,
  roomierProviders,
};

if (require.main === module) main();
