import { inflateBytes } from '../core/inflate.js';

// ---------------------------------------------------------------------------
// The PDF reader: file structure
//
// Bytes in, a table of objects and a list of pages out. Pure — nothing here
// touches the drawing, and nothing here knows what a page will be used for;
// model/pdfPage.js is what turns one page into line work.
//
// A PDF is meant to be read backwards: the last line says where the
// cross-reference table is, and the table says where each object starts. This
// reader ignores all of that and walks the file forwards, collecting every
// `N G obj` it meets. That is what a viewer falls back to when the table is
// damaged, and it is used here as the only path for three reasons: a damaged
// file and a healthy one go through the same code, cross-reference streams and
// hybrid files need no handling of their own, and an appended revision
// replaces what it changes simply by coming later in the file.
//
// Values are plain JavaScript where PDF has an obvious equivalent, and a
// tagged object where it does not:
//
//   number, true/false, null   themselves
//   /Name                      the string 'Name'
//   (text) or <hex>            { string } — one character per byte, undecoded
//   [ ... ]                    an array
//   << ... >>                  a Map
//   12 0 R                     { ref: 12 }
//   a stream                   { dict, start, end } — the byte range, undecoded
//   an operator (content only) { op: 'cm' }
// ---------------------------------------------------------------------------

export const PDF_MAX_BYTES = 256 * 1024 * 1024;
// Past this a decoded stream is a decompression bomb or a mistake, not a page.
export const PDF_MAX_STREAM_BYTES = 512 * 1024 * 1024;

export const PDF_EOF = Object.freeze({ end: 'file' });
const PDF_ARRAY_END = Object.freeze({ end: 'array' });
const PDF_DICT_END = Object.freeze({ end: 'dict' });

// 1 = white space, 2 = delimiter; everything else is a "regular" character
// and can be part of a name, a number or a keyword.
const PDF_CHAR_CLASS = new Uint8Array(256);
for (const code of [0, 9, 10, 12, 13, 32]) PDF_CHAR_CLASS[code] = 1;
for (const character of '()<>[]{}/%') PDF_CHAR_CLASS[character.charCodeAt(0)] = 2;

export function isPdfRef(value) {
  return value !== null && typeof value === 'object' && typeof value.ref === 'number';
}

export function isPdfString(value) {
  return value !== null && typeof value === 'object' && typeof value.string === 'string';
}

export function isPdfStream(value) {
  return value !== null && typeof value === 'object' && value.dict instanceof Map
    && typeof value.start === 'number';
}

export function isPdfDict(value) {
  return value instanceof Map;
}

// Bytes to a string with one character per byte. Chunked because spreading a
// large array into fromCharCode overflows the argument stack.
export function pdfLatin1(bytes, start = 0, end = bytes.length) {
  let out = '';
  for (let index = start; index < end; index += 8192) {
    out += String.fromCharCode.apply(null, bytes.subarray(index, Math.min(end, index + 8192)));
  }
  return out;
}

export function pdfBytesFromLatin1(text) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index) & 255;
  return bytes;
}

function pdfIndexOf(bytes, needle, from, end) {
  const first = needle.charCodeAt(0);
  let at = from;
  for (;;) {
    at = bytes.indexOf(first, at);
    if (at < 0 || at + needle.length > end) return -1;
    let index = 1;
    while (index < needle.length && bytes[at + index] === needle.charCodeAt(index)) index++;
    if (index === needle.length) return at;
    at++;
  }
}

function pdfMatchesAt(bytes, at, word) {
  for (let index = 0; index < word.length; index++) {
    if (bytes[at + index] !== word.charCodeAt(index)) return false;
  }
  return true;
}

export function skipPdfSpace(cursor) {
  const { bytes, end } = cursor;
  let pos = cursor.pos;
  while (pos < end) {
    const code = bytes[pos];
    if (PDF_CHAR_CLASS[code] === 1) { pos++; continue; }
    if (code === 37) {
      while (pos < end && bytes[pos] !== 10 && bytes[pos] !== 13) pos++;
      continue;
    }
    break;
  }
  cursor.pos = pos;
}

