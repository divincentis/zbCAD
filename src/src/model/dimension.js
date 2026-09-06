import { DIM_TEXT_PREFIX } from '../core/constants.js';
import { DEFAULT_DIM_STYLE_ID } from '../core/defaults.js';
import { dimSize, getDimStyle } from '../core/dimstyle.js';
import { angleFromCenter, angleOnArc, bulgeParam, bulgePointAt, circularPoint, dist } from '../core/math.js';
import { formatLength } from '../core/units.js';
import { isEntityVisible } from './layerQuery.js';
import { state } from '../state.js';

// ---------------------------------------------------------------------------
// Dimension geometry
//
// A dimension is defined by the two points it measures, a point the dimension
// line passes through, and a direction. ALIGNED takes its direction from the
// measured points; LINEAR takes it from `rotation`, so it reports the
// horizontal or vertical component instead of the true distance.
//
// `refs` holds a reference to whatever each measured point was snapped to.
// It is captured at creation and carried through the file.
// `updateAssociativeDimensions` (below) is what makes that reference live: it
// runs once per commit and re-derives p1/p2 from the referenced entity's
// current geometry, so moving, rotating, scaling, or stretching that entity
// carries the dimension along.
// A reference that no longer resolves (the entity was deleted, trimmed away,
// or a polyline vertex it named is gone) simply stops updating that point
// rather than erroring — the dimension freezes at its last measured value.
// ---------------------------------------------------------------------------


export function dimDirection(entity) {
  if (entity.dimType === 'LINEAR') {
    return { x: Math.cos(entity.rotation), y: Math.sin(entity.rotation) };
  }
  const dx = entity.p2.x - entity.p1.x;
  const dy = entity.p2.y - entity.p1.y;
  const length = Math.hypot(dx, dy);
  if (length <= 1e-12) return { x: 1, y: 0 };
  return { x: dx / length, y: dy / length };
}

// Everything the renderer, the hit test, and the bounding box need, derived
// from the stored definition rather than cached, so there is no second copy
// of the truth to keep in step.
export function dimensionGeometry(entity, style = getDimStyle(entity.styleId)) {
  const d = dimDirection(entity);
  const n = { x: -d.y, y: d.x };
  const along = point => (point.x - entity.linePoint.x) * d.x + (point.y - entity.linePoint.y) * d.y;
  const t1 = along(entity.p1);
  const t2 = along(entity.p2);
  const q1 = { x: entity.linePoint.x + d.x * t1, y: entity.linePoint.y + d.y * t1 };
  const q2 = { x: entity.linePoint.x + d.x * t2, y: entity.linePoint.y + d.y * t2 };
  const measure = Math.abs(t2 - t1);

  const offset = dimSize(style, 'extensionOffset');
  const beyond = dimSize(style, 'extensionBeyond');
  const extensionFor = (from, to) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    // A measured point sitting on the dimension line has no extension line.
    if (length <= offset + 1e-9) return null;
    const ux = dx / length;
    const uy = dy / length;
    return [
      { x: from.x + ux * offset, y: from.y + uy * offset },
      { x: to.x + ux * beyond, y: to.y + uy * beyond },
    ];
  };

  const mid = { x: (q1.x + q2.x) / 2, y: (q1.y + q2.y) / 2 };
  // Text sits above the dimension line, on the side away from the geometry.
  const geometryMid = { x: (entity.p1.x + entity.p2.x) / 2, y: (entity.p1.y + entity.p2.y) / 2 };
  const towardGeometry = (geometryMid.x - mid.x) * n.x + (geometryMid.y - mid.y) * n.y;
  const away = towardGeometry > 0 ? -1 : 1;
  const lift = dimSize(style, 'textGap') + dimSize(style, 'textHeight') / 2;
  const textAnchor = entity.textOffset
    ? { x: mid.x + entity.textOffset.x, y: mid.y + entity.textOffset.y }
    : { x: mid.x + n.x * lift * away, y: mid.y + n.y * lift * away };

  return {
    style, direction: d, normal: n, q1, q2, measure, mid, textAnchor,
    extension1: extensionFor(entity.p1, q1),
    extension2: extensionFor(entity.p2, q2),
  };
}

