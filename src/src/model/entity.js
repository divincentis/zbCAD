import { TAU } from '../core/constants.js';
import { angleOnArc, arcSweep, circularPoint, dist, segmentCircularIntersections, segmentIntersection } from '../core/math.js';
import { dimensionGeometry, dimensionSegments } from './dimension.js';
import { allocateEntityId, state } from '../state.js';

export function polygonArea(points) {
  if (!points.length) return 0;
  // Work near the origin to avoid cancellation at large drawing coordinates.
  const origin = points[0];
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    total += (current.x - origin.x) * (next.y - origin.y) -
      (next.x - origin.x) * (current.y - origin.y);
  }
  return total / 2;
}

export function polylineIsClosed(entity) {
  return Boolean(entity.closed) && entity.points.length >= 3;
}

// Total length along the entity: perimeter for a closed shape, run length for
// an open one, circumference or arc length for circular entities.
export function entityLength(entity) {
  if (entity.type === 'CIRCLE') return TAU * entity.radius;
  if (entity.type === 'ARC') return arcSweep(entity) * entity.radius;
  let total = 0;
  for (const [a, b] of entitySegments(entity)) total += dist(a, b);
  return total;
}

// Null where an area is undefined rather than zero: an open polyline and an
// arc do not enclose anything, and saying "0" would be a lie.
export function entityArea(entity) {
  if (entity.type === 'CIRCLE') return Math.PI * entity.radius * entity.radius;
  if (entity.type === 'PLINE' && polylineIsClosed(entity)) return Math.abs(polygonArea(entity.points));
  return null;
}

// ---------------------------------------------------------------------------
// Entity identity
//
// IDs stay monotone integers. The thing that actually matters for references
// is not the id format but that every path which duplicates entities rewrites
// the references between them, so that goes through one helper.
// ---------------------------------------------------------------------------


export function remapEntityReferences(entity, idMap) {
  if (!Array.isArray(entity.refs)) return entity;
  entity.refs = entity.refs.map(ref => {
    if (!ref) return null;
    const mapped = idMap.get(ref.entityId);
    // A reference to something outside the copied set keeps pointing at the
    // original: copying a dimension on its own should still measure the
    // geometry it was measuring.
    return mapped === undefined ? { ...ref } : { ...ref, entityId: mapped };
  });
  return entity;
}

export function duplicateEntities(entities, firstId = null) {
  let nextId = firstId;
  const idMap = new Map();
  const copies = entities.map(entity => {
    const id = firstId === null ? allocateEntityId() : nextId++;
    idMap.set(entity.id, id);
    // Preserve non-finite values until validation can reject them.
    return { ...structuredClone(entity), id };
  });
  for (const copy of copies) remapEntityReferences(copy, idMap);
  return { entities: copies, idMap, nextId: firstId === null ? state.nextId : nextId };
}

export function cloneDimStyles() {
  return state.dimStyles.map(style => ({ ...style }));
}

export function cloneEntities() {
  return JSON.parse(JSON.stringify(state.entities));
}

export function cloneLayers() {
  return JSON.parse(JSON.stringify(state.layers));
}
export function entitySegments(entity) {
  if (entity.type === 'LINE') return [[entity.a, entity.b]];
  if (entity.type === 'PLINE') {
    const segs = [];
    for (let i = 0; i < entity.points.length - 1; i++) segs.push([entity.points[i], entity.points[i + 1]]);
    if (entity.closed && entity.points.length >= 3) {
      segs.push([entity.points[entity.points.length - 1], entity.points[0]]);
    }
    return segs;
  }
  return [];
}

// Geometry for picking and bounds. Dimensions are pickable but are
// deliberately absent from entitySegments: snapping to a dimension line, or
// trimming to one, is never what anybody wants.
export function pickSegments(entity) {
  if (entity.type === 'DIM') return dimensionSegments(entity);
  return entitySegments(entity);
}

export function entityBBox(e) {
  if (e.type === 'CIRCLE') {
    return {
      minX: e.center.x - e.radius,
      maxX: e.center.x + e.radius,
      minY: e.center.y - e.radius,
      maxY: e.center.y + e.radius,
    };
  }
  if (e.type === 'ARC') {
    const points = [
      circularPoint(e.center, e.radius, e.startAngle),
      circularPoint(e.center, e.radius, e.endAngle),
    ];
    for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      if (angleOnArc(angle, e)) points.push(circularPoint(e.center, e.radius, angle));
    }
    return {
      minX: Math.min(...points.map(point => point.x)),
      maxX: Math.max(...points.map(point => point.x)),
      minY: Math.min(...points.map(point => point.y)),
      maxY: Math.max(...points.map(point => point.y)),
    };
  }
  const pts = [];
  for (const [a, b] of pickSegments(e)) pts.push(a, b);
  // The measured points sit outside the line work when extension lines are
  // suppressed, and zoom-extents should still frame them.
  if (e.type === 'DIM') pts.push(e.p1, e.p2, dimensionGeometry(e).textAnchor);
  if (!pts.length) return null;
  return {
    minX: Math.min(...pts.map(p => p.x)), maxX: Math.max(...pts.map(p => p.x)),
    minY: Math.min(...pts.map(p => p.y)), maxY: Math.max(...pts.map(p => p.y)),
  };
}

export function boxesOverlap(a, b) {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

export function boxContains(outer, inner) {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
}

export function pointInBox(p, box) {
  return p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
}

export function boxEdges(box) {
  const corners = [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ];
  return [
    [corners[0], corners[1]],
    [corners[1], corners[2]],
    [corners[2], corners[3]],
    [corners[3], corners[0]],
  ];
}

// A crossing window must select geometry the window actually touches. Testing
// bounding boxes selected any diagonal line whose box overlapped the window,
// and any circle whose box corner overlapped it, even when the window sat in
// empty space.
export function entityCrossesBox(entity, box) {
  const bounds = entityBBox(entity);
  if (!bounds || !boxesOverlap(box, bounds)) return false;
  if (boxContains(box, bounds)) return true;

  const edges = boxEdges(box);
  if (entity.type === 'CIRCLE' || entity.type === 'ARC') {
    return edges.some(([a, b]) => segmentCircularIntersections(a, b, entity).length > 0);
  }
  for (const [a, b] of pickSegments(entity)) {
    if (pointInBox(a, box) || pointInBox(b, box)) return true;
    if (edges.some(([c, d]) => segmentIntersection(a, b, c, d))) return true;
  }
  return false;
}
