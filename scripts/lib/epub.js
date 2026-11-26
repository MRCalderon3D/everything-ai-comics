'use strict';
/**
 * Minimal EPUB 3 writer for comics: fixed layout, one image per page. Zero
 * dependencies; the container is written with ./zip.js.
 *
 * Layout of the archive:
 *   mimetype                    first entry, stored, "application/epub+zip"
 *   META-INF/container.xml      points at the package document
 *   OEBPS/content.opf           metadata (rendition:layout pre-paginated),
 *                               manifest, spine with the reading direction
 *   OEBPS/nav.xhtml             the navigation document
 *   OEBPS/style.css
 *   OEBPS/page-###.xhtml        one per page, with its own viewport
 *   OEBPS/images/###.<ext>      the page images, stored as they are
 *
 * A cover is the first page (page-000-cover.xhtml) and its image carries the
 * cover-image property. The output is deterministic: the identifier comes
 * from the caller and every entry is stamped with the modification date.
 */

const crypto = require('crypto');
const { createZip } = require('./zip');
const { escapeXml } = require('./svg');

const MIMETYPE = 'application/epub+zip';

/** A stable urn:uuid from any text (the 16 leading bytes of its SHA-1, shaped as a version 5 UUID). */
function uuidFrom(text) {
  const bytes = crypto.createHash('sha1').update(String(text)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** CCYY-MM-DDThh:mm:ssZ, the form dcterms:modified requires. */
function modifiedStamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error('epub: invalid modification date');
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function pageDocument(page, meta) {
  const lang = escapeXml(meta.language || 'en');
  const { width, height } = page;
  const draft = meta.draftNote
    ? `\n<div class="draft" style="font-size:${Math.max(10, Math.round(width / 40))}px">${escapeXml(meta.draftNote)}</div>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head>
<meta charset="UTF-8"/>
<title>${escapeXml(page.label)}</title>
<meta name="viewport" content="width=${width}, height=${height}"/>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body style="width:${width}px;height:${height}px">
<div class="page"><img src="images/${escapeXml(page.name)}" alt="${escapeXml(page.label)}" width="${width}" height="${height}"/></div>${draft}
</body>
</html>
`;
}

function navDocument(pages, meta) {
  const lang = escapeXml(meta.language || 'en');
  const items = pages.map((p) => `      <li><a href="${escapeXml(p.doc)}">${escapeXml(p.label)}</a></li>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head>
<meta charset="UTF-8"/>
<title>${escapeXml(meta.title)}</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>${escapeXml(meta.title)}</h1>
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>
`;
}

function packageDocument(pages, meta) {
  const lang = escapeXml(meta.language || 'en');
  const rtl = meta.readingDirection === 'rtl';
  const webtoon = meta.comicFormat === 'webtoon';
  const cover = pages.find((p) => p.cover);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${lang}">`,
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `    <dc:identifier id="pub-id">${escapeXml(meta.identifier)}</dc:identifier>`,
    `    <dc:title>${escapeXml(meta.title)}</dc:title>`,
    `    <dc:language>${lang}</dc:language>`,
  ];
  if (meta.description) lines.push(`    <dc:description>${escapeXml(meta.description)}</dc:description>`);
  lines.push(
    `    <meta property="dcterms:modified">${modifiedStamp(meta.modified)}</meta>`,
    '    <meta property="rendition:layout">pre-paginated</meta>',
    '    <meta property="rendition:orientation">auto</meta>',
    `    <meta property="rendition:spread">${webtoon ? 'none' : 'auto'}</meta>`);
  if (cover) lines.push(`    <meta name="cover" content="${cover.imageId}"/>`);
  lines.push('  </metadata>', '  <manifest>',
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '    <item id="css" href="style.css" media-type="text/css"/>');
  for (const p of pages) {
    lines.push(`    <item id="${p.docId}" href="${escapeXml(p.doc)}" media-type="application/xhtml+xml"/>`);
    lines.push(`    <item id="${p.imageId}" href="images/${escapeXml(p.name)}" media-type="${p.mime}"${p.cover ? ' properties="cover-image"' : ''}/>`);
  }
  lines.push('  </manifest>', `  <spine page-progression-direction="${rtl ? 'rtl' : 'ltr'}">`);
  for (const p of pages) {
    let spread = '';
    if (!webtoon) {
      if (p.cover) spread = ' properties="rendition:page-spread-center"';
      else if (p.side === 'left') spread = ' properties="page-spread-left"';
      else if (p.side === 'right') spread = ' properties="page-spread-right"';
    }
    lines.push(`    <itemref idref="${p.docId}"${spread}/>`);
  }
  lines.push('  </spine>', '</package>', '');
  return lines.join('\n');
}

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

const STYLE_CSS = `html, body { margin: 0; padding: 0; }
.page { margin: 0; padding: 0; }
.page img { display: block; width: 100%; height: 100%; }
.draft { position: absolute; right: 0; bottom: 0; background: #b3261e; color: #fff; padding: 0.4em 0.8em; font-family: sans-serif; font-weight: bold; }
`;

/**
 * Build a fixed-layout EPUB 3 in memory.
 *
 * @param {Array<{name: string, data: Buffer, width: number, height: number, mime: string,
 *   label: string, cover?: boolean, side?: string}>} pages
 *   In reading order. `name` is the image file name inside images/
 *   ("000-cover.png", "001.png"); `label` is what the navigation shows
 *   ("Cover", "Page 1"); `side` is left or right when the page plan fixes it.
 * @param {{title: string, identifier: string, language?: string, readingDirection?: string,
 *   comicFormat?: string, modified?: Date, description?: string, draftNote?: string}} meta
 *   `identifier` is the publication's unique ID (see uuidFrom). `draftNote`
 *   puts a banner on every page.
 * @returns {Buffer}
 */
function buildEpub(pages, meta = {}) {
  if (!Array.isArray(pages) || !pages.length) throw new Error('epub: at least one page is required');
  if (!meta.title) throw new Error('epub: a title is required');
  if (!meta.identifier) throw new Error('epub: an identifier is required');
  const modified = meta.modified instanceof Date ? meta.modified : new Date();
  const full = Object.assign({}, meta, { modified });
  let numbered = 0;
  const list = pages.map((p, i) => {
    if (!p || !Buffer.isBuffer(p.data) || !p.name || !(p.width > 0) || !(p.height > 0) || !p.mime) {
      throw new Error(`epub: page ${i + 1} needs name, data, width, height and mime`);
    }
    const stem = String(p.name).replace(/\.[^.]+$/, '');
    // Story pages count from 1; the cover is not one of them.
    if (!p.cover) numbered++;
    return Object.assign({}, p, {
      label: p.label || (p.cover ? 'Cover' : `Page ${numbered}`),
      doc: `page-${stem}.xhtml`,
      docId: `page-${i + 1}`,
      imageId: `img-${i + 1}`,
    });
  });

  // The mimetype entry goes first and is stored, never deflated: readers
  // identify an EPUB by those bytes at a fixed offset.
  const entries = [
    { name: 'mimetype', data: MIMETYPE },
    { name: 'META-INF/container.xml', data: CONTAINER_XML, compress: true },
    { name: 'OEBPS/content.opf', data: packageDocument(list, full), compress: true },
    { name: 'OEBPS/nav.xhtml', data: navDocument(list, full), compress: true },
    { name: 'OEBPS/style.css', data: STYLE_CSS, compress: true },
  ];
  for (const p of list) entries.push({ name: `OEBPS/${p.doc}`, data: pageDocument(p, full), compress: true });
  for (const p of list) entries.push({ name: `OEBPS/images/${p.name}`, data: p.data });
  return createZip(entries, { date: modified });
}

module.exports = { buildEpub, uuidFrom, modifiedStamp, MIMETYPE };