// Leaves the cursor after the number. Sets cursor.integer so the caller can
// tell `12` from `12.0`, which is the difference between a possible object
// reference and a coordinate.
function readPdfNumber(cursor) {
  const { bytes, end } = cursor;
  let pos = cursor.pos;
  let negative = false;
  // A doubled sign is malformed, and common enough that every reader lets it
  // through as the single sign it was meant to be.
  while (pos < end && (bytes[pos] === 43 || bytes[pos] === 45)) {
    if (bytes[pos] === 45) negative = true;
    pos++;
  }
  let value = 0;
  let code;
  while (pos < end && (code = bytes[pos]) >= 48 && code <= 57) {
    value = value * 10 + (code - 48);
    pos++;
  }
  let integer = true;
  if (pos < end && bytes[pos] === 46) {
    integer = false;
    pos++;
    let fraction = 0;
    let divisor = 1;
    while (pos < end && (code = bytes[pos]) >= 48 && code <= 57) {
      // Past fifteen digits the fraction no longer fits a double and the
      // extra precision is noise; the digits are still consumed.
      if (divisor < 1e15) { fraction = fraction * 10 + (code - 48); divisor *= 10; }
      pos++;
    }
    value += fraction / divisor;
  }
  // Anything else stuck to the number (an exponent, a stray letter) belongs to
  // the same broken token and is dropped with it.
  while (pos < end && !PDF_CHAR_CLASS[bytes[pos]]) pos++;
  cursor.pos = pos;
  cursor.integer = integer;
  return negative ? -value : value;
}

function readPdfLiteralString(cursor) {
  const { bytes, end } = cursor;
  let pos = cursor.pos + 1;
  let depth = 1;
  const codes = [];
  while (pos < end) {
    let code = bytes[pos++];
    if (code === 92) {
      code = bytes[pos++];
      if (code === 110) codes.push(10);
      else if (code === 114) codes.push(13);
      else if (code === 116) codes.push(9);
      else if (code === 98) codes.push(8);
      else if (code === 102) codes.push(12);
      else if (code >= 48 && code <= 55) {
        let value = code - 48;
        for (let digit = 0; digit < 2 && bytes[pos] >= 48 && bytes[pos] <= 55; digit++) {
          value = value * 8 + (bytes[pos++] - 48);
        }
        codes.push(value & 255);
      } else if (code === 13) {
        // A backslash at the end of a line continues the string on the next.
        if (bytes[pos] === 10) pos++;
      } else if (code !== 10 && code !== undefined) {
        codes.push(code);
      }
    } else if (code === 40) {
      depth++;
      codes.push(code);
    } else if (code === 41) {
      if (--depth === 0) break;
      codes.push(code);
    } else {
      codes.push(code);
    }
  }
  cursor.pos = pos;
  let text = '';
  for (let index = 0; index < codes.length; index += 8192) {
    text += String.fromCharCode.apply(null, codes.slice(index, index + 8192));
  }
  return { string: text };
}

