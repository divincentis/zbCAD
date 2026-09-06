import { visibleSelectedEntities } from '../commands/inquiry.js';
import { arcSweep, bulgeFromSweep, circularPoint, dist } from '../core/math.js';
import { commitGeometry } from '../model/history.js';
import { entitySegments, polylineBulge, withPolylineBulges } from '../model/entity.js';
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

// A path being chained: `points` vertices and the `bulges` of the segments
// between them, so one entry shorter. Only open shapes can be joined — a
// closed one has no free end to attach to — but an arc is now among them,
// since a polyline can hold the curve as a bulge on its own segment.
export function joinablePath(entity) {
  if (entity.type === 'LINE') return { points: [{ ...entity.a }, { ...entity.b }], bulges: [0] };
  if (entity.type === 'ARC') {
    return {
      points: [
        circularPoint(entity.center, entity.radius, entity.startAngle),
        circularPoint(entity.center, entity.radius, entity.endAngle),
      ],
      // Arcs are stored counter-clockwise from start to end, which is exactly
      // the direction a positive bulge names.
      bulges: [bulgeFromSweep(arcSweep(entity))],
    };
  }
  if (entity.type === 'PLINE' && !entity.closed) {
    return {
      points: entity.points.map(point => ({ ...point })),
      bulges: entity.points.slice(0, -1).map((vertex, index) => polylineBulge(entity, index)),
    };
  }
  return null;
}

// Walking a path backwards reverses the sense of every arc on it, so each
// bulge changes sign as well as place — the same reflection rule MIRROR uses.
export function reversePath(path) {
  return {
    points: [...path.points].reverse(),
    bulges: [...path.bulges].reverse().map(bulge => (bulge === 0 ? 0 : -bulge)),
  };
}

// Joins two paths that already meet: `second` starts where `first` ends, so
// that shared vertex is stored once.
export function concatPaths(first, second) {
  return {
    points: first.points.concat(second.points.slice(1)),
    bulges: first.bulges.concat(second.bulges),
  };
}

// Grows one chain outwards from the first path, reversing whatever attaches
// backwards, until nothing else fits. Returns null if anything is left over,
// which is what "these do not form a single chain" means. Where three paths
// meet at one point the choice is arbitrary; the result is still a valid
// chain through that vertex, just not necessarily the one the eye expects.
export function chainPaths(paths) {
  let chain = paths[0];
  const remaining = paths.slice(1);
  let attached = true;
  while (remaining.length && attached) {
    attached = false;
    for (let i = 0; i < remaining.length; i++) {
      const path = remaining[i];
      const head = chain.points[0];
      const tail = chain.points[chain.points.length - 1];
      const first = path.points[0];
      const last = path.points[path.points.length - 1];
      let merged = null;
      if (dist(tail, first) < JOIN_TOLERANCE) merged = concatPaths(chain, path);
      else if (dist(tail, last) < JOIN_TOLERANCE) merged = concatPaths(chain, reversePath(path));
      else if (dist(head, last) < JOIN_TOLERANCE) merged = concatPaths(path, chain);
      else if (dist(head, first) < JOIN_TOLERANCE) merged = concatPaths(reversePath(path), chain);
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
    return { error: 'Only open lines, arcs and polylines can be joined.' };
  }

  const chain = chainPaths(paths);
  if (!chain) return { error: 'The selected objects do not meet end to end.' };

  // A chain that returns to its own start is a closed shape, and a closed
  // polyline stores the start once rather than repeating it at the end.
  // Dropping that repeat also leaves the bulge list exactly the length the
  // entity needs, with the closing segment's curve last.
  const points = chain.points;
  const closed = points.length >= 4 && dist(points[0], points[points.length - 1]) < JOIN_TOLERANCE;
  if (closed) points.pop();
  const bulges = closed ? chain.bulges : [...chain.bulges, 0];

  const sourceIds = new Set(selected.map(entity => entity.id));
  const joined = withPolylineBulges({
    id: state.nextId,
    type: 'PLINE',
    // The result belongs where the first source object lived, which is the
    // only choice that does not depend on the order they were picked in.
    layerId: selected[0].layerId,
    points,
    closed,
  }, bulges);
  const entities = [...state.entities.filter(entity => !sourceIds.has(entity.id)), joined];
  if (!commitGeometry(entities, { nextId: state.nextId + 1 })) return { error: 'Joining would create invalid geometry.' };
  state.selected = new Set([joined.id]);
  return { joined: selected.length };
}

// Rectangles are stored as closed polylines, so this covers both. A curved
// segment leaves as an ARC rather than as the chord across it, which is what
// makes EXPLODE the honest escape hatch the commands that refuse a curved
// polyline (OFFSET, TRIM, EXTEND) point users at.
export function explodedPieces(entity) {
  if (entity.type !== 'PLINE') return null;
  const pieces = [];
  for (const [a, b, arc] of entitySegments(entity)) {
    if (dist(a, b) <= 1e-9) continue;
    if (arc) {
      pieces.push({
        type: 'ARC', layerId: entity.layerId,
        center: { ...arc.center }, radius: arc.radius,
        startAngle: arc.startAngle, endAngle: arc.endAngle,
      });
    } else {
      pieces.push({ type: 'LINE', layerId: entity.layerId, a: { ...a }, b: { ...b } });
    }
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
