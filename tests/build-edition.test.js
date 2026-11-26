'use strict';
/** scripts/build-edition.js: review gate, page rules, exports, no-overwrite. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('../scripts/lib/yaml');
const { readZip } = require('../scripts/lib/zip');
const { buildEdition, resolveFormats, editionText, slugify } = require('../scripts/build-edition');
const { FIXTURE, makeWorkspace, cleanup, editYaml, readPdf, solidPng } = require('./fixtures/publishing/helpers');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'build-edition.js');
const NOW = new Date(Date.UTC(2026, 10, 26, 10, 0, 0));
const roots = [];

function workspace() {
  const root = makeWorkspace();
  roots.push(root);
  return {
    root,
    edition: path.join(root, 'editions', 'ED_001_01', 'edition.yaml'),
    exports: path.join(root, 'editions', 'ED_001_01', 'exports'),
    render: (page, name) => path.join(root, 'issues', 'ISS_001', 'pages', page, 'renders', name),
    review: (page, render) => path.join(root, 'issues', 'ISS_001', 'pages', page, 'reviews', `${render}.review.yaml`),
  };
}
const codes = (result) => result.errors.map((e) => e.code);
const listExports = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

try {
  // --- a clean build: all three formats, from the project's deliverables --------------------
  {
    const w = workspace();
    const before = yaml.parse(fs.readFileSync(w.edition, 'utf8'));
    const result = buildEdition(w.edition, { now: NOW });
    assert.deepStrictEqual(result.errors, [], JSON.stringify(result.errors));
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.formats, ['pdf', 'cbz', 'web'], 'formats come from project.deliverables');
    assert.deepStrictEqual(listExports(w.exports), [
      'the-night-ferry-001-ed01-web',
      'the-night-ferry-001-ed01.cbz',
      'the-night-ferry-001-ed01.pdf',
    ]);
    assert.deepStrictEqual(result.written.map((x) => x.file), [
      'editions/ED_001_01/exports/the-night-ferry-001-ed01.pdf',
      'editions/ED_001_01/exports/the-night-ferry-001-ed01.cbz',
      'editions/ED_001_01/exports/the-night-ferry-001-ed01-web/index.html',
    ]);
    assert.deepStrictEqual(result.shipped, [
      { page: 'PG_001_001', render: 'PG_001_001_V01', verdict: 'pass' },
      { page: 'PG_001_002', render: 'PG_001_002_V02', verdict: 'fixed' },
      { page: 'PG_001_003', render: 'PG_001_003_V01', verdict: 'pass' },
    ]);

    // CBZ: pages renamed in reading order, plus ComicInfo.xml.
    const cbz = readZip(fs.readFileSync(path.join(w.exports, 'the-night-ferry-001-ed01.cbz')));
    assert.deepStrictEqual(cbz.map((e) => e.name), ['001.png', '002.png', '003.jpg', 'ComicInfo.xml']);
    assert.ok(cbz[0].data.equals(fs.readFileSync(w.render('PG_001_001', 'PG_001_001_V01.png'))), 'page 1 is the listed render');
    assert.ok(cbz[1].data.equals(fs.readFileSync(w.render('PG_001_002', 'PG_001_002_V02.png'))), 'page 2 is V02, not V01');
    assert.ok(cbz[2].data.equals(fs.readFileSync(w.render('PG_001_003', 'PG_001_003_V01.jpg'))));
    assert.strictEqual(cbz[0].method, 0, 'images are stored, not recompressed');
    const info = cbz[3].data.toString('utf8');
    assert.match(info, /^<\?xml version="1\.0" encoding="utf-8"\?>\n<ComicInfo /);
    assert.match(info, /<Title>Crossing<\/Title>/);
    assert.match(info, /<Series>The Night Ferry<\/Series>/);
    assert.match(info, /<Number>1<\/Number>/);
    assert.match(info, /<PageCount>3<\/PageCount>/);
    assert.match(info, /<LanguageISO>en<\/LanguageISO>/);
    assert.match(info, /<Manga>No<\/Manga>/);
    assert.match(info, /<BlackAndWhite>Yes<\/BlackAndWhite>/);
    assert.strictEqual((info.match(/<Page Image=/g) || []).length, 3);
    assert.match(info, /<Page Image="2" ImageSize="\d+" ImageWidth="16" ImageHeight="24" \/>/);
    assert.ok(!/DRAFT/.test(info));

    // PDF: three pages, valid xref (readPdf checks every offset), no stamp.
    const pdf = readPdf(fs.readFileSync(path.join(w.exports, 'the-night-ferry-001-ed01.pdf')));
    assert.strictEqual(pdf.objects.filter((o) => /\/Type \/Page[^s]/.test(o.body)).length, 3);
    assert.match(pdf.text, /\/Count 3\b/);
    assert.match(pdf.text, /\/Title \(The Night Ferry - Crossing\)/);
    assert.match(pdf.text, /\/Filter \/DCTDecode/, 'the JPEG page is embedded as JPEG');
    assert.match(pdf.text, /\/SMask \d+ 0 R/, 'the RGBA page keeps its alpha');
    assert.ok(!/\(DRAFT\) Tj/.test(pdf.text));
    assert.ok(!/\/Author/.test(pdf.text));

    // Web reader: self-contained directory.
    const web = path.join(w.exports, 'the-night-ferry-001-ed01-web');
    assert.deepStrictEqual(fs.readdirSync(web).sort(), ['index.html', 'pages']);
    assert.deepStrictEqual(fs.readdirSync(path.join(web, 'pages')).sort(), ['001.png', '002.png', '003.jpg']);
    const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<title>The Night Ferry - Crossing<\/title>/);
    assert.match(html, /<body class="pages" data-direction="ltr">/);
    assert.strictEqual((html.match(/<img class="page"/g) || []).length, 3);
    assert.match(html, /src="pages\/001\.png" alt="Page 1" width="40" height="60"/);
    assert.match(html, /src="pages\/003\.jpg"/);
    assert.match(html, /addEventListener\('keydown'/, 'keyboard navigation');
    assert.match(html, /reader\.onclick/, 'click navigation');
    assert.ok(!/https?:\/\//.test(html.replace(/http:\/\/www\.w3\.org\/[^"]*/g, '')), 'no external resources');
    assert.ok(!/DRAFT/.test(html));

    // edition.yaml: exports recorded, everything else unchanged.
    const after = yaml.parse(fs.readFileSync(w.edition, 'utf8'));
    assert.deepStrictEqual(after.exports, [
      { format: 'pdf', file: 'editions/ED_001_01/exports/the-night-ferry-001-ed01.pdf', built_at: '2026-11-26T10:00:00Z' },
      { format: 'cbz', file: 'editions/ED_001_01/exports/the-night-ferry-001-ed01.cbz', built_at: '2026-11-26T10:00:00Z' },
      { format: 'web', file: 'editions/ED_001_01/exports/the-night-ferry-001-ed01-web/index.html', built_at: '2026-11-26T10:00:00Z' },
    ]);
    assert.deepStrictEqual({ ...after, exports: [] }, before, 'the rest of edition.yaml survives the rewrite');
    // Only the exports block is replaced: comments and quoting elsewhere stay.
    const afterText = fs.readFileSync(w.edition, 'utf8');
    const beforeText = fs.readFileSync(path.join(FIXTURE, 'editions', 'ED_001_01', 'edition.yaml'), 'utf8').replace(/\r\n/g, '\n');
    const [head, tail] = beforeText.split('exports: []\n');
    assert.ok(afterText.startsWith(head), 'everything above the exports block is untouched, comments included');
    assert.ok(afterText.endsWith(tail), 'everything below the exports block is untouched');
    assert.match(afterText, /# the repaired render, not V01/);
    assert.match(afterText, /created_at: "2026-11-26"\n$/);
    assert.ok(!result.warnings.some((x) => x.code === 'edition-rewritten'));
    assert.deepStrictEqual(Object.keys(after), Object.keys(before), 'key order survives');
    assert.strictEqual(after.created_at, '2026-11-26', 'date strings stay strings');

    // --- never overwrite ---------------------------------------------------------------------
    const pdfFile = path.join(w.exports, 'the-night-ferry-001-ed01.pdf');
    const cbzFile = path.join(w.exports, 'the-night-ferry-001-ed01.cbz');
    fs.writeFileSync(pdfFile, 'hand-edited, must survive');
    const editionText = fs.readFileSync(w.edition, 'utf8');
    const again = buildEdition(w.edition, { now: new Date(Date.UTC(2027, 0, 1)) });
    assert.strictEqual(again.ok, true);
    assert.deepStrictEqual(again.written, []);
    assert.deepStrictEqual(again.skipped.map((s) => s.format), ['pdf', 'cbz', 'web']);
    assert.ok(again.skipped.every((s) => s.reason === 'exists'));
    assert.strictEqual(fs.readFileSync(pdfFile, 'utf8'), 'hand-edited, must survive', 'existing export untouched');
    assert.strictEqual(fs.readFileSync(w.edition, 'utf8'), editionText, 'edition.yaml untouched when nothing was built');

    // One missing export is built; the others are still skipped.
    fs.rmSync(cbzFile);
    const partial = buildEdition(w.edition, { now: new Date(Date.UTC(2027, 0, 2)) });
    assert.deepStrictEqual(partial.written.map((x) => x.format), ['cbz']);
    assert.deepStrictEqual(partial.skipped.map((s) => s.format), ['pdf', 'web']);
    const partialDoc = yaml.parse(fs.readFileSync(w.edition, 'utf8'));
    assert.strictEqual(partialDoc.exports.length, 3, 'the cbz entry is replaced, not duplicated');
    assert.strictEqual(partialDoc.exports[1].built_at, '2027-01-02T00:00:00Z');
    assert.strictEqual(partialDoc.exports[0].built_at, '2026-11-26T10:00:00Z');

    // --force replaces.
    fs.writeFileSync(path.join(web, 'stale.txt'), 'left over');
    const forced = buildEdition(w.edition, { force: true, now: new Date(Date.UTC(2027, 0, 3)) });
    assert.deepStrictEqual(forced.written.map((x) => x.format), ['pdf', 'cbz', 'web']);
    assert.deepStrictEqual(forced.skipped, []);
    assert.strictEqual(fs.readFileSync(pdfFile, 'latin1').slice(0, 8), '%PDF-1.4');
    assert.ok(!fs.existsSync(path.join(web, 'stale.txt')), 'a forced web export starts from an empty directory');
    assert.strictEqual(yaml.parse(fs.readFileSync(w.edition, 'utf8')).exports.length, 3);

    // --force is refused once the edition is no longer a draft.
    const draftText = fs.readFileSync(w.edition, 'utf8');
    assert.ok(/^status: draft$/m.test(draftText), 'fixture edition starts as a draft');
    fs.writeFileSync(w.edition, draftText.replace(/^status: draft$/m, 'status: published'));
    const refused = buildEdition(w.edition, { force: true });
    assert.strictEqual(refused.ok, false);
    assert.deepStrictEqual(refused.errors.map((e) => e.code), ['force-not-draft']);
    assert.strictEqual(fs.readFileSync(pdfFile, 'latin1').slice(0, 8), '%PDF-1.4', 'the published export is untouched');
    fs.writeFileSync(w.edition, draftText);
  }

  // --- the review gate -----------------------------------------------------------------------
  {
    const w = workspace();
    // List the flagged render of page 2 and remove the review of page 3.
    editYaml(w.edition, (doc) => {
      doc.pages[1].render = 'PG_001_002_V01';
      doc.pages[1].file = 'issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V01.png';
    });
    fs.rmSync(w.review('PG_001_003', 'PG_001_003_V01'));
    const editionText = fs.readFileSync(w.edition, 'utf8');

    const refused = buildEdition(w.edition, { now: NOW });
    assert.strictEqual(refused.ok, false);
    assert.deepStrictEqual(codes(refused), ['review-gate']);
    const gate = refused.errors[0];
    assert.match(gate.message, /PG_001_002\s+PG_001_002_V01\s+flagged/);
    assert.match(gate.message, /PG_001_003\s+PG_001_003_V01\s+no review/);
    assert.ok(!/PG_001_001_V01/.test(gate.message), 'the passing page is not listed');
    assert.deepStrictEqual(gate.renders, [
      { page: 'PG_001_002', render: 'PG_001_002_V01', verdict: 'flagged' },
      { page: 'PG_001_003', render: 'PG_001_003_V01', verdict: 'no review' },
    ]);
    assert.deepStrictEqual(listExports(w.exports), [], 'a refused build writes nothing');
    assert.strictEqual(fs.readFileSync(w.edition, 'utf8'), editionText);

    // Same edition through the CLI: exit 1, every offending page on stderr.
    const cli = spawnSync(process.execPath, [SCRIPT, '--edition', w.edition], { encoding: 'utf8' });
    assert.strictEqual(cli.status, 1);
    assert.match(cli.stderr, /PG_001_002_V01\s+flagged/);
    assert.match(cli.stderr, /PG_001_003_V01\s+no review/);
    assert.match(cli.stderr, /--draft/);
    assert.deepStrictEqual(listExports(w.exports), []);

    // --draft goes through and marks everything.
    const draft = buildEdition(w.edition, { draft: true, now: NOW });
    assert.strictEqual(draft.ok, true, JSON.stringify(draft.errors));
    assert.strictEqual(draft.draft, true);
    assert.deepStrictEqual(listExports(w.exports), [
      'the-night-ferry-001-ed01-DRAFT-web',
      'the-night-ferry-001-ed01-DRAFT.cbz',
      'the-night-ferry-001-ed01-DRAFT.pdf',
    ]);
    assert.ok(draft.written.every((x) => /-DRAFT/.test(x.file)), 'every export name carries -DRAFT');
    assert.ok(draft.warnings.some((x) => x.code === 'review-gate' && /flagged/.test(x.message) && /no review/.test(x.message)));
    assert.deepStrictEqual(draft.shipped.map((s) => s.verdict), ['pass', 'flagged', 'no review']);
    const pdf = readPdf(fs.readFileSync(path.join(w.exports, 'the-night-ferry-001-ed01-DRAFT.pdf')));
    assert.strictEqual((pdf.text.match(/\(DRAFT\) Tj/g) || []).length, 3, 'DRAFT stamped on every page');
    assert.match(pdf.text, /\/BaseFont \/Helvetica/);
    const cbz = readZip(fs.readFileSync(path.join(w.exports, 'the-night-ferry-001-ed01-DRAFT.cbz')));
    assert.match(cbz[cbz.length - 1].data.toString('utf8'), /<Notes>ED_001_01 DRAFT: 2 of 3 pages have no passing review<\/Notes>/);
    assert.match(fs.readFileSync(path.join(w.exports, 'the-night-ferry-001-ed01-DRAFT-web', 'index.html'), 'utf8'),
      /<div class="draft" role="note">DRAFT: 2 of 3 pages have no passing review<\/div>/);
    assert.ok(yaml.parse(fs.readFileSync(w.edition, 'utf8')).exports.every((e) => /-DRAFT/.test(e.file)));

    // A draft of an edition whose pages all passed does not claim otherwise.
    const clean = workspace();
    const cleanDraft = buildEdition(clean.edition, { draft: true, formats: 'web,cbz', now: NOW });
    assert.strictEqual(cleanDraft.ok, true);
    assert.ok(!cleanDraft.warnings.some((x) => x.code === 'review-gate'));
    assert.match(fs.readFileSync(path.join(clean.exports, 'the-night-ferry-001-ed01-DRAFT-web', 'index.html'), 'utf8'),
      /DRAFT: every page passed review, built as a draft/);

    // A review without a passing verdict is named by its verdict.
    editYaml(w.review('PG_001_001', 'PG_001_001_V01'), (doc) => { doc.verdict = 'flagged'; });
    const three = buildEdition(w.edition, { now: NOW });
    assert.strictEqual(three.errors[0].renders.length, 3);
  }

  // --- CLI on a passing edition: closing line with renders and verdicts -------------------------
  {
    const w = workspace();
    const cli = spawnSync(process.execPath, [SCRIPT, '--edition', w.edition, '--formats', 'cbz'], { encoding: 'utf8' });
    assert.strictEqual(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /wrote editions\/ED_001_01\/exports\/the-night-ferry-001-ed01\.cbz/);
    const last = cli.stdout.trim().split('\n').pop();
    assert.match(last, /Renders shipped and their review verdicts: PG_001_001_V01 \(pass\), PG_001_002_V02 \(fixed\), PG_001_003_V01 \(pass\)/);
    assert.deepStrictEqual(listExports(w.exports), ['the-night-ferry-001-ed01.cbz'], '--formats limits the build');

    const second = spawnSync(process.execPath, [SCRIPT, '--edition', w.edition, '--formats', 'cbz'], { encoding: 'utf8' });
    assert.strictEqual(second.status, 0);
    assert.match(second.stdout, /skipped editions\/ED_001_01\/exports\/the-night-ferry-001-ed01\.cbz/);

    const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
    assert.strictEqual(help.status, 0);
    assert.match(help.stdout, /comments and hand formatting in\s+edition\.yaml are lost/);
    const noArgs = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.strictEqual(noArgs.status, 1);
    const badFormat = buildEdition(w.edition, { formats: 'pdf,epub' });
    assert.deepStrictEqual(codes(badFormat), ['formats']);
  }

  // --- page rules: once each, in order, no gaps --------------------------------------------------
  {
    const w = workspace();
    const original = fs.readFileSync(w.edition, 'utf8');
    const attempt = (change) => {
      fs.writeFileSync(w.edition, original);
      editYaml(w.edition, change);
      const result = buildEdition(w.edition, { now: NOW });
      assert.strictEqual(result.ok, false);
      assert.deepStrictEqual(listExports(w.exports), [], 'nothing written on a page error');
      return result;
    };

    const swapped = attempt((doc) => { doc.pages = [doc.pages[1], doc.pages[0], doc.pages[2]]; });
    assert.ok(codes(swapped).includes('page-order'), codes(swapped).join());
    assert.match(swapped.errors.find((e) => e.code === 'page-order').message, /PG_001_001 \(page 1\) is listed after page 2/);

    const gap = attempt((doc) => { doc.pages.splice(1, 1); });
    assert.deepStrictEqual(codes(gap), ['page-gap']);
    assert.match(gap.errors[0].message, /PG_001_003 is page 3 but page 2 was expected: page 2 is missing/);

    const headless = attempt((doc) => { doc.pages.shift(); });
    assert.deepStrictEqual(codes(headless), ['page-gap']);
    assert.match(headless.errors[0].message, /page 1 is missing/);

    const twice = attempt((doc) => { doc.pages.push({ ...doc.pages[1] }); });
    assert.ok(codes(twice).includes('page-duplicate'));
    assert.match(twice.errors.find((e) => e.code === 'page-duplicate').message, /PG_001_002 is listed more than once/);

    const missing = attempt((doc) => { doc.pages[0].file = 'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V09.png'; doc.pages[0].render = 'PG_001_001_V09'; });
    assert.deepStrictEqual(codes(missing), ['file-missing']);

    const wrongFile = attempt((doc) => { doc.pages[1].file = 'issues/ISS_001/pages/PG_001_002/renders/PG_001_002_V01.png'; });
    assert.deepStrictEqual(codes(wrongFile), ['file-render'], 'the shipped file must be the reviewed render');

    const foreign = attempt((doc) => { doc.pages[0].render = 'PG_001_002_V02'; });
    assert.ok(codes(foreign).includes('render-id'));

    const outside = attempt((doc) => { doc.pages[0].file = '../PG_001_001_V01.png'; });
    assert.deepStrictEqual(codes(outside), ['file-outside']);

    const empty = attempt((doc) => { doc.pages = []; });
    assert.deepStrictEqual(codes(empty), ['no-pages']);

    const svg = attempt((doc) => { doc.pages[0].lettered_file = 'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.lettered.svg'; });
    assert.deepStrictEqual(codes(svg), ['file-svg']);
    assert.match(svg.errors[0].message, /export it to PNG or JPEG/);
  }

  // --- aspect ratio: warn within tolerance, stop beyond ---------------------------------------------
  {
    const w = workspace();
    fs.writeFileSync(w.render('PG_001_002', 'PG_001_002_V02.png'), solidPng(40, 61, 'rgb', [1, 2, 3]));
    const near = buildEdition(w.edition, { formats: 'cbz', now: NOW });
    assert.strictEqual(near.ok, true, JSON.stringify(near.errors));
    const warning = near.warnings.find((x) => x.code === 'aspect');
    assert.ok(warning, 'a 1.6% difference is a warning');
    assert.match(warning.message, /PG_001_002 is 40x61, which is 1\.6% off/);

    const w2 = workspace();
    fs.writeFileSync(w2.render('PG_001_002', 'PG_001_002_V02.png'), solidPng(40, 80, 'rgb', [1, 2, 3]));
    const far = buildEdition(w2.edition, { formats: 'cbz', now: NOW });
    assert.strictEqual(far.ok, false);
    assert.deepStrictEqual(codes(far), ['aspect']);
    assert.match(far.errors[0].message, /PG_001_002 is 40x80/);
    assert.deepStrictEqual(listExports(w2.exports), []);

    // Webtoon segments may differ in height; the reader stacks them.
    editYaml(path.join(w2.root, 'project.yaml'), (doc) => { doc.comic_format = 'webtoon'; });
    const strip = buildEdition(w2.edition, { formats: 'web', now: NOW });
    assert.strictEqual(strip.ok, true, JSON.stringify(strip.errors));
    const html = fs.readFileSync(path.join(w2.exports, 'the-night-ferry-001-ed01-web', 'index.html'), 'utf8');
    assert.match(html, /<body class="webtoon" data-direction="ltr">/, 'vertical continuous layout');
    assert.match(html, /\.webtoon \.page \{[^}]*width: 100%/);
  }

  // --- reading direction, lettered files, default formats ---------------------------------------------
  {
    const w = workspace();
    editYaml(path.join(w.root, 'project.yaml'), (doc) => {
      doc.reading_direction = 'rtl';
      doc.title = 'Señal & <Niebla>';
      delete doc.deliverables;
    });
    const lettered = solidPng(40, 60, 'rgb', [7, 8, 9]);
    fs.writeFileSync(w.render('PG_001_001', 'PG_001_001_V01.lettered.png'), lettered);
    editYaml(w.edition, (doc) => {
      doc.pages[0].lettered_file = 'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.lettered.png';
      doc.exports = [{ format: 'cbz', file: 'editions/ED_001_01/exports/planned-name.cbz', built_at: null }];
    });
    const result = buildEdition(w.edition, { now: NOW });
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.deepStrictEqual(result.formats, ['pdf', 'cbz'], 'default formats without deliverables');
    assert.deepStrictEqual(listExports(w.exports), ['senal-niebla-001-ed01.cbz', 'senal-niebla-001-ed01.pdf']);
    const cbz = readZip(fs.readFileSync(path.join(w.exports, 'senal-niebla-001-ed01.cbz')));
    assert.ok(cbz[0].data.equals(lettered), 'lettered_file replaces file');
    const info = cbz[cbz.length - 1].data.toString('utf8');
    assert.match(info, /<Manga>YesAndRightToLeft<\/Manga>/);
    assert.match(info, /<Series>Señal &amp; &lt;Niebla&gt;<\/Series>/, 'XML escaped');
    const pdf = readPdf(fs.readFileSync(path.join(w.exports, 'senal-niebla-001-ed01.pdf')));
    assert.match(pdf.text, /\/ViewerPreferences << \/Direction \/R2L >>/);
    const doc = yaml.parse(fs.readFileSync(w.edition, 'utf8'));
    assert.deepStrictEqual(doc.exports.map((e) => e.format), ['cbz', 'pdf'], 'the planned cbz entry is filled in, pdf appended');
    assert.strictEqual(doc.exports[0].file, 'editions/ED_001_01/exports/senal-niebla-001-ed01.cbz');

    const web = buildEdition(w.edition, { formats: 'web', now: NOW });
    assert.strictEqual(web.ok, true);
    const html = fs.readFileSync(path.join(w.exports, 'senal-niebla-001-ed01-web', 'index.html'), 'utf8');
    assert.match(html, /data-direction="rtl"/);
    assert.match(html, /<h1>The Night Ferry - Crossing<\/h1>/);
  }

  // --- WebP pages: fine for CBZ and web, refused up front for PDF -----------------------------------------
  {
    const w = workspace();
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'latin1');
    webp.writeUInt32LE(22, 4);
    webp.write('WEBPVP8X', 8, 'latin1');
    webp.writeUIntLE(39, 24, 3);
    webp.writeUIntLE(59, 27, 3);
    fs.writeFileSync(w.render('PG_001_001', 'PG_001_001_V01.webp'), webp);
    editYaml(w.edition, (doc) => { doc.pages[0].file = 'issues/ISS_001/pages/PG_001_001/renders/PG_001_001_V01.webp'; });
    const refused = buildEdition(w.edition, { now: NOW });
    assert.deepStrictEqual(codes(refused), ['pdf-webp']);
    assert.deepStrictEqual(listExports(w.exports), [], 'no partial build when one format cannot be made');
    const zipped = buildEdition(w.edition, { formats: 'cbz', now: NOW });
    assert.strictEqual(zipped.ok, true, JSON.stringify(zipped.errors));
    assert.deepStrictEqual(readZip(fs.readFileSync(path.join(w.exports, 'the-night-ferry-001-ed01.cbz'))).map((e) => e.name),
      ['001.webp', '002.png', '003.jpg', 'ComicInfo.xml']);
  }

  // --- helpers and bad input ------------------------------------------------------------------------
  {
    assert.deepStrictEqual(resolveFormats(undefined, {}), ['pdf', 'cbz']);
    assert.deepStrictEqual(resolveFormats(undefined, { deliverables: [{ target: 'print' }, { target: 'social-carousel' }] }), ['pdf', 'cbz']);
    assert.deepStrictEqual(resolveFormats(undefined, { deliverables: [{ target: 'web' }, { target: 'print' }] }), ['web']);
    assert.deepStrictEqual(resolveFormats('web, pdf', {}), ['pdf', 'web']);
    assert.throws(() => resolveFormats('mobi', {}), /unknown format "mobi"/);
    assert.strictEqual(slugify('The Night Ferry'), 'the-night-ferry');
    assert.strictEqual(slugify('  Señal & <Niebla>!  '), 'senal-niebla');
    assert.strictEqual(slugify('???'), 'edition');

    // Recording exports: splice the block when that is safe, rewrite the file when it is not.
    const built = [{ format: 'pdf', file: 'editions/ED_001_01/exports/a.pdf', built_at: '2026-11-26T10:00:00Z' }];
    const doc = { id: 'ED_001_01', exports: built, created_at: '2026-11-26' };
    const sameIndent = '# header\nid: ED_001_01\nexports:\n# old entry\n- format: cbz\n  file: old.cbz\n  built_at: null\n\n# about the date\ncreated_at: "2026-11-26"\n';
    const spliced = editionText(sameIndent, doc);
    assert.strictEqual(spliced.preserved, true);
    assert.strictEqual(spliced.text,
      '# header\nid: ED_001_01\nexports:\n  - format: pdf\n    file: editions/ED_001_01/exports/a.pdf\n    built_at: 2026-11-26T10:00:00Z\n\n# about the date\ncreated_at: "2026-11-26"\n');
    const crlf = editionText('id: ED_001_01\r\nexports: []\r\ncreated_at: "2026-11-26"\r\n', doc);
    assert.strictEqual(crlf.preserved, true);
    assert.ok(!crlf.text.includes('\r'));
    const absent = editionText('id: ED_001_01\ncreated_at: "2026-11-26"\n\n', doc);
    assert.strictEqual(absent.preserved, true, 'a missing exports key is appended');
    assert.deepStrictEqual(yaml.parse(absent.text), doc);
    assert.match(absent.text, /^id: ED_001_01\ncreated_at: "2026-11-26"\nexports:\n/);
    // Text that cannot be patched into the intended document: full rewrite, and the caller is told.
    const rewritten = editionText('"exports": []\nid: ED_001_01\ncreated_at: "2026-11-26"\n', doc);
    assert.strictEqual(rewritten.preserved, false);
    assert.strictEqual(rewritten.text, yaml.stringify(doc));
    assert.strictEqual(editionText('id: [unclosed\n', doc).preserved, false);

    const w = workspace();
    assert.deepStrictEqual(codes(buildEdition(path.join(w.root, 'editions', 'ED_001_02', 'edition.yaml'))), ['edition-missing']);
    const moved = path.join(w.root, 'editions', 'ED_001_07');
    fs.mkdirSync(moved);
    fs.copyFileSync(w.edition, path.join(moved, 'edition.yaml'));
    assert.deepStrictEqual(codes(buildEdition(path.join(moved, 'edition.yaml'))), ['edition-location']);
  }

  console.log('build-edition: OK');
} finally {
  roots.forEach(cleanup);
}
