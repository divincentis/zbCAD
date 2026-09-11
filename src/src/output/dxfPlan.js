import { LINETYPE_DASH_PATTERNS } from '../core/constants.js';
import { dimSize } from '../core/dimstyle.js';
import { DRAWING_UNITS, LENGTH_FORMATS } from '../core/units.js';
import { entityBBox, mtextLineHeight } from '../model/entity.js';
import { dimensionGeometry, dimensionText } from '../model/dimension.js';
import { PLOT_DASH_MM_PER_UNIT, plotDimensionOps } from './plot.js';
import { state } from '../state.js';

// ---------------------------------------------------------------------------
// The DXF plan
//
// The same split CLAUDE.md asks for between output/plot.js and output/pdf.js:
// this module decides WHAT a DXF should contain, output/dxf.js decides how to
// spell it, and model/dxfRead.js parses a file back into this same shape. That
// last point is the one worth protecting — because import and export share the
// intermediate, a round trip can be asserted as plan → text → plan without
// going near the document model, which is where the mistakes actually hide.
//
// The plan sits at a HIGHER altitude than the plot plan. buildPlotPlan
// flattens everything: arcs become beziers, layers become numbers, dimensions
// become loose line work. DXF wants the opposite — real ARCs, symbolic layer
// names, live DIMENSION entities — so this is a parallel intermediate rather
// than a reuse of that one.
//
// Coordinates here are drawing units, unconverted. A DXF has no paper.
// Angles are radians; degrees appear only in the serialiser.
// ---------------------------------------------------------------------------

// DXF $INSUNITS codes. zbCAD's unit enum was modelled on this header in the
// first place (see core/units.js), so the mapping is one-to-one.
export const DXF_INSUNITS = {
  inches: 1,
  feet: 2,
  millimeters: 4,
  centimeters: 5,
  meters: 6,
};

// $LUNITS: 1 scientific, 2 decimal, 3 engineering, 4 architectural, 5 fractional.
export const DXF_LUNITS = {
  decimal: 2,
  engineering: 3,
  architectural: 4,
  fractional: 5,
};

// zbCAD's MTEXT stacks lines at 1.5x the character height. DXF's MTEXT spaces
// them at 1.66x times a line-spacing factor, so the factor that reproduces
// zbCAD's spacing is 1.5/1.66. Code 44 accepts 0.25..4.0, so this is in range.
export const DXF_MTEXT_SPACING_BASE = 1.66;

// A zbCAD TEXT/MTEXT position is the baseline of the first line; a DXF MTEXT
// with attachment 1 is anchored at the TOP-left of its box. The gap between
// them is one ascent, and there is no exact answer because zbCAD never measures
// a real font — this is the same 0.8 the renderer's own box uses.
export const DXF_TEXT_ASCENT = 0.8;

export const DXF_STYLE_NAME = 'Standard';
export const DXF_DEFAULT_LINETYPE = 'CONTINUOUS';

// zbCAD's dash patterns are screen pixels, turned into paper millimetres by
// PLOT_DASH_MM_PER_UNIT when plotting. A DXF pattern is in drawing units, so
// the same millimetre length is converted back through the drawing's own unit.
export function dxfDashPattern(linetype, drawingUnit) {
  const pattern = LINETYPE_DASH_PATTERNS[linetype];
  if (!pattern || !pattern.length) return null;
  const mmPerUnit = DRAWING_UNITS[drawingUnit].mmPerUnit;
  const lengths = pattern.map((value, index) => {
    const units = (value * PLOT_DASH_MM_PER_UNIT) / mmPerUnit;
    // DXF signs a pattern element: positive draws, negative is a gap. The
    // source pattern alternates dash/gap starting with a dash.
    return index % 2 === 0 ? units : -units;
  });
  return lengths;
}

