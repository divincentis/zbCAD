import { TAU } from '../core/constants.js';
import { DXF_DEFAULT_LINETYPE, DXF_STYLE_NAME } from '../output/dxfPlan.js';

// ---------------------------------------------------------------------------
// The DXF reader
//
// Parses ASCII DXF into the same plan shape output/dxfPlan.js builds, which is
// what makes a state -> plan -> text -> plan -> state round trip assertable in
// one test. Pure: text in, plan out, no state touched.
//
// The format is a flat stream of (code, value) line pairs, so the parser is a
// cursor over that stream plus a per-entity accumulator. It is deliberately
// tolerant — real files come from a dozen different writers across thirty years
// of the format, and the ones that matter here differ in what they OMIT rather
// than in what they get wrong. Anything unrecognised is counted and reported,
// never guessed at.
// ---------------------------------------------------------------------------

export const DXF_BINARY_SENTINEL = 'AutoCAD Binary DXF';

export function parseDxfPairs(text) {
  // Files arrive with CRLF, LF, or (rarely) CR line endings.
  const lines = String(text).split(/\r\n|\r|\n/);
  const pairs = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = Number(lines[index].trim());
    if (!Number.isFinite(code)) return { error: `Line ${index + 1} is not a DXF group code.` };
    pairs.push([code, lines[index + 1]]);
  }
  return { pairs };
}

// Group codes below 10 and a few others are strings; the numeric ranges are
// well defined by the format.
function isNumericCode(code) {
  return (code >= 10 && code <= 59)
    || (code >= 60 && code <= 79)
    || (code >= 90 && code <= 99)
    || (code >= 140 && code <= 179)
    || (code >= 210 && code <= 239)
    || (code >= 270 && code <= 299)
    || (code >= 370 && code <= 389)
    || (code >= 400 && code <= 409)
    || code === 420 || code === 1070 || code === 1071;
}

function codeValue(code, raw) {
  if (!isNumericCode(code)) return raw;
  const value = Number(String(raw).trim());
  return Number.isFinite(value) ? value : 0;
}

// One record: the 0/<type> that opened it plus every pair until the next 0.
// Repeated codes are kept in order, because a LWPOLYLINE's vertices are
// nothing but repeated 10/20/42.
function readRecords(pairs, from) {
  const records = [];
  let index = from;
  while (index < pairs.length) {
    const [code, raw] = pairs[index];
    if (code === 0 && (raw === 'ENDSEC' || raw === 'EOF')) break;
    if (code !== 0) { index++; continue; }
    const record = { type: raw, pairs: [] };
    index++;
    while (index < pairs.length && pairs[index][0] !== 0) {
      const [innerCode, innerRaw] = pairs[index];
      record.pairs.push([innerCode, codeValue(innerCode, innerRaw)]);
      index++;
    }
    records.push(record);
  }
  return { records, index };
}

function first(record, code, fallback = undefined) {
  const found = record.pairs.find(pair => pair[0] === code);
  return found ? found[1] : fallback;
}

function all(record, code) {
  return record.pairs.filter(pair => pair[0] === code).map(pair => pair[1]);
}

function point(record, baseCode) {
  return {
    x: Number(first(record, baseCode, 0)) || 0,
    y: Number(first(record, baseCode + 10, 0)) || 0,
  };
}

function radians(degrees) {
  return (Number(degrees) || 0) * TAU / 360;
}

function sectionBounds(pairs, name) {
  for (let index = 0; index + 1 < pairs.length; index++) {
    if (pairs[index][0] === 0 && pairs[index][1] === 'SECTION'
      && pairs[index + 1][0] === 2 && pairs[index + 1][1] === name) {
      return index + 2;
    }
  }
  return -1;
}

export function readDxfHeader(pairs) {
  const start = sectionBounds(pairs, 'HEADER');
  const header = { insunits: 0, lunits: 2, luprec: 4, auprec: 1 };
  if (start < 0) return header;
  for (let index = start; index < pairs.length; index++) {
    const [code, raw] = pairs[index];
    if (code === 0 && (raw === 'ENDSEC' || raw === 'EOF')) break;
    if (code !== 9) continue;
    const next = pairs[index + 1];
    if (!next) break;
    const value = Number(String(next[1]).trim());
    if (raw === '$INSUNITS') header.insunits = value;
    else if (raw === '$LUNITS') header.lunits = value;
    else if (raw === '$LUPREC') header.luprec = value;
    else if (raw === '$AUPREC') header.auprec = value;
  }
  return header;
}

