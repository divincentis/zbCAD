import { visibleSelectedEntities } from '../commands/inquiry.js';
import { dist } from '../core/math.js';
import { commitGeometry } from '../model/document.js';
import { isEntityEditable } from '../model/layerQuery.js';
import { state } from '../state.js';

// ---------------------------------------------------------------------------
// Join and explode
//
// Inverse operations on a selection: several open paths become one polyline,
// or one polyline becomes its segments. Neither takes a point, so both are
// finished from the selection stage alone.
// ---------------------------------------------------------------------------

// Endpoints that met through a snap are exactly equal, but a point typed to
// the displayed precision can miss by a rounding step, so ends are matched
// with a tolerance rather than by equality.
export const JOIN_TOLERANCE = 1e-6;

// Only open lines and polylines can be joined: a closed shape has no free end
// to attach to, and joining an arc would need a polyline bulge, which this
// drawing format does not have.
export function joinablePath(entity) {
  if (entity.type === 'LINE') return [{ ...entity.a }, { ...entity.b }];
  if (entity.type === 'PLINE' && !entity.closed) return entity.points.map(point => ({ ...point }));
  return null;
}

// Grows one chain outwards from the first path, reversing whatever attaches
// backwards, until nothing else fits. Returns null if anything is left over,
// which is what "these do not form a single chain" means. Where three paths
// meet at one point the choice is arbitrary; the result is still a valid
// chain through that vertex, just not necessarily the one the eye expects.
export function chainPaths(paths) {
  let chain = paths[0].slice();
  const remaining = paths.slice(1);
  let attached = true;
  while (remaining.length && attached) {
    attached = false;
    for (let i = 0; i < remaining.length; i++) {
      const path = remaining[i];
      const head = chain[0];
      const tail = chain[chain.length - 1];
      const first = path[0];
      const last = path[path.length - 1];
      let merged = null;
      if (dist(tail, first) < JOIN_TOLERANCE) merged = chain.concat(path.slice(1));
      else if (dist(tail, last) < JOIN_TOLERANCE) merged = chain.concat(path.slice(0, -1).reverse());
      else if (dist(head, last) < JOIN_TOLERANCE) merged = path.slice(0, -1).concat(chain);
      else if (dist(head, first) < JOIN_TOLERANCE) merged = path.slice(1).reverse().concat(chain);
      if (!merged) continue;
      chain = merged;
      remaining.splice(i, 1);
      attached = true;
      break;
    }
  }
  return remaining.length ? null : chain;
}

export function joinSelection() {
  const selected = visibleSelectedEntities().filter(isEntityEditable);
  if (selected.length < 2) {
    return { error: 'Select at least two open lines or polylines to join.' };
  }
  const paths = selected.map(joinablePath);
  if (paths.some(path => !path)) {
    return { error: 'Only open lines and polylines can be joined.' };
  }

  const chain = chainPaths(paths);
  if (!chain) return { error: 'The selected objects do not meet end to end.' };

  // A chain that returns to its own start is a closed shape, and a closed
  // polyline stores the start once rather than repeating it at the end.
  const closed = chain.length >= 4 && dist(chain[0], chain[chain.length - 1]) < JOIN_TOLERANCE;
  if (closed) chain.pop();

  const sourceIds = new Set(selected.map(entity => entity.id));
  const joined = {
    id: state.nextId,
    type: 'PLINE',
    // The result belongs where the first source object lived, which is the
    // only choice that does not depend on the order they were picked in.
    layerId: selected[0].layerId,
    points: chain,
    closed,
  };
  const entities = [...state.entities.filter(entity => !sourceIds.has(entity.id)), joined];
  if (!commitGeometry(entities, { nextId: state.nextId + 1 })) return { error: 'Joining would create invalid geometry.' };
  state.selected = new Set([joined.id]);
  return { joined: selected.length };
}

// Rectangles are stored as closed polylines, so this covers both.
export function explodedPieces(entity) {
  if (entity.type !== 'PLINE') return null;
  const points = entity.points;
  const segmentCount = entity.closed ? points.length : points.length - 1;
  const pieces = [];
  for (let i = 0; i < segmentCount; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (dist(a, b) <= 1e-9) continue;
    pieces.push({ type: 'LINE', layerId: entity.layerId, a: { ...a }, b: { ...b } });
  }
  return pieces.length ? pieces : null;
}

export function explodeSelection() {
  const selected = visibleSelectedEntities().filter(isEntityEditable);
  if (!selected.length) return { error: 'No objects selected.' };

  const pieces = new Map();
  for (const entity of selected) {
    const exploded = explodedPieces(entity);
    if (exploded) pieces.set(entity.id, exploded);
  }
  if (!pieces.size) return { error: 'Select a polyline or rectangle to explode.' };

  let nextId = state.nextId;
  const created = [];
  // Replacing in place rather than appending keeps the new segments in the
  // draw order the polyline occupied.
  const entities = state.entities.flatMap(entity => {
    const exploded = pieces.get(entity.id);
    if (!exploded) return [entity];
    return exploded.map(piece => {
      const line = { id: nextId++, ...piece };
      created.push(line.id);
      return line;
    });
  });
  if (!commitGeometry(entities, { nextId })) return { error: 'Exploding would create invalid geometry.' };
  state.selected = new Set(created);
  return { exploded: pieces.size, skipped: selected.length - pieces.size, created: created.length };
}

export function joinNote(result) {
  return result.joined > 2 ? `Joined ${result.joined} objects into one polyline.` : '';
}

export function explodeNote(result) {
  if (!result.skipped) return '';
  // The roadmap's rule: something that could not be done is reported, never
  // dropped quietly.
  return `Exploded ${result.exploded} of ${result.exploded + result.skipped} objects; `
    + `${result.skipped} cannot be exploded.`;
}

// Both commands read a selection and nothing else, so they share a shape: act
// on a preselection immediately, otherwise gather one and act on Enter.