function pdfHexValue(code) {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

function readPdfHexString(cursor) {
  const { bytes, end } = cursor;
  let pos = cursor.pos + 1;
  let text = '';
  let high = -1;
  while (pos < end) {
    const code = bytes[pos++];
    if (code === 62) break;
    const value = pdfHexValue(code);
    if (value < 0) continue;
    if (high < 0) high = value;
    else { text += String.fromCharCode(high * 16 + value); high = -1; }
  }
  // An odd digit count means the last one is the high half of a byte.
  if (high >= 0) text += String.fromCharCode(high * 16);
  cursor.pos = pos;
  return { string: text };
}

function readPdfName(cursor) {
  const { bytes, end } = cursor;
  let pos = cursor.pos + 1;
  let name = '';
  while (pos < end) {
    const code = bytes[pos];
    if (PDF_CHAR_CLASS[code]) break;
    pos++;
    if (code === 35 && pdfHexValue(bytes[pos]) >= 0 && pdfHexValue(bytes[pos + 1]) >= 0) {
      name += String.fromCharCode(pdfHexValue(bytes[pos]) * 16 + pdfHexValue(bytes[pos + 1]));
      pos += 2;
    } else {
      name += String.fromCharCode(code);
    }
  }
  cursor.pos = pos;
  return name;
}

// One object, or one of the three sentinels. `references` is off inside a
// content stream, where `12 0 R` cannot occur and two integers followed by an
// operator beginning with R must not be mistaken for one.
export function readPdfObject(cursor, references = true) {
  skipPdfSpace(cursor);
  const { bytes, end } = cursor;
  if (cursor.pos >= end) return PDF_EOF;
  const code = bytes[cursor.pos];

  if ((code >= 48 && code <= 57) || code === 45 || code === 43 || code === 46) {
    const value = readPdfNumber(cursor);
    if (!references || !cursor.integer || value < 0) return value;
    // `12 0 R`: look ahead for a generation and the R, and put the cursor back
    // if this turns out to be two plain numbers.
    const saved = cursor.pos;
    skipPdfSpace(cursor);
    let pos = cursor.pos;
    let digits = 0;
    while (pos < end && bytes[pos] >= 48 && bytes[pos] <= 57) { pos++; digits++; }
    if (digits && digits <= 5) {
      cursor.pos = pos;
      skipPdfSpace(cursor);
      if (bytes[cursor.pos] === 82 && (cursor.pos + 1 >= end || PDF_CHAR_CLASS[bytes[cursor.pos + 1]])) {
        cursor.pos++;
        return { ref: value };
      }
    }
    cursor.pos = saved;
    return value;
  }
  if (code === 47) return readPdfName(cursor);
  if (code === 40) return readPdfLiteralString(cursor);
  if (code === 60) {
    if (bytes[cursor.pos + 1] !== 60) return readPdfHexString(cursor);
    cursor.pos += 2;
    const dict = new Map();
    for (;;) {
      const key = readPdfObject(cursor, references);
      if (key === PDF_DICT_END || key === PDF_EOF) break;
      if (typeof key !== 'string') continue;
      const value = readPdfObject(cursor, references);
      if (value === PDF_DICT_END || value === PDF_EOF) break;
      if (value === PDF_ARRAY_END) continue;
      dict.set(key, value);
    }
    return dict;
  }
  if (code === 62) {
    cursor.pos += bytes[cursor.pos + 1] === 62 ? 2 : 1;
    return PDF_DICT_END;
  }
  if (code === 91) {
    cursor.pos++;
    const array = [];
    for (;;) {
      const item = readPdfObject(cursor, references);
      if (item === PDF_ARRAY_END || item === PDF_EOF) break;
      if (item === PDF_DICT_END) continue;
      array.push(item);
    }
    return array;
  }
  if (code === 93) { cursor.pos++; return PDF_ARRAY_END; }
  if (code === 123 || code === 125 || code === 41) {
    // Braces belong to PostScript calculator functions, which never appear
    // where this reader looks; a stray one is stepped over.
    cursor.pos++;
    return { op: String.fromCharCode(code) };
  }

  let pos = cursor.pos;
  while (pos < end && !PDF_CHAR_CLASS[bytes[pos]]) pos++;
  const word = pdfLatin1(bytes, cursor.pos, pos);
  cursor.pos = pos;
  if (word === 'true') return true;
  if (word === 'false') return false;
  if (word === 'null') return null;
  return { op: word };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const PDF_FILTER_NAMES = Object.freeze({
  Fl: 'FlateDecode', LZW: 'LZWDecode', A85: 'ASCII85Decode', AHx: 'ASCIIHexDecode',
  RL: 'RunLengthDecode', DCT: 'DCTDecode', CCF: 'CCITTFaxDecode',
});

export function pdfAscii85Decode(bytes) {
  const out = [];
  let group = [];
  for (let index = 0; index < bytes.length; index++) {
    const code = bytes[index];
    if (code === 126) break;
    if (PDF_CHAR_CLASS[code] === 1) continue;
    if (code === 122 && !group.length) { out.push(0, 0, 0, 0); continue; }
    if (code < 33 || code > 117) continue;
    group.push(code - 33);
    if (group.length === 5) {
      let value = 0;
      for (const digit of group) value = value * 85 + digit;
      out.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
      group = [];
    }
  }
  if (group.length > 1) {
    // A short final group is padded with the highest digit and gives one byte
    // fewer than it has characters.
    const kept = group.length - 1;
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const tail = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
    out.push(...tail.slice(0, kept));
  }
  return Uint8Array.from(out);
}

export function pdfAsciiHexDecode(bytes) {
  const out = [];
  let high = -1;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === 62) break;
    const value = pdfHexValue(bytes[index]);
    if (value < 0) continue;
    if (high < 0) high = value;
    else { out.push(high * 16 + value); high = -1; }
  }
  if (high >= 0) out.push(high * 16);
  return Uint8Array.from(out);
}