export function dxfLayerName(name) {
  // DXF forbids these in symbol names. A layer called "A/B" would otherwise
  // produce a file some readers reject outright.
  const cleaned = String(name).replace(/[<>/\\":;?*|=`,]/g, '_').trim();
  return cleaned.slice(0, 255) || 'LAYER';
}

export function dxfLinetypeName(linetype) {
  return String(linetype || 'continuous').toUpperCase();
}

export function dxfPlanLayers(drawingUnit) {
  return state.layers.map(layer => ({
    name: dxfLayerName(layer.name),
    colorHex: layer.color,
    linetype: dxfLinetypeName(layer.linetype),
    lineweightMM: layer.lineweight,
    plot: layer.printable !== false,
    // A DXF layer is switched off by a negative colour index, which is how the
    // `visible` flag survives the trip.
    off: !layer.visible,
    id: layer.id,
  }));
}

export function dxfPlanLinetypes(drawingUnit) {
  const used = new Set(state.layers.map(layer => dxfLinetypeName(layer.linetype)));
  used.add(DXF_DEFAULT_LINETYPE);
  const linetypes = [{ name: DXF_DEFAULT_LINETYPE, description: 'Solid line', pattern: [] }];
  for (const layer of state.layers) {
    const name = dxfLinetypeName(layer.linetype);
    if (name === DXF_DEFAULT_LINETYPE) continue;
    if (linetypes.some(entry => entry.name === name)) continue;
    linetypes.push({
      name,
      description: name.toLowerCase(),
      pattern: dxfDashPattern(layer.linetype, drawingUnit) || [],
    });
  }
  return linetypes;
}

export function dxfPlanDimStyles() {
  return state.dimStyles.map(style => ({
    name: dxfLayerName(style.name || style.id),
    id: style.id,
    scale: style.scale,
    textHeight: dimSize(style, 'textHeight'),
    arrowSize: dimSize(style, 'arrowSize'),
    extensionOffset: dimSize(style, 'extensionOffset'),
    extensionBeyond: dimSize(style, 'extensionBeyond'),
    textGap: dimSize(style, 'textGap'),
    // An architectural tick is DIMTSZ; an arrowhead is DIMTSZ 0 plus DIMASZ.
    tick: style.arrowType === 'tick',
  }));
}

function layerNameFor(layerId, layers) {
  const found = layers.find(layer => layer.id === layerId);
  return found ? found.name : '0';
}

// Identity context: plotDimensionOps is written against a paper transform, and
// handing it the identity gives back the very same line work, arrowheads and
// text in DRAWING units. That is how a dimension's picture gets into its block
// without a second implementation of dimension rendering existing to drift.
export const DXF_IDENTITY_CONTEXT = {
  settings: { color: 'mono', lineweights: false },
  mmPerUnit: 1,
  toPaper: point => ({ x: point.x, y: point.y }),
};

// The anonymous block holding a dimension's drawn picture. R2000 expects one
// per DIMENSION entity; readers that regenerate dimensions ignore it, and
// readers that do not still show the right thing.
export function dxfDimensionBlockEntities(entity, layerName) {
  const ops = plotDimensionOps(entity, DXF_IDENTITY_CONTEXT, [0, 0, 0]);
  const entities = [];
  for (const op of ops) {
    if (op.kind === 'stroke') {
      for (const subpath of op.subpaths) {
        let cursor = subpath.start;
        for (const segment of subpath.segs) {
          // Dimension line work is straight; a bezier here would mean the
          // dimension renderer grew a curve, which is worth not silently
          // flattening.
          if (segment.type === 'l') {
            entities.push({ type: 'LINE', layer: layerName, a: cursor, b: segment.to });
          }
          cursor = segment.to;
        }
      }
    } else if (op.kind === 'fill') {
      // Arrowheads and ticks. A DXF SOLID takes four corners with the third
      // and fourth swapped relative to a polygon's winding; a triangle repeats
      // its last point.
      const points = op.points.slice(0, 4);
      while (points.length < 4) points.push(points[points.length - 1]);
      entities.push({
        type: 'SOLID',
        layer: layerName,
        points: [points[0], points[1], points[3], points[2]],
      });
    } else if (op.kind === 'text') {
      entities.push({
        type: 'TEXT',
        layer: layerName,
        style: DXF_STYLE_NAME,
        position: { x: op.x, y: op.y },
        height: op.sizeMM,
        rotation: op.angle,
        text: op.text,
        // The plan's dimension text is centred on the dimension line; DXF
        // expresses that as horizontal justification 1 with a second alignment
        // point, which the serialiser writes.
        halign: op.anchor === 'center' ? 1 : 0,
        valign: op.baseline === 'middle' ? 2 : 0,
      });
    }
  }
  return entities;
}

export const DXF_DIMENSION_TYPES = { LINEAR: 0, ALIGNED: 1, DIAMETER: 3, RADIUS: 4 };

export function dxfDimensionEntity(entity, layerName, styleName, blockName) {
  const geometry = dimensionGeometry(entity);
  const base = {
    type: 'DIMENSION',
    layer: layerName,
    block: blockName,
    styleName,
    dimType: entity.dimType,
    // Group 70's low bits are the dimension kind; bit 32 says the picture is
    // in a block, which it is, and bit 128 says the text position is given.
    flags: DXF_DIMENSION_TYPES[entity.dimType] + 32 + 128,
    textMid: geometry.textAnchor,
    measurement: geometry.measure,
    text: dimensionText(entity),
    rotation: entity.rotation || 0,
  };
  if (entity.dimType === 'RADIUS') {
    // 10 is the centre, 15 the point on the curve.
    return { ...base, defPoint: entity.p1, chordPoint: entity.p2 };
  }
  if (entity.dimType === 'DIAMETER') {
    return { ...base, defPoint: entity.p2, chordPoint: entity.p1 };
  }
  // Linear and aligned: 10 is where the dimension line sits, 13 and 14 are the
  // two extension line origins.
  return { ...base, defPoint: geometry.q2, ext1: entity.p1, ext2: entity.p2 };
}

export function dxfEntityRecords(entity, layers, plan) {
  const layer = layerNameFor(entity.layerId, layers);
  if (entity.type === 'LINE') {
    return [{ type: 'LINE', layer, a: entity.a, b: entity.b }];
  }
  if (entity.type === 'PLINE') {
    const points = entity.points.map((point, index) => ({
      x: point.x,
      y: point.y,
      // zbCAD's bulge convention IS the DXF one — tan(sweep/4), positive
      // counter-clockwise — so this crosses over untouched.
      bulge: entity.bulges ? (entity.bulges[index] || 0) : 0,
    }));
    return [{ type: 'LWPOLYLINE', layer, points, closed: Boolean(entity.closed) }];
  }
  if (entity.type === 'CIRCLE') {
    return [{ type: 'CIRCLE', layer, center: entity.center, radius: entity.radius }];
  }
  if (entity.type === 'ARC') {
    return [{
      type: 'ARC', layer,
      center: entity.center, radius: entity.radius,
      startAngle: entity.startAngle, endAngle: entity.endAngle,
    }];
  }
  if (entity.type === 'TEXT') {
    return [{
      type: 'TEXT', layer, style: DXF_STYLE_NAME,
      position: entity.position,
      height: entity.height,
      rotation: entity.rotation,
      text: entity.content,
      halign: 0, valign: 0,
    }];
  }
  if (entity.type === 'MTEXT') {
    // Shift up by one ascent, along the text's own up direction, to convert
    // zbCAD's first-line baseline into DXF's top-left attachment point.
    const lift = entity.height * DXF_TEXT_ASCENT;
    const cos = Math.cos(entity.rotation);
    const sin = Math.sin(entity.rotation);
    return [{
      type: 'MTEXT', layer, style: DXF_STYLE_NAME,
      position: {
        x: entity.position.x - lift * sin,
        y: entity.position.y + lift * cos,
      },
      height: entity.height,
      width: entity.width,
      rotation: entity.rotation,
      text: entity.content,
      attachment: 1,
      lineSpacing: mtextLineHeight(entity) / entity.height / DXF_MTEXT_SPACING_BASE,
    }];
  }
  if (entity.type === 'DIM') {
    const styleName = (plan.dimStyles.find(style => style.id === entity.styleId)
      || plan.dimStyles[0]).name;
    const blockName = `*D${plan.blocks.length + 1}`;
    plan.blocks.push({
      name: blockName,
      base: { x: 0, y: 0 },
      entities: dxfDimensionBlockEntities(entity, layer),
    });
    return [dxfDimensionEntity(entity, layer, styleName, blockName)];
  }
  return [];
}

export function buildDxfPlan(options = {}) {
  const drawingUnit = state.unitSettings.drawingUnit;
  const layers = dxfPlanLayers(drawingUnit);
  const plan = {
    header: {
      insunits: DXF_INSUNITS[drawingUnit] ?? 0,
      lunits: DXF_LUNITS[state.unitSettings.format] ?? 2,
      luprec: LENGTH_FORMATS[state.unitSettings.format]?.precisions?.includes(state.unitSettings.precision)
        ? state.unitSettings.precision : 4,
      auprec: state.unitSettings.anglePrecision ?? 1,
      drawingUnit,
      extMin: { x: 0, y: 0 },
      extMax: { x: 0, y: 0 },
    },
    layers,
    linetypes: dxfPlanLinetypes(drawingUnit),
    styles: [{ name: DXF_STYLE_NAME, font: 'cour.ttf', widthFactor: 1 }],
    dimStyles: dxfPlanDimStyles(),
    blocks: [],
    entities: [],
    warnings: [],
  };

  const skipped = new Map();
  // Everything is exported, hidden layers included: a DXF is the drawing, not
  // a plot of it, and the layer's own off flag travels with it.
  const source = options.entities || state.entities;
  for (const entity of source) {
    const records = dxfEntityRecords(entity, layers, plan);
    if (!records.length) {
      skipped.set(entity.type, (skipped.get(entity.type) || 0) + 1);
      continue;
    }
    plan.entities.push(...records);
  }

  const boxes = source.map(entityBBox).filter(Boolean);
  if (boxes.length) {
    plan.header.extMin = {
      x: Math.min(...boxes.map(box => box.minX)),
      y: Math.min(...boxes.map(box => box.minY)),
    };
    plan.header.extMax = {
      x: Math.max(...boxes.map(box => box.maxX)),
      y: Math.max(...boxes.map(box => box.maxY)),
    };
  }

  for (const [type, count] of skipped) {
    plan.warnings.push(`${count} ${type} entit${count === 1 ? 'y' : 'ies'} had no DXF equivalent and were left out.`);
  }
  // DXF's own IMAGE entity needs an IMAGEDEF object and an external or embedded
  // raster, which is a whole subsystem for something no consumer of this file
  // is likely to want. Saying so beats writing a file that quietly lost them.
  if (state.underlays.length) {
    plan.warnings.push(`${state.underlays.length} reference image${state.underlays.length === 1 ? '' : 's'} ` +
      'cannot be written to DXF and are not included.');
  }
  return plan;
}
