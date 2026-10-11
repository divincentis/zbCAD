import { PDF_EOF, isPdfRef, isPdfStream, isPdfString, pdfDictGet, pdfPageGeometry, pdfResolve, pdfStreamData, pdfStreamFilters, readPdfObject } from './pdfRead.js';
import { pdfFontRecord, pdfTextRun } from './pdfText.js';

// ---------------------------------------------------------------------------
// The PDF reader: one page
//
// Runs a page's content stream and writes down what it paints, in the shape
// output/plot.js builds for the way out: strokes, fills and text measured in
// millimetres from the bottom-left corner of the sheet, Y up. Reading into the
// plot plan's own shape is what lets a test plot a drawing, read the PDF back
// and compare the two plans directly, and it means everything that already
// consumes a plan (the PDF writer, the plot preview) can consume a page.
//
// This is an interpreter, not a renderer: it never rasterises. It follows the
// graphics state closely enough to know where each path ends up and in what
// colour, and deliberately stops short of the parts of the imaging model a
// drawing to be traced over does not need:
//
//   - Clipping is tracked as a rectangle (the bounding box of each clip path).
//     That is exact for the case that matters, a viewport or plot window, and
//     conservative for an irregular clip, where it keeps a little too much.
//   - Transparency is flattened onto white paper.
//   - Pattern and shading fills are left out and counted.
//   - Text is positioned and sized exactly but carries no outlines; see
//     model/pdfText.js.
//   - Images are located, not decoded.
// ---------------------------------------------------------------------------

// A page with more line work than this is abandoned part-way with what it has.
// It is far past any real sheet and well short of what would hang the tab.
export const PDF_MAX_SEGMENTS = 4000000;
export const PDF_MAX_FORM_DEPTH = 16;
// A kerning adjustment this large, in thousandths of an em, is a word space
// written as a gap rather than as a character.
export const PDF_WORD_GAP_UNITS = 250;
// One this large is a jump to the next column, not a space within a line.
export const PDF_COLUMN_GAP_UNITS = 700;

const PDF_IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

// `first` applied, then `second` — the order PDF's `cm` builds a matrix in.
function pdfMatrixMultiply(first, second) {
  return [
    first[0] * second[0] + first[1] * second[2],
    first[0] * second[1] + first[1] * second[3],
    first[2] * second[0] + first[3] * second[2],
    first[2] * second[1] + first[3] * second[3],
    first[4] * second[0] + first[5] * second[2] + second[4],
    first[4] * second[1] + first[5] * second[3] + second[5],
  ];
}

function pdfClamp01(value) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const PDF_GRAY_SPACE = Object.freeze({ kind: 'gray', components: 1 });
const PDF_RGB_SPACE = Object.freeze({ kind: 'rgb', components: 3 });
const PDF_CMYK_SPACE = Object.freeze({ kind: 'cmyk', components: 4 });
const PDF_PATTERN_SPACE = Object.freeze({ kind: 'pattern', components: 0 });

function pdfColorSpace(doc, resources, value, depth = 0) {
  value = pdfResolve(doc, value);
  if (typeof value === 'string') {
    if (value === 'DeviceGray' || value === 'G' || value === 'CalGray') return PDF_GRAY_SPACE;
    if (value === 'DeviceRGB' || value === 'RGB' || value === 'CalRGB') return PDF_RGB_SPACE;
    if (value === 'DeviceCMYK' || value === 'CMYK') return PDF_CMYK_SPACE;
    if (value === 'Pattern') return PDF_PATTERN_SPACE;
    const named = pdfDictGet(doc, pdfDictGet(doc, resources, 'ColorSpace'), value);
    return named && depth < 4 ? pdfColorSpace(doc, resources, named, depth + 1) : PDF_GRAY_SPACE;
  }
  if (!Array.isArray(value) || !value.length) return PDF_GRAY_SPACE;
  const family = pdfResolve(doc, value[0]);
  if (family === 'ICCBased') {
    // The profile is not read; its channel count says which device space it
    // stands in for, and for line work that is close enough.
    const profile = pdfResolve(doc, value[1]);
    const channels = isPdfStream(profile) ? pdfDictGet(doc, profile.dict, 'N') : 3;
    return channels === 1 ? PDF_GRAY_SPACE : channels === 4 ? PDF_CMYK_SPACE : PDF_RGB_SPACE;
  }
  if (family === 'CalRGB' || family === 'DeviceRGB') return PDF_RGB_SPACE;
  if (family === 'CalGray' || family === 'DeviceGray') return PDF_GRAY_SPACE;
  if (family === 'DeviceCMYK') return PDF_CMYK_SPACE;
  if (family === 'Lab') return { kind: 'lab', components: 3 };
  if (family === 'Pattern') return PDF_PATTERN_SPACE;
  if (family === 'Indexed' || family === 'I') {
    const base = depth < 4 ? pdfColorSpace(doc, resources, value[1], depth + 1) : PDF_RGB_SPACE;
    let table = pdfResolve(doc, value[3]);
    if (isPdfStream(table)) {
      try { table = pdfStreamData(doc, table).bytes; } catch { table = null; }
    } else if (isPdfString(table)) {
      table = Uint8Array.from(table.string, character => character.charCodeAt(0));
    } else {
      table = null;
    }
    return { kind: 'indexed', components: 1, base, table };
  }
  if (family === 'Separation') {
    const name = pdfResolve(doc, value[1]);
    return { kind: name === 'None' ? 'none' : 'tint', components: 1 };
  }
  if (family === 'DeviceN') {
    const names = pdfResolve(doc, value[1]);
    return { kind: 'tint', components: Array.isArray(names) ? names.length : 1 };
  }
  return PDF_GRAY_SPACE;
}

