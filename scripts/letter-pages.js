#!/usr/bin/env node
'use strict';
/**
 * letter-pages.js: build the lettering overlay of one page (overlay mode).
 *
 * Reads page.yaml (the exact text) and lettering.yaml (the geometry) and
 * writes renders/<RENDER_ID>.lettered.svg: the render image with captions,
 * balloons, thoughts, shouts, and sound effects drawn on top.
 *
 * The text always comes from page.yaml. Every lettering.yaml element must
 * carry the same string for the same id; a mismatch, a missing id, or an
 * extra id stops the run before anything is written.
 *
 * Layout is approximate: there is no font file to measure, so line breaks
 * come from a character-width table. Elements whose wrapped text does not fit
 * their box are reported as warnings with the measured overflow.
 *
 * registerLetteredFile() files the PNG or JPEG exported from that SVG: next
 * to the render as <RENDER_ID>.lettered.png, and as lettered_file in the
 * draft editions that ship the render.
 */

const fs = require('fs');
const path = require('path');
const util = require('util');
const { parseArgs, helpIfRequested } = require('./lib/cli');
const { writeFileEnsuring } = require('./lib/fsx');
const yaml = require('./lib/yaml');
const ws = require('./lib/workspace');
const { imageInfo } = require('./lib/image-info');
const svg = require('./lib/svg');

const HELP = `
letter-pages.js: write the lettering overlay SVG for one page (overlay mode).

Usage:
  node scripts/letter-pages.js --page <page.yaml> [--render <RENDER_ID>] [--embed]
  node scripts/letter-pages.js --register-lettered <image> --render <RENDER_ID> (--page <page.yaml> | --root <workspace>)

Options:
  --page <file>      The page.yaml of the page. lettering.yaml is read from
                     the same directory. Required.
  --render <id>      Render to letter (default: lettering.yaml "render", then
                     page.yaml "current_render").
  --embed            Inline the render image as base64 instead of linking it
                     with a relative href.
  --help             Show this help.

Output: renders/<RENDER_ID>.lettered.svg next to the render. The file is
derived from lettering.yaml and is rewritten on every run; the render image
itself is never touched.

The text comes from page.yaml. The run fails when a lettering.yaml element's
text differs from page.yaml, when a page.yaml lettering id has no element, or
when an element has an id that page.yaml does not know.

The layout is approximate. Line breaks and fit warnings come from a
character-width model, not from the real font, so check the result by eye.
SVG is a vector file: to get a PNG for an edition, open it in a browser or a
vector tool and export it at the canvas size.

--register-lettered files that exported image. It is stored next to the render
as <RENDER_ID>.lettered.png (or .jpg) and set as "lettered_file" on the entry
of that render in every draft edition. Reviewed and published editions are
left as they are. The render may be a cover render (CV_###_V##).
`;

const DEFAULT_SHAPE = {
  caption: 'rect',
  narration: 'rect',
  balloon: 'ellipse',
  whisper: 'ellipse',
  radio: 'ellipse',
  shout: 'burst',
  thought: 'cloud',
  sfx: 'none',
  sign: 'none',
};
const SHAPES = ['rect', 'ellipse', 'burst', 'cloud', 'none'];
/** Share of the box a round shape leaves for text (the rest is outline and spikes). */
const INNER_SCALE = { ellipse: 0.94, burst: 0.72, cloud: 0.8 };
const WRAP_FACTORS = [0.92, 0.86, 0.8, 0.74, 0.68, 0.62, 0.56, 0.5, 0.44];

function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** page.yaml lettering as a Map id -> { text, type, speaker, order, panel }. */
function pageLettering(page) {
  const map = new Map();
  const duplicates = [];
  for (const panel of (page && Array.isArray(page.panels) ? page.panels : [])) {
    for (const item of (Array.isArray(panel.lettering) ? panel.lettering : [])) {
      if (!item || !item.id) continue;
      if (map.has(item.id)) duplicates.push(item.id);
      map.set(item.id, {
        text: String(item.text == null ? '' : item.text),
        type: item.type,
        speaker: item.speaker || null,
        order: isNumber(item.order) ? item.order : Infinity,
        panel: panel.id,
      });
    }
  }
  return { map, duplicates };
}

