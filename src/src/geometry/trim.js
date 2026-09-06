import { TAU } from '../core/constants.js';
import { angleFromCenter, circularEntityIntersections, segmentCircularIntersections, unwrappedArcAngle } from '../core/math.js';
import { buildTrimPieces, editBoundarySegments, hitTestSegment, makeArc, pathPointsBetween, segmentIntersectionParameters } from './edgeEdit.js';
import { commitGeometry } from '../model/document.js';
import { entitySegments, polylineHasBulges } from '../model/entity.js';
import { state } from '../state.js';
import { updatePrompt } from '../ui/prompt.js';
import { draw } from '../view/frame.js';

export function calculateCircularTrimOperation(hit, boundaries) {
  const entity = hit.entity;
  const intersectionAngles = [];
  for (const boundary of boundaries) {
    const points = boundary.kind === 'SEGMENT'
      ? segmentCircularIntersections(boundary.a, boundary.b, entity).map(result => result.point)
      : circularEntityIntersections(entity, boundary);
    for (const point of points) intersectionAngles.push(angleFromCenter(entity.center, point));
  }

  if (entity.type === 'CIRCLE') {
    intersectionAngles.sort((a, b) => a - b);
    const unique = intersectionAngles.filter((angle, index) =>
      index === 0 || Math.abs(angle - intersectionAngles[index - 1]) > 1e-7,
    );
    if (unique.length < 2) return { error: 'A circle needs two cutting intersections to trim.' };

    const clickAngle = hit.angle;
    let previous = [...unique].reverse().find(angle => angle <= clickAngle + 1e-9);
    let next = unique.find(angle => angle > clickAngle + 1e-9);
    if (previous === undefined) previous = unique[unique.length - 1] - TAU;
    if (next === undefined) next = unique[0] + TAU;
    const removedSweep = next - previous;
    const kept = makeArc(entity, next, next + TAU - removedSweep);
    if (!kept) return { error: 'Those cutting intersections do not leave a valid arc.' };
    return {
      hit,
      removeArc: makeArc(entity, previous, next),
      pieces: [kept],
    };
  }

  const start = entity.startAngle;
  const end = entity.endAngle;
  const interior = intersectionAngles
    .map(angle => unwrappedArcAngle(angle, entity))
    .filter(angle => angle > start + 1e-8 && angle < end - 1e-8)
    .sort((a, b) => a - b)
    .filter((angle, index, values) => index === 0 || Math.abs(angle - values[index - 1]) > 1e-7);
  if (!interior.length) return { error: 'No cutting boundary intersects that arc.' };

  const clickAngle = unwrappedArcAngle(hit.angle, entity);
  const limits = [start, ...interior, end];
  let interval = 0;
  for (let index = 0; index < limits.length - 1; index++) {
    if (clickAngle >= limits[index] - 1e-9 && clickAngle <= limits[index + 1] + 1e-9) {
      interval = index;
      break;
    }
  }
  const removeStart = limits[interval];
  const removeEnd = limits[interval + 1];
  const pieces = [
    makeArc(entity, start, removeStart),
    makeArc(entity, removeEnd, end),
  ].filter(Boolean);
  return {
    hit,
    removeArc: makeArc(entity, removeStart, removeEnd),
    pieces,
  };
}

export function calculateTrimOperation(world) {
  const excludedIds = state.edit?.boundaryIds ? new Set(state.edit.boundaryIds) : null;
  const hit = hitTestSegment(world, 10, excludedIds, true);
  if (!hit) return { error: 'Click the portion of a line, polyline, circle, or arc to trim.' };
  const includeSelfIntersections = !state.edit?.boundaryIds;
  const boundaries = editBoundarySegments(hit.entity.id, includeSelfIntersections);
  if (hit.kind === 'CIRCULAR') return calculateCircularTrimOperation(hit, boundaries);
  // Trimming rebuilds a polyline from a list of points, which has nowhere to
  // put a curve. Refusing the whole polyline rather than just its curved
  // segments is deliberate: a piece cut from a straight segment still has to
  // carry the rest of the shape, arcs included.
  if (polylineHasBulges(hit.entity)) {
    return { error: 'That polyline has a curved segment, which TRIM cannot rebuild. EXPLODE it first.' };
  }

  const segmentCount = entitySegments(hit.entity).length;
  const intersections = [];

  for (const boundary of boundaries) {
    if (boundary.kind === 'SEGMENT' && boundary.entityId === hit.entity.id) {
      if (boundary.segmentIndex === hit.segmentIndex) continue;
      const separation = Math.abs(boundary.segmentIndex - hit.segmentIndex);
      const adjacent = separation === 1 || (hit.entity.closed && separation === segmentCount - 1);
      if (adjacent) continue;
    }
    if (boundary.kind === 'CIRCLE' || boundary.kind === 'ARC') {
      for (const detail of segmentCircularIntersections(hit.a, hit.b, boundary)) {
        if (detail.t > 1e-8 && detail.t < 1 - 1e-8) intersections.push(detail.t);
      }
    } else {
      const detail = segmentIntersectionParameters(hit.a, hit.b, boundary.a, boundary.b);
      if (detail && detail.t > 1e-8 && detail.t < 1 - 1e-8) intersections.push(detail.t);
    }
  }
  intersections.sort((a, b) => a - b);
  const unique = intersections.filter((value, index) => index === 0 || Math.abs(value - intersections[index - 1]) > 1e-7);
  if (!unique.length && hit.entity.type === 'LINE') return { error: 'No cutting boundary intersects that line.' };

  let previousIntersection = null;
  let nextIntersection = null;
  for (const position of unique) {
    if (position <= hit.t + 1e-9) previousIntersection = position;
    else if (nextIntersection === null) nextIntersection = position;
  }
  const pathStart = hit.segmentIndex + (previousIntersection ?? 0);
  const pathEnd = hit.segmentIndex + (nextIntersection ?? 1);
  return {
    hit,
    pathStart,
    pathEnd,
    removePoints: pathPointsBetween(hit.entity, pathStart, pathEnd),
    pieces: buildTrimPieces(hit.entity, pathStart, pathEnd),
  };
}

export function replaceEditedEntity(entity, replacements) {
  const entityIndex = state.entities.findIndex(candidate => candidate.id === entity.id);
  if (entityIndex < 0) return;
  let nextId = state.nextId;
  const assigned = replacements.map((replacement, index) => ({
    ...replacement,
    id: index === 0 ? entity.id : nextId++,
  }));
  const entities = state.entities.slice();
  entities.splice(entityIndex, 1, ...assigned);
  if (!commitGeometry(entities, { nextId })) return false;
  state.selected.clear();
  updatePrompt();
  draw();
}

export function trimAt(world) {
  const operation = calculateTrimOperation(world);
  if (operation.error) {
    updatePrompt(operation.error);
    draw();
    return;
  }
  replaceEditedEntity(operation.hit.entity, operation.pieces);
}