// A colour as [r, g, b] in 0..1, or null for one that cannot be painted with
// (a pattern, or the separation that means "no ink").
function pdfInkColor(space, values) {
  const numbers = values.filter(Number.isFinite);
  if (space.kind === 'pattern' || space.kind === 'none') return null;
  if (space.kind === 'rgb') return [pdfClamp01(numbers[0]), pdfClamp01(numbers[1]), pdfClamp01(numbers[2])];
  if (space.kind === 'cmyk') {
    const black = 1 - pdfClamp01(numbers[3]);
    return [
      (1 - pdfClamp01(numbers[0])) * black,
      (1 - pdfClamp01(numbers[1])) * black,
      (1 - pdfClamp01(numbers[2])) * black,
    ];
  }
  if (space.kind === 'lab') {
    const level = pdfClamp01((numbers[0] ?? 0) / 100);
    return [level, level, level];
  }
  if (space.kind === 'tint') {
    // A spot colour's real appearance lives in a function this reader does not
    // run. Full tint is drawn as full ink, which keeps line work visible.
    const level = 1 - pdfClamp01(Math.max(0, ...numbers));
    return [level, level, level];
  }
  if (space.kind === 'indexed') {
    const size = space.base.components || 3;
    const at = Math.max(0, Math.round(numbers[0] ?? 0)) * size;
    if (!space.table || at + size > space.table.length) return [0, 0, 0];
    const entry = [];
    for (let channel = 0; channel < size; channel++) entry.push(space.table[at + channel] / 255);
    return pdfInkColor(space.base, entry);
  }
  const level = pdfClamp01(numbers[0]);
  return [level, level, level];
}

// Ink at less than full opacity, flattened onto the white sheet behind it.
function pdfOnPaper(color, alpha) {
  if (!(alpha < 1)) return color;
  const a = pdfClamp01(alpha);
  return [1 - a * (1 - color[0]), 1 - a * (1 - color[1]), 1 - a * (1 - color[2])];
}

function pdfSameColor(a, b) {
  return Math.abs(a[0] - b[0]) < 0.002 && Math.abs(a[1] - b[1]) < 0.002 && Math.abs(a[2] - b[2]) < 0.002;
}

// ---------------------------------------------------------------------------
// Clipping
// ---------------------------------------------------------------------------

function pdfSubpathsBox(subpaths) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const take = point => {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  };
  for (const subpath of subpaths) {
    take(subpath.start);
    for (const segment of subpath.segs) {
      // A curve stays inside the hull of its control points, so including
      // them gives a box that is never too small.
      if (segment.type === 'c') { take(segment.c1); take(segment.c2); }
      take(segment.to);
    }
  }
  return { minX, minY, maxX, maxY };
}

function pdfBoxIntersect(a, b) {
  return {
    minX: Math.max(a.minX, b.minX), minY: Math.max(a.minY, b.minY),
    maxX: Math.min(a.maxX, b.maxX), maxY: Math.min(a.maxY, b.maxY),
  };
}

// Straight points along a subpath, curves included. Only used on paths that
// cross the clip edge, where the pieces are about to be cut anyway.
function pdfFlattenSubpath(subpath) {
  const points = [subpath.start];
  let from = subpath.start;
  for (const segment of subpath.segs) {
    if (segment.type === 'c') {
      const reach = Math.hypot(segment.c1.x - from.x, segment.c1.y - from.y)
        + Math.hypot(segment.c2.x - segment.c1.x, segment.c2.y - segment.c1.y)
        + Math.hypot(segment.to.x - segment.c2.x, segment.to.y - segment.c2.y);
      const steps = Math.min(64, Math.max(4, Math.ceil(reach / 0.4)));
      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const u = 1 - t;
        points.push({
          x: u * u * u * from.x + 3 * u * u * t * segment.c1.x + 3 * u * t * t * segment.c2.x + t * t * t * segment.to.x,
          y: u * u * u * from.y + 3 * u * u * t * segment.c1.y + 3 * u * t * t * segment.c2.y + t * t * t * segment.to.y,
        });
      }
    } else {
      points.push(segment.to);
    }
    from = segment.to;
  }
  return points;
}

// Liang-Barsky: the part of a..b inside the box, or null.
function pdfClipSegment(a, b, box) {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges = [[-dx, a.x - box.minX], [dx, box.maxX - a.x], [-dy, a.y - box.minY], [dy, box.maxY - a.y]];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
    else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return [
    t0 > 0 ? { x: a.x + dx * t0, y: a.y + dy * t0 } : a,
    t1 < 1 ? { x: a.x + dx * t1, y: a.y + dy * t1 } : b,
  ];
}