export function pdfRunLengthDecode(bytes) {
  const out = [];
  let index = 0;
  while (index < bytes.length) {
    const length = bytes[index++];
    if (length === 128) break;
    if (length < 128) {
      for (let count = 0; count <= length && index < bytes.length; count++) out.push(bytes[index++]);
    } else {
      const value = bytes[index++];
      for (let count = 0; count < 257 - length; count++) out.push(value);
    }
  }
  return Uint8Array.from(out);
}

// LZW as PDF uses it: codes packed most significant bit first, growing from
// nine bits to twelve, with 256 clearing the table and 257 ending the data.
// `earlyChange` is the off-by-one the format inherited from TIFF: by default
// the code width grows one code sooner than the table strictly needs.
export function pdfLzwDecode(bytes, earlyChange = 1) {
  const out = [];
  let table = [];
  const reset = () => {
    table = [];
    for (let code = 0; code < 256; code++) table.push([code]);
    table.push(null, null);
  };
  reset();
  let width = 9;
  let hold = 0;
  let held = 0;
  let previous = null;
  for (let index = 0; index < bytes.length; index++) {
    hold = (hold << 8) | bytes[index];
    held += 8;
    while (held >= width) {
      const code = (hold >> (held - width)) & ((1 << width) - 1);
      held -= width;
      hold &= (1 << held) - 1;
      if (code === 257) return Uint8Array.from(out);
      if (code === 256) { reset(); width = 9; previous = null; continue; }
      let entry;
      if (code < table.length && table[code]) entry = table[code];
      else if (previous) entry = previous.concat(previous[0]);
      else return Uint8Array.from(out);
      for (const value of entry) out.push(value);
      if (previous && table.length < 4096) table.push(previous.concat(entry[0]));
      previous = entry;
      const size = table.length + earlyChange;
      width = size > 2048 ? 12 : size > 1024 ? 11 : size > 512 ? 10 : 9;
    }
  }
  return Uint8Array.from(out);
}

// PNG row filters, which is what "Predictor 10 and up" means. Each row carries
// its own filter byte, so the declared predictor number does not matter beyond
// saying that PNG prediction is in use.
export function pdfPngUnpredict(bytes, columns, colors, bitsPerComponent) {
  const pixelBytes = Math.max(1, Math.ceil((colors * bitsPerComponent) / 8));
  const rowBytes = Math.ceil((columns * colors * bitsPerComponent) / 8);
  if (!(rowBytes > 0)) return bytes;
  const rows = Math.floor(bytes.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  for (let row = 0; row < rows; row++) {
    const filter = bytes[row * (rowBytes + 1)];
    const from = row * (rowBytes + 1) + 1;
    const to = row * rowBytes;
    for (let index = 0; index < rowBytes; index++) {
      const left = index >= pixelBytes ? out[to + index - pixelBytes] : 0;
      const up = row ? out[to + index - rowBytes] : 0;
      const upLeft = row && index >= pixelBytes ? out[to + index - rowBytes - pixelBytes] : 0;
      let value = bytes[from + index];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const dLeft = Math.abs(estimate - left);
        const dUp = Math.abs(estimate - up);
        const dUpLeft = Math.abs(estimate - upLeft);
        value += dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft;
      }
      out[to + index] = value & 255;
    }
  }
  return out;
}

