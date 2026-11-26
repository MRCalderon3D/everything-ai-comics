'use strict';
/**
 * Panel vocabulary: turns the enums of page.yaml (framing, panel size,
 * facing, position, lettering type, state tags) into the phrases the prompt
 * compiler writes. Pure and deterministic; unknown values fall back to the
 * enum with underscores replaced, so a new enum value still compiles.
 */

const SHOT_SIZE = {
  extreme_wide: 'extreme wide shot, figures small inside the setting',
  wide: 'wide shot that shows the whole setting',
  full: 'full shot, figures head to toe',
  medium_wide: 'medium wide shot, figures from the knees up',
  medium: 'medium shot, figures from the waist up',
  medium_close_up: 'medium close-up, head and chest',
  close_up: 'close-up on the face',
  extreme_close_up: 'extreme close-up on one detail',
  insert: 'insert on an object or detail',
  over_the_shoulder: 'over-the-shoulder view, past the near figure toward the far one',
};

const ANGLE = {
  eye_level: 'eye level',
  high_angle: 'seen from above (high angle)',
  low_angle: 'seen from below (low angle)',
  overhead: 'seen from directly overhead',
  worms_eye: 'seen from ground level looking up',
  dutch: 'tilted horizon',
};

const VIEW = {
  front: 'subject seen from the front',
  three_quarter: 'subject in three-quarter view',
  profile: 'subject in profile',
  three_quarter_back: 'subject in three-quarter back view',
  back: 'subject seen from behind',
};

const PANEL_SIZE = {
  splash: 'splash panel that fills the page',
  wide: 'wide panel',
  large: 'large panel',
  medium: 'medium panel',
  small: 'small panel',
  inset: 'small inset panel set inside a larger one',
};

const FACING = {
  left: 'screen left',
  right: 'screen right',
  toward_reader: 'toward the reader',
  away_from_reader: 'away from the reader',
};

const SIDE = {
  left: 'screen left',
  right: 'screen right',
  center: 'center of the frame',
};

const LETTERING_TYPE = {
  caption: 'caption box',
  narration: 'narration box',
  balloon: 'speech balloon',
  thought: 'thought balloon',
  whisper: 'whisper balloon with a dashed outline',
  shout: 'shout balloon with a jagged outline',
  radio: 'radio balloon with a jagged tail',
  sfx: 'sound effect lettered into the art',
  sign: 'sign text that exists in the scene',
};

/** Lettering types that have a speaker whose balloon tail must point at them. */
const SPOKEN_TYPES = ['balloon', 'thought', 'whisper', 'shout', 'radio'];

function humanize(token) {
  return String(token === null || token === undefined ? '' : token).replace(/_/g, ' ').trim();
}

function lookup(table, value) {
  if (value === null || value === undefined || value === '') return null;
  return table[value] || humanize(value);
}

/** "extreme wide shot, ..., seen from above (high angle), subject in three-quarter view" */
function framingPhrase(framing) {
  const f = framing || {};
  return [lookup(SHOT_SIZE, f.shot_size), lookup(ANGLE, f.angle), lookup(VIEW, f.view)]
    .filter(Boolean).join('; ');
}

function panelSizePhrase(size) {
  return lookup(PANEL_SIZE, size) || 'panel';
}

function facingPhrase(facing) {
  return lookup(FACING, facing);
}

/**
 * "on the wheelhouse level, screen right, at the ladder".
 * @param {{level?: string, side?: string, landmark?: string}} position
 */
function positionPhrase(position) {
  const p = position || {};
  const bits = [];
  if (p.level) bits.push(`on the ${humanize(p.level)} level`);
  if (p.side) bits.push(lookup(SIDE, p.side));
  if (p.landmark) bits.push(`at the ${humanize(p.landmark)}`);
  return bits.join(', ');
}

/** ["cut_left_hand", "soaked"] -> "cut left hand, soaked"; [] -> null. */
function statePhrase(tags) {
  const list = (Array.isArray(tags) ? tags : []).map(humanize).filter(Boolean);
  return list.length ? list.join(', ') : null;
}

function letteringTypePhrase(type) {
  return lookup(LETTERING_TYPE, type) || 'lettering';
}

function isSpoken(type) {
  return SPOKEN_TYPES.includes(type);
}

/** Text with exactly one terminal period (keeps ?, !, and closing quotes). */
function sentence(text) {
  const t = String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return /[.!?…]["')\]]?$/.test(t) ? t : `${t}.`;
}

module.exports = {
  SHOT_SIZE,
  ANGLE,
  VIEW,
  PANEL_SIZE,
  FACING,
  SIDE,
  LETTERING_TYPE,
  SPOKEN_TYPES,
  humanize,
  framingPhrase,
  panelSizePhrase,
  facingPhrase,
  positionPhrase,
  statePhrase,
  letteringTypePhrase,
  isSpoken,
  sentence,
};
