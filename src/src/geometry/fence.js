// TRIM's Fence option: a drawn polyline whose crossings pick the trim points
// instead of a sequence of individual clicks. This reuses calculateTrimOperation
// and replaceEditedEntity as-is — a fence crossing is nothing but a click point
// whose location was computed instead of clicked, so it inherits every rule the
// click path already enforces (preselected boundaries, self-intersection,
// curved-polyline refusal) with no separate logic to keep in sync.
import { dist, segmentCircularIntersections } from '../core/math.js';
import { entitySegments } from '../model/entity.js';
import { isEntityEditable } from '../model/layerQuery.js';
import { state } from '../state.js';
import { updatePrompt } from '../ui/prompt.js';
import { draw } from '../view/frame.js';
import { segmentIntersectionParameters } from './edgeEdit.js';
import { calculateTrimOperation, replaceEditedEntity } from './trim.js';

// Ordered along the fence rather than by entity, so a fence that weaves back
// over the same object still trims each crossing where it was actually drawn.
export function fenceCrossingPoints(fencePoints) {
  const excludedIds = state.edit?.boundaryIds ? new Set(state.edit.boundaryIds) : null;
  const crossings = [];
  let travelled = 0;
  for (let i = 0; i < fencePoints.length - 1; i++) {
    const f0 = fencePoints[i];
    const f1 = fencePoints[i + 1];
    const length = dist(f0, f1);
    for (const entity of state.entities) {
      if (excludedIds?.has(entity.id) || !isEntityEditable(entity)) continue;
      if (entity.type === 'CIRCLE' || entity.type === 'ARC') {
        for (const hit of segmentCircularIntersections(f0, f1, entity)) {
          crossings.push({ point: hit.point, along: travelled + hit.t * length });
        }
        continue;
      }
      for (const [a, b, arc] of entitySegments(entity)) {
        if (arc) {
          for (const hit of segmentCircularIntersections(f0, f1, arc)) {
            crossings.push({ point: hit.point, along: travelled + hit.t * length });
          }
        } else {
          const hit = segmentIntersectionParameters(f0, f1, a, b);
          if (hit) crossings.push({ point: hit.point, along: travelled + hit.t * length });
        }
      }
    }
    travelled += length;
  }
  crossings.sort((first, second) => first.along - second.along);
  return crossings.map(crossing => crossing.point);
}

export function applyFenceTrim(fencePoints) {
  const crossings = fenceCrossingPoints(fencePoints);
  if (!crossings.length) {
    updatePrompt('TRIM Fence — That fence crossed nothing to trim.');
    draw();
    return;
  }
  let trimmed = 0;
  let skipped = 0;
  for (const point of crossings) {
    const operation = calculateTrimOperation(point);
    if (operation.error) {
      skipped++;
      continue;
    }
    if (replaceEditedEntity(operation.hit.entity, operation.pieces) === false) skipped++;
    else trimmed++;
  }
  updatePrompt(skipped
    ? `TRIM Fence — trimmed ${trimmed}, skipped ${skipped} (no cutting boundary there).`
    : `TRIM Fence — trimmed ${trimmed}.`);
  draw();
}