export function pdfResolve(doc, value) {
  // A reference can point at another reference; a file that makes a loop of
  // them should resolve to nothing rather than hang.
  for (let hops = 0; hops < 32 && isPdfRef(value); hops++) {
    value = doc.objects.has(value.ref) ? doc.objects.get(value.ref) : null;
  }
  return isPdfRef(value) ? null : value;
}

export function pdfDictGet(doc, dict, key) {
  return dict instanceof Map ? pdfResolve(doc, dict.get(key)) : null;
}

export function pdfStreamFilters(doc, stream) {
  const filter = pdfDictGet(doc, stream.dict, 'Filter') ?? pdfDictGet(doc, stream.dict, 'F');
  const list = Array.isArray(filter) ? filter : (filter ? [filter] : []);
  return list.map(name => pdfResolve(doc, name))
    .filter(name => typeof name === 'string')
    .map(name => PDF_FILTER_NAMES[name] || name);
}

// Decodes as far as it can and reports what it could not. The image filters
// (DCT, CCITT, JBIG2, JPX) are never undone here: their output is pixels, and a
// caller that wants an image is better served by the still-encoded bytes.
export function pdfStreamData(doc, stream) {
  let bytes = doc.bytes.subarray(stream.start, stream.end);
  const filters = pdfStreamFilters(doc, stream);
  let parms = pdfDictGet(doc, stream.dict, 'DecodeParms') ?? pdfDictGet(doc, stream.dict, 'DP');
  parms = Array.isArray(parms) ? parms.map(item => pdfResolve(doc, item)) : [parms];
  for (let index = 0; index < filters.length; index++) {
    const name = filters[index];
    const parm = parms[index] instanceof Map ? parms[index] : null;
    if (name === 'FlateDecode') bytes = inflateBytes(bytes);
    else if (name === 'LZWDecode') bytes = pdfLzwDecode(bytes, pdfDictGet(doc, parm, 'EarlyChange') ?? 1);
    else if (name === 'ASCII85Decode') bytes = pdfAscii85Decode(bytes);
    else if (name === 'ASCIIHexDecode') bytes = pdfAsciiHexDecode(bytes);
    else if (name === 'RunLengthDecode') bytes = pdfRunLengthDecode(bytes);
    else if (name === 'Crypt') continue;
    else return { bytes, remaining: filters.slice(index) };
    if (bytes.length > PDF_MAX_STREAM_BYTES) throw new Error('A stream in this PDF is too large to read.');
    const predictor = pdfDictGet(doc, parm, 'Predictor') ?? 1;
    if (predictor >= 10 && (name === 'FlateDecode' || name === 'LZWDecode')) {
      bytes = pdfPngUnpredict(bytes,
        pdfDictGet(doc, parm, 'Columns') ?? 1,
        pdfDictGet(doc, parm, 'Colors') ?? 1,
        pdfDictGet(doc, parm, 'BitsPerComponent') ?? 8);
    }
  }
  return { bytes, remaining: [] };
}

// ---------------------------------------------------------------------------
// File structure
// ---------------------------------------------------------------------------

