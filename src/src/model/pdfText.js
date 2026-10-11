import { PDF_COURIER_WIDTH, PDF_HELVETICA_WIDTHS } from '../output/pdf.js';
import { PDF_EOF, isPdfStream, isPdfString, pdfDictGet, pdfResolve, pdfStreamData, readPdfObject } from './pdfRead.js';

// ---------------------------------------------------------------------------
// The PDF reader: text
//
// A PDF does not store text. It stores character codes and the name of a font
// to draw them with, and the font — usually embedded, usually a subset — is
// what knows which shape each code is. Drawing those shapes would mean reading
// TrueType and CFF outlines, which is most of what a PDF renderer is.
//
// This reader does the other half instead: it works out which characters the
// codes stand for, and how wide the font says each one is. That is enough to
// put the right words in the right place at the right size in a stand-in face,
// stretched to the width the real one occupied, and for a page that is going
// to be traced over the words matter far more than the typeface.
//
// Where a font gives no way to recover its characters (a subset addressed by
// glyph number with no /ToUnicode table), the run is reported as undecodable
// rather than drawn as the wrong letters.
// ---------------------------------------------------------------------------

// Windows-1252 and Mac OS Roman differ from Latin-1 only in the ranges below.
const PDF_WIN_ANSI_HIGH = '€•‚ƒ„…†‡ˆ‰Š‹Œ•Ž•'
  + '•‘’“”•–—˜™š›œ•žŸ';
const PDF_MAC_ROMAN_HIGH = 'ÄÅÇÉÑÖÜáàâäãåçéè'
  + 'êëíìîïñóòôöõúùûü'
  + '†°¢£§•¶ß®©™´¨≠ÆØ'
  + '∞±≤≥¥µ∂∑∏π∫ªºΩæø'
  + '¿¡¬√ƒ≈∆«»… ÀÃÕŒœ'
  + '–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ'
  + '‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ'
  + 'ÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

// Adobe's StandardEncoding, as the places it departs from ASCII and Latin-1.
// It is what a Type 1 font uses when the file names no encoding at all.
const PDF_STANDARD_OVERRIDES = Object.freeze({
  0x27: '’', 0x60: '‘', 0xa4: '⁄', 0xa6: 'ƒ', 0xa8: '¤', 0xa9: "'",
  0xaa: '“', 0xac: '‹', 0xad: '›', 0xae: 'fi', 0xaf: 'fl', 0xb1: '–',
  0xb2: '†', 0xb3: '‡', 0xb4: '·', 0xb7: '•', 0xb8: '‚', 0xb9: '„',
  0xba: '”', 0xbc: '…', 0xbd: '‰', 0xc1: '`', 0xc2: '´', 0xc3: 'ˆ',
  0xc4: '˜', 0xc5: '¯', 0xc8: '¨', 0xcb: '¸', 0xd0: '—', 0xe1: 'Æ',
  0xe3: 'ª', 0xe8: 'Ł', 0xe9: 'Ø', 0xea: 'Œ', 0xeb: 'º', 0xf1: 'æ',
  0xf5: 'ı', 0xf8: 'ł', 0xf9: 'ø', 0xfa: 'œ', 0xfb: 'ß',
});

