import { POINTS_PER_MM } from '../core/paper.js';

// ---------------------------------------------------------------------------
// PDF writer
//
// A plot plan (see output/plot.js) is a list of primitives in millimetres from
// the bottom-left of the sheet, with Y up. That is already PDF's own
// convention, so this file does nothing but serialise: scale millimetres to
// points, write the operators, and assemble the object table around them.
// There is no library here and no rasterisation — the output is real vector
// geometry, which is what makes a plotted line measurable.
//
// Only the base-14 fonts are used (Helvetica for dimension text, Courier for
// TEXT entities), so nothing has to be embedded and the file stays small. The
// output is deterministic: no timestamps, so plotting the same drawing twice
// produces two identical files that can be diffed.
// ---------------------------------------------------------------------------

// Standard Helvetica advance widths, in 1/1000 em, for character codes 32-126.
// Needed because dimension text is centred on the dimension line, and centring
// without metrics puts it visibly off-centre.
export const PDF_HELVETICA_WIDTHS = Object.freeze([
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667,
  778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556,
  556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
  334, 260, 334, 584,
]);

// Courier is metrically monospaced at 600/1000 em, which is exactly the
// TEXT_WIDTH_FACTOR this app already approximates a text entity's footprint
// with — so a plotted TEXT entity occupies precisely the box that hit-testing
// and zoom-extents said it would.
export const PDF_COURIER_WIDTH = 600;

// The characters this app can produce that are not plain ASCII, mapped to
// their WinAnsiEncoding code. The diameter sign the app displays (U+2300) is
// not in WinAnsi; the slashed O at 0xD8 is the glyph every CAD font uses for
// diameter anyway, so it is the right substitution rather than a compromise.
export const PDF_WINANSI_EXTRAS = Object.freeze({
  '°': 0xb0, '⌀': 0xd8, 'Ø': 0xd8, 'ø': 0xf8,
  '±': 0xb1, '×': 0xd7, '÷': 0xf7, '½': 0xbd,
  '¼': 0xbc, '¾': 0xbe, '–': 0x96, '—': 0x97,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94,
  '²': 0xb2, '³': 0xb3, '©': 0xa9, '®': 0xae,
});

// The code this character plots as, or null where the base-14 encoding has no
// equivalent. Callers decide whether that is a warning or a silent '?'.
export function pdfMapCharacter(character) {
  const code = character.charCodeAt(0);
  if (code >= 32 && code <= 126) return code;
  if (PDF_WINANSI_EXTRAS[character] !== undefined) return PDF_WINANSI_EXTRAS[character];
  // The upper half of Latin-1 is WinAnsi's own range, apart from the 0x80-0x9f
  // window which WinAnsi fills with punctuation instead of control codes.
  if (code >= 0xa0 && code <= 0xff) return code;
  return null;
}

export function pdfGlyphWidth(code, font) {
  if (font === 'courier') return PDF_COURIER_WIDTH;
  if (code >= 32 && code <= 126) return PDF_HELVETICA_WIDTHS[code - 32];
  // Everything outside the metrics table is a punctuation or accented glyph;
  // 556 is Helvetica's digit width and the closest thing to an average.
  return 556;
}

export function pdfTextWidthMM(text, font, sizeMM) {
  let total = 0;
  for (const character of String(text)) {
    const code = pdfMapCharacter(character);
    total += pdfGlyphWidth(code === null ? 63 : code, font);
  }
  return (total / 1000) * sizeMM;
}

export function pdfUnsupportedCharacters(text) {
  const bad = new Set();
  for (const character of String(text)) {
    if (pdfMapCharacter(character) === null) bad.add(character);
  }
  return [...bad];
}