// The next `N G obj` at or after `from`, found by looking for the word and
// reading backwards. Backwards because the word is the rare part: a file is
// full of digits, and almost none of them begin an object.
function nextPdfObjectHeader(bytes, from, end) {
  let at = from;
  for (;;) {
    at = pdfIndexOf(bytes, 'obj', at, end);
    if (at < 0) return null;
    const after = at + 3;
    at = after;
    if (after < end && !PDF_CHAR_CLASS[bytes[after]]) continue;
    let pos = after - 4;
    const spaceBeforeWord = pos;
    while (pos >= from && PDF_CHAR_CLASS[bytes[pos]] === 1) pos--;
    if (pos === spaceBeforeWord) continue;
    const generationEnd = pos;
    while (pos >= from && bytes[pos] >= 48 && bytes[pos] <= 57) pos--;
    if (pos === generationEnd) continue;
    const spaceBeforeGeneration = pos;
    while (pos >= from && PDF_CHAR_CLASS[bytes[pos]] === 1) pos--;
    if (pos === spaceBeforeGeneration) continue;
    const numberEnd = pos;
    while (pos >= from && bytes[pos] >= 48 && bytes[pos] <= 57) pos--;
    if (pos === numberEnd || numberEnd - pos > 10) continue;
    // The number has to start a token: `x12 0 obj` is not object 12.
    if (pos >= from && !PDF_CHAR_CLASS[bytes[pos]]) continue;
    return { number: Number(pdfLatin1(bytes, pos + 1, numberEnd + 1)), at: pos + 1, after };
  }
}

function pdfStreamRange(doc, cursor, dict, lengths) {
  const { bytes, end } = cursor;
  let start = cursor.pos + 6;
  // The keyword is followed by CRLF or LF; a bare CR is not allowed and is
  // written anyway.
  if (bytes[start] === 13) start++;
  if (bytes[start] === 10) start++;
  let length = dict.get('Length');
  if (isPdfRef(length)) length = lengths.get(length.ref);
  if (Number.isSafeInteger(length) && length >= 0 && start + length <= end) {
    // Trust a declared length only if `endstream` really is where it says.
    let probe = start + length;
    while (probe < end && PDF_CHAR_CLASS[bytes[probe]] === 1) probe++;
    if (pdfMatchesAt(bytes, probe, 'endstream')) return { start, end: start + length, next: probe + 9 };
  }
  const found = pdfIndexOf(bytes, 'endstream', start, end);
  if (found < 0) return { start, end, next: end };
  let stop = found;
  // The line break before the keyword is not part of the data.
  if (stop > start && bytes[stop - 1] === 10) stop--;
  if (stop > start && bytes[stop - 1] === 13) stop--;
  return { start, end: stop, next: found + 9 };
}

function pdfObjectStreamEntries(doc, stream) {
  const count = pdfDictGet(doc, stream.dict, 'N');
  const first = pdfDictGet(doc, stream.dict, 'First');
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(first) || count < 0 || first < 0) return [];
  let data;
  try { data = pdfStreamData(doc, stream); } catch { return []; }
  if (data.remaining.length) return [];
  const header = { bytes: data.bytes, pos: 0, end: Math.min(first, data.bytes.length) };
  const index = [];
  for (let entry = 0; entry < count; entry++) {
    const number = readPdfObject(header, false);
    const offset = readPdfObject(header, false);
    if (typeof number !== 'number' || typeof offset !== 'number') break;
    index.push([number, offset]);
  }
  return index.map(([number, offset]) => {
    const cursor = { bytes: data.bytes, pos: first + offset, end: data.bytes.length };
    const value = readPdfObject(cursor);
    return [number, value === PDF_EOF || value === PDF_ARRAY_END || value === PDF_DICT_END ? null : value];
  });
}

function pdfNumberArray(doc, value, length) {
  const array = pdfResolve(doc, value);
  if (!Array.isArray(array) || array.length < length) return null;
  const numbers = array.slice(0, length).map(item => pdfResolve(doc, item));
  return numbers.every(Number.isFinite) ? numbers : null;
}

