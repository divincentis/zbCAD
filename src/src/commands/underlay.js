import { defineCommand, setMode, startCommand } from './registry.js';
import { UNDERLAY_DEFAULT_FADE } from '../core/constants.js';
import { dist } from '../core/math.js';
import { formatLength, formatLengthLabel } from '../core/units.js';
import { parseDistance } from '../interaction/input.js';
import { commitGeometry } from '../model/history.js';
import { currentLayerIsEditable } from '../model/layerQuery.js';
import { calibrateUnderlay, makeUnderlay, underlayContainsPoint, underlayIsSelectable, underlaySelectionId, underlayWidth } from '../model/underlay.js';
import { state } from '../state.js';
import { updatePrompt } from '../ui/prompt.js';
import { draw } from '../view/frame.js';
import { drawEntity } from '../view/render.js';
import { drawUnderlayPreview } from '../view/underlay.js';

// ---------------------------------------------------------------------------
// Underlay commands
//
// IMAGE places a raster; CALIBRATE tells the drawing how big it really is.
// They are separate commands rather than one wizard because calibration is not
// a one-time step: a traced image gets re-calibrated whenever a better known
// dimension turns up, and having to re-import to do that would be absurd.
// ---------------------------------------------------------------------------

// The descriptor waiting to be placed. It is handed in from the file picker
// (ui/shell.js) or, in tests, injected directly — the command itself never
// touches a File, which is what keeps it drivable headlessly.
export let pendingUnderlayImage = null;

export function setPendingUnderlayImage(descriptor) {
  pendingUnderlayImage = descriptor;
}

// Routed through startCommand rather than setMode so the placement obeys the
// same rules every other command does: it refuses while another command is
// mid-stage, and `creates` clears the selection and checks the current layer.
export function startImagePlacement(descriptor) {
  if (!descriptor) return false;
  pendingUnderlayImage = descriptor;
  startCommand('IMAGE');
  return true;
}

defineCommand('IMAGE', {
  creates: true,

  canBegin() {
    if (!pendingUnderlayImage) {
      updatePrompt('IMAGE — choose a file with the Image button first.');
      return false;
    }
    return true;
  },

  begin() {
    state.underlay = {
      stage: 'PLACE',
      descriptor: pendingUnderlayImage,
      // One drawing unit per pixel is an arbitrary but honest default: the
      // image carries no real-world scale, and pretending otherwise would be
      // a guess the user then has to detect and undo. CALIBRATE is the answer,
      // and the prompt says so.
      unitsPerPixel: 1,
    };
  },

  takesDistance: true,

  prompt() {
    const operation = state.underlay;
    if (!operation) return 'IMAGE:';
    const width = operation.descriptor.widthPx * operation.unitsPerPixel;
    return `IMAGE — Specify bottom-left corner, or type a width (${formatLengthLabel(width)} at present):`;
  },

  // A typed number at the placement stage means "make the image this wide",
  // which is the fastest possible calibration when the width is already known.
  distance(value) {
    const operation = state.underlay;
    if (!operation || !(value > 0)) {
      updatePrompt('Enter a width greater than zero.');
      return;
    }
    operation.unitsPerPixel = value / operation.descriptor.widthPx;
    updatePrompt();
    draw();
  },

  previewReady() {
    return Boolean(state.underlay);
  },

  preview(p) {
    const operation = state.underlay;
    if (!operation) return;
    drawUnderlayPreview(operation.descriptor, p, operation.unitsPerPixel);
  },

  point(p) {
    const operation = state.underlay;
    if (!operation) return;
    if (!currentLayerIsEditable()) {
      updatePrompt('The current layer is locked or hidden.');
      return;
    }
    const underlay = makeUnderlay(operation.descriptor, p, {
      unitsPerPixel: operation.unitsPerPixel,
      fade: UNDERLAY_DEFAULT_FADE,
    });
    const nextUnderlayId = underlay.id + 1;
    if (!commitGeometry(state.entities, {
      underlays: [...state.underlays, underlay],
      nextUnderlayId,
    })) return;
    pendingUnderlayImage = null;
    state.selected = new Set([underlaySelectionId(underlay.id)]);
    setMode('SELECT');
    updatePrompt(`Image placed ${formatLengthLabel(underlayWidth(underlay))} wide. Use CALIBRATE to set its true scale.`);
  },

  finish() {
    pendingUnderlayImage = null;
    setMode('SELECT');
  },
});

// ---------------------------------------------------------------------------
// CALIBRATE
//
// Pick two points whose real separation is known, type the distance, and the
// image is scaled about the first pick. Holding the first pick fixed matters:
// the user has just told you where a known point on the image is, and moving it
// out from under them would undo the very thing they were establishing.
// ---------------------------------------------------------------------------

