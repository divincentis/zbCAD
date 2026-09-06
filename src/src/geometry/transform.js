import { arcSweep, normalizeAngle } from '../core/math.js';

export function translateEntity(entity, dx, dy, id = entity.id) {
  if (entity.type === 'LINE') {
    return {
      ...entity,
      id,
      a: { x: entity.a.x + dx, y: entity.a.y + dy },
      b: { x: entity.b.x + dx, y: entity.b.y + dy },
    };
  }
  if (entity.type === 'PLINE') {
    return {
      ...entity,
      id,
      points: entity.points.map(point => ({ x: point.x + dx, y: point.y + dy })),
    };
  }
  if (entity.type === 'CIRCLE' || entity.type === 'ARC') {
    return {
      ...entity,
      id,
      center: { x: entity.center.x + dx, y: entity.center.y + dy },
    };
  }
  if (entity.type === 'DIM') {
    return {
      ...entity,
      id,
      p1: { x: entity.p1.x + dx, y: entity.p1.y + dy },
      p2: { x: entity.p2.x + dx, y: entity.p2.y + dy },
      linePoint: { x: entity.linePoint.x + dx, y: entity.linePoint.y + dy },
      refs: entity.refs.map(ref => (ref ? { ...ref } : null)),
    };
  }
  if (entity.type === 'TEXT') {
    return { ...entity, id, position: { x: entity.position.x + dx, y: entity.position.y + dy } };
  }
  return JSON.parse(JSON.stringify(entity));
}

export function rotatePoint(point, base, angle) {
  const dx = point.x - base.x;
  const dy = point.y - base.y;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    x: base.x + dx * cosine - dy * sine,
    y: base.y + dx * sine + dy * cosine,
  };
}

export function rotateEntity(entity, base, angle, id = entity.id) {
  if (entity.type === 'LINE') {
    return {
      ...entity,
      id,
      a: rotatePoint(entity.a, base, angle),
      b: rotatePoint(entity.b, base, angle),
    };
  }
  if (entity.type === 'PLINE') {
    return {
      ...entity,
      id,
      points: entity.points.map(point => rotatePoint(point, base, angle)),
    };
  }
  if (entity.type === 'CIRCLE') {
    return { ...entity, id, center: rotatePoint(entity.center, base, angle) };
  }
  if (entity.type === 'ARC') {
    const rotatedStart = normalizeAngle(entity.startAngle + angle);
    return {
      ...entity,
      id,
      center: rotatePoint(entity.center, base, angle),
      startAngle: rotatedStart,
      endAngle: rotatedStart + arcSweep(entity),
    };
  }
  if (entity.type === 'DIM') {
    return {
      ...entity,
      id,
      p1: rotatePoint(entity.p1, base, angle),
      p2: rotatePoint(entity.p2, base, angle),
      linePoint: rotatePoint(entity.linePoint, base, angle),
      // A LINEAR dimension measures along a fixed direction, so the direction
      // has to turn with it or the measurement silently changes.
      rotation: normalizeAngle(entity.rotation + angle),
      textOffset: entity.textOffset
        ? rotatePoint(entity.textOffset, { x: 0, y: 0 }, angle) : null,
      refs: entity.refs.map(ref => (ref ? { ...ref } : null)),
    };
  }
  if (entity.type === 'TEXT') {
    return {
      ...entity,
      id,
      position: rotatePoint(entity.position, base, angle),
      rotation: normalizeAngle(entity.rotation + angle),
    };
  }
  return JSON.parse(JSON.stringify(entity));
}

export function scalePoint(point, base, factor) {
  return {
    x: base.x + (point.x - base.x) * factor,
    y: base.y + (point.y - base.y) * factor,
  };
}

export function scaleEntity(entity, base, factor, id = entity.id) {
  if (entity.type === 'LINE') {
    return {
      ...entity,
      id,
      a: scalePoint(entity.a, base, factor),
      b: scalePoint(entity.b, base, factor),
    };
  }
  if (entity.type === 'PLINE') {
    return {
      ...entity,
      id,
      points: entity.points.map(point => scalePoint(point, base, factor)),
    };
  }
  if (entity.type === 'CIRCLE' || entity.type === 'ARC') {
    return {
      ...entity,
      id,
      center: scalePoint(entity.center, base, factor),
      radius: entity.radius * factor,
    };
  }
  if (entity.type === 'DIM') {
    return {
      ...entity,
      id,
      p1: scalePoint(entity.p1, base, factor),
      p2: scalePoint(entity.p2, base, factor),
      linePoint: scalePoint(entity.linePoint, base, factor),
      textOffset: entity.textOffset
        ? { x: entity.textOffset.x * factor, y: entity.textOffset.y * factor } : null,
      refs: entity.refs.map(ref => (ref ? { ...ref } : null)),
    };
  }
  if (entity.type === 'TEXT') {
    // Real CAD scales text height along with everything else, so a 2x SCALE
    // on a wall and its label keeps them in visual proportion.
    return { ...entity, id, position: scalePoint(entity.position, base, factor), height: entity.height * factor };
  }
  return JSON.parse(JSON.stringify(entity));
}