// Glyph names an /Encoding's /Differences array can use, for everything that
// is not a single letter or a letter plus an accent (both handled in code).
const PDF_GLYPH_NAMES = Object.freeze({
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&',
  quotesingle: "'", parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-',
  minus: '−', period: '.', slash: '/', zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9', colon: ':', semicolon: ';', less: '<',
  equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\',
  bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|',
  braceright: '}', asciitilde: '~', exclamdown: '¡', cent: '¢', sterling: '£',
  currency: '¤', yen: '¥', brokenbar: '¦', section: '§', dieresis: '¨',
  copyright: '©', ordfeminine: 'ª', guillemotleft: '«', logicalnot: '¬',
  registered: '®', macron: '¯', degree: '°', plusminus: '±',
  twosuperior: '²', threesuperior: '³', acute: '´', mu: 'µ',
  paragraph: '¶', periodcentered: '·', cedilla: '¸', onesuperior: '¹',
  ordmasculine: 'º', guillemotright: '»', onequarter: '¼', onehalf: '½',
  threequarters: '¾', questiondown: '¿', multiply: '×', divide: '÷',
  germandbls: 'ß', AE: 'Æ', ae: 'æ', Oslash: 'Ø', oslash: 'ø',
  Eth: 'Ð', eth: 'ð', Thorn: 'Þ', thorn: 'þ', OE: 'Œ', oe: 'œ',
  Lslash: 'Ł', lslash: 'ł', dotlessi: 'ı', florin: 'ƒ', circumflex: 'ˆ',
  tilde: '˜', endash: '–', emdash: '—', quoteleft: '‘', quoteright: '’',
  quotesinglbase: '‚', quotedblleft: '“', quotedblright: '”',
  quotedblbase: '„', dagger: '†', daggerdbl: '‡', bullet: '•',
  ellipsis: '…', perthousand: '‰', guilsinglleft: '‹', guilsinglright: '›',
  fraction: '⁄', Euro: '€', trademark: '™', fi: 'fi', fl: 'fl', ff: 'ff',
  ffi: 'ffi', ffl: 'ffl', nbspace: ' ', sfthyphen: '-', Delta: '∆', Omega: 'Ω',
  pi: 'π', infinity: '∞', lessequal: '≤', greaterequal: '≥',
  notequal: '≠', approxequal: '≈', summation: '∑', product: '∏',
  radical: '√', integral: '∫', partialdiff: '∂', lozenge: '◊',
});

const PDF_GLYPH_ACCENTS = Object.freeze({
  acute: '́', grave: '̀', circumflex: '̂', dieresis: '̈', tilde: '̃',
  ring: '̊', cedilla: '̧', caron: '̌', macron: '̄', breve: '̆',
});

export function pdfGlyphNameToText(name) {
  // `a.sc`, `one.oldstyle`: a variant of the glyph before the dot.
  const base = String(name).split('.')[0];
  if (!base) return '';
  if (base.length === 1) return base;
  if (PDF_GLYPH_NAMES[base] !== undefined) return PDF_GLYPH_NAMES[base];
  let match = /^uni([0-9A-Fa-f]{4})+$/.test(base) ? base.slice(3).match(/.{4}/g) : null;
  if (match) return String.fromCharCode(...match.map(hex => parseInt(hex, 16)));
  match = /^u([0-9A-Fa-f]{4,6})$/.exec(base);
  if (match) {
    const point = parseInt(match[1], 16);
    return point <= 0x10ffff ? String.fromCodePoint(point) : '';
  }
  match = /^([A-Za-z])([a-z]+)$/.exec(base);
  if (match && PDF_GLYPH_ACCENTS[match[2]]) return (match[1] + PDF_GLYPH_ACCENTS[match[2]]).normalize('NFC');
  return '';
}

function pdfBaseEncoding(name) {
  const table = [];
  for (let code = 0; code < 256; code++) {
    if (code < 32 || code === 127) table.push('');
    else if (code < 127) table.push(String.fromCharCode(code));
    else if (name === 'MacRomanEncoding') table.push(PDF_MAC_ROMAN_HIGH[code - 128]);
    else if (code < 160) table.push(name === 'StandardEncoding' ? '' : PDF_WIN_ANSI_HIGH[code - 128]);
    else table.push(String.fromCharCode(code));
  }
  if (name === 'StandardEncoding') {
    for (const [code, text] of Object.entries(PDF_STANDARD_OVERRIDES)) table[Number(code)] = text;
  }
  return table;
}

function pdfCodeFromString(text) {
  let code = 0;
  for (let index = 0; index < text.length; index++) code = code * 256 + text.charCodeAt(index);
  return code;
}

function pdfUtf16FromString(text) {
  if (text.length < 2) return text;
  let out = '';
  for (let index = 0; index + 1 < text.length; index += 2) {
    out += String.fromCharCode(text.charCodeAt(index) * 256 + text.charCodeAt(index + 1));
  }
  return out;
}

