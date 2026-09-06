import { MTEXT_LINE_SPACING, TAU, TEXT_WIDTH_FACTOR } from '../core/constants.js';
import { angleOnArc, arcSweep, bulgeArc, circularPoint, circularSegmentArea, dist, segmentCircularIntersections, segmentIntersection } from '../core/math.js';
import { dimensionGeometry, dimensionSegments } from './dimension.js';
import { allocateEntityId, state } from '../state.js';

// ---------------------------------------------------------------------------
// Text footprint
//
// No real glyph metrics exist outside a canvas context, so a text entity's
// on-screen box is approximated from its character count and height rather
// than measured — see TEXT_WIDTH_FACTOR. Used for bounding box, hit-testing,
// and zoom-extents; the renderer draws with a monospace font specifically to
// keep this approximation close to what actually appears.
//
// MTEXT shares this model rather than getting its own: it is TEXT with a
// fixed box width instead of a width derived from content, and with more than
// one line. Position is the baseline-left anchor of the first (topmost) line,
// exactly like TEXT's position — later lines just stack downward from it —
// so no separate "corner" concept is needed.
// ---------------------------------------------------------------------------

export function rotateAroundOrigin(point, angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return { x: point.x * cosine - point.y * sine, y: point.x * sine + point.y * cosine };
}

// Character width has no real glyph metrics behind it either (see above), so
// wrapping is estimated from the same per-character factor the single-line
// footprint uses, which is also why the renderer uses a monospace font.
export function mtextCharWidth(entity) {
  return entity.height * TEXT_WIDTH_FACTOR;
}

export function mtextLineHeight(entity) {
  return entity.height * MTEXT_LINE_SPACING;
}

