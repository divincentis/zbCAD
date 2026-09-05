import { defineCommand, setMode } from './registry.js';
import { DEGREES } from './transform.js';
import { DEFAULT_DIM_STYLE_ID } from '../core/defaults.js';
import { dimSize, getDimStyle } from '../core/dimstyle.js';
import { dist } from '../core/math.js';
import { formatLength } from '../core/units.js';
import { buildDimension, dimensionGeometry, resolveEntityReference } from '../model/dimension.js';
import { commitGeometry } from '../model/document.js';
import { currentLayerIsEditable } from '../model/layerQuery.js';
import { state } from '../state.js';
import { draw } from '../view/frame.js';
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

// ---------------------------------------------------------------------------
// TEXT
//
// Follows the AutoCAD single-line TEXT flow: insertion point, height,
// rotation, then the content itself. The first three are point/distance/angle
// entry like every other command; content is not, so it goes through value()
// instead of point() — acceptsPoint() shuts point/coordinate parsing off once
// content is being typed, so a string that happens to contain a comma or
// start with '@' is never mistaken for a coordinate.
// ---------------------------------------------------------------------------

export function addText(position, height, rotation, content) {
  if (!currentLayerIsEditable()) return false;
  const entity = {
    id: state.nextId,
    type: 'TEXT',
    layerId: state.currentLayerId,
    position: { ...position },
    height,
    rotation,
    content,
  };
  return commitGeometry([...state.entities, entity], { nextId: state.nextId + 1 });
}

// A style's textHeight is already the "what does normal annotation text look
// like in this drawing" answer — dimension text uses exactly this number —
// so plain TEXT defaults to it too rather than inventing a second default.
export function defaultTextHeight() {
  return dimSize(getDimStyle(DEFAULT_DIM_STYLE_ID), 'textHeight');
}

defineCommand('TEXT', {
  creates: true,
  usesOrtho: true,

  takesDistance() {
    return state.text?.stage === 'HEIGHT';
  },

  begin() {
    state.text = { stage: 'POINT', position: null, height: null, rotation: null };
  },

  prompt() {
    const stage = state.text?.stage;
    if (stage === 'HEIGHT') return `TEXT — Specify height <${formatLength(defaultTextHeight())}>:`;
    if (stage === 'ROTATION') return 'TEXT — Specify rotation angle <0>:';
    if (stage === 'CONTENT') return 'TEXT — Enter the text:';
    return 'TEXT — Specify start point:';
  },

  acceptsPoint() {
    return ['POINT', 'HEIGHT'].includes(state.text?.stage);
  },

  previewReady() {
    return ['HEIGHT', 'ROTATION'].includes(state.text?.stage);
  },

  point(p) {
    const operation = state.text;
    if (operation.stage === 'POINT') {
      operation.position = { ...p };
      operation.stage = 'HEIGHT';
      updatePrompt();
      return;
    }
    if (operation.stage === 'HEIGHT') {
      const height = dist(operation.position, p);
      if (height <= 1e-9) { updatePrompt('Height must be greater than zero.'); return; }
      operation.height = height;
      operation.stage = 'ROTATION';
      updatePrompt();
    }
  },

  distance(value) {
    const operation = state.text;
    if (operation?.stage !== 'HEIGHT') return false;
    if (value <= 1e-9) { updatePrompt('Height must be greater than zero.'); return true; }
    operation.height = value;
    operation.stage = 'ROTATION';
    updatePrompt();
    draw();
    return true;
  },

  value(text) {
    const operation = state.text;
    if (operation?.stage === 'ROTATION') {
      const match = text.trim().match(DEGREES);
      if (!match) { updatePrompt('Invalid angle. Enter degrees.'); return true; }
      operation.rotation = Number(match[1]) * Math.PI / 180;
      operation.stage = 'CONTENT';
      updatePrompt();
      draw();
      return true;
    }
    if (operation?.stage === 'CONTENT') {
      if (!text) { updatePrompt('Enter the text to place:'); return true; }
      if (addText(operation.position, operation.height, operation.rotation, text)) setMode('SELECT');
      return true;
    }
    return false;
  },

  // Enter/Space with nothing typed accepts the bracketed default for the
  // current stage, matching AutoCAD's <default> convention.
  finish() {
    const operation = state.text;
    if (!operation || operation.stage === 'POINT') return false;
    if (operation.stage === 'HEIGHT') {
      operation.height = defaultTextHeight();
      operation.stage = 'ROTATION';
      updatePrompt();
      draw();
      return;
    }
    if (operation.stage === 'ROTATION') {
      operation.rotation = 0;
      operation.stage = 'CONTENT';
      updatePrompt();
      draw();
      return;
    }
    // CONTENT: nothing typed yet, nothing to place.
    updatePrompt('Enter the text to place:');
    return false;
  },

  preview(p) {
    const operation = state.text;
    if (operation.stage === 'HEIGHT') {
      drawEntity({ type: 'LINE', a: operation.position, b: p }, true);
      return;
    }
    if (operation.stage === 'ROTATION') {
      drawEntity({
        type: 'TEXT',
        position: operation.position,
        height: operation.height,
        rotation: Math.atan2(p.y - operation.position.y, p.x - operation.position.x),
        content: '(text)',
      }, true);
    }
  },
});
