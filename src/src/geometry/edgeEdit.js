import { setMode } from '../commands/registry.js';
import { TAU } from '../core/constants.js';
import { angleFromCenter, angleOnArc, circularPoint, dist, normalizeAngle, pointAlong, pointOnCircularEntity } from '../core/math.js';
import { entitySegments, withPolylineBulges } from '../model/entity.js';
import { isEntityEditable, isEntityVisible } from '../model/layerQuery.js';
import { state } from '../state.js';
import { worldToScreen } from '../view/viewport.js';

export function finishEdgeEdit() {
  state.selected.clear();
  setMode('SELECT');
}

export function hitTestSegment(world, maxPx = 10, excludedIds = null, includeCircular = false) {
  const cursor = worldToScreen(world);
  let best = null;
  for (const entity of state.entities) {
    if (excludedIds?.has(entity.id) || !isEntityEditable(entity)) continue;
    const segments = entitySegments(entity);
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
      const [a, b, arc] = segments[segmentIndex];
      let t;
      let point;
      if (arc) {
        // A curved segment answers where the cursor sits along the arc, not
        // along its chord; off the sweep entirely it is simply not hit, the
        // same rule a standalone ARC follows below.
        const angle = angleFromCenter(arc.center, world);
        if (!angleOnArc(angle, arc)) continue;
        const travelled = arc.sweep > 0
          ? normalizeAngle(angle - arc.angleA)
          : normalizeAngle(arc.angleA - angle);
        t = Math.max(0, Math.min(1, travelled / Math.abs(arc.sweep)));
        point = circularPoint(arc.center, arc.radius, angle);
      } else {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lengthSquared = dx * dx + dy * dy;
        if (lengthSquared < 1e-12) continue;
        t = Math.max(0, Math.min(1, ((world.x - a.x) * dx + (world.y - a.y) * dy) / lengthSquared));
        point = { x: a.x + t * dx, y: a.y + t * dy };
      }
      const screen = worldToScreen(point);
      const px = Math.hypot(screen.x - cursor.x, screen.y - cursor.y);
      if (px <= maxPx && (!best || px < best.px)) {
        best = { entity, kind: 'SEGMENT', segmentIndex, a, b, arc, t, point, px };
      }
    }
    if (includeCircular && ['CIRCLE', 'ARC'].includes(entity.type)) {
      const angle = angleFromCenter(entity.center, world);
      if (pointOnCircularEntity(world, entity)) {
        const point = circularPoint(entity.center, entity.radius, angle);
        const px = dist(world, point) * state.view.scale;
        if (px <= maxPx && (!best || px < best.px)) {
          best = { entity, kind: 'CIRCULAR', angle, point, px };
        }
      }
    }
  }
  return best;
}

export function editBoundarySegments(targetId, includeTarget = false) {
  const limitedIds = state.edit?.boundaryIds ? new Set(state.edit.boundaryIds) : null;
  const boundaries = [];
  for (const entity of state.entities) {
    if (!isEntityVisible(entity) || (!includeTarget && entity.id === targetId) || (limitedIds && !limitedIds.has(entity.id))) continue;
    if (entity.type === 'CIRCLE' || entity.type === 'ARC') {
      boundaries.push({
        kind: entity.type,
        entityId: entity.id,
        center: entity.center,
        radius: entity.radius,
        ...(entity.type === 'ARC' ? { startAngle: entity.startAngle, endAngle: entity.endAngle } : {}),
      });
      continue;
    }
    const segments = entitySegments(entity);
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
      const [a, b, arc] = segments[segmentIndex];
      // A polyline's curved segment cuts as an arc, so it is offered in the
      // same shape a standalone ARC is above rather than as its chord.
      if (arc) {
        boundaries.push({
          kind: 'ARC', entityId: entity.id, segmentIndex,
          center: arc.center, radius: arc.radius, startAngle: arc.startAngle, endAngle: arc.endAngle,
        });
      } else {
        boundaries.push({ kind: 'SEGMENT', entityId: entity.id, segmentIndex, a, b });
      }
    }
  }
  return boundaries;
}

export function segmentIntersectionParameters(a, b, c, d) {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-10) return null;
  const ca = { x: c.x - a.x, y: c.y - a.y };
  const t = (ca.x * s.y - ca.y * s.x) / den;
  const u = (ca.x * r.y - ca.y * r.x) / den;
  const eps = 1e-9;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return {
    t: Math.max(0, Math.min(1, t)),
    u: Math.max(0, Math.min(1, u)),
    point: { x: a.x + t * r.x, y: a.y + t * r.y },
  };
}


export function appendDistinct(points, point) {
  if (!points.length || dist(points[points.length - 1], point) > 1e-8) points.push({ ...point });
}

export function cleanPointPath(points) {
  const cleaned = [];
  for (const point of points) appendDistinct(cleaned, point);
  return cleaned;
}

export function trimPieceFromPoints(entity, points) {
  const cleaned = cleanPointPath(points);
  if (cleaned.length < 2) return null;
  const length = cleaned.slice(1).reduce((sum, point, index) => sum + dist(cleaned[index], point), 0);
  if (length < 1e-8) return null;
  if (entity.type === 'LINE') return { ...entity, a: cleaned[0], b: cleaned[cleaned.length - 1] };
  // A trimmed piece is rebuilt from points alone, so any curve the source
  // carried is not one of them. TRIM refuses a curved polyline outright (see
  // calculateTrimOperation) precisely so this never silently straightens one;
  // clearing the array here keeps that guarantee local rather than remote.
  return withPolylineBulges({ ...entity, points: cleaned, closed: false }, cleaned.map(() => 0));
}

export function pointAtPathPosition(entity, position) {
  const segments = entitySegments(entity);
  const count = segments.length;
  if (!count) return null;
  let normalized = position;
  if (entity.closed) {
    normalized = ((position % count) + count) % count;
  } else {
    normalized = Math.max(0, Math.min(count, position));
    if (normalized >= count) return { ...segments[count - 1][1] };
  }
  const segmentIndex = Math.min(count - 1, Math.floor(normalized));
  return pointAlong(segments[segmentIndex][0], segments[segmentIndex][1], normalized - segmentIndex);
}

export function pathPointsBetween(entity, start, end) {
  const points = [];
  appendDistinct(points, pointAtPathPosition(entity, start));
  for (let vertex = Math.floor(start + 1e-9) + 1; vertex < end - 1e-9; vertex++) {
    appendDistinct(points, pointAtPathPosition(entity, vertex));
  }
  appendDistinct(points, pointAtPathPosition(entity, end));
  return points;
}

export function buildTrimPieces(entity, pathStart, pathEnd) {
  const segmentCount = entitySegments(entity).length;
  const rawPieces = [];

  if (entity.closed) {
    rawPieces.push(pathPointsBetween(entity, pathEnd, pathStart + segmentCount));
  } else {
    if (pathStart > 1e-8) rawPieces.push(pathPointsBetween(entity, 0, pathStart));
    if (pathEnd < segmentCount - 1e-8) rawPieces.push(pathPointsBetween(entity, pathEnd, segmentCount));
  }

  return rawPieces.map(points => trimPieceFromPoints(entity, points)).filter(Boolean);
}

export function makeArc(entity, startAngle, endAngle) {
  const sweep = endAngle - startAngle;
  if (sweep <= 1e-8 || sweep >= TAU - 1e-8) return null;
  const normalizedStart = normalizeAngle(startAngle);
  return {
    ...entity,
    type: 'ARC',
    center: { ...entity.center },
    startAngle: normalizedStart,
    endAngle: normalizedStart + sweep,
  };
}
