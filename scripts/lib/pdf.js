'use strict';
/**
 * Minimal PDF writer: one image per page. Zero dependencies (zlib and crypto
 * are Node built-ins).
 *
 * JPEG files are embedded as they are (DCTDecode). PNG files are decoded with
 * ./png.js and embedded as FlateDecode pixel data, with a soft mask when the
 * image has real transparency. Page size comes from each image's aspect ratio,
 * or from a fixed trim size when one is given. An optional DRAFT stamp is
 * drawn across every page in Helvetica, one of the 14 standard fonts every
 * reader ships, so no font file is embedded.
 *
 * The output is PDF 1.4 with a classic cross-reference table.
 */

const zlib = require('zlib');
const crypto = require('crypto');
const png = require('./png');
const { imageInfo } = require('./image-info');

const MM_TO_PT = 72 / 25.4;
/** 6.625 in, the width of a US comic page. Used when no trim size is given. */
const DEFAULT_PAGE_WIDTH_PT = 477;
/** Acrobat refuses pages larger than 200 in on either side. */
const MAX_PAGE_PT = 14400;
/** Advance width of "DRAFT" in Helvetica, in 1/1000 of the font size (D R A F T). */
const DRAFT_WIDTH = 722 + 722 + 667 + 611 + 611;
const HELVETICA_CAP_HEIGHT = 718;

/** Format a number for a content stream or dictionary: at most 4 decimals, no exponent. */
function num(value) {
  if (!Number.isFinite(value)) throw new Error(`pdf: cannot write the number ${value}`);
  const text = value.toFixed(4).replace(/\.?0+$/, '');
  return text === '-0' ? '0' : text;
}

/** A PDF string object: literal when plain ASCII, UTF-16BE hex otherwise. */
function pdfString(text) {
  const value = String(text);
  if (/^[\x20-\x7E]*$/.test(value)) {
    return `(${value.replace(/([\\()])/g, '\\$1')})`;
  }
  let hex = 'FEFF';
  for (let i = 0; i < value.length; i++) {
    hex += value.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  }
  return `<${hex}>`;
}