// A PDF string literal. Characters outside ASCII go out as octal escapes so
// the whole file stays 7-bit — which keeps character offsets equal to byte
// offsets, and the cross-reference table below depends on that.
export function pdfEncodeText(text) {
  let out = '';
  for (const character of String(text)) {
    const code = pdfMapCharacter(character);
    const byte = code === null ? 63 : code;
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${character}`;
    else if (byte < 32 || byte > 126) out += `\\${byte.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(byte);
  }
  return out;
}

// Four decimals is roughly a thousandth of a millimetre at PDF's own scale,
// well past what any plotter resolves, and it keeps the file compact.
export function pdfNumber(value) {
  if (!Number.isFinite(value)) return '0';
  const fixed = value.toFixed(4);
  const trimmed = fixed.replace(/\.?0+$/, '');
  return trimmed === '' || trimmed === '-0' ? '0' : trimmed;
}

function pdfPoint(mm) {
  return pdfNumber(mm * POINTS_PER_MM);
}

function pdfColor(color, stroking) {
  const [r, g, b] = color;
  return `${pdfNumber(r)} ${pdfNumber(g)} ${pdfNumber(b)} ${stroking ? 'RG' : 'rg'}`;
}

export function pdfStrokeOperators(op) {
  const lines = [];
  lines.push(pdfColor(op.color, true));
  lines.push(`${pdfPoint(op.widthMM)} w`);
  lines.push(op.dash && op.dash.length
    ? `[${op.dash.map(pdfPoint).join(' ')}] 0 d`
    : '[] 0 d');
  for (const subpath of op.subpaths) {
    lines.push(`${pdfPoint(subpath.start.x)} ${pdfPoint(subpath.start.y)} m`);
    for (const segment of subpath.segs) {
      if (segment.type === 'c') {
        lines.push(`${pdfPoint(segment.c1.x)} ${pdfPoint(segment.c1.y)} ` +
          `${pdfPoint(segment.c2.x)} ${pdfPoint(segment.c2.y)} ` +
          `${pdfPoint(segment.to.x)} ${pdfPoint(segment.to.y)} c`);
      } else {
        lines.push(`${pdfPoint(segment.to.x)} ${pdfPoint(segment.to.y)} l`);
      }
    }
    if (subpath.closed) lines.push('h');
  }
  lines.push('S');
  return lines;
}

export function pdfFillOperators(op) {
  const lines = [pdfColor(op.color, false)];
  op.points.forEach((point, index) => {
    lines.push(`${pdfPoint(point.x)} ${pdfPoint(point.y)} ${index === 0 ? 'm' : 'l'}`);
  });
  lines.push('h', 'f');
  return lines;
}

// Text is placed by a full text matrix rather than a translate plus rotate,
// because the anchor a caller gives is the middle of the string for dimension
// text and its baseline start for a TEXT entity, and both have to end up in
// the same place after rotation.
export function pdfTextOperators(op) {
  const font = op.font === 'courier' ? '/F2' : '/F1';
  const width = pdfTextWidthMM(op.text, op.font, op.sizeMM);
  const u = op.anchor === 'center' ? -width / 2 : 0;
  // Canvas' "middle" baseline sits about 0.35 em above the alphabetic one for
  // both of these faces, which is what the on-screen dimension text uses.
  const v = op.baseline === 'middle' ? -0.35 * op.sizeMM : 0;
  const cos = Math.cos(op.angle);
  const sin = Math.sin(op.angle);
  const x = op.x + u * cos - v * sin;
  const y = op.y + u * sin + v * cos;
  return [
    'BT',
    `${font} ${pdfNumber(op.sizeMM * POINTS_PER_MM)} Tf`,
    pdfColor(op.color, false),
    `${pdfNumber(cos)} ${pdfNumber(sin)} ${pdfNumber(-sin)} ${pdfNumber(cos)} ` +
      `${pdfPoint(x)} ${pdfPoint(y)} Tm`,
    `(${pdfEncodeText(op.text)}) Tj`,
    'ET',
  ];
}


// ---------------------------------------------------------------------------
// Images
//
// A PDF carrying a raster is normally a binary file, which would mean this
// module could no longer return a string: xref offsets are byte offsets, and
// the Blob that delivers the file encodes strings as UTF-8, so every byte above
// 127 would shift and corrupt. Rather than give that up — the purity here is
// what lets the test suite assert on the PDF directly — the image bytes are
// ASCII85-encoded and declared as `/Filter [/ASCII85Decode /DCTDecode]`. The
// reader undoes both, the file stays 7-bit, and the cost is 25% size on a
// payload that is already compressed.
//
// Underlays are always JPEG by the time they get here (model/imageImport.js
// normalises every source format), so DCTDecode is the only image filter this
// writer ever needs.
// ---------------------------------------------------------------------------

export const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Hand-rolled rather than using atob, which does not exist in the headless test
// environment and would make the whole image path untestable.
export function base64ToBytes(base64) {
  const clean = String(base64).replace(/[^A-Za-z0-9+/]/g, '');
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const character of clean) {
    const value = BASE64_ALPHABET.indexOf(character);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  return bytes;
}

export function dataUrlPayload(dataUrl) {
  const comma = String(dataUrl).indexOf(',');
  return comma < 0 ? '' : String(dataUrl).slice(comma + 1);
}

// ASCII85 as PDF defines it: four bytes to five printable characters, 'z' for
// an all-zero group, '~>' to end. Line length is capped because some readers
// baulk at very long lines.
export function ascii85Encode(bytes) {
  let out = '';
  let lineLength = 0;
  const emit = text => {
    for (const character of text) {
      out += character;
      if (++lineLength >= 75) { out += '\n'; lineLength = 0; }
    }
  };
  for (let index = 0; index < bytes.length; index += 4) {
    const remaining = Math.min(4, bytes.length - index);
    let value = 0;
    for (let offset = 0; offset < 4; offset++) {
      value = value * 256 + (offset < remaining ? bytes[index + offset] : 0);
    }
    if (remaining === 4 && value === 0) { emit('z'); continue; }
    const group = [];
    let rest = value;
    for (let position = 4; position >= 0; position--) {
      group[position] = String.fromCharCode(33 + (rest % 85));
      rest = Math.floor(rest / 85);
    }
    // A partial final group drops the same number of characters as it was
    // short of bytes, which is what tells the decoder how much to keep.
    emit(group.slice(0, remaining + 1).join(''));
  }
  return out + '~>';
}

// JPEG is self-describing, and the PDF image dictionary has to agree with it on
// size and colour space or the reader rejects the stream. Reading them back out
// of the bytes is more trustworthy than carrying the canvas's numbers along,
// since a re-encode can legitimately change them.
export function jpegInfo(bytes) {
  let index = 2;
  while (index + 9 < bytes.length) {
    if (bytes[index] !== 0xff) { index++; continue; }
    const marker = bytes[index + 1];
    // SOF0..SOF15, skipping the four that are not frame headers.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (bytes[index + 5] << 8) | bytes[index + 6],
        width: (bytes[index + 7] << 8) | bytes[index + 8],
        components: bytes[index + 9],
      };
    }
    const length = (bytes[index + 2] << 8) | bytes[index + 3];
    if (!(length > 0)) break;
    index += 2 + length;
  }
  return null;
}

