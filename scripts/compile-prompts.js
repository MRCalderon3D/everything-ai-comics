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
 *      and the props in view;
 *   5. lettering: the exact strings (in_image mode) or an instruction to
 *      leave the art free of text (overlay mode);
 *   6. hard constraints: exact panel count, one of each named character
 *      per panel, no extra text.
 *
 * --repair <review.yaml> compiles a repair instead: the reviewed render is
 * the edit target, the open blocking findings (or, when none is blocking,
 * every open finding) become the exact changes, and everything else is
 * locked. It refuses once the review's repair_cycle has reached the
 * project's repair_policy.max_cycles.
 *
 * provider.compile() runs last to enforce the provider's capabilities and
 * pin the model.
 */

const path = require('path');
const { writeFileEnsuring, toPosix } = require('./lib/fsx');
const { loadImageProvider, resolveProviderId } = require('./lib/providers');
const { parseArgs, helpIfRequested } = require('./lib/cli');
const {
  pipelineError, loadPageContext, hashPage, hashPlan, hashText, assertValid,
} = require('./lib/page-pipeline');
const layout = require('./lib/layout-language');
const lang = require('./lib/panel-language');
const ws = require('./lib/workspace');
const yaml = require('./lib/yaml');
const { attachments, providerTag } = require('../providers/lib/common');

const HELP = `
compile-prompts.js: compile a page into a prompt package for an image provider.

Usage:
  node scripts/compile-prompts.js --page <page.yaml> [--provider <id>] [--repair <review.yaml>]

Options:
  --page <file>      page.yaml (or its directory). Required.
  --provider <id>    Image provider. Default: the page's generation.provider,
                     then the project's default_providers.image.
  --repair <file>    A visual review of one of this page's renders. Compiles
                     a repair package: edit target, exact changes, locked
                     elements. Refused once the repair limit is reached.
  --model <id>       Pin a model instead of the provider's default.
  --panel <PN_ID>    Per-panel mode: compile one panel as its own image
                     (written to prompts/<provider>.<PN_ID>.yaml).
  --help             Show this help.

Needs style/style-block.txt and a reference-plan.yaml next to page.yaml
(run build-reference-plan.js first).
Output: prompts/<provider>.yaml next to page.yaml, status "compiled".
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
  return lines.join('\n');
}

/** One legend line per attached image, by position, each with its single role. */
function legendSection(images, entityByAsset, bibles) {
  if (!images.length) {
    return 'REFERENCE IMAGES\nNo reference images are attached.';
  }
  const lines = ['REFERENCE IMAGES', 'Each attached image has one role. Use it for that role only.'];
  for (const att of images) {
    const label = `Image ${att.position}`;
    const entity = entityByAsset.get(att.asset_id) || null;
    const name = entity ? bibles.entityName(entity) : null;
    switch (att.role) {
      case 'edit_target':
        lines.push(`${label}: the rendered page to edit. Keep everything in it that CHANGES does not name.`);
        break;
      case 'style':
        lines.push(`${label}: drawing style only (line, tone, texture, rendering). Do not copy its characters, composition, or text.`);
        break;
      case 'identity':
        lines.push(`${label}: identity of ${name || 'the character'}. Match the face, hair, build, and proportions exactly. Do not copy the sheet's poses, layout, background, or labels.`);
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

/**
 * Select the findings a repair addresses: the open blocking ones, or every
 * open finding when none is blocking.
 */
function selectFindings(review) {
  const open = (Array.isArray(review.findings) ? review.findings : [])
    .filter((f) => f && f.status === 'open');
  const blocking = open.filter((f) => f.severity === 'blocking');
  return blocking.length ? blocking : open;
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
    return `${n ? `Panel ${n}` : 'Whole page'}: ${lang.sentence(f.repair)} Expected result: ${lang.sentence(f.expected)}`;
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
  const planFile = path.join(ws.pageDir(root, page.id), 'reference-plan.yaml');
  const plan = options.plan || ws.loadYaml(planFile);
  if (!plan) {
    throw pipelineError('plan_missing',
      `${page.id}: no reference-plan.yaml next to page.yaml. Run build-reference-plan.js --page <page.yaml> first.`);
  }
  if (plan.page && plan.page !== page.id) {
    throw pipelineError('plan_mismatch', `reference plan is for ${plan.page}, not ${page.id}`);
  }
  if (plan.provider && plan.provider !== providerId) {
    warnings.push(`the reference plan was built for ${plan.provider}; its budget is re-checked against ${providerId}`);
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

function main() {
  helpIfRequested(process.argv.slice(2), HELP);
  const { flags } = parseArgs();
  if (!flags.page || flags.page === true) {
    console.error('error: --page <page.yaml> is required (see --help)');
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
  console.log(`  request endpoint: ${spec.endpoint || '(none: handoff to a person or the harness tool)'}`);
  for (const w of warnings) console.log(`  warning: ${w}`);
}

module.exports = {
  compilePage,
  composePagePrompt,
  composeRepairPrompt,
  composePanelPrompt,
  selectFindings,
  buildRepair,
  resolveReferences,
  letteringElements,
  differenceLine,
};

if (require.main === module) main();
