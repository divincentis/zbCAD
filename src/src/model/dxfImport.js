import { DEFAULT_LINETYPE, DEFAULT_LINEWEIGHT, DOCUMENT_FORMAT, DOCUMENT_VERSION, LINETYPES, LINEWEIGHTS, TAU } from '../core/constants.js';
import { DEFAULT_DIM_STYLE_ID, defaultDimStyle, defaultUnitSettings } from '../core/defaults.js';
import { normalizeAngle } from '../core/math.js';
import { DXF_INSUNITS, DXF_TEXT_ASCENT } from '../output/dxfPlan.js';
import { aciToHex } from '../output/dxf.js';
import { parseDxfText } from './dxfRead.js';
import { validateDocumentData } from './document.js';

// ---------------------------------------------------------------------------
// DXF import
//
// Turns a parsed DXF plan into a zbCAD document. The policy, decided up front:
// flatten what can be flattened, and report the rest. A real consultant's DXF
// is full of things this program has no model for, and the two bad answers are
// refusing the file outright and silently dropping half of it. So INSERTs are
// exploded at their transform, ellipses and splines are approximated as
// polylines, and anything genuinely unrepresentable is counted by type and
// named in a report the user sees.
//
// Import replaces the document, exactly as opening a file does. Inserting a DXF
// into the current drawing is a different feature and is not this one.
// ---------------------------------------------------------------------------

// How finely a curve with no exact representation is approximated. A DXF arc
// and a zbCAD bulge are the same thing, so only true ellipses and splines land
// here; 64 segments over a full turn holds a metre-radius curve to well under a
// millimetre, which is finer than anything traced off one will be drawn to.
export const DXF_CURVE_SEGMENTS = 64;

export const DXF_INSERT_DEPTH_LIMIT = 8;

const INSUNITS_TO_DRAWING_UNIT = Object.fromEntries(
  Object.entries(DXF_INSUNITS).map(([unit, code]) => [code, unit]),
);

export function drawingUnitFromInsunits(code) {
  return INSUNITS_TO_DRAWING_UNIT[Number(code)] || null;
}

function trueColorToHex(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return `#${(numeric & 0xffffff).toString(16).padStart(6, '0')}`;
}

export function importedLayerColor(layer) {
  // A true colour is exact; an index is a lookup into a palette whose middle is
  // only approximately agreed on, so 420 wins wherever a writer supplied it.
  const exact = layer.trueColor === null || layer.trueColor === undefined
    ? null : trueColorToHex(layer.trueColor);
  if (exact) return exact;
  return aciToHex(layer.aci);
}

export function importedLinetype(name) {
  const lowered = String(name || '').toLowerCase();
  if (LINETYPES.includes(lowered)) return lowered;
  // DXF linetype names are conventions, not a fixed set: match the common
  // spellings by what they describe rather than demanding an exact name.
  if (/dashdot|dash_dot|center/.test(lowered)) return lowered.includes('center') ? 'center' : 'dashdot';
  if (/dot|hidden2/.test(lowered)) return 'dotted';
  if (/dash|hidden/.test(lowered)) return 'dashed';
  return DEFAULT_LINETYPE;
}