defineCommand('CALIBRATE', {
  stateMode: 'CALIBRATE',

  canBegin() {
    if (!state.underlays.some(underlayIsSelectable)) {
      updatePrompt('CALIBRATE — there is no unlocked image to calibrate.');
      return false;
    }
    return true;
  },

  begin() {
    const preselected = state.underlays.filter(underlay =>
      state.selected.has(underlaySelectionId(underlay.id)) && underlayIsSelectable(underlay));
    const selectable = state.underlays.filter(underlayIsSelectable);
    // One image, or exactly one selected, is not a choice worth asking about.
    const target = preselected.length === 1 ? preselected[0]
      : (selectable.length === 1 ? selectable[0] : null);
    state.underlay = {
      stage: target ? 'FIRST' : 'PICK',
      targetId: target ? target.id : null,
      first: null,
      second: null,
    };
  },

  // Calibration points are read off a raster, so OSNAP has nothing useful to
  // contribute and a stray endpoint snap would silently calibrate against the
  // wrong place.
  usesSnap: false,

  takesDistance() {
    return state.underlay?.stage === 'DISTANCE';
  },

  acceptsPoint() {
    return state.underlay?.stage !== 'DISTANCE';
  },

  prompt() {
    const operation = state.underlay;
    if (!operation) return 'CALIBRATE:';
    if (operation.stage === 'PICK') return 'CALIBRATE — Select the image to calibrate:';
    if (operation.stage === 'FIRST') return 'CALIBRATE — Specify first point of a known distance:';
    if (operation.stage === 'SECOND') return 'CALIBRATE — Specify second point of the known distance:';
    const measured = dist(operation.first, operation.second);
    return `CALIBRATE — Enter the true distance between those points (${formatLength(measured)} at present):`;
  },

  point(p) {
    const operation = state.underlay;
    if (!operation) return;
    if (operation.stage === 'PICK') {
      const target = [...state.underlays].reverse()
        .find(underlay => underlayIsSelectable(underlay) && underlayContainsPoint(underlay, p));
      if (!target) {
        updatePrompt('CALIBRATE — that is not on an unlocked image. Pick again:');
        return;
      }
      operation.targetId = target.id;
      operation.stage = 'FIRST';
      updatePrompt();
      return;
    }
    if (operation.stage === 'FIRST') {
      operation.first = { ...p };
      operation.stage = 'SECOND';
      updatePrompt();
      return;
    }
    if (operation.stage === 'SECOND') {
      if (dist(operation.first, p) < 1e-9) {
        updatePrompt('CALIBRATE — those points are in the same place. Pick the second point again:');
        return;
      }
      operation.second = { ...p };
      operation.stage = 'DISTANCE';
      updatePrompt();
      draw();
    }
  },

  distance(value) {
    applyCalibration(value);
  },

  // The typed value can carry a unit suffix (12', 150mm), which parseDistance
  // already understands, so it is routed here as well as through distance().
  value(text) {
    if (state.underlay?.stage !== 'DISTANCE') return false;
    const parsed = parseDistance(text);
    if (parsed === null) {
      updatePrompt('Enter a distance, for example 24 or 2\' or 600mm.');
      return true;
    }
    applyCalibration(parsed);
    return true;
  },

  previewReady() {
    return Boolean(state.underlay?.first) && state.underlay.stage === 'SECOND';
  },

  // The measuring line is the whole feedback for this stage: it is what tells
  // the user which two features of the image they are about to declare a
  // distance between.
  preview(p) {
    drawEntity({ type: 'LINE', a: state.underlay.first, b: p }, true);
  },

  finish() {
    setMode('SELECT');
  },
});

export function applyCalibration(knownDistance) {
  const operation = state.underlay;
  if (!operation || operation.stage !== 'DISTANCE') return;
  const target = state.underlays.find(underlay => underlay.id === operation.targetId);
  if (!target) {
    updatePrompt('That image is no longer in the drawing.');
    setMode('SELECT');
    return;
  }
  const result = calibrateUnderlay(target, operation.first, operation.second, knownDistance);
  if (result.error) {
    updatePrompt(`CALIBRATE — ${result.error}`);
    return;
  }
  const underlays = state.underlays.map(underlay =>
    underlay.id === target.id ? result.underlay : underlay);
  if (!commitGeometry(state.entities, { underlays })) return;
  state.selected = new Set([underlaySelectionId(target.id)]);
  setMode('SELECT');
  updatePrompt(`Image calibrated: scaled ${result.factor.toFixed(4)}x, now ${formatLengthLabel(underlayWidth(result.underlay))} wide.`);
}
