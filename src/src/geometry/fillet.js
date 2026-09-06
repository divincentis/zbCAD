import { TAU } from '../core/constants.js';
import { angleFromCenter, bulgeForArc, dist, isArc, normalizeAngle, unwrappedArcAngle } from '../core/math.js';
import { hitTestSegment } from './edgeEdit.js';
import { infiniteLineIntersection } from './offset.js';
import { edgeRef, tangentCircleSolutions } from './tangentCircle.js';
import { commitGeometry } from '../model/history.js';
import { polylineBulgeList, withPolylineBulges } from '../model/entity.js';
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
// An "edge" is a LINE entity or one segment of a PLINE — see edgeRef() in
// tangentCircle.js. The two edges are ordinarily two different entities, each
// trimmed or extended by rewriting its own endpoint. When they are instead the
// two segments either side of one polyline vertex (the everyday "round this
// rectangle's corner" case), that shared vertex has to become two separate
// points rather than one — see sharedVertexIndex()/spliceEntity() — since it
// is the single point where both edges currently meet. Both operations write
// their result back into the polyline itself: a chamfer as the straight
// segment between the two new points, a fillet as that segment's bulge (see
// core/math.js). Either way the polyline stays one object, which is what
// rounding a rectangle's corner is supposed to leave you with.
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
// original geometry preserved. Neither works from a polyline segment that is
// already curved: a rounded corner has no straight direction to build the next
// one from, and that is refused by name too — see cornerPick().
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
//
// `arc` names the fillet circle the new segment should follow, or null for a
// chamfer's straight cut. The new segment takes the vertex's own index, so the
// segment that used to leave this vertex shifts along by one and every bulge
// after it moves with it.
export function spliceEntity(ref1, ref2, sharedIndex, t1, t2, arc = null) {
  const [into, outOf] = ref1.pointIndexB === sharedIndex ? [t1, t2] : [t2, t1];
  const points = ref1.entity.points.map(point => ({ ...point }));
  const bulges = polylineBulgeList(ref1.entity);
  if (dist(into, outOf) < CORNER_TOLERANCE) {
    points[sharedIndex] = into;
    return withPolylineBulges({ ...ref1.entity, points }, bulges);
  }
  points.splice(sharedIndex, 1, into, outOf);
  bulges.splice(sharedIndex, 0, arc ? filletBulge(arc.center, into, outOf) : 0);
  return withPolylineBulges({ ...ref1.entity, points }, bulges);
}

// The bulge of a fillet arc travelled from `into` to `outOf`. A fillet never
// sweeps more than half a turn, so the sign of the cross product settles the
// direction outright: positive means the short way round is counter-clockwise.
export function filletBulge(center, into, outOf) {
  const cross = (into.x - center.x) * (outOf.y - center.y) -
    (into.y - center.y) * (outOf.x - center.x);
  return bulgeForArc(
    center,
    angleFromCenter(center, into),
    angleFromCenter(center, outOf),
    cross > 0,
  );
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
// There is no single "corner" to bisect when a curve is involved: a line and a
// circle can cross twice or not at all. The construction that answers it
// instead — every circle of the given radius tangent to both edges — lives in
// tangentCircle.js, because CIRCLE's Ttr option asks precisely the same
// question and keeps the whole circle rather than an arc of it. What is left
// here is only what makes an answer a *fillet*: the tangent point has to land
// on the arc's actual sweep, and the arc that survives is the short way round
// between the two contact points.
// ---------------------------------------------------------------------------

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
  let best = null;
  for (const { center, t1, t2 } of tangentCircleSolutions(ref1, ref2, radius)) {
    if (!tangentWithinSweep(ref1, t1) || !tangentWithinSweep(ref2, t2)) continue;
    const score = dist(t1, pickFirst) + dist(t2, pickSecond);
    if (!best || score < best.score) best = { center, t1, t2, score };
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

  // Two segments of one polyline round into that polyline: the arc becomes the
  // bulge of the new segment between the tangent points, exactly where the
  // chamfer's straight cut would have gone. A separate ARC entity is only for
  // edges that belong to different objects and have nothing to write into.
  if (shared !== null) {
    return { updated: [spliceEntity(ref1, ref2, shared, t1, t2, { center })], addition: null };
  }

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
  // The corner maths below works from a straight edge's direction, which a
  // curved polyline segment does not have. Filleting against one would mean
  // treating an already-rounded corner as its chord, so it is refused by name.
  if (hit.arc) {
    return { error: `That polyline segment is already curved; ${type} works from its straight segments.` };
  }
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
