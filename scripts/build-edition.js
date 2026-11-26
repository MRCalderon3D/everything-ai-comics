#!/usr/bin/env node
'use strict';
/**
 * build-edition.js: assemble an edition and export it as PDF, CBZ, and a web
 * reader.
 *
 * Reads editions/<ED_ID>/edition.yaml, which lists the exact render of every
 * page, and enforces the edition rules of docs/data-model.md:
 *   - every listed render has a visual review with verdict pass or fixed
 *     (otherwise the build refuses, unless --draft, which marks every export)
 *   - pages are listed once each, in page-number order, with no gaps
 *   - an export file that already exists is never overwritten (unless --force)
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
const { escapeXml } = require('./lib/svg');

const FORMATS = ['pdf', 'cbz', 'web'];
const DEFAULT_FORMATS = ['pdf', 'cbz'];
/** Aspect ratios closer than this are treated as equal (pixel rounding). */
const ASPECT_SAME = 0.002;
/** Up to this relative difference the build warns; beyond it, it stops. */
const ASPECT_TOLERANCE = 0.02;

const HELP = `
build-edition.js: export an edition as PDF, CBZ, and a web reader.

Usage:
  node scripts/build-edition.js --edition <edition.yaml> [--formats pdf,cbz,web] [--draft] [--force]

Options:
  --edition <file>   The edition.yaml to build (editions/<ED_ID>/edition.yaml). Required.
  --formats <list>   Comma-separated: pdf, cbz, web. Default: the pdf, cbz and
                     web targets of project.yaml "deliverables", else pdf,cbz.
  --draft            Build even when a listed render has no passing review.
                     Every export gets -DRAFT in its name, the PDF is stamped
                     on every page, and the web reader shows a draft banner.
  --force            Overwrite existing exports. Draft editions only.
  --help             Show this help.

Checks before anything is written:
  - every page has "page", "render" and "file", and the file exists
  - every render has a review with verdict pass or fixed (skipped by --draft,
    which still prints each verdict)
  - pages are listed once each, in page-number order, starting at 1, no gaps
  - all pages share one aspect ratio: a small difference is a warning, a
    larger one stops the build (webtoon projects only compare widths)

Output, under editions/<ED_ID>/exports/:
  <title>-<issue>-ed<edition>[-DRAFT].pdf      one page image per PDF page
  <title>-<issue>-ed<edition>[-DRAFT].cbz      001.png, 002.png ... plus ComicInfo.xml
  <title>-<issue>-ed<edition>[-DRAFT]-web/     index.html reader plus pages/

"lettered_file" replaces "file" when it is set. It must be a PNG or JPEG: an
overlay SVG from letter-pages.js has to be exported to an image first.

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
    lines.push(`    <Page Image="${index}" ImageSize="${page.size}" ImageWidth="${page.width}" ImageHeight="${page.height}" />`);
  });
  lines.push('  </Pages>', '</ComicInfo>', '');
  return lines.join('\n');
}

/** index.html of the web reader. Plain HTML and CSS; a short script adds paging. */
function webReaderHtml(meta) {
  const rtl = meta.readingDirection === 'rtl';
  const webtoon = meta.comicFormat === 'webtoon';
  const images = meta.pages.map((page, index) =>
    `  <img class="page" id="p${index + 1}" src="${escapeXml(page.src)}" alt="Page ${index + 1}" width="${page.width}" height="${page.height}"${index > 1 ? ' loading="lazy"' : ''}>`
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
 * Check an edition against the edition rules and collect what is needed to
 * export it. Writes nothing.
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

    // The file that ships: lettered_file when set, else file.
    const lettered = entry.lettered_file ? String(entry.lettered_file) : null;
    const relFile = (lettered || String(entry.file)).replace(/\\/g, '/');
    const file = path.resolve(ws.abs(root, relFile));
    const baseName = path.basename(relFile);
    const stem = baseName.slice(0, baseName.length - path.extname(baseName).length);
    if (!isInside(root, file)) {
      error('file-outside', `${pageId}: ${relFile} points outside the workspace`, { page: pageId });
      return;
    }
    if (lettered ? !baseName.startsWith(renderId) : stem !== renderId) {
      error('file-render', `${pageId}: ${relFile} is not the file of render ${renderId}; the review covers the render, so the two must match`, { page: pageId });
      return;
    }
    if (/\.svg$/i.test(relFile)) {
      error('file-svg', `${pageId}: ${relFile} is an SVG overlay; export it to PNG or JPEG (browser or vector tool) and list that image as lettered_file`, { page: pageId });
      return;
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      error('file-missing', `${pageId}: image not found: ${relFile}`, { page: pageId });
      return;
    }
    let info;
    let data;
    try {
      data = fs.readFileSync(file);
      info = imageInfo(data);
    } catch (err) {
      error('file-unreadable', `${pageId}: ${relFile}: ${err.message}`, { page: pageId });
      return;
    }

    let review = null;
    try {
      review = ws.loadReview(root, renderId);
    } catch (err) {
      error('yaml', err.message, { page: pageId });
    }
    if (review && review.render && review.render !== renderId) {
      warn('review-render', `${pageId}: the review file of ${renderId} says it reviews ${review.render}`, { page: pageId });
    }
    const verdict = review ? String(review.verdict || 'no verdict') : 'no review';
    pages.push({
      page: pageId, render: renderId, number, relFile, file, data, info,
      verdict, passes: ws.reviewPasses(review),
    });
  });

  // Review gate.
  const failing = pages.filter((p) => !p.passes);
  result.gate = pages.map((p) => ({ page: p.page, render: p.render, verdict: p.verdict, passes: p.passes }));
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

  // One aspect ratio (paged), or one width (webtoon).
  if (pages.length > 1) {
    if (project.comic_format === 'webtoon') {
      const widths = [...new Set(pages.map((p) => p.info.width))];
      if (widths.length > 1) warn('width', `scroll segments have different widths (${widths.join(', ')} px); the reader scales them to one column`);
    } else {
      const ratios = pages.map((p) => p.info.width / p.info.height).sort((a, b) => a - b);
      const common = ratios[Math.floor(ratios.length / 2)];
      const reference = pages.find((p) => p.info.width / p.info.height === common);
      for (const p of pages) {
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
  return pages;
}

/**
 * Build the exports of an edition.
 *
 * @param {string} editionFile  Path to edition.yaml.
 * @param {object} [options]
 * @param {string|string[]} [options.formats]  "pdf,cbz,web" or an array.
 * @param {boolean} [options.draft]
 * @param {boolean} [options.force]
 * @param {Date} [options.now]  Build time (tests pass a fixed date).
 * @returns {{ok:boolean, errors:Array, warnings:Array, draft:boolean,
 *   formats:string[], written:Array<{format,file}>, skipped:Array<{format,file,reason}>,
 *   shipped:Array<{page,render,verdict}>, gate:Array, root:string|null, edition:string|null}}
 *   File paths in `written` and `skipped` are workspace-relative.
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

  const pages = inspectEdition(root, edition, project, options, result);
  if (formats.includes('pdf')) {
    for (const p of pages.filter((x) => x.info.format === 'webp')) {
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
  const digits = Math.max(3, String(pages.length).length);
  const pageName = (index, info) => `${String(index + 1).padStart(digits, '0')}.${info.ext}`;

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

  const builders = {
    pdf() {
      const trim = project.page && project.page.trim_mm;
      return buildPdf(pages.map((p) => ({ data: p.data, name: `${p.page} (${p.relFile})` })), {
        title: displayTitle,
        draft: !!options.draft,
        pageSizeMm: trim && trim.width > 0 && trim.height > 0 && project.comic_format !== 'webtoon' ? trim : undefined,
        readingDirection: project.reading_direction,
        language: project.language,
        creationDate: now,
      });
    },
    cbz() {
      const entries = pages.map((p, i) => ({ name: pageName(i, p.info), data: p.data }));
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
          pages: pages.map((p) => ({ size: p.data.length, width: p.info.width, height: p.info.height })),
        }),
      });
      return createZip(entries);
    },
  };

  for (const format of formats) {
    const target = format === 'web'
      ? path.join(exportsDir, `${baseName}-web`)
      : path.join(exportsDir, `${baseName}.${format}`);
    const recorded = ws.rel(root, format === 'web' ? path.join(target, 'index.html') : target);
    if (fs.existsSync(target)) {
      if (!options.force) {
        result.skipped.push({ format, file: recorded, reason: 'exists' });
        continue;
      }
      if (format === 'web') fs.rmSync(target, { recursive: true, force: true });
    }
    try {
      if (format === 'web') {
        const entries = pages.map((p, i) => ({ name: pageName(i, p.info), page: p }));
        for (const entry of entries) writeFileEnsuring(path.join(target, 'pages', entry.name), entry.page.data);
        writeFileEnsuring(path.join(target, 'index.html'), webReaderHtml({
          title: displayTitle,
          language: project.language,
          readingDirection: project.reading_direction,
          comicFormat: project.comic_format,
          draft: !!options.draft,
          draftNote,
          pages: entries.map((e) => ({ src: `pages/${e.name}`, width: e.page.info.width, height: e.page.info.height })),
        }));
      } else {
        writeFileEnsuring(target, builders[format]());
      }
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

module.exports = { buildEdition, resolveFormats, editionText, comicInfoXml, webReaderHtml, slugify, FORMATS };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`build-edition: ${err.message}`);
    process.exit(1);
  }
}
