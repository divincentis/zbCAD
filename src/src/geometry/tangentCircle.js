import { circleCircleIntersections, dist, pointOnCircularEntity, pointOnInfiniteLine, pointWithinSegment } from '../core/math.js';
import { infiniteLineIntersection, shiftSegment } from './offset.js';

// ---------------------------------------------------------------------------
// Circles tangent to two edges
//
// Two commands need the same construction. FILLET, given a radius, has to find
// where an arc of that radius touches both picked edges. CIRCLE's Ttr option
// asks the same question and keeps the whole circle instead of an arc of it.
//
// A line/line corner has one well-defined intersection point to build from.
// Two general curves generally don't — a line and a circle can cross twice or
// not at all, so there is no single "corner" to bisect. Real CAD works around
// this by constructing loci instead: the set of points a candidate centre
// could sit at, one locus per edge, then intersecting them.
//
// For a line, that locus is the line shifted by the radius, on either side
// (two candidates). For a circle of radius r, it is a concentric circle of
// radius r+R (the new circle sits outside it, the common case) or |r-R| (it is
// internally tangent — nested either way round, wrapping inside a bore or
// swallowing a small circle whole).
//
// Pairing every locus of one edge against every locus of the other, and
// keeping every intersection, produces every geometrically valid tangent
// circle — up to eight of them for two curved edges. Exactly one is what the
// user meant, and there is no way to know which from the radius alone; it is
// picked by the same rule a person uses when AutoCAD asks the same question:
// whichever solution's tangent points fall nearest the two points actually
// clicked.
// ---------------------------------------------------------------------------

// Lengths below this have no usable direction and the arithmetic built on them
// stops meaning anything.
export const TANGENT_TOLERANCE = 1e-9;

// An edge for tangency purposes: a LINE entity (its whole a/b span), one
// segment of a PLINE, named by the point-array indices of its two ends so a
// result can be written back to just that part of the polyline, or a whole
// ARC/CIRCLE. `a`/`b` are the actual point objects the entity stores, not
// copies, so a surviving endpoint can be matched back to its index by
// reference — see fillet.js, which relies on exactly that.
export function edgeRef(entity, segmentIndex) {
  if (entity.type === 'LINE') {
    return { entity, layerId: entity.layerId, kind: 'line', a: entity.a, b: entity.b, pointIndexA: null, pointIndexB: null };
  }
  if (entity.type === 'ARC' || entity.type === 'CIRCLE') {
    return { entity, layerId: entity.layerId, kind: 'circle', center: entity.center, radius: entity.radius };
  }
  const count = entity.points.length;
  const pointIndexA = segmentIndex;
  const pointIndexB = (segmentIndex + 1) % count;
  return {
    entity, layerId: entity.layerId, kind: 'line',
    a: entity.points[pointIndexA], b: entity.points[pointIndexB],
    pointIndexA, pointIndexB,
  };
}

// An infinite line's intersections with a circle, unlike segmentCircleIntersections
// (core/math.js), which clips to the a–b segment: an offset line here is a
// construction line, not the edge itself, so it must extend past both ends.
export function infiniteLineCircleIntersections(a, b, center, radius) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const qa = dx * dx + dy * dy;
  if (qa < TANGENT_TOLERANCE || radius <= 0) return [];
  const fx = a.x - center.x;
  const fy = a.y - center.y;
  const qb = 2 * (fx * dx + fy * dy);
  const qc = fx * fx + fy * fy - radius * radius;
  const discriminant = qb * qb - 4 * qa * qc;
  if (discriminant < -1e-9) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  const points = [];
  for (const t of [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)]) {
    const point = { x: a.x + t * dx, y: a.y + t * dy };
    if (points.some(p => dist(p, point) < 1e-7)) continue;
    points.push(point);
  }
  return points;
}