export function pdfImageObject(op) {
  const bytes = base64ToBytes(dataUrlPayload(op.data));
  if (!bytes.length) return null;
  const info = jpegInfo(bytes);
  const width = info?.width || op.pixelWidth;
  const height = info?.height || op.pixelHeight;
  if (!(width > 0) || !(height > 0)) return null;
  const colorSpace = info && info.components === 1 ? '/DeviceGray' : '/DeviceRGB';
  const encoded = ascii85Encode(bytes);
  return {
    width, height, colorSpace,
    body: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/ColorSpace ${colorSpace} /BitsPerComponent 8 ` +
      `/Filter [/ASCII85Decode /DCTDecode] /Length ${encoded.length} >>\nstream\n${encoded}\nendstream`,
  };
}

// The unit square an image XObject draws into is mapped by `cm` onto the
// parallelogram the plan supplies, which is what carries rotation without this
// writer needing to know an angle.
export function pdfImageOperators(op, name, graphicsStateName) {
  const origin = op.origin;
  return [
    'q',
    graphicsStateName ? `/${graphicsStateName} gs` : null,
    `${pdfPoint(op.edgeX.x)} ${pdfPoint(op.edgeX.y)} ` +
      `${pdfPoint(op.edgeY.x)} ${pdfPoint(op.edgeY.y)} ` +
      `${pdfPoint(origin.x)} ${pdfPoint(origin.y)} cm`,
    `/${name} Do`,
    'Q',
  ].filter(Boolean);
}

export function pdfContentStream(plan) {
  const lines = ['q'];
  // Clipped to the picked area intersected with the printable rectangle, so a
  // plot at an exact scale larger than the sheet stops at the border the same
  // way a plotter would, and geometry outside a picked Window/Display never
  // bleeds into the unused margin around it.
  const clip = plan.clipMM || plan.printable;
  lines.push(`${pdfPoint(clip.xMM)} ${pdfPoint(clip.yMM)} ` +
    `${pdfPoint(clip.widthMM)} ${pdfPoint(clip.heightMM)} re W n`);
  let imageIndex = 0;
  for (const op of plan.ops) {
    if (op.kind === 'stroke') lines.push(...pdfStrokeOperators(op));
    else if (op.kind === 'fill') lines.push(...pdfFillOperators(op));
    else if (op.kind === 'text') lines.push(...pdfTextOperators(op));
    else if (op.kind === 'image') {
      const name = `Im${imageIndex}`;
      const alphaName = op.alpha < 1 ? `GSa${imageIndex}` : null;
      lines.push(...pdfImageOperators(op, name, alphaName));
      imageIndex++;
    }
  }
  lines.push('Q');
  return lines.join('\n');
}

export function buildPdfDocument(plan, title = 'Drawing') {
  const content = pdfContentStream(plan);
  // Objects 1-6 are fixed (catalog, pages, page, contents, two fonts); image
  // XObjects and their transparency states are appended after the Info object,
  // so their numbers are computed rather than written literally.
  const imageOps = plan.ops.filter(op => op.kind === 'image');
  const images = imageOps.map(pdfImageObject);
  const FIXED_OBJECTS = 7;
  const xobjectEntries = [];
  const gsEntries = [];
  const extraObjects = [];
  images.forEach((image, index) => {
    if (!image) return;
    const objectNumber = FIXED_OBJECTS + extraObjects.length + 1;
    extraObjects.push(image.body);
    xobjectEntries.push(`/Im${index} ${objectNumber} 0 R`);
    if (imageOps[index].alpha < 1) {
      const gsNumber = FIXED_OBJECTS + extraObjects.length + 1;
      extraObjects.push(`<< /Type /ExtGState /ca ${pdfNumber(imageOps[index].alpha)} ` +
        `/CA ${pdfNumber(imageOps[index].alpha)} >>`);
      gsEntries.push(`/GSa${index} ${gsNumber} 0 R`);
    }
  });
  const xobjectResource = xobjectEntries.length ? ` /XObject << ${xobjectEntries.join(' ')} >>` : '';
  const gsResource = gsEntries.length ? ` /ExtGState << ${gsEntries.join(' ')} >>` : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R ' +
      `/MediaBox [0 0 ${pdfPoint(plan.page.widthMM)} ${pdfPoint(plan.page.heightMM)}] ` +
      `/Resources << /Font << /F1 5 0 R /F2 6 0 R >>${xobjectResource}${gsResource} >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
    `<< /Title (${pdfEncodeText(title)}) /Producer (zbCAD) /Creator (zbCAD) >>`,
    ...extraObjects,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  return pdf;
}