export function dimensionText(entity) {
  const geometry = dimensionGeometry(entity);
  const style = geometry.style;
  const prefix = DIM_TEXT_PREFIX[entity.dimType] || '';
  if (style.precision === null) return prefix + formatLength(geometry.measure);
  return prefix + formatLength(geometry.measure, { ...state.unitSettings, precision: style.precision });
}

// The line work only, used for hit testing and bounds. Text is excluded on
// purpose: picking a dimension by its text is a separate affordance.
export function dimensionSegments(entity) {
  const geometry = dimensionGeometry(entity);
  const segments = [[geometry.q1, geometry.q2]];
  if (geometry.extension1) segments.push(geometry.extension1);
  if (geometry.extension2) segments.push(geometry.extension2);
  return segments;
}

// Signed shoelace area. Callers take the absolute value; the sign is only
// meaningful for winding direction, which nothing needs yet.

// ---------------------------------------------------------------------------
// Dimension commands
// ---------------------------------------------------------------------------

// References are resolved from the committed point rather than captured from
// the snap, so a typed coordinate that lands exactly on a vertex is recorded
// too. The tolerance is deliberately tight: a reference should only exist
// where the point genuinely coincides with a feature, otherwise a future
// associative build would inherit references nobody asked for.
export const REFERENCE_TOLERANCE = 1e-7;

// Duplicates entitySegments() in model/entity.js rather than importing it:
// entity.js already imports dimensionGeometry/dimensionSegments from this
// file, so importing back would be a cycle. The logic is small enough that
// keeping two copies is cheaper than restructuring the module graph for it.
// The third element is the segment's bulge rather than the arc entity.js
// derives from it, since both callers here want the raw number.
function segmentPairs(entity) {
  const segments = [];
  const bulgeAt = index => (Number.isFinite(entity.bulges?.[index]) ? entity.bulges[index] : 0);
  for (let i = 0; i < entity.points.length - 1; i++) {
    segments.push([entity.points[i], entity.points[i + 1], bulgeAt(i)]);
  }
  if (entity.closed && entity.points.length >= 3) {
    const last = entity.points.length - 1;
    segments.push([entity.points[last], entity.points[0], bulgeAt(last)]);
  }
  return segments;
}

// The parametric position of `point` along [a, b] (0 at a, 1 at b) if it
// genuinely lies on the segment within REFERENCE_TOLERANCE, else null. Used
// both to capture a SEGMENT reference and to recompute one later.
function segmentParam(a, b, point) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const length2 = vx * vx + vy * vy;
  if (length2 <= 1e-18) return null;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * vx + (point.y - a.y) * vy) / length2));
  const projected = { x: a.x + t * vx, y: a.y + t * vy };
  return dist(point, projected) <= REFERENCE_TOLERANCE ? t : null;
}

export function entityReferenceCandidates(entity) {
  if (entity.type === 'LINE') {
    return [
      { part: 'START', point: entity.a },
      { part: 'END', point: entity.b },
      { part: 'MID', point: { x: (entity.a.x + entity.b.x) / 2, y: (entity.a.y + entity.b.y) / 2 } },
    ];
  }
  if (entity.type === 'PLINE') {
    return entity.points.map((point, index) => ({ part: 'VERTEX', index, point }));
  }
  if (entity.type === 'CIRCLE') {
    return [
      { part: 'CENTER', point: entity.center },
      ...[0, Math.PI / 2, Math.PI, Math.PI * 1.5].map(angle => ({
        part: 'QUAD', angle, point: circularPoint(entity.center, entity.radius, angle),
      })),
    ];
  }
  if (entity.type === 'ARC') {
    return [
      { part: 'CENTER', point: entity.center },
      { part: 'START', point: circularPoint(entity.center, entity.radius, entity.startAngle) },
      { part: 'END', point: circularPoint(entity.center, entity.radius, entity.endAngle) },
    ];
  }
  return [];
}

