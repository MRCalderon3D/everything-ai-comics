'use strict';
/**
 * scripts/build-edition.js beyond PDF, CBZ and web: the images and EPUB
 * formats, the optional cover as the first page of every format,
 * draftEdition(), and registerLetteredFile() from scripts/letter-pages.js.
 * Also scripts/lib/epub.js on its own.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('../scripts/lib/yaml');
const ws = require('../scripts/lib/workspace');
const { readZip } = require('../scripts/lib/zip');
const { buildEpub, uuidFrom, MIMETYPE } = require('../scripts/lib/epub');
const { validateDoc } = require('../scripts/lib/page-pipeline');
const { buildEdition, draftEdition, resolveFormats, comicInfoXml, FORMATS } = require('../scripts/build-edition');
const { registerLetteredFile } = require('../scripts/letter-pages');
const { makeWorkspace, cleanup, editYaml, readPdf, solidPng, greyJpeg } = require('./fixtures/publishing/helpers');

const BUILD = path.join(__dirname, '..', 'scripts', 'build-edition.js');
const LETTER = path.join(__dirname, '..', 'scripts', 'letter-pages.js');
const NOW = new Date(Date.UTC(2026, 10, 26, 10, 0, 0));
const BASE = 'the-night-ferry-001-ed01';
const roots = [];

function workspace() {
  const root = makeWorkspace();
  roots.push(root);
  return {
    root,
    edition: path.join(root, 'editions', 'ED_001_01', 'edition.yaml'),
    exports: path.join(root, 'editions', 'ED_001_01', 'exports'),
    abs: (rel) => path.join(root, ...rel.split('/')),
  };
}

function writeYaml(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.stringify(doc));
}

const COVER_RENDER = 'issues/ISS_001/cover/renders/CV_001_V01.png';
const COVER_REVIEW = 'issues/ISS_001/cover/reviews/CV_001_V01.review.yaml';
const COVER_FILE = 'issues/ISS_001/cover/cover.yaml';

/** Add a cover with one render and a passing review to a workspace. */
function addCover(w, { status = 'approved', verdict = 'pass', size = [40, 60] } = {}) {
  fs.mkdirSync(path.dirname(w.abs(COVER_RENDER)), { recursive: true });
  fs.writeFileSync(w.abs(COVER_RENDER), solidPng(size[0], size[1], 'grey', [30]));
  writeYaml(w.abs(COVER_FILE), {
    id: 'CV_001',
    issue: 'ISS_001',
    concept: 'The ferry alone on black water.',
    cast: [],
    lettering: { mode: 'overlay', title: 'The Night Ferry' },
    status,
    approved_render: status === 'approved' ? 'CV_001_V01' : null,
  });
  if (verdict) {
    writeYaml(w.abs(COVER_REVIEW), {
      page: 'CV_001',
      render: 'CV_001_V01',
      findings: [],
      gates: { style_fidelity: 'pass', narrative_continuity: verdict === 'flagged' ? 'fail' : 'pass' },
      verdict,
      repair_cycle: 0,
    });
  }
}

