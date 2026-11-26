'use strict';
/**
 * scripts/lib/pdf.js: document structure, checked by hand because no PDF
 * reader is available to the test suite. The cross-reference table is
 * verified by offset arithmetic, not by trusting the writer's own numbers.
 */

const assert = require('assert');
const zlib = require('zlib');
const png = require('../scripts/lib/png');
const { buildPdf, pdfString, pdfDate, MM_TO_PT } = require('../scripts/lib/pdf');
const { greyJpeg, rgbJpeg, solidPng, readPdf, streamOf } = require('./fixtures/publishing/helpers');

function gradientRgba(width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = (i * 5) & 255;
    data[i * 4 + 1] = (i * 3) & 255;
    data[i * 4 + 2] = 255 - ((i * 7) & 255);
    data[i * 4 + 3] = i % 2 ? 255 : 64;
  }
  return { data, file: png.encode({ width, height, data, colorType: 'rgba', filter: 4 }) };
}

const find = (doc, pattern) => doc.objects.filter((o) => pattern.test(o.body));
const pagesOf = (doc) => find(doc, /\/Type \/Page[^s]/);
const refs = (text) => (text.match(/(\d+) 0 R/g) || []).map((r) => Number(r.split(' ')[0]));

// --- one document with every kind of input ---------------------------------------------

const rgba = gradientRgba(8, 12);
const rgbFile = solidPng(8, 12, 'rgb', [10, 120, 230]);
const greyFile = solidPng(8, 12, 'grey', [77]);
const paletteFile = png.encode({ width: 4, height: 6, data: Buffer.alloc(24, 1), colorType: 'palette', palette: [[0, 0, 0], [192, 57, 43]] });
const inputs = [
  { name: 'rgb.png', data: rgbFile },
  { name: 'rgba.png', data: rgba.file },
  { name: 'grey.png', data: greyFile },
  { name: 'palette.png', data: paletteFile },
  { name: 'grey.jpg', data: greyJpeg() },
  { name: 'rgb.jpg', data: rgbJpeg() },
];
const bytes = buildPdf(inputs, { title: 'The Night Ferry - Crossing' });
const doc = readPdf(bytes); // throws when any xref offset is wrong

// --- header, trailer, end marker -----------------------------------------------------------

{
  assert.strictEqual(bytes.toString('latin1', 0, 9), '%PDF-1.4\n', 'header');
  assert.ok(bytes[10] > 127 && bytes[11] > 127, 'binary marker comment after the header');
  assert.ok(bytes.toString('latin1').endsWith('%%EOF\n'));
  assert.strictEqual(doc.size, doc.objects.length + 1, '/Size counts object 0');
  assert.match(doc.trailer, new RegExp(`/Size ${doc.size}\\b`));
  assert.match(doc.trailer, /\/Root 1 0 R/);
  assert.match(doc.trailer, /\/Info 3 0 R/);
  assert.match(doc.trailer, /\/ID \[<[0-9A-F]{32}> <[0-9A-F]{32}>\]/);
}

// --- xref by hand: offset arithmetic --------------------------------------------------------

{
  // The header is "%PDF-1.4\n" (9 bytes) plus "%" + four binary bytes + "\n" (6 bytes).
  let expected = 9 + 6;
  for (const object of doc.objects) {
    assert.strictEqual(object.offset, expected, `object ${object.id} starts where the previous one ended`);
    assert.strictEqual(bytes.toString('latin1', expected, expected + `${object.id} 0 obj`.length), `${object.id} 0 obj`);
    // "<id> 0 obj\n" + body + "\nendobj\n"
    expected += `${object.id} 0 obj\n`.length + object.body.length + '\nendobj\n'.length;
  }
  assert.strictEqual(doc.startxref, expected, 'startxref is the byte right after the last object');
  assert.strictEqual(bytes.toString('latin1', doc.startxref, doc.startxref + 4), 'xref');
  // The table itself: header line, then 20 bytes per entry, then the trailer.
  const tableStart = doc.startxref + `xref\n0 ${doc.size}\n`.length;
  assert.strictEqual(bytes.toString('latin1', tableStart, tableStart + 20), '0000000000 65535 f \n');
  const second = bytes.toString('latin1', tableStart + 20, tableStart + 40);
  assert.strictEqual(second, '0000000015 00000 n \n', 'object 1 sits right after the 15-byte header');
  assert.strictEqual(bytes.toString('latin1', tableStart + 20 * doc.size, tableStart + 20 * doc.size + 7), 'trailer');
}

