import { TAU } from '../core/constants.js';

// ---------------------------------------------------------------------------
// The DXF writer
//
// Turns a DXF plan (output/dxfPlan.js) into AutoCAD R2000 / AC1015 ASCII. Pure
// and deterministic, exactly like output/pdf.js: a plan in, a string out, no
// DOM, no clock, no state. That is what lets the test suite assert on the file
// itself rather than on a re-parse of it.
//
// A DXF is a flat stream of (group code, value) pairs, each on its own line.
// Structure comes entirely from convention: sections open with 0/SECTION and a
// 2/<name>, tables with 0/TABLE, and everything closes with 0/ENDSEC or
// 0/ENDTAB. R2000 additionally requires every record to carry a unique
// hexadecimal handle (code 5) and to name its owner (code 330), which is what
// most of the bookkeeping below is for.
// ---------------------------------------------------------------------------

export const DXF_ACAD_VERSION = 'AC1015';

// Colour. zbCAD stores RGB hex and has no colour index, so export writes both:
// code 62 as the nearest indexed colour for readers that only understand the
// old palette, and code 420 as the exact 24-bit value for those that do. On the
// way back in, 420 wins whenever it is present, so a zbCAD -> DXF -> zbCAD trip
// is colour-exact and only a trip through indexed-only software loses anything.
export const ACI_BASIC = [
  [0, '#000000'], [1, '#ff0000'], [2, '#ffff00'], [3, '#00ff00'],
  [4, '#00ffff'], [5, '#0000ff'], [6, '#ff00ff'], [7, '#ffffff'],
  [8, '#414141'], [9, '#808080'],
  [250, '#333333'], [251, '#505050'], [252, '#696969'],
  [253, '#828282'], [254, '#bebebe'], [255, '#ffffff'],
];

export function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!match) return [0, 0, 0];
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function rgbToTrueColor(hex) {
  const [r, g, b] = hexToRgb(hex);
  return (r << 16) | (g << 8) | b;
}

// Nearest of the indexed colours this writer knows by name. Indices 10-249 are
// a generated hue ramp whose exact values vary between implementations, so only
// the fixed ends of the palette are matched against — an approximate 62 beside
// an exact 420 is honest, and a wrong "precise" index would not be.
export function nearestAci(hex) {
  const [r, g, b] = hexToRgb(hex);
  let best = 7;
  let bestDistance = Infinity;
  for (const [index, candidate] of ACI_BASIC) {
    if (index === 0) continue;
    const [cr, cg, cb] = hexToRgb(candidate);
    const distance = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (distance < bestDistance) { bestDistance = distance; best = index; }
  }
  return best;
}

export function aciToHex(index) {
  const found = ACI_BASIC.find(([value]) => value === Number(index));
  if (found) return found[1];
  const numeric = Number(index);
  if (!Number.isFinite(numeric) || numeric < 10 || numeric > 249) return '#ffffff';
  // The generated part of the palette: 24 hues, ten steps each, alternating a
  // saturated and a washed-out variant down five brightness levels. This
  // reconstruction is close to AutoCAD's table but not bit-exact, which is why
  // export always writes a true colour alongside the index.
  const hue = Math.floor((numeric - 10) / 10) * 15;
  const step = (numeric - 10) % 10;
  const value = [255, 255, 189, 189, 129, 129, 104, 104, 79, 79][step] / 255;
  const saturation = step % 2 === 0 ? 1 : 0.5;
  return hslLikeToHex(hue, saturation, value);
}

function hslLikeToHex(hueDegrees, saturation, value) {
  const h = ((hueDegrees % 360) + 360) % 360 / 60;
  const c = value * saturation;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = value - c;
  const table = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]];
  const [r, g, b] = table[Math.floor(h) % 6];
  const byte = channel => Math.round((channel + m) * 255).toString(16).padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