// A /ToUnicode CMap: the table that says which characters each code stands
// for. Only the two mapping operators matter; the rest of the file is the
// PostScript ceremony the format is wrapped in.
export function parsePdfToUnicode(bytes) {
  const map = new Map();
  let codeBytes = 0;
  const cursor = { bytes, pos: 0, end: bytes.length };
  let operands = [];
  for (;;) {
    const token = readPdfObject(cursor, false);
    if (token === PDF_EOF) break;
    if (!token || token.op === undefined) { operands.push(token); continue; }
    if (token.op === 'endcodespacerange') {
      for (const item of operands) if (isPdfString(item)) codeBytes = Math.max(codeBytes, item.string.length);
    } else if (token.op === 'endbfchar') {
      for (let index = 0; index + 1 < operands.length; index += 2) {
        const [from, to] = [operands[index], operands[index + 1]];
        if (!isPdfString(from) || !isPdfString(to)) continue;
        map.set(pdfCodeFromString(from.string), pdfUtf16FromString(to.string));
        codeBytes = Math.max(codeBytes, from.string.length);
      }
    } else if (token.op === 'endbfrange') {
      for (let index = 0; index + 2 < operands.length; index += 3) {
        const [low, high, to] = [operands[index], operands[index + 1], operands[index + 2]];
        if (!isPdfString(low) || !isPdfString(high)) continue;
        const first = pdfCodeFromString(low.string);
        const count = Math.min(65536, pdfCodeFromString(high.string) - first + 1);
        codeBytes = Math.max(codeBytes, low.string.length);
        if (Array.isArray(to)) {
          for (let step = 0; step < count && step < to.length; step++) {
            if (isPdfString(to[step])) map.set(first + step, pdfUtf16FromString(to[step].string));
          }
        } else if (isPdfString(to)) {
          const start = pdfUtf16FromString(to.string);
          if (!start) continue;
          // The range counts up in its last code unit only.
          const head = start.slice(0, -1);
          const last = start.charCodeAt(start.length - 1);
          for (let step = 0; step < count; step++) map.set(first + step, head + String.fromCharCode(last + step));
        }
      }
    }
    operands = [];
  }
  return { map, codeBytes };
}

function pdfFontFace(doc, baseFont, descriptor) {
  const flags = pdfDictGet(doc, descriptor, 'Flags');
  const fixed = Number.isFinite(flags) && (flags & 1) === 1;
  return fixed || /courier|mono|consol|typewriter/i.test(baseFont) ? 'courier' : 'helvetica';
}

// The widths a base-14 font has when the file, as it is allowed to, leaves
// them out. Helvetica's stand in for every proportional face.
function pdfDefaultWidth(code, face) {
  if (face === 'courier') return PDF_COURIER_WIDTH;
  return code >= 32 && code <= 126 ? PDF_HELVETICA_WIDTHS[code - 32] : 556;
}

function pdfCompositeFont(doc, dict, unicode) {
  const descendants = pdfDictGet(doc, dict, 'DescendantFonts');
  const descendant = Array.isArray(descendants) ? pdfResolve(doc, descendants[0]) : descendants;
  const baseFont = String(pdfDictGet(doc, dict, 'BaseFont') || '');
  const face = pdfFontFace(doc, baseFont, pdfDictGet(doc, descendant, 'FontDescriptor'));
  const defaultWidth = pdfDictGet(doc, descendant, 'DW');
  const widths = new Map();
  // /W is a run-length list in two shapes: `c [w1 w2 ...]` gives consecutive
  // widths starting at c, and `first last w` gives one width to a whole range.
  const list = pdfDictGet(doc, descendant, 'W');
  if (Array.isArray(list)) {
    for (let index = 0; index < list.length;) {
      const first = pdfResolve(doc, list[index]);
      const second = pdfResolve(doc, list[index + 1]);
      if (Array.isArray(second)) {
        second.forEach((width, offset) => {
          const value = pdfResolve(doc, width);
          if (Number.isFinite(value)) widths.set(first + offset, value);
        });
        index += 2;
      } else {
        const width = pdfResolve(doc, list[index + 2]);
        if (Number.isFinite(first) && Number.isFinite(second) && Number.isFinite(width)) {
          for (let cid = first; cid <= second && cid - first < 65536; cid++) widths.set(cid, width);
        }
        index += 3;
      }
    }
  }
  return {
    codeBytes: 2,
    face,
    textOf: code => (unicode ? unicode.map.get(code) ?? '' : ''),
    widthOf: code => widths.get(code) ?? (Number.isFinite(defaultWidth) ? defaultWidth : 1000),
  };
}

