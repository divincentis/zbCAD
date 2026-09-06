import { TAU } from '../core/constants.js';
import { angleFromCenter, circleCircleIntersections, dist, isArc, normalizeAngle, pointOnInfiniteLine, unwrappedArcAngle } from '../core/math.js';
import { hitTestSegment } from './edgeEdit.js';
import { infiniteLineIntersection, shiftSegment } from './offset.js';
import { commitGeometry } from '../model/document.js';
import { isEntityEditable } from '../model/layerQuery.js';
import { state } from '../state.js';
import { updatePrompt } from '../ui/prompt.js';
import { draw } from '../view/frame.js';

// ---------------------------------------------------------------------------
// Fillet and chamfer
//
// Both rebuild the corner where two straight edges meet: FILLET with a tangent
// arc of a given radius, CHAMFER with a straight cut at given distances. Both
// trim or extend the two edges onto the new corner, which is why a radius of
// zero is not a special case but the everyday "close this corner exactly"
// cleanup — the tangent length falls out as zero and the two edges simply meet
// at their intersection.
//
// An "edge" is a LINE entity or one segment of a PLINE — see edgeRef(). The
// two edges are ordinarily two different entities, each trimmed/extended by
// rewriting its own endpoint. When they are instead the two segments either
// side of one polyline vertex (the everyday "round this rectangle's corner"
// case), that shared vertex has to become two separate points rather than
// one — see sharedVertexIndex()/spliceEntity() — since it is the single point
// where both edges currently meet. Polylines here have no curved (bulge)
// segment, so a shared vertex can be chamfered (the new points are a straight
// cut, which a polyline can represent natively) but not filleted; that case
// is refused by name rather than either faking a straight "arc" or breaking
// the polyline into pieces to carry a real one.
//
// FILLET also accepts ARC and CIRCLE edges, in any combination with each
// other or with a line/polyline segment — see filletCurved() below. A CIRCLE
// is never trimmed (it has no endpoint to move), only an ARC's nearer
// endpoint is; the arc's other endpoint, and which of the (up to eight)
// tangent-circle solutions is used, are chosen by the same "whichever is
// closest to what the user actually clicked" rule as everything else here.
// CHAMFER has no equivalent: a straight cut at an arc-length distance from an
// arc/circle is a murkier idea than a radius, so it still refuses them by
// name, per the roadmap's rule that an unsupported case is reported and the
// original geometry preserved.
// ---------------------------------------------------------------------------

export const CORNER_TOLERANCE = 1e-9;

// Two directions this close to parallel have no usable corner: the
// intersection runs off towards infinity and the arithmetic stops meaning
// anything. Compared against the sine of the angle between unit vectors, so
// the test is about the angle rather than the size of the coordinates.
export const CORNER_PARALLEL_SINE = 1e-9;

export function cornerDirection(line) {
  const dx = line.b.x - line.a.x;
  const dy = line.b.y - line.a.y;
  const length = Math.hypot(dx, dy);
  if (length < CORNER_TOLERANCE) return null;
  return { x: dx / length, y: dy / length };
}

// One side of the corner: which way the edge runs away from the intersection
// towards the part the user picked, and which endpoint therefore survives.
export function cornerArm(line, corner, pick) {
  const along = cornerDirection(line);
  if (!along) return null;
  const reach = (pick.x - corner.x) * along.x + (pick.y - corner.y) * along.y;
  const endA = (line.a.x - corner.x) * along.x + (line.a.y - corner.y) * along.y;
  const endB = (line.b.x - corner.x) * along.x + (line.b.y - corner.y) * along.y;
  // A pick sitting on the corner itself names no side, so the longer half of
  // the edge is kept: that is the piece the user can still see.
  const forward = Math.abs(reach) > CORNER_TOLERANCE
    ? reach > 0
    : Math.abs(endA) < Math.abs(endB) ? endB > 0 : endA > 0;
  const direction = forward ? along : { x: -along.x, y: -along.y };
  const projectionA = forward ? endA : -endA;
  const projectionB = forward ? endB : -endB;
  return {
    direction,
    // The surviving endpoint is the one furthest along the kept direction.
    // When the corner lies beyond both, this is the end the edge is stretched
    // from to reach it.
    far: projectionA >= projectionB ? line.a : line.b,
    reach: Math.max(projectionA, projectionB),
  };
}