export function readDxfTables(pairs) {
  const layers = [];
  const linetypes = [];
  const styles = [];
  const dimStyles = [];
  const start = sectionBounds(pairs, 'TABLES');
  if (start < 0) return { layers, linetypes, styles, dimStyles };

  let index = start;
  while (index < pairs.length) {
    const [code, raw] = pairs[index];
    if (code === 0 && (raw === 'ENDSEC' || raw === 'EOF')) break;
    if (code === 0 && raw === 'TABLE') {
      const tableName = pairs[index + 1] && pairs[index + 1][0] === 2 ? pairs[index + 1][1] : '';
      const { records, index: next } = readTableRecords(pairs, index + 2, tableName);
      if (tableName === 'LAYER') layers.push(...records);
      else if (tableName === 'LTYPE') linetypes.push(...records);
      else if (tableName === 'STYLE') styles.push(...records);
      else if (tableName === 'DIMSTYLE') dimStyles.push(...records);
      index = next;
      continue;
    }
    index++;
  }
  return { layers, linetypes, styles, dimStyles };
}

function readTableRecords(pairs, from, tableName) {
  const records = [];
  let index = from;
  while (index < pairs.length) {
    const [code, raw] = pairs[index];
    if (code === 0 && (raw === 'ENDTAB' || raw === 'ENDSEC' || raw === 'EOF')) {
      return { records, index: index + 1 };
    }
    if (code === 0 && raw === tableName) {
      const record = { type: raw, pairs: [] };
      index++;
      while (index < pairs.length && pairs[index][0] !== 0) {
        record.pairs.push([pairs[index][0], codeValue(pairs[index][0], pairs[index][1])]);
        index++;
      }
      records.push(readTableRecord(record, tableName));
      continue;
    }
    index++;
  }
  return { records, index };
}