function pdfSimpleFont(doc, dict, unicode) {
  const subtype = dict.get('Subtype');
  const baseFont = String(pdfDictGet(doc, dict, 'BaseFont') || '');
  const descriptor = pdfDictGet(doc, dict, 'FontDescriptor');
  const face = pdfFontFace(doc, baseFont, descriptor);

  const encoding = pdfDictGet(doc, dict, 'Encoding');
  const fallback = subtype === 'Type1' || subtype === 'MMType1' ? 'StandardEncoding' : 'WinAnsiEncoding';
  let table;
  if (typeof encoding === 'string') {
    table = pdfBaseEncoding(encoding);
  } else if (encoding instanceof Map) {
    const base = pdfDictGet(doc, encoding, 'BaseEncoding');
    table = pdfBaseEncoding(typeof base === 'string' ? base : fallback);
    // `[ 65 /A /B 97 /a ]`: a number sets the code, each name after it takes
    // the next one.
    let code = 0;
    for (const item of pdfDictGet(doc, encoding, 'Differences') || []) {
      const value = pdfResolve(doc, item);
      if (typeof value === 'number') code = value;
      else if (typeof value === 'string' && code >= 0 && code < 256) table[code++] = pdfGlyphNameToText(value);
    }
  } else {
    table = pdfBaseEncoding(fallback);
  }

  const firstChar = pdfDictGet(doc, dict, 'FirstChar');
  const declared = pdfDictGet(doc, dict, 'Widths');
  const missing = pdfDictGet(doc, descriptor, 'MissingWidth');
  // A Type 3 font measures its glyphs in its own space rather than in
  // thousandths of an em; its font matrix is the conversion.
  const matrix = pdfDictGet(doc, dict, 'FontMatrix');
  const scale = subtype === 'Type3' && Array.isArray(matrix) && Number.isFinite(pdfResolve(doc, matrix[0]))
    ? Math.abs(pdfResolve(doc, matrix[0])) * 1000 : 1;
  const widths = Array.isArray(declared) && Number.isFinite(firstChar)
    ? declared.map(width => pdfResolve(doc, width)) : null;

  return {
    codeBytes: 1,
    face,
    textOf: code => (unicode && unicode.map.has(code) ? unicode.map.get(code) : table[code] ?? ''),
    widthOf: code => {
      const width = widths ? widths[code - firstChar] : undefined;
      if (Number.isFinite(width)) return width * scale;
      if (widths && Number.isFinite(missing)) return missing;
      return pdfDefaultWidth(code, face);
    },
  };
}

export function pdfFontRecord(doc, dict) {
  if (!(dict instanceof Map)) return null;
  let unicode = null;
  const stream = pdfDictGet(doc, dict, 'ToUnicode');
  if (isPdfStream(stream)) {
    try {
      const data = pdfStreamData(doc, stream);
      if (!data.remaining.length) unicode = parsePdfToUnicode(data.bytes);
    } catch {
      unicode = null;
    }
  }
  return dict.get('Subtype') === 'Type0'
    ? pdfCompositeFont(doc, dict, unicode)
    : pdfSimpleFont(doc, dict, unicode);
}

// One shown string, reduced to what placing it needs: the characters, the sum
// of their advance widths in thousandths of an em, how many glyphs there were
// (character spacing is added once per glyph) and how many of them were the
// single-byte space that word spacing applies to.
export function pdfTextRun(font, string) {
  let text = '';
  let units = 0;
  let glyphs = 0;
  let spaces = 0;
  let unknown = 0;
  const step = font.codeBytes;
  for (let index = 0; index + step <= string.length; index += step) {
    const code = step === 2
      ? string.charCodeAt(index) * 256 + string.charCodeAt(index + 1)
      : string.charCodeAt(index);
    const piece = font.textOf(code);
    if (piece) text += piece;
    else unknown++;
    units += font.widthOf(code);
    glyphs++;
    if (step === 1 && code === 32) spaces++;
  }
  return { text, units, glyphs, spaces, unknown };
}