export function resolveEntityReference(point) {
  for (const entity of state.entities) {
    if (entity.type === 'DIM' || !isEntityVisible(entity)) continue;
    for (const candidate of entityReferenceCandidates(entity)) {
      if (dist(point, candidate.point) > REFERENCE_TOLERANCE) continue;
      const ref = { entityId: entity.id, part: candidate.part };
      if (candidate.part === 'VERTEX') ref.index = candidate.index;
      // A circle has four quadrant candidates with the same part name; without
      // the angle, resolving the reference later could not tell them apart.
      if (candidate.part === 'QUAD') ref.angle = candidate.angle;
      return ref;
    }
    // Most points picked on a circle or arc are not one of the few named
    // candidates above — a NEAREST snap or a typed coordinate that happens to
    // land on the curve is the common case, and it is also what DIMRADIUS and
    // DIMDIAMETER produce, since the point their leader lands on is wherever
    // the cursor was. Any such point is still a real, trackable spot: its
    // angle from the entity's centre. Checked last so an exact quadrant or arc
    // endpoint still gets its more specific part instead of falling through.
    if (entity.type === 'CIRCLE' || entity.type === 'ARC') {
      if (Math.abs(dist(point, entity.center) - entity.radius) > REFERENCE_TOLERANCE) continue;
      const angle = angleFromCenter(entity.center, point);
      if (angleOnArc(angle, entity)) return { entityId: entity.id, part: 'POINT', angle };
    }
    // Same idea for a straight edge: a NEAREST snap onto a line, or onto a
    // polyline between its vertices, is by far the most common way a point
    // there gets picked, and none of it is START/END/MID/VERTEX. Track it by
    // its parametric position along the segment instead.
    if (entity.type === 'LINE') {
      const t = segmentParam(entity.a, entity.b, point);
      if (t !== null) return { entityId: entity.id, part: 'SEGMENT', t };
    }
    if (entity.type === 'PLINE') {
      const segments = segmentPairs(entity);
      for (let index = 0; index < segments.length; index++) {
        const [a, b, bulge] = segments[index];
        // On a curved segment the position runs along the arc, so the same
        // 0-to-1 number keeps naming the same spot when the curve is reshaped.
        const t = bulge
          ? bulgeParam(a, b, bulge, point, REFERENCE_TOLERANCE)
          : segmentParam(a, b, point);
        if (t !== null) return { entityId: entity.id, part: 'SEGMENT', segmentIndex: index, t };
      }
    }
  }
  return null;
}

// AutoCAD decides horizontal versus vertical from where the dimension line is
// dragged: pull it above or below and you measure the horizontal component.
export function linearDimensionRotation(p1, p2, linePoint) {
  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;
  return Math.abs(linePoint.y - midY) >= Math.abs(linePoint.x - midX) ? 0 : Math.PI / 2;
}

