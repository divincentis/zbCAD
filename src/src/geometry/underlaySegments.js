import { underlayWorldToLocal } from '../model/underlay.js';
import { eachVectorRecord, isVectorUnderlayData, traceVectorPath } from '../model/vectorUnderlay.js';

// ---------------------------------------------------------------------------
// The straight segments of a vector underlay, for OSNAP.
//
// A page placed from a PDF is line work, and the point of keeping it as line
// work rather than a picture is that the drawing traced over it can land
// exactly on its corners instead of on wherever the cursor happened to be.
// That means handing its segments to the snap engine — but a sheet has tens of
// thousands of them and the snap engine runs on every mouse move, so they are
// never handed over wholesale. They are sorted once into a grid, and a query
// returns only the handful that pass near the cursor.
//
// Only straight segments are indexed. A PDF has no circles or arcs, only
// Bezier curves, and a chord across one would offer snaps at points that are
// not on the drawing at all.
// ---------------------------------------------------------------------------

// Cells along the page's longer edge. Finer costs memory in the index;
// coarser means more segments to test exactly at each query.
export const UNDERLAY_SNAP_CELLS = 128;
// More than this many segments within the aperture means the view is zoomed so
// far out that the page's detail is under a few pixels, where no single one
// can be picked anyway — and the snap engine's intersection pass is quadratic.
export const UNDERLAY_SNAP_MAX_SEGMENTS = 240;
export const UNDERLAY_SNAP_INDEX_LIMIT = 4;

// Keyed by the payload string, like the display list in view/underlay.js, so
// moving or calibrating a page keeps its index.
const UNDERLAY_SNAP_INDEXES = new Map();

export function vectorSegmentIndex(data, widthPx, heightPx) {
  const cached = UNDERLAY_SNAP_INDEXES.get(data);
  if (cached) return cached;

  const coords = [];
  let startX = 0;
  let startY = 0;
  let x = 0;
  let y = 0;
  const sink = {
    moveTo(toX, toY) { startX = x = toX; startY = y = toY; },
    lineTo(toX, toY) {
      if (toX !== x || toY !== y) coords.push(x, y, toX, toY);
      x = toX;
      y = toY;
    },
    bezierCurveTo(c1x, c1y, c2x, c2y, toX, toY) { x = toX; y = toY; },
    closePath() {
      if (x !== startX || y !== startY) coords.push(x, y, startX, startY);
      x = startX;
      y = startY;
    },
  };
  eachVectorRecord(data, record => {
    if (record.kind === 'text') return;
    // A white fill is a mask: it hides what is under it and has no edge of its
    // own to be seen, so it has none to snap to either.
    if (record.kind === 'fill' && record.color.every(level => level > 0.98)) return;
    traceVectorPath(record.path, sink);
  });

  const cell = Math.max(1, Math.max(widthPx, heightPx) / UNDERLAY_SNAP_CELLS);
  const columns = Math.max(1, Math.ceil(widthPx / cell));
  const rows = Math.max(1, Math.ceil(heightPx / cell));
  const cells = new Array(columns * rows);
  const segments = Int32Array.from(coords);
  const clampColumn = value => Math.min(columns - 1, Math.max(0, Math.floor(value / cell)));
  const clampRow = value => Math.min(rows - 1, Math.max(0, Math.floor(value / cell)));
  for (let index = 0; index < segments.length; index += 4) {
    const x0 = segments[index];
    const y0 = segments[index + 1];
    const dx = segments[index + 2] - x0;
    const dy = segments[index + 3] - y0;
    // Walked at half-cell steps and filed under each cell it passes through.
    // A corner it merely clips can be missed, which the query allows for by
    // looking half a cell further than it strictly needs to.
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (cell / 2)));
    let last = -1;
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const at = clampRow(y0 + dy * t) * columns + clampColumn(x0 + dx * t);
      if (at === last) continue;
      last = at;
      (cells[at] || (cells[at] = [])).push(index);
    }
  }

  const built = { segments, cells, cell, columns, rows };
  UNDERLAY_SNAP_INDEXES.set(data, built);
  while (UNDERLAY_SNAP_INDEXES.size > UNDERLAY_SNAP_INDEX_LIMIT) {
    UNDERLAY_SNAP_INDEXES.delete(UNDERLAY_SNAP_INDEXES.keys().next().value);
  }
  return built;
}

// The underlay's segments that pass within `radius` of `point`, both in world
// units, as [a, b] pairs in world coordinates — the shape interaction/snap.js
// already works in. Empty for a raster underlay, which has no line work.
export function underlaySegmentsNear(underlay, point, radius) {
  if (!isVectorUnderlayData(underlay.data)) return [];
  const index = vectorSegmentIndex(underlay.data, underlay.widthPx, underlay.heightPx);
  const unit = underlay.unitsPerPixel;
  const local = underlayWorldToLocal(underlay, point);
  const px = local.x / unit;
  const py = local.y / unit;
  const reach = radius / unit;
  const span = reach + index.cell / 2;
  if (px + span < 0 || py + span < 0 || px - span > underlay.widthPx || py - span > underlay.heightPx) return [];
  const column0 = Math.max(0, Math.floor((px - span) / index.cell));
  const column1 = Math.min(index.columns - 1, Math.floor((px + span) / index.cell));
  const row0 = Math.max(0, Math.floor((py - span) / index.cell));
  const row1 = Math.min(index.rows - 1, Math.floor((py + span) / index.cell));

  const cos = Math.cos(underlay.rotation);
  const sin = Math.sin(underlay.rotation);
  const world = (u, v) => ({
    x: underlay.origin.x + (u * cos - v * sin) * unit,
    y: underlay.origin.y + (u * sin + v * cos) * unit,
  });
  const seen = new Set();
  const near = [];
  const coords = index.segments;
  for (let row = row0; row <= row1; row++) {
    for (let column = column0; column <= column1; column++) {
      const bucket = index.cells[row * index.columns + column];
      if (!bucket) continue;
      for (const at of bucket) {
        if (seen.has(at)) continue;
        seen.add(at);
        const x0 = coords[at];
        const y0 = coords[at + 1];
        const dx = coords[at + 2] - x0;
        const dy = coords[at + 3] - y0;
        const t = Math.min(1, Math.max(0, ((px - x0) * dx + (py - y0) * dy) / (dx * dx + dy * dy)));
        if (Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t)) > reach) continue;
        if (near.length >= UNDERLAY_SNAP_MAX_SEGMENTS) return [];
        near.push([world(x0, y0), world(coords[at + 2], coords[at + 3])]);
      }
    }
  }
  return near;
}
