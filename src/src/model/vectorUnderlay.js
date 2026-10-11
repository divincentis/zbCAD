// ---------------------------------------------------------------------------
// Vector underlays
//
// A PDF page placed as an underlay is line work, not a picture, and it is kept
// as line work: it stays sharp at any zoom, which a raster capped at
// UNDERLAY_MAX_EDGE_PX could never be for a full-size sheet.
//
// It is still an underlay in every other respect — the same record in
// state.underlays, with the same origin, rotation, scale, fade and lock — and
// only the payload differs. Where an image underlay's `data` is a JPEG data
// URL, a vector underlay's is the page as one compact string. Keeping it a
// string is deliberate: the record is copied into every undo snapshot, and a
// string is shared by reference where an array of paths would have to be
// cloned or trusted never to be mutated.
//
// The string is a list of records separated by ';', in paint order:
//
//   S<rrggbb>,<width>,<dash ...>|<path>        a stroke
//   F<rrggbb>,<n|e>|<path>                     a fill, non-zero or even-odd
//   T<rrggbb>,<x>,<y>,<angle>,<size>,<width>,<h|c>|<text>
//
// Every length is a whole number of micrometres on the page, measured from its
// bottom-left corner with Y up, and one micrometre is the "pixel" the record's
// widthPx, heightPx and unitsPerPixel are counted in. A path is SVG path data
// restricted to M (absolute), l and c (relative) and z, so a subpath costs its
// start once and each segment after that only the distance it moves.
// ---------------------------------------------------------------------------

export const VECTOR_UNDERLAY_PREFIX = 'zbv1;';
export const VECTOR_UNITS_PER_MM = 1000;

export function isVectorUnderlayData(data) {
  return typeof data === 'string' && data.startsWith(VECTOR_UNDERLAY_PREFIX);
}

function vectorHexColor(color) {
  let hex = '';
  for (let channel = 0; channel < 3; channel++) {
    const level = Math.round(Math.min(1, Math.max(0, color[channel] || 0)) * 255);
    hex += level.toString(16).padStart(2, '0');
  }
  return hex;
}

// A separator is only needed before a number that does not announce itself
// with a minus sign, which on a real drawing is about half of them.
function vectorJoin(out, value) {
  return value < 0 || !out || out.endsWith('M') || out.endsWith('l') || out.endsWith('c')
    ? out + value
    : `${out} ${value}`;
}

function vectorPath(subpaths) {
  let out = '';
  for (const subpath of subpaths) {
    // Positions are rounded as absolutes and written as differences of the
    // rounded values, so rounding error never accumulates along a path.
    let x = Math.round(subpath.start.x * VECTOR_UNITS_PER_MM);
    let y = Math.round(subpath.start.y * VECTOR_UNITS_PER_MM);
    out += `M${x} ${y}`;
    let command = '';
    for (const segment of subpath.segs) {
      const toX = Math.round(segment.to.x * VECTOR_UNITS_PER_MM);
      const toY = Math.round(segment.to.y * VECTOR_UNITS_PER_MM);
      if (segment.type === 'c') {
        if (command !== 'c') { out += 'c'; command = 'c'; }
        out = vectorJoin(out, Math.round(segment.c1.x * VECTOR_UNITS_PER_MM) - x);
        out = vectorJoin(out, Math.round(segment.c1.y * VECTOR_UNITS_PER_MM) - y);
        out = vectorJoin(out, Math.round(segment.c2.x * VECTOR_UNITS_PER_MM) - x);
        out = vectorJoin(out, Math.round(segment.c2.y * VECTOR_UNITS_PER_MM) - y);
      } else if (command !== 'l') {
        out += 'l';
        command = 'l';
      }
      out = vectorJoin(out, toX - x);
      out = vectorJoin(out, toY - y);
      x = toX;
      y = toY;
    }
    if (subpath.closed) out += 'z';
  }
  return out;
}

// A page plan (model/pdfPage.js, or anything else in output/plot.js's shape)
// to the fields of an underlay descriptor. Images in the plan are not carried:
// a vector underlay is line work only, and the caller is told how many were
// left behind.
export function encodeVectorUnderlay(plan) {
  const records = [];
  const counts = { strokes: 0, fills: 0, texts: 0, images: 0 };
  for (const op of plan.ops) {
    if (op.kind === 'stroke') {
      const path = vectorPath(op.subpaths);
      if (!path) continue;
      const width = Math.max(0, Math.round(op.widthMM * VECTOR_UNITS_PER_MM));
      const dash = (op.dash || []).map(value => Math.max(0, Math.round(value * VECTOR_UNITS_PER_MM)));
      // A pattern that rounds to nothing would draw as nothing; solid is the
      // honest reading of a dash too fine to resolve.
      records.push(`S${vectorHexColor(op.color)},${width},${dash.some(value => value > 0) ? dash.join(' ') : ''}|${path}`);
      counts.strokes++;
    } else if (op.kind === 'fill') {
      const subpaths = op.subpaths
        || [{ start: op.points[0], segs: op.points.slice(1).map(to => ({ type: 'l', to })), closed: true }];
      const path = vectorPath(subpaths.map(subpath => ({ ...subpath, closed: true })));
      if (!path) continue;
      records.push(`F${vectorHexColor(op.color)},${op.evenOdd ? 'e' : 'n'}|${path}`);
      counts.fills++;
    } else if (op.kind === 'text') {
      if (!op.text) continue;
      const fields = [
        Math.round(op.x * VECTOR_UNITS_PER_MM),
        Math.round(op.y * VECTOR_UNITS_PER_MM),
        Math.round((op.angle * 180 / Math.PI) * 1000),
        Math.round(op.sizeMM * VECTOR_UNITS_PER_MM),
        Math.round((op.widthMM || 0) * VECTOR_UNITS_PER_MM),
        op.font === 'courier' ? 'c' : 'h',
      ];
      // Percent-encoded so that no character of the text can be mistaken for a
      // separator, whatever the page happened to say.
      records.push(`T${vectorHexColor(op.color)},${fields.join(',')}|${encodeURIComponent(op.text)}`);
      counts.texts++;
    } else if (op.kind === 'image') {
      counts.images++;
    }
  }
  return {
    widthPx: Math.max(1, Math.round(plan.page.widthMM * VECTOR_UNITS_PER_MM)),
    heightPx: Math.max(1, Math.round(plan.page.heightMM * VECTOR_UNITS_PER_MM)),
    data: VECTOR_UNDERLAY_PREFIX + records.join(';'),
    counts,
  };
}