// DXF numbers. The shortest decimal that reads back as the very same double,
// which is what JavaScript's own number-to-string already gives — a fixed
// number of decimal places would quietly round every coordinate and, worse,
// every polyline bulge, where the lost digits are angular error rather than
// sub-micron position. Exponent notation is avoided because some older readers
// mishandle it, and values below a nanometre-ish threshold are written as zero
// rather than as 1.2e-15.
export function dxfNumber(value) {
  if (!Number.isFinite(value)) return '0.0';
  if (Math.abs(value) < 1e-12) return '0.0';
  let text = String(value);
  if (text.includes('e') || text.includes('E')) {
    text = value.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  }
  // A DXF real should look like one, so an integer value still gets a point.
  if (!text.includes('.')) text += '.0';
  return text === '-0.0' ? '0.0' : text;
}

export function degrees(radians) {
  const value = (radians * 360) / TAU;
  // Angles are written in [0, 360) so a reader never has to normalise.
  const wrapped = ((value % 360) + 360) % 360;
  return dxfNumber(wrapped);
}

// A DXF string cannot carry a raw newline, and ^ is the control-code escape.
export function dxfEscape(text) {
  return String(text == null ? '' : text).replace(/\r?\n/g, '\\P');
}

// Handles are hex, start above the reserved low values, and must be unique
// across the whole file. A counter is enough because nothing here references a
// handle it has not already allocated.
export function createHandleSource(start = 0x100) {
  let next = start;
  return () => (next++).toString(16).toUpperCase();
}

class DxfWriter {
  constructor() {
    this.lines = [];
  }

  pair(code, value) {
    this.lines.push(String(code));
    this.lines.push(String(value));
    return this;
  }

  point(baseCode, point, z = 0) {
    this.pair(baseCode, dxfNumber(point.x));
    this.pair(baseCode + 10, dxfNumber(point.y));
    this.pair(baseCode + 20, dxfNumber(z));
    return this;
  }

  toString() {
    // DXF is conventionally CRLF, and every reader accepts it.
    return `${this.lines.join('\r\n')}\r\n`;
  }
}

function writeHeaderVariable(writer, name, code, value) {
  writer.pair(9, name).pair(code, value);
}

function writeHeader(writer, plan) {
  writer.pair(0, 'SECTION').pair(2, 'HEADER');
  writeHeaderVariable(writer, '$ACADVER', 1, DXF_ACAD_VERSION);
  writeHeaderVariable(writer, '$HANDSEED', 5, 'FFFF');
  writeHeaderVariable(writer, '$INSUNITS', 70, plan.header.insunits);
  writeHeaderVariable(writer, '$LUNITS', 70, plan.header.lunits);
  writeHeaderVariable(writer, '$LUPREC', 70, plan.header.luprec);
  writeHeaderVariable(writer, '$AUNITS', 70, 0);
  writeHeaderVariable(writer, '$AUPREC', 70, plan.header.auprec);
  writer.pair(9, '$EXTMIN');
  writer.point(10, plan.header.extMin);
  writer.pair(9, '$EXTMAX');
  writer.point(10, plan.header.extMax);
  writeHeaderVariable(writer, '$MEASUREMENT', 70, plan.header.insunits === 1 || plan.header.insunits === 2 ? 0 : 1);
  writer.pair(0, 'ENDSEC');
}

function writeTableHead(writer, name, handle, count, ownerHandle) {
  writer.pair(0, 'TABLE').pair(2, name).pair(5, handle).pair(330, ownerHandle)
    .pair(100, 'AcDbSymbolTable').pair(70, count);
  // DIMSTYLE is the one table with a subclass of its own and a second count.
  if (name === 'DIMSTYLE') writer.pair(100, 'AcDbDimStyleTable').pair(71, count);
}