// Greedy word wrap against the estimated character width. A word wider than
// the box on its own is hard-broken rather than left to overflow, so a narrow
// box or a long unspaced token still produces a bounded footprint.
export function mtextLines(entity) {
  const maxChars = Math.max(1, Math.floor(entity.width / mtextCharWidth(entity)));
  const lines = [];
  for (const paragraph of entity.content.split('\n')) {
    if (!paragraph) { lines.push(''); continue; }
    let current = '';
    for (let word of paragraph.split(' ')) {
      while (word.length > maxChars) {
        if (current) { lines.push(current); current = ''; }
        lines.push(word.slice(0, maxChars));
        word = word.slice(maxChars);
      }
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > maxChars && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines.length ? lines : [''];
}

function textLocalBounds(entity) {
  const descent = entity.height * 0.25;
  if (entity.type === 'MTEXT') {
    const lineCount = mtextLines(entity).length;
    return {
      width: entity.width,
      minY: -descent - (lineCount - 1) * mtextLineHeight(entity),
      maxY: entity.height,
    };
  }
  return {
    width: Math.max(entity.content.length, 1) * entity.height * TEXT_WIDTH_FACTOR,
    minY: -descent,
    maxY: entity.height,
  };
}

export function textWidth(entity) {
  return textLocalBounds(entity).width;
}

// Corners of the text's footprint, in drawing order, position first. The box
// extends from a quarter-height descender below the baseline (position, or
// for MTEXT the last line's baseline) to the full nominal height above the
// first line's baseline — an approximation of ascender/descender, not a
// measurement of this particular string's actual glyphs.
export function textCorners(entity) {
  const { width, minY, maxY } = textLocalBounds(entity);
  const local = [
    { x: 0, y: minY }, { x: width, y: minY },
    { x: width, y: maxY }, { x: 0, y: maxY },
  ];
  return local.map(point => {
    const rotated = rotateAroundOrigin(point, entity.rotation);
    return { x: entity.position.x + rotated.x, y: entity.position.y + rotated.y };
  });
}

export function textContainsPoint(entity, point) {
  const local = rotateAroundOrigin(
    { x: point.x - entity.position.x, y: point.y - entity.position.y },
    -entity.rotation,
  );
  const { width, minY, maxY } = textLocalBounds(entity);
  return local.x >= 0 && local.x <= width && local.y >= minY && local.y <= maxY;
}

// World-space baseline-left anchor of one wrapped line, for callers (the
// plotter) that need each line's own position rather than the whole box.
export function mtextLinePosition(entity, index) {
  const offset = rotateAroundOrigin({ x: 0, y: -index * mtextLineHeight(entity) }, entity.rotation);
  return { x: entity.position.x + offset.x, y: entity.position.y + offset.y };
}

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

// ---------------------------------------------------------------------------
// Curved polyline segments
//
// A polyline's `bulges` array runs parallel to `points`: bulges[i] curves the
// segment leaving vertex i, so the last entry belongs to the closing segment
// and is unused on an open polyline. The array is absent altogether while
// every segment is straight, which is the overwhelmingly common case and keeps
// both saved files and this module's fast path unchanged — read it only
// through polylineBulge(), never directly.
// ---------------------------------------------------------------------------

export function polylineBulge(entity, index) {
  const value = entity.bulges?.[index];
  return Number.isFinite(value) ? value : 0;
}

export function polylineHasBulges(entity) {
  return entity.type === 'PLINE' && Array.isArray(entity.bulges) &&
    entity.bulges.some((value, index) => polylineBulge(entity, index) !== 0 &&
      (entity.closed || index < entity.points.length - 1));
}

// A bulges array sized to match `points`, for the callers that have to write
// one back. Zero-filled when the polyline is entirely straight.
export function polylineBulgeList(entity) {
  return entity.points.map((vertex, index) => polylineBulge(entity, index));
}

// Drops an all-zero bulges array rather than storing one, so that a polyline
// which has lost its last curve is indistinguishable from one that never had
// any. Every path that writes bulges ends here.
export function withPolylineBulges(entity, bulges) {
  const next = { ...entity };
  if (bulges.some(value => Number.isFinite(value) && value !== 0)) {
    next.bulges = bulges.map(value => (Number.isFinite(value) ? value : 0));
  } else {
    delete next.bulges;
  }
  return next;
}

// Total length along the entity: perimeter for a closed shape, run length for
// an open one, circumference or arc length for circular entities.
export function entityLength(entity) {
  if (entity.type === 'CIRCLE') return TAU * entity.radius;
  if (entity.type === 'ARC') return arcSweep(entity) * entity.radius;
  let total = 0;
  for (const [a, b, arc] of entitySegments(entity)) {
    total += arc ? Math.abs(arc.sweep) * arc.radius : dist(a, b);
  }
  return total;
}

// Null where an area is undefined rather than zero: an open polyline and an
// arc do not enclose anything, and saying "0" would be a lie.
export function entityArea(entity) {
  if (entity.type === 'CIRCLE') return Math.PI * entity.radius * entity.radius;
  if (entity.type === 'PLINE' && polylineIsClosed(entity)) {
    // The straight-sided polygon through the vertices, plus whatever each arc
    // adds beyond its own chord. Both terms are signed the same way round, so
    // a bulge that cuts a bite out of the shape subtracts.
    let total = polygonArea(entity.points);
    for (const [, , arc] of entitySegments(entity)) {
      if (arc) total += circularSegmentArea(arc.radius, arc.sweep);
    }
    return Math.abs(total);
  }
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
// Each segment is [a, b, arc]: `arc` is null for a straight one and otherwise
// the circular arc the segment's bulge describes (see bulgeArc). A caller that
// predates curved segments destructures only [a, b] and so reads the chord,
// which is why every caller for which that distinction matters is listed in
// this module's sibling comment rather than left to be discovered.
export function entitySegments(entity) {
  if (entity.type === 'LINE') return [[entity.a, entity.b, null]];
  if (entity.type === 'PLINE') {
    const segs = [];
    const push = (index, a, b) => segs.push([a, b, bulgeArc(a, b, polylineBulge(entity, index))]);
    for (let i = 0; i < entity.points.length - 1; i++) push(i, entity.points[i], entity.points[i + 1]);
    if (entity.closed && entity.points.length >= 3) {
      push(entity.points.length - 1, entity.points[entity.points.length - 1], entity.points[0]);
    }
    return segs;
  }
  return [];
}

// The extreme points of an arc: its two ends, plus whichever axis crossings it
// actually passes through. Shared by bounding-box code for ARC entities and
// for a polyline's curved segments, which need exactly the same treatment.
export function circularExtremes(arc) {
  const points = [
    circularPoint(arc.center, arc.radius, arc.startAngle),
    circularPoint(arc.center, arc.radius, arc.endAngle),
  ];
  for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    if (angleOnArc(angle, arc)) points.push(circularPoint(arc.center, arc.radius, angle));
  }
  return points;
}

// Geometry for picking and bounds. Dimensions are pickable but are
// deliberately absent from entitySegments: snapping to a dimension line, or
// trimming to one, is never what anybody wants.
export function pickSegments(entity) {
  if (entity.type === 'DIM') return dimensionSegments(entity);
  if (entity.type === 'TEXT' || entity.type === 'MTEXT') {
    const corners = textCorners(entity);
    return corners.map((point, index) => [point, corners[(index + 1) % corners.length]]);
  }
  return entitySegments(entity);
}

export function entityBBox(e) {
  if (e.type === 'TEXT' || e.type === 'MTEXT') {
    const corners = textCorners(e);
    return {
      minX: Math.min(...corners.map(p => p.x)), maxX: Math.max(...corners.map(p => p.x)),
      minY: Math.min(...corners.map(p => p.y)), maxY: Math.max(...corners.map(p => p.y)),
    };
  }
  if (e.type === 'CIRCLE') {
    return {
      minX: e.center.x - e.radius,
      maxX: e.center.x + e.radius,
      minY: e.center.y - e.radius,
      maxY: e.center.y + e.radius,
    };
  }
  if (e.type === 'ARC') {
    const points = circularExtremes(e);
    return {
      minX: Math.min(...points.map(point => point.x)),
      maxX: Math.max(...points.map(point => point.x)),
      minY: Math.min(...points.map(point => point.y)),
      maxY: Math.max(...points.map(point => point.y)),
    };
  }
  const pts = [];
  for (const [a, b, arc] of pickSegments(e)) {
    if (arc) pts.push(...circularExtremes(arc));
    else pts.push(a, b);
  }
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
  for (const [a, b, arc] of pickSegments(entity)) {
    if (pointInBox(a, box) || pointInBox(b, box)) return true;
    if (arc) {
      if (edges.some(([c, d]) => segmentCircularIntersections(c, d, arc).length > 0)) return true;
      continue;
    }
    if (edges.some(([c, d]) => segmentIntersection(a, b, c, d))) return true;
  }
  return false;
}