function collectPdfPages(doc) {
  const pages = [];
  const seen = new Set();
  // An explicit stack rather than recursion: a page tree is usually three
  // levels deep, and occasionally a linked list a thousand long.
  const stack = [{ node: doc.root.get('Pages'), inherited: {} }];
  while (stack.length && pages.length < 100000) {
    const { node, inherited } = stack.pop();
    const dict = pdfResolve(doc, node);
    if (!(dict instanceof Map) || seen.has(dict)) continue;
    seen.add(dict);
    const attributes = { ...inherited };
    for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate', 'UserUnit']) {
      if (dict.has(key)) attributes[key] = dict.get(key);
    }
    const kids = pdfResolve(doc, dict.get('Kids'));
    if (Array.isArray(kids) && dict.get('Type') !== 'Page') {
      // Reversed so the stack hands them back in reading order.
      for (let index = kids.length - 1; index >= 0; index--) stack.push({ node: kids[index], inherited: attributes });
    } else {
      pages.push({ dict, ...attributes });
    }
  }
  return pages;
}

// Where a page sits and which way up, as the matrix that takes its own
// coordinates to millimetres from the bottom-left corner of the page as a
// reader would display it. /Rotate turns the page clockwise, so a landscape
// drawing saved as a rotated portrait page comes out landscape here too.
export function pdfPageGeometry(doc, page) {
  const media = pdfNumberArray(doc, page.MediaBox, 4) || [0, 0, 612, 792];
  const crop = pdfNumberArray(doc, page.CropBox, 4);
  let x0 = Math.min(media[0], media[2]);
  let y0 = Math.min(media[1], media[3]);
  let x1 = Math.max(media[0], media[2]);
  let y1 = Math.max(media[1], media[3]);
  if (crop) {
    // The crop box is what a reader shows; it cannot reach outside the media.
    const cx0 = Math.max(x0, Math.min(crop[0], crop[2]));
    const cy0 = Math.max(y0, Math.min(crop[1], crop[3]));
    const cx1 = Math.min(x1, Math.max(crop[0], crop[2]));
    const cy1 = Math.min(y1, Math.max(crop[1], crop[3]));
    if (cx1 - cx0 > 1e-6 && cy1 - cy0 > 1e-6) { x0 = cx0; y0 = cy0; x1 = cx1; y1 = cy1; }
  }
  const width = x1 - x0;
  const height = y1 - y0;
  if (!(width > 1e-6) || !(height > 1e-6)) return null;
  const userUnit = pdfResolve(doc, page.UserUnit);
  const mm = (25.4 / 72) * (Number.isFinite(userUnit) && userUnit > 0 ? userUnit : 1);
  const turn = pdfResolve(doc, page.Rotate);
  const rotate = Number.isFinite(turn) ? ((Math.round(turn / 90) * 90) % 360 + 360) % 360 : 0;
  let matrix;
  if (rotate === 90) matrix = [0, -mm, mm, 0, -y0 * mm, x1 * mm];
  else if (rotate === 180) matrix = [-mm, 0, 0, -mm, x1 * mm, y1 * mm];
  else if (rotate === 270) matrix = [0, mm, -mm, 0, y1 * mm, -x0 * mm];
  else matrix = [mm, 0, 0, mm, -x0 * mm, -y0 * mm];
  const sideways = rotate === 90 || rotate === 270;
  return {
    widthMM: (sideways ? height : width) * mm,
    heightMM: (sideways ? width : height) * mm,
    rotate,
    matrix,
  };
}