/**
 * Wrap text into a shape and measure how well it fits.
 * @returns {{lines:string[], width:number, height:number, overflowX:number, overflowY:number}}
 */
function fitText(text, box, shape, fontSize, lineHeight) {
  const round = shape === 'ellipse' || shape === 'burst' || shape === 'cloud';
  let best = null;
  const consider = (wrapWidth, maxWidth, availableHeight) => {
    const lines = svg.wrapText(text, wrapWidth, fontSize);
    const block = svg.measureBlock(lines, fontSize, lineHeight);
    const overflowX = Math.max(0, block.width - maxWidth);
    const overflowY = Math.max(0, block.height - availableHeight(block.width));
    const candidate = { lines, width: block.width, height: block.height, overflowX, overflowY };
    if (!best || overflowX + overflowY < best.overflowX + best.overflowY) best = candidate;
    return overflowX + overflowY === 0;
  };

  if (!round) {
    const pad = shape === 'rect' ? fontSize * 0.35 : 0;
    const maxWidth = Math.max(1, box.width - 2 * pad);
    consider(maxWidth, maxWidth, () => Math.max(0, box.height - 2 * pad));
    return best;
  }

  const rx = (box.width / 2) * INNER_SCALE[shape];
  const ry = (box.height / 2) * INNER_SCALE[shape];
  // Height available to a centred block of a given width inside the ellipse.
  const available = (width) => {
    const k = width / (2 * rx);
    return k >= 1 ? 0 : 2 * ry * Math.sqrt(1 - k * k);
  };
  for (const factor of WRAP_FACTORS) {
    if (consider(2 * rx * factor, 2 * rx, available)) break;
  }
  return best;
}

/** Font size that makes sound-effect text fill its box. */
function sfxFontSize(lines, box, lineHeight) {
  let units = 0;
  for (const line of lines) units = Math.max(units, svg.measureText(line, 1));
  // Sound effects are drawn bold with an outline, which runs wider than the model: leave 12%.
  const byWidth = units > 0 ? (box.width * 0.88) / units : box.height;
  const byHeight = box.height / (lines.length * lineHeight);
  return Math.max(4, Math.min(byWidth, byHeight));
}

