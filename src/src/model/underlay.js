import { TAU, UNDERLAY_MIN_UNITS_PER_PIXEL } from '../core/constants.js';
import { dist, normalizeAngle } from '../core/math.js';
import { isLayerLocked, isLayerVisible } from './layerQuery.js';
import { state } from '../state.js';

// ---------------------------------------------------------------------------
// Underlays
//
// A raster reference image the drawing is traced over. Underlays are kept in
// their own array rather than joining state.entities for two reasons: the
// roadmap requires them to stay visually distinct from CAD geometry, and every
// one of the seven-way type dispatches across this codebase (segments, bbox,
// snap, offset, trim, grips, plot) would otherwise need a branch for a thing
// that has no geometry to speak of.
//
// The record is deliberately small:
//
//   origin          bottom-left corner in world space
//   rotation        radians CCW about that corner
//   unitsPerPixel   the one number CALIBRATE solves for
//   widthPx/heightPx  the raster's own size, fixed at import
//   fade            0..100, purely a display property
//   locked          this image is not pickable (but still draws)
//   plot            include it in PDF output; off by default, since an
//                   underlay is a tracing aid far more often than artwork
//   layerId         so visibility/lock/printability come from the layer table
//                   instead of a second, parallel permission system
//   data            a JPEG data URL (model/imageImport.js normalises every
//                   source format to JPEG so the PDF writer needs one filter)
// ---------------------------------------------------------------------------

export function allocateUnderlayId() {
  return state.nextUnderlayId++;
}

// Underlays share state.selected with entities. Entity ids are positive
// integers, so prefixing makes the two id spaces provably disjoint and every
// existing `state.selected.has(entity.id)` filter keeps working untouched.
export function underlaySelectionId(id) {
  return `u:${id}`;
}

export function isUnderlaySelectionId(value) {
  return typeof value === 'string' && value.startsWith('u:');
}

export function underlayIdFromSelectionId(value) {
  return isUnderlaySelectionId(value) ? Number(value.slice(2)) : null;
}

export function makeUnderlay(descriptor, origin, options = {}) {
  return {
    id: options.id ?? allocateUnderlayId(),
    layerId: options.layerId ?? state.currentLayerId,
    name: descriptor.name || 'image',
    origin: { x: origin.x, y: origin.y },
    rotation: options.rotation ?? 0,
    unitsPerPixel: options.unitsPerPixel ?? 1,
    widthPx: descriptor.widthPx,
    heightPx: descriptor.heightPx,
    fade: options.fade ?? 0,
    locked: options.locked ?? false,
    plot: options.plot ?? false,
    data: descriptor.data,
  };
}

// A shallow copy is the point, not an oversight: `data` is a base64 string that
// can run to hundreds of kilobytes, and strings are immutable, so sharing the
// reference across every history snapshot costs nothing. Deep-cloning underlays
// (as JSON.parse(JSON.stringify(...)) would) copies that payload on every undo
// push and every commit.
export function cloneUnderlays(underlays = state.underlays) {
  return underlays.map(underlay => ({ ...underlay, origin: { ...underlay.origin } }));
}

export function underlayWidth(underlay) {
  return underlay.widthPx * underlay.unitsPerPixel;
}

export function underlayHeight(underlay) {
  return underlay.heightPx * underlay.unitsPerPixel;
}

// Corners counter-clockwise from the origin: bottom-left, bottom-right,
// top-right, top-left.
export function underlayCorners(underlay) {
  const cos = Math.cos(underlay.rotation);
  const sin = Math.sin(underlay.rotation);
  const w = underlayWidth(underlay);
  const h = underlayHeight(underlay);
  const at = (u, v) => ({
    x: underlay.origin.x + u * cos - v * sin,
    y: underlay.origin.y + u * sin + v * cos,
  });
  return [at(0, 0), at(w, 0), at(w, h), at(0, h)];
}

export function underlayBBox(underlay) {
  const corners = underlayCorners(underlay);
  const xs = corners.map(p => p.x);
  const ys = corners.map(p => p.y);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}