export function cornerFrame(first, second, pickFirst, pickSecond) {
  const along1 = cornerDirection(first);
  const along2 = cornerDirection(second);
  if (!along1 || !along2) return { error: 'A line with no length has no direction to work from.' };
  // Parallel and collinear are the same refusal, and it is made here, on unit
  // directions, rather than on the crossing itself: a pair of edges a hair off
  // parallel still produces a finite intersection, just one thousands of units
  // away that no user pointed at.
  const sine = along1.x * along2.y - along1.y * along2.x;
  if (Math.abs(sine) < CORNER_PARALLEL_SINE) {
    return { error: 'Those two lines are parallel, so they have no corner.' };
  }

  const corner = infiniteLineIntersection(first.a, first.b, second.a, second.b);
  if (!corner) return { error: 'Those two lines are parallel, so they have no corner.' };
  const arm1 = cornerArm(first, corner, pickFirst);
  const arm2 = cornerArm(second, corner, pickSecond);
  // Either kept side may run against its line's stored direction, so the
  // enclosed angle is measured from the arms. It is the corner the user
  // pointed into, not necessarily the smallest of the four the crossing makes.
  const cosine = arm1.direction.x * arm2.direction.x + arm1.direction.y * arm2.direction.y;
  const armSine = arm1.direction.x * arm2.direction.y - arm1.direction.y * arm2.direction.x;
  return { corner, arm1, arm2, included: Math.atan2(Math.abs(armSine), cosine) };
}

// The arc belongs with the corner it closes, so it inherits the layer when
// both edges agree and falls back to the current layer when they do not.
export function cornerLayerId(first, second) {
  return first.layerId === second.layerId ? first.layerId : state.currentLayerId;
}

// An edge for corner purposes: a LINE entity (its whole a/b span), or one
// segment of a PLINE, named by the point-array indices of its two ends so a
// result can be written back to just that part of the polyline. `a`/`b` are
// the actual point objects the entity stores, not copies, so arm.far — itself
// one of `a`/`b`, see cornerArm() — can be matched back to its index by
// reference in sharedVertexIndex()/buildIndependentUpdates().
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

// Two edges share a polyline corner when they are segments of the same
// polyline and one's endpoint is the other's — the ordinary case of picking
// the two edges either side of one vertex. Returns that vertex's index, or
// null for two independent edges (different entities, or non-adjacent
// segments of the same polyline, which have nothing in common to splice).
export function sharedVertexIndex(ref1, ref2) {
  if (ref1.pointIndexA === null || ref1.entity.id !== ref2.entity.id) return null;
  if (ref1.pointIndexA === ref2.pointIndexA || ref1.pointIndexA === ref2.pointIndexB) return ref1.pointIndexA;
  if (ref1.pointIndexB === ref2.pointIndexA || ref1.pointIndexB === ref2.pointIndexB) return ref1.pointIndexB;
  return null;
}

// Splits the one vertex ref1/ref2 share into their two tangent/cut points, in
// path order — the vertex-side of whichever ref runs INTO it (its `b`) gets
// the earlier point, the side that runs OUT of it (the other ref's `a`) gets
// the later one. Coincident points (FILLET 0's exact-intersection case, which
// for an already-sharp polyline vertex is the vertex itself) collapse back to
// one point rather than leaving a zero-length duplicate segment behind.
export function spliceEntity(ref1, ref2, sharedIndex, t1, t2) {
  const [into, outOf] = ref1.pointIndexB === sharedIndex ? [t1, t2] : [t2, t1];
  const points = ref1.entity.points.map(point => ({ ...point }));
  if (dist(into, outOf) < CORNER_TOLERANCE) {
    points[sharedIndex] = into;
  } else {
    points.splice(sharedIndex, 1, into, outOf);
  }
  return { ...ref1.entity, points };
}

