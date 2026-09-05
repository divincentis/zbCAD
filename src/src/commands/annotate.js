import { defineCommand, setMode } from './registry.js';
import { dist } from '../core/math.js';
import { buildDimension, dimensionGeometry, resolveEntityReference } from '../model/dimension.js';
import { commitGeometry } from '../model/document.js';
import { currentLayerIsEditable } from '../model/layerQuery.js';
import { state } from '../state.js';
import { updatePrompt } from '../ui/prompt.js';
import { drawEntity } from '../view/render.js';

export function dimensionCommand(dimType, label) {
  return {
    // Both public commands share the existing DIM runtime state without
    // sacrificing their canonical identity for prompts and command repeat.
    stateMode: 'DIM',

    // A dimension is new geometry, so it behaves like the other creation
    // commands: an existing selection is unrelated and is cleared on entry
    // rather than left highlighted through the command.
    creates: true,

    canBegin() {
      if (currentLayerIsEditable()) return true;
      updatePrompt('The current layer is locked or hidden.');
      return false;
    },

    usesOrtho() {
      // The measured points benefit from ORTHO; the dimension-line location
      // is a free offset and must not be constrained.
      return state.currentPoints.length < 2;
    },

    begin() {
      state.dimension = { dimType, refs: [null, null] };
    },

    prompt() {
      if (!state.currentPoints.length) {
        return `${label} — Specify first extension line origin:`;
      }
      return state.currentPoints.length === 1
        ? `${label} — Specify second extension line origin:`
        : `${label} — Specify dimension line location:`;
    },

    point(p) {
      if (state.currentPoints.length < 2) {
        state.dimension.refs[state.currentPoints.length] = resolveEntityReference(p);
        state.currentPoints.push({ ...p });
        updatePrompt();
      } else if (addDimension(
        dimType,
        state.currentPoints[0], state.currentPoints[1], p,
        state.dimension.refs,
      )) {
        setMode('SELECT');
      }
    },

    preview(p) {
      if (state.currentPoints.length === 1) {
        drawEntity({ type: 'LINE', a: state.currentPoints[0], b: p }, true);
        return;
      }
      const preview = buildDimension(
        dimType, state.currentPoints[0], state.currentPoints[1], p, [null, null],
      );
      if (dimensionGeometry(preview).measure > 1e-9) drawEntity(preview, true);
    },
  };
}

defineCommand('DIMLINEAR', dimensionCommand('LINEAR', 'DIMLINEAR'));
defineCommand('DIMALIGNED', dimensionCommand('ALIGNED', 'DIMALIGNED'));

// Every transform opens the same way — take a selection, then a base point —
// and they all keep their staged runtime state in state.transform. Only what
// follows the base point differs, so the shared opening lives here.
export function addDimension(dimType, p1, p2, linePoint, refs) {
  if (!currentLayerIsEditable()) return false;
  if (dist(p1, p2) <= 1e-9) {
    updatePrompt('A dimension needs two distinct points.');
    return false;
  }
  const entity = buildDimension(dimType, p1, p2, linePoint, refs);
  const geometry = dimensionGeometry(entity);
  if (geometry.measure <= 1e-9) {
    updatePrompt('That dimension line direction measures nothing. Try the other side.');
    return false;
  }
  entity.id = state.nextId;
  return commitGeometry([...state.entities, entity], { nextId: state.nextId + 1 });
}