// Geometry drawn right up to a clip edge is written by one piece of arithmetic
// and the edge by another, so "inside" is given a hair of slack. Without it a
// circle touching its viewport would count as crossing it, and be cut into
// straight pieces for the sake of a rounding error.
const PDF_CLIP_SLACK_MM = 1e-4;

function pdfBoxOutside(inner, box) {
  return inner.maxX < box.minX || inner.minX > box.maxX || inner.maxY < box.minY || inner.minY > box.maxY;
}

function pdfBoxInside(inner, box) {
  return inner.minX >= box.minX - PDF_CLIP_SLACK_MM && inner.maxX <= box.maxX + PDF_CLIP_SLACK_MM
    && inner.minY >= box.minY - PDF_CLIP_SLACK_MM && inner.maxY <= box.maxY + PDF_CLIP_SLACK_MM;
}

function pdfClipStroke(subpaths, box) {
  const whole = pdfSubpathsBox(subpaths);
  if (pdfBoxOutside(whole, box)) return [];
  if (pdfBoxInside(whole, box)) return subpaths;
  const out = [];
  for (const subpath of subpaths) {
    const own = pdfSubpathsBox([subpath]);
    if (pdfBoxOutside(own, box)) continue;
    if (pdfBoxInside(own, box)) {
      out.push(subpath);
      continue;
    }
    const points = pdfFlattenSubpath(subpath);
    if (subpath.closed) points.push(subpath.start);
    let piece = null;
    for (let index = 1; index < points.length; index++) {
      const cut = pdfClipSegment(points[index - 1], points[index], box);
      if (!cut) { piece = null; continue; }
      // A piece carries on only while each cut segment starts where the last
      // one stopped; leaving the box and coming back starts a new one.
      if (piece && cut[0] === points[index - 1]) {
        piece.segs.push({ type: 'l', to: cut[1] });
      } else {
        piece = { start: cut[0], segs: [{ type: 'l', to: cut[1] }], closed: false };
        out.push(piece);
      }
      if (cut[1] !== points[index]) piece = null;
    }
  }
  return out;
}