function writeTables(writer, plan, handles, context) {
  writer.pair(0, 'SECTION').pair(2, 'TABLES');

  // VPORT — a reader wants at least *Active to know how to show the drawing.
  writeTableHead(writer, 'VPORT', handles(), 1, '0');
  writer.pair(0, 'VPORT').pair(5, handles()).pair(330, '0')
    .pair(100, 'AcDbSymbolTableRecord').pair(100, 'AcDbViewportTableRecord')
    .pair(2, '*Active').pair(70, 0);
  writer.pair(12, dxfNumber((plan.header.extMin.x + plan.header.extMax.x) / 2));
  writer.pair(22, dxfNumber((plan.header.extMin.y + plan.header.extMax.y) / 2));
  writer.pair(40, dxfNumber(Math.max(1,
    Math.abs(plan.header.extMax.y - plan.header.extMin.y) || 1)));
  writer.pair(0, 'ENDTAB');

  // LTYPE
  writeTableHead(writer, 'LTYPE', handles(), plan.linetypes.length + 2, '0');
  for (const name of ['ByBlock', 'ByLayer']) {
    writer.pair(0, 'LTYPE').pair(5, handles()).pair(330, '0')
      .pair(100, 'AcDbSymbolTableRecord').pair(100, 'AcDbLinetypeTableRecord')
      .pair(2, name).pair(70, 0).pair(3, '').pair(72, 65).pair(73, 0).pair(40, '0.0');
  }
  for (const linetype of plan.linetypes) {
    const total = linetype.pattern.reduce((sum, value) => sum + Math.abs(value), 0);
    writer.pair(0, 'LTYPE').pair(5, handles()).pair(330, '0')
      .pair(100, 'AcDbSymbolTableRecord').pair(100, 'AcDbLinetypeTableRecord')
      .pair(2, linetype.name).pair(70, 0).pair(3, linetype.description)
      .pair(72, 65).pair(73, linetype.pattern.length).pair(40, dxfNumber(total));
    for (const dash of linetype.pattern) {
      writer.pair(49, dxfNumber(dash)).pair(74, 0);
    }
  }
  writer.pair(0, 'ENDTAB');

  // LAYER
  writeTableHead(writer, 'LAYER', handles(), plan.layers.length, '0');
  for (const layer of plan.layers) {
    const aci = nearestAci(layer.colorHex);
    writer.pair(0, 'LAYER').pair(5, handles()).pair(330, '0')
      .pair(100, 'AcDbSymbolTableRecord').pair(100, 'AcDbLayerTableRecord')
      .pair(2, layer.name)
      .pair(70, 0)
      // A negative colour index is how DXF says a layer is switched off.
      .pair(62, layer.off ? -aci : aci)
      .pair(420, rgbToTrueColor(layer.colorHex))
      .pair(6, layer.linetype)
      .pair(290, layer.plot ? 1 : 0)
      // Lineweight is hundredths of a millimetre, as an integer.
      .pair(370, Math.round(layer.lineweightMM * 100))
      .pair(390, context.plotStyleHandle);
  }
  writer.pair(0, 'ENDTAB');

  // STYLE — Courier, because zbCAD measures text as a monospace 0.6 em and a
  // proportional font would make every string the wrong length on arrival.
  writeTableHead(writer, 'STYLE', handles(), plan.styles.length, '0');
  for (const style of plan.styles) {
    writer.pair(0, 'STYLE').pair(5, handles()).pair(330, '0')
      .pair(100, 'AcDbSymbolTableRecord').pair(100, 'AcDbTextStyleTableRecord')
      .pair(2, style.name).pair(70, 0).pair(40, '0.0')
      .pair(41, dxfNumber(style.widthFactor)).pair(50, '0.0').pair(71, 0)
      .pair(42, '0.2').pair(3, style.font).pair(4, '');
  }
  writer.pair(0, 'ENDTAB');

  writeTableHead(writer, 'VIEW', handles(), 0, '0');
  writer.pair(0, 'ENDTAB');

  writeTableHead(writer, 'UCS', handles(), 0, '0');
  writer.pair(0, 'ENDTAB');

  writeTableHead(writer, 'APPID', handles(), 1, '0');
  writer.pair(0, 'APPID').pair(5, handles()).pair(330, '0')
    .pair(100, 'AcDbSymbolTableRecord').pair(100, 'AcDbRegAppTableRecord')
    .pair(2, 'ACAD').pair(70, 0);
  writer.pair(0, 'ENDTAB');

  // DIMSTYLE
  writeTableHead(writer, 'DIMSTYLE', handles(), plan.dimStyles.length, '0');
  for (const style of plan.dimStyles) {
    writer.pair(0, 'DIMSTYLE').pair(105, handles()).pair(330, '0')
      .pair(100, 'AcDbSymbolTableRecord').pair(100, 'AcDbDimStyleTableRecord')
      .pair(2, style.name).pair(70, 0)
      // DIMSCALE is 1 because the plan has already multiplied every size by it:
      // the numbers below are drawing sizes, not paper sizes.
      .pair(40, '1.0')
      .pair(41, dxfNumber(style.arrowSize))
      .pair(42, dxfNumber(style.extensionOffset))
      .pair(44, dxfNumber(style.extensionBeyond))
      .pair(140, dxfNumber(style.textHeight))
      .pair(147, dxfNumber(style.textGap))
      // DIMTSZ non-zero means "draw ticks, not arrowheads", which is the
      // architectural convention zbCAD's `tick` terminator expresses.
      .pair(141, dxfNumber(style.arrowSize))
      .pair(173, style.tick ? 1 : 0)
      .pair(176, 0).pair(177, 0).pair(178, 0)
      .pair(271, 4).pair(179, 0)
      .pair(340, context.textStyleHandle);
    if (style.tick) writer.pair(142, dxfNumber(style.arrowSize));
  }
  writer.pair(0, 'ENDTAB');

  // BLOCK_RECORD — one per block, plus the two mandatory spaces.
  const blockRecordCount = plan.blocks.length + 2;
  writeTableHead(writer, 'BLOCK_RECORD', handles(), blockRecordCount, '0');
  for (const name of ['*Model_Space', '*Paper_Space']) {
    const handle = name === '*Model_Space' ? context.modelSpaceHandle : context.paperSpaceHandle;
    writer.pair(0, 'BLOCK_RECORD').pair(5, handle).pair(330, '0')
      .pair(100, 'AcDbSymbolTableRecord').pair(100, 'AcDbBlockTableRecord')
      .pair(2, name).pair(70, 0);
  }
  for (const block of plan.blocks) {
    block.recordHandle = handles();
    writer.pair(0, 'BLOCK_RECORD').pair(5, block.recordHandle).pair(330, '0')
      .pair(100, 'AcDbSymbolTableRecord').pair(100, 'AcDbBlockTableRecord')
      .pair(2, block.name).pair(70, 0);
  }
  writer.pair(0, 'ENDTAB');

  writer.pair(0, 'ENDSEC');
}

