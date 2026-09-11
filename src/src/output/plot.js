import { LINETYPE_DASH_PATTERNS, TAU } from '../core/constants.js';
import { dimSize } from '../core/dimstyle.js';
import { circularPoint } from '../core/math.js';
import { DEFAULT_PAPER_SIZE_ID, PAPER_MARGIN_MM, paperMMPerDrawingUnit, paperSizeMM, scalePresetLabel } from '../core/paper.js';
import { DRAWING_UNITS } from '../core/units.js';
import { canvas } from '../dom.js';
import { dimensionGeometry, dimensionText } from '../model/dimension.js';
import { entityBBox, entitySegments, mtextLinePosition, mtextLines } from '../model/entity.js';
import { getLayer, isLayerPrintable, isLayerVisible } from '../model/layerQuery.js';
import { pdfTextWidthMM, pdfUnsupportedCharacters } from './pdf.js';
import { state } from '../state.js';
import { screenToWorld } from '../view/viewport.js';

// ---------------------------------------------------------------------------
// Plot plan
//
// The drawing reduced to paper: a list of primitives measured in millimetres
// from the bottom-left corner of the sheet, Y up. Nothing here knows about
// PDF, and nothing here draws — output/pdf.js serialises the plan, and a test
// can assert on it directly, which is the only honest way to check that a
// hundred-foot line really did come out five inches long.
//
// The single number the whole plan turns on is `paperMMPerDrawingUnit`: paper
// millimetres per drawing unit. Every coordinate below is a model coordinate
// multiplied by it and shifted onto the sheet.
// ---------------------------------------------------------------------------

// The linetype patterns are screen pixels (see core/constants.js), which is
// the right unit for something that must stay legible at any zoom. On paper
// there is no zoom, so the same pattern is read as a paper length: a dashed
// line prints as 3.2mm on, 1.6mm off, which is a conventional plotted dash.
export const PLOT_DASH_MM_PER_UNIT = 0.4;

// A lineweight of 0.00 means "thinnest the device can draw"; on paper that is
// a hairline, not an invisible line.
export const PLOT_MIN_LINEWEIGHT_MM = 0.05;
// What everything plots at when lineweights are turned off, and the weight
// dimension line work always uses — dimensions carry their own style rather
// than the layer's, which is the same convention the screen renderer follows.
export const PLOT_THIN_LINEWEIGHT_MM = 0.18;

export const PLOT_AREAS = Object.freeze({
  extents: 'Extents — everything visible',
  display: 'Display — the current view',
  window: 'Window — a picked rectangle',
});
export const PLOT_COLOR_MODES = Object.freeze({
  mono: 'Monochrome (all black)',
  layer: 'Layer colors',
});

export function defaultPlotSettings() {
  return {
    paperSizeId: DEFAULT_PAPER_SIZE_ID,
    orientation: 'landscape',
    area: 'extents',
    window: null,
    scaleMode: 'fit',
    scale: 48,
    center: true,
    color: 'mono',
    lineweights: true,
  };
}

// Hidden layers are absent from the plot for the same reason they are absent
// from the screen. Non-printable layers are the point of the `printable` flag
// added with the rest of the layer record: construction lines and notes that
// belong on screen but never on the issued sheet.
export function plottableEntities() {
  return state.entities.filter(entity =>
    isLayerVisible(entity.layerId) && isLayerPrintable(entity.layerId));
}