// Sutherland-Hodgman against the four sides of the box. Each contour is cut
// on its own, which is valid for either fill rule because the box is convex.
function pdfClipFill(subpaths, box) {
  const whole = pdfSubpathsBox(subpaths);
  if (pdfBoxOutside(whole, box)) return [];
  if (pdfBoxInside(whole, box)) return subpaths;
  const sides = [
    [point => point.x >= box.minX, (a, b) => ({ x: box.minX, y: a.y + (b.y - a.y) * (box.minX - a.x) / (b.x - a.x) })],
    [point => point.x <= box.maxX, (a, b) => ({ x: box.maxX, y: a.y + (b.y - a.y) * (box.maxX - a.x) / (b.x - a.x) })],
    [point => point.y >= box.minY, (a, b) => ({ x: a.x + (b.x - a.x) * (box.minY - a.y) / (b.y - a.y), y: box.minY })],
    [point => point.y <= box.maxY, (a, b) => ({ x: a.x + (b.x - a.x) * (box.maxY - a.y) / (b.y - a.y), y: box.maxY })],
  ];
  const out = [];
  for (const subpath of subpaths) {
    let points = pdfFlattenSubpath(subpath);
    for (const [inside, cross] of sides) {
      const next = [];
      for (let index = 0; index < points.length; index++) {
        const a = points[index];
        const b = points[(index + 1) % points.length];
        const aIn = inside(a);
        const bIn = inside(b);
        if (aIn) next.push(a);
        if (aIn !== bIn) next.push(cross(a, b));
      }
      points = next;
      if (points.length < 3) break;
    }
    if (points.length < 3) continue;
    out.push({ start: points[0], segs: points.slice(1).map(to => ({ type: 'l', to })), closed: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Optional content ("layers")
// ---------------------------------------------------------------------------

// Object numbers of the layers a reader would open the file with switched off.
function pdfHiddenLayers(doc) {
  if (doc.hiddenLayers) return doc.hiddenLayers;
  const hidden = new Set();
  const properties = pdfDictGet(doc, doc.root, 'OCProperties');
  const config = pdfDictGet(doc, properties, 'D');
  const refs = list => (Array.isArray(list) ? list.filter(isPdfRef).map(item => item.ref) : []);
  if (pdfDictGet(doc, config, 'BaseState') === 'OFF') {
    for (const ref of refs(pdfDictGet(doc, properties, 'OCGs'))) hidden.add(ref);
    for (const ref of refs(pdfDictGet(doc, config, 'ON'))) hidden.delete(ref);
  }
  for (const ref of refs(pdfDictGet(doc, config, 'OFF'))) hidden.add(ref);
  doc.hiddenLayers = hidden;
  return hidden;
}

// `entry` is the /OC value as written: a reference to a layer, or to a
// membership dictionary naming several. A membership is hidden when every
// layer it names is — the default policy, and the only one worth following.
function pdfLayerHidden(doc, entry) {
  const hidden = pdfHiddenLayers(doc);
  if (!hidden.size) return false;
  if (isPdfRef(entry) && hidden.has(entry.ref)) return true;
  const dict = pdfResolve(doc, entry);
  if (!(dict instanceof Map) || dict.get('Type') !== 'OCMD') return false;
  const groups = dict.get('OCGs');
  const list = (Array.isArray(pdfResolve(doc, groups)) ? pdfResolve(doc, groups) : [groups]).filter(isPdfRef);
  return list.length > 0 && list.every(item => hidden.has(item.ref));
}

// ---------------------------------------------------------------------------
// The interpreter
// ---------------------------------------------------------------------------

function pdfContentBytes(doc, contents) {
  const value = pdfResolve(doc, contents);
  const streams = (Array.isArray(value) ? value.map(item => pdfResolve(doc, item)) : [value]).filter(isPdfStream);
  const parts = [];
  let total = 0;
  for (const stream of streams) {
    let data;
    try { data = pdfStreamData(doc, stream); } catch { continue; }
    if (data.remaining.length) continue;
    parts.push(data.bytes);
    total += data.bytes.length + 1;
  }
  if (parts.length === 1) return parts[0];
  // The streams of one page are a single program split at arbitrary token
  // boundaries, so they are joined with white space between them.
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
    joined[at++] = 10;
  }
  return joined;
}

// Steps over an inline image's data, which is raw bytes sitting in the middle
// of the content stream. There is no length; the data ends at an `EI` that
// stands alone, and binary data can contain those two letters, so the one that
// counts is the first that is followed by something that still reads as PDF.
function pdfSkipInlineImage(cursor) {
  const { bytes, end } = cursor;
  for (;;) {
    const token = readPdfObject(cursor, false);
    if (token === PDF_EOF) return;
    if (token && token.op === 'ID') break;
  }
  let pos = cursor.pos + 1;
  for (; pos + 1 < end; pos++) {
    if (bytes[pos] !== 69 || bytes[pos + 1] !== 73) continue;
    const before = bytes[pos - 1];
    const after = pos + 2 < end ? bytes[pos + 2] : 32;
    const spaced = code => code === 0 || code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
    if (!spaced(before) || !spaced(after)) continue;
    // Whatever follows a real EI is an operator or operand in plain ASCII.
    let plain = true;
    for (let probe = pos + 2; probe < Math.min(end, pos + 12); probe++) {
      if (bytes[probe] > 126 || (bytes[probe] < 32 && !spaced(bytes[probe]))) { plain = false; break; }
    }
    if (plain) break;
  }
  cursor.pos = Math.min(end, pos + 2);
}

function runPdfContent(run, bytes, resources, depth) {
  const { doc, plan } = run;
  const ops = plan.ops;
  const cursor = { bytes, pos: 0, end: bytes.length };
  const args = [];
  let gs = run.gs;

  let path = [];
  let subpath = null;
  let current = null;
  let pendingClip = false;
  let textMatrix = PDF_IDENTITY;
  let lineMatrix = PDF_IDENTITY;
  // One entry per open marked-content section, true where that section is a
  // switched-off layer. Kept apart from the graphics state because q/Q and
  // BDC/EMC nest independently.
  const marked = [];
  const hiddenBefore = run.hidden;

  const number = index => {
    const value = args[index];
    return typeof value === 'number' ? value : 0;
  };
  const point = (x, y) => {
    const m = gs.ctm;
    return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
  };
  const moveTo = at => {
    // Two moves in a row: the first one drew nothing and is replaced.
    if (subpath && !subpath.segs.length) path.pop();
    subpath = { start: at, segs: [], closed: false };
    path.push(subpath);
    current = at;
  };
  const ensureSubpath = () => {
    if (subpath && !subpath.closed) return true;
    // Drawing on after a close starts a new subpath where the old one began.
    if (current) { moveTo(current); return true; }
    return false;
  };
  const closeSubpath = () => {
    if (!subpath || subpath.closed) return;
    subpath.closed = true;
    current = subpath.start;
  };
  const endPath = () => {
    if (pendingClip) {
      const drawn = path.filter(item => item.segs.length);
      gs.clip = drawn.length ? pdfBoxIntersect(gs.clip, pdfSubpathsBox(drawn)) : gs.clip;
      pendingClip = false;
    }
    path = [];
    subpath = null;
    current = null;
  };
  const lineScale = () => Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2]));

  const stroke = () => {
    if (run.hidden || !gs.strokeColor || run.segments > PDF_MAX_SEGMENTS) return;
    const drawn = pdfClipStroke(path.filter(item => item.segs.length), gs.clip);
    if (!drawn.length) return;
    const scale = lineScale();
    const widthMM = gs.lineWidth * scale;
    const dash = gs.dash.some(value => value > 0) ? gs.dash.map(value => value * scale) : [];
    const color = pdfOnPaper(gs.strokeColor, gs.strokeAlpha);
    for (const item of drawn) run.segments += item.segs.length;
    // Consecutive strokes in one style become a single op. A CAD page is
    // mostly runs of thousands of separate lines in the same pen, and one path
    // per run is what keeps both the stored page and its redraw small.
    const last = ops[ops.length - 1];
    if (last && last.kind === 'stroke' && Math.abs(last.widthMM - widthMM) < 1e-6
      && pdfSameColor(last.color, color) && last.dash.length === dash.length
      && last.dash.every((value, index) => Math.abs(value - dash[index]) < 1e-6)) {
      for (const item of drawn) last.subpaths.push(item);
      return;
    }
    ops.push({ kind: 'stroke', widthMM, dash, color, subpaths: drawn });
  };

  const fill = evenOdd => {
    if (run.hidden || run.segments > PDF_MAX_SEGMENTS) return;
    if (!gs.fillColor) { plan.skipped.patterns++; return; }
    // Two points enclose nothing; a lone curve can.
    const closedAreas = path.filter(item => item.segs.length > 1 || item.segs[0]?.type === 'c');
    const drawn = pdfClipFill(closedAreas, gs.clip);
    if (!drawn.length) return;
    const color = pdfOnPaper(gs.fillColor, gs.fillAlpha);
    for (const item of drawn) run.segments += item.segs.length;
    const only = drawn[0];
    if (drawn.length === 1 && !evenOdd && only.segs.every(segment => segment.type === 'l')) {
      // The simple polygon the plot plan already uses for arrowheads.
      const points = [only.start, ...only.segs.map(segment => segment.to)];
      const tail = points[points.length - 1];
      if (points.length > 3 && Math.abs(tail.x - only.start.x) < 1e-9 && Math.abs(tail.y - only.start.y) < 1e-9) {
        points.pop();
      }
      ops.push({ kind: 'fill', color, points });
      return;
    }
    ops.push({ kind: 'fill', color, evenOdd: Boolean(evenOdd), subpaths: drawn });
  };

  // One piece of shown text, starting `offset` along the baseline from the
  // text matrix and `advance` long, both in text space.
  const placeText = (font, raw, unknown, offset, advance) => {
    // Mode 3 is invisible text — the searchable layer under a scanned page —
    // and 7 only adds to the clip. Neither puts ink on the sheet.
    if (run.hidden || gs.renderMode === 3 || gs.renderMode === 7) return;
    const text = raw.replace(/[\u0000-\u001f\u007f]/g, '');
    if (!text.trim()) {
      if (unknown) plan.skipped.text++;
      return;
    }
    const stroked = gs.renderMode === 1 || gs.renderMode === 5;
    const color = stroked ? gs.strokeColor : gs.fillColor;
    if (!color) return;
    const size = gs.fontSize;
    const placed = pdfMatrixMultiply([1, 0, 0, 1, offset, 0], pdfMatrixMultiply(textMatrix, gs.ctm));
    const direction = size * gs.hScale < 0 ? -1 : 1;
    const xScale = Math.hypot(placed[0], placed[1]);
    const sizeMM = Math.abs(size) * Math.hypot(placed[2], placed[3]);
    const widthMM = Math.abs(advance) * xScale;
    if (!(sizeMM > 1e-6) || !(xScale > 1e-12)) return;
    const x = placed[2] * gs.rise + placed[4];
    const y = placed[3] * gs.rise + placed[5];
    const angle = Math.atan2(placed[1] * direction, placed[0] * direction);
    const endX = x + Math.cos(angle) * widthMM;
    const endY = y + Math.sin(angle) * widthMM;
    const outside = (px, py) => px < gs.clip.minX - sizeMM || px > gs.clip.maxX + sizeMM
      || py < gs.clip.minY - sizeMM || py > gs.clip.maxY + sizeMM;
    if (outside(x, y) && outside(endX, endY)) return;
    if (unknown) plan.skipped.text++;

    const inked = pdfOnPaper(color, stroked ? gs.strokeAlpha : gs.fillAlpha);
    // Many writers place a line of text a word, or a letter, at a time. Where
    // one run starts where the previous one stopped, on the same baseline in
    // the same face, they are the same line of text and are stored as one.
    const last = ops[ops.length - 1];
    if (last && last.kind === 'text' && last.font === font.face && pdfSameColor(last.color, inked)
      && Math.abs(last.sizeMM - sizeMM) < sizeMM * 0.02
      && Math.abs(Math.atan2(Math.sin(last.angle - angle), Math.cos(last.angle - angle))) < 0.01) {
      const along = (x - last.x) * Math.cos(angle) + (y - last.y) * Math.sin(angle);
      const across = -(x - last.x) * Math.sin(angle) + (y - last.y) * Math.cos(angle);
      const gap = along - last.widthMM;
      if (Math.abs(across) < sizeMM * 0.1 && gap > -sizeMM * 0.25 && gap < sizeMM * PDF_COLUMN_GAP_UNITS / 1000) {
        const spaced = gap > sizeMM * 0.18 && !last.text.endsWith(' ') && !text.startsWith(' ');
        last.text += (spaced ? ' ' : '') + text;
        last.widthMM = along + widthMM;
        return;
      }
    }
    ops.push({
      kind: 'text', text, x, y, angle, sizeMM, widthMM,
      font: font.face, anchor: 'left', baseline: 'alphabetic', color: inked,
    });
  };

  const showText = items => {
    const font = gs.font;
    if (!font) return;
    const size = gs.fontSize;
    let text = '';
    let unknown = 0;
    let begun = false;
    let start = 0;
    let advance = 0;
    const flush = () => {
      if (begun) placeText(font, text, unknown, start, advance - start);
      text = '';
      unknown = 0;
      begun = false;
    };
    for (const item of items) {
      if (typeof item === 'number') {
        // A table row is often one operator, with the jump to each column
        // written as a huge kerning adjustment. Those are separate strings
        // that happen to share a baseline, so the run is cut there; stretching
        // one string across the whole row would put every cell in the wrong
        // place. A backwards jump is cut for the same reason.
        if (item < -PDF_COLUMN_GAP_UNITS || item > PDF_WORD_GAP_UNITS) flush();
        else if (item < -PDF_WORD_GAP_UNITS && text && !text.endsWith(' ')) text += ' ';
        advance -= (item / 1000) * size * gs.hScale;
      } else if (isPdfString(item)) {
        if (!begun) { begun = true; start = advance; }
        const piece = pdfTextRun(font, item.string);
        text += piece.text;
        unknown += piece.unknown;
        advance += ((piece.units / 1000) * size + piece.glyphs * gs.charSpace + piece.spaces * gs.wordSpace) * gs.hScale;
      }
    }
    flush();
    textMatrix = pdfMatrixMultiply([1, 0, 0, 1, advance, 0], textMatrix);
  };

  const nextLine = (tx, ty) => {
    lineMatrix = pdfMatrixMultiply([1, 0, 0, 1, tx, ty], lineMatrix);
    textMatrix = lineMatrix;
  };

  const setColor = (stroking, space, values) => {
    const color = pdfInkColor(space, values);
    if (stroking) { gs.strokeSpace = space; gs.strokeColor = color; }
    else { gs.fillSpace = space; gs.fillColor = color; }
  };

  const drawObject = name => {
    const xobjects = pdfDictGet(doc, resources, 'XObject');
    const stream = pdfDictGet(doc, xobjects, name);
    if (!isPdfStream(stream)) return;
    if (stream.dict.has('OC') && pdfLayerHidden(doc, stream.dict.get('OC'))) return;
    const subtype = stream.dict.get('Subtype');
    if (subtype === 'Image') {
      if (run.hidden) return;
      const m = gs.ctm;
      const corners = [point(0, 0), point(1, 0), point(1, 1), point(0, 1)];
      const box = pdfSubpathsBox([{ start: corners[0], segs: corners.slice(1).map(to => ({ type: 'l', to })) }]);
      if (pdfBoxOutside(box, gs.clip)) return;
      ops.push({
        kind: 'image',
        data: null,
        source: stream,
        filters: pdfStreamFilters(doc, stream),
        mask: pdfDictGet(doc, stream.dict, 'ImageMask') === true,
        pixelWidth: pdfDictGet(doc, stream.dict, 'Width') || 0,
        pixelHeight: pdfDictGet(doc, stream.dict, 'Height') || 0,
        origin: corners[0],
        edgeX: { x: m[0], y: m[1] },
        edgeY: { x: m[2], y: m[3] },
        alpha: gs.fillAlpha,
        widthMM: Math.hypot(m[0], m[1]),
        heightMM: Math.hypot(m[2], m[3]),
      });
      return;
    }
    if (subtype !== 'Form' || depth >= PDF_MAX_FORM_DEPTH) return;
    let data = run.forms.get(stream);
    if (data === undefined) {
      try {
        const decoded = pdfStreamData(doc, stream);
        data = decoded.remaining.length ? null : decoded.bytes;
      } catch {
        data = null;
      }
      run.forms.set(stream, data);
    }
    if (!data) return;
    // A form is drawn as if wrapped in q ... Q, in its own matrix, clipped to
    // its own bounding box.
    const saved = gs;
    gs = { ...gs };
    const matrix = pdfDictGet(doc, stream.dict, 'Matrix');
    if (Array.isArray(matrix) && matrix.length >= 6) {
      const values = matrix.slice(0, 6).map(item => pdfResolve(doc, item));
      if (values.every(Number.isFinite)) gs.ctm = pdfMatrixMultiply(values, gs.ctm);
    }
    const bbox = pdfDictGet(doc, stream.dict, 'BBox');
    if (Array.isArray(bbox) && bbox.length >= 4) {
      const [x0, y0, x1, y1] = bbox.slice(0, 4).map(item => pdfResolve(doc, item));
      if ([x0, y0, x1, y1].every(Number.isFinite)) {
        const corners = [point(x0, y0), point(x1, y0), point(x1, y1), point(x0, y1)];
        gs.clip = pdfBoxIntersect(gs.clip,
          pdfSubpathsBox([{ start: corners[0], segs: corners.slice(1).map(to => ({ type: 'l', to })) }]));
      }
    }
    run.gs = gs;
    // An unbalanced Q inside the form must not pop state that belongs to
    // whoever drew it, so the form gets its own floor in the shared stack.
    const stackDepth = run.stack.length;
    const floor = run.floor;
    run.floor = stackDepth;
    runPdfContent(run, data, pdfDictGet(doc, stream.dict, 'Resources') || resources, depth + 1);
    run.stack.length = stackDepth;
    run.floor = floor;
    gs = saved;
    run.gs = gs;
  };

  for (;;) {
    const token = readPdfObject(cursor, false);
    if (token === PDF_EOF) break;
    if (token === null || typeof token !== 'object' || token.op === undefined) {
      // Operands pile up until an operator consumes them. The cap is only so a
      // stream of garbage cannot grow the stack without limit.
      if (args.length < 4096) args.push(token);
      continue;
    }
    const op = token.op;
    switch (op) {
      // Path construction
      case 'm': moveTo(point(number(0), number(1))); break;
      case 'l':
        if (ensureSubpath()) { current = point(number(0), number(1)); subpath.segs.push({ type: 'l', to: current }); }
        else moveTo(point(number(0), number(1)));
        break;
      case 'c':
        if (ensureSubpath()) {
          const to = point(number(4), number(5));
          subpath.segs.push({ type: 'c', c1: point(number(0), number(1)), c2: point(number(2), number(3)), to });
          current = to;
        }
        break;
      case 'v':
        if (ensureSubpath()) {
          const to = point(number(2), number(3));
          subpath.segs.push({ type: 'c', c1: current, c2: point(number(0), number(1)), to });
          current = to;
        }
        break;
      case 'y':
        if (ensureSubpath()) {
          const to = point(number(2), number(3));
          subpath.segs.push({ type: 'c', c1: point(number(0), number(1)), c2: to, to });
          current = to;
        }
        break;
      case 'h': closeSubpath(); break;
      case 're': {
        const [x, y, w, h] = [number(0), number(1), number(2), number(3)];
        moveTo(point(x, y));
        subpath.segs.push({ type: 'l', to: point(x + w, y) }, { type: 'l', to: point(x + w, y + h) },
          { type: 'l', to: point(x, y + h) });
        closeSubpath();
        break;
      }

      // Path painting
      case 'S': stroke(); endPath(); break;
      case 's': closeSubpath(); stroke(); endPath(); break;
      case 'f': case 'F': fill(false); endPath(); break;
      case 'f*': fill(true); endPath(); break;
      case 'B': fill(false); stroke(); endPath(); break;
      case 'B*': fill(true); stroke(); endPath(); break;
      case 'b': closeSubpath(); fill(false); stroke(); endPath(); break;
      case 'b*': closeSubpath(); fill(true); stroke(); endPath(); break;
      case 'n': endPath(); break;
      case 'W': case 'W*': pendingClip = true; break;
      case 'sh': if (!run.hidden) plan.skipped.shadings++; break;

      // Graphics state
      case 'q': run.stack.push(gs); gs = { ...gs }; run.gs = gs; break;
      case 'Q':
        if (run.stack.length > run.floor) { gs = run.stack.pop(); run.gs = gs; }
        break;
      case 'cm':
        if (args.length >= 6) gs.ctm = pdfMatrixMultiply(args.slice(-6).map(value => (typeof value === 'number' ? value : 0)), gs.ctm);
        break;
      case 'w': gs.lineWidth = Math.abs(number(0)); break;
      case 'd': {
        const pattern = Array.isArray(args[0]) ? args[0].filter(value => typeof value === 'number' && value >= 0) : [];
        gs.dash = pattern;
        break;
      }
      case 'gs': {
        const state = pdfDictGet(doc, pdfDictGet(doc, resources, 'ExtGState'), args[0]);
        if (!(state instanceof Map)) break;
        const strokeAlpha = pdfDictGet(doc, state, 'CA');
        const fillAlpha = pdfDictGet(doc, state, 'ca');
        const width = pdfDictGet(doc, state, 'LW');
        const dash = pdfDictGet(doc, state, 'D');
        if (Number.isFinite(strokeAlpha)) gs.strokeAlpha = strokeAlpha;
        if (Number.isFinite(fillAlpha)) gs.fillAlpha = fillAlpha;
        if (Number.isFinite(width)) gs.lineWidth = Math.abs(width);
        if (Array.isArray(dash) && Array.isArray(pdfResolve(doc, dash[0]))) {
          gs.dash = pdfResolve(doc, dash[0]).map(value => pdfResolve(doc, value)).filter(value => typeof value === 'number' && value >= 0);
        }
        break;
      }

      // Colour
      case 'G': setColor(true, PDF_GRAY_SPACE, args); break;
      case 'g': setColor(false, PDF_GRAY_SPACE, args); break;
      case 'RG': setColor(true, PDF_RGB_SPACE, args); break;
      case 'rg': setColor(false, PDF_RGB_SPACE, args); break;
      case 'K': setColor(true, PDF_CMYK_SPACE, args); break;
      case 'k': setColor(false, PDF_CMYK_SPACE, args); break;
      case 'CS': {
        const space = pdfColorSpace(doc, resources, args[0]);
        gs.strokeSpace = space;
        gs.strokeColor = space.kind === 'pattern' || space.kind === 'none' ? null : [0, 0, 0];
        break;
      }
      case 'cs': {
        const space = pdfColorSpace(doc, resources, args[0]);
        gs.fillSpace = space;
        gs.fillColor = space.kind === 'pattern' || space.kind === 'none' ? null : [0, 0, 0];
        break;
      }
      case 'SC': case 'SCN': setColor(true, gs.strokeSpace, args); break;
      case 'sc': case 'scn': setColor(false, gs.fillSpace, args); break;

      // Text
      case 'BT': textMatrix = PDF_IDENTITY; lineMatrix = PDF_IDENTITY; break;
      case 'ET': break;
      case 'Tf': {
        const dict = pdfDictGet(doc, pdfDictGet(doc, resources, 'Font'), args[0]);
        if (dict instanceof Map) {
          if (!run.fonts.has(dict)) run.fonts.set(dict, pdfFontRecord(doc, dict));
          gs.font = run.fonts.get(dict);
        } else {
          gs.font = null;
        }
        gs.fontSize = number(1);
        break;
      }
      case 'Tc': gs.charSpace = number(0); break;
      case 'Tw': gs.wordSpace = number(0); break;
      case 'Tz': gs.hScale = number(0) / 100; break;
      case 'TL': gs.leading = number(0); break;
      case 'Ts': gs.rise = number(0); break;
      case 'Tr': gs.renderMode = number(0); break;
      case 'Td': nextLine(number(0), number(1)); break;
      case 'TD': gs.leading = -number(1); nextLine(number(0), number(1)); break;
      case 'Tm':
        if (args.length >= 6) {
          lineMatrix = args.slice(-6).map(value => (typeof value === 'number' ? value : 0));
          textMatrix = lineMatrix;
        }
        break;
      case 'T*': nextLine(0, -gs.leading); break;
      case 'Tj': showText([args[0]]); break;
      case 'TJ': if (Array.isArray(args[0])) showText(args[0]); break;
      case "'": nextLine(0, -gs.leading); showText([args[0]]); break;
      case '"':
        gs.wordSpace = number(0);
        gs.charSpace = number(1);
        nextLine(0, -gs.leading);
        showText([args[2]]);
        break;

      // XObjects and inline images
      case 'Do': if (typeof args[0] === 'string') drawObject(args[0]); break;
      case 'BI':
        pdfSkipInlineImage(cursor);
        if (!run.hidden) plan.skipped.inlineImages++;
        break;

      // Marked content, which is where optional-content layers attach
      case 'BMC': marked.push(false); break;
      case 'BDC': {
        let off = false;
        if (args[0] === 'OC') {
          const properties = pdfDictGet(doc, resources, 'Properties');
          const entry = typeof args[1] === 'string' && properties instanceof Map ? properties.get(args[1]) : args[1];
          off = pdfLayerHidden(doc, entry);
        }
        marked.push(off);
        if (off) run.hidden++;
        break;
      }
      case 'EMC':
        if (marked.length && marked.pop()) run.hidden--;
        break;

      default: break;
    }
    args.length = 0;
  }
  // A stream that ends with a layer still open must not leave the rest of the
  // page hidden.
  run.hidden = hiddenBefore;
}