function writeBlockShell(writer, handles, name, ownerHandle, base, isPaperSpace) {
  writer.pair(0, 'BLOCK').pair(5, handles()).pair(330, ownerHandle)
    .pair(100, 'AcDbEntity').pair(67, isPaperSpace ? 1 : 0).pair(8, '0')
    .pair(100, 'AcDbBlockBegin').pair(2, name).pair(70, 0);
  writer.point(10, base);
  writer.pair(3, name).pair(1, '');
}

function writeBlockEnd(writer, handles, ownerHandle, isPaperSpace) {
  writer.pair(0, 'ENDBLK').pair(5, handles()).pair(330, ownerHandle)
    .pair(100, 'AcDbEntity').pair(67, isPaperSpace ? 1 : 0).pair(8, '0')
    .pair(100, 'AcDbBlockEnd');
}

function writeBlocks(writer, plan, handles, context) {
  writer.pair(0, 'SECTION').pair(2, 'BLOCKS');

  writeBlockShell(writer, handles, '*Model_Space', context.modelSpaceHandle, { x: 0, y: 0 }, false);
  writeBlockEnd(writer, handles, context.modelSpaceHandle, false);
  writeBlockShell(writer, handles, '*Paper_Space', context.paperSpaceHandle, { x: 0, y: 0 }, true);
  writeBlockEnd(writer, handles, context.paperSpaceHandle, true);

  for (const block of plan.blocks) {
    writeBlockShell(writer, handles, block.name, block.recordHandle, block.base, false);
    for (const entity of block.entities) {
      writeEntity(writer, entity, handles, block.recordHandle, context);
    }
    writeBlockEnd(writer, handles, block.recordHandle, false);
  }

  writer.pair(0, 'ENDSEC');
}