function fontFamilyAttr(family) {
  const value = String(family || 'sans-serif').trim();
  if (/[,'"]/.test(value)) return value;
  return /\s/.test(value) ? `'${value}', sans-serif` : `${value}, sans-serif`;
}

function applyCase(text, project) {
  const lettering = (project && project.lettering) || {};
  if (lettering.case !== 'upper') return text;
  try {
    return text.toLocaleUpperCase(project.language || undefined);
  } catch (err) {
    return text.toUpperCase();
  }
}

/** SVG markup of one lettering element, plus its fit measurement. */
function drawElement(element, display, font) {
  const { box } = element;
  const shape = element.shape;
  const style = element.style || {};
  const fill = style.fill || '#FFFFFF';
  const stroke = style.stroke || '#000000';
  const textColor = style.text || '#000000';
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const rx = box.width / 2;
  const ry = box.height / 2;
  const strokeWidth = Math.max(1.5, font.size / 11);
  const tail = element.tail && isNumber(element.tail.x) && isNumber(element.tail.y) ? element.tail : null;
  const paint = `fill="${svg.escapeXml(fill)}" stroke="${svg.escapeXml(stroke)}" stroke-width="${svg.fmt(strokeWidth)}" stroke-linejoin="round"`;
  const dash = element.type === 'whisper' ? ` stroke-dasharray="${svg.fmt(strokeWidth * 3)} ${svg.fmt(strokeWidth * 2.5)}"` : '';
  const parts = [];

  if (shape === 'rect') {
    const points = svg.tailPolygon(cx, cy, rx, ry, tail);
    if (points) parts.push(`<polygon points="${points}" ${paint}/>`);
    parts.push(`<rect x="${svg.fmt(box.x)}" y="${svg.fmt(box.y)}" width="${svg.fmt(box.width)}" height="${svg.fmt(box.height)}" ${paint}/>`);
  } else if (shape === 'ellipse') {
    parts.push(`<path d="${svg.balloonPath(cx, cy, rx, ry, tail)}" ${paint}${dash}/>`);
  } else if (shape === 'burst') {
    const points = svg.tailPolygon(cx, cy, rx, ry, tail);
    if (points) parts.push(`<polygon points="${points}" ${paint}/>`);
    parts.push(`<polygon points="${svg.burstPoints(cx, cy, rx, ry)}" ${paint}/>`);
  } else if (shape === 'cloud') {
    for (const bubble of svg.thoughtBubbles(cx, cy, rx, ry, tail)) {
      parts.push(`<circle cx="${svg.fmt(bubble.cx)}" cy="${svg.fmt(bubble.cy)}" r="${svg.fmt(bubble.r)}" ${paint}/>`);
    }
    parts.push(`<path d="${svg.cloudPath(cx, cy, rx, ry)}" ${paint}/>`);
  }

  let fit;
  let size = font.size;
  let extra = '';
  if (element.type === 'sfx') {
    const lines = display.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    size = sfxFontSize(lines.length ? lines : [''], box, font.lineHeight);
    const block = svg.measureBlock(lines, size, font.lineHeight);
    fit = { lines, width: block.width, height: block.height, overflowX: 0, overflowY: 0 };
    extra = ` font-weight="bold" stroke="${svg.escapeXml(fill)}" stroke-width="${svg.fmt(size / 9)}" paint-order="stroke" stroke-linejoin="round"`;
  } else {
    fit = fitText(display, box, shape, size, font.lineHeight);
    if (element.type === 'radio') extra = ' font-style="italic"';
    if (element.type === 'shout') extra = ' font-weight="bold"';
  }

  const lineStep = size * font.lineHeight;
  const top = cy - fit.height / 2;
  const tspans = fit.lines.map((line, i) => {
    // Centre the capitals of each line inside its line box.
    const baseline = top + i * lineStep + (lineStep + size * 0.72) / 2;
    return `<tspan x="${svg.fmt(cx)}" y="${svg.fmt(baseline)}">${svg.escapeXml(line)}</tspan>`;
  });
  parts.push(`<text text-anchor="middle" font-family="${svg.escapeXml(fontFamilyAttr(font.family))}" font-size="${svg.fmt(size)}" fill="${svg.escapeXml(textColor)}"${extra}>${tspans.join('')}</text>`);

  const markup = `  <g id="${svg.escapeXml(element.id)}" data-type="${svg.escapeXml(element.type)}" data-panel="${svg.escapeXml(element.panel || '')}">\n` +
    parts.map((p) => `    ${p}`).join('\n') + '\n  </g>';
  return { markup, fit, fontSize: size };
}

/**
 * Build the lettering overlay of one page.
 *
 * @param {string} pageFile  Path to page.yaml.
 * @param {{render?:string, embed?:boolean, write?:boolean}} [options]
 *   `write: false` builds the SVG without touching the disk.
 * @returns {{ok:boolean, errors:Array<{code:string,message:string}>,
 *   warnings:Array<{code:string,message:string,element?:string,overflow?:{x:number,y:number}}>,
 *   file:string|null, svg:string|null, render:string|null, elements:number}}
 */
function letterPage(pageFile, options = {}) {
  const result = { ok: false, errors: [], warnings: [], file: null, svg: null, render: null, elements: 0 };
  const error = (code, message) => result.errors.push({ code, message });
  const warn = (code, message, more) => result.warnings.push({ code, message, ...(more || {}) });

  const file = path.resolve(String(pageFile || ''));
  if (!pageFile || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    error('page-missing', `page file not found: ${file}`);
    return result;
  }
  const root = ws.findWorkspaceRoot(file);
  if (!root) {
    error('no-workspace', `no project.yaml found above ${file}; a workspace root is the directory that holds project.yaml`);
    return result;
  }
  let project;
  let page;
  let lettering;
  const letteringFile = path.join(path.dirname(file), 'lettering.yaml');
  try {
    project = ws.loadProject(root) || {};
    page = ws.loadYaml(file);
    lettering = ws.loadYaml(letteringFile);
  } catch (err) {
    error('yaml', err.message);
    return result;
  }
  if (!page || typeof page !== 'object') {
    error('page-empty', `${ws.rel(root, file)} is empty`);
    return result;
  }
  if (!lettering || typeof lettering !== 'object') {
    error('lettering-missing', `${ws.rel(root, letteringFile)} not found; overlay lettering needs the geometry file next to page.yaml`);
    return result;
  }
  const mode = project.lettering && project.lettering.mode;
  if (mode && mode !== 'overlay') {
    warn('lettering-mode', `project lettering mode is "${mode}"; this overlay is only part of the pipeline in overlay mode`);
  }
  if (lettering.page && page.id && lettering.page !== page.id) {
    error('page-mismatch', `lettering.yaml is for ${lettering.page}, page.yaml is ${page.id}`);
  }

  // --- text: page.yaml is the authority --------------------------------------
  const { map: canon, duplicates } = pageLettering(page);
  for (const id of duplicates) error('duplicate-id', `page.yaml lists lettering id ${id} more than once`);
  const elements = Array.isArray(lettering.elements) ? lettering.elements.filter((e) => e && typeof e === 'object') : [];
  const seen = new Set();
  for (const element of elements) {
    const id = element.id;
    if (!id) {
      error('element-id', 'lettering.yaml has an element without an id');
      continue;
    }
    if (seen.has(id)) {
      error('duplicate-id', `lettering.yaml lists element ${id} more than once`);
      continue;
    }
    seen.add(id);
    const source = canon.get(id);
    if (!source) {
      error('extra-id', `${id}: lettering.yaml has this element but page.yaml has no lettering with that id`);
      continue;
    }
    const text = String(element.text == null ? '' : element.text);
    if (text !== source.text) {
      error('text-mismatch', `${id}: text differs from page.yaml\n    page.yaml:      ${JSON.stringify(source.text)}\n    lettering.yaml: ${JSON.stringify(text)}`);
    }
    if (element.type && source.type && element.type !== source.type) {
      warn('type-mismatch', `${id}: type "${element.type}" in lettering.yaml, "${source.type}" in page.yaml; drawing it as "${element.type}"`, { element: id });
    }
    if (element.panel && source.panel && element.panel !== source.panel) {
      warn('panel-mismatch', `${id}: lettering.yaml puts it in ${element.panel}, page.yaml in ${source.panel}`, { element: id });
    }
  }
  for (const id of canon.keys()) {
    if (!seen.has(id)) error('missing-id', `${id}: page.yaml has this lettering but lettering.yaml has no element for it`);
  }

  // --- render and canvas ------------------------------------------------------
  const renderId = (options.render && String(options.render)) || lettering.render || page.current_render || null;
  result.render = renderId;
  let renderPath = null;
  if (!renderId) {
    error('render-unknown', 'no render to letter: pass --render, or set "render" in lettering.yaml');
  } else if (!ws.ID.render.test(renderId)) {
    error('render-id', `"${renderId}" is not a render ID (expected PG_###_###_V##)`);
  } else if (page.id && ws.pageOfRender(renderId) !== page.id) {
    error('render-page', `render ${renderId} does not belong to page ${page.id}`);
  } else {
    renderPath = ws.renderFile(root, renderId);
    if (!renderPath) error('render-missing', `render image for ${renderId} not found under ${ws.rel(root, path.join(path.dirname(file), 'renders'))}/`);
    if (lettering.render && lettering.render !== renderId) {
      warn('render-differs', `lettering.yaml was placed on ${lettering.render}; applying it to ${renderId}, so check every position`);
    }
  }

  let renderBytes = null;
  let renderInfo = null;
  if (renderPath) {
    try {
      renderBytes = fs.readFileSync(renderPath);
      renderInfo = imageInfo(renderBytes);
    } catch (err) {
      error('render-unreadable', `${ws.rel(root, renderPath)}: ${err.message}`);
    }
  }

  const declared = lettering.canvas || {};
  const projectPage = project.page || {};
  const canvas = {
    width: isNumber(declared.width_px) ? declared.width_px : (isNumber(projectPage.width_px) ? projectPage.width_px : (renderInfo ? renderInfo.width : null)),
    height: isNumber(declared.height_px) ? declared.height_px : (isNumber(projectPage.height_px) ? projectPage.height_px : (renderInfo ? renderInfo.height : null)),
  };
  if (!(canvas.width > 0) || !(canvas.height > 0)) {
    error('canvas', 'lettering.yaml needs canvas.width_px and canvas.height_px');
  } else if (renderInfo) {
    const drift = Math.abs(renderInfo.width / renderInfo.height - canvas.width / canvas.height) / (canvas.width / canvas.height);
    if (drift > 0.005) {
      warn('canvas-aspect', `render is ${renderInfo.width}x${renderInfo.height}, canvas is ${canvas.width}x${canvas.height}: the aspect ratios differ by ${(drift * 100).toFixed(1)}%, so the image is letterboxed inside the canvas`);
    }
  }

  // --- geometry ---------------------------------------------------------------
  const fontSpec = lettering.font || {};
  const font = {
    family: fontSpec.family || (project.lettering && project.lettering.font_family) || 'sans-serif',
    size: isNumber(fontSpec.size_px) && fontSpec.size_px > 0 ? fontSpec.size_px : Math.max(8, Math.round((canvas.width || 2000) / 60)),
    lineHeight: isNumber(fontSpec.line_height) && fontSpec.line_height > 0 ? fontSpec.line_height : 1.15,
  };
  const drawable = [];
  for (const element of elements) {
    if (!element.id || !canon.has(element.id)) continue;
    const box = element.box || {};
    if (![box.x, box.y, box.width, box.height].every(isNumber) || box.width <= 0 || box.height <= 0) {
      error('box', `${element.id}: box needs numeric x, y and a positive width and height`);
      continue;
    }
    const type = element.type || canon.get(element.id).type;
    let shape = element.shape;
    if (shape == null) shape = DEFAULT_SHAPE[type] || 'rect';
    if (!SHAPES.includes(shape)) {
      error('shape', `${element.id}: unknown shape "${shape}" (use ${SHAPES.join(', ')})`);
      continue;
    }
    if (canvas.width > 0 && canvas.height > 0 &&
        (box.x < 0 || box.y < 0 || box.x + box.width > canvas.width || box.y + box.height > canvas.height)) {
      warn('off-canvas', `${element.id}: box reaches outside the ${canvas.width}x${canvas.height} canvas`, { element: element.id });
    }
    drawable.push({ ...element, type, shape, box, order: canon.get(element.id).order });
  }

  if (result.errors.length) return result;

  drawable.sort((a, b) => (a.order !== b.order ? a.order - b.order : (a.id < b.id ? -1 : 1)));
  const groups = [];
  for (const element of drawable) {
    const display = applyCase(canon.get(element.id).text, project);
    const drawn = drawElement(element, display, font);
    groups.push(drawn.markup);
    const { overflowX, overflowY, lines, width, height } = drawn.fit;
    if (overflowX > 0.5 || overflowY > 0.5) {
      warn('overflow',
        `${element.id} (${element.panel || 'no panel'}, ${element.type}): text does not fit its ${element.shape === 'none' ? 'box' : element.shape}: ` +
        `over by ${Math.ceil(overflowX)}px in width and ${Math.ceil(overflowY)}px in height ` +
        `(${lines.length} line${lines.length === 1 ? '' : 's'}, about ${Math.round(width)}x${Math.round(height)}px of text in a ${Math.round(element.box.width)}x${Math.round(element.box.height)}px box)`,
        { element: element.id, overflow: { x: Math.ceil(overflowX), y: Math.ceil(overflowY) } });
    }
    if (element.tail && element.shape !== 'none' &&
        !svg.outsideEllipse(element.box.x + element.box.width / 2, element.box.y + element.box.height / 2, element.box.width / 2, element.box.height / 2, element.tail)) {
      warn('tail-inside', `${element.id}: the tail tip lies inside the balloon, so no tail is drawn`, { element: element.id });
    }
  }
  if (!drawable.length) warn('no-elements', 'the page has no lettering; the overlay holds only the render image');

  const outFile = path.join(path.dirname(renderPath), `${renderId}.lettered.svg`);
  const href = options.embed
    ? `data:${renderInfo.mime};base64,${renderBytes.toString('base64')}`
    : path.relative(path.dirname(outFile), renderPath).split(path.sep).join('/');
  const title = `${page.id || ''} lettering overlay on ${renderId}`.trim();
  const doc = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${svg.fmt(canvas.width)}" height="${svg.fmt(canvas.height)}" viewBox="0 0 ${svg.fmt(canvas.width)} ${svg.fmt(canvas.height)}">`,
    `  <title>${svg.escapeXml(title)}</title>`,
    `  <image x="0" y="0" width="${svg.fmt(canvas.width)}" height="${svg.fmt(canvas.height)}" href="${svg.escapeXml(href)}" xlink:href="${svg.escapeXml(href)}"/>`,
    ...groups,
    '</svg>',
    '',
  ].join('\n');

  result.svg = doc;
  result.file = outFile;
  result.elements = drawable.length;
  if (options.write !== false) writeFileEnsuring(outFile, doc);
  result.ok = true;
  return result;
}

/**
 * New text of an edition.yaml after `lettered_file` changed on the entry
 * that ships `renderId` (a page entry, or the cover). Only that line is
 * edited or added, and the result is accepted only when it parses to exactly
 * the intended document; otherwise the document goes through the YAML
 * library and its comments are lost.
 * @returns {{text: string, preserved: boolean}}
 */
function letteredEditionText(originalText, edition, renderId, relPath) {
  try {
    const lines = String(originalText).split(/\r?\n/);
    const at = lines.findIndex((line) => new RegExp(`^\\s*(?:-\\s+)?render:\\s*["']?${renderId}["']?\\s*(#.*)?$`).test(line));
    if (at !== -1) {
      // Keys of the entry sit at the column of "render" (after "- " on the first line of a list item).
      const column = lines[at].indexOf('render:');
      const isKeyLine = (line) => line.length - line.trimStart().length === column && !line.trimStart().startsWith('-');
      let start = at;
      while (start > 0 && isKeyLine(lines[start - 1])) start--;
      if (start > 0 && lines[start - 1].indexOf('- ') === column - 2 && lines[start - 1].trim().startsWith('- ')) start--;
      let end = at + 1;
      while (end < lines.length && isKeyLine(lines[end])) end++;
      const value = yaml.stringify({ k: relPath }).slice(3).trimEnd();
      let found = -1;
      for (let i = start; i < end; i++) {
        if (/^\s*(?:-\s+)?lettered_file:/.test(lines[i])) found = i;
      }
      if (found !== -1) {
        const comment = /\s(#.*)$/.exec(lines[found]);
        lines[found] = lines[found].replace(/^(\s*(?:-\s+)?lettered_file:).*$/, `$1 ${value}${comment ? `  ${comment[1]}` : ''}`);
      } else {
        lines.splice(end, 0, `${' '.repeat(column)}lettered_file: ${value}`);
      }
      const text = `${lines.join('\n').trimEnd()}\n`;
      if (util.isDeepStrictEqual(yaml.parse(text), edition)) return { text, preserved: true };
    }
  } catch (err) {
    // Fall through to the full rewrite.
  }
  return { text: yaml.stringify(edition), preserved: false };
}

/**
 * Store a rasterized lettered page and record it.
 *
 * In overlay mode the lettered page is the render with the overlay
 * flattened onto it. A browser or a vector tool produces that image from the
 * SVG; this function files it where the data model expects it:
 * `<RENDER_ID>.lettered.png` (or `.jpg`) next to the render, and as
 * `lettered_file` on the entry that ships that render in every draft
 * edition. An edition that is reviewed or published is left as it is: its
 * files are what readers hold, and a correction is a new edition.
 * draftEdition() in build-edition.js picks the stored file up for editions
 * composed later. The same call works for a cover render.
 *
 * The render itself is never touched. A lettered file is derived, so storing
 * it again replaces the earlier one, unless a reviewed or published edition
 * ships that file.
 *
 * @param {{root: string, page?: string, render?: string, file: string|Buffer}} options
 *   `page` is the page ID (or the cover ID). `render` defaults to the page's
 *   current_render. `file` is the path of the image, or its bytes: PNG or JPEG.
 * @returns {{path: string, render: string, editions: string[], skipped: string[]}}
 *   `path` is workspace-relative. `editions` lists the draft editions whose
 *   entry was updated; `skipped` the reviewed or published ones that list
 *   the render and were left alone.
 * @throws an Error with `code` when the render or the image is missing or unusable
 */
function registerLetteredFile(options = {}) {
  const fail = (code, message) => Object.assign(new Error(message), { code });
  const root = options.root ? path.resolve(String(options.root)) : null;
  if (!root || !fs.existsSync(path.join(root, 'project.yaml'))) {
    throw fail('no-workspace', `registerLetteredFile needs the workspace root (the directory that holds project.yaml), got "${options.root}"`);
  }
  let renderId = options.render ? String(options.render) : null;
  const owner = options.page ? String(options.page) : null;
  if (!renderId && owner && ws.ID.page.test(owner)) {
    const page = ws.loadPage(root, owner);
    renderId = page && page.current_render ? String(page.current_render) : null;
    if (!renderId) throw fail('render-unknown', `${owner} has no current_render: pass the render the lettered image was made from`);
  }
  const ownerOfRender = renderId ? (ws.pageOfRender(renderId) || ws.coverOfRender(renderId)) : null;
  if (!ownerOfRender) {
    throw fail('render-id', `"${renderId}" is not a render ID (expected PG_###_###_V## or CV_###_V##)`);
  }
  if (owner && owner !== ownerOfRender) {
    throw fail('render-page', `render ${renderId} does not belong to ${owner}`);
  }
  const renderPath = ws.renderFile(root, renderId);
  if (!renderPath) throw fail('render-missing', `render image for ${renderId} not found in the workspace`);

  let data;
  if (Buffer.isBuffer(options.file)) {
    data = options.file;
  } else if (typeof options.file === 'string' && options.file) {
    const source = path.resolve(options.file);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw fail('file-missing', `lettered image not found: ${source}`);
    data = fs.readFileSync(source);
  } else {
    throw fail('file-missing', 'registerLetteredFile needs "file": the path of the lettered image, or its bytes');
  }
  let info;
  try {
    info = imageInfo(data);
  } catch (err) {
    throw fail('file-format', `the lettered image is not a PNG or JPEG (${err.message}); export the SVG overlay to an image first`);
  }
  if (info.format !== 'png' && info.format !== 'jpeg') {
    throw fail('file-format', `the lettered image is ${info.format.toUpperCase()}; an edition takes a lettered PNG or JPEG`);
  }

  const dir = path.dirname(renderPath);
  const target = path.join(dir, `${renderId}.lettered.${info.ext}`);
  const rel = ws.rel(root, target);
  const siblings = ['png', 'jpg', 'jpeg'].map((ext) => path.join(dir, `${renderId}.lettered.${ext}`));

  // Editions that ship this render: drafts are updated, the others protect their file.
  const listing = [];
  for (const editionId of ws.listEditions(root)) {
    const file = path.join(root, 'editions', editionId, 'edition.yaml');
    let edition = null;
    try {
      edition = ws.loadYaml(file);
    } catch (err) {
      edition = null;
    }
    if (!edition || typeof edition !== 'object') continue;
    const entries = (Array.isArray(edition.pages) ? edition.pages : []).concat(edition.cover ? [edition.cover] : []);
    const entry = entries.find((e) => e && e.render === renderId);
    if (entry) listing.push({ editionId, file, edition, entry });
  }
  const locked = listing.filter((l) => l.edition.status !== 'draft');
  for (const l of locked) {
    const shipped = l.entry.lettered_file ? path.resolve(ws.abs(root, String(l.entry.lettered_file))) : null;
    if (shipped && siblings.some((s) => path.resolve(s) === shipped) && fs.existsSync(shipped)) {
      throw fail('lettered-file-shipped',
        `${ws.rel(root, shipped)} ships in ${l.editionId}, which is ${l.edition.status}; a lettered file that readers hold is not replaced. ` +
        'Letter a new render version, or correct the edition with a new edition ID.');
    }
  }

  writeFileEnsuring(target, data);
  // One lettered file per render: an earlier one in the other format would be ambiguous.
  for (const other of siblings) {
    if (path.resolve(other) !== path.resolve(target) && fs.existsSync(other)) fs.rmSync(other);
  }

  const editions = [];
  for (const l of listing.filter((x) => x.edition.status === 'draft')) {
    if (l.entry.lettered_file === rel) {
      editions.push(l.editionId);
      continue;
    }
    l.entry.lettered_file = rel;
    const updated = letteredEditionText(fs.readFileSync(l.file, 'utf8'), l.edition, renderId, rel);
    writeFileEnsuring(l.file, updated.text);
    editions.push(l.editionId);
  }
  return { path: rel, render: renderId, editions, skipped: locked.map((l) => l.editionId) };
}

function main() {
  const argv = process.argv.slice(2);
  helpIfRequested(argv, HELP);
  const { flags } = parseArgs(argv);
  if (flags['register-lettered'] !== undefined) {
    const source = flags['register-lettered'];
    const start = flags.page && flags.page !== true ? path.resolve(String(flags.page)) : process.cwd();
    const root = flags.root && flags.root !== true ? path.resolve(String(flags.root)) : ws.findWorkspaceRoot(start);
    if (source === true || !root || !flags.render || flags.render === true) {
      console.error('error: --register-lettered <image> needs --render <RENDER_ID> and a workspace (--root <dir>, or --page <page.yaml>)');
      process.exit(1);
    }
    const stored = registerLetteredFile({ root, render: String(flags.render), file: String(source) });
    console.log(`letter-pages: stored ${stored.path}`);
    for (const id of stored.editions) console.log(`  ${id}: lettered_file set for ${stored.render}`);
    for (const id of stored.skipped) console.log(`  ${id}: not a draft, left as it is`);
    return;
  }
  if (!flags.page || flags.page === true) {
    console.error('error: --page <page.yaml> is required (see --help)');
    process.exit(1);
  }
  const result = letterPage(String(flags.page), {
    render: flags.render && flags.render !== true ? String(flags.render) : undefined,
    embed: flags.embed === true,
  });
  for (const w of result.warnings) console.warn(`warning: ${w.message}`);
  for (const e of result.errors) console.error(`error: ${e.message}`);
  if (!result.ok) {
    console.error(`letter-pages: nothing written (${result.errors.length} error${result.errors.length === 1 ? '' : 's'})`);
    process.exit(1);
  }
  const root = ws.findWorkspaceRoot(result.file);
  const overflow = result.warnings.filter((w) => w.code === 'overflow').length;
  console.log(`letter-pages: wrote ${root ? ws.rel(root, result.file) : result.file}`);
  console.log(`  ${result.elements} element${result.elements === 1 ? '' : 's'} on ${result.render}, ${overflow} that may not fit`);
  console.log('  Layout is approximate. Open the SVG in a browser or a vector tool to check it and to export a PNG.');
}

module.exports = { letterPage, registerLetteredFile, fitText, pageLettering, DEFAULT_SHAPE };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`letter-pages: ${err.message}`);
    process.exit(1);
  }
}
