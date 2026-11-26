#!/usr/bin/env node
'use strict';
/**
 * build-edition.js: assemble an edition and export it as PDF, CBZ, a web
 * reader, a folder of numbered images, and an EPUB.
 *
 * Reads editions/<ED_ID>/edition.yaml, which lists the exact render of every
 * page and, optionally, of the cover, and enforces the edition rules of
 * docs/data-model.md:
 *   - every listed render has a visual review with verdict pass or fixed
 *     (otherwise the build refuses, unless --draft, which marks every export)
 *   - pages are listed once each, in page-number order, with no gaps
 *   - an export file that already exists is never overwritten (unless --force)
 *
 * When the edition names a cover, the cover is the first page of every
 * format. A page or cover with a lettered_file ships that file.
 *
 * draftEdition() composes an edition document from the current state of an
 * issue without writing anything.
 *
 * This script checks files and review verdicts. It does not look at the
 * artwork: a passing build means the listed renders were reviewed, and the
 * closing line says which renders shipped and with which verdict.
 */

const fs = require('fs');
const path = require('path');
const util = require('util');
const { parseArgs, helpIfRequested } = require('./lib/cli');
const { writeFileEnsuring } = require('./lib/fsx');
const yaml = require('./lib/yaml');
const ws = require('./lib/workspace');
const { imageInfo } = require('./lib/image-info');
const { createZip } = require('./lib/zip');
const { buildPdf } = require('./lib/pdf');
const { buildEpub, uuidFrom } = require('./lib/epub');
const { escapeXml } = require('./lib/svg');

const FORMATS = ['pdf', 'cbz', 'web', 'images', 'epub'];
const DEFAULT_FORMATS = ['pdf', 'cbz'];
/** Aspect ratios closer than this are treated as equal (pixel rounding). */
const ASPECT_SAME = 0.002;
/** Up to this relative difference the build warns; beyond it, it stops. */
const ASPECT_TOLERANCE = 0.02;

const HELP = `
build-edition.js: export an edition as PDF, CBZ, a web reader, numbered
images, and EPUB.

Usage:
  node scripts/build-edition.js --edition <edition.yaml> [--formats pdf,cbz,web,images,epub] [--draft] [--force]

Options:
  --edition <file>   The edition.yaml to build (editions/<ED_ID>/edition.yaml). Required.
  --formats <list>   Comma-separated: pdf, cbz, web, images, epub. Default: the
                     pdf, cbz, web, images and epub targets of project.yaml
                     "deliverables", else pdf,cbz.
  --draft            Build even when a listed render has no passing review.
                     Every export gets -DRAFT in its name, the PDF is stamped
                     on every page, and the web reader shows a draft banner.
  --force            Overwrite existing exports. Draft editions only.
  --help             Show this help.

Checks before anything is written:
  - every page has "page", "render" and "file", and the file exists; the
    same for "cover" when the edition names one
  - every render has a review with verdict pass or fixed (skipped by --draft,
    which still prints each verdict)
  - pages are listed once each, in page-number order, starting at 1, no gaps
  - all pages share one aspect ratio: a small difference is a warning, a
    larger one stops the build (webtoon projects only compare widths, and
    leave the cover out of the comparison)

Output, under editions/<ED_ID>/exports/:
  <title>-<issue>-ed<edition>[-DRAFT].pdf      one page image per PDF page
  <title>-<issue>-ed<edition>[-DRAFT].cbz      001.png, 002.png ... plus ComicInfo.xml
  <title>-<issue>-ed<edition>[-DRAFT]-web/     index.html reader plus pages/
  <title>-<issue>-ed<edition>[-DRAFT]-images/  001.png, 002.png ..., and the
  <title>-<issue>-ed<edition>[-DRAFT]-images.zip with the same files
  <title>-<issue>-ed<edition>[-DRAFT].epub     EPUB 3, fixed layout, one image per page

When the edition has a "cover", the cover is the first page of every format:
000-cover.<ext> in the CBZ, the web reader, the images and the EPUB, marked
FrontCover in ComicInfo.xml and cover-image in the EPUB.

"lettered_file" replaces "file" when it is set, for a page and for the cover.
It must be a PNG or JPEG: an overlay SVG from letter-pages.js has to be
exported to an image first.

An existing export is skipped, not overwritten. --force replaces it only while
the edition has status "draft" (or the build is --draft); a reviewed or
published edition is corrected with a new edition ID.

After a successful build the "exports" list in edition.yaml is updated
(format, file, built_at). Only the exports block is replaced, so comments and
formatting elsewhere in the file stay as they are; comments inside the old
exports block go with it. If the block cannot be replaced safely, the whole
file is rewritten through the YAML library instead: keys, values, and order
are kept, but comments and hand formatting in edition.yaml are lost, and the
script says so.
`;

function slugify(text) {
  const slug = String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'edition';
}

/** "PG_001_004" -> 4. */
function pageNumberOfId(pageId) {
  const m = /^PG_\d{3}_(\d{3})$/.exec(String(pageId));
  return m ? Number(m[1]) : null;
}