function entityHead(writer, type, handles, ownerHandle, layer) {
  writer.pair(0, type).pair(5, handles()).pair(330, ownerHandle)
    .pair(100, 'AcDbEntity').pair(8, layer || '0');
}

export function writeEntity(writer, entity, handles, ownerHandle, context) {
  if (entity.type === 'LINE') {
    entityHead(writer, 'LINE', handles, ownerHandle, entity.layer);
    writer.pair(100, 'AcDbLine');
    writer.point(10, entity.a);
    writer.point(11, entity.b);
    return;
  }
  if (entity.type === 'LWPOLYLINE') {
    entityHead(writer, 'LWPOLYLINE', handles, ownerHandle, entity.layer);
    writer.pair(100, 'AcDbPolyline')
      .pair(90, entity.points.length)
      .pair(70, entity.closed ? 1 : 0);
    for (const point of entity.points) {
      writer.pair(10, dxfNumber(point.x)).pair(20, dxfNumber(point.y));
      // Code 42 is omitted for a straight segment, which is what every other
      // writer does and what keeps a straight polyline byte-comparable.
      if (Math.abs(point.bulge || 0) > 1e-12) writer.pair(42, dxfNumber(point.bulge));
    }
    return;
  }
  if (entity.type === 'CIRCLE') {
    entityHead(writer, 'CIRCLE', handles, ownerHandle, entity.layer);
    writer.pair(100, 'AcDbCircle');
    writer.point(10, entity.center);
    writer.pair(40, dxfNumber(entity.radius));
    return;
  }
  if (entity.type === 'ARC') {
    entityHead(writer, 'ARC', handles, ownerHandle, entity.layer);
    writer.pair(100, 'AcDbCircle');
    writer.point(10, entity.center);
    writer.pair(40, dxfNumber(entity.radius));
    writer.pair(100, 'AcDbArc');
    // DXF arcs run counter-clockwise from start to end, which is zbCAD's own
    // convention, so no swap is needed.
    writer.pair(50, degrees(entity.startAngle));
    writer.pair(51, degrees(entity.endAngle));
    return;
  }
  if (entity.type === 'TEXT') {
    entityHead(writer, 'TEXT', handles, ownerHandle, entity.layer);
    writer.pair(100, 'AcDbText');
    writer.point(10, entity.position);
    writer.pair(40, dxfNumber(entity.height));
    writer.pair(1, dxfEscape(entity.text));
    if (entity.rotation) writer.pair(50, degrees(entity.rotation));
    writer.pair(7, entity.style || 'Standard');
    if (entity.halign) writer.pair(72, entity.halign);
    if (entity.halign || entity.valign) {
      // With any justification but left/baseline, DXF reads the position from
      // the second alignment point, so it has to be written too.
      writer.point(11, entity.position);
    }
    writer.pair(100, 'AcDbText');
    if (entity.valign) writer.pair(73, entity.valign);
    return;
  }
  if (entity.type === 'MTEXT') {
    entityHead(writer, 'MTEXT', handles, ownerHandle, entity.layer);
    writer.pair(100, 'AcDbMText');
    writer.point(10, entity.position);
    writer.pair(40, dxfNumber(entity.height));
    writer.pair(41, dxfNumber(entity.width));
    writer.pair(71, entity.attachment || 1);
    writer.pair(72, 5);
    writer.pair(1, dxfEscape(entity.text));
    writer.pair(7, entity.style || 'Standard');
    if (entity.rotation) writer.pair(50, degrees(entity.rotation));
    writer.pair(73, 2);
    writer.pair(44, dxfNumber(entity.lineSpacing || 1));
    return;
  }
  if (entity.type === 'SOLID') {
    entityHead(writer, 'SOLID', handles, ownerHandle, entity.layer);
    writer.pair(100, 'AcDbTrace');
    writer.point(10, entity.points[0]);
    writer.point(11, entity.points[1]);
    writer.point(12, entity.points[2]);
    writer.point(13, entity.points[3]);
    return;
  }
  if (entity.type === 'DIMENSION') {
    entityHead(writer, 'DIMENSION', handles, ownerHandle, entity.layer);
    writer.pair(100, 'AcDbDimension');
    writer.pair(2, entity.block);
    writer.point(10, entity.defPoint);
    writer.point(11, entity.textMid);
    writer.pair(70, entity.flags);
    writer.pair(71, 5);
    writer.pair(42, dxfNumber(entity.measurement));
    writer.pair(1, '');
    writer.pair(3, entity.styleName);
    if (entity.dimType === 'RADIUS') {
      writer.pair(100, 'AcDbRadialDimension');
      writer.point(15, entity.chordPoint);
      writer.pair(40, '0.0');
      return;
    }
    if (entity.dimType === 'DIAMETER') {
      writer.pair(100, 'AcDbDiametricDimension');
      writer.point(15, entity.chordPoint);
      writer.pair(40, '0.0');
      return;
    }
    writer.pair(100, 'AcDbAlignedDimension');
    writer.point(13, entity.ext1);
    writer.point(14, entity.ext2);
    if (entity.dimType === 'LINEAR') {
      writer.pair(50, degrees(entity.rotation || 0));
      writer.pair(100, 'AcDbRotatedDimension');
    }
    return;
  }
  if (entity.type === 'POINT') {
    entityHead(writer, 'POINT', handles, ownerHandle, entity.layer);
    writer.pair(100, 'AcDbPoint');
    writer.point(10, entity.position);
  }
}