export function importedLineweight(value) {
  const numeric = Number(value);
  // -1 ByLayer, -2 ByBlock, -3 Default: all mean "no explicit weight".
  if (!Number.isFinite(numeric) || numeric < 0) return DEFAULT_LINEWEIGHT;
  const mm = numeric / 100;
  let best = DEFAULT_LINEWEIGHT;
  let bestDistance = Infinity;
  for (const candidate of LINEWEIGHTS) {
    const distance = Math.abs(candidate - mm);
    if (distance < bestDistance) { bestDistance = distance; best = candidate; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Transforms, for flattening INSERTs
// ---------------------------------------------------------------------------

export function composeTransform(outer, inner) {
  // inner applied first, then outer.
  return {
    scaleX: outer.scaleX * inner.scaleX,
    scaleY: outer.scaleY * inner.scaleY,
    rotation: outer.rotation + inner.rotation,
    offset: dxfApplyTransform(outer, inner.offset),
  };
}

export function dxfApplyTransform(transform, point) {
  const x = point.x * transform.scaleX;
  const y = point.y * transform.scaleY;
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  return {
    x: transform.offset.x + x * cos - y * sin,
    y: transform.offset.y + x * sin + y * cos,
  };
}

export const DXF_IDENTITY_TRANSFORM = {
  scaleX: 1, scaleY: 1, rotation: 0, offset: { x: 0, y: 0 },
};

function transformIsUniform(transform) {
  return Math.abs(Math.abs(transform.scaleX) - Math.abs(transform.scaleY)) < 1e-9;
}

// ---------------------------------------------------------------------------
// Curve approximation
// ---------------------------------------------------------------------------

export function ellipsePolylinePoints(entity) {
  const majorLength = Math.hypot(entity.majorAxis.x, entity.majorAxis.y);
  if (!(majorLength > 1e-12)) return null;
  const minorLength = majorLength * entity.ratio;
  const axisAngle = Math.atan2(entity.majorAxis.y, entity.majorAxis.x);
  let start = entity.startParam;
  let end = entity.endParam;
  let sweep = end - start;
  if (Math.abs(sweep) < 1e-12) sweep = TAU;
  const closed = Math.abs(Math.abs(sweep) - TAU) < 1e-9;
  const steps = Math.max(8, Math.ceil(DXF_CURVE_SEGMENTS * Math.abs(sweep) / TAU));
  const points = [];
  // A closed ellipse must not repeat its first vertex: zbCAD's closed polyline
  // holds the closing segment implicitly.
  const count = closed ? steps : steps + 1;
  for (let index = 0; index < count; index++) {
    const parameter = start + (sweep * index) / steps;
    const u = Math.cos(parameter) * majorLength;
    const v = Math.sin(parameter) * minorLength;
    points.push({
      x: entity.center.x + u * Math.cos(axisAngle) - v * Math.sin(axisAngle),
      y: entity.center.y + u * Math.sin(axisAngle) + v * Math.cos(axisAngle),
      bulge: 0,
    });
  }
  return { points, closed };
}

// Splines are approximated through their fit points when the writer supplied
// them, and through the control polygon otherwise. Neither is the real curve;
// this is the documented lossy case, and it is reported as such.
export function splinePolylinePoints(entity) {
  const source = entity.fitPoints.length >= 2 ? entity.fitPoints : entity.controlPoints;
  if (source.length < 2) return null;
  return {
    points: source.map(point => ({ x: point.x, y: point.y, bulge: 0 })),
    closed: (entity.flags & 1) === 1,
    approximate: true,
  };
}

// ---------------------------------------------------------------------------
// Plan entity -> zbCAD entity
// ---------------------------------------------------------------------------

function transformedArc(entity, transform) {
  const center = dxfApplyTransform(transform, entity.center);
  const scale = Math.abs(transform.scaleX);
  const radius = entity.radius * scale;
  // A mirrored transform reverses an arc's direction, so start and end swap to
  // keep zbCAD's "always counter-clockwise from start to end" invariant.
  const mirrored = (transform.scaleX * transform.scaleY) < 0;
  let startAngle = entity.startAngle + transform.rotation;
  let endAngle = entity.endAngle + transform.rotation;
  if (mirrored) {
    startAngle = Math.PI - entity.endAngle + transform.rotation;
    endAngle = Math.PI - entity.startAngle + transform.rotation;
  }
  const normalizedStart = normalizeAngle(startAngle);
  let sweep = endAngle - startAngle;
  if (sweep <= 0) sweep += TAU;
  return { center, radius, startAngle: normalizedStart, endAngle: normalizedStart + sweep };
}

export function importEntity(record, transform, context) {
  const layerId = context.layerIdFor(record.layer);
  const place = point => dxfApplyTransform(transform, point);
  const scale = Math.abs(transform.scaleX);

  if (record.type === 'LINE') {
    const a = place(record.a);
    const b = place(record.b);
    if (Math.hypot(b.x - a.x, b.y - a.y) <= 1e-9) return context.skip('zero-length LINE');
    return [{ type: 'LINE', layerId, a, b }];
  }

  if (record.type === 'LWPOLYLINE') {
    return importPolyline(record.points, record.closed, layerId, transform, context);
  }

  if (record.type === 'CIRCLE') {
    if (!(record.radius * scale > 1e-9)) return context.skip('zero-radius CIRCLE');
    if (!transformIsUniform(transform)) {
      // A non-uniformly scaled circle is an ellipse, and saying so beats
      // quietly writing the wrong radius.
      return importEllipse({
        center: record.center,
        majorAxis: { x: record.radius, y: 0 },
        ratio: 1,
        startParam: 0,
        endParam: TAU,
      }, layerId, transform, context);
    }
    return [{ type: 'CIRCLE', layerId, center: place(record.center), radius: record.radius * scale }];
  }

  if (record.type === 'ARC') {
    if (!(record.radius * scale > 1e-9)) return context.skip('zero-radius ARC');
    const arc = transformedArc(record, transform);
    const sweep = arc.endAngle - arc.startAngle;
    if (!(sweep > 1e-8) || sweep >= TAU - 1e-8) {
      return [{ type: 'CIRCLE', layerId, center: arc.center, radius: arc.radius }];
    }
    return [{ type: 'ARC', layerId, ...arc }];
  }

  if (record.type === 'TEXT') {
    const content = String(record.text || '').trim();
    if (!content) return context.skip('empty TEXT');
    return [{
      type: 'TEXT', layerId,
      position: place(record.position),
      height: Math.max(1e-6, record.height * scale),
      rotation: normalizeAngle(record.rotation + transform.rotation),
      content: content.slice(0, 1000),
    }];
  }

  if (record.type === 'MTEXT') {
    const content = decodeMtext(record.text);
    if (!content.trim()) return context.skip('empty MTEXT');
    const height = Math.max(1e-6, record.height * scale);
    const rotation = normalizeAngle(record.rotation + transform.rotation);
    // Undo the attachment-point shift export applies: a top-left anchor is one
    // ascent above the first line's baseline.
    const anchored = place(record.position);
    const lift = attachmentLift(record.attachment, height);
    const position = {
      x: anchored.x + lift * Math.sin(rotation),
      y: anchored.y - lift * Math.cos(rotation),
    };
    const width = record.width * scale;
    if (!(width > 1e-9)) {
      // MTEXT with no wrap width is a single run; zbCAD's MTEXT requires one,
      // so it becomes TEXT unless it actually has line breaks.
      if (!content.includes('\n')) {
        return [{ type: 'TEXT', layerId, position, height, rotation, content: content.slice(0, 1000) }];
      }
      const longest = Math.max(...content.split('\n').map(line => line.length));
      return [{
        type: 'MTEXT', layerId, position, height, rotation,
        width: Math.max(height, longest * height * 0.6),
        content: content.slice(0, 4000),
      }];
    }
    return [{ type: 'MTEXT', layerId, position, height, rotation, width, content: content.slice(0, 4000) }];
  }

  if (record.type === 'SOLID') {
    // A filled quad has no fill in zbCAD, so its outline is kept: the shape is
    // still information even without the fill.
    const points = dedupe(record.points.map(place));
    if (points.length < 3) return context.skip('degenerate SOLID');
    return [{ type: 'PLINE', layerId, points, closed: true }];
  }

  if (record.type === 'ELLIPSE') {
    return importEllipse(record, layerId, transform, context);
  }

  if (record.type === 'SPLINE') {
    const approximated = splinePolylinePoints(record);
    if (!approximated) return context.skip('SPLINE');
    context.approximated('SPLINE');
    return importPolyline(approximated.points, approximated.closed, layerId, transform, context);
  }

  if (record.type === 'POINT') {
    // zbCAD has no POINT entity. Reported rather than turned into a tiny circle
    // that would pollute snap and selection.
    return context.skip('POINT');
  }

  if (record.type === 'DIMENSION') {
    return importDimension(record, layerId, transform, context);
  }

  return context.skip(record.dxfType || record.type);
}

function attachmentLift(attachment, height) {
  const code = Number(attachment) || 1;
  // 1-3 top, 4-6 middle, 7-9 bottom.
  if (code <= 3) return height * DXF_TEXT_ASCENT;
  if (code <= 6) return 0;
  return -height * DXF_TEXT_ASCENT;
}

function dedupe(points) {
  const out = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && Math.hypot(point.x - last.x, point.y - last.y) <= 1e-9) continue;
    out.push({ x: point.x, y: point.y });
  }
  while (out.length > 1
    && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= 1e-9) {
    out.pop();
  }
  return out;
}

function importEllipse(record, layerId, transform, context) {
  const approximated = ellipsePolylinePoints(record);
  if (!approximated) return context.skip('degenerate ELLIPSE');
  context.approximated('ELLIPSE');
  return importPolyline(approximated.points, approximated.closed, layerId, transform, context);
}

function importPolyline(sourcePoints, closed, layerId, transform, context) {
  const mirrored = (transform.scaleX * transform.scaleY) < 0;
  const points = [];
  const bulges = [];
  for (const source of sourcePoints) {
    const placed = dxfApplyTransform(transform, source);
    const last = points[points.length - 1];
    if (last && Math.hypot(placed.x - last.x, placed.y - last.y) <= 1e-9) continue;
    points.push(placed);
    // A bulge is a signed sweep; reflecting the geometry reverses its sign.
    bulges.push(mirrored ? -(source.bulge || 0) : (source.bulge || 0));
  }
  if (closed) {
    while (points.length > 1
      && Math.hypot(points[0].x - points[points.length - 1].x,
        points[0].y - points[points.length - 1].y) <= 1e-9) {
      points.pop();
      bulges.pop();
    }
  }
  if (points.length < 2) return context.skip('degenerate POLYLINE');
  if (closed && points.length < 3) return context.skip('degenerate closed POLYLINE');
  if (!closed) bulges[bulges.length - 1] = 0;

  const entity = { type: 'PLINE', layerId, points, closed: Boolean(closed) };
  if (bulges.some(value => Math.abs(value) > 1e-12)) entity.bulges = bulges;
  return [entity];
}

// A DXF MTEXT carries formatting inline. zbCAD's MTEXT is plain, so the codes
// are stripped rather than rendered: losing the bold is acceptable, showing
// "\f Arial|b1;" to the user is not.
export function decodeMtext(text) {
  let out = String(text || '');
  out = out.replace(/\\P/g, '\n');
  out = out.replace(/\\~/g, ' ');
  // Stacked fractions: keep the pieces, drop the stacking.
  out = out.replace(/\\S([^;]*);/g, (match, body) => body.replace(/[#^]/g, '/'));
  // Any other \X...; control sequence, and the {} grouping around them.
  out = out.replace(/\\[A-Za-z][^\\;]*;/g, '');
  out = out.replace(/\\[A-Za-z]/g, '');
  out = out.replace(/[{}]/g, '');
  out = out.replace(/\\\\/g, '\\');
  return out;
}

const DXF_DIM_KINDS = { 0: 'LINEAR', 1: 'ALIGNED', 3: 'DIAMETER', 4: 'RADIUS' };

function importDimension(record, layerId, transform, context) {
  const kind = DXF_DIM_KINDS[record.kind];
  if (!kind) {
    // Angular and ordinate dimensions have no zbCAD equivalent. Their picture
    // lives in the block, so the geometry survives even though the dimension
    // does not.
    return explodeDimensionBlock(record, layerId, transform, context, 'angular/ordinate DIMENSION');
  }
  const place = point => dxfApplyTransform(transform, point);
  const scale = Math.abs(transform.scaleX);

  if (kind === 'RADIUS' || kind === 'DIAMETER') {
    const p1 = kind === 'RADIUS' ? place(record.defPoint) : place(record.chordPoint);
    const p2 = kind === 'RADIUS' ? place(record.chordPoint) : place(record.defPoint);
    if (Math.hypot(p2.x - p1.x, p2.y - p1.y) <= 1e-9) {
      return explodeDimensionBlock(record, layerId, transform, context, 'degenerate radial DIMENSION');
    }
    return [{
      type: 'DIM', layerId, dimType: kind,
      p1, p2, linePoint: p1, rotation: 0,
      styleId: context.dimStyleIdFor(record.styleName),
      textOffset: offsetFromTextMid(record, place, p1, p2, kind),
      refs: [null, null],
    }];
  }

  const p1 = place(record.ext1);
  const p2 = place(record.ext2);
  if (Math.hypot(p2.x - p1.x, p2.y - p1.y) <= 1e-9) {
    return explodeDimensionBlock(record, layerId, transform, context, 'degenerate DIMENSION');
  }
  return [{
    type: 'DIM', layerId, dimType: kind,
    p1, p2,
    linePoint: place(record.defPoint),
    rotation: kind === 'LINEAR' ? normalizeAngle(record.rotation + transform.rotation) : 0,
    styleId: context.dimStyleIdFor(record.styleName),
    textOffset: null,
    refs: [null, null],
  }];
}

function offsetFromTextMid(record, place, p1, p2) {
  const textMid = place(record.textMid);
  if (!Number.isFinite(textMid.x) || !Number.isFinite(textMid.y)) return null;
  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const offset = { x: textMid.x - mid.x, y: textMid.y - mid.y };
  return Math.hypot(offset.x, offset.y) > 1e-9 ? offset : null;
}

// When a dimension cannot be represented, its drawn picture still can: the
// block holds lines, ticks and text that are perfectly ordinary geometry.
function explodeDimensionBlock(record, layerId, transform, context, reason) {
  const block = context.blocks.get(record.block);
  context.exploded(reason);
  if (!block) return [];
  const out = [];
  for (const child of block.entities) {
    out.push(...importEntity(child, transform, context));
  }
  return out;
}

// ---------------------------------------------------------------------------
// INSERT flattening
// ---------------------------------------------------------------------------

export function importInsert(record, transform, context, depth) {
  if (depth > DXF_INSERT_DEPTH_LIMIT) {
    context.skip('deeply nested INSERT');
    return [];
  }
  const block = context.blocks.get(record.name);
  if (!block) {
    context.skip(`INSERT of missing block ${record.name}`);
    return [];
  }
  const out = [];
  const columns = Math.max(1, Math.floor(record.columns) || 1);
  const rows = Math.max(1, Math.floor(record.rows) || 1);
  for (let column = 0; column < columns; column++) {
    for (let row = 0; row < rows; row++) {
      // A DXF array offsets its copies along the INSERT's own rotated axes.
      const cos = Math.cos(record.rotation);
      const sin = Math.sin(record.rotation);
      const dx = column * record.columnSpacing;
      const dy = row * record.rowSpacing;
      const local = {
        scaleX: record.scaleX,
        scaleY: record.scaleY,
        rotation: record.rotation,
        offset: {
          x: record.insert.x + dx * cos - dy * sin,
          y: record.insert.y + dx * sin + dy * cos,
        },
      };
      // The block's own base point is subtracted before its contents are
      // placed, which is what makes the insertion point land where it should.
      const shifted = {
        ...local,
        offset: dxfApplyTransform(local, {
          x: -block.base.x,
          y: -block.base.y,
        }),
      };
      const combined = composeTransform(transform, shifted);
      out.push(...importRecords(block.entities, combined, context, depth + 1));
    }
  }
  return out;
}

function importRecords(records, transform, context, depth) {
  const out = [];
  for (const record of records) {
    if (record.type === 'INSERT') {
      out.push(...importInsert(record, transform, context, depth));
      continue;
    }
    out.push(...importEntity(record, transform, context));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export function dxfPlanToDocument(plan, options = {}) {
  const skipped = new Map();
  const approximated = new Map();
  const exploded = new Map();

  const drawingUnit = drawingUnitFromInsunits(plan.header.insunits);
  const unitSettings = { ...defaultUnitSettings() };
  if (drawingUnit) {
    unitSettings.drawingUnit = drawingUnit;
    // The architectural and engineering formats are inch-only; a millimetre
    // drawing has to fall back to decimal or the document fails validation.
    if (drawingUnit !== 'inches') {
      unitSettings.format = 'decimal';
      unitSettings.precision = 2;
    }
  }

  // Layers. Layer 0 is mandatory and must survive whatever the file says.
  const layers = [];
  const layerIds = new Map();
  let nextLayerId = 1;
  const addLayer = source => {
    const name = String(source.name || '').trim() || 'Layer';
    const existing = layers.find(layer => layer.name.toLowerCase() === name.toLowerCase());
    if (existing) { layerIds.set(source.name, existing.id); return existing; }
    const id = name === '0' ? '0' : `layer-${nextLayerId++}`;
    const layer = {
      id,
      name: name.slice(0, 80),
      color: importedLayerColor(source),
      visible: !source.off,
      locked: Boolean(source.locked),
      linetype: importedLinetype(source.linetype),
      lineweight: importedLineweight(source.lineweight),
      printable: source.plot !== false,
    };
    layers.push(layer);
    layerIds.set(source.name, id);
    return layer;
  };

  for (const layer of plan.layers) addLayer(layer);
  if (!layers.some(layer => layer.id === '0')) {
    layers.unshift({
      id: '0', name: '0', color: '#d6d6d6', visible: true, locked: false,
      linetype: DEFAULT_LINETYPE, lineweight: DEFAULT_LINEWEIGHT, printable: true,
    });
    layerIds.set('0', '0');
  }

  // Dimension styles. zbCAD's sizes are paper sizes multiplied by a scale; the
  // imported ones are already drawing sizes, so scale is pinned at 1 and the
  // numbers carry over directly.
  const dimStyles = [defaultDimStyle(unitSettings.drawingUnit)];
  const dimStyleIds = new Map();
  for (const style of plan.dimStyles) {
    const name = String(style.name || '').trim();
    if (!name) continue;
    if (name.toLowerCase() === 'standard') {
      dimStyles[0] = {
        ...dimStyles[0],
        scale: 1,
        textHeight: style.textHeight,
        arrowSize: style.arrowSize,
        extensionOffset: style.extensionOffset,
        extensionBeyond: style.extensionBeyond,
        textGap: style.textGap,
        arrowType: style.tick ? 'tick' : 'arrow',
      };
      dimStyleIds.set(name, DEFAULT_DIM_STYLE_ID);
      continue;
    }
    const id = `dim-${dimStyles.length}`;
    dimStyles.push({
      id, name: name.slice(0, 80),
      arrowType: style.tick ? 'tick' : 'arrow',
      scale: 1,
      precision: null,
      textHeight: style.textHeight,
      arrowSize: style.arrowSize,
      extensionOffset: style.extensionOffset,
      extensionBeyond: style.extensionBeyond,
      textGap: style.textGap,
    });
    dimStyleIds.set(name, id);
  }

  const context = {
    blocks: new Map(plan.blocks.map(block => [block.name, block])),
    layerIdFor(name) {
      if (layerIds.has(name)) return layerIds.get(name);
      const created = addLayer({ name, aci: 7, trueColor: null, plot: true });
      return created.id;
    },
    dimStyleIdFor(name) {
      return dimStyleIds.get(name) || DEFAULT_DIM_STYLE_ID;
    },
    skip(what) {
      skipped.set(what, (skipped.get(what) || 0) + 1);
      return [];
    },
    approximated(what) {
      approximated.set(what, (approximated.get(what) || 0) + 1);
    },
    exploded(what) {
      exploded.set(what, (exploded.get(what) || 0) + 1);
    },
  };

  const imported = importRecords(plan.entities, DXF_IDENTITY_TRANSFORM, context, 0);

  let nextId = 1;
  const entities = imported.map(entity => ({ ...entity, id: nextId++ }));

  const document = {
    format: DOCUMENT_FORMAT,
    version: DOCUMENT_VERSION,
    name: options.name || 'Imported',
    units: unitSettings,
    layers,
    dimStyles,
    currentLayerId: '0',
    nextId,
    nextLayerId,
    nextUnderlayId: 1,
    entities,
    underlays: [],
  };

  const checked = validateDocumentData(document);
  if (checked.error) {
    // A whole file refused over one bad entity would be the worst outcome, so
    // the offending entity is dropped and the rest is kept — but only once the
    // per-entity validator has had its say, which is what names the culprit.
    const salvaged = salvageEntities(document, skipped);
    if (salvaged.error) return { error: salvaged.error };
    document.entities = salvaged.entities;
    document.nextId = salvaged.entities.length + 1;
    const recheck = validateDocumentData(document);
    if (recheck.error) return { error: recheck.error };
    return { document: recheck.document, report: buildReport(recheck.document, skipped, approximated, exploded) };
  }

  return {
    document: checked.document,
    report: buildReport(checked.document, skipped, approximated, exploded),
  };
}

function salvageEntities(document, skipped) {
  const kept = [];
  let nextId = 1;
  for (const entity of document.entities) {
    const candidate = { ...document, entities: [{ ...entity, id: 1 }], nextId: 2 };
    if (validateDocumentData(candidate).error) {
      skipped.set(`invalid ${entity.type}`, (skipped.get(`invalid ${entity.type}`) || 0) + 1);
      continue;
    }
    kept.push({ ...entity, id: nextId++ });
  }
  return { entities: kept };
}

function describe(counts) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([what, count]) => `${count} ${what}`)
    .join(', ');
}

export function buildReport(document, skipped, approximated, exploded) {
  const lines = [];
  const total = document.entities.length;
  lines.push(`Imported ${total} object${total === 1 ? '' : 's'} on ${document.layers.length} layer${document.layers.length === 1 ? '' : 's'}.`);
  if (approximated.size) {
    lines.push(`Approximated as polylines: ${describe(approximated)}.`);
  }
  if (exploded.size) {
    lines.push(`Exploded into plain geometry: ${describe(exploded)}.`);
  }
  if (skipped.size) {
    lines.push(`Not imported: ${describe(skipped)}.`);
  }
  if (!approximated.size && !exploded.size && !skipped.size) {
    lines.push('Everything in the file was imported.');
  }
  return {
    text: lines.join('\n'),
    entityCount: total,
    layerCount: document.layers.length,
    skipped: Object.fromEntries(skipped),
    approximated: Object.fromEntries(approximated),
    exploded: Object.fromEntries(exploded),
  };
}

export function importDxfText(text, sourceName = '') {
  const parsed = parseDxfText(text);
  if (parsed.error) return { error: parsed.error };
  const name = String(sourceName).replace(/\.dxf$/i, '').trim();
  return dxfPlanToDocument(parsed.plan, { name: name || 'Imported' });
}