// The other half of entityReferenceCandidates: given the entity a reference
// now points at, recompute the world point that reference names. Returns
// null wherever the reference no longer makes sense against that entity (a
// mismatched type, a vertex index past the current point count, and so on),
// which the caller treats as "leave this measured point where it was."
export function pointForReference(entity, ref) {
  if (!entity || entity.type === 'DIM') return null;
  if (ref.part === 'CENTER') {
    return entity.type === 'CIRCLE' || entity.type === 'ARC' ? entity.center : null;
  }
  if (ref.part === 'QUAD') {
    return entity.type === 'CIRCLE' && Number.isFinite(ref.angle)
      ? circularPoint(entity.center, entity.radius, ref.angle) : null;
  }
  // An arbitrary point on a circle or arc's own curve, named by its angle
  // from the centre rather than one of the fixed candidates above. On an arc
  // whose sweep has since moved past that angle, this freezes rather than
  // producing a point that is no longer actually on the arc.
  if (ref.part === 'POINT') {
    if (entity.type !== 'CIRCLE' && entity.type !== 'ARC') return null;
    if (!Number.isFinite(ref.angle) || !angleOnArc(ref.angle, entity)) return null;
    return circularPoint(entity.center, entity.radius, ref.angle);
  }
  if (ref.part === 'START') {
    if (entity.type === 'LINE') return entity.a;
    if (entity.type === 'ARC') return circularPoint(entity.center, entity.radius, entity.startAngle);
    return null;
  }
  if (ref.part === 'END') {
    if (entity.type === 'LINE') return entity.b;
    if (entity.type === 'ARC') return circularPoint(entity.center, entity.radius, entity.endAngle);
    return null;
  }
  if (ref.part === 'MID') {
    return entity.type === 'LINE'
      ? { x: (entity.a.x + entity.b.x) / 2, y: (entity.a.y + entity.b.y) / 2 } : null;
  }
  if (ref.part === 'VERTEX') {
    if (entity.type !== 'PLINE' || !Number.isInteger(ref.index) ||
        ref.index < 0 || ref.index >= entity.points.length) return null;
    return entity.points[ref.index];
  }
  // An arbitrary point along a line, or along one segment of a polyline,
  // named by its parametric position rather than one of the fixed candidates
  // above. A polyline segment that no longer exists (a vertex was removed or
  // the shape was otherwise reshaped down to fewer segments) freezes this
  // point instead of guessing which segment it meant.
  if (ref.part === 'SEGMENT') {
    if (!Number.isFinite(ref.t)) return null;
    if (entity.type === 'LINE') {
      return { x: entity.a.x + ref.t * (entity.b.x - entity.a.x), y: entity.a.y + ref.t * (entity.b.y - entity.a.y) };
    }
    if (entity.type === 'PLINE') {
      const segments = segmentPairs(entity);
      if (!Number.isInteger(ref.segmentIndex) || ref.segmentIndex < 0 || ref.segmentIndex >= segments.length) return null;
      const [a, b, bulge] = segments[ref.segmentIndex];
      return bulge
        ? bulgePointAt(a, b, bulge, ref.t)
        : { x: a.x + ref.t * (b.x - a.x), y: a.y + ref.t * (b.y - a.y) };
    }
    return null;
  }
  return null;
}

// Runs once per commit (see commitGeometry) over the full candidate entity
// list, so it sees every edit uniformly instead of every command having to
// know it should re-derive dimensions. Idempotent: an entity whose reference
// already resolves to its current point is returned unchanged, so calling
// this on every commit (including ones with no dimensions at all) is cheap
// and never introduces spurious history entries.
export function updateAssociativeDimensions(entities) {
  let byId = null;
  let changed = false;
  const next = entities.map(entity => {
    if (entity.type !== 'DIM' || !entity.refs || (!entity.refs[0] && !entity.refs[1])) return entity;
    byId ??= new Map(entities.map(candidate => [candidate.id, candidate]));
    let p1 = entity.p1;
    let p2 = entity.p2;
    let dirty = false;
    if (entity.refs[0]) {
      const resolved = pointForReference(byId.get(entity.refs[0].entityId), entity.refs[0]);
      if (resolved && (resolved.x !== p1.x || resolved.y !== p1.y)) { p1 = { ...resolved }; dirty = true; }
    }
    if (entity.refs[1]) {
      const resolved = pointForReference(byId.get(entity.refs[1].entityId), entity.refs[1]);
      if (resolved && (resolved.x !== p2.x || resolved.y !== p2.y)) { p2 = { ...resolved }; dirty = true; }
    }
    if (!dirty) return entity;
    changed = true;
    return { ...entity, p1, p2 };
  });
  return changed ? next : entities;
}

export function buildDimension(dimType, p1, p2, linePoint, refs) {
  const rotation = dimType === 'LINEAR' ? linearDimensionRotation(p1, p2, linePoint) : 0;
  return {
    id: 0,
    type: 'DIM',
    layerId: state.currentLayerId,
    dimType,
    p1: { ...p1 },
    p2: { ...p2 },
    linePoint: { ...linePoint },
    rotation,
    styleId: getDimStyle(DEFAULT_DIM_STYLE_ID).id,
    textOffset: null,
    refs: refs || [null, null],
  };
}
