'use strict';
/**
 * Layout vocabulary: turns page.layout (tiers, reading order) into the
 * sentences the prompt compiler writes about the grid, and tells each panel
 * where it sits. Pure and deterministic.
 *
 * Panels fill the tiers top to bottom in `order`; inside a tier they run in
 * the reading direction, so with `rtl` the first panel of a tier is the
 * rightmost one.
 */

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];

function layoutError(message) {
  const err = new Error(message);
  err.code = 'layout_mismatch';
  return err;
}

/** Panels sorted by their `order` value (stable). */
function orderedPanels(page) {
  const panels = Array.isArray(page && page.panels) ? page.panels.slice() : [];
  return panels
    .map((panel, index) => ({ panel, index }))
    .sort((a, b) => ((a.panel.order || 0) - (b.panel.order || 0)) || (a.index - b.index))
    .map((x) => x.panel);
}

/** Panels in layout.reading_order when it is a valid permutation, else by order. */
function readingSequence(page) {
  const panels = orderedPanels(page);
  const reading = page && page.layout && page.layout.reading_order;
  if (!Array.isArray(reading) || reading.length !== panels.length) return panels;
  const byOrder = new Map(panels.map((p) => [p.order, p]));
  const out = reading.map((o) => byOrder.get(o));
  return out.every(Boolean) && new Set(out).size === panels.length ? out : panels;
}

/** True when the reading sequence differs from plain ascending order. */
function hasCustomReadingOrder(page) {
  const a = orderedPanels(page);
  const b = readingSequence(page);
  return a.some((p, i) => p !== b[i]);
}

function tiersOf(page) {
  const panels = orderedPanels(page);
  const tiers = page && page.layout && page.layout.tiers;
  if (!Array.isArray(tiers) || !tiers.length || tiers.some((n) => !Number.isInteger(n) || n < 1)) {
    throw layoutError(`${(page && page.id) || 'page'}: layout.tiers must list the panels per tier as positive integers`);
  }
  const sum = tiers.reduce((a, b) => a + b, 0);
  if (sum !== panels.length) {
    throw layoutError(`${(page && page.id) || 'page'}: layout.tiers sums to ${sum} but the page has ${panels.length} panel(s)`);
  }
  return tiers;
}

function placementWord(slot, of, direction) {
  if (of === 1) return 'full width';
  const fromLeft = direction === 'rtl' ? of - slot + 1 : slot;
  if (of === 2) return fromLeft === 1 ? 'left' : 'right';
  if (of === 3) return ['left', 'center', 'right'][fromLeft - 1];
  return `${ORDINALS[fromLeft - 1] || `number ${fromLeft}`} from the left of ${of}`;
}

/**
 * Where each panel sits: Map(panel.id -> { tier, tiers, slot, of, placement }).
 * @param {object} page page.yaml document
 * @param {'ltr'|'rtl'} direction project.reading_direction
 */
function panelSlots(page, direction = 'ltr') {
  const tiers = tiersOf(page);
  const panels = orderedPanels(page);
  const slots = new Map();
  let cursor = 0;
  tiers.forEach((count, t) => {
    for (let s = 1; s <= count; s++) {
      const panel = panels[cursor++];
      slots.set(panel.id, {
        tier: t + 1,
        tiers: tiers.length,
        slot: s,
        of: count,
        placement: placementWord(s, count, direction),
      });
    }
  });
  return slots;
}

/** "tier 2 of 3, left" */
function slotPhrase(slot) {
  return `tier ${slot.tier} of ${slot.tiers}, ${slot.placement}`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Sentences that describe the grid, tier by tier, top to bottom. */
function describeGrid(page) {
  const tiers = tiersOf(page);
  const total = tiers.reduce((a, b) => a + b, 0);
  const parts = [`${plural(total, 'panel')} in ${plural(tiers.length, 'tier')}, top to bottom.`];
  tiers.forEach((count, i) => {
    parts.push(count === 1
      ? `Tier ${i + 1}: 1 panel across the full width.`
      : `Tier ${i + 1}: ${count} panels side by side.`);
  });
  const grid = page.layout && page.layout.grid;
  if (grid) parts.push(`Planned grid: ${String(grid).trim()}.`);
  return parts.join(' ');
}

function describeReading(direction) {
  return direction === 'rtl'
    ? 'right to left, top to bottom'
    : 'left to right, top to bottom';
}

function ratioValue(ratio) {
  const m = /^(\d+):(\d+)$/.exec(String(ratio));
  return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : null;
}

/**
 * Width/height of one panel, estimated from the page ratio and the grid:
 * the page is cut into equal tiers and each tier into equal panels.
 */
function estimatePanelRatio(pageRatio, tierCount, panelsInTier) {
  const page = ratioValue(pageRatio);
  if (!page || !tierCount || !panelsInTier) return null;
  return (page * tierCount) / panelsInTier;
}

/** The supported "W:H" closest to a width/height value (first wins on a tie). */
function nearestRatio(value, supported) {
  let best = null;
  let bestDistance = Infinity;
  for (const ratio of supported || []) {
    const v = ratioValue(ratio);
    if (!v) continue;
    const distance = Math.abs(Math.log(v / value));
    if (distance < bestDistance - 1e-9) {
      best = ratio;
      bestDistance = distance;
    }
  }
  return best;
}

module.exports = {
  orderedPanels,
  readingSequence,
  hasCustomReadingOrder,
  panelSlots,
  slotPhrase,
  describeGrid,
  describeReading,
  ratioValue,
  estimatePanelRatio,
  nearestRatio,
};
