import { TAU } from '../core/constants.js';
import { angleFromCenter, angleOnArc, arcSweep, circleCircleIntersections, circularPoint, dist, normalizeAngle, pointOnCircularEntity, segmentCircleIntersections } from '../core/math.js';
import { editBoundarySegments, makeArc } from './edgeEdit.js';
import { replaceEditedEntity } from './trim.js';
import { polylineBulge } from '../model/entity.js';
import { distanceToEntityPx } from '../interaction/selection.js';
import { isEntityEditable } from '../model/layerQuery.js';
import { state } from '../state.js';
import { updatePrompt } from '../ui/prompt.js';
import { draw } from '../view/frame.js';

export function raySegmentIntersection(origin, direction, a, b) {
  const segment = { x: b.x - a.x, y: b.y - a.y };
  const den = direction.x * segment.y - direction.y * segment.x;
  if (Math.abs(den) < 1e-10) return null;
  const ao = { x: a.x - origin.x, y: a.y - origin.y };
  const t = (ao.x * segment.y - ao.y * segment.x) / den;
  const u = (ao.x * direction.y - ao.y * direction.x) / den;
  if (t <= 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { t, point: { x: origin.x + t * direction.x, y: origin.y + t * direction.y } };
}

export function rayCircleIntersections(origin, direction, center, radius) {
  const dx = direction.x;
  const dy = direction.y;
  const fx = origin.x - center.x;
  const fy = origin.y - center.y;
  const qa = dx * dx + dy * dy;
  if (qa < 1e-12 || radius <= 0) return [];
  const qb = 2 * (fx * dx + fy * dy);
  const qc = fx * fx + fy * fy - radius * radius;
  const discriminant = qb * qb - 4 * qa * qc;
  if (discriminant < -1e-9) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  return [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)]
    .filter((t, index, values) => t > 1e-9 && (index === 0 || Math.abs(t - values[0]) > 1e-8))
    .map(t => ({ t, point: { x: origin.x + t * dx, y: origin.y + t * dy } }));
}

export function rayCircularIntersections(origin, direction, circularEntity) {
  return rayCircleIntersections(origin, direction, circularEntity.center, circularEntity.radius)
    .filter(intersection => pointOnCircularEntity(intersection.point, circularEntity));
}

export function circularExtensionIntersections(target, boundary) {
  if (boundary.kind === 'SEGMENT') {
    return segmentCircleIntersections(boundary.a, boundary.b, target.center, target.radius)
      .map(intersection => intersection.point);
  }
  return circleCircleIntersections(target, boundary)
    .filter(point => pointOnCircularEntity(point, boundary));
}

export function extendableEndpoints(entity) {
  if (entity.type === 'LINE') return [entity.a, entity.b];
  if (entity.type === 'PLINE' && !entity.closed && entity.points.length >= 2) {
    return [entity.points[0], entity.points[entity.points.length - 1]];
  }
  if (entity.type === 'ARC') {
    return [
      circularPoint(entity.center, entity.radius, entity.startAngle),
      circularPoint(entity.center, entity.radius, entity.endAngle),
    ];
  }
  return [];
}

export function hitTestExtendTarget(world, maxPx = 10, excludedIds = null) {
  let best = null;
  for (const entity of state.entities) {
    if (excludedIds?.has(entity.id) || !isEntityEditable(entity)) continue;
    const endpoints = extendableEndpoints(entity);
    if (!endpoints.length) continue;
    const geometryPx = distanceToEntityPx(world, entity);
    if (geometryPx > maxPx) continue;
    const endpointPx = Math.min(...endpoints.map(point => dist(world, point) * state.view.scale));

    let point = { ...world };
    if (entity.type === 'ARC') {
      const angle = angleFromCenter(entity.center, world);
      point = angleOnArc(angle, entity)
        ? circularPoint(entity.center, entity.radius, angle)
        : endpoints.reduce((nearest, endpoint) => dist(world, endpoint) < dist(world, nearest) ? endpoint : nearest);
    }

    const geometryTie = best && Math.abs(geometryPx - best.geometryPx) <= 0.75;
    const endpointTie = best && Math.abs(endpointPx - best.endpointPx) <= 0.1;
    const isBetter = !best || geometryPx < best.geometryPx - 0.75 ||
      (geometryTie && endpointPx < best.endpointPx - 0.1) ||
      (geometryTie && endpointTie && entity.type === 'ARC' && best.entity.type !== 'ARC');
    if (isBetter) best = { entity, point, world: { ...world }, geometryPx, endpointPx };
  }
  return best;
}