function readTableRecord(record, tableName) {
  if (tableName === 'LAYER') {
    const colorIndex = Number(first(record, 62, 7));
    return {
      name: String(first(record, 2, '0')),
      aci: Math.abs(colorIndex),
      trueColor: record.pairs.some(pair => pair[0] === 420) ? Number(first(record, 420)) : null,
      // DXF says "layer off" with a negative colour index.
      off: colorIndex < 0,
      linetype: String(first(record, 6, DXF_DEFAULT_LINETYPE)),
      lineweight: Number(first(record, 370, -1)),
      plot: Number(first(record, 290, 1)) !== 0,
      locked: (Number(first(record, 70, 0)) & 4) !== 0,
    };
  }
  if (tableName === 'LTYPE') {
    return {
      name: String(first(record, 2, DXF_DEFAULT_LINETYPE)),
      description: String(first(record, 3, '')),
      pattern: all(record, 49).map(Number),
    };
  }
  if (tableName === 'STYLE') {
    return {
      name: String(first(record, 2, DXF_STYLE_NAME)),
      font: String(first(record, 3, '')),
      widthFactor: Number(first(record, 41, 1)) || 1,
    };
  }
  return {
    name: String(first(record, 2, 'Standard')),
    scale: Number(first(record, 40, 1)) || 1,
    arrowSize: Number(first(record, 41, 0.18)) || 0.18,
    extensionOffset: Number(first(record, 42, 0.0625)),
    extensionBeyond: Number(first(record, 44, 0.18)),
    textHeight: Number(first(record, 140, 0.18)) || 0.18,
    textGap: Number(first(record, 147, 0.09)),
    tick: Number(first(record, 173, 0)) === 1 || Number(first(record, 142, 0)) > 0,
  };
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export function readDxfEntityRecord(record) {
  const layer = String(first(record, 8, '0'));
  const type = record.type;

  if (type === 'LINE') {
    return { type: 'LINE', layer, a: point(record, 10), b: point(record, 11) };
  }
  if (type === 'CIRCLE') {
    return { type: 'CIRCLE', layer, center: point(record, 10), radius: Number(first(record, 40, 0)) };
  }
  if (type === 'ARC') {
    return {
      type: 'ARC', layer,
      center: point(record, 10),
      radius: Number(first(record, 40, 0)),
      startAngle: radians(first(record, 50, 0)),
      endAngle: radians(first(record, 51, 0)),
    };
  }
  if (type === 'LWPOLYLINE') {
    // Vertices are interleaved repeats of 10/20 with an optional 42 between
    // them, so they have to be walked in order rather than gathered by code.
    const points = [];
    let current = null;
    for (const [code, value] of record.pairs) {
      if (code === 10) {
        if (current) points.push(current);
        current = { x: Number(value) || 0, y: 0, bulge: 0 };
      } else if (code === 20 && current) {
        current.y = Number(value) || 0;
      } else if (code === 42 && current) {
        current.bulge = Number(value) || 0;
      }
    }
    if (current) points.push(current);
    return { type: 'LWPOLYLINE', layer, points, closed: (Number(first(record, 70, 0)) & 1) === 1 };
  }
  if (type === 'POINT') {
    return { type: 'POINT', layer, position: point(record, 10) };
  }
  if (type === 'TEXT') {
    const halign = Number(first(record, 72, 0));
    const valign = Number(first(record, 73, 0));
    // With any justification but left/baseline the real position is the second
    // alignment point; a writer that sets one usually sets both to the same
    // place, but the spec says 11 wins.
    const anchored = halign !== 0 || valign !== 0;
    return {
      type: 'TEXT', layer,
      style: String(first(record, 7, DXF_STYLE_NAME)),
      position: anchored ? point(record, 11) : point(record, 10),
      height: Number(first(record, 40, 1)) || 1,
      rotation: radians(first(record, 50, 0)),
      text: String(first(record, 1, '')),
      halign, valign,
    };
  }
  if (type === 'MTEXT') {
    // Long MTEXT is split across repeated 3 chunks with the tail in 1.
    const chunks = all(record, 3).map(String).join('');
    return {
      type: 'MTEXT', layer,
      style: String(first(record, 7, DXF_STYLE_NAME)),
      position: point(record, 10),
      height: Number(first(record, 40, 1)) || 1,
      width: Number(first(record, 41, 0)) || 0,
      rotation: radians(first(record, 50, 0)),
      text: `${chunks}${String(first(record, 1, ''))}`,
      attachment: Number(first(record, 71, 1)),
      lineSpacing: Number(first(record, 44, 1)) || 1,
    };
  }
  if (type === 'SOLID' || type === 'TRACE') {
    return {
      type: 'SOLID', layer,
      points: [point(record, 10), point(record, 11), point(record, 12), point(record, 13)],
    };
  }
  if (type === 'ELLIPSE') {
    return {
      type: 'ELLIPSE', layer,
      center: point(record, 10),
      majorAxis: point(record, 11),
      ratio: Number(first(record, 40, 1)) || 1,
      startParam: Number(first(record, 41, 0)),
      endParam: Number(first(record, 42, TAU)),
    };
  }
  if (type === 'SPLINE') {
    const xs = all(record, 10).map(Number);
    const ys = all(record, 20).map(Number);
    const fitX = all(record, 11).map(Number);
    const fitY = all(record, 21).map(Number);
    return {
      type: 'SPLINE', layer,
      flags: Number(first(record, 70, 0)),
      degree: Number(first(record, 71, 3)),
      controlPoints: xs.map((x, index) => ({ x, y: ys[index] ?? 0 })),
      fitPoints: fitX.map((x, index) => ({ x, y: fitY[index] ?? 0 })),
      knots: all(record, 40).map(Number),
    };
  }
  if (type === 'INSERT') {
    return {
      type: 'INSERT', layer,
      name: String(first(record, 2, '')),
      insert: point(record, 10),
      scaleX: Number(first(record, 41, 1)) || 1,
      scaleY: Number(first(record, 42, 1)) || 1,
      rotation: radians(first(record, 50, 0)),
      columns: Number(first(record, 70, 1)) || 1,
      rows: Number(first(record, 71, 1)) || 1,
      columnSpacing: Number(first(record, 44, 0)),
      rowSpacing: Number(first(record, 45, 0)),
    };
  }
  if (type === 'DIMENSION') {
    const flags = Number(first(record, 70, 0));
    return {
      type: 'DIMENSION', layer,
      block: String(first(record, 2, '')),
      styleName: String(first(record, 3, 'Standard')),
      flags,
      kind: flags & 7,
      defPoint: point(record, 10),
      textMid: point(record, 11),
      ext1: point(record, 13),
      ext2: point(record, 14),
      chordPoint: point(record, 15),
      rotation: radians(first(record, 50, 0)),
      measurement: Number(first(record, 42, 0)),
      textOverride: String(first(record, 1, '')),
    };
  }
  return { type: 'UNSUPPORTED', layer, dxfType: type };
}

// The old pre-LWPOLYLINE form: a POLYLINE record, a run of VERTEX records, then
// a SEQEND. R12 files and plenty of modern exporters still use it.
function collapseLegacyPolylines(records) {
  const out = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.type !== 'POLYLINE') { out.push(record); continue; }
    const flags = Number(first(record, 70, 0));
    const layer = String(first(record, 8, '0'));
    const points = [];
    index++;
    while (index < records.length && records[index].type === 'VERTEX') {
      const vertex = records[index];
      points.push({
        x: Number(first(vertex, 10, 0)) || 0,
        y: Number(first(vertex, 20, 0)) || 0,
        bulge: Number(first(vertex, 42, 0)) || 0,
      });
      index++;
    }
    if (index < records.length && records[index].type === 'SEQEND') {
      // consumed
    } else {
      index--;
    }
    out.push({
      type: '__LWPOLYLINE__',
      parsed: { type: 'LWPOLYLINE', layer, points, closed: (flags & 1) === 1 },
    });
  }
  return out;
}