/** D:YYYYMMDDHHmmSSZ in UTC. */
function pdfDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error('pdf: invalid creation date');
  const p = (n, width = 2) => String(n).padStart(width, '0');
  return `D:${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/**
 * Turn one image file into the pieces of an image XObject.
 * @returns {{width:number, height:number, dict:string, data:Buffer,
 *   smask:null|{dict:string, data:Buffer}}}
 */
function prepareImage(buffer, label) {
  let info;
  try {
    info = imageInfo(buffer);
  } catch (err) {
    throw new Error(`pdf: ${label}: ${err.message}`);
  }
  const base = `/Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height}`;

  if (info.format === 'jpeg') {
    if (info.bitsPerSample !== 8) {
      throw new Error(`pdf: ${label}: ${info.bitsPerSample}-bit JPEG is not supported; re-save it as 8-bit`);
    }
    if (info.lossless || info.arithmetic) {
      throw new Error(`pdf: ${label}: lossless and arithmetic-coded JPEG cannot be embedded; re-save it as a baseline JPEG`);
    }
    let colour;
    if (info.components === 1) colour = '/ColorSpace /DeviceGray';
    else if (info.components === 3) colour = '/ColorSpace /DeviceRGB';
    else if (info.components === 4) {
      // Adobe applications write CMYK JPEG samples inverted; undo that on decode.
      colour = '/ColorSpace /DeviceCMYK' + (info.adobe ? ' /Decode [1 0 1 0 1 0 1 0]' : '');
    } else {
      throw new Error(`pdf: ${label}: JPEG with ${info.components} components is not supported`);
    }
    return {
      width: info.width,
      height: info.height,
      dict: `${base} ${colour} /BitsPerComponent 8 /Filter /DCTDecode`,
      data: buffer,
      smask: null,
    };
  }

  if (info.format === 'png') {
    let decoded;
    try {
      decoded = png.decode(buffer);
    } catch (err) {
      throw new Error(`pdf: ${label}: ${err.message}`);
    }
    const { color, colorChannels, alpha, opaque } = png.splitAlpha(decoded);
    const space = colorChannels === 1 ? '/DeviceGray' : '/DeviceRGB';
    const smask = opaque ? null : {
      dict: `${base} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`,
      data: zlib.deflateSync(alpha, { level: 9 }),
    };
    return {
      width: info.width,
      height: info.height,
      dict: `${base} /ColorSpace ${space} /BitsPerComponent 8 /Filter /FlateDecode`,
      data: zlib.deflateSync(color, { level: 9 }),
      smask,
    };
  }

  throw new Error(`pdf: ${label}: ${info.format.toUpperCase()} images cannot be embedded; convert the page to PNG or JPEG`);
}

/** Page box and image placement for one image. */
function layoutPage(image, options) {
  const ratio = image.height / image.width;
  if (options.pageSizeMm && options.pageSizeMm.width > 0 && options.pageSizeMm.height > 0) {
    const pageWidth = options.pageSizeMm.width * MM_TO_PT;
    const pageHeight = options.pageSizeMm.height * MM_TO_PT;
    const scale = Math.min(pageWidth / image.width, pageHeight / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    return { pageWidth, pageHeight, x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height };
  }
  let pageWidth = options.pageWidthPt > 0 ? options.pageWidthPt : DEFAULT_PAGE_WIDTH_PT;
  let pageHeight = pageWidth * ratio;
  if (pageHeight > MAX_PAGE_PT) {
    pageWidth *= MAX_PAGE_PT / pageHeight;
    pageHeight = MAX_PAGE_PT;
  }
  return { pageWidth, pageHeight, x: 0, y: 0, width: pageWidth, height: pageHeight };
}

/** Content-stream operators that draw DRAFT diagonally across the page. */
function draftStamp(pageWidth, pageHeight) {
  const diagonal = Math.hypot(pageWidth, pageHeight);
  const angle = Math.atan2(pageHeight, pageWidth);
  const size = (diagonal * 0.62) / (DRAFT_WIDTH / 1000);
  const textWidth = (DRAFT_WIDTH / 1000) * size;
  const capHeight = (HELVETICA_CAP_HEIGHT / 1000) * size;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Start so that the word's centre sits on the page centre.
  const x = pageWidth / 2 - (textWidth / 2) * cos + (capHeight / 2) * sin;
  const y = pageHeight / 2 - (textWidth / 2) * sin - (capHeight / 2) * cos;
  return [
    'q',
    '/GS0 gs',
    '0.8 0.1 0.1 rg',
    'BT',
    `/F1 ${num(size)} Tf`,
    `${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} ${num(x)} ${num(y)} Tm`,
    '(DRAFT) Tj',
    'ET',
    'Q',
  ].join('\n');
}

/**
 * Build a PDF with one image per page.
 *
 * @param {Array<{data:Buffer, name?:string}>} pages  Image files (PNG or JPEG) in page order.
 * @param {object} [options]
 * @param {string} [options.title]  Document title. No author is written.
 * @param {boolean} [options.draft]  Stamp DRAFT across every page.
 * @param {{width:number, height:number}} [options.pageSizeMm]  Fixed page
 *   size (for example project.page.trim_mm). The image is scaled to fit and centred.
 * @param {number} [options.pageWidthPt]  Page width when no fixed size is given;
 *   the height follows the image's aspect ratio. Default 477 pt (6.625 in).
 * @param {'ltr'|'rtl'} [options.readingDirection]  rtl sets the viewer's page direction.
 * @param {string} [options.language]  Document language tag (for example "en").
 * @param {Date|string} [options.creationDate]  Omitted when not given, which keeps the output deterministic.
 * @param {string} [options.producer]
 * @returns {Buffer}
 */
function buildPdf(pages, options = {}) {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('pdf: at least one page is required');

  const bodies = []; // bodies[n - 1] = Buffer for object n
  const alloc = () => {
    bodies.push(null);
    return bodies.length;
  };
  const set = (id, body) => {
    bodies[id - 1] = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1');
  };
  const stream = (dict, data) => Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream', 'latin1'),
  ]);

  const catalogId = alloc();
  const pagesId = alloc();
  const infoId = alloc();
  const fontId = options.draft ? alloc() : 0;
  if (fontId) {
    set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  }

  const pageIds = [];
  pages.forEach((page, index) => {
    const label = page.name || `page ${index + 1}`;
    if (!Buffer.isBuffer(page.data)) throw new Error(`pdf: ${label}: image data must be a Buffer`);
    const image = prepareImage(page.data, label);
    const box = layoutPage(image, options);

    const pageId = alloc();
    const contentId = alloc();
    const imageId = alloc();
    let imageDict = image.dict;
    if (image.smask) {
      const maskId = alloc();
      set(maskId, stream(image.smask.dict, image.smask.data));
      imageDict += ` /SMask ${maskId} 0 R`;
    }
    set(imageId, stream(imageDict, image.data));

    let content = `q\n${num(box.width)} 0 0 ${num(box.height)} ${num(box.x)} ${num(box.y)} cm\n/Im0 Do\nQ`;
    let resources = `/XObject << /Im0 ${imageId} 0 R >>`;
    if (options.draft) {
      content += '\n' + draftStamp(box.pageWidth, box.pageHeight);
      resources += ` /Font << /F1 ${fontId} 0 R >> /ExtGState << /GS0 << /Type /ExtGState /ca 0.35 /CA 0.35 >> >>`;
    }
    set(contentId, stream('', Buffer.from(content + '\n', 'latin1')));
    set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(box.pageWidth)} ${num(box.pageHeight)}] ` +
      `/Resources << ${resources} >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  });

  let catalog = `<< /Type /Catalog /Pages ${pagesId} 0 R`;
  if (options.language) catalog += ` /Lang ${pdfString(options.language)}`;
  if (options.readingDirection === 'rtl') catalog += ' /ViewerPreferences << /Direction /R2L >>';
  set(catalogId, catalog + ' >>');
  set(pagesId, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);

  let info = '<<';
  if (options.title) info += ` /Title ${pdfString(options.draft ? `${options.title} (DRAFT)` : options.title)}`;
  info += ` /Producer ${pdfString(options.producer || 'everything-ai-comics')}`;
  if (options.creationDate) info += ` /CreationDate (${pdfDate(options.creationDate)})`;
  set(infoId, info + ' >>');

  // Serialise, recording the byte offset of every object for the xref table.
  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let offset = parts[0].length;
  const offsets = [];
  bodies.forEach((body, i) => {
    const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
    const tail = Buffer.from('\nendobj\n', 'latin1');
    offsets.push(offset);
    parts.push(head, body, tail);
    offset += head.length + body.length + tail.length;
  });

  const id = crypto.createHash('md5').update(Buffer.concat(parts)).digest('hex').toUpperCase();
  const size = bodies.length + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (const at of offsets) xref += `${String(at).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${size} /Root ${catalogId} 0 R /Info ${infoId} 0 R /ID [<${id}> <${id}>] >>\n`;
  xref += `startxref\n${offset}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

module.exports = { buildPdf, pdfString, pdfDate, MM_TO_PT, DEFAULT_PAGE_WIDTH_PT };