// Reflecting a point across the line through axisA and axisB: split the offset
// from axisA into the component running along the axis and the component
// crossing it, then negate only the second.
export function mirrorPoint(point, axisA, axisB) {
  const axisX = axisB.x - axisA.x;
  const axisY = axisB.y - axisA.y;
  const axisLengthSq = axisX * axisX + axisY * axisY;
  // Two coincident points name no direction to reflect across. The command
  // rejects that before committing, so the point is handed back untouched
  // rather than turned into NaN on the way to a preview.
  if (axisLengthSq < 1e-18) return { x: point.x, y: point.y };
  const dx = point.x - axisA.x;
  const dy = point.y - axisA.y;
  const projection = 2 * (dx * axisX + dy * axisY) / axisLengthSq;
  return {
    x: axisA.x + projection * axisX - dx,
    y: axisA.y + projection * axisY - dy,
  };
}

// A direction at angle θ reflected across an axis at angle φ comes back at
// 2φ − θ.
export function mirrorAngle(angle, axisA, axisB) {
  const axisAngle = Math.atan2(axisB.y - axisA.y, axisB.x - axisA.x);
  return normalizeAngle(2 * axisAngle - angle);
}

export function mirrorEntity(entity, axisA, axisB, id = entity.id) {
  if (entity.type === 'LINE') {
    return {
      ...entity,
      id,
      a: mirrorPoint(entity.a, axisA, axisB),
      b: mirrorPoint(entity.b, axisA, axisB),
    };
  }
  if (entity.type === 'PLINE') {
    // Reflection reverses the sense of rotation, so every curved segment
    // sweeps the other way round while keeping its shape — which for a bulge
    // is exactly a change of sign. Translation, rotation and scale leave them
    // alone, which is the whole reason a curve is stored this way.
    const mirrored = {
      ...entity,
      id,
      points: entity.points.map(point => mirrorPoint(point, axisA, axisB)),
    };
    return entity.bulges
      ? { ...mirrored, bulges: entity.bulges.map(bulge => (bulge === 0 ? 0 : -bulge)) }
      : mirrored;
  }
  if (entity.type === 'CIRCLE') {
    return { ...entity, id, center: mirrorPoint(entity.center, axisA, axisB) };
  }
  if (entity.type === 'ARC') {
    // Reflection reverses the sense of rotation, so the mirrored arc runs
    // counter-clockwise from the reflected end back to the reflected start.
    // Sweeping the original magnitude from that reflected end lands on the
    // reflected start and covers the mirrored span.
    const sweep = arcSweep(entity);
    const startAngle = mirrorAngle(entity.startAngle + sweep, axisA, axisB);
    return {
      ...entity,
      id,
      center: mirrorPoint(entity.center, axisA, axisB),
      startAngle,
      endAngle: startAngle + sweep,
    };
  }
  if (entity.type === 'DIM') {
    return {
      ...entity,
      id,
      p1: mirrorPoint(entity.p1, axisA, axisB),
      p2: mirrorPoint(entity.p2, axisA, axisB),
      linePoint: mirrorPoint(entity.linePoint, axisA, axisB),
      // A LINEAR dimension measures along a fixed direction, so that direction
      // reflects with the geometry or the measurement silently changes.
      rotation: mirrorAngle(entity.rotation, axisA, axisB),
      // textOffset is a displacement rather than a place, so it reflects about
      // the origin: only its direction is meant to change.
      textOffset: entity.textOffset
        ? mirrorPoint(
          entity.textOffset,
          { x: 0, y: 0 },
          { x: axisB.x - axisA.x, y: axisB.y - axisA.y },
        )
        : null,
      refs: entity.refs.map(ref => (ref ? { ...ref } : null)),
    };
  }
  if (entity.type === 'TEXT') {
    // AutoCAD's MIRRTEXT default, and for the same reason: the insertion point
    // moves with everything else, but the lettering keeps its own angle rather
    // than becoming a mirror image of itself. A note on a mirrored roof half
    // still has to be readable.
    return { ...entity, id, position: mirrorPoint(entity.position, axisA, axisB) };
  }
  return JSON.parse(JSON.stringify(entity));
}
