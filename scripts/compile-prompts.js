#!/usr/bin/env node
'use strict';
/**
 * compile-prompts.js: build the provider-ready prompt package of a page
 * (skills/prompt-compilation as code). Writes prompts/<provider>.yaml next
 * to page.yaml; the output follows schemas/prompt-package.schema.json.
 *
 * The prompt is model-facing text composed only from recorded data, so the
 * same inputs always give the same string:
 *   1. the frozen style block, verbatim (style/style-block.txt);
 *   2. a page header: panel count, grid, reading direction, aspect ratio,
 *      color mode and spot colors;
 *   3. a reference legend that names every attached image by position and
 *      states its single role;
 *   4. one block per panel in reading order: size, place in the grid,
 *      framing, the moment, setting, each drawn character with identity,
 *      position, facing, action, acting, wardrobe, physical state and held
 *      props, a line that states how visually adjacent characters differ,
 *      the props in view, and the panel's own notes;
 *   5. lettering: the exact strings (in_image mode) with the page's safe
 *      margin as a placement limit, or an instruction to leave the art free
 *      of text (overlay mode);
 *   6. hard constraints: exact panel count, one of each named character
 *      per panel, no extra text.
 *
 * --repair <review.yaml> compiles a repair instead: the reviewed render is
 * the edit target, the open blocking findings (or, when none is blocking,
 * every open finding) and every open change request from a person become
 * the exact changes, and everything else is locked. It refuses once the review's repair_cycle has reached the
 * project's repair_policy.max_cycles.
 *
 * --asset <ENTITY_ID> --sheet <kind> compiles a reference sheet instead of a
 * page: a character turnaround, expression or wardrobe sheet, a location
 * plate, a prop sheet, a look page, or a detail study. The prompt is the
 * style block, a sheet brief for the kind, the reference legend, the
 * entity's canonical description from its bible, and hard constraints. The
 * approved look master is attached with role style (a LOOK entity with no
 * approved master yet compiles its first look with no image). A character
 * has one identity chain: its first turnaround or full character sheet
 * (kind model) attaches the approved photos or drawings the person supplied
 * as likeness sources; once a drawn turnaround or full sheet is approved it
 * is the identity master, and wardrobe and expression sheets (which refuse
 * without one) and pages and covers attach it, never a photo. --revise
 * edits a version of the full sheet into the next one: the previous image
 * is the edit target, the change list is the only change, and everything
 * else is locked. The package is asset-scoped (page: null) and is written into the
 * entity's refs/prompts/ directory. A wardrobe sheet carries its outfit, a
 * detail study its subject, and a plate at a non-default time of day that
 * state in the file name, the package ID, and the candidate name
 * (scripts/lib/asset-paths.js), so no two sheets share a file.
 *
 * --cover <ISS_ID> compiles the cover of an issue from
 * issues/<ISS_ID>/cover/cover.yaml: one image with no panel grid, in the
 * page aspect ratio. The prompt is the style block, a cover header, the
 * reference legend, the cover's subject, its own lettering strings (title,
 * issue line, tagline, credits) in in_image mode or an instruction to leave
 * the art free of text in overlay mode, and hard constraints. The look
 * master and the identity master of every character on the cover are
 * attached; the location plate and prop sheets follow while the provider's
 * budget allows. The package names the cover ID as its page
 * (PP_CV_001_<PROVIDER>) and is written to cover/prompts/. --repair works
 * as for a page.
 *
 * provider.compile() runs last to enforce the provider's capabilities and
 * pin the model.
 */

const fs = require('fs');
const path = require('path');
const { writeFileEnsuring, toPosix } = require('./lib/fsx');
const { loadImageProvider, listProviders, resolveProviderId } = require('./lib/providers');
const { parseArgs, helpIfRequested } = require('./lib/cli');
const {
  pipelineError, loadPageContext, hashPage, hashPlan, hashText, assertValid,
} = require('./lib/page-pipeline');
const layout = require('./lib/layout-language');
const lang = require('./lib/panel-language');
const sheets = require('./lib/sheet-language');
const assetPaths = require('./lib/asset-paths');
const coverLib = require('./lib/cover');
const { selectRepairFindings } = require('./lib/review-requests');
const ws = require('./lib/workspace');
const yaml = require('./lib/yaml');
const {
  bestApproved, entityAssets, findLookMaster, findIdentityMaster, findIdentityChain, identityKindOf, isLikenessSource,
  identityRefusal, roomierProviders, MASTER_KINDS, ensureReferencePlan,
} = require('./build-reference-plan');
const { attachments, providerTag } = require('../providers/lib/common');

const HELP = `
compile-prompts.js: compile a page or a reference sheet into a prompt package
for an image provider.

Usage:
  node scripts/compile-prompts.js --page <page.yaml> [--provider <id>] [--repair <review.yaml>]
  node scripts/compile-prompts.js --cover <ISS_ID> [--root <workspace>] [--provider <id>] [--repair <review.yaml>]
  node scripts/compile-prompts.js --asset <ENTITY_ID> --sheet <kind> [--root <workspace>] [--provider <id>]

Cover options:
  --cover <ISS_ID>   The issue whose cover to compile, from
                     issues/<ISS_ID>/cover/cover.yaml. One image, the page
                     aspect ratio, the look master and the masters of the
                     characters on the cover attached with one role each,
                     and the cover's own title and issue text.
  --repair <file>    A visual review of one of the cover's renders. Compiles
                     a repair package, under the same limit as a page.
  --root <dir>       Workspace root. Default: the workspace found from the
                     current directory.

Page options:
  --page <file>      page.yaml (or its directory).
  --repair <file>    A visual review of one of this page's renders. Compiles
                     a repair package: edit target, exact changes, locked
                     elements. Refused once the repair limit is reached.
  --panel <PN_ID>    Per-panel mode: compile one panel as its own image
                     (written to prompts/<provider>.<PN_ID>.yaml).

Asset options:
  --asset <ID>       A CHAR_*, LOC_*, PROP_* or LOOK_* entity.
  --sheet <kind>     CHAR: turnaround | model | expressions | wardrobe
                     LOC:  plate        PROP: prop        LOOK: look
                     any entity: detail (needs --subject)
                     model is the full character sheet: name and line,
                     turnaround, labelled close-ups, labelled expressions
                     and poses, landscape.
                     A character's first turnaround or full sheet attaches
                     the approved photos the person supplied as likeness
                     sources. Expressions and wardrobe need an approved
                     turnaround or full sheet and attach it, never a photo.
  --closeups "<label: what>; ..."
                     model only. Default: the character file's
                     sheet.closeups, else its distinguishing features.
  --poses "<label>; ..."
                     model only. Default: the character file's sheet.poses,
                     else four defaults plus the states the pages give.
  --revise <version> model only: edit this version of the full sheet
                     (CHAR_X_MODEL_V02, or its path) into the next one.
  --changes "<change>; <change>"
                     with --revise: what to change. Everything else is locked.
  --likeness <ID,ID> with --revise: approved photos of the character to
                     attach for this round, for likeness only.
  --outfit <WARD_ID> wardrobe only. Default: the character's default_wardrobe.
  --time <state>     plate only: one of the location's time_of_day_states.
                     Default: the first one.
  --expressions <a,b,c>
                     expressions only. Default: neutral, wary, angry, afraid,
                     in pain, relieved.
  --subject "<text>" detail only: what the study shows.
  --root <dir>       Workspace root. Default: the workspace found from the
                     current directory.

Both:
  --provider <id>    Image provider. Default: the page's generation.provider,
                     then the project's default_providers.image.
  --model <id>       Pin a model instead of the provider's default.
  --help             Show this help.

A page needs style/style-block.txt and a reference-plan.yaml next to
page.yaml (run build-reference-plan.js first). A plan built for another
generation.mode, provider, or budget is rebuilt and written over the old one
before compiling. A sheet needs the style block,
the entity's bible file, and an approved look master (except the first look).

Output, status "compiled":
  page    <page dir>/prompts/<provider>.yaml
  cover   issues/<ISS_ID>/cover/prompts/<provider>.yaml (ID PP_CV_###_<PROVIDER>)
  sheet   <refs>/prompts/<provider>.<kind>.yaml, where <refs> is
          characters/<ID>/refs, locations/<ID>/refs, or props/<ID>/refs
            wardrobe   <provider>.wardrobe.<WARD_ID>.yaml
            detail     <provider>.detail.<subject-slug>.yaml
            plate      <provider>.plate.yaml, or <provider>.plate.<state>.yaml
                       for a --time that is not the default
          references/style/prompts/<provider>.<LOOK_ID>.yaml for a look
Package ID: PP_<ENTITY_ID>_<PROVIDER>-<TAG>[-<VARIANT>], TAG one of TURN,
MODEL, EXPR, WARD, PLATE, SHEET (props), LOOK, DETAIL.
`;

const DEFAULT_MAX_REPAIR_CYCLES = 2;
const NEGATIVE_BASE = 'watermark, signature, page number, extra panels, duplicated characters, merged bodies';
const NEGATIVE_NO_TEXT = 'text, lettering, speech balloons, caption boxes, sound effects';

/** Bible lookups with a cache, so each file is read once per compile. */
function createBibles(root) {
  const cache = new Map();
  const memo = (key, load) => {
    if (!cache.has(key)) cache.set(key, load() || null);
    return cache.get(key);
  };
  const bibles = {
    character: (id) => memo(`c:${id}`, () => ws.loadCharacter(root, id)),
    wardrobe: (id) => memo(`w:${id}`, () => ws.loadWardrobe(root, id)),
    location: (id) => memo(`l:${id}`, () => ws.loadLocation(root, id)),
    prop: (id) => memo(`p:${id}`, () => ws.loadProp(root, id)),
    characterName: (id) => {
      const doc = bibles.character(id);
      return (doc && doc.name) || lang.humanize(String(id).replace(/^CHAR_/, '').toLowerCase());
    },
    propName: (id) => {
      const doc = bibles.prop(id);
      return (doc && doc.name) || lang.humanize(String(id).replace(/^PROP_/, '').toLowerCase());
    },
    locationName: (id) => {
      const doc = bibles.location(id);
      return (doc && doc.name) || lang.humanize(String(id).replace(/^LOC_/, '').toLowerCase());
    },
    entityName: (id) => {
      const text = String(id || '');
      if (text.startsWith('CHAR_')) return bibles.characterName(text);
      if (text.startsWith('PROP_')) return bibles.propName(text);
      if (text.startsWith('LOC_')) return bibles.locationName(text);
      return lang.humanize(text.toLowerCase());
    },
  };
  return bibles;
}

function summaryOf(doc) {
  if (!doc) return null;
  if (doc.prompt_summary) return String(doc.prompt_summary).trim();
  if (doc.description && doc.description.summary) return String(doc.description.summary).trim();
  return null;
}

function drawnCast(panel) {
  return (Array.isArray(panel.cast) ? panel.cast : [])
    .filter((row) => row && row.character && row.off_panel !== true);
}

function offPanelCast(panel) {
  return (Array.isArray(panel.cast) ? panel.cast : [])
    .filter((row) => row && row.character && row.off_panel === true);
}

function visibleProps(panel) {
  return (Array.isArray(panel.props) ? panel.props : [])
    .filter((row) => row && row.prop && row.visible === true);
}

