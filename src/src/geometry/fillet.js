import { TAU } from '../core/constants.js';
import { angleFromCenter, normalizeAngle } from '../core/math.js';
import { hitTestSegment } from './edgeEdit.js';
import { infiniteLineIntersection } from './offset.js';
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
// Only LINE/LINE corners are handled. Arcs, circles and polyline segments are
// refused by name rather than quietly skipped, per the roadmap's rule that an
// unsupported case is reported and the original geometry preserved.
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

export function filletCorner(first, second, pickFirst, pickSecond, radius) {
  const frame = cornerFrame(first, second, pickFirst, pickSecond);
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

  const t1 = { x: corner.x + tangent * arm1.direction.x, y: corner.y + tangent * arm1.direction.y };
  const t2 = { x: corner.x + tangent * arm2.direction.x, y: corner.y + tangent * arm2.direction.y };

  const edges = [
    { ...first, a: { ...arm1.far }, b: t1 },
    { ...second, a: { ...arm2.far }, b: t2 },
  ];
  if (radius <= 0) return { edges, arc: null };

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
    edges,
    arc: {
      type: 'ARC',
      layerId: cornerLayerId(first, second),
      center,
      radius,
      startAngle,
      endAngle: startAngle + sweep,
    },
  };
}

export function chamferCorner(first, second, pickFirst, pickSecond, firstDistance, secondDistance) {
  const frame = cornerFrame(first, second, pickFirst, pickSecond);
  if (frame.error) return frame;
  const { corner, arm1, arm2 } = frame;
  if (firstDistance > arm1.reach + CORNER_TOLERANCE || secondDistance > arm2.reach + CORNER_TOLERANCE) {
    return { error: 'Those chamfer distances are too large for these lines.' };
  }

  const t1 = { x: corner.x + firstDistance * arm1.direction.x, y: corner.y + firstDistance * arm1.direction.y };
  const t2 = { x: corner.x + secondDistance * arm2.direction.x, y: corner.y + secondDistance * arm2.direction.y };
  const edges = [
    { ...first, a: { ...arm1.far }, b: t1 },
    { ...second, a: { ...arm2.far }, b: t2 },
  ];
  // Both distances zero is the same corner-close FILLET 0 performs, and there
  // is no cut line to draw between two coincident points.
  if (firstDistance <= 0 && secondDistance <= 0) return { edges, cut: null };
  return {
    edges,
    cut: { type: 'LINE', layerId: cornerLayerId(first, second), a: t1, b: t2 },
  };
}

// Which edge the cursor is over, refusing anything that is not a plain line by
// name so the reason is visible rather than the click just doing nothing.
export function cornerPick(world, excludedIds = null) {
  const hit = hitTestSegment(world, 10, excludedIds, true);
  if (!hit) return { error: 'No line there. Click a line.' };
  const entity = hit.entity;
  if (entity.type !== 'LINE') {
    return { error: `${state.edit?.type || 'FILLET'} works on two lines; that is a ${entity.type}.` };
  }
  if (!isEntityEditable(entity)) return { error: 'That line is on a locked or hidden layer.' };
  return { entity, point: hit.point };
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
  if (picked.entity.id === first.id) {
    updatePrompt('Pick a second, different line.');
    draw();
    return;
  }

  const result = operation.type === 'FILLET'
    ? filletCorner(first, picked.entity, operation.firstPoint, picked.point, operation.radius)
    : chamferCorner(
      first, picked.entity, operation.firstPoint, picked.point,
      operation.firstDistance, operation.secondDistance,
    );
  if (result.error) {
    resetCornerPick(result.error);
    return;
  }

  const replaced = new Map(result.edges.map(edge => [edge.id, edge]));
  const entities = state.entities.map(entity => replaced.get(entity.id) || entity);
  const addition = result.arc || result.cut;
  if (addition) {
    if (!commitGeometry([...entities, { ...addition, id: state.nextId }], { nextId: state.nextId + 1 })) return;
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
  state.edit.firstPoint = null;
  updatePrompt(message);
  draw();
}