export function readDxfEntities(pairs, sectionName = 'ENTITIES') {
  const start = sectionBounds(pairs, sectionName);
  if (start < 0) return [];
  const { records } = readRecords(pairs, start);
  return collapseLegacyPolylines(records)
    .map(record => (record.type === '__LWPOLYLINE__' ? record.parsed : readDxfEntityRecord(record)));
}

export function readDxfBlocks(pairs) {
  const start = sectionBounds(pairs, 'BLOCKS');
  const blocks = [];
  if (start < 0) return blocks;
  const { records } = readRecords(pairs, start);
  const collapsed = collapseLegacyPolylines(records);

  let current = null;
  for (const record of collapsed) {
    if (record.type === 'BLOCK') {
      current = {
        name: String(first(record, 2, '')),
        base: point(record, 10),
        entities: [],
      };
      continue;
    }
    if (record.type === 'ENDBLK') {
      if (current) blocks.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    current.entities.push(record.type === '__LWPOLYLINE__' ? record.parsed : readDxfEntityRecord(record));
  }
  if (current) blocks.push(current);
  return blocks;
}

export function parseDxfText(text) {
  const source = String(text ?? '');
  if (!source.trim()) return { error: 'That DXF file is empty.' };
  if (source.startsWith(DXF_BINARY_SENTINEL)) {
    return { error: 'That is a binary DXF. Re-save it as ASCII DXF and try again.' };
  }
  // A DXF must begin with a group code; anything else is a different format
  // wearing a .dxf extension, and saying so beats a parse error fifty lines in.
  if (!/^\s*\d+\s*(\r\n|\r|\n)/.test(source)) {
    return { error: 'That file is not a DXF drawing.' };
  }

  const parsed = parseDxfPairs(source);
  if (parsed.error) return { error: parsed.error };
  const { pairs } = parsed;
  if (!pairs.some(pair => pair[0] === 0 && pair[1] === 'SECTION')) {
    return { error: 'That DXF file has no sections.' };
  }

  const tables = readDxfTables(pairs);
  return {
    plan: {
      header: readDxfHeader(pairs),
      layers: tables.layers,
      linetypes: tables.linetypes,
      styles: tables.styles,
      dimStyles: tables.dimStyles,
      blocks: readDxfBlocks(pairs),
      entities: readDxfEntities(pairs),
      warnings: [],
    },
  };
}