export function plotHexColor(hex) {
  const match = /^#([0-9a-fA-F]{6})$/.exec(String(hex || ''));
  if (!match) return [0, 0, 0];
  // White is the traditional "screen white, paper black" CAD color — the one
  // color guaranteed to vanish into white paper otherwise. Only exact white
  // maps; a deliberately chosen off-white/cream layer color is left alone.
  if (match[1].toLowerCase() === 'ffffff') return [0, 0, 0];
  const value = parseInt(match[1], 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

export function plotAreaBox(settings, entities = plottableEntities()) {
  if (settings.area === 'window') {
    const picked = settings.window;
    if (!picked) return null;
    return {
      minX: Math.min(picked.minX, picked.maxX), maxX: Math.max(picked.minX, picked.maxX),
      minY: Math.min(picked.minY, picked.maxY), maxY: Math.max(picked.minY, picked.maxY),
    };
  }
  if (settings.area === 'display') {
    const topLeft = screenToWorld({ x: 0, y: 0 });
    const bottomRight = screenToWorld({ x: canvas.clientWidth, y: canvas.clientHeight });
    return {
      minX: Math.min(topLeft.x, bottomRight.x), maxX: Math.max(topLeft.x, bottomRight.x),
      minY: Math.min(topLeft.y, bottomRight.y), maxY: Math.max(topLeft.y, bottomRight.y),
    };
  }
  const boxes = entities.map(entityBBox).filter(Boolean);
  if (!boxes.length) return null;
  return {
    minX: Math.min(...boxes.map(box => box.minX)), maxX: Math.max(...boxes.map(box => box.maxX)),
    minY: Math.min(...boxes.map(box => box.minY)), maxY: Math.max(...boxes.map(box => box.maxY)),
  };
}

// A cubic approximation of a circular arc, split so no piece sweeps more than
// a quarter turn — past that the error stops being invisible.
// The bezier pieces of an arc, without the subpath that carries them, so that
// a polyline's curved segment can be spliced into a longer path rather than
// having to become a subpath of its own.
export function plotArcSegs(center, radius, startAngle, sweep) {
  const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const step = sweep / pieces;
  const handle = (4 / 3) * Math.tan(step / 4);
  const segs = [];
  for (let piece = 0; piece < pieces; piece++) {
    const from = startAngle + step * piece;
    const to = from + step;
    const p0 = circularPoint(center, radius, from);
    const p1 = circularPoint(center, radius, to);
    segs.push({
      type: 'c',
      c1: { x: p0.x - handle * radius * Math.sin(from), y: p0.y + handle * radius * Math.cos(from) },
      c2: { x: p1.x + handle * radius * Math.sin(to), y: p1.y - handle * radius * Math.cos(to) },
      to: p1,
    });
  }
  return segs;
}

export function plotArcSubpath(center, radius, startAngle, endAngle, closed = false) {
  return {
    start: circularPoint(center, radius, startAngle),
    segs: plotArcSegs(center, radius, startAngle, endAngle - startAngle),
    closed,
  };
}

// One plotted entity's operators. `context` carries the world-to-paper
// transform and the settings-derived choices every entity shares.
export function plotEntityOps(entity, context) {
  const toPaper = context.toPaper;
  const layer = getLayer(entity.layerId);
  const color = context.settings.color === 'layer' ? plotHexColor(layer?.color) : [0, 0, 0];

  if (entity.type === 'DIM') return plotDimensionOps(entity, context, color);
  if (entity.type === 'TEXT') {
    if (!entity.content) return [];
    const anchor = toPaper(entity.position);
    return [{
      kind: 'text',
      text: entity.content,
      x: anchor.x,
      y: anchor.y,
      angle: entity.rotation,
      sizeMM: entity.height * context.mmPerUnit,
      font: 'courier',
      anchor: 'left',
      baseline: 'alphabetic',
      color,
    }];
  }
  if (entity.type === 'MTEXT') {
    if (!entity.content) return [];
    // Map before filtering, so a blank wrapped line still occupies its index
    // and every later line's y-position stays correct.
    return mtextLines(entity).map((line, index) => {
      if (!line) return null;
      const anchor = toPaper(mtextLinePosition(entity, index));
      return {
        kind: 'text',
        text: line,
        x: anchor.x,
        y: anchor.y,
        angle: entity.rotation,
        sizeMM: entity.height * context.mmPerUnit,
        font: 'courier',
        anchor: 'left',
        baseline: 'alphabetic',
        color,
      };
    }).filter(Boolean);
  }

  const widthMM = context.settings.lineweights
    ? Math.max(PLOT_MIN_LINEWEIGHT_MM, layer?.lineweight ?? PLOT_THIN_LINEWEIGHT_MM)
    : PLOT_THIN_LINEWEIGHT_MM;
  const pattern = LINETYPE_DASH_PATTERNS[layer?.linetype] || [];
  const stroke = {
    kind: 'stroke',
    widthMM,
    dash: pattern.map(value => value * PLOT_DASH_MM_PER_UNIT),
    color,
    subpaths: [],
  };

  if (entity.type === 'CIRCLE') {
    stroke.subpaths.push(plotArcSubpath(toPaper(entity.center), entity.radius * context.mmPerUnit, 0, TAU, true));
  } else if (entity.type === 'ARC') {
    stroke.subpaths.push(plotArcSubpath(
      toPaper(entity.center), entity.radius * context.mmPerUnit, entity.startAngle, entity.endAngle));
  } else if (entity.type === 'PLINE') {
    if (entity.points.length < 2) return [];
    const closed = Boolean(entity.closed) && entity.points.length >= 3;
    const segments = entitySegments(entity);
    const segs = [];
    for (let index = 0; index < segments.length; index++) {
      const [, b, arc] = segments[index];
      if (arc) {
        segs.push(...plotArcSegs(toPaper(arc.center), arc.radius * context.mmPerUnit, arc.angleA, arc.sweep));
      } else if (!(closed && index === segments.length - 1)) {
        // A straight closing segment is what the path's own close operator
        // draws, so writing it out too would only repeat it. A curved one has
        // no such shorthand and is emitted above like any other arc.
        segs.push({ type: 'l', to: toPaper(b) });
      }
    }
    stroke.subpaths.push({ start: toPaper(entity.points[0]), segs, closed });
  } else {
    const segments = entitySegments(entity);
    if (!segments.length) return [];
    for (const [a, b] of segments) {
      stroke.subpaths.push({ start: toPaper(a), segs: [{ type: 'l', to: toPaper(b) }], closed: false });
    }
  }
  return [stroke];
}

export function plotDimensionOps(entity, context, color) {
  const toPaper = context.toPaper;
  const geometry = dimensionGeometry(entity);
  const style = geometry.style;
  const q1 = toPaper(geometry.q1);
  const q2 = toPaper(geometry.q2);

  const lineWork = {
    kind: 'stroke',
    widthMM: PLOT_THIN_LINEWEIGHT_MM,
    dash: [],
    color,
    subpaths: [{ start: q1, segs: [{ type: 'l', to: q2 }], closed: false }],
  };
  for (const extension of [geometry.extension1, geometry.extension2]) {
    if (!extension) continue;
    lineWork.subpaths.push({
      start: toPaper(extension[0]),
      segs: [{ type: 'l', to: toPaper(extension[1]) }],
      closed: false,
    });
  }
  const ops = [lineWork];

  // Terminators. The screen renderer works these out in screen space, where Y
  // points down; paper shares the drawing's Y-up convention, so the tick's
  // rotation is written out here rather than reused from there.
  const span = Math.hypot(q2.x - q1.x, q2.y - q1.y);
  const sizeMM = dimSize(style, 'arrowSize') * context.mmPerUnit;
  if (span > 1e-6 && sizeMM > 0) {
    const ux = (q2.x - q1.x) / span;
    const uy = (q2.y - q1.y) / span;
    if (style.arrowType === 'tick') {
      const tx = (ux - uy) * sizeMM * 0.5;
      const ty = (ux + uy) * sizeMM * 0.5;
      lineWork.subpaths.push(
        { start: { x: q1.x - tx, y: q1.y - ty }, segs: [{ type: 'l', to: { x: q1.x + tx, y: q1.y + ty } }], closed: false },
        { start: { x: q2.x - tx, y: q2.y - ty }, segs: [{ type: 'l', to: { x: q2.x + tx, y: q2.y + ty } }], closed: false },
      );
    } else {
      ops.push(
        plotArrowHead(q1, { x: -ux, y: -uy }, sizeMM, color),
        plotArrowHead(q2, { x: ux, y: uy }, sizeMM, color),
      );
    }
  }

  const text = dimensionText(entity);
  const sizeTextMM = dimSize(style, 'textHeight') * context.mmPerUnit;
  if (text && sizeTextMM > 0) {
    const anchor = toPaper(geometry.textAnchor);
    let angle = Math.atan2(q2.y - q1.y, q2.x - q1.x);
    if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;
    const width = pdfTextWidthMM(text, 'helvetica', sizeTextMM);
    // The screen draws a dark box behind the text so it stays readable where
    // it crosses the dimension line. On white paper the same box is white,
    // which is the conventional gap in the dimension line.
    ops.push(plotTextMask(anchor, angle, width + sizeTextMM * 0.4, sizeTextMM * 1.24));
    ops.push({
      kind: 'text',
      text,
      x: anchor.x,
      y: anchor.y,
      angle,
      sizeMM: sizeTextMM,
      font: 'helvetica',
      anchor: 'center',
      baseline: 'middle',
      color,
    });
  }
  return ops;
}

export function plotArrowHead(tip, direction, sizeMM, color) {
  const half = sizeMM * 0.36;
  const backX = tip.x - direction.x * sizeMM;
  const backY = tip.y - direction.y * sizeMM;
  const nx = -direction.y;
  const ny = direction.x;
  return {
    kind: 'fill',
    color,
    points: [
      { x: tip.x, y: tip.y },
      { x: backX + nx * half, y: backY + ny * half },
      { x: backX - nx * half, y: backY - ny * half },
    ],
  };
}

export function plotTextMask(anchor, angle, widthMM, heightMM) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const corners = [
    [-widthMM / 2, -heightMM / 2], [widthMM / 2, -heightMM / 2],
    [widthMM / 2, heightMM / 2], [-widthMM / 2, heightMM / 2],
  ];
  return {
    kind: 'fill',
    color: [1, 1, 1],
    points: corners.map(([u, v]) => ({
      x: anchor.x + u * cos - v * sin,
      y: anchor.y + u * sin + v * cos,
    })),
  };
}

export function buildPlotPlan(settings) {
  const entities = plottableEntities();
  const page = paperSizeMM(settings.paperSizeId, settings.orientation);
  const printable = {
    xMM: PAPER_MARGIN_MM,
    yMM: PAPER_MARGIN_MM,
    widthMM: page.widthMM - PAPER_MARGIN_MM * 2,
    heightMM: page.heightMM - PAPER_MARGIN_MM * 2,
  };
  if (printable.widthMM <= 0 || printable.heightMM <= 0) {
    return { error: 'That sheet is smaller than its own margins.' };
  }
  const area = plotAreaBox(settings, entities);
  if (!area) {
    return {
      error: settings.area === 'window'
        ? 'Pick a plot window first.'
        : 'There is nothing to plot: every object is on a hidden or non-printable layer.',
    };
  }
  const unitMM = DRAWING_UNITS[state.unitSettings.drawingUnit].mmPerUnit;
  // A drawing whose extents are a single horizontal line has no height, and a
  // fitted scale computed from it would be infinite.
  const areaWidth = Math.max(area.maxX - area.minX, 1e-9);
  const areaHeight = Math.max(area.maxY - area.minY, 1e-9);

  let scale = settings.scale;
  let fitted = false;
  if (settings.scaleMode === 'fit') {
    scale = Math.max(
      (areaWidth * unitMM) / printable.widthMM,
      (areaHeight * unitMM) / printable.heightMM,
    );
    fitted = true;
  }
  if (!Number.isFinite(scale) || scale <= 0) return { error: 'The plot scale must be a positive number.' };

  const mmPerUnit = paperMMPerDrawingUnit(scale);
  const plotWidthMM = areaWidth * mmPerUnit;
  const plotHeightMM = areaHeight * mmPerUnit;
  const originX = (settings.center
    ? printable.xMM + (printable.widthMM - plotWidthMM) / 2
    : printable.xMM) - area.minX * mmPerUnit;
  const originY = (settings.center
    ? printable.yMM + (printable.heightMM - plotHeightMM) / 2
    : printable.yMM) - area.minY * mmPerUnit;

  const context = {
    settings,
    mmPerUnit,
    // World and paper share a Y-up convention, so this is a pure scale and
    // shift — no reflection, which is what keeps arcs and rotated text from
    // needing a mirrored special case.
    toPaper: point => ({ x: originX + point.x * mmPerUnit, y: originY + point.y * mmPerUnit }),
  };

  const ops = [];
  const unsupported = new Set();
  for (const entity of entities) {
    for (const op of plotEntityOps(entity, context)) {
      if (op.kind === 'text') pdfUnsupportedCharacters(op.text).forEach(bad => unsupported.add(bad));
      ops.push(op);
    }
  }

  // The picked area (Window/Display/Extents) mapped onto paper, intersected
  // with the printable rectangle. This — not the printable rectangle alone —
  // is what both the PDF and the preview clip against, so geometry outside
  // the picked area is cut off wherever it falls, not just past the sheet's
  // own margin. Native clipping (the PDF viewer's, the canvas's) handles
  // strokes, beziers, fills and text alike, so nothing here has to walk
  // individual primitives to crop them.
  const areaCornerA = context.toPaper({ x: area.minX, y: area.minY });
  const areaCornerB = context.toPaper({ x: area.maxX, y: area.maxY });
  const clipMM = {
    xMM: Math.max(printable.xMM, Math.min(areaCornerA.x, areaCornerB.x)),
    yMM: Math.max(printable.yMM, Math.min(areaCornerA.y, areaCornerB.y)),
  };
  clipMM.widthMM = Math.max(0,
    Math.min(printable.xMM + printable.widthMM, Math.max(areaCornerA.x, areaCornerB.x)) - clipMM.xMM);
  clipMM.heightMM = Math.max(0,
    Math.min(printable.yMM + printable.heightMM, Math.max(areaCornerA.y, areaCornerB.y)) - clipMM.yMM);

  const warnings = [];
  if (plotWidthMM > printable.widthMM + 1e-6 || plotHeightMM > printable.heightMM + 1e-6) {
    warnings.push(`At ${scalePresetLabel(scale)} the plot is ${plotWidthMM.toFixed(1)} × ` +
      `${plotHeightMM.toFixed(1)} mm and will be clipped to the ${printable.widthMM.toFixed(1)} × ` +
      `${printable.heightMM.toFixed(1)} mm printable area.`);
  }
  const excluded = state.entities.length - entities.length;
  if (excluded > 0) {
    warnings.push(`${excluded} object${excluded === 1 ? '' : 's'} on hidden or non-printable layers ` +
      'are not included.');
  }
  if (settings.color === 'layer') {
    warnings.push('Layer colors are chosen for the dark drawing area and can plot faint on white paper.');
  }
  if (unsupported.size) {
    warnings.push(`These characters have no equivalent in the plot font and print as "?": ${[...unsupported].join(' ')}`);
  }

  return {
    page, printable, clipMM, area, scale, fitted, mmPerUnit, ops, warnings,
    plotWidthMM, plotHeightMM,
    entityCount: entities.length,
  };
}