/** Parse the attributes of every element with this tag name. */
function elements(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b([^>]*?)/?>`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    const attrs = {};
    const attrRe = /([\w:-]+)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(m[1]))) attrs[a[1]] = a[2];
    out.push(attrs);
  }
  return out;
}

/** A crude well-formedness check: every opened element is closed in order. */
function assertBalanced(xml, label) {
  const stack = [];
  const body = xml.replace(/<\?xml[^>]*\?>/, '').replace(/<!DOCTYPE[^>]*>/, '');
  const re = /<(\/?)([\w:-]+)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g;
  let m;
  let last = 0;
  while ((m = re.exec(body))) {
    assert.ok(!/[<>]/.test(body.slice(last, m.index)), `${label}: stray angle bracket before <${m[2]}>`);
    last = re.lastIndex;
    if (m[4] === '/') continue;
    if (m[1] === '/') assert.strictEqual(stack.pop(), m[2], `${label}: </${m[2]}> closes the wrong element`);
    else stack.push(m[2]);
  }
  assert.deepStrictEqual(stack, [], `${label}: unclosed elements`);
  assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(body), `${label}: bare ampersand`);
}

/** Read an EPUB and check the container rules every reader depends on. */
function readEpub(buffer) {
  const entries = readZip(buffer);
  const byName = new Map(entries.map((e) => [e.name, e]));
  // mimetype: first, stored, at offset 0, no extra field, exact content.
  assert.strictEqual(entries[0].name, 'mimetype');
  assert.strictEqual(entries[0].method, 0, 'mimetype is stored, not deflated');
  assert.strictEqual(entries[0].offset, 0);
  assert.strictEqual(buffer.readUInt16LE(28), 0, 'no extra field on the first local header');
  assert.strictEqual(buffer.toString('latin1', 30, 38), 'mimetype');
  assert.strictEqual(buffer.toString('latin1', 38, 38 + MIMETYPE.length), 'application/epub+zip');
  assert.strictEqual(entries[0].data.toString('utf8'), 'application/epub+zip');

  const container = byName.get('META-INF/container.xml').data.toString('utf8');
  assertBalanced(container, 'container.xml');
  const rootfile = elements(container, 'rootfile')[0];
  assert.strictEqual(rootfile['media-type'], 'application/oebps-package+xml');
  const opfEntry = byName.get(rootfile['full-path']);
  assert.ok(opfEntry, 'the container points at a file in the archive');
  const opf = opfEntry.data.toString('utf8');
  assertBalanced(opf, 'content.opf');
  const base = path.posix.dirname(rootfile['full-path']);

  const items = elements(opf, 'item');
  const ids = new Set(items.map((i) => i.id));
  assert.strictEqual(ids.size, items.length, 'manifest ids are unique');
  for (const item of items) {
    const entry = byName.get(`${base}/${item.href}`);
    assert.ok(entry, `manifest item ${item.href} is in the archive`);
    if (item['media-type'] === 'application/xhtml+xml') assertBalanced(entry.data.toString('utf8'), item.href);
  }
  // Every file in the archive is declared, except the container files.
  for (const entry of entries) {
    if (entry.name === 'mimetype' || entry.name.startsWith('META-INF/') || entry.name === rootfile['full-path']) continue;
    assert.ok(items.some((i) => `${base}/${i.href}` === entry.name), `${entry.name} is in the manifest`);
  }
  const spine = elements(opf, 'itemref');
  for (const ref of spine) assert.ok(ids.has(ref.idref), `spine idref ${ref.idref} is in the manifest`);
  const nav = items.filter((i) => i.properties === 'nav');
  assert.strictEqual(nav.length, 1, 'exactly one navigation document');
  return { entries, byName, opf, items, spine, base, nav: byName.get(`${base}/${nav[0].href}`).data.toString('utf8') };
}

try {
  // --- scripts/lib/epub.js -----------------------------------------------------------------
  {
    assert.match(uuidFrom('a'), /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.strictEqual(uuidFrom('a'), uuidFrom('a'));
    assert.notStrictEqual(uuidFrom('a'), uuidFrom('b'));

    const page = (name, extra = {}) => Object.assign({
      name, data: solidPng(8, 12, 'grey', [200]), width: 8, height: 12, mime: 'image/png',
    }, extra);
    const meta = { title: 'Tide & <Salt>', identifier: uuidFrom('x'), language: 'ja', readingDirection: 'rtl', modified: NOW };
    const buffer = buildEpub([
      page('000-cover.png', { label: 'Cover', cover: true }),
      page('001.png', { label: 'Page 1', side: 'right' }),
      page('002.png', { side: 'left' }),
    ], meta);
    assert.ok(buffer.equals(buildEpub([
      page('000-cover.png', { label: 'Cover', cover: true }),
      page('001.png', { label: 'Page 1', side: 'right' }),
      page('002.png', { side: 'left' }),
    ], meta)), 'the same input gives the same bytes');
    const epub = readEpub(buffer);
    assert.deepStrictEqual(epub.entries.map((e) => e.name), [
      'mimetype', 'META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml', 'OEBPS/style.css',
      'OEBPS/page-000-cover.xhtml', 'OEBPS/page-001.xhtml', 'OEBPS/page-002.xhtml',
      'OEBPS/images/000-cover.png', 'OEBPS/images/001.png', 'OEBPS/images/002.png',
    ]);
    assert.match(epub.opf, /<package [^>]*version="3\.0"[^>]*unique-identifier="pub-id"/);
    assert.match(epub.opf, /<meta property="rendition:layout">pre-paginated<\/meta>/);
    assert.match(epub.opf, /<meta property="dcterms:modified">2026-11-26T10:00:00Z<\/meta>/);
    assert.match(epub.opf, /<dc:title>Tide &amp; &lt;Salt&gt;<\/dc:title>/, 'text is escaped');
    assert.match(epub.opf, /<dc:language>ja<\/dc:language>/);
    assert.match(epub.opf, /<spine page-progression-direction="rtl">/);
    assert.deepStrictEqual(epub.spine.map((r) => r.properties), ['rendition:page-spread-center', 'page-spread-right', 'page-spread-left']);
    const coverImages = epub.items.filter((i) => i.properties === 'cover-image');
    assert.deepStrictEqual(coverImages.map((i) => i.href), ['images/000-cover.png']);
    assert.ok(epub.byName.get('OEBPS/images/001.png').method === 0, 'images are stored as they are');
    assert.ok(epub.byName.get('OEBPS/content.opf').method === 8, 'text is deflated');
    const doc = epub.byName.get('OEBPS/page-001.xhtml').data.toString('utf8');
    assert.match(doc, /<meta name="viewport" content="width=8, height=12"\/>/);
    assert.match(doc, /<img src="images\/001\.png" alt="Page 1" width="8" height="12"\/>/);
    assert.ok(!/class="draft"/.test(doc));
    assert.match(epub.nav, /<nav epub:type="toc" id="toc">/);
    assert.deepStrictEqual(elements(epub.nav, 'a').map((a) => a.href), ['page-000-cover.xhtml', 'page-001.xhtml', 'page-002.xhtml']);
    assert.match(epub.nav, />Page 2<\/a>/, 'a page without a label is numbered by position');

    // No cover: no cover-image, no cover meta. Webtoon: no spreads.
    const plain = readEpub(buildEpub([page('001.png', { side: 'right' })], { title: 'T', identifier: 'urn:x', comicFormat: 'webtoon', modified: NOW }));
    assert.ok(!plain.items.some((i) => i.properties === 'cover-image'));
    assert.ok(!/name="cover"/.test(plain.opf));
    assert.match(plain.opf, /<meta property="rendition:spread">none<\/meta>/);
    assert.match(plain.opf, /<spine page-progression-direction="ltr">/);
    assert.deepStrictEqual(plain.spine.map((r) => r.properties), [undefined]);
    // A draft note is a banner on every page.
    const draft = readEpub(buildEpub([page('001.png')], { title: 'T', identifier: 'urn:x', draftNote: 'DRAFT: 1 of 1 page has no passing review', modified: NOW }));
    assert.match(draft.byName.get('OEBPS/page-001.xhtml').data.toString('utf8'), /<div class="draft"[^>]*>DRAFT: 1 of 1 page has no passing review<\/div>/);

    assert.throws(() => buildEpub([], meta), /at least one page/);
    assert.throws(() => buildEpub([page('001.png')], { identifier: 'urn:x' }), /title/);
    assert.throws(() => buildEpub([page('001.png')], { title: 'T' }), /identifier/);
    assert.throws(() => buildEpub([{ name: '001.png' }], meta), /page 1 needs/);
  }

  // --- formats ---------------------------------------------------------------------------------
  assert.deepStrictEqual(FORMATS, ['pdf', 'cbz', 'web', 'images', 'epub']);
  assert.deepStrictEqual(resolveFormats('epub,images,pdf', {}), ['pdf', 'images', 'epub']);
  assert.deepStrictEqual(resolveFormats(undefined, { deliverables: [{ target: 'epub' }, { target: 'images' }, { target: 'print' }] }), ['images', 'epub']);
  assert.throws(() => resolveFormats('mobi', {}), /unknown format "mobi" \(use pdf, cbz, web, images, epub\)/);

  // --- images and epub without a cover -------------------------------------------------------
  {
    const w = workspace();
    const result = buildEdition(w.edition, { formats: 'images,epub', now: NOW });
    assert.deepStrictEqual(result.errors, [], JSON.stringify(result.errors));
    assert.deepStrictEqual(result.written, [
      { format: 'images', file: `editions/ED_001_01/exports/${BASE}-images.zip` },
      { format: 'epub', file: `editions/ED_001_01/exports/${BASE}.epub` },
    ]);
    assert.deepStrictEqual(fs.readdirSync(w.exports).sort(), [`${BASE}-images`, `${BASE}-images.zip`, `${BASE}.epub`]);

    // Images: one numbered file per page in reading order, the listed renders, folder and zip alike.
    const dir = path.join(w.exports, `${BASE}-images`);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['001.png', '002.png', '003.jpg']);
    const zip = readZip(fs.readFileSync(path.join(w.exports, `${BASE}-images.zip`)));
    assert.deepStrictEqual(zip.map((e) => e.name), ['001.png', '002.png', '003.jpg']);
    const renders = [
      'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png',
      'issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V02.png',
      'issues/ISS_001/pages/PG_001_003/renders/PG_001_003_V01.jpg',
    ].map((rel) => fs.readFileSync(w.abs(rel)));
    zip.forEach((entry, i) => {
      assert.ok(entry.data.equals(renders[i]), `${entry.name} is the listed render`);
      assert.ok(fs.readFileSync(path.join(dir, entry.name)).equals(renders[i]));
      assert.strictEqual(entry.method, 0, 'images are stored');
    });

    // EPUB: fixed layout, one page document per image, the project's direction and language.
    const epub = readEpub(fs.readFileSync(path.join(w.exports, `${BASE}.epub`)));
    assert.deepStrictEqual(epub.entries.filter((e) => e.name.startsWith('OEBPS/images/')).map((e) => e.name),
      ['OEBPS/images/001.png', 'OEBPS/images/002.png', 'OEBPS/images/003.jpg']);
    assert.ok(epub.byName.get('OEBPS/images/002.png').data.equals(renders[1]), 'page 2 is V02');
    assert.match(epub.opf, /<dc:title>The Night Ferry - Crossing<\/dc:title>/);
    assert.match(epub.opf, /<dc:language>en<\/dc:language>/);
    assert.match(epub.opf, /<meta property="rendition:layout">pre-paginated<\/meta>/);
    assert.match(epub.opf, /<spine page-progression-direction="ltr">/);
    assert.match(epub.opf, /href="images\/003\.jpg" media-type="image\/jpeg"/);
    assert.strictEqual(epub.spine.length, 3);
    assert.deepStrictEqual(epub.spine.map((r) => r.properties), ['page-spread-right', 'page-spread-left', 'page-spread-right'],
      'page sides come from page.yaml');
    assert.ok(!epub.items.some((i) => i.properties === 'cover-image'), 'no cover in this edition');
    assert.match(epub.byName.get('OEBPS/page-003.xhtml').data.toString('utf8'), /content="width=16, height=24"/);
    assert.deepStrictEqual(elements(epub.nav, 'a').map((a) => a.href), ['page-001.xhtml', 'page-002.xhtml', 'page-003.xhtml']);

    // Recorded in edition.yaml, and the document still follows the schema.
    const after = yaml.parse(fs.readFileSync(w.edition, 'utf8'));
    assert.deepStrictEqual(after.exports, [
      { format: 'images', file: `editions/ED_001_01/exports/${BASE}-images.zip`, built_at: '2026-11-26T10:00:00Z' },
      { format: 'epub', file: `editions/ED_001_01/exports/${BASE}.epub`, built_at: '2026-11-26T10:00:00Z' },
    ]);
    assert.ok(validateDoc('edition', after).valid, validateDoc('edition', after).errors.join('; '));

    // Never overwrite: the folder alone is enough to skip the images export.
    fs.rmSync(path.join(w.exports, `${BASE}-images.zip`));
    fs.writeFileSync(path.join(dir, '001.png'), 'hand-edited, must survive');
    const again = buildEdition(w.edition, { formats: 'images,epub', now: NOW });
    assert.deepStrictEqual(again.written, []);
    assert.deepStrictEqual(again.skipped.map((s) => [s.format, s.reason]), [['images', 'exists'], ['epub', 'exists']]);
    assert.strictEqual(fs.readFileSync(path.join(dir, '001.png'), 'utf8'), 'hand-edited, must survive');
    // --force on a draft rebuilds both from an empty folder.
    fs.writeFileSync(path.join(dir, 'stale.txt'), 'left over');
    const forced = buildEdition(w.edition, { formats: 'images', force: true, now: NOW });
    assert.deepStrictEqual(forced.written.map((x) => x.format), ['images']);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['001.png', '002.png', '003.jpg']);
    assert.ok(fs.existsSync(path.join(w.exports, `${BASE}-images.zip`)));
    // --force is still refused once the edition is not a draft.
    editYaml(w.edition, (doc) => { doc.status = 'reviewed'; });
    assert.deepStrictEqual(buildEdition(w.edition, { formats: 'epub', force: true }).errors.map((e) => e.code), ['force-not-draft']);
  }

  // --- a draft build marks the new formats too -------------------------------------------------
  {
    const w = workspace();
    fs.rmSync(w.abs('issues/ISS_001/pages/PG_001_003/reviews/PG_001_003_V01.review.yaml'));
    assert.deepStrictEqual(buildEdition(w.edition, { formats: 'images,epub', now: NOW }).errors.map((e) => e.code), ['review-gate']);
    assert.ok(!fs.existsSync(w.exports), 'a refused build writes nothing');
    const draft = buildEdition(w.edition, { formats: 'images,epub', draft: true, now: NOW });
    assert.strictEqual(draft.ok, true, JSON.stringify(draft.errors));
    assert.deepStrictEqual(fs.readdirSync(w.exports).sort(), [`${BASE}-DRAFT-images`, `${BASE}-DRAFT-images.zip`, `${BASE}-DRAFT.epub`]);
    const epub = readEpub(fs.readFileSync(path.join(w.exports, `${BASE}-DRAFT.epub`)));
    assert.match(epub.opf, /<dc:title>The Night Ferry - Crossing \(DRAFT\)<\/dc:title>/);
    assert.match(epub.opf, /<dc:description>ED_001_01 DRAFT: 1 of 3 pages has no passing review<\/dc:description>/);
    assert.match(epub.byName.get('OEBPS/page-001.xhtml').data.toString('utf8'), /class="draft"[^>]*>DRAFT: 1 of 3 pages has no passing review</);
    // A draft and a final build of one edition are different publications.
    const final = workspace();
    buildEdition(final.edition, { formats: 'epub', now: NOW });
    const finalOpf = readEpub(fs.readFileSync(path.join(final.exports, `${BASE}.epub`))).opf;
    const idOf = (opf) => /<dc:identifier id="pub-id">([^<]+)</.exec(opf)[1];
    assert.notStrictEqual(idOf(epub.opf), idOf(finalOpf));
    assert.ok(!/DRAFT/.test(finalOpf));
  }

  // --- the cover is the first page of every format ---------------------------------------------
  {
    const w = workspace();
    addCover(w);
    editYaml(w.edition, (doc) => {
      doc.cover = { render: 'CV_001_V01', file: COVER_RENDER, lettered_file: null };
    });
    assert.ok(validateDoc('edition', yaml.parse(fs.readFileSync(w.edition, 'utf8'))).valid);
    const coverBytes = fs.readFileSync(w.abs(COVER_RENDER));
    const result = buildEdition(w.edition, { formats: 'pdf,cbz,web,images,epub', now: NOW });
    assert.deepStrictEqual(result.errors, [], JSON.stringify(result.errors));
    assert.deepStrictEqual(result.formats, ['pdf', 'cbz', 'web', 'images', 'epub']);
    assert.deepStrictEqual(result.shipped, [
      { page: 'CV_001', render: 'CV_001_V01', verdict: 'pass' },
      { page: 'PG_001_001', render: 'PG_001_001_V01', verdict: 'pass' },
      { page: 'PG_001_002', render: 'PG_001_002_V02', verdict: 'fixed' },
      { page: 'PG_001_003', render: 'PG_001_003_V01', verdict: 'pass' },
    ]);
    assert.deepStrictEqual(result.gate[0], { page: 'CV_001', render: 'CV_001_V01', verdict: 'pass', passes: true });

    // CBZ: the cover sorts first and is marked FrontCover; the pages keep their numbers.
    const cbz = readZip(fs.readFileSync(path.join(w.exports, `${BASE}.cbz`)));
    assert.deepStrictEqual(cbz.map((e) => e.name), ['000-cover.png', '001.png', '002.png', '003.jpg', 'ComicInfo.xml']);
    assert.deepStrictEqual(cbz.slice(0, 4).map((e) => e.name), cbz.slice(0, 4).map((e) => e.name).sort(), 'name order is reading order');
    assert.ok(cbz[0].data.equals(coverBytes));
    const info = cbz[4].data.toString('utf8');
    assert.match(info, /<PageCount>4<\/PageCount>/);
    assert.match(info, /<Page Image="0" Type="FrontCover" ImageSize="\d+" ImageWidth="40" ImageHeight="60" \/>/);
    assert.strictEqual((info.match(/Type="FrontCover"/g) || []).length, 1);
    assert.match(info, /<Page Image="1" ImageSize="\d+" ImageWidth="40" ImageHeight="60" \/>/);

    // PDF: four pages, the cover first.
    const pdf = readPdf(fs.readFileSync(path.join(w.exports, `${BASE}.pdf`)));
    assert.match(pdf.text, /\/Count 4\b/);

    // Web reader: the cover image first, labelled as the cover.
    const web = path.join(w.exports, `${BASE}-web`);
    assert.deepStrictEqual(fs.readdirSync(path.join(web, 'pages')).sort(), ['000-cover.png', '001.png', '002.png', '003.jpg']);
    const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
    const imgs = elements(html, 'img');
    assert.deepStrictEqual(imgs.map((i) => [i.id, i.src, i.alt]), [
      ['p1', 'pages/000-cover.png', 'Cover'],
      ['p2', 'pages/001.png', 'Page 1'],
      ['p3', 'pages/002.png', 'Page 2'],
      ['p4', 'pages/003.jpg', 'Page 3'],
    ]);

    // Images: 000-cover first, in the folder and in the zip.
    assert.deepStrictEqual(fs.readdirSync(path.join(w.exports, `${BASE}-images`)).sort(), ['000-cover.png', '001.png', '002.png', '003.jpg']);
    const zip = readZip(fs.readFileSync(path.join(w.exports, `${BASE}-images.zip`)));
    assert.deepStrictEqual(zip.map((e) => e.name), ['000-cover.png', '001.png', '002.png', '003.jpg']);
    assert.ok(zip[0].data.equals(coverBytes));

    // EPUB: the cover is the first spine item and its image is the cover-image.
    const epub = readEpub(fs.readFileSync(path.join(w.exports, `${BASE}.epub`)));
    assert.deepStrictEqual(epub.spine.map((r) => r.idref), ['page-1', 'page-2', 'page-3', 'page-4']);
    assert.strictEqual(epub.items.find((i) => i.id === 'page-1').href, 'page-000-cover.xhtml');
    assert.deepStrictEqual(epub.items.filter((i) => i.properties === 'cover-image').map((i) => i.href), ['images/000-cover.png']);
    assert.strictEqual(epub.spine[0].properties, 'rendition:page-spread-center');
    assert.ok(epub.byName.get('OEBPS/images/000-cover.png').data.equals(coverBytes));
    assert.match(epub.nav, /<a href="page-000-cover\.xhtml">Cover<\/a>/);
    assert.match(epub.nav, /<a href="page-001\.xhtml">Page 1<\/a>/);

    const cli = spawnSync(process.execPath, [BUILD, '--edition', w.edition, '--formats', 'cbz'], { encoding: 'utf8' });
    assert.strictEqual(cli.status, 0, cli.stderr);
    assert.match(cli.stdout.trim().split('\n').pop(), /Renders shipped and their review verdicts: CV_001_V01 \(pass\), PG_001_001_V01 \(pass\)/);
    const help = spawnSync(process.execPath, [BUILD, '--help'], { encoding: 'utf8' });
    assert.match(help.stdout, /--formats pdf,cbz,web,images,epub/);
    assert.match(help.stdout, /000-cover/);
  }

  // --- cover rules in the build ------------------------------------------------------------------
  {
    const w = workspace();
    addCover(w, { verdict: null });
    const original = fs.readFileSync(w.edition, 'utf8');
    const attempt = (cover, options = {}) => {
      fs.writeFileSync(w.edition, original);
      editYaml(w.edition, (doc) => { doc.cover = cover; });
      return buildEdition(w.edition, Object.assign({ formats: 'cbz', now: NOW }, options));
    };
    const listed = { render: 'CV_001_V01', file: COVER_RENDER, lettered_file: null };

    // The review gate covers the cover.
    const gated = attempt(listed);
    assert.deepStrictEqual(gated.errors.map((e) => e.code), ['review-gate']);
    assert.match(gated.errors[0].message, /CV_001\s+CV_001_V01\s+no review/);
    assert.deepStrictEqual(gated.errors[0].renders, [{ page: 'CV_001', render: 'CV_001_V01', verdict: 'no review' }]);
    const draft = attempt(listed, { draft: true });
    assert.strictEqual(draft.ok, true);
    assert.match(readZip(fs.readFileSync(path.join(w.exports, `${BASE}-DRAFT.cbz`))).pop().data.toString('utf8'),
      /DRAFT: 1 of 4 pages has no passing review/);

    assert.deepStrictEqual(attempt({ render: 'CV_001_V01' }).errors.map((e) => e.code), ['cover-entry']);
    assert.deepStrictEqual(attempt({ render: 'PG_001_001_V01', file: COVER_RENDER }, { draft: true }).errors.map((e) => e.code), ['render-id']);
    assert.deepStrictEqual(attempt({ render: 'CV_002_V01', file: COVER_RENDER }, { draft: true }).errors.map((e) => e.code), ['render-id']);
    assert.deepStrictEqual(attempt({ render: 'CV_001_V01', file: 'issues/ISS_001/cover/renders/CV_001_V02.png' }, { draft: true }).errors.map((e) => e.code), ['file-render']);
    assert.deepStrictEqual(attempt({ render: 'CV_001_V01', file: COVER_RENDER, lettered_file: 'issues/ISS_001/cover/renders/CV_001_V01.lettered.svg' }, { draft: true }).errors.map((e) => e.code), ['file-svg']);
    fs.rmSync(w.abs(COVER_RENDER));
    assert.deepStrictEqual(attempt(listed, { draft: true }).errors.map((e) => e.code), ['file-missing']);

    // A cover in another shape than the pages stops a paged build.
    fs.writeFileSync(w.abs(COVER_RENDER), solidPng(60, 60, 'grey', [30]));
    const square = attempt(listed, { draft: true });
    assert.deepStrictEqual(square.errors.map((e) => e.code), ['aspect']);
    assert.match(square.errors[0].message, /^CV_001 is 60x60/);
    // In a webtoon the cover is not a scroll segment and is left out of the comparison.
    editYaml(path.join(w.root, 'project.yaml'), (doc) => { doc.comic_format = 'webtoon'; });
    assert.strictEqual(attempt(listed, { draft: true, force: true }).ok, true);
    // cover: null is the same as no cover.
    editYaml(path.join(w.root, 'project.yaml'), (doc) => { doc.comic_format = 'paged'; });
    const none = attempt(null, { draft: true, force: true });
    assert.strictEqual(none.ok, true);
    assert.deepStrictEqual(readZip(fs.readFileSync(path.join(w.exports, `${BASE}-DRAFT.cbz`))).map((e) => e.name),
      ['001.png', '002.png', '003.jpg', 'ComicInfo.xml']);
  }

  // --- comicInfoXml: the page type is optional ---------------------------------------------------
  {
    const xml = comicInfoXml({ title: 'T', pages: [{ size: 1, width: 2, height: 3, type: 'FrontCover' }, { size: 1, width: 2, height: 3 }] });
    assert.match(xml, /<Page Image="0" Type="FrontCover" ImageSize="1" ImageWidth="2" ImageHeight="3" \/>/);
    assert.match(xml, /<Page Image="1" ImageSize="1" ImageWidth="2" ImageHeight="3" \/>/);
  }

  // --- draftEdition ------------------------------------------------------------------------------
  {
    const w = workspace();
    const before = fs.readFileSync(w.edition, 'utf8');
    const edition = draftEdition({ root: w.root, issue: 'ISS_001', now: NOW });
    assert.strictEqual(fs.readFileSync(w.edition, 'utf8'), before, 'nothing is written');
    assert.deepStrictEqual(fs.readdirSync(path.join(w.root, 'editions')), ['ED_001_01']);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(edition)), {
      id: 'ED_001_02',
      issue: 'ISS_001',
      title: 'The Night Ferry - Crossing',
      label: 'second edition',
      status: 'draft',
      supersedes: 'ED_001_01',
      changes: [],
      pages: [
        { page: 'PG_001_001', render: 'PG_001_001_V01', file: 'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png', lettered_file: null },
        { page: 'PG_001_002', render: 'PG_001_002_V02', file: 'issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V02.png', lettered_file: null },
        { page: 'PG_001_003', render: 'PG_001_003_V01', file: 'issues/ISS_001/pages/PG_001_003/renders/PG_001_003_V01.jpg', lettered_file: null },
      ],
      exports: [],
      created_at: '2026-11-26',
    });
    assert.deepStrictEqual(edition.blockers, [], 'every page has a passing review');
    assert.ok(!Object.keys(edition).includes('blockers'), 'blockers is not part of the document');
    assert.ok(!/blockers/.test(yaml.stringify(edition)));
    const check = validateDoc('edition', yaml.parse(yaml.stringify(edition)));
    assert.ok(check.valid, check.errors.join('; '));

    // The composed edition builds once it is written where its ID says.
    const file = path.join(w.root, 'editions', edition.id, 'edition.yaml');
    writeYaml(file, edition);
    const built = buildEdition(file, { formats: 'cbz', now: NOW });
    assert.strictEqual(built.ok, true, JSON.stringify(built.errors));
    assert.deepStrictEqual(built.written.map((x) => x.file), ['editions/ED_001_02/exports/the-night-ferry-001-ed02.cbz']);
    // The next one takes the next free ID and supersedes the latest.
    const third = draftEdition({ root: w.root, issue: 'ISS_001', now: NOW });
    assert.deepStrictEqual([third.id, third.label, third.supersedes], ['ED_001_03', 'third edition', 'ED_001_02']);
    // A gap in the directories is not reused.
    fs.mkdirSync(path.join(w.root, 'editions', 'ED_001_07'));
    assert.strictEqual(draftEdition({ root: w.root, issue: 'ISS_001' }).id, 'ED_001_08');
    fs.rmdirSync(path.join(w.root, 'editions', 'ED_001_07'));

    // What blocks a final edition, and what changed since the superseded one.
    const page1 = w.abs('issues/ISS_001/pages/PG_001_001/page.yaml');
    const page2 = w.abs('issues/ISS_001/pages/PG_001_002/page.yaml');
    const page3 = w.abs('issues/ISS_001/pages/PG_001_003/page.yaml');
    editYaml(page2, (doc) => { doc.current_render = 'PG_001_002_V01'; });
    fs.rmSync(w.abs('issues/ISS_001/pages/PG_001_003/reviews/PG_001_003_V01.review.yaml'));
    const blocked = draftEdition({ root: w.root, issue: 'ISS_001', now: NOW });
    assert.deepStrictEqual(blocked.pages.map((p) => p.render), ['PG_001_001_V01', 'PG_001_002_V01', 'PG_001_003_V01'],
      'the current render is listed even when it has no passing review');
    assert.deepStrictEqual(blocked.blockers.map((b) => [b.page, b.render, b.code]), [
      ['PG_001_002', 'PG_001_002_V01', 'not_passing'],
      ['PG_001_003', 'PG_001_003_V01', 'no_review'],
    ]);
    assert.match(blocked.blockers[0].message, /verdict flagged/);
    assert.deepStrictEqual(blocked.changes, ['PG_001_002 uses V01 instead of V02']);
    // Such an edition builds only as a draft.
    writeYaml(path.join(w.root, 'editions', blocked.id, 'edition.yaml'), blocked);
    const blockedFile = path.join(w.root, 'editions', blocked.id, 'edition.yaml');
    assert.deepStrictEqual(buildEdition(blockedFile, { formats: 'cbz', now: NOW }).errors.map((e) => e.code), ['review-gate']);
    assert.strictEqual(buildEdition(blockedFile, { formats: 'cbz', draft: true, now: NOW }).ok, true);
    fs.rmSync(path.join(w.root, 'editions', blocked.id), { recursive: true });

    // A page with no render is left out and reported; so is a render that is not on disk.
    editYaml(page1, (doc) => { doc.current_render = null; });
    editYaml(page3, (doc) => { doc.current_render = 'PG_001_003_V04'; });
    const gaps = draftEdition({ root: w.root, issue: 'ISS_001', now: NOW });
    assert.deepStrictEqual(gaps.pages.map((p) => p.page), ['PG_001_002']);
    assert.deepStrictEqual(gaps.blockers.map((b) => [b.page, b.render, b.code]), [
      ['PG_001_001', null, 'no_render'],
      ['PG_001_002', 'PG_001_002_V01', 'not_passing'],
      ['PG_001_003', 'PG_001_003_V04', 'render_missing'],
    ]);
    assert.ok(gaps.changes.includes('PG_001_001 removed') && gaps.changes.includes('PG_001_003 removed'));

    assert.throws(() => draftEdition({ root: w.root, issue: 'ISS_002' }), (err) => err.code === 'issue_missing');
    assert.throws(() => draftEdition({ root: w.root, issue: 'ED_001_01' }), (err) => err.code === 'bad_arguments');
  }

  // --- draftEdition and the cover ----------------------------------------------------------------
  {
    const w = workspace();
    fs.rmSync(path.join(w.root, 'editions'), { recursive: true });
    // A draft cover stays out.
    addCover(w, { status: 'draft' });
    const without = draftEdition({ root: w.root, issue: 'ISS_001', now: NOW });
    assert.deepStrictEqual([without.id, without.label, without.supersedes], ['ED_001_01', 'first edition', null]);
    assert.ok(!('cover' in without));
    assert.deepStrictEqual(without.changes, []);
    // An approved cover goes in, before the pages.
    addCover(w, { status: 'approved' });
    const withCover = draftEdition({ root: w.root, issue: 'ISS_001', now: NOW });
    assert.deepStrictEqual(withCover.cover, { render: 'CV_001_V01', file: COVER_RENDER, lettered_file: null });
    assert.deepStrictEqual(Object.keys(withCover).slice(-4), ['cover', 'pages', 'exports', 'created_at']);
    assert.deepStrictEqual(withCover.blockers, []);
    const file = path.join(w.root, 'editions', withCover.id, 'edition.yaml');
    writeYaml(file, withCover);
    const built = buildEdition(file, { formats: 'images', now: NOW });
    assert.strictEqual(built.ok, true, JSON.stringify(built.errors));
    assert.strictEqual(built.shipped[0].render, 'CV_001_V01');
    // The next edition says nothing changed; drop the approval and it says the cover went.
    assert.deepStrictEqual(draftEdition({ root: w.root, issue: 'ISS_001' }).changes, []);
    editYaml(w.abs(COVER_FILE), (doc) => { doc.status = 'draft'; doc.approved_render = null; });
    assert.deepStrictEqual(draftEdition({ root: w.root, issue: 'ISS_001' }).changes, ['cover removed']);
    // An approved cover whose review no longer passes is a blocker.
    addCover(w, { status: 'approved', verdict: 'flagged' });
    const flagged = draftEdition({ root: w.root, issue: 'ISS_001' });
    assert.deepStrictEqual(flagged.blockers.map((b) => [b.page, b.render, b.code]), [['CV_001', 'CV_001_V01', 'not_passing']]);
    assert.strictEqual(flagged.cover.render, 'CV_001_V01');
  }

  // --- registerLetteredFile ------------------------------------------------------------------------
  {
    const w = workspace();
    const lettered = solidPng(40, 60, 'rgb', [10, 20, 30]);
    const render = 'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png';
    const renderBytes = fs.readFileSync(w.abs(render));
    const target = 'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.lettered.png';

    const stored = registerLetteredFile({ root: w.root, page: 'PG_001_001', render: 'PG_001_001_V01', file: lettered });
    assert.deepStrictEqual(stored, { path: target, render: 'PG_001_001_V01', editions: ['ED_001_01'], skipped: [] });
    assert.ok(fs.readFileSync(w.abs(target)).equals(lettered));
    assert.ok(fs.readFileSync(w.abs(render)).equals(renderBytes), 'the render is never touched');

    // Recorded where the data model puts it: on that render's entry of the draft edition.
    const text = fs.readFileSync(w.edition, 'utf8');
    const doc = yaml.parse(text);
    assert.strictEqual(doc.pages[0].lettered_file, target);
    assert.strictEqual(doc.pages[1].lettered_file, null);
    assert.match(text, /^# Fixture edition\. This header comment survives a build\./, 'comments survive');
    assert.match(text, /# the repaired render, not V01/);
    assert.ok(validateDoc('edition', doc).valid);

    // The edition now ships the lettered file in every format.
    const built = buildEdition(w.edition, { formats: 'cbz,images,epub', now: NOW });
    assert.strictEqual(built.ok, true, JSON.stringify(built.errors));
    assert.ok(readZip(fs.readFileSync(path.join(w.exports, `${BASE}.cbz`)))[0].data.equals(lettered));
    assert.ok(fs.readFileSync(path.join(w.exports, `${BASE}-images`, '001.png')).equals(lettered));
    assert.ok(readEpub(fs.readFileSync(path.join(w.exports, `${BASE}.epub`))).byName.get('OEBPS/images/001.png').data.equals(lettered));

    // Defaults: the render comes from the page's current_render; a path works as well as bytes.
    const source = path.join(w.root, 'upload.jpg');
    fs.writeFileSync(source, greyJpeg());
    const second = registerLetteredFile({ root: w.root, page: 'PG_001_002', file: source });
    assert.strictEqual(second.render, 'PG_001_002_V02');
    assert.strictEqual(second.path, 'issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V02.lettered.jpg');
    assert.strictEqual(yaml.parse(fs.readFileSync(w.edition, 'utf8')).pages[1].lettered_file, second.path);
    // Storing it again in the other format leaves one lettered file for the render.
    const third = registerLetteredFile({ root: w.root, render: 'PG_001_002_V02', file: lettered });
    assert.strictEqual(third.path, 'issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V02.lettered.png');
    assert.ok(!fs.existsSync(w.abs(second.path)), 'the earlier .jpg is gone');
    assert.strictEqual(yaml.parse(fs.readFileSync(w.edition, 'utf8')).pages[1].lettered_file, third.path);

    // draftEdition picks the stored files up.
    const composed = draftEdition({ root: w.root, issue: 'ISS_001', now: NOW });
    assert.deepStrictEqual(composed.pages.map((p) => p.lettered_file), [target, third.path, null]);

    // A render no edition lists is stored and recorded nowhere.
    const loose = registerLetteredFile({ root: w.root, render: 'PG_001_002_V01', file: lettered });
    assert.deepStrictEqual([loose.editions, loose.skipped], [[], []]);
    assert.ok(fs.existsSync(w.abs(loose.path)));

    // A reviewed edition is left as it is, and the file it ships is not replaced.
    editYaml(w.edition, (d) => { d.status = 'reviewed'; });
    const frozen = fs.readFileSync(w.edition, 'utf8');
    const page3 = registerLetteredFile({ root: w.root, render: 'PG_001_003_V01', file: lettered });
    assert.deepStrictEqual([page3.editions, page3.skipped], [[], ['ED_001_01']]);
    assert.strictEqual(fs.readFileSync(w.edition, 'utf8'), frozen, 'a reviewed edition is not edited');
    assert.throws(() => registerLetteredFile({ root: w.root, render: 'PG_001_001_V01', file: solidPng(40, 60, 'grey', [1]) }),
      (err) => err.code === 'lettered-file-shipped' && /ED_001_01, which is reviewed/.test(err.message));
    assert.ok(fs.readFileSync(w.abs(target)).equals(lettered), 'the shipped lettered file is unchanged');

    // Refusals.
    const refuses = (options, code) => assert.throws(() => registerLetteredFile(Object.assign({ root: w.root }, options)),
      (err) => err.code === code, `expected ${code}`);
    refuses({ render: 'PG_001_009_V01', file: lettered }, 'render-missing');
    refuses({ render: 'not-a-render', file: lettered }, 'render-id');
    refuses({ page: 'PG_001_002', render: 'PG_001_001_V01', file: lettered }, 'render-page');
    refuses({ render: 'PG_001_002_V01', file: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') }, 'file-format');
    refuses({ render: 'PG_001_002_V01', file: path.join(w.root, 'missing.png') }, 'file-missing');
    refuses({ render: 'PG_001_002_V01' }, 'file-missing');
    assert.throws(() => registerLetteredFile({ root: path.join(w.root, 'issues'), render: 'PG_001_002_V01', file: lettered }),
      (err) => err.code === 'no-workspace');
  }

  // --- registerLetteredFile: a cover, an edition without the key, and the CLI ----------------------
  {
    const w = workspace();
    addCover(w);
    // An edition written by hand with no lettered_file keys at all.
    fs.writeFileSync(w.edition, [
      'id: ED_001_01',
      'issue: ISS_001',
      'title: The Night Ferry - Crossing',
      'label: first edition',
      'status: draft',
      'cover:',
      '  render: CV_001_V01   # the approved cover',
      `  file: ${COVER_RENDER}`,
      'pages:',
      '  - page: PG_001_001',
      '    render: PG_001_001_V01',
      '    file: issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.png',
      'exports: []',
      '',
    ].join('\n'));
    const lettered = solidPng(40, 60, 'grey', [77]);
    const cover = registerLetteredFile({ root: w.root, page: 'CV_001', render: 'CV_001_V01', file: lettered });
    assert.strictEqual(cover.path, 'issues/ISS_001/cover/renders/CV_001_V01.lettered.png');
    assert.deepStrictEqual(cover.editions, ['ED_001_01']);
    let text = fs.readFileSync(w.edition, 'utf8');
    assert.match(text, /# the approved cover/, 'the key is added without rewriting the file');
    assert.strictEqual(yaml.parse(text).cover.lettered_file, cover.path);
    assert.ok(!('lettered_file' in yaml.parse(text).pages[0]));

    // The CLI form, for a page.
    const source = path.join(w.root, 'page1.png');
    fs.writeFileSync(source, lettered);
    const cli = spawnSync(process.execPath, [LETTER, '--register-lettered', source, '--render', 'PG_001_001_V01', '--root', w.root], { encoding: 'utf8' });
    assert.strictEqual(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /stored issues\/ISS_001\/pages\/PG_001_001\/renders\/PG_001_001_V01\.lettered\.png/);
    assert.match(cli.stdout, /ED_001_01: lettered_file set for PG_001_001_V01/);
    text = fs.readFileSync(w.edition, 'utf8');
    assert.strictEqual(yaml.parse(text).pages[0].lettered_file, 'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.lettered.png');
    const bad = spawnSync(process.execPath, [LETTER, '--register-lettered', source, '--root', w.root], { encoding: 'utf8' });
    assert.strictEqual(bad.status, 1);
    assert.match(bad.stderr, /needs --render/);

    // The build ships the lettered cover.
    const built = buildEdition(w.edition, { formats: 'images', now: NOW });
    assert.strictEqual(built.ok, true, JSON.stringify(built.errors));
    assert.ok(fs.readFileSync(path.join(w.exports, `${BASE}-images`, '000-cover.png')).equals(lettered));
    assert.ok(fs.readFileSync(path.join(w.exports, `${BASE}-images`, '001.png')).equals(lettered));
    assert.strictEqual(draftEdition({ root: w.root, issue: 'ISS_001' }).cover.lettered_file, cover.path);
    assert.ok(ws.renderFile(w.root, 'CV_001_V01').endsWith('CV_001_V01.png'), 'the lettered file is not taken for the render');
  }

  console.log('edition-formats: OK');
} finally {
  roots.forEach(cleanup);
}
