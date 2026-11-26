'use strict';
/**
 * Sheet vocabulary: the model-facing text of reference sheets (character
 * turnarounds, expression and wardrobe sheets, location plates, prop
 * sheets, look pages, detail studies). The briefs follow the
 * character-sheet-generation, location-design, and visual-style-development
 * skills: sheet conditions and nothing else, scene lighting only where the
 * place itself is the subject. Pure and deterministic: the same documents
 * always give the same lines.
 */

const lang = require('./panel-language');

const DEFAULT_EXPRESSIONS = ['neutral', 'wary', 'angry', 'afraid', 'in pain', 'relieved'];

const SHEET_CONDITIONS = 'Plain light background with nothing in it. Flat, even light: no cast shadow across the face or the subject, no dramatic or scene lighting.';
const IN_STYLE = 'Drawn in the comic style described above, as a finished drawing in that style. Not a photograph, not a grayscale render, not a 3D model.';
const NO_MARKS = '- No text, labels, arrows, numbers, or color swatches.';
const NO_SIGNATURE = '- No watermark or signature.';

/** Preferred aspect ratios per kind, best first; the page ratio stands in for null. */
const RATIO_PREFERENCE = {
  turnaround: ['1:1', '4:3', '3:2'],
  expressions: ['1:1', '4:3', '3:2'],
  wardrobe: ['1:1', '4:3', '3:4'],
  prop: ['1:1', '4:3', '3:2'],
  detail: ['1:1', '4:3', '3:2'],
  plate: ['3:2', '4:3', '16:9', null, '1:1'],
  look: [null, '2:3', '3:4', '1:1'],
};

const NEGATIVE = {
  sheet: 'watermark, signature, text, labels, arrows, color swatches, scenery, dramatic lighting, photograph',
  plate: 'watermark, signature, text, labels, people, figures, silhouettes',
  look: 'watermark, signature, page number, photograph',
};

/**
 * The aspect ratio of a sheet: the first preferred ratio the provider
 * supports, else the provider's first ratio.
 */
function pickRatio(kind, supported, pageRatio) {
  const list = Array.isArray(supported) ? supported : [];
  for (const wanted of RATIO_PREFERENCE[kind] || ['1:1']) {
    const ratio = wanted === null ? pageRatio : wanted;
    if (ratio && (!list.length || list.includes(ratio))) return ratio;
  }
  return list[0] || '1:1';
}

function negativePrompt(kind, letteringMode) {
  if (kind === 'plate') return NEGATIVE.plate;
  if (kind === 'look') {
    return letteringMode === 'overlay'
      ? `${NEGATIVE.look}, text, lettering, speech balloons, caption boxes`
      : NEGATIVE.look;
  }
  return NEGATIVE.sheet;
}

