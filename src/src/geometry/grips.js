import { setMode } from '../commands/registry.js';
import { arcSweep, circularPoint, dist } from '../core/math.js';
import { threePointArc } from './construct.js';
import { dimensionGeometry, resolveEntityReference } from '../model/dimension.js';
import { commitGeometry } from '../model/history.js';
import { isEntityEditable } from '../model/layerQuery.js';
import { state } from '../state.js';
import { updatePrompt } from '../ui/prompt.js';
import { draw } from '../view/frame.js';
import { worldToScreen } from '../view/viewport.js';

export function entityGrips(entity) {
  if (entity.type === 'LINE') {
    return [
      { kind: 'LINE_END', index: 0, point: entity.a },
      { kind: 'LINE_END', index: 1, point: entity.b },
    ];
  }
  if (entity.type === 'PLINE') {
    return entity.points.map((point, index) => ({ kind: 'PLINE_VERTEX', index, point }));
  }
  if (entity.type === 'DIM') {
    return [
      { kind: 'DIM_POINT', index: 0, point: entity.p1 },
      { kind: 'DIM_POINT', index: 1, point: entity.p2 },
      { kind: 'DIM_LINE', point: dimensionGeometry(entity).mid },
    ];
  }
  if (entity.type === 'CIRCLE') {
    return [
      { kind: 'CIRCLE_CENTER', point: entity.center },
      ...[0, Math.PI / 2, Math.PI, Math.PI * 1.5].map(angle => ({
        kind: 'CIRCLE_RADIUS',
        angle,
        point: circularPoint(entity.center, entity.radius, angle),
      })),
    ];
  }
  if (entity.type === 'ARC') {
    return [
      { kind: 'ARC_CENTER', point: entity.center },
      { kind: 'ARC_START', point: circularPoint(entity.center, entity.radius, entity.startAngle) },
      {
        kind: 'ARC_MID',
        point: circularPoint(entity.center, entity.radius, entity.startAngle + arcSweep(entity) / 2),
      },
      { kind: 'ARC_END', point: circularPoint(entity.center, entity.radius, entity.endAngle) },
    ];
  }
  if (entity.type === 'TEXT') {
    return [{ kind: 'TEXT_POSITION', point: entity.position }];
  }
  return [];
}

export function hitTestGrip(screen, maxPx = 8) {
  let best = null;
  for (const entity of state.entities) {
    if (!state.selected.has(entity.id) || !isEntityEditable(entity)) continue;
    for (const descriptor of entityGrips(entity)) {
      const gripScreen = worldToScreen(descriptor.point);
      const px = Math.hypot(gripScreen.x - screen.x, gripScreen.y - screen.y);
      if (px <= maxPx && (!best || px < best.px)) best = { entity, descriptor, px };
    }
  }
  return best;
}

export function startGripEdit(hit) {
  if (!hit?.entity || !isEntityEditable(hit.entity)) return false;
  const entityId = hit.entity.id;
  const descriptor = {
    ...hit.descriptor,
    point: { ...hit.descriptor.point },
  };
  setMode('GRIP');
  state.grip = {
    entityId,
    descriptor,
    base: { ...descriptor.point },
  };
  updatePrompt();
  draw();
  return true;
}

