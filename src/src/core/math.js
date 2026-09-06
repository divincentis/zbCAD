import { TAU } from './constants.js';

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function normalizeAngle(angle) {
  const normalized = angle % TAU;
  return normalized < 0 ? normalized + TAU : normalized;
}

export function angleFromCenter(center, point) {
  return normalizeAngle(Math.atan2(point.y - center.y, point.x - center.x));
}

export function circularPoint(center, radius, angle) {
  return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
}

export function isArc(entity) {
  return entity?.type === 'ARC' || entity?.kind === 'ARC';
}

export function arcSweep(entity) {
  return entity.endAngle - entity.startAngle;
}

export function angleOnArc(angle, entity, epsilon = 1e-8) {
  if (!isArc(entity)) return true;
  return normalizeAngle(angle - entity.startAngle) <= arcSweep(entity) + epsilon;
}

export function unwrappedArcAngle(angle, entity) {
  return entity.startAngle + normalizeAngle(angle - entity.startAngle);
}

export function pointOnCircularEntity(point, entity) {
  return !isArc(entity) || angleOnArc(angleFromCenter(entity.center, point), entity);
}

export function pointOnSegmentClosest(p, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return { ...a };
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * vx, y: a.y + t * vy };
}

export function segmentIntersection(a, b, c, d) {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const cross = (u, v) => u.x * v.y - u.y * v.x;
  const den = cross(r, s);
  if (Math.abs(den) < 1e-9) return null;
  const ca = { x: c.x - a.x, y: c.y - a.y };
  const t = cross(ca, s) / den;
  const u = cross(ca, r) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}

export function segmentCircleIntersections(a, b, center, radius) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - center.x;
  const fy = a.y - center.y;
  const qa = dx * dx + dy * dy;
  if (qa < 1e-12 || radius <= 0) return [];
  const qb = 2 * (fx * dx + fy * dy);
  const qc = fx * fx + fy * fy - radius * radius;
  const discriminant = qb * qb - 4 * qa * qc;
  if (discriminant < -1e-9) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  const values = [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)];
  const results = [];
  for (const t of values) {
    if (t < -1e-9 || t > 1 + 1e-9) continue;
    const clamped = Math.max(0, Math.min(1, t));
    if (results.some(result => Math.abs(result.t - clamped) < 1e-8)) continue;
    results.push({ t: clamped, point: pointAlong(a, b, clamped) });
  }
  return results;
}

export function circleCircleIntersections(first, second) {
  const centerDistance = dist(first.center, second.center);
  const r1 = first.radius;
  const r2 = second.radius;
  if (centerDistance < 1e-9 || centerDistance > r1 + r2 + 1e-9 || centerDistance < Math.abs(r1 - r2) - 1e-9) return [];
  const along = (r1 * r1 - r2 * r2 + centerDistance * centerDistance) / (2 * centerDistance);
  const heightSquared = r1 * r1 - along * along;
  if (heightSquared < -1e-9) return [];
  const height = Math.sqrt(Math.max(0, heightSquared));
  const ux = (second.center.x - first.center.x) / centerDistance;
  const uy = (second.center.y - first.center.y) / centerDistance;
  const base = { x: first.center.x + along * ux, y: first.center.y + along * uy };
  const points = [{ x: base.x - height * uy, y: base.y + height * ux }];
  if (height > 1e-8) points.push({ x: base.x + height * uy, y: base.y - height * ux });
  return points;
}

export function segmentCircularIntersections(a, b, circularEntity) {
  return segmentCircleIntersections(a, b, circularEntity.center, circularEntity.radius)
    .filter(intersection => pointOnCircularEntity(intersection.point, circularEntity));
}

export function circularEntityIntersections(first, second) {
  return circleCircleIntersections(first, second)
    .filter(point => pointOnCircularEntity(point, first) && pointOnCircularEntity(point, second));
}

export function segmentWithinRadius(a, b, p, radius) {
  const closest = pointOnSegmentClosest(p, a, b);
  return dist(p, closest) <= radius;
}

// Snap priority, highest first. Distance still decides between candidates in
// different places; this only settles the case where two snaps land on the
// same spot, such as a crossing at the midpoint of a line. Reorder this list
// to change which snap wins there.

// Two candidates within this many pixels of each other count as the same
// place, which keeps the ranking from turning on sub-pixel rounding.
export const SNAP_COINCIDENT_PX = 1;

export function pointOnInfiniteLine(p, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-12) return null;
  const t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  return { x: a.x + t * vx, y: a.y + t * vy };
}

export function pointWithinSegment(p, a, b) {
  const eps = 1e-7;
  return p.x >= Math.min(a.x, b.x) - eps && p.x <= Math.max(a.x, b.x) + eps &&
    p.y >= Math.min(a.y, b.y) - eps && p.y <= Math.max(a.y, b.y) + eps;
}

