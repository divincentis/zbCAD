import { TAU } from '../core/constants.js';
import { angleFromCenter, dist, normalizeAngle } from '../core/math.js';
import { commitGeometry } from '../model/document.js';
import { currentLayerIsEditable } from '../model/layerQuery.js';
import { state } from '../state.js';

export function addLine(a, b) {
  if (dist(a, b) < 1e-9 || !currentLayerIsEditable()) return false;
  return commitGeometry([...state.entities, {
    id: state.nextId,
    type: 'LINE',
    layerId: state.currentLayerId,
    a: { ...a },
    b: { ...b },
  }], { nextId: state.nextId + 1 });
}

export function addPolyline(points, forceClosed = false) {
  if (points.length < 2 || !currentLayerIsEditable()) return false;
  // Never write what the loader will not read back. Every caller funnels
  // through here, so this is the one place duplicate consecutive points can be
  // ruled out for good rather than guarded at each entry point.
  const storedPoints = [];
  for (const point of points) {
    const last = storedPoints[storedPoints.length - 1];
    if (last && dist(last, point) <= 1e-9) continue;
    storedPoints.push({ ...point });
  }
  if (storedPoints.length < 2) return false;
  const closesAtStart = storedPoints.length >= 4 && dist(storedPoints[0], storedPoints[storedPoints.length - 1]) < 1e-7;
  if (closesAtStart) storedPoints.pop();
  const closed = forceClosed || closesAtStart;
  if (closed && storedPoints.length < 3) return false;
  return commitGeometry([...state.entities, {
    id: state.nextId,
    type: 'PLINE',
    layerId: state.currentLayerId,
    points: storedPoints,
    closed,
  }], { nextId: state.nextId + 1 });
}

export function addRectangle(first, opposite) {
  if (Math.abs(first.x - opposite.x) < 1e-9 || Math.abs(first.y - opposite.y) < 1e-9) return false;
  return addPolyline([
    first,
    { x: opposite.x, y: first.y },
    opposite,
    { x: first.x, y: opposite.y },
    first,
  ]);
}

export function addCircle(center, radius) {
  if (!Number.isFinite(radius) || radius <= 1e-9 || !currentLayerIsEditable()) return false;
  return commitGeometry([...state.entities, {
    id: state.nextId,
    type: 'CIRCLE',
    layerId: state.currentLayerId,
    center: { ...center },
    radius,
  }], { nextId: state.nextId + 1 });
}

export function circumcircleFromThreePoints(first, second, third) {
  const span = Math.max(dist(first, second), dist(second, third), dist(third, first));
  if (!Number.isFinite(span) || span <= 1e-9) return null;

  const twiceArea = (second.x - first.x) * (third.y - first.y) -
    (second.y - first.y) * (third.x - first.x);
  if (Math.abs(twiceArea) <= Math.max(1e-10, span * span * 1e-10)) return null;

  // Solve in coordinates relative to the first point. This avoids losing
  // precision when small circular geometry is drawn at large coordinates.
  const secondRelative = { x: second.x - first.x, y: second.y - first.y };
  const thirdRelative = { x: third.x - first.x, y: third.y - first.y };
  const denominator = 2 * (
    secondRelative.x * thirdRelative.y - secondRelative.y * thirdRelative.x
  );
  const secondSquared = secondRelative.x * secondRelative.x + secondRelative.y * secondRelative.y;
  const thirdSquared = thirdRelative.x * thirdRelative.x + thirdRelative.y * thirdRelative.y;
  const center = {
    x: first.x + (
      secondSquared * thirdRelative.y - secondRelative.y * thirdSquared
    ) / denominator,
    y: first.y + (
      secondRelative.x * thirdSquared - secondSquared * thirdRelative.x
    ) / denominator,
  };
  const radius = dist(center, first);
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(radius) || radius <= 1e-9) return null;
  return { center, radius };
}

export function threePointArc(start, through, end, id) {
  const circle = circumcircleFromThreePoints(start, through, end);
  if (!circle) return null;
  const { center, radius } = circle;

  const startAngle = angleFromCenter(center, start);
  const throughAngle = angleFromCenter(center, through);
  const endAngle = angleFromCenter(center, end);
  const counterclockwiseSweep = normalizeAngle(endAngle - startAngle);
  const throughSweep = normalizeAngle(throughAngle - startAngle);
  const followsCounterclockwise = throughSweep < counterclockwiseSweep;
  const storedStart = followsCounterclockwise ? startAngle : endAngle;
  const storedSweep = followsCounterclockwise
    ? counterclockwiseSweep
    : normalizeAngle(startAngle - endAngle);
  if (storedSweep <= 1e-8 || storedSweep >= TAU - 1e-8) return null;

  const arc = {
    type: 'ARC',
    layerId: state.currentLayerId,
    center,
    radius,
    startAngle: storedStart,
    endAngle: storedStart + storedSweep,
  };
  if (id !== undefined) arc.id = id;
  return arc;
}

export function addThreePointCircle(first, second, third) {
  const circle = circumcircleFromThreePoints(first, second, third);
  if (!circle) return false;
  return addCircle(circle.center, circle.radius);
}

export function addThreePointArc(start, through, end) {
  if (!currentLayerIsEditable()) return false;
  const arc = threePointArc(start, through, end, state.nextId);
  if (!arc) return false;
  return commitGeometry([...state.entities, arc], { nextId: state.nextId + 1 });
}