// Returns { doc } or { error }. The document is everything a page reader
// needs: the bytes, the object table, the catalog and the page list.
export function openPdf(input) {
  const bytes = input && input.subarray ? input : Uint8Array.from(input || []);
  const size = bytes.length;
  if (size > PDF_MAX_BYTES) return { error: 'That PDF is too large to read here.' };
  // The header is allowed to sit a little way in; mail software and some
  // scanners put a line of their own ahead of it.
  if (size < 16 || pdfIndexOf(bytes, '%PDF-', 0, Math.min(size, 1024)) < 0) {
    return { error: 'That file is not a PDF.' };
  }

  const doc = { bytes, objects: new Map(), root: null, pages: [] };

  // Stream lengths are often written as a reference to an integer object that
  // comes after the stream. Collecting the bare integers first means a length
  // is known by the time its stream is reached.
  const lengths = new Map();
  for (let from = 0; ;) {
    const header = nextPdfObjectHeader(bytes, from, size);
    if (!header) break;
    from = header.after;
    const cursor = { bytes, pos: header.after, end: Math.min(size, header.after + 40) };
    skipPdfSpace(cursor);
    if (!(bytes[cursor.pos] >= 48 && bytes[cursor.pos] <= 57)) continue;
    const value = readPdfNumber(cursor);
    skipPdfSpace(cursor);
    if (cursor.integer && pdfMatchesAt(bytes, cursor.pos, 'endobj')) lengths.set(header.number, value);
  }

  const trailers = [];
  const objectStreams = [];
  const definedAt = new Map();
  const define = (number, value, position) => {
    // Later in the file wins, which is how an appended revision replaces an
    // object without touching the original.
    if (definedAt.has(number) && definedAt.get(number) > position) return;
    definedAt.set(number, position);
    doc.objects.set(number, value);
  };
  const noteTrailers = (from, to) => {
    for (let at = from; ;) {
      at = pdfIndexOf(bytes, 'trailer', at, to);
      if (at < 0) return;
      const cursor = { bytes, pos: at + 7, end: size };
      const dict = readPdfObject(cursor);
      if (dict instanceof Map) trailers.push({ dict, position: at });
      at += 7;
    }
  };

  let pos = 0;
  for (;;) {
    const header = nextPdfObjectHeader(bytes, pos, size);
    noteTrailers(pos, header ? header.at : size);
    if (!header) break;
    const cursor = { bytes, pos: header.after, end: size };
    let value = readPdfObject(cursor);
    if (value === PDF_EOF || value === PDF_ARRAY_END || value === PDF_DICT_END || (value && value.op)) value = null;
    skipPdfSpace(cursor);
    pos = cursor.pos;
    if (value instanceof Map && pdfMatchesAt(bytes, cursor.pos, 'stream')) {
      const range = pdfStreamRange(doc, cursor, value, lengths);
      value = { dict: value, start: range.start, end: range.end };
      pos = range.next;
      const type = value.dict.get('Type');
      if (type === 'ObjStm') objectStreams.push({ stream: value, position: header.at });
      // A cross-reference stream carries the same keys a trailer does.
      if (type === 'XRef') trailers.push({ dict: value.dict, position: header.at });
    }
    define(header.number, value, header.at);
  }

  // Expanded after the walk, since a stream's filter or length may be an
  // object that comes later in the file, but still filed under the position of
  // the stream that holds them so the later-wins rule is unaffected.
  for (const { stream, position } of objectStreams) {
    for (const [number, value] of pdfObjectStreamEntries(doc, stream)) define(number, value, position);
  }

  trailers.sort((a, b) => a.position - b.position);
  if (trailers.some(trailer => trailer.dict.has('Encrypt'))) {
    return { error: 'That PDF is encrypted. Save an unprotected copy of it, or print it to a new PDF, and place that.' };
  }
  for (let index = trailers.length - 1; index >= 0 && !doc.root; index--) {
    const root = pdfResolve(doc, trailers[index].dict.get('Root'));
    if (root instanceof Map && root.has('Pages')) doc.root = root;
  }
  if (!doc.root) {
    // No usable trailer: the catalog is still an object like any other.
    for (const value of doc.objects.values()) {
      if (value instanceof Map && value.get('Type') === 'Catalog' && value.has('Pages')) doc.root = value;
    }
  }
  if (!doc.root) return { error: 'That PDF has no page catalog and cannot be read.' };

  doc.pages = collectPdfPages(doc);
  if (!doc.pages.length) return { error: 'That PDF has no pages.' };
  return { doc };
}