function joinNames(names) {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/** Every character that has a ledger row on the page, drawn or not. */
function pageCast(page) {
  const ids = [];
  for (const panel of layout.readingSequence(page)) {
    for (const row of Array.isArray(panel.cast) ? panel.cast : []) {
      if (row && row.character && !ids.includes(row.character)) ids.push(row.character);
    }
  }
  return ids;
}

/**
 * Characters on this page that `charId` could be confused with. Adjacency
 * counts in both directions: A listing B is enough.
 */
function adjacentOnPage(charId, cast, bibles) {
  const own = bibles.character(charId);
  const listed = own && Array.isArray(own.visually_adjacent_to) ? own.visually_adjacent_to : [];
  return cast.filter((other) => {
    if (other === charId) return false;
    if (listed.includes(other)) return true;
    const doc = bibles.character(other);
    return Boolean(doc && Array.isArray(doc.visually_adjacent_to) && doc.visually_adjacent_to.includes(charId));
  });
}

function featuresOf(doc) {
  const list = doc && doc.description && Array.isArray(doc.description.distinguishing_features)
    ? doc.description.distinguishing_features : [];
  return list.map((f) => String(f).trim()).filter(Boolean);
}

/** "Mara is not Oskar. Mara: a, b. Oskar: c, d. Do not swap or blend them." */
function differenceLine(charId, otherId, bibles) {
  const name = bibles.characterName(charId);
  const otherName = bibles.characterName(otherId);
  const mine = featuresOf(bibles.character(charId));
  const theirs = featuresOf(bibles.character(otherId));
  const parts = [`${name} is not ${otherName}.`];
  if (mine.length) parts.push(`${name}: ${mine.join(', ')}.`);
  if (theirs.length) parts.push(`${otherName}: ${theirs.join(', ')}.`);
  parts.push('Do not swap or blend their features.');
  return parts.join(' ');
}

function wardrobeDescription(charId, wardrobeId, bibles) {
  const doc = bibles.wardrobe(charId);
  const outfit = doc && Array.isArray(doc.outfits) ? doc.outfits.find((o) => o && o.id === wardrobeId) : null;
  return outfit && outfit.description ? String(outfit.description).trim() : null;
}

function propPhrase(propId, bibles) {
  const summary = summaryOf(bibles.prop(propId));
  const name = bibles.propName(propId);
  return summary ? `${name} (${summary.replace(/\.$/, '')})` : name;
}

/** The lines that describe one drawn character in one panel. */
function characterLines(row, cast, bibles) {
  const name = bibles.characterName(row.character);
  const bits = [`- ${name}.`];
  const summary = summaryOf(bibles.character(row.character));
  if (summary) bits.push(lang.sentence(summary));
  const position = lang.positionPhrase(row.position);
  if (position) bits.push(`Position: ${position}.`);
  const facing = lang.facingPhrase(row.facing);
  if (facing) bits.push(`Facing: ${facing}.`);
  if (row.action) bits.push(`Action: ${lang.sentence(row.action)}`);
  if (row.acting) bits.push(`Acting: ${lang.sentence(row.acting)}`);
  const wardrobe = row.wardrobe ? wardrobeDescription(row.character, row.wardrobe, bibles) : null;
  if (wardrobe) bits.push(`Wardrobe: ${lang.sentence(wardrobe)}`);
  const state = lang.statePhrase(row.state);
  if (state) bits.push(`Physical state, visible in the drawing: ${state}.`);
  const holding = Array.isArray(row.holding) ? row.holding : [];
  if (holding.length) bits.push(`Holding: ${joinNames(holding.map((id) => propPhrase(id, bibles)))}.`);
  if (row.carrying) bits.push(`Carrying ${bibles.characterName(row.carrying)} with both arms.`);
  const lines = [bits.join(' ')];
  for (const otherId of adjacentOnPage(row.character, cast, bibles)) {
    lines.push(`  ${differenceLine(row.character, otherId, bibles)}`);
  }
  return lines;
}

/**
 * The block of one panel.
 * @param {object} panel
 * @param {{number: number, total: number, slot: object|null, cast: string[], bibles: object, single?: boolean}} ctx
 */
function panelBlock(panel, ctx) {
  const lines = [];
  const size = lang.panelSizePhrase(panel.size);
  if (ctx.single) {
    lines.push(`The panel: ${size}.`);
  } else {
    lines.push(`Panel ${ctx.number} of ${ctx.total}. ${ctx.slot ? `${capitalize(layout.slotPhrase(ctx.slot))}. ` : ''}${capitalize(size)}.`);
  }
  const framing = panel.framing || {};
  const framingText = lang.framingPhrase(framing);
  if (framingText || framing.composition) {
    lines.push(`Framing: ${[framingText ? `${framingText}.` : '', framing.composition ? `Composition: ${lang.sentence(framing.composition)}` : '']
      .filter(Boolean).join(' ')}`);
  }
  if (panel.moment) lines.push(`Moment: ${lang.sentence(panel.moment)}`);
  if (panel.location) {
    const summary = summaryOf(ctx.bibles.location(panel.location));
    lines.push(`Setting: ${ctx.bibles.locationName(panel.location)}.${summary ? ` ${lang.sentence(summary)}` : ''}`);
  }
  if (panel.background) lines.push(`Background: ${lang.sentence(panel.background)}`);
  const panelNotes = typeof panel.notes === 'string' ? panel.notes.trim() : '';
  if (panelNotes) lines.push(`Note: ${lang.sentence(panelNotes)}`);

  const drawn = drawnCast(panel);
  if (drawn.length) {
    const names = drawn.map((row) => ctx.bibles.characterName(row.character));
    lines.push(`Characters drawn in this panel: ${drawn.length} (${joinNames(names)}), each exactly once.`);
    for (const row of drawn) lines.push(...characterLines(row, ctx.cast, ctx.bibles));
  } else {
    lines.push('Characters drawn in this panel: none of the named characters.');
  }
  const absent = offPanelCast(panel).map((row) => ctx.bibles.characterName(row.character));
  if (absent.length) lines.push(`Not drawn in this panel: ${joinNames(absent)}.`);

  const props = visibleProps(panel);
  if (props.length) {
    lines.push('Props in view:');
    for (const row of props) {
      const bits = [`- ${capitalize(propPhrase(row.prop, ctx.bibles))}.`];
      const position = lang.positionPhrase(row.position);
      if (position) bits.push(`Position: ${position}.`);
      const state = lang.statePhrase(row.state);
      if (state) bits.push(`State: ${state}.`);
      lines.push(bits.join(' '));
    }
  }
  return lines.join('\n');
}

function capitalize(text) {
  const t = String(text || '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Lettering elements of the page (or of some panels), sorted by reading order. */
function letteringElements(page, panelIds = null) {
  const sequence = layout.readingSequence(page);
  const out = [];
  sequence.forEach((panel, index) => {
    if (panelIds && !panelIds.includes(panel.id)) return;
    (Array.isArray(panel.lettering) ? panel.lettering : []).forEach((el, position) => {
      if (el && el.text !== undefined && el.text !== null) {
        out.push({ el, panel, panelNumber: index + 1, position });
      }
    });
  });
  return out.sort((a, b) => {
    const oa = typeof a.el.order === 'number' ? a.el.order : Infinity;
    const ob = typeof b.el.order === 'number' ? b.el.order : Infinity;
    return (oa - ob) || (a.panelNumber - b.panelNumber) || (a.position - b.position);
  });
}

/**
 * The page's safe margin as a lettering limit the model can act on: a share
 * of the page width and height (rounded up), from project.page.safe_margin_mm
 * and trim_mm. Without a trim size only the distance is stated. Null when
 * the project sets no safe margin.
 */
function safeMarginLine(project) {
  const page = (project && project.page) || {};
  const margin = Number(page.safe_margin_mm);
  if (!(margin > 0)) return null;
  const trim = page.trim_mm || {};
  const width = Number(trim.width);
  const height = Number(trim.height);
  if (width > 0 && height > 0) {
    const share = (side) => Math.max(1, Math.ceil((margin / side) * 100));
    return `Safe margin: keep every balloon, caption, and sound effect at least ${share(width)}% of the page width away from the left and right edges, and at least ${share(height)}% of the page height away from the top and bottom edges.`;
  }
  return `Safe margin: keep every balloon, caption, and sound effect clear of the page edges, inside a margin of ${margin} mm on the printed page.`;
}

function letteringSection(page, project, mode, bibles, options = {}) {
  const elements = letteringElements(page, options.panelIds || null);
  const where = options.single ? 'the panel' : 'the page';
  if (mode === 'overlay') {
    const lines = [
      'LETTERING',
      `None in the image: lettering is added afterwards as an overlay. Draw no text of any kind: no speech balloons, no caption boxes, no sound effects, no readable signs.`,
    ];
    if (elements.length && !options.single) {
      const panels = [...new Set(elements.map((x) => x.panelNumber))].sort((a, b) => a - b);
      lines.push(`Leave calm, uncluttered space for the overlay in panel${panels.length === 1 ? '' : 's'} ${joinNames(panels.map(String))}, away from faces and hands.`);
    } else if (elements.length) {
      lines.push('Leave calm, uncluttered space for the overlay, away from faces and hands.');
    }
    return lines.join('\n');
  }
  if (!elements.length) {
    return `LETTERING\nThis ${options.single ? 'panel' : 'page'} has no lettering. Draw no text, balloons, or captions.`;
  }
  const lettering = project.lettering || {};
  const lines = [
    'LETTERING',
    `Letter ${where} with exactly these ${elements.length} element${elements.length === 1 ? '' : 's'}, in this reading order. Copy every string character for character, with its accents and punctuation.` +
      (lettering.case === 'upper' ? ' Set the lettering in capitals; the words stay exactly as written.' : ''),
  ];
  elements.forEach((x, i) => {
    const bits = [];
    if (!options.single) bits.push(`Panel ${x.panelNumber}`);
    bits.push(lang.letteringTypePhrase(x.el.type));
    if (x.el.speaker) {
      const name = bibles.characterName(x.el.speaker);
      bits.push(lang.isSpoken(x.el.type) ? `speaker ${name}, tail pointing to ${name}` : `attributed to ${name}`);
    }
    lines.push(`${i + 1}. ${capitalize(bits.join(', '))}: "${String(x.el.text)}"`);
  });
  lines.push('Keep balloons and captions clear of faces, hands, and the main action.');
  const safeMargin = options.single ? null : safeMarginLine(project);
  if (safeMargin) lines.push(safeMargin);
  return lines.join('\n');
}

/**
 * One legend line per attached image, by position, each with its single role.
 * options.likeness: asset IDs attached as likeness sources (a photo or
 * drawing a person supplied) rather than as a drawn identity sheet.
 * options.editTarget: what the edit target is ('sheet' for a character
 * sheet revision; a rendered page otherwise).
 */
function legendSection(images, entityByAsset, bibles, options = {}) {
  if (!images.length) {
    return 'REFERENCE IMAGES\nNo reference images are attached.';
  }
  const likeness = options.likeness || new Set();
  const lines = ['REFERENCE IMAGES', 'Each attached image has one role. Use it for that role only.'];
  for (const att of images) {
    const label = `Image ${att.position}`;
    const entity = entityByAsset.get(att.asset_id) || null;
    const name = entity ? bibles.entityName(entity) : null;
    switch (att.role) {
      case 'edit_target':
        lines.push(options.editTarget === 'sheet'
          ? `${label}: the previous version of this character sheet, to edit. Keep everything in it that CHANGES does not name.`
          : `${label}: the rendered page to edit. Keep everything in it that CHANGES does not name.`);
        break;
      case 'style':
        lines.push(`${label}: drawing style only (line, tone, texture, rendering). Do not copy its characters, composition, or text.`);
        break;
      case 'identity':
        lines.push(likeness.has(att.asset_id)
          ? `${label}: a photo or drawing of the person ${name || 'the character'} is based on, for likeness only. ` +
            'Translate this person into the comic style above: match the face, hair, and build. ' +
            "Do not copy the photo's rendering, light, clothes, or background."
          : `${label}: identity of ${name || 'the character'}. Match the face, hair, build, and proportions exactly. ` +
            "Do not copy the sheet's poses, layout, background, or labels, and letter none of its text.");
        break;
      case 'wardrobe':
        lines.push(`${label}: wardrobe of ${name || 'the character'}. Match the clothing and accessories. Do not take a face or a pose from it.`);
        break;
      case 'spatial_continuity':
        lines.push(entity
          ? `${label}: the location ${name}. Match its architecture, landmarks, and light. Do not copy its framing.`
          : `${label}: the previous page, for the setting and the staging only. Keep the place and where things stand consistent with it. Do not copy its panels, poses, or text.`);
        break;
      case 'composition':
        lines.push(`${label}: composition guide${name ? ` for ${name}` : ''}. Follow its arrangement of space. Do not copy its drawing style or its figures.`);
        break;
      case 'prop_consistency':
        lines.push(`${label}: the prop ${name || 'shown'}. Match its shape and details. Nothing else comes from this image.`);
        break;
      default:
        lines.push(`${label}: reference for ${lang.humanize(att.role)} only.`);
    }
  }
  return lines.join('\n');
}

function orientationOf(ratio) {
  const value = layout.ratioValue(ratio);
  if (!value || value === 1) return 'square format';
  return value < 1 ? 'portrait format' : 'landscape format';
}

function colorLines(project) {
  const spots = Array.isArray(project.spot_colors) ? project.spot_colors.filter((s) => s && s.name) : [];
  const lines = [];
  if (project.color_mode === 'monochrome') {
    lines.push(`Color: monochrome. No color anywhere${spots.length ? ' except the spot colors below' : ''}.`);
  } else if (project.color_mode === 'limited') {
    lines.push(`Color: limited palette${spots.length ? ' built on the spot colors below' : ''}.`);
  } else if (project.color_mode === 'full_color') {
    lines.push('Color: full color.');
  }
  for (const spot of spots) {
    lines.push(`Spot color: ${spot.name}${spot.hex ? ` (${spot.hex})` : ''}.${spot.use ? ` ${lang.sentence(spot.use)}` : ''}`);
  }
  return lines;
}

function pageHeader(page, project, ratio) {
  const direction = project.reading_direction === 'rtl' ? 'rtl' : 'ltr';
  const lines = ['PAGE'];
  lines.push(project.comic_format === 'webtoon'
    ? `One vertical scroll segment of a webtoon, aspect ratio ${ratio}.`
    : `One finished comic page, ${orientationOf(ratio)}, aspect ratio ${ratio}.`);
  if (page.spread_with) {
    lines.push(`This page is ${page.side === 'left' || page.side === 'right' ? `the ${page.side} half` : 'one half'} of a double-page spread.`);
  }
  lines.push(`Layout: ${layout.describeGrid(page)}`);
  lines.push(`Reading direction: ${layout.describeReading(direction)}.`);
  if (layout.hasCustomReadingOrder(page)) {
    lines.push(`The panels below are listed in the order they are read (grid positions ${layout.readingSequence(page).map((p) => p.order).join(', ')}).`);
  }
  lines.push('Every panel is its own bordered frame, separated from the others by gutters.');
  lines.push(...colorLines(project));
  return lines.join('\n');
}

function castCountLine(sequence, bibles) {
  return sequence.map((panel, i) => {
    const names = drawnCast(panel).map((row) => bibles.characterName(row.character));
    return `panel ${i + 1}: ${names.length ? joinNames(names) : 'no named character'}`;
  }).join('; ');
}

/** The generate prompt of a full page. Deterministic. */
function composePagePrompt(input) {
  const { page, project, styleBlock, images, entityByAsset, bibles, letteringMode, ratio } = input;
  const direction = project.reading_direction === 'rtl' ? 'rtl' : 'ltr';
  const sequence = layout.readingSequence(page);
  const slots = layout.panelSlots(page, direction);
  const cast = pageCast(page);
  const total = sequence.length;

  const sections = [styleBlock.trim(), pageHeader(page, project, ratio), legendSection(images, entityByAsset, bibles)];
  sections.push(['PANELS, in reading order']
    .concat(sequence.map((panel, i) => panelBlock(panel, { number: i + 1, total, slot: slots.get(panel.id), cast, bibles })))
    .join('\n\n'));
  sections.push(letteringSection(page, project, letteringMode, bibles));
  sections.push([
    'HARD CONSTRAINTS',
    `- Exactly ${total} panel${total === 1 ? '' : 's'}, arranged as described. No extra panels, insets, or split frames.`,
    `- Each named character appears exactly once in every panel that lists them, and not at all in the others: ${castCountLine(sequence, bibles)}.`,
    '- Every character keeps the same face, hair, build, and wardrobe from panel to panel.',
    letteringMode === 'overlay'
      ? '- No text anywhere in the image.'
      : '- No text other than the lettering listed above.',
    '- No watermark, signature, or page number.',
  ].join('\n'));
  return sections.join('\n\n');
}

/** The generate prompt of one panel drawn as its own image (per_panel mode). */
function composePanelPrompt(input) {
  const { page, project, styleBlock, images, entityByAsset, bibles, letteringMode, ratio, panel } = input;
  const cast = pageCast(page);
  const names = drawnCast(panel).map((row) => bibles.characterName(row.character));
  const sections = [
    styleBlock.trim(),
    ['PANEL IMAGE',
      `One single comic panel drawn as its own image, ${orientationOf(ratio)}, aspect ratio ${ratio}. No panel grid and no inner borders: the whole image is the panel.`]
      .concat(colorLines(project)).join('\n'),
    legendSection(images, entityByAsset, bibles),
    panelBlock(panel, { number: 1, total: 1, slot: null, cast, bibles, single: true }),
    letteringSection(page, project, letteringMode, bibles, { panelIds: [panel.id], single: true }),
    ['HARD CONSTRAINTS',
      '- One panel only. No grid, no insets, no split frame.',
      `- Named characters in the image: ${names.length ? `${joinNames(names)}, each exactly once` : 'none'}.`,
      letteringMode === 'overlay' ? '- No text anywhere in the image.' : '- No text other than the lettering listed above.',
      '- No watermark, signature, or page number.'].join('\n'),
  ];
  return sections.join('\n\n');
}

/** One line for the CLI: where the compiled request goes. */
function endpointText(spec) {
  if (spec.endpoint) return spec.endpoint;
  if (spec.handoff) return '(none: handoff to a person or the harness tool)';
  return `(none: ${spec.provider} runs a local tool)`;
}

/**
 * Select the findings a repair addresses: the open blocking ones, or every
 * open finding when none is blocking, plus every open change request from a
 * person (source: user_request) whatever its severity. The rule lives in
 * lib/review-requests.js, next to the code that records those requests.
 */
function selectFindings(review) {
  return selectRepairFindings(review);
}

/** Repair plan of a review: failing panels, exact changes, locked elements. */
function buildRepair(page, review, findings, letteringMode) {
  const sequence = layout.readingSequence(page);
  const numberOf = (panelId) => sequence.findIndex((p) => p.id === panelId) + 1;
  const pageLevel = findings.some((f) => !f.panel || !numberOf(f.panel));
  const failing = [...new Set(findings.map((f) => numberOf(f.panel)).filter((n) => n > 0))].sort((a, b) => a - b);
  const others = sequence.map((_, i) => i + 1).filter((n) => !failing.includes(n));
  const changes = findings.map((f) => {
    const n = numberOf(f.panel);
    // A finding may mark the area it is about (fractions of the page).
    const where = regionPhrase(f.region);
    const place = n
      ? `Panel ${n}${where ? `, in ${where} of the page` : ''}`
      : (where ? `In ${where} of the page` : 'Whole page');
    return `${place}: ${lang.sentence(f.repair)} Expected result: ${lang.sentence(f.expected)}`;
  });
  const touchesLettering = findings.some((f) => f.check === 'lettering');
  const locked = [];
  if (!pageLevel && others.length) {
    locked.push(`Panel${others.length === 1 ? '' : 's'} ${joinNames(others.map(String))}: every figure, object, background, and line stays as it is.`);
  }
  if (letteringMode === 'overlay') {
    locked.push('The page stays free of text: add no balloons, captions, or sound effects.');
  } else if (touchesLettering) {
    locked.push('All lettering that CHANGES does not name: text, shape, and position stay as they are.');
  } else {
    locked.push('All lettering: every balloon, caption, and sound effect keeps its exact text, shape, and position.');
  }
  locked.push(`Panel borders, gutters, and the grid of ${sequence.length} panel${sequence.length === 1 ? '' : 's'}.`);
  locked.push('Inside the changed panels, everything CHANGES does not name.');
  locked.push('The drawing style, and the identity and wardrobe of every character CHANGES does not name.');
  return {
    failing,
    pageLevel,
    repair: {
      of_render: review.render,
      findings: findings.map((f) => f.id),
      changes,
      locked,
    },
  };
}

/** The repair prompt. Deterministic. */
function composeRepairPrompt(input) {
  const { page, project, styleBlock, images, entityByAsset, bibles, letteringMode, ratio, findings, plan } = input;
  const direction = project.reading_direction === 'rtl' ? 'rtl' : 'ltr';
  const sequence = layout.readingSequence(page);
  const slots = layout.panelSlots(page, direction);
  const cast = pageCast(page);
  const total = sequence.length;
  const numberOf = (panelId) => sequence.findIndex((p) => p.id === panelId) + 1;

  const failingLines = ['FAILING PANELS'];
  for (const f of findings) {
    const n = numberOf(f.panel);
    const where = n ? `Panel ${n} (${layout.slotPhrase(slots.get(sequence[n - 1].id))})` : 'Whole page';
    failingLines.push(`${where}. Failed check: ${lang.humanize(f.check)}.`);
    failingLines.push(`  Visible now: ${lang.sentence(f.visible)}`);
    failingLines.push(`  Expected: ${lang.sentence(f.expected)}`);
  }

  const planned = plan.pageLevel ? sequence.map((_, i) => i + 1) : plan.failing;
  const sections = [
    styleBlock.trim(),
    ['REPAIR',
      `Edit Image 1, the rendered comic page. This corrects an existing page; it is not a new drawing. Change only what CHANGES lists and return the whole page at the same size, aspect ratio ${ratio}, with the same ${total}-panel grid.`]
      .join('\n'),
    legendSection(images, entityByAsset, bibles),
    failingLines.join('\n'),
    ['CHANGES'].concat(plan.repair.changes.map((c, i) => `${i + 1}. ${c}`)).join('\n'),
    ['PLANNED CONTENT OF THE CHANGED PANELS']
      .concat(planned.map((n) => panelBlock(sequence[n - 1], { number: n, total, slot: slots.get(sequence[n - 1].id), cast, bibles })))
      .join('\n\n'),
    ['LOCKED, DO NOT CHANGE'].concat(plan.repair.locked.map((l) => `- ${l}`)).join('\n'),
    ['HARD CONSTRAINTS',
      `- The page still has exactly ${total} panel${total === 1 ? '' : 's'} in the same positions.`,
      `- Each named character appears exactly once in every panel that lists them: ${castCountLine(sequence, bibles)}.`,
      letteringMode === 'overlay' ? '- No text anywhere in the image.' : '- No new text, and no lettering removed or reworded unless CHANGES says so.',
      '- No watermark, signature, or page number.'].join('\n'),
  ];
  return sections.join('\n\n');
}

/** Is a plan entry needed for these panels? (entries without an entity apply to all) */
function entryRelevant(entry, panels) {
  const entity = String(entry.entity || '');
  if (entry.role === 'style' || !entity || entity.startsWith('LOOK_')) return true;
  return panels.some((panel) => {
    if (entity.startsWith('CHAR_')) return drawnCast(panel).some((row) => row.character === entity);
    if (entity.startsWith('LOC_')) return panel.location === entity;
    if (entity.startsWith('PROP_')) {
      return visibleProps(panel).some((row) => row.prop === entity) ||
        drawnCast(panel).some((row) => Array.isArray(row.holding) && row.holding.includes(entity));
    }
    return true;
  });
}

/**
 * Turn plan entries into package references that fit the budget.
 * Optional entries go first, last one first. In a repair, required entries
 * that no changed panel needs may go too (never the style reference); a
 * generate package never loses a required entry.
 */
function resolveReferences(root, plan, options) {
  const { capacity, providerId, repair, relevantPanels, warnings } = options;
  const assets = ws.loadReferenceAssets(root);
  const entries = [];
  const consider = (entry, required) => {
    if (!entry || !entry.asset_id) return;
    if (relevantPanels && !entryRelevant(entry, relevantPanels)) return;
    let imagePath = null;
    if (ws.ID.render.test(entry.asset_id)) {
      const file = ws.renderFile(root, entry.asset_id);
      const review = ws.loadReview(root, entry.asset_id);
      if (!file || !ws.reviewPasses(review)) {
        const why = !file ? 'its file is not on disk' : 'it no longer has a passing review';
        if (required) throw pipelineError('reference_unusable', `reference plan requires render ${entry.asset_id} but ${why}; rebuild the reference plan`);
        warnings.push(`render ${entry.asset_id} dropped: ${why}`);
        return;
      }
      imagePath = ws.rel(root, file);
    } else {
      const asset = assets.get(entry.asset_id);
      if (!asset || asset.status !== 'approved' || !asset.path) {
        const why = !asset ? 'it is not registered in references/manifest.yaml'
          : asset.status !== 'approved' ? `it is ${asset.status}, not approved` : 'it has no path in the registry';
        if (required) throw pipelineError('reference_unusable', `reference plan requires ${entry.asset_id} but ${why}; fix the registry and rebuild the reference plan`);
        warnings.push(`${entry.asset_id} dropped: ${why}`);
        return;
      }
      imagePath = String(asset.path).replace(/\\/g, '/');
    }
    if (entries.some((e) => e.asset_id === entry.asset_id)) return;
    entries.push({
      asset_id: entry.asset_id,
      role: entry.role,
      image_path: imagePath,
      entity: entry.entity || null,
      required,
      relevant: repair ? entryRelevant(entry, repair.panels) : true,
    });
  };
  for (const entry of Array.isArray(plan.required) ? plan.required : []) consider(entry, true);
  for (const entry of Array.isArray(plan.optional) ? plan.optional : []) consider(entry, false);

  while (entries.length > capacity) {
    let index = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (!entries[i].required) { index = i; break; }
    }
    if (index === -1 && repair) {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (!entries[i].relevant && entries[i].role !== 'style') { index = i; break; }
      }
    }
    if (index === -1) {
      throw pipelineError('budget_exceeded',
        `${entries.length} required reference image(s)${repair ? ' plus the edit target' : ''} do not fit ${providerId}` +
        `, which takes ${options.totalCapacity} image(s) per request. ` +
        (repair
          ? 'Repair with a provider that has a larger budget, or split the repair so each request changes fewer characters.'
          : `Rebuild the reference plan for ${providerId} (build-reference-plan.js --provider ${providerId}), or use a provider with a larger budget.`));
    }
    const [dropped] = entries.splice(index, 1);
    warnings.push(`${dropped.asset_id} (${dropped.role}) not attached: ${providerId} takes ${options.totalCapacity} image(s)${repair ? ', one of them the edit target' : ''}`);
  }
  return entries;
}

/**
 * Compile the prompt package of a page.
 * @param {string} root workspace root
 * @param {object} page page.yaml document
 * @param {{providerId?: string, provider?: object, project?: object, plan?: object,
 *          styleBlock?: string, model?: string, panel?: string,
 *          repairReview?: object}} [options]
 * @returns {{pkg: object, spec: object, warnings: string[], fileName: string}}
 * @throws an Error with `code` on any refusal
 */
function compilePage(root, page, options = {}) {
  const project = options.project || ws.loadProject(root) || {};
  const providerId = resolveProviderId(options.providerId, page, project);
  const provider = options.provider || loadImageProvider(providerId);
  const capabilities = provider.capabilities || {};
  const totalCapacity = typeof capabilities.referenceImages === 'number' ? capabilities.referenceImages : Infinity;
  const letteringMode = project.lettering && project.lettering.mode === 'overlay' ? 'overlay' : 'in_image';
  const warnings = [];

  const styleBlock = options.styleBlock !== undefined ? options.styleBlock : ws.loadStyleBlock(root, project);
  if (!styleBlock || !String(styleBlock).trim()) {
    throw pipelineError('style_block_missing',
      `${page.id}: the frozen style block is missing or empty (${(project.style && project.style.style_block) || 'style/style-block.txt'}). ` +
      'Every prompt starts with it verbatim; write it with /style-bible first.');
  }
  // The plan on disk is used only while it fits the page's generation mode,
  // this provider, and its budget; otherwise it is rebuilt and rewritten
  // first, so switching full_page <-> per_panel never compiles a stale plan.
  let plan = options.plan || null;
  if (!plan) {
    const ensured = ensureReferencePlan(root, page, { providerId, capabilities, project, now: options.now });
    plan = ensured.doc;
    if (ensured.rebuilt) warnings.push(`the reference plan was rebuilt: ${ensured.reasons.join('; ')}`);
  }
  if (!plan) {
    throw pipelineError('plan_missing',
      `${page.id}: no reference-plan.yaml next to page.yaml. Run build-reference-plan.js --page <page.yaml> first.`);
  }
  if (plan.page && plan.page !== page.id) {
    throw pipelineError('plan_mismatch', `reference plan is for ${plan.page}, not ${page.id}`);
  }
  if (!Array.isArray(page.panels) || !page.panels.length) {
    throw pipelineError('page_invalid', `${page.id}: the page has no panels to compile`);
  }

  const sequence = layout.readingSequence(page);
  const pageRatio = (project.page && project.page.aspect_ratio) || '2:3';
  const bibles = createBibles(root);

  // Mode.
  let mode = 'generate';
  let repairPlan = null;
  let findings = [];
  let editTarget = null;
  let panel = null;
  if (options.repairReview) {
    const review = options.repairReview;
    if (options.panel) throw pipelineError('bad_arguments', '--repair and --panel cannot be combined: a repair edits the whole rendered page');
    if (review.page !== page.id) {
      throw pipelineError('review_mismatch', `review is for ${review.page || '(no page)'}, not ${page.id}`);
    }
    const maxCycles = project.repair_policy && Number.isInteger(project.repair_policy.max_cycles)
      ? project.repair_policy.max_cycles : DEFAULT_MAX_REPAIR_CYCLES;
    const cycle = Number.isInteger(review.repair_cycle) ? review.repair_cycle : 0;
    if (cycle >= maxCycles) {
      throw pipelineError('repair_limit',
        `${review.render}: repair limit reached (repair_cycle ${cycle}, repair_policy.max_cycles ${maxCycles}). ` +
        'No further repair is compiled. Fix the page plan or the references first (an ambiguous identity sheet, a missing ledger row, an unclear panel), then compile a fresh generate package.');
    }
    findings = selectFindings(review);
    if (!findings.length) {
      throw pipelineError('nothing_to_repair', `${review.render}: the review has no open finding to repair`);
    }
    const file = review.render ? ws.renderFile(root, review.render) : null;
    if (!file) {
      throw pipelineError('edit_target_missing', `${review.render || '(no render)'}: the reviewed render is not on disk, so there is nothing to edit`);
    }
    mode = 'repair';
    editTarget = ws.rel(root, file);
    repairPlan = buildRepair(page, review, findings, letteringMode);
  } else if (options.panel) {
    panel = sequence.find((p) => p.id === options.panel);
    if (!panel) throw pipelineError('panel_missing', `${page.id} has no panel ${options.panel}`);
  }

  // References within the budget (the edit target is one of the images).
  const capacity = mode === 'repair' ? totalCapacity - 1 : totalCapacity;
  if (capacity < 0) {
    throw pipelineError('budget_exceeded', `${providerId} takes no input images, so it cannot carry an edit target`);
  }
  const repairPanels = repairPlan
    ? (repairPlan.pageLevel ? sequence : repairPlan.failing.map((n) => sequence[n - 1]))
    : null;
  const entries = resolveReferences(root, plan, {
    capacity,
    totalCapacity,
    providerId,
    warnings,
    repair: repairPlan ? { panels: repairPanels } : null,
    relevantPanels: panel ? [panel] : null,
  });
  const entityByAsset = new Map(entries.map((e) => [e.asset_id, e.entity]));

  // Parameters.
  let ratio = pageRatio;
  const parameters = { aspect_ratio: pageRatio };
  if (panel) {
    const slot = layout.panelSlots(page, project.reading_direction === 'rtl' ? 'rtl' : 'ltr').get(panel.id);
    const estimate = panel.size === 'splash' ? layout.ratioValue(pageRatio)
      : layout.estimatePanelRatio(pageRatio, slot.tiers, slot.of);
    ratio = layout.nearestRatio(estimate, capabilities.aspectRatios) || pageRatio;
    parameters.aspect_ratio = ratio;
  } else if (project.page && project.page.width_px && project.page.height_px) {
    parameters.resolution = `${project.page.width_px}x${project.page.height_px}`;
  }
  parameters.seed = null;

  // A panel package keeps the page scope and marks the panel in its suffix
  // (PP_PG_001_002_FAL-P03), so it still matches the package ID pattern.
  const panelSuffix = panel ? `-P${String(panel.order).padStart(2, '0')}` : '';
  const pkg = {
    id: `PP_${page.id}_${providerTag(providerId)}${panelSuffix}`,
    page: page.id,
    asset: null,
    provider: providerId,
    model: 'pending',
    mode,
    prompt: '',
    negative_prompt: letteringMode === 'overlay' ? `${NEGATIVE_BASE}, ${NEGATIVE_NO_TEXT}` : NEGATIVE_BASE,
    parameters,
    references: entries.map((e) => ({ asset_id: e.asset_id, role: e.role, image_path: e.image_path })),
    edit_target: editTarget,
  };
  if (repairPlan) pkg.repair = repairPlan.repair;

  const images = attachments(pkg);
  const input = { page, project, styleBlock: String(styleBlock), images, entityByAsset, bibles, letteringMode, ratio };
  if (mode === 'repair') {
    pkg.prompt = composeRepairPrompt(Object.assign({ findings, plan: repairPlan }, input));
  } else if (panel) {
    pkg.prompt = composePanelPrompt(Object.assign({ panel }, input));
  } else {
    pkg.prompt = composePagePrompt(input);
  }
  pkg.lettering_text = letteringMode === 'in_image'
    ? letteringElements(page, panel ? [panel.id] : null).map((x) => String(x.el.text))
    : [];
  pkg.status = 'compiled';
  pkg.source_hashes = {
    page: hashPage(page),
    reference_plan: hashPlan(plan),
    style_block: hashText(String(styleBlock)),
  };

  let spec;
  try {
    spec = provider.compile(pkg, options.model ? { model: String(options.model) } : {});
  } catch (err) {
    throw pipelineError('provider_rejected', `${providerId} cannot run this package: ${err.message}`);
  }
  pkg.model = spec.model; // pin the exact model the provider resolved
  for (const w of (spec.meta && spec.meta.warnings) || []) warnings.push(w);
  if (letteringMode === 'in_image' && pkg.lettering_text.length && capabilities.textRendering === 'unreliable') {
    warnings.push(`${providerId} renders text unreliably: the review must check all ${pkg.lettering_text.length} lettering string(s) against lettering_text`);
  }

  return {
    pkg,
    spec,
    warnings,
    fileName: panel ? `${providerId}.${panel.id}.yaml` : `${providerId}.yaml`,
  };
}

/**
 * Characters `charId` could be confused with, across the whole cast:
 * the ones its file lists, then every character whose file lists it.
 */
function adjacentInCast(root, charId, bibles) {
  const own = bibles.character(charId);
  const out = own && Array.isArray(own.visually_adjacent_to) ? own.visually_adjacent_to.slice() : [];
  for (const other of ws.listEntityIds(root, 'characters')) {
    if (other === charId || out.includes(other)) continue;
    const doc = bibles.character(other);
    if (doc && Array.isArray(doc.visually_adjacent_to) && doc.visually_adjacent_to.includes(charId)) out.push(other);
  }
  return out.filter((id) => id !== charId);
}

/** A list of IDs from an array or a comma-separated string. */
function idList(input) {
  if (input === undefined || input === null || input === true) return [];
  const raw = Array.isArray(input) ? input : String(input).split(',');
  return [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
}

/**
 * The change list of a sheet revision: [{ text, region }]. Takes an array of
 * strings or of { text, region } (region as fractions of the image, the
 * shape page corrections use), or text separated by semicolons or new lines.
 */
function sheetChanges(input) {
  if (input === undefined || input === null || input === true) return [];
  const raw = Array.isArray(input) ? input : String(input).split(/[;\n]/);
  const out = [];
  for (const item of raw) {
    const text = String(item && typeof item === 'object' ? item.text || '' : item || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push({ text, region: item && typeof item === 'object' && item.region ? item.region : null });
  }
  return out;
}

/**
 * Physical states the pages give a character (wounded, soaked), in plain
 * words and in story order, at most four: the states a full character sheet
 * shows by default.
 */
function storyStates(root, charId) {
  const out = [];
  for (const issueId of ws.listIssues(root)) {
    for (const entry of ws.listPages(root, issueId)) {
      const hasPanels = entry.doc && Array.isArray(entry.doc.panels) && entry.doc.panels.length > 0;
      for (const panel of hasPanels ? layout.readingSequence(entry.doc) : []) {
        for (const row of drawnCast(panel)) {
          if (row.character !== charId) continue;
          for (const tag of Array.isArray(row.state) ? row.state : []) {
            const text = lang.humanize(String(tag));
            if (text && !out.includes(text)) out.push(text);
          }
        }
      }
    }
  }
  return out.slice(0, 4);
}

/** The refusal for an expressions or wardrobe sheet of a character with no approved identity master. */
function masterRequired(entityId, name, kind, chain) {
  const what = kind === 'wardrobe' ? 'wardrobe sheet' : 'expressions sheet';
  const waiting = chain.pool.filter((a) => MASTER_KINDS.includes(identityKindOf(a)) && a.status !== 'approved' && a.status !== 'superseded');
  let text = `${entityId}: the ${what} is drawn from the approved identity master of ${name} (the turnaround or the full character sheet), and there is none yet`;
  if (waiting.length) text += ` (${waiting.map((a) => `${a.id} is ${a.status}`).join(', ')})`;
  text += '. Draw the turnaround or the full character sheet, approve it, then draw this sheet.';
  if (chain.likeness.length) {
    text += ` The photos on file (${chain.likeness.map((a) => a.id).join(', ')}) are likeness sources for that first sheet only.`;
  }
  return pipelineError('master_required', text);
}

/**
 * The version of a sheet a revision edits: a candidate or master image of
 * that sheet in the entity's refs directory, by stem or by path.
 * @returns {{id: string, rel: string}}
 */
function sheetVersion(root, entityId, kind, given) {
  const tag = assetPaths.SHEET_TAGS[kind];
  const stemRe = new RegExp(`^${entityId}_${tag}(?:_MASTER)?_V\\d{2}$`);
  const dir = assetPaths.refsDir(entityId);
  let rel = null;
  if (/[\\/]/.test(given) || ws.IMAGE_EXTENSIONS.includes(path.extname(given).toLowerCase())) {
    const absolute = path.isAbsolute(given) ? given : ws.abs(root, given);
    rel = toPosix(ws.rel(root, absolute));
    if (!fs.existsSync(absolute)) rel = null;
  } else {
    for (const ext of ws.IMAGE_EXTENSIONS) {
      if (fs.existsSync(ws.abs(root, `${dir}/${given}${ext}`))) {
        rel = `${dir}/${given}${ext}`;
        break;
      }
    }
  }
  const stem = rel ? path.posix.basename(rel).replace(/\.[^.]+$/, '') : '';
  if (!rel || path.posix.dirname(rel) !== dir || !stemRe.test(stem)) {
    throw pipelineError('revise_target_missing',
      `--revise ${given}: no image of the ${kind === 'model' ? 'full character sheet' : kind} of ${entityId} by that name in ${dir}/ ` +
      `(expected ${entityId}_${tag}_V## or ${entityId}_${tag}_MASTER_V##)`);
  }
  return { id: stem, rel };
}

/** A likeness source named for a revision round: registered for the entity, approved, a photo or drawing. */
function likenessAsset(assets, entityId, id) {
  const asset = assets.get(id);
  if (!asset || asset.entity !== entityId || asset.status !== 'approved' || !isLikenessSource(asset)) {
    throw pipelineError('bad_arguments',
      `--likeness ${id}: not an approved photo or drawing of ${entityId} in references/manifest.yaml ` +
      '(a likeness source has role identity and a kind that is not a drawn sheet)');
  }
  return asset;
}

/**
 * Compile the prompt package of a reference sheet (asset scope).
 * @param {string} root workspace root
 * @param {string} entityId CHAR_*, LOC_*, PROP_* or LOOK_* entity ID
 * @param {{sheet: string, outfit?: string, subject?: string, time?: string, expressions?: string|string[],
 *          providerId?: string, provider?: object, project?: object,
 *          styleBlock?: string, model?: string}} options
 * @returns {{pkg: object, spec: object, warnings: string[], notes: string[], fileRel: string}}
 *   fileRel is the workspace-relative path the package belongs at
 * @throws an Error with `code` on any refusal
 */
function compileAsset(root, entityId, options = {}) {
  const type = assetPaths.entityType(entityId);
  if (!type) {
    throw pipelineError('bad_arguments', `--asset needs an entity ID (CHAR_*, LOC_*, PROP_* or LOOK_*), got "${entityId}"`);
  }
  const kind = options.sheet && options.sheet !== true ? String(options.sheet) : null;
  const allowed = assetPaths.SHEET_KINDS[type];
  if (!kind || !allowed.includes(kind)) {
    throw pipelineError('bad_arguments',
      `--sheet ${kind || '(missing)'} does not apply to ${entityId}: a ${type} entity takes ${allowed.join(' | ')}`);
  }
  const subject = options.subject && options.subject !== true ? String(options.subject).trim() : '';
  if (kind === 'detail' && !subject) {
    throw pipelineError('bad_arguments', '--sheet detail needs --subject "<what the study shows>"');
  }
  const timeWanted = options.time && options.time !== true ? String(options.time).trim() : '';
  if (timeWanted && kind !== 'plate') {
    throw pipelineError('bad_arguments', '--time applies to --sheet plate only');
  }
  // What tells this sheet from another of the same kind (outfit, subject,
  // non-default time of day); part of the file name, the ID, and the candidate.
  let variant = kind === 'detail' ? assetPaths.sheetVariant(entityId, kind, { subject }) : null;
  if (kind === 'detail' && !variant) {
    throw pipelineError('bad_arguments', `--subject "${subject}" has no letter or digit to name the detail by`);
  }
  // A revision of a full character sheet: the previous version is edited
  // into the next one with a list of changes.
  const reviseWanted = options.revise && options.revise !== true ? String(options.revise).trim() : '';
  const changes = sheetChanges(options.changes);
  const likenessWanted = idList(options.likeness);
  if ((reviseWanted || changes.length || likenessWanted.length) && kind !== 'model') {
    throw pipelineError('bad_arguments', '--revise, --changes, and --likeness apply to --sheet model only');
  }
  if (reviseWanted && !changes.length) {
    throw pipelineError('bad_arguments', '--revise needs --changes "<what to change>; <another change>"');
  }
  if (!reviseWanted && (changes.length || likenessWanted.length)) {
    throw pipelineError('bad_arguments', '--changes and --likeness need --revise <the version to edit>');
  }
  const corrections = (Array.isArray(options.corrections) ? options.corrections : [])
    .map((c) => String(c || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (corrections.length && reviseWanted) {
    throw pipelineError('bad_arguments', 'corrections apply to a fresh drawing, not to a revision');
  }

  const project = options.project || ws.loadProject(root) || {};
  const providerId = resolveProviderId(options.providerId, null, project);
  const provider = options.provider || loadImageProvider(providerId);
  const capabilities = provider.capabilities || {};
  const capacity = typeof capabilities.referenceImages === 'number' ? capabilities.referenceImages : Infinity;
  const letteringMode = project.lettering && project.lettering.mode === 'overlay' ? 'overlay' : 'in_image';
  const warnings = [];
  const notes = [];

  const styleBlock = options.styleBlock !== undefined ? options.styleBlock : ws.loadStyleBlock(root, project);
  if (!styleBlock || !String(styleBlock).trim()) {
    throw pipelineError('style_block_missing',
      `${entityId}: the frozen style block is missing or empty (${(project.style && project.style.style_block) || 'style/style-block.txt'}). ` +
      'Every prompt starts with it verbatim; write it with /style-bible first.');
  }

  const bibles = createBibles(root);
  const assets = ws.loadReferenceAssets(root);
  const name = bibles.entityName(entityId);
  const missingBible = (file) => pipelineError('entity_missing',
    `${entityId}: ${file} not found in the workspace. Write the bible entry before compiling its sheet.`);

  // The entity's canonical description, from its bible file.
  const subjectLines = [];
  const extraSections = [];
  const briefCtx = {
    name,
    subject,
    format: project.comic_format,
    genre: project.genre ? String(project.genre).trim() : '',
    letteringMode,
  };
  if (type === 'CHAR') {
    const character = bibles.character(entityId);
    if (!character) throw missingBible(`characters/${entityId}/character.yaml`);
    const wardrobe = bibles.wardrobe(entityId);
    const outfits = wardrobe && Array.isArray(wardrobe.outfits) ? wardrobe.outfits.filter((o) => o && o.id) : [];
    const outfitId = kind === 'wardrobe' && options.outfit && options.outfit !== true
      ? String(options.outfit) : character.default_wardrobe;
    const outfit = outfits.find((o) => o.id === outfitId) || null;
    if (kind === 'wardrobe' && !outfit) {
      throw pipelineError('outfit_missing',
        `${entityId}: ${outfitId ? `outfit ${outfitId} is not in characters/${entityId}/wardrobe.yaml` : 'no --outfit given and the character has no default_wardrobe'}` +
        ` (outfits on file: ${outfits.map((o) => o.id).join(', ') || 'none'})`);
    }
    if (kind === 'wardrobe') variant = assetPaths.sheetVariant(entityId, kind, { outfit: outfit.id });
    if (kind === 'expressions') briefCtx.expressions = sheets.expressionList(options.expressions);
    if (kind === 'model') {
      const lists = sheets.modelLists(character, { closeups: options.closeups, poses: options.poses }, storyStates(root, entityId));
      briefCtx.closeups = lists.closeups;
      briefCtx.poses = lists.poses;
      briefCtx.line = sheets.sheetLine({
        title: project.title,
        language: project.language,
        number: assetPaths.nextCandidate(root, entityId, assetPaths.SHEET_TAGS.model).version,
      });
    }
    subjectLines.push(...sheets.characterSubject(character, name));
    if (kind === 'wardrobe') {
      extraSections.push(['OUTFIT', ...sheets.outfitLines(outfit, 'The outfit on this sheet')].join('\n'));
    } else {
      subjectLines.push(...sheets.outfitLines(outfit, 'Outfit'));
    }
    for (const otherId of adjacentInCast(root, entityId, bibles)) {
      subjectLines.push(differenceLine(entityId, otherId, bibles));
    }
  } else if (type === 'LOC') {
    const location = bibles.location(entityId);
    if (!location) throw missingBible(`locations/${entityId}/location.yaml`);
    const map = ws.loadLocationMap(root, entityId);
    const states = (Array.isArray(location.time_of_day_states) ? location.time_of_day_states : []).map(String);
    if (timeWanted && !states.includes(timeWanted)) {
      throw pipelineError('time_unknown',
        `${entityId}: --time ${timeWanted} is not one of the location's time_of_day_states (${states.join(', ') || 'none on file'}). ` +
        'Design that state in location.yaml first, then compile its plate.');
    }
    const time = timeWanted || states[0] || null;
    if (time) briefCtx.time = lang.humanize(time);
    if (kind === 'plate') variant = assetPaths.sheetVariant(entityId, kind, { time, defaultTime: states[0] });
    subjectLines.push(...sheets.locationSubject(location, name));
    const geography = sheets.geographyLines(map);
    if (geography.length) extraSections.push(['GEOGRAPHY', ...geography].join('\n'));
    else if (kind === 'plate') {
      warnings.push(`locations/${entityId}/map.yaml is missing or empty: the plate states no sides, levels, or landmarks, and later pages may contradict it`);
    }
  } else if (type === 'PROP') {
    const prop = bibles.prop(entityId);
    if (!prop) throw missingBible(`props/${entityId}/prop.yaml`);
    subjectLines.push(...sheets.propSubject(prop, name));
  }

  // References: one role per image.
  const picked = [];
  if (type === 'LOOK') {
    const own = bestApproved(entityAssets(assets, entityId)
      .filter((a) => !a.kind || a.kind === 'look' || a.default_role === 'style'));
    if (own) picked.push({ asset: own, role: 'style' });
    else notes.push(`${entityId} has no approved master yet: this is its first look, compiled with no reference image.`);
  } else {
    const { look, pool, unregistered } = findLookMaster(project, assets);
    if (!look) {
      const why = pool.length
        ? `the look master is not approved (${pool.map((a) => `${a.id} is ${a.status}`).join(', ')})`
        : `no look master is registered${unregistered.length ? ` (project.style.look_refs lists ${unregistered.join(', ')}, which references/manifest.yaml does not register)` : ''}`;
      throw pipelineError(pool.length ? 'look_unapproved' : 'look_missing',
        `${entityId}: ${why}. A sheet is drawn in the approved look, so finish the look first: ` +
        'compile and generate a look page (--asset <LOOK_ID> --sheet look), approve it, and list it under style.look_refs.');
    }
    picked.push({ asset: look, role: 'style' });
  }

  // The identity chain of a character: one identity master, drawn, approved.
  let editTarget = null;
  if (type === 'CHAR') {
    const chain = findIdentityChain(assets, entityId, bibles.character(entityId));
    const sheetName = kind === 'model' ? 'full character sheet' : kind;
    // Photos or drawings a person supplied, attached for likeness only, as
    // far as the provider's budget allows (the look master and an edit
    // target come first).
    const addLikeness = (list) => {
      for (const asset of list) {
        if (picked.length + (editTarget ? 1 : 0) >= capacity) {
          warnings.push(`${asset.id} not attached as a likeness source: ${providerId} takes ${capacity} image(s)`);
          continue;
        }
        picked.push({ asset, role: 'identity', likeness: true });
      }
    };
    if (kind === 'expressions' || kind === 'wardrobe') {
      // Drawn from the approved master only: never from a photo, and never
      // from a candidate the person has not said is right.
      if (!chain.master) throw masterRequired(entityId, name, kind, chain);
      picked.push({ asset: chain.master, role: 'identity' });
    } else if (MASTER_KINDS.includes(kind)) {
      if (reviseWanted) {
        // The previous version carries the identity; a photo the person
        // attached to this round is used for this round only.
        editTarget = sheetVersion(root, entityId, kind, reviseWanted);
        addLikeness(likenessWanted.map((id) => likenessAsset(assets, entityId, id)));
      } else if (!chain.master) {
        if (chain.likeness.length) {
          addLikeness(chain.likeness);
          notes.push(`${entityId} has no approved drawn sheet yet: the ${sheetName} is drawn from the description and ` +
            `${chain.likeness.map((a) => a.id).join(', ')} as likeness source(s), translated into the comic style.`);
        } else {
          notes.push(`${entityId} has no approved drawn sheet and no photo on file: the ${sheetName} is drawn from the written description only.`);
        }
      } else if (identityKindOf(chain.master) === kind) {
        notes.push(`${chain.master.id} is the approved ${sheetName}: this new version is drawn from the written description, as a redesign` +
          `${kind === 'model' ? '. To change the sheet and keep the rest, revise it (--revise)' : ''}.`);
      } else {
        // The other master kind exists: the new sheet is drawn from it.
        picked.push({ asset: chain.master, role: 'identity' });
      }
    }
  }
  for (const p of picked) {
    if (!p.asset.path) {
      throw pipelineError('reference_unusable', `${p.asset.id} has no path in references/manifest.yaml`);
    }
  }
  const imageCount = picked.length + (editTarget ? 1 : 0);
  if (imageCount > capacity) {
    const roomier = roomierProviders(imageCount, providerId, listProviders('image'));
    throw pipelineError('budget_exceeded',
      `${entityId}: the ${kind} sheet needs ${imageCount} reference image(s) (${[...(editTarget ? [editTarget.id] : []), ...picked.map((p) => p.asset.id)].join(', ')}) ` +
      `but ${providerId} takes ${capacity}. ` +
      (roomier.length ? `Use a provider with a larger budget: ${roomier.join(', ')}.` : 'No listed provider takes that many images.'));
  }

  // Parameters: sheets are square, plates landscape, look pages page-shaped.
  const pageRatio = (project.page && project.page.aspect_ratio) || '2:3';
  const ratio = sheets.pickRatio(kind, capabilities.aspectRatios, pageRatio);
  const parameters = { aspect_ratio: ratio };
  if (kind === 'look' && ratio === pageRatio && project.page && project.page.width_px && project.page.height_px) {
    parameters.resolution = `${project.page.width_px}x${project.page.height_px}`;
  }
  parameters.seed = null;

  const pkg = {
    id: assetPaths.packageId(entityId, providerId, kind, variant),
    page: null,
    asset: entityId,
    provider: providerId,
    model: 'pending',
    mode: editTarget ? 'repair' : 'generate',
    prompt: '',
    negative_prompt: sheets.negativePrompt(kind, letteringMode),
    parameters,
    references: picked.map((p) => ({
      asset_id: p.asset.id,
      role: p.role,
      image_path: String(p.asset.path).replace(/\\/g, '/'),
    })),
    edit_target: editTarget ? editTarget.rel : null,
  };
  if (editTarget) {
    // What was right stays right: everything the change list does not name is locked.
    pkg.repair = {
      changes: changes.map((c) => {
        const where = regionPhrase(c.region);
        return `${where ? `In ${where}: ` : ''}${capitalize(lang.sentence(c.text))}`;
      }),
      locked: [
        'Everything CHANGES does not name: the face, hair, build, and clothing, every view, close-up, and pose, their labels, and their places on the sheet.',
        'The name header and the line under it, except for the sheet number.',
        'The drawing style, the plain background, and the flat, even light.',
      ],
    };
  }

  const entityByAsset = new Map(picked.map((p) => [p.asset.id, p.asset.entity || null]));
  const legend = legendSection(attachments(pkg), entityByAsset, bibles, {
    likeness: new Set(picked.filter((p) => p.likeness).map((p) => p.asset.id)),
    editTarget: editTarget ? 'sheet' : null,
  });
  const sections = [String(styleBlock).trim()];
  if (editTarget) {
    sections.push(['REVISION',
      `Edit Image 1, the previous version of the full character sheet of ${name}. This is the next version of the same sheet, not a new drawing. ` +
        `Change only what CHANGES lists and return the whole sheet with the same layout, ${orientationOf(ratio)}, aspect ratio ${ratio}.`,
      ...colorLines(project)].join('\n'));
    sections.push(legend);
    sections.push(['CHANGES', ...pkg.repair.changes.map((c, i) => `${i + 1}. ${c}`)].join('\n'));
    if (subjectLines.length) sections.push(['SUBJECT, as the character file now describes them', ...subjectLines].join('\n'));
    sections.push(...extraSections);
    sections.push(['THE SHEET', ...sheets.modelLayout(briefCtx)].join('\n'));
    sections.push(['LOCKED, DO NOT CHANGE', ...pkg.repair.locked.map((l) => `- ${l}`)].join('\n'));
  } else {
    sections.push(['SHEET', ...sheets.sheetBrief(kind, briefCtx),
      `One image, ${orientationOf(ratio)}, aspect ratio ${ratio}.`,
      ...colorLines(project)].join('\n'));
    sections.push(legend);
    if (subjectLines.length) sections.push(['SUBJECT', ...subjectLines].join('\n'));
    sections.push(...extraSections);
    if (corrections.length) {
      sections.push(['CORRECTIONS',
        'The last drawing of this sheet did not match the identity reference. This drawing must fix each of these:',
        ...corrections.map((c, i) => `${i + 1}. ${capitalize(lang.sentence(c))}`)].join('\n'));
    }
  }
  sections.push(['HARD CONSTRAINTS', ...sheets.sheetConstraints(kind, briefCtx)].join('\n'));
  pkg.prompt = sections.join('\n\n');

  // A sheet carries no story lettering. A full character sheet letters its
  // name, its line, and its labels, which a look at the image can compare.
  pkg.lettering_text = kind === 'model'
    ? [name, briefCtx.line, ...briefCtx.closeups.map((c) => c.label), ...briefCtx.poses.map((p) => p.label)]
    : [];
  pkg.status = 'compiled';
  // The schema defines page, reference_plan, and style_block hashes and
  // requires none. An asset package has neither a page nor a reference
  // plan, so only the style block is hashed.
  pkg.source_hashes = { style_block: hashText(String(styleBlock)) };

  let spec;
  try {
    spec = provider.compile(pkg, options.model ? { model: String(options.model) } : {});
  } catch (err) {
    throw pipelineError('provider_rejected', `${providerId} cannot run this package: ${err.message}`);
  }
  pkg.model = spec.model;
  for (const w of (spec.meta && spec.meta.warnings) || []) warnings.push(w);

  return { pkg, spec, warnings, notes, fileRel: assetPaths.packageFile(entityId, providerId, kind, variant) };
}

// --- cover -------------------------------------------------------------------

/** The lines that describe one character on the cover. */
function coverCharacterLines(row, cast, bibles) {
  const name = bibles.characterName(row.character);
  const character = bibles.character(row.character);
  const bits = [`- ${name}.`];
  const summary = summaryOf(character);
  if (summary) bits.push(lang.sentence(summary));
  if (row.action) bits.push(`Action: ${lang.sentence(row.action)}`);
  if (row.acting) bits.push(`Acting: ${lang.sentence(row.acting)}`);
  const wardrobeId = row.wardrobe || (character && character.default_wardrobe) || null;
  const wardrobe = wardrobeId ? wardrobeDescription(row.character, wardrobeId, bibles) : null;
  if (wardrobe) bits.push(`Wardrobe: ${lang.sentence(wardrobe)}`);
  const state = lang.statePhrase(row.state);
  if (state) bits.push(`Physical state, visible in the drawing: ${state}.`);
  const holding = Array.isArray(row.holding) ? row.holding : [];
  if (holding.length) bits.push(`Holding: ${joinNames(holding.map((id) => propPhrase(id, bibles)))}.`);
  const lines = [bits.join(' ')];
  for (const otherId of adjacentOnPage(row.character, cast, bibles)) {
    lines.push(`  ${differenceLine(row.character, otherId, bibles)}`);
  }
  return lines;
}

/** What the cover shows: concept, composition, setting, characters, props. */
function coverSubject(cover, bibles) {
  const rows = (Array.isArray(cover.cast) ? cover.cast : []).filter((row) => row && row.character);
  const cast = rows.map((row) => row.character);
  const lines = [`Concept: ${lang.sentence(cover.concept)}`];
  if (cover.composition) lines.push(`Composition: ${lang.sentence(cover.composition)}`);
  if (cover.location) {
    const summary = summaryOf(bibles.location(cover.location));
    lines.push(`Setting: ${bibles.locationName(cover.location)}.${summary ? ` ${lang.sentence(summary)}` : ''}` +
      `${cover.time_of_day ? ` Time of day: ${lang.humanize(cover.time_of_day)}.` : ''}`);
  } else if (cover.time_of_day) {
    lines.push(`Time of day: ${lang.humanize(cover.time_of_day)}.`);
  }
  if (rows.length) {
    lines.push(`Characters on the cover: ${rows.length} (${joinNames(rows.map((row) => bibles.characterName(row.character)))}), each exactly once.`);
    for (const row of rows) lines.push(...coverCharacterLines(row, cast, bibles));
  } else {
    lines.push('Characters on the cover: none of the named characters.');
  }
  const props = (Array.isArray(cover.props) ? cover.props : []).filter(Boolean);
  if (props.length) {
    lines.push('Props in view:');
    for (const propId of props) lines.push(`- ${capitalize(propPhrase(propId, bibles))}.`);
  }
  return lines;
}

/** The cover's lettering section: its exact strings, or an instruction to leave the art free of text. */
function coverLetteringSection(cover, project, mode) {
  const elements = coverLib.letteringElements(cover);
  if (mode === 'overlay') {
    return [
      'LETTERING',
      'None in the image: the title and the other cover text are added afterwards as an overlay. Draw no text of any kind: no title, no logo, no credits, no readable signs.',
      'Leave calm, uncluttered space for the title, away from faces and hands.',
    ].join('\n');
  }
  const lettering = project.lettering || {};
  const lines = [
    'LETTERING',
    `Letter the cover with exactly these ${elements.length} element${elements.length === 1 ? '' : 's'}. Copy every string character for character, with its accents and punctuation.` +
      (lettering.case === 'upper' ? ' Set the lettering in capitals; the words stay exactly as written.' : ''),
  ];
  elements.forEach((el, i) => lines.push(`${i + 1}. ${el.label}: "${el.text}"`));
  lines.push('Keep the lettering clear of faces, hands, and the main action.');
  const safeMargin = safeMarginLine(project);
  if (safeMargin) lines.push(safeMargin.replace('every balloon, caption, and sound effect', 'every piece of lettering'));
  return lines.join('\n');
}

function coverHeader(project, ratio) {
  const lines = ['COVER'];
  lines.push(project.comic_format === 'webtoon'
    ? `The cover image of one webtoon episode: one single illustration, ${orientationOf(ratio)}, aspect ratio ${ratio}.`
    : `The front cover of one comic book issue: one single full-bleed illustration, ${orientationOf(ratio)}, aspect ratio ${ratio}.`);
  lines.push('No panel grid, no panel borders, no gutters: the whole image is the cover.');
  lines.push(...colorLines(project));
  return lines.join('\n');
}

function coverConstraints(cover, bibles, mode, repair) {
  const names = (Array.isArray(cover.cast) ? cover.cast : [])
    .filter((row) => row && row.character)
    .map((row) => bibles.characterName(row.character));
  const textLine = mode === 'overlay'
    ? '- No text anywhere in the image.'
    : (repair ? '- No new text, and no lettering removed or reworded unless CHANGES says so.' : '- No text other than the lettering listed above.');
  return [
    'HARD CONSTRAINTS',
    repair ? '- Still one single image: no panels, no borders, no insets.' : '- One single image. No panels, no borders, no insets.',
    `- Named characters on the cover: ${names.length ? `${joinNames(names)}, each exactly once` : 'none'}.`,
    textLine,
    '- No watermark, signature, barcode, price, or page number.',
  ].join('\n');
}

/** Where a finding's optional region sits, as shares of the cover. Null without a usable region. */
function regionPhrase(region) {
  if (!region || typeof region !== 'object') return null;
  const x = Number(region.x);
  const y = Number(region.y);
  const w = Number(region.w !== undefined ? region.w : region.width);
  const h = Number(region.h !== undefined ? region.h : region.height);
  if (![x, y, w, h].every((n) => Number.isFinite(n)) || w <= 0 || h <= 0) return null;
  const pct = (n) => `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;
  return `the area from ${pct(x)} to ${pct(x + w)} of the width (left to right) and from ${pct(y)} to ${pct(y + h)} of the height (top to bottom)`;
}

/** Repair plan of a cover review: exact changes and locked elements. */
function buildCoverRepair(review, findings, mode) {
  const changes = findings.map((f) => {
    const where = regionPhrase(f.region);
    return `${where ? `In ${where}: ` : ''}${lang.sentence(f.repair)} Expected result: ${lang.sentence(f.expected)}`;
  });
  const touchesLettering = findings.some((f) => f.check === 'lettering');
  const locked = [];
  if (mode === 'overlay') {
    locked.push('The cover stays free of text: add no title, logo, or credits.');
  } else if (touchesLettering) {
    locked.push('All lettering that CHANGES does not name: text, shape, and position stay as they are.');
  } else {
    locked.push('All lettering: the title and every other string keep their exact text, shape, and position.');
  }
  locked.push('The composition, and everything CHANGES does not name.');
  locked.push('The drawing style, and the identity and wardrobe of every character CHANGES does not name.');
  return { of_render: review.render, findings: findings.map((f) => f.id), changes, locked };
}

/**
 * Reference images of a cover, one role each: the look master (style), the
 * identity master of every character on it, then the location plate and the
 * sheets of plot-relevant props, which give way first when the provider's
 * budget is short.
 */
function coverReferences(root, cover, project, bibles, options) {
  const { capacity, totalCapacity, providerId, repair, warnings } = options;
  const coverId = cover.id;
  const assets = ws.loadReferenceAssets(root);
  const picked = [];
  const add = (asset, role, required) => {
    if (!asset || picked.some((p) => p.asset.id === asset.id)) return;
    if (!asset.path) throw pipelineError('reference_unusable', `${asset.id} has no path in references/manifest.yaml`);
    picked.push({ asset, role, required });
  };

  const { look, pool, unregistered } = findLookMaster(project, assets);
  if (!look) {
    const why = pool.length
      ? `the look master is not approved (${pool.map((a) => `${a.id} is ${a.status}`).join(', ')})`
      : `no look master is registered${unregistered.length ? ` (project.style.look_refs lists ${unregistered.join(', ')}, which references/manifest.yaml does not register)` : ''}`;
    throw pipelineError(pool.length ? 'look_unapproved' : 'look_missing',
      `${coverId}: ${why}. A cover is drawn in the approved look, so finish the look first.`);
  }
  add(look, 'style', true);

  for (const row of (Array.isArray(cover.cast) ? cover.cast : []).filter((r) => r && r.character)) {
    const chain = findIdentityMaster(assets, row.character, bibles.character(row.character));
    const { identity } = chain;
    if (identity) add(identity, 'identity', true);
    // Photos are likeness sources for the first sheet, never cover references.
    else if (chain.likeness.length && !chain.pool.length) throw identityRefusal(coverId, row.character, chain);
    else warnings.push(`${row.character} has no approved identity master: the cover draws ${bibles.characterName(row.character)} from the written description only`);
  }
  if (cover.location) {
    const location = bibles.location(cover.location);
    const listed = location && Array.isArray(location.references) ? location.references : [];
    const plate = bestApproved(entityAssets(assets, cover.location), listed, { plate: 0 });
    if (plate) add(plate, plate.default_role === 'composition' ? 'composition' : 'spatial_continuity', false);
  }
  const propIds = [];
  for (const row of (Array.isArray(cover.cast) ? cover.cast : [])) {
    for (const id of (row && Array.isArray(row.holding) ? row.holding : [])) if (!propIds.includes(id)) propIds.push(id);
  }
  for (const id of (Array.isArray(cover.props) ? cover.props : [])) if (id && !propIds.includes(id)) propIds.push(id);
  for (const propId of propIds) {
    const prop = bibles.prop(propId);
    if (!prop || prop.plot_relevant !== true) continue;
    const sheet = bestApproved(entityAssets(assets, propId), Array.isArray(prop.references) ? prop.references : []);
    if (sheet) add(sheet, 'prop_consistency', false);
  }

  while (picked.length > capacity) {
    let index = -1;
    for (let i = picked.length - 1; i >= 0; i--) {
      if (!picked[i].required) { index = i; break; }
    }
    if (index === -1) {
      const roomier = roomierProviders(picked.length + (repair ? 1 : 0), providerId, listProviders('image'));
      throw pipelineError('budget_exceeded',
        `${coverId}: the cover needs ${picked.length} reference image(s)${repair ? ' plus the edit target' : ''} ` +
        `(${picked.map((p) => p.asset.id).join(', ')}) but ${providerId} takes ${totalCapacity}. ` +
        (roomier.length ? `Use a provider with a larger budget: ${roomier.join(', ')}.` : 'No listed provider takes that many images.'));
    }
    const [dropped] = picked.splice(index, 1);
    warnings.push(`${dropped.asset.id} (${dropped.role}) not attached: ${providerId} takes ${totalCapacity} image(s)${repair ? ', one of them the edit target' : ''}`);
  }
  return picked;
}

/**
 * Compile the prompt package of an issue's cover.
 *
 * The prompt is the frozen style block, a cover header (one image, the page
 * aspect ratio, color mode), the reference legend, the cover's subject from
 * cover.yaml and the bibles, its own lettering strings (or an instruction to
 * leave the art free of text in overlay mode), and hard constraints. With
 * `repair` it compiles a repair of the reviewed cover render instead.
 *
 * @param {{root: string, issue: string, provider?: string, model?: string,
 *          repair?: string|object, write?: boolean, project?: object,
 *          styleBlock?: string, providerModule?: object}} options
 *   `issue` is the ISS_###. `repair` is a review file path or a review
 *   document. `write: true` also writes the package to `fileRel`.
 * @returns {{pkg: object, spec: object, warnings: string[], fileName: string, fileRel: string}}
 *   The shape compilePage returns, plus fileRel: the workspace-relative path
 *   the package belongs at (issues/<ISS_ID>/cover/prompts/<provider>.yaml).
 * @throws an Error with `code` on any refusal
 */
function compileCover(options = {}) {
  const root = options.root;
  const issueId = String(options.issue || '');
  if (!root || !ws.ID.issue.test(issueId)) {
    throw pipelineError('bad_arguments', `compileCover needs { root, issue: "ISS_###" }, got issue "${options.issue}"`);
  }
  const coverId = ws.coverIdOfIssue(issueId);
  const cover = ws.loadCover(root, issueId);
  if (!cover || typeof cover !== 'object') {
    throw pipelineError('cover_missing',
      `${issueId} has no cover: issues/${issueId}/cover/cover.yaml not found. Write it with /cover first.`);
  }
  if (cover.id !== coverId) {
    throw pipelineError('cover_invalid', `issues/${issueId}/cover/cover.yaml has id ${cover.id || '(none)'}; the cover of ${issueId} is ${coverId}`);
  }
  if (!cover.concept || !String(cover.concept).trim()) {
    throw pipelineError('cover_invalid', `${coverId}: cover.yaml has no concept, so there is nothing to draw`);
  }

  const project = options.project || ws.loadProject(root) || {};
  const providerId = resolveProviderId(options.provider, cover, project);
  const provider = options.providerModule || loadImageProvider(providerId);
  const capabilities = provider.capabilities || {};
  const totalCapacity = typeof capabilities.referenceImages === 'number' ? capabilities.referenceImages : Infinity;
  const mode = coverLib.letteringMode(cover, project);
  const warnings = [];

  const styleBlock = options.styleBlock !== undefined ? options.styleBlock : ws.loadStyleBlock(root, project);
  if (!styleBlock || !String(styleBlock).trim()) {
    throw pipelineError('style_block_missing',
      `${coverId}: the frozen style block is missing or empty (${(project.style && project.style.style_block) || 'style/style-block.txt'}). ` +
      'Every prompt starts with it verbatim; write it with /style-bible first.');
  }

  // Mode.
  let review = null;
  if (options.repair !== undefined && options.repair !== null && options.repair !== false) {
    if (options.repair === true) throw pipelineError('bad_arguments', '--repair needs the path of a review file');
    if (typeof options.repair === 'string') {
      const reviewFile = path.resolve(options.repair);
      review = ws.loadYaml(reviewFile);
      if (!review) throw pipelineError('review_missing', `review file not found: ${reviewFile}`);
    } else {
      review = options.repair;
    }
  }
  let findings = [];
  let editTarget = null;
  let repair = null;
  if (review) {
    if (review.page !== coverId) {
      throw pipelineError('review_mismatch', `review is for ${review.page || '(no page)'}, not ${coverId}`);
    }
    const maxCycles = project.repair_policy && Number.isInteger(project.repair_policy.max_cycles)
      ? project.repair_policy.max_cycles : DEFAULT_MAX_REPAIR_CYCLES;
    const cycle = Number.isInteger(review.repair_cycle) ? review.repair_cycle : 0;
    if (cycle >= maxCycles) {
      throw pipelineError('repair_limit',
        `${review.render}: repair limit reached (repair_cycle ${cycle}, repair_policy.max_cycles ${maxCycles}). ` +
        'No further repair is compiled. Fix cover.yaml or the references first, then compile a fresh generate package.');
    }
    findings = selectFindings(review);
    if (!findings.length) {
      throw pipelineError('nothing_to_repair', `${review.render}: the review has no open finding to repair`);
    }
    const file = review.render ? ws.renderFile(root, review.render) : null;
    if (!file) {
      throw pipelineError('edit_target_missing', `${review.render || '(no render)'}: the reviewed render is not on disk, so there is nothing to edit`);
    }
    editTarget = ws.rel(root, file);
    repair = buildCoverRepair(review, findings, mode);
  }

  const capacity = repair ? totalCapacity - 1 : totalCapacity;
  if (capacity < 0) {
    throw pipelineError('budget_exceeded', `${providerId} takes no input images, so it cannot carry an edit target`);
  }
  const bibles = createBibles(root);
  const picked = coverReferences(root, cover, project, bibles, {
    capacity, totalCapacity, providerId, repair: Boolean(repair), warnings,
  });

  const ratio = (project.page && project.page.aspect_ratio) || '2:3';
  const parameters = { aspect_ratio: ratio };
  if (project.page && project.page.width_px && project.page.height_px) {
    parameters.resolution = `${project.page.width_px}x${project.page.height_px}`;
  }
  parameters.seed = null;

  const pkg = {
    id: `PP_${coverId}_${providerTag(providerId)}`,
    page: coverId, // a cover package names the cover where a page package names its page
    asset: null,
    provider: providerId,
    model: 'pending',
    mode: repair ? 'repair' : 'generate',
    prompt: '',
    negative_prompt: mode === 'overlay' ? `${NEGATIVE_BASE}, ${NEGATIVE_NO_TEXT}` : NEGATIVE_BASE,
    parameters,
    references: picked.map((p) => ({
      asset_id: p.asset.id,
      role: p.role,
      image_path: String(p.asset.path).replace(/\\/g, '/'),
    })),
    edit_target: editTarget,
  };
  if (repair) pkg.repair = repair;

  const entityByAsset = new Map(picked.map((p) => [p.asset.id, p.asset.entity || null]));
  const legend = legendSection(attachments(pkg), entityByAsset, bibles)
    .replace('the rendered page to edit', 'the rendered cover to edit');
  const subject = coverSubject(cover, bibles);
  const sections = [String(styleBlock).trim()];
  if (repair) {
    const failing = ['FAILING ELEMENTS'];
    for (const f of findings) {
      const where = regionPhrase(f.region);
      failing.push(`${where ? `${capitalize(where)}` : 'Whole cover'}. Failed check: ${lang.humanize(f.check)}.`);
      failing.push(`  Visible now: ${lang.sentence(f.visible)}`);
      failing.push(`  Expected: ${lang.sentence(f.expected)}`);
    }
    sections.push(
      ['REPAIR',
        `Edit Image 1, the rendered cover. This corrects an existing cover; it is not a new drawing. Change only what CHANGES lists and return the whole cover at the same size, aspect ratio ${ratio}.`].join('\n'),
      legend,
      failing.join('\n'),
      ['CHANGES'].concat(repair.changes.map((c, i) => `${i + 1}. ${c}`)).join('\n'),
      ['PLANNED CONTENT OF THE COVER', ...subject].join('\n'),
      ['LOCKED, DO NOT CHANGE'].concat(repair.locked.map((l) => `- ${l}`)).join('\n'),
      coverConstraints(cover, bibles, mode, true));
  } else {
    sections.push(
      coverHeader(project, ratio),
      legend,
      ['SUBJECT', ...subject].join('\n'),
      coverLetteringSection(cover, project, mode),
      coverConstraints(cover, bibles, mode, false));
  }
  pkg.prompt = sections.join('\n\n');
  pkg.lettering_text = mode === 'in_image' ? coverLib.letteringElements(cover).map((el) => el.text) : [];
  pkg.status = 'compiled';
  // A cover has no reference plan: its references come straight from
  // cover.yaml and the registry, so only the cover and the style block are hashed.
  pkg.source_hashes = {
    page: coverLib.hashCover(cover),
    style_block: hashText(String(styleBlock)),
  };

  let spec;
  try {
    spec = provider.compile(pkg, options.model ? { model: String(options.model) } : {});
  } catch (err) {
    throw pipelineError('provider_rejected', `${providerId} cannot run this package: ${err.message}`);
  }
  pkg.model = spec.model;
  for (const w of (spec.meta && spec.meta.warnings) || []) warnings.push(w);
  if (mode === 'in_image' && pkg.lettering_text.length && capabilities.textRendering === 'unreliable') {
    warnings.push(`${providerId} renders text unreliably: the review must check all ${pkg.lettering_text.length} lettering string(s) against lettering_text`);
  }

  const fileName = `${providerId}.yaml`;
  const fileRel = `issues/${issueId}/cover/prompts/${fileName}`;
  if (options.write === true) {
    assertValid('prompt-package', pkg, `prompt package ${pkg.id}`);
    writeFileEnsuring(ws.abs(root, fileRel), yaml.stringify(pkg));
  }
  return { pkg, spec, warnings, fileName, fileRel };
}

/** --cover branch of the CLI. */
function mainCover(flags) {
  let root;
  let result;
  try {
    if (flags.cover === true) throw pipelineError('bad_arguments', '--cover needs an issue ID such as ISS_001');
    for (const other of ['page', 'asset', 'panel', 'sheet']) {
      if (flags[other] !== undefined) throw pipelineError('bad_arguments', `--cover and --${other} cannot be combined`);
    }
    const start = flags.root && flags.root !== true ? path.resolve(String(flags.root)) : process.cwd();
    root = ws.findWorkspaceRoot(start);
    if (!root) {
      throw pipelineError('workspace_missing',
        `no project.yaml at or above ${start}: pass --root <workspace> or run from inside the workspace`);
    }
    result = compileCover({
      root,
      issue: String(flags.cover),
      provider: flags.provider,
      model: flags.model && flags.model !== true ? flags.model : undefined,
      repair: flags.repair,
    });
    const check = assertValid('prompt-package', result.pkg, `prompt package ${result.pkg.id}`);
    if (check.skipped) console.warn('warning: schemas/prompt-package.schema.json not found, schema validation skipped');
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
  const { pkg, spec, warnings } = result;
  const outFile = ws.abs(root, result.fileRel);
  writeFileEnsuring(outFile, yaml.stringify(pkg));
  console.log(`prompt package: ${pkg.id} (cover, ${pkg.mode}, ${pkg.provider}, model ${pkg.model}) -> ${toPosix(outFile)}`);
  console.log(`  prompt: ${pkg.prompt.length} characters, ${pkg.references.length} reference image(s)${pkg.edit_target ? ' + edit target' : ''}, aspect ${pkg.parameters.aspect_ratio}`);
  if (pkg.repair) console.log(`  repair of ${pkg.repair.of_render}: findings ${pkg.repair.findings.join(', ')}`);
  console.log(`  lettering strings in the image: ${pkg.lettering_text.length}`);
  console.log(`  request endpoint: ${endpointText(spec)}`);
  for (const w of warnings) console.log(`  warning: ${w}`);
  console.log(`  next: node scripts/generate-assets.js --cover ${flags.cover} --root ${toPosix(root)}`);
}

/** --asset branch of the CLI. */
function mainAsset(flags) {
  let root;
  let result;
  try {
    if (flags.asset === true) throw pipelineError('bad_arguments', '--asset needs an entity ID');
    for (const other of ['page', 'repair', 'panel']) {
      if (flags[other] !== undefined) throw pipelineError('bad_arguments', `--asset and --${other} cannot be combined`);
    }
    const start = flags.root && flags.root !== true ? path.resolve(String(flags.root)) : process.cwd();
    root = ws.findWorkspaceRoot(start);
    if (!root) {
      throw pipelineError('workspace_missing',
        `no project.yaml at or above ${start}: pass --root <workspace> or run from inside the workspace`);
    }
    result = compileAsset(root, String(flags.asset), {
      sheet: flags.sheet,
      outfit: flags.outfit,
      subject: flags.subject,
      time: flags.time,
      expressions: flags.expressions && flags.expressions !== true ? String(flags.expressions) : undefined,
      closeups: flags.closeups !== undefined && flags.closeups !== true ? String(flags.closeups) : undefined,
      poses: flags.poses !== undefined && flags.poses !== true ? String(flags.poses) : undefined,
      revise: flags.revise,
      changes: flags.changes !== undefined && flags.changes !== true ? String(flags.changes) : undefined,
      likeness: flags.likeness !== undefined && flags.likeness !== true ? String(flags.likeness) : undefined,
      providerId: flags.provider,
      model: flags.model && flags.model !== true ? flags.model : undefined,
    });
    const check = assertValid('prompt-package', result.pkg, `prompt package ${result.pkg.id}`);
    if (check.skipped) console.warn('warning: schemas/prompt-package.schema.json not found, schema validation skipped');
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
  const { pkg, spec, warnings, notes } = result;
  const outFile = ws.abs(root, result.fileRel);
  writeFileEnsuring(outFile, yaml.stringify(pkg));
  console.log(`prompt package: ${pkg.id} (asset ${pkg.asset}, ${pkg.provider}, model ${pkg.model}) -> ${toPosix(outFile)}`);
  console.log(`  prompt: ${pkg.prompt.length} characters, ${pkg.references.length} reference image(s)${pkg.edit_target ? ' + edit target' : ''}, aspect ${pkg.parameters.aspect_ratio}`);
  if (pkg.repair) console.log(`  revision of ${pkg.edit_target}: ${pkg.repair.changes.length} change(s), everything else locked`);
  console.log(`  request endpoint: ${endpointText(spec)}`);
  for (const n of notes) console.log(`  note: ${n}`);
  for (const w of warnings) console.log(`  warning: ${w}`);
  console.log(`  next: node scripts/generate-assets.js --package ${toPosix(outFile)}`);
}

function main() {
  helpIfRequested(process.argv.slice(2), HELP);
  const { flags } = parseArgs();
  if (flags.cover !== undefined) {
    mainCover(flags);
    return;
  }
  if (flags.asset !== undefined) {
    mainAsset(flags);
    return;
  }
  if (!flags.page || flags.page === true) {
    console.error('error: --page <page.yaml>, --cover <ISS_ID> or --asset <ENTITY_ID> --sheet <kind> is required (see --help)');
    process.exit(1);
  }
  let ctx;
  let result;
  try {
    ctx = loadPageContext(flags.page);
    let repairReview = null;
    if (flags.repair !== undefined) {
      if (flags.repair === true) throw pipelineError('bad_arguments', '--repair needs the path of a review file');
      const reviewFile = path.resolve(String(flags.repair));
      repairReview = ws.loadYaml(reviewFile);
      if (!repairReview) throw pipelineError('review_missing', `review file not found: ${reviewFile}`);
    }
    result = compilePage(ctx.root, ctx.page, {
      providerId: flags.provider,
      project: ctx.project,
      model: flags.model && flags.model !== true ? flags.model : undefined,
      panel: flags.panel && flags.panel !== true ? String(flags.panel) : undefined,
      repairReview,
    });
    const check = assertValid('prompt-package', result.pkg, `prompt package ${result.pkg.id}`);
    if (check.skipped) console.warn('warning: schemas/prompt-package.schema.json not found, schema validation skipped');
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
  const { pkg, spec, warnings } = result;
  const outFile = path.join(ctx.pageDir, 'prompts', result.fileName);
  writeFileEnsuring(outFile, yaml.stringify(pkg));
  console.log(`prompt package: ${pkg.id} (${pkg.mode}, ${pkg.provider}, model ${pkg.model}) -> ${toPosix(outFile)}`);
  console.log(`  prompt: ${pkg.prompt.length} characters, ${pkg.references.length} reference image(s)${pkg.edit_target ? ' + edit target' : ''}, aspect ${pkg.parameters.aspect_ratio}`);
  if (pkg.repair) console.log(`  repair of ${pkg.repair.of_render}: findings ${pkg.repair.findings.join(', ')}`);
  console.log(`  lettering strings in the image: ${pkg.lettering_text.length}`);
  console.log(`  request endpoint: ${endpointText(spec)}`);
  for (const w of warnings) console.log(`  warning: ${w}`);
}

module.exports = {
  compilePage,
  compileAsset,
  compileCover,
  composePagePrompt,
  composeRepairPrompt,
  composePanelPrompt,
  selectFindings,
  buildRepair,
  resolveReferences,
  letteringElements,
  differenceLine,
  storyStates,
  sheetChanges,
};

if (require.main === module) main();