// The loci a tangent circle's centre could sit at, at distance `radius` from
// this edge. A circle locus carries `sign`: the tangent point sits at
// center + sign*radius*unit(candidateCentre - center) — see
// circularTangentPoint(). That is +1 for the ordinary "outside" tangency and
// for the "this edge's circle swallows the new one" nesting, and -1 only for
// the opposite nesting (the new circle swallows this edge's) — the one case
// where the tangent point sits on the far side of this edge's centre from the
// candidate centre rather than the near side.
export function offsetLoci(ref, radius) {
  if (ref.kind === 'line') {
    const loci = [];
    for (const side of [1, -1]) {
      const shifted = shiftSegment(ref.a, ref.b, radius, side);
      if (shifted) loci.push({ kind: 'line', a: shifted[0], b: shifted[1] });
    }
    return loci;
  }
  const loci = [{ kind: 'circle', center: ref.center, radius: ref.radius + radius, sign: 1 }];
  const nested = Math.abs(ref.radius - radius);
  if (nested > TANGENT_TOLERANCE) {
    loci.push({ kind: 'circle', center: ref.center, radius: nested, sign: radius > ref.radius ? -1 : 1 });
  }
  return loci;
}

export function locusIntersections(first, second) {
  if (first.kind === 'line' && second.kind === 'line') {
    const point = infiniteLineIntersection(first.a, first.b, second.a, second.b);
    return point ? [point] : [];
  }
  if (first.kind === 'line') return infiniteLineCircleIntersections(first.a, first.b, second.center, second.radius);
  if (second.kind === 'line') return infiniteLineCircleIntersections(second.a, second.b, first.center, first.radius);
  return circleCircleIntersections(first, second);
}

export function circularTangentPoint(ref, locus, candidateCenter) {
  const ux = candidateCenter.x - ref.center.x;
  const uy = candidateCenter.y - ref.center.y;
  const length = Math.hypot(ux, uy);
  if (length < TANGENT_TOLERANCE) return null;
  const sign = locus.sign;
  return { x: ref.center.x + sign * ref.radius * ux / length, y: ref.center.y + sign * ref.radius * uy / length };
}

export function edgeTangentPoint(ref, locus, candidateCenter) {
  return ref.kind === 'line'
    ? pointOnInfiniteLine(candidateCenter, ref.a, ref.b)
    : circularTangentPoint(ref, locus, candidateCenter);
}

// Every circle of the given radius tangent to both edges, with the point at
// which it touches each. Callers decide which of them the user meant.
export function tangentCircleSolutions(ref1, ref2, radius) {
  const solutions = [];
  for (const locus1 of offsetLoci(ref1, radius)) {
    for (const locus2 of offsetLoci(ref2, radius)) {
      for (const center of locusIntersections(locus1, locus2)) {
        const t1 = edgeTangentPoint(ref1, locus1, center);
        const t2 = edgeTangentPoint(ref2, locus2, center);
        if (!t1 || !t2) continue;
        solutions.push({ center, t1, t2 });
      }
    }
  }
  return solutions;
}

// Whether a tangent point lands on the drawn edge rather than on the extension
// of it. Both are legitimate answers — a circle tangent to where two walls
// would meet is a real construction — so this ranks solutions rather than
// discarding them.
export function tangentTouchesEdge(ref, point) {
  if (ref.kind === 'line') return pointWithinSegment(point, ref.a, ref.b);
  // A whole circle has no ends to fall outside of; an arc does.
  return pointOnCircularEntity(point, ref.entity);
}

// CIRCLE's Ttr option: the circle of the given radius touching both picked
// edges. Preference goes first to solutions that touch the edges themselves
// rather than their extensions, and then to the one whose contact points are
// nearest what was actually clicked — the extension is still offered when
// nothing else fits, which is what makes "fillet the corner two walls would
// have made" work.
export function tangentTangentRadiusCircle(ref1, ref2, pick1, pick2, radius) {
  if (!Number.isFinite(radius) || radius <= TANGENT_TOLERANCE) {
    return { error: 'Radius must be greater than zero.' };
  }
  let best = null;
  for (const solution of tangentCircleSolutions(ref1, ref2, radius)) {
    const offEdge = (tangentTouchesEdge(ref1, solution.t1) ? 0 : 1) +
      (tangentTouchesEdge(ref2, solution.t2) ? 0 : 1);
    const score = dist(solution.t1, pick1) + dist(solution.t2, pick2);
    if (!best || offEdge < best.offEdge || (offEdge === best.offEdge && score < best.score)) {
      best = { ...solution, offEdge, score };
    }
  }
  if (!best) return { error: 'No circle of that radius is tangent to both of those objects.' };
  return { center: best.center, radius, tangents: [best.t1, best.t2] };
}