// --- catalog, page tree, info ---------------------------------------------------------------

{
  const catalog = doc.objects[0];
  assert.match(catalog.body, /\/Type \/Catalog/);
  const pagesId = refs(/\/Pages \d+ 0 R/.exec(catalog.body)[0])[0];
  const tree = doc.objects[pagesId - 1];
  assert.match(tree.body, /\/Type \/Pages/);
  assert.match(tree.body, new RegExp(`/Count ${inputs.length}\\b`));
  const kids = refs(/\/Kids \[([^\]]*)\]/.exec(tree.body)[1]);
  assert.strictEqual(kids.length, inputs.length, 'one kid per image');
  const pages = pagesOf(doc);
  assert.strictEqual(pages.length, inputs.length, 'page count');
  assert.deepStrictEqual(kids, pages.map((p) => p.id), 'kids are the page objects, in order');
  for (const page of pages) assert.match(page.body, new RegExp(`/Parent ${pagesId} 0 R`));

  const info = doc.objects[2];
  assert.match(info.body, /\/Title \(The Night Ferry - Crossing\)/);
  assert.match(info.body, /\/Producer \(everything-ai-comics\)/);
  assert.ok(!/\/Author/.test(info.body), 'no invented author');
  assert.ok(!/\/CreationDate/.test(info.body), 'no date unless one is given');
  assert.ok(!find(doc, /\/Type \/Font/).length, 'no font without the draft stamp');
}

// --- pages, contents, images -----------------------------------------------------------------

{
  const pages = pagesOf(doc);
  const expectedImages = [
    { width: 8, height: 12, space: 'DeviceRGB', filter: 'FlateDecode', mask: false },
    { width: 8, height: 12, space: 'DeviceRGB', filter: 'FlateDecode', mask: true },
    { width: 8, height: 12, space: 'DeviceGray', filter: 'FlateDecode', mask: false },
    { width: 4, height: 6, space: 'DeviceRGB', filter: 'FlateDecode', mask: false },
    { width: 16, height: 24, space: 'DeviceGray', filter: 'DCTDecode', mask: false },
    { width: 16, height: 24, space: 'DeviceRGB', filter: 'DCTDecode', mask: false },
  ];
  pages.forEach((page, i) => {
    const want = expectedImages[i];
    const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(page.body);
    const width = Number(box[1]);
    const height = Number(box[2]);
    assert.strictEqual(width, 477, 'default page width');
    assert.ok(Math.abs(height / width - want.height / want.width) < 1e-4, `page ${i + 1}: page shape follows the image`);

    const contentId = refs(/\/Contents \d+ 0 R/.exec(page.body)[0])[0];
    const content = streamOf(doc.objects[contentId - 1]);
    assert.match(content.data.toString('latin1'), /^q\n[\d.]+ 0 0 [\d.]+ 0 0 cm\n\/Im0 Do\nQ\n$/, 'content draws the image once');
    assert.ok(!/DRAFT/.test(content.data.toString('latin1')));

    const imageId = refs(/\/Im0 \d+ 0 R/.exec(page.body)[0])[0];
    const image = streamOf(doc.objects[imageId - 1]);
    assert.match(image.dict, /\/Type \/XObject \/Subtype \/Image/);
    assert.match(image.dict, new RegExp(`/Width ${want.width} /Height ${want.height}\\b`));
    assert.match(image.dict, new RegExp(`/ColorSpace /${want.space}\\b`));
    assert.match(image.dict, /\/BitsPerComponent 8\b/);
    assert.match(image.dict, new RegExp(`/Filter /${want.filter}\\b`));
    assert.strictEqual(/\/SMask/.test(image.dict), want.mask, `page ${i + 1}: soft mask`);
  });

  // PNG pixels: the stream inflates to exactly width * height * channels samples.
  const imageOf = (index) => streamOf(doc.objects[refs(/\/Im0 \d+ 0 R/.exec(pages[index].body)[0])[0] - 1]);
  const rgbPixels = zlib.inflateSync(imageOf(0).data);
  assert.strictEqual(rgbPixels.length, 8 * 12 * 3);
  assert.deepStrictEqual([...rgbPixels.subarray(0, 6)], [10, 120, 230, 10, 120, 230]);
  assert.strictEqual(zlib.inflateSync(imageOf(2).data).length, 8 * 12, 'grey: one sample per pixel');
  const palettePixels = zlib.inflateSync(imageOf(3).data);
  assert.deepStrictEqual([...palettePixels.subarray(0, 3)], [192, 57, 43], 'palette expanded to RGB');

  // Alpha: colour and mask are split, and the mask is a grey image of the same size.
  const rgbaImage = imageOf(1);
  const colour = zlib.inflateSync(rgbaImage.data);
  const maskId = refs(/\/SMask \d+ 0 R/.exec(rgbaImage.dict)[0])[0];
  const mask = streamOf(doc.objects[maskId - 1]);
  assert.match(mask.dict, /\/Width 8 \/Height 12 \/ColorSpace \/DeviceGray \/BitsPerComponent 8 \/Filter \/FlateDecode/);
  const alpha = zlib.inflateSync(mask.data);
  assert.strictEqual(colour.length, 8 * 12 * 3);
  assert.strictEqual(alpha.length, 8 * 12);
  for (let i = 0; i < 8 * 12; i++) {
    assert.deepStrictEqual([...colour.subarray(i * 3, i * 3 + 3)], [...rgba.data.subarray(i * 4, i * 4 + 3)], `colour of pixel ${i}`);
    assert.strictEqual(alpha[i], rgba.data[i * 4 + 3], `alpha of pixel ${i}`);
  }

  // JPEG: the file bytes go in untouched.
  assert.ok(imageOf(4).data.equals(greyJpeg()), 'grey JPEG embedded byte for byte');
  assert.ok(imageOf(5).data.equals(rgbJpeg()), 'RGB JPEG embedded byte for byte');

  // Every stream's /Length is exact (streamOf throws otherwise).
  for (const object of doc.objects) streamOf(object);
}