// World point expressed in the image's own unrotated frame, measured in
// drawing units from the bottom-left corner.
export function underlayWorldToLocal(underlay, point) {
  const cos = Math.cos(underlay.rotation);
  const sin = Math.sin(underlay.rotation);
  const dx = point.x - underlay.origin.x;
  const dy = point.y - underlay.origin.y;
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

export function underlayContainsPoint(underlay, point) {
  const local = underlayWorldToLocal(underlay, point);
  return local.x >= 0 && local.y >= 0
    && local.x <= underlayWidth(underlay) && local.y <= underlayHeight(underlay);
}

// Pickable means the layer allows editing AND the underlay is not locked. The
// per-underlay flag exists on top of the layer's because the usual reason to
// bring an image in is to trace over it, and an image that keeps catching
// clicks meant for the geometry on top of it is worse than no image.
export function underlayIsSelectable(underlay) {
  return !underlay.locked && isLayerVisible(underlay.layerId) && !isLayerLocked(underlay.layerId);
}

// Copies share the base64 payload by reference, so duplicating an underlay
// costs a small object rather than the image.
export function duplicateUnderlays(underlays, firstId = null) {
  let nextUnderlayId = firstId ?? state.nextUnderlayId;
  const copies = underlays.map(underlay => ({
    ...underlay,
    id: nextUnderlayId++,
    origin: { ...underlay.origin },
  }));
  return { underlays: copies, nextUnderlayId };
}

export function translateUnderlay(underlay, dx, dy) {
  return { ...underlay, origin: { x: underlay.origin.x + dx, y: underlay.origin.y + dy } };
}

export function rotateUnderlay(underlay, base, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = underlay.origin.x - base.x;
  const dy = underlay.origin.y - base.y;
  return {
    ...underlay,
    origin: { x: base.x + dx * cos - dy * sin, y: base.y + dx * sin + dy * cos },
    rotation: normalizeAngle(underlay.rotation + angle),
  };
}

// Scaling an underlay moves its corner and changes how much ground a pixel
// covers, the same way scaling TEXT moves its position and changes its height.
export function scaleUnderlay(underlay, base, factor) {
  return {
    ...underlay,
    origin: {
      x: base.x + (underlay.origin.x - base.x) * factor,
      y: base.y + (underlay.origin.y - base.y) * factor,
    },
    unitsPerPixel: underlay.unitsPerPixel * factor,
  };
}

// A mirrored raster would have to be drawn flipped, and nothing downstream
// (canvas, PDF) carries a flip flag, so MIRROR reflects the placement and
// leaves the image reading the right way round. The corner that ends up
// bottom-left after reflection becomes the new origin.
export function mirrorUnderlay(underlay, axisA, axisB) {
  const ax = axisB.x - axisA.x;
  const ay = axisB.y - axisA.y;
  const lengthSquared = ax * ax + ay * ay;
  if (lengthSquared < 1e-18) return { ...underlay, origin: { ...underlay.origin } };
  const reflect = point => {
    const dx = point.x - axisA.x;
    const dy = point.y - axisA.y;
    const t = (dx * ax + dy * ay) / lengthSquared;
    const projX = axisA.x + t * ax;
    const projY = axisA.y + t * ay;
    return { x: 2 * projX - point.x, y: 2 * projY - point.y };
  };
  const axisAngle = Math.atan2(ay, ax);
  // Reflection reverses handedness; keeping the image unflipped means the
  // mirrored bottom-left corner is the old bottom-RIGHT corner.
  const corners = underlayCorners(underlay);
  const origin = reflect(corners[1]);
  return {
    ...underlay,
    origin,
    rotation: normalizeAngle(2 * axisAngle - underlay.rotation + Math.PI),
  };
}

// CALIBRATE: the user names two points on the image and the real distance
// between them. The first pick is held fixed so the part of the drawing they
// measured from does not walk away underneath them.
export function calibrateUnderlay(underlay, from, to, knownDistance) {
  const measured = dist(from, to);
  if (!(measured > 1e-9)) return { error: 'Those two points are in the same place.' };
  if (!Number.isFinite(knownDistance) || knownDistance <= 0) {
    return { error: 'Enter a distance greater than zero.' };
  }
  const factor = knownDistance / measured;
  const scaled = scaleUnderlay(underlay, from, factor);
  if (!(scaled.unitsPerPixel > UNDERLAY_MIN_UNITS_PER_PIXEL) || !Number.isFinite(scaled.unitsPerPixel)) {
    return { error: 'That distance would scale the image beyond a usable size.' };
  }
  return { underlay: scaled, factor };
}

export function underlayFadeAlpha(underlay) {
  return 1 - Math.min(100, Math.max(0, underlay.fade || 0)) / 100;
}

export function underlayScaleLabel(underlay) {
  const width = underlayWidth(underlay);
  return { width, height: underlayHeight(underlay), unitsPerPixel: underlay.unitsPerPixel };
}

export function selectedUnderlays() {
  return state.underlays.filter(underlay => state.selected.has(underlaySelectionId(underlay.id)));
}

export function underlayById(id) {
  return state.underlays.find(underlay => underlay.id === id) || null;
}

export function normalizeUnderlayRotation(rotation) {
  const value = normalizeAngle(rotation);
  return value >= TAU ? value - TAU : value;
}