/** "--expressions a,b" or the default set, cleaned and de-duplicated. */
function expressionList(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(',');
  const list = [...new Set(raw.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  return list.length ? list : DEFAULT_EXPRESSIONS.slice();
}

function gridOf(count) {
  const cols = count <= 4 ? Math.min(count, 2) : 3;
  return { cols, rows: Math.ceil(count / cols) };
}

/**
 * The SHEET section: what kind of drawing this is and how it is laid out.
 * @param {string} kind
 * @param {{name: string, expressions?: string[], subject?: string, time?: string,
 *          format?: string, genre?: string, letteringMode?: string, outfitName?: string}} ctx
 * @returns {string[]} lines
 */
function sheetBrief(kind, ctx) {
  const name = ctx.name;
  switch (kind) {
    case 'turnaround':
      return [
        `Character turnaround sheet of one character: ${name}.`,
        'Four full-figure views of the same person in one row, left to right: front, three-quarter, profile, back.',
        'All four figures at the same scale, heads level, feet on one baseline. Neutral standing pose, arms a little away from the body so the hands, the cuffs, and the silhouette read.',
        'The face is fully readable in the front, three-quarter, and profile views.',
        SHEET_CONDITIONS,
        IN_STYLE,
      ];
    case 'expressions': {
      const list = ctx.expressions || DEFAULT_EXPRESSIONS;
      const grid = gridOf(list.length);
      return [
        `Expression sheet of one character: ${name}.`,
        `${list.length} head-and-shoulders drawings of the same head in a grid of ${grid.cols} column${grid.cols === 1 ? '' : 's'} and ${grid.rows} row${grid.rows === 1 ? '' : 's'}, read left to right, top to bottom: ` +
          `${list.map((e, i) => `${i + 1}. ${e}`).join('; ')}.`,
        'Every head the same size, in the same slight three-quarter view, with the same proportions, hair, and clothing at the neck. Only the expression changes.',
        'Each expression is played with the brows, the eyes, and the mouth, and reads at panel size.',
        SHEET_CONDITIONS,
        IN_STYLE,
      ];
    }
    case 'wardrobe':
      return [
        `Wardrobe sheet: one outfit on one character, ${name}.`,
        'Two full-figure views of the same person side by side: front on the left, back on the right. Same scale, feet on one baseline, neutral standing pose, arms a little away from the body.',
        'Every layer and accessory of the outfit is visible. Sided details stay on the same side of the body in both views.',
        SHEET_CONDITIONS,
        IN_STYLE,
      ];
    case 'plate':
      return [
        `Establishing plate of one location: ${name}.`,
        'One wide view of the whole place, empty: no characters, no figures, no silhouettes.',
        'Seen from the viewpoint of the side convention below, with every landmark visible on its own side and level.',
        `Lit by the location's own light sources as described below${ctx.time ? `, at ${ctx.time}` : ''}. What lies beyond the place is drawn as described, not invented.`,
        IN_STYLE,
      ];
    case 'prop':
      return [
        `Prop sheet of one object: ${name}.`,
        'The object alone, large, in a three-quarter view that shows its whole shape. Add a second, smaller side view when it shows a feature the first view hides.',
        'No hands, no characters, no setting. Both views at one consistent scale.',
        SHEET_CONDITIONS,
        IN_STYLE,
      ];
    case 'look': {
      const lines = [
        'Look page: one sample comic page that demonstrates the drawing style above and nothing else.',
        ctx.format === 'webtoon'
          ? 'One vertical scroll segment of three stacked panels of different heights, each in its own border, separated by gutters.'
          : 'One page of three or four panels of different sizes, each in its own border, separated by gutters.',
        `Content, generic on purpose: one anonymous adult figure who belongs to no story, in a plain everyday setting${ctx.genre ? ` that suits a ${ctx.genre} story` : ''}. ` +
          'One panel shows the figure at full length, one is a close-up on the face and a hand, and one shows the setting with no figure.',
        'The page shows every rule of the style at work: the line weights, the handling of blacks and shadow, the texture, how faces and hands are simplified, the panel borders, and the gutters.',
      ];
      lines.push(ctx.letteringMode === 'overlay'
        ? 'No balloons, captions, or text of any kind: lettering is added afterwards as an overlay.'
        : 'Include one speech balloon and one caption box in the lettering style, with a few short placeholder words. The wording does not matter.');
      return lines;
    }
    case 'detail':
      return [
        `Detail sheet: a close study of one detail of ${name}: ${String(ctx.subject).replace(/\.+$/, '')}.`,
        'The detail drawn large and readable, in one or two views, consistent with the description below.',
        SHEET_CONDITIONS,
        IN_STYLE,
      ];
    default:
      throw new Error(`unknown sheet kind "${kind}"`);
  }
}

/** The HARD CONSTRAINTS lines of a sheet. */
function sheetConstraints(kind, ctx) {
  const name = ctx.name;
  switch (kind) {
    case 'turnaround':
      return [
        `- One character only, ${name}, shown exactly four times: front, three-quarter, profile, back. No other figure.`,
        '- The four views are the same person: same face, hair, build, and clothing.',
        '- Sided details stay on the same side of the body in every view.',
        '- Plain background, flat even light, no cast shadow on the face.',
        NO_MARKS,
        NO_SIGNATURE,
      ];
    case 'expressions': {
      const count = (ctx.expressions || DEFAULT_EXPRESSIONS).length;
      return [
        `- One character only: the head of ${name}, exactly ${count} times. No other figure.`,
        '- Same head size, proportions, and hair in every drawing.',
        '- Plain background, flat even light, no cast shadow on the face.',
        NO_MARKS,
        NO_SIGNATURE,
      ];
    }
    case 'wardrobe':
      return [
        `- One character only, ${name}, shown exactly twice: front and back. No other figure.`,
        '- The same outfit in both views, with every listed layer and accessory.',
        '- Plain background, flat even light.',
        NO_MARKS,
        NO_SIGNATURE,
      ];
    case 'plate':
      return [
        '- No characters, figures, or silhouettes anywhere in the image.',
        '- Every landmark sits on the side and the level stated above.',
        '- One single image of the place: no panels, no insets.',
        '- No text or labels.',
        NO_SIGNATURE,
      ];
    case 'prop':
      return [
        `- One object only, ${name}, shown once or twice. No hands, no figures, no setting.`,
        '- Every distinguishing feature listed above is visible.',
        '- Plain background, flat even light.',
        NO_MARKS,
        NO_SIGNATURE,
      ];
    case 'look':
      return [
        '- One page only, built as described.',
        '- The figure is anonymous: nobody from any story, no recognizable person.',
        ctx.letteringMode === 'overlay'
          ? '- No text anywhere in the image.'
          : '- No text other than the placeholder balloon and caption.',
        '- No watermark, signature, or page number.',
      ];
    case 'detail':
      return [
        '- Only the named detail and what is needed to place it. No scene around it.',
        '- Plain background, flat even light.',
        NO_MARKS,
        NO_SIGNATURE,
      ];
    default:
      throw new Error(`unknown sheet kind "${kind}"`);
  }
}

function labelOf(key) {
  const text = lang.humanize(key);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function valueText(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean).join('; ');
  return String(value).trim();
}

/**
 * "Label: value." lines for every field of a bible `description` block,
 * in file order, except the ones named in `skip`.
 */
function descriptionLines(description, skip = []) {
  const out = [];
  for (const [key, value] of Object.entries(description || {})) {
    if (skip.includes(key) || value === null || value === undefined || typeof value === 'object' && !Array.isArray(value)) continue;
    const text = valueText(value);
    if (text) out.push(`${labelOf(key)}: ${lang.sentence(text)}`);
  }
  return out;
}

function featuresLine(doc) {
  const list = doc && doc.description && Array.isArray(doc.description.distinguishing_features)
    ? doc.description.distinguishing_features.map((f) => String(f).trim()).filter(Boolean) : [];
  return list.length ? `Distinguishing features, all visible: ${list.join('; ')}.` : null;
}

/** Canonical description of a character, from character.yaml. */
function characterSubject(character, name) {
  const lines = [`Name: ${name}.`];
  if (character.prompt_summary) lines.push(`In one line: ${lang.sentence(character.prompt_summary)}`);
  lines.push(...descriptionLines(character.description, ['distinguishing_features']));
  const features = featuresLine(character);
  if (features) lines.push(features);
  return lines;
}

/** The outfit lines, from one entry of wardrobe.yaml. */
function outfitLines(outfit, label = 'Outfit') {
  if (!outfit) return [];
  const lines = [];
  if (outfit.description) lines.push(`${label}: ${lang.sentence(outfit.description)}`);
  if (Array.isArray(outfit.layers) && outfit.layers.length) lines.push(`Layers: ${outfit.layers.join('; ')}.`);
  if (Array.isArray(outfit.accessories) && outfit.accessories.length) lines.push(`Accessories: ${outfit.accessories.join('; ')}.`);
  if (outfit.hands) lines.push(`Hands: ${lang.humanize(outfit.hands)}.`);
  return lines;
}

/** Canonical description of a location, from location.yaml. */
function locationSubject(location, name) {
  const lines = [`Name: ${name}.`];
  if (location.prompt_summary) lines.push(`In one line: ${lang.sentence(location.prompt_summary)}`);
  lines.push(...descriptionLines(location.description));
  return lines;
}

function placeLine(item) {
  const bits = [];
  const where = lang.positionPhrase({ level: item.level, side: item.side });
  if (where) bits.push(`${where}.`);
  if (item.description) bits.push(lang.sentence(item.description));
  return `- ${labelOf(item.id)}: ${bits.join(' ')}`.trimEnd();
}

/** Geography of a location, from map.yaml: sides, levels, landmarks, exits. */
function geographyLines(map) {
  if (!map) return [];
  const lines = [];
  const sides = map.sides || {};
  if (sides.convention) lines.push(`Side convention: ${lang.sentence(sides.convention)}`);
  const fixed = [];
  if (sides.left) fixed.push(`Screen left is the ${lang.humanize(sides.left)}.`);
  if (sides.right) fixed.push(`Screen right is the ${lang.humanize(sides.right)}.`);
  if (fixed.length) lines.push(fixed.join(' '));
  const levels = Array.isArray(map.levels) ? map.levels.filter((l) => l && l.id) : [];
  if (levels.length) {
    lines.push('Levels, bottom to top:');
    levels.forEach((level, i) => {
      lines.push(`${i + 1}. ${labelOf(level.id)}${level.description ? `: ${lang.sentence(level.description)}` : '.'}`);
    });
  }
  const landmarks = Array.isArray(map.landmarks) ? map.landmarks.filter((l) => l && l.id) : [];
  if (landmarks.length) {
    lines.push('Landmarks:');
    for (const landmark of landmarks) lines.push(placeLine(landmark));
  }
  const exits = Array.isArray(map.exits) ? map.exits.filter((e) => e && e.id) : [];
  if (exits.length) {
    lines.push('Exits:');
    for (const exit of exits) lines.push(placeLine(exit));
  }
  const connections = Array.isArray(map.connections) ? map.connections.filter((c) => c && c.from && c.to) : [];
  for (const c of connections) {
    lines.push(`The ${lang.humanize(c.from)} level connects to the ${lang.humanize(c.to)} level${c.via ? ` by the ${lang.humanize(c.via)}` : ''}.`);
  }
  return lines;
}

/** Canonical description of a prop, from prop.yaml. */
function propSubject(prop, name) {
  const lines = [`Name: ${name}.`];
  if (prop.prompt_summary) lines.push(`In one line: ${lang.sentence(prop.prompt_summary)}`);
  lines.push(...descriptionLines(prop.description, ['distinguishing_features']));
  const features = featuresLine(prop);
  if (features) lines.push(features);
  if (prop.hands_required === 1) lines.push('Size: held in one hand.');
  if (prop.hands_required === 2) lines.push('Size: needs both hands.');
  return lines;
}

module.exports = {
  DEFAULT_EXPRESSIONS,
  RATIO_PREFERENCE,
  pickRatio,
  negativePrompt,
  expressionList,
  sheetBrief,
  sheetConstraints,
  descriptionLines,
  characterSubject,
  outfitLines,
  locationSubject,
  geographyLines,
  propSubject,
};