export function gripEditedEntity(entity, descriptor, point) {
  if (!entity || !descriptor || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return { error: 'Grip destination is invalid.' };
  }

  if (entity.type === 'LINE' && descriptor.kind === 'LINE_END') {
    const result = {
      ...entity,
      a: { ...entity.a },
      b: { ...entity.b },
    };
    if (descriptor.index === 0) result.a = { ...point };
    else result.b = { ...point };
    if (dist(result.a, result.b) <= 1e-9) return { error: 'A line must retain a nonzero length.' };
    return { entity: result };
  }

  if (entity.type === 'PLINE' && descriptor.kind === 'PLINE_VERTEX') {
    const index = descriptor.index;
    if (!Number.isInteger(index) || index < 0 || index >= entity.points.length) {
      return { error: 'That polyline vertex is no longer available.' };
    }
    const points = entity.points.map(value => ({ ...value }));
    const previousIndex = index > 0 ? index - 1 : entity.closed ? points.length - 1 : null;
    const nextIndex = index < points.length - 1 ? index + 1 : entity.closed ? 0 : null;
    if ((previousIndex !== null && dist(point, points[previousIndex]) <= 1e-9) ||
        (nextIndex !== null && dist(point, points[nextIndex]) <= 1e-9)) {
      return { error: 'A polyline vertex cannot coincide with an adjacent vertex.' };
    }
    points[index] = { ...point };
    return { entity: { ...entity, points } };
  }

  if (entity.type === 'DIM' && descriptor.kind === 'DIM_POINT') {
    const next = { ...entity, p1: { ...entity.p1 }, p2: { ...entity.p2 },
      refs: entity.refs.map(ref => (ref ? { ...ref } : null)) };
    if (descriptor.index === 0) next.p1 = { ...point }; else next.p2 = { ...point };
    if (dist(next.p1, next.p2) <= 1e-9) return { error: 'A dimension needs two distinct points.' };
    if (dimensionGeometry(next).measure <= 1e-9) {
      return { error: 'That would leave the dimension measuring nothing.' };
    }
    // The measured point moved by hand, so whatever it used to reference is no
    // longer what it measures.
    next.refs[descriptor.index] = resolveEntityReference(point);
    return { entity: next };
  }

  if (entity.type === 'DIM' && descriptor.kind === 'DIM_LINE') {
    return { entity: { ...entity, linePoint: { ...point },
      refs: entity.refs.map(ref => (ref ? { ...ref } : null)) } };
  }

  if (entity.type === 'CIRCLE') {
    if (descriptor.kind === 'CIRCLE_CENTER') {
      return { entity: { ...entity, center: { ...point } } };
    }
    if (descriptor.kind === 'CIRCLE_RADIUS') {
      const radius = dist(entity.center, point);
      if (radius <= 1e-9) return { error: 'Circle radius must be greater than zero.' };
      return { entity: { ...entity, center: { ...entity.center }, radius } };
    }
  }

  if (entity.type === 'ARC') {
    if (descriptor.kind === 'ARC_CENTER') {
      return { entity: { ...entity, center: { ...point } } };
    }
    if (['ARC_START', 'ARC_MID', 'ARC_END'].includes(descriptor.kind)) {
      const start = circularPoint(entity.center, entity.radius, entity.startAngle);
      const through = circularPoint(entity.center, entity.radius, entity.startAngle + arcSweep(entity) / 2);
      const end = circularPoint(entity.center, entity.radius, entity.endAngle);
      const reconstructed = descriptor.kind === 'ARC_START'
        ? threePointArc(point, through, end, entity.id)
        : descriptor.kind === 'ARC_MID'
          ? threePointArc(start, point, end, entity.id)
          : threePointArc(start, through, point, entity.id);
      if (!reconstructed) {
        return { error: 'Arc control points must remain distinct and non-collinear.' };
      }
      return {
        entity: {
          ...entity,
          center: { ...reconstructed.center },
          radius: reconstructed.radius,
          startAngle: reconstructed.startAngle,
          endAngle: reconstructed.endAngle,
        },
      };
    }
  }

  if (entity.type === 'TEXT' && descriptor.kind === 'TEXT_POSITION') {
    return { entity: { ...entity, position: { ...point } } };
  }

  return { error: 'That grip cannot edit this entity.' };
}

export function applyGripEdit(point) {
  const operation = state.grip;
  const entity = state.entities.find(value => value.id === operation?.entityId);
  if (!operation || !entity || !isEntityEditable(entity)) {
    updatePrompt('The gripped object is no longer editable.');
    return false;
  }
  const result = gripEditedEntity(entity, operation.descriptor, point);
  if (result.error) {
    updatePrompt(result.error);
    draw();
    return false;
  }
  if (JSON.stringify(result.entity) === JSON.stringify(entity)) {
    updatePrompt('Grip destination must change the geometry.');
    draw();
    return false;
  }
  if (!commitGeometry(state.entities.map(value => value.id === entity.id ? result.entity : value))) return false;
  setMode('SELECT');
  return true;
}
