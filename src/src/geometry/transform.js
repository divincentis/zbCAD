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
  return JSON.parse(JSON.stringify(entity));
}
