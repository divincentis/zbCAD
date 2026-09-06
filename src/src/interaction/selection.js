import { activeCommand, commandSelectsObjects } from '../commands/registry.js';
import { angleFromCenter, angleOnArc, circularPoint, dist, pointOnSegmentClosest } from '../core/math.js';
import { commitGeometry } from '../model/history.js';
import { boxContains, entityBBox, entityCrossesBox, pickSegments, textContainsPoint } from '../model/entity.js';
import { isEntityEditable } from '../model/layerQuery.js';
import { state } from '../state.js';
import { updatePrompt } from '../ui/prompt.js';
import { draw } from '../view/frame.js';
import { screenToWorld, worldToScreen } from '../view/viewport.js';

export function distanceToEntityPx(world, entity) {
  if (entity.type === 'CIRCLE' || entity.type === 'ARC') {
    const angle = angleFromCenter(entity.center, world);
    if (angleOnArc(angle, entity)) {
      return Math.abs(dist(world, entity.center) - entity.radius) * state.view.scale;
    }
    const endpoints = [
      circularPoint(entity.center, entity.radius, entity.startAngle),
      circularPoint(entity.center, entity.radius, entity.endAngle),
    ];
    return Math.min(...endpoints.map(point => dist(world, point))) * state.view.scale;
  }
  // A click anywhere inside a text run's footprint should select it, the way
  // a filled glyph area reads, rather than only near its outline.
  if (entity.type === 'TEXT' && textContainsPoint(entity, world)) return 0;
  let best = Infinity;
  for (const [a, b, arc] of pickSegments(entity)) {
    // A curved segment is picked off its arc, not the chord across it — the
    // same rule the standalone-curve branch above follows, including falling
    // back to the nearer end once the cursor is past the sweep.
    let q;
    if (arc) {
      const angle = angleFromCenter(arc.center, world);
      q = angleOnArc(angle, arc)
        ? circularPoint(arc.center, arc.radius, angle)
        : (dist(world, a) <= dist(world, b) ? a : b);
    } else {
      q = pointOnSegmentClosest(world, a, b);
    }
    const qs = worldToScreen(q);
    best = Math.min(best, Math.hypot(qs.x - state.mouseScreen.x, qs.y - state.mouseScreen.y));
  }
  return best;
}

export function selectAt(world, add = false) {
  let hit = null;
  let best = 8;
  for (const e of state.entities) {
    if (!isEntityEditable(e)) continue;
    const d = distanceToEntityPx(world, e);
    if (d < best) { best = d; hit = e; }
  }
  if (!add) state.selected.clear();
  if (hit) {
    if (add && state.selected.has(hit.id)) state.selected.delete(hit.id);
    else state.selected.add(hit.id);
    activeCommand()?.noteSelection?.({ entityId: hit.id });
  }
  // Any command gathering a selection may be reporting how many it has.
  if (commandSelectsObjects()) updatePrompt();
  draw();
}

export function finishBoxSelection(add = false) {
  const ds = state.dragSelect;
  if (!ds) return;
  const a = screenToWorld(ds.start);
  const b = screenToWorld(ds.end);
  const box = { minX: Math.min(a.x,b.x), maxX: Math.max(a.x,b.x), minY: Math.min(a.y,b.y), maxY: Math.max(a.y,b.y) };
  const crossing = ds.end.x < ds.start.x;
  if (!add) state.selected.clear();
  for (const e of state.entities) {
    if (!isEntityEditable(e)) continue;
    const bb = entityBBox(e);
    if (!bb) continue;
    // Window selection stays a bbox containment test: these bounding boxes are
    // tight (arcs include their quadrant extremes), so bbox-inside-window is
    // equivalent to geometry-inside-window.
    const hit = crossing ? entityCrossesBox(e, box) : boxContains(box, bb);
    if (hit) state.selected.add(e.id);
  }
  activeCommand()?.noteSelection?.({ box, crossing });
  state.dragSelect = null;
  if (commandSelectsObjects()) updatePrompt();
  draw();
}

// The one implementation of "remove what is selected", shared by the Delete
// key and the ERASE command. It reports what it did so ERASE can say so at the
// prompt; the key press has nowhere to show that and ignores it.
export function eraseSelection() {
  const deletable = new Set(state.entities
    .filter(entity => state.selected.has(entity.id) && isEntityEditable(entity))
    .map(entity => entity.id));
  if (!deletable.size) return { error: 'No objects selected.', erased: 0 };
  if (!commitGeometry(state.entities.filter(e => !deletable.has(e.id)))) {
    return { error: 'That deletion was rejected.', erased: 0 };
  }
  state.selected.clear();
  draw();
  return { erased: deletable.size };
}

// A dimension whose geometry is erased freezes at its last measured value
// rather than disappearing, so the count names objects removed, not objects
// affected.
export function eraseNote(result) {
  if (!result.erased) return '';
  return `Erased ${result.erased} object${result.erased === 1 ? '' : 's'}.`;
}

export function deleteSelected() {
  eraseSelection();
}
