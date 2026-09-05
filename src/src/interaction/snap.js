import { activeCommand } from '../commands/registry.js';
import { SNAP_RANK } from '../core/defaults.js';
import { SNAP_COINCIDENT_PX, angleFromCenter, angleOnArc, arcSweep, circularEntityIntersections, circularPoint, dist, normalizeAngle, pointOnInfiniteLine, pointOnSegmentClosest, pointWithinSegment, segmentCircularIntersections, segmentIntersection, segmentWithinRadius } from '../core/math.js';
import { isEntityVisible } from '../model/layerQuery.js';
import { state } from '../state.js';
import { screenToWorld, worldToScreen } from '../view/viewport.js';

export function snapSegments(excludedEntityId = null) {
  const segs = [];
  for (const entity of state.entities) {
    if (isEntityVisible(entity) && entity.id !== excludedEntityId) segs.push(...entitySegments(entity));
  }

  const command = activeCommand();
  if (command?.snapSegments) segs.push(...command.snapSegments());
  return segs;
}

export function getSnap(rawWorld, basePoint = null, excludedEntityId = null) {
  if (!state.snapEnabled) return null;
  const maxPx = 10;
  const candidates = [];

  // Aperture prefilter. Every snap candidate this function can return lies either
  // ON a segment/curve or AT a circle center, and is discarded below unless it is
  // within maxPx of the cursor. So geometry that never passes within the aperture
  // cannot contribute a surviving candidate, and can be dropped before the
  // O(n^2) intersection pass. This is an exact filter, not an approximation.
  const cursor = screenToWorld(state.mouseScreen);
  const aperture = maxPx / state.view.scale + 1e-9;

  const segs = snapSegments(excludedEntityId)
    .filter(([a, b]) => segmentWithinRadius(a, b, cursor, aperture));
  const circularEntities = state.entities.filter(entity => {
    if (!isEntityVisible(entity) || entity.id === excludedEntityId) return false;
    if (!['CIRCLE', 'ARC'].includes(entity.type)) return false;
    const radial = dist(cursor, entity.center);
    // Near the curve (endpoints, midpoint, quadrants, intersections, perpendicular)
    // or near the center (CENTER snap, which sits far from the drawn curve).
    return Math.abs(radial - entity.radius) <= aperture || radial <= aperture;
  });

  // Each type is skipped at the source rather than filtered afterwards, so a
  // snap that is switched off costs nothing to have.
  const wants = type => Boolean(state.snapTypes[type]);

  for (const [a, b] of segs) {
    if (wants('END')) {
      candidates.push({ type: 'END', p: a });
      candidates.push({ type: 'END', p: b });
    }
    if (wants('MID')) candidates.push({ type: 'MID', p: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } });
  }

  if (wants('INT')) {
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const p = segmentIntersection(segs[i][0], segs[i][1], segs[j][0], segs[j][1]);
        if (p) candidates.push({ type: 'INT', p });
      }
    }
  }

  for (const circularEntity of circularEntities) {
    if (circularEntity.type === 'ARC') {
      if (wants('END')) {
        candidates.push({ type: 'END', p: circularPoint(circularEntity.center, circularEntity.radius, circularEntity.startAngle) });
        candidates.push({ type: 'END', p: circularPoint(circularEntity.center, circularEntity.radius, circularEntity.endAngle) });
      }
      if (wants('MID')) candidates.push({ type: 'MID', p: circularPoint(circularEntity.center, circularEntity.radius, circularEntity.startAngle + arcSweep(circularEntity) / 2) });
    }
    if (wants('CENTER')) candidates.push({ type: 'CENTER', p: circularEntity.center });
    if (wants('QUAD')) {
      for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
        if (angleOnArc(angle, circularEntity)) {
          candidates.push({ type: 'QUAD', p: circularPoint(circularEntity.center, circularEntity.radius, angle) });
        }
      }
    }
    if (wants('INT')) {
      for (const [a, b] of segs) {
        for (const intersection of segmentCircularIntersections(a, b, circularEntity)) {
          candidates.push({ type: 'INT', p: intersection.point });
        }
      }
    }
  }

  if (wants('INT')) {
    for (let i = 0; i < circularEntities.length; i++) {
      for (let j = i + 1; j < circularEntities.length; j++) {
        for (const p of circularEntityIntersections(circularEntities[i], circularEntities[j])) candidates.push({ type: 'INT', p });
      }
    }
  }

  // Perpendicular and tangent are both measured from the point the command is
  // already working from, so neither exists until there is one.
  if (basePoint && wants('PERP')) {
    for (const [a, b] of segs) {
      const proj = pointOnInfiniteLine(basePoint, a, b);
      if (proj && pointWithinSegment(proj, a, b)) candidates.push({ type: 'PERP', p: proj });
    }
    for (const circularEntity of circularEntities) {
      const radialLength = dist(basePoint, circularEntity.center);
      if (radialLength > 1e-9) {
        const radialAngle = angleFromCenter(circularEntity.center, basePoint);
        for (const angle of [radialAngle, normalizeAngle(radialAngle + Math.PI)]) {
          if (angleOnArc(angle, circularEntity)) {
            candidates.push({ type: 'PERP', p: circularPoint(circularEntity.center, circularEntity.radius, angle) });
          }
        }
      }
    }
  }

  if (basePoint && wants('TAN')) {
    for (const circularEntity of circularEntities) {
      const away = dist(basePoint, circularEntity.center);
      // The touch point sees the centre at a right angle, so the angle it
      // subtends at the centre from the base direction is acos(r / d). From
      // inside the curve there is no tangent, and from exactly on it the
      // touch point is the base point itself, which is no use as a
      // destination.
      if (away <= circularEntity.radius + 1e-9) continue;
      const toward = angleFromCenter(circularEntity.center, basePoint);
      const spread = Math.acos(circularEntity.radius / away);
      for (const angle of [toward + spread, toward - spread]) {
        const touch = normalizeAngle(angle);
        if (angleOnArc(touch, circularEntity)) {
          candidates.push({ type: 'TAN', p: circularPoint(circularEntity.center, circularEntity.radius, touch) });
        }
      }
    }
  }

  // Nearest can always produce a point on any curve under the aperture, so it
  // is gathered apart from the rest and only consulted when nothing else is
  // in range. Letting it compete on distance would let a point on a line beat
  // an endpoint a few pixels away, which is not what a draughtsman means.
  const nearCandidates = [];
  if (wants('NEAR')) {
    for (const [a, b] of segs) {
      nearCandidates.push({ type: 'NEAR', p: pointOnSegmentClosest(cursor, a, b) });
    }
    for (const circularEntity of circularEntities) {
      if (dist(cursor, circularEntity.center) < 1e-9) continue;
      const angle = angleFromCenter(circularEntity.center, cursor);
      if (angleOnArc(angle, circularEntity)) {
        nearCandidates.push({ type: 'NEAR', p: circularPoint(circularEntity.center, circularEntity.radius, angle) });
      }
    }
  }

  function closestCandidate(list) {
    let best = null;
    for (const c of list) {
      const s = worldToScreen(c.p);
      const px = Math.hypot(s.x - state.mouseScreen.x, s.y - state.mouseScreen.y);
      if (px > maxPx) continue;
      if (!best) { best = { ...c, px, screen: s }; continue; }
      const nearer = px < best.px - SNAP_COINCIDENT_PX;
      // Rank only decides between candidates at the SAME PLACE. Comparing each
      // candidate's distance from the cursor instead let two points on opposite
      // sides of the cursor count as coincident, so a higher-ranked endpoint
      // could beat a midpoint a dozen pixels nearer.
      const apart = Math.hypot(s.x - best.screen.x, s.y - best.screen.y);
      const sameSpot = apart <= SNAP_COINCIDENT_PX;
      const outranks = sameSpot && (SNAP_RANK[c.type] ?? 99) < (SNAP_RANK[best.type] ?? 99);
      if (nearer || outranks) best = { ...c, px, screen: s };
    }
    return best;
  }

  return closestCandidate(candidates) || closestCandidate(nearCandidates);
}