export function calculateArcExtendOperation(hit) {
  const entity = hit.entity;
  const startPoint = circularPoint(entity.center, entity.radius, entity.startAngle);
  const endPoint = circularPoint(entity.center, entity.radius, entity.endAngle);
  const extendStart = dist(hit.point, startPoint) <= dist(hit.point, endPoint);
  const activeEndpoint = extendStart ? startPoint : endPoint;
  const availableSweep = TAU - arcSweep(entity);
  if (availableSweep <= 1e-8) return { error: 'That arc has no remaining sweep to extend.' };
  const endpointTolerance = Math.max(1e-7, entity.radius * 1e-7);
  const angularTolerance = endpointTolerance / entity.radius;

  let nearest = null;
  for (const boundary of editBoundarySegments(entity.id)) {
    const intersections = circularExtensionIntersections(entity, boundary);
    // A boundary already containing this endpoint is the satisfied boundary.
    // Skip the entity, not merely the coincident point, so EX advances to the
    // next distinct element instead of finding the far side of the same one.
    if (intersections.some(point => dist(point, activeEndpoint) <= endpointTolerance)) continue;
    for (const point of intersections) {
      const angle = angleFromCenter(entity.center, point);
      const delta = extendStart
        ? normalizeAngle(entity.startAngle - angle)
        : normalizeAngle(angle - entity.endAngle);
      if (delta <= angularTolerance || delta >= availableSweep - angularTolerance) continue;
      if (!nearest || delta < nearest.delta) nearest = { delta, point, angle };
    }
  }
  if (!nearest) return { error: 'No boundary intersects that arc extension direction.' };

  const result = extendStart
    ? makeArc(entity, entity.startAngle - nearest.delta, entity.endAngle)
    : makeArc(entity, entity.startAngle, entity.endAngle + nearest.delta);
  return result ? { hit, result } : { error: 'That extension would close or invalidate the arc.' };
}

export function calculateExtendOperation(world) {
  const excludedIds = state.edit?.boundaryIds ? new Set(state.edit.boundaryIds) : null;
  const hit = hitTestExtendTarget(world, 10, excludedIds);
  if (!hit) return { error: 'Click a line, open polyline, or arc near the end to extend.' };
  if (hit.entity.type === 'ARC') return calculateArcExtendOperation(hit);
  if (hit.entity.type === 'PLINE' && hit.entity.closed) return { error: 'A closed polyline has no endpoint to extend.' };

  const points = hit.entity.type === 'LINE'
    ? [hit.entity.a, hit.entity.b]
    : hit.entity.points;
  if (points.length < 2) return { error: 'That entity has no extendable endpoint.' };
  const extendStart = dist(world, points[0]) <= dist(world, points[points.length - 1]);
  const endpointIndex = extendStart ? 0 : points.length - 1;
  // An extension runs along the end segment's own direction, and a curved
  // segment's direction is its tangent rather than its chord — a different
  // operation (growing the arc's sweep) than the one below.
  if (hit.entity.type === 'PLINE' &&
      polylineBulge(hit.entity, extendStart ? 0 : points.length - 2) !== 0) {
    return { error: 'That end of the polyline is curved; EXTEND works from a straight end.' };
  }
  const adjacentIndex = extendStart ? 1 : points.length - 2;
  const origin = points[endpointIndex];
  const adjacent = points[adjacentIndex];
  const direction = { x: origin.x - adjacent.x, y: origin.y - adjacent.y };
  if (Math.hypot(direction.x, direction.y) < 1e-9) return { error: 'The selected endpoint has no valid direction.' };

  let nearest = null;
  for (const boundary of editBoundarySegments(hit.entity.id)) {
    const intersections = boundary.kind === 'CIRCLE' || boundary.kind === 'ARC'
      ? rayCircularIntersections(origin, direction, boundary)
      : [raySegmentIntersection(origin, direction, boundary.a, boundary.b)].filter(Boolean);
    for (const intersection of intersections) {
      if (!nearest || intersection.t < nearest.t) nearest = intersection;
    }
  }
  if (!nearest) return { error: 'No boundary intersects that extension direction.' };

  let result;
  if (hit.entity.type === 'LINE') {
    result = {
      ...hit.entity,
      a: extendStart ? nearest.point : { ...hit.entity.a },
      b: extendStart ? { ...hit.entity.b } : nearest.point,
    };
  } else {
    const extendedPoints = hit.entity.points.map(point => ({ ...point }));
    extendedPoints[endpointIndex] = nearest.point;
    result = { ...hit.entity, points: extendedPoints, closed: false };
  }
  return { hit, result };
}

export function extendAt(world) {
  const operation = calculateExtendOperation(world);
  if (operation.error) {
    updatePrompt(operation.error);
    draw();
    return;
  }
  replaceEditedEntity(operation.hit.entity, [operation.result]);
}
