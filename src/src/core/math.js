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