// The ordinary case: each edge's near endpoint (arm.far is the one kept, see
// cornerArm()) moves independently to its own tangent/cut point. A LINE is
// simply rewritten; a polyline has just the one point-array index touched. If
// both edges happen to belong to the same polyline without sharing a vertex,
// their edits are merged into a single update of that one entity.
function updateEdgeEndpoint(ref, arm, point, base) {
  if (ref.entity.type === 'LINE') {
    return { ...ref.entity, a: { ...arm.far }, b: point };
  }
  const index = arm.far === ref.a ? ref.pointIndexB : ref.pointIndexA;
  const entity = base || ref.entity;
  const points = entity.points === ref.entity.points ? ref.entity.points.map(p => ({ ...p })) : entity.points;
  points[index] = point;
  return { ...entity, points };
}

export function buildIndependentUpdates(ref1, arm1, t1, ref2, arm2, t2) {
  const byId = new Map();
  for (const { ref, arm, point } of [{ ref: ref1, arm: arm1, point: t1 }, { ref: ref2, arm: arm2, point: t2 }]) {
    byId.set(ref.entity.id, updateEdgeEndpoint(ref, arm, point, byId.get(ref.entity.id)));
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// FILLET on a curved edge (ARC or CIRCLE), alone or paired with another one.
//
// A line/line corner has one well-defined intersection point to build from.
// Two general curves generally don't — a line and a circle can cross twice or
// not at all, so there is no single "corner" to bisect. Real CAD fillet works
// around this by constructing loci instead: the set of points a candidate
// fillet centre could sit at, one locus per edge, then intersecting them.
//
// For a line, that locus is the line shifted by the radius, on either side
// (two candidates). For a circle of radius r, it is a concentric circle of
// radius r+R (the fillet arc sits outside it, the common "round this corner"
// case) or |r-R| (the fillet arc is internally tangent — nested either way
// round, wrapping inside a bore or swallowing a small circle whole).
//
// Pairing every locus of one edge against every locus of the other, and
// keeping every intersection, produces every geometrically valid tangent
// circle — up to eight of them for two curved edges. Exactly one is what the
// user meant, and there is no way to know which from the radius alone; it is
// picked by the same rule a person uses when AutoCAD asks the same question:
// whichever solution's tangent points fall nearest the two points actually
// clicked.
// ---------------------------------------------------------------------------

// An infinite line's intersections with a circle, unlike segmentCircleIntersections
// (core/math.js), which clips to the a–b segment: a fillet's offset line is a
// construction line, not the edge itself, so it must extend past both ends.
function infiniteLineCircleIntersections(a, b, center, radius) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const qa = dx * dx + dy * dy;
  if (qa < CORNER_TOLERANCE || radius <= 0) return [];
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

// The loci a fillet-arc centre could sit at, at distance `radius` from this
// edge. A circle locus carries `sign`: the tangent point sits at
// center + sign*radius*unit(candidateCentre - center) — see
// circularTangentPoint(). That is +1 for the ordinary "outside" tangency and
// for the "this edge's circle swallows the fillet" nesting, and -1 only for
// the opposite nesting (the fillet swallows this edge's circle) — the one
// case where the tangent point sits on the far side of this edge's centre
// from the candidate fillet centre rather than the near side.
function offsetLoci(ref, radius) {
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
  if (nested > CORNER_TOLERANCE) {
    loci.push({ kind: 'circle', center: ref.center, radius: nested, sign: radius > ref.radius ? -1 : 1 });
  }
  return loci;
}

function locusIntersections(first, second) {
  if (first.kind === 'line' && second.kind === 'line') {
    const point = infiniteLineIntersection(first.a, first.b, second.a, second.b);
    return point ? [point] : [];
  }
  if (first.kind === 'line') return infiniteLineCircleIntersections(first.a, first.b, second.center, second.radius);
  if (second.kind === 'line') return infiniteLineCircleIntersections(second.a, second.b, first.center, first.radius);
  return circleCircleIntersections(first, second);
}

function circularTangentPoint(ref, locus, candidateCenter) {
  const ux = candidateCenter.x - ref.center.x;
  const uy = candidateCenter.y - ref.center.y;
  const length = Math.hypot(ux, uy);
  if (length < CORNER_TOLERANCE) return null;
  const sign = locus.sign;
  return { x: ref.center.x + sign * ref.radius * ux / length, y: ref.center.y + sign * ref.radius * uy / length };
}

function edgeTangentPoint(ref, locus, candidateCenter) {
  return ref.kind === 'line'
    ? pointOnInfiniteLine(candidateCenter, ref.a, ref.b)
    : circularTangentPoint(ref, locus, candidateCenter);
}

// An ARC can only be trimmed to a tangent point that actually lies on its
// current sweep — extending an arc's angular span the way a line can be
// extended isn't supported. A CIRCLE has no sweep to fall outside of.
function tangentWithinSweep(ref, tangentPoint) {
  if (ref.kind !== 'circle' || !isArc(ref.entity)) return true;
  const angle = unwrappedArcAngle(angleFromCenter(ref.entity.center, tangentPoint), ref.entity);
  return angle >= ref.entity.startAngle - 1e-7 && angle <= ref.entity.endAngle + 1e-7;
}

// Moves whichever of an ARC's two endpoints is nearer the tangent point to
// sit exactly on it — the other endpoint, on the same side as the pick,
// stays put. A CIRCLE is returned untouched: it has no endpoint to move.
function updateCircularEdge(ref, pick, tangentPoint) {
  const entity = ref.entity;
  if (!isArc(entity)) return entity;
  const tangentAngle = unwrappedArcAngle(angleFromCenter(entity.center, tangentPoint), entity);
  const pickAngle = unwrappedArcAngle(angleFromCenter(entity.center, pick), entity);
  return pickAngle >= tangentAngle
    ? { ...entity, startAngle: tangentAngle }
    : { ...entity, endAngle: tangentAngle };
}

function filletCurved(ref1, ref2, pickFirst, pickSecond, radius) {
  if (radius <= 0) {
    return { error: 'FILLET needs a radius greater than zero when an arc or circle is involved.' };
  }
  const loci1 = offsetLoci(ref1, radius);
  const loci2 = offsetLoci(ref2, radius);
  let best = null;
  for (const locus1 of loci1) {
    for (const locus2 of loci2) {
      for (const center of locusIntersections(locus1, locus2)) {
        const t1 = edgeTangentPoint(ref1, locus1, center);
        const t2 = edgeTangentPoint(ref2, locus2, center);
        if (!t1 || !t2 || !tangentWithinSweep(ref1, t1) || !tangentWithinSweep(ref2, t2)) continue;
        const score = dist(t1, pickFirst) + dist(t2, pickSecond);
        if (!best || score < best.score) best = { center, t1, t2, score };
      }
    }
  }
  if (!best) return { error: 'That radius does not fit here.' };

  const { center, t1, t2 } = best;
  let startAngle = angleFromCenter(center, t1);
  let sweep = normalizeAngle(angleFromCenter(center, t2) - startAngle);
  if (sweep > Math.PI) {
    startAngle = angleFromCenter(center, t2);
    sweep = TAU - sweep;
  }
  if (sweep <= 1e-8) return { error: 'That radius does not fit here.' };

  const updated = [];
  for (const [ref, point, pick] of [[ref1, t1, pickFirst], [ref2, t2, pickSecond]]) {
    if (ref.kind === 'line') {
      const arm = cornerArm({ a: ref.a, b: ref.b }, point, pick);
      if (!arm) return { error: 'A line with no length has no direction to work from.' };
      updated.push(updateEdgeEndpoint(ref, arm, point));
    } else if (isArc(ref.entity)) {
      updated.push(updateCircularEdge(ref, pick, point));
    }
  }

  return {
    updated,
    addition: {
      type: 'ARC',
      layerId: cornerLayerId(ref1, ref2),
      center,
      radius,
      startAngle,
      endAngle: startAngle + sweep,
    },
  };
}

export function filletCorner(ref1, ref2, pickFirst, pickSecond, radius) {
  if (ref1.kind === 'circle' || ref2.kind === 'circle') {
    return filletCurved(ref1, ref2, pickFirst, pickSecond, radius);
  }
  const frame = cornerFrame(ref1, ref2, pickFirst, pickSecond);
  if (frame.error) return frame;
  const { corner, arm1, arm2, included } = frame;

  const half = included / 2;
  // Distance back from the corner to where the arc becomes tangent. At radius
  // zero this is zero and the edges meet at the corner with no arc at all.
  const tangent = radius > 0 ? radius / Math.tan(half) : 0;
  if (!Number.isFinite(tangent)) return { error: 'That radius does not fit this corner.' };
  if (tangent > arm1.reach + CORNER_TOLERANCE || tangent > arm2.reach + CORNER_TOLERANCE) {
    return { error: 'That radius is too large for these lines.' };
  }

  const shared = sharedVertexIndex(ref1, ref2);
  if (shared !== null && radius > 0) {
    return { error: "That polyline corner can't be filleted — polylines here can't hold a curved segment. Try CHAMFER, or fillet two separate lines instead." };
  }

  const t1 = { x: corner.x + tangent * arm1.direction.x, y: corner.y + tangent * arm1.direction.y };
  const t2 = { x: corner.x + tangent * arm2.direction.x, y: corner.y + tangent * arm2.direction.y };

  if (radius <= 0) {
    const updated = shared !== null
      ? [spliceEntity(ref1, ref2, shared, t1, t2)]
      : buildIndependentUpdates(ref1, arm1, t1, ref2, arm2, t2);
    return { updated, addition: null };
  }

  // The centre sits on the bisector of the kept sides, far enough along it
  // that the perpendicular distance to each edge is exactly the radius.
  const bisectorX = arm1.direction.x + arm2.direction.x;
  const bisectorY = arm1.direction.y + arm2.direction.y;
  const bisectorLength = Math.hypot(bisectorX, bisectorY);
  if (bisectorLength < CORNER_TOLERANCE) return { error: 'That radius does not fit this corner.' };
  const offset = radius / Math.sin(half);
  const center = {
    x: corner.x + offset * bisectorX / bisectorLength,
    y: corner.y + offset * bisectorY / bisectorLength,
  };

  // Arcs are stored counter-clockwise, so whichever tangent point comes first
  // going that way becomes the start; the fillet is always the short way
  // round, never the reflex remainder.
  let startAngle = angleFromCenter(center, t1);
  let sweep = normalizeAngle(angleFromCenter(center, t2) - startAngle);
  if (sweep > Math.PI) {
    startAngle = angleFromCenter(center, t2);
    sweep = TAU - sweep;
  }
  if (sweep <= 1e-8) return { error: 'That radius does not fit this corner.' };

  return {
    updated: buildIndependentUpdates(ref1, arm1, t1, ref2, arm2, t2),
    addition: {
      type: 'ARC',
      layerId: cornerLayerId(ref1, ref2),
      center,
      radius,
      startAngle,
      endAngle: startAngle + sweep,
    },
  };
}

export function chamferCorner(ref1, ref2, pickFirst, pickSecond, firstDistance, secondDistance) {
  const frame = cornerFrame(ref1, ref2, pickFirst, pickSecond);
  if (frame.error) return frame;
  const { corner, arm1, arm2 } = frame;
  if (firstDistance > arm1.reach + CORNER_TOLERANCE || secondDistance > arm2.reach + CORNER_TOLERANCE) {
    return { error: 'Those chamfer distances are too large for these lines.' };
  }

  const t1 = { x: corner.x + firstDistance * arm1.direction.x, y: corner.y + firstDistance * arm1.direction.y };
  const t2 = { x: corner.x + secondDistance * arm2.direction.x, y: corner.y + secondDistance * arm2.direction.y };

  const shared = sharedVertexIndex(ref1, ref2);
  if (shared !== null) {
    // The cut is already the polyline's own new edge between the two points;
    // a separate LINE bridging them would just duplicate it.
    return { updated: [spliceEntity(ref1, ref2, shared, t1, t2)], addition: null };
  }

  const updated = buildIndependentUpdates(ref1, arm1, t1, ref2, arm2, t2);
  // Both distances zero is the same corner-close FILLET 0 performs, and there
  // is no cut line to draw between two coincident points.
  if (firstDistance <= 0 && secondDistance <= 0) return { updated, addition: null };
  return { updated, addition: { type: 'LINE', layerId: cornerLayerId(ref1, ref2), a: t1, b: t2 } };
}

// Which edge the cursor is over, refusing anything that is not a line or
// polyline segment (or, for FILLET only, an arc or circle) by name so the
// reason is visible rather than the click just doing nothing.
export function cornerPick(world, excludedIds = null) {
  const hit = hitTestSegment(world, 10, excludedIds, true);
  if (!hit) return { error: 'No line there. Click a line.' };
  const entity = hit.entity;
  const type = state.edit?.type || 'FILLET';
  const allowCircular = type === 'FILLET';
  if (!['LINE', 'PLINE'].includes(entity.type) && !(allowCircular && ['ARC', 'CIRCLE'].includes(entity.type))) {
    const allowed = allowCircular ? 'lines, polyline segments, arcs and circles' : 'lines and polyline segments';
    return { error: `${type} works on ${allowed}; that is a ${entity.type}.` };
  }
  if (!isEntityEditable(entity)) return { error: 'That line is on a locked or hidden layer.' };
  return { entity, point: hit.point, segmentIndex: hit.segmentIndex };
}

export function applyCorner(secondPick) {
  const operation = state.edit;
  if (!operation || !['FILLET', 'CHAMFER'].includes(operation.type)) return;

  const picked = cornerPick(secondPick);
  if (picked.error) {
    updatePrompt(picked.error);
    draw();
    return;
  }
  const first = state.entities.find(entity => entity.id === operation.firstId);
  if (!first) {
    resetCornerPick('The first line is no longer in the drawing.');
    return;
  }
  if (picked.entity.id === first.id && picked.segmentIndex === operation.firstSegmentIndex) {
    updatePrompt('Pick a second, different line or segment.');
    draw();
    return;
  }

  const ref1 = edgeRef(first, operation.firstSegmentIndex);
  const ref2 = edgeRef(picked.entity, picked.segmentIndex);
  const result = operation.type === 'FILLET'
    ? filletCorner(ref1, ref2, operation.firstPoint, picked.point, operation.radius)
    : chamferCorner(ref1, ref2, operation.firstPoint, picked.point, operation.firstDistance, operation.secondDistance);
  if (result.error) {
    resetCornerPick(result.error);
    return;
  }

  const replaced = new Map(result.updated.map(entity => [entity.id, entity]));
  const entities = state.entities.map(entity => replaced.get(entity.id) || entity);
  if (result.addition) {
    if (!commitGeometry([...entities, { ...result.addition, id: state.nextId }], { nextId: state.nextId + 1 })) return;
  } else if (!commitGeometry(entities)) {
    return;
  }
  resetCornerPick();
}

// Back to waiting for a first line, so corners can be cleaned up one after
// another without retyping the command — the same repeat-until-dismissed shape
// TRIM and EXTEND already use. A refusal passes its reason through here rather
// than announcing it first, because resetting the stage rewrites the prompt
// and would otherwise wipe the explanation before it could be read.
export function resetCornerPick(message) {
  if (!state.edit) return;
  state.edit.stage = 'FIRST';
  state.edit.firstId = null;
  state.edit.firstSegmentIndex = null;
  state.edit.firstPoint = null;
  updatePrompt(message);
  draw();
}
