import { setMode } from '../commands/registry.js';
import { dist, pointOnSegmentClosest } from '../core/math.js';
import { cleanPoint, commitGeometry } from '../model/document.js';
import { entitySegments, polylineHasBulges } from '../model/entity.js';
import { isEntityEditable } from '../model/layerQuery.js';
import { state } from '../state.js';
import { updatePrompt } from '../ui/prompt.js';
import { draw } from '../view/frame.js';

export function infiniteLineIntersection(a, b, c, d) {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-10) return null;
  const ca = { x: c.x - a.x, y: c.y - a.y };
  const t = (ca.x * s.y - ca.y * s.x) / den;
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}

export function offsetSideSign(entity, sidePoint) {
  let best = null;
  for (const [a, b] of entitySegments(entity)) {
    const q = pointOnSegmentClosest(sidePoint, a, b);
    const gap = dist(sidePoint, q);
    if (!best || gap < best.gap) {
      const cross = (b.x - a.x) * (sidePoint.y - a.y) - (b.y - a.y) * (sidePoint.x - a.x);
      best = { gap, cross };
    }
  }
  if (!best || Math.abs(best.cross) < 1e-9) return 0;
  return best.cross > 0 ? 1 : -1;
}

export function shiftSegment(a, b, distance, side) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return null;
  const nx = -dy / length * distance * side;
  const ny = dx / length * distance * side;
  return [
    { x: a.x + nx, y: a.y + ny },
    { x: b.x + nx, y: b.y + ny },
  ];
}

export function joinedOffsetPoint(previous, current) {
  return infiniteLineIntersection(previous[0], previous[1], current[0], current[1]) || {
    x: (previous[1].x + current[0].x) / 2,
    y: (previous[1].y + current[0].y) / 2,
  };
}

// OFFSET currently produces one mitered path. If the correct result needs
// splitting or removing loops, refuse it instead of drawing a plausible but
// incorrect path. These checks also run for the preview.
export function pathSegments(points, closed) {
  return points.slice(0, closed ? points.length : -1)
    .map((point, index) => [point, points[(index + 1) % points.length]]);
}

export function segmentBoundsNear(a, b, c, d, tolerance) {
  return Math.min(a.x, b.x) <= Math.max(c.x, d.x) + tolerance &&
    Math.max(a.x, b.x) + tolerance >= Math.min(c.x, d.x) &&
    Math.min(a.y, b.y) <= Math.max(c.y, d.y) + tolerance &&
    Math.max(a.y, b.y) + tolerance >= Math.min(c.y, d.y);
}

export function segmentsMeet(a, b, c, d, tolerance) {
  if (!segmentBoundsNear(a, b, c, d, tolerance)) return false;
  if (dist(a, pointOnSegmentClosest(a, c, d)) <= tolerance ||
      dist(b, pointOnSegmentClosest(b, c, d)) <= tolerance ||
      dist(c, pointOnSegmentClosest(c, a, b)) <= tolerance ||
      dist(d, pointOnSegmentClosest(d, a, b)) <= tolerance) return true;
  const side = (p, q, r) => {
    const length = dist(p, q);
    return ((q.x - p.x) / length) * (r.y - p.y) -
      ((q.y - p.y) / length) * (r.x - p.x);
  };
  const opposite = (first, second) =>
    (first > tolerance && second < -tolerance) ||
    (first < -tolerance && second > tolerance);
  return opposite(side(a, b, c), side(a, b, d)) &&
    opposite(side(c, d, a), side(c, d, b));
}

export function pathHasCrossings(segments, closed, tolerance) {
  for (let i = 0; i < segments.length; i++) {
    const [a, b] = segments[i];
    if (dist(a, b) <= tolerance) return true;
    for (let j = i + 1; j < segments.length; j++) {
      const [c, d] = segments[j];
      const adjacent = j === i + 1 || (closed && i === 0 && j === segments.length - 1);
      if (adjacent) {
        // Adjacent edges may share their vertex, but cannot double back.
        const incoming = j === i + 1 ? a : b;
        const joint = j === i + 1 ? b : a;
        const outgoing = j === i + 1 ? d : c;
        if (dist(incoming, pointOnSegmentClosest(incoming, joint, outgoing)) <= tolerance ||
            dist(outgoing, pointOnSegmentClosest(outgoing, incoming, joint)) <= tolerance) return true;
      } else if (segmentsMeet(a, b, c, d, tolerance)) return true;
    }
  }
  return false;
}

export function offsetPathIsValid(source, result, closed, distance) {
  if (result.some(point => !cleanPoint(point))) return false;
  const magnitude = source.concat(result).reduce((maximum, point) =>
    Math.max(maximum, Math.abs(point.x), Math.abs(point.y)), 1);
  const tolerance = Math.max(1e-9, distance * 1e-8, magnitude * Number.EPSILON * 32);
  const before = pathSegments(source, closed);
  const after = pathSegments(result, closed);
  if (pathHasCrossings(before, closed, tolerance) || pathHasCrossings(after, closed, tolerance)) return false;
  for (let i = 0; i < before.length; i++) {
    const [a, b] = before[i];
    const [c, d] = after[i];
    // A surviving edge must retain its direction. This rejects polygons that
    // have passed through collapse and reappeared on the other side.
    const length = dist(a, b);
    if (((b.x - a.x) / length) * (d.x - c.x) +
        ((b.y - a.y) / length) * (d.y - c.y) <= tolerance) return false;
    for (const [p, q] of before) {
      if (!segmentBoundsNear(c, d, p, q, distance + tolerance)) continue;
      if (segmentsMeet(c, d, p, q, tolerance)) return false;
      const gap = Math.min(
        dist(c, pointOnSegmentClosest(c, p, q)), dist(d, pointOnSegmentClosest(d, p, q)),
        dist(p, pointOnSegmentClosest(p, c, d)), dist(q, pointOnSegmentClosest(q, c, d)),
      );
      if (!Number.isFinite(gap) || gap < distance - tolerance) return false;
    }
  }
  return true;
}