function vectorColor(hex) {
  const value = parseInt(hex, 16);
  if (!Number.isFinite(value)) return [0, 0, 0];
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

// Calls `visit` once per record, in paint order, with the record's style and,
// for strokes and fills, its path still as a string. Nothing is expanded into
// points here: a caller that wants geometry replays the path onto a sink with
// traceVectorPath, and one that only wants a count never pays for it.
export function eachVectorRecord(data, visit) {
  if (!isVectorUnderlayData(data)) return;
  const body = data.slice(VECTOR_UNDERLAY_PREFIX.length);
  if (!body) return;
  for (const record of body.split(';')) {
    const bar = record.indexOf('|');
    if (bar < 0) continue;
    const kind = record[0];
    const fields = record.slice(1, bar).split(',');
    const payload = record.slice(bar + 1);
    if (kind === 'S') {
      visit({
        kind: 'stroke',
        color: vectorColor(fields[0]),
        width: Number(fields[1]) || 0,
        dash: fields[2] ? fields[2].split(' ').map(Number).filter(Number.isFinite) : [],
        path: payload,
      });
    } else if (kind === 'F') {
      visit({ kind: 'fill', color: vectorColor(fields[0]), evenOdd: fields[1] === 'e', path: payload });
    } else if (kind === 'T') {
      let text;
      try { text = decodeURIComponent(payload); } catch { continue; }
      visit({
        kind: 'text',
        color: vectorColor(fields[0]),
        x: Number(fields[1]) || 0,
        y: Number(fields[2]) || 0,
        angle: ((Number(fields[3]) || 0) / 1000) * Math.PI / 180,
        size: Number(fields[4]) || 0,
        width: Number(fields[5]) || 0,
        font: fields[6] === 'c' ? 'courier' : 'helvetica',
        text,
      });
    }
  }
}

// Replays a path onto anything with the canvas path methods — a Path2D, a
// 2D context, or an object that just collects points. Coordinates are handed
// over in micrometres, absolute.
export function traceVectorPath(path, sink) {
  const length = path.length;
  const numbers = [0, 0, 0, 0, 0, 0];
  let index = 0;
  let command = 0;
  let have = 0;
  let x = 0;
  let y = 0;
  while (index < length) {
    let code = path.charCodeAt(index);
    if (code === 77 || code === 108 || code === 99) { command = code; have = 0; index++; continue; }
    if (code === 122) { sink.closePath(); index++; continue; }
    const negative = code === 45;
    if (negative) code = path.charCodeAt(++index);
    if (!(code >= 48 && code <= 57)) { index++; continue; }
    let value = 0;
    while (code >= 48 && code <= 57) {
      value = value * 10 + (code - 48);
      code = path.charCodeAt(++index);
    }
    numbers[have++] = negative ? -value : value;
    if (command === 99) {
      if (have < 6) continue;
      sink.bezierCurveTo(x + numbers[0], y + numbers[1], x + numbers[2], y + numbers[3], x + numbers[4], y + numbers[5]);
      x += numbers[4];
      y += numbers[5];
    } else {
      if (have < 2) continue;
      if (command === 77) { x = numbers[0]; y = numbers[1]; sink.moveTo(x, y); }
      else { x += numbers[0]; y += numbers[1]; sink.lineTo(x, y); }
    }
    have = 0;
  }
}

// The stored page back as plan ops, each coordinate passed through `place`
// (micrometres on the page in, whatever the caller draws in out) and each
// length multiplied by `scale`. This is the form output/plot.js wants; the
// screen never builds it.
export function vectorUnderlayOps(data, place, scale) {
  const ops = [];
  eachVectorRecord(data, record => {
    if (record.kind === 'text') {
      const at = place(record.x, record.y);
      ops.push({
        kind: 'text', text: record.text, x: at.x, y: at.y, angle: record.angle,
        sizeMM: record.size * scale, widthMM: record.width * scale,
        font: record.font, anchor: 'left', baseline: 'alphabetic', color: record.color,
      });
      return;
    }
    const subpaths = [];
    let subpath = null;
    traceVectorPath(record.path, {
      moveTo(x, y) { subpath = { start: place(x, y), segs: [], closed: false }; subpaths.push(subpath); },
      lineTo(x, y) { subpath.segs.push({ type: 'l', to: place(x, y) }); },
      bezierCurveTo(x1, y1, x2, y2, x, y) {
        subpath.segs.push({ type: 'c', c1: place(x1, y1), c2: place(x2, y2), to: place(x, y) });
      },
      closePath() { if (subpath) subpath.closed = true; },
    });
    if (!subpaths.length) return;
    if (record.kind === 'stroke') {
      ops.push({
        kind: 'stroke', widthMM: record.width * scale,
        dash: record.dash.map(value => value * scale), color: record.color, subpaths,
      });
    } else {
      ops.push({ kind: 'fill', color: record.color, evenOdd: record.evenOdd, subpaths });
    }
  });
  return ops;
}
