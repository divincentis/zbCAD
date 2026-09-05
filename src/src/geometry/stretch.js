import { setMode } from '../commands/registry.js';
import { dist } from '../core/math.js';
import { dimensionGeometry } from '../model/dimension.js';
import { commitGeometry } from '../model/document.js';
import { pointInBox } from '../model/entity.js';
import { isEntityEditable } from '../model/layerQuery.js';
import { state } from '../state.js';
import { updatePrompt } from '../ui/prompt.js';

// ---------------------------------------------------------------------------
// Stretch
//
// The one editing command whose operand is not a set of objects but a set of
// points: vertices caught by a crossing window move, the rest stay, and an
// object caught entirely is simply carried along. That is what lets a wall be
// lengthened without redrawing what it connects to.
// ---------------------------------------------------------------------------

export function pointInStretchWindow(point, windows) {
  return windows.some(box => pointInBox(point, box));
}

// Curves have no vertices to pull, so they answer to their centre: caught,
// the whole curve travels; missed, it stays put and its ends do not follow
// the geometry they were drawn against. That limit is deliberate — stretching
// an arc endpoint would have to invent a new radius.
export function stretchedEntity(entity, dx, dy, caught) {
  const shift = point => (caught(point) ? { x: point.x + dx, y: point.y + dy } : { ...point });
  if (entity.type === 'LINE') return { ...entity, a: shift(entity.a), b: shift(entity.b) };
  if (entity.type === 'PLINE') return { ...entity, points: entity.points.map(shift) };
  if (entity.type === 'CIRCLE' || entity.type === 'ARC') {
    return { ...entity, center: shift(entity.center) };
  }
  if (entity.type === 'DIM') {
    // Each measured point moves on its own, so a dimension across a stretched
    // wall reports the new length rather than the old one.
    return {
      ...entity,
      p1: shift(entity.p1),
      p2: shift(entity.p2),
      linePoint: shift(entity.linePoint),
      refs: entity.refs.map(ref => (ref ? { ...ref } : null)),
    };
  }
  // Text has one anchor point and no vertices of its own, so — like a circle
  // or arc — it answers to that point: caught, it travels; missed, it stays.
  if (entity.type === 'TEXT') return { ...entity, position: shift(entity.position) };
  return { ...entity };
}

export function stretchIsDegenerate(entity) {
  if (entity.type === 'LINE') return dist(entity.a, entity.b) <= 1e-9;
  if (entity.type === 'PLINE') {
    return entity.points.some((point, index) => index > 0 && dist(point, entity.points[index - 1]) <= 1e-9);
  }
  if (entity.type === 'DIM') return dimensionGeometry(entity).measure <= 1e-9;
  return false;
}

export function applyStretch(destination) {
  const operation = state.edit;
  if (!operation?.base || operation.stage !== 'DEST') return;
  const dx = destination.x - operation.base.x;
  const dy = destination.y - operation.base.y;
  if (Math.hypot(dx, dy) < 1e-9) {
    updatePrompt('Destination must differ from the base point.');
    return;
  }

  const editable = new Set(state.entities
    .filter(entity => operation.ids.includes(entity.id) && isEntityEditable(entity))
    .map(entity => entity.id));
  if (!editable.size) {
    updatePrompt('The selected objects are no longer editable.');
    return;
  }

  const stretched = new Map();
  for (const entity of state.entities) {
    if (!editable.has(entity.id)) continue;
    // An object named by a bare click has no window around it, so all of it
    // travels — which is what picking an object rather than windowing part of
    // it asks for.
    const whole = operation.pickedIds.includes(entity.id);
    const result = stretchedEntity(
      entity, dx, dy,
      point => whole || pointInStretchWindow(point, operation.windows),
    );
    if (stretchIsDegenerate(result)) {
      updatePrompt('That stretch would collapse geometry.');
      return;
    }
    stretched.set(entity.id, result);
  }

  if (!commitGeometry(state.entities.map(entity => stretched.get(entity.id) || entity))) return;
  state.selected = new Set(editable);
  setMode('SELECT');
}