// --- alpha that is fully opaque needs no mask -------------------------------------------------

{
  const opaque = readPdf(buildPdf([{ data: solidPng(4, 6, 'rgba', [1, 2, 3, 255]) }]));
  assert.ok(!/\/SMask/.test(opaque.text), 'no soft mask for an opaque RGBA image');
  assert.strictEqual(opaque.objects.length, 6, 'catalog, pages, info, page, content, image');
  const masked = readPdf(buildPdf([{ data: solidPng(4, 6, 'grey-alpha', [9, 100]) }]));
  assert.match(masked.text, /\/SMask \d+ 0 R/);
  assert.strictEqual(masked.objects.length, 7);
}

// --- draft stamp ----------------------------------------------------------------------------

{
  const draft = readPdf(buildPdf([{ data: rgbFile }, { data: greyJpeg() }], { title: 'Crossing', draft: true }));
  const fonts = find(draft, /\/Type \/Font/);
  assert.strictEqual(fonts.length, 1, 'one shared font object');
  assert.match(fonts[0].body, /\/Subtype \/Type1 \/BaseFont \/Helvetica\b/);
  const pages = pagesOf(draft);
  assert.strictEqual(pages.length, 2);
  for (const page of pages) {
    assert.match(page.body, new RegExp(`/Font << /F1 ${fonts[0].id} 0 R >>`));
    assert.match(page.body, /\/ExtGState << \/GS0 << \/Type \/ExtGState \/ca 0\.35/);
    const content = streamOf(draft.objects[refs(/\/Contents \d+ 0 R/.exec(page.body)[0])[0] - 1]).data.toString('latin1');
    assert.match(content, /\/Im0 Do/);
    assert.match(content, /BT\n\/F1 [\d.]+ Tf\n[-\d. ]+ Tm\n\(DRAFT\) Tj\nET/, 'DRAFT drawn on every page');
  }
  assert.match(draft.objects[2].body, /\/Title \(Crossing \\\(DRAFT\\\)\)/, 'title marked, parentheses escaped');
}

// --- options ---------------------------------------------------------------------------------