function isInside(root, file) {
  const relative = path.relative(root, file);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Formats to build: --formats, else the project's deliverables, else pdf + cbz. */
function resolveFormats(requested, project) {
  if (requested) {
    const list = String(requested).split(',').map((f) => f.trim().toLowerCase()).filter(Boolean);
    const unknown = list.filter((f) => !FORMATS.includes(f));
    if (unknown.length) throw new Error(`unknown format "${unknown.join('", "')}" (use ${FORMATS.join(', ')})`);
    if (!list.length) throw new Error('--formats needs at least one of ' + FORMATS.join(', '));
    return FORMATS.filter((f) => list.includes(f));
  }
  const targets = (project && Array.isArray(project.deliverables) ? project.deliverables : [])
    .map((d) => d && d.target)
    .filter((t) => FORMATS.includes(t));
  return targets.length ? FORMATS.filter((f) => targets.includes(f)) : DEFAULT_FORMATS.slice();
}

/** ComicInfo.xml (ComicRack schema) for the CBZ. Elements follow the schema's order. */
function comicInfoXml(meta) {
  const lines = ['<?xml version="1.0" encoding="utf-8"?>',
    '<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'];
  const add = (tag, value) => {
    if (value !== null && value !== undefined && value !== '') lines.push(`  <${tag}>${escapeXml(value)}</${tag}>`);
  };
  add('Title', meta.title);
  add('Series', meta.series);
  add('Number', meta.number);
  add('Summary', meta.summary);
  add('Notes', meta.notes);
  add('Genre', meta.genre);
  add('PageCount', meta.pages.length);
  add('LanguageISO', meta.language);
  add('BlackAndWhite', meta.blackAndWhite);
  add('Manga', meta.readingDirection === 'rtl' ? 'YesAndRightToLeft' : 'No');
  lines.push('  <Pages>');
  meta.pages.forEach((page, index) => {
    lines.push(`    <Page Image="${index}"${page.type ? ` Type="${escapeXml(page.type)}"` : ''} ImageSize="${page.size}" ImageWidth="${page.width}" ImageHeight="${page.height}" />`);
  });
  lines.push('  </Pages>', '</ComicInfo>', '');
  return lines.join('\n');
}

/** index.html of the web reader. Plain HTML and CSS; a short script adds paging. */
function webReaderHtml(meta) {
  const rtl = meta.readingDirection === 'rtl';
  const webtoon = meta.comicFormat === 'webtoon';
  const images = meta.pages.map((page, index) =>
    `  <img class="page" id="p${index + 1}" src="${escapeXml(page.src)}" alt="${escapeXml(page.label || `Page ${index + 1}`)}" width="${page.width}" height="${page.height}"${index > 1 ? ' loading="lazy"' : ''}>`
  ).join('\n');
  const draft = meta.draft ? `\n<div class="draft" role="note">${escapeXml(meta.draftNote || 'DRAFT')}</div>` : '';
  return `<!DOCTYPE html>
<html lang="${escapeXml(meta.language || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(meta.title)}${meta.draft ? ' (DRAFT)' : ''}</title>
<style>
  html, body { margin: 0; background: #111; color: #ddd; font: 14px/1.4 system-ui, sans-serif; }
  header { display: flex; gap: 12px; align-items: center; height: 48px; box-sizing: border-box; padding: 0 14px; background: #1b1b1b; position: sticky; top: 0; z-index: 2; }
  header h1 { font-size: 14px; font-weight: 600; margin: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header button { background: #333; color: #eee; border: 0; border-radius: 4px; padding: 6px 12px; font: inherit; cursor: pointer; }
  header button:disabled { opacity: .35; cursor: default; }
  #controls { display: none; gap: 8px; align-items: center; }
  .paged #controls { display: flex; }
  .page { display: block; margin: 0 auto 16px; max-width: 100%; height: auto; }
  .webtoon .page { margin: 0 auto; width: 100%; max-width: 800px; }
  .paged #reader { height: calc(100vh - 48px); display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .paged .page { display: none; margin: 0; max-width: 100vw; max-height: calc(100vh - 48px); width: auto; object-fit: contain; }
  .paged .page.current { display: block; }
  .draft { position: fixed; right: 0; bottom: 0; z-index: 3; background: #b3261e; color: #fff; padding: 6px 12px; font-weight: 600; }
</style>
</head>
<body class="${webtoon ? 'webtoon' : 'pages'}" data-direction="${rtl ? 'rtl' : 'ltr'}">
<header>
  <h1>${escapeXml(meta.title)}</h1>
  <div id="controls">
    <button type="button" id="prev">Previous</button>
    <span id="position"></span>
    <button type="button" id="next">Next</button>
  </div>
</header>
<main id="reader">
${images}
</main>${draft}
<script>
(function () {
  var body = document.body;
  if (body.className.indexOf('webtoon') !== -1) return; // continuous scroll: the browser handles it
  var rtl = body.getAttribute('data-direction') === 'rtl';
  var pages = Array.prototype.slice.call(document.querySelectorAll('.page'));
  var reader = document.getElementById('reader');
  var prev = document.getElementById('prev');
  var next = document.getElementById('next');
  var position = document.getElementById('position');
  var current = 0;
  function show(index) {
    current = Math.max(0, Math.min(pages.length - 1, index));
    pages.forEach(function (img, i) {
      img.className = i === current ? 'page current' : 'page';
      if (Math.abs(i - current) <= 1) img.loading = 'eager';
    });
    position.textContent = (current + 1) + ' / ' + pages.length;
    prev.disabled = current === 0;
    next.disabled = current === pages.length - 1;
    if (history.replaceState) history.replaceState(null, '', '#p' + (current + 1));
  }
  function fromHash() {
    var m = /^#p(\\d+)$/.exec(location.hash);
    return m ? Number(m[1]) - 1 : 0;
  }
  body.className += ' paged';
  prev.onclick = function () { show(current - 1); };
  next.onclick = function () { show(current + 1); };
  // Clicking the side the story reads toward goes forward.
  reader.onclick = function (event) {
    var rightHalf = event.clientX > window.innerWidth / 2;
    show(current + (rightHalf !== rtl ? 1 : -1));
  };
  document.addEventListener('keydown', function (event) {
    var key = event.key;
    if (key === 'ArrowRight') show(current + (rtl ? -1 : 1));
    else if (key === 'ArrowLeft') show(current + (rtl ? 1 : -1));
    else if (key === ' ' || key === 'PageDown' || key === 'ArrowDown') show(current + 1);
    else if (key === 'PageUp' || key === 'ArrowUp') show(current - 1);
    else if (key === 'Home') show(0);
    else if (key === 'End') show(pages.length - 1);
    else return;
    event.preventDefault();
  });
  window.addEventListener('hashchange', function () { show(fromHash()); });
  show(fromHash());
})();
</script>
</body>
</html>
`;
}

/**
 * New text of edition.yaml after its exports changed.
 *
 * Replaces only the top-level "exports" block in the original text, which
 * keeps comments and formatting everywhere else, and accepts the result only
 * when it parses back to exactly the intended document. Otherwise the whole
 * document goes through the YAML library and its comments are lost.
 * @returns {{text:string, preserved:boolean}}
 */
function editionText(originalText, edition) {
  try {
    const lines = String(originalText).split(/\r?\n/);
    const block = yaml.stringify({ exports: edition.exports }).trimEnd().split('\n');
    const start = lines.findIndex((line) => /^exports:(\s|$)/.test(line));
    let next;
    if (start === -1) {
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
      next = [...lines, ...block];
    } else {
      // The block runs to the next top-level key; blank lines and comments right before that key stay.
      let end = start + 1;
      while (end < lines.length && (lines[end].trim() === '' || /^[\s#-]/.test(lines[end]))) end++;
      while (end > start + 1 && (lines[end - 1].trim() === '' || lines[end - 1].startsWith('#'))) end--;
      next = [...lines.slice(0, start), ...block, ...lines.slice(end)];
    }
    const text = `${next.join('\n').trimEnd()}\n`;
    if (util.isDeepStrictEqual(yaml.parse(text), edition)) return { text, preserved: true };
  } catch (err) {
    // Fall through to the full rewrite.
  }
  return { text: yaml.stringify(edition), preserved: false };
}

/**
 * The file one edition entry ships (a page or the cover): lettered_file when
 * set, else file. Checks that it is the listed render's own file, reads it,
 * and looks up the render's review. Reports through `error` and returns null
 * when the file cannot ship.
 * @returns {{relFile:string, file:string, data:Buffer, info:object, verdict:string, passes:boolean}|null}
 */
function shippedFile(root, label, renderId, entry, error, warn) {
  const lettered = entry.lettered_file ? String(entry.lettered_file) : null;
  const relFile = (lettered || String(entry.file)).replace(/\\/g, '/');
  const file = path.resolve(ws.abs(root, relFile));
  const baseName = path.basename(relFile);
  const stem = baseName.slice(0, baseName.length - path.extname(baseName).length);
  if (!isInside(root, file)) {
    error('file-outside', `${label}: ${relFile} points outside the workspace`, { page: label });
    return null;
  }
  if (lettered ? !baseName.startsWith(renderId) : stem !== renderId) {
    error('file-render', `${label}: ${relFile} is not the file of render ${renderId}; the review covers the render, so the two must match`, { page: label });
    return null;
  }
  if (/\.svg$/i.test(relFile)) {
    error('file-svg', `${label}: ${relFile} is an SVG overlay; export it to PNG or JPEG (browser or vector tool) and list that image as lettered_file`, { page: label });
    return null;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    error('file-missing', `${label}: image not found: ${relFile}`, { page: label });
    return null;
  }
  let info;
  let data;
  try {
    data = fs.readFileSync(file);
    info = imageInfo(data);
  } catch (err) {
    error('file-unreadable', `${label}: ${relFile}: ${err.message}`, { page: label });
    return null;
  }

  let review = null;
  try {
    review = ws.loadReview(root, renderId);
  } catch (err) {
    error('yaml', err.message, { page: label });
  }
  if (review && review.render && review.render !== renderId) {
    warn('review-render', `${label}: the review file of ${renderId} says it reviews ${review.render}`, { page: label });
  }
  const verdict = review ? String(review.verdict || 'no verdict') : 'no review';
  return { relFile, file, data, info, verdict, passes: ws.reviewPasses(review) };
}

/**
 * Check an edition against the edition rules and collect what is needed to
 * export it: the pages in order, with the cover first when the edition
 * names one (its entry carries `cover: true`). Writes nothing.
 */
function inspectEdition(root, edition, project, options, result) {
  const error = (code, message, more) => result.errors.push({ code, message, ...(more || {}) });
  const warn = (code, message, more) => result.warnings.push({ code, message, ...(more || {}) });

  if (!ws.ID.edition.test(String(edition.id || ''))) {
    error('edition-id', `edition id "${edition.id}" is not an edition ID (expected ED_###_##)`);
  }
  if (!ws.ID.issue.test(String(edition.issue || ''))) {
    error('edition-issue', `edition issue "${edition.issue}" is not an issue ID (expected ISS_###)`);
  }
  const listed = Array.isArray(edition.pages) ? edition.pages : [];
  if (!listed.length) {
    error('no-pages', 'the edition lists no pages');
    return [];
  }

  const pages = [];
  const seenPages = new Set();
  let previousNumber = null;
  listed.forEach((entry, index) => {
    const where = `pages[${index}]`;
    if (!entry || typeof entry !== 'object' || !entry.page || !entry.render || !entry.file) {
      error('page-entry', `${where}: every page needs "page", "render" and "file"`);
      return;
    }
    const pageId = String(entry.page);
    const renderId = String(entry.render);
    if (!ws.ID.page.test(pageId)) {
      error('page-id', `${where}: "${pageId}" is not a page ID`);
      return;
    }
    if (seenPages.has(pageId)) {
      error('page-duplicate', `${pageId} is listed more than once`, { page: pageId });
      return;
    }
    seenPages.add(pageId);
    if (edition.issue && ws.issueOfPage(pageId) !== edition.issue) {
      error('page-issue', `${pageId} does not belong to ${edition.issue}`, { page: pageId });
    }

    // Page-number order, starting at 1, no gaps.
    let pageDoc = null;
    try {
      pageDoc = ws.loadPage(root, pageId);
    } catch (err) {
      error('yaml', err.message, { page: pageId });
    }
    const number = pageDoc && typeof pageDoc.number === 'number' ? pageDoc.number : pageNumberOfId(pageId);
    const expected = previousNumber === null ? 1 : previousNumber + 1;
    if (previousNumber !== null && number <= previousNumber) {
      error('page-order', `${pageId} (page ${number}) is listed after page ${previousNumber}: pages must be in page-number order`, { page: pageId });
    } else if (number !== expected) {
      const missing = number - expected === 1 ? `page ${expected} is missing` : `pages ${expected}-${number - 1} are missing`;
      error('page-gap', `${pageId} is page ${number} but page ${expected} was expected: ${missing}`, { page: pageId });
    }
    previousNumber = number;

    if (!ws.ID.render.test(renderId) || ws.pageOfRender(renderId) !== pageId) {
      error('render-id', `${pageId}: render "${renderId}" is not a render of this page`, { page: pageId });
      return;
    }
    const shipped = shippedFile(root, pageId, renderId, entry, error, warn);
    if (shipped) pages.push(Object.assign({ page: pageId, render: renderId, number, side: pageDoc && pageDoc.side }, shipped));
  });

  // The cover, when the edition names one: the first page of every export.
  let cover = null;
  if (edition.cover !== null && edition.cover !== undefined) {
    const entry = edition.cover;
    const coverId = ws.coverIdOfIssue(edition.issue);
    if (!entry || typeof entry !== 'object' || !entry.render || !entry.file) {
      error('cover-entry', 'cover: needs "render" and "file"');
    } else if (!coverId || ws.coverOfRender(String(entry.render)) !== coverId) {
      error('render-id', `cover: render "${entry.render}" is not a cover render of ${edition.issue} (expected ${coverId || 'CV_###'}_V##)`, { page: coverId });
    } else {
      const shipped = shippedFile(root, coverId, String(entry.render), entry, error, warn);
      if (shipped) cover = Object.assign({ page: coverId, render: String(entry.render), cover: true }, shipped);
    }
  }
  // Everything that ships, in export order.
  const sheets = cover ? [cover, ...pages] : pages;

  // Review gate.
  const failing = sheets.filter((p) => !p.passes);
  result.gate = sheets.map((p) => ({ page: p.page, render: p.render, verdict: p.verdict, passes: p.passes }));
  if (failing.length) {
    const lines = failing.map((p) => `    ${p.page}  ${p.render}  ${p.verdict}`).join('\n');
    if (options.draft) {
      warn('review-gate', `draft build: ${failing.length} render${failing.length === 1 ? ' has' : 's have'} no passing review:\n${lines}`);
    } else {
      error('review-gate',
        `${failing.length} render${failing.length === 1 ? '' : 's'} cannot enter a non-draft edition (a review with verdict pass or fixed is required):\n${lines}\n` +
        '    Review or repair these pages, list a render that passed, or build a marked draft with --draft.',
        { renders: failing.map((p) => ({ page: p.page, render: p.render, verdict: p.verdict })) });
    }
  }

  // The issue's own page count.
  let issue = null;
  try {
    issue = edition.issue ? ws.loadIssue(root, edition.issue) : null;
  } catch (err) {
    error('yaml', err.message);
  }
  if (issue && typeof issue.page_count === 'number' && issue.page_count !== listed.length) {
    warn('page-count', `${edition.issue} declares ${issue.page_count} page${issue.page_count === 1 ? '' : 's'}, the edition lists ${listed.length}`);
  }

  // One aspect ratio (paged, the cover included), or one width (webtoon:
  // the cover of an episode is not a scroll segment, so it is left out).
  if (pages.length && sheets.length > 1) {
    if (project.comic_format === 'webtoon') {
      const widths = [...new Set(pages.map((p) => p.info.width))];
      if (widths.length > 1) warn('width', `scroll segments have different widths (${widths.join(', ')} px); the reader scales them to one column`);
    } else {
      const ratios = pages.map((p) => p.info.width / p.info.height).sort((a, b) => a - b);
      const common = ratios[Math.floor(ratios.length / 2)];
      const reference = pages.find((p) => p.info.width / p.info.height === common);
      for (const p of sheets) {
        const diff = Math.abs(p.info.width / p.info.height - common) / common;
        if (diff <= ASPECT_SAME) continue;
        const text = `${p.page} is ${p.info.width}x${p.info.height}, which is ${(diff * 100).toFixed(1)}% off the edition's page shape (${reference.info.width}x${reference.info.height} on ${reference.page})`;
        if (diff <= ASPECT_TOLERANCE) warn('aspect', text, { page: p.page });
        else error('aspect', `${text}; all pages of an edition share one aspect ratio`, { page: p.page });
      }
    }
  }
  const declared = project.page && /^\d+:\d+$/.test(String(project.page.aspect_ratio || ''))
    ? String(project.page.aspect_ratio).split(':').map(Number) : null;
  if (declared && declared[1] > 0 && pages.length && project.comic_format !== 'webtoon') {
    const want = declared[0] / declared[1];
    const first = pages[0];
    const diff = Math.abs(first.info.width / first.info.height - want) / want;
    if (diff > ASPECT_TOLERANCE) {
      warn('aspect-project', `pages are ${first.info.width}x${first.info.height}, project.yaml declares ${project.page.aspect_ratio}`);
    }
  }
  return sheets;
}

/**
 * Build the exports of an edition.
 *
 * @param {string} editionFile  Path to edition.yaml.
 * @param {object} [options]
 * @param {string|string[]} [options.formats]  "pdf,cbz,web,images,epub" or an array.
 * @param {boolean} [options.draft]
 * @param {boolean} [options.force]
 * @param {Date} [options.now]  Build time (tests pass a fixed date).
 * @returns {{ok:boolean, errors:Array, warnings:Array, draft:boolean,
 *   formats:string[], written:Array<{format,file}>, skipped:Array<{format,file,reason}>,
 *   shipped:Array<{page,render,verdict}>, gate:Array, root:string|null, edition:string|null}}
 *   File paths in `written` and `skipped` are workspace-relative. When the
 *   edition has a cover it is the first entry of `shipped` and `gate`, with
 *   the cover ID as its `page`.
 */
function buildEdition(editionFile, options = {}) {
  const result = {
    ok: false, errors: [], warnings: [], draft: !!options.draft, formats: [],
    written: [], skipped: [], shipped: [], gate: [], root: null, edition: null,
  };
  const error = (code, message) => result.errors.push({ code, message });

  const file = path.resolve(String(editionFile || ''));
  if (!editionFile || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    error('edition-missing', `edition file not found: ${file}`);
    return result;
  }
  const root = ws.findWorkspaceRoot(file);
  if (!root) {
    error('no-workspace', `no project.yaml found above ${file}; a workspace root is the directory that holds project.yaml`);
    return result;
  }
  result.root = root;
  let edition;
  let project;
  try {
    edition = ws.loadYaml(file);
    project = ws.loadProject(root) || {};
  } catch (err) {
    error('yaml', err.message);
    return result;
  }
  if (!edition || typeof edition !== 'object' || Array.isArray(edition)) {
    error('edition-empty', `${ws.rel(root, file)} is empty or not a map`);
    return result;
  }
  result.edition = edition.id || null;
  if (edition.id && path.basename(path.dirname(file)) !== String(edition.id)) {
    error('edition-location', `${ws.rel(root, file)} holds edition ${edition.id}; an edition lives at editions/${edition.id}/edition.yaml`);
    return result;
  }

  let formats;
  try {
    formats = resolveFormats(Array.isArray(options.formats) ? options.formats.join(',') : options.formats, project);
  } catch (err) {
    error('formats', err.message);
    return result;
  }
  result.formats = formats;

  // --force may replace exports of a draft only. Once an edition is reviewed
  // or published, its files are what readers hold: correct it with a new
  // edition ID instead.
  if (options.force && !options.draft && edition.status !== 'draft') {
    error('force-not-draft', `${edition.id || 'this edition'} has status "${edition.status}"; --force only replaces exports of a draft edition. Create a new edition with "supersedes: ${edition.id}" and the list of changes.`);
    return result;
  }

  const inspected = inspectEdition(root, edition, project, options, result);
  if (formats.includes('pdf')) {
    for (const p of inspected.filter((x) => x.info.format === 'webp')) {
      error('pdf-webp', `${p.page}: ${p.relFile} is a WebP image, which the PDF export cannot embed; convert the page to PNG or JPEG, or leave pdf out of --formats`);
    }
  }
  if (result.errors.length) return result;

  // --- names -------------------------------------------------------------------
  const issueNumber = String(edition.issue).replace(/^ISS_/, '');
  const editionNumber = String(edition.id).replace(/^ED_\d{3}_/, '');
  const baseName = `${slugify(project.title || edition.title)}-${issueNumber}-ed${editionNumber}${options.draft ? '-DRAFT' : ''}`;
  const exportsDir = path.join(path.dirname(file), 'exports');
  const now = options.now instanceof Date ? options.now : new Date();
  // Pages are numbered from 001; the cover, when there is one, sorts before
  // them as 000-cover.
  const digits = Math.max(3, String(inspected.filter((p) => !p.cover).length).length);
  let pageCount = 0;
  const pages = inspected.map((p) => {
    if (p.cover) return Object.assign({}, p, { name: `${'0'.repeat(digits)}-cover.${p.info.ext}`, label: 'Cover' });
    pageCount++;
    return Object.assign({}, p, { name: `${String(pageCount).padStart(digits, '0')}.${p.info.ext}`, label: `Page ${pageCount}` });
  });

  let issue = null;
  try {
    issue = ws.loadIssue(root, edition.issue);
  } catch (err) {
    issue = null;
  }
  const displayTitle = String(edition.title || project.title || edition.id);
  // What a draft export says about itself: the real review state, not a blanket claim.
  const unreviewed = pages.filter((p) => !p.passes).length;
  let draftNote = null;
  if (options.draft) {
    draftNote = unreviewed === 0
      ? 'DRAFT: every page passed review, built as a draft'
      : `DRAFT: ${unreviewed} of ${pages.length} page${pages.length === 1 ? '' : 's'} ${unreviewed === 1 ? 'has' : 'have'} no passing review`;
  }

  // Each format: the path it is built at, the path recorded in edition.yaml,
  // every path that must be free before it is built, and how to write it.
  const targets = {
    pdf() {
      const target = path.join(exportsDir, `${baseName}.pdf`);
      return {
        recorded: target,
        occupies: [target],
        write() {
          const trim = project.page && project.page.trim_mm;
          writeFileEnsuring(target, buildPdf(pages.map((p) => ({ data: p.data, name: `${p.page} (${p.relFile})` })), {
            title: displayTitle,
            draft: !!options.draft,
            pageSizeMm: trim && trim.width > 0 && trim.height > 0 && project.comic_format !== 'webtoon' ? trim : undefined,
            readingDirection: project.reading_direction,
            language: project.language,
            creationDate: now,
          }));
        },
      };
    },
    cbz() {
      const target = path.join(exportsDir, `${baseName}.cbz`);
      return {
        recorded: target,
        occupies: [target],
        write() {
          const entries = pages.map((p) => ({ name: p.name, data: p.data }));
          const notes = draftNote
            ? `${edition.id} ${draftNote}`
            : (edition.label ? `${edition.id}, ${edition.label}` : String(edition.id));
          entries.push({
            name: 'ComicInfo.xml',
            compress: true,
            data: comicInfoXml({
              title: (issue && issue.title) || displayTitle,
              series: project.title || displayTitle,
              number: issue && issue.number != null ? issue.number : Number(issueNumber),
              summary: issue && issue.summary,
              notes,
              genre: project.genre,
              language: project.language,
              blackAndWhite: project.color_mode === 'monochrome' ? 'Yes' : (project.color_mode ? 'No' : null),
              readingDirection: project.reading_direction,
              pages: pages.map((p) => ({
                size: p.data.length, width: p.info.width, height: p.info.height, type: p.cover ? 'FrontCover' : null,
              })),
            }),
          });
          writeFileEnsuring(target, createZip(entries));
        },
      };
    },
    web() {
      const target = path.join(exportsDir, `${baseName}-web`);
      return {
        recorded: path.join(target, 'index.html'),
        occupies: [target],
        write() {
          for (const p of pages) writeFileEnsuring(path.join(target, 'pages', p.name), p.data);
          writeFileEnsuring(path.join(target, 'index.html'), webReaderHtml({
            title: displayTitle,
            language: project.language,
            readingDirection: project.reading_direction,
            comicFormat: project.comic_format,
            draft: !!options.draft,
            draftNote,
            pages: pages.map((p) => ({
              src: `pages/${p.name}`, width: p.info.width, height: p.info.height, label: p.label,
            })),
          }));
        },
      };
    },
    // One numbered image per page, as a folder and as a zip of the same files.
    images() {
      const dir = path.join(exportsDir, `${baseName}-images`);
      const zip = path.join(exportsDir, `${baseName}-images.zip`);
      return {
        recorded: zip,
        occupies: [zip, dir],
        write() {
          for (const p of pages) writeFileEnsuring(path.join(dir, p.name), p.data);
          writeFileEnsuring(zip, createZip(pages.map((p) => ({ name: p.name, data: p.data }))));
        },
      };
    },
    epub() {
      const target = path.join(exportsDir, `${baseName}.epub`);
      return {
        recorded: target,
        occupies: [target],
        write() {
          writeFileEnsuring(target, buildEpub(pages.map((p) => ({
            name: p.name,
            data: p.data,
            width: p.info.width,
            height: p.info.height,
            mime: p.info.mime,
            label: p.label,
            cover: !!p.cover,
            side: p.side,
          })), {
            title: `${displayTitle}${options.draft ? ' (DRAFT)' : ''}`,
            // Stable per edition and build kind, so a rebuilt file is the same publication.
            identifier: uuidFrom(`${slugify(project.title || edition.title)}:${edition.id}${options.draft ? ':draft' : ''}`),
            language: project.language,
            readingDirection: project.reading_direction,
            comicFormat: project.comic_format,
            modified: now,
            description: draftNote ? `${edition.id} ${draftNote}` : ((issue && issue.summary) || null),
            draftNote,
          }));
        },
      };
    },
  };

  for (const format of formats) {
    const target = targets[format]();
    const recorded = ws.rel(root, target.recorded);
    const taken = target.occupies.filter((p) => fs.existsSync(p));
    if (taken.length) {
      if (!options.force) {
        result.skipped.push({ format, file: recorded, reason: 'exists' });
        continue;
      }
      // A forced directory export starts from an empty directory.
      for (const p of taken) {
        if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      }
    }
    try {
      target.write();
    } catch (err) {
      error('export', `${format}: ${err.message}`);
      continue;
    }
    result.written.push({ format, file: recorded });
  }

  // --- record the exports in edition.yaml ------------------------------------------
  if (result.written.length) {
    const exportsList = Array.isArray(edition.exports) ? edition.exports.filter((e) => e && typeof e === 'object') : [];
    const builtAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
    for (const written of result.written) {
      const entry = { format: written.format, file: written.file, built_at: builtAt };
      // Replace the entry for the same file, or a planned entry of this format that was never built.
      let at = exportsList.findIndex((e) => e.file === written.file);
      if (at === -1) at = exportsList.findIndex((e) => e.format === written.format && !e.built_at && !fs.existsSync(ws.abs(root, String(e.file || ''))));
      if (at === -1) exportsList.push(entry);
      else exportsList[at] = entry;
    }
    edition.exports = exportsList;
    const updated = editionText(fs.readFileSync(file, 'utf8'), edition);
    writeFileEnsuring(file, updated.text);
    if (!updated.preserved) {
      result.warnings.push({
        code: 'edition-rewritten',
        message: `${ws.rel(root, file)} was rewritten through the YAML library to record the exports; its comments and hand formatting are gone`,
      });
    }
  }

  result.shipped = pages.map((p) => ({ page: p.page, render: p.render, verdict: p.verdict }));
  result.ok = result.errors.length === 0;
  return result;
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

/** "PG_001_002_V02" -> "V02". */
function versionTag(renderId) {
  const m = /_(V\d{2})$/.exec(String(renderId));
  return m ? m[1] : String(renderId);
}

/** The lettered image stored next to a render (<RENDER_ID>.lettered.png or .jpg), workspace-relative, or null. */
function letteredFileOf(root, renderFile, renderId) {
  for (const ext of ['.png', '.jpg', '.jpeg']) {
    const candidate = path.join(path.dirname(renderFile), `${renderId}.lettered${ext}`);
    if (fs.existsSync(candidate)) return ws.rel(root, candidate);
  }
  return null;
}

/**
 * Compose an edition from the current state of an issue. Writes nothing.
 *
 * The edition takes the next free ID of the issue (one above the highest
 * edition directory), status draft, every page of the issue that has a
 * current render, in page order, and the cover when cover.yaml is approved.
 * A lettered image stored next to a render (letter-pages.js
 * registerLetteredFile) is listed as its lettered_file. When the issue
 * already has an edition, the new one supersedes the latest and `changes`
 * says which renders differ.
 *
 * The returned object is a plain edition document: it serializes to a file
 * that follows schemas/edition.schema.json. It also carries `blockers`, a
 * non-enumerable array (so it never reaches the YAML) of what keeps this
 * edition from being final: [{ page, render, code, message }], with code
 * no_render, render_missing, no_review, or not_passing. `page` is the cover
 * ID for the cover. An edition with blockers builds only with --draft; a
 * page with no render at all is left out of `pages`, which leaves a gap
 * that even a draft build refuses.
 *
 * @param {{root: string, issue: string, now?: Date}} options
 * @returns {object} the edition document, plus the non-enumerable `blockers`
 * @throws an Error with `code` when the issue does not exist
 */
function draftEdition(options = {}) {
  const root = options.root;
  const issueId = String(options.issue || '');
  const fail = (code, message) => Object.assign(new Error(message), { code });
  if (!root || !ws.ID.issue.test(issueId)) {
    throw fail('bad_arguments', `draftEdition needs { root, issue: "ISS_###" }, got issue "${options.issue}"`);
  }
  const issue = ws.loadIssue(root, issueId);
  if (!issue) throw fail('issue_missing', `${issueId}: issues/${issueId}/issue.yaml not found`);
  const project = ws.loadProject(root) || {};
  const blockers = [];
  const block = (page, render, code, message) => blockers.push({ page, render, code, message });
  /** Record why a listed render cannot enter a final edition, if it cannot. */
  const gate = (label, renderId) => {
    const review = ws.loadReview(root, renderId);
    if (ws.reviewPasses(review)) return;
    if (!review) block(label, renderId, 'no_review', `${renderId} has no review; a final edition needs verdict pass or fixed`);
    else block(label, renderId, 'not_passing', `the review of ${renderId} has verdict ${review.verdict || 'none'}; a final edition needs pass or fixed`);
  };

  const pages = [];
  for (const entry of ws.listPages(root, issueId)) {
    const renderId = entry.doc && entry.doc.current_render ? String(entry.doc.current_render) : null;
    if (!renderId) {
      block(entry.id, null, 'no_render', `${entry.id} has no current render`);
      continue;
    }
    const file = ws.pageOfRender(renderId) === entry.id ? ws.renderFile(root, renderId) : null;
    if (!file) {
      block(entry.id, renderId, 'render_missing', `${entry.id} names ${renderId} as its current render and no such image is on disk`);
      continue;
    }
    pages.push({
      page: entry.id,
      render: renderId,
      file: ws.rel(root, file),
      lettered_file: letteredFileOf(root, file, renderId),
    });
    gate(entry.id, renderId);
  }
  if (!pages.length && !blockers.length) block(null, null, 'no_render', `${issueId} has no pages`);

  // The cover enters only once it is approved.
  let cover = null;
  const coverDoc = ws.loadCover(root, issueId);
  if (coverDoc && coverDoc.status === 'approved' && coverDoc.approved_render) {
    const renderId = String(coverDoc.approved_render);
    const coverId = ws.coverIdOfIssue(issueId);
    const file = ws.coverOfRender(renderId) === coverId ? ws.renderFile(root, renderId) : null;
    if (!file) {
      block(coverId, renderId, 'render_missing', `cover.yaml approves ${renderId} and no such image is on disk`);
    } else {
      cover = { render: renderId, file: ws.rel(root, file), lettered_file: letteredFileOf(root, file, renderId) };
      gate(coverId, renderId);
    }
  }

  // Next free ID: one above the highest edition directory of this issue.
  const prefix = `ED_${issueId.slice(4)}_`;
  const earlier = ws.listEditions(root).filter((id) => id.startsWith(prefix));
  const highest = earlier.reduce((max, id) => Math.max(max, Number(id.slice(prefix.length))), 0);
  if (highest >= 99) throw fail('edition_ids_exhausted', `${issueId} already has 99 editions`);
  const number = highest + 1;
  const supersedes = earlier.length ? earlier[earlier.length - 1] : null;

  // What changed since the edition this one replaces.
  const changes = [];
  let previous = null;
  try {
    previous = supersedes ? ws.loadEdition(root, supersedes) : null;
  } catch (err) {
    previous = null;
  }
  if (previous) {
    const before = new Map((Array.isArray(previous.pages) ? previous.pages : [])
      .filter((p) => p && p.page).map((p) => [p.page, p]));
    for (const p of pages) {
      const old = before.get(p.page);
      if (!old) changes.push(`${p.page} added with ${versionTag(p.render)}`);
      else if (old.render !== p.render) changes.push(`${p.page} uses ${versionTag(p.render)} instead of ${versionTag(old.render)}`);
      else if ((old.lettered_file || null) !== p.lettered_file) changes.push(`${p.page} ships ${p.lettered_file ? 'its lettered file' : 'the unlettered render'}`);
    }
    for (const id of before.keys()) {
      if (!pages.some((p) => p.page === id)) changes.push(`${id} removed`);
    }
    const oldCover = previous.cover && previous.cover.render ? previous.cover.render : null;
    if (cover && !oldCover) changes.push(`cover added with ${versionTag(cover.render)}`);
    else if (cover && oldCover !== cover.render) changes.push(`cover uses ${versionTag(cover.render)} instead of ${versionTag(oldCover)}`);
    else if (!cover && oldCover) changes.push('cover removed');
  }

  const edition = {
    id: `${prefix}${String(number).padStart(2, '0')}`,
    issue: issueId,
    title: issue.title && project.title ? `${project.title} - ${issue.title}` : String(project.title || issue.title || issueId),
    label: `${ORDINALS[number - 1] || `${number}th`} edition`,
    status: 'draft',
    supersedes,
    changes,
  };
  if (cover) edition.cover = cover;
  edition.pages = pages;
  edition.exports = [];
  edition.created_at = (options.now instanceof Date ? options.now : new Date()).toISOString().slice(0, 10);
  Object.defineProperty(edition, 'blockers', { value: blockers, enumerable: false });
  return edition;
}

function main() {
  const argv = process.argv.slice(2);
  helpIfRequested(argv, HELP);
  const { flags } = parseArgs(argv);
  if (!flags.edition || flags.edition === true) {
    console.error('error: --edition <edition.yaml> is required (see --help)');
    process.exit(1);
  }
  if (flags.formats === true) {
    console.error('error: --formats needs a list, for example --formats pdf,cbz');
    process.exit(1);
  }
  const result = buildEdition(String(flags.edition), {
    formats: flags.formats || undefined,
    draft: flags.draft === true,
    force: flags.force === true,
  });
  for (const w of result.warnings) console.warn(`warning: ${w.message}`);
  for (const e of result.errors) console.error(`error: ${e.message}`);
  for (const w of result.written) console.log(`wrote ${w.file}`);
  for (const s of result.skipped) {
    console.log(`skipped ${s.file}: it already exists and exports are never overwritten (pass --force, or create a new edition)`);
  }
  if (!result.ok) {
    console.error(`build-edition: ${result.edition || 'edition'} not built (${result.errors.length} error${result.errors.length === 1 ? '' : 's'})`);
    process.exit(1);
  }
  const shipped = result.shipped.map((s) => `${s.render} (${s.verdict})`).join(', ');
  const what = result.written.length
    ? `${result.written.map((w) => w.format).join(', ')} built`
    : 'nothing new built';
  console.log(`build-edition: ${result.edition}${result.draft ? ' DRAFT' : ''}, ${what}. Renders shipped and their review verdicts: ${shipped}`);
}

module.exports = {
  buildEdition, draftEdition, resolveFormats, editionText, comicInfoXml, webReaderHtml, slugify, FORMATS,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`build-edition: ${err.message}`);
    process.exit(1);
  }
}