// Returns the page as a plan: { page, ops, skipped, truncated }, or { error }.
export function readPdfPage(doc, pageIndex) {
  const page = doc.pages[pageIndex];
  if (!page) return { error: 'That page is not in the PDF.' };
  const geometry = pdfPageGeometry(doc, page);
  if (!geometry) return { error: 'That page has no usable size.' };
  const plan = {
    page: { widthMM: geometry.widthMM, heightMM: geometry.heightMM },
    ops: [],
    skipped: { text: 0, patterns: 0, shadings: 0, inlineImages: 0 },
    truncated: false,
  };
  const gs = {
    ctm: geometry.matrix,
    // Nothing outside the page is ever shown, so the page is the first clip.
    clip: { minX: 0, minY: 0, maxX: geometry.widthMM, maxY: geometry.heightMM },
    strokeColor: [0, 0, 0],
    fillColor: [0, 0, 0],
    strokeSpace: PDF_GRAY_SPACE,
    fillSpace: PDF_GRAY_SPACE,
    strokeAlpha: 1,
    fillAlpha: 1,
    lineWidth: 1,
    dash: [],
    font: null,
    fontSize: 0,
    charSpace: 0,
    wordSpace: 0,
    hScale: 1,
    leading: 0,
    rise: 0,
    renderMode: 0,
  };
  const run = { doc, plan, gs, stack: [], floor: 0, hidden: 0, segments: 0, fonts: new Map(), forms: new Map() };
  let bytes;
  try {
    bytes = pdfContentBytes(doc, page.dict.get('Contents'));
  } catch {
    return { error: 'That page could not be decompressed.' };
  }
  if (bytes && bytes.length) runPdfContent(run, bytes, pdfResolve(doc, page.Resources), 0);
  plan.truncated = run.segments > PDF_MAX_SEGMENTS;
  return plan;
}

// The still-encoded bytes of an image the page placed, as a data URL, when
// they are something a browser can decode as they stand. That is JPEG only:
// every other image filter in PDF stores bare samples with no file around
// them.
export function pdfImageDataUrl(doc, op) {
  if (!op || !isPdfStream(op.source) || op.mask) return null;
  let data;
  try { data = pdfStreamData(doc, op.source); } catch { return null; }
  if (data.remaining.length !== 1 || data.remaining[0] !== 'DCTDecode') return null;
  const bytes = data.bytes;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const parts = [];
  let chunk = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : -1;
    const c = index + 2 < bytes.length ? bytes[index + 2] : -1;
    chunk += alphabet[a >> 2] + alphabet[((a & 3) << 4) | (b < 0 ? 0 : b >> 4)]
      + (b < 0 ? '=' : alphabet[((b & 15) << 2) | (c < 0 ? 0 : c >> 6)])
      + (c < 0 ? '=' : alphabet[c & 63]);
    if (chunk.length > 16384) { parts.push(chunk); chunk = ''; }
  }
  parts.push(chunk);
  return `data:image/jpeg;base64,${parts.join('')}`;
}