{
  const sized = readPdf(buildPdf([{ data: rgbFile }], { pageSizeMm: { width: 168, height: 260 } }));
  const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pagesOf(sized)[0].body);
  assert.ok(Math.abs(Number(box[1]) - 168 * MM_TO_PT) < 0.001, 'trim width in points');
  assert.ok(Math.abs(Number(box[2]) - 260 * MM_TO_PT) < 0.001, 'trim height in points');
  // 2:3 image on a 168x260 page: fitted to the width, centred vertically.
  const content = streamOf(sized.objects[4]).data.toString('latin1');
  const cm = /^q\n([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm/.exec(content);
  assert.ok(Math.abs(Number(cm[1]) - 168 * MM_TO_PT) < 0.001);
  assert.ok(Math.abs(Number(cm[2]) / Number(cm[1]) - 1.5) < 1e-4, 'image keeps its shape');
  assert.strictEqual(Number(cm[3]), 0);
  assert.ok(Math.abs(Number(cm[4]) - (260 * MM_TO_PT - Number(cm[2])) / 2) < 0.001, 'centred');

  const rtl = readPdf(buildPdf([{ data: rgbFile }], { readingDirection: 'rtl', language: 'ja', creationDate: new Date(Date.UTC(2026, 10, 26, 9, 5, 7)) }));
  assert.match(rtl.objects[0].body, /\/ViewerPreferences << \/Direction \/R2L >>/);
  assert.match(rtl.objects[0].body, /\/Lang \(ja\)/);
  assert.match(rtl.objects[2].body, /\/CreationDate \(D:20261126090507Z\)/);

  // A very tall strip is scaled down to the largest page a reader accepts.
  const tall = readPdf(buildPdf([{ data: solidPng(2, 100, 'grey', [0]) }]));
  const tallBox = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pagesOf(tall)[0].body);
  assert.strictEqual(Number(tallBox[2]), 14400);
  assert.ok(Math.abs(Number(tallBox[1]) - 288) < 0.001);

  assert.strictEqual(pdfString('Plain (text) \\ here'), '(Plain \\(text\\) \\\\ here)');
  assert.strictEqual(pdfString('Señal'), '<FEFF0053006500F10061006C>');
  assert.strictEqual(pdfDate('2026-11-26T10:00:00Z'), 'D:20261126100000Z');
  const accented = readPdf(buildPdf([{ data: rgbFile }], { title: 'Señal' }));
  assert.match(accented.objects[2].body, /\/Title <FEFF0053006500F10061006C>/);

  assert.ok(buildPdf(inputs, { title: 'T' }).equals(buildPdf(inputs, { title: 'T' })), 'deterministic without a date');
}

// --- CMYK and rejections -----------------------------------------------------------------------

{
  const cmyk = Buffer.concat([
    Buffer.from('ffd8', 'hex'),
    Buffer.from('ffee000e41646f626500640000000000', 'hex'),
    Buffer.from('ffc0001408003c002804' + '011100' + '021100' + '031100' + '041100', 'hex'),
    Buffer.from('ffd9', 'hex'),
  ]);
  const doc4 = readPdf(buildPdf([{ data: cmyk }]));
  assert.match(doc4.text, /\/ColorSpace \/DeviceCMYK \/Decode \[1 0 1 0 1 0 1 0\] \/BitsPerComponent 8 \/Filter \/DCTDecode/);

  const interlaced = Buffer.from(rgbFile);
  interlaced[28] = 1; // IHDR interlace byte; the CRC is now wrong too, but the header is read first
  assert.throws(() => buildPdf([{ name: 'PG_001_001', data: interlaced }]), /PG_001_001: .*interlaced/);

  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'latin1');
  webp.write('WEBPVP8X', 8, 'latin1');
  assert.throws(() => buildPdf([{ name: 'page 2', data: webp }]), /page 2: WEBP images cannot be embedded/);
  assert.throws(() => buildPdf([{ data: Buffer.from('nothing like an image here') }]), /page 1: unrecognised image format/);
  assert.throws(() => buildPdf([]), /at least one page/);

  const twelveBit = greyJpeg();
  twelveBit[twelveBit.indexOf(Buffer.from([0xFF, 0xC0])) + 4] = 12;
  assert.throws(() => buildPdf([{ data: twelveBit }]), /12-bit JPEG/);
}

console.log('pdf: OK');