export function offsetEntity(entity, distance, sidePoint, id = entity.id) {
  if (!['LINE', 'PLINE', 'CIRCLE', 'ARC'].includes(entity.type) || distance <= 0) return null;
  // The mitered path below is built from shifted straight segments and checked
  // for self-crossing the same way. Offsetting a curved segment means offset
  // arcs joined by arc/line intersections, which is a different construction —
  // refused by name in acceptOffsetSource rather than approximated here.
  if (polylineHasBulges(entity)) return null;

  if (entity.type === 'CIRCLE' || entity.type === 'ARC') {
    const pointDistance = dist(entity.center, sidePoint);
    if (Math.abs(pointDistance - entity.radius) < 1e-9) return null;
    const radius = pointDistance > entity.radius ? entity.radius + distance : entity.radius - distance;
    return radius > 1e-9 ? { ...entity, id, center: { ...entity.center }, radius } : null;
  }

  const side = offsetSideSign(entity, sidePoint);
  if (!side) return null;

  if (entity.type === 'LINE') {
    const shifted = shiftSegment(entity.a, entity.b, distance, side);
    return shifted ? { ...entity, id, a: shifted[0], b: shifted[1] } : null;
  }

  const points = entity.points.map(point => ({ ...point }));
  if (entity.closed && points.length > 1 && dist(points[0], points[points.length - 1]) < 1e-9) points.pop();
  if (points.length < (entity.closed ? 3 : 2)) return null;

  const sourceSegments = [];
  for (let i = 0; i < points.length - 1; i++) sourceSegments.push([points[i], points[i + 1]]);
  if (entity.closed) sourceSegments.push([points[points.length - 1], points[0]]);
  const shifted = sourceSegments.map(segment => shiftSegment(segment[0], segment[1], distance, side));
  if (shifted.some(segment => !segment)) return null;

  const offsetPoints = [];
  if (entity.closed) {
    for (let i = 0; i < shifted.length; i++) {
      offsetPoints.push(joinedOffsetPoint(shifted[(i - 1 + shifted.length) % shifted.length], shifted[i]));
    }
  } else {
    offsetPoints.push(shifted[0][0]);
    for (let i = 1; i < shifted.length; i++) {
      offsetPoints.push(joinedOffsetPoint(shifted[i - 1], shifted[i]));
    }
    offsetPoints.push(shifted[shifted.length - 1][1]);
  }

  if (!offsetPathIsValid(points, offsetPoints, Boolean(entity.closed), distance)) return null;
  return { ...entity, id, points: offsetPoints, closed: Boolean(entity.closed) };
}

export function isOffsettable(entity) {
  return entity && ['LINE', 'PLINE', 'CIRCLE', 'ARC'].includes(entity.type);
}

export function setOffsetDistance(value) {
  if (state.mode !== 'OFFSET' || state.offset?.stage !== 'DISTANCE') return false;
  if (!Number.isFinite(value) || value <= 0) {
    updatePrompt('Distance must be greater than zero.');
    return true;
  }
  state.offset.distance = value;
  state.offset.stage = state.offset.sourceId ? 'SIDE' : 'SOURCE';
  updatePrompt();
  draw();
  return true;
}

export function acceptOffsetSource() {
  if (state.mode !== 'OFFSET' || state.offset?.stage !== 'SOURCE') return false;
  const selected = state.entities.filter(entity => state.selected.has(entity.id) && isEntityEditable(entity));
  if (selected.length !== 1 || !isOffsettable(selected[0])) {
    updatePrompt(selected.length ? 'Select exactly one line, polyline, circle, or arc.' : 'No object selected.');
    return true;
  }
  if (polylineHasBulges(selected[0])) {
    updatePrompt('OFFSET works on straight polylines; that one has a curved segment. EXPLODE it first.');
    return true;
  }
  state.offset.sourceId = selected[0].id;
  state.offset.stage = 'SIDE';
  updatePrompt();
  draw();
  return true;
}

export function applyOffset(sidePoint) {
  if (state.mode !== 'OFFSET' || state.offset?.stage !== 'SIDE') return;
  const source = state.entities.find(entity => entity.id === state.offset.sourceId && isEntityEditable(entity));
  const result = source && offsetEntity(source, state.offset.distance, sidePoint, state.nextId);
  if (!result) {
    updatePrompt('Offset rejected: the result collapses, crosses itself, or has no valid side. Try a smaller distance or another side.');
    return;
  }
  if (!commitGeometry([...state.entities, result], { nextId: state.nextId + 1 })) return;
  state.selected = new Set([result.id]);
  setMode('SELECT');
}
