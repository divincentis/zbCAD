import { documentChanged } from '../events.js';
import { markDirty } from './dirty.js';
import { documentSnapshot, editSnapshot, restoreEditSnapshot, validateDocumentData } from './document.js';
import { updateAssociativeDimensions } from './dimension.js';
import { state } from '../state.js';
import { updatePrompt } from '../ui/prompt.js';
import { draw } from '../view/frame.js';

export function pushHistory() {
  state.history.push(editSnapshot());
  if (state.history.length > 100) state.history.shift();
  state.future.length = 0;
  markDirty();
}

// Build a complete candidate without mutating entities, IDs, history, or the
// command stage. Only a validated candidate may enter the undoable document.
//
// Underlays ride in the same candidate rather than getting a commit path of
// their own, so a MOVE over a selection holding both geometry and an image is
// one undo step instead of two half-steps that can be separated.
export function commitGeometry(entities, options = {}) {
  const candidate = {
    ...documentSnapshot(), entities: updateAssociativeDimensions(entities),
    nextId: options.nextId ?? state.nextId,
    units: options.unitSettings ?? state.unitSettings,
    dimStyles: options.dimStyles ?? state.dimStyles,
    underlays: options.underlays ?? state.underlays,
    nextUnderlayId: options.nextUnderlayId ?? state.nextUnderlayId,
  };
  if (!Number.isSafeInteger(candidate.nextId) || candidate.nextId <= 0) {
    updatePrompt('Edit rejected: no valid entity IDs remain.');
    return false;
  }
  const checked = validateDocumentData(candidate);
  if (checked.error) {
    updatePrompt(`Edit rejected: ${checked.error}`);
    return false;
  }
  pushHistory();
  state.entities = checked.document.entities;
  state.nextId = checked.document.nextId;
  state.unitSettings = checked.document.unitSettings;
  state.dimStyles = checked.document.dimStyles;
  state.underlays = checked.document.underlays;
  state.nextUnderlayId = checked.document.nextUnderlayId;
  return true;
}

export function undo() {
  if (!state.history.length) return;
  state.future.push(editSnapshot());
  restoreEditSnapshot(state.history.pop());
  state.selected.clear();
  markDirty();
  documentChanged();
  draw();
}

export function redo() {
  if (!state.future.length) return;
  state.history.push(editSnapshot());
  restoreEditSnapshot(state.future.pop());
  state.selected.clear();
  markDirty();
  documentChanged();
  draw();
}