// Locks the cursor onto the nearest multiple of the polar increment, but only
// once it is close to that ray on screen. Away from every alignment the point
// is left alone, which is what separates polar tracking from ORTHO: ORTHO is
// always in force, polar only when the cursor asks for it.
export function pointAlong(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// ---------------------------------------------------------------------------
// Polyline bulge
//
// A polyline segment is straight when its bulge is zero and a circular arc
// otherwise. The number is DXF's: the tangent of a quarter of the arc's
// included angle, signed positive when the arc sweeps counter-clockwise from
// the segment's first point to its second. Storing the curve that way, rather
// than as a centre and radius, is what lets a curved segment survive every
// edit a straight one does: it is invariant under translation, rotation and
// uniform scale, so MOVE/ROTATE/SCALE never have to know it exists, and only
// MIRROR — which reverses the sense of rotation — has to touch it at all.
// ---------------------------------------------------------------------------

// Below this the segment is straight for every purpose. Squaring a bulge this
// small underflows long before the arc it describes is a pixel off its chord.
export const BULGE_TOLERANCE = 1e-12;

export function bulgeSweep(bulge) {
  return 4 * Math.atan(bulge);
}

export function bulgeFromSweep(sweep) {
  return Math.tan(sweep / 4);
}

// The arc a bulged segment describes, or null when the segment is straight or
// degenerate. Shaped so that every helper above which takes an ARC entity
// (angleOnArc, pointOnCircularEntity, segmentCircularIntersections) accepts it
// unchanged — hence `kind: 'ARC'`, which isArc() recognises. startAngle and
// endAngle follow this app's counter-clockwise arc convention and so belong to
// `b` rather than `a` whenever the bulge is negative; angleA/angleB name the
// two endpoints individually for the callers that need to tell them apart.
export function bulgeArc(a, b, bulge) {
  if (!Number.isFinite(bulge) || Math.abs(bulge) < BULGE_TOLERANCE) return null;
  const chord = dist(a, b);
  if (chord < 1e-12) return null;
  const sweep = bulgeSweep(bulge);
  const radius = chord / (2 * Math.sin(Math.abs(sweep) / 2));
  if (!Number.isFinite(radius) || radius <= 0) return null;
  // Signed distance from the chord's midpoint to the centre, measured to the
  // left of a→b. It goes negative past a half turn, which is exactly what puts
  // the centre on the far side of the chord for a major arc.
  const apothem = (chord / 2) / Math.tan(sweep / 2);
  if (!Number.isFinite(apothem)) return null;
  const ux = (b.x - a.x) / chord;
  const uy = (b.y - a.y) / chord;
  const center = {
    x: (a.x + b.x) / 2 - apothem * uy,
    y: (a.y + b.y) / 2 + apothem * ux,
  };
  const angleA = angleFromCenter(center, a);
  const angleB = angleFromCenter(center, b);
  const startAngle = sweep > 0 ? angleA : angleB;
  return {
    kind: 'ARC',
    center,
    radius,
    startAngle,
    endAngle: startAngle + Math.abs(sweep),
    sweep,
    angleA,
    angleB,
  };
}

// The bulge that reproduces an arc running from `angleA` to `angleB` around
// `center` in the given direction — the inverse of bulgeArc(), used wherever a
// constructed arc has to be written back into a polyline.
export function bulgeForArc(center, angleA, angleB, counterclockwise) {
  const sweep = counterclockwise
    ? normalizeAngle(angleB - angleA)
    : -normalizeAngle(angleA - angleB);
  return bulgeFromSweep(sweep);
}

// The point a fraction `t` of the way along a segment, 0 at `a` and 1 at `b`,
// following the arc when the segment is bulged.
export function bulgePointAt(a, b, bulge, t) {
  const arc = bulgeArc(a, b, bulge);
  if (!arc) return pointAlong(a, b, t);
  return circularPoint(arc.center, arc.radius, arc.angleA + arc.sweep * t);
}

// Where `point` sits along a bulged segment, on the same 0-at-a, 1-at-b scale,
// or null when it is not on that arc within `tolerance`. The whole comparison
// is made in angles rather than on the ratio, so that a point a rounding step
// short of the start reads as the start rather than wrapping a full turn and
// coming back as a parameter far past the end.
export const BULGE_ANGLE_TOLERANCE = 1e-7;

export function bulgeParam(a, b, bulge, point, tolerance) {
  const arc = bulgeArc(a, b, bulge);
  if (!arc) return null;
  if (Math.abs(dist(point, arc.center) - arc.radius) > tolerance) return null;
  const angle = angleFromCenter(arc.center, point);
  const span = Math.abs(arc.sweep);
  let offset = arc.sweep > 0
    ? normalizeAngle(angle - arc.angleA)
    : normalizeAngle(arc.angleA - angle);
  if (offset > TAU - BULGE_ANGLE_TOLERANCE) offset = 0;
  if (offset > span + BULGE_ANGLE_TOLERANCE) return null;
  return Math.min(1, offset / span);
}

// How much area an arc adds beyond its own chord, signed the way the sweep is
// so that a polygon's signed area and its segments' can simply be added up.
export function circularSegmentArea(radius, sweep) {
  return (radius * radius / 2) * (sweep - Math.sin(sweep));
}