function writeEntities(writer, plan, handles, context) {
  writer.pair(0, 'SECTION').pair(2, 'ENTITIES');
  for (const entity of plan.entities) {
    writeEntity(writer, entity, handles, context.modelSpaceHandle, context);
  }
  writer.pair(0, 'ENDSEC');
}

// R2000 readers expect a named-object dictionary to exist even when it holds
// nothing interesting; a file without one is rejected by some of them.
function writeObjects(writer, handles, context) {
  writer.pair(0, 'SECTION').pair(2, 'OBJECTS');
  writer.pair(0, 'DICTIONARY').pair(5, context.rootDictHandle).pair(330, '0')
    .pair(100, 'AcDbDictionary').pair(281, 1)
    .pair(3, 'ACAD_GROUP').pair(350, context.groupDictHandle);
  writer.pair(0, 'DICTIONARY').pair(5, context.groupDictHandle).pair(330, context.rootDictHandle)
    .pair(100, 'AcDbDictionary').pair(281, 1);
  writer.pair(0, 'ACDBPLACEHOLDER').pair(5, context.plotStyleHandle)
    .pair(330, context.rootDictHandle);
  writer.pair(0, 'ENDSEC');
}

export function buildDxfDocument(plan) {
  const handles = createHandleSource();
  const context = {
    modelSpaceHandle: handles(),
    paperSpaceHandle: handles(),
    rootDictHandle: handles(),
    groupDictHandle: handles(),
    plotStyleHandle: handles(),
    textStyleHandle: handles(),
  };
  const writer = new DxfWriter();
  writeHeader(writer, plan);
  writeTables(writer, plan, handles, context);
  writeBlocks(writer, plan, handles, context);
  writeEntities(writer, plan, handles, context);
  writeObjects(writer, handles, context);
  writer.pair(0, 'EOF');
  return writer.toString();
}
